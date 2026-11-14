package agent

import (
	"bufio"
	"bytes"
	"context"
	"crypto/rand"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"math/big"
	"os"
	"os/exec"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

// opencode is OpenCode 2.x (https://opencode.ai, "V2"), an interactive TUI in the terminal with the
// minbox plugin (plugin/opencode) loaded through OPENCODE_CONFIG_CONTENT.
//
// Verified against OpenCode 2.1.4 in an isolated environment with a mock model (docs/opencode.md):
// --standalone runs a private server per process whose plugins see the CLI's environment;
// a "plugins" entry of OPENCODE_CONFIG_CONTENT with an absolute folder loads the plugin next to the
// person's own configuration; --session <id> opens an existing session; `opencode api --standalone`
// reads and creates sessions (session.get, session.create with a chosen id); `run --format json`
// prints JSON lines and reads the prompt from stdin.
type opencode struct{}

func (opencode) Kind() string     { return OpenCode }
func (opencode) Label() string    { return "OpenCode" }
func (opencode) Tools() ToolNames { return ToolNames{Prefix: "minbox_"} }

// Caps: OpenCode has subagents (its `subagent` tool, general and explore), takes a conversation id
// chosen by minbox (--session; minbox creates the session first, see OpenCodeEnsureSession), can move
// a session to another folder (the plugin does it at startup), and runs on the server's machine only
// for now.
func (opencode) Caps() Caps {
	return Caps{Subagents: true, PreassignedID: true, MovableConversation: true}
}

// NewConversationID: OpenCode's session id format, "ses_" + 12 hex digits + 14 base62 characters.
// Like OpenCode's own session ids the hex part counts down with time, so newer sessions sort first.
func (opencode) NewConversationID() string { return NewOpenCodeSessionID(time.Now()) }

var ocIDMu sync.Mutex
var ocIDLast int64
var ocIDCount int64

// NewOpenCodeSessionID makes a session id the way OpenCode does: the low 48 bits of
// (milliseconds*4096 + a counter), inverted (descending), in hex, then 14 random base62 characters.
func NewOpenCodeSessionID(now time.Time) string {
	ms := now.UnixMilli()
	ocIDMu.Lock()
	if ms != ocIDLast {
		ocIDLast, ocIDCount = ms, 0
	}
	ocIDCount++
	n := ms*0x1000 + ocIDCount
	ocIDMu.Unlock()
	var b [8]byte
	binary.BigEndian.PutUint64(b[:], ^uint64(n))
	const alphabet = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"
	tail := make([]byte, 14)
	for i := range tail {
		v, err := rand.Int(rand.Reader, big.NewInt(int64(len(alphabet))))
		if err != nil {
			v = big.NewInt(int64(i))
		}
		tail[i] = alphabet[v.Int64()]
	}
	return fmt.Sprintf("ses_%x%s", b[2:], tail)
}

// openCodeIDRe is a session id OpenCode accepts (and one minbox can put on a command line safely).
var openCodeIDRe = regexp.MustCompile(`^ses_[0-9A-Za-z]{26}$`)

// ValidOpenCodeSessionID reports whether id looks like an OpenCode session id.
func ValidOpenCodeSessionID(id string) bool { return openCodeIDRe.MatchString(id) }

// Argv: the person's opencode command, a private server (--standalone: the shared background service
// would not see this session's environment, so not the plugin's either), auto-approval of anything
// not explicitly denied (minbox's default, as with Pi), and the conversation. Instructions are not on
// the command line (OpenCode has no such flag): the plugin gets them in its hello and adds them to the
// system prompt of every model request of this session.
func (opencode) Argv(req ArgvReq) []string {
	argv := append([]string{}, req.Command...)
	if !hasFlag(req.Command, "--standalone") {
		argv = append(argv, "--standalone")
	}
	if !hasFlag(req.Command, "--auto") {
		argv = append(argv, "--auto")
	}
	if req.ConversationID != "" {
		argv = append(argv, "--session", req.ConversationID)
	}
	return argv
}

func hasFlag(argv []string, flag string) bool {
	for _, a := range argv {
		if a == flag || strings.HasPrefix(a, flag+"=") {
			return true
		}
	}
	return false
}

// Env: the plugin (a "plugins" entry of OPENCODE_CONFIG_CONTENT, merged into one the person already
// sets), the session it serves and the folder the session belongs in.
func (opencode) Env(req ArgvReq) []string {
	var env []string
	if req.Extension != "" {
		env = append(env, "OPENCODE_CONFIG_CONTENT="+openCodePluginConfig(envValue(req.BaseEnv, "OPENCODE_CONFIG_CONTENT"), req.Extension))
	}
	if req.ConversationID != "" {
		env = append(env, "MINBOX_OPENCODE_SESSION="+req.ConversationID)
	}
	if req.Cwd != "" {
		env = append(env, "MINBOX_OPENCODE_DIR="+req.Cwd)
	}
	return env
}

func envValue(env []string, key string) string {
	v := ""
	for _, kv := range env {
		if strings.HasPrefix(kv, key+"=") {
			v = kv[len(key)+1:] // the last one wins, as in exec
		}
	}
	return v
}

// openCodePluginConfig adds the plugin folder to the "plugins" of an existing OPENCODE_CONFIG_CONTENT
// (plain JSON). One that is not plain JSON (JSONC with comments, say) cannot be merged and is replaced.
func openCodePluginConfig(existing, pluginDir string) string {
	cfg := map[string]any{}
	if strings.TrimSpace(existing) != "" {
		if err := json.Unmarshal([]byte(existing), &cfg); err != nil || cfg == nil {
			cfg = map[string]any{}
		}
	}
	plugins, _ := cfg["plugins"].([]any)
	cfg["plugins"] = append(plugins, map[string]any{"package": pluginDir})
	b, _ := json.Marshal(cfg)
	return string(b)
}

// RelocationNote: none. OpenCode moves the session itself (the plugin moves it to the new folder at
// startup), so the conversation goes on in the new folder with its history.
func (opencode) RelocationNote(Relocation) string { return "" }

// openCodeHelperAgent is the agent of helper runs (defined in the run's OPENCODE_CONFIG_CONTENT).
const openCodeHelperAgent = "minbox-helper"

// Headless: `opencode run --standalone --format json` with a hidden agent of its own whose system
// prompt is the helper's and whose permissions deny every tool (OpenCode has no tool-less flag); the
// prompt comes on stdin. OpenCode cannot enforce a schema either, so the answer is read leniently, as
// for Pi. --title skips the title model call. The run leaves a session behind: Cleanup deletes it.
func (opencode) Headless(spec HeadlessSpec) Headless {
	base := spec.Command
	if len(base) == 0 {
		base = []string{"opencode"}
	}
	system := spec.System
	if spec.Schema != "" {
		system += "\nYour whole reply must be one JSON object that matches this JSON Schema, and nothing else (no prose, no code fence):\n" + spec.Schema
	}
	cfg, _ := json.Marshal(map[string]any{"agents": map[string]any{openCodeHelperAgent: map[string]any{
		"mode":        "primary",
		"hidden":      true,
		"system":      system,
		"permissions": []map[string]string{{"action": "*", "resource": "*", "effect": "deny"}},
	}}})
	argv := append([]string{}, base...)
	argv = append(argv, "run", "--standalone", "--format", "json", "--agent", openCodeHelperAgent, "--title", "minbox helper")
	if spec.Model != "" {
		argv = append(argv, "--model", spec.Model)
	}
	return Headless{
		Argv: argv,
		Env:  []string{"OPENCODE_CONFIG_CONTENT=" + string(cfg)},
		Normalize: func(out []byte) ([]byte, error) {
			text, _, err := OpenCodeRunText(out)
			if err != nil {
				return nil, err
			}
			raw := jsonObjectIn(text)
			if raw == nil {
				return nil, errors.New("opencode printed no JSON")
			}
			return json.Marshal(map[string]json.RawMessage{"structured_output": raw})
		},
		Cleanup: func(out []byte) []string {
			_, id, _ := OpenCodeRunText(out)
			if !ValidOpenCodeSessionID(id) {
				return nil
			}
			return append(append([]string{}, base...), "session", "delete", "--standalone", id)
		},
	}
}

// OpenCodeRunText reads the JSON lines of `opencode run --format json`: the text of the answer (the
// "text" parts, in order) and the session id. An "error" line is an error.
func OpenCodeRunText(out []byte) (text, sessionID string, err error) {
	var parts []string
	sc := bufio.NewScanner(bytes.NewReader(out))
	sc.Buffer(make([]byte, 0, 64*1024), 8*1024*1024)
	for sc.Scan() {
		line := bytes.TrimSpace(sc.Bytes())
		if len(line) == 0 || line[0] != '{' {
			continue
		}
		var ev struct {
			Type      string `json:"type"`
			SessionID string `json:"sessionID"`
			Part      struct {
				Type string `json:"type"`
				Text string `json:"text"`
			} `json:"part"`
			Error json.RawMessage `json:"error"`
		}
		if json.Unmarshal(line, &ev) != nil {
			continue
		}
		if sessionID == "" {
			sessionID = ev.SessionID
		}
		switch ev.Type {
		case "text":
			parts = append(parts, ev.Part.Text)
		case "error":
			msg := strings.TrimSpace(string(ev.Error))
			if msg == "" {
				msg = string(line)
			}
			if len(msg) > 200 {
				msg = msg[:200]
			}
			err = fmt.Errorf("opencode reported an error: %s", msg)
		}
	}
	if len(parts) == 0 && err == nil {
		err = errors.New("opencode printed no answer")
	}
	if len(parts) > 0 {
		err = nil
	}
	return strings.Join(parts, "\n"), sessionID, err
}

// ---- version ----

var versionRe = regexp.MustCompile(`(\d+)\.(\d+)\.(\d+)`)

// OpenCodeVersionProbe runs `<path> --version` and returns what it printed. Replaced in tests. For a
// session on another machine (not supported yet) the same command would run there.
var OpenCodeVersionProbe = func(path string) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, path, "--version")
	cmd.Stdin = nil
	out, err := cmd.Output()
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(string(out)), nil
}

