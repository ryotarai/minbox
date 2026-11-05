package server

import (
	"context"
	"encoding/json"
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
	for _, want := range []string{"one subagent per thread", "own git worktree", "merge conflicts", "you do the merging", "not a git repository"} {
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
