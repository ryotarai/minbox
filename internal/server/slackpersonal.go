package server

import (
	"context"
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/ryotarai/minbox/internal/slackuser"
)

// The personal Slack integration ("Slack" screen above My issues): the person's own Slack USER token
// (xoxp-…) lists the threads and DMs that need their reply. This file is the settings side: the
// stored token, test, disconnect, status and diagnostics. See docs/slack-personal.md. It is
// separate from the bot-token notification destination (internal/notify).
//
// The token is read access to the person's private messages: read scopes only, kept in the store
// (never sent to the browser or an agent), scrubbed from every error and log line. Nothing is ever
// posted to Slack and nothing is marked read.

const (
	slackBackendAuto   = "auto"
	slackBackendRTS    = "rts"
	slackBackendLegacy = "legacy"
	slackFallbackFor   = 30 * time.Minute // after an RTS failure that means "not for this app", auto uses the legacy search for this long
)

// Scopes (user token scopes).
var (
	slackHistoryScopes = []string{"channels:history", "groups:history", "im:history", "users:read"}
	slackRTSScopes     = []string{"search:read.public", "search:read.private", "search:read.im"}
	slackLegacyScopes  = []string{"search:read"}
	slackOptionalScope = []string{"im:read"} // unread dots of DMs
)

type slackUserAuth struct {
	Token       string    `json:"token"`
	UserID      string    `json:"user_id"`
	User        string    `json:"user"`
	TeamID      string    `json:"team_id"`
	Team        string    `json:"team"`
	URL         string    `json:"url"`
	Scopes      []string  `json:"scopes"`
	ScopesKnown bool      `json:"scopes_known"`
	Backend     string    `json:"backend"`
	ConnectedAt time.Time `json:"connected_at"`
	// FallbackReason: why auto mode currently uses the legacy search ("" none), since FallbackAt.
	FallbackReason string    `json:"fallback_reason,omitempty"`
	FallbackAt     time.Time `json:"fallback_at,omitempty"`
	LastTest       string    `json:"last_test,omitempty"`
	LastTestOK     bool      `json:"last_test_ok,omitempty"`
	LastTestAt     time.Time `json:"last_test_at,omitempty"`
}

type slackSvc struct {
	s    *Server
	base string
	cl   *slackuser.Client
	now  func() time.Time

	authMu sync.Mutex
	tokMu  sync.RWMutex
	tok    string
	tokSet bool

	// the thread pipeline (slackpipeline.go)
	mu          sync.Mutex
	flight      *slackFlight
	lastRefresh time.Time
	prog        slackProgress
	notes       []string
	threads     map[string]*slackThreadData
	users       map[string]slackUserEntry
	loaded      bool // the persisted threads and names were loaded (slackpersist.go)
	// judgeRun runs the helper for a judgement prompt (replaced in tests).
	judgeRun func(ctx context.Context, prompt string) ([]byte, error)

	threadTTL     time.Duration // a cached thread younger than this is not fetched again
	debounce      time.Duration // a refresh within this of the last one is answered from the cache
	userTTL       time.Duration
	maxCandidates int
	maxCalls      int
	searchPages   int
	days          int
	judgeBatch    int
	judgeParallel int
	judgeTimeout  time.Duration
	scopeNoted    map[string]bool
}

func newSlackSvc(s *Server) *slackSvc {
	l := &slackSvc{
		s: s, base: slackuser.BaseFromEnv(os.Getenv("MINBOX_SLACK_API_URL")), now: time.Now,
		threads: map[string]*slackThreadData{}, users: map[string]slackUserEntry{},
		threadTTL: 5 * time.Minute, debounce: 15 * time.Second, userTTL: 6 * time.Hour,
		maxCandidates: 30, maxCalls: 80, searchPages: 2, days: 7, judgeBatch: 4, judgeParallel: 2, judgeTimeout: 90 * time.Second,
		scopeNoted: map[string]bool{},
	}
	l.judgeRun = func(ctx context.Context, prompt string) ([]byte, error) {
		return s.runHelper(ctx, s.pickModel(), slackJudgeSystem, slackJudgeSchema, prompt)
	}
	l.cl = slackuser.NewClient(l.base, l.token)
	return l
}

// token is the Client's token source.
func (l *slackSvc) token() string {
	l.tokMu.RLock()
	if l.tokSet {
		defer l.tokMu.RUnlock()
		return l.tok
	}
	l.tokMu.RUnlock()
	if a := l.loadAuth(context.Background()); a != nil {
		return a.Token
	}
	return ""
}

