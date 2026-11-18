package server

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/ryotarai/minbox/internal/agent"
	"github.com/ryotarai/minbox/internal/claudetrust"
	"github.com/ryotarai/minbox/internal/hostfs"
	"github.com/ryotarai/minbox/internal/store"
	"github.com/ryotarai/minbox/internal/termhost"
)

// ProtocolVersion is the server's terminal-host protocol version.
const ProtocolVersion = 1

// RequiredHostVersion is the lowest terminal host protocol this server works with.
const RequiredHostVersion = 1

// HostConn is what the server needs from the terminal host (a *termhost.Client).
type HostConn interface {
	List(ctx context.Context) ([]termhost.TerminalInfo, error)
	Spawn(ctx context.Context, req termhost.SpawnRequest) (termhost.TerminalInfo, error)
	Kill(ctx context.Context, id string) error
	Remove(ctx context.Context, id string) error
}

// sessionManager starts, stops and resumes sessions on their hosts.
type sessionManager struct {
	// modLog and modForget feed the mod connection log (modconn.go); nil in a bare manager.
	modLog    func(id, kind, format string, args ...any)
	modForget func(id, why string)
	cfg       Config
	store     *store.Store
	hub       *hub
	hosts     *hostSet
	localFS   *hostfs.Local

	mu sync.Mutex
	// shellMu serialises starting companion shells (two attaches must not spawn twice).
	shellMu sync.Mutex
	// stopping holds sessions the person stopped: their exit is a close.
	stopping map[string]bool
	// restarting holds sessions being restarted: the exit of their old
	// terminal is not a close (see Restart).
	restarting map[string]*restartState

	// The local host's connections, for a restart of the host (hostrestart.go):
	// localConn counts them; exits on connection localQuiet are not session
	// ends (the host is being restarted); while localHold is set, Run does not
	// connect (nor start a host); localReady is closed, and replaced, after each
	// connection's Reconcile.
	localConn  int
	localQuiet int
	localHold  chan struct{}
	localReady chan struct{}
	localDrop  context.CancelFunc // ends the current connection's event stream
}

// dropLocal ends the local host connection's event stream: Run reconnects.
func (m *sessionManager) dropLocal() {
	m.mu.Lock()
	drop := m.localDrop
	m.mu.Unlock()
	if drop != nil {
		drop()
	}
}

// waitLocalHold waits while a host restart holds the connection back.
func (m *sessionManager) waitLocalHold(ctx context.Context) {
	m.mu.Lock()
	hold := m.localHold
	m.mu.Unlock()
	if hold == nil {
		return
	}
	select {
	case <-hold:
	case <-ctx.Done():
	}
}

// localConnected numbers a new connection to the local host.
func (m *sessionManager) localConnected() int {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.localConn++
	return m.localConn
}

// localReconciled tells a host restart waiting for it that a connection is reconciled.
func (m *sessionManager) localReconciled() {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.localReady != nil {
		close(m.localReady)
	}
	m.localReady = make(chan struct{})
}

// quietExit: an exit on this connection comes from a host being restarted.
func (m *sessionManager) quietExit(conn int) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	return conn != 0 && conn == m.localQuiet
}

type restartState struct {
	exited chan struct{}
	once   sync.Once
}

// errRestartInProgress is Restart's answer to a second restart of a session (HTTP 409).
var errRestartInProgress = errors.New("a restart is already in progress")

func newUUID() string {
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
}

// getHost is the built-in host's connection (nil while it is not connected).
func (m *sessionManager) getHost() HostConn { return m.hosts.local().getClient() }

// setHost sets the built-in host's connection.
func (m *sessionManager) setHost(h HostConn) { m.hosts.local().setClient(h, nil) }

// hostOf is the connection to a session's host.
func (m *sessionManager) hostOf(sess *store.Session) (HostConn, error) {
	c := m.hosts.get(sess.HostID)
	if c == nil {
		return nil, fmt.Errorf("host %s is gone", sess.HostID)
	}
	h := c.getClient()
	if h == nil {
		return nil, fmt.Errorf("host %s is not connected", c.displayName())
	}
	return h, nil
}

// fsOf is file access on a host's machine.
func (m *sessionManager) fsOf(hostID string) (hostfs.FS, error) {
	if hostID == "" || hostID == store.LocalHostID {
		return m.localFS, nil
	}
	c := m.hosts.get(hostID)
	if c == nil {
		return nil, fmt.Errorf("host %s is gone", hostID)
	}
	if f := c.getFS(); f != nil {
		return f, nil
	}
	return nil, fmt.Errorf("host %s is not connected", c.displayName())
}

// homeOf is the home folder on a host's machine.
func (m *sessionManager) homeOf(ctx context.Context, hostID string) string {
	f, err := m.fsOf(hostID)
	if err != nil {
		return ""
	}
	env, _ := f.Env(ctx)
	return env.Home
}

func (m *sessionManager) remote(hostID string) bool {
	return hostID != "" && hostID != store.LocalHostID
}

var errShellCreate = errors.New("shell sessions can no longer be created; use the companion shell (Ctrl+`)")

// Create records a new session and starts Claude Code in it.
func (m *sessionManager) Create(ctx context.Context, name, cwd, hostID string) (*store.Session, error) {
	return m.CreateKind(ctx, store.KindClaude, name, cwd, hostID, "")
}

// CreateKind records a new Claude Code session and starts it. Shell sessions can no longer be
// created (the companion shell replaces them); old ones in a database keep working. With a projectID the session
// belongs to that project: its host, and its folder unless cwd names another one. Without, the
// project is the one for (host, folder), created on first use.
func (m *sessionManager) CreateKind(ctx context.Context, kind, name, cwd, hostID, projectID string) (*store.Session, error) {
	return m.CreateAgent(ctx, kind, "", name, cwd, hostID, projectID)
}

