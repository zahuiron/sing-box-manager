package agent

import (
	"context"
	"errors"
	"fmt"
	"os/exec"
	"strings"
	"time"
)

type LogOptions struct {
	Lines  int
	Follow bool
}

type Service interface {
	Status(context.Context) (string, error)
	Control(context.Context, string) error
	Version(context.Context) (string, error)
	Check(context.Context, string) error
	Logs(context.Context, LogOptions, func([]byte) error) error
	Close(context.Context) error
}

type commandResult struct {
	Output string
	Code   int
}

type commandRunner func(context.Context, string, string, ...string) (commandResult, error)

func NewService(cfg ServiceConfig) Service {
	return &processService{cfg: cfg, run: runCommand, logs: newLogBuffer(), state: "stopped"}
}

func (s *processService) Version(ctx context.Context) (string, error) {
	s.versionMu.Lock()
	defer s.versionMu.Unlock()
	if s.version != "" {
		return s.version, nil
	}
	result, err := s.run(ctx, s.cfg.WorkDir, s.cfg.Binary, "version")
	if err != nil || result.Code != 0 {
		return "", commandError(result, err)
	}
	s.version = strings.TrimSpace(strings.SplitN(result.Output, "\n", 2)[0])
	return s.version, nil
}

func (s *processService) Check(ctx context.Context, path string) error {
	if _, err := configurationFile(path); err != nil {
		return err
	}
	result, err := s.run(ctx, s.cfg.WorkDir, s.cfg.Binary, "check", "-D", s.cfg.WorkDir, "-C", path)
	if err != nil || result.Code != 0 {
		return commandError(result, err)
	}
	return nil
}

func commandError(result commandResult, err error) error {
	if result.Output != "" {
		return errors.New(strings.TrimSpace(result.Output))
	}
	if err != nil {
		return err
	}
	return fmt.Errorf("command exited with code %d", result.Code)
}

func runCommand(ctx context.Context, dir, binary string, args ...string) (commandResult, error) {
	cmd := exec.CommandContext(ctx, binary, args...)
	cmd.Dir = dir
	cmd.Env = commandEnvironment()
	cmd.WaitDelay = time.Second
	output := &limitedBuffer{limit: 32 << 10}
	cmd.Stdout, cmd.Stderr = output, output
	err := cmd.Run()
	result := commandResult{Output: output.String()}
	var exit *exec.ExitError
	if errors.As(err, &exit) {
		result.Code = exit.ExitCode()
		return result, nil
	}
	return result, err
}

func waitForState(ctx context.Context, s Service, wanted string) error {
	stable := time.Time{}
	ticker := time.NewTicker(100 * time.Millisecond)
	defer ticker.Stop()
	for {
		state, err := s.Status(ctx)
		if err != nil {
			return err
		}
		if state == wanted {
			if stable.IsZero() {
				stable = time.Now()
			}
			if wanted == "stopped" || time.Since(stable) >= 300*time.Millisecond {
				return nil
			}
		} else {
			stable = time.Time{}
			if state == "failed" || (wanted == "running" && state == "stopped") {
				return fmt.Errorf("service entered %s state", state)
			}
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-ticker.C:
		}
	}
}
