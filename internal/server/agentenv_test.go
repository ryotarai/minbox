package server

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/ryotarai/minbox/internal/store"
)

// A fake secret: never a real credential.
const fakeSecret = "fake-secret-value-0123456789"

// rawText is e.do with the response body as text (to check what it does not contain).
func (e *env) rawText(method, path string, body any, header map[string]string) (int, string) {
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
	b, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, string(b)
}

func envVal(req []string, key string) (string, bool) {
	v, ok := "", false
	for _, kv := range req {
		if k, val, found := strings.Cut(kv, "="); found && k == key {
			v, ok = val, true
		}
	}
	return v, ok
}

func TestAgentEnvIsStoredAndSpawned(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	code, body := e.rawText("POST", "/api/sessions", map[string]any{"cwd": e.dir, "name": "s", "env": map[string]string{
		"API_TOKEN": fakeSecret, "WITH_EQ": "a=b=c", "EMPTY": "",
	}}, nil)
	if code != 201 {
		t.Fatalf("create: %d %s", code, body)
	}
	if strings.Contains(body, fakeSecret) || !strings.Contains(body, `"env_keys":["API_TOKEN","EMPTY","WITH_EQ"]`) {
		t.Fatalf("create answered %s", body)
	}
	var obj map[string]any
	_ = json.Unmarshal([]byte(body), &obj)
	sess, err := e.st.GetSession(ctx, obj["id"].(string))
	if err != nil {
		t.Fatal(err)
	}
	if sess.Env["API_TOKEN"] != fakeSecret || sess.Env["WITH_EQ"] != "a=b=c" || sess.Env["EMPTY"] != "" || len(sess.Env) != 3 {
		t.Fatalf("stored env = %d keys %v", len(sess.Env), sess.EnvKeys)
	}
	req := e.host.spawned[len(e.host.spawned)-1]
	for k, want := range map[string]string{"API_TOKEN": fakeSecret, "WITH_EQ": "a=b=c", "EMPTY": ""} {
		if v, ok := envVal(req.Env, k); !ok || v != want {
			t.Fatalf("spawned env %s = %q (%v)", k, v, ok)
		}
	}
	// On top of the inherited environment, under minbox's own variables.
	idx := func(prefix string) int {
		for i, kv := range req.Env {
			if strings.HasPrefix(kv, prefix) {
				return i
			}
		}
		return -1
	}
	if a, m := idx("API_TOKEN="), idx("MINBOX_SESSION_ID="); a < 0 || m < 0 || a > m {
		t.Fatalf("order: API_TOKEN at %d, MINBOX_SESSION_ID at %d", a, m)
	}
	if path := idx("PATH="); path < 0 || path > idx("API_TOKEN=") {
		t.Fatalf("inherited PATH not before the person's variables: %d", path)
	}

	// The browser's session list names the keys, not the values.
	code, list := e.rawText("GET", "/api/sessions", nil, nil)
	if code != 200 || strings.Contains(list, fakeSecret) || !strings.Contains(list, `"API_TOKEN"`) {
		t.Fatalf("list: %d %s", code, list)
	}

	// The companion shell runs with them too.
	if err := e.srv.sessions.ensureShell(ctx, sess); err != nil {
		t.Fatal(err)
	}
	shell := e.host.spawned[len(e.host.spawned)-1]
	if v, _ := envVal(shell.Env, "API_TOKEN"); shell.ID != shellTermID(sess.ID) || v != fakeSecret {
		t.Fatalf("shell env: %s %q", shell.ID, v)
	}
}

func TestAgentEnvAsAListOfPairs(t *testing.T) {
	e := newEnv(t)
	for _, env := range []any{
		[]any{map[string]string{"key": "A_ONE", "value": "1"}, map[string]string{"key": "B_TWO", "value": "x=y"}},
		[]any{[]string{"A_ONE", "1"}, []string{"B_TWO", "x=y"}},
	} {
		code, obj, _ := e.do("POST", "/api/sessions", map[string]any{"cwd": e.dir, "env": env}, nil)
		if code != 201 {
			t.Fatalf("create: %d %v", code, obj)
		}
		req := e.host.spawned[len(e.host.spawned)-1]
		if a, _ := envVal(req.Env, "A_ONE"); a != "1" {
			t.Fatalf("A_ONE = %q", a)
		}
		if b, _ := envVal(req.Env, "B_TWO"); b != "x=y" {
			t.Fatalf("B_TWO = %q", b)
		}
	}
	if code, obj, _ := e.do("POST", "/api/sessions", map[string]any{"cwd": e.dir, "env": []any{"A=1"}}, nil); code != 400 {
		t.Fatalf("a bare string pair: %d %v", code, obj)
	}
}

