package server

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/ryotarai/minbox/internal/store"
)

// send_message carries task_status (required): a call without it is refused with a text that says to
// send it again with task_status, and nothing is stored or delivered.
func TestSendMessageNeedsTaskStatus(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	sess := e.createSession()
	a := e.newTask(sess, "Task A")
	count := func() int {
		msgs, _, _ := e.st.SessionMessages(ctx, sess.ID)
		return len(msgs)
	}
	before := count()
	// Protocol 0: POST /api/agent/messages answers 400 with the text; an empty one is none.
	for _, st := range []string{"", " "} {
		code, obj, _ := e.do("POST", "/api/agent/messages", map[string]any{"body": "hi", "task_id": a, "task_status": st}, bearer(sess))
		if code != 400 || obj["error"] != sendStatusMissing {
			t.Fatalf("protocol 0 task_status %q: %d %v", st, code, obj)
		}
	}
	if !strings.Contains(sendStatusMissing, "send the same message again with task_status (working | needs_you | blocked | done)") {
		t.Fatalf("the refusal does not say how to resend: %s", sendStatusMissing)
	}
	// Protocol 1: POST /api/agent/tool answers ok:false with the text the agent reads.
	code, tool, _ := e.do("POST", "/api/agent/tool", map[string]any{"tool": "send_message", "args": map[string]any{"body": "hi", "task_id": a}}, bearer(sess))
	if code != 200 || tool["ok"] != false || tool["error"] != "minbox: "+sendStatusMissing {
		t.Fatalf("protocol 1: %d %v", code, tool)
	}
	// Not a status; status (the older name) disagreeing with task_status.
	if code, obj, _ := e.do("POST", "/api/agent/messages", map[string]any{"body": "hi", "task_id": a, "task_status": "bogus"}, bearer(sess)); code != 400 || obj["error"] != sendStatusInvalid {
		t.Fatalf("bogus: %d %v", code, obj)
	}
	if code, obj, _ := e.do("POST", "/api/agent/messages", map[string]any{"body": "hi", "task_id": a, "task_status": "done", "status": "working"}, bearer(sess)); code != 400 || obj["error"] != sendStatusConflict {
		t.Fatalf("conflict: %d %v", code, obj)
	}
	if n := count(); n != before {
		t.Fatalf("a refused send stored %d message(s)", n-before)
	}
	if got, _ := e.st.GetTask(ctx, a); got.Status != store.TaskWorking {
		t.Fatalf("the task is %s after refused sends", got.Status)
	}
}

// Each task_status is set on the message's task as update_task sets it (a status event on change),
// for the named task and for the task the reply resolves to; status, the older key, is an alias.
func TestSendMessageTaskStatusApplied(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	sess := e.createSession()
	a := e.newTask(sess, "Task A")
	other := e.newTask(sess, "Other")
	statusEvents := func(id string) []string {
		evs, _ := e.st.TaskEvents(ctx, id)
		out := []string{}
		for _, ev := range evs {
			if ev.Kind == "status" {
				out = append(out, ev.Text)
			}
		}
		return out
	}
	for _, st := range []string{"needs_you", "blocked", "done", "working"} {
		sent := e.agentSays(sess, map[string]any{"body": "about " + st, "task_id": a, "task_status": st})
		if sent["task_id"] != a || sent["task_status"] != st {
			t.Fatalf("send %s: %v", st, sent)
		}
		if got, _ := e.st.GetTask(ctx, a); got.Status != st {
			t.Fatalf("after task_status %s the task is %s", st, got.Status)
		}
	}
	if evs := statusEvents(a); len(evs) != 4 {
		t.Fatalf("status events = %v", evs)
	}
	if got, _ := e.st.GetTask(ctx, other); got.Status != store.TaskWorking || len(statusEvents(other)) != 0 {
		t.Fatalf("the other task changed: %s %v", got.Status, statusEvents(other))
	}
	// The same status again adds no event.
	e.agentSays(sess, map[string]any{"body": "still", "task_id": a, "task_status": "working"})
	if evs := statusEvents(a); len(evs) != 4 {
		t.Fatalf("status events after a same status = %v", evs)
	}
	// status, the older key, is accepted as task_status (and the tool result says the new status).
	o := e.do2tool(sess, map[string]any{"body": "waiting", "task_id": a, "status": "needs_you"})
	if o["ok"] != true || !strings.Contains(o["text"].(string), "About task "+a+". Its status is now needs_you.") {
		t.Fatalf("alias: %v", o)
	}
	if got, _ := e.st.GetTask(ctx, a); got.Status != store.TaskNeedsYou {
		t.Fatalf("after status (alias) the task is %s", got.Status)
	}
	// No task_id: the task the reply resolves to (the person's message's task) gets it.
	e.personSays(sess, "and the other one?", other)
	sent := e.agentSays(sess, map[string]any{"body": "Done there.", "task_status": "done"})
	if sent["task_id"] != other {
		t.Fatalf("resolved task = %v", sent)
	}
	if got, _ := e.st.GetTask(ctx, other); got.Status != store.TaskDone || got.DoneAt == nil {
		t.Fatalf("resolved task is %s", got.Status)
	}
}

