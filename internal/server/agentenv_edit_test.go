package server

import (
	"context"
	"strings"
	"testing"

	"github.com/ryotarai/minbox/internal/store"
)

// PATCH /api/sessions/{id}/env: set adds or replaces, unset removes, the rest keeps its value; the
// values never come back; a running agent is stale ("env") until a restart gives it the new set.
func TestAgentEnvEdit(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	const newSecret = "fake-new-secret-9876543210"
	code, obj, _ := e.do("POST", "/api/sessions", map[string]any{"cwd": e.dir, "env": map[string]string{"API_TOKEN": fakeSecret, "KEEP": "kept", "GONE": "bye"}}, nil)
	if code != 201 {
		t.Fatalf("create: %d %v", code, obj)
	}
	id := obj["id"].(string)
	e.wantStale(id)
	spawns := len(e.host.spawned)

	code, body := e.rawText("PATCH", "/api/sessions/"+id+"/env", map[string]any{
		"set":   map[string]string{"API_TOKEN": newSecret, "ADDED": "x=y"},
		"unset": []string{"GONE", "NEVER_SET"},
	}, nil)
	if code != 200 || strings.Contains(body, newSecret) || strings.Contains(body, fakeSecret) || !strings.Contains(body, `"env_keys":["ADDED","API_TOKEN","KEEP"]`) {
		t.Fatalf("patch: %d %s", code, body)
	}
	got, _ := e.st.GetSession(ctx, id)
	want := map[string]string{"API_TOKEN": newSecret, "ADDED": "x=y", "KEEP": "kept"}
	if len(got.Env) != len(want) {
		t.Fatalf("stored %v", got.EnvKeys)
	}
	for k, v := range want {
		if got.Env[k] != v {
			t.Fatalf("stored %s wrong", k)
		}
	}
	if len(e.host.spawned) != spawns {
		t.Fatal("the edit restarted the agent")
	}
	// Not applied yet: the running agent is stale for "env"; the list names keys, never values.
	e.wantStale(id, "env")
	if code, list := e.rawText("GET", "/api/sessions", nil, nil); code != 200 || strings.Contains(list, newSecret) || strings.Contains(list, fakeSecret) {
		t.Fatalf("list: %d %s", code, list)
	}

	// The restart (resuming the conversation) picks them up and clears the mark.
	if code, _, _ := e.do("POST", "/api/sessions/"+id+"/restart", nil, nil); code != 200 {
		t.Fatalf("restart: %d", code)
	}
	req := e.host.spawned[len(e.host.spawned)-1]
	for k, v := range want {
		if got, ok := envVal(req.Env, k); !ok || got != v {
			t.Fatalf("after restart %s wrong (set: %v)", k, ok)
		}
	}
	if _, ok := envVal(req.Env, "GONE"); ok {
		t.Fatal("GONE still in the restarted agent's environment")
	}
	e.wantStale(id)

	// The companion shell's next start has them too.
	sess, _ := e.st.GetSession(ctx, id)
	if err := e.srv.sessions.ensureShell(ctx, sess); err != nil {
		t.Fatal(err)
	}
	shell := e.host.spawned[len(e.host.spawned)-1]
	if v, _ := envVal(shell.Env, "API_TOKEN"); shell.ID != shellTermID(id) || v != newSecret {
		t.Fatalf("shell env: %s", shell.ID)
	}

	// Removing every variable; then setting the started ones back is no longer stale.
	if code, body := e.rawText("PATCH", "/api/sessions/"+id+"/env", map[string]any{"unset": []string{"API_TOKEN", "ADDED", "KEEP"}}, nil); code != 200 || !strings.Contains(body, `"env_keys":[]`) {
		t.Fatalf("unset all: %d %s", code, body)
	}
	if got, _ := e.st.GetSession(ctx, id); len(got.Env) != 0 {
		t.Fatalf("left %v", got.EnvKeys)
	}
	e.wantStale(id, "env")
	if code, _ := e.rawText("PATCH", "/api/sessions/"+id+"/env", map[string]any{"set": want}, nil); code != 200 {
		t.Fatalf("set back: %d", code)
	}
	e.wantStale(id)
}

