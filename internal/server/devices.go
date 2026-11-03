package server

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"net"
	"net/http"
	"net/url"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/ryotarai/minbox/internal/devices"
	"github.com/ryotarai/minbox/internal/hostauth"
)

// Browsers on other machines (through `minbox start --tailscale`, or any
// proxy) must be paired devices; a browser straight on this machine's
// loopback address is trusted as before.

const (
	deviceCookie     = "minbox_device"
	deviceSessionTTL = 12 * time.Hour
	challengeTTL     = 60 * time.Second
	maxPendingPerIP  = 3
	maxPending       = 10
)

type deviceSession struct {
	deviceID string
	expires  time.Time
}

type challenge struct {
	fingerprint string
	expires     time.Time
}

// deviceAuth holds the server's device sessions (cookies) and challenges in
// memory: after a restart a paired browser signs a new challenge by itself.
type deviceAuth struct {
	mu         sync.Mutex
	sessions   map[string]deviceSession // cookie value → device
	challenges map[string]challenge     // base64 challenge → who may answer it
	live       map[string]map[*liveReq]struct{}

	// devices.json, re-read when the CLI changes it.
	cacheMod  time.Time
	cacheSize int64
	cache     map[string]devices.Device // by id
	reqMod    time.Time
}

type liveReq struct{ cancel context.CancelFunc }

func newDeviceAuth() *deviceAuth {
	return &deviceAuth{sessions: map[string]deviceSession{}, challenges: map[string]challenge{}, live: map[string]map[*liveReq]struct{}{}}
}

type ctxKey int

const deviceKey ctxKey = 1

// trust is how a request is trusted.
type trust struct {
	via    string // "loopback" | "device" | ""
	device *devices.Device
}

func trustOf(r *http.Request) trust {
	if t, ok := r.Context().Value(deviceKey).(trust); ok {
		return t
	}
	return trust{}
}

// remote reports whether the request came through a proxy (tailscale serve
// adds Tailscale-User-Login and X-Forwarded-For) or names a host other than a
// loopback address. Only a request straight to loopback is trusted as local.
// The connection itself must come from loopback too: with --listen 0.0.0.0 a
// client elsewhere could send "Host: 127.0.0.1".
func remote(r *http.Request) bool {
	return r.Header.Get("Tailscale-User-Login") != "" || r.Header.Get("X-Forwarded-For") != "" ||
		r.Header.Get("Forwarded") != "" || !loopbackHost(r.Host) || !loopbackAddr(r.RemoteAddr)
}

// loopbackAddr: the peer of the connection is a loopback address.
func loopbackAddr(remoteAddr string) bool {
	if remoteAddr == "" || remoteAddr == "@" {
		return true // not a TCP connection (tests driving the handler directly)
	}
	host, _, err := net.SplitHostPort(remoteAddr)
	if err != nil {
		host = remoteAddr
	}
	ip := net.ParseIP(strings.Trim(host, "[]"))
	return ip != nil && ip.IsLoopback()
}

// allowedHost: loopback, or (in Tailscale mode) the server's own MagicDNS name.
func (s *Server) allowedHost(hostport string) bool {
	if loopbackHost(hostport) || s.cfg.ListenAny {
		// Listening beyond loopback: any name may reach it. Such requests are
		// remote, so they need a paired browser's cookie (host-only,
		// SameSite=Strict): a page on another name never carries it.
		return true
	}
	host, _, err := net.SplitHostPort(hostport)
	if err != nil {
		host = hostport
	}
	host = strings.ToLower(strings.TrimSuffix(host, "."))
	for _, h := range s.cfg.PublicHosts {
		if strings.ToLower(strings.TrimSuffix(h, ".")) == host {
			return true
		}
	}
	return false
}

