package server

import (
	"context"
	"errors"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/ryotarai/minbox/internal/question"
	"github.com/ryotarai/minbox/internal/store"
)

// minbox v3 (docs/v3/redesign.md, docs/v3/api.md): the Board of tasks and goals, a task's view (its
// tagged messages from every agent's stream), an agent's stream, tags, read state, search. The
// person's messages still go through the reply machinery of the session's stream thread.

const (
	v3DoneWindow   = 7 * 24 * time.Hour
	v3DoneLimit    = 50
	v3StreamLimit  = 200
	v3SearchLimit  = 60
	v3ExcerptChars = 240
)

// V3Message is a message as the v3 views show it: with its agent (session), its tags and, for a
// message of an older thread, that thread (the stream shows a divider where it changes).
type V3Message struct {
	store.Message
	SessionID string          `json:"session_id"`
	Tasks     []store.TaskRef `json:"tasks"`
	Segment   *Segment        `json:"segment,omitempty"`
	// Open: the questions of this (agent) message still waiting on the person.
	Open int `json:"open"`
}

// Segment is the older thread a message belongs to.
type Segment struct {
	ID      string `json:"id"`
	Subject string `json:"subject"`
}

// BoardTask is a task (or goal) with what the Board shows about it.
type BoardTask struct {
	store.Task
	OpenQuestions int       `json:"open_questions"`
	Unread        int       `json:"unread"`
	MessageCount  int       `json:"message_count"`
	LastActivity  time.Time `json:"last_activity"`
	// LastAgent: the session of the newest tagged agent message (else the first assigned agent):
	// where a reply from the task goes by default.
	LastAgent string `json:"last_agent"`
	// NeedsYou: set to needs_you, or a tagged question is open.
	NeedsYou bool `json:"needs_you"`
	// Goals: how many of its criteria are met; its tasks.
	CriteriaDone int      `json:"criteria_done"`
	TaskIDs      []string `json:"task_ids,omitempty"`
	// LastLine: the start of the newest agent message about it (what the agent said last).
	LastLine string `json:"last_line"`
}

// lastLine is a line to show for a message in a list: its first line of prose (no markdown marks, no
// question blocks), at most 160 characters.
func lastLine(body string) string {
	inBlock := false
	for _, l := range strings.Split(body, "\n") {
		t := strings.TrimSpace(l)
		if strings.HasPrefix(t, ":::") {
			inBlock = t != ":::" && !inBlock
			continue
		}
		if inBlock || t == "" || strings.HasPrefix(t, "```") || strings.HasPrefix(t, "|") || strings.HasPrefix(t, "---") {
			continue
		}
		t = strings.TrimLeft(t, "#>-*0123456789. ")
		t = strings.NewReplacer("**", "", "`", "", "__", "").Replace(t)
		t = strings.TrimSpace(t)
		if t == "" {
			continue
		}
		return truncRunes(t, 160)
	}
	return ""
}

// openOf counts the open questions of a message as derive left it (answered and closed ones out).
func openOf(m *store.Message) int {
	if m.Author != store.AuthorAgent {
		return 0
	}
	n := 0
	for _, q := range m.Questions {
		if q.Kind != question.Text && q.Kind != question.Action && settled(q) {
			continue
		}
		if a, ok := m.AnswerState[q.Key]; ok && !a.Empty() {
			continue
		}
		if _, closed := m.Closed[q.Key]; closed {
			continue
		}
		n++
	}
	return n
}

func settled(q question.Question) bool {
	for _, c := range q.Choices {
		if c.Settled {
			return true
		}
	}
	return false
}

// v3View is what the Board and the task view are computed from: the messages of the live sessions
// (of a project), with their tags.
type v3View struct {
	msgs    []V3Message
	byID    map[string]int
	threads map[string]*store.Thread
}

