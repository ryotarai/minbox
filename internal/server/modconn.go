package server

import (
	"context"
	"fmt"
	"log"
	"net/http"
	"strings"
	"time"

	"github.com/ryotarai/minbox/internal/store"
)

// The mod connection: what the server knows about the integration (the Claude Code mod, or the
// Pi extension) running inside a session. The mod sends a heartbeat every few seconds
// (POST /api/agent/heartbeat); this file records it, notices when it stops (stale) and when it
// comes back, and keeps a small per-session log that GET /api/sessions/{id}/connection shows.
// See docs/mod-connection.md.
//
// Every log line starts with "modconn:" and carries ids, lengths and timings only: never a message
// body, a token or an owner key.

const (
	// modStaleDefault: no heartbeat for this long and the connection is stale. The mod beats every 15 s.
	modStaleDefault = 45 * time.Second
	// modUndeliveredDefault: a queued message this old, while the mod claims to be idle, is logged once.
	modUndeliveredDefault = 30 * time.Second
	// maxModEvents bounds both event rings (the mod's tail and the server's own).
	maxModEvents = 50
)

// ModEvent is one line of a connection log: the mod's own events or the server's.
type ModEvent struct {
	At   time.Time `json:"at"`
	Kind string    `json:"kind"`
	Msg  string    `json:"msg"`
}

// modConn is the server's record of one session's mod.
type modConn struct {
	hb          bool // the mod has sent at least one heartbeat (an old mod only makes calls)
	firstSeen   time.Time
	lastBeat    time.Time
	lastContact time.Time // any call from the mod, a heartbeat included
	beats       int
	seq         int64
	agent       string
	version     string
	modState    string // idle | working, as the mod sees it
	lastPoll    string // the mod's own timestamps, passed through
	lastDeliver string
	modInfo     map[string]any // the rest of the mod's self-report (ticks, poll state, ...)
	// liveInstr: the mod gives the agent the instructions as a system prompt section and sends
	// changed ones to the running conversation (the Claude Code mod, heartbeat live_instructions);
	// instrVersion: the version it last answered with. A restart is then not needed for new
	// instructions (stale.go).
	liveInstr    bool
	instrVersion string
	// protocol: the mod protocol the integration reported (hello, heartbeat); protoKnown: it reported.
	protocol   int
	protoKnown bool
	stale      bool
	staleSince time.Time
	reconnects int
	lastGap    time.Duration
	modEvents  []ModEvent // the tail the mod sent last
	events     []ModEvent // the server's log for this session
	timer      *time.Timer
	// Rate limits for log lines.
	pendingKey string
	pendingAt  time.Time
	warned     map[string]bool // messages already logged as undelivered
}

// ref is the time the connection's health is judged by.
func (c *modConn) ref() time.Time {
	if c.hb {
		return c.lastBeat
	}
	return c.lastContact
}

func (c *modConn) sourceName() string {
	if c.hb {
		return "heartbeat"
	}
	return "call"
}

func (s *Server) nowFn() time.Time {
	if s.clock != nil {
		return s.clock()
	}
	return time.Now()
}

func truncate(v string, n int) string {
	r := []rune(v)
	if len(r) <= n {
		return v
	}
	return string(r[:n]) + "…"
}

// connLocked returns the session's record, creating it. modMu must be held.
func (s *Server) connLocked(id string, now time.Time) *modConn {
	c := s.modConns[id]
	if c == nil {
		c = &modConn{firstSeen: now, warned: map[string]bool{}}
		s.modConns[id] = c
	}
	return c
}

// modLogLocked writes a "modconn:" line to the server log and the session's ring. modMu must be held.
func (s *Server) modLogLocked(id string, now time.Time, kind, format string, args ...any) {
	msg := fmt.Sprintf(format, args...)
	log.Printf("modconn: %s session=%s %s", kind, id, msg)
	c := s.connLocked(id, now)
	c.events = append(c.events, ModEvent{At: now, Kind: kind, Msg: msg})
	if len(c.events) > maxModEvents {
		c.events = c.events[len(c.events)-maxModEvents:]
	}
}