func TestAgentEnvRejectsReservedAndBadKeys(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	for _, k := range []string{"MINBOX_TOKEN", "MINBOX_SESSION_ID", "MINBOX_SERVER_FILE", "MINBOX_ANYTHING", "minbox_token", "TERM", "COLORTERM", "OPENCODE_CONFIG_CONTENT", "1ABC", "A-B", "A B", ""} {
		code, body := e.rawText("POST", "/api/sessions", map[string]any{"cwd": e.dir, "env": map[string]string{k: fakeSecret}}, nil)
		if code != 400 || strings.Contains(body, fakeSecret) {
			t.Fatalf("%q: %d %s", k, code, body)
		}
	}
	if code, body := e.rawText("POST", "/api/sessions", map[string]any{"cwd": e.dir, "env": map[string]string{"OK": "a\x00b"}}, nil); code != 400 {
		t.Fatalf("NUL: %d %s", code, body)
	}
	// Through the composer's "new agent" too.
	p, _, _ := e.st.EnsureProject(ctx, store.LocalHostID, e.dir)
	if code, body := e.rawText("POST", "/api/v3/new", map[string]any{"to": "new", "project_id": p.ID, "words": "hi", "env": map[string]string{"MINBOX_TOKEN": "x"}}, nil); code != 400 || !strings.Contains(body, "MINBOX_TOKEN") {
		t.Fatalf("v3 new: %d %s", code, body)
	}
	if list, _ := e.st.ListSessions(ctx); len(list) != 0 || len(e.host.spawned) != 0 {
		t.Fatalf("created %d sessions, spawned %d", len(list), len(e.host.spawned))
	}
	// A key minbox sets that was stored anyway (an older rule) never overrides minbox's own.
	sess := e.createSession()
	_ = e.st.SetSessionEnv(ctx, sess.ID, map[string]string{"MINBOX_TOKEN": "evil", "TERM": "dumb", "FINE": "1"})
	got, _ := e.st.GetSession(ctx, sess.ID)
	env := e.srv.sessions.sessionEnv(got)
	if v, _ := envVal(env, "MINBOX_TOKEN"); v != sess.Token {
		t.Fatal("a stored MINBOX_TOKEN overrode the session's")
	}
	if v, _ := envVal(env, "TERM"); v != "xterm-256color" {
		t.Fatalf("TERM = %q", v)
	}
	if v, _ := envVal(env, "FINE"); v != "1" {
		t.Fatalf("FINE = %q", v)
	}
}

func TestAgentEnvSurvivesRestartAndResume(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	code, obj, _ := e.do("POST", "/api/sessions", map[string]any{"cwd": e.dir, "env": map[string]string{"API_TOKEN": fakeSecret}}, nil)
	if code != 201 {
		t.Fatalf("create: %d %v", code, obj)
	}
	id := obj["id"].(string)
	// A restart of an ended agent.
	_ = e.st.SetSessionEnded(ctx, id, 0)
	if err := e.srv.sessions.Restart(ctx, id); err != nil {
		t.Fatal(err)
	}
	if v, _ := envVal(e.host.spawned[len(e.host.spawned)-1].Env, "API_TOKEN"); v != fakeSecret {
		t.Fatalf("after restart: %q", v)
	}
	// The server starts again (a fresh terminal host, the same database): the agent resumes with them.
	fresh := newFakeHost()
	e.srv.sessions.setHost(fresh)
	if err := e.srv.sessions.Reconcile(ctx); err != nil {
		t.Fatal(err)
	}
	if len(fresh.spawned) != 1 {
		t.Fatalf("resumed %d", len(fresh.spawned))
	}
	if v, _ := envVal(fresh.spawned[0].Env, "API_TOKEN"); v != fakeSecret {
		t.Fatalf("after resume: %q", v)
	}
	// And the database keeps them across a reopen.
	path := filepath.Join(e.dir, "db")
	st2, err := store.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer st2.Close()
	if s, _ := st2.GetSession(ctx, id); s.Env["API_TOKEN"] != fakeSecret {
		t.Fatal("not stored")
	}
}

