package agent

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"
)

const operationTimeout = 20 * time.Second

type API struct {
	cfg         Config
	service     Service
	version     string
	environment string
	tokenHash   [sha256.Size]byte
	writes      chan struct{}
	streams     chan struct{}
	requests    chan struct{}
	schemaMu    sync.Mutex
	schemaData  []byte
	schemaInfo  os.FileInfo
}

func NewAPI(cfg Config, service Service, version string) *API {
	return &API{cfg: cfg, service: service, version: version, environment: detectEnvironment(), tokenHash: sha256.Sum256([]byte(cfg.Token)),
		writes: make(chan struct{}, 1), streams: make(chan struct{}, 4), requests: make(chan struct{}, 32)}
}

func (a *API) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/status", a.status)
	mux.HandleFunc("GET /v1/config", a.config)
	mux.HandleFunc("GET /v1/schema", a.schema)
	mux.HandleFunc("POST /v1/config/check", a.check)
	mux.HandleFunc("PUT /v1/config", a.save)
	mux.HandleFunc("POST /v1/service/{action}", a.control)
	mux.HandleFunc("GET /v1/logs", a.logs)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		provided := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
		hash := sha256.Sum256([]byte(provided))
		if !strings.HasPrefix(r.Header.Get("Authorization"), "Bearer ") || subtle.ConstantTimeCompare(hash[:], a.tokenHash[:]) != 1 {
			w.Header().Set("WWW-Authenticate", "Bearer")
			respondError(w, problem(401, "unauthorized", "a valid Bearer token is required"), nil)
			return
		}
		select {
		case a.requests <- struct{}{}:
			defer func() { <-a.requests }()
		default:
			respondError(w, problem(429, "busy", "too many active requests"), nil)
			return
		}
		if r.URL.Path != "/v1/logs" {
			_ = http.NewResponseController(w).SetWriteDeadline(time.Now().Add(45 * time.Second))
		}
		mux.ServeHTTP(w, r)
	})
}

func (a *API) status(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()
	state, err := a.service.Status(ctx)
	if err != nil {
		respondError(w, problem(503, "state_unknown", "could not read service state"), map[string]any{"state": "unknown", "environment": a.environment})
		return
	}
	version, err := a.service.Version(ctx)
	if err != nil {
		respondError(w, problem(503, "version_unavailable", "could not read sing-box version"), map[string]any{"state": state, "environment": a.environment})
		return
	}
	respondJSON(w, 200, map[string]any{"api_version": 1, "agent_version": a.version,
		"core_version": version, "state": state, "driver": "process", "environment": a.environment})
}

func (a *API) config(w http.ResponseWriter, r *http.Request) {
	content, _, err := readConfig(a.cfg.Service.Config)
	if err != nil {
		respondError(w, err, nil)
		return
	}
	etag := configETag(content)
	w.Header().Set("ETag", etag)
	respondJSON(w, 200, map[string]string{"content": string(content), "etag": etag})
}

type configRequest struct {
	Content string `json:"content"`
	Apply   bool   `json:"apply,omitempty"`
}

func decodeRequest(w http.ResponseWriter, r *http.Request, dst any) error {
	if media := strings.SplitN(r.Header.Get("Content-Type"), ";", 2)[0]; media != "application/json" {
		return problem(415, "unsupported_media_type", "Content-Type must be application/json")
	}
	r.Body = http.MaxBytesReader(w, r.Body, 6*MaxConfigBytes+4096)
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(dst); err != nil {
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			return problem(413, "request_too_large", "request body is too large")
		}
		return problem(400, "invalid_request", "request must contain valid JSON with the documented fields")
	}
	if err := decoder.Decode(new(any)); err != io.EOF {
		return problem(400, "invalid_request", "request must contain one JSON object")
	}
	return nil
}

func (a *API) mutate(w http.ResponseWriter, r *http.Request, operation func(context.Context)) {
	select {
	case a.writes <- struct{}{}:
		defer func() { <-a.writes }()
	default:
		respondError(w, problem(409, "service_busy", "another configuration or service operation is running"), nil)
		return
	}
	// Once accepted, complete or recover the mutation even if the caller disconnects.
	ctx, cancel := context.WithTimeout(context.WithoutCancel(r.Context()), operationTimeout)
	defer cancel()
	operation(ctx)
}

