package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"sort"
	"strings"
	"time"
)

// Every message is about at least one task (docs/v3/redesign.md §4.5, revision 7). The agent places
// its messages and the person's: send_message task_ids, create_task, update_task message_ids. A
// message it has not placed yet is unplaced: minbox asks the agent to place it at the end of each turn
// (KindPlace) until it does; the person's message not yet delivered is provisional (it is the next
// turn's). The person moves messages between tasks but cannot take a message out of its last task.

// KindPlace marks minbox's request to the agent to place its unplaced messages in tasks (a message from
// the person's side, delivered like theirs, shown as a small note). TurnOf lists the messages it asks
// about; it belongs to the tasks they end up in.
const KindPlace = "place"

// Unplaced is a message no task has yet.
type Unplaced struct {
	ID        string
	Author    string
	Kind      string
	Text      string
	CreatedAt time.Time
}

// UnplacedMessages lists the messages of a session that are in no task, oldest first: not minbox's
// own requests to place them, and not the person's messages still on their way (provisional).
func (s *Store) UnplacedMessages(ctx context.Context, sessionID string) ([]Unplaced, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT m.id, m.author, m.kind, m.body, m.words, m.created_at FROM messages m JOIN threads t ON t.id=m.thread_id
	  WHERE t.session_id=? AND m.kind!=? AND NOT (m.author='user' AND m.delivered_at IS NULL)
	  AND NOT EXISTS(SELECT 1 FROM message_tasks mt WHERE mt.message_id=m.id) ORDER BY m.created_at, m.rowid`, sessionID, KindPlace)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Unplaced{}
	for rows.Next() {
		var u Unplaced
		var body, words string
		var at int64
		if err := rows.Scan(&u.ID, &u.Author, &u.Kind, &body, &words, &at); err != nil {
			return nil, err
		}
		u.Text, u.CreatedAt = body, fromMs(at)
		if u.Author == AuthorUser && strings.TrimSpace(words) != "" {
			u.Text = words
		}
		out = append(out, u)
	}
	return out, rows.Err()
}

// PlaceRequest is minbox's request to place messages (KindPlace) that is in no task yet.
type PlaceRequest struct {
	ID      string
	Targets []string
}

// OpenPlaceRequests lists the session's requests to place messages that are in no task yet.
func (s *Store) OpenPlaceRequests(ctx context.Context, sessionID string) ([]PlaceRequest, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT m.id, m.turn_of FROM messages m JOIN threads t ON t.id=m.thread_id
	  WHERE t.session_id=? AND m.kind=? AND NOT EXISTS(SELECT 1 FROM message_tasks mt WHERE mt.message_id=m.id) ORDER BY m.created_at`, sessionID, KindPlace)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []PlaceRequest{}
	for rows.Next() {
		var p PlaceRequest
		var turnOf string
		if err := rows.Scan(&p.ID, &turnOf); err != nil {
			return nil, err
		}
		_ = json.Unmarshal([]byte(turnOf), &p.Targets)
		out = append(out, p)
	}
	return out, rows.Err()
}

// LinkCount is how many tasks a message is about.
func (s *Store) LinkCount(ctx context.Context, messageID string) (int, error) {
	var n int
	err := s.db.QueryRowContext(ctx, `SELECT count(*) FROM message_tasks WHERE message_id=?`, messageID).Scan(&n)
	return n, err
}

// CountUnlinked is how many messages are in no task (all of them, provisional ones too).
func (s *Store) CountUnlinked(ctx context.Context) (int, error) {
	var n int
	err := s.db.QueryRowContext(ctx, `SELECT count(*) FROM messages m WHERE NOT EXISTS(SELECT 1 FROM message_tasks mt WHERE mt.message_id=m.id)`).Scan(&n)
	return n, err
}

// ---- the migration: every message in a task (v3_migrated_3) ----

type v3Msg struct {
	id, thread, kind, author, body, words, answersFor string
	turnOf                                            []string
	created                                           int64
}

// migrateV3Place links every message that is in no task, once (v3_migrated_3), in one transaction:
//   - a message of an older thread goes to that thread's task (the task made from it or its topics,
//     else the task most of its messages are about); a thread without one gets a task of its own,
//     done (when the thread was last active), titled from its name or subject: the Board's open lists
//     never show it, its done list only while it is recent;
//   - a message of a session's stream goes by its turn: an agent reply to the tasks of the person's
//     messages it answered, the person's message to the tasks of the reply that answered it or of
//     the message it answers; else to the tasks of the session's message nearest in time that has
//     some; a session with none gets one done task for its stream, titled from its first message.
//
// Links it makes are LinkAuto with the message's own time. Nothing is removed.
func migrateV3Place(ctx context.Context, db *sql.DB) error {
	var done string
	if err := db.QueryRowContext(ctx, `SELECT value FROM settings WHERE key='v3_migrated_3'`).Scan(&done); err == nil {
		return nil
	} else if !errors.Is(err, sql.ErrNoRows) {
		return err
	}
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if err := placeAll(ctx, tx); err != nil {
		return err
	}
	if err := settingSet(ctx, tx, "v3_migrated_3"); err != nil {
		return err
	}
	return tx.Commit()
}

