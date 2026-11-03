package termhost

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/coder/websocket"
)

// The relay carries the mod's API calls from a remote machine to the server.
// The server is the one that connects (it may be unreachable from the host):
// it opens GET /relay, a WebSocket, and answers the requests the host sends
// on it. The host takes the mod's requests on a loopback listener.

// RelayFrame is a request (host → server) or a response (server → host).
type RelayFrame struct {
	ID     string      `json:"id"`
	Method string      `json:"method,omitempty"`
	Path   string      `json:"path,omitempty"` // with the query
	Header http.Header `json:"header,omitempty"`
	Body   []byte      `json:"body,omitempty"`
	Status int         `json:"status,omitempty"`
}

type relayHub struct {
	mu      sync.Mutex
	conn    *websocket.Conn
	writeMu sync.Mutex
	pending map[string]chan RelayFrame
	seq     atomic.Int64
}

func newRelayHub() *relayHub { return &relayHub{pending: map[string]chan RelayFrame{}} }

func (rh *relayHub) close() {
	rh.mu.Lock()
	c := rh.conn
	rh.conn = nil
	rh.mu.Unlock()
	if c != nil {
		c.Close(websocket.StatusGoingAway, "host stopping")
	}
}

// serveWS is the server's end: the latest connection wins.
func (rh *relayHub) serveWS(w http.ResponseWriter, r *http.Request) {
	conn, err := websocket.Accept(w, r, nil)
	if err != nil {
		return
	}
	conn.SetReadLimit(64 << 20)
	rh.mu.Lock()
	old := rh.conn
	rh.conn = conn
	rh.mu.Unlock()
	if old != nil {
		old.Close(websocket.StatusGoingAway, "replaced")
	}
	defer func() {
		rh.mu.Lock()
		if rh.conn == conn {
			rh.conn = nil
		}
		rh.mu.Unlock()
		conn.CloseNow()
	}()
	for {
		_, data, err := conn.Read(r.Context())
		if err != nil {
			return
		}
		var f RelayFrame
		if json.Unmarshal(data, &f) != nil {
			continue
		}
		rh.mu.Lock()
		ch := rh.pending[f.ID]
		delete(rh.pending, f.ID)
		rh.mu.Unlock()
		if ch != nil {
			ch <- f
		}
	}
}

// ServeHTTP takes a mod's request (on the host's loopback listener) and
// relays it to the server.
func (rh *relayHub) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	host, _, _ := net.SplitHostPort(r.RemoteAddr)
	if ip := net.ParseIP(host); ip == nil || !ip.IsLoopback() {
		httpError(w, 403, "loopback only")
		return
	}
	if !strings.HasPrefix(r.URL.Path, "/api/agent/") {
		httpError(w, 404, "not found")
		return
	}
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 8<<20))
	if err != nil {
		httpError(w, 413, err.Error())
		return
	}
	rh.mu.Lock()
	conn := rh.conn
	rh.mu.Unlock()
	if conn == nil {
		httpError(w, 503, "the minbox server is not connected to this host")
		return
	}
	id := strconv.FormatInt(rh.seq.Add(1), 10)
	ch := make(chan RelayFrame, 1)
	rh.mu.Lock()
	rh.pending[id] = ch
	rh.mu.Unlock()
	defer func() {
		rh.mu.Lock()
		delete(rh.pending, id)
		rh.mu.Unlock()
	}()
	hdr := http.Header{}
	for _, k := range []string{"Authorization", "Content-Type"} {
		if v := r.Header.Get(k); v != "" {
			hdr.Set(k, v)
		}
	}
	req := RelayFrame{ID: id, Method: r.Method, Path: r.URL.RequestURI(), Header: hdr, Body: body}
	b, _ := json.Marshal(req)
	rh.writeMu.Lock()
	err = conn.Write(r.Context(), websocket.MessageText, b)
	rh.writeMu.Unlock()
	if err != nil {
		httpError(w, 503, "the minbox server is not connected to this host")
		return
	}
	select {
	case resp := <-ch:
		for k, v := range resp.Header {
			w.Header()[k] = v
		}
		if resp.Status == 0 {
			resp.Status = 502
		}
		w.WriteHeader(resp.Status)
		_, _ = w.Write(resp.Body)
	case <-r.Context().Done():
	case <-time.After(60 * time.Second):
		httpError(w, 504, "the minbox server did not answer")
	}
}

// Relay is the server's end of a host's relay: it connects and answers the
// requests with handler until ctx ends or the connection drops.
func (c *Client) Relay(ctx context.Context, handler http.Handler) error {
	conn, err := c.dialWS(ctx, "/relay")
	if err != nil {
		return err
	}
	defer conn.CloseNow()
	conn.SetReadLimit(64 << 20)
	var writeMu sync.Mutex
	for {
		_, data, err := conn.Read(ctx)
		if err != nil {
			return err
		}
		var f RelayFrame
		if json.Unmarshal(data, &f) != nil || f.ID == "" {
			continue
		}
		go func(f RelayFrame) {
			resp := RelayFrame{ID: f.ID, Status: 502}
			if !strings.HasPrefix(f.Path, "/api/agent/") {
				resp.Status = 404
			} else if req, err := http.NewRequestWithContext(ctx, f.Method, "http://127.0.0.1"+f.Path, bytes.NewReader(f.Body)); err == nil {
				req.Header = f.Header
				if req.Header == nil {
					req.Header = http.Header{}
				}
				req.Host = "127.0.0.1"
				req.RemoteAddr = "127.0.0.1:0"
				rec := httptest.NewRecorder()
				handler.ServeHTTP(rec, req)
				resp.Status = rec.Code
				resp.Header = rec.Header()
				resp.Body = rec.Body.Bytes()
			}
			b, _ := json.Marshal(resp)
			writeMu.Lock()
			_ = conn.Write(ctx, websocket.MessageText, b)
			writeMu.Unlock()
		}(f)
	}
}

// ServeRelay serves the mods of this machine on a loopback listener, writing
// its URL to serverFile (the file the mod reads to find "the server").
func (h *Host) ServeRelay(ctx context.Context, serverFile string) error {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return err
	}
	url := "http://" + ln.Addr().String()
	b, _ := json.Marshal(map[string]any{"url": url, "relay": true})
	if err := writeFileAtomic(serverFile, b); err != nil {
		ln.Close()
		return fmt.Errorf("server file: %w", err)
	}
	srv := &http.Server{Handler: h.relay}
	go func() {
		<-ctx.Done()
		srv.Close()
	}()
	err = srv.Serve(ln)
	if errors.Is(err, http.ErrServerClosed) {
		return nil
	}
	return err
}
