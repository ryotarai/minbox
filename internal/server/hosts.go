package server

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/ryotarai/minbox/internal/hostauth"
	"github.com/ryotarai/minbox/internal/hostfs"
	"github.com/ryotarai/minbox/internal/store"
	"github.com/ryotarai/minbox/internal/termhost"
)

// Hosts: the machines sessions run on. The built-in "local" host is the
// terminal host on this machine (Unix socket); others run `minbox host
// --listen` (Direct) or `minbox host --tailscale` (Tailscale) and are
// reached over HTTP(S) with requests signed by this server's key, once a
// person paired it on that machine (`minbox pair accept CODE`).

// hostConn is the server's connection to one host.
type hostConn struct {
	id      string
	builtin bool

	mu       sync.Mutex
	name     string
	url      string
	paired   bool
	pairing  string // the code waiting for accept
	client   HostConn
	fs       hostfs.FS
	status   string // online | offline | connecting
	version  string
	os, arch string
	latency  int64 // ms; -1 unknown
	lastSeen *time.Time
	err      string
	cancel   context.CancelFunc
	retry    chan struct{}
}

func (c *hostConn) getClient() HostConn {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.client
}

func (c *hostConn) getFS() hostfs.FS {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.fs
}

func (c *hostConn) displayName() string {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.name
}

func (c *hostConn) setClient(h HostConn, f hostfs.FS) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.client, c.fs = h, f
	if h != nil {
		now := time.Now()
		c.status, c.err, c.lastSeen = "online", "", &now
	} else {
		c.status = "offline"
	}
}

func (c *hostConn) setOffline(err error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.client = nil
	if !c.builtin {
		c.fs = nil
	}
	c.status = "offline"
	if err != nil {
		c.err = err.Error()
	}
}

func (c *hostConn) setVersion(v termhost.VersionInfo, latency time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.version, c.os, c.arch = v.Version, v.OS, v.Arch
	c.latency = latency.Milliseconds()
	now := time.Now()
	c.lastSeen = &now
}

// hostSet holds the connections.
type hostSet struct {
	mu    sync.Mutex
	conns map[string]*hostConn
}

func newHostSet() *hostSet {
	hs := &hostSet{conns: map[string]*hostConn{}}
	hs.conns[store.LocalHostID] = &hostConn{id: store.LocalHostID, builtin: true, name: "local", status: "connecting", latency: -1}
	return hs
}

func (hs *hostSet) get(id string) *hostConn {
	if id == "" {
		id = store.LocalHostID
	}
	hs.mu.Lock()
	defer hs.mu.Unlock()
	return hs.conns[id]
}

func (hs *hostSet) local() *hostConn { return hs.get(store.LocalHostID) }

func (hs *hostSet) put(c *hostConn) {
	hs.mu.Lock()
	defer hs.mu.Unlock()
	hs.conns[c.id] = c
}

func (hs *hostSet) remove(id string) *hostConn {
	hs.mu.Lock()
	defer hs.mu.Unlock()
	c := hs.conns[id]
	delete(hs.conns, id)
	return c
}

// ---- running the remote hosts ----

// startHosts connects to every remote host recorded (call once, at start).
func (s *Server) startHosts(ctx context.Context) {
	s.hostsCtx = ctx
	hosts, err := s.store.ListHosts(ctx)
	if err != nil {
		log.Printf("hosts: %v", err)
		return
	}
	for _, h := range hosts {
		if h.Builtin {
			s.sessions.hosts.local().mu.Lock()
			s.sessions.hosts.local().name = h.Name
			s.sessions.hosts.local().mu.Unlock()
			continue
		}
		s.runRemote(h)
	}
}

// runRemote starts (or restarts) the connection loop of a remote host.
func (s *Server) runRemote(h store.Host) {
	c := s.sessions.hosts.get(h.ID)
	if c == nil {
		c = &hostConn{id: h.ID, latency: -1, retry: make(chan struct{}, 1)}
		s.sessions.hosts.put(c)
	}
	c.mu.Lock()
	if c.cancel != nil {
		c.cancel()
	}
	c.name, c.url, c.paired, c.pairing = h.Name, h.URL, h.Paired, h.PairingCode
	switch {
	case h.PairingCode != "":
		c.status, c.err = "pairing", ""
	case !h.Paired:
		c.status, c.err = "offline", "pair this host again"
	default:
		c.status = "connecting"
	}
	if c.retry == nil {
		c.retry = make(chan struct{}, 1)
	}
	base := s.hostsCtx
	if base == nil {
		base = context.Background()
	}
	ctx, cancel := context.WithCancel(base)
	c.cancel = cancel
	c.mu.Unlock()
	switch {
	case h.PairingCode != "":
		go s.pairLoop(ctx, c, h.PairingCode)
	case h.Paired:
		go s.remoteLoop(ctx, c)
	}
}

