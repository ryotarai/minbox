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

// Reply suggestions: up to three short replies the person could send next, drafted by Haiku.
// See docs/api-contract.md ("Reply suggestions").

const (
	suggestMax        = 3
	suggestMaxLen     = 200  // runes per suggestion
	suggestMsgCount   = 12   // messages of the thread in the prompt
	suggestMsgLen     = 1500 // runes per message
	suggestRunTimeout = 45 * time.Second
	suggestWait       = 50 * time.Second // how long the endpoint waits for a run
	suggestCacheSize  = 200
	suggestCacheTTL   = time.Hour
	suggestParallel   = 2
)

const suggestSystemPrompt = "You draft replies. Output only JSON matching the schema."

const suggestSchema = `{"type":"object","properties":{"suggestions":{"type":"array","minItems":0,"maxItems":3,"items":{"type":"string","maxLength":200}}},"required":["suggestions"],"additionalProperties":false}`

// SuggestResult is the endpoint's answer.
type SuggestResult struct {
	Suggestions []string `json:"suggestions"`
	Reason      string   `json:"reason,omitempty"` // not_needed | disabled | no_agent (no coding agent is installed)
	Error       string   `json:"error,omitempty"`
}

type suggestEntry struct {
	key     string
	res     []string
	expires time.Time
}

type suggestCall struct {
	done chan struct{}
	res  []string
	err  error
}

// suggester runs the generator: cache per (thread, last message), one run per key, two at a time.
type suggester struct {
	// run turns a prompt into suggestions. Replaced in tests.
	run func(ctx context.Context, prompt string) ([]string, error)
	// timeout bounds one run (including the wait for a free slot).
	timeout time.Duration

	mu       sync.Mutex
	cache    map[string]*list.Element
	order    *list.List // front = most recent
	inflight map[string]*suggestCall
	sem      chan struct{}
	now      func() time.Time
}

func newSuggester(run func(ctx context.Context, prompt string) ([]string, error)) *suggester {
	return &suggester{run: run, timeout: suggestRunTimeout, cache: map[string]*list.Element{}, order: list.New(), inflight: map[string]*suggestCall{}, sem: make(chan struct{}, suggestParallel), now: time.Now}
}

func (g *suggester) cached(key string) ([]string, bool) {
	g.mu.Lock()
	defer g.mu.Unlock()
	el, ok := g.cache[key]
	if !ok {
		return nil, false
	}
	e := el.Value.(*suggestEntry)
	if g.now().After(e.expires) {
		g.order.Remove(el)
		delete(g.cache, key)
		return nil, false
	}
	g.order.MoveToFront(el)
	return e.res, true
}

