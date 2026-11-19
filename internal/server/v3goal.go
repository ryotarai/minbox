package server

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"log"
	"net/http"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/ryotarai/minbox/internal/notify"
	"github.com/ryotarai/minbox/internal/store"
)

// Goals' autonomous runs (docs/v3/redesign.md §12): while a goal's run is on, minbox continues its
// agent whenever it is idle with nothing queued, until the goal is met, it needs the person (a
// tagged question is open: the run waits), or a limit hits. Emulated the same way for every agent.

const (
	goalDefaultTurns = 20
	goalMaxTurns     = 200
	goalDefaultFor   = 4 * time.Hour
)

// goalSettle: the agent must have been idle this long before the next continuation (tests shorten it).
var goalSettle = 1500 * time.Millisecond

// The run's guards pause it (state paused, Reason too_fast or no_progress; the person resumes it)
// when it spins or stalls, as Claude Code pauses a session resumed too often. They are checked each
// time minbox is about to continue the agent, so they count the turns minbox started:
//   - too_fast: goalFastCount continuations were sent within goalFastWindow (the next one would make
//     more), or goalFastStreak turns in a row ended within goalFastTurn of their continuation (the
//     agent went idle again almost at once: an error, a refusal, a no-op).
//   - no_progress: goalStillTurns turns in a row ended with no progress. Progress is any change to
//     the goal's criteria (text or ticks), its status or steps, or its tasks (a new one, a status or
//     a ticked step). Messages alone are not progress: a stuck agent still writes "working on it".
//
// Tests lower them.
var (
	goalFastCount  = 5
	goalFastWindow = 2 * time.Minute
	goalFastStreak = 3
	goalFastTurn   = 10 * time.Second
	goalStillTurns = 3
)

// KindContinue marks minbox's continuation message of a goal's run (a message from the person's
// side, delivered like theirs, shown as a small note).
const KindContinue = "continue"

var goalIdle = struct {
	sync.Mutex
	at map[string]time.Time // session → when it last reported idle
	// seeded: the time in at was not reported but taken after a restart (resumeIdle): the turn that
	// ended then is not timed by the guards.
	seeded map[string]bool
}{at: map[string]time.Time{}, seeded: map[string]bool{}}

func noteIdle(sessionID string) {
	goalIdle.Lock()
	goalIdle.at[sessionID] = time.Now()
	delete(goalIdle.seeded, sessionID)
	goalIdle.Unlock()
}

func idleSince(sessionID string) (time.Time, bool) {
	goalIdle.Lock()
	defer goalIdle.Unlock()
	t, ok := goalIdle.at[sessionID]
	return t, ok
}

// seedIdle records an idle time minbox did not hear (see resumeIdle); false when one is known already.
func seedIdle(sessionID string, at time.Time) bool {
	goalIdle.Lock()
	defer goalIdle.Unlock()
	if _, ok := goalIdle.at[sessionID]; ok {
		return false
	}
	goalIdle.at[sessionID] = at
	goalIdle.seeded[sessionID] = true
	return true
}

func idleSeeded(sessionID string) bool {
	goalIdle.Lock()
	defer goalIdle.Unlock()
	return goalIdle.seeded[sessionID]
}

// forgetIdle drops what minbox knows of a session's idle time (tests: a restart).
func forgetIdle(sessionID string) {
	goalIdle.Lock()
	delete(goalIdle.at, sessionID)
	delete(goalIdle.seeded, sessionID)
	goalIdle.Unlock()
}

