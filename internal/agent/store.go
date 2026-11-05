package agent

import (
	"bytes"
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
)

type apiError struct {
	Status int
	Code   string
	Err    error
}

func (e *apiError) Error() string { return e.Err.Error() }

func problem(status int, code, message string) error {
	return &apiError{Status: status, Code: code, Err: errors.New(message)}
}

func configETag(data []byte) string { return fmt.Sprintf(`"%x"`, sha256.Sum256(data)) }

func readConfig(path string) ([]byte, os.FileInfo, error) {
	info, err := os.Lstat(path)
	if err != nil {
		return nil, nil, err
	}
	if !info.Mode().IsRegular() {
		return nil, nil, errors.New("configuration must be a regular file, not a symlink")
	}
	if info.Size() > MaxConfigBytes {
		return nil, nil, problem(413, "config_too_large", "configuration exceeds 2 MiB")
	}
	f, err := os.Open(path)
	if err != nil {
		return nil, nil, err
	}
	defer f.Close()
	data, err := io.ReadAll(io.LimitReader(f, MaxConfigBytes+1))
	if len(data) > MaxConfigBytes {
		return nil, nil, problem(413, "config_too_large", "configuration exceeds 2 MiB")
	}
	return data, info, err
}

func validateConfig(ctx context.Context, cfg ServiceConfig, service Service, content []byte) error {
	if len(bytes.TrimSpace(content)) == 0 {
		return problem(400, "empty_config", "configuration cannot be empty")
	}
	if len(content) > MaxConfigBytes {
		return problem(413, "config_too_large", "configuration exceeds 2 MiB")
	}
	f, err := os.CreateTemp(filepath.Dir(cfg.Config), ".sing-box-manager-agent-check-*")
	if err != nil {
		return err
	}
	path := f.Name()
	defer os.Remove(path)
	if _, err := f.Write(content); err != nil {
		_ = f.Close()
		return err
	}
	if err := f.Close(); err != nil {
		return err
	}
	if err := service.Check(ctx, path); err != nil {
		return &apiError{Status: 422, Code: "invalid_config", Err: err}
	}
	return nil
}

func writeAtomic(path string, data []byte, info os.FileInfo) error {
	f, err := os.CreateTemp(filepath.Dir(path), ".sing-box-manager-agent-write-*")
	if err != nil {
		return err
	}
	defer os.Remove(f.Name())
	defer f.Close()
	if err := preserveOwner(f, info); err != nil {
		return err
	}
	if err := f.Chmod(info.Mode().Perm()); err != nil {
		return err
	}
	if _, err := f.Write(data); err != nil {
		return err
	}
	if err := f.Sync(); err != nil {
		return err
	}
	if err := f.Close(); err != nil {
		return err
	}
	return os.Rename(f.Name(), path)
}

type saveResult struct {
	ETag       string `json:"etag"`
	Applied    bool   `json:"applied"`
	State      string `json:"state,omitempty"`
	RolledBack bool   `json:"rolled_back,omitempty"`
}

func saveConfig(ctx context.Context, cfg ServiceConfig, service Service, content []byte, expected string, apply bool) (saveResult, error) {
	var result saveResult
	if expected == "" {
		return result, problem(428, "precondition_required", "If-Match must contain the ETag from GET /v1/config")
	}
	previous, info, err := readConfig(cfg.Config)
	if err != nil {
		return result, err
	}
	if configETag(previous) != expected {
		return result, problem(412, "config_conflict", "configuration changed; read it again before saving")
	}
	if err := validateConfig(ctx, cfg, service, content); err != nil {
		return result, err
	}
	state := ""
	if apply {
		state, err = service.Status(ctx)
		if err != nil || state == "unknown" {
			return result, problem(503, "state_unknown", "cannot determine service state; configuration was not written")
		}
		if state == "starting" || state == "stopping" {
			return result, problem(409, "service_busy", "service is changing state")
		}
	}
	current, _, err := readConfig(cfg.Config)
	if err != nil {
		return result, err
	}
	if configETag(current) != expected {
		return result, problem(412, "config_conflict", "configuration changed during validation")
	}
	if err := writeAtomic(cfg.Config+".bak", previous, info); err != nil {
		return result, fmt.Errorf("create configuration backup: %w", err)
	}
	if err := writeAtomic(cfg.Config, content, info); err != nil {
		return result, fmt.Errorf("write configuration: %w", err)
	}
	result.ETag, result.State = configETag(content), state
	if !apply || state != "running" {
		return result, nil
	}
	if err := service.Control(ctx, "restart"); err == nil {
		result.Applied = true
		return result, nil
	}
	result.State = "unknown"
	// Recovery has its own deadline: a failed restart may consume the request budget.
	recoveryCtx, cancel := context.WithTimeout(context.Background(), operationTimeout)
	defer cancel()
	current, _, err = readConfig(cfg.Config)
	if err != nil || configETag(current) != result.ETag {
		result.ETag = ""
		if err == nil {
			result.ETag = configETag(current)
		}
		return result, problem(502, "rollback_conflict", "apply failed; configuration changed or cannot be read, so recovery was not attempted")
	}
	if err := writeAtomic(cfg.Config, previous, info); err != nil {
		return result, problem(502, "rollback_failed", "apply failed and the previous configuration could not be restored; inspect the .bak file")
	}
	result.ETag = expected
	if err := service.Control(recoveryCtx, "restart"); err != nil {
		return result, problem(502, "rollback_failed", "previous file restored, but service recovery failed; inspect service logs")
	}
	result.RolledBack, result.State = true, "running"
	return result, problem(502, "apply_failed", "apply failed; previous configuration and running service were restored")
}
