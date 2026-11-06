package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"path"
	"sort"
	"strings"
	"time"
)

// Project errors; the server answers them with 409.
var (
	// ErrProjectBusy: the change would orphan or hide sessions (archive a project with live
	// sessions, delete one with any, move one that has sessions).
	ErrProjectBusy = errors.New("project has sessions")
	// ErrSessionIsMain: the session is its project's main one and other Claude Code sessions exist;
	// promote another first (or in the same request).
	ErrSessionIsMain = errors.New("session is the project's main session")
	// ErrProjectExists: there already is a project for this host and folder.
	ErrProjectExists = errors.New("a project for this folder already exists")
)

// NoProjectName is the catch-all project of sessions without a usable folder.
const NoProjectName = "No project"

// Project is a folder on a host; sessions (and so threads) are resources under it.
type Project struct {
	ID         string     `json:"id"`
	Name       string     `json:"name"`
	Dir        string     `json:"dir"` // '' for the catch-all project
	HostID     string     `json:"host_id"`
	HostName   string     `json:"host_name,omitempty"` // filled by the server
	CreatedAt  time.Time  `json:"created_at"`
	ArchivedAt *time.Time `json:"archived_at"`
	PinnedAt   *time.Time `json:"pinned_at"`
	// MainSessionID: the session a new thread goes to by default; '' until the project has a Claude Code session.
	MainSessionID string `json:"main_session_id"`
	// Derived.
	SessionCount int       `json:"session_count"` // every session, archived and ended too
	LiveSessions int       `json:"live_sessions"` // not ended, not archived
	LastActivity time.Time `json:"last_activity"` // newest session or thread update
}

// querier is what *sql.DB and *sql.Tx share.
type querier interface {
	ExecContext(ctx context.Context, q string, args ...any) (sql.Result, error)
	QueryContext(ctx context.Context, q string, args ...any) (*sql.Rows, error)
	QueryRowContext(ctx context.Context, q string, args ...any) *sql.Row
}

// CleanProjectDir normalises a folder: path.Clean, and ” for anything that is not an absolute path.
func CleanProjectDir(dir string) string {
	dir = strings.TrimSpace(dir)
	if !strings.HasPrefix(dir, "/") {
		return ""
	}
	return path.Clean(dir)
}

func baseName(dir string) string {
	if dir == "" {
		return NoProjectName
	}
	if dir == "/" {
		return "/"
	}
	return path.Base(dir)
}

func hostLabel(ctx context.Context, q querier, hostID string) string {
	var name string
	if err := q.QueryRowContext(ctx, `SELECT name FROM hosts WHERE id=?`, hostID).Scan(&name); err != nil || name == "" {
		return hostID
	}
	return name
}

// uniqueProjectName makes base unique among projects (case-insensitive): a remote host's name is
// added first, then a number.
func uniqueProjectName(ctx context.Context, q querier, base, hostID string) (string, error) {
	taken := func(n string) (bool, error) {
		var c int
		err := q.QueryRowContext(ctx, `SELECT COUNT(*) FROM projects WHERE lower(name)=lower(?)`, n).Scan(&c)
		return c > 0, err
	}
	if t, err := taken(base); err != nil || !t {
		return base, err
	}
	cand := base
	if hostID != "" && hostID != LocalHostID {
		cand = fmt.Sprintf("%s (%s)", base, hostLabel(ctx, q, hostID))
		if t, err := taken(cand); err != nil || !t {
			return cand, err
		}
	}
	for i := 2; ; i++ {
		n := fmt.Sprintf("%s %d", cand, i)
		if t, err := taken(n); err != nil || !t {
			return n, err
		}
	}
}

const projectCols = `id, name, dir, host_id, created_at, archived_at, pinned_at, COALESCE(main_session_id,'')`

