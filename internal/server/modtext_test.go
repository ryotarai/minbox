package server

import (
	"encoding/json"
	"regexp"
	"strings"
	"testing"
)

// The wording the agent reads (modtext.go, modtools_text.go). These were the integrations' own unit
// tests (plugin/minbox/hooks/register.test.ts, plugin/opencode/v3text.test.ts, plugin/pi) before
// mod protocol 1 moved the text to the server.

func js(t *testing.T, s string) any {
	t.Helper()
	var v any
	if err := json.Unmarshal([]byte(s), &v); err != nil {
		t.Fatal(err)
	}
	return v
}

func TestWakeTextOfAThreadReply(t *testing.T) {
	p := wakeMsg{ID: "msg_r1", ThreadID: "thr_1", Subject: "Plan", Body: "Answered 1 question.\n\n## Answers to your questions\n\n### Q1. A or B?\nAnswer: A"}
	got := wakeText(p, "mcp__minbox__send_message", "mcp__minbox__read_thread")
	for _, want := range []string{"minbox inbox: Plan (thread_id: thr_1)", "Answer: A", "mcp__minbox__send_message with thread_id thr_1", replyLine} {
		if !strings.Contains(got, want) {
			t.Errorf("missing %q in\n%s", want, got)
		}
	}
	lines := strings.Split(strings.TrimRight(got, "\n"), "\n")
	if last := lines[len(lines)-1]; last != "(Thread thr_1. Earlier messages in this thread: call mcp__minbox__read_thread with this thread_id.)" {
		t.Fatalf("last line = %q", last)
	}
	p.NewThread, p.Subject = true, " "
	if got := wakeText(p, "s", "r"); !strings.Contains(got, newThreadLine) || !strings.HasPrefix(got, "minbox inbox: a reply (thread_id: thr_1)") {
		t.Fatalf("new thread:\n%s", got)
	}
}

func TestWakeTextOfAStreamMessage(t *testing.T) {
	plain := wakeText(wakeMsg{ID: "m1", ThreadID: "thr_s", Body: "fix the gauge", Stream: true}, "minbox_send_message", "minbox_read_thread")
	if !strings.Contains(plain, "a message from the person (message m1).") || !regexp.MustCompile(`open task .*task_id\b.*new work the person asked for \(create_task`).MatchString(plain) || strings.Contains(plain, "thread_id") {
		t.Fatalf("plain:\n%s", plain)
	}
	if !strings.Contains(plain, "Answer it with minbox_send_message, even briefly") || !strings.HasSuffix(plain, "\n\nfix the gauge") {
		t.Fatalf("plain:\n%s", plain)
	}
	about := wakeText(wakeMsg{ID: "m2", Body: "status?", Stream: true, Tasks: []wakeTask{{ID: "tsk_2", Title: "Docs\n x", Status: "needs_you"}}}, "s", "r")
	if !strings.Contains(about, `Task: tsk_2 "Docs x" (needs_you) (they wrote it about this task; reply with its task_id).`) || strings.Contains(about, streamLine) || strings.Contains(about, "Tasks:") {
		t.Fatalf("about:\n%s", about)
	}
	cont := wakeText(wakeMsg{ID: "m3", Kind: "continue", Stream: true, Body: " minbox goal (autonomous run, turn 1 of 20): go\n"}, "s", "r")
	if cont != "minbox goal (autonomous run, turn 1 of 20): go" {
		t.Fatalf("continue = %q", cont)
	}
	if !strings.Contains(plain, "Every message must be about a task") || strings.Contains(plain, "nothing that needs a task") {
		t.Fatalf("every message is about a task:\n%s", plain)
	}
	place := wakeText(wakeMsg{ID: "m4", Kind: "place", Stream: true, Body: "minbox: these messages of your conversation with the person are in no task yet.\n"}, "s", "r")
	if place != "minbox: these messages of your conversation with the person are in no task yet." {
		t.Fatalf("place = %q", place)
	}
}

