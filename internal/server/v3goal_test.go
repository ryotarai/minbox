package server

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/ryotarai/minbox/internal/store"
)

// guards sets the run's guard thresholds for a test (fast: continuations in window; streak: fast
// turns in a row, a turn being fast under turn; still: turns without progress).
func guards(t *testing.T, fast int, window time.Duration, streak int, turn time.Duration, still int) {
	t.Helper()
	oc, ow, os, ot, ost, oset := goalFastCount, goalFastWindow, goalFastStreak, goalFastTurn, goalStillTurns, goalSettle
	goalFastCount, goalFastWindow, goalFastStreak, goalFastTurn, goalStillTurns, goalSettle = fast, window, streak, turn, still, 0
	t.Cleanup(func() {
		goalFastCount, goalFastWindow, goalFastStreak, goalFastTurn, goalStillTurns, goalSettle = oc, ow, os, ot, ost, oset
	})
}

type goalRun struct {
	e    *env
	sess *store.Session
	id   string
}

// newGoalRun makes a goal with the given criteria and an autonomous run, its agent idle.
func newGoalRun(t *testing.T, e *env, criteria []string, extra map[string]any) *goalRun {
	t.Helper()
	sess := e.createSession()
	e.do("POST", "/api/agent/status", map[string]string{"status": "idle"}, bearer(sess))
	e.personSays(sess, "keep going")
	crit := []any{}
	for _, c := range criteria {
		crit = append(crit, map[string]any{"text": c})
	}
	body := map[string]any{"title": "Ship it", "kind": "goal", "criteria": crit, "autonomous": true}
	for k, v := range extra {
		body[k] = v
	}
	code, g, _ := e.do("POST", "/api/agent/tasks", body, bearer(sess))
	if code != 200 {
		t.Fatalf("goal: %d %v", code, g)
	}
	e.drain(sess)
	return &goalRun{e: e, sess: sess, id: g["task_id"].(string)}
}

// turn ends the agent's turn (idle) and ticks the runs: true when minbox continued it.
func (g *goalRun) turn() bool {
	g.e.do("POST", "/api/agent/status", map[string]string{"status": "idle"}, bearer(g.sess))
	time.Sleep(3 * time.Millisecond)
	g.e.srv.goalTick()
	n := 0
	for _, p := range g.e.pending(g.sess) {
		if p["kind"] == KindContinue {
			n++
		}
		g.e.deliverMsg(g.sess, p["id"].(string))
	}
	return n > 0
}

func (g *goalRun) task(t *testing.T) *store.Task {
	t.Helper()
	got, err := g.e.st.GetTask(context.Background(), g.id)
	if err != nil {
		t.Fatal(err)
	}
	return got
}

func (g *goalRun) lastEvent(t *testing.T) string {
	t.Helper()
	evs, _ := g.e.st.TaskEvents(context.Background(), g.id)
	for i := len(evs) - 1; i >= 0; i-- {
		if evs[i].Kind == "auto" {
			return evs[i].Text
		}
	}
	return ""
}

func (g *goalRun) resume(t *testing.T) map[string]any {
	t.Helper()
	code, got, _ := g.e.do("POST", "/api/v3/tasks/"+g.id+"/auto", map[string]any{"action": "start"}, nil)
	if code != 200 {
		t.Fatalf("resume: %d %v", code, got)
	}
	return got["auto"].(map[string]any)
}

// Continued too often in a short time: the run pauses (too_fast), says why, tells the person, and
// Resume starts the count over.
func TestGoalGuardTooManyContinuations(t *testing.T) {
	guards(t, 3, time.Minute, 100, 0, 100)
	e := newEnv(t)
	sink := newSlackSink(t)
	e.addDest(sink, map[string]any{"events": "action"})
	g := newGoalRun(t, e, []string{"CI passes"}, nil)
	for i := 1; i <= 3; i++ {
		if !g.turn() {
			t.Fatalf("turn %d: not continued (%+v)", i, g.task(t).Auto)
		}
	}
	if g.turn() {
		t.Fatal("continued a 4th time within the window")
	}
	a := g.task(t).Auto
	if a.State != store.AutoPaused || a.Reason != store.AutoReasonTooFast || a.ReasonText != "continued 3 times in 1 minute" || a.Turns != 3 {
		t.Fatalf("auto = %+v", a)
	}
	if ev := g.lastEvent(t); ev != "Autonomous run paused: continued 3 times in 1 minute" {
		t.Fatalf("event = %q", ev)
	}
	// The person hears of it as something that needs them (a destination set to "needs action" only).
	waitFor(t, "the paused notification", func() bool { return len(sink.all()) == 1 })
	if txt := sink.text(0); !strings.Contains(txt, "paused: continued 3 times in 1 minute") || !strings.Contains(txt, "Resume") {
		t.Fatalf("notification = %s", txt)
	}
	// The API returns the reason.
	_, got, _ := e.do("GET", "/api/v3/tasks/"+g.id, nil, nil)
	if b, ok := got["task"].(map[string]any); ok {
		got = b
	}
	if au := got["auto"].(map[string]any); au["reason"] != "too_fast" || au["reason_text"] != "continued 3 times in 1 minute" {
		t.Fatalf("api auto = %v", au)
	}
	// Resume: the counters start over, and it goes on for three more.
	au := g.resume(t)
	if au["state"] != "running" || au["reason"] != nil || au["recent"] != nil {
		t.Fatalf("resumed = %v", au)
	}
	for i := 1; i <= 3; i++ {
		if !g.turn() {
			t.Fatalf("after resume, turn %d: not continued", i)
		}
	}
	if g.turn() || g.task(t).Auto.Reason != store.AutoReasonTooFast {
		t.Fatalf("after resume = %+v", g.task(t).Auto)
	}
}

