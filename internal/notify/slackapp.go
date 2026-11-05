package notify

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/ryotarai/minbox/internal/store"
)

// slackAPIBase is where the Slack Web API lives. MINBOX_SLACK_API_BASE overrides it for tests
// (e2e, a fake Slack on 127.0.0.1); a value that is not an http URL on a loopback host is ignored,
// so the bot token can never be redirected to another machine by the environment.
var slackAPIBase = slackAPIBaseFromEnv(os.Getenv("MINBOX_SLACK_API_BASE"))

func slackAPIBaseFromEnv(v string) string {
	const def = "https://slack.com/api"
	u, err := url.Parse(strings.TrimRight(strings.TrimSpace(v), "/"))
	if v == "" || err != nil || u.Scheme != "http" || u.Host == "" {
		return def
	}
	if ip := net.ParseIP(u.Hostname()); u.Hostname() != "localhost" && (ip == nil || !ip.IsLoopback()) {
		return def
	}
	return strings.TrimRight(u.String(), "/")
}

var slackAppType = Type{
	ID:    "slack_app",
	Label: "Slack app (bot token)",
	Fields: []Field{
		{Key: "bot_token", Label: "Bot token", Kind: "secret", Required: true, Placeholder: "xoxb-…",
			Hint: "The Bot User OAuth Token. Kept on the server; it is never shown again in full.", validate: validBotToken},
		{Key: "channel", Label: "Channel", Kind: "text", Required: true, Placeholder: "C0123ABCD or #alerts",
			Hint: "A channel ID (C0123ABCD) or a name (#alerts). The bot must be in the channel unless it has chat:write.public.", validate: validChannel},
		{Key: "include_body", Label: "Send full message", Kind: "bool", Default: true, Hint: "Off: only the thread title."},
		{Key: "thread_replies", Label: "Group a thread's messages in one Slack thread", Kind: "bool", Default: true,
			Hint: "The first notification of a minbox thread is the parent; later ones are replies to it."},
		{Key: "events", Label: "Notify for", Kind: "select", Default: EventsAll, Options: []Option{
			{Value: EventsAll, Label: "Every message from Claude"},
			{Value: EventsAction, Label: "Only messages that need your answer"},
		}},
	},
	Help: "How to create the Slack app:\n" +
		"1. Open api.slack.com/apps and choose Create New App (From scratch).\n" +
		"2. OAuth & Permissions → Bot Token Scopes: add chat:write (and chat:write.public to post to channels the bot has not joined).\n" +
		"3. Install to Workspace, then copy the Bot User OAuth Token (xoxb-…) into the Bot token field below.\n" +
		"4. In Slack, invite the bot to the channel: /invite @your-app-name.",
	new: func(cfg map[string]any, c *http.Client, env Env) (Notifier, error) {
		tok, _ := cfg["bot_token"].(string)
		ch, _ := cfg["channel"].(string)
		if tok == "" {
			return nil, errors.New("no bot token")
		}
		if ch == "" {
			return nil, errors.New("no channel")
		}
		inc, ok := cfg["include_body"].(bool)
		if !ok {
			inc = true
		}
		thr, ok := cfg["thread_replies"].(bool)
		if !ok {
			thr = true
		}
		return &SlackApp{Token: tok, Channel: ch, IncludeBody: inc, ThreadReplies: thr, Client: c, Store: env.Store, DestID: env.DestID, Base: slackAPIBase}, nil
	},
}

func validBotToken(s string) error {
	if strings.ContainsAny(s, " \t\r\n") {
		return errors.New("must not contain spaces")
	}
	return nil
}

func validChannel(s string) error {
	if strings.ContainsAny(s, " \t\r\n") {
		return errors.New("must be a channel ID like C0123ABCD or a name like #alerts, without spaces")
	}
	return nil
}

