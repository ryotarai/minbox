// Package server is the minbox HTTP server: the web app, the browser API, the
// terminal WebSocket bridge and the API the Claude Code mod calls.
package server

import (
	"context"
	"crypto/ed25519"
	"encoding/json"
	"errors"
	"io/fs"
	"log"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/ryotarai/minbox/internal/agent"
	"github.com/ryotarai/minbox/internal/hostauth"
	"github.com/ryotarai/minbox/internal/hostfs"
	"github.com/ryotarai/minbox/internal/notify"
	"github.com/ryotarai/minbox/internal/store"
	"github.com/ryotarai/minbox/internal/termhost"
)

// Config configures a Server.
type Config struct {
	// ListenAny: --listen on a non-loopback address; every remote browser must be paired.
	ListenAny     bool
	Addr          string   // listen address, e.g. 127.0.0.1:4848
	DataDir       string   // ~/.minbox
	ClaudeCommand []string // e.g. ["claude"]
	// PiCommand starts Pi (MINBOX_PI), e.g. ["pi"]; empty: Pi is not offered.
	PiCommand []string
	// PiExtension is the extracted minbox extension for Pi (plugin/pi/minbox.ts), passed with -e.
	PiExtension string
	// PiSubagentExtension is the extracted subagent extension (plugin/pi/subagent.ts), a second -e.
	PiSubagentExtension string
	// PiHelperModel is the model Pi uses for one-shot helper runs (MINBOX_PI_HELPER_MODEL); empty: Pi's own default.
	PiHelperModel string
	// OpenCodeCommand starts OpenCode 2.x (MINBOX_OPENCODE), e.g. ["opencode"]; empty: OpenCode is not offered.
	OpenCodeCommand []string
	// OpenCodePlugin is the extracted minbox plugin folder for OpenCode (plugin/opencode), loaded
	// through OPENCODE_CONFIG_CONTENT.
	OpenCodePlugin string
	// OpenCodeHelperModel is the model of OpenCode's helper runs (MINBOX_OPENCODE_HELPER_MODEL, provider/model);
	// empty: OpenCode's own default.
	OpenCodeHelperModel string
	// OpenCodeRunner runs the opencode CLI for session checks (nil: on this machine). Tests replace it.
	OpenCodeRunner agent.Runner
	// SuggestCommand starts the reply-suggestions generator (MINBOX_SUGGEST_COMMAND); empty: the first word of ClaudeCommand.
	SuggestCommand []string
	// PickModel is the model that picks the project of a new thread from a Slack DM (MINBOX_PICK_MODEL); empty: claude-haiku-5-5.
	PickModel  string
	PluginDir  string // the extracted minbox mod
	ServerFile string // where the server writes its URL for the mod
	ScratchDir string // pasted images go here
	HostURL    string // how the built-in host is shown (unix://…)
	// Tailscale: requests through tailscale serve must come from this login
	// (empty: any). PublicHosts are the Host names the server answers to
	// besides loopback (its MagicDNS name).
	TailscaleLogin string
	PublicHosts    []string
}

