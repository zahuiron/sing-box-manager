package panel

import (
	"crypto/x509"
	"encoding/pem"
	"errors"
	"net"
	"os"
	"strings"

	"github.com/zahuiron/sing-box-manager/internal/agent"
)

func (s *Store) ImportAgent(path, name string) error {
	cfg, err := agent.LoadConfig(path)
	if err != nil {
		return err
	}
	certificate, err := os.ReadFile(cfg.TLS.Cert)
	if err != nil {
		return err
	}
	block, _ := pem.Decode(certificate)
	if block == nil {
		return errors.New("Agent certificate is not PEM encoded")
	}
	leaf, err := x509.ParseCertificate(block.Bytes)
	if err != nil {
		return err
	}
	host, port, err := net.SplitHostPort(cfg.Listen)
	if err != nil {
		return err
	}
	if host == "" || host == "0.0.0.0" || host == "::" || leaf.VerifyHostname(host) != nil {
		host = ""
		for _, candidate := range leaf.DNSNames {
			if !strings.Contains(candidate, "*") {
				host = candidate
				break
			}
		}
		if host == "" && len(leaf.IPAddresses) > 0 {
			host = leaf.IPAddresses[0].String()
		}
	}
	if host == "" {
		return errors.New("add this Agent manually using a hostname covered by its certificate")
	}
	input := ServerInput{Name: name, URL: "https://" + net.JoinHostPort(host, port), Token: cfg.Token}
	if leaf.CheckSignature(leaf.SignatureAlgorithm, leaf.RawTBSCertificate, leaf.Signature) == nil {
		input.CAPEM = string(certificate)
	}
	if err := normalizeServer(&input); err != nil {
		return err
	}
	id := ""
	for _, node := range s.Servers() {
		if node.URL == input.URL {
			id = node.ID
			break
		}
	}
	_, err = s.Save(id, input)
	return err
}
