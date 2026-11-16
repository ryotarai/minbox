package server

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/ryotarai/minbox/internal/agent"
	"github.com/ryotarai/minbox/internal/store"
)

// Topics: the pieces of work each thread is about, read from its messages by the helper model
// (Haiku, or the default agent's helper run; see helperPlan) and shown on the Topics board across
// threads. A thread's topics are extracted again a few seconds after each new message in it (bursts
// coalesce, one run per thread at a time); existing threads are never extracted until they get a
// new message. The topics setting (Settings › Capabilities) turns it off. See docs/api-contract.md
// ("Topics").

const (
	topicsDebounce   = 4 * time.Second  // quiet time after a message before the run
	topicsMaxDelay   = 30 * time.Second // a steady stream of messages still runs this often
	topicsRunTimeout = 90 * time.Second
	topicsParallel   = 2
	topicsMaxTopics  = 6
	topicsMsgBudget  = 12000 // runes of messages in the prompt, newest first
	topicsMsgLen     = 1500  // runes per message
	topicsTitleLen   = 80
	topicsSummaryLen = 160
	// The board's Done column: topics done within this long, at most topicsDoneLimit of them.
	topicsDoneWindow = 7 * 24 * time.Hour
	topicsDoneLimit  = 30
)

const topicsSystemPrompt = "You track the topics of a conversation between a person and their coding agent for a kanban board. Output only JSON matching the schema."

const topicsSchema = `{"type":"object","properties":{` +
	`"topics":{"type":"array","minItems":0,"maxItems":6,"items":{"type":"object","properties":{` +
	`"id":{"type":"string"},` +
	`"title":{"type":"string","maxLength":80},` +
	`"summary":{"type":"string","maxLength":160},` +
	`"status":{"type":"string","enum":["in_progress","waiting_on_you","done"]}},` +
	`"required":["title","summary","status"],"additionalProperties":false}}},` +
	`"required":["topics"],"additionalProperties":false}`

// ---- scheduling ----

// topicJob is one thread's pending or running extraction.
type topicJob struct {
	timer   *time.Timer
	gen     int       // the timer that may fire; older ones do nothing
	first   time.Time // the first message not yet extracted
	running bool
	dirty   bool // a message came while running: run again after
}

// topicer debounces the extraction per thread: kick after each message, run once things are quiet
// (at most maxDelay after the first kick), never twice at once for one thread, at most parallel
// threads at a time.
type topicer struct {
	run      func(threadID string) // replaced in tests
	debounce time.Duration
	maxDelay time.Duration
	now      func() time.Time

	mu     sync.Mutex
	jobs   map[string]*topicJob
	sem    chan struct{}
	closed bool
}

func newTopicer(run func(threadID string)) *topicer {
	return &topicer{run: run, debounce: topicsDebounce, maxDelay: topicsMaxDelay, now: time.Now, jobs: map[string]*topicJob{}, sem: make(chan struct{}, topicsParallel)}
}

// kick notes a new message in the thread.
func (g *topicer) kick(threadID string) {
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.closed {
		return
	}
	j := g.jobs[threadID]
	if j == nil {
		j = &topicJob{}
		g.jobs[threadID] = j
	}
	if j.running {
		j.dirty = true
		return
	}
	now := g.now()
	if j.timer == nil {
		j.first = now
	}
	delay := g.debounce
	if left := j.first.Add(g.maxDelay).Sub(now); left < delay {
		delay = max(left, 0)
	}
	g.schedule(threadID, j, delay)
}

// schedule (with g.mu held) replaces the job's timer.
func (g *topicer) schedule(threadID string, j *topicJob, delay time.Duration) {
	if j.timer != nil {
		j.timer.Stop()
	}
	j.gen++
	gen := j.gen
	j.timer = time.AfterFunc(delay, func() { g.fire(threadID, gen) })
}

func (g *topicer) fire(threadID string, gen int) {
	g.mu.Lock()
	j := g.jobs[threadID]
	if g.closed || j == nil || j.gen != gen || j.running {
		g.mu.Unlock()
		return
	}
	j.timer, j.running, j.dirty = nil, true, false
	g.mu.Unlock()

	g.sem <- struct{}{}
	func() {
		defer func() {
			if r := recover(); r != nil {
				log.Printf("topics: %s: panic: %v", threadID, r)
			}
		}()
		g.run(threadID)
	}()
	<-g.sem

	g.mu.Lock()
	defer g.mu.Unlock()
	j.running = false
	if j.dirty && !g.closed {
		j.dirty = false
		j.first = g.now()
		g.schedule(threadID, j, g.debounce)
		return
	}
	if g.jobs[threadID] == j && j.timer == nil {
		delete(g.jobs, threadID)
	}
}

