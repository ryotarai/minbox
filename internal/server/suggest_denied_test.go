package server

import (
	"context"
	"errors"
	"strings"
	"sync/atomic"
	"testing"
)

func TestDeniedCommandSuggestion(t *testing.T) {
	for _, tc := range []struct{ name, body, want string }{
		{"inline", "I tried `npm run build` but you denied it.", "!npm run build"},
		{"fenced", "The command was rejected:\n```sh\n$ go test ./...\n```\nCan you run it?", "!go test ./..."},
		{"japanese", "`make lint` の実行が拒否されました", "!make lint"},
		{"no denial", "Run `npm test` to check.", ""},
		{"no command", "That was denied.", ""},
		{"multi-line", "denied:\n```\nls\nrm x\n```", ""},
		{"too long", "denied `" + strings.Repeat("x", 250) + "`", ""},
	} {
		if got := deniedCommandSuggestion(tc.body); got != tc.want {
			t.Errorf("%s: got %q want %q", tc.name, got, tc.want)
		}
	}
	got := withDeniedCommand("!ls", []string{"Yes", "!LS", "No", "Maybe"})
	if strings.Join(got, "|") != "!ls|Yes|No" {
		t.Errorf("merge: %v", got)
	}
}

func TestSuggestionsOfferTheDeniedCommandFirst(t *testing.T) {
	e := newEnv(t)
	sess := e.createSession()
	var prompt string
	var fail atomic.Bool
	e.srv.suggest = newSuggester(func(ctx context.Context, p string) ([]string, error) {
		prompt = p
		if fail.Load() {
			return nil, errors.New("helper down")
		}
		return []string{"Skip it", "Use another way"}, nil
	})
	_, obj, _ := e.do("POST", "/api/agent/messages", map[string]any{"body": "Running `rm -rf build` was denied. Should I continue?"}, bearer(sess))
	id := obj["thread_id"].(string)
	_, o, _ := e.do("GET", "/api/threads/"+id+"/suggestions", nil, nil)
	got := o["suggestions"].([]any)
	if len(got) != 3 || got[0] != "!rm -rf build" || got[1] != "Skip it" {
		t.Fatalf("got %v", got)
	}
	if !strings.Contains(prompt, "'!' followed by that command") {
		t.Errorf("prompt does not teach the denied-command form")
	}
	// The helper failing still leaves the deterministic suggestion.
	fail.Store(true)
	e.do("POST", "/api/agent/messages", map[string]any{"thread_id": id, "body": "Also `git push` was rejected."}, bearer(sess))
	_, o, _ = e.do("GET", "/api/threads/"+id+"/suggestions", nil, nil)
	if got := o["suggestions"].([]any); len(got) != 1 || got[0] != "!git push" || o["error"] != nil {
		t.Fatalf("helper down: %v", o)
	}
}
