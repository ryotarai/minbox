// Package store keeps minbox's data (sessions, threads, messages) in SQLite3.
package store

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/ryotarai/minbox/internal/question"
	_ "modernc.org/sqlite"
)

// ErrNotFound is returned when a row does not exist.
var ErrNotFound = errors.New("not found")

// Session states.
const (
	StatusStarting = "starting" // PTY started, mod not connected yet
	StatusWorking  = "working"  // Claude is running a turn
	StatusIdle     = "idle"     // waiting for the person's input
	StatusEnded    = "ended"    // process exited (closed)

	KindClaude = "claude" // Claude Code with the minbox mod
	KindShell  = "shell"  // a plain login shell: a terminal, no inbox
)

// Message authors.
const (
	AuthorAgent = "agent"
	AuthorUser  = "user"
)

// Delivery states of the person's messages.
const (
	DeliveryQueued      = "queued"      // waiting for Claude to be idle
	DeliverySending     = "sending"     // claimed by the mod, being submitted
	DeliveryDelivered   = "delivered"   // Claude has it
	DeliveryUndelivered = "undelivered" // the session ended before it was delivered
)

// Thread statuses: what the thread is doing, set by the person's messages, the
// agent's send_message `status`, and by hand.
const (
	ThreadWorking    = "working"
	ThreadNeedAction = "need_action"
	ThreadFinished   = "finished"
)

// NormalizeThreadStatus maps a status (or an alias) to its canonical value.
func NormalizeThreadStatus(v string) (string, bool) {
	switch strings.ToLower(strings.TrimSpace(v)) {
	case "working", "in_progress", "in-progress", "inprogress":
		return ThreadWorking, true
	case "need_action", "needs_action", "need-action", "waiting":
		return ThreadNeedAction, true
	case "finished", "done", "complete", "completed":
		return ThreadFinished, true
	}
	return "", false
}

// Thread list sections, in the order the person should look at them.
const (
	SectionStopped  = "stopped" // an open question stops Claude's work
	SectionHolding  = "holding" // an open question holds up work
	SectionWaiting  = "waiting" // open questions or actions for the person
	SectionSent     = "sent"    // the person wrote last; waiting on Claude
	SectionNew      = "new"     // agent messages the person has not read
	SectionQuiet    = "quiet"
	SectionSnoozed  = "snoozed"
	SectionArchived = "archived"
)

// SectionOrder is the display order of sections.
var SectionOrder = []string{SectionStopped, SectionHolding, SectionWaiting, SectionSent, SectionNew, SectionQuiet, SectionSnoozed, SectionArchived}

func sectionRank(s string) int {
	for i, v := range SectionOrder {
		if v == s {
			return i
		}
	}
	return len(SectionOrder)
}

// Message kinds.
const (
	KindMessage = "message"
	KindNote    = "note" // a person's note (re-ask, thumbs up): not a reply
)

// Reasons an open question was closed unanswered.
const (
	ClosedMovedOn    = "moved_on"
	ClosedReplaced   = "replaced"
	ClosedMarkedRead = "marked_read"
	ClosedArchived   = "archived"
)

// UrgentAfter: a reply queued this long is delivered even into a busy session.
const UrgentAfter = 5 * time.Minute

// ClaimTimeout: a claim older than this, made by another mod instance, is stale.
const ClaimTimeout = 60 * time.Second

type Session struct {
	ID              string     `json:"id"`
	Name            string     `json:"name"`
	Cwd             string     `json:"cwd"`
	Status          string     `json:"status"`
	ClaudeSessionID string     `json:"claude_session_id"`
	Token           string     `json:"-"` // the mod's bearer token for this session
	ExitCode        *int       `json:"exit_code"`
	CreatedAt       time.Time  `json:"created_at"`
	UpdatedAt       time.Time  `json:"updated_at"`
	ArchivedAt      *time.Time `json:"archived_at"`
	HostID          string     `json:"host_id"`
	Kind            string     `json:"kind"`                // KindClaude or KindShell
	Title           string     `json:"title"`               // what Claude says the session is doing (set_session_title)
	HostName        string     `json:"host_name,omitempty"` // filled by the server
	ProjectID       string     `json:"project_id"`
	IsMain          bool       `json:"is_main"` // the project's main session
	// Derived.
	Unread        int    `json:"unread"`
	OpenQuestions int    `json:"open_questions"`
	Waiting       int    `json:"waiting"` // threads waiting on the person
	Section       string `json:"section"`
	Stopped       int    `json:"stopped"`
	Holding       int    `json:"holding"`
	Undelivered   int    `json:"undelivered"`
	// The mod's last call (any /api/agent/*, the long poll included); filled by the server, nil before the first one since it started.
	ModSeenAt *time.Time `json:"mod_seen_at"`
	// ModSilent: a Claude Code session whose mod has not called for a while (the server's modSilentAfter).
	ModSilent    bool       `json:"mod_silent"`
	LastActivity time.Time  `json:"last_activity"`
	TopThread    *TopThread `json:"top_thread"`
}

// TopThread is the thread a session row shows.
type TopThread struct {
	ID            string    `json:"id"`
	Status        string    `json:"status"`
	Subject       string    `json:"subject"`
	Section       string    `json:"section"`
	UpdatedAt     time.Time `json:"updated_at"`
	LastAuthor    string    `json:"last_author"`
	LastDelivery  string    `json:"last_delivery,omitempty"`
	OpenQuestions int       `json:"open_questions"`
	Stopped       bool      `json:"stopped"`
	HoldsUp       int       `json:"holds_up"`
}

type Thread struct {
	ID           string     `json:"id"`
	SessionID    string     `json:"session_id"`
	Subject      string     `json:"subject"`
	CreatedAt    time.Time  `json:"created_at"`
	UpdatedAt    time.Time  `json:"updated_at"`
	Messages     []Message  `json:"messages,omitempty"`
	Name         string     `json:"name"`
	ProjectID    string     `json:"project_id"`
	ProjectName  string     `json:"project_name"`
	ArchivedAt   *time.Time `json:"archived_at"`
	PinnedAt     *time.Time `json:"pinned_at"`
	SnoozedUntil *time.Time `json:"snoozed_until"`
	MarkedReadAt *time.Time `json:"marked_read_at"`
	// Status: working | need_action | finished (stored).
	Status string `json:"status"`
	// Derived.
	Unread          int        `json:"unread"`
	OpenQuestions   int        `json:"open_questions"`
	OpenActions     int        `json:"open_actions"`
	Section         string     `json:"section"`
	CameBack        bool       `json:"came_back"`
	Stopped         bool       `json:"stopped"`
	HoldsUp         int        `json:"holds_up"`
	MessageCount    int        `json:"message_count"`
	AttachmentCount int        `json:"attachment_count"`
	LastAgentAt     *time.Time `json:"last_agent_at"`
	LastBody        string     `json:"last_body"`
	LastAuthor      string     `json:"last_author"`
	LastDelivery    string     `json:"last_delivery,omitempty"` // when the person wrote last
	undelivered     int
}

