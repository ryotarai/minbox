package agent

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func TestFor(t *testing.T) {
	for kind, want := range map[string]string{"": Claude, "claude": Claude, "pi": Pi, "opencode": OpenCode} {
		a, err := For(kind)
		if err != nil || a.Kind() != want {
			t.Fatalf("For(%q) = %v %v", kind, a, err)
		}
	}
	if _, err := For("gemini"); err == nil || !strings.Contains(err.Error(), "unknown agent") {
		t.Fatalf("unknown: %v", err)
	}
	if Valid("") || !Valid("pi") || Valid("x") {
		t.Fatal("Valid")
	}
}

func TestClaudeArgvIsTheOriginal(t *testing.T) {
	a := Must(Claude)
	got := a.Argv(ArgvReq{Command: []string{"claude", "--model", "opus"}, Extension: "/plugin", ConversationID: "abc", Instructions: "TEXT"})
	want := []string{"claude", "--model", "opus", "--plugin-dir", "/plugin", "--session-id", "abc", "--append-system-prompt", "TEXT"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("new: %q", got)
	}
	got = a.Argv(ArgvReq{Command: []string{"claude"}, Extension: "/plugin", ConversationID: "abc", Resume: true, Instructions: "T"})
	want = []string{"claude", "--plugin-dir", "/plugin", "--resume", "abc", "--append-system-prompt", "T"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("resume: %q", got)
	}
	if got := a.Argv(ArgvReq{Command: []string{"claude"}, Extension: "/p", Instructions: "T"}); hasArg(got, "--session-id") || hasArg(got, "--resume") {
		t.Fatalf("no id: %q", got)
	}
	// The caller's command slice is not modified.
	cmd := make([]string, 1, 10)
	cmd[0] = "claude"
	a.Argv(ArgvReq{Command: cmd, Extension: "/p", Instructions: "T"})
	if cmd[:2][1] != "" {
		t.Fatal("the command slice was appended to in place")
	}
}

func hasArg(argv []string, a string) bool {
	for _, x := range argv {
		if x == a {
			return true
		}
	}
	return false
}

func TestPiArgv(t *testing.T) {
	a := Must(Pi)
	// New and resumed conversations look the same: --session-id creates the conversation if the
	// folder has none and continues it otherwise (verified in Pi 1.4.0).
	for _, resume := range []bool{false, true} {
		got := a.Argv(ArgvReq{Command: []string{"pi", "--model", "anthropic/sonnet:high"}, Extension: "/x/pi/minbox.ts", ConversationID: "uuid-1", Resume: resume, Instructions: "TEXT"})
		want := []string{"pi", "--model", "anthropic/sonnet:high", "-e", "/x/pi/minbox.ts", "--session-id", "uuid-1", "--append-system-prompt", "TEXT"}
		if !reflect.DeepEqual(got, want) {
			t.Fatalf("resume=%v: %q", resume, got)
		}
	}
	// Pi must not be started with options that hide the project's AGENTS.md / CLAUDE.md or minbox's extension.
	got := a.Argv(ArgvReq{Command: []string{"pi"}, Extension: "/e", ConversationID: "u", Instructions: "T"})
	for _, bad := range []string{"-nc", "--no-context-files", "-ne", "--no-extensions", "--no-session"} {
		if hasArg(got, bad) {
			t.Fatalf("%s in %q", bad, got)
		}
	}
	// A second extension (the subagent one) is another -e; Claude ignores it.
	got = a.Argv(ArgvReq{Command: []string{"pi"}, Extension: "/e/pi/minbox.ts", ExtraExtensions: []string{"/e/pi/subagent.ts"}, ConversationID: "u", Instructions: "T"})
	if want := []string{"pi", "-e", "/e/pi/minbox.ts", "-e", "/e/pi/subagent.ts", "--session-id", "u", "--append-system-prompt", "T"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("argv with two extensions = %q", got)
	}
	if got := Must(Claude).Argv(ArgvReq{Command: []string{"claude"}, Extension: "/p", ExtraExtensions: []string{"/x.ts"}, Instructions: "T"}); hasArg(got, "/x.ts") {
		t.Fatalf("claude got the Pi extension: %q", got)
	}
	if c := a.Caps(); c.Subagents || !c.PreassignedID || !c.RemoteHosts {
		t.Fatalf("caps = %+v", c)
	}
	if a.Tools().Name("send_message") != "minbox_send_message" || Must(Claude).Tools().Name("send_message") != "mcp__minbox__send_message" {
		t.Fatal("tool names")
	}
}