// The agents' API (the mod's tools) never shows another agent's values, nor its own.
func TestAgentAPIDoesNotExposeEnv(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	code, obj, _ := e.do("POST", "/api/sessions", map[string]any{"cwd": e.dir, "name": "holder", "env": map[string]string{"API_TOKEN": fakeSecret}}, nil)
	if code != 201 {
		t.Fatalf("create: %d %v", code, obj)
	}
	holder, _ := e.st.GetSession(ctx, obj["id"].(string))
	other := e.createSession()
	for _, who := range []*store.Session{other, holder} {
		for _, p := range []string{"/api/agent/sessions", "/api/agent/sessions?archived=0", "/api/agent/projects", "/api/agent/projects/" + holder.ProjectID, "/api/agent/search?q=holder", "/api/agent/hello"} {
			method := "GET"
			if p == "/api/agent/hello" {
				method = "POST"
			}
			code, body := e.rawText(method, p, nil, bearer(who))
			if strings.Contains(body, fakeSecret) {
				t.Fatalf("%s %s (%d) shows the value: %s", method, p, code, body)
			}
		}
		for _, tool := range []struct {
			name string
			args map[string]any
		}{{"list_sessions", map[string]any{}}, {"list_projects", map[string]any{}}, {"get_project", map[string]any{"project_id": holder.ProjectID}}, {"search", map[string]any{"query": "holder"}}} {
			code, body := e.rawText("POST", "/api/agent/tool", map[string]any{"tool": tool.name, "args": tool.args}, bearer(who))
			if code != 200 || strings.Contains(body, fakeSecret) {
				t.Fatalf("tool %s: %d %s", tool.name, code, body)
			}
			if tool.name == "list_sessions" && !strings.Contains(body, "holder") {
				t.Fatalf("list_sessions does not list the agent: %s", body)
			}
		}
	}
}

// On another machine the host adds them to its own environment and the agent's process gets them.
func TestAgentEnvOnRemoteHost(t *testing.T) {
	e := newEnv(t)
	e.srv.pairPoll = 50 * time.Millisecond
	hostURL, hostDir, _ := remoteHost(t, "", "")
	hostID := pairHost(t, e, hostURL, hostDir)
	work := t.TempDir()
	e.srv.sessions.cfg.ClaudeCommand = []string{"/bin/sh", "-c", `echo "got=[$API_TOKEN] eq=[$WITH_EQ] empty=${EMPTY-unset}. term=$TERM"; sleep 30`, "sh"}
	code, sessJSON, _ := e.do("POST", "/api/sessions", map[string]any{"cwd": work, "host_id": hostID, "env": map[string]string{"API_TOKEN": fakeSecret, "WITH_EQ": "a=b", "EMPTY": ""}}, nil)
	if code != 201 {
		t.Fatalf("create: %d %v", code, sessJSON)
	}
	sessID := sessJSON["id"].(string)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	ws, _, err := websocket.Dial(ctx, strings.Replace(e.ts.URL, "http", "ws", 1)+"/api/sessions/"+sessID+"/terminal", &websocket.DialOptions{HTTPHeader: e.authHeader()})
	if err != nil {
		t.Fatal(err)
	}
	defer ws.CloseNow()
	var out strings.Builder
	for !strings.Contains(out.String(), "term=") || !strings.Contains(out.String(), "color") {
		typ, data, err := ws.Read(ctx)
		if err != nil {
			t.Fatalf("terminal: %v (got %q)", err, out.String())
		}
		if typ == websocket.MessageBinary {
			out.Write(data)
		}
	}
	if s := out.String(); !strings.Contains(s, "got=["+fakeSecret+"]") || !strings.Contains(s, "eq=[a=b]") || !strings.Contains(s, "empty=.") || !strings.Contains(s, "term=xterm-256color") {
		t.Fatalf("terminal said %q", s)
	}
}