type versionEntry struct {
	key           string
	version       string
	ok            bool
	reason        string
	checkedAt     time.Time
	probeFailedAt time.Time
}

var versionMu sync.Mutex
var versionCache = map[string]versionEntry{}

// ResetOpenCodeVersionCache forgets the versions read so far (tests).
func ResetOpenCodeVersionCache() {
	versionMu.Lock()
	versionCache = map[string]versionEntry{}
	versionMu.Unlock()
}

// OpenCodeSupport says whether the opencode executable at path is a version minbox runs (2.x): its
// version, ok, and the reason when not. The answer is cached per executable (path, size, mtime), so an
// upgrade is noticed; a failed probe is retried after a minute.
func OpenCodeSupport(path string) (version string, ok bool, reason string) {
	key := path
	if st, err := os.Stat(path); err == nil {
		key = fmt.Sprintf("%s|%d|%d", path, st.Size(), st.ModTime().UnixNano())
	}
	versionMu.Lock()
	e, hit := versionCache[path]
	versionMu.Unlock()
	if hit && e.key == key && (e.probeFailedAt.IsZero() || time.Since(e.probeFailedAt) < time.Minute) {
		return e.version, e.ok, e.reason
	}
	out, err := OpenCodeVersionProbe(path)
	e = versionEntry{key: key, checkedAt: time.Now()}
	if err != nil {
		e.reason = fmt.Sprintf("`%s --version` failed (%v)", path, err)
		e.probeFailedAt = time.Now()
	} else {
		e.version, e.ok, e.reason = judgeOpenCodeVersion(out)
	}
	versionMu.Lock()
	versionCache[path] = e
	versionMu.Unlock()
	return e.version, e.ok, e.reason
}

