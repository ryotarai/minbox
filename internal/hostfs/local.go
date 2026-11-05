package hostfs

import (
	"bufio"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"time"
)

// Local is file access on this machine. Areas maps AreaScratch, AreaUploads
// and AreaMarkups to folders.
type Local struct {
	Areas map[string]string
}

// NewLocal writes the areas under dataDir.
func NewLocal(dataDir string) *Local {
	return &Local{Areas: map[string]string{
		AreaScratch: filepath.Join(dataDir, "scratch"),
		AreaUploads: filepath.Join(dataDir, "uploads"),
		AreaMarkups: filepath.Join(dataDir, "markups"),
	}}
}

func infoOf(fi os.FileInfo) Info {
	return Info{Name: fi.Name(), Size: fi.Size(), Mode: fi.Mode(), ModTime: fi.ModTime()}
}

func (l *Local) Env(context.Context) (Env, error) {
	home, _ := os.UserHomeDir()
	cfg := os.Getenv("CLAUDE_CONFIG_DIR")
	if cfg == "" && home != "" {
		cfg = filepath.Join(home, ".claude")
	}
	return Env{Home: home, ClaudeConfigDir: cfg, OS: runtime.GOOS, Arch: runtime.GOARCH}, nil
}

func (l *Local) Stat(_ context.Context, path string) (Info, error) {
	fi, err := os.Stat(path)
	if err != nil {
		return Info{}, err
	}
	return infoOf(fi), nil
}

func (l *Local) EvalSymlinks(_ context.Context, path string) (string, error) {
	return filepath.EvalSymlinks(path)
}

type localFile struct {
	*os.File
	info Info
}

func (f localFile) Info() Info { return f.info }

func (l *Local) Open(_ context.Context, path string) (File, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	fi, err := f.Stat()
	if err != nil {
		f.Close()
		return nil, err
	}
	if fi.IsDir() {
		f.Close()
		return nil, fmt.Errorf("%s is a folder", path)
	}
	return localFile{f, infoOf(fi)}, nil
}

func (l *Local) Sum(_ context.Context, path string) (string, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer f.Close()
	h := sha256.New()
	if _, err := io.CopyBuffer(h, f, make([]byte, 1<<20)); err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

func (l *Local) MkdirAll(_ context.Context, path string) error { return os.MkdirAll(path, 0o755) }

const maxDirEntries = 500

// gitBranch reports whether dir is a git checkout (or worktree), and its branch.
func gitBranch(dir string) (bool, string) {
	dotgit := filepath.Join(dir, ".git")
	st, err := os.Stat(dotgit)
	if err != nil {
		return false, ""
	}
	gitDir := dotgit
	if !st.IsDir() { // a worktree: ".git" is a file "gitdir: <path>"
		b, err := os.ReadFile(dotgit)
		if err != nil {
			return true, ""
		}
		v := strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(string(b)), "gitdir:"))
		if !filepath.IsAbs(v) {
			v = filepath.Join(dir, v)
		}
		gitDir = v
	}
	head, err := os.ReadFile(filepath.Join(gitDir, "HEAD"))
	if err != nil {
		return true, ""
	}
	h := strings.TrimSpace(string(head))
	if ref, ok := strings.CutPrefix(h, "ref: refs/heads/"); ok {
		return true, ref
	}
	if len(h) > 7 {
		h = h[:7]
	}
	return true, h
}

// worktrees lists the linked worktrees of the repository in dir.
func worktrees(dir string) []string {
	ents, err := os.ReadDir(filepath.Join(dir, ".git", "worktrees"))
	if err != nil {
		return nil
	}
	var out []string
	for _, e := range ents {
		b, err := os.ReadFile(filepath.Join(dir, ".git", "worktrees", e.Name(), "gitdir"))
		if err != nil {
			continue
		}
		wt := filepath.Dir(strings.TrimSpace(string(b))) // ".../<worktree>/.git" → worktree
		if st, err := os.Stat(wt); err == nil && st.IsDir() {
			out = append(out, wt)
		}
	}
	return out
}

