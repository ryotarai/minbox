package server

import (
	"context"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/ryotarai/minbox/internal/store"
)

func TestParseTopics(t *testing.T) {
	out := []byte(`{"type":"result","is_error":false,"result":"{}","structured_output":{"topics":[
		{"title":"  Search   UI ","summary":"Building\nthe box","status":"in_progress"},
		{"id":"tpc_1","title":"Index format","summary":"Pick one","status":"waiting"},
		{"title":"search ui","summary":"dup","status":"done"},
		{"title":"No status","summary":"x","status":"later"},
		{"title":"","summary":"x","status":"done"},
		"junk"
	]}}`)
	got, err := parseTopics(out)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 2 || got[0].Title != "Search UI" || got[0].Summary != "Building the box" || got[1].ID != "tpc_1" || got[1].Status != store.TopicWaitingOnYou {
		t.Fatalf("topics = %+v", got)
	}
	// The JSON in result (fenced), when there is no structured output.
	got, err = parseTopics([]byte("{\"result\":\"```json\\n{\\\"topics\\\":[{\\\"title\\\":\\\"A\\\",\\\"summary\\\":\\\"\\\",\\\"status\\\":\\\"done\\\"}]}\\n```\"}"))
	if err != nil || len(got) != 1 || got[0].Status != store.TopicDone {
		t.Fatalf("fenced = %+v %v", got, err)
	}
	// No topics is an answer.
	if got, err := parseTopics([]byte(`{"structured_output":{"topics":[]}}`)); err != nil || len(got) != 0 {
		t.Fatalf("empty = %+v %v", got, err)
	}
	for _, bad := range []string{``, `nope`, `{"is_error":true,"result":"boom"}`, `{"structured_output":{"questions":[]}}`} {
		if _, err := parseTopics([]byte(bad)); err == nil {
			t.Fatalf("%q parsed", bad)
		}
	}
}

func TestBuildTopicsPrompt(t *testing.T) {
	long := strings.Repeat("x", 5000)
	th := &store.Thread{Subject: "Search", Messages: []store.Message{
		{Author: store.AuthorAgent, Body: "OLDEST " + long},
		{Author: store.AuthorUser, Body: "full", Words: "please add search"},
		{Author: store.AuthorUser, Body: "!ls", Words: "!ls", Kind: store.KindCommand},
	}}
	for i := 0; i < 20; i++ {
		th.Messages = append(th.Messages, store.Message{Author: store.AuthorAgent, Body: long})
	}
	th.Messages = append(th.Messages, store.Message{Author: store.AuthorAgent, Body: "Which index?", Questions: nil})
	p := buildTopicsPrompt(th, []store.Topic{{ID: "tpc_1", Title: "Search UI", Summary: "Building", Status: store.TopicInProgress}})
	if !strings.HasPrefix(p, "Track the topics") || !strings.Contains(p, "id: tpc_1 | status: in_progress | title: Search UI") {
		t.Fatalf("prompt head:\n%s", p[:300])
	}
	if strings.Contains(p, "OLDEST") || !strings.Contains(p, "earlier ones left out") || !strings.Contains(p, "Which index?") {
		t.Fatal("the budget keeps the newest messages")
	}
	if n := len([]rune(p)); n > topicsMsgBudget+4000 {
		t.Fatalf("prompt is %d runes", n)
	}
	short := buildTopicsPrompt(&store.Thread{Subject: "S", Messages: th.Messages[1:3]}, nil)
	if !strings.Contains(short, "(none yet)") || !strings.Contains(short, "please add search") || !strings.Contains(short, "[PERSON ran a command") || strings.Contains(short, "left out") {
		t.Fatalf("short prompt:\n%s", short)
	}
}

func TestTopicerDebounce(t *testing.T) {
	var mu sync.Mutex
	runs := map[string]int{}
	var active, maxActive atomic.Int32
	release := make(chan struct{})
	block := atomic.Bool{}
	g := newTopicer(func(id string) {
		if id == "c" {
			n := active.Add(1)
			for {
				m := maxActive.Load()
				if n <= m || maxActive.CompareAndSwap(m, n) {
					break
				}
			}
			if block.Load() {
				<-release
			}
			defer active.Add(-1)
		}
		mu.Lock()
		runs[id]++
		mu.Unlock()
	})
	g.debounce, g.maxDelay = 40*time.Millisecond, 400*time.Millisecond
	count := func(id string) int { mu.Lock(); defer mu.Unlock(); return runs[id] }
	wait := func(cond func() bool) {
		t.Helper()
		for i := 0; i < 300 && !cond(); i++ {
			time.Sleep(10 * time.Millisecond)
		}
		if !cond() {
			t.Fatalf("timed out; runs = %v", runs)
		}
	}

	// A burst runs once, after it.
	for i := 0; i < 5; i++ {
		g.kick("a")
		time.Sleep(10 * time.Millisecond)
	}
	if count("a") != 0 {
		t.Fatal("ran during the burst")
	}
	wait(func() bool { return count("a") == 1 })
	time.Sleep(100 * time.Millisecond)
	if count("a") != 1 {
		t.Fatalf("burst ran %d times", count("a"))
	}

	// A steady stream still runs by maxDelay.
	start := time.Now()
	for time.Since(start) < 600*time.Millisecond {
		g.kick("b")
		time.Sleep(15 * time.Millisecond)
	}
	if count("b") < 1 {
		t.Fatal("a steady stream never ran")
	}

	// Messages during a run: one more run after it, never two at once for the thread.
	block.Store(true)
	g.kick("c")
	wait(func() bool { return active.Load() == 1 })
	g.kick("c")
	g.kick("c")
	time.Sleep(100 * time.Millisecond)
	if maxActive.Load() != 1 {
		t.Fatal("ran twice at once for one thread")
	}
	block.Store(false)
	close(release)
	wait(func() bool { return count("c") == 2 })
	time.Sleep(100 * time.Millisecond)
	if count("c") != 2 {
		t.Fatalf("c ran %d times", count("c"))
	}

	// Closed: nothing more runs.
	g.close()
	g.kick("d")
	time.Sleep(100 * time.Millisecond)
	if count("d") != 0 {
		t.Fatal("ran after close")
	}
}