func scanProject(row interface{ Scan(...any) error }) (*Project, error) {
	var p Project
	var created int64
	var archived, pinned sql.NullInt64
	if err := row.Scan(&p.ID, &p.Name, &p.Dir, &p.HostID, &created, &archived, &pinned, &p.MainSessionID); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	p.CreatedAt = fromMs(created)
	p.ArchivedAt, p.PinnedAt = fromNullMs(archived), fromNullMs(pinned)
	p.LastActivity = p.CreatedAt
	return &p, nil
}

// findProject: the project for (host, dir), a live one before an archived one.
func findProject(ctx context.Context, q querier, hostID, dir string) (*Project, error) {
	return scanProject(q.QueryRowContext(ctx, `SELECT `+projectCols+` FROM projects WHERE host_id=? AND dir=? ORDER BY archived_at IS NOT NULL, created_at, rowid LIMIT 1`, hostID, dir))
}

func insertProject(ctx context.Context, q querier, name, dir, hostID string, created time.Time, archived *time.Time) (*Project, error) {
	name, err := uniqueProjectName(ctx, q, name, hostID)
	if err != nil {
		return nil, err
	}
	p := &Project{ID: NewID("prj"), Name: name, Dir: dir, HostID: hostID, CreatedAt: created, ArchivedAt: archived, LastActivity: created}
	var arch any
	if archived != nil {
		arch = ms(*archived)
	}
	_, err = q.ExecContext(ctx, `INSERT INTO projects(id,name,dir,host_id,created_at,archived_at) VALUES(?,?,?,?,?,?)`, p.ID, p.Name, p.Dir, p.HostID, ms(created), arch)
	return p, err
}

// EnsureProject finds the project for (host, dir) or creates it, named after the last folder.
// An archived one is brought back. A dir that is not an absolute path is the host's catch-all.
func (s *Store) EnsureProject(ctx context.Context, hostID, dir string) (p *Project, created bool, err error) {
	if hostID == "" {
		hostID = LocalHostID
	}
	dir = CleanProjectDir(dir)
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, false, err
	}
	defer tx.Rollback()
	p, err = findProject(ctx, tx, hostID, dir)
	switch {
	case err == nil:
		if p.ArchivedAt != nil {
			if _, err := tx.ExecContext(ctx, `UPDATE projects SET archived_at=NULL WHERE id=?`, p.ID); err != nil {
				return nil, false, err
			}
			p.ArchivedAt = nil
		}
	case errors.Is(err, ErrNotFound):
		p, err = insertProject(ctx, tx, baseName(dir), dir, hostID, s.now(), nil)
		if err != nil {
			return nil, false, err
		}
		created = true
	default:
		return nil, false, err
	}
	return p, created, tx.Commit()
}

