package server

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"unicode/utf8"

	"github.com/ryotarai/minbox/internal/agent"
	"github.com/ryotarai/minbox/internal/store"
)

// The mod protocol (docs/mod-protocol.md). Since protocol 1 the integrations (the Claude Code mod,
// the Pi extension, the OpenCode plugin) are thin proxies: they fetch their tool definitions from
// GET /api/agent/tools, pass every tool call to POST /api/agent/tool and inject the text the server
// answers, forward their hooks' events to POST /api/agent/event and inject the delivered messages'
// text the pending poll carries (?proto=1). Everything the agent reads, and every decision about it,
// is made here, so a running session follows the server's behaviour without a restart. The older
// endpoints stay for integrations of protocol 0 (sessions started before the change).

// ModProtocol is the protocol this server speaks. Bump it only when an integration must change to keep
// working (a new endpoint it has to call, a changed field): the session then shows "old mod — restart
// to update". New wording, tools or decisions need no bump.
const ModProtocol = 1

// ---- the tool set ----

// modTool is one tool as an integration registers it.
type modTool struct {
	Name        string `json:"name"`
	Label       string `json:"label,omitempty"`
	Description string `json:"description"`
	InputSchema jobj   `json:"input_schema"`
	Deferred    bool   `json:"deferred"`
}

// modGuard refuses a call of a host's own tool: a shell command matching one of Patterns (JavaScript
// regular expressions), or any call when Patterns is empty. MainOnly: only in the session minbox
// started (OpenCode: not its subagents).
type modGuard struct {
	Tools    []string `json:"tools"`
	Patterns []string `json:"patterns,omitempty"`
	Deny     string   `json:"deny"`
	MainOnly bool     `json:"main_only,omitempty"`
}

type modManifest struct {
	Protocol int        `json:"protocol"`
	Version  string     `json:"version"`
	Tools    []modTool  `json:"tools"`
	Guards   []modGuard `json:"guards"`
}

var manifestCache sync.Map // agent kind -> modManifest

// manifestFor is the tool set of an agent kind, with the names the host registers: Claude Code adds
// its own mcp__minbox__ prefix, Pi and OpenCode take the names as given (minbox_*).
func manifestFor(kind string) modManifest {
	if m, ok := manifestCache.Load(kind); ok {
		return m.(modManifest)
	}
	a := agent.Must(kind)
	prefix := a.Tools().Prefix
	var tools []modTool
	var guards []modGuard
	label := func(tool string) string {
		if kind != agent.Pi {
			return ""
		}
		return "minbox: " + strings.Replace(tool, "_", " ", 1)
	}
	if a.Kind() == agent.Claude {
		tools = append(tools,
			modTool{Name: toolSend, Description: sendDescription, InputSchema: sendSchema()},
			modTool{Name: toolRead, Description: readDescription, InputSchema: readSchema()},
			modTool{Name: toolTitle, Description: titleDescription, InputSchema: titleSchema()},
			modTool{Name: toolOpen, Description: openDescription, InputSchema: openSchema()},
		)
		for _, t := range taskTools {
			tools = append(tools, modTool{Name: t, Description: taskDescription[t], InputSchema: taskSchema(t)})
		}
		for _, t := range navTools {
			tools = append(tools, modTool{Name: t, Description: navDescription[t], InputSchema: navSchema(t), Deferred: true})
		}
		guards = []modGuard{{Tools: []string{"Bash"}, Patterns: openerPatterns, Deny: openDeny(prefix + toolOpen)}, {Tools: []string{"Bash"}, Patterns: pairAcceptPatterns, Deny: pairAcceptDeny}}
	} else {
		send := modTool{Name: prefix + toolSend, Description: sendDescription, InputSchema: sendSchema()}
		read := modTool{Name: prefix + toolRead, Description: localNames(prefix, readDescription), InputSchema: readSchema()}
		title := modTool{Name: prefix + toolTitle, Description: titleDescription, InputSchema: titleSchema()}
		open := modTool{Name: prefix + toolOpen, Description: strings.Replace(openDescription, "the machine Claude runs on", "the machine you run on", 1), InputSchema: openSchema()}
		if kind == agent.Pi {
			send.Label, read.Label, title.Label, open.Label = "minbox: send message", "minbox: read thread", "minbox: set session title", "minbox: open url"
		}
		var navs, tasks []modTool
		for _, t := range navTools {
			navs = append(navs, modTool{Name: prefix + t, Label: label(t), Description: localNames(prefix, navDescription[t]), InputSchema: navSchema(t)})
		}
		for _, t := range taskTools {
			tasks = append(tasks, modTool{Name: prefix + t, Label: label(t), Description: localNames(prefix, taskDescription[t]), InputSchema: taskSchema(t)})
		}
		tools = append(tools, send, read)
		if kind == agent.Pi {
			tools = append(append(tools, navs...), tasks...)
			guards = []modGuard{{Tools: []string{"bash"}, Patterns: openerPatterns, Deny: openDeny(prefix + toolOpen)}, {Tools: []string{"bash"}, Patterns: pairAcceptPatterns, Deny: pairAcceptDeny}}
		} else {
			tools = append(append(tools, tasks...), navs...)
			guards = []modGuard{
				{Tools: []string{"shell", "bash"}, Patterns: openerPatterns, Deny: openDeny(prefix + toolOpen)},
				{Tools: []string{"shell", "bash"}, Patterns: pairAcceptPatterns, Deny: pairAcceptDeny},
				{Tools: []string{"question"}, Deny: questionDeny(prefix + toolSend), MainOnly: true},
			}
		}
		tools = append(tools, title, open)
	}
	m := modManifest{Protocol: ModProtocol, Tools: tools, Guards: guards}
	b, _ := json.Marshal(m)
	sum := sha256.Sum256(b)
	m.Version = hex.EncodeToString(sum[:])[:12]
	manifestCache.Store(kind, m)
	return m
}

