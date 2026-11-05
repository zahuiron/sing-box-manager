package coreinstall

import (
	"archive/tar"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"debug/elf"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"time"
)

type manifest struct {
	Version string `json:"version"`
	SHA256  string `json:"sha256"`
}

type release struct {
	Tag        string `json:"tag_name"`
	Draft      bool   `json:"draft"`
	Prerelease bool   `json:"prerelease"`
	Assets     []struct {
		Name   string `json:"name"`
		URL    string `json:"browser_download_url"`
		Digest string `json:"digest"`
	} `json:"assets"`
}

var versionPattern = regexp.MustCompile(`^v?[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$`)

func Install(ctx context.Context, version, destination string) (string, error) {
	if runtime.GOOS != "linux" || runtime.GOARCH != "amd64" && runtime.GOARCH != "arm64" {
		return "", errors.New("sing-box installation supports Linux amd64 and arm64")
	}
	if version == "" {
		version = "latest"
	}
	if version != "latest" {
		if !versionPattern.MatchString(version) {
			return "", errors.New("sing-box version must be latest or a release version such as 1.14.4")
		}
		version = strings.TrimPrefix(version, "v")
		if cached(destination, version) {
			return version, nil
		}
	}
	endpoint := "https://api.github.com/repos/SagerNet/sing-box/releases/latest"
	if version != "latest" {
		endpoint = "https://api.github.com/repos/SagerNet/sing-box/releases/tags/v" + version
	}
	client := &http.Client{Timeout: 3 * time.Minute}
	metadata, err := get(ctx, client, endpoint)
	if err != nil {
		return "", err
	}
	var info release
	err = json.NewDecoder(io.LimitReader(metadata.Body, 8<<20)).Decode(&info)
	metadata.Body.Close()
	if err != nil || !versionPattern.MatchString(info.Tag) || info.Draft || version == "latest" && info.Prerelease {
		return "", errors.New("GitHub did not return the requested sing-box release")
	}
	resolved := strings.TrimPrefix(info.Tag, "v")
	if version != "latest" && resolved != version {
		return "", errors.New("sing-box release version does not match the request")
	}
	if cached(destination, resolved) {
		return resolved, nil
	}
	baseName := "sing-box-" + resolved + "-linux-" + runtime.GOARCH
	var name, download, digest string
	for _, candidate := range []string{baseName + "-musl", baseName} {
		for _, asset := range info.Assets {
			if asset.Name == candidate+".tar.gz" {
				name, download, digest = candidate, asset.URL, asset.Digest
				break
			}
		}
		if download != "" {
			break
		}
	}
	if download != "https://github.com/SagerNet/sing-box/releases/download/"+info.Tag+"/"+name+".tar.gz" {
		return "", errors.New("the release has no matching sing-box archive")
	}
	if err := os.MkdirAll(filepath.Dir(destination), 0755); err != nil {
		return "", err
	}
	archive, err := os.CreateTemp(filepath.Dir(destination), ".sing-box-manager-agent-download-*")
	if err != nil {
		return "", err
	}
	defer os.Remove(archive.Name())
	defer archive.Close()
	response, err := get(ctx, client, download)
	if err != nil {
		return "", err
	}
	hash := sha256.New()
	size, err := io.Copy(io.MultiWriter(archive, hash), io.LimitReader(response.Body, (128<<20)+1))
	response.Body.Close()
	if err != nil {
		return "", err
	}
	if size > 128<<20 {
		return "", errors.New("sing-box archive exceeds 128 MiB")
	}
	if digest != "" && digest != "sha256:"+hex.EncodeToString(hash.Sum(nil)) {
		return "", errors.New("sing-box archive SHA256 verification failed")
	}
	if _, err := archive.Seek(0, io.SeekStart); err != nil {
		return "", err
	}
	compressed, err := gzip.NewReader(archive)
	if err != nil {
		return "", err
	}
	defer compressed.Close()
	reader := tar.NewReader(io.LimitReader(compressed, 512<<20))
	for {
		header, err := reader.Next()
		if err != nil {
			return "", errors.New("sing-box executable is missing from the archive")
		}
		if header.Name != name+"/sing-box" {
			continue
		}
		if header.Typeflag != tar.TypeReg || header.Size <= 0 || header.Size > 256<<20 {
			return "", errors.New("invalid sing-box executable in archive")
		}
		binary, err := os.CreateTemp(filepath.Dir(destination), ".sing-box-manager-agent-binary-*")
		if err != nil {
			return "", err
		}
		defer os.Remove(binary.Name())
		defer binary.Close()
		hash.Reset()
		if _, err := io.Copy(io.MultiWriter(binary, hash), reader); err != nil {
			return "", err
		}
		if err := validateExecutable(binary); err != nil {
			return "", err
		}
		if err := binary.Chmod(0755); err != nil {
			return "", err
		}
		if err := binary.Sync(); err != nil {
			return "", err
		}
		if err := binary.Close(); err != nil {
			return "", err
		}
		if err := os.Rename(binary.Name(), destination); err != nil {
			return "", err
		}
		data, _ := json.Marshal(manifest{Version: resolved, SHA256: hex.EncodeToString(hash.Sum(nil))})
		if err := os.WriteFile(destination+".manager-version", append(data, '\n'), 0644); err != nil {
			return "", err
		}
		return resolved, nil
	}
}

func cached(path, version string) bool {
	data, err := os.ReadFile(path + ".manager-version")
	var saved manifest
	if err != nil || len(data) > 1024 || json.Unmarshal(data, &saved) != nil || saved.Version != version {
		return false
	}
	f, err := os.Open(path)
	if err != nil {
		return false
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil || !info.Mode().IsRegular() || info.Mode()&0111 == 0 || validateExecutable(f) != nil {
		return false
	}
	hash := sha256.New()
	_, err = io.Copy(hash, f)
	return err == nil && hex.EncodeToString(hash.Sum(nil)) == saved.SHA256
}

func validateExecutable(binary *os.File) error {
	executable, err := elf.NewFile(binary)
	if err != nil {
		return fmt.Errorf("read sing-box executable: %w", err)
	}
	machine := elf.EM_X86_64
	if runtime.GOARCH == "arm64" {
		machine = elf.EM_AARCH64
	}
	if executable.Class != elf.ELFCLASS64 || executable.Data != elf.ELFDATA2LSB || executable.Machine != machine ||
		executable.Type != elf.ET_EXEC && executable.Type != elf.ET_DYN {
		return fmt.Errorf("sing-box archive does not contain a Linux %s executable", runtime.GOARCH)
	}
	for _, program := range executable.Progs {
		if program.Type == elf.PT_INTERP {
			return errors.New("sing-box archive requires a dynamic linker; use a release with a static musl build")
		}
	}
	return nil
}

func get(ctx context.Context, client *http.Client, url string) (*http.Response, error) {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	request.Header.Set("User-Agent", "sing-box-manager-agent")
	response, err := client.Do(request)
	if err != nil {
		return nil, err
	}
	if response.StatusCode != http.StatusOK {
		response.Body.Close()
		return nil, fmt.Errorf("download sing-box: HTTP %d", response.StatusCode)
	}
	return response, nil
}
