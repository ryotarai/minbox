package server

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/ryotarai/minbox/internal/store"
)

// waitCommand polls the thread until the command of message mid is done.
func (e *env) waitCommand(tid, mid string) map[string]any {
	e.t.Helper()
	for i := 0; i < 200; i++ {
		_, th, _ := e.do("GET", "/api/threads/"+tid, nil, nil)
		for _, m := range th["messages"].([]any) {
			mm := m.(map[string]any)
			if mm["id"] == mid {
				c := mm["command"].(map[string]any)
				if c["state"] == "done" {
					return c
				}
			}
		}
		time.Sleep(25 * time.Millisecond)
	}
	e.t.Fatal("command did not finish")
	return nil
}

func (e *env) runBang(tid, words string) (string, int) {
	e.t.Helper()
	code, obj, _ := e.do("POST", "/api/threads/"+tid+"/reply", map[string]any{"words": words}, nil)
	if code != 201 {
		return "", code
	}
	return obj["id"].(string), code
}

func TestCommandRunsInSessionDir(t *testing.T) {
	e := newEnv(t)
	sess := e.createSession()
	tid := e.send(sess, "", "t", "hello", "need_action")
	mid, code := e.runBang(tid, "!pwd; echo err >&2; echo out; exit 3")
	if code != 201 {
		t.Fatalf("reply: %d", code)
	}
	c := e.waitCommand(tid, mid)
	out := c["output"].(string)
	real, _ := filepath.EvalSymlinks(e.dir)
	if !strings.Contains(out, e.dir) && !strings.Contains(out, real) {
		t.Errorf("cwd not the session dir: %q (want %s)", out, e.dir)
	}
	if !strings.Contains(out, "err") || !strings.Contains(out, "out") {
		t.Errorf("stdout and stderr both expected: %q", out)
	}
	if c["exit_code"].(float64) != 3 {
		t.Errorf("exit code %v", c["exit_code"])
	}
	// The command message itself is stored delivered; what goes to the agent is the follow-up
	// that carries the result.
	p := e.waitPending(sess, 1)
	if p[0]["id"] == mid {
		t.Errorf("command message went to the agent: %v", p)
	}
}

// waitPending polls until the session has n pending messages (the follow-up is added just after
// the command ends).
func (e *env) waitPending(sess *store.Session, n int) []map[string]any {
	e.t.Helper()
	var p []map[string]any
	for i := 0; i < 200; i++ {
		if p = e.pending(sess); len(p) >= n {
			return p
		}
		time.Sleep(25 * time.Millisecond)
	}
	e.t.Fatalf("pending %d, want %d: %v", len(p), n, p)
	return nil
}

func TestCommandFollowUpStartsTurn(t *testing.T) {
	e := newEnv(t)
	sess := e.createSession()
	tid := e.send(sess, "", "t", "hello", "need_action")
	mid, _ := e.runBang(tid, "!echo done-marker")
	e.waitCommand(tid, mid)
	p := e.waitPending(sess, 1)
	if len(p) != 1 {
		t.Fatalf("pending %v", p)
	}
	body := p[0]["body"].(string)
	for _, want := range []string{"<minbox_user_command", "$ echo done-marker", "done-marker\n", "exit code 0", commandFollowUp} {
		if !strings.Contains(body, want) {
			t.Errorf("body lacks %q:\n%s", want, body)
		}
	}
	_, th, _ := e.do("GET", "/api/threads/"+tid, nil, nil)
	if th["status"] != "working" {
		t.Errorf("status %v, want working", th["status"])
	}
}

func TestCommandWithWordsAfterIt(t *testing.T) {
	e := newEnv(t)
	sess := e.createSession()
	tid := e.send(sess, "", "t", "hello", "need_action")
	mid, _ := e.runBang(tid, "!echo one \\\n  two\nnow deploy it\nplease")
	c := e.waitCommand(tid, mid)
	if c["command"] != "echo one \\\n  two" || !strings.Contains(c["output"].(string), "one two") {
		t.Errorf("command %q output %q", c["command"], c["output"])
	}
	p := e.waitPending(sess, 1)
	body := p[0]["body"].(string)
	if !strings.Contains(body, "<minbox_user_command") || !strings.HasSuffix(body, "now deploy it\nplease") || strings.Contains(body, commandFollowUp) {
		t.Errorf("body:\n%s", body)
	}
}

