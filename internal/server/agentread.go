package server

import (
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/ryotarai/minbox/internal/store"
)

// The mod's read-only navigation API: projects, sessions, threads (across sessions), search and
// paged thread reads. Every answer is bounded and a projection of the stored rows: no tokens,
// notification destinations, Slack settings or device data ever pass through here.

const (
	agentListMax      = 200 // most rows of a list
	agentListDefault  = 50
	agentSnippetBytes = 300 // a thread's last_body in a list
	agentMsgBytes     = 8000
	agentReadBytes    = 60000 // a thread read's bodies together
	agentReadDefault  = 30
	agentReadMax      = 100
)

// cutBytes cuts s to at most n bytes on a rune boundary; cut reports whether it was shortened.
func cutBytes(s string, n int) (out string, cut bool) {
	if len(s) <= n {
		return s, false
	}
	for n > 0 && !utf8.RuneStart(s[n]) {
		n--
	}
	return s[:n], true
}

func queryLimit(r *http.Request, def, max int) int {
	n, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	if n <= 0 {
		return def
	}
	return min(n, max)
}

func queryFlag(r *http.Request, key string) bool {
	v := r.URL.Query().Get(key)
	return v == "1" || v == "true"
}

// ---- projects ----

type agentProject struct {
	ID           string     `json:"id"`
	Name         string     `json:"name"`
	Dir          string     `json:"dir"`
	HostID       string     `json:"host_id"`
	HostName     string     `json:"host_name,omitempty"`
	DefaultAgent string     `json:"default_agent"`
	Pinned       bool       `json:"pinned"`
	Archived     bool       `json:"archived"`
	SessionCount int        `json:"session_count"`
	LiveSessions int        `json:"live_sessions"`
	ThreadCount  int        `json:"thread_count"`
	NeedAction   int        `json:"need_action"` // threads waiting on the person
	Unread       int        `json:"unread"`      // unread agent messages
	LastActivity time.Time  `json:"last_activity"`
	Sessions     []agentSes `json:"sessions,omitempty"`
}

type agentSes struct {
	ID           string    `json:"id"`
	Name         string    `json:"name"`
	Title        string    `json:"title"`
	Cwd          string    `json:"cwd"`
	Status       string    `json:"status"`
	Agent        string    `json:"agent"`
	Kind         string    `json:"kind"`
	ProjectID    string    `json:"project_id"`
	HostID       string    `json:"host_id"`
	HostName     string    `json:"host_name,omitempty"`
	Archived     bool      `json:"archived"`
	Unread       int       `json:"unread"`
	Waiting      int       `json:"waiting"`
	LastActivity time.Time `json:"last_activity"`
	Self         bool      `json:"self,omitempty"`
}

func agentSessionOf(sess store.Session, names map[string]string, self string) agentSes {
	return agentSes{ID: sess.ID, Name: sess.Name, Title: sess.Title, Cwd: sess.Cwd, Status: sess.Status, Agent: sess.Agent, Kind: sess.Kind,
		ProjectID: sess.ProjectID, HostID: sess.HostID, HostName: names[sess.HostID], Archived: sess.ArchivedAt != nil,
		Unread: sess.Unread, Waiting: sess.Waiting, LastActivity: sess.LastActivity, Self: sess.ID == self}
}

type projectCounts struct{ threads, needAction, unread int }

func (s *Server) projectCounts(r *http.Request) (map[string]*projectCounts, error) {
	threads, err := s.store.ListAllThreads(r.Context())
	if err != nil {
		return nil, err
	}
	out := map[string]*projectCounts{}
	for _, t := range threads {
		if t.ArchivedAt != nil {
			continue
		}
		c := out[t.ProjectID]
		if c == nil {
			c = &projectCounts{}
			out[t.ProjectID] = c
		}
		c.threads++
		if t.Status == store.ThreadNeedAction {
			c.needAction++
		}
		c.unread += t.Unread
	}
	return out, nil
}

func agentProjectOf(p store.Project, names map[string]string, counts map[string]*projectCounts) agentProject {
	out := agentProject{ID: p.ID, Name: p.Name, Dir: p.Dir, HostID: p.HostID, HostName: names[p.HostID], DefaultAgent: p.DefaultAgent,
		Pinned: p.PinnedAt != nil, Archived: p.ArchivedAt != nil, SessionCount: p.SessionCount,
		LiveSessions: p.LiveSessions, LastActivity: p.LastActivity}
	if c := counts[p.ID]; c != nil {
		out.ThreadCount, out.NeedAction, out.Unread = c.threads, c.needAction, c.unread
	}
	return out
}

