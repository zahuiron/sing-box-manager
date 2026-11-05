package agent

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/zahuiron/sing-box-manager/internal/coreinstall"
)

func InstallSingBox(basePath, version string) error {
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
	base, err := filepath.Abs(filepath.Dir(basePath))
	if err != nil {
		return err
	}
	resolve := func(value string) string {
		if value != "" && !filepath.IsAbs(value) {
			return filepath.Join(base, value)
		}
		return value
	}
	cfg.Service.Config = resolve(cfg.Service.Config)
	cfg.Service.WorkDir = resolve(cfg.Service.WorkDir)
	cfg.TLS.Cert, cfg.TLS.Key = resolve(cfg.TLS.Cert), resolve(cfg.TLS.Key)
	if cfg.Service.WorkDir == "" {
		cfg.Service.WorkDir = filepath.Dir(cfg.Service.Config)
	}
	if cfg.Service.Name == "" {
		cfg.Service.Name = "sing-box"
	}
	if strings.ContainsAny(cfg.Service.Binary, `/\`) {
		cfg.Service.Binary = resolve(cfg.Service.Binary)
	}
	if !serviceNamePattern.MatchString(cfg.Service.Name) {
		return fmt.Errorf("invalid sing-box service name")
	}
	if _, err := os.Stat(cfg.Service.Config); err != nil {
		return fmt.Errorf("prepare an existing sing-box configuration at %s: %w", cfg.Service.Config, err)
	}
	if err := os.MkdirAll(cfg.Service.WorkDir, 0755); err != nil {
		return err
	}
	binary := cfg.Service.Binary
	if binary == "" || binary == "sing-box" {
		binary, err = exec.LookPath("sing-box")
		if err != nil {
			binary = "/var/lib/sing-box-manager-agent/bin/sing-box"
		}
	}
	binary, err = filepath.Abs(binary)
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()
	installed, err := coreinstall.Install(ctx, version, binary)
	if err != nil {
		return err
	}
	fmt.Printf("sing-box %s: %s\n", installed, binary)
	return nil
}

func InstallEnvironmentSingBox() error {
	if value := os.Getenv("SING_BOX_AUTO_INSTALL"); value != "" {
		enabled, err := strconv.ParseBool(value)
		if err != nil {
			return fmt.Errorf("SING_BOX_AUTO_INSTALL must be true or false")
		}
		if !enabled {
			return nil
		}
	}
	cfg, err := environmentConfig()
	if err != nil {
		return err
	}
	if err := validateToken(cfg.Token); err != nil {
		return err
	}
	return InstallSingBox("", os.Getenv("SING_BOX_VERSION"))
}
