package server

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/ryotarai/minbox/internal/question"
	"github.com/ryotarai/minbox/internal/store"
)

func TestBuildSuggestPrompt(t *testing.T) {
	th := &store.Thread{Subject: "Pick a DB"}
	for i := 0; i < 20; i++ {
		th.Messages = append(th.Messages, store.Message{Author: store.AuthorAgent, Body: fmt.Sprintf("agent-%d", i)})
		th.Messages = append(th.Messages, store.Message{Author: store.AuthorUser, Body: fmt.Sprintf("composed-%d", i), Words: fmt.Sprintf("words-%d", i)})
	}
	th.Messages = append(th.Messages, store.Message{
		Author: store.AuthorAgent, Body: strings.Repeat("あ", 3000),
		Questions: []question.Question{{Key: "q", Prompt: "Which?", Choices: []question.Choice{{Label: "Postgres"}, {Label: "SQLite"}}}},
	})
	p := buildSuggestPrompt(th)
	if strings.Contains(p, "agent-0\n") || strings.Contains(p, "words-0\n") {
		t.Error("old messages are in the prompt")
	}
	if got := strings.Count(p, "[AGENT]") + strings.Count(p, "[PERSON]"); got != suggestMsgCount {
		t.Errorf("messages = %d", got)
	}
	if strings.Contains(p, "composed-19") || !strings.Contains(p, "words-19") {
		t.Error("the person's own words should be used")
	}
	if strings.Count(p, "あ") != suggestMsgLen || !strings.Contains(p, "あ…") {
		t.Errorf("long message not truncated to %d runes", suggestMsgLen)
	}
	for _, want := range []string{"Subject: Pick a DB", "Open question: Which?", "option: Postgres", "option: SQLite", "language the PERSON used"} {
		if !strings.Contains(p, want) {
			t.Errorf("prompt lacks %q", want)
		}
	}
}

func TestParseSuggestions(t *testing.T) {
	long := strings.Repeat("x", 300)
	cases := []struct {
		name, in string
		want     []string
		err      bool
	}{
		{"structured", `{"is_error":false,"structured_output":{"suggestions":["a","b"]}}`, []string{"a", "b"}, false},
		{"result string", `{"result":"{\"suggestions\":[\"a\"]}"}`, []string{"a"}, false},
		{"extra fields", `{"type":"result","x":1,"structured_output":{"suggestions":[" a ","b"],"note":"hi"}}`, []string{"a", "b"}, false},
		{"more than 3, dupes, empties", `{"structured_output":{"suggestions":["a","A","","  ","b",3,"c","d"]}}`, []string{"a", "b", "c"}, false},
		{"long", `{"structured_output":{"suggestions":["` + long + `"]}}`, []string{strings.Repeat("x", suggestMaxLen) + "…"}, false},
		{"none", `{"structured_output":{"suggestions":[]}}`, nil, true},
		{"not json", `hello`, nil, true},
		{"bad result", `{"result":"nope"}`, nil, true},
		{"is_error", `{"is_error":true,"result":"boom"}`, nil, true},
	}
	for _, c := range cases {
		got, err := parseSuggestions([]byte(c.in))
		if (err != nil) != c.err {
			t.Errorf("%s: err = %v", c.name, err)
			continue
		}
		if strings.Join(got, "|") != strings.Join(c.want, "|") {
			t.Errorf("%s: got %q want %q", c.name, got, c.want)
		}
	}
}

func TestSuggesterCacheAndSingleflight(t *testing.T) {
	var runs atomic.Int32
	release := make(chan struct{})
	g := newSuggester(func(ctx context.Context, prompt string) ([]string, error) {
		runs.Add(1)
		<-release
		return []string{"ok"}, nil
	})
	var wg sync.WaitGroup
	var fresh atomic.Int32
	for i := 0; i < 5; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			res, f, err := g.get(context.Background(), "k", "p")
			if err != nil || len(res) != 1 {
				t.Errorf("get: %v %v", res, err)
			}
			if f {
				fresh.Add(1)
			}
		}()
	}
	time.Sleep(50 * time.Millisecond)
	close(release)
	wg.Wait()
	if runs.Load() != 1 || fresh.Load() != 1 {
		t.Fatalf("runs = %d fresh = %d", runs.Load(), fresh.Load())
	}
	if _, f, _ := g.get(context.Background(), "k", "p"); f || runs.Load() != 1 {
		t.Fatal("second call should come from the cache")
	}
	now := time.Now()
	g.now = func() time.Time { return now.Add(suggestCacheTTL + time.Second) }
	g.get(context.Background(), "k", "p")
	if runs.Load() != 2 {
		t.Fatalf("expired entry not rerun: %d", runs.Load())
	}
	g.now = time.Now
	for i := 0; i < suggestCacheSize+10; i++ {
		g.put(fmt.Sprint("e", i), []string{"x"})
	}
	if g.order.Len() != suggestCacheSize {
		t.Fatalf("cache size %d", g.order.Len())
	}
}

