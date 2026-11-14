package server

import (
	"net/http"
	"strings"

	"github.com/ryotarai/minbox/internal/store"
)

// GET /api/agents: the coding agents minbox can run, which of them are installed on this machine,
// and the one a new session gets by default. Nothing here runs Claude Code or Pi: installed means the
// configured command's executable is on PATH. No agent is required at startup; with none installed
// the list says so and starting a session fails with a message that names the missing command.
//
// With ?host_id= of a remote host the list is that machine's (found by its host: the executables on
// its PATH, Node's version for Pi, `opencode --version`), and the default is one that host can run.
// ?fresh=1 probes the host again.
func (s *Server) listAgents(w http.ResponseWriter, r *http.Request) {
	hostID := strings.TrimSpace(r.URL.Query().Get("host_id"))
	if hostID == "" || hostID == store.LocalHostID {
		cmds := s.sessions.commands()
		writeJSON(w, 200, map[string]any{
			"agents":  cmds.Infos(),
			"default": s.sessions.defaultAgent(r.Context()),
		})
		return
	}
	if s.sessions.hosts.get(hostID) == nil {
		httpError(w, 404, "no such host: "+hostID)
		return
	}
	infos, err := s.sessions.hostAgents(r.Context(), hostID, r.URL.Query().Get("fresh") == "1")
	if err != nil {
		writeJSON(w, 200, map[string]any{"agents": []any{}, "default": s.sessions.defaultAgent(r.Context()), "host_id": hostID, "error": err.Error()})
		return
	}
	writeJSON(w, 200, map[string]any{
		"agents":  infos,
		"default": s.sessions.hostDefaultAgent(r.Context(), hostID),
		"host_id": hostID,
	})
}