func sessKind(sess *store.Session) string { return agent.Must(sess.Agent).Kind() }

func sessNames(sess *store.Session) toolNames {
	return toolNames{prefix: agent.Must(sess.Agent).Tools().Prefix}
}

// GET /api/agent/tools: the session's tool set (names, descriptions, schemas), its guards and version.
func (s *Server) agentTools(w http.ResponseWriter, r *http.Request, sess *store.Session) {
	writeJSON(w, 200, manifestFor(sessKind(sess)))
}

// ---- calling the agent API from inside the server ----

type sessCtxKey struct{}

// agentRoutes is the agent API, for the server's mux and for the tool and event endpoints, which
// call it from inside (so a tool behaves exactly as the endpoint an older integration calls).
func (s *Server) agentRoutes() []struct {
	pattern string
	h       agentHandler
} {
	return []struct {
		pattern string
		h       agentHandler
	}{
		{"POST /api/agent/hello", s.agentHello},
		{"POST /api/agent/status", s.agentStatus},
		{"POST /api/agent/heartbeat", s.agentHeartbeat},
		{"POST /api/agent/title", s.agentTitle},
		{"POST /api/agent/open", s.agentOpen},
		{"POST /api/agent/denied-commands", s.agentDeniedCommand},
		{"POST /api/agent/denied-commands/ran", s.agentRanCommand},
		{"GET /api/agent/tasks", s.agentListTasks},
		{"POST /api/agent/tasks", s.agentCreateTask},
		{"PATCH /api/agent/tasks/{id}", s.agentUpdateTask},
		{"POST /api/agent/messages", s.agentSend},
		{"GET /api/agent/threads", s.agentListThreads},
		{"GET /api/agent/threads/{id}", s.agentReadThread},
		{"GET /api/agent/inbox", s.agentInbox},
		{"GET /api/agent/projects", s.agentListProjects},
		{"GET /api/agent/projects/{id}", s.agentGetProject},
		{"GET /api/agent/sessions", s.agentListSessions},
		{"GET /api/agent/search", s.agentSearch},
		{"GET /api/agent/pending", s.agentPending},
		{"POST /api/agent/pending/{id}/claim", s.agentClaim},
		{"POST /api/agent/pending/{id}/release", s.agentRelease},
		{"POST /api/agent/pending/{id}/delivered", s.agentDelivered},
		// Protocol 1.
		{"GET /api/agent/tools", s.agentTools},
		{"POST /api/agent/tool", s.agentTool},
		{"POST /api/agent/event", s.agentEvent},
	}
}

