package notify

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"math/rand"
	"net/http"
	"net/url"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/ryotarai/minbox/internal/store"
)

// Receiving messages from Slack, by polling the Web API with the bot token (no Socket Mode, no
// public URL). Opt-in per Slack app destination ("receive"). DM only in v1:
//   - conversations.replies on the Slack threads of recent notifications: a reply from an
//     allowed member becomes the person's reply in that minbox thread;
//   - conversations.history on the DM: a new top-level message from an allowed member starts a
//     new minbox thread (in the project named by "#project", else the default project).
//
// Rate limits: one global budget of slackBudget calls per minute per destination, threads polled
// round-robin, Retry-After obeyed exactly, exponential backoff with jitter (cap 5 minutes) on
// other errors, and a slower pace while nothing is going on.

const (
	slackBudget       = 20 // API calls per minute, all methods
	slackMaxReplies   = 8
	slackActiveWindow = 24 * time.Hour  // notified (or received) within this: "active"
	slackMaxBackoff   = 5 * time.Minute // upper bound of any wait
	slackMaxText      = 4000            // runes of a received message
	slackSeenKeep     = 7 * 24 * time.Hour
)

// Inbound is what a received Slack message is turned into; the server implements it with the same
// code paths as the web UI.
type Inbound interface {
	// DeliverReply adds the person's reply to a minbox thread (ErrGone when the thread is gone).
	DeliverReply(ctx context.Context, threadID, text string) error
	// NewThread starts a thread from a DM. project "" is the destination's default project;
	// ErrUnknownProject when project names none, ErrNoTarget when there is no session to put it in.
	NewThread(ctx context.Context, project, defaultProject, text string) (threadID string, err error)
	// PickProject asks a model which project (id or name, as NewThread takes it) the text of a new
	// DM belongs to. "" with no error: unsure. Any error: the caller falls back.
	PickProject(ctx context.Context, text string) (project string, err error)
}

var (
	ErrGone           = errors.New("thread is gone")
	ErrNoTarget       = errors.New("no project session to start a thread in")
	ErrUnknownProject = errors.New("unknown project")
)

// Poller runs one worker per Slack app destination that has receiving on.
type Poller struct {
	Store  *store.Store
	Client *http.Client
	In     Inbound
	// Changed is called after a destination's last result changed.
	Changed func()

	// Test hooks.
	Now        func() time.Time
	Reconcile  time.Duration // how often destinations are re-read (default 10s)
	IntervalFn func(configured time.Duration) time.Duration

	mu      sync.Mutex
	workers map[string]*pollWorker
	wg      sync.WaitGroup
}

// NewPoller builds a poller with the real clock.
func NewPoller(st *store.Store, in Inbound) *Poller {
	return &Poller{Store: st, In: in, Client: &http.Client{Timeout: 20 * time.Second}, Now: time.Now, Reconcile: 10 * time.Second}
}

// Run keeps workers in step with the destinations until ctx ends, then waits for them.
func (p *Poller) Run(ctx context.Context) {
	if p.workers == nil {
		p.mu.Lock()
		p.workers = map[string]*pollWorker{}
		p.mu.Unlock()
	}
	t := time.NewTicker(p.Reconcile)
	defer t.Stop()
	for {
		p.reconcile(ctx)
		select {
		case <-ctx.Done():
			p.stopAll()
			p.wg.Wait()
			return
		case <-t.C:
		}
	}
}

func (p *Poller) stopAll() {
	p.mu.Lock()
	defer p.mu.Unlock()
	for id, w := range p.workers {
		w.cancel()
		delete(p.workers, id)
	}
}

// Workers is the number of running workers (tests).
func (p *Poller) Workers() int {
	p.mu.Lock()
	defer p.mu.Unlock()
	return len(p.workers)
}