// openRoute: what an unpaired remote browser may reach: the app itself and
// the pairing and sign-in routes.
func openRoute(r *http.Request) bool {
	p := r.URL.Path
	if !strings.HasPrefix(p, "/api/") {
		return r.Method == http.MethodGet || r.Method == http.MethodHead
	}
	switch {
	case p == "/api/devices/pair" && r.Method == http.MethodPost,
		strings.HasPrefix(p, "/api/devices/pair/") && r.Method == http.MethodGet,
		p == "/api/devices/auth/challenge" && r.Method == http.MethodPost,
		p == "/api/devices/auth" && r.Method == http.MethodPost,
		p == "/api/devices/me" && r.Method == http.MethodGet:
		return true
	}
	return false
}

// device answers the paired device behind the request's cookie, or nil.
func (s *Server) deviceOf(r *http.Request) *devices.Device {
	c, err := r.Cookie(deviceCookie)
	if err != nil || c.Value == "" {
		return nil
	}
	a := s.devAuth
	a.mu.Lock()
	ds, ok := a.sessions[c.Value]
	if ok && time.Now().After(ds.expires) {
		delete(a.sessions, c.Value)
		ok = false
	}
	a.mu.Unlock()
	if !ok {
		return nil
	}
	d, found := s.lookupDevice(ds.deviceID)
	if !found {
		s.dropDevice(ds.deviceID) // revoked from the CLI
		return nil
	}
	return &d
}

// lookupDevice reads devices.json when it changed.
func (s *Server) lookupDevice(id string) (devices.Device, bool) {
	a := s.devAuth
	a.mu.Lock()
	defer a.mu.Unlock()
	fi, err := os.Stat(devices.File(s.cfg.DataDir))
	var mod time.Time
	var size int64
	if err == nil {
		mod, size = fi.ModTime(), fi.Size()
	}
	if a.cache == nil || !mod.Equal(a.cacheMod) || size != a.cacheSize {
		list, err := devices.List(s.cfg.DataDir)
		if err != nil {
			return devices.Device{}, false
		}
		a.cache = map[string]devices.Device{}
		for _, d := range list {
			a.cache[d.ID] = d
		}
		a.cacheMod, a.cacheSize = mod, size
	}
	d, ok := a.cache[id]
	return d, ok
}

// track lets a revoke end the device's open streams (SSE, terminal).
func (s *Server) track(r *http.Request, deviceID string) (*http.Request, func()) {
	ctx, cancel := context.WithCancel(r.Context())
	lr := &liveReq{cancel: cancel}
	a := s.devAuth
	a.mu.Lock()
	if a.live[deviceID] == nil {
		a.live[deviceID] = map[*liveReq]struct{}{}
	}
	a.live[deviceID][lr] = struct{}{}
	a.mu.Unlock()
	return r.WithContext(ctx), func() {
		cancel()
		a.mu.Lock()
		delete(a.live[deviceID], lr)
		a.mu.Unlock()
	}
}

// dropDevice ends a device's cookies and open streams at once.
func (s *Server) dropDevice(id string) {
	a := s.devAuth
	a.mu.Lock()
	for k, ds := range a.sessions {
		if ds.deviceID == id {
			delete(a.sessions, k)
		}
	}
	for lr := range a.live[id] {
		lr.cancel()
	}
	delete(a.live, id)
	a.cache = nil
	a.mu.Unlock()
}