func (s *Server) loadView(ctx context.Context, ths []store.Thread) (*v3View, error) {
	all, byThread, _ := flattenThreads(ths)
	ids := make([]string, len(all))
	for i := range all {
		ids[i] = all[i].ID
	}
	tags, err := s.store.TasksOf(ctx, ids)
	if err != nil {
		return nil, err
	}
	v := &v3View{byID: map[string]int{}, threads: byThread}
	for _, m := range all {
		th := byThread[m.ThreadID]
		vm := V3Message{Message: m, SessionID: th.SessionID, Tasks: tags[m.ID]}
		if vm.Tasks == nil {
			vm.Tasks = []store.TaskRef{}
		}
		if th.Kind != store.ThreadStream {
			vm.Segment = &Segment{ID: th.ID, Subject: firstNonEmpty(th.Name, th.Subject)}
		}
		// An older thread's question counts while that thread still waits on the person.
		if th.Kind == store.ThreadStream || th.Section == store.SectionStopped || th.Section == store.SectionHolding || th.Section == store.SectionWaiting {
			vm.Open = openOf(&m)
		}
		v.byID[m.ID] = len(v.msgs)
		v.msgs = append(v.msgs, vm)
	}
	return v, nil
}

func flattenThreads(ths []store.Thread) ([]store.Message, map[string]*store.Thread, error) {
	byID := map[string]*store.Thread{}
	var out []store.Message
	for i := range ths {
		byID[ths[i].ID] = &ths[i]
		out = append(out, ths[i].Messages...)
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].CreatedAt.Before(out[j].CreatedAt) })
	return out, byID, nil
}

// boardTask derives a task's Board fields from the view.
func (v *v3View) boardTask(t store.Task, tasks []store.Task) BoardTask {
	b := BoardTask{Task: t, LastActivity: t.UpdatedAt}
	for _, m := range v.msgs {
		has := false
		for _, tg := range m.Tasks {
			if tg.TaskID == t.ID {
				has = true
				break
			}
		}
		if !has {
			continue
		}
		b.MessageCount++
		b.OpenQuestions += m.Open
		if m.Author == store.AuthorAgent {
			if m.ReadAt == nil {
				b.Unread++
			}
			b.LastAgent = m.SessionID
			if l := lastLine(m.Body); l != "" {
				b.LastLine = l
			}
		}
		if m.CreatedAt.After(b.LastActivity) {
			b.LastActivity = m.CreatedAt
		}
	}
	if b.LastAgent == "" && len(t.Agents) > 0 {
		b.LastAgent = t.Agents[0].SessionID
	}
	if t.Kind == store.KindGoal && t.Auto.SessionID != "" {
		b.LastAgent = t.Auto.SessionID
	}
	for _, c := range t.Criteria {
		if c.Done {
			b.CriteriaDone++
		}
	}
	for _, x := range tasks {
		if x.ParentID == t.ID {
			b.TaskIDs = append(b.TaskIDs, x.ID)
		}
	}
	b.NeedsYou = t.Status != store.TaskDone && (t.Status == store.TaskNeedsYou || b.OpenQuestions > 0)
	return b
}

// GET /api/v3/board?project=<id>: the Board: open questions (oldest first), tasks and goals with
// their derived fields (open ones, then the done ones of the last week), and per-agent counts.
func (s *Server) v3Board(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	project := r.URL.Query().Get("project")
	ths, err := s.store.ProjectThreads(ctx, project)
	if err != nil {
		storeError(w, err)
		return
	}
	v, err := s.loadView(ctx, ths)
	if err != nil {
		storeError(w, err)
		return
	}
	tasks, err := s.store.ListTasks(ctx, store.TaskQuery{ProjectID: project, DoneSince: time.Now().Add(-v3DoneWindow), DoneLimit: v3DoneLimit})
	if err != nil {
		storeError(w, err)
		return
	}
	out := make([]BoardTask, 0, len(tasks))
	for _, t := range tasks {
		out = append(out, v.boardTask(t, tasks))
	}
	questions := []V3Message{}
	type agentCount struct {
		Unread        int `json:"unread"`
		OpenQuestions int `json:"open_questions"`
	}
	agents := map[string]*agentCount{}
	for _, m := range v.msgs {
		a := agents[m.SessionID]
		if a == nil {
			a = &agentCount{}
			agents[m.SessionID] = a
		}
		if m.Author == store.AuthorAgent && m.ReadAt == nil {
			a.Unread++
		}
		if m.Open > 0 {
			a.OpenQuestions += m.Open
			questions = append(questions, m)
		}
	}
	writeJSON(w, 200, map[string]any{"tasks": out, "questions": questions, "agents": agents})
}

