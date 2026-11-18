package plugin

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

// The mod is extracted once per content hash into a private folder, and a second extract reuses it.
func TestExtractIdempotentAndPrivate(t *testing.T) {
	t.Setenv(SourceEnv, "")
	root := filepath.Join(t.TempDir(), "plugin")
	dir, err := Extract(root)
	if err != nil {
		t.Fatal(err)
	}
	if filepath.Dir(dir) != root || !isHashName(filepath.Base(dir)) {
		t.Fatalf("dir = %s, want root/<12 hex>", dir)
	}
	for _, f := range []string{".claude-plugin/plugin.json", "hooks/hooks.json", "hooks/register.ts", ".complete"} {
		if _, err := os.Stat(filepath.Join(dir, f)); err != nil {
			t.Fatalf("%s: %v", f, err)
		}
	}
	if _, err := os.Stat(filepath.Join(dir, "hooks", "register.test.ts")); err == nil {
		t.Fatal("a test file was extracted")
	}
	for path, want := range map[string]os.FileMode{
		dir:                                     dirMode,
		filepath.Join(dir, "hooks"):             dirMode,
		filepath.Join(dir, "hooks/register.ts"): fileMode,
	} {
		info, err := os.Stat(path)
		if err != nil {
			t.Fatal(err)
		}
		if got := info.Mode().Perm(); got != want {
			t.Fatalf("%s: mode %o, want %o", path, got, want)
		}
	}

	// Reuse: same folder, and a file changed in it is not rewritten.
	marker := filepath.Join(dir, "marker")
	if err := os.WriteFile(marker, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	again, err := Extract(root)
	if err != nil || again != dir {
		t.Fatalf("second extract: %s %v", again, err)
	}
	if _, err := os.Stat(marker); err != nil {
		t.Fatal("the folder was rewritten")
	}
	entries, _ := os.ReadDir(root)
	if len(entries) != 1 {
		t.Fatalf("root holds %d entries, want 1", len(entries))
	}
}

// Old versions are removed once there are more than keepVersions and they are long unused; recent
// ones, the current one, stale temporary folders and unrelated folders are handled as documented.
func TestExtractPrunesOldVersions(t *testing.T) {
	t.Setenv(SourceEnv, "")
	root := t.TempDir()
	now := time.Now()
	mk := func(name string, age time.Duration) {
		p := filepath.Join(root, name)
		if err := os.MkdirAll(p, 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.Chtimes(p, now.Add(-age), now.Add(-age)); err != nil {
			t.Fatal(err)
		}
	}
	day := 24 * time.Hour
	mk("aaaaaaaaaaa1", 1*day)  // recent: kept
	mk("aaaaaaaaaaa2", 40*day) // among the 3 newest old ones: kept
	mk("aaaaaaaaaaa3", 41*day) // kept
	mk("aaaaaaaaaaa4", 42*day) // removed
	mk("aaaaaaaaaaa5", 43*day) // removed
	mk(".extract-stale", 2*time.Hour)
	mk(".extract-fresh", time.Minute)
	mk("not-a-version", 100*day)

	dir, err := Extract(root)
	if err != nil {
		t.Fatal(err)
	}
	want := map[string]bool{
		filepath.Base(dir): true, "aaaaaaaaaaa1": true, "aaaaaaaaaaa2": true, "aaaaaaaaaaa3": true,
		"aaaaaaaaaaa4": false, "aaaaaaaaaaa5": false, ".extract-stale": false, ".extract-fresh": true,
		"not-a-version": true,
	}
	for name, keep := range want {
		_, err := os.Stat(filepath.Join(root, name))
		if keep != (err == nil) {
			t.Errorf("%s: exists=%v, want %v", name, err == nil, keep)
		}
	}
}

// With MINBOX_PLUGIN_SOURCE set, the live folders are used and nothing is extracted.
func TestSourceEnvUsesLiveFolders(t *testing.T) {
	live, err := filepath.Abs(".") // this package's folder is the repository's plugin/
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv(SourceEnv, ".")
	root := t.TempDir()
	if dir, err := Extract(root); err != nil || dir != filepath.Join(live, "minbox") {
		t.Fatalf("Extract = %s %v", dir, err)
	}
	if p, err := ExtractPi(root); err != nil || p != filepath.Join(live, "pi", "minbox.ts") {
		t.Fatalf("ExtractPi = %s %v", p, err)
	}
	if p, err := ExtractOpenCode(root); err != nil || p != filepath.Join(live, "opencode") {
		t.Fatalf("ExtractOpenCode = %s %v", p, err)
	}
	if entries, _ := os.ReadDir(root); len(entries) != 0 {
		t.Fatalf("extracted %d entries", len(entries))
	}

	t.Setenv(SourceEnv, t.TempDir()) // not a plugin folder
	if _, err := Extract(root); err == nil {
		t.Fatal("a folder without minbox/.claude-plugin was accepted")
	}
}
