package server

import (
	"context"
	"time"

	"github.com/ryotarai/minbox/internal/store"
)

// v3StreamTaskEvents: the task changes (created, status, renamed) the agent's stream shows between
// msgs[start:end] of its whole stream msgs. A page owns the events after the message before it and up
// to its last message; the newest page also the ones after its last message. So "show earlier" pages
// meet without a gap or an overlap. A context window (after=) shows none.
func (s *Server) v3StreamTaskEvents(ctx context.Context, sid string, msgs []V3Message, start, end int, window bool) []store.StreamTaskEvent {
	none := []store.StreamTaskEvent{}
	if window || (end < len(msgs) && start >= end) {
		return none
	}
	var lo, hi *time.Time
	if start > 0 {
		lo = &msgs[start-1].CreatedAt
	}
	if end < len(msgs) {
		hi = &msgs[end-1].CreatedAt
	}
	evs, err := s.store.SessionTaskEvents(ctx, sid, lo, hi)
	if err != nil {
		return none
	}
	return evs
}
