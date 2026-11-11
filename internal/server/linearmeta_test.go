package server

import (
	"fmt"
	"strings"
	"testing"
)

func manyTeams(n int) []map[string]any {
	var out []map[string]any
	for i := 1; i <= n; i++ {
		out = append(out, map[string]any{"id": fmt.Sprintf("team-%d", i), "name": fmt.Sprintf("Team %d", i), "key": fmt.Sprintf("T%d", i)})
	}
	return out
}

func (e *linEnv) metaOf(id string, refresh bool) map[string]any {
	e.t.Helper()
	code, obj, _ := e.do("POST", "/api/threads/"+id+"/linear/draft", map[string]any{"stage": "meta", "refresh": refresh}, nil)
	if code != 200 {
		e.t.Fatalf("meta: %d %v", code, obj)
	}
	return obj["meta"].(map[string]any)
}

func warningsOf(m map[string]any) []string {
	var out []string
	for _, w := range m["warnings"].([]any) {
		out = append(out, w.(string))
	}
	return out
}

func TestLinearMetaPagination(t *testing.T) {
	for _, tc := range []struct{ name, cursorKey, shape string }{
		{"cursor", "cursor", ""},
		{"after", "after", ""},
		{"pageInfo", "cursor", "pageInfo"},
		{"text content", "cursor", "text"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			e, _, id := newDraftEnv(t)
			e.f.teamList = manyTeams(11) // more than the old cap of 8
			e.f.teamPage, e.f.cursorKey, e.f.pageShape = 4, tc.cursorKey, tc.shape
			e.srv.lin.cl().Reset() // the schema changed
			m := e.metaOf(id, false)
			if n := len(m["teams"].([]any)); n != 11 {
				t.Fatalf("teams %d, want 11 (3 pages)", n)
			}
			if m["warnings"] != nil {
				t.Errorf("warnings %v", m["warnings"])
			}
			if n := len(e.f.callsOf("list_teams")); n != 3 {
				t.Errorf("list_teams calls %d, want 3", n)
			}
			for _, l := range m["lists"].([]any) {
				if l := l.(map[string]any); l["list"] == "list_teams" && (l["pages"].(float64) != 3 || l["items"].(float64) != 11 || l["tool"] != "list_teams") {
					t.Errorf("summary %v", l)
				}
			}
		})
	}
}

func TestLinearMetaLimitHonoured(t *testing.T) {
	e, _, id := newDraftEnv(t)
	e.f.teamList = manyTeams(5)
	e.f.teamPage, e.f.teamLimitMax = 50, 2 // the schema allows at most 2 per page
	e.srv.lin.cl().Reset()
	m := e.metaOf(id, false)
	if n := len(m["teams"].([]any)); n != 5 {
		t.Fatalf("teams %d", n)
	}
	for _, c := range e.f.callsOf("list_teams") {
		if c.Args["limit"] != float64(2) {
			t.Errorf("limit arg %v, want the schema maximum 2", c.Args["limit"])
		}
	}
	// Without a declared maximum the page size is asked for explicitly.
	e2, _, id2 := newDraftEnv(t)
	e2.metaOf(id2, false)
	if c := e2.f.callsOf("list_teams")[0]; c.Args["limit"] != float64(metaPageSize) {
		t.Errorf("default limit %v", c.Args["limit"])
	}
}

func TestLinearMetaStatusFailureKeepsTeam(t *testing.T) {
	e, _, id := newDraftEnv(t)
	e.f.failStatusTeam = "team-2"
	m := e.metaOf(id, false)
	teams := m["teams"].([]any)
	if len(teams) != 2 {
		t.Fatalf("teams %v", teams)
	}
	t2 := teams[1].(map[string]any)
	if t2["name"] != "Design" || len(t2["states"].([]any)) != 0 || t2["default_state_id"] != "" {
		t.Errorf("team 2 %v", t2)
	}
	if len(teams[0].(map[string]any)["states"].([]any)) != 4 {
		t.Errorf("team 1 states lost")
	}
	w := warningsOf(m)
	if len(w) != 1 || !strings.HasPrefix(w[0], "list_issue_statuses of Design: ") || !strings.Contains(w[0], "statuses unavailable") {
		t.Errorf("warnings %v", w)
	}
	// The per-list summary names the failure too.
	var found bool
	for _, l := range m["lists"].([]any) {
		if l := l.(map[string]any); l["list"] == "list_issue_statuses of Design" && strings.Contains(fmt.Sprint(l["error"]), "unavailable") {
			found = true
		}
	}
	if !found {
		t.Errorf("lists %v", m["lists"])
	}
}

func TestLinearMetaMalformedItemsSkipped(t *testing.T) {
	e, _, id := newDraftEnv(t)
	e.f.teamList = []map[string]any{
		{"id": "team-1", "name": "Engineering", "key": "ENG"},
		{"name": "no id"},
		{"id": "team-3", "key": "NOK"}, // no name: the key stands in
		{"id": "", "name": ""},
	}
	m := e.metaOf(id, false)
	if n := len(m["teams"].([]any)); n != 2 {
		t.Fatalf("teams %v", m["teams"])
	}
	w := warningsOf(m)
	if len(w) != 1 || !strings.Contains(w[0], "list_teams: parsed 2 of 4 items") {
		t.Errorf("warnings %v", w)
	}
}

func TestLinearMetaLaterPageFailureKeepsTeams(t *testing.T) {
	e, _, id := newDraftEnv(t)
	e.f.teamList = manyTeams(6)
	e.f.teamPage, e.f.failTeamsPage2 = 4, true
	m := e.metaOf(id, false)
	if n := len(m["teams"].([]any)); n != 4 {
		t.Fatalf("teams %d, want the 4 of page 1", n)
	}
	w := warningsOf(m)
	if len(w) != 1 || !strings.Contains(w[0], "list_teams: page 2 failed") || !strings.Contains(w[0], "rate limited") {
		t.Errorf("warnings %v", w)
	}
}

func TestLinearMetaOneListFailingKeepsOthers(t *testing.T) {
	e, _, id := newDraftEnv(t)
	e.f.failLabels = true
	m := e.metaOf(id, false)
	teams := m["teams"].([]any)
	if len(teams) != 2 || len(teams[0].(map[string]any)["states"].([]any)) != 4 || len(m["projects"].([]any)) != 2 {
		t.Fatalf("meta %v", m)
	}
	for _, w := range warningsOf(m) {
		if !strings.HasPrefix(w, "list_issue_labels of ") || !strings.Contains(w, "labels unavailable") {
			t.Errorf("warning %q", w)
		}
	}
}

func TestLinearMetaFailuresAreNotCached(t *testing.T) {
	e, _, id := newDraftEnv(t)
	e.f.failLabels = true
	if w := warningsOf(e.metaOf(id, false)); len(w) != 2 {
		t.Fatalf("warnings %v", w)
	}
	e.f.failLabels = false
	m := e.metaOf(id, false) // no explicit refresh: the partial result was not kept
	if m["warnings"] != nil {
		t.Errorf("stale warnings %v", m["warnings"])
	}
	// A good result is cached; refresh bypasses the cache.
	before := len(e.f.callsOf("list_teams"))
	e.metaOf(id, false)
	if n := len(e.f.callsOf("list_teams")); n != before {
		t.Errorf("cache not used: %d -> %d", before, n)
	}
	e.metaOf(id, true)
	if n := len(e.f.callsOf("list_teams")); n != before+1 {
		t.Errorf("refresh did not refetch: %d -> %d", before, n)
	}
}
