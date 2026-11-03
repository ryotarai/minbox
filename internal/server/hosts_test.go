package server

import (
	"context"
	"crypto/ed25519"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/ryotarai/minbox/internal/hostauth"
	"github.com/ryotarai/minbox/internal/hostfs"
	"github.com/ryotarai/minbox/internal/store"
	"github.com/ryotarai/minbox/internal/termhost"
)

// remoteHost runs `minbox host --listen` in process (at addr, data dir dir);
// it answers its URL, its data dir and a stop function.
func remoteHost(t *testing.T, addr0, dir string) (string, string, func()) {
	t.Helper()
	if dir == "" {
		dir = t.TempDir()
	}
	if addr0 == "" {
		addr0 = "127.0.0.1:0"
	}
	ctx, cancel := context.WithCancel(context.Background())
	addr := make(chan string, 1)
	done := make(chan struct{})
	go func() {
		defer close(done)
		err := termhost.ServeRemote(ctx, termhost.RemoteOptions{
			Addr: addr0, DataDir: dir,
			PluginDir: "/plugin-remote", ServerFile: filepath.Join(dir, "host-server.json"), Version: "test",
			Listening: func(a string) { addr <- a },
		})
		if err != nil {
			t.Log(err)
		}
	}()
	u := "http://" + <-addr
	var once sync.Once
	stop := func() {
		once.Do(func() {
			cancel()
			<-done
		})
	}
	t.Cleanup(stop)
	return u, dir, stop
}

func waitFor(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", what)
		}
		time.Sleep(50 * time.Millisecond)
	}
}

func (e *env) hostStatus(id string) map[string]any {
	_, _, arr := e.do("GET", "/api/hosts", nil, nil)
	for _, x := range arr {
		h := x.(map[string]any)
		if h["id"] == id {
			return h
		}
	}
	return nil
}

// pairHost adds the host at hostURL and accepts the pairing on its machine
// (the function `minbox pair accept` runs); it answers the host's id.
func pairHost(t *testing.T, e *env, hostURL, hostDir string) string {
	t.Helper()
	code, res, _ := e.do("POST", "/api/hosts", map[string]string{"name": "devbox", "url": hostURL, "method": "direct"}, nil)
	if code != 201 {
		t.Fatalf("add: %d %v", code, res)
	}
	h := res["host"].(map[string]any)
	pcode := res["code"].(string)
	hostID := h["id"].(string)
	t.Cleanup(func() {
		if c := e.srv.sessions.hosts.get(hostID); c != nil && c.cancel != nil {
			c.cancel()
		}
	})
	if h["status"] != "pairing" || h["paired"] != false || h["pairing_code"] != pcode || h["method"] != "direct" || !strings.HasPrefix(h["fingerprint"].(string), "SHA256:") {
		t.Fatalf("host while pairing = %v", h)
	}
	// On that machine: the request is listed, then accepted.
	ps, err := hostauth.ListPairings(hostDir, time.Now())
	if err != nil || len(ps) != 1 || ps[0].Code != pcode || ps[0].Fingerprint != e.srv.signer.Fingerprint() {
		t.Fatalf("pair list = %v %v", ps, err)
	}
	want := pcode + "  " + e.srv.serverName + "  ed25519 " + e.srv.signer.Fingerprint() + "\n"
	if got := hostauth.FormatList(ps); got != want {
		t.Fatalf("pair list output = %q, want %q", got, want)
	}
	if _, err := hostauth.Accept(hostDir, pcode, time.Now()); err != nil {
		t.Fatal(err)
	}
	waitFor(t, "online", func() bool { return e.hostStatus(hostID)["status"] == "online" })
	if hs := e.hostStatus(hostID); hs["paired"] != true || hs["pairing_code"] != nil {
		t.Fatalf("host after accept = %v", hs)
	}
	return hostID
}

