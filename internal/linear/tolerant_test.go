package linear

import (
	"encoding/json"
	"strings"
	"testing"
)

func textRes(texts ...string) *Result {
	r := &Result{}
	for _, t := range texts {
		r.Blocks = append(r.Blocks, Block{Type: "text", Text: t})
	}
	r.Text = strings.Join(texts, "\n")
	return r
}

func readIssues(r *Result) []Issue { return ParseIssues(IssueItems(r.Value())) }

func idents(is []Issue) string {
	var s []string
	for _, i := range is {
		s = append(s, i.Identifier)
	}
	return strings.Join(s, ",")
}

func TestReadIssuesVariants(t *testing.T) {
	uuid := "0b1c2d3e-1111-4222-8333-444455556666"
	structured := &Result{Structured: map[string]any{"issues": []any{map[string]any{"identifier": "ENG-1", "title": "A"}}}}
	cases := []struct {
		name  string
		res   *Result
		want  string // identifiers, in order
		check func(t *testing.T, is []Issue)
	}{
		{"canonical", textRes(`{"issues":[{"id":"` + uuid + `","identifier":"ENG-123","title":"T","status":"In Progress","priority":{"value":2,"name":"High"},"url":"https://linear.app/w/issue/ENG-123/t","labels":["bug"],"assignee":"Me","assigneeId":"u1","createdAt":"2025-01-02T03:04:05Z","dueDate":null},{"identifier":"ENG-124","title":"U","status":"Todo"}],"hasNextPage":false,"cursor":null}`), "ENG-123,ENG-124",
			func(t *testing.T, is []Issue) {
				if is[0].State != "In Progress" || is[0].Priority != 2 || is[0].Labels[0] != "bug" || is[0].CreatedAt.IsZero() {
					t.Errorf("%+v", is[0])
				}
			}},
		{"two blocks, json then pagination note", textRes(`{"issues":[{"identifier":"ENG-1","title":"A"},{"identifier":"ENG-2","title":"B"}]}`, `Next page cursor: abc123`), "ENG-1,ENG-2", nil},
		{"two blocks, note first", textRes(`Found 2 issues`, `{"issues":[{"identifier":"ENG-1","title":"A"},{"identifier":"ENG-2","title":"B"}]}`), "ENG-1,ENG-2", nil},
		{"preface line then json", textRes("Here are your issues:\n" + `{"issues":[{"identifier":"ENG-1","title":"A"}]}`), "ENG-1", nil},
		{"structuredContent", structured, "ENG-1", nil},
		{"top-level array", textRes(`[{"identifier":"ENG-1","title":"A"},{"identifier":"ENG-2","title":"B"}]`), "ENG-1,ENG-2", nil},
		{"issue wrapper", textRes(`{"issues":[{"issue":{"identifier":"ENG-1","title":"A"}},{"issue":{"identifier":"ENG-2","title":"B"}}]}`), "ENG-1,ENG-2", nil},
		{"edges and node", textRes(`{"issues":{"edges":[{"node":{"identifier":"ENG-1","title":"A"}},{"node":{"identifier":"ENG-2","title":"B"}}],"pageInfo":{"hasNextPage":false}}}`), "ENG-1,ENG-2", nil},
		{"nodes", textRes(`{"data":{"issues":{"nodes":[{"identifier":"ENG-1","title":"A"}]}}}`), "ENG-1", nil},
		{"id is the identifier", textRes(`{"issues":[{"id":"ENG-5","title":"A"},{"id":"ENG-6","title":"B"}]}`), "ENG-5,ENG-6", nil},
		{"identifier from url", textRes(`{"issues":[{"id":"` + uuid + `","title":"A","url":"https://linear.app/acme/issue/ENG-77/some-slug"}]}`), "ENG-77", nil},
		{"identifier from team key and number", textRes(`{"issues":[{"id":"` + uuid + `","number":42,"team":{"key":"OPS","name":"Ops"},"title":"A"}]}`), "OPS-42", nil},
		{"number with team key string", textRes(`{"issues":[{"id":"` + uuid + `","number":"9","team":"WEB","title":"A"}]}`), "WEB-9", nil},
		{"uuid and title only", textRes(`{"issues":[{"id":"` + uuid + `","title":"A"}]}`), uuid, nil},
		{"snake_case and state object", textRes(`{"issues":[{"identifier":"ENG-1","title":"A","state":{"name":"Done","type":"completed"},"created_at":"2025-01-02T03:04:05Z","assignee_id":"u1","due_date":"2025-02-01","priority_label":"Low"}]}`), "ENG-1",
			func(t *testing.T, is []Issue) {
				if is[0].State != "Done" || is[0].StateType != "completed" || is[0].CreatedAt.IsZero() || is[0].AssigneeID != "u1" || is[0].DueDate != "2025-02-01" || is[0].Priority != 4 {
					t.Errorf("%+v", is[0])
				}
			}},
		{"priority variants", textRes(`{"issues":[{"identifier":"ENG-1","title":"A","priority":"High"},{"identifier":"ENG-2","title":"B","priority":"3"},{"identifier":"ENG-3","title":"C","priority":null},{"identifier":"ENG-4","title":"D","priority":{"value":"1","name":"Urgent"}},{"identifier":"ENG-5","title":"E","priority":[1]}]}`), "ENG-1,ENG-2,ENG-3,ENG-4,ENG-5",
			func(t *testing.T, is []Issue) {
				if is[0].Priority != 2 || is[1].Priority != 3 || is[2].Priority != 0 || is[3].Priority != 1 {
					t.Errorf("%+v %+v %+v %+v", is[0].Priority, is[1].Priority, is[2].Priority, is[3].Priority)
				}
			}},
		{"label variants", textRes(`{"issues":[{"identifier":"ENG-1","title":"A","labels":{"nodes":[{"name":"x"},{"name":"y"}]}},{"identifier":"ENG-2","title":"B","labels":"a, b"},{"identifier":"ENG-3","title":"C","labels":[{"name":"z"}]},{"identifier":"ENG-4","title":"D","labels":7}]}`), "ENG-1,ENG-2,ENG-3,ENG-4",
			func(t *testing.T, is []Issue) {
				if len(is[0].Labels) != 2 || len(is[1].Labels) != 2 || is[2].Labels[0] != "z" {
					t.Errorf("%+v", is)
				}
			}},
		{"assignee variants", textRes(`{"issues":[{"identifier":"ENG-1","title":"A","assignee":null},{"identifier":"ENG-2","title":"B","assignee":{"name":"Me","id":"u1"}},{"identifier":"ENG-3","title":"C","assignee":12}]}`), "ENG-1,ENG-2,ENG-3", nil},
		{"odd optional types are ignored", textRes(`{"issues":[{"identifier":"ENG-1","title":"A","labels":true,"project":5,"team":[1],"estimate":[],"createdAt":99,"status":{"x":1}}]}`), "ENG-1", nil},
		{"grouped by state", textRes(`{"groups":[{"state":"Todo","issues":[{"identifier":"ENG-1","title":"A"}]},{"state":"Done","issues":[{"identifier":"ENG-2","title":"B"}]}]}`), "ENG-1,ENG-2", nil},
		{"array of strings", textRes(`{"issues":["ENG-1: Alpha (Todo)","ENG-2: Beta (Done)"]}`), "ENG-1,ENG-2", nil},
		{"markdown table", textRes("| ID | Title | Status | Priority |\n|---|---|---|---|\n| ENG-10 | First thing | In Progress | High |\n| ENG-11 | Second | Todo | Low |"), "ENG-10,ENG-11",
			func(t *testing.T, is []Issue) {
				if is[0].Title != "First thing" || is[0].State != "In Progress" || is[0].Priority != 2 {
					t.Errorf("%+v", is[0])
				}
			}},
		{"markdown table in the second block", textRes("Issues assigned to you:", "| Issue | Title | State |\n| --- | --- | --- |\n| [ENG-1](https://linear.app/w/issue/ENG-1/a) | Alpha | Todo |"), "ENG-1",
			func(t *testing.T, is []Issue) {
				if is[0].Title != "Alpha" || is[0].URL == "" {
					t.Errorf("%+v", is[0])
				}
			}},
		{"bullet list with parentheses", textRes("- ENG-123: Fix the login (In Progress)\n- ENG-124: Another one (Todo)"), "ENG-123,ENG-124",
			func(t *testing.T, is []Issue) {
				if is[0].Title != "Fix the login" || is[0].State != "In Progress" {
					t.Errorf("%+v", is[0])
				}
			}},
		{"linked bullet list with status", textRes("1. **[ENG-9](https://linear.app/w/issue/ENG-9/x)** Do it — Status: Backlog, Priority: Urgent"), "ENG-9",
			func(t *testing.T, is []Issue) {
				if is[0].State != "Backlog" || is[0].Priority != 1 || is[0].Title != "Do it" {
					t.Errorf("%+v", is[0])
				}
			}},
		{"japanese titles", textRes(`{"issues":[{"identifier":"ENG-1","title":"ログインの不具合を直す","status":"進行中"}]}`), "ENG-1", nil},
		{"result wrapper with text field list", textRes(`{"result":{"items":[{"identifier":"ENG-1","title":"A"}]}}`), "ENG-1", nil},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := readIssues(c.res)
			if idents(got) != c.want {
				t.Fatalf("got %q, want %q (value %v)", idents(got), c.want, c.res.Value())
			}
			if c.check != nil {
				c.check(t, got)
			}
		})
	}
}