// connectRemote checks a host answers this server's signed requests and
// speaks a protocol we can use; it answers a client for it.
func connectRemote(ctx context.Context, rawURL string, signer *hostauth.Signer) (*termhost.Client, termhost.VersionInfo, time.Duration, error) {
	if err := checkHostURL(rawURL); err != nil {
		return nil, termhost.VersionInfo{}, 0, err
	}
	client := termhost.NewHTTPClient(rawURL, signer, ProtocolVersion)
	vctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	start := time.Now()
	v, err := client.Version(vctx)
	if err != nil {
		return nil, v, 0, describeHostErr(err)
	}
	latency := time.Since(start)
	if err := checkHostVersion(v); err != nil {
		return nil, v, 0, err
	}
	// Something only a paired server may ask.
	if _, err := client.List(vctx); err != nil {
		return nil, v, 0, describeHostErr(err)
	}
	return client, v, latency, nil
}

func checkHostURL(rawURL string) error {
	if _, err := url.ParseRequestURI(rawURL); err != nil || !(strings.HasPrefix(rawURL, "http://") || strings.HasPrefix(rawURL, "https://")) {
		return errors.New("the URL must start with http:// or https://")
	}
	return nil
}

func checkHostVersion(v termhost.VersionInfo) error {
	if !v.Remote {
		return errors.New("that is a local terminal host, not one started with `minbox host --listen` or `--tailscale`")
	}
	if v.Protocol < termhost.RemoteProtocol || !termhost.Compatible(v, ProtocolVersion, RequiredHostVersion) {
		if v.Protocol < termhost.RemoteProtocol || v.Protocol < RequiredHostVersion {
			return fmt.Errorf("its minbox is too old (host protocol %d, this server needs %d): update minbox on that machine", v.Protocol, termhost.RemoteProtocol)
		}
		return fmt.Errorf("its minbox is newer than this server's (it needs server protocol %d): update minbox here", v.RequiredServerVersion)
	}
	return nil
}

func describeHostErr(err error) error {
	var se *termhost.StatusError
	if errors.As(err, &se) {
		switch se.Status {
		case http.StatusUnauthorized:
			return fmt.Errorf("the host does not accept this server (%s): pair it again", se.Message)
		case http.StatusForbidden:
			return errors.New(se.Message)
		case http.StatusUpgradeRequired:
			return fmt.Errorf("its minbox is newer than this server's: %s", se.Message)
		}
		return fmt.Errorf("the host answered %d %s", se.Status, se.Message)
	}
	return fmt.Errorf("could not connect: %v", err)
}

// pairLoop waits (polling every second) for a person to accept the code on
// the host's machine; then the host connects.
func (s *Server) pairLoop(ctx context.Context, c *hostConn, code string) {
	c.mu.Lock()
	u := c.url
	c.mu.Unlock()
	client := termhost.NewHTTPClient(u, nil, ProtocolVersion)
	deadline := time.Now().Add(hostauth.PairingTTL + 30*time.Second)
	end := func(paired bool, msg string) {
		_ = s.store.SetHostPairing(context.Background(), c.id, "", paired)
		h, err := s.store.GetHost(context.Background(), c.id)
		if err != nil {
			return
		}
		if paired {
			s.runRemote(*h)
		} else {
			c.mu.Lock()
			c.pairing, c.status, c.err = "", "offline", msg
			c.mu.Unlock()
		}
		s.hub.publish(Event{Type: "hosts"})
	}
	t := time.NewTicker(s.pairPoll)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
		qctx, cancel := context.WithTimeout(ctx, 5*time.Second)
		st, err := client.PairStatus(qctx, code)
		cancel()
		if err != nil {
			if time.Now().After(deadline) {
				end(false, "the pairing code expired; pair again")
				return
			}
			continue
		}
		switch st {
		case "accepted":
			end(true, "")
			return
		case "rejected":
			end(false, "the pairing was rejected on the host")
			return
		case "expired":
			end(false, "the pairing code expired; pair again")
			return
		}
	}
}