// innerMux serves the agent API for in-process calls; the session rides in the context.
func (s *Server) innerMux() *http.ServeMux {
	s.innerOnce.Do(func() {
		mux := http.NewServeMux()
		for _, rt := range s.agentRoutes() {
			h := rt.h
			mux.HandleFunc(rt.pattern, func(w http.ResponseWriter, r *http.Request) {
				h(w, r, r.Context().Value(sessCtxKey{}).(*store.Session))
			})
		}
		s.inner = mux
	})
	return s.inner
}

// agentDo calls the agent API in-process as the session; it answers the status and the decoded JSON.
func (s *Server) agentDo(ctx context.Context, sess *store.Session, c apiCall) (int, any) {
	// Each call sees the session as it is now (an earlier call may have changed its status).
	cur := sess
	if fresh, err := s.store.GetSession(ctx, sess.ID); err == nil {
		cur = fresh
	}
	var body *bytes.Reader
	if c.Body != nil {
		b, _ := json.Marshal(c.Body)
		body = bytes.NewReader(b)
	} else {
		body = bytes.NewReader(nil)
	}
	u := &url.URL{Path: c.Path, RawQuery: c.Query.Encode()}
	req, err := http.NewRequestWithContext(context.WithValue(ctx, sessCtxKey{}, cur), c.Method, u.String(), body)
	if err != nil {
		return 500, jobj{"error": err.Error()}
	}
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	s.innerMux().ServeHTTP(rec, req)
	var out any
	_ = json.Unmarshal(rec.Body.Bytes(), &out)
	return rec.Code, out
}

func failText(status int, v any) string {
	if e := jstr(jget(v, "error")); e != "" {
		return "minbox: " + e
	}
	return "minbox: HTTP " + strconv.Itoa(status)
}

// ---- POST /api/agent/tool ----

// POST /api/agent/tool {tool, args}: one tool call of the agent. Answers {ok: true, text, effects?}
// (text is the tool's result) or {ok: false, error} (the call failed; error is what the agent reads).
// effects tell the integration what to mirror in its host: session_title (OpenCode's own list).
func (s *Server) agentTool(w http.ResponseWriter, r *http.Request, sess *store.Session) {
	var req struct {
		Tool string `json:"tool"`
		Args jobj   `json:"args"`
	}
	if !decode(w, r, &req) {
		return
	}
	if req.Args == nil {
		req.Args = jobj{}
	}
	names := sessNames(sess)
	tool := strings.TrimPrefix(strings.TrimPrefix(req.Tool, "mcp__minbox__"), names.prefix)
	text, effects, errText := s.runTool(r.Context(), sess, names, tool, req.Args)
	if errText != "" {
		writeJSON(w, 200, jobj{"ok": false, "error": errText})
		return
	}
	out := jobj{"ok": true, "text": text}
	if len(effects) > 0 {
		out["effects"] = effects
	}
	writeJSON(w, 200, out)
}

