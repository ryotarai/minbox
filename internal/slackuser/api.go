package slackuser

import (
	"context"
	"encoding/json"
	"net/url"
	"regexp"
	"strings"
)

// Auth is auth.test's answer.
type Auth struct {
	UserID string
	User   string
	TeamID string
	Team   string
	URL    string // the workspace URL, https://<team>.slack.com/
	Scopes []string
	// ScopesKnown: Slack sent the x-oauth-scopes header.
	ScopesKnown bool
}

// AuthTest validates the token. The granted scopes come from the x-oauth-scopes response header.
func (c *Client) AuthTest(ctx context.Context) (*Auth, *APIError) {
	r, err := c.Call(ctx, "auth.test", map[string]any{}, false)
	if err != nil {
		return nil, err
	}
	var b struct {
		UserID string `json:"user_id"`
		User   string `json:"user"`
		TeamID string `json:"team_id"`
		Team   string `json:"team"`
		URL    string `json:"url"`
	}
	_ = json.Unmarshal(r.Body, &b)
	a := &Auth{UserID: b.UserID, User: b.User, TeamID: b.TeamID, Team: b.Team, URL: b.URL}
	if h := r.Header.Get("X-OAuth-Scopes"); h != "" {
		a.ScopesKnown = true
		for _, s := range strings.Split(h, ",") {
			if s = strings.TrimSpace(s); s != "" {
				a.Scopes = append(a.Scopes, s)
			}
		}
	}
	return a, nil
}

// Hit is one search result (a message that matched).
type Hit struct {
	Channel     string
	ChannelName string
	IsIM        bool
	TS          string
	ThreadTS    string // from the permalink's thread_ts parameter; "" for a message outside a thread
	User        string
	UserName    string
	Text        string
	Permalink   string
}

var threadTSRe = regexp.MustCompile(`[?&]thread_ts=(\d+\.\d+)`)

func threadFromPermalink(p string) string {
	if m := threadTSRe.FindStringSubmatch(p); m != nil {
		return m[1]
	}
	return ""
}

// SearchLegacy: search.messages (classic search:read scope). page is 1-based.
func (c *Client) SearchLegacy(ctx context.Context, query string, page, count int) (hits []Hit, pages int, err *APIError) {
	r, err := c.Call(ctx, "search.messages", map[string]any{"query": query, "count": count, "page": page, "sort": "timestamp", "sort_dir": "desc"}, false)
	if err != nil {
		return nil, 0, err
	}
	var b struct {
		Messages struct {
			Matches []struct {
				Channel struct {
					ID   string `json:"id"`
					Name string `json:"name"`
					IsIM bool   `json:"is_im"`
				} `json:"channel"`
				Type      string `json:"type"`
				TS        string `json:"ts"`
				User      string `json:"user"`
				Username  string `json:"username"`
				Text      string `json:"text"`
				Permalink string `json:"permalink"`
			} `json:"matches"`
			Paging struct {
				Pages int `json:"pages"`
			} `json:"paging"`
		} `json:"messages"`
	}
	_ = json.Unmarshal(r.Body, &b)
	for _, m := range b.Messages.Matches {
		if m.Channel.ID == "" || m.TS == "" {
			continue
		}
		hits = append(hits, Hit{Channel: m.Channel.ID, ChannelName: m.Channel.Name, IsIM: m.Channel.IsIM || m.Type == "im" || strings.HasPrefix(m.Channel.ID, "D"),
			TS: m.TS, ThreadTS: threadFromPermalink(m.Permalink), User: m.User, UserName: m.Username, Text: m.Text, Permalink: m.Permalink})
	}
	return hits, b.Messages.Paging.Pages, nil
}

// RTSQuery is a Real-time Search request (assistant.search.context).
type RTSQuery struct {
	Query        string
	ChannelTypes []string // public_channel | private_channel | mpim | im
	AfterUnix    int64
	Limit        int // at most 20
	Cursor       string
}

// SearchRTS: assistant.search.context with a user token (no action_token needed for user tokens,
// per the method's documentation). Results carry channel_id, message_ts, content, permalink,
// author_user_id; they carry no thread_ts (read from the permalink when it has one).
func (c *Client) SearchRTS(ctx context.Context, q RTSQuery) (hits []Hit, next string, err *APIError) {
	body := map[string]any{"query": q.Query, "content_types": []string{"messages"}, "channel_types": q.ChannelTypes, "sort": "timestamp", "sort_dir": "desc"}
	if q.Limit <= 0 || q.Limit > 20 {
		q.Limit = 20
	}
	body["limit"] = q.Limit
	if q.AfterUnix > 0 {
		body["after"] = q.AfterUnix
	}
	if q.Cursor != "" {
		body["cursor"] = q.Cursor
	}
	r, err := c.Call(ctx, "assistant.search.context", body, true)
	if err != nil {
		return nil, "", err
	}
	var b struct {
		Results struct {
			Messages []struct {
				AuthorName   string `json:"author_name"`
				AuthorUserID string `json:"author_user_id"`
				ChannelID    string `json:"channel_id"`
				ChannelName  string `json:"channel_name"`
				MessageTS    string `json:"message_ts"`
				Content      string `json:"content"`
				Permalink    string `json:"permalink"`
				ThreadTS     string `json:"thread_ts"` // not documented; used when present
			} `json:"messages"`
		} `json:"results"`
		Meta struct {
			NextCursor string `json:"next_cursor"`
		} `json:"response_metadata"`
	}
	_ = json.Unmarshal(r.Body, &b)
	for _, m := range b.Results.Messages {
		if m.ChannelID == "" || m.MessageTS == "" {
			continue
		}
		th := m.ThreadTS
		if th == "" {
			th = threadFromPermalink(m.Permalink)
		}
		hits = append(hits, Hit{Channel: m.ChannelID, ChannelName: m.ChannelName, IsIM: strings.HasPrefix(m.ChannelID, "D"), TS: m.MessageTS, ThreadTS: th,
			User: m.AuthorUserID, UserName: m.AuthorName, Text: m.Content, Permalink: m.Permalink})
	}
	return hits, b.Meta.NextCursor, nil
}

