package server

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"testing/fstest"
	"time"

	"github.com/ryotarai/minbox/internal/agent"
	"github.com/ryotarai/minbox/internal/store"
	"github.com/ryotarai/minbox/internal/termhost"
)

// fakeHost stands in for the terminal host.
type fakeHost struct {
	mu      sync.Mutex
	terms   map[string]termhost.TerminalInfo
	spawned []termhost.SpawnRequest
	// stubborn is a terminal id that Kill leaves running.
	stubborn string
}

func newFakeHost() *fakeHost { return &fakeHost{terms: map[string]termhost.TerminalInfo{}} }

func (f *fakeHost) List(context.Context) ([]termhost.TerminalInfo, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []termhost.TerminalInfo
	for _, t := range f.terms {
		out = append(out, t)
	}
	return out, nil
}

func (f *fakeHost) Spawn(_ context.Context, req termhost.SpawnRequest) (termhost.TerminalInfo, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.spawned = append(f.spawned, req)
	info := termhost.TerminalInfo{ID: req.ID, PID: 1, Running: true}
	f.terms[req.ID] = info
	return info, nil
}

func (f *fakeHost) Kill(_ context.Context, id string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if id == f.stubborn {
		return nil // a terminal that does not exit (tests of Restart)
	}
	t := f.terms[id]
	t.Running = false
	f.terms[id] = t
	return nil
}

func (f *fakeHost) Remove(_ context.Context, id string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	delete(f.terms, id)
	return nil
}

type env struct {
	t    *testing.T
	srv  *Server
	st   *store.Store
	host *fakeHost
	ts   *httptest.Server
	dir  string
	// cookie is this machine's paired browser ("minbox_device=…"): e.do sends it with every
	// request that names no Cookie of its own and does not come through a proxy.
	cookie string
}

// claudeAbsentIn records the tests that called claudeAbsent: newEnv puts no fake `claude` on their PATH.
var claudeAbsentIn sync.Map // *testing.T -> struct{}

