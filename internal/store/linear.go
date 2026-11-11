package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"time"
)

// The Linear integration's tables (additive: nothing else reads them).

const linearSchema = `
CREATE TABLE IF NOT EXISTS linear_auth (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  data TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS thread_links (
  thread_id TEXT PRIMARY KEY REFERENCES threads(id) ON DELETE CASCADE,
  issue_id TEXT NOT NULL DEFAULT '',
  identifier TEXT NOT NULL DEFAULT '',
  url TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL DEFAULT '',
  state_type TEXT NOT NULL DEFAULT '',
  assignee TEXT NOT NULL DEFAULT '',
  team_id TEXT NOT NULL DEFAULT '',
  team_name TEXT NOT NULL DEFAULT '',
  baselined INTEGER NOT NULL DEFAULT 0,
  last_seen_comment_at INTEGER NOT NULL DEFAULT 0,
  seen_comment_ids TEXT NOT NULL DEFAULT '[]',
  progress_comment_id TEXT NOT NULL DEFAULT '',
  progress_hash TEXT NOT NULL DEFAULT '',
  last_progress_at INTEGER NOT NULL DEFAULT 0,
  last_status TEXT NOT NULL DEFAULT '',
  last_synced_at INTEGER NOT NULL DEFAULT 0,
  last_error TEXT NOT NULL DEFAULT '',
  last_error_at INTEGER NOT NULL DEFAULT 0,
  include_body INTEGER,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS linear_events (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  external_id TEXT NOT NULL DEFAULT '',
  author TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL DEFAULT '',
  url TEXT NOT NULL DEFAULT '',
  filtered INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  inject_message_id TEXT NOT NULL DEFAULT '',
  delivered_at INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS linear_events_ext ON linear_events(thread_id, external_id) WHERE external_id != '';
CREATE INDEX IF NOT EXISTS linear_events_thread ON linear_events(thread_id, created_at);
`

// MaxSeenCommentIDs bounds the comment ids a link remembers.
const MaxSeenCommentIDs = 500

// LinearAuth returns the stored login (JSON owned by the server's linear code; it holds tokens
// and never goes to a client), "" when there is none.
func (s *Store) LinearAuth(ctx context.Context) (string, error) {
	var d string
	err := s.db.QueryRowContext(ctx, `SELECT data FROM linear_auth WHERE id=1`).Scan(&d)
	if errors.Is(err, sql.ErrNoRows) {
		return "", nil
	}
	return d, err
}

// SetLinearAuth stores the login.
func (s *Store) SetLinearAuth(ctx context.Context, data string) error {
	_, err := s.db.ExecContext(ctx, `INSERT INTO linear_auth(id,data) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data`, data)
	return err
}

// DeleteLinearAuth forgets the login.
func (s *Store) DeleteLinearAuth(ctx context.Context) error {
	_, err := s.db.ExecContext(ctx, `DELETE FROM linear_auth`)
	return err
}

// ThreadLink links a thread to one Linear issue.
type ThreadLink struct {
	ThreadID   string `json:"thread_id"`
	IssueID    string `json:"issue_id"`
	Identifier string `json:"identifier"`
	URL        string `json:"url"`
	Title      string `json:"title"`
	State      string `json:"state"`
	StateType  string `json:"state_type"`
	Assignee   string `json:"assignee"`
	TeamID     string `json:"-"`
	TeamName   string `json:"-"`
	// Baselined: the comments that existed at link time were recorded as seen.
	Baselined          bool       `json:"-"`
	LastSeenCommentAt  time.Time  `json:"-"`
	SeenCommentIDs     []string   `json:"-"`
	ProgressCommentID  string     `json:"-"`
	ProgressHash       string     `json:"-"`
	LastProgressAt     time.Time  `json:"-"`
	LastStatus         string     `json:"-"`
	LastSyncedAt       *time.Time `json:"last_synced_at"`
	LastError          string     `json:"last_error"`
	LastErrorAt        *time.Time `json:"last_error_at"`
	IncludeBody        *bool      `json:"include_body"` // nil: the global setting
	CreatedAt          time.Time  `json:"created_at"`
	HasProgressComment bool       `json:"has_progress_comment"`
	// Syncing is filled by the server (a refresh is running).
	Syncing bool `json:"syncing"`
}

