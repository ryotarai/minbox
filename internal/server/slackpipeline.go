package server

import (
	"context"
	"errors"
	"fmt"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/ryotarai/minbox/internal/slackuser"
	"github.com/ryotarai/minbox/internal/store"
)

// The candidate pipeline of one refresh of the Slack screen, with a strict call budget:
//
//	search (mentions of me, DMs to me, threads I am in; few pages)
//	→ dedupe by (channel, thread_ts) → at most maxCandidates, newest first
//	→ read each thread (conversations.replies; recent history for a DM), cached per (channel, thread_ts)
//	  and not read again while its latest ts is unchanged and the cache is younger than threadTTL
//	→ names (users.info, cached with a TTL)
//	→ the helper judges every thread whose latest ts changed since it was last judged.
//
// A rate limit stops the reading (never retried in a loop): what is done is kept and shown, the
// note says when Slack allows more. See docs/slack-personal.md.

// slackThreadData is a thread's messages as last read (memory only: message text is not persisted).
type slackThreadData struct {
	Channel     string
	ThreadTS    string // the root ts; "dm" for a DM conversation
	ChannelName string
	IsDM        bool
	IsGroup     bool
	Msgs        []slackuser.Message
	LatestTS    string
	FetchedAt   time.Time
	Peer        string // DM: the other member's id
	Unread      bool
	Permalink   string
	More        int // messages cut from the start
}

type slackUserEntry struct {
	at   time.Time
	name string
	bot  bool
}

type slackProgress struct {
	Running     bool
	Stage       string
	Done, Total int
	StartedAt   time.Time
	FinishedAt  time.Time
	Calls       int
	Partial     bool
	WaitUntil   time.Time
	Error       string
}

type slackProgressView struct {
	Running    bool       `json:"running"`
	Stage      string     `json:"stage,omitempty"`
	Done       int        `json:"done"`
	Total      int        `json:"total"`
	StartedAt  *time.Time `json:"started_at,omitempty"`
	FinishedAt *time.Time `json:"finished_at,omitempty"`
	Calls      int        `json:"calls"`
	Partial    bool       `json:"partial"`
	WaitUntil  *time.Time `json:"wait_until,omitempty"`
	Error      string     `json:"error,omitempty"`
}

func (l *slackSvc) progressView() slackProgressView {
	l.mu.Lock()
	defer l.mu.Unlock()
	p := l.prog
	return slackProgressView{Running: p.Running, Stage: p.Stage, Done: p.Done, Total: p.Total, StartedAt: tpp(p.StartedAt), FinishedAt: tpp(p.FinishedAt),
		Calls: p.Calls, Partial: p.Partial, WaitUntil: tpp(p.WaitUntil), Error: p.Error}
}

type slackFlight struct {
	done chan struct{}
	err  error
}

// ---- ts helpers ----

// tsCmp compares two Slack timestamps ("1700000000.000100"): -1, 0, 1.
func tsCmp(a, b string) int {
	ai, af, _ := strings.Cut(a, ".")
	bi, bf, _ := strings.Cut(b, ".")
	if len(ai) != len(bi) {
		if len(ai) < len(bi) {
			return -1
		}
		return 1
	}
	if c := strings.Compare(ai, bi); c != 0 {
		return c
	}
	for len(af) < 6 {
		af += "0"
	}
	for len(bf) < 6 {
		bf += "0"
	}
	return strings.Compare(af, bf)
}

func tsTime(ts string) time.Time {
	s, _, _ := strings.Cut(ts, ".")
	n, err := strconv.ParseInt(s, 10, 64)
	if err != nil {
		return time.Time{}
	}
	return time.Unix(n, 0)
}

func tsFromTime(t time.Time) string { return fmt.Sprintf("%d.000000", t.Unix()) }

func threadKey(channel, ts string) string { return channel + ":" + ts }

// ---- budget ----

type slackBudget struct {
	max, used int
}

func (b *slackBudget) take() bool {
	if b.used >= b.max {
		return false
	}
	b.used++
	return true
}

// ---- the refresh (one at a time; callers share it) ----

