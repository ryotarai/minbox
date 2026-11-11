package server

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"html"
	"log"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/ryotarai/minbox/internal/linear"
	"github.com/ryotarai/minbox/internal/store"
)

// The Linear integration: minbox is an MCP client of Linear's remote MCP server. See docs/linear.md.
//
// The login (tokens, the registered OAuth clients) lives in the store (linear_auth) and never
// leaves the server: the API shows only the status, the agent has no Linear tools, errors are
// scrubbed of tokens before they are stored or logged.

const linearCallbackPath = "/api/integrations/linear/callback"

var (
	errLinearNotConnected = errors.New("Linear is not connected: Settings → Integrations → Linear → Connect")
	errLinearNeedsLogin   = errors.New("the Linear login expired or was revoked: log in again (Settings → Integrations → Linear → Connect)")
)

// linearAuth is the stored login.
type linearAuth struct {
	MCPURL string `json:"mcp_url"`
	// Registrations: the OAuth client registered for each redirect URI (the Host the browser used).
	Registrations map[string]linear.Registration `json:"registrations"`
	Disc          *linear.Discovery              `json:"discovery,omitempty"`
	RedirectURI   string                         `json:"redirect_uri"` // the one the token was obtained with
	Token         linear.Token                   `json:"token"`
	User          *linear.User                   `json:"user,omitempty"`
	ConnectedAt   time.Time                      `json:"connected_at"`
	NeedsLogin    bool                           `json:"needs_login"`
	LastError     string                         `json:"last_error,omitempty"`
	// LoginError: why the last login attempt failed (shown in Settings; no secrets).
	LoginError   string    `json:"login_error,omitempty"`
	LoginErrorAt time.Time `json:"login_error_at,omitempty"`
}

// loginAttempt is a pending login. It is kept in the store (hashed state as key) so that it
// survives a restart between Connect and the approval at Linear; the verifier is a secret like a token.
type loginAttempt struct {
	Verifier string              `json:"verifier"`
	Host     string              `json:"host"`
	Reg      linear.Registration `json:"reg"`
	Disc     linear.Discovery    `json:"disc"`
	Expires  time.Time           `json:"expires"`
}

// loginOutcome remembers how a callback for a state ended for a few minutes, so that a second hit
// (browser prefetch, reload, second tab) shows the same page and never exchanges the code again.
type loginOutcome struct {
	done  chan struct{}
	ok    bool
	msg   string
	until time.Time
}

const loginOutcomeKeep = 5 * time.Minute

func stateHash(state string) string {
	h := sha256.Sum256([]byte(state))
	return hex.EncodeToString(h[:])
}

type linearSvc struct {
	s      *Server
	mcpURL string
	hc     *http.Client

	authMu sync.Mutex // the stored login (read-modify-write)
	tokMu  sync.Mutex // token refresh
	client *linear.Client
	cliMu  sync.Mutex

	loginMu  sync.Mutex
	outcomes map[string]*loginOutcome // by state hash

	linkMu sync.Mutex // read-modify-write of a thread's link

	// Create issue from a thread (linearcreate.go).
	metaMu        sync.Mutex
	metaCache     *linearMeta
	metaAt        time.Time
	teamMu        sync.Mutex
	teamCache     map[string]teamEntry
	teamInflight  map[string]*teamCall
	draftMu       sync.Mutex
	draftCache    map[string]draftEntry
	draftInflight map[string]*draftCall
	draftSem      chan struct{}
	draftRun      func(ctx context.Context, prompt, schema string) ([]byte, error) // replaced in tests
	createMu      sync.Mutex
	creates       map[string]*createCall

	// My issues (linearissues.go).
	iss issuesState

	mu          sync.Mutex
	syncing     map[string]bool
	lastRefresh map[string]time.Time
	timers      map[string]*time.Timer

	// refreshEvery: a thread opened again within this time is not synced again. progressEvery: the
	// progress comment is updated at most this often. loginTTL: how long a login may take.
	refreshEvery  time.Duration
	progressEvery time.Duration
	loginTTL      time.Duration
	now           func() time.Time
}

func newLinearSvc(s *Server) *linearSvc {
	return &linearSvc{
		s: s, mcpURL: linear.MCPURLFromEnv(os.Getenv("MINBOX_LINEAR_MCP_URL")),
		hc:        &http.Client{Timeout: 30 * time.Second},
		teamCache: map[string]teamEntry{}, teamInflight: map[string]*teamCall{}, draftCache: map[string]draftEntry{}, draftInflight: map[string]*draftCall{}, draftSem: make(chan struct{}, draftParallel),
		creates: map[string]*createCall{}, draftRun: s.runLinearDraft, iss: newIssuesState(),
		outcomes: map[string]*loginOutcome{}, syncing: map[string]bool{}, lastRefresh: map[string]time.Time{}, timers: map[string]*time.Timer{},
		refreshEvery: 45 * time.Second, progressEvery: 60 * time.Second, loginTTL: 20 * time.Minute, now: time.Now,
	}
}

