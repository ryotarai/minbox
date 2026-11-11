package store

import (
	"context"
	"database/sql"
	"path/filepath"
	"testing"
)

func TestForkTableIsAdditiveAndSurvivesParentDeletion(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "f.db")
	s, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	a, _ := s.CreateSession(ctx, "a", "/tmp", "u1")
	b, _ := s.CreateSession(ctx, "b", "/tmp", "u2")
	parent, pm, err := s.CreateThread(ctx, a.ID, "Parent", NewMessage{Author: AuthorAgent, Body: "hello"})
	if err != nil {
		t.Fatal(err)
	}
	child, cm, err := s.CreateThreadWith(ctx, b.ID, "Child", NewMessage{Author: AuthorUser, Body: "go", Words: "go"}, func(tx *sql.Tx, th *Thread, m *Message) error {
		return s.InsertFork(ctx, tx, ThreadFork{ChildThreadID: th.ID, ParentThreadID: parent.ID, FromMessageID: pm.ID, FromSeq: 1, ParentSubject: "Parent",
			ParentProject: "proj", ParentSession: "a", Handoff: "HANDOFF", HandoffMessageID: m.ID})
	})
	if err != nil {
		t.Fatal(err)
	}
	if h, ok := s.ForkHandoffFor(ctx, cm.ID); !ok || h != "HANDOFF" {
		t.Fatalf("handoff = %q %v", h, ok)
	}
	if _, err := s.MarkDelivered(ctx, b.ID, cm.ID); err != nil {
		t.Fatal(err)
	}
	if _, ok := s.ForkHandoffFor(ctx, cm.ID); ok {
		t.Fatal("handoff still due after delivery")
	}
	got, _ := s.GetThread(ctx, child.ID)
	if got.ForkedFrom == nil || got.ForkedFrom.ThreadID != parent.ID || got.ForkedFrom.Gone || got.ForkedFrom.MessageGone {
		t.Fatalf("forked_from = %+v", got.ForkedFrom)
	}
	// Reopening the database (the migration runs again) keeps the rows.
	s.Close()
	s, err = Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	if f, _ := s.ForkedFromOf(ctx, child.ID); f == nil {
		t.Fatal("fork lost on reopen")
	}
	// Cancelling nothing, deleting the parent's session: the child keeps its snapshot.
	if err := s.DeleteSession(ctx, a.ID); err != nil {
		t.Fatal(err)
	}
	f, _ := s.ForkedFromOf(ctx, child.ID)
	if f == nil || !f.Gone || f.ThreadID != "" || f.Subject != "Parent" || f.ProjectName != "proj" || f.Seq != 1 {
		t.Fatalf("after delete: %+v", f)
	}
	// Deleting the child removes the link.
	if err := s.DeleteSession(ctx, b.ID); err != nil {
		t.Fatal(err)
	}
	var n int
	_ = s.db.QueryRow(`SELECT COUNT(*) FROM thread_forks`).Scan(&n)
	if n != 0 {
		t.Fatalf("%d links left", n)
	}
}