// CreateAgent is CreateKind with the coding agent to run. agentKind "" means the project's
// default agent, else the default_agent setting, else the installed agent (Claude Code if both are).
func (m *sessionManager) CreateAgent(ctx context.Context, kind, agentKind, name, cwd, hostID, projectID string) (*store.Session, error) {
	switch kind {
	case "":
		kind = store.KindClaude
	case store.KindClaude:
	case store.KindShell:
		return nil, errShellCreate
	default:
		return nil, fmt.Errorf("unknown kind: %s (only claude)", kind)
	}
	var project *store.Project
	if projectID != "" {
		p, err := m.store.GetProject(ctx, projectID)
		if err != nil {
			return nil, fmt.Errorf("no such project: %s", projectID)
		}
		if hostID != "" && hostID != p.HostID {
			return nil, fmt.Errorf("host_id %s is not the project's host (%s)", hostID, p.HostID)
		}
		project, hostID = p, p.HostID
		if cwd == "" {
			cwd = p.Dir
		}
	}
	if hostID == "" {
		hostID = store.LocalHostID
	}
	if m.hosts.get(hostID) == nil {
		return nil, fmt.Errorf("no such host: %s", hostID)
	}
	f, err := m.fsOf(hostID)
	if err != nil {
		return nil, err
	}
	cwd, err = resolveDirOn(ctx, f, cwd)
	if err != nil {
		return nil, err
	}
	if name == "" {
		name = filepath.Base(cwd)
	}
	if agentKind == "" && project != nil {
		agentKind = project.DefaultAgent
	}
	agentKind, err = m.resolveAgent(ctx, agentKind, hostID)
	if err != nil {
		return nil, err
	}
	claudeID := agent.Must(agentKind).NewConversationID()
	var sess *store.Session
	if project != nil {
		sess, err = m.store.CreateSessionAgent(ctx, project.ID, kind, agentKind, name, cwd, claudeID)
	} else {
		var p *store.Project
		if p, _, err = m.store.EnsureProject(ctx, hostID, cwd); err == nil {
			sess, err = m.store.CreateSessionAgent(ctx, p.ID, kind, agentKind, name, cwd, claudeID)
		}
	}
	if err != nil {
		return nil, err
	}
	if err := m.spawn(ctx, sess, false); err != nil {
		_ = m.store.SetSessionEnded(ctx, sess.ID, -1)
		m.hub.publish(Event{Type: "sessions"})
		m.hub.publish(Event{Type: "projects"})
		return nil, err
	}
	m.hub.publish(Event{Type: "sessions"})
	m.hub.publish(Event{Type: "projects"})
	return m.store.GetSession(ctx, sess.ID)
}

// commands are the configured commands of the coding agents.
func (m *sessionManager) commands() agent.Commands {
	return agent.Commands{agent.Claude: m.cfg.ClaudeCommand, agent.Pi: m.cfg.PiCommand, agent.OpenCode: m.cfg.OpenCodeCommand}
}

// defaultAgent is the agent a new session gets when nobody says: the default_agent setting if that
// agent is installed, else the installed one (Claude Code when both are, or neither).
func (m *sessionManager) defaultAgent(ctx context.Context) string {
	stored, _ := m.store.Settings(ctx)
	return m.commands().Choose(settingString(stored, "default_agent"))
}

// resolveAgent turns the requested agent ("" = default) into the one to run on a host, and refuses
// one that cannot run there: an unknown kind, Pi or OpenCode when it is not installed (or, for OpenCode,
// not a supported version), Pi or OpenCode on another machine.
func (m *sessionManager) resolveAgent(ctx context.Context, requested, hostID string) (string, error) {
	if requested == "" {
		requested = m.hostDefaultAgent(ctx, hostID)
	}
	a, err := agent.For(requested)
	if err != nil {
		return "", err
	}
	if m.remote(hostID) {
		if !a.Caps().RemoteHosts {
			return "", fmt.Errorf("%s sessions run on the server's own machine only (host %s is another machine)", a.Label(), hostID)
		}
		// That machine's PATH, Node and OpenCode version decide (hostagents.go).
		if err := m.agentOnHost(ctx, a.Kind(), hostID); err != nil {
			return "", err
		}
		return a.Kind(), nil
	}
	if a.Kind() != agent.Claude && !m.commands().Usable(a.Kind()) {
		return "", m.commands().NotInstalledError(a.Kind())
	}
	return a.Kind(), nil
}

func resolveDir(dir string) (string, error) {
	return resolveDirOn(context.Background(), hostfs.NewLocal(""), dir)
}

// resolveDirOn makes dir absolute (~ is the host's home) and checks it is a folder there.
func resolveDirOn(ctx context.Context, f hostfs.FS, dir string) (string, error) {
	env, err := f.Env(ctx)
	if err != nil {
		return "", err
	}
	if dir == "" {
		dir = "~"
	}
	if dir == "~" || strings.HasPrefix(dir, "~/") {
		dir = hostfs.ExpandPath(env.Home, dir)
	}
	if !filepath.IsAbs(dir) {
		return "", fmt.Errorf("directory must be absolute: %s", dir)
	}
	st, err := f.Stat(ctx, dir)
	if err != nil {
		return "", fmt.Errorf("no such folder: %s", dir)
	}
	if !st.IsDir() {
		return "", fmt.Errorf("not a directory: %s", dir)
	}
	return filepath.Clean(dir), nil
}

// transcriptExists reports whether Claude Code has a transcript for the
// conversation, so `--resume` will find it (on this machine).
func transcriptExists(cwd, claudeSessionID string) bool {
	return hostfs.NewLocal("").TranscriptExists(context.Background(), cwd, claudeSessionID)
}

// projectDirName is how Claude Code names a project's folder under ~/.claude/projects.
func projectDirName(cwd string) string { return hostfs.ProjectDirName(cwd) }

