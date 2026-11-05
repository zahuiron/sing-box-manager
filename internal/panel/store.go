package panel

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync"
)

type ServerRecord struct {
	ID     string `json:"id"`
	Name   string `json:"name"`
	URL    string `json:"url"`
	CAPEM  string `json:"ca_pem,omitempty"`
	Secret string `json:"secret"`
}

type ServerView struct {
	ID    string `json:"id"`
	Name  string `json:"name"`
	URL   string `json:"url"`
	CAPEM string `json:"ca_pem,omitempty"`
}

type ServerInput struct {
	ID    string `json:"id,omitempty"`
	Name  string `json:"name"`
	URL   string `json:"url"`
	Token string `json:"token"`
	CAPEM string `json:"ca_pem,omitempty"`
}

type database struct {
	Version int            `json:"version"`
	Servers []ServerRecord `json:"nodes"` // Existing data key.
}

type Store struct {
	mu   sync.RWMutex
	path string
	aead cipher.AEAD
	data database
}

var errServerOrderConflict = errors.New("server list changed; reload before reordering")

func OpenStore(dir string) (*Store, error) {
	if err := os.MkdirAll(dir, 0700); err != nil {
		return nil, err
	}
	if err := recoverRestore(dir); err != nil {
		return nil, fmt.Errorf("recover interrupted restore: %w", err)
	}
	s := &Store{path: filepath.Join(dir, "panel.json")}
	data, err := os.ReadFile(s.path)
	first := os.IsNotExist(err)
	if err != nil && !first {
		return nil, err
	}
	keyPath := filepath.Join(dir, "master.key")
	key, err := os.ReadFile(keyPath)
	if os.IsNotExist(err) && first {
		key = make([]byte, 32)
		if _, err = rand.Read(key); err == nil {
			err = writePrivate(keyPath, key)
		}
	}
	if err != nil {
		return nil, fmt.Errorf("read panel encryption key: %w", err)
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	s.aead, err = cipher.NewGCMWithRandomNonce(block)
	if err != nil {
		return nil, err
	}
	if !first {
		if len(data) > 8<<20 {
			return nil, errors.New("panel data exceeds 8 MiB")
		}
		if err := json.Unmarshal(data, &s.data); err != nil {
			return nil, err
		}
		if s.data.Version != 1 {
			return nil, errors.New("unsupported panel data version")
		}
		return s, nil
	}
	s.data = database{Version: 1, Servers: []ServerRecord{}}
	return s, s.persist(s.data)
}

func encode(data []byte) string { return base64.RawStdEncoding.EncodeToString(data) }

func view(n ServerRecord) ServerView {
	return ServerView{ID: n.ID, Name: n.Name, URL: n.URL, CAPEM: n.CAPEM}
}

func (s *Store) Servers() []ServerView {
	s.mu.RLock()
	defer s.mu.RUnlock()
	nodes := make([]ServerView, 0, len(s.data.Servers))
	for _, node := range s.data.Servers {
		nodes = append(nodes, view(node))
	}
	return nodes
}

func (s *Store) Server(id string) (ServerRecord, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	for _, node := range s.data.Servers {
		if node.ID == id {
			return node, true
		}
	}
	return ServerRecord{}, false
}

func (s *Store) Token(node ServerRecord) (string, error) {
	sealed, err := base64.RawStdEncoding.DecodeString(node.Secret)
	if err != nil {
		return "", err
	}
	plain, err := s.aead.Open(nil, nil, sealed, []byte(node.ID))
	return string(plain), err
}

func (s *Store) Save(id string, input ServerInput) (ServerView, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	next := s.data
	next.Servers = append([]ServerRecord{}, s.data.Servers...)
	index := -1
	for i, node := range next.Servers {
		if node.ID == id && id != "" {
			index = i
			break
		}
	}
	if id != "" && index < 0 {
		return ServerView{}, errors.New("server no longer exists")
	}
	if index < 0 && len(next.Servers) >= 64 {
		return ServerView{}, errors.New("at most 64 servers are supported")
	}
	node := ServerRecord{ID: id, Name: input.Name, URL: input.URL, CAPEM: input.CAPEM}
	if index < 0 {
		node.ID = rand.Text()
	} else {
		node.Secret = next.Servers[index].Secret
	}
	if input.Token != "" {
		node.Secret = encode(s.aead.Seal(nil, nil, []byte(input.Token), []byte(node.ID)))
	}
	if node.Secret == "" {
		return ServerView{}, errors.New("server token is required")
	}
	if index < 0 {
		next.Servers = append(next.Servers, node)
	} else {
		next.Servers[index] = node
	}
	if err := s.persist(next); err != nil {
		return ServerView{}, err
	}
	s.data = next
	return view(node), nil
}

func (s *Store) ReorderServers(ids []string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if len(ids) != len(s.data.Servers) {
		return errServerOrderConflict
	}
	byID := make(map[string]ServerRecord, len(ids))
	for _, server := range s.data.Servers {
		byID[server.ID] = server
	}
	next := s.data
	next.Servers = make([]ServerRecord, 0, len(ids))
	changed := false
	for index, id := range ids {
		server, ok := byID[id]
		if !ok {
			return errServerOrderConflict
		}
		delete(byID, id)
		next.Servers = append(next.Servers, server)
		changed = changed || s.data.Servers[index].ID != id
	}
	if !changed {
		return nil
	}
	if err := s.persist(next); err != nil {
		return err
	}
	s.data = next
	return nil
}

func (s *Store) Delete(id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	next := s.data
	next.Servers = make([]ServerRecord, 0, len(s.data.Servers))
	for _, node := range s.data.Servers {
		if node.ID != id {
			next.Servers = append(next.Servers, node)
		}
	}
	if err := s.persist(next); err != nil {
		return err
	}
	s.data = next
	if path, err := draftFilename(s.path, id); err == nil {
		_ = os.Remove(path)
	}
	return nil
}

func (s *Store) persist(data database) error {
	content, err := json.MarshalIndent(data, "", "  ")
	if err != nil {
		return err
	}
	return writePrivate(s.path, append(content, '\n'))
}

func writePrivate(path string, data []byte) error {
	f, err := os.CreateTemp(filepath.Dir(path), ".sing-box-manager-panel-*")
	if err != nil {
		return err
	}
	defer os.Remove(f.Name())
	defer f.Close()
	if _, err := f.Write(data); err != nil {
		return err
	}
	if err := f.Sync(); err != nil {
		return err
	}
	if err := f.Close(); err != nil {
		return err
	}
	return os.Rename(f.Name(), path)
}
