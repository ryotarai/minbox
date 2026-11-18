package server

import (
	"bytes"
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/ryotarai/minbox/internal/store"
)

// The mod protocol (modproto.go, docs/mod-protocol.md): the tool set, tool calls, events and the
// pending poll's text, as the thin integrations use them; and that protocol 0 keeps working.

// TestManifestFixtures keeps plugin/testdata/manifest-<agent>.json equal to what the server serves:
// the integrations' node tests run against these files (their guards' JavaScript patterns
// included). MINBOX_UPDATE_FIXTURES=1 rewrites them.
func TestManifestFixtures(t *testing.T) {
	for _, kind := range []string{"claude", "pi", "opencode"} {
		b, _ := json.MarshalIndent(manifestFor(kind), "", "  ")
		b = append(b, '\n')
		p := filepath.Join("..", "..", "plugin", "testdata", "manifest-"+kind+".json")
		if os.Getenv("MINBOX_UPDATE_FIXTURES") == "1" {
			if err := os.WriteFile(p, b, 0o644); err != nil {
				t.Fatal(err)
			}
			continue
		}
		have, err := os.ReadFile(p)
		if err != nil || !bytes.Equal(have, b) {
			t.Errorf("%s is out of date: run MINBOX_UPDATE_FIXTURES=1 go test ./internal/server -run TestManifestFixtures", p)
		}
	}
}

func TestManifestPerAgent(t *testing.T) {
	names := func(kind string) []string {
		var out []string
		for _, tl := range manifestFor(kind).Tools {
			out = append(out, tl.Name)
		}
		return out
	}
	if got := strings.Join(names("claude"), ","); got != "send_message,read_thread,set_session_title,open_url,create_task,update_task,list_tasks,list_projects,get_project,list_sessions,list_threads,search" {
		t.Fatal(got)
	}
	if got := strings.Join(names("pi"), ","); got != "minbox_send_message,minbox_read_thread,minbox_list_projects,minbox_get_project,minbox_list_sessions,minbox_list_threads,minbox_search,minbox_create_task,minbox_update_task,minbox_list_tasks,minbox_set_session_title,minbox_open_url" {
		t.Fatal(got)
	}
	if got := strings.Join(names("opencode"), ","); got != "minbox_send_message,minbox_read_thread,minbox_create_task,minbox_update_task,minbox_list_tasks,minbox_list_projects,minbox_get_project,minbox_list_sessions,minbox_list_threads,minbox_search,minbox_set_session_title,minbox_open_url" {
		t.Fatal(got)
	}
	for _, tl := range manifestFor("claude").Tools {
		if tl.Deferred != (tl.Name == "list_projects" || tl.Name == "get_project" || tl.Name == "list_sessions" || tl.Name == "list_threads" || tl.Name == "search") {
			t.Errorf("%s deferred=%v", tl.Name, tl.Deferred)
		}
	}
	pi := manifestFor("pi")
	if pi.Tools[1].Label != "minbox: read thread" || pi.Tools[2].Label != "minbox: list projects" || !strings.Contains(pi.Tools[1].Description, "minbox_list_threads") || strings.Contains(pi.Tools[11].Description, "Claude runs on") {
		t.Fatalf("pi: %+v", pi.Tools[1])
	}
	if manifestFor("claude").Version == manifestFor("pi").Version || len(manifestFor("opencode").Guards) != 2 || manifestFor("claude").Guards[0].Deny != openDeny("mcp__minbox__open_url") {
		t.Fatal("versions or guards")
	}
}

type protoEnv struct {
	*env
	sess *store.Session
}

func (p protoEnv) tool(name string, args map[string]any) map[string]any {
	p.t.Helper()
	code, o, _ := p.do("POST", "/api/agent/tool", map[string]any{"tool": name, "args": args}, bearer(p.sess))
	if code != 200 {
		p.t.Fatalf("tool %s: %d %v", name, code, o)
	}
	return o
}

func (p protoEnv) event(body map[string]any) map[string]any {
	p.t.Helper()
	code, o, _ := p.do("POST", "/api/agent/event", body, bearer(p.sess))
	if code != 200 {
		p.t.Fatalf("event %v: %d %v", body, code, o)
	}
	return o
}

func newProto(t *testing.T) protoEnv {
	e := newEnv(t)
	sess := e.createSession()
	p := protoEnv{e, sess}
	if code, o, _ := e.do("POST", "/api/agent/hello", map[string]any{"claude_session_id": "c1", "protocol": 1}, bearer(sess)); code != 200 || o["protocol"] != float64(ModProtocol) || o["tools_version"] != manifestFor("claude").Version {
		t.Fatalf("hello: %d %v", code, o)
	}
	return p
}