func (l *slackSvc) setTokenCache(t string) {
	l.tokMu.Lock()
	l.tok, l.tokSet = t, true
	l.tokMu.Unlock()
}

func (l *slackSvc) loadAuth(ctx context.Context) *slackUserAuth {
	raw, err := l.s.store.SlackUserAuth(ctx)
	if err != nil || raw == "" {
		return nil
	}
	var a slackUserAuth
	if json.Unmarshal([]byte(raw), &a) != nil || a.Token == "" {
		return nil
	}
	if a.Backend == "" {
		a.Backend = slackBackendAuto
	}
	return &a
}

func (l *slackSvc) saveAuth(ctx context.Context, a *slackUserAuth) error {
	b, _ := json.Marshal(a)
	l.setTokenCache(a.Token)
	return l.s.store.SetSlackUserAuth(ctx, string(b))
}

func (l *slackSvc) updateAuth(ctx context.Context, fn func(a *slackUserAuth)) *slackUserAuth {
	l.authMu.Lock()
	defer l.authMu.Unlock()
	a := l.loadAuth(ctx)
	if a == nil {
		return nil
	}
	fn(a)
	if err := l.saveAuth(ctx, a); err != nil {
		log.Printf("slack (personal): saving the login: %v", l.scrub(err.Error()))
	}
	return a
}

// scrub removes the token (and anything token-shaped) from s.
func (l *slackSvc) scrub(s string) string { return slackuser.Scrub(s, l.token()) }

var errSlackNotConnected = errors.New("Slack is not connected: Settings → Integrations → Slack (personal) → paste your user token")

// ---- scopes ----

func contains(l []string, s string) bool {
	for _, x := range l {
		if x == s {
			return true
		}
	}
	return false
}

// searchScopesOK: whether the granted scopes allow the search of the backend.
func searchScopesOK(backend string, granted []string) bool {
	switch backend {
	case slackBackendRTS:
		for _, s := range slackRTSScopes[:1] { // search:read.public is the one every RTS call needs
			if !contains(granted, s) {
				return false
			}
		}
		return true
	default:
		return contains(granted, "search:read")
	}
}

// missingScopes: the scopes the chosen backend needs that the token's header did not list.
func missingScopes(a *slackUserAuth) []string {
	if !a.ScopesKnown {
		return nil
	}
	var miss []string
	need := append([]string{}, slackHistoryScopes...)
	switch a.Backend {
	case slackBackendRTS:
		need = append(need, slackRTSScopes...)
	case slackBackendLegacy:
		need = append(need, slackLegacyScopes...)
	default: // auto: either search flavour will do
		if !searchScopesOK(slackBackendRTS, a.Scopes) && !searchScopesOK(slackBackendLegacy, a.Scopes) {
			need = append(need, slackRTSScopes...)
		}
	}
	for _, s := range need {
		if !contains(a.Scopes, s) {
			miss = append(miss, s)
		}
	}
	return miss
}

// effectiveBackend: the search flavour to try first.
func (l *slackSvc) effectiveBackend(a *slackUserAuth) (backend, note string) {
	switch a.Backend {
	case slackBackendRTS, slackBackendLegacy:
		return a.Backend, ""
	}
	if a.ScopesKnown && !searchScopesOK(slackBackendRTS, a.Scopes) && searchScopesOK(slackBackendLegacy, a.Scopes) {
		return slackBackendLegacy, "Using the legacy search.messages: the token has search:read but not the search:read.* scopes of the Real-time Search API."
	}
	if a.FallbackReason != "" && l.now().Sub(a.FallbackAt) < slackFallbackFor {
		return slackBackendLegacy, "Using the legacy search.messages because the Real-time Search API failed: " + a.FallbackReason
	}
	return slackBackendRTS, ""
}

// ---- status ----

