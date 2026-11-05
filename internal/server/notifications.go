package server

import (
	"context"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/ryotarai/minbox/internal/notify"
	"github.com/ryotarai/minbox/internal/store"
)

// Notifications: destinations that hear about each new message of the agent in a thread.
// The destination's config holds secrets (a webhook URL): the API only ever shows it masked.

func validPublicURL(u string) bool {
	if u == "" {
		return true
	}
	p, err := url.Parse(u)
	return err == nil && (p.Scheme == "http" || p.Scheme == "https") && p.Host != ""
}

// threadLink is the URL that opens a thread, "" when no public URL is set.
func threadLinkURL(publicURL, sessionID, threadID string) string {
	base := strings.TrimRight(strings.TrimSpace(publicURL), "/")
	if base == "" {
		return ""
	}
	return base + "/#s=" + url.QueryEscape(sessionID) + "&t=" + url.QueryEscape(threadID)
}

// notifyAgentMessage tells the destinations about a message the agent just stored; the sending
// happens in the background.
func (s *Server) notifyAgentMessage(ctx context.Context, sess *store.Session, threadID, messageID, subject, body string, needsAction bool) {
	n := notify.Notification{
		Session: sess.Name, Title: subject, ThreadID: threadID, MessageID: messageID,
		From: "Claude", Body: body, NeedsAction: needsAction,
	}
	if sess.ProjectID != "" {
		if p, err := s.store.GetProject(ctx, sess.ProjectID); err == nil {
			n.Project = p.Name
		}
	}
	if st, err := s.settings(ctx); err == nil {
		pub, _ := st["public_url"].(string)
		n.Link = threadLinkURL(pub, sess.ID, threadID)
	}
	s.notifier.Dispatch(n)
}

type destView struct {
	ID          string         `json:"id"`
	Type        string         `json:"type"`
	Name        string         `json:"name"`
	Enabled     bool           `json:"enabled"`
	Config      map[string]any `json:"config"`
	CreatedAt   time.Time      `json:"created_at"`
	LastOKAt    *time.Time     `json:"last_ok_at"`
	LastError   string         `json:"last_error"`
	LastErrorAt *time.Time     `json:"last_error_at"`
}

func viewDest(d *store.Destination) destView {
	cfg := d.Config
	if t, ok := notify.Lookup(d.Type); ok {
		cfg = t.Public(d.Config)
	} else {
		cfg = map[string]any{}
	}
	return destView{d.ID, d.Type, d.Name, d.Enabled, cfg, d.CreatedAt, d.LastOKAt, d.LastError, d.LastErrorAt}
}

func (s *Server) listNotifications(w http.ResponseWriter, r *http.Request) {
	dests, err := s.store.ListDestinations(r.Context())
	if err != nil {
		storeError(w, err)
		return
	}
	out := []destView{}
	for i := range dests {
		out = append(out, viewDest(&dests[i]))
	}
	writeJSON(w, 200, map[string]any{"types": notify.Types(), "destinations": out})
}

func (s *Server) createNotification(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Type    string         `json:"type"`
		Name    string         `json:"name"`
		Enabled *bool          `json:"enabled"`
		Config  map[string]any `json:"config"`
	}
	if !decode(w, r, &req) {
		return
	}
	t, ok := notify.Lookup(req.Type)
	if !ok {
		httpError(w, 400, "unknown destination type "+req.Type)
		return
	}
	cfg, err := t.Normalize(nil, req.Config)
	if err != nil {
		httpError(w, 400, err.Error())
		return
	}
	d := &store.Destination{Type: t.ID, Name: strings.TrimSpace(req.Name), Enabled: req.Enabled == nil || *req.Enabled, Config: cfg}
	if d.Name == "" {
		d.Name = t.Label
	}
	if err := s.store.CreateDestination(r.Context(), d); err != nil {
		storeError(w, err)
		return
	}
	s.hub.publish(Event{Type: "notifications"})
	writeJSON(w, 201, viewDest(d))
}

func (s *Server) patchNotification(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Name    *string        `json:"name"`
		Enabled *bool          `json:"enabled"`
		Config  map[string]any `json:"config"`
	}
	if !decode(w, r, &req) {
		return
	}
	d, err := s.store.GetDestination(r.Context(), r.PathValue("id"))
	if err != nil {
		storeError(w, err)
		return
	}
	if req.Name != nil {
		if n := strings.TrimSpace(*req.Name); n != "" {
			d.Name = n
		}
	}
	if req.Enabled != nil {
		d.Enabled = *req.Enabled
	}
	if req.Config != nil {
		t, ok := notify.Lookup(d.Type)
		if !ok {
			httpError(w, 400, "unknown destination type "+d.Type)
			return
		}
		cfg, err := t.Normalize(d.Config, req.Config)
		if err != nil {
			httpError(w, 400, err.Error())
			return
		}
		d.Config = cfg
	}
	if err := s.store.UpdateDestination(r.Context(), d); err != nil {
		storeError(w, err)
		return
	}
	s.hub.publish(Event{Type: "notifications"})
	writeJSON(w, 200, viewDest(d))
}

func (s *Server) deleteNotification(w http.ResponseWriter, r *http.Request) {
	if err := s.store.DeleteDestination(r.Context(), r.PathValue("id")); err != nil {
		storeError(w, err)
		return
	}
	s.hub.publish(Event{Type: "notifications"})
	writeJSON(w, 200, map[string]bool{"ok": true})
}

// testNotification sends a sample once and answers with the outcome (always 200 for a known
// destination: a failing webhook is a result, not a server error).
func (s *Server) testNotification(w http.ResponseWriter, r *http.Request) {
	d, err := s.store.GetDestination(r.Context(), r.PathValue("id"))
	if err != nil {
		storeError(w, err)
		return
	}
	st, _ := s.settings(r.Context())
	pub, _ := st["public_url"].(string)
	n := notify.Notification{
		Project: "Sample project", Session: "Sample session", Title: "Test notification", From: "Claude",
		Body: "This is a **test** from minbox. Messages look like this: [a link](https://example.com), `code`, and lists.\n\n- first\n- second",
	}
	if pub = strings.TrimSpace(pub); pub != "" {
		n.Link = pub
	}
	if err := s.notifier.Test(r.Context(), d, n); err != nil {
		writeJSON(w, 200, map[string]any{"ok": false, "error": err.Error()})
		return
	}
	writeJSON(w, 200, map[string]any{"ok": true})
}