// Resuming after a restart: the idle times above live in memory, so after a restart minbox knows none
// and a running goal would wait for its agent to report idle again, which an agent that was already
// idle never does. resumeIdle takes the agent as idle from now when its stored status is idle with
// nothing queued, and its mod, heard from since the start, does not say it is working (its heartbeat
// state; a mod that sends no heartbeats counts once it has been heard from for a stale period without
// one). The run then goes on after goalSettle, as after any idle. An agent in a turn has the stored
// status working (or a heartbeat saying so) and is left alone until it reports idle. The seeded idle
// is no turn's end: the guards do not time it (a restart is no fast turn), and the turn count, the
// recent continuations and the progress mark carry over from the stored run.
func (s *Server) resumeIdle(sess *store.Session) bool {
	if sess.Status != store.StatusIdle || sess.Undelivered > 0 || sess.ArchivedAt != nil {
		return false
	}
	if !s.modConfirmsIdle(sess.ID) {
		return false
	}
	if seedIdle(sess.ID, time.Now()) {
		log.Printf("goals: session %s: idle after a restart (stored status idle, its mod agrees); runs go on", sess.ID)
		return true
	}
	return false
}

// modConfirmsIdle: the session's mod has been heard from since minbox started, is not stale, and does
// not say it is working.
func (s *Server) modConfirmsIdle(id string) bool {
	now := s.nowFn()
	s.modMu.Lock()
	defer s.modMu.Unlock()
	c := s.modConns[id]
	if c == nil || c.lastContact.IsZero() || c.stale {
		return false
	}
	if c.hb {
		return c.modState == store.StatusIdle
	}
	return now.Sub(c.firstSeen) > s.modStaleAfter
}

// goalResumeKick: a mod spoke (hello, heartbeat) for a session whose idle time minbox does not know
// (after a restart): tick the runs, which may now take it as idle (resumeIdle).
func (s *Server) goalResumeKick(id string) {
	if _, ok := idleSince(id); !ok {
		s.kickGoals()
	}
}

// kickGoals ticks the runs now, off the caller's request (the ticker does it every few seconds
// anyway; this only spares the wait).
func (s *Server) kickGoals() {
	if !s.manualGoalTicks.Load() {
		go s.goalTick()
	}
}

// goalAgent is the session that pursues a goal: the run's, else its first assigned agent.
func goalAgent(t *store.Task) string {
	if t.Auto.SessionID != "" {
		return t.Auto.SessionID
	}
	for _, a := range t.Agents {
		if a.Role == store.RoleAssigned {
			return a.SessionID
		}
	}
	if len(t.Agents) > 0 {
		return t.Agents[0].SessionID
	}
	return t.CreatedBy
}

// The run (Task.Auto) is changed by the person, the agent and the ticks at once, so every change is
// made to the stored run in one step (store.UpdateAuto), never by writing back a copy read earlier:
// that would undo a change made in between (a pause, a stop, a new time limit) and could let a run go
// on past its limits.

func (s *Server) startAuto(ctx context.Context, t *store.Task, sessionID string, maxTurns int, by string) {
	if sessionID == "" {
		sessionID = goalAgent(t)
	}
	if maxTurns <= 0 {
		maxTurns = goalDefaultTurns
	}
	maxTurns = min(maxTurns, goalMaxTurns)
	until := time.Now().Add(goalDefaultFor)
	a, _, err := s.store.UpdateAuto(ctx, t.ID, func(a *store.AutoRun) bool {
		if a.State == store.AutoPaused && a.SessionID == sessionID {
			// Resume: the guards start over.
			a.State, a.Reason, a.ReasonText = store.AutoRunning, "", ""
			a.Recent, a.FastTurns, a.StillTurns, a.Mark = nil, 0, 0, ""
		} else {
			*a = store.AutoRun{State: store.AutoRunning, SessionID: sessionID, MaxTurns: maxTurns, Until: &until}
		}
		return true
	})
	if err != nil {
		log.Printf("goal %s: start: %v", t.ID, err)
		return
	}
	t.Auto = a
	_, _ = s.store.AddTaskAgent(ctx, t.ID, sessionID, store.RoleAssigned)
	who := ""
	if by != "" {
		who = " (" + by + ")"
	}
	_ = s.store.AddTaskEvent(ctx, t.ID, "auto", fmt.Sprintf("Autonomous run on%s · up to %d turns", who, a.MaxTurns), sessionID, "")
	s.publishTasks()
	s.kickGoals()
}