const linkCols = `thread_id, issue_id, identifier, url, title, state, state_type, assignee, team_id, team_name, baselined,
  last_seen_comment_at, seen_comment_ids, progress_comment_id, progress_hash, last_progress_at, last_status,
  last_synced_at, last_error, last_error_at, include_body, created_at`

func scanLink(row interface{ Scan(...any) error }) (*ThreadLink, error) {
	var l ThreadLink
	var seen string
	var base, lastSeen, lastProg, synced, errAt, created int64
	var incl sql.NullBool
	if err := row.Scan(&l.ThreadID, &l.IssueID, &l.Identifier, &l.URL, &l.Title, &l.State, &l.StateType, &l.Assignee, &l.TeamID, &l.TeamName, &base,
		&lastSeen, &seen, &l.ProgressCommentID, &l.ProgressHash, &lastProg, &l.LastStatus, &synced, &l.LastError, &errAt, &incl, &created); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	l.Baselined = base != 0
	if lastSeen > 0 {
		l.LastSeenCommentAt = fromMs(lastSeen)
	}
	if lastProg > 0 {
		l.LastProgressAt = fromMs(lastProg)
	}
	if synced > 0 {
		t := fromMs(synced)
		l.LastSyncedAt = &t
	}
	if errAt > 0 {
		t := fromMs(errAt)
		l.LastErrorAt = &t
	}
	if incl.Valid {
		b := incl.Bool
		l.IncludeBody = &b
	}
	l.CreatedAt = fromMs(created)
	l.SeenCommentIDs = []string{}
	_ = json.Unmarshal([]byte(seen), &l.SeenCommentIDs)
	l.HasProgressComment = l.ProgressCommentID != ""
	return &l, nil
}

// GetThreadLink returns a thread's link, ErrNotFound when there is none.
func (s *Store) GetThreadLink(ctx context.Context, threadID string) (*ThreadLink, error) {
	return scanLink(s.db.QueryRowContext(ctx, `SELECT `+linkCols+` FROM thread_links WHERE thread_id=?`, threadID))
}

// HasThreadLink is the cheap check.
func (s *Store) HasThreadLink(ctx context.Context, threadID string) bool {
	var n int
	_ = s.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM thread_links WHERE thread_id=?`, threadID).Scan(&n)
	return n > 0
}

// PutThreadLink inserts or replaces a link.
func (s *Store) PutThreadLink(ctx context.Context, l *ThreadLink) error {
	ids := l.SeenCommentIDs
	if len(ids) > MaxSeenCommentIDs {
		ids = ids[len(ids)-MaxSeenCommentIDs:]
	}
	if ids == nil {
		ids = []string{}
	}
	seen, _ := json.Marshal(ids)
	created := l.CreatedAt
	if created.IsZero() {
		created = s.now()
	}
	var incl any
	if l.IncludeBody != nil {
		incl = *l.IncludeBody
	}
	nm := func(t time.Time) int64 {
		if t.IsZero() {
			return 0
		}
		return ms(t)
	}
	np := func(t *time.Time) int64 {
		if t == nil {
			return 0
		}
		return ms(*t)
	}
	_, err := s.db.ExecContext(ctx, `INSERT OR REPLACE INTO thread_links(`+linkCols+`) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
		l.ThreadID, l.IssueID, l.Identifier, l.URL, l.Title, l.State, l.StateType, l.Assignee, l.TeamID, l.TeamName, l.Baselined,
		nm(l.LastSeenCommentAt), string(seen), l.ProgressCommentID, l.ProgressHash, nm(l.LastProgressAt), l.LastStatus,
		np(l.LastSyncedAt), l.LastError, np(l.LastErrorAt), incl, ms(created))
	return err
}

// DeleteThreadLink unlinks a thread (its recorded Linear events go with it).
func (s *Store) DeleteThreadLink(ctx context.Context, threadID string) error {
	if _, err := s.db.ExecContext(ctx, `DELETE FROM linear_events WHERE thread_id=?`, threadID); err != nil {
		return err
	}
	_, err := s.db.ExecContext(ctx, `DELETE FROM thread_links WHERE thread_id=?`, threadID)
	return err
}

