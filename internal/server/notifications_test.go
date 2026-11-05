package server

import (
	"bytes"
	"encoding/json"
	"io"
	"log"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
)

type slackSink struct {
	mu       sync.Mutex
	payloads []map[string]any
	status   int
	srv      *httptest.Server
}

func newSlackSink(t *testing.T) *slackSink {
	f := &slackSink{status: 200}
	f.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		var m map[string]any
		_ = json.Unmarshal(b, &m)
		f.mu.Lock()
		f.payloads = append(f.payloads, m)
		code := f.status
		f.mu.Unlock()
		w.WriteHeader(code)
		_, _ = w.Write([]byte("ok"))
	}))
	t.Cleanup(f.srv.Close)
	return f
}

func (f *slackSink) all() []map[string]any {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]map[string]any(nil), f.payloads...)
}

func (f *slackSink) text(i int) string {
	var sb strings.Builder
	for _, b := range f.all()[i]["blocks"].([]any) {
		if tx, ok := b.(map[string]any)["text"].(map[string]any); ok {
			sb.WriteString(tx["text"].(string) + "\n")
		}
	}
	return sb.String()
}

const hookSecret = "/services/T000/B000/XXXXsecretYYYY"

func (e *env) addDest(f *slackSink, cfg map[string]any) map[string]any {
	e.t.Helper()
	c := map[string]any{"webhook_url": f.srv.URL + hookSecret}
	for k, v := range cfg {
		c[k] = v
	}
	code, d, _ := e.do("POST", "/api/notifications", map[string]any{"type": "slack", "name": "team", "config": c}, nil)
	if code != 201 {
		e.t.Fatalf("create: %d %v", code, d)
	}
	return d
}

func TestNotificationsAPISecretMasked(t *testing.T) {
	e := newEnv(t)
	f := newSlackSink(t)
	var logs bytes.Buffer
	log.SetOutput(&logs)
	defer log.SetOutput(io.Discard)

	d := e.addDest(f, nil)
	raw, _ := json.Marshal(d)
	if strings.Contains(string(raw), "secretYYYY") || strings.Contains(string(raw), "XXXX") && !strings.Contains(d["config"].(map[string]any)["webhook_url"].(string), "…") {
		t.Fatalf("secret in %s", raw)
	}
	cfg := d["config"].(map[string]any)
	if cfg["webhook_url"] != f.srv.URL+"/…YYYY" || cfg["include_body"] != true || cfg["events"] != "all" || d["enabled"] != true {
		t.Fatalf("config = %v", cfg)
	}
	id := d["id"].(string)

	// The list has the types for the form, and no secret.
	code, list, _ := e.do("GET", "/api/notifications", nil, nil)
	b, _ := json.Marshal(list)
	if code != 200 || strings.Contains(string(b), "secretYYYY") || !strings.Contains(string(b), `"types"`) {
		t.Fatalf("list: %d %s", code, b)
	}

	// Patching without the URL (or with the masked one) keeps it; a new URL replaces it.
	code, d, _ = e.do("PATCH", "/api/notifications/"+id, map[string]any{"name": "ops", "config": map[string]any{"include_body": false}}, nil)
	if code != 200 || d["name"] != "ops" || d["config"].(map[string]any)["include_body"] != false {
		t.Fatalf("patch: %d %v", code, d)
	}
	e.do("PATCH", "/api/notifications/"+id, map[string]any{"config": map[string]any{"webhook_url": cfg["webhook_url"]}}, nil)
	stored, _ := e.st.GetDestination(t.Context(), id)
	if stored.Config["webhook_url"] != f.srv.URL+hookSecret {
		t.Fatalf("stored URL = %v", stored.Config["webhook_url"])
	}
	e.do("PATCH", "/api/notifications/"+id, map[string]any{"config": map[string]any{"webhook_url": f.srv.URL + "/new/hook9999"}}, nil)
	stored, _ = e.st.GetDestination(t.Context(), id)
	if stored.Config["webhook_url"] != f.srv.URL+"/new/hook9999" {
		t.Fatalf("stored URL = %v", stored.Config["webhook_url"])
	}

	// Validation.
	for _, body := range []map[string]any{
		{"type": "carrier-pigeon", "config": map[string]any{}},
		{"type": "slack", "config": map[string]any{}},
		{"type": "slack", "config": map[string]any{"webhook_url": "not a url"}},
		{"type": "slack", "config": map[string]any{"webhook_url": "https://h/x", "events": "weird"}},
	} {
		if code, _, _ := e.do("POST", "/api/notifications", body, nil); code != 400 {
			t.Fatalf("%v: %d", body, code)
		}
	}
	if code, _, _ := e.do("PATCH", "/api/notifications/nope", map[string]any{"name": "x"}, nil); code != 404 {
		t.Fatalf("patch missing: %d", code)
	}
	if code, _, _ := e.do("DELETE", "/api/notifications/"+id, nil, nil); code != 200 {
		t.Fatalf("delete: %d", code)
	}
	if code, _, _ := e.do("DELETE", "/api/notifications/"+id, nil, nil); code != 404 {
		t.Fatalf("delete again: %d", code)
	}
	if strings.Contains(logs.String(), "secretYYYY") {
		t.Fatalf("secret logged: %s", logs.String())
	}
}