// modLog is modLogLocked for callers that do not hold modMu (the session manager, handlers).
func (s *Server) modLog(id, kind, format string, args ...any) {
	s.modMu.Lock()
	defer s.modMu.Unlock()
	s.modLogLocked(id, s.nowFn(), kind, format, args...)
}

// checkStaleLocked flags the transition connected -> stale. It returns true when it flipped.
func (s *Server) checkStaleLocked(id string, c *modConn, now time.Time) bool {
	ref := c.ref()
	if c.stale || ref.IsZero() || now.Sub(ref) <= s.modStaleAfter {
		return false
	}
	c.stale = true
	c.staleSince = now
	s.modLogLocked(id, now, "stale", "no %s for %s (threshold %s) mod_state=%s last_seq=%d", c.sourceName(), now.Sub(ref).Round(time.Second), s.modStaleAfter, c.modState, c.seq)
	return true
}

// modCheck re-evaluates one session now (a timer calls it) and publishes when the state flipped.
func (s *Server) modCheck(id string) {
	s.modMu.Lock()
	c := s.modConns[id]
	flipped := false
	if c != nil {
		flipped = s.checkStaleLocked(id, c, s.nowFn())
	}
	s.modMu.Unlock()
	if flipped {
		s.modQueueCheck(id)
		s.hub.publish(Event{Type: "sessions"})
	}
}

// modCheckAll is modCheck for every session.
func (s *Server) modCheckAll() {
	s.modMu.Lock()
	ids := make([]string, 0, len(s.modConns))
	for id := range s.modConns {
		ids = append(ids, id)
	}
	s.modMu.Unlock()
	for _, id := range ids {
		s.modCheck(id)
	}
}

// modObserveLocked records contact from the session's mod (beat: it is a heartbeat). It logs the
// transition stale -> reconnected with the length of the gap, and returns true when it did.
func (s *Server) modObserveLocked(id string, beat bool, now time.Time) (recovered bool) {
	c := s.connLocked(id, now)
	s.checkStaleLocked(id, c, now)
	prevRef := c.ref()
	if beat {
		c.hb = true
		c.lastBeat = now
	}
	c.lastContact = now
	if c.stale && (beat || !c.hb) {
		gap := now.Sub(prevRef)
		c.stale = false
		c.reconnects++
		c.lastGap = gap
		s.modLogLocked(id, now, "reconnected", "after %s without %s (stale for %s) reconnects=%d", gap.Round(time.Second), c.sourceName(), now.Sub(c.staleSince).Round(time.Second), c.reconnects)
		return true
	}
	return false
}

// armBeatTimerLocked schedules the stale check one threshold after the last heartbeat.
func (s *Server) armBeatTimerLocked(id string, c *modConn) {
	d := s.modStaleAfter + time.Second
	if c.timer != nil {
		c.timer.Reset(d)
		return
	}
	c.timer = time.AfterFunc(d, func() { s.modCheck(id) })
}

// modForget ends the record of a session whose process is gone.
func (s *Server) modForget(id, why string) {
	s.modMu.Lock()
	defer s.modMu.Unlock()
	if c := s.modConns[id]; c != nil {
		if c.timer != nil {
			c.timer.Stop()
			c.timer = nil
		}
		s.modLogLocked(id, s.nowFn(), "exit", "%s (heartbeats=%d reconnects=%d)", why, c.beats, c.reconnects)
		c.stale = false
		c.hb = false
		c.lastBeat, c.lastContact = time.Time{}, time.Time{}
	}
}

// modProtocolSeen records the mod protocol an integration reported in its hello.
func (s *Server) modProtocolSeen(id string, protocol int) {
	now := s.nowFn()
	s.modMu.Lock()
	c := s.connLocked(id, now)
	changed := !c.protoKnown || c.protocol != protocol
	c.protocol, c.protoKnown = protocol, true
	if changed && protocol < ModProtocol {
		s.modLogLocked(id, now, "old-protocol", "the integration speaks mod protocol %d, the server %d: it keeps working; a restart of the agent loads the current one", protocol, ModProtocol)
	}
	s.modMu.Unlock()
}

