package server

import (
	"context"
	"strings"
	"testing"

	"github.com/ryotarai/minbox/internal/store"
)

// Every message belongs to exactly one task (docs/v3/redesign.md §4.5, revision 8): the reply's
// explicit task wins over the turn's context, the context counts only when it points at one task,
// and send_message names one task (task_id; task_ids is its one-element alias).

func (e *env) newTask(sess *store.Session, title string) string {
	e.t.Helper()
	code, obj, _ := e.do("POST", "/api/agent/tasks", map[string]any{"title": title}, bearer(sess))
	if code != 200 {
		e.t.Fatalf("create %q: %d %v", title, code, obj)
	}
	return obj["task_id"].(string)
}

func (e *env) turnEnds(sess *store.Session) {
	e.do("POST", "/api/agent/status", map[string]string{"status": "idle"}, bearer(sess))
}

func oneOf(t *testing.T, e *env, msgID, want string) {
	t.Helper()
	got := tagIDs(t, e, msgID)
	if want == "" && len(got) == 0 {
		return
	}
	if len(got) != 1 || got[0] != want {
		t.Fatalf("message %s is in %v, want [%s]", msgID, got, want)
	}
}

func TestV3ReplyNamesOneTask(t *testing.T) {
	e := newEnv(t)
	sess := e.createSession()
	a := e.newTask(sess, "Task A")
	e.turnEnds(sess)

	// The trigger: the turn created B, the reply names A. The reply and the person's message are in
	// A only; B keeps nothing of the turn.
	u1 := e.personSays(sess, "about A, and maybe something new")
	b := e.newTask(sess, "Task B")
	oneOf(t, e, u1, b) // for now: the turn's first new task
	r1 := e.agentSays(sess, map[string]any{"body": "That is A.", "task_id": a})
	if ids := r1["task_ids"].([]any); len(ids) != 1 || ids[0] != a || r1["task_id"] != a || r1["decision"] != "existing" {
		t.Fatalf("reply = %v", r1)
	}
	oneOf(t, e, r1["message_id"].(string), a)
	oneOf(t, e, u1, a)
	if n, _ := e.st.TaskCount(context.Background(), b); n != 0 {
		t.Fatalf("B has %d messages", n)
	}
	e.turnEnds(sess)

	// No task named, one task created in the turn: that one.
	u2 := e.personSays(sess, "new thing C")
	c := e.newTask(sess, "Task C")
	r2 := e.agentSays(sess, map[string]any{"body": "Made C."})
	if r2["decision"] != "created" {
		t.Fatalf("created = %v", r2)
	}
	oneOf(t, e, r2["message_id"].(string), c)
	oneOf(t, e, u2, c)
	e.turnEnds(sess)

	// No task named, none created: the task of the person's message (written from A's view).
	u3 := e.personSays(sess, "status?", a)
	r3 := e.agentSays(sess, map[string]any{"body": "Halfway."})
	oneOf(t, e, u3, a)
	oneOf(t, e, r3["message_id"].(string), a)
	e.turnEnds(sess)

	// Ambiguous: two tasks created in the turn and none named: the reply is unplaced (the place
	// request asks the agent), and says so.
	u4 := e.personSays(sess, "two new things")
	d := e.newTask(sess, "Task D")
	e.newTask(sess, "Task E")
	r4 := e.agentSays(sess, map[string]any{"body": "Made two."})
	if r4["decision"] != "none" || len(r4["task_ids"].([]any)) != 0 || !strings.Contains(r4["note"].(string), "in no task") {
		t.Fatalf("ambiguous = %v", r4)
	}
	oneOf(t, e, r4["message_id"].(string), "")
	oneOf(t, e, u4, d) // the first new task's provisional placement stays
	e.turnEnds(sess)

	// The task_ids alias: one id works; two are refused with a text that says to pick one.
	e.personSays(sess, "and A again")
	r5 := e.agentSays(sess, map[string]any{"body": "A it is.", "task_ids": []string{a}})
	oneOf(t, e, r5["message_id"].(string), a)
	code, bad, _ := e.do("POST", "/api/agent/messages", map[string]any{"task_status": "working", "body": "both", "task_ids": []string{a, c}}, bearer(sess))
	if code != 400 || !strings.Contains(bad["error"].(string), "exactly one task") || !strings.Contains(bad["error"].(string), "task_id") {
		t.Fatalf("two tasks: %d %v", code, bad)
	}
	code, bad, _ = e.do("POST", "/api/agent/messages", map[string]any{"task_status": "working", "body": "both", "task_id": a, "task_ids": []string{c}}, bearer(sess))
	if code != 400 {
		t.Fatalf("task_id + another task_ids: %d %v", code, bad)
	}
	if code, _, _ := e.do("POST", "/api/agent/messages", map[string]any{"task_status": "working", "body": "same", "task_id": a, "task_ids": []string{a}}, bearer(sess)); code != 201 {
		t.Fatalf("the same task twice: %d", code)
	}
	// Through the thin integrations' tool call: the error is the text the agent reads.
	code, tool, _ := e.do("POST", "/api/agent/tool", map[string]any{"tool": "send_message", "args": map[string]any{"task_status": "working", "body": "both", "task_ids": []any{a, c}}}, bearer(sess))
	if code != 200 || tool["ok"] != false || !strings.Contains(tool["error"].(string), "pass task_id with the one task") {
		t.Fatalf("tool: %d %v", code, tool)
	}
	code, tool, _ = e.do("POST", "/api/agent/tool", map[string]any{"tool": "send_message", "args": map[string]any{"task_status": "working", "body": "one", "task_id": c}}, bearer(sess))
	if code != 200 || tool["ok"] != true || !strings.Contains(tool["text"].(string), "About task "+c+".") {
		t.Fatalf("tool task_id: %d %v", code, tool)
	}
}

func TestV3PersonMovesAMessage(t *testing.T) {
	e := newEnv(t)
	sess := e.createSession()
	a := e.newTask(sess, "Task A")
	b := e.newTask(sess, "Task B")
	e.turnEnds(sess)
	u := e.personSays(sess, "this is A", a)
	oneOf(t, e, u, a)
	// Move (the canonical PUT and the older POST): the message leaves A.
	if code, obj, _ := e.do("PUT", "/api/v3/messages/"+u+"/task", map[string]any{"task_id": b}, nil); code != 200 || obj["from"] != a {
		t.Fatalf("move: %d %v", code, obj)
	}
	oneOf(t, e, u, b)
	if code, _, _ := e.do("POST", "/api/v3/messages/"+u+"/tasks", map[string]any{"task_id": a}, nil); code != 200 {
		t.Fatalf("move back: %d", code)
	}
	oneOf(t, e, u, a)
	// It is never taken out of its task.
	if code, _, _ := e.do("DELETE", "/api/v3/messages/"+u+"/tasks/"+a, nil, nil); code != 409 {
		t.Fatalf("take out: %d", code)
	}
	oneOf(t, e, u, a)
	// create_task message_ids moves it too.
	code, obj, _ := e.do("POST", "/api/agent/tasks", map[string]any{"title": "Task C", "message_ids": []string{u}}, bearer(sess))
	if code != 200 {
		t.Fatalf("create: %d %v", code, obj)
	}
	oneOf(t, e, u, obj["task_id"].(string))
	evs, _ := e.st.TaskEvents(context.Background(), b)
	moved := false
	for _, ev := range evs {
		moved = moved || strings.Contains(ev.Text, "moved by you to")
	}
	if !moved {
		t.Fatalf("B's timeline: %+v", evs)
	}
}