// guard checks every request: the Host, the Tailscale user, the device of a
// remote browser, and that it is not a cross-site request.
func (s *Server) guard(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !s.allowedHost(r.Host) {
			httpError(w, http.StatusForbidden, "forbidden host")
			return
		}
		isRemote := remote(r)
		if isRemote && s.cfg.TailscaleLogin != "" && r.Header.Get("Tailscale-User-Login") != s.cfg.TailscaleLogin {
			httpError(w, http.StatusForbidden, "this minbox answers only its Tailscale user")
			return
		}
		// What a sandboxed frame (an opaque origin, which sends no cookie)
		// loads: an attached HTML page's own files and ```html embeds.
		// Read-only, by unguessable token or by the hash of content the
		// caller already has.
		if (r.Method == http.MethodGet || r.Method == http.MethodHead) &&
			(strings.HasPrefix(r.URL.Path, "/api/html-assets/") || strings.HasPrefix(r.URL.Path, "/api/embeds/")) {
			if o := r.Header.Get("Origin"); o == "" || o == "null" {
				next.ServeHTTP(w, r)
				return
			}
		}
		if origin := r.Header.Get("Origin"); origin != "" {
			u, err := url.Parse(origin)
			if err != nil || !sameHost(u.Host, requestHost(r)) {
				httpError(w, http.StatusForbidden, "cross-origin request refused")
				return
			}
		}
		if site := r.Header.Get("Sec-Fetch-Site"); site == "cross-site" {
			httpError(w, http.StatusForbidden, "cross-site request refused")
			return
		}
		t := trust{}
		if !isRemote {
			t.via = "loopback"
		} else if d := s.deviceOf(r); d != nil {
			t = trust{via: "device", device: d}
		}
		// The mod's API has its own bearer token.
		if t.via == "" && !openRoute(r) && !strings.HasPrefix(r.URL.Path, "/api/agent/") {
			w.Header().Set("Cache-Control", "no-store")
			writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "this browser is not paired with this minbox", "code": "unpaired"})
			return
		}
		r = r.WithContext(context.WithValue(r.Context(), deviceKey, t))
		if t.device != nil {
			var done func()
			r, done = s.track(r, t.device.ID)
			defer done()
		}
		next.ServeHTTP(w, r)
	})
}

// requestHost is the host the browser used (tailscale serve passes it on).
// sameHost compares an Origin's host with the request's. A proxy (tailscale
// serve on a port other than 443) may pass the Host without its port: then the
// names alone are compared, as cookies are (they never look at ports).
func sameHost(origin, req string) bool {
	if strings.EqualFold(origin, req) {
		return true
	}
	oh, _, oerr := net.SplitHostPort(origin)
	if _, _, rerr := net.SplitHostPort(req); oerr == nil && rerr != nil {
		return strings.EqualFold(oh, req)
	}
	return false
}

func requestHost(r *http.Request) string {
	if h := r.Header.Get("X-Forwarded-Host"); h != "" {
		return h
	}
	return r.Host
}

