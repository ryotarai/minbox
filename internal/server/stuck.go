package server

import (
	"context"
	"log"
	"os"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/ryotarai/minbox/internal/store"
)

// A stuck agent: its process runs, but it waits for something in its terminal that minbox cannot
// answer, so the person's messages go nowhere. Claude Code at its start may ask whether to trust the
// folder, to log in, for an API key, to pick a theme or a model, to update; any agent may show an
// error screen. Until that is answered the integration never says hello, or never takes the
// person's message. A model that does not exist (or a key that is refused) gets further: the mod
// connects and takes the message, and every turn dies at once on an API error.
//
// The server judges it from what it already sees (no new traffic from the integrations):
//
//	startup  the process was started (spawn, restart) and the integration has not said hello within
//	         stuckStartupAfter (status stays "starting" until the hello)
//	message  a message to the agent has not been taken (delivered) for stuckMessageAfter, counted
//	         from when it was written or the agent last became idle, whichever is later, while the
//	         agent is not in a turn
//	error    the agent's last turn ended on an API error (turn.complete reason "error", or Claude
//	         Code's StopFailure forwarded as turn.error) and it has not completed a turn normally or
//	         posted a message since
//
// A third rule, "working but no progress", is left out on purpose: nothing the server sees tells a
// long tool run apart from a hung one (the heartbeat is a timer of the mod's, and tool calls of the
// agent's own tools never reach minbox), so it would raise false alarms during legitimate work.
//
// Shells and ended agents are never stuck. The state clears as soon as what it waits for happens:
// a hello, a delivered message, a normal turn, a posted message. While stuck, the last screen of the
// agent's terminal (the host's scrollback tail, local or remote) is read now and then for a hint: the
// last line matching a known prompt or error, cleaned and cut to 200 characters.
//
// The browser gets stuck / stuck_since / stuck_hint on the agent (GET /api/sessions) and a
// "sessions" event when any of them changes.

const (
	// stuckStartupDefault: no hello this long after a start.
	stuckStartupDefault = 20 * time.Second
	// stuckMessageDefault: a message not taken this long while the agent is not in a turn.
	stuckMessageDefault = 30 * time.Second
	// stuckTickMax: the watch looks at least this often (more often for shorter thresholds).
	stuckTickMax = 2 * time.Second
	// stuckHintEvery: a stuck agent's screen is read again after this long.
	stuckHintEvery = 5 * time.Second
	// stuckTailBytes: how much of the terminal's output the hint is looked for in.
	stuckTailBytes = 16 << 10
	// stuckHintMax: the longest hint, in characters.
	stuckHintMax = 200
)

// Stuck kinds, as the browser gets them.
const (
	stuckStartup = "startup"
	stuckMessage = "message"
	stuckError   = "error"
)

// stuckState is what the server keeps per agent for the stuck judgement.
type stuckState struct {
	spawnedAt time.Time // the last start (or restart) of the agent's process
	idleSince time.Time // when the agent last became idle: a message waits from then at the earliest
	errAt     time.Time // the last turn ended on an API error (zero: none since a normal turn)
	errKind   string    // the error's class, when the integration said (model_not_found, ...)
	// What was judged last (and published).
	kind   string
	since  time.Time
	hint   string
	hintAt time.Time
}

// durationFromEnv reads a number of seconds from an environment variable (tests shorten thresholds).
func durationFromEnv(name string, def time.Duration) time.Duration {
	if n, err := strconv.ParseFloat(os.Getenv(name), 64); err == nil && n > 0 {
		return time.Duration(n * float64(time.Second))
	}
	return def
}

// stuckLocked returns the agent's record, creating it. stuckMu must be held.
func (s *Server) stuckLocked(id string) *stuckState {
	st := s.stuck[id]
	if st == nil {
		st = &stuckState{}
		s.stuck[id] = st
	}
	return st
}

func (s *Server) stuckUpdate(id string, f func(st *stuckState)) {
	s.stuckMu.Lock()
	f(s.stuckLocked(id))
	s.stuckMu.Unlock()
	s.stuckKick()
}

