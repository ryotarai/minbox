package server

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/ryotarai/minbox/internal/hostfs"
	"github.com/ryotarai/minbox/internal/store"
	"github.com/ryotarai/minbox/internal/termhost"
)

// Version is minbox's version, set with -ldflags "-X github.com/ryotarai/minbox/internal/server.Version=...".
var Version = "dev"

// ---- sessions ----

func (s *Server) archiveSession(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	id := r.PathValue("id")
	sess, err := s.store.GetSession(ctx, id)
	if err != nil {
		storeError(w, err)
		return
	}
	if sess.Status != store.StatusEnded {
		httpError(w, 409, "only an ended session can be archived; stop it first")
		return
	}
	if err := s.store.ReleaseMain(ctx, id, r.URL.Query().Get("promote")); err != nil {
		storeError(w, err)
		return
	}
	if err := s.store.SetSessionArchived(ctx, id, true); err != nil {
		storeError(w, err)
		return
	}
	s.hub.publish(Event{Type: "sessions"})
	s.hub.publish(Event{Type: "projects"})
	writeJSON(w, 200, map[string]bool{"ok": true})
}

func (s *Server) unarchiveSession(w http.ResponseWriter, r *http.Request) {
	if err := s.store.SetSessionArchived(r.Context(), r.PathValue("id"), false); err != nil {
		storeError(w, err)
		return
	}
	s.hub.publish(Event{Type: "sessions"})
	writeJSON(w, 200, map[string]bool{"ok": true})
}

var unsafeName = regexp.MustCompile(`[^\p{L}\p{N}._-]+`)

// uploadFile saves any file (Compose's attachments) in the scratch area.
func (s *Server) uploadFile(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	sess, err := s.store.GetSession(r.Context(), id)
	if err != nil {
		storeError(w, err)
		return
	}
	fsys, err := s.sessions.fsOf(sess.HostID)
	if err != nil {
		httpError(w, 503, err.Error())
		return
	}
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 32<<20))
	if err != nil {
		httpError(w, 413, "file is larger than 32 MB")
		return
	}
	name := unsafeName.ReplaceAllString(filepath.Base(r.Header.Get("X-Filename")), "_")
	if name == "" || name == "." || name == "_" {
		name = "file"
	}
	path, err := fsys.WriteFile(r.Context(), hostfs.AreaScratch, id+"/files/"+time.Now().Format("20060102-150405")+"-"+name, bytes.NewReader(body), false)
	if err != nil {
		storeError(w, err)
		return
	}
	writeJSON(w, 201, map[string]string{"path": path})
}

// completions lists the agents, skills and commands Compose can mention
// (on the session's machine).
func (s *Server) completions(w http.ResponseWriter, r *http.Request) {
	sess, err := s.store.GetSession(r.Context(), r.PathValue("id"))
	if err != nil {
		storeError(w, err)
		return
	}
	fsys, err := s.sessions.fsOf(sess.HostID)
	if err != nil {
		httpError(w, 503, err.Error())
		return
	}
	out, err := fsys.Completions(r.Context(), sess.Cwd)
	if err != nil {
		httpError(w, 502, err.Error())
		return
	}
	writeJSON(w, 200, out)
}

// ---- threads ----

func (s *Server) threadOp(op func(ctx context.Context, id string) error) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		id := r.PathValue("id")
		th, err := s.store.GetThread(ctx, id)
		if err != nil {
			storeError(w, err)
			return
		}
		if err := op(ctx, id); err != nil {
			storeError(w, err)
			return
		}
		s.publishThread(th.SessionID, id)
		writeJSON(w, 200, map[string]bool{"ok": true})
	}
}

func (s *Server) patchThread(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Name    *string `json:"name"`
		Subject *string `json:"subject"`
	}
	if !decode(w, r, &req) {
		return
	}
	if req.Subject != nil {
		v := strings.TrimSpace(*req.Subject)
		if v == "" {
			httpError(w, 400, "subject is required")
			return
		}
		req.Subject = &v
	}
	if req.Name != nil {
		v := strings.TrimSpace(*req.Name)
		req.Name = &v
	}
	s.threadOp(func(ctx context.Context, id string) error {
		return s.store.UpdateThread(ctx, id, req.Subject, req.Name)
	})(w, r)
}

