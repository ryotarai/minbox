package hostfs

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

// Handler serves l over HTTP under /fs/ (the host mounts it behind its token).
func Handler(l *Local) http.Handler {
	mux := http.NewServeMux()
	q := func(r *http.Request, k string) string { return r.URL.Query().Get(k) }
	mux.HandleFunc("GET /fs/env", func(w http.ResponseWriter, r *http.Request) {
		e, _ := l.Env(r.Context())
		writeJSON(w, 200, e)
	})
	mux.HandleFunc("GET /fs/stat", func(w http.ResponseWriter, r *http.Request) {
		i, err := l.Stat(r.Context(), q(r, "path"))
		if err != nil {
			writeErr(w, err)
			return
		}
		writeJSON(w, 200, i)
	})
	mux.HandleFunc("GET /fs/realpath", func(w http.ResponseWriter, r *http.Request) {
		p, err := l.EvalSymlinks(r.Context(), q(r, "path"))
		if err != nil {
			writeErr(w, err)
			return
		}
		writeJSON(w, 200, map[string]string{"path": p})
	})
	mux.HandleFunc("GET /fs/read", func(w http.ResponseWriter, r *http.Request) {
		f, err := l.Open(r.Context(), q(r, "path"))
		if err != nil {
			writeErr(w, err)
			return
		}
		defer f.Close()
		i := f.Info()
		b, _ := json.Marshal(i)
		w.Header().Set("X-File-Info", string(b))
		w.Header().Set("Content-Type", "application/octet-stream")
		http.ServeContent(w, r, "", i.ModTime, f)
	})
	mux.HandleFunc("GET /fs/sum", func(w http.ResponseWriter, r *http.Request) {
		s, err := l.Sum(r.Context(), q(r, "path"))
		if err != nil {
			writeErr(w, err)
			return
		}
		writeJSON(w, 200, map[string]string{"sha256": s})
	})
	mux.HandleFunc("POST /fs/mkdir", func(w http.ResponseWriter, r *http.Request) {
		if err := l.MkdirAll(r.Context(), q(r, "path")); err != nil {
			writeErr(w, err)
			return
		}
		writeJSON(w, 200, map[string]bool{"ok": true})
	})
	mux.HandleFunc("GET /fs/dirs", func(w http.ResponseWriter, r *http.Request) {
		v, err := l.ListDirs(r.Context(), q(r, "path"))
		if err != nil {
			writeErr(w, err)
			return
		}
		writeJSON(w, 200, v)
	})
	mux.HandleFunc("GET /fs/completions", func(w http.ResponseWriter, r *http.Request) {
		v, _ := l.Completions(r.Context(), q(r, "cwd"))
		writeJSON(w, 200, v)
	})
	mux.HandleFunc("GET /fs/gitdiff", func(w http.ResponseWriter, r *http.Request) {
		d, err := l.GitDiff(r.Context(), q(r, "cwd"), q(r, "path"), q(r, "base"))
		if err != nil {
			writeErr(w, err)
			return
		}
		writeJSON(w, 200, map[string]string{"diff": d})
	})
	mux.HandleFunc("GET /fs/transcript", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, 200, map[string]bool{"exists": l.TranscriptExists(r.Context(), q(r, "cwd"), q(r, "id"))})
	})
	mux.HandleFunc("PUT /fs/write", func(w http.ResponseWriter, r *http.Request) {
		p, err := l.WriteFile(r.Context(), q(r, "area"), q(r, "rel"), r.Body, q(r, "readonly") == "1")
		if err != nil {
			writeErr(w, err)
			return
		}
		writeJSON(w, 200, map[string]string{"path": p})
	})
	return mux
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeErr(w http.ResponseWriter, err error) {
	status := 400
	if errors.Is(err, fs.ErrNotExist) {
		status = 404
	}
	writeJSON(w, status, map[string]string{"error": err.Error()})
}

// Remote is file access on another machine, through its host.
type Remote struct {
	Base string // http://host:4849
	// Sign signs each request (the server's key); nil for none.
	Sign   func(*http.Request)
	Header http.Header // extra headers on every request (the server's protocol version)
	Client *http.Client
}

func (c *Remote) req(ctx context.Context, method, path string, args url.Values, body io.Reader) (*http.Response, error) {
	u := strings.TrimRight(c.Base, "/") + path
	if len(args) > 0 {
		u += "?" + args.Encode()
	}
	req, err := http.NewRequestWithContext(ctx, method, u, body)
	if err != nil {
		return nil, err
	}
	for k, v := range c.Header {
		req.Header[k] = v
	}
	if c.Sign != nil {
		c.Sign(req)
	}
	cl := c.Client
	if cl == nil {
		cl = http.DefaultClient
	}
	resp, err := cl.Do(req)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode >= 300 {
		defer resp.Body.Close()
		var e struct {
			Error string `json:"error"`
		}
		_ = json.NewDecoder(resp.Body).Decode(&e)
		if resp.StatusCode == 404 {
			return nil, fmt.Errorf("%s: %w", e.Error, fs.ErrNotExist)
		}
		return nil, fmt.Errorf("host: %d %s", resp.StatusCode, e.Error)
	}
	return resp, nil
}

func (c *Remote) getJSON(ctx context.Context, path string, args url.Values, out any) error {
	resp, err := c.req(ctx, "GET", path, args, nil)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	return json.NewDecoder(resp.Body).Decode(out)
}

func pathArg(p string) url.Values { return url.Values{"path": {p}} }

func (c *Remote) Env(ctx context.Context) (Env, error) {
	var e Env
	err := c.getJSON(ctx, "/fs/env", nil, &e)
	return e, err
}