func (s *Server) agentListProjects(w http.ResponseWriter, r *http.Request, sess *store.Session) {
	ps, err := s.store.ListProjects(r.Context(), queryFlag(r, "archived"))
	if err != nil {
		storeError(w, err)
		return
	}
	counts, err := s.projectCounts(r)
	if err != nil {
		storeError(w, err)
		return
	}
	names := s.hostNames(r.Context())
	out := []agentProject{}
	for _, p := range ps {
		out = append(out, agentProjectOf(p, names, counts))
	}
	if len(out) > agentListMax {
		out = out[:agentListMax]
	}
	writeJSON(w, 200, out)
}

func (s *Server) agentGetProject(w http.ResponseWriter, r *http.Request, sess *store.Session) {
	p, err := s.store.GetProject(r.Context(), r.PathValue("id"))
	if err != nil {
		httpError(w, 404, "no such project")
		return
	}
	counts, err := s.projectCounts(r)
	if err != nil {
		storeError(w, err)
		return
	}
	names := s.hostNames(r.Context())
	out := agentProjectOf(*p, names, counts)
	all, err := s.store.ListSessions(r.Context())
	if err != nil {
		storeError(w, err)
		return
	}
	out.Sessions = []agentSes{}
	for _, x := range all {
		if x.ProjectID == p.ID && x.Kind == store.KindClaude {
			out.Sessions = append(out.Sessions, agentSessionOf(x, names, sess.ID))
		}
	}
	sort.SliceStable(out.Sessions, func(i, j int) bool { return out.Sessions[i].LastActivity.After(out.Sessions[j].LastActivity) })
	if len(out.Sessions) > agentListDefault {
		out.Sessions = out.Sessions[:agentListDefault]
	}
	writeJSON(w, 200, out)
}

// ---- sessions ----

// agentListSessions: agent sessions (not shells), newest activity first. Filters: project_id,
// status, agent, archived=1 (archived ones instead of live ones), limit.
func (s *Server) agentListSessions(w http.ResponseWriter, r *http.Request, sess *store.Session) {
	q := r.URL.Query()
	all, err := s.store.ListSessions(r.Context())
	if err != nil {
		storeError(w, err)
		return
	}
	names := s.hostNames(r.Context())
	archived := queryFlag(r, "archived")
	out := []agentSes{}
	for _, x := range all {
		if x.Kind != store.KindClaude || (x.ArchivedAt != nil) != archived {
			continue
		}
		if v := q.Get("project_id"); v != "" && x.ProjectID != v {
			continue
		}
		if v := q.Get("status"); v != "" && x.Status != v {
			continue
		}
		if v := q.Get("agent"); v != "" && x.Agent != v {
			continue
		}
		out = append(out, agentSessionOf(x, names, sess.ID))
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].LastActivity.After(out[j].LastActivity) })
	total := len(out)
	if lim := queryLimit(r, agentListDefault, agentListMax); len(out) > lim {
		out = out[:lim]
	}
	writeJSON(w, 200, map[string]any{"sessions": out, "total": total, "has_more": total > len(out)})
}

// ---- threads ----

type agentThreadRow struct {
	ID            string    `json:"id"`
	Subject       string    `json:"subject"`
	Name          string    `json:"name,omitempty"`
	SessionID     string    `json:"session_id"`
	SessionName   string    `json:"session_name"`
	ProjectID     string    `json:"project_id"`
	ProjectName   string    `json:"project_name"`
	Status        string    `json:"status"`
	Section       string    `json:"section"`
	UpdatedAt     time.Time `json:"updated_at"`
	Unread        int       `json:"unread"`
	OpenQuestions int       `json:"open_questions"`
	MessageCount  int       `json:"message_count"`
	LastAuthor    string    `json:"last_author"`
	LastBody      string    `json:"last_body"`
	Archived      bool      `json:"archived"`
	Self          bool      `json:"self,omitempty"` // a thread of the calling session
}

