package server

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/ryotarai/minbox/internal/store"
)

// stuckEnv: a server with a settable clock, short thresholds and a terminal screen the test sets.
// The background watch is stopped first: the test runs every pass itself (stuckJSON), so a pass of
// the watch can neither interleave with the test's nor read the fields set here.
func stuckEnv(t *testing.T) (*env, *fakeClock, *string) {
	t.Helper()
	e := newEnv(t)
	close(e.srv.stuckStop)
	<-e.srv.stuckDone
	clk := &fakeClock{t: time.Now()}
	e.srv.clock = clk.now
	e.srv.stuckStartupAfter = 20 * time.Second
	e.srv.stuckMessageAfter = 30 * time.Second
	screen := new(string)
	e.srv.stuckTail = func(context.Context, *store.Session) ([]byte, error) { return []byte(*screen), nil }
	return e, clk, screen
}

// stuckJSON runs a pass of the watch and answers the agent's stuck fields as the browser gets them.
func stuckJSON(e *env, id string) (kind, hint string) {
	e.t.Helper()
	e.srv.stuckPass(context.Background())
	m := sessionJSON(e, id)
	kind, _ = m["stuck"].(string)
	hint, _ = m["stuck_hint"].(string)
	if kind != "" && m["stuck_since"] == nil {
		e.t.Fatalf("stuck %q without stuck_since", kind)
	}
	return kind, hint
}

func hello(e *env, sess *store.Session) {
	e.t.Helper()
	if code, obj, _ := e.do("POST", "/api/agent/hello", map[string]any{"claude_session_id": sess.ClaudeSessionID}, bearer(sess)); code != 200 {
		e.t.Fatalf("hello: %d %v", code, obj)
	}
}

func TestStuckAtStartupUntilTheHello(t *testing.T) {
	e, clk, screen := stuckEnv(t)
	*screen = "\x1b[2J\x1b[H\x1b[1m╭──────╮\x1b[0m\r\n│ \x1b[1mDo you trust the files in this folder?\x1b[0m │\r\n│ ❯ 1. Yes, proceed │\r\n"
	sess := e.createSession()
	if s, _ := e.st.GetSession(context.Background(), sess.ID); s.Status != store.StatusStarting {
		t.Fatalf("status after spawn = %s", s.Status)
	}
	clk.add(10 * time.Second)
	if k, _ := stuckJSON(e, sess.ID); k != "" {
		t.Fatalf("10 s after the start: stuck %q", k)
	}
	clk.add(15 * time.Second)
	k, hint := stuckJSON(e, sess.ID)
	if k != stuckStartup {
		t.Fatalf("25 s without a hello: stuck %q", k)
	}
	if hint != "Do you trust the files in this folder?" {
		t.Fatalf("hint = %q", hint)
	}
	hello(e, sess)
	if k, h := stuckJSON(e, sess.ID); k != "" || h != "" {
		t.Fatalf("after the hello: stuck %q hint %q", k, h)
	}
	// A restart starts the count again.
	if err := e.srv.sessions.Restart(context.Background(), sess.ID); err != nil {
		t.Fatal(err)
	}
	clk.add(5 * time.Second)
	if k, _ := stuckJSON(e, sess.ID); k != "" {
		t.Fatalf("5 s after a restart: stuck %q", k)
	}
	clk.add(20 * time.Second)
	if k, _ := stuckJSON(e, sess.ID); k != stuckStartup {
		t.Fatalf("25 s after a restart without a hello: stuck %q", k)
	}
}

