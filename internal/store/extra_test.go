package store

import (
	"context"
	"encoding/json"
	"path/filepath"
	"testing"
	"time"

	"github.com/ryotarai/minbox/internal/question"
)

func agentMsg(body string) NewMessage {
	return NewMessage{Author: AuthorAgent, Body: body, Questions: question.Parse(body)}
}

func TestSectionsAndSessionTop(t *testing.T) {
	ctx := context.Background()
	s := newStore(t)
	sess, _ := s.CreateSession(ctx, "demo", "/tmp", "u")

	stop, _, _ := s.CreateThread(ctx, sess.ID, "Stops", agentMsg(":::question\nGo?\nStopped: migration waits\n- [ ] Yes\n- [ ] No\n:::"))
	hold, _, _ := s.CreateThread(ctx, sess.ID, "Holds", agentMsg(":::question\nWhich?\nHolds up: api; ui\n- [ ] A\n- [ ] B\n:::"))
	act, _, _ := s.CreateThread(ctx, sess.ID, "Acts", agentMsg(":::actions\n- [ ] Label it\n:::"))
	news, _, _ := s.CreateThread(ctx, sess.ID, "News", agentMsg("done"))

	get := func(id string) *Thread {
		th, err := s.GetThread(ctx, id)
		if err != nil {
			t.Fatal(err)
		}
		return th
	}
	if th := get(stop.ID); th.Section != SectionStopped || !th.Stopped || th.OpenQuestions != 1 {
		t.Fatalf("stop = %+v", th)
	}
	if th := get(hold.ID); th.Section != SectionHolding || th.HoldsUp != 2 {
		t.Fatalf("hold = %+v", th)
	}
	if th := get(act.ID); th.Section != SectionWaiting || th.OpenActions != 1 || th.OpenQuestions != 0 {
		t.Fatalf("act = %+v", th)
	}
	if th := get(news.ID); th.Section != SectionNew {
		t.Fatalf("news = %+v", th)
	}
	got, _ := s.GetSession(ctx, sess.ID)
	if got.Section != SectionStopped || got.TopThread == nil || got.TopThread.ID != stop.ID || got.Stopped != 1 || got.Holding != 1 || got.Waiting != 3 {
		t.Fatalf("session = %+v top=%+v", got, got.TopThread)
	}

	// Mark read: quiet, its question closed; undo brings it back.
	if err := s.SetAside(ctx, stop.ID); err != nil {
		t.Fatal(err)
	}
	th := get(stop.ID)
	if th.Section != SectionQuiet || th.OpenQuestions != 0 || th.Messages[0].Closed[th.Messages[0].Questions[0].Key] != ClosedMarkedRead {
		t.Fatalf("set aside = %+v", th)
	}
	_ = s.UndoSetAside(ctx, stop.ID)
	if get(stop.ID).Section != SectionStopped {
		t.Fatal("undo set aside")
	}

	// Archive: archived; Claude writes again: came back.
	_ = s.SetThreadArchived(ctx, hold.ID, true)
	if th := get(hold.ID); th.Section != SectionArchived || th.Messages[0].Closed == nil {
		t.Fatalf("archived = %+v", th)
	}
	if _, err := s.AddMessage(ctx, hold.ID, agentMsg("more")); err != nil {
		t.Fatal(err)
	}
	if th := get(hold.ID); !th.CameBack || th.Section != SectionNew || th.ArchivedAt == nil {
		t.Fatalf("came back = %+v", th)
	}

	// Snooze until later; a reply wakes it.
	until := s.now().Add(time.Hour)
	_ = s.SnoozeThread(ctx, news.ID, &until)
	if get(news.ID).Section != SectionSnoozed {
		t.Fatal("snoozed")
	}
	_, _ = s.AddMessage(ctx, news.ID, NewMessage{Author: AuthorUser, Body: "ok", Words: "ok"})
	if th := get(news.ID); th.SnoozedUntil != nil || th.Section != SectionNew {
		t.Fatalf("woken = %+v", th)
	}
	got, _ = s.GetSession(ctx, sess.ID)
	if got.Undelivered != 1 {
		t.Fatalf("undelivered = %d", got.Undelivered)
	}

	// Pinned first within a section.
	_ = s.SetThreadPinned(ctx, act.ID, true)
	threads, _ := s.ListThreads(ctx, sess.ID)
	SortThreads(threads)
	if threads[0].ID != stop.ID {
		t.Fatalf("order = %v", threads[0].Subject)
	}
}

func TestReplacedQuestion(t *testing.T) {
	ctx := context.Background()
	s := newStore(t)
	sess, _ := s.CreateSession(ctx, "demo", "/tmp", "u")
	th, _, _ := s.CreateThread(ctx, sess.ID, "Q", agentMsg(":::question\nShip now?\n- [ ] Yes\n- [ ] No\n:::"))
	_, _ = s.AddMessage(ctx, th.ID, agentMsg(":::question\nShip today?\nReplaces: Ship now?\n- [ ] Yes\n- [ ] No\n:::"))
	got, _ := s.GetThread(ctx, th.ID)
	if got.Messages[0].Closed[got.Messages[0].Questions[0].Key] != ClosedReplaced || got.OpenQuestions != 1 {
		t.Fatalf("thread = %+v", got.Messages[0].Closed)
	}
}