func (s *Server) snoozeThread(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Until time.Time `json:"until"`
	}
	if !decode(w, r, &req) {
		return
	}
	if req.Until.IsZero() || !req.Until.After(time.Now()) {
		httpError(w, 400, "until must be a time in the future")
		return
	}
	s.threadOp(func(ctx context.Context, id string) error {
		return s.store.SnoozeThread(ctx, id, &req.Until)
	})(w, r)
}

// reask adds a note asking Claude to ask the thread's open questions again.
func (s *Server) reask(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	id := r.PathValue("id")
	th, err := s.store.GetThread(ctx, id)
	if err != nil {
		storeError(w, err)
		return
	}
	n := th.OpenQuestions
	if n == 0 {
		httpError(w, 400, "this thread has no open questions")
		return
	}
	noun := "question"
	if n > 1 {
		noun = "questions"
	}
	words := fmt.Sprintf("Asked Claude Code to ask the %d open %s again.", n, noun)
	body := fmt.Sprintf("Please ask your %d open %s in this thread again (they may be out of date): send them again as :::question blocks with send_message and thread_id %s.", n, noun, id)
	msg, err := s.store.AddMessage(ctx, id, store.NewMessage{Author: store.AuthorUser, Body: body, Words: words, Kind: store.KindNote})
	if err != nil {
		storeError(w, err)
		return
	}
	s.publishThread(th.SessionID, id)
	s.wakePending(th.SessionID)
	writeJSON(w, 201, msg)
}

func (s *Server) sendNow(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	id := r.PathValue("id")
	threadID, err := s.store.ThreadOfMessage(ctx, id)
	if err != nil {
		storeError(w, err)
		return
	}
	if err := s.store.SetUrgent(ctx, id); err != nil {
		if errors.Is(err, store.ErrNotFound) {
			httpError(w, 409, "that message is delivered already, or is not yours")
			return
		}
		storeError(w, err)
		return
	}
	th, err := s.store.GetThread(ctx, threadID)
	if err == nil {
		s.publishThread(th.SessionID, threadID)
		s.wakePending(th.SessionID)
	}
	writeJSON(w, 200, map[string]bool{"ok": true})
}

// cancelMessage deletes the person's queued message, so it is never delivered.
// 409 when it is delivered already (or being delivered), or is not the person's.
func (s *Server) cancelMessage(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	id := r.PathValue("id")
	threadID, err := s.store.ThreadOfMessage(ctx, id)
	if err != nil {
		storeError(w, err)
		return
	}
	th, thErr := s.store.GetThread(ctx, threadID)
	deleted, err := s.store.CancelMessage(ctx, id)
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			httpError(w, 409, "that message is delivered already, or is not yours")
			return
		}
		storeError(w, err)
		return
	}
	if thErr == nil {
		s.publishThread(th.SessionID, threadID)
	}
	writeJSON(w, 200, map[string]any{"ok": true, "thread_id": threadID, "thread_deleted": deleted})
}

func oneLine(s string, max int) string {
	s = strings.Join(strings.Fields(s), " ")
	if r := []rune(s); len(r) > max {
		return string(r[:max-1]) + "…"
	}
	return s
}

// ---- attachments ----

type attachmentSnapshot struct {
	att     store.Attachment
	content []byte
	review  string
}

type reviewReq struct {
	Title   string `json:"title"`
	Summary string `json:"summary"`
	// Cwd is where relative file paths resolve (e.g. a git worktree); the
	// session's directory when empty, and resolved against it.
	Cwd string `json:"cwd"`
	// Base, a branch or commit: diff from where HEAD left it, so committed
	// changes show too (e.g. "main" for a worktree's branch). HEAD when empty.
	Base     string `json:"base"`
	Sections []struct {
		Title   string   `json:"title"`
		Summary string   `json:"summary"`
		Files   []string `json:"files"`
	} `json:"sections"`
}

type reviewFile struct {
	Path      string `json:"path"`
	Additions int    `json:"additions"`
	Deletions int    `json:"deletions"`
	Diff      string `json:"diff"`
}