func TestStuckOnAMessageNotTakenWhileIdle(t *testing.T) {
	e, clk, _ := stuckEnv(t)
	sess := e.createSession()
	hello(e, sess)
	code, obj, _ := e.do("POST", "/api/v3/sessions/"+sess.ID+"/messages", map[string]any{"words": "hello?"}, nil)
	if code != 201 {
		t.Fatalf("send: %d %v", code, obj)
	}
	id := obj["id"].(string)
	clk.add(20 * time.Second)
	if k, _ := stuckJSON(e, sess.ID); k != "" {
		t.Fatalf("20 s: stuck %q", k)
	}
	// In a turn, waiting is expected.
	e.do("POST", "/api/agent/status", map[string]any{"status": "working"}, bearer(sess))
	clk.add(60 * time.Second)
	if k, _ := stuckJSON(e, sess.ID); k != "" {
		t.Fatalf("working: stuck %q", k)
	}
	// Idle again: the message waits from now.
	e.do("POST", "/api/agent/status", map[string]any{"status": "idle"}, bearer(sess))
	clk.add(10 * time.Second)
	if k, _ := stuckJSON(e, sess.ID); k != "" {
		t.Fatalf("10 s after the turn: stuck %q", k)
	}
	clk.add(25 * time.Second)
	if k, _ := stuckJSON(e, sess.ID); k != stuckMessage {
		t.Fatalf("35 s idle with the message waiting: stuck %q", k)
	}
	// Claimed is not taken yet.
	e.do("POST", "/api/agent/pending/"+id+"/claim?owner=o", nil, bearer(sess))
	if k, _ := stuckJSON(e, sess.ID); k != stuckMessage {
		t.Fatalf("claimed: stuck %q", k)
	}
	if code, _, _ := e.do("POST", "/api/agent/pending/"+id+"/delivered?owner=o", nil, bearer(sess)); code != 200 {
		t.Fatalf("delivered: %d", code)
	}
	if k, _ := stuckJSON(e, sess.ID); k != "" {
		t.Fatalf("delivered: stuck %q", k)
	}
}

func TestStuckAfterATurnThatDiedOnAnAPIError(t *testing.T) {
	e, _, screen := stuckEnv(t)
	sess := e.createSession()
	hello(e, sess)
	ev := func(body map[string]any) {
		t.Helper()
		if code, obj, _ := e.do("POST", "/api/agent/event", body, bearer(sess)); code != 200 {
			t.Fatalf("event %v: %d %v", body, code, obj)
		}
	}
	*screen = "> hi\r\n  \x1b[31m⎿  API Error: 404 {\"type\":\"error\",\"error\":{\"type\":\"not_found_error\",\"message\":\"model: claude-bogus\"}}\x1b[0m\r\n\r\n> \r\n"
	ev(map[string]any{"type": "turn.start"})
	ev(map[string]any{"type": "turn.error", "error": "model_not_found"})
	ev(map[string]any{"type": "turn.complete", "reason": "error", "answer": ""})
	k, hint := stuckJSON(e, sess.ID)
	if k != stuckError {
		t.Fatalf("after the failed turn: stuck %q", k)
	}
	if !strings.HasPrefix(hint, "API Error: 404") || !strings.Contains(hint, "not_found_error") {
		t.Fatalf("hint = %q", hint)
	}
	// A normal turn clears it.
	ev(map[string]any{"type": "turn.start"})
	ev(map[string]any{"type": "turn.complete", "reason": "answer", "answer": "done"})
	if k, _ := stuckJSON(e, sess.ID); k != "" {
		t.Fatalf("after a normal turn: stuck %q", k)
	}

	// An API error shown as the turn's answer counts too; with nothing known on the screen the
	// class the integration sent is the hint; the agent posting a message clears it.
	*screen = "nothing to see"
	ev(map[string]any{"type": "turn.error", "error": "authentication_failed"})
	ev(map[string]any{"type": "turn.complete", "reason": "answer", "answer": "API Error: 401 invalid x-api-key"})
	if k, h := stuckJSON(e, sess.ID); k != stuckError || h != "API error: authentication failed" {
		t.Fatalf("answer-shaped error: stuck %q hint %q", k, h)
	}
	if code, obj, _ := e.do("POST", "/api/agent/messages", map[string]any{"task_status": "working", "subject": "Hi", "body": "I am back"}, bearer(sess)); code >= 300 {
		t.Fatalf("send: %d %v", code, obj)
	}
	if k, _ := stuckJSON(e, sess.ID); k != "" {
		t.Fatalf("after the agent wrote: stuck %q", k)
	}
}

