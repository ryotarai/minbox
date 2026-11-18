package server

import (
	"bytes"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
	"testing"
)

func treeWrite(t *testing.T, root string, files map[string]string) {
	t.Helper()
	for name, body := range files {
		p := filepath.Join(root, name)
		if strings.HasSuffix(name, "/") {
			if err := os.MkdirAll(p, 0o755); err != nil {
				t.Fatal(err)
			}
			continue
		}
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
}

func treeGit(t *testing.T, dir string, args ...string) {
	t.Helper()
	cmd := exec.Command("git", append([]string{"-C", dir, "-c", "user.email=t@example.invalid", "-c", "user.name=t", "-c", "commit.gpgsign=false"}, args...)...)
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("git %v: %v %s", args, err, out)
	}
}

func treeSession(t *testing.T, e *env, cwd string) string {
	t.Helper()
	code, obj, _ := e.do("POST", "/api/sessions", map[string]string{"cwd": cwd, "name": "files"}, nil)
	if code != 201 {
		t.Fatalf("create session: %d %v", code, obj)
	}
	return obj["id"].(string)
}

func treePaths(t *testing.T, e *env, id string) ([]string, map[string]any) {
	t.Helper()
	code, out, _ := e.do("GET", "/api/sessions/"+id+"/tree", nil, nil)
	if code != 200 {
		t.Fatalf("tree: %d %v", code, out)
	}
	paths := []string{}
	for _, p := range out["paths"].([]any) {
		paths = append(paths, p.(string))
	}
	sort.Strings(paths)
	return paths, out
}

func treeStatus(t *testing.T, e *env, id string) map[string]string {
	t.Helper()
	code, out, _ := e.do("GET", "/api/sessions/"+id+"/tree/status", nil, nil)
	if code != 200 {
		t.Fatalf("status: %d %v", code, out)
	}
	m := map[string]string{}
	for _, x := range out["entries"].([]any) {
		en := x.(map[string]any)
		m[en["path"].(string)] = en["status"].(string)
	}
	return m
}

func TestTreeInGitRepository(t *testing.T) {
	e := newEnv(t)
	repo := t.TempDir()
	treeWrite(t, repo, map[string]string{
		"README.md": "hi\n", "src/main.go": "package main\n", "src/old.go": "x\n", "gone.txt": "bye\n",
		"keep.txt": "k\n", ".gitignore": "*.log\n",
	})
	treeGit(t, repo, "init", "-q")
	treeGit(t, repo, "add", ".")
	treeGit(t, repo, "commit", "-qm", "init")
	treeWrite(t, repo, map[string]string{"src/main.go": "package main\n// changed\n", "new.txt": "n\n", "src/fresh/a.ts": "a\n", "debug.log": "noise\n", "staged.txt": "s\n"})
	treeGit(t, repo, "add", "staged.txt")
	treeGit(t, repo, "mv", "src/old.go", "src/renamed.go")
	if err := os.Remove(filepath.Join(repo, "gone.txt")); err != nil {
		t.Fatal(err)
	}

	id := treeSession(t, e, repo)
	paths, out := treePaths(t, e, id)
	if out["git"] != true || out["truncated"] != false {
		t.Fatalf("tree flags: %v", out)
	}
	// Tracked (also the deleted one, still in the index) and untracked; ignored left out.
	want := []string{".gitignore", "README.md", "gone.txt", "keep.txt", "new.txt", "src/fresh/a.ts", "src/main.go", "src/renamed.go", "staged.txt"}
	if !reflect.DeepEqual(paths, want) {
		t.Fatalf("paths = %q, want %q", paths, want)
	}
	st := treeStatus(t, e, id)
	wantSt := map[string]string{"src/main.go": "modified", "new.txt": "untracked", "src/fresh/a.ts": "untracked", "gone.txt": "deleted", "staged.txt": "added", "src/renamed.go": "renamed"}
	if !reflect.DeepEqual(st, wantSt) {
		t.Fatalf("status = %v, want %v", st, wantSt)
	}

	// A session in a subfolder: paths relative to it, nothing from outside.
	sub := treeSession(t, e, filepath.Join(repo, "src"))
	paths, _ = treePaths(t, e, sub)
	if !reflect.DeepEqual(paths, []string{"fresh/a.ts", "main.go", "renamed.go"}) {
		t.Fatalf("sub paths = %q", paths)
	}
	st = treeStatus(t, e, sub)
	if !reflect.DeepEqual(st, map[string]string{"main.go": "modified", "fresh/a.ts": "untracked", "renamed.go": "renamed"}) {
		t.Fatalf("sub status = %v", st)
	}
}

func TestTreeOutsideGit(t *testing.T) {
	e := newEnv(t)
	dir := t.TempDir()
	outside := t.TempDir()
	treeWrite(t, dir, map[string]string{"a.txt": "a", "lib/b.py": "b", "empty/": "", "node_modules/x/index.js": "x", ".venv/bin/python": "p", "deep/er/c.md": "c"})
	treeWrite(t, outside, map[string]string{"secret.txt": "s"})
	if err := os.Symlink(outside, filepath.Join(dir, "link")); err != nil {
		t.Fatal(err)
	}
	id := treeSession(t, e, dir)
	paths, out := treePaths(t, e, id)
	if out["git"] != false {
		t.Fatalf("git = %v", out["git"])
	}
	// Heavy folders skipped, an empty one kept, a symbolic link listed but not followed.
	want := []string{"a.txt", "deep/er/c.md", "empty/", "lib/b.py", "link"}
	if !reflect.DeepEqual(paths, want) {
		t.Fatalf("paths = %q, want %q", paths, want)
	}
	if st := treeStatus(t, e, id); len(st) != 0 {
		t.Fatalf("status outside git = %v", st)
	}
}