func TestDiagnoseLeaksNoValues(t *testing.T) {
	secret := "SuperSecretTitleXYZ"
	var v any
	_ = json.Unmarshal([]byte(`{"weird":[{"summary":"`+secret+`","code":"ENG-123","uuid-key":"0b1c2d3e-1111-4222-8333-444455556666","priority":{"value":2,"name":"High"},"n":null,"tags":["a"]}],"0b1c2d3e-1111-4222-8333-444455556666":1}`), &v)
	r := &Result{Structured: v, Blocks: []Block{{Type: "text", Text: "x"}, {Type: "image"}}}
	items := Items(v)
	d := Diagnose("list_issues", r, items, true)
	for _, bad := range []string{secret, "0b1c2d3e", "High"} {
		if strings.Contains(d, bad) {
			t.Errorf("diagnosis leaks %q:\n%s", bad, d)
		}
	}
	for _, want := range []string{"tool: list_issues", "content blocks: 2 [text,image]", "item[0]:", "priority:object{name:string, value:number}", "code:string", "n:null"} {
		if !strings.Contains(d, want) {
			t.Errorf("diagnosis lacks %q:\n%s", want, d)
		}
	}
	// A non-JSON text: only a masked start, no digits, uuids or long tokens.
	r = textRes("Total 12 results for 0b1c2d3e-1111-4222-8333-444455556666 averyveryveryverylongtokenhere done")
	d = Diagnose("list_issues", r, nil, true)
	if strings.Contains(d, "12") || strings.Contains(d, "0b1c") || strings.Contains(d, "averyvery") || !strings.Contains(d, "text start (masked)") || !strings.Contains(d, "<uuid>") || !strings.Contains(d, "<long>") {
		t.Errorf("text not masked:\n%s", d)
	}
	if got := readIssues(r); len(got) != 0 {
		t.Errorf("read issues from a text without identifiers: %+v", got)
	}
	// Identifier form shown for an item whose id is an identifier.
	d = Diagnose("list_issues", textRes(`{"issues":[{"id":"ENG-123"}]}`), Items(map[string]any{"issues": []any{map[string]any{"id": "ENG-123"}}}), false)
	if !strings.Contains(d, "ENG-###") || strings.Contains(d, "ENG-123") {
		t.Errorf("identifier form:\n%s", d)
	}
}

func TestParseUserAndIssueText(t *testing.T) {
	if u := ParseUser("Name: Ryota Arai\nEmail: r@example.com\nID: u-1"); u == nil || u.ID != "u-1" || u.Name != "Ryota Arai" || u.Email != "r@example.com" {
		t.Errorf("%+v", u)
	}
	if u := ParseUser(map[string]any{"user": map[string]any{"display_name": "Ryo", "Id": "u2"}}); u == nil || u.ID != "u2" || u.Name != "Ryo" {
		t.Errorf("%+v", u)
	}
	is, err := ParseIssue("# ENG-5: Title here (In Progress)\n\nBody text")
	if err != nil || is.Identifier != "ENG-5" || is.State != "In Progress" || !strings.Contains(is.Description, "Body text") {
		t.Errorf("%+v %v", is, err)
	}
}