func clientIP(r *http.Request) string {
	if f := r.Header.Get("X-Forwarded-For"); f != "" {
		return strings.TrimSpace(strings.Split(f, ",")[0])
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}

func randomToken(n int) string {
	b := make([]byte, n)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

// ---- routes ----

type pairRequestJSON struct {
	ID             string    `json:"id"`
	Code           string    `json:"code"`
	Name           string    `json:"name"`
	Fingerprint    string    `json:"fingerprint"`
	CreatedAt      time.Time `json:"created_at"`
	IP             string    `json:"ip,omitempty"`
	TailscaleLogin string    `json:"tailscale_login,omitempty"`
}

type deviceJSON struct {
	ID          string    `json:"id"`
	Name        string    `json:"name"`
	Fingerprint string    `json:"fingerprint"`
	CreatedAt   time.Time `json:"created_at"`
	LastSeen    time.Time `json:"last_seen"`
	Current     bool      `json:"current"`
}

func toDeviceJSON(d devices.Device, current string) deviceJSON {
	return deviceJSON{ID: d.ID, Name: d.Name, Fingerprint: d.Fingerprint, CreatedAt: d.CreatedAt, LastSeen: d.LastSeen, Current: d.ID == current}
}

func (s *Server) publishDevices() { s.hub.publish(Event{Type: "devices"}) }

func (s *Server) devicePair(w http.ResponseWriter, r *http.Request) {
	var req struct {
		PublicKey string `json:"public_key"`
		Name      string `json:"name"`
	}
	if !decode(w, r, &req) {
		return
	}
	now := time.Now()
	ip := clientIP(r)
	pending, err := devices.Pending(s.cfg.DataDir, now)
	if err != nil {
		storeError(w, err)
		return
	}
	mine := 0
	for _, p := range pending {
		if p.IP == ip {
			mine++
		}
	}
	if len(pending) >= maxPending || mine >= maxPendingPerIP {
		httpError(w, http.StatusTooManyRequests, "too many browsers are waiting to be paired; accept or reject them first, or wait 10 minutes")
		return
	}
	pr, err := devices.NewRequest(s.cfg.DataDir, req.Name, req.PublicKey, ip, r.Header.Get("Tailscale-User-Login"), now,
		func(code string) bool { return hostauth.PairingExists(s.cfg.DataDir, code) })
	if err != nil {
		httpError(w, 400, err.Error())
		return
	}
	s.publishDevices()
	writeJSON(w, 201, map[string]string{"request_id": pr.ID, "code": pr.Code, "fingerprint": pr.Fingerprint})
}

func (s *Server) devicePairStatus(w http.ResponseWriter, r *http.Request) {
	pr, err := devices.GetByID(s.cfg.DataDir, r.PathValue("id"), time.Now())
	if err != nil {
		httpError(w, 404, err.Error())
		return
	}
	writeJSON(w, 200, map[string]string{"status": pr.Effective(time.Now())})
}

func (s *Server) deviceChallenge(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Fingerprint string `json:"fingerprint"`
	}
	if !decode(w, r, &req) {
		return
	}
	b := make([]byte, 32)
	_, _ = rand.Read(b)
	c := base64.StdEncoding.EncodeToString(b)
	a := s.devAuth
	a.mu.Lock()
	now := time.Now()
	for k, v := range a.challenges { // sweep
		if now.After(v.expires) {
			delete(a.challenges, k)
		}
	}
	if len(a.challenges) > 1000 {
		a.mu.Unlock()
		httpError(w, http.StatusTooManyRequests, "too many sign-ins at once")
		return
	}
	a.challenges[c] = challenge{fingerprint: strings.TrimSpace(req.Fingerprint), expires: now.Add(challengeTTL)}
	a.mu.Unlock()
	writeJSON(w, 200, map[string]string{"challenge": c})
}

func (s *Server) deviceSignIn(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Fingerprint string `json:"fingerprint"`
		Challenge   string `json:"challenge"`
		Signature   string `json:"signature"`
	}
	if !decode(w, r, &req) {
		return
	}
	fail := func() { httpError(w, http.StatusUnauthorized, "this browser is not paired with this minbox") }
	a := s.devAuth
	a.mu.Lock()
	ch, ok := a.challenges[req.Challenge]
	delete(a.challenges, req.Challenge) // one answer per challenge
	a.mu.Unlock()
	if !ok || time.Now().After(ch.expires) || ch.fingerprint != req.Fingerprint {
		fail()
		return
	}
	list, err := devices.List(s.cfg.DataDir)
	if err != nil {
		storeError(w, err)
		return
	}
	var dev *devices.Device
	for i := range list {
		if list[i].Fingerprint == req.Fingerprint {
			dev = &list[i]
		}
	}
	if dev == nil {
		fail()
		return
	}
	pub, _, err := devices.ParsePublicKey(dev.PublicKey)
	if err != nil {
		fail()
		return
	}
	msg, err1 := base64.StdEncoding.DecodeString(req.Challenge)
	sig, err2 := base64.StdEncoding.DecodeString(req.Signature)
	if err1 != nil || err2 != nil || !devices.Verify(pub, msg, sig) {
		fail()
		return
	}
	token := randomToken(32)
	exp := time.Now().Add(deviceSessionTTL)
	a.mu.Lock()
	a.sessions[token] = deviceSession{deviceID: dev.ID, expires: exp}
	a.mu.Unlock()
	_ = devices.Touch(s.cfg.DataDir, dev.ID, time.Now())
	http.SetCookie(w, &http.Cookie{
		Name: deviceCookie, Value: token, Path: "/", Expires: exp, MaxAge: int(deviceSessionTTL / time.Second),
		HttpOnly: true, SameSite: http.SameSiteStrictMode,
		Secure: r.TLS != nil || strings.EqualFold(r.Header.Get("X-Forwarded-Proto"), "https"),
	})
	writeJSON(w, 200, map[string]any{"ok": true, "device": toDeviceJSON(*dev, dev.ID)})
}

