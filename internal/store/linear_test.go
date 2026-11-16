package store

import (
	"context"
	"testing"
)

// A sync that read the link before the thread was unlinked (or linked to another issue) must not
// save it back.
func TestUpdateThreadLinkOnlyWhileLinked(t *testing.T) {
	ctx := context.Background()
	s := newStore(t)
	sess, _ := s.CreateSession(ctx, "a", "/a", "u-a")
	th, _, err := s.CreateThread(ctx, sess.ID, "hi", NewMessage{Author: AuthorAgent, Body: "hi"})
	if err != nil {
		t.Fatal(err)
	}
	if err := s.PutThreadLink(ctx, &ThreadLink{ThreadID: th.ID, IssueID: "iss_1", Identifier: "ENG-1"}); err != nil {
		t.Fatal(err)
	}
	k, err := s.GetThreadLink(ctx, th.ID)
	if err != nil {
		t.Fatal(err)
	}
	k.LastStatus = "working"
	if ok, err := s.UpdateThreadLink(ctx, k); !ok || err != nil {
		t.Fatalf("linked: %v %v", ok, err)
	}
	if got, _ := s.GetThreadLink(ctx, th.ID); got.LastStatus != "working" {
		t.Fatalf("not saved: %+v", got)
	}
	// Linked to another issue meanwhile: the old link is not written over it.
	if err := s.PutThreadLink(ctx, &ThreadLink{ThreadID: th.ID, IssueID: "iss_2", Identifier: "ENG-2"}); err != nil {
		t.Fatal(err)
	}
	if ok, err := s.UpdateThreadLink(ctx, k); ok || err != nil {
		t.Fatalf("other issue: %v %v", ok, err)
	}
	if got, _ := s.GetThreadLink(ctx, th.ID); got.IssueID != "iss_2" {
		t.Fatalf("overwritten: %+v", got)
	}
	// Unlinked meanwhile: stays unlinked.
	if err := s.DeleteThreadLink(ctx, th.ID); err != nil {
		t.Fatal(err)
	}
	k.IssueID = "iss_2"
	if ok, err := s.UpdateThreadLink(ctx, k); ok || err != nil {
		t.Fatalf("unlinked: %v %v", ok, err)
	}
	if s.HasThreadLink(ctx, th.ID) {
		t.Fatal("link came back")
	}
}
