// Package linear is minbox's client of Linear's remote MCP server (Streamable HTTP): a minimal
// MCP client, the MCP OAuth 2.1 login (discovery, dynamic client registration, PKCE) and tolerant
// parsers of the tools' results. Nothing here talks to Linear unless the caller asks it to.
package linear

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
	"strconv"
	"strings"
	"sync"
	"time"
)

// DefaultMCPURL is Linear's remote MCP server.
const DefaultMCPURL = "https://mcp.linear.app/mcp"

// MCPURLFromEnv: MINBOX_LINEAR_MCP_URL overrides the MCP URL for tests (a fake Linear on
// 127.0.0.1). Only an http URL on a loopback host is honoured, so tokens can never be redirected
// to another machine by the environment.
func MCPURLFromEnv(v string) string {
	u, err := url.Parse(strings.TrimSpace(v))
	if v == "" || err != nil || u.Scheme != "http" || u.Host == "" || !LoopbackHost(u.Hostname()) {
		return DefaultMCPURL
	}
	return u.String()
}

// LoopbackHost: localhost or a loopback IP.
func LoopbackHost(h string) bool {
	if h == "localhost" {
		return true
	}
	ip := net.ParseIP(h)
	return ip != nil && ip.IsLoopback()
}

const (
	maxBody         = 8 << 20
	protocolVersion = "2025-06-18"
)

// ErrUnauthorized: the server refused the access token (after one refresh attempt).
var ErrUnauthorized = errors.New("linear: not authorized (login needed)")

// RateLimitError: HTTP 429; no request is sent before the time in Until.
type RateLimitError struct {
	RetryAfter time.Duration
	Until      time.Time
}

func (e *RateLimitError) Error() string {
	return fmt.Sprintf("linear: rate limited, retry in %s", e.RetryAfter.Round(time.Second))
}

// HTTPError: a non-success HTTP status.
type HTTPError struct {
	Status int
	Body   string
}

func (e *HTTPError) Error() string { return fmt.Sprintf("linear: HTTP %d: %s", e.Status, e.Body) }

// RPCError: a JSON-RPC error object.
type RPCError struct {
	Code    int
	Message string
}

func (e *RPCError) Error() string { return fmt.Sprintf("linear: %s (code %d)", e.Message, e.Code) }

// ToolError: a tool result with isError.
type ToolError struct{ Text string }

func (e *ToolError) Error() string { return "linear: tool failed: " + Truncate(e.Text, 300) }

// Tool is one entry of tools/list.
type Tool struct {
	Name        string         `json:"name"`
	Description string         `json:"description"`
	InputSchema map[string]any `json:"inputSchema"`
}

// Props lists the argument names the tool's input schema declares.
func (t Tool) Props() map[string]bool {
	out := map[string]bool{}
	if p, ok := t.InputSchema["properties"].(map[string]any); ok {
		for k := range p {
			out[k] = true
		}
	}
	return out
}

// Pick returns the first candidate that the tool declares; with no schema it returns the first
// candidate, with a schema that has none of them, "".
func (t Tool) Pick(cands ...string) string {
	p := t.Props()
	for _, c := range cands {
		if p[c] {
			return c
		}
	}
	if len(p) == 0 && len(cands) > 0 {
		return cands[0]
	}
	return ""
}

// Result is a tool's result.
type Result struct {
	Text       string // the text content joined
	Structured any    // structuredContent, if any
}

// Value is the result as data: structuredContent, else the text parsed as JSON, else the text.
func (r *Result) Value() any {
	if r.Structured != nil {
		return r.Structured
	}
	var v any
	if json.Unmarshal([]byte(strings.TrimSpace(r.Text)), &v) == nil {
		return v
	}
	return r.Text
}

// Client is a minimal MCP client over Streamable HTTP.
type Client struct {
	URL  string
	HTTP *http.Client
	// Token returns the access token; force: the server refused the last one, refresh it.
	Token func(ctx context.Context, force bool) (string, error)
	// Scrub removes secrets from an error text.
	Scrub func(string) string
	Now   func() time.Time

	mu      sync.Mutex
	session string
	proto   string
	ready   bool
	blocked time.Time
	nextID  int64
	tools   []Tool
	toolsAt time.Time
}

func (c *Client) now() time.Time {
	if c.Now != nil {
		return c.Now()
	}
	return time.Now()
}

func (c *Client) scrub(s string) string {
	if c.Scrub != nil {
		return c.Scrub(s)
	}
	return s
}

// Truncate cuts s to at most n bytes on a rune boundary, adding an ellipsis when it cut.
func Truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	cut := n
	for cut > 0 && s[cut]&0xC0 == 0x80 {
		cut--
	}
	return s[:cut] + "…"
}

type rpcResp struct {
	ID     json.RawMessage `json:"id"`
	Result json.RawMessage `json:"result"`
	Error  *struct {
		Code    int    `json:"code"`
		Message string `json:"message"`
	} `json:"error"`
}

