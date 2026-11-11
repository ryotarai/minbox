package store

import (
	"context"
	"database/sql"
	"errors"
	"time"
)

// The personal Slack integration's tables (additive; see docs/slack-personal.md). The user token
// lives in slack_user_auth (the JSON is owned by the server's slack code and never leaves the
// server); slack_items holds what minbox keeps per Slack thread: the person's own triage state
// (dismissed, snoozed, muted), the helper's judgement and the link to a minbox thread.

const slackPersonalSchema = `
CREATE TABLE IF NOT EXISTS slack_user_auth (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  data TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS slack_items (
  channel TEXT NOT NULL,
  thread_ts TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'active',
  snooze_until INTEGER NOT NULL DEFAULT 0,
  dismissed_at_ts TEXT NOT NULL DEFAULT '',
  judged_at INTEGER NOT NULL DEFAULT 0,
  judged_latest_ts TEXT NOT NULL DEFAULT '',
  judgement TEXT NOT NULL DEFAULT '',
  last_seen_ts TEXT NOT NULL DEFAULT '',
  view TEXT NOT NULL DEFAULT '',
  minbox_thread_id TEXT NOT NULL DEFAULT '',
  updated_at INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (channel, thread_ts)
);
CREATE TABLE IF NOT EXISTS slack_threads (
  channel TEXT NOT NULL,
  thread_ts TEXT NOT NULL,
  latest_ts TEXT NOT NULL DEFAULT '',
  fetched_at INTEGER NOT NULL DEFAULT 0,
  seen_at INTEGER NOT NULL DEFAULT 0,
  data TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (channel, thread_ts)
);
CREATE TABLE IF NOT EXISTS slack_users (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL DEFAULT '',
  bot INTEGER NOT NULL DEFAULT 0,
  fetched_at INTEGER NOT NULL DEFAULT 0
);
`

// SlackItem is one row of slack_items.
type SlackItem struct {
	Channel        string
	ThreadTS       string
	State          string // active | dismissed | snoozed | muted
	SnoozeUntil    time.Time
	DismissedAtTS  string
	JudgedAt       time.Time
	JudgedLatestTS string
	Judgement      string // JSON
	LastSeenTS     string
	View           string // JSON: what the list shows
	MinboxThreadID string
	UpdatedAt      time.Time
}

// SlackUserAuth returns the stored token record ("" when none).
func (s *Store) SlackUserAuth(ctx context.Context) (string, error) {
	var d string
	err := s.db.QueryRowContext(ctx, `SELECT data FROM slack_user_auth WHERE id=1`).Scan(&d)
	if errors.Is(err, sql.ErrNoRows) {
		return "", nil
	}
	return d, err
}

func (s *Store) SetSlackUserAuth(ctx context.Context, data string) error {
	_, err := s.db.ExecContext(ctx, `INSERT INTO slack_user_auth(id,data) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data`, data)
	return err
}

func (s *Store) DeleteSlackUserAuth(ctx context.Context) error {
	_, err := s.db.ExecContext(ctx, `DELETE FROM slack_user_auth`)
	return err
}

const slackItemCols = `channel, thread_ts, state, snooze_until, dismissed_at_ts, judged_at, judged_latest_ts, judgement, last_seen_ts, view, minbox_thread_id, updated_at`

func scanSlackItem(sc interface{ Scan(...any) error }) (SlackItem, error) {
	var it SlackItem
	var snooze, judged, upd int64
	err := sc.Scan(&it.Channel, &it.ThreadTS, &it.State, &snooze, &it.DismissedAtTS, &judged, &it.JudgedLatestTS, &it.Judgement, &it.LastSeenTS, &it.View, &it.MinboxThreadID, &upd)
	if snooze > 0 {
		it.SnoozeUntil = fromMs(snooze)
	}
	if judged > 0 {
		it.JudgedAt = fromMs(judged)
	}
	it.UpdatedAt = fromMs(upd)
	return it, err
}

// SlackItems lists every stored item (newest update first).
func (s *Store) SlackItems(ctx context.Context) ([]SlackItem, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT `+slackItemCols+` FROM slack_items ORDER BY updated_at DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []SlackItem
	for rows.Next() {
		it, err := scanSlackItem(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, it)
	}
	return out, rows.Err()
}

// SlackItem returns one item (ok false when there is none).
func (s *Store) SlackItem(ctx context.Context, channel, ts string) (SlackItem, bool) {
	it, err := scanSlackItem(s.db.QueryRowContext(ctx, `SELECT `+slackItemCols+` FROM slack_items WHERE channel=? AND thread_ts=?`, channel, ts))
	return it, err == nil
}