// remoteLoop keeps a remote host connected: reconcile its sessions, follow
// exits, carry its mods' calls (the relay), measure it; back off when it is away.
func (s *Server) remoteLoop(ctx context.Context, c *hostConn) {
	backoff := time.Second
	for ctx.Err() == nil {
		c.mu.Lock()
		u := c.url
		c.mu.Unlock()
		client, v, latency, err := connectRemote(ctx, u, s.signer)
		if err != nil {
			c.setOffline(err)
			s.hub.publish(Event{Type: "hosts"})
			select {
			case <-ctx.Done():
				return
			case <-c.retry:
				backoff = time.Second
			case <-time.After(backoff):
				if backoff < 30*time.Second {
					backoff *= 2
				}
			}
			continue
		}
		backoff = time.Second
		c.setVersion(v, latency)
		c.setClient(client, client.FS())
		s.hub.publish(Event{Type: "hosts"})
		if err := s.sessions.reconcileHost(ctx, c.id); err != nil {
			log.Printf("host %s: reconcile: %v", c.id, err)
		}
		cctx, cancel := context.WithCancel(ctx)
		go func() { // the relay: reconnect while the host is up
			for cctx.Err() == nil {
				if err := client.Relay(cctx, s.handler); err != nil && cctx.Err() == nil {
					time.Sleep(500 * time.Millisecond)
				}
			}
		}()
		go func() { // latency and last seen
			t := time.NewTicker(30 * time.Second)
			defer t.Stop()
			for {
				select {
				case <-cctx.Done():
					return
				case <-t.C:
					start := time.Now()
					vctx, vc := context.WithTimeout(cctx, 5*time.Second)
					v, err := client.Version(vctx)
					vc()
					if err == nil {
						c.setVersion(v, time.Since(start))
						s.hub.publish(Event{Type: "hosts"})
					}
				}
			}
		}()
		err = client.Events(cctx, func(ev termhost.Event) {
			if ev.Type == "exit" {
				s.sessions.onExit(cctx, ev.ID, ev.ExitCode)
			}
		})
		cancel()
		if ctx.Err() != nil {
			return
		}
		log.Printf("host %s: connection lost (%v); reconnecting", c.id, err)
		c.setOffline(fmt.Errorf("connection lost: %v", err))
		s.hub.publish(Event{Type: "hosts"})
		time.Sleep(500 * time.Millisecond)
	}
}

// ---- browser routes ----

type hostJSON struct {
	ID             string     `json:"id"`
	Name           string     `json:"name"`
	URL            string     `json:"url"`
	Builtin        bool       `json:"builtin"`
	Method         string     `json:"method"`
	TailscaleLogin string     `json:"tailscale_login,omitempty"`
	Paired         bool       `json:"paired"`
	PairingCode    string     `json:"pairing_code,omitempty"`
	Fingerprint    string     `json:"fingerprint,omitempty"`
	Status         string     `json:"status"`
	Version        string     `json:"version,omitempty"`
	OS             string     `json:"os,omitempty"`
	Arch           string     `json:"arch,omitempty"`
	LatencyMs      *int64     `json:"latency_ms,omitempty"`
	LastSeen       *time.Time `json:"last_seen"`
	Error          string     `json:"error,omitempty"`
	Sessions       int        `json:"sessions"`
}

func (s *Server) hostView(ctx context.Context, h store.Host) hostJSON {
	out := hostJSON{ID: h.ID, Name: h.Name, URL: h.URL, Builtin: h.Builtin, Method: h.Method, TailscaleLogin: h.TailscaleLogin,
		Paired: h.Paired || h.Builtin, PairingCode: h.PairingCode, Status: "offline"}
	if h.Builtin {
		out.Method = store.MethodBuiltin
	} else {
		out.Fingerprint = s.signer.Fingerprint()
	}
	if c := s.sessions.hosts.get(h.ID); c != nil {
		c.mu.Lock()
		out.Status, out.Version, out.OS, out.Arch, out.LastSeen, out.Error = c.status, c.version, c.os, c.arch, c.lastSeen, c.err
		if out.Status == "" {
			out.Status = "connecting"
		}
		if c.latency >= 0 && out.Status == "online" {
			l := c.latency
			out.LatencyMs = &l
		}
		c.mu.Unlock()
	}
	if h.PairingCode != "" {
		out.Status = "pairing"
	}
	if h.Builtin && out.Version == "" {
		out.Version = Version
	}
	out.Sessions, _ = s.store.SessionsOnHost(ctx, h.ID)
	return out
}

