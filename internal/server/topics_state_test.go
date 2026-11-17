package server

import (
	"context"
	"encoding/json"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/ryotarai/minbox/internal/store"
)

// The prompt says what the agent is doing now and carries the status rules: in progress only for
// work the agent is doing right now.
func TestBuildTopicsPromptAgentState(t *testing.T) {
	th := &store.Thread{Subject: "S", Status: store.ThreadFinished, Messages: []store.Message{{Author: store.AuthorAgent, Body: "Pushed."}}}
	since := time.Date(2026, 11, 17, 8, 5, 0, 0, time.UTC)
	p := buildTopicsPrompt(th, nil, topicsAgent{State: store.StatusIdle, Since: since})
	for _, want := range []string{
		"Agent state now: idle (its turn ended; it is waiting for the person) since 2026-11-17 08:05 UTC\n",
		"Thread status now: finished",
		"Status rules",
		"never keep \"in_progress\" just because a topic was in progress before",
		"\"in_progress\" ONLY when the agent is actively working on it right now",
		"AND the agent state now is working",
		"\"waiting_on_you\" ONLY when progress on it is blocked on the PERSON",
		":::question block",
		"log in, approve, run or test something themselves",
		"stopped, waiting for their reply",
		"NOT \"waiting_on_you\"",
		"\"let me know if…\"",
		"optional suggestions",
		"FYI notes",
		"unverified points in a finished report",
		"When unsure between \"waiting_on_you\" and \"done\", choose \"done\"",
		"\"done\" when the result was reported or delivered",
		"A question that was answered is done",
		"When unsure between \"in_progress\" and \"done\", choose \"done\"",
		"When the agent state now is idle, no topic can be \"in_progress\"",
		"only that specific topic",
	} {
		if !strings.Contains(p, want) {
			t.Errorf("prompt lacks %q:\n%s", want, p)
		}
	}
	if strings.Contains(p, "otherwise \"in_progress\"") {
		t.Error("the old default to in_progress is left")
	}
	if strings.Contains(p, "or \"waiting_on_you\" if a request to the person is open") || strings.Contains(p, "explicitly awaits the person's input") {
		t.Error("the old broad waiting_on_you rule is left")
	}
	for state, want := range map[string]string{
		store.StatusWorking: "Agent state now: working (",
		store.StatusEnded:   "Agent state now: idle (the session has ended)",
		"":                  "Agent state now: unknown\n",
	} {
		if p := buildTopicsPrompt(&store.Thread{Subject: "S"}, nil, topicsAgent{State: state}); !strings.Contains(p, want) || strings.Contains(p, "Thread status now") {
			t.Errorf("state %q: prompt lacks %q:\n%s", state, want, p)
		}
	}
}

// The agent's turn ends (the session goes idle): its threads with a topic in progress are extracted
// again, with the idle state in the prompt; threads with nothing in progress are not, and the run
// does not start another (no loop). Marking a thread finished by hand also runs it again.
func TestTopicsRerunOnIdleAndFinished(t *testing.T) {
	e := newEnv(t)
	e.srv.topics.debounce = 20 * time.Millisecond
	var mu sync.Mutex
	var prompts []string
	status := "in_progress"
	e.srv.topicsRun = func(_ context.Context, p string) ([]byte, error) {
		mu.Lock()
		defer mu.Unlock()
		prompts = append(prompts, p)
		// Every message shown is about the one topic (a done topic reopens only on a new one).
		ids, _ := json.Marshal(promptMessageIDs(p))
		return []byte(`{"structured_output":{"topics":[{"title":"Search UI","summary":"s","status":"` + status + `","message_ids":` + string(ids) + `}]}}`), nil
	}
	runs := func() int { mu.Lock(); defer mu.Unlock(); return len(prompts) }
	last := func() string { mu.Lock(); defer mu.Unlock(); return prompts[len(prompts)-1] }
	waitRuns := func(n int) {
		t.Helper()
		deadline := time.Now().Add(5 * time.Second)
		for runs() < n {
			if time.Now().After(deadline) {
				t.Fatalf("runs = %d, want %d", runs(), n)
			}
			time.Sleep(10 * time.Millisecond)
		}
		time.Sleep(50 * time.Millisecond) // let the store write land
	}
	agentStatus := func(sess *store.Session, st string) {
		t.Helper()
		if code, obj, _ := e.do("POST", "/api/agent/status", map[string]string{"status": st}, bearer(sess)); code != 200 {
			t.Fatalf("status: %d %v", code, obj)
		}
	}

	sess := e.createSession()
	agentStatus(sess, store.StatusWorking)
	th := e.send(sess, "", "Search", "Implementing search…", "working")
	waitRuns(1)
	if !strings.Contains(last(), "Agent state now: working") || !strings.Contains(last(), "Thread status now: working") {
		t.Fatalf("prompt:\n%s", last())
	}

	// The turn ends with no new message: the thread runs again, told the agent is idle.
	mu.Lock()
	status = "done"
	mu.Unlock()
	agentStatus(sess, store.StatusIdle)
	waitRuns(2)
	if p := last(); !strings.Contains(p, "Agent state now: idle (its turn ended; it is waiting for the person) since ") {
		t.Fatalf("prompt:\n%s", p)
	}
	tps, _ := e.srv.store.ThreadTopics(context.Background(), th)
	if len(tps) != 1 || tps[0].Status != store.TopicDone {
		t.Fatalf("topics = %+v", tps)
	}

	// Nothing in progress now: another idle (after working) or a finished mark runs nothing.
	agentStatus(sess, store.StatusWorking)
	agentStatus(sess, store.StatusIdle)
	if code, _, _ := e.do("POST", "/api/threads/"+th+"/status", map[string]any{"status": "finished"}, nil); code != 200 {
		t.Fatal("finished")
	}
	time.Sleep(200 * time.Millisecond)
	if runs() != 2 {
		t.Fatalf("runs = %d, want 2 (no run without a topic in progress, no loop)", runs())
	}

	// A topic in progress again (a new message); then the person marks the thread finished.
	mu.Lock()
	status = "in_progress"
	mu.Unlock()
	agentStatus(sess, store.StatusWorking)
	e.send(sess, th, "Search", "Investigating the index…", "working")
	waitRuns(3)
	mu.Lock()
	status = "done"
	mu.Unlock()
	if code, _, _ := e.do("POST", "/api/threads/"+th+"/status", map[string]any{"status": "finished"}, nil); code != 200 {
		t.Fatal("finished")
	}
	waitRuns(4)
	if !strings.Contains(last(), "Thread status now: finished") {
		t.Fatalf("prompt:\n%s", last())
	}
	time.Sleep(200 * time.Millisecond)
	if runs() != 4 {
		t.Fatalf("runs = %d, want 4 (no loop)", runs())
	}
}