// stuckSpawned: the agent's process was (re)started; what was judged of the old one is gone.
func (s *Server) stuckSpawned(id string) {
	now := s.nowFn()
	s.stuckUpdate(id, func(st *stuckState) { *st = stuckState{spawnedAt: now, idleSince: now} })
}

// stuckIdle: the agent became idle (a message may wait from now).
func (s *Server) stuckIdle(id string) {
	now := s.nowFn()
	s.stuckUpdate(id, func(st *stuckState) { st.idleSince = now })
}

// stuckTurnError: a turn ended on an API error (kind: its class, "" when not known).
func (s *Server) stuckTurnError(id, kind string) {
	now := s.nowFn()
	s.stuckUpdate(id, func(st *stuckState) {
		if st.errAt.IsZero() {
			st.errAt = now
		}
		if kind != "" {
			st.errKind = truncate(kind, 40)
		}
	})
}

// stuckReplied: a turn completed normally, or the agent posted a message: no error stands.
func (s *Server) stuckReplied(id string) {
	s.stuckMu.Lock()
	st := s.stuck[id]
	had := st != nil && !st.errAt.IsZero()
	if had {
		st.errAt, st.errKind = time.Time{}, ""
	}
	s.stuckMu.Unlock()
	if had {
		s.stuckKick()
	}
}

// stuckKick asks the watch for a pass now (a hello, a delivery: the state may have cleared).
func (s *Server) stuckKick() {
	select {
	case s.stuckWake <- struct{}{}:
	default:
	}
}

// runStuck is the watch: a pass every tick, and at once when kicked.
func (s *Server) runStuck() {
	tick := min(stuckTickMax, s.stuckStartupAfter/4, s.stuckMessageAfter/4)
	tick = max(tick, 100*time.Millisecond)
	t := time.NewTicker(tick)
	defer t.Stop()
	for {
		select {
		case <-s.closing:
			return
		case <-t.C:
		case <-s.stuckWake:
		}
		s.stuckPass(context.Background())
	}
}

// stuckOf judges one agent at now. oldest: when its oldest message not taken yet was written (zero:
// none). stuckMu and modMu must not be held.
func (s *Server) stuckOf(sess *store.Session, oldest, now time.Time) (kind string, since time.Time) {
	if sess.Kind != store.KindClaude || sess.Status == store.StatusEnded || sess.ArchivedAt != nil {
		return "", time.Time{}
	}
	s.modMu.Lock()
	var contact time.Time
	modWorking := false
	if c := s.modConns[sess.ID]; c != nil {
		contact = c.lastContact
		modWorking = c.modState == store.StatusWorking && !c.stale
	}
	s.modMu.Unlock()
	s.stuckMu.Lock()
	var st stuckState
	if p := s.stuck[sess.ID]; p != nil {
		st = *p
	}
	s.stuckMu.Unlock()

	if sess.Status == store.StatusStarting {
		ref := st.spawnedAt
		if ref.IsZero() || ref.Before(s.startedAt) {
			ref = s.startedAt // started before this server: counted from the server's start
		}
		if contact.After(ref) {
			return "", time.Time{} // the integration is talking: its hello is on the way
		}
		if at := ref.Add(s.stuckStartupAfter); now.After(at) {
			return stuckStartup, at
		}
		return "", time.Time{}
	}
	if !st.errAt.IsZero() {
		return stuckError, st.errAt
	}
	if oldest.IsZero() || sess.Status == store.StatusWorking || modWorking {
		return "", time.Time{}
	}
	from := oldest
	for _, t := range []time.Time{st.idleSince, s.startedAt} {
		if t.After(from) {
			from = t
		}
	}
	if at := from.Add(s.stuckMessageAfter); now.After(at) {
		return stuckMessage, at
	}
	return "", time.Time{}
}

