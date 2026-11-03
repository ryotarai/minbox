package server

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/ryotarai/minbox/internal/attach"
	"github.com/ryotarai/minbox/internal/hostfs"
	"github.com/ryotarai/minbox/internal/store"
)

// Attachments, the way Plannotator Inbox has them
// (docs/research/plannotator-attachments.md): any regular file of any size,
// kept as sent (a blob) and shown as it is now; folders and .env files refused.

const (
	htmlDocMaxBytes    = 2 << 20  // nested HTML documents and linked pages
	imageMaxBytes      = 10 << 20 // body / markdown images
	imageMaxPixels     = 50_000_000
	inlineImagesMax    = 64
	uploadMaxBytes     = 100 << 20
	markupMaxBytes     = 128 << 20
	embedMaxBytes      = 512 * 1024
	embedStoreMaxBytes = 64 << 20
	embedStoreMaxCount = 500
	searchTextMaxBytes = 1 << 20
)

const (
	cspText  = "sandbox"
	cspImage = "sandbox; default-src 'none'; style-src 'unsafe-inline'"
	cspHTML  = "sandbox allow-scripts allow-modals; connect-src 'none'"
	cspEmbed = "sandbox allow-scripts allow-forms; default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' data: blob: https:; style-src 'unsafe-inline' data: https:; img-src data: blob: https:; font-src data: https:; media-src data: blob: https:; connect-src https:; worker-src blob: https:; frame-src https:; object-src 'none'; manifest-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'self'"
)

// fileState is the server's in-memory state for attachments: folder tokens
// for HTML assets, and built ```html embeds.
type fileState struct {
	mu          sync.Mutex
	tokenOf     map[string]string    // host + folder -> token
	folderOf    map[string]folderRef // token -> host, folder
	embeds      map[string][]byte
	embedOrder  []string
	embedsBytes int
}

func newFileState() *fileState {
	return &fileState{tokenOf: map[string]string{}, folderOf: map[string]folderRef{}, embeds: map[string][]byte{}}
}

type folderRef struct{ host, folder string }

// hostOfAttachment is the host id of the attachment's session.
func (s *Server) hostOfAttachment(ctx context.Context, a *store.Attachment) string {
	h, _, _ := s.store.HostOfThread(ctx, a.ThreadID)
	return h
}

// ---- snapshot (agent attachments) ----

const dotenvRefusal = ".env files are never attached (they hold secrets)."

// snapshotFile keeps the version of the file the agent sends, in the blob
// store. i is its index in `attachments` (for messages).
func (s *Server) snapshotFile(ctx context.Context, fsys hostfs.FS, home, cwd, p string, i int) (*attachmentSnapshot, error) {
	field := fmt.Sprintf("attachments[%d]: ", i)
	if strings.TrimSpace(p) == "" {
		return nil, errors.New(field + "a file path is required.")
	}
	named := hostfs.ResolveIn(home, cwd, p)
	if attach.IsDotenv(named) {
		return nil, errors.New(field + filepath.Base(named) + ": " + dotenvRefusal)
	}
	real, err := fsys.EvalSymlinks(ctx, named)
	if err != nil {
		return nil, errors.New(field + named + ": no such file.")
	}
	if attach.IsDotenv(real) {
		return nil, fmt.Errorf("%s%s resolves to %s: %s", field, filepath.Base(named), filepath.Base(real), dotenvRefusal)
	}
	fi, err := fsys.Stat(ctx, real)
	if err != nil {
		return nil, errors.New(field + named + ": no such file.")
	}
	if fi.IsDir() {
		return nil, errors.New(field + named + ": a folder. Attach the files in it, or a zip of them.")
	}
	if !fi.IsRegular() {
		return nil, errors.New(field + named + ": not a regular file.")
	}
	b, err := s.putBlobFS(ctx, fsys, real)
	if err != nil {
		return nil, fmt.Errorf("%s%s: %v", field, named, err)
	}
	a := s.fileAttachment(filepath.Base(real), real, b)
	// The name it was attached by, when that is a link to it (not merely a
	// path through a linked folder such as macOS's /var).
	if filepath.Join(realDirFS(ctx, fsys, filepath.Dir(named)), filepath.Base(named)) != real {
		a.NamedPath = &named
	}
	mt := fi.ModTime
	a.SentMtime = &mt
	return &attachmentSnapshot{att: a}, nil
}

// fileAttachment is the record for a stored blob.
func (s *Server) fileAttachment(name, path string, b blob) store.Attachment {
	info := s.classify(name, b)
	a := store.Attachment{Kind: store.AttachmentFile, Type: info.Type, Name: name, Path: path, Size: b.Size, SHA256: b.Sum,
		Width: info.Width, Height: info.Height, DurationMs: info.DurationMs, Mime: info.MediaType}
	if a.Mime == "" {
		a.Mime = mimeOf(name, b.Head, info.Type)
	}
	if attach.IsTextType(info.Type) || info.Type == attach.Code {
		a.SearchText = searchText(b.Head, s.blobPath(b.Sum), b.Size)
	}
	return a
}

func searchText(head []byte, path string, size int64) string {
	if size <= int64(len(head)) {
		return string(head)
	}
	if t, err := readHead(path, searchTextMaxBytes); err == nil {
		return strings.ToValidUTF8(string(t), "")
	}
	return string(head)
}

// mimeOf: the media type a stored file is served with.
func mimeOf(name string, head []byte, typ string) string {
	switch typ {
	case attach.Markdown:
		return "text/markdown"
	case attach.HTML:
		return "text/html"
	case attach.Text, attach.Code, attach.Mermaid, attach.Graphviz:
		return "text/plain"
	}
	if t := mime.TypeByExtension(strings.ToLower(filepath.Ext(name))); t != "" {
		t, _, _ = strings.Cut(t, ";")
		return t
	}
	t, _, _ := strings.Cut(http.DetectContentType(head), ";")
	return t
}

// ---- reading attachments ----

type nopCloser struct{ *bytes.Reader }

func (nopCloser) Close() error { return nil }

// sentReader opens the version that was sent: the blob, or (older rows) the
// bytes kept in the database.
func (s *Server) sentReader(a *store.Attachment, content []byte) (io.ReadSeekCloser, error) {
	if len(content) > 0 || a.SHA256 == "" {
		return nopCloser{bytes.NewReader(content)}, nil
	}
	return os.Open(s.blobPath(a.SHA256))
}