// CreateProject makes a project with a chosen name. A folder that has a live project is
// ErrProjectExists; one with an archived project brings that back, under the new name.
func (s *Store) CreateProject(ctx context.Context, name, dir, hostID string) (*Project, error) {
	if hostID == "" {
		hostID = LocalHostID
	}
	dir = CleanProjectDir(dir)
	if dir == "" {
		return nil, errors.New("dir must be an absolute path")
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	if name = strings.TrimSpace(name); name == "" {
		name = baseName(dir)
	}
	old, err := findProject(ctx, tx, hostID, dir)
	if err != nil && !errors.Is(err, ErrNotFound) {
		return nil, err
	}
	var p *Project
	if err == nil {
		if old.ArchivedAt == nil {
			return nil, ErrProjectExists
		}
		if _, err := tx.ExecContext(ctx, `UPDATE projects SET archived_at=NULL, name=? WHERE id=?`, name, old.ID); err != nil {
			return nil, err
		}
		old.ArchivedAt, old.Name = nil, name
		p = old
	} else {
		if err := nameFree(ctx, tx, name, ""); err != nil {
			return nil, err
		}
		if p, err = insertProject(ctx, tx, name, dir, hostID, s.now(), nil); err != nil {
			return nil, err
		}
	}
	return p, tx.Commit()
}

// nameFree: a chosen name must not be another project's (case-insensitive).
func nameFree(ctx context.Context, q querier, name, exceptID string) error {
	var c int
	if err := q.QueryRowContext(ctx, `SELECT COUNT(*) FROM projects WHERE lower(name)=lower(?) AND id!=?`, name, exceptID).Scan(&c); err != nil {
		return err
	}
	if c > 0 {
		return fmt.Errorf("a project named %q already exists", name)
	}
	return nil
}

// GetProject returns a project with its derived fields.
func (s *Store) GetProject(ctx context.Context, id string) (*Project, error) {
	list, err := s.listProjects(ctx, `WHERE p.id=?`, id)
	if err != nil {
		return nil, err
	}
	if len(list) == 0 {
		return nil, ErrNotFound
	}
	return &list[0], nil
}

// ListProjects lists projects: pinned first, then newest activity first. Archived ones only on request.
func (s *Store) ListProjects(ctx context.Context, includeArchived bool) ([]Project, error) {
	if includeArchived {
		return s.listProjects(ctx, ``)
	}
	return s.listProjects(ctx, `WHERE p.archived_at IS NULL`)
}

func (s *Store) listProjects(ctx context.Context, where string, args ...any) ([]Project, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT p.id, p.name, p.dir, p.host_id, p.created_at, p.archived_at, p.pinned_at, COALESCE(p.main_session_id,''),
	  (SELECT COUNT(*) FROM sessions s WHERE s.project_id=p.id),
	  (SELECT COUNT(*) FROM sessions s WHERE s.project_id=p.id AND s.archived_at IS NULL AND s.status!=?),
	  (SELECT COALESCE(MAX(s.updated_at),0) FROM sessions s WHERE s.project_id=p.id),
	  (SELECT COALESCE(MAX(t.updated_at),0) FROM threads t JOIN sessions s ON s.id=t.session_id WHERE s.project_id=p.id)
	  FROM projects p `+where, append([]any{StatusEnded}, args...)...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Project{}
	for rows.Next() {
		var p Project
		var created, sUp, tUp int64
		var archived, pinned sql.NullInt64
		if err := rows.Scan(&p.ID, &p.Name, &p.Dir, &p.HostID, &created, &archived, &pinned, &p.MainSessionID, &p.SessionCount, &p.LiveSessions, &sUp, &tUp); err != nil {
			return nil, err
		}
		p.CreatedAt = fromMs(created)
		p.ArchivedAt, p.PinnedAt = fromNullMs(archived), fromNullMs(pinned)
		last := created
		if sUp > last {
			last = sUp
		}
		if tUp > last {
			last = tUp
		}
		p.LastActivity = fromMs(last)
		out = append(out, p)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	sort.SliceStable(out, func(i, j int) bool {
		a, b := out[i], out[j]
		if (a.PinnedAt != nil) != (b.PinnedAt != nil) {
			return a.PinnedAt != nil
		}
		if !a.LastActivity.Equal(b.LastActivity) {
			return a.LastActivity.After(b.LastActivity)
		}
		return a.Name < b.Name
	})
	return out, nil
}

// ProjectPatch is what UpdateProject changes; nil fields stay.
type ProjectPatch struct {
	// MainSession: promote this session (it must be a Claude Code session of the project).
	MainSession *string
	Name        *string
	Dir         *string
	HostID      *string
	Pinned      *bool
}

// UpdateProject renames, pins, or (only while it has no sessions) moves a project.
func (s *Store) UpdateProject(ctx context.Context, id string, patch ProjectPatch) (*Project, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	p, err := scanProject(tx.QueryRowContext(ctx, `SELECT `+projectCols+` FROM projects WHERE id=?`, id))
	if err != nil {
		return nil, err
	}
	if patch.Name != nil {
		name := strings.TrimSpace(*patch.Name)
		if name == "" {
			return nil, errors.New("name is required")
		}
		if err := nameFree(ctx, tx, name, id); err != nil {
			return nil, err
		}
		p.Name = name
	}
	if patch.MainSession != nil {
		if err := setMain(ctx, tx, id, *patch.MainSession); err != nil {
			return nil, err
		}
	}
	if patch.Pinned != nil {
		if *patch.Pinned {
			now := s.now()
			p.PinnedAt = &now
		} else {
			p.PinnedAt = nil
		}
	}
	if patch.Dir != nil || patch.HostID != nil {
		dir, host := p.Dir, p.HostID
		if patch.Dir != nil {
			if dir = CleanProjectDir(*patch.Dir); dir == "" {
				return nil, errors.New("dir must be an absolute path")
			}
		}
		if patch.HostID != nil && *patch.HostID != "" {
			host = *patch.HostID
		}
		if dir != p.Dir || host != p.HostID {
			var n int
			if err := tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM sessions WHERE project_id=?`, id).Scan(&n); err != nil {
				return nil, err
			}
			if n > 0 {
				return nil, fmt.Errorf("%w: folder and host cannot change", ErrProjectBusy)
			}
			if o, err := findProject(ctx, tx, host, dir); err == nil && o.ID != id && o.ArchivedAt == nil {
				return nil, ErrProjectExists
			}
			p.Dir, p.HostID = dir, host
		}
	}
	var pinned any
	if p.PinnedAt != nil {
		pinned = ms(*p.PinnedAt)
	}
	if _, err := tx.ExecContext(ctx, `UPDATE projects SET name=?, dir=?, host_id=?, pinned_at=? WHERE id=?`, p.Name, p.Dir, p.HostID, pinned, id); err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return s.GetProject(ctx, id)
}

