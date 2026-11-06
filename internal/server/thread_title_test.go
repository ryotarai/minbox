package server

import (
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
	if strings.ContainsAny(got, "\n\t") || strings.Contains(got, "  ") || len([]rune(got)) != 30 || !strings.HasSuffix(got, "…") {
		t.Fatalf("not trimmed: %q (%d)", got, len([]rune(got)))
	}
}
