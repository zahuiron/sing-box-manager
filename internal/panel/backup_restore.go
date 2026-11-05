package panel

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"time"
)

const restoreJournalName = ".restore-journal.json"
const maxRestoreJournalBytes = 3 * maxBackupBytes

var errRestoreIncomplete = errors.New("restore rollback is incomplete; restart the panel to recover")

func readRestoreFile(path string, limit int64) ([]byte, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	data, err := io.ReadAll(io.LimitReader(f, limit+1))
	if err == nil && int64(len(data)) > limit {
		err = errors.New("restore data exceeds the size limit")
	}
	return data, err
}

func writeRestoreFiles(dir string, files map[string][]byte) error {
	names := make([]string, 0, len(files))
	for name := range files {
		if name != "panel.json" && name != "library.bin" {
			id, ok := strings.CutPrefix(name, "drafts/")
			id, suffix := strings.CutSuffix(id, ".bin")
			if !ok || !suffix || !backupIDPattern.MatchString(id) {
				return errors.New("invalid restore file path")
			}
		}
		names = append(names, name)
	}
	slices.Sort(names)
	for _, name := range names {
		path := filepath.Join(dir, filepath.FromSlash(name))
		if files[name] == nil {
			if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
				return err
			}
			continue
		}
		if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
			return err
		}
		if err := writePrivate(path, files[name]); err != nil {
			return err
		}
	}
	return nil
}

func recoverRestore(dir string) error {
	path := filepath.Join(dir, restoreJournalName)
	data, err := readRestoreFile(path, maxRestoreJournalBytes)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return err
	}
	var files map[string][]byte
	if err := json.Unmarshal(data, &files); err != nil {
		return err
	}
	if files["panel.json"] == nil || len(files) > 130 {
		return errors.New("invalid restore journal")
	}
	if err := writeRestoreFiles(dir, files); err != nil {
		return err
	}
	return os.Remove(path)
}

func (s *Store) Restore(data Backup) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	dir := filepath.Dir(s.path)
	next := database{Version: 1, Servers: []ServerRecord{}}
	files := map[string][]byte{}
	for _, server := range s.data.Servers {
		if !backupIDPattern.MatchString(server.ID) {
			return errors.New("current server has an invalid identifier")
		}
		files["drafts/"+server.ID+".bin"] = nil
	}
	for _, server := range data.Servers {
		next.Servers = append(next.Servers, ServerRecord{ID: server.ID, Name: server.Name, URL: server.URL, CAPEM: server.CAPEM,
			Secret: encode(s.aead.Seal(nil, nil, []byte(server.Token), []byte(server.ID)))})
		files["drafts/"+server.ID+".bin"] = nil
	}
	library := data.library()
	library.Revision = time.Now().UnixMilli()
	if previous, err := s.libraryLocked(); err == nil {
		library.Revision = max(library.Revision, previous.Revision+1)
	}
	seal := func(name, aad string, value any) error {
		plain, err := json.Marshal(value)
		if err == nil {
			files[name] = s.aead.Seal(nil, nil, plain, []byte(aad))
		}
		return err
	}
	if err := seal("library.bin", "library", library); err != nil {
		return err
	}
	for id, draft := range data.Drafts {
		revision := max(draft.Revision+1, time.Now().UnixMilli())
		if previous, err := s.readDraftLocked(id); err == nil {
			revision = max(revision, previous.Revision+1)
		}
		if draft.Revision == draft.PublishedRevision {
			draft.PublishedRevision = revision
		} else {
			draft.PublishedRevision = revision - 1
		}
		draft.Revision = revision
		if err := seal("drafts/"+id+".bin", "draft:"+id, draft); err != nil {
			return err
		}
	}
	encoded, err := json.MarshalIndent(next, "", "  ")
	if err != nil {
		return err
	}
	files["panel.json"] = append(encoded, '\n')
	previous := make(map[string][]byte, len(files))
	for name := range files {
		content, err := readRestoreFile(filepath.Join(dir, filepath.FromSlash(name)), 26<<20)
		if err != nil && !os.IsNotExist(err) {
			return err
		}
		previous[name] = content
	}
	if previous["panel.json"] == nil {
		return errors.New("current panel database is missing")
	}
	journal, err := json.Marshal(previous)
	if err != nil {
		return err
	}
	if len(journal) > maxRestoreJournalBytes {
		return errors.New("current data is too large for restore rollback")
	}
	journalPath := filepath.Join(dir, restoreJournalName)
	if err := writePrivate(journalPath, journal); err != nil {
		return err
	}
	err = writeRestoreFiles(dir, files)
	if err == nil {
		err = os.Remove(journalPath)
	}
	if err != nil {
		if rollback := recoverRestore(dir); rollback != nil {
			return errors.Join(errRestoreIncomplete, fmt.Errorf("%w; rollback: %v", err, rollback))
		}
		return err
	}
	s.data = next
	return nil
}
