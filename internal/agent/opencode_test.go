package agent

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

func TestOpenCodeArgvAndEnv(t *testing.T) {
	a := Must(OpenCode)
	if a.Kind() != OpenCode || a.Tools().Prefix != "minbox_" {
		t.Fatalf("kind/prefix: %s %s", a.Kind(), a.Tools().Prefix)
	}
	c := a.Caps()
	if !c.Subagents || !c.PreassignedID || !c.RemoteHosts || !c.MovableConversation {
		t.Fatalf("caps: %+v", c)
	}
	// New and resumed look the same: minbox creates the session before the start.
	for _, resume := range []bool{false, true} {
		got := a.Argv(ArgvReq{Command: []string{"opencode", "-m", "x"}, Extension: "/ext/opencode", ConversationID: "ses_abc", Resume: resume, Instructions: "TEXT"})
		want := []string{"opencode", "-m", "x", "--standalone", "--auto", "--session", "ses_abc"}
		if !reflect.DeepEqual(got, want) {
			t.Fatalf("resume=%v: %q", resume, got)
		}
	}
	// The person's own --standalone / --auto are not repeated.
	got := a.Argv(ArgvReq{Command: []string{"opencode", "--standalone", "--auto"}, ConversationID: "ses_x"})
	if want := []string{"opencode", "--standalone", "--auto", "--session", "ses_x"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("own flags: %q", got)
	}

	env := a.Env(ArgvReq{Extension: "/ext/opencode", ConversationID: "ses_abc", Cwd: "/work/api"})
	vals := map[string]string{}
	for _, kv := range env {
		k, v, _ := strings.Cut(kv, "=")
		vals[k] = v
	}
	if vals["MINBOX_OPENCODE_SESSION"] != "ses_abc" || vals["MINBOX_OPENCODE_DIR"] != "/work/api" {
		t.Fatalf("env: %q", env)
	}
	var cfg struct {
		Plugins []map[string]string `json:"plugins"`
	}
	if err := json.Unmarshal([]byte(vals["OPENCODE_CONFIG_CONTENT"]), &cfg); err != nil || len(cfg.Plugins) != 1 || cfg.Plugins[0]["package"] != "/ext/opencode" {
		t.Fatalf("config: %s", vals["OPENCODE_CONFIG_CONTENT"])
	}
	// A configuration the person already passes is kept, with the plugin added.
	env = a.Env(ArgvReq{Extension: "/ext/opencode", BaseEnv: []string{`OPENCODE_CONFIG_CONTENT={"model":"a/b","plugins":[{"package":"./mine"}]}`}})
	var merged struct {
		Model   string              `json:"model"`
		Plugins []map[string]string `json:"plugins"`
	}
	_ = json.Unmarshal([]byte(strings.TrimPrefix(env[0], "OPENCODE_CONFIG_CONTENT=")), &merged)
	if merged.Model != "a/b" || len(merged.Plugins) != 2 || merged.Plugins[1]["package"] != "/ext/opencode" {
		t.Fatalf("merged: %s", env[0])
	}
	if a.RelocationNote(Relocation{Cwd: "/new", Prev: Prev{Dir: "/old", ConversationID: "ses_1"}}) != "" {
		t.Fatal("OpenCode moves the session: no note")
	}
}

func TestOpenCodeSessionIDs(t *testing.T) {
	now := time.Date(2026, 11, 14, 1, 0, 0, 0, time.UTC)
	a, b := NewOpenCodeSessionID(now), NewOpenCodeSessionID(now.Add(time.Second))
	if !ValidOpenCodeSessionID(a) || !ValidOpenCodeSessionID(b) {
		t.Fatalf("ids: %s %s", a, b)
	}
	if !(b < a) {
		t.Fatalf("newer ids sort first, like OpenCode's: %s %s", a, b)
	}
	if id := Must(OpenCode).NewConversationID(); !ValidOpenCodeSessionID(id) {
		t.Fatalf("NewConversationID = %s", id)
	}
	for _, bad := range []string{"", "ses_", "ses_abc", "abc-def", "ses_0123456789abcdefghijABCDE/", "ses_0123456789abcdefghijABCDEFG"} {
		if ValidOpenCodeSessionID(bad) {
			t.Fatalf("valid: %q", bad)
		}
	}
	if Must(Claude).NewConversationID() == "" || len(Must(Pi).NewConversationID()) != 36 {
		t.Fatal("uuid ids")
	}
}