func TestToolCallsGoThroughTheAgentAPI(t *testing.T) {
	p := newProto(t)
	if code, o, _ := p.do("GET", "/api/agent/tools", nil, bearer(p.sess)); code != 200 || o["version"] != manifestFor("claude").Version || len(o["tools"].([]any)) != 12 {
		t.Fatalf("tools: %d %v", code, o)
	}
	if o := p.tool("mcp__minbox__send_message", map[string]any{"body": "  "}); o["ok"] != false || o["error"] != "body is required." {
		t.Fatal(o)
	}
	o := p.tool("send_message", map[string]any{"body": "Pick one\n\n:::question\nA or B?\n- [ ] A\n- [ ] B\n:::", "subject": "Old"})
	if o["ok"] != true || !strings.HasPrefix(o["text"].(string), "Sent to the person in minbox asking 1 question.") || !strings.Contains(o["text"].(string), `Questions the inbox shows: "A or B?".`) {
		t.Fatal(o)
	}
	if o := p.tool("send_message", map[string]any{"body": "x", "task_ids": []any{"tsk_nope"}}); o["ok"] != false || !strings.HasPrefix(o["error"].(string), "minbox: ") {
		t.Fatalf("unknown task: %v", o)
	}
	if o := p.tool("set_session_title", map[string]any{"title": "  Fix   login "}); o["text"] != "Session title set: Fix login" || o["effects"].(map[string]any)["session_title"] != "Fix   login" {
		t.Fatal(o)
	}
	if o := p.tool("open_url", map[string]any{"url": "https://x.dev"}); o["ok"] != false || !strings.Contains(o["error"].(string), "minbox: no browser has minbox open") {
		t.Fatal(o)
	}
	if o := p.tool("open_url", map[string]any{}); o["error"] != "url is required." {
		t.Fatal(o)
	}
	o = p.tool("create_task", map[string]any{"title": "Search UI", "steps": []any{map[string]any{"text": "Add the field"}}})
	text := o["text"].(string)
	if !strings.HasPrefix(text, "Task created (task_id ") || !strings.Contains(text, "  1. [ ] Add the field") {
		t.Fatal(o)
	}
	id := strings.TrimSuffix(strings.Fields(strings.TrimPrefix(text, "Task created (task_id "))[0], ").")
	if o := p.tool("update_task", map[string]any{"task_id": id, "check_steps": []any{1}}); !strings.Contains(o["text"].(string), "Task updated.\n- "+id+" [working] Search UI\n  1. [x] Add the field") {
		t.Fatal(o)
	}
	if o := p.tool("list_tasks", nil); !strings.Contains(o["text"].(string), id) {
		t.Fatal(o)
	}
	if o := p.tool("read_thread", nil); !strings.HasPrefix(o["text"].(string), "- thr_") {
		t.Fatal(o)
	}
	if o := p.tool("list_threads", map[string]any{"session_id": "self"}); !strings.Contains(o["text"].(string), "(this session)") {
		t.Fatal(o)
	}
	if o := p.tool("search", map[string]any{"query": ""}); o["error"] != "query is required." {
		t.Fatal(o)
	}
	if o := p.tool("get_project", map[string]any{"project_id": "a/b"}); o["ok"] != false {
		t.Fatal(o)
	}
	if o := p.tool("nope", nil); o["error"] != "minbox: unknown tool nope" {
		t.Fatal(o)
	}
}