// stopAuto ends a run that is on or paused: reason is a code (store.AutoReason*), text says it for
// the person. False when it was neither (anymore).
func (s *Server) stopAuto(ctx context.Context, t *store.Task, reason, text string) bool {
	return s.endAuto(ctx, t, nil, false, reason, text)
}

// pauseAuto pauses a run that is on (the person resumes it): reason is a code, text says it for the
// person. False when it was not on (anymore).
func (s *Server) pauseAuto(ctx context.Context, t *store.Task, reason, text string) bool {
	return s.endAuto(ctx, t, nil, true, reason, text)
}

// endAuto pauses or stops a run and records it on the goal's timeline. from is the run as the caller
// read it: when set (a tick, whose decision rests on that run), the change is made only if the stored
// run is still exactly that, and to t.Auto (which may carry the guards' counts); when nil (the
// person, the agent), it is made to the stored run as it is now. False when nothing changed.
func (s *Server) endAuto(ctx context.Context, t *store.Task, from *store.AutoRun, pause bool, reason, text string) bool {
	state, prefix := store.AutoStopped, "Autonomous run ended: "
	if pause {
		state, prefix = store.AutoPaused, "Autonomous run paused: "
	}
	var ok bool
	var err error
	if from != nil {
		next := t.Auto
		next.State, next.Reason, next.ReasonText = state, reason, text
		if ok, err = s.store.CompareAndSetAuto(ctx, t.ID, *from, next); ok {
			t.Auto = next
		}
	} else {
		var a store.AutoRun
		a, ok, err = s.store.UpdateAuto(ctx, t.ID, func(a *store.AutoRun) bool {
			if a.State != store.AutoRunning && (pause || a.State != store.AutoPaused) {
				return false
			}
			a.State, a.Reason, a.ReasonText = state, reason, text
			return true
		})
		if ok {
			t.Auto = a
		}
	}
	if err != nil {
		log.Printf("goal %s: %s: %v", t.ID, state, err)
	}
	if !ok {
		return false
	}
	_ = s.store.AddTaskEvent(ctx, t.ID, "auto", prefix+text, t.Auto.SessionID, "")
	s.publishTasks()
	return true
}

// haltAuto pauses or stops a run that halted by itself without meeting the goal (from: the run the
// tick read, see endAuto), and tells the person through the notification destinations (as a message
// that needs them), since the goal now waits on them.
func (s *Server) haltAuto(ctx context.Context, t *store.Task, from *store.AutoRun, pause bool, reason, text string) {
	verb := "stopped"
	if pause {
		verb = "paused"
	}
	if !s.endAuto(ctx, t, from, pause, reason, text) {
		return
	}
	sess, err := s.store.GetSession(ctx, t.Auto.SessionID)
	if err != nil {
		return
	}
	stream, _ := s.store.StreamThread(ctx, sess.ID)
	next := "Start a new run from the goal when you are ready."
	if pause {
		next = "Resume it from the goal when you are ready."
	}
	n := notify.Notification{
		Session: sess.Name, Title: t.Title, ThreadID: stream, From: "minbox", NeedsAction: true,
		Body:   fmt.Sprintf("The autonomous run of the goal \"%s\" %s: %s. %s", t.Title, verb, text, next),
		TaskID: t.ID, TaskTitle: t.Title, TaskStatus: t.Status,
	}
	if sess.ProjectID != "" {
		if p, err := s.store.GetProject(ctx, sess.ProjectID); err == nil {
			n.Project = p.Name
		}
	}
	pub := s.publicURL(ctx)
	n.TaskLink = taskLinkURL(pub, t.ID, "")
	n.Link = n.TaskLink
	if n.Link == "" {
		n.Link = threadLinkURL(pub, sess.ID, stream)
	}
	s.notifier.Dispatch(n)
}

