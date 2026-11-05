package main

import (
	"bufio"
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"log"
	"net"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"github.com/ryotarai/minbox/internal/server"
	"github.com/ryotarai/minbox/internal/termhost"
)

// exitError is an error that ends the process with a given exit code.
type exitError struct {
	code int
	msg  string
}

func (e *exitError) Error() string { return e.msg }

// restartDeps are the actions and checks `minbox restart` makes, so tests can
// replace them and touch no process.
type restartDeps struct {
	stdinIsTTY func() bool
	// hostSessions: whether a terminal host answers on dataDir's socket and how
	// many terminals run in it (-1: it runs but would not list them).
	hostSessions func(dataDir string) (n int, running bool)
	stopServer   func(dataDir string) (pid int, stopped bool, err error)
	stopHost     func(dataDir string) (pid int, running bool, err error)
	startServer  func(args []string) error
}

func realRestartDeps() restartDeps {
	return restartDeps{
		stdinIsTTY: func() bool {
			st, err := os.Stdin.Stat()
			return err == nil && st.Mode()&os.ModeCharDevice != 0
		},
		hostSessions: func(dataDir string) (int, bool) {
			sock := socketPath(dataDir)
			c, err := net.DialTimeout("unix", sock, time.Second)
			if err != nil {
				return 0, false
			}
			c.Close()
			ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
			defer cancel()
			list, err := termhost.NewClient(sock, server.ProtocolVersion).List(ctx)
			if err != nil {
				return -1, true
			}
			n := 0
			for _, t := range list {
				if t.Running {
					n++
				}
			}
			return n, true
		},
		stopServer: stopServer,
		stopHost: func(dataDir string) (int, bool, error) {
			return termhost.Stop(context.Background(), socketPath(dataDir), server.ProtocolVersion, log.Printf)
		},
		startServer: startCmd,
	}
}

// restartCmd stops the server and starts it again: with the flags given, or
// else with those of the last `minbox start` (never opening the browser).
// With --host it stops the local terminal host in between, after asking.
func restartCmd(args []string) error {
	return restartRun(args, realRestartDeps(), os.Stdin, os.Stdout)
}

func restartRun(args []string, d restartDeps, in io.Reader, out io.Writer) error {
	// Parse with the start flags themselves, so --data-dir is read wherever it
	// stands among them (and an unknown flag stops here, before anything stops).
	f := newServeFlags("restart")
	withHost := f.fs.Bool("host", false, "also stop the local terminal host (every session's claude ends and is resumed)")
	yes := f.fs.Bool("yes", false, "with --host: do not ask for confirmation")
	f.fs.BoolVar(yes, "y", false, "short for --yes")
	_ = f.fs.Parse(args)
	dataDir, err := filepath.Abs(*f.dataDir)
	if err != nil {
		return err
	}
	// --host and --yes belong to restart alone; they are never passed on to start
	// (and so never land in start-args.json).
	args = withoutFlag(withoutFlag(withoutFlag(args, "host"), "yes"), "y")
	onlyDataDir := f.fs.NArg() == 0
	f.fs.Visit(func(fl *flag.Flag) {
		switch fl.Name {
		case "data-dir", "host", "yes", "y":
		default:
			onlyDataDir = false
		}
	})
	start := args
	if onlyDataDir {
		if b, err := os.ReadFile(startArgsFile(dataDir)); err == nil {
			var saved []string
			if json.Unmarshal(b, &saved) == nil {
				start = saved
			}
		}
	}
	start = append(withoutFlag(start, "no-open"), "--no-open", "--data-dir", dataDir)

	if *withHost {
		if n, running := d.hostSessions(dataDir); running && !*yes {
			if !d.stdinIsTTY() {
				return &exitError{2, "minbox restart --host would end the sessions' claude; stdin is not a terminal, so it cannot ask. Pass --yes (or -y) to go ahead."}
			}
			what := "an unknown number of sessions'"
			switch {
			case n == 1:
				what = "1 session's"
			case n >= 0:
				what = fmt.Sprintf("%d sessions'", n)
			}
			fmt.Fprintf(out, "Restart the terminal host too? %s claude will stop and resume (running turns are interrupted). [y/N] ", what)
			line, _ := bufio.NewReader(in).ReadString('\n')
			if a := strings.ToLower(strings.TrimSpace(line)); a != "y" && a != "yes" {
				fmt.Fprintln(out, "cancelled; nothing was stopped")
				return nil
			}
		}
	}

	pid, stopped, err := d.stopServer(dataDir)
	if err != nil {
		return err
	}
	if stopped {
		fmt.Fprintf(out, "stopped minbox (pid %d)\n", pid)
	} else {
		fmt.Fprintln(out, "minbox was not running")
	}
	if *withHost {
		hpid, running, err := d.stopHost(dataDir)
		if err != nil {
			return fmt.Errorf("stop the terminal host: %w", err)
		}
		if running {
			fmt.Fprintf(out, "stopped the terminal host (pid %d)\n", hpid)
		} else {
			fmt.Fprintln(out, "no terminal host was running")
		}
	}
	if err := d.startServer(start); err != nil {
		return err
	}
	if *withHost {
		fmt.Fprintln(out, "the new server started a fresh terminal host; open sessions resume automatically (claude --resume)")
	}
	return nil
}

func stopCmd(args []string) error {
	fs := flag.NewFlagSet("stop", flag.ExitOnError)
	dataDir := fs.String("data-dir", defaultDataDir(), "data directory")
	_ = fs.Parse(args)
	pid, stopped, err := stopServer(*dataDir)
	if err != nil {
		return err
	}
	if !stopped {
		fmt.Println("minbox is not running")
		return nil
	}
	fmt.Printf("stopped minbox (pid %d); sessions keep running in the terminal host (minbox host stop ends them)\n", pid)
	return nil
}

// stopServer stops the server of dataDir (SIGTERM, then SIGKILL after 10 s).
func stopServer(dataDir string) (int, bool, error) {
	pid, _, ok := runningServer(dataDir)
	if !ok {
		return 0, false, nil
	}
	if err := syscall.Kill(pid, syscall.SIGTERM); err != nil {
		return pid, false, fmt.Errorf("stop pid %d: %w", pid, err)
	}
	deadline := time.Now().Add(10 * time.Second)
	for alive(pid) {
		if time.Now().After(deadline) {
			_ = syscall.Kill(pid, syscall.SIGKILL)
			fmt.Printf("minbox (pid %d) did not stop in 10s; killed it\n", pid)
			return pid, true, nil
		}
		time.Sleep(100 * time.Millisecond)
	}
	return pid, true, nil
}
