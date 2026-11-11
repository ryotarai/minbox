// Package slackuser is a small read-only client of the Slack Web API for the person's own USER
// token (xoxp-…): auth.test, the candidate search (the Real-time Search API assistant.search.context
// and the legacy search.messages), conversations.replies/history/info, users.info. It is separate from
// the bot-token integration of internal/notify. It never posts or marks anything read.
//
// The token is never put in an error, a log line or a diagnostic: every string that leaves this
// package passes Scrub.
package slackuser

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

// DefaultBase is the Slack Web API.
const DefaultBase = "https://slack.com/api"

// BaseFromEnv: MINBOX_SLACK_API_URL overrides the API base for tests (a fake Slack on 127.0.0.1).
// Only an http URL on a loopback host is honoured, so the token can never be redirected to another
// machine by the environment.
func BaseFromEnv(v string) string {
	u, err := url.Parse(strings.TrimRight(strings.TrimSpace(v), "/"))
	if v == "" || err != nil || u.Scheme != "http" || u.Host == "" {
		return DefaultBase
	}
	if ip := net.ParseIP(u.Hostname()); u.Hostname() != "localhost" && (ip == nil || !ip.IsLoopback()) {
		return DefaultBase
	}
	return strings.TrimRight(u.String(), "/")
}

var tokenRe = regexp.MustCompile(`xox[a-zA-Z]-[A-Za-z0-9._-]{4,}`)
var bearerRe = regexp.MustCompile(`(?i)bearer\s+[A-Za-z0-9._~+/=-]+`)

// Scrub removes the token (and anything shaped like a Slack token or bearer credential) from s.
func Scrub(s, token string) string {
	if len(token) >= 6 {
		s = strings.ReplaceAll(s, token, "[token]")
	}
	s = tokenRe.ReplaceAllString(s, "[token]")
	return bearerRe.ReplaceAllString(s, "Bearer [token]")
}

// APIError is a failed call. Msg is plain, actionable text (no secrets).
type APIError struct {
	Method     string
	Code       string // Slack's error code ("" for a transport problem)
	Needed     string // missing_scope: the scope Slack names
	Provided   string
	Status     int
	RetryAfter time.Duration
	Msg        string
}

func (e *APIError) Error() string { return e.Msg }

// Retryable: waiting and trying again can help.
func (e *APIError) Retryable() bool {
	switch e.Code {
	case "ratelimited", "rate_limited", "internal_error", "service_unavailable", "fatal_error", "request_timeout":
		return true
	}
	return e.Status >= 500
}

// RateLimited: Slack asked to wait (HTTP 429 or the ratelimited code).
func (e *APIError) RateLimited() bool {
	return e.Status == 429 || e.Code == "ratelimited" || e.Code == "rate_limited"
}

// Describe turns Slack's error code into text that says what to do.
func Describe(method, code, needed string) string {
	switch code {
	case "invalid_auth", "not_authed", "token_expired":
		return "Slack rejected the token (" + code + "): copy the User OAuth Token (xoxp-…) from the app's OAuth & Permissions page again. A token from a rotated or reinstalled app stops working."
	case "token_revoked", "account_inactive":
		return "The token was revoked or the account is deactivated (" + code + "): reinstall the app and paste the new User OAuth Token (xoxp-…)."
	case "missing_scope":
		if needed == "" {
			needed = "the scope for " + method
		}
		return "The token lacks the " + needed + " user scope: add it under OAuth & Permissions → User Token Scopes, reinstall the app, and paste the new token."
	case "not_allowed_token_type":
		return method + " does not accept this kind of token. Paste the User OAuth Token (xoxp-…), not a bot (xoxb-) or app-level token."
	case "app_not_approved", "app_approval_required", "app_not_installed", "team_access_not_granted":
		return "The workspace has not approved (or has removed) this app (" + code + "): ask a workspace admin to approve it, then reinstall."
	case "no_permission", "access_denied", "restricted_action", "not_allowed", "method_restricted_for_app":
		return "The workspace's settings do not let this app call " + method + " (" + code + "): ask a workspace admin."
	case "unknown_method", "method_not_found", "not_allowed_for_method", "method_deprecated":
		return method + " is not available to this app (" + code + ")."
	case "assistant_search_context_disabled", "feature_not_enabled":
		return "The Real-time Search API is not enabled for this workspace or app (" + code + ")."
	case "invalid_action_token", "missing_action_token":
		return "The Real-time Search API wants an action token that only AI-enabled apps get (" + code + ")."
	case "ratelimited", "rate_limited":
		return "Slack asked minbox to slow down (rate limited)."
	case "channel_not_found", "thread_not_found", "message_not_found":
		return "Slack cannot find that conversation or message (" + code + "): it may be deleted, or not visible to this token."
	case "user_not_found":
		return "Slack cannot find that user."
	case "":
		return "Slack refused the request."
	}
	return "Slack error: " + safeCode(code)
}

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

