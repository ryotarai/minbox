package server

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/ryotarai/minbox/internal/store"
)

// The v3 agent contract (docs/v3/redesign.md §4.5, §7): the agent talks in its stream, and decides for
// the person's messages of a turn which task they are about: an existing one (send_message task_ids)
// or new work (create_task). Every message is about a task: what a turn leaves in none, minbox asks the
// agent to place (v3place.go). The server applies the decision to the turn's untagged messages of the
// person, tags the reply, and records the decision on the reply (shown under it).

// turnState is what the server remembers of a session's current turn: the person's messages it
// answers (Key: the newest one's id), the tasks the agent created in it, and whether a reply already
// carried the turn's decision.
type turnState struct {
	Key     string
	Created []string
	Decided bool
}

type turns struct {
	mu sync.Mutex
	m  map[string]*turnState
}

var v3Turns = &turns{m: map[string]*turnState{}}

// get returns the session's turn state for the turn whose person's messages are cand (a new turn
// when they changed).
func (t *turns) get(sessionID string, cand []string) *turnState {
	t.mu.Lock()
	defer t.mu.Unlock()
	key := ""
	if len(cand) > 0 {
		key = cand[len(cand)-1]
	}
	st := t.m[sessionID]
	if st == nil || (key != "" && st.Key != key) {
		st = &turnState{Key: key}
		t.m[sessionID] = st
	}
	return st
}

func (t *turns) end(sessionID string) {
	t.mu.Lock()
	defer t.mu.Unlock()
	delete(t.m, sessionID)
}

// sameProjectTasks checks task ids: each must be a task of the session's project.
func (s *Server) sameProjectTasks(ctx context.Context, sess *store.Session, ids []string) ([]string, string) {
	out := []string{}
	seen := map[string]bool{}
	for _, id := range ids {
		id = strings.TrimSpace(id)
		if id == "" || seen[id] {
			continue
		}
		seen[id] = true
		t, err := s.store.GetTask(ctx, id)
		if err != nil || (t.ProjectID != "" && t.ProjectID != sess.ProjectID) {
			return nil, "no task " + id + " in this project (list_tasks lists them; create_task makes one)"
		}
		out = append(out, id)
	}
	return out, ""
}

// untaggedOf is the messages among ids that have no tag.
func (s *Server) untaggedOf(ctx context.Context, ids []string) ([]string, map[string][]store.TaskRef) {
	tags, _ := s.store.TasksOf(ctx, ids)
	out := []string{}
	for _, id := range ids {
		if len(tags[id]) == 0 {
			out = append(out, id)
		}
	}
	return out, tags
}

// v3AgentReply runs after an agent message was stored: it tags the message and the turn's person's
// messages, records the decision, applies status to the named tasks. It returns the tasks the
// reply is tagged with and the decision ("" when the reply carries none).
func (s *Server) v3AgentReply(ctx context.Context, sess *store.Session, messageID string, taskIDs []string, status string) ([]string, string) {
	cand, _ := s.store.TurnMessages(ctx, sess.ID)
	st := v3Turns.get(sess.ID, cand)
	untagged, tags := s.untaggedOf(ctx, cand)
	inherited := []string{}
	seen := map[string]bool{}
	for _, id := range cand {
		for _, tg := range tags[id] {
			if !seen[tg.TaskID] && tg.Status != "" {
				seen[tg.TaskID] = true
				inherited = append(inherited, tg.TaskID)
			}
		}
	}
	named := append(append([]string{}, taskIDs...), st.Created...)
	all := []string{}
	have := map[string]bool{}
	for _, id := range named {
		if !have[id] {
			have[id] = true
			all = append(all, id)
			_, _ = s.store.LinkMessages(ctx, id, []string{messageID}, store.LinkAgent)
			_, _ = s.store.LinkMessages(ctx, id, untagged, store.LinkAgent)
		}
	}
	for _, id := range inherited {
		if !have[id] {
			have[id] = true
			all = append(all, id)
			_, _ = s.store.LinkMessages(ctx, id, []string{messageID}, store.LinkAuto)
		}
	}
	for _, id := range all {
		_, _ = s.store.AddTaskAgent(ctx, id, sess.ID, store.RoleInvolved)
	}
	// Status (the legacy send_message status) applies to the tasks the agent named.
	if status != "" {
		if ts, ok := store.NormalizeTaskStatus(status); ok {
			for _, id := range named {
				if t, err := s.store.GetTask(ctx, id); err == nil && t.Status != ts {
					_, _ = s.store.UpdateTask(ctx, id, sess.ID, store.TaskFields{Status: &ts})
				}
			}
		}
	}
	decision := ""
	if len(cand) > 0 && !st.Decided {
		st.Decided = true
		task := ""
		switch {
		case len(st.Created) > 0:
			decision, task = store.DecisionCreated, st.Created[0]
		case len(taskIDs) > 0:
			decision, task = store.DecisionExisting, taskIDs[0]
		case len(inherited) > 0:
			decision, task = store.DecisionExisting, inherited[0]
		default:
			decision = store.DecisionNone
		}
		_ = s.store.SetDecision(ctx, messageID, decision, task, cand)
	}
	s.settlePlaceRequests(ctx, sess.ID)
	if len(all) > 0 || decision != "" {
		s.publishTasks()
	}
	return all, decision
}

