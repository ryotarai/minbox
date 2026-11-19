package server

import (
	"math"
	"net/url"
	"strconv"
	"strings"
)

// The task tools (create_task, update_task, list_tasks) and the read-only navigation tools
// (list_projects, get_project, list_sessions, list_threads, search): their descriptions and schemas,
// the API request a call becomes and the text an answer becomes. Ported from the integrations'
// tasks.ts and nav.ts (mod protocol 1, docs/mod-protocol.md).

var navTools = []string{"list_projects", "get_project", "list_sessions", "list_threads", "search"}
var taskTools = []string{"create_task", "update_task", "list_tasks"}

var navDescription = map[string]string{
	"list_projects": "List the person's minbox projects (a project is a folder on a host): id, name, folder, host, default agent, session and thread counts, how many threads wait on the person, last activity. Read-only. Archived projects only with `archived`.",
	"get_project":   "One minbox project by id (from list_projects): its folder, host, default agent, counts and its sessions (id, name, title, agent, status). Read-only.",
	"list_sessions": "List minbox sessions (one coding-agent session each, Claude Code or Pi): id, name, title, folder, agent, status, project, unread and waiting counts. Newest activity first. Filter by `project_id`, `status` or `agent`. Read-only; returns at most `limit` rows and says how many exist.",
	"list_threads":  "List minbox threads across ALL sessions and projects (read_thread without an id lists only this session's), newest first: id, subject, project, session, status, unread and open-question counts, who wrote last, the start of the last message. Filters: `project_id`, `session_id` (\"self\" = this session), `status`, `awaiting` (person = waits on the person, agent = the person wrote last), `unread`, `query` (words in the subject or last message), `archived`. Read a thread with read_thread. Read-only; returns at most `limit` rows and says how many exist.",
	"search":        "Full-text search of minbox: thread titles, message bodies of the agent and of the person, and attachment names/text. Returns hits with thread id, session, a snippet and the date; open one with read_thread. Narrow it with `project_id`, `session_id` (\"self\" = this session) or `from` (agent | person). Read-only.",
}

func navSchema(tool string) jobj {
	switch tool {
	case "list_projects":
		return jobj{"type": "object", "properties": jobj{"archived": jobj{"type": "boolean", "description": "List archived projects instead of live ones."}}, "additionalProperties": false}
	case "get_project":
		return jobj{"type": "object", "properties": jobj{"project_id": jobj{"type": "string", "description": "A project id from list_projects."}}, "required": []string{"project_id"}, "additionalProperties": false}
	case "list_sessions":
		return jobj{"type": "object", "properties": jobj{
			"project_id": jobj{"type": "string"},
			"status":     jobj{"type": "string", "enum": []string{"starting", "working", "idle", "ended"}, "description": "The session's state."},
			"agent":      jobj{"type": "string", "enum": []string{"claude", "pi"}},
			"archived":   jobj{"type": "boolean", "description": "List archived sessions instead of live ones."},
			"limit":      jobj{"type": "number", "description": "Most rows (default 50, at most 200)."},
		}, "additionalProperties": false}
	case "list_threads":
		return jobj{"type": "object", "properties": jobj{
			"project_id": jobj{"type": "string"},
			"session_id": jobj{"type": "string", "description": "A session id, or \"self\" for this session."},
			"status":     jobj{"type": "string", "enum": []string{"working", "need_action", "blocked", "finished"}, "description": "The thread's status."},
			"awaiting":   jobj{"type": "string", "enum": []string{"person", "agent"}, "description": "person: waits on the person (need_action or open questions); agent: the person wrote last and waits on the agent."},
			"unread":     jobj{"type": "boolean", "description": "Only threads with unread agent messages."},
			"query":      jobj{"type": "string", "description": "Words that must all appear in the subject, name or last message (case-insensitive). For full text use search."},
			"archived":   jobj{"type": "boolean", "description": "List archived threads instead of live ones."},
			"limit":      jobj{"type": "number", "description": "Most rows (default 50, at most 200)."},
		}, "additionalProperties": false}
	case "search":
		return jobj{"type": "object", "properties": jobj{
			"query":      jobj{"type": "string", "description": "Words that must all appear (case-insensitive)."},
			"project_id": jobj{"type": "string"},
			"session_id": jobj{"type": "string", "description": "A session id, or \"self\" for this session."},
			"from":       jobj{"type": "string", "enum": []string{"agent", "person"}, "description": "Only messages written by the agent or by the person."},
			"limit":      jobj{"type": "number", "description": "Most hits per kind (default 20, at most 50)."},
		}, "required": []string{"query"}, "additionalProperties": false}
	}
	return nil
}

