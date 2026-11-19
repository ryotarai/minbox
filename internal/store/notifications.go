package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"time"
)

// Destination is a place notifications go to. Config holds the type's settings including
// secrets (a webhook URL): it never goes to a client as it is, hence no JSON tag.
type Destination struct {
	ID        string
	Type      string
	Name      string
	Enabled   bool
	Config    map[string]any
	CreatedAt time.Time
	// The last delivery result: LastOKAt of the last success, LastError (and its time) of the
	// last failure, cleared by the next success.
	LastOKAt    *time.Time
	LastError   string
	LastErrorAt *time.Time
}

const destCols = `id, type, name, enabled, config, created_at, last_ok_at, last_error, last_error_at`

func scanDestination(row interface{ Scan(...any) error }) (*Destination, error) {
	var d Destination
	var cfg string
	var created int64
	var ok, errAt sql.NullInt64
	if err := row.Scan(&d.ID, &d.Type, &d.Name, &d.Enabled, &cfg, &created, &ok, &d.LastError, &errAt); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	d.Config = map[string]any{}
	_ = json.Unmarshal([]byte(cfg), &d.Config)
	d.CreatedAt = fromMs(created)
	d.LastOKAt, d.LastErrorAt = fromNullMs(ok), fromNullMs(errAt)
	return &d, nil
}

// ListDestinations lists the destinations, oldest first.
func (s *Store) ListDestinations(ctx context.Context) ([]Destination, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT `+destCols+` FROM notification_destinations ORDER BY created_at, rowid`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Destination{}
	for rows.Next() {
		d, err := scanDestination(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *d)
	}
	return out, rows.Err()
}

func (s *Store) GetDestination(ctx context.Context, id string) (*Destination, error) {
	return scanDestination(s.db.QueryRowContext(ctx, `SELECT `+destCols+` FROM notification_destinations WHERE id=?`, id))
}

// CreateDestination stores a new destination (ID and CreatedAt are filled in).
func (s *Store) CreateDestination(ctx context.Context, d *Destination) error {
	cfg, err := json.Marshal(d.Config)
	if err != nil {
		return err
	}
	d.ID, d.CreatedAt = NewID("dst"), s.now()
	_, err = s.db.ExecContext(ctx, `INSERT INTO notification_destinations(id,type,name,enabled,config,created_at) VALUES(?,?,?,?,?,?)`,
		d.ID, d.Type, d.Name, d.Enabled, string(cfg), ms(d.CreatedAt))
	return err
}

// UpdateDestination replaces name, enabled and config.
func (s *Store) UpdateDestination(ctx context.Context, d *Destination) error {
	cfg, err := json.Marshal(d.Config)
	if err != nil {
		return err
	}
	return s.exec(ctx, `UPDATE notification_destinations SET name=?, enabled=?, config=? WHERE id=?`, d.Name, d.Enabled, string(cfg), d.ID)
}

func (s *Store) DeleteDestination(ctx context.Context, id string) error {
	_, _ = s.db.ExecContext(ctx, `DELETE FROM notification_slack_threads WHERE destination_id=?`, id)
	_, _ = s.db.ExecContext(ctx, `DELETE FROM notification_slack_state WHERE destination_id=?`, id)
	_, _ = s.db.ExecContext(ctx, `DELETE FROM notification_slack_seen WHERE destination_id=?`, id)
	_, _ = s.db.ExecContext(ctx, `DELETE FROM notification_slack_pending WHERE destination_id=?`, id)
	return s.exec(ctx, `DELETE FROM notification_destinations WHERE id=?`, id)
}

// RecordDelivery stores the result of a send: errText "" is a success.
func (s *Store) RecordDelivery(ctx context.Context, id string, at time.Time, errText string) error {
	if errText == "" {
		return s.exec(ctx, `UPDATE notification_destinations SET last_ok_at=?, last_error='', last_error_at=NULL WHERE id=?`, ms(at), id)
	}
	return s.exec(ctx, `UPDATE notification_destinations SET last_error=?, last_error_at=? WHERE id=?`, errText, ms(at), id)
}

// SlackThread is the Slack message that parents the replies for one minbox thread.
type SlackThread struct {
	ChannelID string
	TS        string
}

// GetSlackThread finds the stored Slack parent of a minbox thread's messages that are about no task
// (ok=false when there is none).
func (s *Store) GetSlackThread(ctx context.Context, destID, threadID string) (SlackThread, bool, error) {
	var t SlackThread
	err := s.db.QueryRowContext(ctx, `SELECT channel_id, ts FROM notification_slack_threads WHERE destination_id=? AND minbox_thread_id=? AND task_id=''`, destID, threadID).Scan(&t.ChannelID, &t.TS)
	if errors.Is(err, sql.ErrNoRows) {
		return SlackThread{}, false, nil
	}
	return t, err == nil, err
}

// PutSlackThread stores (or replaces) the Slack parent of a minbox thread's messages that are about
// no task.
func (s *Store) PutSlackThread(ctx context.Context, destID, threadID string, t SlackThread) error {
	_, err := s.db.ExecContext(ctx, `INSERT OR REPLACE INTO notification_slack_threads(destination_id, minbox_thread_id, task_id, channel_id, ts, created_at, last_notified_at) VALUES(?,?,'',?,?,?,?)`,
		destID, threadID, t.ChannelID, t.TS, ms(s.now()), ms(s.now()))
	return err
}

// SlackTaskThread is the Slack thread of a task: its parent message, and the minbox thread (an
// agent's stream) the person's replies in it go to.
type SlackTaskThread struct {
	SlackThread
	ThreadID string
}

// GetSlackTaskThread finds the Slack thread of a task (ok=false when there is none).
func (s *Store) GetSlackTaskThread(ctx context.Context, destID, taskID string) (SlackTaskThread, bool, error) {
	var t SlackTaskThread
	if taskID == "" {
		return t, false, nil
	}
	err := s.db.QueryRowContext(ctx, `SELECT channel_id, ts, minbox_thread_id FROM notification_slack_threads WHERE destination_id=? AND task_id=?`, destID, taskID).Scan(&t.ChannelID, &t.TS, &t.ThreadID)
	if errors.Is(err, sql.ErrNoRows) {
		return SlackTaskThread{}, false, nil
	}
	return t, err == nil, err
}

// PutSlackTaskThread stores (or replaces) the Slack thread of a task; replies in it go to threadID.
func (s *Store) PutSlackTaskThread(ctx context.Context, destID, taskID, threadID string, t SlackThread) error {
	if taskID == "" {
		return errors.New("no task")
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err := tx.ExecContext(ctx, `DELETE FROM notification_slack_threads WHERE destination_id=? AND task_id=?`, destID, taskID); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO notification_slack_threads(destination_id, minbox_thread_id, task_id, channel_id, ts, created_at, last_notified_at) VALUES(?,?,?,?,?,?,?)`,
		destID, threadID, taskID, t.ChannelID, t.TS, ms(s.now()), ms(s.now())); err != nil {
		return err
	}
	return tx.Commit()
}

