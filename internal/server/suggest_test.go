package server

import (
	"context"
	"encoding/json"
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
	for _, want := range []string{"Subject: Pick a DB", "Open question: Which?", "option: Postgres", "option: SQLite", "language the PERSON used", "\"single\"", "\"multi\"", "2 to 5 options", "Strongly prefer options", "set command"} {
		if !strings.Contains(p, want) {
			t.Errorf("prompt lacks %q", want)
		}
	}
}

func TestParseSuggestions(t *testing.T) {
	long := strings.Repeat("x", 300)
	// render: "question[kind]=label/desc,label;..." then " !command"
	render := func(h replyHelp) string {
		var parts []string
		for _, q := range h.Questions {
			var os []string
			for _, o := range q.Options {
				os = append(os, o.Label+"/"+o.Description)
			}
			parts = append(parts, q.Question+"["+q.Kind+"]="+strings.Join(os, ","))
		}
		return strings.Join(parts, ";") + " " + h.Command
	}
	cases := []struct {
		name, in, want string
		err            bool
	}{
		{"structured", `{"is_error":false,"structured_output":{"questions":[{"question":"Which DB?","kind":"single","options":[{"label":"SQLite","description":"simple"},{"label":"Postgres"}]}]}}`, "Which DB?[single]=SQLite/simple,Postgres/ ", false},
		{"result string", `{"result":"{\"questions\":[{\"question\":\"Test what?\",\"kind\":\"multi\",\"options\":[{\"label\":\"Unit\"}]}]}"}`, "Test what?[multi]=Unit/ ", false},
		{"free text only", `{"structured_output":{"questions":[{"question":"Name?","kind":"single","options":[]}]}}`, "Name?[single]= ", false},
		{"unknown kind is single, string options", `{"structured_output":{"questions":[{"question":"Q","kind":"radio","options":["a"," b "]}]}}`, "Q[single]=a/,b/ ", false},
		{"dupes, empties, bad entries", `{"structured_output":{"questions":[{"question":"Q","kind":"multi","options":[{"label":"a"},{"label":"A"},{"label":" "},3,{"label":"b"}]},{"question":"q","kind":"single","options":[]},{"question":"  "},7,{"question":"R","kind":"single","options":[]}]}}`, "Q[multi]=a/,b/;R[single]= ", false},
		{"caps", `{"structured_output":{"questions":[{"question":"` + long + `","kind":"single","options":[{"label":"1"},{"label":"2"},{"label":"3"},{"label":"4"},{"label":"5"},{"label":"6"}]}]}}`, strings.Repeat("x", suggestMaxLen) + "…[single]=1/,2/,3/,4/,5/ ", false},
		{"command", `{"structured_output":{"questions":[],"command":"$ make lint"}}`, " !make lint", false},
		{"multi-line command dropped", `{"structured_output":{"questions":[],"command":"a\nb"}}`, " ", false},
		{"none", `{"structured_output":{"questions":[]}}`, " ", false},
		{"old shape", `{"structured_output":{"suggestions":["a"]}}`, "", true},
		{"not json", `hello`, "", true},
		{"bad result", `{"result":"nope"}`, "", true},
		{"is_error", `{"is_error":true,"result":"boom"}`, "", true},
	}
	for _, c := range cases {
		got, err := parseSuggestions([]byte(c.in))
		if (err != nil) != c.err {
			t.Errorf("%s: err = %v", c.name, err)
			continue
		}
		if c.err {
			continue
		}
		if r := render(got); r != c.want {
			t.Errorf("%s: got %q want %q", c.name, r, c.want)
		}
	}
	many := `{"structured_output":{"questions":[`
	for i := 0; i < 12; i++ {
		if i > 0 {
			many += ","
		}
		many += fmt.Sprintf(`{"question":"q%d","kind":"single","options":[]}`, i)
	}
	if got, err := parseSuggestions([]byte(many + `]}}`)); err != nil || len(got.Questions) != suggestMaxQuestions {
		t.Fatalf("question cap: %d %v", len(got.Questions), err)
	}
}

func TestSuggestSchemaIsJSON(t *testing.T) {
	var v map[string]any
	if err := json.Unmarshal([]byte(suggestSchema), &v); err != nil {
		t.Fatal(err)
	}
}