// refresh runs the pipeline unless one runs already (then it waits for that one) or the last one
// was less than debounce ago (unless force). It returns when done.
func (l *slackSvc) refresh(ctx context.Context, force bool) error {
	if l.loadAuth(ctx) == nil {
		return errSlackNotConnected
	}
	l.mu.Lock()
	if f := l.flight; f != nil {
		l.mu.Unlock()
		return l.wait(ctx, f)
	}
	if !l.lastRefresh.IsZero() && l.now().Sub(l.lastRefresh) < l.debounce && !force {
		l.mu.Unlock()
		return nil
	}
	f := &slackFlight{done: make(chan struct{})}
	l.flight = f
	l.prog = slackProgress{Running: true, Stage: "Searching Slack", StartedAt: l.now()}
	l.mu.Unlock()
	l.s.hub.publish(Event{Type: "slack"})
	go func() {
		rctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
		defer cancel()
		f.err = l.run(rctx)
		l.mu.Lock()
		l.flight = nil
		l.lastRefresh = l.now()
		l.prog.Running = false
		l.prog.FinishedAt = l.now()
		if f.err != nil {
			l.prog.Error = l.scrub(f.err.Error())
		}
		l.mu.Unlock()
		close(f.done)
		l.s.hub.publish(Event{Type: "slack"})
	}()
	return l.wait(ctx, f)
}

