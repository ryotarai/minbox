package server

import (
	"fmt"
	"regexp"
	"strconv"
	"strings"
)

// The wording the agent reads: tool descriptions, delivered messages, tool results, reminders. It used
// to live in the integrations (plugin/minbox/hooks/text.ts, nav.ts, tasks.ts); since mod protocol 1
// the server owns it and the integrations pass it on verbatim (docs/mod-protocol.md), so a running
// session picks up new wording without a restart. Pure functions; the tests are modtext_test.go.

// ---- loose JSON access (the renderers read the API's answers as the integrations did) ----

type jobj = map[string]any

func jget(v any, key string) any {
	if m, ok := v.(map[string]any); ok {
		return m[key]
	}
	return nil
}

func jstr(v any) string {
	s, _ := v.(string)
	return s
}

func jarr(v any) []any {
	a, _ := v.([]any)
	return a
}

func jnum(v any) (float64, bool) {
	f, ok := v.(float64)
	return f, ok
}

// jtext is a value as JavaScript's template literal writes it (missing: "undefined").
func jtext(v any) string {
	switch t := v.(type) {
	case nil:
		return "undefined"
	case string:
		return t
	case float64:
		return strconv.FormatFloat(t, 'f', -1, 64)
	case bool:
		return strconv.FormatBool(t)
	}
	return fmt.Sprint(v)
}

// truthy is JavaScript's truthiness of a JSON value.
func truthy(v any) bool {
	switch t := v.(type) {
	case nil:
		return false
	case string:
		return t != ""
	case float64:
		return t != 0
	case bool:
		return t
	}
	return true
}

func numOr(v any, def float64) float64 {
	if f, ok := v.(float64); ok {
		return f
	}
	return def
}

func fmtNum(f float64) string { return strconv.FormatFloat(f, 'f', -1, 64) }

func squash(s string) string { return strings.Join(strings.Fields(s), " ") }

// cut is JavaScript's s.slice(0, n) (by characters).
func cut(s string, n int) string {
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return string(r[:n])
}

func plural(n float64, word string) string {
	if n == 1 {
		return fmtNum(n) + " " + word
	}
	return fmtNum(n) + " " + word + "s"
}

// day: an ISO time as "2026-11-10 01:02".
func day(v any) string {
	s, ok := v.(string)
	if !ok {
		return ""
	}
	return strings.Replace(cut(s, 16), "T", " ", 1)
}

// ---- tool names ----

// toolNames are the full names the agent sees for the tools the texts mention.
type toolNames struct{ prefix string }

func (n toolNames) of(tool string) string { return n.prefix + tool }

// localNames rewrites the tool names in a shared description with the prefix (Pi, OpenCode).
var sharedToolWords = regexp.MustCompile(`\b(read_thread|list_threads|send_message|create_task|update_task|list_tasks)\b`)

func localNames(prefix, text string) string {
	return sharedToolWords.ReplaceAllString(text, prefix+"$1")
}

// ---- send_message, read_thread, set_session_title, open_url ----

const (
	toolSend  = "send_message"
	toolRead  = "read_thread"
	toolTitle = "set_session_title"
	toolOpen  = "open_url"
)

var sendDescription = strings.Join([]string{
	"Send a message to the person in minbox: your conversation with them (your stream) is how they hear from you; they may not be watching the terminal.",
	"Use it EVERY time you need their opinion, a decision, an approval or an action from them, and when you finish work they should look at. Ask each decision as a `:::question` block (see `body`).",
	"It does not block: their reply arrives later as a new message in this conversation. Never wait or poll for it, and do not also ask the same thing in the chat.",
	"It reaches the person at once and cannot be taken back: never send placeholder, test or draft text, only the final message. Do not call it in the same parallel batch as a call whose result it needs (e.g. create_task's task id): wait for that result, then send; never guess ids.",
	"Pass `task_id`: the one task this message is about (from create_task / list_tasks, or the task shown with the person's message). Every message belongs to exactly one task; the person's messages it answers that are in no task yet go in the same one, so the person sees the exchange in that task. Without task_id it goes in the task you created in this turn (if you created exactly one), else in the task of the person's message it answers. About two tasks: send one message per task. `task_ids` is the older name (one id).",
	"`thread_id` and `thread_title` are accepted but not needed: every message goes to your one conversation with the person (an older thread_id points the message at that conversation's task).",
	"It has no `status`: a task's status is set with update_task, and a send_message that carries one is refused.",
	"attachments: files to show the person beside your message; link one from the body (`[the mock](mock.html)`) to open it. A guided `review` walks them through your changes.",
}, " ")

