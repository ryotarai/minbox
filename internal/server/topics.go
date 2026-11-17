package server

import (
	"errors"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/ryotarai/minbox/internal/store"
)

// Topics (Tasks in the UI): the pieces of work each thread is about. The agent of the thread's
// session keeps them itself with its create_task / update_task / list_tasks tools (the Claude Code
// mod, Pi's extension and OpenCode's plugin call /api/agent/tasks), and the Tasks board shows them
// across threads. The person can move a card by hand (PATCH /api/topics/{id}); the agent may set the
// status again afterwards. See docs/api-contract.md ("Tasks").

const (
	topicsTitleLen   = 120
	topicsSummaryLen = 300
	// The topic pane: the fuller summary, its steps, the related messages.
	topicsDetailLen  = 4000
	topicsMaxTasks   = 30
	topicsTaskLen    = 200
	topicsMaxMsgIDs  = 50
	topicsExcerptLen = 240
	// A thread holds at most this many tasks (against a runaway agent).
	topicsPerThread = 100
	// The board's Done column: topics done within this long, at most topicsDoneLimit of them.
	topicsDoneWindow = 7 * 24 * time.Hour
	topicsDoneLimit  = 30
)

// ---- the agent's API ----

// taskBody is what create_task and update_task send. Every field is optional on an update (a field
// left out stays as it is); steps replace the checklist, check_steps / uncheck_steps tick or untick
// steps by their number (1-based) after that.
type taskBody struct {
	ThreadID     string             `json:"thread_id"`
	Title        *string            `json:"title"`
	Summary      *string            `json:"summary"`
	Detail       *string            `json:"detail"`
	Status       *string            `json:"status"`
	Steps        *[]store.TopicTask `json:"steps"`
	Tasks        *[]store.TopicTask `json:"tasks"` // the store's name of steps
	CheckSteps   []int              `json:"check_steps"`
	UncheckSteps []int              `json:"uncheck_steps"`
	MessageIDs   []string           `json:"message_ids"`
}

// fields checks and caps the body; cur is the task's current steps (nil on create).
func (b *taskBody) fields(cur []store.TopicTask) (store.TopicFields, string) {
	var f store.TopicFields
	capped := func(p *string, n int, oneLine bool) *string {
		if p == nil {
			return nil
		}
		v := strings.TrimSpace(*p)
		if oneLine {
			v = strings.Join(strings.Fields(v), " ")
		}
		v = truncRunes(v, n)
		return &v
	}
	f.Title = capped(b.Title, topicsTitleLen, true)
	f.Summary = capped(b.Summary, topicsSummaryLen, true)
	f.Detail = capped(b.Detail, topicsDetailLen, false)
	if b.Status != nil && strings.TrimSpace(*b.Status) != "" {
		st, ok := store.NormalizeTopicStatus(*b.Status)
		if !ok {
			return f, "status must be in_progress, waiting_on_you or done"
		}
		f.Status = &st
	}
	steps := b.Steps
	if steps == nil {
		steps = b.Tasks
	}
	if steps != nil {
		if len(*steps) > topicsMaxTasks {
			return f, "at most " + strconv.Itoa(topicsMaxTasks) + " steps"
		}
		out := make([]store.TopicTask, 0, len(*steps))
		for _, k := range *steps {
			out = append(out, store.TopicTask{Text: truncRunes(strings.Join(strings.Fields(k.Text), " "), topicsTaskLen), Done: k.Done})
		}
		cur = out
		f.Tasks = &out
	}
	if len(b.CheckSteps)+len(b.UncheckSteps) > 0 {
		next := append([]store.TopicTask{}, cur...)
		for _, set := range []struct {
			nums []int
			done bool
		}{{b.CheckSteps, true}, {b.UncheckSteps, false}} {
			for _, n := range set.nums {
				if n < 1 || n > len(next) {
					return f, "no step " + strconv.Itoa(n) + " (the task has " + strconv.Itoa(len(next)) + " steps, numbered from 1)"
				}
				next[n-1].Done = set.done
			}
		}
		f.Tasks = &next
	}
	if len(b.MessageIDs) > topicsMaxMsgIDs {
		return f, "at most " + strconv.Itoa(topicsMaxMsgIDs) + " message_ids"
	}
	for _, id := range b.MessageIDs {
		if id = strings.TrimSpace(id); id != "" {
			f.AddMessageIDs = append(f.AddMessageIDs, id)
		}
	}
	return f, ""
}