func (g *suggester) put(key string, res []string) {
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

// get returns the suggestions for key, running the generator once however many callers ask.
// Errors are not cached. fresh reports that this call started the run that produced the result.
func (g *suggester) get(ctx context.Context, key, prompt string) (res []string, fresh bool, err error) {
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
				c.res, c.err = nil, errors.New("the coding agent took too long")
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
		return nil, false, ctx.Err()
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
	b.WriteString("Task: propose up to 3 distinct, short, ready-to-send replies the PERSON could send next. " +
		"Write in the language the PERSON used above (if they wrote nothing, the agent's language). " +
		"Each under 200 characters, in the person's voice, no explanations or labels. " +
		"If the agent asked a question with options, propose the sensible answers. " +
		"If the agent reports completion, propose short follow-ups that move the work forward (a concrete next step, a request for detail or a check). " +
		"If the agent's last message says a command it wanted to run was denied or rejected and quotes that command, make one suggestion exactly '!' followed by that command (the person can then run it themselves; a message starting with '!' runs as a shell command). " +
		"Never propose thanks, praise, greetings, acknowledgements or other replies that add no instruction or information (no 'thank you', 'great', 'OK', 'got it'); " +
		"if nothing useful can be proposed, return fewer suggestions.\n")
	return b.String()
}

// ---- denied commands ----

var deniedRe = regexp.MustCompile(`(?i)\b(denied|deny|denies|rejected|reject|declined|refused|not allowed|not approved|disallowed)\b|拒否|許可されな|承認されな|却下`)
var fencedRe = regexp.MustCompile("(?s)```[a-zA-Z0-9_-]*\\n(.*?)\\n?```")
var inlineCodeRe = regexp.MustCompile("`([^`\\n]{2,})`")

// deniedCommandSuggestion: the command the agent's message says was denied, as "!command" for the
// composer, or "". It needs a denial word and one quoted command (the first one-line code block, else
// the first inline code span); a command that does not fit in a suggestion is not offered cut.
func deniedCommandSuggestion(body string) string {
	if !deniedRe.MatchString(body) {
		return ""
	}
	cmd := ""
	if m := fencedRe.FindStringSubmatch(body); m != nil {
		cmd = strings.TrimSpace(m[1])
		cmd = strings.TrimSpace(strings.TrimPrefix(cmd, "$ "))
	} else if m := inlineCodeRe.FindStringSubmatch(body); m != nil {
		cmd = strings.TrimSpace(m[1])
		cmd = strings.TrimSpace(strings.TrimPrefix(cmd, "$ "))
	}
	if cmd == "" || strings.ContainsAny(cmd, "\r\n") || utf8.RuneCountInString(cmd)+1 > suggestMaxLen {
		return ""
	}
	return "!" + cmd
}

// withDeniedCommand puts the denied command first, drops duplicates and keeps at most suggestMax.
func withDeniedCommand(denied string, rest []string) []string {
	out := []string{denied}
	for _, s := range rest {
		if strings.EqualFold(strings.TrimSpace(s), denied) {
			continue
		}
		if len(out) < suggestMax {
			out = append(out, s)
		}
	}
	return out
}

// ---- result parsing ----

// parseSuggestions reads claude's `--output-format json` envelope: structured_output.suggestions,
// else the `result` string parsed as the same JSON. Trims, dedupes, drops empties, caps count and length.
func parseSuggestions(out []byte) ([]string, error) {
	var env struct {
		IsError          bool            `json:"is_error"`
		Subtype          string          `json:"subtype"`
		Result           string          `json:"result"`
		StructuredOutput json.RawMessage `json:"structured_output"`
	}
	if err := json.Unmarshal(bytes.TrimSpace(out), &env); err != nil {
		return nil, errors.New("claude printed no JSON")
	}
	if env.IsError {
		return nil, errors.New("claude reported an error: " + truncRunes(firstNonEmpty(env.Result, env.Subtype), 120))
	}
	var body struct {
		Suggestions []any `json:"suggestions"`
	}
	raw := []byte(env.StructuredOutput)
	if len(raw) == 0 || string(raw) == "null" {
		raw = []byte(env.Result)
	}
	if err := json.Unmarshal(raw, &body); err != nil {
		return nil, errors.New("claude's answer was not the expected JSON")
	}
	var res []string
	seen := map[string]bool{}
	for _, v := range body.Suggestions {
		s, ok := v.(string)
		if !ok {
			continue
		}
		s = strings.TrimSpace(s)
		if s == "" || seen[strings.ToLower(s)] {
			continue
		}
		seen[strings.ToLower(s)] = true
		res = append(res, truncRunes(s, suggestMaxLen))
		if len(res) == suggestMax {
			break
		}
	}
	if len(res) == 0 {
		return nil, errors.New("claude returned no suggestions")
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

// runSuggest runs the helper agent for reply suggestions, the prompt on stdin.
func (s *Server) runSuggest(ctx context.Context, prompt string) ([]string, error) {
	out, err := s.runHelper(ctx, "haiku", suggestSystemPrompt, suggestSchema, prompt)
	if err != nil {
		return nil, err
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
		if res.Suggestions == nil {
			res.Suggestions = []string{}
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
	// A command the person denied the agent: offered as "!command" without asking the helper.
	denied := deniedCommandSuggestion(th.Messages[n-1].Body)
	if denied != "" {
		if err != nil {
			res, err = nil, nil
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
	empty(SuggestResult{Suggestions: res})
}
