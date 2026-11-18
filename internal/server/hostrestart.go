package server

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"strings"
	"time"

	"github.com/ryotarai/minbox/internal/store"
	"github.com/ryotarai/minbox/internal/termhost"
)

// Restarting the local terminal host from Settings › Hosts: what
// `minbox restart --host` does, with the server kept running. The host is
// stopped the same way (termhost.Stop: a shutdown request, then a signal),
// and the server's own connection loop (sessionManager.Run, with the connect
// function `minbox start` gives it: termhost.Ensure) starts a new host from the
// current binary, connects and reconciles: the sessions that were running are
// resumed (claude --resume), or, when the person chose not to, marked ended.

// errHostRestartBusy answers a second restart while one is under way (HTTP 409).
var errHostRestartBusy = errors.New("the terminal host is already being restarted")

// hostRestartTimeout is how long a restart waits for the new host to connect and reconcile.
var hostRestartTimeout = 30 * time.Second

// hostRestartSession is a session the restart stopped.
type hostRestartSession struct {
	ID    string `json:"id"`
	Name  string `json:"name"`
	Kind  string `json:"kind"`
	Agent string `json:"agent,omitempty"`
}

// hostRestartResult is what POST /api/hosts/local/restart answers.
type hostRestartResult struct {
	OldPID    int                  `json:"old_pid"`
	NewPID    int                  `json:"new_pid"`
	StartedAt *time.Time           `json:"started_at,omitempty"`
	Sessions  []hostRestartSession `json:"sessions"`
	Resumed   bool                 `json:"resumed"`
}

// localSocket is the local terminal host's socket (from Config.HostURL).
func (s *Server) localSocket() string {
	u := s.cfg.HostURL
	if u == "" {
		return ""
	}
	return strings.TrimPrefix(u, "unix://")
}

// stopLocalHostDefault stops the local host as `minbox host stop` and
// `minbox restart --host` do.
func (s *Server) stopLocalHostDefault(ctx context.Context) (int, bool, error) {
	sock := s.localSocket()
	if sock == "" {
		return 0, false, errors.New("the local terminal host's socket is not known")
	}
	return termhost.Stop(ctx, sock, ProtocolVersion, log.Printf)
}

// restartLocalHost stops the local terminal host and waits for the server to
// start and reconcile a new one. resume: the sessions that were running resume
// in the new host; otherwise they are marked ended.
func (s *Server) restartLocalHost(ctx context.Context, resume bool) (hostRestartResult, error) {
	if !s.hostRestartMu.TryLock() {
		return hostRestartResult{}, errHostRestartBusy
	}
	defer s.hostRestartMu.Unlock()
	s.hostRestarting.Store(true)
	defer func() {
		s.hostRestarting.Store(false)
		s.hub.publish(Event{Type: "hosts"})
	}()
	s.hub.publish(Event{Type: "hosts"})

	m := s.sessions
	res := hostRestartResult{Sessions: []hostRestartSession{}, Resumed: resume}
	lc := m.hosts.local()
	lc.mu.Lock()
	res.OldPID = lc.pid
	lc.mu.Unlock()
	all, err := m.store.ListSessions(ctx)
	if err != nil {
		return res, err
	}
	for _, sess := range all {
		if sess.Status == store.StatusEnded || m.remote(sess.HostID) {
			continue
		}
		res.Sessions = append(res.Sessions, hostRestartSession{ID: sess.ID, Name: sess.Name, Kind: sess.Kind, Agent: sess.Agent})
	}

	// From here the connection loop does not connect, and the exits of the
	// host's terminals are not session ends.
	hold := make(chan struct{})
	m.mu.Lock()
	m.localQuiet = m.localConn
	m.localHold = hold
	if m.localReady == nil {
		m.localReady = make(chan struct{})
	}
	ready := m.localReady
	m.mu.Unlock()
	released := false
	release := func() {
		if released {
			return
		}
		released = true
		m.mu.Lock()
		m.localHold = nil
		m.mu.Unlock()
		close(hold)
	}
	defer release()

	log.Printf("restarting the terminal host (pid %d) from Settings; %d agents and shells", res.OldPID, len(res.Sessions))
	pid, running, err := s.stopLocalHost(ctx)
	if err != nil {
		return res, fmt.Errorf("stop the terminal host: %w", err)
	}
	if running && pid != 0 {
		res.OldPID = pid
	}
	m.dropLocal()
	lc.setOffline(nil)
	lc.mu.Lock()
	lc.status = "connecting"
	lc.mu.Unlock()
	s.hub.publish(Event{Type: "hosts"})
	if !resume {
		for _, sess := range res.Sessions {
			if m.modForget != nil {
				m.modForget(sess.ID, "terminal host restarted")
			}
			if err := m.store.SetSessionEnded(ctx, sess.ID, -1); err != nil && !errors.Is(err, store.ErrNotFound) {
				log.Printf("mark %s ended: %v", sess.ID, err)
			}
		}
		m.hub.publish(Event{Type: "sessions"})
	}
	release()

	wctx, cancel := context.WithTimeout(ctx, hostRestartTimeout)
	defer cancel()
	select {
	case <-ready:
	case <-wctx.Done():
		lc.mu.Lock()
		why := lc.err
		lc.mu.Unlock()
		if why == "" {
			why = wctx.Err().Error()
		}
		return res, fmt.Errorf("the new terminal host did not come up: %s", why)
	}
	lc.mu.Lock()
	res.NewPID, res.StartedAt = lc.pid, lc.startedAt
	lc.mu.Unlock()
	log.Printf("terminal host restarted: pid %d → %d", res.OldPID, res.NewPID)
	return res, nil
}

// restartHost is POST /api/hosts/{id}/restart: only the local host can be restarted.
func (s *Server) restartHost(w http.ResponseWriter, r *http.Request) {
	c := s.sessions.hosts.get(r.PathValue("id"))
	if c == nil {
		httpError(w, 404, "not found")
		return
	}
	if !c.builtin {
		httpError(w, 400, "only this machine's terminal host can be restarted from here; run `minbox host` again on that machine")
		return
	}
	var req struct {
		Resume *bool `json:"resume"`
	}
	if r.ContentLength != 0 {
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			httpError(w, 400, "bad request")
			return
		}
	}
	resume := req.Resume == nil || *req.Resume
	// Not the request's context: a browser that goes away must not leave the
	// host half restarted.
	res, err := s.restartLocalHost(context.WithoutCancel(r.Context()), resume)
	if errors.Is(err, errHostRestartBusy) {
		httpError(w, 409, err.Error())
		return
	}
	if err != nil {
		httpError(w, 500, err.Error())
		return
	}
	writeJSON(w, 200, res)
}

// hostVersionStatus says whether a host runs the server's build: the local host
// by the hash of its binary, a remote one by its version string.
func hostVersionStatus(builtin bool, version, binary, serverBinary string) string {
	if builtin {
		if binary == "" || serverBinary == "" {
			return "unknown"
		}
		if binary == serverBinary {
			return "current"
		}
		return "outdated"
	}
	if version == "" || Version == "" || (version == "dev" && Version == "dev") {
		return "unknown"
	}
	if version == Version {
		return "current"
	}
	return "outdated"
}
