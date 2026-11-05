package store

import (
	"context"
	"database/sql"
	"errors"
	"path/filepath"
	"strings"
	"testing"
)

// oldDB creates a database as the build before projects left it: no projects table, no
// sessions.project_id, and the rows the tests give it.
func oldDB(t *testing.T, path string) *sql.DB {
	t.Helper()
	db, err := sql.Open("sqlite", "file:"+path+"?_pragma=foreign_keys(1)&_pragma=journal_mode(WAL)&_pragma=busy_timeout(5000)")
	if err != nil {
		t.Fatal(err)
	}
	db.SetMaxOpenConns(1)
	a := strings.Index(schema, "CREATE TABLE IF NOT EXISTS projects")
	b := strings.Index(schema, "CREATE TABLE IF NOT EXISTS settings")
	if _, err := db.Exec(schema[:a] + schema[b:]); err != nil {
		t.Fatal(err)
	}
	for _, c := range addedColumns {
		if c.column == "project_id" {
			continue
		}
		if _, err := db.Exec("ALTER TABLE " + c.table + " ADD COLUMN " + c.column + " " + c.def); err != nil {
			t.Fatal(err)
		}
	}
	return db
}

type oldSession struct {
	id, host, kind, cwd, status string
	created                     int64
	archived                    int64 // 0 = not
}

func (o oldSession) insert(t *testing.T, db *sql.DB) {
	t.Helper()
	var arch any
	if o.archived != 0 {
		arch = o.archived
	}
	if _, err := db.Exec(`INSERT INTO sessions(id,name,cwd,status,token,created_at,updated_at,archived_at,host_id,kind) VALUES(?,?,?,?,?,?,?,?,?,?)`,
		o.id, o.id, o.cwd, o.status, "tok-"+o.id, o.created, o.created, arch, o.host, o.kind); err != nil {
		t.Fatal(err)
	}
}

func projectOf(t *testing.T, s *Store, sessionID string) *Project {
	t.Helper()
	sess, err := s.GetSession(context.Background(), sessionID)
	if err != nil {
		t.Fatal(err)
	}
	if sess.ProjectID == "" {
		t.Fatalf("session %s has no project", sessionID)
	}
	p, err := s.GetProject(context.Background(), sess.ProjectID)
	if err != nil {
		t.Fatal(err)
	}
	return p
}

