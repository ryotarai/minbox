package notify

import (
	"bytes"
	"context"
	"encoding/json"
	"strings"
	"testing"
)

func mentionRun(t *testing.T, cfg map[string]any) []appCall {
	r := newRig(t)
	f := newFakeSlackAPI(t, okReply())
	r.addApp(t, cfg)
	n := Notification{Session: "s", Title: "Hi", ThreadID: "thr_m", Body: "x"}
	r.d.Dispatch(n)
	r.d.Wait()
	r.d.Dispatch(n)
	r.d.Wait()
	return f.all()
}

func blocksJSON(c appCall) string {
	var b bytes.Buffer
	e := json.NewEncoder(&b)
	e.SetEscapeHTML(false)
	_ = e.Encode(c.body["blocks"])
	return b.String()
}

func hasMention(c appCall) bool {
	return strings.Contains(c.body["text"].(string), "<@") || strings.Contains(blocksJSON(c), "<@")
}

func mentionsID(c appCall, id string) bool {
	return strings.HasPrefix(c.body["text"].(string), "<@"+id+"> ") && strings.Contains(blocksJSON(c), "<@"+id+"> ")
}

func TestSlackAppMentionsOnParentOnly(t *testing.T) {
	// Channel is a user ID: the parent mentions it, the reply does not.
	c := mentionRun(t, map[string]any{"channel": "U0123ABCD"})
	if len(c) != 2 || !mentionsID(c[0], "U0123ABCD") || hasMention(c[1]) {
		t.Fatalf("calls = %+v", c)
	}
	// A channel: the first allowed user.
	c = mentionRun(t, map[string]any{"channel": "C0123ABCD", "allowed_users": "U0AAA, U0BBB"})
	if len(c) != 2 || !mentionsID(c[0], "U0AAA") || hasMention(c[1]) {
		t.Fatalf("calls = %+v", c)
	}
}

func TestSlackAppNoMentionWithoutIDOrWhenOff(t *testing.T) {
	c := mentionRun(t, map[string]any{"channel": "#alerts"})
	if len(c) != 2 || hasMention(c[0]) || hasMention(c[1]) {
		t.Fatalf("no id: %+v", c)
	}
	c = mentionRun(t, map[string]any{"channel": "U0123ABCD", "mention_me": false})
	if len(c) != 2 || hasMention(c[0]) || hasMention(c[1]) {
		t.Fatalf("off: %+v", c)
	}
}

func TestSlackAppTestSampleMentions(t *testing.T) {
	r := newRig(t)
	f := newFakeSlackAPI(t, okReply())
	d := r.addApp(t, map[string]any{"channel": "U0123ABCD"})
	if _, err := r.d.TestInfo(context.Background(), d, Notification{Title: "t", Test: true}); err != nil {
		t.Fatal(err)
	}
	calls := f.all()
	if !mentionsID(calls[len(calls)-1], "U0123ABCD") {
		t.Fatalf("calls = %+v", calls)
	}
}
