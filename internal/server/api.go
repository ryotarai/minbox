package server

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/coder/websocket"
	"github.com/ryotarai/minbox/internal/hostfs"
	"github.com/ryotarai/minbox/internal/question"
	"github.com/ryotarai/minbox/internal/store"
)

// ---- sessions ----

func (s *Server) listSessions(w http.ResponseWriter, r *http.Request) {
	sessions, err := s.store.ListSessions(r.Context())
	if err != nil {
		storeError(w, err)
		return
	}
	names := s.hostNames(r.Context())
	for i := range sessions {
		sessions[i].HostName = names[sessions[i].HostID]
	}
	writeJSON(w, 200, sessions)
}

func (s *Server) createSession(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Name   string `json:"name"`
		Cwd    string `json:"cwd"`
		HostID string `json:"host_id"`
		Kind   string `json:"kind"` // "claude" (default) or "shell"
		// ProjectID: start in this project (its host; its folder unless cwd is given). Without it
		// the project is the one for (host_id, cwd), created on first use.
		ProjectID string `json:"project_id"`
		// Main: make it the project's main session (the first Claude Code session of a project is main anyway).
		Main bool `json:"main"`
	}
	if !decode(w, r, &req) {
		return
	}
	sess, err := s.sessions.CreateKind(r.Context(), strings.TrimSpace(req.Kind), strings.TrimSpace(req.Name), strings.TrimSpace(req.Cwd), strings.TrimSpace(req.HostID), strings.TrimSpace(req.ProjectID))
	if err != nil {
		httpError(w, 400, err.Error())
		return
	}
	if req.Main && sess.Kind == store.KindClaude && !sess.IsMain {
		if _, err := s.store.UpdateProject(r.Context(), sess.ProjectID, store.ProjectPatch{MainSession: &sess.ID}); err != nil {
			storeError(w, err)
			return
		}
		sess.IsMain = true
		s.hub.publish(Event{Type: "sessions"})
	}
	sess.HostName = s.hostNames(r.Context())[sess.HostID]
	writeJSON(w, 201, sess)
}

func (s *Server) updateSession(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Name string `json:"name"`
	}
	if !decode(w, r, &req) {
		return
	}
	name := strings.TrimSpace(req.Name)
	if name == "" {
		httpError(w, 400, "name is required")
		return
	}
	if err := s.store.RenameSession(r.Context(), r.PathValue("id"), name); err != nil {
		storeError(w, err)
		return
	}
	s.hub.publish(Event{Type: "sessions"})
	writeJSON(w, 200, map[string]bool{"ok": true})
}

func (s *Server) deleteSession(w http.ResponseWriter, r *http.Request) {
	if err := s.sessions.Delete(r.Context(), r.PathValue("id"), r.URL.Query().Get("promote")); err != nil {
		storeError(w, err)
		return
	}
	writeJSON(w, 200, map[string]bool{"ok": true})
}

func (s *Server) restartSession(w http.ResponseWriter, r *http.Request) {
	if err := s.sessions.Restart(r.Context(), r.PathValue("id")); err != nil {
		if errors.Is(err, errRestartInProgress) {
			httpError(w, 409, err.Error())
			return
		}
		httpError(w, 400, err.Error())
		return
	}
	writeJSON(w, 200, map[string]bool{"ok": true})
}

func (s *Server) stopSession(w http.ResponseWriter, r *http.Request) {
	if err := s.sessions.Stop(r.Context(), r.PathValue("id")); err != nil {
		httpError(w, 400, err.Error())
		return
	}
	writeJSON(w, 200, map[string]bool{"ok": true})
}

const terminalPingEvery = 15 * time.Second

// terminalWS bridges the browser's WebSocket to the terminal host's attach socket.
func (s *Server) terminalWS(w http.ResponseWriter, r *http.Request) {
	sess, err := s.store.GetSession(r.Context(), r.PathValue("id"))
	if err != nil {
		storeError(w, err)
		return
	}
	s.bridgeTerminal(w, r, sess, sess.ID)
}

