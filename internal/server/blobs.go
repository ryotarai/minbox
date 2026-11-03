package server

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"os"
	"path/filepath"
	"unicode/utf8"

	"github.com/ryotarai/minbox/internal/attach"
	"github.com/ryotarai/minbox/internal/hostfs"
)

// Attachment bytes live in <data dir>/blobs/<sha256>, written once, shared by
// every attachment with the same content. Any size: copied as a stream.

func (s *Server) blobDir() string { return filepath.Join(s.cfg.DataDir, "blobs") }

func (s *Server) blobPath(sum string) string { return filepath.Join(s.blobDir(), sum) }

// blob is what putting a file into the store learned about it.
type blob struct {
	Sum    string
	Size   int64
	Head   []byte // the first attach.HeadBytes, for sniffing
	IsText bool   // valid UTF-8 with no NUL byte, all of it
}

// putBlob copies the file at path into the blob store.
func (s *Server) putBlob(path string) (blob, error) {
	src, err := os.Open(path)
	if err != nil {
		return blob{}, err
	}
	defer src.Close()
	return s.putBlobReader(src, -1)
}

// putBlobFS copies a file of a host's machine into the blob store.
func (s *Server) putBlobFS(ctx context.Context, fsys hostfs.FS, path string) (blob, error) {
	src, err := fsys.Open(ctx, path)
	if err != nil {
		return blob{}, err
	}
	defer src.Close()
	return s.putBlobReader(src, -1)
}

var errTooLarge = errors.New("too large")

// putBlobReader stores what r yields (at most limit bytes when limit >= 0).
func (s *Server) putBlobReader(r io.Reader, limit int64) (blob, error) {
	if err := os.MkdirAll(s.blobDir(), 0o700); err != nil {
		return blob{}, err
	}
	tmp, err := os.CreateTemp(s.blobDir(), ".in-*")
	if err != nil {
		return blob{}, err
	}
	defer os.Remove(tmp.Name()) // a no-op once renamed
	h := sha256.New()
	head := &headWriter{max: attach.HeadBytes}
	text := &textCheck{ok: true}
	src := r
	if limit >= 0 {
		src = io.LimitReader(r, limit+1)
	}
	n, err := io.CopyBuffer(io.MultiWriter(tmp, h, head, text), src, make([]byte, 1<<20))
	if cerr := tmp.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		return blob{}, err
	}
	if limit >= 0 && n > limit {
		return blob{}, errTooLarge
	}
	sum := hex.EncodeToString(h.Sum(nil))
	if _, err := os.Stat(s.blobPath(sum)); err != nil {
		if err := os.Rename(tmp.Name(), s.blobPath(sum)); err != nil {
			return blob{}, err
		}
	}
	return blob{Sum: sum, Size: n, Head: head.buf, IsText: text.done()}, nil
}

// fileSum hashes a file as a stream.
func fileSum(path string) (string, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer f.Close()
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

// headWriter keeps the first max bytes written to it.
type headWriter struct {
	buf []byte
	max int
}

func (w *headWriter) Write(p []byte) (int, error) {
	if room := w.max - len(w.buf); room > 0 {
		if len(p) < room {
			room = len(p)
		}
		w.buf = append(w.buf, p[:room]...)
	}
	return len(p), nil
}

// textCheck tells whether a stream is valid UTF-8 with no NUL byte.
type textCheck struct {
	ok    bool
	carry []byte
}

func (t *textCheck) Write(p []byte) (int, error) {
	if !t.ok {
		return len(p), nil
	}
	b := append(t.carry, p...)
	t.carry = nil
	for i := 0; i < len(b); {
		c := b[i]
		if c == 0 {
			t.ok = false
			return len(p), nil
		}
		if c < utf8.RuneSelf {
			i++
			continue
		}
		if !utf8.FullRune(b[i:]) {
			t.carry = append([]byte(nil), b[i:]...)
			break
		}
		r, size := utf8.DecodeRune(b[i:])
		if r == utf8.RuneError && size == 1 {
			t.ok = false
			return len(p), nil
		}
		i += size
	}
	return len(p), nil
}

func (t *textCheck) done() bool { return t.ok && len(t.carry) == 0 }

// readHead reads up to n bytes of a file.
func readHead(path string, n int64) ([]byte, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	return io.ReadAll(io.LimitReader(f, n))
}

// classify decides an attachment's type from a stored blob.
func (s *Server) classify(name string, b blob) attach.Info {
	return attach.Decide(name, b.Head, b.IsText, b.Size, s.blobPath(b.Sum))
}
