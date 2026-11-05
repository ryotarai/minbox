package server

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/ryotarai/minbox/internal/store"
)

func TestRestartRunningSession(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	sess := e.createSession()
	_ = e.st.SetSessionStatus(ctx, sess.ID, store.StatusIdle)
	// A companion shell is running and stays.
	if err := e.srv.sessions.ensureShell(ctx, sess); err != nil {
		t.Fatal(err)
	}
	shell := shellTermID(sess.ID)
	n := len(e.host.spawned)

	// The host reports the exit once the terminal is killed, like the real one.
	done := make(chan struct{})
	go func() {
		defer close(done)
		for {
			e.host.mu.Lock()
			running := e.host.terms[sess.ID].Running
			e.host.mu.Unlock()
			if !running {
				e.srv.sessions.onExit(ctx, sess.ID, 0)
				return
			}
			time.Sleep(10 * time.Millisecond)
		}
	}()
	code, _, _ := e.do("POST", "/api/sessions/"+sess.ID+"/restart", nil, nil)
	if code != 200 {
		t.Fatalf("restart: %d", code)
	}
	<-done
	got, _ := e.st.GetSession(ctx, sess.ID)
	if got.Status != store.StatusStarting {
		t.Fatalf("status = %s", got.Status)
	}
	if len(e.host.spawned) != n+1 {
		t.Fatalf("spawned %d, want %d", len(e.host.spawned), n+1)
	}
	last := e.host.spawned[len(e.host.spawned)-1]
	if last.ID != sess.ID {
		t.Fatalf("spawned %s", last.ID)
	}
	// No transcript in the test: the same conversation id starts again.
	if a := strings.Join(last.Argv, " "); !strings.Contains(a, sess.ClaudeSessionID) {
		t.Fatalf("argv = %s", a)
	}
	if !e.host.terms[sess.ID].Running || !e.host.terms[shell].Running {
		t.Fatal("terminal or companion shell not running")
	}
}

func TestRestartTimesOutWhenTerminalStaysUp(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	sess := e.createSession()
	_ = e.st.SetSessionStatus(ctx, sess.ID, store.StatusIdle)
	old := restartWait
	restartWait = 300 * time.Millisecond
	defer func() { restartWait = old }()
	e.host.stubborn = sess.ID // Kill leaves it running
	code, _, _ := e.do("POST", "/api/sessions/"+sess.ID+"/restart", nil, nil)
	if code != 400 {
		t.Fatalf("restart: %d", code)
	}
	// The restart is over: a new one is not refused as in progress.
	e.srv.sessions.mu.Lock()
	busy := e.srv.sessions.restarting[sess.ID] != nil
	e.srv.sessions.mu.Unlock()
	if busy {
		t.Fatal("restart still marked in progress")
	}
}

func TestDoubleRestartIs409(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	sess := e.createSession()
	_ = e.st.SetSessionStatus(ctx, sess.ID, store.StatusIdle)
	e.host.stubborn = sess.ID // the first restart waits for an exit that has not come yet
	first := make(chan int, 1)
	go func() {
		code, _, _ := e.do("POST", "/api/sessions/"+sess.ID+"/restart", nil, nil)
		first <- code
	}()
	deadline := time.Now().Add(3 * time.Second)
	for {
		e.srv.sessions.mu.Lock()
		busy := e.srv.sessions.restarting[sess.ID] != nil
		e.srv.sessions.mu.Unlock()
		if busy {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("restart never started")
		}
		time.Sleep(5 * time.Millisecond)
	}
	if code, _, _ := e.do("POST", "/api/sessions/"+sess.ID+"/restart", nil, nil); code != 409 {
		t.Fatalf("second restart: %d", code)
	}
	e.srv.sessions.onExit(ctx, sess.ID, 0) // the exit event: the first one finishes
	if code := <-first; code != 200 {
		t.Fatalf("first restart: %d", code)
	}
}

func TestRestartEndedSessionIsResume(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	sess := e.createSession()
	_ = e.st.SetSessionEnded(ctx, sess.ID, 0)
	n := len(e.host.spawned)
	if code, _, _ := e.do("POST", "/api/sessions/"+sess.ID+"/restart", nil, nil); code != 200 {
		t.Fatalf("restart: %d", code)
	}
	if len(e.host.spawned) != n+1 {
		t.Fatal("not spawned")
	}
	if got, _ := e.st.GetSession(ctx, sess.ID); got.Status != store.StatusStarting {
		t.Fatalf("status = %s", got.Status)
	}
}