// Server is the minbox server.
type Server struct {
	cfg      Config
	store    *store.Store
	hub      *hub
	sessions *sessionManager
	suggest  *suggester
	// envMu serializes changes of an agent's environment variables (patchSessionEnv).
	envMu sync.Mutex
	// poller receives messages from Slack (RunSlackInbound runs it); its status feeds the Notifications API.
	poller *notify.Poller
	// pickRun runs the project-picking model (replaced in tests).
	pickRun func(ctx context.Context, prompt string) ([]byte, error)
	// agentPickRun runs the agent-picking model (agentpick.go; replaced in tests).
	agentPickRun func(ctx context.Context, prompt string) ([]byte, error)
	// manualGoalTicks (tests): the goals' runs tick only when the test calls goalTick, never on the
	// ticker or a kick (kickGoals), so a test decides when each tick happens.
	manualGoalTicks atomic.Bool
	web             fs.FS
	handler         http.Handler

	pendingMu sync.Mutex
	pendingCh map[string]chan struct{}

	// The mod's last contact per session, and the timers that publish the flip to "silent".
	modMu          sync.Mutex
	modSeen        map[string]time.Time
	modTimers      map[string]*time.Timer
	modSilentAfter time.Duration
	startedAt      time.Time
	// The mod connection (modconn.go): heartbeats, stale detection, per-session logs.
	modConns            map[string]*modConn
	modStaleAfter       time.Duration
	modUndeliveredAfter time.Duration
	clock               func() time.Time // nil: time.Now (tests inject one)
	// Stuck agents (stuck.go): per-agent state, thresholds, the watch's wake-up, the terminal reader.
	stuckMu           sync.Mutex
	stuck             map[string]*stuckState
	stuckStartupAfter time.Duration
	stuckMessageAfter time.Duration
	stuckWake         chan struct{}
	stuckTail         func(ctx context.Context, sess *store.Session) ([]byte, error)
	// The mod protocol (modproto.go): the in-process agent API and the sessions' turn state.
	innerOnce sync.Once
	inner     *http.ServeMux
	proxyMu   sync.Mutex
	proxy     map[string]*proxyState
	closing   chan struct{}
	closeOnce sync.Once

	files *fileState

	hostsCtx context.Context

	// The key this server signs host requests with, and its name hosts see.
	signer     *hostauth.Signer
	serverName string
	// Tailscale: the status source and how a peer is reached (tests replace them).
	tailscaleStatus func(ctx context.Context) ([]byte, error)
	peerURL         func(dnsName string) string
	pairPoll        time.Duration

	devAuth *deviceAuth

	// notifier sends the notifications of new agent messages.
	notifier *notify.Dispatcher

	// lin is the Linear integration (see linear.go).
	lin *linearSvc
	// slack is the personal Slack integration (slackpersonal.go).
	slack *slackSvc
	// commandTimeout overrides the 60 s limit of "!" commands (tests).
	commandTimeout time.Duration
	// runCmds serializes the runs of the commands agents ask the person to run (runcommands.go);
	// runCmdTimeout overrides their 10 min limit (tests).
	runCmds       runCmdState
	runCmdTimeout time.Duration

	// binary is this server's build (termhost.BinaryID), to tell an outdated host.
	binary string
	// Restarting the local host (hostrestart.go): one at a time; stopLocalHost
	// is termhost.Stop on its socket (tests replace it).
	hostRestartMu  sync.Mutex
	hostRestarting atomic.Bool
	stopLocalHost  func(ctx context.Context) (pid int, running bool, err error)
}