// GET /api/v3/tasks/{id}: a task (or goal) with its tagged messages from every stream (oldest first),
// each with how many untagged messages of the same stream lie between it and the previous tagged one
// (the "show context" gap), its timeline, and its tasks when it is a goal.
func (s *Server) v3Task(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	t, err := s.store.GetTask(ctx, r.PathValue("id"))
	if err != nil {
		storeError(w, err)
		return
	}
	ids, err := s.store.TaskMessageIDs(ctx, t.ID)
	if err != nil {
		storeError(w, err)
		return
	}
	// The sessions the tagged messages are in: their whole streams (for the gaps).
	sessions := map[string]bool{}
	for _, id := range ids {
		if sid, _, err := s.store.MessageSession(ctx, id); err == nil {
			sessions[sid] = true
		}
	}
	var ths []store.Thread
	for sid := range sessions {
		more, err := s.store.ListThreads(ctx, sid)
		if err != nil {
			storeError(w, err)
			return
		}
		ths = append(ths, more...)
	}
	v, err := s.loadView(ctx, ths)
	if err != nil {
		storeError(w, err)
		return
	}
	tagged := map[string]bool{}
	for _, id := range ids {
		tagged[id] = true
	}
	type item struct {
		V3Message
		Gap int `json:"gap"` // untagged messages of its stream since the previous tagged one there
	}
	items := []item{}
	lastIdx := map[string]int{} // session → index in v.msgs of its previous tagged message
	for i, m := range v.msgs {
		if !tagged[m.ID] {
			continue
		}
		gap := 0
		if prev, ok := lastIdx[m.SessionID]; ok {
			for j := prev + 1; j < i; j++ {
				if v.msgs[j].SessionID == m.SessionID {
					gap++
				}
			}
		}
		lastIdx[m.SessionID] = i
		items = append(items, item{V3Message: m, Gap: gap})
	}
	evs, err := s.store.TaskEvents(ctx, t.ID)
	if err != nil {
		storeError(w, err)
		return
	}
	all, err := s.store.ListTasks(ctx, store.TaskQuery{ProjectID: t.ProjectID})
	if err != nil {
		storeError(w, err)
		return
	}
	bt := v.boardTask(*t, all)
	children := []BoardTask{}
	for _, x := range all {
		if x.ParentID == t.ID {
			children = append(children, v.boardTask(x, all))
		}
	}
	var parent *store.Task
	if t.ParentID != "" {
		parent, _ = s.store.GetTask(ctx, t.ParentID)
	}
	writeJSON(w, 200, map[string]any{"task": bt, "messages": items, "events": evs, "tasks": children, "goal": parent})
}

// GET /api/v3/sessions/{id}/stream?limit=&before=<msg>&after=<msg>: the agent's stream, oldest first:
// the newest `limit` messages (before a message, when given), or the messages between after and
// before (the context of a task's gap). has_more says older ones exist.
func (s *Server) v3Stream(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	sid := r.PathValue("id")
	if _, err := s.store.GetSession(ctx, sid); err != nil {
		storeError(w, err)
		return
	}
	ths, err := s.store.ListThreads(ctx, sid)
	if err != nil {
		storeError(w, err)
		return
	}
	v, err := s.loadView(ctx, ths)
	if err != nil {
		storeError(w, err)
		return
	}
	q := r.URL.Query()
	limit, _ := strconv.Atoi(q.Get("limit"))
	if limit <= 0 || limit > 1000 {
		limit = v3StreamLimit
	}
	end := len(v.msgs)
	if b := q.Get("before"); b != "" {
		if i, ok := v.byID[b]; ok {
			end = i
		}
	}
	start := max(0, end-limit)
	if a := q.Get("after"); a != "" {
		if i, ok := v.byID[a]; ok {
			start = i + 1
		}
	}
	if start > end {
		start = end
	}
	msgs := v.msgs[start:end]
	if msgs == nil {
		msgs = []V3Message{}
	}
	tasks, err := s.store.ListTasks(ctx, store.TaskQuery{SessionID: sid, DoneSince: time.Now().Add(-v3DoneWindow), DoneLimit: 20})
	if err != nil {
		storeError(w, err)
		return
	}
	stream, _ := s.store.StreamThread(ctx, sid)
	writeJSON(w, 200, map[string]any{"messages": msgs, "has_more": start > 0 && q.Get("after") == "", "tasks": tasks, "stream_thread_id": stream})
}

