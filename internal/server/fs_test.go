package server

import (
	"net/url"
	"os"
	"path/filepath"
	"testing"
)

func TestListDirsShowsFoldersAndGitBranches(t *testing.T) {
	e := newEnv(t)
	root := t.TempDir()
	repo := filepath.Join(root, "repo")
	os.MkdirAll(filepath.Join(repo, ".git"), 0o755)
	os.WriteFile(filepath.Join(repo, ".git", "HEAD"), []byte("ref: refs/heads/main\n"), 0o644)
	os.MkdirAll(filepath.Join(root, "plain"), 0o755)
	os.MkdirAll(filepath.Join(root, ".hidden"), 0o755)
	os.WriteFile(filepath.Join(root, "file.txt"), []byte("x"), 0o644)
	// A worktree of repo, outside it.
	wt := filepath.Join(root, "wt")
	os.MkdirAll(wt, 0o755)
	os.MkdirAll(filepath.Join(repo, ".git", "worktrees", "wt"), 0o755)
	os.WriteFile(filepath.Join(repo, ".git", "worktrees", "wt", "gitdir"), []byte(filepath.Join(wt, ".git")+"\n"), 0o644)
	os.WriteFile(filepath.Join(repo, ".git", "worktrees", "wt", "HEAD"), []byte("ref: refs/heads/feature\n"), 0o644)
	os.WriteFile(filepath.Join(wt, ".git"), []byte("gitdir: "+filepath.Join(repo, ".git", "worktrees", "wt")+"\n"), 0o644)

	code, body, _ := e.do("GET", "/api/fs/dirs?path="+url.QueryEscape(root), nil, nil)
	if code != 200 {
		t.Fatalf("code %d %v", code, body)
	}
	var names []string
	for _, x := range body["entries"].([]any) {
		names = append(names, x.(map[string]any)["name"].(string))
	}
	if got := len(names); got != 4 || names[0] != "." || names[1] != "plain" || names[2] != "repo" || names[3] != "wt" {
		t.Fatalf("entries = %v", names)
	}
	repoEntry := body["entries"].([]any)[2].(map[string]any)
	if repoEntry["git"] != true || repoEntry["branch"] != "main" {
		t.Fatalf("repo = %v", repoEntry)
	}
	if wtEntry := body["entries"].([]any)[3].(map[string]any); wtEntry["branch"] != "feature" {
		t.Fatalf("worktree = %v", wtEntry)
	}

	// Inside the repo, its worktree is listed too.
	_, body, _ = e.do("GET", "/api/fs/dirs?path="+url.QueryEscape(repo), nil, nil)
	ents := body["entries"].([]any)
	if last := ents[len(ents)-1].(map[string]any); last["path"] != wt || last["branch"] != "feature" {
		t.Fatalf("repo listing = %v", ents)
	}

	if code, _, _ := e.do("GET", "/api/fs/dirs?path="+url.QueryEscape(filepath.Join(root, "nope")), nil, nil); code != 404 {
		t.Fatalf("missing folder: %d", code)
	}
}

func TestMakeDir(t *testing.T) {
	e := newEnv(t)
	dir := filepath.Join(t.TempDir(), "new", "folder")
	if code, body, _ := e.do("POST", "/api/fs/mkdir", map[string]string{"path": dir}, nil); code != 201 {
		t.Fatalf("code %d %v", code, body)
	}
	if st, err := os.Stat(dir); err != nil || !st.IsDir() {
		t.Fatal("not created")
	}
	if code, _, _ := e.do("POST", "/api/fs/mkdir", map[string]string{"path": dir}, nil); code != 409 {
		t.Fatalf("again: %d", code)
	}
}