// argv builds the command line: the person's claude command, our mod, and the
// conversation id (a new one, or --resume of the existing one). On another
// machine the host fills in its own mod folder.
func (m *sessionManager) argv(ctx context.Context, sess *store.Session, resume bool) []string {
	if sess.Kind == store.KindShell {
		return shellArgv
	}
	a := agent.Must(sess.Agent)
	req := agent.ArgvReq{ConversationID: sess.ClaudeSessionID, Cwd: sess.Cwd}
	if a.Kind() == agent.OpenCode {
		// --session opens the session minbox created (or found) just before the start (prepareOpenCode).
		// The plugin is in the environment (sessionEnv).
		req.Command = m.cfg.OpenCodeCommand
		req.Extension = m.cfg.OpenCodePlugin
	} else if a.Kind() == agent.Pi {
		req.Command = m.cfg.PiCommand
		req.Extension = m.cfg.PiExtension
		if m.cfg.PiSubagentExtension != "" {
			req.ExtraExtensions = []string{m.cfg.PiSubagentExtension}
		}
		if m.remote(sess.HostID) {
			// The host fills in its own copy of the extensions.
			req.Extension = termhost.PiExtensionPlaceholder
			req.ExtraExtensions = []string{termhost.PiSubagentPlaceholder}
		}
		if resume && sess.ClaudeSessionID != "" {
			// --session-id continues the conversation if the folder has it, else starts it.
			log.Printf("session %s (%s): resume check: Pi conversation %s, cwd %q, host %q, session file found: %v", sess.ID, sess.Name, sess.ClaudeSessionID, sess.Cwd, sess.HostID, m.piConversationExists(ctx, sess))
		}
	} else {
		req.Command = m.cfg.ClaudeCommand
		req.Extension = m.cfg.PluginDir
		if m.remote(sess.HostID) {
			req.Extension = termhost.PluginDirPlaceholder
		}
		exists := false
		if resume && sess.ClaudeSessionID != "" {
			if f, err := m.fsOf(sess.HostID); err == nil {
				exists = f.TranscriptExists(ctx, sess.Cwd, sess.ClaudeSessionID)
			} else {
				log.Printf("session %s (%s): cannot check for a transcript on host %q (%v)", sess.ID, sess.Name, sess.HostID, err)
			}
			log.Printf("session %s (%s): resume check: conversation %s, cwd %q, host %q, transcript found: %v", sess.ID, sess.Name, sess.ClaudeSessionID, sess.Cwd, sess.HostID, exists)
		}
		if resume && sess.ClaudeSessionID != "" && !exists {
			log.Printf("session %s (%s): no transcript for conversation %s found (looked for %s.jsonl under ~/.claude/projects/%s/, the symlink-resolved cwd, and every project folder on host %q): starting a NEW conversation with --session-id",
				sess.ID, sess.Name, sess.ClaudeSessionID, sess.ClaudeSessionID, projectDirName(sess.Cwd), sess.HostID)
		}
		req.Resume = exists
	}
	req.Instructions = m.instructions(ctx, sess)
	return a.Argv(req)
}

// piConversationExists reports whether Pi has a session file for the session's conversation on the
// session's machine (a remote host looks in its own Pi folder).
func (m *sessionManager) piConversationExists(ctx context.Context, sess *store.Session) bool {
	f, err := m.fsOf(sess.HostID)
	if err != nil {
		return false
	}
	return f.PiConversationFile(ctx, sess.Cwd, sess.ClaudeSessionID) != ""
}

// conversationExists reports whether the session's agent has a saved conversation `id` in cwd.
func (m *sessionManager) conversationExists(ctx context.Context, f hostfs.FS, sess *store.Session, id string) bool {
	switch sess.Agent {
	case agent.Pi:
		// Pi's session files are on the session's machine (f is that machine's).
		return f.PiConversationFile(ctx, sess.Cwd, id) != ""
	case agent.OpenCode:
		exists, _, err := m.openCodeSession(ctx, sess, id)
		if err != nil {
			log.Printf("session %s (%s): cannot check OpenCode session %s: %v", sess.ID, sess.Name, id, err)
		}
		return exists
	}
	return f.TranscriptExists(ctx, sess.Cwd, id)
}

// openCodeRunner runs the opencode CLI on a session's machine: here, or through a remote host's exec.
func (m *sessionManager) openCodeRunner(hostID string) (agent.Runner, error) {
	return m.runnerOn(hostID)
}

// openCodeCLITimeout bounds one `opencode api --standalone` call (it starts a private server).
var openCodeCLITimeout = 30 * time.Second

// openCodeSession asks OpenCode (its CLI, never its database) whether session id exists and where.
func (m *sessionManager) openCodeSession(ctx context.Context, sess *store.Session, id string) (bool, string, error) {
	run, err := m.openCodeRunner(sess.HostID)
	if err != nil {
		return false, "", err
	}
	ctx, cancel := context.WithTimeout(ctx, openCodeCLITimeout)
	defer cancel()
	return agent.OpenCodeSessionDir(ctx, run, m.cfg.OpenCodeCommand, sess.Cwd, id)
}

// prepareOpenCode creates the session's OpenCode session before the TUI starts: the TUI shows a
// session given with --session only if it exists then (a missing one would be created only by the
// person's first prompt, and turns minbox starts would not show). A failure is logged and the start
// goes on: the plugin creates the session itself as a fallback.
func (m *sessionManager) prepareOpenCode(ctx context.Context, sess *store.Session) {
	if sess.Agent != agent.OpenCode || sess.ClaudeSessionID == "" {
		return
	}
	run, err := m.openCodeRunner(sess.HostID)
	if err != nil {
		log.Printf("session %s (%s): %v", sess.ID, sess.Name, err)
		return
	}
	ctx, cancel := context.WithTimeout(ctx, openCodeCLITimeout)
	defer cancel()
	created, at, err := agent.OpenCodeEnsureSession(ctx, run, m.cfg.OpenCodeCommand, sess.Cwd, sess.ClaudeSessionID)
	switch {
	case err != nil:
		log.Printf("session %s (%s): could not create OpenCode session %s in %s (%v); the plugin will try", sess.ID, sess.Name, sess.ClaudeSessionID, sess.Cwd, err)
	case created:
		log.Printf("session %s (%s): created OpenCode session %s in %s", sess.ID, sess.Name, sess.ClaudeSessionID, sess.Cwd)
	default:
		log.Printf("session %s (%s): resume check: OpenCode session %s exists (in %s)", sess.ID, sess.Name, sess.ClaudeSessionID, at)
	}
}

// instructions is the one text that tells the agent how to work with minbox:
// AgentSystemPrompt, the orchestration prompt while the orchestrator_prompt
// setting is on, and the person's prompt_extra setting. The command line
// (--append-system-prompt) and the hello endpoint (which the mod re-injects
// into prompts) both use it, so there is a single source.
func (m *sessionManager) instructions(ctx context.Context, sess *store.Session) string {
	stored, err := m.store.Settings(ctx)
	if err != nil {
		stored = nil
	}
	a := agent.Must(sess.Agent)
	// The orchestrator prompt tells the main agent to start subagents: only for agents that have them.
	text := buildInstructionsFor(a, settingOn(stored, "orchestrator_prompt", true) && a.Caps().Subagents, settingString(stored, "prompt_extra"))
	if note := relocationNote(sess); note != "" {
		text += "\n\n" + note
	}
	return text
}

