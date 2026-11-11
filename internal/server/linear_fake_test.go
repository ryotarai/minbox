package server

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"
)

// fakeLinear is a fake Linear: an MCP server (JSON or SSE responses, both tool-name catalogs) and
// an OAuth server with dynamic client registration. No real Linear is ever contacted.
type fakeLinear struct {
	t  *testing.T
	ts *httptest.Server

	mu sync.Mutex
	// OAuth
	clients         map[string]string // client_id -> redirect uri
	codes           map[string]fakeCode
	access          string // the access token the MCP endpoint accepts
	refresh         string
	expiresIn       int
	invalidGrant    bool
	registrations   int
	tokenCalls      int
	refreshCalls    int
	lastRegRedirect string
	// MCP
	variant    string // "save" (save_comment, save_issue) or "create" (create_comment, update_comment, update_issue)
	sse        bool
	issue      map[string]any
	issueURL   string
	comments   []map[string]any
	statuses   []map[string]any
	calls      []fakeCall
	rateLimit  bool
	failUpdate bool
	failBody   string // when set, get_issue answers 500 with this body
	nextID     int
	// create-issue support
	created    []map[string]any // issues made by save_issue/create_issue, in order
	failCreate string           // when set, the create tool answers a tool error with this text
	createNoID bool             // the create tool answers something without an identifier
	failTeams  bool
	// list_teams pagination: teamList overrides the two default teams; teamPage > 0 pages it with
	// the cursor argument named cursorKey ("cursor" by default) and the result shape pageShape
	// ("" = nextCursor, "pageInfo", "text" = prose around the JSON); teamLimitMax is the schema's
	// maximum for limit; failTeamsPage2 makes the second page a tool error.
	teamList       []map[string]any
	teamPage       int
	cursorKey      string
	pageShape      string
	teamLimitMax   int
	failTeamsPage2 bool
	failStatusTeam string // list_issue_statuses for this team id is a tool error
	failLabels     bool
	failProjects   bool
	failLabelsTeam string // list_issue_labels for this team id is a tool error
	createDelay    time.Duration
}

type fakeCode struct {
	challenge, redirect string
}

type fakeCall struct {
	Tool string
	Args map[string]any
}

func randHex(n int) string {
	b := make([]byte, n)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

func newFakeLinear(t *testing.T) *fakeLinear {
	f := &fakeLinear{t: t, clients: map[string]string{}, codes: map[string]fakeCode{}, variant: "save", expiresIn: 3600}
	f.issueURL = "https://linear.app/some-other-workspace/issue/ENG-123/fix-the-thing"
	f.issue = map[string]any{"id": "iss-uuid-1", "identifier": "ENG-123", "title": "Fix the thing",
		"state": map[string]any{"name": "Todo", "type": "unstarted"}, "team": map[string]any{"id": "team-1", "name": "Engineering"},
		"assignee": "Alice", "url": f.issueURL}
	f.statuses = []map[string]any{
		{"id": "st-1", "name": "Backlog", "type": "backlog"}, {"id": "st-2", "name": "Todo", "type": "unstarted"},
		{"id": "st-3", "name": "In Progress", "type": "started"}, {"id": "st-4", "name": "Done", "type": "completed"},
	}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /.well-known/oauth-protected-resource/mcp", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, 200, map[string]any{"resource": f.ts.URL, "authorization_servers": []string{f.ts.URL}, "scopes_supported": []string{"read", "write"}})
	})
	mux.HandleFunc("GET /.well-known/oauth-authorization-server", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, 200, map[string]any{"issuer": f.ts.URL, "authorization_endpoint": f.ts.URL + "/authorize", "token_endpoint": f.ts.URL + "/token",
			"registration_endpoint": f.ts.URL + "/register", "scopes_supported": []string{"read", "write", "openid"}, "code_challenge_methods_supported": []string{"S256"}})
	})
	mux.HandleFunc("POST /register", f.register)
	mux.HandleFunc("GET /authorize", f.authorize)
	mux.HandleFunc("POST /token", f.token)
	mux.HandleFunc("POST /mcp", f.mcp)
	f.ts = httptest.NewServer(mux)
	t.Cleanup(f.ts.Close)
	return f
}