type Message struct {
	ID       string `json:"id"`
	ThreadID string `json:"thread_id"`
	Author   string `json:"author"`
	// Body: an agent message's Markdown; for the person's message, the text
	// the agent reads (their words and the composed answers).
	Body string `json:"body"`
	// Words: the person's own words (their message without composed answers).
	Words     string              `json:"words,omitempty"`
	Questions []question.Question `json:"questions,omitempty"`
	// Answers given in this (person's) message, to the questions of AnswersFor.
	Answers     []question.Answer `json:"answers,omitempty"`
	AnswersFor  string            `json:"answers_for,omitempty"`
	CreatedAt   time.Time         `json:"created_at"`
	ReadAt      *time.Time        `json:"read_at"`
	ClaimedAt   *time.Time        `json:"claimed_at"`
	DeliveredAt *time.Time        `json:"delivered_at"`
	// Derived: on an agent message, the answers its questions got so far (by key);
	// on the person's message, its delivery state.
	AnswerState map[string]question.Answer `json:"answer_state,omitempty"`
	Delivery    string                     `json:"delivery,omitempty"`
	Kind        string                     `json:"kind"`
	Urgent      bool                       `json:"urgent"`
	Annotations []Annotation               `json:"annotations"`
	Attachments []Attachment               `json:"attachments"`
	// InlineImages: images the (agent's) body shows, captured at send.
	InlineImages []Attachment `json:"inline_images"`
	// Closed: open questions of this agent message closed unanswered, by key.
	Closed map[string]string `json:"closed,omitempty"`

	claimOwner string
}

// Annotation is the person's comment on an attachment, sent with a reply.
type Annotation struct {
	Kind         string            `json:"kind"` // comment | region | pen | video | element | diagram
	AttachmentID string            `json:"attachment_id,omitempty"`
	Version      string            `json:"version,omitempty"` // current | sent
	Name         string            `json:"name,omitempty"`
	Quote        string            `json:"quote,omitempty"` // the original text the comment is on
	LineStart    int               `json:"line_start,omitempty"`
	LineEnd      int               `json:"line_end,omitempty"`
	Line         int               `json:"line,omitempty"` // older drafts: one line
	Time         *float64          `json:"time,omitempty"` // video: seconds
	Comment      string            `json:"comment"`
	Images       []AnnotationImage `json:"images,omitempty"`
	ImagePath    string            `json:"image_path,omitempty"` // older drafts
	Region       *Region           `json:"region,omitempty"`
}

// AnnotationImage is a picture sent with a comment (a marked-up image, a video frame).
type AnnotationImage struct {
	Path string `json:"path"`
	Name string `json:"name"`
}

// Region is a box on an image, in the image's own pixels.
type Region struct {
	X        float64 `json:"x"`
	Y        float64 `json:"y"`
	W        float64 `json:"w"`
	H        float64 `json:"h"`
	NaturalW float64 `json:"natural_w"`
	NaturalH float64 `json:"natural_h"`
}

// Store wraps the SQLite database.
type Store struct {
	db  *sql.DB
	now func() time.Time
}

const schema = `
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  cwd TEXT NOT NULL,
  status TEXT NOT NULL,
  claude_session_id TEXT NOT NULL DEFAULT '',
  token TEXT NOT NULL DEFAULT '',
  exit_code INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS sessions_token ON sessions(token);
CREATE TABLE IF NOT EXISTS threads (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  subject TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS threads_session ON threads(session_id, updated_at);
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  author TEXT NOT NULL,
  body TEXT NOT NULL,
  words TEXT NOT NULL DEFAULT '',
  questions TEXT NOT NULL DEFAULT '[]',
  answers TEXT NOT NULL DEFAULT '[]',
  answers_for TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  read_at INTEGER,
  claimed_at INTEGER,
  claim_owner TEXT NOT NULL DEFAULT '',
  delivered_at INTEGER
);
CREATE INDEX IF NOT EXISTS messages_thread ON messages(thread_id, created_at);
CREATE TABLE IF NOT EXISTS attachments (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  path TEXT NOT NULL,
  mime TEXT NOT NULL DEFAULT '',
  size INTEGER NOT NULL DEFAULT 0,
  sha256 TEXT NOT NULL DEFAULT '',
  content BLOB,
  review TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS attachments_thread ON attachments(thread_id, created_at);
CREATE TABLE IF NOT EXISTS cards (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  col TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  session_id TEXT,
  thread_id TEXT,
  pr_url TEXT NOT NULL DEFAULT '',
  pr_state TEXT NOT NULL DEFAULT '',
  pr_number INTEGER NOT NULL DEFAULT 0,
  created_by TEXT NOT NULL,
  dropped_by TEXT NOT NULL DEFAULT '',
  position REAL NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS uploads (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  size INTEGER NOT NULL,
  type TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  mime TEXT NOT NULL DEFAULT '',
  width INTEGER NOT NULL DEFAULT 0,
  height INTEGER NOT NULL DEFAULT 0,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  search_text TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS hosts (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  url TEXT NOT NULL DEFAULT '',
  token TEXT NOT NULL DEFAULT '',
  builtin INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  dir TEXT NOT NULL,
  host_id TEXT NOT NULL DEFAULT 'local',
  created_at INTEGER NOT NULL,
  archived_at INTEGER,
  pinned_at INTEGER
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`

