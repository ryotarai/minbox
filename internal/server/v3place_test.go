package server

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/ryotarai/minbox/internal/store"
)

func shortPlace(t *testing.T) {
	oldS, oldW := placeSettle, placeWait
	placeSettle, placeWait = 0, 0
	t.Cleanup(func() { placeSettle, placeWait = oldS, oldW })
}

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

func (e *env) idle(sess *store.Session) {
	e.do("POST", "/api/agent/status", map[string]string{"status": "idle"}, bearer(sess))
	time.Sleep(5 * time.Millisecond)
	e.srv.placeCheck(sess.ID)
}

// A turn that leaves messages in no task ends with minbox asking the agent to place them, again after
// every turn that leaves them, until it does; the requests then belong to those tasks too.
func TestV3PlaceAsksUntilPlaced(t *testing.T) {
	shortPlace(t)
	e := newEnv(t)
	ctx := context.Background()
	sess := e.createSession()
	u := e.personSays(sess, "thanks!")
	r := e.agentSays(sess, map[string]any{"body": "You're welcome."})
	reply := r["message_id"].(string)
	if note, _ := r["note"].(string); !strings.Contains(note, "in no task") || !strings.Contains(note, u) {
		t.Fatalf("send_message note = %q", note)
	}
	e.idle(sess)
	pend := e.takePending(sess)
	if len(pend) != 1 || pend[0].Kind != store.KindPlace || !strings.Contains(pend[0].Body, u) || !strings.Contains(pend[0].Body, reply) || !strings.Contains(pend[0].Body, "create_task") {
		t.Fatalf("first request = %+v", pend)
	}
	// Not idle again since: no second request.
	e.srv.placeCheck(sess.ID)
	if p, _ := e.st.PendingForSession(ctx, sess.ID, ""); len(p) != 0 {
		t.Fatalf("asked twice in one idle: %+v", p)
	}
	// The agent ignores it (a turn without placing anything): asked again.
	e.do("POST", "/api/agent/status", map[string]string{"status": "working"}, bearer(sess))
	e.idle(sess)
	pend2 := e.takePending(sess)
	if len(pend2) != 1 || pend2[0].Kind != store.KindPlace {
		t.Fatalf("second request = %+v", pend2)
	}
	// It places them: create_task with the reply (its turn comes along), status done.
	code, obj, _ := e.do("POST", "/api/agent/tasks", map[string]any{"title": "Thanks", "status": "done", "message_ids": []string{reply}}, bearer(sess))
	if code != 200 {
		t.Fatalf("create: %d %v", code, obj)
	}
	tid := obj["task_id"].(string)
	for _, id := range []string{u, reply, pend[0].ID, pend2[0].ID} {
		if got := tagIDs(t, e, id); len(got) != 1 || got[0] != tid {
			t.Fatalf("%s in %v, want %s", id, got, tid)
		}
	}
	e.idle(sess)
	if p, _ := e.st.PendingForSession(ctx, sess.ID, ""); len(p) != 0 {
		t.Fatalf("asked with nothing left: %+v", p)
	}
	if left, _ := e.st.UnplacedMessages(ctx, sess.ID); len(left) != 0 {
		t.Fatalf("unplaced = %+v", left)
	}
}

// Not while one of its questions waits on the person, nor while the person's message is on its way.
func TestV3PlaceWaits(t *testing.T) {
	shortPlace(t)
	e := newEnv(t)
	ctx := context.Background()
	sess := e.createSession()
	e.agentSays(sess, map[string]any{"body": "Which one?\n\n:::question\nPick\n- [ ] A\n- [ ] B\n:::"})
	e.idle(sess)
	if p, _ := e.st.PendingForSession(ctx, sess.ID, ""); len(p) != 0 {
		t.Fatalf("asked while a question is open: %+v", p)
	}
	code, m, _ := e.do("POST", "/api/v3/sessions/"+sess.ID+"/messages", map[string]any{"words": "later"}, nil)
	if code != 201 {
		t.Fatalf("send: %d %v", code, m)
	}
	e.idle(sess)
	if p, _ := e.st.PendingForSession(ctx, sess.ID, ""); len(p) != 1 || p[0].Kind == store.KindPlace {
		t.Fatalf("pending = %+v", p)
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
