package main

import (
	"context"
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

	"github.com/zahuiron/sing-box-manager/internal/accesskey"
	"github.com/zahuiron/sing-box-manager/internal/agent"
	"github.com/zahuiron/sing-box-manager/internal/panel"
)

var version = "dev"

func main() {
	flag.CommandLine = flag.NewFlagSet("sing-box-panel", flag.ExitOnError)
	log.SetPrefix("sing-box-panel: ")
	config := flag.String("config", "", "optional runtime JSON configuration")
	writeConfig := flag.String("write-config", "", "write environment settings to a runtime configuration and exit")
	listen := flag.String("listen", "", "HTTP(S) listen address")
	dir := flag.String("data-dir", "", "panel data directory")
	secret := flag.String("secret", "", "panel access secret")
	cert := flag.String("cert", "", "optional HTTPS certificate")
	key := flag.String("key", "", "optional HTTPS private key")
	init := flag.Bool("init", false, "initialize data and exit")
	generateSecret := flag.Bool("generate-secret", false, "generate a panel access secret and exit")
	importAgent := flag.String("import-agent", "", "import a local Agent configuration and exit")
	nodeName := flag.String("node-name", "Local", "name for an imported local Agent")
	showVersion := flag.Bool("version", false, "print version and exit")
	flag.Parse()
	if *generateSecret {
		secret, err := accesskey.Generate()
		if err != nil {
			log.Fatal(err)
		}
		fmt.Println(secret)
		return
	}
	if *showVersion {
		fmt.Printf("sing-box-panel %s\n", version)
		return
	}
	cfg, err := panel.LoadRuntime(*config, panel.RuntimeConfig{Listen: *listen, DataDir: *dir, Secret: *secret, Cert: *cert, Key: *key}, *writeConfig != "")
	if err != nil {
		log.Fatal(err)
	}
	if *writeConfig != "" {
		if cfg.Cert != "" {
			if _, err := agent.NewCertificateStore(agent.TLSConfig{Cert: cfg.Cert, Key: cfg.Key}); err != nil {
				log.Fatal(err)
			}
		}
		if err := panel.SaveRuntime(*writeConfig, cfg); err != nil {
			log.Fatal(err)
		}
		return
	}
	if err := run(cfg, *init, *importAgent, *nodeName); err != nil {
		log.Fatal(err)
	}
}

func run(cfg panel.RuntimeConfig, initialize bool, importPath, nodeName string) error {
	dir := cfg.DataDir
	store, err := panel.OpenStore(dir)
	if err != nil {
		return err
	}
	if importPath != "" {
		if err := store.ImportAgent(importPath, nodeName); err != nil {
			return err
		}
		fmt.Println("Local Agent imported")
		return nil
	}
	if initialize {
		fmt.Printf("Panel data initialized: %s\n", dir)
		return nil
	}
	server := &http.Server{Addr: cfg.Listen, Handler: panel.NewServer(store, version, cfg.Secret).Handler(),
		ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 20 * time.Second, IdleTimeout: 60 * time.Second, MaxHeaderBytes: 16 << 10}
	listener, err := net.Listen("tcp", cfg.Listen)
	if err != nil {
		return err
	}
	defer listener.Close()
	var certificates *agent.CertificateStore
	scheme := "http"
	if cfg.Cert != "" {
		certificates, err = agent.NewCertificateStore(agent.TLSConfig{Cert: cfg.Cert, Key: cfg.Key})
		if err != nil {
			return err
		}
		server.TLSConfig, scheme = certificates.TLSConfig(), "https"
	}
	stopped := make(chan os.Signal, 2)
	signal.Notify(stopped, os.Interrupt, syscall.SIGTERM)
	defer signal.Stop(stopped)
	reload := make(chan os.Signal, 1)
	if reloadSignal := agent.ReloadSignal(); reloadSignal != nil {
		signal.Notify(reload, reloadSignal)
		defer signal.Stop(reload)
	}
	failed := make(chan error, 1)
	go func() {
		if certificates != nil {
			failed <- server.ServeTLS(listener, "", "")
		} else {
			failed <- server.Serve(listener)
		}
	}()
	log.Printf("listening on %s://%s", scheme, listener.Addr())
	for {
		select {
		case err := <-failed:
			if errors.Is(err, http.ErrServerClosed) {
				return nil
			}
			return err
		case <-reload:
			if certificates != nil {
				if err := certificates.Reload(); err != nil {
					log.Print("TLS reload failed; keeping previous certificate")
				}
			}
		case <-stopped:
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			err := server.Shutdown(ctx)
			_ = server.Close()
			return err
		}
	}
}
