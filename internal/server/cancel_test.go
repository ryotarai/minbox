package server

import "testing"

func TestCancelQueuedMessage(t *testing.T) {
	e := newEnv(t)
	sess := e.createSession()
	_, sent, _ := e.do("POST", "/api/agent/messages", map[string]any{"body": "hi", "subject": "S"}, bearer(sess))
	tid := sent["thread_id"].(string)

	_, a, _ := e.do("POST", "/api/threads/"+tid+"/reply", map[string]any{"words": "first"}, nil)
	_, b, _ := e.do("POST", "/api/threads/"+tid+"/reply", map[string]any{"words": "second"}, nil)
	aid, bid := a["id"].(string), b["id"].(string)

	code, obj, _ := e.do("POST", "/api/messages/"+aid+"/cancel", nil, nil)
	if code != 200 || obj["thread_deleted"] != false {
		t.Fatalf("cancel: %d %v", code, obj)
	}
	_, _, pending := e.do("GET", "/api/agent/pending?owner=o", nil, bearer(sess))
	if len(pending) != 1 || pending[0].(map[string]any)["id"] != bid {
		t.Fatalf("pending = %v", pending)
	}
	if code, _, _ := e.do("POST", "/api/messages/"+aid+"/cancel", nil, nil); code != 404 {
		t.Fatalf("cancel again: %d", code)
	}
	// In flight (claimed) or delivered: 409.
	e.do("POST", "/api/agent/pending/"+bid+"/claim?owner=o", nil, bearer(sess))
	if code, _, _ := e.do("POST", "/api/messages/"+bid+"/cancel", nil, nil); code != 409 {
		t.Fatalf("cancel claimed: %d", code)
	}
	e.do("POST", "/api/agent/pending/"+bid+"/delivered?owner=o", nil, bearer(sess))
	if code, _, _ := e.do("POST", "/api/messages/"+bid+"/cancel", nil, nil); code != 409 {
		t.Fatalf("cancel delivered: %d", code)
	}
	// An agent message is not cancellable.
	_, th, _ := e.do("GET", "/api/threads/"+tid, nil, nil)
	first := th["messages"].([]any)[0].(map[string]any)["id"].(string)
	if code, _, _ := e.do("POST", "/api/messages/"+first+"/cancel", nil, nil); code != 409 {
		t.Fatalf("cancel agent message: %d", code)
	}
}
