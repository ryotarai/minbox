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

// fakeAgentBin writes an executable shell script named name into a fresh folder and returns its path.
func fakeAgentBin(t *testing.T, name, script string) string {
	t.Helper()
	p := filepath.Join(t.TempDir(), name)
	if err := os.WriteFile(p, []byte("#!/bin/sh\n"+script+"\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	return p
}

// withPi gives the env a (fake) Pi: installed, with an extension path.
func withPi(e *env, script string) string {
	bin := fakeAgentBin(e.t, "pi", script)
	e.srv.cfg.PiCommand = []string{bin}
	e.srv.sessions.cfg.PiCommand = []string{bin}
	e.srv.cfg.PiExtension = "/ext/pi/minbox.ts"
	e.srv.sessions.cfg.PiExtension = "/ext/pi/minbox.ts"
	return bin
}

// claudeAbsent makes `claude` unavailable: PATH holds nothing, and the configured command is the
// bare name, as on a machine with only Pi.
func claudeAbsent(t *testing.T) {
	t.Helper()
	t.Setenv("PATH", t.TempDir())
}

func (e *env) createAgentSession(agentKind string) (*store.Session, int, map[string]any) {
	e.t.Helper()
	code, obj, _ := e.do("POST", "/api/sessions", map[string]string{"cwd": e.dir, "name": "s", "agent": agentKind}, nil)
	if code != 201 {
		return nil, code, obj
	}
	sess, err := e.st.GetSession(context.Background(), obj["id"].(string))
	if err != nil {
		e.t.Fatal(err)
	}
	return sess, code, obj
}

func TestPiSessionSpawnsPiWithTheExtension(t *testing.T) {
	e := newEnv(t)
	bin := withPi(e, "sleep 1")
	e.srv.cfg.PiCommand = []string{bin, "--model", "anthropic/sonnet"}
	e.srv.sessions.cfg.PiCommand = e.srv.cfg.PiCommand
	sess, code, obj := e.createAgentSession("pi")
	if sess == nil {
		t.Fatalf("create: %d %v", code, obj)
	}
	if obj["agent"] != "pi" || sess.Agent != "pi" || sess.Kind != store.KindClaude {
		t.Fatalf("session = %v / %+v", obj, sess)
	}
	req := e.host.spawned[0]
	want := []string{bin, "--model", "anthropic/sonnet", "-e", "/ext/pi/minbox.ts", "--session-id", sess.ClaudeSessionID, "--append-system-prompt"}
	if len(req.Argv) != len(want)+1 || strings.Join(req.Argv[:len(want)], "\x00") != strings.Join(want, "\x00") {
		t.Fatalf("argv = %q", req.Argv)
	}
	p := lastPrompt(req.Argv)
	// One instruction text, Pi's tool names, no orchestrator (Pi has no subagents).
	if !strings.Contains(p, "minbox_send_message") || strings.Contains(p, "mcp__minbox__") || strings.Contains(p, "# minbox: orchestration") {
		t.Fatalf("prompt = %q", p)
	}
	if want := buildInstructionsFor(agent.Must(agent.Pi), false, ""); p != want {
		t.Fatalf("prompt differs from buildInstructionsFor")
	}
	env := strings.Join(req.Env, "\n")
	for _, w := range []string{"MINBOX_SESSION_ID=" + sess.ID, "MINBOX_TOKEN=" + sess.Token, "MINBOX_SERVER_FILE="} {
		if !strings.Contains(env, w) {
			t.Fatalf("env lacks %q: %v", w, req.Env)
		}
	}
	if req.Cwd != e.dir || req.InheritEnv {
		t.Fatalf("cwd/inherit: %+v", req)
	}
	// The orchestrator setting does not turn the orchestration text on for Pi.
	_ = e.st.PutSettings(context.Background(), map[string]json.RawMessage{"orchestrator_prompt": json.RawMessage("true")})
	if p := lastPrompt(e.srv.sessions.argv(context.Background(), sess, true)); strings.Contains(p, "orchestration") {
		t.Fatalf("orchestrator text for Pi: %q", p)
	}
}

// Restarting a Pi session continues the same conversation: --session-id with the same id.
func TestPiRestartKeepsTheConversationID(t *testing.T) {
	e := newEnv(t)
	withPi(e, "sleep 1")
	sess, _, _ := e.createAgentSession("pi")
	ctx := context.Background()
	_ = e.st.SetSessionEnded(ctx, sess.ID, 0)
	if err := e.srv.sessions.Restart(ctx, sess.ID); err != nil {
		t.Fatal(err)
	}
	last := e.host.spawned[len(e.host.spawned)-1]
	if !strings.Contains(strings.Join(last.Argv, " "), "--session-id "+sess.ClaudeSessionID) || hasFlag(last.Argv, "--resume") {
		t.Fatalf("argv %v", last.Argv)
	}
}

func TestHelloIsAgentAware(t *testing.T) {
	e := newEnv(t)
	withPi(e, "sleep 1")
	sess, _, _ := e.createAgentSession("pi")
	code, hello, _ := e.do("POST", "/api/agent/hello", map[string]any{"agent": "pi", "agent_session_id": "conv-2", "session_file": "/x/a_conv-2.jsonl", "ext_version": "0.1.0"}, bearer(sess))
	if code != 200 || hello["agent"] != "pi" || hello["orchestrator"] != "" {
		t.Fatalf("hello = %v", hello)
	}
	if !strings.Contains(hello["instructions"].(string), "minbox_open_url") {
		t.Fatalf("instructions = %v", hello["instructions"])
	}
	if got, _ := e.st.GetSession(context.Background(), sess.ID); got.ClaudeSessionID != "conv-2" {
		t.Fatalf("conversation id not followed: %q", got.ClaudeSessionID)
	}
	// The Claude mod's old key still works, and its hello says claude.
	c := e.createSession()
	_, h, _ := e.do("POST", "/api/agent/hello", map[string]any{"claude_session_id": "old-key"}, bearer(c))
	if h["agent"] != "claude" || h["orchestrator"] != OrchestratorPrompt {
		t.Fatalf("claude hello = %v", h)
	}
	if got, _ := e.st.GetSession(context.Background(), c.ID); got.ClaudeSessionID != "old-key" {
		t.Fatalf("claude_session_id ignored: %q", got.ClaudeSessionID)
	}
}

func TestAgentChoiceAndErrors(t *testing.T) {
	e := newEnv(t)
	// Pi is not configured: asking for it fails with a message, and an unknown agent is a 400.
	if _, code, obj := e.createAgentSession("pi"); code != 400 || !strings.Contains(obj["error"].(string), "not installed") {
		t.Fatalf("pi absent: %d %v", code, obj)
	}
	if _, code, obj := e.createAgentSession("gemini"); code != 400 || !strings.Contains(obj["error"].(string), "unknown agent") {
		t.Fatalf("unknown: %d %v", code, obj)
	}
	// Pi cannot run on another machine yet.
	withPi(e, "sleep 1")
	if _, err := e.srv.sessions.resolveAgent(context.Background(), "pi", "host_other"); err == nil || !strings.Contains(err.Error(), "own machine") {
		t.Fatalf("remote pi: %v", err)
	}
	// Project default: patch it, and a new session in the project follows it; an explicit agent wins.
	first := e.createSession() // claude (Pi would be chosen only if claude were missing)
	if first.Agent == "pi" {
		t.Fatalf("default picked pi although claude is first")
	}
	if code, _, _ := e.do("PATCH", "/api/projects/"+first.ProjectID, map[string]any{"default_agent": "nope"}, nil); code != 400 {
		t.Fatalf("bad default: %d", code)
	}
	if code, obj, _ := e.do("PATCH", "/api/projects/"+first.ProjectID, map[string]any{"default_agent": "pi"}, nil); code != 200 || obj["default_agent"] != "pi" {
		t.Fatalf("patch: %d %v", code, obj)
	}
	code, obj, _ := e.do("POST", "/api/sessions", map[string]string{"project_id": first.ProjectID, "name": "second"}, nil)
	if code != 201 || obj["agent"] != "pi" {
		t.Fatalf("project default: %d %v", code, obj)
	}
	code, obj, _ = e.do("POST", "/api/sessions", map[string]string{"project_id": first.ProjectID, "name": "third", "agent": "claude"}, nil)
	if code != 201 || obj["agent"] != "claude" {
		t.Fatalf("explicit wins: %d %v", code, obj)
	}
	// The setting must name a known agent.
	if code, _, _ := e.do("PUT", "/api/settings", map[string]any{"default_agent": "nope"}, nil); code != 400 {
		t.Fatalf("setting: %d", code)
	}
	if code, _, _ := e.do("PUT", "/api/settings", map[string]any{"default_agent": "pi"}, nil); code != 200 {
		t.Fatalf("setting pi: %d", code)
	}
	if s := e.createSession(); s.Agent != "pi" {
		t.Fatalf("setting not followed: %q", s.Agent)
	}
}

// A project's sessions that are Pi sessions move to the new folder like Claude's: a fresh
// conversation, with the old Pi session file named in the instructions.
func TestPiRelocationNote(t *testing.T) {
	e := newEnv(t)
	withPi(e, "sleep 1")
	root := t.TempDir()
	t.Setenv("PI_CODING_AGENT_SESSION_DIR", root)
	sess, _, _ := e.createAgentSession("pi")
	ctx := context.Background()
	oldDir, oldID := sess.Cwd, sess.ClaudeSessionID
	if err := mkdirWrite(filepath.Join(root, agent.PiDirName(oldDir)), "2026-01-01T00-00-00-000Z_"+oldID+".jsonl"); err != nil {
		t.Fatal(err)
	}
	other := e.mkdir("pi-moved")
	if code, _, _ := e.do("PATCH", "/api/projects/"+sess.ProjectID, map[string]any{"dir": other}, nil); code != 200 {
		t.Fatalf("patch: %d", code)
	}
	_ = e.st.SetSessionEnded(ctx, sess.ID, 0)
	n := len(e.host.spawned)
	if err := e.srv.sessions.Restart(ctx, sess.ID); err != nil {
		t.Fatal(err)
	}
	last := e.host.spawned[n]
	got, _ := e.st.GetSession(ctx, sess.ID)
	if last.Cwd != other || got.PrevClaudeSessionID != oldID || got.ClaudeSessionID == oldID {
		t.Fatalf("after start: cwd %q %+v", last.Cwd, got)
	}
	p := lastPrompt(last.Argv)
	for _, want := range []string{oldDir, oldID, "Pi session " + oldID, agent.PiDirName(oldDir), other} {
		if !strings.Contains(p, want) {
			t.Fatalf("instructions lack %q: %s", want, p)
		}
	}
	if strings.Contains(p, "~/.claude") {
		t.Fatalf("a Claude path in Pi's note: %s", p)
	}
	if !strings.Contains(strings.Join(last.Argv, " "), "--session-id "+got.ClaudeSessionID) {
		t.Fatalf("argv %v", last.Argv)
	}
}

// ---- no `claude` on PATH ----

func TestStartupAndAgentsListWithoutClaude(t *testing.T) {
	claudeAbsent(t)
	e := newEnv(t) // New() runs with ClaudeCommand ["claude"], which does not exist
	code, obj, _ := e.do("GET", "/api/agents", nil, nil)
	if code != 200 {
		t.Fatalf("agents: %d", code)
	}
	for _, a := range obj["agents"].([]any) {
		if a.(map[string]any)["installed"] != false {
			t.Fatalf("installed with an empty PATH: %v", a)
		}
	}
	if code, _, _ := e.do("GET", "/api/about", nil, nil); code != 200 {
		t.Fatalf("about: %d", code)
	}
	if code, _, _ := e.do("GET", "/api/sessions", nil, nil); code != 200 {
		t.Fatalf("sessions: %d", code)
	}
}

func TestWithoutAnyAgentTheHelpersAreOffNotBroken(t *testing.T) {
	claudeAbsent(t)
	e := newEnv(t)
	sess := e.createSession() // the fake host spawns; a real one would fail with exec's message
	_, m, _ := e.do("POST", "/api/agent/messages", map[string]any{"body": "Done."}, bearer(sess))
	id := m["thread_id"].(string)
	code, o, _ := e.do("GET", "/api/threads/"+id+"/suggestions", nil, nil)
	if code != 200 || o["reason"] != "no_agent" || o["error"] != nil || len(o["suggestions"].([]any)) != 0 {
		t.Fatalf("suggestions: %d %v", code, o)
	}
	// Slack pick: an error (so the DM falls back to the default project), never a panic.
	in := slackInbound{e.srv}
	if got, err := in.PickProject(context.Background(), "hello"); err == nil || got != "" || !strings.Contains(err.Error(), "no coding agent") {
		t.Fatalf("pick: %q %v", got, err)
	}
}

// With only Pi installed the helpers run Pi's print mode and parse its text answer.
func TestHelpersRunPiWhenItIsTheOnlyAgent(t *testing.T) {
	claudeAbsent(t)
	e := newEnv(t)
	log := filepath.Join(t.TempDir(), "args")
	withPi(e, `printf '%s\n' "$@" > `+log+`
/bin/cat > `+log+`.stdin # PATH is empty in this test
echo 'Sure, here you go:'
echo '{"suggestions":["Yes, go ahead","No, wait"]}'`)
	if code, obj, _ := e.do("GET", "/api/agents", nil, nil); code != 200 || obj["default"] != "pi" {
		t.Fatalf("default = %v", obj["default"])
	}
	if s := e.createSession(); s.Agent != "pi" {
		t.Fatalf("with only pi the default agent is pi, got %q", s.Agent)
	}
	got, err := e.srv.runSuggest(context.Background(), "the conversation")
	if err != nil || len(got) != 2 || got[0] != "Yes, go ahead" {
		t.Fatalf("suggestions %v %v", got, err)
	}
	args, _ := os.ReadFile(log)
	for _, want := range []string{"--print", "--no-session", "--no-tools", "--no-context-files", "--system-prompt", "JSON Schema"} {
		if !strings.Contains(string(args), want) {
			t.Fatalf("pi args lack %q:\n%s", want, args)
		}
	}
	if strings.Contains(string(args), "--model") {
		t.Fatalf("a model was passed without PiHelperModel:\n%s", args)
	}
	if in, _ := os.ReadFile(log + ".stdin"); string(in) != "the conversation" {
		t.Fatalf("the prompt must be on stdin, got %q", in)
	}
	e.srv.cfg.PiHelperModel = "openai/gpt-4o-mini"
	e.srv.sessions.cfg.PiHelperModel = "openai/gpt-4o-mini"
	if _, err := e.srv.runSuggest(context.Background(), "x"); err != nil {
		t.Fatal(err)
	}
	if args, _ := os.ReadFile(log); !strings.Contains(string(args), "openai/gpt-4o-mini") {
		t.Fatalf("model not passed:\n%s", args)
	}
}

// The project pick through Pi keeps its validation: only ids of existing projects count.
func TestPickProjectThroughPiValidatesIDs(t *testing.T) {
	claudeAbsent(t)
	e := newEnv(t)
	sess := e.createSession()
	proj, _ := e.st.GetProject(context.Background(), sess.ProjectID)
	pi := withPi(e, `cat >/dev/null; echo 'The best match is {"project_id": "`+sess.ProjectID+`"}.'`)
	in := slackInbound{e.srv}
	if got, err := in.PickProject(context.Background(), "x"); err != nil || got != proj.ID {
		t.Fatalf("pick = %q %v", got, err)
	}
	for _, out := range []string{`{"project_id": "proj_made_up"}`, `{"project_id": null}`} {
		if err := os.WriteFile(pi, []byte("#!/bin/sh\ncat >/dev/null; echo '"+out+"'\n"), 0o755); err != nil {
			t.Fatal(err)
		}
		if got, err := in.PickProject(context.Background(), "x"); err != nil || got != "" {
			t.Fatalf("%s: %q %v", out, got, err)
		}
	}
	if err := os.WriteFile(pi, []byte("#!/bin/sh\ncat >/dev/null; echo 'I cannot decide'\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	if got, err := in.PickProject(context.Background(), "x"); err == nil || got != "" {
		t.Fatalf("prose only: %q %v", got, err)
	}
}

// The preferred agent runs the helpers; when it is not installed the other one does.
func TestHelperFallsBackToTheOtherAgent(t *testing.T) {
	e := newEnv(t)
	claude := fakeAgentBin(t, "claude", `cat >/dev/null; echo '{"structured_output":{"suggestions":["from claude"]}}'`)
	e.srv.cfg.ClaudeCommand = []string{claude}
	e.srv.sessions.cfg.ClaudeCommand = []string{claude}
	withPi(e, `cat >/dev/null; echo '{"suggestions":["from pi"]}'`)
	run := func() string {
		got, err := e.srv.runSuggest(context.Background(), "p")
		if err != nil || len(got) != 1 {
			t.Fatalf("%v %v", got, err)
		}
		return got[0]
	}
	if run() != "from claude" {
		t.Fatal("claude is the default when both are installed")
	}
	_ = e.st.PutSettings(context.Background(), map[string]json.RawMessage{"default_agent": json.RawMessage(`"pi"`)})
	if run() != "from pi" {
		t.Fatal("the default_agent setting picks pi")
	}
	e.srv.sessions.cfg.PiCommand = []string{"/nonexistent/pi"}
	e.srv.cfg.PiCommand = e.srv.sessions.cfg.PiCommand
	if run() != "from claude" {
		t.Fatal("pi is preferred but missing: fall back to claude")
	}
}
