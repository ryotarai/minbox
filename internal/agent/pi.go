package agent

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// pi is Pi (@earendil-works/pi-coding-agent 1.x), an interactive TUI in the terminal with the minbox
// extension (plugin/pi/minbox.ts) loaded by -e.
//
// What is verified (Pi 1.4.0, its docs and its code): --session-id <id> opens the conversation of
// that id in the current folder's session directory, "creating it if missing"; sessions live in
// <agent dir>/sessions/--<cwd with / \ : replaced by ->--/<timestamp>_<id>.jsonl; -p prints the
// final answer to stdout and exits; there is no JSON-schema enforcement.
// Not verified without a model: a whole turn, and sendUserMessage into an idle TUI (see docs/agents.md).
type pi struct{}

func (pi) Kind() string     { return Pi }
func (pi) Label() string    { return "Pi" }
func (pi) Tools() ToolNames { return ToolNames{Prefix: "minbox_"} }

// Caps: Pi has no subagents of its own (the orchestrator prompt is off; the minbox_subagent tool of
// plugin/pi/subagent.ts is described by a short section of the instructions instead), accepts a preassigned conversation id
// (--session-id), and in this first version runs on the server's machine only.
func (pi) Caps() Caps { return Caps{PreassignedID: true} }

// Argv: the person's pi command, the extension, the conversation (--session-id both starts a new
// one and continues an existing one), and the instructions. Pi still reads AGENTS.md and
// CLAUDE.md from the folder (no -nc): they are the project's own notes.
func (pi) Argv(req ArgvReq) []string {
	argv := append([]string{}, req.Command...)
	argv = append(argv, "-e", req.Extension)
	for _, x := range req.ExtraExtensions {
		argv = append(argv, "-e", x)
	}
	if req.ConversationID != "" {
		argv = append(argv, "--session-id", req.ConversationID)
	}
	return append(argv, "--append-system-prompt", req.Instructions)
}

// RelocationNote: Pi, like Claude Code, keeps conversations per folder, so a session that moved
// starts a new one and is told where the old one is.
func (pi) RelocationNote(r Relocation) string {
	if r.Prev.Dir == "" || r.Prev.ConversationID == "" {
		return ""
	}
	note := fmt.Sprintf(`# minbox: this thread moved to a new folder
The project's folder changed, so this session now runs in %s. It was worked on before in %s, as Pi session %s. That earlier conversation cannot be resumed from here, but its session file can be read (it is JSON lines) at ~/.pi/agent/sessions/%s/<timestamp>_%s.jsonl (under $PI_CODING_AGENT_DIR/sessions instead of ~/.pi/agent/sessions when that is set). If it is not there, look for ~/.pi/agent/sessions/*/*_%s.jsonl. Read it only when you need what was said or done before, for example when the person refers to earlier work; the files themselves are now where the project's folder points.`,
		r.Cwd, r.Prev.Dir, r.Prev.ConversationID, PiDirName(r.Prev.Dir), r.Prev.ConversationID, r.Prev.ConversationID)
	if len(r.Chain) > 0 {
		note += "\nEven earlier conversations of this thread (oldest first; session files are found the same way):"
		for _, c := range r.Chain {
			note += fmt.Sprintf("\n- %s, Pi session %s", c.Dir, c.ConversationID)
		}
	}
	return note
}

// piHeadlessPrompt is the positional message of a headless run; the real prompt arrives on stdin
// (Pi prepends piped stdin to the first prompt).
const piHeadlessPrompt = "Answer now. Reply with only the JSON object requested above, with no other text."

// Headless: `pi -p` with everything switched off. Pi cannot enforce a schema, so the system prompt
// repeats it and the answer is read leniently (the first JSON object in the output).
func (pi) Headless(spec HeadlessSpec) Headless {
	base := spec.Command
	if len(base) == 0 {
		base = []string{"pi"}
	}
	system := spec.System
	if spec.Schema != "" {
		system += "\nYour whole reply must be one JSON object that matches this JSON Schema, and nothing else (no prose, no code fence):\n" + spec.Schema
	}
	argv := append([]string{}, base...)
	argv = append(argv,
		"--print",
		"--offline",
		"--no-session",
		"--no-tools",
		"--no-extensions",
		"--no-skills",
		"--no-prompt-templates",
		"--no-context-files",
		"--no-themes",
		"--system-prompt", system,
	)
	if spec.Model != "" {
		argv = append(argv, "--model", spec.Model)
	}
	argv = append(argv, piHeadlessPrompt)
	return Headless{Argv: argv, Normalize: func(out []byte) ([]byte, error) {
		raw := jsonObjectIn(string(out))
		if raw == nil {
			return nil, errors.New("pi printed no JSON")
		}
		return json.Marshal(map[string]json.RawMessage{"structured_output": raw})
	}}
}

// PiDirName is how Pi names a folder's session directory under <agent dir>/sessions: the path
// without its leading separator, with / \ and : replaced by -, between "--" and "--".
func PiDirName(cwd string) string {
	cwd = strings.TrimLeft(cwd, `/\`)
	return "--" + strings.NewReplacer("/", "-", `\`, "-", ":", "-").Replace(cwd) + "--"
}

// PiSessionsRoot is where Pi keeps its sessions on this machine: $PI_CODING_AGENT_SESSION_DIR,
// else $PI_CODING_AGENT_DIR/sessions, else ~/.pi/agent/sessions. (A per-run --session-dir is not
// known here; minbox does not pass one.)
func PiSessionsRoot() string {
	if d := os.Getenv("PI_CODING_AGENT_SESSION_DIR"); d != "" {
		return d
	}
	if d := os.Getenv("PI_CODING_AGENT_DIR"); d != "" {
		return filepath.Join(d, "sessions")
	}
	home, err := os.UserHomeDir()
	if err != nil || home == "" {
		return ""
	}
	return filepath.Join(home, ".pi", "agent", "sessions")
}

// PiConversationFile finds the session file of conversation id on this machine: in the folder's
// own session directory first (also for the symlink-resolved folder), else in any directory (ids
// are UUIDs). It returns "" if there is none.
func PiConversationFile(root, cwd, id string) string {
	if root == "" || id == "" || strings.ContainsAny(id, `/\*?[`) {
		return ""
	}
	find := func(dir string) string {
		m, _ := filepath.Glob(filepath.Join(dir, "*_"+id+".jsonl"))
		if len(m) > 0 {
			return m[0]
		}
		return ""
	}
	if cwd != "" {
		if p := find(filepath.Join(root, PiDirName(cwd))); p != "" {
			return p
		}
		if real, err := filepath.EvalSymlinks(cwd); err == nil {
			if p := find(filepath.Join(root, PiDirName(real))); p != "" {
				return p
			}
		}
	}
	entries, err := os.ReadDir(root)
	if err != nil {
		return ""
	}
	for _, e := range entries {
		if e.IsDir() {
			if p := find(filepath.Join(root, e.Name())); p != "" {
				return p
			}
		}
	}
	return ""
}
