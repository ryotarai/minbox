package server

import "testing"

func projectNeedsYou(t *testing.T, e *env, id string) float64 {
	t.Helper()
	code, _, list := e.do("GET", "/api/projects", nil, nil)
	if code != 200 {
		t.Fatalf("projects: %d", code)
	}
	for _, x := range list {
		if p := x.(map[string]any); p["id"] == id {
			return p["needs_you"].(float64)
		}
	}
	t.Fatalf("project %s not listed", id)
	return 0
}

// A project's needs_you (the project rail's badge) is its tasks and goals whose status is needs_you:
// an open question alone never counts, and a task leaving needs_you leaves the count.
func TestProjectNeedsYouCountsTaskStatusOnly(t *testing.T) {
	e := newEnv(t)
	sess := e.createSession()
	e.personSays(sess, "two things")
	asked := e.newTask(sess, "Asked")
	e.agentSays(sess, map[string]any{"task_id": asked, "body": ":::question\nShip now?\n- [ ] Yes\n- [ ] No\n:::"})
	e.agentSays(sess, map[string]any{"body": ":::question\nAnything else?\n- [ ] Yes\n- [ ] No\n:::"})
	if n := projectNeedsYou(t, e, sess.ProjectID); n != 0 {
		t.Fatalf("open questions alone: needs_you = %v, want 0", n)
	}

	waits := e.newTask(sess, "Waits")
	if code, obj, _ := e.do("PATCH", "/api/agent/tasks/"+waits, map[string]any{"status": "needs_you"}, bearer(sess)); code != 200 {
		t.Fatalf("needs_you: %d %v", code, obj)
	}
	// A goal set to needs_you by the person counts too.
	code, g, _ := e.do("POST", "/api/v3/tasks", map[string]any{"project_id": sess.ProjectID, "title": "Green CI", "kind": "goal"}, nil)
	if code != 201 {
		t.Fatalf("goal: %d %v", code, g)
	}
	if code, obj, _ := e.do("PATCH", "/api/v3/tasks/"+g["id"].(string), map[string]any{"status": "needs_you"}, nil); code != 200 {
		t.Fatalf("goal needs_you: %d %v", code, obj)
	}
	if n := projectNeedsYou(t, e, sess.ProjectID); n != 2 {
		t.Fatalf("needs_you = %v, want 2", n)
	}

	// Done: it leaves the count.
	if code, obj, _ := e.do("PATCH", "/api/agent/tasks/"+waits, map[string]any{"status": "done"}, bearer(sess)); code != 200 {
		t.Fatalf("done: %d %v", code, obj)
	}
	if n := projectNeedsYou(t, e, sess.ProjectID); n != 1 {
		t.Fatalf("after done: needs_you = %v, want 1", n)
	}
}
