package store

import (
	"context"
	"database/sql"
	"errors"
	"time"
)

// Thread commands: a person's message that starts with "!" is run as a shell command (see
// docs/thread-commands.md). The message (kind "command", author user) is stored already delivered:
// it is never delivered to the agent as a message of its own. The result lives in thread_commands
// and is carried to the agent in front of the thread's next delivered message (inject_message_id /
// delivered_at, the same one-place injection as linear_events), composed once at carry time.

const commandSchema = `
CREATE TABLE IF NOT EXISTS thread_commands (
  message_id TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
  thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  command TEXT NOT NULL,
  cwd TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL DEFAULT 'running',
  exit_code INTEGER NOT NULL DEFAULT 0,
  timed_out INTEGER NOT NULL DEFAULT 0,
  truncated INTEGER NOT NULL DEFAULT 0,
  error TEXT NOT NULL DEFAULT '',
  output TEXT NOT NULL DEFAULT '',
  duration_ms INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  inject_message_id TEXT NOT NULL DEFAULT '',
  delivered_at INTEGER
);
CREATE INDEX IF NOT EXISTS thread_commands_thread ON thread_commands(thread_id);
`

// Command states.
const (
	CommandRunning = "running"
	CommandDone    = "done"
)

// Command is the run of a "!" message.
type Command struct {
	MessageID  string `json:"message_id"`
	ThreadID   string `json:"-"`
	Command    string `json:"command"`
	Cwd        string `json:"cwd"`
	State      string `json:"state"`
	ExitCode   int    `json:"exit_code"`
	TimedOut   bool   `json:"timed_out"`
	Truncated  bool   `json:"truncated"`
	Error      string `json:"error,omitempty"` // could not start / interrupted
	Output     string `json:"output"`
	DurationMs int64  `json:"duration_ms"`
	// Told: the agent has the result (it rode along with a delivered message).
	Told      bool      `json:"told"`
	CreatedAt time.Time `json:"-"`
}

const commandCols = `message_id, thread_id, command, cwd, state, exit_code, timed_out, truncated, error, output, duration_ms, created_at, delivered_at IS NOT NULL`

func scanCommand(row interface{ Scan(...any) error }) (*Command, error) {
	var c Command
	var created int64
	if err := row.Scan(&c.MessageID, &c.ThreadID, &c.Command, &c.Cwd, &c.State, &c.ExitCode, &c.TimedOut, &c.Truncated, &c.Error, &c.Output, &c.DurationMs, &created, &c.Told); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	c.CreatedAt = fromMs(created)
	return &c, nil
}

// CreateCommandMessage adds the person's "!" message (already delivered) and its running command.
func (s *Store) CreateCommandMessage(ctx context.Context, threadID, command, cwd string) (*Message, error) {
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
	now := s.now()
	msg, err := insertMessage(ctx, tx, threadID, NewMessage{Author: AuthorUser, Body: "!" + command, Words: "!" + command, Kind: KindCommand, Delivered: true}, now)
	if err != nil {
		return nil, err
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO thread_commands(message_id, thread_id, command, cwd, state, created_at) VALUES(?,?,?,?,?,?)`,
		msg.ID, threadID, command, cwd, CommandRunning, ms(now)); err != nil {
		return nil, err
	}
	return msg, tx.Commit()
}

// FinishCommand records the result of a command.
func (s *Store) FinishCommand(ctx context.Context, c Command) error {
	return s.exec(ctx, `UPDATE thread_commands SET state=?, exit_code=?, timed_out=?, truncated=?, error=?, output=?, duration_ms=? WHERE message_id=? AND state=?`,
		CommandDone, c.ExitCode, c.TimedOut, c.Truncated, c.Error, c.Output, c.DurationMs, c.MessageID, CommandRunning)
}

// FailRunningCommands ends commands a restart of the server left running.
func (s *Store) FailRunningCommands(ctx context.Context) error {
	return s.exec(ctx, `UPDATE thread_commands SET state=?, exit_code=-1, error='interrupted: the server restarted while it ran' WHERE state=?`, CommandDone, CommandRunning)
}

// GetCommand returns the command of a message.
func (s *Store) GetCommand(ctx context.Context, messageID string) (*Command, error) {
	return scanCommand(s.db.QueryRowContext(ctx, `SELECT `+commandCols+` FROM thread_commands WHERE message_id=?`, messageID))
}

func (s *Store) commandsOfThread(ctx context.Context, threadID string) (map[string]*Command, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT `+commandCols+` FROM thread_commands WHERE thread_id=?`, threadID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]*Command{}
	for rows.Next() {
		c, err := scanCommand(rows)
		if err != nil {
			return nil, err
		}
		out[c.MessageID] = c
	}
	return out, rows.Err()
}

// AssignCommands ties the thread's finished, not-yet-told commands to the message that will carry
// them to the agent and returns them, oldest first. Idempotent while the message is pending; ones
// tied to a message that is gone are taken over.
func (s *Store) AssignCommands(ctx context.Context, threadID, messageID string) ([]Command, error) {
	if _, err := s.db.ExecContext(ctx, `UPDATE thread_commands SET inject_message_id=?
	  WHERE thread_id=? AND state=? AND delivered_at IS NULL AND (inject_message_id='' OR inject_message_id NOT IN (SELECT id FROM messages))`, messageID, threadID, CommandDone); err != nil {
		return nil, err
	}
	rows, err := s.db.QueryContext(ctx, `SELECT `+commandCols+` FROM thread_commands WHERE thread_id=? AND state=? AND delivered_at IS NULL AND inject_message_id=? ORDER BY created_at, rowid`, threadID, CommandDone, messageID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Command
	for rows.Next() {
		c, err := scanCommand(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *c)
	}
	return out, rows.Err()
}

func (s *Store) markCommandsDelivered(ctx context.Context, messageID string) error {
	_, err := s.db.ExecContext(ctx, `UPDATE thread_commands SET delivered_at=COALESCE(delivered_at, ?) WHERE inject_message_id=? AND delivered_at IS NULL`, ms(s.now()), messageID)
	return err
}