func TestPiDirNameAndConversationFile(t *testing.T) {
	// The rule is Pi's own: no leading separator, / \ : become -, between "--" and "--".
	for in, want := range map[string]string{
		"/Users/me/work/app":      "--Users-me-work-app--",
		"/private/tmp/x/-Users-a": "--private-tmp-x--Users-a--",
		`C:\work\app`:             "--C--work-app--",
		"/home/me/my.app/sub dir": "--home-me-my.app-sub dir--",
	} {
		if got := PiDirName(in); got != want {
			t.Fatalf("PiDirName(%q) = %q, want %q", in, got, want)
		}
	}
	root := t.TempDir()
	cwd := "/Users/me/work/app"
	id := "11111111-2222-4333-8444-555555555555"
	if PiConversationFile(root, cwd, id) != "" {
		t.Fatal("found a file in an empty root")
	}
	dir := filepath.Join(root, PiDirName(cwd))
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	f := filepath.Join(dir, "2026-11-10T01-02-03-000Z_"+id+".jsonl")
	if err := os.WriteFile(f, []byte(`{"type":"session"}`+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if got := PiConversationFile(root, cwd, id); got != f {
		t.Fatalf("by folder: %q", got)
	}
	// Another folder name (a symlinked cwd, an overridden session dir): found by id anywhere.
	if got := PiConversationFile(root, "/somewhere/else", id); got != f {
		t.Fatalf("by id: %q", got)
	}
	for _, bad := range []string{"", "../x", "*", "a/b"} {
		if PiConversationFile(root, cwd, bad) != "" {
			t.Fatalf("id %q matched", bad)
		}
	}
	if PiConversationFile(root, cwd, "other-id") != "" || PiConversationFile("", cwd, id) != "" {
		t.Fatal("false positive")
	}
}

func TestPiSessionsRoot(t *testing.T) {
	t.Setenv("PI_CODING_AGENT_SESSION_DIR", "")
	t.Setenv("PI_CODING_AGENT_DIR", "/agent")
	if got := PiSessionsRoot(); got != "/agent/sessions" {
		t.Fatalf("%q", got)
	}
	t.Setenv("PI_CODING_AGENT_SESSION_DIR", "/sess")
	if got := PiSessionsRoot(); got != "/sess" {
		t.Fatalf("%q", got)
	}
	t.Setenv("PI_CODING_AGENT_SESSION_DIR", "")
	t.Setenv("PI_CODING_AGENT_DIR", "")
	t.Setenv("HOME", "/h")
	if got := PiSessionsRoot(); got != "/h/.pi/agent/sessions" {
		t.Fatalf("%q", got)
	}
}

func TestRelocationNotes(t *testing.T) {
	r := Relocation{Cwd: "/new", Prev: Prev{Dir: "/old", ConversationID: "c1"}, Chain: []Prev{{Dir: "/older", ConversationID: "c0"}}}
	c := Must(Claude).RelocationNote(r)
	for _, w := range []string{"/new", "/old", "Claude Code session c1", "~/.claude/projects/-old/c1.jsonl", "CLAUDE_CONFIG_DIR", "/older, Claude Code session c0"} {
		if !strings.Contains(c, w) {
			t.Fatalf("claude note lacks %q:\n%s", w, c)
		}
	}
	p := Must(Pi).RelocationNote(r)
	for _, w := range []string{"/new", "/old", "Pi session c1", "sessions/--old--/<timestamp>_c1.jsonl", "PI_CODING_AGENT_DIR", "/older, Pi session c0"} {
		if !strings.Contains(p, w) {
			t.Fatalf("pi note lacks %q:\n%s", w, p)
		}
	}
	if strings.Contains(p, ".claude") || strings.Contains(c, "Pi session") {
		t.Fatal("a note names the other agent's paths")
	}
	if Must(Pi).RelocationNote(Relocation{Cwd: "/x"}) != "" || Must(Claude).RelocationNote(Relocation{}) != "" {
		t.Fatal("a note without a previous conversation")
	}
}

func TestClaudeHeadlessArgv(t *testing.T) {
	h := Must(Claude).Headless(HeadlessSpec{Command: []string{"claude"}, Model: "haiku", System: "SYS", Schema: "{}"})
	want := []string{"claude", "-p", "--model", "haiku", "--effort", "low", "--system-prompt", "SYS", "--tools", "", "--no-session-persistence", "--setting-sources", "", "--strict-mcp-config", "--disable-slash-commands", "--output-format", "json", "--json-schema", "{}"}
	if !reflect.DeepEqual(h.Argv, want) {
		t.Fatalf("%q", h.Argv)
	}
	out, err := h.Normalize([]byte("  {\"a\":1}\n"))
	if err != nil || string(out) != `{"a":1}` {
		t.Fatalf("normalize: %q %v", out, err)
	}
}

func TestPiHeadless(t *testing.T) {
	h := Must(Pi).Headless(HeadlessSpec{Command: []string{"pi"}, System: "SYS", Schema: `{"type":"object"}`})
	for _, w := range []string{"pi", "--print", "--offline", "--no-session", "--no-tools", "--no-extensions", "--no-skills", "--no-context-files"} {
		if !hasArg(h.Argv, w) {
			t.Fatalf("argv lacks %s: %q", w, h.Argv)
		}
	}
	if hasArg(h.Argv, "--model") {
		t.Fatalf("model without a request: %q", h.Argv)
	}
	var sys string
	for i, a := range h.Argv {
		if a == "--system-prompt" {
			sys = h.Argv[i+1]
		}
	}
	if !strings.HasPrefix(sys, "SYS") || !strings.Contains(sys, `{"type":"object"}`) {
		t.Fatalf("system prompt = %q", sys)
	}
	if got := Must(Pi).Headless(HeadlessSpec{Command: []string{"pi"}, Model: "openai/gpt-4o-mini"}).Argv; !hasArg(got, "openai/gpt-4o-mini") {
		t.Fatalf("model: %q", got)
	}

	for name, c := range map[string]struct {
		in   string
		want string // the structured_output JSON, "" for an error
	}{
		"bare":     {`{"project_id":"p1"}`, `{"project_id":"p1"}`},
		"prose":    {"Sure!\n{\"project_id\": \"p2\"}\nHope it helps.", `{"project_id":"p2"}`},
		"fenced":   {"```json\n{\"suggestions\":[\"a\",\"b\"]}\n```", `{"suggestions":["a","b"]}`},
		"braces":   {`I considered {braces} then {"x":{"y":1}} done`, `{"x":{"y":1}}`},
		"nothing":  {"I cannot decide", ""},
		"broken":   {`{"project_id": `, ""},
		"an array": {`["a"]`, ""},
		"empty":    {"", ""},
	} {
		out, err := h.Normalize([]byte(c.in))
		if c.want == "" {
			if err == nil {
				t.Fatalf("%s: want an error, got %s", name, out)
			}
			continue
		}
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		var env struct {
			S json.RawMessage `json:"structured_output"`
		}
		if json.Unmarshal(out, &env) != nil || string(env.S) != c.want {
			t.Fatalf("%s: %s", name, out)
		}
	}
}

// Commands: nothing here may need `claude`. With an empty PATH nothing is installed and Choose still answers.
func TestCommandsWithoutAnyAgent(t *testing.T) {
	t.Setenv("PATH", t.TempDir())
	c := Commands{Claude: {"claude"}, Pi: {"pi"}, OpenCode: {"opencode"}}
	if c.Installed(Claude) || c.Installed(Pi) || c.Installed(OpenCode) {
		t.Fatal("installed with an empty PATH")
	}
	if got := c.Choose(""); got != Claude {
		t.Fatalf("Choose = %q", got)
	}
	if got := c.Choose(Pi); got != Pi {
		t.Fatalf("an explicit preference is kept so a start can name the missing command: %q", got)
	}
	for _, i := range c.Infos() {
		if i.Installed || i.Path != "" || i.Command == "" || i.Label == "" {
			t.Fatalf("info = %+v", i)
		}
	}
	if err := c.NotInstalledError(Pi); err == nil || !strings.Contains(err.Error(), `"pi"`) {
		t.Fatalf("error = %v", err)
	}
}

func TestChoosePrefersInstalledAgents(t *testing.T) {
	dir := t.TempDir()
	mk := func(name string) {
		if err := os.WriteFile(filepath.Join(dir, name), []byte("#!/bin/sh\n"), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	t.Setenv("PATH", dir)
	c := Commands{Claude: {"claude"}, Pi: {"pi"}}
	mk("pi")
	if got := c.Choose(""); got != Pi {
		t.Fatalf("only pi: %q", got)
	}
	if got := c.Choose(Claude); got != Pi {
		t.Fatalf("claude preferred but missing: %q", got)
	}
	mk("claude")
	if got := c.Choose(""); got != Claude {
		t.Fatalf("both: %q", got)
	}
	if got := c.Choose(Pi); got != Pi {
		t.Fatalf("pi preferred: %q", got)
	}
	if got := c.Choose("junk"); got != Claude {
		t.Fatalf("junk preference: %q", got)
	}
	// An empty command means the agent is not offered.
	if (Commands{Claude: {"claude"}}).Installed(Pi) {
		t.Fatal("unconfigured pi installed")
	}
}
