package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"sort"
	"strings"
	"time"
)

// v3 (docs/v3/redesign.md): the conversation with an agent is one stream per session, and the work
// is tasks; every message belongs to exactly one task (message_tasks keeps at most one row per
// message: a unique index since the v3_one_task migration, tasks_onetask.go). Internally each session has one stream thread
// (threads.kind = 'stream') that new messages go to; its older threads stay as they were and read
// as segments of the same stream. A task belongs to a project; its messages may come from any
// session's stream.

// ThreadStream is the kind of a session's stream thread.
const ThreadStream = "stream"

// Task statuses.
const (
	TaskWorking  = "working"
	TaskNeedsYou = "needs_you"
	TaskBlocked  = "blocked"
	TaskDone     = "done"
)

// Where a message's tag came from.
const (
	LinkAgent  = "agent"  // the agent named the task (send_message task_id, create_task, update_task message_ids)
	LinkAuto   = "auto"   // a rule: inherited from the messages a reply answers, a reply sent from a task, an answer
	LinkPerson = "person" // the person added it
)

// The agent's decision about the person's messages a reply answers (Message.Decision).
const (
	DecisionExisting = "existing" // about a task that existed
	DecisionCreated  = "created"  // new work: the agent created the task in this turn
	DecisionNone     = "none"     // the reply named no task (minbox asks the agent to place it after the turn)
	DecisionMoved    = "moved"    // the person moved the tags to another task
)

// Roles of an agent (session) on a task.
const (
	RoleAssigned = "assigned" // created it, or the person gave it the task
	RoleInvolved = "involved" // wrote a message tagged with it
)

const taskSchema = `
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  detail TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL,
  steps TEXT NOT NULL DEFAULT '[]',
  report TEXT NOT NULL DEFAULT '',
  links TEXT NOT NULL DEFAULT '[]',
  created_by TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  done_at INTEGER,
  manual_status TEXT NOT NULL DEFAULT '',
  manual_at INTEGER,
  origin TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL DEFAULT '',
  parent_id TEXT NOT NULL DEFAULT '',
  criteria TEXT NOT NULL DEFAULT '[]',
  auto TEXT NOT NULL DEFAULT '{}',
  title_by TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS tasks_project ON tasks(project_id, status);
CREATE UNIQUE INDEX IF NOT EXISTS tasks_origin ON tasks(origin) WHERE origin != '';
CREATE TABLE IF NOT EXISTS message_tasks (
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  source TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (message_id, task_id)
);
CREATE INDEX IF NOT EXISTS message_tasks_task ON message_tasks(task_id);
CREATE TABLE IF NOT EXISTS task_agents (
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL,
  role TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (task_id, session_id)
);
CREATE INDEX IF NOT EXISTS task_agents_session ON task_agents(session_id);
CREATE TABLE IF NOT EXISTS task_events (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  at INTEGER NOT NULL,
  kind TEXT NOT NULL,
  text TEXT NOT NULL,
  session_id TEXT NOT NULL DEFAULT '',
  message_id TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS task_events_task ON task_events(task_id, at);
`

// NormalizeTaskStatus maps a status or an alias (the older topic and thread statuses too) to its
// canonical value.
func NormalizeTaskStatus(v string) (string, bool) {
	switch strings.ToLower(strings.TrimSpace(strings.ReplaceAll(v, "-", "_"))) {
	case "working", "in_progress", "inprogress", "active", "open", "doing":
		return TaskWorking, true
	case "needs_you", "need_you", "waiting_on_you", "waiting", "need_action", "needs_action", "waiting_on_person", "waiting_for_you":
		return TaskNeedsYou, true
	case "blocked", "stuck", "on_hold":
		return TaskBlocked, true
	case "done", "finished", "resolved", "complete", "completed", "closed", "dropped":
		return TaskDone, true
	}
	return "", false
}

// ErrInvalidTaskStatus: not a task status.
var ErrInvalidTaskStatus = errors.New("status must be working, needs_you, blocked or done")

// TaskStep is one item of a task's checklist; Steps nests one level.
type TaskStep struct {
	Text  string     `json:"text"`
	Done  bool       `json:"done"`
	Steps []TaskStep `json:"steps,omitempty"`
}

// TaskLink is a link of a task: a PR, a Linear issue, anything with a URL.
type TaskLink struct {
	Kind  string `json:"kind"` // pr | linear | link
	Label string `json:"label"`
	URL   string `json:"url"`
	State string `json:"state,omitempty"`
}

// TaskAgent is a session on a task.
type TaskAgent struct {
	SessionID string    `json:"session_id"`
	Role      string    `json:"role"`
	Since     time.Time `json:"since"`
}

// Task is a piece of work.
type Task struct {
	ID        string     `json:"id"`
	ProjectID string     `json:"project_id"`
	Title     string     `json:"title"`
	Summary   string     `json:"summary"`
	Detail    string     `json:"detail"`
	Status    string     `json:"status"`
	Steps     []TaskStep `json:"steps"`
	Report    string     `json:"report"`
	Links     []TaskLink `json:"links"`
	CreatedBy string     `json:"created_by"`
	CreatedAt time.Time  `json:"created_at"`
	UpdatedAt time.Time  `json:"updated_at"`
	DoneAt    *time.Time `json:"done_at"`
	// The person set ManualStatus by hand at ManualAt, until the agent sets a status again.
	ManualStatus string      `json:"manual_status"`
	ManualAt     *time.Time  `json:"manual_at"`
	Agents       []TaskAgent `json:"agents"`
	// Goals (docs/v3/redesign.md §12): Kind is KindGoal for a goal, "" for a task. A task may serve a
	// goal (ParentID). A goal's Criteria are its "done when" checklist; Auto is its autonomous run.
	Kind     string     `json:"kind"`
	ParentID string     `json:"parent_id"`
	Criteria []TaskStep `json:"criteria"`
	Auto     AutoRun    `json:"auto"`
	// TitleBy is who named the task last: TitleByPerson or TitleByAgent ("" for older tasks, as an
	// agent's). An agent's rename of a task the person named is not applied (see agentUpdateTask).
	TitleBy string `json:"title_by"`
}

