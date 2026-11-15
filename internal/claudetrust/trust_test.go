package claudetrust

import (
	"encoding/json"
	"os"
	"os/user"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

// Every test works in its own temporary HOME and CLAUDE_CONFIG_DIR: the person's ~/.claude.json is
// never looked at.

func sandbox(t *testing.T) (home string, env []string) {
	t.Helper()
	home = t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("CLAUDE_CONFIG_DIR", "")
	return home, []string{"HOME=" + home}
}

func write(t *testing.T, path, data string, perm os.FileMode) {
	t.Helper()
	if err := os.WriteFile(path, []byte(data), perm); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(path, perm); err != nil {
		t.Fatal(err)
	}
}

func read(t *testing.T, path string) string {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func project(t *testing.T, path string) string {
	t.Helper()
	b, _ := os.MkdirTemp(path, "proj")
	real, err := filepath.EvalSymlinks(b)
	if err != nil {
		t.Fatal(err)
	}
	return real
}

func trusted(t *testing.T, data, key string) bool {
	t.Helper()
	var cfg struct {
		Projects map[string]map[string]any `json:"projects"`
	}
	if err := json.Unmarshal([]byte(data), &cfg); err != nil {
		t.Fatalf("not JSON: %v", err)
	}
	return cfg.Projects[key]["hasTrustDialogAccepted"] == true
}

func TestConfigPath(t *testing.T) {
	home, env := sandbox(t)
	if got := ConfigPath(env); got != filepath.Join(home, ".claude.json") {
		t.Fatalf("got %s", got)
	}
	cfg := t.TempDir()
	if got := ConfigPath([]string{"HOME=" + home, "CLAUDE_CONFIG_DIR=" + cfg}); got != filepath.Join(cfg, ".claude.json") {
		t.Fatalf("with CLAUDE_CONFIG_DIR: got %s", got)
	}
	if got := ConfigPath([]string{"HOME=" + home, "CLAUDE_CODE_CUSTOM_OAUTH_URL=https://x"}); got != filepath.Join(home, ".claude-custom-oauth.json") {
		t.Fatalf("custom oauth: got %s", got)
	}
	// A non-empty legacy .config.json in the config folder is the file Claude Code uses.
	write(t, filepath.Join(cfg, ".config.json"), "{}", 0o600)
	if got := ConfigPath([]string{"HOME=" + home, "CLAUDE_CONFIG_DIR=" + cfg}); got != filepath.Join(cfg, ".config.json") {
		t.Fatalf("legacy: got %s", got)
	}
	if got := ConfigPath(nil); got != "" {
		t.Fatalf("no env: got %s", got)
	}
}

func TestPreservesEverythingElse(t *testing.T) {
	home, env := sandbox(t)
	dir := project(t, home)
	cfg := filepath.Join(home, ".claude.json")
	orig := `{
  "numStartups": 12345678901234567890,
  "ratio": 0.1000000000000000055511151231257827,
  "oauthAccount": {"accountUuid": "x", "nested": {"a": [1, 2.50, {"b": null}]}},
  "projects": {
    "/elsewhere": {"allowedTools": ["Bash"], "hasTrustDialogAccepted": true, "lastCost": 1e-7}
  },
  "zLast": "<&>"
}`
	write(t, cfg, orig, 0o600)
	out, path, err := Ensure(dir, env)
	if err != nil || out != Written || path != cfg {
		t.Fatalf("Ensure = %v %s %v", out, path, err)
	}
	got := read(t, cfg)
	if !trusted(t, got, dir) {
		t.Fatalf("not trusted:\n%s", got)
	}
	for _, want := range []string{"12345678901234567890", "0.1000000000000000055511151231257827", "2.50", "1e-7", `"<&>"`, `"lastCost"`} {
		if !strings.Contains(got, want) {
			t.Errorf("lost %s:\n%s", want, got)
		}
	}
	// Same document apart from the new entry: compare the decoded values with numbers as written.
	dec := func(s string) map[string]any {
		d := json.NewDecoder(strings.NewReader(s))
		d.UseNumber()
		var m map[string]any
		if err := d.Decode(&m); err != nil {
			t.Fatal(err)
		}
		return m
	}
	a, b := dec(orig), dec(got)
	delete(b["projects"].(map[string]any), dir)
	ja, _ := json.Marshal(a)
	jb, _ := json.Marshal(b)
	if string(ja) != string(jb) {
		t.Fatalf("other content changed:\n%s\n%s", ja, jb)
	}
	// Key order is kept.
	if strings.Index(got, "numStartups") > strings.Index(got, "zLast") || strings.Index(got, `"/elsewhere"`) > strings.Index(got, `"`+dir+`"`) {
		t.Fatalf("order changed:\n%s", got)
	}
	if strings.HasSuffix(got, "\n") {
		t.Fatalf("a newline was added")
	}
}

func TestNoWriteWhenTrusted(t *testing.T) {
	home, env := sandbox(t)
	dir := project(t, home)
	cfg := filepath.Join(home, ".claude.json")
	write(t, cfg, `{"projects":{"`+dir+`":{"hasTrustDialogAccepted":true}}}`, 0o600)
	old := time.Now().Add(-time.Hour).Truncate(time.Second)
	_ = os.Chtimes(cfg, old, old)
	out, _, err := Ensure(dir, env)
	if err != nil || out != Trusted {
		t.Fatalf("Ensure = %v %v", out, err)
	}
	st, _ := os.Stat(cfg)
	if !st.ModTime().Equal(old) {
		t.Fatalf("file was written")
	}
	if _, err := os.Stat(cfg + ".lock"); !os.IsNotExist(err) {
		t.Fatalf("lock left behind")
	}
}

func TestCreatesAndUpdatesEntry(t *testing.T) {
	home, env := sandbox(t)
	dir := project(t, home)
	cfg := filepath.Join(home, ".claude.json")
	// No projects at all: a minimal entry.
	write(t, cfg, `{"theme":"dark"}`+"\n", 0o600)
	if out, _, err := Ensure(dir, env); err != nil || out != Written {
		t.Fatalf("Ensure = %v %v", out, err)
	}
	got := read(t, cfg)
	if !trusted(t, got, dir) || !strings.Contains(got, `"theme": "dark"`) || !strings.HasSuffix(got, "}\n") {
		t.Fatalf("got:\n%s", got)
	}
	// An entry with the flag false keeps its other fields.
	write(t, cfg, `{"projects":{"`+dir+`":{"allowedTools":[],"hasTrustDialogAccepted":false,"x":1}}}`, 0o600)
	if out, _, err := Ensure(dir, env); err != nil || out != Written {
		t.Fatalf("Ensure = %v %v", out, err)
	}
	got = read(t, cfg)
	if !trusted(t, got, dir) || !strings.Contains(got, `"x": 1`) || strings.Count(got, "hasTrustDialogAccepted") != 1 {
		t.Fatalf("got:\n%s", got)
	}
}

func TestMissingFileNotCreated(t *testing.T) {
	home, env := sandbox(t)
	dir := project(t, home)
	out, _, err := Ensure(dir, env)
	if err != nil || out != NoConfig {
		t.Fatalf("Ensure = %v %v", out, err)
	}
	if _, err := os.Stat(filepath.Join(home, ".claude.json")); !os.IsNotExist(err) {
		t.Fatalf("file was created")
	}
}

func TestInvalidJSONUntouched(t *testing.T) {
	home, env := sandbox(t)
	dir := project(t, home)
	cfg := filepath.Join(home, ".claude.json")
	for _, bad := range []string{`{"projects": {`, `[1,2]`, `{"projects": []}`, `{"projects": {"` + dir + `": 3}}`, `{} {}`} {
		write(t, cfg, bad, 0o600)
		if _, _, err := Ensure(dir, env); err == nil {
			t.Errorf("%s: no error", bad)
		}
		if got := read(t, cfg); got != bad {
			t.Errorf("%s: changed to %s", bad, got)
		}
	}
	entries, _ := os.ReadDir(home)
	for _, e := range entries {
		if strings.Contains(e.Name(), "minbox") || strings.HasSuffix(e.Name(), ".lock") {
			t.Errorf("left behind: %s", e.Name())
		}
	}
}

func TestPermissionsPreserved(t *testing.T) {
	home, env := sandbox(t)
	dir := project(t, home)
	cfg := filepath.Join(home, ".claude.json")
	write(t, cfg, `{}`, 0o640)
	if out, _, err := Ensure(dir, env); err != nil || out != Written {
		t.Fatalf("Ensure = %v %v", out, err)
	}
	st, _ := os.Stat(cfg)
	if st.Mode().Perm() != 0o640 {
		t.Fatalf("mode %v", st.Mode().Perm())
	}
}

func TestSymlinkedConfigStaysALink(t *testing.T) {
	home, env := sandbox(t)
	dir := project(t, home)
	real := filepath.Join(home, "dotfiles", "claude.json")
	_ = os.MkdirAll(filepath.Dir(real), 0o755)
	write(t, real, `{}`, 0o600)
	cfg := filepath.Join(home, ".claude.json")
	if err := os.Symlink(real, cfg); err != nil {
		t.Fatal(err)
	}
	if out, _, err := Ensure(dir, env); err != nil || out != Written {
		t.Fatalf("Ensure = %v %v", out, err)
	}
	if st, _ := os.Lstat(cfg); st.Mode()&os.ModeSymlink == 0 {
		t.Fatalf("the link was replaced")
	}
	if !trusted(t, read(t, real), dir) {
		t.Fatalf("target not updated")
	}
}

func TestRealpathKeys(t *testing.T) {
	home, env := sandbox(t)
	realDir := project(t, home)
	link := filepath.Join(home, "link")
	if err := os.Symlink(realDir, link); err != nil {
		t.Fatal(err)
	}
	cfg := filepath.Join(home, ".claude.json")
	write(t, cfg, `{}`, 0o600)
	if out, _, err := Ensure(link+"/", env); err != nil || out != Written {
		t.Fatalf("Ensure = %v %v", out, err)
	}
	got := read(t, cfg)
	if !trusted(t, got, link) || !trusted(t, got, realDir) {
		t.Fatalf("want both %s and %s:\n%s", link, realDir, got)
	}
}

func TestHomeAndRootSkipped(t *testing.T) {
	home, env := sandbox(t)
	cfg := filepath.Join(home, ".claude.json")
	write(t, cfg, `{}`, 0o600)
	for _, d := range []string{home, home + "/", "/", "relative/dir", ""} {
		if out, _, err := Ensure(d, env); err != nil || out != Skipped {
			t.Errorf("%q: %v %v", d, out, err)
		}
	}
	if read(t, cfg) != `{}` {
		t.Fatalf("written")
	}
}

func TestConcurrentChangeRetries(t *testing.T) {
	home, env := sandbox(t)
	dir := project(t, home)
	cfg := filepath.Join(home, ".claude.json")
	write(t, cfg, `{"n":0}`, 0o600)
	// Another writer (one that does not take the lock) changes the file between the read and the
	// rename, twice: each change makes minbox read again, and the last version is the one updated.
	n := 0
	testHook = func() {
		if n < 2 {
			n++
			write(t, cfg, `{"n":`+string(rune('0'+n))+`,"pad":"`+strings.Repeat("x", n)+`"}`, 0o600)
		}
	}
	defer func() { testHook = nil }()
	out, _, err := Ensure(dir, env)
	if err != nil || out != Written {
		t.Fatalf("Ensure = %v %v", out, err)
	}
	got := read(t, cfg)
	if !trusted(t, got, dir) || !strings.Contains(got, `"n": 2`) {
		t.Fatalf("got:\n%s", got)
	}
	// One that never stops changing it: minbox gives up and leaves the writer's version.
	n = -1000
	testHook = func() {
		n++
		write(t, cfg, `{"n":"`+strings.Repeat("y", n+1001)+`"}`, 0o600)
	}
	other := project(t, home)
	if _, _, err := Ensure(other, env); err == nil {
		t.Fatalf("no error")
	}
	if trusted(t, read(t, cfg), other) {
		t.Fatalf("written anyway")
	}
}

func TestWaitsForClaudesLock(t *testing.T) {
	home, env := sandbox(t)
	dir := project(t, home)
	cfg := filepath.Join(home, ".claude.json")
	write(t, cfg, `{}`, 0o600)
	if err := os.Mkdir(cfg+".lock", 0o755); err != nil {
		t.Fatal(err)
	}
	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		time.Sleep(150 * time.Millisecond)
		_ = os.Remove(cfg + ".lock")
	}()
	if out, _, err := Ensure(dir, env); err != nil || out != Written {
		t.Fatalf("Ensure = %v %v", out, err)
	}
	wg.Wait()

	// A lock held too long: left alone.
	defer func(w time.Duration) { LockWait = w }(LockWait)
	LockWait = 100 * time.Millisecond
	_ = os.Mkdir(cfg+".lock", 0o755)
	other := project(t, home)
	if _, _, err := Ensure(other, env); err == nil || trusted(t, read(t, cfg), other) {
		t.Fatalf("written under someone else's lock (%v)", err)
	}
	if _, err := os.Stat(cfg + ".lock"); err != nil {
		t.Fatalf("someone else's lock was removed")
	}
}

func TestRealHomeGuard(t *testing.T) {
	u, err := user.Current()
	if err != nil {
		t.Skip(err)
	}
	if !underRealHome(filepath.Join(u.HomeDir, ".claude.json")) || !underRealHome(filepath.Join(u.HomeDir, ".claude", ".claude.json")) {
		t.Fatal("the real home is not guarded")
	}
	if underRealHome(filepath.Join(t.TempDir(), ".claude.json")) || underRealHome(u.HomeDir+"-other/.claude.json") {
		t.Fatal("a temporary folder is guarded")
	}
}

func TestCLAUDE_CONFIG_DIR(t *testing.T) {
	home, _ := sandbox(t)
	cfgDir := t.TempDir()
	dir := project(t, home)
	write(t, filepath.Join(home, ".claude.json"), `{}`, 0o600)
	write(t, filepath.Join(cfgDir, ".claude.json"), `{}`, 0o600)
	if out, path, err := Ensure(dir, []string{"HOME=" + home, "CLAUDE_CONFIG_DIR=" + cfgDir}); err != nil || out != Written || path != filepath.Join(cfgDir, ".claude.json") {
		t.Fatalf("Ensure = %v %s %v", out, path, err)
	}
	if read(t, filepath.Join(home, ".claude.json")) != `{}` {
		t.Fatalf("the HOME file was written")
	}
}
