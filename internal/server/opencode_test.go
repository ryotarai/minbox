package server

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/ryotarai/minbox/internal/agent"
)

// fakeOpenCodeScript is a stand-in for the opencode CLI: --version, `api --standalone session.get /
// session.create` (sessions are files in state, holding their folder), `run` (prints the JSON lines of
// a real run and keeps its stdin and configuration) and `session delete` (logged). It never runs a
// real OpenCode. Absolute paths: some tests empty PATH.
func fakeOpenCodeScript(state, version string) string {
	return `S=` + state + `
echo "$@" >> $S/calls
case "$1" in
--version) echo "` + version + `"; exit 0;;
api)
  if [ "$3" = session.get ]; then
    id=${5#sessionID=}
    if [ -f "$S/$id" ]; then printf '{"data":{"id":"%s","location":{"directory":"%s"}}}\n' "$id" "$(/bin/cat $S/$id)"; exit 0; fi
    printf '{"_tag":"SessionNotFoundError","sessionID":"%s"}\n' "$id"; echo "HTTP 404 Not Found" >&2; exit 1
  fi
  if [ "$3" = session.create ]; then
    id=$(printf '%s' "$5" | /usr/bin/sed 's/.*"id":"\([^"]*\)".*/\1/')
    dir=$(printf '%s' "$5" | /usr/bin/sed 's/.*"directory":"\([^"]*\)".*/\1/')
    printf '%s' "$dir" > $S/$id
    echo '{"data":{}}'; exit 0
  fi;;
run)
  /bin/cat > $S/stdin
  printf '%s' "$OPENCODE_CONFIG_CONTENT" > $S/helper-config
  echo '{"type":"step_start","sessionID":"ses_e285a65dfffeYCrRv3lSUZCvnI","part":{"type":"step-start"}}'
  echo '{"type":"text","sessionID":"ses_e285a65dfffeYCrRv3lSUZCvnI","part":{"type":"text","text":"{\"suggestions\":[\"Ship it\"]}"}}'
  exit 0;;
session) echo "$@" >> $S/deleted; exit 0;;
esac
exit 0`
}

// withOpenCode gives the env a fake OpenCode (version as given) with a plugin folder; it returns the
// executable and the fake's state folder.
func withOpenCode(e *env, version string) (string, string) {
	state := e.t.TempDir()
	bin := fakeAgentBin(e.t, "opencode", fakeOpenCodeScript(state, version))
	for _, c := range []*Config{&e.srv.cfg, &e.srv.sessions.cfg} {
		c.OpenCodeCommand = []string{bin}
		c.OpenCodePlugin = "/ext/opencode"
	}
	return bin, state
}

func envOf(env []string) map[string]string {
	m := map[string]string{}
	for _, kv := range env {
		k, v, _ := strings.Cut(kv, "=")
		m[k] = v
	}
	return m
}

func TestOpenCodeSessionStartsTheTUIWithThePlugin(t *testing.T) {
	e := newEnv(t)
	bin, state := withOpenCode(e, "opencode v2.1.4")
	sess, code, obj := e.createAgentSession("opencode")
	if sess == nil {
		t.Fatalf("create: %d %v", code, obj)
	}
	if sess.Agent != agent.OpenCode || !agent.ValidOpenCodeSessionID(sess.ClaudeSessionID) {
		t.Fatalf("session = %+v", sess)
	}
	req := e.host.spawned[0]
	if want := []string{bin, "--standalone", "--auto", "--session", sess.ClaudeSessionID}; strings.Join(req.Argv, "\x00") != strings.Join(want, "\x00") {
		t.Fatalf("argv = %q", req.Argv)
	}
	env := envOf(req.Env)
	if env["MINBOX_OPENCODE_SESSION"] != sess.ClaudeSessionID || env["MINBOX_OPENCODE_DIR"] != e.dir || env["MINBOX_TOKEN"] != sess.Token {
		t.Fatalf("env = %v", req.Env)
	}
	if !strings.Contains(env["OPENCODE_CONFIG_CONTENT"], `"package":"/ext/opencode"`) {
		t.Fatalf("plugin config = %q", env["OPENCODE_CONFIG_CONTENT"])
	}
	// The session was created (in the session's folder) before the TUI started.
	if dir, err := os.ReadFile(filepath.Join(state, sess.ClaudeSessionID)); err != nil || string(dir) != e.dir {
		t.Fatalf("created: %q %v", dir, err)
	}
	// A restart opens the same session and creates nothing.
	ctx := context.Background()
	_ = e.st.SetSessionEnded(ctx, sess.ID, 0)
	if err := e.srv.sessions.Restart(ctx, sess.ID); err != nil {
		t.Fatal(err)
	}
	last := e.host.spawned[len(e.host.spawned)-1]
	if !strings.Contains(strings.Join(last.Argv, " "), "--session "+sess.ClaudeSessionID) {
		t.Fatalf("restart argv %q", last.Argv)
	}
	calls, _ := os.ReadFile(filepath.Join(state, "calls"))
	if n := strings.Count(string(calls), "session.create"); n != 1 {
		t.Fatalf("session.create %d times:\n%s", n, calls)
	}

	// The hello answers with the instructions the plugin puts in the system prompt: OpenCode's tool
	// names, the orchestration (OpenCode has subagents) and the OpenCode subagent section.
	codeH, hello, _ := e.do("POST", "/api/agent/hello", map[string]any{"agent": "opencode", "agent_session_id": sess.ClaudeSessionID, "ext_version": "0.1.0"}, bearer(sess))
	ins, _ := hello["instructions"].(string)
	if codeH != 200 || hello["agent"] != "opencode" || hello["orchestrator"] != OrchestratorPrompt {
		t.Fatalf("hello = %v", hello)
	}
	for _, want := range []string{"minbox_send_message", "# minbox: orchestration", "# minbox: subagents in OpenCode", "background: true"} {
		if !strings.Contains(ins, want) {
			t.Fatalf("instructions lack %q", want)
		}
	}
	if strings.Contains(ins, "mcp__minbox__") || strings.Contains(ins, "minbox_subagent") {
		t.Fatalf("instructions of another agent: %s", ins)
	}
	if ins != buildInstructionsFor(agent.Must(agent.OpenCode), true, "") {
		t.Fatal("hello instructions differ from buildInstructionsFor")
	}

	// /api/agents reports the version.
	_, list, _ := e.do("GET", "/api/agents", nil, nil)
	found := false
	for _, a := range list["agents"].([]any) {
		m := a.(map[string]any)
		if m["kind"] == "opencode" {
			found = m["installed"] == true && m["supported"] == true && m["version"] == "2.1.4"
		}
	}
	if !found {
		t.Fatalf("agents = %v", list)
	}
}