// pendingV1 answers the delivered text; delivering it makes the next turn answer its thread, and a
// turn that answered without send_message is reminded once (Claude Code).
func TestPendingTextAndTurnReminders(t *testing.T) {
	p := newProto(t)
	ctx := context.Background()
	stream, _ := p.st.StreamThread(ctx, p.sess.ID)
	if code, o, _ := p.do("POST", "/api/threads/"+stream+"/reply", map[string]any{"words": "fix the gauge"}, nil); code != 201 {
		t.Fatalf("reply: %d %v", code, o)
	}
	_, o, _ := p.do("GET", "/api/agent/pending?owner=o&proto=1", nil, bearer(p.sess))
	items := o["items"].([]any)
	if len(items) != 1 || o["joiner"] != "\n\n---\n\n" || o["protocol"] != float64(1) {
		t.Fatalf("pending: %v", o)
	}
	it := items[0].(map[string]any)
	if !strings.Contains(it["text"].(string), "a message from the person (message "+it["id"].(string)+")") || !strings.Contains(it["text"].(string), "Answer it with mcp__minbox__send_message") || !strings.HasSuffix(it["text"].(string), "fix the gauge") {
		t.Fatalf("text: %q", it["text"])
	}
	// Protocol 0 still gets the plain list.
	if _, _, arr := p.do("GET", "/api/agent/pending?owner=o", nil, bearer(p.sess)); len(arr) != 1 {
		t.Fatal("protocol 0 list")
	}
	p.do("POST", "/api/agent/pending/"+it["id"].(string)+"/claim?owner=o", nil, bearer(p.sess))
	p.do("POST", "/api/agent/pending/"+it["id"].(string)+"/delivered?owner=o", nil, bearer(p.sess))

	p.event(map[string]any{"type": "turn.start"})
	if s, _ := p.st.GetSession(ctx, p.sess.ID); s.Status != store.StatusWorking {
		t.Fatalf("status %s", s.Status)
	}
	o = p.event(map[string]any{"type": "turn.complete", "reason": "answer", "answer": "Done."})
	if o["submit_when_idle"] != replyNudgeText("mcp__minbox__send_message") {
		t.Fatalf("reply nudge: %v", o)
	}
	if s, _ := p.st.GetSession(ctx, p.sess.ID); s.Status != store.StatusIdle {
		t.Fatalf("status %s", s.Status)
	}
	// The reminder's own turn does not remind again, even when it asks.
	p.event(map[string]any{"type": "turn.start"})
	if o := p.event(map[string]any{"type": "turn.complete", "reason": "answer", "answer": "Should I merge?"}); o["submit_when_idle"] != nil {
		t.Fatal(o)
	}
	// Asking in the chat only: one reminder; with send_message: none; aborted: none.
	p.event(map[string]any{"type": "turn.start"})
	if o := p.event(map[string]any{"type": "turn.complete", "reason": "answer", "answer": "Done. マージしてもよろしいですか？"}); o["submit_when_idle"] != nudgeText("mcp__minbox__send_message") {
		t.Fatal(o)
	}
	// The person typed before it went in: the reminder is dropped (the next turn is theirs).
	p.event(map[string]any{"type": "prompt", "origin": "composer"})
	p.event(map[string]any{"type": "turn.start"})
	p.tool("send_message", map[string]any{"body": "Which one?"})
	if o := p.event(map[string]any{"type": "turn.complete", "reason": "answer", "answer": "Which one?"}); o["submit_when_idle"] != nil {
		t.Fatal(o)
	}
	p.event(map[string]any{"type": "turn.start"})
	if o := p.event(map[string]any{"type": "turn.complete", "reason": "answer", "aborted": true, "answer": "Which?"}); o["submit_when_idle"] != nil {
		t.Fatal(o)
	}
	// Pi and OpenCode report no reason: never reminded.
	p.event(map[string]any{"type": "turn.start"})
	if o := p.event(map[string]any{"type": "turn.complete"}); o["submit_when_idle"] != nil {
		t.Fatal(o)
	}
	if code, _, _ := p.do("POST", "/api/agent/event", map[string]any{"type": "bogus"}, bearer(p.sess)); code != 400 {
		t.Fatal("unknown event")
	}
}

func TestPromptContextFollowsTheConversation(t *testing.T) {
	t.Setenv("MINBOX_ORCHESTRATOR_EVERY", "3")
	p := newProto(t)
	ctx := func(origin string) []any {
		return p.event(map[string]any{"type": "prompt", "origin": origin})["context"].([]any)
	}
	first := ctx("composer")
	if len(first) != 1 || !strings.HasPrefix(first[0].(string), "minbox: standing instructions (still in force):\n\n# minbox: talking with the person") || !strings.Contains(first[0].(string), "# minbox: orchestration") {
		t.Fatalf("first: %v", first)
	}
	if got := [][]any{ctx(""), ctx(""), ctx(""), ctx("")}; len(got[0]) != 0 || len(got[1]) != 1 || len(got[2]) != 0 || len(got[3]) != 0 {
		t.Fatalf("every 3rd: %v", got)
	}
	// After a compaction: the instructions and the open threads, once.
	p.do("POST", "/api/agent/messages", map[string]any{"body": "A or B?\n\n:::question\nA or B?\n- [ ] A\n- [ ] B\n:::"}, bearer(p.sess))
	p.event(map[string]any{"type": "session.compact"})
	got := ctx("")
	if len(got) != 2 || !strings.Contains(got[1].(string), "Your open minbox threads (1)") {
		t.Fatalf("after compaction: %v", got)
	}
	// A /clear (session.end) and a new hello: the instructions again.
	p.event(map[string]any{"type": "session.end"})
	if got := ctx(""); len(got) != 1 {
		t.Fatalf("after session.end: %v", got)
	}
	p.do("POST", "/api/agent/hello", map[string]any{"claude_session_id": "c2", "protocol": 1}, bearer(p.sess))
	if got := ctx(""); len(got) != 1 {
		t.Fatalf("after hello: %v", got)
	}
}

