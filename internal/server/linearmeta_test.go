package server

import (
	"fmt"
	"strings"
	"sync"
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

// teamListsOf asks for one team's lists (the call the dialog makes when a team is selected).
func (e *linEnv) teamListsOf(id, team string, refresh bool) (int, map[string]any) {
	e.t.Helper()
	code, obj, _ := e.do("POST", "/api/threads/"+id+"/linear/team/"+team+"/lists", map[string]any{"refresh": refresh}, nil)
	return code, obj
}

func TestLinearMetaMakesNoPerTeamCalls(t *testing.T) {
	e, _, id := newDraftEnv(t)
	m := e.metaOf(id, false)
	for _, tm := range m["teams"].([]any) {
		if tm := tm.(map[string]any); tm["states"] != nil || tm["labels"] != nil {
			t.Errorf("team lists in the meta stage: %v", tm)
		}
	}
	for _, tool := range []string{"list_issue_statuses", "list_issue_labels"} {
		if n := len(e.f.callsOf(tool)); n != 0 {
			t.Errorf("%s called %d times by the meta stage", tool, n)
		}
	}
	for _, l := range m["lists"].([]any) {
		if name := l.(map[string]any)["list"].(string); strings.Contains(name, " of ") {
			t.Errorf("per-team entry in the meta lists: %s", name)
		}
	}
}

func TestLinearTeamListsOnSelection(t *testing.T) {
	e, _, id := newDraftEnv(t)
	e.metaOf(id, false)
	code, obj := e.teamListsOf(id, "team-1", false)
	if code != 200 {
		t.Fatalf("%d %v", code, obj)
	}
	tm := obj["team"].(map[string]any)
	if len(tm["states"].([]any)) != 4 || tm["default_state_id"] != "st-2" || tm["started_state_id"] != "st-3" || len(tm["labels"].([]any)) != 2 {
		t.Errorf("team 1 %v", tm) // "Design only" belongs to the other team
	}
	if obj["warnings"] != nil || len(obj["lists"].([]any)) != 2 {
		t.Errorf("warnings/lists %v %v", obj["warnings"], obj["lists"])
	}
	if a, b := len(e.f.callsOf("list_issue_statuses")), len(e.f.callsOf("list_issue_labels")); a != 1 || b != 1 {
		t.Fatalf("calls: statuses %d labels %d, want 1 each", a, b)
	}
	// Re-selecting hits the cache; refresh bypasses it.
	e.teamListsOf(id, "team-1", false)
	if a := len(e.f.callsOf("list_issue_statuses")); a != 1 {
		t.Errorf("cache not used: %d status calls", a)
	}
	e.teamListsOf(id, "team-1", true)
	if a := len(e.f.callsOf("list_issue_statuses")); a != 2 {
		t.Errorf("refresh did not refetch: %d", a)
	}
	// Another team costs its own pair of calls, and only when selected.
	_, obj = e.teamListsOf(id, "team-2", false)
	if n := len(obj["team"].(map[string]any)["labels"].([]any)); n != 3 {
		t.Errorf("team 2 labels %d", n)
	}
	if a := len(e.f.callsOf("list_issue_statuses")); a != 3 {
		t.Errorf("status calls %d", a)
	}
	if code, _ := e.teamListsOf(id, "team-99", false); code != 404 {
		t.Errorf("unknown team: %d", code)
	}
}

func TestLinearTeamListsAreDeduplicated(t *testing.T) {
	e, _, id := newDraftEnv(t)
	e.metaOf(id, false)
	var wg sync.WaitGroup
	for i := 0; i < 5; i++ {
		wg.Add(1)
		go func() { defer wg.Done(); e.teamListsOf(id, "team-1", false) }()
	}
	wg.Wait()
	if a, b := len(e.f.callsOf("list_issue_statuses")), len(e.f.callsOf("list_issue_labels")); a != 1 || b != 1 {
		t.Errorf("concurrent selections: statuses %d labels %d, want 1 each", a, b)
	}
}

func TestLinearTeamListsFailureWarnsAndIsNotCached(t *testing.T) {
	e, _, id := newDraftEnv(t)
	e.metaOf(id, false)
	e.f.failStatusTeam = "team-2"
	code, obj := e.teamListsOf(id, "team-2", false)
	if code != 200 {
		t.Fatalf("%d %v", code, obj)
	}
	tm := obj["team"].(map[string]any)
	if tm["name"] != "Design" || tm["states"] != nil || len(tm["labels"].([]any)) != 3 {
		t.Errorf("team 2 %v", tm)
	}
	w := warningsOf(obj)
	if len(w) != 1 || !strings.HasPrefix(w[0], "list_issue_statuses of Design: ") || !strings.Contains(w[0], "statuses unavailable") {
		t.Errorf("warnings %v", w)
	}
	var found bool
	for _, l := range obj["lists"].([]any) {
		if l := l.(map[string]any); l["list"] == "list_issue_statuses of Design" && strings.Contains(fmt.Sprint(l["error"]), "unavailable") {
			found = true
		}
	}
	if !found {
		t.Errorf("lists %v", obj["lists"])
	}
	// The other team is unaffected, and the failure was not kept: the retry fetches again.
	e.f.failStatusTeam = ""
	_, obj = e.teamListsOf(id, "team-2", false)
	if obj["warnings"] != nil || len(obj["team"].(map[string]any)["states"].([]any)) != 4 {
		t.Errorf("retry %v", obj)
	}
	// A failing label list: a warning naming the team, the states still come.
	e.f.failLabelsTeam = "team-1"
	_, obj = e.teamListsOf(id, "team-1", false)
	w = warningsOf(obj)
	if len(w) != 1 || !strings.HasPrefix(w[0], "list_issue_labels of Engineering: ") || len(obj["team"].(map[string]any)["states"].([]any)) != 4 {
		t.Errorf("labels failure: %v %v", w, obj)
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

func TestLinearMetaFailuresAreNotCached(t *testing.T) {
	e, _, id := newDraftEnv(t)
	e.f.failProjects = true
	if w := warningsOf(e.metaOf(id, false)); len(w) != 1 || !strings.HasPrefix(w[0], "list_projects: ") {
		t.Fatalf("warnings %v", w)
	}
	e.f.failProjects = false
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
