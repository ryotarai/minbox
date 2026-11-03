package server

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestAttachmentsAndReview(t *testing.T) {
	e := newEnv(t)
	sess := e.createSession()
	repo := e.dir
	run := func(args ...string) {
		cmd := exec.Command("git", append([]string{"-C", repo}, args...)...)
		cmd.Env = append(os.Environ(), "GIT_AUTHOR_NAME=t", "GIT_AUTHOR_EMAIL=t@t", "GIT_COMMITTER_NAME=t", "GIT_COMMITTER_EMAIL=t@t")
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v %s", args, err, out)
		}
	}
	run("init", "-q")
	_ = os.WriteFile(filepath.Join(repo, "a.go"), []byte("package a\n"), 0o644)
	run("add", "a.go")
	run("commit", "-qm", "init")
	_ = os.WriteFile(filepath.Join(repo, "a.go"), []byte("package a\n\nfunc A() {}\n"), 0o644)
	_ = os.WriteFile(filepath.Join(repo, "new.go"), []byte("package a\nvar X = 1\n"), 0o644)
	_ = os.WriteFile(filepath.Join(repo, "plan.md"), []byte("# Plan\n"), 0o644)

	code, sent, _ := e.do("POST", "/api/agent/messages", map[string]any{
		"body": "see the plan", "subject": "Plan", "name": "plan-tag",
		"attachments": []string{"plan.md"},
		"review":      map[string]any{"title": "Review", "summary": "s", "sections": []any{map[string]any{"title": "one", "files": []string{"a.go", "new.go"}}}},
	}, bearer(sess))
	if code != 201 {
		t.Fatalf("send: %d %v", code, sent)
	}
	list := sent["attachments"].([]any)
	if len(list) != 2 {
		t.Fatalf("attachments = %v", list)
	}
	ids := []any{}
	for _, x := range list {
		ids = append(ids, x.(map[string]any)["id"])
	}
	if a0 := list[0].(map[string]any); a0["kind"] != "markdown" || a0["name"] != "plan.md" {
		t.Fatalf("attachment result = %v", a0)
	}
	_, th, _ := e.do("GET", "/api/threads/"+sent["thread_id"].(string), nil, nil)
	if th["name"] != "plan-tag" || th["attachment_count"].(float64) != 2 {
		t.Fatalf("thread = %v", th)
	}
	_, att, _ := e.do("GET", "/api/attachments/"+ids[0].(string), nil, nil)
	if att["text_sent"] != "# Plan\n" || att["changed"] != false || att["mime"] != "text/markdown" || att["type"] != "markdown" {
		t.Fatalf("att = %v", att)
	}
	_ = os.WriteFile(filepath.Join(repo, "plan.md"), []byte("# Plan v2\n"), 0o644)
	_, att, _ = e.do("GET", "/api/attachments/"+ids[0].(string), nil, nil)
	if att["changed"] != true || att["text_current"] != "# Plan v2\n" {
		t.Fatalf("changed att = %v", att)
	}
	_, rv, _ := e.do("GET", "/api/attachments/"+ids[1].(string), nil, nil)
	review := rv["review"].(map[string]any)
	files := review["sections"].([]any)[0].(map[string]any)["files"].([]any)
	f0, f1 := files[0].(map[string]any), files[1].(map[string]any)
	if !strings.Contains(f0["diff"].(string), "+func A() {}") || f1["additions"].(float64) != 2 || f1["path"] != "new.go" {
		t.Fatalf("review = %v", review)
	}
	if code, _, _ := e.do("POST", "/api/agent/messages", map[string]any{"body": "x", "attachments": []string{"missing.md"}}, bearer(sess)); code != 400 {
		t.Fatalf("missing attachment: %d", code)
	}
}

