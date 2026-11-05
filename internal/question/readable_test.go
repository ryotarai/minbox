package question

import (
	"strings"
	"testing"
)

func TestReadableReplacesQuestionBlocks(t *testing.T) {
	body := "I need a decision.\n\n:::question\nWhich database should we use?\nWe store small records.\n\n- [ ] SQLite — simplest\n- [ ] Postgres — needs a server\n\nRecommended: SQLite\n:::\n\nThanks."
	got := Readable(body)
	for _, bad := range []string{":::", "- [ ]"} {
		if strings.Contains(got, bad) {
			t.Errorf("Readable left %q in:\n%s", bad, got)
		}
	}
	for _, want := range []string{"I need a decision.", "**❓ Which database should we use?**", "We store small records.", "- SQLite — simplest (recommended)", "- Postgres — needs a server", "Thanks."} {
		if !strings.Contains(got, want) {
			t.Errorf("Readable lacks %q in:\n%s", want, got)
		}
	}
}

func TestReadableKindsAndFences(t *testing.T) {
	body := ":::question-multi\nWhich checks?\n\n- [ ] unit\n- [ ] e2e\n:::\n:::question-text\nAnything else?\n:::\n```\n:::question\nnot a block\n:::\n```\n"
	got := Readable(body)
	if !strings.Contains(got, "(choose any)") || !strings.Contains(got, "(free answer)") {
		t.Errorf("kinds missing:\n%s", got)
	}
	if !strings.Contains(got, ":::question\nnot a block") {
		t.Errorf("a fenced block must stay as written:\n%s", got)
	}
}

func TestReadableWithoutBlocksIsUnchanged(t *testing.T) {
	body := "Plain **text**\n\n- a\n- b"
	if got := Readable(body); got != body {
		t.Errorf("changed: %q", got)
	}
}
