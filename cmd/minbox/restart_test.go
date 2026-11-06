package main

import (
	"bytes"
	"errors"
	"slices"
	"strings"
	"testing"
)

func TestSavedStartArgsCollapsesAndIsStable(t *testing.T) {
	want := []string{"--tailscale", "--tailscale-port", "8443"}
	bloated := slices.Clone(want)
	for i := 0; i < 20; i++ {
		bloated = append(bloated, "--data-dir", "/d", "--data-dir=/d", "--no-open", "--foreground")
	}
	cur := savedStartArgs(bloated)
	if !slices.Equal(cur, want) {
		t.Fatalf("got %v, want %v", cur, want)
	}
	for i := 0; i < 5; i++ {
		launch := append(withoutValueFlag(withoutFlag(cur, "no-open"), "data-dir"), "--no-open", "--data-dir", "/d")
		cur = savedStartArgs(launch)
		if !slices.Equal(cur, want) {
			t.Fatalf("round %d: got %v", i, cur)
		}
	}
}

type fakeRestart struct {
	calls      []string
	tty        bool
	hostN      int
	hostUp     bool
	serverUp   bool
	startArgs  []string
	startError error
}

func (f *fakeRestart) deps() restartDeps {
	return restartDeps{
		stdinIsTTY:   func() bool { return f.tty },
		hostSessions: func(string) (int, bool) { f.calls = append(f.calls, "count"); return f.hostN, f.hostUp },
		stopServer:   func(string) (int, bool, error) { f.calls = append(f.calls, "stopServer"); return 11, f.serverUp, nil },
		stopHost:     func(string) (int, bool, error) { f.calls = append(f.calls, "stopHost"); return 22, f.hostUp, nil },
		startServer: func(a []string) error {
			f.calls = append(f.calls, "start")
			f.startArgs = a
			return f.startError
		},
	}
}

func run(t *testing.T, f *fakeRestart, in string, args ...string) (string, error) {
	t.Helper()
	var out bytes.Buffer
	err := restartRun(append([]string{"--data-dir", t.TempDir()}, args...), f.deps(), strings.NewReader(in), &out)
	return out.String(), err
}

func TestRestartWithoutHostIsUnchanged(t *testing.T) {
	f := &fakeRestart{serverUp: true, hostUp: true, hostN: 3}
	out, err := run(t, f, "")
	if err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(f.calls, []string{"stopServer", "start"}) {
		t.Fatalf("calls = %v", f.calls)
	}
	if strings.Contains(out, "Restart the terminal host") {
		t.Fatalf("asked without --host: %q", out)
	}
}

func TestRestartHostFlagsNotPassedToStart(t *testing.T) {
	f := &fakeRestart{serverUp: true, hostUp: true, hostN: 1, tty: true}
	if _, err := run(t, f, "", "--host", "-y", "--addr", "127.0.0.1:9999"); err != nil {
		t.Fatal(err)
	}
	for _, a := range f.startArgs {
		if a == "--host" || a == "-y" || a == "--yes" {
			t.Fatalf("start args carry %q: %v", a, f.startArgs)
		}
	}
	if !slices.Contains(f.startArgs, "--addr") || !slices.Contains(f.startArgs, "--no-open") {
		t.Fatalf("start args = %v", f.startArgs)
	}
	if !slices.Equal(f.calls, []string{"count", "stopServer", "stopHost", "start"}) {
		t.Fatalf("calls = %v", f.calls)
	}
}

func TestRestartHostConfirm(t *testing.T) {
	for _, tc := range []struct {
		in   string
		want bool
	}{{"y\n", true}, {"YES\n", true}, {"n\n", false}, {"\n", false}, {"", false}, {"maybe\n", false}} {
		f := &fakeRestart{serverUp: true, hostUp: true, hostN: 3, tty: true}
		out, err := run(t, f, tc.in, "--host")
		if err != nil {
			t.Fatal(err)
		}
		if !strings.Contains(out, "3 sessions' claude will stop and resume") || !strings.Contains(out, "[y/N]") {
			t.Fatalf("prompt = %q", out)
		}
		if got := slices.Contains(f.calls, "stopHost"); got != tc.want {
			t.Fatalf("input %q: stopHost = %v, calls %v", tc.in, got, f.calls)
		}
		if !tc.want && (slices.Contains(f.calls, "stopServer") || slices.Contains(f.calls, "start")) {
			t.Fatalf("declined but acted: %v", f.calls)
		}
	}
}

func TestRestartHostRefusesWithoutTTY(t *testing.T) {
	f := &fakeRestart{serverUp: true, hostUp: true, hostN: 2, tty: false}
	_, err := run(t, f, "y\n", "--host")
	var ee *exitError
	if !errors.As(err, &ee) || ee.code != 2 {
		t.Fatalf("err = %v", err)
	}
	if !slices.Equal(f.calls, []string{"count"}) {
		t.Fatalf("calls = %v", f.calls)
	}
}

func TestRestartHostYesSkipsQuestionWithoutTTY(t *testing.T) {
	f := &fakeRestart{serverUp: true, hostUp: true, hostN: 2}
	out, err := run(t, f, "", "--host", "--yes")
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(out, "[y/N]") || !slices.Contains(f.calls, "stopHost") {
		t.Fatalf("out %q calls %v", out, f.calls)
	}
}

func TestRestartHostNotRunningNeedsNoConfirmation(t *testing.T) {
	f := &fakeRestart{tty: false}
	out, err := run(t, f, "", "--host")
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(out, "[y/N]") || !slices.Equal(f.calls, []string{"count", "stopServer", "stopHost", "start"}) {
		t.Fatalf("out %q calls %v", out, f.calls)
	}
}