func TestOpenCodeHeadless(t *testing.T) {
	h := Must(OpenCode).Headless(HeadlessSpec{Command: []string{"/bin/opencode", "--ignored"}, Model: "mock/m", System: "SYS", Schema: `{"type":"object"}`})
	want := []string{"/bin/opencode", "--ignored", "run", "--standalone", "--format", "json", "--agent", "minbox-helper", "--title", "minbox helper", "--model", "mock/m"}
	if !reflect.DeepEqual(h.Argv, want) {
		t.Fatalf("argv: %q", h.Argv)
	}
	if len(h.Env) != 1 || !strings.HasPrefix(h.Env[0], "OPENCODE_CONFIG_CONTENT=") {
		t.Fatalf("env: %q", h.Env)
	}
	var cfg struct {
		Agents map[string]struct {
			Mode        string              `json:"mode"`
			Hidden      bool                `json:"hidden"`
			System      string              `json:"system"`
			Permissions []map[string]string `json:"permissions"`
		} `json:"agents"`
	}
	if err := json.Unmarshal([]byte(strings.TrimPrefix(h.Env[0], "OPENCODE_CONFIG_CONTENT=")), &cfg); err != nil {
		t.Fatal(err)
	}
	ag := cfg.Agents["minbox-helper"]
	if ag.Mode != "primary" || !ag.Hidden || !strings.HasPrefix(ag.System, "SYS") || !strings.Contains(ag.System, `{"type":"object"}`) {
		t.Fatalf("agent: %+v", ag)
	}
	if len(ag.Permissions) != 1 || ag.Permissions[0]["effect"] != "deny" || ag.Permissions[0]["action"] != "*" {
		t.Fatalf("permissions: %+v", ag.Permissions)
	}

	// The JSON lines of a real `run --format json` (OpenCode 2.1.4 against a mock model).
	out := []byte(`{"type":"step_start","timestamp":1,"sessionID":"ses_e285a65dfffeYCrRv3lSUZCvnI","part":{"type":"step-start"}}
{"type":"text","timestamp":2,"sessionID":"ses_e285a65dfffeYCrRv3lSUZCvnI","part":{"type":"text","text":"Here: {\"suggestions\":[\"a\",\"b\"]}"}}
`)
	norm, err := h.Normalize(out)
	if err != nil || string(norm) != `{"structured_output":{"suggestions":["a","b"]}}` {
		t.Fatalf("normalize: %s %v", norm, err)
	}
	if got := h.Cleanup(out); !reflect.DeepEqual(got, []string{"/bin/opencode", "--ignored", "session", "delete", "--standalone", "ses_e285a65dfffeYCrRv3lSUZCvnI"}) {
		t.Fatalf("cleanup: %q", got)
	}
	if _, err := h.Normalize([]byte(`{"type":"text","sessionID":"ses_x","part":{"text":"no json here"}}`)); err == nil {
		t.Fatal("no JSON: want an error")
	}
	if _, err := h.Normalize([]byte(`{"type":"error","sessionID":"ses_x","error":{"name":"ProviderAuthError"}}`)); err == nil || !strings.Contains(err.Error(), "ProviderAuthError") {
		t.Fatalf("error line: %v", err)
	}
	if h.Cleanup([]byte("garbage")) != nil {
		t.Fatal("no session id: no cleanup")
	}
}

func TestOpenCodeVersionSupport(t *testing.T) {
	for out, want := range map[string]bool{"opencode v2.1.4": true, "2.0.0": true, "v3.0.1": true, "1.0.150": false, "opencode 0.15.0": false, "garbage": false} {
		v, ok, reason := judgeOpenCodeVersion(out)
		if ok != want || (!ok && reason == "") {
			t.Fatalf("%q: %q %v %q", out, v, ok, reason)
		}
	}
	_, _, reason := judgeOpenCodeVersion("1.2.3")
	if !strings.Contains(reason, "OpenCode 2") || !strings.Contains(reason, "v2/install") {
		t.Fatalf("V1 reason: %q", reason)
	}

	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "opencode"), []byte("#!/bin/sh\necho 'opencode v1.0.3'\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", dir)
	ResetOpenCodeVersionCache()
	t.Cleanup(ResetOpenCodeVersionCache)
	c := Commands{Claude: {"claude"}, OpenCode: {"opencode"}}
	if !c.Installed(OpenCode) || c.Usable(OpenCode) {
		t.Fatal("V1 is installed but not usable")
	}
	if got := c.Choose(OpenCode); got != OpenCode {
		t.Fatalf("an explicit preference is kept (the start names the problem): %q", got)
	}
	if err := c.NotInstalledError(OpenCode); err == nil || !strings.Contains(err.Error(), "cannot be used") {
		t.Fatalf("error: %v", err)
	}
	var info Info
	for _, i := range c.Infos() {
		if i.Kind == OpenCode {
			info = i
		}
	}
	if !info.Installed || info.Supported || info.Version != "1.0.3" || info.Reason == "" {
		t.Fatalf("info: %+v", info)
	}
	// An upgrade (a different executable) is noticed.
	time.Sleep(10 * time.Millisecond)
	if err := os.WriteFile(filepath.Join(dir, "opencode"), []byte("#!/bin/sh\necho 'opencode v2.1.4' # newer\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	if !c.Usable(OpenCode) || c.Choose("") != OpenCode {
		t.Fatal("V2 is usable (and the only installed agent)")
	}
}