func placeAll(ctx context.Context, tx *sql.Tx) error {
	type thr struct {
		id, session, project, kind, subject, name string
		created, updated                          int64
	}
	threads := map[string]*thr{}
	rows, err := tx.QueryContext(ctx, `SELECT t.id, t.session_id, COALESCE(s.project_id,''), t.kind, t.subject, t.name, t.created_at, t.updated_at FROM threads t JOIN sessions s ON s.id=t.session_id
	  WHERE EXISTS(SELECT 1 FROM messages m WHERE m.thread_id=t.id AND NOT EXISTS(SELECT 1 FROM message_tasks mt WHERE mt.message_id=m.id))`)
	if err != nil {
		return err
	}
	for rows.Next() {
		var t thr
		if err := rows.Scan(&t.id, &t.session, &t.project, &t.kind, &t.subject, &t.name, &t.created, &t.updated); err != nil {
			rows.Close()
			return err
		}
		threads[t.id] = &t
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}
	if len(threads) == 0 {
		return nil
	}
	sessions := map[string]bool{}
	for _, t := range threads {
		sessions[t.session] = true
	}
	link := func(taskID string, m *v3Msg, session string) error {
		if _, err := tx.ExecContext(ctx, `INSERT OR IGNORE INTO message_tasks(message_id, task_id, source, created_at) VALUES(?,?,?,?)`, m.id, taskID, LinkAuto, m.created); err != nil {
			return err
		}
		if m.author == AuthorAgent {
			_, err := tx.ExecContext(ctx, `INSERT OR IGNORE INTO task_agents(task_id, session_id, role, created_at) VALUES(?,?,?,?)`, taskID, session, RoleInvolved, m.created)
			return err
		}
		return nil
	}
	newTask := func(project, session, title, origin string, created, doneAt int64) (string, error) {
		var id string
		if err := tx.QueryRowContext(ctx, `SELECT id FROM tasks WHERE origin=?`, origin).Scan(&id); err == nil {
			return id, nil
		} else if !errors.Is(err, sql.ErrNoRows) {
			return "", err
		}
		id = NewID("tsk")
		if _, err := tx.ExecContext(ctx, `INSERT INTO tasks(`+taskCols+`, origin) VALUES(?,?,?,'','',?,'[]','','[]',?,?,?,?,'',NULL,'','','[]','{}',?)`,
			id, project, title, TaskDone, session, created, doneAt, doneAt, origin); err != nil {
			return "", err
		}
		_, err := tx.ExecContext(ctx, `INSERT OR IGNORE INTO task_agents(task_id, session_id, role, created_at) VALUES(?,?,?,?)`, id, session, RoleAssigned, created)
		return id, err
	}
	for session := range sessions {
		// The session's messages, oldest first, with their tasks.
		rows, err := tx.QueryContext(ctx, `SELECT m.id, m.thread_id, m.kind, m.author, m.body, m.words, m.answers_for, m.turn_of, m.created_at FROM messages m JOIN threads t ON t.id=m.thread_id
		  WHERE t.session_id=? ORDER BY m.created_at, m.rowid`, session)
		if err != nil {
			return err
		}
		var msgs []*v3Msg
		for rows.Next() {
			var m v3Msg
			var turnOf string
			if err := rows.Scan(&m.id, &m.thread, &m.kind, &m.author, &m.body, &m.words, &m.answersFor, &turnOf, &m.created); err != nil {
				rows.Close()
				return err
			}
			_ = json.Unmarshal([]byte(turnOf), &m.turnOf)
			msgs = append(msgs, &m)
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return err
		}
		tasksOf := map[string][]string{}
		trows, err := tx.QueryContext(ctx, `SELECT mt.message_id, mt.task_id FROM message_tasks mt JOIN messages m ON m.id=mt.message_id JOIN threads t ON t.id=m.thread_id WHERE t.session_id=? ORDER BY mt.created_at`, session)
		if err != nil {
			return err
		}
		for trows.Next() {
			var mid, tid string
			if err := trows.Scan(&mid, &tid); err != nil {
				trows.Close()
				return err
			}
			tasksOf[mid] = append(tasksOf[mid], tid)
		}
		trows.Close()
		place := func(m *v3Msg, ids []string) error {
			for _, id := range ids {
				if err := link(id, m, session); err != nil {
					return err
				}
				tasksOf[m.id] = appendUnique(tasksOf[m.id], id)
			}
			return nil
		}
		// Older threads: to the thread's task, or one made for it.
		for _, m := range msgs {
			th := threads[m.thread]
			if len(tasksOf[m.id]) > 0 || th == nil || th.kind == ThreadStream {
				continue
			}
			var tid string
			err := tx.QueryRowContext(ctx, `SELECT t.id FROM tasks t
			  LEFT JOIN (SELECT mt.task_id, count(*) n FROM message_tasks mt JOIN messages m ON m.id=mt.message_id WHERE m.thread_id=?1 GROUP BY mt.task_id) c ON c.task_id=t.id
			  WHERE t.origin='thread:'||?1 OR t.origin IN (SELECT 'topic:'||id FROM topics WHERE thread_id=?1) OR c.n > 0
			  ORDER BY (t.origin='thread:'||?1 OR t.origin IN (SELECT 'topic:'||id FROM topics WHERE thread_id=?1)) DESC, COALESCE(c.n,0) DESC, t.updated_at DESC LIMIT 1`, th.id).Scan(&tid)
			if errors.Is(err, sql.ErrNoRows) {
				subject := th.subject
				if strings.TrimSpace(subject) == "" && strings.TrimSpace(th.name) == "" {
					subject = firstWords(msgs, th.id)
				}
				tid, err = newTask(th.project, session, v3Title(th.name, subject), "thread:"+th.id, th.created, max(th.updated, th.created))
			}
			if err != nil {
				return err
			}
			if err := place(m, []string{tid}); err != nil {
				return err
			}
		}
		// The stream: by turn, a few rounds (a reply's tasks reach its turn's messages and back).
		byID := map[string]*v3Msg{}
		for _, m := range msgs {
			byID[m.id] = m
		}
		for round := 0; round < 3; round++ {
			for _, m := range msgs {
				if len(m.turnOf) == 0 {
					continue
				}
				if len(tasksOf[m.id]) == 0 {
					for _, p := range m.turnOf {
						if err := place(m, tasksOf[p]); err != nil {
							return err
						}
					}
				}
				for _, p := range m.turnOf {
					if pm := byID[p]; pm != nil && len(tasksOf[p]) == 0 {
						if err := place(pm, tasksOf[m.id]); err != nil {
							return err
						}
					}
				}
			}
			for _, m := range msgs {
				if len(tasksOf[m.id]) == 0 && m.answersFor != "" {
					if err := place(m, tasksOf[m.answersFor]); err != nil {
						return err
					}
				}
			}
		}
		// The rest: the tasks of the nearest message in time that has some.
		var placed []*v3Msg
		for _, m := range msgs {
			if len(tasksOf[m.id]) > 0 {
				placed = append(placed, m)
			}
		}
		if len(placed) > 0 {
			for _, m := range msgs {
				if len(tasksOf[m.id]) > 0 {
					continue
				}
				i := sort.Search(len(placed), func(i int) bool { return placed[i].created > m.created })
				var near *v3Msg
				if i > 0 {
					near = placed[i-1]
				}
				if i < len(placed) && (near == nil || placed[i].created-m.created < m.created-near.created) {
					near = placed[i]
				}
				if err := place(m, tasksOf[near.id]); err != nil {
					return err
				}
			}
		}
		// A session nothing of which is in a task: one task for its stream.
		for _, m := range msgs {
			if len(tasksOf[m.id]) > 0 {
				continue
			}
			th := threads[m.thread]
			if th == nil {
				continue
			}
			last := m.created
			for _, x := range msgs {
				last = max(last, x.created)
			}
			tid, err := newTask(th.project, session, v3Title("", firstWords(msgs, "")), "stream:"+th.id, m.created, last)
			if err != nil {
				return err
			}
			for _, x := range msgs {
				if len(tasksOf[x.id]) == 0 {
					if err := place(x, []string{tid}); err != nil {
						return err
					}
				}
			}
			break
		}
	}
	return nil
}

// firstWords: the first message of the person (else any first message) among msgs (of a thread, or
// all of them for ""), as its text.
func firstWords(msgs []*v3Msg, thread string) string {
	first := ""
	for _, m := range msgs {
		if thread != "" && m.thread != thread || m.kind == KindCommand || m.kind == KindPlace {
			continue
		}
		text := m.body
		if m.author == AuthorUser && strings.TrimSpace(m.words) != "" {
			text = m.words
		}
		if strings.TrimSpace(text) == "" {
			continue
		}
		if m.author == AuthorUser {
			return text
		}
		if first == "" {
			first = text
		}
	}
	return first
}

func appendUnique(ids []string, id string) []string {
	for _, x := range ids {
		if x == id {
			return ids
		}
	}
	return append(ids, id)
}
