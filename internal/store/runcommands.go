package store

import (
	"context"
	"database/sql"
	"errors"
	"strings"
	"time"
)

// Commands an agent asks the person to run (send_message `commands`). They are stored with the
// agent's message, one row each, and run only after the person allows them from a paired browser
// (server: runcommands.go). Each one runs at most once: every step is a guarded state change.
//
//	pending → allowed → running → done
//	pending → denied
//
// When the commands the person decided on are finished, minbox sends the agent one message with
// their results (KindRunResult); Reported marks the commands that message carried.

const runCommandSchema = `
CREATE TABLE IF NOT EXISTS message_commands (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  thread_id TEXT NOT NULL,
  idx INTEGER NOT NULL,
  command TEXT NOT NULL,
  cwd TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL DEFAULT 'pending',
  exit_code INTEGER NOT NULL DEFAULT 0,
  timed_out INTEGER NOT NULL DEFAULT 0,
  truncated INTEGER NOT NULL DEFAULT 0,
  error TEXT NOT NULL DEFAULT '',
  output TEXT NOT NULL DEFAULT '',
  duration_ms INTEGER NOT NULL DEFAULT 0,
  decided_by TEXT NOT NULL DEFAULT '',
  decided_at INTEGER,
  finished_at INTEGER,
  result_message_id TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS message_commands_message ON message_commands(message_id);
CREATE INDEX IF NOT EXISTS message_commands_thread ON message_commands(thread_id);
`

// KindRunResult: minbox's message to the agent with the results of the commands it asked to run
// (a message from the person's side, delivered like theirs, shown as a small note).
const KindRunResult = "run_result"

// Run command states.
const (
	RunPending = "pending"
	RunAllowed = "allowed"
	RunDenied  = "denied"
	RunRunning = "running"
	RunDone    = "done"
)

// RunCommandSpec is a command as the agent asks for it.
type RunCommandSpec struct {
	Command     string
	Cwd         string
	Description string
}

// RunCommand is a command an agent asked the person to run, with its state and result.
type RunCommand struct {
	ID          string     `json:"id"`
	MessageID   string     `json:"message_id"`
	ThreadID    string     `json:"-"`
	Index       int        `json:"index"`
	Command     string     `json:"command"`
	Cwd         string     `json:"cwd"`
	Description string     `json:"description,omitempty"`
	State       string     `json:"state"`
	ExitCode    int        `json:"exit_code"`
	TimedOut    bool       `json:"timed_out"`
	Truncated   bool       `json:"truncated"`
	Error       string     `json:"error,omitempty"`
	Output      string     `json:"output"`
	DurationMs  int64      `json:"duration_ms"`
	DecidedBy   string     `json:"decided_by,omitempty"`
	DecidedAt   *time.Time `json:"decided_at,omitempty"`
	FinishedAt  *time.Time `json:"finished_at,omitempty"`
	// Reported: the agent was sent this command's result (in ResultMessageID).
	Reported        bool   `json:"reported"`
	ResultMessageID string `json:"result_message_id,omitempty"`
}

// Final: the command will not change any more (it ran, or the person denied it).
func (c *RunCommand) Final() bool { return c.State == RunDone || c.State == RunDenied }

const runCommandCols = `id, message_id, thread_id, idx, command, cwd, description, state, exit_code, timed_out, truncated, error, output, duration_ms, decided_by, decided_at, finished_at, result_message_id`

func scanRunCommand(row interface{ Scan(...any) error }) (*RunCommand, error) {
	var c RunCommand
	var decided, finished sql.NullInt64
	if err := row.Scan(&c.ID, &c.MessageID, &c.ThreadID, &c.Index, &c.Command, &c.Cwd, &c.Description, &c.State, &c.ExitCode, &c.TimedOut, &c.Truncated, &c.Error, &c.Output, &c.DurationMs, &c.DecidedBy, &decided, &finished, &c.ResultMessageID); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	c.DecidedAt, c.FinishedAt = fromNullMs(decided), fromNullMs(finished)
	c.Reported = c.ResultMessageID != ""
	return &c, nil
}

func insertRunCommands(ctx context.Context, tx *sql.Tx, msg *Message, specs []RunCommandSpec) error {
	for i, sp := range specs {
		c := RunCommand{ID: NewID("cmd"), MessageID: msg.ID, ThreadID: msg.ThreadID, Index: i, Command: sp.Command, Cwd: sp.Cwd, Description: sp.Description, State: RunPending}
		if _, err := tx.ExecContext(ctx, `INSERT INTO message_commands(id, message_id, thread_id, idx, command, cwd, description, state) VALUES(?,?,?,?,?,?,?,?)`,
			c.ID, c.MessageID, c.ThreadID, c.Index, c.Command, c.Cwd, c.Description, c.State); err != nil {
			return err
		}
		msg.RunCommands = append(msg.RunCommands, c)
	}
	return nil
}