// fakeRunner answers `opencode api --standalone ...` calls from a map of sessions.
type fakeRunner struct {
	sessions map[string]string // id -> dir
	calls    [][]string
}

func (f *fakeRunner) run(_ context.Context, argv []string, dir string, env []string, stdin string) ([]byte, error) {
	f.calls = append(f.calls, argv)
	if len(argv) < 4 || argv[1] != "api" || argv[2] != "--standalone" {
		return nil, errors.New("unexpected")
	}
	switch argv[3] {
	case "session.get":
		id := strings.TrimPrefix(argv[5], "sessionID=")
		d, ok := f.sessions[id]
		if !ok {
			body := []byte(`{"_tag":"SessionNotFoundError","sessionID":"` + id + `"}`)
			return body, &ExitError{Code: 1, Stdout: body, Stderr: "HTTP 404 Not Found"}
		}
		b, _ := json.Marshal(map[string]any{"data": map[string]any{"id": id, "location": map[string]string{"directory": d}}})
		return b, nil
	case "session.create":
		var req struct {
			ID       string `json:"id"`
			Location struct {
				Directory string `json:"directory"`
			} `json:"location"`
		}
		_ = json.Unmarshal([]byte(argv[5]), &req)
		f.sessions[req.ID] = req.Location.Directory
		return []byte(`{"data":{}}`), nil
	}
	return nil, errors.New("unknown op")
}

func TestOpenCodeEnsureSession(t *testing.T) {
	f := &fakeRunner{sessions: map[string]string{}}
	ctx := context.Background()
	id := NewOpenCodeSessionID(time.Now())
	created, _, err := OpenCodeEnsureSession(ctx, f.run, []string{"opencode", "--x"}, "/work/a", id)
	if err != nil || !created || f.sessions[id] != "/work/a" {
		t.Fatalf("create: %v %v %v", created, err, f.sessions)
	}
	if f.calls[0][0] != "opencode" || hasArg(f.calls[0], "--x") {
		t.Fatalf("only the executable of the person's command: %q", f.calls[0])
	}
	created, at, err := OpenCodeEnsureSession(ctx, f.run, []string{"opencode"}, "/work/b", id)
	if err != nil || created || at != "/work/a" {
		t.Fatalf("exists: %v %q %v", created, at, err)
	}
	exists, _, err := OpenCodeSessionDir(ctx, f.run, nil, "/", "ses_missing0000000000000000000")
	if err != nil || exists {
		t.Fatalf("missing: %v %v", exists, err)
	}
	if _, _, err := OpenCodeEnsureSession(ctx, f.run, nil, "/", "ses; rm -rf"); err == nil {
		t.Fatal("a bad id is refused")
	}
	if got := OpenCodeBase([]string{"npx", "opencode", "--model", "a/b"}); !reflect.DeepEqual(got, []string{"npx", "opencode"}) {
		t.Fatalf("base: %q", got)
	}
	if got := OpenCodeBase(nil); !reflect.DeepEqual(got, []string{"opencode"}) {
		t.Fatalf("base of nothing: %q", got)
	}
	broken := func(context.Context, []string, string, []string, string) ([]byte, error) {
		return nil, &ExitError{Code: 2, Stderr: "boom"}
	}
	if _, _, err := OpenCodeSessionDir(ctx, broken, nil, "/", id); err == nil {
		t.Fatal("a failing CLI is an error, not a missing session")
	}
}
