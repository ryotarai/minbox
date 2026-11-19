package store

import (
	"context"
	"time"
)

// SessionRows lists the sessions as stored, without the counts derived from their threads (one
// query: the stuck-agent watch reads it every few seconds).
func (s *Store) SessionRows(ctx context.Context) ([]Session, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT `+sessionCols+` FROM sessions`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Session{}
	for rows.Next() {
		sess, err := scanSession(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *sess)
	}
	return out, rows.Err()
}

// OldestUndelivered answers, per session, when the oldest of the messages to its agent that the
// agent has not taken yet (author user, not delivered; claimed or not) was written. Sessions with
// none are left out.
func (s *Store) OldestUndelivered(ctx context.Context) (map[string]time.Time, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT t.session_id, MIN(m.created_at) FROM messages m JOIN threads t ON t.id=m.thread_id
	  WHERE m.author='user' AND m.delivered_at IS NULL GROUP BY t.session_id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]time.Time{}
	for rows.Next() {
		var id string
		var at int64
		if err := rows.Scan(&id, &at); err != nil {
			return nil, err
		}
		out[id] = fromMs(at)
	}
	return out, rows.Err()
}
