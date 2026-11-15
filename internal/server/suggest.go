package server

import (
	"bytes"
	"container/list"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/exec"
	"regexp"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/ryotarai/minbox/internal/agent"
	"github.com/ryotarai/minbox/internal/store"
)

// Reply questions ("reply suggestions"): a few questions for the person, each with options to pick,
// that help them decide how to answer the agent's latest message. The person's answers are put into
// the reply by the web UI. Drafted by Haiku (or the helper agent). See docs/api-contract.md
// ("Reply suggestions").

const (
	suggestMaxQuestions = 8
	suggestMaxOptions   = 5
	suggestMaxLen       = 200  // runes per question text and per command
	suggestLabelLen     = 80   // runes per option label
	suggestDescLen      = 160  // runes per option description
	suggestMsgCount     = 12   // messages of the thread in the prompt
	suggestMsgLen       = 1500 // runes per message
	suggestRunTimeout   = 45 * time.Second
	suggestWait         = 50 * time.Second // how long the endpoint waits for a run
	suggestCacheSize    = 200
	suggestCacheTTL     = time.Hour
	suggestParallel     = 2
)

const suggestSystemPrompt = "You write short multiple-choice questions that help a person decide how to reply to their coding agent. Output only JSON matching the schema."

const suggestSchema = `{"type":"object","properties":{` +
	`"questions":{"type":"array","minItems":0,"maxItems":8,"items":{"type":"object","properties":{` +
	`"question":{"type":"string","maxLength":200},` +
	`"kind":{"type":"string","enum":["single","multi"]},` +
	`"options":{"type":"array","minItems":0,"maxItems":5,"items":{"type":"object","properties":{` +
	`"label":{"type":"string","maxLength":80},"description":{"type":"string","maxLength":160}},` +
	`"required":["label"],"additionalProperties":false}}},` +
	`"required":["question","kind","options"],"additionalProperties":false}},` +
	`"command":{"type":"string","maxLength":200}},` +
	`"required":["questions"],"additionalProperties":false}`

// ReplyOption is one answer the person can pick.
type ReplyOption struct {
	Label       string `json:"label"`
	Description string `json:"description,omitempty"`
}

// ReplyQuestion is one question for the person: single (one answer) or multi (any number). Every
// question also takes a free-text answer in the UI; no options means free text only.
type ReplyQuestion struct {
	Question string        `json:"question"`
	Kind     string        `json:"kind"` // single | multi
	Options  []ReplyOption `json:"options"`
}

// replyHelp is one helper run's result (what is cached).
type replyHelp struct {
	Questions []ReplyQuestion
	Command   string // "!command" the person may run themselves, or ""
}

// SuggestResult is the endpoint's answer.
type SuggestResult struct {
	Questions []ReplyQuestion `json:"questions"`
	Command   string          `json:"command,omitempty"` // "!command": a command the agent was denied, to run yourself
	Reason    string          `json:"reason,omitempty"`  // not_needed | disabled | no_agent (no coding agent is installed)
	Error     string          `json:"error,omitempty"`
}

type suggestEntry struct {
	key     string
	res     replyHelp
	expires time.Time
}

type suggestCall struct {
	done chan struct{}
	res  replyHelp
	err  error
}

// suggester runs the generator: cache per (thread, last message), one run per key, two at a time.
type suggester struct {
	// run turns a prompt into questions. Replaced in tests.
	run func(ctx context.Context, prompt string) (replyHelp, error)
	// timeout bounds one run (including the wait for a free slot).
	timeout time.Duration

	mu       sync.Mutex
	cache    map[string]*list.Element
	order    *list.List // front = most recent
	inflight map[string]*suggestCall
	sem      chan struct{}
	now      func() time.Time
}

func newSuggester(run func(ctx context.Context, prompt string) (replyHelp, error)) *suggester {
	return &suggester{run: run, timeout: suggestRunTimeout, cache: map[string]*list.Element{}, order: list.New(), inflight: map[string]*suggestCall{}, sem: make(chan struct{}, suggestParallel), now: time.Now}
}

func (g *suggester) cached(key string) (replyHelp, bool) {
	g.mu.Lock()
	defer g.mu.Unlock()
	el, ok := g.cache[key]
	if !ok {
		return replyHelp{}, false
	}
	e := el.Value.(*suggestEntry)
	if g.now().After(e.expires) {
		g.order.Remove(el)
		delete(g.cache, key)
		return replyHelp{}, false
	}
	g.order.MoveToFront(el)
	return e.res, true
}

