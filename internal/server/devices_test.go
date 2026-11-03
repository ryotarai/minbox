package server

import (
	"bufio"
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/ryotarai/minbox/internal/devices"
)

// remoteHeaders: what tailscale serve adds to a request from the tailnet.
func remoteHeaders(login string) map[string]string {
	h := map[string]string{"X-Forwarded-For": "100.64.0.7", "X-Forwarded-Proto": "https"}
	if login != "" {
		h["Tailscale-User-Login"] = login
	}
	return h
}

func with(h map[string]string, kv ...string) map[string]string {
	out := map[string]string{}
	for k, v := range h {
		out[k] = v
	}
	for i := 0; i+1 < len(kv); i += 2 {
		out[kv[i]] = kv[i+1]
	}
	return out
}

// browserKey is a browser's WebCrypto key: ECDSA P-256, signatures in IEEE P1363.
type browserKey struct {
	priv *ecdsa.PrivateKey
	spki string
	fp   string
}

func newBrowserKey(t *testing.T) *browserKey {
	t.Helper()
	priv, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	der, err := x509.MarshalPKIXPublicKey(&priv.PublicKey)
	if err != nil {
		t.Fatal(err)
	}
	return &browserKey{priv: priv, spki: base64.StdEncoding.EncodeToString(der), fp: devices.Fingerprint(der)}
}

func (k *browserKey) sign(t *testing.T, msg []byte) string {
	t.Helper()
	h := sha256.Sum256(msg)
	r, s, err := ecdsa.Sign(rand.Reader, k.priv, h[:])
	if err != nil {
		t.Fatal(err)
	}
	sig := make([]byte, 64)
	r.FillBytes(sig[:32])
	s.FillBytes(sig[32:])
	return base64.StdEncoding.EncodeToString(sig)
}

// signIn answers a challenge and returns the cookie header value ("" if refused).
func (e *env) signIn(k *browserKey, hdr map[string]string) (int, string) {
	e.t.Helper()
	code, obj, _ := e.do("POST", "/api/devices/auth/challenge", map[string]string{"fingerprint": k.fp}, hdr)
	if code != 200 {
		e.t.Fatalf("challenge: %d %v", code, obj)
	}
	ch := obj["challenge"].(string)
	msg, _ := base64.StdEncoding.DecodeString(ch)
	b, _ := json.Marshal(map[string]string{"fingerprint": k.fp, "challenge": ch, "signature": k.sign(e.t, msg)})
	req, _ := http.NewRequest("POST", e.ts.URL+"/api/devices/auth", strings.NewReader(string(b)))
	for kk, v := range hdr {
		req.Header.Set(kk, v)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		e.t.Fatal(err)
	}
	resp.Body.Close()
	for _, c := range resp.Cookies() {
		if c.Name == deviceCookie {
			if !c.HttpOnly || c.SameSite != http.SameSiteStrictMode || !c.Secure {
				e.t.Fatalf("cookie flags: %+v", c)
			}
			return resp.StatusCode, deviceCookie + "=" + c.Value
		}
	}
	return resp.StatusCode, ""
}