// apiCall is the API request a tool call becomes.
type apiCall struct {
	Method, Path string
	Query        url.Values
	Body         jobj
}

func argStr(e jobj, k string) string {
	s, _ := e[k].(string)
	return strings.TrimSpace(s)
}

func argLimit(e jobj, q url.Values) {
	if f, ok := e["limit"].(float64); ok && f > 0 {
		q.Set("limit", strconv.Itoa(int(math.Floor(f))))
	}
}

// navCall is the API request of a navigation tool's call, or an error for the agent.
func navCall(tool string, e jobj) (apiCall, string) {
	q := url.Values{}
	str := func(k, as string) {
		if v := argStr(e, k); v != "" {
			q.Set(as, v)
		}
	}
	flag := func(k string) {
		if e[k] == true {
			q.Set(k, "1")
		}
	}
	switch tool {
	case "list_projects":
		flag("archived")
		return apiCall{Method: "GET", Path: "/api/agent/projects", Query: q}, ""
	case "get_project":
		id := argStr(e, "project_id")
		if id == "" {
			return apiCall{}, "project_id is required."
		}
		return apiCall{Method: "GET", Path: "/api/agent/projects/" + id}, ""
	case "list_sessions":
		str("project_id", "project_id")
		str("status", "status")
		str("agent", "agent")
		flag("archived")
		argLimit(e, q)
		return apiCall{Method: "GET", Path: "/api/agent/sessions", Query: q}, ""
	case "list_threads":
		str("project_id", "project_id")
		str("session_id", "session_id")
		str("status", "status")
		str("awaiting", "awaiting")
		flag("unread")
		str("query", "q")
		flag("archived")
		argLimit(e, q)
		return apiCall{Method: "GET", Path: "/api/agent/inbox", Query: q}, ""
	case "search":
		if argStr(e, "query") == "" {
			return apiCall{}, "query is required."
		}
		str("query", "q")
		str("project_id", "project_id")
		str("session_id", "session_id")
		switch e["from"] {
		case "agent":
			q.Set("from", "agent")
		case "person", "user":
			q.Set("from", "user")
		}
		argLimit(e, q)
		return apiCall{Method: "GET", Path: "/api/agent/search", Query: q}, ""
	}
	return apiCall{}, "unknown tool " + tool
}

func more(shown int, total any, what string) []string {
	if t, ok := total.(float64); ok && t > float64(shown) {
		return []string{"", "(" + strconv.Itoa(shown) + " of " + fmtNum(t) + " " + what + " shown; narrow the filters or raise limit.)"}
	}
	return nil
}

func joinNonEmpty(parts []string, sep string) string {
	var out []string
	for _, p := range parts {
		if p != "" {
			out = append(out, p)
		}
	}
	return strings.Join(out, sep)
}