// POST /api/v3/tasks/{id}/auto {action: start|pause|stop, session_id?, max_turns?}: the person runs a goal.
func (s *Server) v3Auto(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Action    string `json:"action"`
		SessionID string `json:"session_id"`
		MaxTurns  int    `json:"max_turns"`
	}
	if !decode(w, r, &body) {
		return
	}
	ctx := r.Context()
	t, err := s.store.GetTask(ctx, r.PathValue("id"))
	if err != nil {
		storeError(w, err)
		return
	}
	switch body.Action {
	case "start":
		if t.Kind != store.KindGoal {
			k := store.KindGoal
			t, err = s.store.UpdateTask(ctx, t.ID, "", store.TaskFields{Kind: &k})
			if err != nil {
				storeError(w, err)
				return
			}
		}
		if t.Status == store.TaskDone {
			wk := store.TaskWorking
			t, _ = s.store.UpdateTask(ctx, t.ID, "", store.TaskFields{Status: &wk})
		}
		if goalAgent(t) == "" && body.SessionID == "" {
			httpError(w, 400, "the goal has no agent: pass session_id")
			return
		}
		s.startAuto(ctx, t, body.SessionID, body.MaxTurns, "you")
	case "pause":
		if !s.pauseAuto(ctx, t, store.AutoReasonByYou, "by you") {
			httpError(w, 409, "the run is not on")
			return
		}
	case "stop":
		s.stopAuto(ctx, t, store.AutoReasonByYou, "by you") // a run that is neither on nor paused stays as it is
	default:
		httpError(w, 400, "action must be start, pause or stop")
		return
	}
	t, _ = s.store.GetTask(ctx, t.ID)
	writeJSON(w, 200, t)
}

// runGoals ticks the runs until the server closes.
func (s *Server) runGoals(every time.Duration) {
	tk := time.NewTicker(every)
	defer tk.Stop()
	for {
		select {
		case <-s.closing:
			return
		case <-tk.C:
			if !s.manualGoalTicks.Load() {
				s.goalTick()
			}
		}
	}
}

var goalTickMu sync.Mutex

// goalTick continues every running goal whose agent is ready for it.
func (s *Server) goalTick() {
	goalTickMu.Lock()
	defer goalTickMu.Unlock()
	ctx := context.Background()
	goals, err := s.store.RunningGoals(ctx)
	if err != nil {
		log.Printf("goals: %v", err)
		return
	}
	for i := range goals {
		s.goalStep(ctx, &goals[i])
	}
}