// close stops the pending runs (a running one finishes).
func (g *topicer) close() {
	g.mu.Lock()
	defer g.mu.Unlock()
	g.closed = true
	for _, j := range g.jobs {
		if j.timer != nil {
			j.timer.Stop()
		}
	}
}

// ---- the extraction ----

// topicsOn: the topics setting (on unless turned off).
func (s *Server) topicsOn(ctx context.Context) bool {
	st, err := s.settings(ctx)
	if err != nil {
		return false
	}
	on, ok := st["topics"].(bool)
	return on || !ok
}

// refreshTopics extracts a thread's topics again and stores them; on any failure the thread keeps
// the topics it had.
func (s *Server) refreshTopics(threadID string) {
	ctx, cancel := context.WithTimeout(context.Background(), topicsRunTimeout)
	defer cancel()
	// A card the person moves from now on (while the helper runs) keeps its move: see ReplaceTopics.
	started := s.store.Now()
	if !s.topicsOn(ctx) {
		return
	}
	th, err := s.store.GetThread(ctx, threadID)
	if err != nil || th.ArchivedAt != nil || len(th.Messages) == 0 {
		return
	}
	cur, err := s.store.ThreadTopics(ctx, threadID)
	if err != nil {
		log.Printf("topics: %s: %v", threadID, err)
		return
	}
	out, err := s.topicsRun(ctx, buildTopicsPrompt(th, cur))
	if err != nil {
		if !errors.Is(err, agent.ErrNoneInstalled) {
			log.Printf("topics: %s: %v", threadID, err)
		}
		return
	}
	in, err := parseTopics(out)
	if err != nil {
		log.Printf("topics: %s: %v", threadID, err)
		return
	}
	// The thread may have been archived or turned off while the helper ran.
	if th2, err := s.store.GetThread(ctx, threadID); err != nil || th2.ArchivedAt != nil {
		return
	}
	changed, err := s.store.ReplaceTopics(ctx, threadID, in, started)
	if err != nil {
		log.Printf("topics: %s: %v", threadID, err)
		return
	}
	if changed {
		s.hub.publish(Event{Type: "topics", SessionID: th.SessionID, ThreadID: threadID})
	}
}

// runTopicsHelper runs the helper agent with the topics prompt.
func (s *Server) runTopicsHelper(ctx context.Context, prompt string) ([]byte, error) {
	return s.runHelper(ctx, "haiku", topicsSystemPrompt, topicsSchema, prompt)
}

// buildTopicsPrompt: the thread's current topics and its recent messages (newest kept within the
// budget), then the instruction. It starts with "Track the topics" (the e2e fake helper keys on it).
func buildTopicsPrompt(th *store.Thread, cur []store.Topic) string {
	var b strings.Builder
	b.WriteString("Track the topics of this conversation between a PERSON and their coding AGENT.\n")
	if name := firstNonEmpty(th.Name, th.Subject); name != "" {
		b.WriteString("Thread: " + truncRunes(name, 200) + "\n")
	}
	b.WriteString("\nCurrent topics (from the last update):\n")
	if len(cur) == 0 {
		b.WriteString("(none yet)\n")
	}
	manual := false
	for _, t := range cur {
		b.WriteString("- id: " + t.ID + " | status: " + t.Status + " | title: " + truncRunes(t.Title, topicsTitleLen) + " | summary: " + truncRunes(t.Summary, topicsSummaryLen))
		if t.ManualStatus != "" && t.ManualAt != nil {
			b.WriteString(" | moved by the PERSON by hand to " + t.ManualStatus + " at " + t.ManualAt.UTC().Format("2006-01-02 15:04") + " UTC")
			manual = true
		}
		b.WriteString("\n")
	}
	if manual {
		b.WriteString("A topic marked \"moved by the PERSON by hand\" has the status the person chose on the board: a strong signal. " +
			"Keep that status unless messages written after that time clearly show it is now in a different state.\n")
	}
	// The newest messages that fit, shown oldest first.
	var parts []string
	used := 0
	for i := len(th.Messages) - 1; i >= 0; i-- {
		m := th.Messages[i]
		who, body := "AGENT", m.Body
		if m.Author == store.AuthorUser {
			who = "PERSON"
			if m.Words != "" {
				body = m.Words
			}
			if m.Kind == store.KindCommand {
				who = "PERSON ran a command"
			}
		}
		text := truncRunes(strings.TrimSpace(body), topicsMsgLen)
		if i == len(th.Messages)-1 && m.Author == store.AuthorAgent {
			for _, q := range m.Questions {
				if _, answered := m.AnswerState[q.Key]; !answered {
					text += "\nOpen question to the person: " + truncRunes(q.Prompt, 300)
				}
			}
		}
		part := "[" + who + " · " + m.CreatedAt.UTC().Format("2006-01-02 15:04") + "]\n" + text + "\n"
		n := len([]rune(part))
		if used+n > topicsMsgBudget && len(parts) > 0 {
			break
		}
		used += n
		parts = append(parts, part)
	}
	b.WriteString("\nMessages (oldest first")
	if len(parts) < len(th.Messages) {
		b.WriteString("; earlier ones left out")
	}
	b.WriteString("):\n\n")
	for i := len(parts) - 1; i >= 0; i-- {
		b.WriteString(parts[i] + "\n")
	}
	b.WriteString("Task: list the topics of this thread for the person's board: the separate pieces of work or decisions it is about " +
		"(a feature, a bug, an investigation, a question to settle, a review), not individual messages or steps. " +
		"Usually 1 to 3, at most 6; fold small related items into one topic. For each topic give:\n" +
		"- title: a short name (2 to 8 words), in the language the PERSON writes in (if they wrote nothing, the agent's). Keep the current title when a topic continues.\n" +
		"- summary: one line (under 120 characters) saying where it stands now.\n" +
		"- status: \"waiting_on_you\" when the agent is waiting for the person's decision, answer, review or action on it; " +
		"\"done\" when it is finished, resolved or dropped; otherwise \"in_progress\" (the agent is working on it, or it is still open).\n" +
		"- id: the id of the current topic it continues; leave it out for a new topic.\n" +
		"Keep the current topics that still apply, including done ones, and update their status and summary from the newest messages. " +
		"Drop a current topic only when it was a mistake or became part of another.\n")
	return b.String()
}

