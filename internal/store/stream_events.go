package store

import (
	"context"
	"strings"
	"time"
)

// StreamTaskEvent is a change of a task an agent works on, as the agent's stream shows it between
// the messages: the task was created, its status changed (or it was reopened), or it was renamed.
// Step and criterion ticks are left out: they show in the checklist, and a line for each would bury
// the conversation.
type StreamTaskEvent struct {
	ID     string    `json:"id"`
	TaskID string    `json:"task_id"`
	At     time.Time `json:"at"`
	Kind   string    `json:"kind"` // created | status | title
	// Title: the task's title now; TaskKind: "goal" for a goal.
	Title    string `json:"title"`
	TaskKind string `json:"task_kind,omitempty"`
	// Status: the status a status event set. Reopened: it moved out of done.
	Status   string `json:"status,omitempty"`
	Reopened bool   `json:"reopened,omitempty"`
	// ByYou: the person made the change (else the agent did).
	ByYou bool `json:"by_you,omitempty"`
	// OldTitle, NewTitle: a rename's titles (OldTitle is "" for a rename stored before it was kept).
	OldTitle string `json:"old_title,omitempty"`
	NewTitle string `json:"new_title,omitempty"`
}

// statusOfEventText reads the status out of a stored status line ("Status → needs you (you)", the
// older bare "→ needs you"); "" when the line names none ("Reopened by your message").
func statusOfEventText(text string) (string, bool) {
	t := strings.TrimSpace(strings.TrimPrefix(text, "Status"))
	if !strings.HasPrefix(t, "→") {
		return "", false
	}
	t = strings.TrimSpace(strings.TrimPrefix(t, "→"))
	you := strings.HasSuffix(t, "(you)")
	t = strings.TrimSpace(strings.TrimSuffix(t, "(you)"))
	for st, w := range map[string]string{TaskWorking: "working", TaskNeedsYou: "needs you", TaskBlocked: "blocked", TaskDone: "done"} {
		if t == w {
			return st, you
		}
	}
	return "", you
}

// SessionTaskEvents returns the creations, status changes and renames of the tasks the session is on
// (assigned or involved) or changed itself, oldest first, in (after, upTo] (a nil bound is open).
func (s *Store) SessionTaskEvents(ctx context.Context, sessionID string, after, upTo *time.Time) ([]StreamTaskEvent, error) {
	q := `SELECT e.id, e.task_id, e.at, e.kind, e.text, e.session_id, t.title, t.kind FROM task_events e JOIN tasks t ON t.id = e.task_id
WHERE e.kind IN ('created', 'status', 'title') AND (e.task_id IN (SELECT task_id FROM task_agents WHERE session_id = ?) OR e.session_id = ?)`
	args := []any{sessionID, sessionID}
	if upTo != nil {
		q += ` AND e.at <= ?`
		args = append(args, ms(*upTo))
	}
	// The whole history up to upTo: a status line needs the one before it to tell a reopening.
	rows, err := s.db.QueryContext(ctx, q+` ORDER BY e.at, e.rowid`, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	all := []StreamTaskEvent{}
	last := map[string]int{}          // task → index in all of its newest status event
	lastStatus := map[string]string{} // task → the status it was last set to
	for rows.Next() {
		var e StreamTaskEvent
		var at int64
		var text, by string
		if err := rows.Scan(&e.ID, &e.TaskID, &at, &e.Kind, &text, &by, &e.Title, &e.TaskKind); err != nil {
			return nil, err
		}
		e.At = fromMs(at)
		switch e.Kind {
		case "created":
			e.ByYou = strings.Contains(text, "by you")
		case "title":
			if r, ok := strings.CutPrefix(text, "Renamed: "); ok {
				// "Renamed: old → new" (a title is one line; an arrow in it reads at the first one).
				e.OldTitle, e.NewTitle, _ = strings.Cut(r, " → ")
			} else {
				e.NewTitle = strings.TrimSuffix(strings.TrimPrefix(text, "Renamed to “"), "”")
			}
			e.ByYou = by == ""
		case "status":
			st, you := statusOfEventText(text)
			if st == "" {
				// "Reopened by your message": it follows the status change it explains.
				if i, ok := last[e.TaskID]; ok && all[i].Reopened && e.At.Sub(all[i].At) < 5*time.Second {
					all[i].ByYou = true
					continue
				}
				if !strings.HasPrefix(text, "Reopened") {
					continue
				}
				st, e.Reopened, e.ByYou = TaskWorking, true, true
			} else {
				e.Reopened = lastStatus[e.TaskID] == TaskDone && st != TaskDone
				e.ByYou = you
			}
			e.Status = st
			lastStatus[e.TaskID] = st
			last[e.TaskID] = len(all)
		}
		all = append(all, e)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	out := []StreamTaskEvent{}
	for _, e := range all {
		if after == nil || e.At.After(*after) {
			out = append(out, e)
		}
	}
	return out, nil
}
