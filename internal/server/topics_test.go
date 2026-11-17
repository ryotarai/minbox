package server

import (
	"testing"
)

// The agent's task tools are v3's now (v3_test.go); topics stay only as older data (migrated to tasks).

func TestTopicsSettingRetired(t *testing.T) {
	e := newEnv(t)
	_, st, _ := e.do("GET", "/api/settings", nil, nil)
	if _, ok := st["topics"]; ok {
		t.Fatalf("settings = %v", st)
	}
	if code, _, _ := e.do("PUT", "/api/settings", map[string]any{"topics": false}, nil); code != 400 {
		t.Fatalf("put topics: %d", code)
	}
}
