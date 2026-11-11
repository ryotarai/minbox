package linear

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestParseIssueRef(t *testing.T) {
	ok := map[string]string{
		"ENG-123": "ENG-123", " eng-7 ": "ENG-7",
		"https://linear.app/ryotarai/issue/ENG-123/some-title": "ENG-123",
		"https://linear.app/other-ws/issue/abc-9":              "ABC-9", // the workspace is not checked
	}
	for in, want := range ok {
		got, err := ParseIssueRef(in)
		if err != nil || got != want {
			t.Errorf("ParseIssueRef(%q) = %q, %v; want %q", in, got, err, want)
		}
	}
	for _, in := range []string{"", "ENG", "123", "https://example.com/ws/issue/ENG-1", "https://linear.app/ws/project/x", "ENG-1 and more"} {
		if _, err := ParseIssueRef(in); err == nil {
			t.Errorf("ParseIssueRef(%q) should fail", in)
		}
	}
}

func TestTolerantParsers(t *testing.T) {
	var v any
	// state as an object, assignee as a string, wrapped in "issue"
	_ = json.Unmarshal([]byte(`{"issue":{"id":"u1","identifier":"ENG-1","title":"T","state":{"name":"Todo","type":"unstarted"},"assignee":"Al","team":{"id":"t1","name":"Eng"},"url":"https://linear.app/x/issue/ENG-1"}}`), &v)
	is, err := ParseIssue(v)
	if err != nil || is.State != "Todo" || is.StateType != "unstarted" || is.Assignee != "Al" || is.TeamID != "t1" || is.TeamName != "Eng" {
		t.Fatalf("%+v %v", is, err)
	}
	// flat shape with status string
	_ = json.Unmarshal([]byte(`{"id":"u1","identifier":"ENG-1","status":"In Progress","statusType":"started"}`), &v)
	is, err = ParseIssue(v)
	if err != nil || is.State != "In Progress" || is.StateType != "started" {
		t.Fatalf("%+v %v", is, err)
	}
	// comments in three shapes; one without an id is dropped
	for _, doc := range []string{
		`{"comments":[{"id":"c1","body":"hi","createdAt":"2026-11-11T10:00:00Z","user":{"name":"Al","email":"a@x"}},{"body":"no id"}]}`,
		`[{"id":"c1","body":"hi","created_at":"2026-11-11T10:00:00.123Z","author":"Al"}]`,
		`{"nodes":[{"id":"c1","content":"hi","createdAt":"2026-11-11T10:00:00Z","userName":"Al"}]}`,
	} {
		_ = json.Unmarshal([]byte(doc), &v)
		cs, err := ParseComments(v)
		if err != nil || len(cs) != 1 || cs[0].ID != "c1" || cs[0].Body != "hi" || cs[0].Author != "Al" || cs[0].CreatedAt.IsZero() {
			t.Fatalf("%s: %+v %v", doc, cs, err)
		}
	}
	if _, err := ParseComments("just words"); err == nil {
		t.Error("text is not a comment list")
	}
	_ = json.Unmarshal([]byte(`{"comment":{"id":"c9"}}`), &v)
	if CommentID(v) != "c9" {
		t.Error("comment id")
	}
	_ = json.Unmarshal([]byte(`{"statuses":[{"id":"s1","name":"Todo","type":"unstarted"},{"id":"s2","name":"Doing","type":"started"},{"id":"s3","name":"In Progress","type":"started"}]}`), &v)
	if p := PickStarted(ParseStatuses(v)); p == nil || p.Name != "In Progress" {
		t.Errorf("PickStarted = %+v", p)
	}
}

// fake MCP server for the client tests.
func fakeMCP(t *testing.T, sse bool, hits *atomic.Int32, sessions *[]string) *httptest.Server {
	t.Helper()
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		if !strings.Contains(r.Header.Get("Accept"), "text/event-stream") || !strings.Contains(r.Header.Get("Accept"), "application/json") {
			t.Errorf("Accept = %q", r.Header.Get("Accept"))
		}
		var req struct {
			ID     any    `json:"id"`
			Method string `json:"method"`
		}
		_ = json.NewDecoder(r.Body).Decode(&req)
		*sessions = append(*sessions, r.Header.Get("Mcp-Session-Id"))
		if req.Method == "notifications/initialized" {
			w.WriteHeader(202)
			return
		}
		var result string
		switch req.Method {
		case "initialize":
			w.Header().Set("Mcp-Session-Id", "sess-1")
			result = `{"protocolVersion":"2025-06-18"}`
		case "tools/list":
			result = `{"tools":[{"name":"get_issue","inputSchema":{"properties":{"id":{}}}}]}`
		default:
			result = `{"content":[{"type":"text","text":"{\"ok\":true}"}]}`
		}
		body := fmt.Sprintf(`{"jsonrpc":"2.0","id":%v,"result":%s}`, req.ID, result)
		if sse {
			w.Header().Set("Content-Type", "text/event-stream")
			fmt.Fprintf(w, "event: message\ndata: {\"jsonrpc\":\"2.0\",\"method\":\"notifications/progress\"}\n\nevent: message\ndata: %s\n\n", body)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprint(w, body)
	}))
	t.Cleanup(ts.Close)
	return ts
}

