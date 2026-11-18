package server

import (
	"context"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/ryotarai/minbox/internal/store"
)

// v3 helpers: the person writes to an agent's stream, the agent gets it (claim + delivered).
func (e *env) personSays(sess *store.Session, words string, taskIDs ...string) string {
	e.t.Helper()
	body := map[string]any{"words": words}
	if len(taskIDs) > 0 {
		body["task_ids"] = taskIDs
	}
	code, obj, _ := e.do("POST", "/api/v3/sessions/"+sess.ID+"/messages", body, nil)
	if code != 201 {
		e.t.Fatalf("person: %d %v", code, obj)
	}
	id := obj["id"].(string)
	e.do("POST", "/api/agent/pending/"+id+"/claim?owner=o", nil, bearer(sess))
	if code, _, _ := e.do("POST", "/api/agent/pending/"+id+"/delivered?owner=o", nil, bearer(sess)); code != 200 {
		e.t.Fatalf("delivered: %d", code)
	}
	return id
}

func (e *env) agentSays(sess *store.Session, body map[string]any) map[string]any {
	e.t.Helper()
	code, obj, _ := e.do("POST", "/api/agent/messages", body, bearer(sess))
	if code != 201 {
		e.t.Fatalf("agent: %d %v", code, obj)
	}
	return obj
}

func tagIDs(t *testing.T, e *env, msgID string) []string {
	t.Helper()
	tags, err := e.st.TasksOf(context.Background(), []string{msgID})
	if err != nil {
		t.Fatal(err)
	}
	out := []string{}
	for _, tg := range tags[msgID] {
		out = append(out, tg.TaskID)
	}
	return out
}