func (c *Remote) Stat(ctx context.Context, path string) (Info, error) {
	var i Info
	err := c.getJSON(ctx, "/fs/stat", pathArg(path), &i)
	return i, err
}

func (c *Remote) EvalSymlinks(ctx context.Context, path string) (string, error) {
	var v struct{ Path string }
	err := c.getJSON(ctx, "/fs/realpath", pathArg(path), &v)
	return v.Path, err
}

func (c *Remote) Sum(ctx context.Context, path string) (string, error) {
	var v struct {
		SHA256 string `json:"sha256"`
	}
	err := c.getJSON(ctx, "/fs/sum", pathArg(path), &v)
	return v.SHA256, err
}

func (c *Remote) MkdirAll(ctx context.Context, path string) error {
	resp, err := c.req(ctx, "POST", "/fs/mkdir", pathArg(path), nil)
	if err != nil {
		return err
	}
	resp.Body.Close()
	return nil
}

func (c *Remote) ListDirs(ctx context.Context, path string) (Listing, error) {
	var v Listing
	err := c.getJSON(ctx, "/fs/dirs", pathArg(path), &v)
	return v, err
}

func (c *Remote) Completions(ctx context.Context, cwd string) (map[string][]Completion, error) {
	var v map[string][]Completion
	err := c.getJSON(ctx, "/fs/completions", url.Values{"cwd": {cwd}}, &v)
	return v, err
}

func (c *Remote) GitDiff(ctx context.Context, cwd, path, base string) (string, error) {
	var v struct{ Diff string }
	err := c.getJSON(ctx, "/fs/gitdiff", url.Values{"cwd": {cwd}, "path": {path}, "base": {base}}, &v)
	return v.Diff, err
}

func (c *Remote) TranscriptExists(ctx context.Context, cwd, id string) bool {
	var v struct{ Exists bool }
	if err := c.getJSON(ctx, "/fs/transcript", url.Values{"cwd": {cwd}, "id": {id}}, &v); err != nil {
		log.Printf("hostfs: transcript check for %s on the remote host failed: %v", id, err)
		return false
	}
	return v.Exists
}

func (c *Remote) WriteFile(ctx context.Context, area, rel string, r io.Reader, readOnly bool) (string, error) {
	args := url.Values{"area": {area}, "rel": {rel}}
	if readOnly {
		args.Set("readonly", "1")
	}
	resp, err := c.req(ctx, "PUT", "/fs/write", args, r)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	var v struct{ Path string }
	err = json.NewDecoder(resp.Body).Decode(&v)
	return v.Path, err
}

// Open opens a remote file: its bytes are fetched as they are read, with a
// Range request from the current offset (so seeking costs nothing).
func (c *Remote) Open(ctx context.Context, path string) (File, error) {
	resp, err := c.req(ctx, "GET", "/fs/read", pathArg(path), nil)
	if err != nil {
		return nil, err
	}
	var i Info
	_ = json.Unmarshal([]byte(resp.Header.Get("X-File-Info")), &i)
	if i.Size == 0 {
		if n, err := strconv.ParseInt(resp.Header.Get("Content-Length"), 10, 64); err == nil {
			i.Size = n
		}
	}
	return &remoteFile{c: c, ctx: ctx, path: path, info: i, body: resp.Body}, nil
}

type remoteFile struct {
	c    *Remote
	ctx  context.Context
	path string
	info Info
	off  int64
	body io.ReadCloser // positioned at off; nil after a seek
}

func (f *remoteFile) Info() Info { return f.info }

func (f *remoteFile) Read(p []byte) (int, error) {
	if f.off >= f.info.Size && f.info.Size >= 0 && f.body == nil {
		return 0, io.EOF
	}
	if f.body == nil {
		u := strings.TrimRight(f.c.Base, "/") + "/fs/read?" + pathArg(f.path).Encode()
		req, err := http.NewRequestWithContext(f.ctx, "GET", u, nil)
		if err != nil {
			return 0, err
		}
		for k, v := range f.c.Header {
			req.Header[k] = v
		}
		if f.c.Sign != nil {
			f.c.Sign(req)
		}
		req.Header.Set("Range", fmt.Sprintf("bytes=%d-", f.off))
		cl := f.c.Client
		if cl == nil {
			cl = http.DefaultClient
		}
		resp, err := cl.Do(req)
		if err != nil {
			return 0, err
		}
		if resp.StatusCode == http.StatusRequestedRangeNotSatisfiable {
			resp.Body.Close()
			return 0, io.EOF
		}
		if resp.StatusCode != http.StatusPartialContent && resp.StatusCode != http.StatusOK {
			resp.Body.Close()
			return 0, fmt.Errorf("host: read %s: %d", f.path, resp.StatusCode)
		}
		f.body = resp.Body
	}
	n, err := f.body.Read(p)
	f.off += int64(n)
	return n, err
}

func (f *remoteFile) Seek(offset int64, whence int) (int64, error) {
	var abs int64
	switch whence {
	case io.SeekStart:
		abs = offset
	case io.SeekCurrent:
		abs = f.off + offset
	case io.SeekEnd:
		abs = f.info.Size + offset
	}
	if abs < 0 {
		return 0, errors.New("negative offset")
	}
	if abs != f.off && f.body != nil {
		f.body.Close()
		f.body = nil
	}
	f.off = abs
	return abs, nil
}

func (f *remoteFile) Close() error {
	if f.body != nil {
		return f.body.Close()
	}
	return nil
}

var _ FS = (*Local)(nil)
var _ FS = (*Remote)(nil)
var _ = time.Second