// Diag is what the status shows about the calls made (no secrets, no message text).
type Diag struct {
	Calls            int            `json:"calls"`
	ByMethod         map[string]int `json:"by_method"`
	Errors           int            `json:"errors"`
	RateLimited      int            `json:"rate_limited"`
	LastError        string         `json:"last_error"`
	LastErrorMethod  string         `json:"last_error_method,omitempty"`
	LastErrorAt      *time.Time     `json:"last_error_at"`
	LastCallAt       *time.Time     `json:"last_call_at"`
	RateLimitedUntil *time.Time     `json:"rate_limited_until"`
	Blocked          map[string]int `json:"blocked,omitempty"` // method -> seconds left
}

// Client calls Slack with the token returned by Token.
type Client struct {
	Base  string
	HC    *http.Client
	Token func() string
	Now   func() time.Time

	mu      sync.Mutex
	blocked map[string]time.Time
	diag    Diag
}

// NewClient: base "" means the real Slack (or the loopback override from the environment).
func NewClient(base string, token func() string) *Client {
	if base == "" {
		base = DefaultBase
	}
	return &Client{Base: strings.TrimRight(base, "/"), HC: &http.Client{Timeout: 30 * time.Second}, Token: token, Now: time.Now, blocked: map[string]time.Time{}, diag: Diag{ByMethod: map[string]int{}}}
}

func (c *Client) now() time.Time {
	if c.Now != nil {
		return c.Now()
	}
	return time.Now()
}

// Diagnostics returns a copy of the call counters.
func (c *Client) Diagnostics() Diag {
	c.mu.Lock()
	defer c.mu.Unlock()
	d := c.diag
	d.ByMethod = map[string]int{}
	for k, v := range c.diag.ByMethod {
		d.ByMethod[k] = v
	}
	now := c.now()
	var latest time.Time
	d.Blocked = nil
	for m, t := range c.blocked {
		if t.After(now) {
			if d.Blocked == nil {
				d.Blocked = map[string]int{}
			}
			d.Blocked[m] = int(t.Sub(now).Seconds()) + 1
			if t.After(latest) {
				latest = t
			}
		}
	}
	d.RateLimitedUntil = nil
	if !latest.IsZero() {
		d.RateLimitedUntil = &latest
	}
	return d
}

// ResetDiagnostics forgets counters and rate-limit blocks.
func (c *Client) ResetDiagnostics() {
	c.mu.Lock()
	c.diag = Diag{ByMethod: map[string]int{}}
	c.blocked = map[string]time.Time{}
	c.mu.Unlock()
}

// BlockedFor: how long calls to method are held back after a rate limit (0: not blocked).
func (c *Client) BlockedFor(method string) time.Duration {
	c.mu.Lock()
	defer c.mu.Unlock()
	if t, ok := c.blocked[method]; ok {
		if d := t.Sub(c.now()); d > 0 {
			return d
		}
		delete(c.blocked, method)
	}
	return 0
}

// Resp is a successful answer.
type Resp struct {
	Body   []byte
	Header http.Header
}

