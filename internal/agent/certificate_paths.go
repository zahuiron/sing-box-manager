package agent

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

type domainNames []string

func (d *domainNames) UnmarshalJSON(data []byte) error {
	if len(data) > 0 && data[0] == '"' {
		var name string
		if err := json.Unmarshal(data, &name); err != nil {
			return err
		}
		*d = []string{name}
		return nil
	}
	return json.Unmarshal(data, (*[]string)(d))
}

type acmeSource struct {
	Type      string      `json:"type"`
	Domains   domainNames `json:"domain"`
	Directory string      `json:"data_directory"`
	Provider  string      `json:"provider"`
}

type inboundTLS struct {
	Certificate string          `json:"certificate_path"`
	Key         string          `json:"key_path"`
	ACME        *acmeSource     `json:"acme"`
	Provider    json.RawMessage `json:"certificate_provider"`
}

func discoverCertificate(tlsConfig TLSConfig, service ServiceConfig) (TLSConfig, error) {
	if tlsConfig.Cert != "" || tlsConfig.Key != "" {
		if tlsConfig.Cert == "" || tlsConfig.Key == "" {
			return tlsConfig, errors.New("tls.cert and tls.key must be provided together")
		}
		return tlsConfig, nil
	}
	data, _, err := readConfig(service.Config)
	if err != nil {
		return tlsConfig, fmt.Errorf("discover TLS certificate from sing-box configuration: %w", err)
	}
	var options struct {
		Providers []acmeSource `json:"certificate_providers"`
		Inbounds  []struct {
			TLS *inboundTLS `json:"tls"`
		} `json:"inbounds"`
	}
	if err := json.Unmarshal(CleanJSONC(data), &options); err != nil {
		return tlsConfig, errors.New("cannot read certificate settings: sing-box configuration must be valid JSON/JSONC")
	}
	for _, inbound := range options.Inbounds {
		if inbound.TLS == nil {
			continue
		}
		t := inbound.TLS
		if t.Certificate != "" && t.Key != "" && tlsConfig.Domain == "" && tlsConfig.ACMEDir == "" {
			tlsConfig.Cert = corePath(service.WorkDir, t.Certificate)
			tlsConfig.Key = corePath(service.WorkDir, t.Key)
			return tlsConfig, nil
		}
		if t.ACME != nil {
			t.ACME.Type = "acme"
			options.Providers = append(options.Providers, *t.ACME)
		}
		if len(t.Provider) > 0 && t.Provider[0] == '{' {
			var provider acmeSource
			if err := json.Unmarshal(t.Provider, &provider); err != nil {
				return tlsConfig, errors.New("cannot read inline certificate provider")
			}
			options.Providers = append(options.Providers, provider)
		}
	}
	for _, source := range options.Providers {
		if source.Type != "acme" || len(source.Domains) == 0 {
			continue
		}
		for _, domain := range source.Domains {
			if tlsConfig.Domain != "" && !matchesDomain(domain, tlsConfig.Domain) {
				continue
			}
			roots := certificateRoots(source.Directory, tlsConfig.ACMEDir, service.WorkDir)
			issuer := source.Provider
			switch issuer {
			case "", "letsencrypt":
				issuer = "https://acme-v02.api.letsencrypt.org/directory"
			case "zerossl":
				issuer = "https://acme.zerossl.com/v2/DV90"
			}
			parsed, err := url.Parse(issuer)
			if err != nil || parsed.Scheme != "https" || parsed.Host == "" {
				return tlsConfig, errors.New("invalid ACME issuer URL")
			}
			issuerKey := parsed.Host
			if path := strings.Trim(strings.NewReplacer("/", "-", `\`, "-").Replace(parsed.Path), "-"); path != "" {
				issuerKey += "-" + path
			}
			name := storageName(domain)
			if name == "" {
				return tlsConfig, errors.New("ACME domain has no usable certificate storage name")
			}
			tlsConfig.Auto = true
			if tlsConfig.Domain == "" {
				tlsConfig.Domain = domain
			}
			for i, root := range roots {
				base := filepath.Join(root, "certificates", storageName(issuerKey), name, name)
				cert, key := base+".crt", base+".key"
				if i == 0 {
					tlsConfig.Cert, tlsConfig.Key = cert, key
				}
				if _, err := os.Stat(cert); err == nil {
					if _, err := os.Stat(key); err == nil {
						tlsConfig.Cert, tlsConfig.Key = cert, key
						return tlsConfig, nil
					}
				}
			}
			return tlsConfig, nil
		}
	}
	return tlsConfig, errors.New("no reusable TLS certificate found in sing-box configuration; set --cert/--key or select an ACME domain with --tls-domain")
}

func corePath(workDir, path string) string {
	path = os.ExpandEnv(path)
	if filepath.IsAbs(path) {
		return filepath.Clean(path)
	}
	return filepath.Join(workDir, path)
}

func certificateRoots(configured, override, workDir string) []string {
	if override != "" {
		return []string{corePath(workDir, override)}
	}
	if configured != "" {
		return []string{corePath(workDir, configured)}
	}
	if dataHome := os.Getenv("XDG_DATA_HOME"); dataHome != "" {
		return []string{corePath(workDir, filepath.Join(dataHome, "certmagic"))}
	}
	home, _ := os.UserHomeDir()
	if home == "" {
		home = workDir
	}
	primary := corePath(workDir, filepath.Join(home, ".local", "share", "certmagic"))
	fallback := filepath.Join(workDir, ".local", "share", "certmagic")
	if primary == fallback {
		return []string{primary}
	}
	return []string{primary, fallback}
}

func matchesDomain(pattern, name string) bool {
	pattern, name = strings.ToLower(pattern), strings.ToLower(name)
	if pattern == name {
		return true
	}
	if strings.HasPrefix(pattern, "*.") {
		_, suffix, found := strings.Cut(name, ".")
		return found && suffix == pattern[2:]
	}
	return false
}

var unsafeStorageName = regexp.MustCompile(`[^\w@.-]`)

func storageName(name string) string {
	name = strings.ToLower(strings.TrimSpace(name))
	name = strings.NewReplacer(" ", "_", "+", "_plus_", "*", "wildcard_", ":", "-", "..", "").Replace(name)
	return unsafeStorageName.ReplaceAllLiteralString(name, "")
}

func CleanJSONC(data []byte) []byte {
	clean := bytes.Clone(data)
	inString, escaped := false, false
	for i := 0; i < len(clean); i++ {
		c := clean[i]
		if inString {
			if escaped {
				escaped = false
			} else if c == '\\' {
				escaped = true
			} else if c == '"' {
				inString = false
			}
			continue
		}
		if c == '"' {
			inString = true
		} else if c == '/' && i+1 < len(clean) && clean[i+1] == '/' {
			for i < len(clean) && clean[i] != '\n' {
				clean[i] = ' '
				i++
			}
		} else if c == '/' && i+1 < len(clean) && clean[i+1] == '*' {
			clean[i], clean[i+1] = ' ', ' '
			i += 2
			for i+1 < len(clean) && !(clean[i] == '*' && clean[i+1] == '/') {
				clean[i] = ' '
				i++
			}
			if i+1 >= len(clean) {
				return nil
			}
			clean[i], clean[i+1] = ' ', ' '
			i++
		}
	}
	inString, escaped = false, false
	for i, c := range clean {
		if inString {
			if escaped {
				escaped = false
			} else if c == '\\' {
				escaped = true
			} else if c == '"' {
				inString = false
			}
		} else if c == '"' {
			inString = true
		} else if c == ',' {
			j := i + 1
			for j < len(clean) && (clean[j] == ' ' || clean[j] == '\r' || clean[j] == '\n' || clean[j] == '\t') {
				j++
			}
			if j < len(clean) && (clean[j] == ']' || clean[j] == '}') {
				clean[i] = ' '
			}
		}
	}
	return clean
}
