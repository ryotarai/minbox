package server

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"strconv"
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
// new message. It also runs again when the agent's turn ends (the session goes idle) for the
// session's threads with a topic in progress, and when the person marks a thread finished, so work
// that ended leaves In progress without a new message. The topics setting (Settings ›
// Capabilities) turns it off. See docs/api-contract.md ("Topics").

const (
	topicsDebounce   = 4 * time.Second  // quiet time after a message before the run
	topicsMaxDelay   = 30 * time.Second // a steady stream of messages still runs this often
	topicsRunTimeout = 5 * time.Minute  // 20 whole messages can make a long prompt, and the answer many topics
	topicsParallel   = 2
	// No product limit on the number of topics: every separate subject is one. This only guards
	// against a runaway answer.
	topicsMaxTopics = 100
	// The newest messages of the thread, each in full (the current topics carry what came before).
	topicsMsgCount   = 20
	topicsTitleLen   = 80
	topicsSummaryLen = 160
	// The topic pane: the fuller summary, its steps, the related messages of one answer.
	topicsDetailLen    = 1200
	topicsMaxTasks     = 20
	topicsTaskLen      = 200
	topicsMaxMsgIDs    = 50
	topicsExcerptLen   = 240
	topicsPromptDetail = 600 // the current topic's detail, in the prompt
	// The board's Done column: topics done within this long, at most topicsDoneLimit of them.
	topicsDoneWindow = 7 * 24 * time.Hour
	topicsDoneLimit  = 30
)

const topicsSystemPrompt = "You track the topics of a conversation between a person and their coding agent for a kanban board. Output only JSON matching the schema."