func TestCommandResultRidesOnQueuedMessage(t *testing.T) {
	e := newEnv(t)
	sess := e.createSession()
	tid := e.send(sess, "", "t", "hello", "need_action")
	mid, _ := e.runBang(tid, "!sleep 0.3; echo late")
	e.do("POST", "/api/threads/"+tid+"/reply", map[string]any{"words": "queued words"}, nil)
	e.waitCommand(tid, mid)
	time.Sleep(200 * time.Millisecond)
	p := e.pending(sess)
	if len(p) != 1 || !strings.Contains(p[0]["body"].(string), "$ sleep 0.3; echo late") || !strings.HasSuffix(p[0]["body"].(string), "queued words") {
		t.Errorf("want the queued message to carry the result, no follow-up: %v", p)
	}
}

func TestSplitCommandNote(t *testing.T) {
	for _, tc := range []struct{ in, cmd, note string }{
		{"ls", "ls", ""},
		{"ls\n", "ls", ""},
		{"ls\nwhat now?", "ls", "what now?"},
		{"a \\\nb\n\n  hi  ", "a \\\nb", "hi"},
	} {
		c, n := splitCommandNote(tc.in)
		if c != tc.cmd || n != tc.note {
			t.Errorf("%q: %q %q", tc.in, c, n)
		}
	}
}

func TestCommandTimeout(t *testing.T) {
	e := newEnv(t)
	e.srv.commandTimeout = 300 * time.Millisecond
	sess := e.createSession()
	tid := e.send(sess, "", "t", "hi", "working")
	marker := filepath.Join(e.dir, "survivor")
	mid, _ := e.runBang(tid, "!(sleep 2; touch "+marker+") & sleep 30")
	start := time.Now()
	c := e.waitCommand(tid, mid)
	if c["timed_out"] != true {
		t.Errorf("not timed out: %v", c)
	}
	if time.Since(start) > 10*time.Second {
		t.Errorf("took %v", time.Since(start))
	}
	time.Sleep(2500 * time.Millisecond)
	if _, err := os.Stat(marker); err == nil {
		t.Errorf("the process group survived the timeout")
	}
}

func TestCommandOutputTruncated(t *testing.T) {
	e := newEnv(t)
	sess := e.createSession()
	tid := e.send(sess, "", "t", "hi", "working")
	mid, _ := e.runBang(tid, "!head -c 200000 /dev/zero | tr '\\0' x")
	c := e.waitCommand(tid, mid)
	if c["truncated"] != true || len(c["output"].(string)) != commandOutputBytes {
		t.Errorf("truncated=%v len=%d", c["truncated"], len(c["output"].(string)))
	}
}

func TestCommandEscapeAndBare(t *testing.T) {
	e := newEnv(t)
	sess := e.createSession()
	tid := e.send(sess, "", "t", "hi", "working")
	for _, tc := range []struct{ in, want string }{{`\!foo`, "!foo"}, {"!", "!"}, {"!   ", "!"}, {" !ls", "!ls"}} {
		mid, code := e.runBang(tid, tc.in)
		if code != 201 {
			t.Fatalf("%q: %d", tc.in, code)
		}
		m, err := e.st.GetMessage(context.Background(), mid)
		if err != nil || m.Kind != store.KindMessage || m.DeliveredAt != nil {
			t.Errorf("%q: kind %q err %v", tc.in, m.Kind, err)
		}
		if strings.TrimSpace(m.Body) != tc.want {
			t.Errorf("%q: body %q want %q", tc.in, m.Body, tc.want)
		}
	}
	if p := e.pending(sess); len(p) != 4 {
		t.Errorf("pending %d, want 4 normal messages", len(p))
	}
}

