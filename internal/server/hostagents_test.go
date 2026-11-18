package server

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/ryotarai/minbox/internal/agent"
	"github.com/ryotarai/minbox/internal/termhost"
)

// terminalSays reads a session's terminal (through the server) until it printed want.
func (e *env) terminalSays(sessID, want string) string {
	e.t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	ws, _, err := websocket.Dial(ctx, strings.Replace(e.ts.URL, "http", "ws", 1)+"/api/sessions/"+sessID+"/terminal", &websocket.DialOptions{HTTPHeader: e.authHeader()})
	if err != nil {
		e.t.Fatal(err)
	}
	defer ws.CloseNow()
	var out strings.Builder
	for !strings.Contains(out.String(), want) {
		typ, data, err := ws.Read(ctx)
		if err != nil {
			e.t.Fatalf("terminal: %v (got %q)", err, out.String())
		}
		if typ == websocket.MessageBinary {
			out.Write(data)
		}
	}
	return out.String()
}

// agentInfo finds one agent in a GET /api/agents answer.
func agentInfo(t *testing.T, list map[string]any, kind string) map[string]any {
	t.Helper()
	for _, a := range list["agents"].([]any) {
		if m := a.(map[string]any); m["kind"] == kind {
			return m
		}
	}
	t.Fatalf("no %s in %v", kind, list)
	return nil
}

