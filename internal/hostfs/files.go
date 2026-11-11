package hostfs

import (
	"bytes"
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

// DefaultFileLimit caps an @-mention listing.
const DefaultFileLimit = 50

// maxScan bounds how many entries of one folder are looked at.
const maxScan = 5000

// ListFiles lists the entries of the folder a query names, for @-mentions.
// The query is a path the person is typing: "" (cwd), "src/ma" (folder src/
// under cwd, names matching "ma"), "../x", "/abs/dir/x", "~/x". Names only; no
// file is read. Folders come first, then better matches (prefix, substring,
// then in-order letters, case-insensitive). Hidden names show when the typed
// name starts with "."; .git, node_modules and the like only when asked for
// by prefix; files git ignores only once a name is being typed. The entry
// Path keeps the folder part as typed.
func (l *Local) ListFiles(ctx context.Context, cwd, query string, limit int) ([]FileEntry, error) {
	if limit <= 0 || limit > 200 {
		limit = DefaultFileLimit
	}
	dirPart, base := "", query
	if i := strings.LastIndex(query, "/"); i >= 0 {
		dirPart, base = query[:i+1], query[i+1:]
	}
	home, _ := os.UserHomeDir()
	var dir string
	switch {
	case query == "~":
		// "~" alone: offer home itself as "~/".
		return []FileEntry{{Path: "~/", Dir: true}}, nil
	case dirPart == "":
		dir = cwd
	case strings.HasPrefix(dirPart, "~/"):
		dir = filepath.Join(home, dirPart[2:])
	case filepath.IsAbs(dirPart):
		dir = filepath.Clean(dirPart)
	default:
		dir = filepath.Join(cwd, dirPart)
	}
	ents, err := os.ReadDir(dir)
	if err != nil {
		return []FileEntry{}, nil // not a folder (yet): nothing to offer
	}
	lbase := strings.ToLower(base)
	type cand struct {
		e    FileEntry
		name string
		rank int
	}
	var cands []cand
	for i, e := range ents {
		if i >= maxScan {
			break
		}
		name := e.Name()
		if junk(name, base) {
			continue
		}
		rank := match(strings.ToLower(name), lbase)
		if rank < 0 {
			continue
		}
		isDir := e.IsDir()
		if e.Type()&os.ModeSymlink != 0 {
			if st, err := os.Stat(filepath.Join(dir, name)); err == nil && st.IsDir() {
				isDir = true
			}
		}
		p := dirPart + name
		if isDir {
			p += "/"
		}
		cands = append(cands, cand{FileEntry{Path: p, Dir: isDir}, name, rank})
	}
	if base == "" && len(cands) > 0 {
		names := make([]string, len(cands))
		for i, c := range cands {
			names[i] = c.name
		}
		ignored := gitIgnored(ctx, dir, names)
		kept := cands[:0]
		for _, c := range cands {
			if !ignored[c.name] {
				kept = append(kept, c)
			}
		}
		cands = kept
	}
	sort.SliceStable(cands, func(i, j int) bool {
		a, b := cands[i], cands[j]
		if a.e.Dir != b.e.Dir {
			return a.e.Dir
		}
		if a.rank != b.rank {
			return a.rank < b.rank
		}
		return strings.ToLower(a.name) < strings.ToLower(b.name)
	})
	out := make([]FileEntry, 0, min(limit, len(cands)))
	for _, c := range cands {
		if len(out) >= limit {
			break
		}
		out = append(out, c.e)
	}
	return out, nil
}

// junk: names left out unless the typed name asks for them.
func junk(name, base string) bool {
	switch {
	case name == ".git":
		return !strings.HasPrefix(base, ".g")
	case name == "node_modules":
		return !strings.HasPrefix(base, "node")
	case name == ".DS_Store" || name == "__pycache__":
		return base == ""
	case strings.HasPrefix(name, "."):
		return !strings.HasPrefix(base, ".")
	}
	return false
}

// match ranks name against the typed text: 0 prefix, 1 substring, 2 letters
// in order, -1 no match. Both are lower case.
func match(name, q string) int {
	switch {
	case q == "" || strings.HasPrefix(name, q):
		return 0
	case strings.Contains(name, q):
		return 1
	}
	i := 0
	for _, r := range name {
		if i < len(q) && rune(q[i]) == r {
			i++
		}
	}
	if i == len(q) {
		return 2
	}
	return -1
}

// gitIgnored answers which of names (in dir) git ignores; none when dir is
// not in a repository or git is missing or slow.
func gitIgnored(ctx context.Context, dir string, names []string) map[string]bool {
	out := map[string]bool{}
	ctx, cancel := context.WithTimeout(ctx, 1500*time.Millisecond)
	defer cancel()
	cmd := exec.CommandContext(ctx, "git", "-C", dir, "check-ignore", "-z", "--stdin")
	cmd.Stdin = strings.NewReader(strings.Join(names, "\x00") + "\x00")
	b, err := cmd.Output()
	if err != nil && len(b) == 0 {
		return out
	}
	for _, n := range bytes.Split(b, []byte{0}) {
		if len(n) > 0 {
			out[string(n)] = true
		}
	}
	return out
}
