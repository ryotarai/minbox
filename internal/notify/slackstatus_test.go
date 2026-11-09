package notify

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"
	"time"
)

// register makes the worker the poller's worker of the rig's destination (without Run).
func (r *inRig) register(w *pollWorker) {
	r.p.mu.Lock()
	defer r.p.mu.Unlock()
	if r.p.workers == nil {
		r.p.workers = map[string]*pollWorker{}
	}
	r.p.workers[r.dest.ID] = w
}

func TestStatusAfterOKCycle(t *testing.T) {
	r := newInRig(t, nil)
	ctx := context.Background()
	r.st.TouchSlackThread(ctx, r.dest.ID, "thr_1")
	parent := "1699999000.000100"
	s := &slackScript{replies: map[string][]map[string]any{parent: {msg("U0ME", "hi", ts(r.now.Unix()+5, 1), nil)}}}
	newFakeSlackAPI(t, s.handler())
	w := r.worker(t)
	r.register(w)
	if st := r.p.Status(ctx, r.dest); st.LastPollAt != nil || !st.Receiving || !st.DMKnown {
		t.Fatalf("before the first poll: %+v", st)
	}
	w.cycle(ctx)
	st := r.p.Status(ctx, r.dest)
	if st.LastPollOK == nil || !*st.LastPollOK || st.LastPollAt == nil || st.NextPollAt == nil || st.PausedUntil != nil {
		t.Fatalf("status = %+v", st)
	}
	if st.Delivered != 1 || st.LastDeliveredAt == nil || st.WatchedThreads != 1 || !strings.Contains(st.Summary, "delivered 1 reply") {
		t.Fatalf("status = %+v", st)
	}
	if st.IntervalSeconds != 60 || st.Slowed || st.ConfiguredSeconds != 60 || len(st.Problems) != 0 {
		t.Fatalf("status = %+v", st)
	}
	// A cycle with nothing new.
	w.cycle(ctx)
	if st = r.p.Status(ctx, r.dest); !strings.Contains(st.Summary, "0 new") || st.Delivered != 1 {
		t.Fatalf("status = %+v", st)
	}
}

func TestStatusIdleIsSlowed(t *testing.T) {
	r := newInRig(t, nil)
	ctx := context.Background()
	newFakeSlackAPI(t, (&slackScript{}).handler())
	w := r.worker(t)
	r.register(w)
	r.st.TouchSlackThread(ctx, r.dest.ID, "thr_1")
	w.cycle(ctx) // a thread was notified just now: active
	if st := r.p.Status(ctx, r.dest); st.Slowed {
		t.Fatalf("active but slowed: %+v", st)
	}
	r.now = r.now.Add(48 * time.Hour)
	w.cycle(ctx)
	if st := r.p.Status(ctx, r.dest); !st.Slowed || st.IntervalSeconds != 180 {
		t.Fatalf("idle: %+v", st)
	}
}

func TestStatusAfterError(t *testing.T) {
	r := newInRig(t, nil)
	ctx := context.Background()
	newFakeSlackAPI(t, func(c appCall, n int) (int, http.Header, string) {
		return 200, nil, `{"ok":false,"error":"missing_scope","needed":"im:history"}`
	})
	w := r.worker(t)
	r.register(w)
	w.cycle(ctx)
	st := r.p.Status(ctx, r.dest)
	if st.LastPollOK == nil || *st.LastPollOK || !strings.Contains(st.LastPollError, "im:history") || !strings.HasPrefix(st.Summary, "Error: ") {
		t.Fatalf("status = %+v", st)
	}
	if len(st.MissingScopes) != 1 || st.MissingScopes[0] != "im:history" || len(st.Problems) != 1 || strings.Contains(st.LastPollError, testToken) {
		t.Fatalf("status = %+v", st)
	}
	d, _ := r.st.GetDestination(ctx, r.dest.ID)
	if !strings.HasSuffix(d.LastError, st.LastPollError) {
		t.Fatalf("last_error %q vs %q", d.LastError, st.LastPollError)
	}
	// The next good cycle clears the error and the scope problem.
	newFakeSlackAPI(t, (&slackScript{}).handler())
	w.app.Base = slackAPIBase
	w.pauseUntil = time.Time{}
	w.cycle(ctx)
	st = r.p.Status(ctx, r.dest)
	if st.LastPollOK == nil || !*st.LastPollOK || st.LastPollError != "" || len(st.MissingScopes) != 0 || len(st.Problems) != 0 {
		t.Fatalf("not cleared: %+v", st)
	}
}

func TestStatusPausedBy429AndCheckNowDoesNotCall(t *testing.T) {
	r := newInRig(t, nil)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	f := newFakeSlackAPI(t, func(c appCall, n int) (int, http.Header, string) {
		return 429, http.Header{"Retry-After": {"137"}}, `{"ok":false,"error":"ratelimited"}`
	})
	w := r.worker(t)
	r.register(w)
	go w.loop(ctx)
	waitFor(t, func() bool { return len(f.all()) == 1 })
	waitFor(t, func() bool { return r.p.Status(ctx, r.dest).PausedUntil != nil })
	st := r.p.Status(ctx, r.dest)
	if !st.PausedUntil.Equal(r.now.Add(137 * time.Second)) {
		t.Fatalf("paused until %v", st.PausedUntil)
	}
	res, err := r.p.CheckNow(ctx, r.dest)
	if err != nil || res.Ran || res.Busy || !strings.Contains(res.Summary, "Paused until") || len(f.all()) != 1 {
		t.Fatalf("res=%+v err=%v calls=%d", res, err, len(f.all()))
	}
	// The pause is over: the check polls.
	r.now = r.now.Add(140 * time.Second)
	res, _ = r.p.CheckNow(ctx, r.dest)
	if !res.Ran || len(f.all()) != 2 {
		t.Fatalf("res=%+v calls=%d", res, len(f.all()))
	}
}

