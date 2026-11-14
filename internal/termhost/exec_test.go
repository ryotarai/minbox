package termhost

import (
	"context"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestExecAndLookPath(t *testing.T) {
	bin := t.TempDir()
	os.WriteFile(filepath.Join(bin, "tool"), []byte("#!/bin/sh\necho \"args=$* ext=$EXT cfg=$OPENCODE_CONFIG_CONTENT\"; cat; echo err >&2; exit ${CODE:-0}\n"), 0o755)
	t.Setenv("PATH", bin+":/usr/bin:/bin")
	t.Setenv("OPENCODE_CONFIG_CONTENT", `{"model":"a/b","plugins":[{"package":"/mine"}]}`)
	t.Setenv("MINBOX_TOKEN", "server-secret") // not handed on (CleanEnv)
	h := New()
	h.PiExtension, h.OpenCodePlugin = "/host/pi/minbox.ts", `/host/"oc"`
	ts := httptest.NewServer(h.Handler())
	defer ts.Close()
	c := NewHTTPClient(ts.URL, nil, 1)
	ctx := context.Background()

	res, err := c.Exec(ctx, ExecRequest{
		Argv:  []string{"tool", PiExtensionPlaceholder},
		Env:   []string{"EXT=" + PiExtensionPlaceholder, `OPENCODE_CONFIG_CONTENT={"plugins":[{"package":"` + OpenCodePluginPlaceholder + `"}]}`, "CODE=3"},
		Stdin: "in",
	})
	if err != nil {
		t.Fatal(err)
	}
	want := `args=/host/pi/minbox.ts ext=/host/pi/minbox.ts cfg={"model":"a/b","plugins":[{"package":"/mine"},{"package":"/host/\"oc\""}]}` + "\nin"
	if res.ExitCode != 3 || string(res.Stdout) != want || res.Stderr != "err\n" || res.Error != "" {
		t.Fatalf("exec = %+v (stdout %q)", res, res.Stdout)
	}
	res, _ = c.Exec(ctx, ExecRequest{Argv: []string{"/bin/sh", "-c", "echo ${MINBOX_TOKEN:-none}; pwd"}, Dir: bin})
	if got := string(res.Stdout); !strings.HasPrefix(got, "none\n") || !strings.HasSuffix(got, filepath.Base(bin)+"\n") {
		t.Fatalf("env/dir = %q", got)
	}
	if res, _ = c.Exec(ctx, ExecRequest{Argv: []string{"no-such-tool-x"}}); !res.NotFound || res.ExitCode != -1 {
		t.Fatalf("missing = %+v", res)
	}
	if res, _ = c.Exec(ctx, ExecRequest{Argv: []string{"/bin/sleep", "5"}, TimeoutMs: 200}); !res.TimedOut {
		t.Fatalf("timeout = %+v", res)
	}
	paths, err := c.LookPath(ctx, []string{"tool", "sh", "no-such-tool-x"})
	if err != nil || paths["tool"] != filepath.Join(bin, "tool") || paths["sh"] == "" || paths["no-such-tool-x"] != "" {
		t.Fatalf("lookpath = %v %v", paths, err)
	}
}

func TestMergeOpenCodeConfig(t *testing.T) {
	ours := `{"plugins":[{"package":"/p"}]}`
	for _, c := range []struct{ existing, want string }{
		{"", ours},
		{"not json", ours},
		{`{"model":"x"}`, `{"model":"x","plugins":[{"package":"/p"}]}`},
	} {
		if got := mergeOpenCodeConfig(c.existing, ours); got != c.want {
			t.Errorf("merge(%q) = %q, want %q", c.existing, got, c.want)
		}
	}
}

// A spawn fills in the host's Pi extension and OpenCode plugin.
func TestSpawnFillsInAgentFiles(t *testing.T) {
	h := New()
	h.PiExtension, h.PiSubagent, h.OpenCodePlugin = "/h/pi/minbox.ts", "/h/pi/subagent.ts", "/h/opencode"
	out := filepath.Join(t.TempDir(), "out")
	_, err := h.Spawn(SpawnRequest{ID: "s", Argv: []string{"/bin/sh", "-c", `echo "$1 $2 $OPENCODE_CONFIG_CONTENT" > ` + out, "sh", PiExtensionPlaceholder, PiSubagentPlaceholder},
		Env: []string{`OPENCODE_CONFIG_CONTENT={"plugins":[{"package":"` + OpenCodePluginPlaceholder + `"}]}`}})
	if err != nil {
		t.Fatal(err)
	}
	defer h.KillAll()
	var b []byte
	for i := 0; i < 100 && len(b) == 0; i++ {
		b, _ = os.ReadFile(out)
		if len(b) == 0 {
			time.Sleep(50 * time.Millisecond)
		}
	}
	if got := strings.TrimSpace(string(b)); got != `/h/pi/minbox.ts /h/pi/subagent.ts {"plugins":[{"package":"/h/opencode"}]}` {
		t.Fatalf("spawned with %q", got)
	}
}
