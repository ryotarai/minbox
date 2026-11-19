package server

import "testing"

func TestThreadStatusAPI(t *testing.T) {
	e := newEnv(t)
	sess := e.createSession()
	send := func(m map[string]any) (int, map[string]any) {
		m["task_status"] = "working"
		code, obj, _ := e.do("POST", "/api/agent/messages", m, bearer(sess))
		return code, obj
	}
	status := func(id string) string {
		_, obj, _ := e.do("GET", "/api/threads/"+id, nil, nil)
		return obj["status"].(string)
	}
	code, obj := send(map[string]any{"body": "hello"})
	if code != 201 {
		t.Fatalf("send: %d", code)
	}
	id := obj["thread_id"].(string)
	if status(id) != "finished" { // an agent message without a question: finished
		t.Fatalf("no status = %s", status(id))
	}
	send(map[string]any{"body": ":::question\nA or B?\n- [ ] A\n- [ ] B\n:::", "thread_id": id})
	if status(id) != "need_action" {
		t.Fatalf("question = %s", status(id))
	}
	if code, _, _ := e.do("POST", "/api/threads/"+id+"/reply", map[string]any{"words": "A"}, nil); code != 201 {
		t.Fatalf("reply: %d", code)
	}
	if status(id) != "working" {
		t.Fatalf("reply = %s", status(id))
	}
	if code, _, _ := e.do("POST", "/api/threads/"+id+"/status", map[string]any{"status": "finished"}, nil); code != 200 {
		t.Fatalf("set: %d", code)
	}
	if status(id) != "finished" {
		t.Fatalf("set = %s", status(id))
	}
	if code, _, _ := e.do("POST", "/api/threads/"+id+"/status", map[string]any{"status": "nope"}, nil); code != 400 {
		t.Fatalf("set bogus: %d", code)
	}
}