// ---- stored login ----

func (l *linearSvc) loadAuth(ctx context.Context) *linearAuth {
	raw, err := l.s.store.LinearAuth(ctx)
	if err != nil || raw == "" {
		return nil
	}
	var a linearAuth
	if json.Unmarshal([]byte(raw), &a) != nil {
		return nil
	}
	if a.Registrations == nil {
		a.Registrations = map[string]linear.Registration{}
	}
	return &a
}

func (l *linearSvc) saveAuth(ctx context.Context, a *linearAuth) error {
	b, _ := json.Marshal(a)
	return l.s.store.SetLinearAuth(ctx, string(b))
}

// updateAuth: read-modify-write of the stored login under a lock.
func (l *linearSvc) updateAuth(ctx context.Context, fn func(a *linearAuth)) *linearAuth {
	l.authMu.Lock()
	defer l.authMu.Unlock()
	a := l.loadAuth(ctx)
	if a == nil {
		a = &linearAuth{Registrations: map[string]linear.Registration{}}
	}
	fn(a)
	if err := l.saveAuth(ctx, a); err != nil {
		log.Printf("linear: saving the login: %v", l.scrub(ctx, err.Error()))
	}
	return a
}

var bearerRe = regexp.MustCompile(`(?i)bearer\s+[A-Za-z0-9._~+/=-]+`)

// scrub removes every secret of the stored login (and anything shaped like a bearer token) from s.
func (l *linearSvc) scrub(ctx context.Context, s string) string {
	if a := l.loadAuth(ctx); a != nil {
		secrets := []string{a.Token.Access, a.Token.Refresh}
		for _, r := range a.Registrations {
			secrets = append(secrets, r.ClientSecret)
		}
		for _, sec := range secrets {
			if len(sec) >= 6 {
				s = strings.ReplaceAll(s, sec, "[redacted]")
			}
		}
	}
	return bearerRe.ReplaceAllString(s, "Bearer [redacted]")
}

// token is the Client's token source: it refreshes an expired access token (the refresh token
// rotates), and marks the login as needing a new login on invalid_grant.
func (l *linearSvc) token(ctx context.Context, force bool) (string, error) {
	l.tokMu.Lock()
	defer l.tokMu.Unlock()
	a := l.loadAuth(ctx)
	if a == nil || (a.Token.Access == "" && a.Token.Refresh == "" && !a.NeedsLogin) {
		return "", errLinearNotConnected
	}
	if a.NeedsLogin {
		return "", errLinearNeedsLogin
	}
	if !force && a.Token.Valid(l.now()) {
		return a.Token.Access, nil
	}
	reg, ok := a.Registrations[a.RedirectURI]
	if a.Token.Refresh == "" || !ok || a.Disc == nil {
		l.markNeedsLogin(ctx, "the login has no refresh token")
		return "", errLinearNeedsLogin
	}
	nt, err := linear.Refresh(ctx, l.hc, a.Disc, &reg, a.Token.Refresh, l.now())
	if errors.Is(err, linear.ErrInvalidGrant) {
		l.markNeedsLogin(ctx, err.Error())
		return "", errLinearNeedsLogin
	}
	if err != nil {
		return "", errors.New(l.scrub(ctx, err.Error()))
	}
	l.updateAuth(ctx, func(a *linearAuth) { a.Token = *nt; a.NeedsLogin = false; a.LastError = "" })
	return nt.Access, nil
}

func (l *linearSvc) markNeedsLogin(ctx context.Context, why string) {
	l.updateAuth(ctx, func(a *linearAuth) {
		a.NeedsLogin, a.Token.Access, a.Token.Refresh, a.LastError = true, "", "", why
	})
	l.s.hub.publish(Event{Type: "linear"})
}

// cl is the shared MCP client.
func (l *linearSvc) cl() *linear.Client {
	l.cliMu.Lock()
	defer l.cliMu.Unlock()
	if l.client == nil || l.client.URL != l.mcpURL {
		l.client = &linear.Client{URL: l.mcpURL, Token: l.token, Now: l.now,
			Scrub: func(s string) string { return l.scrub(context.Background(), s) }}
	}
	return l.client
}

// errText is an error as stored or shown: scrubbed and short.
func (l *linearSvc) errText(err error) string {
	n := 300
	if strings.Contains(err.Error(), "\ntool: ") {
		n = 1800 // carries a structure summary of an unreadable result
	}
	return linear.Truncate(l.scrub(context.Background(), err.Error()), n)
}

// ---- status ----