func TestTopicsFlow(t *testing.T) {
	e := newEnv(t)
	e.srv.topics.debounce = 20 * time.Millisecond
	var prompts []string
	var mu sync.Mutex
	answer := `{"structured_output":{"topics":[{"title":"Search UI","summary":"Building","status":"in_progress"},{"title":"Index format","summary":"Pick one","status":"waiting_on_you"}]}}`
	e.srv.topicsRun = func(_ context.Context, p string) ([]byte, error) {
		mu.Lock()
		defer mu.Unlock()
		prompts = append(prompts, p)
		return []byte(answer), nil
	}
	ch := make(chan Event, 64)
	e.srv.hub.mu.Lock()
	e.srv.hub.subs[ch] = struct{}{}
	e.srv.hub.mu.Unlock()
	waitTopicsEvent := func(thread string) {
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

	sess := e.createSession()
	th := e.send(sess, "", "Search", "Shall I build search?", "need_action")
	waitTopicsEvent(th)
	_, obj, _ := e.do("GET", "/api/topics", nil, nil)
	ts := rows(t, obj, "topics")
	if len(ts) != 2 || ts[0]["thread_id"] != th || ts[0]["session_id"] != sess.ID || obj["enabled"] != true || obj["done_days"].(float64) != 7 {
		t.Fatalf("topics = %v", obj)
	}
	first := map[string]string{}
	for _, tp := range ts {
		first[tp["title"].(string)] = tp["id"].(string)
	}

	// The next message: the prompt carries the current topics; a topic moves to done, keeping its id.
	mu.Lock()
	answer = `{"structured_output":{"topics":[{"title":"Search UI","summary":"Shipped","status":"done"},{"title":"Index format","summary":"Pick one","status":"waiting_on_you"}]}}`
	mu.Unlock()
	e.send(sess, th, "Search", "Search is done.", "finished")
	waitTopicsEvent(th)
	mu.Lock()
	if !strings.Contains(prompts[len(prompts)-1], "id: "+first["Search UI"]) {
		t.Fatalf("prompt without the current topics:\n%s", prompts[len(prompts)-1])
	}
	mu.Unlock()
	_, obj, _ = e.do("GET", "/api/topics?project="+sess.ProjectID, nil, nil)
	ts = rows(t, obj, "topics")
	if len(ts) != 2 || ts[1]["id"] != first["Search UI"] || ts[1]["status"] != "done" {
		t.Fatalf("after = %v", ts)
	}
	if _, obj, _ = e.do("GET", "/api/topics?project=nope", nil, nil); len(obj["topics"].([]any)) != 0 {
		t.Fatalf("other project = %v", obj)
	}

	// A failed run keeps the topics.
	mu.Lock()
	answer = `not json`
	n := len(prompts)
	mu.Unlock()
	e.send(sess, th, "Search", "More.", "working")
	for i := 0; i < 200; i++ {
		mu.Lock()
		done := len(prompts) > n
		mu.Unlock()
		if done {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	time.Sleep(50 * time.Millisecond)
	if _, obj, _ = e.do("GET", "/api/topics", nil, nil); len(obj["topics"].([]any)) != 2 {
		t.Fatalf("after a failed run = %v", obj)
	}

	// Turned off: no run.
	e.do("PUT", "/api/settings", map[string]any{"topics": false}, nil)
	mu.Lock()
	n = len(prompts)
	mu.Unlock()
	e.send(sess, th, "Search", "Even more.", "working")
	time.Sleep(200 * time.Millisecond)
	mu.Lock()
	if len(prompts) != n {
		t.Fatal("ran while turned off")
	}
	mu.Unlock()

	// Archived threads: no run, and their topics are off the board.
	e.do("PUT", "/api/settings", map[string]any{"topics": true}, nil)
	if code, _, _ := e.do("POST", "/api/threads/"+th+"/archive", nil, nil); code != 200 {
		t.Fatal("archive")
	}
	e.send(sess, th, "Search", "Late.", "working")
	time.Sleep(200 * time.Millisecond)
	mu.Lock()
	if len(prompts) != n {
		t.Fatal("ran for an archived thread")
	}
	mu.Unlock()
	if _, obj, _ = e.do("GET", "/api/topics", nil, nil); len(obj["topics"].([]any)) != 0 {
		t.Fatalf("archived thread's topics shown: %v", obj)
	}
}
