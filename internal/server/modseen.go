package server

import (
	"os"
	"strconv"
	"time"

	"github.com/ryotarai/minbox/internal/store"
)

// modSilentDefault: a Claude Code session whose mod has made no call for this long is "silent".
// The mod long-polls (20 s) and looks every second while busy, so a live mod is never this quiet.
const modSilentDefault = 45 * time.Second

// modSilentAfterFromEnv lets tests shorten the threshold (MINBOX_MOD_SILENT_S).
func modSilentAfterFromEnv() time.Duration {
	if n, err := strconv.ParseFloat(os.Getenv("MINBOX_MOD_SILENT_S"), 64); err == nil && n > 0 {
		return time.Duration(n * float64(time.Second))
	}
	return modSilentDefault
}

// touchMod records a call from the session's mod. The sessions event is published only when the
// mod comes back from being silent, and (by a timer) when it goes silent: not on every call.
func (s *Server) touchMod(sessionID string) {
	now := time.Now()
	s.modMu.Lock()
	prev, seen := s.modSeen[sessionID]
	s.modSeen[sessionID] = now
	wasSilent := (!seen && now.Sub(s.startedAt) > s.modSilentAfter) || (seen && now.Sub(prev) > s.modSilentAfter)
	if t := s.modTimers[sessionID]; t != nil {
		t.Reset(s.modSilentAfter + time.Second)
	} else {
		s.modTimers[sessionID] = time.AfterFunc(s.modSilentAfter+time.Second, func() { s.hub.publish(Event{Type: "sessions"}) })
	}
	s.modMu.Unlock()
	if wasSilent {
		s.hub.publish(Event{Type: "sessions"})
	}
}

// watchStartup publishes once the threshold passes after boot, for sessions no mod has called yet.
func (s *Server) watchStartup() {
	time.AfterFunc(s.modSilentAfter+time.Second, func() { s.hub.publish(Event{Type: "sessions"}) })
}

// withModSeen fills mod_seen_at and mod_silent.
func (s *Server) withModSeen(sess *store.Session) {
	now := time.Now()
	s.modMu.Lock()
	t, seen := s.modSeen[sess.ID]
	s.modMu.Unlock()
	if seen {
		sess.ModSeenAt = &t
	} else {
		t = s.startedAt
	}
	sess.ModSilent = sess.Kind == store.KindClaude && sess.Status != store.StatusEnded && sess.Status != store.StatusStarting && now.Sub(t) > s.modSilentAfter
}

// Close ends the long polls cleanly (the http server's shutdown calls it), so the mods reconnect at once.
func (s *Server) Close() {
	s.closeOnce.Do(func() { close(s.closing) })
}