// goalStep decides on one running goal from the run as goalTick read it (from). The person or the
// agent may change the run meanwhile (pause, stop, a new limit), so what it decides is stored only
// if the run is still that one (CompareAndSetAuto); otherwise the next tick decides again.
func (s *Server) goalStep(ctx context.Context, g *store.Task) {
	from := g.Auto
	a := g.Auto
	now := time.Now()
	met := len(g.Criteria) > 0
	for _, c := range g.Criteria {
		met = met && c.Done
	}
	switch {
	case g.Status == store.TaskDone || met:
		if g.Status != store.TaskDone {
			d := store.TaskDone
			_, _ = s.store.UpdateTask(ctx, g.ID, a.SessionID, store.TaskFields{Status: &d})
		}
		s.stopAuto(ctx, g, store.AutoReasonMet, "met")
		return
	case a.Until != nil && now.After(*a.Until):
		s.haltAuto(ctx, g, &from, false, store.AutoReasonTimeLimit, "time limit")
		return
	case a.MaxTurns > 0 && a.Turns >= a.MaxTurns:
		s.haltAuto(ctx, g, &from, false, store.AutoReasonTurnLimit, fmt.Sprintf("turn limit (%d)", a.MaxTurns))
		return
	}
	sess, err := s.store.GetSession(ctx, a.SessionID)
	if err != nil || sess.ArchivedAt != nil {
		s.stopAuto(ctx, g, store.AutoReasonAgentGone, "its agent is gone")
		return
	}
	if sess.Status != store.StatusIdle || sess.Undelivered > 0 {
		return // working, starting, ended, or a message is on its way
	}
	idle, ok := idleSince(sess.ID)
	if !ok {
		s.resumeIdle(sess) // after a restart: idle from now when its mod agrees, settled next tick
		return
	}
	seeded := idleSeeded(sess.ID)
	if now.Sub(idle) < goalSettle || (a.LastAt != nil && !idle.After(*a.LastAt)) {
		return // not idle since the last continuation (it has not taken it yet)
	}
	if seeded && !s.modConfirmsIdle(sess.ID) {
		return // taken as idle after a restart, but its mod now says it works
	}
	// Waiting on the person: a question tagged with the goal or its tasks is open.
	if s.goalNeedsYou(ctx, g) {
		return
	}
	// The agent has ended a turn: the guards decide whether it may go on.
	if reason, text := goalGuard(&a, now, idle, s.goalMark(ctx, g), !seeded); reason != "" {
		g.Auto = a
		s.haltAuto(ctx, g, &from, true, reason, text)
		return
	}
	stream, err := s.store.StreamThread(ctx, sess.ID)
	if err != nil {
		return
	}
	body := goalPrompt(g, a.Turns+1, a.MaxTurns)
	// Take the turn before sending it, and only from the run read above: a run paused, stopped or
	// given a new limit since sends nothing (the next tick decides on it as it is now).
	took := a
	took.Turns++
	took.LastAt = &now
	took.Recent = append(took.Recent, now)
	if ok, err := s.store.CompareAndSetAuto(ctx, g.ID, from, took); err != nil || !ok {
		if err != nil {
			log.Printf("goal %s: %v", g.ID, err)
		}
		return
	}
	msg, err := s.store.AddMessage(ctx, stream, store.NewMessage{Author: store.AuthorUser, Body: body, Kind: KindContinue})
	if err != nil {
		log.Printf("goal %s: %v", g.ID, err)
		_, _ = s.store.CompareAndSetAuto(ctx, g.ID, took, from) // give the turn back
		return
	}
	_, _ = s.store.LinkMessages(ctx, g.ID, []string{msg.ID}, store.LinkAuto)
	s.publishThread(sess.ID, stream)
	s.publishTasks()
	s.wakePending(sess.ID)
}

func (s *Server) goalNeedsYou(ctx context.Context, g *store.Task) bool {
	ids := []string{g.ID}
	if ts, err := s.store.ListTasks(ctx, store.TaskQuery{ProjectID: g.ProjectID}); err == nil {
		for _, t := range ts {
			if t.ParentID == g.ID && t.Status != store.TaskDone {
				if t.Status == store.TaskNeedsYou {
					return true
				}
				ids = append(ids, t.ID)
			}
		}
	}
	threads := map[string]bool{}
	for _, id := range ids {
		mids, _ := s.store.TaskMessageIDs(ctx, id)
		for _, m := range mids {
			if th, err := s.store.ThreadOfMessage(ctx, m); err == nil {
				threads[th] = true
			}
		}
	}
	list := []string{}
	for th := range threads {
		list = append(list, th)
	}
	ths, err := s.store.ThreadsOf(ctx, list)
	if err != nil {
		return false
	}
	v, err := s.loadView(ctx, ths)
	if err != nil {
		return false
	}
	want := map[string]bool{}
	for _, id := range ids {
		want[id] = true
	}
	for _, m := range v.msgs {
		if m.Open == 0 {
			continue
		}
		for _, tg := range m.Tasks {
			if want[tg.TaskID] {
				return true
			}
		}
	}
	return g.Status == store.TaskNeedsYou
}