// TouchSlackTaskThread records that the task's Slack thread was notified now by the agent whose
// stream is threadID: the person's replies in it go there from now on.
func (s *Store) TouchSlackTaskThread(ctx context.Context, destID, taskID, threadID string) error {
	return s.exec2(ctx, `UPDATE notification_slack_threads SET last_notified_at=?, minbox_thread_id=? WHERE destination_id=? AND task_id=?`, ms(s.now()), threadID, destID, taskID)
}

// migrateSlackTaskThreads gives notification_slack_threads a task_id (a task's Slack thread): the
// primary key becomes (destination, minbox thread, task), so the table is rebuilt once; the rows
// of before are threads about no task (an empty task_id). One Slack thread per task and destination.
func migrateSlackTaskThreads(db *sql.DB) error {
	var n int
	if err := db.QueryRow(`SELECT count(*) FROM pragma_table_info('notification_slack_threads') WHERE name='task_id'`).Scan(&n); err != nil {
		return err
	}
	if n == 0 {
		tx, err := db.Begin()
		if err != nil {
			return err
		}
		defer tx.Rollback()
		for _, q := range []string{
			`CREATE TABLE notification_slack_threads_new (
  destination_id TEXT NOT NULL,
  minbox_thread_id TEXT NOT NULL,
  task_id TEXT NOT NULL DEFAULT '',
  channel_id TEXT NOT NULL,
  ts TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_notified_at INTEGER NOT NULL DEFAULT 0,
  reply_cursor TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (destination_id, minbox_thread_id, task_id)
)`,
			`INSERT INTO notification_slack_threads_new(destination_id, minbox_thread_id, task_id, channel_id, ts, created_at, last_notified_at, reply_cursor)
  SELECT destination_id, minbox_thread_id, '', channel_id, ts, created_at, last_notified_at, reply_cursor FROM notification_slack_threads ORDER BY rowid`,
			`DROP TABLE notification_slack_threads`,
			`ALTER TABLE notification_slack_threads_new RENAME TO notification_slack_threads`,
		} {
			if _, err := tx.Exec(q); err != nil {
				return err
			}
		}
		if err := tx.Commit(); err != nil {
			return err
		}
	}
	_, err := db.Exec(`CREATE UNIQUE INDEX IF NOT EXISTS notification_slack_threads_task ON notification_slack_threads(destination_id, task_id) WHERE task_id != ''`)
	return err
}

// DeleteSlackThreads forgets every Slack parent of a destination (its channel changed).
func (s *Store) DeleteSlackThreads(ctx context.Context, destID string) error {
	_, err := s.db.ExecContext(ctx, `DELETE FROM notification_slack_threads WHERE destination_id=?`, destID)
	return err
}