const topicsSchema = `{"type":"object","properties":{` +
	`"topics":{"type":"array","minItems":0,"items":{"type":"object","properties":{` +
	`"id":{"type":"string"},` +
	`"title":{"type":"string","maxLength":80},` +
	`"summary":{"type":"string","maxLength":160},` +
	`"status":{"type":"string","enum":["in_progress","waiting_on_you","done"]},` +
	`"detail":{"type":"string","maxLength":1200},` +
	`"tasks":{"type":"array","items":{"type":"object","properties":{` +
	`"text":{"type":"string","maxLength":200},"done":{"type":"boolean"}},` +
	`"required":["text","done"],"additionalProperties":false}},` +
	`"message_ids":{"type":"array","items":{"type":"string"}}},` +
	`"required":["title","summary","status","detail","tasks","message_ids"],"additionalProperties":false}}},` +
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
	out, err := s.topicsRun(ctx, buildTopicsPrompt(th, cur, s.topicsAgentState(ctx, th.SessionID)))
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
	// Related messages: only ids of the history the helper was shown (ReplaceTopics also checks
	// them against the thread, and adds them to the ones the topic has).
	shown := map[string]bool{}
	for _, m := range th.Messages[max(0, len(th.Messages)-topicsMsgCount):] {
		shown[m.ID] = true
	}
	for i := range in {
		ids := in[i].MessageIDs[:0]
		for _, id := range in[i].MessageIDs {
			if shown[id] {
				ids = append(ids, id)
			}
		}
		in[i].MessageIDs = ids
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

// topicsOnIdle: the session's agent finished its turn. Its threads with a topic still in progress
// are extracted again (debounced like a message), so finished work leaves In progress. This cannot
// loop: an extraction adds no message and changes no session or thread status.
func (s *Server) topicsOnIdle(sessionID string) {
	ids, err := s.store.ThreadsWithTopicStatus(context.Background(), sessionID, store.TopicInProgress)
	if err != nil {
		log.Printf("topics: session %s: %v", sessionID, err)
		return
	}
	for _, id := range ids {
		s.topics.kick(id)
	}
}

// topicsOnFinished: the person marked the thread finished; extract it again when a topic is still
// in progress.
func (s *Server) topicsOnFinished(ctx context.Context, threadID string) {
	cur, err := s.store.ThreadTopics(ctx, threadID)
	if err != nil {
		return
	}
	for _, t := range cur {
		if t.Status == store.TopicInProgress {
			s.topics.kick(threadID)
			return
		}
	}
}

// topicsAgent is what the topics prompt says about the agent now.
type topicsAgent struct {
	State string    // the session's status: working, idle, starting, ended ("" unknown)
	Since time.Time // when State began, as this server saw it (zero: unknown)
}

// topicsAgentState: the session's stored status (the mod reports working / idle at each turn's
// start and end: POST /api/agent/status) and when it last changed (agentSince).
func (s *Server) topicsAgentState(ctx context.Context, sessionID string) topicsAgent {
	var a topicsAgent
	sess, err := s.store.GetSession(ctx, sessionID)
	if err != nil {
		return a
	}
	a.State = sess.Status
	if sess.Status == store.StatusEnded {
		a.Since = sess.UpdatedAt
	} else if v, ok := s.agentSince.Load(sessionID); ok {
		a.Since = v.(time.Time)
	}
	return a
}

// runTopicsHelper runs the helper agent with the topics prompt.
func (s *Server) runTopicsHelper(ctx context.Context, prompt string) ([]byte, error) {
	return s.runHelper(ctx, "haiku", topicsSystemPrompt, topicsSchema, prompt)
}

// buildTopicsPrompt: the thread's current topics, the agent's state now and the thread's newest
// messages (in full), then the instruction with the status rules. It starts with "Track the
// topics" (the e2e fake helper keys on it).
func buildTopicsPrompt(th *store.Thread, cur []store.Topic, ag topicsAgent) string {
	var b strings.Builder
	b.WriteString("Track the topics of this conversation between a PERSON and their coding AGENT.\n")
	if name := firstNonEmpty(th.Name, th.Subject); name != "" {
		b.WriteString("Thread: " + truncRunes(name, 200) + "\n")
	}
	// The agent's state now: whether anything can still be in progress.
	state := ag.State
	switch state {
	case store.StatusWorking:
		state = "working (running a turn now; possibly for another thread of the same session)"
	case store.StatusIdle:
		state = "idle (its turn ended; it is waiting for the person)"
	case store.StatusStarting:
		state = "idle (starting up)"
	case store.StatusEnded:
		state = "idle (the session has ended)"
	case "":
		state = "unknown"
	}
	b.WriteString("Agent state now: " + state)
	if !ag.Since.IsZero() {
		b.WriteString(" since " + ag.Since.UTC().Format("2006-01-02 15:04") + " UTC")
	}
	b.WriteString("\n")
	if th.Status != "" {
		b.WriteString("Thread status now: " + th.Status + " (set by the agent or the person: working | need_action | blocked | finished)\n")
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
		if d := strings.Join(strings.Fields(t.Detail), " "); d != "" {
			b.WriteString("  detail: " + truncRunes(d, topicsPromptDetail) + "\n")
		}
		for _, k := range t.Tasks {
			box := "[ ]"
			if k.Done {
				box = "[x]"
			}
			b.WriteString("  task " + box + " " + truncRunes(k.Text, topicsTaskLen) + "\n")
		}
	}
	if manual {
		b.WriteString("A topic marked \"moved by the PERSON by hand\" has the status the person chose on the board: a strong signal. " +
			"Keep that status. Change it only when messages written after that time are about that topic and clearly show it is now in a different state " +
			"(for a topic moved to done: only when new work or a new problem on it clearly appears in those messages); " +
			"then include the ids of those newer messages in its message_ids. With no such newer message about it, keep the status the person chose.\n")
	}
	// The newest topicsMsgCount messages, in full, oldest first.
	label := func(m store.Message) (string, string) {
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
		return "[" + who + " · " + m.CreatedAt.UTC().Format("2006-01-02 15:04") + " · id: " + m.ID + "]", strings.TrimSpace(body)
	}
	start := max(0, len(th.Messages)-topicsMsgCount)
	b.WriteString("\nMessages (oldest first")
	if start > 0 {
		b.WriteString("; only the newest " + strconv.Itoa(topicsMsgCount) + ", the earlier ones are behind the current topics above")
	}
	b.WriteString("):\n\n")
	for i := start; i < len(th.Messages); i++ {
		m := th.Messages[i]
		head, text := label(m)
		if i == len(th.Messages)-1 && m.Author == store.AuthorAgent {
			for _, q := range m.Questions {
				if _, answered := m.AnswerState[q.Key]; !answered {
					text += "\nOpen question to the person: " + q.Prompt
				}
			}
		}
		b.WriteString(head + "\n" + text + "\n\n")
	}
	b.WriteString("Task: list the topics of this thread for the person's board. " +
		"Every distinct subject, request, question, decision or piece of work in the thread is its own topic " +
		"(a feature, a bug, an investigation, a question to settle, a review). " +
		"Each separate request or question the PERSON made is its own topic: do not merge unrelated ones into one. " +
		"Merge only true duplicates, or a later message that continues the same request. " +
		"A request or question that is already finished or answered is still a topic, with status \"done\". " +
		"There is no limit on the number of topics. Individual steps of one piece of work are not topics. For each topic give:\n" +
		"- title: a short name (2 to 8 words), in the language the PERSON writes in (if they wrote nothing, the agent's). Keep the current title when a topic continues.\n" +
		"- summary: one line (under 120 characters) saying where it stands now.\n" +
		"- status: \"in_progress\", \"waiting_on_you\" or \"done\"; see the status rules below.\n" +
		"- id: the id of the current topic it continues; leave it out for a new topic.\n" +
		"- detail: a fuller summary for the topic's pane: a few sentences (Markdown allowed) on what it is about, what was decided or done, and what is left. Update the current detail; do not start over.\n" +
		"- tasks: the concrete steps or sub-tasks of the topic (short, imperative; usually 0 to 8), each with done true when the messages show it finished. " +
		"Keep the current tasks and their order and wording (mark them done as they finish; add new ones at the end); an empty list when the topic has no separate steps.\n" +
		"- message_ids: the ids (from the message headers above) of the messages that are about this topic; an empty list when none of the messages above is.\n" +
		"Keep the current topics, including done ones (with status \"done\"; do not drop a topic because it is finished), " +
		"and update their status and summary from the newest messages. " +
		"Drop a current topic only when it was a mistake or became part of another.\n" +
		topicsStatusRules)
	return b.String()
}

// topicsStatusRules: how the helper picks a topic's status (the board's columns). In progress is
// only for work the agent is doing right now; waiting on you only for what is blocked on the person
// (an open question to decide, an action only they can take); anything else is done.
const topicsStatusRules = "\nStatus rules (judge every topic again, current ones included, from the newest messages and the agent state now; " +
	"never keep \"in_progress\" just because a topic was in progress before):\n" +
	"- \"in_progress\" ONLY when the agent is actively working on it right now: the latest messages about it show the agent " +
	"started or continues the work (e.g. \"implementing…\", \"investigating…\", a subagent running) and has not yet reported the result, " +
	"AND the agent state now is working.\n" +
	"- \"waiting_on_you\" ONLY when progress on it is blocked on the PERSON, with that request still unanswered: " +
	"a question asking them to choose, decide or answer (e.g. a :::question block, or an explicit question that needs their decision); " +
	"or a request that they act themselves (log in, approve, run or test something themselves, e.g. on a real device, " +
	"provide credentials or information); or the agent explicitly says it is stopped, waiting for their reply.\n" +
	"- NOT \"waiting_on_you\" (these are \"done\", unless the agent is actively working on it): a plain report of finished work; " +
	"boilerplate offers such as \"let me know if…\", \"tell me if anything is off\", \"any feedback welcome\"; " +
	"optional suggestions or \"you may want to check…\" that block nothing; FYI notes; a list of unverified points in a finished report.\n" +
	"- \"done\" when the result was reported or delivered (e.g. \"pushed\", \"fixed\", \"here is the answer\"), " +
	"or the topic has no pending work, or it went quiet with nobody working on it. A question that was answered is done.\n" +
	"- When unsure between \"in_progress\" and \"done\", choose \"done\". " +
	"When unsure between \"waiting_on_you\" and \"done\", choose \"done\".\n" +
	"- When the agent state now is idle, no topic can be \"in_progress\", unless the latest message clearly says work continues " +
	"in the background (e.g. a subagent still running), and then only that specific topic.\n" +
	"- When the thread status now is finished, the agent reported its work done: no topic is \"in_progress\" unless a later message clearly starts new work.\n" +
	"- A current topic that is \"done\" stays \"done\" unless a message written after it was done is about it and clearly shows new work or a new problem on it; " +
	"then include that message's id in its message_ids. No new message about it, no change.\n"

// parseTopics reads the helper's answer (the envelope parseSuggestions reads): topics with a title
// and a known status, deduplicated by title, lengths capped (and the count, only against a runaway
// answer: topicsMaxTopics).
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
			ID         string            `json:"id"`
			Title      string            `json:"title"`
			Summary    string            `json:"summary"`
			Status     string            `json:"status"`
			Detail     string            `json:"detail"`
			Tasks      []json.RawMessage `json:"tasks"`
			MessageIDs []any             `json:"message_ids"`
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
		in := store.TopicInput{
			ID:         strings.TrimSpace(t.ID),
			Title:      truncRunes(title, topicsTitleLen),
			Summary:    truncRunes(strings.Join(strings.Fields(t.Summary), " "), topicsSummaryLen),
			Status:     status,
			Detail:     truncRunes(strings.TrimSpace(t.Detail), topicsDetailLen),
			Tasks:      []store.TopicTask{},
			MessageIDs: []string{},
		}
		for _, rk := range t.Tasks {
			var k store.TopicTask
			if json.Unmarshal(rk, &k) != nil {
				continue
			}
			if text := strings.Join(strings.Fields(k.Text), " "); text != "" && len(in.Tasks) < topicsMaxTasks {
				in.Tasks = append(in.Tasks, store.TopicTask{Text: truncRunes(text, topicsTaskLen), Done: k.Done})
			}
		}
		for _, v := range t.MessageIDs {
			if id, ok := v.(string); ok && strings.TrimSpace(id) != "" && len(in.MessageIDs) < topicsMaxMsgIDs {
				in.MessageIDs = append(in.MessageIDs, strings.TrimSpace(id))
			}
		}
		res = append(res, in)
		if len(res) == topicsMaxTopics {
			break
		}
	}
	return res, nil
}

// ---- API ----

// PATCH /api/topics/{id} {status}: the person moves a topic to another column by hand. The status
// holds until an extraction finds new information about the topic (see store.ReplaceTopics).
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
	writeJSON(w, 200, map[string]any{"topics": ts, "enabled": s.topicsOn(r.Context()), "done_days": int(topicsDoneWindow / (24 * time.Hour))})
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