// shellWS bridges to the session's companion shell, starting it on first attach.
func (s *Server) shellWS(w http.ResponseWriter, r *http.Request) {
	sess, err := s.store.GetSession(r.Context(), r.PathValue("id"))
	if err != nil {
		storeError(w, err)
		return
	}
	if err := s.sessions.ensureShell(r.Context(), sess); err != nil {
		var ce *clientError
		if errors.As(err, &ce) {
			httpError(w, ce.status, ce.msg)
		} else {
			httpError(w, 503, err.Error())
		}
		return
	}
	s.bridgeTerminal(w, r, sess, shellTermID(sess.ID))
}

// bridgeTerminal attaches to the host terminal id of a session and pipes it to the browser.
func (s *Server) bridgeTerminal(w http.ResponseWriter, r *http.Request, sess *store.Session, id string) {
	hc, err := s.sessions.hostOf(sess)
	if err != nil {
		httpError(w, 503, err.Error())
		return
	}
	host, ok := hc.(interface {
		Attach(ctx context.Context, id string) (*websocket.Conn, error)
	})
	if !ok || host == nil {
		httpError(w, 503, "terminal host is not connected")
		return
	}
	upstream, err := host.Attach(r.Context(), id)
	if err != nil {
		httpError(w, 502, err.Error())
		return
	}
	defer upstream.CloseNow()
	conn, err := websocket.Accept(w, r, nil) // the guard already checked Origin
	if err != nil {
		return
	}
	defer conn.CloseNow()
	conn.SetReadLimit(1 << 20)
	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()
	pipe := func(dst, src *websocket.Conn) {
		defer cancel()
		for {
			typ, data, err := src.Read(ctx)
			if err != nil {
				return
			}
			if err := dst.Write(ctx, typ, data); err != nil {
				return
			}
		}
	}
	go pipe(upstream, conn)
	// A radio that drops leaves the socket half-open, with no close for minutes. The page
	// treats silence as death, so something must flow even when the terminal is idle.
	go func() {
		t := time.NewTicker(terminalPingEvery)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
				wctx, wcancel := context.WithTimeout(ctx, 10*time.Second)
				err := conn.Write(wctx, websocket.MessageBinary, nil) // empty: a page still on an older build draws nothing for it
				wcancel()
				if err != nil {
					cancel()
					return
				}
			}
		}
	}()
	pipe(conn, upstream)
	conn.Close(websocket.StatusNormalClosure, "")
}

var imageExts = map[string]string{
	"image/png":  ".png",
	"image/jpeg": ".jpg",
	"image/gif":  ".gif",
	"image/webp": ".webp",
}

// upload saves a pasted image in the scratch area and answers its path, which
// the browser then types into the terminal.
func (s *Server) upload(w http.ResponseWriter, r *http.Request) {
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
	ct := strings.TrimSpace(strings.Split(r.Header.Get("Content-Type"), ";")[0])
	ext, ok := imageExts[ct]
	if !ok {
		httpError(w, 415, "only png, jpeg, gif and webp images can be pasted")
		return
	}
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 32<<20))
	if err != nil {
		httpError(w, 413, err.Error())
		return
	}
	b := make([]byte, 3)
	_, _ = rand.Read(b)
	name := fmt.Sprintf("paste-%s-%s%s", time.Now().Format("20060102-150405"), hex.EncodeToString(b), ext)
	// On the session's machine: the agent opens it there.
	path, err := fsys.WriteFile(r.Context(), hostfs.AreaScratch, id+"/"+name, bytes.NewReader(body), false)
	if err != nil {
		storeError(w, err)
		return
	}
	writeJSON(w, 201, map[string]string{"path": path})
}

// ---- inbox (browser) ----

// listAllThreads: the threads of every live session, for the all-sessions inbox.
func (s *Server) listAllThreads(w http.ResponseWriter, r *http.Request) {
	threads, err := s.store.ListAllThreads(r.Context())
	if err != nil {
		storeError(w, err)
		return
	}
	for i := range threads {
		threads[i].Messages = nil
	}
	store.SortThreads(threads)
	writeJSON(w, 200, threads)
}