// relocationNote tells the agent of a session whose project folder changed that its earlier
// conversation ran in the old folder: where the transcript is, so it can look things up. It is part
// of the instructions text, so every way the text reaches the agent carries it. The wording is the
// session's agent's (where it keeps conversations).
func relocationNote(sess *store.Session) string {
	if sess == nil || sess.PrevDir == "" || sess.PrevClaudeSessionID == "" {
		return ""
	}
	r := agent.Relocation{Cwd: sess.Cwd, Prev: agent.Prev{Dir: sess.PrevDir, ConversationID: sess.PrevClaudeSessionID}}
	for _, c := range sess.PrevChain {
		r.Chain = append(r.Chain, agent.Prev{Dir: c.Dir, ConversationID: c.ClaudeSessionID})
	}
	return agent.Must(sess.Agent).RelocationNote(r)
}

// maxPrevChain bounds how many older conversations a session remembers.
const maxPrevChain = 5

// relocate applies a pending folder change (the project's folder changed while the session had
// its own cwd) before the session starts: it runs in the project's new folder. Claude Code keys a
// conversation by its folder, so `--resume` would not find the old one there: when the old
// conversation has a transcript, the session starts a fresh conversation (new claude_session_id)
// and remembers the old folder and id for relocationNote. This runs once: the store clears the
// pending move. If the new folder is gone the session starts in its old folder, the move pending.
func (m *sessionManager) relocate(ctx context.Context, sess *store.Session) {
	if sess.Kind == store.KindShell || sess.RelocateTo == "" {
		return
	}
	if sess.RelocateTo == sess.Cwd {
		_ = m.store.RelocateSession(ctx, sess.ID, sess.Cwd, "", "", "", nil)
		sess.RelocateTo = ""
		return
	}
	f, err := m.fsOf(sess.HostID)
	if err != nil {
		log.Printf("session %s (%s): folder change postponed: %v", sess.ID, sess.Name, err)
		return
	}
	dir, err := resolveDirOn(ctx, f, sess.RelocateTo)
	if err != nil {
		log.Printf("session %s (%s): folder change postponed: %v", sess.ID, sess.Name, err)
		return
	}
	// With no transcript in the old folder (the person never sent a prompt there) the Claude id
	// stays and so do the older prev_* fields: only the folder moves. An agent whose conversation can
	// move (OpenCode: its plugin moves the session at startup) keeps it too.
	prevDir, prevID, newID := "", "", sess.ClaudeSessionID
	var chain []store.PrevConv
	movable := agent.Must(sess.Agent).Caps().MovableConversation
	if !movable && sess.ClaudeSessionID != "" && m.conversationExists(ctx, f, sess, sess.ClaudeSessionID) {
		prevDir, prevID, newID = sess.Cwd, sess.ClaudeSessionID, agent.Must(sess.Agent).NewConversationID()
		chain = append(chain, sess.PrevChain...)
		if sess.PrevDir != "" && sess.PrevClaudeSessionID != "" {
			chain = append(chain, store.PrevConv{Dir: sess.PrevDir, ClaudeSessionID: sess.PrevClaudeSessionID})
		}
		if len(chain) > maxPrevChain {
			chain = chain[len(chain)-maxPrevChain:]
		}
	}
	if err := m.store.RelocateSession(ctx, sess.ID, dir, newID, prevDir, prevID, chain); err != nil {
		log.Printf("session %s (%s): folder change: %v", sess.ID, sess.Name, err)
		return
	}
	if m.modLog != nil {
		m.modLog(sess.ID, "relocated", "from=%q to=%q new_conversation=%q", sess.Cwd, dir, newID)
	}
	log.Printf("session %s (%s): moved from %s to %s (previous conversation %q)", sess.ID, sess.Name, sess.Cwd, dir, prevID)
	sess.Cwd, sess.RelocateTo, sess.ClaudeSessionID = dir, "", newID
	if prevDir != "" {
		sess.PrevDir, sess.PrevClaudeSessionID, sess.PrevChain = prevDir, prevID, chain
	}
}

// buildInstructions assembles the instructions text from its parts.
func buildInstructions(orchestrator bool, extra string) string {
	return buildInstructionsFor(agent.Must(agent.Claude), orchestrator, extra)
}

// buildInstructionsFor assembles the instructions text for an agent. The text is written once,
// with Claude Code's tool names (mcp__minbox__send_message); another agent gets the same text with
// its own tool names. For Claude Code this is the text unchanged.
func buildInstructionsFor(a agent.Agent, orchestrator bool, extra string) string {
	text := AgentSystemPrompt
	if orchestrator {
		text += "\n\n" + OrchestratorPrompt
	}
	if p := a.Tools().Prefix; p != toolPrefix {
		text = strings.ReplaceAll(text, toolPrefix, p)
	}
	switch a.Kind() {
	case agent.Pi:
		// Pi has no Task tool; the subagent extension registers minbox_subagent.
		text += "\n\n" + PiSubagentPrompt
	case agent.OpenCode:
		// OpenCode's subagent tool and its built-in agents differ from Claude Code's Task tool.
		text += "\n\n" + OpenCodeSubagentPrompt
	}
	if extra = strings.TrimSpace(extra); extra != "" {
		text += "\n\nThe person adds: " + extra
	}
	return text
}

// toolPrefix is what the instruction constants write before a tool's name (Claude Code's).
const toolPrefix = "mcp__minbox__"

func settingOn(stored map[string]json.RawMessage, key string, def bool) bool {
	var on bool
	if raw, ok := stored[key]; ok && json.Unmarshal(raw, &on) == nil {
		return on
	}
	return def
}

func settingString(stored map[string]json.RawMessage, key string) string {
	var v string
	if raw, ok := stored[key]; ok && json.Unmarshal(raw, &v) == nil {
		return v
	}
	return ""
}

// trustClaudeFolder says whether the session is a Claude Code one whose folder is to be marked
// trusted in Claude Code's configuration before it starts (the claude_trust_folders setting, on
// unless set to false): Claude Code otherwise stops at its "do you trust this folder" dialog.
func (m *sessionManager) trustClaudeFolder(ctx context.Context, sess *store.Session) bool {
	if sess.Kind == store.KindShell || (sess.Agent != agent.Claude && sess.Agent != "") {
		return false
	}
	stored, err := m.store.Settings(ctx)
	if err != nil {
		return true
	}
	return settingOn(stored, "claude_trust_folders", true)
}