// agentThread is the thread a task call is about: thread_id when given (it must be one of the
// caller's session), else the session's live thread with the newest activity.
func (s *Server) agentThread(w http.ResponseWriter, r *http.Request, sess *store.Session, id string) (*store.Thread, bool) {
	ctx := r.Context()
	if id = strings.TrimSpace(id); id != "" {
		th, err := s.store.GetThread(ctx, id)
		if errors.Is(err, store.ErrNotFound) || (err == nil && th.SessionID != sess.ID) {
			httpError(w, 404, "no thread "+id+" in this session (pass the thread_id of a thread of yours)")
			return nil, false
		}
		if err != nil {
			storeError(w, err)
			return nil, false
		}
		return th, true
	}
	ths, err := s.store.ListThreads(ctx, sess.ID)
	if err != nil {
		storeError(w, err)
		return nil, false
	}
	var best *store.Thread
	for i := range ths {
		if ths[i].ArchivedAt == nil && (best == nil || ths[i].UpdatedAt.After(best.UpdatedAt)) {
			best = &ths[i]
		}
	}
	if best == nil {
		httpError(w, 400, "this session has no thread yet: send a message first (send_message), then pass its thread_id")
		return nil, false
	}
	return best, true
}

// agentTask is the task id names when it belongs to a thread of the caller's session.
func (s *Server) agentTask(w http.ResponseWriter, r *http.Request, sess *store.Session, id string) (*store.Topic, bool) {
	t, err := s.store.GetTopic(r.Context(), id)
	if errors.Is(err, store.ErrNotFound) || (err == nil && t.SessionID != sess.ID) {
		httpError(w, 404, "no task "+id+" in this session's threads (list_tasks lists them)")
		return nil, false
	}
	if err != nil {
		storeError(w, err)
		return nil, false
	}
	return t, true
}

func taskError(w http.ResponseWriter, err error) {
	if errors.Is(err, store.ErrTopicTitle) || errors.Is(err, store.ErrInvalidTopicStatus) {
		httpError(w, 400, err.Error())
		return
	}
	storeError(w, err)
}

// POST /api/agent/tasks {thread_id?, title, summary?, detail?, status?, steps?, message_ids?}: the
// agent adds a task to one of its threads. Without message_ids the thread's newest message is
// linked (the request it is working on).
func (s *Server) agentCreateTask(w http.ResponseWriter, r *http.Request, sess *store.Session) {
	var b taskBody
	if !decode(w, r, &b) {
		return
	}
	if b.Title == nil || strings.TrimSpace(*b.Title) == "" {
		httpError(w, 400, "title is required")
		return
	}
	f, msg := b.fields(nil)
	if msg != "" {
		httpError(w, 400, msg)
		return
	}
	th, ok := s.agentThread(w, r, sess, b.ThreadID)
	if !ok {
		return
	}
	cur, err := s.store.ThreadTopics(r.Context(), th.ID)
	if err != nil {
		storeError(w, err)
		return
	}
	if len(cur) >= topicsPerThread {
		httpError(w, 400, "this thread has "+strconv.Itoa(len(cur))+" tasks already: update one instead")
		return
	}
	if len(f.AddMessageIDs) == 0 {
		if id, err := s.store.LatestMessageID(r.Context(), th.ID); err == nil && id != "" {
			f.AddMessageIDs = []string{id}
		}
	}
	t, err := s.store.CreateTopic(r.Context(), th.ID, f)
	if err != nil {
		taskError(w, err)
		return
	}
	s.modLog(sess.ID, "task-create", "thread=%q task=%q status=%s (%d characters)", th.ID, t.ID, t.Status, utf8.RuneCountInString(t.Title))
	s.hub.publish(Event{Type: "topics", SessionID: sess.ID, ThreadID: th.ID})
	writeJSON(w, 200, t)
}

// PATCH /api/agent/tasks/{id} {title?, summary?, detail?, status?, steps?, check_steps?,
// uncheck_steps?, message_ids?}: the agent updates one of its tasks.
func (s *Server) agentUpdateTask(w http.ResponseWriter, r *http.Request, sess *store.Session) {
	var b taskBody
	if !decode(w, r, &b) {
		return
	}
	cur, ok := s.agentTask(w, r, sess, r.PathValue("id"))
	if !ok {
		return
	}
	if b.ThreadID != "" && b.ThreadID != cur.ThreadID {
		httpError(w, 400, "task "+cur.ID+" belongs to thread "+cur.ThreadID+", not "+b.ThreadID)
		return
	}
	f, msg := b.fields(cur.Tasks)
	if msg != "" {
		httpError(w, 400, msg)
		return
	}
	t, err := s.store.UpdateTopic(r.Context(), cur.ID, f)
	if err != nil {
		taskError(w, err)
		return
	}
	s.modLog(sess.ID, "task-update", "thread=%q task=%q status=%s", t.ThreadID, t.ID, t.Status)
	s.hub.publish(Event{Type: "topics", SessionID: sess.ID, ThreadID: t.ThreadID})
	writeJSON(w, 200, t)
}

