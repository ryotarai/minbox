package store

import (
	"context"
	"database/sql"
	"path/filepath"
	"testing"
	"time"
)

func ptr[T any](v T) *T { return &v }

// mk creates a topic with a title and status (the clock moves on a little, so the order of
// creation is the order of updated_at).
func mk(t *testing.T, s *Store, threadID, title, status string) *Topic {
	t.Helper()
	tp, err := s.CreateTopic(context.Background(), threadID, TopicFields{Title: &title, Status: &status})
	if err != nil {
		t.Fatal(err)
	}
	time.Sleep(2 * time.Millisecond)
	return tp
}

func TestCreateAndUpdateTopic(t *testing.T) {
	ctx := context.Background()
	s := newStore(t)
	sess, _ := s.CreateSession(ctx, "alpha", "/tmp/a", "u")
	th, m1, _ := s.CreateThread(ctx, sess.ID, "Search", agentMsg("hi"))
	_, m9, _ := s.CreateThread(ctx, sess.ID, "Other", agentMsg("other"))

	if _, err := s.CreateTopic(ctx, th.ID, TopicFields{Title: ptr("  ")}); err != ErrTopicTitle {
		t.Fatalf("no title: %v", err)
	}
	if _, err := s.CreateTopic(ctx, th.ID, TopicFields{Title: ptr("X"), Status: ptr("bogus")}); err != ErrInvalidTopicStatus {
		t.Fatalf("bad status: %v", err)
	}
	if _, err := s.CreateTopic(ctx, "thr_nope", TopicFields{Title: ptr("X")}); err != ErrNotFound {
		t.Fatalf("unknown thread: %v", err)
	}
	// Defaults: in progress; only the thread's own messages are linked.
	a, err := s.CreateTopic(ctx, th.ID, TopicFields{Title: ptr(" Search   UI "), Summary: ptr(" Building "), Detail: ptr("The **box**."),
		Tasks: &[]TopicTask{{Text: "Add the field", Done: true}, {Text: "  "}, {Text: "Show  results"}}, AddMessageIDs: []string{m1.ID, m9.ID, "msg_nope"}})
	if err != nil {
		t.Fatal(err)
	}
	if a.Title != "Search UI" || a.Summary != "Building" || a.Status != TopicInProgress || a.DoneAt != nil || a.Position != 0 || a.SessionID != sess.ID ||
		len(a.Tasks) != 2 || a.Tasks[1].Text != "Show results" || len(a.MessageIDs) != 1 || a.MessageIDs[0] != m1.ID {
		t.Fatalf("created = %+v", a)
	}
	b, _ := s.CreateTopic(ctx, th.ID, TopicFields{Title: ptr("Index"), Status: ptr("waiting")})
	if b.Position != 1 || b.Status != TopicWaitingOnYou || b.Tasks == nil || b.MessageIDs == nil {
		t.Fatalf("second = %+v", b)
	}

	// An update of nothing changes nothing.
	same, _ := s.UpdateTopic(ctx, a.ID, TopicFields{Title: ptr("Search UI")})
	if !same.UpdatedAt.Equal(a.UpdatedAt) {
		t.Fatal("updated_at moved without a change")
	}
	time.Sleep(2 * time.Millisecond)
	m2, _ := s.AddMessage(ctx, th.ID, NewMessage{Author: AuthorUser, Body: "two", Words: "two"})
	// More related messages alone: updated_at stays.
	u, _ := s.UpdateTopic(ctx, a.ID, TopicFields{AddMessageIDs: []string{m2.ID, m1.ID}})
	if len(u.MessageIDs) != 2 || u.MessageIDs[1] != m2.ID || !u.UpdatedAt.Equal(a.UpdatedAt) {
		t.Fatalf("messages = %+v", u)
	}
	u, err = s.UpdateTopic(ctx, a.ID, TopicFields{Status: ptr("done"), Tasks: &[]TopicTask{{Text: "All", Done: true}}})
	if err != nil || u.Status != TopicDone || u.DoneAt == nil || len(u.Tasks) != 1 || u.Summary != "Building" || !u.UpdatedAt.After(a.UpdatedAt) {
		t.Fatalf("done = %+v %v", u, err)
	}
	doneAt := *u.DoneAt
	u, _ = s.UpdateTopic(ctx, a.ID, TopicFields{Status: ptr("done"), Summary: ptr("Shipped")})
	if !u.DoneAt.Equal(doneAt) || u.Summary != "Shipped" {
		t.Fatalf("done again = %+v", u)
	}
	if _, err := s.UpdateTopic(ctx, a.ID, TopicFields{Title: ptr("")}); err != ErrTopicTitle {
		t.Fatalf("empty title: %v", err)
	}
	if _, err := s.UpdateTopic(ctx, a.ID, TopicFields{Status: ptr("nope")}); err != ErrInvalidTopicStatus {
		t.Fatalf("bad status: %v", err)
	}
	if _, err := s.UpdateTopic(ctx, "tpc_nope", TopicFields{}); err != ErrNotFound {
		t.Fatalf("unknown: %v", err)
	}

	// The person moves it by hand; the agent's next status replaces the move (the marker goes),
	// another change keeps it.
	moved, _ := s.SetTopicStatus(ctx, b.ID, "done")
	if moved.ManualStatus != TopicDone {
		t.Fatalf("moved = %+v", moved)
	}
	u, _ = s.UpdateTopic(ctx, b.ID, TopicFields{Summary: ptr("Picked FTS5")})
	if u.Status != TopicDone || u.ManualStatus != TopicDone || u.ManualAt == nil {
		t.Fatalf("summary only = %+v", u)
	}
	u, _ = s.UpdateTopic(ctx, b.ID, TopicFields{Status: ptr("in_progress")})
	if u.Status != TopicInProgress || u.ManualStatus != "" || u.ManualAt != nil || u.DoneAt != nil {
		t.Fatalf("agent status = %+v", u)
	}
	if id, _ := s.LatestMessageID(ctx, th.ID); id != m2.ID {
		t.Fatalf("latest = %q", id)
	}
	ts, _ := s.ThreadTopics(ctx, th.ID)
	if len(ts) != 2 || ts[0].ID != a.ID || ts[1].ID != b.ID {
		t.Fatalf("thread topics = %+v", ts)
	}
}