// Blocked reports how long calls are refused after a 429.
func (c *Client) Blocked() time.Duration {
	c.mu.Lock()
	defer c.mu.Unlock()
	if d := c.blocked.Sub(c.now()); d > 0 {
		return d
	}
	return 0
}

func (c *Client) post(ctx context.Context, payload []byte, token, session, proto string) (*http.Response, []byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.URL, bytes.NewReader(payload))
	if err != nil {
		return nil, nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json, text/event-stream")
	req.Header.Set("Authorization", "Bearer "+token)
	if session != "" {
		req.Header.Set("Mcp-Session-Id", session)
	}
	if proto != "" {
		req.Header.Set("MCP-Protocol-Version", proto)
	}
	hc := c.HTTP
	if hc == nil {
		hc = &http.Client{Timeout: 45 * time.Second}
	}
	resp, err := hc.Do(req)
	if err != nil {
		return nil, nil, errors.New(c.scrub(err.Error()))
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, maxBody+1))
	if err != nil {
		return nil, nil, errors.New(c.scrub(err.Error()))
	}
	if len(body) > maxBody {
		return nil, nil, errors.New("linear: response too large")
	}
	return resp, body, nil
}

func parseRetryAfter(v string, now time.Time) time.Duration {
	if n, err := strconv.Atoi(strings.TrimSpace(v)); err == nil && n >= 0 {
		return time.Duration(n) * time.Second
	}
	if t, err := http.ParseTime(v); err == nil {
		return max(0, t.Sub(now))
	}
	return 30 * time.Second
}

// rpc sends one request and returns its result; it handles 401 (one refresh), 404 on a session
// (re-initialize once), 429 and SSE responses.
func (c *Client) rpc(ctx context.Context, method string, params any, init bool) (json.RawMessage, error) {
	if d := c.Blocked(); d > 0 {
		return nil, &RateLimitError{RetryAfter: d, Until: c.now().Add(d)}
	}
	forced, reinit := false, false
	for {
		if !init {
			if err := c.ensureReady(ctx); err != nil {
				return nil, err
			}
		}
		token, err := c.Token(ctx, forced)
		if err != nil {
			return nil, err
		}
		c.mu.Lock()
		c.nextID++
		id := c.nextID
		session, proto := c.session, c.proto
		c.mu.Unlock()
		payload, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": id, "method": method, "params": params})
		resp, body, err := c.post(ctx, payload, token, session, proto)
		if err != nil {
			return nil, err
		}
		switch {
		case resp.StatusCode == 401:
			if forced {
				return nil, ErrUnauthorized
			}
			forced = true
			continue
		case resp.StatusCode == 404 && session != "" && !init && !reinit:
			c.mu.Lock()
			c.ready, c.session = false, ""
			c.mu.Unlock()
			reinit = true
			continue
		case resp.StatusCode == 429:
			d := parseRetryAfter(resp.Header.Get("Retry-After"), c.now())
			c.mu.Lock()
			c.blocked = c.now().Add(d)
			c.mu.Unlock()
			return nil, &RateLimitError{RetryAfter: d, Until: c.now().Add(d)}
		case resp.StatusCode < 200 || resp.StatusCode > 299:
			return nil, &HTTPError{Status: resp.StatusCode, Body: c.scrub(Truncate(strings.TrimSpace(string(body)), 300))}
		}
		if init {
			if s := resp.Header.Get("Mcp-Session-Id"); s != "" {
				c.mu.Lock()
				c.session = s
				c.mu.Unlock()
			}
		}
		rr, err := decodeRPC(resp.Header.Get("Content-Type"), body, id)
		if err != nil {
			return nil, err
		}
		if rr.Error != nil {
			return nil, &RPCError{Code: rr.Error.Code, Message: c.scrub(Truncate(rr.Error.Message, 300))}
		}
		return rr.Result, nil
	}
}

// decodeRPC reads the response of request id from a JSON body or an SSE stream.
func decodeRPC(contentType string, body []byte, id int64) (*rpcResp, error) {
	want := strconv.FormatInt(id, 10)
	match := func(raw []byte) *rpcResp {
		var r rpcResp
		if json.Unmarshal(raw, &r) != nil || len(r.ID) == 0 || (r.Result == nil && r.Error == nil) {
			return nil
		}
		if strings.Trim(strings.TrimSpace(string(r.ID)), `"`) != want {
			return nil
		}
		return &r
	}
	if strings.HasPrefix(strings.ToLower(contentType), "text/event-stream") {
		var data []string
		flush := func() *rpcResp {
			if len(data) == 0 {
				return nil
			}
			raw := strings.Join(data, "\n")
			data = nil
			return match([]byte(raw))
		}
		for _, line := range strings.Split(string(body), "\n") {
			line = strings.TrimRight(line, "\r")
			switch {
			case line == "":
				if r := flush(); r != nil {
					return r, nil
				}
			case strings.HasPrefix(line, "data:"):
				data = append(data, strings.TrimPrefix(strings.TrimPrefix(line, "data:"), " "))
			}
		}
		if r := flush(); r != nil {
			return r, nil
		}
		return nil, errors.New("linear: no response in the event stream")
	}
	trim := bytes.TrimSpace(body)
	if len(trim) > 0 && trim[0] == '[' { // a batch
		var arr []json.RawMessage
		if json.Unmarshal(trim, &arr) == nil {
			for _, a := range arr {
				if r := match(a); r != nil {
					return r, nil
				}
			}
		}
		return nil, errors.New("linear: no response in the batch")
	}
	if r := match(trim); r != nil {
		return r, nil
	}
	return nil, errors.New("linear: unreadable response")
}