func TestStatusDMUnknown(t *testing.T) {
	r := newInRig(t, nil)
	ctx := context.Background()
	_ = r.st.SetSlackState(ctx, r.dest.ID, "dm_channel", "")
	f := newFakeSlackAPI(t, (&slackScript{}).handler())
	w := r.worker(t)
	r.register(w)
	w.cycle(ctx)
	st := r.p.Status(ctx, r.dest)
	if st.DMKnown || !strings.Contains(st.Summary, "Press Send test first") || len(f.all()) != 0 {
		t.Fatalf("status = %+v calls=%d", st, len(f.all()))
	}
}

func TestStatusConfigProblems(t *testing.T) {
	r := newInRig(t, map[string]any{"pick_project": false, "default_project": ""})
	ctx := context.Background()
	if st := r.p.Status(ctx, r.dest); len(st.Problems) != 1 || !strings.Contains(st.Problems[0], "No project route") || !strings.Contains(st.Problems[0], "#project") {
		t.Fatalf("problems = %q", r.p.Status(ctx, r.dest).Problems)
	}
	r.dest.Config["pick_project"] = true
	r.dest.Config["channel"] = "C0123ABCD"
	r.dest.Config["allowed_users"] = ""
	st := r.p.Status(ctx, r.dest)
	if len(st.Problems) != 2 || !strings.Contains(st.Problems[0], "Channel is not a user ID") || !strings.Contains(st.Problems[1], "empty") {
		t.Fatalf("problems = %q", st.Problems)
	}
	r.dest.Config["allowed_users"] = "bob"
	if st = r.p.Status(ctx, r.dest); !strings.Contains(strings.Join(st.Problems, "|"), "not a member ID") {
		t.Fatalf("problems = %q", st.Problems)
	}
	r.dest.Config["receive"] = false
	if r.p.Status(ctx, r.dest) != nil {
		t.Fatal("status for a destination that does not receive")
	}
}

func TestCheckNowRunsExactlyOneCycle(t *testing.T) {
	r := newInRig(t, nil)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	f := newFakeSlackAPI(t, (&slackScript{}).handler())
	w := r.worker(t)
	r.register(w)
	go w.loop(ctx)
	waitFor(t, func() bool { return len(f.all()) == 1 }) // the first cycle at start
	res, err := r.p.CheckNow(ctx, r.dest)
	if err != nil || !res.Ran || res.Busy || res.Status == nil || !strings.Contains(res.Summary, "fetched 0 messages") {
		t.Fatalf("res=%+v err=%v", res, err)
	}
	if n := len(f.all()); n != 2 {
		t.Fatalf("calls = %d, want 2", n)
	}
	time.Sleep(50 * time.Millisecond)
	if n := len(f.all()); n != 2 {
		t.Fatalf("a second cycle ran: %d", n)
	}
	r.dest.Enabled = false
	if _, err := r.p.CheckNow(ctx, r.dest); err != ErrNotReceiving {
		t.Fatalf("err = %v", err)
	}
}

func TestCheckNowRespectsAllowlistAndDedupe(t *testing.T) {
	r := newInRig(t, nil)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	r.st.TouchSlackThread(ctx, r.dest.ID, "thr_1")
	parent := "1699999000.000100"
	s := &slackScript{replies: map[string][]map[string]any{parent: {
		msg("U0EVIL", "nope", ts(r.now.Unix()+5, 1), nil),
		msg("U0ME", "yes", ts(r.now.Unix()+6, 1), nil),
	}}}
	newFakeSlackAPI(t, s.handler())
	w := r.worker(t)
	r.register(w)
	go w.loop(ctx)
	waitFor(t, func() bool {
		r.in.mu.Lock()
		defer r.in.mu.Unlock()
		return len(r.in.replies) == 1
	})
	for i := 0; i < 2; i++ {
		if _, err := r.p.CheckNow(ctx, r.dest); err != nil {
			t.Fatal(err)
		}
	}
	r.in.mu.Lock()
	defer r.in.mu.Unlock()
	if len(r.in.replies) != 1 || r.in.replies[0] != "thr_1:yes" {
		t.Fatalf("replies = %q", r.in.replies)
	}
}

// A healthy destination has no problems; they must encode as [] not null (the settings page
// reads .length and crashed on null).
func TestStatusJSONArraysAreNeverNull(t *testing.T) {
	r := newInRig(t, nil)
	b, err := json.Marshal(r.p.Status(context.Background(), r.dest))
	if err != nil {
		t.Fatal(err)
	}
	var m map[string]any
	_ = json.Unmarshal(b, &m)
	for _, k := range []string{"problems", "missing_scopes"} {
		if _, ok := m[k].([]any); !ok {
			t.Fatalf("%s = %v in %s, want an array", k, m[k], b)
		}
	}
}