// navText is what a navigation tool returns.
func navText(tool string, v any) string {
	switch tool {
	case "list_projects":
		ps := jarr(v)
		if len(ps) == 0 {
			return "No projects."
		}
		out := make([]string, len(ps))
		for i, p := range ps {
			out[i] = projectLine(p)
		}
		return strings.Join(out, "\n")
	case "get_project":
		lines := []string{projectLine(v)}
		if ses := jarr(jget(v, "sessions")); len(ses) > 0 {
			lines = append(lines, "Sessions:")
			for _, s := range ses {
				lines = append(lines, sessionLine(s))
			}
		}
		return strings.Join(lines, "\n")
	case "list_sessions":
		ss := jarr(jget(v, "sessions"))
		if len(ss) == 0 {
			return "No sessions match."
		}
		var out []string
		for _, s := range ss {
			out = append(out, sessionLine(s))
		}
		return strings.Join(append(out, more(len(ss), jget(v, "total"), "sessions")...), "\n")
	case "list_threads":
		ts := jarr(jget(v, "threads"))
		if len(ts) == 0 {
			return "No threads match."
		}
		var out []string
		for _, t := range ts {
			out = append(out, navThreadLine(t))
		}
		return strings.Join(append(out, more(len(ts), jget(v, "total"), "threads")...), "\n")
	case "search":
		kinds := []struct {
			label string
			hits  []any
		}{{"Threads", jarr(jget(v, "threads"))}, {"Messages", jarr(jget(v, "messages"))}, {"Files", jarr(jget(v, "files"))}}
		empty := true
		for _, k := range kinds {
			if len(k.hits) > 0 {
				empty = false
			}
		}
		if empty {
			return "No matches."
		}
		var out []string
		for _, k := range kinds {
			if len(k.hits) == 0 {
				continue
			}
			out = append(out, k.label+":")
			for _, h := range k.hits {
				who := ""
				if a := jget(h, "author"); truthy(a) {
					if jstr(a) == "user" {
						who = " person"
					} else {
						who = " agent"
					}
				}
				file := ""
				if k.label == "Files" {
					name := jget(h, "name")
					if name == nil {
						name = ""
					}
					file = " file " + jtext(name)
				}
				sess := jget(h, "session_name")
				if sess == nil {
					sess = jget(h, "session_id")
				}
				arch := ""
				if truthy(jget(h, "archived")) {
					arch = ", archived"
				}
				out = append(out, "- thread "+jtext(jget(h, "thread_id"))+" \""+squash(jstr(jget(h, "subject")))+"\" (session "+jtext(sess)+arch+")"+file+" ·"+who+" "+day(jget(h, "created_at"))+": "+cut(squash(jstr(jget(h, "snippet"))), 200))
			}
		}
		return strings.Join(out, "\n")
	}
	return ""
}

func projectLine(p any) string {
	dir := jstr(jget(p, "dir"))
	if dir == "" {
		dir = "(no folder)"
	}
	if h := jstr(jget(p, "host_name")); h != "" {
		dir += " on " + h
	}
	agentPart := ""
	if a := jget(p, "default_agent"); truthy(a) {
		agentPart = "default agent " + jtext(a)
	}
	archived := ""
	if truthy(jget(p, "archived")) {
		archived = "archived"
	}
	last := ""
	if l := jget(p, "last_activity"); truthy(l) {
		last = "last " + day(l)
	}
	return joinNonEmpty([]string{
		"- " + jtext(jget(p, "id")) + " \"" + jtext(jget(p, "name")) + "\"",
		dir,
		agentPart,
		plural(numOr(jget(p, "session_count"), 0), "session") + " (" + fmtNum(numOr(jget(p, "live_sessions"), 0)) + " live)",
		plural(numOr(jget(p, "thread_count"), 0), "thread") + ", " + fmtNum(numOr(jget(p, "need_action"), 0)) + " waiting on the person, " + fmtNum(numOr(jget(p, "unread"), 0)) + " unread",
		archived,
		last,
	}, " · ")
}

func sessionLine(s any) string {
	head := "- " + jtext(jget(s, "id")) + " \"" + jtext(jget(s, "name")) + "\""
	if t := jget(s, "title"); truthy(t) {
		head += " (" + squash(jstr(t)) + ")"
	}
	state := jtext(jget(s, "agent")) + " " + jtext(jget(s, "status"))
	if truthy(jget(s, "archived")) {
		state += " archived"
	}
	if truthy(jget(s, "self")) {
		state += " (this session)"
	}
	cwd := jstr(jget(s, "cwd"))
	project, waiting, unread, last := "", "", "", ""
	if p := jget(s, "project_id"); truthy(p) {
		project = "project " + jtext(p)
	}
	if w := jget(s, "waiting"); truthy(w) {
		waiting = jtext(w) + " waiting"
	}
	if u := jget(s, "unread"); truthy(u) {
		unread = jtext(u) + " unread"
	}
	if l := jget(s, "last_activity"); truthy(l) {
		last = "last " + day(l)
	}
	return joinNonEmpty([]string{head, state, cwd, project, waiting, unread, last}, " · ")
}