// POST /api/v3/sessions/{id}/messages: the person writes to the agent (in its stream). The body is
// the reply's ({words, answers_for?, answers?, uploads?, annotations?, urgent?, resume?}) plus
// task_ids: tags the message gets (a message from a task view). A message answering a question of
// an older thread goes to that thread.
func (s *Server) v3Send(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	sid := r.PathValue("id")
	sess, err := s.store.GetSession(ctx, sid)
	if err != nil {
		storeError(w, err)
		return
	}
	if sess.Kind == store.KindShell {
		httpError(w, 400, "a shell session has no stream")
		return
	}
	thread, err := s.store.StreamThread(ctx, sid)
	if err != nil {
		storeError(w, err)
		return
	}
	if th := r.URL.Query().Get("thread"); th != "" {
		// Answers to a question of an older thread go to that thread.
		if t, err := s.store.GetThread(ctx, th); err == nil && t.SessionID == sid {
			thread = th
		}
	}
	r.SetPathValue("id", thread)
	s.reply(w, r)
}

// POST /api/v3/new {to: <session id> | "new", project_id, agent?, name?, words, task_ids?, uploads?}:
// the composer's message: to an agent's stream, or to a new agent (session) started for it.
func (s *Server) v3New(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	var req struct {
		To        string `json:"to"`
		ProjectID string `json:"project_id"`
		Agent     string `json:"agent"`
		Name      string `json:"name"`
	}
	body, ok := peekJSON(w, r, &req)
	if !ok {
		return
	}
	to := req.To
	if to == "" || to == "new" {
		if to == "" {
			// The project's main session.
			if p, err := s.store.GetProject(ctx, req.ProjectID); err == nil && p.MainSessionID != "" {
				to = p.MainSessionID
			}
		}
		if to == "" || to == "new" {
			sess, err := s.sessions.CreateAgent(ctx, store.KindClaude, strings.TrimSpace(req.Agent), strings.TrimSpace(req.Name), "", "", strings.TrimSpace(req.ProjectID))
			if err != nil {
				httpError(w, 400, err.Error())
				return
			}
			to = sess.ID
			s.hub.publish(Event{Type: "sessions"})
		}
	}
	r.Body = body
	r.SetPathValue("id", to)
	s.v3Send(w, r)
}

// PATCH /api/v3/tasks/{id} {title?, status?, steps?, criteria?, parent_id?, summary?}: the person edits a task.
func (s *Server) v3PatchTask(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Title    *string           `json:"title"`
		Status   *string           `json:"status"`
		Summary  *string           `json:"summary"`
		Steps    *[]store.TaskStep `json:"steps"`
		Criteria *[]store.TaskStep `json:"criteria"`
		ParentID *string           `json:"parent_id"`
	}
	if !decode(w, r, &body) {
		return
	}
	ctx := r.Context()
	t, err := s.store.UpdateTask(ctx, r.PathValue("id"), "", store.TaskFields{Title: body.Title, Status: body.Status, Summary: body.Summary, Steps: body.Steps, Criteria: body.Criteria, ParentID: body.ParentID})
	if err != nil {
		v3TaskError(w, err)
		return
	}
	if t.Kind == store.KindGoal && t.Status == store.TaskDone && t.Auto.State == store.AutoRunning {
		s.stopAuto(ctx, t, "done")
	}
	s.publishTasks()
	writeJSON(w, 200, t)
}

