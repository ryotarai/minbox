package server

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/ryotarai/minbox/internal/agent"
	"github.com/ryotarai/minbox/internal/store"
)

func lastPrompt(argv []string) string {
	for i, a := range argv {
		if a == "--append-system-prompt" && i+1 < len(argv) {
			return argv[i+1]
		}
	}
	return ""
}

func TestOrchestratorPromptSetting(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	sess := e.createSession()
	// A Claude Code agent here gets the instructions from its mod, not the command line.
	if p := lastPrompt(e.host.spawned[0].Argv); p != "" {
		t.Fatalf("argv carries the instructions: %q", p)
	}
	// Absent setting: on, and the existing prompt is kept.
	p := e.srv.sessions.instructions(ctx, sess)
	if !strings.HasPrefix(p, AgentSystemPrompt) || !strings.Contains(p, OrchestratorPrompt) {
		t.Fatalf("prompt = %q", p)
	}
	for _, want := range []string{"ALWAYS start one subagent per task", "own git worktree", "merge conflicts", "the integration subagent resolves them", "Stay responsive", "one integration at a time", "not a git repository", "brief it with the task_id and the step numbers", "check_steps and a concrete summary"} {
		if !strings.Contains(p, want) {
			t.Fatalf("prompt lacks %q", want)
		}
	}
	_ = e.st.PutSettings(ctx, map[string]json.RawMessage{"orchestrator_prompt": json.RawMessage("false")})
	if p := e.srv.sessions.instructions(ctx, sess); p != AgentSystemPrompt {
		t.Fatalf("off: prompt = %q", p)
	}
	_ = e.st.PutSettings(ctx, map[string]json.RawMessage{"orchestrator_prompt": json.RawMessage("true")})
	if p := e.srv.sessions.instructions(ctx, sess); !strings.Contains(p, "# minbox: orchestration") {
		t.Fatalf("on: prompt = %q", p)
	}
	// A non-boolean value counts as unknown: on.
	_ = e.st.PutSettings(ctx, map[string]json.RawMessage{"orchestrator_prompt": json.RawMessage(`"x"`)})
	if p := e.srv.sessions.instructions(ctx, sess); !strings.Contains(p, "# minbox: orchestration") {
		t.Fatalf("junk: prompt = %q", p)
	}
}

func TestHelloReturnsOrchestrator(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	sess := e.createSession()
	_, hello, _ := e.do("POST", "/api/agent/hello", map[string]any{}, bearer(sess))
	if hello["orchestrator"] != OrchestratorPrompt {
		t.Fatalf("on: hello = %v", hello)
	}
	_ = e.st.PutSettings(ctx, map[string]json.RawMessage{"orchestrator_prompt": json.RawMessage("false")})
	_, hello, _ = e.do("POST", "/api/agent/hello", map[string]any{}, bearer(sess))
	if v, ok := hello["orchestrator"]; !ok || v != "" {
		t.Fatalf("off: hello = %v", hello)
	}
}

func TestBuildInstructions(t *testing.T) {
	if got := buildInstructions(false, ""); got != AgentSystemPrompt {
		t.Fatalf("off: %q", got)
	}
	if got := buildInstructions(true, "  "); got != AgentSystemPrompt+"\n\n"+OrchestratorPrompt {
		t.Fatalf("on: %q", got)
	}
	got := buildInstructions(true, " be brief ")
	if !strings.HasSuffix(got, "\n\nThe person adds: be brief") || !strings.Contains(got, OrchestratorPrompt) {
		t.Fatalf("extra: %q", got)
	}
	if got := buildInstructions(false, "x"); got != AgentSystemPrompt+"\n\nThe person adds: x" {
		t.Fatalf("off+extra: %q", got)
	}
}

func TestHelloInstructionsMatchArgv(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	sess := e.createSession()
	hello := func() map[string]any {
		_, h, _ := e.do("POST", "/api/agent/hello", map[string]any{}, bearer(sess))
		return h
	}
	h := hello()
	if h["instructions"] != buildInstructions(true, "") || h["instructions"] != e.srv.sessions.instructions(ctx, sess) {
		t.Fatalf("hello = %v", h)
	}
	_ = e.st.PutSettings(ctx, map[string]json.RawMessage{"orchestrator_prompt": json.RawMessage("false"), "prompt_extra": json.RawMessage(`"be brief"`)})
	h = hello()
	want := AgentSystemPrompt + "\n\nThe person adds: be brief"
	if h["instructions"] != want || e.srv.sessions.instructions(ctx, sess) != want {
		t.Fatalf("off+extra: hello = %v", h)
	}
	if h["prompt_extra"] != "be brief" || h["orchestrator"] != "" {
		t.Fatalf("compat fields: %v", h)
	}
}

