package agent

import (
	"bytes"
	"fmt"

	"github.com/ryotarai/minbox/internal/hostfs"
)

// claude is Claude Code with the minbox mod (plugin/minbox).
type claude struct{}

func (claude) Kind() string     { return Claude }
func (claude) Label() string    { return "Claude Code" }
func (claude) Tools() ToolNames { return ToolNames{Prefix: "mcp__minbox__"} }
func (claude) Caps() Caps {
	return Caps{Subagents: true, PreassignedID: true, RemoteHosts: true, Completions: true}
}

func (claude) Env(ArgvReq) []string      { return nil }
func (claude) NewConversationID() string { return NewUUID() }

// Argv: the person's claude command, our mod, and the conversation id (a new one, or --resume of
// the existing one), then the instructions when given (none: the mod puts them in the system
// prompt itself, as a prompt section it keeps up to date).
func (claude) Argv(req ArgvReq) []string {
	argv := append([]string{}, req.Command...)
	argv = append(argv, "--plugin-dir", req.Extension)
	if req.Resume && req.ConversationID != "" {
		argv = append(argv, "--resume", req.ConversationID)
	} else if req.ConversationID != "" {
		argv = append(argv, "--session-id", req.ConversationID)
	}
	if req.Instructions == "" {
		return argv
	}
	return append(argv, "--append-system-prompt", req.Instructions)
}

// RelocationNote: Claude Code keys a conversation by its folder, so the old one cannot be resumed
// in the new folder; its transcript can be read.
func (claude) RelocationNote(r Relocation) string {
	if r.Prev.Dir == "" || r.Prev.ConversationID == "" {
		return ""
	}
	note := fmt.Sprintf(`# minbox: this thread moved to a new folder
The project's folder changed, so this session now runs in %s. It was worked on before in %s, as Claude Code session %s. That earlier conversation cannot be resumed from here, but its transcript can be read (it is JSON lines) at ~/.claude/projects/%s/%s.jsonl (under $CLAUDE_CONFIG_DIR instead of ~/.claude when that is set). If it is not there, look for ~/.claude/projects/*/%s.jsonl. Read it only when you need what was said or done before, for example when the person refers to earlier work; the files themselves are now where the project's folder points.`,
		r.Cwd, r.Prev.Dir, r.Prev.ConversationID, hostfs.ProjectDirName(r.Prev.Dir), r.Prev.ConversationID, r.Prev.ConversationID)
	if len(r.Chain) > 0 {
		note += "\nEven earlier conversations of this thread (oldest first; transcripts are found the same way):"
		for _, c := range r.Chain {
			note += fmt.Sprintf("\n- %s, Claude Code session %s", c.Dir, c.ConversationID)
		}
	}
	return note
}

// Headless: a tool-less, session-less, settings-less `claude -p` run with a JSON schema; its
// `--output-format json` envelope is what the parsers read.
func (claude) Headless(spec HeadlessSpec) Headless {
	base := spec.Command
	if len(base) == 0 {
		base = []string{"claude"}
	}
	model := spec.Model
	if model == "" {
		model = "haiku"
	}
	argv := append([]string{}, base...)
	argv = append(argv,
		"-p",
		"--model", model,
		"--effort", "low",
		"--system-prompt", spec.System,
		"--tools", "",
		"--no-session-persistence",
		"--setting-sources", "",
		"--strict-mcp-config",
		"--disable-slash-commands",
		"--output-format", "json",
		"--json-schema", spec.Schema,
	)
	return Headless{Argv: argv, Normalize: func(out []byte) ([]byte, error) { return bytes.TrimSpace(out), nil }}
}
