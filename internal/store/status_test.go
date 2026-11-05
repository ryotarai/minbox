package store

import (
	"context"
	"path/filepath"
	"testing"

	"github.com/ryotarai/minbox/internal/question"
)

func TestThreadStatusRules(t *testing.T) {
	ctx := context.Background()
	s := newStore(t)
	sess, _ := s.CreateSession(ctx, "a", "/a", "u")
	status := func(id string) string {
		th, err := s.GetThread(ctx, id)
		if err != nil {
			t.Fatal(err)
		}
		return th.Status
	}

	// The person starts a thread: working.
	th, _, _ := s.CreateThread(ctx, sess.ID, "u", NewMessage{Author: AuthorUser, Body: "hi", Words: "hi"})
	if status(th.ID) != ThreadWorking {
		t.Fatalf("user thread = %s", status(th.ID))
	}
	// Agent message without status: unchanged.
	_, _ = s.AddMessage(ctx, th.ID, NewMessage{Author: AuthorAgent, Body: "on it"})
	if status(th.ID) != ThreadWorking {
		t.Fatalf("unchanged = %s", status(th.ID))
	}
	// With status.
	_, _ = s.AddMessage(ctx, th.ID, NewMessage{Author: AuthorAgent, Body: "done", Status: ThreadFinished})
	if status(th.ID) != ThreadFinished {
		t.Fatalf("finished = %s", status(th.ID))
	}
	// Questions: need_action; the person's answer: working.
	m, _ := s.AddMessage(ctx, th.ID, agentMsg(ask))
	if status(th.ID) != ThreadNeedAction {
		t.Fatalf("question = %s", status(th.ID))
	}
	got, _ := s.GetThread(ctx, th.ID)
	if got.Section != SectionWaiting {
		t.Fatalf("section = %s", got.Section)
	}
	sg, _ := s.GetSession(ctx, sess.ID)
	if sg.Waiting != 1 || sg.TopThread.Status != ThreadNeedAction {
		t.Fatalf("session = %+v", sg)
	}
	_, _ = s.AddMessage(ctx, th.ID, NewMessage{Author: AuthorUser, Body: "A", Words: "A", AnswersFor: m.ID,
		Answers: []question.Answer{{Key: m.Questions[0].Key, Selected: []string{"A"}}}})
	if status(th.ID) != ThreadWorking {
		t.Fatalf("answered = %s", status(th.ID))
	}
	// A note is not a reply.
	_ = s.SetThreadStatus(ctx, th.ID, ThreadFinished)
	_, _ = s.AddMessage(ctx, th.ID, NewMessage{Author: AuthorUser, Body: "+1", Kind: KindNote})
	if status(th.ID) != ThreadFinished {
		t.Fatalf("note = %s", status(th.ID))
	}
	// Explicit status wins over questions.
	m2 := agentMsg(ask)
	m2.Status = ThreadFinished
	_, _ = s.AddMessage(ctx, th.ID, m2)
	if status(th.ID) != ThreadFinished {
		t.Fatalf("explicit = %s", status(th.ID))
	}
	// Agent-started threads.
	a, _, _ := s.CreateThread(ctx, sess.ID, "a", NewMessage{Author: AuthorAgent, Body: "fyi"})
	b, _, _ := s.CreateThread(ctx, sess.ID, "b", agentMsg(ask))
	if status(a.ID) != ThreadFinished || status(b.ID) != ThreadNeedAction {
		t.Fatalf("agent threads = %s %s", status(a.ID), status(b.ID))
	}
	// By hand, with aliases; unknown is refused.
	if err := s.SetThreadStatus(ctx, a.ID, "in_progress"); err != nil || status(a.ID) != ThreadWorking {
		t.Fatalf("alias: %v %s", err, status(a.ID))
	}
	if err := s.SetThreadStatus(ctx, a.ID, "bogus"); err == nil {
		t.Fatal("bogus status accepted")
	}
	for in, want := range map[string]string{"done": ThreadFinished, "complete": ThreadFinished, "needs_action": ThreadNeedAction, "waiting": ThreadNeedAction, "WORKING": ThreadWorking, "blocked": ThreadBlocked, "stuck": ThreadBlocked} {
		if v, ok := NormalizeThreadStatus(in); !ok || v != want {
			t.Fatalf("%s -> %s", in, v)
		}
	}
}

func TestThreadStatusMigration(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "m.db")
	s, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	sess, _ := s.CreateSession(ctx, "a", "/a", "u")
	open, _, _ := s.CreateThread(ctx, sess.ID, "open", agentMsg(ask))
	plain, _, _ := s.CreateThread(ctx, sess.ID, "plain", NewMessage{Author: AuthorAgent, Body: "hello"})
	mine, _, _ := s.CreateThread(ctx, sess.ID, "mine", NewMessage{Author: AuthorUser, Body: "x", Words: "x"})
	// As a database from before the column: statuses NULL.
	if _, err := s.db.Exec(`UPDATE threads SET status=NULL`); err != nil {
		t.Fatal(err)
	}
	s.Close()
	for i := 0; i < 2; i++ { // twice: idempotent
		s, err = Open(path)
		if err != nil {
			t.Fatal(err)
		}
		for id, want := range map[string]string{open.ID: ThreadNeedAction, plain.ID: ThreadFinished, mine.ID: ThreadFinished} {
			th, _ := s.GetThread(ctx, id)
			if th.Status != want {
				t.Fatalf("round %d: %s = %s, want %s", i, th.Subject, th.Status, want)
			}
		}
		_ = s.SetThreadStatus(ctx, plain.ID, ThreadWorking) // a later change survives a reopen
		s.Close()
		s, _ = Open(path)
		if th, _ := s.GetThread(ctx, plain.ID); th.Status != ThreadWorking {
			t.Fatalf("status reset on reopen: %s", th.Status)
		}
		_ = s.SetThreadStatus(ctx, plain.ID, ThreadFinished)
		s.Close()
	}
}
