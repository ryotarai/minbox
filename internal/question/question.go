// Package question parses the question blocks an agent writes in a message
// and composes the person's answers into the reply the agent reads.
//
// The block syntax follows Plannotator's `:::question` directive:
//
//	:::question            pick one (also :::question-multi, :::question-text)
//	Which database should we use?
//	Context lines, before or after the choices.
//
//	- [ ] SQLite — simplest
//	- [ ] Postgres — needs a server
//
//	Recommended: SQLite
//	:::
package question

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"regexp"
	"strings"
)

// Kinds of question.
const (
	Single = "single"
	Multi  = "multi"
	Text   = "text"
	Action = "action" // one item of an :::actions block
)

// Choices of an action item.
const (
	ActionDone   = "Done"
	ActionCannot = "Can't do it"
)

type Choice struct {
	Label       string `json:"label"`
	Description string `json:"description,omitempty"`
	Settled     bool   `json:"settled,omitempty"` // "- [x]": a decision already made
	Recommended bool   `json:"recommended,omitempty"`
}

type Question struct {
	Key     string   `json:"key"`
	Kind    string   `json:"kind"`
	Prompt  string   `json:"prompt"`
	Context string   `json:"context,omitempty"`
	Choices []Choice `json:"choices,omitempty"`
	// RecommendedText is a recommendation that names no choice: a suggested answer.
	RecommendedText string `json:"recommended_text,omitempty"`
	// From context lines: "Stopped: ..." (work is stopped on this answer),
	// "Holds up: a; b" (what waits on it), "Replaces: <earlier prompt>".
	Stopped  string   `json:"stopped,omitempty"`
	HoldsUp  []string `json:"holds_up,omitempty"`
	Replaces string   `json:"replaces,omitempty"`
	// Group: the :::actions block an action item belongs to.
	Group string `json:"group,omitempty"`
}

// Answer is the person's answer to one question.
type Answer struct {
	Key      string   `json:"key"`
	Selected []string `json:"selected,omitempty"` // choice labels
	Other    string   `json:"other,omitempty"`
	Text     string   `json:"text,omitempty"`
	Note     string   `json:"note,omitempty"`
	Skipped  bool     `json:"skipped,omitempty"`
}

// Empty reports whether the answer says nothing.
func (a Answer) Empty() bool {
	return len(a.Selected) == 0 && strings.TrimSpace(a.Other) == "" && strings.TrimSpace(a.Text) == "" && !a.Skipped && strings.TrimSpace(a.Note) == ""
}

const maxPrompt = 400

var (
	openRe   = regexp.MustCompile(`^\s*:::\s*(question(?:-multi|-text)?|actions)\s*$`)
	metaRe   = regexp.MustCompile(`^\s*(Stopped|Holds up|Replaces)\s*:\s*(.*)$`)
	closeRe  = regexp.MustCompile(`^\s*:::\s*$`)
	choiceRe = regexp.MustCompile(`^\s*(?:[-*+]|\d+[.)])\s+\[( |x|X)\]\s+(.*)$`)
	bulletRe = regexp.MustCompile(`^\s*(?:[-*+]|\d+[.)])\s+(.*)$`)
	recRe    = regexp.MustCompile(`^\s*(?:Recommended|Recommendation|➡️|->|=>|→)\s*:?\s*(.*)$`)
	splitRe  = regexp.MustCompile(`\s+[—–]\s+|\s+-\s+`)
	listSep  = regexp.MustCompile(`\s*(?:,|;|\band\b)\s*`)
)

// Parse finds the question blocks in a message body.
func Parse(body string) []Question {
	var out []Question
	seen := map[string]int{}
	lines := strings.Split(strings.ReplaceAll(body, "\r\n", "\n"), "\n")
	inFence := false
	for i := 0; i < len(lines); i++ {
		if strings.HasPrefix(strings.TrimSpace(lines[i]), "```") {
			inFence = !inFence
			continue
		}
		if inFence {
			continue
		}
		m := openRe.FindStringSubmatch(lines[i])
		if m == nil {
			continue
		}
		var block []string
		j := i + 1
		for ; j < len(lines) && !closeRe.MatchString(lines[j]); j++ {
			block = append(block, lines[j])
		}
		i = j
		var qs []Question
		if m[1] == "actions" {
			qs = parseActions(block)
		} else if q, ok := parseBlock(m[1], block); ok {
			qs = []Question{q}
		}
		for _, q := range qs {
			base := q.Key
			if n := seen[base]; n > 0 {
				q.Key = fmt.Sprintf("%s-%d", base, n+1)
			}
			seen[base]++
			out = append(out, q)
		}
	}
	return out
}

