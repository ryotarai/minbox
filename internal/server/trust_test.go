package server

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// TestMain points HOME and CLAUDE_CONFIG_DIR at temporary folders for every test of the package:
// sessions started here run claudetrust against the environment, and the person's own
// ~/.claude.json must never be touched by a test.
func TestMain(m *testing.M) {
	tmp, err := os.MkdirTemp("", "minbox-server-test-home-")
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	os.Setenv("HOME", tmp)
	os.Setenv("CLAUDE_CONFIG_DIR", filepath.Join(tmp, ".claude"))
	code := m.Run()
	os.RemoveAll(tmp)
	os.Exit(code)
}

func claudeTrusted(t *testing.T, cfg, dir string) bool {
	t.Helper()
	b, err := os.ReadFile(cfg)
	if err != nil {
		t.Fatal(err)
	}
	var c struct {
		Projects map[string]map[string]any `json:"projects"`
	}
	if err := json.Unmarshal(b, &c); err != nil {
		t.Fatalf("%s: %v", b, err)
	}
	return c.Projects[dir]["hasTrustDialogAccepted"] == true
}

// claudeConfig gives the test its own Claude Code config folder with a .claude.json in it.
func claudeConfig(t *testing.T) string {
	t.Helper()
	cfgDir := t.TempDir()
	t.Setenv("CLAUDE_CONFIG_DIR", cfgDir)
	cfg := filepath.Join(cfgDir, ".claude.json")
	if err := os.WriteFile(cfg, []byte(`{"numStartups": 3, "projects": {}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	return cfg
}

// A Claude Code session on this machine: its folder is marked trusted (in the config of the
// environment the session gets) before the spawn, unless the setting is off.
func TestClaudeSessionFolderIsTrusted(t *testing.T) {
	cfg := claudeConfig(t)
	e := newEnv(t)
	sess := e.createSession()
	if !claudeTrusted(t, cfg, sess.Cwd) {
		b, _ := os.ReadFile(cfg)
		t.Fatalf("%s not trusted: %s", sess.Cwd, b)
	}
	if real, _ := filepath.EvalSymlinks(sess.Cwd); !claudeTrusted(t, cfg, real) {
		t.Fatalf("realpath %s not trusted", real)
	}
	if b, _ := os.ReadFile(cfg); !strings.Contains(string(b), `"numStartups": 3`) {
		t.Fatalf("other content lost: %s", b)
	}
	if e.host.spawned[0].TrustClaudeFolder {
		t.Fatal("a local spawn asked the host to trust the folder (the server does it)")
	}

	// Setting off: left alone.
	_ = e.st.PutSettings(context.Background(), map[string]json.RawMessage{"claude_trust_folders": json.RawMessage("false")})
	other := e.mkdir("other")
	if code, obj, _ := e.do("POST", "/api/sessions", map[string]string{"cwd": other, "name": "o"}, nil); code != 201 {
		t.Fatalf("create: %d %v", code, obj)
	}
	if claudeTrusted(t, cfg, other) {
		t.Fatal("trusted with the setting off")
	}
	// The default is on and the setting is listed.
	_, st, _ := e.do("GET", "/api/settings", nil, nil)
	if st["claude_trust_folders"] != false {
		t.Fatalf("settings = %v", st["claude_trust_folders"])
	}
}

func TestTrustOnlyForClaudeSessions(t *testing.T) {
	e := newEnv(t)
	m := e.srv.sessions
	sess := e.createSession()
	if !m.trustClaudeFolder(context.Background(), sess) {
		t.Fatal("claude session not trusted")
	}
	for _, agentKind := range []string{"pi", "opencode"} {
		s := *sess
		s.Agent = agentKind
		if m.trustClaudeFolder(context.Background(), &s) {
			t.Errorf("%s session trusted", agentKind)
		}
	}
	s := *sess
	s.Kind = "shell"
	if m.trustClaudeFolder(context.Background(), &s) {
		t.Error("shell trusted")
	}
}

// A Claude Code session on a remote host: the host marks the folder trusted on its machine (here
// the host runs in this process, so "its machine" is the test's CLAUDE_CONFIG_DIR).
func TestRemoteClaudeSessionFolderIsTrusted(t *testing.T) {
	cfg := claudeConfig(t)
	bin := t.TempDir()
	if err := os.WriteFile(filepath.Join(bin, "remote-claude"), []byte("#!/bin/sh\necho remote-claude-started\nexec /bin/sleep 30\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", bin+":"+os.Getenv("PATH"))
	e := newEnv(t)
	e.srv.pairPoll = 50 * time.Millisecond
	for _, c := range []*Config{&e.srv.cfg, &e.srv.sessions.cfg} {
		c.ClaudeCommand = []string{"remote-claude"}
	}
	hostURL, hostDir, _ := remoteHost(t, "", "")
	hostID := pairHost(t, e, hostURL, hostDir)
	work := t.TempDir()
	code, obj, _ := e.do("POST", "/api/sessions", map[string]string{"cwd": work, "name": "rc", "host_id": hostID}, nil)
	if code != 201 {
		t.Fatalf("create: %d %v", code, obj)
	}
	e.terminalSays(obj["id"].(string), "remote-claude-started")
	if !claudeTrusted(t, cfg, work) {
		b, _ := os.ReadFile(cfg)
		t.Fatalf("%s not trusted on the host: %s", work, b)
	}
}