func TestBrowserPairingAndSignIn(t *testing.T) {
	e := newEnv(t)
	remote := remoteHeaders("")

	// An unpaired remote browser: the app and the pairing routes only.
	if code, obj, _ := e.do("GET", "/api/sessions", nil, remote); code != 401 || obj["code"] != "unpaired" {
		t.Fatalf("unpaired API: %d %v", code, obj)
	}
	if code, _, _ := e.do("GET", "/", nil, remote); code != 200 {
		t.Fatalf("the app itself: %d", code)
	}
	if code, obj, _ := e.do("GET", "/api/devices/me", nil, remote); code != 200 || obj["trusted"] != false {
		t.Fatalf("me (unpaired): %d %v", code, obj)
	}
	// The loopback browser stays trusted.
	if code, obj, _ := e.do("GET", "/api/devices/me", nil, nil); code != 200 || obj["via"] != "loopback" {
		t.Fatalf("me (loopback): %d %v", code, obj)
	}

	k := newBrowserKey(t)
	code, obj, _ := e.do("POST", "/api/devices/pair", map[string]string{"public_key": k.spki, "name": "Safari on iPhone"}, remote)
	if code != 201 || obj["fingerprint"] != k.fp {
		t.Fatalf("pair: %d %v", code, obj)
	}
	reqID, pairCode := obj["request_id"].(string), obj["code"].(string)
	if _, obj, _ := e.do("GET", "/api/devices/pair/"+reqID, nil, remote); obj["status"] != "pending" {
		t.Fatalf("status: %v", obj)
	}
	// Not paired yet: no sign-in.
	if c, cookie := e.signIn(k, remote); c != 401 || cookie != "" {
		t.Fatalf("sign-in before accept: %d %q", c, cookie)
	}
	// A remote browser cannot accept itself.
	if code, _, _ := e.do("POST", "/api/devices/requests/"+reqID+"/accept", nil, remote); code != 401 {
		t.Fatalf("self-accept: %d", code)
	}
	// The trusted window sees and accepts it.
	_, list, _ := e.do("GET", "/api/devices", nil, nil)
	reqs := list["requests"].([]any)
	if len(reqs) != 1 || reqs[0].(map[string]any)["code"] != pairCode || reqs[0].(map[string]any)["ip"] != "100.64.0.7" {
		t.Fatalf("requests: %v", list)
	}
	if code, obj, _ := e.do("POST", "/api/devices/requests/"+reqID+"/accept", nil, nil); code != 200 {
		t.Fatalf("accept: %d %v", code, obj)
	}
	if _, obj, _ := e.do("GET", "/api/devices/pair/"+reqID, nil, remote); obj["status"] != "accepted" {
		t.Fatalf("status after accept: %v", obj)
	}

	c, cookie := e.signIn(k, remote)
	if c != 200 || cookie == "" {
		t.Fatalf("sign-in: %d %q", c, cookie)
	}
	auth := with(remote, "Cookie", cookie)
	if code, _, arr := e.do("GET", "/api/sessions", nil, auth); code != 200 || arr == nil {
		t.Fatalf("API with the cookie: %d", code)
	}
	if _, obj, _ := e.do("GET", "/api/devices/me", nil, auth); obj["via"] != "device" || obj["device"].(map[string]any)["name"] != "Safari on iPhone" {
		t.Fatalf("me (device): %v", obj)
	}
	_, list, _ = e.do("GET", "/api/devices", nil, auth)
	devs := list["devices"].([]any)
	if len(devs) != 1 || devs[0].(map[string]any)["current"] != true {
		t.Fatalf("devices: %v", list)
	}
	devID := devs[0].(map[string]any)["id"].(string)

	// A challenge is answered once; a wrong signature fails.
	_, obj, _ = e.do("POST", "/api/devices/auth/challenge", map[string]string{"fingerprint": k.fp}, remote)
	other := newBrowserKey(t)
	msg, _ := base64.StdEncoding.DecodeString(obj["challenge"].(string))
	if code, _, _ := e.do("POST", "/api/devices/auth", map[string]string{"fingerprint": k.fp, "challenge": obj["challenge"].(string), "signature": other.sign(t, msg)}, remote); code != 401 {
		t.Fatalf("wrong key: %d", code)
	}
	if code, _, _ := e.do("POST", "/api/devices/auth", map[string]string{"fingerprint": k.fp, "challenge": obj["challenge"].(string), "signature": k.sign(t, msg)}, remote); code != 401 {
		t.Fatalf("a used challenge: %d", code)
	}

	// SSE and the terminal socket need the cookie too.
	sse := func(h map[string]string) *http.Response {
		req, _ := http.NewRequest("GET", e.ts.URL+"/api/events", nil)
		for kk, v := range h {
			req.Header.Set(kk, v)
		}
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		return resp
	}
	if r := sse(remote); r.StatusCode != 401 {
		t.Fatalf("SSE without cookie: %d", r.StatusCode)
	}
	stream := sse(auth)
	if stream.StatusCode != 200 {
		t.Fatalf("SSE with cookie: %d", stream.StatusCode)
	}
	sess := e.createSession()
	if code, _, _ := e.do("GET", "/api/sessions/"+sess.ID+"/terminal", nil, remote); code != 401 {
		t.Fatalf("terminal without cookie: %d", code)
	}
	if code, _, _ := e.do("GET", "/api/sessions/"+sess.ID+"/terminal", nil, auth); code == 401 || code == 403 {
		t.Fatalf("terminal with cookie refused: %d", code)
	}

	// Revoke: the cookie stops at once, and the open stream ends.
	if code, _, _ := e.do("DELETE", "/api/devices/"+devID, nil, nil); code != 200 {
		t.Fatalf("revoke: %d", code)
	}
	done := make(chan struct{})
	go func() {
		sc := bufio.NewScanner(stream.Body)
		for sc.Scan() {
		}
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("the revoked device's SSE stream stayed open")
	}
	stream.Body.Close()
	if code, _, _ := e.do("GET", "/api/sessions", nil, auth); code != 401 {
		t.Fatalf("API after revoke: %d", code)
	}
	if c, _ := e.signIn(k, remote); c != 401 {
		t.Fatalf("sign-in after revoke: %d", c)
	}
}