var questionGuide = strings.Join([]string{
	"The message, in Markdown. Lead with what you need from the person; they switch in cold, so say what it affects and what you know.",
	"Ask each decision as a block:",
	":::question",
	"The question, on the first line.",
	"One to three short lines of context.",
	"- [ ] Choice A — why",
	"- [ ] Choice B — why",
	"Recommended: Choice A",
	":::",
	"`:::question` picks one, `:::question-multi` any number, `:::question-text` asks for free text.",
	"Optional context lines: `Stopped: <what waits>` when your work is stopped on the answer; `Holds up: a; b` for what it blocks; `Replaces: <earlier question>` when you re-ask.",
	"Ask the person to do things by hand with an `:::actions` block of `- [ ] item` lines; they mark each Done or Can't do it.",
	"Fenced blocks draw as pictures: ```mermaid and ```dot (Graphviz) as diagrams, ```svg (an inline <svg>) as an image, ```html as a sandboxed live page. Use them instead of ASCII art.",
	"The person can also answer Other, add a note, or skip. Ask only what you cannot decide alone.",
	"Answers come back under \"## Answers to your questions\".",
}, "\n")

const attachmentsGuide = "Files to show the person beside your message, e.g. [\"docs/plan.md\", \"/tmp/checkout.png\", \"src/retry.mjs\"]: absolute (anywhere you can read) or relative to the session's folder. " +
	"For something visual, a screenshot or image usually reads fastest; attach the HTML or source too when they should open or click through it. Any regular file, any size. " +
	"Markdown, plain text, config and data files, Mermaid and Graphviz sources and HTML (its relative images and frames load from its folder) open in minbox's viewers; " +
	"images (PNG, JPEG, GIF, WebP, SVG, AVIF, BMP, ICO) show in the message; videos (MP4, MOV, WebM) play beside it, and the person comments at moments (each comment comes back with its time and the paused frame's path); " +
	"source code, scripts and other text open as code with line comments; PDFs and anything else are offered as a download. Folders and .env files are refused. " +
	"The inbox keeps the version you sent and shows the file as it is now, saying when it changed. " +
	"The person's annotations, including comments on images and code lines, come back in their reply. " +
	"Each attachment's kind in the result is markdown, text, html, mermaid, graphviz, code, image, video, pdf or file; treat any other as file. " +
	"A markdown link to an attached file in the body, e.g. [the mock](proto/admin.html), opens it beside the thread."

