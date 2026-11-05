package notify

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/ryotarai/minbox/internal/store"
)

func TestMrkdwn(t *testing.T) {
	cases := map[string]string{
		"**bold** and *it* and ~~gone~~":         "*bold* and _it_ and ~gone~",
		"see [the docs](https://x.io/a?b=1&c=2)": "see <https://x.io/a?b=1&amp;c=2|the docs>",
		"# Title\n## Sub":                        "*Title*\n*Sub*",
		"a < b && c > d":                         "a &lt; b &amp;&amp; c &gt; d",
		"- one\n  - two\n* three":                "• one\n  • two\n• three",
		"```go\nx := a<b\n```":                   "```\nx := a&lt;b\n```",
		"`a<b` stays code":                       "`a&lt;b` stays code",
		"| a | b |\n|---|---|\n| 1 | 2 |\nafter": "```\n| a | b |\n|---|---|\n| 1 | 2 |\n```\nafter",
		"> quoted **x**":                         "> quoted *x*",
		"---":                                    "──────────",
		"**# not heading**":                      "*# not heading*",
	}
	for in, want := range cases {
		if got := Mrkdwn(in); got != want {
			t.Errorf("Mrkdwn(%q)\n got %q\nwant %q", in, got, want)
		}
	}
}

func TestSplit(t *testing.T) {
	line := strings.Repeat("word ", 100) + "\n"
	body := strings.Repeat(line, 40) // ~20k
	parts := splitMrkdwn(body, 2900)
	if len(parts) < 7 {
		t.Fatalf("parts = %d", len(parts))
	}
	var joined string
	for _, p := range parts {
		if n := len([]rune(p)); n > 2900 {
			t.Fatalf("part of %d chars", n)
		}
		joined += p + "\n"
	}
	if strings.Count(joined, "word") != 4000 {
		t.Fatal("text lost in the split")
	}
	// a code fence cut in the middle is closed and reopened
	code := "```\n" + strings.Repeat("x := 1\n", 800) + "```"
	for i, p := range splitMrkdwn(code, 2900) {
		if strings.Count(p, "```")%2 != 0 {
			t.Fatalf("part %d has an open fence", i)
		}
	}
	// multi-byte text splits on characters
	for _, p := range splitMrkdwn(strings.Repeat("あ", 7000), 2900) {
		if len([]rune(p)) > 2900 {
			t.Fatal("too long")
		}
	}
}

func TestPayloadShape(t *testing.T) {
	p := BuildSlackPayload(Notification{Project: "api", Session: "alpha", Title: "A & B <c>", From: "Claude", Body: "Hello **there**", NeedsAction: true, Link: "https://m.example/#s=1&t=2"}, true)
	b, _ := json.Marshal(p)
	var m map[string]any
	_ = json.Unmarshal(b, &m)
	blocks := m["blocks"].([]any)
	if len(blocks) != 4 {
		t.Fatalf("blocks = %s", b)
	}
	head := blocks[0].(map[string]any)["text"].(map[string]any)["text"]
	if head != "*api / alpha*: A &amp; B &lt;c&gt;" {
		t.Fatalf("head = %q", head)
	}
	if blocks[1].(map[string]any)["text"].(map[string]any)["text"] != "Hello *there*" {
		t.Fatalf("body = %s", b)
	}
	ctx := blocks[2].(map[string]any)["elements"].([]any)[0].(map[string]any)["text"]
	if ctx != "Claude · needs your answer" {
		t.Fatalf("context = %v", ctx)
	}
	btn := blocks[3].(map[string]any)["elements"].([]any)[0].(map[string]any)
	if btn["type"] != "button" || btn["url"] != "https://m.example/#s=1&t=2" || btn["text"].(map[string]any)["text"] != "Open thread" {
		t.Fatalf("button = %v", btn)
	}
	if !strings.HasPrefix(m["text"].(string), "api / alpha: A &amp; B") || !strings.Contains(m["text"].(string), "Hello there") {
		t.Fatalf("fallback = %q", m["text"])
	}
	// Title only: no body, no link.
	p = BuildSlackPayload(Notification{Session: "s", Title: "t", Body: "secret body"}, false)
	if len(p.Blocks) != 1 || strings.Contains(p.Text, "secret") {
		t.Fatalf("title only = %+v", p)
	}
}

