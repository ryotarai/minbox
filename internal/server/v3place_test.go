package server

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/ryotarai/minbox/internal/store"
)

// takePending claims and delivers the session's pending messages (the agent took them in a turn).
func (e *env) takePending(sess *store.Session) []store.PendingDelivery {
	e.t.Helper()
	pend, _ := e.st.PendingForSession(context.Background(), sess.ID, "")
	for _, p := range pend {
		e.do("POST", "/api/agent/pending/"+p.ID+"/claim?owner=o", nil, bearer(sess))
		e.do("POST", "/api/agent/pending/"+p.ID+"/delivered?owner=o", nil, bearer(sess))
	}
	return pend
}

// idle ends the agent's turn and waits a little (minbox used to ask about unplaced messages then).
func (e *env) idle(sess *store.Session) {
	e.do("POST", "/api/agent/status", map[string]string{"status": "idle"}, bearer(sess))
	time.Sleep(50 * time.Millisecond)
}

// A turn that leaves messages in no task: minbox does not ask the agent to place them (no message
// to the agent, nothing in the stream); they stay in no task until the agent places them.
func TestV3NoPlaceRequestAfterTurn(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	sess := e.createSession()
	u := e.personSays(sess, "thanks!")
	e.do("POST", "/api/agent/status", map[string]string{"status": "working"}, bearer(sess))
	r := e.agentSays(sess, map[string]any{"body": "You're welcome."})
	reply := r["message_id"].(string)
	// send_message's own answer still says the message is in no task.
	if note, _ := r["note"].(string); !strings.Contains(note, "in no task") || !strings.Contains(note, u) {
		t.Fatalf("send_message note = %q", note)
	}
	e.idle(sess)
	e.do("POST", "/api/agent/status", map[string]string{"status": "working"}, bearer(sess))
	e.idle(sess)
	if p, _ := e.st.PendingForSession(ctx, sess.ID, ""); len(p) != 0 {
		t.Fatalf("asked the agent: %+v", p)
	}
	stream, _ := e.st.StreamThread(ctx, sess.ID)
	th, err := e.st.GetThread(ctx, stream)
	if err != nil {
		t.Fatal(err)
	}
	if len(th.Messages) != 2 {
		t.Fatalf("stream = %+v", th.Messages)
	}
	for _, m := range th.Messages {
		if m.Kind == store.KindPlace {
			t.Fatalf("a request to place messages: %+v", m)
		}
	}
	for _, id := range []string{u, reply} {
		if got := tagIDs(t, e, id); len(got) != 0 {
			t.Fatalf("%s in %v", id, got)
		}
	}
	// The agent places them itself: create_task with the reply (its turn comes along).
	code, obj, _ := e.do("POST", "/api/agent/tasks", map[string]any{"title": "Thanks", "status": "done", "message_ids": []string{reply}}, bearer(sess))
	if code != 200 {
		t.Fatalf("create: %d %v", code, obj)
	}
	tid := obj["task_id"].(string)
	for _, id := range []string{u, reply} {
		if got := tagIDs(t, e, id); len(got) != 1 || got[0] != tid {
			t.Fatalf("%s in %v, want %s", id, got, tid)
		}
	}
}

// An older request to place messages (stored before this was dropped) is not in the v3 stream.
func TestV3OldPlaceRequestHidden(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	sess := e.createSession()
	u := e.personSays(sess, "hi")
	stream, _ := e.st.StreamThread(ctx, sess.ID)
	old, err := e.st.AddMessage(ctx, stream, store.NewMessage{Author: store.AuthorUser, Body: "place them", Words: "Asked s to put 1 message(s) in tasks.", Kind: store.KindPlace, Delivered: true})
	if err != nil {
		t.Fatal(err)
	}
	code, obj, _ := e.do("GET", "/api/v3/sessions/"+sess.ID+"/stream", nil, nil)
	if code != 200 {
		t.Fatalf("stream: %d %v", code, obj)
	}
	ids := []string{}
	for _, m := range obj["messages"].([]any) {
		ids = append(ids, m.(map[string]any)["id"].(string))
	}
	if strings.Join(ids, ",") != u {
		t.Fatalf("stream = %v (old %s)", ids, old.ID)
	}
}

// The person cannot take a message out of its last task; moving it is fine.
func TestV3LastTaskStays(t *testing.T) {
	e := newEnv(t)
	sess := e.createSession()
	u := e.personSays(sess, "fix it")
	_, a, _ := e.do("POST", "/api/agent/tasks", map[string]any{"title": "A"}, bearer(sess))
	r := e.agentSays(sess, map[string]any{"body": "ok"})
	_, b, _ := e.do("POST", "/api/v3/tasks", map[string]any{"title": "B", "project_id": sess.ProjectID}, nil)
	ta, tb := a["task_id"].(string), b["id"].(string)
	if code, _, _ := e.do("DELETE", "/api/v3/messages/"+u+"/tasks/"+ta, nil, nil); code != 409 {
		t.Fatalf("unlink last: %d", code)
	}
	if code, _, _ := e.do("POST", "/api/v3/messages/"+u+"/tasks", map[string]any{"task_id": tb}, nil); code != 200 {
		t.Fatalf("link: %d", code)
	}
	if code, _, _ := e.do("DELETE", "/api/v3/messages/"+u+"/tasks/"+ta, nil, nil); code != 200 {
		t.Fatalf("unlink one of two: %d", code)
	}
	if code, _, _ := e.do("POST", "/api/v3/messages/"+r["message_id"].(string)+"/move", map[string]any{"from": ta, "to": tb}, nil); code != 200 {
		t.Fatalf("move: %d", code)
	}
	if got := tagIDs(t, e, r["message_id"].(string)); len(got) != 1 || got[0] != tb {
		t.Fatalf("moved reply in %v", got)
	}
}
