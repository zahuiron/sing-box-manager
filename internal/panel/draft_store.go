package panel

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/zahuiron/sing-box-manager/internal/agent"
)

var (
	errDraftConflict = errors.New("draft changed; reload it before saving")
	errSourceChanged = errors.New("server address changed; import its current configuration before publishing")
)

type ConfigDraft struct {
	Content           string    `json:"content"`
	PublishedContent  string    `json:"published_content"`
	Revision          int64     `json:"revision"`
	PublishedRevision int64     `json:"published_revision"`
	RemoteETag        string    `json:"remote_etag"`
	SourceURL         string    `json:"source_url"`
	UpdatedAt         time.Time `json:"updated_at"`
}

type DraftSummary struct {
	Revision          int64          `json:"revision"`
	PublishedRevision int64          `json:"published_revision"`
	Counts            map[string]int `json:"counts,omitempty"`
	UpdatedAt         time.Time      `json:"updated_at"`
}

type ManagedServer struct {
	ServerView
	Configuration *DraftSummary `json:"configuration,omitempty"`
}

func draftFilename(base, id string) (string, error) {
	if id == "" || id == "." || id == ".." || strings.ContainsAny(id, `/\`) {
		return "", errors.New("invalid server identifier")
	}
	return filepath.Join(filepath.Dir(base), "drafts", id+".bin"), nil
}

func (s *Store) serverLocked(id string) (ServerRecord, bool) {
	for _, node := range s.data.Servers {
		if node.ID == id {
			return node, true
		}
	}
	return ServerRecord{}, false
}

func (s *Store) readDraftLocked(id string) (ConfigDraft, error) {
	var draft ConfigDraft
	if _, exists := s.serverLocked(id); !exists {
		return draft, os.ErrNotExist
	}
	path, err := draftFilename(s.path, id)
	if err != nil {
		return draft, err
	}
	err = s.readEncrypted(path, "draft:"+id, &draft, 26<<20)
	return draft, err
}

func (s *Store) writeDraftLocked(id string, draft ConfigDraft) error {
	if _, exists := s.serverLocked(id); !exists {
		return os.ErrNotExist
	}
	path, err := draftFilename(s.path, id)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return err
	}
	return s.writeEncrypted(path, "draft:"+id, draft)
}

func (s *Store) Draft(id string) (ConfigDraft, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.readDraftLocked(id)
}

func (s *Store) ImportDraft(id, source, content, etag string, expected *int64) (ConfigDraft, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	previous, err := s.readDraftLocked(id)
	if err != nil && !os.IsNotExist(err) {
		return ConfigDraft{}, err
	}
	if expected == nil && err == nil {
		return previous, nil
	}
	if expected != nil && previous.Revision != *expected {
		return previous, errDraftConflict
	}
	node, ok := s.serverLocked(id)
	if !ok {
		return previous, os.ErrNotExist
	}
	if node.URL != source {
		return previous, errSourceChanged
	}
	revision := previous.Revision + 1
	draft := ConfigDraft{Content: content, PublishedContent: content, Revision: revision, PublishedRevision: revision,
		RemoteETag: etag, SourceURL: source, UpdatedAt: time.Now().UTC()}
	return draft, s.writeDraftLocked(id, draft)
}

func (s *Store) SaveDraft(id, content string, revision int64, restore bool) (ConfigDraft, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	draft, err := s.readDraftLocked(id)
	if err != nil {
		return draft, err
	}
	if draft.Revision != revision {
		return draft, errDraftConflict
	}
	if restore {
		content = draft.PublishedContent
	}
	if len(content) > agent.MaxConfigBytes || strings.TrimSpace(content) == "" {
		return draft, errors.New("configuration must contain 1 byte to 2 MiB")
	}
	if draft.Content == content {
		return draft, nil
	}
	draft.Content, draft.Revision, draft.UpdatedAt = content, draft.Revision+1, time.Now().UTC()
	return draft, s.writeDraftLocked(id, draft)
}

func (s *Store) MarkPublished(id string, snapshot ConfigDraft, etag string) (ConfigDraft, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	draft, err := s.readDraftLocked(id)
	if err != nil {
		return draft, err
	}
	node, ok := s.serverLocked(id)
	if !ok {
		return draft, os.ErrNotExist
	}
	if draft.SourceURL != snapshot.SourceURL || node.URL != snapshot.SourceURL {
		return draft, errSourceChanged
	}
	draft.PublishedRevision, draft.PublishedContent = snapshot.Revision, snapshot.Content
	draft.RemoteETag, draft.UpdatedAt = etag, time.Now().UTC()
	return draft, s.writeDraftLocked(id, draft)
}

func (s *Store) ManagedServers() []ManagedServer {
	nodes := s.Servers()
	result := make([]ManagedServer, 0, len(nodes))
	for _, node := range nodes {
		server := ManagedServer{ServerView: node}
		if draft, err := s.Draft(node.ID); err == nil {
			var fields map[string]json.RawMessage
			counts := make(map[string]int)
			if json.Unmarshal(agent.CleanJSONC([]byte(draft.Content)), &fields) == nil && fields != nil {
				for _, name := range []string{"inbounds", "outbounds", "endpoints", "services"} {
					var entries []json.RawMessage
					if json.Unmarshal(fields[name], &entries) == nil || fields[name] == nil {
						counts[name] = len(entries)
					}
				}
			}
			server.Configuration = &DraftSummary{Revision: draft.Revision, PublishedRevision: draft.PublishedRevision, Counts: counts, UpdatedAt: draft.UpdatedAt}
		}
		result = append(result, server)
	}
	return result
}