type linearStatus struct {
	MCPURL      string       `json:"mcp_url"`
	Connected   bool         `json:"connected"`
	NeedsLogin  bool         `json:"needs_login"`
	User        *linear.User `json:"user,omitempty"`
	ConnectedAt *time.Time   `json:"connected_at,omitempty"`
	LastError   string       `json:"last_error,omitempty"`
	// LastLoginError: why the last Connect did not complete (also in the server log).
	LastLoginError string `json:"last_login_error,omitempty"`
	RedirectURI    string `json:"redirect_uri"` // what Connect would register from this browser
	Blocked        int    `json:"rate_limited_for,omitempty"`
}

func (l *linearSvc) status(r *http.Request) linearStatus {
	st := linearStatus{MCPURL: l.mcpURL, RedirectURI: l.redirectURI(r)}
	if a := l.loadAuth(r.Context()); a != nil {
		st.NeedsLogin = a.NeedsLogin
		st.Connected = !a.NeedsLogin && (a.Token.Access != "" || a.Token.Refresh != "")
		st.User = a.User
		if st.Connected || st.NeedsLogin {
			t := a.ConnectedAt
			st.ConnectedAt = &t
		}
		st.LastError = l.scrub(r.Context(), a.LastError)
		if !st.Connected {
			st.LastLoginError = l.scrub(r.Context(), a.LoginError)
		}
	}
	if d := l.cl().Blocked(); d > 0 {
		st.Blocked = int(d.Seconds()) + 1
	}
	return st
}

func (s *Server) linearStatus(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, 200, s.lin.status(r))
}

// redirectURI is where Linear sends the browser back: this server, under the host the browser used
// to reach it (the guard has checked it against the allowed hosts), over https when the request
// came in over TLS or through a proxy that says so (or the public URL names this host with https).
func (l *linearSvc) redirectURI(r *http.Request) string {
	host := requestHost(r)
	scheme := "http"
	if r.TLS != nil || strings.EqualFold(r.Header.Get("X-Forwarded-Proto"), "https") {
		scheme = "https"
	} else if st, err := l.s.settings(r.Context()); err == nil {
		if pub, _ := st["public_url"].(string); pub != "" {
			if u, err := url.Parse(pub); err == nil && strings.EqualFold(u.Host, host) {
				scheme = u.Scheme
			}
		}
	}
	return scheme + "://" + host + linearCallbackPath
}

// ---- login ----

func (s *Server) linearLogin(w http.ResponseWriter, r *http.Request) {
	l := s.lin
	host := requestHost(r)
	if !s.allowedHost(host) {
		httpError(w, 403, "forbidden host")
		return
	}
	ctx := r.Context()
	redirect := l.redirectURI(r)
	disc, err := linear.Discover(ctx, l.hc, l.mcpURL)
	if err != nil {
		httpError(w, 502, l.errText(err))
		return
	}
	a := l.loadAuth(ctx)
	var reg linear.Registration
	if a != nil {
		reg = a.Registrations[redirect]
	}
	if reg.ClientID == "" {
		nr, err := linear.Register(ctx, l.hc, disc, redirect)
		if err != nil {
			httpError(w, 502, l.errText(err)+" (redirect URI "+redirect+")")
			return
		}
		reg = *nr
		l.updateAuth(ctx, func(a *linearAuth) { a.Registrations[redirect] = reg })
	}
	verifier, challenge := linear.NewPKCE()
	state := linear.RandomState()
	now := l.now()
	if n, err := l.s.store.CountLinearLogins(ctx, now); err == nil && n >= 20 {
		httpError(w, 429, "too many logins in progress")
		return
	}
	at := loginAttempt{Verifier: verifier, Host: strings.ToLower(host), Reg: reg, Disc: *disc, Expires: now.Add(l.loginTTL)}
	b, _ := json.Marshal(at)
	if err := l.s.store.PutLinearLogin(ctx, stateHash(state), string(b), at.Expires, now); err != nil {
		storeError(w, err)
		return
	}
	scope := wantedScopes(disc.Scopes)
	writeJSON(w, 200, map[string]string{"url": linear.AuthURL(disc, &reg, state, challenge, scope), "redirect_uri": redirect})
}

// wantedScopes: read and write, as far as the server offers them.
func wantedScopes(offered []string) string {
	var out []string
	for _, want := range []string{"read", "write"} {
		if len(offered) == 0 {
			out = append(out, want)
			continue
		}
		for _, o := range offered {
			if o == want {
				out = append(out, want)
			}
		}
	}
	return strings.Join(out, " ")
}

// oauthCallback: GET from Linear's authorization page (a top-level cross-site navigation, which
// the guard lets through for this one path). It is authorized by the state alone: an unguessable,
// single-use value made by a login the person started here, bound to the host that started it.
func oauthCallback(r *http.Request) bool {
	// Browsers send Sec-Fetch-Mode/Dest; some webviews and redirect chains do not. A request that
	// says it is something other than a document navigation is refused; one that says nothing is
	// let through (the state is what authorizes it).
	mode, dest := r.Header.Get("Sec-Fetch-Mode"), r.Header.Get("Sec-Fetch-Dest")
	return r.Method == http.MethodGet && r.URL.Path == linearCallbackPath &&
		(mode == "" || mode == "navigate") && (dest == "" || dest == "document")
}