// Who named a task (Task.TitleBy).
const (
	TitleByPerson = "person"
	TitleByAgent  = "agent"
)

// taskAddedColumns are the columns added to tasks after its first version (taskSchema has them for a
// new database).
var taskAddedColumns = []struct{ table, column, def string }{
	{"tasks", "title_by", "TEXT NOT NULL DEFAULT ''"},
}

// KindGoal is the kind of a goal.
const KindGoal = "goal"

// Autonomous run states of a goal.
const (
	AutoOff     = ""        // the agent works turn by turn, as with any task
	AutoRunning = "running" // minbox continues the agent's turns until the goal is met, it needs the person, or a limit hits
	AutoPaused  = "paused"  // the person paused it, or a guard did (Reason); Start resumes
	AutoStopped = "stopped" // ended: met, stopped by the person, or a limit (Reason)
)

// AutoRun is a goal's autonomous run.
type AutoRun struct {
	State     string     `json:"state"`
	SessionID string     `json:"session_id,omitempty"` // the agent that pursues it
	MaxTurns  int        `json:"max_turns,omitempty"`  // continuation turns at most (0: the default)
	Turns     int        `json:"turns,omitempty"`      // continuation turns sent so far
	Until     *time.Time `json:"until,omitempty"`      // stop after this time
	// Reason is why it stopped or paused, a code (AutoReason*); ReasonText says it for the person.
	Reason     string     `json:"reason,omitempty"`
	ReasonText string     `json:"reason_text,omitempty"`
	LastAt     *time.Time `json:"last_at,omitempty"` // the last continuation
	// The run's guards (internal/server/v3goal.go): when the recent continuations were sent, how many
	// turns in a row ended fast, how many in a row made no progress, and the progress mark of the
	// last continuation. Resuming clears them.
	Recent     []time.Time `json:"recent,omitempty"`
	FastTurns  int         `json:"fast_turns,omitempty"`
	StillTurns int         `json:"still_turns,omitempty"`
	Mark       string      `json:"mark,omitempty"`
}

// Why a goal's run paused or stopped (AutoRun.Reason).
const (
	AutoReasonMet        = "met"         // its criteria are met (or it is done)
	AutoReasonByYou      = "by_you"      // the person paused or stopped it
	AutoReasonByAgent    = "by_agent"    // the agent turned it off
	AutoReasonAgentGone  = "agent_gone"  // its agent was archived or removed
	AutoReasonTurnLimit  = "turn_limit"  // it used its turns
	AutoReasonTimeLimit  = "time_limit"  // it ran out of time
	AutoReasonTooFast    = "too_fast"    // the agent's turns ended right away, again and again
	AutoReasonNoProgress = "no_progress" // turns in a row changed nothing
)

// TaskEvent is a line of a task's timeline.
type TaskEvent struct {
	ID        string    `json:"id"`
	TaskID    string    `json:"task_id"`
	At        time.Time `json:"at"`
	Kind      string    `json:"kind"` // created | status | step | link | unlink | handoff | report | link | title
	Text      string    `json:"text"`
	SessionID string    `json:"session_id,omitempty"`
	MessageID string    `json:"message_id,omitempty"`
}

// TaskRef is a task a message is about (Source: how the link was made).
type TaskRef struct {
	TaskID string `json:"task_id"`
	Title  string `json:"title"`
	Status string `json:"status"`
	Source string `json:"source"`
}

const taskCols = `id, project_id, title, summary, detail, status, steps, report, links, created_by, created_at, updated_at, done_at, manual_status, manual_at, kind, parent_id, criteria, auto`

// taskReadCols are the columns scanTask reads: taskCols (what the inserts write) and title_by.
const taskReadCols = taskCols + `, title_by`

func scanTask(row interface{ Scan(...any) error }) (*Task, error) {
	var t Task
	var steps, links, criteria, auto string
	var created, updated int64
	var done, manual sql.NullInt64
	if err := row.Scan(&t.ID, &t.ProjectID, &t.Title, &t.Summary, &t.Detail, &t.Status, &steps, &t.Report, &links, &t.CreatedBy, &created, &updated, &done, &t.ManualStatus, &manual, &t.Kind, &t.ParentID, &criteria, &auto, &t.TitleBy); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	t.CreatedAt, t.UpdatedAt, t.DoneAt, t.ManualAt = fromMs(created), fromMs(updated), fromNullMs(done), fromNullMs(manual)
	if json.Unmarshal([]byte(steps), &t.Steps) != nil || t.Steps == nil {
		t.Steps = []TaskStep{}
	}
	if json.Unmarshal([]byte(links), &t.Links) != nil || t.Links == nil {
		t.Links = []TaskLink{}
	}
	if json.Unmarshal([]byte(criteria), &t.Criteria) != nil || t.Criteria == nil {
		t.Criteria = []TaskStep{}
	}
	_ = json.Unmarshal([]byte(auto), &t.Auto)
	t.Agents = []TaskAgent{}
	return &t, nil
}

