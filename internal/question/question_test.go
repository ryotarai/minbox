package question

import (
	"strings"
	"testing"
)

const sample = `I looked at the sync code.

:::question
Where should we keep the edit that loses a sync conflict?

When two devices edit one note offline, the later save wins.

- [ ] Nowhere — silent loss, as today
- [ ] Local only — cheap
- [ ] Server-side per user — survives reinstall

Recommended: Local only
:::

:::question-multi
Which areas?
- [ ] Billing
- [ ] Auth
- [x] Search
Recommended: Billing and Auth
:::

:::question-text
Anything else I should know?
:::

` + "```\n:::question\nNot a question, it is in a code fence\n:::\n```\n"

func TestParse(t *testing.T) {
	qs := Parse(sample)
	if len(qs) != 3 {
		t.Fatalf("got %d questions: %+v", len(qs), qs)
	}
	q := qs[0]
	if q.Kind != Single || q.Prompt != "Where should we keep the edit that loses a sync conflict?" {
		t.Fatalf("q0 = %+v", q)
	}
	if !strings.Contains(q.Context, "later save wins") {
		t.Fatalf("context = %q", q.Context)
	}
	if len(q.Choices) != 3 || q.Choices[1].Label != "Local only" || q.Choices[1].Description != "cheap" || !q.Choices[1].Recommended {
		t.Fatalf("choices = %+v", q.Choices)
	}
	m := qs[1]
	if m.Kind != Multi || !m.Choices[0].Recommended || !m.Choices[1].Recommended || m.Choices[2].Recommended || !m.Choices[2].Settled {
		t.Fatalf("multi = %+v", m)
	}
	if qs[2].Kind != Text || len(qs[2].Choices) != 0 {
		t.Fatalf("text = %+v", qs[2])
	}
	if !strings.HasPrefix(q.Key, "q-") || len(q.Key) != 10 {
		t.Fatalf("key = %q", q.Key)
	}
	if Parse(sample)[0].Key != q.Key {
		t.Fatal("keys must be stable")
	}
}

func TestParsePlainBulletsAndFreeRecommendation(t *testing.T) {
	qs := Parse(":::question\nPick a color\n- **Red:** warm\n- Blue\nRecommended: something green\n:::")
	if len(qs) != 1 {
		t.Fatal(qs)
	}
	q := qs[0]
	if len(q.Choices) != 2 || q.Choices[0].Label != "Red" || q.Choices[0].Description != "warm" {
		t.Fatalf("choices = %+v", q.Choices)
	}
	if q.RecommendedText != "something green" {
		t.Fatalf("recommended_text = %q", q.RecommendedText)
	}
}

func TestDuplicateKeys(t *testing.T) {
	qs := Parse(":::question-text\nWhy?\n:::\n:::question-text\nWhy?\n:::")
	if len(qs) != 2 || qs[0].Key == qs[1].Key || qs[1].Key != qs[0].Key+"-2" {
		t.Fatalf("keys = %s %s", qs[0].Key, qs[1].Key)
	}
}

func TestCompose(t *testing.T) {
	qs := Parse(sample)
	answers := map[string]Answer{
		qs[0].Key: {Key: qs[0].Key, Selected: []string{"Local only"}, Note: "30 days"},
		qs[1].Key: {Key: qs[1].Key, Selected: []string{"Billing"}, Other: "Reports"},
	}
	got := Compose("Thanks, go ahead.", qs, answers)
	for _, want := range []string{
		"Answered 2 questions.",
		"Thanks, go ahead.",
		"You have 1 other question open in this thread.",
		"## Answers to your questions",
		"2 of 3 questions answered.",
		"### Q1. Where should we keep",
		"Answer: Local only (your recommendation)",
		"Note: 30 days",
		"### Q2. Which areas?\nAnswer:\n- Billing (your recommendation)\n- Other: Reports",
		"### Unanswered\n- Q3. Anything else I should know?",
	} {
		if !strings.Contains(got, want) {
			t.Errorf("missing %q in:\n%s", want, got)
		}
	}
}

func TestComposeNoAnswers(t *testing.T) {
	qs := Parse(sample)
	got := Compose("later", qs, nil)
	if !strings.Contains(got, "all 3 are still open") || strings.Contains(got, "## Answers") {
		t.Fatalf("got:\n%s", got)
	}
	if Compose("just words", nil, nil) != "just words" {
		t.Fatal("no questions: words only")
	}
	skip := Compose("", qs[:1], map[string]Answer{qs[0].Key: {Key: qs[0].Key, Skipped: true}})
	if !strings.HasPrefix(skip, "Skipped 1 question.") || !strings.HasSuffix(skip, "?\nSkipped") {
		t.Fatalf("skip:\n%s", skip)
	}
}

func TestMetaAndActions(t *testing.T) {
	body := ":::question\nShip it?\nStopped: migration 0007 waits on this\nHolds up: search API; search UI\nReplaces: Ship now?\n- [ ] Yes\n- [ ] No\n:::\n\n:::actions\nBefore I go on\n- [ ] Add the labels\n- [ ] Check staging DNS\n:::\n"
	qs := Parse(body)
	if len(qs) != 3 {
		t.Fatalf("got %+v", qs)
	}
	q := qs[0]
	if q.Stopped != "migration 0007 waits on this" || len(q.HoldsUp) != 2 || q.HoldsUp[1] != "search UI" || q.Replaces != "Ship now?" {
		t.Fatalf("meta = %+v", q)
	}
	a1, a2 := qs[1], qs[2]
	if a1.Kind != Action || a1.Prompt != "Add the labels" || a1.Group == "" || a1.Group != a2.Group || len(a1.Choices) != 2 || a1.Context != "Before I go on" {
		t.Fatalf("actions = %+v %+v", a1, a2)
	}
	out := Compose("ok", qs, map[string]Answer{
		q.Key:  {Key: q.Key, Selected: []string{"Yes"}},
		a1.Key: {Key: a1.Key, Selected: []string{ActionDone}},
		a2.Key: {Key: a2.Key, Selected: []string{ActionCannot}, Note: "no access"},
	})
	if !strings.Contains(out, "Answered 1 question.") || !strings.Contains(out, "## Actions\n\n- Done: Add the labels\n- Can't do it: Check staging DNS — no access") {
		t.Fatalf("compose = %s", out)
	}
	only := Compose("", qs[1:], map[string]Answer{a1.Key: {Key: a1.Key, Selected: []string{ActionDone}}})
	if !strings.HasPrefix(only, "## Actions") {
		t.Fatalf("only = %s", only)
	}
}