// parseTopics reads the helper's answer (the envelope parseSuggestions reads): topics with a title
// and a known status, deduplicated by title, lengths and count capped.
func parseTopics(out []byte) ([]store.TopicInput, error) {
	var env struct {
		IsError          bool            `json:"is_error"`
		Subtype          string          `json:"subtype"`
		Result           string          `json:"result"`
		StructuredOutput json.RawMessage `json:"structured_output"`
	}
	if err := json.Unmarshal(bytes.TrimSpace(out), &env); err != nil {
		return nil, errors.New("the helper printed no JSON")
	}
	if env.IsError {
		return nil, errors.New("the helper reported an error: " + truncRunes(firstNonEmpty(env.Result, env.Subtype), 120))
	}
	raw := []byte(env.StructuredOutput)
	if len(raw) == 0 || string(raw) == "null" {
		raw = []byte(strings.TrimSpace(env.Result))
		// A model without structured output may fence its JSON.
		if s := string(raw); strings.HasPrefix(s, "```") {
			s = strings.TrimPrefix(strings.TrimPrefix(s, "```json"), "```")
			raw = []byte(strings.TrimSpace(strings.TrimSuffix(strings.TrimSpace(s), "```")))
		}
	}
	var body struct {
		Topics []json.RawMessage `json:"topics"`
	}
	if err := json.Unmarshal(raw, &body); err != nil || body.Topics == nil {
		return nil, errors.New("the helper's answer was not the expected JSON")
	}
	res := []store.TopicInput{}
	seen := map[string]bool{}
	for _, rt := range body.Topics {
		var t struct {
			ID      string `json:"id"`
			Title   string `json:"title"`
			Summary string `json:"summary"`
			Status  string `json:"status"`
		}
		if json.Unmarshal(rt, &t) != nil {
			continue
		}
		title := strings.Join(strings.Fields(t.Title), " ")
		status, ok := store.NormalizeTopicStatus(t.Status)
		if title == "" || !ok || seen[strings.ToLower(title)] {
			continue
		}
		seen[strings.ToLower(title)] = true
		res = append(res, store.TopicInput{
			ID:      strings.TrimSpace(t.ID),
			Title:   truncRunes(title, topicsTitleLen),
			Summary: truncRunes(strings.Join(strings.Fields(t.Summary), " "), topicsSummaryLen),
			Status:  status,
		})
		if len(res) == topicsMaxTopics {
			break
		}
	}
	return res, nil
}

// ---- API ----

// PATCH /api/topics/{id} {status}: the person moves a topic to another column by hand. The status
// holds until the thread's next extraction, which is told about the move (see buildTopicsPrompt).
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

// GET /api/topics?project=<id>: the topics of every live thread (of one project), open ones by last
// change, then the done ones of the last week (newest first, capped).
func (s *Server) listTopics(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	project := q.Get("project")
	if project == "" {
		project = q.Get("project_id")
	}
	ts, err := s.store.ListTopics(r.Context(), store.TopicQuery{ProjectID: project, DoneSince: time.Now().Add(-topicsDoneWindow), DoneLimit: topicsDoneLimit})
	if err != nil {
		storeError(w, err)
		return
	}
	writeJSON(w, 200, map[string]any{"topics": ts, "enabled": s.topicsOn(r.Context()), "done_days": int(topicsDoneWindow / (24 * time.Hour))})
}
