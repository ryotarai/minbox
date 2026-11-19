package server

import (
	"context"
	"testing"
)

func boardTaskOf(t *testing.T, e *env, id any) map[string]any {
	t.Helper()
	_, board, _ := e.do("GET", "/api/v3/board", nil, nil)
	for _, x := range board["tasks"].([]any) {
		if bt := x.(map[string]any); bt["id"] == id {
			return bt
		}
	}
	t.Fatalf("task %v not on the Board", id)
	return nil
}

func TestV3IgnoreQuestions(t *testing.T) {
	e := newEnv(t)
	sess := e.createSession()
	e.personSays(sess, "rename things")
	_, tk, _ := e.do("POST", "/api/agent/tasks", map[string]any{"title": "Naming"}, bearer(sess))
	q := e.agentSays(sess, map[string]any{"body": "Two things.\n\n:::question\nRename it in the UI?\n- [ ] Yes\n- [ ] No\n:::\n\n:::question-text\nWhat name?\n:::"})
	msgID := q["message_id"].(string)
	keys := []string{}
	for _, x := range q["questions"].([]any) {
		keys = append(keys, x.(map[string]any)["key"].(string))
	}
	if bt := boardTaskOf(t, e, tk["task_id"]); bt["status"] != "working" || bt["open_questions"].(float64) != 2 {
		t.Fatalf("before: %v", bt)
	}

	// One question by key: the other stays open.
	if code, obj, _ := e.do("POST", "/api/v3/messages/"+msgID+"/ignore", map[string]any{"key": keys[0]}, nil); code != 200 {
		t.Fatalf("ignore: %d %v", code, obj)
	}
	if bt := boardTaskOf(t, e, tk["task_id"]); bt["status"] != "working" || bt["open_questions"].(float64) != 1 {
		t.Fatalf("after one: %v", bt)
	}
	// The whole message: no question left open; the status is untouched.
	if code, _, _ := e.do("POST", "/api/v3/messages/"+msgID+"/ignore", nil, nil); code != 200 {
		t.Fatalf("ignore all: %d", code)
	}
	bt := boardTaskOf(t, e, tk["task_id"])
	if bt["open_questions"].(float64) != 0 || bt["status"] != "working" {
		t.Fatalf("after all: %v", bt)
	}
	// The message says ignored (closed reason and when).
	m, err := e.st.GetMessage(context.Background(), msgID)
	if err != nil || len(m.Ignored) != 2 {
		t.Fatalf("ignored = %v %v", m, err)
	}
	ths, _ := e.st.ListThreads(context.Background(), sess.ID)
	for _, th := range ths {
		for _, x := range th.Messages {
			if x.ID == msgID && (x.Closed[keys[0]] != "ignored" || x.Closed[keys[1]] != "ignored") {
				t.Fatalf("closed = %v", x.Closed)
			}
		}
		if th.OpenQuestions != 0 {
			t.Fatalf("thread open = %d", th.OpenQuestions)
		}
	}
	// Nothing is sent to the agent.
	if p, err := e.st.PendingForSession(context.Background(), sess.ID, ""); err != nil || len(p) != 0 {
		t.Fatalf("pending = %v %v", p, err)
	}

	// Unignore one: it is open again.
	if code, _, _ := e.do("POST", "/api/v3/messages/"+msgID+"/unignore", map[string]any{"key": keys[1]}, nil); code != 200 {
		t.Fatalf("unignore: %d", code)
	}
	if bt := boardTaskOf(t, e, tk["task_id"]); bt["status"] != "working" || bt["open_questions"].(float64) != 1 {
		t.Fatalf("after unignore: %v", bt)
	}

	// An unknown key, a message without questions, a missing message.
	if code, _, _ := e.do("POST", "/api/v3/messages/"+msgID+"/ignore", map[string]any{"key": "nope"}, nil); code != 400 {
		t.Fatalf("unknown key: %d", code)
	}
	plain := e.agentSays(sess, map[string]any{"body": "Just a note."})
	if code, _, _ := e.do("POST", "/api/v3/messages/"+plain["message_id"].(string)+"/ignore", nil, nil); code != 400 {
		t.Fatalf("no questions: %d", code)
	}
	if code, _, _ := e.do("POST", "/api/v3/messages/missing/ignore", nil, nil); code != 404 {
		t.Fatalf("missing: %d", code)
	}
}

// A task the agent set to needs_you keeps it when its question is ignored.
func TestV3IgnoreKeepsExplicitNeedsYou(t *testing.T) {
	e := newEnv(t)
	sess := e.createSession()
	e.personSays(sess, "ship it")
	_, tk, _ := e.do("POST", "/api/agent/tasks", map[string]any{"title": "Ship", "status": "needs_you"}, bearer(sess))
	q := e.agentSays(sess, map[string]any{"task_status": "needs_you", "body": ":::question\nShip now?\n- [ ] Yes\n- [ ] No\n:::"})
	if code, _, _ := e.do("POST", "/api/v3/messages/"+q["message_id"].(string)+"/ignore", nil, nil); code != 200 {
		t.Fatalf("ignore: %d", code)
	}
	bt := boardTaskOf(t, e, tk["task_id"])
	if bt["status"] != "needs_you" || bt["open_questions"].(float64) != 0 {
		t.Fatalf("task = %v", bt)
	}
}

// NEEDS YOU is the tasks set to needs_you: an open question (however old) never puts a task or a
// question there, and the per-agent count is the agent's needs_you tasks, not its open questions.
func TestBoardNeedsYouIsTaskStatusOnly(t *testing.T) {
	e := newEnv(t)
	sess := e.createSession()
	e.personSays(sess, "two things")
	asked := e.newTask(sess, "Asked")
	waits := e.newTask(sess, "Waits")
	e.agentSays(sess, map[string]any{"task_id": asked, "body": ":::question\nShip now?\n- [ ] Yes\n- [ ] No\n:::"})
	// A question with no task at all.
	e.agentSays(sess, map[string]any{"body": ":::question\nAnything else?\n- [ ] Yes\n- [ ] No\n:::"})
	if code, obj, _ := e.do("PATCH", "/api/agent/tasks/"+waits, map[string]any{"status": "needs_you"}, bearer(sess)); code != 200 {
		t.Fatalf("needs_you: %d %v", code, obj)
	}
	e.agentSays(sess, map[string]any{"task_id": waits, "task_status": "needs_you", "body": "Please check the gauge."})

	_, board, _ := e.do("GET", "/api/v3/board", nil, nil)
	if _, ok := board["questions"]; ok {
		t.Fatalf("per-question entries on the Board: %v", board["questions"])
	}
	needs := []string{}
	for _, x := range board["tasks"].([]any) {
		bt := x.(map[string]any)
		if _, ok := bt["needs_you"]; ok {
			t.Fatalf("a derived needs_you on %v", bt)
		}
		if bt["status"] == "needs_you" {
			needs = append(needs, bt["id"].(string))
		}
	}
	if len(needs) != 1 || needs[0] != waits {
		t.Fatalf("needs you = %v, want [%s]", needs, waits)
	}
	if bt := boardTaskOf(t, e, asked); bt["status"] != "working" || bt["open_questions"].(float64) != 1 {
		t.Fatalf("asked = %v", bt)
	}
	a := board["agents"].(map[string]any)[sess.ID].(map[string]any)
	if a["needs_you"].(float64) != 1 {
		t.Fatalf("agent counts = %v", a)
	}
	if _, ok := a["open_questions"]; ok {
		t.Fatalf("agent counts open questions: %v", a)
	}
}
