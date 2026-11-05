package agent

import (
	"encoding/json"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"strconv"

	"github.com/zahuiron/sing-box-manager/internal/accesskey"
)

func GenerateToken() (string, error) {
	return accesskey.Generate()
}

func defaultEnvConfig() Config {
	return Config{Listen: ":9091", Service: ServiceConfig{Driver: "process", Name: "sing-box",
		Binary: "sing-box", Config: "/etc/sing-box/config.json", WorkDir: "/var/lib/sing-box"}}
}

func applyEnvironment(cfg Config) (Config, error) {
	fields := map[string]*string{
		"AGENT_LISTEN": &cfg.Listen, "AGENT_TOKEN": &cfg.Token,
		"AGENT_TLS_CERT": &cfg.TLS.Cert, "AGENT_TLS_KEY": &cfg.TLS.Key,
		"AGENT_TLS_DOMAIN": &cfg.TLS.Domain, "AGENT_ACME_DIR": &cfg.TLS.ACMEDir,
		"AGENT_SERVICE":   &cfg.Service.Name,
		"SING_BOX_BINARY": &cfg.Service.Binary, "SING_BOX_CONFIG": &cfg.Service.Config,
		"SING_BOX_WORK_DIR": &cfg.Service.WorkDir,
	}
	for name, field := range fields {
		if value, exists := os.LookupEnv(name); exists {
			*field = value
		}
	}
	if os.Getenv("AGENT_TLS_CERT") != "" || os.Getenv("AGENT_TLS_KEY") != "" {
		cfg.TLS.Auto = false
		if os.Getenv("AGENT_TLS_DOMAIN") == "" {
			cfg.TLS.Domain = ""
		}
	} else if os.Getenv("AGENT_TLS_DOMAIN") != "" || os.Getenv("AGENT_ACME_DIR") != "" {
		cfg.TLS.Cert, cfg.TLS.Key = "", ""
	}
	if cfg.Listen == "" {
		cfg.Listen = ":9091"
	}
	if port := os.Getenv("AGENT_PORT"); port != "" && os.Getenv("AGENT_LISTEN") == "" {
		n, err := strconv.Atoi(port)
		if err != nil || n < 1 || n > 65535 {
			return cfg, fmt.Errorf("AGENT_PORT must be between 1 and 65535")
		}
		host, _, err := net.SplitHostPort(cfg.Listen)
		if err != nil {
			return cfg, fmt.Errorf("invalid listen address: %w", err)
		}
		cfg.Listen = net.JoinHostPort(host, port)
	}
	if value, exists := os.LookupEnv("SING_BOX_AUTO_START"); exists {
		autoStart, err := strconv.ParseBool(value)
		if err != nil {
			return cfg, fmt.Errorf("SING_BOX_AUTO_START must be true or false")
		}
		cfg.Service.AutoStart = &autoStart
	}
	cfg.Service.Driver, cfg.Service.LogFile = "process", ""
	return cfg, nil
}

func environmentConfig() (Config, error) {
	cfg, err := applyEnvironment(defaultEnvConfig())
	if err != nil {
		return cfg, err
	}
	if path := os.Getenv("AGENT_TOKEN_FILE"); cfg.Token == "" && path != "" {
		cfg.Token, err = accesskey.LoadOrCreate(path)
		if err != nil {
			return cfg, fmt.Errorf("load agent access key: %w", err)
		}
	}
	return cfg, nil
}

func LoadEnvironment() (Config, error) {
	cfg, err := environmentConfig()
	if err != nil {
		return cfg, err
	}
	return prepareConfig(cfg, "agent.json")
}

func WriteEnvironmentConfig(basePath, outputPath string) error {
	cfg, err := decodeConfig(basePath)
	if os.IsNotExist(err) {
		cfg, err = defaultEnvConfig(), nil
	}
	if err != nil {
		return err
	}
	cfg, err = applyEnvironment(cfg)
	if err != nil {
		return err
	}
	if cfg.Token == "" {
		cfg.Token, err = GenerateToken()
		if err != nil {
			return err
		}
	}
	cfg, err = prepareConfig(cfg, basePath)
	if err != nil {
		return err
	}
	if _, err := NewCertificateStore(cfg.TLS); err != nil {
		return err
	}
	if _, _, err := readConfig(cfg.Service.Config); err != nil {
		return fmt.Errorf("read sing-box configuration: %w", err)
	}
	data, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return err
	}
	f, err := os.CreateTemp(filepath.Dir(outputPath), ".sbm-config-*")
	if err != nil {
		return err
	}
	defer os.Remove(f.Name())
	defer f.Close()
	if _, err := f.Write(append(data, '\n')); err != nil {
		return err
	}
	if err := f.Sync(); err != nil {
		return err
	}
	if err := f.Close(); err != nil {
		return err
	}
	return os.Rename(f.Name(), outputPath)
}
