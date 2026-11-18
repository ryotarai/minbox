package store

import (
	"context"
	"path/filepath"
	"testing"
	"time"
)

// The third migration (v3_migrated_3) puts every message in a task: an older thread's messages in its
// task (a done one made for a thread that has none), a stream's by turn or by the nearest message in
// time, a session with no task at all in one done task for its stream. Idempotent, nothing lost.
func TestMigrateV3Place(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "p.db")
	s, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	at := func(m *Message, d time.Duration) {
		_, _ = s.db.ExecContext(ctx, `UPDATE messages SET created_at=? WHERE id=?`, ms(now.Add(d)), m.ID)
	}
	a, _ := s.CreateSession(ctx, "api", "/tmp/a", "u")
	// An older thread with no task.
	oldTh, o1, _ := s.CreateThread(ctx, a.ID, "Fix the login page\nmore words", NewMessage{Author: AuthorUser, Body: "Fix the login page", Words: "Fix the login page"})
	o2, _ := s.AddMessage(ctx, oldTh.ID, agentMsg("done"))
	at(o1, -100*time.Hour)
	at(o2, -99*time.Hour)
	_, _ = s.db.ExecContext(ctx, `UPDATE threads SET created_at=?, updated_at=? WHERE id=?`, ms(now.Add(-100*time.Hour)), ms(now.Add(-99*time.Hour)), oldTh.ID)
	// An older thread whose task has only some of its messages.
	tTh, t1, _ := s.CreateThread(ctx, a.ID, "Gauge", NewMessage{Author: AuthorUser, Body: "gauge", Words: "gauge"})
	t2, _ := s.AddMessage(ctx, tTh.ID, agentMsg("on it"))
	gauge, _ := s.CreateTask(ctx, a.ProjectID, a.ID, TaskFields{Title: ptr("Gauge")})
	_, _ = s.LinkMessages(ctx, gauge.ID, []string{t1.ID}, LinkAgent)
	at(t1, -50*time.Hour)
	at(t2, -49*time.Hour)
	// The stream: a turn the agent put in a task, a quick exchange after it (no task: by turn_of),
	// and a lone agent message later (the nearest in time).
	stream, _ := s.StreamThread(ctx, a.ID)
	work, _ := s.CreateTask(ctx, a.ProjectID, a.ID, TaskFields{Title: ptr("Work")})
	p1, _ := s.AddMessage(ctx, stream, NewMessage{Author: AuthorUser, Body: "do the work", Words: "do the work"})
	r1, _ := s.AddMessage(ctx, stream, agentMsg("doing it"))
	_, _ = s.LinkMessages(ctx, work.ID, []string{p1.ID, r1.ID}, LinkAgent)
	p2, _ := s.AddMessage(ctx, stream, NewMessage{Author: AuthorUser, Body: "thanks", Words: "thanks"})
	r2, _ := s.AddMessage(ctx, stream, agentMsg("you're welcome"))
	_ = s.SetDecision(ctx, r2.ID, DecisionNone, "", []string{p2.ID})
	r3, _ := s.AddMessage(ctx, stream, agentMsg("by the way"))
	at(p1, -3*time.Hour)
	at(r1, -3*time.Hour+time.Minute)
	at(p2, -2*time.Hour)
	at(r2, -2*time.Hour+time.Minute)
	at(r3, -time.Hour)
	// A session with no task at all.
	b, _ := s.CreateSession(ctx, "api", "/tmp/b", "u")
	bs, _ := s.StreamThread(ctx, b.ID)
	b1, _ := s.AddMessage(ctx, bs, NewMessage{Author: AuthorUser, Body: "what time is it?", Words: "what time is it?"})
	b2, _ := s.AddMessage(ctx, bs, agentMsg("noon"))
	_, _ = s.db.ExecContext(ctx, `DELETE FROM settings WHERE key='v3_migrated_3'`)
	if n, _ := s.CountUnlinked(ctx); n != 8 {
		t.Fatalf("unlinked before = %d", n)
	}
	s.Close()

	tasks := 0
	for round := 0; round < 2; round++ {
		s, err = Open(path)
		if err != nil {
			t.Fatal(err)
		}
		if n, _ := s.CountUnlinked(ctx); n != 0 {
			t.Fatalf("round %d: unlinked after = %d", round, n)
		}
		var oldTask string
		_ = s.db.QueryRowContext(ctx, `SELECT id FROM tasks WHERE origin=?`, "thread:"+oldTh.ID).Scan(&oldTask)
		ot, err := s.GetTask(ctx, oldTask)
		if err != nil || ot.Status != TaskDone || ot.Title != "Fix the login page" || ot.DoneAt == nil || ot.DoneAt.After(now.Add(-90*time.Hour)) {
			t.Fatalf("round %d: the older thread's task = %+v %v", round, ot, err)
		}
		want := map[string]string{o1.ID: oldTask, o2.ID: oldTask, t2.ID: gauge.ID, p2.ID: work.ID, r2.ID: work.ID, r3.ID: work.ID}
		tags, _ := s.TasksOf(ctx, []string{o1.ID, o2.ID, t2.ID, p2.ID, r2.ID, r3.ID, b1.ID, b2.ID})
		for id, tid := range want {
			if len(tags[id]) != 1 || tags[id][0].TaskID != tid {
				t.Fatalf("round %d: %s in %+v, want %s", round, id, tags[id], tid)
			}
		}
		if len(tags[b1.ID]) != 1 || len(tags[b2.ID]) != 1 || tags[b1.ID][0].TaskID != tags[b2.ID][0].TaskID || tags[b1.ID][0].Title != "what time is it?" || tags[b1.ID][0].Status != TaskDone {
			t.Fatalf("round %d: the taskless session = %+v %+v", round, tags[b1.ID], tags[b2.ID])
		}
		var n, msgs int
		_ = s.db.QueryRowContext(ctx, `SELECT count(*) FROM tasks`).Scan(&n)
		_ = s.db.QueryRowContext(ctx, `SELECT count(*) FROM messages`).Scan(&msgs)
		if round == 0 {
			tasks = n
		}
		if n != 4 || n != tasks || msgs != 11 {
			t.Fatalf("round %d: tasks %d messages %d", round, n, msgs)
		}
		// Runs again on the next open: nothing changes.
		_, _ = s.db.ExecContext(ctx, `DELETE FROM settings WHERE key='v3_migrated_3'`)
		s.Close()
	}
}

// Unplaced messages: in no task, not minbox's requests, not the person's messages on their way.
func TestUnplacedMessages(t *testing.T) {
	ctx := context.Background()
	s := newStore(t)
	a, _ := s.CreateSession(ctx, "api", "/tmp/a", "u")
	stream, _ := s.StreamThread(ctx, a.ID)
	queued, _ := s.AddMessage(ctx, stream, NewMessage{Author: AuthorUser, Body: "later", Words: "later"})
	r, _ := s.AddMessage(ctx, stream, agentMsg("hi"))
	_, _ = s.AddMessage(ctx, stream, NewMessage{Author: AuthorUser, Body: "place them", Kind: KindPlace, Delivered: true})
	got, err := s.UnplacedMessages(ctx, a.ID)
	if err != nil || len(got) != 1 || got[0].ID != r.ID {
		t.Fatalf("unplaced = %+v %v (queued %s)", got, err, queued.ID)
	}
	reqs, _ := s.OpenPlaceRequests(ctx, a.ID)
	if len(reqs) != 1 {
		t.Fatalf("requests = %+v", reqs)
	}
}
