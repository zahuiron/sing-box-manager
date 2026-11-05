package agent

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/json"
	"encoding/pem"
	"math/big"
	"net"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func writeTestCertificate(t *testing.T, dir string, serial int64, expired bool) (TLSConfig, *x509.CertPool) {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	until := time.Now().Add(time.Hour)
	if expired {
		until = time.Now().Add(-time.Minute)
	}
	template := &x509.Certificate{SerialNumber: big.NewInt(serial), Subject: pkix.Name{CommonName: "agent test"},
		NotBefore: time.Now().Add(-time.Hour), NotAfter: until,
		KeyUsage: x509.KeyUsageDigitalSignature | x509.KeyUsageCertSign, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		IPAddresses: []net.IP{net.ParseIP("127.0.0.1")}, DNSNames: []string{"localhost"},
		IsCA: true, BasicConstraintsValid: true}
	der, err := x509.CreateCertificate(rand.Reader, template, template, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	keyDER, err := x509.MarshalPKCS8PrivateKey(key)
	if err != nil {
		t.Fatal(err)
	}
	paths := TLSConfig{Cert: filepath.Join(dir, "cert.pem"), Key: filepath.Join(dir, "key.pem")}
	certPEM := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})
	if err := os.WriteFile(paths.Cert, certPEM, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(paths.Key, pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: keyDER}), 0o600); err != nil {
		t.Fatal(err)
	}
	roots := x509.NewCertPool()
	roots.AppendCertsFromPEM(certPEM)
	return paths, roots
}

func TestCertificateReloadKeepsWorkingCertificateOnFailure(t *testing.T) {
	dir := t.TempDir()
	paths, _ := writeTestCertificate(t, dir, 1, false)
	store, err := NewCertificateStore(paths)
	if err != nil {
		t.Fatal(err)
	}
	getSerial := func() int64 {
		cert, _ := store.TLSConfig().GetCertificate(&tls.ClientHelloInfo{})
		leaf, err := x509.ParseCertificate(cert.Certificate[0])
		if err != nil {
			t.Fatal(err)
		}
		return leaf.SerialNumber.Int64()
	}
	writeTestCertificate(t, dir, 2, false)
	if err := store.Reload(); err != nil || getSerial() != 2 {
		t.Fatal("new certificate was not loaded", err)
	}
	writeTestCertificate(t, dir, 3, true)
	if err := store.Reload(); err == nil || getSerial() != 2 {
		t.Fatal("expired certificate replaced working certificate")
	}
	if err := os.WriteFile(paths.Key, []byte("invalid private key"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := store.Reload(); err == nil || getSerial() != 2 {
		t.Fatal("invalid key replaced working certificate")
	}
}

func TestLoadConfigResolvesPathsAndRejectsUnsafeInputs(t *testing.T) {
	binary, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	path := filepath.Join(dir, "agent.json")
	coreDir := filepath.Join(dir, "core")
	if err := os.Mkdir(coreDir, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(coreDir, "profile.json"), []byte(`{}`), 0600); err != nil {
		t.Fatal(err)
	}
	cfg := Config{Token: testToken, TLS: TLSConfig{Cert: "cert.pem", Key: "key.pem"},
		Service: ServiceConfig{Driver: "openrc", Name: "sing-box", Binary: binary, Config: "core", WorkDir: "."}}
	write := func(value Config) {
		data, _ := json.Marshal(value)
		if err := os.WriteFile(path, data, 0o600); err != nil {
			t.Fatal(err)
		}
	}
	write(cfg)
	loaded, err := LoadConfig(path)
	if err != nil || loaded.Service.Config != coreDir || loaded.Service.WorkDir != dir {
		t.Fatalf("loaded %+v, error %v", loaded.Service, err)
	}
	for _, change := range []func(*Config){
		func(c *Config) { c.Token = "short" },
		func(c *Config) { c.Service.Driver = "ssh" },
		func(c *Config) { c.Service.Name = "sing-box; arbitrary-command" },
	} {
		bad := cfg
		change(&bad)
		write(bad)
		if _, err := LoadConfig(path); err == nil {
			t.Fatal("invalid configuration was accepted")
		}
	}
	if err := os.WriteFile(path, []byte(`{"token":"`+strings.Repeat("x", 32)+`","unexpected":true}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := LoadConfig(path); err == nil {
		t.Fatal("unknown field was accepted")
	}
}
