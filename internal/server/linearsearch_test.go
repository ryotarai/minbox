package server

import (
	"net/url"
	"testing"
)

// The link dialog's issue search against the fake Linear: text matches, an exact identifier first,
// the cache, an empty query and a missing login.

func TestLinearSearch(t *testing.T) {
	e := newLinEnv(t)
	search := func(q string) (int, map[string]any) {
		t.Helper()
		code, obj, _ := e.do("GET", "/api/linear/search?q="+url.QueryEscape(q), nil, nil)
		return code, obj
	}
	if code, obj := search("fix"); code != 409 || obj["code"] != "linear_login" {
		t.Fatalf("not connected: %d %v", code, obj)
	}
	e.connect()
	e.f.assigned = fakeAssigned()

	code, obj := search("")
	if code != 200 || len(obj["issues"].([]any)) != 0 || len(e.f.callsOf("list_issues")) != 0 {
		t.Fatalf("empty query: %d %v", code, obj)
	}

	code, obj = search("urgent")
	if code != 200 {
		t.Fatalf("search %d %v", code, obj)
	}
	if got := identsOf(obj); len(got) != 1 || got[0] != "ENG-124" {
		t.Fatalf("urgent: %v", got)
	}
	is := obj["issues"].([]any)[0].(map[string]any)
	if is["title"] != "Urgent outage" || is["state"] != "In Progress" || is["state_type"] != "started" {
		t.Fatalf("view: %v", is)
	}
	calls := e.f.callsOf("list_issues")
	if len(calls) != 1 || calls[0].Args["query"] != "urgent" || calls[0].Args["assignee"] != nil {
		t.Fatalf("list_issues args: %+v", calls)
	}

	// Cached: the same query (any case) does not ask again.
	if code, _ := search("URGENT"); code != 200 || len(e.f.callsOf("list_issues")) != 1 {
		t.Fatalf("not cached: %d calls", len(e.f.callsOf("list_issues")))
	}

	// An identifier: the issue itself first (get_issue), then the text matches, no duplicate.
	code, obj = search("eng-123")
	if got := identsOf(obj); code != 200 || len(got) != 1 || got[0] != "ENG-123" {
		t.Fatalf("identifier: %d %v", code, got)
	}
	if len(e.f.callsOf("get_issue")) == 0 {
		t.Fatal("identifier did not read the issue")
	}
	// An identifier Linear does not know (still typing): the text search answers.
	code, obj = search("ENG-12")
	if got := identsOf(obj); code != 200 || len(got) != 5 {
		t.Fatalf("partial identifier: %d %v", code, got)
	}

	// No match: an empty list, not an error.
	code, obj = search("zzz nothing")
	if code != 200 || len(obj["issues"].([]any)) != 0 {
		t.Fatalf("no match: %d %v", code, obj)
	}

	// The tool fails: the error reaches the dialog.
	e.f.failList = true
	if code, _ := search("other text"); code < 400 {
		t.Fatalf("failing tool: %d", code)
	}
}