func (s *Server) runTool(ctx context.Context, sess *store.Session, names toolNames, tool string, e jobj) (text string, effects jobj, errText string) {
	call := func(c apiCall) (any, string) {
		status, v := s.agentDo(ctx, sess, c)
		if status < 200 || status > 299 {
			return nil, failText(status, v)
		}
		return v, ""
	}
	switch tool {
	case toolSend:
		body, _ := e["body"].(string)
		if strings.TrimSpace(body) == "" {
			return "", nil, "body is required."
		}
		req := jobj{"body": body}
		if v, ok := e["task_id"].(string); ok && strings.TrimSpace(v) != "" {
			req["task_id"] = v
		}
		if v := argStrs(e["task_ids"]); v != nil {
			req["task_ids"] = v // the older name of task_id (one element)
		} else if v, ok := e["task_ids"].(string); ok && strings.TrimSpace(v) != "" {
			req["task_ids"] = []any{v}
		}
		for _, k := range []string{"status", "thread_id"} {
			if v, ok := e[k].(string); ok && strings.TrimSpace(v) != "" {
				req[k] = v
			}
		}
		for _, k := range []string{"thread_title", "subject"} {
			if v, ok := e[k].(string); ok && strings.TrimSpace(v) != "" {
				req["thread_title"] = v
				break
			}
		}
		if v := argStrs(e["attachments"]); v != nil {
			req["attachments"] = v
		}
		if v, ok := e["review"].(map[string]any); ok {
			req["review"] = v
		}
		v, fail := call(apiCall{Method: "POST", Path: "/api/agent/messages", Body: req})
		if fail != "" {
			return "", nil, fail
		}
		s.proxyUpdate(sess.ID, func(p *proxyState) { p.sent = true })
		return sentText(v), nil, ""
	case toolRead:
		id, _ := e["thread_id"].(string)
		if id == "" {
			v, fail := call(apiCall{Method: "GET", Path: "/api/agent/threads"})
			if fail != "" {
				return "", nil, fail
			}
			return threadListText(jarr(v)), nil, ""
		}
		q := url.Values{}
		if f, ok := e["limit"].(float64); ok && f > 0 {
			q.Set("limit", strconv.Itoa(int(f)))
		}
		if b, ok := e["before"].(string); ok && b != "" {
			q.Set("before", b)
		}
		v, fail := call(apiCall{Method: "GET", Path: "/api/agent/threads/" + url.PathEscape(id), Query: q})
		if fail != "" {
			return "", nil, fail
		}
		return threadText(v, names.of(toolRead)), nil, ""
	case toolTitle:
		t := argStr(e, "title")
		if t == "" {
			return "", nil, "title is required."
		}
		v, fail := call(apiCall{Method: "POST", Path: "/api/agent/title", Body: jobj{"title": t}})
		if fail != "" {
			return "", nil, fail
		}
		title := jstr(jget(v, "title"))
		if title == "" {
			title = t
		}
		return "Session title set: " + title, jobj{"session_title": t}, ""
	case toolOpen:
		u := argStr(e, "url")
		if u == "" {
			return "", nil, "url is required."
		}
		v, fail := call(apiCall{Method: "POST", Path: "/api/agent/open", Body: jobj{"url": u}})
		if fail != "" {
			return "", nil, fail
		}
		opened := jstr(jget(v, "url"))
		if opened == "" {
			opened = u
		}
		return "Opened " + opened + " in the person's browser.", nil, ""
	}
	for _, t := range taskTools {
		if t == tool {
			c, bad := taskCall(tool, e)
			if bad != "" {
				return "", nil, bad
			}
			if strings.HasPrefix(c.Path, "/api/agent/tasks/") {
				c.Path = "/api/agent/tasks/" + url.PathEscape(strings.TrimPrefix(c.Path, "/api/agent/tasks/"))
			}
			v, fail := call(c)
			if fail != "" {
				return "", nil, fail
			}
			return taskText(tool, v), nil, ""
		}
	}
	for _, t := range navTools {
		if t == tool {
			c, bad := navCall(tool, e)
			if bad != "" {
				return "", nil, bad
			}
			if strings.HasPrefix(c.Path, "/api/agent/projects/") {
				c.Path = "/api/agent/projects/" + url.PathEscape(strings.TrimPrefix(c.Path, "/api/agent/projects/"))
			}
			v, fail := call(c)
			if fail != "" {
				return "", nil, fail
			}
			return navText(tool, v), nil, ""
		}
	}
	return "", nil, "minbox: unknown tool " + tool
}

// ---- the session's turn, as the server follows it for protocol-1 integrations ----

// proxyState is what the server remembers of a session's turns: the threads of the messages just
// delivered (the next turn answers them), whether the agent replied in the turn, the reminders due.
type proxyState struct {
	delivered   []string // threads delivered for the turn that starts next
	turn        []string // threads the running turn answers
	sent        bool     // send_message ran in the running turn
	nudgeIssued bool     // a reminder was handed out; the next turn is it
	nudging     bool     // the running turn is a reminder
	remind      bool     // the next prompt carries the instructions (a new conversation)
	threadsNext bool     // the next prompt carries the open threads (after a compaction)
	fresh       bool     // a hello came: the next prompt carries the instructions
	prompts     int
	reported    []string        // tool call ids reported as denied (once each)
	denied      map[string]bool // commands reported as denied: a later run clears them
}

