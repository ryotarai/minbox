package server

import (
	"context"
	"testing"
	"time"

	"github.com/ryotarai/minbox/internal/store"
)

func sessionJSON(e *env, id string) map[string]any {
	_, _, arr := e.do("GET", "/api/sessions", nil, nil)
	for _, v := range arr {
		m := v.(map[string]any)
		if m["id"] == id {
			return m
		}
	}
	e.t.Fatalf("session %s not listed", id)
	return nil
}

func TestModSeenAndSilent(t *testing.T) {
	e := newEnv(t)
	e.srv.modSilentAfter = 300 * time.Millisecond
	sess := e.createSession()
	_ = e.st.SetSessionStatus(context.Background(), sess.ID, store.StatusIdle)

	if m := sessionJSON(e, sess.ID); m["mod_seen_at"] != nil {
		t.Fatalf("mod_seen_at before any call = %v", m["mod_seen_at"])
	}
	e.do("GET", "/api/agent/pending?owner=o", nil, bearer(sess))
	m := sessionJSON(e, sess.ID)
	if m["mod_seen_at"] == nil || m["mod_silent"] != false {
		t.Fatalf("after a call: %v %v", m["mod_seen_at"], m["mod_silent"])
	}
	events := make(chan Event, 16)
	e.srv.hub.mu.Lock()
	e.srv.hub.subs[events] = struct{}{}
	e.srv.hub.mu.Unlock()

	time.Sleep(500 * time.Millisecond)
	if m := sessionJSON(e, sess.ID); m["mod_silent"] != true {
		t.Fatalf("silent expected: %v", m["mod_silent"])
	}
	// Going silent published a sessions event (by timer); coming back publishes one too.
	waitEvent := func(why string) {
		select {
		case <-events:
		case <-time.After(2 * time.Second):
			t.Fatalf("no sessions event: %s", why)
		}
	}
	waitEvent("flip to silent")
	e.do("GET", "/api/agent/pending?owner=o", nil, bearer(sess))
	waitEvent("mod came back")
	if m := sessionJSON(e, sess.ID); m["mod_silent"] != false {
		t.Fatalf("back: %v", m["mod_silent"])
	}
}

func TestSendNowMakesPendingUrgentAndCloseEndsPolls(t *testing.T) {
	e := newEnv(t)
	sess := e.createSession()
	_, sent, _ := e.do("POST", "/api/agent/messages", map[string]string{"body": "done", "subject": "S"}, bearer(sess))
	thread := sent["thread_id"].(string)
	_, msg, _ := e.do("POST", "/api/threads/"+thread+"/reply", map[string]any{"words": "hello"}, nil)
	_, _, pending := e.do("GET", "/api/agent/pending?owner=o", nil, bearer(sess))
	if len(pending) != 1 || pending[0].(map[string]any)["urgent"] == true {
		t.Fatalf("pending = %v", pending)
	}
	if code, _, _ := e.do("POST", "/api/messages/"+msg["id"].(string)+"/send-now", nil, nil); code != 200 {
		t.Fatalf("send-now: %d", code)
	}
	_, _, pending = e.do("GET", "/api/agent/pending?owner=o", nil, bearer(sess))
	if len(pending) != 1 || pending[0].(map[string]any)["urgent"] != true {
		t.Fatalf("pending after send-now = %v", pending)
	}

	// A poll that waits ends at once, with an empty list, when the server closes.
	other := e.createSession()
	done := make(chan []any, 1)
	go func() {
		_, _, arr := e.do("GET", "/api/agent/pending?owner=o&wait=20", nil, bearer(other))
		done <- arr
	}()
	time.Sleep(200 * time.Millisecond)
	e.srv.Close()
	select {
	case arr := <-done:
		if len(arr) != 0 {
			t.Fatalf("arr = %v", arr)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("long poll survived Close")
	}
}