func callbackPage(w http.ResponseWriter, status int, ok bool, msg string) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Referrer-Policy", "no-referrer")
	w.WriteHeader(status)
	title := "Linear login failed"
	refresh := ""
	if ok {
		title = "Connected to Linear"
		refresh = `<meta http-equiv="refresh" content="1;url=/#v=settings&amp;ss=integrations">`
	}
	fmt.Fprintf(w, `<!doctype html><meta charset="utf-8">%s<title>%s</title><body style="font:14px system-ui;margin:3em"><h3>%s</h3><p>%s</p><p><a href="/">Back to minbox</a></p>`,
		refresh, title, title, html.EscapeString(linear.Truncate(msg, 300)))
}

// stateCandidates: the state as received, and the forms a redirect may have mangled it into
// (repeated parameter, percent-encoded again, parameters or a fragment glued on, spaces).
func stateCandidates(q url.Values, rawQuery string) []string {
	var out []string
	seen := map[string]bool{}
	vals := append([]string(nil), q["state"]...)
	for _, v := range q["state"] {
		if k := strings.IndexAny(v, "?&#;"); k > 0 {
			vals = append(vals, v[:k])
		}
		if u, err := url.QueryUnescape(v); err == nil {
			vals = append(vals, u)
		}
	}
	// the query parsed by hand, for a state that url.ParseQuery rejected (e.g. a bad escape)
	for _, kv := range strings.FieldsFunc(rawQuery, func(r rune) bool { return r == '&' || r == ';' }) {
		if strings.HasPrefix(kv, "state=") {
			vals = append(vals, strings.TrimPrefix(kv, "state="))
		}
	}
	for _, v := range vals {
		v = strings.TrimSpace(v)
		if v != "" && !seen[v] {
			seen[v] = true
			out = append(out, v)
		}
	}
	return out
}

func sortedKeys(q url.Values) string {
	var ks []string
	for k := range q {
		ks = append(ks, k)
	}
	sort.Strings(ks)
	return strings.Join(ks, ",")
}

func statePrefix(s string) string {
	if len(s) > 6 {
		return s[:6]
	}
	return s
}

// uaClass: a coarse class of the User-Agent (enough to tell a prefetcher or an in-app view from a
// browser; the full string is not logged).
func uaClass(ua string) string {
	l := strings.ToLower(ua)
	switch {
	case ua == "":
		return "none"
	case strings.Contains(l, "bot"), strings.Contains(l, "preview"), strings.Contains(l, "prefetch"), strings.Contains(l, "slack"), strings.Contains(l, "curl"):
		return "bot-or-tool"
	case strings.Contains(l, "firefox"):
		return "firefox"
	case strings.Contains(l, "chrome"), strings.Contains(l, "chromium"), strings.Contains(l, "edg/"):
		return "chromium"
	case strings.Contains(l, "safari"):
		return "safari"
	}
	return "other"
}

// logHit: one line for every callback hit (no secrets: never the code, a 6-character state prefix),
// so a double hit and its source can be read from the log.
func logHit(r *http.Request, state string) {
	h := r.Header
	log.Printf("linear: login callback hit: host=%s state_present=%t state_prefix=%q query_keys=[%s] sec_fetch=site:%q,mode:%q,dest:%q,user:%q purpose=%q ua=%s",
		requestHost(r), state != "", statePrefix(state), sortedKeys(r.URL.Query()),
		h.Get("Sec-Fetch-Site"), h.Get("Sec-Fetch-Mode"), h.Get("Sec-Fetch-Dest"), h.Get("Sec-Fetch-User"),
		firstNonEmpty(h.Get("Sec-Purpose"), h.Get("Purpose"), h.Get("X-Moz")), uaClass(h.Get("User-Agent")))
}

// callbackFail logs the reason (no secrets) and keeps it for Settings, then shows the failure page.
func (l *linearSvc) callbackFail(w http.ResponseWriter, r *http.Request, status int, state, reason, msg string) {
	log.Printf("linear: login callback failed: reason=%s host=%s state_present=%t state_prefix=%q query_keys=[%s] shown=%q",
		reason, requestHost(r), state != "", statePrefix(state), sortedKeys(r.URL.Query()), linear.Truncate(l.scrub(r.Context(), msg), 200))
	l.noteLoginError(r.Context(), msg)
	callbackPage(w, status, false, msg)
}

func (l *linearSvc) noteLoginError(ctx context.Context, msg string) {
	msg = l.scrub(ctx, linear.Truncate(msg, 300))
	l.updateAuth(ctx, func(a *linearAuth) { a.LoginError, a.LoginErrorAt = msg, l.now() })
}

