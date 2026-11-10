package plugin

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// The subagent extension, the busy marker it shares with minbox.ts and the role definitions are
// extracted next to the entry; tests are not.
func TestExtractPiSubagent(t *testing.T) {
	entry, err := ExtractPi(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	sub := PiSubagentPath(entry)
	if filepath.Base(sub) != "subagent.ts" || filepath.Dir(sub) != filepath.Dir(entry) {
		t.Fatalf("subagent path = %s", sub)
	}
	dir := filepath.Dir(entry)
	for _, f := range []string{"subagent.ts", "busy.ts", "agents/scout.md", "agents/planner.md", "agents/reviewer.md", "agents/worker.md"} {
		if _, err := os.Stat(filepath.Join(dir, f)); err != nil {
			t.Fatalf("%s not extracted: %v", f, err)
		}
	}
	for _, f := range []string{"minbox.test.ts", "subagent.test.ts"} {
		if _, err := os.Stat(filepath.Join(dir, f)); err == nil {
			t.Fatalf("%s was extracted", f)
		}
	}
	for _, f := range []string{"minbox.ts", "subagent.ts"} {
		src, _ := os.ReadFile(filepath.Join(dir, f))
		if !strings.Contains(string(src), "./busy.ts") {
			t.Fatalf("%s does not use the shared busy marker", f)
		}
	}
}