func navThreadLine(t any) string {
	where := jstr(jget(t, "project_name"))
	if where == "" {
		where = jtext(jget(t, "project_id"))
	}
	sess := jstr(jget(t, "session_name"))
	if sess == "" {
		sess = jtext(jget(t, "session_id"))
	}
	self := ""
	if truthy(jget(t, "self")) {
		self = " (this session)"
	}
	oq := ""
	if n := numOr(jget(t, "open_questions"), 0); n != 0 {
		s := ""
		if n > 1 {
			s = "s"
		}
		oq = fmtNum(n) + " open question" + s
	}
	unread := ""
	if u := jget(t, "unread"); truthy(u) {
		unread = jtext(u) + " unread"
	}
	who := "the agent"
	if jstr(jget(t, "last_author")) == "user" {
		who = "the person"
	}
	status := ""
	if st := jget(t, "status"); truthy(st) {
		status = jtext(st)
	}
	head := joinNonEmpty([]string{
		"- " + jtext(jget(t, "id")) + " \"" + squash(jstr(jget(t, "subject"))) + "\"",
		status,
		where + " / " + sess + self,
		oq,
		unread,
		plural(numOr(jget(t, "message_count"), 0), "message") + ", " + who + " wrote last " + day(jget(t, "updated_at")),
	}, " · ")
	return head + ": " + cut(squash(jstr(jget(t, "last_body"))), 100)
}

// ---- tasks ----

var taskStatuses = []string{"working", "needs_you", "blocked", "done"}

const taskStatusGuide = "working: you are on it (the default). needs_you: you are blocked on the person (a decision, an answer, an action only they can take), also while a question you asked waits on their answer (an open question alone does not put the task in NEEDS YOU). blocked: you wait on something outside them (CI, another session). done: finished, delivered, or dropped."

func stepsSchema() jobj {
	return jobj{
		"type":        "array",
		"description": "The checklist: short imperative steps, in order, each with done (sub-steps nest one level). Replaces the current steps.",
		"items": jobj{
			"type": "object",
			"properties": jobj{
				"text":  jobj{"type": "string"},
				"done":  jobj{"type": "boolean"},
				"steps": jobj{"type": "array", "description": "Sub-steps (one level).", "items": jobj{"type": "object", "properties": jobj{"text": jobj{"type": "string"}, "done": jobj{"type": "boolean"}}, "required": []string{"text"}}},
			},
			"required":             []string{"text"},
			"additionalProperties": false,
		},
	}
}

func criteriaSchema() jobj {
	return jobj{
		"type":        "array",
		"description": "A goal's \"done when\" criteria: checkable outcomes (e.g. \"CI is green on the PR\"). Replaces the current ones.",
		"items":       jobj{"type": "object", "properties": jobj{"text": jobj{"type": "string"}, "done": jobj{"type": "boolean"}}, "required": []string{"text"}, "additionalProperties": false},
	}
}

// summaryGuide: a task's summary is the line the person reads under its title in their lists.
const summaryGuide = "One line on where it stands now, shown under the task's title: what is being done now, concretely (the step, the finding), never only who does it or how (\"a subagent is on it\", \"investigating\"). Update it as the work moves."

