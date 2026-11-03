package termhost

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/coder/websocket"
	"github.com/ryotarai/minbox/internal/hostauth"
	"github.com/ryotarai/minbox/internal/hostfs"
)

// Client talks to a terminal host: over its Unix socket (this machine), or
// over HTTP with signed requests (another machine).
type Client struct {
	SocketPath    string
	ServerVersion int // sent on every request
	http          *http.Client
	base          string // http://termhost (socket) or the host's URL
	signer        *hostauth.Signer
}

func NewClient(socketPath string, serverVersion int) *Client {
	tr := &http.Transport{
		DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
			var d net.Dialer
			return d.DialContext(ctx, "unix", socketPath)
		},
	}
	return &Client{SocketPath: socketPath, ServerVersion: serverVersion, http: &http.Client{Transport: tr}, base: "http://termhost"}
}

// NewHTTPClient talks to a remote host at baseURL (http:// or https://),
// signing every request with signer (nil: unsigned, for /version and pairing).
func NewHTTPClient(baseURL string, signer *hostauth.Signer, serverVersion int) *Client {
	return &Client{ServerVersion: serverVersion, http: &http.Client{}, base: strings.TrimRight(baseURL, "/"), signer: signer}
}

// Base is the host's URL.
func (c *Client) Base() string { return c.base }

func (c *Client) setHeaders(h http.Header, method, requestURI string) {
	h.Set(HeaderServerVersion, strconv.Itoa(c.ServerVersion))
	if c.signer != nil {
		h.Set("Authorization", c.signer.Header(method, requestURI))
	}
}

// FS is file access on the host's machine (a remote host).
func (c *Client) FS() *hostfs.Remote {
	r := &hostfs.Remote{Base: c.base, Client: c.http, Header: http.Header{HeaderServerVersion: {strconv.Itoa(c.ServerVersion)}}}
	if c.signer != nil {
		r.Sign = c.signer.Sign
	}
	return r
}

// PairRequest asks the host to pair with this server's key; it answers the
// code a person accepts on that machine.
func (c *Client) PairRequest(ctx context.Context, serverName, publicKey string) (string, error) {
	var out struct {
		Code string `json:"code"`
	}
	err := c.do(ctx, "POST", "/pair", map[string]string{"server_name": serverName, "public_key": publicKey}, &out)
	return out.Code, err
}

// PairStatus is pending, accepted, rejected or expired.
func (c *Client) PairStatus(ctx context.Context, code string) (string, error) {
	var out struct {
		Status string `json:"status"`
	}
	err := c.do(ctx, "GET", "/pair/"+url.PathEscape(code), nil, &out)
	return out.Status, err
}

// ForgetSelf makes the host forget this server's key.
func (c *Client) ForgetSelf(ctx context.Context) error {
	return c.do(ctx, "DELETE", "/pair/self", nil, nil)
}

func (c *Client) dialWS(ctx context.Context, path string) (*websocket.Conn, error) {
	h := http.Header{}
	c.setHeaders(h, "GET", path)
	u := c.base + path
	if strings.HasPrefix(u, "https://") {
		u = "wss://" + strings.TrimPrefix(u, "https://")
	} else {
		u = "ws://" + strings.TrimPrefix(u, "http://")
	}
	conn, _, err := websocket.Dial(ctx, u, &websocket.DialOptions{HTTPClient: c.http, HTTPHeader: h})
	return conn, err
}

func (c *Client) do(ctx context.Context, method, path string, body any, out any) error {
	var rd io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return err
		}
		rd = bytes.NewReader(b)
	}
	req, err := http.NewRequestWithContext(ctx, method, c.base+path, rd)
	if err != nil {
		return err
	}
	c.setHeaders(req.Header, method, req.URL.RequestURI())
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 300 {
		var e struct {
			Error string `json:"error"`
		}
		_ = json.NewDecoder(resp.Body).Decode(&e)
		return &StatusError{Status: resp.StatusCode, Message: e.Error}
	}
	if out != nil {
		return json.NewDecoder(resp.Body).Decode(out)
	}
	return nil
}

// StatusError is a non-2xx answer from the host.
type StatusError struct {
	Status  int
	Message string
}

func (e *StatusError) Error() string { return fmt.Sprintf("terminal host: %d %s", e.Status, e.Message) }

func (c *Client) Version(ctx context.Context) (VersionInfo, error) {
	var v VersionInfo
	err := c.do(ctx, "GET", "/version", nil, &v)
	return v, err
}

func (c *Client) List(ctx context.Context) ([]TerminalInfo, error) {
	var out []TerminalInfo
	err := c.do(ctx, "GET", "/terminals", nil, &out)
	return out, err
}

func (c *Client) Spawn(ctx context.Context, req SpawnRequest) (TerminalInfo, error) {
	var out TerminalInfo
	err := c.do(ctx, "POST", "/terminals", req, &out)
	return out, err
}

func (c *Client) Kill(ctx context.Context, id string) error {
	return c.do(ctx, "POST", "/terminals/"+id+"/kill", nil, nil)
}

func (c *Client) Remove(ctx context.Context, id string) error {
	return c.do(ctx, "DELETE", "/terminals/"+id, nil, nil)
}

func (c *Client) Shutdown(ctx context.Context) error {
	return c.do(ctx, "POST", "/shutdown", nil, nil)
}