// agentInbox lists threads across sessions, newest first. Filters: project_id, session_id (or
// "self"), status, awaiting=person|agent, unread=1, q (words in subject, name, last message),
// archived=1 (archived threads instead of live ones), limit.
func (s *Server) agentInbox(w http.ResponseWriter, r *http.Request, sess *store.Session) {
	q := r.URL.Query()
	status := q.Get("status")
	if status != "" {
		v, ok := store.NormalizeThreadStatus(status)
		if !ok && status != "blocked" {
			httpError(w, 400, "status must be working, need_action, blocked or finished")
			return
		}
		if ok {
			status = v
		}
	}
	awaiting := q.Get("awaiting")
	if awaiting != "" && awaiting != "person" && awaiting != "agent" {
		httpError(w, 400, "awaiting must be person or agent")
		return
	}
	sessionID := q.Get("session_id")
	if sessionID == "self" {
		sessionID = sess.ID
	}
	archived := queryFlag(r, "archived")
	words := strings.Fields(strings.ToLower(q.Get("q")))
	var threads []store.Thread
	var err error
	if sessionID != "" {
		threads, err = s.store.ListThreads(r.Context(), sessionID)
	} else {
		threads, err = s.store.ListAllThreads(r.Context())
	}
	if err != nil {
		storeError(w, err)
		return
	}
	sessNames := map[string]string{}
	if all, err := s.store.ListSessions(r.Context()); err == nil {
		for _, x := range all {
			sessNames[x.ID] = x.Name
		}
	}
	rows := []agentThreadRow{}
	for _, t := range threads {
		if (t.ArchivedAt != nil) != archived {
			continue
		}
		if v := q.Get("project_id"); v != "" && t.ProjectID != v {
			continue
		}
		if status != "" && t.Status != status {
			continue
		}
		if awaiting == "person" && t.Status != store.ThreadNeedAction && t.OpenQuestions == 0 {
			continue
		}
		if awaiting == "agent" && t.LastAuthor != store.AuthorUser {
			continue
		}
		if queryFlag(r, "unread") && t.Unread == 0 {
			continue
		}
		if len(words) > 0 {
			hay := strings.ToLower(t.Subject + " " + t.Name + " " + t.LastBody)
			ok := true
			for _, w := range words {
				ok = ok && strings.Contains(hay, w)
			}
			if !ok {
				continue
			}
		}
		last, _ := cutBytes(strings.Join(strings.Fields(t.LastBody), " "), agentSnippetBytes)
		rows = append(rows, agentThreadRow{ID: t.ID, Subject: t.Subject, Name: t.Name, SessionID: t.SessionID, SessionName: sessNames[t.SessionID],
			ProjectID: t.ProjectID, ProjectName: t.ProjectName, Status: t.Status, Section: t.Section, UpdatedAt: t.UpdatedAt, Unread: t.Unread,
			OpenQuestions: t.OpenQuestions, MessageCount: t.MessageCount, LastAuthor: t.LastAuthor, LastBody: last, Archived: t.ArchivedAt != nil,
			Self: t.SessionID == sess.ID})
	}
	sort.SliceStable(rows, func(i, j int) bool { return rows[i].UpdatedAt.After(rows[j].UpdatedAt) })
	total := len(rows)
	if lim := queryLimit(r, agentListDefault, agentListMax); len(rows) > lim {
		rows = rows[:lim]
	}
	writeJSON(w, 200, map[string]any{"threads": rows, "total": total, "has_more": total > len(rows)})
}

// ---- reading one thread ----

type agentAtt struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	Kind string `json:"kind"`
	Type string `json:"type,omitempty"`
	Path string `json:"path"`
	Ref  string `json:"ref,omitempty"`
}

type agentMsg struct {
	ID           string     `json:"id"`
	Author       string     `json:"author"`
	Body         string     `json:"body"`
	Truncated    bool       `json:"truncated,omitempty"`
	BodyBytes    int        `json:"body_bytes,omitempty"` // the full body's size when cut
	CreatedAt    time.Time  `json:"created_at"`
	Questions    []string   `json:"questions,omitempty"`
	Attachments  []agentAtt `json:"attachments,omitempty"`
	InlineImages []agentAtt `json:"inline_images,omitempty"`
}

func attsOf(in []store.Attachment) []agentAtt {
	var out []agentAtt
	for _, a := range in {
		out = append(out, agentAtt{ID: a.ID, Name: a.Name, Kind: a.Kind, Type: a.Type, Path: a.Path, Ref: a.Ref})
	}
	return out
}

