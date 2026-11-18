package plugin

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// The Pi extension is extracted with the shared text helpers at the relative path it imports.
func TestExtractPi(t *testing.T) {
	root := t.TempDir()
	entry, err := ExtractPi(root)
	if err != nil {
		t.Fatal(err)
	}
	if filepath.Base(entry) != "minbox.ts" || filepath.Base(filepath.Dir(entry)) != "pi" {
		t.Fatalf("entry = %s", entry)
	}
	src, err := os.ReadFile(entry)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(src), "'../minbox/hooks/proxy.ts'") {
		t.Fatal("the extension no longer imports ../minbox/hooks/proxy.ts: update piSources")
	}
	if _, err := os.Stat(filepath.Join(filepath.Dir(entry), "..", "minbox", "hooks", "proxy.ts")); err != nil {
		t.Fatalf("shared proxy.ts missing next to the extension: %v", err)
	}
	if _, err := os.Stat(filepath.Join(filepath.Dir(entry), "minbox.test.ts")); err == nil {
		t.Fatal("the test file was extracted")
	}
	again, err := ExtractPi(root)
	if err != nil || again != entry {
		t.Fatalf("second extract: %s %v", again, err)
	}
}