// CleanSteps: steps with text, spacing collapsed, nesting cut at one level (never nil). A parent with
// sub-steps is done when they all are.
func CleanSteps(in []TaskStep) []TaskStep {
	out := []TaskStep{}
	for _, s := range in {
		text := strings.Join(strings.Fields(s.Text), " ")
		if text == "" {
			continue
		}
		st := TaskStep{Text: text, Done: s.Done}
		for _, c := range s.Steps {
			if ct := strings.Join(strings.Fields(c.Text), " "); ct != "" {
				st.Steps = append(st.Steps, TaskStep{Text: ct, Done: c.Done})
			}
		}
		if len(st.Steps) > 0 {
			all := true
			for _, c := range st.Steps {
				all = all && c.Done
			}
			st.Done = all
		}
		out = append(out, st)
	}
	return out
}

// FlatSteps numbers the steps from 1 in reading order (a parent, then its sub-steps), as the agent
// sees them: the result points into steps.
func FlatSteps(steps []TaskStep) []*TaskStep {
	var out []*TaskStep
	for i := range steps {
		out = append(out, &steps[i])
		for j := range steps[i].Steps {
			out = append(out, &steps[i].Steps[j])
		}
	}
	return out
}

// TaskFields are what a create or update sets; nil leaves a field as it is.
type TaskFields struct {
	Kind     *string
	ParentID *string
	Criteria *[]TaskStep
	Title    *string
	Summary  *string
	Detail   *string
	Status   *string
	Steps    *[]TaskStep
	Report   *string
	Links    *[]TaskLink
}

// ErrTaskTitle: a task needs a title.
var ErrTaskTitle = errors.New("title is required")

func oneLine(s string) string { return strings.Join(strings.Fields(s), " ") }

// CreateTask adds a task to a project; by (a session id, or "" for the person) is its first agent.
func (s *Store) CreateTask(ctx context.Context, projectID, by string, f TaskFields) (*Task, error) {
	return s.createTask(ctx, projectID, by, f, "")
}

