package store

import (
	"context"
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
	})
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
	})
	if changed {
		t.Fatal("unchanged answer reported a change")
	}

	// Matched by title (case and spacing do not count) and by id (a renamed topic); a new one; the
	// search topic is done.
	changed, _ = s.ReplaceTopics(ctx, th.ID, []TopicInput{
		{Title: "search  ui", Summary: "Shipped", Status: "done"},
		{ID: indexID, Title: "Index format (v2)", Summary: "Pick one", Status: "in_progress"},
		{Title: "Docs", Summary: "Write them", Status: "in_progress"},
	})
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
	_, _ = s.ReplaceTopics(ctx, th.ID, []TopicInput{{Title: "Docs", Summary: "Write them", Status: "in_progress"}})
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
	_, _ = s.ReplaceTopics(ctx, ta.ID, []TopicInput{{Title: "A1", Status: "in_progress"}, {Title: "A2", Status: "done"}})
	_, _ = s.ReplaceTopics(ctx, tb.ID, []TopicInput{{Title: "B1", Status: "waiting_on_you"}, {Title: "B2", Status: "done"}})
	_, _ = s.ReplaceTopics(ctx, tc.ID, []TopicInput{{Title: "C1", Status: "in_progress"}})
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