func (s *Server) proxyUpdate(id string, f func(p *proxyState)) {
	s.proxyMu.Lock()
	defer s.proxyMu.Unlock()
	if s.proxy == nil {
		s.proxy = map[string]*proxyState{}
	}
	p := s.proxy[id]
	if p == nil {
		p = &proxyState{remind: true, denied: map[string]bool{}}
		s.proxy[id] = p
	}
	f(p)
}

// noteDelivered: the person's message of a thread went into the agent; the next turn answers it.
func (s *Server) noteDelivered(sessionID, threadID string) {
	s.proxyUpdate(sessionID, func(p *proxyState) { p.delivered = appendNew(p.delivered, threadID) })
}

// currentThread is the thread the running turn answers when it is exactly one ("" otherwise).
func (p *proxyState) currentThread() string {
	threads := p.turn
	if len(threads) == 0 {
		threads = p.delivered
	}
	if len(threads) == 1 {
		return threads[0]
	}
	return ""
}

func orchestratorEvery() int {
	if n, err := strconv.Atoi(os.Getenv("MINBOX_ORCHESTRATOR_EVERY")); err == nil && n > 0 {
		return n
	}
	return 20
}

// ---- POST /api/agent/event ----

// claudeRefusals: how Claude Code words a tool call that never ran because it was refused (the
// person rejecting the prompt, a deny rule, a mode that cannot ask, auto mode's classifier). Anchored
// at the start, so a command's own output ("Permission denied") does not count.
var claudeRefusals = []*regexp.Regexp{
	regexp.MustCompile(`^The user doesn't want to proceed with this tool use\b`),
	regexp.MustCompile(`^The user doesn't want to take this action right now\b`),
	regexp.MustCompile(`(?s)^Permission to use \S+(?: with command .*?)? has been denied\b`),
	regexp.MustCompile(`^Permission for this action has been denied\b`),
	regexp.MustCompile(`^Permission to use \S+ has been denied\b`),
}

var piNotBlocked = regexp.MustCompile(`^(Operation aborted|Tool \S+ not found|Invalid arguments for tool|Validation failed)`)

// deniedMax: the longest command reported (the reply area offers at most 500 characters).
const deniedMax = 4000

// shortReason: a reason's first line, at most 300 characters.
func shortReason(reason string) string {
	line := strings.Split(strings.TrimSpace(reason), "\n")[0]
	if utf8.RuneCountInString(line) > 300 {
		return cut(line, 300) + "…"
	}
	return line
}

type eventReq struct {
	Type string `json:"type"`
	// turn.complete (Claude Code): why the turn ended, whether it was aborted, its final answer.
	Reason  string `json:"reason"`
	Aborted bool   `json:"aborted"`
	Answer  string `json:"answer"`
	// prompt: who submitted it ("composer": the person typed).
	Origin string `json:"origin"`
	// bash: a shell call's outcome, as the host reported it (Phase says which hook saw it).
	Phase    string  `json:"phase"`
	ID       string  `json:"id"`
	Command  string  `json:"command"`
	Deny     *string `json:"deny"`
	IsError  bool    `json:"is_error"`
	Ran      bool    `json:"ran"`
	Text     string  `json:"text"`
	Decision string  `json:"decision"`
	Rule     string  `json:"rule"`
	Hook     string  `json:"hook"`
	Message  string  `json:"message"`
	ErrType  string  `json:"error_type"`
}

