package agent_test

import (
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"github.com/ryotarai/minbox/internal/agent"
	"github.com/ryotarai/minbox/plugin"
)

// The agents are started with the copies of the mod and the extensions that the binary extracts
// into its data directory: nothing has to be installed next to the binary.
func TestSpawnArgsPointAtExtractedPlugins(t *testing.T) {
	t.Setenv(plugin.SourceEnv, "")
	data := t.TempDir()

	modDir, err := plugin.Extract(filepath.Join(data, "plugin"))
	if err != nil {
		t.Fatal(err)
	}
	argv := agent.Must(agent.Claude).Argv(agent.ArgvReq{Command: []string{"claude"}, Extension: modDir, ConversationID: "c", Instructions: "T"})
	i := slices.Index(argv, "--plugin-dir")
	if i < 0 || argv[i+1] != modDir {
		t.Fatalf("claude argv %q does not load %s", argv, modDir)
	}
	if _, err := os.Stat(filepath.Join(argv[i+1], ".claude-plugin", "plugin.json")); err != nil {
		t.Fatalf("--plugin-dir is not a Claude Code plugin: %v", err)
	}

	piExt, err := plugin.ExtractPi(filepath.Join(data, "pi-extension"))
	if err != nil {
		t.Fatal(err)
	}
	argv = agent.Must(agent.Pi).Argv(agent.ArgvReq{Command: []string{"pi"}, Extension: piExt, ExtraExtensions: []string{plugin.PiSubagentPath(piExt)}, ConversationID: "c", Instructions: "T"})
	for _, want := range []string{piExt, plugin.PiSubagentPath(piExt)} {
		j := slices.Index(argv, want)
		if j < 1 || argv[j-1] != "-e" {
			t.Fatalf("pi argv %q does not load %s", argv, want)
		}
		if _, err := os.Stat(want); err != nil {
			t.Fatal(err)
		}
	}
	for _, p := range []string{modDir, piExt} {
		rel, err := filepath.Rel(data, p)
		if err != nil || filepath.IsAbs(rel) || strings.HasPrefix(rel, "..") {
			t.Fatalf("%s is outside the data dir %s", p, data)
		}
	}
}
