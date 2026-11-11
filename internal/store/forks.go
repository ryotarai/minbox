package store

import (
	"context"
	"database/sql"
	"errors"
	"time"
)

// Thread forks: a thread started from a message of another thread. The link table is additive
// (nothing else reads it). It is named thread_forks because thread_links is the Linear link.
//
// A fork keeps a snapshot of the parent (subject, project, session, message number) so that the
// child still says where it came from when the parent is deleted (parent_thread_id becomes NULL).
// The handoff text the new agent reads first is composed once at creation and frozen here: it is
// not part of the child's visible message, it is put in front of that message when the message is
// delivered (see the server's forkInject), exactly as the preview showed it.

const forkSchema = `
CREATE TABLE IF NOT EXISTS thread_forks (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL DEFAULT 'fork',
  child_thread_id TEXT NOT NULL UNIQUE REFERENCES threads(id) ON DELETE CASCADE,
  parent_thread_id TEXT REFERENCES threads(id) ON DELETE SET NULL,
  from_message_id TEXT NOT NULL DEFAULT '',
  from_seq INTEGER NOT NULL DEFAULT 0,
  from_excerpt TEXT NOT NULL DEFAULT '',
  parent_subject TEXT NOT NULL DEFAULT '',
  parent_project_name TEXT NOT NULL DEFAULT '',
  parent_session_name TEXT NOT NULL DEFAULT '',
  same_session INTEGER NOT NULL DEFAULT 0,
  carry_before INTEGER NOT NULL DEFAULT 0,
  handoff TEXT NOT NULL DEFAULT '',
  handoff_message_id TEXT NOT NULL DEFAULT '',
  handoff_delivered_at INTEGER,
  notice_state TEXT NOT NULL DEFAULT 'pending',
  notice_message_id TEXT NOT NULL DEFAULT '',
  notice_delivered_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS thread_forks_parent ON thread_forks(parent_thread_id, from_message_id);
`

// Notice states of a fork towards the parent thread's agent.
const (
	ForkNoticePending   = "pending"
	ForkNoticeDelivered = "delivered"
	ForkNoticeSkipped   = "skipped_same_session"
)

// ThreadFork is a stored fork link (the row to write).
type ThreadFork struct {
	ID               string
	ChildThreadID    string
	ParentThreadID   string // '' once the parent is deleted
	FromMessageID    string
	FromSeq          int
	FromExcerpt      string
	ParentSubject    string
	ParentProject    string
	ParentSession    string
	SameSession      bool
	CarryBefore      int
	Handoff          string
	HandoffMessageID string
	NoticeState      string
}

// ForkedFrom is what a forked thread says about where it came from (Thread JSON, GetThread).
type ForkedFrom struct {
	// ThreadID is empty when the parent thread no longer exists (Gone).
	ThreadID    string `json:"thread_id"`
	Subject     string `json:"subject"`
	ProjectName string `json:"project_name"`
	SessionName string `json:"session_name"`
	// SessionID: the parent thread's session ('' when it is gone), to open it.
	SessionID string `json:"session_id"`
	MessageID string `json:"message_id"`
	Seq       int    `json:"seq"`
	Gone      bool   `json:"gone"`
	// MessageGone: the message is not in the parent thread any more (cancelled, or the thread is gone).
	MessageGone bool `json:"message_gone"`
	SameSession bool `json:"same_session"`
	CarryBefore int  `json:"carry_before"`
	// Handoff: the text the agent got in front of the first message (the "Handoff context" card).
	Handoff   string    `json:"handoff"`
	CreatedAt time.Time `json:"created_at"`
}

// ForkChild is a thread started from a message of this thread (Thread JSON, GetThread).
type ForkChild struct {
	ThreadID      string     `json:"thread_id"`
	Subject       string     `json:"subject"`
	ProjectID     string     `json:"project_id"`
	ProjectName   string     `json:"project_name"`
	SessionID     string     `json:"session_id"`
	SessionName   string     `json:"session_name"`
	Agent         string     `json:"agent"`
	Status        string     `json:"status"`
	FromMessageID string     `json:"from_message_id"`
	Seq           int        `json:"seq"`
	SameSession   bool       `json:"same_session"`
	ArchivedAt    *time.Time `json:"archived_at"`
	CreatedAt     time.Time  `json:"created_at"`
}