func TestBrowserPairingRejectExpireAndLimits(t *testing.T) {
	e := newEnv(t)
	remote := remoteHeaders("")
	k := newBrowserKey(t)
	_, obj, _ := e.do("POST", "/api/devices/pair", map[string]string{"public_key": k.spki, "name": "x"}, remote)
	id := obj["request_id"].(string)
	if code, _, _ := e.do("POST", "/api/devices/requests/"+id+"/reject", nil, nil); code != 200 {
		t.Fatalf("reject: %d", code)
	}
	if _, obj, _ := e.do("GET", "/api/devices/pair/"+id, nil, remote); obj["status"] != "rejected" {
		t.Fatalf("status: %v", obj)
	}
	if code, _, _ := e.do("POST", "/api/devices/requests/"+id+"/accept", nil, nil); code != 409 {
		t.Fatalf("accept after reject: %d", code)
	}

	// Expiry.
	r, err := devices.NewRequest(e.dir, "old", newBrowserKey(t).spki, "1.2.3.4", "", time.Now().Add(-time.Hour), nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, obj, _ := e.do("GET", "/api/devices/pair/"+r.ID, nil, remote); obj["status"] != "expired" {
		t.Fatalf("expired: %v", obj)
	}

	// Not a P-256 key.
	if code, _, _ := e.do("POST", "/api/devices/pair", map[string]string{"public_key": "AAAA", "name": "x"}, remote); code != 400 {
		t.Fatalf("bad key: %d", code)
	}
	// At most 3 waiting per address.
	for i := 0; i < 3; i++ {
		code, _, _ := e.do("POST", "/api/devices/pair", map[string]string{"public_key": newBrowserKey(t).spki, "name": "x"}, remote)
		if i < 3 && code != 201 {
			t.Fatalf("pair %d: %d", i, code)
		}
	}
	if code, _, _ := e.do("POST", "/api/devices/pair", map[string]string{"public_key": newBrowserKey(t).spki, "name": "x"}, remote); code != 429 {
		t.Fatalf("over the limit: %d", code)
	}
}

func TestTailscaleModeGuard(t *testing.T) {
	e := newEnv(t)
	e.srv.cfg.TailscaleLogin = "ryota@github"
	e.srv.cfg.PublicHosts = []string{"mbp.tail1234.ts.net"}

	// The wrong Tailscale user, or none, is refused before anything else.
	if code, _, _ := e.do("GET", "/", nil, remoteHeaders("someone@github")); code != 403 {
		t.Fatalf("wrong login: %d", code)
	}
	if code, _, _ := e.do("GET", "/", nil, remoteHeaders("")); code != 403 {
		t.Fatalf("no login: %d", code)
	}
	// The right user still needs a paired browser.
	if code, _, _ := e.do("GET", "/api/sessions", nil, remoteHeaders("ryota@github")); code != 401 {
		t.Fatalf("right login, unpaired: %d", code)
	}
	// Its MagicDNS name is an accepted Host; another name is not.
	req, _ := http.NewRequest("GET", e.ts.URL+"/api/devices/me", nil)
	req.Host = "mbp.tail1234.ts.net"
	for k, v := range remoteHeaders("ryota@github") {
		req.Header.Set(k, v)
	}
	req.Header.Set("Origin", "https://mbp.tail1234.ts.net")
	if resp, err := http.DefaultClient.Do(req); err != nil || resp.StatusCode != 200 {
		t.Fatalf("MagicDNS host: %v %v", resp, err)
	}
	req.Host = "evil.example"
	req.Header.Del("Origin")
	if resp, err := http.DefaultClient.Do(req); err != nil || resp.StatusCode != 403 {
		t.Fatalf("other host: %v %v", resp, err)
	}
	// Loopback stays trusted.
	if code, _, _ := e.do("GET", "/api/sessions", nil, nil); code != 200 {
		t.Fatalf("loopback: %d", code)
	}
	_ = context.Background()
}

func TestPairListShowsBrowsers(t *testing.T) {
	dir := t.TempDir()
	k := newBrowserKey(t)
	r, err := devices.NewRequest(dir, "Chrome on Pixel", k.spki, "", "", time.Now(), nil)
	if err != nil {
		t.Fatal(err)
	}
	ps, _ := devices.Pending(dir, time.Now())
	out := devices.FormatList(ps)
	want := r.Code + "  browser  Chrome on Pixel  ecdsa-p256 " + k.fp + "\n"
	if out != want {
		t.Fatalf("list:\n%q\nwant\n%q", out, want)
	}
	if _, d, err := devices.Accept(dir, strings.ReplaceAll(r.Code, "-", ""), time.Now()); err != nil || d.Fingerprint != k.fp {
		t.Fatalf("accept by code without the dash: %v %v", d, err)
	}
	if ps, _ := devices.Pending(dir, time.Now()); len(ps) != 0 {
		t.Fatalf("still pending: %v", ps)
	}
}

// With --listen 0.0.0.0 a client elsewhere may send any Host, even a loopback
// one: only the connection's own address makes it local.
func TestListenAnyNeedsPairingFromElsewhere(t *testing.T) {
	e := newEnv(t)
	e.srv.cfg.ListenAny = true
	get := func(path, host, remoteAddr string) int {
		req := httptest.NewRequest("GET", path, nil)
		req.Host = host
		req.RemoteAddr = remoteAddr
		rec := httptest.NewRecorder()
		e.srv.ServeHTTP(rec, req)
		return rec.Code
	}
	if code := get("/api/sessions", "127.0.0.1:4848", "192.0.2.7:51000"); code != 401 {
		t.Fatalf("spoofed loopback Host from elsewhere: %d, want 401", code)
	}
	if code := get("/api/sessions", "192.168.1.5:4848", "192.0.2.7:51000"); code != 401 {
		t.Fatalf("LAN address: %d, want 401", code)
	}
	if code := get("/api/devices/me", "192.168.1.5:4848", "192.0.2.7:51000"); code != 200 {
		t.Fatalf("pairing routes stay open: %d", code)
	}
	if code := get("/api/sessions", "127.0.0.1:4848", "127.0.0.1:51000"); code != 200 {
		t.Fatalf("this machine: %d, want 200", code)
	}
	// Without --listen any other Host is refused outright.
	e.srv.cfg.ListenAny = false
	if code := get("/api/devices/me", "192.168.1.5:4848", "192.0.2.7:51000"); code != 403 {
		t.Fatalf("other Host without --listen: %d, want 403", code)
	}
}

func TestSameHostToleratesAPortlessProxyHost(t *testing.T) {
	cases := []struct {
		origin, req string
		want        bool
	}{
		{"mbp.ts.net:8443", "mbp.ts.net:8443", true},
		{"mbp.ts.net:8443", "mbp.ts.net", true}, // the proxy dropped the port
		{"mbp.ts.net", "mbp.ts.net", true},
		{"evil.example:8443", "mbp.ts.net", false},
		{"mbp.ts.net:8443", "mbp.ts.net:9000", false},
	}
	for _, c := range cases {
		if got := sameHost(c.origin, c.req); got != c.want {
			t.Errorf("sameHost(%q, %q) = %v, want %v", c.origin, c.req, got, c.want)
		}
	}
}
