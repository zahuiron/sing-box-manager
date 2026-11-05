package panel

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/zahuiron/sing-box-manager/internal/agent"
)

type ProtocolCredential struct {
	Type string          `json:"type"`
	Auth json.RawMessage `json:"auth"`
}

type ProtocolUser struct {
	ID        string               `json:"id"`
	Name      string               `json:"name"`
	Protocols []ProtocolCredential `json:"protocols"`
}

type ConfigTemplate struct {
	ID      string `json:"id"`
	Name    string `json:"name"`
	Target  string `json:"target"`
	Kind    string `json:"kind"`
	Content string `json:"content"`
}

type Library struct {
	Revision      int64            `json:"revision"`
	Users         []ProtocolUser   `json:"users"`
	Templates     []ConfigTemplate `json:"templates"`
	Subscriptions []Subscription   `json:"subscriptions"`
}

const maxLibraryBytes = 8 << 20

var (
	errLibraryConflict = errors.New("library changed; reload before saving")
	errInvalidLibrary  = errors.New("invalid library")
	libraryTypePattern = regexp.MustCompile(`^[a-z][a-z0-9_\-]{0,63}$`)
)

func (s *Store) readEncrypted(path, aad string, value any, limit int64) error {
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()
	sealed, err := io.ReadAll(io.LimitReader(f, limit+1))
	if err != nil {
		return err
	}
	if int64(len(sealed)) > limit {
		return errors.New("encrypted data exceeds the size limit")
	}
	plain, err := s.aead.Open(nil, nil, sealed, []byte(aad))
	if err != nil {
		return errors.New("cannot decrypt panel data")
	}
	return json.Unmarshal(plain, value)
}

func (s *Store) writeEncrypted(path, aad string, value any) error {
	plain, err := json.Marshal(value)
	if err != nil {
		return err
	}
	return writePrivate(path, s.aead.Seal(nil, nil, plain, []byte(aad)))
}

func (s *Store) libraryLocked() (Library, error) {
	data := Library{Users: []ProtocolUser{}, Templates: []ConfigTemplate{}, Subscriptions: []Subscription{}}
	err := s.readEncrypted(filepath.Join(filepath.Dir(s.path), "library.bin"), "library", &data, maxLibraryBytes+64)
	if os.IsNotExist(err) {
		return data, nil
	}
	for index := range data.Templates {
		if data.Templates[index].Target == "" {
			data.Templates[index].Target = "server"
		}
	}
	return data, err
}

func (s *Store) Library() (Library, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.libraryLocked()
}

func (s *Store) SaveLibrary(next Library) (Library, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	previous, err := s.libraryLocked()
	if err != nil {
		return previous, err
	}
	if next.Revision != previous.Revision {
		return previous, errLibraryConflict
	}
	if next.Subscriptions == nil {
		next.Subscriptions = previous.Subscriptions
	}
	targets := make(map[string]string, len(previous.Templates))
	for _, template := range previous.Templates {
		targets[template.ID] = template.Target
	}
	for index := range next.Templates {
		if next.Templates[index].Target == "" {
			next.Templates[index].Target = targets[next.Templates[index].ID]
			if next.Templates[index].Target == "" {
				next.Templates[index].Target = "server"
			}
		}
	}
	if err := prepareSubscriptions(&next, previous); err != nil {
		return previous, fmt.Errorf("%w: %v", errInvalidLibrary, err)
	}
	if err := validateLibrary(&next); err != nil {
		return previous, fmt.Errorf("%w: %v", errInvalidLibrary, err)
	}
	next.Revision++
	if err := s.writeEncrypted(filepath.Join(filepath.Dir(s.path), "library.bin"), "library", next); err != nil {
		return previous, err
	}
	return next, nil
}

func validateLibrary(data *Library) error {
	if len(data.Users) > 256 || len(data.Templates) > 256 {
		return errors.New("library supports at most 256 users and 256 templates")
	}
	if data.Users == nil {
		data.Users = []ProtocolUser{}
	}
	if data.Templates == nil {
		data.Templates = []ConfigTemplate{}
	}
	ids, names := map[string]bool{}, map[string]bool{}
	validRecord := func(id, name string) bool {
		if id == "" || len(id) > 80 || ids[id] || name == "" || len(name) > 128 {
			return false
		}
		ids[id] = true
		return true
	}
	object := func(raw json.RawMessage) bool {
		var value map[string]json.RawMessage
		return len(raw) <= 2<<20 && json.Unmarshal(raw, &value) == nil && value != nil
	}
	for index := range data.Users {
		user := &data.Users[index]
		user.Name = strings.TrimSpace(user.Name)
		if !validRecord(user.ID, user.Name) || names[user.Name] || len(user.Protocols) > 64 {
			return errors.New("invalid or duplicate user")
		}
		names[user.Name] = true
		if user.Protocols == nil {
			user.Protocols = []ProtocolCredential{}
		}
		types := map[string]bool{}
		for _, credential := range user.Protocols {
			if !libraryTypePattern.MatchString(credential.Type) || types[credential.Type] || !object(credential.Auth) {
				return errors.New("invalid or duplicate protocol credentials")
			}
			types[credential.Type] = true
		}
	}
	for index := range data.Templates {
		template := &data.Templates[index]
		template.Name = strings.TrimSpace(template.Name)
		if !validRecord(template.ID, template.Name) || (template.Target != "client" && template.Target != "server") || !libraryTypePattern.MatchString(template.Kind) || len(template.Content) > agent.MaxConfigBytes || !object(agent.CleanJSONC([]byte(template.Content))) {
			return errors.New("invalid configuration template")
		}
	}
	for _, subscription := range data.Subscriptions {
		if !validRecord(subscription.ID, subscription.Name) {
			return errors.New("invalid or duplicate subscription")
		}
	}
	encoded, err := json.Marshal(data)
	if err != nil || len(encoded) > maxLibraryBytes {
		return fmt.Errorf("library exceeds %d MiB", maxLibraryBytes>>20)
	}
	return nil
}