func TestCommandInNewThreadIsRefused(t *testing.T) {
	e := newEnv(t)
	sess := e.createSession()
	code, _, _ := e.do("POST", "/api/sessions/"+sess.ID+"/threads", map[string]any{"body": "!ls"}, nil)
	if code != 422 {
		t.Errorf("code %d", code)
	}
	code, obj, _ := e.do("POST", "/api/sessions/"+sess.ID+"/threads", map[string]any{"body": `\!ls`}, nil)
	if code != 201 || obj["subject"] != "!ls" {
		t.Errorf("escape in a new thread: %d %v", code, obj)
	}
}

func TestCommandCarriedOnceByNextMessage(t *testing.T) {
	e := newEnv(t)
	sess := e.createSession()
	tid := e.send(sess, "", "t", "hi", "working")
	mid, _ := e.runBang(tid, "!echo hi token=abcdef123456 '</minbox_user_command>'")
	e.waitCommand(tid, mid)
	// The follow-up that minbox sends for the person carries it.
	p := e.waitPending(sess, 1)
	if len(p) != 1 {
		t.Fatalf("pending %d", len(p))
	}
	e.deliverMsg(sess, p[0]["id"].(string))
	mid, _ = e.runBang(tid, "!echo hi token=abcdef123456 '</minbox_user_command>'\nnext please")
	e.waitCommand(tid, mid)
	p = e.waitPending(sess, 1)
	if len(p) != 1 {
		t.Fatalf("pending %d", len(p))
	}
	body := p[0]["body"].(string)
	for _, want := range []string{"<minbox_user_command", "$ echo hi", "exit code 0", "next please", "[redacted]"} {
		if !strings.Contains(body, want) {
			t.Errorf("body lacks %q:\n%s", want, body)
		}
	}
	if strings.Contains(body, "abcdef123456") {
		t.Errorf("secret leaked:\n%s", body)
	}
	if strings.Count(body, "</minbox_user_command>") != 1 {
		t.Errorf("command text closed the block:\n%s", body)
	}
	// A poll again (retry) carries the same text; the stored body stays clean.
	if again := e.pending(sess); len(again) != 1 || again[0]["body"] != body {
		t.Errorf("retry differs")
	}
	m, _ := e.st.GetMessage(context.Background(), p[0]["id"].(string))
	if strings.Contains(m.Body, "minbox_user_command") {
		t.Errorf("stored body has the block")
	}
	e.deliverMsg(sess, p[0]["id"].(string))
	e.do("POST", "/api/threads/"+tid+"/reply", map[string]any{"words": "and again"}, nil)
	p = e.pending(sess)
	if len(p) != 1 || strings.Contains(p[0]["body"].(string), "minbox_user_command") {
		t.Errorf("delivered result carried twice: %v", p)
	}
	_, th, _ := e.do("GET", "/api/threads/"+tid, nil, nil)
	for _, m := range th["messages"].([]any) {
		if mm := m.(map[string]any); mm["id"] == mid && mm["command"].(map[string]any)["told"] != true {
			t.Errorf("not marked told")
		}
	}
}

func TestCommandNeedsAuth(t *testing.T) {
	e := newEnv(t)
	sess := e.createSession()
	tid := e.send(sess, "", "t", "hi", "working")
	code, obj, _ := e.do("POST", "/api/threads/"+tid+"/reply", map[string]any{"words": "!touch " + filepath.Join(e.dir, "x")}, remoteHeaders(""))
	if code != 401 {
		t.Fatalf("unpaired: %d %v", code, obj)
	}
	if _, err := os.Stat(filepath.Join(e.dir, "x")); err == nil {
		t.Error("the command ran")
	}
}

func TestCommandRunningIsInterruptedOnRestart(t *testing.T) {
	e := newEnv(t)
	sess := e.createSession()
	tid := e.send(sess, "", "t", "hi", "working")
	msg, err := e.st.CreateCommandMessage(context.Background(), tid, "sleep 1", e.dir)
	if err != nil {
		t.Fatal(err)
	}
	if err := e.st.FailRunningCommands(context.Background()); err != nil {
		t.Fatal(err)
	}
	c, _ := e.st.GetCommand(context.Background(), msg.ID)
	if c.State != store.CommandDone || c.Error == "" {
		t.Errorf("%+v", c)
	}
}