func (s *Store) createTask(ctx context.Context, projectID, by string, f TaskFields, origin string) (*Task, error) {
	title := ""
	if f.Title != nil {
		title = oneLine(*f.Title)
	}
	if title == "" {
		return nil, ErrTaskTitle
	}
	status := TaskWorking
	if f.Status != nil && strings.TrimSpace(*f.Status) != "" {
		st, ok := NormalizeTaskStatus(*f.Status)
		if !ok {
			return nil, ErrInvalidTaskStatus
		}
		status = st
	}
	str := func(p *string) string {
		if p == nil {
			return ""
		}
		return strings.TrimSpace(*p)
	}
	steps := []TaskStep{}
	if f.Steps != nil {
		steps = CleanSteps(*f.Steps)
	}
	links := []TaskLink{}
	if f.Links != nil {
		links = *f.Links
	}
	now := s.now()
	var done any
	if status == TaskDone {
		done = ms(now)
	}
	id := NewID("tsk")
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	criteria := []TaskStep{}
	if f.Criteria != nil {
		criteria = CleanSteps(*f.Criteria)
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO tasks(`+taskCols+`, origin) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,'',NULL,?,?,?,'{}',?)`,
		id, projectID, title, str(f.Summary), str(f.Detail), status, jsonText(steps), str(f.Report), jsonText(links), by, ms(now), ms(now), done, str(f.Kind), str(f.ParentID), jsonText(criteria), origin); err != nil {
		return nil, err
	}
	titleBy := TitleByPerson
	if by != "" {
		titleBy = TitleByAgent
	}
	if _, err := tx.ExecContext(ctx, `UPDATE tasks SET title_by=? WHERE id=?`, titleBy, id); err != nil {
		return nil, err
	}
	who := "you"
	if by != "" {
		if _, err := tx.ExecContext(ctx, `INSERT OR IGNORE INTO task_agents(task_id, session_id, role, created_at) VALUES(?,?,?,?)`, id, by, RoleAssigned, ms(now)); err != nil {
			return nil, err
		}
		who = ""
	}
	text := "Task created"
	if str(f.Kind) == KindGoal {
		text = "Goal set"
	}
	if who != "" {
		text += " by you"
	}
	if len(steps) > 0 {
		text += " · " + itoa(len(FlatSteps(steps))) + " steps"
	}
	if err := addEvent(ctx, tx, id, now, "created", text, by, ""); err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return s.GetTask(ctx, id)
}

func itoa(n int) string {
	b, _ := json.Marshal(n)
	return string(b)
}

func addEvent(ctx context.Context, tx *sql.Tx, taskID string, at time.Time, kind, text, sessionID, messageID string) error {
	_, err := tx.ExecContext(ctx, `INSERT INTO task_events(id, task_id, at, kind, text, session_id, message_id) VALUES(?,?,?,?,?,?,?)`,
		NewID("tev"), taskID, ms(at), kind, text, sessionID, messageID)
	return err
}

// AddTaskEvent adds a line to a task's timeline.
func (s *Store) AddTaskEvent(ctx context.Context, taskID, kind, text, sessionID, messageID string) error {
	return s.exec(ctx, `INSERT INTO task_events(id, task_id, at, kind, text, session_id, message_id) VALUES(?,?,?,?,?,?,?)`,
		NewID("tev"), taskID, ms(s.now()), kind, text, sessionID, messageID)
}

// eventText is an event's line as the timeline shows it. Status changes were once stored as a bare
// "→ needs you", a line with no subject: they read "Status → needs you" now.
func eventText(kind, text string) string {
	if kind == "status" && strings.HasPrefix(text, "→ ") {
		return "Status " + text
	}
	return text
}

// statusWord is a status as the timeline says it.
func statusWord(st string) string {
	return map[string]string{TaskWorking: "working", TaskNeedsYou: "needs you", TaskBlocked: "blocked", TaskDone: "done"}[st]
}

// UpdateTask changes the fields of f that are set. by is the session that changed it ("" for the
// person): the person's status is marked as a manual move until an agent sets one again. Every
// change is a line in the timeline.
func (s *Store) UpdateTask(ctx context.Context, id, by string, f TaskFields) (*Task, error) {
	cur, err := s.GetTask(ctx, id)
	if err != nil {
		return nil, err
	}
	t := *cur
	now := s.now()
	type ev struct{ kind, text string }
	var evs []ev
	if f.Title != nil {
		if t.Title = oneLine(*f.Title); t.Title == "" {
			return nil, ErrTaskTitle
		}
		if t.Title != cur.Title {
			w := "Renamed: " + cur.Title + " → " + t.Title
			t.TitleBy = TitleByAgent
			if by == "" {
				w += " (you)"
				t.TitleBy = TitleByPerson
			}
			evs = append(evs, ev{"title", w})
		}
	}
	if f.Summary != nil {
		t.Summary = strings.TrimSpace(*f.Summary)
	}
	if f.Detail != nil {
		t.Detail = strings.TrimSpace(*f.Detail)
	}
	if f.Report != nil {
		t.Report = strings.TrimSpace(*f.Report)
		if t.Report != cur.Report && t.Report != "" {
			evs = append(evs, ev{"report", "Report: " + firstLineOf(t.Report)})
		}
	}
	if f.Links != nil {
		t.Links = *f.Links
	}
	if f.Kind != nil {
		t.Kind = strings.TrimSpace(*f.Kind)
	}
	if f.ParentID != nil && strings.TrimSpace(*f.ParentID) != cur.ParentID {
		t.ParentID = strings.TrimSpace(*f.ParentID)
		if t.ParentID != "" {
			evs = append(evs, ev{"goal", "Serves a goal now"})
		}
	}
	if f.Criteria != nil {
		t.Criteria = CleanSteps(*f.Criteria)
		old := map[string]bool{}
		for _, p := range cur.Criteria {
			old[p.Text] = p.Done
		}
		for _, p := range t.Criteria {
			if was, ok := old[p.Text]; ok && was != p.Done && p.Done {
				evs = append(evs, ev{"criterion", "Met: " + p.Text})
			}
		}
	}
	if f.Steps != nil {
		t.Steps = CleanSteps(*f.Steps)
		old := map[string]bool{}
		for _, p := range FlatSteps(cur.Steps) {
			old[p.Text] = p.Done
		}
		for _, p := range FlatSteps(t.Steps) {
			if was, ok := old[p.Text]; ok && was != p.Done {
				w := "done"
				if !p.Done {
					w = "not done"
				}
				evs = append(evs, ev{"step", p.Text + " → " + w})
			}
		}
	}
	manual := cur.ManualStatus != "" && cur.ManualAt != nil
	manualStatus, manualAt := t.ManualStatus, t.ManualAt
	if f.Status != nil && strings.TrimSpace(*f.Status) != "" {
		st, ok := NormalizeTaskStatus(*f.Status)
		if !ok {
			return nil, ErrInvalidTaskStatus
		}
		switch {
		case st == TaskDone && t.Status == TaskDone && t.DoneAt != nil:
		case st == TaskDone:
			t.DoneAt = &now
		default:
			t.DoneAt = nil
		}
		if st != cur.Status {
			w := "Status → " + statusWord(st)
			if by == "" {
				w += " (you)"
			}
			evs = append(evs, ev{"status", w})
		}
		t.Status = st
		if by == "" {
			manual, manualStatus, manualAt = true, st, &now
		} else {
			manual = false
		}
	}
	if !manual {
		manualStatus, manualAt = "", nil
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	var done, mAt any
	if t.DoneAt != nil {
		done = ms(*t.DoneAt)
	}
	if manualAt != nil {
		mAt = ms(*manualAt)
	}
	if _, err := tx.ExecContext(ctx, `UPDATE tasks SET title=?, summary=?, detail=?, status=?, steps=?, report=?, links=?, updated_at=?, done_at=?, manual_status=?, manual_at=?, kind=?, parent_id=?, criteria=?, title_by=? WHERE id=?`,
		t.Title, t.Summary, t.Detail, t.Status, jsonText(t.Steps), t.Report, jsonText(t.Links), ms(now), done, manualStatus, mAt, t.Kind, t.ParentID, jsonText(t.Criteria), t.TitleBy, id); err != nil {
		return nil, err
	}
	for _, e := range evs {
		if err := addEvent(ctx, tx, id, now, e.kind, e.text, by, ""); err != nil {
			return nil, err
		}
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	out, err := s.GetTask(ctx, id)
	if err == nil && s.onTaskChange != nil && (out.Title != cur.Title || out.Status != cur.Status) {
		s.onTaskChange(*cur, *out)
	}
	return out, err
}

func firstLineOf(s string) string {
	l, _, _ := strings.Cut(strings.TrimSpace(s), "\n")
	l = oneLine(l)
	if r := []rune(l); len(r) > 140 {
		l = string(r[:139]) + "…"
	}
	return l
}

// DeleteTask removes a task, its tags and its timeline.
func (s *Store) DeleteTask(ctx context.Context, id string) error {
	_, _ = s.db.ExecContext(ctx, `DELETE FROM notification_slack_threads WHERE task_id=? AND task_id!=''`, id)
	return s.exec(ctx, `DELETE FROM tasks WHERE id=?`, id)
}

// GetTask returns a task with its agents.
func (s *Store) GetTask(ctx context.Context, id string) (*Task, error) {
	t, err := scanTask(s.db.QueryRowContext(ctx, `SELECT `+taskReadCols+` FROM tasks WHERE id=?`, id))
	if err != nil {
		return nil, err
	}
	ts := []Task{*t}
	if err := s.fillAgents(ctx, ts); err != nil {
		return nil, err
	}
	return &ts[0], nil
}

func (s *Store) fillAgents(ctx context.Context, ts []Task) error {
	if len(ts) == 0 {
		return nil
	}
	idx := map[string]int{}
	ids := make([]any, len(ts))
	for i := range ts {
		idx[ts[i].ID] = i
		ids[i] = ts[i].ID
	}
	rows, err := s.db.QueryContext(ctx, `SELECT ta.task_id, ta.session_id, ta.role, ta.created_at FROM task_agents ta JOIN sessions s ON s.id=ta.session_id
	  WHERE ta.task_id IN (`+placeholders(len(ids))+`) ORDER BY CASE ta.role WHEN 'assigned' THEN 0 ELSE 1 END, ta.created_at`, ids...)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var a TaskAgent
		var tid string
		var at int64
		if err := rows.Scan(&tid, &a.SessionID, &a.Role, &at); err != nil {
			return err
		}
		a.Since = fromMs(at)
		ts[idx[tid]].Agents = append(ts[idx[tid]].Agents, a)
	}
	return rows.Err()
}

func placeholders(n int) string {
	if n == 0 {
		return "NULL"
	}
	return strings.TrimSuffix(strings.Repeat("?,", n), ",")
}

// TaskQuery filters ListTasks.
type TaskQuery struct {
	ProjectID string // "" = every project
	SessionID string // only tasks this session is an agent of
	// DoneSince: done tasks finished before it are left out (zero: all).
	DoneSince time.Time
	DoneLimit int
}

// ListTasks lists tasks: open ones by last change, newest first, then done ones by when they were done.
func (s *Store) ListTasks(ctx context.Context, q TaskQuery) ([]Task, error) {
	where := `(p.id IS NULL OR p.archived_at IS NULL)`
	args := []any{}
	if q.ProjectID != "" {
		where += ` AND t.project_id=?`
		args = append(args, q.ProjectID)
	}
	if q.SessionID != "" {
		where += ` AND EXISTS(SELECT 1 FROM task_agents ta WHERE ta.task_id=t.id AND ta.session_id=?)`
		args = append(args, q.SessionID)
	}
	rows, err := s.db.QueryContext(ctx, `SELECT `+prefixed("t.", taskReadCols)+` FROM tasks t LEFT JOIN projects p ON p.id=t.project_id
	  WHERE `+where+` ORDER BY CASE WHEN t.status='done' THEN 1 ELSE 0 END, COALESCE(t.done_at,0) DESC, t.updated_at DESC`, args...)
	if err != nil {
		return nil, err
	}
	out := []Task{}
	done := 0
	for rows.Next() {
		t, err := scanTask(rows)
		if err != nil {
			rows.Close()
			return nil, err
		}
		if t.Status == TaskDone {
			if (!q.DoneSince.IsZero() && (t.DoneAt == nil || t.DoneAt.Before(q.DoneSince))) || (q.DoneLimit > 0 && done >= q.DoneLimit) {
				continue
			}
			done++
		}
		out = append(out, *t)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, s.fillAgents(ctx, out)
}

// AddTaskAgent puts a session on a task (an assignment upgrades an involvement, never the reverse).
// It reports whether the session is new on the task.
func (s *Store) AddTaskAgent(ctx context.Context, taskID, sessionID, role string) (bool, error) {
	if sessionID == "" {
		return false, nil
	}
	res, err := s.db.ExecContext(ctx, `INSERT OR IGNORE INTO task_agents(task_id, session_id, role, created_at) VALUES(?,?,?,?)`, taskID, sessionID, role, ms(s.now()))
	if err != nil {
		return false, err
	}
	n, _ := res.RowsAffected()
	if n == 0 && role == RoleAssigned {
		err = s.exec(ctx, `UPDATE task_agents SET role='assigned' WHERE task_id=? AND session_id=?`, taskID, sessionID)
	}
	return n > 0, err
}

// LinkMessages puts messages in a task: a message is about exactly one task, so one that was in
// another task moves (docs/v3/redesign.md §4.5, revision 8). It returns the ids that were not in this
// task before. The sessions that wrote moved agent messages become involved in the task.
func (s *Store) LinkMessages(ctx context.Context, taskID string, messageIDs []string, source string) ([]string, error) {
	return s.linkMessages(ctx, taskID, messageIDs, source, true)
}

// PlaceMessages puts in a task the messages among ids that are in no task yet (a rule's placement:
// it never moves a message the agent or the person placed). It returns the ids it placed.
func (s *Store) PlaceMessages(ctx context.Context, taskID string, messageIDs []string, source string) ([]string, error) {
	return s.linkMessages(ctx, taskID, messageIDs, source, false)
}

func (s *Store) linkMessages(ctx context.Context, taskID string, messageIDs []string, source string, move bool) ([]string, error) {
	added := []string{}
	if len(messageIDs) == 0 {
		return added, nil
	}
	var ok int
	if err := s.db.QueryRowContext(ctx, `SELECT count(*) FROM tasks WHERE id=?`, taskID).Scan(&ok); err != nil || ok == 0 {
		return added, err
	}
	now := ms(s.now())
	for _, id := range messageIDs {
		cur, err := s.TaskOfMessage(ctx, id)
		if err != nil {
			return nil, err
		}
		if cur == taskID || (cur != "" && !move) {
			continue
		}
		tx, err := s.db.BeginTx(ctx, nil)
		if err != nil {
			return nil, err
		}
		if _, err := tx.ExecContext(ctx, `DELETE FROM message_tasks WHERE message_id=?`, id); err != nil {
			tx.Rollback()
			return nil, err
		}
		res, err := tx.ExecContext(ctx, `INSERT INTO message_tasks(message_id, task_id, source, created_at) SELECT id, ?, ?, ? FROM messages WHERE id=?`, taskID, source, now, id)
		if err != nil {
			tx.Rollback()
			return nil, err
		}
		if err := tx.Commit(); err != nil {
			return nil, err
		}
		if n, _ := res.RowsAffected(); n == 0 {
			continue
		}
		added = append(added, id)
		var sess, author string
		if err := s.db.QueryRowContext(ctx, `SELECT t.session_id, m.author FROM messages m JOIN threads t ON t.id=m.thread_id WHERE m.id=?`, id).Scan(&sess, &author); err == nil && author == AuthorAgent {
			if _, err := s.AddTaskAgent(ctx, taskID, sess, RoleInvolved); err != nil {
				return nil, err
			}
		}
	}
	if len(added) > 0 {
		_ = s.exec(ctx, `UPDATE tasks SET updated_at=MAX(updated_at, ?) WHERE id=?`, now, taskID)
	}
	return added, nil
}

// TaskOfMessage is the task a message is about ("" while it is in none).
func (s *Store) TaskOfMessage(ctx context.Context, messageID string) (string, error) {
	var id string
	err := s.db.QueryRowContext(ctx, `SELECT task_id FROM message_tasks WHERE message_id=? ORDER BY created_at DESC LIMIT 1`, messageID).Scan(&id)
	if errors.Is(err, sql.ErrNoRows) {
		return "", nil
	}
	return id, err
}

// UnlinkMessage takes a message out of its task (it is unplaced then; the person never does this).
func (s *Store) UnlinkMessage(ctx context.Context, messageID, taskID string) (bool, error) {
	res, err := s.db.ExecContext(ctx, `DELETE FROM message_tasks WHERE message_id=? AND task_id=?`, messageID, taskID)
	if err != nil {
		return false, err
	}
	n, _ := res.RowsAffected()
	return n > 0, nil
}

// TasksOf returns the task of each message, by message id (its title and status), as a list of at
// most one: a message is about exactly one task (none while it is unplaced).
func (s *Store) TasksOf(ctx context.Context, messageIDs []string) (map[string][]TaskRef, error) {
	out := map[string][]TaskRef{}
	for start := 0; start < len(messageIDs); start += 500 {
		end := min(start+500, len(messageIDs))
		args := make([]any, 0, end-start)
		for _, id := range messageIDs[start:end] {
			args = append(args, id)
		}
		rows, err := s.db.QueryContext(ctx, `SELECT mt.message_id, mt.task_id, t.title, t.status, mt.source FROM message_tasks mt JOIN tasks t ON t.id=mt.task_id
		  WHERE mt.message_id IN (`+placeholders(len(args))+`) ORDER BY mt.created_at, t.created_at`, args...)
		if err != nil {
			return nil, err
		}
		for rows.Next() {
			var mid string
			var tg TaskRef
			if err := rows.Scan(&mid, &tg.TaskID, &tg.Title, &tg.Status, &tg.Source); err != nil {
				rows.Close()
				return nil, err
			}
			out[mid] = append(out[mid], tg)
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return nil, err
		}
	}
	return out, nil
}

// TaskMessageIDs returns the ids of a task's tagged messages, oldest first.
func (s *Store) TaskMessageIDs(ctx context.Context, taskID string) ([]string, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT m.id FROM message_tasks mt JOIN messages m ON m.id=mt.message_id WHERE mt.task_id=? ORDER BY m.created_at, m.rowid`, taskID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []string{}
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		out = append(out, id)
	}
	return out, rows.Err()
}