// SlackApp posts with chat.postMessage as a Slack app's bot.
type SlackApp struct {
	Token         string
	Channel       string
	IncludeBody   bool
	ThreadReplies bool
	Client        *http.Client
	Store         *store.Store // thread grouping; nil: always top-level
	DestID        string
	Base          string // API base URL
}

// One lock per (destination, minbox thread): two notifications of one thread at the same
// moment must not both become the Slack parent.
var slackThreadLocks sync.Map

func slackThreadLock(destID, threadID string) *sync.Mutex {
	m, _ := slackThreadLocks.LoadOrStore(destID+"\x00"+threadID, &sync.Mutex{})
	return m.(*sync.Mutex)
}

type slackResp struct {
	OK      bool   `json:"ok"`
	Error   string `json:"error"`
	Needed  string `json:"needed"`
	Channel string `json:"channel"`
	TS      string `json:"ts"`
	Team    string `json:"team"`
	User    string `json:"user"`
}

// Send posts the notification (grouped in the Slack thread of its minbox thread when enabled).
// Errors never contain the token.
func (s *SlackApp) Send(ctx context.Context, n Notification) error {
	if n.Test || !s.ThreadReplies || s.Store == nil || n.ThreadID == "" {
		_, err := s.post(ctx, n, s.Channel, "")
		return err
	}
	mu := slackThreadLock(s.DestID, n.ThreadID)
	mu.Lock()
	defer mu.Unlock()
	parent, ok, err := s.Store.GetSlackThread(ctx, s.DestID, n.ThreadID)
	if err != nil {
		return &SendError{Msg: "reading the Slack thread: " + err.Error()}
	}
	if ok {
		_, err := s.post(ctx, n, parent.ChannelID, parent.TS)
		if err == nil {
			return nil
		}
		var se *SendError
		if !errors.As(err, &se) || (se.code != "thread_not_found" && se.code != "message_not_found") {
			return err
		}
		// The parent was deleted in Slack: this message becomes the new one.
	}
	r, err := s.post(ctx, n, s.Channel, "")
	if err != nil {
		return err
	}
	if r.TS != "" {
		ch := r.Channel
		if ch == "" {
			ch = s.Channel
		}
		if e := s.Store.PutSlackThread(ctx, s.DestID, n.ThreadID, store.SlackThread{ChannelID: ch, TS: r.TS}); e != nil {
			return &SendError{Msg: "storing the Slack thread: " + e.Error()}
		}
	}
	return nil
}

// Test checks the token with auth.test, then posts the sample at the top level of the channel.
func (s *SlackApp) Test(ctx context.Context, n Notification) (string, error) {
	r, err := s.call(ctx, "auth.test", map[string]any{})
	if err != nil {
		return "", err
	}
	info := "Connected"
	if r.Team != "" {
		info += " to " + r.Team
	}
	if r.User != "" {
		info += " as " + r.User
	}
	if _, err := s.post(ctx, n, s.Channel, ""); err != nil {
		return "", err
	}
	return info, nil
}

func (s *SlackApp) post(ctx context.Context, n Notification, channel, threadTS string) (slackResp, error) {
	p := BuildSlackPayload(n, s.IncludeBody)
	body := map[string]any{
		"channel": channel, "text": p.Text, "blocks": p.Blocks,
		"unfurl_links": false, "unfurl_media": false,
	}
	if threadTS != "" {
		body["thread_ts"] = threadTS
		body["reply_broadcast"] = false
	}
	return s.call(ctx, "chat.postMessage", body)
}

