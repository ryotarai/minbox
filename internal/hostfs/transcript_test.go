package hostfs

import (
	"context"
	"os"
	"path/filepath"
	"testing"
)

func TestTranscriptExists(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("CLAUDE_CONFIG_DIR", "")
	projects := filepath.Join(home, ".claude", "projects")
	put := func(dir, id string) {
		if err := os.MkdirAll(filepath.Join(projects, dir), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(projects, dir, id+".jsonl"), []byte("{}\n"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	base, _ := filepath.EvalSymlinks(t.TempDir())
	real := filepath.Join(base, "real")
	link := filepath.Join(base, "link")
	if err := os.Mkdir(real, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(real, link); err != nil {
		t.Fatal(err)
	}
	l := NewLocal("")
	ctx := context.Background()
	check := func(cwd, id string, want bool) {
		t.Helper()
		if got := l.TranscriptExists(ctx, cwd, id); got != want {
			t.Fatalf("TranscriptExists(%q, %s) = %v, want %v", cwd, id, got, want)
		}
	}
	put(ProjectDirName(real), "resolved")
	check(link, "resolved", true) // stored under the resolved name
	check(real, "resolved", true)
	put(ProjectDirName(link), "raw")
	check(link, "raw", true) // stored under the raw name
	check(link+"/", "resolved", true)
	check(real+"/", "resolved", true) // trailing slash
	put("-some-other-dir", "elsewhere")
	check("/does/not/exist", "elsewhere", true) // global search
	check(real, "missing", false)
	check(real, "", false)
	check(real, "../x", false)
}
