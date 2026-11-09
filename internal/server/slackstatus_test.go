package server

import (
	"testing"
)

func TestReceiveStatusInListAndCheckEndpoint(t *testing.T) {
	e := newEnv(t)
	app := func(cfg map[string]any) string {
		c := map[string]any{"bot_token": "xox" + "b-1-fakefakefake", "channel": "U0ME"}
		for k, v := range cfg {
			c[k] = v
		}
		code, d, _ := e.do("POST", "/api/notifications", map[string]any{"type": "slack_app", "name": "bot", "config": c}, nil)
		if code != 201 {
			t.Fatalf("create: %d %v", code, d)
		}
		return d["id"].(string)
	}
	off := app(nil)
	on := app(map[string]any{"receive": true})

	_, list, _ := e.do("GET", "/api/notifications", nil, nil)
	byID := map[string]map[string]any{}
	for _, d := range list["destinations"].([]any) {
		m := d.(map[string]any)
		byID[m["id"].(string)] = m
	}
	if _, ok := byID[off]["receive_status"]; ok {
		t.Fatalf("receive_status on a destination that does not receive: %v", byID[off])
	}
	st, _ := byID[on]["receive_status"].(map[string]any)
	if st == nil || st["receiving"] != false || st["dm_known"] != false || st["delivered"] != float64(0) || st["last_poll_at"] != nil {
		t.Fatalf("status = %v", byID[on]["receive_status"])
	}
	if p, _ := st["problems"].([]any); len(p) != 0 {
		t.Fatalf("problems = %v", p)
	}

	// The check endpoint: unknown id, not receiving, receiving but no worker yet.
	if code, _, _ := e.do("POST", "/api/notifications/nope/check", nil, nil); code != 404 {
		t.Fatalf("unknown: %d", code)
	}
	if code, _, _ := e.do("POST", "/api/notifications/"+off+"/check", nil, nil); code != 400 {
		t.Fatalf("receive off: %d", code)
	}
	if code, _, _ := e.do("POST", "/api/notifications/"+on+"/check", nil, nil); code != 409 {
		t.Fatalf("no worker: %d", code)
	}

	// Same guard as the other endpoints: a cross-site page and an unpaired remote are refused.
	cross := map[string]string{"Sec-Fetch-Site": "cross-site", "Origin": "https://evil.example"}
	if code, _, _ := e.do("POST", "/api/notifications/"+on+"/check", nil, cross); code != 403 {
		t.Fatalf("cross-site: %d", code)
	}
	e.srv.cfg.TailscaleLogin = "ryota@github"
	if code, _, _ := e.do("POST", "/api/notifications/"+on+"/check", nil, remoteHeaders("ryota@github")); code != 401 {
		t.Fatalf("unpaired remote: %d", code)
	}
	if code, _, _ := e.do("POST", "/api/notifications/"+on+"/check", nil, remoteHeaders("someone@github")); code != 403 {
		t.Fatalf("wrong login: %d", code)
	}
}
