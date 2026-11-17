package server

import (
	"errors"
	"net/http"
	"strings"
	"time"

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