func TestAgentEnvEditRejects(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	code, obj, _ := e.do("POST", "/api/sessions", map[string]any{"cwd": e.dir, "env": map[string]string{"API_TOKEN": fakeSecret}}, nil)
	if code != 201 {
		t.Fatalf("create: %d %v", code, obj)
	}
	id := obj["id"].(string)
	path := "/api/sessions/" + id + "/env"
	unchanged := func(what string) {
		t.Helper()
		got, _ := e.st.GetSession(ctx, id)
		if len(got.Env) != 1 || got.Env["API_TOKEN"] != fakeSecret {
			t.Fatalf("%s changed the variables: %v", what, got.EnvKeys)
		}
	}
	for _, k := range []string{"MINBOX_TOKEN", "minbox_x", "TERM", "COLORTERM", "OPENCODE_CONFIG_CONTENT", "1ABC", "A-B", ""} {
		code, body := e.rawText("PATCH", path, map[string]any{"set": map[string]string{k: "fake-v"}}, nil)
		if code != 400 || strings.Contains(body, "fake-v") || strings.Contains(body, fakeSecret) {
			t.Fatalf("%q: %d %s", k, code, body)
		}
		unchanged(k)
	}
	if code, body := e.rawText("PATCH", path, map[string]any{"set": map[string]string{"OK": "a\x00b"}}, nil); code != 400 {
		t.Fatalf("NUL: %d %s", code, body)
	}
	if code, body := e.rawText("PATCH", path, map[string]any{"set": map[string]string{"API_TOKEN": "x"}, "unset": []string{"API_TOKEN"}}, nil); code != 400 {
		t.Fatalf("set and unset: %d %s", code, body)
	}
	unchanged("set and unset")

	// An agent's token never reaches it (no paired device): neither its own agent's nor another's.
	other := e.createSession()
	holder, _ := e.st.GetSession(ctx, id)
	for _, who := range []*store.Session{holder, other} {
		h := bearer(who)
		h["Cookie"] = ""
		if code, body := e.rawText("PATCH", path, map[string]any{"set": map[string]string{"API_TOKEN": "agent-set"}}, h); code != 401 || strings.Contains(body, fakeSecret) {
			t.Fatalf("agent token: %d %s", code, body)
		}
		unchanged("an agent token")
		// Nor anything under the agents' API.
		h = bearer(who)
		h["Cookie"] = ""
		if code, _ := e.rawText("PATCH", "/api/agent/sessions/"+id+"/env", map[string]any{"set": map[string]string{"API_TOKEN": "agent-set"}}, h); code < 400 {
			t.Fatalf("agent API: %d", code)
		}
		unchanged("the agent API")
	}

	// An unknown agent is 404.
	if code, _ := e.rawText("PATCH", "/api/sessions/nope/env", map[string]any{"set": map[string]string{"A": "1"}}, nil); code != 404 {
		t.Fatalf("unknown: %d", code)
	}

	// A stored key an older rule allowed is dropped by an edit, never kept.
	_ = e.st.SetSessionEnv(ctx, id, map[string]string{"MINBOX_TOKEN": "evil", "API_TOKEN": fakeSecret})
	if code, body := e.rawText("PATCH", path, map[string]any{"set": map[string]string{"NEW": "1"}}, nil); code != 200 || !strings.Contains(body, `"env_keys":["API_TOKEN","NEW"]`) {
		t.Fatalf("legacy: %d %s", code, body)
	}
}

// An agent started before the record (no run_env) is not counted stale for "env".
func TestAgentEnvStaleNotRecorded(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	sess := e.createSession()
	_ = e.st.SetSessionRunEnv(ctx, sess.ID, "")
	_ = e.st.SetSessionEnv(ctx, sess.ID, map[string]string{"A": "1"})
	e.wantStale(sess.ID)
}