// POST /api/agent/event {type, ...}: what happened in the agent, forwarded by a protocol-1
// integration. The answer says what to do: {context: [texts]} for a prompt (added to it),
// {submit_when_idle: text} after a turn (a reminder to submit once the agent is idle; dropped when
// the person types first).
//
//	turn.start                         the main loop started a turn (status working)
//	turn.complete {reason, aborted, answer}  it ended (status idle)
//	session.end                        the conversation ended (/clear, resume): its state starts over
//	session.compact                    the conversation was compacted
//	prompt {origin}                    a prompt is being submitted
//	bash {phase, id, command, ...}     a shell call's outcome (see bashOutcome)
func (s *Server) agentEvent(w http.ResponseWriter, r *http.Request, sess *store.Session) {
	var req eventReq
	if !decode(w, r, &req) {
		return
	}
	ctx := r.Context()
	names := sessNames(sess)
	out := jobj{"ok": true}
	status := func(v string) {
		s.agentDo(ctx, sess, apiCall{Method: "POST", Path: "/api/agent/status", Body: jobj{"status": v}})
	}
	switch req.Type {
	case "turn.start":
		s.proxyUpdate(sess.ID, func(p *proxyState) {
			p.sent = false
			p.turn = p.delivered
			p.delivered = nil
			p.nudging = p.nudgeIssued
			p.nudgeIssued = false
		})
		status(store.StatusWorking)
	case "turn.complete":
		nudge := ""
		s.proxyUpdate(sess.ID, func(p *proxyState) {
			answered := req.Reason == "answer" && !req.Aborted
			quiet := answered && !p.nudging && !p.sent
			if quiet && len(p.turn) > 0 {
				nudge = replyNudgeText(names.of(toolSend))
			} else if quiet && asksPerson(req.Answer) {
				nudge = nudgeText(names.of(toolSend))
			}
			p.nudgeIssued = nudge != ""
			p.turn = nil
			p.nudging = false
		})
		status(store.StatusIdle)
		if nudge != "" {
			out["submit_when_idle"] = nudge
		}
	case "session.end":
		s.proxyUpdate(sess.ID, func(p *proxyState) {
			*p = proxyState{remind: true, denied: p.denied, reported: p.reported}
		})
		status(store.StatusIdle)
	case "session.compact":
		s.proxyUpdate(sess.ID, func(p *proxyState) { p.threadsNext = true })
	case "prompt":
		out["context"] = s.promptContext(ctx, sess, names, req.Origin == "composer")
	case "bash":
		s.bashOutcome(ctx, sess, names, req)
	default:
		httpError(w, 400, "unknown event type "+req.Type)
		return
	}
	writeJSON(w, 200, out)
}

// promptContext is what a prompt carries: the instructions on the first prompt of a conversation,
// after a hello, after a compaction (with the open threads) and every Nth prompt; else nothing.
func (s *Server) promptContext(ctx context.Context, sess *store.Session, names toolNames, typed bool) []string {
	var remind, threads bool
	every := orchestratorEvery()
	s.proxyUpdate(sess.ID, func(p *proxyState) {
		if typed {
			p.nudgeIssued = false // the person answered in the chat
		}
		p.prompts++
		remind = p.remind || p.threadsNext || p.fresh || p.prompts%every == 0
		threads = p.threadsNext
		if remind {
			p.remind, p.threadsNext, p.fresh = false, false, false
		}
	})
	added := []string{}
	if !remind {
		return added
	}
	if instr := s.sessions.instructions(ctx, sess); strings.TrimSpace(instr) != "" {
		added = append(added, instructionsText(instr))
	} else {
		added = append(added, fallbackReminderText(names.of(toolSend)))
	}
	if threads {
		if status, v := s.agentDo(ctx, sess, apiCall{Method: "GET", Path: "/api/agent/threads"}); status == 200 {
			if list := openThreadsText(jarr(v)); list != "" {
				added = append(added, list)
			}
		}
	}
	return added
}

