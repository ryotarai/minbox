package store

import (
	"context"
	"database/sql"
	"path/filepath"
	"strings"
	"testing"
)

// A database from before coding agents (no sessions.agent, no projects.default_agent) opens, and every
// session in it is a Claude Code session.
func TestMigrationGivesOldSessionsTheClaudeAgent(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "pre-agent.db")
	db, err := sql.Open("sqlite", "file:"+path+"?_pragma=foreign_keys(1)&_pragma=journal_mode(WAL)&_pragma=busy_timeout(5000)")
	if err != nil {
		t.Fatal(err)
	}
	db.SetMaxOpenConns(1)
	if _, err := db.Exec(schema); err != nil {
		t.Fatal(err)
	}
	for _, c := range addedColumns {
		if c.column == "agent" || c.column == "default_agent" || strings.HasPrefix(c.table, "notification_") {
			continue
		}
		if _, err := db.Exec("ALTER TABLE " + c.table + " ADD COLUMN " + c.column + " " + c.def); err != nil {
			t.Fatalf("%s.%s: %v", c.table, c.column, err)
		}
	}
	if _, err := db.Exec(`INSERT INTO hosts(id,name,url,builtin,created_at) VALUES('local','local','',1,1)`); err != nil {
		t.Fatal(err)
	}
	oldSession{id: "old1", host: "local", kind: "claude", cwd: "/work/api", status: "idle", created: 10}.insert(t, db)
	db.Close()

	s, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	got, err := s.GetSession(ctx, "old1")
	if err != nil {
		t.Fatal(err)
	}
	if got.Agent != "claude" {
		t.Fatalf("agent = %q", got.Agent)
	}
	p := projectOf(t, s, "old1")
	if p.DefaultAgent != "" {
		t.Fatalf("default_agent = %q", p.DefaultAgent)
	}

	// New sessions record their agent; the project default round-trips.
	pi, err := s.CreateSessionAgent(ctx, p.ID, KindClaude, "pi", "n", "/work/api", "conv-1")
	if err != nil || pi.Agent != "pi" {
		t.Fatalf("pi session: %+v %v", pi, err)
	}
	if again, _ := s.GetSession(ctx, pi.ID); again.Agent != "pi" || again.ClaudeSessionID != "conv-1" {
		t.Fatalf("stored: %+v", again)
	}
	if plain, err := s.CreateSessionIn(ctx, p.ID, KindClaude, "n", "/work/api", "c2"); err != nil || plain.Agent != "claude" {
		t.Fatalf("CreateSessionIn keeps creating Claude sessions: %+v %v", plain, err)
	}
	piDefault := "pi"
	up, err := s.UpdateProject(ctx, p.ID, ProjectPatch{DefaultAgent: &piDefault})
	if err != nil || up.DefaultAgent != "pi" {
		t.Fatalf("update: %+v %v", up, err)
	}
	list, _ := s.ListProjects(ctx, false)
	if len(list) != 1 || list[0].DefaultAgent != "pi" {
		t.Fatalf("list: %+v", list)
	}
	empty := ""
	if up, _ := s.UpdateProject(ctx, p.ID, ProjectPatch{DefaultAgent: &empty}); up.DefaultAgent != "" {
		t.Fatalf("cleared: %+v", up)
	}
}
