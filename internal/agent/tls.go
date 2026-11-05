package agent

import (
	"crypto/tls"
	"crypto/x509"
	"fmt"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

type CertificateStore struct {
	paths     TLSConfig
	cert      atomic.Pointer[tls.Certificate]
	mu        sync.Mutex
	checkedAt time.Time
	certInfo  os.FileInfo
	keyInfo   os.FileInfo
}

func NewCertificateStore(paths TLSConfig) (*CertificateStore, error) {
	s := &CertificateStore{paths: paths}
	if err := s.Reload(); err != nil {
		return nil, err
	}
	return s, nil
}

func (s *CertificateStore) Reload() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.reload()
}

func (s *CertificateStore) reload() error {
	certInfo, err := os.Stat(s.paths.Cert)
	if err != nil {
		return fmt.Errorf("read TLS certificate %s: %w", s.paths.Cert, err)
	}
	keyInfo, err := os.Stat(s.paths.Key)
	if err != nil {
		return fmt.Errorf("read TLS private key %s: %w", s.paths.Key, err)
	}
	cert, err := tls.LoadX509KeyPair(s.paths.Cert, s.paths.Key)
	if err != nil {
		return fmt.Errorf("load TLS certificate/key: %w", err)
	}
	leaf, err := x509.ParseCertificate(cert.Certificate[0])
	if err != nil {
		return err
	}
	now := time.Now()
	if now.Before(leaf.NotBefore) || !now.Before(leaf.NotAfter) {
		return fmt.Errorf("TLS certificate is outside its validity period")
	}
	if domain := s.paths.Domain; domain != "" {
		matches := leaf.VerifyHostname(domain) == nil
		for _, name := range leaf.DNSNames {
			matches = matches || strings.EqualFold(name, domain)
		}
		if !matches {
			return fmt.Errorf("TLS certificate does not cover the selected domain")
		}
	}
	s.certInfo, s.keyInfo = certInfo, keyInfo
	s.checkedAt = now
	s.cert.Store(&cert)
	return nil
}

func (s *CertificateStore) TLSConfig() *tls.Config {
	return &tls.Config{
		MinVersion: tls.VersionTLS12,
		GetCertificate: func(*tls.ClientHelloInfo) (*tls.Certificate, error) {
			s.refresh()
			return s.cert.Load(), nil
		},
	}
}

func (s *CertificateStore) refresh() {
	s.mu.Lock()
	defer s.mu.Unlock()
	if time.Since(s.checkedAt) < time.Minute {
		return
	}
	s.checkedAt = time.Now()
	certInfo, certErr := os.Stat(s.paths.Cert)
	keyInfo, keyErr := os.Stat(s.paths.Key)
	if certErr != nil || keyErr != nil {
		return
	}
	changed := func(before, after os.FileInfo) bool {
		return before == nil || !os.SameFile(before, after) || before.Size() != after.Size() || !before.ModTime().Equal(after.ModTime())
	}
	if changed(s.certInfo, certInfo) || changed(s.keyInfo, keyInfo) {
		_ = s.reload()
	}
}