// fakeClaudeOnPath makes the test's `claude` a fake that fails at once: PATH starts with a folder
// that holds only it. Tests must not depend on whether the machine has Claude Code, Pi or OpenCode,
// nor run a real one (Pi and OpenCode stay unconfigured unless a test gives them a fake).
func fakeClaudeOnPath(t *testing.T) {
	t.Helper()
	bin := t.TempDir()
	script := "#!/bin/sh\necho 'fake claude of the minbox tests' >&2\nexit 1\n"
	if err := os.WriteFile(filepath.Join(bin, "claude"), []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", bin+string(os.PathListSeparator)+os.Getenv("PATH"))
}

func newEnv(t *testing.T) *env {
	t.Helper()
	if _, absent := claudeAbsentIn.Load(t); !absent {
		fakeClaudeOnPath(t)
	}
	dir := t.TempDir()
	st, err := store.Open(filepath.Join(dir, "db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })
	cfg := Config{DataDir: dir, ClaudeCommand: []string{"claude"}, PluginDir: "/plugin", ServerFile: filepath.Join(dir, "server.json"), ScratchDir: filepath.Join(dir, "scratch")}
	srv := New(cfg, st, fstest.MapFS{"index.html": {Data: []byte("<html>app</html>")}})
	host := newFakeHost()
	srv.sessions.setHost(host)
	// Never a real model in tests: the agent pick falls back unless a test answers for the helper.
	srv.agentPickRun = func(context.Context, string) ([]byte, error) { return nil, agent.ErrNoneInstalled }
	ts := httptest.NewServer(srv)
	t.Cleanup(ts.Close)
	e := &env{t: t, srv: srv, st: st, host: host, ts: ts, dir: dir}
	e.cookie = pairedCookie(t, srv, "Test browser")
	return e
}

// auth adds this machine's paired browser's cookie to a request built by hand.
func (e *env) auth(req *http.Request) *http.Request {
	req.Header.Set("Cookie", e.cookie)
	return req
}

// authUnless adds the cookie unless the headers name a Cookie of their own ("" for none) or
// make the request come through a proxy (another machine's browser).
func (e *env) authUnless(req *http.Request, header map[string]string) {
	_, hasCookie := header["Cookie"]
	if !hasCookie && header["X-Forwarded-For"] == "" && header["Tailscale-User-Login"] == "" {
		e.auth(req)
	}
}

// authHeader is the same as a header map (websocket.Dial, e.do callers).
func (e *env) authHeader() http.Header { return http.Header{"Cookie": {e.cookie}} }

func (e *env) do(method, path string, body any, header map[string]string) (int, map[string]any, []any) {
	e.t.Helper()
	var rd io.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		rd = bytes.NewReader(b)
	}
	req, _ := http.NewRequest(method, e.ts.URL+path, rd)
	e.authUnless(req, header)
	for k, v := range header {
		req.Header.Set(k, v)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		e.t.Fatal(err)
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	var obj map[string]any
	var arr []any
	if json.Unmarshal(raw, &obj) != nil {
		_ = json.Unmarshal(raw, &arr)
	}
	return resp.StatusCode, obj, arr
}

func (e *env) createSession() *store.Session {
	e.t.Helper()
	code, obj, _ := e.do("POST", "/api/sessions", map[string]string{"cwd": e.dir, "name": "s"}, nil)
	if code != 201 {
		e.t.Fatalf("create session: %d %v", code, obj)
	}
	sess, err := e.st.GetSession(context.Background(), obj["id"].(string))
	if err != nil {
		e.t.Fatal(err)
	}
	return sess
}

func bearer(s *store.Session) map[string]string {
	return map[string]string{"Authorization": "Bearer " + s.Token}
}

func TestCreateSessionSpawnsClaudeWithTheMod(t *testing.T) {
	t.Setenv("CLAUDE_CODE_CHILD_SESSION", "1")
	t.Setenv("CLAUDECODE", "1")
	t.Setenv("TERM_PROGRAM", "Apple_Terminal")
	e := newEnv(t)
	sess := e.createSession()
	if len(e.host.spawned) != 1 {
		t.Fatalf("spawned %d", len(e.host.spawned))
	}
	req := e.host.spawned[0]
	argv := strings.Join(req.Argv, " ")
	if !strings.HasPrefix(argv, "claude --plugin-dir /plugin --session-id "+sess.ClaudeSessionID) {
		t.Fatalf("argv = %s", argv)
	}
	if n := len(req.Argv); n < 2 || req.Argv[n-2] != "--append-system-prompt" || !strings.Contains(req.Argv[n-1], "mcp__minbox__open_url") {
		t.Errorf("argv lacks minbox's system prompt: %q", req.Argv)
	}
	envs := strings.Join(req.Env, "\n")
	for _, want := range []string{"MINBOX_TOKEN=" + sess.Token, "MINBOX_SESSION_ID=" + sess.ID, "TERM=xterm-256color"} {
		if !strings.Contains(envs, want) {
			t.Errorf("env lacks %s", want)
		}
	}
	for _, leak := range []string{"CLAUDE_CODE_CHILD_SESSION=", "CLAUDECODE=", "TERM_PROGRAM="} {
		for _, kv := range req.Env {
			if strings.HasPrefix(kv, leak) {
				t.Errorf("%s leaked into the session", leak)
			}
		}
	}
}

func TestGuardRefusesOtherOriginsAndHosts(t *testing.T) {
	e := newEnv(t)
	code, _, _ := e.do("POST", "/api/sessions", map[string]string{"cwd": e.dir}, map[string]string{"Origin": "https://evil.example"})
	if code != 403 {
		t.Fatalf("cross-origin POST: %d", code)
	}
	req, _ := http.NewRequest("GET", e.ts.URL+"/api/sessions", nil)
	req.Host = "evil.example:4848"
	resp, _ := http.DefaultClient.Do(req)
	if resp.StatusCode != 403 {
		t.Fatalf("foreign Host: %d", resp.StatusCode)
	}
	code, _, _ = e.do("GET", "/some/spa/route", nil, nil)
	if code != 200 {
		t.Fatalf("SPA route: %d", code)
	}
}

func TestAgentNeedsItsToken(t *testing.T) {
	e := newEnv(t)
	a := e.createSession()
	b := e.createSession()
	if code, _, _ := e.do("GET", "/api/agent/pending", nil, nil); code != 401 {
		t.Fatalf("no token: %d", code)
	}
	_, obj, _ := e.do("POST", "/api/agent/messages", map[string]string{"body": "hi", "subject": "S"}, bearer(a))
	thread := obj["thread_id"].(string)
	// Session b cannot write into a's thread (it may read it: read_thread works across sessions):
	// its message goes to its own stream.
	if code, obj, _ := e.do("POST", "/api/agent/messages", map[string]string{"body": "x", "thread_id": thread}, bearer(b)); code != 201 || obj["thread_id"] == thread {
		t.Fatalf("cross-session write: %d %v", code, obj)
	}
	if code, _, _ := e.do("GET", "/api/agent/threads/"+thread, nil, bearer(b)); code != 200 {
		t.Fatalf("cross-session read: %d", code)
	}
}

func TestQuestionReplyIsComposedAndDelivered(t *testing.T) {
	e := newEnv(t)
	sess := e.createSession()
	body := ":::question\nWhich DB?\n- [ ] SQLite\n- [ ] Postgres\nRecommended: SQLite\n:::"
	_, sent, _ := e.do("POST", "/api/agent/messages", map[string]string{"body": body, "subject": "DB"}, bearer(sess))
	thread, msg := sent["thread_id"].(string), sent["message_id"].(string)
	qs := sent["questions"].([]any)
	key := qs[0].(map[string]any)["key"].(string)

	// A label that is not a choice is refused.
	code, _, _ := e.do("POST", "/api/threads/"+thread+"/reply", map[string]any{"words": "", "answers_for": msg,
		"answers": []map[string]any{{"key": key, "selected": []string{"MySQL"}}}}, nil)
	if code != 422 {
		t.Fatalf("bad label: %d", code)
	}
	code, _, _ = e.do("POST", "/api/threads/"+thread+"/reply", map[string]any{"words": "go", "answers_for": msg,
		"answers": []map[string]any{{"key": key, "selected": []string{"SQLite"}}}}, nil)
	if code != 201 {
		t.Fatalf("reply: %d", code)
	}

	_, _, pending := e.do("GET", "/api/agent/pending?owner=o", nil, bearer(sess))
	if len(pending) != 1 {
		t.Fatalf("pending = %v", pending)
	}
	p := pending[0].(map[string]any)
	if !strings.Contains(p["body"].(string), "Answer: SQLite (your recommendation)") || !strings.Contains(p["body"].(string), "go") {
		t.Fatalf("body = %s", p["body"])
	}
	id := p["id"].(string)
	_, c, _ := e.do("POST", "/api/agent/pending/"+id+"/claim?owner=o", nil, bearer(sess))
	if c["claimed"] != true {
		t.Fatal("claim")
	}
	_, c, _ = e.do("POST", "/api/agent/pending/"+id+"/claim?owner=other", nil, bearer(sess))
	if c["claimed"] != false {
		t.Fatal("double claim")
	}
	if code, _, _ := e.do("POST", "/api/agent/pending/"+id+"/delivered?owner=o", nil, bearer(sess)); code != 200 {
		t.Fatal("delivered")
	}
	th, _ := e.st.GetThread(context.Background(), thread)
	if th.OpenQuestions != 0 || th.LastDelivery != store.DeliveryDelivered {
		t.Fatalf("thread = %+v", th)
	}
}

func TestAnswerToAnEarlierMessageNamesIt(t *testing.T) {
	e := newEnv(t)
	sess := e.createSession()
	body := "Two ways to store it.\n\n:::question\nWhich DB?\n- [ ] SQLite\n- [ ] Postgres\n:::"
	_, sent, _ := e.do("POST", "/api/agent/messages", map[string]string{"body": body, "subject": "DB"}, bearer(sess))
	thread, msg := sent["thread_id"].(string), sent["message_id"].(string)
	key := sent["questions"].([]any)[0].(map[string]any)["key"].(string)
	// A later message moves the thread on; the earlier question still takes an answer.
	e.do("POST", "/api/agent/messages", map[string]string{"body": "Meanwhile, the build is green.", "thread_id": thread}, bearer(sess))
	code, _, _ := e.do("POST", "/api/threads/"+thread+"/reply", map[string]any{"words": "", "answers_for": msg,
		"answers": []map[string]any{{"key": key, "selected": []string{"Postgres"}}}}, nil)
	if code != 201 {
		t.Fatalf("reply: %d", code)
	}
	_, _, pending := e.do("GET", "/api/agent/pending?owner=o", nil, bearer(sess))
	if len(pending) != 1 {
		t.Fatalf("pending = %v", pending)
	}
	got := pending[0].(map[string]any)["body"].(string)
	for _, want := range []string{"your earlier message", `That message began: "Two ways to store it."`, "### Q1. Which DB?\nAnswer: Postgres"} {
		if !strings.Contains(got, want) {
			t.Errorf("missing %q in:\n%s", want, got)
		}
	}
	th, _ := e.st.GetThread(context.Background(), thread)
	if a := th.Messages[0].AnswerState[key]; len(a.Selected) != 1 || a.Selected[0] != "Postgres" {
		t.Fatalf("answer state = %+v", th.Messages[0].AnswerState)
	}
}

func TestPendingLongPollWakesOnReply(t *testing.T) {
	e := newEnv(t)
	sess := e.createSession()
	_, sent, _ := e.do("POST", "/api/agent/messages", map[string]string{"body": "done", "subject": "S"}, bearer(sess))
	thread := sent["thread_id"].(string)

	got := make(chan []any, 1)
	start := time.Now()
	go func() {
		_, _, arr := e.do("GET", "/api/agent/pending?owner=o&wait=10", nil, bearer(sess))
		got <- arr
	}()
	time.Sleep(200 * time.Millisecond)
	e.do("POST", "/api/threads/"+thread+"/reply", map[string]any{"words": "thanks"}, nil)
	select {
	case arr := <-got:
		if len(arr) != 1 || time.Since(start) > 5*time.Second {
			t.Fatalf("got %v after %v", arr, time.Since(start))
		}
	case <-time.After(8 * time.Second):
		t.Fatal("long poll did not wake")
	}
}

func TestReconcileResumesOpenSessionsOnly(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	open := e.createSession()
	closed := e.createSession()
	running := e.createSession()
	_ = e.st.SetSessionStatus(ctx, open.ID, store.StatusIdle)
	_ = e.st.SetSessionEnded(ctx, closed.ID, 0)

	// A fresh host (after an OS restart) holds only "running".
	fresh := newFakeHost()
	fresh.terms[running.ID] = termhost.TerminalInfo{ID: running.ID, Running: true}
	e.srv.sessions.setHost(fresh)
	if err := e.srv.sessions.Reconcile(ctx); err != nil {
		t.Fatal(err)
	}
	if len(fresh.spawned) != 1 || fresh.spawned[0].ID != open.ID {
		t.Fatalf("spawned = %+v", fresh.spawned)
	}
	// No transcript exists here, so it starts the same conversation id fresh.
	if argv := strings.Join(fresh.spawned[0].Argv, " "); !strings.Contains(argv, "--session-id "+open.ClaudeSessionID) {
		t.Fatalf("argv = %s", argv)
	}
	got, _ := e.st.GetSession(ctx, closed.ID)
	if got.Status != store.StatusEnded {
		t.Fatalf("closed session status = %s", got.Status)
	}
}

func TestResumeUsesTranscriptWhenThere(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	sess := e.createSession()
	cfgDir := t.TempDir()
	t.Setenv("CLAUDE_CONFIG_DIR", cfgDir)
	p := filepath.Join(cfgDir, "projects", projectDirName(sess.Cwd))
	if err := mkdirWrite(p, sess.ClaudeSessionID+".jsonl"); err != nil {
		t.Fatal(err)
	}
	_ = e.st.SetSessionEnded(ctx, sess.ID, 0)
	if err := e.srv.sessions.Restart(ctx, sess.ID); err != nil {
		t.Fatal(err)
	}
	last := e.host.spawned[len(e.host.spawned)-1]
	if argv := strings.Join(last.Argv, " "); !strings.Contains(argv, " --resume "+sess.ClaudeSessionID+" ") {
		t.Fatalf("argv = %s", argv)
	}
}

func TestProjectDirName(t *testing.T) {
	if got := projectDirName("/Users/me/work/my.app"); got != "-Users-me-work-my-app" {
		t.Fatalf("got %s", got)
	}
}

func TestUploadOnlyImages(t *testing.T) {
	e := newEnv(t)
	sess := e.createSession()
	req, _ := http.NewRequest("POST", e.ts.URL+"/api/sessions/"+sess.ID+"/uploads", strings.NewReader("hello"))
	req.Header.Set("Content-Type", "text/plain")
	resp, _ := http.DefaultClient.Do(e.auth(req))
	if resp.StatusCode != 415 {
		t.Fatalf("text upload: %d", resp.StatusCode)
	}
	req, _ = http.NewRequest("POST", e.ts.URL+"/api/sessions/"+sess.ID+"/uploads", strings.NewReader("\x89PNG...."))
	req.Header.Set("Content-Type", "image/png")
	resp, _ = http.DefaultClient.Do(e.auth(req))
	var out map[string]string
	_ = json.NewDecoder(resp.Body).Decode(&out)
	if resp.StatusCode != 201 || !strings.HasPrefix(out["path"], filepath.Join(e.dir, "scratch", sess.ID)) || !strings.HasSuffix(out["path"], ".png") {
		t.Fatalf("upload: %d %v", resp.StatusCode, out)
	}
}

func mkdirWrite(dir, name string) error {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(dir, name), []byte("{}\n"), 0o644)
}
