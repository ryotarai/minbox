package server

import (
	"bytes"
	"context"
	"log"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/ryotarai/minbox/internal/store"
)

// fakeClock is a settable clock for the connection tests.
type fakeClock struct {
	mu sync.Mutex
	t  time.Time
}

func (c *fakeClock) now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.t
}

func (c *fakeClock) add(d time.Duration) {
	c.mu.Lock()
	c.t = c.t.Add(d)
	c.mu.Unlock()
}

// captureLog collects the server log of a test.
type logBuf struct {
	mu sync.Mutex
	b  bytes.Buffer
}

func (l *logBuf) Write(p []byte) (int, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.b.Write(p)
}

func (l *logBuf) String() string {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.b.String()
}

func captureLog(t *testing.T) *logBuf {
	t.Helper()
	l := &logBuf{}
	log.SetOutput(l)
	t.Cleanup(func() { log.SetOutput(os.Stderr) })
	return l
}

func connEnv(t *testing.T) (*env, *fakeClock, *store.Session) {
	t.Helper()
	e := newEnv(t)
	clk := &fakeClock{t: time.Now()}
	e.srv.clock = clk.now
	e.srv.modStaleAfter = 45 * time.Second
	sess := e.createSession()
	_ = e.st.SetSessionStatus(context.Background(), sess.ID, store.StatusIdle)
	return e, clk, sess
}

func connection(e *env, id string) map[string]any {
	e.t.Helper()
	code, obj, _ := e.do("GET", "/api/sessions/"+id+"/connection", nil, nil)
	if code != 200 {
		e.t.Fatalf("connection: %d %v", code, obj)
	}
	return obj
}

func beat(e *env, sess *store.Session, seq int, state string) {
	e.t.Helper()
	code, obj, _ := e.do("POST", "/api/agent/heartbeat", map[string]any{
		"seq": seq, "agent": "claude", "ext_version": "1.2.3", "state": state,
		"last_poll_at": "2026-11-11T00:00:00Z", "last_delivery_at": "",
		"info":   map[string]any{"poll_ticks": 3, "polling": true},
		"events": []map[string]any{{"at": "2026-11-11T00:00:01Z", "kind": "api-error", "msg": "GET /api/agent/pending: not reachable"}},
	}, bearer(sess))
	if code != 200 {
		e.t.Fatalf("heartbeat: %d %v", code, obj)
	}
}

func TestHeartbeatIsRecordedAndShownInTheSessionAndConnectionAPI(t *testing.T) {
	logs := captureLog(t)
	e, clk, sess := connEnv(t)

	if got := connection(e, sess.ID)["state"]; got != "connecting" {
		t.Fatalf("before any beat: %v", got)
	}
	beat(e, sess, 1, "idle")
	c := connection(e, sess.ID)
	if c["state"] != "connected" || c["heartbeat"] != true || c["mod_version"] != "1.2.3" || c["mod_state"] != "idle" || c["seq"] != float64(1) {
		t.Fatalf("connection = %v", c)
	}
	if evs := c["mod_events"].([]any); len(evs) != 1 || !strings.Contains(evs[0].(map[string]any)["msg"].(string), "not reachable") {
		t.Fatalf("mod events = %v", c["mod_events"])
	}
	if info := c["mod_info"].(map[string]any); info["poll_ticks"] != float64(3) {
		t.Fatalf("mod info = %v", info)
	}
	m := sessionJSON(e, sess.ID)
	if m["mod_conn"] != "connected" || m["mod_beat_at"] == nil {
		t.Fatalf("session = %v %v", m["mod_conn"], m["mod_beat_at"])
	}
	if !strings.Contains(logs.String(), "modconn: heartbeat-first session="+sess.ID) {
		t.Fatalf("no first-heartbeat line:\n%s", logs.String())
	}
	// A shell has no mod.
	clk.add(time.Second)
	if age := connection(e, sess.ID)["age_s"].(float64); age < 0.9 || age > 1.5 {
		t.Fatalf("age = %v", age)
	}
}

