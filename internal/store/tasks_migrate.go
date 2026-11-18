package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"strings"
	"time"
	"unicode/utf8"
)

// ---- migration (docs/v3/redesign.md §8) ----
//
// Only the work that is still going on becomes a task: an unfinished older thread that was active in
// the last week (or asks the person something, in the last month), and the open topics of such a
// thread. Finished, archived and long-quiet threads, and done topics, stay what they are (the threads
// read as segments of each session's stream, search finds them; the topics table keeps its rows):
// they are not current work, and a Board full of them hides the work that is.

const (
	v3StaleAfter     = 7 * 24 * time.Hour  // working / blocked and quiet longer than this: not current work
	v3WaitStaleAfter = 30 * 24 * time.Hour // waiting on the person and quiet longer than this: neither
	v3TitleMax       = 80
	// The first migration's creation event (removed by the corrective one: it is noise).
	v3OldCreatedText = "Task created (from the earlier inbox)"
)

type v3Thread struct {
	id, session, project, subject, name, status string
	created, updated                            int64
	archived                                    bool
}

// open: is the thread current work (see above)?
func (t *v3Thread) open(now time.Time) bool {
	if t == nil || t.archived {
		return false
	}
	age := now.Sub(fromMs(t.updated))
	switch t.status {
	case ThreadNeedAction:
		return age <= v3WaitStaleAfter
	case ThreadWorking, ThreadBlocked:
		return age <= v3StaleAfter
	}
	return false
}

// v3Title makes a task title from an older thread: its name, else its subject (which, for a thread the
// person started, is their first message): the first line, at most v3TitleMax characters.
func v3Title(name, subject string) string {
	s := strings.TrimSpace(name)
	if s == "" {
		s = strings.TrimSpace(subject)
	}
	if i := strings.IndexByte(s, '\n'); i >= 0 {
		s = s[:i]
	}
	s = oneLine(s)
	if utf8.RuneCountInString(s) > v3TitleMax {
		r := []rune(s)
		cut := v3TitleMax - 1
		// End at a sentence when one ends early enough.
		for i := 20; i < cut; i++ {
			if r[i] == '。' || r[i] == '．' || r[i] == '!' || r[i] == '?' || r[i] == '！' || r[i] == '？' || (r[i] == '.' && i+1 < len(r) && r[i+1] == ' ') {
				return string(r[:i+1])
			}
		}
		s = string(r[:cut]) + "…"
	}
	if s == "" {
		s = "Untitled"
	}
	return s
}

func loadV3Threads(ctx context.Context, tx *sql.Tx) (map[string]*v3Thread, error) {
	rows, err := tx.QueryContext(ctx, `SELECT t.id, t.session_id, COALESCE(s.project_id,''), t.subject, t.name, COALESCE(t.status,''), t.created_at, t.updated_at,
	  (t.archived_at IS NOT NULL OR s.archived_at IS NOT NULL)
	  FROM threads t JOIN sessions s ON s.id=t.session_id WHERE t.kind!='stream'`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]*v3Thread{}
	for rows.Next() {
		var t v3Thread
		if err := rows.Scan(&t.id, &t.session, &t.project, &t.subject, &t.name, &t.status, &t.created, &t.updated, &t.archived); err != nil {
			return nil, err
		}
		out[t.id] = &t
	}
	return out, rows.Err()
}

type v3Topic struct {
	id, thread, title, summary, status, manualStatus, detail, steps, msgs string
	created, updated                                                      int64
	done, manualAt                                                        sql.NullInt64
}