func (a *API) check(w http.ResponseWriter, r *http.Request) {
	var request configRequest
	if err := decodeRequest(w, r, &request); err != nil {
		respondError(w, err, nil)
		return
	}
	a.mutate(w, r, func(ctx context.Context) {
		if err := validateConfig(ctx, a.cfg.Service, a.service, []byte(request.Content)); err != nil {
			respondError(w, err, nil)
			return
		}
		respondJSON(w, 200, map[string]any{"valid": true, "etag": configETag([]byte(request.Content))})
	})
}

func (a *API) save(w http.ResponseWriter, r *http.Request) {
	var request configRequest
	if err := decodeRequest(w, r, &request); err != nil {
		respondError(w, err, nil)
		return
	}
	a.mutate(w, r, func(ctx context.Context) {
		result, err := saveConfig(ctx, a.cfg.Service, a.service, []byte(request.Content), r.Header.Get("If-Match"), request.Apply)
		if result.ETag != "" {
			w.Header().Set("ETag", result.ETag)
		}
		if err != nil {
			respondError(w, err, result)
			return
		}
		respondJSON(w, 200, result)
	})
}

func (a *API) control(w http.ResponseWriter, r *http.Request) {
	action := r.PathValue("action")
	if action != "start" && action != "stop" && action != "restart" {
		respondError(w, problem(400, "invalid_action", "action must be start, stop or restart"), nil)
		return
	}
	a.mutate(w, r, func(ctx context.Context) {
		if action != "stop" {
			if err := a.service.Check(ctx, a.cfg.Service.Config); err != nil {
				respondError(w, &apiError{Status: 422, Code: "invalid_config", Err: err}, nil)
				return
			}
		}
		if err := a.service.Control(ctx, action); err != nil {
			respondError(w, problem(502, "service_action_failed", "service action failed; inspect service logs and current state"), nil)
			return
		}
		state, err := a.service.Status(ctx)
		if err != nil {
			respondError(w, problem(503, "state_unknown", "action completed but current state could not be read"), nil)
			return
		}
		respondJSON(w, 200, map[string]string{"state": state})
	})
}

func (a *API) logs(w http.ResponseWriter, r *http.Request) {
	opts := LogOptions{Lines: 100}
	if value := r.URL.Query().Get("lines"); value != "" {
		lines, err := strconv.Atoi(value)
		if err != nil || lines < 1 || lines > maxLogLines {
			respondError(w, problem(400, "invalid_lines", "lines must be between 1 and 1000"), nil)
			return
		}
		opts.Lines = lines
	}
	if value := r.URL.Query().Get("follow"); value != "" {
		follow, err := strconv.ParseBool(value)
		if err != nil {
			respondError(w, problem(400, "invalid_follow", "follow must be true or false"), nil)
			return
		}
		opts.Follow = follow
	}
	select {
	case a.streams <- struct{}{}:
		defer func() { <-a.streams }()
	default:
		respondError(w, problem(429, "too_many_streams", "at most four log readers are allowed"), nil)
		return
	}
	var mu sync.Mutex
	started := false
	write := func(p []byte) error {
		mu.Lock()
		defer mu.Unlock()
		if err := r.Context().Err(); err != nil {
			return err
		}
		controller := http.NewResponseController(w)
		_ = controller.SetWriteDeadline(time.Now().Add(10 * time.Second))
		if !started {
			w.Header().Set("Content-Type", "text/plain; charset=utf-8")
			w.Header().Set("X-Accel-Buffering", "no")
			w.WriteHeader(200)
			started = true
		}
		if _, err := w.Write(p); err != nil {
			return err
		}
		return controller.Flush()
	}
	err := a.service.Logs(r.Context(), opts, write)
	mu.Lock()
	defer mu.Unlock()
	if err != nil && r.Context().Err() == nil {
		if !started {
			var detail *apiError
			if errors.As(err, &detail) {
				respondError(w, err, nil)
			} else {
				respondError(w, problem(503, "logs_unavailable", "cannot read managed core output"), nil)
			}
		} else {
			_, _ = io.WriteString(w, "\n[agent] log source ended with an error\n")
		}
	} else if !started {
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		w.WriteHeader(200)
	}
}

func respondJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

func respondError(w http.ResponseWriter, err error, result any) {
	failure := &apiError{Status: 500, Code: "internal_error", Err: errors.New("operation failed; check configured paths and permissions")}
	var typed *apiError
	if errors.As(err, &typed) {
		failure = typed
	}
	message := failure.Error()
	if len(message) > 8192 {
		message = message[:8192] + " [truncated]"
	}
	respondJSON(w, failure.Status, map[string]any{"error": map[string]string{"code": failure.Code, "message": message}, "result": result})
}
