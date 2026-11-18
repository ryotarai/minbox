package server

import (
	"context"
	"errors"
	"fmt"
	"log"
	"strings"
	"time"

	"github.com/ryotarai/minbox/internal/agent"
	"github.com/ryotarai/minbox/internal/termhost"
)

// Coding agents on remote hosts. A Pi or OpenCode session on another machine runs there like a
// Claude Code one: the host starts it in a PTY with its own copy of minbox's extension/plugin (the
// placeholders of termhost), and the extension reaches this server through the host's relay
// (MINBOX_SERVER_FILE is the host's). What the server must know or do on that machine goes through
// the host too: which agents are installed there (POST /lookpath, version probes through POST
// /exec), Pi's session files (GET /fs/piconversation) and the opencode CLI calls (POST /exec).
// Helper runs (reply suggestions, project pick, drafts) stay on the server's machine.

// HostExec is what a host connection offers for running short commands there (termhost.Client,
// protocol termhost.AgentsProtocol or later).
type HostExec interface {
	Exec(ctx context.Context, req termhost.ExecRequest) (termhost.ExecResult, error)
	LookPath(ctx context.Context, names []string) (map[string]string, error)
}

// hostAgentsTTL is how long a remote host's agent list is used before it is probed again.
var hostAgentsTTL = time.Minute

// execOn is the exec access to a remote host, or why there is none.
func (m *sessionManager) execOn(hostID string) (HostExec, error) {
	c := m.hosts.get(hostID)
	if c == nil {
		return nil, fmt.Errorf("host %s is gone", hostID)
	}
	c.mu.Lock()
	client, protocol, name := c.client, c.protocol, c.name
	c.mu.Unlock()
	if client == nil {
		return nil, fmt.Errorf("host %s is not connected", name)
	}
	if protocol < termhost.AgentsProtocol {
		return nil, fmt.Errorf("the minbox on host %s is too old for Pi and OpenCode agents (host protocol %d, needs %d): update minbox on that machine and restart `minbox host` there", name, protocol, termhost.AgentsProtocol)
	}
	x, ok := client.(HostExec)
	if !ok {
		return nil, fmt.Errorf("host %s cannot run commands for the server", name)
	}
	return x, nil
}

// runnerOn runs commands on a host's machine: this machine's runner for the built-in host, the
// host's POST /exec for another one.
func (m *sessionManager) runnerOn(hostID string) (agent.Runner, error) {
	if !m.remote(hostID) {
		if m.cfg.OpenCodeRunner != nil {
			return m.cfg.OpenCodeRunner, nil
		}
		return agent.LocalRunner, nil
	}
	x, err := m.execOn(hostID)
	if err != nil {
		return nil, err
	}
	return execRunner(x), nil
}

// execRunner is an agent.Runner over a host's exec.
func execRunner(x HostExec) agent.Runner {
	return func(ctx context.Context, argv []string, dir string, env []string, stdin string) ([]byte, error) {
		req := termhost.ExecRequest{Argv: argv, Dir: dir, Env: env, Stdin: stdin}
		if dl, ok := ctx.Deadline(); ok {
			req.TimeoutMs = int(time.Until(dl).Milliseconds())
			if req.TimeoutMs <= 0 {
				return nil, context.DeadlineExceeded
			}
		}
		res, err := x.Exec(ctx, req)
		if err != nil {
			return nil, err
		}
		switch {
		case res.NotFound:
			return nil, fmt.Errorf("%s is not on the host's PATH", argv[0])
		case res.Error != "":
			return res.Stdout, errors.New(res.Error)
		case res.TimedOut:
			return res.Stdout, fmt.Errorf("%s timed out on the host", argv[0])
		case res.ExitCode != 0:
			return res.Stdout, &agent.ExitError{Code: res.ExitCode, Stdout: res.Stdout, Stderr: res.Stderr}
		}
		return res.Stdout, nil
	}
}