type reviewSection struct {
	Title   string       `json:"title"`
	Summary string       `json:"summary"`
	Files   []reviewFile `json:"files"`
}

type review struct {
	Title     string          `json:"title"`
	Summary   string          `json:"summary"`
	Base      string          `json:"base,omitempty"`
	Additions int             `json:"additions"`
	Deletions int             `json:"deletions"`
	Sections  []reviewSection `json:"sections"`
}

func resolveIn(cwd, p string) string {
	if strings.HasPrefix(p, "~/") {
		if home, err := os.UserHomeDir(); err == nil {
			p = filepath.Join(home, p[2:])
		}
	}
	if !filepath.IsAbs(p) {
		p = filepath.Join(cwd, p)
	}
	return filepath.Clean(p)
}

func countDiff(diff string) (add, del int) {
	for _, l := range strings.Split(diff, "\n") {
		switch {
		case strings.HasPrefix(l, "+++"), strings.HasPrefix(l, "---"):
		case strings.HasPrefix(l, "+"):
			add++
		case strings.HasPrefix(l, "-"):
			del++
		}
	}
	return
}

func snapshotReview(ctx context.Context, fsys hostfs.FS, home, cwd string, req *reviewReq) (*attachmentSnapshot, error) {
	if strings.TrimSpace(req.Title) == "" || len(req.Sections) == 0 {
		return nil, errors.New("review needs a title and at least one section")
	}
	if len(req.Sections) > 20 {
		return nil, errors.New("review has too many sections (20 at most)")
	}
	if req.Cwd != "" {
		cwd = hostfs.ResolveIn(home, cwd, req.Cwd)
	}
	base := strings.TrimSpace(req.Base)
	rv := review{Title: strings.TrimSpace(req.Title), Summary: req.Summary, Base: base, Sections: []reviewSection{}}
	nFiles := 0
	for _, sec := range req.Sections {
		rs := reviewSection{Title: sec.Title, Summary: sec.Summary, Files: []reviewFile{}}
		for _, f := range sec.Files {
			if nFiles++; nFiles > 50 {
				return nil, errors.New("review has too many files (50 at most)")
			}
			diff, err := fsys.GitDiff(ctx, cwd, hostfs.ResolveIn(home, cwd, f), base)
			if err != nil {
				return nil, fmt.Errorf("review file %s: %v", f, err)
			}
			if len(diff) > 1<<20 {
				diff = diff[:1<<20] + "\n… (diff cut at 1 MB)\n"
			}
			a, d := countDiff(diff)
			rv.Additions += a
			rv.Deletions += d
			rel := f
			if r, err := filepath.Rel(cwd, hostfs.ResolveIn(home, cwd, f)); err == nil && !strings.HasPrefix(r, "..") {
				rel = r
			}
			rs.Files = append(rs.Files, reviewFile{Path: rel, Additions: a, Deletions: d, Diff: diff})
		}
		rv.Sections = append(rv.Sections, rs)
	}
	b, _ := json.Marshal(rv)
	return &attachmentSnapshot{att: store.Attachment{Kind: store.AttachmentReview, Name: rv.Title, Path: cwd, Mime: "application/json", Size: int64(len(b))}, review: string(b)}, nil
}

// ---- search ----

func (s *Server) search(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	limit, _ := strconv.Atoi(q.Get("limit"))
	res, err := s.store.Search(r.Context(), store.SearchQuery{Q: q.Get("q"), SessionID: q.Get("session_id"), Status: q.Get("status"), From: q.Get("from"), Limit: limit})
	if err != nil {
		storeError(w, err)
		return
	}
	writeJSON(w, 200, res)
}

// ---- settings ----

func defaultSettings() map[string]any {
	return map[string]any{
		"theme": "system", "text_size": 13, "notifications": true, "sound": true, "tab_count": true, "single_key": true,
		"board": false, "decision_mode": false, "swap_panes": true, "prompt_extra": "", "orchestrator_prompt": true,
		"list": map[string]any{"highlight_subject": true, "compact": false, "hide_icons": false, "small_names": false, "keep_panel": false},
	}
}

