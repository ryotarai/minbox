package server

import (
	"context"
	"encoding/json"
	"regexp"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/ryotarai/minbox/internal/store"
)

func TestBuildTopicsPromptManualHint(t *testing.T) {
	at := time.Date(2026, 11, 16, 9, 30, 0, 0, time.UTC)
	th := &store.Thread{Subject: "S", Messages: []store.Message{{Author: store.AuthorAgent, Body: "hi"}}}
	p := buildTopicsPrompt(th, []store.Topic{
		{ID: "tpc_1", Title: "Search UI", Status: store.TopicDone, ManualStatus: store.TopicDone, ManualAt: &at},
		{ID: "tpc_2", Title: "Index", Status: store.TopicInProgress},
	}, topicsAgent{})
	if !strings.Contains(p, "id: tpc_1 | status: done | title: Search UI | summary:  | moved by the PERSON by hand to done at 2026-11-16 09:30 UTC") ||
		!strings.Contains(p, "strong signal") || !strings.Contains(p, "only when new work or a new problem on it clearly appears") || strings.Contains(p, "title: Index | summary:  | moved") {
		t.Fatalf("prompt:\n%s", p)
	}
	if strings.Contains(buildTopicsPrompt(th, []store.Topic{{ID: "tpc_2", Title: "Index", Status: store.TopicInProgress}}, topicsAgent{}), "strong signal") {
		t.Fatal("hint without a manual move")
	}
}

// The person moves a card: PATCH stores it and publishes SSE; the next extraction is told about it;
// a move made while an extraction runs survives that extraction.
func TestTopicsManualMove(t *testing.T) {
	e := newEnv(t)
	e.srv.topics.debounce = 20 * time.Millisecond
	var mu sync.Mutex
	var prompts []string
	answer := `{"structured_output":{"topics":[{"title":"Search UI","summary":"Building","status":"in_progress"}]}}`
	var hold chan struct{} // while set, the run waits for it (after recording its prompt)
	started := make(chan struct{}, 4)
	e.srv.topicsRun = func(_ context.Context, p string) ([]byte, error) {
		mu.Lock()
		prompts = append(prompts, p)
		h, a := hold, answer
		mu.Unlock()
		started <- struct{}{}
		if h != nil {
			<-h
		}
		return []byte(a), nil
	}
	ch := make(chan Event, 64)
	e.srv.hub.mu.Lock()
	e.srv.hub.subs[ch] = struct{}{}
	e.srv.hub.mu.Unlock()
	waitEvent := func(thread string) {
		t.Helper()
		deadline := time.After(5 * time.Second)
		for {
			select {
			case ev := <-ch:
				if ev.Type == "topics" && ev.ThreadID == thread {
					return
				}
			case <-deadline:
				t.Fatal("no topics event")
			}
		}
	}
	topic := func() map[string]any {
		t.Helper()
		_, obj, _ := e.do("GET", "/api/topics", nil, nil)
		ts := rows(t, obj, "topics")
		if len(ts) != 1 {
			t.Fatalf("topics = %v", ts)
		}
		return ts[0]
	}

	sess := e.createSession()
	th := e.send(sess, "", "Search", "Building search.", "working")
	<-started
	waitEvent(th)
	id := topic()["id"].(string)

	// Errors.
	if code, _, _ := e.do("PATCH", "/api/topics/"+id, map[string]any{"status": "later"}, nil); code != 400 {
		t.Fatalf("bad status: %d", code)
	}
	if code, _, _ := e.do("PATCH", "/api/topics/tpc_nope", map[string]any{"status": "done"}, nil); code != 404 {
		t.Fatalf("unknown: %d", code)
	}
	// The move.
	code, obj, _ := e.do("PATCH", "/api/topics/"+id, map[string]any{"status": "done"}, nil)
	if code != 200 || obj["status"] != "done" || obj["manual_status"] != "done" || obj["done_at"] == nil || obj["manual_at"] == nil {
		t.Fatalf("patch = %d %v", code, obj)
	}
	waitEvent(th)
	if tp := topic(); tp["status"] != "done" || tp["manual_status"] != "done" {
		t.Fatalf("after move = %v", tp)
	}

	// The next message: the prompt tells of the move; the answer (here: keep it done) applies and
	// the marker stays (no new information moved it).
	mu.Lock()
	answer = `{"structured_output":{"topics":[{"title":"Search UI","summary":"Shipped","status":"done"}]}}`
	mu.Unlock()
	e.send(sess, th, "Search", "More on search.", "working")
	<-started
	waitEvent(th)
	mu.Lock()
	last := prompts[len(prompts)-1]
	mu.Unlock()
	if !strings.Contains(last, "id: "+id+" | status: done") || !strings.Contains(last, "moved by the PERSON by hand to done at") {
		t.Fatalf("prompt without the move:\n%s", last)
	}
	if tp := topic(); tp["status"] != "done" || tp["summary"] != "Shipped" || tp["manual_status"] != "done" || tp["manual_at"] == nil {
		t.Fatalf("after the run = %v", tp)
	}

	// A move while an extraction runs: the run (which did not know of it) answers in_progress, the
	// move to waiting_on_you holds and keeps its marker for the next run.
	h := make(chan struct{})
	mu.Lock()
	hold = h
	answer = `{"structured_output":{"topics":[{"title":"Search UI","summary":"Reopened","status":"in_progress"}]}}`
	mu.Unlock()
	e.send(sess, th, "Search", "Reopen?", "working")
	<-started
	if code, _, _ := e.do("PATCH", "/api/topics/"+id, map[string]any{"status": "waiting_on_you"}, nil); code != 200 {
		t.Fatal("patch during the run")
	}
	waitEvent(th)
	close(h)
	waitEvent(th)
	if tp := topic(); tp["status"] != "waiting_on_you" || tp["summary"] != "Reopened" || tp["manual_status"] != "waiting_on_you" {
		t.Fatalf("in-flight run overwrote the move: %v", tp)
	}
}

