package server

import (
	"context"
	"errors"
	"strings"
	"sync/atomic"
	"testing"
)

// autoPermissionMessage once wrongly offered "!extensions/auto-permission/": `deny` (in code) counted
// as a denial and the first inline code span, a directory, as the command.
const autoPermissionMessage = "了解です。auto permission mode は、別のサブエージェントで Pi extension（TypeScript、`extensions/auto-permission/`）として実装を始めました。\n\n" +
	"- ツール呼び出しごとに `allow` / `deny` / `ask` を判定します\n" +
	"- `ask` のときは `extension_ui_request` で確認を出します\n" +
	"- 判定のログは `~/.okaka/state/logs/` に残します\n\n" +
	"違っていたら言ってください。"

func TestDeniedCommandSuggestion(t *testing.T) {
	for _, tc := range []struct{ name, body, want string }{
		{"inline", "I tried `npm run build` but you denied it.", "!npm run build"},
		{"fenced", "The command was rejected:\n```sh\n$ go test ./...\n```\nCan you run it?", "!go test ./..."},
		{"japanese", "`make lint` の実行が拒否されました", "!make lint"},
		{"no denial", "Run `npm test` to check.", ""},
		{"no command", "That was denied.", ""},
		{"multi-line", "denied:\n```\nls\nrm x\n```", ""},
		{"too long", "denied `echo " + strings.Repeat("x", 250) + "`", ""},
		// A denial word only inside code (a list of permission modes) and a directory in inline code.
		{"path, deny in code", autoPermissionMessage, ""},
		{"denied path", "Reading `extensions/auto-permission/` was denied.", ""},
		{"denied home path", "Access to `~/.okaka/state/logs/` was denied.", ""},
		{"denied lone name", "`extension_ui_request` was rejected.", ""},
		{"skips a path for the command", "Writing to `build/out/` was denied when I ran `make dist`.", "!make dist"},
		{"bang form", "Running `! gcloud auth login` was denied; please run it yourself.", "!gcloud auth login"},
		{"script", "`./scripts/release.sh` was rejected.", "!./scripts/release.sh"},
		{"env and path exe", "Denied: `GOOS=linux /usr/local/go/bin/go build ./...`", "!GOOS=linux /usr/local/go/bin/go build ./..."},
		{"lone known command", "`make` was denied.", "!make"},
	} {
		if got := deniedCommandSuggestion(tc.body); got != tc.want {
			t.Errorf("%s: got %q want %q", tc.name, got, tc.want)
		}
	}
	h := replyHelp{Command: "!other", Questions: []ReplyQuestion{
		{Question: "Run it?", Kind: "single", Options: []ReplyOption{{Label: "!LS"}, {Label: "Skip it"}}},
		{Question: "Only the command", Kind: "single", Options: []ReplyOption{{Label: "ls"}}},
		{Question: "Free text", Kind: "single", Options: []ReplyOption{}},
	}}
	got := withDeniedCommand("!ls", h)
	if got.Command != "!ls" || len(got.Questions) != 2 || len(got.Questions[0].Options) != 1 || got.Questions[0].Options[0].Label != "Skip it" || got.Questions[1].Question != "Free text" {
		t.Errorf("merge: %+v", got)
	}
}

func TestSuggestionsOfferTheDeniedCommand(t *testing.T) {
	e := newEnv(t)
	sess := e.createSession()
	var prompt string
	var fail atomic.Bool
	e.srv.suggest = newSuggester(func(ctx context.Context, p string) (replyHelp, error) {
		prompt = p
		if fail.Load() {
			return replyHelp{}, errors.New("helper down")
		}
		return replyHelp{Command: "!something else", Questions: []ReplyQuestion{{Question: "How to go on?", Kind: "single", Options: []ReplyOption{{Label: "Skip it"}, {Label: "Use another way"}}}}}, nil
	})
	_, obj, _ := e.do("POST", "/api/agent/messages", map[string]any{"body": "Running `rm -rf build` was denied. Should I continue?"}, bearer(sess))
	id := obj["thread_id"].(string)
	_, o, _ := e.do("GET", "/api/threads/"+id+"/suggestions", nil, nil)
	qs := o["questions"].([]any)
	if o["command"] != "!rm -rf build" || len(qs) != 1 || qs[0].(map[string]any)["question"] != "How to go on?" {
		t.Fatalf("got %v", o)
	}
	if !strings.Contains(prompt, "set command to exactly that command") {
		t.Errorf("prompt does not teach the denied-command field")
	}
	// The helper failing still leaves the deterministic command.
	fail.Store(true)
	e.do("POST", "/api/agent/messages", map[string]any{"thread_id": id, "body": "Also `git push` was rejected."}, bearer(sess))
	_, o, _ = e.do("GET", "/api/threads/"+id+"/suggestions", nil, nil)
	if o["command"] != "!git push" || len(o["questions"].([]any)) != 0 || o["error"] != nil {
		t.Fatalf("helper down: %v", o)
	}
	// Without a denial in the message the helper's own command is passed on.
	fail.Store(false)
	e.do("POST", "/api/agent/messages", map[string]any{"thread_id": id, "body": "Could not run the linter."}, bearer(sess))
	_, o, _ = e.do("GET", "/api/threads/"+id+"/suggestions", nil, nil)
	if o["command"] != "!something else" {
		t.Fatalf("helper command: %v", o)
	}
	// Neither the message (a path in code, `deny` only in code) nor a helper's path is offered.
	e.srv.suggest = newSuggester(func(ctx context.Context, p string) (replyHelp, error) {
		return replyHelp{Command: "!extensions/auto-permission/", Questions: []ReplyQuestion{}}, nil
	})
	e.do("POST", "/api/agent/messages", map[string]any{"thread_id": id, "body": autoPermissionMessage}, bearer(sess))
	_, o, _ = e.do("GET", "/api/threads/"+id+"/suggestions", nil, nil)
	if c, ok := o["command"]; ok && c != "" {
		t.Fatalf("path offered as a command: %v", o)
	}
}
