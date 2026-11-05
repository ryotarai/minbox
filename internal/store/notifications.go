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

// GetSlackThread finds the stored Slack parent (ok=false when there is none).
func (s *Store) GetSlackThread(ctx context.Context, destID, threadID string) (SlackThread, bool, error) {
	var t SlackThread
	err := s.db.QueryRowContext(ctx, `SELECT channel_id, ts FROM notification_slack_threads WHERE destination_id=? AND minbox_thread_id=?`, destID, threadID).Scan(&t.ChannelID, &t.TS)
	if errors.Is(err, sql.ErrNoRows) {
		return SlackThread{}, false, nil
	}
	return t, err == nil, err
}

// PutSlackThread stores (or replaces) the Slack parent of a minbox thread.
func (s *Store) PutSlackThread(ctx context.Context, destID, threadID string, t SlackThread) error {
	_, err := s.db.ExecContext(ctx, `INSERT OR REPLACE INTO notification_slack_threads(destination_id, minbox_thread_id, channel_id, ts, created_at) VALUES(?,?,?,?,?)`,
		destID, threadID, t.ChannelID, t.TS, ms(s.now()))
	return err
}

// DeleteSlackThreads forgets every Slack parent of a destination (its channel changed).
func (s *Store) DeleteSlackThreads(ctx context.Context, destID string) error {
	_, err := s.db.ExecContext(ctx, `DELETE FROM notification_slack_threads WHERE destination_id=?`, destID)
	return err
}