func (c *Client) ensureReady(ctx context.Context) error {
	c.mu.Lock()
	ready := c.ready
	c.mu.Unlock()
	if ready {
		return nil
	}
	raw, err := c.rpc(ctx, "initialize", map[string]any{
		"protocolVersion": protocolVersion, "capabilities": map[string]any{},
		"clientInfo": map[string]any{"name": "minbox", "version": "1"},
	}, true)
	if err != nil {
		return err
	}
	var res struct {
		ProtocolVersion string `json:"protocolVersion"`
	}
	_ = json.Unmarshal(raw, &res)
	c.mu.Lock()
	c.proto = res.ProtocolVersion
	if c.proto == "" {
		c.proto = protocolVersion
	}
	c.ready = true
	session, proto := c.session, c.proto
	c.mu.Unlock()
	// notifications/initialized: no id, 202 expected; failures here are not fatal.
	if token, err := c.Token(ctx, false); err == nil {
		payload, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "method": "notifications/initialized"})
		_, _, _ = c.post(ctx, payload, token, session, proto)
	}
	return nil
}

// Tools lists the server's tools (cached for ten minutes; refresh forces a new list).
func (c *Client) Tools(ctx context.Context, refresh bool) ([]Tool, error) {
	c.mu.Lock()
	if !refresh && c.tools != nil && c.now().Sub(c.toolsAt) < 10*time.Minute {
		t := c.tools
		c.mu.Unlock()
		return t, nil
	}
	c.mu.Unlock()
	var all []Tool
	cursor := ""
	for page := 0; page < 10; page++ {
		params := map[string]any{}
		if cursor != "" {
			params["cursor"] = cursor
		}
		raw, err := c.rpc(ctx, "tools/list", params, false)
		if err != nil {
			return nil, err
		}
		var res struct {
			Tools      []Tool `json:"tools"`
			NextCursor string `json:"nextCursor"`
		}
		if err := json.Unmarshal(raw, &res); err != nil {
			return nil, errors.New("linear: unreadable tools/list")
		}
		all = append(all, res.Tools...)
		if res.NextCursor == "" {
			break
		}
		cursor = res.NextCursor
	}
	if all == nil {
		all = []Tool{}
	}
	c.mu.Lock()
	c.tools, c.toolsAt = all, c.now()
	c.mu.Unlock()
	return all, nil
}

// FindTool returns the first tool whose name is one of names (in that order).
func (c *Client) FindTool(ctx context.Context, names ...string) (Tool, error) {
	tools, err := c.Tools(ctx, false)
	if err != nil {
		return Tool{}, err
	}
	for _, n := range names {
		for _, t := range tools {
			if t.Name == n {
				return t, nil
			}
		}
	}
	return Tool{}, fmt.Errorf("linear: the server has no tool named %s", strings.Join(names, " or "))
}

// Call runs a tool.
func (c *Client) Call(ctx context.Context, name string, args map[string]any) (*Result, error) {
	raw, err := c.rpc(ctx, "tools/call", map[string]any{"name": name, "arguments": args}, false)
	if err != nil {
		return nil, err
	}
	var res struct {
		Content []struct {
			Type string `json:"type"`
			Text string `json:"text"`
		} `json:"content"`
		Structured any  `json:"structuredContent"`
		IsError    bool `json:"isError"`
	}
	if err := json.Unmarshal(raw, &res); err != nil {
		return nil, errors.New("linear: unreadable tool result")
	}
	var texts []string
	for _, p := range res.Content {
		if p.Type == "text" || p.Type == "" {
			texts = append(texts, p.Text)
		}
	}
	out := &Result{Text: strings.Join(texts, "\n"), Structured: res.Structured}
	if res.IsError {
		return nil, &ToolError{Text: c.scrub(out.Text)}
	}
	return out, nil
}

// Reset forgets the session and the cached tools (after a login change).
func (c *Client) Reset() {
	c.mu.Lock()
	c.ready, c.session, c.tools, c.blocked = false, "", nil, time.Time{}
	c.mu.Unlock()
}
