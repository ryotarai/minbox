package server

import (
	"context"
	"crypto/rand"
	"errors"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

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
	cfg     Config
	store   *store.Store
	hub     *hub
	hosts   *hostSet
	localFS *hostfs.Local

	mu sync.Mutex
	// shellMu serialises starting companion shells (two attaches must not spawn twice).
	shellMu sync.Mutex
	// stopping holds sessions the person stopped: their exit is a close.
	stopping map[string]bool
}

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

// Create records a new session and starts Claude Code in it.
func (m *sessionManager) Create(ctx context.Context, name, cwd, hostID string) (*store.Session, error) {
	return m.CreateKind(ctx, store.KindClaude, name, cwd, hostID)
}

// CreateKind records a new session of a kind: Claude Code (store.KindClaude)
// or the host's own login shell (store.KindShell), and starts it.
func (m *sessionManager) CreateKind(ctx context.Context, kind, name, cwd, hostID string) (*store.Session, error) {
	switch kind {
	case "":
		kind = store.KindClaude
	case store.KindClaude, store.KindShell:
	default:
		return nil, fmt.Errorf("unknown kind: %s (claude or shell)", kind)
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
	claudeID := newUUID()
	if kind == store.KindShell {
		claudeID = ""
	}
	sess, err := m.store.CreateSessionKind(ctx, hostID, kind, name, cwd, claudeID)
	if err != nil {
		return nil, err
	}
	if err := m.spawn(ctx, sess, false); err != nil {
		_ = m.store.SetSessionEnded(ctx, sess.ID, -1)
		m.hub.publish(Event{Type: "sessions"})
		return nil, err
	}
	m.hub.publish(Event{Type: "sessions"})
	return m.store.GetSession(ctx, sess.ID)
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
	argv := append([]string{}, m.cfg.ClaudeCommand...)
	plugin := m.cfg.PluginDir
	if m.remote(sess.HostID) {
		plugin = termhost.PluginDirPlaceholder
	}
	argv = append(argv, "--plugin-dir", plugin)
	exists := false
	if resume && sess.ClaudeSessionID != "" {
		if f, err := m.fsOf(sess.HostID); err == nil {
			exists = f.TranscriptExists(ctx, sess.Cwd, sess.ClaudeSessionID)
		}
	}
	if exists {
		argv = append(argv, "--resume", sess.ClaudeSessionID)
	} else if sess.ClaudeSessionID != "" {
		argv = append(argv, "--session-id", sess.ClaudeSessionID)
	}
	// The mod adds these to the system prompt too (prompt.compose), but some
	// environments skip that hook: the command line carries them as well.
	argv = append(argv, "--append-system-prompt", AgentSystemPrompt)
	return argv
}

// AgentSystemPrompt is minbox's part of Claude's system prompt: reach the
// person through the inbox, keep the session's title current, and open pages
// in the person's browser (the host may be another machine). The mod's
// inboxSection, titleSection and openSection say the same.
const AgentSystemPrompt = `# minbox: inbox
The person follows this session through the minbox inbox and may not be watching the terminal. mcp__minbox__send_message is how you reach them:
- Every time you need their opinion, a decision, an approval or an action from them (run or check something, review, choose what comes next), send it with the tool, each decision as a :::question block. Do this every time, also for small questions; a question asked only in your chat reply goes unseen.
- When you finish a task or a long stretch of work, send a short summary of what is done and anything they should look at.
- Then keep working on what does not depend on the answer, or end your turn; their reply arrives here by itself. Do not ask the same thing again in the chat.

# minbox: session title
The person sees this session in minbox's session list under a title you set with mcp__minbox__set_session_title. Keep it current:
- Set it once the task is clear, early in the first turn: a few words naming the work (e.g. "Fix login redirect loop"), not a status or a sentence.
- Set it again whenever the main task changes (a new request, a different bug, the next phase); leave it alone for small steps within the same task.
- Plain text, at most 80 characters, in the person's language. Do not mention the title in your replies.

# minbox: opening pages
When the person asks you to open, show or view a web page (a PR, an issue, a CI run, a URL), call mcp__minbox__open_url with its URL. It opens the page in the browser they are using minbox from.
- Never open pages with Bash (` + "`open URL`, `xdg-open`, `gh pr view --web`, `gh browse`" + `, …): those open on the machine you run on, which may be a remote host the person is not sitting at.
- With gh, get the URL first (e.g. ` + "`gh pr view --json url -q .url`" + `), then pass it to the tool.`

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
	return append(env,
		"MINBOX_SESSION_ID="+sess.ID,
		"MINBOX_TOKEN="+sess.Token,
		"MINBOX_SERVER_FILE="+serverFile,
	)
}

func (m *sessionManager) spawn(ctx context.Context, sess *store.Session, resume bool) error {
	host, err := m.hostOf(sess)
	if err != nil {
		return err
	}
	_ = host.Remove(ctx, sess.ID) // forget an exited terminal of the same id
	_, err = host.Spawn(ctx, termhost.SpawnRequest{
		ID:         sess.ID,
		Argv:       m.argv(ctx, sess, resume),
		Cwd:        sess.Cwd,
		Env:        m.sessionEnv(sess),
		InheritEnv: m.remote(sess.HostID) || sess.Kind == store.KindShell,
		Cols:       120,
		Rows:       36,
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

// Restart starts an ended session again, resuming its conversation.
func (m *sessionManager) Restart(ctx context.Context, id string) error {
	sess, err := m.store.GetSession(ctx, id)
	if err != nil {
		return err
	}
	if sess.Status != store.StatusEnded {
		return fmt.Errorf("session is running")
	}
	if err := m.store.RestartSession(ctx, id); err != nil {
		return err
	}
	err = m.spawn(ctx, sess, true)
	if err != nil {
		_ = m.store.SetSessionEnded(ctx, id, -1)
	}
	m.hub.publish(Event{Type: "sessions"})
	return err
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
func (m *sessionManager) Delete(ctx context.Context, id string) error {
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
	err := m.store.DeleteSession(ctx, id)
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
	delete(m.stopping, id)
	m.mu.Unlock()
	m.endShell(ctx, id)
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
		client, err := connect(ctx)
		if err == nil {
			m.hosts.local().setClient(client, nil)
			if v, verr := client.Version(ctx); verr == nil {
				m.hosts.local().setVersion(v, 0)
			}
			err = m.Reconcile(ctx)
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
		err = client.Events(ctx, func(ev termhost.Event) {
			if ev.Type == "exit" {
				m.onExit(ctx, ev.ID, ev.ExitCode)
			}
		})
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