func TestArgvResumeVsSessionID(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	sess := e.createSession()
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("CLAUDE_CONFIG_DIR", "")
	flagged := func(flag string) bool {
		a := e.srv.sessions.argv(ctx, sess, true)
		for i := range a {
			if a[i] == flag && i+1 < len(a) && a[i+1] == sess.ClaudeSessionID {
				return true
			}
		}
		return false
	}
	if !flagged("--session-id") || flagged("--resume") {
		t.Fatalf("no transcript: want --session-id, got %v", e.srv.sessions.argv(ctx, sess, true))
	}
	dir := filepath.Join(home, ".claude", "projects", "-elsewhere")
	_ = os.MkdirAll(dir, 0o755)
	_ = os.WriteFile(filepath.Join(dir, sess.ClaudeSessionID+".jsonl"), []byte("{}\n"), 0o600)
	if !flagged("--resume") || flagged("--session-id") {
		t.Fatalf("transcript: want --resume, got %v", e.srv.sessions.argv(ctx, sess, true))
	}
}

// agentInstructions is the instructions text the session's mod is served (GET /api/agent/instructions).
func (e *env) agentInstructions(id string) string {
	e.t.Helper()
	sess, err := e.st.GetSession(context.Background(), id)
	if err != nil {
		e.t.Fatal(err)
	}
	code, obj, _ := e.do("GET", "/api/agent/instructions", nil, bearer(sess))
	if code != 200 {
		e.t.Fatalf("instructions: %d %v", code, obj)
	}
	text, _ := obj["text"].(string)
	return text
}

// The Claude Code mod is served the instructions with their version; the version follows the text
// and is the one the hello and every heartbeat answer.
func TestAgentInstructionsEndpoint(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	sess := e.createSession()
	code, obj, _ := e.do("GET", "/api/agent/instructions", nil, bearer(sess))
	text, _ := obj["text"].(string)
	if code != 200 || text != e.srv.sessions.instructions(ctx, sess) || !strings.HasPrefix(text, AgentSystemPrompt) {
		t.Fatalf("instructions: %d %v", code, obj)
	}
	v1, _ := obj["version"].(string)
	if v1 != promptID(text) || obj["section"] != true {
		t.Fatalf("version/section: %v", obj)
	}
	if _, hello, _ := e.do("POST", "/api/agent/hello", map[string]any{}, bearer(sess)); hello["instructions_version"] != v1 {
		t.Fatalf("hello: %v", hello)
	}
	if _, hb, _ := e.do("POST", "/api/agent/heartbeat", map[string]any{"seq": 1}, bearer(sess)); hb["instructions_version"] != v1 {
		t.Fatalf("heartbeat: %v", hb)
	}
	// The person's prompt setting changes the text: a new version, in the heartbeat's answer too.
	_ = e.st.PutSettings(ctx, map[string]json.RawMessage{"prompt_extra": json.RawMessage(`"be brief"`)})
	_, obj, _ = e.do("GET", "/api/agent/instructions", nil, bearer(sess))
	v2, _ := obj["version"].(string)
	if v2 == v1 || !strings.HasSuffix(obj["text"].(string), "The person adds: be brief") {
		t.Fatalf("after the setting: %v", obj)
	}
	if _, hb, _ := e.do("POST", "/api/agent/heartbeat", map[string]any{"seq": 2}, bearer(sess)); hb["instructions_version"] != v2 {
		t.Fatalf("heartbeat after the setting: %v", hb)
	}
	// Unauthenticated: refused.
	if code, _, _ := e.do("GET", "/api/agent/instructions", nil, nil); code != 401 {
		t.Fatalf("no token: %d", code)
	}
}

// Who gets the instructions as a live prompt section, and who on the command line.
func TestLiveInstructionsOnlyForLocalClaude(t *testing.T) {
	e := newEnv(t)
	m := e.srv.sessions
	for _, c := range []struct {
		sess *store.Session
		want bool
	}{
		{&store.Session{Kind: store.KindClaude, Agent: agent.Claude}, true},
		{&store.Session{Kind: store.KindClaude, Agent: ""}, true}, // an older record: Claude Code
		{&store.Session{Kind: store.KindClaude, Agent: agent.Pi}, false},
		{&store.Session{Kind: store.KindClaude, Agent: agent.OpenCode}, false},
		{&store.Session{Kind: store.KindClaude, Agent: agent.Claude, HostID: "h1"}, false},
		{&store.Session{Kind: store.KindShell}, false},
	} {
		if got := m.liveInstructions(c.sess); got != c.want {
			t.Errorf("%+v: live = %v, want %v", c.sess, got, c.want)
		}
	}
	// Pi keeps the command line.
	pi := &store.Session{ID: "p", Kind: store.KindClaude, Agent: agent.Pi, Cwd: t.TempDir(), ClaudeSessionID: "u"}
	if p := lastPrompt(m.argv(context.Background(), pi, false)); p == "" || p != m.instructions(context.Background(), pi) {
		t.Fatalf("pi argv lacks the instructions: %q", p)
	}
}