// TaskEvents returns a task's timeline, oldest first.
func (s *Store) TaskEvents(ctx context.Context, taskID string) ([]TaskEvent, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT id, task_id, at, kind, text, session_id, message_id FROM task_events WHERE task_id=? ORDER BY at, rowid`, taskID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []TaskEvent{}
	for rows.Next() {
		var e TaskEvent
		var at int64
		if err := rows.Scan(&e.ID, &e.TaskID, &at, &e.Kind, &e.Text, &e.SessionID, &e.MessageID); err != nil {
			return nil, err
		}
		e.At = fromMs(at)
		e.Text = eventText(e.Kind, e.Text)
		out = append(out, e)
	}
	return out, rows.Err()
}

// StreamThread returns the id of the session's stream thread, creating it on first use.
func (s *Store) StreamThread(ctx context.Context, sessionID string) (string, error) {
	var id string
	err := s.db.QueryRowContext(ctx, `SELECT id FROM threads WHERE session_id=? AND kind='stream' ORDER BY created_at LIMIT 1`, sessionID).Scan(&id)
	if err == nil {
		return id, nil
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return "", err
	}
	var one int
	if err := s.db.QueryRowContext(ctx, `SELECT 1 FROM sessions WHERE id=?`, sessionID).Scan(&one); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return "", ErrNotFound
		}
		return "", err
	}
	id = NewID("thr")
	now := ms(s.now())
	if _, err := s.db.ExecContext(ctx, `INSERT INTO threads(id, session_id, subject, created_at, updated_at, status, kind) VALUES(?,?,'',?,?,?,'stream')`,
		id, sessionID, now, now, ThreadFinished); err != nil {
		return "", err
	}
	return id, nil
}

// SessionMessages loads every thread of the session (derived, as GetThread does) and returns their
// messages in time order, with each message's thread.
func (s *Store) SessionMessages(ctx context.Context, sessionID string) ([]Message, map[string]*Thread, error) {
	ths, err := s.loadThreads(ctx, `t.session_id=?`, sessionID)
	if err != nil {
		return nil, nil, err
	}
	return flatten(ths)
}

func flatten(ths []Thread) ([]Message, map[string]*Thread, error) {
	byID := map[string]*Thread{}
	var out []Message
	for i := range ths {
		byID[ths[i].ID] = &ths[i]
		out = append(out, ths[i].Messages...)
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].CreatedAt.Before(out[j].CreatedAt) })
	return out, byID, nil
}

// ThreadsWhere loads derived threads (with messages) of live sessions of a project ("" = all).
func (s *Store) ProjectThreads(ctx context.Context, projectID string) ([]Thread, error) {
	if projectID == "" {
		return s.loadThreads(ctx, `s.archived_at IS NULL AND s.kind!='shell'`)
	}
	return s.loadThreads(ctx, `s.archived_at IS NULL AND s.kind!='shell' AND s.project_id=?`, projectID)
}

// ThreadsOf loads the derived threads with these ids.
func (s *Store) ThreadsOf(ctx context.Context, ids []string) ([]Thread, error) {
	if len(ids) == 0 {
		return []Thread{}, nil
	}
	args := make([]any, len(ids))
	for i, id := range ids {
		args[i] = id
	}
	return s.loadThreads(ctx, `t.id IN (`+placeholders(len(args))+`)`, args...)
}

// MarkMessagesRead marks agent messages read; it returns how many changed.
func (s *Store) MarkMessagesRead(ctx context.Context, ids []string) (int64, error) {
	if len(ids) == 0 {
		return 0, nil
	}
	args := []any{ms(s.now())}
	for _, id := range ids {
		args = append(args, id)
	}
	res, err := s.db.ExecContext(ctx, `UPDATE messages SET read_at=? WHERE author='agent' AND read_at IS NULL AND id IN (`+placeholders(len(ids))+`)`, args...)
	if err != nil {
		return 0, err
	}
	return res.RowsAffected()
}

// MarkMessagesUnread is "Mark unread from here": the agent messages count as not seen again.
func (s *Store) MarkMessagesUnread(ctx context.Context, ids []string) (int64, error) {
	if len(ids) == 0 {
		return 0, nil
	}
	args := make([]any, len(ids))
	for i, id := range ids {
		args[i] = id
	}
	res, err := s.db.ExecContext(ctx, `UPDATE messages SET read_at=NULL WHERE author='agent' AND read_at IS NOT NULL AND id IN (`+placeholders(len(ids))+`)`, args...)
	if err != nil {
		return 0, err
	}
	return res.RowsAffected()
}

// SetDecision records the agent's decision on its reply.
func (s *Store) SetDecision(ctx context.Context, messageID, decision, taskID string, turnOf []string) error {
	if turnOf == nil {
		turnOf = []string{}
	}
	return s.exec(ctx, `UPDATE messages SET decision=?, decision_task=?, turn_of=? WHERE id=?`, decision, taskID, jsonText(turnOf), messageID)
}

// TurnMessages returns the person's messages the agent's next reply answers: walking the session's
// messages from the newest, the agent's messages newer than the person's newest delivered one are
// this turn's earlier replies; the person's delivered messages before them, back to the agent message
// before those, are the turn's. Oldest first.
func (s *Store) TurnMessages(ctx context.Context, sessionID string) ([]string, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT m.id, m.author, m.kind, m.delivered_at FROM messages m JOIN threads t ON t.id=m.thread_id
	  WHERE t.session_id=? ORDER BY m.created_at DESC, m.rowid DESC LIMIT 200`, sessionID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []string
	seenUser := false
	for rows.Next() {
		var id, author, kind string
		var delivered sql.NullInt64
		if err := rows.Scan(&id, &author, &kind, &delivered); err != nil {
			return nil, err
		}
		if author == AuthorAgent {
			if seenUser {
				break
			}
			continue
		}
		if !delivered.Valid || kind == KindCommand || kind == KindNote {
			continue
		}
		seenUser = true
		out = append([]string{id}, out...)
	}
	return out, rows.Err()
}

