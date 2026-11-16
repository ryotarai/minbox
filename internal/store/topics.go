package store

import (
	"context"
	"database/sql"
	"errors"
	"strings"
	"time"
)

// Topics: the pieces of work a thread is about, as the helper model reads them from the thread's
// messages (see internal/server/topics.go). One thread can have several at once, each with its own
// status, independent of the thread's status. They are replaced per thread on each extraction;
// a topic that continues keeps its id (matched by id, else by title), so the board's cards stay put.
//
// The person can move a topic to another column by hand (SetTopicStatus): that status holds until
// the thread's next extraction, which is told about the move (manual_status, manual_at) and whose
// answer then replaces it; an extraction that started before the move keeps the move.

const topicSchema = `
CREATE TABLE IF NOT EXISTS topics (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  done_at INTEGER,
  manual_status TEXT NOT NULL DEFAULT '',
  manual_at INTEGER
);
CREATE INDEX IF NOT EXISTS topics_thread ON topics(thread_id);
`

// topicAddedColumns: columns added to topics after its first release. Kept apart from addedColumns,
// whose tables every older schema has (tests build old databases from it).
var topicAddedColumns = []struct{ table, column, def string }{
	{"topics", "manual_status", "TEXT NOT NULL DEFAULT ''"}, // a topic moved by hand (SetTopicStatus)
	{"topics", "manual_at", "INTEGER"},
}

// Topic statuses (the board's columns).
const (
	TopicInProgress   = "in_progress"
	TopicWaitingOnYou = "waiting_on_you"
	TopicDone         = "done"
)

// NormalizeTopicStatus maps a status (or an alias) to its canonical value.
func NormalizeTopicStatus(v string) (string, bool) {
	switch strings.ToLower(strings.TrimSpace(strings.ReplaceAll(v, "-", "_"))) {
	case "in_progress", "inprogress", "working", "active", "open":
		return TopicInProgress, true
	case "waiting_on_you", "waiting", "need_action", "needs_action", "waiting_on_person", "waiting_for_you":
		return TopicWaitingOnYou, true
	case "done", "finished", "resolved", "complete", "completed", "closed", "dropped":
		return TopicDone, true
	}
	return "", false
}

// Topic is one topic of a thread. The thread's fields are filled by ListTopics.
type Topic struct {
	ID        string     `json:"id"`
	ThreadID  string     `json:"thread_id"`
	Title     string     `json:"title"`
	Summary   string     `json:"summary"`
	Status    string     `json:"status"`
	Position  int        `json:"position"`
	CreatedAt time.Time  `json:"created_at"`
	UpdatedAt time.Time  `json:"updated_at"`
	DoneAt    *time.Time `json:"done_at"`
	// The person moved it to ManualStatus by hand at ManualAt ("" / nil: not since the last extraction).
	ManualStatus string     `json:"manual_status"`
	ManualAt     *time.Time `json:"manual_at"`
	// The thread's (ListTopics only).
	ThreadName    string `json:"thread_name,omitempty"`
	ThreadSubject string `json:"thread_subject,omitempty"`
	SessionID     string `json:"session_id,omitempty"`
	ProjectID     string `json:"project_id,omitempty"`
	ProjectName   string `json:"project_name,omitempty"`
}

// TopicInput is a topic as an extraction gives it. ID, when set, names the thread's current topic
// it continues.
type TopicInput struct {
	ID      string
	Title   string
	Summary string
	Status  string
}

const topicCols = `id, thread_id, title, summary, status, position, created_at, updated_at, done_at, manual_status, manual_at`

func scanTopic(row interface{ Scan(...any) error }, extra ...any) (*Topic, error) {
	var t Topic
	var created, updated int64
	var done, manual sql.NullInt64
	if err := row.Scan(append([]any{&t.ID, &t.ThreadID, &t.Title, &t.Summary, &t.Status, &t.Position, &created, &updated, &done, &t.ManualStatus, &manual}, extra...)...); err != nil {
		return nil, err
	}
	t.CreatedAt, t.UpdatedAt, t.DoneAt, t.ManualAt = fromMs(created), fromMs(updated), fromNullMs(done), fromNullMs(manual)
	return &t, nil
}

