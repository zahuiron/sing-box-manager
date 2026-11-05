package panel

import (
	"bytes"
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"
)

type agentClient struct {
	server    ServerRecord
	token     string
	client    *http.Client
	transport *http.Transport
}

func normalizeServer(input *ServerInput) error {
	input.Name, input.URL = strings.TrimSpace(input.Name), strings.TrimRight(strings.TrimSpace(input.URL), "/")
	if input.Name == "" || len(input.Name) > 120 {
		return errors.New("server name must contain 1–120 bytes")
	}
	u, err := url.Parse(input.URL)
	if err != nil || u.Scheme != "https" || u.Hostname() == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || u.Path != "" || len(input.URL) > 2048 {
		return errors.New("server URL must be an HTTPS origin, for example https://node.example.com:9091")
	}
	if input.Token != "" && (len(input.Token) < 32 || len(input.Token) > 4096 || strings.ContainsAny(input.Token, " \r\n\t<>")) {
		return errors.New("server token must contain 32–4096 non-whitespace characters")
	}
	if len(input.CAPEM) > 64<<10 {
		return errors.New("trusted CA exceeds 64 KiB")
	}
	return nil
}

func newAgentClient(node ServerRecord, token string) (*agentClient, error) {
	tlsConfig := &tls.Config{MinVersion: tls.VersionTLS12}
	if strings.TrimSpace(node.CAPEM) != "" {
		roots, err := x509.SystemCertPool()
		if err != nil {
			roots = x509.NewCertPool()
		}
		if !roots.AppendCertsFromPEM([]byte(node.CAPEM)) {
			return nil, errors.New("trusted CA must contain a PEM certificate")
		}
		tlsConfig.RootCAs = roots
	}
	transport := &http.Transport{Proxy: http.ProxyFromEnvironment,
		DialContext:     (&net.Dialer{Timeout: 5 * time.Second, KeepAlive: 30 * time.Second}).DialContext,
		TLSClientConfig: tlsConfig, TLSHandshakeTimeout: 5 * time.Second, ResponseHeaderTimeout: 50 * time.Second,
		MaxIdleConns: 4, MaxIdleConnsPerHost: 2, MaxConnsPerHost: 6, IdleConnTimeout: 90 * time.Second}
	return &agentClient{server: node, token: token, transport: transport,
		client: &http.Client{Transport: transport, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}}, nil
}

func (s *Server) client(id string) (*agentClient, error) {
	node, ok := s.store.Server(id)
	if !ok {
		return nil, errors.New("server no longer exists")
	}
	s.clientsMu.Lock()
	defer s.clientsMu.Unlock()
	if client := s.clients[id]; client != nil && client.server == node {
		return client, nil
	}
	token, err := s.store.Token(node)
	if err != nil {
		return nil, errors.New("could not decrypt server token")
	}
	client, err := newAgentClient(node, token)
	if err != nil {
		return nil, err
	}
	if old := s.clients[id]; old != nil {
		old.transport.CloseIdleConnections()
	}
	s.clients[id] = client
	return client, nil
}

func (s *Server) forgetClient(id string) {
	s.clientsMu.Lock()
	defer s.clientsMu.Unlock()
	if old := s.clients[id]; old != nil {
		old.transport.CloseIdleConnections()
		delete(s.clients, id)
	}
}

func (c *agentClient) request(ctx context.Context, method, path string, body []byte, etag string) (*http.Response, error) {
	req, err := http.NewRequestWithContext(ctx, method, c.server.URL+path, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+c.token)
	if len(body) > 0 {
		req.Header.Set("Content-Type", "application/json")
	}
	if etag != "" {
		req.Header.Set("If-Match", etag)
	}
	return c.client.Do(req)
}

func (s *Server) probe(w http.ResponseWriter, r *http.Request) {
	var input ServerInput
	if !decode(w, r, &input, 128<<10) {
		return
	}
	if err := normalizeServer(&input); err != nil {
		failure(w, 400, "invalid_server", err.Error())
		return
	}
	if input.Token == "" && input.ID != "" {
		if node, exists := s.store.Server(input.ID); exists {
			input.Token, _ = s.store.Token(node)
		}
	}
	if input.Token == "" {
		failure(w, 400, "token_required", "server token is required")
		return
	}
	client, err := newAgentClient(ServerRecord{URL: input.URL, CAPEM: input.CAPEM}, input.Token)
	if err != nil {
		failure(w, 400, "invalid_ca", err.Error())
		return
	}
	defer client.transport.CloseIdleConnections()
	ctx, cancel := context.WithTimeout(r.Context(), 8*time.Second)
	defer cancel()
	response, err := client.request(ctx, http.MethodGet, "/v1/status", nil, "")
	if err != nil {
		connectionError(w, err)
		return
	}
	defer response.Body.Close()
	forwardJSON(w, response)
}

