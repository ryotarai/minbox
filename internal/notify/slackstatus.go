package notify

import (
	"context"
	"errors"
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/ryotarai/minbox/internal/store"
)

// The receiving status of a Slack app destination (Settings → Notifications), and "Check
// receiving now". The state lives in the worker (in memory, gone with it when the destination is
// re-created); the counters of delivered messages are kept in the destination's slack state.

// RecvStatus is what the API shows under a Slack app destination that has receiving on.
type RecvStatus struct {
	Receiving         bool       `json:"receiving"`          // enabled, receive on, and a worker running
	LastPollAt        *time.Time `json:"last_poll_at"`       // the last cycle that called Slack
	LastPollOK        *bool      `json:"last_poll_ok"`       // its outcome (nil: no poll yet)
	LastPollError     string     `json:"last_poll_error"`    // same text as the destination's last_error
	Summary           string     `json:"summary"`            // one line about the latest cycle
	NextPollAt        *time.Time `json:"next_poll_at"`       // when the worker polls next
	PausedUntil       *time.Time `json:"paused_until"`       // Slack asked us to wait (HTTP 429) until then
	IntervalSeconds   int        `json:"interval_seconds"`   // the current effective wait between polls
	ConfiguredSeconds int        `json:"configured_seconds"` // the Poll interval setting
	Slowed            bool       `json:"slowed"`             // the idle rule (x3, at most 5 minutes) is in effect
	DMKnown           bool       `json:"dm_known"`           // the bot-you DM channel (D…) is known
	Delivered         int        `json:"delivered"`          // messages delivered since receiving was switched on
	LastDeliveredAt   *time.Time `json:"last_delivered_at"`
	WatchedThreads    int        `json:"watched_threads"` // notified parents seen in the last history page
	Problems          []string   `json:"problems"`        // what is wrong with the config or the app, in words
	MissingScopes     []string   `json:"missing_scopes"`  // scopes Slack said the app lacks
}

// cycStats is the cycle in progress (touched by the worker's loop goroutine only).
type cycStats struct {
	paused, budget, dmUnknown, called, slowed, reactScope bool
	errMsg                                                string
	fetched, watched                                      int
	delivered, replies, threads                           int
}

// recvState is the published outcome of the latest cycles.
type recvState struct {
	polled      bool
	lastPollAt  time.Time
	lastErr     string
	summary     string
	nextAt      time.Time
	pausedUntil time.Time
	interval    time.Duration
	slowed      bool
	watched     int
	scopes      []string
	reactScope  bool
}

var scopeRe = regexp.MustCompile(`lacks the (\S+) scope`)

// cycle runs one poll cycle and publishes its outcome; the wait to the next one is returned.
func (w *pollWorker) cycle(ctx context.Context) time.Duration {
	w.running.Store(true)
	defer w.running.Store(false)
	w.cyc = cycStats{}
	start := w.p.Now()
	wait := w.step(ctx)
	if ctx.Err() != nil {
		return wait
	}
	c := w.cyc
	w.smu.Lock()
	defer w.smu.Unlock()
	s := &w.st
	s.nextAt = w.p.Now().Add(wait)
	s.pausedUntil = time.Time{}
	if w.pauseUntil.After(w.p.Now()) {
		s.pausedUntil = w.pauseUntil
	}
	if c.paused {
		s.summary = "Paused: Slack asked minbox to wait (rate limited), so no call was made"
		return wait
	}
	s.polled, s.lastPollAt, s.lastErr = true, start, c.errMsg
	s.interval, s.slowed = wait, c.slowed
	if c.called {
		s.watched = c.watched
	}
	if c.reactScope {
		s.reactScope = true
	}
	switch {
	case c.errMsg != "":
		s.summary = "Error: " + c.errMsg
		for _, m := range scopeRe.FindAllStringSubmatch(c.errMsg, -1) {
			if !contains(s.scopes, m[1]) {
				s.scopes = append(s.scopes, m[1])
			}
		}
	case c.dmUnknown:
		s.summary = "Nothing to poll yet: the DM with the bot is not known. Press Send test first"
	default:
		s.scopes = nil
		parts := []string{fmt.Sprintf("fetched %d messages", c.fetched)}
		var got []string
		if c.replies > 0 {
			got = append(got, plural(c.replies, "reply", "replies"))
		}
		if c.threads > 0 {
			got = append(got, plural(c.threads, "new thread", "new threads"))
		}
		if len(got) == 0 {
			parts = append(parts, "0 new")
		} else {
			parts = append(parts, "delivered "+strings.Join(got, " and "))
		}
		s.summary = strings.Join(parts, ", ")
		if c.budget {
			s.summary += " (stopped early: the Slack call budget of this minute is used up)"
		}
	}
	return wait
}

func plural(n int, one, many string) string {
	if n == 1 {
		return "1 " + one
	}
	return strconv.Itoa(n) + " " + many
}

func contains(l []string, s string) bool {
	for _, x := range l {
		if x == s {
			return true
		}
	}
	return false
}