func (s *SlackApp) call(ctx context.Context, method string, body map[string]any) (slackResp, error) {
	var r slackResp
	b, err := json.Marshal(body)
	if err != nil {
		return r, err
	}
	req, err := http.NewRequestWithContext(ctx, "POST", strings.TrimRight(s.Base, "/")+"/"+method, bytes.NewReader(b))
	if err != nil {
		return r, &SendError{Msg: "bad Slack API URL"}
	}
	req.Header.Set("Content-Type", "application/json; charset=utf-8")
	req.Header.Set("Authorization", "Bearer "+s.Token)
	resp, err := s.Client.Do(req)
	if err != nil {
		return r, &SendError{Msg: s.scrub("request failed: " + withoutURL(err).Error()), Retry: ctx.Err() == nil}
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	retryAfter := time.Duration(0)
	if secs, err := strconv.Atoi(resp.Header.Get("Retry-After")); err == nil && secs > 0 {
		retryAfter = min(time.Duration(secs)*time.Second, time.Minute)
	}
	if resp.StatusCode == http.StatusTooManyRequests {
		return r, &SendError{Msg: "Slack is rate limiting this app; will retry", Status: 429, Retry: true, RetryAfter: retryAfter, code: "ratelimited"}
	}
	if resp.StatusCode >= 500 {
		return r, &SendError{Msg: fmt.Sprintf("Slack answered %d", resp.StatusCode), Status: resp.StatusCode, Retry: true, RetryAfter: retryAfter}
	}
	if err := json.Unmarshal(raw, &r); err != nil {
		return r, &SendError{Msg: fmt.Sprintf("Slack answered %d with something that is not JSON", resp.StatusCode), Status: resp.StatusCode}
	}
	if !r.OK {
		return r, slackAPIError(r, retryAfter)
	}
	return r, nil
}

func (s *SlackApp) scrub(msg string) string { return strings.ReplaceAll(msg, s.Token, "[token]") }

var slackRetryable = map[string]bool{
	"ratelimited": true, "rate_limited": true, "internal_error": true, "service_unavailable": true,
	"fatal_error": true, "request_timeout": true,
}

// slackAPIError turns Slack's {ok:false, error} into an actionable message; whether trying again
// can help depends on the code.
func slackAPIError(r slackResp, retryAfter time.Duration) *SendError {
	msg := ""
	switch r.Error {
	case "channel_not_found":
		msg = "Slack cannot find that channel: check the channel ID or name (a private channel needs the bot invited)"
	case "not_in_channel":
		msg = "The bot is not in that channel: invite it with /invite @<app name>, or add the chat:write.public scope"
	case "is_archived":
		msg = "That channel is archived: unarchive it or choose another channel"
	case "invalid_auth", "not_authed", "token_expired":
		msg = "The token is invalid or expired: copy the Bot User OAuth Token (xoxb-…) again"
	case "token_revoked":
		msg = "The token is invalid or revoked: reinstall the app and copy the new Bot User OAuth Token"
	case "account_inactive":
		msg = "The app's workspace or bot user is deactivated: reinstall the app"
	case "missing_scope":
		need := r.Needed
		if need == "" {
			need = "chat:write"
		}
		msg = "The app lacks the " + need + " scope: add it under OAuth & Permissions → Bot Token Scopes and reinstall the app"
	case "msg_too_long", "invalid_blocks", "invalid_blocks_format", "no_text":
		msg = "Slack refused the message (" + r.Error + ")"
	case "restricted_action", "access_denied":
		msg = "The workspace does not let the app post there (" + r.Error + ")"
	case "ratelimited", "rate_limited":
		msg = "Slack is rate limiting this app; will retry"
	case "thread_not_found", "message_not_found":
		msg = "The Slack thread to reply to is gone"
	case "":
		msg = "Slack refused the request"
	default:
		msg = "Slack error: " + safeCode(r.Error)
	}
	return &SendError{Msg: msg, Retry: slackRetryable[r.Error], RetryAfter: retryAfter, code: r.Error}
}

// safeCode keeps a Slack error code short and plain.
func safeCode(c string) string {
	if len(c) > 60 {
		c = c[:60]
	}
	return strings.Map(func(r rune) rune {
		if r < 0x20 || r > 0x7e {
			return '?'
		}
		return r
	}, c)
}
