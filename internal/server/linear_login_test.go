package server

import (
	"bytes"
	"log"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"
	"testing/fstest"
	"time"

	"github.com/ryotarai/minbox/internal/linear"
)

func stateOf(t *testing.T, cb string) string {
	t.Helper()
	u, err := url.Parse(cb)
	if err != nil {
		t.Fatal(err)
	}
	return u.Query().Get("state")
}

type lockedBuf struct {
	mu sync.Mutex
	b  bytes.Buffer
}

func (l *lockedBuf) Write(p []byte) (int, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.b.Write(p)
}
func (l *lockedBuf) String() string { l.mu.Lock(); defer l.mu.Unlock(); return l.b.String() }

func logCapture(t *testing.T) *lockedBuf {
	t.Helper()
	buf := &lockedBuf{}
	prev := log.Writer()
	log.SetOutput(buf)
	t.Cleanup(func() { log.SetOutput(prev) })
	return buf
}

func (e *linEnv) tokenCalls() int {
	e.f.mu.Lock()
	defer e.f.mu.Unlock()
	return e.f.tokenCalls
}

func TestLinearDoubleCallbackShowsSuccessWithoutAnotherExchange(t *testing.T) {
	e := newLinEnv(t)
	cb := e.startLogin()
	buf := logCapture(t)
	for i := 0; i < 3; i++ {
		code, body, _ := e.raw("GET", cb, "", navHeaders)
		if code != 200 || !strings.Contains(body, "Connected to Linear") {
			t.Fatalf("hit %d: %d %s", i, code, body)
		}
	}
	if n := e.tokenCalls(); n != 1 {
		t.Fatalf("token exchanges = %d, want 1", n)
	}
	_, st, _ := e.do("GET", "/api/integrations/linear", nil, nil)
	if st["connected"] != true || st["last_login_error"] != nil {
		t.Fatalf("status %v", st)
	}
	out := buf.String()
	if strings.Count(out, "login callback hit") != 3 || !strings.Contains(out, "replayed after success") {
		t.Fatalf("log: %s", out)
	}
	if strings.Contains(out, stateOf(t, cb)) || strings.Contains(out, "code=") {
		t.Fatalf("log leaks the state or code: %s", out)
	}
	// concurrent hits: one exchange
	cb = e.startLogin()
	done := make(chan int, 4)
	for i := 0; i < 4; i++ {
		go func() { c, _, _ := e.raw("GET", cb, "", navHeaders); done <- c }()
	}
	for i := 0; i < 4; i++ {
		if c := <-done; c != 200 {
			t.Fatalf("concurrent hit: %d", c)
		}
	}
	if n := e.tokenCalls(); n != 2 {
		t.Fatalf("token exchanges = %d, want 2", n)
	}
}