func TestV3AgentDecides(t *testing.T) {
	e := newEnv(t)
	sess := e.createSession()

	// New work: create_task in the turn tags the person's message and the reply.
	u1 := e.personSays(sess, "please fix the gauge")
	code, created, _ := e.do("POST", "/api/agent/tasks", map[string]any{"title": "Fix gauge", "steps": []any{map[string]any{"text": "Look"}, map[string]any{"text": "Fix"}}}, bearer(sess))
	if code != 200 {
		t.Fatalf("create: %d %v", code, created)
	}
	gauge := created["task_id"].(string)
	r1 := e.agentSays(sess, map[string]any{"body": "On it."})
	if r1["decision"] != "created" || len(r1["task_ids"].([]any)) != 1 {
		t.Fatalf("reply = %v", r1)
	}
	if got := tagIDs(t, e, u1); len(got) != 1 || got[0] != gauge {
		t.Fatalf("person's message tags = %v", got)
	}
	m, _ := e.st.GetMessage(context.Background(), r1["message_id"].(string))
	if m.Decision != "created" || m.DecisionTask != gauge || len(m.TurnOf) != 1 || m.TurnOf[0] != u1 {
		t.Fatalf("decision = %+v", m)
	}
	// A second reply in the same turn carries no decision, but still the turn's task.
	r1b := e.agentSays(sess, map[string]any{"body": "Looking at the code."})
	if r1b["decision"] != "" || len(r1b["task_ids"].([]any)) != 1 {
		t.Fatalf("second reply = %v", r1b)
	}
	e.do("POST", "/api/agent/status", map[string]string{"status": "idle"}, bearer(sess))

	// Existing task: task_ids on the reply tag the person's untagged message too (retroactively).
	u2 := e.personSays(sess, "also the label of the gauge")
	r2 := e.agentSays(sess, map[string]any{"body": "Folding it in.", "task_ids": []string{gauge}})
	if r2["decision"] != "existing" {
		t.Fatalf("existing = %v", r2)
	}
	if got := tagIDs(t, e, u2); len(got) != 1 || got[0] != gauge {
		t.Fatalf("retroactive tag = %v", got)
	}
	e.do("POST", "/api/agent/status", map[string]string{"status": "idle"}, bearer(sess))

	// No task: nothing is tagged.
	u3 := e.personSays(sess, "how long does the build take?")
	r3 := e.agentSays(sess, map[string]any{"body": "About 14 minutes."})
	if r3["decision"] != "none" || len(tagIDs(t, e, u3)) != 0 || len(r3["task_ids"].([]any)) != 0 {
		t.Fatalf("none = %v", r3)
	}
	e.do("POST", "/api/agent/status", map[string]string{"status": "idle"}, bearer(sess))

	// From a task view: the person's message is tagged at once; the reply inherits it.
	u4 := e.personSays(sess, "status?", gauge)
	if got := tagIDs(t, e, u4); len(got) != 1 {
		t.Fatalf("task view message = %v", got)
	}
	r4 := e.agentSays(sess, map[string]any{"body": "Halfway."})
	if r4["decision"] != "existing" || len(r4["task_ids"].([]any)) != 1 {
		t.Fatalf("inherited = %v", r4)
	}

	// An unknown task is refused.
	if code, _, _ := e.do("POST", "/api/agent/messages", map[string]any{"body": "x", "task_ids": []string{"tsk_nope"}}, bearer(sess)); code != 404 {
		t.Fatalf("unknown task: %d", code)
	}
	// update_task: check a step (numbered in reading order), tag an older message, report.
	code, up, _ := e.do("PATCH", "/api/agent/tasks/"+gauge, map[string]any{"check_steps": []int{1}, "message_ids": []string{u3}, "report": "Looked."}, bearer(sess))
	if code != 200 {
		t.Fatalf("update: %d %v", code, up)
	}
	if got := tagIDs(t, e, u3); len(got) != 1 {
		t.Fatalf("message_ids = %v", got)
	}
	_, list, _ := e.do("GET", "/api/agent/tasks", nil, bearer(sess))
	ts := list["tasks"].([]any)
	if len(ts) != 1 || ts[0].(map[string]any)["report"] != "Looked." {
		t.Fatalf("list = %v", list)
	}

	// Wrong task: move the reply and the person's message to another task; the mistaken task goes.
	u5 := e.personSays(sess, "add a dark mode toggle")
	_, mistaken, _ := e.do("POST", "/api/agent/tasks", map[string]any{"title": "Dark mode"}, bearer(sess))
	r5 := e.agentSays(sess, map[string]any{"body": "Created a task."})
	code, rt, _ := e.do("POST", "/api/v3/messages/"+r5["message_id"].(string)+"/move", map[string]any{"from": mistaken["task_id"], "to": gauge}, nil)
	if code != 200 || rt["removed_task"] != "Dark mode" {
		t.Fatalf("retag: %d %v", code, rt)
	}
	if got := tagIDs(t, e, u5); len(got) != 1 || got[0] != gauge {
		t.Fatalf("moved = %v", got)
	}
	if _, err := e.st.GetTask(context.Background(), mistaken["task_id"].(string)); err == nil {
		t.Fatal("the mistaken task is still there")
	}

	// The Board: the task with its counts; the task view: messages with gaps and events.
	_, board, _ := e.do("GET", "/api/v3/board?project="+sess.ProjectID, nil, nil)
	bts := board["tasks"].([]any)
	if len(bts) != 1 || bts[0].(map[string]any)["message_count"].(float64) < 8 {
		t.Fatalf("board = %v", board)
	}
	_, view, _ := e.do("GET", "/api/v3/tasks/"+gauge, nil, nil)
	if len(view["messages"].([]any)) < 8 || len(view["events"].([]any)) < 2 {
		t.Fatalf("view = %v", view)
	}
	// Read state: the task's agent messages read.
	ids := []string{}
	for _, x := range view["messages"].([]any) {
		ids = append(ids, x.(map[string]any)["id"].(string))
	}
	_, rd, _ := e.do("POST", "/api/v3/read", map[string]any{"message_ids": ids}, nil)
	if rd["marked"].(float64) < 3 {
		t.Fatalf("read = %v", rd)
	}
	// Search: tasks and messages.
	_, found, _ := e.do("GET", "/api/v3/search?q=gauge", nil, nil)
	if len(found["tasks"].([]any)) != 1 || len(found["messages"].([]any)) < 2 {
		t.Fatalf("search = %v", found)
	}
	// The stream: everything, oldest first, with tags.
	_, stream, _ := e.do("GET", "/api/v3/sessions/"+sess.ID+"/stream", nil, nil)
	if n := len(stream["messages"].([]any)); n != 11 {
		t.Fatalf("stream has %d", n)
	}
}

