package notify

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/ryotarai/minbox/internal/store"
)

const testToken = "xoxb-1234-SECRETTOKENabcd"

type appCall struct {
	method string
	auth   string
	body   map[string]any
}

// fakeSlackAPI answers like Slack's Web API; reply decides per call.
type fakeSlackAPI struct {
	mu    sync.Mutex
	calls []appCall
	reply func(c appCall, n int) (int, http.Header, string)
	srv   *httptest.Server
}

func newFakeSlackAPI(t *testing.T, reply func(c appCall, n int) (int, http.Header, string)) *fakeSlackAPI {
	f := &fakeSlackAPI{reply: reply}
	f.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		var m map[string]any
		_ = json.Unmarshal(b, &m)
		c := appCall{method: strings.TrimPrefix(r.URL.Path, "/"), auth: r.Header.Get("Authorization"), body: m}
		f.mu.Lock()
		f.calls = append(f.calls, c)
		n := len(f.calls)
		rep := f.reply
		f.mu.Unlock()
		code, h, body := rep(c, n)
		for k, v := range h {
			w.Header()[k] = v
		}
		w.WriteHeader(code)
		_, _ = w.Write([]byte(body))
	}))
	t.Cleanup(f.srv.Close)
	old := slackAPIBase
	slackAPIBase = f.srv.URL
	t.Cleanup(func() { slackAPIBase = old })
	return f
}

func (f *fakeSlackAPI) all() []appCall {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]appCall(nil), f.calls...)
}

// okReply answers chat.postMessage with a fresh ts in channel C0123ABCD (1700000000.001, .002, ...).
func okReply() func(appCall, int) (int, http.Header, string) {
	var seq atomic.Int64
	return func(c appCall, n int) (int, http.Header, string) {
		if c.method == "auth.test" {
			return 200, nil, `{"ok":true,"team":"Acme","user":"minbot"}`
		}
		return 200, nil, `{"ok":true,"channel":"C0123ABCD","ts":"1700000000.00` + string(rune('0'+seq.Add(1))) + `"}`
	}
}

func (r *rig) addApp(t *testing.T, cfg map[string]any) *store.Destination {
	c := map[string]any{"bot_token": testToken, "channel": "#alerts"}
	for k, v := range cfg {
		c[k] = v
	}
	norm, err := slackAppType.Normalize(nil, c)
	if err != nil {
		t.Fatal(err)
	}
	d := &store.Destination{Type: "slack_app", Name: "app", Enabled: true, Config: norm}
	if err := r.st.CreateDestination(context.Background(), d); err != nil {
		t.Fatal(err)
	}
	return d
}

func mustJSON(v any) []byte { b, _ := json.Marshal(v); return b }

func TestSlackAppPayloadAndThreads(t *testing.T) {
	r := newRig(t)
	f := newFakeSlackAPI(t, okReply())
	d := r.addApp(t, nil)
	n := Notification{Project: "api", Session: "alpha", Title: "Hi", ThreadID: "thr_1", Body: "Hello **there**", NeedsAction: true, Link: "https://m.example/#t=1", From: "Claude"}
	r.d.Dispatch(n)
	r.d.Wait()
	n.Body = "second"
	r.d.Dispatch(n)
	r.d.Wait()
	n.ThreadID = "thr_2"
	r.d.Dispatch(n)
	r.d.Wait()

	calls := f.all()
	if len(calls) != 3 {
		t.Fatalf("calls = %d", len(calls))
	}
	first := calls[0]
	if first.method != "chat.postMessage" || first.auth != "Bearer "+testToken {
		t.Fatalf("first = %+v", first)
	}
	if first.body["channel"] != "#alerts" || first.body["unfurl_links"] != false || first.body["unfurl_media"] != false {
		t.Fatalf("body = %v", first.body)
	}
	if _, has := first.body["thread_ts"]; has {
		t.Fatal("the parent has a thread_ts")
	}
	if !strings.Contains(first.body["text"].(string), "api / alpha: Hi") {
		t.Fatalf("text = %v", first.body["text"])
	}
	blocks := first.body["blocks"].([]any)
	if len(blocks) != 4 || blocks[3].(map[string]any)["type"] != "actions" {
		t.Fatalf("blocks = %v", blocks)
	}
	// The second message of the same thread replies to the first, in the channel ID Slack returned.
	second := calls[1].body
	if second["thread_ts"] != "1700000000.001" || second["channel"] != "C0123ABCD" || second["reply_broadcast"] != false {
		t.Fatalf("second = %v", second)
	}
	// Another minbox thread starts its own Slack thread.
	if _, has := calls[2].body["thread_ts"]; has || calls[2].body["channel"] != "#alerts" {
		t.Fatalf("third = %v", calls[2].body)
	}
	st, ok, _ := r.st.GetSlackThread(context.Background(), d.ID, "thr_1")
	if !ok || st.TS != "1700000000.001" || st.ChannelID != "C0123ABCD" {
		t.Fatalf("stored = %+v %v", st, ok)
	}
}

