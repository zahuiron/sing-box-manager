package panel

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"time"

	"github.com/zahuiron/sing-box-manager/internal/agent"
)

type draftRequest struct {
	Content  string `json:"content"`
	Revision int64  `json:"revision"`
}

func (s *Server) readDraft(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	draft, err := s.store.Draft(id)
	if err == nil {
		respond(w, 200, draft)
		return
	}
	if !os.IsNotExist(err) {
		draftFailure(w, err)
		return
	}
	s.importRemote(w, r, nil)
}

func (s *Server) saveDraft(w http.ResponseWriter, r *http.Request) {
	var input draftRequest
	if !decode(w, r, &input, 13<<20) {
		return
	}
	draft, err := s.store.SaveDraft(r.PathValue("id"), input.Content, input.Revision, false)
	if err != nil {
		draftFailure(w, err)
		return
	}
	respond(w, 200, draft)
}

func (s *Server) restoreDraft(w http.ResponseWriter, r *http.Request) {
	var input draftRequest
	if !decode(w, r, &input, 4096) {
		return
	}
	draft, err := s.store.SaveDraft(r.PathValue("id"), "", input.Revision, true)
	if err != nil {
		draftFailure(w, err)
		return
	}
	respond(w, 200, draft)
}

func (s *Server) importDraft(w http.ResponseWriter, r *http.Request) {
	var input draftRequest
	if !decode(w, r, &input, 4096) {
		return
	}
	s.importRemote(w, r, &input.Revision)
}

func (s *Server) operation(id string, w http.ResponseWriter, run func()) {
	if _, exists := s.store.Server(id); !exists {
		failure(w, 404, "server_unavailable", "server no longer exists")
		return
	}
	value, _ := s.operations.LoadOrStore(id, make(chan struct{}, 1))
	gate := value.(chan struct{})
	select {
	case gate <- struct{}{}:
		defer func() { <-gate }()
		run()
	default:
		failure(w, 409, "service_busy", "another server operation is running")
	}
}

func (s *Server) importRemote(w http.ResponseWriter, r *http.Request, expected *int64) {
	id := r.PathValue("id")
	s.operation(id, w, func() {
		client, err := s.client(id)
		if err != nil {
			failure(w, 404, "server_unavailable", err.Error())
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
		defer cancel()
		response, err := client.request(ctx, http.MethodGet, "/v1/config", nil, "")
		if err != nil {
			connectionError(w, err)
			return
		}
		defer response.Body.Close()
		if response.StatusCode != 200 {
			forwardJSON(w, response)
			return
		}
		var remote struct {
			Content string `json:"content"`
			ETag    string `json:"etag"`
		}
		if json.NewDecoder(io.LimitReader(response.Body, 13<<20)).Decode(&remote) != nil || remote.ETag == "" || len(remote.Content) > agent.MaxConfigBytes {
			failure(w, 502, "invalid_agent_response", "Agent did not return a valid configuration")
			return
		}
		draft, err := s.store.ImportDraft(id, client.server.URL, remote.Content, remote.ETag, expected)
		if err != nil {
			draftFailure(w, err)
			return
		}
		respond(w, 200, draft)
	})
}

func (s *Server) publishDraft(w http.ResponseWriter, r *http.Request) {
	var input draftRequest
	if !decode(w, r, &input, 4096) {
		return
	}
	id := r.PathValue("id")
	s.operation(id, w, func() {
		snapshot, err := s.store.Draft(id)
		if err != nil {
			draftFailure(w, err)
			return
		}
		if snapshot.Revision != input.Revision {
			draftFailure(w, errDraftConflict)
			return
		}
		client, err := s.client(id)
		if err != nil {
			failure(w, 404, "server_unavailable", err.Error())
			return
		}
		if snapshot.SourceURL != client.server.URL {
			draftFailure(w, errSourceChanged)
			return
		}
		body, _ := json.Marshal(map[string]any{"content": snapshot.Content, "apply": true})
		ctx, cancel := context.WithTimeout(context.WithoutCancel(r.Context()), 50*time.Second)
		defer cancel()
		response, err := client.request(ctx, http.MethodPut, "/v1/config", body, snapshot.RemoteETag)
		if err != nil {
			connectionError(w, err)
			return
		}
		defer response.Body.Close()
		if response.StatusCode != 200 {
			forwardJSON(w, response)
			return
		}
		var result struct {
			ETag    string `json:"etag"`
			Applied bool   `json:"applied"`
			State   string `json:"state"`
		}
		if json.NewDecoder(io.LimitReader(response.Body, 65536)).Decode(&result) != nil || result.ETag == "" {
			failure(w, 502, "invalid_agent_response", "publish result is unknown; import the remote configuration before retrying")
			return
		}
		draft, err := s.store.MarkPublished(id, snapshot, result.ETag)
		if err != nil {
			failure(w, 502, "publish_record_failed", "Agent accepted the configuration but its local record could not be saved; import the remote configuration")
			return
		}
		respond(w, 200, map[string]any{"draft": draft, "applied": result.Applied, "state": result.State})
	})
}

func draftFailure(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, errDraftConflict):
		failure(w, 409, "draft_conflict", err.Error())
	case errors.Is(err, errSourceChanged):
		failure(w, 409, "source_changed", err.Error())
	case os.IsNotExist(err):
		failure(w, 404, "draft_unavailable", "import the server configuration first")
	default:
		failure(w, 400, "draft_failed", err.Error())
	}
}