func TestListTopics(t *testing.T) {
	ctx := context.Background()
	s := newStore(t)
	a, _ := s.CreateSession(ctx, "alpha", "/tmp/a", "u")
	b, _ := s.CreateSession(ctx, "beta", "/tmp/b", "u2")
	ta, _, _ := s.CreateThread(ctx, a.ID, "A thread", agentMsg("a"))
	tb, _, _ := s.CreateThread(ctx, b.ID, "B thread", agentMsg("b"))
	tc, _, _ := s.CreateThread(ctx, b.ID, "Archived thread", agentMsg("c"))
	mk(t, s, ta.ID, "A1", "in_progress")
	mk(t, s, ta.ID, "A2", "done")
	mk(t, s, tb.ID, "B1", "waiting_on_you")
	mk(t, s, tb.ID, "B2", "done")
	mk(t, s, tc.ID, "C1", "in_progress")
	_ = s.SetThreadArchived(ctx, tc.ID, true)

	all, err := s.ListTopics(ctx, TopicQuery{})
	if err != nil {
		t.Fatal(err)
	}
	titles := func(ts []Topic) (out []string) {
		for _, t := range ts {
			out = append(out, t.Title)
		}
		return
	}
	// Open topics newest first, then done ones newest first; the archived thread's are left out.
	if got := titles(all); len(got) != 4 || got[0] != "B1" || got[1] != "A1" || got[2] != "B2" || got[3] != "A2" {
		t.Fatalf("all = %v", got)
	}
	if all[0].ThreadSubject != "B thread" || all[0].SessionID != b.ID || all[0].ProjectID == "" || all[0].ProjectName == "" {
		t.Fatalf("thread fields = %+v", all[0])
	}
	one, _ := s.ListTopics(ctx, TopicQuery{ProjectID: a.ProjectID})
	if got := titles(one); len(got) != 2 || got[0] != "A1" {
		t.Fatalf("project = %v", got)
	}
	th, _ := s.ListTopics(ctx, TopicQuery{ThreadID: tb.ID})
	if got := titles(th); len(got) != 2 || got[0] != "B1" || got[1] != "B2" {
		t.Fatalf("thread = %v", got)
	}
	// Done ones: only since a time, and at most so many.
	lim, _ := s.ListTopics(ctx, TopicQuery{DoneLimit: 1})
	if got := titles(lim); len(got) != 3 || got[2] != "B2" {
		t.Fatalf("limit = %v", got)
	}
	since, _ := s.ListTopics(ctx, TopicQuery{DoneSince: s.now().Add(time.Hour)})
	if got := titles(since); len(got) != 2 {
		t.Fatalf("since = %v", got)
	}
}