// v3TagPersonMessage tags the person's new message: the tasks of the view they wrote from, and, for
// answers, the tasks of the message they answer. A done task they write to is open again.
func (s *Server) v3TagPersonMessage(ctx context.Context, sessionID, messageID string, taskIDs []string, answersFor string) {
	changed := false
	for _, id := range taskIDs {
		t, err := s.store.GetTask(ctx, id)
		if err != nil {
			continue
		}
		if added, _ := s.store.LinkMessages(ctx, id, []string{messageID}, store.LinkPerson); len(added) > 0 {
			changed = true
		}
		if isNew, _ := s.store.AddTaskAgent(ctx, id, sessionID, store.RoleAssigned); isNew && len(t.Agents) > 0 {
			name := sessionID
			if sess, err := s.store.GetSession(ctx, sessionID); err == nil {
				name = sess.Name
			}
			_ = s.store.AddTaskEvent(ctx, id, "handoff", "Handed to "+name+" by you", sessionID, messageID)
		}
		if t.Status == store.TaskDone {
			w := store.TaskWorking
			_, _ = s.store.UpdateTask(ctx, id, sessionID, store.TaskFields{Status: &w})
			_ = s.store.AddTaskEvent(ctx, id, "status", "Reopened by your message", "", messageID)
		}
	}
	if answersFor != "" {
		tags, _ := s.store.TasksOf(ctx, []string{answersFor})
		for _, tg := range tags[answersFor] {
			if added, _ := s.store.LinkMessages(ctx, tg.TaskID, []string{messageID}, store.LinkAuto); len(added) > 0 {
				changed = true
				_ = s.store.AddTaskEvent(ctx, tg.TaskID, "answer", "You answered", "", messageID)
			}
		}
	}
	if changed {
		s.publishTasks()
	}
}

// ---- the agent's task tools ----

// v3TaskBody is what create_task and update_task send (the older fields included).
type v3TaskBody struct {
	ThreadID      string            `json:"thread_id"` // legacy: ignored
	Kind          string            `json:"kind"`      // "goal" for a goal
	GoalID        *string           `json:"goal_id"`
	ParentID      *string           `json:"parent_id"`
	Title         *string           `json:"title"`
	Summary       *string           `json:"summary"`
	Detail        *string           `json:"detail"`
	Status        *string           `json:"status"`
	Report        *string           `json:"report"`
	Steps         *[]store.TaskStep `json:"steps"`
	Tasks         *[]store.TaskStep `json:"tasks"` // an older name of steps
	CheckSteps    []int             `json:"check_steps"`
	UncheckSteps  []int             `json:"uncheck_steps"`
	Criteria      *[]store.TaskStep `json:"criteria"`
	CheckCriteria []int             `json:"check_criteria"`
	MessageIDs    []string          `json:"message_ids"`
	Links         *[]store.TaskLink `json:"links"`
	Autonomous    *bool             `json:"autonomous"`
	MaxTurns      int               `json:"max_turns"`
}

