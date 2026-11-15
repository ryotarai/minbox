package server

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"testing"
	"testing/fstest"
	"time"

	"github.com/ryotarai/minbox/internal/store"
	"github.com/ryotarai/minbox/internal/termhost"
)

// realHostEnv is a server connected to real terminal hosts (in this process, on
// a socket of its own under /tmp) that its connection loop starts by itself, as
// `minbox start` does. starts counts the hosts started.
type realHostEnv struct {
	*env
	sock   string
	starts atomic.Int32
}

func newRealHostEnv(t *testing.T) *realHostEnv {
	t.Helper()
	// A short folder: Unix socket paths are limited to 104 bytes on macOS.
	dir, err := os.MkdirTemp("/tmp", "mbxt-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(dir) })
	script := filepath.Join(dir, "agent.sh")
	if err := os.WriteFile(script, []byte("#!/bin/sh\nexec sleep 300\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	st, err := store.Open(filepath.Join(dir, "db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })
	sock := filepath.Join(dir, "h.sock")
	cfg := Config{DataDir: dir, ClaudeCommand: []string{script}, PluginDir: "/plugin", ServerFile: filepath.Join(dir, "server.json"),
		ScratchDir: filepath.Join(dir, "scratch"), HostURL: "unix://" + sock}
	srv := New(cfg, st, fstest.MapFS{"index.html": {Data: []byte("<html>app</html>")}})
	ts := httptest.NewServer(srv)
	t.Cleanup(ts.Close)
	e := &realHostEnv{env: &env{t: t, srv: srv, st: st, ts: ts, dir: dir}, sock: sock}

	ctx, cancel := context.WithCancel(context.Background())
	var hosts sync.WaitGroup
	t.Cleanup(func() {
		cancel() // ends the hosts (and their sleeps)
		hosts.Wait()
	})
	connect := func(ctx context.Context) (*termhost.Client, error) {
		c, _, err := termhost.Ensure(ctx, sock, termhost.EnsureOptions{
			ServerVersion:      ProtocolVersion,
			ServerRequiresHost: RequiredHostVersion,
			Start: func() error {
				e.starts.Add(1)
				hosts.Add(1)
				go func() {
					defer hosts.Done()
					_ = termhost.Serve(ctx, sock, "test")
				}()
				return nil
			},
		})
		return c, err
	}
	if err := srv.RunHost(ctx, connect); err != nil {
		t.Fatal(err)
	}
	return e
}

func (e *realHostEnv) localHost() map[string]any {
	e.t.Helper()
	_, _, arr := e.do("GET", "/api/hosts", nil, nil)
	for _, h := range arr {
		if m := h.(map[string]any); m["id"] == store.LocalHostID {
			return m
		}
	}
	e.t.Fatalf("no local host in %v", arr)
	return nil
}

func (e *realHostEnv) terminals() map[string]bool {
	e.t.Helper()
	list, err := termhost.NewClient(e.sock, ProtocolVersion).List(context.Background())
	if err != nil {
		e.t.Fatal(err)
	}
	out := map[string]bool{}
	for _, t := range list {
		out[t.ID] = t.Running
	}
	return out
}

func TestRestartLocalHostResumesSessions(t *testing.T) {
	e := newRealHostEnv(t)
	code, sess, _ := e.do("POST", "/api/sessions", map[string]any{"name": "worker", "cwd": e.dir}, nil)
	if code != 201 {
		t.Fatalf("create = %d %v", code, sess)
	}
	id := sess["id"].(string)
	if !e.terminals()[id] {
		t.Fatalf("terminal of %s not running: %v", id, e.terminals())
	}
	before := e.localHost()
	if before["version"] != "test" || before["started_at"] == nil || before["restartable"] != true || before["version_status"] != "current" {
		t.Fatalf("local host = %v", before)
	}
	// So that the new host's start time is another one.
	time.Sleep(10 * time.Millisecond)

	code, res, _ := e.do("POST", "/api/hosts/local/restart", map[string]any{"resume": true}, nil)
	if code != 200 {
		t.Fatalf("restart = %d %v", code, res)
	}
	if e.starts.Load() != 2 {
		t.Fatalf("hosts started = %d, want 2", e.starts.Load())
	}
	stopped := res["sessions"].([]any)
	if len(stopped) != 1 || stopped[0].(map[string]any)["id"] != id || stopped[0].(map[string]any)["name"] != "worker" || res["resumed"] != true {
		t.Fatalf("result = %v", res)
	}
	after := e.localHost()
	if after["status"] != "online" || after["started_at"] == before["started_at"] {
		t.Fatalf("host after = %v (before %v)", after, before)
	}
	// The session was not closed by its process ending: it runs again in the new host.
	got, err := e.st.GetSession(context.Background(), id)
	if err != nil || got.Status == store.StatusEnded {
		t.Fatalf("session = %+v, %v", got, err)
	}
	if !e.terminals()[id] {
		t.Fatalf("session not resumed in the new host: %v", e.terminals())
	}
	// And a new session starts in it.
	if code, s2, _ := e.do("POST", "/api/sessions", map[string]any{"name": "second", "cwd": e.dir}, nil); code != 201 || !e.terminals()[s2["id"].(string)] {
		t.Fatalf("create after restart = %d %v", code, s2)
	}
}

func TestRestartLocalHostWithoutResumeEndsSessions(t *testing.T) {
	e := newRealHostEnv(t)
	_, sess, _ := e.do("POST", "/api/sessions", map[string]any{"name": "worker", "cwd": e.dir}, nil)
	id := sess["id"].(string)
	code, res, _ := e.do("POST", "/api/hosts/local/restart", map[string]any{"resume": false}, nil)
	if code != 200 || res["resumed"] != false {
		t.Fatalf("restart = %d %v", code, res)
	}
	got, _ := e.st.GetSession(context.Background(), id)
	if got.Status != store.StatusEnded {
		t.Fatalf("status = %s, want ended", got.Status)
	}
	if _, ok := e.terminals()[id]; ok {
		t.Fatalf("an ended session was started again: %v", e.terminals())
	}
}

func TestRestartLocalHostOneAtATime(t *testing.T) {
	e := newRealHostEnv(t)
	entered, unblock := make(chan struct{}), make(chan struct{})
	stop := e.srv.stopLocalHost
	var first sync.Once
	e.srv.stopLocalHost = func(ctx context.Context) (int, bool, error) {
		first.Do(func() {
			close(entered)
			<-unblock
		})
		return stop(ctx)
	}
	done := make(chan int)
	go func() {
		code, _, _ := e.do("POST", "/api/hosts/local/restart", nil, nil)
		done <- code
	}()
	<-entered
	if h := e.localHost(); h["restarting"] != true {
		t.Fatalf("host while restarting = %v", h)
	}
	if code, body, _ := e.do("POST", "/api/hosts/local/restart", nil, nil); code != 409 {
		t.Fatalf("second restart = %d %v, want 409", code, body)
	}
	close(unblock)
	if code := <-done; code != 200 {
		t.Fatalf("first restart = %d", code)
	}
	// Once it is done, another one may run.
	if code, body, _ := e.do("POST", "/api/hosts/local/restart", nil, nil); code != 200 {
		t.Fatalf("restart after = %d %v", code, body)
	}
	if e.starts.Load() != 3 {
		t.Fatalf("hosts started = %d, want 3", e.starts.Load())
	}
}

func TestRestartHostRefusals(t *testing.T) {
	e := newEnv(t)
	stops := 0
	e.srv.stopLocalHost = func(context.Context) (int, bool, error) { stops++; return 0, false, nil }
	// Another site's page cannot restart it.
	if code, _, _ := e.do("POST", "/api/hosts/local/restart", nil, map[string]string{"Origin": "https://evil.example"}); code != http.StatusForbidden {
		t.Fatalf("cross-origin = %d", code)
	}
	if code, _, _ := e.do("POST", "/api/hosts/nope/restart", nil, nil); code != 404 {
		t.Fatalf("unknown host = %d", code)
	}
	h, err := e.st.CreateHost(context.Background(), "devbox", "https://devbox.example:4849", store.MethodDirect, "", "")
	if err != nil {
		t.Fatal(err)
	}
	e.srv.sessions.hosts.put(&hostConn{id: h.ID, name: "devbox", latency: -1})
	if code, _, _ := e.do("POST", "/api/hosts/"+h.ID+"/restart", nil, nil); code != 400 {
		t.Fatalf("remote host = %d", code)
	}
	if stops != 0 {
		t.Fatalf("stopped %d times", stops)
	}
}

func TestHostVersionStatus(t *testing.T) {
	old := Version
	Version = "v1.2.0"
	defer func() { Version = old }()
	for _, c := range []struct {
		builtin            bool
		version, bin, sbin string
		want               string
	}{
		{true, "v1.2.0", "aaa", "aaa", "current"},
		{true, "v1.2.0", "aaa", "bbb", "outdated"},
		{true, "", "", "bbb", "unknown"}, // an older host: says nothing
		{false, "v1.2.0", "", "bbb", "current"},
		{false, "v1.1.0", "", "bbb", "outdated"},
		{false, "", "", "bbb", "unknown"},
	} {
		if got := hostVersionStatus(c.builtin, c.version, c.bin, c.sbin); got != c.want {
			t.Errorf("hostVersionStatus(%v, %q, %q, %q) = %q, want %q", c.builtin, c.version, c.bin, c.sbin, got, c.want)
		}
	}
	// The hosts list says it.
	e := newEnv(t)
	lc := e.srv.sessions.hosts.local()
	lc.setVersion(termhost.VersionInfo{Protocol: termhost.ProtocolVersion, Version: "v1.1.0", Binary: "old-build"}, 0)
	_, _, arr := e.do("GET", "/api/hosts", nil, nil)
	if h := arr[0].(map[string]any); h["version_status"] != "outdated" || h["version"] != "v1.1.0" {
		t.Fatalf("local host = %v", h)
	}
	lc.setVersion(termhost.VersionInfo{Protocol: termhost.ProtocolVersion}, 0)
	_, _, arr = e.do("GET", "/api/hosts", nil, nil)
	if h := arr[0].(map[string]any); h["version_status"] != "unknown" {
		t.Fatalf("old local host = %v", h)
	}
}
