package server

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/ryotarai/minbox/internal/agent"
	"github.com/ryotarai/minbox/internal/store"
)

// sessionIn starts a session in its own folder (so in its own project).
func (e *env) sessionIn(sub, name string) *store.Session {
	e.t.Helper()
	dir := filepath.Join(e.dir, sub)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		e.t.Fatal(err)
	}
	code, obj, _ := e.do("POST", "/api/sessions", map[string]string{"cwd": dir, "name": name}, nil)
	if code != 201 {
		e.t.Fatalf("create session: %d %v", code, obj)
	}
	sess, err := e.st.GetSession(context.Background(), obj["id"].(string))
	if err != nil {
		e.t.Fatal(err)
	}
	return sess
}

// send posts an agent message; without threadID it first makes an older-style thread (a segment
// of the session's stream, as every thread was before v3) and posts into it.
func (e *env) send(sess *store.Session, threadID, subject, body, status string) string {
	e.t.Helper()
	if threadID == "" {
		id, err := e.st.NewSegmentThread(context.Background(), sess.ID, subject)
		if err != nil {
			e.t.Fatal(err)
		}
		threadID = id
	}
	m := map[string]string{"body": body, "thread_title": subject, "status": status}
	if threadID != "" {
		m["thread_id"] = threadID
	}
	code, obj, _ := e.do("POST", "/api/agent/messages", m, bearer(sess))
	if code != 201 {
		e.t.Fatalf("send: %d %v", code, obj)
	}
	return obj["thread_id"].(string)
}

func rows(t *testing.T, obj map[string]any, key string) []map[string]any {
	t.Helper()
	var out []map[string]any
	for _, v := range obj[key].([]any) {
		out = append(out, v.(map[string]any))
	}
	return out
}

func TestInstructionsMentionTheNavigationTools(t *testing.T) {
	names := []string{"list_projects", "get_project", "list_sessions", "list_threads", "search", "read_thread"}
	claude := buildInstructions(false, "")
	pi := buildInstructionsFor(agent.Must(agent.Pi), false, "")
	for _, n := range names {
		if !strings.Contains(claude, "mcp__minbox__"+n) {
			t.Errorf("claude instructions lack %s", n)
		}
		if !strings.Contains(pi, "minbox_"+n) {
			t.Errorf("pi instructions lack %s", n)
		}
	}
	if strings.Contains(pi, "mcp__minbox__") {
		t.Error("pi instructions name Claude tools")
	}
}

func TestAgentReadAPINeedsItsToken(t *testing.T) {
	e := newEnv(t)
	e.createSession()
	for _, p := range []string{"/api/agent/projects", "/api/agent/projects/x", "/api/agent/sessions", "/api/agent/inbox", "/api/agent/search?q=a", "/api/agent/threads/x"} {
		if code, _, _ := e.do("GET", p, nil, nil); code != 401 {
			t.Errorf("%s without token: %d", p, code)
		}
		if code, _, _ := e.do("GET", p, nil, map[string]string{"Authorization": "Bearer nope"}); code != 401 {
			t.Errorf("%s with a wrong token: %d", p, code)
		}
	}
}

func TestAgentProjectsAndSessions(t *testing.T) {
	e := newEnv(t)
	a := e.createSession()
	b := e.sessionIn("other", "b")
	e.send(a, "", "Alpha", "hello", "need_action")
	e.send(b, "", "Beta", "hello", "finished")

	code, _, arr := e.do("GET", "/api/agent/projects", nil, bearer(a))
	if code != 200 || len(arr) != 2 {
		t.Fatalf("projects: %d %v", code, arr)
	}
	byDir := map[string]map[string]any{}
	for _, v := range arr {
		p := v.(map[string]any)
		byDir[p["dir"].(string)] = p
	}
	pa := byDir[a.Cwd]
	if pa == nil || pa["thread_count"].(float64) != 1 || pa["need_action"].(float64) != 1 || pa["session_count"].(float64) != 1 {
		t.Fatalf("project a: %v", pa)
	}
	if _, ok := pa["icon"]; ok {
		t.Fatalf("icon leaked: %v", pa)
	}
	code, one, _ := e.do("GET", "/api/agent/projects/"+pa["id"].(string), nil, bearer(b))
	if code != 200 || one["name"] != pa["name"] || len(one["sessions"].([]any)) != 1 {
		t.Fatalf("project: %d %v", code, one)
	}
	if code, _, _ := e.do("GET", "/api/agent/projects/nope", nil, bearer(a)); code != 404 {
		t.Fatalf("missing project: %d", code)
	}

	code, ses, _ := e.do("GET", "/api/agent/sessions", nil, bearer(a))
	if code != 200 || len(rows(t, ses, "sessions")) != 2 {
		t.Fatalf("sessions: %d %v", code, ses)
	}
	_, ses, _ = e.do("GET", "/api/agent/sessions?project_id="+pa["id"].(string), nil, bearer(a))
	got := rows(t, ses, "sessions")
	if len(got) != 1 || got[0]["id"] != a.ID || got[0]["self"] != true || got[0]["agent"] != "claude" {
		t.Fatalf("filtered sessions: %v", ses)
	}
	_, ses, _ = e.do("GET", "/api/agent/sessions?agent=pi", nil, bearer(a))
	if len(rows(t, ses, "sessions")) != 0 {
		t.Fatalf("agent filter: %v", ses)
	}
}