func TestStaleDetectionAndReconnectAreLoggedWithTheGap(t *testing.T) {
	logs := captureLog(t)
	e, clk, sess := connEnv(t)
	events := make(chan Event, 16)
	e.srv.hub.mu.Lock()
	e.srv.hub.subs[events] = struct{}{}
	e.srv.hub.mu.Unlock()

	beat(e, sess, 1, "idle")
	clk.add(30 * time.Second)
	e.srv.modCheckAll()
	if got := connection(e, sess.ID)["state"]; got != "connected" {
		t.Fatalf("30 s: %v", got)
	}
	clk.add(30 * time.Second) // 60 s without a heartbeat
	e.srv.modCheckAll()
	c := connection(e, sess.ID)
	if c["state"] != "stale" || sessionJSON(e, sess.ID)["mod_conn"] != "stale" {
		t.Fatalf("60 s: %v", c["state"])
	}
	if n := strings.Count(logs.String(), "modconn: stale session="+sess.ID); n != 1 {
		t.Fatalf("stale lines = %d\n%s", n, logs.String())
	}
	e.srv.modCheckAll() // logged once, not again
	if n := strings.Count(logs.String(), "modconn: stale session="); n != 1 {
		t.Fatalf("stale lines after a second check = %d", n)
	}
	// The flip published a sessions event.
	select {
	case <-events:
	default:
		t.Fatal("no sessions event on the flip to stale")
	}

	clk.add(60 * time.Second) // 2 min gap
	beat(e, sess, 2, "idle")
	c = connection(e, sess.ID)
	if c["state"] != "connected" || c["reconnects"] != float64(1) {
		t.Fatalf("after reconnect: %v %v", c["state"], c["reconnects"])
	}
	if !strings.Contains(logs.String(), "modconn: reconnected session="+sess.ID+" after 2m0s without heartbeat") {
		t.Fatalf("no reconnect line with the gap:\n%s", logs.String())
	}
	// The server's own ring has the transitions too.
	var kinds []string
	for _, ev := range c["events"].([]any) {
		kinds = append(kinds, ev.(map[string]any)["kind"].(string))
	}
	if got := strings.Join(kinds, ","); !strings.Contains(got, "stale,reconnected") {
		t.Fatalf("event kinds = %s", got)
	}
}

func TestStaleIsFoundEvenWithoutATimerCheck(t *testing.T) {
	logs := captureLog(t)
	e, clk, sess := connEnv(t)
	beat(e, sess, 1, "idle")
	clk.add(2 * time.Minute)
	// No modCheck ran: the state is still judged at read time, and the next beat logs both transitions.
	if got := connection(e, sess.ID)["state"]; got != "stale" {
		t.Fatalf("state = %v", got)
	}
	beat(e, sess, 2, "idle")
	if !strings.Contains(logs.String(), "modconn: stale session=") || !strings.Contains(logs.String(), "modconn: reconnected session=") {
		t.Fatalf("logs:\n%s", logs.String())
	}
}

func TestLegacyModWithoutHeartbeatsIsJudgedByItsCalls(t *testing.T) {
	logs := captureLog(t)
	e, clk, sess := connEnv(t)
	e.do("GET", "/api/agent/pending?owner=o", nil, bearer(sess))
	c := connection(e, sess.ID)
	if c["state"] != "connected" || c["heartbeat"] != false {
		t.Fatalf("connection = %v %v", c["state"], c["heartbeat"])
	}
	clk.add(time.Minute)
	if got := connection(e, sess.ID)["state"]; got != "stale" {
		t.Fatalf("state = %v", got)
	}
	e.do("GET", "/api/agent/pending?owner=o", nil, bearer(sess))
	if got := connection(e, sess.ID)["state"]; got != "connected" {
		t.Fatalf("state after a call = %v", got)
	}
	if !strings.Contains(logs.String(), "without call") {
		t.Fatalf("logs:\n%s", logs.String())
	}
}

