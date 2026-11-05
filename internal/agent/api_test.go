package agent

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

const testToken = "0123456789abcdef0123456789abcdef"

type stubService struct {
	mu       sync.Mutex
	state    string
	actions  []string
	onCheck  func(string) error
	onAction func(string, int) error
}

func (s *stubService) Status(context.Context) (string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.state, nil
}

func (s *stubService) Control(_ context.Context, action string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.actions = append(s.actions, action)
	if s.onAction != nil {
		if err := s.onAction(action, len(s.actions)); err != nil {
			return err
		}
	}
	if action == "stop" {
		s.state = "stopped"
	} else {
		s.state = "running"
	}
	return nil
}

func (s *stubService) Version(context.Context) (string, error) { return "sing-box test", nil }
func (s *stubService) Check(_ context.Context, path string) error {
	if s.onCheck != nil {
		return s.onCheck(path)
	}
	return nil
}
func (s *stubService) Close(context.Context) error { return nil }
func (s *stubService) Logs(ctx context.Context, opts LogOptions, write func([]byte) error) error {
	if err := write([]byte("sample log\n")); err != nil {
		return err
	}
	if opts.Follow {
		<-ctx.Done()
		return ctx.Err()
	}
	return nil
}

func testAPI(t *testing.T, state string) (*API, *stubService) {
	t.Helper()
	dir := t.TempDir()
	path := filepath.Join(dir, "config.json")
	if err := os.WriteFile(path, []byte("{\n  \"old\": true\n}\n"), 0o640); err != nil {
		t.Fatal(err)
	}
	service := &stubService{state: state}
	cfg := Config{Token: testToken, Service: ServiceConfig{Config: path, WorkDir: dir, Driver: "process"}}
	return NewAPI(cfg, service, "test"), service
}

func request(t *testing.T, a *API, method, path string, value any, etag string) *httptest.ResponseRecorder {
	t.Helper()
	var body io.Reader
	if value != nil {
		data, err := json.Marshal(value)
		if err != nil {
			t.Fatal(err)
		}
		body = bytes.NewReader(data)
	}
	r := httptest.NewRequest(method, path, body)
	r.Header.Set("Authorization", "Bearer "+testToken)
	r.Header.Set("Content-Type", "application/json")
	if etag != "" {
		r.Header.Set("If-Match", etag)
	}
	w := httptest.NewRecorder()
	a.Handler().ServeHTTP(w, r)
	return w
}

func requireStatus(t *testing.T, w *httptest.ResponseRecorder, status int) {
	t.Helper()
	if w.Code != status {
		t.Fatalf("status %d, want %d: %s", w.Code, status, w.Body)
	}
}

func requireFile(t *testing.T, path, content string) {
	t.Helper()
	actual, err := os.ReadFile(path)
	if err != nil || string(actual) != content {
		t.Fatalf("file %s: content %q, error %v", filepath.Base(path), actual, err)
	}
}

func TestAllEndpointsRequireToken(t *testing.T) {
	a, _ := testAPI(t, "stopped")
	server := httptest.NewTLSServer(a.Handler())
	defer server.Close()
	for _, target := range []struct{ method, path string }{
		{"GET", "/v1/status"}, {"GET", "/v1/config"}, {"POST", "/v1/config/check"},
		{"PUT", "/v1/config"}, {"POST", "/v1/service/start"}, {"GET", "/v1/logs"},
	} {
		r, err := http.NewRequest(target.method, server.URL+target.path+"?token="+testToken, nil)
		if err != nil {
			t.Fatal(err)
		}
		response, err := server.Client().Do(r)
		if err != nil {
			t.Fatal(err)
		}
		_ = response.Body.Close()
		if response.StatusCode != 401 {
			t.Fatalf("%s %s: status %d", target.method, target.path, response.StatusCode)
		}
	}
	w := request(t, a, "GET", "/v1/status", nil, "")
	requireStatus(t, w, 200)
	if !strings.Contains(w.Body.String(), `"state":"stopped"`) || strings.Contains(w.Body.String(), testToken) {
		t.Fatal(w.Body.String())
	}
}

func TestConfigPreconditionsAndValidation(t *testing.T) {
	for _, tc := range []struct {
		name string
		etag string
		fail bool
		want int
	}{
		{"missing etag", "", false, 428}, {"stale etag", `"stale"`, false, 412},
		{"invalid candidate", "current", true, 422},
	} {
		t.Run(tc.name, func(t *testing.T) {
			a, service := testAPI(t, "running")
			before, _ := os.ReadFile(a.cfg.Service.Config)
			etag := tc.etag
			if etag == "current" {
				etag = configETag(before)
			}
			if tc.fail {
				service.onCheck = func(string) error { return errors.New("invalid outbound") }
			}
			w := request(t, a, "PUT", "/v1/config", configRequest{Content: `{"new":true}`, Apply: true}, etag)
			requireStatus(t, w, tc.want)
			requireFile(t, a.cfg.Service.Config, string(before))
			if len(service.actions) != 0 {
				t.Fatal("failed validation changed service state")
			}
		})
	}
}