func TestSentText(t *testing.T) {
	text := sentText(js(t, `{"thread_id":"thr_9","new_thread":true,"questions":[{"key":"q-1","prompt":"Go?"}],
		"attachments":[{"id":"att_1","name":"plan.md","kind":"markdown","path":"/w/plan.md"}],
		"images_not_shown":[{"ref":"shots/x.png","reason":"r","not_yet":true},{"ref":"~/.ssh/k.png","reason":"a .env file, or in a hidden folder of the home folder such as ~/.ssh"}]}`))
	for _, want := range []string{
		"Sent to the person in minbox asking 1 question with 1 attachment.",
		"The person's reply will arrive by itself as a new message in this conversation. Do not wait or poll for it.",
		`Questions the inbox shows: "Go?".`,
		"Attached: plan.md (markdown).",
		"This image does not exist yet: shots/x.png; it shows once written there.",
		"The message was sent, but this image will not show: ~/.ssh/k.png (a .env file, or in a hidden folder of the home folder such as ~/.ssh). Copy the image to a plain folder and link that path, or attach it with attachments.",
	} {
		if !strings.Contains(text, want) {
			t.Errorf("missing %q in %s", want, text)
		}
	}
	if got := sentText(js(t, `{"thread_id":"t","task_ids":["tsk_1"]}`)); !strings.HasPrefix(got, "Sent to the person in minbox. About task tsk_1.") {
		t.Fatalf("tasks: %s", got)
	}
	if got := sentText(js(t, `{"thread_id":"t","task_ids":[],"note":"This message is in no task yet."}`)); !strings.HasSuffix(got, " This message is in no task yet.") {
		t.Fatalf("note: %s", got)
	}
	if got := sentText(js(t, `{"task_ids":["a","b"],"questions":[{"prompt":"x"},{"prompt":"y"}]}`)); !strings.HasPrefix(got, "Sent to the person in minbox asking 2 questions. About tasks a, b.") {
		t.Fatalf("plural: %s", got)
	}
	if len(sendDescription) >= 2048 || !strings.Contains(attachmentsGuide, "Folders and .env files are refused.") {
		t.Fatal("descriptions")
	}
}

func TestThreadText(t *testing.T) {
	read := threadText(js(t, `{"id":"thr_9","subject":"S","open_questions":0,"section":"quiet","last_author":"user",
		"messages":[{"id":"m","author":"user","body":"see","created_at":"t","attachments":[{"id":"a","name":"n.png","type":"image","kind":"file","path":"/d/uploads/a/n.png"}]}]}`), "read_thread")
	if !strings.Contains(read, "Attached: n.png (/d/uploads/a/n.png) [image]") || !strings.Contains(read, "[person · t · m]\nsee") {
		t.Fatalf("read:\n%s", read)
	}
	paged := threadText(js(t, `{"id":"thr_5","subject":"Long","status":"working","own":false,"session_name":"other","open_questions":2,"message_count":40,"has_more":true,"older":38,"next_before":"msg_1",
		"messages":[{"id":"msg_1","author":"agent","body":"hello","created_at":"t1","inline_images":[{"name":"x.png","ref":"shots/x.png","path":"/p"}]}]}`), "mcp__minbox__read_thread")
	for _, want := range []string{
		"Thread thr_5: Long\nworking · session other (not yours)",
		"Showing the newest 1 of 40 messages; 38 older ones are not shown.",
		`mcp__minbox__read_thread with this thread_id and before "msg_1"`,
		"[agent · t1 · msg_1]",
		"Image shown: shots/x.png (/p)",
		"(2 questions are still open; the person will answer in the inbox.)",
	} {
		if !strings.Contains(paged, want) {
			t.Errorf("missing %q in\n%s", want, paged)
		}
	}
	if got := threadListText(nil); got != "No threads in the minbox inbox for this session yet." {
		t.Fatal(got)
	}
	list := threadListText(js(t, `[{"id":"thr_1","subject":"Plan","open_questions":1,"last_author":"agent","last_body":"A or B?"},{"id":"thr_2","subject":"X","open_questions":0,"last_author":"user","last_body":"go\n on"}]`).([]any))
	if list != "- thr_1 \"Plan\" · 1 open question: A or B?\n- thr_2 \"X\" · the person wrote last: go on" {
		t.Fatalf("list:\n%s", list)
	}
}