func (s *Server) listThreads(w http.ResponseWriter, r *http.Request) {
	threads, err := s.store.ListThreads(r.Context(), r.PathValue("id"))
	if err != nil {
		storeError(w, err)
		return
	}
	for i := range threads {
		threads[i].Messages = nil
	}
	store.SortThreads(threads)
	writeJSON(w, 200, threads)
}

func (s *Server) createUserThread(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Subject string   `json:"subject"`
		Body    string   `json:"body"`
		Name    string   `json:"name"`
		Uploads []string `json:"uploads"`
	}
	if !decode(w, r, &req) {
		return
	}
	ups, err := s.takeUploads(r, req.Uploads)
	if err != nil {
		writeErr(w, err)
		return
	}
	body := strings.TrimSpace(req.Body)
	if body == "" && len(ups) == 0 {
		httpError(w, 400, "body is required")
		return
	}
	subject := strings.TrimSpace(req.Subject)
	if subject == "" {
		subject = firstLine(body, 60)
	}
	if subject == "" && len(ups) > 0 {
		subject = ups[0].Name
	}
	sessionID := r.PathValue("id")
	th, msg, err := s.store.CreateThread(r.Context(), sessionID, subject, store.NewMessage{Author: store.AuthorUser, Body: body, Words: body})
	if err != nil {
		storeError(w, err)
		return
	}
	if err := s.attachUploads(r, ups, th.ID, msg.ID); err != nil {
		storeError(w, err)
		return
	}
	if name := strings.TrimSpace(req.Name); name != "" {
		_ = s.store.UpdateThread(r.Context(), th.ID, nil, &name)
		th.Name = name
	}
	s.publishThread(sessionID, th.ID)
	s.wakePending(sessionID)
	writeJSON(w, 201, th)
}

// cleanTitle makes a thread title: one line, whitespace collapsed, 120 characters at most.
func cleanTitle(s string) string {
	s = strings.Join(strings.Fields(s), " ")
	if r := []rune(s); len(r) > 120 {
		return string(r[:119]) + "…"
	}
	return s
}

func firstLine(s string, max int) string {
	s, _, _ = strings.Cut(strings.TrimSpace(s), "\n")
	s = strings.TrimSpace(strings.TrimLeft(s, "#>*- "))
	if r := []rune(s); len(r) > max {
		return string(r[:max-1]) + "…"
	}
	return s
}

func (s *Server) getThread(w http.ResponseWriter, r *http.Request) {
	th, err := s.store.GetThread(r.Context(), r.PathValue("id"))
	if err != nil {
		storeError(w, err)
		return
	}
	writeJSON(w, 200, th)
}

func (s *Server) markRead(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	th, err := s.store.GetThread(r.Context(), id)
	if err != nil {
		storeError(w, err)
		return
	}
	n, err := s.store.MarkThreadRead(r.Context(), id)
	if err != nil {
		storeError(w, err)
		return
	}
	if n > 0 {
		s.publishThread(th.SessionID, id)
	}
	writeJSON(w, 200, map[string]int64{"marked": n})
}

func (s *Server) markUnread(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	th, err := s.store.GetThread(r.Context(), id)
	if err != nil {
		storeError(w, err)
		return
	}
	if err := s.store.MarkThreadUnread(r.Context(), id); err != nil {
		storeError(w, err)
		return
	}
	s.publishThread(th.SessionID, id)
	writeJSON(w, 200, map[string]bool{"ok": true})
}