// unavailable says why the file as it is now cannot be shown (nil: it can).
type unavailable struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

// currentFile checks the file on disk still is what was attached: the same
// real path, a regular file, not a dotenv, and (for media) still that kind.
func currentFile(ctx context.Context, fsys hostfs.FS, a *store.Attachment) (hostfs.Info, *unavailable) {
	missing := &unavailable{"attachment_missing", a.Name + " is no longer on disk."}
	changedType := func(msg string) *unavailable { return &unavailable{"attachment_changed_type", msg} }
	none := hostfs.Info{}
	if fsys == nil {
		return none, &unavailable{"attachment_missing", a.Name + " is on a host that is not connected."}
	}
	real, err := fsys.EvalSymlinks(ctx, a.Path)
	if err != nil {
		return none, missing
	}
	if real != a.Path {
		return none, changedType(a.Name + " now leads somewhere else.")
	}
	if a.NamedPath != nil {
		if r, err := fsys.EvalSymlinks(ctx, *a.NamedPath); err != nil || r != a.Path {
			return none, changedType(a.Name + " now leads somewhere else.")
		}
	}
	fi, err := fsys.Stat(ctx, real)
	if err != nil {
		return none, missing
	}
	if !fi.IsRegular() || attach.IsDotenv(real) {
		return none, changedType(a.Name + " is no longer a regular file.")
	}
	switch a.Type {
	case attach.Image, attach.PDF, attach.Video:
		head, err := hostfs.ReadHead(ctx, fsys, real, attach.HeadBytes)
		if err != nil {
			return none, missing
		}
		ok := true
		switch a.Type {
		case attach.Image:
			_, _, _, ok = attach.SniffImage(head)
			if !ok {
				return none, changedType(a.Name + " is no longer an image.")
			}
		case attach.PDF:
			ok = attach.IsPDF(head)
		case attach.Video:
			_, ok = attach.SniffVideo(head, "")
		}
		if !ok {
			return none, changedType(a.Name + " is no longer that kind of file.")
		}
	}
	return fi, nil
}

// attFS is file access on the machine an attachment's session runs on (nil
// while that host is away).
func (s *Server) attFS(ctx context.Context, a *store.Attachment) hostfs.FS {
	host, _, err := s.store.HostOfThread(ctx, a.ThreadID)
	if err != nil {
		return nil
	}
	f, err := s.sessions.fsOf(host)
	if err != nil {
		return nil
	}
	return f
}

// realDirFS is a folder's real path on that machine ("" stays "").
func realDirFS(ctx context.Context, fsys hostfs.FS, dir string) string {
	if dir == "" {
		return ""
	}
	if r, err := fsys.EvalSymlinks(ctx, dir); err == nil {
		return r
	}
	return dir
}

func (s *Server) loadAttachment(w http.ResponseWriter, r *http.Request) (*store.Attachment, []byte, string, bool) {
	a, content, rv, err := s.store.GetAttachment(r.Context(), r.PathValue("id"))
	if err != nil {
		storeError(w, err)
		return nil, nil, "", false
	}
	return a, content, rv, true
}

func wantSent(w http.ResponseWriter, r *http.Request) (bool, bool) {
	switch v := r.URL.Query().Get("v"); v {
	case "", "current":
		return false, true
	case "sent":
		return true, true
	default:
		httpError(w, 422, "version must be current or sent")
		return false, false
	}
}

// openVersion opens the sent or the current version (current falls back to
// nothing when unavailable).
func (s *Server) openVersion(ctx context.Context, a *store.Attachment, content []byte, sent bool) (io.ReadSeekCloser, time.Time, *unavailable, error) {
	if !sent {
		fsys := s.attFS(ctx, a)
		fi, un := currentFile(ctx, fsys, a)
		if un != nil {
			return nil, time.Time{}, un, nil
		}
		f, err := fsys.Open(ctx, a.Path)
		if err != nil {
			return nil, time.Time{}, &unavailable{"attachment_missing", a.Name + " is no longer on disk."}, nil
		}
		return f, fi.ModTime, nil, nil
	}
	f, err := s.sentReader(a, content)
	mt := a.CreatedAt
	if a.SentMtime != nil {
		mt = *a.SentMtime
	}
	return f, mt, nil, err
}

// readAllCapped reads at most max bytes; ok is false when there was more.
func readAllCapped(r io.Reader, max int64) ([]byte, bool, error) {
	b, err := io.ReadAll(io.LimitReader(r, max+1))
	if err != nil {
		return nil, false, err
	}
	if int64(len(b)) > max {
		return b[:max], false, nil
	}
	return b, true, nil
}

func (s *Server) getAttachment(w http.ResponseWriter, r *http.Request) {
	a, content, rv, ok := s.loadAttachment(w, r)
	if !ok {
		return
	}
	out := map[string]any{"id": a.ID, "thread_id": a.ThreadID, "message_id": a.MessageID, "author": a.Author, "kind": a.Kind, "type": a.Type,
		"name": a.Name, "path": a.Path, "named_path": a.NamedPath, "mime": a.Mime, "size": a.Size, "sent_mtime": a.SentMtime,
		"created_at": a.CreatedAt, "inline": a.Inline, "exists": false, "changed": false, "modified_at": nil, "unavailable": nil}
	if a.Width > 0 {
		out["width"], out["height"] = a.Width, a.Height
	}
	if a.DurationMs > 0 {
		out["duration_ms"] = a.DurationMs
	}
	if a.Ref != "" {
		out["ref"] = a.Ref
	}
	if a.Kind == store.AttachmentReview {
		out["exists"] = true
		out["review"] = json.RawMessage(rv)
		writeJSON(w, 200, out)
		return
	}
	text := attach.IsTextType(a.Type)
	if text {
		if f, err := s.sentReader(a, content); err == nil {
			if b, _, err := readAllCapped(f, attach.ViewMaxBytes); err == nil {
				out["text_sent"] = string(b)
			}
			f.Close()
		}
	}
	fsys := s.attFS(r.Context(), a)
	fi, un := currentFile(r.Context(), fsys, a)
	if un != nil {
		out["unavailable"] = un
		out["exists"] = un.Code != "attachment_missing"
	} else {
		out["exists"] = true
		out["modified_at"] = fi.ModTime
		out["current_size"] = fi.Size
		if sum, err := fsys.Sum(r.Context(), a.Path); err == nil {
			if a.SHA256 != "" {
				out["changed"] = sum != a.SHA256
			} else { // an older row: compare with the bytes kept
				cs := sha256.Sum256(content)
				out["changed"] = hex.EncodeToString(cs[:]) != sum
			}
		}
		if text {
			if fi.Size > attach.ViewMaxBytes {
				out["too_large"] = true
			} else if b, err := hostfs.ReadFile(r.Context(), fsys, a.Path); err == nil {
				out["text_current"] = string(b)
			}
		}
	}
	writeJSON(w, 200, out)
}