func TestRemoteHost(t *testing.T) {
	e := newEnv(t)
	e.srv.pairPoll = 50 * time.Millisecond
	hostURL, hostDir, stopHost := remoteHost(t, "", "")

	// The built-in host is listed.
	_, _, arr := e.do("GET", "/api/hosts", nil, nil)
	if len(arr) != 1 || arr[0].(map[string]any)["builtin"] != true || arr[0].(map[string]any)["method"] != "builtin" {
		t.Fatalf("hosts = %v", arr)
	}

	// Probing reads the open /version.
	_, probe, _ := e.do("POST", "/api/hosts/probe", map[string]string{"url": hostURL}, nil)
	if probe["ok"] != true || probe["version"] != "test" || probe["tailscale"] != false || probe["hostname"] == "" {
		t.Fatalf("probe = %v", probe)
	}
	// Not paired yet: the host refuses this server.
	if _, _, _, err := connectRemote(context.Background(), hostURL, e.srv.signer); err == nil || !strings.Contains(err.Error(), "pair it again") {
		t.Fatalf("unpaired connect err = %v", err)
	}

	hostID := pairHost(t, e, hostURL, hostDir)

	// Folders on that machine.
	work := t.TempDir()
	os.MkdirAll(filepath.Join(work, "proj"), 0o755)
	_, dirs, _ := e.do("GET", "/api/fs/dirs?path="+url.QueryEscape(work)+"&host_id="+hostID, nil, nil)
	if ents, _ := dirs["entries"].([]any); len(ents) != 2 || ents[1].(map[string]any)["name"] != "proj" {
		t.Fatalf("dirs = %v", dirs)
	}

	// A session there: the host fills in its mod folder and its server file (the relay).
	e.srv.sessions.cfg.ClaudeCommand = []string{"/bin/sh", "-c", `echo "plugin=$2 file=$MINBOX_SERVER_FILE"; sleep 30`, "sh"}
	code, sessJSON, _ := e.do("POST", "/api/sessions", map[string]string{"cwd": work, "name": "remote", "host_id": hostID}, nil)
	if code != 201 || sessJSON["host_id"] != hostID || sessJSON["host_name"] != "devbox" {
		t.Fatalf("create: %d %v", code, sessJSON)
	}
	sessID := sessJSON["id"].(string)
	sess, _ := e.st.GetSession(context.Background(), sessID)

	// The terminal, through the server.
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	ws, _, err := websocket.Dial(ctx, strings.Replace(e.ts.URL, "http", "ws", 1)+"/api/sessions/"+sessID+"/terminal", nil)
	if err != nil {
		t.Fatal(err)
	}
	var out strings.Builder
	for !strings.Contains(out.String(), "file=") || !strings.Contains(out.String(), ".json") {
		typ, data, err := ws.Read(ctx)
		if err != nil {
			t.Fatalf("terminal: %v (got %q)", err, out.String())
		}
		if typ == websocket.MessageBinary {
			out.Write(data)
		}
	}
	ws.CloseNow()
	if !strings.Contains(out.String(), "plugin=/plugin-remote") || !strings.Contains(out.String(), filepath.Join(hostDir, "host-server.json")) {
		t.Fatalf("terminal said %q", out.String())
	}

	// The mod on that machine reaches the server through the relay.
	var sf struct{ URL string }
	b, _ := os.ReadFile(filepath.Join(hostDir, "host-server.json"))
	_ = json.Unmarshal(b, &sf)
	relay := func(method, path string, body string) (int, map[string]any, []any) {
		req, _ := http.NewRequest(method, sf.URL+path, strings.NewReader(body))
		req.Header.Set("Authorization", "Bearer "+sess.Token)
		req.Header.Set("Content-Type", "application/json")
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		raw, _ := io.ReadAll(resp.Body)
		var obj map[string]any
		var arr []any
		if json.Unmarshal(raw, &obj) != nil {
			_ = json.Unmarshal(raw, &arr)
		}
		return resp.StatusCode, obj, arr
	}
	if code, _, _ := relay("POST", "/api/agent/hello", `{"claude_session_id":"x"}`); code != 200 {
		t.Fatalf("hello through the relay: %d", code)
	}
	if s, _ := e.st.GetSession(context.Background(), sessID); s.Status != store.StatusIdle {
		t.Fatalf("status after hello = %s", s.Status)
	}

	// An attachment read on that machine.
	file := filepath.Join(work, "plan.md")
	os.WriteFile(file, []byte("# Plan\n"), 0o644)
	code, sent, _ := relay("POST", "/api/agent/messages", `{"subject":"Plan","body":"see","attachments":["plan.md"]}`)
	if code != 201 {
		t.Fatalf("send: %d %v", code, sent)
	}
	attID := sent["attachments"].([]any)[0].(map[string]any)["id"].(string)
	_, att, _ := e.do("GET", "/api/attachments/"+attID, nil, nil)
	if att["text_sent"] != "# Plan\n" || att["changed"] != false || att["exists"] != true {
		t.Fatalf("attachment = %v", att)
	}
	os.WriteFile(file, []byte("# Plan v2\n"), 0o644)
	_, att, _ = e.do("GET", "/api/attachments/"+attID, nil, nil)
	if att["changed"] != true || att["text_current"] != "# Plan v2\n" {
		t.Fatalf("changed attachment = %v", att)
	}

	// A long poll through the relay wakes on the person's message.
	got := make(chan []any, 1)
	go func() {
		_, _, arr := relay("GET", "/api/agent/pending?owner=o&wait=10", "")
		got <- arr
	}()
	time.Sleep(200 * time.Millisecond)
	if code, _, _ := e.do("POST", "/api/sessions/"+sessID+"/threads", map[string]string{"subject": "Hi", "body": "hello there"}, nil); code != 201 {
		t.Fatalf("person's message: %d", code)
	}
	var pending []any
	select {
	case pending = <-got:
	case <-time.After(8 * time.Second):
		t.Fatal("the long poll did not wake")
	}
	if len(pending) != 1 {
		t.Fatalf("pending = %v", pending)
	}
	mid := pending[0].(map[string]any)["id"].(string)
	if code, _, _ := relay("POST", "/api/agent/pending/"+mid+"/delivered?owner=o", ""); code != 200 {
		t.Fatalf("delivered: %d", code)
	}

	// The host goes away: offline. It comes back: online again.
	addr := strings.TrimPrefix(hostURL, "http://")
	stopHost()
	waitFor(t, "offline", func() bool { return e.hostStatus(hostID)["status"] == "offline" })
	_, _, stopHost = remoteHost(t, addr, hostDir)
	e.do("POST", "/api/hosts/"+hostID+"/retry", nil, nil)
	waitFor(t, "online again", func() bool { return e.hostStatus(hostID)["status"] == "online" })

	// Removing the host ends its sessions (they stay) and the host forgets
	// this server's key: it refuses it from then on.
	if code, _, _ := e.do("DELETE", "/api/hosts/"+hostID, nil, nil); code != 200 {
		t.Fatalf("remove: %d", code)
	}
	s, err := e.st.GetSession(context.Background(), sessID)
	if err != nil || s.Status != store.StatusEnded {
		t.Fatalf("session after removing its host: %v %v", s, err)
	}
	_, _, arr = e.do("GET", "/api/hosts", nil, nil)
	if len(arr) != 1 {
		t.Fatalf("hosts after remove = %v", arr)
	}
	if list, _ := hostauth.ReadAuthorized(hostDir); len(list) != 0 {
		t.Fatalf("the host still knows the server: %v", list)
	}
	if _, _, _, err := connectRemote(context.Background(), hostURL, e.srv.signer); err == nil {
		t.Fatal("the host still accepts the removed server")
	}
	stopHost()
}