// New builds a server. web holds the built frontend (index.html at its root).
func New(cfg Config, st *store.Store, web fs.FS) *Server {
	h := newHub()
	s := &Server{
		cfg:                 cfg,
		store:               st,
		hub:                 h,
		web:                 web,
		pendingCh:           map[string]chan struct{}{},
		modSeen:             map[string]time.Time{},
		modTimers:           map[string]*time.Timer{},
		modSilentAfter:      modSilentAfterFromEnv(),
		startedAt:           time.Now(),
		modConns:            map[string]*modConn{},
		modStaleAfter:       modSilentAfterFromEnv(),
		modUndeliveredAfter: modUndeliveredDefault,
		stuck:               map[string]*stuckState{},
		stuckStartupAfter:   durationFromEnv("MINBOX_STUCK_STARTUP_S", stuckStartupDefault),
		stuckMessageAfter:   durationFromEnv("MINBOX_STUCK_MESSAGE_S", stuckMessageDefault),
		stuckWake:           make(chan struct{}, 1),
		closing:             make(chan struct{}),
		files:               newFileState(),
		devAuth:             newDeviceAuth(),
		sessions: &sessionManager{
			cfg: cfg, store: st, hub: h, stopping: map[string]bool{}, restarting: map[string]*restartState{},
			hosts: newHostSet(),
			localFS: &hostfs.Local{Areas: map[string]string{
				hostfs.AreaScratch: cfg.ScratchDir,
				hostfs.AreaUploads: filepath.Join(cfg.DataDir, "uploads"),
				hostfs.AreaMarkups: filepath.Join(cfg.DataDir, "markups"),
			}},
		},
	}
	s.sessions.modLog, s.sessions.modForget = s.modLog, s.modForget
	s.sessions.spawned = s.stuckSpawned
	s.stuckTail = s.sessions.tail
	s.lin = newLinearSvc(s)
	s.slack = newSlackSvc(s)
	s.poller = notify.NewPoller(st, slackInbound{s})
	s.poller.Changed = func() { h.publish(Event{Type: "notifications"}) }
	s.suggest = newSuggester(s.runSuggest)
	s.pickRun = s.runPick
	s.agentPickRun = s.runAgentPick
	key, err := hostauth.LoadOrCreateKey(filepath.Join(cfg.DataDir, "server-key"))
	if err != nil {
		log.Printf("server key: %v (using a key for this run only)", err)
		_, key, _ = ed25519.GenerateKey(nil)
	}
	s.signer = &hostauth.Signer{Key: key}
	s.serverName, _ = os.Hostname()
	if s.serverName == "" {
		s.serverName = "minbox"
	}
	s.tailscaleStatus = tailscaleStatusJSON
	s.peerURL = tailnetHostURL
	s.pairPoll = time.Second
	hostURL := cfg.HostURL
	if hostURL == "" {
		hostURL = "unix://" + filepath.Join(cfg.DataDir, "termhost.sock")
		s.cfg.HostURL = hostURL
	}
	s.binary = termhost.BinaryID()
	s.stopLocalHost = s.stopLocalHostDefault
	if err := st.EnsureLocalHost(context.Background(), hostURL); err != nil {
		log.Printf("hosts: %v", err)
	}
	s.notifier = notify.NewDispatcher(st)
	s.notifier.Changed = func() { h.publish(Event{Type: "notifications"}) }
	// A renamed or finished task shows it on the parent of its Slack thread.
	st.OnTaskChange(func(_, cur store.Task) { s.notifyTaskChanged(cur) })
	s.watchStartup()
	if err := st.FailRunningCommands(context.Background()); err != nil {
		log.Printf("commands: %v", err)
	}
	s.reportPendingRunResults()
	s.handler = s.routes()
	go s.runGoals(2 * time.Second)
	go s.runStuck()
	return s
}

// RunHost keeps the server connected to the terminal host; it returns once the
// first connection attempt finished (with its error), and keeps going in the
// background until ctx ends.
func (s *Server) RunHost(ctx context.Context, connect func(context.Context) (*termhost.Client, error)) error {
	ready := make(chan error, 1)
	s.startHosts(ctx)
	go s.watchDevices(ctx)
	go s.sessions.Run(ctx, connect, ready)
	return <-ready
}

func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) { s.handler.ServeHTTP(w, r) }