// columns added after the first release: table -> column -> definition.
var addedColumns = []struct{ table, column, def string }{
	{"sessions", "archived_at", "INTEGER"},
	{"sessions", "host_id", "TEXT NOT NULL DEFAULT 'local'"},
	{"sessions", "kind", "TEXT NOT NULL DEFAULT 'claude'"},
	{"sessions", "title", "TEXT NOT NULL DEFAULT ''"},
	{"sessions", "project_id", "TEXT"},
	{"projects", "main_session_id", "TEXT"},
	{"threads", "name", "TEXT NOT NULL DEFAULT ''"},
	{"threads", "archived_at", "INTEGER"},
	{"threads", "pinned_at", "INTEGER"},
	{"threads", "snoozed_until", "INTEGER"},
	{"threads", "marked_read_at", "INTEGER"},
	{"threads", "status", "TEXT"},
	{"messages", "kind", "TEXT NOT NULL DEFAULT 'message'"},
	{"messages", "urgent", "INTEGER NOT NULL DEFAULT 0"},
	{"messages", "annotations", "TEXT NOT NULL DEFAULT '[]'"},
	{"attachments", "type", "TEXT NOT NULL DEFAULT ''"},
	{"attachments", "author", "TEXT NOT NULL DEFAULT 'agent'"},
	{"attachments", "named_path", "TEXT NOT NULL DEFAULT ''"},
	{"attachments", "width", "INTEGER NOT NULL DEFAULT 0"},
	{"attachments", "height", "INTEGER NOT NULL DEFAULT 0"},
	{"attachments", "duration_ms", "INTEGER NOT NULL DEFAULT 0"},
	{"attachments", "sent_mtime", "INTEGER"},
	{"attachments", "inline", "INTEGER NOT NULL DEFAULT 0"},
	{"attachments", "ref", "TEXT NOT NULL DEFAULT ''"},
	{"attachments", "search_text", "TEXT NOT NULL DEFAULT ''"},
	{"hosts", "method", "TEXT NOT NULL DEFAULT 'direct'"},
	{"hosts", "tailscale_login", "TEXT NOT NULL DEFAULT ''"},
	{"hosts", "paired", "INTEGER NOT NULL DEFAULT 0"},
	{"hosts", "pairing_code", "TEXT NOT NULL DEFAULT ''"},
}

func migrate(db *sql.DB) error {
	if _, err := db.Exec(schema); err != nil {
		return err
	}
	for _, c := range addedColumns {
		rows, err := db.Query(`SELECT name FROM pragma_table_info(?)`, c.table)
		if err != nil {
			return err
		}
		has := false
		for rows.Next() {
			var n string
			if err := rows.Scan(&n); err != nil {
				rows.Close()
				return err
			}
			if n == c.column {
				has = true
			}
		}
		rows.Close()
		if !has {
			if _, err := db.Exec(fmt.Sprintf(`ALTER TABLE %s ADD COLUMN %s %s`, c.table, c.column, c.def)); err != nil {
				return err
			}
		}
	}
	if err := migrateProjects(context.Background(), db); err != nil {
		return fmt.Errorf("projects: %w", err)
	}
	if err := migrateThreadStatus(context.Background(), db); err != nil {
		return fmt.Errorf("thread status: %w", err)
	}
	// Hosts added with a shared token (before pairing) must be paired again.
	if _, err := db.Exec(`UPDATE hosts SET token='', paired=0, pairing_code='' WHERE builtin=0 AND token!=''`); err != nil {
		return err
	}
	return nil
}

// Open opens (and migrates) the database at path.
func Open(path string) (*Store, error) {
	dsn := "file:" + path + "?_pragma=foreign_keys(1)&_pragma=journal_mode(WAL)&_pragma=busy_timeout(5000)"
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	if err := migrate(db); err != nil {
		db.Close()
		return nil, fmt.Errorf("migrate: %w", err)
	}
	return &Store{db: db, now: time.Now}, nil
}

func (s *Store) Close() error { return s.db.Close() }

// NewID returns a random id with the given prefix.
func NewID(prefix string) string {
	b := make([]byte, 10)
	_, _ = rand.Read(b)
	return prefix + "_" + hex.EncodeToString(b)
}

func ms(t time.Time) int64 { return t.UnixMilli() }

func fromMs(v int64) time.Time { return time.UnixMilli(v) }

func fromNullMs(v sql.NullInt64) *time.Time {
	if !v.Valid {
		return nil
	}
	t := fromMs(v.Int64)
	return &t
}

func (s *Store) exec(ctx context.Context, q string, args ...any) error {
	res, err := s.db.ExecContext(ctx, q, args...)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	return nil
}

// ---- sessions ----

// CreateSession records a new session. claudeSessionID is the id Claude Code
// runs the conversation under (passed as --session-id, later --resume).
func (s *Store) CreateSession(ctx context.Context, name, cwd, claudeSessionID string) (*Session, error) {
	return s.CreateSessionOn(ctx, LocalHostID, name, cwd, claudeSessionID)
}

// CreateSessionOn records a new session on a host.
func (s *Store) CreateSessionOn(ctx context.Context, hostID, name, cwd, claudeSessionID string) (*Session, error) {
	return s.CreateSessionKind(ctx, hostID, KindClaude, name, cwd, claudeSessionID)
}

// CreateSessionKind records a new session of a kind (KindClaude or KindShell) on a host.
// Its project is the one for (host, cwd), created on first use.
func (s *Store) CreateSessionKind(ctx context.Context, hostID, kind, name, cwd, claudeSessionID string) (*Session, error) {
	if hostID == "" {
		hostID = LocalHostID
	}
	p, _, err := s.EnsureProject(ctx, hostID, cwd)
	if err != nil {
		return nil, err
	}
	return s.CreateSessionIn(ctx, p.ID, kind, name, cwd, claudeSessionID)
}