func (s *Server) proxy(w http.ResponseWriter, r *http.Request) {
	endpoint := "/v1/" + r.PathValue("endpoint")
	if r.Method == http.MethodPut && endpoint == "/v1/config" {
		failure(w, 409, "draft_required", "save a central draft and publish it; refresh the panel to use the current workflow")
		return
	}
	allowed := (r.Method == "GET" && (endpoint == "/v1/status" || endpoint == "/v1/config" || endpoint == "/v1/logs" || endpoint == "/v1/schema")) ||
		(r.Method == "POST" && (endpoint == "/v1/config/check" ||
			endpoint == "/v1/service/start" || endpoint == "/v1/service/stop" || endpoint == "/v1/service/restart"))
	if !allowed {
		failure(w, 404, "not_found", "unknown Agent operation")
		return
	}
	client, err := s.client(r.PathValue("id"))
	if err != nil {
		failure(w, 404, "server_unavailable", err.Error())
		return
	}
	stream := endpoint == "/v1/logs"
	if stream {
		select {
		case s.streams <- struct{}{}:
			defer func() { <-s.streams }()
		default:
			failure(w, 429, "busy", "too many log readers")
			return
		}
		if len(r.URL.RawQuery) > 128 {
			failure(w, 400, "invalid_query", "log query is too long")
			return
		}
		if r.URL.RawQuery != "" {
			endpoint += "?" + r.URL.RawQuery
		}
	}
	var body []byte
	if r.Method == "PUT" || r.Method == "POST" {
		body, err = io.ReadAll(http.MaxBytesReader(w, r.Body, 13<<20))
		if err != nil {
			failure(w, 413, "request_too_large", "request exceeds 13 MiB")
			return
		}
	}
	ctx := r.Context()
	if !stream {
		timeout := 50 * time.Second
		if endpoint == "/v1/status" {
			timeout = 8 * time.Second
		}
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, timeout)
		defer cancel()
	}
	response, err := client.request(ctx, r.Method, endpoint, body, r.Header.Get("If-Match"))
	if err != nil {
		connectionError(w, err)
		return
	}
	defer response.Body.Close()
	if !stream || response.StatusCode != 200 {
		forwardJSON(w, response)
		return
	}
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.Header().Set("X-Accel-Buffering", "no")
	w.WriteHeader(200)
	controller := http.NewResponseController(w)
	_ = controller.Flush()
	buffer := make([]byte, 8192)
	for {
		n, err := response.Body.Read(buffer)
		if n > 0 {
			_ = controller.SetWriteDeadline(time.Now().Add(10 * time.Second))
			if _, writeErr := w.Write(buffer[:n]); writeErr != nil {
				return
			}
			if flushErr := controller.Flush(); flushErr != nil {
				return
			}
		}
		if err != nil {
			if !errors.Is(err, io.EOF) && ctx.Err() == nil {
				_, _ = io.WriteString(w, "\n[panel] log connection interrupted\n")
			}
			return
		}
	}
}

func forwardJSON(w http.ResponseWriter, response *http.Response) {
	if response.StatusCode == http.StatusUnauthorized {
		failure(w, 502, "agent_unauthorized", "Agent rejected the server token")
		return
	}
	body, err := io.ReadAll(io.LimitReader(response.Body, (13<<20)+1))
	if err != nil || len(body) > 13<<20 || !json.Valid(body) || response.StatusCode >= 300 && response.StatusCode < 400 {
		failure(w, 502, "invalid_agent_response", "Agent returned an invalid response")
		return
	}
	if etag := response.Header.Get("ETag"); etag != "" {
		w.Header().Set("ETag", etag)
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(response.StatusCode)
	_, _ = w.Write(body)
}

func connectionError(w http.ResponseWriter, err error) {
	var certificate *tls.CertificateVerificationError
	if errors.As(err, &certificate) {
		failure(w, 502, "certificate_error", "Agent certificate verification failed; check domain, expiry and trusted CA")
	} else {
		failure(w, 502, "connection_failed", "could not connect to Agent; check address, port and network")
	}
}
