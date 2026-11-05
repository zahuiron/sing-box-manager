package panel

import (
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"strconv"

	"github.com/zahuiron/sing-box-manager/internal/accesskey"
)

type RuntimeConfig struct {
	Listen  string `json:"listen"`
	DataDir string `json:"data_dir"`
	Secret  string `json:"secret"`
	Cert    string `json:"cert,omitempty"`
	Key     string `json:"key,omitempty"`
}

func LoadRuntime(path string, overrides RuntimeConfig, writing bool) (RuntimeConfig, error) {
	var cfg RuntimeConfig
	if path != "" {
		data, err := os.ReadFile(path)
		if err != nil && !(os.IsNotExist(err) && writing) {
			return cfg, err
		}
		if err == nil {
			if err := json.Unmarshal(data, &cfg); err != nil {
				return cfg, err
			}
		}
	}
	for _, field := range []struct {
		value         *string
		override, env string
	}{
		{&cfg.Listen, overrides.Listen, "PANEL_LISTEN"}, {&cfg.DataDir, overrides.DataDir, "PANEL_DATA_DIR"},
		{&cfg.Secret, overrides.Secret, "PANEL_SECRET"},
		{&cfg.Cert, overrides.Cert, "PANEL_TLS_CERT"}, {&cfg.Key, overrides.Key, "PANEL_TLS_KEY"},
	} {
		if field.override != "" {
			*field.value = field.override
		} else if value, exists := os.LookupEnv(field.env); exists {
			*field.value = value
		}
	}
	if cfg.Secret == "" && writing {
		var err error
		cfg.Secret, err = accesskey.Generate()
		if err != nil {
			return cfg, err
		}
	}
	if path := os.Getenv("PANEL_SECRET_FILE"); cfg.Secret == "" && path != "" && !writing {
		var err error
		cfg.Secret, err = accesskey.LoadOrCreate(path)
		if err != nil {
			return cfg, fmt.Errorf("load panel access key: %w", err)
		}
	}
	if cfg.Secret == "" || len(cfg.Secret) > 1024 {
		return cfg, errors.New("panel secret is required (at most 1024 characters); set -secret, PANEL_SECRET or config secret")
	}
	for _, char := range cfg.Secret {
		if char < '!' || char > '~' {
			return cfg, errors.New("panel secret must contain only visible ASCII characters")
		}
	}
	if cfg.Listen == "" {
		cfg.Listen = "0.0.0.0:18080"
	}
	if port := os.Getenv("PANEL_PORT"); port != "" && overrides.Listen == "" && os.Getenv("PANEL_LISTEN") == "" {
		host, _, err := net.SplitHostPort(cfg.Listen)
		if err != nil {
			return cfg, err
		}
		cfg.Listen = net.JoinHostPort(host, port)
	}
	_, port, err := net.SplitHostPort(cfg.Listen)
	if err != nil {
		return cfg, err
	}
	n, err := strconv.Atoi(port)
	if err != nil || n < 1 || n > 65535 {
		return cfg, errors.New("panel port must be between 1 and 65535")
	}
	if cfg.DataDir == "" {
		cfg.DataDir = "/var/lib/sing-box-manager-panel"
	}
	for _, path := range []*string{&cfg.DataDir, &cfg.Cert, &cfg.Key} {
		if *path != "" {
			*path, err = filepath.Abs(*path)
			if err != nil {
				return cfg, err
			}
		}
	}
	if (cfg.Cert == "") != (cfg.Key == "") {
		return cfg, errors.New("panel certificate and private key must be set together")
	}
	return cfg, nil
}

func SaveRuntime(path string, cfg RuntimeConfig) error {
	data, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return err
	}
	return writePrivate(path, append(data, '\n'))
}