// CreateSessionIn records a new session in a project (on the project's host). cwd is where it
// runs: the project's dir, or a folder of the person's choosing.
func (s *Store) CreateSessionIn(ctx context.Context, projectID, kind, name, cwd, claudeSessionID string) (*Session, error) {
	if kind == "" {
		kind = KindClaude
	}
	p, err := s.GetProject(ctx, projectID)
	if err != nil {
		return nil, err
	}
	if cwd == "" {
		cwd = p.Dir
	}
	hostID := p.HostID
	now := s.now()
	sess := &Session{ID: NewID("ses"), Name: name, Cwd: cwd, Status: StatusStarting, ClaudeSessionID: claudeSessionID,
		Token: NewID("tok") + NewID(""), CreatedAt: now, UpdatedAt: now, HostID: hostID, Kind: kind, ProjectID: p.ID}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	if _, err := tx.ExecContext(ctx, `INSERT INTO sessions(id,name,cwd,status,claude_session_id,token,created_at,updated_at,host_id,kind,project_id) VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
		sess.ID, sess.Name, sess.Cwd, sess.Status, sess.ClaudeSessionID, sess.Token, ms(now), ms(now), hostID, kind, p.ID); err != nil {
		return nil, err
	}
	// A session in an archived project brings it back.
	if _, err := tx.ExecContext(ctx, `UPDATE projects SET archived_at=NULL WHERE id=?`, p.ID); err != nil {
		return nil, err
	}
	// The first Claude Code session of a project is its main one.
	if kind == KindClaude {
		if _, err := tx.ExecContext(ctx, `UPDATE projects SET main_session_id=? WHERE id=? AND (main_session_id IS NULL OR main_session_id='' OR main_session_id NOT IN (SELECT id FROM sessions))`, sess.ID, p.ID); err != nil {
			return nil, err
		}
		var main string
		_ = tx.QueryRowContext(ctx, `SELECT COALESCE(main_session_id,'') FROM projects WHERE id=?`, p.ID).Scan(&main)
		sess.IsMain = main == sess.ID
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return sess, nil
}

const sessionCols = `id, name, cwd, status, claude_session_id, token, exit_code, created_at, updated_at, archived_at, host_id, kind, title, COALESCE(project_id,''), EXISTS(SELECT 1 FROM projects p WHERE p.main_session_id=sessions.id)`

func scanSession(row interface{ Scan(...any) error }) (*Session, error) {
	var sess Session
	var exit, archived sql.NullInt64
	var created, updated int64
	if err := row.Scan(&sess.ID, &sess.Name, &sess.Cwd, &sess.Status, &sess.ClaudeSessionID, &sess.Token, &exit, &created, &updated, &archived, &sess.HostID, &sess.Kind, &sess.Title, &sess.ProjectID, &sess.IsMain); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	if exit.Valid {
		v := int(exit.Int64)
		sess.ExitCode = &v
	}
	sess.CreatedAt, sess.UpdatedAt = fromMs(created), fromMs(updated)
	sess.ArchivedAt = fromNullMs(archived)
	return &sess, nil
}

func (s *Store) addSessionCounts(ctx context.Context, sess *Session) error {
	threads, err := s.ListThreads(ctx, sess.ID)
	if err != nil {
		return err
	}
	deriveSession(sess, threads)
	return nil
}

// deriveSession fills a session's derived fields from its (derived) threads.
func deriveSession(sess *Session, threads []Thread) {
	SortThreads(threads)
	sess.LastActivity = sess.UpdatedAt
	for _, t := range threads {
		sess.Undelivered += t.undelivered
		if t.UpdatedAt.After(sess.LastActivity) {
			sess.LastActivity = t.UpdatedAt
		}
		switch t.Section {
		case SectionStopped, SectionHolding, SectionWaiting:
			sess.Waiting++
			sess.OpenQuestions += t.OpenQuestions
			if t.Section == SectionStopped {
				sess.Stopped++
			}
			if t.Section == SectionHolding {
				sess.Holding++
			}
		}
		if t.Section != SectionArchived && t.Section != SectionSnoozed {
			sess.Unread += t.Unread
			if sess.TopThread == nil {
				sess.TopThread = &TopThread{ID: t.ID, Status: t.Status, Subject: t.Subject, Section: t.Section, UpdatedAt: t.UpdatedAt,
					LastAuthor: t.LastAuthor, LastDelivery: t.LastDelivery, OpenQuestions: t.OpenQuestions, Stopped: t.Stopped, HoldsUp: t.HoldsUp}
			}
		}
	}
	switch {
	case sess.ArchivedAt != nil:
		sess.Section = SectionArchived
	case sess.TopThread != nil:
		sess.Section = sess.TopThread.Section
	default:
		sess.Section = SectionQuiet
	}
}

func (s *Store) GetSession(ctx context.Context, id string) (*Session, error) {
	sess, err := scanSession(s.db.QueryRowContext(ctx, `SELECT `+sessionCols+` FROM sessions WHERE id=?`, id))
	if err != nil {
		return nil, err
	}
	return sess, s.addSessionCounts(ctx, sess)
}

// SessionByToken finds the session a mod's bearer token belongs to.
func (s *Store) SessionByToken(ctx context.Context, token string) (*Session, error) {
	if token == "" {
		return nil, ErrNotFound
	}
	return scanSession(s.db.QueryRowContext(ctx, `SELECT `+sessionCols+` FROM sessions WHERE token=?`, token))
}

func (s *Store) ListSessions(ctx context.Context) ([]Session, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT `+sessionCols+` FROM sessions ORDER BY created_at DESC`)
	if err != nil {
		return nil, err
	}
	out := []Session{}
	for rows.Next() {
		sess, err := scanSession(rows)
		if err != nil {
			rows.Close()
			return nil, err
		}
		out = append(out, *sess)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	for i := range out {
		if err := s.addSessionCounts(ctx, &out[i]); err != nil {
			return nil, err
		}
	}
	return out, nil
}

func (s *Store) SetSessionStatus(ctx context.Context, id, status string) error {
	return s.exec(ctx, `UPDATE sessions SET status=?, updated_at=? WHERE id=?`, status, ms(s.now()), id)
}

func (s *Store) SetSessionEnded(ctx context.Context, id string, exitCode int) error {
	return s.exec(ctx, `UPDATE sessions SET status=?, exit_code=?, updated_at=? WHERE id=?`, StatusEnded, exitCode, ms(s.now()), id)
}

func (s *Store) SetClaudeSessionID(ctx context.Context, id, claudeID string) error {
	return s.exec(ctx, `UPDATE sessions SET claude_session_id=?, updated_at=? WHERE id=?`, claudeID, ms(s.now()), id)
}

func (s *Store) RenameSession(ctx context.Context, id, name string) error {
	return s.exec(ctx, `UPDATE sessions SET name=?, updated_at=? WHERE id=?`, name, ms(s.now()), id)
}

// SetSessionTitle records the session's title (Claude's own one-line summary).
func (s *Store) SetSessionTitle(ctx context.Context, id, title string) error {
	return s.exec(ctx, `UPDATE sessions SET title=?, updated_at=? WHERE id=?`, title, ms(s.now()), id)
}

// RestartSession marks an ended session as starting again (and unarchives it).
func (s *Store) RestartSession(ctx context.Context, id string) error {
	if err := s.exec(ctx, `UPDATE sessions SET status=?, exit_code=NULL, archived_at=NULL, updated_at=? WHERE id=?`, StatusStarting, ms(s.now()), id); err != nil {
		return err
	}
	return s.unarchiveProjectOf(ctx, id)
}

// SetSessionArchived archives or unarchives a session.
func (s *Store) SetSessionArchived(ctx context.Context, id string, archived bool) error {
	var v any
	if archived {
		v = ms(s.now())
	}
	if err := s.exec(ctx, `UPDATE sessions SET archived_at=? WHERE id=?`, v, id); err != nil {
		return err
	}
	if !archived {
		return s.unarchiveProjectOf(ctx, id)
	}
	return nil
}

func (s *Store) DeleteSession(ctx context.Context, id string) error {
	return s.exec(ctx, `DELETE FROM sessions WHERE id=?`, id)
}

// ---- threads & messages ----

// NewMessage is what a caller adds to a thread.
type NewMessage struct {
	Author      string
	Body        string
	Words       string
	Questions   []question.Question
	Answers     []question.Answer
	AnswersFor  string
	Kind        string // KindMessage when empty
	Urgent      bool
	Annotations []Annotation
	// Status: the thread's new status (canonical); empty keeps it (see statusAfter).
	Status string
}

// statusAfter is the thread's status after message m: the message's own
// status; else the person's message means working; else an agent message with
// questions needs action; else the status stays (cur).
func statusAfter(cur string, m NewMessage) string {
	switch {
	case m.Status != "":
		return m.Status
	case m.Author == AuthorUser && m.Kind != KindNote:
		return ThreadWorking
	case m.Author == AuthorAgent && len(m.Questions) > 0:
		return ThreadNeedAction
	}
	if cur == "" {
		return ThreadFinished
	}
	return cur
}

// CreateThread creates a thread with its first message.
func (s *Store) CreateThread(ctx context.Context, sessionID, subject string, m NewMessage) (*Thread, *Message, error) {
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
	if err := tx.Commit(); err != nil {
		return nil, nil, err
	}
	return th, msg, nil
}

func jsonOf(v any) string {
	b, _ := json.Marshal(v)
	if string(b) == "null" {
		return "[]"
	}
	return string(b)
}

func insertMessage(ctx context.Context, tx *sql.Tx, threadID string, m NewMessage, now time.Time) (*Message, error) {
	if m.Kind == "" {
		m.Kind = KindMessage
	}
	msg := &Message{ID: NewID("msg"), ThreadID: threadID, Author: m.Author, Body: m.Body, Words: m.Words,
		Questions: m.Questions, Answers: m.Answers, AnswersFor: m.AnswersFor, CreatedAt: now,
		Kind: m.Kind, Urgent: m.Urgent, Annotations: m.Annotations, Attachments: []Attachment{}, InlineImages: []Attachment{}}
	if msg.Annotations == nil {
		msg.Annotations = []Annotation{}
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO messages(id,thread_id,author,body,words,questions,answers,answers_for,created_at,kind,urgent,annotations) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
		msg.ID, threadID, m.Author, m.Body, m.Words, jsonOf(m.Questions), jsonOf(m.Answers), m.AnswersFor, ms(now), m.Kind, m.Urgent, jsonOf(m.Annotations)); err != nil {
		return nil, err
	}
	var cur sql.NullString
	if err := tx.QueryRowContext(ctx, `SELECT status FROM threads WHERE id=?`, threadID).Scan(&cur); err != nil {
		return nil, err
	}
	status := statusAfter(cur.String, m)
	q := `UPDATE threads SET updated_at=?, status=? WHERE id=?`
	if m.Author == AuthorUser {
		q = `UPDATE threads SET updated_at=?, status=?, snoozed_until=NULL WHERE id=?` // a reply ends a snooze
	}
	if _, err := tx.ExecContext(ctx, q, ms(now), status, threadID); err != nil {
		return nil, err
	}
	return msg, nil
}

// AddMessage appends a message to an existing thread.
func (s *Store) AddMessage(ctx context.Context, threadID string, m NewMessage) (*Message, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	var one int
	if err := tx.QueryRowContext(ctx, `SELECT 1 FROM threads WHERE id=?`, threadID).Scan(&one); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	msg, err := insertMessage(ctx, tx, threadID, m, s.now())
	if err != nil {
		return nil, err
	}
	return msg, tx.Commit()
}

const messageCols = `id, thread_id, author, body, words, questions, answers, answers_for, created_at, read_at, claimed_at, claim_owner, delivered_at, kind, urgent, annotations`

func scanMessage(row interface{ Scan(...any) error }) (*Message, error) {
	var m Message
	var qs, as, ann string
	var created int64
	var read, claimed, delivered sql.NullInt64
	if err := row.Scan(&m.ID, &m.ThreadID, &m.Author, &m.Body, &m.Words, &qs, &as, &m.AnswersFor, &created, &read, &claimed, &m.claimOwner, &delivered, &m.Kind, &m.Urgent, &ann); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	_ = json.Unmarshal([]byte(qs), &m.Questions)
	_ = json.Unmarshal([]byte(as), &m.Answers)
	_ = json.Unmarshal([]byte(ann), &m.Annotations)
	if m.Annotations == nil {
		m.Annotations = []Annotation{}
	}
	m.Attachments = []Attachment{}
	m.InlineImages = []Attachment{}
	if len(m.Questions) == 0 {
		m.Questions = nil
	}
	if len(m.Answers) == 0 {
		m.Answers = nil
	}
	m.CreatedAt = fromMs(created)
	m.ReadAt, m.ClaimedAt, m.DeliveredAt = fromNullMs(read), fromNullMs(claimed), fromNullMs(delivered)
	return &m, nil
}

func (s *Store) loadThreads(ctx context.Context, where string, args ...any) ([]Thread, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT t.id, t.session_id, t.subject, t.created_at, t.updated_at, s.status,
	  t.name, t.archived_at, t.pinned_at, t.snoozed_until, t.marked_read_at, COALESCE(s.project_id,''), COALESCE(p.name,''), COALESCE(t.status,'')
	  FROM threads t JOIN sessions s ON s.id=t.session_id LEFT JOIN projects p ON p.id=s.project_id WHERE `+where+` ORDER BY t.updated_at DESC`, args...)
	if err != nil {
		return nil, err
	}
	var threads []Thread
	status := map[string]string{}
	for rows.Next() {
		var t Thread
		var created, updated int64
		var st string
		var archived, pinned, snoozed, marked sql.NullInt64
		if err := rows.Scan(&t.ID, &t.SessionID, &t.Subject, &created, &updated, &st, &t.Name, &archived, &pinned, &snoozed, &marked, &t.ProjectID, &t.ProjectName, &t.Status); err != nil {
			rows.Close()
			return nil, err
		}
		t.CreatedAt, t.UpdatedAt = fromMs(created), fromMs(updated)
		t.ArchivedAt, t.PinnedAt, t.SnoozedUntil, t.MarkedReadAt = fromNullMs(archived), fromNullMs(pinned), fromNullMs(snoozed), fromNullMs(marked)
		status[t.ID] = st
		threads = append(threads, t)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	for i := range threads {
		mrows, err := s.db.QueryContext(ctx, `SELECT `+messageCols+` FROM messages WHERE thread_id=? ORDER BY created_at, rowid`, threads[i].ID)
		if err != nil {
			return nil, err
		}
		for mrows.Next() {
			m, err := scanMessage(mrows)
			if err != nil {
				mrows.Close()
				return nil, err
			}
			threads[i].Messages = append(threads[i].Messages, *m)
		}
		mrows.Close()
		atts, err := s.ListAttachments(ctx, threads[i].ID)
		if err != nil {
			return nil, err
		}
		count := 0
		for _, a := range atts {
			if !a.Inline {
				count++
			}
			for j := range threads[i].Messages {
				m := &threads[i].Messages[j]
				if m.ID != a.MessageID {
					continue
				}
				if a.Inline {
					m.InlineImages = append(m.InlineImages, a)
				} else {
					m.Attachments = append(m.Attachments, a)
				}
			}
		}
		threads[i].AttachmentCount = count
		derive(&threads[i], status[threads[i].ID], s.now())
	}
	if threads == nil {
		threads = []Thread{}
	}
	return threads, nil
}

// derive fills the thread's and its messages' derived fields.
func derive(t *Thread, sessionStatus string, now time.Time) {
	// Answers each agent message's questions got, from later messages of the person.
	state := map[string]map[string]question.Answer{}
	for _, m := range t.Messages {
		if m.Author == AuthorUser && m.AnswersFor != "" {
			if state[m.AnswersFor] == nil {
				state[m.AnswersFor] = map[string]question.Answer{}
			}
			for _, a := range m.Answers {
				state[m.AnswersFor][a.Key] = a
			}
		}
	}
	// Prompts later questions say they replace.
	replaced := map[string]bool{}
	for _, m := range t.Messages {
		for _, q := range m.Questions {
			if q.Replaces != "" {
				replaced[normPrompt(q.Replaces)] = true
			}
		}
	}
	lastAgent := -1
	t.MessageCount = len(t.Messages)
	for i := range t.Messages {
		m := &t.Messages[i]
		switch m.Author {
		case AuthorAgent:
			lastAgent = i
			m.AnswerState = state[m.ID]
			if m.ReadAt == nil {
				t.Unread++
			}
			if t.ArchivedAt != nil && m.CreatedAt.After(*t.ArchivedAt) {
				t.CameBack = true
			}
			at := m.CreatedAt
			t.LastAgentAt = &at
		case AuthorUser:
			m.Delivery = deliveryOf(m, sessionStatus)
			if m.DeliveredAt == nil {
				t.undelivered++
			}
		}
	}
	archived := t.ArchivedAt != nil && !t.CameBack
	markedRead := t.MarkedReadAt != nil && (t.LastAgentAt == nil || !t.MarkedReadAt.Before(*t.LastAgentAt))
	for i := range t.Messages {
		m := &t.Messages[i]
		if m.Author != AuthorAgent || len(m.Questions) == 0 {
			continue
		}
		for _, q := range m.Questions {
			if q.Kind != question.Text && q.Kind != question.Action && allSettled(q) {
				continue
			}
			if a, ok := m.AnswerState[q.Key]; ok && !a.Empty() {
				continue
			}
			reason := ""
			switch {
			case replaced[normPrompt(q.Prompt)] && q.Replaces == "":
				reason = ClosedReplaced
			case i != lastAgent:
				reason = ClosedMovedOn
			case markedRead:
				reason = ClosedMarkedRead
			case archived:
				reason = ClosedArchived
			}
			if reason != "" {
				if m.Closed == nil {
					m.Closed = map[string]string{}
				}
				m.Closed[q.Key] = reason
				continue
			}
			// Open.
			if q.Kind == question.Action {
				t.OpenActions++
			} else {
				t.OpenQuestions++
				t.HoldsUp += len(q.HoldsUp)
			}
			if q.Stopped != "" {
				t.Stopped = true
			}
		}
	}
	if n := len(t.Messages); n > 0 {
		last := t.Messages[n-1]
		t.LastAuthor = last.Author
		t.LastBody = last.Body
		if last.Author == AuthorUser {
			if last.Words != "" || len(last.Answers) > 0 {
				t.LastBody = last.Words
			}
			t.LastDelivery = last.Delivery
		}
	}
	switch {
	case archived:
		t.Section = SectionArchived
	case t.SnoozedUntil != nil && t.SnoozedUntil.After(now):
		t.Section = SectionSnoozed
	case markedRead:
		t.Section = SectionQuiet
	case t.Status == ThreadNeedAction && t.Stopped:
		t.Section = SectionStopped
	case t.Status == ThreadNeedAction && t.HoldsUp > 0:
		t.Section = SectionHolding
	case t.Status == ThreadNeedAction:
		t.Section = SectionWaiting
	case t.Unread > 0:
		t.Section = SectionNew
	case t.LastAuthor == AuthorUser:
		t.Section = SectionSent
	default:
		t.Section = SectionQuiet
	}
}

func normPrompt(p string) string {
	return strings.Join(strings.Fields(strings.ToLower(strings.TrimSpace(p))), " ")
}

func allSettled(q question.Question) bool {
	if len(q.Choices) == 0 {
		return false
	}
	for _, c := range q.Choices {
		if c.Settled {
			return true
		}
	}
	return false
}

func deliveryOf(m *Message, sessionStatus string) string {
	switch {
	case m.DeliveredAt != nil:
		return DeliveryDelivered
	case sessionStatus == StatusEnded:
		return DeliveryUndelivered
	case m.ClaimedAt != nil:
		return DeliverySending
	default:
		return DeliveryQueued
	}
}

// SetThreadStatus sets a thread's status; status must be canonical.
func (s *Store) SetThreadStatus(ctx context.Context, id, status string) error {
	v, ok := NormalizeThreadStatus(status)
	if !ok {
		return fmt.Errorf("unknown status %q (working, need_action or finished)", status)
	}
	return s.exec(ctx, `UPDATE threads SET status=? WHERE id=?`, v, id)
}

// migrateThreadStatus gives threads without a status one: need_action when a
// question or action is open, else finished. Idempotent: only NULL rows.
func migrateThreadStatus(ctx context.Context, db *sql.DB) error {
	s := &Store{db: db, now: time.Now}
	threads, err := s.loadThreads(ctx, `t.status IS NULL`)
	if err != nil {
		return err
	}
	for _, t := range threads {
		v := ThreadFinished
		if t.OpenQuestions > 0 || t.OpenActions > 0 {
			v = ThreadNeedAction
		}
		if _, err := db.ExecContext(ctx, `UPDATE threads SET status=? WHERE id=?`, v, t.ID); err != nil {
			return err
		}
	}
	return nil
}

// ListThreads lists a session's threads (with messages and derived state), newest first.
func (s *Store) ListThreads(ctx context.Context, sessionID string) ([]Thread, error) {
	return s.loadThreads(ctx, `t.session_id=?`, sessionID)
}

// ListAllThreads returns every thread of every session that is not archived.
func (s *Store) ListAllThreads(ctx context.Context) ([]Thread, error) {
	return s.loadThreads(ctx, `s.archived_at IS NULL`)
}

// GetThread returns the thread with all its messages.
func (s *Store) GetThread(ctx context.Context, id string) (*Thread, error) {
	threads, err := s.loadThreads(ctx, `t.id=?`, id)
	if err != nil {
		return nil, err
	}
	if len(threads) == 0 {
		return nil, ErrNotFound
	}
	return &threads[0], nil
}

// GetMessage returns one message.
func (s *Store) GetMessage(ctx context.Context, id string) (*Message, error) {
	return scanMessage(s.db.QueryRowContext(ctx, `SELECT `+messageCols+` FROM messages WHERE id=?`, id))
}

// MarkThreadRead marks every agent message in the thread as read.
func (s *Store) MarkThreadRead(ctx context.Context, threadID string) (int64, error) {
	res, err := s.db.ExecContext(ctx, `UPDATE messages SET read_at=? WHERE thread_id=? AND author='agent' AND read_at IS NULL`, ms(s.now()), threadID)
	if err != nil {
		return 0, err
	}
	return res.RowsAffected()
}

// MarkThreadUnread marks the thread's latest agent message unread again
// (and takes back a Mark read).
func (s *Store) MarkThreadUnread(ctx context.Context, threadID string) error {
	if _, err := s.db.ExecContext(ctx, `UPDATE threads SET marked_read_at=NULL WHERE id=?`, threadID); err != nil {
		return err
	}
	_, err := s.db.ExecContext(ctx, `UPDATE messages SET read_at=NULL WHERE id=(SELECT id FROM messages WHERE thread_id=? AND author='agent' ORDER BY created_at DESC, rowid DESC LIMIT 1)`, threadID)
	return err
}

// SetAside is Mark read: the thread moves to Quiet, its open questions close.
func (s *Store) SetAside(ctx context.Context, threadID string) error {
	if err := s.exec(ctx, `UPDATE threads SET marked_read_at=?, snoozed_until=NULL WHERE id=?`, ms(s.now()), threadID); err != nil {
		return err
	}
	_, err := s.MarkThreadRead(ctx, threadID)
	return err
}

// UndoSetAside takes back a Mark read.
func (s *Store) UndoSetAside(ctx context.Context, threadID string) error {
	return s.exec(ctx, `UPDATE threads SET marked_read_at=NULL WHERE id=?`, threadID)
}

func (s *Store) nowOrNull(on bool) any {
	if on {
		return ms(s.now())
	}
	return nil
}

// SetThreadArchived archives (and unsnoozes) or unarchives a thread.
func (s *Store) SetThreadArchived(ctx context.Context, threadID string, archived bool) error {
	if archived {
		return s.exec(ctx, `UPDATE threads SET archived_at=?, snoozed_until=NULL WHERE id=?`, ms(s.now()), threadID)
	}
	return s.exec(ctx, `UPDATE threads SET archived_at=NULL WHERE id=?`, threadID)
}

// SetThreadPinned pins or unpins a thread.
func (s *Store) SetThreadPinned(ctx context.Context, threadID string, pinned bool) error {
	return s.exec(ctx, `UPDATE threads SET pinned_at=? WHERE id=?`, s.nowOrNull(pinned), threadID)
}

// SnoozeThread hides a thread until the time; nil wakes it.
func (s *Store) SnoozeThread(ctx context.Context, threadID string, until *time.Time) error {
	var v any
	if until != nil {
		v = ms(*until)
	}
	return s.exec(ctx, `UPDATE threads SET snoozed_until=? WHERE id=?`, v, threadID)
}

// UpdateThread renames a thread or its name tag (nil leaves a field).
func (s *Store) UpdateThread(ctx context.Context, threadID string, subject, name *string) error {
	if subject != nil {
		if err := s.exec(ctx, `UPDATE threads SET subject=? WHERE id=?`, *subject, threadID); err != nil {
			return err
		}
	}
	if name != nil {
		if err := s.exec(ctx, `UPDATE threads SET name=? WHERE id=?`, *name, threadID); err != nil {
			return err
		}
	}
	return nil
}

// SetUrgent marks the person's undelivered message for delivery even into a busy session.
func (s *Store) SetUrgent(ctx context.Context, messageID string) error {
	return s.exec(ctx, `UPDATE messages SET urgent=1 WHERE id=? AND author='user' AND delivered_at IS NULL`, messageID)
}

// CancelMessage deletes the person's message while it is still queued: not
// delivered, and not claimed by a mod instance that may be submitting it right
// now. ErrNotFound when it is gone, not the person's, delivered or in flight.
// A thread left without messages (the person started it) is deleted too.
func (s *Store) CancelMessage(ctx context.Context, messageID string) (threadDeleted bool, err error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return false, err
	}
	defer tx.Rollback()
	var threadID string
	err = tx.QueryRowContext(ctx, `SELECT thread_id FROM messages WHERE id=? AND author='user' AND delivered_at IS NULL
	  AND (claimed_at IS NULL OR claimed_at<?)`, messageID, ms(s.now().Add(-ClaimTimeout))).Scan(&threadID)
	if errors.Is(err, sql.ErrNoRows) {
		return false, ErrNotFound
	}
	if err != nil {
		return false, err
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM messages WHERE id=?`, messageID); err != nil {
		return false, err
	}
	var left int
	if err := tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM messages WHERE thread_id=?`, threadID).Scan(&left); err != nil {
		return false, err
	}
	if left == 0 {
		if _, err := tx.ExecContext(ctx, `DELETE FROM threads WHERE id=?`, threadID); err != nil {
			return false, err
		}
		threadDeleted = true
	}
	return threadDeleted, tx.Commit()
}

// PendingDelivery is a message of the person waiting to be delivered to the agent.
type PendingDelivery struct {
	Message
	Subject   string `json:"subject"`
	NewThread bool   `json:"new_thread"` // the person started this thread
	// The agent message the person answered (the latest one before this message).
	InReplyTo *Message `json:"in_reply_to,omitempty"`
}

// PendingForSession lists the person's undelivered messages of the session,
// oldest first, leaving out those another mod instance claimed recently.
func (s *Store) PendingForSession(ctx context.Context, sessionID, owner string) ([]PendingDelivery, error) {
	stale := ms(s.now().Add(-ClaimTimeout))
	rows, err := s.db.QueryContext(ctx, `SELECT m.id, t.subject FROM messages m JOIN threads t ON t.id=m.thread_id
	  WHERE t.session_id=? AND m.author='user' AND m.delivered_at IS NULL
	    AND (m.claimed_at IS NULL OR (m.claim_owner!=? AND m.claimed_at<?))
	  ORDER BY m.created_at, m.rowid`, sessionID, owner, stale)
	if err != nil {
		return nil, err
	}
	type idSubj struct{ id, subject string }
	var ids []idSubj
	for rows.Next() {
		var v idSubj
		if err := rows.Scan(&v.id, &v.subject); err != nil {
			rows.Close()
			return nil, err
		}
		ids = append(ids, v)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	out := []PendingDelivery{}
	for _, v := range ids {
		m, err := s.GetMessage(ctx, v.id)
		if err != nil {
			return nil, err
		}
		p := PendingDelivery{Message: *m, Subject: v.subject}
		// Urgent: delivered even while Claude is busy (Send now, or queued long).
		p.Urgent = m.Urgent || s.now().Sub(m.CreatedAt) >= UrgentAfter
		prev, err := scanMessage(s.db.QueryRowContext(ctx, `SELECT `+messageCols+` FROM messages
		  WHERE thread_id=? AND author='agent' AND (created_at<? OR (created_at=? AND rowid<(SELECT rowid FROM messages WHERE id=?)))
		  ORDER BY created_at DESC, rowid DESC LIMIT 1`, m.ThreadID, ms(m.CreatedAt), ms(m.CreatedAt), m.ID))
		switch {
		case err == nil:
			p.InReplyTo = prev
		case errors.Is(err, ErrNotFound):
			var agents int
			_ = s.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM messages WHERE thread_id=? AND author='agent'`, m.ThreadID).Scan(&agents)
			p.NewThread = agents == 0
		default:
			return nil, err
		}
		out = append(out, p)
	}
	return out, nil
}

