package linear

import "testing"

func TestNextCursorShapes(t *testing.T) {
	for name, tc := range map[string]struct {
		in   map[string]any
		want string
	}{
		"nextCursor":    {map[string]any{"nextCursor": "a"}, "a"},
		"next_cursor":   {map[string]any{"next_cursor": "b"}, "b"},
		"pageInfo":      {map[string]any{"pageInfo": map[string]any{"hasNextPage": true, "endCursor": "c"}}, "c"},
		"pageInfo end":  {map[string]any{"pageInfo": map[string]any{"hasNextPage": false, "endCursor": "c"}}, ""},
		"nested data":   {map[string]any{"data": map[string]any{"nextCursor": "d"}}, "d"},
		"none":          {map[string]any{"teams": []any{}}, ""},
		"hasMore false": {map[string]any{"hasMore": false, "cursor": "x"}, ""},
	} {
		if got := NextCursor(tc.in); got != tc.want {
			t.Errorf("%s: %q, want %q", name, got, tc.want)
		}
	}
}

func TestEmbeddedJSONAndValue(t *testing.T) {
	r := &Result{Text: "Found 2 teams:\n{\"teams\":[{\"id\":\"1\",\"name\":\"A\"},{\"id\":\"2\",\"name\":\"B\"}]}\nDone"}
	if n := len(ParseTeams(r.Value())); n != 2 {
		t.Errorf("teams %d", n)
	}
	if _, ok := EmbeddedJSON("Issue ENG-1 [Done] is fine"); ok {
		t.Error("prose parsed as JSON")
	}
}