func TestSetTopicStatusAndManualMarker(t *testing.T) {
	ctx := context.Background()
	s := newStore(t)
	sess, _ := s.CreateSession(ctx, "alpha", "/tmp/a", "u")
	th, _, _ := s.CreateThread(ctx, sess.ID, "Search", agentMsg("hi"))
	ui := mk(t, s, th.ID, "Search UI", "in_progress")

	if _, err := s.SetTopicStatus(ctx, ui.ID, "bogus"); err != ErrInvalidTopicStatus {
		t.Fatalf("bad status: %v", err)
	}
	if _, err := s.SetTopicStatus(ctx, "tpc_nope", "done"); err != ErrNotFound {
		t.Fatalf("unknown: %v", err)
	}
	got, err := s.SetTopicStatus(ctx, ui.ID, "done")
	if err != nil || got.Status != TopicDone || got.DoneAt == nil || got.ManualStatus != TopicDone || got.ManualAt == nil || got.SessionID != sess.ID || !got.UpdatedAt.After(ui.UpdatedAt) {
		t.Fatalf("moved = %+v %v", got, err)
	}
	doneAt := *got.DoneAt
	// Done again keeps when it was done; back to in progress clears it.
	got, _ = s.SetTopicStatus(ctx, ui.ID, "done")
	if !got.DoneAt.Equal(doneAt) {
		t.Fatal("done_at moved")
	}
	got, _ = s.SetTopicStatus(ctx, ui.ID, "in_progress")
	if got.DoneAt != nil || got.ManualStatus != TopicInProgress {
		t.Fatalf("back = %+v", got)
	}
}

func TestTopicsMigrationAddsManualColumns(t *testing.T) {
	path := filepath.Join(t.TempDir(), "old-topics.db")
	db, err := sql.Open("sqlite", "file:"+path)
	if err != nil {
		t.Fatal(err)
	}
	// The topics table as its first release made it.
	if _, err := db.Exec(`CREATE TABLE topics (id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, title TEXT NOT NULL, summary TEXT NOT NULL DEFAULT '',
	  status TEXT NOT NULL, position INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, done_at INTEGER)`); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`INSERT INTO topics VALUES('tpc_old','thr_x','Old','s','in_progress',0,1,1,NULL)`); err != nil {
		t.Fatal(err)
	}
	db.Close()
	s, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	ts, err := s.ThreadTopics(context.Background(), "thr_x")
	if err != nil {
		t.Fatalf("after the migration: %v", err)
	}
	// The pane's columns too: no detail, no tasks, no related messages.
	if len(ts) != 1 || ts[0].Detail != "" || ts[0].Tasks == nil || len(ts[0].Tasks) != 0 || ts[0].MessageIDs == nil || len(ts[0].MessageIDs) != 0 {
		t.Fatalf("old topic = %+v", ts)
	}
}