// parseActions turns an :::actions block into one action item per list item.
func parseActions(lines []string) []Question {
	var title []string
	var items []string
	for _, l := range lines {
		if m := choiceRe.FindStringSubmatch(l); m != nil {
			items = append(items, strings.TrimSpace(m[2]))
			continue
		}
		if m := bulletRe.FindStringSubmatch(l); m != nil {
			items = append(items, strings.TrimSpace(m[1]))
			continue
		}
		if t := strings.TrimSpace(l); t != "" {
			title = append(title, t)
		}
	}
	if len(items) == 0 {
		return nil
	}
	if len(items) > 20 {
		items = items[:20]
	}
	ctx := strings.Join(title, "\n")
	group := Key(Action, ctx+"\n"+strings.Join(items, "\n"))
	var out []Question
	for _, it := range items {
		q := Question{Kind: Action, Prompt: truncate(it, maxPrompt), Context: ctx, Group: group,
			Choices: []Choice{{Label: ActionDone}, {Label: ActionCannot}}}
		applyMeta(&q, ctx)
		q.Key = Key(Action, q.Prompt)
		out = append(out, q)
	}
	return out
}

// applyMeta reads Stopped / Holds up / Replaces lines of the context.
func applyMeta(q *Question, context string) {
	for _, l := range strings.Split(context, "\n") {
		m := metaRe.FindStringSubmatch(l)
		if m == nil {
			continue
		}
		v := strings.TrimSpace(m[2])
		switch m[1] {
		case "Stopped":
			if v == "" {
				v = "yes"
			}
			q.Stopped = v
		case "Holds up":
			for _, part := range regexp.MustCompile(`\s*[;,、]\s*`).Split(v, -1) {
				if part = strings.TrimSpace(part); part != "" {
					q.HoldsUp = append(q.HoldsUp, part)
				}
			}
		case "Replaces":
			q.Replaces = v
		}
	}
}

func parseBlock(directive string, lines []string) (Question, bool) {
	kind := Single
	switch directive {
	case "question-multi":
		kind = Multi
	case "question-text":
		kind = Text
	}
	var q Question
	var context []string
	var rec string
	hasTask := false
	for _, l := range lines {
		if choiceRe.MatchString(l) {
			hasTask = true
			break
		}
	}
	for _, l := range lines {
		trimmed := strings.TrimSpace(l)
		if trimmed == "" {
			if q.Prompt != "" {
				context = append(context, "")
			}
			continue
		}
		if m := choiceRe.FindStringSubmatch(l); m != nil {
			q.Choices = append(q.Choices, splitChoice(m[2], m[1] != " "))
			continue
		}
		if !hasTask && kind != Text && q.Prompt != "" {
			if m := bulletRe.FindStringSubmatch(l); m != nil {
				q.Choices = append(q.Choices, splitChoice(m[1], false))
				continue
			}
		}
		if m := recRe.FindStringSubmatch(l); m != nil && q.Prompt != "" {
			rec = strings.TrimSpace(m[1])
			continue
		}
		if q.Prompt == "" {
			q.Prompt = truncate(trimmed, maxPrompt)
			continue
		}
		context = append(context, strings.TrimRight(l, " \t"))
	}
	if q.Prompt == "" {
		return q, false
	}
	if len(q.Choices) == 0 {
		kind = Text
	}
	if len(q.Choices) > 20 {
		q.Choices = q.Choices[:20]
	}
	q.Kind = kind
	q.Context = strings.TrimSpace(strings.Join(context, "\n"))
	applyMeta(&q, q.Context)
	if rec != "" {
		applyRecommendation(&q, rec)
	}
	q.Key = Key(kind, q.Prompt)
	return q, true
}