func loadV3Topics(ctx context.Context, tx *sql.Tx) ([]v3Topic, error) {
	rows, err := tx.QueryContext(ctx, `SELECT id, thread_id, title, summary, status, created_at, updated_at, done_at, manual_status, manual_at, detail, tasks, message_ids FROM topics ORDER BY created_at`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []v3Topic
	for rows.Next() {
		var r v3Topic
		if err := rows.Scan(&r.id, &r.thread, &r.title, &r.summary, &r.status, &r.created, &r.updated, &r.done, &r.manualStatus, &r.manualAt, &r.detail, &r.steps, &r.msgs); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// topicOpen: a topic that is current work: not done (by the agent or by hand), in an open thread.
func (r *v3Topic) open(th *v3Thread, now time.Time) bool {
	st, ok := NormalizeTaskStatus(r.status)
	if r.manualStatus != "" {
		if m, ok2 := NormalizeTaskStatus(r.manualStatus); ok2 {
			st, ok = m, true
		}
	}
	if ok && st == TaskDone {
		return false
	}
	return th.open(now)
}

// threadMessages lists a thread's message ids in order.
func threadMessages(ctx context.Context, tx *sql.Tx, threadID string) ([]string, []int64, error) {
	rows, err := tx.QueryContext(ctx, `SELECT id, created_at FROM messages WHERE thread_id=? ORDER BY created_at, rowid`, threadID)
	if err != nil {
		return nil, nil, err
	}
	defer rows.Close()
	var ids []string
	var at []int64
	for rows.Next() {
		var id string
		var a int64
		if err := rows.Scan(&id, &a); err != nil {
			return nil, nil, err
		}
		ids, at = append(ids, id), append(at, a)
	}
	return ids, at, rows.Err()
}

// topicMessages: the messages a topic's task is about: the ones the topic named, and the rest of the
// thread after the newest of them (the conversation went on about it). The only topic of its thread
// gets the whole thread.
func topicMessages(ctx context.Context, tx *sql.Tx, r *v3Topic, onlyTopic bool) ([]string, error) {
	ids, at, err := threadMessages(ctx, tx, r.thread)
	if err != nil {
		return nil, err
	}
	if onlyTopic {
		return ids, nil
	}
	var named []string
	_ = json.Unmarshal([]byte(r.msgs), &named)
	in := map[string]bool{}
	for _, id := range named {
		in[id] = true
	}
	var newest int64 = -1
	for i, id := range ids {
		if in[id] && at[i] > newest {
			newest = at[i]
		}
	}
	out := append([]string{}, named...)
	if newest >= 0 {
		for i, id := range ids {
			if at[i] > newest {
				out = append(out, id)
			}
		}
	}
	return out, nil
}

func linkMigrated(ctx context.Context, tx *sql.Tx, taskID string, mids []string) error {
	for _, mid := range mids {
		// created_at = the message's: a link the migration made never reads as later activity.
		if _, err := tx.ExecContext(ctx, `INSERT OR IGNORE INTO message_tasks(message_id, task_id, source, created_at) SELECT id, ?, ?, created_at FROM messages WHERE id=?`, taskID, LinkAuto, mid); err != nil {
			return err
		}
	}
	return nil
}

func settingSet(ctx context.Context, tx *sql.Tx, key string) error {
	_, err := tx.ExecContext(ctx, `INSERT OR REPLACE INTO settings(key, value) VALUES(?, ?)`, key, `"`+time.Now().UTC().Format(time.RFC3339)+`"`)
	return err
}

// renameMessageTags: the table of which tasks a message is about was message_tags.
func renameMessageTags(db *sql.DB) error {
	var n int
	if err := db.QueryRow(`SELECT count(*) FROM sqlite_master WHERE type='table' AND name='message_tags'`).Scan(&n); err != nil || n == 0 {
		return err
	}
	if err := db.QueryRow(`SELECT count(*) FROM sqlite_master WHERE type='table' AND name='message_tasks'`).Scan(&n); err != nil || n > 0 {
		return err
	}
	if _, err := db.Exec(`ALTER TABLE message_tags RENAME TO message_tasks`); err != nil {
		return err
	}
	_, err := db.Exec(`DROP INDEX IF EXISTS message_tags_task`)
	return err
}

// migrateV3 turns the older data into v3's (see above). Agent messages older than a thread's Mark read
// count as read. Nothing is dropped. Runs once (v3_migrated); a database the first version of this
// migration ran on is corrected by migrateV3Fix.
func migrateV3(ctx context.Context, db *sql.DB) error {
	var done string
	if err := db.QueryRowContext(ctx, `SELECT value FROM settings WHERE key='v3_migrated'`).Scan(&done); err == nil {
		return migrateV3Fix(ctx, db)
	} else if !errors.Is(err, sql.ErrNoRows) {
		return err
	}
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	now := time.Now()
	threads, err := loadV3Threads(ctx, tx)
	if err != nil {
		return err
	}
	topics, err := loadV3Topics(ctx, tx)
	if err != nil {
		return err
	}
	perThread := map[string]int{}
	for _, r := range topics {
		perThread[r.thread]++
	}
	// Idempotent: a task remembers the topic or thread it was made from.
	hasOrigin := map[string]bool{}
	if rows, err := tx.QueryContext(ctx, `SELECT origin FROM tasks WHERE origin!=''`); err == nil {
		for rows.Next() {
			var o string
			if rows.Scan(&o) == nil {
				_, ref, _ := strings.Cut(o, ":")
				hasOrigin[ref] = true
			}
		}
		rows.Close()
	} else {
		return err
	}
	for i := range topics {
		r := &topics[i]
		th := threads[r.thread]
		if !r.open(th, now) || hasOrigin[r.id] {
			continue
		}
		st, ok := NormalizeTaskStatus(r.status)
		if !ok || st == TaskDone {
			st = TaskWorking
		}
		manual := ""
		var mAt any
		if r.manualStatus != "" {
			manual, _ = NormalizeTaskStatus(r.manualStatus)
			if r.manualAt.Valid && manual != "" {
				mAt = r.manualAt.Int64
			}
		}
		var old []TopicTask
		_ = json.Unmarshal([]byte(r.steps), &old)
		steps := []TaskStep{}
		for _, k := range old {
			steps = append(steps, TaskStep{Text: k.Text, Done: k.Done})
		}
		id := NewID("tsk")
		if _, err := tx.ExecContext(ctx, `INSERT INTO tasks(`+taskCols+`, origin) VALUES(?,?,?,?,?,?,?,'','[]',?,?,?,NULL,?,?,'','','[]','{}',?)`,
			id, th.project, r.title, r.summary, r.detail, st, jsonText(steps), th.session, r.created, max(r.updated, th.updated), manual, mAt, "topic:"+r.id); err != nil {
			return err
		}
		mids, err := topicMessages(ctx, tx, r, perThread[r.thread] == 1)
		if err != nil {
			return err
		}
		if err := migrateTaskRest(ctx, tx, id, th.session, fromMs(r.created), mids); err != nil {
			return err
		}
	}
	for _, th := range threads {
		if perThread[th.id] > 0 || !th.open(now) || hasOrigin[th.id] {
			continue
		}
		st, _ := NormalizeTaskStatus(th.status)
		id := NewID("tsk")
		if _, err := tx.ExecContext(ctx, `INSERT INTO tasks(`+taskCols+`, origin) VALUES(?,?,?,'','',?,'[]','','[]',?,?,?,NULL,'',NULL,'','','[]','{}',?)`,
			id, th.project, v3Title(th.name, th.subject), st, th.session, th.created, th.updated, "thread:"+th.id); err != nil {
			return err
		}
		mids, _, err := threadMessages(ctx, tx, th.id)
		if err != nil {
			return err
		}
		if err := migrateTaskRest(ctx, tx, id, th.session, fromMs(th.created), mids); err != nil {
			return err
		}
	}
	if err := migrateLinearLinks(ctx, tx); err != nil {
		return err
	}
	// Read state: agent messages a Mark read covered are read.
	if _, err := tx.ExecContext(ctx, `UPDATE messages SET read_at=(SELECT t.marked_read_at FROM threads t WHERE t.id=messages.thread_id)
	  WHERE author='agent' AND read_at IS NULL AND EXISTS(SELECT 1 FROM threads t WHERE t.id=messages.thread_id AND t.marked_read_at IS NOT NULL AND t.marked_read_at>=messages.created_at)`); err != nil {
		return err
	}
	if err := settingSet(ctx, tx, "v3_migrated"); err != nil {
		return err
	}
	if err := settingSet(ctx, tx, "v3_migrated_2"); err != nil {
		return err
	}
	return tx.Commit()
}

// migrateLinearLinks: Linear links of threads → the tasks made from them.
func migrateLinearLinks(ctx context.Context, tx *sql.Tx) error {
	_, err := tx.ExecContext(ctx, `UPDATE tasks SET links=(SELECT json_array(json_object('kind','linear','label',l.identifier,'url',l.url,'state',l.state))
	  FROM thread_links l WHERE 'thread:'||l.thread_id=tasks.origin OR EXISTS(SELECT 1 FROM topics tp WHERE 'topic:'||tp.id=tasks.origin AND tp.thread_id=l.thread_id))
	  WHERE links='[]' AND EXISTS(SELECT 1 FROM thread_links l WHERE 'thread:'||l.thread_id=tasks.origin OR EXISTS(SELECT 1 FROM topics tp WHERE 'topic:'||tp.id=tasks.origin AND tp.thread_id=l.thread_id))`)
	return err
}

func migrateTaskRest(ctx context.Context, tx *sql.Tx, taskID, session string, created time.Time, mids []string) error {
	if _, err := tx.ExecContext(ctx, `INSERT OR IGNORE INTO task_agents(task_id, session_id, role, created_at) VALUES(?,?,?,?)`, taskID, session, RoleAssigned, ms(created)); err != nil {
		return err
	}
	return linkMigrated(ctx, tx, taskID, mids)
}

// migrateV3Fix corrects what the first version of migrateV3 made (it turned every unfinished thread
// and every topic into a task, titled a thread's task with the person's first message, and logged a
// creation event on each). Once (v3_migrated_2), in one transaction:
//   - a task it made that nobody touched since (no change, no event, no message added to it after
//     the migration, no message the person put in it) and that is not current work (see above) is
//     removed: its thread and topic rows keep everything;
//   - a kept task made from a thread gets the thread's name (or its subject's first line) as title,
//     unless the title was changed since;
//   - a kept task is about every message of its thread (its only topic's, or after its topic's
//     messages) too;
//   - the "Task created (from the earlier inbox)" events go;
//   - the session streams lose a title an agent gave them through the older thread_title.
//
// Tasks the person or the agents made are never touched.
func migrateV3Fix(ctx context.Context, db *sql.DB) error {
	var done, at string
	if err := db.QueryRowContext(ctx, `SELECT value FROM settings WHERE key='v3_migrated_2'`).Scan(&done); err == nil {
		return nil
	} else if !errors.Is(err, sql.ErrNoRows) {
		return err
	}
	if err := db.QueryRowContext(ctx, `SELECT value FROM settings WHERE key='v3_migrated'`).Scan(&at); err != nil {
		return err
	}
	// Anything after the first migration (plus a minute) counts as the person's or an agent's doing.
	var migratedAt int64 = -1
	if t, err := time.Parse(time.RFC3339, strings.Trim(at, `"`)); err == nil {
		migratedAt = ms(t.Add(time.Minute))
	}
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	now := time.Now()
	threads, err := loadV3Threads(ctx, tx)
	if err != nil {
		return err
	}
	topicList, err := loadV3Topics(ctx, tx)
	if err != nil {
		return err
	}
	topics := map[string]*v3Topic{}
	perThread := map[string]int{}
	for i := range topicList {
		topics[topicList[i].id] = &topicList[i]
		perThread[topicList[i].thread]++
	}
	type row struct {
		id, origin, title, manual, kind, parent string
		updated                                 int64
	}
	rows, err := tx.QueryContext(ctx, `SELECT id, origin, title, manual_status, kind, parent_id, updated_at FROM tasks WHERE origin LIKE 'thread:%' OR origin LIKE 'topic:%'`)
	if err != nil {
		return err
	}
	var tasks []row
	for rows.Next() {
		var r row
		if err := rows.Scan(&r.id, &r.origin, &r.title, &r.manual, &r.kind, &r.parent, &r.updated); err != nil {
			rows.Close()
			return err
		}
		tasks = append(tasks, r)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}
	isChild := map[string]bool{}
	if rows, err := tx.QueryContext(ctx, `SELECT DISTINCT parent_id FROM tasks WHERE parent_id!=''`); err == nil {
		for rows.Next() {
			var p string
			if rows.Scan(&p) == nil {
				isChild[p] = true
			}
		}
		rows.Close()
	}
	for _, r := range tasks {
		touched := migratedAt < 0 || r.manual != "" || r.kind != "" || r.parent != "" || isChild[r.id] || r.updated > migratedAt
		if !touched {
			var n int
			if err := tx.QueryRowContext(ctx, `SELECT (SELECT count(*) FROM task_events WHERE task_id=?1 AND at>?2)
			  + (SELECT count(*) FROM message_tasks WHERE task_id=?1 AND (source=?3 OR created_at>?2))
			  + (SELECT count(*) FROM task_agents WHERE task_id=?1 AND created_at>?2)`, r.id, migratedAt, LinkPerson).Scan(&n); err != nil {
				return err
			}
			touched = n > 0
		}
		var th *v3Thread
		var tp *v3Topic
		kind, ref, _ := strings.Cut(r.origin, ":")
		if kind == "thread" {
			th = threads[ref]
		} else if tp = topics[ref]; tp != nil {
			th = threads[tp.thread]
		}
		current := th != nil && (tp == nil && th.open(now) || tp != nil && tp.open(th, now))
		if !touched && !current {
			for _, q := range []string{`DELETE FROM message_tasks WHERE task_id=?`, `DELETE FROM task_agents WHERE task_id=?`, `DELETE FROM task_events WHERE task_id=?`, `DELETE FROM tasks WHERE id=?`} {
				if _, err := tx.ExecContext(ctx, q, r.id); err != nil {
					return err
				}
			}
			continue
		}
		if th == nil {
			continue
		}
		var mids []string
		if tp == nil {
			// The first migration's title was the subject (or name) on one line.
			if title := v3Title(th.name, th.subject); title != r.title && (r.title == oneLine(th.subject) || r.title == oneLine(th.name)) {
				if _, err := tx.ExecContext(ctx, `UPDATE tasks SET title=? WHERE id=?`, title, r.id); err != nil {
					return err
				}
			}
			mids, _, err = threadMessages(ctx, tx, th.id)
		} else {
			mids, err = topicMessages(ctx, tx, tp, perThread[tp.thread] == 1)
		}
		if err != nil {
			return err
		}
		if err := linkMigrated(ctx, tx, r.id, mids); err != nil {
			return err
		}
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM task_events WHERE kind='created' AND text=?`, v3OldCreatedText); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `UPDATE threads SET subject='', name='' WHERE kind='stream' AND (subject!='' OR name!='')`); err != nil {
		return err
	}
	if err := settingSet(ctx, tx, "v3_migrated_2"); err != nil {
		return err
	}
	return tx.Commit()
}
