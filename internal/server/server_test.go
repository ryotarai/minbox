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

	"github.com/ryotarai/minbox/internal/store"
	"github.com/ryotarai/minbox/internal/termhost"
)

// fakeHost stands in for the terminal host.
type fakeHost struct {
	mu      sync.Mutex
	terms   map[string]termhost.TerminalInfo
	spawned []termhost.SpawnRequest
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
}

func newEnv(t *testing.T) *env {
	t.Helper()
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
	ts := httptest.NewServer(srv)
	t.Cleanup(ts.Close)
	return &env{t: t, srv: srv, st: st, host: host, ts: ts, dir: dir}
}

func (e *env) do(method, path string, body any, header map[string]string) (int, map[string]any, []any) {
	e.t.Helper()
	var rd io.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		rd = bytes.NewReader(b)
	}
	req, _ := http.NewRequest(method, e.ts.URL+path, rd)
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
	// Session b cannot write into or read a's thread.
	if code, _, _ := e.do("POST", "/api/agent/messages", map[string]string{"body": "x", "thread_id": thread}, bearer(b)); code != 404 {
		t.Fatalf("cross-session write: %d", code)
	}
	if code, _, _ := e.do("GET", "/api/agent/threads/"+thread, nil, bearer(b)); code != 404 {
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
	if argv := strings.Join(last.Argv, " "); !strings.HasSuffix(argv, "--resume "+sess.ClaudeSessionID) {
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
	resp, _ := http.DefaultClient.Do(req)
	if resp.StatusCode != 415 {
		t.Fatalf("text upload: %d", resp.StatusCode)
	}
	req, _ = http.NewRequest("POST", e.ts.URL+"/api/sessions/"+sess.ID+"/uploads", strings.NewReader("\x89PNG...."))
	req.Header.Set("Content-Type", "image/png")
	resp, _ = http.DefaultClient.Do(req)
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