func (s *Server) linearCallback(w http.ResponseWriter, r *http.Request) {
	l := s.lin
	ctx := r.Context()
	q := r.URL.Query()
	cands := stateCandidates(q, r.URL.RawQuery)
	state := ""
	if len(cands) > 0 {
		state = cands[0]
	}
	logHit(r, state)
	now := l.now()

	// Find what we know about the state: a recent outcome (a replay) or a pending login.
	var at *loginAttempt
	var expiredAt time.Time
	var mine *loginOutcome
	l.loginMu.Lock()
	for k, o := range l.outcomes { // forget old outcomes
		if !o.until.IsZero() && now.After(o.until) {
			delete(l.outcomes, k)
		}
	}
	for _, c := range cands {
		h := stateHash(c)
		if o := l.outcomes[h]; o != nil {
			l.loginMu.Unlock()
			select { // a concurrent hit waits for the first to finish
			case <-o.done:
			case <-time.After(30 * time.Second):
			case <-ctx.Done():
			}
			// A replay changes nothing: no exchange, no stored error, no state consumed.
			if o.ok {
				log.Printf("linear: login callback replayed after success: state_prefix=%q (success page shown again)", statePrefix(c))
				callbackPage(w, 200, true, "You can close this tab.")
			} else {
				log.Printf("linear: login callback replayed after a failure: state_prefix=%q", statePrefix(c))
				callbackPage(w, 400, false, "This login link was already used and it did not succeed: "+o.msg)
			}
			return
		}
		data, exp, err := s.store.TakeLinearLogin(ctx, h) // single use, whatever happens next
		if err != nil {
			l.loginMu.Unlock()
			l.callbackFail(w, r, 500, c, "store", "minbox could not read the pending login: "+err.Error())
			return
		}
		if data == "" {
			continue
		}
		var a loginAttempt
		if json.Unmarshal([]byte(data), &a) != nil {
			continue
		}
		state, at, expiredAt = c, &a, exp
		mine = &loginOutcome{done: make(chan struct{})}
		l.outcomes[h] = mine
		break
	}
	l.loginMu.Unlock()

	finish := func(ok bool, msg string) { // record the outcome for replays
		l.loginMu.Lock()
		mine.ok, mine.msg, mine.until = ok, msg, l.now().Add(loginOutcomeKeep)
		l.loginMu.Unlock()
		close(mine.done)
	}
	fail := func(status int, reason, msg string) {
		if mine != nil {
			finish(false, msg)
		}
		l.callbackFail(w, r, status, state, reason, msg)
	}

	// Linear's own error first: it is the real reason, with or without a known state.
	if e := q.Get("error"); e != "" {
		fail(400, "linear_error", "Linear answered: "+e+" "+q.Get("error_description"))
		return
	}
	if at == nil {
		if state == "" {
			fail(400, "no_state", "The answer from Linear carried no login state. Start again from Settings.")
		} else {
			fail(400, "unknown_state", "This login is unknown (maybe the server restarted or another minbox instance started it, or the link was altered). Start again from Settings.")
		}
		return
	}
	if now.After(at.Expires) || now.After(expiredAt) {
		fail(400, "expired", "This login expired (it must be approved within "+l.loginTTL.String()+"). Start again from Settings.")
		return
	}
	if !strings.EqualFold(requestHost(r), at.Host) {
		fail(400, "host_mismatch", "The login was started from another address ("+at.Host+"). Open minbox there and start again.")
		return
	}
	if iss := q.Get("iss"); iss != "" && at.Disc.Issuer != "" && strings.TrimRight(iss, "/") != strings.TrimRight(at.Disc.Issuer, "/") {
		fail(400, "issuer", "The answer came from an unexpected authorization server.")
		return
	}
	code := q.Get("code")
	if code == "" {
		fail(400, "no_code", "No authorization code in the answer.")
		return
	}
	tok, err := linear.Exchange(ctx, l.hc, &at.Disc, &at.Reg, code, at.Verifier, l.now())
	if err != nil {
		fail(502, "exchange", l.errText(err))
		return
	}
	disc := at.Disc
	l.updateAuth(ctx, func(a *linearAuth) {
		a.MCPURL, a.Disc, a.RedirectURI, a.Token = l.mcpURL, &disc, at.Reg.RedirectURI, *tok
		a.Registrations[at.Reg.RedirectURI] = at.Reg
		a.NeedsLogin, a.LastError, a.ConnectedAt, a.User = false, "", l.now(), nil
		a.LoginError, a.LoginErrorAt = "", time.Time{}
	})
	l.cl().Reset()
	// Who is it? Best effort: the connection works without it.
	if u, err := l.getUser(ctx); err == nil && u != nil {
		l.updateAuth(ctx, func(a *linearAuth) { a.User = u })
	}
	finish(true, "")
	s.hub.publish(Event{Type: "linear"})
	callbackPage(w, 200, true, "You can close this tab.")
}

