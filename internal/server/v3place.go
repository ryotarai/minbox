package server

import (
	"context"
	"fmt"
	"log"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/ryotarai/minbox/internal/store"
)

// Every message belongs to exactly one task (docs/v3/redesign.md §4.5). The agent places its messages and the
// person's; minbox never picks a task for it. When a turn ends with messages of the session in no
// task, minbox asks the agent to place them: a request delivered like the person's messages (so every
// integration, an old one too, takes it as a turn), after each turn that leaves some, for as long as
// some are left. Not while the agent is in a turn, has a message on its way, or waits on one of its
// questions. Asking again about the same messages waits longer each time (placeWait, doubling, at
// most placeWaitMax), so an agent that does not do it is not kept busy.

var (
	// placeSettle: the agent must have been idle this long before minbox asks (tests shorten it).
	placeSettle = 1500 * time.Millisecond
	// placeWait: the wait before asking again about the same messages (MINBOX_PLACE_WAIT_S).
	placeWait    = envSeconds("MINBOX_PLACE_WAIT_S", 30*time.Second)
	placeWaitMax = 10 * time.Minute
)

func envSeconds(name string, def time.Duration) time.Duration {
	if n, err := strconv.ParseFloat(os.Getenv(name), 64); err == nil && n >= 0 {
		return time.Duration(n * float64(time.Second))
	}
	return def
}

type placeState struct {
	n     int             // requests sent about (some of) the same messages
	last  time.Time       // the last one
	asked map[string]bool // the messages it asked about
	timer *time.Timer
}

// placeMu: one check at a time (a timer's and a direct one never both ask).
var placeMu sync.Mutex

var places = struct {
	sync.Mutex
	m map[string]*placeState
}{m: map[string]*placeState{}}

// schedulePlace checks the session's unplaced messages after d (replacing a check already waiting).
func (s *Server) schedulePlace(sessionID string, d time.Duration) {
	places.Lock()
	defer places.Unlock()
	st := places.m[sessionID]
	if st == nil {
		st = &placeState{}
		places.m[sessionID] = st
	}
	if st.timer != nil {
		st.timer.Stop()
	}
	st.timer = time.AfterFunc(d, func() {
		select {
		case <-s.closing:
			return
		default:
		}
		s.placeCheck(sessionID)
	})
}

// placeCheck asks the agent to place its unplaced messages when it is ready for it (see above).
func (s *Server) placeCheck(sessionID string) {
	placeMu.Lock()
	defer placeMu.Unlock()
	ctx := context.Background()
	s.settlePlaceRequests(ctx, sessionID)
	sess, err := s.store.GetSession(ctx, sessionID)
	if err != nil || sess.ArchivedAt != nil {
		return
	}
	if sess.Status != store.StatusIdle || sess.Undelivered > 0 {
		return // in a turn, ended (asked when it is idle again), or a message is on its way
	}
	now := time.Now()
	idle, ok := idleSince(sessionID)
	if !ok {
		return
	}
	if wait := placeSettle - now.Sub(idle); wait > 0 {
		s.schedulePlace(sessionID, wait)
		return
	}
	unplaced, err := s.store.UnplacedMessages(ctx, sessionID)
	if err != nil {
		log.Printf("place %s: %v", sessionID, err)
		return
	}
	places.Lock()
	st := places.m[sessionID]
	if st == nil {
		st = &placeState{}
		places.m[sessionID] = st
	}
	if len(unplaced) == 0 {
		st.n, st.asked = 0, nil
		places.Unlock()
		return
	}
	again := false
	for _, u := range unplaced {
		again = again || st.asked[u.ID]
	}
	if !again {
		st.n = 0
	}
	if st.n > 0 {
		if !idle.After(st.last) {
			places.Unlock()
			return // it has not taken the last request yet
		}
		wait := placeWait << min(st.n-1, 20)
		if wait > placeWaitMax || wait < 0 {
			wait = placeWaitMax
		}
		if left := wait - now.Sub(st.last); left > 0 {
			places.Unlock()
			s.schedulePlace(sessionID, left)
			return
		}
	}
	places.Unlock()
	// Waiting on the person: none while one of its questions is open.
	if s.sessionAsking(ctx, sessionID) {
		return
	}
	stream, err := s.store.StreamThread(ctx, sessionID)
	if err != nil {
		return
	}
	ids := make([]string, len(unplaced))
	for i, u := range unplaced {
		ids[i] = u.ID
	}
	body := s.placePrompt(ctx, sess, unplaced)
	words := fmt.Sprintf("Asked %s to put %d message(s) in tasks.", sess.Name, len(unplaced))
	msg, err := s.store.AddMessage(ctx, stream, store.NewMessage{Author: store.AuthorUser, Body: body, Words: words, Kind: store.KindPlace})
	if err != nil {
		log.Printf("place %s: %v", sessionID, err)
		return
	}
	_ = s.store.SetDecision(ctx, msg.ID, "", "", ids)
	places.Lock()
	st.n++
	st.last = now
	st.asked = map[string]bool{}
	for _, id := range ids {
		st.asked[id] = true
	}
	places.Unlock()
	s.modLog(sessionID, "place", "asked to place %d message(s)", len(ids))
	s.publishThread(sessionID, stream)
	s.wakePending(sessionID)
}