func TestV3QuestionsOnBoardAndAnswerTags(t *testing.T) {
	e := newEnv(t)
	sess := e.createSession()
	e.personSays(sess, "deploy the api")
	_, tk, _ := e.do("POST", "/api/agent/tasks", map[string]any{"title": "Deploy"}, bearer(sess))
	q := e.agentSays(sess, map[string]any{"body": "Which region?\n\n:::question\nWhich region?\n- [ ] Tokyo\n- [ ] Oregon\n:::"})
	// Later messages do not close a stream question.
	e.agentSays(sess, map[string]any{"body": "Meanwhile: tests pass."})
	_, board, _ := e.do("GET", "/api/v3/board", nil, nil)
	if qs := board["questions"].([]any); len(qs) != 1 {
		t.Fatalf("questions = %v", board["questions"])
	}
	bt := board["tasks"].([]any)[0].(map[string]any)
	if bt["needs_you"] != true || bt["open_questions"].(float64) != 1 {
		t.Fatalf("task = %v", bt)
	}
	// Answering: the answer carries the question's task, and the question leaves the Board.
	code, ans, _ := e.do("POST", "/api/v3/sessions/"+sess.ID+"/messages", map[string]any{"answers_for": q["message_id"], "answers": []any{map[string]any{"key": q["questions"].([]any)[0].(map[string]any)["key"], "selected": []string{"Tokyo"}}}}, nil)
	if code != 201 {
		t.Fatalf("answer: %d %v", code, ans)
	}
	if got := tagIDs(t, e, ans["id"].(string)); len(got) != 1 || got[0] != tk["task_id"] {
		t.Fatalf("answer tags = %v", got)
	}
	_, board, _ = e.do("GET", "/api/v3/board", nil, nil)
	if len(board["questions"].([]any)) != 0 {
		t.Fatalf("still open: %v", board["questions"])
	}
}

// A task's unread count (its title is bold in the task lists): the agent's messages about it the person
// has not seen; the person's own messages never count. Reading them publishes "tasks" (the lists update).
func TestV3TaskUnread(t *testing.T) {
	e := newEnv(t)
	sess := e.createSession()
	e.personSays(sess, "please fix the gauge")
	_, tk, _ := e.do("POST", "/api/agent/tasks", map[string]any{"title": "Fix gauge"}, bearer(sess))
	id := tk["task_id"].(string)
	unread := func() float64 {
		t.Helper()
		_, board, _ := e.do("GET", "/api/v3/board", nil, nil)
		for _, x := range board["tasks"].([]any) {
			if m := x.(map[string]any); m["id"] == id {
				return m["unread"].(float64)
			}
		}
		t.Fatalf("no task %s", id)
		return 0
	}
	if n := unread(); n != 0 {
		t.Fatalf("before the reply: %v", n)
	}
	r := e.agentSays(sess, map[string]any{"body": "On it.", "task_id": id})
	if n := unread(); n != 1 {
		t.Fatalf("after the reply: %v", n)
	}
	e.personSays(sess, "also the needle", id)
	if n := unread(); n != 1 {
		t.Fatalf("the person's message counted: %v", n)
	}
	events := make(chan Event, 16)
	e.srv.hub.mu.Lock()
	e.srv.hub.subs[events] = struct{}{}
	e.srv.hub.mu.Unlock()
	e.do("POST", "/api/v3/read", map[string]any{"message_ids": []string{r["message_id"].(string)}}, nil)
	if n := unread(); n != 0 {
		t.Fatalf("after reading: %v", n)
	}
	got := false
	for len(events) > 0 {
		if ev := <-events; ev.Type == "tasks" {
			got = true
		}
	}
	if !got {
		t.Fatal("reading did not publish tasks")
	}
}