// Claim marks the person's message as being delivered by the mod instance
// owner. It fails when it is delivered, or claimed by someone else recently.
func (s *Store) Claim(ctx context.Context, sessionID, messageID, owner string) (bool, error) {
	now := s.now()
	res, err := s.db.ExecContext(ctx, `UPDATE messages SET claimed_at=?, claim_owner=? WHERE id=? AND author='user' AND delivered_at IS NULL
	  AND (claimed_at IS NULL OR claim_owner=? OR claimed_at<?)
	  AND thread_id IN (SELECT id FROM threads WHERE session_id=?)`, ms(now), owner, messageID, owner, ms(now.Add(-ClaimTimeout)), sessionID)
	if err != nil {
		return false, err
	}
	n, _ := res.RowsAffected()
	return n > 0, nil
}

// Release undoes a claim (the mod could not submit the message).
func (s *Store) Release(ctx context.Context, sessionID, messageID, owner string) (bool, error) {
	res, err := s.db.ExecContext(ctx, `UPDATE messages SET claimed_at=NULL, claim_owner='' WHERE id=? AND author='user' AND delivered_at IS NULL AND claim_owner=?
	  AND thread_id IN (SELECT id FROM threads WHERE session_id=?)`, messageID, owner, sessionID)
	if err != nil {
		return false, err
	}
	n, _ := res.RowsAffected()
	return n > 0, nil
}

