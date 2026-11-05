package server

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestSlackAppAPIMasksToken(t *testing.T) {
	e := newEnv(t)
	code, d, _ := e.do("POST", "/api/notifications", map[string]any{"type": "slack_app", "name": "bot", "config": map[string]any{"bot_token": "xoxb-1-SECRETvalue9z8y", "channel": "#alerts"}}, nil)
	if code != 201 {
		t.Fatalf("create: %d %v", code, d)
	}
	raw, _ := json.Marshal(d)
	cfg := d["config"].(map[string]any)
	if strings.Contains(string(raw), "SECRET") || cfg["bot_token"] != "xoxb-…9z8y" || cfg["thread_replies"] != true || cfg["channel"] != "#alerts" {
		t.Fatalf("view = %s", raw)
	}
	id := d["id"].(string)
	// Patch with the masked token keeps the stored one.
	e.do("PATCH", "/api/notifications/"+id, map[string]any{"config": map[string]any{"bot_token": "xoxb-…9z8y", "channel": "C0123ABCD"}}, nil)
	stored, _ := e.st.GetDestination(t.Context(), id)
	if stored.Config["bot_token"] != "xoxb-1-SECRETvalue9z8y" || stored.Config["channel"] != "C0123ABCD" {
		t.Fatalf("stored = %v", stored.Config)
	}
	for _, c := range []map[string]any{{"channel": "C1"}, {"bot_token": "a b", "channel": "C1"}, {"bot_token": "xoxb-1", "channel": "a b"}} {
		if code, _, _ := e.do("POST", "/api/notifications", map[string]any{"type": "slack_app", "config": c}, nil); code != 400 {
			t.Fatalf("%v: %d", c, code)
		}
	}
	// The type list carries the setup help for the form.
	_, list, _ := e.do("GET", "/api/notifications", nil, nil)
	b, _ := json.Marshal(list)
	if !strings.Contains(string(b), `"slack_app"`) || !strings.Contains(string(b), "chat:write") {
		t.Fatalf("types = %s", b)
	}
}