func sendSchema() jobj {
	return jobj{
		"type": "object",
		"properties": jobj{
			"body": jobj{"type": "string", "description": questionGuide},
			"task_id": jobj{
				"type":        "string",
				"description": "The one task this message is about (an id from create_task or list_tasks, or shown with the person's message). The person's messages this reply answers that are in no task yet go in it too.",
			},
			"task_ids": jobj{
				"type":        "array",
				"items":       jobj{"type": "string"},
				"description": "Legacy: the older name of task_id, as a list of one id.",
			},
			"thread_id": jobj{
				"type":        "string",
				"description": "Legacy, not needed: the id of an older thread; the message goes to your conversation with the person, about that thread's task.",
			},
			"thread_title": jobj{"type": "string", "description": "Legacy, not needed (ignored)."},
			"attachments": jobj{
				"type":        "array",
				"items":       jobj{"type": "string"},
				"description": attachmentsGuide,
			},
			"review": jobj{
				"type":        "object",
				"description": "A guided review of your changes: minbox snapshots each file's diff, in the git repository or worktree that holds the file. Lead with the section the person should look at most. Working in a worktree or on a branch whose changes are committed: set cwd to the worktree and base to the branch you started from (e.g. main), or the review shows only uncommitted changes.",
				"properties": jobj{
					"title":   jobj{"type": "string"},
					"cwd":     jobj{"type": "string", "description": "Where relative file paths resolve, e.g. the git worktree you work in (absolute, or relative to the session directory). Default: the session directory."},
					"base":    jobj{"type": "string", "description": "A branch or commit to diff from (from where your HEAD left it), so committed changes show as well as uncommitted ones, e.g. \"main\". Default: HEAD (uncommitted changes only)."},
					"summary": jobj{"type": "string", "description": "What changed and why, in two or three sentences."},
					"sections": jobj{
						"type": "array",
						"items": jobj{
							"type": "object",
							"properties": jobj{
								"title":   jobj{"type": "string"},
								"summary": jobj{"type": "string"},
								"files":   jobj{"type": "array", "items": jobj{"type": "string"}},
							},
							"required": []string{"title", "files"},
						},
					},
				},
				"required": []string{"title", "sections"},
			},
		},
		"required":             []string{"body"},
		"additionalProperties": false,
	}
}

var readDescription = strings.Join([]string{
	"Read the person's minbox inbox.",
	"With `thread_id` (the id every reply from the person carries, or one from list_threads / search): that thread's messages and the answers given. Any thread can be read, also one of another session (read-only).",
	"It returns the newest `limit` messages (default 30, at most 100), oldest first, and says how many exist; pass `before` (the message id the answer names) to page back to older ones. Long messages are cut and the whole answer is bounded, with a marker where text is missing.",
	"Without `thread_id`: the list of this session's threads (use list_threads for other sessions and filters).",
}, " ")

func readSchema() jobj {
	return jobj{
		"type": "object",
		"properties": jobj{
			"thread_id": jobj{"type": "string", "description": "The thread to read. Leave out to list this session's threads."},
			"limit":     jobj{"type": "number", "description": "Most messages to return: the newest ones (default 30, at most 100)."},
			"before":    jobj{"type": "string", "description": "A message id from an earlier answer (\"older messages: before <id>\"): returns the messages before it."},
		},
		"additionalProperties": false,
	}
}

const titleDescription = "Set this session's title in the person's minbox session list: a few words saying what you are working on now (e.g. \"Fix login redirect loop\"). Call it when the work becomes clear and again when it changes; it costs nothing and needs no reply."

func titleSchema() jobj {
	return jobj{
		"type": "object",
		"properties": jobj{
			"title": jobj{"type": "string", "description": "One line, about 3-8 words, about 80 characters or fewer (a guide, not a hard limit); plain text, in the language the person writes in."},
		},
		"required":             []string{"title"},
		"additionalProperties": false,
	}
}

const openDescription = "Open a web page (a PR, an issue, a CI run, docs) in the person's browser, wherever they have minbox open. Use it instead of `open URL`, `xdg-open`, `gh … --web` or `gh browse`: those open the page on the machine Claude runs on, which may not be the person's computer."

func openSchema() jobj {
	return jobj{
		"type": "object",
		"properties": jobj{
			"url": jobj{"type": "string", "description": "An absolute http(s) URL, e.g. https://github.com/owner/repo/pull/12."},
		},
		"required":             []string{"url"},
		"additionalProperties": false,
	}
}

// openerPatterns are JavaScript regular expressions (the integrations test Bash commands with them):
// a command that opens a web page on the host, `open URL` (and its Linux kin) or gh's --web / browse.
// At the start of a command, not an argument (`echo open …`).
var openerPatterns = func() []string {
	start := "(?:^|[;&|(\\x60]|\\$\\()\\s*"
	return []string{
		start + "(?:open|xdg-open|gio\\s+open|sensible-browser|x-www-browser|wslview)\\s+(?:[^;&|\\n]*?[\\s'\"])?['\"]?https?:\\/\\/",
		start + "gh\\s+(?:browse\\b|[^;&|\\n]*\\s(?:--web|-w)(?=[\\s;&|)]|$))",
	}
}()