func TestMigrateProjectsFromOldSchema(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "old.db")
	db := oldDB(t, path)
	if _, err := db.Exec(`INSERT INTO hosts(id,name,url,builtin,created_at) VALUES('local','local','',1,1),('gpu1','gpu1','http://gpu1',0,2),('gpu2','gpu2','http://gpu2',0,3)`); err != nil {
		t.Fatal(err)
	}
	for _, o := range []oldSession{
		{id: "a1", host: "local", kind: "claude", cwd: "/work/api", status: "idle", created: 10},
		{id: "a2", host: "local", kind: "claude", cwd: "/work/api/", status: "ended", created: 20}, // trailing slash: same project
		{id: "a3", host: "local", kind: "shell", cwd: "/work/api", status: "idle", created: 30},    // shell kind: same project
		{id: "d1", host: "local", kind: "claude", cwd: "/docs", status: "working", created: 40},
		{id: "sub", host: "local", kind: "claude", cwd: "/work/api/sub", status: "idle", created: 45}, // a sub-folder is its own project
		{id: "r1", host: "gpu1", kind: "claude", cwd: "/work/api", status: "idle", created: 50},       // same dir, other host, same name
		{id: "r2", host: "gpu2", kind: "claude", cwd: "/work/api", status: "idle", created: 60},
		{id: "e1", host: "local", kind: "claude", cwd: "", status: "ended", created: 70}, // no cwd: catch-all
		{id: "e2", host: "local", kind: "claude", cwd: "relative/dir", status: "idle", created: 80},
		{id: "e3", host: "gpu1", kind: "claude", cwd: "~/x", status: "idle", created: 90},
		{id: "z1", host: "local", kind: "claude", cwd: "/old/stuff", status: "ended", created: 100, archived: 500},
		{id: "z2", host: "local", kind: "claude", cwd: "/old/stuff", status: "ended", created: 110, archived: 600}, // all archived: project archived
		{id: "m1", host: "local", kind: "claude", cwd: "/mixed", status: "ended", created: 120, archived: 700},
		{id: "m2", host: "local", kind: "claude", cwd: "/mixed", status: "idle", created: 110},
		{id: "root", host: "local", kind: "shell", cwd: "/", status: "idle", created: 140},
		{id: "gone", host: "deleted-host", kind: "claude", cwd: "/work/api", status: "ended", created: 150},
	} {
		o.insert(t, db)
	}
	if _, err := db.Exec(`INSERT INTO threads(id,session_id,subject,created_at,updated_at) VALUES('th1','a1','hello',11,12),('th2','z1','old',101,102)`); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`INSERT INTO messages(id,thread_id,author,body,created_at) VALUES('m_1','th1','agent','hi',11)`); err != nil {
		t.Fatal(err)
	}
	db.Close()

	s, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()

	same := func(ids ...string) *Project {
		p := projectOf(t, s, ids[0])
		for _, id := range ids[1:] {
			if q := projectOf(t, s, id); q.ID != p.ID {
				t.Errorf("%s and %s should share a project, got %s and %s", ids[0], id, p.Name, q.Name)
			}
		}
		return p
	}
	api := same("a1", "a2", "a3")
	if api.Name != "api" || api.Dir != "/work/api" || api.HostID != "local" || api.SessionCount != 3 || api.ArchivedAt != nil {
		t.Errorf("api project = %+v", api)
	}
	if api.CreatedAt.UnixMilli() != 10 {
		t.Errorf("project created_at = %d, want the oldest session's (10)", api.CreatedAt.UnixMilli())
	}
	if p := same("d1"); p.Name != "docs" {
		t.Errorf("docs project = %+v", p)
	}
	if p := same("sub"); p.Name != "sub" || p.Dir != "/work/api/sub" {
		t.Errorf("sub project = %+v", p)
	}
	if p := same("r1"); p.Name != "api (gpu1)" || p.HostID != "gpu1" {
		t.Errorf("r1 project = %+v", p)
	}
	if p := same("r2"); p.Name != "api (gpu2)" {
		t.Errorf("r2 project = %+v", p)
	}
	if p := same("gone"); p.Name != "api (deleted-host)" || p.HostID != "deleted-host" {
		t.Errorf("gone project = %+v", p)
	}
	if p := same("e1", "e2"); p.Name != NoProjectName || p.Dir != "" || p.HostID != "local" {
		t.Errorf("catch-all = %+v", p)
	}
	if p := same("e3"); p.Dir != "" || p.HostID != "gpu1" || p.Name != "No project (gpu1)" {
		t.Errorf("remote catch-all = %+v", p)
	}
	if p := same("z1", "z2"); p.Name != "stuff" || p.ArchivedAt == nil || p.ArchivedAt.UnixMilli() != 600 {
		t.Errorf("archived project = %+v", p)
	}
	if p := same("m1", "m2"); p.ArchivedAt != nil {
		t.Errorf("a project with a live session must not be archived: %+v", p)
	}
	if p := same("root"); p.Name != "/" || p.Dir != "/" {
		t.Errorf("root project = %+v", p)
	}

	// Threads reach their project through the session.
	th, err := s.GetThread(ctx, "th1")
	if err != nil || th.ProjectID != api.ID || th.ProjectName != "api" || len(th.Messages) != 1 {
		t.Fatalf("thread = %+v, %v", th, err)
	}
	all, _ := s.ListAllThreads(ctx)
	if len(all) != 1 { // th2 sits in an archived session
		t.Fatalf("threads = %d", len(all))
	}

	// Idempotent: running again changes nothing, and nothing new is created.
	before, _ := s.ListProjects(ctx, true)
	if err := migrateProjects(ctx, s.db); err != nil {
		t.Fatal(err)
	}
	after, _ := s.ListProjects(ctx, true)
	if len(before) != len(after) || len(after) != 11 {
		t.Fatalf("projects before %d after %d, want 11", len(before), len(after))
	}
	for i := range before {
		if before[i].ID != after[i].ID || before[i].Name != after[i].Name {
			t.Fatalf("project changed: %+v -> %+v", before[i], after[i])
		}
	}
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}
	s2, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer s2.Close()
	if p, _ := s2.ListProjects(ctx, true); len(p) != 11 {
		t.Fatalf("after reopening: %d projects", len(p))
	}
}

