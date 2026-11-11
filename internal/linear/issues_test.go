package linear

import (
	"encoding/json"
	"testing"
)

func TestParseIssuesShapes(t *testing.T) {
	var v any
	_ = json.Unmarshal([]byte(`{"issues":[
	  {"id":"a","identifier":"ENG-1","title":"One","status":"In Progress","priority":{"value":2,"name":"High"},"labels":["Bug",{"name":"Infra"}],
	   "assignee":"Ryota","assigneeId":"u1","team":"Engineering","project":"Web","updatedAt":"2026-11-10T10:00:00Z","estimate":{"value":3}},
	  {"node":{"id":"b","identifier":"DES-2","title":"Two","state":{"name":"Done","type":"completed"},"priority":"Urgent","team":{"id":"t2","name":"Design","key":"DES"},"dueDate":"2026-12-01"}},
	  {"title":"no id"}
	 ],"hasNextPage":true,"cursor":"abc"}`), &v)
	got := ParseIssues(v)
	if len(got) != 2 {
		t.Fatalf("parsed %d: %+v", len(got), got)
	}
	a, b := got[0], got[1]
	if a.State != "In Progress" || a.Priority != 2 || a.PriorityName != "High" || len(a.Labels) != 2 || a.Labels[1] != "Infra" || a.TeamKey != "ENG" || a.Project != "Web" || a.Estimate != "3" || a.UpdatedAt.IsZero() || a.AssigneeID != "u1" {
		t.Errorf("a = %+v", a)
	}
	if b.StateType != "completed" || b.Priority != 1 || b.TeamKey != "DES" || b.DueDate != "2026-12-01" || !Closed(b.StateType) {
		t.Errorf("b = %+v", b)
	}
	if NextCursor(v) != "abc" {
		t.Errorf("cursor %q", NextCursor(v))
	}
}

func TestTypeByName(t *testing.T) {
	for name, want := range map[string]string{"Done": "completed", "Canceled": "canceled", "Duplicate": "canceled", "Backlog": "backlog", "Triage": "triage",
		"In Progress": "started", "In Review": "started", "Todo": "unstarted", "Weird": "unstarted", "": ""} {
		if got := TypeByName(name); got != want {
			t.Errorf("%q -> %q, want %q", name, got, want)
		}
	}
}