func TestShellsAndEndedAgentsAreNeverStuck(t *testing.T) {
	e, clk, _ := stuckEnv(t)
	ctx := context.Background()
	sh, err := e.st.CreateSessionKind(ctx, store.LocalHostID, store.KindShell, "sh", e.dir, "")
	if err != nil {
		t.Fatal(err)
	}
	_ = e.st.SetSessionStatus(ctx, sh.ID, store.StatusStarting)
	sess := e.createSession()
	_ = e.st.SetSessionEnded(ctx, sess.ID, 0)
	clk.add(time.Hour)
	for _, id := range []string{sh.ID, sess.ID} {
		if k, _ := stuckJSON(e, id); k != "" {
			t.Fatalf("%s: stuck %q", id, k)
		}
	}
}

func TestStuckPublishesWhenItChanges(t *testing.T) {
	e, clk, _ := stuckEnv(t)
	e.createSession()
	events := make(chan Event, 64)
	e.srv.hub.mu.Lock()
	e.srv.hub.subs[events] = struct{}{}
	e.srv.hub.mu.Unlock()
	drain := func() (n int) {
		for {
			select {
			case ev := <-events:
				if ev.Type == "sessions" {
					n++
				}
			default:
				return n
			}
		}
	}
	drain()
	clk.add(30 * time.Second)
	e.srv.stuckPass(context.Background())
	if drain() == 0 {
		t.Fatal("no sessions event when the agent got stuck")
	}
	e.srv.stuckPass(context.Background())
	if n := drain(); n != 0 {
		t.Fatalf("%d sessions events with nothing changed", n)
	}
}

func TestScreenHint(t *testing.T) {
	cases := []struct{ name, screen, want string }{
		{"trust", "\x1b[?25l\x1b[2K\x1b[1A\x1b[2K\x1b[G│\x1b[1CDo\x1b[1Cyou\x1b[1Ctrust\x1b[1Cthe\x1b[1Cfiles\x1b[1Cin\x1b[1Cthis\x1b[1Cfolder?\x1b[1C│\r\n │ ❯ 1. Yes, proceed │\r\nEnter to confirm · Esc to exit\r\n", "Do you trust the files in this folder?"},
		{"login", "Welcome to Claude Code\r\n\r\n Select login method:\r\n ❯ 1. Claude account with subscription\r\n", "Select login method:"},
		{"api key", "\x1b]0;claude\x07Detected a custom API key in your environment\r\n Do you want to use this API key? sk-ant-api03-abcdefghijklmnop\r\n", "Do you want to use this API key? …"},
		{"error last wins", "Press Enter to continue\r\nAPI Error: 529 {\"type\":\"error\",\"error\":{\"type\":\"overloaded_error\"}}\r\n", `API Error: 529 {"type":"error","error":{"type":"overloaded_error"}}`},
		{"rate limit", "Claude usage limit reached. Rate limit resets at 5pm\r\n", "Claude usage limit reached. Rate limit resets at 5pm"},
		{"model", "There's an issue with the selected model (claude-bogus). It may not exist or you may not have access to it. Run /model to pick a different model. invalid model\r\n", "There's an issue with the selected model (claude-bogus). It may not exist or you may not have access to it. Run /model to pick a different model. invalid model"},
		{"nothing", "ready> \r\nhello\r\n", ""},
		{"long token", "Error: 401 Unauthorized token=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\r\n", "Error: 401 Unauthorized token=…"},
	}
	for _, c := range cases {
		if got := screenHint([]byte(c.screen)); got != c.want {
			t.Errorf("%s: hint = %q, want %q", c.name, got, c.want)
		}
	}
	long := "API Error: " + strings.Repeat("x y ", 200)
	if got := []rune(screenHint([]byte(long))); len(got) > stuckHintMax+1 {
		t.Errorf("long hint: %d characters", len(got))
	}
}

func TestTurnFailed(t *testing.T) {
	for _, c := range []struct {
		reason, answer string
		want           bool
	}{
		{"error", "", true},
		{"answer", "API Error: 404 model not found", true},
		{"answer", "All done. The API error handling is fixed.", false},
		{"aborted", "", false},
	} {
		if got := turnFailed(c.reason, c.answer); got != c.want {
			t.Errorf("turnFailed(%q, %q) = %v", c.reason, c.answer, got)
		}
	}
}
