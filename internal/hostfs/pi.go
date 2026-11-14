package hostfs

import (
	"os"
	"path/filepath"
	"strings"
)

// PiDirName is how Pi names a folder's session directory under <agent dir>/sessions: the path
// without its leading separator, with / \ and : replaced by -, between "--" and "--".
func PiDirName(cwd string) string {
	cwd = strings.TrimLeft(cwd, `/\`)
	return "--" + strings.NewReplacer("/", "-", `\`, "-", ":", "-").Replace(cwd) + "--"
}

// PiSessionsRoot is where Pi keeps its sessions on this machine: $PI_CODING_AGENT_SESSION_DIR,
// else $PI_CODING_AGENT_DIR/sessions, else ~/.pi/agent/sessions. (A per-run --session-dir is not
// known here; minbox does not pass one.)
func PiSessionsRoot() string {
	if d := os.Getenv("PI_CODING_AGENT_SESSION_DIR"); d != "" {
		return d
	}
	if d := os.Getenv("PI_CODING_AGENT_DIR"); d != "" {
		return filepath.Join(d, "sessions")
	}
	home, err := os.UserHomeDir()
	if err != nil || home == "" {
		return ""
	}
	return filepath.Join(home, ".pi", "agent", "sessions")
}

// PiConversationFile finds the session file of conversation id on this machine: in the folder's
// own session directory first (also for the symlink-resolved folder), else in any directory (ids
// are UUIDs). It returns "" if there is none.
func PiConversationFile(root, cwd, id string) string {
	if root == "" || id == "" || strings.ContainsAny(id, `/\*?[`) {
		return ""
	}
	find := func(dir string) string {
		m, _ := filepath.Glob(filepath.Join(dir, "*_"+id+".jsonl"))
		if len(m) > 0 {
			return m[0]
		}
		return ""
	}
	if cwd != "" {
		if p := find(filepath.Join(root, PiDirName(cwd))); p != "" {
			return p
		}
		if real, err := filepath.EvalSymlinks(cwd); err == nil {
			if p := find(filepath.Join(root, PiDirName(real))); p != "" {
				return p
			}
		}
	}
	entries, err := os.ReadDir(root)
	if err != nil {
		return ""
	}
	for _, e := range entries {
		if e.IsDir() {
			if p := find(filepath.Join(root, e.Name())); p != "" {
				return p
			}
		}
	}
	return ""
}
