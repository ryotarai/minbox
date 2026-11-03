package termhost

import (
	"context"
	"crypto/ed25519"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/ryotarai/minbox/internal/hostauth"
	"github.com/ryotarai/minbox/internal/hostfs"
)

// startHost serves a Host on a temp Unix socket and returns its socket path.
func startHost(t *testing.T, h *Host) string {
	t.Helper()
	dir, err := os.MkdirTemp("", "mbx")
	if err != nil {
		t.Fatal(err)
	}
	sock := filepath.Join(dir, "h.sock")
	ln, err := net.Listen("unix", sock)
	if err != nil {
		t.Fatal(err)
	}
	srv := &http.Server{Handler: h.Handler()}
	go srv.Serve(ln)
	t.Cleanup(func() {
		h.KillAll()
		srv.Close()
		os.RemoveAll(dir)
	})
	return sock
}

func TestSpawnAttachInputAndExit(t *testing.T) {
	h := New()
	sock := startHost(t, h)
	c := NewClient(sock, 1)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	events := make(chan Event, 4)
	go c.Events(ctx, func(ev Event) { events <- ev })
	time.Sleep(100 * time.Millisecond)

	_, err := c.Spawn(ctx, SpawnRequest{ID: "t1", Argv: []string{"/bin/sh", "-c", "echo hello; read line; echo got:$line; exit 3"}, Cwd: "/", Env: []string{"PATH=/bin:/usr/bin"}})
	if err != nil {
		t.Fatal(err)
	}
	conn, err := c.Attach(ctx, "t1")
	if err != nil {
		t.Fatal(err)
	}
	defer conn.CloseNow()

	var out strings.Builder
	readUntil := func(want string) {
		for !strings.Contains(out.String(), want) {
			_, data, err := conn.Read(ctx)
			if err != nil {
				t.Fatalf("read waiting for %q: %v (got %q)", want, err, out.String())
			}
			out.Write(data)
		}
	}
	readUntil("hello")
	if err := conn.Write(ctx, websocket.MessageBinary, []byte("abc\r")); err != nil {
		t.Fatal(err)
	}
	readUntil("got:abc")

	select {
	case ev := <-events:
		if ev.Type != "exit" || ev.ID != "t1" || ev.ExitCode != 3 {
			t.Fatalf("event = %+v", ev)
		}
	case <-ctx.Done():
		t.Fatal("no exit event")
	}
	list, _ := c.List(ctx)
	if len(list) != 1 || list[0].Running || list[0].ExitCode != 3 {
		t.Fatalf("list = %+v", list)
	}

	// A second attach replays the scrollback.
	conn2, err := c.Attach(ctx, "t1")
	if err != nil {
		t.Fatal(err)
	}
	defer conn2.CloseNow()
	_, data, err := conn2.Read(ctx)
	if err != nil || !strings.Contains(string(data), "hello") {
		t.Fatalf("replay = %q, %v", data, err)
	}
}

func TestKill(t *testing.T) {
	h := New()
	sock := startHost(t, h)
	c := NewClient(sock, 1)
	ctx := context.Background()
	if _, err := c.Spawn(ctx, SpawnRequest{ID: "k", Argv: []string{"/bin/sleep", "60"}, Cwd: "/"}); err != nil {
		t.Fatal(err)
	}
	if err := c.Kill(ctx, "k"); err != nil {
		t.Fatal(err)
	}
	list, _ := c.List(ctx)
	if len(list) != 1 || list[0].Running {
		t.Fatalf("list = %+v", list)
	}
}

func TestVersionGate(t *testing.T) {
	h := New()
	h.RequiredServer = 5
	sock := startHost(t, h)
	ctx := context.Background()
	old := NewClient(sock, 4)
	if _, err := old.List(ctx); err == nil {
		t.Fatal("an old server must be refused")
	} else if se, ok := err.(*StatusError); !ok || se.Status != http.StatusUpgradeRequired {
		t.Fatalf("err = %v", err)
	}
	v, err := old.Version(ctx)
	if err != nil || v.RequiredServerVersion != 5 {
		t.Fatalf("version = %+v, %v", v, err)
	}
	if _, err := NewClient(sock, 5).List(ctx); err != nil {
		t.Fatal(err)
	}
}

func TestCompatible(t *testing.T) {
	cases := []struct {
		host                  VersionInfo
		server, serverReqHost int
		want                  bool
	}{
		{VersionInfo{Protocol: 1, RequiredServerVersion: 1}, 1, 1, true},
		{VersionInfo{Protocol: 1, RequiredServerVersion: 1}, 2, 2, false}, // host too old for server
		{VersionInfo{Protocol: 2, RequiredServerVersion: 2}, 1, 1, false}, // server too old for host
		{VersionInfo{Protocol: 3, RequiredServerVersion: 1}, 2, 2, true},
	}
	for _, c := range cases {
		if got := Compatible(c.host, c.server, c.serverReqHost); got != c.want {
			t.Errorf("Compatible(%+v, %d, %d) = %v", c.host, c.server, c.serverReqHost, got)
		}
	}
}