func (g *suggester) put(key string, res replyHelp) {
	g.mu.Lock()
	defer g.mu.Unlock()
	if el, ok := g.cache[key]; ok {
		g.order.Remove(el)
	}
	g.cache[key] = g.order.PushFront(&suggestEntry{key: key, res: res, expires: g.now().Add(suggestCacheTTL)})
	for g.order.Len() > suggestCacheSize {
		last := g.order.Back()
		g.order.Remove(last)
		delete(g.cache, last.Value.(*suggestEntry).key)
	}
}

// get returns the questions for key, running the generator once however many callers ask.
// Errors are not cached. fresh reports that this call started the run that produced the result.
func (g *suggester) get(ctx context.Context, key, prompt string) (res replyHelp, fresh bool, err error) {
	if r, ok := g.cached(key); ok {
		return r, false, nil
	}
	g.mu.Lock()
	c, joined := g.inflight[key]
	if !joined {
		c = &suggestCall{done: make(chan struct{})}
		g.inflight[key] = c
		go func() {
			// The run belongs to the key, not to the request that started it.
			rctx, cancel := context.WithTimeout(context.Background(), g.timeout)
			defer cancel()
			select {
			case g.sem <- struct{}{}:
				c.res, c.err = g.run(rctx, prompt)
				<-g.sem
			case <-rctx.Done():
				c.err = errors.New("timed out waiting for a free slot")
			}
			if c.err == nil && rctx.Err() != nil {
				c.res, c.err = replyHelp{}, errors.New("the coding agent took too long")
			}
			if c.err == nil {
				g.put(key, c.res)
			}
			g.mu.Lock()
			delete(g.inflight, key)
			g.mu.Unlock()
			close(c.done)
		}()
	}
	g.mu.Unlock()
	select {
	case <-c.done:
		return c.res, !joined, c.err
	case <-ctx.Done():
		return replyHelp{}, false, ctx.Err()
	}
}

// ---- prompt ----

func truncRunes(s string, n int) string {
	if utf8.RuneCountInString(s) <= n {
		return s
	}
	r := []rune(s)
	return string(r[:n]) + "…"
}

// buildSuggestPrompt: the recent messages (who said what), the open questions of the last agent
// message, and the instruction.
func buildSuggestPrompt(th *store.Thread) string {
	ms := th.Messages
	if len(ms) > suggestMsgCount {
		ms = ms[len(ms)-suggestMsgCount:]
	}
	var b strings.Builder
	b.WriteString("Conversation between a person and their coding agent (oldest first).\n")
	if th.Subject != "" {
		b.WriteString("Subject: " + truncRunes(th.Subject, 200) + "\n")
	}
	b.WriteString("\n")
	for i, m := range ms {
		who := "AGENT"
		body := m.Body
		if m.Author == store.AuthorUser {
			who = "PERSON"
			if m.Words != "" {
				body = m.Words
			}
		}
		b.WriteString("[" + who + "]\n" + truncRunes(strings.TrimSpace(body), suggestMsgLen) + "\n")
		if i == len(ms)-1 && m.Author == store.AuthorAgent {
			for _, q := range m.Questions {
				b.WriteString("Open question: " + truncRunes(q.Prompt, 400) + "\n")
				for _, c := range q.Choices {
					b.WriteString("  - option: " + truncRunes(c.Label, 200) + "\n")
				}
			}
		}
		b.WriteString("\n")
	}
	b.WriteString("Task: the PERSON is about to reply to the AGENT's last message. Write the questions the PERSON should answer to decide that reply; " +
		"their answers will be sent to the agent as the reply. " +
		"Ask as many questions as the message needs: usually 1 to 4, more only when it really raises more separate decisions, none when there is nothing to decide. " +
		"Each question is short and concrete, with kind \"single\" (exactly one answer fits) or \"multi\" (several answers can apply together), " +
		"and 2 to 5 options: short labels (a few words) of the likely answers, each with an optional one-line description. " +
		"Strongly prefer options; leave options empty only when no sensible options exist (the person can always type their own answer, so do not add an \"Other\" option). " +
		"Write questions and options in the language the PERSON used above (if they wrote nothing, the agent's language). " +
		"If the agent asked a question with options, ask it with those options. " +
		"If the agent reports completion, ask about the next step (a concrete follow-up, a check, a detail to request). " +
		"Never ask about thanks, praise, greetings or acknowledgements, and do not ask what the agent already knows. " +
		"If the agent's last message says a command it wanted to run was denied or rejected and quotes that command, set command to exactly that command " +
		"(the person can then run it themselves); otherwise leave command out. " +
		"Never set command to a file or directory path, a lone word or name quoted in the message, or a command the agent did not say was denied: " +
		"a message that only mentions code, paths or settings (such as allow / deny / ask) has no command.\n")
	return b.String()
}

