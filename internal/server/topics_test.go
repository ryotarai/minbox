package server

import (
	"context"
	"strings"
	"testing"
	"time"
)

// topicsEvents subscribes to the hub; wait returns once a topics event for the thread arrived.
func topicsEvents(t *testing.T, e *env) (wait func(thread string), none func()) {
	ch := make(chan Event, 64)
	e.srv.hub.mu.Lock()
	e.srv.hub.subs[ch] = struct{}{}
	e.srv.hub.mu.Unlock()
	wait = func(thread string) {
		t.Helper()
		deadline := time.After(5 * time.Second)
		for {
			select {
			case ev := <-ch:
				if ev.Type == "topics" && ev.ThreadID == thread {
					return
				}
			case <-deadline:
				t.Fatal("no topics event")
			}
		}
	}
	none = func() {
		t.Helper()
		for {
			select {
			case ev := <-ch:
				if ev.Type == "topics" {
					t.Fatalf("unexpected topics event %+v", ev)
				}
			default:
				return
			}
		}
	}
	return wait, none
}

func TestAgentTasks(t *testing.T) {
	e := newEnv(t)
	wait, none := topicsEvents(t, e)
	sess := e.createSession()
	// No thread yet: create_task without a thread_id has nothing to attach to.
	if code, obj, _ := e.do("POST", "/api/agent/tasks", map[string]any{"title": "X"}, bearer(sess)); code != 400 || !strings.Contains(obj["error"].(string), "no thread") {
		t.Fatalf("no thread: %d %v", code, obj)
	}
	old := e.send(sess, "", "Old", "Earlier work", "finished")
	time.Sleep(5 * time.Millisecond)
	th := e.send(sess, "", "Search", "Shall I build search?", "working")
	thMsg, _ := e.st.GetThread(context.Background(), th)
	other := e.sessionIn("other", "other")
	otherTh := e.send(other, "", "Elsewhere", "Not yours", "working")

	// Validation.
	for _, c := range []struct {
		body map[string]any
		want string
	}{
		{map[string]any{"summary": "no title"}, "title is required"},
		{map[string]any{"title": "  "}, "title is required"},
		{map[string]any{"title": "X", "status": "bogus"}, "status must be"},
		{map[string]any{"title": "X", "check_steps": []int{1}}, "no step 1"},
		{map[string]any{"title": "X", "thread_id": otherTh}, "no thread"},
		{map[string]any{"title": "X", "thread_id": "thr_nope"}, "no thread"},
	} {
		code, obj, _ := e.do("POST", "/api/agent/tasks", c.body, bearer(sess))
		if code < 400 || !strings.Contains(obj["error"].(string), c.want) {
			t.Fatalf("%v: %d %v", c.body, code, obj)
		}
	}
	if code, _, _ := e.do("POST", "/api/agent/tasks", map[string]any{"title": "X"}, nil); code != 401 {
		t.Fatalf("no token: %d", code)
	}
	none()

	// Without thread_id: the thread with the newest activity; the newest message is linked.
	code, a, _ := e.do("POST", "/api/agent/tasks", map[string]any{
		"title": "Search UI", "summary": "Building the box", "detail": "The **box**.",
		"steps": []map[string]any{{"text": "Add the field", "done": true}, {"text": "Wire results"}},
	}, bearer(sess))
	if code != 200 || a["thread_id"] != th || a["status"] != "in_progress" || a["session_id"] != sess.ID || len(a["tasks"].([]any)) != 2 {
		t.Fatalf("create: %d %v", code, a)
	}
	if ids := a["message_ids"].([]any); len(ids) != 1 || ids[0] != thMsg.Messages[len(thMsg.Messages)-1].ID {
		t.Fatalf("linked = %v", a["message_ids"])
	}
	wait(th)
	code, b, _ := e.do("POST", "/api/agent/tasks", map[string]any{"title": "Index format", "status": "waiting_on_you", "thread_id": th}, bearer(sess))
	if code != 200 || b["status"] != "waiting_on_you" || b["position"].(float64) != 1 {
		t.Fatalf("second: %d %v", code, b)
	}
	wait(th)
	aid, bid := a["id"].(string), b["id"].(string)

	// Update: tick a step, change the summary; the rest stays.
	code, u, _ := e.do("PATCH", "/api/agent/tasks/"+aid, map[string]any{"check_steps": []int{2}, "summary": "Results wired"}, bearer(sess))
	if code != 200 || u["summary"] != "Results wired" || u["title"] != "Search UI" || u["detail"] != "The **box**." {
		t.Fatalf("update: %d %v", code, u)
	}
	if steps := u["tasks"].([]any); !steps[0].(map[string]any)["done"].(bool) || !steps[1].(map[string]any)["done"].(bool) {
		t.Fatalf("steps = %v", steps)
	}
	wait(th)
	// Steps replaced, then one unticked; a bad step number or status is refused.
	code, u, _ = e.do("PATCH", "/api/agent/tasks/"+aid, map[string]any{"steps": []map[string]any{{"text": "One", "done": true}}, "uncheck_steps": []int{1}}, bearer(sess))
	if steps := u["tasks"].([]any); code != 200 || len(steps) != 1 || steps[0].(map[string]any)["done"].(bool) {
		t.Fatalf("replace = %d %v", code, u)
	}
	if code, _, _ := e.do("PATCH", "/api/agent/tasks/"+aid, map[string]any{"check_steps": []int{3}}, bearer(sess)); code != 400 {
		t.Fatalf("bad step: %d", code)
	}
	if code, _, _ := e.do("PATCH", "/api/agent/tasks/"+aid, map[string]any{"status": "nope"}, bearer(sess)); code != 400 {
		t.Fatalf("bad status: %d", code)
	}
	if code, _, _ := e.do("PATCH", "/api/agent/tasks/"+aid, map[string]any{"thread_id": old}, bearer(sess)); code != 400 {
		t.Fatalf("other thread: %d", code)
	}
	// Another session cannot touch it, nor see it.
	if code, _, _ := e.do("PATCH", "/api/agent/tasks/"+aid, map[string]any{"status": "done"}, bearer(other)); code != 404 {
		t.Fatalf("foreign update: %d", code)
	}
	if code, _, _ := e.do("PATCH", "/api/agent/tasks/tpc_nope", map[string]any{"status": "done"}, bearer(sess)); code != 404 {
		t.Fatalf("unknown: %d", code)
	}
	if code, obj, _ := e.do("GET", "/api/agent/tasks", nil, bearer(other)); code != 200 || len(obj["threads"].([]any)) != 0 {
		t.Fatalf("other's list: %d %v", code, obj)
	}
	if code, _, _ := e.do("GET", "/api/agent/tasks?thread_id="+th, nil, bearer(other)); code != 404 {
		t.Fatalf("other's thread list: %d", code)
	}

	// A related message of another thread is never linked; one of this thread is.
	later := e.send(sess, th, "Search", "Done with the field.", "working")
	_ = later
	thMsg, _ = e.st.GetThread(context.Background(), th)
	otherMsg, _ := e.st.GetThread(context.Background(), otherTh)
	last := thMsg.Messages[len(thMsg.Messages)-1].ID
	code, u, _ = e.do("PATCH", "/api/agent/tasks/"+aid, map[string]any{"status": "done", "message_ids": []string{last, otherMsg.Messages[0].ID}}, bearer(sess))
	if ids := u["message_ids"].([]any); code != 200 || u["status"] != "done" || u["done_at"] == nil || len(ids) != 2 || ids[1] != last {
		t.Fatalf("done = %d %v", code, u)
	}

	// The person moves a card by hand; the agent may set the status again afterwards.
	code, m, _ := e.do("PATCH", "/api/topics/"+bid, map[string]any{"status": "done"}, nil)
	if code != 200 || m["manual_status"] != "done" {
		t.Fatalf("manual: %d %v", code, m)
	}
	wait(th)
	code, u, _ = e.do("PATCH", "/api/agent/tasks/"+bid, map[string]any{"status": "in_progress"}, bearer(sess))
	if code != 200 || u["status"] != "in_progress" || u["manual_status"] != "" {
		t.Fatalf("agent after the move: %d %v", code, u)
	}
	wait(th)

	// list_tasks: the session's threads that have tasks (a thread asked for by id: also when it has none).
	code, obj, _ := e.do("GET", "/api/agent/tasks", nil, bearer(sess))
	ths := rows(t, obj, "threads")
	if code != 200 || len(ths) != 1 || ths[0]["id"] != th || ths[0]["subject"] != "Search" || len(ths[0]["tasks"].([]any)) != 2 {
		t.Fatalf("list: %d %v", code, obj)
	}
	_, obj, _ = e.do("GET", "/api/agent/tasks?thread_id="+old, nil, bearer(sess))
	if ths = rows(t, obj, "threads"); len(ths) != 1 || ths[0]["id"] != old || len(ths[0]["tasks"].([]any)) != 0 {
		t.Fatalf("old thread: %v", obj)
	}

	// The board and the pane.
	_, obj, _ = e.do("GET", "/api/topics?thread="+th, nil, nil)
	if ts := rows(t, obj, "topics"); len(ts) != 2 || obj["done_days"].(float64) != 7 || ts[0]["id"] != bid {
		t.Fatalf("board = %v", obj)
	}
	code, obj, _ = e.do("GET", "/api/topics/"+aid, nil, nil)
	if ms := rows(t, obj, "messages"); code != 200 || len(ms) != 2 || ms[1]["excerpt"] != "Done with the field." {
		t.Fatalf("pane = %d %v", code, obj)
	}
	if code, _, _ := e.do("GET", "/api/topics/tpc_nope", nil, nil); code != 404 {
		t.Fatalf("missing: %d", code)
	}
	// An archived thread's tasks are off the board.
	if code, _, _ := e.do("POST", "/api/threads/"+th+"/archive", nil, nil); code != 200 {
		t.Fatal("archive")
	}
	if _, obj, _ = e.do("GET", "/api/topics", nil, nil); len(obj["topics"].([]any)) != 0 {
		t.Fatalf("archived thread's topics shown: %v", obj)
	}
}

// The retired topics setting (the helper-model extraction's switch) is not a setting any more.
func TestTopicsSettingRetired(t *testing.T) {
	e := newEnv(t)
	_, st, _ := e.do("GET", "/api/settings", nil, nil)
	if _, ok := st["topics"]; ok {
		t.Fatalf("settings = %v", st)
	}
	if code, _, _ := e.do("PUT", "/api/settings", map[string]any{"topics": false}, nil); code != 400 {
		t.Fatalf("put topics: %d", code)
	}
}
