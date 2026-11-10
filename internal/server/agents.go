package server

import (
	"net/http"
)

// GET /api/agents: the coding agents minbox can run, which of them are installed on this machine,
// and the one a new session gets by default. Nothing here runs an agent: installed means the
// configured command's executable is on PATH. No agent is required at startup; with none installed
// the list says so and starting a session fails with a message that names the missing command.
func (s *Server) listAgents(w http.ResponseWriter, r *http.Request) {
	cmds := s.sessions.commands()
	writeJSON(w, 200, map[string]any{
		"agents":  cmds.Infos(),
		"default": s.sessions.defaultAgent(r.Context()),
	})
}