type slackStatus struct {
	Connected     bool              `json:"connected"`
	TokenMasked   string            `json:"token_masked,omitempty"`
	UserID        string            `json:"user_id,omitempty"`
	User          string            `json:"user,omitempty"`
	TeamID        string            `json:"team_id,omitempty"`
	Team          string            `json:"team,omitempty"`
	TeamURL       string            `json:"team_url,omitempty"`
	ConnectedAt   *time.Time        `json:"connected_at,omitempty"`
	Backend       string            `json:"search_backend"`
	BackendUsed   string            `json:"search_backend_used,omitempty"`
	BackendNote   string            `json:"search_backend_note,omitempty"`
	Scopes        []string          `json:"scopes"`
	ScopesKnown   bool              `json:"scopes_known"`
	Missing       []string          `json:"missing_scopes"`
	Optional      []string          `json:"optional_scopes"`
	OptionalMiss  []string          `json:"optional_missing"`
	LastTest      string            `json:"last_test,omitempty"`
	LastTestOK    bool              `json:"last_test_ok"`
	LastTestAt    *time.Time        `json:"last_test_at,omitempty"`
	Diag          slackuser.Diag    `json:"diagnostics"`
	Days          int               `json:"days"`
	MaxCandidates int               `json:"max_candidates"`
	Unverified    []string          `json:"unverified"`
	Refresh       slackProgressView `json:"refresh"`
}

func maskToken(t string) string {
	if len(t) < 10 {
		return "…"
	}
	return t[:5] + "…" + t[len(t)-4:]
}

func tpp(t time.Time) *time.Time {
	if t.IsZero() {
		return nil
	}
	return &t
}

// slackUnverified: facts the Slack documentation does not settle; the UI Details lists them.
var slackUnverified = []string{
	"Real-time Search (assistant.search.context): that a plain internal app with a user token may call it without the Agents & AI feature (the docs say internal apps and user tokens are allowed; not tried against a live workspace).",
	"Real-time Search: query syntax for mentions (<@U…>), DMs (to:…) and my own messages (from:…) is assumed to follow the search.messages operators.",
	"Search results carry no thread_ts: the thread is read from the permalink, else the message is treated as a thread root.",
	"search.messages: no deprecation date was found; the docs call it legacy.",
	"The 2025 rate limit of 1 request per minute for conversations.history/replies applies to distributed non-Marketplace apps; an internal app is documented as exempt (Tier 3).",
}

func (l *slackSvc) status(ctx context.Context) slackStatus {
	st := slackStatus{Scopes: []string{}, Missing: []string{}, Optional: slackOptionalScope, OptionalMiss: []string{}, Backend: slackBackendAuto, Unverified: slackUnverified,
		Days: l.days, MaxCandidates: l.maxCandidates, Diag: l.cl.Diagnostics(), Refresh: l.progressView()}
	a := l.loadAuth(ctx)
	if a == nil {
		return st
	}
	st.Connected = true
	st.TokenMasked = maskToken(a.Token)
	st.UserID, st.User, st.TeamID, st.Team, st.TeamURL = a.UserID, a.User, a.TeamID, a.Team, a.URL
	st.ConnectedAt = tpp(a.ConnectedAt)
	st.Backend = a.Backend
	st.BackendUsed, st.BackendNote = l.effectiveBackend(a)
	st.ScopesKnown = a.ScopesKnown
	if a.Scopes != nil {
		st.Scopes = a.Scopes
	}
	if m := missingScopes(a); m != nil {
		st.Missing = m
	}
	if a.ScopesKnown {
		for _, s := range slackOptionalScope {
			if !contains(a.Scopes, s) {
				st.OptionalMiss = append(st.OptionalMiss, s)
			}
		}
	}
	st.LastTest, st.LastTestOK, st.LastTestAt = a.LastTest, a.LastTestOK, tpp(a.LastTestAt)
	return st
}

// validUserToken: a user token (xoxp-…). Rotation tokens (xoxe.xoxp-…) expire after 12 hours and
// are not supported.
func validUserToken(t string) error {
	switch {
	case strings.HasPrefix(t, "xoxb-"):
		return errors.New("that is a bot token (xoxb-…): paste the User OAuth Token (xoxp-…) from OAuth & Permissions")
	case strings.HasPrefix(t, "xoxe."):
		return errors.New("token rotation is not supported: turn token rotation off in the app (or use an app without it) and paste the non-expiring User OAuth Token (xoxp-…)")
	case strings.HasPrefix(t, "xapp-"):
		return errors.New("that is an app-level token (xapp-…): paste the User OAuth Token (xoxp-…)")
	case !strings.HasPrefix(t, "xoxp-"):
		return errors.New("a Slack user token starts with xoxp-")
	case len(t) < 20 || len(t) > 400 || strings.ContainsAny(t, " \t\r\n\"'"):
		return errors.New("that does not look like a complete user token")
	}
	return nil
}