func TestV3NewMessageToMainAndNewSession(t *testing.T) {
	e := newEnv(t)
	sess := e.createSession() // the project's first session is its main one
	code, m, _ := e.do("POST", "/api/v3/new", map[string]any{"project_id": sess.ProjectID, "words": "hello main"}, nil)
	if code != 201 {
		t.Fatalf("to main: %d %v", code, m)
	}
	stream, _ := e.st.StreamThread(context.Background(), sess.ID)
	if m["thread_id"] != stream {
		t.Fatalf("not in the main stream: %v", m)
	}
	code, m, _ = e.do("POST", "/api/v3/new", map[string]any{"project_id": sess.ProjectID, "to": "new", "name": "helper", "words": "hello new"}, nil)
	if code != 201 {
		t.Fatalf("to new: %d %v", code, m)
	}
	th, _ := e.st.GetThread(context.Background(), m["thread_id"].(string))
	if th.SessionID == sess.ID || th.Kind != store.ThreadStream {
		t.Fatalf("new session thread = %+v", th)
	}
}

func TestV3GoalAutonomousRun(t *testing.T) {
	old := goalSettle
	goalSettle = 0
	t.Cleanup(func() { goalSettle = old })
	e := newEnv(t)
	sess := e.createSession()
	e.do("POST", "/api/agent/status", map[string]string{"status": "idle"}, bearer(sess))
	e.personSays(sess, "keep going until CI is green")
	code, g, _ := e.do("POST", "/api/agent/tasks", map[string]any{"title": "CI green", "kind": "goal", "criteria": []any{map[string]any{"text": "CI passes"}}, "autonomous": true}, bearer(sess))
	if code != 200 || g["kind"] != "goal" {
		t.Fatalf("goal: %d %v", code, g)
	}
	gid := g["task_id"].(string)
	e.agentSays(sess, map[string]any{"body": "Working toward it."})
	e.do("POST", "/api/agent/status", map[string]string{"status": "idle"}, bearer(sess))
	time.Sleep(5 * time.Millisecond)
	e.srv.goalTick()
	pend, _ := e.st.PendingForSession(context.Background(), sess.ID, "")
	if len(pend) != 1 || pend[0].Kind != KindContinue || pend[0].Urgent {
		t.Fatalf("no continuation: %+v", pend)
	}
	// Not idle again since: no second continuation.
	e.srv.goalTick()
	if p, _ := e.st.PendingForSession(context.Background(), sess.ID, ""); len(p) != 1 {
		t.Fatalf("pending = %d", len(p))
	}
	// Pause and stop from the person.
	code, paused, _ := e.do("POST", "/api/v3/tasks/"+gid+"/auto", map[string]any{"action": "pause"}, nil)
	if code != 200 || paused["auto"].(map[string]any)["state"] != "paused" {
		t.Fatalf("pause: %d %v", code, paused)
	}
	e.do("POST", "/api/v3/tasks/"+gid+"/auto", map[string]any{"action": "start"}, nil)
	// Met: the agent ticks the criterion; the goal is done and the run ends.
	code, up, _ := e.do("PATCH", "/api/agent/tasks/"+gid, map[string]any{"check_criteria": []int{1}}, bearer(sess))
	if code != 200 {
		t.Fatalf("check: %d %v", code, up)
	}
	got, _ := e.st.GetTask(context.Background(), gid)
	if got.Status != store.TaskDone || got.Auto.State != store.AutoStopped || got.Auto.Reason != "met" {
		t.Fatalf("goal after met = %+v", got)
	}
}