func TestEnsureRestartsIncompatibleHost(t *testing.T) {
	old := New()
	old.Protocol = 1
	dir, _ := os.MkdirTemp("", "mbx")
	defer os.RemoveAll(dir)
	sock := filepath.Join(dir, "h.sock")
	ln, err := net.Listen("unix", sock)
	if err != nil {
		t.Fatal(err)
	}
	srv := &http.Server{Handler: old.Handler()}
	old.shutdown = func() { srv.Close() }
	go srv.Serve(ln)
	if _, err := old.Spawn(SpawnRequest{ID: "s", Argv: []string{"/bin/sleep", "60"}, Cwd: "/"}); err != nil {
		t.Fatal(err)
	}

	started := 0
	start := func() error {
		started++
		h := New()
		h.Protocol = 2
		ln, err := net.Listen("unix", sock)
		if err != nil {
			return err
		}
		s := &http.Server{Handler: h.Handler()}
		go s.Serve(ln)
		t.Cleanup(func() { s.Close() })
		return nil
	}
	ctx := context.Background()
	c, restarted, err := Ensure(ctx, sock, EnsureOptions{ServerVersion: 2, ServerRequiresHost: 2, Start: start})
	if err != nil {
		t.Fatal(err)
	}
	if !restarted || started != 1 {
		t.Fatalf("restarted=%v started=%d", restarted, started)
	}
	v, _ := c.Version(ctx)
	if v.Protocol != 2 {
		t.Fatalf("protocol = %d", v.Protocol)
	}
	if old.List()[0].Running {
		t.Fatal("the old host's terminals must have ended")
	}

	// A compatible host is kept.
	_, restarted, err = Ensure(ctx, sock, EnsureOptions{ServerVersion: 2, ServerRequiresHost: 2, Start: start})
	if err != nil || restarted || started != 1 {
		t.Fatalf("restarted=%v started=%d err=%v", restarted, started, err)
	}
}

func TestSizeFrames(t *testing.T) {
	h := New()
	sock := startHost(t, h)
	c := NewClient(sock, 1)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if _, err := c.Spawn(ctx, SpawnRequest{ID: "s1", Argv: []string{"/bin/sh", "-c", "sleep 5"}, Cwd: "/", Env: []string{"PATH=/bin:/usr/bin"}, Cols: 90, Rows: 30}); err != nil {
		t.Fatal(err)
	}
	a, err := c.Attach(ctx, "s1")
	if err != nil {
		t.Fatal(err)
	}
	defer a.CloseNow()
	b, err := c.Attach(ctx, "s1")
	if err != nil {
		t.Fatal(err)
	}
	defer b.CloseNow()
	nextSize := func(conn *websocket.Conn) string {
		for {
			typ, data, err := conn.Read(ctx)
			if err != nil {
				t.Fatal(err)
			}
			if typ == websocket.MessageText {
				return string(data)
			}
		}
	}
	if got := nextSize(a); got != `{"type":"size","cols":90,"rows":30}` {
		t.Fatalf("initial = %s", got)
	}
	_ = nextSize(b)
	if err := a.Write(ctx, websocket.MessageText, []byte(`{"type":"resize","cols":100,"rows":40}`)); err != nil {
		t.Fatal(err)
	}
	if got := nextSize(b); got != `{"type":"size","cols":100,"rows":40}` {
		t.Fatalf("broadcast = %s", got)
	}
}

func TestStopEndsTheHostAndItsTerminals(t *testing.T) {
	h := New()
	dir, _ := os.MkdirTemp("", "mbx")
	defer os.RemoveAll(dir)
	sock := filepath.Join(dir, "h.sock")
	ctx := context.Background()

	// Nothing on the socket: not running, no error.
	if _, running, err := Stop(ctx, sock, 1, nil); running || err != nil {
		t.Fatalf("running=%v err=%v", running, err)
	}

	ln, err := net.Listen("unix", sock)
	if err != nil {
		t.Fatal(err)
	}
	srv := &http.Server{Handler: h.Handler()}
	h.shutdown = func() { srv.Close() }
	go srv.Serve(ln)
	if _, err := h.Spawn(SpawnRequest{ID: "s", Argv: []string{"/bin/sleep", "60"}, Cwd: "/"}); err != nil {
		t.Fatal(err)
	}
	pid, running, err := Stop(ctx, sock, 1, t.Logf)
	if err != nil || !running || pid != os.Getpid() {
		t.Fatalf("pid=%d running=%v err=%v", pid, running, err)
	}
	if h.List()[0].Running {
		t.Fatal("the host's terminals must have ended")
	}
	if _, running, _ := Stop(ctx, sock, 1, nil); running {
		t.Fatal("the host still answers after Stop")
	}
}