// ---- heartbeat ----

type heartbeatReq struct {
	Seq        int64  `json:"seq"`
	Agent      string `json:"agent"`
	ExtVersion string `json:"ext_version"`
	State      string `json:"state"` // idle | working
	// The mod's own clock readings (RFC 3339), passed through to the diagnostics.
	LastPollAt     string         `json:"last_poll_at"`
	LastDeliveryAt string         `json:"last_delivery_at"`
	Info           map[string]any `json:"info"`
	// Protocol: the integration's mod protocol (0, absent, before protocol 1).
	Protocol int `json:"protocol"`
	// LiveInstructions: the mod keeps the instructions in the system prompt up to date itself
	// (GET /api/agent/instructions); InstructionsVersion: the version it last answered with.
	LiveInstructions    bool   `json:"live_instructions"`
	InstructionsVersion string `json:"instructions_version"`
	Events              []struct {
		At   string `json:"at"`
		Kind string `json:"kind"`
		Msg  string `json:"msg"`
	} `json:"events"`
}

// liveInstructions reports whether the session's mod said in its last heartbeat that it keeps the
// instructions in the agent's system prompt up to date (the Claude Code mod, started without them
// on the command line).
func (s *Server) liveInstructions(id string) bool {
	s.modMu.Lock()
	defer s.modMu.Unlock()
	c := s.modConns[id]
	return c != nil && c.liveInstr
}

func (s *Server) agentHeartbeat(w http.ResponseWriter, r *http.Request, sess *store.Session) {
	var req heartbeatReq
	if !decode(w, r, &req) {
		return
	}
	now := s.nowFn()
	s.modMu.Lock()
	c := s.connLocked(sess.ID, now)
	recovered := s.modObserveLocked(sess.ID, true, now)
	first := c.beats == 0
	if req.Seq > 0 && c.seq > 0 && req.Seq <= c.seq {
		// The sequence went back: the mod was reloaded, or a second instance reports.
		s.modLogLocked(sess.ID, now, "seq-reset", "heartbeat seq %d after %d: the mod restarted or a second instance reports", req.Seq, c.seq)
	}
	c.beats++
	c.seq = req.Seq
	c.protocol, c.protoKnown = req.Protocol, true
	c.agent, c.version = truncate(req.Agent, 20), truncate(req.ExtVersion, 40)
	if req.State == store.StatusWorking || req.State == store.StatusIdle {
		c.modState = req.State
	}
	c.lastPoll, c.lastDeliver = truncate(req.LastPollAt, 40), truncate(req.LastDeliveryAt, 40)
	liveChanged := c.liveInstr != req.LiveInstructions
	c.liveInstr, c.instrVersion = req.LiveInstructions, truncate(req.InstructionsVersion, 40)
	c.modInfo = nil
	if len(req.Info) > 0 && len(req.Info) <= 30 {
		c.modInfo = map[string]any{}
		for k, v := range req.Info {
			switch t := v.(type) {
			case string:
				c.modInfo[truncate(k, 40)] = truncate(t, 100)
			case float64, bool:
				c.modInfo[truncate(k, 40)] = t
			}
		}
	}
	c.modEvents = nil
	evs := req.Events
	if len(evs) > maxModEvents {
		evs = evs[len(evs)-maxModEvents:]
	}
	for _, e := range evs {
		at, _ := time.Parse(time.RFC3339Nano, e.At)
		c.modEvents = append(c.modEvents, ModEvent{At: at, Kind: truncate(e.Kind, 30), Msg: truncate(e.Msg, 300)})
	}
	if first {
		s.modLogLocked(sess.ID, now, "heartbeat-first", "agent=%q version=%q state=%s seq=%d", c.agent, c.version, c.modState, c.seq)
	}
	s.armBeatTimerLocked(sess.ID, c)
	s.modMu.Unlock()
	if recovered || first || liveChanged {
		s.hub.publish(Event{Type: "sessions"}) // liveChanged: the stale "prompt" reason may change
	}
	s.modQueueCheck(sess.ID)
	if req.State == store.StatusIdle {
		s.goalResumeKick(sess.ID) // after a restart: a running goal may go on (resumeIdle)
	}
	writeJSON(w, 200, map[string]any{"ok": true, "server_time": now.UTC().Format(time.RFC3339Nano),
		"protocol": ModProtocol, "tools_version": manifestFor(sessKind(sess)).Version,
		"instructions_version": promptID(s.sessions.instructions(r.Context(), sess))})
}