// slackTestResult is what Test and Connect answer.
type slackTestResult struct {
	OK      bool     `json:"ok"`
	Message string   `json:"message"`
	Error   string   `json:"error,omitempty"`
	Code    string   `json:"code,omitempty"`
	Missing []string `json:"missing_scopes,omitempty"`
	Search  string   `json:"search,omitempty"` // how the candidate search fared
}

// verify runs auth.test with the token in the client (the token must already be set) and probes the search.
func (l *slackSvc) verify(ctx context.Context, backend string) (*slackuser.Auth, slackTestResult) {
	au, err := l.cl.AuthTest(ctx)
	if err != nil {
		return nil, slackTestResult{Error: err.Msg, Code: err.Code, Message: err.Msg}
	}
	tmp := &slackUserAuth{Scopes: au.Scopes, ScopesKnown: au.ScopesKnown, Backend: backend}
	res := slackTestResult{OK: true, Missing: missingScopes(tmp)}
	res.Message = "Connected as " + firstNonEmpty(au.User, au.UserID) + " in " + firstNonEmpty(au.Team, au.TeamID)
	if au.ScopesKnown {
		res.Message += ". Scopes: " + strings.Join(au.Scopes, ", ")
	} else {
		res.Message += ". (Slack did not list the token's scopes.)"
	}
	if len(res.Missing) > 0 {
		res.Message += ". Missing: " + strings.Join(res.Missing, ", ") + " (add under OAuth & Permissions → User Token Scopes, reinstall, paste the new token)"
	}
	res.Search = l.probeSearch(ctx, au, backend)
	return au, res
}

// probeSearch makes one search call so that the Test says whether the candidate search works.
func (l *slackSvc) probeSearch(ctx context.Context, au *slackuser.Auth, backend string) string {
	try := func(b string) *slackuser.APIError {
		if b == slackBackendLegacy {
			_, _, err := l.cl.SearchLegacy(ctx, "<@"+au.UserID+">", 1, 1)
			return err
		}
		_, _, err := l.cl.SearchRTS(ctx, slackuser.RTSQuery{Query: "<@" + au.UserID + ">", ChannelTypes: []string{"public_channel"}, Limit: 1})
		return err
	}
	first := backend
	if first == slackBackendAuto {
		first = slackBackendRTS
	}
	err := try(first)
	if err == nil {
		return "The " + backendLabel(first) + " search works."
	}
	msg := "The " + backendLabel(first) + " search failed: " + err.Msg
	if backend == slackBackendAuto && first == slackBackendRTS && rtsFallbackCode(err) {
		if err2 := try(slackBackendLegacy); err2 == nil {
			return msg + " Falling back to the legacy search.messages, which works."
		} else {
			return msg + " The legacy search.messages failed too: " + err2.Msg
		}
	}
	return msg
}

func backendLabel(b string) string {
	if b == slackBackendLegacy {
		return "legacy search.messages"
	}
	return "Real-time Search (assistant.search.context)"
}

// rtsFallbackCode: an RTS failure that says "this app/token cannot use it" (auto mode then falls back).
func rtsFallbackCode(err *slackuser.APIError) bool {
	switch err.Code {
	case "unknown_method", "method_not_found", "not_allowed_token_type", "not_allowed", "access_denied", "no_permission", "missing_scope",
		"invalid_action_token", "missing_action_token", "assistant_search_context_disabled", "feature_not_enabled", "method_deprecated", "restricted_action", "invalid_arguments", "app_not_approved":
		return true
	}
	return err.Status == 404
}

// ---- HTTP ----

func (s *Server) slackUserStatus(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, 200, s.slack.status(r.Context()))
}

type slackPutReq struct {
	Token   *string `json:"token"`
	Backend *string `json:"search_backend"`
}