// LinearEvent is something that happened on the linked issue: a comment, or a compact change of
// the issue (kind "comment" | "state" | "title" | "assignee").
type LinearEvent struct {
	ID         string    `json:"id"`
	ThreadID   string    `json:"thread_id"`
	Kind       string    `json:"kind"`
	ExternalID string    `json:"-"`
	Author     string    `json:"author"`
	Body       string    `json:"body"`
	URL        string    `json:"url"`
	Filtered   bool      `json:"filtered"` // not passed to the agent (the author filter)
	CreatedAt  time.Time `json:"created_at"`
	// Delivered: the agent got it with a message.
	Delivered bool `json:"delivered"`

	injectMessageID string
}

const eventCols = `id, thread_id, kind, external_id, author, body, url, filtered, created_at, inject_message_id, delivered_at`

func scanEvent(row interface{ Scan(...any) error }) (*LinearEvent, error) {
	var e LinearEvent
	var created int64
	var del sql.NullInt64
	if err := row.Scan(&e.ID, &e.ThreadID, &e.Kind, &e.ExternalID, &e.Author, &e.Body, &e.URL, &e.Filtered, &created, &e.injectMessageID, &del); err != nil {
		return nil, err
	}
	e.CreatedAt = fromMs(created)
	e.Delivered = del.Valid
	return &e, nil
}

// AddLinearEvent records an event; an event whose ExternalID is already there is ignored (false).
func (s *Store) AddLinearEvent(ctx context.Context, e *LinearEvent) (bool, error) {
	if e.ID == "" {
		e.ID = NewID("lev")
	}
	if e.CreatedAt.IsZero() {
		e.CreatedAt = s.now()
	}
	res, err := s.db.ExecContext(ctx, `INSERT OR IGNORE INTO linear_events(id, thread_id, kind, external_id, author, body, url, filtered, created_at)
	  VALUES(?,?,?,?,?,?,?,?,?)`, e.ID, e.ThreadID, e.Kind, e.ExternalID, e.Author, e.Body, e.URL, e.Filtered, ms(e.CreatedAt))
	if err != nil {
		return false, err
	}
	n, _ := res.RowsAffected()
	return n > 0, nil
}

// ListLinearEvents lists a thread's events, oldest first.
func (s *Store) ListLinearEvents(ctx context.Context, threadID string) ([]LinearEvent, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT `+eventCols+` FROM linear_events WHERE thread_id=? ORDER BY created_at, rowid`, threadID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []LinearEvent{}
	for rows.Next() {
		e, err := scanEvent(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *e)
	}
	return out, rows.Err()
}

// AssignLinearEvents ties the thread's undelivered events to the message that will carry them to
// the agent and returns them, oldest first. It is idempotent while the message is pending (the
// same events come back); events tied to a message that is gone are taken over.
func (s *Store) AssignLinearEvents(ctx context.Context, threadID, messageID string) ([]LinearEvent, error) {
	if _, err := s.db.ExecContext(ctx, `UPDATE linear_events SET inject_message_id=?
	  WHERE thread_id=? AND delivered_at IS NULL AND (inject_message_id='' OR inject_message_id NOT IN (SELECT id FROM messages))`, messageID, threadID); err != nil {
		return nil, err
	}
	rows, err := s.db.QueryContext(ctx, `SELECT `+eventCols+` FROM linear_events WHERE thread_id=? AND delivered_at IS NULL AND inject_message_id=? ORDER BY created_at, rowid`, threadID, messageID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []LinearEvent
	for rows.Next() {
		e, err := scanEvent(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *e)
	}
	return out, rows.Err()
}

// markLinearDelivered: the agent got the message, so it got the events tied to it.
func (s *Store) markLinearDelivered(ctx context.Context, messageID string) error {
	_, err := s.db.ExecContext(ctx, `UPDATE linear_events SET delivered_at=COALESCE(delivered_at, ?) WHERE inject_message_id=? AND delivered_at IS NULL`, ms(s.now()), messageID)
	return err
}