var taskDescription = map[string]string{
	"create_task": strings.Join([]string{
		"Add a task to the person's minbox Board: the Board is how they follow your work, and only you fill it in.",
		"A task is one distinct piece of work the person asked for (a feature, a bug, an investigation). Create one only for new work: first check the tasks shown with their message (or list_tasks) and keep using an open one that fits. Not for steps inside one piece of work (put those in its `steps`), not for a sub-question or a status check (they go in the task they are about). Every message must be about a task: a quick exchange that fits no task gets a small one, with status done once answered; message_ids moves earlier messages to it (a message belongs to exactly one task).",
		"The person's message that asked for it goes in it by itself, and so does your reply in this turn when it names no other task (send_message task_id).",
		"If the result lists similar_tasks that are the same work, use that task (send_message task_id) and do not create more.",
		"kind \"goal\": an outcome to keep pursuing until its `criteria` are met (\"keep going until CI is green\"); tasks can serve it (goal_id). Set autonomous: true only when the person asked you to keep going on your own: minbox then continues you until the criteria are met.",
		"It returns the task id; keep the task current with update_task. A reply that needs the id waits for this result: do not call send_message in the same parallel batch.",
	}, " "),
	"update_task": strings.Join([]string{
		"Update a task or goal of your project by its task_id (from create_task or list_tasks). Pass only what changed.",
		"Tick steps as you finish them (check_steps: their numbers from 1, in reading order), or replace the checklist with steps. A goal: tick its criteria with check_criteria; when all are met it is done.",
		"Set status needs_you only while you are truly blocked on the person (and ask them with send_message), done when finished or dropped; a done task the person writes about stays done until you set it back to working (only when they ask for more work). Keep summary current: one line on what is being done now, concretely (not who does it or how), updated as the work moves (the person reads it under the task's title). report: a short \"where it stands\" the person reads on the Board, as concrete.",
		"message_ids: earlier messages that are about this task (they move to it: a message belongs to exactly one task).",
		"title: rename it when the work's scope becomes clear or changes, not on every step.",
		"A subagent briefed with a task_id calls it too, as each of its steps finishes: check_steps and summary only.",
	}, " "),
	"list_tasks": "List your tasks and goals on the person's minbox Board (open ones and the ones done this week) with their ids, status, steps and criteria; all: true lists every open task of the project. Use it to find a task's id (e.g. after a compaction) before update_task or send_message task_id.",
}

func taskSchema(tool string) jobj {
	switch tool {
	case "create_task":
		return jobj{"type": "object", "properties": jobj{
			"title":       jobj{"type": "string", "description": "A short name for the work (2 to 8 words), in the person's language."},
			"kind":        jobj{"type": "string", "enum": []string{"task", "goal"}, "description": "task (default) or goal (an outcome pursued until its criteria are met)."},
			"goal_id":     jobj{"type": "string", "description": "The goal this task serves."},
			"summary":     jobj{"type": "string", "description": summaryGuide},
			"detail":      jobj{"type": "string", "description": "Optional: a few sentences (Markdown) on what it is about, what was decided, what is left."},
			"status":      jobj{"type": "string", "enum": taskStatuses, "description": taskStatusGuide},
			"steps":       stepsSchema(),
			"criteria":    criteriaSchema(),
			"autonomous":  jobj{"type": "boolean", "description": "Goals only: minbox keeps continuing you until the criteria are met. Only when the person asked for it."},
			"message_ids": jobj{"type": "array", "items": jobj{"type": "string"}, "description": "Ids of earlier messages about it (the ones of this turn belong to it anyway)."},
		}, "required": []string{"title"}, "additionalProperties": false}
	case "update_task":
		return jobj{"type": "object", "properties": jobj{
			"task_id":        jobj{"type": "string", "description": "The task or goal to update (from create_task or list_tasks)."},
			"title":          jobj{"type": "string", "description": "A new name, when the work's scope has become clear or changed (2 to 8 words, in the person's language). A name the person gave the task is kept."},
			"summary":        jobj{"type": "string", "description": summaryGuide},
			"detail":         jobj{"type": "string", "description": "The fuller summary (Markdown); replaces the current one."},
			"report":         jobj{"type": "string", "description": "The latest report the person reads on the Board: what is done and what is being done, concretely (not who does it or how)."},
			"status":         jobj{"type": "string", "enum": taskStatuses, "description": taskStatusGuide},
			"steps":          stepsSchema(),
			"check_steps":    jobj{"type": "array", "items": jobj{"type": "number"}, "description": "Numbers (from 1, in reading order) of steps that are now done."},
			"uncheck_steps":  jobj{"type": "array", "items": jobj{"type": "number"}, "description": "Numbers (from 1) of steps that are not done after all."},
			"criteria":       criteriaSchema(),
			"check_criteria": jobj{"type": "array", "items": jobj{"type": "number"}, "description": "Numbers (from 1) of a goal's criteria that are now met."},
			"goal_id":        jobj{"type": "string", "description": "The goal this task serves."},
			"message_ids":    jobj{"type": "array", "items": jobj{"type": "string"}, "description": "Ids of more messages that are about this task."},
		}, "required": []string{"task_id"}, "additionalProperties": false}
	case "list_tasks":
		return jobj{"type": "object", "properties": jobj{
			"all": jobj{"type": "boolean", "description": "Every open task of the project, not only yours."},
		}, "additionalProperties": false}
	}
	return nil
}

