package server

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"regexp"
	"strings"
	"sync"
	"testing"
	"time"
)

// fakeSlackUser is a fake Slack Web API (user-token methods) on loopback. No real Slack is contacted.
type fakeSlackUser struct {
	t  *testing.T
	ts *httptest.Server

	mu     sync.Mutex
	token  string // the token it accepts
	scopes string // x-oauth-scopes of auth.test ("" sends no header)
	me     string
	team   string
	calls  []fakeSlackCall
	// RTS
	rtsError  string                        // an error code for assistant.search.context ("" = works)
	rtsPages  map[string][][]map[string]any // kind -> pages of results
	legacy    map[string][]map[string]any   // kind -> matches
	replies   map[string][]map[string]any   // "C1:ts" -> messages
	history   map[string][]map[string]any   // "D1" -> messages newest first
	users     map[string]string
	limitFor  map[string]int // method -> Retry-After seconds when set (429)
	authError string
	rawAuths  []string // Authorization headers seen
}

type fakeSlackCall struct {
	Method string
	Args   map[string]any
}

func newFakeSlackUser(t *testing.T) *fakeSlackUser {
	f := &fakeSlackUser{t: t, token: "xoxp-" + "1111111111-" + "2222222222-" + "abcdefABCDEF1234567890", me: "U_ME", team: "Acme",
		scopes:   "search:read.public,search:read.private,search:read.im,channels:history,groups:history,im:history,users:read,im:read",
		rtsPages: map[string][][]map[string]any{}, legacy: map[string][]map[string]any{}, replies: map[string][]map[string]any{}, history: map[string][]map[string]any{},
		users: map[string]string{"U_ME": "Ryota", "U_ALICE": "Alice", "U_BOB": "Bob"}, limitFor: map[string]int{}}
	f.ts = httptest.NewServer(http.HandlerFunc(f.serve))
	t.Cleanup(f.ts.Close)
	return f
}

func (f *fakeSlackUser) count(method string) int {
	f.mu.Lock()
	defer f.mu.Unlock()
	n := 0
	for _, c := range f.calls {
		if c.Method == method {
			n++
		}
	}
	return n
}

func (f *fakeSlackUser) callsOf(method string) []fakeSlackCall {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []fakeSlackCall
	for _, c := range f.calls {
		if c.Method == method {
			out = append(out, c)
		}
	}
	return out
}

func (f *fakeSlackUser) serve(w http.ResponseWriter, r *http.Request) {
	method := strings.TrimPrefix(r.URL.Path, "/")
	raw, _ := io.ReadAll(r.Body)
	args := map[string]any{}
	if strings.HasPrefix(r.Header.Get("Content-Type"), "application/json") {
		_ = json.Unmarshal(raw, &args)
	} else if v, err := url.ParseQuery(string(raw)); err == nil {
		for k := range v {
			args[k] = v.Get(k)
		}
	}
	f.mu.Lock()
	f.calls = append(f.calls, fakeSlackCall{method, args})
	f.rawAuths = append(f.rawAuths, r.Header.Get("Authorization"))
	f.mu.Unlock()
	out := func(v map[string]any) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(v)
	}
	fail := func(code string, extra map[string]any) {
		m := map[string]any{"ok": false, "error": code}
		for k, v := range extra {
			m[k] = v
		}
		out(m)
	}
	f.mu.Lock()
	limit := f.limitFor[method]
	authErr := f.authError
	f.mu.Unlock()
	if r.Header.Get("Authorization") != "Bearer "+f.token || authErr != "" {
		fail(firstNonEmpty(authErr, "invalid_auth"), nil)
		return
	}
	if limit > 0 {
		w.Header().Set("Retry-After", fmt.Sprint(limit))
		w.WriteHeader(429)
		return
	}
	switch method {
	case "auth.test":
		if f.scopes != "" {
			w.Header().Set("X-OAuth-Scopes", f.scopes)
		}
		out(map[string]any{"ok": true, "user_id": f.me, "user": "ryota", "team_id": "T1", "team": f.team, "url": "https://acme.slack.com/"})
	case "assistant.search.context":
		f.mu.Lock()
		e := f.rtsError
		f.mu.Unlock()
		if e != "" {
			fail(e, nil)
			return
		}
		q, _ := args["query"].(string)
		kind := classify(q)
		cur, _ := args["cursor"].(string)
		f.mu.Lock()
		pages := f.rtsPages[kind]
		f.mu.Unlock()
		idx := 0
		if cur != "" {
			fmt.Sscanf(cur, "c%d", &idx)
		}
		var msgs []map[string]any
		if idx < len(pages) {
			msgs = pages[idx]
		}
		next := ""
		if idx+1 < len(pages) {
			next = fmt.Sprintf("c%d", idx+1)
		}
		out(map[string]any{"ok": true, "results": map[string]any{"messages": msgs}, "response_metadata": map[string]any{"next_cursor": next}})
	case "search.messages":
		q, _ := args["query"].(string)
		kind := classify(q)
		f.mu.Lock()
		m := f.legacy[kind]
		f.mu.Unlock()
		out(map[string]any{"ok": true, "messages": map[string]any{"matches": m, "paging": map[string]any{"pages": 1, "page": 1}}})
	case "conversations.replies":
		k := fmt.Sprint(args["channel"]) + ":" + fmt.Sprint(args["ts"])
		f.mu.Lock()
		m, ok := f.replies[k]
		f.mu.Unlock()
		if !ok {
			fail("thread_not_found", nil)
			return
		}
		out(map[string]any{"ok": true, "messages": m, "has_more": false})
	case "conversations.history":
		f.mu.Lock()
		m := f.history[fmt.Sprint(args["channel"])]
		f.mu.Unlock()
		out(map[string]any{"ok": true, "messages": m})
	case "conversations.info":
		out(map[string]any{"ok": true, "channel": map[string]any{"id": args["channel"], "is_im": true, "user": "U_ALICE", "last_read": "1", "unread_count_display": 2}})
	case "users.info":
		id := fmt.Sprint(args["user"])
		f.mu.Lock()
		name, ok := f.users[id]
		f.mu.Unlock()
		if !ok {
			fail("user_not_found", nil)
			return
		}
		out(map[string]any{"ok": true, "user": map[string]any{"id": id, "name": strings.ToLower(name), "real_name": name, "profile": map[string]any{"display_name": name}}})
	default:
		fail("unknown_method", nil)
	}
}

var quoteRe = regexp.MustCompile(`from:|is:thread`)

func classify(q string) string {
	switch {
	case strings.Contains(q, "to:"):
		return "dm"
	case quoteRe.MatchString(q):
		return "part"
	}
	return "mention"
}

// ---- builders ----

func slackTS(base int64, n int) string { return fmt.Sprintf("%d.%06d", base, n) }

// rtsHit: a Real-time Search message result.
func rtsHit(channel, name, ts, user, text, permalink string) map[string]any {
	return map[string]any{"channel_id": channel, "channel_name": name, "message_ts": ts, "author_user_id": user, "content": text, "permalink": permalink}
}

// legacyHit: a search.messages match.
func legacyHit(channel, name, ts, user, text, permalink string, im bool) map[string]any {
	return map[string]any{"channel": map[string]any{"id": channel, "name": name, "is_im": im}, "ts": ts, "user": user, "text": text, "permalink": permalink}
}

func smsg(ts, user, text string) map[string]any {
	return map[string]any{"ts": ts, "user": user, "text": text}
}

var _ = time.Second
