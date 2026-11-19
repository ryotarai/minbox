package server

import (
	"context"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/ryotarai/minbox/internal/store"
)

// Commands an agent asks the person to run (runcommands.go).

// sendCommands sends an agent message with commands and answers its id and the commands' ids.
func sendCommands(t *testing.T, e *env, sess *store.Session, cmds ...map[string]any) (string, []string) {
	t.Helper()
	list := make([]any, len(cmds))
	for i, c := range cmds {
		list[i] = c
	}
	code, o, _ := e.do("POST", "/api/agent/messages", map[string]any{"body": "Please allow these.", "commands": list}, bearer(sess))
	if code != 201 {
		t.Fatalf("send: %d %v", code, o)
	}
	var ids []string
	for _, c := range o["commands"].([]any) {
		ids = append(ids, c.(map[string]any)["id"].(string))
	}
	return o["message_id"].(string), ids
}

func runCmds(t *testing.T, e *env, msg string) []store.RunCommand {
	t.Helper()
	cs, err := e.st.RunCommandsOf(context.Background(), msg)
	if err != nil {
		t.Fatal(err)
	}
	return cs
}

// resultOf waits for the message's commands to be reported and answers the result message.
func resultOf(t *testing.T, e *env, msg string) *store.Message {
	t.Helper()
	var id string
	waitFor(t, "the results to be reported", func() bool {
		cs := runCmds(t, e, msg)
		for _, c := range cs {
			if c.State == store.RunPending {
				continue
			}
			if !c.Reported {
				return false
			}
			id = c.ResultMessageID
		}
		return id != ""
	})
	m, err := e.st.GetMessage(context.Background(), id)
	if err != nil {
		t.Fatal(err)
	}
	return m
}

func TestRunCommandsAllowRunsInOrderAndReports(t *testing.T) {
	e := newEnv(t)
	sess := e.createSession()
	sub := filepath.Join(e.dir, "sub")
	os.MkdirAll(sub, 0o755)
	t.Setenv("MINBOX_LEAK", "secret") // minbox's own variables are not passed on
	msg, ids := sendCommands(t, e, sess,
		map[string]any{"command": "echo first > order.txt; echo out; echo err >&2; echo leak=${MINBOX_LEAK:-none}", "description": "write a file"},
		map[string]any{"command": "pwd; exit 3", "cwd": "sub"},
		map[string]any{"command": "echo never > denied.txt"},
		map[string]any{"command": "cat order.txt", "cwd": e.dir},
	)
	if len(ids) != 4 {
		t.Fatalf("ids = %v", ids)
	}
	cs := runCmds(t, e, msg)
	if cs[0].Cwd != e.dir || cs[1].Cwd != sub || cs[0].State != store.RunPending || cs[0].Description != "write a file" {
		t.Fatalf("stored = %+v", cs)
	}
	// The stream shows them, pending: the message waits on the person.
	_, stream, _ := e.do("GET", "/api/v3/sessions/"+sess.ID+"/stream", nil, nil)
	var shown map[string]any
	for _, m := range stream["messages"].([]any) {
		if m.(map[string]any)["id"] == msg {
			shown = m.(map[string]any)
		}
	}
	if rc, _ := shown["run_commands"].([]any); len(rc) != 4 || shown["open"] != float64(4) {
		t.Fatalf("stream message = %v", shown)
	}

	code, o, _ := e.do("POST", "/api/v3/messages/"+msg+"/commands", map[string]any{"allow": []string{ids[0], ids[1], ids[3]}, "deny": []string{ids[2]}}, nil)
	if code != 200 {
		t.Fatalf("decide: %d %v", code, o)
	}
	res := resultOf(t, e, msg)
	cs = runCmds(t, e, msg)
	if cs[0].State != store.RunDone || cs[0].ExitCode != 0 || !strings.Contains(cs[0].Output, "out") || !strings.Contains(cs[0].Output, "err") || !strings.Contains(cs[0].Output, "leak=none") {
		t.Fatalf("first = %+v", cs[0])
	}
	if cs[1].ExitCode != 3 || strings.TrimSpace(strings.Split(cs[1].Output, "\n")[0]) != evalPath(sub) && strings.TrimSpace(strings.Split(cs[1].Output, "\n")[0]) != sub {
		t.Fatalf("second (a failure does not stop the rest) = %+v", cs[1])
	}
	if cs[2].State != store.RunDenied || cs[2].DecidedBy != "Test browser" {
		t.Fatalf("denied = %+v", cs[2])
	}
	if _, err := os.Stat(filepath.Join(e.dir, "denied.txt")); err == nil {
		t.Fatal("a denied command ran")
	}
	if !strings.Contains(cs[3].Output, "first") {
		t.Fatalf("fourth ran before the first: %+v", cs[3])
	}
	// One message of minbox brings the agent the results, delivered like the person's replies.
	if res.Author != store.AuthorUser || res.Kind != store.KindRunResult || res.DeliveredAt != nil {
		t.Fatalf("result message = %+v", res)
	}
	for _, want := range []string{"3 ran, 1 denied", "### Command 1: exit code 0", "### Command 2: exit code 3", "### Command 3: denied by the person, not run", "```sh\necho never > denied.txt\n```", "write a file", "Output:\n```text\nfirst\n"} {
		if !strings.Contains(res.Body, want) {
			t.Errorf("result lacks %q:\n%s", want, res.Body)
		}
	}
	_, pend, _ := e.do("GET", "/api/agent/pending?proto=1", nil, bearer(sess))
	items, _ := pend["items"].([]any)
	if len(items) != 1 || !strings.HasPrefix(items[0].(map[string]any)["text"].(string), "minbox: the person decided on the commands you asked to run") {
		t.Fatalf("pending = %v", pend)
	}
}