func TestV3HandoffCarriesTheTask(t *testing.T) {
	e := newEnv(t)
	a := e.createSession()
	b := e.createSession()
	e.personSays(a, "fix the gauge")
	_, created, _ := e.do("POST", "/api/agent/tasks", map[string]any{"title": "Fix gauge", "steps": []any{map[string]any{"text": "Look", "done": true}}}, bearer(a))
	e.agentSays(a, map[string]any{"body": "Looked: the scale is off."})
	tid := created["task_id"].(string)
	// The person writes from the task to b: a hand-off.
	code, m, _ := e.do("POST", "/api/v3/sessions/"+b.ID+"/messages", map[string]any{"words": "please take it over", "task_ids": []string{tid}}, nil)
	if code != 201 {
		t.Fatalf("send: %d %v", code, m)
	}
	_, _, list := e.do("GET", "/api/agent/pending", nil, bearer(b))
	if len(list) != 1 {
		t.Fatalf("pending = %v", list)
	}
	body := list[0].(map[string]any)["body"].(string)
	for _, want := range []string{"<minbox_handoff task=\"" + tid + "\">", "1. [x] Look", "[agent] Looked: the scale is off.", "please take it over"} {
		if !strings.Contains(body, want) {
			t.Fatalf("hand-off lacks %q:\n%s", want, body)
		}
	}
	got, _ := e.st.GetTask(context.Background(), tid)
	if len(got.Agents) != 2 {
		t.Fatalf("agents = %+v", got.Agents)
	}
}

// Every message of the person goes into a busy agent's running turn at once (urgent by default, as
// Send now did): a stream message, a task's message, an answer, an older thread's reply, a new
// thread. Both protocols see it; minbox's own place request and a goal's continue do not.
func TestPersonMessagesAreUrgent(t *testing.T) {
	e := newEnv(t)
	sess := e.createSession()
	e.do("POST", "/api/agent/status", map[string]string{"status": "working"}, bearer(sess))
	code, obj, _ := e.do("POST", "/api/v3/sessions/"+sess.ID+"/messages", map[string]any{"words": "first"}, nil)
	if code != 201 {
		t.Fatalf("stream: %d %v", code, obj)
	}
	code, obj, _ = e.do("POST", "/api/v3/sessions/"+sess.ID+"/messages", map[string]any{"words": "second"}, nil)
	if code != 201 {
		t.Fatalf("stream 2: %d %v", code, obj)
	}
	code, obj, _ = e.do("POST", "/api/sessions/"+sess.ID+"/threads", map[string]any{"body": "a new thread"}, nil)
	if code != 201 {
		t.Fatalf("new thread: %d %v", code, obj)
	}
	streamID, err := e.st.StreamThread(context.Background(), sess.ID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := e.st.AddMessage(context.Background(), streamID, store.NewMessage{Author: store.AuthorUser, Body: "place them", Kind: store.KindPlace}); err != nil {
		t.Fatal(err)
	}
	if _, err := e.st.AddMessage(context.Background(), streamID, store.NewMessage{Author: store.AuthorUser, Body: "carry on", Kind: KindContinue}); err != nil {
		t.Fatal(err)
	}
	// Protocol 0 (an old mod, fake-claude.py): a list of messages.
	var got []string
	for _, p := range e.pending(sess) {
		got = append(got, fmt.Sprintf("%s:%v", p["body"], p["urgent"]))
	}
	want := "first:true second:true a new thread:true place them:false carry on:false"
	if strings.Join(got, " ") != want {
		t.Fatalf("proto 0 pending = %s, want %s", strings.Join(got, " "), want)
	}
	// Protocol 1: items with the text to inject, in the same order.
	_, ans, _ := e.do("GET", "/api/agent/pending?owner=o&proto=1", nil, bearer(sess))
	items, _ := ans["items"].([]any)
	got = nil
	for _, v := range items {
		p := v.(map[string]any)
		got = append(got, fmt.Sprintf("%s:%v", p["body"], p["urgent"]))
	}
	if strings.Join(got, " ") != want {
		t.Fatalf("proto 1 pending = %s, want %s", strings.Join(got, " "), want)
	}
}
