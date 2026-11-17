package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"sort"
	"strings"
	"time"
)

// Topics (Tasks in the UI): the pieces of work a thread is about. The agent of the thread's session
// keeps them itself through its create_task / update_task tools (POST and PATCH /api/agent/tasks,
// see internal/server/topics.go): one thread can have several at once, each with its own status,
// independent of the thread's status.
//
// The person can move a topic to another column by hand (SetTopicStatus); the move is marked
// (manual_status, manual_at) until the agent sets the status again (UpdateTopic).

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
  manual_at INTEGER,
  detail TEXT NOT NULL DEFAULT '',
  tasks TEXT NOT NULL DEFAULT '[]',
  message_ids TEXT NOT NULL DEFAULT '[]'
);
CREATE INDEX IF NOT EXISTS topics_thread ON topics(thread_id);
`

// topicAddedColumns: columns added to topics after its first release. Kept apart from addedColumns,
// whose tables every older schema has (tests build old databases from it).
var topicAddedColumns = []struct{ table, column, def string }{
	{"topics", "manual_status", "TEXT NOT NULL DEFAULT ''"}, // a topic moved by hand (SetTopicStatus)
	{"topics", "manual_at", "INTEGER"},
	// The topic pane: a fuller summary, the steps (JSON [{text, done}]) and the related messages
	// (JSON [message id], in the thread's order).
	{"topics", "detail", "TEXT NOT NULL DEFAULT ''"},
	{"topics", "tasks", "TEXT NOT NULL DEFAULT '[]'"},
	{"topics", "message_ids", "TEXT NOT NULL DEFAULT '[]'"},
}

// TopicMaxMessages: at most this many related messages are kept per topic (the newest).
const TopicMaxMessages = 200

// TopicTask is one step of a topic (the agent's checklist), done or not.
type TopicTask struct {
	Text string `json:"text"`
	Done bool   `json:"done"`
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
	// The person moved it to ManualStatus by hand at ManualAt ("" / nil: not moved since the agent last set it).
	ManualStatus string     `json:"manual_status"`
	ManualAt     *time.Time `json:"manual_at"`
	// Detail: a fuller summary (a few sentences, Markdown). Tasks: its steps. MessageIDs: the
	// thread's messages about it, oldest first.
	Detail     string      `json:"detail"`
	Tasks      []TopicTask `json:"tasks"`
	MessageIDs []string    `json:"message_ids"`
	// The thread's (ListTopics only).
	ThreadName    string `json:"thread_name,omitempty"`
	ThreadSubject string `json:"thread_subject,omitempty"`
	SessionID     string `json:"session_id,omitempty"`
	ProjectID     string `json:"project_id,omitempty"`
	ProjectName   string `json:"project_name,omitempty"`
}

const topicCols = `id, thread_id, title, summary, status, position, created_at, updated_at, done_at, manual_status, manual_at, detail, tasks, message_ids`

func scanTopic(row interface{ Scan(...any) error }, extra ...any) (*Topic, error) {
	var t Topic
	var created, updated int64
	var done, manual sql.NullInt64
	var tasks, msgs string
	if err := row.Scan(append([]any{&t.ID, &t.ThreadID, &t.Title, &t.Summary, &t.Status, &t.Position, &created, &updated, &done, &t.ManualStatus, &manual, &t.Detail, &tasks, &msgs}, extra...)...); err != nil {
		return nil, err
	}
	t.CreatedAt, t.UpdatedAt, t.DoneAt, t.ManualAt = fromMs(created), fromMs(updated), fromNullMs(done), fromNullMs(manual)
	if json.Unmarshal([]byte(tasks), &t.Tasks) != nil || t.Tasks == nil {
		t.Tasks = []TopicTask{}
	}
	if json.Unmarshal([]byte(msgs), &t.MessageIDs) != nil || t.MessageIDs == nil {
		t.MessageIDs = []string{}
	}
	return &t, nil
}

// jsonText is v as JSON text (for the tasks and message_ids columns).
func jsonText(v any) string {
	b, _ := json.Marshal(v)
	return string(b)
}

// cleanTasks: the tasks with text, spacing collapsed (never nil).
func cleanTasks(in []TopicTask) []TopicTask {
	out := []TopicTask{}
	for _, t := range in {
		if text := strings.Join(strings.Fields(t.Text), " "); text != "" {
			out = append(out, TopicTask{Text: text, Done: t.Done})
		}
	}
	return out
}

// mergeMessageIDs: the ids of old and add that are messages of the thread (order: each message's
// place in it), once each, in the thread's order, at most TopicMaxMessages (the newest).
func mergeMessageIDs(order map[string]int, old, add []string) []string {
	seen := map[string]bool{}
	out := []string{}
	for _, id := range append(append([]string{}, old...), add...) {
		if _, ok := order[id]; ok && !seen[id] {
			seen[id] = true
			out = append(out, id)
		}
	}
	sort.SliceStable(out, func(i, j int) bool { return order[out[i]] < order[out[j]] })
	if len(out) > TopicMaxMessages {
		out = out[len(out)-TopicMaxMessages:]
	}
	return out
}

// threadMessageOrder: the ids of the thread's messages, each with its place in the thread.
func threadMessageOrder(ctx context.Context, tx *sql.Tx, threadID string) (map[string]int, error) {
	rows, err := tx.QueryContext(ctx, `SELECT id FROM messages WHERE thread_id=? ORDER BY created_at, rowid`, threadID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]int{}
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		out[id] = len(out)
	}
	return out, rows.Err()
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

// TopicFields are the fields of a topic the agent sets (CreateTopic, UpdateTopic). A nil field is
// left as it is (on create: empty; Status: in progress). AddMessageIDs are added to the topic's
// related messages; ids that are not messages of its thread are left out.
type TopicFields struct {
	Title         *string
	Summary       *string
	Detail        *string
	Status        *string
	Tasks         *[]TopicTask
	AddMessageIDs []string
}

// ErrTopicTitle: a topic needs a title.
var ErrTopicTitle = errors.New("title is required")

// CreateTopic adds a topic to the thread, after its others. Status defaults to in progress.
func (s *Store) CreateTopic(ctx context.Context, threadID string, f TopicFields) (*Topic, error) {
	title := ""
	if f.Title != nil {
		title = strings.Join(strings.Fields(*f.Title), " ")
	}
	if title == "" {
		return nil, ErrTopicTitle
	}
	status := TopicInProgress
	if f.Status != nil && strings.TrimSpace(*f.Status) != "" {
		st, ok := NormalizeTopicStatus(*f.Status)
		if !ok {
			return nil, ErrInvalidTopicStatus
		}
		status = st
	}
	str := func(p *string) string {
		if p == nil {
			return ""
		}
		return strings.TrimSpace(*p)
	}
	tasks := []TopicTask{}
	if f.Tasks != nil {
		tasks = cleanTasks(*f.Tasks)
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	var n int
	if err := tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM threads WHERE id=?`, threadID).Scan(&n); err != nil {
		return nil, err
	}
	if n == 0 {
		return nil, ErrNotFound
	}
	order, err := threadMessageOrder(ctx, tx, threadID)
	if err != nil {
		return nil, err
	}
	var pos int
	if err := tx.QueryRowContext(ctx, `SELECT COALESCE(MAX(position)+1, 0) FROM topics WHERE thread_id=?`, threadID).Scan(&pos); err != nil {
		return nil, err
	}
	now := ms(s.now())
	var done any
	if status == TopicDone {
		done = now
	}
	id := NewID("tpc")
	if _, err := tx.ExecContext(ctx, `INSERT INTO topics(`+topicCols+`) VALUES(?,?,?,?,?,?,?,?,?,'',NULL,?,?,?)`,
		id, threadID, title, str(f.Summary), status, pos, now, now, done, str(f.Detail), jsonText(tasks), jsonText(mergeMessageIDs(order, nil, f.AddMessageIDs))); err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return s.GetTopic(ctx, id)
}

