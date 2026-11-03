// Package termhost is the terminal host: a separate, long-lived process that
// owns the PTYs, so restarting (updating) the minbox server does not end the
// sessions running in them. The server talks to it over HTTP on a Unix socket.
package termhost

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"os/exec"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/coder/websocket"
	"github.com/creack/pty"
	"github.com/ryotarai/minbox/internal/hostauth"
	"github.com/ryotarai/minbox/internal/hostfs"
)

// ProtocolVersion is the terminal host's protocol version.
// 3: remote hosts check signed requests (pairing) instead of a token.
// 4: a "resize" from a client is the size it wants; the PTY takes the smallest
// of the attached clients' and grows back when the smallest one leaves.
const ProtocolVersion = 4

// RemoteProtocol is the lowest host protocol a server pairs with over the network.
const RemoteProtocol = 3

// RequiredServerVersion is the lowest server protocol version this host works with.
const RequiredServerVersion = 1

// Header names used in the version handshake: every request from the server
// carries its version, and the host refuses one older than it requires.
const (
	HeaderServerVersion = "X-Minbox-Server-Protocol"
)

// VersionInfo is what GET /version answers.
type VersionInfo struct {
	Protocol              int    `json:"protocol"`
	RequiredServerVersion int    `json:"required_server_version"`
	PID                   int    `json:"pid"`
	Version               string `json:"version,omitempty"` // the minbox binary
	OS                    string `json:"os,omitempty"`
	Arch                  string `json:"arch,omitempty"`
	// Remote: a host that serves other machines (pairing, file access, relay).
	Remote   bool   `json:"remote,omitempty"`
	Hostname string `json:"hostname,omitempty"`
	// Tailscale: it is reached through tailscale serve.
	Tailscale bool `json:"tailscale"`
}

// Placeholders the server puts in a remote host's spawn requests; the host
// replaces them with its own paths.
const (
	PluginDirPlaceholder  = "{{MINBOX_PLUGIN_DIR}}"
	ServerFilePlaceholder = "{{MINBOX_SERVER_FILE}}"
)

// SpawnRequest asks the host to start a process in a new PTY.
type SpawnRequest struct {
	ID   string   `json:"id"`
	Argv []string `json:"argv"`
	Cwd  string   `json:"cwd"`
	Env  []string `json:"env"`
	// InheritEnv: start from the host's own environment (another machine).
	InheritEnv bool   `json:"inherit_env,omitempty"`
	Cols       uint16 `json:"cols"`
	Rows       uint16 `json:"rows"`
}

// TerminalInfo describes a terminal the host holds.
type TerminalInfo struct {
	ID       string `json:"id"`
	PID      int    `json:"pid"`
	Running  bool   `json:"running"`
	ExitCode int    `json:"exit_code"`
}

// Event is sent on GET /events (one JSON object per line).
type Event struct {
	Type     string `json:"type"` // "exit"
	ID       string `json:"id"`
	ExitCode int    `json:"exit_code"`
}

// ResizeMessage is a text frame on the attach WebSocket: the size the client
// would fit. The PTY takes the smallest cols and rows of the attached clients.
type ResizeMessage struct {
	Type string `json:"type"` // "resize"
	Cols uint16 `json:"cols"`
	Rows uint16 `json:"rows"`
}

// SizeMessage is a text frame the host sends attached clients: the PTY size,
// after the replay and after every resize.
type SizeMessage struct {
	Type string `json:"type"` // "size"
	Cols uint16 `json:"cols"`
	Rows uint16 `json:"rows"`
}

// frame is what a subscriber gets: output bytes, or a text (JSON) frame.
type frame struct {
	text bool
	data []byte
}

const scrollbackLimit = 2 << 20 // bytes of output kept per terminal for replay

type terminal struct {
	id   string
	cmd  *exec.Cmd
	ptmx *os.File

	mu         sync.Mutex
	scrollback []byte
	subs       map[chan frame]struct{}
	wants      map[chan frame][2]uint16 // the size each attached client fits
	running    bool
	exitCode   int
	done       chan struct{}
	cols, rows uint16
}