// Attach opens the terminal's attach WebSocket.
func (c *Client) Attach(ctx context.Context, id string) (*websocket.Conn, error) {
	conn, err := c.dialWS(ctx, "/terminals/"+id+"/attach")
	if err != nil {
		return nil, err
	}
	conn.SetReadLimit(8 << 20)
	return conn, nil
}

// Events streams host events until ctx ends or the connection drops.
func (c *Client) Events(ctx context.Context, fn func(Event)) error {
	req, err := http.NewRequestWithContext(ctx, "GET", c.base+"/events", nil)
	if err != nil {
		return err
	}
	c.setHeaders(req.Header, "GET", req.URL.RequestURI())
	resp, err := c.http.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return &StatusError{Status: resp.StatusCode}
	}
	sc := bufio.NewScanner(resp.Body)
	for sc.Scan() {
		var ev Event
		if json.Unmarshal(sc.Bytes(), &ev) == nil && ev.Type != "ping" {
			fn(ev)
		}
	}
	if err := sc.Err(); err != nil {
		return err
	}
	return io.EOF
}

// Compatible reports whether a host and a server can work together: each must
// meet the other's required version.
func Compatible(host VersionInfo, serverVersion, serverRequiresHost int) bool {
	return host.Protocol >= serverRequiresHost && serverVersion >= host.RequiredServerVersion
}

// EnsureOptions controls how Ensure starts a host.
type EnsureOptions struct {
	ServerVersion      int
	ServerRequiresHost int
	// Start launches a new host process listening on the socket (detached).
	Start func() error
	// Logf reports what happened.
	Logf func(format string, args ...any)
}

// Ensure connects to the host on socketPath, starting one when none answers,
// and restarting it when the versions are not compatible. It reports whether
// the host was (re)started.
func Ensure(ctx context.Context, socketPath string, opts EnsureOptions) (*Client, bool, error) {
	logf := opts.Logf
	if logf == nil {
		logf = func(string, ...any) {}
	}
	c := NewClient(socketPath, opts.ServerVersion)
	vctx, cancel := context.WithTimeout(ctx, 2*time.Second)
	v, err := c.Version(vctx)
	cancel()
	started := false
	if err == nil && !Compatible(v, opts.ServerVersion, opts.ServerRequiresHost) {
		logf("terminal host protocol %d (requires server %d) is not compatible with server protocol %d (requires host %d): restarting it; its sessions end",
			v.Protocol, v.RequiredServerVersion, opts.ServerVersion, opts.ServerRequiresHost)
		if err := stopHost(ctx, c, v, logf); err != nil {
			return nil, false, err
		}
		err = errors.New("restarting")
	}
	if err != nil {
		if opts.Start == nil {
			return nil, false, fmt.Errorf("no terminal host on %s: %w", socketPath, err)
		}
		if err := opts.Start(); err != nil {
			return nil, false, fmt.Errorf("start terminal host: %w", err)
		}
		started = true
		deadline := time.Now().Add(10 * time.Second)
		for {
			vctx, cancel := context.WithTimeout(ctx, time.Second)
			v, err = c.Version(vctx)
			cancel()
			if err == nil {
				break
			}
			if time.Now().After(deadline) {
				return nil, false, fmt.Errorf("terminal host did not come up: %w", err)
			}
			time.Sleep(100 * time.Millisecond)
		}
		if !Compatible(v, opts.ServerVersion, opts.ServerRequiresHost) {
			return nil, false, fmt.Errorf("new terminal host protocol %d is not compatible", v.Protocol)
		}
	}
	return c, started, nil
}

// Stop asks the host on socketPath to shut down (its terminals end), and
// signals its process when the request fails (a host that refuses this
// server's protocol, say). It answers the host's pid, and false when no host
// answers on the socket.
func Stop(ctx context.Context, socketPath string, serverVersion int, logf func(string, ...any)) (int, bool, error) {
	if logf == nil {
		logf = func(string, ...any) {}
	}
	c := NewClient(socketPath, serverVersion)
	vctx, cancel := context.WithTimeout(ctx, 2*time.Second)
	v, err := c.Version(vctx)
	cancel()
	if err != nil {
		return 0, false, nil
	}
	return v.PID, true, stopHost(ctx, c, v, logf)
}

func stopHost(ctx context.Context, c *Client, v VersionInfo, logf func(string, ...any)) error {
	sctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	if err := c.Shutdown(sctx); err != nil {
		logf("shutdown request failed (%v); signalling pid %d", err, v.PID)
		if v.PID > 0 {
			_ = syscall.Kill(v.PID, syscall.SIGTERM)
		}
	}
	if !waitGone(c.SocketPath, 10*time.Second) {
		return fmt.Errorf("terminal host (pid %d) is still running on %s", v.PID, c.SocketPath)
	}
	return nil
}

// waitGone waits until nothing answers on the socket; false on timeout.
func waitGone(socketPath string, timeout time.Duration) bool {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		c, err := net.DialTimeout("unix", socketPath, 200*time.Millisecond)
		if err != nil {
			return true
		}
		c.Close()
		time.Sleep(100 * time.Millisecond)
	}
	return false
}

// StartDetached starts `exe args...` in its own session, so it outlives the
// server, with output appended to logPath.
func StartDetached(exe string, args []string, logPath string) error {
	logf, err := os.OpenFile(logPath, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
	if err != nil {
		return err
	}
	defer logf.Close()
	cmd := exec.Command(exe, args...)
	cmd.Stdout, cmd.Stderr = logf, logf
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	if err := cmd.Start(); err != nil {
		return err
	}
	return cmd.Process.Release()
}
