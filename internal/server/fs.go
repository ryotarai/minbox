package server

import (
	"net/http"
	"path/filepath"
	"strings"

	"github.com/ryotarai/minbox/internal/hostfs"
)

// The New session dialog browses folders on the chosen host's machine.
// (The server listens on loopback only: the person browses their own disks.)

func homeDir() string {
	env, _ := hostfs.NewLocal("").Env(nil)
	return env.Home
}

func expandPath(p string) string { return hostfs.ExpandPath(homeDir(), p) }

func displayPath(p string) string { return hostfs.DisplayPath(homeDir(), p) }

func (s *Server) listDirs(w http.ResponseWriter, r *http.Request) {
	fsys, err := s.sessions.fsOf(r.URL.Query().Get("host_id"))
	if err != nil {
		httpError(w, 503, err.Error())
		return
	}
	env, err := fsys.Env(r.Context())
	if err != nil {
		httpError(w, 503, err.Error())
		return
	}
	dir := hostfs.ExpandPath(env.Home, r.URL.Query().Get("path"))
	if !filepath.IsAbs(dir) {
		httpError(w, 400, "the path must be absolute or start with ~")
		return
	}
	out, err := fsys.ListDirs(r.Context(), dir)
	if err != nil {
		if hostfs.IsNotExist(err) {
			httpError(w, 404, "No such folder")
			return
		}
		httpError(w, 403, err.Error())
		return
	}
	writeJSON(w, 200, out)
}

func (s *Server) makeDir(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Path   string `json:"path"`
		HostID string `json:"host_id"`
	}
	if !decode(w, r, &req) {
		return
	}
	fsys, err := s.sessions.fsOf(req.HostID)
	if err != nil {
		httpError(w, 503, err.Error())
		return
	}
	env, err := fsys.Env(r.Context())
	if err != nil {
		httpError(w, 503, err.Error())
		return
	}
	dir := hostfs.ExpandPath(env.Home, req.Path)
	if !filepath.IsAbs(dir) || strings.TrimSpace(req.Path) == "" {
		httpError(w, 400, "the path must be absolute or start with ~")
		return
	}
	if _, err := fsys.Stat(r.Context(), dir); err == nil {
		httpError(w, 409, "That folder already exists")
		return
	}
	if err := fsys.MkdirAll(r.Context(), dir); err != nil {
		httpError(w, 400, err.Error())
		return
	}
	writeJSON(w, 201, map[string]string{"path": dir, "display": hostfs.DisplayPath(env.Home, dir)})
}