// openDeny is the refusal of a Bash command that would open a page on the host.
func openDeny(openTool string) string {
	return "minbox: this would open the page on the host machine, not in the person's browser. Call " + openTool + " with the page's URL instead (with gh, get it with e.g. `gh pr view --json url -q .url`)."
}

// pairAcceptPatterns: a command that accepts a pairing (`minbox pair accept <code>`: a browser or a
// server gets to act as the person). Anywhere in the command, quoted or not (`sh -c "minbox pair
// accept …"`, ./bin/minbox, go run ./cmd/minbox): only the person accepts a pairing, in their own
// terminal. A backstop: `minbox pair accept` also asks on an interactive terminal (see cmd/minbox).
var pairAcceptPatterns = []string{
	"(?:^|[^\\w.-])minbox['\"]?\\s+(?:[^;&|\\n]*\\s)?pair\\s+(?:[^;&|\\n]*\\s)?accept\\b",
}

// pairAcceptDeny is the refusal of a command that would accept a pairing.
const pairAcceptDeny = "minbox: accepting a pairing lets a browser or a server act as the person, so only the person does it, in their own terminal (or in Settings › Devices on a paired browser). Do not run `minbox pair accept` yourself, in any form; if the person asked for it, tell them the command to run."

// questionDeny refuses OpenCode's own question tool in the main session.
func questionDeny(sendTool string) string {
	return "minbox: the person follows this session in the minbox inbox and does not see questions in the terminal. Ask with " + sendTool + " (a :::question block) instead."
}

// ---- the person's messages, as the agent receives them ----

const replyLine = "The person replied to you in the minbox inbox. Their reply follows as they wrote it: it is their answer to you."
const newThreadLine = "The person started a new thread with you in the minbox inbox: a request of their own, not an answer to something you asked. It may be unrelated to what you were doing; say how you will handle it before you start."
const streamLine = "Decide which task it is about: an open task (reply with send_message and its task_id; prefer this when one fits), or new work the person asked for (create_task, then reply). Every message must be about a task: a quick question that fits none gets a small task of its own (create_task, status done once answered)."

// wakeJoiner separates the person's messages delivered in one turn.
const wakeJoiner = "\n\n---\n\n"

// wakeTask is one of a delivered message's tasks.
type wakeTask struct {
	ID, Title, Status string
}

// wakeMsg is what the delivered text needs of a pending message.
type wakeMsg struct {
	ID, ThreadID, Subject, Body, Kind string
	NewThread, Stream                 bool
	Tasks                             []wakeTask
}

func readHint(threadID, readTool string) string {
	return "(Thread " + threadID + ". Earlier messages in this thread: call " + readTool + " with this thread_id.)"
}

// tasksLine names the task the person's message is about (a message belongs to one task).
func tasksLine(p wakeMsg) string {
	if len(p.Tasks) == 0 {
		return ""
	}
	t := p.Tasks[0]
	st := ""
	if t.Status != "" && t.Status != "working" {
		st = " (" + t.Status + ")"
	}
	return "Task: " + t.ID + " \"" + squash(t.Title) + "\"" + st
}

// doneTaskLine: the person wrote about a done task, which stays done unless the agent reopens it.
func doneTaskLine(updateTool string) string {
	return "The task is done: reopen it with " + updateTool + " status working only if their message asks for more work (a remark or a quick question leaves it done)."
}

