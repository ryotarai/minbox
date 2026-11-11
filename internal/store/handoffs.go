package store

import (
	"context"
	"database/sql"
	"strings"
	"time"
)

// Thread handoffs: text composed once when a thread is created from something outside minbox (a
// Linear issue from the My issues screen) and put in front of the thread's first message when that
// message is delivered, exactly like a fork's handoff (forks.go): never in the stored message,
// repeated if the delivery is retried, marked delivered with the message.

const handoffSchema = `
CREATE TABLE IF NOT EXISTS thread_handoffs (
  thread_id TEXT PRIMARY KEY REFERENCES threads(id) ON DELETE CASCADE,
  kind TEXT NOT NULL DEFAULT '',
  ref TEXT NOT NULL DEFAULT '',
  handoff TEXT NOT NULL DEFAULT '',
  message_id TEXT NOT NULL DEFAULT '',
  delivered_at INTEGER,
  created_at INTEGER NOT NULL
);
`

// ThreadHandoff is a stored handoff (the row to write).
type ThreadHandoff struct {
	ThreadID, Kind, Ref, Handoff, MessageID string
}

// InsertHandoff writes a handoff in CreateThreadWith's step.
func (s *Store) InsertHandoff(ctx context.Context, tx *sql.Tx, h ThreadHandoff) error {
	_, err := tx.ExecContext(ctx, `INSERT INTO thread_handoffs(thread_id, kind, ref, handoff, message_id, created_at) VALUES(?,?,?,?,?,?)`,
		h.ThreadID, h.Kind, h.Ref, h.Handoff, h.MessageID, ms(s.now()))
	return err
}

// ThreadHandoffFor returns the frozen handoff to put in front of the message, if it is the
// handoff's message and the agent has not got it yet.
func (s *Store) ThreadHandoffFor(ctx context.Context, messageID string) (string, bool) {
	var h string
	err := s.db.QueryRowContext(ctx, `SELECT handoff FROM thread_handoffs WHERE message_id=? AND delivered_at IS NULL AND handoff!=''`, messageID).Scan(&h)
	return h, err == nil
}

// HandoffDelivered reports whether the thread's handoff reached the agent (tests).
func (s *Store) HandoffDelivered(ctx context.Context, threadID string) bool {
	var d sql.NullInt64
	err := s.db.QueryRowContext(ctx, `SELECT delivered_at FROM thread_handoffs WHERE thread_id=?`, threadID).Scan(&d)
	return err == nil && d.Valid
}

func (s *Store) markHandoffDelivered(ctx context.Context, messageID string) error {
	_, err := s.db.ExecContext(ctx, `UPDATE thread_handoffs SET delivered_at=COALESCE(delivered_at, ?) WHERE message_id=?`, ms(s.now()), messageID)
	return err
}

// LinkedThread is a thread linked to a Linear issue.
type LinkedThread struct {
	ThreadID  string    `json:"thread_id"`
	SessionID string    `json:"session_id"`
	Subject   string    `json:"subject"`
	Status    string    `json:"status"`
	ProjectID string    `json:"project_id"`
	UpdatedAt time.Time `json:"updated_at"`
}

// ThreadsByIssue lists the threads linked to Linear issues, by upper-cased identifier (newest
// first). Threads of archived sessions are left out.
func (s *Store) ThreadsByIssue(ctx context.Context) (map[string][]LinkedThread, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT l.identifier, t.id, t.session_id, t.subject, t.status, COALESCE(ss.project_id,''), t.updated_at
	  FROM thread_links l JOIN threads t ON t.id=l.thread_id JOIN sessions ss ON ss.id=t.session_id
	  WHERE l.identifier!='' AND ss.archived_at IS NULL ORDER BY t.updated_at DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string][]LinkedThread{}
	for rows.Next() {
		var id string
		var lt LinkedThread
		var upd int64
		if err := rows.Scan(&id, &lt.ThreadID, &lt.SessionID, &lt.Subject, &lt.Status, &lt.ProjectID, &upd); err != nil {
			return nil, err
		}
		lt.UpdatedAt = fromMs(upd)
		id = strings.ToUpper(id)
		out[id] = append(out[id], lt)
	}
	return out, rows.Err()
}