// File is a file attached to a message (name and link only).
type File struct {
	Name      string `json:"name"`
	Title     string `json:"title"`
	Permalink string `json:"permalink"`
	Mimetype  string `json:"mimetype"`
}

// Attachment is a legacy attachment (unfurl): title and link only.
type Attachment struct {
	Title     string `json:"title"`
	TitleLink string `json:"title_link"`
	Fallback  string `json:"fallback"`
}

// Message is one message of a thread or conversation.
type Message struct {
	TS          string       `json:"ts"`
	ThreadTS    string       `json:"thread_ts"`
	User        string       `json:"user"`
	BotID       string       `json:"bot_id"`
	Username    string       `json:"username"`
	Text        string       `json:"text"`
	Subtype     string       `json:"subtype"`
	ReplyCount  int          `json:"reply_count"`
	LatestReply string       `json:"latest_reply"`
	Files       []File       `json:"files"`
	Attachments []Attachment `json:"attachments"`
}

func parseMessages(raw []byte) (msgs []Message, next string) {
	var b struct {
		Messages []Message `json:"messages"`
		Meta     struct {
			NextCursor string `json:"next_cursor"`
		} `json:"response_metadata"`
	}
	_ = json.Unmarshal(raw, &b)
	return b.Messages, b.Meta.NextCursor
}

// Replies: conversations.replies (oldest first; the first message is the parent).
func (c *Client) Replies(ctx context.Context, channel, ts string, limit int, cursor string) ([]Message, string, *APIError) {
	p := map[string]any{"channel": channel, "ts": ts, "limit": limit}
	if cursor != "" {
		p["cursor"] = cursor
	}
	r, err := c.Call(ctx, "conversations.replies", p, false)
	if err != nil {
		return nil, "", err
	}
	m, n := parseMessages(r.Body)
	return m, n, nil
}

// History: the newest messages of a conversation, returned oldest first.
func (c *Client) History(ctx context.Context, channel string, limit int) ([]Message, *APIError) {
	r, err := c.Call(ctx, "conversations.history", map[string]any{"channel": channel, "limit": limit}, false)
	if err != nil {
		return nil, err
	}
	m, _ := parseMessages(r.Body)
	for i, j := 0, len(m)-1; i < j; i, j = i+1, j-1 {
		m[i], m[j] = m[j], m[i]
	}
	return m, nil
}

// User is a workspace member (name only).
type User struct {
	ID       string
	Name     string // the display name, else the real name, else the handle
	IsBot    bool
	Deleted  bool
	RealName string
}

// UserInfo: users.info.
func (c *Client) UserInfo(ctx context.Context, id string) (*User, *APIError) {
	r, err := c.Call(ctx, "users.info", map[string]any{"user": id}, false)
	if err != nil {
		return nil, err
	}
	var b struct {
		User struct {
			ID       string `json:"id"`
			Name     string `json:"name"`
			RealName string `json:"real_name"`
			Deleted  bool   `json:"deleted"`
			IsBot    bool   `json:"is_bot"`
			Profile  struct {
				DisplayName string `json:"display_name"`
				RealName    string `json:"real_name"`
			} `json:"profile"`
		} `json:"user"`
	}
	_ = json.Unmarshal(r.Body, &b)
	u := &User{ID: id, IsBot: b.User.IsBot, Deleted: b.User.Deleted, RealName: firstNonEmpty(b.User.RealName, b.User.Profile.RealName)}
	u.Name = firstNonEmpty(b.User.Profile.DisplayName, u.RealName, b.User.Name, id)
	return u, nil
}

// Conv is what conversations.info says about a conversation (the unread state of a DM).
type Conv struct {
	ID       string
	IsIM     bool
	Peer     string // the other member of a DM
	LastRead string
	Unread   int
}

// ConvInfo: conversations.info.
func (c *Client) ConvInfo(ctx context.Context, channel string) (*Conv, *APIError) {
	r, err := c.Call(ctx, "conversations.info", map[string]any{"channel": channel}, false)
	if err != nil {
		return nil, err
	}
	var b struct {
		Channel struct {
			ID       string `json:"id"`
			IsIM     bool   `json:"is_im"`
			User     string `json:"user"`
			LastRead string `json:"last_read"`
			Unread   int    `json:"unread_count_display"`
		} `json:"channel"`
	}
	_ = json.Unmarshal(r.Body, &b)
	return &Conv{ID: b.Channel.ID, IsIM: b.Channel.IsIM, Peer: b.Channel.User, LastRead: b.Channel.LastRead, Unread: b.Channel.Unread}, nil
}

func firstNonEmpty(a ...string) string {
	for _, s := range a {
		if s != "" {
			return s
		}
	}
	return ""
}

// PermalinkFor builds a permalink from the workspace URL (https://x.slack.com/), the channel and
// the message ts (no API call). threadTS "" or equal to ts: a plain message link.
func PermalinkFor(workspaceURL, channel, ts, threadTS string) string {
	base := strings.TrimRight(workspaceURL, "/")
	if base == "" || channel == "" || ts == "" {
		return ""
	}
	p := base + "/archives/" + url.PathEscape(channel) + "/p" + strings.Replace(ts, ".", "", 1)
	if threadTS != "" && threadTS != ts {
		p += "?thread_ts=" + url.QueryEscape(threadTS) + "&cid=" + url.QueryEscape(channel)
	}
	return p
}