// A database migrated by this build is opened by the previous build (here: its queries and inserts),
// which adds sessions without a project; the next start of this build assigns them.
func TestRollbackAndForwardAgain(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "x.db")
	db := oldDB(t, path)
	oldSession{id: "a", host: "local", kind: "claude", cwd: "/work/api", status: "idle", created: 1}.insert(t, db)
	db.Close()
	s, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	s.Close()

	db, err = sql.Open("sqlite", "file:"+path+"?_pragma=foreign_keys(1)&_pragma=busy_timeout(5000)")
	if err != nil {
		t.Fatal(err)
	}
	var n int
	if err := db.QueryRow(`SELECT COUNT(*) FROM sessions WHERE host_id='local'`).Scan(&n); err != nil || n != 1 {
		t.Fatalf("old build reads sessions: %d, %v", n, err)
	}
	oldSession{id: "b", host: "local", kind: "claude", cwd: "/work/api", status: "idle", created: 2}.insert(t, db)
	oldSession{id: "c", host: "local", kind: "claude", cwd: "/other", status: "idle", created: 3}.insert(t, db)
	db.Close()

	s, err = Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	if a, b := projectOf(t, s, "a"), projectOf(t, s, "b"); a.ID != b.ID {
		t.Errorf("session b should join a's project")
	}
	if c := projectOf(t, s, "c"); c.Name != "other" {
		t.Errorf("c = %+v", c)
	}
	if p, _ := s.ListProjects(ctx, true); len(p) != 2 {
		t.Errorf("projects = %d, want 2", len(p))
	}
}

func TestEnsureProjectAndCreateSession(t *testing.T) {
	ctx := context.Background()
	s := newStore(t)
	a, err := s.CreateSession(ctx, "one", "/work/api", "u1")
	if err != nil {
		t.Fatal(err)
	}
	b, _ := s.CreateSession(ctx, "two", "/work/api/", "u2") // same project
	if a.ProjectID == "" || a.ProjectID != b.ProjectID {
		t.Fatalf("projects %q %q", a.ProjectID, b.ProjectID)
	}
	c, _ := s.CreateSessionOn(ctx, "gpu1", "three", "/work/api", "u3") // another host: another project
	if c.ProjectID == a.ProjectID {
		t.Fatal("hosts must not share a project")
	}
	pc, _ := s.GetProject(ctx, c.ProjectID)
	if pc.Name != "api (gpu1)" || pc.HostID != "gpu1" {
		t.Fatalf("pc = %+v", pc)
	}
	// Explicit project: the folder comes from it, an override stays on the session.
	in, err := s.CreateSessionIn(ctx, a.ProjectID, KindClaude, "in", "", "u4")
	if err != nil || in.Cwd != "/work/api" || in.HostID != "local" {
		t.Fatalf("in = %+v, %v", in, err)
	}
	wt, _ := s.CreateSessionIn(ctx, a.ProjectID, KindClaude, "wt", "/work/api-wt", "u5")
	if wt.Cwd != "/work/api-wt" || wt.ProjectID != a.ProjectID {
		t.Fatalf("wt = %+v", wt)
	}
	if _, err := s.CreateSessionIn(ctx, "prj_nope", KindClaude, "x", "", ""); !errors.Is(err, ErrNotFound) {
		t.Fatalf("err = %v", err)
	}
	p, _ := s.GetProject(ctx, a.ProjectID)
	if p.SessionCount != 4 || p.LiveSessions != 4 {
		t.Fatalf("counts = %+v", p)
	}
}