// ListDirs lists a folder's subfolders (no hidden ones), with git branches,
// and the repository's worktrees. dir is absolute.
func (l *Local) ListDirs(_ context.Context, dir string) (Listing, error) {
	home, _ := os.UserHomeDir()
	st, err := os.Stat(dir)
	if err != nil || !st.IsDir() {
		return Listing{}, os.ErrNotExist
	}
	out := Listing{Path: dir, Display: DisplayPath(home, dir), Home: home, Entries: []DirEntry{}}
	if parent := filepath.Dir(dir); parent != dir {
		out.Parent = parent
	}
	git, branch := gitBranch(dir)
	out.Entries = append(out.Entries, DirEntry{Name: ".", Path: dir, Display: out.Display, Git: git, Branch: branch})
	ents, err := os.ReadDir(dir)
	if err != nil {
		return Listing{}, err
	}
	var subs []DirEntry
	for _, e := range ents {
		if strings.HasPrefix(e.Name(), ".") {
			continue
		}
		p := filepath.Join(dir, e.Name())
		isDir := e.IsDir()
		if e.Type()&os.ModeSymlink != 0 {
			if st, err := os.Stat(p); err == nil && st.IsDir() {
				isDir = true
			}
		}
		if !isDir {
			continue
		}
		g, b := gitBranch(p)
		subs = append(subs, DirEntry{Name: e.Name(), Path: p, Display: DisplayPath(home, p), Git: g, Branch: b})
		if len(subs) >= maxDirEntries {
			break
		}
	}
	sort.Slice(subs, func(i, j int) bool { return strings.ToLower(subs[i].Name) < strings.ToLower(subs[j].Name) })
	out.Entries = append(out.Entries, subs...)
	listed := map[string]bool{}
	for _, e := range out.Entries {
		listed[e.Path] = true
	}
	for _, wt := range worktrees(dir) {
		if listed[wt] {
			continue
		}
		name := DisplayPath(home, wt)
		if rel, err := filepath.Rel(dir, wt); err == nil && !strings.HasPrefix(rel, "..") {
			name = rel
		}
		_, b := gitBranch(wt)
		out.Entries = append(out.Entries, DirEntry{Name: name, Path: wt, Display: DisplayPath(home, wt), Git: true, Branch: b})
	}
	return out, nil
}

// Completions lists the agents, skills and commands in ~/.claude and <cwd>/.claude.
func (l *Local) Completions(_ context.Context, cwd string) (map[string][]Completion, error) {
	var roots []string
	if home, err := os.UserHomeDir(); err == nil {
		roots = append(roots, filepath.Join(home, ".claude"))
	}
	roots = append(roots, filepath.Join(cwd, ".claude"))
	out := map[string][]Completion{"agents": {}, "skills": {}, "commands": {}}
	seen := map[string]bool{}
	add := func(kind, name, desc string) {
		if name == "" || seen[kind+"/"+name] {
			return
		}
		seen[kind+"/"+name] = true
		out[kind] = append(out[kind], Completion{Name: name, Description: desc})
	}
	glob := func(p string) []string { m, _ := filepath.Glob(p); return m }
	first := func(v ...string) string {
		for _, s := range v {
			if s != "" {
				return s
			}
		}
		return ""
	}
	for _, root := range roots {
		for _, p := range glob(filepath.Join(root, "agents", "*.md")) {
			n, d := frontmatter(p)
			add("agents", first(n, strings.TrimSuffix(filepath.Base(p), ".md")), d)
		}
		for _, p := range glob(filepath.Join(root, "skills", "*", "SKILL.md")) {
			n, d := frontmatter(p)
			add("skills", first(n, filepath.Base(filepath.Dir(p))), d)
		}
		for _, p := range glob(filepath.Join(root, "commands", "*.md")) {
			_, d := frontmatter(p)
			add("commands", strings.TrimSuffix(filepath.Base(p), ".md"), d)
		}
	}
	for _, k := range []string{"agents", "skills", "commands"} {
		sort.Slice(out[k], func(i, j int) bool { return out[k][i].Name < out[k][j].Name })
	}
	return out, nil
}

// frontmatter reads name/description from a Markdown file's YAML front matter
// (or the first prose line as the description).
func frontmatter(path string) (name, desc string) {
	f, err := os.Open(path)
	if err != nil {
		return "", ""
	}
	defer f.Close()
	sc := bufio.NewScanner(io.LimitReader(f, 64<<10))
	inFM := false
	for i := 0; sc.Scan(); i++ {
		l := strings.TrimSpace(sc.Text())
		if i == 0 && l == "---" {
			inFM = true
			continue
		}
		if inFM {
			if l == "---" {
				inFM = false
				continue
			}
			if v, ok := strings.CutPrefix(l, "name:"); ok {
				name = strings.Trim(strings.TrimSpace(v), `"'`)
			}
			if v, ok := strings.CutPrefix(l, "description:"); ok {
				desc = strings.Trim(strings.TrimSpace(v), `"'`)
			}
			continue
		}
		if desc == "" && l != "" && !strings.HasPrefix(l, "#") {
			desc = l
		}
		if desc != "" {
			break
		}
	}
	if r := []rune(desc); len(r) > 160 {
		desc = string(r[:159]) + "…"
	}
	return name, desc
}

