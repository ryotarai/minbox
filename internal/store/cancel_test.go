package store

import (
	"context"
	"testing"
)

func TestCancelMessage(t *testing.T) {
	ctx := context.Background()
	s := newStore(t)
	sess, _ := s.CreateSession(ctx, "demo", "/tmp", "u")
	th, _, _ := s.CreateThread(ctx, sess.ID, "S", agentMsg("hello"))
	m1, _ := s.AddMessage(ctx, th.ID, NewMessage{Author: AuthorUser, Body: "one"})
	m2, _ := s.AddMessage(ctx, th.ID, NewMessage{Author: AuthorUser, Body: "two"})
	if ok, _ := s.Claim(ctx, sess.ID, m2.ID, "o"); !ok {
		t.Fatal("claim")
	}
	if _, err := s.CancelMessage(ctx, m2.ID); err != ErrNotFound {
		t.Fatalf("claimed message: %v", err)
	}
	if del, err := s.CancelMessage(ctx, m1.ID); err != nil || del {
		t.Fatalf("cancel: %v %v", del, err)
	}
	if _, err := s.GetMessage(ctx, m1.ID); err != ErrNotFound {
		t.Fatalf("still there: %v", err)
	}
	// A thread the person started goes with its only message.
	nt, first, _ := s.CreateThread(ctx, sess.ID, "Mine", NewMessage{Author: AuthorUser, Body: "x"})
	if del, err := s.CancelMessage(ctx, first.ID); err != nil || !del {
		t.Fatalf("cancel only: %v %v", del, err)
	}
	if _, err := s.GetThread(ctx, nt.ID); err != ErrNotFound {
		t.Fatalf("thread: %v", err)
	}
}
