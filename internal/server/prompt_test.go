package server

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
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
	// Absent setting: on, and the existing prompt is kept.
	p := lastPrompt(e.host.spawned[0].Argv)
	if !strings.HasPrefix(p, AgentSystemPrompt) || !strings.Contains(p, OrchestratorPrompt) {
		t.Fatalf("prompt = %q", p)
	}
	for _, want := range []string{"ALWAYS start one subagent per thread", "own git worktree", "merge conflicts", "you resolve them when you merge", "not a git repository"} {
		if !strings.Contains(p, want) {
			t.Fatalf("prompt lacks %q", want)
		}
	}
	_ = e.st.PutSettings(ctx, map[string]json.RawMessage{"orchestrator_prompt": json.RawMessage("false")})
	if p := lastPrompt(e.srv.sessions.argv(ctx, sess, true)); p != AgentSystemPrompt {
		t.Fatalf("off: prompt = %q", p)
	}
	_ = e.st.PutSettings(ctx, map[string]json.RawMessage{"orchestrator_prompt": json.RawMessage("true")})
	if p := lastPrompt(e.srv.sessions.argv(ctx, sess, true)); !strings.Contains(p, "# minbox: orchestration") {
		t.Fatalf("on: prompt = %q", p)
	}
	// A non-boolean value counts as unknown: on.
	_ = e.st.PutSettings(ctx, map[string]json.RawMessage{"orchestrator_prompt": json.RawMessage(`"x"`)})
	if p := lastPrompt(e.srv.sessions.argv(ctx, sess, true)); !strings.Contains(p, "# minbox: orchestration") {
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
	if h["instructions"] != buildInstructions(true, "") || h["instructions"] != lastPrompt(e.srv.sessions.argv(ctx, sess, true)) {
		t.Fatalf("hello = %v", h)
	}
	_ = e.st.PutSettings(ctx, map[string]json.RawMessage{"orchestrator_prompt": json.RawMessage("false"), "prompt_extra": json.RawMessage(`"be brief"`)})
	h = hello()
	want := AgentSystemPrompt + "\n\nThe person adds: be brief"
	if h["instructions"] != want || lastPrompt(e.srv.sessions.argv(ctx, sess, true)) != want {
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
