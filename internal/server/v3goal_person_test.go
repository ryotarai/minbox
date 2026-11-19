package server

import (
	"context"
	"testing"
	"time"

	"github.com/ryotarai/minbox/internal/store"
)

func crit(texts ...string) []any {
	out := []any{}
	for _, t := range texts {
		out = append(out, map[string]any{"text": t})
	}
	return out
}

func critOf(t *testing.T, obj map[string]any) []map[string]any {
	t.Helper()
	out := []map[string]any{}
	for _, c := range obj["criteria"].([]any) {
		out = append(out, c.(map[string]any))
	}
	return out
}

// The person makes a goal from the UI: its criteria, its agent, and its run started at once.
func TestV3PersonCreatesGoal(t *testing.T) {
	e := newEnv(t)
	sess := e.createSession()
	code, g, _ := e.do("POST", "/api/v3/tasks", map[string]any{"title": "Ship v2", "kind": "goal", "criteria": crit("CI passes", " ", "Docs updated"), "session_id": sess.ID, "autonomous": true, "max_turns": 7}, nil)
	if code != 201 {
		t.Fatalf("create: %d %v", code, g)
	}
	if g["kind"] != "goal" || g["project_id"] != sess.ProjectID {
		t.Fatalf("goal = %v", g)
	}
	cs := critOf(t, g)
	if len(cs) != 2 || cs[0]["text"] != "CI passes" || cs[1]["text"] != "Docs updated" || cs[0]["done"] != false {
		t.Fatalf("criteria = %v", cs)
	}
	au := g["auto"].(map[string]any)
	if au["state"] != "running" || au["session_id"] != sess.ID || au["max_turns"] != float64(7) {
		t.Fatalf("auto = %v", au)
	}
	agents := g["agents"].([]any)
	if len(agents) != 1 || agents[0].(map[string]any)["session_id"] != sess.ID {
		t.Fatalf("agents = %v", agents)
	}
	// Without a run; and a run needs an agent.
	code, g2, _ := e.do("POST", "/api/v3/tasks", map[string]any{"project_id": sess.ProjectID, "title": "Later", "kind": "goal", "criteria": crit("a")}, nil)
	if code != 201 || g2["auto"].(map[string]any)["state"] != "" || len(critOf(t, g2)) != 1 {
		t.Fatalf("no run: %d %v", code, g2)
	}
	if code, _, _ := e.do("POST", "/api/v3/tasks", map[string]any{"project_id": sess.ProjectID, "title": "x", "kind": "goal", "autonomous": true}, nil); code != 400 {
		t.Fatalf("run without an agent: %d", code)
	}
	if code, _, _ := e.do("POST", "/api/v3/tasks", map[string]any{"project_id": sess.ProjectID, "title": "x", "session_id": sess.ID, "autonomous": true}, nil); code != 400 {
		t.Fatalf("run of a task: %d", code)
	}
	// A task ignores criteria.
	_, tk, _ := e.do("POST", "/api/v3/tasks", map[string]any{"project_id": sess.ProjectID, "title": "plain", "criteria": crit("a")}, nil)
	if tk["kind"] != "" || len(critOf(t, tk)) != 0 {
		t.Fatalf("task = %v", tk)
	}
}

// The person adds, edits, deletes and ticks criteria with PATCH; all met: done, and the run stops.
func TestV3PersonEditsCriteria(t *testing.T) {
	guards(t, 100, time.Minute, 100, 0, 100)
	e := newEnv(t)
	sess := e.createSession()
	_, g, _ := e.do("POST", "/api/v3/tasks", map[string]any{"title": "Ship", "kind": "goal", "criteria": crit("one"), "session_id": sess.ID, "autonomous": true}, nil)
	id := g["id"].(string)
	patch := func(cs []any) map[string]any {
		t.Helper()
		code, got, _ := e.do("PATCH", "/api/v3/tasks/"+id, map[string]any{"criteria": cs}, nil)
		if code != 200 {
			t.Fatalf("patch: %d %v", code, got)
		}
		return got
	}
	// add
	got := patch([]any{map[string]any{"text": "one"}, map[string]any{"text": "two"}, map[string]any{"text": "three"}})
	if cs := critOf(t, got); len(cs) != 3 || cs[2]["text"] != "three" {
		t.Fatalf("add: %v", cs)
	}
	// edit, delete, reorder
	got = patch([]any{map[string]any{"text": "three"}, map[string]any{"text": "one (edited)"}})
	if cs := critOf(t, got); len(cs) != 2 || cs[0]["text"] != "three" || cs[1]["text"] != "one (edited)" {
		t.Fatalf("edit/delete: %v", cs)
	}
	// tick one: not done yet
	got = patch([]any{map[string]any{"text": "three", "done": true}, map[string]any{"text": "one (edited)"}})
	if got["status"] == "done" || got["auto"].(map[string]any)["state"] != "running" {
		t.Fatalf("one ticked: %v", got)
	}
	// tick all: done, the run stopped (met)
	got = patch([]any{map[string]any{"text": "three", "done": true}, map[string]any{"text": "one (edited)", "done": true}})
	if got["status"] != "done" {
		t.Fatalf("all ticked: status %v", got["status"])
	}
	au := got["auto"].(map[string]any)
	if au["state"] != "stopped" || au["reason"] != store.AutoReasonMet {
		t.Fatalf("auto = %v", au)
	}
}

