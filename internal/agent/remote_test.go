package agent

import (
	"context"
	"errors"
	"strings"
	"testing"
)

func TestJudgeNodeForPi(t *testing.T) {
	for _, c := range []struct {
		out string
		ok  bool
	}{
		{"v22.19.0", true}, {"v22.20.1\n", true}, {"v23.0.0", true}, {"v26.12.1", true},
		{"v22.18.9", false}, {"v20.11.1", false}, {"node", false},
	} {
		if _, ok, reason := JudgeNodeForPi(c.out); ok != c.ok || (!ok && !strings.Contains(reason, "22.19")) {
			t.Errorf("%q: ok=%v reason=%q", c.out, ok, reason)
		}
	}
}

func TestProbeHost(t *testing.T) {
	cmds := Commands{Claude: {"claude"}, Pi: {"pi", "--model", "x"}, OpenCode: {"opencode", "--model", "y"}}
	paths := map[string]string{"claude": "", "pi": "/h/pi", "opencode": "/h/opencode", "node": "/h/node"}
	var ran [][]string
	look := func(_ context.Context, names []string) (map[string]string, error) {
		out := map[string]string{}
		for _, n := range names {
			out[n] = paths[n]
		}
		return out, nil
	}
	run := func(_ context.Context, argv []string, _ string, _ []string, _ string) ([]byte, error) {
		ran = append(ran, argv)
		switch argv[0] {
		case "/h/node":
			return []byte("v22.19.0\n"), nil
		case "/h/opencode":
			return []byte("opencode v2.1.4\n"), nil
		}
		return nil, errors.New("unexpected")
	}
	infos := ProbeHost(context.Background(), cmds, look, run)
	if len(infos) != 3 || infos[0].Installed || infos[0].Reason != "not installed" {
		t.Fatalf("claude = %+v", infos[0])
	}
	if pi := infos[1]; !pi.Installed || !pi.Supported || pi.Path != "/h/pi" || pi.Version != "node 22.19.0" {
		t.Fatalf("pi = %+v", pi)
	}
	if oc := infos[2]; !oc.Installed || !oc.Supported || oc.Version != "2.1.4" {
		t.Fatalf("opencode = %+v", oc)
	}
	// Pi itself is never run; OpenCode's TUI flags are not passed to --version.
	if len(ran) != 2 || strings.Join(ran[1], " ") != "/h/opencode --version" {
		t.Fatalf("ran %q", ran)
	}
	if k := ChooseIn(infos, ""); k != Pi {
		t.Fatalf("choose = %s", k)
	}
	if k := ChooseIn(infos, OpenCode); k != OpenCode {
		t.Fatalf("choose opencode = %s", k)
	}

	paths["node"] = ""
	infos = ProbeHost(context.Background(), cmds, look, run)
	if pi := infos[1]; pi.Supported || !strings.Contains(pi.Reason, "Node.js is not on the host's PATH") {
		t.Fatalf("pi without node = %+v", pi)
	}
	failing := func(context.Context, []string) (map[string]string, error) { return nil, errors.New("gone") }
	for _, i := range ProbeHost(context.Background(), cmds, failing, run) {
		if i.Installed || !strings.Contains(i.Reason, "gone") {
			t.Fatalf("host unreachable: %+v", i)
		}
	}
}
