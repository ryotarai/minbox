package server

import (
	"errors"
	"fmt"
	"net/http"
	"strings"

	"github.com/ryotarai/minbox/internal/store"
)

// ---- projects ----

func (s *Server) projectJSON(r *http.Request, ps ...store.Project) []store.Project {
	names := s.hostNames(r.Context())
	for i := range ps {
		ps[i].HostName = names[ps[i].HostID]
	}
	return ps
}

// publishProjects tells browsers a project changed; sessions and threads follow when asked.
func (s *Server) publishProjects(sessionsToo bool) {
	s.hub.publish(Event{Type: "projects"})
	if sessionsToo {
		s.hub.publish(Event{Type: "sessions"})
		s.hub.publish(Event{Type: "threads"})
	}
}

func (s *Server) listProjects(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query().Get("archived")
	ps, err := s.store.ListProjects(r.Context(), q == "1" || q == "true")
	if err != nil {
		storeError(w, err)
		return
	}
	writeJSON(w, 200, s.projectJSON(r, ps...))
}

func (s *Server) createProject(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Name   string `json:"name"`
		Dir    string `json:"dir"`
		HostID string `json:"host_id"`
	}
	if !decode(w, r, &req) {
		return
	}
	hostID := strings.TrimSpace(req.HostID)
	if hostID == "" {
		hostID = store.LocalHostID
	}
	dir, err := s.projectDir(r, hostID, req.Dir)
	if err != nil {
		httpError(w, 400, err.Error())
		return
	}
	p, err := s.store.CreateProject(r.Context(), req.Name, dir, hostID)
	if err != nil {
		if isConflict(err) {
			storeError(w, err)
		} else {
			httpError(w, 400, err.Error())
		}
		return
	}
	got, err := s.store.GetProject(r.Context(), p.ID)
	if err != nil {
		storeError(w, err)
		return
	}
	s.publishProjects(false)
	writeJSON(w, 201, s.projectJSON(r, *got)[0])
}

// projectDir resolves dir on the host (~ is its home) and checks it is a folder there.
func (s *Server) projectDir(r *http.Request, hostID, dir string) (string, error) {
	if s.sessions.hosts.get(hostID) == nil {
		return "", fmt.Errorf("no such host: %s", hostID)
	}
	f, err := s.sessions.fsOf(hostID)
	if err != nil {
		return "", err
	}
	return resolveDirOn(r.Context(), f, strings.TrimSpace(dir))
}

func (s *Server) patchProject(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Name   *string `json:"name"`
		Dir    *string `json:"dir"`
		HostID *string `json:"host_id"`
		Pinned *bool   `json:"pinned"`
		// MainSession: a Claude Code session of the project to make its main one.
		MainSession *string `json:"main_session_id"`
	}
	if !decode(w, r, &req) {
		return
	}
	id := r.PathValue("id")
	patch := store.ProjectPatch{Name: req.Name, HostID: req.HostID, Pinned: req.Pinned, MainSession: req.MainSession}
	if req.Dir != nil || req.HostID != nil {
		cur, err := s.store.GetProject(r.Context(), id)
		if err != nil {
			storeError(w, err)
			return
		}
		host, dir := cur.HostID, cur.Dir
		if req.HostID != nil && *req.HostID != "" {
			host = *req.HostID
		}
		if req.Dir != nil {
			dir = *req.Dir
		}
		// Only a change is checked against the host (and refused later when there are sessions).
		if host != cur.HostID || strings.TrimSpace(dir) != cur.Dir {
			d, err := s.projectDir(r, host, dir)
			if err != nil {
				httpError(w, 400, err.Error())
				return
			}
			patch.Dir, patch.HostID = &d, &host
		} else {
			patch.Dir, patch.HostID = nil, nil
		}
	}
	p, err := s.store.UpdateProject(r.Context(), id, patch)
	if err != nil {
		if isConflict(err) || isNotFound(err) {
			storeError(w, err)
		} else {
			httpError(w, 400, err.Error())
		}
		return
	}
	s.publishProjects(patch.Name != nil || patch.MainSession != nil)
	writeJSON(w, 200, s.projectJSON(r, *p)[0])
}

func (s *Server) deleteProject(w http.ResponseWriter, r *http.Request) {
	if err := s.sessions.DeleteProject(r.Context(), r.PathValue("id")); err != nil {
		storeError(w, err)
		return
	}
	s.publishProjects(true)
	writeJSON(w, 200, map[string]bool{"ok": true})
}

func (s *Server) projectDeletePreview(w http.ResponseWriter, r *http.Request) {
	d, err := s.store.ProjectDeletePreview(r.Context(), r.PathValue("id"))
	if err != nil {
		storeError(w, err)
		return
	}
	writeJSON(w, 200, d)
}

func (s *Server) archiveProject(archive bool) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if err := s.store.SetProjectArchived(r.Context(), r.PathValue("id"), archive); err != nil {
			storeError(w, err)
			return
		}
		s.publishProjects(true)
		writeJSON(w, 200, map[string]bool{"ok": true})
	}
}

func isConflict(err error) bool {
	return errors.Is(err, store.ErrProjectBusy) || errors.Is(err, store.ErrProjectExists)
}

func isNotFound(err error) bool { return errors.Is(err, store.ErrNotFound) }
