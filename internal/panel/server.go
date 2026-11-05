package panel

import (
	"crypto/sha256"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

type Server struct {
	store         *Store
	version       string
	startedAt     time.Time
	secretHash    [32]byte
	dataMu        sync.RWMutex
	restoreFailed atomic.Bool
	backups       chan struct{}
	clientsMu     sync.Mutex
	clients       map[string]*agentClient
	requests      chan struct{}
	streams       chan struct{}
	subscriptions chan struct{}
	operations    sync.Map
}

func NewServer(store *Store, version, secret string) *Server {
	return &Server{store: store, version: version, startedAt: time.Now().UTC(),
		secretHash: sha256.Sum256([]byte(secret)),
		backups:    make(chan struct{}, 1),
		clients:    make(map[string]*agentClient), requests: make(chan struct{}, 64), streams: make(chan struct{}, 8), subscriptions: make(chan struct{}, 2)}
}

func (s *Server) Handler() http.Handler {
	api := http.NewServeMux()
	api.HandleFunc("GET /api/session", s.session)
	api.HandleFunc("GET /api/backup", s.exportBackup)
	api.HandleFunc("POST /api/backup/check", s.checkBackup)
	api.HandleFunc("POST /api/backup/restore", s.restoreBackup)
	api.HandleFunc("GET /api/library", s.readLibrary)
	api.HandleFunc("PUT /api/library", s.saveLibrary)
	api.HandleFunc("GET /api/subscriptions/sources", s.subscriptionSources)
	api.HandleFunc("POST /api/subscriptions/preview", s.previewSubscription)
	api.HandleFunc("GET /api/nodes", func(w http.ResponseWriter, r *http.Request) { respond(w, 200, s.store.Servers()) })
	api.HandleFunc("POST /api/nodes", s.saveServer)
	api.HandleFunc("PUT /api/nodes/{id}", s.saveServer)
	api.HandleFunc("DELETE /api/nodes/{id}", s.deleteServer)
	api.HandleFunc("POST /api/nodes/probe", s.probe)
	api.HandleFunc("/api/nodes/{id}/agent/{endpoint...}", s.proxy)
	api.HandleFunc("GET /api/servers", func(w http.ResponseWriter, r *http.Request) { respond(w, 200, s.store.ManagedServers()) })
	api.HandleFunc("POST /api/servers", s.saveServer)
	api.HandleFunc("PUT /api/servers/order", s.reorderServers)
	api.HandleFunc("PUT /api/servers/{id}", s.saveServer)
	api.HandleFunc("DELETE /api/servers/{id}", s.deleteServer)
	api.HandleFunc("POST /api/servers/probe", s.probe)
	api.HandleFunc("/api/servers/{id}/agent/{endpoint...}", s.proxy)
	api.HandleFunc("GET /api/servers/{id}/draft", s.readDraft)
	api.HandleFunc("PUT /api/servers/{id}/draft", s.saveDraft)
	api.HandleFunc("POST /api/servers/{id}/draft/import", s.importDraft)
	api.HandleFunc("POST /api/servers/{id}/draft/restore", s.restoreDraft)
	api.HandleFunc("POST /api/servers/{id}/publish", s.publishDraft)
	assets := assetHandler()
	public := http.NewServeMux()
	public.HandleFunc("GET /subscribe/{id}/{token}", s.downloadSubscription)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Referrer-Policy", "same-origin")
		w.Header().Set("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data:; connect-src 'self' http: https:; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'")
		w.Header().Set("Cache-Control", "no-store")
		select {
		case s.requests <- struct{}{}:
			defer func() { <-s.requests }()
		default:
			failure(w, 429, "busy", "too many active requests")
			return
		}
		if strings.HasPrefix(r.URL.Path, "/subscribe/") {
			s.dataMu.RLock()
			defer s.dataMu.RUnlock()
			if s.restoreFailed.Load() {
				http.Error(w, "subscription unavailable", http.StatusServiceUnavailable)
				return
			}
			_ = http.NewResponseController(w).SetWriteDeadline(time.Now().Add(60 * time.Second))
			public.ServeHTTP(w, r)
			return
		}
		if !strings.HasPrefix(r.URL.Path, "/api/") {
			assets.ServeHTTP(w, r)
			return
		}
		if !strings.Contains(r.URL.Path, "/agent/logs") {
			_ = http.NewResponseController(w).SetWriteDeadline(time.Now().Add(60 * time.Second))
		}
		panelCORS(w, r)
		if r.Method == "OPTIONS" {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		if !s.authorized(r) {
			w.Header().Set("WWW-Authenticate", "Bearer")
			failure(w, 401, "unauthorized", "a valid panel secret is required")
			return
		}
		if !(r.Method == "POST" && r.URL.Path == "/api/backup/restore") && !(r.Method == "GET" && strings.Contains(r.URL.Path, "/agent/logs")) {
			s.dataMu.RLock()
			defer s.dataMu.RUnlock()
		}
		if s.restoreFailed.Load() {
			failure(w, 503, "restore_recovery_required", "restart the panel to recover the previous data")
			return
		}
		api.ServeHTTP(w, r)
	})
}