func (t *terminal) sizeFrame() frame {
	b, _ := json.Marshal(SizeMessage{Type: "size", Cols: t.cols, Rows: t.rows})
	return frame{text: true, data: b}
}

// want records the size a client fits and sizes the PTY to the smallest.
func (t *terminal) want(ch chan frame, cols, rows uint16) {
	t.mu.Lock()
	defer t.mu.Unlock()
	if _, ok := t.subs[ch]; !ok {
		return
	}
	t.wants[ch] = [2]uint16{cols, rows}
	t.fitLocked()
}

// fitLocked sizes the PTY to the smallest wanted cols and rows; with no client
// telling its size, the PTY keeps the size it has.
func (t *terminal) fitLocked() {
	if len(t.wants) == 0 {
		return
	}
	var cols, rows uint16
	for _, w := range t.wants {
		if cols == 0 || w[0] < cols {
			cols = w[0]
		}
		if rows == 0 || w[1] < rows {
			rows = w[1]
		}
	}
	if cols != t.cols || rows != t.rows {
		t.resizeLocked(cols, rows)
	}
}

// resize sets the PTY size and tells every attached client.
func (t *terminal) resize(cols, rows uint16) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.resizeLocked(cols, rows)
}

func (t *terminal) resizeLocked(cols, rows uint16) {
	_ = pty.Setsize(t.ptmx, &pty.Winsize{Cols: cols, Rows: rows})
	t.cols, t.rows = cols, rows
	f := t.sizeFrame()
	for ch := range t.subs {
		select {
		case ch <- f:
		default:
			delete(t.subs, ch)
			close(ch)
		}
	}
}

func (t *terminal) info() TerminalInfo {
	t.mu.Lock()
	defer t.mu.Unlock()
	pid := 0
	if t.cmd.Process != nil {
		pid = t.cmd.Process.Pid
	}
	return TerminalInfo{ID: t.id, PID: pid, Running: t.running, ExitCode: t.exitCode}
}

// subscribe returns the scrollback so far, a channel of later output, and
// whether the process still runs (an exited terminal's channel gets nothing).
func (t *terminal) subscribe() ([]byte, chan frame, bool) {
	t.mu.Lock()
	defer t.mu.Unlock()
	ch := make(chan frame, 256)
	if t.running {
		t.subs[ch] = struct{}{}
		ch <- t.sizeFrame() // sent after the replay
	}
	return append([]byte(nil), t.scrollback...), ch, t.running
}

func (t *terminal) unsubscribe(ch chan frame) {
	t.mu.Lock()
	defer t.mu.Unlock()
	if _, ok := t.subs[ch]; ok {
		delete(t.subs, ch)
		close(ch)
	}
	if _, ok := t.wants[ch]; ok {
		delete(t.wants, ch)
		t.fitLocked() // the smallest left: grow to the next
	}
}

func (t *terminal) pump() {
	buf := make([]byte, 32*1024)
	for {
		n, err := t.ptmx.Read(buf)
		if n > 0 {
			chunk := append([]byte(nil), buf[:n]...)
			t.mu.Lock()
			t.scrollback = append(t.scrollback, chunk...)
			if over := len(t.scrollback) - scrollbackLimit; over > 0 {
				t.scrollback = append([]byte(nil), t.scrollback[over:]...)
			}
			for ch := range t.subs {
				select {
				case ch <- frame{data: chunk}:
				default: // slow reader: drop it; it will reattach and replay
					delete(t.subs, ch)
					close(ch)
				}
			}
			t.mu.Unlock()
		}
		if err != nil {
			return
		}
	}
}

// Host holds terminals and serves the host protocol.
type Host struct {
	mu        sync.Mutex
	terminals map[string]*terminal
	listeners map[chan Event]struct{}
	shutdown  func()

	// Versions, overridable in tests.
	Protocol       int
	RequiredServer int

	// A remote host (minbox host --listen / --tailscale): the keys it
	// accepts (paired servers), the Tailscale user it requires, file access,
	// and its own paths for the mod.
	Verifier       *hostauth.Verifier
	DataDir        string
	TailscaleLogin string
	FS             *hostfs.Local
	PluginDir      string
	ServerFile     string
	Version        string
	relay          *relayHub
}