func setByteHeaders(w http.ResponseWriter, ct, csp string) {
	w.Header().Set("Content-Type", ct)
	w.Header().Set("Content-Security-Policy", csp)
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Cross-Origin-Resource-Policy", "same-origin")
}

// rawAttachment serves the bytes to look at: text as text/plain (never run on
// this origin), images and videos with their type sniffed from the bytes.
func (s *Server) rawAttachment(w http.ResponseWriter, r *http.Request) {
	a, content, rv, ok := s.loadAttachment(w, r)
	if !ok {
		return
	}
	if a.Kind == store.AttachmentReview {
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, rv)
		return
	}
	sent, ok := wantSent(w, r)
	if !ok {
		return
	}
	f, mt, un, err := s.openVersion(r.Context(), a, content, sent)
	if un != nil {
		httpError(w, 404, un.Message)
		return
	}
	if err != nil {
		httpError(w, 404, "the version sent is missing: "+err.Error())
		return
	}
	defer f.Close()
	head := make([]byte, attach.HeadBytes)
	n, _ := io.ReadFull(f, head)
	head = head[:n]
	_, _ = f.Seek(0, io.SeekStart)
	switch {
	case attach.IsTextType(a.Type):
		setByteHeaders(w, "text/plain; charset=utf-8", cspText)
		w.Header().Set("Content-Disposition", "inline")
		w.Header().Set("Cache-Control", "no-store")
	case a.Type == attach.Image:
		mt2, _, _, ok := attach.SniffImage(head)
		if !ok {
			httpError(w, 415, a.Name+" is no longer an image.")
			return
		}
		setByteHeaders(w, mt2, cspImage)
		if sent && a.SHA256 != "" {
			w.Header().Set("ETag", `"`+a.SHA256+`"`)
		}
		if a.Width > 0 {
			w.Header().Set("X-Image-Width", strconv.Itoa(a.Width))
			w.Header().Set("X-Image-Height", strconv.Itoa(a.Height))
		}
		w.Header().Set("Cache-Control", "private, no-cache")
	case a.Type == attach.Video:
		v, ok := attach.SniffVideo(head, "")
		if !ok {
			httpError(w, 415, a.Name+" is no longer a video.")
			return
		}
		setByteHeaders(w, v.MediaType, cspText)
	default:
		setByteHeaders(w, "application/octet-stream", cspText)
		w.Header().Set("Cache-Control", "no-store")
	}
	http.ServeContent(w, r, "", mt, f) // Range requests: video seeks
}

// downloadAttachment serves the file as a download.
func (s *Server) downloadAttachment(w http.ResponseWriter, r *http.Request) {
	a, content, _, ok := s.loadAttachment(w, r)
	if !ok {
		return
	}
	if a.Kind == store.AttachmentReview {
		httpError(w, 400, "a guided review is not a file")
		return
	}
	sent, ok := wantSent(w, r)
	if !ok {
		return
	}
	f, mt, un, err := s.openVersion(r.Context(), a, content, sent)
	if un != nil {
		httpError(w, 404, un.Message)
		return
	}
	if err != nil {
		httpError(w, 404, err.Error())
		return
	}
	defer f.Close()
	ct := "application/octet-stream"
	if a.Type == attach.PDF {
		head := make([]byte, 1024)
		n, _ := io.ReadFull(f, head)
		if attach.IsPDF(head[:n]) {
			ct = "application/pdf"
		}
		_, _ = f.Seek(0, io.SeekStart)
	}
	setByteHeaders(w, ct, cspText)
	w.Header().Set("Content-Disposition", contentDisposition(a.Name))
	w.Header().Set("Cache-Control", "no-store")
	http.ServeContent(w, r, "", mt, f)
}

func contentDisposition(name string) string {
	ascii := strings.Map(func(r rune) rune {
		if r < 0x20 || r > 0x7e || r == '"' || r == '\\' {
			return '_'
		}
		return r
	}, name)
	return fmt.Sprintf(`attachment; filename="%s"; filename*=UTF-8''%s`, ascii, url.PathEscape(name))
}

// viewAttachment: the text of a text-read type; for HTML also the document
// to put in the sandboxed frame, its relative URLs loading from its folder.
func (s *Server) viewAttachment(w http.ResponseWriter, r *http.Request) {
	a, content, _, ok := s.loadAttachment(w, r)
	if !ok {
		return
	}
	if !attach.IsTextType(a.Type) {
		httpError(w, 400, "only text files have a view")
		return
	}
	sent, ok := wantSent(w, r)
	if !ok {
		return
	}
	f, _, un, err := s.openVersion(r.Context(), a, content, sent)
	if un != nil {
		f, _, _, err = s.openVersion(r.Context(), a, content, true)
		sent = true
	}
	if err != nil {
		httpError(w, 404, err.Error())
		return
	}
	defer f.Close()
	b, whole, err := readAllCapped(f, attach.ViewMaxBytes)
	if err != nil {
		storeError(w, err)
		return
	}
	if !whole {
		httpError(w, 413, a.Name+" is too large to show here (over 16 MB). Download it instead.")
		return
	}
	version := "current"
	if sent {
		version = a.SHA256
	}
	out := map[string]any{"version": version, "text": string(b), "html": nil, "unavailable": un}
	if a.Type == attach.HTML {
		out["html"] = s.rewriteHTML(string(b), s.hostOfAttachment(r.Context(), a), filepath.Dir(a.Path))
	}
	writeJSON(w, 200, out)
}