func TestLinearLoginSurvivesARestart(t *testing.T) {
	e := newLinEnv(t)
	cb := e.startLogin()
	// a new Server on the same store: the pending login was persisted
	srv2 := New(Config{DataDir: e.dir, ClaudeCommand: []string{"claude"}, PluginDir: "/plugin"}, e.st, fstest.MapFS{"index.html": {Data: []byte("x")}})
	srv2.lin.mcpURL = e.f.ts.URL + "/mcp"
	ts2 := httptest.NewServer(srv2)
	defer ts2.Close()
	req, _ := http.NewRequest("GET", ts2.URL+cb, nil)
	req.Host = strings.TrimPrefix(e.ts.URL, "http://") // the host the login was started from
	for k, v := range navHeaders {
		req.Header.Set(k, v)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	var b bytes.Buffer
	b.ReadFrom(resp.Body)
	resp.Body.Close()
	if resp.StatusCode != 200 || !strings.Contains(b.String(), "Connected to Linear") {
		t.Fatalf("after restart: %d %s", resp.StatusCode, b.String())
	}
}

func TestLinearErrorCallbackShowsLinearsReasonEvenWithUnknownState(t *testing.T) {
	e := newLinEnv(t)
	buf := logCapture(t)
	code, body, _ := e.raw("GET", linearCallbackPath+"?error=invalid_request&error_description=redirect_uri+mismatch&state=zzzzzzzzzz", "", navHeaders)
	if code != 400 || !strings.Contains(body, "invalid_request") || !strings.Contains(body, "redirect_uri mismatch") {
		t.Fatalf("%d %s", code, body)
	}
	if !strings.Contains(buf.String(), "reason=linear_error") {
		t.Fatalf("log: %s", buf.String())
	}
	// no state at all
	code, body, _ = e.raw("GET", linearCallbackPath+"?error=access_denied", "", navHeaders)
	if code != 400 || !strings.Contains(body, "access_denied") {
		t.Fatalf("%d %s", code, body)
	}
	// and Settings shows it
	_, st, _ := e.do("GET", "/api/integrations/linear", nil, nil)
	if s, _ := st["last_login_error"].(string); !strings.Contains(s, "access_denied") {
		t.Fatalf("status %v", st)
	}
}

func TestLinearCallbackMessagesAreDistinct(t *testing.T) {
	e := newLinEnv(t)
	_, body, _ := e.raw("GET", linearCallbackPath+"?code=x&state=nope", "", navHeaders)
	if !strings.Contains(body, "unknown") || !strings.Contains(body, "restarted") {
		t.Errorf("unknown: %s", body)
	}
	_, body, _ = e.raw("GET", linearCallbackPath+"?code=x", "", navHeaders)
	if !strings.Contains(body, "no login state") {
		t.Errorf("no state: %s", body)
	}
	cb := e.startLogin()
	_, body, _ = e.raw("GET", cb, "localhost:1", navHeaders)
	if !strings.Contains(body, "another address") {
		t.Errorf("host: %s", body)
	}
	// the failed attempt is remembered as failed: a replay says it was already used
	_, body, _ = e.raw("GET", cb, "", navHeaders)
	if !strings.Contains(body, "already used") {
		t.Errorf("replay of a failure: %s", body)
	}
}

func TestLinearLoginTTL(t *testing.T) {
	e := newLinEnv(t)
	if e.srv.lin.loginTTL < 15*time.Minute {
		t.Fatalf("loginTTL = %v", e.srv.lin.loginTTL)
	}
	cb := e.startLogin()
	cb2 := e.startLogin()
	now := time.Now()
	e.srv.lin.now = func() time.Time { return now.Add(e.srv.lin.loginTTL - time.Minute) }
	if code, body, _ := e.raw("GET", cb, "", navHeaders); code != 200 {
		t.Fatalf("within ttl: %d %s", code, body)
	}
	e.srv.lin.now = func() time.Time { return now.Add(e.srv.lin.loginTTL + time.Minute) }
	code, body, _ := e.raw("GET", cb2, "", navHeaders)
	if code != 400 || !strings.Contains(body, "expired") {
		t.Fatalf("after ttl: %d %s", code, body)
	}
}

func TestLinearStateSurvivesRedirectMangling(t *testing.T) {
	// AuthURL carries the state intact and the state is URL-safe
	d := &linear.Discovery{AuthorizationEndpoint: "https://linear.example/authorize"}
	reg := &linear.Registration{ClientID: "c", RedirectURI: "http://127.0.0.1:1/cb"}
	st := linear.RandomState()
	if strings.ContainsAny(st, "+/=%&? ") {
		t.Fatalf("state not URL-safe: %q", st)
	}
	u, _ := url.Parse(linear.AuthURL(d, reg, st, "ch", "read write"))
	if u.Query().Get("state") != st || !strings.Contains(u.RawQuery, "state="+st) {
		t.Fatalf("auth URL %s", u)
	}

	e := newLinEnv(t)
	hex := "0123456789ABCDEF"
	mangles := map[string]func(cb string) string{
		"percent-re-encoded": func(cb string) string {
			s := stateOf(t, cb)
			var b strings.Builder
			for i := 0; i < len(s); i++ {
				b.WriteString("%" + string(hex[s[i]>>4]) + string(hex[s[i]&15]))
			}
			return strings.Replace(cb, "state="+s, "state="+b.String(), 1)
		},
		"double-encoded": func(cb string) string {
			s := stateOf(t, cb)
			return strings.Replace(cb, "state="+s, "state="+url.QueryEscape(url.QueryEscape(s)), 1)
		},
		"state twice":      func(cb string) string { return cb + "&state=" + stateOf(t, cb) },
		"appended params":  func(cb string) string { return cb + "%3Fextra%3D1" },
		"trailing space":   func(cb string) string { return cb + "%20" },
		"real state first": func(cb string) string { return cb + "&state=bogus" },
	}
	for name, mangle := range mangles {
		cb := e.startLogin()
		code, body, _ := e.raw("GET", mangle(cb), "", navHeaders)
		if code != 200 || !strings.Contains(body, "Connected") {
			t.Errorf("%s: %d %s", name, code, body)
		}
	}
}

func TestLinearCallbackWithoutFetchMetadata(t *testing.T) {
	e := newLinEnv(t)
	cb := e.startLogin()
	if code, body, _ := e.raw("GET", cb, "", map[string]string{"X-Forwarded-For": "100.64.0.9"}); code != 200 {
		t.Fatalf("no Sec-Fetch headers: %d %s", code, body)
	}
}
