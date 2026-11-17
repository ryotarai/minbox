package server

import (
	"context"
	"strings"
	"testing"
	"time"
)

// TestDeniedCommandsOnlyFromReports: a message that talks about denied commands offers nothing; a
// denial the integration reports is offered; running it, the agent running it, or dismissing it
// clears it.
func TestDeniedCommandsOnlyFromReports(t *testing.T) {
	e := newEnv(t)
	sess := e.createSession()
	e.srv.suggest = newSuggester(func(ctx context.Context, p string) (replyHelp, error) {
		return replyHelp{Questions: []ReplyQuestion{{Question: "Next?", Kind: "single", Options: []ReplyOption{{Label: "Go"}}}}}, nil
	})
	command := func(id string) any {
		t.Helper()
		code, o, _ := e.do("GET", "/api/threads/"+id+"/suggestions", nil, nil)
		if code != 200 {
			t.Fatalf("suggestions: %d %v", code, o)
		}
		return o["command"]
	}
	id := e.send(sess, "", "t", "Running `rm -rf build` was denied. Please run `make lint` yourself.", "need_action")
	if c := command(id); c != nil {
		t.Fatalf("a message mentioning a denial offered %v", c)
	}

	// A denial reported for the thread.
	code, o, _ := e.do("POST", "/api/agent/denied-commands", map[string]any{"command": "  go test ./... ", "reason": "rejected", "thread_id": id, "at": time.Now().Add(-time.Second).Format(time.RFC3339Nano)}, bearer(sess))
	if code != 200 || o["thread_id"] != id {
		t.Fatalf("report: %d %v", code, o)
	}
	e.send(sess, id, "t", "I could not run the tests.", "need_action")
	if c := command(id); c != "!go test ./..." {
		t.Fatalf("command = %v", c)
	}
	// Also when the questions are off or not needed.
	e.do("PUT", "/api/settings", map[string]any{"reply_suggestions": false}, nil)
	if c := command(id); c != "!go test ./..." {
		t.Fatalf("disabled: command = %v", c)
	}
	e.do("PUT", "/api/settings", map[string]any{"reply_suggestions": true}, nil)

	// The agent ran it later: cleared.
	if code, o, _ := e.do("POST", "/api/agent/denied-commands/ran", map[string]any{"command": "go test ./..."}, bearer(sess)); code != 200 || o["cleared"] != true {
		t.Fatalf("ran: %d %v", code, o)
	}
	if c := command(id); c != nil {
		t.Fatalf("after the agent ran it: %v", c)
	}

	// Dismissed by the person.
	e.do("POST", "/api/agent/denied-commands", map[string]any{"command": "npm publish", "thread_id": id}, bearer(sess))
	if c := command(id); c != "!npm publish" {
		t.Fatalf("command = %v", c)
	}
	if code, o, _ := e.do("DELETE", "/api/threads/"+id+"/denied-command", nil, nil); code != 200 || o["cleared"] != true {
		t.Fatalf("dismiss: %d %v", code, o)
	}
	if c := command(id); c != nil {
		t.Fatalf("after dismiss: %v", c)
	}

	// Run by the person with "!".
	e.do("POST", "/api/agent/denied-commands", map[string]any{"command": "true", "thread_id": id}, bearer(sess))
	if c := command(id); c != "!true" {
		t.Fatalf("command = %v", c)
	}
	if code, o, _ := e.do("POST", "/api/threads/"+id+"/reply", map[string]any{"words": "!true"}, nil); code != 201 {
		t.Fatalf("reply: %d %v", code, o)
	}
	if c := command(id); c != nil {
		t.Fatalf("after the person ran it: %v", c)
	}
}

func TestDeniedCommandWithoutThreadGoesToTheNextMessage(t *testing.T) {
	e := newEnv(t)
	sess := e.createSession()
	other := e.createSession()
	first := e.send(sess, "", "first", "hello", "working")
	foreign := e.send(other, "", "x", "hello", "working")
	// No thread (and a thread of another session is ignored): it waits for the agent's next message.
	e.do("POST", "/api/agent/denied-commands", map[string]any{"command": "git push", "thread_id": foreign}, bearer(sess))
	if c := e.srv.denied.offer(first); c != "" {
		t.Fatalf("offered before any message: %q", c)
	}
	if c := e.srv.denied.offer(foreign); c != "" {
		t.Fatalf("offered in another session's thread: %q", c)
	}
	second := e.send(sess, "", "second", "git push was denied", "need_action")
	if c := e.srv.denied.offer(second); c != "!git push" {
		t.Fatalf("offer = %q", c)
	}
	if c := e.srv.denied.offer(first); c != "" {
		t.Fatalf("first thread: %q", c)
	}
}

func TestDeniedStore(t *testing.T) {
	d := newDeniedStore()
	t0 := time.Now()
	d.add(deniedCommand{SessionID: "s", ThreadID: "t", Command: "a", At: t0})
	d.add(deniedCommand{SessionID: "s", ThreadID: "t", Command: "b", At: t0.Add(time.Second)})
	if c := d.offer("t"); c != "!b" {
		t.Fatalf("latest = %q", c)
	}
	d.add(deniedCommand{SessionID: "s", ThreadID: "t", Command: "$ a", At: t0.Add(2 * time.Second)})
	if c := d.offer("t"); c != "!a" || len(d.bySession["s"]) != 2 {
		t.Fatalf("same command again: %q %v", c, d.bySession["s"])
	}
	d.resolve("s", "a")
	if c := d.offer("t"); c != "!b" {
		t.Fatalf("after resolve = %q", c)
	}
	// Commands that a "!" reply cannot carry are not offered.
	d.add(deniedCommand{SessionID: "s", ThreadID: "t", Command: "echo a\necho b", At: t0.Add(3 * time.Second)})
	if c := d.offer("t"); c != "" {
		t.Fatalf("multi-line offered: %q", c)
	}
	d.add(deniedCommand{SessionID: "s", ThreadID: "u", Command: "echo " + strings.Repeat("x", deniedMaxRunes), At: t0})
	if c := d.offer("u"); c != "" {
		t.Fatalf("long offered: %q", c)
	}
	for i := 0; i < deniedPerSession+5; i++ {
		d.add(deniedCommand{SessionID: "s", ThreadID: "t", Command: strings.Repeat("x", i+1), At: t0})
	}
	if n := len(d.bySession["s"]); n != deniedPerSession {
		t.Fatalf("kept %d", n)
	}
}