func (f *fakeLinear) register(w http.ResponseWriter, r *http.Request) {
	var req struct {
		RedirectURIs []string `json:"redirect_uris"`
		Method       string   `json:"token_endpoint_auth_method"`
	}
	_ = json.NewDecoder(r.Body).Decode(&req)
	f.mu.Lock()
	defer f.mu.Unlock()
	if len(req.RedirectURIs) != 1 {
		writeJSON(w, 400, map[string]string{"error": "invalid_redirect_uri"})
		return
	}
	f.registrations++
	f.lastRegRedirect = req.RedirectURIs[0]
	id := "client-" + randHex(4)
	f.clients[id] = req.RedirectURIs[0]
	writeJSON(w, 201, map[string]any{"client_id": id, "token_endpoint_auth_method": "none"})
}

func (f *fakeLinear) authorize(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	f.mu.Lock()
	defer f.mu.Unlock()
	redirect, ok := f.clients[q.Get("client_id")]
	if !ok || redirect != q.Get("redirect_uri") || q.Get("code_challenge_method") != "S256" || q.Get("state") == "" || q.Get("response_type") != "code" {
		http.Error(w, "bad authorize request", 400)
		return
	}
	if q.Get("resource") == "" || q.Get("scope") != "read write" {
		http.Error(w, "resource/scope missing: "+q.Get("scope"), 400)
		return
	}
	code := "code-" + randHex(6)
	f.codes[code] = fakeCode{challenge: q.Get("code_challenge"), redirect: redirect}
	u, _ := url.Parse(redirect)
	rq := u.Query()
	rq.Set("code", code)
	rq.Set("state", q.Get("state"))
	rq.Set("iss", f.ts.URL)
	u.RawQuery = rq.Encode()
	http.Redirect(w, r, u.String(), 302)
}

func (f *fakeLinear) newTokens() (string, string) {
	return "at_" + randHex(12), "rt_" + randHex(12)
}

func (f *fakeLinear) token(w http.ResponseWriter, r *http.Request) {
	_ = r.ParseForm()
	f.mu.Lock()
	defer f.mu.Unlock()
	f.tokenCalls++
	switch r.Form.Get("grant_type") {
	case "authorization_code":
		c, ok := f.codes[r.Form.Get("code")]
		delete(f.codes, r.Form.Get("code"))
		sum := sha256.Sum256([]byte(r.Form.Get("code_verifier")))
		if !ok || c.redirect != r.Form.Get("redirect_uri") || base64.RawURLEncoding.EncodeToString(sum[:]) != c.challenge {
			writeJSON(w, 400, map[string]string{"error": "invalid_grant"})
			return
		}
	case "refresh_token":
		f.refreshCalls++
		if f.invalidGrant || r.Form.Get("refresh_token") != f.refresh {
			writeJSON(w, 400, map[string]string{"error": "invalid_grant", "error_description": "refresh token revoked"})
			return
		}
	default:
		writeJSON(w, 400, map[string]string{"error": "unsupported_grant_type"})
		return
	}
	f.access, f.refresh = f.newTokens()
	writeJSON(w, 200, map[string]any{"access_token": f.access, "refresh_token": f.refresh, "token_type": "Bearer", "expires_in": f.expiresIn, "scope": "read write"})
}

