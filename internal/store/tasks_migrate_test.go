package store

import (
	"context"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestV3Title(t *testing.T) {
	for _, c := range []struct{ name, subject, want string }{
		{"", "update readme", "update readme"},
		{"Readme", "update readme", "Readme"},
		{"", "first line\nsecond line", "first line"},
		{"", strings.Repeat("あ", 30) + "。" + strings.Repeat("い", 80), strings.Repeat("あ", 30) + "。"},
		{"", strings.Repeat("x", 100), strings.Repeat("x", 79) + "…"},
		{"", "  ", "Untitled"},
	} {
		if got := v3Title(c.name, c.subject); got != c.want {
			t.Errorf("v3Title(%q, %q) = %q, want %q", c.name, c.subject, got, c.want)
		}
	}
}

// The corrective migration (v3_migrated_2) on what the first v3 migration made: stale and done tasks
// it made go unless someone touched them; kept ones get a title and all their thread's messages;
// tasks the person or an agent made stay as they are.
func TestMigrateV3Fix(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "m.db")
	s, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	sess, _ := s.CreateSession(ctx, "api", "/tmp/a", "u")
	now := time.Now()
	old := ms(now.Add(-12 * 24 * time.Hour))
	firstMigration := now.Add(-10 * time.Minute)
	raw := "スマホだと、attachmentの画像をタッチしてもひらけない。もう少し大きく表示されるようにして、ピンチで拡大もできるようにしてほしい。"
	thread := func(subject, status string, updated int64) (string, []string) {
		th, m, err := s.CreateThread(ctx, sess.ID, subject, NewMessage{Author: AuthorUser, Body: subject, Words: subject})
		if err != nil {
			t.Fatal(err)
		}
		m2, _ := s.AddMessage(ctx, th.ID, agentMsg("on it"))
		_, _ = s.db.ExecContext(ctx, `UPDATE threads SET status=?, updated_at=? WHERE id=?`, status, updated, th.ID)
		_, _ = s.db.ExecContext(ctx, `UPDATE messages SET created_at=? WHERE thread_id=?`, updated, th.ID)
		return th.ID, []string{m.ID, m2.ID}
	}
	// What the first migration made: a task per thread / topic, the raw subject as title, all
	// messages linked (created_at = the message's), and a creation event.
	firstTask := func(origin, title, status string, mids []string) string {
		id := NewID("tsk")
		at := ms(firstMigration)
		if _, err := s.db.ExecContext(ctx, `INSERT INTO tasks(id, project_id, title, status, created_by, created_at, updated_at, origin) VALUES(?,?,?,?,?,?,?,?)`, id, sess.ProjectID, title, status, sess.ID, old, old, origin); err != nil {
			t.Fatal(err)
		}
		_, _ = s.db.ExecContext(ctx, `INSERT INTO task_agents VALUES(?,?,?,?)`, id, sess.ID, RoleAssigned, old)
		for _, m := range mids {
			_, _ = s.db.ExecContext(ctx, `INSERT INTO message_tasks SELECT id, ?, 'auto', created_at FROM messages WHERE id=?`, id, m)
		}
		_, _ = s.db.ExecContext(ctx, `INSERT INTO task_events(id, task_id, at, kind, text) VALUES(?,?,?,?,?)`, NewID("tev"), id, at-1000, "created", v3OldCreatedText)
		return id
	}
	staleTh, staleMsgs := thread(raw, ThreadWorking, old)
	stale := firstTask("thread:"+staleTh, oneLine(raw), TaskWorking, staleMsgs)
	keptTh, keptMsgs := thread("update readme\nand the screenshots", ThreadWorking, ms(now.Add(-time.Hour)))
	kept := firstTask("thread:"+keptTh, "update readme and the screenshots", TaskWorking, keptMsgs[:1])
	touchedTh, touchedMsgs := thread("old but the person put a message in it", ThreadWorking, old)
	touched := firstTask("thread:"+touchedTh, "old but the person put a message in it", TaskWorking, touchedMsgs)
	doneTh, doneMsgs := thread("Tasks pane", ThreadFinished, ms(now.Add(-time.Hour)))
	tp, _ := s.CreateTopic(ctx, doneTh, TopicFields{Title: ptr("Done topic"), Status: ptr("done"), AddMessageIDs: doneMsgs})
	doneTask := firstTask("topic:"+tp.ID, "Done topic", TaskDone, doneMsgs)
	// After the first migration: the person put a message in `touched`; an agent made a task.
	_, _ = s.LinkMessages(ctx, touched, []string{staleMsgs[0]}, LinkPerson)
	agentTask, err := s.CreateTask(ctx, sess.ProjectID, sess.ID, TaskFields{Title: ptr("Agent's own task")})
	if err != nil {
		t.Fatal(err)
	}
	_, _ = s.db.ExecContext(ctx, `UPDATE tasks SET updated_at=? WHERE id=?`, old, agentTask.ID)
	_, _ = s.db.ExecContext(ctx, `UPDATE threads SET subject='a reply' WHERE id=(SELECT id FROM threads WHERE kind='stream' LIMIT 1)`)
	stream, _ := s.StreamThread(ctx, sess.ID)
	_, _ = s.db.ExecContext(ctx, `UPDATE threads SET subject='a reply' WHERE id=?`, stream)
	_, _ = s.db.ExecContext(ctx, `UPDATE settings SET value=? WHERE key='v3_migrated'`, `"`+firstMigration.UTC().Format(time.RFC3339)+`"`)
	_, _ = s.db.ExecContext(ctx, `DELETE FROM settings WHERE key='v3_migrated_2'`)
	s.Close()

	for round := 0; round < 2; round++ { // idempotent
		s, err = Open(path)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := s.GetTask(ctx, stale); err != ErrNotFound {
			t.Fatalf("round %d: the stale, untouched task is still there: %v", round, err)
		}
		if _, err := s.GetTask(ctx, doneTask); err != ErrNotFound {
			t.Fatalf("round %d: the done topic's task is still there: %v", round, err)
		}
		k, err := s.GetTask(ctx, kept)
		if err != nil || k.Title != "update readme" {
			t.Fatalf("round %d: kept = %+v %v", round, k, err)
		}
		if ids, _ := s.TaskMessageIDs(ctx, kept); len(ids) != 2 {
			t.Fatalf("round %d: kept is about %v, want its whole thread", round, ids)
		}
		if evs, _ := s.TaskEvents(ctx, kept); len(evs) != 0 {
			t.Fatalf("round %d: events = %+v", round, evs)
		}
		if x, err := s.GetTask(ctx, touched); err != nil || x.Title != "old but the person put a message in it" {
			t.Fatalf("round %d: touched = %+v %v", round, x, err)
		}
		if ids, _ := s.TaskMessageIDs(ctx, touched); len(ids) != 3 {
			t.Fatalf("round %d: touched is about %v", round, ids)
		}
		if _, err := s.GetTask(ctx, agentTask.ID); err != nil {
			t.Fatalf("round %d: the agent's task: %v", round, err)
		}
		var subject string
		_ = s.db.QueryRowContext(ctx, `SELECT subject FROM threads WHERE id=?`, stream).Scan(&subject)
		if subject != "" {
			t.Fatalf("stream subject = %q", subject)
		}
		// Nothing of the older data is gone.
		var threads, msgs, topics int
		_ = s.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM threads WHERE kind!='stream'`).Scan(&threads)
		_ = s.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM messages`).Scan(&msgs)
		_ = s.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM topics`).Scan(&topics)
		if threads != 4 || msgs != 8 || topics != 1 {
			t.Fatalf("threads %d messages %d topics %d", threads, msgs, topics)
		}
		s.Close()
	}
}

// A database that still has the table under its older name gets it renamed, links and all.
func TestRenameMessageTags(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "r.db")
	s, _ := Open(path)
	sess, _ := s.CreateSession(ctx, "api", "/tmp/a", "u")
	th, m, _ := s.CreateThread(ctx, sess.ID, "x", agentMsg("hi"))
	_ = th
	task, _ := s.CreateTask(ctx, sess.ProjectID, sess.ID, TaskFields{Title: ptr("T")})
	_, _ = s.LinkMessages(ctx, task.ID, []string{m.ID}, LinkAgent)
	_, _ = s.db.ExecContext(ctx, `ALTER TABLE message_tasks RENAME TO message_tags`)
	s.Close()
	s, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	if ids, _ := s.TaskMessageIDs(ctx, task.ID); len(ids) != 1 {
		t.Fatalf("links after the rename: %v", ids)
	}
}
