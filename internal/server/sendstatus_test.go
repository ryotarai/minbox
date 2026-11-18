package server

import (
	"context"
	"testing"

	"github.com/ryotarai/minbox/internal/store"
)

// send_message has no status: a call that carries one is refused with a text that says to set the
// status with update_task, nothing is stored or delivered, and the task keeps its status (a reply
// with status working used to reopen a done task).
func TestSendMessageStatusRefused(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	sess := e.createSession()
	a := e.newTask(sess, "Task A")
	if code, obj, _ := e.do("PATCH", "/api/agent/tasks/"+a, map[string]any{"status": "done"}, bearer(sess)); code != 200 {
		t.Fatalf("done: %d %v", code, obj)
	}
	count := func() int {
		msgs, _, _ := e.st.SessionMessages(ctx, sess.ID)
		return len(msgs)
	}
	before := count()
	want := "send_message has no status: a task's status is set with update_task (status working | needs_you | blocked | done). Send the message again without status."
	// Protocol 0: POST /api/agent/messages answers 400 with the text.
	for _, st := range []string{"working", "done", "bogus"} {
		code, obj, _ := e.do("POST", "/api/agent/messages", map[string]any{"body": "hi", "task_id": a, "status": st}, bearer(sess))
		if code != 400 || obj["error"] != want {
			t.Fatalf("protocol 0 status %s: %d %v", st, code, obj)
		}
	}
	// Protocol 1: POST /api/agent/tool answers ok:false with the text the agent reads.
	code, tool, _ := e.do("POST", "/api/agent/tool", map[string]any{"tool": "send_message", "args": map[string]any{"body": "hi", "task_id": a, "status": "working"}}, bearer(sess))
	if code != 200 || tool["ok"] != false || tool["error"] != "minbox: "+want {
		t.Fatalf("protocol 1: %d %v", code, tool)
	}
	if n := count(); n != before {
		t.Fatalf("a refused send stored %d message(s)", n-before)
	}
	if got, _ := e.st.GetTask(ctx, a); got.Status != store.TaskDone {
		t.Fatalf("the done task is %s", got.Status)
	}
	// An empty status is no status: the message goes out, and the task stays done.
	if code, obj, _ := e.do("POST", "/api/agent/messages", map[string]any{"body": "hi", "task_id": a, "status": " "}, bearer(sess)); code != 201 {
		t.Fatalf("empty status: %d %v", code, obj)
	}
	if got, _ := e.st.GetTask(ctx, a); got.Status != store.TaskDone {
		t.Fatalf("after a reply the done task is %s", got.Status)
	}
}