// SaveSlackJudgement stores the helper's judgement and the list view of an item (the triage state is kept).
func (s *Store) SaveSlackJudgement(ctx context.Context, channel, ts, latestTS, judgement, view string) error {
	now := ms(s.now())
	_, err := s.db.ExecContext(ctx, `INSERT INTO slack_items(channel, thread_ts, judged_at, judged_latest_ts, judgement, last_seen_ts, view, updated_at) VALUES(?,?,?,?,?,?,?,?)
	  ON CONFLICT(channel, thread_ts) DO UPDATE SET judged_at=excluded.judged_at, judged_latest_ts=excluded.judged_latest_ts, judgement=excluded.judgement, last_seen_ts=excluded.last_seen_ts, view=excluded.view, updated_at=excluded.updated_at`,
		channel, ts, now, latestTS, judgement, latestTS, view, now)
	return err
}

// SaveSlackView updates the list view (and last seen ts) of an item without a new judgement.
func (s *Store) SaveSlackView(ctx context.Context, channel, ts, latestTS, view string) error {
	now := ms(s.now())
	_, err := s.db.ExecContext(ctx, `INSERT INTO slack_items(channel, thread_ts, last_seen_ts, view, updated_at) VALUES(?,?,?,?,?)
	  ON CONFLICT(channel, thread_ts) DO UPDATE SET last_seen_ts=excluded.last_seen_ts, view=excluded.view, updated_at=excluded.updated_at`,
		channel, ts, latestTS, view, now)
	return err
}

// SetSlackState sets the person's triage state. dismissedAtTS is the newest message the person had
// seen (a dismissed item returns when something newer arrives, unless the state is "muted").
func (s *Store) SetSlackItemState(ctx context.Context, channel, ts, state string, snoozeUntil time.Time, dismissedAtTS string) error {
	var su int64
	if !snoozeUntil.IsZero() {
		su = ms(snoozeUntil)
	}
	now := ms(s.now())
	_, err := s.db.ExecContext(ctx, `INSERT INTO slack_items(channel, thread_ts, state, snooze_until, dismissed_at_ts, updated_at) VALUES(?,?,?,?,?,?)
	  ON CONFLICT(channel, thread_ts) DO UPDATE SET state=excluded.state, snooze_until=excluded.snooze_until, dismissed_at_ts=excluded.dismissed_at_ts, updated_at=excluded.updated_at`,
		channel, ts, state, su, dismissedAtTS, now)
	return err
}

// SetSlackMinboxThread records the minbox thread started from a Slack thread.
func (s *Store) SetSlackMinboxThread(ctx context.Context, channel, ts, threadID string) error {
	now := ms(s.now())
	_, err := s.db.ExecContext(ctx, `INSERT INTO slack_items(channel, thread_ts, minbox_thread_id, updated_at) VALUES(?,?,?,?)
	  ON CONFLICT(channel, thread_ts) DO UPDATE SET minbox_thread_id=excluded.minbox_thread_id, updated_at=excluded.updated_at`, channel, ts, threadID, now)
	return err
}

// ClearSlackCache deletes judgements and list views (the person's dismissals and links stay).
func (s *Store) ClearSlackCache(ctx context.Context) error {
	if err := s.ClearSlackFetched(ctx); err != nil {
		return err
	}
	if _, err := s.db.ExecContext(ctx, `DELETE FROM slack_items WHERE state='active' AND minbox_thread_id=''`); err != nil {
		return err
	}
	_, err := s.db.ExecContext(ctx, `UPDATE slack_items SET judged_at=0, judged_latest_ts='', judgement='', view='', last_seen_ts=''`)
	return err
}

// DeleteSlackItems removes every item and every fetched copy (Disconnect).
func (s *Store) DeleteSlackItems(ctx context.Context) error {
	if err := s.ClearSlackFetched(ctx); err != nil {
		return err
	}
	_, err := s.db.ExecContext(ctx, `DELETE FROM slack_items`)
	return err
}

// SlackThreadRow is a fetched Slack thread as last read (Data is JSON owned by the server's slack
// code; it holds message text, never the token).
type SlackThreadRow struct {
	Channel   string
	ThreadTS  string
	LatestTS  string
	FetchedAt time.Time
	SeenAt    time.Time
	Data      string
}

// SlackUserRow is a resolved Slack user name.
type SlackUserRow struct {
	ID        string
	Name      string
	Bot       bool
	FetchedAt time.Time
}