func (f *fakeLinear) mcp(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if r.Header.Get("Authorization") != "Bearer "+f.access || f.access == "" {
		w.WriteHeader(401)
		return
	}
	var req struct {
		ID     any             `json:"id"`
		Method string          `json:"method"`
		Params json.RawMessage `json:"params"`
	}
	_ = json.NewDecoder(r.Body).Decode(&req)
	if req.Method == "notifications/initialized" {
		w.WriteHeader(202)
		return
	}
	reply := func(result any) {
		b, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": req.ID, "result": result})
		if f.sse {
			w.Header().Set("Content-Type", "text/event-stream")
			fmt.Fprintf(w, "event: message\ndata: %s\n\n", b)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write(b)
	}
	text := func(v any) {
		b, _ := json.Marshal(v)
		reply(map[string]any{"content": []map[string]any{{"type": "text", "text": string(b)}}})
	}
	toolErr := func(msg string) {
		reply(map[string]any{"isError": true, "content": []map[string]any{{"type": "text", "text": msg}}})
	}
	switch req.Method {
	case "initialize":
		w.Header().Set("Mcp-Session-Id", "sess-"+randHex(3))
		reply(map[string]any{"protocolVersion": "2025-06-18", "capabilities": map[string]any{"tools": map[string]any{}}, "serverInfo": map[string]any{"name": "fake-linear"}})
		return
	case "tools/list":
		obj := func(props ...string) map[string]any {
			p := map[string]any{}
			for _, k := range props {
				p[k] = map[string]any{"type": "string"}
			}
			return map[string]any{"type": "object", "properties": p}
		}
		tools := []map[string]any{
			{"name": "get_user", "inputSchema": obj("query")}, {"name": "get_issue", "inputSchema": obj("id")},
			{"name": "list_comments", "inputSchema": obj("issueId")}, {"name": "list_issue_statuses", "inputSchema": obj("team")},
			{"name": "list_teams", "inputSchema": f.teamsSchema(obj)}, {"name": "list_issue_labels", "inputSchema": obj("team", "limit")},
			{"name": "list_projects", "inputSchema": obj("limit")},
		}
		createProps := obj("title", "description", "team", "state", "assignee", "project")
		createProps["properties"].(map[string]any)["priority"] = map[string]any{"type": "number"}
		createProps["properties"].(map[string]any)["labels"] = map[string]any{"type": "array", "items": map[string]any{"type": "string"}}
		if f.variant == "save" {
			tools = append(tools, map[string]any{"name": "save_comment", "inputSchema": obj("issueId", "body", "id")},
				map[string]any{"name": "save_issue", "inputSchema": mergeProps(obj("id", "state"), createProps)})
		} else {
			tools = append(tools, map[string]any{"name": "create_comment", "inputSchema": obj("issueId", "body")},
				map[string]any{"name": "update_comment", "inputSchema": obj("id", "body")},
				map[string]any{"name": "update_issue", "inputSchema": obj("id", "state")},
				map[string]any{"name": "create_issue", "inputSchema": createProps})
		}
		reply(map[string]any{"tools": tools})
		return
	case "tools/call":
	default:
		reply(map[string]any{})
		return
	}
	var call struct {
		Name string         `json:"name"`
		Args map[string]any `json:"arguments"`
	}
	_ = json.Unmarshal(req.Params, &call)
	f.calls = append(f.calls, fakeCall{call.Name, call.Args})
	if f.rateLimit {
		w.Header().Set("Retry-After", "30")
		w.WriteHeader(429)
		return
	}
	s := func(k string) string { v, _ := call.Args[k].(string); return v }
	switch call.Name {
	case "get_user":
		text(map[string]any{"id": "user-1", "name": "Ryota", "email": "ryota@example.com"})
	case "get_issue":
		if f.failBody != "" {
			w.WriteHeader(500)
			_, _ = io.WriteString(w, f.failBody)
			return
		}
		for _, c := range f.created {
			if id := s("id"); id == c["identifier"] || id == c["id"] {
				text(c)
				return
			}
		}
		if id := s("id"); id != "ENG-123" && id != "iss-uuid-1" {
			toolErr("Entity not found: Issue - " + id)
			return
		}
		text(f.issue)
	case "list_comments":
		text(map[string]any{"comments": f.comments})
	case "list_issue_statuses":
		if f.failStatusTeam != "" && s("team") == f.failStatusTeam {
			toolErr("statuses unavailable for " + f.failStatusTeam)
			return
		}
		text(map[string]any{"statuses": f.statuses})
	case "list_teams":
		if f.failTeams {
			toolErr("teams unavailable")
			return
		}
		f.listTeams(call.Args, text, toolErr, func(s string) {
			reply(map[string]any{"content": []map[string]any{{"type": "text", "text": s}}})
		})
	case "list_issue_labels":
		if f.failLabels || (f.failLabelsTeam != "" && s("team") == f.failLabelsTeam) {
			toolErr("labels unavailable")
			return
		}
		text(map[string]any{"labels": []map[string]any{{"id": "lab-1", "name": "Bug", "color": "#f00"}, {"id": "lab-2", "name": "Feature"}, {"id": "lab-3", "name": "Design only", "team": map[string]any{"id": "team-2"}}}})
	case "list_projects":
		if f.failProjects {
			toolErr("projects unavailable")
			return
		}
		text(map[string]any{"projects": []map[string]any{{"id": "proj-1", "name": "Website"}, {"id": "proj-2", "name": "Design system", "teams": []map[string]any{{"id": "team-2"}}}}})
	case "save_issue", "create_issue":
		if call.Name == "create_issue" || s("id") == "" {
			if f.failCreate != "" {
				toolErr(f.failCreate)
				return
			}
			if f.createDelay > 0 {
				f.mu.Unlock()
				time.Sleep(f.createDelay)
				f.mu.Lock()
			}
			n := len(f.created) + 1
			iss := map[string]any{"id": fmt.Sprintf("iss-new-%d", n), "identifier": fmt.Sprintf("ENG-%d", 100+n), "title": s("title"),
				"url": fmt.Sprintf("https://linear.app/some-other-workspace/issue/ENG-%d/new", 100+n), "description": s("description"),
				"state": map[string]any{"name": "Todo", "type": "unstarted"}, "team": map[string]any{"id": s("team"), "name": "Engineering"}}
			if st := s("state"); st != "" {
				for _, x := range f.statuses {
					if x["id"] == st {
						iss["state"] = map[string]any{"name": x["name"], "type": x["type"]}
					}
				}
			}
			f.created = append(f.created, iss)
			if f.createNoID {
				text(map[string]any{"ok": true})
				return
			}
			text(iss)
			return
		}
		fallthrough
	case "update_issue":
		name := s("state")
		for _, st := range f.statuses {
			if st["name"] == name {
				f.issue["state"] = map[string]any{"name": name, "type": st["type"]}
			}
		}
		text(f.issue)
	case "save_comment", "create_comment", "update_comment":
		if id := s("id"); id != "" {
			if f.failUpdate {
				toolErr("Comment not found")
				return
			}
			for _, c := range f.comments {
				if c["id"] == id {
					c["body"] = s("body")
					text(c)
					return
				}
			}
			toolErr("Comment not found")
			return
		}
		f.nextID++
		c := map[string]any{"id": fmt.Sprintf("cmt-%d", f.nextID), "body": s("body"), "createdAt": time.Now().UTC().Format(time.RFC3339), "user": map[string]any{"name": "Ryota"}}
		f.comments = append(f.comments, c)
		text(c)
	default:
		toolErr("unknown tool " + call.Name)
	}
}

func (f *fakeLinear) teamsSchema(obj func(...string) map[string]any) map[string]any {
	key := f.cursorKey
	if key == "" {
		key = "cursor"
	}
	sc := obj("query", "limit", key)
	if f.teamLimitMax > 0 {
		sc["properties"].(map[string]any)["limit"] = map[string]any{"type": "number", "maximum": f.teamLimitMax}
	}
	return sc
}

// listTeams answers list_teams (the caller holds f.mu).
func (f *fakeLinear) listTeams(args map[string]any, text func(any), toolErr func(string), prose func(string)) {
	teams := f.teamList
	if teams == nil {
		teams = []map[string]any{{"id": "team-1", "name": "Engineering", "key": "ENG"}, {"id": "team-2", "name": "Design", "key": "DES"}}
	}
	if f.teamPage <= 0 {
		text(map[string]any{"teams": teams})
		return
	}
	key := f.cursorKey
	if key == "" {
		key = "cursor"
	}
	start := 0
	if c, _ := args[key].(string); c != "" {
		_, _ = fmt.Sscanf(c, "c%d", &start)
		if f.failTeamsPage2 {
			toolErr("rate limited on page 2")
			return
		}
	}
	size := f.teamPage
	if lim, ok := args["limit"].(float64); ok && int(lim) < size {
		size = int(lim)
	}
	end := min(start+size, len(teams))
	out := map[string]any{"teams": teams[start:end]}
	next := ""
	if end < len(teams) {
		next = fmt.Sprintf("c%d", end)
	}
	if f.pageShape == "pageInfo" {
		out["pageInfo"] = map[string]any{"hasNextPage": next != "", "endCursor": next}
	} else if next != "" {
		out["nextCursor"] = next
	}
	if f.pageShape == "text" {
		b, _ := json.Marshal(out)
		prose("Found teams:\n" + string(b) + "\n(end)")
		return
	}
	text(out)
}

func mergeProps(a, b map[string]any) map[string]any {
	for k, v := range b["properties"].(map[string]any) {
		a["properties"].(map[string]any)[k] = v
	}
	return a
}

// helpers for tests

func (f *fakeLinear) callsOf(tool string) []fakeCall {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []fakeCall
	for _, c := range f.calls {
		if c.Tool == tool {
			out = append(out, c)
		}
	}
	return out
}

func (f *fakeLinear) count() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.calls)
}

func (f *fakeLinear) addComment(id, author, body string, at time.Time) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.comments = append(f.comments, map[string]any{"id": id, "body": body, "createdAt": at.UTC().Format(time.RFC3339), "user": map[string]any{"name": author, "email": strings.ToLower(author) + "@example.com"}})
}

func (f *fakeLinear) setState(name, typ string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.issue["state"] = map[string]any{"name": name, "type": typ}
}

func (f *fakeLinear) stateName() string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.issue["state"].(map[string]any)["name"].(string)
}