// wakeText is the turn text of one of the person's messages.
func wakeText(p wakeMsg, sendTool, readTool string) string {
	if p.Stream {
		// A goal's run ("continue") and minbox's request to place messages in tasks ("place", v3place.go)
		// are minbox's own words: as they are.
		if p.Kind == "continue" || p.Kind == "place" {
			return strings.TrimSpace(p.Body)
		}
		tl := tasksLine(p)
		dot := "."
		if tl != "" {
			dot = ""
		}
		lines := []string{"minbox: a message from the person (message " + p.ID + ")" + dot}
		if tl != "" {
			lines = append(lines, tl+" (they wrote it about this task; reply with its task_id).")
			if p.Tasks[0].Status == "done" {
				lines = append(lines, doneTaskLine(strings.TrimSuffix(sendTool, toolSend)+"update_task"))
			}
		} else {
			lines = append(lines, streamLine)
		}
		lines = append(lines, "Answer it with "+sendTool+", even briefly: text only in the terminal is not shown to them.", "", strings.TrimSpace(p.Body))
		return strings.Join(lines, "\n")
	}
	subject := squash(p.Subject)
	if subject == "" {
		subject = "a reply"
	}
	kind := replyLine
	if p.NewThread {
		kind = newThreadLine
	}
	return strings.Join([]string{
		"minbox inbox: " + subject + " (thread_id: " + p.ThreadID + ")",
		kind,
		"IMPORTANT: answer this message in the inbox, in this thread: call " + sendTool + " with thread_id " + p.ThreadID + ", even for a short answer. Text you only write in the terminal is not shown to the person.",
		"",
		strings.TrimSpace(p.Body),
		"",
		readHint(p.ThreadID, readTool),
	}, "\n")
}

// ---- nudges and reminders ----

var asksTail = regexp.MustCompile(`[?？]\s*[*_` + "`" + `)）」]*\s*$`)
var asksWords = regexp.MustCompile(`(?i)(どうしますか|いかがですか|よろしいですか|しますか|ますか。|ご確認|確認してください|教えてください|選んでください|決めてください|お知らせください|お願いします|指示をください|ご判断|\bshould I\b|\bwould you like\b|\bdo you want\b|\blet me know\b|\bplease (?:confirm|review|check|choose|decide|run|approve|test|try)\b|\bwhich (?:one|option|approach)\b|\byour call\b)`)
var (
	fencedCode = regexp.MustCompile("(?s)```.*?```")
	inlineCode = regexp.MustCompile("`[^`\\n]*`")
	urlRe      = regexp.MustCompile(`https?://\S+`)
)

// asksPerson: the turn's last words ask the person something (a question, or a request for their
// decision or action), read from the answer's end.
func asksPerson(answer string) bool {
	prose := fencedCode.ReplaceAllString(answer, " ")
	prose = inlineCode.ReplaceAllString(prose, " ")
	prose = urlRe.ReplaceAllString(prose, " ")
	tail := strings.TrimSpace(prose)
	if r := []rune(tail); len(r) > 400 {
		tail = string(r[len(r)-400:])
	}
	if tail == "" {
		return false
	}
	if asksTail.MatchString(tail) {
		return true
	}
	lines := strings.Split(tail, "\n")
	if len(lines) > 4 {
		lines = lines[len(lines)-4:]
	}
	last := strings.Join(lines, "\n")
	if strings.ContainsAny(last, "?？") {
		return true
	}
	return asksWords.MatchString(last)
}

// replyNudgeText: the turn handled the person's message but never replied with send_message.
func replyNudgeText(sendTool string) string {
	return strings.Join([]string{
		"minbox: the last turn handled a message from the person, but nothing was sent back with " + sendTool + ", and they cannot see the terminal.",
		"Reply now with " + sendTool + ": the answer, or a short summary of what you did. Do not repeat the long text here; after sending, end your turn.",
	}, " ")
}

// nudgeText: the last reply asked the person in the chat, not in the inbox.
func nudgeText(sendTool string) string {
	return strings.Join([]string{
		"minbox: your last reply asks the person for something (an opinion, a decision or an action) in the chat only, and they follow this session through the inbox.",
		"Send it now with " + sendTool + ": what you need, with enough context to answer cold, each decision as a :::question block. Do not repeat the chat reply here; after sending, end your turn.",
	}, " ")
}

