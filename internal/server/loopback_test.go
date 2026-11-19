package server

import (
	"encoding/base64"
	"encoding/json"
	"net/http"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/ryotarai/minbox/internal/agent"
	"github.com/ryotarai/minbox/internal/devices"
)

// Every agent's shell tool refuses a command that would accept a pairing (the agent pairing a
// browser of its own, then acting as the person).
func TestGuardRefusesPairAccept(t *testing.T) {
	re := regexp.MustCompile(pairAcceptPatterns[0]) // no lookahead: Go reads it as JavaScript does
	for _, c := range []string{
		"minbox pair accept 482-913",
		"minbox pair accept 482913 --data-dir ~/.minbox",
		"./bin/minbox pair accept 482-913",
		"go run ./cmd/minbox pair accept 1",
		"cd /x && minbox pair accept 1",
		`sh -c "minbox pair accept 1"`,
		"minbox --data-dir /d pair accept 1",
		"script -q /dev/null minbox pair accept 1",
		"echo y | minbox pair accept 1",
	} {
		if !re.MatchString(c) {
			t.Errorf("not refused: %s", c)
		}
	}
	for _, c := range []string{"minbox pair list", "minbox pair reject 1", "git commit -m 'minbox: pair accept docs'", "grep -n 'pair accept' x", "myminbox pair accept 1"} {
		if re.MatchString(c) {
			t.Errorf("refused: %s", c)
		}
	}
	for _, kind := range []string{agent.Claude, agent.Pi, agent.OpenCode} {
		found := false
		for _, g := range manifestFor(kind).Guards {
			if g.Deny == pairAcceptDeny && !g.MainOnly && len(g.Tools) > 0 {
				found = true
			}
		}
		if !found {
			t.Errorf("%s: no pair-accept guard", kind)
		}
	}
}

// H1: a process on this machine (a coding agent with a shell, say) reaching 127.0.0.1 with no
// paired browser's cookie gets nothing of the person's API: it cannot reply or answer as the
// person, open a shell, add a notification webhook or read files. The mods' own API still works
// with the session's bearer token alone.
func TestLoopbackWithoutADeviceIsRefused(t *testing.T) {
	e := newEnv(t)
	sess := e.createSession()
	_, obj, _ := e.do("POST", "/api/agent/messages", map[string]string{"task_status": "working", "body": "Which one?", "subject": "Q"}, with(bearer(sess), "Cookie", ""))
	thread, _ := obj["thread_id"].(string)
	if thread == "" {
		t.Fatalf("the agent's message (bearer only): %v", obj)
	}
	none := map[string]string{"Cookie": ""}
	forged := map[string]string{"Cookie": deviceCookie + "=" + randomToken(32)}
	for _, h := range []map[string]string{none, forged} {
		for _, c := range []struct{ method, path string }{
			{"POST", "/api/threads/" + thread + "/reply"},
			{"GET", "/api/threads/" + thread},
			{"GET", "/api/sessions"},
			{"POST", "/api/sessions"},
			{"GET", "/api/sessions/" + sess.ID + "/shell/terminal"},
			{"GET", "/api/sessions/" + sess.ID + "/terminal"},
			{"POST", "/api/notifications"},
			{"GET", "/api/settings"},
			{"GET", "/api/devices"},
			{"POST", "/api/uploads"},
			{"GET", "/api/events"},
		} {
			code, obj, _ := e.do(c.method, c.path, map[string]string{"words": "yes"}, h)
			if code != 401 || obj["code"] != "unpaired" {
				t.Errorf("%s %s with Cookie %q: %d %v", c.method, c.path, h["Cookie"], code, obj)
			}
		}
	}
	// The mod's API: its token, no browser.
	if code, _, _ := e.do("GET", "/api/agent/tools", nil, with(bearer(sess), "Cookie", "")); code != 200 {
		t.Fatalf("agent API with its token: %d", code)
	}
	// What an unpaired browser needs to pair stays open on loopback.
	k := newBrowserKey(t)
	code, obj, _ := e.do("POST", "/api/devices/pair", map[string]string{"public_key": k.spki, "name": "Chrome on Mac"}, none)
	if code != 201 {
		t.Fatalf("pair from loopback: %d %v", code, obj)
	}
	reqID := obj["request_id"].(string)
	// Asking again (a reload) keeps the code.
	if _, again, _ := e.do("POST", "/api/devices/pair", map[string]string{"public_key": k.spki, "name": "Chrome on Mac"}, none); again["request_id"] != reqID || again["code"] != obj["code"] {
		t.Fatalf("asked again: %v, first %v", again, obj)
	}
	// It cannot accept itself either.
	if code, _, _ := e.do("POST", "/api/devices/requests/"+reqID+"/accept", nil, none); code != 401 {
		t.Fatalf("self-accept from loopback: %d", code)
	}
	if c, cookie := e.signInLocal(k); c != 401 || cookie != "" {
		t.Fatalf("sign-in before accept: %d %q", c, cookie)
	}
	// Accepted in a terminal (`minbox pair accept <code>`): it signs in and gets the API.
	if _, _, err := devices.Accept(e.dir, obj["code"].(string), time.Now()); err != nil {
		t.Fatal(err)
	}
	c, cookie := e.signInLocal(k)
	if c != 200 || cookie == "" {
		t.Fatalf("sign-in: %d %q", c, cookie)
	}
	if code, obj, _ := e.do("POST", "/api/threads/"+thread+"/reply", map[string]string{"words": "the first"}, map[string]string{"Cookie": cookie}); code != 201 {
		t.Fatalf("reply as the paired browser: %d %v", code, obj)
	}
}

// signInLocal answers a challenge from loopback (over plain http) and returns the cookie.
func (e *env) signInLocal(k *browserKey) (int, string) {
	e.t.Helper()
	_, obj, _ := e.do("POST", "/api/devices/auth/challenge", map[string]string{"fingerprint": k.fp}, map[string]string{"Cookie": ""})
	ch := obj["challenge"].(string)
	msg, _ := base64.StdEncoding.DecodeString(ch)
	b, _ := json.Marshal(map[string]string{"fingerprint": k.fp, "challenge": ch, "signature": k.sign(e.t, msg)})
	resp, err := http.Post(e.ts.URL+"/api/devices/auth", "application/json", strings.NewReader(string(b)))
	if err != nil {
		e.t.Fatal(err)
	}
	resp.Body.Close()
	for _, c := range resp.Cookies() {
		if c.Name == deviceCookie {
			return resp.StatusCode, deviceCookie + "=" + c.Value
		}
	}
	return resp.StatusCode, ""
}