func TestAgentInboxFilters(t *testing.T) {
	e := newEnv(t)
	a := e.createSession()
	b := e.sessionIn("other", "b")
	t1 := e.send(a, "", "Deploy plan", "ship the thing on friday", "need_action")
	e.send(a, "", "Done work", "all merged", "finished")
	t3 := e.send(b, "", "Other project", "waiting for CI", "blocked")

	list := func(q string) map[string]any {
		code, obj, _ := e.do("GET", "/api/agent/inbox"+q, nil, bearer(a))
		if code != 200 {
			t.Fatalf("%s: %d %v", q, code, obj)
		}
		return obj
	}
	if all := list(""); all["total"].(float64) != 3 {
		t.Fatalf("all: %v", all)
	}
	if got := rows(t, list("?status=need_action"), "threads"); len(got) != 1 || got[0]["id"] != t1 || got[0]["self"] != true {
		t.Fatalf("status: %v", got)
	}
	if got := rows(t, list("?status=blocked"), "threads"); len(got) != 1 || got[0]["id"] != t3 || got[0]["session_name"] != "b" {
		t.Fatalf("blocked: %v", got)
	}
	if got := rows(t, list("?q=friday"), "threads"); len(got) != 1 || got[0]["id"] != t1 {
		t.Fatalf("q: %v", got)
	}
	if got := rows(t, list("?session_id=self"), "threads"); len(got) != 2 {
		t.Fatalf("self: %v", got)
	}
	if got := rows(t, list("?session_id="+b.ID), "threads"); len(got) != 1 || got[0]["id"] != t3 {
		t.Fatalf("session: %v", got)
	}
	pb := rows(t, list("?session_id="+b.ID), "threads")[0]["project_id"].(string)
	if got := rows(t, list("?project_id="+pb), "threads"); len(got) != 1 {
		t.Fatalf("project: %v", got)
	}
	if got := rows(t, list("?awaiting=person"), "threads"); len(got) != 1 || got[0]["id"] != t1 {
		t.Fatalf("awaiting person: %v", got)
	}
	if got := rows(t, list("?unread=1"), "threads"); len(got) != 3 {
		t.Fatalf("unread: %v", got)
	}
	// The person writes in thread 1: it awaits the agent.
	if code, _, _ := e.do("POST", "/api/threads/"+t1+"/reply", map[string]any{"words": "ok go"}, nil); code != 201 && code != 200 {
		t.Fatalf("reply: %d", code)
	}
	if got := rows(t, list("?awaiting=agent"), "threads"); len(got) != 1 || got[0]["id"] != t1 {
		t.Fatalf("awaiting agent: %v", got)
	}
	// Archived threads only on request.
	if code, _, _ := e.do("POST", "/api/threads/"+t3+"/archive", nil, nil); code != 200 && code != 204 {
		t.Fatalf("archive: %d", code)
	}
	if all := list(""); all["total"].(float64) != 2 {
		t.Fatalf("after archive: %v", all)
	}
	if got := rows(t, list("?archived=1"), "threads"); len(got) != 1 || got[0]["id"] != t3 {
		t.Fatalf("archived: %v", got)
	}
	// Bounds.
	for i := 0; i < 5; i++ {
		e.send(a, "", fmt.Sprintf("bulk %d", i), strings.Repeat("x", 2000), "working")
	}
	lim := list("?limit=3")
	got := rows(t, lim, "threads")
	if len(got) != 3 || lim["has_more"] != true || lim["total"].(float64) != 7 {
		t.Fatalf("limit: %v", lim)
	}
	for _, r := range got {
		if len(r["last_body"].(string)) > agentSnippetBytes {
			t.Fatalf("last_body not cut: %d", len(r["last_body"].(string)))
		}
	}
	if code, _, _ := e.do("GET", "/api/agent/inbox?status=bogus", nil, bearer(a)); code != 400 {
		t.Fatalf("bad status: %d", code)
	}
	if code, _, _ := e.do("GET", "/api/agent/inbox?awaiting=x", nil, bearer(a)); code != 400 {
		t.Fatalf("bad awaiting: %d", code)
	}
	// The legacy list (this session's threads) is unchanged: an array.
	if code, _, arr := e.do("GET", "/api/agent/threads", nil, bearer(a)); code != 200 || len(arr) == 0 {
		t.Fatalf("legacy list: %d %v", code, arr)
	}
}