// instructionsText wraps the instructions for a prompt (models forget the first instruction).
func instructionsText(instructions string) string {
	return "minbox: standing instructions (still in force):\n\n" + instructions
}

// fallbackReminderText: the short reminder when there are no instructions.
func fallbackReminderText(sendTool string) string {
	return strings.Join([]string{
		"minbox: the person follows this session through the minbox inbox and may not be watching the terminal.",
		"Whenever you need their opinion, a decision, an approval or an action from them, and when you finish work they should look at, send it with " + sendTool + " (each decision as a :::question block) and keep going; their reply comes back here by itself.",
		"Messages that arrive as \"minbox: a message from the person\" come from minbox: always answer them with " + sendTool + ", never only in the terminal.",
		"Whatever you send with " + sendTool + " reaches the person at once and cannot be taken back: never send placeholder, test or draft text, and do not send it in the same parallel batch as a call whose result it needs (e.g. a task id); wait for that result, never guess ids.",
	}, " ")
}

func threadState(t any) string {
	oq := numOr(jget(t, "open_questions"), 0)
	if oq > 0 {
		s := ""
		if oq > 1 {
			s = "s"
		}
		return fmtNum(oq) + " open question" + s
	}
	if jstr(jget(t, "last_author")) == "user" {
		return "the person wrote last"
	}
	return "you wrote last"
}

// openThreadsText: after a compaction, the threads this session has open ("" for none).
func openThreadsText(threads []any) string {
	var open []any
	for _, t := range threads {
		switch jstr(jget(t, "section")) {
		case "quiet", "archived", "snoozed":
			continue
		}
		open = append(open, t)
		if len(open) == 5 {
			break
		}
	}
	if len(open) == 0 {
		return ""
	}
	lines := []string{"Your open minbox threads (" + strconv.Itoa(len(open)) + "); answer in one with its thread_id:"}
	for _, t := range open {
		lines = append(lines, "- "+jtext(jget(t, "id"))+" \""+squash(jstr(jget(t, "subject")))+"\" · "+threadState(t))
	}
	return strings.Join(lines, "\n")
}

// ---- tool results ----

// sentText is what send_message returns.
func sentText(r any) string {
	qs := jarr(jget(r, "questions"))
	atts := jarr(jget(r, "attachments"))
	tids := jarr(jget(r, "task_ids"))
	asking, files, about := "", "", ""
	if len(qs) > 0 {
		asking = " asking " + plural(float64(len(qs)), "question")
	}
	if len(atts) > 0 {
		files = " with " + plural(float64(len(atts)), "attachment")
	}
	if len(tids) > 0 {
		s := ""
		if len(tids) > 1 {
			s = "s"
		}
		ids := make([]string, len(tids))
		for i, x := range tids {
			ids[i] = jtext(x)
		}
		about = " About task" + s + " " + strings.Join(ids, ", ") + "."
	}
	lines := []string{
		"Sent to the person in minbox" + asking + files + "." + about,
		"The person's reply will arrive by itself as a new message in this conversation. Do not wait or poll for it.",
	}
	if len(qs) > 0 {
		ps := make([]string, len(qs))
		for i, q := range qs {
			ps[i] = "\"" + jtext(jget(q, "prompt")) + "\""
		}
		lines = append(lines, "Questions the inbox shows: "+strings.Join(ps, ", ")+".")
	}
	if len(atts) > 0 {
		ps := make([]string, len(atts))
		for i, a := range atts {
			ps[i] = jtext(jget(a, "name")) + " (" + jtext(jget(a, "kind")) + ")"
		}
		lines = append(lines, "Attached: "+strings.Join(ps, ", ")+".")
	}
	notShown := jarr(jget(r, "images_not_shown"))
	if len(notShown) > 10 {
		notShown = notShown[:10]
	}
	for _, n := range notShown {
		if truthy(jget(n, "not_yet")) {
			lines = append(lines, "This image does not exist yet: "+jtext(jget(n, "ref"))+"; it shows once written there.")
		} else {
			lines = append(lines, "The message was sent, but this image will not show: "+jtext(jget(n, "ref"))+" ("+jtext(jget(n, "reason"))+"). Copy the image to a plain folder and link that path, or attach it with attachments.")
		}
	}
	// The messages of the turn still in no task (agentSend's unplacedNote).
	if note := jstr(jget(r, "note")); note != "" {
		lines = append(lines, note)
	}
	return strings.Join(lines, " ")
}