func New() *Host {
	return &Host{
		terminals:      map[string]*terminal{},
		listeners:      map[chan Event]struct{}{},
		relay:          newRelayHub(),
		Protocol:       ProtocolVersion,
		RequiredServer: RequiredServerVersion,
	}
}

func (h *Host) broadcast(ev Event) {
	h.mu.Lock()
	defer h.mu.Unlock()
	for ch := range h.listeners {
		select {
		case ch <- ev:
		default:
		}
	}
}

// Spawn starts a process in a PTY.
func (h *Host) Spawn(req SpawnRequest) (TerminalInfo, error) {
	if req.ID == "" || len(req.Argv) == 0 {
		return TerminalInfo{}, errors.New("id and argv are required")
	}
	h.mu.Lock()
	if t, ok := h.terminals[req.ID]; ok && t.info().Running {
		h.mu.Unlock()
		return TerminalInfo{}, fmt.Errorf("terminal %s is running", req.ID)
	}
	h.mu.Unlock()

	sub := strings.NewReplacer(PluginDirPlaceholder, h.PluginDir, ServerFilePlaceholder, h.ServerFile)
	argv := make([]string, len(req.Argv))
	for i, a := range req.Argv {
		argv[i] = sub.Replace(a)
	}
	var env []string
	if req.InheritEnv {
		env = CleanEnv(os.Environ())
	}
	for _, e := range req.Env {
		env = append(env, sub.Replace(e))
	}
	cmd := exec.Command(argv[0], argv[1:]...)
	cmd.Dir = req.Cwd
	cmd.Env = env
	cols, rows := req.Cols, req.Rows
	if cols == 0 {
		cols = 120
	}
	if rows == 0 {
		rows = 32
	}
	ptmx, err := pty.StartWithSize(cmd, &pty.Winsize{Cols: cols, Rows: rows})
	if err != nil {
		return TerminalInfo{}, err
	}
	t := &terminal{id: req.ID, cmd: cmd, ptmx: ptmx, subs: map[chan frame]struct{}{}, wants: map[chan frame][2]uint16{}, running: true, done: make(chan struct{}), cols: cols, rows: rows}
	h.mu.Lock()
	h.terminals[req.ID] = t
	h.mu.Unlock()

	go t.pump()
	go func() {
		err := cmd.Wait()
		code := 0
		if err != nil {
			var ee *exec.ExitError
			if errors.As(err, &ee) {
				code = ee.ExitCode()
			} else {
				code = -1
			}
		}
		t.mu.Lock()
		t.running = false
		t.exitCode = code
		for ch := range t.subs {
			close(ch)
		}
		t.subs = map[chan frame]struct{}{}
		t.mu.Unlock()
		ptmx.Close()
		close(t.done)
		h.broadcast(Event{Type: "exit", ID: t.id, ExitCode: code})
	}()
	return t.info(), nil
}

func (h *Host) get(id string) *terminal {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.terminals[id]
}

// Kill sends SIGHUP then SIGKILL to the terminal's process group.
func (h *Host) Kill(id string) error {
	t := h.get(id)
	if t == nil {
		return errNotFound
	}
	if !t.info().Running {
		return nil
	}
	pid := t.cmd.Process.Pid
	_ = syscall.Kill(-pid, syscall.SIGHUP)
	_ = t.cmd.Process.Signal(syscall.SIGHUP)
	select {
	case <-t.done:
	case <-time.After(3 * time.Second):
		_ = syscall.Kill(-pid, syscall.SIGKILL)
		_ = t.cmd.Process.Kill()
		<-t.done
	}
	return nil
}

// Remove forgets an exited terminal.
func (h *Host) Remove(id string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if t, ok := h.terminals[id]; ok && !t.running {
		delete(h.terminals, id)
	}
}

func (h *Host) List() []TerminalInfo {
	h.mu.Lock()
	ts := make([]*terminal, 0, len(h.terminals))
	for _, t := range h.terminals {
		ts = append(ts, t)
	}
	h.mu.Unlock()
	out := make([]TerminalInfo, 0, len(ts))
	for _, t := range ts {
		out = append(out, t.info())
	}
	return out
}