func TestAgentReadThreadPagesAcrossSessions(t *testing.T) {
	e := newEnv(t)
	a := e.createSession()
	b := e.sessionIn("other", "b")
	tid := ""
	for i := 0; i < 45; i++ {
		tid = e.send(a, tid, "Long", fmt.Sprintf("message %02d", i), "working")
	}
	// Another session may read it (read-only), but not write into it.
	code, th, _ := e.do("GET", "/api/agent/threads/"+tid, nil, bearer(b))
	if code != 200 || th["own"] != false || th["session_name"] != "s" {
		t.Fatalf("cross-session read: %d %v", code, th)
	}
	if code, _, _ := e.do("POST", "/api/agent/messages", map[string]string{"body": "x", "thread_id": tid}, bearer(b)); code != 404 {
		t.Fatalf("cross-session write: %d", code)
	}
	msgs := rows(t, th, "messages")
	if len(msgs) != agentReadDefault || th["message_count"].(float64) != 45 || th["has_more"] != true {
		t.Fatalf("default page: %d msgs, %v", len(msgs), th["message_count"])
	}
	if msgs[len(msgs)-1]["body"] != "message 44" || msgs[0]["body"] != "message 15" {
		t.Fatalf("not the latest in order: %v ... %v", msgs[0]["body"], msgs[len(msgs)-1]["body"])
	}
	// Older ones with before.
	cursor := th["next_before"].(string)
	_, th2, _ := e.do("GET", "/api/agent/threads/"+tid+"?before="+cursor, nil, bearer(a))
	older := rows(t, th2, "messages")
	if len(older) != 15 || older[0]["body"] != "message 00" || older[14]["body"] != "message 14" || th2["has_more"] != false || th2["next_before"] != nil {
		t.Fatalf("older page: %d %v", len(older), th2["has_more"])
	}
	// limit
	_, th3, _ := e.do("GET", "/api/agent/threads/"+tid+"?limit=2", nil, bearer(a))
	if len(rows(t, th3, "messages")) != 2 || th3["older"].(float64) != 43 {
		t.Fatalf("limit: %v", th3["older"])
	}
	_, th4, _ := e.do("GET", "/api/agent/threads/"+tid+"?limit=100000", nil, bearer(a))
	if len(rows(t, th4, "messages")) != 45 {
		t.Fatalf("limit is capped at %d, 45 exist", agentReadMax)
	}
	if code, _, _ := e.do("GET", "/api/agent/threads/"+tid+"?before=nope", nil, bearer(a)); code != 400 {
		t.Fatalf("bad cursor: %d", code)
	}
	if code, _, _ := e.do("GET", "/api/agent/threads/nope", nil, bearer(a)); code != 404 {
		t.Fatalf("missing: %d", code)
	}
}

func TestAgentReadThreadByteCaps(t *testing.T) {
	e := newEnv(t)
	a := e.createSession()
	tid := e.send(a, "", "Big", strings.Repeat("é", 10000), "working") // 20000 bytes
	for i := 0; i < 9; i++ {
		tid = e.send(a, tid, "Big", strings.Repeat("y", 7000), "working")
	}
	_, th, _ := e.do("GET", "/api/agent/threads/"+tid, nil, bearer(a))
	msgs := rows(t, th, "messages")
	total := 0
	for _, m := range msgs {
		total += len(m["body"].(string))
	}
	if total > agentReadBytes+200 {
		t.Fatalf("bodies together: %d bytes", total)
	}
	// 60000 / 7000: the oldest messages fall off the page, the newest stay.
	if len(msgs) >= 10 || th["has_more"] != true || th["next_before"] != msgs[0]["id"] {
		t.Fatalf("total cap: %d msgs, %v", len(msgs), th["has_more"])
	}
	// Following the cursor reaches the big first message, cut with a marker and valid UTF-8.
	_, first, _ := e.do("GET", "/api/agent/threads/"+tid+"?before="+th["next_before"].(string)+"&limit=1", nil, bearer(a))
	for first["has_more"] == true {
		_, first, _ = e.do("GET", "/api/agent/threads/"+tid+"?before="+first["next_before"].(string)+"&limit=1", nil, bearer(a))
	}
	m := rows(t, first, "messages")[0]
	body := m["body"].(string)
	if m["truncated"] != true || !strings.Contains(body, "[message cut:") || len(body) > agentMsgBytes+60 || m["body_bytes"].(float64) != 20000 {
		t.Fatalf("per-message cap: truncated=%v len=%d", m["truncated"], len(body))
	}
	raw, _ := json.Marshal(first)
	if !json.Valid(raw) || strings.Contains(string(raw), "�") {
		t.Fatalf("cut inside a rune")
	}
}