// agentReadThread answers any thread by id (read-only, also another session's): the newest
// `limit` messages (default 30, at most 100), older ones with `before` (a message id from
// next_before). Each body is cut at 8000 bytes and the bodies together at 60000 (the oldest of
// the page drop first, so the newest stay); has_more and next_before say how to go on.
func (s *Server) agentReadThread(w http.ResponseWriter, r *http.Request, sess *store.Session) {
	th, err := s.store.GetThread(r.Context(), r.PathValue("id"))
	if err != nil {
		httpError(w, 404, "no such thread")
		return
	}
	msgs := th.Messages
	total := len(msgs)
	end := total
	if before := r.URL.Query().Get("before"); before != "" {
		end = -1
		for i, m := range msgs {
			if m.ID == before {
				end = i
				break
			}
		}
		if end < 0 {
			httpError(w, 400, "before is not a message of this thread")
			return
		}
	}
	limit := queryLimit(r, agentReadDefault, agentReadMax)
	start := max(0, end-limit)
	page := []agentMsg{}
	size := 0
	// Newest first until the byte budget is spent, then back to chronological order.
	i := end - 1
	for ; i >= start; i-- {
		m := msgs[i]
		body, cut := cutBytes(m.Body, agentMsgBytes)
		if cut {
			body += "\n… [message cut: " + strconv.Itoa(len(m.Body)-len(body)) + " more bytes]"
		}
		if size+len(body) > agentReadBytes && len(page) > 0 {
			break
		}
		size += len(body)
		am := agentMsg{ID: m.ID, Author: m.Author, Body: body, Truncated: cut, CreatedAt: m.CreatedAt,
			Attachments: attsOf(m.Attachments), InlineImages: attsOf(m.InlineImages)}
		if cut {
			am.BodyBytes = len(m.Body)
		}
		for _, q := range m.Questions {
			am.Questions = append(am.Questions, q.Prompt)
		}
		page = append(page, am)
	}
	for a, b := 0, len(page)-1; a < b; a, b = a+1, b-1 {
		page[a], page[b] = page[b], page[a]
	}
	older := i + 1 // messages before the page's first
	out := map[string]any{
		"id": th.ID, "subject": th.Subject, "session_id": th.SessionID, "project_id": th.ProjectID, "project_name": th.ProjectName,
		"status": th.Status, "section": th.Section, "updated_at": th.UpdatedAt, "unread": th.Unread, "open_questions": th.OpenQuestions,
		"message_count": total, "messages": page, "has_more": older > 0, "older": older,
		"own": th.SessionID == sess.ID,
	}
	if older > 0 && len(page) > 0 {
		out["next_before"] = page[0].ID
	}
	if owner, err := s.store.GetSession(r.Context(), th.SessionID); err == nil {
		out["session_name"] = owner.Name
	}
	writeJSON(w, 200, out)
}

// ---- search ----

// agentSearch is the palette's search for the mod: threads, messages and files (names), with
// snippets, optionally within a project or a session.
func (s *Server) agentSearch(w http.ResponseWriter, r *http.Request, sess *store.Session) {
	q := r.URL.Query()
	if strings.TrimSpace(q.Get("q")) == "" {
		httpError(w, 400, "q is required")
		return
	}
	sessionID := q.Get("session_id")
	if sessionID == "self" {
		sessionID = sess.ID
	}
	from := q.Get("from")
	if from != "" && from != "agent" && from != "user" {
		httpError(w, 400, "from must be agent or user")
		return
	}
	lim := queryLimit(r, 20, 50)
	res, err := s.store.Search(r.Context(), store.SearchQuery{Q: q.Get("q"), SessionID: sessionID, From: from, Limit: lim})
	if err != nil {
		storeError(w, err)
		return
	}
	projectOf := map[string]string{}
	if v := q.Get("project_id"); v != "" {
		all, err := s.store.ListSessions(r.Context())
		if err != nil {
			storeError(w, err)
			return
		}
		for _, x := range all {
			projectOf[x.ID] = x.ProjectID
		}
	}
	keep := func(hs []store.Hit) []store.Hit {
		out := []store.Hit{}
		for _, h := range hs {
			if v := q.Get("project_id"); v != "" && projectOf[h.SessionID] != v {
				continue
			}
			h.Snippet, _ = cutBytes(h.Snippet, 400)
			out = append(out, h)
			if len(out) >= lim {
				break
			}
		}
		return out
	}
	writeJSON(w, 200, store.SearchResult{Threads: keep(res.Threads), Messages: keep(res.Messages), Files: keep(res.Files)})
}
