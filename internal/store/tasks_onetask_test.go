package store

import (
	"context"
	"path/filepath"
	"testing"
)

// The migration to one task per message (v3_one_task): of a message's links, an explicit one (agent
// / person) wins over a rule's (auto), then the most recently created task; the dropped links are
// logged in message_tasks_dropped; nothing else goes; it runs once; the unique index holds after.
func TestMigrateOneTask(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "m.db")
	s, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	sess, _ := s.CreateSession(ctx, "api", "/tmp/a", "u")
	stream, _ := s.StreamThread(ctx, sess.ID)
	task := func(title string, created int64) string {
		tk, err := s.CreateTask(ctx, sess.ProjectID, sess.ID, TaskFields{Title: ptr(title)})
		if err != nil {
			t.Fatal(err)
		}
		_, _ = s.db.ExecContext(ctx, `UPDATE tasks SET created_at=? WHERE id=?`, created, tk.ID)
		return tk.ID
	}
	older, newer, newest := task("older", 1000), task("newer", 2000), task("newest", 3000)
	msg := func(body string) string {
		m, err := s.AddMessage(ctx, stream, agentMsg(body))
		if err != nil {
			t.Fatal(err)
		}
		return m.ID
	}
	m1, m2, m3, m4 := msg("explicit in older, auto in newer"), msg("auto in all three"), msg("person in older, agent in newer"), msg("one link")
	// The live mess: the person writes (t=10000), the agent creates B and C in the turn (11000, 12000)
	// and replies naming the older task (13000); the older server linked the reply to the named task,
	// both created tasks (agent links) and the person's message's task (auto).
	p, err := s.AddMessage(ctx, stream, NewMessage{Author: AuthorUser, Body: "do it", Words: "do it"})
	if err != nil {
		t.Fatal(err)
	}
	mB, mC := task("created in the turn B", 11000), task("created in the turn C", 12000)
	r := msg("named older")
	r2 := msg("named nothing")
	_, _ = s.db.ExecContext(ctx, `UPDATE messages SET created_at=10000 WHERE id=?`, p.ID)
	_, _ = s.db.ExecContext(ctx, `UPDATE messages SET created_at=13000 WHERE id IN (?, ?)`, r, r2)
	_, _ = s.db.ExecContext(ctx, `UPDATE messages SET created_at=500 WHERE id IN (?, ?, ?, ?)`, m1, m2, m3, m4)
	_, _ = s.db.ExecContext(ctx, `UPDATE tasks SET created_at=created_at/10 WHERE id IN (?, ?, ?)`, older, newer, newest)
	// The state before: the unique index is not there yet and messages have several links.
	if _, err := s.db.ExecContext(ctx, `DROP INDEX message_tasks_one`); err != nil {
		t.Fatal(err)
	}
	_, _ = s.db.ExecContext(ctx, `DELETE FROM settings WHERE key='v3_one_task'`)
	link := func(m, tk, source string) {
		if _, err := s.db.ExecContext(ctx, `INSERT INTO message_tasks(message_id, task_id, source, created_at) VALUES(?,?,?,?)`, m, tk, source, 5000); err != nil {
			t.Fatal(err)
		}
	}
	link(m1, older, LinkAgent)
	link(m1, newer, LinkAuto)
	link(m2, older, LinkAuto)
	link(m2, newest, LinkAuto)
	link(m2, newer, LinkAuto)
	link(m3, older, LinkPerson)
	link(m3, newer, LinkAgent)
	link(m4, older, LinkAuto)
	link(r, newest, LinkAuto)
	link(r, mB, LinkAgent)
	link(r, older, LinkAgent)
	link(r, mC, LinkAgent)
	link(r2, newest, LinkAuto)
	link(r2, mB, LinkAgent)
	link(r2, mC, LinkAgent)
	s.Close()

	for round := 0; round < 2; round++ { // idempotent
		s, err = Open(path)
		if err != nil {
			t.Fatal(err)
		}
		for m, want := range map[string]string{m1: older, m2: newest, m3: newer, m4: older, r: older, r2: mC} {
			tags, _ := s.TasksOf(ctx, []string{m})
			if len(tags[m]) != 1 || tags[m][0].TaskID != want {
				t.Fatalf("round %d: %s is in %+v, want %s", round, m, tags[m], want)
			}
		}
		var multi, dropped int
		_ = s.db.QueryRowContext(ctx, `SELECT count(*) FROM (SELECT message_id FROM message_tasks GROUP BY message_id HAVING count(*) > 1)`).Scan(&multi)
		_ = s.db.QueryRowContext(ctx, `SELECT count(*) FROM message_tasks_dropped`).Scan(&dropped)
		if multi != 0 || dropped != 9 {
			t.Fatalf("round %d: multi-linked %d, dropped %d", round, multi, dropped)
		}
		var kept string
		_ = s.db.QueryRowContext(ctx, `SELECT kept_task_id FROM message_tasks_dropped WHERE message_id=? AND task_id=?`, m3, older).Scan(&kept)
		if kept != newer {
			t.Fatalf("round %d: m3's dropped link says kept %q", round, kept)
		}
		// The index holds: a second link of a message is refused.
		if _, err := s.db.ExecContext(ctx, `INSERT INTO message_tasks(message_id, task_id, source, created_at) VALUES(?,?,?,?)`, m4, newer, LinkAuto, 1); err == nil {
			t.Fatalf("round %d: a second link was accepted", round)
		}
		s.Close()
	}
}

// LinkMessages moves a message to a task; PlaceMessages only places messages that are in no task.
func TestLinkMovesPlaceDoesNot(t *testing.T) {
	ctx := context.Background()
	s := newStore(t)
	sess, _ := s.CreateSession(ctx, "api", "/tmp/a", "u")
	stream, _ := s.StreamThread(ctx, sess.ID)
	a, _ := s.CreateTask(ctx, sess.ProjectID, sess.ID, TaskFields{Title: ptr("A")})
	b, _ := s.CreateTask(ctx, sess.ProjectID, sess.ID, TaskFields{Title: ptr("B")})
	m, _ := s.AddMessage(ctx, stream, agentMsg("hi"))
	if got, _ := s.PlaceMessages(ctx, a.ID, []string{m.ID}, LinkAuto); len(got) != 1 {
		t.Fatalf("place = %v", got)
	}
	if got, _ := s.PlaceMessages(ctx, b.ID, []string{m.ID}, LinkAuto); len(got) != 0 {
		t.Fatalf("place again = %v", got)
	}
	if cur, _ := s.TaskOfMessage(ctx, m.ID); cur != a.ID {
		t.Fatalf("in %s", cur)
	}
	if got, _ := s.LinkMessages(ctx, b.ID, []string{m.ID}, LinkPerson); len(got) != 1 {
		t.Fatalf("move = %v", got)
	}
	tags, _ := s.TasksOf(ctx, []string{m.ID})
	if len(tags[m.ID]) != 1 || tags[m.ID][0].TaskID != b.ID || tags[m.ID][0].Source != LinkPerson {
		t.Fatalf("after move: %+v", tags[m.ID])
	}
	if n, _ := s.TaskCount(ctx, a.ID); n != 0 {
		t.Fatalf("A still has %d", n)
	}
}