func TestProjectRules(t *testing.T) {
	ctx := context.Background()
	s := newStore(t)
	sess, _ := s.CreateSession(ctx, "one", "/work/api", "u1")
	pid := sess.ProjectID

	// Rename: allowed, unique.
	name := "API"
	p, err := s.UpdateProject(ctx, pid, ProjectPatch{Name: &name})
	if err != nil || p.Name != "API" {
		t.Fatalf("rename: %+v %v", p, err)
	}
	other, err := s.CreateProject(ctx, "Docs", "/docs", "")
	if err != nil {
		t.Fatal(err)
	}
	dup := "api"
	if _, err := s.UpdateProject(ctx, other.ID, ProjectPatch{Name: &dup}); err == nil {
		t.Fatal("duplicate name accepted")
	}
	if _, err := s.CreateProject(ctx, "Whatever", "/work/api", ""); !errors.Is(err, ErrProjectExists) {
		t.Fatalf("duplicate folder: %v", err)
	}

	// dir/host change only while empty.
	dir := "/elsewhere"
	if _, err := s.UpdateProject(ctx, pid, ProjectPatch{Dir: &dir}); !errors.Is(err, ErrProjectBusy) {
		t.Fatalf("dir change with sessions: %v", err)
	}
	host := "gpu1"
	moved, err := s.UpdateProject(ctx, other.ID, ProjectPatch{Dir: &dir, HostID: &host})
	if err != nil || moved.Dir != "/elsewhere" || moved.HostID != "gpu1" {
		t.Fatalf("move empty project: %+v %v", moved, err)
	}

	// Archive refuses with a live session; delete refuses with any session.
	if err := s.SetProjectArchived(ctx, pid, true); !errors.Is(err, ErrProjectBusy) {
		t.Fatalf("archive with live session: %v", err)
	}
	if err := s.DeleteProject(ctx, pid); !errors.Is(err, ErrProjectBusy) {
		t.Fatalf("delete with session: %v", err)
	}
	// Once the session ended, archive works and takes the session with it...
	if err := s.SetSessionEnded(ctx, sess.ID, 0); err != nil {
		t.Fatal(err)
	}
	if err := s.DeleteProject(ctx, pid); !errors.Is(err, ErrProjectBusy) {
		t.Fatalf("delete with an ended session must still refuse: %v", err)
	}
	if err := s.SetProjectArchived(ctx, pid, true); err != nil {
		t.Fatal(err)
	}
	if got, _ := s.GetSession(ctx, sess.ID); got.ArchivedAt == nil {
		t.Fatal("ended session should be archived with its project")
	}
	if list, _ := s.ListProjects(ctx, false); len(list) != 1 || list[0].ID != other.ID {
		t.Fatalf("archived project listed: %+v", list)
	}
	// ...and back, restoring exactly that session.
	if err := s.SetProjectArchived(ctx, pid, false); err != nil {
		t.Fatal(err)
	}
	if got, _ := s.GetSession(ctx, sess.ID); got.ArchivedAt != nil {
		t.Fatal("session should come back with its project")
	}
	// A session brought back alone unarchives its project; so does a new one.
	_ = s.SetProjectArchived(ctx, pid, true)
	if err := s.SetSessionArchived(ctx, sess.ID, false); err != nil {
		t.Fatal(err)
	}
	if got, _ := s.GetProject(ctx, pid); got.ArchivedAt != nil {
		t.Fatal("unarchiving a session should unarchive its project")
	}
	_ = s.SetSessionEnded(ctx, sess.ID, 0)
	_ = s.SetProjectArchived(ctx, pid, true)
	if _, err := s.CreateSession(ctx, "again", "/work/api", "u9"); err != nil {
		t.Fatal(err)
	}
	if got, _ := s.GetProject(ctx, pid); got.ArchivedAt != nil {
		t.Fatal("a new session should unarchive its project")
	}

	// An empty project can be deleted; a missing one is not found.
	if err := s.DeleteProject(ctx, other.ID); err != nil {
		t.Fatal(err)
	}
	if err := s.DeleteProject(ctx, other.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("delete twice: %v", err)
	}

	// Pinned projects sort first.
	_, _ = s.CreateSession(ctx, "newer", "/zzz", "u10")
	list, _ := s.ListProjects(ctx, false)
	pin := true
	if list[0].Dir != "/zzz" {
		t.Fatalf("most recent first: %+v", list)
	}
	if _, err := s.UpdateProject(ctx, pid, ProjectPatch{Pinned: &pin}); err != nil {
		t.Fatal(err)
	}
	list, _ = s.ListProjects(ctx, false)
	if list[0].ID != pid || list[0].PinnedAt == nil {
		t.Fatalf("pinned first: %+v", list)
	}
}