// reply sends the person's reply: their words, and their answers to the
// questions of one agent message (answers_for), composed into what Claude reads.
func (s *Server) reply(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Words       string             `json:"words"`
		AnswersFor  string             `json:"answers_for"`
		Answers     []question.Answer  `json:"answers"`
		Annotations []store.Annotation `json:"annotations"`
		Urgent      bool               `json:"urgent"`
		ForwardTo   string             `json:"forward_to"`
		Resume      bool               `json:"resume"`
		Uploads     []string           `json:"uploads"`
	}
	if !decode(w, r, &req) {
		return
	}
	ctx := r.Context()
	id := r.PathValue("id")
	th, err := s.store.GetThread(ctx, id)
	if err != nil {
		storeError(w, err)
		return
	}
	words := strings.TrimSpace(req.Words)
	var questions []question.Question
	var answers []question.Answer
	if req.AnswersFor != "" {
		var target *store.Message
		for i := range th.Messages {
			if th.Messages[i].ID == req.AnswersFor && th.Messages[i].Author == store.AuthorAgent {
				target = &th.Messages[i]
			}
		}
		if target == nil {
			httpError(w, 400, "answers_for is not an agent message of this thread")
			return
		}
		questions = target.Questions
		answers, err = validateAnswers(questions, req.Answers)
		if err != nil {
			httpError(w, 422, err.Error())
			return
		}
	}
	annotations, err := validateAnnotations(req.Annotations)
	if err != nil {
		httpError(w, 422, err.Error())
		return
	}
	ups, err := s.takeUploads(r, req.Uploads)
	if err != nil {
		writeErr(w, err)
		return
	}
	if words == "" && len(answers) == 0 && len(annotations) == 0 && len(ups) == 0 {
		httpError(w, 400, "write something or answer a question")
		return
	}
	byKey := map[string]question.Answer{}
	for _, a := range answers {
		byKey[a.Key] = a
	}
	body := question.Compose(words, questions, byKey)
	if sec := s.feedbackFor(r, th, annotations); sec != "" {
		if body != "" {
			body += "\n\n"
		}
		body += sec
	}
	// Replying means the person has seen the thread.
	_, _ = s.store.MarkThreadRead(ctx, id)

	if req.ForwardTo != "" {
		// Where should this reply go: a new thread in another session.
		target, err := s.store.GetSession(ctx, req.ForwardTo)
		if err != nil {
			httpError(w, 404, "no session "+req.ForwardTo)
			return
		}
		nt, msg, err := s.store.CreateThread(ctx, target.ID, th.Subject, store.NewMessage{Author: store.AuthorUser, Body: body, Words: words, Urgent: req.Urgent, Annotations: annotations})
		if err != nil {
			storeError(w, err)
			return
		}
		if err := s.attachUploads(r, ups, nt.ID, msg.ID); err != nil {
			storeError(w, err)
			return
		}
		s.publishThread(th.SessionID, id)
		s.publishThread(target.ID, nt.ID)
		s.wakePending(target.ID)
		writeJSON(w, 201, map[string]any{"thread_id": nt.ID, "session_id": target.ID, "message": msg})
		return
	}

	m := store.NewMessage{Author: store.AuthorUser, Body: body, Words: words, Answers: answers, Urgent: req.Urgent, Annotations: annotations}
	if len(answers) > 0 {
		m.AnswersFor = req.AnswersFor
	}
	msg, err := s.store.AddMessage(ctx, id, m)
	if err != nil {
		storeError(w, err)
		return
	}
	if err := s.attachUploads(r, ups, id, msg.ID); err != nil {
		storeError(w, err)
		return
	}
	if atts, err := s.store.AttachmentsOfMessage(ctx, msg.ID); err == nil {
		msg.Attachments = atts
	}
	s.publishThread(th.SessionID, id)
	s.wakePending(th.SessionID)
	if req.Resume {
		if sess, err := s.store.GetSession(ctx, th.SessionID); err == nil && sess.Status == store.StatusEnded {
			if err := s.sessions.Restart(ctx, sess.ID); err != nil {
				httpError(w, 500, "the reply is saved, but the session did not resume: "+err.Error())
				return
			}
		}
	}
	writeJSON(w, 201, msg)
}

const (
	maxOther = 2000
	maxText  = 4000
	maxNote  = 2000
)

