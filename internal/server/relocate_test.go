package server

import (
	"context"
	"path/filepath"
	"strings"
	"testing"

	"github.com/ryotarai/minbox/internal/store"
	"github.com/ryotarai/minbox/internal/termhost"
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

// Two folder changes. relocateEnv runs one restart of sess and returns the spawn request.
type relocateEnv struct {
	t      *testing.T
	e      *env
	sess   *store.Session
	cfgDir string
}

func (r *relocateEnv) patch(dir string) {
	r.t.Helper()
	if code, _, _ := r.e.do("PATCH", "/api/projects/"+r.sess.ProjectID, map[string]any{"dir": dir}, nil); code != 200 {
		r.t.Fatalf("patch %s: %d", dir, code)
	}
}

func (r *relocateEnv) transcript(dir, id string) {
	r.t.Helper()
	if err := mkdirWrite(filepath.Join(r.cfgDir, "projects", projectDirName(dir)), id+".jsonl"); err != nil {
		r.t.Fatal(err)
	}
}

func (r *relocateEnv) restart() (termhost.SpawnRequest, *store.Session) {
	r.t.Helper()
	ctx := context.Background()
	n := len(r.e.host.spawned)
	_ = r.e.st.SetSessionEnded(ctx, r.sess.ID, 0)
	if err := r.e.srv.sessions.Restart(ctx, r.sess.ID); err != nil {
		r.t.Fatal(err)
	}
	got, _ := r.e.st.GetSession(ctx, r.sess.ID)
	return r.e.host.spawned[n], got
}

func newRelocateEnv(t *testing.T) *relocateEnv {
	e := newEnv(t)
	cfg := t.TempDir()
	t.Setenv("CLAUDE_CONFIG_DIR", cfg)
	return &relocateEnv{t: t, e: e, sess: e.createSession(), cfgDir: cfg}
}

// A -> B -> C before any restart: pending points at C; the first start is fresh in C, with A's id.
func TestRelocateTwiceBeforeRestart(t *testing.T) {
	r := newRelocateEnv(t)
	a, oldID := r.sess.Cwd, r.sess.ClaudeSessionID
	r.transcript(a, oldID)
	b, c := r.e.mkdir("b"), r.e.mkdir("c")
	r.patch(b)
	r.patch(c)
	if got, _ := r.e.st.GetSession(context.Background(), r.sess.ID); got.RelocateTo != c || got.Cwd != a {
		t.Fatalf("pending: %+v", got)
	}
	req, got := r.restart()
	if req.Cwd != c || hasFlag(req.Argv, "--resume") || got.Cwd != c || got.RelocateTo != "" ||
		got.PrevDir != a || got.PrevClaudeSessionID != oldID || got.ClaudeSessionID == oldID || len(got.PrevChain) != 0 {
		t.Fatalf("spawn %+v record %+v", req, got)
	}
	if p := lastPrompt(req.Argv); !strings.Contains(p, a) || strings.Contains(p, b) {
		t.Fatalf("instructions: %s", p)
	}
}

// A -> B, restart, B -> C, restart: fresh again in C, prev = B's conversation, A kept in the chain;
// the start after that resumes in C.
func TestRelocateTwiceWithRestartBetween(t *testing.T) {
	r := newRelocateEnv(t)
	a, oldID := r.sess.Cwd, r.sess.ClaudeSessionID
	r.transcript(a, oldID)
	b, c := r.e.mkdir("b"), r.e.mkdir("c")
	r.patch(b)
	_, g1 := r.restart()
	n1 := g1.ClaudeSessionID
	r.transcript(b, n1) // the person talked in B
	r.patch(c)
	req, g2 := r.restart()
	if req.Cwd != c || hasFlag(req.Argv, "--resume") || g2.Cwd != c || g2.PrevDir != b || g2.PrevClaudeSessionID != n1 ||
		g2.ClaudeSessionID == n1 || g2.ClaudeSessionID == oldID || g2.ClaudeSessionID == "" {
		t.Fatalf("spawn %+v record %+v", req, g2)
	}
	if len(g2.PrevChain) != 1 || g2.PrevChain[0].Dir != a || g2.PrevChain[0].ClaudeSessionID != oldID {
		t.Fatalf("chain %+v", g2.PrevChain)
	}
	p := lastPrompt(req.Argv)
	for _, want := range []string{b, n1, a, oldID} {
		if !strings.Contains(p, want) {
			t.Fatalf("instructions lack %q: %s", want, p)
		}
	}
	r.transcript(c, g2.ClaudeSessionID)
	req, g3 := r.restart()
	if req.Cwd != c || !strings.Contains(strings.Join(req.Argv, " "), "--resume "+g2.ClaudeSessionID) || g3.PrevClaudeSessionID != n1 {
		t.Fatalf("third start %+v %+v", req, g3)
	}
}

// A -> B, restart, nothing said in B, B -> C, restart: must not fail; only the folder moves, the
// older conversation stays the one the note names, and the Claude id is kept.
func TestRelocateTwiceWithoutTranscriptInMiddle(t *testing.T) {
	r := newRelocateEnv(t)
	a, oldID := r.sess.Cwd, r.sess.ClaudeSessionID
	r.transcript(a, oldID)
	b, c := r.e.mkdir("b"), r.e.mkdir("c")
	r.patch(b)
	_, g1 := r.restart()
	r.patch(c)
	req, g2 := r.restart()
	if req.Cwd != c || hasFlag(req.Argv, "--resume") || !strings.Contains(strings.Join(req.Argv, " "), "--session-id "+g1.ClaudeSessionID) {
		t.Fatalf("spawn %+v", req)
	}
	if g2.Cwd != c || g2.RelocateTo != "" || g2.ClaudeSessionID != g1.ClaudeSessionID || g2.PrevDir != a || g2.PrevClaudeSessionID != oldID {
		t.Fatalf("record %+v", g2)
	}
	p := lastPrompt(req.Argv)
	if !strings.Contains(p, c) || !strings.Contains(p, a) || !strings.Contains(p, oldID) {
		t.Fatalf("instructions: %s", p)
	}
}

// A running session is not touched by either change.
func TestRelocateTwiceLeavesRunningSessionAlone(t *testing.T) {
	r := newRelocateEnv(t)
	ctx := context.Background()
	a, id := r.sess.Cwd, r.sess.ClaudeSessionID
	_ = r.e.st.SetSessionStatus(ctx, r.sess.ID, store.StatusIdle)
	n := len(r.e.host.spawned)
	r.patch(r.e.mkdir("b"))
	r.patch(r.e.mkdir("c"))
	got, _ := r.e.st.GetSession(ctx, r.sess.ID)
	if got.Status != store.StatusIdle || got.Cwd != a || got.ClaudeSessionID != id || len(r.e.host.spawned) != n {
		t.Fatalf("running session disturbed: %+v spawned %d->%d", got, n, len(r.e.host.spawned))
	}
}
