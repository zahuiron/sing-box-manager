package main

import (
	"context"
	"crypto/tls"
	"errors"
	"flag"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/zahuiron/sing-box-manager/internal/agent"
)

var version = "dev"

func main() {
	flag.CommandLine = flag.NewFlagSet("sing-box-manager-agent", flag.ExitOnError)
	log.SetPrefix("sing-box-manager-agent: ")
	path := flag.String("config", "/etc/sing-box-manager-agent/config.json", "agent JSON configuration")
	fromEnv := flag.Bool("env", false, "read configuration from environment variables")
	writeConfig := flag.String("write-config", "", "write validated environment settings to a JSON configuration and exit")
	generate := flag.Bool("generate-token", false, "generate a node token and exit")
	showVersion := flag.Bool("version", false, "print version and exit")
	serviceInfo := flag.Bool("service-info", false, "print configured driver and service name, then exit")
	installCore := flag.Bool("install-sing-box", false, "install the managed sing-box binary")
	coreVersion := flag.String("sing-box-version", "latest", "sing-box release to install (default: latest stable)")
	flag.Parse()
	if *showVersion {
		fmt.Printf("sing-box-manager-agent %s\n", version)
		return
	}
	if *serviceInfo {
		service, err := agent.ConfiguredService(*path)
		if err != nil {
			log.Fatal(err)
		}
		fmt.Printf("%s %s\n", service.Driver, service.Name)
		return
	}
	if *installCore {
		if err := agent.InstallSingBox(*path, *coreVersion); err != nil {
			log.Fatal(err)
		}
		return
	}
	if *generate {
		token, err := agent.GenerateToken()
		if err != nil {
			log.Fatal(err)
		}
		fmt.Println(token)
		return
	}
	if *writeConfig != "" {
		if err := agent.WriteEnvironmentConfig(*path, *writeConfig); err != nil {
			log.Fatal(err)
		}
		fmt.Printf("Configuration written: %s\n", *writeConfig)
		return
	}
	if err := run(*path, *fromEnv); err != nil {
		log.Fatal(err)
	}
}

func run(path string, fromEnv bool) error {
	var cfg agent.Config
	var err error
	if fromEnv {
		if err := agent.InstallEnvironmentSingBox(); err != nil {
			return err
		}
		cfg, err = agent.LoadEnvironment()
	} else {
		cfg, err = agent.LoadConfig(path)
	}
	if err != nil {
		return err
	}
	stopped := make(chan os.Signal, 2)
	signal.Notify(stopped, os.Interrupt, syscall.SIGTERM)
	defer signal.Stop(stopped)
	reload := make(chan os.Signal, 1)
	if reloadSignal := agent.ReloadSignal(); reloadSignal != nil {
		signal.Notify(reload, reloadSignal)
		defer signal.Stop(reload)
	}
	service := agent.NewService(cfg.Service)
	defer func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = service.Close(ctx)
	}()
	autoStart := cfg.Service.AutoStart == nil || *cfg.Service.AutoStart
	started := false
	certificates, err := agent.NewCertificateStore(cfg.TLS)
	if err != nil && cfg.TLS.Auto && autoStart {
		log.Print("starting sing-box and waiting for its ACME certificate")
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		startErr := service.Control(ctx, "start")
		cancel()
		if startErr != nil {
			return startErr
		}
		started = true
		certificates, err = waitForCertificate(cfg.TLS, service, stopped)
		if errors.Is(err, context.Canceled) {
			return nil
		}
	}
	if err != nil {
		return err
	}
	listener, err := net.Listen("tcp", cfg.Listen)
	if err != nil {
		return err
	}
	defer listener.Close()
	if autoStart && !started {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		err := service.Control(ctx, "start")
		cancel()
		if err != nil {
			log.Print("sing-box did not start; management API remains available")
		}
	}
	api := agent.NewAPI(cfg, service, version)
	server := &http.Server{
		Handler: api.Handler(), TLSConfig: certificates.TLSConfig(),
		ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 15 * time.Second,
		IdleTimeout: 30 * time.Second, MaxHeaderBytes: 16 << 10,
	}
	serveError := make(chan error, 1)
	go func() { serveError <- server.Serve(tls.NewListener(listener, server.TLSConfig)) }()
	log.Printf("listening on https://%s (%s)", listener.Addr(), cfg.Service.Driver)
	for {
		select {
		case err := <-serveError:
			if errors.Is(err, http.ErrServerClosed) {
				return nil
			}
			return err
		case <-reload:
			if err := certificates.Reload(); err != nil {
				log.Print("TLS reload failed; keeping previous certificate")
			} else {
				log.Print("TLS certificate reloaded")
			}
		case <-stopped:
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			err := server.Shutdown(ctx)
			cancel()
			_ = server.Close()
			return err
		}
	}
}

func waitForCertificate(paths agent.TLSConfig, service agent.Service, stopped <-chan os.Signal) (*agent.CertificateStore, error) {
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	deadline := time.NewTimer(5 * time.Minute)
	defer deadline.Stop()
	for {
		certificates, err := agent.NewCertificateStore(paths)
		if err == nil {
			return certificates, nil
		}
		if state, _ := service.Status(context.Background()); state == "failed" || state == "stopped" {
			return nil, fmt.Errorf("sing-box stopped before its ACME certificate became available: %w", err)
		}
		select {
		case <-stopped:
			return nil, context.Canceled
		case <-deadline.C:
			return nil, fmt.Errorf("ACME certificate was not available within five minutes: %w", err)
		case <-ticker.C:
		}
	}
}
