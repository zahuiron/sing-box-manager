package agent

import (
	"context"
	"errors"
	"fmt"
	"log"
	"os"
	"os/exec"
	"runtime"
	"sync"
	"time"
)

type processService struct {
	cfg        ServiceConfig
	run        commandRunner
	version    string
	versionMu  sync.Mutex
	controlMu  sync.Mutex
	procMu     sync.Mutex
	cmd        *exec.Cmd
	retry      *time.Timer
	generation uint64
	failures   int
	failedAt   time.Time
	done       chan struct{}
	state      string
	logs       *logBuffer
}

func (s *processService) Status(context.Context) (string, error) {
	s.procMu.Lock()
	defer s.procMu.Unlock()
	return s.state, nil
}

func (s *processService) Control(ctx context.Context, action string) error {
	if action != "start" && action != "stop" && action != "restart" {
		return errors.New("unsupported service action")
	}
	s.controlMu.Lock()
	defer s.controlMu.Unlock()
	s.procMu.Lock()
	s.generation++
	s.failures, s.failedAt = 0, time.Time{}
	if s.retry != nil {
		s.retry.Stop()
		s.retry = nil
	}
	s.procMu.Unlock()
	switch action {
	case "start":
		return s.start(ctx)
	case "stop":
		return s.stop(ctx)
	case "restart":
		if err := s.stop(ctx); err != nil {
			return err
		}
		return s.start(ctx)
	default:
		return errors.New("unsupported service action")
	}
}

func (s *processService) start(ctx context.Context) error {
	s.procMu.Lock()
	if s.cmd != nil {
		state := s.state
		s.procMu.Unlock()
		if state == "running" {
			return nil
		}
		return fmt.Errorf("service is %s", state)
	}
	cmd := exec.Command(s.cfg.Binary, "run", "-D", s.cfg.WorkDir, "-c", s.cfg.Config)
	cmd.Dir, cmd.Env = s.cfg.WorkDir, commandEnvironment()
	configureProcess(cmd)
	out := newLineWriter(func(p []byte) error { s.logs.append(p); return nil })
	errout := newLineWriter(func(p []byte) error { s.logs.append(p); return nil })
	cmd.Stdout, cmd.Stderr = out, errout
	cmd.WaitDelay = time.Second
	done := make(chan struct{})
	started := make(chan error, 1)
	s.logs.reset()
	go func() {
		// Linux parent-death signals follow the thread that creates the child.
		runtime.LockOSThread()
		defer runtime.UnlockOSThread()
		err := cmd.Start()
		started <- err
		if err != nil {
			return
		}
		_ = cmd.Wait()
		_ = out.Flush()
		_ = errout.Flush()
		s.procMu.Lock()
		defer s.procMu.Unlock()
		stopping := s.state == "stopping"
		if stopping {
			s.state = "stopped"
		} else {
			s.state = "failed"
			s.logs.append([]byte("[agent] sing-box exited unexpectedly\n"))
		}
		s.cmd = nil
		close(done)
		if !stopping {
			s.scheduleRestart(s.generation)
		}
	}()
	if err := <-started; err != nil {
		s.state = "failed"
		s.procMu.Unlock()
		return err
	}
	s.cmd, s.done, s.state = cmd, done, "running"
	s.procMu.Unlock()
	return waitForState(ctx, s, "running")
}

// Called with procMu held; no timer runs while the core is healthy or stopped.
func (s *processService) scheduleRestart(generation uint64) {
	if generation != s.generation {
		return
	}
	if time.Since(s.failedAt) >= time.Minute {
		s.failedAt, s.failures = time.Now(), 0
	}
	if s.failures >= 5 {
		log.Print("sing-box recovery stopped after repeated exits")
		return
	}
	s.failures++
	log.Printf("sing-box exited unexpectedly; recovery %d/5 in 3s", s.failures)
	s.retry = time.AfterFunc(3*time.Second, func() {
		s.controlMu.Lock()
		defer s.controlMu.Unlock()
		s.procMu.Lock()
		if generation != s.generation {
			s.procMu.Unlock()
			return
		}
		s.retry = nil
		s.procMu.Unlock()
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		err := s.start(ctx)
		cancel()
		if err != nil {
			s.procMu.Lock()
			if s.cmd == nil && s.retry == nil {
				s.scheduleRestart(generation)
			}
			s.procMu.Unlock()
		}
	})
}

func (s *processService) stop(ctx context.Context) error {
	s.procMu.Lock()
	if s.cmd == nil {
		s.state = "stopped"
		s.procMu.Unlock()
		return nil
	}
	cmd, done := s.cmd, s.done
	s.state = "stopping"
	s.procMu.Unlock()
	if err := stopProcess(cmd, false); err != nil && !errors.Is(err, os.ErrProcessDone) {
		return err
	}
	timer := time.NewTimer(3 * time.Second)
	defer timer.Stop()
	select {
	case <-done:
		return nil
	case <-ctx.Done():
		_ = stopProcess(cmd, true)
		return ctx.Err()
	case <-timer.C:
		_ = stopProcess(cmd, true)
	}
	select {
	case <-done:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (s *processService) Close(ctx context.Context) error { return s.Control(ctx, "stop") }

func (s *processService) Logs(ctx context.Context, opts LogOptions, write func([]byte) error) error {
	var sequence uint64
	initial := true
	ticker := time.NewTicker(250 * time.Millisecond)
	defer ticker.Stop()
	for {
		entries, latest := s.logs.snapshot(sequence, opts.Lines, initial)
		for _, entry := range entries {
			if err := write(entry.data); err != nil {
				return err
			}
		}
		sequence, initial = latest, false
		if !opts.Follow {
			return nil
		}
		if err := write(nil); err != nil {
			return err
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-ticker.C:
		}
	}
}
