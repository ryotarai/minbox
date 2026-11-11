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
		{Key: "channel", Label: "Channel or user", Kind: "text", Required: true, Placeholder: "C0123ABCD, #alerts or U0123ABCD",
			Hint: "A channel ID (C0123ABCD), a name (#alerts), or a user ID (U0123ABCD; Slack profile → ⋮ → Copy member ID) for a DM with the bot. A channel needs the bot in it unless it has chat:write.public; a DM needs no invite.", validate: validChannel},
		{Key: "include_body", Label: "Send full message", Kind: "bool", Default: true, Hint: "Off: only the thread title."},
		{Key: "thread_replies", Label: "Group a thread's messages in one Slack thread", Kind: "bool", Default: true,
			Hint: "The first notification of a minbox thread is the parent; later ones are replies to it."},
		{Key: "mention_me", Label: "Mention me when starting a thread", Kind: "bool", Default: true,
			Hint: "The first message of a Slack thread mentions you (the user ID in Channel, else the first Allowed Slack user ID), because Slack only notifies about replies in a thread you take part in or are mentioned in. Later messages of the thread do not repeat it."},
		{Key: "send_artifacts", Label: "Send artifacts (images, HTML, files)", Kind: "bool", Default: true,
			Hint: "Files Claude attaches to a message (and images its message shows) are uploaded to the same Slack thread, up to 10 files and 20 MB each. Needs the files:write scope; without it the message still arrives and the status says what is missing."},
		{Key: "events", Label: "Notify for", Kind: "select", Default: EventsAll, Options: []Option{
			{Value: EventsAll, Label: "Every message from Claude"},
			{Value: EventsAction, Label: "Only messages that need your answer"},
		}},
		{Key: "receive", Label: "Receive messages from Slack", Kind: "bool", Default: false,
			Hint: "Off by default. On: minbox polls Slack (no public URL needed) so you can reply to a notification in its Slack thread, or DM the bot to start a new thread. Needs a user ID as Channel (a DM), the im:history scope (files:read to take images you send, reactions:write for the 👀 ack), and takes up to the poll interval to arrive."},
		{Key: "allowed_users", Label: "Allowed Slack user IDs", Kind: "text", Placeholder: "U0123ABCD, U0456EFGH",
			Hint: "Only messages from these members are taken (comma separated). Empty: the user ID in Channel. Required when receiving is on.", validate: validUserIDs},
		{Key: "pick_project", Label: "Let Claude Haiku pick the project", Kind: "bool", Default: true,
			Hint: "A DM that starts a new thread (without a #project prefix) is sent to Claude Haiku together with your project names, and the thread goes to the project it picks. When Haiku is unsure it asks you in the Slack thread which project (up to 3 times) instead of guessing. At most 10 calls a minute; the DM text and your answers are sent to Claude. Only matters when receiving is on."},
		{Key: "default_project", Label: "Fallback project (when Claude cannot tell)", Kind: "text", Placeholder: "my-project",
			Hint: "A project name used when Claude Haiku is off or fails, or is still unsure after 3 questions in Slack. Start a DM with #other-project to choose a project yourself (no Claude call). Empty and no project found: the DM is ignored; only replies in notification threads are received."},
		{Key: "poll_interval", Label: "Poll interval", Kind: "select", Default: "60", Options: []Option{
			{Value: "30", Label: "30 seconds"}, {Value: "60", Label: "1 minute"},
			{Value: "120", Label: "2 minutes"}, {Value: "300", Label: "5 minutes"},
		}, Hint: "Polling slows down by itself (up to 5 minutes) while nothing is going on, and stays within 20 Slack API calls a minute."},
	},
	finish: finishSlackApp,
	Help: "Slack app setup:\n" +
		"1. Open api.slack.com/apps → Create New App → From scratch.\n" +
		"2. OAuth & Permissions → Bot Token Scopes: add chat:write, im:history (to receive your replies), files:write (to send images, HTML and other files Claude attaches), files:read (to take images you send in Slack as input) and optionally reactions:write (the 👀 on delivered messages). Not needed: chat:write.public, im:write, channels:*.\n" +
		"3. App Home → Show Tabs: turn Messages Tab on and tick 'Allow users to send Slash commands and messages from the messages tab'.\n" +
		"4. Install to Workspace (Reinstall after any scope change), then copy the Bot User OAuth Token (xoxb-…) into Bot token.\n" +
		"5. No Event Subscriptions, no Socket Mode, no Request URL: minbox polls Slack, nothing is exposed.\n" +
		"6. Channel: your member ID (Slack profile → ⋮ → Copy member ID, U…) for a DM with the bot. Press Send test first: the DM is learned from it.\n" +
		"7. To reply from Slack: turn Receive messages from Slack on, set Allowed Slack user IDs and a Fallback project. If Claude cannot tell the project of a DM it asks in the Slack thread; answer there. Images you send are taken as input (files:read). Replies in a notification's thread go into that minbox thread; a DM to the bot starts a new thread (#project text picks the project). A message takes up to the poll interval to arrive; the status under the destination shows what went wrong, with Check receiving now.\n" +
		"Posting to a channel instead of a DM: use its ID (C…) or #name as Channel and /invite the bot (or add chat:write.public); receiving needs the DM.",
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
		men, ok := cfg["mention_me"].(bool)
		if !ok {
			men = true
		}
		allowed, _ := cfg["allowed_users"].(string)
		art, ok := cfg["send_artifacts"].(bool)
		if !ok {
			art = true
		}
		return &SlackApp{SendArtifacts: art, Token: tok, Channel: ch, IncludeBody: inc, ThreadReplies: thr, MentionMe: men, AllowedUsers: allowed, Client: c, Store: env.Store, DestID: env.DestID, Base: slackAPIBase}, nil
	},
}