func evalPath(p string) string {
	r, err := filepath.EvalSymlinks(p)
	if err != nil {
		return p
	}
	return r
}

// TestRunCommandsOnlyThePerson: the agent's token never reaches the approve endpoint, and the agent
// API has no way to decide or run commands.
func TestRunCommandsOnlyThePerson(t *testing.T) {
	e := newEnv(t)
	sess := e.createSession()
	marker := filepath.Join(e.dir, "ran.txt")
	msg, ids := sendCommands(t, e, sess, map[string]any{"command": "echo x >> " + marker})
	// The agent's bearer token, no browser cookie: refused before the handler.
	for _, hdr := range []map[string]string{
		{"Authorization": "Bearer " + sess.Token, "Cookie": ""},
		{"Authorization": "Bearer " + sess.Token, "Cookie": "minbox_device=" + sess.Token},
	} {
		if code, _, _ := e.do("POST", "/api/v3/messages/"+msg+"/commands", map[string]any{"allow": ids}, hdr); code != 401 {
			t.Fatalf("agent token on the approve endpoint: %d", code)
		}
	}
	// Under the agent API there is no such route.
	for _, p := range []string{"/api/agent/messages/" + msg + "/commands", "/api/agent/commands/" + ids[0] + "/allow"} {
		if code, _, _ := e.do("POST", p, map[string]any{"allow": ids}, map[string]string{"Authorization": "Bearer " + sess.Token, "Cookie": ""}); code != 404 {
			t.Fatalf("%s: %d", p, code)
		}
	}
	// A loopback request without a paired browser is not the person either.
	if code, _, _ := e.do("POST", "/api/v3/messages/"+msg+"/commands", map[string]any{"allow": ids}, map[string]string{"Cookie": ""}); code != 401 {
		t.Fatalf("unpaired: %d", code)
	}
	// The handler itself also requires the device (should the guard ever let a request through).
	rec := httptest.NewRecorder()
	req := httptest.NewRequest("POST", "/api/v3/messages/"+msg+"/commands", strings.NewReader(`{"allow":["`+ids[0]+`"]}`))
	req.SetPathValue("id", msg)
	e.srv.decideRunCommands(rec, req)
	if rec.Code != 403 {
		t.Fatalf("handler without a device: %d", rec.Code)
	}
	// A tool call can only add commands, pending.
	if code, _, _ := e.do("POST", "/api/agent/tool", map[string]any{"tool": "send_message", "args": map[string]any{"body": "x", "commands": []any{map[string]any{"command": "true"}}}}, map[string]string{"Authorization": "Bearer " + sess.Token, "Cookie": ""}); code != 200 {
		t.Fatalf("tool: %d", code)
	}
	time.Sleep(100 * time.Millisecond)
	if cs := runCmds(t, e, msg); cs[0].State != store.RunPending {
		t.Fatalf("decided without the person: %+v", cs[0])
	}
	if _, err := os.Stat(marker); err == nil {
		t.Fatal("ran without the person")
	}
}

