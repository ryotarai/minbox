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
	if !strings.Contains(string(src), "'../minbox/hooks/text.ts'") {
		t.Fatal("the extension no longer imports ../minbox/hooks/text.ts: update piSources")
	}
	if _, err := os.Stat(filepath.Join(filepath.Dir(entry), "..", "minbox", "hooks", "text.ts")); err != nil {
		t.Fatalf("shared text.ts missing next to the extension: %v", err)
	}
	if !strings.Contains(string(src), "'../minbox/hooks/nav.ts'") {
		t.Fatal("the extension no longer imports ../minbox/hooks/nav.ts: update piSources")
	}
	if _, err := os.Stat(filepath.Join(filepath.Dir(entry), "..", "minbox", "hooks", "nav.ts")); err != nil {
		t.Fatalf("shared nav.ts missing next to the extension: %v", err)
	}
	if !strings.Contains(string(src), "'../minbox/hooks/denied.ts'") {
		t.Fatal("the extension no longer imports ../minbox/hooks/denied.ts: update piSources")
	}
	if _, err := os.Stat(filepath.Join(filepath.Dir(entry), "..", "minbox", "hooks", "denied.ts")); err != nil {
		t.Fatalf("shared denied.ts missing next to the extension: %v", err)
	}
	if _, err := os.Stat(filepath.Join(filepath.Dir(entry), "minbox.test.ts")); err == nil {
		t.Fatal("the test file was extracted")
	}
	again, err := ExtractPi(root)
	if err != nil || again != entry {
		t.Fatalf("second extract: %s %v", again, err)
	}
}