func (p *Poller) reconcile(ctx context.Context) {
	dests, err := p.Store.ListDestinations(ctx)
	if err != nil {
		if ctx.Err() == nil {
			log.Printf("slack inbound: %v", err)
		}
		return
	}
	want := map[string]store.Destination{}
	for _, d := range dests {
		if d.Type == "slack_app" && d.Enabled {
			if on, _ := d.Config["receive"].(bool); on {
				want[d.ID] = d
			}
		}
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	for id, w := range p.workers {
		d, ok := want[id]
		if !ok || w.fingerprint != fingerprint(d.Config) {
			w.cancel()
			delete(p.workers, id)
		}
	}
	if ctx.Err() != nil {
		return
	}
	for id, d := range want {
		if _, ok := p.workers[id]; ok {
			continue
		}
		w, err := p.newWorker(d)
		if err != nil {
			continue
		}
		wctx, cancel := context.WithCancel(ctx)
		w.cancel = cancel
		p.workers[id] = w
		p.wg.Add(1)
		go func() {
			defer p.wg.Done()
			w.loop(wctx)
		}()
	}
}

func fingerprint(cfg map[string]any) string {
	b, _ := json.Marshal(cfg)
	return string(b)
}

type pollWorker struct {
	p           *Poller
	dest        store.Destination
	app         *SlackApp
	allowed     map[string]bool
	project     string
	interval    time.Duration
	fingerprint string
	cancel      context.CancelFunc

	calls          []time.Time // API calls within the last minute
	pauseUntil     time.Time
	fails          int
	active         bool
	errRecorded    bool
	lastErrMsg     string
	reactWarned    bool
	noTargetWarned bool
	pick           bool        // let the model pick the project of a new thread
	pickCalls      []time.Time // model calls within the last minute
}

// slackPickPerMinute caps the model calls of one destination.
const slackPickPerMinute = 10

func (p *Poller) newWorker(d store.Destination) (*pollWorker, error) {
	t, _ := Lookup("slack_app")
	n, err := t.Notifier(d.Config, p.Client, Env{Store: p.Store, DestID: d.ID})
	if err != nil {
		return nil, err
	}
	app := n.(*SlackApp)
	w := &pollWorker{p: p, dest: d, app: app, allowed: map[string]bool{}, fingerprint: fingerprint(d.Config)}
	a, _ := d.Config["allowed_users"].(string)
	for _, id := range SplitUserIDs(a) {
		w.allowed[id] = true
	}
	if len(w.allowed) == 0 {
		return nil, errors.New("no allowed users")
	}
	w.project, _ = d.Config["default_project"].(string)
	if v, ok := d.Config["pick_project"].(bool); ok {
		w.pick = v
	} else {
		w.pick = true
	}
	secs, _ := strconv.Atoi(fmt.Sprint(d.Config["poll_interval"]))
	w.interval = min(max(time.Duration(secs)*time.Second, 30*time.Second), slackMaxBackoff)
	if p.IntervalFn != nil {
		w.interval = p.IntervalFn(w.interval)
	}
	return w, nil
}

func (w *pollWorker) loop(ctx context.Context) {
	for {
		wait := w.cycle(ctx)
		t := time.NewTimer(wait)
		select {
		case <-ctx.Done():
			t.Stop()
			return
		case <-t.C:
		}
	}
}

var errBudget = errors.New("slack call budget used up for this minute")

// take reserves one API call of the per-minute budget.
func (w *pollWorker) take() error {
	now := w.p.Now()
	keep := w.calls[:0]
	for _, c := range w.calls {
		if now.Sub(c) < time.Minute {
			keep = append(keep, c)
		}
	}
	w.calls = keep
	if len(w.calls) >= slackBudget {
		return errBudget
	}
	w.calls = append(w.calls, now)
	return nil
}

// cycle polls once (unless paused) and returns how long to wait before the next one.
func (w *pollWorker) cycle(ctx context.Context) time.Duration {
	now := w.p.Now()
	if now.Before(w.pauseUntil) {
		return w.pauseUntil.Sub(now)
	}
	err := w.run(ctx)
	if err != nil && !errors.Is(err, errBudget) && ctx.Err() == nil {
		return w.failed(err)
	}
	if err == nil || errors.Is(err, errBudget) {
		w.fails = 0
		w.recordOK(ctx)
	}
	d := w.interval
	if now2 := w.p.Now(); now2.Before(w.pauseUntil) {
		d = max(d, w.pauseUntil.Sub(now2))
	}
	if !w.active {
		d = min(d*3, slackMaxBackoff)
	}
	if errors.Is(err, errBudget) {
		d = max(d, 15*time.Second)
	}
	return d
}

func (w *pollWorker) failed(err error) time.Duration {
	var se *SendError
	msg := err.Error()
	if errors.As(err, &se) {
		msg = se.Msg
	}
	w.recordErr(msg)
	if errors.As(err, &se) && se.Status == http.StatusTooManyRequests {
		d := se.retryAfterExact
		if d <= 0 {
			d = time.Minute
		}
		w.pauseUntil = w.p.Now().Add(d)
		return d
	}
	w.fails++
	d := w.interval
	for i := 0; i < w.fails && d < slackMaxBackoff; i++ {
		d *= 2
	}
	rnd := rand.Float64
	d = time.Duration(float64(d) * (0.8 + 0.4*rnd()))
	return min(d, slackMaxBackoff)
}

func (w *pollWorker) recordErr(msg string) {
	msg = "Receiving from Slack: " + msg
	if msg == w.lastErrMsg {
		return
	}
	w.lastErrMsg, w.errRecorded = msg, true
	log.Printf("slack inbound: %s: %s", w.dest.ID, msg)
	_ = w.p.Store.RecordDelivery(context.Background(), w.dest.ID, w.p.Now(), msg)
	if w.p.Changed != nil {
		w.p.Changed()
	}
}

func (w *pollWorker) recordOK(ctx context.Context) {
	if !w.errRecorded || ctx.Err() != nil {
		return
	}
	w.errRecorded, w.lastErrMsg = false, ""
	_ = w.p.Store.RecordDelivery(ctx, w.dest.ID, w.p.Now(), "")
	if w.p.Changed != nil {
		w.p.Changed()
	}
}

// slackTS formats a time as a Slack ts.
func slackTS(t time.Time) string { return fmt.Sprintf("%d.%06d", t.Unix(), t.Nanosecond()/1000) }

// tsCmp compares two Slack timestamps ("1700000000.000100").
func tsCmp(a, b string) int {
	as, au := splitTS(a)
	bs, bu := splitTS(b)
	switch {
	case as != bs:
		if as < bs {
			return -1
		}
		return 1
	case au != bu:
		if au < bu {
			return -1
		}
		return 1
	}
	return 0
}

func splitTS(s string) (sec, usec int64) {
	a, b, _ := strings.Cut(s, ".")
	sec, _ = strconv.ParseInt(a, 10, 64)
	for len(b) < 6 {
		b += "0"
	}
	usec, _ = strconv.ParseInt(b[:6], 10, 64)
	return
}

func maxTS(a, b string) string {
	if tsCmp(a, b) >= 0 {
		return a
	}
	return b
}

// run is one cycle. One conversations.history call (the latest 200 top-level messages of the DM)
// shows every parent in it with its latest_reply: conversations.replies is called only for a
// parent whose latest_reply is newer than what was handled, so the steady state is one call per
// cycle however many threads there are (replies to threads older than the latest 200 messages
// are not seen). A DM top-level message newer than the DM cursor starts a new thread.
func (w *pollWorker) run(ctx context.Context) error {
	st := w.p.Store
	id := w.dest.ID
	now := w.p.Now()
	since, err := st.GetSlackState(ctx, id, "since")
	if err != nil {
		return err
	}
	if since == "" {
		// First enable: start at now, never import history.
		since = slackTS(now)
		if err := st.SetSlackState(ctx, id, "since", since); err != nil {
			return err
		}
	}
	_ = st.PruneSlackSeen(ctx, now.Add(-slackSeenKeep))
	recent, err := st.RecentSlackThreads(ctx, id, now.Add(-slackActiveWindow), 1)
	if err != nil {
		return err
	}
	lastIn, _ := st.GetSlackState(ctx, id, "last_inbound")
	w.active = len(recent) > 0
	if lastIn != "" {
		if n, _ := strconv.ParseInt(lastIn, 10, 64); now.Sub(time.Unix(n, 0)) < slackActiveWindow {
			w.active = true
		}
	}
	dm, _ := st.GetSlackState(ctx, id, "dm_channel")
	if dm == "" {
		return nil
	}
	all, err := st.ListSlackThreads(ctx, id)
	if err != nil {
		return err
	}
	byTS := map[string]store.SlackThreadRef{}
	for _, t := range all {
		if t.ChannelID == dm {
			byTS[t.TS] = t
		}
	}
	dmCursor, _ := st.GetSlackState(ctx, id, "dm_cursor")
	dmCursor = maxTS(dmCursor, since)
	pc := &pageCtx{channel: dm, since: since, dmCursor: dmCursor, newDM: dmCursor, byTS: byTS}
	// The one history call of the cycle: the latest 200 top-level messages of the DM.
	r, err := w.call(ctx, "conversations.history", url.Values{"channel": {dm}, "limit": {"200"}})
	if err != nil {
		return err
	}
	runErr := w.processPage(ctx, pc, r.Messages)
	if pc.newDM != dmCursor {
		if err := st.SetSlackState(ctx, id, "dm_cursor", pc.newDM); err != nil && runErr == nil {
			runErr = err
		}
	}
	return runErr
}

type pageCtx struct {
	channel, since string
	dmCursor       string
	newDM          string // the DM cursor to store
	byTS           map[string]store.SlackThreadRef
	repliesCalls   int
}

func (w *pollWorker) processPage(ctx context.Context, pc *pageCtx, msgs []slackMsg) error {
	sort.SliceStable(msgs, func(i, j int) bool { return tsCmp(msgs[i].TS, msgs[j].TS) < 0 })
	for _, m := range msgs {
		if ref, ok := pc.byTS[m.TS]; ok { // a parent we notified
			cur := maxTS(ref.ReplyCursor, pc.since)
			if m.LatestReply != "" && tsCmp(m.LatestReply, cur) > 0 && pc.repliesCalls < slackMaxReplies {
				pc.repliesCalls++
				if err := w.pollReplies(ctx, ref, cur); err != nil {
					return err
				}
			}
			continue
		}
		if tsCmp(m.TS, pc.dmCursor) <= 0 {
			continue
		}
		if m.ThreadTS != "" && m.ThreadTS != m.TS { // a thread reply shown in the channel: not a new thread
			pc.newDM = maxTS(pc.newDM, m.TS)
			continue
		}
		err := w.accept(ctx, pc.channel, m, w.newThread)
		if err != nil && !errors.Is(err, ErrNoTarget) {
			return err
		}
		pc.newDM = maxTS(pc.newDM, m.TS)
	}
	return nil
}

// call makes a read call within the budget and maps scope errors to what to do.
func (w *pollWorker) call(ctx context.Context, method string, v url.Values) (slackResp, error) {
	if err := w.take(); err != nil {
		return slackResp{}, err
	}
	r, err := w.app.callForm(ctx, method, v)
	var se *SendError
	if errors.As(err, &se) && se.code == "missing_scope" {
		need := r.Needed
		if need == "" {
			need = "im:history"
		}
		se.Msg = "The app lacks the " + safeCode(need) + " scope: add it under OAuth & Permissions → Bot Token Scopes (DM history and replies need im:history) and reinstall the app"
	}
	return r, err
}

var projectPrefix = regexp.MustCompile(`(?s)^#([^\s#]+)\s+(.+)$`)

// takePick reserves one model call of the per-minute cap.
func (w *pollWorker) takePick() bool {
	now := w.p.Now()
	kept := w.pickCalls[:0]
	for _, t := range w.pickCalls {
		if now.Sub(t) < time.Minute {
			kept = append(kept, t)
		}
	}
	w.pickCalls = kept
	if len(kept) >= slackPickPerMinute {
		return false
	}
	w.pickCalls = append(w.pickCalls, now)
	return true
}

// newThread decides the project of a new thread: an explicit #project prefix (no model), else the
// model's pick, else the fallback project. Only called for a message of an allowed member.
func (w *pollWorker) newThread(ctx context.Context, text string) error {
	if m := projectPrefix.FindStringSubmatch(text); m != nil {
		_, err := w.p.In.NewThread(ctx, m[1], w.project, m[2])
		if !errors.Is(err, ErrUnknownProject) {
			if err == nil {
				log.Printf("slack inbound: %s: new thread: project from the #prefix", w.dest.ID)
			}
			return err
		}
		// Not a project name: the whole text is the message.
	}
	why := "the fallback project"
	if !w.pick {
		why = "the fallback project (Claude pick is off)"
	} else if !w.takePick() {
		why = "the fallback project (Claude pick rate cap reached)"
		log.Printf("slack inbound: %s: more than %d project picks in a minute; using the fallback project", w.dest.ID, slackPickPerMinute)
	} else if p, err := w.p.In.PickProject(ctx, text); err != nil {
		why = "the fallback project (Claude pick failed)"
	} else if p == "" {
		why = "the fallback project (Claude was unsure)"
	} else {
		_, err := w.p.In.NewThread(ctx, p, w.project, text)
		if err == nil {
			log.Printf("slack inbound: %s: new thread: project picked by Claude", w.dest.ID)
			return nil
		}
		if !errors.Is(err, ErrUnknownProject) && !errors.Is(err, ErrNoTarget) {
			return err
		}
		why = "the fallback project (the picked project has no session)"
	}
	_, err := w.p.In.NewThread(ctx, "", w.project, text)
	if err == nil {
		log.Printf("slack inbound: %s: new thread: %s", w.dest.ID, why)
	}
	if errors.Is(err, ErrNoTarget) && !w.noTargetWarned {
		w.noTargetWarned = true
		log.Printf("slack inbound: %s: a DM arrived but no project could be chosen (Claude pick off or unsure, no valid 'Fallback project'); ignoring DMs that start threads", w.dest.ID)
	}
	return err
}

func (w *pollWorker) pollReplies(ctx context.Context, t store.SlackThreadRef, cursor string) error {
	cursor = maxTS(cursor, t.TS)
	r, err := w.call(ctx, "conversations.replies", url.Values{"channel": {t.ChannelID}, "ts": {t.TS}, "oldest": {cursor}, "limit": {"50"}, "inclusive": {"false"}})
	if err != nil {
		var se *SendError
		if errors.As(err, &se) && (se.code == "thread_not_found" || se.code == "message_not_found") {
			return nil // the parent was deleted in Slack
		}
		return err
	}
	msgs := r.Messages
	sort.SliceStable(msgs, func(i, j int) bool { return tsCmp(msgs[i].TS, msgs[j].TS) < 0 })
	newCursor := cursor
	var failure error
	for _, m := range msgs {
		if tsCmp(m.TS, cursor) <= 0 || m.TS == t.TS {
			continue
		}
		err := w.accept(ctx, t.ChannelID, m, func(ctx context.Context, text string) error {
			return w.p.In.DeliverReply(ctx, t.ThreadID, text)
		})
		if err != nil && !errors.Is(err, ErrGone) {
			failure = err
			break
		}
		newCursor = m.TS
	}
	if newCursor != cursor {
		if err := w.p.Store.SetSlackReplyCursor(ctx, w.dest.ID, t.ThreadID, newCursor); err != nil {
			return err
		}
	}
	return failure
}

// accept delivers one message when it is from an allowed member, at most once, then acks it.
// Skipped messages (bots, edits, other people) return nil.
func (w *pollWorker) accept(ctx context.Context, channel string, m slackMsg, deliver func(context.Context, string) error) error {
	if m.BotID != "" || m.Subtype != "" || (m.Type != "" && m.Type != "message") {
		return nil
	}
	if !w.allowed[m.User] {
		log.Printf("slack inbound: %s: ignored a message from a member that is not allowed (ts %s)", w.dest.ID, safeCode(m.TS))
		return nil
	}
	text := cleanSlackText(m.Text)
	if text == "" {
		return nil
	}
	st := w.p.Store
	first, err := st.MarkSlackSeen(ctx, w.dest.ID, channel, m.TS)
	if err != nil {
		return err
	}
	if !first {
		return nil
	}
	if err := deliver(ctx, text); err != nil {
		if errors.Is(err, ErrNoTarget) || errors.Is(err, ErrGone) {
			return err // dropped on purpose: stays marked, never retried
		}
		_ = st.UnmarkSlackSeen(ctx, w.dest.ID, channel, m.TS)
		return err
	}
	_ = st.SetSlackState(ctx, w.dest.ID, "last_inbound", strconv.FormatInt(w.p.Now().Unix(), 10))
	w.active = true
	w.ack(ctx, channel, m.TS)
	return nil
}

// ack adds the check mark; failing to is never an error of the delivery.
func (w *pollWorker) ack(ctx context.Context, channel, ts string) {
	if w.take() != nil {
		return
	}
	_, err := w.app.call(ctx, "reactions.add", map[string]any{"channel": channel, "timestamp": ts, "name": "white_check_mark"})
	var se *SendError
	if err == nil || !errors.As(err, &se) {
		return
	}
	switch {
	case se.code == "already_reacted":
	case se.Status == http.StatusTooManyRequests:
		w.pauseUntil = w.p.Now().Add(max(se.retryAfterExact, time.Second))
	case !w.reactWarned:
		w.reactWarned = true
		if se.code == "missing_scope" {
			log.Printf("slack inbound: %s: no ✅ reaction: add the reactions:write scope and reinstall the app to get it", w.dest.ID)
		} else {
			log.Printf("slack inbound: %s: could not add the ✅ reaction: %s", w.dest.ID, se.Msg)
		}
	}
}

var (
	slackLinkLabel = regexp.MustCompile(`<([^<>|]+)\|([^<>]+)>`)
	slackLinkBare  = regexp.MustCompile(`<((?:https?://|mailto:)[^<>]+)>`)
)

// cleanSlackText turns Slack's mrkdwn escapes back into plain text and caps the length. The result
// is untrusted data: it is stored as the person's words like anything typed in the web UI.
func cleanSlackText(s string) string {
	s = slackLinkLabel.ReplaceAllString(s, "$2")
	s = slackLinkBare.ReplaceAllString(s, "$1")
	s = strings.NewReplacer("&lt;", "<", "&gt;", ">", "&amp;", "&").Replace(s)
	s = strings.TrimSpace(s)
	if r := []rune(s); len(r) > slackMaxText {
		s = string(r[:slackMaxText]) + "\n\n[truncated: the Slack message was longer than " + strconv.Itoa(slackMaxText) + " characters]"
	}
	return s
}