func (s *Server) linearDisconnect(w http.ResponseWriter, r *http.Request) {
	if err := s.store.DeleteLinearAuth(r.Context()); err != nil {
		storeError(w, err)
		return
	}
	s.lin.cl().Reset()
	s.hub.publish(Event{Type: "linear"})
	writeJSON(w, 200, s.lin.status(r))
}

// linearTest asks Linear who the login is (get_user "me").
func (s *Server) linearTest(w http.ResponseWriter, r *http.Request) {
	l := s.lin
	u, err := l.getUser(r.Context())
	if err != nil {
		writeJSON(w, 200, map[string]any{"ok": false, "error": l.errText(err)})
		return
	}
	if u != nil {
		l.updateAuth(r.Context(), func(a *linearAuth) { a.User = u })
		s.hub.publish(Event{Type: "linear"})
	}
	var names []string
	if tools, err := l.cl().Tools(r.Context(), true); err == nil {
		for _, t := range tools {
			names = append(names, t.Name)
		}
	}
	writeJSON(w, 200, map[string]any{"ok": true, "user": u, "tools": names})
}

// ---- tool access (names adapt to the server's catalog) ----

var linearTools = map[string][]string{
	"get_issue":      {"get_issue"},
	"list_comments":  {"list_comments"},
	"create_comment": {"save_comment", "create_comment"},
	"update_comment": {"save_comment", "update_comment"},
	"update_issue":   {"save_issue", "update_issue"},
	"list_statuses":  {"list_issue_statuses", "list_workflow_states", "list_statuses"},
	"list_teams":     {"list_teams"},
	"list_labels":    {"list_issue_labels", "list_labels"},
	"list_projects":  {"list_projects"},
	"create_issue":   {"save_issue", "create_issue"},
	"get_user":       {"get_user"},
	"list_issues":    {"list_issues"},
}

func (l *linearSvc) call(ctx context.Context, op string, build func(t linear.Tool) (map[string]any, error)) (any, error) {
	res, _, err := l.callRaw(ctx, op, build)
	if err != nil {
		return nil, err
	}
	return res.Value(), nil
}

// callRaw is call that returns the whole result and the tool's name (for a diagnosis).
func (l *linearSvc) callRaw(ctx context.Context, op string, build func(t linear.Tool) (map[string]any, error)) (*linear.Result, string, error) {
	t, err := l.cl().FindTool(ctx, linearTools[op]...)
	if err != nil {
		return nil, "", err
	}
	args, err := build(t)
	if err != nil {
		return nil, t.Name, err
	}
	res, err := l.cl().Call(ctx, t.Name, args)
	if err != nil {
		return nil, t.Name, err
	}
	return res, t.Name, nil
}

// unreadable is the error for a result no parser could read: what failed plus the structure of the
// raw answer (no values), which the person can paste back.
func unreadable(what, tool string, res *linear.Result, items []any) error {
	return fmt.Errorf("%s\n%s", what, strings.TrimRight(linear.Diagnose(tool, res, items, true), "\n"))
}

func (l *linearSvc) getUser(ctx context.Context) (*linear.User, error) {
	res, tool, err := l.callRaw(ctx, "get_user", func(t linear.Tool) (map[string]any, error) {
		return map[string]any{t.Pick("query", "id", "userId"): "me"}, nil
	})
	if err != nil {
		return nil, err
	}
	u := linear.ParseUser(res.Value())
	if u == nil || u.ID == "" {
		log.Printf("linear: get_user unreadable: %s", linear.OneLine(linear.Diagnose(tool, res, nil, false)))
		return nil, unreadable("Linear did not say who you are", tool, res, nil)
	}
	return u, nil
}

func (l *linearSvc) getIssue(ctx context.Context, ref string) (*linear.Issue, error) {
	res, tool, err := l.callRaw(ctx, "get_issue", func(t linear.Tool) (map[string]any, error) {
		return map[string]any{t.Pick("id", "issueId", "identifier"): ref}, nil
	})
	if err != nil {
		return nil, err
	}
	is, err := linear.ParseIssue(res.Value())
	if err != nil {
		log.Printf("linear: get_issue unreadable: %s", linear.OneLine(linear.Diagnose(tool, res, nil, false)))
		return nil, unreadable(err.Error(), tool, res, nil)
	}
	if is.Identifier == "" {
		is.Identifier = ref
	}
	return is, nil
}

func issueRef(l *store.ThreadLink) string {
	if l.IssueID != "" {
		return l.IssueID
	}
	return l.Identifier
}

func (l *linearSvc) listComments(ctx context.Context, lk *store.ThreadLink) ([]linear.Comment, error) {
	res, tool, err := l.callRaw(ctx, "list_comments", func(t linear.Tool) (map[string]any, error) {
		return map[string]any{t.Pick("issueId", "issue", "issue_id"): issueRef(lk)}, nil
	})
	if err != nil {
		return nil, err
	}
	v := res.Value()
	cs, err := linear.ParseComments(v)
	if err != nil {
		items := linear.Items(v, "comments")
		log.Printf("linear: list_comments unreadable: %s", linear.OneLine(linear.Diagnose(tool, res, items, false)))
		return nil, unreadable(err.Error(), tool, res, items)
	}
	return cs, nil
}