func argStrs(v any) []any {
	a, ok := v.([]any)
	if !ok {
		return nil
	}
	out := []any{}
	for _, x := range a {
		if s, ok := x.(string); ok && strings.TrimSpace(s) != "" {
			out = append(out, s)
		}
	}
	return out
}

func argNums(v any) []any {
	a, ok := v.([]any)
	if !ok {
		return nil
	}
	out := []any{}
	for _, x := range a {
		if f, ok := x.(float64); ok && !math.IsInf(f, 0) && !math.IsNaN(f) {
			out = append(out, math.Floor(f))
		}
	}
	return out
}

func argSteps(v any) []any {
	a, ok := v.([]any)
	if !ok {
		return nil
	}
	out := []any{}
	for _, s := range a {
		m, ok := s.(map[string]any)
		if !ok {
			continue
		}
		text, ok := m["text"].(string)
		if !ok {
			continue
		}
		step := jobj{"text": text, "done": m["done"] == true}
		if subs, ok := m["steps"].([]any); ok && len(subs) > 0 {
			kids := []any{}
			for _, c := range subs {
				cm, ok := c.(map[string]any)
				if !ok {
					continue
				}
				if ct, ok := cm["text"].(string); ok {
					kids = append(kids, jobj{"text": ct, "done": cm["done"] == true})
				}
			}
			step["steps"] = kids
		}
		out = append(out, step)
	}
	return out
}

// taskFields are the fields of a task call the server takes, unset ones left out.
func taskFields(e jobj) jobj {
	out := jobj{}
	for _, k := range []string{"title", "kind", "goal_id", "status"} {
		if v := argStr(e, k); v != "" {
			out[k] = v
		}
	}
	for _, k := range []string{"summary", "detail", "report"} {
		if v, ok := e[k].(string); ok {
			out[k] = v
		}
	}
	if v := argSteps(e["steps"]); v != nil {
		out["steps"] = v
	}
	if v := argSteps(e["criteria"]); v != nil {
		out["criteria"] = v
	}
	if v, ok := e["autonomous"].(bool); ok {
		out["autonomous"] = v
	}
	if v := argStrs(e["message_ids"]); v != nil {
		out["message_ids"] = v
	}
	return out
}

// taskCall is the API request of a task tool's call, or an error for the agent.
func taskCall(tool string, e jobj) (apiCall, string) {
	switch tool {
	case "create_task":
		if argStr(e, "title") == "" {
			return apiCall{}, "title is required: a short name for the work."
		}
		return apiCall{Method: "POST", Path: "/api/agent/tasks", Body: taskFields(e)}, ""
	case "update_task":
		id := argStr(e, "task_id")
		if id == "" {
			return apiCall{}, "task_id is required (from create_task or list_tasks)."
		}
		body := taskFields(e)
		for _, k := range []string{"check_steps", "uncheck_steps", "check_criteria"} {
			if v := argNums(e[k]); len(v) > 0 {
				body[k] = v
			}
		}
		if len(body) == 0 {
			return apiCall{}, "nothing to update: pass status, report, steps, check_steps, check_criteria, … "
		}
		return apiCall{Method: "PATCH", Path: "/api/agent/tasks/" + id, Body: body}, ""
	case "list_tasks":
		q := url.Values{}
		if e["all"] == true {
			q.Set("all", "1")
		}
		return apiCall{Method: "GET", Path: "/api/agent/tasks", Query: q}, ""
	}
	return apiCall{}, "unknown tool " + tool
}

func squashAny(v any) string {
	s, _ := v.(string)
	return squash(s)
}

