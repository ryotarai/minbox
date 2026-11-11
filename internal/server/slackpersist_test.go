package server

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/ryotarai/minbox/internal/slackuser"
	"github.com/ryotarai/minbox/internal/store"
)

// restart replaces the Slack service by a new one over the same database, as a server restart does.
func (e *slEnv) restart() {
	e.t.Helper()
	old := e.srv.slack
	l := newSlackSvc(e.srv)
	l.cl.Base = old.cl.Base
	l.now, l.cl.Now, l.judgeRun = old.now, old.now, old.judgeRun
	e.srv.slack = l
}

func (e *slEnv) rows() (int, int) {
	th, _ := e.st.SlackThreads(context.Background())
	us, _ := e.st.SlackUsers(context.Background())
	return len(th), len(us)
}

func TestSlackFetchedDataSurvivesRestart(t *testing.T) {
	e := newSlEnv(t)
	e.connect()
	e.scenario()
	_, first := e.list("refresh=1")
	if th, us := e.rows(); th != 4 || us == 0 {
		t.Fatalf("stored threads %d users %d", th, us)
	}
	repl, hist, users, prompts := e.f.count("conversations.replies"), e.f.count("conversations.history"), e.f.count("users.info"), e.promptCount()
	if users == 0 {
		t.Fatal("no users.info calls in the first refresh")
	}
	e.restart()
	if len(e.srv.slack.threads) != 0 {
		t.Fatal("memory not empty after restart")
	}
	e.advance(30 * time.Second)
	_, second := e.list("refresh=1")
	if e.f.count("conversations.replies") != repl || e.f.count("conversations.history") != hist || e.f.count("users.info") != users || e.promptCount() != prompts {
		t.Errorf("re-read after restart: replies %d/%d history %d/%d users %d/%d prompts %d/%d", e.f.count("conversations.replies"), repl, e.f.count("conversations.history"), hist, e.f.count("users.info"), users, e.promptCount(), prompts)
	}
	if strings.Join(idsOf(first, ""), ",") != strings.Join(idsOf(second, ""), ",") {
		t.Errorf("list changed: %v vs %v", idsOf(first, ""), idsOf(second, ""))
	}
	a, b := first["items"].([]any)[0].(map[string]any), second["items"].([]any)[0].(map[string]any)
	if a["last_author"] != b["last_author"] || a["snippet"] != b["snippet"] {
		t.Errorf("row changed: %v vs %v", a, b)
	}
	// the DM's peer and unread state came back with the stored copy
	for _, it := range second["items"].([]any) {
		if m := it.(map[string]any); m["id"] == "D1:dm" && (m["unread"] != true || m["label"] != "DM with Alice") {
			t.Errorf("dm row %v", m)
		}
	}
	// a changed latest ts is read and judged again
	t1 := strings.TrimPrefix(idsOf(second, "needs_reply")[0], "C1:")
	e.bump(t1, e.ts(time.Minute, 9), "any update?")
	e.advance(30 * time.Second)
	e.list("refresh=1")
	if e.f.count("conversations.replies") != repl+1 || e.promptCount() != prompts+1 {
		t.Errorf("changed thread: replies %d (want %d) prompts %d (want %d)", e.f.count("conversations.replies"), repl+1, e.promptCount(), prompts+1)
	}
	// after the TTL a restart reads again (stale rows are refetched), but still judges nothing twice
	e.restart()
	e.advance(10 * time.Minute)
	repl = e.f.count("conversations.replies")
	prompts = e.promptCount()
	e.list("refresh=1")
	if e.f.count("conversations.replies") <= repl {
		t.Errorf("stale rows were not refetched")
	}
	if e.promptCount() != prompts {
		t.Errorf("unchanged threads judged again after restart")
	}
}

