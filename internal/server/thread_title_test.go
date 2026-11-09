package server

import (
	"context"
	"strings"
	"testing"
)

func TestAgentThreadTitle(t *testing.T) {
	e := newEnv(t)
	sess := e.createSession()
	subject := func(id string) string {
		_, obj, _ := e.do("GET", "/api/threads/"+id, nil, nil)
		return obj["subject"].(string)
	}
	send := func(m map[string]any) string {
		code, obj, _ := e.do("POST", "/api/agent/messages", m, bearer(sess))
		if code != 201 {
			t.Fatalf("send %v: %d", m, code)
		}
		return obj["thread_id"].(string)
	}
	id := send(map[string]any{"body": "First line\nmore", "thread_title": "Plan"})
	if got := subject(id); got != "Plan" {
		t.Fatalf("new thread title %q", got)
	}
	send(map[string]any{"body": "again", "thread_id": id})
	send(map[string]any{"body": "again", "thread_id": id, "thread_title": "  "})
	if got := subject(id); got != "Plan" {
		t.Fatalf("omitted/empty changed the title: %q", got)
	}
	send(map[string]any{"body": "drift", "thread_id": id, "thread_title": "Other topic"})
	if got := subject(id); got != "Other topic" {
		t.Fatalf("update %q", got)
	}
	send(map[string]any{"body": "alias", "thread_id": id, "subject": "Via alias"})
	if got := subject(id); got != "Via alias" {
		t.Fatalf("alias %q", got)
	}
	send(map[string]any{"body": "both", "thread_id": id, "subject": "old", "thread_title": "new"})
	if got := subject(id); got != "new" {
		t.Fatalf("thread_title should win: %q", got)
	}
	id2 := send(map[string]any{"body": "Derived title here"})
	if got := subject(id2); got != "Derived title here" {
		t.Fatalf("derived %q", got)
	}
	long := send(map[string]any{"body": "x", "thread_title": "line one\n\nline   two " + strings.Repeat("あ", 200)})
	got := subject(long)
	if strings.ContainsAny(got, "\n\t") || strings.Contains(got, "  ") || got != "line one line two "+strings.Repeat("あ", 200) {
		t.Fatalf("not collapsed to one full line: %q (%d)", got, len([]rune(got)))
	}
	// A new thread without a title takes the whole first line, uncut.
	fl := strings.Repeat("い", 150)
	id3 := send(map[string]any{"body": fl + "\nsecond"})
	if got := subject(id3); got != fl {
		t.Fatalf("first-line subject cut: %q", got)
	}
}

func TestAgentSessionTitleKeptInFull(t *testing.T) {
	e := newEnv(t)
	sess := e.createSession()
	long := "a  long\ntitle " + strings.Repeat("あ", 200)
	code, obj, _ := e.do("POST", "/api/agent/title", map[string]any{"title": long}, bearer(sess))
	want := "a long title " + strings.Repeat("あ", 200)
	if code != 200 || obj["title"] != want {
		t.Fatalf("code %d title %v", code, obj["title"])
	}
	got, _ := e.st.GetSession(context.Background(), sess.ID)
	if got.Title != want {
		t.Fatalf("stored %q", got.Title)
	}
}
