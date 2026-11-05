package panel

import (
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"time"
)

func (s *Server) backupRequest(w http.ResponseWriter, r *http.Request) bool {
	select {
	case s.backups <- struct{}{}:
		controller := http.NewResponseController(w)
		_ = controller.SetReadDeadline(time.Now().Add(2 * time.Minute))
		_ = controller.SetWriteDeadline(time.Now().Add(2 * time.Minute))
		return true
	default:
		failure(w, 409, "backup_busy", "another backup or restore is running")
		return false
	}
}

func (s *Server) exportBackup(w http.ResponseWriter, r *http.Request) {
	if !s.backupRequest(w, r) {
		return
	}
	defer func() { <-s.backups }()
	data, err := s.store.Backup(s.version)
	if err == nil {
		err = validateBackup(&data)
	}
	if err != nil {
		failure(w, 500, "backup_failed", "could not read complete panel data")
		return
	}
	content, err := json.MarshalIndent(data, "", "  ")
	if err != nil || len(content)+1 > maxBackupBytes {
		failure(w, 500, "backup_failed", "backup exceeds 128 MiB or could not be encoded")
		return
	}
	content = append(content, '\n')
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Content-Length", strconv.Itoa(len(content)))
	w.Header().Set("Content-Disposition", `attachment; filename="sing-box-manager-backup-`+data.CreatedAt.Format("20060102T150405Z")+`.json"`)
	_, _ = w.Write(content)
}

func decodeBackup(w http.ResponseWriter, r *http.Request) (Backup, bool) {
	var data Backup
	if !decode(w, r, &data, maxBackupBytes) {
		return data, false
	}
	if err := validateBackup(&data); err != nil {
		failure(w, 400, "invalid_backup", err.Error())
		return data, false
	}
	return data, true
}

func (s *Server) checkBackup(w http.ResponseWriter, r *http.Request) {
	if !s.backupRequest(w, r) {
		return
	}
	defer func() { <-s.backups }()
	data, ok := decodeBackup(w, r)
	if !ok {
		return
	}
	respond(w, 200, map[string]any{"created_at": data.CreatedAt, "panel_version": data.PanelVersion,
		"servers": len(data.Servers), "users": len(data.Templates.Users), "client_templates": len(data.Templates.Client),
		"server_templates": len(data.Templates.Server), "subscriptions": len(data.Subscriptions), "drafts": len(data.Drafts)})
}

func (s *Server) restoreBackup(w http.ResponseWriter, r *http.Request) {
	if !s.backupRequest(w, r) {
		return
	}
	defer func() { <-s.backups }()
	data, ok := decodeBackup(w, r)
	if !ok {
		return
	}
	if !s.dataMu.TryLock() {
		failure(w, 409, "restore_busy", "panel requests are still running; retry shortly")
		return
	}
	defer s.dataMu.Unlock()
	if err := s.store.Restore(data); err != nil {
		if errors.Is(err, errRestoreIncomplete) {
			s.restoreFailed.Store(true)
			failure(w, 503, "restore_recovery_required", "restart the panel to recover the previous data")
		} else {
			failure(w, 500, "restore_failed", "restore failed; previous panel data was retained")
		}
		return
	}
	s.clientsMu.Lock()
	for _, client := range s.clients {
		client.transport.CloseIdleConnections()
	}
	s.clients = make(map[string]*agentClient)
	s.clientsMu.Unlock()
	s.operations.Clear()
	respond(w, 200, map[string]bool{"ok": true})
}
