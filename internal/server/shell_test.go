package server

import (
	"context"
	"strings"
	"testing"

	"github.com/ryotarai/minbox/internal/store"
)

func TestCompanionShell(t *testing.T) {
	e := newEnv(t)
	sess := e.createSession()
	ctx := context.Background()
	id := sess.ID + ":shell"

	if err := e.srv.sessions.ensureShell(ctx, sess); err != nil {
		t.Fatal(err)
	}
	if err := e.srv.sessions.ensureShell(ctx, sess); err != nil {
		t.Fatal(err)
	}
	n := 0
	for _, r := range e.host.spawned {
		if r.ID != id {
			continue
		}
		n++
		if r.Cwd != sess.Cwd || !r.InheritEnv || len(r.Argv) == 0 || r.Argv[0] != "/bin/sh" {
			t.Fatalf("spawn = %+v", r)
		}
		for _, kv := range r.Env {
			if strings.HasPrefix(kv, "MINBOX_") {
				t.Fatalf("shell got the mod env: %s", kv)
			}
		}
	}
	if n != 1 {
		t.Fatalf("spawned %d shells, want 1 (second ensure reuses it)", n)
	}

	// It is not a session.
	list, _ := e.st.ListSessions(ctx)
	if len(list) != 1 {
		t.Fatalf("sessions = %d", len(list))
	}
	// Its exit does not touch the session.
	e.srv.sessions.onExit(ctx, id, 0)
	if got, _ := e.st.GetSession(ctx, sess.ID); got.Status == store.StatusEnded {
		t.Fatal("shell exit ended the session")
	}
	// An exited shell is started again.
	_ = e.host.Kill(ctx, id)
	if err := e.srv.sessions.ensureShell(ctx, sess); err != nil {
		t.Fatal(err)
	}
	if !e.host.terms[id].Running {
		t.Fatal("shell not restarted")
	}

	// Stop ends it.
	if err := e.srv.sessions.Stop(ctx, sess.ID); err != nil {
		t.Fatal(err)
	}
	if _, ok := e.host.terms[id]; ok {
		t.Fatal("shell survived stop")
	}
	ended, _ := e.st.GetSession(ctx, sess.ID)
	if err := e.srv.sessions.ensureShell(ctx, ended); err == nil {
		t.Fatal("ensureShell on an ended session")
	}
}

func TestCompanionShellDeleteAndKinds(t *testing.T) {
	e := newEnv(t)
	sess := e.createSession()
	ctx := context.Background()
	if err := e.srv.sessions.ensureShell(ctx, sess); err != nil {
		t.Fatal(err)
	}
	if err := e.srv.sessions.Delete(ctx, sess.ID, ""); err != nil {
		t.Fatal(err)
	}
	if _, ok := e.host.terms[sess.ID+":shell"]; ok {
		t.Fatal("shell survived delete")
	}

	code, obj, _ := e.do("POST", "/api/sessions", map[string]string{"cwd": e.dir, "kind": "shell"}, nil)
	if code != 201 {
		t.Fatal(code, obj)
	}
	sh, _ := e.st.GetSession(ctx, obj["id"].(string))
	if err := e.srv.sessions.ensureShell(ctx, sh); err == nil {
		t.Fatal("shell session got a companion shell")
	}
	if code, _, _ := e.do("GET", "/api/sessions/"+sh.ID+"/shell/terminal", nil, nil); code != 400 {
		t.Fatalf("shell kind: %d", code)
	}
	if code, _, _ := e.do("GET", "/api/sessions/nope/shell/terminal", nil, nil); code != 404 {
		t.Fatalf("missing: %d", code)
	}
}