// goalPrompt is the continuation the agent gets.
func goalPrompt(g *store.Task, turn, max int) string {
	var b strings.Builder
	fmt.Fprintf(&b, "minbox goal (autonomous run, turn %d of %d): keep working toward this goal on your own.\n\n", turn, max)
	fmt.Fprintf(&b, "Goal %s: %s\n", g.ID, g.Title)
	if g.Summary != "" {
		fmt.Fprintf(&b, "%s\n", g.Summary)
	}
	if len(g.Criteria) > 0 {
		b.WriteString("\nDone when:\n")
		for i, c := range g.Criteria {
			box := " "
			if c.Done {
				box = "x"
			}
			fmt.Fprintf(&b, "%d. [%s] %s\n", i+1, box, c.Text)
		}
	}
	b.WriteString("\nDo the next useful step now. When a criterion is met, tick it (update_task with check_criteria); when all are met, or the goal cannot be reached, report with send_message task_status done (that sets the goal done). If you need the person, ask with a :::question block and task_status needs_you: the run waits for their answer. Report progress with send_message (task_id: the goal or its task; task_status working).")
	return b.String()
}

// goalGuard counts the turn that just ended (idle: when the agent went idle; mark: the goal's
// progress mark now) and says why the run must pause ("" when it may go on). See goalFastCount.
// The turn before the first continuation of a run (or of a resume) is not minbox's: only its mark
// is taken. timed is false when the idle time was not reported but taken after a restart: that
// turn's length is unknown, so it neither counts as fast nor ends a streak.
func goalGuard(a *store.AutoRun, now, idle time.Time, mark string, timed bool) (reason, text string) {
	if a.Mark != "" && a.LastAt != nil {
		switch {
		case !timed: // a restart: the fast streak stays as it was
		case idle.Sub(*a.LastAt) < goalFastTurn:
			a.FastTurns++
		default:
			a.FastTurns = 0
		}
		if mark == a.Mark {
			a.StillTurns++
		} else {
			a.StillTurns = 0
		}
	}
	a.Mark = mark
	recent := a.Recent[:0:0]
	for _, t := range a.Recent {
		if now.Sub(t) < goalFastWindow {
			recent = append(recent, t)
		}
	}
	a.Recent = recent
	switch {
	case len(a.Recent) >= goalFastCount:
		return store.AutoReasonTooFast, fmt.Sprintf("continued %d times in %s", len(a.Recent), spanText(goalFastWindow))
	case a.FastTurns >= goalFastStreak:
		return store.AutoReasonTooFast, fmt.Sprintf("%d turns in a row ended within %s", a.FastTurns, spanText(goalFastTurn))
	case a.StillTurns >= goalStillTurns:
		return store.AutoReasonNoProgress, fmt.Sprintf("no progress in %d turns", a.StillTurns)
	}
	return "", ""
}

// goalMark sums up a goal's progress: it changes when a criterion is ticked or changed, the goal's
// status or steps change, or one of its tasks is added, changes status or ticks a step.
func (s *Server) goalMark(ctx context.Context, g *store.Task) string {
	h := sha256.New()
	w := func(parts ...string) { fmt.Fprintln(h, strings.Join(parts, "\x1f")) }
	var steps func(ss []store.TaskStep)
	steps = func(ss []store.TaskStep) {
		for _, c := range ss {
			w(c.Text, fmt.Sprint(c.Done))
			steps(c.Steps)
		}
	}
	w("goal", g.Status)
	steps(g.Criteria)
	w("steps")
	steps(g.Steps)
	if ts, err := s.store.ListTasks(ctx, store.TaskQuery{ProjectID: g.ProjectID}); err == nil {
		sort.Slice(ts, func(i, j int) bool { return ts[i].ID < ts[j].ID })
		for _, t := range ts {
			if t.ParentID == g.ID {
				w("task", t.ID, t.Status)
				steps(t.Steps)
			}
		}
	}
	return hex.EncodeToString(h.Sum(nil))[:16]
}

// spanText says a duration in words: "2 minutes", "10 seconds".
func spanText(d time.Duration) string {
	n, unit := int(d/time.Second), "second"
	if d >= time.Minute && d%time.Minute == 0 {
		n, unit = int(d/time.Minute), "minute"
	}
	if n != 1 {
		unit += "s"
	}
	return fmt.Sprintf("%d %s", n, unit)
}
