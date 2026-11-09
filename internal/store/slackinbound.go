package store

import (
	"context"
	"database/sql"
	"errors"
	"time"
)

// State for receiving messages from Slack (polling): per-thread reply cursors, per-destination
// key/value state (the DM channel, the DM cursor, when receiving started) and the set of Slack
// messages already delivered (so one is delivered at most once).

// SlackThreadRef is a Slack thread of a destination with its poll state.
type SlackThreadRef struct {
	ThreadID     string
	ChannelID    string
	TS           string // the parent's ts
	ReplyCursor  string // latest reply ts handled ("" none)
	LastNotified time.Time
}

func (s *Store) exec2(ctx context.Context, q string, args ...any) error {
	_, err := s.db.ExecContext(ctx, q, args...)
	return err
}

// TouchSlackThread records that the thread was notified now (it is polled for replies for a while).
func (s *Store) TouchSlackThread(ctx context.Context, destID, threadID string) error {
	return s.exec2(ctx, `UPDATE notification_slack_threads SET last_notified_at=? WHERE destination_id=? AND minbox_thread_id=?`, ms(s.now()), destID, threadID)
}

// RecentSlackThreads lists the destination's Slack threads notified since `since`, most recent first.
func (s *Store) RecentSlackThreads(ctx context.Context, destID string, since time.Time, limit int) ([]SlackThreadRef, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT minbox_thread_id, channel_id, ts, reply_cursor, last_notified_at FROM notification_slack_threads
		WHERE destination_id=? AND last_notified_at>=? ORDER BY last_notified_at DESC, rowid DESC LIMIT ?`, destID, ms(since), limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []SlackThreadRef{}
	for rows.Next() {
		var r SlackThreadRef
		var at int64
		if err := rows.Scan(&r.ThreadID, &r.ChannelID, &r.TS, &r.ReplyCursor, &at); err != nil {
			return nil, err
		}
		r.LastNotified = fromMs(at)
		out = append(out, r)
	}
	return out, rows.Err()
}

// SetSlackReplyCursor stores the latest reply ts handled in a thread.
func (s *Store) SetSlackReplyCursor(ctx context.Context, destID, threadID, ts string) error {
	return s.exec2(ctx, `UPDATE notification_slack_threads SET reply_cursor=? WHERE destination_id=? AND minbox_thread_id=?`, ts, destID, threadID)
}

// GetSlackState reads a state value ("" when unset).
func (s *Store) GetSlackState(ctx context.Context, destID, key string) (string, error) {
	var v string
	err := s.db.QueryRowContext(ctx, `SELECT value FROM notification_slack_state WHERE destination_id=? AND key=?`, destID, key).Scan(&v)
	if errors.Is(err, sql.ErrNoRows) {
		return "", nil
	}
	return v, err
}

// SetSlackState stores a state value.
func (s *Store) SetSlackState(ctx context.Context, destID, key, value string) error {
	return s.exec2(ctx, `INSERT OR REPLACE INTO notification_slack_state(destination_id, key, value) VALUES(?,?,?)`, destID, key, value)
}

// MarkSlackSeen records a Slack message as taken; false when it already was (deliver nothing).
func (s *Store) MarkSlackSeen(ctx context.Context, destID, channelID, ts string) (bool, error) {
	res, err := s.db.ExecContext(ctx, `INSERT OR IGNORE INTO notification_slack_seen(destination_id, channel_id, ts, at) VALUES(?,?,?,?)`, destID, channelID, ts, ms(s.now()))
	if err != nil {
		return false, err
	}
	n, _ := res.RowsAffected()
	return n > 0, nil
}

// UnmarkSlackSeen releases a message whose delivery failed, so it is tried again.
func (s *Store) UnmarkSlackSeen(ctx context.Context, destID, channelID, ts string) error {
	return s.exec2(ctx, `DELETE FROM notification_slack_seen WHERE destination_id=? AND channel_id=? AND ts=?`, destID, channelID, ts)
}

// PruneSlackSeen forgets messages taken before `before` (the cursors keep them from coming back).
func (s *Store) PruneSlackSeen(ctx context.Context, before time.Time) error {
	return s.exec2(ctx, `DELETE FROM notification_slack_seen WHERE at<?`, ms(before))
}

// ResetSlackInbound forgets the receive state of a destination (its token or channel changed,
// or receiving was switched off); cursors start again from "now" when it is on.
func (s *Store) ResetSlackInbound(ctx context.Context, destID string) error {
	if err := s.exec2(ctx, `DELETE FROM notification_slack_state WHERE destination_id=?`, destID); err != nil {
		return err
	}
	return s.exec2(ctx, `UPDATE notification_slack_threads SET reply_cursor='' WHERE destination_id=?`, destID)
}

// ListSlackThreads lists every Slack thread of a destination (the poll state included).
func (s *Store) ListSlackThreads(ctx context.Context, destID string) ([]SlackThreadRef, error) {
	return s.RecentSlackThreads(ctx, destID, time.Time{}, 1<<30)
}
