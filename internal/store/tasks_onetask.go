package store

import (
	"context"
	"database/sql"
	"errors"
	"time"
)

// One task per message (docs/v3/redesign.md §4.5, revision 8): messages and tasks were many to many;
// now every message belongs to exactly one task. message_tasks keeps its shape, and a unique index on
// message_id holds it to one row per message.
//
// migrateOneTask (once, v3_one_task, in one transaction) keeps one link of each message that has
// several, and drops the others:
//
//  1. an explicit link (the agent named the task, or the person put it there: source agent / person)
//     wins over a rule's (auto: inherited from the turn, the migration's placement);
//  2. among those, the most recently created task;
//  3. then the most recent link, then the larger task id (only so that it is deterministic).
//
// Every dropped link is written to message_tasks_dropped (with the task that was kept and when), so
// the change can be audited and undone by hand. Nothing else is touched: no message, task or event is
// deleted. The unique index is made in the same transaction.

const oneTaskSchema = `
CREATE TABLE IF NOT EXISTS message_tasks_dropped (
  message_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  source TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  kept_task_id TEXT NOT NULL,
  dropped_at INTEGER NOT NULL
);
`

const oneTaskIndex = `CREATE UNIQUE INDEX IF NOT EXISTS message_tasks_one ON message_tasks(message_id)`

func migrateOneTask(ctx context.Context, db *sql.DB) error {
	var done string
	if err := db.QueryRowContext(ctx, `SELECT value FROM settings WHERE key='v3_one_task'`).Scan(&done); err == nil {
		_, err := db.ExecContext(ctx, oneTaskIndex)
		return err
	} else if !errors.Is(err, sql.ErrNoRows) {
		return err
	}
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err := tx.ExecContext(ctx, oneTaskSchema); err != nil {
		return err
	}
	type link struct {
		message, task, source string
		created               int64
	}
	rows, err := tx.QueryContext(ctx, `SELECT mt.message_id, mt.task_id, mt.source, mt.created_at FROM message_tasks mt LEFT JOIN tasks t ON t.id=mt.task_id
	  WHERE mt.message_id IN (SELECT message_id FROM message_tasks GROUP BY message_id HAVING count(*) > 1)
	  ORDER BY mt.message_id, (mt.source IN ('agent','person')) DESC, COALESCE(t.created_at, 0) DESC, mt.created_at DESC, mt.task_id DESC`)
	if err != nil {
		return err
	}
	var links []link
	for rows.Next() {
		var l link
		if err := rows.Scan(&l.message, &l.task, &l.source, &l.created); err != nil {
			rows.Close()
			return err
		}
		links = append(links, l)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}
	now := ms(time.Now())
	kept := map[string]string{}
	for _, l := range links {
		k, ok := kept[l.message]
		if !ok {
			kept[l.message] = l.task // the first in the order above
			continue
		}
		if _, err := tx.ExecContext(ctx, `INSERT INTO message_tasks_dropped(message_id, task_id, source, created_at, kept_task_id, dropped_at) VALUES(?,?,?,?,?,?)`,
			l.message, l.task, l.source, l.created, k, now); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `DELETE FROM message_tasks WHERE message_id=? AND task_id=?`, l.message, l.task); err != nil {
			return err
		}
	}
	if _, err := tx.ExecContext(ctx, oneTaskIndex); err != nil {
		return err
	}
	if err := settingSet(ctx, tx, "v3_one_task"); err != nil {
		return err
	}
	return tx.Commit()
}