var promptMessageIDRe = regexp.MustCompile(`· id: (\S+)\]`)

// promptMessageIDs: the ids of the messages a topics prompt shows, oldest first.
func promptMessageIDs(p string) []string {
	out := []string{}
	for _, m := range promptMessageIDRe.FindAllStringSubmatch(p, -1) {
		out = append(out, m[1])
	}
	return out
}

// No new information, no move: a card moved to done by hand stays done through re-extractions
// with no new message about it (as on idle / finished), and moves only when a new message is
// linked to it; then the marker goes.
func TestTopicsManualDoneHoldsWithoutNewInfo(t *testing.T) {
	e := newEnv(t)
	e.srv.topics.debounce = 20 * time.Millisecond
	var mu sync.Mutex
	status, cite := "in_progress", "none" // cite: "none" or "newest" (the newest message shown)
	e.srv.topicsRun = func(_ context.Context, p string) ([]byte, error) {
		mu.Lock()
		defer mu.Unlock()
		ids := []string{}
		if all := promptMessageIDs(p); cite == "newest" && len(all) > 0 {
			ids = all[len(all)-1:]
		}
		b, _ := json.Marshal(ids)
		return []byte(`{"structured_output":{"topics":[{"title":"Search UI","summary":"s","status":"` + status + `","message_ids":` + string(b) + `}]}}`), nil
	}
	ctx := context.Background()
	one := func(th string) store.Topic {
		t.Helper()
		ts, _ := e.srv.store.ThreadTopics(ctx, th)
		if len(ts) != 1 {
			t.Fatalf("topics = %+v", ts)
		}
		return ts[0]
	}
	waitStatus := func(th, want string) store.Topic {
		t.Helper()
		deadline := time.Now().Add(5 * time.Second)
		for {
			if ts, _ := e.srv.store.ThreadTopics(ctx, th); len(ts) == 1 && ts[0].Status == want {
				return ts[0]
			}
			if time.Now().After(deadline) {
				t.Fatalf("status = %+v, want %s", one(th), want)
			}
			time.Sleep(10 * time.Millisecond)
		}
	}

	sess := e.createSession()
	th := e.send(sess, "", "Search", "Implementing the search UI…", "working")
	tp := waitStatus(th, store.TopicInProgress)
	if code, _, _ := e.do("PATCH", "/api/topics/"+tp.ID, map[string]any{"status": "done"}, nil); code != 200 {
		t.Fatal("patch")
	}

	// Re-extractions without a new message (what idle / finished run): the answer says
	// in_progress, the card stays done with its marker.
	e.srv.refreshTopics(th)
	mu.Lock()
	cite = "newest" // the only message shown is older than the move
	mu.Unlock()
	e.srv.refreshTopics(th)
	if tp := one(th); tp.Status != store.TopicDone || tp.ManualStatus != store.TopicDone || tp.ManualAt == nil {
		t.Fatalf("moved without new info: %+v", tp)
	}

	// A new message, linked to the topic: a new problem reopens it and the marker goes.
	e.send(sess, th, "Search", "The search UI crashes on empty input; fixing it.", "working")
	if tp := waitStatus(th, store.TopicInProgress); tp.ManualStatus != "" || tp.ManualAt != nil || tp.DoneAt != nil {
		t.Fatalf("after new info: %+v", tp)
	}
}