// CreateThreadWith is CreateThread plus a step in the same transaction (a link to write).
func (s *Store) CreateThreadWith(ctx context.Context, sessionID, subject string, m NewMessage, after func(tx *sql.Tx, th *Thread, msg *Message) error) (*Thread, *Message, error) {
	if _, err := scanSession(s.db.QueryRowContext(ctx, `SELECT `+sessionCols+` FROM sessions WHERE id=?`, sessionID)); err != nil {
		return nil, nil, err
	}
	now := s.now()
	th := &Thread{ID: NewID("thr"), SessionID: sessionID, Subject: subject, CreatedAt: now, UpdatedAt: now, Status: statusAfter("", m)}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, nil, err
	}
	defer tx.Rollback()
	if _, err := tx.ExecContext(ctx, `INSERT INTO threads(id,session_id,subject,created_at,updated_at,status) VALUES(?,?,?,?,?,?)`,
		th.ID, th.SessionID, th.Subject, ms(now), ms(now), th.Status); err != nil {
		return nil, nil, err
	}
	msg, err := insertMessage(ctx, tx, th.ID, m, now)
	if err != nil {
		return nil, nil, err
	}
	if after != nil {
		if err := after(tx, th, msg); err != nil {
			return nil, nil, err
		}
	}
	if err := tx.Commit(); err != nil {
		return nil, nil, err
	}
	return th, msg, nil
}

