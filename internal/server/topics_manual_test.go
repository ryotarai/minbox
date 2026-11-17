package server

import (
	"context"
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
		!strings.Contains(p, "strong signal") || strings.Contains(p, "title: Index | summary:  | moved") {
		t.Fatalf("prompt:\n%s", p)
	}
	if strings.Contains(buildTopicsPrompt(th, []store.Topic{{ID: "tpc_2", Title: "Index", Status: store.TopicInProgress}}, topicsAgent{}), "strong signal") {
		t.Fatal("hint without a manual move")
	}
}

// The person moves a card: PATCH stores it and publishes SSE; the next extraction is told about it
// and its answer then wins; a move made while an extraction runs survives that extraction.
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
	// the marker is gone.
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
	if tp := topic(); tp["status"] != "done" || tp["summary"] != "Shipped" || tp["manual_status"] != "" || tp["manual_at"] != nil {
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