func splitChoice(text string, settled bool) Choice {
	text = strings.TrimSpace(text)
	c := Choice{Label: text, Settled: settled}
	if loc := splitRe.FindStringIndex(text); loc != nil {
		c.Label = strings.TrimSpace(text[:loc[0]])
		c.Description = strings.TrimSpace(text[loc[1]:])
	}
	// "- **Name:** prose" uses the bold name as the label.
	if strings.HasPrefix(c.Label, "**") {
		if end := strings.Index(c.Label[2:], "**"); end > 0 {
			name := strings.TrimSuffix(strings.TrimSpace(c.Label[2:2+end]), ":")
			rest := strings.TrimSpace(c.Label[2+end+2:])
			if c.Description != "" {
				rest = strings.TrimSpace(rest + " " + c.Description)
			}
			c.Label, c.Description = name, rest
		}
	}
	c.Label = truncate(c.Label, 200)
	return c
}

func applyRecommendation(q *Question, rec string) {
	match := func(s string) int {
		s = strings.ToLower(strings.TrimSpace(s))
		for i, c := range q.Choices {
			if strings.ToLower(c.Label) == s {
				return i
			}
		}
		return -1
	}
	// The whole text, or its head before " — reason", names a choice.
	head := rec
	if loc := splitRe.FindStringIndex(rec); loc != nil {
		head = rec[:loc[0]]
	}
	for _, cand := range []string{rec, head} {
		if i := match(cand); i >= 0 {
			q.Choices[i].Recommended = true
			return
		}
	}
	if q.Kind == Multi {
		found := false
		for _, part := range listSep.Split(head, -1) {
			if i := match(part); i >= 0 {
				q.Choices[i].Recommended = true
				found = true
			}
		}
		if found {
			return
		}
	}
	// Text that begins with exactly one label followed by ":", "—" or "(".
	var hit = -1
	for i, c := range q.Choices {
		l := strings.ToLower(c.Label)
		r := strings.ToLower(rec)
		if strings.HasPrefix(r, l) && len(r) > len(l) && strings.ContainsAny(r[len(l):len(l)+1], ":(—–- ") {
			if hit >= 0 {
				hit = -2
				break
			}
			hit = i
		}
	}
	if hit >= 0 {
		q.Choices[hit].Recommended = true
		return
	}
	q.RecommendedText = rec
}

// Key identifies a question stably across revisions.
func Key(kind, prompt string) string {
	norm := strings.Join(strings.Fields(strings.ToLower(prompt)), " ")
	sum := sha256.Sum256([]byte(kind + "\n" + norm))
	return "q-" + hex.EncodeToString(sum[:4])
}

func truncate(s string, max int) string {
	if r := []rune(s); len(r) > max {
		return string(r[:max-1]) + "…"
	}
	return s
}