// taskLines is a task as the agent reads it back: id, kind, status, title, summary, steps, criteria.
func taskLines(t any) []string {
	manual := ""
	if m := jget(t, "manual_status"); truthy(m) {
		manual = " (the person set it to " + jtext(m) + " by hand)"
	}
	goal := ""
	if jstr(jget(t, "kind")) == "goal" {
		goal = "goal "
	}
	auto := ""
	if jstr(jget(jget(t, "auto"), "state")) == "running" {
		auto = " [autonomous run on]"
	}
	parent := ""
	if p := jget(t, "parent_id"); truthy(p) {
		parent = " (serves goal " + jtext(p) + ")"
	}
	summary := ""
	if s := jget(t, "summary"); truthy(s) {
		summary = " — " + squashAny(s)
	}
	lines := []string{"- " + goal + jtext(jget(t, "id")) + " [" + jtext(jget(t, "status")) + "]" + manual + auto + " " + squashAny(jget(t, "title")) + parent + summary}
	ks := jarr(jget(t, "steps"))
	if _, ok := jget(t, "steps").([]any); !ok {
		ks = jarr(jget(t, "tasks"))
	}
	box := func(v any) string {
		if truthy(jget(v, "done")) {
			return "x"
		}
		return " "
	}
	n := 0
	for _, k := range ks {
		n++
		lines = append(lines, "  "+strconv.Itoa(n)+". ["+box(k)+"] "+squashAny(jget(k, "text")))
		for _, c := range jarr(jget(k, "steps")) {
			n++
			lines = append(lines, "    "+strconv.Itoa(n)+". ["+box(c)+"] "+squashAny(jget(c, "text")))
		}
	}
	if cs := jarr(jget(t, "criteria")); len(cs) > 0 {
		lines = append(lines, "  Done when:")
		for i, c := range cs {
			lines = append(lines, "  c"+strconv.Itoa(i+1)+". ["+box(c)+"] "+squashAny(jget(c, "text")))
		}
	}
	return lines
}

// taskText is what a task tool returns.
func taskText(tool string, v any) string {
	t := jget(v, "task")
	if t == nil {
		t = v
	}
	kind := "Task"
	if jstr(jget(t, "kind")) == "goal" {
		kind = "Goal"
	}
	switch tool {
	case "create_task":
		linked := ""
		if tm := jarr(jget(v, "tagged_messages")); len(tm) > 0 {
			s := ""
			if len(tm) > 1 {
				s = "s"
			}
			linked = " The person's message" + s + " of this turn went in it; your reply goes in it too unless it names another task (task_id)."
		}
		lines := []string{kind + " created (task_id " + jtext(jget(t, "id")) + ")." + linked + " Keep it current with update_task."}
		if sim := jarr(jget(v, "similar_tasks")); len(sim) > 0 {
			note := ""
			if n := jstr(jget(v, "note")); n != "" {
				note = squash(n) + " "
			}
			parts := make([]string, len(sim))
			for i, x := range sim {
				st := ""
				if s := jget(x, "status"); truthy(s) {
					st = " (" + jtext(s) + ")"
				}
				parts[i] = jtext(jget(x, "id")) + " \"" + squashAny(jget(x, "title")) + "\"" + st
			}
			lines = append(lines, note+"Similar open tasks: "+strings.Join(parts, "; ")+". If one is the same work, keep using it (send_message task_id) and do not create more.")
		}
		return strings.Join(append(lines, taskLines(t)...), "\n")
	case "update_task":
		head := []string{kind + " updated."}
		if n := jstr(jget(v, "note")); n != "" {
			head = append(head, squash(n))
		}
		return strings.Join(append(head, taskLines(t)...), "\n")
	case "list_tasks":
		ts := jarr(jget(v, "tasks"))
		if len(ts) == 0 {
			for _, th := range jarr(jget(v, "threads")) {
				ts = append(ts, jarr(jget(th, "tasks"))...)
			}
		}
		if len(ts) == 0 {
			return "No tasks yet."
		}
		var out []string
		for _, x := range ts {
			out = append(out, taskLines(x)...)
		}
		return strings.Join(out, "\n")
	}
	return ""
}