func TestRepairAndReject(t *testing.T) {
	e := newEnv(t)
	e.srv.pairPoll = 50 * time.Millisecond
	hostURL, hostDir, _ := remoteHost(t, "", "")
	code, res, _ := e.do("POST", "/api/hosts", map[string]string{"name": "box", "url": hostURL}, nil)
	if code != 201 {
		t.Fatalf("add: %d %v", code, res)
	}
	hostID := res["host"].(map[string]any)["id"].(string)
	t.Cleanup(func() {
		if c := e.srv.sessions.hosts.get(hostID); c != nil && c.cancel != nil {
			c.cancel()
		}
	})
	if _, err := hostauth.Reject(hostDir, res["code"].(string), time.Now()); err != nil {
		t.Fatal(err)
	}
	waitFor(t, "rejected", func() bool {
		h := e.hostStatus(hostID)
		return h["status"] == "offline" && strings.Contains(h["error"].(string), "rejected")
	})
	// Pair again: a new code, accepted this time.
	_, rp, _ := e.do("POST", "/api/hosts/"+hostID+"/repair", nil, nil)
	code2, _ := rp["code"].(string)
	if code2 == "" || code2 == res["code"] {
		t.Fatalf("repair = %v", rp)
	}
	if e.hostStatus(hostID)["status"] != "pairing" {
		t.Fatalf("after repair = %v", e.hostStatus(hostID))
	}
	if _, err := hostauth.Accept(hostDir, code2, time.Now()); err != nil {
		t.Fatal(err)
	}
	waitFor(t, "online", func() bool { return e.hostStatus(hostID)["status"] == "online" })
}