func TestDeliveryAndUndeliveredLines(t *testing.T) {
	logs := captureLog(t)
	e, clk, sess := connEnv(t)
	_, sent, _ := e.do("POST", "/api/agent/messages", map[string]any{"body": "hi", "subject": "S"}, bearer(sess))
	tid := sent["thread_id"].(string)
	_, reply, _ := e.do("POST", "/api/threads/"+tid+"/reply", map[string]any{"words": "SECRET-WORDS"}, nil)
	mid := reply["id"].(string)

	beat(e, sess, 1, "idle")
	clk.add(10 * time.Second)
	beat(e, sess, 2, "idle")
	if strings.Contains(logs.String(), "modconn: undelivered") {
		t.Fatal("undelivered logged too early")
	}
	clk.add(25 * time.Second) // 35 s queued, the mod says idle
	beat(e, sess, 3, "idle")
	beat(e, sess, 4, "idle") // once only
	out := logs.String()
	if n := strings.Count(out, "modconn: undelivered session="+sess.ID); n != 1 {
		t.Fatalf("undelivered lines = %d\n%s", n, out)
	}
	if !strings.Contains(out, "msg="+mid) || !strings.Contains(out, `mod_state="idle"`) || !strings.Contains(out, "last_heartbeat_age=0s") {
		t.Fatalf("undelivered line lacks details:\n%s", out)
	}
	if q := connection(e, sess.ID)["queue"].(map[string]any); q["count"] != float64(1) {
		t.Fatalf("queue = %v", q)
	}

	// A poll that returns it, the claim and the delivered mark are logged with the wait.
	e.do("GET", "/api/agent/pending?owner=o", nil, bearer(sess))
	e.do("POST", "/api/agent/pending/"+mid+"/claim?owner=o", nil, bearer(sess))
	e.do("POST", "/api/agent/pending/"+mid+"/delivered?owner=o", nil, bearer(sess))
	out = logs.String()
	for _, want := range []string{"modconn: pending session=" + sess.ID + " poll returned 1 message(s)", "modconn: claimed session=" + sess.ID + " msg=" + mid + " thread=" + tid, "modconn: delivered session=" + sess.ID + " msg=" + mid} {
		if !strings.Contains(out, want) {
			t.Fatalf("missing %q in\n%s", want, out)
		}
	}
	// Never a body, a token or an owner.
	for _, secret := range []string{"SECRET-WORDS", sess.Token} {
		if strings.Contains(out, secret) {
			t.Fatalf("log leaks %q", secret)
		}
	}
	if strings.Contains(out, "owner=o") {
		t.Fatalf("log leaks the owner key")
	}
}

func TestBusyModDoesNotLogUndelivered(t *testing.T) {
	logs := captureLog(t)
	e, clk, sess := connEnv(t)
	_, sent, _ := e.do("POST", "/api/agent/messages", map[string]any{"body": "hi", "subject": "S"}, bearer(sess))
	e.do("POST", "/api/threads/"+sent["thread_id"].(string)+"/reply", map[string]any{"words": "x"}, nil)
	clk.add(40 * time.Second)
	beat(e, sess, 1, "working")
	if strings.Contains(logs.String(), "modconn: undelivered") {
		t.Fatalf("busy mod flagged:\n%s", logs.String())
	}
}

func TestSessionExitAndSeqResetAreLogged(t *testing.T) {
	logs := captureLog(t)
	e, _, sess := connEnv(t)
	beat(e, sess, 5, "idle")
	beat(e, sess, 1, "idle")
	e.srv.sessions.onExit(context.Background(), sess.ID, 0)
	out := logs.String()
	if !strings.Contains(out, "modconn: seq-reset session="+sess.ID) || !strings.Contains(out, "modconn: exit session="+sess.ID) {
		t.Fatalf("logs:\n%s", out)
	}
	if got := connection(e, sess.ID)["state"]; got != "none" {
		t.Fatalf("ended session state = %v", got)
	}
}

func TestHeartbeatNeedsTheSessionToken(t *testing.T) {
	e, _, _ := connEnv(t)
	if code, _, _ := e.do("POST", "/api/agent/heartbeat", map[string]any{"seq": 1}, map[string]string{"Authorization": "Bearer nope"}); code != 401 {
		t.Fatalf("code = %d", code)
	}
}