func (s *Store) queryRunCommands(ctx context.Context, where string, args ...any) ([]RunCommand, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT `+runCommandCols+` FROM message_commands WHERE `+where+` ORDER BY message_id, idx`, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []RunCommand
	for rows.Next() {
		c, err := scanRunCommand(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *c)
	}
	return out, rows.Err()
}

// RunCommandsOf lists a message's commands in order.
func (s *Store) RunCommandsOf(ctx context.Context, messageID string) ([]RunCommand, error) {
	return s.queryRunCommands(ctx, `message_id=?`, messageID)
}

func (s *Store) runCommandsOfThread(ctx context.Context, threadID string) (map[string][]RunCommand, error) {
	cs, err := s.queryRunCommands(ctx, `thread_id=?`, threadID)
	if err != nil {
		return nil, err
	}
	out := map[string][]RunCommand{}
	for _, c := range cs {
		out[c.MessageID] = append(out[c.MessageID], c)
	}
	return out, nil
}

// DecideRunCommand moves a pending command of the message to allowed or denied, recording who
// decided. It answers false when the command is not pending (decided before: each command is
// decided once) or not the message's.
func (s *Store) DecideRunCommand(ctx context.Context, messageID, id string, allow bool, by string) (bool, error) {
	state := RunDenied
	if allow {
		state = RunAllowed
	}
	res, err := s.db.ExecContext(ctx, `UPDATE message_commands SET state=?, decided_by=?, decided_at=? WHERE id=? AND message_id=? AND state=?`,
		state, by, ms(s.now()), id, messageID, RunPending)
	if err != nil {
		return false, err
	}
	n, _ := res.RowsAffected()
	return n == 1, nil
}

// StartRunCommand moves an allowed command to running; false when it is not allowed (any more).
func (s *Store) StartRunCommand(ctx context.Context, id string) (bool, error) {
	res, err := s.db.ExecContext(ctx, `UPDATE message_commands SET state=? WHERE id=? AND state=?`, RunRunning, id, RunAllowed)
	if err != nil {
		return false, err
	}
	n, _ := res.RowsAffected()
	return n == 1, nil
}

// FinishRunCommand records the result of a running (or allowed, when it could not start) command.
func (s *Store) FinishRunCommand(ctx context.Context, c RunCommand) error {
	return s.exec(ctx, `UPDATE message_commands SET state=?, exit_code=?, timed_out=?, truncated=?, error=?, output=?, duration_ms=?, finished_at=? WHERE id=? AND state IN (?,?)`,
		RunDone, c.ExitCode, c.TimedOut, c.Truncated, c.Error, c.Output, c.DurationMs, ms(s.now()), c.ID, RunRunning, RunAllowed)
}

// MarkRunCommandsReported records that resultMessageID carried these commands' results.
func (s *Store) MarkRunCommandsReported(ctx context.Context, ids []string, resultMessageID string) error {
	if len(ids) == 0 {
		return nil
	}
	q := `UPDATE message_commands SET result_message_id=? WHERE result_message_id='' AND id IN (?` + strings.Repeat(",?", len(ids)-1) + `)`
	args := []any{resultMessageID}
	for _, id := range ids {
		args = append(args, id)
	}
	return s.exec(ctx, q, args...)
}

// FailRunningRunCommands ends commands a restart of the server left allowed or running.
func (s *Store) FailRunningRunCommands(ctx context.Context) error {
	_, err := s.db.ExecContext(ctx, `UPDATE message_commands SET state=?, exit_code=-1, error='interrupted: the server restarted before it finished', finished_at=? WHERE state IN (?,?)`,
		RunDone, ms(s.now()), RunRunning, RunAllowed)
	return err
}

// UnreportedRunCommands lists the messages whose decided commands are all final but not yet
// reported to the agent (after a restart), by message id.
func (s *Store) UnreportedRunCommands(ctx context.Context) ([]string, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT DISTINCT message_id FROM message_commands WHERE result_message_id='' AND state IN (?,?)`, RunDone, RunDenied)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		out = append(out, id)
	}
	return out, rows.Err()
}