// validateAnswers keeps the answers that name a question of the message, with
// labels that are its choices, and drops empty ones.
func validateAnswers(questions []question.Question, in []question.Answer) ([]question.Answer, error) {
	byKey := map[string]question.Question{}
	for _, q := range questions {
		byKey[q.Key] = q
	}
	var out []question.Answer
	seen := map[string]bool{}
	for _, a := range in {
		q, ok := byKey[a.Key]
		if !ok {
			return nil, fmt.Errorf("no question %q in that message", a.Key)
		}
		if seen[a.Key] {
			return nil, fmt.Errorf("question %q answered twice", a.Key)
		}
		seen[a.Key] = true
		labels := map[string]bool{}
		for _, c := range q.Choices {
			labels[c.Label] = true
		}
		for _, l := range a.Selected {
			if !labels[l] {
				return nil, fmt.Errorf("%q is not a choice of %q", l, q.Prompt)
			}
		}
		if q.Kind == question.Single && len(a.Selected) > 1 {
			return nil, fmt.Errorf("%q takes one choice", q.Prompt)
		}
		if q.Kind == question.Single && len(a.Selected) == 1 && strings.TrimSpace(a.Other) != "" {
			a.Other = "" // one answer: the picked choice wins
		}
		if len([]rune(a.Other)) > maxOther || len([]rune(a.Text)) > maxText || len([]rune(a.Note)) > maxNote {
			return nil, fmt.Errorf("answer to %q is too long", q.Prompt)
		}
		if a.Skipped {
			a = question.Answer{Key: a.Key, Skipped: true, Note: a.Note}
		}
		if !a.Empty() {
			out = append(out, a)
		}
	}
	return out, nil
}

func (s *Server) publishThread(sessionID, threadID string) {
	s.hub.publish(Event{Type: "thread", SessionID: sessionID, ThreadID: threadID})
	s.hub.publish(Event{Type: "threads", SessionID: sessionID})
	s.hub.publish(Event{Type: "sessions"})
}

// ---- the mod's API ----

type agentHandler func(w http.ResponseWriter, r *http.Request, sess *store.Session)

// agent authenticates the mod by its session's bearer token.
func (s *Server) agent(h agentHandler) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		token := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
		sess, err := s.store.SessionByToken(r.Context(), token)
		if err != nil {
			httpError(w, 401, "unknown session token")
			return
		}
		h(w, r, sess)
	}
}

func (s *Server) agentHello(w http.ResponseWriter, r *http.Request, sess *store.Session) {
	var req struct {
		ClaudeSessionID string `json:"claude_session_id"`
	}
	if !decode(w, r, &req) {
		return
	}
	ctx := r.Context()
	// /clear gives the conversation a new id: resume that one later.
	if req.ClaudeSessionID != "" && req.ClaudeSessionID != sess.ClaudeSessionID {
		_ = s.store.SetClaudeSessionID(ctx, sess.ID, req.ClaudeSessionID)
	}
	if sess.Status == store.StatusStarting {
		_ = s.store.SetSessionStatus(ctx, sess.ID, store.StatusIdle)
	}
	s.hub.publish(Event{Type: "sessions"})
	extra := ""
	if st, err := s.settings(ctx); err == nil {
		extra, _ = st["prompt_extra"].(string)
	}
	writeJSON(w, 200, map[string]string{"session_id": sess.ID, "name": sess.Name, "prompt_extra": extra})
}

func (s *Server) agentStatus(w http.ResponseWriter, r *http.Request, sess *store.Session) {
	var req struct {
		Status string `json:"status"`
	}
	if !decode(w, r, &req) {
		return
	}
	if req.Status != store.StatusWorking && req.Status != store.StatusIdle {
		httpError(w, 400, "status must be working or idle")
		return
	}
	if sess.Status != store.StatusEnded && sess.Status != req.Status {
		if err := s.store.SetSessionStatus(r.Context(), sess.ID, req.Status); err != nil {
			storeError(w, err)
			return
		}
		s.hub.publish(Event{Type: "sessions"})
		s.hub.publish(Event{Type: "threads", SessionID: sess.ID})
	}
	writeJSON(w, 200, map[string]bool{"ok": true})
}