// needs_you puts the task in NEEDS YOU on the Board (and in the agent's count).
func TestSendMessageNeedsYouOnBoard(t *testing.T) {
	e := newEnv(t)
	sess := e.createSession()
	a := e.newTask(sess, "Ship")
	e.agentSays(sess, map[string]any{"task_id": a, "task_status": "needs_you", "body": ":::question\nShip now?\n- [ ] Yes\n- [ ] No\n:::"})
	_, board, _ := e.do("GET", "/api/v3/board", nil, nil)
	if bt := boardTaskOf(t, e, a); bt["status"] != "needs_you" {
		t.Fatalf("task = %v", bt)
	}
	if ag := board["agents"].(map[string]any)[sess.ID].(map[string]any); ag["needs_you"].(float64) != 1 {
		t.Fatalf("agent = %v", ag)
	}
}

// done on a goal stops its run, as update_task status done does.
func TestSendMessageDoneStopsGoalRun(t *testing.T) {
	old := goalSettle
	goalSettle = 0
	t.Cleanup(func() { goalSettle = old })
	e := newEnv(t)
	ctx := context.Background()
	sess := e.createSession()
	e.do("POST", "/api/agent/status", map[string]string{"status": "idle"}, bearer(sess))
	e.personSays(sess, "keep going until CI is green")
	code, g, _ := e.do("POST", "/api/agent/tasks", map[string]any{"title": "CI green", "kind": "goal", "criteria": []any{map[string]any{"text": "CI passes"}}, "autonomous": true}, bearer(sess))
	if code != 200 {
		t.Fatalf("goal: %d %v", code, g)
	}
	gid := g["task_id"].(string)
	if got, _ := e.st.GetTask(ctx, gid); got.Auto.State != store.AutoRunning {
		t.Fatalf("run = %+v", got.Auto)
	}
	e.agentSays(sess, map[string]any{"body": "It cannot be reached: CI is gone.", "task_id": gid, "task_status": "done"})
	got, _ := e.st.GetTask(ctx, gid)
	if got.Status != store.TaskDone || got.Auto.State != store.AutoStopped {
		t.Fatalf("goal after done = %s %+v", got.Status, got.Auto)
	}
	// No further continuation follows (one may be queued from the run's start).
	time.Sleep(5 * time.Millisecond)
	before, _ := e.st.PendingForSession(ctx, sess.ID, "")
	e.do("POST", "/api/agent/status", map[string]string{"status": "idle"}, bearer(sess))
	time.Sleep(5 * time.Millisecond)
	e.srv.goalTick()
	if p, _ := e.st.PendingForSession(ctx, sess.ID, ""); len(p) != len(before) {
		t.Fatalf("pending after done = %d, before %d", len(p), len(before))
	}
}

// A message that goes in no task is stored; its task_status is not applied and the note says so.
func TestSendMessageNoTaskKeepsStatusUnapplied(t *testing.T) {
	e := newEnv(t)
	sess := e.createSession()
	sent := e.agentSays(sess, map[string]any{"body": "Hello.", "task_status": "done"})
	if sent["task_id"] != "" || sent["task_status"] != "" {
		t.Fatalf("send = %v", sent)
	}
	note, _ := sent["note"].(string)
	if !strings.Contains(note, "This message is in no task yet") || !strings.Contains(note, "Its task_status (done) was not applied: set it on that task (status done).") {
		t.Fatalf("note = %q", note)
	}
}

// do2tool calls send_message through POST /api/agent/tool (protocol 1).
func (e *env) do2tool(sess *store.Session, args map[string]any) map[string]any {
	e.t.Helper()
	code, o, _ := e.do("POST", "/api/agent/tool", map[string]any{"tool": "send_message", "args": args}, bearer(sess))
	if code != 200 {
		e.t.Fatalf("tool: %d %v", code, o)
	}
	return o
}