func (s *Server) listHosts(w http.ResponseWriter, r *http.Request) {
	hosts, err := s.store.ListHosts(r.Context())
	if err != nil {
		storeError(w, err)
		return
	}
	out := []hostJSON{}
	for _, h := range hosts {
		out = append(out, s.hostView(r.Context(), h))
	}
	writeJSON(w, 200, out)
}

// HostTailscalePort is the tailnet HTTPS port `minbox host --tailscale`
// serves on: not 3125, which `minbox start --tailscale` (or anything
// else) may hold on the same machine.
const HostTailscalePort = 14849

// tailnetHostURL is the URL of a minbox host served on a tailnet machine.
func tailnetHostURL(dnsName string) string {
	return fmt.Sprintf("https://%s:%d", strings.TrimSuffix(dnsName, "."), HostTailscalePort)
}

// hostURL makes the URL a host is reached at: a Tailscale host may be given as
// its bare MagicDNS name (the host's port is added).
func hostURL(raw, method string) string {
	u := strings.TrimRight(strings.TrimSpace(raw), "/")
	if method == store.MethodTailscale && u != "" && !strings.Contains(u, "://") {
		if _, _, err := net.SplitHostPort(u); err == nil {
			return "https://" + u // a port of one's own
		}
		u = tailnetHostURL(u)
	}
	return u
}

// probeHost asks a host's (unauthenticated) /version.
func (s *Server) probeHost(ctx context.Context, rawURL string, timeout time.Duration) (termhost.VersionInfo, error) {
	if err := checkHostURL(rawURL); err != nil {
		return termhost.VersionInfo{}, err
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	v, err := termhost.NewHTTPClient(rawURL, nil, ProtocolVersion).Version(ctx)
	if err != nil {
		return v, describeHostErr(err)
	}
	return v, checkHostVersion(v)
}

func (s *Server) probeHostRoute(w http.ResponseWriter, r *http.Request) {
	var req struct {
		URL    string `json:"url"`
		Method string `json:"method"`
	}
	if !decode(w, r, &req) {
		return
	}
	method := req.Method
	if method == "" && !strings.Contains(req.URL, "://") {
		method = store.MethodTailscale
	}
	v, err := s.probeHost(r.Context(), hostURL(req.URL, method), 5*time.Second)
	if err != nil {
		writeJSON(w, 200, map[string]any{"ok": false, "error": err.Error()})
		return
	}
	writeJSON(w, 200, map[string]any{"ok": true, "version": v.Version, "os": v.OS, "arch": v.Arch, "hostname": v.Hostname, "tailscale": v.Tailscale})
}

// addHost starts pairing with a host: it asks the host for a code, which a
// person accepts there (`minbox pair accept CODE`).
func (s *Server) addHost(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Name           string `json:"name"`
		URL            string `json:"url"`
		Method         string `json:"method"`
		TailscaleLogin string `json:"tailscale_login"`
	}
	if !decode(w, r, &req) {
		return
	}
	method := req.Method
	if method == "" {
		method = store.MethodDirect
	}
	if method != store.MethodDirect && method != store.MethodTailscale {
		httpError(w, 400, "method must be tailscale or direct")
		return
	}
	u := hostURL(req.URL, method)
	name := strings.TrimSpace(req.Name)
	if name == "" {
		if pu, err := url.Parse(u); err == nil {
			name, _, _ = strings.Cut(pu.Hostname(), ".")
		}
	}
	if name == "" || u == "" {
		httpError(w, 400, "name and url are required")
		return
	}
	if _, err := s.probeHost(r.Context(), u, 5*time.Second); err != nil {
		httpError(w, 400, err.Error())
		return
	}
	code, err := s.requestPairing(r.Context(), u)
	if err != nil {
		httpError(w, 400, err.Error())
		return
	}
	h, err := s.store.CreateHost(r.Context(), name, u, method, strings.TrimSpace(req.TailscaleLogin), code)
	if err != nil {
		storeError(w, err)
		return
	}
	s.runRemote(*h)
	s.hub.publish(Event{Type: "hosts"})
	writeJSON(w, 201, map[string]any{"host": s.hostView(r.Context(), *h), "code": code})
}

func (s *Server) requestPairing(ctx context.Context, u string) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	code, err := termhost.NewHTTPClient(u, nil, ProtocolVersion).PairRequest(ctx, s.serverName, hostauth.EncodePublicKey(s.signer.Public()))
	if err != nil {
		return "", describeHostErr(err)
	}
	return code, nil
}