// POST /api/v3/tasks {project_id, title, kind?, session_id?, message_ids?}: the person makes a task (the
// tag picker's "New task") and tags messages with it.
func (s *Server) v3CreateTask(w http.ResponseWriter, r *http.Request) {
	var body struct {
		ProjectID  string   `json:"project_id"`
		Title      string   `json:"title"`
		Kind       string   `json:"kind"`
		SessionID  string   `json:"session_id"`
		MessageIDs []string `json:"message_ids"`
	}
	if !decode(w, r, &body) {
		return
	}
	ctx := r.Context()
	project := body.ProjectID
	if project == "" && len(body.MessageIDs) > 0 {
		if sid, _, err := s.store.MessageSession(ctx, body.MessageIDs[0]); err == nil {
			if sess, err := s.store.GetSession(ctx, sid); err == nil {
				project = sess.ProjectID
			}
		}
	}
	kind := ""
	if body.Kind == store.KindGoal {
		kind = store.KindGoal
	}
	t, err := s.store.CreateTask(ctx, project, "", store.TaskFields{Title: &body.Title, Kind: &kind})
	if err != nil {
		v3TaskError(w, err)
		return
	}
	if body.SessionID != "" {
		_, _ = s.store.AddTaskAgent(ctx, t.ID, body.SessionID, store.RoleAssigned)
	}
	if _, err := s.store.LinkMessages(ctx, t.ID, body.MessageIDs, store.LinkPerson); err != nil {
		storeError(w, err)
		return
	}
	t, _ = s.store.GetTask(ctx, t.ID)
	s.publishTasks()
	writeJSON(w, 201, t)
}

func v3TaskError(w http.ResponseWriter, err error) {
	if errors.Is(err, store.ErrTaskTitle) || errors.Is(err, store.ErrInvalidTaskStatus) {
		httpError(w, 400, err.Error())
		return
	}
	storeError(w, err)
}

// POST /api/v3/messages/{id}/tasks {task_id}: the person says a message is (also) about a task.
func (s *Server) v3LinkTask(w http.ResponseWriter, r *http.Request) {
	var body struct {
		TaskID string `json:"task_id"`
	}
	if !decode(w, r, &body) {
		return
	}
	ctx := r.Context()
	mid := r.PathValue("id")
	if _, err := s.store.GetTask(ctx, body.TaskID); err != nil {
		storeError(w, err)
		return
	}
	added, err := s.store.LinkMessages(ctx, body.TaskID, []string{mid}, store.LinkPerson)
	if err != nil {
		storeError(w, err)
		return
	}
	if len(added) == 0 {
		if _, _, err := s.store.MessageSession(ctx, mid); err != nil {
			storeError(w, err)
			return
		}
	} else {
		_ = s.store.AddTaskEvent(ctx, body.TaskID, "link", "A message added by you", "", mid)
	}
	s.publishMessage(ctx, mid)
	writeJSON(w, 200, map[string]any{"ok": true, "added": len(added) > 0})
}

// DELETE /api/v3/messages/{id}/tasks/{task}: the person says a message is not about that task.
func (s *Server) v3UnlinkTask(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	mid, tid := r.PathValue("id"), r.PathValue("task")
	ok, err := s.store.UnlinkMessage(ctx, mid, tid)
	if err != nil {
		storeError(w, err)
		return
	}
	if ok {
		_ = s.store.AddTaskEvent(ctx, tid, "unlink", "A message taken out by you", "", mid)
	}
	s.publishMessage(ctx, mid)
	writeJSON(w, 200, map[string]any{"ok": true, "removed": ok})
}