func TestTailscaleInfo(t *testing.T) {
	e := newEnv(t)
	// No tailscale CLI: not available, no peers.
	e.srv.tailscaleStatus = func(context.Context) ([]byte, error) { return nil, nil }
	_, info, _ := e.do("GET", "/api/hosts/tailscale", nil, nil)
	if info["available"] != false || len(info["peers"].([]any)) != 0 {
		t.Fatalf("without tailscale = %v", info)
	}
	// A tailnet with three machines; one runs a minbox host.
	hostURL, _, _ := remoteHost(t, "", "")
	e.srv.peerURL = func(dns string) string {
		if dns == "devbox.tail3f2a.ts.net" {
			return hostURL
		}
		return "http://127.0.0.1:1" // nothing there
	}
	e.srv.tailscaleStatus = func(context.Context) ([]byte, error) {
		return []byte(`{"Self":{"UserID":7,"DNSName":"ryota-mbp.tail3f2a.ts.net."},"MagicDNSSuffix":"tail3f2a.ts.net",
		  "User":{"7":{"LoginName":"ryota@github"}},
		  "Peer":{"a":{"HostName":"zeta","DNSName":"zeta.tail3f2a.ts.net.","OS":"linux","Online":true},
		          "b":{"HostName":"alpha","DNSName":"alpha.tail3f2a.ts.net.","OS":"windows","Online":false},
		          "c":{"HostName":"devbox","DNSName":"devbox.tail3f2a.ts.net.","OS":"linux","Online":true}}}`), nil
	}
	_, info, _ = e.do("GET", "/api/hosts/tailscale", nil, nil)
	if info["available"] != true || info["login"] != "ryota@github" || info["suffix"] != "tail3f2a.ts.net" {
		t.Fatalf("info = %v", info)
	}
	var names []string
	for _, p := range info["peers"].([]any) {
		names = append(names, p.(map[string]any)["name"].(string))
	}
	if strings.Join(names, ",") != "devbox,zeta,alpha" {
		t.Fatalf("peer order = %v (%v)", names, info["peers"])
	}
	first := info["peers"].([]any)[0].(map[string]any)
	if first["has_host"] != true || first["dns_name"] != "devbox.tail3f2a.ts.net" || first["online"] != true || first["added"] != false || first["os"] != "linux" {
		t.Fatalf("devbox = %v", first)
	}
	// A host using that name is "added".
	if _, err := e.st.CreateHost(context.Background(), "devbox", "https://devbox.tail3f2a.ts.net", store.MethodTailscale, "ryota@github", ""); err != nil {
		t.Fatal(err)
	}
	_, info, _ = e.do("GET", "/api/hosts/tailscale", nil, nil)
	if info["peers"].([]any)[0].(map[string]any)["added"] != true {
		t.Fatalf("added = %v", info["peers"])
	}
}

func TestRemoteHostTooOld(t *testing.T) {
	h := termhost.New()
	h.Protocol = 2 // a token host, older than pairing
	dir := t.TempDir()
	h.Verifier = &hostauth.Verifier{DataDir: dir}
	h.DataDir = dir
	h.FS = hostfs.NewLocal(dir)
	ts := httptest.NewServer(h.Handler())
	defer ts.Close()
	signer := &hostauth.Signer{Key: testKey()}
	_, _, _, err := connectRemote(context.Background(), ts.URL, signer)
	if err == nil || !strings.Contains(err.Error(), "too old") {
		t.Fatalf("err = %v", err)
	}
	// A local (socket) host is not a remote one.
	l := termhost.New()
	ts2 := httptest.NewServer(l.Handler())
	defer ts2.Close()
	if _, _, _, err := connectRemote(context.Background(), ts2.URL, signer); err == nil || !strings.Contains(err.Error(), "minbox host --listen") {
		t.Fatalf("local host err = %v", err)
	}
}

func testKey() ed25519.PrivateKey {
	_, k, _ := ed25519.GenerateKey(nil)
	return k
}

func TestTailnetHostURLUsesTheHostPort(t *testing.T) {
	for in, want := range map[string]string{
		"devbox.tail3f2a.ts.net":         "https://devbox.tail3f2a.ts.net:14849",
		"devbox.tail3f2a.ts.net.":        "https://devbox.tail3f2a.ts.net:14849",
		"devbox.tail3f2a.ts.net:9443":    "https://devbox.tail3f2a.ts.net:9443",
		"https://devbox.tail3f2a.ts.net": "https://devbox.tail3f2a.ts.net",
	} {
		if got := hostURL(in, store.MethodTailscale); got != want {
			t.Errorf("hostURL(%q) = %q, want %q", in, got, want)
		}
	}
}