// ---- the thread's link ----

type linkReq struct {
	Issue       string `json:"issue"`
	IncludeBody *bool  `json:"include_body"`
}

// wrapErr carries a scrubbed message and the error it came from.
type wrapErr struct {
	msg string
	err error
	// status and code, when set, are what the API answers with (see createError).
	status int
	code   string
}

func (e *wrapErr) Error() string { return e.msg }
func (e *wrapErr) Unwrap() error { return e.err }

func linearError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, errLinearNotConnected), errors.Is(err, errLinearNeedsLogin), errors.Is(err, linear.ErrUnauthorized):
		writeJSON(w, 409, map[string]string{"error": err.Error(), "code": "linear_login"})
	default:
		var rl *linear.RateLimitError
		if errors.As(err, &rl) {
			writeJSON(w, 429, map[string]string{"error": err.Error(), "code": "linear_rate_limited"})
			return
		}
		httpError(w, 502, err.Error())
	}
}

func (s *Server) putThreadLinear(w http.ResponseWriter, r *http.Request) {
	l := s.lin
	ctx := r.Context()
	id := r.PathValue("id")
	th, err := s.store.GetThread(ctx, id)
	if err != nil {
		storeError(w, err)
		return
	}
	var req linkReq
	if !decode(w, r, &req) {
		return
	}
	ident, err := linear.ParseIssueRef(req.Issue)
	if err != nil {
		httpError(w, 400, err.Error())
		return
	}
	is, err := l.getIssue(ctx, ident)
	if err != nil {
		linearError(w, &wrapErr{msg: fmt.Sprintf("could not read issue %s: %s", ident, l.errText(err)), err: err})
		return
	}
	out, err := l.linkIssue(ctx, th, is, req.IncludeBody)
	if err != nil {
		storeError(w, err)
		return
	}
	writeJSON(w, 200, l.view(out))
}

// linkIssue stores the thread's link to the issue (keeping what was learned when it is the same
// issue again), records the comments that exist now as seen, and starts the first sync. The
// create flow uses it too, so a created issue is linked exactly like a pasted one.
func (l *linearSvc) linkIssue(ctx context.Context, th *store.Thread, is *linear.Issue, includeBody *bool) (*store.ThreadLink, error) {
	s, id := l.s, th.ID
	lk := &store.ThreadLink{ThreadID: id, IssueID: is.ID, Identifier: is.Identifier, URL: is.URL, Title: is.Title, State: is.State,
		StateType: is.StateType, Assignee: is.Assignee, TeamID: is.TeamID, TeamName: is.TeamName, IncludeBody: includeBody}
	if old, err := s.store.GetThreadLink(ctx, id); err == nil && old.IssueID == lk.IssueID {
		// The same issue again: keep what was learned (the progress comment, the seen comments).
		cp := *old
		cp.Title, cp.State, cp.StateType, cp.Assignee, cp.URL = lk.Title, lk.State, lk.StateType, lk.Assignee, lk.URL
		if includeBody != nil {
			cp.IncludeBody = includeBody
		}
		lk = &cp
	}
	l.linkMu.Lock()
	err := s.store.PutThreadLink(ctx, lk)
	l.linkMu.Unlock()
	if err != nil {
		return nil, err
	}
	// Baseline: what is on the issue now is not news. Best effort; the first sync retries it.
	if !lk.Baselined {
		if cs, err := l.listComments(ctx, lk); err == nil {
			l.updateLink(ctx, id, func(k *store.ThreadLink) { l.baseline(k, cs) })
		}
	}
	s.publishThread(th.SessionID, id)
	go l.threadChanged(id)
	return s.store.GetThreadLink(ctx, id)
}

func (l *linearSvc) view(k *store.ThreadLink) *store.ThreadLink {
	if k == nil {
		return nil
	}
	l.mu.Lock()
	k.Syncing = l.syncing[k.ThreadID]
	l.mu.Unlock()
	k.LastError = l.scrub(context.Background(), k.LastError)
	return k
}

func (s *Server) getThreadLinear(w http.ResponseWriter, r *http.Request) {
	k, err := s.store.GetThreadLink(r.Context(), r.PathValue("id"))
	if errors.Is(err, store.ErrNotFound) {
		writeJSON(w, 200, map[string]any{"link": nil})
		return
	}
	if err != nil {
		storeError(w, err)
		return
	}
	writeJSON(w, 200, map[string]any{"link": s.lin.view(k)})
}