func TestAgentSearch(t *testing.T) {
	e := newEnv(t)
	a := e.createSession()
	b := e.sessionIn("other", "b")
	e.send(a, "", "Pelican plan", "the zeppelin is late", "working")
	e.send(b, "", "Other", "zeppelin in the other project", "working")

	_, res, _ := e.do("GET", "/api/agent/search?q=zeppelin", nil, bearer(b))
	if len(rows(t, res, "messages")) != 2 {
		t.Fatalf("all: %v", res)
	}
	_, res, _ = e.do("GET", "/api/agent/search?q=zeppelin&session_id=self", nil, bearer(b))
	if got := rows(t, res, "messages"); len(got) != 1 || got[0]["session_id"] != b.ID {
		t.Fatalf("self: %v", res)
	}
	_, res, _ = e.do("GET", "/api/agent/search?q=zeppelin&project_id="+a.ProjectID, nil, bearer(b))
	if got := rows(t, res, "messages"); len(got) != 1 || got[0]["session_id"] != a.ID {
		t.Fatalf("project: %v", res)
	}
	_, res, _ = e.do("GET", "/api/agent/search?q=pelican", nil, bearer(b))
	if len(rows(t, res, "threads")) != 1 {
		t.Fatalf("threads: %v", res)
	}
	_, res, _ = e.do("GET", "/api/agent/search?q=zeppelin&limit=1", nil, bearer(b))
	if len(rows(t, res, "messages")) != 1 {
		t.Fatalf("limit: %v", res)
	}
	if code, _, _ := e.do("GET", "/api/agent/search?q=", nil, bearer(a)); code != 400 {
		t.Fatalf("empty q: %d", code)
	}
	if code, _, _ := e.do("GET", "/api/agent/search?q=a&from=x", nil, bearer(a)); code != 400 {
		t.Fatalf("bad from: %d", code)
	}
}

func TestAgentReadAPILeaksNoSecrets(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	a := e.createSession()
	e.send(a, "", "Secrets", "hello", "working")
	// Settings and notification destinations that must never show up.
	_ = e.st.PutSettings(ctx, map[string]json.RawMessage{"public_url": json.RawMessage(`"https://secret-host.example"`), "prompt_extra": json.RawMessage(`"TOPSECRETEXTRA"`)})
	e.do("POST", "/api/notifications", map[string]any{"kind": "webhook", "name": "n", "url": "https://hooks.example/SECRETHOOK"}, nil)
	for _, p := range []string{"/api/agent/projects", "/api/agent/projects/" + a.ProjectID, "/api/agent/sessions", "/api/agent/inbox", "/api/agent/search?q=hello", "/api/agent/threads"} {
		_, obj, arr := e.do("GET", p, nil, bearer(a))
		var raw []byte
		if obj != nil {
			raw, _ = json.Marshal(obj)
		} else {
			raw, _ = json.Marshal(arr)
		}
		s := string(raw)
		for _, bad := range []string{a.Token, "SECRETHOOK", "secret-host", "TOPSECRETEXTRA", `"token"`, "claude_session_id", `"icon"`} {
			if strings.Contains(s, bad) {
				t.Errorf("%s leaks %q: %s", p, bad, s)
			}
		}
	}
	// A thread read carries messages and attachment paths of the thread only.
	tid := ""
	_, th, _ := e.do("GET", "/api/agent/inbox", nil, bearer(a))
	tid = rows(t, th, "threads")[0]["id"].(string)
	_, one, _ := e.do("GET", "/api/agent/threads/"+tid, nil, bearer(a))
	raw, _ := json.Marshal(one)
	for _, bad := range []string{a.Token, "claude_session_id", "annotations", "claimed_at"} {
		if strings.Contains(string(raw), bad) {
			t.Errorf("thread read leaks %q: %s", bad, raw)
		}
	}
}