func validBotToken(s string) error {
	if strings.ContainsAny(s, " \t\r\n") {
		return errors.New("must not contain spaces")
	}
	return nil
}

// slackUserID matches a member ID (U… or W…).
func slackUserID(s string) bool {
	if len(s) < 3 || len(s) > 30 || (s[0] != 'U' && s[0] != 'W') {
		return false
	}
	for _, c := range s[1:] {
		if !(c >= 'A' && c <= 'Z' || c >= '0' && c <= '9') {
			return false
		}
	}
	return true
}

// SplitUserIDs splits a comma/space separated list of member IDs.
func SplitUserIDs(s string) []string {
	return strings.FieldsFunc(s, func(r rune) bool { return r == ',' || r == ' ' || r == '\n' || r == '\t' || r == ';' })
}

func validUserIDs(s string) error {
	for _, id := range SplitUserIDs(s) {
		if !slackUserID(id) {
			return fmt.Errorf("%q is not a member ID (U0123ABCD or W0123ABCD; Slack profile → ⋮ → Copy member ID)", safeCode(id))
		}
	}
	return nil
}

// finishSlackApp: receiving needs a DM (v1) and an allowlist; the allowlist defaults to the DM's user.
func finishSlackApp(cfg map[string]any) error {
	if on, _ := cfg["receive"].(bool); !on {
		return nil
	}
	ch, _ := cfg["channel"].(string)
	if !slackUserID(ch) {
		return errors.New("Receive messages from Slack works for a DM only: put your user ID (U0123ABCD) in Channel")
	}
	if a, _ := cfg["allowed_users"].(string); strings.TrimSpace(a) == "" {
		cfg["allowed_users"] = ch
	}
	return nil
}

func validChannel(s string) error {
	if strings.ContainsAny(s, " \t\r\n") {
		return errors.New("must be a channel ID like C0123ABCD, a name like #alerts or a user ID like U0123ABCD, without spaces")
	}
	return nil
}

// SlackApp posts with chat.postMessage as a Slack app's bot.
type SlackApp struct {
	Token         string
	Channel       string
	IncludeBody   bool
	ThreadReplies bool
	SendArtifacts bool   // upload the notification's Files to the Slack thread
	MentionMe     bool   // mention the person in the parent post of a Slack thread
	AllowedUsers  string // Allowed Slack user IDs (the mention falls back to the first)
	Client        *http.Client
	Store         *store.Store // thread grouping; nil: always top-level
	DestID        string
	Base          string // API base URL
}

// mentionID is who the parent post mentions: the Channel when it is a user ID, else the first
// allowed user; "" when neither is known (or mentioning is off).
func (s *SlackApp) mentionID() string {
	if !s.MentionMe {
		return ""
	}
	if slackUserID(s.Channel) {
		return s.Channel
	}
	for _, id := range SplitUserIDs(s.AllowedUsers) {
		if slackUserID(id) {
			return id
		}
	}
	return ""
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
	// files.getUploadURLExternal
	UploadURL string `json:"upload_url"`
	FileID    string `json:"file_id"`
	// conversations.history / conversations.replies
	Messages []slackMsg `json:"messages"`
	HasMore  bool       `json:"has_more"`
}

type slackMsg struct {
	Type     string `json:"type"`
	Subtype  string `json:"subtype"`
	User     string `json:"user"`
	BotID    string `json:"bot_id"`
	Text     string `json:"text"`
	TS       string `json:"ts"`
	ThreadTS string `json:"thread_ts"`
	// LatestReply is the ts of the newest reply to this message (set on a thread parent).
	LatestReply string `json:"latest_reply"`
	// Files shared with the message (images and other uploads).
	Files []slackFile `json:"files"`
}

type slackFile struct {
	ID                 string `json:"id"`
	Name               string `json:"name"`
	Mimetype           string `json:"mimetype"`
	Size               int64  `json:"size"`
	URLPrivateDownload string `json:"url_private_download"`
	URLPrivate         string `json:"url_private"`
}