func TestSessionArchiveAndRestart(t *testing.T) {
	ctx := context.Background()
	s := newStore(t)
	sess, _ := s.CreateSession(ctx, "demo", "/tmp", "u")
	_ = s.SetSessionEnded(ctx, sess.ID, 0)
	_ = s.SetSessionArchived(ctx, sess.ID, true)
	got, _ := s.GetSession(ctx, sess.ID)
	if got.Section != SectionArchived || got.ArchivedAt == nil {
		t.Fatalf("session = %+v", got)
	}
	_ = s.RestartSession(ctx, sess.ID)
	got, _ = s.GetSession(ctx, sess.ID)
	if got.ArchivedAt != nil || got.Section != SectionQuiet {
		t.Fatalf("restarted = %+v", got)
	}
}

func TestUrgentPending(t *testing.T) {
	ctx := context.Background()
	s := newStore(t)
	sess, _ := s.CreateSession(ctx, "demo", "/tmp", "u")
	th, m, _ := s.CreateThread(ctx, sess.ID, "S", NewMessage{Author: AuthorUser, Body: "hi", Words: "hi"})
	_ = th
	p, _ := s.PendingForSession(ctx, sess.ID, "o")
	if len(p) != 1 || p[0].Urgent {
		t.Fatalf("pending = %+v", p)
	}
	_ = s.SetUrgent(ctx, m.ID)
	p, _ = s.PendingForSession(ctx, sess.ID, "o")
	if !p[0].Urgent {
		t.Fatal("send now")
	}
	b, _ := json.Marshal(p[0])
	var v map[string]any
	_ = json.Unmarshal(b, &v)
	if v["urgent"] != true {
		t.Fatalf("json = %s", b)
	}
}

func TestSearchCardsSettings(t *testing.T) {
	ctx := context.Background()
	s := newStore(t)
	a, _ := s.CreateSession(ctx, "alpha", "/tmp", "u")
	b, _ := s.CreateSession(ctx, "beta", "/tmp", "u2")
	t1, m1, _ := s.CreateThread(ctx, a.ID, "アーカイブの扱い", agentMsg("アーカイブ済みに書いたら未読に戻しますか?"))
	_, _, _ = s.CreateThread(ctx, b.ID, "Other", agentMsg("nothing here"))
	att := &Attachment{ThreadID: t1.ID, MessageID: m1.ID, Kind: AttachmentFile, Name: "plan.md", Path: "/tmp/plan.md", Mime: "text/markdown"}
	if err := s.AddAttachment(ctx, att, []byte("未読 の 計画"), ""); err != nil {
		t.Fatal(err)
	}
	r, err := s.Search(ctx, SearchQuery{Q: "アーカイブ 未読"})
	if err != nil {
		t.Fatal(err)
	}
	if len(r.Threads) != 0 || len(r.Messages) != 1 || r.Messages[0].SessionName != "alpha" || r.Messages[0].Section != SectionNew {
		t.Fatalf("search = %+v", r)
	}
	r, _ = s.Search(ctx, SearchQuery{Q: "未読", SessionID: b.ID})
	if len(r.Messages)+len(r.Files) != 0 {
		t.Fatalf("scoped = %+v", r)
	}
	r, _ = s.Search(ctx, SearchQuery{Q: "計画"})
	if len(r.Files) != 1 || r.Files[0].AttachmentID != att.ID {
		t.Fatalf("files = %+v", r.Files)
	}
	th, _ := s.GetThread(ctx, t1.ID)
	if th.AttachmentCount != 1 || len(th.Messages[0].Attachments) != 1 {
		t.Fatalf("attachments = %+v", th.Messages[0].Attachments)
	}

	c := &Card{Title: "Search UI", Column: "designing", CreatedBy: "agent"}
	if err := s.CreateCard(ctx, c); err != nil {
		t.Fatal(err)
	}
	col := "dropped"
	got, err := s.UpdateCard(ctx, c.ID, CardPatch{Column: &col}, "agent")
	if err != nil || got.DroppedBy != "agent" {
		t.Fatalf("card = %+v %v", got, err)
	}
	cards, _ := s.ListCards(ctx, "")
	if len(cards) != 1 {
		t.Fatal(cards)
	}

	_ = s.PutSettings(ctx, map[string]json.RawMessage{"board": json.RawMessage("true")})
	st, _ := s.Settings(ctx)
	if string(st["board"]) != "true" {
		t.Fatal(st)
	}
}

func TestTokenHostsMustPairAgain(t *testing.T) {
	path := filepath.Join(t.TempDir(), "m.db")
	st, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	// A host added with a shared token, before pairing.
	if _, err := st.db.Exec(`INSERT INTO hosts(id,name,url,token,builtin,paired,created_at) VALUES('hst_old','old','http://x:4849','mbx_h_secret',0,1,0)`); err != nil {
		t.Fatal(err)
	}
	st.Close()
	st, err = Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	h, err := st.GetHost(context.Background(), "hst_old")
	if err != nil || h.Paired || h.PairingCode != "" {
		t.Fatalf("old token host = %+v %v", h, err)
	}
	var tok string
	_ = st.db.QueryRow(`SELECT token FROM hosts WHERE id='hst_old'`).Scan(&tok)
	if tok != "" {
		t.Fatalf("token kept: %q", tok)
	}
}