// orchestratorPrompt reports the orchestrator_prompt setting (on unless set to
// false), read when a session is started or resumed.
func (m *sessionManager) orchestratorPrompt(ctx context.Context) bool {
	stored, err := m.store.Settings(ctx)
	if err != nil {
		return true
	}
	return settingOn(stored, "orchestrator_prompt", true)
}

// OrchestratorPrompt is appended to AgentSystemPrompt while the
// orchestrator_prompt setting is on: the main agent only orchestrates, one
// subagent per task. It is part of the instructions text (see instructions).
const OrchestratorPrompt = `# minbox: orchestration
You are the main agent of this session and only orchestrate. ALWAYS start one subagent per task, whether the change is large or tiny; never do a task's work yourself and never judge a task too small for a subagent. Unless the person says otherwise, this holds for every task and message.
Your job: split the work, brief each subagent fully (goal, files, constraints, how to verify), track progress, review what comes back (the subagent's checks and evidence), and report to the person (send_message with the task_id).
Stay responsive: the person's messages keep arriving, and while you run something in the foreground you cannot answer them. Never run long or blocking work yourself (merging, building, running tests, restarting or deploying, pushing, long investigations); it goes to a background subagent too. Integrating finished work (merge into the main branch, run the full checks, build or deploy, push) is also a subagent's job, one integration at a time since they share the branch and running services: queue them and review each result. Your own tool calls stay short: reading reports, task and message updates, briefing and starting agents.
Every task uses a subagent, so saying one does tells the person nothing: as each subagent's work moves, update its task's summary, and in progress messages describe what the subagent is doing (the step, the finding), not that a subagent is used.
Run independent subagents in parallel; do not hold work back for fear of merge conflicts: the integration subagent resolves them.
A subagent that changes anything other than reading (edit files, build, commit) works in its own git worktree when the working directory is in a git repository; read-only investigation needs no worktree. If the directory is not a git repository this does not apply.`

// PiSubagentPrompt is Pi's counterpart of the orchestration block: a short note on the
// minbox_subagent tool (plugin/pi/subagent.ts). It is added for Pi only; Claude's text is unchanged.
const PiSubagentPrompt = `# minbox: subagents
minbox_subagent runs up to 8 tasks (4 at a time) in separate Pi processes with their own context; use it to investigate, review or implement pieces in parallel. Brief each task fully (goal, files, constraints, how to verify): a child sees nothing of this conversation.
- Default children are read-only (read, grep, find, ls). role picks a prepared prompt: scout (recon), planner, reviewer, worker.
- Set write: true only for a task that must change files. That child works in its own git worktree on a new branch minbox-sub/<id> (the folder must be inside a git repository), and the result names the branch and path. Review the diff and merge the branch yourself; a child never touches your own checkout.
- Several minbox tasks: the person's messages can be about different tasks. When the work for different tasks is independent, do not do it serially yourself: give each task's work its own minbox_subagent task, run them in parallel, and name the task id in each task. You stay the coordinator: when a task returns, review it and report it with minbox_send_message with that task's task_id. Use write: true only for a task that needs edits.
- Children cannot use minbox_* tools; report to the person yourself.`

// OpenCodeSubagentPrompt tells OpenCode how the orchestration above maps onto its own subagents (the
// subagent tool with the built-in general and explore agents). It is added for OpenCode only.
const OpenCodeSubagentPrompt = `# minbox: subagents in OpenCode
Subagents here are OpenCode's subagent tool: agent "general" (can edit files and run commands) or "explore" (read-only search). Give each task a full brief (goal, files, constraints, how to verify): a subagent sees nothing of this conversation.
- Several minbox tasks: the person's messages can be about different tasks. When the work for different tasks is independent, start one subagent per task with background: true so they run in parallel, and name the task id in each brief. You stay the coordinator: when a subagent reports back, review its result and report it with minbox_send_message with that task's task_id.
- A subagent that changes files works in its own git worktree when the folder is in a git repository: create one first (Code Mode: execute with tools.opencode.worktree_create) and tell the subagent to work only there; review and merge its branch yourself. Read-only investigation needs no worktree.
- Subagents do not message the person; you report with minbox_send_message.`