// modQueueCheck logs, once per message, a queued message that has waited long while the mod
// says it is idle or has gone stale: what the person experiences as "the agent ignores me".
func (s *Server) modQueueCheck(id string) {
	pending, err := s.store.PendingForSession(context.Background(), id, "")
	if err != nil || len(pending) == 0 {
		return
	}
	now := s.nowFn()
	s.modMu.Lock()
	defer s.modMu.Unlock()
	c := s.connLocked(id, now)
	for _, p := range pending {
		wait := now.Sub(p.CreatedAt)
		if wait < s.modUndeliveredAfter || c.warned[p.ID] {
			continue
		}
		state := "connected"
		if c.stale {
			state = "stale"
		}
		if c.ref().IsZero() {
			state = "never-seen"
		}
		if c.modState == store.StatusWorking && state == "connected" {
			continue // busy: waiting is expected
		}
		c.warned[p.ID] = true
		beatAge := "never"
		if !c.lastBeat.IsZero() {
			beatAge = now.Sub(c.lastBeat).Round(time.Second).String()
		}
		s.modLogLocked(id, now, "undelivered", "msg=%s thread=%s waited=%s conn=%s mod_state=%q last_heartbeat_age=%s last_poll=%q urgent=%v", p.ID, p.ThreadID, wait.Round(time.Second), state, c.modState, beatAge, c.lastPoll, p.Urgent)
	}
}

// ---- delivery logging ----

// modPendingServed logs a poll that returned messages (rate limited: the mod may look every second).
func (s *Server) modPendingServed(id string, pending []store.PendingDelivery) {
	if len(pending) == 0 {
		return
	}
	now := s.nowFn()
	ids := make([]string, len(pending))
	for i, p := range pending {
		ids[i] = p.ID
	}
	key := strings.Join(ids, ",")
	s.modMu.Lock()
	defer s.modMu.Unlock()
	c := s.connLocked(id, now)
	if c.pendingKey == key && now.Sub(c.pendingAt) < 30*time.Second {
		return
	}
	c.pendingKey, c.pendingAt = key, now
	s.modLogLocked(id, now, "pending", "poll returned %d message(s) oldest_wait=%s ids=%s", len(pending), now.Sub(pending[0].CreatedAt).Round(time.Second), truncate(key, 120))
}

// modDelivery logs a claim or a delivered mark of one message, with how long it waited.
func (s *Server) modDelivery(id, what, messageID string) {
	m, err := s.store.GetMessage(context.Background(), messageID)
	if err != nil {
		return
	}
	now := s.nowFn()
	s.modMu.Lock()
	defer s.modMu.Unlock()
	c := s.connLocked(id, now)
	s.modLogLocked(id, now, what, "msg=%s thread=%s waited=%s via=%s/pending-poll mod_state=%q", m.ID, m.ThreadID, now.Sub(m.CreatedAt).Round(time.Millisecond), firstNonEmpty(c.agent, "mod"), c.modState)
}

// ---- state and API ----