// stuckPass judges every agent, reads hints for the stuck ones, and publishes what changed.
func (s *Server) stuckPass(ctx context.Context) {
	sessions, err := s.store.SessionRows(ctx)
	if err != nil {
		return
	}
	oldest, err := s.store.OldestUndelivered(ctx)
	if err != nil {
		return
	}
	now := s.nowFn()
	changed := false
	var hintFor []store.Session
	live := map[string]bool{}
	for i := range sessions {
		sess := &sessions[i]
		live[sess.ID] = true
		kind, since := s.stuckOf(sess, oldest[sess.ID], now)
		s.stuckMu.Lock()
		st := s.stuck[sess.ID]
		if st == nil && kind == "" {
			s.stuckMu.Unlock()
			continue
		}
		st = s.stuckLocked(sess.ID)
		if st.kind != kind {
			if kind != "" {
				log.Printf("stuck: session=%s kind=%s since=%s", sess.ID, kind, since.UTC().Format(time.RFC3339))
			} else {
				log.Printf("stuck: session=%s cleared (was %s)", sess.ID, st.kind)
			}
			st.kind, st.since = kind, since
			if kind == "" || st.hint == "" {
				st.hint, st.hintAt = "", time.Time{}
			}
			changed = true
		}
		if kind != "" && now.Sub(st.hintAt) >= stuckHintEvery {
			st.hintAt = now
			hintFor = append(hintFor, *sess)
		}
		s.stuckMu.Unlock()
	}
	s.stuckMu.Lock()
	for id := range s.stuck {
		if !live[id] {
			delete(s.stuck, id)
		}
	}
	s.stuckMu.Unlock()
	for i := range hintFor {
		sess := &hintFor[i]
		hint := ""
		if s.stuckTail != nil {
			tctx, cancel := context.WithTimeout(ctx, 3*time.Second)
			if b, err := s.stuckTail(tctx, sess); err == nil {
				hint = screenHint(b)
			}
			cancel()
		}
		s.stuckMu.Lock()
		st := s.stuck[sess.ID]
		if st != nil && st.kind != "" {
			if hint == "" && st.kind == stuckError && st.errKind != "" {
				hint = errKindHint(st.errKind)
			}
			if hint != st.hint {
				st.hint = hint
				changed = true
			}
		}
		s.stuckMu.Unlock()
	}
	if changed {
		s.hub.publish(Event{Type: "sessions"})
	}
}

// withStuck fills stuck, stuck_since and stuck_hint of an agent for the browser.
func (s *Server) withStuck(sess *store.Session) {
	s.stuckMu.Lock()
	defer s.stuckMu.Unlock()
	st := s.stuck[sess.ID]
	if st == nil || st.kind == "" || sess.Kind != store.KindClaude || sess.Status == store.StatusEnded {
		return
	}
	sess.Stuck = st.kind
	t := st.since
	sess.StuckSince = &t
	sess.StuckHint = st.hint
}

// tail reads the end of the agent's terminal output from its host ("" when the host cannot say).
func (m *sessionManager) tail(ctx context.Context, sess *store.Session) ([]byte, error) {
	h, err := m.hostOf(sess)
	if err != nil {
		return nil, err
	}
	t, ok := h.(interface {
		Tail(ctx context.Context, id string, n int) ([]byte, error)
	})
	if !ok {
		return nil, errNoTail
	}
	return t.Tail(ctx, sess.ID, stuckTailBytes)
}

type tailError string

func (e tailError) Error() string { return string(e) }

const errNoTail = tailError("the host does not give its terminals' output")

// ---- the hint ----

var (
	// OSC (titles, links): up to BEL or ST.
	reOSC = regexp.MustCompile("\x1b\\][^\x07\x1b]*(?:\x07|\x1b\\\\)?")
	// CSI: parameters, intermediates, a final byte.
	reCSI = regexp.MustCompile("\x1b\\[([0-?]*)[ -/]*([@-~])")
	// Any other escape: ESC and one more byte (charset picks take two).
	reESC = regexp.MustCompile("\x1b[()*+][0-9A-Za-z]|\x1b.")
	// Secrets that may stand on a screen: API keys, tokens, long opaque strings.
	reSecret = regexp.MustCompile(`(?i)\b(?:sk-[a-z0-9_\-]{6,}|bearer\s+\S+|[a-z0-9_\-]{32,})`)
	reSpace  = regexp.MustCompile(`\s+`)
)

