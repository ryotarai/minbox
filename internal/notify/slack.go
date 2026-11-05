package notify

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

// Slack's limits: a section's text is 3,000 characters, a message has 50 blocks.
const (
	slackSectionMax = 2900
	slackBlocksMax  = 50
	slackFallback   = 280
)

var slackType = Type{
	ID:    "slack",
	Label: "Slack (incoming webhook)",
	Fields: []Field{
		{Key: "webhook_url", Label: "Webhook URL", Kind: "secret", Required: true, Placeholder: "https://hooks.slack.com/services/…",
			Hint: "Kept on the server; it is never shown again in full.", validate: validWebhookURL},
		{Key: "include_body", Label: "Send full message", Kind: "bool", Default: true, Hint: "Off: only the thread title."},
		{Key: "events", Label: "Notify for", Kind: "select", Default: EventsAll, Options: []Option{
			{Value: EventsAll, Label: "Every message from Claude"},
			{Value: EventsAction, Label: "Only messages that need your answer"},
		}},
	},
	new: func(cfg map[string]any, c *http.Client, _ Env) (Notifier, error) {
		u, _ := cfg["webhook_url"].(string)
		if u == "" {
			return nil, errors.New("no webhook URL")
		}
		inc, ok := cfg["include_body"].(bool)
		if !ok {
			inc = true
		}
		return &Slack{URL: u, IncludeBody: inc, Client: c}, nil
	},
}

func validWebhookURL(s string) error {
	u, err := url.Parse(s)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		return errors.New("must be an http(s) URL")
	}
	return nil
}

// Slack posts to an incoming webhook.
type Slack struct {
	URL         string
	IncludeBody bool
	Client      *http.Client
}

// SlackPayload is the JSON an incoming webhook takes.
type SlackPayload struct {
	Text   string       `json:"text"`
	Blocks []SlackBlock `json:"blocks"`
}

// SlackBlock is a section, context or actions block.
type SlackBlock struct {
	Type     string         `json:"type"`
	Text     *SlackText     `json:"text,omitempty"`
	Elements []SlackElement `json:"elements,omitempty"`
}

// SlackText is mrkdwn text.
type SlackText struct {
	Type string `json:"type"`
	Text string `json:"text"`
}

// SlackElement is a context text or a button.
type SlackElement struct {
	Type string
	Text string
	URL  string
}

// MarshalJSON writes a context element's text, or a button's plain_text label.
func (e SlackElement) MarshalJSON() ([]byte, error) {
	if e.Type == "button" {
		return json.Marshal(map[string]any{"type": "button", "text": map[string]any{"type": "plain_text", "text": e.Text}, "url": e.URL})
	}
	return json.Marshal(map[string]any{"type": e.Type, "text": e.Text})
}

func mrkdwnBlock(text string) SlackBlock {
	return SlackBlock{Type: "section", Text: &SlackText{Type: "mrkdwn", Text: text}}
}

// BuildSlackPayload lays a notification out as Block Kit with a plain `text` fallback (what
// push notifications show): a header section, the body in consecutive sections of at most
// 2,900 characters (the tail is cut with "…" past the 50 blocks Slack allows), a line saying who
// wrote it, and an "Open thread" button when there is a link.
func BuildSlackPayload(n Notification, includeBody bool) SlackPayload {
	where := strings.TrimSpace(n.Project)
	if n.Session != "" {
		if where != "" {
			where += " / "
		}
		where += n.Session
	}
	title := n.Title
	if title == "" {
		title = "(no subject)"
	}
	head := "*" + escapeSlack(where) + "*: " + escapeSlack(title)
	if where == "" {
		head = "*" + escapeSlack(title) + "*"
	}
	if n.Test {
		head = ":bell: *minbox test notification*\n" + head
	}
	fallback := strings.TrimPrefix(where+": ", ": ") + title
	blocks := []SlackBlock{mrkdwnBlock(head)}

	var ctx []string
	if n.From != "" && !n.Test {
		ctx = append(ctx, escapeSlack(n.From))
	}
	if n.NeedsAction && !n.Test {
		ctx = append(ctx, "needs your answer")
	}
	if n.Status != "" {
		ctx = append(ctx, escapeSlack(n.Status))
	}
	reserved := 0 // blocks after the body
	if len(ctx) > 0 {
		reserved++
	}
	if n.Link != "" {
		reserved++
	}
	if includeBody && strings.TrimSpace(n.Body) != "" {
		parts := splitMrkdwn(Mrkdwn(n.Body), slackSectionMax)
		room := slackBlocksMax - len(blocks) - reserved
		if len(parts) > room {
			parts = parts[:room]
			parts[room-1] += "\n…"
			if n.Link != "" {
				parts[room-1] += " (cut: open the thread for the rest)"
			} else {
				parts[room-1] += " (cut)"
			}
		}
		for _, p := range parts {
			blocks = append(blocks, mrkdwnBlock(p))
		}
		flat := strings.Join(strings.Fields(strings.NewReplacer("*", "", "`", "", "#", "").Replace(n.Body)), " ")
		if r := []rune(flat); len(r) > slackFallback {
			flat = string(r[:slackFallback]) + "…"
		}
		fallback += "\n" + escapeSlack(flat)
	}
	if len(ctx) > 0 {
		blocks = append(blocks, SlackBlock{Type: "context", Elements: []SlackElement{{Type: "mrkdwn", Text: strings.Join(ctx, " · ")}}})
	}
	if n.Link != "" {
		blocks = append(blocks, SlackBlock{Type: "actions", Elements: []SlackElement{{Type: "button", Text: "Open thread", URL: n.Link}}})
	}
	return SlackPayload{Text: escapeSlack(fallback), Blocks: blocks}
}

// Send posts the notification. The error never contains the webhook URL.
func (s *Slack) Send(ctx context.Context, n Notification) error {
	body, err := json.Marshal(BuildSlackPayload(n, s.IncludeBody))
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, "POST", s.URL, bytes.NewReader(body))
	if err != nil {
		return &SendError{Msg: "bad webhook URL"}
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := s.Client.Do(req)
	if err != nil {
		return &SendError{Msg: "request failed: " + withoutURL(err).Error(), Retry: ctx.Err() == nil}
	}
	defer resp.Body.Close()
	snippet, _ := io.ReadAll(io.LimitReader(resp.Body, 200))
	if resp.StatusCode >= 200 && resp.StatusCode < 300 {
		return nil
	}
	se := &SendError{Status: resp.StatusCode, Retry: resp.StatusCode >= 500 || resp.StatusCode == http.StatusTooManyRequests}
	se.Msg = fmt.Sprintf("Slack answered %d", resp.StatusCode)
	if t := strings.TrimSpace(string(snippet)); t != "" {
		se.Msg += ": " + t
	}
	if secs, err := strconv.Atoi(resp.Header.Get("Retry-After")); err == nil && secs > 0 {
		se.RetryAfter = min(time.Duration(secs)*time.Second, time.Minute)
	}
	return se
}