// Pi and OpenCode sessions on a remote host (here: `minbox host --listen` in process): what is
// installed there is found by the host, the host fills in its own extension/plugin, the opencode CLI
// calls run there, Pi's session files are looked up there, and a clear refusal when it cannot run.
func TestRemoteHostPiAndOpenCode(t *testing.T) {
	// "That machine's" PATH: a node, a pi and an opencode (the host runs in this process).
	bin := t.TempDir()
	write := func(name, script string) {
		if err := os.WriteFile(filepath.Join(bin, name), []byte("#!/bin/sh\n"+script+"\n"), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	nodeVersion := filepath.Join(t.TempDir(), "node-version")
	os.WriteFile(nodeVersion, []byte("v22.19.0"), 0o644)
	write("node", `/bin/cat `+nodeVersion)
	write("remote-pi", `echo "pi ext=$2 sub=$4 id=$6 file=$MINBOX_SERVER_FILE tok=${MINBOX_TOKEN:+set}"; exec /bin/sleep 30`)
	ocState := t.TempDir()
	write("remote-opencode", `if [ "$1" = --standalone ]; then echo "oc cfg=$OPENCODE_CONFIG_CONTENT ses=$MINBOX_OPENCODE_SESSION dir=$MINBOX_OPENCODE_DIR file=$MINBOX_SERVER_FILE"; exec /bin/sleep 30; fi
`+fakeOpenCodeScript(ocState, "opencode v2.1.4"))
	t.Setenv("PATH", bin+":"+os.Getenv("PATH"))
	// The host's own OpenCode configuration: minbox's plugin entry is merged into it there.
	t.Setenv("OPENCODE_CONFIG_CONTENT", `{"model":"mock/m"}`)
	piSessions := t.TempDir()
	t.Setenv("PI_CODING_AGENT_SESSION_DIR", piSessions)

	e := newEnv(t)
	e.srv.pairPoll = 50 * time.Millisecond
	for _, c := range []*Config{&e.srv.cfg, &e.srv.sessions.cfg} {
		c.PiCommand = []string{"remote-pi"}
		c.PiExtension, c.PiSubagentExtension = "/server/pi/minbox.ts", "/server/pi/subagent.ts"
		c.OpenCodeCommand = []string{"remote-opencode"}
		c.OpenCodePlugin = "/server/opencode"
		// The opencode CLI of a remote session must not run on the server's machine.
		c.OpenCodeRunner = func(ctx context.Context, argv []string, dir string, env []string, stdin string) ([]byte, error) {
			t.Errorf("opencode ran on the server's machine: %q", argv)
			return nil, context.Canceled
		}
	}
	hostURL, hostDir, _ := remoteHost(t, "", "")
	hostID := pairHost(t, e, hostURL, hostDir)
	work := t.TempDir()

	// What that machine has.
	_, list, _ := e.do("GET", "/api/agents?host_id="+hostID+"&fresh=1", nil, nil)
	if pi := agentInfo(t, list, "pi"); pi["installed"] != true || pi["supported"] != true || pi["path"] != filepath.Join(bin, "remote-pi") || pi["version"] != "node 22.19.0" {
		t.Fatalf("pi on the host = %v", pi)
	}
	if oc := agentInfo(t, list, "opencode"); oc["installed"] != true || oc["supported"] != true || oc["version"] != "2.1.4" || oc["caps"].(map[string]any)["remote_hosts"] != true {
		t.Fatalf("opencode on the host = %v", oc)
	}
	if list["host_id"] != hostID {
		t.Fatalf("list = %v", list)
	}
	waitFor(t, "the host's agents in the host list", func() bool {
		ags, _ := e.hostStatus(hostID)["agents"].([]any)
		return len(ags) == 3
	})

	// A Pi session there: the host's extension files and relay, the session id.
	code, obj, _ := e.do("POST", "/api/sessions", map[string]string{"cwd": work, "name": "pi", "host_id": hostID, "agent": "pi"}, nil)
	if code != 201 || obj["agent"] != "pi" {
		t.Fatalf("pi session: %d %v", code, obj)
	}
	piSess, _ := e.st.GetSession(context.Background(), obj["id"].(string))
	out := e.terminalSays(piSess.ID, "tok=set")
	if !strings.Contains(out, "ext=/pi-remote/pi/minbox.ts sub=/pi-remote/pi/subagent.ts id="+piSess.ClaudeSessionID) || !strings.Contains(out, filepath.Join(hostDir, "host-server.json")) {
		t.Fatalf("pi terminal = %q", out)
	}
	// Its session file is looked up on that machine.
	f, err := e.srv.sessions.fsOf(hostID)
	if err != nil {
		t.Fatal(err)
	}
	if e.srv.sessions.conversationExists(context.Background(), f, piSess, piSess.ClaudeSessionID) {
		t.Fatal("a Pi conversation before Pi wrote its file")
	}
	dir := filepath.Join(piSessions, agent.PiDirName(work))
	os.MkdirAll(dir, 0o755)
	os.WriteFile(filepath.Join(dir, "2026-01-01T00-00-00_"+piSess.ClaudeSessionID+".jsonl"), []byte("{}\n"), 0o644)
	if !e.srv.sessions.conversationExists(context.Background(), f, piSess, piSess.ClaudeSessionID) || !e.srv.sessions.piConversationExists(context.Background(), piSess) {
		t.Fatal("the Pi session file on the host was not found")
	}

	// An OpenCode session there: created on that machine before the start, the host's plugin merged
	// into its own OPENCODE_CONFIG_CONTENT.
	code, obj, _ = e.do("POST", "/api/sessions", map[string]string{"cwd": work, "name": "oc", "host_id": hostID, "agent": "opencode"}, nil)
	if code != 201 || obj["agent"] != "opencode" {
		t.Fatalf("opencode session: %d %v", code, obj)
	}
	ocSess, _ := e.st.GetSession(context.Background(), obj["id"].(string))
	out = e.terminalSays(ocSess.ID, "host-server.json")
	if !strings.Contains(out, `cfg={"model":"mock/m","plugins":[{"package":"/oc-remote/opencode"}]}`) || !strings.Contains(out, "ses="+ocSess.ClaudeSessionID) || !strings.Contains(out, "dir="+work) {
		t.Fatalf("opencode terminal = %q", out)
	}
	if b, _ := os.ReadFile(filepath.Join(ocState, ocSess.ClaudeSessionID)); string(b) != work {
		t.Fatalf("the OpenCode session was not created on the host: %q", b)
	}
	if !e.srv.sessions.conversationExists(context.Background(), f, ocSess, ocSess.ClaudeSessionID) {
		t.Fatal("conversationExists did not ask the host's opencode")
	}

	// The default agent on that host follows the setting when the host can run it.
	if code, _, _ := e.do("PUT", "/api/settings", map[string]any{"default_agent": "opencode"}, nil); code != 200 {
		t.Fatalf("settings: %d", code)
	}
	if k := e.srv.sessions.hostDefaultAgent(context.Background(), hostID); k != agent.OpenCode {
		t.Fatalf("default on the host = %s", k)
	}

	// Refusals name the host and the reason.
	os.WriteFile(nodeVersion, []byte("v20.11.1"), 0o644)
	if _, err := e.srv.sessions.hostAgents(context.Background(), hostID, true); err != nil {
		t.Fatal(err)
	}
	if code, obj, _ := e.do("POST", "/api/sessions", map[string]string{"cwd": work, "host_id": hostID, "agent": "pi"}, nil); code != 400 || !strings.Contains(obj["error"].(string), "Pi cannot be used on host devbox: Node.js 20.11.1 is too old") {
		t.Fatalf("old node: %d %v", code, obj)
	}
	for _, c := range []*Config{&e.srv.cfg, &e.srv.sessions.cfg} {
		c.PiCommand = []string{"no-such-pi"}
	}
	if code, obj, _ := e.do("POST", "/api/sessions", map[string]string{"cwd": work, "host_id": hostID, "agent": "pi"}, nil); code != 400 || !strings.Contains(obj["error"].(string), `Pi is not installed on host devbox (looked for "no-such-pi" on its PATH)`) {
		t.Fatalf("no pi: %d %v", code, obj)
	}
	write("remote-opencode", `echo "opencode 1.0.150"`)
	e.srv.sessions.hostAgents(context.Background(), hostID, true) // (a minute later, or Settings asks again)
	if code, obj, _ := e.do("POST", "/api/sessions", map[string]string{"cwd": work, "host_id": hostID, "agent": "opencode"}, nil); code != 400 || !strings.Contains(obj["error"].(string), "OpenCode cannot be used on host devbox") || !strings.Contains(obj["error"].(string), "OpenCode 2") {
		t.Fatalf("opencode v1: %d %v", code, obj)
	}

	// A host whose minbox predates Pi/OpenCode support: refused with "update minbox there", and a
	// restart of such a session does not start it without minbox's part.
	c := e.srv.sessions.hosts.get(hostID)
	c.mu.Lock()
	c.protocol, c.agents = termhost.AgentsProtocol-1, nil
	c.mu.Unlock()
	if _, err := e.srv.sessions.resolveAgent(context.Background(), "opencode", hostID); err == nil || !strings.Contains(err.Error(), "too old to run OpenCode") {
		t.Fatalf("old host: %v", err)
	}
	if err := e.srv.sessions.spawn(context.Background(), piSess, true); err == nil || !strings.Contains(err.Error(), "update minbox on that machine") {
		t.Fatalf("spawn on an old host: %v", err)
	}
	if _, err := e.srv.sessions.resolveAgent(context.Background(), "claude", hostID); err != nil {
		t.Fatalf("claude on an old host: %v", err)
	}
}