func TestNotificationTestSend(t *testing.T) {
	e := newEnv(t)
	f := newSlackSink(t)
	d := e.addDest(f, nil)
	id := d["id"].(string)
	code, res, _ := e.do("POST", "/api/notifications/"+id+"/test", nil, nil)
	if code != 200 || res["ok"] != true {
		t.Fatalf("test: %d %v", code, res)
	}
	if len(f.all()) != 1 || !strings.Contains(f.text(0), "test notification") {
		t.Fatalf("sink got %v", f.all())
	}
	_, list, _ := e.do("GET", "/api/notifications", nil, nil)
	got := list["destinations"].([]any)[0].(map[string]any)
	if got["last_ok_at"] == nil || got["last_error"] != "" {
		t.Fatalf("result = %v", got)
	}

	// A failing webhook is a result with an error text, once (no retries), and is recorded.
	f.mu.Lock()
	f.status = 500
	f.mu.Unlock()
	code, res, _ = e.do("POST", "/api/notifications/"+id+"/test", nil, nil)
	if code != 200 || res["ok"] != false || !strings.Contains(res["error"].(string), "500") || strings.Contains(res["error"].(string), "secretYYYY") {
		t.Fatalf("failing test: %d %v", code, res)
	}
	if len(f.all()) != 2 {
		t.Fatalf("requests = %d", len(f.all()))
	}
	_, list, _ = e.do("GET", "/api/notifications", nil, nil)
	got = list["destinations"].([]any)[0].(map[string]any)
	if !strings.Contains(got["last_error"].(string), "500") || got["last_error_at"] == nil {
		t.Fatalf("result = %v", got)
	}
	if code, _, _ := e.do("POST", "/api/notifications/nope/test", nil, nil); code != 404 {
		t.Fatalf("test missing: %d", code)
	}
}

func TestAgentMessageNotifies(t *testing.T) {
	e := newEnv(t)
	all, action := newSlackSink(t), newSlackSink(t)
	e.addDest(all, nil)
	e.addDest(action, map[string]any{"events": "action"})

	if code, _, _ := e.do("PUT", "/api/settings", map[string]any{"public_url": "https://box.tail.ts.net/"}, nil); code != 200 {
		t.Fatalf("public_url: %d", code)
	}
	if code, _, _ := e.do("PUT", "/api/settings", map[string]any{"public_url": "javascript:alert(1)"}, nil); code != 400 {
		t.Fatalf("bad public_url: %d", code)
	}
	sess := e.createSession()
	long := "# Plan\n\nThe **full** body with <tags> & more.\n\n" + strings.Repeat("A long paragraph of text. ", 400)
	code, sent, _ := e.do("POST", "/api/agent/messages", map[string]any{"body": long, "thread_title": "The plan"}, bearer(sess))
	if code != 201 {
		t.Fatalf("send: %d %v", code, sent)
	}
	e.srv.notifier.Wait()
	if len(all.all()) != 1 || len(action.all()) != 0 {
		t.Fatalf("sinks: %d %d", len(all.all()), len(action.all()))
	}
	txt := all.text(0)
	if !strings.Contains(txt, "The plan") || !strings.Contains(txt, "*Plan*") || !strings.Contains(txt, "*full*") || !strings.Contains(txt, "&lt;tags&gt; &amp; more") {
		t.Fatalf("text = %q", txt[:200])
	}
	if strings.Count(txt, "text.") != 400 {
		t.Fatalf("not the full body: %d", strings.Count(txt, "text."))
	}
	btn := all.all()[0]["blocks"].([]any)
	last := btn[len(btn)-1].(map[string]any)["elements"].([]any)[0].(map[string]any)
	want := "https://box.tail.ts.net/#s=" + sess.ID + "&t=" + sent["thread_id"].(string)
	if last["url"] != want {
		t.Fatalf("link = %v, want %s", last["url"], want)
	}

	// A message with a question reaches both; the person's own reply reaches neither.
	q := "Which one?\n\n:::question\nA or B?\n- [ ] A\n- [ ] B\nRecommended: A\n:::"
	code, sent, _ = e.do("POST", "/api/agent/messages", map[string]any{"body": q, "thread_id": sent["thread_id"]}, bearer(sess))
	if code != 201 {
		t.Fatalf("send: %d %v", code, sent)
	}
	e.srv.notifier.Wait()
	if len(all.all()) != 2 || len(action.all()) != 1 {
		t.Fatalf("sinks: %d %d", len(all.all()), len(action.all()))
	}
	if code, r, _ := e.do("POST", "/api/threads/"+sent["thread_id"].(string)+"/reply", map[string]any{"words": "my words"}, nil); code != 200 && code != 201 {
		t.Fatalf("reply: %d %v", code, r)
	}
	e.srv.notifier.Wait()
	if len(all.all()) != 2 || len(action.all()) != 1 {
		t.Fatalf("a reply of the person notified: %d %d", len(all.all()), len(action.all()))
	}
}