// MessageSession returns the session of a message, and its author.
func (s *Store) MessageSession(ctx context.Context, messageID string) (sessionID, author string, err error) {
	err = s.db.QueryRowContext(ctx, `SELECT t.session_id, m.author FROM messages m JOIN threads t ON t.id=m.thread_id WHERE m.id=?`, messageID).Scan(&sessionID, &author)
	if errors.Is(err, sql.ErrNoRows) {
		return "", "", ErrNotFound
	}
	return sessionID, author, err
}

// TaskCount is how many messages are in a task.
func (s *Store) TaskCount(ctx context.Context, taskID string) (int, error) {
	var n int
	err := s.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM message_tasks WHERE task_id=?`, taskID).Scan(&n)
	return n, err
}

// SearchHit is a message that matched a search.
type SearchMessage struct {
	ID        string    `json:"id"`
	SessionID string    `json:"session_id"`
	ThreadID  string    `json:"thread_id"`
	Author    string    `json:"author"`
	Text      string    `json:"text"`
	CreatedAt time.Time `json:"created_at"`
	Tasks     []TaskRef `json:"tasks"`
}

// SearchMessages finds messages of live sessions (of a project, or all) whose text has q, newest first.
func (s *Store) SearchMessages(ctx context.Context, projectID, q string, limit int) ([]SearchMessage, error) {
	q = strings.TrimSpace(q)
	out := []SearchMessage{}
	if q == "" {
		return out, nil
	}
	like := "%" + strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`).Replace(strings.ToLower(q)) + "%"
	where := `s.archived_at IS NULL AND (lower(m.body) LIKE ? ESCAPE '\' OR lower(m.words) LIKE ? ESCAPE '\')`
	args := []any{like, like}
	if projectID != "" {
		where += ` AND s.project_id=?`
		args = append(args, projectID)
	}
	args = append(args, limit)
	rows, err := s.db.QueryContext(ctx, `SELECT m.id, t.session_id, m.thread_id, m.author, m.body, m.words, m.created_at FROM messages m
	  JOIN threads t ON t.id=m.thread_id JOIN sessions s ON s.id=t.session_id WHERE `+where+` ORDER BY m.created_at DESC LIMIT ?`, args...)
	if err != nil {
		return nil, err
	}
	ids := []string{}
	for rows.Next() {
		var m SearchMessage
		var body, words string
		var at int64
		if err := rows.Scan(&m.ID, &m.SessionID, &m.ThreadID, &m.Author, &body, &words, &at); err != nil {
			rows.Close()
			return nil, err
		}
		m.Text, m.CreatedAt = body, fromMs(at)
		if m.Author == AuthorUser && strings.TrimSpace(words) != "" {
			m.Text = words
		}
		m.Tasks = []TaskRef{}
		out = append(out, m)
		ids = append(ids, m.ID)
	}
	rows.Close()
	tags, err := s.TasksOf(ctx, ids)
	if err != nil {
		return nil, err
	}
	for i := range out {
		if tg := tags[out[i].ID]; tg != nil {
			out[i].Tasks = tg
		}
	}
	return out, nil
}