var (
	headTagRe = regexp.MustCompile(`(?i)<head(?:\s[^>]*)?>`)
	htmlTagRe = regexp.MustCompile(`(?i)<html(?:\s[^>]*)?>`)
)

// rewriteHTML puts a <base> in the document so its relative images, styles,
// scripts and frames load from its own folder (through a folder token).
func (s *Server) rewriteHTML(doc, host, folder string) string {
	base := `<base href="/api/html-assets/` + s.folderToken(host, folder) + `/">`
	if loc := headTagRe.FindStringIndex(doc); loc != nil {
		return doc[:loc[1]] + base + doc[loc[1]:]
	}
	if loc := htmlTagRe.FindStringIndex(doc); loc != nil {
		return doc[:loc[1]] + "<head>" + base + "</head>" + doc[loc[1]:]
	}
	return base + doc
}

func (s *Server) folderToken(host, folder string) string {
	s.files.mu.Lock()
	defer s.files.mu.Unlock()
	key := host + "\x00" + folder
	if t, ok := s.files.tokenOf[key]; ok {
		return t
	}
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	t := hex.EncodeToString(b)
	s.files.tokenOf[key] = t
	s.files.folderOf[t] = folderRef{host, folder}
	return t
}

// htmlAssets serves the files an attached HTML page loads from its folder.
func (s *Server) htmlAssets(w http.ResponseWriter, r *http.Request) {
	s.files.mu.Lock()
	ref, ok := s.files.folderOf[r.PathValue("token")]
	s.files.mu.Unlock()
	if !ok {
		httpError(w, 404, "unknown folder (reload the page)")
		return
	}
	folder := ref.folder
	ctx := r.Context()
	fsys, err := s.sessions.fsOf(ref.host)
	if err != nil {
		httpError(w, 503, err.Error())
		return
	}
	rel := r.PathValue("path")
	for _, seg := range strings.Split(rel, "/") {
		if seg == "" || strings.HasPrefix(seg, ".") || attach.IsDotenv(seg) {
			httpError(w, 403, "that file is not served")
			return
		}
	}
	p := filepath.Join(folder, filepath.FromSlash(rel))
	real, err := fsys.EvalSymlinks(ctx, p)
	if err != nil {
		httpError(w, 404, "no such file")
		return
	}
	if real != folder && !strings.HasPrefix(real, folder+string(filepath.Separator)) {
		httpError(w, 403, "that file is outside the page's folder")
		return
	}
	if attach.IsDotenv(real) {
		httpError(w, 403, "that file is not served")
		return
	}
	f, err := fsys.Open(ctx, real)
	if err != nil {
		httpError(w, 404, "no such file")
		return
	}
	defer f.Close()
	fi := f.Info()
	if !fi.IsRegular() {
		httpError(w, 404, "no such file")
		return
	}
	ct := mime.TypeByExtension(strings.ToLower(filepath.Ext(real)))
	if ct == "" {
		head := make([]byte, 512)
		n, _ := io.ReadFull(f, head)
		ct = http.DetectContentType(head[:n])
		_, _ = f.Seek(0, io.SeekStart)
	}
	if strings.HasPrefix(ct, "text/html") && fi.Size > htmlDocMaxBytes {
		httpError(w, 413, "that page is larger than 2 MB")
		return
	}
	w.Header().Set("Content-Type", ct)
	w.Header().Set("Content-Security-Policy", cspHTML)
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Referrer-Policy", "no-referrer")
	w.Header().Set("Cache-Control", "no-store")
	http.ServeContent(w, r, "", fi.ModTime, f)
}

// ---- images a markdown file or a message shows ----

var imageExtRe = regexp.MustCompile(`(?i)\.(?:png|jpe?g|gif|webp|svg|avif|bmp|ico|apng)$`)

func isRemoteRef(src string) bool {
	l := strings.ToLower(strings.TrimSpace(src))
	return strings.HasPrefix(l, "http:") || strings.HasPrefix(l, "https:") || strings.HasPrefix(l, "//") ||
		strings.HasPrefix(l, `\\`) || strings.HasPrefix(l, "data:") || strings.HasPrefix(l, "blob:")
}

// imageRefusal checks a local image against the body-image rules; "" = fine.
// base is the folder relative paths resolve against (and inside which
// hidden folders are allowed).
func imageRefusal(ctx context.Context, fsys hostfs.FS, path, base string) (reason string, notYet bool) {
	if !imageExtRe.MatchString(path) {
		return "not an image (png, jpg, gif, webp, svg, avif, bmp, ico)", false
	}
	hidden := "a .env file, or in a hidden folder of the home folder such as ~/.ssh"
	if attach.IsDotenv(path) {
		return hidden, false
	}
	real, err := fsys.EvalSymlinks(ctx, path)
	if err != nil {
		return "does not exist yet; it will show if it is written there later", true
	}
	if attach.IsDotenv(real) {
		return hidden, false
	}
	rbase := realDirFS(ctx, fsys, base)
	inside := rbase != "" && strings.HasPrefix(real, rbase+string(filepath.Separator))
	if !inside {
		for _, seg := range strings.Split(real, string(filepath.Separator)) {
			if strings.HasPrefix(seg, ".") && seg != "." && seg != ".." {
				return hidden, false
			}
		}
	}
	fi, err := fsys.Stat(ctx, real)
	if err != nil {
		return "does not exist yet; it will show if it is written there later", true
	}
	if !fi.IsRegular() {
		return "not a readable file (a folder, a pipe or a device)", false
	}
	if fi.Size > imageMaxBytes {
		return "over 10 MB or 50 megapixels", false
	}
	head, err := hostfs.ReadHead(ctx, fsys, real, attach.HeadBytes)
	if err != nil {
		return "not a readable file (a folder, a pipe or a device)", false
	}
	_, w, h, ok := attach.SniffImage(head)
	if !ok {
		return "not an image (png, jpg, gif, webp, svg, avif, bmp, ico)", false
	}
	if w*h > imageMaxPixels {
		return "over 10 MB or 50 megapixels", false
	}
	return "", false
}