func TestSavePreservesContentAndDoesNotStartStoppedService(t *testing.T) {
	for _, apply := range []bool{false, true} {
		t.Run(map[bool]string{false: "save only", true: "apply stopped service"}[apply], func(t *testing.T) {
			a, service := testAPI(t, "stopped")
			previous, _ := os.ReadFile(a.cfg.Service.Config)
			candidate := "{\n  \"unknown_field\": [1, 2]\n}\n"
			w := request(t, a, "PUT", "/v1/config", configRequest{Content: candidate, Apply: apply}, configETag(previous))
			requireStatus(t, w, 200)
			requireFile(t, a.cfg.Service.Config, candidate)
			requireFile(t, a.cfg.Service.Config+".bak", string(previous))
			if len(service.actions) != 0 || strings.Contains(w.Body.String(), `"applied":true`) {
				t.Fatal("saving configuration started a stopped service")
			}
			get := request(t, a, "GET", "/v1/config", nil, "")
			requireStatus(t, get, 200)
			if get.Header().Get("ETag") != configETag([]byte(candidate)) {
				t.Fatal("ETag does not describe stored bytes")
			}
		})
	}
}

func TestApplyFailureRestoresPreviousConfigAndReportsRecovery(t *testing.T) {
	for _, recoveryFails := range []bool{false, true} {
		t.Run(map[bool]string{false: "recovered", true: "recovery failed"}[recoveryFails], func(t *testing.T) {
			a, service := testAPI(t, "running")
			previous, _ := os.ReadFile(a.cfg.Service.Config)
			service.onAction = func(_ string, attempt int) error {
				if attempt == 1 || recoveryFails {
					return errors.New("failed to start")
				}
				return nil
			}
			w := request(t, a, "PUT", "/v1/config", configRequest{Content: `{"new":true}`, Apply: true}, configETag(previous))
			requireStatus(t, w, 502)
			requireFile(t, a.cfg.Service.Config, string(previous))
			if len(service.actions) != 2 {
				t.Fatalf("expected apply and recovery, got %v", service.actions)
			}
			if recoveryFails {
				if !strings.Contains(w.Body.String(), `"code":"rollback_failed"`) {
					t.Fatal(w.Body.String())
				}
			} else if !strings.Contains(w.Body.String(), `"rolled_back":true`) {
				t.Fatal(w.Body.String())
			}
		})
	}
}

func TestExternalEditDuringValidationIsNotOverwritten(t *testing.T) {
	a, service := testAPI(t, "running")
	previous, _ := os.ReadFile(a.cfg.Service.Config)
	service.onCheck = func(string) error {
		return os.WriteFile(a.cfg.Service.Config, []byte(`{"external":true}`), 0o600)
	}
	w := request(t, a, "PUT", "/v1/config", configRequest{Content: `{"new":true}`}, configETag(previous))
	requireStatus(t, w, 412)
	requireFile(t, a.cfg.Service.Config, `{"external":true}`)
}

func TestConcurrentMutationReturnsBusy(t *testing.T) {
	a, service := testAPI(t, "running")
	entered, release := make(chan struct{}), make(chan struct{})
	service.onCheck = func(string) error { close(entered); <-release; return nil }
	done := make(chan *httptest.ResponseRecorder, 1)
	go func() { done <- request(t, a, "POST", "/v1/config/check", configRequest{Content: `{}`}, "") }()
	<-entered
	w := request(t, a, "POST", "/v1/service/stop", nil, "")
	requireStatus(t, w, 409)
	close(release)
	requireStatus(t, <-done, 200)
}

func TestRejectsOversizedAndUndocumentedInput(t *testing.T) {
	a, _ := testAPI(t, "stopped")
	w := request(t, a, "POST", "/v1/config/check", configRequest{Content: strings.Repeat("x", MaxConfigBytes+1)}, "")
	requireStatus(t, w, 413)
	w = request(t, a, "POST", "/v1/config/check", map[string]string{"content": "{}", "path": "/etc/passwd"}, "")
	requireStatus(t, w, 400)
	w = request(t, a, "POST", "/v1/service/arbitrary-command", nil, "")
	requireStatus(t, w, 400)
}

func TestLogStreamReleasesSlotOnDisconnect(t *testing.T) {
	a, _ := testAPI(t, "stopped")
	server := httptest.NewTLSServer(a.Handler())
	defer server.Close()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	r, _ := http.NewRequestWithContext(ctx, "GET", server.URL+"/v1/logs?follow=true", nil)
	r.Header.Set("Authorization", "Bearer "+testToken)
	response, err := server.Client().Do(r)
	if err != nil {
		t.Fatal(err)
	}
	if response.StatusCode != 200 {
		t.Fatal(response.Status)
	}
	buffer := make([]byte, len("sample log\n"))
	if _, err := io.ReadFull(response.Body, buffer); err != nil {
		t.Fatal(err)
	}
	cancel()
	_ = response.Body.Close()
	deadline := time.Now().Add(2 * time.Second)
	for len(a.streams) != 0 && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	if len(a.streams) != 0 {
		t.Fatal("log reader leaked its slot")
	}
}