// ThreadTopics lists a thread's topics in their order.
func (s *Store) ThreadTopics(ctx context.Context, threadID string) ([]Topic, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT `+topicCols+` FROM topics WHERE thread_id=? ORDER BY position, created_at`, threadID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Topic{}
	for rows.Next() {
		t, err := scanTopic(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *t)
	}
	return out, rows.Err()
}

// topicKey is how titles are matched: case, spacing and trailing punctuation do not count.
func topicKey(title string) string {
	return strings.Trim(strings.Join(strings.Fields(strings.ToLower(title)), " "), ".。!?")
}

// ReplaceTopics makes in the thread's topics. A topic in in that continues a current one (same id,
// else same title) keeps its id, created_at and, when nothing about it changed, updated_at. Current
// topics left out are deleted, except done ones: they stay (the board shows recent done work). It
// reports whether anything changed.
//
// started is when the extraction began (zero: now). A topic the person moved by hand at or after
// started keeps that status and its manual marker (the extraction did not know of the move), and is
// not deleted when left out; every other manual marker is cleared: the answer took it into account.
func (s *Store) ReplaceTopics(ctx context.Context, threadID string, in []TopicInput, started time.Time) (bool, error) {
	cur, err := s.ThreadTopics(ctx, threadID)
	if err != nil {
		return false, err
	}
	byID := map[string]*Topic{}
	byKey := map[string]*Topic{}
	for i := range cur {
		byID[cur[i].ID] = &cur[i]
		if _, ok := byKey[topicKey(cur[i].Title)]; !ok {
			byKey[topicKey(cur[i].Title)] = &cur[i]
		}
	}
	now := s.now()
	if started.IsZero() {
		started = now
	}
	// fresh: moved by hand after the extraction started.
	fresh := func(t *Topic) bool { return t.ManualAt != nil && ms(*t.ManualAt) >= ms(started) }
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return false, err
	}
	defer tx.Rollback()
	changed := false
	kept := map[string]bool{}
	pos := 0
	for _, t := range in {
		title := strings.TrimSpace(t.Title)
		status, ok := NormalizeTopicStatus(t.Status)
		if title == "" || !ok {
			continue
		}
		summary := strings.TrimSpace(t.Summary)
		old := byID[t.ID]
		if old == nil || kept[old.ID] {
			old = byKey[topicKey(title)]
		}
		if old != nil && kept[old.ID] {
			continue // two answers for one topic: the first wins
		}
		if old == nil {
			var done any
			if status == TopicDone {
				done = ms(now)
			}
			id := NewID("tpc")
			if _, err := tx.ExecContext(ctx, `INSERT INTO topics(`+topicCols+`) VALUES(?,?,?,?,?,?,?,?,?,'',NULL)`,
				id, threadID, title, summary, status, pos, ms(now), ms(now), done); err != nil {
				return false, err
			}
			kept[id] = true
			changed = true
			pos++
			continue
		}
		kept[old.ID] = true
		manualStatus, manualAt := "", any(nil)
		if fresh(old) {
			status, manualStatus, manualAt = old.Status, old.ManualStatus, ms(*old.ManualAt)
		}
		same := old.Title == title && old.Summary == summary && old.Status == status
		if same && old.Position == pos && old.ManualStatus == manualStatus {
			pos++
			continue
		}
		updated := ms(old.UpdatedAt)
		if !same {
			updated = ms(now)
		}
		var done any
		switch {
		case status == TopicDone && old.Status == TopicDone && old.DoneAt != nil:
			done = ms(*old.DoneAt)
		case status == TopicDone:
			done = ms(now)
		}
		if _, err := tx.ExecContext(ctx, `UPDATE topics SET title=?, summary=?, status=?, position=?, updated_at=?, done_at=?, manual_status=?, manual_at=? WHERE id=?`,
			title, summary, status, pos, updated, done, manualStatus, manualAt, old.ID); err != nil {
			return false, err
		}
		changed = true
		pos++
	}
	for i := range cur {
		t := &cur[i]
		if kept[t.ID] {
			continue
		}
		if t.Status == TopicDone || fresh(t) {
			manualStatus, manualAt := "", any(nil)
			if fresh(t) {
				manualStatus, manualAt = t.ManualStatus, ms(*t.ManualAt)
			}
			if t.Position != pos || t.ManualStatus != manualStatus {
				if _, err := tx.ExecContext(ctx, `UPDATE topics SET position=?, manual_status=?, manual_at=? WHERE id=?`, pos, manualStatus, manualAt, t.ID); err != nil {
					return false, err
				}
			}
			pos++
			continue
		}
		if _, err := tx.ExecContext(ctx, `DELETE FROM topics WHERE id=?`, t.ID); err != nil {
			return false, err
		}
		changed = true
	}
	if err := tx.Commit(); err != nil {
		return false, err
	}
	return changed, nil
}

// Now is the store's clock (an extraction's start, for ReplaceTopics).
func (s *Store) Now() time.Time { return s.now() }

// SetTopicStatus moves a topic to status by hand (the person dragged its card): the status holds
// until the thread's next extraction, which is told about the move. done_at is set when it turns
// done (kept when it already was) and cleared otherwise; updated_at is bumped. It returns the topic
// with its thread's session id.
func (s *Store) SetTopicStatus(ctx context.Context, id, status string) (*Topic, error) {
	st, ok := NormalizeTopicStatus(status)
	if !ok {
		return nil, ErrInvalidTopicStatus
	}
	now := ms(s.now())
	res, err := s.db.ExecContext(ctx, `UPDATE topics SET
	  done_at = CASE WHEN ?='done' THEN (CASE WHEN status='done' AND done_at IS NOT NULL THEN done_at ELSE ? END) ELSE NULL END,
	  status=?, manual_status=?, manual_at=?, updated_at=? WHERE id=?`, st, now, st, st, now, now, id)
	if err != nil {
		return nil, err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return nil, ErrNotFound
	}
	var sess string
	t, err := scanTopic(s.db.QueryRowContext(ctx, `SELECT `+prefixed("tp.", topicCols)+`, t.session_id FROM topics tp JOIN threads t ON t.id=tp.thread_id WHERE tp.id=?`, id), &sess)
	if err != nil {
		return nil, err
	}
	t.SessionID = sess
	return t, nil
}

// ErrInvalidTopicStatus: not one of the board's columns.
var ErrInvalidTopicStatus = errors.New("status must be in_progress, waiting_on_you or done")

// prefixed puts p in front of each of the comma-separated columns.
func prefixed(p, cols string) string {
	parts := strings.Split(cols, ",")
	for i, c := range parts {
		parts[i] = p + strings.TrimSpace(c)
	}
	return strings.Join(parts, ", ")
}

// TopicQuery filters ListTopics.
type TopicQuery struct {
	ProjectID string // "" = every project
	// DoneSince: done topics finished before it are left out (zero: all of them).
	DoneSince time.Time
	// DoneLimit: at most this many done topics, the newest (0: no limit).
	DoneLimit int
}

// ListTopics lists the topics of every thread that is not archived (in a live session and project),
// with their thread's names: open topics by last change, newest first, then the done ones by when
// they were done, newest first.
func (s *Store) ListTopics(ctx context.Context, q TopicQuery) ([]Topic, error) {
	where := `t.archived_at IS NULL AND s.archived_at IS NULL AND (p.id IS NULL OR p.archived_at IS NULL)`
	args := []any{}
	if q.ProjectID != "" {
		where += ` AND s.project_id=?`
		args = append(args, q.ProjectID)
	}
	rows, err := s.db.QueryContext(ctx, `SELECT tp.id, tp.thread_id, tp.title, tp.summary, tp.status, tp.position, tp.created_at, tp.updated_at, tp.done_at, tp.manual_status, tp.manual_at,
	  t.name, t.subject, t.session_id, COALESCE(s.project_id,''), COALESCE(p.name,'')
	  FROM topics tp JOIN threads t ON t.id=tp.thread_id JOIN sessions s ON s.id=t.session_id LEFT JOIN projects p ON p.id=s.project_id
	  WHERE `+where+` ORDER BY CASE WHEN tp.status='done' THEN 1 ELSE 0 END, COALESCE(tp.done_at, 0) DESC, tp.updated_at DESC, tp.position`, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Topic{}
	done := 0
	for rows.Next() {
		var t *Topic
		var name, subject, sess, proj, projName string
		if t, err = scanTopic(rows, &name, &subject, &sess, &proj, &projName); err != nil {
			return nil, err
		}
		t.ThreadName, t.ThreadSubject, t.SessionID, t.ProjectID, t.ProjectName = name, subject, sess, proj, projName
		if t.Status == TopicDone {
			if (!q.DoneSince.IsZero() && (t.DoneAt == nil || t.DoneAt.Before(q.DoneSince))) || (q.DoneLimit > 0 && done >= q.DoneLimit) {
				continue
			}
			done++
		}
		out = append(out, *t)
	}
	return out, rows.Err()
}
