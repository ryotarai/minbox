package store

import (
	"context"
	"database/sql"
	"path/filepath"
	"sync"
	"testing"
	"time"
)

func TestReplaceTopicsKeepsIDs(t *testing.T) {
	ctx := context.Background()
	s := newStore(t)
	sess, _ := s.CreateSession(ctx, "alpha", "/tmp/a", "u")
	th, _, _ := s.CreateThread(ctx, sess.ID, "Search", agentMsg("hi"))

	changed, err := s.ReplaceTopics(ctx, th.ID, []TopicInput{
		{Title: "Search UI", Summary: "Building the box", Status: "in_progress"},
		{Title: "Index format", Summary: "Pick one", Status: "waiting"},
		{Title: "", Status: "done"},          // no title: dropped
		{Title: "Bad status", Status: "meh"}, // unknown status: dropped
	}, time.Time{})
	if err != nil || !changed {
		t.Fatalf("first: %v %v", changed, err)
	}
	cur, _ := s.ThreadTopics(ctx, th.ID)
	if len(cur) != 2 || cur[0].Title != "Search UI" || cur[1].Status != TopicWaitingOnYou {
		t.Fatalf("topics = %+v", cur)
	}
	searchID, indexID := cur[0].ID, cur[1].ID
	indexUpdated := cur[1].UpdatedAt

	// The same answer again changes nothing.
	changed, _ = s.ReplaceTopics(ctx, th.ID, []TopicInput{
		{Title: "Search UI", Summary: "Building the box", Status: "in_progress"},
		{Title: "Index format", Summary: "Pick one", Status: "waiting_on_you"},
	}, time.Time{})
	if changed {
		t.Fatal("unchanged answer reported a change")
	}

	// Matched by title (case and spacing do not count) and by id (a renamed topic); a new one; the
	// search topic is done.
	changed, _ = s.ReplaceTopics(ctx, th.ID, []TopicInput{
		{Title: "search  ui", Summary: "Shipped", Status: "done"},
		{ID: indexID, Title: "Index format (v2)", Summary: "Pick one", Status: "in_progress"},
		{Title: "Docs", Summary: "Write them", Status: "in_progress"},
	}, time.Time{})
	if !changed {
		t.Fatal("no change")
	}
	cur, _ = s.ThreadTopics(ctx, th.ID)
	if len(cur) != 3 || cur[0].ID != searchID || cur[0].Status != TopicDone || cur[0].DoneAt == nil || cur[1].ID != indexID || cur[1].Title != "Index format (v2)" {
		t.Fatalf("topics = %+v", cur)
	}
	if !cur[1].UpdatedAt.After(indexUpdated) {
		t.Fatal("updated_at kept on a change")
	}
	doneAt := *cur[0].DoneAt

	// Left out: an open topic goes, a done one stays (and keeps when it was done).
	_, _ = s.ReplaceTopics(ctx, th.ID, []TopicInput{{Title: "Docs", Summary: "Write them", Status: "in_progress"}}, time.Time{})
	cur, _ = s.ThreadTopics(ctx, th.ID)
	if len(cur) != 2 || cur[0].Title != "Docs" || cur[1].ID != searchID || !cur[1].DoneAt.Equal(doneAt) {
		t.Fatalf("after drop = %+v", cur)
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
	_, _ = s.ReplaceTopics(ctx, ta.ID, []TopicInput{{Title: "A1", Status: "in_progress"}, {Title: "A2", Status: "done"}}, time.Time{})
	_, _ = s.ReplaceTopics(ctx, tb.ID, []TopicInput{{Title: "B1", Status: "waiting_on_you"}, {Title: "B2", Status: "done"}}, time.Time{})
	_, _ = s.ReplaceTopics(ctx, tc.ID, []TopicInput{{Title: "C1", Status: "in_progress"}}, time.Time{})
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

func TestOnMessageHook(t *testing.T) {
	ctx := context.Background()
	s := newStore(t)
	var mu sync.Mutex
	var got []string
	s.OnMessage(func(id string) { mu.Lock(); got = append(got, id); mu.Unlock() })
	sess, _ := s.CreateSession(ctx, "alpha", "/tmp/a", "u")
	th, _, _ := s.CreateThread(ctx, sess.ID, "S", agentMsg("a"))
	_, _ = s.AddMessage(ctx, th.ID, NewMessage{Author: AuthorUser, Body: "ok"})
	_, _ = s.CreateCommandMessage(ctx, th.ID, "ls", "/tmp")
	mu.Lock()
	defer mu.Unlock()
	if len(got) != 3 || got[0] != th.ID || got[2] != th.ID {
		t.Fatalf("hook calls = %v", got)
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

func TestReplaceTopicsDetailTasksAndMessages(t *testing.T) {
	ctx := context.Background()
	s := newStore(t)
	sess, _ := s.CreateSession(ctx, "alpha", "/tmp/a", "u")
	th, _, _ := s.CreateThread(ctx, sess.ID, "Search", agentMsg("one"))
	other, _, _ := s.CreateThread(ctx, sess.ID, "Other", agentMsg("elsewhere"))
	full, _ := s.GetThread(ctx, th.ID)
	m1 := full.Messages[0].ID
	m2, _ := s.AddMessage(ctx, th.ID, NewMessage{Author: AuthorUser, Body: "two", Words: "two"})
	m3, _ := s.AddMessage(ctx, th.ID, agentMsg("three"))
	of, _ := s.GetThread(ctx, other.ID)
	foreign := of.Messages[0].ID

	// A new topic: detail, tasks (blank ones dropped), only this thread's messages, in its order.
	changed, err := s.ReplaceTopics(ctx, th.ID, []TopicInput{{Title: "Search UI", Status: "in_progress", Detail: " Building **the box**. ",
		Tasks:      []TopicTask{{Text: "Add the  field"}, {Text: " "}, {Text: "Wire results", Done: true}},
		MessageIDs: []string{m3.ID, foreign, "msg_nope", m1}}}, time.Time{})
	if err != nil || !changed {
		t.Fatalf("first: %v %v", changed, err)
	}
	cur, _ := s.ThreadTopics(ctx, th.ID)
	tp := cur[0]
	if tp.Detail != "Building **the box**." || len(tp.Tasks) != 2 || tp.Tasks[0].Text != "Add the field" || tp.Tasks[0].Done || !tp.Tasks[1].Done {
		t.Fatalf("topic = %+v", tp)
	}
	if len(tp.MessageIDs) != 2 || tp.MessageIDs[0] != m1 || tp.MessageIDs[1] != m3.ID {
		t.Fatalf("message ids = %v", tp.MessageIDs)
	}
	updated := tp.UpdatedAt

	// The next answer names other messages: they are added to the ones it had (merged, in order);
	// more related messages alone keep updated_at.
	s.now = func() time.Time { return updated.Add(time.Minute) }
	changed, _ = s.ReplaceTopics(ctx, th.ID, []TopicInput{{Title: "Search UI", Status: "in_progress", Detail: "Building **the box**.",
		Tasks: []TopicTask{{Text: "Add the field"}, {Text: "Wire results", Done: true}}, MessageIDs: []string{m2.ID}}}, time.Time{})
	cur, _ = s.ThreadTopics(ctx, th.ID)
	tp = cur[0]
	if !changed || len(tp.MessageIDs) != 3 || tp.MessageIDs[1] != m2.ID || !tp.UpdatedAt.Equal(updated) {
		t.Fatalf("merge: changed=%v %+v", changed, tp)
	}
	// The same answer again: no change. A task done: a change.
	if changed, _ = s.ReplaceTopics(ctx, th.ID, []TopicInput{{Title: "Search UI", Status: "in_progress", Detail: "Building **the box**.",
		Tasks: []TopicTask{{Text: "Add the field"}, {Text: "Wire results", Done: true}}}}, time.Time{}); changed {
		t.Fatal("unchanged answer reported a change")
	}
	changed, _ = s.ReplaceTopics(ctx, th.ID, []TopicInput{{Title: "Search UI", Status: "in_progress", Detail: "Building **the box**.",
		Tasks: []TopicTask{{Text: "Add the field", Done: true}, {Text: "Wire results", Done: true}}}}, time.Time{})
	cur, _ = s.ThreadTopics(ctx, th.ID)
	if !changed || !cur[0].Tasks[0].Done || !cur[0].UpdatedAt.After(updated) || len(cur[0].MessageIDs) != 3 {
		t.Fatalf("task done: %+v", cur[0])
	}

	// One topic with its thread's fields; its messages (a gone or foreign id left out).
	got, err := s.GetTopic(ctx, tp.ID)
	if err != nil || got.SessionID != sess.ID || got.ThreadSubject != "Search" || len(got.Tasks) != 2 {
		t.Fatalf("get = %+v %v", got, err)
	}
	if _, err := s.GetTopic(ctx, "tpc_nope"); err != ErrNotFound {
		t.Fatalf("missing = %v", err)
	}
	ms, err := s.TopicMessages(ctx, th.ID, []string{m3.ID, m2.ID, foreign})
	if err != nil || len(ms) != 2 || ms[0].ID != m2.ID || ms[0].Text != "two" || ms[0].Author != AuthorUser || ms[1].Text != "three" {
		t.Fatalf("messages = %+v %v", ms, err)
	}
}

func TestSetTopicStatusAndManualMarker(t *testing.T) {
	ctx := context.Background()
	s := newStore(t)
	sess, _ := s.CreateSession(ctx, "alpha", "/tmp/a", "u")
	th, _, _ := s.CreateThread(ctx, sess.ID, "Search", agentMsg("hi"))
	_, _ = s.ReplaceTopics(ctx, th.ID, []TopicInput{
		{Title: "Search UI", Status: "in_progress"},
		{Title: "Index", Status: "waiting_on_you"},
	}, time.Time{})
	cur, _ := s.ThreadTopics(ctx, th.ID)
	ui, idx := cur[0], cur[1]

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
	got, _ = s.SetTopicStatus(ctx, ui.ID, "done")
	moved := *got.ManualAt

	// An extraction that started before the move (it did not know of it): the move holds, the
	// marker stays, and the topic is not dropped when left out.
	before := moved.Add(-time.Second)
	_, _ = s.SetTopicStatus(ctx, idx.ID, "in_progress")
	if _, err := s.ReplaceTopics(ctx, th.ID, []TopicInput{{Title: "Search UI", Summary: "Building", Status: "in_progress"}}, before); err != nil {
		t.Fatal(err)
	}
	cur, _ = s.ThreadTopics(ctx, th.ID)
	if len(cur) != 2 || cur[0].ID != ui.ID || cur[0].Status != TopicDone || cur[0].Summary != "Building" || cur[0].ManualStatus != TopicDone || cur[1].ID != idx.ID || cur[1].Status != TopicInProgress || cur[1].ManualStatus == "" {
		t.Fatalf("in-flight = %+v", cur)
	}

	// An extraction that started after the move (it was told): its answer wins, the markers go.
	if _, err := s.ReplaceTopics(ctx, th.ID, []TopicInput{{Title: "Search UI", Summary: "Reopened", Status: "in_progress"}, {Title: "Index", Status: "waiting_on_you"}}, time.Time{}); err != nil {
		t.Fatal(err)
	}
	cur, _ = s.ThreadTopics(ctx, th.ID)
	if len(cur) != 2 || cur[0].Status != TopicInProgress || cur[0].DoneAt != nil || cur[0].ManualStatus != "" || cur[0].ManualAt != nil || cur[1].Status != TopicWaitingOnYou || cur[1].ManualStatus != "" {
		t.Fatalf("after = %+v", cur)
	}
}
