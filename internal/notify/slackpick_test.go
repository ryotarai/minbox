package notify

import (
	"context"
	"errors"
	"fmt"
	"testing"
	"time"
)

// pickRun: one DM per call through a worker whose fake model answers pick/err.
func pickRun(t *testing.T, cfg map[string]any, texts []string, setup func(*fakeInbound)) *fakeInbound {
	r := newInRig(t, cfg)
	setup(r.in)
	now := r.now.Unix()
	var hist []map[string]any
	for i, tx := range texts {
		hist = append(hist, msg("U0ME", tx, ts(now+int64(10+i), 1), nil))
	}
	hist = append(hist, msg("U0EVIL", "stranger", ts(now+5, 1), nil))
	newFakeSlackAPI(t, (&slackScript{history: hist}).handler())
	r.worker(t).cycle(context.Background())
	return r.in
}

func TestPickModelChoosesProject(t *testing.T) {
	in := pickRun(t, nil, []string{"fix the build"}, func(f *fakeInbound) { f.pick = "proj_api" })
	if fmt.Sprint(in.threads) != "[proj_api|main|fix the build]" || fmt.Sprint(in.picked) != "[fix the build]" {
		t.Fatalf("threads=%q picked=%q", in.threads, in.picked)
	}
}

func TestPickFallsBack(t *testing.T) {
	for name, set := range map[string]func(*fakeInbound){
		"unsure":  func(f *fakeInbound) { f.pick = "" },
		"error":   func(f *fakeInbound) { f.pickErr = errors.New("timeout") },
		"unknown": func(f *fakeInbound) { f.pick = "nope" }, // the server never returns this; NewThread rejects it
	} {
		in := pickRun(t, nil, []string{"hello"}, set)
		if fmt.Sprint(in.threads) != "[|main|hello]" {
			t.Fatalf("%s: threads=%q", name, in.threads)
		}
	}
}

func TestPickNoFallbackProjectIgnores(t *testing.T) {
	in := pickRun(t, map[string]any{"default_project": ""}, []string{"hello"}, func(f *fakeInbound) {})
	if len(in.threads) != 0 {
		t.Fatalf("threads=%q", in.threads)
	}
}

func TestPickPrefixSkipsModel(t *testing.T) {
	in := pickRun(t, nil, []string{"#other do it"}, func(f *fakeInbound) { f.pick = "proj_api" })
	if fmt.Sprint(in.threads) != "[other|main|do it]" || len(in.picked) != 0 {
		t.Fatalf("threads=%q picked=%q", in.threads, in.picked)
	}
}

func TestPickNeverForNonAllowedSender(t *testing.T) {
	in := pickRun(t, nil, nil, func(f *fakeInbound) { f.pick = "proj_api" }) // only the stranger writes
	if len(in.picked) != 0 || len(in.threads) != 0 {
		t.Fatalf("picked=%q threads=%q", in.picked, in.threads)
	}
}

func TestPickDisabled(t *testing.T) {
	in := pickRun(t, map[string]any{"pick_project": false}, []string{"hello"}, func(f *fakeInbound) { f.pick = "proj_api" })
	if len(in.picked) != 0 || fmt.Sprint(in.threads) != "[|main|hello]" {
		t.Fatalf("picked=%q threads=%q", in.picked, in.threads)
	}
}

func TestPickRateCap(t *testing.T) {
	var texts []string
	for i := 0; i < slackPickPerMinute+3; i++ {
		texts = append(texts, fmt.Sprintf("m%02d", i))
	}
	in := pickRun(t, nil, texts, func(f *fakeInbound) { f.pick = "proj_api" })
	if len(in.picked) != slackPickPerMinute || len(in.threads) != len(texts) {
		t.Fatalf("picked=%d threads=%d", len(in.picked), len(in.threads))
	}
	over := in.threads[slackPickPerMinute]
	if over != "|main|m10" {
		t.Fatalf("over the cap went to %q", over)
	}
	_ = time.Second
}