func treeGetRaw(t *testing.T, e *env, path string) (int, http.Header, []byte) {
	t.Helper()
	req, _ := http.NewRequest("GET", e.ts.URL+path, nil)
	resp, err := http.DefaultClient.Do(e.auth(req))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, resp.Header, b
}

func TestTreeFileContents(t *testing.T) {
	e := newEnv(t)
	base := t.TempDir()
	dir := filepath.Join(base, "proj")
	png := []byte{0x89, 'P', 'N', 'G', 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 0x0D, 'I', 'H', 'D', 'R', 0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0}
	treeWrite(t, dir, map[string]string{
		"src/main.go": "package main\n", "bin.dat": "ab\x00cd", "latin1.txt": "caf\xe9", ".env": "TOKEN=" + strings.Repeat("z", 8),
		"pic.png": string(png), "notpic.png": "plain text",
	})
	treeWrite(t, base, map[string]string{"outside.txt": "do not read", "proj2/x.txt": "sibling"})
	if err := os.WriteFile(filepath.Join(dir, "big.txt"), bytes.Repeat([]byte("a"), treeTextMax+1), 0o644); err != nil {
		t.Fatal(err)
	}
	_ = os.Symlink(filepath.Join(base, "outside.txt"), filepath.Join(dir, "escape.txt"))
	_ = os.Symlink(base, filepath.Join(dir, "up"))
	_ = os.Symlink(filepath.Join(dir, "src", "main.go"), filepath.Join(dir, "inside.go"))
	id := treeSession(t, e, dir)
	file := func(p string) (int, map[string]any) {
		t.Helper()
		code, out, _ := e.do("GET", "/api/sessions/"+id+"/tree/file?path="+url.QueryEscape(p), nil, nil)
		return code, out
	}

	code, out := file("src/main.go")
	if code != 200 || out["kind"] != "text" || out["text"] != "package main\n" || out["size"] != float64(13) {
		t.Fatalf("text: %d %v", code, out)
	}
	// A link that stays inside is read through.
	if code, out := file("inside.go"); code != 200 || out["text"] != "package main\n" {
		t.Fatalf("inside link: %d %v", code, out)
	}
	for p, kind := range map[string]string{"bin.dat": "binary", "latin1.txt": "binary", "big.txt": "too_large", ".env": "hidden", "pic.png": "image", "notpic.png": "text"} {
		code, out := file(p)
		if code != 200 || out["kind"] != kind {
			t.Fatalf("%s: %d %v, want kind %s", p, code, out, kind)
		}
		if kind != "text" && out["text"] != nil {
			t.Fatalf("%s: text sent for kind %s", p, kind)
		}
	}

	// Never outside the folder: .., absolute paths, links out, a sibling sharing the prefix.
	for _, p := range []string{"../outside.txt", "src/../../outside.txt", filepath.Join(base, "outside.txt"), "escape.txt", "up/outside.txt", "../proj2/x.txt", "", "src/\x00x"} {
		code, out := file(p)
		if code != 400 {
			t.Fatalf("%q: %d %v, want 400", p, code, out)
		}
		if s, _ := out["text"].(string); strings.Contains(s, "do not read") || strings.Contains(s, "sibling") {
			t.Fatalf("%q leaked the file", p)
		}
	}
	if code, _ := file("nope.txt"); code != 404 {
		t.Fatalf("missing: %d", code)
	}
	if code, _ := file("src"); code != 400 {
		t.Fatalf("folder: %d", code)
	}

	// Raw bytes: images only, with the safe headers.
	code, h, b := treeGetRaw(t, e, "/api/sessions/"+id+"/tree/raw?path=pic.png")
	if code != 200 || h.Get("Content-Type") != "image/png" || h.Get("X-Content-Type-Options") != "nosniff" || h.Get("Content-Security-Policy") != cspImage || !bytes.Equal(b, png) {
		t.Fatalf("raw png: %d %v", code, h)
	}
	for _, p := range []string{"notpic.png", "src/main.go", ".env"} {
		if code, _, _ := treeGetRaw(t, e, "/api/sessions/"+id+"/tree/raw?path="+url.QueryEscape(p)); code != 415 {
			t.Fatalf("raw %s: %d, want 415", p, code)
		}
	}
	if code, _, _ := treeGetRaw(t, e, "/api/sessions/"+id+"/tree/raw?path="+url.QueryEscape("../outside.txt")); code != 400 {
		t.Fatalf("raw outside: %d", code)
	}
	if code, _, _ := treeGetRaw(t, e, "/api/sessions/nope/tree"); code != 404 {
		t.Fatalf("unknown session: %d", code)
	}
}