// SessionTitleMax is the longest title set_session_title keeps (in characters).
const SessionTitleMax = 80

// agentTitle sets the session's title: one line, cut to SessionTitleMax.
func (s *Server) agentTitle(w http.ResponseWriter, r *http.Request, sess *store.Session) {
	var req struct {
		Title string `json:"title"`
	}
	if !decode(w, r, &req) {
		return
	}
	title := strings.Join(strings.Fields(req.Title), " ")
	if title == "" {
		httpError(w, 400, "title is required")
		return
	}
	if rs := []rune(title); len(rs) > SessionTitleMax {
		title = strings.TrimSpace(string(rs[:SessionTitleMax-1])) + "…"
	}
	if title != sess.Title {
		if err := s.store.SetSessionTitle(r.Context(), sess.ID, title); err != nil {
			storeError(w, err)
			return
		}
		s.hub.publish(Event{Type: "sessions"})
	}
	writeJSON(w, 200, map[string]any{"ok": true, "title": title})
}

// agentOpen opens a page in the person's browser (wherever minbox is open),
// not on the host: Claude's `open URL` would open it on the host machine,
// which may be another computer.
func (s *Server) agentOpen(w http.ResponseWriter, r *http.Request, sess *store.Session) {
	var req struct {
		URL string `json:"url"`
	}
	if !decode(w, r, &req) {
		return
	}
	u, err := url.Parse(strings.TrimSpace(req.URL))
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		httpError(w, 400, "url must be an absolute http(s) URL")
		return
	}
	n := s.hub.count()
	if n == 0 {
		httpError(w, 409, "no browser has minbox open; give the person the URL in your reply instead")
		return
	}
	s.hub.publish(Event{Type: "open", SessionID: sess.ID, URL: u.String()})
	writeJSON(w, 200, map[string]any{"ok": true, "url": u.String(), "browsers": n})
}