// TestInstructionsCarryTheOrchestration: the instructions the server serves (system prompt and the
// per-prompt standing instructions) keep the orchestration / subagent block for each agent.
func TestInstructionsCarryTheOrchestration(t *testing.T) {
	e := newEnv(t)
	withPi(e, "sleep 1")
	withOpenCode(e, "opencode v2.1.4")
	for kind, want := range map[string]string{"claude": "# minbox: orchestration\nYou are the main agent of this session and only orchestrate.", "pi": "# minbox: subagents\n", "opencode": "# minbox: subagents in OpenCode\n"} {
		var sess *store.Session
		if kind == "claude" {
			sess = e.createSession()
		} else {
			s, code, o := e.createAgentSession(kind)
			if s == nil {
				t.Fatalf("%s: %d %v", kind, code, o)
			}
			sess = s
		}
		_, hello, _ := e.do("POST", "/api/agent/hello", map[string]any{"agent": kind, "protocol": 1}, bearer(sess))
		if !strings.Contains(hello["instructions"].(string), want) {
			t.Errorf("%s hello: missing %q", kind, want)
		}
		// v3 terms in the finding-things section (agents, tasks, conversations), and no "no task" option.
		for _, want := range []string{"an agent, a task or an earlier conversation the person mentions", "Every message, theirs and yours, must be about a task"} {
			if !strings.Contains(hello["instructions"].(string), want) {
				t.Errorf("%s: missing %q", kind, want)
			}
		}
		if strings.Contains(hello["instructions"].(string), "nothing that needs a task") {
			t.Errorf("%s: the instructions still offer no task", kind)
		}
		_, o, _ := e.do("POST", "/api/agent/event", map[string]any{"type": "prompt"}, bearer(sess))
		if c := o["context"].([]any); len(c) != 1 || !strings.Contains(c[0].(string), want) {
			t.Errorf("%s prompt: %v", kind, o)
		}
	}
}

func TestBashOutcomesReportDeniedCommands(t *testing.T) {
	p := newProto(t)
	ctx := context.Background()
	stream, _ := p.st.StreamThread(ctx, p.sess.ID)
	latest := func() string {
		c, ok := p.srv.denied.latest(stream)
		if !ok {
			return ""
		}
		return c.Command + " | " + c.Reason
	}
	// A message delivered: the turn answers the stream, so the denial belongs to it.
	p.do("POST", "/api/threads/"+stream+"/reply", map[string]any{"words": "run the tests"}, nil)
	_, _, arr := p.do("GET", "/api/agent/pending?owner=o", nil, bearer(p.sess))
	id := arr[0].(map[string]any)["id"].(string)
	p.do("POST", "/api/agent/pending/"+id+"/claim?owner=o", nil, bearer(p.sess))
	p.do("POST", "/api/agent/pending/"+id+"/delivered?owner=o", nil, bearer(p.sess))
	p.event(map[string]any{"type": "turn.start"})

	// A failed run is no denial; a refusal worded as an error is.
	p.event(map[string]any{"type": "bash", "phase": "result", "id": "t0", "command": "go test", "is_error": true, "text": "exit 1: Permission denied"})
	if latest() != "" {
		t.Fatal(latest())
	}
	p.event(map[string]any{"type": "bash", "phase": "result", "id": "t1", "command": " go test ./... ", "is_error": true, "text": "The user doesn't want to proceed with this tool use. The tool use was rejected."})
	if got := latest(); got != "go test ./... | The user doesn't want to proceed with this tool use. The tool use was rejected." {
		t.Fatal(got)
	}
	// The same call seen again (check, then result) is reported once; a later run clears it.
	p.event(map[string]any{"type": "bash", "phase": "check", "id": "t2", "command": "rm -rf build", "decision": "deny", "rule": "Bash(rm:*)"})
	p.event(map[string]any{"type": "bash", "phase": "result", "id": "t2", "command": "rm -rf build", "deny": "no"})
	if got := latest(); got != "rm -rf build | denied by the rule Bash(rm:*)" {
		t.Fatal(got)
	}
	p.event(map[string]any{"type": "bash", "phase": "result", "id": "t3", "command": "rm -rf build"})
	if got := latest(); got != "go test ./... | The user doesn't want to proceed with this tool use. The tool use was rejected." {
		t.Fatal(got)
	}
	// minbox's own refusal is not offered; Pi's block and OpenCode's rejection are.
	p.event(map[string]any{"type": "bash", "phase": "result", "id": "t4", "command": "open https://x", "deny": openDeny("mcp__minbox__open_url")})
	p.event(map[string]any{"type": "bash", "phase": "end", "id": "t5", "command": "make", "is_error": true, "text": "Operation aborted"})
	if !strings.HasPrefix(latest(), "go test") {
		t.Fatal(latest())
	}
	p.event(map[string]any{"type": "bash", "phase": "end", "id": "t6", "command": "make deploy", "is_error": true, "text": "Blocked by policy"})
	if got := latest(); got != "make deploy | Blocked by policy" {
		t.Fatal(got)
	}
	p.event(map[string]any{"type": "bash", "phase": "failed", "id": "t7", "command": "npm publish", "error_type": "permission.rejected", "message": "denied by config"})
	if got := latest(); got != "npm publish | denied by config" {
		t.Fatal(got)
	}
	p.event(map[string]any{"type": "bash", "phase": "success", "command": "npm publish"})
	if got := latest(); got != "make deploy | Blocked by policy" {
		t.Fatal(got)
	}
}