// threadText is read_thread's answer for one thread.
func threadText(t any, readTool string) string {
	lines := []string{"Thread " + jtext(jget(t, "id")) + ": " + jtext(jget(t, "subject"))}
	own, ownSet := jget(t, "own").(bool)
	var meta []string
	if s := jstr(jget(t, "status")); s != "" {
		meta = append(meta, s)
	}
	if p := jstr(jget(t, "project_name")); p != "" {
		meta = append(meta, "project "+p)
	}
	if sn := jstr(jget(t, "session_name")); sn != "" {
		x := "session " + sn
		if ownSet && !own {
			x += " (not yours)"
		}
		meta = append(meta, x)
	}
	if len(meta) > 0 {
		lines = append(lines, strings.Join(meta, " · "))
	}
	msgs := jarr(jget(t, "messages"))
	shown := float64(len(msgs))
	if count, ok := jnum(jget(t, "message_count")); ok && truthy(jget(t, "has_more")) {
		older := count - shown
		if o, ok := jnum(jget(t, "older")); ok {
			older = o
		}
		lines = append(lines, "Showing the newest "+fmtNum(shown)+" of "+fmtNum(count)+" messages; "+fmtNum(older)+" older ones are not shown. For them call "+readTool+" with this thread_id and before \""+jtext(jget(t, "next_before"))+"\".")
	}
	for _, m := range msgs {
		who := "person"
		if jstr(jget(m, "author")) == "agent" {
			who = "you"
			if ownSet && !own {
				who = "agent"
			}
		}
		lines = append(lines, "", "["+who+" · "+jtext(jget(m, "created_at"))+" · "+jtext(jget(m, "id"))+"]", strings.TrimSpace(jstr(jget(m, "body"))))
		for _, a := range jarr(jget(m, "attachments")) {
			if jstr(jget(a, "kind")) == "review" {
				lines = append(lines, "Guided review: "+jtext(jget(a, "name")))
			} else {
				typ := ""
				if ty := jstr(jget(a, "type")); ty != "" {
					typ = " [" + ty + "]"
				}
				lines = append(lines, "Attached: "+jtext(jget(a, "name"))+" ("+jtext(jget(a, "path"))+")"+typ)
			}
		}
		for _, a := range jarr(jget(m, "inline_images")) {
			ref := jget(a, "ref")
			if ref == nil {
				ref = jget(a, "name")
			}
			lines = append(lines, "Image shown: "+jtext(ref)+" ("+jtext(jget(a, "path"))+")")
		}
	}
	if oq := numOr(jget(t, "open_questions"), 0); oq > 0 {
		x := " is"
		if oq > 1 {
			x = "s are"
		}
		lines = append(lines, "", "("+fmtNum(oq)+" question"+x+" still open; the person will answer in the inbox.)")
	}
	return strings.Join(lines, "\n")
}

// threadListText is read_thread's answer without a thread: the session's threads.
func threadListText(threads []any) string {
	if len(threads) == 0 {
		return "No threads in the minbox inbox for this session yet."
	}
	out := make([]string, len(threads))
	for i, t := range threads {
		out[i] = "- " + jtext(jget(t, "id")) + " \"" + jtext(jget(t, "subject")) + "\" · " + threadState(t) + ": " + cut(squash(jstr(jget(t, "last_body"))), 80)
	}
	return strings.Join(out, "\n")
}