func serveImageFile(w http.ResponseWriter, r *http.Request, fsys hostfs.FS, path string) {
	f, err := fsys.Open(r.Context(), path)
	if err != nil {
		httpError(w, 404, "no such image")
		return
	}
	defer f.Close()
	head := make([]byte, attach.HeadBytes)
	n, _ := io.ReadFull(f, head)
	mt, _, _, ok := attach.SniffImage(head[:n])
	if !ok {
		httpError(w, 415, "not an image")
		return
	}
	_, _ = f.Seek(0, io.SeekStart)
	setByteHeaders(w, mt, cspImage)
	w.Header().Set("Cache-Control", "private, no-cache")
	http.ServeContent(w, r, "", f.Info().ModTime, f)
}

// markdownImage serves an image a markdown attachment references, relative
// to its own folder.
func (s *Server) markdownImage(w http.ResponseWriter, r *http.Request) {
	a, content, _, ok := s.loadAttachment(w, r)
	if !ok {
		return
	}
	if a.Type != attach.Markdown && a.Type != attach.Text {
		httpError(w, 400, "only markdown shows images")
		return
	}
	ref := r.URL.Query().Get("path")
	if ref == "" || len(ref) > 2048 || isRemoteRef(ref) {
		httpError(w, 400, "a local image path is required")
		return
	}
	sent, ok := wantSent(w, r)
	if !ok {
		return
	}
	// Only images the document itself references.
	f, _, _, err := s.openVersion(r.Context(), a, content, sent)
	if f == nil || err != nil {
		f, _, _, err = s.openVersion(r.Context(), a, content, true)
	}
	if err != nil {
		httpError(w, 404, err.Error())
		return
	}
	doc, _, _ := readAllCapped(f, attach.ViewMaxBytes)
	f.Close()
	if !containsRef(string(doc), ref) {
		httpError(w, 403, "the document does not show that image")
		return
	}
	folder := filepath.Dir(a.Path)
	p := ref
	if !filepath.IsAbs(p) {
		p = filepath.Join(folder, filepath.FromSlash(p))
	}
	fsys := s.attFS(r.Context(), a)
	if fsys == nil {
		httpError(w, 503, "the host of that file is not connected")
		return
	}
	if reason, _ := imageRefusal(r.Context(), fsys, p, folder); reason != "" {
		httpError(w, 403, filepath.Base(p)+": "+reason)
		return
	}
	real, _ := fsys.EvalSymlinks(r.Context(), p)
	serveImageFile(w, r, fsys, real)
}

func containsRef(doc, ref string) bool {
	for _, src := range imageRefs(doc) {
		if src == ref {
			return true
		}
	}
	return false
}

var (
	fenceRe   = regexp.MustCompile("(?ms)^[ \t]*(```|~~~).*?^[ \t]*(```|~~~)[ \t]*$")
	inlineRe  = regexp.MustCompile("`[^`\n]*`")
	mdImageRe = regexp.MustCompile(`!\[[^\]]*\]\(([^)]+)\)`)
	imgTagRe  = regexp.MustCompile("(?i)<img\\b[^>]*?\\ssrc\\s*=\\s*(?:\"([^\"]*)\"|'([^']*)'|([^\\s\"'=<>`]+))")
)

// imageRefs lists the local image sources a markdown body shows, in order,
// once each (not in code; not remote, data: or blob:).
func imageRefs(body string) []string {
	body = fenceRe.ReplaceAllString(body, "")
	body = inlineRe.ReplaceAllString(body, "")
	var out []string
	seen := map[string]bool{}
	add := func(src string) {
		src = strings.TrimSpace(src)
		// ![alt](path "title"): the title is not part of the path.
		if i := strings.Index(src, ` "`); i > 0 {
			src = src[:i]
		}
		src = strings.Trim(src, "<>")
		if src == "" || isRemoteRef(src) || seen[src] {
			return
		}
		seen[src] = true
		out = append(out, src)
	}
	type hit struct {
		at  int
		src string
	}
	var hits []hit
	for _, m := range mdImageRe.FindAllStringSubmatchIndex(body, -1) {
		hits = append(hits, hit{m[0], body[m[2]:m[3]]})
	}
	for _, m := range imgTagRe.FindAllStringSubmatchIndex(body, -1) {
		for g := 1; g <= 3; g++ {
			if m[2*g] >= 0 {
				hits = append(hits, hit{m[0], htmlUnescape(body[m[2*g]:m[2*g+1]])})
				break
			}
		}
	}
	for i := 1; i < len(hits); i++ { // by position
		for j := i; j > 0 && hits[j].at < hits[j-1].at; j-- {
			hits[j], hits[j-1] = hits[j-1], hits[j]
		}
	}
	for _, h := range hits {
		add(h.src)
	}
	return out
}

func htmlUnescape(s string) string {
	r := strings.NewReplacer("&amp;", "&", "&lt;", "<", "&gt;", ">", "&quot;", `"`, "&#39;", "'", "&#x27;", "'")
	return r.Replace(s)
}

type imageNotShown struct {
	Ref    string `json:"ref"`
	Reason string `json:"reason"`
	NotYet bool   `json:"not_yet,omitempty"`
}

// captureInlineImages keeps the images an agent's body shows, as they are now.
func (s *Server) captureInlineImages(ctx context.Context, fsys hostfs.FS, home, cwd, body string) ([]store.Attachment, []imageNotShown) {
	var atts []store.Attachment
	notShown := []imageNotShown{}
	for _, ref := range imageRefs(body) {
		if len(atts) >= inlineImagesMax {
			break
		}
		p := ref
		if strings.HasPrefix(p, "~/") || !filepath.IsAbs(p) {
			p = hostfs.ResolveIn(home, cwd, p)
		}
		if reason, notYet := imageRefusal(ctx, fsys, p, cwd); reason != "" {
			notShown = append(notShown, imageNotShown{ref, reason, notYet})
			continue
		}
		real, _ := fsys.EvalSymlinks(ctx, p)
		b, err := s.putBlobFS(ctx, fsys, real)
		if err != nil {
			notShown = append(notShown, imageNotShown{ref, "not a readable file (a folder, a pipe or a device)", false})
			continue
		}
		a := s.fileAttachment(filepath.Base(real), real, b)
		if a.Type != attach.Image {
			notShown = append(notShown, imageNotShown{ref, "not an image (png, jpg, gif, webp, svg, avif, bmp, ico)", false})
			continue
		}
		if fi, err := fsys.Stat(ctx, real); err == nil {
			mt := fi.ModTime
			a.SentMtime = &mt
		}
		a.Inline, a.Ref = true, ref
		atts = append(atts, a)
	}
	return atts, notShown
}

