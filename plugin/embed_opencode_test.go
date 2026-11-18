package plugin

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestExtractOpenCode(t *testing.T) {
	root := t.TempDir()
	dir, err := ExtractOpenCode(root)
	if err != nil {
		t.Fatal(err)
	}
	if filepath.Base(dir) != "opencode" {
		t.Fatalf("dir = %s", dir)
	}
	// OpenCode loads the folder's index.ts (a plain {id, setup} object; verified with 2.1.4).
	idx, err := os.ReadFile(filepath.Join(dir, "index.ts"))
	if err != nil || !strings.Contains(string(idx), "setup") {
		t.Fatalf("index.ts: %v", err)
	}
	src, err := os.ReadFile(filepath.Join(dir, "minbox.ts"))
	if err != nil {
		t.Fatal(err)
	}
	for _, shared := range []string{"proxy.ts"} {
		if !strings.Contains(string(src), "'../minbox/hooks/"+shared+"'") {
			t.Fatalf("the plugin no longer imports ../minbox/hooks/%s: update openCodeSources", shared)
		}
		if _, err := os.Stat(filepath.Join(dir, "..", "minbox", "hooks", shared)); err != nil {
			t.Fatalf("shared %s missing next to the plugin: %v", shared, err)
		}
	}
	for _, not := range []string{"minbox.test.ts", "test"} {
		if _, err := os.Stat(filepath.Join(dir, not)); err == nil {
			t.Fatalf("%s was extracted", not)
		}
	}
	again, err := ExtractOpenCode(root)
	if err != nil || again != dir {
		t.Fatalf("second extract: %s %v", again, err)
	}
}