func TestSlackAppThreadRepliesOffAndTitleOnly(t *testing.T) {
	r := newRig(t)
	f := newFakeSlackAPI(t, okReply())
	r.addApp(t, map[string]any{"thread_replies": false, "include_body": false})
	for i := 0; i < 2; i++ {
		r.d.Dispatch(Notification{Session: "s", Title: "t", ThreadID: "thr_1", Body: "secret body"})
		r.d.Wait()
	}
	for _, c := range f.all() {
		if _, has := c.body["thread_ts"]; has {
			t.Fatal("thread_ts although thread_replies is off")
		}
		if strings.Contains(string(mustJSON(c.body)), "secret body") {
			t.Fatal("body sent although include_body is off")
		}
	}
}

func TestSlackAppThreadNotFoundRecovers(t *testing.T) {
	r := newRig(t)
	var parents atomic.Int64
	f := newFakeSlackAPI(t, func(c appCall, n int) (int, http.Header, string) {
		if c.body["thread_ts"] == "1.1" {
			return 200, nil, `{"ok":false,"error":"thread_not_found"}`
		}
		ts := "2.2"
		if parents.Add(1) == 1 {
			ts = "1.1"
		}
		return 200, nil, `{"ok":true,"channel":"C1","ts":"` + ts + `"}`
	})
	d := r.addApp(t, nil)
	for i := 0; i < 3; i++ {
		r.d.Dispatch(Notification{Session: "s", Title: "t", ThreadID: "thr_1"})
		r.d.Wait()
	}
	calls := f.all()
	// parent, reply (fails), new parent, reply to the new parent.
	if len(calls) != 4 {
		t.Fatalf("calls = %d", len(calls))
	}
	if calls[2].body["thread_ts"] != nil || calls[3].body["thread_ts"] != "2.2" {
		t.Fatalf("calls = %v", calls)
	}
	st, _, _ := r.st.GetSlackThread(context.Background(), d.ID, "thr_1")
	if st.TS != "2.2" {
		t.Fatalf("stored = %+v", st)
	}
	got, _ := r.st.GetDestination(context.Background(), d.ID)
	if got.LastError != "" {
		t.Fatalf("last error = %q", got.LastError)
	}
}

func TestSlackAppSerializesPerThread(t *testing.T) {
	r := newRig(t)
	var seq atomic.Int64
	f := newFakeSlackAPI(t, func(c appCall, n int) (int, http.Header, string) {
		time.Sleep(30 * time.Millisecond) // widen the race
		return 200, nil, `{"ok":true,"channel":"C1","ts":"` + string(rune('a'+seq.Add(1))) + `"}`
	})
	r.addApp(t, nil)
	for i := 0; i < 6; i++ {
		r.d.Dispatch(Notification{Session: "s", Title: "t", ThreadID: "thr_1"})
	}
	r.d.Wait()
	parents := 0
	for _, c := range f.all() {
		if c.body["thread_ts"] == nil {
			parents++
		}
	}
	if len(f.all()) != 6 || parents != 1 {
		t.Fatalf("calls = %d, parents = %d", len(f.all()), parents)
	}
}