// UpdateTopic changes the fields of f that are set. A status the agent sets replaces any move the
// person made by hand (the marker goes); done_at is set when it turns done (kept when it already
// was) and cleared otherwise. updated_at is bumped when anything but the related messages changed.
func (s *Store) UpdateTopic(ctx context.Context, id string, f TopicFields) (*Topic, error) {
	cur, err := s.GetTopic(ctx, id)
	if err != nil {
		return nil, err
	}
	t := *cur
	manual := t.ManualStatus != "" && t.ManualAt != nil
	if f.Title != nil {
		if t.Title = strings.Join(strings.Fields(*f.Title), " "); t.Title == "" {
			return nil, ErrTopicTitle
		}
	}
	if f.Summary != nil {
		t.Summary = strings.TrimSpace(*f.Summary)
	}
	if f.Detail != nil {
		t.Detail = strings.TrimSpace(*f.Detail)
	}
	if f.Tasks != nil {
		t.Tasks = cleanTasks(*f.Tasks)
	}
	now := s.now()
	if f.Status != nil && strings.TrimSpace(*f.Status) != "" {
		st, ok := NormalizeTopicStatus(*f.Status)
		if !ok {
			return nil, ErrInvalidTopicStatus
		}
		switch {
		case st == TopicDone && t.Status == TopicDone && t.DoneAt != nil:
		case st == TopicDone:
			t.DoneAt = &now
		default:
			t.DoneAt = nil
		}
		t.Status, manual = st, false
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	order, err := threadMessageOrder(ctx, tx, t.ThreadID)
	if err != nil {
		return nil, err
	}
	msgs := mergeMessageIDs(order, t.MessageIDs, f.AddMessageIDs)
	same := t.Title == cur.Title && t.Summary == cur.Summary && t.Detail == cur.Detail && t.Status == cur.Status && sameTasks(t.Tasks, cur.Tasks) &&
		manual == (cur.ManualStatus != "" && cur.ManualAt != nil)
	if same && sameStrings(msgs, cur.MessageIDs) {
		return cur, nil
	}
	updated := ms(cur.UpdatedAt)
	if !same {
		updated = ms(now)
	}
	var done, manualAt any
	if t.DoneAt != nil {
		done = ms(*t.DoneAt)
	}
	manualStatus := ""
	if manual {
		manualStatus, manualAt = t.ManualStatus, ms(*t.ManualAt)
	}
	if _, err := tx.ExecContext(ctx, `UPDATE topics SET title=?, summary=?, status=?, updated_at=?, done_at=?, manual_status=?, manual_at=?, detail=?, tasks=?, message_ids=? WHERE id=?`,
		t.Title, t.Summary, t.Status, updated, done, manualStatus, manualAt, t.Detail, jsonText(t.Tasks), jsonText(msgs), id); err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return s.GetTopic(ctx, id)
}

// LatestMessageID is the id of the thread's newest message ("" when it has none).
func (s *Store) LatestMessageID(ctx context.Context, threadID string) (string, error) {
	var id string
	err := s.db.QueryRowContext(ctx, `SELECT id FROM messages WHERE thread_id=? ORDER BY created_at DESC, rowid DESC LIMIT 1`, threadID).Scan(&id)
	if errors.Is(err, sql.ErrNoRows) {
		return "", nil
	}
	return id, err
}

func sameTasks(a, b []TopicTask) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

func sameStrings(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

// SetTopicStatus moves a topic to status by hand (the person dragged its card): the move is marked
// (manual_status, manual_at) until the agent sets the status again (UpdateTopic). done_at is set when
// it turns done (kept when it already was) and cleared otherwise; updated_at is bumped. It returns
// the topic with its thread's session id.
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
	ThreadID  string // "" = every thread
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
	if q.ThreadID != "" {
		where += ` AND tp.thread_id=?`
		args = append(args, q.ThreadID)
	}
	rows, err := s.db.QueryContext(ctx, `SELECT `+prefixed("tp.", topicCols)+`,
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

// GetTopic returns one topic with its thread's fields (as ListTopics fills them).
func (s *Store) GetTopic(ctx context.Context, id string) (*Topic, error) {
	var name, subject, sess, proj, projName string
	t, err := scanTopic(s.db.QueryRowContext(ctx, `SELECT `+prefixed("tp.", topicCols)+`, t.name, t.subject, t.session_id, COALESCE(s.project_id,''), COALESCE(p.name,'')
	  FROM topics tp JOIN threads t ON t.id=tp.thread_id JOIN sessions s ON s.id=t.session_id LEFT JOIN projects p ON p.id=s.project_id
	  WHERE tp.id=?`, id), &name, &subject, &sess, &proj, &projName)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	t.ThreadName, t.ThreadSubject, t.SessionID, t.ProjectID, t.ProjectName = name, subject, sess, proj, projName
	return t, nil
}

// TopicMessage is a message a topic relates to, as the topic pane lists it.
type TopicMessage struct {
	ID        string    `json:"id"`
	Author    string    `json:"author"`
	Kind      string    `json:"kind"`
	CreatedAt time.Time `json:"created_at"`
	// Text: the agent's body, or the person's own words (their body when they wrote none).
	Text string `json:"text"`
}

// TopicMessages returns the thread's messages among ids, in the thread's order (ids of other
// threads, or gone, are left out).
func (s *Store) TopicMessages(ctx context.Context, threadID string, ids []string) ([]TopicMessage, error) {
	out := []TopicMessage{}
	if len(ids) == 0 {
		return out, nil
	}
	want := map[string]bool{}
	for _, id := range ids {
		want[id] = true
	}
	rows, err := s.db.QueryContext(ctx, `SELECT id, author, kind, body, words, created_at FROM messages WHERE thread_id=? ORDER BY created_at, rowid`, threadID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var m TopicMessage
		var body, words string
		var created int64
		if err := rows.Scan(&m.ID, &m.Author, &m.Kind, &body, &words, &created); err != nil {
			return nil, err
		}
		if !want[m.ID] {
			continue
		}
		m.CreatedAt, m.Text = fromMs(created), body
		if m.Author == AuthorUser && strings.TrimSpace(words) != "" {
			m.Text = words
		}
		out = append(out, m)
	}
	return out, rows.Err()
}