// TestRunCommandsRunOnceExactText: a command runs at most once however often it is allowed, ids must
// be the message's, and only the stored text runs.
func TestRunCommandsRunOnceExactText(t *testing.T) {
	e := newEnv(t)
	sess := e.createSession()
	marker := filepath.Join(e.dir, "count.txt")
	msg, ids := sendCommands(t, e, sess, map[string]any{"command": "echo x >> " + marker})
	other, otherIDs := sendCommands(t, e, sess, map[string]any{"command": "echo other"})
	_ = other
	// Another message's command, an unknown id, a command named twice: refused, nothing decided.
	for _, body := range []map[string]any{
		{"allow": otherIDs},
		{"allow": []string{"cmd_nope"}},
		{"allow": ids, "deny": ids},
		{},
	} {
		if code, _, _ := e.do("POST", "/api/v3/messages/"+msg+"/commands", body, nil); code != 400 {
			t.Fatalf("%v: %d", body, code)
		}
	}
	// A command text in the request is ignored: what runs is the stored one.
	for i := 0; i < 3; i++ {
		if code, _, _ := e.do("POST", "/api/v3/messages/"+msg+"/commands", map[string]any{"allow": ids, "command": "echo hijack > " + marker}, nil); code != 200 {
			t.Fatalf("allow %d: %d", i, code)
		}
	}
	resultOf(t, e, msg)
	time.Sleep(200 * time.Millisecond)
	b, _ := os.ReadFile(marker)
	if string(b) != "x\n" {
		t.Fatalf("ran %q", b)
	}
	// Denying it afterwards changes nothing; no second result message.
	e.do("POST", "/api/v3/messages/"+msg+"/commands", map[string]any{"deny": ids}, nil)
	if cs := runCmds(t, e, msg); cs[0].State != store.RunDone {
		t.Fatalf("after deny: %+v", cs[0])
	}
	stream, _ := e.st.StreamThread(context.Background(), sess.ID)
	th, _ := e.st.GetThread(context.Background(), stream)
	n := 0
	for _, m := range th.Messages {
		if m.Kind == store.KindRunResult {
			n++
		}
	}
	if n != 1 {
		t.Fatalf("%d result messages", n)
	}
}

// TestRunCommandsDenialWaitsForTheRest: a denial alone, while another command still waits on the
// person, is not sent yet; it goes with the next result.
func TestRunCommandsDenialWaitsForTheRest(t *testing.T) {
	e := newEnv(t)
	sess := e.createSession()
	msg, ids := sendCommands(t, e, sess, map[string]any{"command": "echo a"}, map[string]any{"command": "echo b"})
	e.do("POST", "/api/v3/messages/"+msg+"/commands", map[string]any{"deny": []string{ids[0]}}, nil)
	time.Sleep(200 * time.Millisecond)
	if cs := runCmds(t, e, msg); cs[0].State != store.RunDenied || cs[0].Reported {
		t.Fatalf("after the denial: %+v", cs[0])
	}
	e.do("POST", "/api/v3/messages/"+msg+"/commands", map[string]any{"allow": []string{ids[1]}}, nil)
	res := resultOf(t, e, msg)
	if !strings.Contains(res.Body, "1 ran, 1 denied") {
		t.Fatalf("result = %s", res.Body)
	}
	// Everything denied: reported at once.
	msg2, ids2 := sendCommands(t, e, sess, map[string]any{"command": "echo c"})
	e.do("POST", "/api/v3/messages/"+msg2+"/commands", map[string]any{"deny": ids2}, nil)
	if res := resultOf(t, e, msg2); !strings.Contains(res.Body, "0 ran, 1 denied") {
		t.Fatalf("result = %s", res.Body)
	}
}

