package server

import (
	"context"
	"errors"
	"github.com/ryotarai/minbox/internal/question"
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
		From: "Claude", Body: question.Readable(body), NeedsAction: needsAction,
	}
	if sess.ProjectID != "" {
		if p, err := s.store.GetProject(ctx, sess.ProjectID); err == nil {
			n.Project = p.Name
		}
	}
	if th, err := s.store.GetThread(ctx, threadID); err == nil {
		n.Status = th.Status
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
	// ReceiveStatus is set for a Slack app destination whose "Receive messages from Slack" is on.
	ReceiveStatus *notify.RecvStatus `json:"receive_status,omitempty"`
}

func viewDest(d *store.Destination) destView {
	cfg := d.Config
	if t, ok := notify.Lookup(d.Type); ok {
		cfg = t.Public(d.Config)
	} else {
		cfg = map[string]any{}
	}
	return destView{ID: d.ID, Type: d.Type, Name: d.Name, Enabled: d.Enabled, Config: cfg, CreatedAt: d.CreatedAt, LastOKAt: d.LastOKAt, LastError: d.LastError, LastErrorAt: d.LastErrorAt}
}

func (s *Server) viewDestStatus(ctx context.Context, d *store.Destination) destView {
	v := viewDest(d)
	v.ReceiveStatus = s.poller.Status(ctx, d)
	return v
}

func (s *Server) listNotifications(w http.ResponseWriter, r *http.Request) {
	dests, err := s.store.ListDestinations(r.Context())
	if err != nil {
		storeError(w, err)
		return
	}
	out := []destView{}
	for i := range dests {
		out = append(out, s.viewDestStatus(r.Context(), &dests[i]))
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
		// A new channel or token starts new Slack threads.
		if cfg["channel"] != d.Config["channel"] || cfg["bot_token"] != d.Config["bot_token"] {
			_ = s.store.DeleteSlackThreads(r.Context(), d.ID)
		}
		// Receiving starts from "now" again when it is switched on, or the token or channel changed.
		if cfg["receive"] != d.Config["receive"] || cfg["channel"] != d.Config["channel"] || cfg["bot_token"] != d.Config["bot_token"] {
			_ = s.store.ResetSlackInbound(r.Context(), d.ID)
		}
		d.Config = cfg
	}
	if err := s.store.UpdateDestination(r.Context(), d); err != nil {
		storeError(w, err)
		return
	}
	s.hub.publish(Event{Type: "notifications"})
	writeJSON(w, 200, s.viewDestStatus(r.Context(), d))
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
	info, err := s.notifier.TestInfo(r.Context(), d, n)
	if err != nil {
		writeJSON(w, 200, map[string]any{"ok": false, "error": err.Error()})
		return
	}
	res := map[string]any{"ok": true}
	if info != "" {
		res["message"] = info
	}
	writeJSON(w, 200, res)
}

// checkNotification runs one receive cycle of a Slack app destination now ("Check receiving
// now"): the normal cycle early, within the same budget and pause. 200 with the summary and the
// new status; 409 when the destination is not receiving.
func (s *Server) checkNotification(w http.ResponseWriter, r *http.Request) {
	d, err := s.store.GetDestination(r.Context(), r.PathValue("id"))
	if err != nil {
		storeError(w, err)
		return
	}
	if !notify.ReceivesFrom(d) {
		httpError(w, 400, "Receiving from Slack is not switched on for this destination")
		return
	}
	res, err := s.poller.CheckNow(r.Context(), d)
	if errors.Is(err, notify.ErrNotReceiving) {
		httpError(w, 409, "Not receiving now: the destination is switched off, or the receiver has not started yet (try again in a few seconds)")
		return
	}
	if err != nil {
		httpError(w, 500, err.Error())
		return
	}
	writeJSON(w, 200, res)
}