// PUT /api/integrations/slack-user: set the token (it is verified with auth.test first; a token that
// fails is not stored) and/or the search backend.
func (s *Server) slackUserPut(w http.ResponseWriter, r *http.Request) {
	l := s.slack
	ctx := r.Context()
	var req slackPutReq
	if !decode(w, r, &req) {
		return
	}
	if req.Backend != nil {
		switch *req.Backend {
		case slackBackendAuto, slackBackendRTS, slackBackendLegacy:
		default:
			httpError(w, 400, "search_backend must be auto, rts or legacy")
			return
		}
		if a := l.updateAuth(ctx, func(a *slackUserAuth) {
			a.Backend = *req.Backend
			a.FallbackReason, a.FallbackAt = "", time.Time{}
		}); a == nil && req.Token == nil {
			httpError(w, 409, errSlackNotConnected.Error())
			return
		}
	}
	if req.Token != nil {
		tok := strings.TrimSpace(*req.Token)
		if err := validUserToken(tok); err != nil {
			httpError(w, 400, err.Error())
			return
		}
		prev := l.loadAuth(ctx)
		backend := slackBackendAuto
		if prev != nil {
			backend = prev.Backend
		}
		if req.Backend != nil {
			backend = *req.Backend
		}
		// The token goes to the client only for this test; it is stored when auth.test accepts it.
		l.setTokenCache(tok)
		l.cl.ResetDiagnostics()
		au, res := l.verify(ctx, backend)
		if au == nil {
			if prev != nil {
				l.setTokenCache(prev.Token)
			} else {
				l.setTokenCache("")
			}
			writeJSON(w, 200, map[string]any{"result": res, "status": l.status(ctx)})
			return
		}
		a := &slackUserAuth{Token: tok, UserID: au.UserID, User: au.User, TeamID: au.TeamID, Team: au.Team, URL: au.URL, Scopes: au.Scopes, ScopesKnown: au.ScopesKnown,
			Backend: backend, ConnectedAt: l.now(), LastTest: res.Message, LastTestOK: res.OK, LastTestAt: l.now()}
		l.authMu.Lock()
		err := l.saveAuth(ctx, a)
		l.authMu.Unlock()
		if err != nil {
			storeError(w, err)
			return
		}
		l.forgetCaches()
		s.hub.publish(Event{Type: "slack"})
		writeJSON(w, 200, map[string]any{"result": res, "status": l.status(ctx)})
		return
	}
	s.hub.publish(Event{Type: "slack"})
	writeJSON(w, 200, map[string]any{"status": l.status(ctx)})
}

// POST /api/integrations/slack-user/test
func (s *Server) slackUserTest(w http.ResponseWriter, r *http.Request) {
	l := s.slack
	ctx := r.Context()
	a := l.loadAuth(ctx)
	if a == nil {
		httpError(w, 409, errSlackNotConnected.Error())
		return
	}
	au, res := l.verify(ctx, a.Backend)
	l.updateAuth(ctx, func(a *slackUserAuth) {
		a.LastTest, a.LastTestOK, a.LastTestAt = res.Message, res.OK, l.now()
		if au != nil {
			a.UserID, a.User, a.TeamID, a.Team, a.URL = au.UserID, au.User, au.TeamID, au.Team, au.URL
			a.Scopes, a.ScopesKnown = au.Scopes, au.ScopesKnown
		}
	})
	writeJSON(w, 200, map[string]any{"result": res, "status": l.status(ctx)})
}

// POST /api/integrations/slack-user/disconnect: forgets the token and every cached judgement and thread.
func (s *Server) slackUserDisconnect(w http.ResponseWriter, r *http.Request) {
	l := s.slack
	ctx := r.Context()
	if err := s.store.DeleteSlackUserAuth(ctx); err != nil {
		storeError(w, err)
		return
	}
	_ = s.store.DeleteSlackItems(ctx)
	l.setTokenCache("")
	l.cl.ResetDiagnostics()
	l.forgetCaches()
	s.hub.publish(Event{Type: "slack"})
	writeJSON(w, 200, l.status(ctx))
}

// POST /api/integrations/slack-user/clear-cache: judgements, list views and the in-memory thread cache.
func (s *Server) slackUserClearCache(w http.ResponseWriter, r *http.Request) {
	l := s.slack
	if err := s.store.ClearSlackCache(r.Context()); err != nil {
		storeError(w, err)
		return
	}
	l.forgetCaches()
	s.hub.publish(Event{Type: "slack"})
	writeJSON(w, 200, l.status(r.Context()))
}

func (l *slackSvc) forgetCaches() {
	l.mu.Lock()
	l.threads = map[string]*slackThreadData{}
	l.users = map[string]slackUserEntry{}
	l.loaded = true // the database rows were deleted by the caller
	l.lastRefresh = time.Time{}
	l.notes = nil
	l.scopeNoted = map[string]bool{}
	l.mu.Unlock()
}