// A task becomes a goal from its menu (PATCH kind), and back.
func TestV3ConvertTaskToGoal(t *testing.T) {
	e := newEnv(t)
	sess := e.createSession()
	_, tk, _ := e.do("POST", "/api/v3/tasks", map[string]any{"project_id": sess.ProjectID, "title": "Fix login", "session_id": sess.ID}, nil)
	id := tk["id"].(string)
	code, got, _ := e.do("PATCH", "/api/v3/tasks/"+id, map[string]any{"kind": "goal"}, nil)
	if code != 200 || got["kind"] != "goal" || got["title"] != "Fix login" {
		t.Fatalf("convert: %d %v", code, got)
	}
	evs, _ := e.st.TaskEvents(context.Background(), id)
	found := false
	for _, ev := range evs {
		found = found || ev.Text == "Made a goal (you)"
	}
	if !found {
		t.Fatalf("events = %+v", evs)
	}
	// Its criteria can be set now; and it can run.
	_, got, _ = e.do("PATCH", "/api/v3/tasks/"+id, map[string]any{"criteria": crit("login works")}, nil)
	if len(critOf(t, got)) != 1 {
		t.Fatalf("criteria = %v", got)
	}
	if code, _, _ := e.do("PATCH", "/api/v3/tasks/"+id, map[string]any{"kind": "epic"}, nil); code != 400 {
		t.Fatalf("bad kind: %d", code)
	}
	code, got, _ = e.do("PATCH", "/api/v3/tasks/"+id, map[string]any{"kind": "task"}, nil)
	if code != 200 || got["kind"] != "" {
		t.Fatalf("back to a task: %d %v", code, got)
	}
}

// restart simulates a server restart for the session: minbox forgets its idle time and its mod.
func restart(e *env, sess *store.Session, status string) {
	e.t.Helper()
	if err := e.st.SetSessionStatus(context.Background(), sess.ID, status); err != nil {
		e.t.Fatal(err)
	}
	forgetIdle(sess.ID)
	e.srv.modMu.Lock()
	delete(e.srv.modConns, sess.ID)
	e.srv.modMu.Unlock()
}

func modBeat(e *env, sess *store.Session, state string, seq int) {
	e.t.Helper()
	if code, _, _ := e.do("POST", "/api/agent/heartbeat", map[string]any{"seq": seq, "agent": "claude", "state": state, "protocol": 1}, bearer(sess)); code != 200 {
		e.t.Fatalf("heartbeat: %d", code)
	}
}

// ticks runs the goals a few times and returns how many continuations were sent (delivering them).
func (g *goalRun) ticks(n int) int {
	for i := 0; i < n; i++ {
		g.e.srv.goalTick()
		time.Sleep(2 * time.Millisecond)
	}
	c := 0
	for _, p := range g.e.pending(g.sess) {
		if p["kind"] == KindContinue {
			c++
		}
		g.e.deliverMsg(g.sess, p["id"].(string))
	}
	return c
}

// After a restart, a running goal whose agent is idle goes on once its mod is heard from (and says
// it is idle): one continuation, not two; the restart is not a fast turn.
func TestGoalResumesAfterRestartIdle(t *testing.T) {
	guards(t, 100, time.Minute, 1, time.Hour, 100)
	e := newEnv(t)
	g := newGoalRun(t, e, []string{"CI passes"}, nil)
	if !g.turn() {
		t.Fatal("first turn not continued")
	}
	before := g.task(t).Auto
	if before.Turns != 1 || before.FastTurns != 0 {
		t.Fatalf("before = %+v", before)
	}
	restart(e, g.sess, store.StatusIdle)
	// Nothing heard from its mod yet: it waits.
	for i := 0; i < 3; i++ {
		e.srv.goalTick()
	}
	if a := g.task(t).Auto; a.Turns != 1 {
		t.Fatalf("continued before the mod spoke: %+v", a)
	}
	// The mod's heartbeat says idle: it goes on, exactly once.
	modBeat(e, g.sess, "idle", 1)
	if n := g.ticks(4); n != 1 {
		t.Fatalf("continuations after the restart = %d, want 1", n)
	}
	a := g.task(t).Auto
	// Streak 1 within an hour would pause it if the restart counted as a fast turn.
	if a.State != store.AutoRunning || a.Turns != 2 || a.FastTurns != 0 || len(a.Recent) != 2 {
		t.Fatalf("after = %+v", a)
	}
	if n := g.ticks(3); n != 0 {
		t.Fatalf("continued again without a turn: %d", n)
	}
	// The next real turn is timed as usual: within the hour, so a fast turn (streak 1 pauses it).
	if g.turn() || g.task(t).Auto.Reason != store.AutoReasonTooFast {
		t.Fatalf("next turn: %+v", g.task(t).Auto)
	}
}

// After a restart, an agent in a turn is not continued until it reports idle.
func TestGoalResumeWaitsForWorkingAgent(t *testing.T) {
	guards(t, 100, time.Minute, 100, 0, 100)
	e := newEnv(t)
	g := newGoalRun(t, e, []string{"CI passes"}, nil)
	if !g.turn() {
		t.Fatal("first turn not continued")
	}
	restart(e, g.sess, store.StatusWorking)
	modBeat(e, g.sess, "working", 1)
	if n := g.ticks(3); n != 0 {
		t.Fatalf("continued a working agent: %d", n)
	}
	// The mod thinks it is idle, but the stored status says working: still nothing.
	modBeat(e, g.sess, "idle", 2)
	if n := g.ticks(3); n != 0 {
		t.Fatalf("continued while the status says working: %d", n)
	}
	// Stored idle, but the mod says it works (a turn started while minbox was down): nothing.
	restart(e, g.sess, store.StatusIdle)
	modBeat(e, g.sess, "working", 3)
	if n := g.ticks(3); n != 0 {
		t.Fatalf("continued while the mod says working: %d", n)
	}
	// It reports idle: the run goes on, once.
	e.do("POST", "/api/agent/status", map[string]string{"status": "idle"}, bearer(g.sess))
	if n := g.ticks(3); n != 1 {
		t.Fatalf("continuations after idle = %d, want 1", n)
	}
}