// hintPatterns: what a waiting prompt or an error screen says, the telling ones first: the last line
// of the screen that matches one of the first tier is the hint, else the last one of the second
// (the generic "Enter to confirm" under a question says less than the question).
var hintPatterns = [][]*regexp.Regexp{{
	// Waiting prompts.
	regexp.MustCompile(`(?i)do you trust the files in this folder|trust (this|the) folder`),
	regexp.MustCompile(`(?i)\bapi key\b|select login method|/login\b`),
	regexp.MustCompile(`(?i)choose the text style|select (a )?model|choose (a )?model`),
	regexp.MustCompile(`(?i)bypass permissions mode|yes, i accept`),
	regexp.MustCompile(`(?i)update available|new version (is )?available|update now`),
	// Errors.
	regexp.MustCompile(`(?i)api error|model not found|model_not_found|not_found_error|invalid model|authentication_error|authentication failed|invalid api key|oauth token|rate limit|rate_limit|overloaded|credit balance`),
	regexp.MustCompile(`(?i)\b(401|403|404|429|500|529)\b.*\berror\b|\berror\b.*\b(401|403|404|429|500|529)\b`),
}, {
	regexp.MustCompile(`(?i)press enter to continue|enter to confirm|\blog ?in\b|\bsign in\b`),
}}

// screenLines turns raw terminal output into its lines of text: escape sequences dropped (a cursor
// move to another line ends a line, one along it is a space), control characters gone, box drawing
// left out, spaces collapsed.
func screenLines(raw []byte) []string {
	t := string(raw)
	t = reOSC.ReplaceAllString(t, "")
	t = reCSI.ReplaceAllStringFunc(t, func(m string) string {
		switch m[len(m)-1] {
		case 'C':
			return " "
		case 'H', 'f', 'B', 'E', 'F', 'A', 'd', 'J':
			return "\n"
		}
		return ""
	})
	t = reESC.ReplaceAllString(t, "")
	t = strings.ReplaceAll(t, "\r\n", "\n")
	t = strings.ReplaceAll(t, "\r", "\n")
	var b strings.Builder
	for _, r := range t {
		switch {
		case r == '\n' || r == '\t':
			b.WriteRune(r)
		case r < 0x20 || r == 0x7f || r == 0xfffd:
		case r >= 0x2500 && r <= 0x259f: // box drawing, blocks
			b.WriteRune(' ')
		default:
			b.WriteRune(r)
		}
	}
	var out []string
	for _, l := range strings.Split(b.String(), "\n") {
		l = strings.TrimSpace(reSpace.ReplaceAllString(l, " "))
		if l != "" {
			out = append(out, l)
		}
	}
	return out
}

// screenHint is the last line of the output that matches a known prompt or error, cleaned of
// anything that looks like a secret and cut to stuckHintMax characters ("" when none matches).
func screenHint(raw []byte) string {
	lines := screenLines(raw)
	for _, tier := range hintPatterns {
		for i := len(lines) - 1; i >= 0; i-- {
			for _, re := range tier {
				if re.MatchString(lines[i]) {
					return sanitizeHint(lines[i])
				}
			}
		}
	}
	return ""
}

func sanitizeHint(l string) string {
	l = reSecret.ReplaceAllString(l, "…")
	l = strings.TrimLeft(l, "❯>›•·*-⎿✗✘⚠ ")
	return truncate(strings.TrimSpace(l), stuckHintMax)
}

// errKindHint words an API error class the integration reported, when the screen said nothing known.
func errKindHint(kind string) string {
	switch kind {
	case "model_not_found":
		return "API error: model not found"
	case "authentication_failed":
		return "API error: authentication failed"
	case "rate_limit":
		return "API error: rate limited"
	case "billing_error":
		return "API error: billing"
	}
	return "API error: " + strings.ReplaceAll(kind, "_", " ")
}