// bashOutcome reads a shell call's outcome as the host reported it: a refused command is offered to
// the person as "Run yourself" (denied.go), a later successful run of it withdraws the offer.
//
//	check  {decision, rule, hook, reason}  Claude Code's permission verdict (tool.check)
//	denied {reason}                        Claude Code's auto mode refused it
//	result {deny?, is_error, text}         Claude Code's tool result (a refusal is worded as an error)
//	end    {is_error, ran, text}           Pi's tool_execution_end (ran: it has a duration)
//	failed {error_type, message}           OpenCode's session.tool.failed
//	success                                OpenCode's session.tool.success
func (s *Server) bashOutcome(ctx context.Context, sess *store.Session, names toolNames, e eventReq) {
	command := strings.TrimSpace(e.Command)
	if command == "" {
		return
	}
	reason, denied, ran := "", false, false
	switch e.Phase {
	case "check":
		if e.Decision == "deny" {
			denied = true
			switch {
			case e.Rule != "":
				reason = "denied by the rule " + e.Rule
			case e.Hook != "":
				reason = "denied by a " + e.Hook + " hook"
				if e.Message != "" {
					reason += ": " + e.Message
				}
			case e.Message != "":
				reason = e.Message
			default:
				reason = "denied"
			}
		}
	case "denied":
		denied, reason = true, firstNonEmpty(e.Message, "denied")
	case "result":
		switch {
		case e.Deny != nil:
			denied, reason = true, firstNonEmpty(*e.Deny, "denied")
		case e.IsError:
			text := strings.TrimSpace(e.Text)
			for _, re := range claudeRefusals {
				if re.MatchString(text) {
					denied, reason = true, text
					break
				}
			}
		default:
			ran = true
		}
	case "end":
		if e.IsError && !e.Ran {
			text := strings.TrimSpace(e.Text)
			if !piNotBlocked.MatchString(text) {
				denied, reason = true, firstNonEmpty(text, "Tool execution was blocked")
			}
		} else if !e.IsError {
			ran = true
		}
	case "failed":
		if e.ErrType == "permission.rejected" {
			denied, reason = true, firstNonEmpty(e.Message, "permission rejected")
		}
	case "success":
		ran = true
	}
	if denied && reason == openDeny(names.of(toolOpen)) {
		return // minbox's own refusal (a page opened on the host)
	}
	if denied {
		if len(command) > deniedMax {
			return
		}
		dup, thread := false, ""
		s.proxyUpdate(sess.ID, func(p *proxyState) {
			if e.ID != "" {
				for _, id := range p.reported {
					if id == e.ID {
						dup = true
					}
				}
				if !dup {
					p.reported = append(p.reported, e.ID)
					if len(p.reported) > 200 {
						p.reported = p.reported[1:]
					}
				}
			}
			if !dup {
				p.denied[command] = true
			}
			thread = p.currentThread()
		})
		if dup {
			return
		}
		body := jobj{"command": command, "reason": shortReason(reason), "at": s.nowFn().UTC().Format("2006-01-02T15:04:05.000Z07:00")}
		if thread != "" {
			body["thread_id"] = thread
		}
		s.agentDo(ctx, sess, apiCall{Method: "POST", Path: "/api/agent/denied-commands", Body: body})
		return
	}
	if ran {
		was := false
		s.proxyUpdate(sess.ID, func(p *proxyState) {
			was = p.denied[command]
			delete(p.denied, command)
		})
		if was {
			s.agentDo(ctx, sess, apiCall{Method: "POST", Path: "/api/agent/denied-commands/ran", Body: jobj{"command": command}})
		}
	}
}

// ---- the pending poll, protocol 1 ----

// pendingV1 is the pending poll's answer for protocol 1: each message with the text to inject
// (verbatim; several delivered together are joined with joiner).
func pendingV1(sess *store.Session, pending []store.PendingDelivery) jobj {
	names := sessNames(sess)
	items := make([]jobj, 0, len(pending))
	for _, p := range pending {
		var item jobj
		b, _ := json.Marshal(p)
		_ = json.Unmarshal(b, &item)
		wm := wakeMsg{ID: p.ID, ThreadID: p.ThreadID, Subject: p.Subject, Body: p.Body, Kind: p.Kind, NewThread: p.NewThread, Stream: p.Stream}
		for _, t := range p.Tasks {
			wm.Tasks = append(wm.Tasks, wakeTask{ID: t.TaskID, Title: t.Title, Status: t.Status})
		}
		item["text"] = wakeText(wm, names.of(toolSend), names.of(toolRead))
		items = append(items, item)
	}
	return jobj{"protocol": ModProtocol, "items": items, "joiner": wakeJoiner}
}