func TestPayloadLimits(t *testing.T) {
	body := strings.Repeat("0123456789", 20000) // 200k, far past 50 blocks
	p := BuildSlackPayload(Notification{Session: "s", Title: "t", Body: body, Link: "https://m.example"}, true)
	if len(p.Blocks) != slackBlocksMax {
		t.Fatalf("blocks = %d", len(p.Blocks))
	}
	last := p.Blocks[len(p.Blocks)-2]
	if !strings.Contains(last.Text.Text, "…") || !strings.Contains(last.Text.Text, "open the thread") {
		t.Fatalf("no cut marker: %q", last.Text.Text[len(last.Text.Text)-80:])
	}
	for _, b := range p.Blocks {
		if b.Text != nil && len([]rune(b.Text.Text)) > 3000 {
			t.Fatalf("section of %d chars", len([]rune(b.Text.Text)))
		}
	}
	if p.Blocks[len(p.Blocks)-1].Type != "actions" {
		t.Fatal("no button")
	}
	// A body that fits is sent whole (about 30k chars: 11 sections).
	full := strings.Repeat("line of text\n", 2300)
	p = BuildSlackPayload(Notification{Session: "s", Title: "t", Body: full}, true)
	var got strings.Builder
	for _, b := range p.Blocks[1:] {
		got.WriteString(b.Text.Text + "\n")
	}
	if strings.Count(got.String(), "line of text") != 2300 {
		t.Fatal("body cut although it fits")
	}
}

type fakeSlack struct {
	mu       sync.Mutex
	status   []int // status per request; the last repeats
	retry    string
	payloads []map[string]any
	srv      *httptest.Server
}

func newFakeSlack(t *testing.T, retryAfter string, status ...int) *fakeSlack {
	f := &fakeSlack{status: status, retry: retryAfter}
	f.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		var m map[string]any
		_ = json.Unmarshal(b, &m)
		f.mu.Lock()
		f.payloads = append(f.payloads, m)
		code := f.status[min(len(f.payloads), len(f.status))-1]
		f.mu.Unlock()
		if f.retry != "" {
			w.Header().Set("Retry-After", f.retry)
		}
		w.WriteHeader(code)
		if code == 200 {
			_, _ = w.Write([]byte("ok"))
		} else {
			_, _ = w.Write([]byte("invalid_payload"))
		}
	}))
	t.Cleanup(f.srv.Close)
	return f
}

func (f *fakeSlack) count() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.payloads)
}

type rig struct {
	st     *store.Store
	d      *Dispatcher
	sleeps []time.Duration
	mu     sync.Mutex
}