// judgeOpenCodeVersion reads `opencode --version` output ("opencode v2.1.4", or "1.0.0" for V1).
func judgeOpenCodeVersion(out string) (version string, ok bool, reason string) {
	m := versionRe.FindStringSubmatch(out)
	if m == nil {
		return "", false, fmt.Sprintf("could not read the version from %q", truncate(out, 80))
	}
	version = m[0]
	major, _ := strconv.Atoi(m[1])
	if major < 2 {
		return version, false, fmt.Sprintf("OpenCode %s is OpenCode 1.x; minbox needs OpenCode 2 (V2), whose plugins differ. Install V2 (curl -fsSL https://opencode.ai/v2/install | bash) — it uses the same opencode command", version)
	}
	return version, true, ""
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "…"
}

// ---- sessions (through the OpenCode CLI, never its database) ----

// Runner runs a command for a session's machine: argv in dir with env added, stdin as input, and
// returns stdout (and stderr folded into the error). Today only the local machine has one
// (LocalRunner); a remote host would run the same command there.
type Runner func(ctx context.Context, argv []string, dir string, env []string, stdin string) ([]byte, error)

// ExitError is a command that ran and failed: its exit code and output.
type ExitError struct {
	Code   int
	Stdout []byte
	Stderr string
}

func (e *ExitError) Error() string {
	msg := strings.TrimSpace(e.Stderr)
	if msg == "" {
		msg = strings.TrimSpace(string(e.Stdout))
	}
	return fmt.Sprintf("exit %d: %s", e.Code, truncate(msg, 200))
}