// repairHost pairs again (a new code), e.g. after the host forgot this server.
func (s *Server) repairHost(w http.ResponseWriter, r *http.Request) {
	h, err := s.store.GetHost(r.Context(), r.PathValue("id"))
	if err != nil {
		storeError(w, err)
		return
	}
	if h.Builtin {
		httpError(w, 400, "the built-in host needs no pairing")
		return
	}
	code, err := s.requestPairing(r.Context(), h.URL)
	if err != nil {
		httpError(w, 400, err.Error())
		return
	}
	if err := s.store.SetHostPairing(r.Context(), h.ID, code, h.Paired); err != nil {
		storeError(w, err)
		return
	}
	h.PairingCode = code
	s.runRemote(*h)
	s.hub.publish(Event{Type: "hosts"})
	writeJSON(w, 200, map[string]string{"code": code})
}

func (s *Server) patchHost(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Name *string `json:"name"`
		URL  *string `json:"url"`
	}
	if !decode(w, r, &req) {
		return
	}
	id := r.PathValue("id")
	h, err := s.store.GetHost(r.Context(), id)
	if err != nil {
		storeError(w, err)
		return
	}
	if req.Name != nil {
		n := strings.TrimSpace(*req.Name)
		if n == "" {
			httpError(w, 400, "name is required")
			return
		}
		req.Name = &n
	}
	if h.Builtin && req.URL != nil {
		httpError(w, 400, "the built-in host has no URL")
		return
	}
	if req.URL != nil {
		u := hostURL(*req.URL, h.Method)
		if err := checkHostURL(u); err != nil {
			httpError(w, 400, err.Error())
			return
		}
		req.URL = &u
	}
	if err := s.store.UpdateHost(r.Context(), id, req.Name, req.URL); err != nil {
		storeError(w, err)
		return
	}
	h, _ = s.store.GetHost(r.Context(), id)
	if c := s.sessions.hosts.get(id); c != nil && req.Name != nil {
		c.mu.Lock()
		c.name = *req.Name
		c.mu.Unlock()
	}
	if !h.Builtin && req.URL != nil {
		s.runRemote(*h)
	}
	s.hub.publish(Event{Type: "hosts"})
	s.hub.publish(Event{Type: "sessions"})
	writeJSON(w, 200, s.hostView(r.Context(), *h))
}

func (s *Server) deleteHost(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if id == store.LocalHostID {
		httpError(w, 400, "the built-in host cannot be removed")
		return
	}
	if c := s.sessions.hosts.get(id); c != nil {
		if h := c.getClient(); h != nil {
			// Its running sessions end (while it can still be asked to).
			if sessions, err := s.store.ListSessions(r.Context()); err == nil {
				for _, sess := range sessions {
					if sess.HostID == id && sess.Status != store.StatusEnded {
						s.sessions.mu.Lock()
						s.sessions.stopping[sess.ID] = true
						s.sessions.mu.Unlock()
						_ = h.Kill(r.Context(), sess.ID)
						_ = h.Kill(r.Context(), shellTermID(sess.ID))
					}
				}
			}
			// And it forgets this server's key.
			if cl, ok := h.(*termhost.Client); ok {
				fctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
				if err := cl.ForgetSelf(fctx); err != nil {
					log.Printf("host %s: forget this server: %v", id, err)
				}
				cancel()
			}
		}
	}
	if err := s.store.DeleteHost(r.Context(), id); err != nil {
		storeError(w, err)
		return
	}
	if c := s.sessions.hosts.remove(id); c != nil {
		c.mu.Lock()
		if c.cancel != nil {
			c.cancel()
		}
		c.mu.Unlock()
	}
	s.hub.publish(Event{Type: "hosts"})
	s.hub.publish(Event{Type: "sessions"})
	writeJSON(w, 200, map[string]bool{"ok": true})
}

func (s *Server) retryHost(w http.ResponseWriter, r *http.Request) {
	c := s.sessions.hosts.get(r.PathValue("id"))
	if c == nil {
		httpError(w, 404, "not found")
		return
	}
	if c.builtin {
		writeJSON(w, 200, map[string]bool{"ok": true})
		return
	}
	c.mu.Lock()
	if c.paired && c.pairing == "" {
		c.status = "connecting"
	}
	c.mu.Unlock()
	select {
	case c.retry <- struct{}{}:
	default:
	}
	s.hub.publish(Event{Type: "hosts"})
	writeJSON(w, 200, map[string]bool{"ok": true})
}