func TestRemoteHostAuthAndTailscale(t *testing.T) {
	dir := t.TempDir()
	h := New()
	h.Verifier = &hostauth.Verifier{DataDir: dir}
	h.DataDir = dir
	h.FS = hostfs.NewLocal(dir)
	h.TailscaleLogin = "ryota@github"
	ts := httptest.NewServer(h.Handler())
	defer ts.Close()
	get := func(path, login string, sign *hostauth.Signer) int {
		req, _ := http.NewRequest("GET", ts.URL+path, nil)
		req.Header.Set(HeaderServerVersion, strconv.Itoa(RequiredServerVersion))
		if login != "" {
			req.Header.Set("Tailscale-User-Login", login)
		}
		if sign != nil {
			sign.Sign(req)
		}
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		return resp.StatusCode
	}
	_, key, _ := ed25519.GenerateKey(nil)
	signer := &hostauth.Signer{Key: key}
	// Without the Tailscale user, or with another one: refused, even /version.
	if c := get("/version", "", nil); c != 403 {
		t.Fatalf("no login: %d", c)
	}
	if c := get("/version", "mallory@github", nil); c != 403 {
		t.Fatalf("wrong login: %d", c)
	}
	if c := get("/version", "ryota@github", nil); c != 200 {
		t.Fatalf("right login: %d", c)
	}
	// Signed but not paired: refused.
	if c := get("/terminals", "ryota@github", signer); c != 401 {
		t.Fatalf("unpaired: %d", c)
	}
	// Pair through the open route, accept, then it works.
	client := NewHTTPClient(ts.URL, nil, ProtocolVersion)
	client.http.Transport = loginTransport{"ryota@github"}
	code, err := client.PairRequest(context.Background(), "laptop", hostauth.EncodePublicKey(signer.Public()))
	if err != nil {
		t.Fatal(err)
	}
	if st, _ := client.PairStatus(context.Background(), code); st != "pending" {
		t.Fatalf("status = %s", st)
	}
	if _, err := hostauth.Accept(dir, code, time.Now()); err != nil {
		t.Fatal(err)
	}
	if st, _ := client.PairStatus(context.Background(), code); st != "accepted" {
		t.Fatalf("status = %s", st)
	}
	if c := get("/terminals", "ryota@github", signer); c != 200 {
		t.Fatalf("paired: %d", c)
	}
	if c := get("/terminals", "", signer); c != 403 {
		t.Fatalf("paired, no login: %d", c)
	}
}

type loginTransport struct{ login string }

func (l loginTransport) RoundTrip(r *http.Request) (*http.Response, error) {
	r.Header.Set("Tailscale-User-Login", l.login)
	return http.DefaultTransport.RoundTrip(r)
}

func TestThePTYTakesTheSmallestClientAndGrowsBack(t *testing.T) {
	h := New()
	sock := startHost(t, h)
	c := NewClient(sock, 1)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if _, err := c.Spawn(ctx, SpawnRequest{ID: "s1", Argv: []string{"/bin/sh", "-c", "sleep 5"}, Cwd: "/", Env: []string{"PATH=/bin:/usr/bin"}, Cols: 90, Rows: 30}); err != nil {
		t.Fatal(err)
	}
	desk, err := c.Attach(ctx, "s1")
	if err != nil {
		t.Fatal(err)
	}
	defer desk.CloseNow()
	nextSize := func(conn *websocket.Conn) string {
		for {
			typ, data, err := conn.Read(ctx)
			if err != nil {
				t.Fatal(err)
			}
			if typ == websocket.MessageText {
				return string(data)
			}
		}
	}
	want := func(conn *websocket.Conn, cols, rows int) {
		if err := conn.Write(ctx, websocket.MessageText, []byte(`{"type":"resize","cols":`+strconv.Itoa(cols)+`,"rows":`+strconv.Itoa(rows)+`}`)); err != nil {
			t.Fatal(err)
		}
	}
	_ = nextSize(desk)
	want(desk, 160, 48)
	if got := nextSize(desk); got != `{"type":"size","cols":160,"rows":48}` {
		t.Fatalf("desktop alone = %s", got)
	}

	phone, err := c.Attach(ctx, "s1")
	if err != nil {
		t.Fatal(err)
	}
	_ = nextSize(phone)
	want(phone, 50, 60) // narrower, but taller
	if got := nextSize(desk); got != `{"type":"size","cols":50,"rows":48}` {
		t.Fatalf("with the phone = %s", got)
	}
	_ = nextSize(phone)
	want(desk, 170, 50) // the desktop grows: the phone's width, the desktop's rows
	if got := nextSize(phone); got != `{"type":"size","cols":50,"rows":50}` {
		t.Fatalf("after the desktop grew = %s", got)
	}
	_ = nextSize(desk)

	phone.Close(websocket.StatusNormalClosure, "")
	if got := nextSize(desk); got != `{"type":"size","cols":170,"rows":50}` {
		t.Fatalf("after the phone left = %s", got)
	}
}