func TestRunCommandsArchivedAgent(t *testing.T) {
	e := newEnv(t)
	sess := e.createSession()
	marker := filepath.Join(e.dir, "ran.txt")
	msg, ids := sendCommands(t, e, sess, map[string]any{"command": "touch " + marker})
	if err := e.st.SetSessionArchived(context.Background(), sess.ID, true); err != nil {
		t.Fatal(err)
	}
	if code, _, _ := e.do("POST", "/api/v3/messages/"+msg+"/commands", map[string]any{"allow": ids}, nil); code != 409 {
		t.Fatalf("allow on an archived agent: %d", code)
	}
	time.Sleep(100 * time.Millisecond)
	if _, err := os.Stat(marker); err == nil {
		t.Fatal("ran for an archived agent")
	}
	if cs := runCmds(t, e, msg); cs[0].State != store.RunPending {
		t.Fatalf("state = %+v", cs[0])
	}
}

func TestRunCommandsValidationAndTimeout(t *testing.T) {
	e := newEnv(t)
	sess := e.createSession()
	many := []any{}
	for i := 0; i < runCmdMax+1; i++ {
		many = append(many, map[string]any{"command": "true"})
	}
	for _, cmds := range [][]any{many, {map[string]any{"command": "  "}}, {map[string]any{"command": strings.Repeat("x", runCmdMaxRunes+1)}}} {
		if code, _, _ := e.do("POST", "/api/agent/messages", map[string]any{"body": "b", "commands": cmds}, bearer(sess)); code != 400 {
			t.Fatalf("bad commands: %d", code)
		}
	}
	e.srv.runCmdTimeout = 300 * time.Millisecond
	msg, ids := sendCommands(t, e, sess, map[string]any{"command": "echo started; sleep 30"})
	e.do("POST", "/api/v3/messages/"+msg+"/commands", map[string]any{"allow": ids}, nil)
	res := resultOf(t, e, msg)
	if cs := runCmds(t, e, msg); !cs[0].TimedOut || !strings.Contains(cs[0].Output, "started") {
		t.Fatalf("timeout: %+v", cs[0])
	}
	if !strings.Contains(res.Body, "timed out and was killed") {
		t.Fatalf("result = %s", res.Body)
	}
}

func TestHeadTailKeepsBothEnds(t *testing.T) {
	in := strings.Repeat("a", 100) + strings.Repeat("m", 1000) + strings.Repeat("z", 100)
	out, cut := headTail(in, 200)
	if !cut || !strings.HasPrefix(out, strings.Repeat("a", 100)) || !strings.HasSuffix(out, strings.Repeat("z", 100)) || !strings.Contains(out, "[1000 bytes cut]") {
		t.Fatalf("out = %q", out)
	}
	if out, cut := headTail("short", 200); cut || out != "short" {
		t.Fatalf("short = %q", out)
	}
	w := &headTailWriter{max: 10}
	for _, c := range "abcdefghijklmnopqrstuvwxyz" {
		w.Write([]byte(string(c)))
	}
	if s, cut := w.String(); !cut || !strings.HasPrefix(s, "abcde") || !strings.HasSuffix(s, "vwxyz") {
		t.Fatalf("writer = %q", s)
	}
}

