// Package agent is minbox's model of the coding agents it runs in a terminal: Claude Code, Pi and
// OpenCode.
//
// Everything the server does that depends on which agent runs a session sits behind the Agent
// interface: the command line, the names of the tools minbox registers, where the agent keeps its
// conversations (for the folder-change note), and how a one-shot, tool-less "headless" run is made
// (reply suggestions, Slack project pick). The terminal host, threads, questions, the queue and
// the HTTP API the agents call (/api/agent/*) know nothing of the agent kind.
//
// See docs/agents.md for how to add an agent.
package agent

import (
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"os/exec"
	"strings"
)

// Agent kinds. A session's kind is stored in sessions.agent.
const (
	Claude   = "claude"
	Pi       = "pi"
	OpenCode = "opencode"
)

// Kinds lists the supported agents in the order they are preferred when nothing is configured.
var Kinds = []string{Claude, Pi, OpenCode}

// ToolNames are the names the agent sees for the tools minbox registers (the instructions text
// is written with Claude's names and rewritten with these).
type ToolNames struct {
	// Prefix is what precedes a tool's bare name: "mcp__minbox__" for Claude Code, "minbox_" for Pi.
	Prefix string
}

// Name is the agent-side name of a minbox tool ("send_message" -> "mcp__minbox__send_message").
func (t ToolNames) Name(tool string) string { return t.Prefix + tool }

// Caps says what an agent can do; the web UI uses it to show only what applies.
type Caps struct {
	// Subagents: the agent can run subagents, so the orchestrator prompt makes sense.
	Subagents bool `json:"subagents"`
	// PreassignedID: the server may choose the conversation id before the agent starts.
	PreassignedID bool `json:"preassigned_id"`
	// RemoteHosts: sessions of this agent can run on hosts other than the server's machine.
	RemoteHosts bool `json:"remote_hosts"`
	// Completions: ~/.claude style agent/skill/command completions exist for it.
	Completions bool `json:"completions"`
	// MovableConversation: a conversation can follow the project to a new folder (OpenCode moves a
	// session). Without it a folder change starts a fresh conversation and RelocationNote points back.
	MovableConversation bool `json:"movable_conversation,omitempty"`
}

// ArgvReq is what an agent needs to build its command line.
type ArgvReq struct {
	// Command is the person's command for the agent (MINBOX_CLAUDE / MINBOX_PI), already split.
	Command []string
	// Extension is the minbox integration to load: the folder of the Claude Code mod
	// (--plugin-dir), the path of the Pi extension file (-e), or the folder of the OpenCode plugin
	// (a "plugins" entry of OPENCODE_CONFIG_CONTENT). On a remote host it is a placeholder.
	Extension string
	// ExtraExtensions are further extension files for Pi (each loaded with its own -e), such as
	// the subagent extension. Claude Code ignores them.
	ExtraExtensions []string
	// ConversationID is the agent's conversation id ("" lets the agent choose).
	ConversationID string
	// Resume: the conversation exists and is to be continued.
	Resume bool
	// Instructions is the text minbox adds to the agent's system prompt.
	Instructions string
	// Cwd is the session's folder (OpenCode's plugin moves the conversation there if it is elsewhere).
	Cwd string
	// BaseEnv is the environment the agent starts from (the server's, cleaned), for Env to merge
	// with (OpenCode: an OPENCODE_CONFIG_CONTENT the person already sets).
	BaseEnv []string
}

// Prev is a conversation left behind in a folder the project used to have.
type Prev struct {
	Dir            string
	ConversationID string
}

// Relocation is the input of the "this thread moved" note.
type Relocation struct {
	Cwd   string // where the session runs now
	Prev  Prev   // the conversation before the last move
	Chain []Prev // the ones before that, oldest first
}

// HeadlessSpec describes a one-shot run without tools, session or settings that must answer in JSON.
type HeadlessSpec struct {
	// Command is the executable (and its leading arguments).
	Command []string
	// Model asks for a model; "" lets the agent use its own default.
	Model string
	// System is the system prompt.
	System string
	// Schema is the JSON Schema of the answer. Claude enforces it; Pi cannot, so the prompt must
	// also ask for JSON, and the answer is parsed leniently (see Headless.Normalize).
	Schema string
}

// Headless is how to run a HeadlessSpec.
type Headless struct {
	// Argv is the command line; the prompt goes on stdin.
	Argv []string
	// Normalize turns the command's stdout into the envelope parseSuggestions/parsePick read:
	// {"structured_output": <the answer>} (or Claude's own envelope, passed through).
	Normalize func(stdout []byte) ([]byte, error)
	// Env is added to the environment of the run (OpenCode: the helper agent's configuration).
	Env []string
	// Cleanup, if set, is a command to run after the run, given its stdout (OpenCode: delete the
	// session the run left in the person's session list). Best effort; nil for none.
	Cleanup func(stdout []byte) []string
}

// Agent is one coding agent minbox can run.
type Agent interface {
	// Kind is "claude", "pi" or "opencode".
	Kind() string
	// Label is the name shown to people.
	Label() string
	Tools() ToolNames
	Caps() Caps
	// Argv is the command line of an interactive session.
	Argv(req ArgvReq) []string
	// Env is what the agent needs in its environment besides minbox's MINBOX_* variables (OpenCode:
	// the plugin's configuration and the conversation id). nil for none.
	Env(req ArgvReq) []string
	// NewConversationID is a fresh conversation id in the agent's own format.
	NewConversationID() string
	// RelocationNote tells a session whose project folder changed where its earlier conversations are.
	RelocationNote(r Relocation) string
	// Headless is the one-shot, JSON-answering run used by the helper features.
	Headless(spec HeadlessSpec) Headless
}

