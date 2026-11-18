package server

import (
	"errors"
	"net/http"

	"github.com/ryotarai/minbox/internal/store"
)

// POST /api/v3/messages/{id}/ignore {key?}: the person ignores a moot question (key) or every question
// of the agent message: it stops waiting on them (NEEDS YOU, a task's derived needs you, the badges),
// and its card reads Ignored. Nothing is sent to the agent. A task the agent itself set to needs_you
// keeps that status. POST /api/v3/messages/{id}/unignore {key?} reopens them.
func (s *Server) v3Ignore(ignore bool) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Key  string   `json:"key"`
			Keys []string `json:"keys"`
		}
		if r.ContentLength != 0 && !decode(w, r, &body) {
			return
		}
		keys := body.Keys
		if body.Key != "" {
			keys = append(keys, body.Key)
		}
		ctx := r.Context()
		id := r.PathValue("id")
		if _, err := s.store.IgnoreQuestions(ctx, id, keys, ignore); err != nil {
			if errors.Is(err, store.ErrNoQuestions) {
				httpError(w, 400, err.Error())
				return
			}
			storeError(w, err)
			return
		}
		s.publishMessage(ctx, id)
		writeJSON(w, 200, map[string]bool{"ok": true})
	}
}
