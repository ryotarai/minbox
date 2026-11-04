// Package hostfs is the file access minbox needs on the machine a session
// runs on: the server's own machine (Local), or another machine's host
// reached over HTTP (Remote, served by Handler on that host).
package hostfs

import (
	"context"
	"errors"
	"io"
	"io/fs"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

// Info describes a file.
type Info struct {
	Name    string      `json:"name"`
	Size    int64       `json:"size"`
	Mode    fs.FileMode `json:"mode"`
	ModTime time.Time   `json:"mod_time"`
}

func (i Info) IsDir() bool     { return i.Mode.IsDir() }
func (i Info) IsRegular() bool { return i.Mode.IsRegular() }

// File is an open file: readable, seekable (for Range requests).
type File interface {
	io.ReadSeekCloser
	Info() Info
}

// DirEntry is a folder in a listing.
type DirEntry struct {
	Name    string `json:"name"`    // relative to the listed folder ("." is the folder itself)
	Path    string `json:"path"`    // absolute
	Display string `json:"display"` // ~-relative
	Git     bool   `json:"git"`
	Branch  string `json:"branch,omitempty"`
}

// Listing is a folder's subfolders (and the repository's worktrees).
type Listing struct {
	Path    string     `json:"path"`
	Display string     `json:"display"`
	Parent  string     `json:"parent,omitempty"`
	Home    string     `json:"home"`
	Entries []DirEntry `json:"entries"`
}

// Completion is an agent, skill or command a message can mention.
type Completion struct {
	Name        string `json:"name"`
	Description string `json:"description"`
}

// Areas a host writes files into (under its data directory): files the agent
// must be able to open on that machine.
const (
	AreaScratch = "scratch" // pasted images, compose files
	AreaUploads = "uploads" // the person's files attached to a reply
	AreaMarkups = "markups" // drawings on images
)

// Env is what the server needs to know about the machine.
type Env struct {
	Home            string `json:"home"`
	ClaudeConfigDir string `json:"claude_config_dir"`
	OS              string `json:"os"`
	Arch            string `json:"arch"`
}

// FS is file access on one machine.
type FS interface {
	Env(ctx context.Context) (Env, error)
	Stat(ctx context.Context, path string) (Info, error)
	EvalSymlinks(ctx context.Context, path string) (string, error)
	Open(ctx context.Context, path string) (File, error)
	Sum(ctx context.Context, path string) (string, error)
	MkdirAll(ctx context.Context, path string) error
	ListDirs(ctx context.Context, path string) (Listing, error)
	Completions(ctx context.Context, cwd string) (map[string][]Completion, error)
	// GitDiff is path's diff in the repository (or worktree) that holds it:
	// against HEAD, or with base against where HEAD left base (its merge
	// base), so committed changes show too. An untracked file is diffed
	// against /dev/null.
	GitDiff(ctx context.Context, cwd, path, base string) (string, error)
	// TranscriptExists: Claude Code has a transcript for the conversation in cwd.
	TranscriptExists(ctx context.Context, cwd, claudeSessionID string) bool
	// WriteFile creates area/rel (exclusive) from r and answers its absolute path.
	WriteFile(ctx context.Context, area, rel string, r io.Reader, readOnly bool) (string, error)
}

// ErrNotFound: no such file.
var ErrNotFound = fs.ErrNotExist

// ReadHead reads up to n bytes of a file.
func ReadHead(ctx context.Context, f FS, path string, n int64) ([]byte, error) {
	r, err := f.Open(ctx, path)
	if err != nil {
		return nil, err
	}
	defer r.Close()
	return io.ReadAll(io.LimitReader(r, n))
}

// ReadFile reads a whole file.
func ReadFile(ctx context.Context, f FS, path string) ([]byte, error) {
	r, err := f.Open(ctx, path)
	if err != nil {
		return nil, err
	}
	defer r.Close()
	return io.ReadAll(r)
}

// ExpandPath turns "~/x" or "" (home) into an absolute, clean path.
func ExpandPath(home, p string) string {
	p = strings.TrimSpace(p)
	switch {
	case p == "" || p == "~":
		return home
	case strings.HasPrefix(p, "~/"):
		return filepath.Join(home, p[2:])
	}
	return filepath.Clean(p)
}

// DisplayPath shows a path under home as ~/…
func DisplayPath(home, p string) string {
	if home != "" && (p == home || strings.HasPrefix(p, home+"/")) {
		return "~" + strings.TrimPrefix(p, home)
	}
	return p
}

// ResolveIn resolves p (absolute, ~/…, or relative to cwd).
func ResolveIn(home, cwd, p string) string {
	if strings.HasPrefix(p, "~/") && home != "" {
		p = filepath.Join(home, p[2:])
	}
	if !filepath.IsAbs(p) {
		p = filepath.Join(cwd, p)
	}
	return filepath.Clean(p)
}

var nonAlnum = regexp.MustCompile(`[^A-Za-z0-9]`)

// ProjectDirName is how Claude Code names a project's folder under ~/.claude/projects.
func ProjectDirName(cwd string) string { return nonAlnum.ReplaceAllString(cwd, "-") }

// IsNotExist reports a missing file (also across Remote).
func IsNotExist(err error) bool { return errors.Is(err, fs.ErrNotExist) }
