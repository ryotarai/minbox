package linear

import (
	"encoding/json"
	"testing"
)

func TestParseCreateLists(t *testing.T) {
	var v any
	_ = json.Unmarshal([]byte(`{"teams":{"nodes":[{"id":"t1","name":"Eng","key":"ENG"},{"name":"no id"}]}}`), &v)
	if ts := ParseTeams(v); len(ts) != 1 || ts[0].Key != "ENG" {
		t.Errorf("teams %v", ts)
	}
	_ = json.Unmarshal([]byte(`[{"id":"l1","name":"Bug","team":{"id":"t1"}},{"id":"l2","name":"Feature"},{"id":"","name":"x"}]`), &v)
	if ls := ParseLabels(v); len(ls) != 2 || ls[0].TeamID != "t1" || ls[1].TeamID != "" {
		t.Errorf("labels %v", ls)
	}
	_ = json.Unmarshal([]byte(`{"projects":[{"id":"p1","name":"Web","teams":{"nodes":[{"id":"t1"}]}},{"id":"p2","name":"All"}]}`), &v)
	if ps := ParseProjects(v); len(ps) != 2 || len(ps[0].TeamIDs) != 1 || len(ps[1].TeamIDs) != 0 {
		t.Errorf("projects %v", ps)
	}
	if ParseTeams("junk") != nil || ParseLabels(nil) != nil {
		t.Error("junk should give nothing")
	}
}