func (b *v3TaskBody) fields(cur *store.Task) (store.TaskFields, string) {
	var f store.TaskFields
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
	f.Report = capped(b.Report, topicsDetailLen, false)
	if b.Status != nil && strings.TrimSpace(*b.Status) != "" {
		st, ok := store.NormalizeTaskStatus(*b.Status)
		if !ok {
			return f, "status must be working, needs_you, blocked or done"
		}
		f.Status = &st
	}
	if b.GoalID != nil {
		f.ParentID = b.GoalID
	} else if b.ParentID != nil {
		f.ParentID = b.ParentID
	}
	steps := b.Steps
	if steps == nil {
		steps = b.Tasks
	}
	var curSteps, curCrit []store.TaskStep
	if cur != nil {
		curSteps, curCrit = cur.Steps, cur.Criteria
	}
	if steps != nil {
		if len(*steps) > topicsMaxTasks {
			return f, "at most " + strconv.Itoa(topicsMaxTasks) + " steps"
		}
		c := store.CleanSteps(*steps)
		curSteps, f.Steps = c, &c
	}
	if len(b.CheckSteps)+len(b.UncheckSteps) > 0 {
		next := cloneSteps(curSteps)
		flat := store.FlatSteps(next)
		for _, set := range []struct {
			nums []int
			done bool
		}{{b.CheckSteps, true}, {b.UncheckSteps, false}} {
			for _, n := range set.nums {
				if n < 1 || n > len(flat) {
					return f, "no step " + strconv.Itoa(n) + " (the task has " + strconv.Itoa(len(flat)) + " steps, numbered from 1 in reading order)"
				}
				flat[n-1].Done = set.done
				for i := range flat[n-1].Steps {
					flat[n-1].Steps[i].Done = set.done
				}
			}
		}
		next = store.CleanSteps(next)
		f.Steps = &next
	}
	if b.Criteria != nil {
		c := store.CleanSteps(*b.Criteria)
		curCrit, f.Criteria = c, &c
	}
	if len(b.CheckCriteria) > 0 {
		next := cloneSteps(curCrit)
		for _, n := range b.CheckCriteria {
			if n < 1 || n > len(next) {
				return f, "no criterion " + strconv.Itoa(n) + " (the goal has " + strconv.Itoa(len(next)) + ", numbered from 1)"
			}
			next[n-1].Done = true
		}
		f.Criteria = &next
	}
	if b.Links != nil {
		f.Links = b.Links
	}
	if len(b.MessageIDs) > topicsMaxMsgIDs {
		return f, "at most " + strconv.Itoa(topicsMaxMsgIDs) + " message_ids"
	}
	return f, ""
}

func cloneSteps(in []store.TaskStep) []store.TaskStep {
	out := make([]store.TaskStep, len(in))
	for i, s := range in {
		out[i] = store.TaskStep{Text: s.Text, Done: s.Done, Steps: append([]store.TaskStep(nil), s.Steps...)}
	}
	return out
}

// POST /api/agent/tasks {title, kind?, goal_id?, summary?, detail?, status?, steps?, criteria?,
// autonomous?, message_ids?}: the agent creates a task (or a goal) in its project. It is the task of
// this turn: the turn's untagged messages of the person, and the agent's replies in the turn, get it.
func (s *Server) agentCreateTask(w http.ResponseWriter, r *http.Request, sess *store.Session) {
	var b v3TaskBody
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
	ctx := r.Context()
	if b.Kind == store.KindGoal {
		k := store.KindGoal
		f.Kind = &k
	} else if b.Kind != "" && b.Kind != "task" {
		httpError(w, 400, "kind must be task or goal")
		return
	}
	if f.ParentID != nil && *f.ParentID != "" {
		if g, err := s.store.GetTask(ctx, *f.ParentID); err != nil || g.ProjectID != sess.ProjectID {
			httpError(w, 404, "no goal "+*f.ParentID+" in this project")
			return
		}
	}
	// Open tasks of the project that look like the same work: the agent is told, so that it keeps
	// using one task instead of making another (the Board stays the real set of ongoing work).
	type similar struct {
		ID     string `json:"id"`
		Title  string `json:"title"`
		Status string `json:"status"`
	}
	similarTasks := []similar{}
	if open, err := s.store.ListTasks(ctx, store.TaskQuery{ProjectID: sess.ProjectID}); err == nil {
		for _, x := range open {
			if x.Status != store.TaskDone && x.Kind == "" && len(similarTasks) < 3 && store.SimilarTitles(x.Title, *b.Title) {
				similarTasks = append(similarTasks, similar{x.ID, x.Title, x.Status})
			}
		}
	}
	t, err := s.store.CreateTask(ctx, sess.ProjectID, sess.ID, f)
	if err != nil {
		v3TaskError(w, err)
		return
	}
	cand, _ := s.store.TurnMessages(ctx, sess.ID)
	st := v3Turns.get(sess.ID, cand)
	st.Created = append(st.Created, t.ID)
	untagged, _ := s.untaggedOf(ctx, cand)
	_, _ = s.store.LinkMessages(ctx, t.ID, untagged, store.LinkAgent)
	if ids, msg := s.projectMessages(ctx, sess, b.MessageIDs); msg != "" {
		httpError(w, 400, msg)
		return
	} else {
		_, _ = s.store.LinkMessages(ctx, t.ID, s.withTurns(ctx, ids), store.LinkAgent)
	}
	s.settlePlaceRequests(ctx, sess.ID)
	if t.Kind == store.KindGoal && b.Autonomous != nil && *b.Autonomous {
		s.startAuto(ctx, t, sess.ID, b.MaxTurns, "")
	}
	t, _ = s.store.GetTask(ctx, t.ID)
	s.modLog(sess.ID, "task-create", "task=%q kind=%q status=%s tagged=%d", t.ID, t.Kind, t.Status, len(untagged))
	s.publishTasks()
	res := map[string]any{"task_id": t.ID, "task": t, "tagged_messages": untagged, "messages": untagged, "id": t.ID, "title": t.Title, "status": t.Status, "kind": t.Kind, "steps": t.Steps, "criteria": t.Criteria}
	if len(similarTasks) > 0 {
		res["similar_tasks"] = similarTasks
		res["note"] = "Open tasks with a similar title exist. If one of them is the same work, use it (send_message task_ids) and do not create more tasks for it; put parts of a piece of work in its steps."
	}
	writeJSON(w, 200, res)
}