func TestRunResultFences(t *testing.T) {
	cs := []store.RunCommand{{Index: 0, Command: "echo '```'", Cwd: "/w", State: store.RunDone, Output: "```\nx\n"}}
	body := runResultText("msg_1", cs, 1, []string{"tsk_1"})
	if !strings.Contains(body, "````sh\necho '```'\n````") || !strings.Contains(body, "````text\n```\nx\n````") || !strings.Contains(body, "Task: tsk_1") {
		t.Fatalf("body = %s", body)
	}
}

func TestRemoteArgvKeepsPlaceholders(t *testing.T) {
	if got := remoteArgv("echo hi"); len(got) != 3 || got[2] != "echo hi" {
		t.Fatalf("%q", got)
	}
	got := remoteArgv("echo {{MINBOX_PI_EXTENSION}}")
	if strings.Contains(got[2], "{{") {
		t.Fatalf("placeholder left for the host to fill in: %q", got)
	}
}

func TestRunCommandsToolAndSlackText(t *testing.T) {
	e := newEnv(t)
	sess := e.createSession()
	code, o, _ := e.do("POST", "/api/agent/tool", map[string]any{"tool": "mcp__minbox__send_message", "args": map[string]any{"body": "Run the migration?", "commands": []any{map[string]any{"command": "echo migrate", "description": "the migration"}}}}, bearer(sess))
	if code != 200 || o["ok"] != true || !strings.Contains(o["text"].(string), "with 1 command for them to approve") || !strings.Contains(o["text"].(string), "Do not wait or poll for them") {
		t.Fatalf("tool: %d %v", code, o)
	}
	note := runCommandsNote([]store.RunCommandSpec{{Command: "echo migrate", Description: "the migration"}})
	if !strings.Contains(note, "approve or deny them in minbox") || !strings.Contains(note, "• echo migrate — the migration") {
		t.Fatalf("note = %q", note)
	}
	if d := sendSchema()["properties"].(jobj)["commands"]; d == nil {
		t.Fatal("send_message has no commands parameter")
	}
}

// TestRunCommandsOnRemoteHost: an agent on another host has its commands run there, through the
// host's exec, with exactly the stored text (a host's placeholders are not filled in).
func TestRunCommandsOnRemoteHost(t *testing.T) {
	e := newEnv(t)
	e.srv.pairPoll = 50 * time.Millisecond
	hostURL, hostDir, _ := remoteHost(t, "", "")
	hostID := pairHost(t, e, hostURL, hostDir)
	work := t.TempDir()
	e.srv.sessions.cfg.ClaudeCommand = []string{"/bin/sh", "-c", "sleep 30"}
	code, obj, _ := e.do("POST", "/api/sessions", map[string]string{"cwd": work, "name": "remote", "host_id": hostID}, nil)
	if code != 201 {
		t.Fatalf("create: %d %v", code, obj)
	}
	sess, _ := e.st.GetSession(context.Background(), obj["id"].(string))
	if !e.srv.sessions.remote(sess.HostID) {
		t.Fatal("not a remote agent")
	}
	msg, ids := sendCommands(t, e, sess, map[string]any{"command": "pwd; echo '{{MINBOX_PI_EXTENSION}}'; echo oops >&2; exit 4"})
	e.do("POST", "/api/v3/messages/"+msg+"/commands", map[string]any{"allow": ids}, nil)
	res := resultOf(t, e, msg)
	c := runCmds(t, e, msg)[0]
	if c.ExitCode != 4 || c.Error != "" || !strings.Contains(c.Output, "{{MINBOX_PI_EXTENSION}}") || !strings.Contains(c.Output, "oops") || !(strings.Contains(c.Output, work) || strings.Contains(c.Output, evalPath(work))) {
		t.Fatalf("remote run = %+v", c)
	}
	if !strings.Contains(res.Body, "exit code 4") {
		t.Fatalf("result = %s", res.Body)
	}
}