func (s *Server) agentSend(w http.ResponseWriter, r *http.Request, sess *store.Session) {
	var req struct {
		ThreadID    string     `json:"thread_id"`
		ThreadTitle string     `json:"thread_title"`
		Subject     string     `json:"subject"` // the old name of thread_title
		Body        string     `json:"body"`
		Name        string     `json:"name"`
		Attachments []string   `json:"attachments"`
		Review      *reviewReq `json:"review"`
		Status      string     `json:"status"`
	}
	if !decode(w, r, &req) {
		return
	}
	status := ""
	if strings.TrimSpace(req.Status) != "" {
		v, ok := store.NormalizeThreadStatus(req.Status)
		if !ok {
			httpError(w, 400, "unknown status "+req.Status+" (working, need_action or finished)")
			return
		}
		status = v
	}
	body := strings.TrimSpace(req.Body)
	if body == "" {
		httpError(w, 400, "body is required")
		return
	}
	if len(body) > 100_000 {
		httpError(w, 400, "body is too long (100,000 bytes at most)")
		return
	}
	ctx := r.Context()
	// The files are on the session's machine.
	fsys, err := s.sessions.fsOf(sess.HostID)
	if err != nil && (len(req.Attachments) > 0 || req.Review != nil) {
		httpError(w, 503, err.Error())
		return
	}
	home := ""
	if fsys != nil {
		env, _ := fsys.Env(ctx)
		home = env.Home
	}
	// Snapshot first: a bad path refuses the whole message.
	var snaps []*attachmentSnapshot
	for i, p := range req.Attachments {
		snap, err := s.snapshotFile(ctx, fsys, home, sess.Cwd, p, i)
		if err != nil {
			httpError(w, 400, err.Error())
			return
		}
		snaps = append(snaps, snap)
	}
	if req.Review != nil {
		snap, err := snapshotReview(ctx, fsys, home, sess.Cwd, req.Review)
		if err != nil {
			httpError(w, 400, err.Error())
			return
		}
		snaps = append(snaps, snap)
	}
	questions := question.Parse(body)
	m := store.NewMessage{Author: store.AuthorAgent, Body: body, Questions: questions, Status: status}
	title := cleanTitle(req.ThreadTitle)
	if title == "" {
		title = cleanTitle(req.Subject)
	}
	var threadID, messageID, subject string
	isNew := req.ThreadID == ""
	if !isNew {
		th, err := s.store.GetThread(ctx, req.ThreadID)
		if err != nil || th.SessionID != sess.ID {
			httpError(w, 404, "no thread "+req.ThreadID+" in this session; leave thread_id out to start a new thread")
			return
		}
		msg, err := s.store.AddMessage(ctx, th.ID, m)
		if err != nil {
			storeError(w, err)
			return
		}
		threadID, messageID, subject = th.ID, msg.ID, th.Subject
		if title != "" && title != th.Subject {
			subject = title
			if err := s.store.UpdateThread(ctx, th.ID, &title, nil); err != nil {
				storeError(w, err)
				return
			}
		}
	} else {
		subject = title
		if subject == "" {
			subject = firstLine(body, 60)
		}
		th, msg, err := s.store.CreateThread(ctx, sess.ID, subject, m)
		if err != nil {
			storeError(w, err)
			return
		}
		threadID, messageID = th.ID, msg.ID
		if name := strings.TrimSpace(req.Name); name != "" {
			_ = s.store.UpdateThread(ctx, threadID, nil, &name)
		}
	}
	type attInfo struct {
		ID   string `json:"id"`
		Name string `json:"name"`
		Kind string `json:"kind"`
		Path string `json:"path"`
	}
	attsOut := []attInfo{}
	for _, snap := range snaps {
		snap.att.ThreadID, snap.att.MessageID = threadID, messageID
		snap.att.Author = store.AuthorAgent
		if err := s.store.AddAttachment(ctx, &snap.att, snap.content, snap.review); err != nil {
			storeError(w, err)
			return
		}
		kind := snap.att.Type
		if snap.att.Kind == store.AttachmentReview {
			kind = "review"
		}
		attsOut = append(attsOut, attInfo{snap.att.ID, snap.att.Name, kind, snap.att.Path})
	}
	// Images the body shows are kept as they are now; a failure never refuses the send.
	var inline []store.Attachment
	notShown := []imageNotShown{}
	if fsys != nil {
		inline, notShown = s.captureInlineImages(ctx, fsys, home, sess.Cwd, body)
	}
	for i := range inline {
		inline[i].ThreadID, inline[i].MessageID, inline[i].Author = threadID, messageID, store.AuthorAgent
		if err := s.store.AddAttachment(ctx, &inline[i], nil, ""); err != nil {
			storeError(w, err)
			return
		}
	}
	s.publishThread(sess.ID, threadID)
	s.notifyAgentMessage(ctx, sess, threadID, messageID, subject, body, len(questions) > 0)
	type qInfo struct {
		Key    string `json:"key"`
		Kind   string `json:"kind"`
		Prompt string `json:"prompt"`
	}
	qs := []qInfo{}
	for _, q := range questions {
		qs = append(qs, qInfo{q.Key, q.Kind, q.Prompt})
	}
	writeJSON(w, 201, map[string]any{"thread_id": threadID, "message_id": messageID, "new_thread": isNew, "questions": qs,
		"attachments": attsOut, "images_not_shown": notShown})
}

func (s *Server) agentListThreads(w http.ResponseWriter, r *http.Request, sess *store.Session) {
	threads, err := s.store.ListThreads(r.Context(), sess.ID)
	if err != nil {
		storeError(w, err)
		return
	}
	for i := range threads {
		threads[i].Messages = nil
	}
	store.SortThreads(threads)
	writeJSON(w, 200, threads)
}