func (s *Server) settings(ctx context.Context) (map[string]any, error) {
	out := defaultSettings()
	stored, err := s.store.Settings(ctx)
	if err != nil {
		return nil, err
	}
	for k, raw := range stored {
		var v any
		if json.Unmarshal(raw, &v) == nil {
			out[k] = v
		}
	}
	return out, nil
}

func (s *Server) boardOn(ctx context.Context) bool {
	st, err := s.settings(ctx)
	if err != nil {
		return false
	}
	on, _ := st["board"].(bool)
	return on
}

func (s *Server) getSettings(w http.ResponseWriter, r *http.Request) {
	st, err := s.settings(r.Context())
	if err != nil {
		storeError(w, err)
		return
	}
	writeJSON(w, 200, st)
}

func (s *Server) putSettings(w http.ResponseWriter, r *http.Request) {
	var req map[string]json.RawMessage
	if !decode(w, r, &req) {
		return
	}
	defaults := defaultSettings()
	for k, v := range req {
		if _, ok := defaults[k]; !ok {
			httpError(w, 400, "unknown setting "+k)
			return
		}
		if len(v) > 64<<10 {
			httpError(w, 400, "setting "+k+" is too large")
			return
		}
	}
	if err := s.store.PutSettings(r.Context(), req); err != nil {
		storeError(w, err)
		return
	}
	s.hub.publish(Event{Type: "settings"})
	s.getSettings(w, r)
}

// ---- cards ----

func (s *Server) listCards(w http.ResponseWriter, r *http.Request) {
	cards, err := s.store.ListCards(r.Context(), r.URL.Query().Get("session_id"))
	if err != nil {
		storeError(w, err)
		return
	}
	writeJSON(w, 200, cards)
}

func validPRState(v string) bool {
	switch v {
	case "", "draft", "open", "merged", "closed":
		return true
	}
	return false
}

func (s *Server) createCardAs(ctx context.Context, w http.ResponseWriter, p store.CardPatch, by string, defaultSession *string) {
	c := &store.Card{Column: "backlog", CreatedBy: by, SessionID: defaultSession}
	if p.Title == nil || strings.TrimSpace(*p.Title) == "" {
		httpError(w, 400, "title is required")
		return
	}
	c.Title = strings.TrimSpace(*p.Title)
	if p.Column != nil {
		c.Column = *p.Column
	}
	if !store.ValidColumn(c.Column) {
		httpError(w, 400, "column must be one of "+strings.Join(store.CardColumns, ", "))
		return
	}
	if p.Note != nil {
		c.Note = *p.Note
	}
	if p.SessionID != nil {
		c.SessionID = p.SessionID
	}
	if p.ThreadID != nil {
		c.ThreadID = p.ThreadID
	}
	if p.PRURL != nil {
		c.PRURL = *p.PRURL
	}
	if p.PRState != nil {
		if !validPRState(*p.PRState) {
			httpError(w, 400, "pr_state must be draft, open, merged or closed")
			return
		}
		c.PRState = *p.PRState
	}
	if p.PRNumber != nil {
		c.PRNumber = *p.PRNumber
	}
	if p.Position != nil {
		c.Position = *p.Position
	}
	if c.Column == "dropped" {
		c.DroppedBy = by
	}
	if err := s.store.CreateCard(ctx, c); err != nil {
		storeError(w, err)
		return
	}
	s.hub.publish(Event{Type: "cards"})
	writeJSON(w, 201, c)
}

func (s *Server) updateCardAs(ctx context.Context, w http.ResponseWriter, id string, p store.CardPatch, by string) {
	if p.Column != nil && !store.ValidColumn(*p.Column) {
		httpError(w, 400, "column must be one of "+strings.Join(store.CardColumns, ", "))
		return
	}
	if p.PRState != nil && !validPRState(*p.PRState) {
		httpError(w, 400, "pr_state must be draft, open, merged or closed")
		return
	}
	if p.Title != nil && strings.TrimSpace(*p.Title) == "" {
		httpError(w, 400, "title is required")
		return
	}
	c, err := s.store.UpdateCard(ctx, id, p, by)
	if err != nil {
		storeError(w, err)
		return
	}
	s.hub.publish(Event{Type: "cards"})
	writeJSON(w, 200, c)
}