func (s *Server) deviceMe(w http.ResponseWriter, r *http.Request) {
	t := trustOf(r)
	out := map[string]any{"trusted": t.via != "", "via": nil}
	if t.via != "" {
		out["via"] = t.via
	}
	if t.device != nil {
		out["device"] = toDeviceJSON(*t.device, t.device.ID)
	}
	writeJSON(w, 200, out)
}

func (s *Server) listDevices(w http.ResponseWriter, r *http.Request) {
	list, err := devices.List(s.cfg.DataDir)
	if err != nil {
		storeError(w, err)
		return
	}
	current := ""
	if t := trustOf(r); t.device != nil {
		current = t.device.ID
	}
	out := []deviceJSON{}
	for _, d := range list {
		out = append(out, toDeviceJSON(d, current))
	}
	pending, err := devices.Pending(s.cfg.DataDir, time.Now())
	if err != nil {
		storeError(w, err)
		return
	}
	reqs := []pairRequestJSON{}
	for _, p := range pending {
		reqs = append(reqs, pairRequestJSON{ID: p.ID, Code: p.Code, Name: p.Name, Fingerprint: p.Fingerprint, CreatedAt: p.CreatedAt, IP: p.IP, TailscaleLogin: p.TailscaleLogin})
	}
	writeJSON(w, 200, map[string]any{"devices": out, "requests": reqs})
}

func (s *Server) decideDevice(accept bool) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		pr, err := devices.GetByID(s.cfg.DataDir, r.PathValue("id"), time.Now())
		if err != nil {
			httpError(w, 404, err.Error())
			return
		}
		if accept {
			_, d, err := devices.Accept(s.cfg.DataDir, pr.Code, time.Now())
			if err != nil {
				httpError(w, 409, err.Error())
				return
			}
			s.publishDevices()
			writeJSON(w, 200, map[string]any{"ok": true, "device": toDeviceJSON(*d, "")})
			return
		}
		if _, err := devices.Reject(s.cfg.DataDir, pr.Code, time.Now()); err != nil {
			httpError(w, 409, err.Error())
			return
		}
		s.publishDevices()
		writeJSON(w, 200, map[string]bool{"ok": true})
	}
}

func (s *Server) revokeDevice(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	found, err := devices.Revoke(s.cfg.DataDir, id)
	if err != nil {
		storeError(w, err)
		return
	}
	if !found {
		httpError(w, 404, "no such device")
		return
	}
	s.publishDevices()
	writeJSON(w, 200, map[string]bool{"ok": true})
	// After the answer: a device revoking itself gets its reply first.
	go s.dropDevice(id)
}

// watchDevices tells the browsers when the CLI changes pairings or devices.
func (s *Server) watchDevices(ctx context.Context) {
	stamp := func() string {
		var b strings.Builder
		if fi, err := os.Stat(devices.File(s.cfg.DataDir)); err == nil {
			b.WriteString(fi.ModTime().String())
		}
		if ents, err := os.ReadDir(devices.PairingDir(s.cfg.DataDir)); err == nil {
			for _, e := range ents {
				if fi, err := e.Info(); err == nil {
					b.WriteString(e.Name() + fi.ModTime().String())
				}
			}
		}
		return b.String()
	}
	last := stamp()
	t := time.NewTicker(2 * time.Second)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			if now := stamp(); now != last {
				last = now
				s.publishDevices()
				// A device revoked from the CLI loses its sessions.
				list, err := devices.List(s.cfg.DataDir)
				if err != nil {
					continue
				}
				keep := map[string]bool{}
				for _, d := range list {
					keep[d.ID] = true
				}
				s.devAuth.mu.Lock()
				var gone []string
				for _, ds := range s.devAuth.sessions {
					if !keep[ds.deviceID] {
						gone = append(gone, ds.deviceID)
					}
				}
				s.devAuth.mu.Unlock()
				for _, id := range gone {
					s.dropDevice(id)
				}
			}
		}
	}
}
