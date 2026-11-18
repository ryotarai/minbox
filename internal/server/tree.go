package server

import (
	"bytes"
	"io"
	"net/http"
	"strconv"
	"unicode/utf8"

	"github.com/ryotarai/minbox/internal/attach"
	"github.com/ryotarai/minbox/internal/hostfs"
	"github.com/ryotarai/minbox/internal/store"
)

// The Files pane: a session's folder as a tree (on the session's machine),
// git's status of it, and one file's contents. Every path is relative to the
// session's folder and must stay inside it.

const (
	// treeTextMax: a larger text file is not shown.
	treeTextMax = 1 << 20
	// treeImageMax: a larger image is not shown.
	treeImageMax = 10 << 20
)

// treeFS is the session's folder and its machine's files.
func (s *Server) treeFS(w http.ResponseWriter, r *http.Request) (*store.Session, hostfs.FS, bool) {
	sess, err := s.store.GetSession(r.Context(), r.PathValue("id"))
	if err != nil {
		storeError(w, err)
		return sess, nil, false
	}
	if sess.Cwd == "" {
		httpError(w, 404, "the agent has no folder")
		return sess, nil, false
	}
	fsys, err := s.sessions.fsOf(sess.HostID)
	if err != nil {
		httpError(w, 503, err.Error())
		return sess, nil, false
	}
	return sess, fsys, true
}

// GET /api/sessions/{id}/tree: the files under the session's folder.
func (s *Server) sessionTree(w http.ResponseWriter, r *http.Request) {
	sess, fsys, ok := s.treeFS(w, r)
	if !ok {
		return
	}
	t, err := fsys.ListTree(r.Context(), sess.Cwd, hostfs.TreeMaxPaths)
	if err != nil {
		if hostfs.IsNotExist(err) {
			httpError(w, 404, "the agent's folder is not there (or its host's minbox is too old to list it)")
			return
		}
		httpError(w, 502, err.Error())
		return
	}
	writeJSON(w, 200, t)
}

// GET /api/sessions/{id}/tree/status: git's status of the changed files.
func (s *Server) sessionTreeStatus(w http.ResponseWriter, r *http.Request) {
	sess, fsys, ok := s.treeFS(w, r)
	if !ok {
		return
	}
	st, err := fsys.TreeGitStatus(r.Context(), sess.Cwd)
	if err != nil {
		if hostfs.IsNotExist(err) {
			httpError(w, 404, "the agent's folder is not there (or its host's minbox is too old to list it)")
			return
		}
		httpError(w, 502, err.Error())
		return
	}
	writeJSON(w, 200, map[string]any{"entries": st})
}

// treeResolve is the real path of ?path= inside the session's folder.
func (s *Server) treeResolve(w http.ResponseWriter, r *http.Request) (hostfs.FS, string, hostfs.Info, bool) {
	sess, fsys, ok := s.treeFS(w, r)
	if !ok {
		return nil, "", hostfs.Info{}, false
	}
	rel := r.URL.Query().Get("path")
	real, err := fsys.ResolveTreePath(r.Context(), sess.Cwd, rel)
	if err != nil {
		if hostfs.IsNotExist(err) {
			httpError(w, 404, "no such file: "+rel)
		} else {
			httpError(w, 400, err.Error()) // hostfs.ErrOutside among others
		}
		return nil, "", hostfs.Info{}, false
	}
	info, err := fsys.Stat(r.Context(), real)
	if err != nil {
		httpError(w, 404, "no such file: "+rel)
		return nil, "", hostfs.Info{}, false
	}
	if !info.IsRegular() {
		httpError(w, 400, rel+" is not a file")
		return nil, "", hostfs.Info{}, false
	}
	return fsys, real, info, true
}

// treeFile is what the viewer shows: Kind is text (Text holds it), image (the
// bytes are at /tree/raw), binary, too_large or hidden (a .env file).
type treeFile struct {
	Path string `json:"path"`
	Size int64  `json:"size"`
	Kind string `json:"kind"`
	Text string `json:"text,omitempty"`
}

// GET /api/sessions/{id}/tree/file?path=: one file to show.
func (s *Server) sessionTreeFile(w http.ResponseWriter, r *http.Request) {
	fsys, real, info, ok := s.treeResolve(w, r)
	if !ok {
		return
	}
	out := treeFile{Path: r.URL.Query().Get("path"), Size: info.Size}
	if attach.IsDotenv(real) {
		out.Kind = "hidden"
		writeJSON(w, 200, out)
		return
	}
	head, err := hostfs.ReadHead(r.Context(), fsys, real, min(info.Size, treeTextMax+1))
	if err != nil {
		httpError(w, 502, err.Error())
		return
	}
	if _, _, _, img := attach.SniffImage(head); img {
		out.Kind = "image"
		if info.Size > treeImageMax {
			out.Kind = "too_large"
		}
		writeJSON(w, 200, out)
		return
	}
	switch {
	case bytes.IndexByte(head[:min(len(head), 8000)], 0) >= 0:
		out.Kind = "binary"
	case info.Size > treeTextMax:
		out.Kind = "too_large"
	case !utf8.Valid(head):
		out.Kind = "binary"
	default:
		out.Kind = "text"
		out.Text = string(head)
	}
	writeJSON(w, 200, out)
}

// GET /api/sessions/{id}/tree/raw?path=: an image's bytes (nothing else).
func (s *Server) sessionTreeRaw(w http.ResponseWriter, r *http.Request) {
	fsys, real, info, ok := s.treeResolve(w, r)
	if !ok {
		return
	}
	if info.Size > treeImageMax {
		httpError(w, 413, "the image is larger than 10 MB")
		return
	}
	if attach.IsDotenv(real) {
		httpError(w, 415, "not an image")
		return
	}
	f, err := fsys.Open(r.Context(), real)
	if err != nil {
		httpError(w, 404, err.Error())
		return
	}
	defer f.Close()
	b, err := io.ReadAll(io.LimitReader(f, treeImageMax+1))
	if err != nil {
		httpError(w, 502, err.Error())
		return
	}
	mt, _, _, img := attach.SniffImage(b[:min(len(b), attach.HeadBytes)])
	if !img {
		httpError(w, 415, "not an image")
		return
	}
	setByteHeaders(w, mt, cspImage)
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Content-Length", strconv.Itoa(len(b)))
	_, _ = w.Write(b)
}