func TestSlackStaleRowShownWhenFetchFails(t *testing.T) {
	e := newSlEnv(t)
	e.connect()
	e.scenario()
	_, obj := e.list("refresh=1")
	id := idsOf(obj, "needs_reply")[0]
	e.restart()
	e.advance(time.Hour)
	e.f.mu.Lock()
	delete(e.f.replies, "C1:"+strings.TrimPrefix(id, "C1:"))
	e.f.mu.Unlock()
	if td, _, err := e.srv.slack.threadData(context.Background(), e.srv.slack.loadAuth(context.Background()), "C1", strings.TrimPrefix(id, "C1:"), false); err != nil || td == nil || len(td.Msgs) == 0 {
		t.Fatalf("stale copy unavailable: %v", err)
	}
}

func TestSlackFetchedDataClearedOnDisconnectAndReset(t *testing.T) {
	e := newSlEnv(t)
	e.connect()
	e.scenario()
	e.list("refresh=1")
	e.do("POST", "/api/integrations/slack-user/clear-cache", nil, nil)
	if th, us := e.rows(); th != 0 || us != 0 {
		t.Errorf("after clear-cache: %d threads %d users", th, us)
	}
	e.list("refresh=1")
	if th, _ := e.rows(); th == 0 {
		t.Fatal("not stored again")
	}
	if code, _, _ := e.do("POST", "/api/integrations/slack-user/disconnect", nil, nil); code != 200 {
		t.Fatalf("disconnect %d", code)
	}
	if th, us := e.rows(); th != 0 || us != 0 {
		t.Errorf("after disconnect: %d threads %d users", th, us)
	}
	if len(e.srv.slack.threads) != 0 {
		t.Error("memory kept")
	}
}

func TestSlackFetchedPruneAndCap(t *testing.T) {
	e := newSlEnv(t)
	e.connect()
	ctx := context.Background()
	if err := e.st.SaveSlackThread(ctx, store.SlackThreadRow{Channel: "C9", ThreadTS: "1.1", FetchedAt: time.Now().Add(-40 * 24 * time.Hour), Data: `{"Channel":"C9","ThreadTS":"1.1"}`}); err != nil {
		t.Fatal(err)
	}
	// the row is "seen" now by the store clock; prune with a cutoff in the future to prove the delete path
	if err := e.st.PruneSlackFetched(ctx, time.Now().Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	if th, _ := e.rows(); th != 0 {
		t.Errorf("not pruned: %d", th)
	}
	// a thread whose messages exceed the byte cap is stored trimmed, or not at all
	big := &slackThreadData{Channel: "C1", ThreadTS: "1.1", LatestTS: "1.2"}
	for i := 0; i < 40; i++ {
		big.Msgs = append(big.Msgs, slackuser.Message{TS: "1.1", Text: strings.Repeat("x", 50000)})
	}
	if s := capThreadJSON(big); s == "" || len(s) > slackThreadMaxBytes || strings.Contains(s, strings.Repeat("x", slackMsgTextMax+1)) {
		t.Errorf("40x50KB not trimmed: %d bytes", len(s))
	}
	mid := &slackThreadData{Channel: "C1", ThreadTS: "1.1"}
	for i := 0; i < 40; i++ {
		mid.Msgs = append(mid.Msgs, slackuser.Message{TS: "1.1", Text: strings.Repeat("y", 20000), Files: []slackuser.File{{Name: "f"}}})
	}
	if s := capThreadJSON(mid); s == "" || len(s) > slackThreadMaxBytes {
		t.Errorf("mid thread: %d bytes", len(s))
	}
}

func TestSlackPruneKeepsSeenThreads(t *testing.T) {
	e := newSlEnv(t)
	e.connect()
	e.scenario()
	e.list("refresh=1")
	e.advance(31 * 24 * time.Hour) // nothing seen for 31 days: the next run prunes what it did not see again
	e.f.mu.Lock()
	e.f.rtsPages["mention"], e.f.rtsPages["dm"], e.f.rtsPages["part"] = nil, nil, nil
	e.f.mu.Unlock()
	e.list("refresh=1")
	if th, _ := e.rows(); th != 0 {
		t.Errorf("unseen threads kept: %d", th)
	}
}
