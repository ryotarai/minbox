package store

import (
	"context"
	"database/sql"
	"path/filepath"
	"testing"
)

// preV3 turns a database into what a minbox before v3 left: no task tables, no v3 columns, not
// migrated. The data written through the current code stays.
func preV3(t *testing.T, path string) {
	t.Helper()
	db, err := sql.Open("sqlite", "file:"+path)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	for _, q := range []string{
		`DROP TABLE task_events`, `DROP TABLE task_agents`, `DROP TABLE message_tasks`, `DROP TABLE tasks`,
		`ALTER TABLE messages DROP COLUMN decision`, `ALTER TABLE messages DROP COLUMN decision_task`, `ALTER TABLE messages DROP COLUMN turn_of`,
		`ALTER TABLE threads DROP COLUMN kind`, `DELETE FROM settings WHERE key='v3_migrated'`,
	} {
		if _, err := db.Exec(q); err != nil {
			t.Fatalf("%s: %v", q, err)
		}
	}
}

func TestMigrateV3(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "old.db")
	s, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	sess, _ := s.CreateSession(ctx, "api", "/tmp/a", "u")
	// A thread with a topic (two of its three messages related), done.
	th1, m1, _ := s.CreateThread(ctx, sess.ID, "Search", NewMessage{Author: AuthorUser, Body: "add search", Words: "add search"})
	m2, _ := s.AddMessage(ctx, th1.ID, agentMsg("on it"))
	m3, _ := s.AddMessage(ctx, th1.ID, agentMsg("unrelated aside"))
	tp, err := s.CreateTopic(ctx, th1.ID, TopicFields{Title: ptr("Search UI"), Status: ptr("done"), Tasks: &[]TopicTask{{Text: "Field", Done: true}}, AddMessageIDs: []string{m1.ID, m2.ID}})
	if err != nil {
		t.Fatal(err)
	}
	// An unfinished thread without topics: a task with every message.
	th2, n1, _ := s.CreateThread(ctx, sess.ID, "Fix flaky CI", agentMsg("CI is red. Which fix?\n\n:::question\nWhich?\n- [ ] A\n- [ ] B\n:::"))
	n2, _ := s.AddMessage(ctx, th2.ID, agentMsg("still looking"))
	_ = s.SetThreadStatus(ctx, th2.ID, "need_action")
	// A finished thread without topics: no task (a segment of the stream only).
	th3, _, _ := s.CreateThread(ctx, sess.ID, "Old chat", agentMsg("hello"))
	_ = s.SetThreadStatus(ctx, th3.ID, "finished")
	// Mark read: the agent messages before it are read.
	_ = s.SetAside(ctx, th3.ID)
	_, _ = s.db.ExecContext(ctx, `UPDATE messages SET read_at=NULL`)
	s.Close()
	preV3(t, path)

	s, err = Open(path)
	if err != nil {
		t.Fatal(err)
	}
	tasks, err := s.ListTasks(ctx, TaskQuery{})
	if err != nil {
		t.Fatal(err)
	}
	// Only current work becomes a task: the done topic does not (its row stays).
	if len(tasks) != 1 {
		t.Fatalf("tasks = %d: %+v", len(tasks), tasks)
	}
	_, _, _ = m1, m2, m3
	byTitle := map[string]Task{}
	for _, x := range tasks {
		byTitle[x.Title] = x
	}
	b := byTitle["Fix flaky CI"]
	if b.ProjectID != sess.ProjectID || len(b.Agents) != 1 || b.Agents[0].SessionID != sess.ID {
		t.Fatalf("thread task = %+v", b)
	}
	if b.Status != TaskNeedsYou {
		t.Fatalf("thread task = %+v", b)
	}
	if ids, _ := s.TaskMessageIDs(ctx, b.ID); len(ids) != 2 || ids[0] != n1.ID || ids[1] != n2.ID {
		t.Fatalf("thread tags = %v", ids)
	}
	if evs, _ := s.TaskEvents(ctx, b.ID); len(evs) != 0 {
		t.Fatalf("events = %+v", evs)
	}
	th, _ := s.GetThread(ctx, th3.ID)
	if th.Messages[0].ReadAt == nil {
		t.Fatal("a message before Mark read is unread")
	}
	_ = tp

	// Idempotent: opening again, or forgetting the marker, adds nothing.
	s.Close()
	s, _ = Open(path)
	_, _ = s.db.ExecContext(ctx, `DELETE FROM settings WHERE key='v3_migrated'`)
	s.Close()
	s, _ = Open(path)
	defer s.Close()
	again, _ := s.ListTasks(ctx, TaskQuery{})
	if len(again) != 1 {
		t.Fatalf("after a second migration: %d tasks", len(again))
	}
	var tags int
	_ = s.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM message_tasks`).Scan(&tags)
	if tags != 2 {
		t.Fatalf("links = %d", tags)
	}
	// The older data is all still there.
	var topics, threads, msgs int
	_ = s.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM topics`).Scan(&topics)
	_ = s.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM threads`).Scan(&threads)
	_ = s.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM messages`).Scan(&msgs)
	if topics != 1 || threads != 3 || msgs != 6 {
		t.Fatalf("topics %d threads %d messages %d", topics, threads, msgs)
	}
}

