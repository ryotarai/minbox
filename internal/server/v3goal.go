package server

import (
	"context"
	"fmt"
	"log"
	"net/http"
	"strings"
	"sync"
	"time"

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

// KindContinue marks minbox's continuation message of a goal's run (a message from the person's
// side, delivered like theirs, shown as a small note).
const KindContinue = "continue"

var goalIdle = struct {
	sync.Mutex
	at map[string]time.Time // session → when it last reported idle
}{at: map[string]time.Time{}}

func noteIdle(sessionID string) {
	goalIdle.Lock()
	goalIdle.at[sessionID] = time.Now()
	goalIdle.Unlock()
}

func idleSince(sessionID string) (time.Time, bool) {
	goalIdle.Lock()
	defer goalIdle.Unlock()
	t, ok := goalIdle.at[sessionID]
	return t, ok
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

func (s *Server) startAuto(ctx context.Context, t *store.Task, sessionID string, maxTurns int, by string) {
	if sessionID == "" {
		sessionID = goalAgent(t)
	}
	if maxTurns <= 0 {
		maxTurns = goalDefaultTurns
	}
	maxTurns = min(maxTurns, goalMaxTurns)
	until := time.Now().Add(goalDefaultFor)
	a := t.Auto
	if a.State == store.AutoPaused && a.SessionID == sessionID {
		a.State, a.Reason = store.AutoRunning, ""
	} else {
		a = store.AutoRun{State: store.AutoRunning, SessionID: sessionID, MaxTurns: maxTurns, Until: &until}
	}
	_ = s.store.SetAuto(ctx, t.ID, a)
	_, _ = s.store.AddTaskAgent(ctx, t.ID, sessionID, store.RoleAssigned)
	who := ""
	if by != "" {
		who = " (" + by + ")"
	}
	_ = s.store.AddTaskEvent(ctx, t.ID, "auto", fmt.Sprintf("Autonomous run on%s · up to %d turns", who, a.MaxTurns), sessionID, "")
	s.publishTasks()
	go s.goalTick()
}

func (s *Server) stopAuto(ctx context.Context, t *store.Task, reason string) {
	a := t.Auto
	a.State, a.Reason = store.AutoStopped, reason
	_ = s.store.SetAuto(ctx, t.ID, a)
	_ = s.store.AddTaskEvent(ctx, t.ID, "auto", "Autonomous run ended: "+reason, a.SessionID, "")
	s.publishTasks()
}

func (s *Server) pauseAuto(ctx context.Context, t *store.Task, reason string) {
	a := t.Auto
	a.State, a.Reason = store.AutoPaused, reason
	_ = s.store.SetAuto(ctx, t.ID, a)
	_ = s.store.AddTaskEvent(ctx, t.ID, "auto", "Autonomous run paused: "+reason, a.SessionID, "")
	s.publishTasks()
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
		if t.Auto.State != store.AutoRunning {
			httpError(w, 409, "the run is not on")
			return
		}
		s.pauseAuto(ctx, t, "by you")
	case "stop":
		if t.Auto.State == store.AutoRunning || t.Auto.State == store.AutoPaused {
			s.stopAuto(ctx, t, "stopped by you")
		}
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
			s.goalTick()
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

func (s *Server) goalStep(ctx context.Context, g *store.Task) {
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
		s.stopAuto(ctx, g, "met")
		return
	case a.Until != nil && now.After(*a.Until):
		s.stopAuto(ctx, g, "time limit")
		return
	case a.MaxTurns > 0 && a.Turns >= a.MaxTurns:
		s.stopAuto(ctx, g, fmt.Sprintf("turn limit (%d)", a.MaxTurns))
		return
	}
	sess, err := s.store.GetSession(ctx, a.SessionID)
	if err != nil || sess.ArchivedAt != nil {
		s.stopAuto(ctx, g, "its agent is gone")
		return
	}
	if sess.Status != store.StatusIdle || sess.Undelivered > 0 {
		return // working, starting, ended, or a message is on its way
	}
	idle, ok := idleSince(sess.ID)
	if !ok || now.Sub(idle) < goalSettle || (a.LastAt != nil && !idle.After(*a.LastAt)) {
		return // not idle since the last continuation (it has not taken it yet)
	}
	// Waiting on the person: a question tagged with the goal or its tasks is open.
	if s.goalNeedsYou(ctx, g) {
		return
	}
	stream, err := s.store.StreamThread(ctx, sess.ID)
	if err != nil {
		return
	}
	body := goalPrompt(g, a.Turns+1, a.MaxTurns)
	msg, err := s.store.AddMessage(ctx, stream, store.NewMessage{Author: store.AuthorUser, Body: body, Kind: KindContinue})
	if err != nil {
		log.Printf("goal %s: %v", g.ID, err)
		return
	}
	_, _ = s.store.LinkMessages(ctx, g.ID, []string{msg.ID}, store.LinkAuto)
	a.Turns++
	a.LastAt = &now
	_ = s.store.SetAuto(ctx, g.ID, a)
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
	b.WriteString("\nDo the next useful step now. When a criterion is met, tick it (update_task with check_criteria); when all are met, or the goal cannot be reached, set the goal's status to done and report with send_message. If you need the person, ask with a :::question block: the run waits for their answer. Report progress with send_message (task_id: the goal or its task).")
	return b.String()
}