// SetProjectArchived archives a project without live sessions (its ended sessions are archived with
// it) or brings it back, with the sessions that were archived with it.
func (s *Store) SetProjectArchived(ctx context.Context, id string, archived bool) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	p, err := scanProject(tx.QueryRowContext(ctx, `SELECT `+projectCols+` FROM projects WHERE id=?`, id))
	if err != nil {
		return err
	}
	if archived {
		if p.ArchivedAt != nil {
			return nil
		}
		var live int
		if err := tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM sessions WHERE project_id=? AND archived_at IS NULL AND status!=?`, id, StatusEnded).Scan(&live); err != nil {
			return err
		}
		if live > 0 {
			return fmt.Errorf("%w: stop or archive its %d live session(s) first", ErrProjectBusy, live)
		}
		at := ms(s.now())
		if _, err := tx.ExecContext(ctx, `UPDATE sessions SET archived_at=? WHERE project_id=? AND archived_at IS NULL`, at, id); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `UPDATE projects SET archived_at=? WHERE id=?`, at, id); err != nil {
			return err
		}
	} else {
		if p.ArchivedAt == nil {
			return nil
		}
		if o, err := findProject(ctx, tx, p.HostID, p.Dir); err == nil && o.ID != id && o.ArchivedAt == nil {
			return ErrProjectExists
		}
		if _, err := tx.ExecContext(ctx, `UPDATE sessions SET archived_at=NULL WHERE project_id=? AND archived_at=?`, id, ms(*p.ArchivedAt)); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `UPDATE projects SET archived_at=NULL WHERE id=?`, id); err != nil {
			return err
		}
	}
	return tx.Commit()
}

// DeleteProject deletes a project with all its sessions, threads, messages, annotations and
// attachments (the rows cascade; attachment content lives in the database) in one transaction.
// Notification thread mappings of those threads go too; cards that pointed at them stay,
// unlinked. Nothing on the host's disk is touched. The caller stops running sessions first.
func (s *Store) DeleteProject(ctx context.Context, id string) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	var found string
	if err := tx.QueryRowContext(ctx, `SELECT id FROM projects WHERE id=?`, id).Scan(&found); errors.Is(err, sql.ErrNoRows) {
		return ErrNotFound
	} else if err != nil {
		return err
	}
	const inProject = `(SELECT s.id FROM sessions s WHERE s.project_id=?)`
	const threadsOf = `(SELECT t.id FROM threads t JOIN sessions s ON s.id=t.session_id WHERE s.project_id=?)`
	for _, q := range []string{
		`DELETE FROM notification_slack_threads WHERE minbox_thread_id IN ` + threadsOf,
		`UPDATE cards SET thread_id=NULL WHERE thread_id IN ` + threadsOf,
		`UPDATE cards SET session_id=NULL WHERE session_id IN ` + inProject,
		`DELETE FROM sessions WHERE project_id=?`,
		`DELETE FROM projects WHERE id=?`,
	} {
		if _, err := tx.ExecContext(ctx, q, id); err != nil {
			return err
		}
	}
	return tx.Commit()
}

// DeletePreview is what deleting a project takes with it.
type DeletePreview struct {
	Sessions        int `json:"sessions"`
	RunningSessions int `json:"running_sessions"` // not ended: their processes are stopped first
	Threads         int `json:"threads"`
	Messages        int `json:"messages"`
}

// ProjectDeletePreview counts what DeleteProject would remove.
func (s *Store) ProjectDeletePreview(ctx context.Context, id string) (*DeletePreview, error) {
	if _, err := s.GetProject(ctx, id); err != nil {
		return nil, err
	}
	var d DeletePreview
	err := s.db.QueryRowContext(ctx, `SELECT
	  (SELECT COUNT(*) FROM sessions WHERE project_id=?1),
	  (SELECT COUNT(*) FROM sessions WHERE project_id=?1 AND status!=?2),
	  (SELECT COUNT(*) FROM threads t JOIN sessions s ON s.id=t.session_id WHERE s.project_id=?1),
	  (SELECT COUNT(*) FROM messages m JOIN threads t ON t.id=m.thread_id JOIN sessions s ON s.id=t.session_id WHERE s.project_id=?1)`,
		id, StatusEnded).Scan(&d.Sessions, &d.RunningSessions, &d.Threads, &d.Messages)
	return &d, err
}

// unarchiveProjectOf: a session came back, so its project is not archived any more.
func (s *Store) unarchiveProjectOf(ctx context.Context, sessionID string) error {
	_, err := s.db.ExecContext(ctx, `UPDATE projects SET archived_at=NULL WHERE archived_at IS NOT NULL AND id=(SELECT project_id FROM sessions WHERE id=?)`, sessionID)
	return err
}

// migrateProjects gives every session without a (valid) project one, in a single transaction.
// It is idempotent: sessions that have a project are not touched.
func migrateProjects(ctx context.Context, db *sql.DB) error {
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	rows, err := tx.QueryContext(ctx, `SELECT id, host_id, cwd, created_at, archived_at FROM sessions
	  WHERE project_id IS NULL OR project_id='' OR project_id NOT IN (SELECT id FROM projects) ORDER BY created_at, rowid`)
	if err != nil {
		return err
	}
	type group struct {
		host, dir string
		first     int64
		ids       []string
		allArch   bool
		lastArch  int64
	}
	var order []*group
	byKey := map[string]*group{}
	for rows.Next() {
		var id, host, cwd string
		var created int64
		var archived sql.NullInt64
		if err := rows.Scan(&id, &host, &cwd, &created, &archived); err != nil {
			rows.Close()
			return err
		}
		if host == "" {
			host = LocalHostID
		}
		dir := CleanProjectDir(cwd)
		k := host + "\x00" + dir
		g := byKey[k]
		if g == nil {
			g = &group{host: host, dir: dir, first: created, allArch: true}
			byKey[k] = g
			order = append(order, g)
		}
		g.ids = append(g.ids, id)
		if !archived.Valid {
			g.allArch = false
		} else if archived.Int64 > g.lastArch {
			g.lastArch = archived.Int64
		}
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}
	for _, g := range order {
		p, err := findProject(ctx, tx, g.host, g.dir)
		if errors.Is(err, ErrNotFound) {
			var arch *time.Time
			if g.allArch {
				t := fromMs(g.lastArch)
				arch = &t
			}
			p, err = insertProject(ctx, tx, baseName(g.dir), g.dir, g.host, fromMs(g.first), arch)
		}
		if err != nil {
			return err
		}
		for _, id := range g.ids {
			if _, err := tx.ExecContext(ctx, `UPDATE sessions SET project_id=? WHERE id=?`, p.ID, id); err != nil {
				return err
			}
		}
		// A live session in an archived project brings it back.
		if !g.allArch && p.ArchivedAt != nil {
			if _, err := tx.ExecContext(ctx, `UPDATE projects SET archived_at=NULL WHERE id=?`, p.ID); err != nil {
				return err
			}
		}
	}
	if err := pickMains(ctx, tx); err != nil {
		return err
	}
	return tx.Commit()
}

// setMain makes a session the main one of the project: it must belong to it and be a Claude Code session.
func setMain(ctx context.Context, q querier, projectID, sessionID string) error {
	var kind, proj string
	err := q.QueryRowContext(ctx, `SELECT kind, COALESCE(project_id,'') FROM sessions WHERE id=?`, sessionID).Scan(&kind, &proj)
	if errors.Is(err, sql.ErrNoRows) || (err == nil && proj != projectID) {
		return errors.New("the main session must be a session of the project")
	}
	if err != nil {
		return err
	}
	if kind != KindClaude {
		return errors.New("the main session must be a Claude Code session, not a shell")
	}
	_, err = q.ExecContext(ctx, `UPDATE projects SET main_session_id=? WHERE id=?`, sessionID, projectID)
	return err
}

// ReleaseMain is called before a main session is deleted or archived. If it is not main, nothing
// happens. promote names another session to make main; without it the session may go only when
// the project has no other live Claude Code session (then the project has no main until one is
// started), else ErrSessionIsMain.
func (s *Store) ReleaseMain(ctx context.Context, sessionID, promote string) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	var pid string
	err = tx.QueryRowContext(ctx, `SELECT id FROM projects WHERE main_session_id=?`, sessionID).Scan(&pid)
	if errors.Is(err, sql.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	if promote != "" {
		if promote == sessionID {
			return ErrSessionIsMain
		}
		if err := setMain(ctx, tx, pid, promote); err != nil {
			return err
		}
		return tx.Commit()
	}
	var others int
	if err := tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM sessions WHERE project_id=? AND id!=? AND kind=? AND archived_at IS NULL`, pid, sessionID, KindClaude).Scan(&others); err != nil {
		return err
	}
	if others > 0 {
		return fmt.Errorf("%w: set another session as main first", ErrSessionIsMain)
	}
	if _, err := tx.ExecContext(ctx, `UPDATE projects SET main_session_id=NULL WHERE id=?`, pid); err != nil {
		return err
	}
	return tx.Commit()
}

// pickMains gives each project without a (valid) main session one: its most recently active
// Claude Code session, a live one before an ended one before an archived one. Shell sessions never.
func pickMains(ctx context.Context, q querier) error {
	_, err := q.ExecContext(ctx, `UPDATE projects SET main_session_id=(
	    SELECT s.id FROM sessions s WHERE s.project_id=projects.id AND s.kind=?
	    ORDER BY s.archived_at IS NOT NULL, s.status=?, s.updated_at DESC, s.created_at DESC, s.rowid DESC LIMIT 1)
	  WHERE main_session_id IS NULL OR main_session_id='' OR main_session_id NOT IN (SELECT id FROM sessions)`, KindClaude, StatusEnded)
	return err
}