// connStateLocked is the connection state shown to the person:
//
//	connected   a heartbeat (for an old mod: a call) within the threshold
//	stale       none for longer, or none at all long after the server started
//	connecting  nothing yet, and the server or the session just started
//	none        a session without a mod (a shell), or one that ended
func (s *Server) connStateLocked(sess *store.Session, now time.Time) (state string, ref time.Time) {
	if sess.Kind != store.KindClaude || sess.Status == store.StatusEnded {
		return "none", time.Time{}
	}
	c := s.modConns[sess.ID]
	if c == nil || c.ref().IsZero() {
		if now.Sub(s.startedAt) <= s.modStaleAfter || sess.Status == store.StatusStarting {
			return "connecting", time.Time{}
		}
		return "stale", time.Time{}
	}
	ref = c.ref()
	if now.Sub(ref) > s.modStaleAfter {
		return "stale", ref
	}
	return "connected", ref
}

// withModConn fills the connection fields of a session (the session list shows them).
func (s *Server) withModConn(sess *store.Session) {
	now := s.nowFn()
	s.modMu.Lock()
	defer s.modMu.Unlock()
	sess.ModConn, _ = s.connStateLocked(sess, now)
	if c := s.modConns[sess.ID]; c != nil && !c.lastBeat.IsZero() {
		t := c.lastBeat
		sess.ModBeatAt = &t
	}
	// An integration of an older protocol keeps working, but a restart loads the current one.
	if c := s.modConns[sess.ID]; c != nil && c.protoKnown && sess.ModConn != "none" {
		sess.ModOutdated = c.protocol < ModProtocol
	}
}

// getConnection answers GET /api/sessions/{id}/connection: the diagnostics of the mod connection.
func (s *Server) getConnection(w http.ResponseWriter, r *http.Request) {
	sess, err := s.store.GetSession(r.Context(), r.PathValue("id"))
	if err != nil {
		storeError(w, err)
		return
	}
	pending, _ := s.store.PendingForSession(r.Context(), sess.ID, "")
	now := s.nowFn()
	s.modMu.Lock()
	state, ref := s.connStateLocked(sess, now)
	out := map[string]any{
		"session_id":        sess.ID,
		"state":             state,
		"stale_after_s":     s.modStaleAfter.Seconds(),
		"server_time":       now.UTC(),
		"server_started_at": s.startedAt.UTC(),
		"session_status":    sess.Status,
		"heartbeat":         false,
		"last_contact_at":   nil,
		"last_beat_at":      nil,
		"age_s":             nil,
		"mod_events":        []ModEvent{},
		"events":            []ModEvent{},
	}
	if !ref.IsZero() {
		out["age_s"] = now.Sub(ref).Seconds()
	}
	if c := s.modConns[sess.ID]; c != nil {
		out["heartbeat"] = c.hb
		if !c.lastContact.IsZero() {
			out["last_contact_at"] = c.lastContact.UTC()
		}
		if !c.lastBeat.IsZero() {
			out["last_beat_at"] = c.lastBeat.UTC()
		}
		out["first_seen_at"] = c.firstSeen.UTC()
		out["beats"] = c.beats
		out["seq"] = c.seq
		out["agent"] = c.agent
		out["mod_version"] = c.version
		out["mod_protocol"] = c.protocol
		out["server_protocol"] = ModProtocol
		out["mod_state"] = c.modState
		out["last_poll_at"] = c.lastPoll
		out["last_delivery_at"] = c.lastDeliver
		out["mod_info"] = c.modInfo
		out["reconnects"] = c.reconnects
		out["last_gap_s"] = c.lastGap.Seconds()
		if c.stale {
			out["stale_since"] = c.staleSince.UTC()
		}
		out["mod_events"] = append([]ModEvent{}, c.modEvents...)
		out["events"] = append([]ModEvent{}, c.events...)
	}
	s.modMu.Unlock()
	queue := map[string]any{"count": len(pending), "oldest_wait_s": nil}
	if len(pending) > 0 {
		queue["oldest_wait_s"] = now.Sub(pending[0].CreatedAt).Seconds()
	}
	out["queue"] = queue
	writeJSON(w, 200, out)
}