// messageImage serves an image a message's body showed, as captured.
func (s *Server) messageImage(w http.ResponseWriter, r *http.Request) {
	ref := r.URL.Query().Get("path")
	a, err := s.store.InlineImage(r.Context(), r.PathValue("id"), ref)
	if err != nil {
		httpError(w, 404, "that message shows no such image")
		return
	}
	serveImageFile(w, r, s.sessions.localFS, s.blobPath(a.SHA256))
}

// linkedPage: a sibling .md/.mdx/.html of a markdown or HTML attachment,
// read-only (it is not attached, so comments are off).
func (s *Server) linkedPage(w http.ResponseWriter, r *http.Request) {
	a, _, _, ok := s.loadAttachment(w, r)
	if !ok {
		return
	}
	rel := r.URL.Query().Get("path")
	if u, err := url.PathUnescape(rel); err == nil {
		rel = u
	}
	rel, _, _ = strings.Cut(rel, "#")
	rel, _, _ = strings.Cut(rel, "?")
	rel = strings.TrimPrefix(rel, "./")
	if rel == "" || strings.ContainsAny(rel, `/\`) || strings.HasPrefix(rel, ".") || attach.IsDotenv(rel) {
		httpError(w, 403, "only pages in the same folder open here")
		return
	}
	if !regexp.MustCompile(`(?i)\.(?:mdx?|html?)$`).MatchString(rel) {
		httpError(w, 400, "only markdown and HTML pages open here")
		return
	}
	folder := filepath.Dir(a.Path)
	fsys := s.attFS(r.Context(), a)
	if fsys == nil {
		httpError(w, 503, "the host of that file is not connected")
		return
	}
	p := filepath.Join(folder, rel)
	real, err := fsys.EvalSymlinks(r.Context(), p)
	if err != nil || filepath.Dir(real) != folder {
		httpError(w, 404, rel+" is not in that folder")
		return
	}
	fi, err := fsys.Stat(r.Context(), real)
	if err != nil || !fi.IsRegular() {
		httpError(w, 404, "no such page")
		return
	}
	if fi.Size > htmlDocMaxBytes {
		httpError(w, 413, rel+" is larger than 2 MB")
		return
	}
	b, err := hostfs.ReadFile(r.Context(), fsys, real)
	if err != nil || !utf8.Valid(b) {
		httpError(w, 415, rel+" is not text")
		return
	}
	out := map[string]any{"name": filepath.Base(real), "path": real, "text": string(b), "html": nil}
	if attach.ByName(rel) == attach.HTML {
		out["html"] = s.rewriteHTML(string(b), s.hostOfAttachment(r.Context(), a), folder)
	}
	writeJSON(w, 200, out)
}

// ---- ```html embeds ----

const embedBaseCSS = `:root{--chart-1:#4f6bed;--chart-2:#e8833a;--chart-3:#2fa37a;--chart-4:#d64c63;--chart-5:#8b5cf6}` +
	`html,body{margin:0;background:transparent}` +
	`html{font-family:var(--font-sans,system-ui,sans-serif);font-size:14px;line-height:1.5;color:var(--foreground,CanvasText)}` +
	`html[data-pn-embed=inline]{overflow:hidden}` +
	`html[data-pn-embed=inline] body{overflow-x:auto;scrollbar-width:none}` +
	`html[data-pn-embed=inline] body::-webkit-scrollbar{display:none}` +
	`img,svg,canvas,video{max-width:100%}`

// embedBootstrap: theme variables (URL fragment, then postMessage), height
// reports, links forwarded to the window, Escape to leave the frame.
const embedBootstrap = `(function(){
function apply(v,scheme){var r=document.documentElement;if(v){for(var k in v){r.style.setProperty(k,v[k]);}}if(scheme){r.style.colorScheme=scheme;}}
var mode='inline';
try{var m=location.hash.match(/pn=([^&]*)/);if(m){var d=JSON.parse(decodeURIComponent(m[1]));apply(d.vars,d.scheme);if(d.mode){mode=d.mode;}}}catch(e){}
document.documentElement.setAttribute('data-pn-embed',mode);
function post(o){o.pnEmbed=1;try{parent.postMessage(o,'*');}catch(e){}}
var last=-1;function size(){var b=document.body;var h=Math.ceil(Math.max(document.documentElement.getBoundingClientRect().height,b?b.scrollHeight:0));if(h!==last){last=h;post({kind:'height',height:h});}}
window.addEventListener('message',function(e){var d=e.data;if(d&&d.pnEmbed===1&&d.kind==='theme'){apply(d.vars,d.scheme);}});
window.addEventListener('load',size);
document.addEventListener('DOMContentLoaded',function(){size();if(window.ResizeObserver){new ResizeObserver(size).observe(document.documentElement);if(document.body){new ResizeObserver(size).observe(document.body);}}});
document.addEventListener('click',function(e){var a=e.target&&e.target.closest?e.target.closest('a[href]'):null;if(!a){return;}var h=a.getAttribute('href')||'';if(h.charAt(0)==='#'){return;}e.preventDefault();var u=a.href;if(/^https?:/i.test(u)&&u.length<=4096){post({kind:'link',url:u});}},true);
document.addEventListener('keydown',function(e){if(e.key==='Escape'){post({kind:'escape'});}});
post({kind:'ready'});
})();`

var leadingDoctypeRe = regexp.MustCompile(`(?is)^\s*<!doctype[^>]*>`)

func (s *Server) postEmbed(w http.ResponseWriter, r *http.Request) {
	var req struct {
		HTML string `json:"html"`
	}
	r.Body = http.MaxBytesReader(w, r.Body, embedMaxBytes*2+1024)
	if !decode(w, r, &req) {
		return
	}
	if len(req.HTML) > embedMaxBytes {
		httpError(w, 413, "that block is larger than 512 KB; it stays code")
		return
	}
	sum := sha256.Sum256([]byte(req.HTML))
	id := hex.EncodeToString(sum[:])[:32]
	doc := []byte(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>` +
		embedBaseCSS + `</style><script>` + embedBootstrap + `</script>` + leadingDoctypeRe.ReplaceAllString(req.HTML, ""))
	st := s.files
	st.mu.Lock()
	if _, ok := st.embeds[id]; !ok {
		st.embeds[id] = doc
		st.embedOrder = append(st.embedOrder, id)
		st.embedsBytes += len(doc)
		for len(st.embedOrder) > embedStoreMaxCount || st.embedsBytes > embedStoreMaxBytes {
			old := st.embedOrder[0]
			st.embedOrder = st.embedOrder[1:]
			st.embedsBytes -= len(st.embeds[old])
			delete(st.embeds, old)
		}
	}
	st.mu.Unlock()
	writeJSON(w, 200, map[string]string{"id": id, "url": "/api/embeds/" + id})
}

var embedIDRe = regexp.MustCompile(`^[a-f0-9]{32}$`)

func (s *Server) getEmbed(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if !embedIDRe.MatchString(id) {
		httpError(w, 404, "no such embed")
		return
	}
	s.files.mu.Lock()
	doc, ok := s.files.embeds[id]
	s.files.mu.Unlock()
	if !ok {
		httpError(w, 404, "no such embed (post it again)")
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Referrer-Policy", "no-referrer")
	w.Header().Set("Cache-Control", "private, max-age=86400, immutable")
	w.Header().Set("Content-Security-Policy", cspEmbed)
	_, _ = w.Write(doc)
}

// ---- the person's files ----

var bidiControls = "\u061c\u200e\u200f\u202a\u202b\u202c\u202d\u202e\u2066\u2067\u2068\u2069"

// uploadNameError checks a file name the person attaches ("" = fine).
func uploadNameError(name string) string {
	if strings.TrimSpace(name) == "" || name == "." || name == ".." {
		return "Not attached: a file name is required."
	}
	if strings.ContainsAny(name, `/\`) || strings.ContainsAny(name, bidiControls) || strings.ContainsAny(name, "\u2028\u2029") {
		return "Not attached: the file name has characters a file name cannot have."
	}
	for _, r := range name {
		if unicode.IsControl(r) {
			return "Not attached: the file name has characters a file name cannot have."
		}
	}
	if len(name) > 255 {
		return "Not attached: the file name is longer than 255 bytes."
	}
	if attach.IsDotenv(name) {
		return "Not attached: .env files often hold secrets."
	}
	return ""
}

func uploadJSON(u *store.Upload) map[string]any {
	return map[string]any{"upload": u}
}

// postUpload receives a file the person attaches (raw body), ahead of Send.
func (s *Server) postUpload(w http.ResponseWriter, r *http.Request) {
	name := r.URL.Query().Get("name")
	if msg := uploadNameError(name); msg != "" {
		writeJSON(w, 400, map[string]string{"error": msg, "code": "upload_refused"})
		return
	}
	if r.ContentLength > uploadMaxBytes {
		writeJSON(w, 413, map[string]string{"error": "Not attached: a file is at most 100 MB.", "code": "upload_too_large"})
		return
	}
	b, err := s.putBlobReader(r.Body, uploadMaxBytes)
	if errors.Is(err, errTooLarge) {
		writeJSON(w, 413, map[string]string{"error": "Not attached: a file is at most 100 MB.", "code": "upload_too_large"})
		return
	}
	if err != nil {
		storeError(w, err)
		return
	}
	a := s.fileAttachment(name, "", b)
	u := &store.Upload{Name: name, Size: b.Size, Type: a.Type, SHA256: b.Sum, Mime: a.Mime, Width: a.Width, Height: a.Height,
		DurationMs: a.DurationMs, SearchText: a.SearchText}
	_ = s.store.SweepUploads(r.Context())
	if err := s.store.AddUpload(r.Context(), u); err != nil {
		storeError(w, err)
		return
	}
	writeJSON(w, 201, uploadJSON(u))
}

var pastedTextRe = regexp.MustCompile(`^pasted-text-[^/\\]+\.txt$`)

// uploadText gives back a pending pasted-text upload's words ("Put back").
func (s *Server) uploadText(w http.ResponseWriter, r *http.Request) {
	u, err := s.store.GetUpload(r.Context(), r.PathValue("id"))
	if err != nil {
		storeError(w, err)
		return
	}
	if !pastedTextRe.MatchString(u.Name) {
		httpError(w, 400, "only pasted text can be put back")
		return
	}
	b, err := os.ReadFile(s.blobPath(u.SHA256))
	if err != nil {
		storeError(w, err)
		return
	}
	writeJSON(w, 200, map[string]string{"text": string(b)})
}

func (s *Server) deleteUpload(w http.ResponseWriter, r *http.Request) {
	if err := s.store.DeleteUpload(r.Context(), r.PathValue("id")); err != nil {
		storeError(w, err)
		return
	}
	writeJSON(w, 200, map[string]bool{"ok": true})
}

// uploadsToAttachments turns pending uploads into read-only copies under
// <data dir>/uploads/<att id>/<name>, as attachments of the person's message.
func (s *Server) takeUploads(r *http.Request, ids []string) ([]*store.Upload, error) {
	var out []*store.Upload
	for i, id := range ids {
		u, err := s.store.GetUpload(r.Context(), id)
		if err != nil {
			return nil, &httpErr{404, fmt.Sprintf("uploads[%d]: that file is no longer here; attach it again.", i), "upload_not_found"}
		}
		out = append(out, u)
	}
	return out, nil
}

type httpErr struct {
	status int
	msg    string
	code   string
}

func (e *httpErr) Error() string { return e.msg }

func writeErr(w http.ResponseWriter, err error) {
	var he *httpErr
	if errors.As(err, &he) {
		writeJSON(w, he.status, map[string]string{"error": he.msg, "code": he.code})
		return
	}
	httpError(w, 400, err.Error())
}

func (s *Server) attachUploads(r *http.Request, ups []*store.Upload, threadID, messageID string) error {
	host, _, err := s.store.HostOfThread(r.Context(), threadID)
	if err != nil {
		return err
	}
	fsys, err := s.sessions.fsOf(host)
	if err != nil {
		return err
	}
	for _, u := range ups {
		id := store.NewID("att")
		// A read-only copy on the session's machine: the agent opens it there.
		src, err := os.Open(s.blobPath(u.SHA256))
		if err != nil {
			return err
		}
		p, err := fsys.WriteFile(r.Context(), hostfs.AreaUploads, id+"/"+u.Name, src, true)
		src.Close()
		if err != nil {
			return err
		}
		real, err := fsys.EvalSymlinks(r.Context(), p)
		if err != nil {
			real = p
		}
		now := time.Now()
		a := store.Attachment{ID: id, ThreadID: threadID, MessageID: messageID, Author: store.AuthorUser, Kind: store.AttachmentFile,
			Type: u.Type, Name: u.Name, Path: real, Mime: u.Mime, Size: u.Size, SHA256: u.SHA256, Width: u.Width, Height: u.Height,
			DurationMs: u.DurationMs, SentMtime: &now, SearchText: u.SearchText}
		if err := s.store.AddAttachment(r.Context(), &a, nil, ""); err != nil {
			return err
		}
		_ = s.store.DeleteUpload(r.Context(), u.ID)
	}
	return nil
}

func copyFile(src, dst string) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.OpenFile(dst, os.O_CREATE|os.O_WRONLY|os.O_EXCL, 0o600)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		out.Close()
		return err
	}
	return out.Close()
}

// attachedLines: what the agent reads about the person's files.
func attachedLines(atts []store.Attachment) string {
	var lines []string
	for _, a := range atts {
		lines = append(lines, fmt.Sprintf("Attached: %s (%s)", a.Name, a.Path))
	}
	return strings.Join(lines, "\n")
}

// bodyForAgent: the stored body plus the Attached lines (a reply of files
// alone may have no words).
func bodyForAgent(body string, atts []store.Attachment) string {
	attached := attachedLines(atts)
	switch {
	case attached == "":
		return body
	case strings.TrimSpace(body) != "":
		return body + "\n\n" + attached
	default:
		return attached
	}
}

// ---- drawings on images (markups) ----

func (s *Server) markupDir() string { return filepath.Join(s.cfg.DataDir, "markups") }

func (s *Server) postMarkup(w http.ResponseWriter, r *http.Request) {
	if err := os.MkdirAll(s.markupDir(), 0o700); err != nil {
		storeError(w, err)
		return
	}
	data, err := io.ReadAll(http.MaxBytesReader(w, r.Body, markupMaxBytes))
	if err != nil {
		httpError(w, 413, "the drawing is too large")
		return
	}
	mt, _, _, ok := attach.SniffImage(data)
	ext := map[string]string{"image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp"}[mt]
	if !ok || ext == "" {
		httpError(w, 415, "a drawing is a PNG, JPEG or WebP image")
		return
	}
	sum := sha256.Sum256(data)
	name := hex.EncodeToString(sum[:]) + ext
	p := filepath.Join(s.markupDir(), name)
	if _, err := os.Stat(p); err != nil {
		if err := os.WriteFile(p, data, 0o600); err != nil {
			storeError(w, err)
			return
		}
	}
	writeJSON(w, 201, map[string]string{"path": p, "name": name, "url": "/api/markups/" + name})
}

var markupNameRe = regexp.MustCompile(`^[a-f0-9]{64}\.(?:png|jpg|webp)$`)

func (s *Server) getMarkup(w http.ResponseWriter, r *http.Request) {
	name := r.PathValue("name")
	if !markupNameRe.MatchString(name) {
		httpError(w, 404, "no such drawing")
		return
	}
	serveImageFile(w, r, s.sessions.localFS, filepath.Join(s.markupDir(), name))
}

// withAttachedLines: the agent reads the person's files as Attached lines
// after their words (never stored in the body).
func (s *Server) withAttachedLines(r *http.Request, pending []store.PendingDelivery) {
	for i := range pending {
		atts, err := s.store.AttachmentsOfMessage(r.Context(), pending[i].ID)
		if err != nil || len(atts) == 0 {
			continue
		}
		pending[i].Attachments = atts
		pending[i].Body = bodyForAgent(pending[i].Body, atts)
	}
}

// feedbackFor composes the reply's feedback on the thread's files.
func (s *Server) feedbackFor(r *http.Request, th *store.Thread, anns []store.Annotation) string {
	if len(anns) == 0 {
		return ""
	}
	byID := map[string]*store.Attachment{}
	for i := range th.Messages {
		m := &th.Messages[i]
		for j := range m.Attachments {
			byID[m.Attachments[j].ID] = &m.Attachments[j]
		}
		for j := range m.InlineImages {
			byID[m.InlineImages[j].ID] = &m.InlineImages[j]
		}
	}
	cwd := ""
	if sess, err := s.store.GetSession(r.Context(), th.SessionID); err == nil {
		cwd = sess.Cwd
		anns = s.relocateMarkups(r.Context(), sess.HostID, anns)
	}
	return composeFeedback(anns, byID, cwd, func(a *store.Attachment) string { return a.CreatedAt.Local().Format("15:04") })
}

// relocateMarkups copies the drawings a reply's comments carry to the
// session's machine (when it is another one), so the agent can open them.
func (s *Server) relocateMarkups(ctx context.Context, hostID string, anns []store.Annotation) []store.Annotation {
	if !s.sessions.remote(hostID) {
		return anns
	}
	fsys, err := s.sessions.fsOf(hostID)
	if err != nil {
		return anns
	}
	dir := s.markupDir() + string(filepath.Separator)
	out := make([]store.Annotation, len(anns))
	for i, a := range anns {
		imgs := make([]store.AnnotationImage, len(a.Images))
		copy(imgs, a.Images)
		for j, im := range imgs {
			if !strings.HasPrefix(im.Path, dir) {
				continue
			}
			f, err := os.Open(im.Path)
			if err != nil {
				continue
			}
			if p, err := fsys.WriteFile(ctx, hostfs.AreaMarkups, filepath.Base(im.Path), f, false); err == nil {
				imgs[j].Path = p
			}
			f.Close()
		}
		a.Images = imgs
		out[i] = a
	}
	return out
}
