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
