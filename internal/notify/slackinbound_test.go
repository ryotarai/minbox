package notify

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/ryotarai/minbox/internal/store"
)

type fakeInbound struct {
	mu       sync.Mutex
	replies  []string // "thread:text"
	threads  []string // "project|text"
	noTarget bool
	failNext bool
}

func (f *fakeInbound) DeliverReply(_ context.Context, threadID, text string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.failNext {
		f.failNext = false
		return fmt.Errorf("boom")
	}
	f.replies = append(f.replies, threadID+":"+text)
	return nil
}

func (f *fakeInbound) NewThread(_ context.Context, project, def, text string) (string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if project == "nope" {
		return "", ErrUnknownProject
	}
	if f.noTarget || (project == "" && def == "") {
		return "", ErrNoTarget
	}
	f.threads = append(f.threads, project+"|"+def+"|"+text)
	return "thr_new", nil
}

type inRig struct {
	st   *store.Store
	in   *fakeInbound
	p    *Poller
	now  time.Time
	dest *store.Destination
}

const dmChan = "D0DM"

func newInRig(t *testing.T, cfg map[string]any) *inRig {
	st, err := store.Open(filepath.Join(t.TempDir(), "db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })
	r := &inRig{st: st, in: &fakeInbound{}, now: time.Now().Truncate(time.Second)}
	r.p = NewPoller(st, r.in)
	r.p.Client = http.DefaultClient
	r.p.Now = func() time.Time { return r.now }
	c := map[string]any{"bot_token": testToken, "channel": "U0ME", "receive": true, "default_project": "main"}
	for k, v := range cfg {
		c[k] = v
	}
	norm, err := slackAppType.Normalize(nil, c)
	if err != nil {
		t.Fatal(err)
	}
	r.dest = &store.Destination{Type: "slack_app", Name: "app", Enabled: true, Config: norm}
	if err := st.CreateDestination(context.Background(), r.dest); err != nil {
		t.Fatal(err)
	}
	// A notification was sent: the DM channel and a Slack thread are known.
	ctx := context.Background()
	_ = st.SetSlackState(ctx, r.dest.ID, "dm_channel", dmChan)
	_ = st.PutSlackThread(ctx, r.dest.ID, "thr_1", store.SlackThread{ChannelID: dmChan, TS: "1699999000.000100"})
	return r
}

func (r *inRig) worker(t *testing.T) *pollWorker {
	w, err := r.p.newWorker(*r.dest)
	if err != nil {
		t.Fatal(err)
	}
	return w
}

func ts(sec int64, n int) string { return fmt.Sprintf("%d.%06d", sec, n) }

type slackScript struct {
	history []map[string]any
	replies map[string][]map[string]any // by thread ts
}

func (s *slackScript) handler() func(appCall, int) (int, http.Header, string) {
	return func(c appCall, n int) (int, http.Header, string) {
		switch c.method {
		case "conversations.history":
			// The parents of the scripted threads show up in history with their latest_reply.
			msgs := append([]map[string]any(nil), s.history...)
			for parent, rs := range s.replies {
				latest := ""
				for _, m := range rs {
					if t := m["ts"].(string); tsCmp(t, parent) > 0 && tsCmp(t, latest) > 0 {
						latest = t
					}
				}
				p := map[string]any{"type": "message", "bot_id": "B1", "text": "parent", "ts": parent, "thread_ts": parent}
				if latest != "" {
					p["latest_reply"] = latest
					p["reply_count"] = len(rs)
				}
				msgs = append(msgs, p)
			}
			return 200, nil, string(mustJSON(map[string]any{"ok": true, "messages": msgs}))
		case "conversations.replies":
			ts, _ := c.body["ts"].(string)
			return 200, nil, string(mustJSON(map[string]any{"ok": true, "messages": s.replies[ts]}))
		}
		return 200, nil, `{"ok":true}`
	}
}

func msg(user, text, ts string, extra map[string]any) map[string]any {
	m := map[string]any{"type": "message", "user": user, "text": text, "ts": ts}
	for k, v := range extra {
		m[k] = v
	}
	return m
}

func methods(f *fakeSlackAPI) map[string]int {
	out := map[string]int{}
	for _, c := range f.all() {
		out[c.method]++
	}
	return out
}

func TestInboundDisabledByDefault(t *testing.T) {
	norm, err := slackAppType.Normalize(nil, map[string]any{"bot_token": testToken, "channel": "U0ME"})
	if err != nil || norm["receive"] != false {
		t.Fatalf("%v %v", norm, err)
	}
	r := newInRig(t, nil)
	cfg := r.dest.Config
	cfg["receive"] = false
	r.dest.Config = cfg
	_ = r.st.UpdateDestination(context.Background(), r.dest)
	f := newFakeSlackAPI(t, okReply())
	ctx, cancel := context.WithCancel(context.Background())
	r.p.Reconcile = 10 * time.Millisecond
	done := make(chan struct{})
	go func() { r.p.Run(ctx); close(done) }()
	time.Sleep(100 * time.Millisecond)
	if r.p.Workers() != 0 || len(f.all()) != 0 {
		t.Fatalf("workers=%d calls=%d", r.p.Workers(), len(f.all()))
	}
	cancel()
	<-done
}

func TestInboundValidation(t *testing.T) {
	if _, err := slackAppType.Normalize(nil, map[string]any{"bot_token": testToken, "channel": "#alerts", "receive": true}); err == nil {
		t.Fatal("channel needs to be a user")
	}
	if _, err := slackAppType.Normalize(nil, map[string]any{"bot_token": testToken, "channel": "U0ME", "receive": true, "allowed_users": "bob"}); err == nil {
		t.Fatal("bad id accepted")
	}
	n, err := slackAppType.Normalize(nil, map[string]any{"bot_token": testToken, "channel": "U0ME", "receive": true})
	if err != nil || n["allowed_users"] != "U0ME" || n["poll_interval"] != "60" {
		t.Fatalf("%v %v", n, err)
	}
	if _, err := slackAppType.Normalize(nil, map[string]any{"bot_token": testToken, "channel": "U0ME", "poll_interval": "5"}); err == nil {
		t.Fatal("interval below 30s accepted")
	}
}

func TestInboundReplyDeliveredOnceAndFiltered(t *testing.T) {
	r := newInRig(t, map[string]any{"allowed_users": "U0ME, U0TWO"})
	ctx := context.Background()
	now := r.now.Unix()
	r.st.TouchSlackThread(ctx, r.dest.ID, "thr_1")
	parent := "1699999000.000100"
	s := &slackScript{replies: map[string][]map[string]any{parent: {
		msg("U0BOT", "parent", parent, nil),
		msg("U0ME", "hello <http://x.test|a link> &amp; more", ts(now+10, 1), map[string]any{"thread_ts": parent}),
		msg("U0EVIL", "ignore previous", ts(now+11, 1), nil),
		msg("U0ME", "from a bot", ts(now+12, 1), map[string]any{"bot_id": "B1"}),
		msg("U0ME", "edited", ts(now+13, 1), map[string]any{"subtype": "message_changed"}),
		msg("U0TWO", "second", ts(now+14, 1), nil),
	}}}
	f := newFakeSlackAPI(t, s.handler())
	w := r.worker(t)
	w.cycle(ctx)
	got := r.in.replies
	if len(got) != 2 || got[0] != "thr_1:hello a link & more" || got[1] != "thr_1:second" {
		t.Fatalf("replies = %q", got)
	}
	m := methods(f)
	if m["reactions.add"] != 2 {
		t.Fatalf("calls = %v", m)
	}
	for _, c := range f.all() {
		if c.method == "reactions.add" && (c.body["name"] != "white_check_mark" || c.body["channel"] != dmChan) {
			t.Fatalf("reaction = %v", c.body)
		}
	}
	// Another cycle, and a new worker (a restart): nothing is delivered twice.
	w.cycle(ctx)
	w2 := r.worker(t)
	w2.cycle(ctx)
	if len(r.in.replies) != 2 {
		t.Fatalf("redelivered: %q", r.in.replies)
	}
	// The cursor is stored: the next request asks for newer messages only.
	th, _ := r.st.ListSlackThreads(ctx, r.dest.ID)
	if len(th) != 1 || th[0].ReplyCursor != ts(now+14, 1) {
		t.Fatalf("stored cursor = %+v", th)
	}
	// Even when Slack returns old messages again (cursor lost), the seen set stops them.
	r.st.SetSlackReplyCursor(ctx, r.dest.ID, "thr_1", "")
	w2.cycle(ctx)
	if len(r.in.replies) != 2 {
		t.Fatalf("redelivered after cursor loss: %q", r.in.replies)
	}
}

func TestInboundFailedDeliveryIsRetried(t *testing.T) {
	r := newInRig(t, nil)
	ctx := context.Background()
	r.st.TouchSlackThread(ctx, r.dest.ID, "thr_1")
	parent := "1699999000.000100"
	s := &slackScript{replies: map[string][]map[string]any{parent: {msg("U0ME", "again", ts(r.now.Unix()+5, 1), nil)}}}
	newFakeSlackAPI(t, s.handler())
	r.in.failNext = true
	w := r.worker(t)
	w.cycle(ctx)
	if len(r.in.replies) != 0 {
		t.Fatal("delivered")
	}
	w.pauseUntil = time.Time{}
	w.cycle(ctx)
	if len(r.in.replies) != 1 {
		t.Fatalf("replies = %q", r.in.replies)
	}
}

func TestInboundStartsAtNowNoHistoryImport(t *testing.T) {
	r := newInRig(t, nil)
	ctx := context.Background()
	r.st.TouchSlackThread(ctx, r.dest.ID, "thr_1")
	parent := "1699999000.000100"
	// A reply from before receiving was switched on, and one after.
	s := &slackScript{replies: map[string][]map[string]any{parent: {
		msg("U0ME", "old", ts(r.now.Unix()-500, 1), nil),
		msg("U0ME", "new", ts(r.now.Unix()+5, 1), nil),
	}}}
	f := newFakeSlackAPI(t, s.handler())
	r.worker(t).cycle(ctx)
	for _, c := range f.all() {
		if c.method == "conversations.replies" && c.body["oldest"] != ts(r.now.Unix(), 0) {
			t.Fatalf("oldest = %v", c.body["oldest"])
		}
	}
}

func TestInboundDMTopLevelCreatesThread(t *testing.T) {
	r := newInRig(t, nil)
	ctx := context.Background()
	now := r.now.Unix()
	s := &slackScript{history: []map[string]any{
		msg("U0ME", "#other do the thing", ts(now+30, 1), nil),
		msg("U0ME", "#nope not a project", ts(now+20, 1), nil),
		msg("U0ME", "a reply in a thread", ts(now+15, 1), map[string]any{"thread_ts": "1699999000.000100"}),
		msg("U0EVIL", "stranger", ts(now+12, 1), nil),
		msg("U0ME", "plain note", ts(now+10, 1), nil),
	}}
	f := newFakeSlackAPI(t, s.handler())
	w := r.worker(t)
	w.cycle(ctx)
	want := []string{"|main|plain note", "|main|#nope not a project", "other|main|do the thing"}
	if fmt.Sprint(r.in.threads) != fmt.Sprint(want) {
		t.Fatalf("threads = %q", r.in.threads)
	}
	if len(r.in.replies) != 0 {
		t.Fatalf("a thread reply in history became %q", r.in.replies)
	}
	w.cycle(ctx)
	if len(r.in.threads) != 3 {
		t.Fatalf("redelivered %q", r.in.threads)
	}
	if methods(f)["conversations.history"] != 2 {
		t.Fatalf("calls = %v", methods(f))
	}
}

func TestInboundNoDefaultProject(t *testing.T) {
	r := newInRig(t, map[string]any{"default_project": ""})
	s := &slackScript{history: []map[string]any{msg("U0ME", "hi", ts(r.now.Unix()+5, 1), nil)}}
	f := newFakeSlackAPI(t, s.handler())
	w := r.worker(t)
	w.cycle(context.Background())
	if len(r.in.threads) != 0 || methods(f)["reactions.add"] != 0 || !w.noTargetWarned {
		t.Fatalf("threads=%q calls=%v", r.in.threads, methods(f))
	}
}

func TestInboundRetryAfterPausesEverything(t *testing.T) {
	r := newInRig(t, nil)
	ctx := context.Background()
	r.st.TouchSlackThread(ctx, r.dest.ID, "thr_1")
	f := newFakeSlackAPI(t, func(c appCall, n int) (int, http.Header, string) {
		return 429, http.Header{"Retry-After": {"137"}}, `{"ok":false,"error":"ratelimited"}`
	})
	w := r.worker(t)
	if d := w.cycle(ctx); d != 137*time.Second {
		t.Fatalf("wait = %v", d)
	}
	n := len(f.all())
	if n != 1 {
		t.Fatalf("calls after 429 = %d", n)
	}
	// Still paused 100s later: no call, and the remaining wait is returned.
	r.now = r.now.Add(100 * time.Second)
	if d := w.cycle(ctx); d != 37*time.Second || len(f.all()) != n {
		t.Fatalf("d=%v calls=%d", d, len(f.all()))
	}
	r.now = r.now.Add(40 * time.Second)
	w.cycle(ctx)
	if len(f.all()) != n+1 {
		t.Fatalf("calls = %d", len(f.all()))
	}
}

func TestInboundBackoffAndErrorRecorded(t *testing.T) {
	r := newInRig(t, nil)
	ctx := context.Background()
	f := newFakeSlackAPI(t, func(c appCall, n int) (int, http.Header, string) {
		return 200, nil, `{"ok":false,"error":"missing_scope","needed":"im:history"}`
	})
	w := r.worker(t)
	prev := time.Duration(0)
	for i := 0; i < 8; i++ {
		d := w.cycle(ctx)
		if d > slackMaxBackoff || d < 20*time.Second {
			t.Fatalf("wait %v", d)
		}
		prev = d
	}
	if prev < 4*time.Minute {
		t.Fatalf("backoff did not grow: %v", prev)
	}
	d, _ := r.st.GetDestination(ctx, r.dest.ID)
	if !strings.Contains(d.LastError, "im:history") || !strings.Contains(d.LastError, "reinstall") || strings.Contains(d.LastError, testToken) {
		t.Fatalf("last error = %q", d.LastError)
	}
	_ = f
	// Success resets and clears the error.
	newFakeSlackAPI(t, (&slackScript{}).handler())
	w.app.Base = slackAPIBase
	w.cycle(ctx)
	if w.fails != 0 {
		t.Fatal("fails not reset")
	}
	d, _ = r.st.GetDestination(ctx, r.dest.ID)
	if d.LastError != "" {
		t.Fatalf("error kept: %q", d.LastError)
	}
}

func TestInboundManyThreadsOneHistoryCall(t *testing.T) {
	r := newInRig(t, nil)
	ctx := context.Background()
	s := &slackScript{replies: map[string][]map[string]any{}}
	for i := 0; i < 60; i++ {
		parent := ts(1699990000+int64(i), 1)
		_ = r.st.PutSlackThread(ctx, r.dest.ID, fmt.Sprintf("thr_%d", i), store.SlackThread{ChannelID: dmChan, TS: parent})
		s.replies[parent] = []map[string]any{}
	}
	f := newFakeSlackAPI(t, s.handler())
	w := r.worker(t)
	w.cycle(ctx)
	if m := methods(f); m["conversations.history"] != 1 || m["conversations.replies"] != 0 || len(f.all()) != 1 {
		t.Fatalf("steady state calls = %v", m)
	}
	// A reply in the OLDEST of the 60 threads: one history call plus one replies call.
	old := ts(1699990000, 1)
	s.replies[old] = []map[string]any{msg("U0ME", "late answer", ts(r.now.Unix()+5, 1), nil)}
	w.cycle(ctx)
	m := methods(f)
	if m["conversations.history"] != 2 || m["conversations.replies"] != 1 || m["reactions.add"] != 1 {
		t.Fatalf("calls = %v", m)
	}
	if len(r.in.replies) != 1 || r.in.replies[0] != "thr_0:late answer" {
		t.Fatalf("replies = %q", r.in.replies)
	}
	// Handled: the next cycles ask history only.
	w.cycle(ctx)
	if m := methods(f); m["conversations.replies"] != 1 || m["conversations.history"] != 3 {
		t.Fatalf("calls = %v", m)
	}
	// The request is the latest 200, no paging.
	for _, c := range f.all() {
		if c.method == "conversations.history" && (c.body["limit"] != "200" || c.body["cursor"] != nil) {
			t.Fatalf("history params = %v", c.body)
		}
	}
}

func TestInboundBudget(t *testing.T) {
	r := newInRig(t, nil)
	ctx := context.Background()
	f := newFakeSlackAPI(t, (&slackScript{}).handler())
	w := r.worker(t)
	for i := 0; i < 50; i++ {
		w.cycle(ctx) // all in the same (fake) minute
	}
	if n := len(f.all()); n != slackBudget {
		t.Fatalf("calls = %d, budget %d", n, slackBudget)
	}
	r.now = r.now.Add(61 * time.Second)
	w.cycle(ctx)
	if len(f.all()) != slackBudget+1 {
		t.Fatal("budget never refills")
	}
}

func TestInboundAdaptiveInterval(t *testing.T) {
	r := newInRig(t, map[string]any{"poll_interval": "60"})
	ctx := context.Background()
	newFakeSlackAPI(t, (&slackScript{}).handler())
	w := r.worker(t)
	if d := w.cycle(ctx); d != 60*time.Second {
		t.Fatalf("active wait = %v", d)
	}
	// Notified long ago, nothing received: slow.
	r.now = r.now.Add(48 * time.Hour)
	if d := w.cycle(ctx); d != 180*time.Second {
		t.Fatalf("idle wait = %v", d)
	}
	r2 := newInRig(t, map[string]any{"poll_interval": "300"})
	r2.now = r2.now.Add(48 * time.Hour)
	if d := r2.worker(t).cycle(ctx); d != 300*time.Second {
		t.Fatalf("idle cap = %v", d)
	}
}

func TestInboundReactionScopeMissingDoesNotFail(t *testing.T) {
	r := newInRig(t, nil)
	ctx := context.Background()
	r.st.TouchSlackThread(ctx, r.dest.ID, "thr_1")
	parent := "1699999000.000100"
	s := &slackScript{replies: map[string][]map[string]any{parent: {msg("U0ME", "x", ts(r.now.Unix()+5, 1), nil)}}}
	h := s.handler()
	newFakeSlackAPI(t, func(c appCall, n int) (int, http.Header, string) {
		if c.method == "reactions.add" {
			return 200, nil, `{"ok":false,"error":"missing_scope","needed":"reactions:write"}`
		}
		return h(c, n)
	})
	w := r.worker(t)
	w.cycle(ctx)
	if len(r.in.replies) != 1 || w.fails != 0 || !w.reactWarned {
		t.Fatalf("replies=%q fails=%d", r.in.replies, w.fails)
	}
}

func TestInboundRunStopsWorkerOnDisableAndShutdown(t *testing.T) {
	r := newInRig(t, nil)
	f := newFakeSlackAPI(t, (&slackScript{}).handler())
	r.p.Reconcile = 10 * time.Millisecond
	r.p.IntervalFn = func(time.Duration) time.Duration { return 20 * time.Millisecond }
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { r.p.Run(ctx); close(done) }()
	waitFor(t, func() bool { return r.p.Workers() == 1 && len(f.all()) > 0 })
	r.dest.Enabled = false
	_ = r.st.UpdateDestination(context.Background(), r.dest)
	waitFor(t, func() bool { return r.p.Workers() == 0 })
	time.Sleep(60 * time.Millisecond)
	n := len(f.all())
	time.Sleep(100 * time.Millisecond)
	if len(f.all()) != n {
		t.Fatal("still polling while disabled")
	}
	r.dest.Enabled = true
	_ = r.st.UpdateDestination(context.Background(), r.dest)
	waitFor(t, func() bool { return r.p.Workers() == 1 })
	cancel()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("Run did not stop")
	}
}

func waitFor(t *testing.T, cond func() bool) {
	t.Helper()
	for i := 0; i < 200; i++ {
		if cond() {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("condition not met")
}

func TestSendRecordsDMChannelAndTouches(t *testing.T) {
	r := newRig(t)
	newFakeSlackAPI(t, func(c appCall, n int) (int, http.Header, string) {
		return 200, nil, `{"ok":true,"channel":"D0XYZ","ts":"1700000000.000100"}`
	})
	d := r.addApp(t, map[string]any{"channel": "U0ME"})
	r.d.Dispatch(Notification{Title: "t", ThreadID: "thr_9", Body: "b"})
	r.d.Wait()
	ctx := context.Background()
	if ch, _ := r.st.GetSlackState(ctx, d.ID, "dm_channel"); ch != "D0XYZ" {
		t.Fatalf("dm_channel = %q", ch)
	}
	th, _ := r.st.RecentSlackThreads(ctx, d.ID, time.Now().Add(-time.Hour), 10)
	if len(th) != 1 || th[0].ThreadID != "thr_9" {
		t.Fatalf("threads = %+v", th)
	}
	_ = json.Marshal
}