func TestSlackAppErrorMapping(t *testing.T) {
	cases := []struct {
		code    string
		contain string
		retry   bool
	}{
		{"channel_not_found", "cannot find that channel", false},
		{"not_in_channel", "/invite @<app name>", false},
		{"is_archived", "archived", false},
		{"user_not_found", "cannot find that user", false},
		{"cannot_dm_bot", "cannot receive a DM", false},
		{"messages_tab_disabled", "Messages tab", false},
		{"invalid_auth", "invalid or expired", false},
		{"account_inactive", "deactivated", false},
		{"token_revoked", "revoked", false},
		{"missing_scope", "lacks the chat:write scope", false},
		{"msg_too_long", "refused the message", false},
		{"weird_new_error", "Slack error: weird_new_error", false},
		{"ratelimited", "rate limiting", true},
		{"internal_error", "Slack error: internal_error", true},
		{"service_unavailable", "service_unavailable", true},
		{"fatal_error", "fatal_error", true},
		{"request_timeout", "request_timeout", true},
	}
	for _, c := range cases {
		r := newRig(t)
		f := newFakeSlackAPI(t, func(appCall, int) (int, http.Header, string) {
			return 200, nil, `{"ok":false,"error":"` + c.code + `"}`
		})
		d := r.addApp(t, nil)
		r.d.Dispatch(Notification{Session: "s", Title: "t"})
		r.d.Wait()
		want := 1
		if c.retry {
			want = 4
		}
		if len(f.all()) != want {
			t.Errorf("%s: calls = %d, want %d", c.code, len(f.all()), want)
		}
		got, _ := r.st.GetDestination(context.Background(), d.ID)
		if !strings.Contains(got.LastError, c.contain) {
			t.Errorf("%s: last_error = %q", c.code, got.LastError)
		}
		if strings.Contains(got.LastError, "SECRETTOKEN") {
			t.Errorf("%s: token in error", c.code)
		}
	}
}

func TestSlackAppHTTPStatusesAndRetryAfter(t *testing.T) {
	r := newRig(t)
	f := newFakeSlackAPI(t, func(c appCall, n int) (int, http.Header, string) {
		if n == 1 {
			return 429, http.Header{"Retry-After": {"7"}}, `{"ok":false,"error":"ratelimited"}`
		}
		if n == 2 {
			return 502, nil, "bad gateway"
		}
		return 200, nil, `{"ok":true,"channel":"C1","ts":"1.1"}`
	})
	d := r.addApp(t, nil)
	r.d.Dispatch(Notification{Session: "s", Title: "t"})
	r.d.Wait()
	if len(f.all()) != 3 {
		t.Fatalf("calls = %d", len(f.all()))
	}
	if len(r.sleeps) != 2 || r.sleeps[0] != 7*time.Second || r.sleeps[1] != 5*time.Second {
		t.Fatalf("sleeps = %v", r.sleeps)
	}
	got, _ := r.st.GetDestination(context.Background(), d.ID)
	if got.LastOKAt == nil || got.LastError != "" {
		t.Fatalf("result = %+v", got)
	}
	// A 404 whose body is not Slack JSON: no retry.
	r2 := newRig(t)
	f2 := newFakeSlackAPI(t, func(appCall, int) (int, http.Header, string) { return 404, nil, "<html>" })
	r2.addApp(t, nil)
	r2.d.Dispatch(Notification{Session: "s", Title: "t"})
	r2.d.Wait()
	if len(f2.all()) != 1 {
		t.Fatalf("calls = %d", len(f2.all()))
	}
}

func TestSlackAppNetworkErrorHidesToken(t *testing.T) {
	r := newRig(t)
	srv := httptest.NewServer(http.NotFoundHandler())
	old := slackAPIBase
	slackAPIBase = srv.URL
	t.Cleanup(func() { slackAPIBase = old })
	srv.Close()
	d := r.addApp(t, nil)
	var logs bytes.Buffer
	log.SetOutput(&logs)
	defer log.SetOutput(io.Discard)
	r.d.Dispatch(Notification{Session: "s", Title: "t"})
	r.d.Wait()
	got, _ := r.st.GetDestination(context.Background(), d.ID)
	if !strings.Contains(got.LastError, "request failed") || strings.Contains(got.LastError, "SECRETTOKEN") || strings.Contains(logs.String(), "SECRETTOKEN") {
		t.Fatalf("last_error = %q, log = %q", got.LastError, logs.String())
	}
	if len(r.sleeps) != 3 {
		t.Fatalf("sleeps = %v", r.sleeps)
	}
}