func TestSuggesterErrorsNotCachedAndTimeout(t *testing.T) {
	var runs atomic.Int32
	g := newSuggester(func(ctx context.Context, prompt string) ([]string, error) {
		runs.Add(1)
		return nil, errors.New("boom")
	})
	for i := 0; i < 2; i++ {
		if _, _, err := g.get(context.Background(), "k", "p"); err == nil {
			t.Fatal("want error")
		}
	}
	if runs.Load() != 2 {
		t.Fatalf("error cached: %d", runs.Load())
	}
	slow := newSuggester(func(ctx context.Context, prompt string) ([]string, error) {
		<-ctx.Done()
		return nil, ctx.Err()
	})
	slow.timeout = 50 * time.Millisecond
	if _, _, err := slow.get(context.Background(), "k", "p"); err == nil {
		t.Fatal("want timeout error")
	}
}

func TestSuggesterConcurrencyLimit(t *testing.T) {
	var cur, peak atomic.Int32
	g := newSuggester(func(ctx context.Context, prompt string) ([]string, error) {
		n := cur.Add(1)
		for {
			p := peak.Load()
			if n <= p || peak.CompareAndSwap(p, n) {
				break
			}
		}
		time.Sleep(30 * time.Millisecond)
		cur.Add(-1)
		return []string{"x"}, nil
	})
	var wg sync.WaitGroup
	for i := 0; i < 6; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			g.get(context.Background(), fmt.Sprint(i), "p")
		}(i)
	}
	wg.Wait()
	if peak.Load() > suggestParallel {
		t.Fatalf("peak %d", peak.Load())
	}
}

func TestSuggestionsEndpoint(t *testing.T) {
	e := newEnv(t)
	sess := e.createSession()
	var runs atomic.Int32
	var fail atomic.Bool
	e.srv.suggest = newSuggester(func(ctx context.Context, prompt string) ([]string, error) {
		runs.Add(1)
		if fail.Load() {
			return nil, errors.New("claude was not found")
		}
		return []string{"Yes", "No"}, nil
	})
	_, obj, _ := e.do("POST", "/api/agent/messages", map[string]any{"body": "Done."}, bearer(sess))
	id := obj["thread_id"].(string)
	get := func() map[string]any {
		code, o, _ := e.do("GET", "/api/threads/"+id+"/suggestions", nil, nil)
		if code != 200 {
			t.Fatalf("code %d", code)
		}
		return o
	}
	if o := get(); len(o["suggestions"].([]any)) != 2 {
		t.Fatalf("got %v", o)
	}
	get()
	if runs.Load() != 1 {
		t.Fatalf("not cached: %d runs", runs.Load())
	}
	e.do("PUT", "/api/settings", map[string]any{"reply_suggestions": false}, nil)
	if o := get(); o["reason"] != "disabled" || len(o["suggestions"].([]any)) != 0 {
		t.Fatalf("disabled: %v", o)
	}
	e.do("PUT", "/api/settings", map[string]any{"reply_suggestions": true}, nil)
	e.do("POST", "/api/threads/"+id+"/reply", map[string]any{"words": "ok"}, nil)
	if o := get(); o["reason"] != "not_needed" {
		t.Fatalf("not_needed: %v", o)
	}
	fail.Store(true)
	e.do("POST", "/api/agent/messages", map[string]any{"body": "More.", "thread_id": id}, bearer(sess))
	o := get()
	if o["error"] == nil || len(o["suggestions"].([]any)) != 0 {
		t.Fatalf("error case: %v", o)
	}
	fail.Store(false)
	if o := get(); len(o["suggestions"].([]any)) != 2 {
		t.Fatalf("retry: %v", o)
	}
	if code, _, _ := e.do("GET", "/api/threads/nope/suggestions", nil, nil); code != 404 {
		t.Fatalf("unknown thread: %d", code)
	}
}

func TestSuggestArgv(t *testing.T) {
	e := newEnv(t)
	e.srv.cfg.ClaudeCommand = []string{"/opt/claude", "--model", "opus"}
	a := e.srv.suggestArgv()
	if a[0] != "/opt/claude" || strings.Contains(strings.Join(a, " "), "opus") {
		t.Fatalf("argv %v", a)
	}
	e.srv.cfg.SuggestCommand = []string{"python3", "fake.py"}
	if a := e.srv.suggestArgv(); a[0] != "python3" || a[1] != "fake.py" {
		t.Fatalf("argv %v", a)
	}
}

func TestRunClaudeSuggestFake(t *testing.T) {
	e := newEnv(t)
	e.srv.cfg.SuggestCommand = []string{"/bin/sh", "-c", `cat >/dev/null; echo '{"type":"result","structured_output":{"suggestions":["hi"]}}'`, "sh"}
	res, err := e.srv.runClaudeSuggest(context.Background(), "p")
	if err != nil || len(res) != 1 || res[0] != "hi" {
		t.Fatalf("%v %v", res, err)
	}
	e.srv.cfg.SuggestCommand = []string{"/nonexistent/claude"}
	if _, err := e.srv.runClaudeSuggest(context.Background(), "p"); err == nil || !strings.Contains(err.Error(), "not found") {
		t.Fatalf("missing: %v", err)
	}
}