// MarkDelivered records that the agent got the message (after the submit).
// It is idempotent; false when the message is not the session's.
func (s *Store) MarkDelivered(ctx context.Context, sessionID, messageID string) (bool, error) {
	res, err := s.db.ExecContext(ctx, `UPDATE messages SET delivered_at=COALESCE(delivered_at, ?) WHERE id=? AND author='user'
	  AND thread_id IN (SELECT id FROM threads WHERE session_id=?)`, ms(s.now()), messageID, sessionID)
	if err != nil {
		return false, err
	}
	n, _ := res.RowsAffected()
	return n > 0, nil
}

// ThreadOfMessage returns the thread id a message belongs to.
func (s *Store) ThreadOfMessage(ctx context.Context, messageID string) (string, error) {
	var id string
	err := s.db.QueryRowContext(ctx, `SELECT thread_id FROM messages WHERE id=?`, messageID).Scan(&id)
	if errors.Is(err, sql.ErrNoRows) {
		return "", ErrNotFound
	}
	return id, err
}

// SortThreads orders threads by section, pinned first, then newest first.
func SortThreads(threads []Thread) {
	sort.SliceStable(threads, func(i, j int) bool {
		ri, rj := sectionRank(threads[i].Section), sectionRank(threads[j].Section)
		if ri != rj {
			return ri < rj
		}
		pi, pj := threads[i].PinnedAt != nil, threads[j].PinnedAt != nil
		if pi != pj {
			return pi
		}
		return threads[i].UpdatedAt.After(threads[j].UpdatedAt)
	})
}
