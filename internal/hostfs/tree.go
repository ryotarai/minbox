package hostfs

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

// The Files pane: every file under a session's folder (names only), git's
// status of the changed ones, and the real path of one file to read, checked
// to stay inside the folder.

// TreeMaxPaths caps a tree listing (and a git status).
const TreeMaxPaths = 20000

// Tree is the files under a folder, relative to it, "/"-separated. Folders
// end with "/" (only those a file list does not imply: empty ones, or a nested
// repository git does not look into).
type Tree struct {
	Root      string   `json:"root"`
	Git       bool     `json:"git"`
	Paths     []string `json:"paths"`
	Truncated bool     `json:"truncated"`
}

// GitStatusEntry is one changed path (relative to the listed folder) and what
// happened to it: added, modified, deleted, renamed or untracked.
type GitStatusEntry struct {
	Path   string `json:"path"`
	Status string `json:"status"`
}

// ErrOutside: a path leads out of the folder it must stay in.
var ErrOutside = errors.New("the path leads outside the agent's folder")

// treeSkip are folders a walk outside git leaves out: generated or vendored
// trees that would drown the files a person looks for.
var treeSkip = map[string]bool{
	".git": true, "node_modules": true, "__pycache__": true, ".venv": true, "venv": true,
	".tox": true, ".mypy_cache": true, ".pytest_cache": true, ".next": true, ".cache": true,
	".gradle": true, ".idea": true, ".DS_Store": true,
}

// ListTree lists the files under root: in a git repository the files git
// knows plus the untracked ones it does not ignore; elsewhere a walk that
// leaves out heavy folders and does not follow symbolic links. At most limit
// (TreeMaxPaths when 0 or more).
func (l *Local) ListTree(ctx context.Context, root string, limit int) (Tree, error) {
	if limit <= 0 || limit > TreeMaxPaths {
		limit = TreeMaxPaths
	}
	root = filepath.Clean(root)
	st, err := os.Stat(root)
	if err != nil {
		return Tree{}, err
	}
	if !st.IsDir() {
		return Tree{}, fmt.Errorf("%s is not a folder", root)
	}
	out := Tree{Root: root, Paths: []string{}}
	if _, ok := gitPrefix(ctx, root); ok {
		ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
		defer cancel()
		b, err := exec.CommandContext(ctx, "git", "-C", root, "-c", "core.quotepath=off", "ls-files", "-z", "--cached", "--others", "--exclude-standard", "--deduplicate").Output()
		if err == nil {
			out.Git = true
			for _, p := range bytes.Split(b, []byte{0}) {
				if len(p) == 0 {
					continue
				}
				if len(out.Paths) >= limit {
					out.Truncated = true
					break
				}
				out.Paths = append(out.Paths, string(p))
			}
			return out, nil
		}
	}
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	err = filepath.WalkDir(root, func(p string, d fs.DirEntry, err error) error {
		if ctx.Err() != nil {
			out.Truncated = true
			return filepath.SkipAll
		}
		if p == root {
			return nil
		}
		if err != nil {
			if d != nil && d.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		if treeSkip[d.Name()] {
			if d.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		if len(out.Paths) >= limit {
			out.Truncated = true
			return filepath.SkipAll
		}
		rel, _ := filepath.Rel(root, p)
		rel = filepath.ToSlash(rel)
		if d.IsDir() {
			out.Paths = append(out.Paths, rel+"/")
		} else {
			out.Paths = append(out.Paths, rel)
		}
		return nil
	})
	if err != nil {
		return Tree{}, err
	}
	out.Paths = dropImpliedDirs(out.Paths)
	return out, nil
}

// dropImpliedDirs leaves out "a/" when a path under it is listed (the tree
// shows the folder anyway); empty folders stay.
func dropImpliedDirs(paths []string) []string {
	parent := map[string]bool{}
	for _, p := range paths {
		q := strings.TrimSuffix(p, "/")
		if i := strings.LastIndex(q, "/"); i >= 0 {
			parent[q[:i+1]] = true
		}
	}
	kept := paths[:0]
	for _, p := range paths {
		if strings.HasSuffix(p, "/") && parent[p] {
			continue
		}
		kept = append(kept, p)
	}
	return kept
}

// gitPrefix is root's path inside its repository ("" at the top, "sub/" below
// it); false when root is not in a work tree.
func gitPrefix(ctx context.Context, root string) (string, bool) {
	ctx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	b, err := exec.CommandContext(ctx, "git", "-C", root, "rev-parse", "--is-inside-work-tree", "--show-prefix").Output()
	if err != nil {
		return "", false
	}
	lines := strings.Split(strings.TrimRight(string(b), "\n"), "\n")
	if len(lines) == 0 || lines[0] != "true" {
		return "", false
	}
	if len(lines) > 1 {
		return lines[1], true
	}
	return "", true
}

// TreeGitStatus is git's status of the changed files under root (relative to
// root); none outside a repository.
func (l *Local) TreeGitStatus(ctx context.Context, root string) ([]GitStatusEntry, error) {
	root = filepath.Clean(root)
	prefix, ok := gitPrefix(ctx, root)
	if !ok {
		return []GitStatusEntry{}, nil
	}
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	// Porcelain paths are relative to the repository's top, whatever the folder.
	b, err := exec.CommandContext(ctx, "git", "-C", root, "status", "--porcelain=v1", "-z", "--untracked-files=all", "--", ".").Output()
	if err != nil {
		return nil, fmt.Errorf("git status: %v", err)
	}
	return parseGitStatus(b, prefix, TreeMaxPaths), nil
}

// parseGitStatus reads `git status --porcelain=v1 -z`, keeping the paths under
// prefix (made relative to it).
func parseGitStatus(b []byte, prefix string, limit int) []GitStatusEntry {
	out := []GitStatusEntry{}
	recs := bytes.Split(b, []byte{0})
	for i := 0; i < len(recs); i++ {
		r := recs[i]
		if len(r) < 4 {
			continue
		}
		x, y, p := r[0], r[1], string(r[3:])
		if x == 'R' || x == 'C' {
			i++ // the old path follows
		}
		var status string
		switch {
		case x == '?' && y == '?':
			status = "untracked"
		case x == '!':
			continue
		case x == 'D' || y == 'D':
			status = "deleted"
		case x == 'R':
			status = "renamed"
		case x == 'A' || x == 'C':
			status = "added"
		default:
			status = "modified"
		}
		if !strings.HasPrefix(p, prefix) {
			continue
		}
		p = strings.TrimPrefix(p, prefix)
		if p == "" {
			continue
		}
		if len(out) >= limit {
			break
		}
		out = append(out, GitStatusEntry{Path: p, Status: status})
	}
	return out
}

// ResolveTreePath is the real path of rel under root, for reading: rel must be
// relative and stay inside root, also once symbolic links are followed.
func (l *Local) ResolveTreePath(ctx context.Context, root, rel string) (string, error) {
	return resolveUnder(root, rel)
}

func resolveUnder(root, rel string) (string, error) {
	if rel == "" || strings.ContainsRune(rel, 0) || filepath.IsAbs(rel) || !filepath.IsLocal(filepath.FromSlash(rel)) {
		return "", ErrOutside
	}
	realRoot, err := filepath.EvalSymlinks(filepath.Clean(root))
	if err != nil {
		return "", err
	}
	real, err := filepath.EvalSymlinks(filepath.Join(root, filepath.FromSlash(rel)))
	if err != nil {
		return "", err
	}
	if real != realRoot && !strings.HasPrefix(real, realRoot+string(filepath.Separator)) {
		return "", ErrOutside
	}
	return real, nil
}