// InsertFork writes the link of a new child thread (in CreateThreadWith's step).
func (s *Store) InsertFork(ctx context.Context, tx *sql.Tx, f ThreadFork) error {
	if f.ID == "" {
		f.ID = NewID("frk")
	}
	if f.NoticeState == "" {
		f.NoticeState = ForkNoticePending
	}
	_, err := tx.ExecContext(ctx, `INSERT INTO thread_forks(id, child_thread_id, parent_thread_id, from_message_id, from_seq, from_excerpt,
	  parent_subject, parent_project_name, parent_session_name, same_session, carry_before, handoff, handoff_message_id, notice_state, created_at)
	  VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
		f.ID, f.ChildThreadID, emptyNil(f.ParentThreadID), f.FromMessageID, f.FromSeq, f.FromExcerpt,
		f.ParentSubject, f.ParentProject, f.ParentSession, f.SameSession, f.CarryBefore, f.Handoff, f.HandoffMessageID, f.NoticeState, ms(s.now()))
	return err
}

func emptyNil(s string) any {
	if s == "" {
		return nil
	}
	return s
}

// forkIndex says, for the threads in a list, which are forks and how many forks each has.
func (s *Store) forkIndex(ctx context.Context) (isFork map[string]bool, count map[string]int) {
	isFork, count = map[string]bool{}, map[string]int{}
	rows, err := s.db.QueryContext(ctx, `SELECT child_thread_id, COALESCE(parent_thread_id,'') FROM thread_forks`)
	if err != nil {
		return
	}
	defer rows.Close()
	for rows.Next() {
		var c, p string
		if rows.Scan(&c, &p) == nil {
			isFork[c] = true
			if p != "" {
				count[p]++
			}
		}
	}
	return
}

// ForkedFromOf describes where the thread came from; nil when it is not a fork.
func (s *Store) ForkedFromOf(ctx context.Context, threadID string) (*ForkedFrom, error) {
	var f ForkedFrom
	var parent sql.NullString
	var created int64
	var liveSubject, liveProject, liveSession, liveSessID, msgThread sql.NullString
	err := s.db.QueryRowContext(ctx, `SELECT f.parent_thread_id, f.from_message_id, f.from_seq, f.parent_subject, f.parent_project_name, f.parent_session_name,
	  f.same_session, f.carry_before, f.handoff, f.created_at, pt.subject, p.name, ss.name, ss.id, (SELECT thread_id FROM messages WHERE id=f.from_message_id)
	  FROM thread_forks f LEFT JOIN threads pt ON pt.id=f.parent_thread_id LEFT JOIN sessions ss ON ss.id=pt.session_id LEFT JOIN projects p ON p.id=ss.project_id
	  WHERE f.child_thread_id=?`, threadID).
		Scan(&parent, &f.MessageID, &f.Seq, &f.Subject, &f.ProjectName, &f.SessionName, &f.SameSession, &f.CarryBefore, &f.Handoff, &created, &liveSubject, &liveProject, &liveSession, &liveSessID, &msgThread)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	f.CreatedAt = fromMs(created)
	if parent.Valid && liveSubject.Valid {
		f.ThreadID = parent.String
		f.Subject = liveSubject.String
		if liveProject.Valid {
			f.ProjectName = liveProject.String
		}
		if liveSession.Valid {
			f.SessionName = liveSession.String
		}
		f.SessionID = liveSessID.String
		f.MessageGone = !msgThread.Valid || msgThread.String != parent.String
	} else {
		f.Gone, f.MessageGone = true, true
	}
	return &f, nil
}

// ForksOf lists the threads started from the thread's messages, oldest first.
func (s *Store) ForksOf(ctx context.Context, threadID string) ([]ForkChild, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT f.child_thread_id, t.subject, COALESCE(ss.project_id,''), COALESCE(p.name,''), t.session_id, ss.name, ss.agent,
	  COALESCE(t.status,''), f.from_message_id, f.from_seq, f.same_session, t.archived_at, f.created_at
	  FROM thread_forks f JOIN threads t ON t.id=f.child_thread_id JOIN sessions ss ON ss.id=t.session_id LEFT JOIN projects p ON p.id=ss.project_id
	  WHERE f.parent_thread_id=? ORDER BY f.created_at, f.rowid`, threadID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []ForkChild
	for rows.Next() {
		var c ForkChild
		var created int64
		var archived sql.NullInt64
		if err := rows.Scan(&c.ThreadID, &c.Subject, &c.ProjectID, &c.ProjectName, &c.SessionID, &c.SessionName, &c.Agent, &c.Status, &c.FromMessageID, &c.Seq, &c.SameSession, &archived, &created); err != nil {
			return nil, err
		}
		c.CreatedAt = fromMs(created)
		c.ArchivedAt = fromNullMs(archived)
		out = append(out, c)
	}
	return out, rows.Err()
}

// ForkHandoffFor returns the frozen handoff text to put in front of the message, if the message is
// a fork's first one and the agent has not got it yet.
func (s *Store) ForkHandoffFor(ctx context.Context, messageID string) (string, bool) {
	var h string
	err := s.db.QueryRowContext(ctx, `SELECT handoff FROM thread_forks WHERE handoff_message_id=? AND handoff_delivered_at IS NULL AND handoff!=''`, messageID).Scan(&h)
	return h, err == nil
}

// ForkNotice is one fork the parent thread's agent has not been told about.
type ForkNotice struct {
	ParentThreadID string
	ParentSubject  string
	FromMessageID  string
	FromSeq        int
	FromExcerpt    string
	ChildThreadID  string
	ChildSubject   string
	ProjectName    string
	SessionName    string
	Agent          string
}

// AssignForkNotices ties the session's not-yet-told forks (made from threads of this session into
// another session) to the message that will carry them to the agent. It is idempotent while the
// message is pending; notices tied to a message that is gone are taken over.
func (s *Store) AssignForkNotices(ctx context.Context, sessionID, messageID string) error {
	_, err := s.db.ExecContext(ctx, `UPDATE thread_forks SET notice_message_id=?
	  WHERE notice_state=? AND parent_thread_id IN (SELECT id FROM threads WHERE session_id=?)
	    AND (notice_message_id='' OR notice_message_id NOT IN (SELECT id FROM messages))`, messageID, ForkNoticePending, sessionID)
	return err
}

// ForkNoticesFor lists the notices tied to the message (oldest first).
func (s *Store) ForkNoticesFor(ctx context.Context, messageID string) ([]ForkNotice, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT f.parent_thread_id, f.parent_subject, f.from_message_id, f.from_seq, f.from_excerpt, f.child_thread_id, t.subject,
	  COALESCE(p.name,''), ss.name, ss.agent
	  FROM thread_forks f JOIN threads t ON t.id=f.child_thread_id JOIN sessions ss ON ss.id=t.session_id LEFT JOIN projects p ON p.id=ss.project_id
	  WHERE f.notice_message_id=? AND f.notice_state=? AND f.parent_thread_id IS NOT NULL ORDER BY f.created_at, f.rowid`, messageID, ForkNoticePending)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []ForkNotice
	for rows.Next() {
		var n ForkNotice
		if err := rows.Scan(&n.ParentThreadID, &n.ParentSubject, &n.FromMessageID, &n.FromSeq, &n.FromExcerpt, &n.ChildThreadID, &n.ChildSubject, &n.ProjectName, &n.SessionName, &n.Agent); err != nil {
			return nil, err
		}
		out = append(out, n)
	}
	return out, rows.Err()
}

// markForkDelivered: the agent got the message, so it got the handoff and the notices tied to it.
func (s *Store) markForkDelivered(ctx context.Context, messageID string) error {
	now := ms(s.now())
	if _, err := s.db.ExecContext(ctx, `UPDATE thread_forks SET handoff_delivered_at=COALESCE(handoff_delivered_at, ?) WHERE handoff_message_id=?`, now, messageID); err != nil {
		return err
	}
	_, err := s.db.ExecContext(ctx, `UPDATE thread_forks SET notice_state=?, notice_delivered_at=? WHERE notice_message_id=? AND notice_state=?`, ForkNoticeDelivered, now, messageID, ForkNoticePending)
	return err
}

// ForkNoticeState reports a fork's notice state and the message carrying it (tests, the UI's "told" hint).
func (s *Store) ForkNoticeState(ctx context.Context, childThreadID string) (state, messageID string, err error) {
	err = s.db.QueryRowContext(ctx, `SELECT notice_state, notice_message_id FROM thread_forks WHERE child_thread_id=?`, childThreadID).Scan(&state, &messageID)
	if errors.Is(err, sql.ErrNoRows) {
		err = ErrNotFound
	}
	return
}
