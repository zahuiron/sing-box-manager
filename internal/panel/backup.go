package panel

import (
	"errors"
	"fmt"
	"os"
	"regexp"
	"strings"
	"time"

	"github.com/zahuiron/sing-box-manager/internal/agent"
)

const maxBackupBytes = 128 << 20
const maxBackupRevision = 1<<53 - 2

var backupIDPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{1,80}$`)

type BackupTemplates struct {
	Users  []ProtocolUser   `json:"users"`
	Client []ConfigTemplate `json:"client"`
	Server []ConfigTemplate `json:"server"`
}

type Backup struct {
	Format        string                 `json:"format"`
	Version       int                    `json:"version"`
	PanelVersion  string                 `json:"panel_version"`
	CreatedAt     time.Time              `json:"created_at"`
	Servers       []ServerInput          `json:"servers"`
	Templates     BackupTemplates        `json:"templates"`
	Subscriptions []Subscription         `json:"subscriptions"`
	Drafts        map[string]ConfigDraft `json:"drafts"`
}

func (b *Backup) library() Library {
	return Library{Users: b.Templates.Users,
		Templates:     append(append([]ConfigTemplate{}, b.Templates.Server...), b.Templates.Client...),
		Subscriptions: b.Subscriptions}
}

func (s *Store) Backup(version string) (Backup, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	library, err := s.libraryLocked()
	if err != nil {
		return Backup{}, err
	}
	data := Backup{Format: "sing-box-manager", Version: 1, PanelVersion: version, CreatedAt: time.Now().UTC(),
		Servers: []ServerInput{}, Templates: BackupTemplates{Users: library.Users, Client: []ConfigTemplate{}, Server: []ConfigTemplate{}},
		Subscriptions: library.Subscriptions, Drafts: map[string]ConfigDraft{}}
	if data.Templates.Users == nil {
		data.Templates.Users = []ProtocolUser{}
	}
	if data.Subscriptions == nil {
		data.Subscriptions = []Subscription{}
	}
	for _, template := range library.Templates {
		if template.Target == "client" {
			data.Templates.Client = append(data.Templates.Client, template)
		} else {
			data.Templates.Server = append(data.Templates.Server, template)
		}
	}
	for _, server := range s.data.Servers {
		token, err := s.Token(server)
		if err != nil {
			return data, err
		}
		data.Servers = append(data.Servers, ServerInput{ID: server.ID, Name: server.Name, URL: server.URL, Token: token, CAPEM: server.CAPEM})
		draft, err := s.readDraftLocked(server.ID)
		if err == nil {
			data.Drafts[server.ID] = draft
		} else if !os.IsNotExist(err) {
			return data, err
		}
	}
	return data, nil
}

func validateBackup(data *Backup) error {
	if data.Format != "sing-box-manager" || data.Version != 1 {
		return errors.New("unsupported backup format or version")
	}
	if data.CreatedAt.IsZero() || data.Servers == nil || data.Drafts == nil || data.Templates.Users == nil || data.Templates.Client == nil || data.Templates.Server == nil || data.Subscriptions == nil {
		return errors.New("backup is missing required sections")
	}
	if len(data.Servers) > 64 || len(data.Drafts) > 64 || len(data.Subscriptions) > 256 {
		return errors.New("backup has too many servers, drafts or subscriptions")
	}
	ids := make(map[string]bool, len(data.Servers))
	for index := range data.Servers {
		server := &data.Servers[index]
		if !backupIDPattern.MatchString(server.ID) || ids[server.ID] || server.Token == "" {
			return fmt.Errorf("servers[%d]: invalid ID, duplicate ID or missing token", index)
		}
		if err := normalizeServer(server); err != nil {
			return fmt.Errorf("servers[%d]: %w", index, err)
		}
		client, err := newAgentClient(ServerRecord{CAPEM: server.CAPEM}, "")
		if err != nil {
			return fmt.Errorf("servers[%d]: %w", index, err)
		}
		client.transport.CloseIdleConnections()
		ids[server.ID] = true
	}
	for _, group := range []struct {
		target string
		items  []ConfigTemplate
	}{{"client", data.Templates.Client}, {"server", data.Templates.Server}} {
		for index, template := range group.items {
			if template.Target != group.target {
				return fmt.Errorf("templates.%s[%d]: template target does not match its section", group.target, index)
			}
		}
	}
	library := data.library()
	if err := validateLibrary(&library); err != nil {
		return err
	}
	for index, profile := range data.Subscriptions {
		if len(profile.Token) != 52 || strings.IndexFunc(profile.Token, func(r rune) bool { return r < '!' || r > '~' }) >= 0 || profile.ResetToken {
			return fmt.Errorf("subscriptions[%d]: invalid link token", index)
		}
		if err := validateSubscription(profile); err != nil {
			return fmt.Errorf("subscriptions[%d]: %w", index, err)
		}
	}
	for id, draft := range data.Drafts {
		if !ids[id] {
			return fmt.Errorf("drafts.%s: server does not exist in this backup", id)
		}
		if draft.Revision < 1 || draft.Revision > maxBackupRevision || draft.PublishedRevision < 1 || draft.PublishedRevision > draft.Revision ||
			len(draft.Content) > agent.MaxConfigBytes || len(draft.PublishedContent) > agent.MaxConfigBytes ||
			strings.TrimSpace(draft.Content) == "" || strings.TrimSpace(draft.PublishedContent) == "" ||
			len(draft.SourceURL) > 2048 || len(draft.RemoteETag) > 4096 || draft.UpdatedAt.IsZero() {
			return fmt.Errorf("drafts.%s: invalid configuration or revision", id)
		}
	}
	return nil
}
