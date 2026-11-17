package server

import "testing"

func TestWithoutTaskContext(t *testing.T) {
	in := "[Task: Search box UI]\n> Task context (from minbox): Building it\n> Status: In progress\n\nDebounce it."
	if got := withoutTaskContext(in); got != "[Task: Search box UI]\n\nDebounce it." {
		t.Fatalf("got %q", got)
	}
	for _, s := range []string{"plain", "[Task: X]\nno context", "> quote\n> more"} {
		if got := withoutTaskContext(s); got != s {
			t.Fatalf("%q changed to %q", s, got)
		}
	}
}
