package store

import (
	"context"
	"testing"
)

func TestSessionTaskEvents(t *testing.T) {
	ctx := context.Background()
	s := newStore(t)
	sess, _ := s.CreateSession(ctx, "api", "/tmp/a", "u")
	other, _ := s.CreateSession(ctx, "web", "/tmp/b", "u")
	tk, err := s.CreateTask(ctx, sess.ProjectID, sess.ID, TaskFields{Title: ptr("Fix gauge"), Steps: &[]TaskStep{{Text: "Look"}}})
	if err != nil {
		t.Fatal(err)
	}
	// Another agent's task: not in this stream.
	_, _ = s.CreateTask(ctx, other.ProjectID, other.ID, TaskFields{Title: ptr("Other work")})
	st := func(v string) *string { return &v }
	_, _ = s.UpdateTask(ctx, tk.ID, sess.ID, TaskFields{Status: st("needs_you")})
	// A step tick: left out.
	_, _ = s.UpdateTask(ctx, tk.ID, sess.ID, TaskFields{Steps: &[]TaskStep{{Text: "Look", Done: true}}})
	mid, _ := s.TaskEvents(ctx, tk.ID)
	cut := mid[len(mid)-1].At
	_, _ = s.UpdateTask(ctx, tk.ID, "", TaskFields{Status: st("done")})
	_, _ = s.UpdateTask(ctx, tk.ID, sess.ID, TaskFields{Status: st("working")})
	_ = s.AddTaskEvent(ctx, tk.ID, "status", "Reopened by your message", "", "")
	_, _ = s.UpdateTask(ctx, tk.ID, sess.ID, TaskFields{Title: ptr("Fix the gauge")})

	all, err := s.SessionTaskEvents(ctx, sess.ID, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	type row struct {
		kind, status  string
		reopened, you bool
	}
	want := []row{{"created", "", false, false}, {"status", "needs_you", false, false}, {"status", "done", false, true}, {"status", "working", true, true}, {"title", "", false, false}}
	if len(all) != len(want) {
		t.Fatalf("events = %+v", all)
	}
	for i, w := range want {
		e := all[i]
		if (row{e.Kind, e.Status, e.Reopened, e.ByYou}) != w {
			t.Errorf("event %d = %+v, want %+v", i, e, w)
		}
		if e.Title != "Fix the gauge" {
			t.Errorf("event %d title = %q", i, e.Title)
		}
	}
	if all[4].NewTitle != "Fix the gauge" {
		t.Errorf("rename = %q", all[4].NewTitle)
	}
	// Windows meet: (nil, cut] and (cut, nil] split the events.
	a, _ := s.SessionTaskEvents(ctx, sess.ID, nil, &cut)
	b, _ := s.SessionTaskEvents(ctx, sess.ID, &cut, nil)
	if len(a) != 2 || len(b) != 3 || !b[1].Reopened {
		t.Fatalf("windows = %+v / %+v", a, b)
	}
}