// SaveSlackThread stores (or replaces) a fetched thread and marks it seen now.
func (s *Store) SaveSlackThread(ctx context.Context, r SlackThreadRow) error {
	_, err := s.db.ExecContext(ctx, `INSERT INTO slack_threads(channel, thread_ts, latest_ts, fetched_at, seen_at, data) VALUES(?,?,?,?,?,?)
	  ON CONFLICT(channel, thread_ts) DO UPDATE SET latest_ts=excluded.latest_ts, fetched_at=excluded.fetched_at, seen_at=excluded.seen_at, data=excluded.data`,
		r.Channel, r.ThreadTS, r.LatestTS, ms(r.FetchedAt), ms(s.now()), r.Data)
	return err
}

// TouchSlackThreads marks the threads ([channel, thread_ts] pairs) seen now, so pruning keeps them.
func (s *Store) TouchSlackThreads(ctx context.Context, keys [][2]string) error {
	now := ms(s.now())
	for _, k := range keys {
		if _, err := s.db.ExecContext(ctx, `UPDATE slack_threads SET seen_at=? WHERE channel=? AND thread_ts=?`, now, k[0], k[1]); err != nil {
			return err
		}
	}
	return nil
}

// SlackThreads returns every stored thread.
func (s *Store) SlackThreads(ctx context.Context) ([]SlackThreadRow, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT channel, thread_ts, latest_ts, fetched_at, seen_at, data FROM slack_threads`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []SlackThreadRow
	for rows.Next() {
		var r SlackThreadRow
		var f, sn int64
		if err := rows.Scan(&r.Channel, &r.ThreadTS, &r.LatestTS, &f, &sn, &r.Data); err != nil {
			return nil, err
		}
		r.FetchedAt, r.SeenAt = fromMs(f), fromMs(sn)
		out = append(out, r)
	}
	return out, rows.Err()
}

func (s *Store) SaveSlackUser(ctx context.Context, u SlackUserRow) error {
	b := 0
	if u.Bot {
		b = 1
	}
	_, err := s.db.ExecContext(ctx, `INSERT INTO slack_users(id, name, bot, fetched_at) VALUES(?,?,?,?)
	  ON CONFLICT(id) DO UPDATE SET name=excluded.name, bot=excluded.bot, fetched_at=excluded.fetched_at`, u.ID, u.Name, b, ms(u.FetchedAt))
	return err
}

func (s *Store) SlackUsers(ctx context.Context) ([]SlackUserRow, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT id, name, bot, fetched_at FROM slack_users`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []SlackUserRow
	for rows.Next() {
		var u SlackUserRow
		var b, f int64
		if err := rows.Scan(&u.ID, &u.Name, &b, &f); err != nil {
			return nil, err
		}
		u.Bot, u.FetchedAt = b != 0, fromMs(f)
		out = append(out, u)
	}
	return out, rows.Err()
}

// PruneSlackFetched deletes threads not seen since cutoff and users not refreshed since cutoff.
func (s *Store) PruneSlackFetched(ctx context.Context, cutoff time.Time) error {
	if _, err := s.db.ExecContext(ctx, `DELETE FROM slack_threads WHERE seen_at < ?`, ms(cutoff)); err != nil {
		return err
	}
	_, err := s.db.ExecContext(ctx, `DELETE FROM slack_users WHERE fetched_at < ?`, ms(cutoff))
	return err
}

// ClearSlackFetched deletes the stored thread copies and user names.
func (s *Store) ClearSlackFetched(ctx context.Context) error {
	if _, err := s.db.ExecContext(ctx, `DELETE FROM slack_threads`); err != nil {
		return err
	}
	_, err := s.db.ExecContext(ctx, `DELETE FROM slack_users`)
	return err
}

// SlackLinkedThreads: Slack item key "channel:ts" -> the minbox thread (live sessions only).
func (s *Store) SlackLinkedThreads(ctx context.Context) (map[string]LinkedThread, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT i.channel, i.thread_ts, t.id, t.session_id, t.subject, t.status, COALESCE(ss.project_id,''), t.updated_at
	  FROM slack_items i JOIN threads t ON t.id=i.minbox_thread_id JOIN sessions ss ON ss.id=t.session_id
	  WHERE i.minbox_thread_id!='' AND ss.archived_at IS NULL`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]LinkedThread{}
	for rows.Next() {
		var ch, ts string
		var lt LinkedThread
		var upd int64
		if err := rows.Scan(&ch, &ts, &lt.ThreadID, &lt.SessionID, &lt.Subject, &lt.Status, &lt.ProjectID, &upd); err != nil {
			return nil, err
		}
		lt.UpdatedAt = fromMs(upd)
		out[ch+":"+ts] = lt
	}
	return out, rows.Err()
}