func (l *slackSvc) wait(ctx context.Context, f *slackFlight) error {
	select {
	case <-f.done:
		return f.err
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (l *slackSvc) setStage(stage string, done, total int) {
	l.mu.Lock()
	l.prog.Stage, l.prog.Done, l.prog.Total = stage, done, total
	l.mu.Unlock()
	l.s.hub.publish(Event{Type: "slack"})
}

func (l *slackSvc) addNote(n string) {
	n = l.scrub(n)
	l.mu.Lock()
	for _, x := range l.notes {
		if x == n {
			l.mu.Unlock()
			return
		}
	}
	l.notes = append(l.notes, n)
	l.mu.Unlock()
}

func (l *slackSvc) pausedBy(err *slackuser.APIError) {
	wait := err.RetryAfter
	if wait <= 0 {
		wait = time.Minute
	}
	l.mu.Lock()
	l.prog.Partial = true
	l.prog.WaitUntil = l.now().Add(wait)
	l.mu.Unlock()
	l.addNote(fmt.Sprintf("Slack asked minbox to slow down: reading paused for about %d s. What was read so far is shown; refresh again after that to continue.", int(wait.Seconds())+1))
}

// ---- candidates ----

type slackCand struct {
	Channel, ThreadTS, ChannelName string
	IsDM                           bool
	HitTS                          string
	Permalink                      string
}

type slackQuery struct {
	kind   string // mention | dm | part
	rts    string
	legacy string
	types  []string
	pages  int
}

func (l *slackSvc) queries(me string) []slackQuery {
	at := "<@" + me + ">"
	return []slackQuery{
		{kind: "mention", rts: at, legacy: at, types: []string{"public_channel", "private_channel"}, pages: l.searchPages},
		{kind: "dm", rts: "to:" + at, legacy: "to:me", types: []string{"im"}, pages: 1},
		{kind: "part", rts: "from:" + at + " is:thread", legacy: "from:me is:thread", types: []string{"public_channel", "private_channel"}, pages: 1},
	}
}

// runQuery pages through one search with the given backend.
func (l *slackSvc) runQuery(ctx context.Context, backend string, q slackQuery, bud *slackBudget) ([]slackuser.Hit, *slackuser.APIError) {
	var all []slackuser.Hit
	after := l.now().Add(-time.Duration(l.days) * 24 * time.Hour).Unix()
	cursor := ""
	for p := 1; p <= q.pages; p++ {
		if !bud.take() {
			break
		}
		var hits []slackuser.Hit
		var err *slackuser.APIError
		more := false
		if backend == slackBackendLegacy {
			var pages int
			hits, pages, err = l.cl.SearchLegacy(ctx, q.legacy, p, 20)
			more = p < pages
		} else {
			var next string
			hits, next, err = l.cl.SearchRTS(ctx, slackuser.RTSQuery{Query: q.rts, ChannelTypes: q.types, AfterUnix: after, Limit: 20, Cursor: cursor})
			cursor, more = next, next != ""
		}
		if err != nil {
			return all, err
		}
		for _, h := range hits {
			if backend == slackBackendLegacy && !tsTime(h.TS).IsZero() && tsTime(h.TS).Unix() < after {
				continue
			}
			all = append(all, h)
		}
		if !more {
			break
		}
	}
	return all, nil
}

func (l *slackSvc) search(ctx context.Context, a *slackUserAuth, bud *slackBudget) (map[string]*slackCand, error) {
	backend, note := l.effectiveBackend(a)
	if note != "" {
		l.addNote(note)
	}
	cands := map[string]*slackCand{}
	add := func(c slackCand) {
		k := threadKey(c.Channel, c.ThreadTS)
		if e := cands[k]; e != nil {
			if tsCmp(c.HitTS, e.HitTS) > 0 {
				e.HitTS = c.HitTS
			}
			if e.ChannelName == "" {
				e.ChannelName = c.ChannelName
			}
			return
		}
		cc := c
		cands[k] = &cc
	}
	var firstErr *slackuser.APIError
	okQueries := 0
	for _, q := range l.queries(a.UserID) {
		hits, err := l.runQuery(ctx, backend, q, bud)
		if err != nil && backend == slackBackendRTS && a.Backend == slackBackendAuto && rtsFallbackCode(err) {
			// Auto mode: this app cannot use the Real-time Search API. Remember it for a while, use the legacy search.
			reason := err.Msg
			l.updateAuth(ctx, func(x *slackUserAuth) { x.FallbackReason, x.FallbackAt = reason, l.now() })
			l.addNote("The Real-time Search API is not usable here (" + reason + "): using the legacy search.messages.")
			backend = slackBackendLegacy
			hits, err = l.runQuery(ctx, backend, q, bud)
		}
		if err != nil {
			if err.RateLimited() {
				l.pausedBy(err)
				firstErr = nil
				if len(cands) == 0 {
					firstErr = err
				}
				break
			}
			if firstErr == nil {
				firstErr = err
			}
			l.addNote("Search failed (" + q.kind + "): " + err.Msg)
			continue
		}
		okQueries++
		for _, h := range hits {
			switch {
			case q.kind == "dm" || h.IsIM:
				add(slackCand{Channel: h.Channel, ThreadTS: "dm", ChannelName: h.ChannelName, IsDM: true, HitTS: h.TS, Permalink: h.Permalink})
				if h.ThreadTS != "" {
					add(slackCand{Channel: h.Channel, ThreadTS: h.ThreadTS, ChannelName: h.ChannelName, IsDM: true, HitTS: h.TS, Permalink: h.Permalink})
				}
			case q.kind == "part":
				if h.ThreadTS != "" {
					add(slackCand{Channel: h.Channel, ThreadTS: h.ThreadTS, ChannelName: h.ChannelName, HitTS: h.TS, Permalink: h.Permalink})
				}
			default:
				ts := h.ThreadTS
				if ts == "" {
					ts = h.TS
				}
				add(slackCand{Channel: h.Channel, ThreadTS: ts, ChannelName: h.ChannelName, HitTS: h.TS, Permalink: h.Permalink})
			}
		}
	}
	if okQueries == 0 && firstErr != nil {
		return nil, errors.New(firstErr.Msg)
	}
	return cands, nil
}

// ---- reading threads ----

const (
	slackThreadPages = 3
	slackKeepMsgs    = 40
	slackDMHistory   = 15
)

func (l *slackSvc) fetchThread(ctx context.Context, c slackCand, bud *slackBudget, wsURL string) (*slackThreadData, *slackuser.APIError) {
	td := &slackThreadData{Channel: c.Channel, ThreadTS: c.ThreadTS, ChannelName: c.ChannelName, IsDM: c.IsDM}
	if c.IsDM && c.ThreadTS == "dm" {
		if !bud.take() {
			return nil, &slackuser.APIError{Code: "budget", Msg: "call budget used up"}
		}
		msgs, err := l.cl.History(ctx, c.Channel, slackDMHistory)
		if err != nil {
			return nil, err
		}
		td.Msgs = msgs
	} else {
		cursor := ""
		for p := 0; p < slackThreadPages; p++ {
			if !bud.take() {
				if p == 0 {
					return nil, &slackuser.APIError{Code: "budget", Msg: "call budget used up"}
				}
				break
			}
			msgs, next, err := l.cl.Replies(ctx, c.Channel, c.ThreadTS, 100, cursor)
			if err != nil {
				if p > 0 {
					break
				}
				return nil, err
			}
			td.Msgs = append(td.Msgs, msgs...)
			if next == "" {
				break
			}
			cursor = next
		}
		if len(td.Msgs) > 0 {
			if root := td.Msgs[0].TS; root != "" {
				td.ThreadTS = root
			}
		}
	}
	if n := len(td.Msgs); n > slackKeepMsgs {
		td.More = n - slackKeepMsgs
		td.Msgs = append([]slackuser.Message{td.Msgs[0]}, td.Msgs[n-slackKeepMsgs+1:]...)
	}
	if n := len(td.Msgs); n > 0 {
		td.LatestTS = td.Msgs[n-1].TS
	}
	td.FetchedAt = l.now()
	if strings.HasPrefix(c.Channel, "G") || strings.HasPrefix(c.ChannelName, "mpdm-") {
		td.IsGroup = true
	}
	// The link to the thread's root message (built from the workspace URL: no API call), else the
	// permalink search returned; for a DM the conversation.
	switch {
	case td.ThreadTS == "dm" && wsURL != "":
		td.Permalink = strings.TrimRight(wsURL, "/") + "/archives/" + c.Channel
	case td.ThreadTS != "dm" && slackuser.PermalinkFor(wsURL, c.Channel, td.ThreadTS, "") != "":
		td.Permalink = slackuser.PermalinkFor(wsURL, c.Channel, td.ThreadTS, "")
	default:
		td.Permalink = c.Permalink
	}
	return td, nil
}

var slackMentionRe = regexp.MustCompile(`<@([UW][A-Z0-9]+)`)

// resolveUsers fills the names of the users in the threads (cached with userTTL; a failure keeps the id).
func (l *slackSvc) resolveUsers(ctx context.Context, ids []string, bud *slackBudget) {
	want := map[string]bool{}
	for _, id := range ids {
		if id == "" {
			continue
		}
		l.mu.Lock()
		e, ok := l.users[id]
		l.mu.Unlock()
		if ok && l.now().Sub(e.at) < l.userTTL {
			continue
		}
		want[id] = true
	}
	for _, id := range slackSortedKeys(want) {
		if !bud.take() {
			l.addNote("The call budget of this refresh was used up before every name was looked up.")
			return
		}
		u, err := l.cl.UserInfo(ctx, id)
		if err != nil {
			if err.RateLimited() {
				l.pausedBy(err)
				return
			}
			if err.Code == "missing_scope" {
				l.addNote("Names are shown as ids: the token lacks the users:read scope.")
				return
			}
			continue
		}
		l.mu.Lock()
		l.users[id] = slackUserEntry{at: l.now(), name: u.Name, bot: u.IsBot}
		l.mu.Unlock()
	}
}

func (l *slackSvc) userName(id string) string {
	l.mu.Lock()
	defer l.mu.Unlock()
	if e, ok := l.users[id]; ok && e.name != "" {
		return e.name
	}
	return ""
}

func (l *slackSvc) displayName(id string) string {
	if n := l.userName(id); n != "" {
		return n
	}
	return id
}

func (l *slackSvc) resolver() slackuser.Resolver {
	return slackuser.Resolver{User: l.userName}
}

func threadUserIDs(td *slackThreadData) []string {
	seen := map[string]bool{}
	var out []string
	add := func(id string) {
		if id != "" && !seen[id] {
			seen[id] = true
			out = append(out, id)
		}
	}
	for _, m := range td.Msgs {
		add(m.User)
		for _, x := range slackMentionRe.FindAllStringSubmatch(m.Text, -1) {
			add(x[1])
		}
	}
	add(td.Peer)
	return out
}

// ---- the run ----

func (l *slackSvc) run(ctx context.Context) error {
	a := l.loadAuth(ctx)
	if a == nil {
		return errSlackNotConnected
	}
	l.mu.Lock()
	l.notes = nil
	l.mu.Unlock()
	bud := &slackBudget{max: l.maxCalls}
	defer func() {
		l.mu.Lock()
		l.prog.Calls = bud.used
		l.mu.Unlock()
	}()
	cands, err := l.search(ctx, a, bud)
	if err != nil {
		return err
	}
	list := make([]*slackCand, 0, len(cands))
	for _, c := range cands {
		list = append(list, c)
	}
	sort.Slice(list, func(i, j int) bool {
		if c := tsCmp(list[i].HitTS, list[j].HitTS); c != 0 {
			return c > 0
		}
		return threadKey(list[i].Channel, list[i].ThreadTS) < threadKey(list[j].Channel, list[j].ThreadTS)
	})
	if len(list) > l.maxCandidates {
		l.addNote(fmt.Sprintf("%d more candidates were left out (the newest %d are read per refresh).", len(list)-l.maxCandidates, l.maxCandidates))
		list = list[:l.maxCandidates]
	}
	// Read the threads (cache first).
	var fresh, retry []*slackThreadData
	paused := false
	for i, c := range list {
		l.setStage("Reading threads", i, len(list))
		k := threadKey(c.Channel, c.ThreadTS)
		l.mu.Lock()
		cached := l.threads[k]
		l.mu.Unlock()
		if cached != nil && tsCmp(c.HitTS, cached.LatestTS) <= 0 && l.now().Sub(cached.FetchedAt) < l.threadTTL {
			// Unchanged and recent: not read again, and not judged again, unless the last judgement failed.
			if it, ok := l.s.store.SlackItem(ctx, cached.Channel, cached.ThreadTS); !ok || it.Judgement == "" || it.JudgedLatestTS != cached.LatestTS {
				retry = append(retry, cached)
			}
			continue
		}
		if paused {
			continue
		}
		td, ferr := l.fetchThread(ctx, *c, bud, a.URL)
		if ferr != nil {
			switch {
			case ferr.RateLimited():
				l.pausedBy(ferr)
				paused = true
			case ferr.Code == "budget":
				l.addNote("The call budget of one refresh (" + strconv.Itoa(l.maxCalls) + " calls) was used up: the rest is read on the next refresh.")
				paused = true
			default:
				l.addNote("Could not read " + firstNonEmpty(c.ChannelName, c.Channel) + ": " + ferr.Msg)
			}
			continue
		}
		if td.ThreadTS != c.ThreadTS { // a reply ts was given: the thread is keyed by its root
			k = threadKey(td.Channel, td.ThreadTS)
		}
		l.mu.Lock()
		l.threads[k] = td
		l.mu.Unlock()
		fresh = append(fresh, td)
	}
	l.trimCache()
	fresh = append(fresh, retry...) // cached threads whose judgement failed earlier are judged again
	if len(fresh) == 0 {
		return nil
	}
	// DMs: who is the other person; unread state.
	l.setStage("Reading names", 0, len(fresh))
	for _, td := range fresh {
		if td.IsDM {
			for _, m := range td.Msgs {
				if m.User != "" && m.User != a.UserID {
					td.Peer = m.User
					break
				}
			}
			if td.Peer == "" && strings.HasPrefix(td.ChannelName, "U") {
				td.Peer = td.ChannelName
			}
		}
	}
	var ids []string
	for _, td := range fresh {
		ids = append(ids, threadUserIDs(td)...)
	}
	l.resolveUsers(ctx, ids, bud)
	l.unreadDMs(ctx, a, fresh, bud)
	// Judge what changed.
	l.judgeAll(ctx, a, fresh)
	return nil
}

func (l *slackSvc) trimCache() {
	l.mu.Lock()
	defer l.mu.Unlock()
	if len(l.threads) <= 200 {
		return
	}
	type kv struct {
		k string
		t time.Time
	}
	var all []kv
	for k, t := range l.threads {
		all = append(all, kv{k, t.FetchedAt})
	}
	sort.Slice(all, func(i, j int) bool { return all[i].t.Before(all[j].t) })
	for _, e := range all[:len(all)-150] {
		delete(l.threads, e.k)
	}
}

// unreadDMs: whether a DM has messages I have not read (conversations.info; needs im:read, optional).
func (l *slackSvc) unreadDMs(ctx context.Context, a *slackUserAuth, fresh []*slackThreadData, bud *slackBudget) {
	for _, td := range fresh {
		if !td.IsDM || td.ThreadTS != "dm" {
			continue
		}
		l.mu.Lock()
		skip := l.scopeNoted["im:read"]
		l.mu.Unlock()
		if skip || (a.ScopesKnown && !contains(a.Scopes, "im:read")) {
			return
		}
		if !bud.take() {
			return
		}
		ci, err := l.cl.ConvInfo(ctx, td.Channel)
		if err != nil {
			if err.RateLimited() {
				l.pausedBy(err)
				return
			}
			if err.Code == "missing_scope" {
				l.mu.Lock()
				l.scopeNoted["im:read"] = true
				l.mu.Unlock()
				l.addNote("Unread dots for DMs need the optional im:read scope.")
				return
			}
			continue
		}
		if ci.Peer != "" && td.Peer == "" {
			td.Peer = ci.Peer
		}
		td.Unread = ci.Unread > 0 || (ci.LastRead != "" && tsCmp(td.LatestTS, ci.LastRead) > 0 && lastAuthor(td) != a.UserID)
	}
}

func lastAuthor(td *slackThreadData) string {
	if n := len(td.Msgs); n > 0 {
		return td.Msgs[n-1].User
	}
	return ""
}

// ---- views and judgements ----

type slackView struct {
	Kind       string   `json:"kind"` // channel | dm | group
	Label      string   `json:"label"`
	People     []string `json:"people"`
	LastTS     string   `json:"last_ts"`
	LastAuthor string   `json:"last_author"`
	LastIsMe   bool     `json:"last_is_me"`
	Snippet    string   `json:"snippet"`
	Messages   int      `json:"messages"`
	Unread     bool     `json:"unread"`
	Permalink  string   `json:"permalink"`
}

func (l *slackSvc) buildView(td *slackThreadData, me string) slackView {
	v := slackView{LastTS: td.LatestTS, Messages: len(td.Msgs) + td.More, Unread: td.Unread, Permalink: td.Permalink, People: []string{}}
	switch {
	case td.IsDM && !td.IsGroup:
		v.Kind = "dm"
		peer := td.Peer
		v.Label = "DM"
		if peer != "" {
			v.Label = "DM with " + l.displayName(peer)
		}
		if td.ThreadTS != "dm" {
			v.Label += " (thread)"
		}
	case td.IsGroup:
		v.Kind = "group"
		v.Label = "Group DM"
	default:
		v.Kind = "channel"
		v.Label = "#" + firstNonEmpty(td.ChannelName, td.Channel)
	}
	seen := map[string]bool{}
	for _, m := range td.Msgs {
		if m.User != "" && !seen[m.User] {
			seen[m.User] = true
			if len(v.People) < 6 {
				v.People = append(v.People, l.displayName(m.User))
			}
		}
	}
	if n := len(td.Msgs); n > 0 {
		m := td.Msgs[n-1]
		v.LastIsMe = m.User == me
		v.LastAuthor = l.displayName(firstNonEmpty(m.User, m.BotID))
		if m.User == "" && m.Username != "" {
			v.LastAuthor = m.Username
		}
		v.Snippet = oneLine(redactSecrets(slackuser.PlainText(m.Text, l.resolver())), 140)
	}
	return v
}

// ---- storage keys ----

// slackItemKey parses "C123:1700000000.000100" (or "D123:dm").
func slackItemKey(id string) (channel, ts string, ok bool) {
	channel, ts, ok = strings.Cut(id, ":")
	if !ok || channel == "" || ts == "" || len(id) > 80 {
		return "", "", false
	}
	for _, r := range id {
		if !(r >= 'A' && r <= 'Z' || r >= 'a' && r <= 'z' || r >= '0' && r <= '9' || r == ':' || r == '.') {
			return "", "", false
		}
	}
	return channel, ts, true
}

var _ = store.SlackItem{}
var _ sync.Mutex

func slackSortedKeys(m map[string]bool) []string {
	ks := make([]string, 0, len(m))
	for k := range m {
		ks = append(ks, k)
	}
	sort.Strings(ks)
	return ks
}
