package server

import (
	"context"
	"strings"
	"testing"

	"github.com/ryotarai/minbox/internal/store"
)

// A message from the person about a done task leaves it done (it used to reopen it, "Reopened by
// your message"): the wake text says the task is done and that the agent reopens it with
// update_task only if the message asks for more work; the agent's update_task status working does.
func TestPersonMessageKeepsDoneTaskDone(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	sess := e.createSession()
	a := e.newTask(sess, "Fix the gauge")
	if code, obj, _ := e.do("PATCH", "/api/agent/tasks/"+a, map[string]any{"status": "done"}, bearer(sess)); code != 200 {
		t.Fatalf("done: %d %v", code, obj)
	}
	statusEvents := func() int {
		evs, _ := e.st.TaskEvents(ctx, a)
		n := 0
		for _, ev := range evs {
			if ev.Kind == "status" {
				n++
			}
		}
		return n
	}
	before := statusEvents()

	// The person writes from the done task's view.
	code, obj, _ := e.do("POST", "/api/v3/sessions/"+sess.ID+"/messages", map[string]any{"words": "thanks, looks good", "task_ids": []string{a}}, nil)
	if code != 201 {
		t.Fatalf("person: %d %v", code, obj)
	}
	id := obj["id"].(string)
	if got, _ := e.st.GetTask(ctx, a); got.Status != store.TaskDone {
		t.Fatalf("the done task is %s after the person's message", got.Status)
	}
	if n := statusEvents(); n != before {
		t.Fatalf("%d status event(s) added by the person's message", n-before)
	}
	if ids := tagIDs(t, e, id); len(ids) != 1 || ids[0] != a {
		t.Fatalf("message tags = %v", ids)
	}

	// The wake text names the task as done and says when to reopen it.
	_, pend, _ := e.do("GET", "/api/agent/pending?owner=o&proto=1", nil, bearer(sess))
	items := pend["items"].([]any)
	if len(items) != 1 {
		t.Fatalf("pending: %v", pend)
	}
	text := items[0].(map[string]any)["text"].(string)
	want := "The task is done: reopen it with mcp__minbox__update_task status working only if their message asks for more work (a remark or a quick question leaves it done)."
	if !strings.Contains(text, `"Fix the gauge" (done)`) || !strings.Contains(text, want) {
		t.Fatalf("wake text:\n%s", text)
	}
	e.deliverMsg(sess, id)

	// The agent decides there is more work: update_task status working reopens it.
	if code, obj, _ := e.do("PATCH", "/api/agent/tasks/"+a, map[string]any{"status": "working"}, bearer(sess)); code != 200 {
		t.Fatalf("reopen: %d %v", code, obj)
	}
	if got, _ := e.st.GetTask(ctx, a); got.Status != store.TaskWorking {
		t.Fatalf("after update_task the task is %s", got.Status)
	}
	evs, _ := e.st.SessionTaskEvents(ctx, sess.ID, nil, nil)
	if last := evs[len(evs)-1]; last.Kind != "status" || !last.Reopened || last.ByYou {
		t.Fatalf("last stream event = %+v", last)
	}

	// An open task gets no done line.
	e.personSays(sess, "and the other gauge?", a)
	if strings.Contains(wakeText(wakeMsg{ID: "m", Stream: true, Body: "x", Tasks: []wakeTask{{ID: a, Title: "t", Status: "working"}}}, "s", "r"), "The task is done") {
		t.Fatal("done line on an open task")
	}
}

// An agent question on a done task: the task stays done (its status decides; the open question counts
// on it), and answering it does not reopen the task.
func TestQuestionOnDoneTaskStaysDone(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	sess := e.createSession()
	a := e.newTask(sess, "Ship docs")
	if code, obj, _ := e.do("PATCH", "/api/agent/tasks/"+a, map[string]any{"status": "done"}, bearer(sess)); code != 200 {
		t.Fatalf("done: %d %v", code, obj)
	}
	sent := e.agentSays(sess, map[string]any{"task_id": a, "body": ":::question\nPublish too?\n- [ ] Yes\n- [ ] No\n:::"})
	thread, msg := sent["thread_id"].(string), sent["message_id"].(string)
	key := sent["questions"].([]any)[0].(map[string]any)["key"].(string)

	_, board, _ := e.do("GET", "/api/v3/board?project="+sess.ProjectID, nil, nil)
	var card map[string]any
	for _, x := range board["tasks"].([]any) {
		if x := x.(map[string]any); x["id"] == a {
			card = x
		}
	}
	if card == nil || card["status"] != "done" || card["open_questions"].(float64) != 1 {
		t.Fatalf("card = %v", card)
	}

	if code, _, _ := e.do("POST", "/api/threads/"+thread+"/reply", map[string]any{"words": "", "answers_for": msg,
		"answers": []map[string]any{{"key": key, "selected": []string{"Yes"}}}}, nil); code != 201 {
		t.Fatalf("answer: %d", code)
	}
	if got, _ := e.st.GetTask(ctx, a); got.Status != store.TaskDone {
		t.Fatalf("after the answer the task is %s", got.Status)
	}
}