// ---- denied commands ----

var deniedRe = regexp.MustCompile(`(?i)\b(denied|deny|denies|rejected|reject|declined|refused|not allowed|not approved|disallowed)\b|拒否|許可されな|承認されな|却下`)
var fencedRe = regexp.MustCompile("(?s)```[a-zA-Z0-9_-]*\\n(.*?)\\n?```")
var inlineCodeRe = regexp.MustCompile("`([^`\\n]{2,})`")

// deniedCommandSuggestion: the command the agent's message says was denied, as "!command" for the
// composer, or "". It needs a denial word in the prose (a word inside code, such as `deny` in a list
// of permission modes, does not count) and a quoted command: the first one-line code block, else the
// first inline code span, that reads as a shell command (a bare path or a lone name does not). A
// command that does not fit is not offered cut.
func deniedCommandSuggestion(body string) string {
	if !deniedRe.MatchString(withoutCode(body)) {
		return ""
	}
	var cands []string
	for _, m := range fencedRe.FindAllStringSubmatch(body, -1) {
		cands = append(cands, m[1])
	}
	for _, m := range inlineCodeRe.FindAllStringSubmatch(withoutFenced(body), -1) {
		cands = append(cands, m[1])
	}
	for _, c := range cands {
		if cmd := bangCommand(c); cmd != "" {
			return cmd
		}
	}
	return ""
}

// withoutFenced is body with its fenced code blocks taken out; withoutCode also takes out inline code.
func withoutFenced(body string) string { return fencedRe.ReplaceAllString(body, " ") }
func withoutCode(body string) string   { return inlineCodeRe.ReplaceAllString(withoutFenced(body), " ") }

// bangCommand: "!command" for a single-line command (a leading "$ " or "!" dropped), or "" when it is
// empty, spans lines, does not fit in suggestMaxLen or does not read as a shell command.
func bangCommand(cmd string) string {
	cmd = strings.TrimSpace(cmd)
	cmd = strings.TrimSpace(strings.TrimPrefix(cmd, "!"))
	cmd = strings.TrimSpace(strings.TrimPrefix(cmd, "$ "))
	if cmd == "" || strings.ContainsAny(cmd, "\r\n") || utf8.RuneCountInString(cmd)+1 > suggestMaxLen || !looksLikeCommand(cmd) {
		return ""
	}
	return "!" + cmd
}