func TestTasksTagsAndTurn(t *testing.T) {
	ctx := context.Background()
	s := newStore(t)
	sess, _ := s.CreateSession(ctx, "api", "/tmp/a", "u")
	stream, err := s.StreamThread(ctx, sess.ID)
	if err != nil {
		t.Fatal(err)
	}
	if again, _ := s.StreamThread(ctx, sess.ID); again != stream {
		t.Fatal("a second stream thread")
	}
	a0, _ := s.AddMessage(ctx, stream, agentMsg("earlier"))
	u1, _ := s.AddMessage(ctx, stream, NewMessage{Author: AuthorUser, Body: "fix the gauge", Words: "fix the gauge"})
	u2, _ := s.AddMessage(ctx, stream, NewMessage{Author: AuthorUser, Body: "and the label", Words: "and the label"})
	// Not delivered yet: not in the turn.
	if ids, _ := s.TurnMessages(ctx, sess.ID); len(ids) != 0 {
		t.Fatalf("turn before delivery = %v", ids)
	}
	_, _ = s.MarkDelivered(ctx, sess.ID, u1.ID)
	_, _ = s.MarkDelivered(ctx, sess.ID, u2.ID)
	if ids, _ := s.TurnMessages(ctx, sess.ID); len(ids) != 2 || ids[0] != u1.ID || ids[1] != u2.ID {
		t.Fatalf("turn = %v", ids)
	}
	r1, _ := s.AddMessage(ctx, stream, agentMsg("on it"))
	// A second reply in the same turn still sees the person's messages.
	if ids, _ := s.TurnMessages(ctx, sess.ID); len(ids) != 2 {
		t.Fatalf("turn after a reply = %v", ids)
	}
	tk, err := s.CreateTask(ctx, sess.ProjectID, sess.ID, TaskFields{Title: ptr(" Fix  gauge "), Steps: &[]TaskStep{{Text: "Look", Steps: []TaskStep{{Text: "a", Done: true}, {Text: "b", Done: true}}}, {Text: "Fix"}}})
	if err != nil {
		t.Fatal(err)
	}
	if tk.Title != "Fix gauge" || !tk.Steps[0].Done || len(FlatSteps(tk.Steps)) != 4 || tk.Agents[0].Role != RoleAssigned {
		t.Fatalf("task = %+v", tk)
	}
	added, _ := s.LinkMessages(ctx, tk.ID, []string{u1.ID, r1.ID, u1.ID, "msg_nope"}, LinkAgent)
	if len(added) != 2 {
		t.Fatalf("added = %v", added)
	}
	tags, _ := s.TasksOf(ctx, []string{u1.ID, a0.ID})
	if len(tags[u1.ID]) != 1 || tags[u1.ID][0].Title != "Fix gauge" || len(tags[a0.ID]) != 0 {
		t.Fatalf("tags = %+v", tags)
	}
	// The person moves it to done by hand; then the agent's status replaces the mark.
	up, _ := s.UpdateTask(ctx, tk.ID, "", TaskFields{Status: ptr("done")})
	if up.Status != TaskDone || up.ManualStatus != TaskDone || up.DoneAt == nil {
		t.Fatalf("manual = %+v", up)
	}
	up, _ = s.UpdateTask(ctx, tk.ID, sess.ID, TaskFields{Status: ptr("in_progress")})
	if up.Status != TaskWorking || up.ManualStatus != "" || up.DoneAt != nil {
		t.Fatalf("agent = %+v", up)
	}
	evs, _ := s.TaskEvents(ctx, tk.ID)
	if len(evs) != 3 || evs[1].Text != "Status → done (you)" || evs[2].Text != "Status → working" {
		t.Fatalf("events = %+v", evs)
	}
	if ok, _ := s.UnlinkMessage(ctx, u1.ID, tk.ID); !ok {
		t.Fatal("untag")
	}
	// Stream questions stay open while the agent writes on.
	q, _ := s.AddMessage(ctx, stream, agentMsg("x\n\n:::question\nWhich?\n- [ ] A\n- [ ] B\n:::"))
	_, _ = s.AddMessage(ctx, stream, agentMsg("meanwhile, other work"))
	th, _ := s.GetThread(ctx, stream)
	if th.OpenQuestions != 1 || th.Kind != ThreadStream {
		t.Fatalf("open = %d kind %q (%s)", th.OpenQuestions, th.Kind, q.ID)
	}
	if n, _ := s.MarkMessagesRead(ctx, []string{q.ID, u1.ID}); n != 1 {
		t.Fatalf("read = %d", n)
	}
	// Mark unread from here: only agent messages, only read ones.
	if n, _ := s.MarkMessagesUnread(ctx, []string{q.ID, u1.ID}); n != 1 {
		t.Fatalf("unread = %d", n)
	}
	if n, _ := s.MarkMessagesUnread(ctx, []string{q.ID}); n != 0 {
		t.Fatalf("unread again = %d", n)
	}
}

// A database from before title_by gets the column; its tasks read as named by no one ("").
func TestMigrateTitleBy(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "old.db")
	s, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	tk, err := s.CreateTask(ctx, "", "", TaskFields{Title: ptr("Mine")})
	if err != nil || tk.TitleBy != TitleByPerson {
		t.Fatalf("%v %+v", err, tk)
	}
	if _, err := s.db.ExecContext(ctx, `ALTER TABLE tasks DROP COLUMN title_by`); err != nil {
		t.Fatal(err)
	}
	s.Close()
	s, err = Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	tk, err = s.GetTask(ctx, tk.ID)
	if err != nil || tk.TitleBy != "" || tk.Title != "Mine" {
		t.Fatalf("%v %+v", err, tk)
	}
}