// LocalRunner runs the command on this machine.
func LocalRunner(ctx context.Context, argv []string, dir string, env []string, stdin string) ([]byte, error) {
	cmd := exec.CommandContext(ctx, argv[0], argv[1:]...)
	cmd.Dir = dir
	cmd.Env = append(os.Environ(), env...)
	cmd.Stdin = strings.NewReader(stdin)
	var out, errb bytes.Buffer
	cmd.Stdout, cmd.Stderr = &out, &errb
	cmd.WaitDelay = 2 * time.Second
	err := cmd.Run()
	if err != nil {
		var ee *exec.ExitError
		if errors.As(err, &ee) {
			return out.Bytes(), &ExitError{Code: ee.ExitCode(), Stdout: out.Bytes(), Stderr: errb.String()}
		}
		return out.Bytes(), err
	}
	return out.Bytes(), nil
}

// OpenCodeSessionDir reports whether OpenCode has session id and the folder it belongs to:
// `opencode api --standalone session.get` (a private server; OpenCode's database is never read
// directly). A missing session is (false, "", nil); any other failure is an error.
func OpenCodeSessionDir(ctx context.Context, run Runner, command []string, dir, id string) (bool, string, error) {
	if !ValidOpenCodeSessionID(id) {
		return false, "", nil
	}
	argv := append(openCodeBase(command), "api", "--standalone", "session.get", "--param", "sessionID="+id)
	out, err := run(ctx, argv, dir, nil, "")
	if err != nil {
		var ee *ExitError
		if errors.As(err, &ee) && bytes.Contains(append(ee.Stdout, ee.Stderr...), []byte("NotFound")) {
			return false, "", nil
		}
		return false, "", err
	}
	var got struct {
		Data struct {
			ID       string `json:"id"`
			Location struct {
				Directory string `json:"directory"`
			} `json:"location"`
		} `json:"data"`
	}
	if err := json.Unmarshal(bytes.TrimSpace(out), &got); err != nil || got.Data.ID != id {
		return false, "", fmt.Errorf("unexpected answer from opencode api: %s", truncate(string(out), 120))
	}
	return true, got.Data.Location.Directory, nil
}

// OpenCodeEnsureSession makes sure session id exists, creating it in dir when it does not
// (`opencode api --standalone session.create` with the id). The TUI shows a session given with
// --session only when it exists at startup; for a missing one it shows its home screen and turns the
// plugin starts do not appear. created reports a new session; existingDir is the folder of an
// existing one (the plugin moves it to the session's folder when they differ).
func OpenCodeEnsureSession(ctx context.Context, run Runner, command []string, dir, id string) (created bool, existingDir string, err error) {
	if !ValidOpenCodeSessionID(id) {
		return false, "", fmt.Errorf("not an OpenCode session id: %q", id)
	}
	exists, at, err := OpenCodeSessionDir(ctx, run, command, dir, id)
	if err != nil {
		return false, "", err
	}
	if exists {
		return false, at, nil
	}
	body, _ := json.Marshal(map[string]any{"id": id, "location": map[string]string{"directory": dir}})
	argv := append(openCodeBase(command), "api", "--standalone", "session.create", "-d", string(body))
	if _, err := run(ctx, argv, dir, nil, ""); err != nil {
		return false, "", err
	}
	return true, "", nil
}

// openCodeBase is the executable of the person's opencode command (their flags are TUI flags).
func openCodeBase(command []string) []string {
	if len(command) == 0 {
		return []string{"opencode"}
	}
	return []string{command[0]}
}
