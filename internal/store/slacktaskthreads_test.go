package store

import (
	"context"
	"path/filepath"
	"testing"
)

func TestSlackTaskThreadsSurviveARestart(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "db")
	s, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := s.PutSlackTaskThread(ctx, "dst_1", "tsk_a", "thr_1", SlackThread{ChannelID: "D1", TS: "1.1"}); err != nil {
		t.Fatal(err)
	}
	_ = s.PutSlackTaskThread(ctx, "dst_1", "tsk_b", "thr_1", SlackThread{ChannelID: "D1", TS: "2.2"})
	// A thread about no task of the same minbox thread is its own row.
	_ = s.PutSlackThread(ctx, "dst_1", "thr_1", SlackThread{ChannelID: "D1", TS: "3.3"})
	// Another agent writes about task A: the replies go to its stream from now on.
	if err := s.TouchSlackTaskThread(ctx, "dst_1", "tsk_a", "thr_2"); err != nil {
		t.Fatal(err)
	}
	refs, _ := s.ListSlackThreads(ctx, "dst_1")
	for _, r := range refs {
		_ = s.SetSlackRefCursor(ctx, "dst_1", r, "9."+r.TS)
	}
	s.Close()

	s, err = Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	a, ok, err := s.GetSlackTaskThread(ctx, "dst_1", "tsk_a")
	if !ok || err != nil || a.TS != "1.1" || a.ChannelID != "D1" || a.ThreadID != "thr_2" {
		t.Fatalf("task A = %+v %v %v", a, ok, err)
	}
	if b, ok, _ := s.GetSlackTaskThread(ctx, "dst_1", "tsk_b"); !ok || b.TS != "2.2" || b.ThreadID != "thr_1" {
		t.Fatalf("task B = %+v", b)
	}
	if n, ok, _ := s.GetSlackThread(ctx, "dst_1", "thr_1"); !ok || n.TS != "3.3" {
		t.Fatalf("no task = %+v", n)
	}
	refs, _ = s.ListSlackThreads(ctx, "dst_1")
	got := map[string]string{}
	for _, r := range refs {
		got[r.TaskID+"@"+r.ThreadID] = r.ReplyCursor
	}
	if len(refs) != 3 || got["tsk_a@thr_2"] != "9.1.1" || got["tsk_b@thr_1"] != "9.2.2" || got["@thr_1"] != "9.3.3" {
		t.Fatalf("refs = %v", got)
	}
	// A new thread for a task replaces its old one.
	_ = s.PutSlackTaskThread(ctx, "dst_1", "tsk_a", "thr_1", SlackThread{ChannelID: "D1", TS: "4.4"})
	if a, _, _ := s.GetSlackTaskThread(ctx, "dst_1", "tsk_a"); a.TS != "4.4" {
		t.Fatalf("replaced = %+v", a)
	}
	if refs, _ := s.ListSlackThreads(ctx, "dst_1"); len(refs) != 3 {
		t.Fatalf("rows = %d", len(refs))
	}
}

func TestSlackThreadsMigrateToTaskThreads(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "db")
	s, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	// The table as it was before tasks had Slack threads.
	for _, q := range []string{
		`DROP TABLE notification_slack_threads`,
		`CREATE TABLE notification_slack_threads (destination_id TEXT NOT NULL, minbox_thread_id TEXT NOT NULL, channel_id TEXT NOT NULL, ts TEXT NOT NULL, created_at INTEGER NOT NULL, last_notified_at INTEGER NOT NULL DEFAULT 0, reply_cursor TEXT NOT NULL DEFAULT '', PRIMARY KEY (destination_id, minbox_thread_id))`,
		`INSERT INTO notification_slack_threads VALUES('dst_1', 'thr_1', 'D1', '1.1', 1, 2, '1.5')`,
	} {
		if _, err := s.db.Exec(q); err != nil {
			t.Fatal(err)
		}
	}
	s.Close()
	s, err = Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	refs, err := s.ListSlackThreads(ctx, "dst_1")
	if err != nil || len(refs) != 1 || refs[0].ThreadID != "thr_1" || refs[0].TaskID != "" || refs[0].TS != "1.1" || refs[0].ReplyCursor != "1.5" {
		t.Fatalf("refs = %+v %v", refs, err)
	}
	if err := s.PutSlackTaskThread(ctx, "dst_1", "tsk_a", "thr_1", SlackThread{ChannelID: "D1", TS: "2.2"}); err != nil {
		t.Fatal(err)
	}
	if n, ok, _ := s.GetSlackThread(ctx, "dst_1", "thr_1"); !ok || n.TS != "1.1" {
		t.Fatalf("old row = %+v", n)
	}
}