func (s *Server) createCard(w http.ResponseWriter, r *http.Request) {
	var p store.CardPatch
	if !decode(w, r, &p) {
		return
	}
	s.createCardAs(r.Context(), w, p, "user", nil)
}

func (s *Server) patchCard(w http.ResponseWriter, r *http.Request) {
	var p store.CardPatch
	if !decode(w, r, &p) {
		return
	}
	s.updateCardAs(r.Context(), w, r.PathValue("id"), p, "user")
}

func (s *Server) deleteCard(w http.ResponseWriter, r *http.Request) {
	if err := s.store.DeleteCard(r.Context(), r.PathValue("id")); err != nil {
		storeError(w, err)
		return
	}
	s.hub.publish(Event{Type: "cards"})
	writeJSON(w, 200, map[string]bool{"ok": true})
}

const boardOff = "the Board is off in minbox settings"

func (s *Server) agentListCards(w http.ResponseWriter, r *http.Request, sess *store.Session) {
	if !s.boardOn(r.Context()) {
		httpError(w, 403, boardOff)
		return
	}
	s.listCards(w, r)
}

func (s *Server) agentCreateCard(w http.ResponseWriter, r *http.Request, sess *store.Session) {
	if !s.boardOn(r.Context()) {
		httpError(w, 403, boardOff)
		return
	}
	var p store.CardPatch
	if !decode(w, r, &p) {
		return
	}
	id := sess.ID
	s.createCardAs(r.Context(), w, p, "agent", &id)
}

func (s *Server) agentPatchCard(w http.ResponseWriter, r *http.Request, sess *store.Session) {
	if !s.boardOn(r.Context()) {
		httpError(w, 403, boardOff)
		return
	}
	var p store.CardPatch
	if !decode(w, r, &p) {
		return
	}
	s.updateCardAs(r.Context(), w, r.PathValue("id"), p, "agent")
}

// ---- storage & about ----

func dirSize(dir string) (bytes int64, files int) {
	_ = filepath.WalkDir(dir, func(_ string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return nil
		}
		if fi, err := d.Info(); err == nil {
			bytes += fi.Size()
			files++
		}
		return nil
	})
	return
}

func (s *Server) dbPath() string { return filepath.Join(s.cfg.DataDir, "minbox.db") }

func (s *Server) storage(w http.ResponseWriter, r *http.Request) {
	var dbBytes int64
	for _, suffix := range []string{"", "-wal", "-shm"} {
		if fi, err := os.Stat(s.dbPath() + suffix); err == nil {
			dbBytes += fi.Size()
		}
	}
	sb, sf := dirSize(s.cfg.ScratchDir)
	writeJSON(w, 200, map[string]any{"data_dir": s.cfg.DataDir, "db_path": s.dbPath(), "db_bytes": dbBytes,
		"scratch_dir": s.cfg.ScratchDir, "scratch_bytes": sb, "scratch_files": sf})
}

func (s *Server) clearScratch(w http.ResponseWriter, r *http.Request) {
	_, n := dirSize(s.cfg.ScratchDir)
	if s.cfg.ScratchDir == "" {
		httpError(w, 500, "no scratch directory")
		return
	}
	if err := os.RemoveAll(s.cfg.ScratchDir); err != nil {
		storeError(w, err)
		return
	}
	writeJSON(w, 200, map[string]int{"removed": n})
}

func (s *Server) about(w http.ResponseWriter, r *http.Request) {
	out := map[string]any{"version": Version, "server_protocol": ProtocolVersion, "required_host": RequiredHostVersion, "host": nil, "data_dir": s.cfg.DataDir, "claude_command": strings.Join(s.cfg.ClaudeCommand, " ")}
	if h, ok := s.sessions.getHost().(interface {
		Version(ctx context.Context) (termhost.VersionInfo, error)
	}); ok && h != nil {
		ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
		defer cancel()
		if v, err := h.Version(ctx); err == nil {
			out["host"] = map[string]int{"protocol": v.Protocol, "required_server": v.RequiredServerVersion, "pid": v.PID}
		}
	}
	writeJSON(w, 200, out)
}