// SearchTasks finds tasks whose title, summary, detail, report or steps have q.
func (s *Store) SearchTasks(ctx context.Context, projectID, q string) ([]Task, error) {
	q = strings.ToLower(strings.TrimSpace(q))
	if q == "" {
		return []Task{}, nil
	}
	all, err := s.ListTasks(ctx, TaskQuery{ProjectID: projectID})
	if err != nil {
		return nil, err
	}
	out := []Task{}
	for _, t := range all {
		hay := t.Title + " " + t.Summary + " " + t.Detail + " " + t.Report
		for _, p := range FlatSteps(t.Steps) {
			hay += " " + p.Text
		}
		if strings.Contains(strings.ToLower(hay), q) {
			out = append(out, t)
		}
	}
	return out, nil
}

// UpdateAuto changes a goal's autonomous run in one transaction: fn gets the stored run and changes
// it, or returns false to leave it as it is. It returns the run as stored afterwards and whether fn
// changed it. fn must not use the store. There is no blind setter on purpose: the person, the agent
// and the ticks change a run at once, and writing back a copy read earlier would undo a change made
// in between (a pause, a stop, a limit).
func (s *Store) UpdateAuto(ctx context.Context, taskID string, fn func(a *AutoRun) bool) (AutoRun, bool, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return AutoRun{}, false, err
	}
	defer tx.Rollback()
	var raw string
	if err := tx.QueryRowContext(ctx, `SELECT auto FROM tasks WHERE id=?`, taskID).Scan(&raw); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			err = ErrNotFound
		}
		return AutoRun{}, false, err
	}
	var a AutoRun
	_ = json.Unmarshal([]byte(raw), &a)
	if !fn(&a) {
		return a, false, nil
	}
	if _, err := tx.ExecContext(ctx, `UPDATE tasks SET auto=?, updated_at=? WHERE id=?`, jsonText(a), ms(s.now()), taskID); err != nil {
		return AutoRun{}, false, err
	}
	return a, true, tx.Commit()
}