// AgentSystemPrompt is minbox's part of Claude's system prompt: reach the
// person through the inbox, keep the session's title current, and open pages
// in the person's browser (the host may be another machine). The tool names are
// the mcp__minbox__* names the mod registers.
const AgentSystemPrompt = `# minbox: talking with the person
The person follows this session in minbox (your conversation with them, and a Board of tasks) and may not be watching the terminal. mcp__minbox__send_message is how you reach them:
- Every time you need their opinion, a decision, an approval or an action from them (run or check something, review, choose what comes next), send it with the tool, each decision as a :::question block. Do this every time, also for small questions; a question asked only in your chat reply goes unseen.
- When you finish a task or a long stretch of work, send a short summary of what is done and anything they should look at.
- Then keep working on what does not depend on the answer, or end your turn; their reply arrives here by itself. Do not ask the same thing again in the chat.
- Whatever you send reaches the person at once and cannot be taken back: never send placeholder, test or draft text, only the final message. Do not put mcp__minbox__send_message in the same parallel batch as a call whose result it needs (e.g. mcp__minbox__create_task's task id): wait for that result, then send; never guess ids.

# minbox: replying to the person's messages (important)
A message that arrives as "minbox: a message from the person …" comes from minbox, not from the terminal. Always answer it with mcp__minbox__send_message: every answer, confirmation, status, "done" and question back, however short. Text you only write in the terminal is not shown to them.
For each such message decide which task it is about: an open task (reply with its task_id; prefer this when one fits), or new work (mcp__minbox__create_task, then reply: the message and your reply belong to it). Every message, theirs and yours, belongs to exactly one task; there is no "no task" and no second task (about two tasks, send one message per task). A quick question or chat that fits no open task gets a small task of its own (create_task with a short title and status done once answered). Messages a turn leaves in no task, minbox asks you to place after the turn (update_task message_ids or create_task message_ids). thread_id and thread_title on send_message are not needed; send_message takes no status (it is refused): set a task's status with update_task.

# minbox: session title
The person sees this session in minbox's session list under a title you set with mcp__minbox__set_session_title. Keep it current:
- Set it once the task is clear, early in the first turn: a few words naming the work (e.g. "Fix login redirect loop"), not a status or a sentence.
- Set it again whenever the main task changes (a new request, a different bug, the next phase); leave it alone for small steps within the same task.
- Plain text, short (around 80 characters is plenty; a guide, not a hard limit), in the person's language. Do not mention the title in your replies.

# minbox: tasks and goals
The person's Board shows your work as tasks; you keep them with mcp__minbox__create_task, mcp__minbox__update_task and mcp__minbox__list_tasks. Nobody else fills them in.
- A task is one distinct piece of work the person asked for. Keep the Board small: reuse an open task that fits (mcp__minbox__list_tasks) instead of creating another, put the parts of the work in its steps, and put a sub-question, a status check or a quick answer in the task it is about. Only a quick exchange that fits no task gets its own small task, done as soon as it is answered.
- Keep a task's title accurate: rename it (update_task title) when the work's scope becomes clear or changes; a short name (2 to 8 words) in the person's language. Do not rename it on every step.
- Give a task short steps and tick them as you go; keep its status true (needs_you only while you are blocked on the person, done when finished or dropped) and its report short.
- A task's summary and report say what is being done now, concretely (the step under way, the latest finding), never only who does it or how ("a subagent is working on it", "investigating"). Update the summary as the work moves.
- An outcome to pursue until it is reached ("keep going until CI is green") is a goal: create_task with kind "goal" and its criteria; tick them with check_criteria. autonomous: true only when the person asked you to keep going on your own.

# minbox: opening pages
When the person asks you to open, show or view a web page (a PR, an issue, a CI run, a URL), call mcp__minbox__open_url with its URL. It opens the page in the browser they are using minbox from.
- Never open pages with Bash (` + "`open URL`, `xdg-open`, `gh pr view --web`, `gh browse`" + `, …): those open on the machine you run on, which may be a remote host the person is not sitting at.
- With gh, get the URL first (e.g. ` + "`gh pr view --json url -q .url`" + `), then pass it to the tool.

# minbox: finding things
To look up a project, an agent, a task or an earlier conversation the person mentions, use mcp__minbox__list_tasks for tasks and the read-only tools mcp__minbox__list_projects, mcp__minbox__get_project, mcp__minbox__list_sessions (agents), mcp__minbox__list_threads (conversations: an agent's stream and its older segments) and mcp__minbox__search (they may be deferred: find them with ToolSearch), then mcp__minbox__read_thread with the conversation's thread_id (any agent's; the newest messages first, older ones with before). Do not guess ids.`

// shellArgv starts the login shell of the machine that runs the terminal:
// the host's own $SHELL (the host's environment, see InheritEnv), else the
// user's shell in the host's user database, else /bin/sh.
var shellArgv = []string{"/bin/sh", "-c", `s="$SHELL"
if [ -z "$s" ] || [ ! -x "$s" ]; then
  s=$(dscl . -read "/Users/$(id -un)" UserShell 2>/dev/null | sed -n 's/^UserShell: //p')
  [ -n "$s" ] || s=$(getent passwd "$(id -un)" 2>/dev/null | cut -d: -f7)
fi
[ -n "$s" ] && [ -x "$s" ] || s=/bin/sh
export SHELL="$s"
exec "$s" -l`}

// sessionEnv is the environment Claude Code runs with. On another machine
// the host starts from its own environment (InheritEnv) and fills in its
// server file (its relay).
func (m *sessionManager) sessionEnv(sess *store.Session) []string {
	var env []string
	serverFile := m.cfg.ServerFile
	if m.remote(sess.HostID) || sess.Kind == store.KindShell {
		// The host's own environment (InheritEnv): its SHELL, PATH and the rest.
		serverFile = termhost.ServerFilePlaceholder
	} else {
		env = termhost.CleanEnv(os.Environ())
	}
	env = append(env, "TERM=xterm-256color", "COLORTERM=truecolor")
	if sess.Kind == store.KindShell {
		return env // no mod: nothing of minbox's to hand on
	}
	env = append(env,
		"MINBOX_SESSION_ID="+sess.ID,
		"MINBOX_TOKEN="+sess.Token,
		"MINBOX_SERVER_FILE="+serverFile,
	)
	// What the agent itself needs (OpenCode: its plugin and the session it serves).
	if sess.Agent == agent.OpenCode {
		req := agent.ArgvReq{
			Extension:      m.cfg.OpenCodePlugin,
			ConversationID: sess.ClaudeSessionID,
			Cwd:            sess.Cwd,
			BaseEnv:        env,
		}
		if m.remote(sess.HostID) {
			// The host fills in its own plugin folder and merges the entry into an
			// OPENCODE_CONFIG_CONTENT of its own environment.
			req.Extension = termhost.OpenCodePluginPlaceholder
		}
		env = append(env, agent.Must(sess.Agent).Env(req)...)
	}
	return env
}

func (m *sessionManager) spawn(ctx context.Context, sess *store.Session, resume bool) error {
	host, err := m.hostOf(sess)
	if err != nil {
		return err
	}
	if m.remote(sess.HostID) && sess.Agent != agent.Claude && sess.Agent != "" && sess.Kind != store.KindShell {
		// A host before AgentsProtocol would start Pi/OpenCode without minbox's part.
		if _, err := m.execOn(sess.HostID); err != nil {
			return err
		}
	}
	_ = host.Remove(ctx, sess.ID) // forget an exited terminal of the same id
	m.relocate(ctx, sess)
	m.prepareOpenCode(ctx, sess)
	if m.modLog != nil {
		m.modLog(sess.ID, "spawn", "resume=%v agent=%s host=%q cwd=%q", resume, sess.Agent, sess.HostID, sess.Cwd)
	}
	env := m.sessionEnv(sess)
	trust := m.trustClaudeFolder(ctx, sess)
	if trust && !m.remote(sess.HostID) {
		// This machine: here, in the environment the session gets. A remote host does it on its own
		// machine (TrustClaudeFolder).
		claudetrust.EnsureLogged(sess.Cwd, env, "session "+sess.ID)
	}
	_, err = host.Spawn(ctx, termhost.SpawnRequest{
		ID:                sess.ID,
		Argv:              m.argv(ctx, sess, resume),
		Cwd:               sess.Cwd,
		Env:               env,
		InheritEnv:        m.remote(sess.HostID) || sess.Kind == store.KindShell,
		Cols:              120,
		Rows:              36,
		TrustClaudeFolder: trust && m.remote(sess.HostID),
	})
	if err != nil {
		return err
	}
	if sess.Kind == store.KindShell {
		// No mod reports in: a shell is ready for the person at once.
		return m.store.SetSessionStatus(ctx, sess.ID, store.StatusIdle)
	}
	return m.store.SetSessionStatus(ctx, sess.ID, store.StatusStarting)
}

