package server

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"

	"github.com/ryotarai/minbox/internal/agent"
	"github.com/ryotarai/minbox/internal/store"
	"github.com/ryotarai/minbox/internal/termhost"
)

// A stale agent runs an older minbox than a restart would give it. Two things are loaded once, at
// the agent's start, and only a restart replaces them:
//
//   - the minbox plugin (the Claude Code mod, the Pi extension, the OpenCode plugin): extracted to a
//     content-hash folder (plugin.Extract), so its path names its content. On another machine the
//     host gives its own copy, which it reports in /version (termhost.VersionInfo.Plugins).
//   - the instructions text (instructions: --append-system-prompt, and what the mod re-injects from
//     hello), which follows minbox's prompt constants and the person's prompt settings.
//
// The person's environment variables for the agent (agentenv.go) are a third: they can be edited
// while the agent runs (PATCH /api/sessions/{id}/env), and spawn records a salted hash of the ones
// it started with (Session.RunEnv, envID); another set makes the agent stale for "env". An agent
// started before that record is not counted for it.
//
// The tool manifest is not among them: the integrations fetch it again whenever a heartbeat's
// answer names another tools_version, so new tools reach a running agent without a restart.
//
// spawn records both (store.Session.RunPlugin / RunPrompt); withStale compares them with what a
// start would load now. Everything is content-based: restarting the server with the same binary
// and settings changes nothing. A shell and an ended agent never count as stale, and a host that does
// not report its plugins never makes an agent stale for its plugin.
//
// A running agent with nothing recorded (both empty) was started by a minbox from before this
// record: what it loaded is not known, and it is older than any record, so it counts as stale for
// "unknown". This holds on any host: spawn always records the instructions hash (the plugin id only
// when known), so both empty means "started before the record", never "a host that does not report
// its plugins". A restart records them and clears it.

// Stale reasons, as the browser gets them.
const (
	staleReasonPlugin = "plugin"
	staleReasonPrompt = "prompt"
	// staleReasonEnv: the person changed the agent's environment variables since it started.
	staleReasonEnv = "env"
	// staleReasonUnknown: started by a minbox from before the record; what it loaded is not known.
	staleReasonUnknown = "unknown"
)

// unrecordedRunVersion is the RunVersion of an agent with nothing recorded: stable until a restart
// records the real one (the browser keys Dismiss by it).
const unrecordedRunVersion = "unrecorded"

// promptID is a short hash of an instructions text.
func promptID(text string) string {
	h := sha256.Sum256([]byte(text))
	return hex.EncodeToString(h[:])[:12]
}

// pluginID is the minbox plugin a start of sess would load now: this server's own folders for a
// session here, the host's report for a session on another machine ("" when not known).
func (m *sessionManager) pluginID(sess *store.Session) string {
	if sess.Kind == store.KindShell {
		return ""
	}
	kind := agent.Must(sess.Agent).Kind()
	if m.remote(sess.HostID) {
		return m.hosts.get(sess.HostID).pluginID(kind)
	}
	switch kind {
	case agent.Pi:
		return termhost.PluginID(m.cfg.PiExtension)
	case agent.OpenCode:
		return termhost.PluginID(m.cfg.OpenCodePlugin)
	}
	return termhost.PluginID(m.cfg.PluginDir)
}

// runVersion is what a start of sess loads now: its plugin id and instructions hash.
func (m *sessionManager) runVersion(ctx context.Context, sess *store.Session) (plugin, prompt string) {
	return m.pluginID(sess), promptID(m.instructions(ctx, sess))
}

// staleReasons compares what the agent's start loaded with what a start would load now.
func (m *sessionManager) staleReasons(stored map[string]json.RawMessage, sess *store.Session) []string {
	if sess.Kind != store.KindClaude || sess.Status == store.StatusEnded {
		return nil
	}
	if sess.RunPlugin == "" && sess.RunPrompt == "" {
		return []string{staleReasonUnknown}
	}
	var out []string
	if sess.RunPlugin != "" {
		if cur := m.pluginID(sess); cur != "" && cur != sess.RunPlugin {
			out = append(out, staleReasonPlugin)
		}
	}
	if sess.RunPrompt != "" && promptID(instructionsWith(stored, sess)) != sess.RunPrompt {
		out = append(out, staleReasonPrompt)
	}
	// Not recorded (a start before the record): not known, so not counted.
	if sess.RunEnv != "" && envID(sess) != sess.RunEnv {
		out = append(out, staleReasonEnv)
	}
	return out
}

// withStale fills Stale, StaleReasons and RunVersion of a session for the browser. stored: the
// settings (read once for a list).
func (s *Server) withStale(stored map[string]json.RawMessage, sess *store.Session) {
	sess.StaleReasons = s.sessions.staleReasons(stored, sess)
	sess.Stale = len(sess.StaleReasons) > 0
	if sess.RunPlugin != "" || sess.RunPrompt != "" {
		sess.RunVersion = sess.RunPlugin + "." + sess.RunPrompt
	} else if sess.Kind != store.KindShell {
		sess.RunVersion = unrecordedRunVersion
	}
}