// hostNames maps host ids to names, for session rows.
func (s *Server) hostNames(ctx context.Context) map[string]string {
	out := map[string]string{}
	if hosts, err := s.store.ListHosts(ctx); err == nil {
		for _, h := range hosts {
			out[h.ID] = h.Name
		}
	}
	return out
}

// ---- Tailscale ----

// tailscaleStatusJSON runs `tailscale status --json` (nil, nil when there is
// no tailscale CLI).
func tailscaleStatusJSON(ctx context.Context) ([]byte, error) {
	bin, err := exec.LookPath("tailscale")
	if err != nil {
		const mac = "/Applications/Tailscale.app/Contents/MacOS/Tailscale"
		if _, serr := os.Stat(mac); serr != nil {
			return nil, nil
		}
		bin = mac
	}
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	return exec.CommandContext(ctx, bin, "status", "--json").Output()
}

type tsStatus struct {
	Self *struct {
		UserID  int64  `json:"UserID"`
		DNSName string `json:"DNSName"`
	} `json:"Self"`
	MagicDNSSuffix string `json:"MagicDNSSuffix"`
	CurrentTailnet *struct {
		MagicDNSSuffix string `json:"MagicDNSSuffix"`
	} `json:"CurrentTailnet"`
	User map[string]struct {
		LoginName string `json:"LoginName"`
	} `json:"User"`
	Peer map[string]struct {
		HostName string `json:"HostName"`
		DNSName  string `json:"DNSName"`
		OS       string `json:"OS"`
		Online   bool   `json:"Online"`
	} `json:"Peer"`
}

type tsPeer struct {
	Name    string `json:"name"`
	DNSName string `json:"dns_name"`
	OS      string `json:"os"`
	Online  bool   `json:"online"`
	HasHost bool   `json:"has_host"`
	Added   bool   `json:"added"`
}

// tailscaleInfo answers whether Tailscale is here, this machine's login, the
// tailnet's MagicDNS suffix and its machines (with which run a minbox host).
func (s *Server) tailscaleInfo(w http.ResponseWriter, r *http.Request) {
	out := map[string]any{"available": false, "peers": []tsPeer{}}
	raw, err := s.tailscaleStatus(r.Context())
	if err != nil || len(raw) == 0 {
		writeJSON(w, 200, out)
		return
	}
	var st tsStatus
	if err := json.Unmarshal(raw, &st); err != nil {
		writeJSON(w, 200, out)
		return
	}
	out["available"] = true
	if st.Self != nil {
		if u, ok := st.User[strconv.FormatInt(st.Self.UserID, 10)]; ok {
			out["login"] = u.LoginName
		}
	}
	suffix := st.MagicDNSSuffix
	if suffix == "" && st.CurrentTailnet != nil {
		suffix = st.CurrentTailnet.MagicDNSSuffix
	}
	if suffix != "" {
		out["suffix"] = strings.TrimSuffix(suffix, ".")
	}
	added := map[string]bool{}
	if hosts, err := s.store.ListHosts(r.Context()); err == nil {
		for _, h := range hosts {
			if pu, err := url.Parse(h.URL); err == nil {
				added[strings.ToLower(pu.Hostname())] = true
			}
		}
	}
	peers := []tsPeer{}
	for _, p := range st.Peer {
		dns := strings.TrimSuffix(p.DNSName, ".")
		if dns == "" {
			continue
		}
		name := p.HostName
		if name == "" {
			name, _, _ = strings.Cut(dns, ".")
		}
		peers = append(peers, tsPeer{Name: name, DNSName: dns, OS: p.OS, Online: p.Online, Added: added[strings.ToLower(dns)]})
	}
	// Which run a minbox host: ask the online ones, all at once.
	var wg sync.WaitGroup
	for i := range peers {
		if !peers[i].Online {
			continue
		}
		wg.Add(1)
		go func(p *tsPeer) {
			defer wg.Done()
			if _, err := s.probeHost(r.Context(), s.peerURL(p.DNSName), 1500*time.Millisecond); err == nil {
				p.HasHost = true
			}
		}(&peers[i])
	}
	wg.Wait()
	sort.Slice(peers, func(i, j int) bool {
		a, b := peers[i], peers[j]
		if a.HasHost != b.HasHost {
			return a.HasHost
		}
		if a.Online != b.Online {
			return a.Online
		}
		return strings.ToLower(a.Name) < strings.ToLower(b.Name)
	})
	out["peers"] = peers
	writeJSON(w, 200, out)
}