func (s *Server) session(w http.ResponseWriter, r *http.Request) {
	respond(w, 200, map[string]any{"version": s.version,
		"started_at": s.startedAt, "uptime_seconds": time.Since(s.startedAt).Seconds()})
}

func (s *Server) saveServer(w http.ResponseWriter, r *http.Request) {
	var input ServerInput
	if !decode(w, r, &input, 128<<10) {
		return
	}
	if err := normalizeServer(&input); err != nil {
		failure(w, 400, "invalid_server", err.Error())
		return
	}
	client, err := newAgentClient(ServerRecord{URL: input.URL, CAPEM: input.CAPEM}, "")
	if err != nil {
		failure(w, 400, "invalid_ca", err.Error())
		return
	}
	client.transport.CloseIdleConnections()
	save := func() {
		server, err := s.store.Save(r.PathValue("id"), input)
		if err != nil {
			failure(w, 400, "save_failed", err.Error())
			return
		}
		s.forgetClient(server.ID)
		respond(w, 200, server)
	}
	if id := r.PathValue("id"); id != "" {
		s.operation(id, w, save)
	} else {
		save()
	}
}

func (s *Server) reorderServers(w http.ResponseWriter, r *http.Request) {
	var input struct {
		IDs []string `json:"ids"`
	}
	if !decode(w, r, &input, 8<<10) {
		return
	}
	if err := s.store.ReorderServers(input.IDs); err != nil {
		if errors.Is(err, errServerOrderConflict) {
			failure(w, 409, "server_order_conflict", err.Error())
		} else {
			failure(w, 500, "server_order_failed", "could not save server order")
		}
		return
	}
	respond(w, 200, map[string]bool{"ok": true})
}

func (s *Server) deleteServer(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	s.operation(id, w, func() {
		if err := s.store.Delete(id); err != nil {
			failure(w, 500, "save_failed", "could not save panel data")
			return
		}
		s.forgetClient(id)
		s.operations.Delete(id)
		respond(w, 200, map[string]bool{"ok": true})
	})
}

func respond(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

func failure(w http.ResponseWriter, status int, code, message string) {
	respond(w, status, map[string]any{"error": map[string]string{"code": code, "message": message}})
}

func decode(w http.ResponseWriter, r *http.Request, value any, limit int64) bool {
	if strings.SplitN(r.Header.Get("Content-Type"), ";", 2)[0] != "application/json" {
		failure(w, 415, "invalid_content_type", "Content-Type must be application/json")
		return false
	}
	r.Body = http.MaxBytesReader(w, r.Body, limit)
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(value); err != nil {
		failure(w, 400, "invalid_request", "request must contain valid JSON within the size limit")
		return false
	}
	if err := decoder.Decode(new(any)); err != io.EOF {
		failure(w, 400, "invalid_request", "request must contain one JSON object")
		return false
	}
	return true
}