func TestThreadOpsReplyExtrasAndSearch(t *testing.T) {
	e := newEnv(t)
	sess := e.createSession()
	other := e.createSession()
	_, sent, _ := e.do("POST", "/api/agent/messages", map[string]any{"body": ":::question\nGo?\nStopped: waiting\n- [ ] Yes\n- [ ] No\n:::", "subject": "検索の範囲"}, bearer(sess))
	tid := sent["thread_id"].(string)
	_, th, _ := e.do("GET", "/api/threads/"+tid, nil, nil)
	if th["section"] != "stopped" {
		t.Fatalf("section = %v", th["section"])
	}
	for _, op := range []string{"mark-read", "unmark-read", "pin", "archive", "unarchive", "unpin"} {
		if code, obj, _ := e.do("POST", "/api/threads/"+tid+"/"+op, nil, nil); code != 200 {
			t.Fatalf("%s: %d %v", op, code, obj)
		}
	}
	if code, _, _ := e.do("POST", "/api/threads/"+tid+"/snooze", map[string]any{"until": "2999-01-01T00:00:00Z"}, nil); code != 200 {
		t.Fatal("snooze")
	}
	_, th, _ = e.do("GET", "/api/threads/"+tid, nil, nil)
	if th["section"] != "snoozed" {
		t.Fatalf("snoozed section = %v", th["section"])
	}
	if code, _, _ := e.do("PATCH", "/api/threads/"+tid, map[string]any{"name": "scope"}, nil); code != 200 {
		t.Fatal("patch")
	}

	// A reply with annotations, urgent.
	code, msg, _ := e.do("POST", "/api/threads/"+tid+"/reply", map[string]any{"words": "see notes", "urgent": true,
		"annotations": []any{map[string]any{"kind": "comment", "name": "plan.md", "quote": "打ち切り", "line": 3, "comment": "more please"}}}, nil)
	if code != 201 || !strings.Contains(msg["body"].(string), "### 1. (line 3) Feedback on: \"打ち切り\"\n> more please") || msg["urgent"] != true {
		t.Fatalf("reply: %d %v", code, msg)
	}
	_, th, _ = e.do("GET", "/api/threads/"+tid, nil, nil)
	if th["snoozed_until"] != nil {
		t.Fatal("a reply ends a snooze")
	}
	_, _, pending := e.do("GET", "/api/agent/pending?owner=o", nil, bearer(sess))
	if len(pending) != 1 || pending[0].(map[string]any)["urgent"] != true {
		t.Fatalf("pending = %v", pending)
	}

	// Forward to another session.
	code, fw, _ := e.do("POST", "/api/threads/"+tid+"/reply", map[string]any{"words": "do it there", "forward_to": other.ID}, nil)
	if code != 201 || fw["session_id"] != other.ID {
		t.Fatalf("forward: %d %v", code, fw)
	}

	// Reask needs open questions: archive closed none here (unarchived), so it works.
	if code, obj, _ := e.do("POST", "/api/threads/"+tid+"/reask", nil, nil); code != 201 || obj["kind"] != "note" {
		t.Fatalf("reask: %d %v", code, obj)
	}

	_, res, _ := e.do("GET", "/api/search?q="+"検索", nil, nil)
	if len(res["threads"].([]any)) != 2 { // the thread and its forwarded copy
		t.Fatalf("search = %v", res)
	}
	_, res, _ = e.do("GET", "/api/search?q=検索&session_id="+other.ID, nil, nil)
	if len(res["threads"].([]any)) != 1 {
		t.Fatalf("scoped search = %v", res)
	}
}

func TestSessionArchiveSettingsCards(t *testing.T) {
	e := newEnv(t)
	sess := e.createSession()
	if code, _, _ := e.do("POST", "/api/sessions/"+sess.ID+"/archive", nil, nil); code != 409 {
		t.Fatalf("archive running: %d", code)
	}
	e.do("POST", "/api/sessions/"+sess.ID+"/stop", nil, nil)
	_ = e.st.SetSessionEnded(t.Context(), sess.ID, 0)
	if code, _, _ := e.do("POST", "/api/sessions/"+sess.ID+"/archive", nil, nil); code != 200 {
		t.Fatalf("archive: %d", code)
	}
	_, _, list := e.do("GET", "/api/sessions", nil, nil)
	if list[0].(map[string]any)["section"] != "archived" {
		t.Fatalf("sessions = %v", list)
	}
	e.do("POST", "/api/sessions/"+sess.ID+"/restart", nil, nil)
	_, _, list = e.do("GET", "/api/sessions", nil, nil)
	if list[0].(map[string]any)["archived_at"] != nil {
		t.Fatal("restart unarchives")
	}

	_, st, _ := e.do("GET", "/api/settings", nil, nil)
	if st["theme"] != "system" || st["text_size"].(float64) != 13 || st["board"] != false {
		t.Fatalf("defaults = %v", st)
	}
	if code, _, _ := e.do("POST", "/api/agent/cards", map[string]any{"title": "x"}, bearer(sess)); code != 403 {
		t.Fatalf("board off: %d", code)
	}
	_, st, _ = e.do("PUT", "/api/settings", map[string]any{"board": true, "prompt_extra": "be brief"}, nil)
	if st["board"] != true || st["theme"] != "system" {
		t.Fatalf("put = %v", st)
	}
	if code, _, _ := e.do("PUT", "/api/settings", map[string]any{"nope": 1}, nil); code != 400 {
		t.Fatal("unknown setting")
	}
	code, card, _ := e.do("POST", "/api/agent/cards", map[string]any{"title": "Search UI", "column": "designing"}, bearer(sess))
	if code != 201 || card["created_by"] != "agent" || card["session_id"] != sess.ID {
		t.Fatalf("card: %d %v", code, card)
	}
	code, card, _ = e.do("PATCH", "/api/cards/"+card["id"].(string), map[string]any{"column": "shipped", "pr_state": "merged", "pr_number": 205}, nil)
	if code != 200 || card["column"] != "shipped" {
		t.Fatalf("patch card: %d %v", code, card)
	}
	_, hello, _ := e.do("POST", "/api/agent/hello", map[string]any{}, bearer(sess))
	if hello["prompt_extra"] != "be brief" {
		t.Fatalf("hello = %v", hello)
	}
	_, about, _ := e.do("GET", "/api/about", nil, nil)
	if about["version"] != "dev" {
		t.Fatalf("about = %v", about)
	}
	if code, _, _ := e.do("GET", "/api/storage", nil, nil); code != 200 {
		t.Fatal("storage")
	}
	code, up, _ := e.do("POST", "/api/sessions/"+sess.ID+"/files", map[string]any{"x": 1}, map[string]string{"X-Filename": "notes.json"})
	if code != 201 || !strings.HasSuffix(up["path"].(string), "-notes.json") {
		t.Fatalf("files: %d %v", code, up)
	}
	_, comp, _ := e.do("GET", "/api/sessions/"+sess.ID+"/completions", nil, nil)
	if comp["skills"] == nil {
		t.Fatalf("completions = %v", comp)
	}
}