// projectMessages keeps the ids that are messages of the session's project.
func (s *Server) projectMessages(ctx context.Context, sess *store.Session, ids []string) ([]string, string) {
	out := []string{}
	for _, id := range ids {
		id = strings.TrimSpace(id)
		if id == "" {
			continue
		}
		sid, _, err := s.store.MessageSession(ctx, id)
		if err != nil {
			return nil, "no message " + id
		}
		other, err := s.store.GetSession(ctx, sid)
		if err != nil || other.ProjectID != sess.ProjectID {
			return nil, "message " + id + " is not in this project"
		}
		out = append(out, id)
	}
	return out, ""
}

// PATCH /api/agent/tasks/{id}: the agent updates a task of its project (and becomes involved in it).
func (s *Server) agentUpdateTask(w http.ResponseWriter, r *http.Request, sess *store.Session) {
	var b v3TaskBody
	if !decode(w, r, &b) {
		return
	}
	ctx := r.Context()
	cur, err := s.store.GetTask(ctx, r.PathValue("id"))
	if err != nil || (cur.ProjectID != "" && cur.ProjectID != sess.ProjectID) {
		httpError(w, 404, "no task "+r.PathValue("id")+" in this project (list_tasks lists them)")
		return
	}
	f, msg := b.fields(cur)
	if msg != "" {
		httpError(w, 400, msg)
		return
	}
	ids, msg := s.projectMessages(ctx, sess, b.MessageIDs)
	if msg != "" {
		httpError(w, 400, msg)
		return
	}
	// The person's name for a task wins: an agent's rename of a task the person named is not applied,
	// and the result says so (the person renames it again, or the agent asks them to).
	note := ""
	if f.Title != nil && cur.TitleBy == store.TitleByPerson && strings.Join(strings.Fields(*f.Title), " ") != cur.Title {
		f.Title = nil
		note = "The person named this task themselves, so its title stays “" + cur.Title + "”. If the work's scope has clearly changed, suggest a new name to them with send_message instead."
	}
	t, err := s.store.UpdateTask(ctx, cur.ID, sess.ID, f)
	if err != nil {
		v3TaskError(w, err)
		return
	}
	if added, _ := s.store.LinkMessages(ctx, t.ID, s.withTurns(ctx, ids), store.LinkAgent); len(added) > 0 {
		_ = s.store.AddTaskEvent(ctx, t.ID, "link", strconv.Itoa(len(added))+" earlier message(s) added by "+sess.Name, sess.ID, "")
	}
	s.settlePlaceRequests(ctx, sess.ID)
	_, _ = s.store.AddTaskAgent(ctx, t.ID, sess.ID, store.RoleInvolved)
	if t.Kind == store.KindGoal {
		allMet := len(t.Criteria) > 0
		for _, c := range t.Criteria {
			allMet = allMet && c.Done
		}
		if allMet && t.Status != store.TaskDone {
			d := store.TaskDone
			t, _ = s.store.UpdateTask(ctx, t.ID, sess.ID, store.TaskFields{Status: &d})
		}
		if t.Status == store.TaskDone && t.Auto.State == store.AutoRunning {
			s.stopAuto(ctx, t, "met")
		}
		if b.Autonomous != nil {
			if *b.Autonomous && t.Auto.State != store.AutoRunning && t.Status != store.TaskDone {
				s.startAuto(ctx, t, sess.ID, b.MaxTurns, "")
			} else if !*b.Autonomous && t.Auto.State == store.AutoRunning {
				s.stopAuto(ctx, t, "stopped by the agent")
			}
		}
	}
	t, _ = s.store.GetTask(ctx, t.ID)
	s.modLog(sess.ID, "task-update", "task=%q status=%s", t.ID, t.Status)
	s.publishTasks()
	res := map[string]any{"task_id": t.ID, "task": t, "id": t.ID, "title": t.Title, "status": t.Status, "kind": t.Kind, "steps": t.Steps, "criteria": t.Criteria}
	if note != "" {
		res["note"] = note
	}
	writeJSON(w, 200, res)
}

