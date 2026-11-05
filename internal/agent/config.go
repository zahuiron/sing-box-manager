package agent

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
)

const MaxConfigBytes = 2 << 20

type Config struct {
	Listen  string        `json:"listen"`
	Token   string        `json:"token"`
	TLS     TLSConfig     `json:"tls"`
	Service ServiceConfig `json:"service"`
}

type TLSConfig struct {
	Cert    string `json:"cert,omitempty"`
	Key     string `json:"key,omitempty"`
	Domain  string `json:"domain,omitempty"`
	ACMEDir string `json:"acme_dir,omitempty"`
	Auto    bool   `json:"auto,omitempty"`
}

type ServiceConfig struct {
	Driver    string `json:"driver"`
	Name      string `json:"name"`
	Binary    string `json:"binary"`
	Config    string `json:"config"`
	WorkDir   string `json:"work_dir"`
	LogFile   string `json:"log_file,omitempty"`
	AutoStart *bool  `json:"auto_start,omitempty"`
}

var serviceNamePattern = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9_.@-]*$`)

func validateToken(token string) error {
	if len(token) < 32 || strings.ContainsAny(token, " \t\r\n<>") {
		return errors.New("token must contain at least 32 non-whitespace characters; use -generate-token")
	}
	return nil
}

func LoadConfig(path string) (Config, error) {
	cfg, err := decodeConfig(path)
	if err != nil {
		return cfg, err
	}
	return prepareConfig(cfg, path)
}

func ConfiguredService(path string) (ServiceConfig, error) {
	cfg, err := decodeConfig(path)
	if err != nil {
		return cfg.Service, err
	}
	if cfg.Service.Name == "" {
		cfg.Service.Name = "sing-box"
	}
	if cfg.Service.Driver == "" {
		cfg.Service.Driver = "process"
	}
	if !serviceNamePattern.MatchString(cfg.Service.Name) {
		return cfg.Service, errors.New("invalid service name")
	}
	return cfg.Service, nil
}

func decodeConfig(path string) (Config, error) {
	var cfg Config
	f, err := os.Open(path)
	if err != nil {
		return cfg, err
	}
	defer f.Close()
	decoder := json.NewDecoder(io.LimitReader(f, 64<<10))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&cfg); err != nil {
		return cfg, fmt.Errorf("read agent configuration: %w", err)
	}
	if err := decoder.Decode(new(any)); err != io.EOF {
		return cfg, errors.New("agent configuration must contain one JSON object")
	}
	return cfg, nil
}

func prepareConfig(cfg Config, path string) (Config, error) {
	if cfg.Listen == "" {
		cfg.Listen = ":9091"
	}
	if _, _, err := net.SplitHostPort(cfg.Listen); err != nil {
		return cfg, fmt.Errorf("invalid listen address: %w", err)
	}
	if err := validateToken(cfg.Token); err != nil {
		return cfg, err
	}
	base, err := filepath.Abs(filepath.Dir(path))
	if err != nil {
		return cfg, err
	}
	resolve := func(value string) string {
		if value == "" || filepath.IsAbs(value) {
			return value
		}
		return filepath.Join(base, value)
	}
	if cfg.Service.Config == "" {
		return cfg, errors.New("service.config is required")
	}
	cfg.TLS.Cert, cfg.TLS.Key = resolve(cfg.TLS.Cert), resolve(cfg.TLS.Key)
	cfg.Service.Config = resolve(cfg.Service.Config)
	cfg.Service.WorkDir = resolve(cfg.Service.WorkDir)
	if cfg.Service.WorkDir == "" {
		cfg.Service.WorkDir = filepath.Dir(cfg.Service.Config)
	}
	if cfg.Service.Binary == "" {
		cfg.Service.Binary = "sing-box"
	}
	if strings.ContainsAny(cfg.Service.Binary, `/\`) {
		cfg.Service.Binary = resolve(cfg.Service.Binary)
	}
	binary, err := exec.LookPath(cfg.Service.Binary)
	if err != nil && cfg.Service.Binary == "sing-box" {
		binary, err = exec.LookPath("/var/lib/sing-box-manager-agent/bin/sing-box")
	}
	if err != nil {
		return cfg, fmt.Errorf("find sing-box binary: %w", err)
	}
	cfg.Service.Binary, err = filepath.Abs(binary)
	if err != nil {
		return cfg, err
	}
	if cfg.Service.Name == "" {
		cfg.Service.Name = "sing-box"
	}
	if !serviceNamePattern.MatchString(cfg.Service.Name) {
		return cfg, errors.New("invalid service name")
	}
	switch cfg.Service.Driver {
	case "", "systemd", "openrc", "process":
	default:
		return cfg, errors.New("unsupported service.driver")
	}
	cfg.Service.Driver, cfg.Service.LogFile = "process", ""
	info, err := os.Stat(cfg.Service.WorkDir)
	if err != nil || !info.IsDir() {
		return cfg, errors.New("service.work_dir must be an existing directory")
	}
	cfg.TLS, err = discoverCertificate(cfg.TLS, cfg.Service)
	if err != nil {
		return cfg, err
	}
	return cfg, nil
}