func (s *Server) deleteThreadLinear(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	th, err := s.store.GetThread(r.Context(), id)
	if err != nil {
		storeError(w, err)
		return
	}
	if err := s.store.DeleteThreadLink(r.Context(), id); err != nil {
		storeError(w, err)
		return
	}
	s.lin.dropTimer(id)
	s.publishThread(th.SessionID, id)
	writeJSON(w, 200, map[string]bool{"ok": true})
}

// refreshThreadLinear: the thread was opened (or the person asked): sync the issue in the
// background. 202 when a sync started; 200 with started=false when it was skipped.
func (s *Server) refreshThreadLinear(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if _, err := s.store.GetThreadLink(r.Context(), id); err != nil {
		storeError(w, err)
		return
	}
	started, why := s.lin.refresh(id, r.URL.Query().Get("force") == "1")
	code := 200
	if started {
		code = 202
	}
	writeJSON(w, code, map[string]any{"started": started, "skipped": why})
}

// updateLink: read-modify-write of a link under the link lock.
func (l *linearSvc) updateLink(ctx context.Context, threadID string, fn func(k *store.ThreadLink)) *store.ThreadLink {
	l.linkMu.Lock()
	defer l.linkMu.Unlock()
	k, err := l.s.store.GetThreadLink(ctx, threadID)
	if err != nil {
		return nil
	}
	fn(k)
	if err := l.s.store.PutThreadLink(ctx, k); err != nil {
		log.Printf("linear: saving link of %s: %v", threadID, err)
	}
	return k
}

// ---- settings ----

type linearSettings struct {
	AuthorFilter string   // "everyone" | "allow_list"
	Allowed      []string // names, emails or ids
	IncludeBody  bool
	ThreadLink   bool   // the drafted issue description ends with a link to the minbox thread
	DraftExtra   string // the person's extra instructions for the Create-issue auto-fill (cleaned, capped)
}

func defaultLinearSettings() map[string]any {
	return map[string]any{"author_filter": "everyone", "allowed_authors": "", "include_body": false, "thread_link": false, "draft_extra_prompt": ""}
}

// normalizeLinearSettings validates the "linear" setting (a JSON object) and returns it cleaned.
func normalizeLinearSettings(raw json.RawMessage) (json.RawMessage, error) {
	var in map[string]any
	if json.Unmarshal(raw, &in) != nil {
		return nil, errors.New("linear must be an object")
	}
	out := defaultLinearSettings()
	for k, v := range in {
		if _, ok := out[k]; !ok {
			return nil, errors.New("unknown linear setting " + k)
		}
		switch k {
		case "author_filter":
			s, _ := v.(string)
			if s != "everyone" && s != "allow_list" {
				return nil, errors.New("author_filter must be everyone or allow_list")
			}
			out[k] = s
		case "allowed_authors":
			s, ok := v.(string)
			if !ok || len(s) > 4000 {
				return nil, errors.New("allowed_authors must be a string (names, emails or ids; comma or line separated)")
			}
			out[k] = s
		case "draft_extra_prompt":
			x, ok := v.(string)
			if !ok || len([]rune(x)) > draftExtraMax {
				return nil, fmt.Errorf("draft_extra_prompt must be a string of at most %d characters", draftExtraMax)
			}
			out[k] = cleanDraftExtra(x)
		case "include_body", "thread_link":
			b, ok := v.(bool)
			if !ok {
				return nil, errors.New(k + " must be true or false")
			}
			out[k] = b
		}
	}
	b, _ := json.Marshal(out)
	return b, nil
}

func (s *Server) linearSettings(ctx context.Context) linearSettings {
	ls := linearSettings{AuthorFilter: "everyone"}
	st, err := s.settings(ctx)
	if err != nil {
		return ls
	}
	m, _ := st["linear"].(map[string]any)
	if f, _ := m["author_filter"].(string); f == "allow_list" {
		ls.AuthorFilter = f
	}
	if a, _ := m["allowed_authors"].(string); a != "" {
		for _, p := range strings.FieldsFunc(a, func(r rune) bool { return r == ',' || r == '\n' || r == ';' }) {
			if p = strings.ToLower(strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(p), "@"))); p != "" {
				ls.Allowed = append(ls.Allowed, p)
			}
		}
	}
	ls.IncludeBody, _ = m["include_body"].(bool)
	ls.ThreadLink, _ = m["thread_link"].(bool)
	x, _ := m["draft_extra_prompt"].(string)
	ls.DraftExtra = cleanDraftExtra(x)
	return ls
}

// authorAllowed applies the comment-author filter.
func (ls linearSettings) authorAllowed(c linear.Comment) bool {
	if ls.AuthorFilter != "allow_list" {
		return true
	}
	for _, a := range ls.Allowed {
		for _, v := range []string{c.Author, c.AuthorEmail, c.AuthorID} {
			if v != "" && strings.EqualFold(strings.TrimSpace(v), a) {
				return true
			}
		}
	}
	return false
}