func (s *Server) routes() http.Handler {
	mux := http.NewServeMux()

	// Browser API.
	mux.HandleFunc("GET /api/events", s.hub.serveSSE)
	mux.HandleFunc("GET /api/sessions", s.listSessions)
	mux.HandleFunc("POST /api/sessions", s.createSession)
	mux.HandleFunc("PATCH /api/sessions/{id}", s.updateSession)
	mux.HandleFunc("PATCH /api/sessions/{id}/env", s.patchSessionEnv)
	mux.HandleFunc("GET /api/sessions/{id}/connection", s.getConnection)
	mux.HandleFunc("DELETE /api/sessions/{id}", s.deleteSession)
	mux.HandleFunc("POST /api/sessions/{id}/restart", s.restartSession)
	mux.HandleFunc("POST /api/sessions/{id}/stop", s.stopSession)
	mux.HandleFunc("GET /api/sessions/{id}/terminal", s.terminalWS)
	mux.HandleFunc("GET /api/sessions/{id}/shell/terminal", s.shellWS)
	mux.HandleFunc("POST /api/sessions/{id}/uploads", s.upload)
	mux.HandleFunc("GET /api/projects", s.listProjects)
	mux.HandleFunc("POST /api/projects", s.createProject)
	mux.HandleFunc("PATCH /api/projects/{id}", s.patchProject)
	mux.HandleFunc("DELETE /api/projects/{id}", s.deleteProject)
	mux.HandleFunc("PUT /api/projects/{id}/icon", s.putProjectIcon)
	mux.HandleFunc("DELETE /api/projects/{id}/icon", s.deleteProjectIcon)
	mux.HandleFunc("GET /api/projects/{id}/icon", s.getProjectIcon)
	mux.HandleFunc("GET /api/projects/{id}/delete-preview", s.projectDeletePreview)
	mux.HandleFunc("POST /api/projects/{id}/archive", s.archiveProject(true))
	mux.HandleFunc("POST /api/projects/{id}/unarchive", s.archiveProject(false))
	mux.HandleFunc("GET /api/threads", s.listAllThreads)
	mux.HandleFunc("GET /api/sessions/{id}/threads", s.listThreads)
	mux.HandleFunc("POST /api/sessions/{id}/threads", s.createUserThread)
	mux.HandleFunc("GET /api/threads/{id}", s.getThread)
	mux.HandleFunc("GET /api/threads/{id}/suggestions", s.threadSuggestions)
	mux.HandleFunc("POST /api/threads/{id}/fork/preview", s.forkPreview)
	mux.HandleFunc("POST /api/threads/{id}/fork", s.forkThread)
	mux.HandleFunc("GET /api/threads/{id}/linear", s.getThreadLinear)
	mux.HandleFunc("PUT /api/threads/{id}/linear", s.putThreadLinear)
	mux.HandleFunc("DELETE /api/threads/{id}/linear", s.deleteThreadLinear)
	mux.HandleFunc("POST /api/threads/{id}/linear/refresh", s.refreshThreadLinear)
	mux.HandleFunc("POST /api/threads/{id}/linear/draft", s.linearDraft)
	mux.HandleFunc("POST /api/threads/{id}/linear/team/{teamId}/lists", s.linearTeamLists)
	mux.HandleFunc("POST /api/threads/{id}/linear/create", s.linearCreate)
	// My issues: the issues assigned to the person, one issue, a thread started from it, and creating
	// an issue from plain language (no thread).
	mux.HandleFunc("GET /api/linear/issues", s.linearIssuesList)
	mux.HandleFunc("GET /api/linear/search", s.linearSearch)
	mux.HandleFunc("POST /api/linear/issues", s.linearIssueCreate)
	mux.HandleFunc("POST /api/linear/issues/draft", s.linearIssueDraft)
	mux.HandleFunc("POST /api/linear/issues/team/{teamId}/lists", s.linearIssueTeamLists)
	mux.HandleFunc("GET /api/linear/issues/{id}", s.linearIssueGet)
	mux.HandleFunc("POST /api/linear/issues/{id}/thread", s.linearIssueStartThread)
	mux.HandleFunc("POST /api/linear/issues/{id}/thread/preview", s.linearIssueThreadPreview)
	mux.HandleFunc("POST /api/linear/issues/{id}/project-suggestion", s.linearIssueProjectSuggestion)
	mux.HandleFunc("GET /api/integrations/linear", s.linearStatus)
	mux.HandleFunc("POST /api/integrations/linear/login", s.linearLogin)
	mux.HandleFunc("GET /api/integrations/linear/callback", s.linearCallback)
	mux.HandleFunc("POST /api/integrations/linear/disconnect", s.linearDisconnect)
	mux.HandleFunc("POST /api/integrations/linear/test", s.linearTest)
	mux.HandleFunc("GET /api/integrations/slack-user", s.slackUserStatus)
	mux.HandleFunc("PUT /api/integrations/slack-user", s.slackUserPut)
	mux.HandleFunc("POST /api/integrations/slack-user/test", s.slackUserTest)
	mux.HandleFunc("POST /api/integrations/slack-user/disconnect", s.slackUserDisconnect)
	mux.HandleFunc("POST /api/integrations/slack-user/clear-cache", s.slackUserClearCache)
	mux.HandleFunc("GET /api/slack/threads", s.slackThreadsList)
	mux.HandleFunc("GET /api/slack/threads/{id}", s.slackThreadGet)
	mux.HandleFunc("POST /api/slack/threads/{id}/state", s.slackThreadState)
	mux.HandleFunc("POST /api/slack/threads/{id}/project-suggestion", s.slackProjectSuggestion)
	mux.HandleFunc("POST /api/slack/threads/{id}/thread/preview", s.slackThreadPreview)
	mux.HandleFunc("POST /api/slack/threads/{id}/thread", s.slackThreadStart)
	mux.HandleFunc("POST /api/threads/{id}/read", s.markRead)
	mux.HandleFunc("POST /api/threads/{id}/unread", s.markUnread)
	mux.HandleFunc("POST /api/threads/{id}/reply", s.reply)
	mux.HandleFunc("PATCH /api/threads/{id}", s.patchThread)
	mux.HandleFunc("POST /api/threads/{id}/mark-read", s.threadOp(s.store.SetAside))
	mux.HandleFunc("POST /api/threads/{id}/unmark-read", s.threadOp(s.store.UndoSetAside))
	mux.HandleFunc("POST /api/threads/{id}/archive", s.threadOp(func(ctx context.Context, id string) error { return s.store.SetThreadArchived(ctx, id, true) }))
	mux.HandleFunc("POST /api/threads/{id}/unarchive", s.threadOp(func(ctx context.Context, id string) error { return s.store.SetThreadArchived(ctx, id, false) }))
	mux.HandleFunc("POST /api/threads/{id}/pin", s.threadOp(func(ctx context.Context, id string) error { return s.store.SetThreadPinned(ctx, id, true) }))
	mux.HandleFunc("POST /api/threads/{id}/unpin", s.threadOp(func(ctx context.Context, id string) error { return s.store.SetThreadPinned(ctx, id, false) }))
	mux.HandleFunc("POST /api/threads/{id}/status", s.setThreadStatus)
	mux.HandleFunc("POST /api/threads/{id}/snooze", s.snoozeThread)
	mux.HandleFunc("POST /api/threads/{id}/unsnooze", s.threadOp(func(ctx context.Context, id string) error { return s.store.SnoozeThread(ctx, id, nil) }))
	mux.HandleFunc("POST /api/threads/{id}/reask", s.reask)
	mux.HandleFunc("POST /api/messages/{id}/send-now", s.sendNow)
	mux.HandleFunc("POST /api/messages/{id}/cancel", s.cancelMessage)
	mux.HandleFunc("POST /api/sessions/{id}/archive", s.archiveSession)
	mux.HandleFunc("POST /api/sessions/{id}/unarchive", s.unarchiveSession)
	mux.HandleFunc("POST /api/sessions/{id}/files", s.uploadFile)
	mux.HandleFunc("GET /api/sessions/{id}/completions", s.completions)
	mux.HandleFunc("GET /api/sessions/{id}/files", s.listFiles)
	mux.HandleFunc("GET /api/sessions/{id}/tree", s.sessionTree)
	mux.HandleFunc("GET /api/sessions/{id}/tree/status", s.sessionTreeStatus)
	mux.HandleFunc("GET /api/sessions/{id}/tree/file", s.sessionTreeFile)
	mux.HandleFunc("GET /api/sessions/{id}/tree/raw", s.sessionTreeRaw)
	mux.HandleFunc("GET /api/attachments/{id}", s.getAttachment)
	mux.HandleFunc("GET /api/attachments/{id}/raw", s.rawAttachment)
	mux.HandleFunc("GET /api/attachments/{id}/download", s.downloadAttachment)
	mux.HandleFunc("GET /api/attachments/{id}/view", s.viewAttachment)
	mux.HandleFunc("GET /api/attachments/{id}/markdown-image", s.markdownImage)
	mux.HandleFunc("GET /api/attachments/{id}/linked", s.linkedPage)
	mux.HandleFunc("GET /api/html-assets/{token}/{path...}", s.htmlAssets)
	mux.HandleFunc("POST /api/embeds", s.postEmbed)
	mux.HandleFunc("GET /api/embeds/{id}", s.getEmbed)
	mux.HandleFunc("GET /api/messages/{id}/image", s.messageImage)
	mux.HandleFunc("POST /api/uploads", s.postUpload)
	mux.HandleFunc("GET /api/uploads/{id}/text", s.uploadText)
	mux.HandleFunc("DELETE /api/uploads/{id}", s.deleteUpload)
	mux.HandleFunc("POST /api/markups", s.postMarkup)
	mux.HandleFunc("GET /api/markups/{name}", s.getMarkup)
	mux.HandleFunc("GET /api/search", s.search)
	mux.HandleFunc("GET /api/topics", s.listTopics)
	mux.HandleFunc("GET /api/topics/{id}", s.getTopic)
	mux.HandleFunc("PATCH /api/topics/{id}", s.patchTopic)
	mux.HandleFunc("GET /api/v3/board", s.v3Board)
	mux.HandleFunc("GET /api/v3/tasks/{id}", s.v3Task)
	mux.HandleFunc("GET /api/v3/tasks/{id}/suggestions", s.v3TaskSuggestions)
	mux.HandleFunc("PATCH /api/v3/tasks/{id}", s.v3PatchTask)
	mux.HandleFunc("POST /api/v3/tasks", s.v3CreateTask)
	mux.HandleFunc("POST /api/v3/tasks/{id}/auto", s.v3Auto)
	mux.HandleFunc("GET /api/v3/sessions/{id}/stream", s.v3Stream)
	mux.HandleFunc("POST /api/v3/sessions/{id}/messages", s.v3Send)
	mux.HandleFunc("POST /api/v3/new", s.v3New)
	mux.HandleFunc("PUT /api/v3/messages/{id}/task", s.v3SetTask)
	mux.HandleFunc("POST /api/v3/messages/{id}/tasks", s.v3SetTask)
	mux.HandleFunc("DELETE /api/v3/messages/{id}/tasks/{task}", s.v3UnlinkTask)
	mux.HandleFunc("POST /api/v3/messages/{id}/move", s.v3Move)
	mux.HandleFunc("POST /api/v3/messages/{id}/ignore", s.v3Ignore(true))
	mux.HandleFunc("POST /api/v3/messages/{id}/unignore", s.v3Ignore(false))
	mux.HandleFunc("POST /api/v3/messages/{id}/commands", s.decideRunCommands)
	mux.HandleFunc("POST /api/v3/read", s.v3Read)
	mux.HandleFunc("POST /api/v3/unread", s.v3Unread)
	mux.HandleFunc("GET /api/v3/search", s.v3Search)
	mux.HandleFunc("GET /api/settings", s.getSettings)
	mux.HandleFunc("PUT /api/settings", s.putSettings)
	mux.HandleFunc("GET /api/notifications", s.listNotifications)
	mux.HandleFunc("POST /api/notifications", s.createNotification)
	mux.HandleFunc("PATCH /api/notifications/{id}", s.patchNotification)
	mux.HandleFunc("DELETE /api/notifications/{id}", s.deleteNotification)
	mux.HandleFunc("POST /api/notifications/{id}/test", s.testNotification)
	mux.HandleFunc("POST /api/notifications/{id}/check", s.checkNotification)
	mux.HandleFunc("GET /api/storage", s.storage)
	mux.HandleFunc("POST /api/storage/clear-scratch", s.clearScratch)
	mux.HandleFunc("GET /api/about", s.about)
	mux.HandleFunc("GET /api/agents", s.listAgents)
	mux.HandleFunc("GET /api/hosts", s.listHosts)
	mux.HandleFunc("POST /api/hosts", s.addHost)
	mux.HandleFunc("GET /api/hosts/tailscale", s.tailscaleInfo)
	mux.HandleFunc("POST /api/hosts/probe", s.probeHostRoute)
	mux.HandleFunc("POST /api/hosts/{id}/repair", s.repairHost)
	mux.HandleFunc("PATCH /api/hosts/{id}", s.patchHost)
	mux.HandleFunc("DELETE /api/hosts/{id}", s.deleteHost)
	mux.HandleFunc("POST /api/hosts/{id}/retry", s.retryHost)
	mux.HandleFunc("POST /api/hosts/{id}/restart", s.restartHost)
	mux.HandleFunc("POST /api/devices/pair", s.devicePair)
	mux.HandleFunc("GET /api/devices/pair/{id}", s.devicePairStatus)
	mux.HandleFunc("POST /api/devices/auth/challenge", s.deviceChallenge)
	mux.HandleFunc("POST /api/devices/auth", s.deviceSignIn)
	mux.HandleFunc("GET /api/devices/me", s.deviceMe)
	mux.HandleFunc("GET /api/devices", s.listDevices)
	mux.HandleFunc("POST /api/devices/requests/{id}/accept", s.decideDevice(true))
	mux.HandleFunc("POST /api/devices/requests/{id}/reject", s.decideDevice(false))
	mux.HandleFunc("DELETE /api/devices/{id}", s.revokeDevice)
	mux.HandleFunc("GET /api/fs/dirs", s.listDirs)
	mux.HandleFunc("POST /api/fs/mkdir", s.makeDir)

	// The Claude Code mod's API (bearer token per session).
	for _, rt := range s.agentRoutes() {
		mux.HandleFunc(rt.pattern, s.agent(rt.h))
	}

	mux.HandleFunc("/api/", func(w http.ResponseWriter, r *http.Request) { httpError(w, 404, "not found") })
	mux.Handle("/", s.static())
	return s.guard(mux)
}