// For returns the agent of a kind ("" is Claude Code, the original agent).
func For(kind string) (Agent, error) {
	switch kind {
	case "", Claude:
		return claude{}, nil
	case Pi:
		return pi{}, nil
	case OpenCode:
		return opencode{}, nil
	}
	return nil, fmt.Errorf("unknown agent: %s (use %s)", kind, strings.Join(Kinds, ", "))
}

// Must is For for kinds already validated (it falls back to Claude Code).
func Must(kind string) Agent {
	a, err := For(kind)
	if err != nil {
		return claude{}
	}
	return a
}

// Valid reports whether kind names an agent ("" does not).
func Valid(kind string) bool {
	for _, k := range Kinds {
		if k == kind {
			return true
		}
	}
	return false
}

// Info is what the API says of one agent.
type Info struct {
	Kind      string `json:"kind"`
	Label     string `json:"label"`
	Installed bool   `json:"installed"`
	Command   string `json:"command"` // as configured, e.g. "claude" or "pi --model x"
	Path      string `json:"path"`    // where the executable was found ("" if not found)
	Caps      Caps   `json:"caps"`
	// Version is the agent's version where minbox reads it (OpenCode only; "" otherwise or unknown).
	Version string `json:"version,omitempty"`
	// Supported is false for an installed agent minbox cannot run (OpenCode 1.x); Reason says why.
	Supported bool   `json:"supported"`
	Reason    string `json:"reason,omitempty"`
}

// Commands holds the configured command of each agent.
type Commands map[string][]string

// Lookup finds the executable of an agent's command on PATH ("" and false if it is not installed).
// It never runs the agent.
func (c Commands) Lookup(kind string) (string, bool) {
	cmd := c[kind]
	if len(cmd) == 0 {
		return "", false
	}
	p, err := exec.LookPath(cmd[0])
	if err != nil {
		return "", false
	}
	return p, true
}

// Installed reports whether the agent's executable is on this machine.
func (c Commands) Installed(kind string) bool {
	_, ok := c.Lookup(kind)
	return ok
}

// Support reports whether minbox can run the installed agent of a kind, the version it read (OpenCode)
// and, when it cannot, why. Claude Code and Pi are not run to find out: installed is supported.
func (c Commands) Support(kind string) (version string, ok bool, reason string) {
	p, installed := c.Lookup(kind)
	if !installed {
		return "", false, "not installed"
	}
	if kind == OpenCode {
		return OpenCodeSupport(p)
	}
	return "", true, ""
}

// Usable reports whether the agent is installed and minbox can run it.
func (c Commands) Usable(kind string) bool {
	_, ok, _ := c.Support(kind)
	return ok
}

// Infos describes every agent, in Kinds order.
func (c Commands) Infos() []Info {
	var out []Info
	for _, k := range Kinds {
		a := Must(k)
		p, ok := c.Lookup(k)
		info := Info{Kind: k, Label: a.Label(), Installed: ok, Command: strings.Join(c[k], " "), Path: p, Caps: a.Caps()}
		if ok {
			info.Version, info.Supported, info.Reason = c.Support(k)
		}
		out = append(out, info)
	}
	return out
}

// Choose picks the agent to use: preferred if it is usable (installed and supported), else the first
// usable one in Kinds order, else preferred (or Claude Code) so a start can fail with a message that
// names the command.
func (c Commands) Choose(preferred string) string {
	if Valid(preferred) && c.Usable(preferred) {
		return preferred
	}
	for _, k := range Kinds {
		if c.Usable(k) {
			return k
		}
	}
	if Valid(preferred) {
		return preferred
	}
	return Claude
}

// ErrNoneInstalled is the error of a helper run when no coding agent is installed.
var ErrNoneInstalled = errors.New("no coding agent (claude, pi or opencode) is installed")

// NotInstalledError names the command that is missing, or says why the installed one cannot run.
func (c Commands) NotInstalledError(kind string) error {
	a := Must(kind)
	cmd := strings.Join(c[kind], " ")
	if cmd == "" {
		cmd = kind
	}
	if c.Installed(kind) {
		if _, ok, reason := c.Support(kind); !ok {
			return fmt.Errorf("%s cannot be used: %s", a.Label(), reason)
		}
	}
	return fmt.Errorf("%s is not installed (looked for %q on PATH)", a.Label(), cmd)
}

// jsonObjectIn finds the first JSON object in text a model wrote: the whole text, a fenced block,
// or the first {...} that parses. It returns nil if there is none.
func jsonObjectIn(text string) json.RawMessage {
	text = strings.TrimSpace(text)
	try := func(s string) json.RawMessage {
		s = strings.TrimSpace(s)
		if !strings.HasPrefix(s, "{") {
			return nil
		}
		dec := json.NewDecoder(strings.NewReader(s))
		var raw json.RawMessage
		if err := dec.Decode(&raw); err != nil {
			return nil
		}
		return raw
	}
	if r := try(text); r != nil {
		return r
	}
	// A fenced block: ```json ... ```
	for rest := text; ; {
		i := strings.Index(rest, "```")
		if i < 0 {
			break
		}
		rest = rest[i+3:]
		if nl := strings.IndexByte(rest, '\n'); nl >= 0 && !strings.ContainsAny(rest[:nl], "{}") {
			rest = rest[nl+1:]
		}
		if r := try(rest); r != nil {
			return r
		}
	}
	for i := 0; i < len(text); i++ {
		if text[i] == '{' {
			if r := try(text[i:]); r != nil {
				return r
			}
		}
	}
	return nil
}

// NewUUID is a random (version 4) UUID, the conversation id format of Claude Code and Pi.
func NewUUID() string {
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
}