// GET /api/agent/tasks?all=1: the tasks and goals the caller is an agent of (open ones, and the ones
// done in the last week); all=1: every open task of the project.
func (s *Server) agentListTasks(w http.ResponseWriter, r *http.Request, sess *store.Session) {
	q := store.TaskQuery{ProjectID: sess.ProjectID, DoneSince: time.Now().Add(-v3DoneWindow), DoneLimit: 20}
	if r.URL.Query().Get("all") == "" {
		q.SessionID = sess.ID
	}
	ts, err := s.store.ListTasks(r.Context(), q)
	if err != nil {
		storeError(w, err)
		return
	}
	writeJSON(w, 200, map[string]any{"tasks": ts})
}

// peekJSON decodes the request's JSON into v and leaves a fresh copy of the body for the next handler.
func peekJSON(w http.ResponseWriter, r *http.Request, v any) (io.ReadCloser, bool) {
	b, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 4<<20))
	if err != nil {
		httpError(w, 400, "invalid body: "+err.Error())
		return nil, false
	}
	if err := json.Unmarshal(b, v); err != nil {
		httpError(w, 400, "invalid JSON: "+err.Error())
		return nil, false
	}
	return io.NopCloser(bytes.NewReader(b)), true
}

// v3Inject fills each pending message's tasks (its tags) and whether it is in the stream: the
// integrations show the tasks to the agent with the message.
func (s *Server) v3Inject(ctx context.Context, pending []store.PendingDelivery) {
	ids := make([]string, len(pending))
	for i := range pending {
		ids[i] = pending[i].ID
	}
	tags, err := s.store.TasksOf(ctx, ids)
	if err != nil {
		return
	}
	for i := range pending {
		pending[i].Tasks = tags[pending[i].ID]
		if k, err := s.store.GetThreadKind(ctx, pending[i].ThreadID); err == nil {
			pending[i].Stream = k == store.ThreadStream
		}
		// A hand-off (the person wrote from a task to an agent new on it): the task's state rides along.
		for _, tg := range pending[i].Tasks {
			if hc := s.handoffContext(ctx, tg.TaskID, pending[i].ID); hc != "" {
				pending[i].Body = hc + "\n\n" + pending[i].Body
			}
		}
	}
}

// handoffContext is what an agent new on a task needs to pick it up: the task, its checklist, its
// last report and its latest messages. "" when the message is no hand-off.
func (s *Server) handoffContext(ctx context.Context, taskID, messageID string) string {
	evs, err := s.store.TaskEvents(ctx, taskID)
	if err != nil {
		return ""
	}
	handoff := false
	for _, e := range evs {
		if e.Kind == "handoff" && e.MessageID == messageID {
			handoff = true
		}
	}
	if !handoff {
		return ""
	}
	t, err := s.store.GetTask(ctx, taskID)
	if err != nil {
		return ""
	}
	var b strings.Builder
	b.WriteString("<minbox_handoff task=\"" + t.ID + "\">\nYou are taking over this task from another agent. Task " + t.ID + ": " + t.Title + " (" + t.Status + ")\n")
	if t.Summary != "" {
		b.WriteString(t.Summary + "\n")
	}
	if t.Detail != "" {
		b.WriteString(truncRunes(t.Detail, 1500) + "\n")
	}
	for i, p := range store.FlatSteps(t.Steps) {
		box := " "
		if p.Done {
			box = "x"
		}
		b.WriteString("  " + strconv.Itoa(i+1) + ". [" + box + "] " + p.Text + "\n")
	}
	if t.Report != "" {
		b.WriteString("Last report: " + truncRunes(t.Report, 1500) + "\n")
	}
	ids, _ := s.store.TaskMessageIDs(ctx, taskID)
	if len(ids) > 6 {
		ids = ids[len(ids)-6:]
	}
	for _, id := range ids {
		if id == messageID {
			continue
		}
		m, err := s.store.GetMessage(ctx, id)
		if err != nil {
			continue
		}
		who := "agent"
		text := m.Body
		if m.Author == store.AuthorUser {
			who = "person"
			if m.Words != "" {
				text = m.Words
			}
		}
		b.WriteString("[" + who + "] " + truncRunes(strings.Join(strings.Fields(text), " "), 400) + "\n")
	}
	b.WriteString("</minbox_handoff>")
	return b.String()
}