// guard protects the local server from other web pages: the Host must be a
// loopback name (DNS rebinding), and a cross-origin browser request is refused (CSRF).
func loopbackHost(hostport string) bool {
	host, _, err := net.SplitHostPort(hostport)
	if err != nil {
		host = hostport
	}
	host = strings.Trim(host, "[]")
	if host == "localhost" {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

func (s *Server) static() http.Handler {
	files := http.FileServerFS(s.web)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		p := strings.TrimPrefix(r.URL.Path, "/")
		if p != "" {
			if _, err := fs.Stat(s.web, p); err == nil {
				if strings.HasPrefix(p, "assets/") {
					w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
				}
				files.ServeHTTP(w, r)
				return
			}
		}
		// SPA: every other path is the app.
		b, err := fs.ReadFile(s.web, "index.html")
		if err != nil {
			http.Error(w, "frontend not built (run `make web`)", 500)
			return
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Header().Set("Cache-Control", "no-cache")
		_, _ = w.Write(b)
	})
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func httpError(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]string{"error": msg})
}

func storeError(w http.ResponseWriter, err error) {
	if errors.Is(err, store.ErrNotFound) {
		httpError(w, 404, "not found")
		return
	}
	if errors.Is(err, store.ErrProjectBusy) || errors.Is(err, store.ErrProjectExists) {
		httpError(w, 409, err.Error())
		return
	}
	log.Printf("error: %v", err)
	httpError(w, 500, err.Error())
}

func decode(w http.ResponseWriter, r *http.Request, v any) bool {
	r.Body = http.MaxBytesReader(w, r.Body, 4<<20)
	if err := json.NewDecoder(r.Body).Decode(v); err != nil {
		httpError(w, 400, "invalid JSON: "+err.Error())
		return false
	}
	return true
}