// hostAgents describes the coding agents of a host's machine: this machine's for the built-in host;
// for another, what its host finds there (cached for hostAgentsTTL; fresh probes again). A host too
// old to run Pi and OpenCode lists them as unavailable, with the reason.
func (m *sessionManager) hostAgents(ctx context.Context, hostID string, fresh bool) ([]agent.Info, error) {
	if !m.remote(hostID) {
		return m.commands().Infos(), nil
	}
	c := m.hosts.get(hostID)
	if c == nil {
		return nil, fmt.Errorf("no such host: %s", hostID)
	}
	c.mu.Lock()
	cached, at, online, protocol := c.agents, c.agentsAt, c.client != nil, c.protocol
	c.mu.Unlock()
	if !online {
		if cached != nil {
			return cached, nil
		}
		return nil, fmt.Errorf("host %s is not connected", c.displayName())
	}
	if cached != nil && !fresh && time.Since(at) < hostAgentsTTL {
		return cached, nil
	}
	var infos []agent.Info
	if protocol < termhost.AgentsProtocol {
		infos = oldHostAgents(protocol)
	} else {
		x, err := m.execOn(hostID)
		if err != nil {
			return nil, err
		}
		infos = agent.ProbeHost(ctx, m.commands(), x.LookPath, execRunner(x))
	}
	c.mu.Lock()
	c.agents, c.agentsAt = infos, time.Now()
	c.mu.Unlock()
	return infos, nil
}

// oldHostAgents: a host before AgentsProtocol runs Claude Code sessions as it always did (its PATH
// decides at the start) and no Pi or OpenCode.
func oldHostAgents(protocol int) []agent.Info {
	var out []agent.Info
	for _, k := range agent.Kinds {
		a := agent.Must(k)
		info := agent.Info{Kind: k, Label: a.Label(), Caps: a.Caps()}
		if k == agent.Claude {
			info.Installed, info.Supported = true, true
		} else {
			info.Reason = fmt.Sprintf("the minbox on this host is too old to run %s (host protocol %d, needs %d): update minbox there", a.Label(), protocol, termhost.AgentsProtocol)
		}
		out = append(out, info)
	}
	return out
}

// refreshHostAgents probes a host's agents again in the background (after it connects) and tells
// the UI.
func (s *Server) refreshHostAgents(ctx context.Context, hostID string) {
	go func() {
		pctx, cancel := context.WithTimeout(ctx, time.Minute)
		defer cancel()
		if _, err := s.sessions.hostAgents(pctx, hostID, true); err != nil {
			log.Printf("host %s: agents: %v", hostID, err)
			return
		}
		s.hub.publish(Event{Type: "hosts"})
	}()
}

// cachedHostAgents is what is known of a host's agents without asking it ("nil" before the first probe).
func (m *sessionManager) cachedHostAgents(hostID string) []agent.Info {
	if !m.remote(hostID) {
		return m.commands().Infos()
	}
	c := m.hosts.get(hostID)
	if c == nil {
		return nil
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.agents
}

// agentOnHost refuses an agent a remote host cannot run, with a message that names the host and
// why (not installed there, unsupported version, Node too old, minbox too old). Claude Code is not
// refused: as before, the host's PATH decides when it starts.
func (m *sessionManager) agentOnHost(ctx context.Context, kind, hostID string) error {
	if !m.remote(hostID) || kind == agent.Claude {
		return nil
	}
	a := agent.Must(kind)
	name := hostID
	if c := m.hosts.get(hostID); c != nil {
		name = c.displayName()
	}
	infos, err := m.hostAgents(ctx, hostID, false)
	if err != nil {
		return fmt.Errorf("cannot start %s on host %s: %v", a.Label(), name, err)
	}
	if agent.UsableIn(infos, kind) {
		return nil
	}
	// A stale "not installed" may be old news: ask again once.
	if infos, err = m.hostAgents(ctx, hostID, true); err == nil && agent.UsableIn(infos, kind) {
		return nil
	}
	for _, i := range infos {
		if i.Kind != kind {
			continue
		}
		cmd := i.Command
		if cmd == "" {
			cmd = kind
		}
		if !i.Installed && (i.Reason == "" || i.Reason == "not installed") {
			return fmt.Errorf("%s is not installed on host %s (looked for %q on its PATH)", a.Label(), name, strings.Fields(cmd)[0])
		}
		return fmt.Errorf("%s cannot be used on host %s: %s", a.Label(), name, i.Reason)
	}
	return fmt.Errorf("%s cannot be used on host %s", a.Label(), name)
}

// hostDefaultAgent is the agent a new session on a host gets when nobody says: the default_agent
// setting if that host can run it, else the first agent it can run.
func (m *sessionManager) hostDefaultAgent(ctx context.Context, hostID string) string {
	if !m.remote(hostID) {
		return m.defaultAgent(ctx)
	}
	stored, _ := m.store.Settings(ctx)
	infos, err := m.hostAgents(ctx, hostID, false)
	if err != nil {
		return m.defaultAgent(ctx)
	}
	return agent.ChooseIn(infos, settingString(stored, "default_agent"))
}
