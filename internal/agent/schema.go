package agent

import (
	"context"
	"encoding/json"
	"net/http"
	"os"
	"os/exec"
	"time"
)

func (a *API) schema(w http.ResponseWriter, r *http.Request) {
	a.schemaMu.Lock()
	defer a.schemaMu.Unlock()
	info, err := os.Stat(a.cfg.Service.Binary)
	if err != nil {
		respondError(w, problem(503, "schema_unavailable", "cannot inspect the sing-box binary"), nil)
		return
	}
	if a.schemaInfo == nil || !os.SameFile(a.schemaInfo, info) || !a.schemaInfo.ModTime().Equal(info.ModTime()) || a.schemaInfo.Size() != info.Size() {
		ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
		defer cancel()
		cmd := exec.CommandContext(ctx, a.cfg.Service.Binary, "schema")
		cmd.Dir, cmd.Env = a.cfg.Service.WorkDir, commandEnvironment()
		cmd.WaitDelay = time.Second
		output, diagnostic := &limitedBuffer{limit: (6 << 20) + 1}, &limitedBuffer{limit: 4096}
		cmd.Stdout, cmd.Stderr = output, diagnostic
		if err := cmd.Run(); err != nil || len(output.data) > 6<<20 || !json.Valid(output.data) {
			respondError(w, problem(503, "schema_unavailable", "this sing-box build cannot provide its JSON Schema"), nil)
			return
		}
		a.schemaInfo, a.schemaData = info, output.data
	}
	respondJSON(w, 200, map[string]any{"schema": json.RawMessage(a.schemaData)})
}