// KillAll ends every terminal (used before the host restarts).
func (h *Host) KillAll() {
	var wg sync.WaitGroup
	for _, info := range h.List() {
		wg.Add(1)
		go func(id string) { defer wg.Done(); _ = h.Kill(id) }(info.ID)
	}
	wg.Wait()
}

var errNotFound = errors.New("terminal not found")

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func httpError(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]string{"error": msg})
}

// Handler serves the host protocol.
func (h *Host) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /version", func(w http.ResponseWriter, r *http.Request) {
		v := VersionInfo{Protocol: h.Protocol, RequiredServerVersion: h.RequiredServer, PID: os.Getpid(),
			Version: h.Version, OS: runtime.GOOS, Arch: runtime.GOARCH, Remote: h.FS != nil, Tailscale: h.TailscaleLogin != ""}
		if h.FS != nil {
			v.Hostname, _ = os.Hostname()
			v.PID = 0 // not another machine's business
		}
		writeJSON(w, 200, v)
	})
	if h.FS != nil {
		mux.Handle("/fs/", hostfs.Handler(h.FS))
		mux.HandleFunc("GET /relay", h.relay.serveWS)
		mux.HandleFunc("POST /pair", h.pairRequest)
		mux.HandleFunc("GET /pair/{code}", h.pairStatus)
		mux.HandleFunc("DELETE /pair/self", h.pairForget)
	}
	mux.HandleFunc("GET /terminals", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, 200, h.List())
	})
	mux.HandleFunc("POST /terminals", func(w http.ResponseWriter, r *http.Request) {
		var req SpawnRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			httpError(w, 400, err.Error())
			return
		}
		info, err := h.Spawn(req)
		if err != nil {
			httpError(w, 500, err.Error())
			return
		}
		writeJSON(w, 200, info)
	})
	mux.HandleFunc("POST /terminals/{id}/kill", func(w http.ResponseWriter, r *http.Request) {
		if err := h.Kill(r.PathValue("id")); err != nil {
			httpError(w, 404, err.Error())
			return
		}
		writeJSON(w, 200, map[string]bool{"ok": true})
	})
	mux.HandleFunc("DELETE /terminals/{id}", func(w http.ResponseWriter, r *http.Request) {
		id := r.PathValue("id")
		_ = h.Kill(id)
		h.Remove(id)
		writeJSON(w, 200, map[string]bool{"ok": true})
	})
	mux.HandleFunc("GET /terminals/{id}/attach", h.attach)
	mux.HandleFunc("GET /events", h.events)
	mux.HandleFunc("POST /shutdown", func(w http.ResponseWriter, r *http.Request) {
		h.KillAll()
		writeJSON(w, 200, map[string]bool{"ok": true})
		if h.shutdown != nil {
			go h.shutdown()
		}
	})
	return h.tailscale(h.auth(h.versionGate(mux)))
}

// open routes need no signature: what a server asks before it is paired.
func openRoute(r *http.Request) bool {
	return r.URL.Path == "/version" ||
		(r.Method == "POST" && r.URL.Path == "/pair") ||
		(r.Method == "GET" && strings.HasPrefix(r.URL.Path, "/pair/") && r.URL.Path != "/pair/self")
}

type ctxKey struct{}

// auth requires a request signed by a paired server (a remote host), except
// on the open routes. The local host (Unix socket) has no verifier.
func (h *Host) auth(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if h.Verifier == nil || openRoute(r) {
			next.ServeHTTP(w, r)
			return
		}
		srv, err := h.Verifier.Verify(r)
		if err != nil {
			httpError(w, http.StatusUnauthorized, err.Error())
			return
		}
		next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), ctxKey{}, srv)))
	})
}

// tailscale requires the Tailscale user the host was started for on every
// request (tailscale serve sets the header; the host listens on 127.0.0.1 only).
func (h *Host) tailscale(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if h.TailscaleLogin != "" && r.Header.Get("Tailscale-User-Login") != h.TailscaleLogin {
			httpError(w, http.StatusForbidden, "this host only answers the Tailscale user "+h.TailscaleLogin)
			return
		}
		next.ServeHTTP(w, r)
	})
}