// Compose builds the reply the agent reads from the person's own words and
// their answers to the questions of the message they answered.
func Compose(words string, all []Question, answers map[string]Answer) string {
	words = strings.TrimSpace(words)
	var questions, actions []Question
	for _, q := range all {
		if q.Kind == Action {
			actions = append(actions, q)
		} else {
			questions = append(questions, q)
		}
	}
	actionSec := composeActions(actions, answers)
	if len(questions) == 0 {
		return joinNonEmpty(words, actionSec)
	}
	answered, skipped := 0, 0
	for _, q := range questions {
		a, ok := answers[q.Key]
		switch {
		case !ok || a.Empty():
		case a.Skipped:
			skipped++
		default:
			answered++
		}
	}
	open := len(questions) - answered - skipped
	var parts []string
	switch {
	case answered > 0 && skipped > 0:
		parts = append(parts, fmt.Sprintf("Answered %s, skipped %d.", plural(answered, "question"), skipped))
	case answered > 0:
		parts = append(parts, fmt.Sprintf("Answered %s.", plural(answered, "question")))
	case skipped > 0:
		parts = append(parts, fmt.Sprintf("Skipped %s.", plural(skipped, "question")))
	}
	if words != "" {
		parts = append(parts, words)
	}
	if open > 0 {
		if answered+skipped == 0 {
			if open == 1 {
				parts = append(parts, "No question answered yet; it is still open. Don't re-ask it; the person will answer in the inbox.")
			} else {
				parts = append(parts, fmt.Sprintf("No questions answered yet; all %d are still open. Don't re-ask them; the person will answer in the inbox.", open))
			}
		} else if open == 1 {
			parts = append(parts, "You have 1 other question open in this thread. It stays open; the person will answer it in the inbox. Don't re-ask it.")
		} else {
			parts = append(parts, fmt.Sprintf("You have %d other questions open in this thread. They stay open; the person will answer them in the inbox. Don't re-ask them.", open))
		}
	}
	if answered+skipped == 0 {
		return joinNonEmpty(strings.Join(parts, "\n\n"), actionSec)
	}

	var sec strings.Builder
	sec.WriteString("## Answers to your questions\n\n")
	fmt.Fprintf(&sec, "%d of %d questions answered.\n", answered, len(questions))
	var unanswered []string
	for i, q := range questions {
		a, ok := answers[q.Key]
		if !ok || a.Empty() {
			unanswered = append(unanswered, fmt.Sprintf("- Q%d. %s", i+1, q.Prompt))
			continue
		}
		fmt.Fprintf(&sec, "\n### Q%d. %s\n", i+1, q.Prompt)
		sec.WriteString(answerText(q, a))
	}
	if len(unanswered) > 0 {
		sec.WriteString("\n### Unanswered\n")
		sec.WriteString(strings.Join(unanswered, "\n"))
		sec.WriteString("\n")
	}
	parts = append(parts, strings.TrimRight(sec.String(), "\n"))
	return joinNonEmpty(strings.Join(parts, "\n\n"), actionSec)
}

func joinNonEmpty(parts ...string) string {
	var out []string
	for _, p := range parts {
		if strings.TrimSpace(p) != "" {
			out = append(out, p)
		}
	}
	return strings.Join(out, "\n\n")
}

// composeActions lists the action items the person marked.
func composeActions(actions []Question, answers map[string]Answer) string {
	var lines []string
	for _, q := range actions {
		a, ok := answers[q.Key]
		if !ok || a.Empty() {
			continue
		}
		state := ""
		switch {
		case a.Skipped:
			state = "Skipped"
		case len(a.Selected) > 0:
			state = a.Selected[0]
		case strings.TrimSpace(a.Other) != "":
			state = "Other (" + strings.TrimSpace(a.Other) + ")"
		default:
			state = "Note"
		}
		line := "- " + state + ": " + q.Prompt
		if n := strings.TrimSpace(a.Note); n != "" {
			line += " — " + n
		}
		lines = append(lines, line)
	}
	if len(lines) == 0 {
		return ""
	}
	return "## Actions\n\n" + strings.Join(lines, "\n")
}

func answerText(q Question, a Answer) string {
	var b strings.Builder
	if a.Skipped {
		b.WriteString("Skipped\n")
	} else {
		var items []string
		for _, label := range a.Selected {
			item := label
			for _, c := range q.Choices {
				if c.Label == label && c.Recommended {
					item += " (your recommendation)"
				}
			}
			items = append(items, item)
		}
		if o := strings.TrimSpace(a.Other); o != "" {
			items = append(items, "Other: "+o)
		}
		if t := strings.TrimSpace(a.Text); t != "" {
			b.WriteString("Answer:\n")
			for _, l := range strings.Split(t, "\n") {
				b.WriteString("> " + l + "\n")
			}
		} else if len(items) == 1 {
			b.WriteString("Answer: " + items[0] + "\n")
		} else if len(items) > 1 {
			b.WriteString("Answer:\n")
			for _, it := range items {
				b.WriteString("- " + it + "\n")
			}
		}
	}
	if n := strings.TrimSpace(a.Note); n != "" {
		b.WriteString("Note: " + n + "\n")
	}
	return b.String()
}

func plural(n int, word string) string {
	if n == 1 {
		return "1 " + word
	}
	return fmt.Sprintf("%d %ss", n, word)
}