func (s *Server) agentReadThread(w http.ResponseWriter, r *http.Request, sess *store.Session) {
	th, err := s.store.GetThread(r.Context(), r.PathValue("id"))
	if err != nil || th.SessionID != sess.ID {
		httpError(w, 404, "no such thread in this session")
		return
	}
	writeJSON(w, 200, th)
}

// agentPending answers the person's undelivered messages. With ?wait=N it
// holds the request up to N seconds (at most 25) until there is one.
func (s *Server) agentPending(w http.ResponseWriter, r *http.Request, sess *store.Session) {
	owner := r.URL.Query().Get("owner")
	wait, _ := strconv.Atoi(r.URL.Query().Get("wait"))
	wait = min(max(wait, 0), 25)
	deadline := time.After(time.Duration(wait) * time.Second)
	for {
		ch := s.pendingSignal(sess.ID)
		pending, err := s.store.PendingForSession(r.Context(), sess.ID, owner)
		if err != nil {
			storeError(w, err)
			return
		}
		if len(pending) > 0 || wait == 0 {
			s.withAttachedLines(r, pending)
			writeJSON(w, 200, pending)
			return
		}
		select {
		case <-ch:
		case <-deadline:
			s.withAttachedLines(r, pending)
			writeJSON(w, 200, pending)
			return
		case <-r.Context().Done():
			return
		}
	}
}

// agentClaim reserves a message for the mod instance before it submits it,
// so two instances never both deliver it.
func (s *Server) agentClaim(w http.ResponseWriter, r *http.Request, sess *store.Session) {
	ok, err := s.store.Claim(r.Context(), sess.ID, r.PathValue("id"), r.URL.Query().Get("owner"))
	if err != nil {
		storeError(w, err)
		return
	}
	if ok {
		s.publishMessageChange(r.Context(), sess.ID, r.PathValue("id"))
	}
	writeJSON(w, 200, map[string]bool{"claimed": ok})
}

func (s *Server) agentRelease(w http.ResponseWriter, r *http.Request, sess *store.Session) {
	ok, err := s.store.Release(r.Context(), sess.ID, r.PathValue("id"), r.URL.Query().Get("owner"))
	if err != nil {
		storeError(w, err)
		return
	}
	if ok {
		s.publishMessageChange(r.Context(), sess.ID, r.PathValue("id"))
		s.wakePending(sess.ID)
	}
	writeJSON(w, 200, map[string]bool{"released": ok})
}

// agentDelivered records that the submit went through.
func (s *Server) agentDelivered(w http.ResponseWriter, r *http.Request, sess *store.Session) {
	ok, err := s.store.MarkDelivered(r.Context(), sess.ID, r.PathValue("id"))
	if err != nil {
		storeError(w, err)
		return
	}
	if !ok {
		httpError(w, 404, "no such message in this session")
		return
	}
	s.publishMessageChange(r.Context(), sess.ID, r.PathValue("id"))
	writeJSON(w, 200, map[string]bool{"ok": true})
}

func (s *Server) publishMessageChange(ctx context.Context, sessionID, messageID string) {
	threadID, err := s.store.ThreadOfMessage(ctx, messageID)
	if err != nil {
		log.Printf("thread of %s: %v", messageID, err)
		return
	}
	s.publishThread(sessionID, threadID)
}

// pendingSignal returns a channel closed the next time the session gets a
// message to deliver.
func (s *Server) pendingSignal(sessionID string) <-chan struct{} {
	s.pendingMu.Lock()
	defer s.pendingMu.Unlock()
	ch, ok := s.pendingCh[sessionID]
	if !ok {
		ch = make(chan struct{})
		s.pendingCh[sessionID] = ch
	}
	return ch
}

func (s *Server) wakePending(sessionID string) {
	s.pendingMu.Lock()
	defer s.pendingMu.Unlock()
	if ch, ok := s.pendingCh[sessionID]; ok {
		close(ch)
		delete(s.pendingCh, sessionID)
	}
}
