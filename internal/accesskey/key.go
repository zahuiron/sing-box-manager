package accesskey

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"log"
	"os"
	"path/filepath"
	"strings"
)

func Generate() (string, error) {
	var key [32]byte
	if _, err := rand.Read(key[:]); err != nil {
		return "", err
	}
	return hex.EncodeToString(key[:]), nil
}

func read(path string) (string, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	key := strings.TrimSpace(string(data))
	if key == "" {
		return "", errors.New("access key file is empty")
	}
	return key, nil
}

func LoadOrCreate(path string) (string, error) {
	key, err := read(path)
	if !os.IsNotExist(err) {
		return key, err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return "", err
	}
	key, err = Generate()
	if err != nil {
		return "", err
	}
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if os.IsExist(err) {
		return read(path)
	}
	if err != nil {
		return "", err
	}
	saved := false
	defer func() {
		_ = f.Close()
		if !saved {
			_ = os.Remove(path)
		}
	}()
	if _, err := f.WriteString(key + "\n"); err != nil {
		return "", err
	}
	if err := f.Sync(); err != nil {
		return "", err
	}
	if err := f.Close(); err != nil {
		return "", err
	}
	saved = true
	log.Printf("generated access key: %s (saved to %s)", key, path)
	return key, nil
}
