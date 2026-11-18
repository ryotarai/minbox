package server

import (
	"context"
	"strings"
	"testing"

	"github.com/ryotarai/minbox/internal/store"
)

// The older send_message contract (thread_id / thread_title), as agents started before v3 still call
// it (its status is refused: TestSendMessageStatusRefused): every message lands in the session's stream; an older thread's id says which task it
// is about; thread_title only finds an open task with that name; nothing gets renamed or created.
func TestAgentLegacyThreadContract(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	sess := e.createSession()
	subject := func(id string) string {
		_, obj, _ := e.do("GET", "/api/threads/"+id, nil, nil)
		return obj["subject"].(string)
	}
	// No thread: the stream. A thread_title never renames it.
	r1 := e.agentSays(sess, map[string]any{"body": "First line\nmore", "thread_title": "a reply"})
	stream := r1["thread_id"].(string)
	if got := subject(stream); got != "" {
		t.Fatalf("the stream got a title: %q", got)
	}
	if r2 := e.agentSays(sess, map[string]any{"body": "again", "subject": "Via alias"}); r2["thread_id"] != stream {
		t.Fatalf("not the stream: %v", r2)
	}
	// An older thread with a task made from it: the message goes to the stream, about that task.
	old, err := e.st.NewSegmentThread(ctx, sess.ID, "update readme")
	if err != nil {
		t.Fatal(err)
	}
	task, _ := e.st.CreateTask(ctx, sess.ProjectID, sess.ID, store.TaskFields{Title: ptrS("Update the readme")})
	if err := e.st.SetTaskOrigin(ctx, task.ID, "thread:"+old); err != nil {
		t.Fatal(err)
	}
	r3 := e.agentSays(sess, map[string]any{"body": "Done with the readme.", "thread_id": old, "thread_title": "a reply"})
	if r3["thread_id"] != stream {
		t.Fatalf("legacy thread_id: went to %v, not the stream", r3["thread_id"])
	}
	if ids := r3["task_ids"].([]any); len(ids) != 1 || ids[0] != task.ID {
		t.Fatalf("legacy thread_id → task: %v", r3)
	}
	// thread_title = an open task's title: about it. Any other title: nothing (no task is made).
	other, _ := e.st.CreateTask(ctx, sess.ProjectID, sess.ID, store.TaskFields{Title: ptrS("Fix the gauge")})
	r4 := e.agentSays(sess, map[string]any{"body": "gauge fixed?", "thread_title": "fix the  gauge"})
	if ids := r4["task_ids"].([]any); len(ids) != 1 || ids[0] != other.ID {
		t.Fatalf("thread_title → open task: %v", r4)
	}
	before, _ := e.st.ListTasks(ctx, store.TaskQuery{ProjectID: sess.ProjectID})
	r5 := e.agentSays(sess, map[string]any{"body": "x", "thread_title": "Some other words"})
	after, _ := e.st.ListTasks(ctx, store.TaskQuery{ProjectID: sess.ProjectID})
	if len(r5["task_ids"].([]any)) != 0 || len(after) != len(before) {
		t.Fatalf("an unknown thread_title made something: %v", r5)
	}
	// Another session's thread id: ignored (its own stream).
	b := e.createSession()
	if rb := e.agentSays(b, map[string]any{"body": "x", "thread_id": old}); rb["thread_id"] == old || len(rb["task_ids"].([]any)) != 0 {
		t.Fatalf("cross-session thread_id: %v", rb)
	}
}

func ptrS(s string) *string { return &s }

// create_task warns about an open task that looks like the same work.
func TestCreateTaskSimilar(t *testing.T) {
	e := newEnv(t)
	sess := e.createSession()
	_, first, _ := e.do("POST", "/api/agent/tasks", map[string]any{"title": "Slack の PDF 添付を認識しない"}, bearer(sess))
	code, again, _ := e.do("POST", "/api/agent/tasks", map[string]any{"title": "Slack の PDF 添付を認識しない問題"}, bearer(sess))
	if code != 200 {
		t.Fatalf("create: %d", code)
	}
	sim, _ := again["similar_tasks"].([]any)
	if len(sim) != 1 || sim[0].(map[string]any)["id"] != first["task_id"] || !strings.Contains(again["note"].(string), "similar") {
		t.Fatalf("similar = %v", again)
	}
	_, third, _ := e.do("POST", "/api/agent/tasks", map[string]any{"title": "Dark mode toggle"}, bearer(sess))
	if _, ok := third["similar_tasks"]; ok {
		t.Fatalf("unrelated title warned: %v", third)
	}
}

func TestAgentSessionTitleKeptInFull(t *testing.T) {
	e := newEnv(t)
	sess := e.createSession()
	long := "a  long\ntitle " + strings.Repeat("あ", 200)
	code, obj, _ := e.do("POST", "/api/agent/title", map[string]any{"title": long}, bearer(sess))
	want := "a long title " + strings.Repeat("あ", 200)
	if code != 200 || obj["title"] != want {
		t.Fatalf("code %d title %v", code, obj["title"])
	}
	got, _ := e.st.GetSession(context.Background(), sess.ID)
	if got.Title != want {
		t.Fatalf("stored %q", got.Title)
	}
}