func TestSlackAppTestSendVerifiesToken(t *testing.T) {
	r := newRig(t)
	f := newFakeSlackAPI(t, okReply())
	d := r.addApp(t, nil)
	info, err := r.d.TestInfo(context.Background(), d, Notification{Session: "s", Title: "t", ThreadID: "thr_1"})
	if err != nil || info != "Connected to Acme as minbot" {
		t.Fatalf("info = %q, err = %v", info, err)
	}
	calls := f.all()
	if len(calls) != 2 || calls[0].method != "auth.test" || calls[1].method != "chat.postMessage" {
		t.Fatalf("calls = %+v", calls)
	}
	if _, has := calls[1].body["thread_ts"]; has {
		t.Fatal("test message is threaded")
	}
	if _, ok, _ := r.st.GetSlackThread(context.Background(), d.ID, "thr_1"); ok {
		t.Fatal("test message stored as a parent")
	}
	// A bad token fails at auth.test, without posting.
	f.mu.Lock()
	f.reply = func(c appCall, n int) (int, http.Header, string) {
		return 200, nil, `{"ok":false,"error":"invalid_auth"}`
	}
	f.mu.Unlock()
	_, err = r.d.TestInfo(context.Background(), d, Notification{})
	if err == nil || !strings.Contains(err.Error(), "invalid or expired") || len(f.all()) != 3 {
		t.Fatalf("err = %v, calls = %d", err, len(f.all()))
	}
}

func TestSlackAppNormalizeAndMask(t *testing.T) {
	for name, in := range map[string]map[string]any{
		"no token":      {"channel": "C1"},
		"token spaces":  {"bot_token": "xoxb 1", "channel": "C1"},
		"no channel":    {"bot_token": testToken},
		"channel space": {"bot_token": testToken, "channel": "my channel"},
		"bad events":    {"bot_token": testToken, "channel": "C1", "events": "x"},
	} {
		if _, err := slackAppType.Normalize(nil, in); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
	cfg, err := slackAppType.Normalize(nil, map[string]any{"bot_token": testToken, "channel": " #alerts "})
	if err != nil || cfg["channel"] != "#alerts" || cfg["include_body"] != true || cfg["thread_replies"] != true || cfg["events"] != "all" {
		t.Fatalf("cfg = %v, %v", cfg, err)
	}
	pub := slackAppType.Public(cfg)
	if pub["bot_token"] != "xoxb-…abcd" || strings.Contains(string(mustJSON(pub)), "SECRET") {
		t.Fatalf("public = %v", pub)
	}
	// Edit: the masked token (or none) keeps the stored one.
	for _, in := range []map[string]any{{"channel": "C2"}, {"bot_token": "xoxb-…abcd", "channel": "C2"}} {
		got, err := slackAppType.Normalize(cfg, in)
		if err != nil || got["bot_token"] != testToken || got["channel"] != "C2" {
			t.Fatalf("got = %v, %v", got, err)
		}
	}
}

func TestSlackAPIBaseOnlyLoopback(t *testing.T) {
	for in, want := range map[string]string{
		"":                           "https://slack.com/api",
		"http://127.0.0.1:9999/api/": "http://127.0.0.1:9999/api",
		"http://localhost:1":         "http://localhost:1",
		"http://evil.example/api":    "https://slack.com/api",
		"https://127.0.0.1:1":        "https://slack.com/api",
	} {
		if got := slackAPIBaseFromEnv(in); got != want {
			t.Errorf("%q -> %q, want %q", in, got, want)
		}
	}
}

func TestSlackAppDMToUserID(t *testing.T) {
	r := newRig(t)
	f := newFakeSlackAPI(t, func(c appCall, n int) (int, http.Header, string) {
		return 200, nil, `{"ok":true,"channel":"D0DMCHAN1","ts":"1700000000.00` + string(rune('0'+n)) + `"}`
	})
	tok := "xox" + "b-1234-DMTOKEN"
	d := r.addApp(t, map[string]any{"bot_token": tok, "channel": "U0123ABCD"})
	n := Notification{Session: "s", Title: "Hi", ThreadID: "thr_dm", Body: "x"}
	r.d.Dispatch(n)
	r.d.Wait()
	r.d.Dispatch(n)
	r.d.Wait()
	calls := f.all()
	if len(calls) != 2 {
		t.Fatalf("calls = %d", len(calls))
	}
	if calls[0].body["channel"] != "U0123ABCD" || calls[0].auth != "Bearer "+tok {
		t.Fatalf("first = %+v", calls[0])
	}
	if _, has := calls[0].body["thread_ts"]; has {
		t.Fatal("parent has thread_ts")
	}
	// The reply goes to the D… channel Slack returned, as a thread reply.
	if calls[1].body["channel"] != "D0DMCHAN1" || calls[1].body["thread_ts"] != "1700000000.001" {
		t.Fatalf("reply = %v", calls[1].body)
	}
	st, ok, _ := r.st.GetSlackThread(context.Background(), d.ID, "thr_dm")
	if !ok || st.ChannelID != "D0DMCHAN1" || st.TS != "1700000000.001" {
		t.Fatalf("stored = %+v %v", st, ok)
	}
}
