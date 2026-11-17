package hostfs

import (
	"context"
	"fmt"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestListTreeCapped(t *testing.T) {
	dir := t.TempDir()
	for i := range 30 {
		if err := os.WriteFile(filepath.Join(dir, fmt.Sprintf("f%02d.txt", i)), []byte("x"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	l := &Local{}
	tr, err := l.ListTree(context.Background(), dir, 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(tr.Paths) != 10 || !tr.Truncated {
		t.Fatalf("got %d paths, truncated %v", len(tr.Paths), tr.Truncated)
	}
	if _, err := l.ListTree(context.Background(), filepath.Join(dir, "f00.txt"), 0); err == nil {
		t.Fatal("a file listed as a folder")
	}
}

func TestParseGitStatus(t *testing.T) {
	in := "?? sub/new.txt\x00 M sub/a.go\x00R  sub/b.go\x00sub/old.go\x00A  top.txt\x00 D sub/gone\x00MM sub/both\x00!! sub/ign\x00UU sub/conflict\x00"
	got := parseGitStatus([]byte(in), "sub/", 100)
	want := []GitStatusEntry{{"new.txt", "untracked"}, {"a.go", "modified"}, {"b.go", "renamed"}, {"gone", "deleted"}, {"both", "modified"}, {"conflict", "modified"}}
	if fmt.Sprint(got) != fmt.Sprint(want) {
		t.Fatalf("got %v, want %v", got, want)
	}
	if got := parseGitStatus([]byte(in), "", 2); len(got) != 2 {
		t.Fatalf("limit: %v", got)
	}
}

func TestResolveUnder(t *testing.T) {
	root := t.TempDir()
	if _, err := resolveUnder(root, "../x"); err != ErrOutside {
		t.Fatalf("..: %v", err)
	}
	if _, err := resolveUnder(root, "/etc/passwd"); err != ErrOutside {
		t.Fatalf("abs: %v", err)
	}
	if _, err := resolveUnder(root, "missing"); !IsNotExist(err) {
		t.Fatalf("missing: %v", err)
	}
}

func TestTreeOverRemote(t *testing.T) {
	ts := httptest.NewServer(Handler(&Local{}))
	defer ts.Close()
	c := &Remote{Base: ts.URL}
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "a.txt"), []byte("a"), 0o644); err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	tr, err := c.ListTree(ctx, dir, 0)
	if err != nil || fmt.Sprint(tr.Paths) != "[a.txt]" {
		t.Fatalf("tree: %v %v", tr, err)
	}
	if st, err := c.TreeGitStatus(ctx, dir); err != nil || len(st) != 0 {
		t.Fatalf("status: %v %v", st, err)
	}
	if p, err := c.ResolveTreePath(ctx, dir, "a.txt"); err != nil || filepath.Base(p) != "a.txt" {
		t.Fatalf("resolve: %q %v", p, err)
	}
	if _, err := c.ResolveTreePath(ctx, dir, "../x"); err == nil || !strings.Contains(err.Error(), "outside") {
		t.Fatalf("resolve outside: %v", err)
	}
	if _, err := c.ResolveTreePath(ctx, dir, "nope"); !IsNotExist(err) {
		t.Fatalf("resolve missing: %v", err)
	}
}
