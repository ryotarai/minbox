package termhost

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// A spawn flagged TrustClaudeFolder marks its folder trusted in the Claude Code config of the
// environment it starts with (here a temporary CLAUDE_CONFIG_DIR); one without the flag does not.
func TestSpawnTrustsClaudeFolder(t *testing.T) {
	cfgDir := t.TempDir()
	t.Setenv("HOME", t.TempDir())
	t.Setenv("CLAUDE_CONFIG_DIR", "")
	cfg := filepath.Join(cfgDir, ".claude.json")
	if err := os.WriteFile(cfg, []byte(`{"keep":1}`), 0o600); err != nil {
		t.Fatal(err)
	}
	// Through the HTTP API: the flag travels in the spawn request.
	c := NewClient(startHost(t, New()), 1)
	ctx := context.Background()
	plain, flagged := t.TempDir(), t.TempDir()
	for _, c0 := range []struct {
		id, dir string
		flag    bool
	}{{"plain", plain, false}, {"flagged", flagged, true}} {
		defer c.Kill(ctx, c0.id)
		if _, err := c.Spawn(ctx, SpawnRequest{ID: c0.id, Argv: []string{"/bin/sleep", "30"}, Cwd: c0.dir, Env: []string{"CLAUDE_CONFIG_DIR=" + cfgDir}, InheritEnv: true, TrustClaudeFolder: c0.flag}); err != nil {
			t.Fatal(err)
		}
	}
	b, _ := os.ReadFile(cfg)
	if !strings.Contains(string(b), `"`+flagged+`": {`) || strings.Contains(string(b), `"`+plain+`"`) || !strings.Contains(string(b), `"keep": 1`) {
		t.Fatalf("config = %s", b)
	}
}