// configProblems reads what is wrong with a destination's receiving config.
func configProblems(cfg map[string]any) []string {
	var out []string
	if ch, _ := cfg["channel"].(string); !slackUserID(ch) {
		out = append(out, "Channel is not a user ID: receiving works for a DM only (put your member ID, U…, in Channel)")
	}
	a, _ := cfg["allowed_users"].(string)
	ids := SplitUserIDs(a)
	valid := 0
	for _, id := range ids {
		if slackUserID(id) {
			valid++
		}
	}
	switch {
	case len(ids) == 0:
		out = append(out, "Allowed Slack user IDs is empty: every message would be ignored")
	case valid < len(ids):
		out = append(out, "Allowed Slack user IDs holds something that is not a member ID (U…)")
	}
	pick := true
	if v, ok := cfg["pick_project"].(bool); ok {
		pick = v
	}
	if p, _ := cfg["default_project"].(string); strings.TrimSpace(p) == "" && !pick {
		out = append(out, "No project route: Fallback project is empty and Claude pick is off, so a new DM is ignored unless it starts with #project (replies in notification threads still work)")
	}
	return out
}

func (p *Poller) workerFor(d *store.Destination) *pollWorker {
	p.mu.Lock()
	defer p.mu.Unlock()
	if w := p.workers[d.ID]; w != nil && w.fingerprint == fingerprint(d.Config) {
		return w
	}
	return nil
}

// ReceivesFrom tells whether a destination is one that receives (a Slack app with receive on).
func ReceivesFrom(d *store.Destination) bool {
	if d.Type != "slack_app" {
		return false
	}
	on, _ := d.Config["receive"].(bool)
	return on
}

// Status is the receiving status of a destination, nil when it does not receive.
func (p *Poller) Status(ctx context.Context, d *store.Destination) *RecvStatus {
	if !ReceivesFrom(d) {
		return nil
	}
	s := &RecvStatus{Problems: configProblems(d.Config), MissingScopes: []string{}}
	secs, _ := strconv.Atoi(fmt.Sprint(d.Config["poll_interval"]))
	s.ConfiguredSeconds = int(min(max(time.Duration(secs)*time.Second, 30*time.Second), slackMaxBackoff).Seconds())
	if dm, _ := p.Store.GetSlackState(ctx, d.ID, "dm_channel"); dm != "" {
		s.DMKnown = true
	}
	n, _ := p.Store.GetSlackState(ctx, d.ID, "delivered_count")
	s.Delivered, _ = strconv.Atoi(n)
	if v, _ := p.Store.GetSlackState(ctx, d.ID, "last_inbound"); v != "" {
		if sec, err := strconv.ParseInt(v, 10, 64); err == nil {
			t := time.Unix(sec, 0)
			s.LastDeliveredAt = &t
		}
	}
	if !d.Enabled {
		s.Problems = append(s.Problems, "The destination is switched off")
	}
	w := p.workerFor(d)
	if w == nil {
		return s
	}
	s.Receiving = true
	w.smu.Lock()
	defer w.smu.Unlock()
	st := w.st
	s.WatchedThreads = st.watched
	if st.polled {
		t, ok := st.lastPollAt, st.lastErr == ""
		s.LastPollAt, s.LastPollOK, s.LastPollError = &t, &ok, st.lastErr
	}
	s.Summary = st.summary
	if !st.nextAt.IsZero() {
		t := st.nextAt
		s.NextPollAt = &t
	}
	if st.pausedUntil.After(p.Now()) {
		t := st.pausedUntil
		s.PausedUntil = &t
	}
	s.IntervalSeconds = int(st.interval.Round(time.Second).Seconds())
	s.Slowed = st.slowed
	s.MissingScopes = append(s.MissingScopes, st.scopes...)
	for _, sc := range st.scopes {
		s.Problems = append(s.Problems, "The app lacks the "+sc+" scope: add it under OAuth & Permissions → Bot Token Scopes and reinstall the app")
	}
	if st.reactScope {
		s.MissingScopes = append(s.MissingScopes, "reactions:write")
		s.Problems = append(s.Problems, "The app lacks reactions:write: delivered messages get no ✅ (optional)")
	}
	return s
}

// CheckResult is the answer of CheckNow.
type CheckResult struct {
	Ran     bool        `json:"ran"`  // a cycle ran now
	Busy    bool        `json:"busy"` // a cycle was already running: nothing was started
	Summary string      `json:"summary"`
	Status  *RecvStatus `json:"status"`
}

// ErrNotReceiving: the destination has no running worker (receiving off, destination off, or the
// worker is about to start).
var ErrNotReceiving = errors.New("not receiving")

// CheckNow makes the destination's worker run one poll cycle immediately: the normal cycle (same
// allowlist, budget, dedupe and pause), only early. While Slack has asked us to wait nothing is
// called, and a cycle that is already running is not doubled.
func (p *Poller) CheckNow(ctx context.Context, d *store.Destination) (*CheckResult, error) {
	w := p.workerFor(d)
	if !ReceivesFrom(d) || !d.Enabled || w == nil {
		return nil, ErrNotReceiving
	}
	res := &CheckResult{}
	w.smu.Lock()
	until := w.st.pausedUntil
	w.smu.Unlock()
	switch {
	case until.After(p.Now()):
		res.Summary = "Paused until " + until.Local().Format("15:04:05") + ": Slack asked minbox to wait (rate limited), so no call was made"
	case w.running.Load():
		res.Busy, res.Summary = true, "A poll is already running"
	default:
		done := make(chan struct{})
		select {
		case w.kick <- done:
			select {
			case <-done:
				res.Ran = true
			case <-w.stopped:
				return nil, ErrNotReceiving
			case <-ctx.Done():
				return nil, ctx.Err()
			case <-time.After(45 * time.Second):
				res.Summary = "Still running"
			}
		default:
			res.Busy, res.Summary = true, "A check is already queued"
		}
	}
	if res.Ran {
		w.smu.Lock()
		res.Summary = w.st.summary
		w.smu.Unlock()
	}
	res.Status = p.Status(ctx, d)
	return res, nil
}
