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
//  1. the task the agent named explicitly (send_message task_ids): an agent link to a task that
//     already existed when the message's turn began (the older server linked the tasks created in
//     the turn as agent links too, and those were created during it);
//  2. then the person's link (source person);
//  3. then another agent link (a task created in the turn);
//  4. then a rule's link (auto: inherited from the turn, the migration's placement);
//  5. within a rank, the most recently created task (the most specific), then the most recent link,
//     then the larger task id (only so that it is deterministic).
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
	// turn: when the message's turn began (the newest of the person's messages up to it, itself for
	// one of theirs). An agent link to a task that existed before that was named (send_message
	// task_ids); an agent link to a task created during the turn came from create_task.
	rows, err := tx.QueryContext(ctx, `SELECT message_id, task_id, source, created_at FROM (
	  SELECT mt.message_id, mt.task_id, mt.source, mt.created_at, COALESCE(t.created_at, 0) AS task_created,
	    COALESCE((SELECT max(m2.created_at) FROM messages m2 JOIN threads t2 ON t2.id=m2.thread_id
	      WHERE t2.session_id=th.session_id AND m2.author='user' AND m2.kind NOT IN ('command','note') AND m2.created_at<=m.created_at), m.created_at) AS turn
	  FROM message_tasks mt JOIN messages m ON m.id=mt.message_id JOIN threads th ON th.id=m.thread_id LEFT JOIN tasks t ON t.id=mt.task_id
	  WHERE mt.message_id IN (SELECT message_id FROM message_tasks GROUP BY message_id HAVING count(*) > 1))
	  ORDER BY message_id,
	    CASE WHEN source='agent' AND task_created < turn THEN 0 WHEN source='person' THEN 1 WHEN source='agent' THEN 2 ELSE 3 END,
	    task_created DESC, created_at DESC, task_id DESC`)
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