func TestAsksPerson(t *testing.T) {
	for _, a := range []string{"どちらにしますか？", "Ready. Should I push?", "Let me know if you want the other layout.", "確認してください。", "Please review the diff.", "方針A/Bどちらで進めますか。", "Done. マージしてもよろしいですか？"} {
		if !asksPerson(a) {
			t.Errorf("%q should ask", a)
		}
	}
	for _, a := range []string{"Fixed the bug; tests pass.", "Uses `x ? y : z` now.", "Opened https://x.dev/?q=1", "```\nconst a = b ? c : d\n```\nDone.", "All tests pass; the fix is in `a ? b : c`.", ""} {
		if asksPerson(a) {
			t.Errorf("%q should not ask", a)
		}
	}
}

func TestNudgesAndReminders(t *testing.T) {
	if got := replyNudgeText("mcp__minbox__send_message"); !strings.Contains(got, "Reply now with mcp__minbox__send_message") {
		t.Fatal(got)
	}
	if got := nudgeText("mcp__minbox__send_message"); !strings.Contains(got, "Send it now with mcp__minbox__send_message") {
		t.Fatal(got)
	}
	if got := instructionsText("X"); got != "minbox: standing instructions (still in force):\n\nX" {
		t.Fatal(got)
	}
	if got := fallbackReminderText("S"); !strings.Contains(got, "send it with S") || strings.Contains(got, "standing instructions") {
		t.Fatal(got)
	}
	open := openThreadsText(js(t, `[{"id":"thr_1","subject":"Plan","section":"waiting","open_questions":1},{"id":"thr_2","subject":"Q","section":"quiet"}]`).([]any))
	if open != "Your open minbox threads (1); answer in one with its thread_id:\n- thr_1 \"Plan\" · 1 open question" {
		t.Fatal(open)
	}
	if openThreadsText(nil) != "" {
		t.Fatal("empty")
	}
}

func TestOpenDenyNamesTheTool(t *testing.T) {
	if got := openDeny("mcp__minbox__open_url"); !strings.Contains(got, "Call mcp__minbox__open_url with the page's URL") {
		t.Fatal(got)
	}
	// The patterns are JavaScript (they use a lookahead); the integrations' tests run them
	// (plugin/testdata/manifest-*.json, see TestManifestFixtures).
	if len(openerPatterns) != 2 || !strings.Contains(openerPatterns[1], "(?=") {
		t.Fatal(openerPatterns)
	}
}

func TestNavCallsAndText(t *testing.T) {
	c, bad := navCall("list_threads", jobj{"status": "need_action", "awaiting": "person", "query": " plan ", "unread": true, "limit": 7.9})
	if bad != "" || c.Path != "/api/agent/inbox" || c.Query.Encode() != "awaiting=person&limit=7&q=plan&status=need_action&unread=1" {
		t.Fatalf("%+v %q", c, bad)
	}
	if _, bad := navCall("search", jobj{"query": " "}); bad != "query is required." {
		t.Fatal(bad)
	}
	if _, bad := navCall("get_project", jobj{}); bad != "project_id is required." {
		t.Fatal(bad)
	}
	if c, _ := navCall("search", jobj{"query": "x", "from": "person"}); c.Query.Get("from") != "user" {
		t.Fatal(c.Query)
	}
	threads := navText("list_threads", js(t, `{"threads":[{"id":"thr_9","subject":"Plan","status":"need_action","project_name":"minbox","session_name":"s","open_questions":0,"unread":0,"message_count":2,"last_author":"user","updated_at":"2026-11-10T01:02:03Z","last_body":"go"}],"total":3}`))
	if threads != "- thr_9 \"Plan\" · need_action · minbox / s · 2 messages, the person wrote last 2026-11-10 01:02: go\n\n(1 of 3 threads shown; narrow the filters or raise limit.)" {
		t.Fatalf("threads:\n%s", threads)
	}
	proj := navText("get_project", js(t, `{"id":"prj_1","name":"minbox","dir":"/w","host_name":"mac","default_agent":"claude","session_count":1,"live_sessions":1,"thread_count":2,"need_action":1,"unread":0,
		"sessions":[{"id":"ses_1","name":"s","title":"Fix it","agent":"claude","status":"idle","self":true,"cwd":"/w","waiting":2}]}`))
	if proj != "- prj_1 \"minbox\" · /w on mac · default agent claude · 1 session (1 live) · 2 threads, 1 waiting on the person, 0 unread\nSessions:\n- ses_1 \"s\" (Fix it) · claude idle (this session) · /w · 2 waiting" {
		t.Fatalf("project:\n%s", proj)
	}
	search := navText("search", js(t, `{"threads":[],"messages":[{"thread_id":"thr_1","subject":"A","session_name":"s","author":"user","created_at":"2026-11-10T01:02:03Z","snippet":"hello\nthere"}],"files":[{"thread_id":"thr_2","subject":"B","session_id":"ses_2","name":"a.md","archived":true,"created_at":"2026-11-11T00:00:00Z","snippet":"x"}]}`))
	if search != "Messages:\n- thread thr_1 \"A\" (session s) · person 2026-11-10 01:02: hello there\nFiles:\n- thread thr_2 \"B\" (session ses_2, archived) file a.md · 2026-11-11 00:00: x" {
		t.Fatalf("search:\n%s", search)
	}
	for tool, want := range map[string]string{"list_projects": "No projects.", "list_sessions": "No sessions match.", "list_threads": "No threads match.", "search": "No matches."} {
		if got := navText(tool, jobj{}); got != want {
			t.Errorf("%s: %q", tool, got)
		}
	}
}