// Restart starts a session again, resuming its conversation. An ended session
// is simply resumed. A running one is stopped first: its terminal is killed
// (the exit is marked as part of the restart, so it does not close the
// session), the exit is awaited (up to restartWait), then it is resumed
// through the usual spawn (plugin dir, prompt and settings are read again; a
// shell starts fresh). The companion shell keeps running: only the main
// terminal is replaced. A second restart meanwhile fails with
// errRestartInProgress.
func (m *sessionManager) Restart(ctx context.Context, id string) error {
	sess, err := m.store.GetSession(ctx, id)
	if err != nil {
		return err
	}
	m.mu.Lock()
	if m.restarting[id] != nil {
		m.mu.Unlock()
		return errRestartInProgress
	}
	st := &restartState{exited: make(chan struct{})}
	m.restarting[id] = st
	m.mu.Unlock()
	defer func() {
		m.mu.Lock()
		delete(m.restarting, id)
		m.mu.Unlock()
	}()

	if sess.Status != store.StatusEnded {
		if err := m.stopForRestart(ctx, sess, st); err != nil {
			return err
		}
	}
	if err := m.store.RestartSession(ctx, id); err != nil {
		return err
	}
	m.hub.publish(Event{Type: "sessions"})
	err = m.spawn(ctx, sess, true)
	if err != nil {
		_ = m.store.SetSessionEnded(ctx, id, -1)
	}
	m.hub.publish(Event{Type: "sessions"})
	return err
}

// restartWait bounds how long Restart waits for the old terminal to exit.
var restartWait = 10 * time.Second

func (m *sessionManager) stopForRestart(ctx context.Context, sess *store.Session, st *restartState) error {
	host, err := m.hostOf(sess)
	if err != nil {
		return err
	}
	if err := host.Kill(ctx, sess.ID); err != nil {
		return err
	}
	deadline := time.NewTimer(restartWait)
	defer deadline.Stop()
	tick := time.NewTicker(100 * time.Millisecond)
	defer tick.Stop()
	gone := 0
	for {
		select {
		case <-st.exited:
			return nil
		case <-ctx.Done():
			return ctx.Err()
		case <-deadline.C:
			return fmt.Errorf("the terminal did not exit within %s", restartWait)
		case <-tick.C:
			// The exit event is the signal; the terminal list is the fallback if
			// the event got lost: not running for a second counts as exited.
			terms, err := host.List(ctx)
			if err != nil {
				continue
			}
			running := false
			for _, t := range terms {
				if t.ID == sess.ID && t.Running {
					running = true
				}
			}
			if running {
				gone = 0
			} else if gone++; gone >= 10 {
				return nil
			}
		}
	}
}

// Stop ends a running session at the person's request; it is not resumed automatically.
func (m *sessionManager) Stop(ctx context.Context, id string) error {
	sess, err := m.store.GetSession(ctx, id)
	if err != nil {
		return err
	}
	host, err := m.hostOf(sess)
	if err != nil {
		// The host is away: the session ends here; its process is gone with it or ends later.
		_ = m.store.SetSessionEnded(ctx, id, -1)
		m.hub.publish(Event{Type: "sessions"})
		return nil
	}
	m.mu.Lock()
	m.stopping[id] = true
	m.mu.Unlock()
	err = host.Kill(ctx, id)
	m.endShell(ctx, id)
	// The exit event marks it ended; make sure even if the host had no such terminal.
	if sess, gerr := m.store.GetSession(ctx, id); gerr == nil && sess.Status != store.StatusEnded {
		_ = m.store.SetSessionEnded(ctx, id, -1)
	}
	m.hub.publish(Event{Type: "sessions"})
	return err
}

// Delete stops the session (if running) and removes it with its threads.
func (m *sessionManager) Delete(ctx context.Context, id, promote string) error {
	// A main session goes only when another is promoted or it is the project's last Claude Code session.
	if err := m.store.ReleaseMain(ctx, id, promote); err != nil {
		return err
	}
	m.terminate(ctx, id)
	err := m.store.DeleteSession(ctx, id)
	m.hub.publish(Event{Type: "sessions"})
	return err
}

// terminate kills the session's Claude Code terminal and companion shell and removes their panes.
func (m *sessionManager) terminate(ctx context.Context, id string) {
	var host HostConn
	if sess, err := m.store.GetSession(ctx, id); err == nil {
		host, _ = m.hostOf(sess)
	}
	if host != nil {
		m.mu.Lock()
		m.stopping[id] = true
		m.mu.Unlock()
		_ = host.Kill(ctx, id)
		_ = host.Remove(ctx, id)
		_ = host.Kill(ctx, shellTermID(id))
		_ = host.Remove(ctx, shellTermID(id))
	}
}

// DeleteProject stops every session of the project, then deletes the project with all of them
// in one store transaction. The main-session rule does not apply: all of them go.
func (m *sessionManager) DeleteProject(ctx context.Context, projectID string) error {
	if _, err := m.store.GetProject(ctx, projectID); err != nil {
		return err
	}
	all, err := m.store.ListSessions(ctx)
	if err != nil {
		return err
	}
	for _, sess := range all {
		if sess.ProjectID == projectID {
			m.terminate(ctx, sess.ID)
		}
	}
	err = m.store.DeleteProject(ctx, projectID)
	m.hub.publish(Event{Type: "sessions"})
	return err
}