// GET /api/agent/tasks?thread_id=<id>: the tasks of the caller's session (its threads that have some), or
// of one of its threads; done ones included, by thread (newest activity first), then in their order.
func (s *Server) agentListTasks(w http.ResponseWriter, r *http.Request, sess *store.Session) {
	ctx := r.Context()
	var ths []store.Thread
	if id := r.URL.Query().Get("thread_id"); id != "" {
		th, ok := s.agentThread(w, r, sess, id)
		if !ok {
			return
		}
		ths = []store.Thread{*th}
	} else {
		all, err := s.store.ListThreads(ctx, sess.ID)
		if err != nil {
			storeError(w, err)
			return
		}
		for _, th := range all {
			if th.ArchivedAt == nil {
				ths = append(ths, th)
			}
		}
		sort.SliceStable(ths, func(i, j int) bool { return ths[i].UpdatedAt.After(ths[j].UpdatedAt) })
	}
	type thread struct {
		ID      string        `json:"id"`
		Subject string        `json:"subject"`
		Tasks   []store.Topic `json:"tasks"`
	}
	out := []thread{}
	for _, th := range ths {
		ts, err := s.store.ThreadTopics(ctx, th.ID)
		if err != nil {
			storeError(w, err)
			return
		}
		if len(ts) > 0 || r.URL.Query().Get("thread_id") != "" {
			out = append(out, thread{ID: th.ID, Subject: firstNonEmpty(th.Name, th.Subject), Tasks: ts})
		}
	}
	writeJSON(w, 200, map[string]any{"threads": out})
}

// ---- the web API ----

// PATCH /api/topics/{id} {status}: the person moves a topic to another column by hand (marked as a
// manual move until the agent sets the status again).
func (s *Server) patchTopic(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Status string `json:"status"`
	}
	if !decode(w, r, &body) {
		return
	}
	t, err := s.store.SetTopicStatus(r.Context(), r.PathValue("id"), body.Status)
	if errors.Is(err, store.ErrInvalidTopicStatus) {
		httpError(w, 400, err.Error())
		return
	}
	if err != nil {
		storeError(w, err)
		return
	}
	s.hub.publish(Event{Type: "topics", SessionID: t.SessionID, ThreadID: t.ThreadID})
	writeJSON(w, 200, t)
}

// GET /api/topics/{id}: one topic (as the list gives it) and its related messages, oldest first,
// each with an excerpt (the topic pane).
func (s *Server) getTopic(w http.ResponseWriter, r *http.Request) {
	t, err := s.store.GetTopic(r.Context(), r.PathValue("id"))
	if err != nil {
		storeError(w, err)
		return
	}
	ms, err := s.store.TopicMessages(r.Context(), t.ThreadID, t.MessageIDs)
	if err != nil {
		storeError(w, err)
		return
	}
	type msg struct {
		ID        string    `json:"id"`
		Author    string    `json:"author"`
		Kind      string    `json:"kind"`
		CreatedAt time.Time `json:"created_at"`
		Excerpt   string    `json:"excerpt"`
	}
	out := make([]msg, 0, len(ms))
	for _, m := range ms {
		out = append(out, msg{ID: m.ID, Author: m.Author, Kind: m.Kind, CreatedAt: m.CreatedAt, Excerpt: truncRunes(strings.Join(strings.Fields(withoutTaskContext(m.Text)), " "), topicsExcerptLen)})
	}
	writeJSON(w, 200, map[string]any{"topic": t, "messages": out})
}

// GET /api/topics?project=<id>&thread=<id>: the topics of every live thread (of one project, or of
// one thread), open ones by last change, then the done ones of the last week (newest first, capped).
func (s *Server) listTopics(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	project := q.Get("project")
	if project == "" {
		project = q.Get("project_id")
	}
	ts, err := s.store.ListTopics(r.Context(), store.TopicQuery{ProjectID: project, ThreadID: q.Get("thread"), DoneSince: time.Now().Add(-topicsDoneWindow), DoneLimit: topicsDoneLimit})
	if err != nil {
		storeError(w, err)
		return
	}
	writeJSON(w, 200, map[string]any{"topics": ts, "done_days": int(topicsDoneWindow / (24 * time.Hour))})
}

// withoutTaskContext drops the quoted task context a message sent from a task's pane carries after
// its "[Task: <title>]" line (web/src/lib/taskContext.ts), so its excerpt shows the person's text.
func withoutTaskContext(text string) string {
	lines := strings.Split(text, "\n")
	if len(lines) < 2 || !strings.HasPrefix(lines[0], "[Task: ") || !strings.HasPrefix(lines[1], "> Task context (from minbox): ") {
		return text
	}
	i := 1
	for i < len(lines) && strings.HasPrefix(lines[i], "> ") {
		i++
	}
	return lines[0] + "\n" + strings.Join(lines[i:], "\n")
}
