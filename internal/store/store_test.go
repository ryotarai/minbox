package store

import (
	"context"
	"path/filepath"
	"testing"
	"time"

	"github.com/ryotarai/minbox/internal/question"
)

func newStore(t *testing.T) *Store {
	t.Helper()
	s, err := Open(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { s.Close() })
	clock := time.UnixMilli(1_700_000_000_000)
	s.now = func() time.Time { clock = clock.Add(time.Millisecond); return clock }
	return s
}

const ask = ":::question\nA or B?\n- [ ] A\n- [ ] B\nRecommended: A\n:::"

func TestThreadFlow(t *testing.T) {
	ctx := context.Background()
	s := newStore(t)
	sess, err := s.CreateSession(ctx, "demo", "/tmp", "uuid-1")
	if err != nil {
		t.Fatal(err)
	}
	qs := question.Parse(ask)
	th, agentMsg, err := s.CreateThread(ctx, sess.ID, "Which approach?", NewMessage{Author: AuthorAgent, Body: ask, Questions: qs})
	if err != nil {
		t.Fatal(err)
	}

	got, err := s.GetSession(ctx, sess.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got.Unread != 1 || got.OpenQuestions != 1 || got.Waiting != 1 {
		t.Fatalf("unread=%d open=%d waiting=%d, want 1/1/1", got.Unread, got.OpenQuestions, got.Waiting)
	}

	if _, err := s.MarkThreadRead(ctx, th.ID); err != nil {
		t.Fatal(err)
	}
	answers := []question.Answer{{Key: qs[0].Key, Selected: []string{"A"}}}
	reply, err := s.AddMessage(ctx, th.ID, NewMessage{Author: AuthorUser, Body: "composed", Words: "go", Answers: answers, AnswersFor: agentMsg.ID})
	if err != nil {
		t.Fatal(err)
	}
	full, _ := s.GetThread(ctx, th.ID)
	if full.Section != SectionSent || full.OpenQuestions != 0 || full.LastDelivery != DeliveryQueued || full.LastBody != "go" {
		t.Fatalf("thread = %+v", full)
	}
	if a := full.Messages[0].AnswerState[qs[0].Key]; len(a.Selected) != 1 || a.Selected[0] != "A" {
		t.Fatalf("answer state = %+v", full.Messages[0].AnswerState)
	}

	pending, err := s.PendingForSession(ctx, sess.ID, "mod-1")
	if err != nil {
		t.Fatal(err)
	}
	if len(pending) != 1 || pending[0].ID != reply.ID || pending[0].Subject != "Which approach?" || pending[0].NewThread {
		t.Fatalf("pending = %+v", pending)
	}
	if pending[0].InReplyTo == nil || pending[0].InReplyTo.ID != agentMsg.ID {
		t.Fatalf("in_reply_to = %+v", pending[0].InReplyTo)
	}

	// Claim: one owner at a time.
	if ok, _ := s.Claim(ctx, sess.ID, reply.ID, "mod-1"); !ok {
		t.Fatal("claim failed")
	}
	if ok, _ := s.Claim(ctx, sess.ID, reply.ID, "mod-2"); ok {
		t.Fatal("a fresh claim must not be taken over")
	}
	if p, _ := s.PendingForSession(ctx, sess.ID, "mod-2"); len(p) != 0 {
		t.Fatalf("claimed message offered to another owner: %+v", p)
	}
	full, _ = s.GetThread(ctx, th.ID)
	if full.LastDelivery != DeliverySending {
		t.Fatalf("delivery = %s", full.LastDelivery)
	}
	if ok, _ := s.MarkDelivered(ctx, sess.ID, reply.ID); !ok {
		t.Fatal("deliver failed")
	}
	if ok, _ := s.MarkDelivered(ctx, sess.ID, reply.ID); !ok {
		t.Fatal("deliver must be idempotent")
	}
	if p, _ := s.PendingForSession(ctx, sess.ID, "mod-1"); len(p) != 0 {
		t.Fatalf("pending after delivery = %+v", p)
	}
	full, _ = s.GetThread(ctx, th.ID)
	if full.LastDelivery != DeliveryDelivered {
		t.Fatalf("delivery = %s", full.LastDelivery)
	}
}

func TestStaleClaimAndRelease(t *testing.T) {
	ctx := context.Background()
	s := newStore(t)
	sess, _ := s.CreateSession(ctx, "a", "/a", "u-a")
	_, msg, _ := s.CreateThread(ctx, sess.ID, "hi", NewMessage{Author: AuthorUser, Body: "do X", Words: "do X"})
	if ok, _ := s.Claim(ctx, sess.ID, msg.ID, "old"); !ok {
		t.Fatal("claim")
	}
	base := s.now()
	s.now = func() time.Time { return base.Add(ClaimTimeout + time.Second) }
	p, _ := s.PendingForSession(ctx, sess.ID, "new")
	if len(p) != 1 || !p[0].NewThread {
		t.Fatalf("stale claim should be offered again: %+v", p)
	}
	if ok, _ := s.Claim(ctx, sess.ID, msg.ID, "new"); !ok {
		t.Fatal("stale claim must be taken over")
	}
	if ok, _ := s.Release(ctx, sess.ID, msg.ID, "old"); ok {
		t.Fatal("only the owner releases")
	}
	if ok, _ := s.Release(ctx, sess.ID, msg.ID, "new"); !ok {
		t.Fatal("owner release")
	}
	if ok, _ := s.Claim(ctx, sess.ID, msg.ID, "other"); !ok {
		t.Fatal("released message can be claimed")
	}
}

func TestOtherSessionAndUndelivered(t *testing.T) {
	ctx := context.Background()
	s := newStore(t)
	a, _ := s.CreateSession(ctx, "a", "/a", "u-a")
	b, _ := s.CreateSession(ctx, "b", "/b", "u-b")
	th, msg, _ := s.CreateThread(ctx, a.ID, "hello", NewMessage{Author: AuthorUser, Body: "please do X"})
	if ok, _ := s.Claim(ctx, b.ID, msg.ID, "x"); ok {
		t.Fatal("another session must not claim this message")
	}
	if ok, _ := s.MarkDelivered(ctx, b.ID, msg.ID); ok {
		t.Fatal("another session must not deliver this message")
	}
	if _, _, err := s.CreateThread(ctx, "ses_missing", "x", NewMessage{Author: AuthorAgent, Body: "y"}); err != ErrNotFound {
		t.Fatalf("err = %v, want ErrNotFound", err)
	}
	_ = s.SetSessionEnded(ctx, a.ID, 0)
	got, _ := s.GetThread(ctx, th.ID)
	if got.LastDelivery != DeliveryUndelivered {
		t.Fatalf("delivery = %s", got.LastDelivery)
	}
}

func TestNewerAgentMessageClosesOldQuestions(t *testing.T) {
	ctx := context.Background()
	s := newStore(t)
	sess, _ := s.CreateSession(ctx, "a", "/a", "u")
	th, _, _ := s.CreateThread(ctx, sess.ID, "q", NewMessage{Author: AuthorAgent, Body: ask, Questions: question.Parse(ask)})
	_, _ = s.AddMessage(ctx, th.ID, NewMessage{Author: AuthorAgent, Body: "never mind, I decided", Status: ThreadNeedAction})
	got, _ := s.GetThread(ctx, th.ID)
	if got.OpenQuestions != 0 || got.Section != SectionWaiting || got.Status != ThreadNeedAction || got.Unread != 2 {
		t.Fatalf("thread = %+v", got)
	}
}

func TestSessionByToken(t *testing.T) {
	ctx := context.Background()
	s := newStore(t)
	a, _ := s.CreateSession(ctx, "a", "/a", "u-a")
	got, err := s.SessionByToken(ctx, a.Token)
	if err != nil || got.ID != a.ID || got.ClaudeSessionID != "u-a" {
		t.Fatalf("got %+v, %v", got, err)
	}
	if _, err := s.SessionByToken(ctx, ""); err != ErrNotFound {
		t.Fatalf("empty token: %v", err)
	}
	if _, err := s.SessionByToken(ctx, "nope"); err != ErrNotFound {
		t.Fatalf("unknown token: %v", err)
	}
}

func TestSortThreads(t *testing.T) {
	now := time.Now()
	ts := []Thread{
		{ID: "quiet", Section: SectionQuiet, UpdatedAt: now},
		{ID: "new", Section: SectionNew, UpdatedAt: now},
		{ID: "wait-old", Section: SectionWaiting, UpdatedAt: now.Add(-time.Hour)},
		{ID: "wait-new", Section: SectionWaiting, UpdatedAt: now},
	}
	SortThreads(ts)
	want := []string{"wait-new", "wait-old", "new", "quiet"}
	for i, id := range want {
		if ts[i].ID != id {
			t.Fatalf("order = %v", ts)
		}
	}
}