// help is a one-question result with the given option labels.
func help(labels ...string) replyHelp {
	q := ReplyQuestion{Question: "Next?", Kind: "single"}
	for _, l := range labels {
		q.Options = append(q.Options, ReplyOption{Label: l})
	}
	return replyHelp{Questions: []ReplyQuestion{q}}
}

func TestSuggesterCacheAndSingleflight(t *testing.T) {
	var runs atomic.Int32
	release := make(chan struct{})
	g := newSuggester(func(ctx context.Context, prompt string) (replyHelp, error) {
		runs.Add(1)
		<-release
		return help("ok"), nil
	})
	var wg sync.WaitGroup
	var fresh atomic.Int32
	for i := 0; i < 5; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			res, f, err := g.get(context.Background(), "k", "p")
			if err != nil || len(res.Questions) != 1 {
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
		g.put(fmt.Sprint("e", i), help("x"))
	}
	if g.order.Len() != suggestCacheSize {
		t.Fatalf("cache size %d", g.order.Len())
	}
}

func TestSuggesterErrorsNotCachedAndTimeout(t *testing.T) {
	var runs atomic.Int32
	g := newSuggester(func(ctx context.Context, prompt string) (replyHelp, error) {
		runs.Add(1)
		return replyHelp{}, errors.New("boom")
	})
	for i := 0; i < 2; i++ {
		if _, _, err := g.get(context.Background(), "k", "p"); err == nil {
			t.Fatal("want error")
		}
	}
	if runs.Load() != 2 {
		t.Fatalf("error cached: %d", runs.Load())
	}
	slow := newSuggester(func(ctx context.Context, prompt string) (replyHelp, error) {
		<-ctx.Done()
		return replyHelp{}, ctx.Err()
	})
	slow.timeout = 50 * time.Millisecond
	if _, _, err := slow.get(context.Background(), "k", "p"); err == nil {
		t.Fatal("want timeout error")
	}
}

func TestSuggesterConcurrencyLimit(t *testing.T) {
	var cur, peak atomic.Int32
	g := newSuggester(func(ctx context.Context, prompt string) (replyHelp, error) {
		n := cur.Add(1)
		for {
			p := peak.Load()
			if n <= p || peak.CompareAndSwap(p, n) {
				break
			}
		}
		time.Sleep(30 * time.Millisecond)
		cur.Add(-1)
		return help("x"), nil
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
	e.srv.suggest = newSuggester(func(ctx context.Context, prompt string) (replyHelp, error) {
		runs.Add(1)
		if fail.Load() {
			return replyHelp{}, errors.New("claude was not found")
		}
		return help("Yes", "No"), nil
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
	o0 := get()
	qs := o0["questions"].([]any)
	if len(qs) != 1 {
		t.Fatalf("got %v", o0)
	}
	q0 := qs[0].(map[string]any)
	if q0["question"] != "Next?" || q0["kind"] != "single" || len(q0["options"].([]any)) != 2 || q0["options"].([]any)[0].(map[string]any)["label"] != "Yes" {
		t.Fatalf("question %v", q0)
	}
	if _, ok := o0["command"]; ok {
		t.Fatalf("no command expected: %v", o0)
	}
	get()
	if runs.Load() != 1 {
		t.Fatalf("not cached: %d runs", runs.Load())
	}
	e.do("PUT", "/api/settings", map[string]any{"reply_suggestions": false}, nil)
	if o := get(); o["reason"] != "disabled" || len(o["questions"].([]any)) != 0 {
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
	if o["error"] == nil || len(o["questions"].([]any)) != 0 {
		t.Fatalf("error case: %v", o)
	}
	fail.Store(false)
	if o := get(); len(o["questions"].([]any)) != 1 {
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
	e.srv.cfg.SuggestCommand = []string{"/bin/sh", "-c", `cat >/dev/null; echo '{"type":"result","structured_output":{"questions":[{"question":"hi?","kind":"multi","options":[{"label":"a"}]}]}}'`, "sh"}
	res, err := e.srv.runSuggest(context.Background(), "p")
	if err != nil || len(res.Questions) != 1 || res.Questions[0].Question != "hi?" || res.Questions[0].Kind != "multi" {
		t.Fatalf("%v %v", res, err)
	}
	e.srv.cfg.SuggestCommand = []string{"/nonexistent/claude"}
	if _, err := e.srv.runSuggest(context.Background(), "p"); err == nil || !strings.Contains(err.Error(), "not found") {
		t.Fatalf("missing: %v", err)
	}
}
