package store

import (
	"context"
	"errors"
	"path/filepath"
	"testing"
)

func mainOf(t *testing.T, s *Store, projectID string) string {
	t.Helper()
	p, err := s.GetProject(context.Background(), projectID)
	if err != nil {
		t.Fatal(err)
	}
	return p.MainSessionID
}

func TestMigrationPicksMainSessions(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "old.db")
	db := oldDB(t, path)
	for _, o := range []oldSession{
		// /live: an older working session, a newer idle one, an ended newest one, a shell: the newest live Claude session.
		{id: "l1", host: "local", kind: "claude", cwd: "/live", status: "working", created: 10},
		{id: "l2", host: "local", kind: "claude", cwd: "/live", status: "idle", created: 20},
		{id: "l3", host: "local", kind: "claude", cwd: "/live", status: "ended", created: 30},
		{id: "l4", host: "local", kind: "shell", cwd: "/live", status: "idle", created: 40},
		// /ended: only ended and archived ones: the newest ended (not archived) one.
		{id: "e1", host: "local", kind: "claude", cwd: "/ended", status: "ended", created: 50},
		{id: "e2", host: "local", kind: "claude", cwd: "/ended", status: "ended", created: 60, archived: 100},
		// /shells: shell sessions only: no main.
		{id: "s1", host: "local", kind: "shell", cwd: "/shells", status: "idle", created: 70},
	} {
		o.insert(t, db)
	}
	db.Close()
	s, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	want := map[string]string{"l2": "l2", "e1": "e1"}
	for sid, main := range want {
		if got := mainOf(t, s, projectOf(t, s, sid).ID); got != main {
			t.Errorf("main of %s's project = %q, want %q", sid, got, main)
		}
	}
	if got := mainOf(t, s, projectOf(t, s, "s1").ID); got != "" {
		t.Errorf("shell-only project main = %q", got)
	}
	if sess, _ := s.GetSession(ctx, "l2"); !sess.IsMain {
		t.Error("l2 should report is_main")
	}
	if sess, _ := s.GetSession(ctx, "l1"); sess.IsMain {
		t.Error("l1 must not be main")
	}
	// Idempotent: a second run keeps the choice, and a promoted session stays.
	pid := projectOf(t, s, "l1").ID
	id := "l1"
	if _, err := s.UpdateProject(ctx, pid, ProjectPatch{MainSession: &id}); err != nil {
		t.Fatal(err)
	}
	if err := migrateProjects(ctx, s.db); err != nil {
		t.Fatal(err)
	}
	if got := mainOf(t, s, pid); got != "l1" {
		t.Errorf("main after re-run = %q", got)
	}
}

func TestMainSessionRules(t *testing.T) {
	ctx := context.Background()
	s := newStore(t)

	// The first Claude Code session of a project becomes main; later ones and shells do not.
	a, _ := s.CreateSession(ctx, "a", "/p", "u1")
	if !a.IsMain || mainOf(t, s, a.ProjectID) != a.ID {
		t.Fatalf("first session should be main: %+v", a)
	}
	sh, _ := s.CreateSessionKind(ctx, "local", KindShell, "sh", "/p", "")
	b, _ := s.CreateSession(ctx, "b", "/p", "u2")
	if sh.IsMain || b.IsMain || mainOf(t, s, a.ProjectID) != a.ID {
		t.Fatal("only one main")
	}
	// A project that begins with a shell gets its main from the first Claude Code session.
	sh2, _ := s.CreateSessionKind(ctx, "local", KindShell, "sh2", "/q", "")
	if mainOf(t, s, sh2.ProjectID) != "" {
		t.Fatal("a shell must not be main")
	}
	c, _ := s.CreateSession(ctx, "c", "/q", "u3")
	if mainOf(t, s, c.ProjectID) != c.ID {
		t.Fatal("first Claude session of the project should be main")
	}

	// Promotion: must be a Claude Code session of the project.
	for _, bad := range []string{sh.ID, c.ID, "ses_none"} {
		bad := bad
		if _, err := s.UpdateProject(ctx, a.ProjectID, ProjectPatch{MainSession: &bad}); err == nil {
			t.Fatalf("promoted %q", bad)
		}
	}
	if _, err := s.UpdateProject(ctx, a.ProjectID, ProjectPatch{MainSession: &b.ID}); err != nil {
		t.Fatal(err)
	}
	if mainOf(t, s, a.ProjectID) != b.ID {
		t.Fatal("promotion failed")
	}
	if sa, _ := s.GetSession(ctx, a.ID); sa.IsMain {
		t.Fatal("old main still main")
	}

	// Ending the main session keeps it main.
	_ = s.SetSessionEnded(ctx, b.ID, 0)
	if mainOf(t, s, a.ProjectID) != b.ID {
		t.Fatal("ended main must stay main")
	}

	// Archiving or deleting the main is refused while another Claude session lives...
	if err := s.ReleaseMain(ctx, b.ID, ""); !errors.Is(err, ErrSessionIsMain) {
		t.Fatalf("release with others: %v", err)
	}
	// ...unless another is promoted in the same breath.
	if err := s.ReleaseMain(ctx, b.ID, a.ID); err != nil {
		t.Fatal(err)
	}
	if mainOf(t, s, a.ProjectID) != a.ID {
		t.Fatal("promote on release")
	}
	// A non-main session is free to go.
	if err := s.ReleaseMain(ctx, b.ID, ""); err != nil {
		t.Fatal(err)
	}
	// The last Claude session may go: the project is left without main (the shell does not count).
	_ = s.SetSessionArchived(ctx, b.ID, true)
	if err := s.ReleaseMain(ctx, a.ID, ""); err != nil {
		t.Fatalf("last claude session: %v", err)
	}
	if mainOf(t, s, a.ProjectID) != "" {
		t.Fatal("main should be cleared")
	}
	// ...and the next Claude session started there becomes main.
	d, _ := s.CreateSession(ctx, "d", "/p", "u4")
	if mainOf(t, s, a.ProjectID) != d.ID {
		t.Fatal("next session should be main")
	}
}