func newRig(t *testing.T) *rig {
	st, err := store.Open(filepath.Join(t.TempDir(), "db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })
	r := &rig{st: st, d: NewDispatcher(st)}
	r.d.Sleep = func(_ context.Context, d time.Duration) error {
		r.mu.Lock()
		r.sleeps = append(r.sleeps, d)
		r.mu.Unlock()
		return nil
	}
	log.SetOutput(io.Discard)
	return r
}

func (r *rig) add(t *testing.T, url string, cfg map[string]any) *store.Destination {
	c := map[string]any{"webhook_url": url}
	for k, v := range cfg {
		c[k] = v
	}
	slack, _ := Lookup("slack")
	norm, err := slack.Normalize(nil, c)
	if err != nil {
		t.Fatal(err)
	}
	d := &store.Destination{Type: "slack", Name: "s", Enabled: true, Config: norm}
	if err := r.st.CreateDestination(context.Background(), d); err != nil {
		t.Fatal(err)
	}
	return d
}

func TestDispatchRetries(t *testing.T) {
	r := newRig(t)
	f := newFakeSlack(t, "", 500, 503, 200)
	d := r.add(t, f.srv.URL+"/services/T0/B0/secretsecret1234", nil)
	r.d.Dispatch(Notification{Session: "s", Title: "t", Body: "b"})
	r.d.Wait()
	if f.count() != 3 {
		t.Fatalf("requests = %d", f.count())
	}
	if len(r.sleeps) != 2 || r.sleeps[0] != time.Second || r.sleeps[1] != 5*time.Second {
		t.Fatalf("sleeps = %v", r.sleeps)
	}
	got, _ := r.st.GetDestination(context.Background(), d.ID)
	if got.LastOKAt == nil || got.LastError != "" {
		t.Fatalf("result = %+v", got)
	}
}

func TestDispatchGivesUpAfterBackoffs(t *testing.T) {
	r := newRig(t)
	f := newFakeSlack(t, "", 500)
	d := r.add(t, f.srv.URL+"/services/T0/B0/secretsecret1234", nil)
	r.d.Dispatch(Notification{Session: "s", Title: "t"})
	r.d.Wait()
	if f.count() != 4 {
		t.Fatalf("requests = %d", f.count())
	}
	if len(r.sleeps) != 3 || r.sleeps[2] != 20*time.Second {
		t.Fatalf("sleeps = %v", r.sleeps)
	}
	got, _ := r.st.GetDestination(context.Background(), d.ID)
	if got.LastOKAt != nil || !strings.Contains(got.LastError, "500") || got.LastErrorAt == nil {
		t.Fatalf("result = %+v", got)
	}
	if strings.Contains(got.LastError, "secretsecret") {
		t.Fatal("the webhook URL is in the error")
	}
}

func TestDispatch4xxNoRetryAnd429RetryAfter(t *testing.T) {
	r := newRig(t)
	f := newFakeSlack(t, "", 404)
	d := r.add(t, f.srv.URL+"/x", nil)
	r.d.Dispatch(Notification{Session: "s", Title: "t"})
	r.d.Wait()
	if f.count() != 1 || len(r.sleeps) != 0 {
		t.Fatalf("requests = %d, sleeps = %v", f.count(), r.sleeps)
	}
	got, _ := r.st.GetDestination(context.Background(), d.ID)
	if !strings.Contains(got.LastError, "404") {
		t.Fatalf("result = %+v", got)
	}

	r2 := newRig(t)
	f2 := newFakeSlack(t, "7", 429, 200)
	r2.add(t, f2.srv.URL+"/x", nil)
	r2.d.Dispatch(Notification{Session: "s", Title: "t"})
	r2.d.Wait()
	if f2.count() != 2 || len(r2.sleeps) != 1 || r2.sleeps[0] != 7*time.Second {
		t.Fatalf("requests = %d, sleeps = %v", f2.count(), r2.sleeps)
	}
}

func TestDispatchFiltersAndDisabled(t *testing.T) {
	r := newRig(t)
	f := newFakeSlack(t, "", 200)
	r.add(t, f.srv.URL+"/all", nil)
	g := newFakeSlack(t, "", 200)
	r.add(t, g.srv.URL+"/action", map[string]any{"events": "action"})
	h := newFakeSlack(t, "", 200)
	off := r.add(t, h.srv.URL+"/off", nil)
	off.Enabled = false
	_ = r.st.UpdateDestination(context.Background(), off)

	r.d.Dispatch(Notification{Session: "s", Title: "t", Body: "plain"})
	r.d.Wait()
	if f.count() != 1 || g.count() != 0 || h.count() != 0 {
		t.Fatalf("plain message: %d %d %d", f.count(), g.count(), h.count())
	}
	r.d.Dispatch(Notification{Session: "s", Title: "t", Body: "q", NeedsAction: true})
	r.d.Wait()
	if f.count() != 2 || g.count() != 1 || h.count() != 0 {
		t.Fatalf("question message: %d %d %d", f.count(), g.count(), h.count())
	}
}

func TestNetworkErrorRetriesAndHidesURL(t *testing.T) {
	r := newRig(t)
	srv := httptest.NewServer(http.NotFoundHandler())
	url := srv.URL + "/services/T/B/hunter2hunter2"
	srv.Close() // connection refused
	d := r.add(t, url, nil)
	var logs bytes.Buffer
	log.SetOutput(&logs)
	defer log.SetOutput(io.Discard)
	r.d.Dispatch(Notification{Session: "s", Title: "t"})
	r.d.Wait()
	if len(r.sleeps) != 3 {
		t.Fatalf("sleeps = %v", r.sleeps)
	}
	got, _ := r.st.GetDestination(context.Background(), d.ID)
	if got.LastError == "" || strings.Contains(got.LastError, "hunter2") || strings.Contains(got.LastError, "/services") {
		t.Fatalf("error = %q", got.LastError)
	}
	if strings.Contains(logs.String(), "hunter2") {
		t.Fatalf("the webhook URL was logged: %s", logs.String())
	}
	if logs.Len() == 0 {
		t.Fatal("nothing logged")
	}
}

func TestNormalizeKeepsSecret(t *testing.T) {
	slack, _ := Lookup("slack")
	old, err := slack.Normalize(nil, map[string]any{"webhook_url": "https://hooks.slack.com/services/T/B/abcdWXYZ"})
	if err != nil || old["include_body"] != true || old["events"] != "all" {
		t.Fatalf("defaults: %v %v", old, err)
	}
	pub := slack.Public(old)["webhook_url"]
	if pub != "https://hooks.slack.com/…WXYZ" {
		t.Fatalf("masked = %v", pub)
	}
	for _, in := range []map[string]any{{}, {"webhook_url": ""}, {"webhook_url": pub}} {
		in["include_body"] = false
		n, err := slack.Normalize(old, in)
		if err != nil || n["webhook_url"] != old["webhook_url"] || n["include_body"] != false {
			t.Fatalf("keep: %v %v", n, err)
		}
	}
	if _, err := slack.Normalize(nil, map[string]any{}); err == nil {
		t.Fatal("a webhook URL is required")
	}
	if _, err := slack.Normalize(nil, map[string]any{"webhook_url": "ftp://x"}); err == nil {
		t.Fatal("scheme not checked")
	}
	if _, err := slack.Normalize(old, map[string]any{"events": "nope"}); err == nil {
		t.Fatal("events not checked")
	}
}