// TestOldProtocolIsFlagged: an integration of protocol 0 keeps working and the session says it runs
// an old mod; protocol 1 clears it.
func TestOldProtocolIsFlagged(t *testing.T) {
	e := newEnv(t)
	sess := e.createSession()
	outdated := func() any {
		_, _, arr := e.do("GET", "/api/sessions", nil, nil)
		for _, s := range arr {
			if m := s.(map[string]any); m["id"] == sess.ID {
				return m["mod_outdated"]
			}
		}
		return "missing"
	}
	if got := outdated(); got != nil {
		t.Fatalf("before any hello: %v", got)
	}
	e.do("POST", "/api/agent/hello", map[string]any{"claude_session_id": "c"}, bearer(sess))
	if got := outdated(); got != true {
		t.Fatalf("protocol 0: %v", got)
	}
	_, o, _ := e.do("POST", "/api/agent/heartbeat", map[string]any{"seq": 1, "agent": "claude", "state": "idle", "protocol": 1}, bearer(sess))
	if o["tools_version"] != manifestFor("claude").Version || outdated() != nil {
		t.Fatalf("protocol 1: %v %v", o, outdated())
	}
	_, conn, _ := e.do("GET", "/api/sessions/"+sess.ID+"/connection", nil, nil)
	if conn["mod_protocol"] != float64(1) || conn["server_protocol"] != float64(ModProtocol) {
		t.Fatal(conn)
	}
}

// minbox's request to place messages in tasks reaches a protocol-1 integration as its own words, its
// turn is not taken for an answer to the person (no "you did not reply" reminder), and the
// send_message result names what is still in no task.
func TestPlaceRequestOverProtocol1(t *testing.T) {
	shortPlace(t)
	p := newProto(t)
	u := p.personSays(p.sess, "thanks!")
	p.event(map[string]any{"type": "turn.start"})
	o := p.tool("send_message", map[string]any{"body": "You're welcome."})
	p.event(map[string]any{"type": "turn.complete", "reason": "answer", "answer": "Done."})
	if text := o["text"].(string); !strings.Contains(text, "in no task") || !strings.Contains(text, u) {
		t.Fatalf("send_message text = %q", text)
	}
	p.idle(p.sess)
	_, pend, _ := p.do("GET", "/api/agent/pending?owner=o&proto=1", nil, bearer(p.sess))
	items := pend["items"].([]any)
	if len(items) != 1 {
		t.Fatalf("items = %v", items)
	}
	it := items[0].(map[string]any)
	if it["kind"] != store.KindPlace || it["text"] != strings.TrimSpace(it["body"].(string)) || !strings.Contains(it["text"].(string), u) {
		t.Fatalf("place item = %v", it)
	}
	p.do("POST", "/api/agent/pending/"+it["id"].(string)+"/claim?owner=o", nil, bearer(p.sess))
	p.do("POST", "/api/agent/pending/"+it["id"].(string)+"/delivered?owner=o", nil, bearer(p.sess))
	p.event(map[string]any{"type": "turn.start"})
	if o := p.event(map[string]any{"type": "turn.complete", "reason": "answer", "answer": "Placed them."}); o["submit_when_idle"] != nil {
		t.Fatalf("a place request's turn was reminded: %v", o)
	}
}