// CompareAndSetAuto stores next only when the stored run is still old (as read before): false when
// it changed meanwhile and nothing was stored.
func (s *Store) CompareAndSetAuto(ctx context.Context, taskID string, old, next AutoRun) (bool, error) {
	want := jsonText(old)
	_, ok, err := s.UpdateAuto(ctx, taskID, func(a *AutoRun) bool {
		if jsonText(*a) != want {
			return false
		}
		*a = next
		return true
	})
	return ok, err
}

// RunningGoals lists the goals whose autonomous run is on.
func (s *Store) RunningGoals(ctx context.Context) ([]Task, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT `+taskReadCols+` FROM tasks WHERE kind='goal' AND json_extract(auto,'$.state')='running'`)
	if err != nil {
		return nil, err
	}
	out := []Task{}
	for rows.Next() {
		t, err := scanTask(rows)
		if err != nil {
			rows.Close()
			return nil, err
		}
		out = append(out, *t)
	}
	rows.Close()
	return out, s.fillAgents(ctx, out)
}

// NewSegmentThread makes an empty thread of the older kind (not the stream): what every thread was
// before v3. Tests use it to build such data.
func (s *Store) NewSegmentThread(ctx context.Context, sessionID, subject string) (string, error) {
	id := NewID("thr")
	now := ms(s.now())
	err := s.exec(ctx, `INSERT INTO threads(id, session_id, subject, created_at, updated_at, status, kind) VALUES(?,?,?,?,?,?,'')`, id, sessionID, subject, now, now, ThreadFinished)
	return id, err
}

// GetThreadKind returns a thread's kind (ThreadStream or "").
func (s *Store) GetThreadKind(ctx context.Context, id string) (string, error) {
	var k string
	err := s.db.QueryRowContext(ctx, `SELECT kind FROM threads WHERE id=?`, id).Scan(&k)
	if errors.Is(err, sql.ErrNoRows) {
		return "", ErrNotFound
	}
	return k, err
}