// Turns that end right after their continuation, several in a row: too_fast.
func TestGoalGuardFastTurns(t *testing.T) {
	guards(t, 100, time.Minute, 2, time.Minute, 100)
	e := newEnv(t)
	g := newGoalRun(t, e, []string{"CI passes"}, nil)
	// The turn before the first continuation is the agent's own; then two of minbox's end fast.
	for i := 1; i <= 2; i++ {
		if !g.turn() {
			t.Fatalf("turn %d: not continued", i)
		}
	}
	if g.turn() {
		t.Fatal("continued after 2 fast turns")
	}
	a := g.task(t).Auto
	if a.State != store.AutoPaused || a.Reason != store.AutoReasonTooFast || a.ReasonText != "2 turns in a row ended within 1 minute" {
		t.Fatalf("auto = %+v", a)
	}
}

// Turns that change nothing pause the run (no_progress); a ticked criterion or a new task of the
// goal is progress and starts the count over; messages alone are not.
func TestGoalGuardNoProgress(t *testing.T) {
	guards(t, 100, time.Minute, 100, 0, 2)
	e := newEnv(t)
	g := newGoalRun(t, e, []string{"unit tests pass", "e2e pass"}, nil)
	g.turn() // continuation 1 (its mark)
	e.agentSays(g.sess, map[string]any{"body": "Still on it.", "task_id": g.id})
	if !g.turn() || g.task(t).Auto.StillTurns != 1 { // a message is not progress
		t.Fatalf("turn 2: %+v", g.task(t).Auto)
	}
	// Progress: a criterion ticked.
	e.do("PATCH", "/api/agent/tasks/"+g.id, map[string]any{"check_criteria": []int{1}}, bearer(g.sess))
	if !g.turn() || g.task(t).Auto.StillTurns != 0 {
		t.Fatalf("after a ticked criterion: %+v", g.task(t).Auto)
	}
	// Progress: a task of the goal.
	if code, _, _ := e.do("POST", "/api/agent/tasks", map[string]any{"title": "Fix flaky spec", "goal_id": g.id}, bearer(g.sess)); code != 200 {
		t.Fatalf("child task: %d", code)
	}
	if !g.turn() || g.task(t).Auto.StillTurns != 0 {
		t.Fatalf("after a new task: %+v", g.task(t).Auto)
	}
	if !g.turn() {
		t.Fatal("1 still turn: not continued")
	}
	if g.turn() {
		t.Fatal("continued after 2 turns without progress")
	}
	a := g.task(t).Auto
	if a.State != store.AutoPaused || a.Reason != store.AutoReasonNoProgress || a.ReasonText != "no progress in 2 turns" {
		t.Fatalf("auto = %+v", a)
	}
	if ev := g.lastEvent(t); ev != "Autonomous run paused: no progress in 2 turns" {
		t.Fatalf("event = %q", ev)
	}
	// Resume clears the guards: its first continuation takes a mark again, the next is 1 still turn,
	// then it pauses again.
	if au := g.resume(t); au["still_turns"] != nil || au["mark"] != nil || au["reason_text"] != nil {
		t.Fatalf("resumed = %v", au)
	}
	for i := 1; i <= 2; i++ {
		if !g.turn() {
			t.Fatalf("after resume, turn %d: not continued", i)
		}
	}
	if g.turn() || g.task(t).Auto.Reason != store.AutoReasonNoProgress {
		t.Fatalf("after resume = %+v", g.task(t).Auto)
	}
}

// The limits stop the run with their reason, and tell the person; the person's pause says "by you".
func TestGoalLimitReasons(t *testing.T) {
	guards(t, 100, time.Minute, 100, 0, 100)
	e := newEnv(t)
	sink := newSlackSink(t)
	e.addDest(sink, nil)
	g := newGoalRun(t, e, []string{"CI passes"}, map[string]any{"max_turns": 2})
	g.turn()
	g.turn()
	if g.turn() {
		t.Fatal("continued past the turn limit")
	}
	a := g.task(t).Auto
	if a.State != store.AutoStopped || a.Reason != store.AutoReasonTurnLimit || a.ReasonText != "turn limit (2)" {
		t.Fatalf("auto = %+v", a)
	}
	waitFor(t, "the stopped notification", func() bool {
		for i := range sink.all() {
			if strings.Contains(sink.text(i), "stopped: turn limit (2)") {
				return true
			}
		}
		return false
	})

	g2 := newGoalRun(t, e, []string{"docs out"}, nil)
	_, paused, _ := e.do("POST", "/api/v3/tasks/"+g2.id+"/auto", map[string]any{"action": "pause"}, nil)
	if au := paused["auto"].(map[string]any); au["reason"] != "by_you" || au["reason_text"] != "by you" {
		t.Fatalf("paused = %v", au)
	}
	g2.resume(t)
	a = g2.task(t).Auto
	past := time.Now().Add(-time.Minute)
	a.Until = &past
	if err := e.st.SetAuto(context.Background(), g2.id, a); err != nil {
		t.Fatal(err)
	}
	g2.turn() // (a continuation the resume sent before the limit may still arrive here)
	if g2.turn() {
		t.Fatal("continued past the time limit")
	}
	if a := g2.task(t).Auto; a.State != store.AutoStopped || a.Reason != store.AutoReasonTimeLimit || a.ReasonText != "time limit" {
		t.Fatalf("auto = %+v", a)
	}
}