func TestClientJSONAndSSEAndSession(t *testing.T) {
	for _, sse := range []bool{false, true} {
		var hits atomic.Int32
		var sessions []string
		ts := fakeMCP(t, sse, &hits, &sessions)
		c := &Client{URL: ts.URL, Token: func(context.Context, bool) (string, error) { return "tok", nil }}
		tools, err := c.Tools(context.Background(), false)
		if err != nil || len(tools) != 1 || tools[0].Pick("id", "issueId") != "id" {
			t.Fatalf("sse=%v tools %+v %v", sse, tools, err)
		}
		res, err := c.Call(context.Background(), "get_issue", map[string]any{"id": "x"})
		if err != nil || res.Value().(map[string]any)["ok"] != true {
			t.Fatalf("sse=%v call %+v %v", sse, res, err)
		}
		// the session id of initialize is sent on later requests
		if sessions[len(sessions)-1] != "sess-1" {
			t.Errorf("sessions %v", sessions)
		}
	}
}

func TestClientReinitializesOn404AndBacksOffOn429(t *testing.T) {
	var inits, calls atomic.Int32
	var drop atomic.Bool
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			ID     any    `json:"id"`
			Method string `json:"method"`
		}
		_ = json.NewDecoder(r.Body).Decode(&req)
		switch req.Method {
		case "initialize":
			inits.Add(1)
			w.Header().Set("Mcp-Session-Id", fmt.Sprintf("s%d", inits.Load()))
			fmt.Fprintf(w, `{"jsonrpc":"2.0","id":%v,"result":{}}`, req.ID)
		case "notifications/initialized":
			w.WriteHeader(202)
		default:
			calls.Add(1)
			if drop.CompareAndSwap(true, false) {
				w.WriteHeader(404) // the session is gone
				return
			}
			if r.Header.Get("X-Limit") == "" && req.Method == "tools/call" && r.URL.Query().Get("limit") != "" {
				w.Header().Set("Retry-After", "30")
				w.WriteHeader(429)
				return
			}
			fmt.Fprintf(w, `{"jsonrpc":"2.0","id":%v,"result":{"content":[{"type":"text","text":"1"}]}}`, req.ID)
		}
	}))
	defer ts.Close()
	c := &Client{URL: ts.URL, Token: func(context.Context, bool) (string, error) { return "tok", nil }}
	if _, err := c.Call(context.Background(), "x", nil); err != nil {
		t.Fatal(err)
	}
	drop.Store(true)
	if _, err := c.Call(context.Background(), "x", nil); err != nil {
		t.Fatal(err)
	}
	if inits.Load() != 2 {
		t.Errorf("initialize ran %d times, want 2 (re-initialized after the 404)", inits.Load())
	}
	// 429: later calls are refused locally until Retry-After passed
	c2 := &Client{URL: ts.URL + "?limit=1", Token: func(context.Context, bool) (string, error) { return "tok", nil }}
	now := time.Now()
	c2.Now = func() time.Time { return now }
	_, err := c2.Call(context.Background(), "x", nil)
	rl, ok := err.(*RateLimitError)
	if !ok || rl.RetryAfter != 30*time.Second {
		t.Fatalf("err = %v", err)
	}
	before := calls.Load()
	if _, err := c2.Call(context.Background(), "x", nil); err == nil || calls.Load() != before {
		t.Errorf("a call during the backoff reached the server (err %v)", err)
	}
	now = now.Add(31 * time.Second)
	if _, err := c2.Call(context.Background(), "x", nil); err == nil {
		// still 429 from the fake, but the request must have been sent
		t.Log("fake still limits")
	}
	if calls.Load() == before {
		t.Error("after the backoff a call should be sent again")
	}
}

func TestClientRefreshesOn401Once(t *testing.T) {
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(401)
	}))
	defer ts.Close()
	var forced atomic.Int32
	c := &Client{URL: ts.URL, Token: func(_ context.Context, f bool) (string, error) {
		if f {
			forced.Add(1)
		}
		return "tok", nil
	}}
	if _, err := c.Tools(context.Background(), true); err != ErrUnauthorized {
		t.Fatalf("err = %v", err)
	}
	if forced.Load() != 1 {
		t.Errorf("forced refresh %d times", forced.Load())
	}
}

func TestMCPURLFromEnv(t *testing.T) {
	if MCPURLFromEnv("") != DefaultMCPURL || MCPURLFromEnv("https://evil.example/mcp") != DefaultMCPURL || MCPURLFromEnv("http://evil.example/mcp") != DefaultMCPURL {
		t.Error("only loopback http overrides the URL")
	}
	if MCPURLFromEnv("http://127.0.0.1:9/mcp") != "http://127.0.0.1:9/mcp" {
		t.Error("loopback override")
	}
}