// OpenCode 1.x shares the command but not the plugin API: it is listed as unsupported and refused.
func TestOpenCodeV1IsRefused(t *testing.T) {
	e := newEnv(t)
	withOpenCode(e, "1.0.150")
	if _, code, obj := e.createAgentSession("opencode"); code != 400 || !strings.Contains(obj["error"].(string), "OpenCode 2") {
		t.Fatalf("v1: %d %v", code, obj)
	}
	_, list, _ := e.do("GET", "/api/agents", nil, nil)
	for _, a := range list["agents"].([]any) {
		m := a.(map[string]any)
		if m["kind"] == "opencode" && (m["installed"] != true || m["supported"] != false || !strings.Contains(m["reason"].(string), "1.0.150")) {
			t.Fatalf("v1 info: %v", m)
		}
	}
	// It is never the default either.
	_ = e.st.PutSettings(context.Background(), map[string]json.RawMessage{"default_agent": json.RawMessage(`"opencode"`)})
	if s := e.createSession(); s.Agent == agent.OpenCode {
		t.Fatal("an unsupported OpenCode became the default")
	}
	// Not on another machine either.
	if _, err := e.srv.sessions.resolveAgent(context.Background(), "opencode", "host_other"); err == nil || !strings.Contains(err.Error(), "own machine") {
		t.Fatalf("remote: %v", err)
	}
}

// A folder change moves the OpenCode session with the project: same conversation, no "moved" note;
// the plugin is told the new folder.
func TestOpenCodeRelocationKeepsTheConversation(t *testing.T) {
	e := newEnv(t)
	withOpenCode(e, "opencode v2.1.4")
	sess, _, _ := e.createAgentSession("opencode")
	ctx := context.Background()
	other := e.mkdir("oc-moved")
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
	if last.Cwd != other || got.Cwd != other || got.ClaudeSessionID != sess.ClaudeSessionID || got.PrevClaudeSessionID != "" {
		t.Fatalf("after the move: cwd %q %+v", last.Cwd, got)
	}
	if envOf(last.Env)["MINBOX_OPENCODE_DIR"] != other {
		t.Fatalf("env %v", last.Env)
	}
	if strings.Contains(e.srv.sessions.instructions(ctx, got), "moved to a new folder") {
		t.Fatal("a relocation note for OpenCode")
	}
}

// With only OpenCode installed the helpers run `opencode run` with a tool-less agent and delete the
// session the run leaves; with Claude Code or Pi installed, OpenCode is not used for helpers even
// when it is the default agent.
func TestHelpersRunOpenCodeOnlyAsTheLastResort(t *testing.T) {
	claudeAbsent(t)
	e := newEnv(t)
	_, state := withOpenCode(e, "opencode v2.1.4")
	got, err := e.srv.runSuggest(context.Background(), "the conversation")
	if err != nil || len(got) != 1 || got[0] != "Ship it" {
		t.Fatalf("suggestions %v %v", got, err)
	}
	if in, _ := os.ReadFile(filepath.Join(state, "stdin")); string(in) != "the conversation" {
		t.Fatalf("stdin = %q", in)
	}
	calls, _ := os.ReadFile(filepath.Join(state, "calls"))
	if !strings.Contains(string(calls), "run --standalone --format json --agent minbox-helper --title minbox helper") {
		t.Fatalf("calls:\n%s", calls)
	}
	cfg, _ := os.ReadFile(filepath.Join(state, "helper-config"))
	if !strings.Contains(string(cfg), `"effect":"deny"`) || !strings.Contains(string(cfg), "JSON Schema") {
		t.Fatalf("helper config: %s", cfg)
	}
	deadline := time.Now().Add(5 * time.Second)
	for {
		d, _ := os.ReadFile(filepath.Join(state, "deleted"))
		if strings.Contains(string(d), "session delete --standalone ses_e285a65dfffeYCrRv3lSUZCvnI") {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("the helper session was not deleted: %q", d)
		}
		time.Sleep(20 * time.Millisecond)
	}

	// Pi installed too, OpenCode the default: Pi runs the helper.
	withPi(e, `/bin/cat >/dev/null; echo '{"suggestions":["from pi"]}'`)
	_ = e.st.PutSettings(context.Background(), map[string]json.RawMessage{"default_agent": json.RawMessage(`"opencode"`)})
	if got, err := e.srv.runSuggest(context.Background(), "p"); err != nil || got[0] != "from pi" {
		t.Fatalf("with pi: %v %v", got, err)
	}
	if s := e.createSession(); s.Agent != agent.OpenCode {
		t.Fatalf("sessions still follow the default: %q", s.Agent)
	}
}