// pairRequest: a server asks to be paired; a person accepts it on this
// machine with `minbox pair accept CODE`.
func (h *Host) pairRequest(w http.ResponseWriter, r *http.Request) {
	var req struct {
		ServerName string `json:"server_name"`
		PublicKey  string `json:"public_key"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<16)).Decode(&req); err != nil {
		httpError(w, 400, err.Error())
		return
	}
	p, err := hostauth.NewPairing(h.DataDir, req.ServerName, req.PublicKey, time.Now())
	if err != nil {
		httpError(w, 400, err.Error())
		return
	}
	log.Printf("pairing request from %q (%s): run `minbox pair accept %s` to accept it", p.ServerName, p.Fingerprint, p.Code)
	writeJSON(w, 200, map[string]string{"code": p.Code})
}

func (h *Host) pairStatus(w http.ResponseWriter, r *http.Request) {
	p, err := hostauth.GetPairing(h.DataDir, r.PathValue("code"))
	if err != nil {
		httpError(w, 404, err.Error())
		return
	}
	writeJSON(w, 200, map[string]string{"status": p.Effective(time.Now())})
}

// pairForget removes the calling server's key (the server removed this host).
func (h *Host) pairForget(w http.ResponseWriter, r *http.Request) {
	srv, _ := r.Context().Value(ctxKey{}).(*hostauth.AuthorizedServer)
	if srv == nil {
		httpError(w, http.StatusUnauthorized, "not signed")
		return
	}
	if _, err := hostauth.Forget(h.DataDir, srv.Fingerprint); err != nil {
		httpError(w, 500, err.Error())
		return
	}
	writeJSON(w, 200, map[string]bool{"ok": true})
}

// versionGate refuses a server older than RequiredServer (except on /version,
// which the server reads to decide whether to restart the host).
func (h *Host) versionGate(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/version" && r.URL.Path != "/shutdown" && !strings.HasPrefix(r.URL.Path, "/pair") {
			v, _ := strconv.Atoi(r.Header.Get(HeaderServerVersion))
			if v < h.RequiredServer {
				httpError(w, http.StatusUpgradeRequired, fmt.Sprintf("server protocol %d is older than required %d", v, h.RequiredServer))
				return
			}
		}
		next.ServeHTTP(w, r)
	})
}

func (h *Host) events(w http.ResponseWriter, r *http.Request) {
	ch := make(chan Event, 64)
	h.mu.Lock()
	h.listeners[ch] = struct{}{}
	h.mu.Unlock()
	defer func() {
		h.mu.Lock()
		delete(h.listeners, ch)
		h.mu.Unlock()
	}()
	w.Header().Set("Content-Type", "application/x-ndjson")
	w.WriteHeader(200)
	flusher, _ := w.(http.Flusher)
	if flusher != nil {
		flusher.Flush()
	}
	enc := json.NewEncoder(w)
	ping := time.NewTicker(15 * time.Second)
	defer ping.Stop()
	for {
		select {
		case <-r.Context().Done():
			return
		case ev := <-ch:
			if err := enc.Encode(ev); err != nil {
				return
			}
		case <-ping.C:
			if err := enc.Encode(Event{Type: "ping"}); err != nil {
				return
			}
		}
		if flusher != nil {
			flusher.Flush()
		}
	}
}

func (h *Host) attach(w http.ResponseWriter, r *http.Request) {
	t := h.get(r.PathValue("id"))
	if t == nil {
		httpError(w, 404, errNotFound.Error())
		return
	}
	conn, err := websocket.Accept(w, r, nil)
	if err != nil {
		return
	}
	conn.SetReadLimit(1 << 20)
	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()
	defer conn.CloseNow()

	replay, ch, running := t.subscribe()
	defer t.unsubscribe(ch)
	if !running {
		// An exited terminal: show what it printed, then close.
		if len(replay) > 0 {
			_ = conn.Write(ctx, websocket.MessageBinary, replay)
		}
		conn.Close(websocket.StatusNormalClosure, "exited")
		return
	}

	go func() {
		defer cancel()
		for {
			typ, data, err := conn.Read(ctx)
			if err != nil {
				return
			}
			if typ == websocket.MessageBinary {
				if _, err := t.ptmx.Write(data); err != nil {
					return
				}
				continue
			}
			var msg ResizeMessage
			if json.Unmarshal(data, &msg) == nil && msg.Type == "resize" && msg.Cols > 0 && msg.Rows > 0 {
				t.want(ch, msg.Cols, msg.Rows)
			}
		}
	}()

	if len(replay) > 0 {
		if err := conn.Write(ctx, websocket.MessageBinary, replay); err != nil {
			return
		}
	}
	for {
		select {
		case <-ctx.Done():
			return
		case chunk, ok := <-ch:
			if !ok {
				conn.Close(websocket.StatusNormalClosure, "exited")
				return
			}
			typ := websocket.MessageBinary
			if chunk.text {
				typ = websocket.MessageText
			}
			if err := conn.Write(ctx, typ, chunk.data); err != nil {
				return
			}
		}
	}
}

// Serve runs the host on a Unix socket until it is shut down or ctx ends.
func Serve(ctx context.Context, socketPath string) error {
	// A live host already owns the socket: refuse to replace it.
	if c, err := net.DialTimeout("unix", socketPath, time.Second); err == nil {
		c.Close()
		return fmt.Errorf("a terminal host is already listening on %s", socketPath)
	}
	_ = os.Remove(socketPath)
	ln, err := net.Listen("unix", socketPath)
	if err != nil {
		return err
	}
	_ = os.Chmod(socketPath, 0o600)
	h := New()
	srv := &http.Server{Handler: h.Handler()}
	ctx, cancel := context.WithCancel(ctx)
	h.shutdown = cancel
	go func() {
		<-ctx.Done()
		h.KillAll()
		shutdownCtx, c := context.WithTimeout(context.Background(), 2*time.Second)
		defer c()
		_ = srv.Shutdown(shutdownCtx)
	}()
	log.Printf("terminal host (protocol %d) listening on %s", ProtocolVersion, socketPath)
	err = srv.Serve(ln)
	_ = os.Remove(socketPath)
	if errors.Is(err, http.ErrServerClosed) {
		return nil
	}
	return err
}

func writeFileAtomic(path string, b []byte) error {
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, b, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

// RemoteOptions configure a host that serves other machines' server.
type RemoteOptions struct {
	Addr    string // e.g. 0.0.0.0:4849 (Direct) or 127.0.0.1:4849 (Tailscale)
	DataDir string
	// TailscaleLogin: requests must carry this Tailscale-User-Login (set by tailscale serve).
	TailscaleLogin string
	PluginDir      string
	ServerFile     string
	Version        string
	// Listening is called with the bound address once the host listens.
	Listening func(addr string)
}

// ServeRemote runs a host over TCP: every request must be signed by a paired
// server (except /version and the pairing routes). The
// server reaches this machine's files through it, and its mods reach the
// server through the relay.
func ServeRemote(ctx context.Context, o RemoteOptions) error {
	ln, err := net.Listen("tcp", o.Addr)
	if err != nil {
		return err
	}
	h := New()
	h.Verifier = &hostauth.Verifier{DataDir: o.DataDir}
	h.DataDir = o.DataDir
	h.TailscaleLogin = o.TailscaleLogin
	h.FS = hostfs.NewLocal(o.DataDir)
	h.PluginDir, h.ServerFile, h.Version = o.PluginDir, o.ServerFile, o.Version
	srv := &http.Server{Handler: h.Handler()}
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	h.shutdown = cancel
	go func() {
		if err := h.ServeRelay(ctx, o.ServerFile); err != nil {
			log.Printf("relay: %v", err)
		}
	}()
	go func() {
		<-ctx.Done()
		h.KillAll()
		h.relay.close()
		shutdownCtx, c := context.WithTimeout(context.Background(), time.Second)
		defer c()
		if srv.Shutdown(shutdownCtx) != nil {
			_ = srv.Close() // the event streams: they never go idle
		}
	}()
	if o.Listening != nil {
		o.Listening(ln.Addr().String())
	}
	err = srv.Serve(ln)
	if errors.Is(err, http.ErrServerClosed) {
		return nil
	}
	return err
}