// Send posts the notification (grouped in the Slack thread of its minbox thread when enabled).
// Errors never contain the token.
func (s *SlackApp) Send(ctx context.Context, n Notification) error {
	if n.Test || !s.ThreadReplies || s.Store == nil || n.ThreadID == "" {
		r, err := s.post(ctx, n, s.Channel, "", n.Test)
		if err != nil {
			return err
		}
		return s.uploadFiles(ctx, n, r.Channel, "") // top level: the message is not a thread
	}
	mu := slackThreadLock(s.DestID, n.ThreadID)
	mu.Lock()
	defer mu.Unlock()
	parent, ok, err := s.Store.GetSlackThread(ctx, s.DestID, n.ThreadID)
	if err != nil {
		return &SendError{Msg: "reading the Slack thread: " + err.Error()}
	}
	if ok {
		_, err := s.post(ctx, n, parent.ChannelID, parent.TS, false)
		if err == nil {
			_ = s.Store.TouchSlackThread(ctx, s.DestID, n.ThreadID)
			return s.uploadFiles(ctx, n, parent.ChannelID, parent.TS)
		}
		var se *SendError
		if !errors.As(err, &se) || (se.code != "thread_not_found" && se.code != "message_not_found") {
			return err
		}
		// The parent was deleted in Slack: this message becomes the new one.
	}
	r, err := s.post(ctx, n, s.Channel, "", true)
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
		return s.uploadFiles(ctx, n, ch, r.TS)
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
	if _, err := s.post(ctx, n, s.Channel, "", true); err != nil {
		return "", err
	}
	return info, nil
}

func (s *SlackApp) post(ctx context.Context, n Notification, channel, threadTS string, parent bool) (slackResp, error) {
	p := BuildSlackPayload(n, s.IncludeBody)
	if id := s.mentionID(); id != "" && parent && threadTS == "" {
		m := "<@" + id + "> "
		p.Text = m + p.Text
		if len(p.Blocks) > 0 && p.Blocks[0].Text != nil {
			b := *p.Blocks[0].Text
			b.Text = m + b.Text
			first := p.Blocks[0]
			first.Text = &b
			p.Blocks = append([]SlackBlock{first}, p.Blocks[1:]...)
		}
	}
	body := map[string]any{
		"channel": channel, "text": p.Text, "blocks": p.Blocks,
		"unfurl_links": false, "unfurl_media": false,
	}
	if threadTS != "" {
		body["thread_ts"] = threadTS
		body["reply_broadcast"] = false
	}
	r, err := s.call(ctx, "chat.postMessage", body)
	// The DM channel (D…) is where the replies and the DMs to the bot are read from.
	if err == nil && s.Store != nil && s.DestID != "" && strings.HasPrefix(r.Channel, "D") {
		_ = s.Store.SetSlackState(ctx, s.DestID, "dm_channel", r.Channel)
	}
	return r, err
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
	return s.do(ctx, req)
}

// callForm calls a read method (conversations.history/replies take form-encoded parameters).
func (s *SlackApp) callForm(ctx context.Context, method string, v url.Values) (slackResp, error) {
	req, err := http.NewRequestWithContext(ctx, "POST", strings.TrimRight(s.Base, "/")+"/"+method, strings.NewReader(v.Encode()))
	if err != nil {
		return slackResp{}, &SendError{Msg: "bad Slack API URL"}
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	return s.do(ctx, req)
}

func (s *SlackApp) do(ctx context.Context, req *http.Request) (slackResp, error) {
	var r slackResp
	req.Header.Set("Authorization", "Bearer "+s.Token)
	resp, err := s.Client.Do(req)
	if err != nil {
		return r, &SendError{Msg: s.scrub("request failed: " + withoutURL(err).Error()), Retry: ctx.Err() == nil}
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	retryAfter, exact := time.Duration(0), time.Duration(0)
	if secs, err := strconv.Atoi(resp.Header.Get("Retry-After")); err == nil && secs > 0 {
		exact = time.Duration(secs) * time.Second
		retryAfter = min(exact, time.Minute)
	}
	if resp.StatusCode == http.StatusTooManyRequests {
		return r, &SendError{Msg: "Slack is rate limiting this app; will retry", Status: 429, Retry: true, RetryAfter: retryAfter, retryAfterExact: exact, code: "ratelimited"}
	}
	if resp.StatusCode >= 500 {
		return r, &SendError{Msg: fmt.Sprintf("Slack answered %d", resp.StatusCode), Status: resp.StatusCode, Retry: true, RetryAfter: retryAfter}
	}
	if err := json.Unmarshal(raw, &r); err != nil {
		return r, &SendError{Msg: fmt.Sprintf("Slack answered %d with something that is not JSON", resp.StatusCode), Status: resp.StatusCode}
	}
	if !r.OK {
		e := slackAPIError(r, retryAfter)
		e.retryAfterExact = exact
		return r, e
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
		msg = "Slack cannot find that channel: check the channel ID or name (a private channel needs the bot invited; for a DM use the user ID, U…)"
	case "user_not_found":
		msg = "Slack cannot find that user: check the member ID (Slack profile → ⋮ → Copy member ID) and that the user is in the app's workspace"
	case "cannot_dm_bot":
		msg = "That ID is a bot, which cannot receive a DM from this app: enter your own member ID (U…)"
	case "messages_tab_disabled":
		msg = "The app's Messages tab is off, so it cannot DM: enable it under App Home → Show Tabs → Messages Tab (and allow users to send messages from it), then reinstall the app"
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
