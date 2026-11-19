package server

import (
	"context"
	"encoding/json"
	"fmt"
	"slices"
	"testing"
	"testing/fstest"

	"github.com/ryotarai/minbox/internal/agent"
	"github.com/ryotarai/minbox/internal/store"
	"github.com/ryotarai/minbox/internal/termhost"
)

// listed is the browser's view of one session (GET /api/sessions).
func (e *env) listed(id string) map[string]any {
	e.t.Helper()
	code, _, arr := e.do("GET", "/api/sessions", nil, nil)
	if code != 200 {
		e.t.Fatalf("list sessions: %d", code)
	}
	for _, v := range arr {
		if m, _ := v.(map[string]any); m != nil && m["id"] == id {
			return m
		}
	}
	e.t.Fatalf("session %s not listed", id)
	return nil
}

func staleOf(m map[string]any) (bool, []string) {
	stale, _ := m["stale"].(bool)
	var reasons []string
	if rs, ok := m["stale_reasons"].([]any); ok {
		for _, r := range rs {
			reasons = append(reasons, fmt.Sprint(r))
		}
	}
	return stale, reasons
}

func (e *env) wantStale(id string, want ...string) {
	e.t.Helper()
	stale, reasons := staleOf(e.listed(id))
	if stale != (len(want) > 0) || !slices.Equal(reasons, want) {
		e.t.Fatalf("stale = %v %q, want %q", stale, reasons, want)
	}
}

func TestStaleFreshAgentIsNot(t *testing.T) {
	e := newEnv(t)
	sess := e.createSession()
	got, _ := e.st.GetSession(context.Background(), sess.ID)
	if got.RunPlugin == "" || got.RunPrompt == "" {
		t.Fatalf("start not recorded: plugin %q prompt %q", got.RunPlugin, got.RunPrompt)
	}
	if got.RunPlugin != termhost.PluginID("/plugin") {
		t.Fatalf("plugin = %q", got.RunPlugin)
	}
	e.wantStale(sess.ID)
	if v := e.listed(sess.ID)["run_version"]; v != got.RunPlugin+"."+got.RunPrompt {
		t.Fatalf("run_version = %v", v)
	}
}

// A server restarted with the same binary and settings: the same content, so nothing is stale.
func TestStaleNotAfterServerRestartWithSameContent(t *testing.T) {
	e := newEnv(t)
	sess := e.createSession()
	_ = e.st.SetSessionStatus(context.Background(), sess.ID, store.StatusIdle)
	again := New(e.srv.cfg, e.st, fstest.MapFS{})
	got, _ := e.st.GetSession(context.Background(), sess.ID)
	stored, _ := e.st.Settings(context.Background())
	again.withStale(stored, got)
	if got.Stale || len(got.StaleReasons) > 0 {
		t.Fatalf("stale after a restart with the same content: %v", got.StaleReasons)
	}
}

func TestStalePromptAndPluginChanges(t *testing.T) {
	e := newEnv(t)
	sess := e.createSession()
	_ = e.st.SetSessionStatus(context.Background(), sess.ID, store.StatusIdle)

	// The person's prompt setting changed: the instructions the agent started with are older.
	if code, obj, _ := e.do("PUT", "/api/settings", map[string]any{"prompt_extra": "be brief"}, nil); code != 200 {
		t.Fatalf("settings: %d %v", code, obj)
	}
	e.wantStale(sess.ID, "prompt")

	// A new minbox with another mod (a new content-hash folder).
	e.srv.sessions.cfg.PluginDir = "/data/plugin/0123456789ab"
	e.wantStale(sess.ID, "plugin", "prompt")

	// Back to the prompt it started with: only the plugin.
	if code, _, _ := e.do("PUT", "/api/settings", map[string]any{"prompt_extra": ""}, nil); code != 200 {
		t.Fatal("settings")
	}
	e.wantStale(sess.ID, "plugin")

	// Restarting the agent loads the current ones.
	_ = e.st.SetSessionEnded(context.Background(), sess.ID, 0)
	e.wantStale(sess.ID) // an ended agent is never stale
	if code, _, _ := e.do("POST", "/api/sessions/"+sess.ID+"/restart", nil, nil); code != 200 {
		t.Fatalf("restart: %d", code)
	}
	e.wantStale(sess.ID)
	got, _ := e.st.GetSession(context.Background(), sess.ID)
	if got.RunPlugin != termhost.PluginID("/data/plugin/0123456789ab") {
		t.Fatalf("plugin after restart = %q", got.RunPlugin)
	}
}

// The prompt constants changed (a new minbox): the hash of the text differs.
func TestStalePromptTextChange(t *testing.T) {
	e := newEnv(t)
	sess := e.createSession()
	got, _ := e.st.GetSession(context.Background(), sess.ID)
	_ = e.st.SetSessionRun(context.Background(), sess.ID, got.RunPlugin, promptID("an older text"))
	e.wantStale(sess.ID, "prompt")
}

// An agent started before minbox recorded what it loaded, a shell, a host that does not report
// its plugins: never stale.
func TestStaleUnknownNeverCounts(t *testing.T) {
	e := newEnv(t)
	sess := e.createSession()
	_ = e.st.SetSessionRun(context.Background(), sess.ID, "", "")
	e.srv.sessions.cfg.PluginDir = "/elsewhere"
	_ = e.st.PutSettings(context.Background(), map[string]json.RawMessage{"prompt_extra": json.RawMessage(`"x"`)})
	e.wantStale(sess.ID)

	shell := &store.Session{ID: "sh", Kind: store.KindShell, Status: store.StatusIdle, RunPlugin: "a", RunPrompt: "b"}
	if r := e.srv.sessions.staleReasons(nil, shell); r != nil {
		t.Fatalf("a shell is stale: %v", r)
	}
}

// On another machine the host's own plugin counts: what its /version reports.
func TestStaleRemoteHostPlugin(t *testing.T) {
	e := newEnv(t)
	m := e.srv.sessions
	c := &hostConn{id: "h1", name: "box", status: "online", latency: -1}
	m.hosts.put(c)
	c.setVersion(termhost.VersionInfo{Plugins: map[string]string{agent.Claude: "aaa", agent.Pi: "ppp"}}, 0)
	sess := &store.Session{ID: "r", Kind: store.KindClaude, Agent: agent.Claude, HostID: "h1", Status: store.StatusIdle}
	sess.RunPlugin, sess.RunPrompt = m.runVersion(context.Background(), sess)
	if sess.RunPlugin != "aaa" {
		t.Fatalf("remote plugin = %q", sess.RunPlugin)
	}
	if r := m.staleReasons(nil, sess); r != nil {
		t.Fatalf("fresh remote agent is stale: %v", r)
	}
	// The host was updated: its mod changed.
	if !c.setVersion(termhost.VersionInfo{Plugins: map[string]string{agent.Claude: "bbb", agent.Pi: "ppp"}}, 0) {
		t.Fatal("setVersion did not report the change")
	}
	if r := m.staleReasons(nil, sess); !slices.Equal(r, []string{"plugin"}) {
		t.Fatalf("reasons = %v", r)
	}
	// The same report again is no change; a host that reports nothing is unknown, never stale.
	if c.setVersion(termhost.VersionInfo{Plugins: map[string]string{agent.Claude: "bbb", agent.Pi: "ppp"}}, 0) {
		t.Fatal("setVersion reported a change for the same plugins")
	}
	c.setVersion(termhost.VersionInfo{}, 0)
	if r := m.staleReasons(nil, sess); r != nil {
		t.Fatalf("unknown host plugins count as stale: %v", r)
	}
}