// GitDiff is path's diff in the repository or worktree that holds it, not
// cwd's: a file in a worktree is diffed in that worktree. Against HEAD, or,
// with base (a branch or commit), against the merge base of base and HEAD, so
// the branch's committed changes show as well as uncommitted ones. An
// untracked file is diffed against /dev/null.
func (l *Local) GitDiff(ctx context.Context, cwd, path, base string) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	dir := gitDirOf(path, cwd)
	from := "HEAD"
	if base != "" {
		if strings.HasPrefix(base, "-") {
			return "", fmt.Errorf("bad base %q", base)
		}
		mb, err := exec.CommandContext(ctx, "git", "-C", dir, "merge-base", base, "HEAD").Output()
		if err != nil {
			return "", fmt.Errorf("base %s: no common commit with HEAD in %s", base, dir)
		}
		from = strings.TrimSpace(string(mb))
	}
	out, err := exec.CommandContext(ctx, "git", "-C", dir, "diff", "--no-color", "--no-ext-diff", from, "--", path).Output()
	if err == nil && len(out) > 0 {
		return string(out), nil
	}
	if err := exec.CommandContext(ctx, "git", "-C", dir, "ls-files", "--error-unmatch", "--", path).Run(); err == nil {
		return "", nil // tracked and unchanged
	}
	if _, serr := os.Stat(path); serr != nil {
		return "", serr
	}
	out, err = exec.CommandContext(ctx, "git", "-C", dir, "diff", "--no-color", "--no-ext-diff", "--no-index", "--", "/dev/null", path).Output()
	var exitErr *exec.ExitError
	if err != nil && !(errors.As(err, &exitErr) && exitErr.ExitCode() == 1) {
		return "", fmt.Errorf("git diff: %v", err)
	}
	return string(out), nil
}

// gitDirOf is the nearest existing directory holding path (git finds the
// repository or worktree from there), else cwd.
func gitDirOf(path, cwd string) string {
	for d := filepath.Dir(path); d != "" && d != "/" && d != "."; d = filepath.Dir(d) {
		if st, err := os.Stat(d); err == nil && st.IsDir() {
			return d
		}
	}
	return cwd
}

func (l *Local) TranscriptExists(ctx context.Context, cwd, id string) bool {
	env, _ := l.Env(ctx)
	if env.ClaudeConfigDir == "" || id == "" {
		return false
	}
	return findTranscript(filepath.Join(env.ClaudeConfigDir, "projects"), cwd, id) != ""
}

// findTranscript locates <id>.jsonl under projects: first for the raw cwd, then
// for the symlink-resolved cwd (Claude Code names the folder after the real
// path: /tmp is -private-tmp on macOS), last in any project folder (ids are
// UUIDs, so unique). It returns "" if there is none.
func findTranscript(projects, cwd, id string) string {
	if id == "" || strings.ContainsAny(id, `/\`) {
		return ""
	}
	name := id + ".jsonl"
	try := func(dir string) string {
		p := filepath.Join(projects, dir, name)
		if _, err := os.Stat(p); err == nil {
			return p
		}
		return ""
	}
	if cwd != "" {
		if p := try(ProjectDirName(cwd)); p != "" {
			return p
		}
		if real, err := filepath.EvalSymlinks(cwd); err == nil {
			if p := try(ProjectDirName(real)); p != "" {
				return p
			}
		}
		if c := filepath.Clean(cwd); c != cwd {
			if p := try(ProjectDirName(c)); p != "" {
				return p
			}
		}
	}
	entries, err := os.ReadDir(projects)
	if err != nil {
		return ""
	}
	for _, e := range entries {
		if e.IsDir() {
			if p := try(e.Name()); p != "" {
				return p
			}
		}
	}
	return ""
}

// WriteFile creates area/rel (exclusive) from r.
func (l *Local) WriteFile(_ context.Context, area, rel string, r io.Reader, readOnly bool) (string, error) {
	root, ok := l.Areas[area]
	if !ok || root == "" {
		return "", fmt.Errorf("unknown area %q", area)
	}
	rel = filepath.Clean(filepath.FromSlash(rel))
	if rel == "." || filepath.IsAbs(rel) || strings.HasPrefix(rel, "..") {
		return "", fmt.Errorf("bad path %q", rel)
	}
	p := filepath.Join(root, rel)
	if err := os.MkdirAll(filepath.Dir(p), 0o700); err != nil {
		return "", err
	}
	f, err := os.OpenFile(p, os.O_CREATE|os.O_WRONLY|os.O_EXCL, 0o600)
	if err != nil {
		if errors.Is(err, os.ErrExist) {
			return p, nil // content-named files: already there
		}
		return "", err
	}
	if _, err := io.Copy(f, r); err != nil {
		f.Close()
		os.Remove(p)
		return "", err
	}
	if err := f.Close(); err != nil {
		return "", err
	}
	if readOnly {
		_ = os.Chmod(p, 0o400)
	}
	return p, nil
}
