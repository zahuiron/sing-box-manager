package agent

import (
	"bufio"
	"bytes"
	"context"
	"crypto/tls"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync/atomic"
	"syscall"
	"testing"
	"time"
)

func processUsage(pid int) (int64, int64, error) {
	status, err := os.ReadFile(fmt.Sprintf("/proc/%d/status", pid))
	if err != nil {
		return 0, 0, err
	}
	var rss int64
	for _, line := range strings.Split(string(status), "\n") {
		if strings.HasPrefix(line, "VmRSS:") {
			rss, _ = strconv.ParseInt(strings.Fields(line)[1], 10, 64)
		}
	}
	stat, err := os.ReadFile(fmt.Sprintf("/proc/%d/stat", pid))
	if err != nil {
		return 0, 0, err
	}
	fields := strings.Fields(string(stat)[strings.LastIndexByte(string(stat), ')')+1:])
	user, _ := strconv.ParseInt(fields[11], 10, 64)
	system, _ := strconv.ParseInt(fields[12], 10, 64)
	return rss, user + system, nil
}

func TestExecutableSmoke(t *testing.T) {
	binary := os.Getenv("SBM_AGENT_BINARY")
	if binary == "" {
		t.Skip("set SBM_AGENT_BINARY to test the built executable")
	}
	serviceConfig, _ := fixtureService(t)
	dir := t.TempDir()
	paths, roots := writeTestCertificate(t, dir, 10, false)
	noAutoStart := false
	serviceConfig.AutoStart = &noAutoStart
	cfg := Config{Listen: "127.0.0.1:0", Token: testToken, TLS: paths, Service: serviceConfig}
	configPath := filepath.Join(dir, "agent.json")
	data, _ := json.Marshal(cfg)
	if err := os.WriteFile(configPath, data, 0o600); err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command(binary, "-config", configPath)
	stderr, err := cmd.StderrPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	exited := make(chan error, 1)
	go func() { exited <- cmd.Wait() }()
	defer func() {
		_ = cmd.Process.Signal(syscall.SIGTERM)
		select {
		case err := <-exited:
			if err != nil {
				t.Errorf("agent shutdown: %v", err)
			}
		case <-time.After(6 * time.Second):
			_ = cmd.Process.Kill()
			<-exited
			t.Error("agent did not shut down")
		}
	}()
	events := make(chan string, 32)
	go func() {
		scanner := bufio.NewScanner(stderr)
		for scanner.Scan() {
			select {
			case events <- scanner.Text():
			default:
			}
		}
	}()
	waitEvent := func(contains string) string {
		t.Helper()
		timer := time.NewTimer(5 * time.Second)
		defer timer.Stop()
		for {
			select {
			case line := <-events:
				if strings.Contains(line, contains) {
					return line
				}
			case <-timer.C:
				t.Fatalf("agent did not report %q", contains)
			}
		}
	}
	ready := waitEvent("agent listening on https://")
	_, address, _ := strings.Cut(ready, "agent listening on ")
	address = strings.Fields(address)[0]
	transport := &http.Transport{TLSClientConfig: &tls.Config{RootCAs: roots, MinVersion: tls.VersionTLS12}}
	defer transport.CloseIdleConnections()
	client := &http.Client{Transport: transport, Timeout: 10 * time.Second}
	call := func(method, path string, body any, etag string) (*http.Response, []byte) {
		t.Helper()
		var reader io.Reader
		if body != nil {
			data, _ := json.Marshal(body)
			reader = bytes.NewReader(data)
		}
		r, _ := http.NewRequest(method, address+path, reader)
		r.Header.Set("Authorization", "Bearer "+testToken)
		r.Header.Set("Content-Type", "application/json")
		r.Header.Set("If-Match", etag)
		response, err := client.Do(r)
		if err != nil {
			t.Fatal(err)
		}
		data, err := io.ReadAll(response.Body)
		_ = response.Body.Close()
		if err != nil || response.StatusCode != 200 {
			t.Fatalf("%s %s: %s, error %v, body %s", method, path, response.Status, err, data)
		}
		return response, data
	}
	call("GET", "/v1/status", nil, "")
	idleRSS, beforeCPU, err := processUsage(cmd.Process.Pid)
	if err != nil {
		t.Fatal(err)
	}
	time.Sleep(2 * time.Second)
	_, afterCPU, _ := processUsage(cmd.Process.Pid)
	var peak atomic.Int64
	peak.Store(idleRSS)
	monitorDone := make(chan struct{})
	defer close(monitorDone)
	go func() {
		ticker := time.NewTicker(20 * time.Millisecond)
		defer ticker.Stop()
		for {
			select {
			case <-monitorDone:
				return
			case <-ticker.C:
				rss, _, err := processUsage(cmd.Process.Pid)
				if err == nil && rss > peak.Load() {
					peak.Store(rss)
				}
			}
		}
	}()
	for i := 0; i < 10; i++ {
		response, _ := call("GET", "/v1/config", nil, "")
		call("POST", "/v1/config/check", configRequest{Content: `{}`}, "")
		call("PUT", "/v1/config", configRequest{Content: `{"burst":true}`}, response.Header.Get("ETag"))
	}
	call("POST", "/v1/service/start", nil, "")
	response, logs := call("GET", "/v1/logs?lines=1000", nil, "")
	if len(logs) > maxLogBytes || response.Header.Get("Content-Type") != "text/plain; charset=utf-8" {
		t.Fatal("log snapshot exceeded its bounds")
	}
	ctx, cancel := context.WithCancel(context.Background())
	r, _ := http.NewRequestWithContext(ctx, "GET", address+"/v1/logs?follow=true", nil)
	r.Header.Set("Authorization", "Bearer "+testToken)
	follow, err := client.Do(r)
	if err != nil {
		t.Fatal(err)
	}
	cancel()
	_ = follow.Body.Close()
	call("POST", "/v1/service/stop", nil, "")
	_, newRoots := writeTestCertificate(t, dir, 11, false)
	if err := cmd.Process.Signal(syscall.SIGHUP); err != nil {
		t.Fatal(err)
	}
	waitEvent("TLS certificate reloaded")
	transport.CloseIdleConnections()
	transport.TLSClientConfig = &tls.Config{RootCAs: newRoots, MinVersion: tls.VersionTLS12}
	response, _ = call("GET", "/v1/status", nil, "")
	if response.TLS.PeerCertificates[0].SerialNumber.Int64() != 11 {
		t.Fatal("SIGHUP did not replace the served certificate")
	}
	low, high := int64(1<<60), int64(0)
	for i := 0; i < 10; i++ {
		time.Sleep(500 * time.Millisecond)
		rss, _, err := processUsage(cmd.Process.Pid)
		if err != nil {
			t.Fatal(err)
		}
		low, high = min(low, rss), max(high, rss)
	}
	t.Logf("Agent only: idle_rss=%d KiB, idle_cpu_delta=%d ticks/2s, peak_rss=%d KiB, final_rss_range=%d..%d KiB/5s; log snapshot=%d bytes", idleRSS, afterCPU-beforeCPU, peak.Load(), low, high, len(logs))
}
