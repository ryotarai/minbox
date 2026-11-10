package server

import (
	"context"
	"path/filepath"
	"strings"
	"testing"

	"github.com/ryotarai/minbox/internal/store"
)

func hasFlag(argv []string, flag string) bool {
	for _, a := range argv {
		if a == flag {
			return true
		}
	}
	return false
}

// A project's folder change: the session keeps running (and its record) until its next start; then
// it starts a FRESH conversation in the new folder (no --resume), told of the old folder and id, once.
func TestRelocatedSessionStartsFreshInNewFolder(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	sess := e.createSession()
	oldDir, oldID := sess.Cwd, sess.ClaudeSessionID
	cfgDir := t.TempDir()
	t.Setenv("CLAUDE_CONFIG_DIR", cfgDir)
	if err := mkdirWrite(filepath.Join(cfgDir, "projects", projectDirName(oldDir)), oldID+".jsonl"); err != nil {
		t.Fatal(err)
	}
	other := e.mkdir("moved")
	if code, _, _ := e.do("PATCH", "/api/projects/"+sess.ProjectID, map[string]any{"dir": other}, nil); code != 200 {
		t.Fatalf("patch: %d", code)
	}
	// Running: untouched; the move waits for its next start; no note yet.
	got, _ := e.st.GetSession(ctx, sess.ID)
	if got.Cwd != oldDir || got.ClaudeSessionID != oldID || got.RelocateTo != other {
		t.Fatalf("after patch: %+v", got)
	}
	_, hello, _ := e.do("POST", "/api/agent/hello", map[string]any{}, bearer(sess))
	if strings.Contains(hello["instructions"].(string), "moved to a new folder") {
		t.Fatal("note before the move")
	}

	_ = e.st.SetSessionEnded(ctx, sess.ID, 0)
	n := len(e.host.spawned)
	if err := e.srv.sessions.Restart(ctx, sess.ID); err != nil {
		t.Fatal(err)
	}
	last := e.host.spawned[n]
	if last.Cwd != other || hasFlag(last.Argv, "--resume") {
		t.Fatalf("spawn cwd %q argv %v", last.Cwd, last.Argv)
	}
	got, _ = e.st.GetSession(ctx, sess.ID)
	if got.Cwd != other || got.RelocateTo != "" || got.PrevDir != oldDir || got.PrevClaudeSessionID != oldID || got.ClaudeSessionID == oldID || got.ClaudeSessionID == "" {
		t.Fatalf("after start: %+v", got)
	}
	if !strings.Contains(strings.Join(last.Argv, " "), "--session-id "+got.ClaudeSessionID) {
		t.Fatalf("argv %v", last.Argv)
	}
	p := lastPrompt(last.Argv)
	for _, want := range []string{oldDir, oldID, "projects/" + projectDirName(oldDir) + "/" + oldID + ".jsonl", other} {
		if !strings.Contains(p, want) {
			t.Fatalf("instructions lack %q: %s", want, p)
		}
	}
	// The hello carries the same text.
	_, hello, _ = e.do("POST", "/api/agent/hello", map[string]any{}, bearer(sess))
	if hello["instructions"] != p {
		t.Fatalf("hello differs from argv")
	}

	// Once: the next start resumes normally in the new folder (the new conversation has a transcript).
	if err := mkdirWrite(filepath.Join(cfgDir, "projects", projectDirName(other)), got.ClaudeSessionID+".jsonl"); err != nil {
		t.Fatal(err)
	}
	_ = e.st.SetSessionEnded(ctx, sess.ID, 0)
	if err := e.srv.sessions.Restart(ctx, sess.ID); err != nil {
		t.Fatal(err)
	}
	again := e.host.spawned[n+1]
	if again.Cwd != other || !strings.Contains(strings.Join(again.Argv, " "), "--resume "+got.ClaudeSessionID) {
		t.Fatalf("second start: cwd %q argv %v", again.Cwd, again.Argv)
	}
	if after, _ := e.st.GetSession(ctx, sess.ID); after.PrevClaudeSessionID != oldID || after.ClaudeSessionID != got.ClaudeSessionID {
		t.Fatalf("second start changed the record: %+v", after)
	}
}

// The server-restart path (Reconcile) relocates too; with no old transcript only the folder moves.
func TestReconcileRelocatesWithoutTranscript(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	t.Setenv("CLAUDE_CONFIG_DIR", t.TempDir())
	sess := e.createSession()
	_ = e.st.SetSessionStatus(ctx, sess.ID, store.StatusIdle)
	other := e.mkdir("moved2")
	if code, _, _ := e.do("PATCH", "/api/projects/"+sess.ProjectID, map[string]any{"dir": other}, nil); code != 200 {
		t.Fatalf("patch: %d", code)
	}
	fresh := newFakeHost()
	e.srv.sessions.setHost(fresh)
	if err := e.srv.sessions.Reconcile(ctx); err != nil {
		t.Fatal(err)
	}
	if len(fresh.spawned) != 1 || fresh.spawned[0].Cwd != other {
		t.Fatalf("spawned %+v", fresh.spawned)
	}
	got, _ := e.st.GetSession(ctx, sess.ID)
	if got.Cwd != other || got.ClaudeSessionID != sess.ClaudeSessionID || got.PrevDir != "" || strings.Contains(lastPrompt(fresh.spawned[0].Argv), "moved to a new folder") {
		t.Fatalf("%+v", got)
	}
}

// A project moved away and back before the session restarts leaves nothing pending; moving on
// again follows the project.
func TestRelocateBackAndForth(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	sess := e.createSession()
	other := e.mkdir("away")
	patch := func(dir string) {
		if code, _, _ := e.do("PATCH", "/api/projects/"+sess.ProjectID, map[string]any{"dir": dir}, nil); code != 200 {
			t.Fatalf("patch %s: %d", dir, code)
		}
	}
	patch(other)
	patch(sess.Cwd)
	if got, _ := e.st.GetSession(ctx, sess.ID); got.RelocateTo != "" {
		t.Fatalf("pending after moving back: %q", got.RelocateTo)
	}
	patch(other)
	third := e.mkdir("third")
	patch(third)
	if got, _ := e.st.GetSession(ctx, sess.ID); got.RelocateTo != third {
		t.Fatalf("pending = %q, want %q", got.RelocateTo, third)
	}
}