func TestTaskCallsAndText(t *testing.T) {
	if _, bad := taskCall("create_task", jobj{"title": " "}); bad != "title is required: a short name for the work." {
		t.Fatal(bad)
	}
	if _, bad := taskCall("update_task", jobj{}); bad != "task_id is required (from create_task or list_tasks)." {
		t.Fatal(bad)
	}
	if _, bad := taskCall("update_task", jobj{"task_id": "t"}); !strings.HasPrefix(bad, "nothing to update") {
		t.Fatal(bad)
	}
	c, _ := taskCall("update_task", jobj{"task_id": "tsk_1", "check_steps": []any{1.0, 2.7, "x"}, "steps": []any{jobj{"text": "a", "steps": []any{jobj{"text": "b", "done": true}}}, "bad"}, "summary": ""})
	b, _ := json.Marshal(c.Body)
	if c.Method != "PATCH" || c.Path != "/api/agent/tasks/tsk_1" || string(b) != `{"check_steps":[1,2],"steps":[{"done":false,"steps":[{"done":true,"text":"b"}],"text":"a"}],"summary":""}` {
		t.Fatalf("%+v %s", c, b)
	}
	if c, _ := taskCall("list_tasks", jobj{"all": true}); c.Query.Encode() != "all=1" {
		t.Fatal(c.Query)
	}
	created := taskText("create_task", js(t, `{"task_id":"n","tagged_messages":["m1"],"task":{"id":"n","status":"working","title":"Fix PDF"},"note":"An open task looks like the same work.","similar_tasks":[{"id":"o","title":"PDF attachments","status":"needs_you"}]}`))
	if !strings.HasPrefix(created, "Task created (task_id n). The person's message of this turn went in it; your reply goes in it too unless it names another task (task_id). Keep it current with update_task.\nAn open task looks like the same work. Similar open tasks: o \"PDF attachments\" (needs_you). If one is the same work, keep using it") {
		t.Fatalf("created:\n%s", created)
	}
	goal := taskText("update_task", js(t, `{"task":{"id":"g","kind":"goal","status":"working","title":"Green CI","manual_status":"blocked","auto":{"state":"running"},"summary":"almost",
		"steps":[{"text":"a","done":true,"steps":[{"text":"b"}]}],"criteria":[{"text":"CI green","done":false}]}}`))
	want := "Goal updated.\n- goal g [working] (the person set it to blocked by hand) [autonomous run on] Green CI — almost\n  1. [x] a\n    2. [ ] b\n  Done when:\n  c1. [ ] CI green"
	if goal != want {
		t.Fatalf("goal:\n%s\nwant:\n%s", goal, want)
	}
	list := taskText("list_tasks", js(t, `{"threads":[{"tasks":[{"id":"tpc_1","status":"waiting_on_you","title":"Index","parent_id":"g"}]}]}`))
	if list != "- tpc_1 [waiting_on_you] Index (serves goal g)" {
		t.Fatal(list)
	}
	if taskText("list_tasks", jobj{}) != "No tasks yet." {
		t.Fatal("empty")
	}
}