func (c *Client) record(method string, err *APIError) {
	c.mu.Lock()
	defer c.mu.Unlock()
	now := c.now()
	c.diag.Calls++
	c.diag.ByMethod[method]++
	c.diag.LastCallAt = &now
	if err != nil {
		c.diag.Errors++
		c.diag.LastError = err.Msg
		c.diag.LastErrorMethod = method
		c.diag.LastErrorAt = &now
		if err.RateLimited() {
			c.diag.RateLimited++
			ra := err.RetryAfter
			if ra <= 0 {
				ra = time.Minute
			}
			c.blocked[method] = now.Add(ra)
		}
	}
}

// Call does one request. params go form-encoded (asJSON false) or as a JSON body (asJSON true).
// A method that Slack told us to wait for is not called until the wait is over (an error with
// RetryAfter is returned at once).
func (c *Client) Call(ctx context.Context, method string, params map[string]any, asJSON bool) (*Resp, *APIError) {
	if d := c.BlockedFor(method); d > 0 {
		return nil, &APIError{Method: method, Code: "ratelimited", Status: 429, RetryAfter: d, Msg: fmt.Sprintf("Slack asked minbox to wait %d s before calling %s again.", int(d.Seconds())+1, method)}
	}
	tok := ""
	if c.Token != nil {
		tok = c.Token()
	}
	var body io.Reader
	ctype := "application/x-www-form-urlencoded"
	if asJSON {
		b, _ := json.Marshal(params)
		body, ctype = bytes.NewReader(b), "application/json; charset=utf-8"
	} else {
		v := url.Values{}
		for k, x := range params {
			switch t := x.(type) {
			case string:
				v.Set(k, t)
			case int:
				v.Set(k, strconv.Itoa(t))
			case int64:
				v.Set(k, strconv.FormatInt(t, 10))
			case bool:
				v.Set(k, strconv.FormatBool(t))
			default:
				v.Set(k, fmt.Sprint(t))
			}
		}
		body = strings.NewReader(v.Encode())
	}
	req, err := http.NewRequestWithContext(ctx, "POST", c.Base+"/"+method, body)
	if err != nil {
		return nil, &APIError{Method: method, Msg: "bad Slack API URL"}
	}
	req.Header.Set("Content-Type", ctype)
	req.Header.Set("Authorization", "Bearer "+tok)
	resp, err := c.HC.Do(req)
	if err != nil {
		e := &APIError{Method: method, Code: "request_failed", Msg: Scrub("Could not reach Slack: "+withoutURL(err), tok)}
		if ctx.Err() == nil {
			c.record(method, e)
		}
		return nil, e
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	var ra time.Duration
	if secs, err := strconv.Atoi(resp.Header.Get("Retry-After")); err == nil && secs > 0 {
		ra = time.Duration(secs) * time.Second
	}
	if resp.StatusCode == http.StatusTooManyRequests {
		e := &APIError{Method: method, Code: "ratelimited", Status: 429, RetryAfter: ra, Msg: Describe(method, "ratelimited", "")}
		if ra > 0 {
			e.Msg += fmt.Sprintf(" Wait about %d s.", int(ra.Seconds()))
		}
		c.record(method, e)
		return nil, e
	}
	if resp.StatusCode >= 500 {
		e := &APIError{Method: method, Status: resp.StatusCode, RetryAfter: ra, Msg: fmt.Sprintf("Slack answered %d", resp.StatusCode)}
		c.record(method, e)
		return nil, e
	}
	var head struct {
		OK       bool   `json:"ok"`
		Error    string `json:"error"`
		Needed   string `json:"needed"`
		Provided string `json:"provided"`
	}
	if err := json.Unmarshal(raw, &head); err != nil {
		e := &APIError{Method: method, Status: resp.StatusCode, Msg: fmt.Sprintf("Slack answered %d with something that is not JSON", resp.StatusCode)}
		c.record(method, e)
		return nil, e
	}
	if !head.OK {
		e := &APIError{Method: method, Code: head.Error, Needed: head.Needed, Provided: head.Provided, RetryAfter: ra, Msg: Scrub(Describe(method, head.Error, head.Needed), tok)}
		c.record(method, e)
		return nil, e
	}
	c.record(method, nil)
	return &Resp{Body: raw, Header: resp.Header}, nil
}

func withoutURL(err error) string {
	if ue, ok := err.(*url.Error); ok {
		return ue.Err.Error()
	}
	return err.Error()
}
