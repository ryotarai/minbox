package server

import (
	"fmt"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"testing"
)

func TestSessionFilesForMentions(t *testing.T) {
	e := newEnv(t)
	sess := e.createSession()
	home := t.TempDir()
	t.Setenv("HOME", home)
	root := e.dir
	mk := func(dir string, names ...string) {
		for _, n := range names {
			p := filepath.Join(dir, n)
			if n[len(n)-1] == '/' {
				_ = os.MkdirAll(p, 0o755)
			} else {
				_ = os.MkdirAll(filepath.Dir(p), 0o755)
				_ = os.WriteFile(p, []byte("x"), 0o644)
			}
		}
	}
	mk(root, "src/", "src/main.go", "src/util.go", "docs/", "zeta.txt", "alpha.txt", "node_modules/", "node_modules/x.js", ".git/", ".env", "my dir/", "my dir/a b.txt", "build.log")
	if out, err := exec.Command("git", "-C", root, "init", "-q").CombinedOutput(); err != nil {
		t.Fatalf("git init: %v %s", err, out)
	}
	_ = os.WriteFile(filepath.Join(root, ".gitignore"), []byte("*.log\ndb*\nserver-key\ndevices.json\ndevice-pairing/\n"), 0o644)
	mk(home, "notes.md", "proj/")

	list := func(prefix string) []string {
		t.Helper()
		code, out, _ := e.do("GET", "/api/sessions/"+sess.ID+"/files?prefix="+url.QueryEscape(prefix), nil, nil)
		if code != 200 {
			t.Fatalf("files %q: %d %v", prefix, code, out)
		}
		paths := []string{}
		for _, x := range out["entries"].([]any) {
			paths = append(paths, x.(map[string]any)["path"].(string))
		}
		return paths
	}
	eq := func(got, want []string) {
		t.Helper()
		if !reflect.DeepEqual(got, want) {
			t.Fatalf("got %q, want %q", got, want)
		}
	}

	// Folders first, then names; junk, hidden and git-ignored left out.
	eq(list(""), []string{"docs/", "my dir/", "src/", "alpha.txt", "zeta.txt"})
	// Prefix before substring before in-order letters; ignored shows once typed.
	eq(list("alp"), []string{"alpha.txt"})
	eq(list("txt"), []string{"alpha.txt", "zeta.txt"})
	eq(list("buil"), []string{"build.log"})
	eq(list("zt"), []string{"zeta.txt"})
	// Asked-for junk.
	eq(list("node"), []string{"node_modules/"})
	eq(list(".env"), []string{".env"})
	// Into a folder: the typed folder part is kept.
	eq(list("src/"), []string{"src/main.go", "src/util.go"})
	eq(list("src/u"), []string{"src/util.go"})
	eq(list("my dir/"), []string{"my dir/a b.txt"})
	eq(list("nope/"), []string{})
	eq(list("zeta.txt/"), []string{})
	// Above the session folder, and absolute / home paths.
	eq(list("src/../alp"), []string{"src/../alpha.txt"})
	if got := list("../"); len(got) == 0 || got[0][:3] != "../" {
		t.Fatalf("../ = %q", got)
	}
	eq(list(root+"/src"), []string{root + "/src/"})
	eq(list("~/"), []string{"~/proj/", "~/notes.md"})
	eq(list("~"), []string{"~/"})

	// The cap.
	big := filepath.Join(root, "big")
	for i := 0; i < 80; i++ {
		_ = os.WriteFile(filepath.Join(big, fmt.Sprintf("f%02d", i)), nil, 0o644)
		if i == 0 {
			_ = os.MkdirAll(big, 0o755)
			_ = os.WriteFile(filepath.Join(big, "f00"), nil, 0o644)
		}
	}
	if got := list("big/"); len(got) != 50 {
		t.Fatalf("cap: %d entries", len(got))
	}

	if code, _, _ := e.do("GET", "/api/sessions/nope/files", nil, nil); code != 404 {
		t.Fatalf("unknown session: %d", code)
	}
}