// POST /api/v3/messages/{id}/move {from?, to?, title?}: "Move to task…" on an agent reply: the reply
// and the person's messages it answered (its turn) move from task `from` (or from no task) to `to`, or
// to a new task named `title`. A task the agent created in that turn that is left with no messages is
// deleted.
func (s *Server) v3Move(w http.ResponseWriter, r *http.Request) {
	var body struct {
		From  string `json:"from"`
		To    string `json:"to"`
		Title string `json:"title"`
	}
	if !decode(w, r, &body) {
		return
	}
	ctx := r.Context()
	m, err := s.store.GetMessage(ctx, r.PathValue("id"))
	if err != nil {
		storeError(w, err)
		return
	}
	sid, _, err := s.store.MessageSession(ctx, m.ID)
	if err != nil {
		storeError(w, err)
		return
	}
	to := body.To
	if to == "" {
		sess, err := s.store.GetSession(ctx, sid)
		if err != nil {
			storeError(w, err)
			return
		}
		t, err := s.store.CreateTask(ctx, sess.ProjectID, "", store.TaskFields{Title: &body.Title})
		if err != nil {
			v3TaskError(w, err)
			return
		}
		_, _ = s.store.AddTaskAgent(ctx, t.ID, sid, store.RoleAssigned)
		to = t.ID
	} else if _, err := s.store.GetTask(ctx, to); err != nil {
		storeError(w, err)
		return
	}
	ids := append([]string{m.ID}, m.TurnOf...)
	if body.From != "" && body.From != to {
		for _, id := range ids {
			_, _ = s.store.UnlinkMessage(ctx, id, body.From)
		}
	}
	if _, err := s.store.LinkMessages(ctx, to, ids, store.LinkPerson); err != nil {
		storeError(w, err)
		return
	}
	removed := ""
	if body.From != "" && body.From != to {
		from, err := s.store.GetTask(ctx, body.From)
		if err == nil {
			toTask, _ := s.store.GetTask(ctx, to)
			title := ""
			if toTask != nil {
				title = toTask.Title
			}
			_ = s.store.AddTaskEvent(ctx, from.ID, "unlink", "Messages moved by you to “"+title+"”", "", m.ID)
			if n, _ := s.store.TaskCount(ctx, from.ID); n == 0 && m.Decision == store.DecisionCreated && m.DecisionTask == from.ID {
				_ = s.store.DeleteTask(ctx, from.ID)
				removed = from.Title
			}
		}
	}
	_ = s.store.AddTaskEvent(ctx, to, "link", "Messages moved here by you", "", m.ID)
	_ = s.store.SetDecision(ctx, m.ID, store.DecisionMoved, to, m.TurnOf)
	s.publishTasks()
	s.publishMessage(ctx, m.ID)
	writeJSON(w, 200, map[string]any{"ok": true, "task_id": to, "removed_task": removed})
}

// POST /api/v3/read {message_ids}: messages shown on screen are read.
func (s *Server) v3Read(w http.ResponseWriter, r *http.Request) {
	var body struct {
		MessageIDs []string `json:"message_ids"`
	}
	if !decode(w, r, &body) {
		return
	}
	n, err := s.store.MarkMessagesRead(r.Context(), body.MessageIDs)
	if err != nil {
		storeError(w, err)
		return
	}
	if n > 0 {
		s.hub.publish(Event{Type: "sessions"})
		s.publishTasks()
	}
	writeJSON(w, 200, map[string]int64{"marked": n})
}

// GET /api/v3/search?q=&project=: tasks and messages that have q.
func (s *Server) v3Search(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	q, project := r.URL.Query().Get("q"), r.URL.Query().Get("project")
	tasks, err := s.store.SearchTasks(ctx, project, q)
	if err != nil {
		storeError(w, err)
		return
	}
	msgs, err := s.store.SearchMessages(ctx, project, q, v3SearchLimit)
	if err != nil {
		storeError(w, err)
		return
	}
	writeJSON(w, 200, map[string]any{"tasks": tasks, "messages": msgs})
}

func (s *Server) publishTasks() { s.hub.publish(Event{Type: "tasks"}) }

// publishMessage tells the browsers a message's thread (and the tasks) changed.
func (s *Server) publishMessage(ctx context.Context, messageID string) {
	sid, _, err := s.store.MessageSession(ctx, messageID)
	if err != nil {
		return
	}
	if th, err := s.store.ThreadOfMessage(ctx, messageID); err == nil {
		s.publishThread(sid, th)
	}
	s.publishTasks()
}