// sessionAsking: one of the session's questions waits on the person.
func (s *Server) sessionAsking(ctx context.Context, sessionID string) bool {
	ths, err := s.store.ListThreads(ctx, sessionID)
	if err != nil {
		return false
	}
	v, err := s.loadView(ctx, ths)
	if err != nil {
		return false
	}
	for _, m := range v.msgs {
		if m.Open > 0 {
			return true
		}
	}
	return false
}

// placePrompt is the request the agent gets: the messages, its open tasks, and how to place them.
func (s *Server) placePrompt(ctx context.Context, sess *store.Session, unplaced []store.Unplaced) string {
	var b strings.Builder
	b.WriteString("minbox: these messages of your conversation with the person are in no task yet. Every message belongs to exactly one task (the person follows the work by task), so put each of them in one now:\n")
	for i, u := range unplaced {
		if i == 20 {
			fmt.Fprintf(&b, "- … and %d more (list_threads / read_thread show them)\n", len(unplaced)-20)
			break
		}
		who := "you"
		if u.Author == store.AuthorUser {
			who = "the person"
		}
		if u.Kind == store.KindCommand {
			who = "the person's command"
		}
		fmt.Fprintf(&b, "- %s (%s, %s): %q\n", u.ID, who, u.CreatedAt.Local().Format("Jan 2 15:04"), truncRunes(strings.Join(strings.Fields(u.Text), " "), 160))
	}
	open := []string{}
	if ts, err := s.store.ListTasks(ctx, store.TaskQuery{ProjectID: sess.ProjectID, SessionID: sess.ID}); err == nil {
		for _, t := range ts {
			if t.Status != store.TaskDone && len(open) < 15 {
				open = append(open, fmt.Sprintf("%s %q (%s)", t.ID, t.Title, t.Status))
			}
		}
	}
	if len(open) > 0 {
		b.WriteString("\nYour open tasks: " + strings.Join(open, "; ") + ". (list_tasks with all: true lists every open task of the project.)\n")
	} else {
		b.WriteString("\nYou have no open tasks. (list_tasks with all: true lists every open task of the project.)\n")
	}
	b.WriteString("\nFor each message: if it is about an existing task, call update_task with that task_id and message_ids; if it is new work, or fits no task, call create_task with message_ids (a quick exchange that is already over: create_task with status done and a short title). One call can take several messages. Nothing needs to be sent to the person for this; if you do write to them, pass task_id.")
	return b.String()
}

// settlePlaceRequests: a request to place messages belongs, once they all are in tasks, to the task
// of the newest of them (a message belongs to one task).
func (s *Server) settlePlaceRequests(ctx context.Context, sessionID string) {
	reqs, err := s.store.OpenPlaceRequests(ctx, sessionID)
	if err != nil || len(reqs) == 0 {
		return
	}
	for _, r := range reqs {
		tags, err := s.store.TasksOf(ctx, r.Targets)
		if err != nil {
			continue
		}
		task := ""
		all := len(r.Targets) > 0
		for _, id := range r.Targets {
			if len(tags[id]) == 0 {
				if _, _, err := s.store.MessageSession(ctx, id); err == nil {
					all = false
				}
				continue
			}
			task = tags[id][0].TaskID
		}
		if !all || task == "" {
			continue
		}
		_, _ = s.store.PlaceMessages(ctx, task, []string{r.ID}, store.LinkAuto)
	}
}

// withTurns adds to message ids the person's messages that an agent reply among them answered and
// that are in no task yet: putting a reply in a task puts its turn there too.
func (s *Server) withTurns(ctx context.Context, ids []string) []string {
	out := append([]string{}, ids...)
	for _, id := range ids {
		m, err := s.store.GetMessage(ctx, id)
		if err != nil || m.Author != store.AuthorAgent || len(m.TurnOf) == 0 {
			continue
		}
		untagged, _ := s.untaggedOf(ctx, m.TurnOf)
		for _, u := range untagged {
			out = appendNew(out, u)
		}
	}
	return out
}

// unplacedNote is what send_message answers when the message went in no task.
func unplacedNote(ids []string) string {
	return "This message is in no task yet, nor are the person's messages it answers (" + strings.Join(ids, ", ") + "). Every message must be about a task: put them in one now with update_task (task_id, message_ids) or create_task (message_ids; status done for a quick exchange that is over), and pass task_id on your next send_message."
}