// onExit handles a terminal's exit: the session is closed (the person stopped
// it, or Claude Code quit on its own). Either way it is not resumed later.
func (m *sessionManager) onExit(ctx context.Context, id string, code int) {
	if isShellTermID(id) {
		return // a companion shell ending is not a session ending
	}
	m.mu.Lock()
	if st := m.restarting[id]; st != nil {
		m.mu.Unlock()
		st.once.Do(func() { close(st.exited) }) // the restart goes on from here
		return
	}
	delete(m.stopping, id)
	m.mu.Unlock()
	m.endShell(ctx, id)
	if m.modLog != nil {
		m.modLog(id, "exit", "terminal exited code=%d", code)
	}
	if m.modForget != nil {
		m.modForget(id, fmt.Sprintf("process exited code=%d", code))
	}
	if err := m.store.SetSessionEnded(ctx, id, code); err != nil && !errors.Is(err, store.ErrNotFound) {
		log.Printf("mark %s ended: %v", id, err)
	}
	m.hub.publish(Event{Type: "sessions"})
}

// Reconcile matches the store against the terminal host after (re)connecting:
//   - a running terminal: the session stays as it is;
//   - an exited terminal: Claude Code quit while the server was away: closed;
//   - no terminal: the host is new (the OS restarted, or the host was
//     restarted for a version change), so the open session is resumed with
//     `claude --resume`.
func (m *sessionManager) Reconcile(ctx context.Context) error {
	return m.reconcileHost(ctx, store.LocalHostID)
}

func (m *sessionManager) reconcileHost(ctx context.Context, hostID string) error {
	c := m.hosts.get(hostID)
	if c == nil {
		return errors.New("no such host")
	}
	host := c.getClient()
	if host == nil {
		return errors.New("terminal host is not connected")
	}
	terms, err := host.List(ctx)
	if err != nil {
		return err
	}
	byID := map[string]termhost.TerminalInfo{}
	for _, t := range terms {
		byID[t.ID] = t
	}
	sessions, err := m.store.ListSessions(ctx)
	if err != nil {
		return err
	}
	for i := range sessions {
		sess := &sessions[i]
		if sess.Status == store.StatusEnded || sess.HostID != hostID {
			continue
		}
		t, ok := byID[sess.ID]
		switch {
		case ok && t.Running:
			// still running
		case ok:
			_ = m.store.SetSessionEnded(ctx, sess.ID, t.ExitCode)
		default:
			log.Printf("resuming session %s (%s) in %s", sess.ID, sess.Name, sess.Cwd)
			if err := m.spawn(ctx, sess, true); err != nil {
				log.Printf("resume %s: %v", sess.ID, err)
				_ = m.store.SetSessionEnded(ctx, sess.ID, -1)
			}
		}
	}
	m.hub.publish(Event{Type: "sessions"})
	return nil
}

// Run keeps the server connected to the terminal host: it (re)starts the host
// when needed, reconciles, and follows exit events until ctx ends.
func (m *sessionManager) Run(ctx context.Context, connect func(context.Context) (*termhost.Client, error), ready chan<- error) {
	first := true
	for ctx.Err() == nil {
		m.waitLocalHold(ctx)
		client, err := connect(ctx)
		conn := 0
		if err == nil {
			conn = m.localConnected()
			m.hosts.local().setClient(client, nil)
			if v, verr := client.Version(ctx); verr == nil {
				m.hosts.local().setVersion(v, 0)
			}
			err = m.Reconcile(ctx)
			if err == nil {
				m.localReconciled()
			}
		} else {
			m.hosts.local().setOffline(err)
		}
		if first {
			ready <- err
			first = false
		}
		if err != nil {
			log.Printf("terminal host: %v", err)
			select {
			case <-ctx.Done():
				return
			case <-time.After(2 * time.Second):
			}
			continue
		}
		// A host restart ends this connection itself (dropLocal) rather than wait
		// for the old host's event stream to close.
		ectx, drop := context.WithCancel(ctx)
		m.mu.Lock()
		m.localDrop = drop
		m.mu.Unlock()
		err = client.Events(ectx, func(ev termhost.Event) {
			if ev.Type == "exit" {
				if m.quietExit(conn) {
					return // the host is being restarted: its sessions resume (or end) with the restart
				}
				m.onExit(ctx, ev.ID, ev.ExitCode)
			}
		})
		drop()
		if ctx.Err() != nil {
			return
		}
		log.Printf("terminal host connection lost (%v); reconnecting", err)
		m.hosts.local().setOffline(err)
		time.Sleep(500 * time.Millisecond)
	}
}

// shellSuffix marks a session's companion shell: a second terminal on the
// session's host, in its folder, with the id "<session id>:shell". It is not
// a session: nothing in the store, the lists or the inbox knows it.
const shellSuffix = ":shell"

func shellTermID(sessionID string) string { return sessionID + shellSuffix }

func isShellTermID(id string) bool { return strings.HasSuffix(id, shellSuffix) }

// clientError is an error with the HTTP status to answer.
type clientError struct {
	status int
	msg    string
}

func (e *clientError) Error() string { return e.msg }

// ensureShell starts the session's companion shell unless one is running.
// An exited one (the person typed exit) is forgotten and started again.
func (m *sessionManager) ensureShell(ctx context.Context, sess *store.Session) error {
	if sess.Kind == store.KindShell {
		return &clientError{400, "a shell session is a shell already"}
	}
	if sess.Status == store.StatusEnded {
		return &clientError{409, "session has ended"}
	}
	host, err := m.hostOf(sess)
	if err != nil {
		return err
	}
	m.shellMu.Lock()
	defer m.shellMu.Unlock()
	id := shellTermID(sess.ID)
	if terms, err := host.List(ctx); err == nil {
		for _, t := range terms {
			if t.ID == id && t.Running {
				return nil
			}
		}
	}
	_ = host.Remove(ctx, id)
	shell := *sess
	shell.Kind = store.KindShell
	_, err = host.Spawn(ctx, termhost.SpawnRequest{
		ID:         id,
		Argv:       shellArgv,
		Cwd:        sess.Cwd,
		Env:        m.sessionEnv(&shell),
		InheritEnv: true,
		Cols:       120,
		Rows:       36,
	})
	return err
}

// endShell ends and forgets the companion shell of a session.
func (m *sessionManager) endShell(ctx context.Context, sessionID string) {
	sess, err := m.store.GetSession(ctx, sessionID)
	if err != nil {
		return
	}
	host, err := m.hostOf(sess)
	if err != nil {
		return
	}
	id := shellTermID(sessionID)
	_ = host.Kill(ctx, id)
	_ = host.Remove(ctx, id)
}
