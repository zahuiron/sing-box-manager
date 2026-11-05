package agent

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"
)

func TestMain(m *testing.M) {
	if os.Getenv("SING_BOX_MANAGER_AGENT_TEST_CORE") == "1" && len(os.Args) > 1 {
		switch os.Args[1] {
		case "version", "check", "run":
			os.Exit(testCore(os.Args[1:]))
		}
	}
	os.Exit(m.Run())
}

func testCore(args []string) int {
	if args[0] == "version" {
		fmt.Println("sing-box fixture")
		return 0
	}
	var path string
	for i := 1; i+1 < len(args); i++ {
		if args[i] == "-c" {
			path = args[i+1]
		}
	}
	data, err := os.ReadFile(path)
	if err != nil || !json.Valid(data) || bytes.Contains(data, []byte(`"reject"`)) {
		fmt.Fprintln(os.Stderr, "invalid test configuration")
		return 1
	}
	if args[0] == "check" {
		return 0
	}
	if bytes.Contains(data, []byte(`"crash"`)) {
		fmt.Fprintln(os.Stderr, "fixture startup failure")
		return 2
	}
	fmt.Println("fixture started")
	if bytes.Contains(data, []byte(`"burst"`)) {
		for i := 0; i < 1100; i++ {
			fmt.Println(strings.Repeat("x", maxLineBytes))
		}
	}
	stopped := make(chan os.Signal, 1)
	signal.Notify(stopped, os.Interrupt, syscall.SIGTERM)
	<-stopped
	fmt.Println("fixture stopped")
	return 0
}

func fixtureService(t *testing.T) (ServiceConfig, Service) {
	t.Helper()
	t.Setenv("SING_BOX_MANAGER_AGENT_TEST_CORE", "1")
	binary, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	path := filepath.Join(dir, "config.json")
	if err := os.WriteFile(path, []byte(`{}`), 0o600); err != nil {
		t.Fatal(err)
	}
	cfg := ServiceConfig{Driver: "process", Binary: binary, Config: path, WorkDir: dir, Name: "sing-box"}
	service := NewService(cfg)
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := service.Close(ctx); err != nil {
			t.Error(err)
		}
	})
	return cfg, service
}

func TestProcessLifecycleValidationAndLogs(t *testing.T) {
	cfg, service := fixtureService(t)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := service.Check(ctx, cfg.Config); err != nil {
		t.Fatal(err)
	}
	if version, err := service.Version(ctx); err != nil || version != "sing-box fixture" {
		t.Fatalf("version %q, error %v", version, err)
	}
	for _, action := range []string{"start", "start", "restart", "stop", "stop"} {
		if err := service.Control(ctx, action); err != nil {
			t.Fatalf("%s: %v", action, err)
		}
		want := "running"
		if action == "stop" {
			want = "stopped"
		}
		if state, _ := service.Status(ctx); state != want {
			t.Fatalf("%s: state %s", action, state)
		}
	}
	var logs bytes.Buffer
	if err := service.Logs(ctx, LogOptions{Lines: 100}, func(p []byte) error { _, err := logs.Write(p); return err }); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(logs.String(), "fixture started") {
		t.Fatalf("missing child logs: %s", &logs)
	}
}

func TestRealProcessApplyFailureRecovers(t *testing.T) {
	cfg, service := fixtureService(t)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := service.Control(ctx, "start"); err != nil {
		t.Fatal(err)
	}
	result, err := saveConfig(ctx, cfg, service, []byte(`{"crash":true}`), configETag([]byte(`{}`)), true)
	var failure *apiError
	if !errors.As(err, &failure) || failure.Code != "apply_failed" || !result.RolledBack {
		t.Fatalf("result %+v, error %v", result, err)
	}
	requireFile(t, cfg.Config, `{}`)
	if state, _ := service.Status(ctx); state != "running" {
		t.Fatal(state)
	}
}