var (
	envAssignRe = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*=\S*$`)
	execNameRe  = regexp.MustCompile(`^[A-Za-z0-9_][A-Za-z0-9_.+-]*$`)
	execPathRe  = regexp.MustCompile(`^(\./|\.\./|/|~/)\S*[^/\s]$`)
)

// loneCommands are the commands taken as one when they stand alone, without arguments: any other lone
// word, such as `allow` or `extension_ui_request`, is more likely a name the agent mentioned.
var loneCommands = map[string]bool{
	"make": true, "ls": true, "pwd": true, "whoami": true, "date": true, "env": true, "top": true,
	"htop": true, "uptime": true, "id": true, "df": true, "ps": true, "history": true, "reboot": true,
}

// looksLikeCommand: cmd reads as a shell command to run. Its first word (after any VAR=value) is an
// executable: a plain name, or a path such as ./run.sh or /usr/bin/env that is not a directory (no
// trailing "/"); a relative path such as dir/sub/ is not. A command of one word must be a ./script or
// a known argument-less command, so a bare path (extensions/auto-permission/, ~/.okaka/state/logs/,
// /etc/hosts) or a lone identifier is not one.
func looksLikeCommand(cmd string) bool {
	words := strings.Fields(cmd)
	i := 0
	for i < len(words)-1 && envAssignRe.MatchString(words[i]) {
		i++
	}
	exe, alone := words[i], len(words)-i == 1
	switch {
	case execPathRe.MatchString(exe):
		return !alone || strings.HasPrefix(exe, "./") || strings.HasPrefix(exe, "../")
	case execNameRe.MatchString(exe):
		return !alone || loneCommands[exe]
	}
	return false
}

// withDeniedCommand makes denied the command of the result and drops options that only repeat it
// (and questions left without options by that).
func withDeniedCommand(denied string, h replyHelp) replyHelp {
	out := replyHelp{Command: denied, Questions: []ReplyQuestion{}}
	same := func(s string) bool {
		s = strings.TrimSpace(s)
		return strings.EqualFold(s, denied) || strings.EqualFold("!"+s, denied)
	}
	for _, q := range h.Questions {
		had := len(q.Options) > 0
		opts := []ReplyOption{}
		for _, o := range q.Options {
			if !same(o.Label) {
				opts = append(opts, o)
			}
		}
		if had && len(opts) == 0 {
			continue
		}
		q.Options = opts
		out.Questions = append(out.Questions, q)
	}
	return out
}

// ---- result parsing ----

// parseSuggestions reads claude's `--output-format json` envelope: structured_output, else the
// `result` string parsed as the same JSON. Questions and options are trimmed, deduped
// (case-insensitive), emptied ones dropped, counts and lengths capped. No questions is a valid answer.
func parseSuggestions(out []byte) (replyHelp, error) {
	var env struct {
		IsError          bool            `json:"is_error"`
		Subtype          string          `json:"subtype"`
		Result           string          `json:"result"`
		StructuredOutput json.RawMessage `json:"structured_output"`
	}
	if err := json.Unmarshal(bytes.TrimSpace(out), &env); err != nil {
		return replyHelp{}, errors.New("claude printed no JSON")
	}
	if env.IsError {
		return replyHelp{}, errors.New("claude reported an error: " + truncRunes(firstNonEmpty(env.Result, env.Subtype), 120))
	}
	var body struct {
		Questions []json.RawMessage `json:"questions"`
		Command   any               `json:"command"`
	}
	raw := []byte(env.StructuredOutput)
	if len(raw) == 0 || string(raw) == "null" {
		raw = []byte(env.Result)
	}
	if err := json.Unmarshal(raw, &body); err != nil || body.Questions == nil {
		return replyHelp{}, errors.New("claude's answer was not the expected JSON")
	}
	res := replyHelp{Questions: []ReplyQuestion{}}
	if c, ok := body.Command.(string); ok {
		res.Command = bangCommand(c)
	}
	seenQ := map[string]bool{}
	for _, rq := range body.Questions {
		var q struct {
			Question string            `json:"question"`
			Kind     string            `json:"kind"`
			Options  []json.RawMessage `json:"options"`
		}
		if json.Unmarshal(rq, &q) != nil {
			continue
		}
		text := strings.TrimSpace(q.Question)
		if text == "" || seenQ[strings.ToLower(text)] {
			continue
		}
		seenQ[strings.ToLower(text)] = true
		kind := "single"
		if strings.EqualFold(strings.TrimSpace(q.Kind), "multi") {
			kind = "multi"
		}
		opts := []ReplyOption{}
		seenO := map[string]bool{}
		for _, ro := range q.Options {
			var o ReplyOption
			var label string
			if json.Unmarshal(ro, &label) == nil { // a bare string is a label
				o.Label = label
			} else if json.Unmarshal(ro, &o) != nil {
				continue
			}
			o.Label = strings.TrimSpace(o.Label)
			o.Description = truncRunes(strings.TrimSpace(o.Description), suggestDescLen)
			if o.Label == "" || seenO[strings.ToLower(o.Label)] {
				continue
			}
			seenO[strings.ToLower(o.Label)] = true
			o.Label = truncRunes(o.Label, suggestLabelLen)
			opts = append(opts, o)
			if len(opts) == suggestMaxOptions {
				break
			}
		}
		res.Questions = append(res.Questions, ReplyQuestion{Question: truncRunes(text, suggestMaxLen), Kind: kind, Options: opts})
		if len(res.Questions) == suggestMaxQuestions {
			break
		}
	}
	return res, nil
}

func firstNonEmpty(a ...string) string {
	for _, s := range a {
		if s != "" {
			return s
		}
	}
	return ""
}

// ---- the helper run ----

// suggestArgv: the executable is Config.SuggestCommand (MINBOX_SUGGEST_COMMAND) if set, else only the
// first word of the Claude command (the person's own flags, such as --model, are not carried over).
func (s *Server) suggestArgv() []string {
	return s.claudeArgv("haiku", suggestSystemPrompt, suggestSchema)
}

// claudeArgv: a tool-less, session-less, settings-less `claude -p` run with a JSON schema.
func (s *Server) claudeArgv(model, system, schema string) []string {
	return agent.Must(agent.Claude).Headless(agent.HeadlessSpec{Command: s.claudeBase(), Model: model, System: system, Schema: schema}).Argv
}

// runSuggest runs the helper agent for the reply questions, the prompt on stdin.
func (s *Server) runSuggest(ctx context.Context, prompt string) (replyHelp, error) {
	out, err := s.runHelper(ctx, "haiku", suggestSystemPrompt, suggestSchema, prompt)
	if err != nil {
		return replyHelp{}, err
	}
	return parseSuggestions(out)
}

// helperPlan chooses the agent for a one-shot helper run (reply suggestions, Slack project pick) and
// builds its command line. Config.SuggestCommand (MINBOX_SUGGEST_COMMAND), if set, is a Claude-format
// helper and wins. Otherwise the default agent runs it (the default_agent setting, else the installed
// one), falling back to another agent when the preferred one is not installed; with none
// installed the error is agent.ErrNoneInstalled and the feature is simply off. OpenCode runs helpers
// only when neither Claude Code nor Pi is installed (its runs are slower: each starts a private server,
// and each leaves a session that is deleted afterwards). claudeModel is the model for Claude Code; Pi
// uses Config.PiHelperModel, OpenCode Config.OpenCodeHelperModel (or their own defaults).
func (s *Server) helperPlan(ctx context.Context, claudeModel, system, schema string) (name string, h agent.Headless, err error) {
	claudeSpec := func() agent.Headless {
		return agent.Must(agent.Claude).Headless(agent.HeadlessSpec{Command: s.claudeBase(), Model: claudeModel, System: system, Schema: schema})
	}
	if len(s.cfg.SuggestCommand) > 0 {
		return "claude", claudeSpec(), nil
	}
	cmds := s.sessions.commands()
	kind := s.sessions.defaultAgent(ctx)
	if kind == agent.OpenCode {
		// OpenCode is the helper of last resort, even when it is the default agent.
		for _, k := range []string{agent.Claude, agent.Pi} {
			if cmds.Usable(k) {
				kind = k
				break
			}
		}
	}
	if !cmds.Usable(kind) {
		return "", agent.Headless{}, agent.ErrNoneInstalled
	}
	switch kind {
	case agent.Pi:
		return "pi", agent.Must(agent.Pi).Headless(agent.HeadlessSpec{Command: cmds[agent.Pi][:1], Model: s.cfg.PiHelperModel, System: system, Schema: schema}), nil
	case agent.OpenCode:
		return "opencode", agent.Must(agent.OpenCode).Headless(agent.HeadlessSpec{Command: agent.OpenCodeBase(cmds[agent.OpenCode]), Model: s.cfg.OpenCodeHelperModel, System: system, Schema: schema}), nil
	}
	return "claude", claudeSpec(), nil
}

// claudeBase is the executable of Claude Code's helper runs: Config.SuggestCommand if set, else only the
// first word of the Claude command (the person's own flags, such as --model, are not carried over).
func (s *Server) claudeBase() []string {
	base := s.cfg.SuggestCommand
	if len(base) == 0 && len(s.cfg.ClaudeCommand) > 0 {
		base = s.cfg.ClaudeCommand[:1]
	}
	if len(base) == 0 {
		base = []string{"claude"}
	}
	return base
}

// runHelper runs the helper agent in a fresh empty directory with the prompt on stdin and returns
// the answer in the envelope parseSuggestions and parsePick read.
func (s *Server) runHelper(ctx context.Context, claudeModel, system, schema, prompt string) ([]byte, error) {
	name, h, err := s.helperPlan(ctx, claudeModel, system, schema)
	if err != nil {
		return nil, err
	}
	out, err := runHelperEnv(ctx, name, h.Argv, h.Env, prompt)
	if h.Cleanup != nil {
		if argv := h.Cleanup(out); len(argv) > 0 {
			// Best effort, after the answer: the person's session list should not fill with helper runs.
			go func() {
				cctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
				defer cancel()
				if _, err := runHelperEnv(cctx, name+" cleanup", argv, nil, ""); err != nil {
					log.Printf("helper cleanup (%s): %v", strings.Join(argv, " "), err)
				}
			}()
		}
	}
	if err != nil {
		return nil, err
	}
	return h.Normalize(out)
}

// runHelperRaw runs argv in a fresh empty directory, the prompt on stdin, and returns stdout.
func runHelperRaw(ctx context.Context, name string, argv []string, prompt string) ([]byte, error) {
	return runHelperEnv(ctx, name, argv, nil, prompt)
}

// runHelperEnv is runHelperRaw with variables added to the environment.
func runHelperEnv(ctx context.Context, name string, argv, env []string, prompt string) ([]byte, error) {
	dir, err := os.MkdirTemp("", "minbox-helper-")
	if err != nil {
		return nil, errors.New("no temp directory")
	}
	defer os.RemoveAll(dir)
	cmd := exec.CommandContext(ctx, argv[0], argv[1:]...)
	cmd.Dir = dir
	if len(env) > 0 {
		cmd.Env = append(os.Environ(), env...)
	}
	cmd.Stdin = strings.NewReader(prompt)
	var out, errb bytes.Buffer
	cmd.Stdout, cmd.Stderr = &out, &errb
	cmd.WaitDelay = 2 * time.Second
	if err := cmd.Run(); err != nil {
		switch {
		case errors.Is(ctx.Err(), context.DeadlineExceeded):
			return nil, fmt.Errorf("%s took too long", name)
		case errors.Is(err, exec.ErrNotFound), errors.Is(err, os.ErrNotExist):
			return nil, fmt.Errorf("%s was not found", name)
		}
		return nil, fmt.Errorf("%s failed: %s", name, truncRunes(strings.TrimSpace(firstNonEmpty(errb.String(), err.Error())), 120))
	}
	return out.Bytes(), nil
}

// GET /api/threads/{id}/suggestions
func (s *Server) threadSuggestions(w http.ResponseWriter, r *http.Request) {
	empty := func(res SuggestResult) {
		if res.Questions == nil {
			res.Questions = []ReplyQuestion{}
		}
		writeJSON(w, 200, res)
	}
	id := r.PathValue("id")
	th, err := s.store.GetThread(r.Context(), id)
	if err != nil {
		storeError(w, err)
		return
	}
	st, err := s.settings(r.Context())
	if err != nil {
		storeError(w, err)
		return
	}
	if on, _ := st["reply_suggestions"].(bool); !on {
		empty(SuggestResult{Reason: "disabled"})
		return
	}
	n := len(th.Messages)
	if n == 0 || th.Messages[n-1].Author != store.AuthorAgent {
		empty(SuggestResult{Reason: "not_needed"})
		return
	}
	key := id + ":" + th.Messages[n-1].ID
	ctx, cancel := context.WithTimeout(r.Context(), suggestWait)
	defer cancel()
	res, fresh, err := s.suggest.get(ctx, key, buildSuggestPrompt(th))
	res.Command = bangCommand(res.Command) // the helper's command only when it reads as one
	// A command the person denied the agent: offered as "!command" without asking the helper.
	if denied := deniedCommandSuggestion(th.Messages[n-1].Body); denied != "" {
		if err != nil {
			res, err = replyHelp{}, nil
		}
		res = withDeniedCommand(denied, res)
	}
	if err != nil {
		if errors.Is(err, agent.ErrNoneInstalled) {
			// No coding agent on this machine: the feature is off, not broken.
			empty(SuggestResult{Reason: "no_agent"})
			return
		}
		empty(SuggestResult{Error: err.Error()})
		return
	}
	if fresh {
		s.hub.publish(Event{Type: "suggestions", SessionID: th.SessionID, ThreadID: id})
	}
	empty(SuggestResult{Questions: res.Questions, Command: res.Command})
}
