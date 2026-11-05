package main

import (
	"bufio"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"time"
)

// `minbox start` runs the server as a daemon: it starts itself again as
// `minbox start --foreground` in a session of its own, its output appended to
// <data-dir>/minbox.log, and returns once the server answers. `stop` and
// `status` find it through the server file (<data-dir>/server.json: url, pid).

const startTimeout = 20 * time.Second

func logPath(dataDir string) string    { return filepath.Join(dataDir, "minbox.log") }
func serverFile(dataDir string) string { return filepath.Join(dataDir, "server.json") }

// startArgsFile keeps the flags of the last `minbox start`, for `minbox restart`.
func startArgsFile(dataDir string) string { return filepath.Join(dataDir, "start-args.json") }

func startCmd(args []string) error {
	f := newServeFlags("start")
	_ = f.fs.Parse(args)
	if *f.foreground {
		return serve(args)
	}
	dataDir, err := filepath.Abs(*f.dataDir)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(dataDir, 0o700); err != nil {
		return err
	}
	if pid, url, ok := runningServer(dataDir); ok {
		fmt.Printf("minbox is already running (pid %d): %s\n", pid, url)
		return nil
	}

	exe, err := os.Executable()
	if err != nil {
		return err
	}
	// The same flags, in the foreground, never opening a browser itself (this
	// process does, once the server answers), on the same data directory.
	child := []string{"start", "--foreground"}
	child = append(child, withoutFlag(args, "foreground")...)
	child = append(child, "--no-open", "--data-dir", dataDir)

	lp := logPath(dataDir)
	logf, err := os.OpenFile(lp, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
	if err != nil {
		return err
	}
	defer logf.Close()
	st, _ := logf.Stat()
	logStart := int64(0)
	if st != nil {
		logStart = st.Size()
	}
	cmd := exec.Command(exe, child...)
	cmd.Stdout, cmd.Stderr = logf, logf
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true} // outlives this terminal
	if err := cmd.Start(); err != nil {
		return err
	}
	pid := cmd.Process.Pid
	exited := make(chan struct{})
	go func() {
		_ = cmd.Wait()
		close(exited)
	}()

	deadline := time.Now().Add(startTimeout)
	for {
		select {
		case <-exited:
			return fmt.Errorf("minbox did not start:\n%s\n(log: %s)", logTail(lp, logStart, 20), lp)
		case <-time.After(100 * time.Millisecond):
		}
		if p, url, err := readServerFile(dataDir); err == nil && p == pid && answers(url) {
			if b, err := json.Marshal(withoutFlag(withoutFlag(args, "foreground"), "no-open")); err == nil {
				_ = os.WriteFile(startArgsFile(dataDir), b, 0o600)
			}
			fmt.Printf("minbox started (pid %d): %s\nlog: %s\n", pid, url, lp)
			if !*f.noOpen {
				openBrowser(url)
			}
			return nil
		}
		if time.Now().After(deadline) {
			return fmt.Errorf("minbox (pid %d) did not answer within %s; see %s", pid, startTimeout, lp)
		}
	}
}

// statusCmd prints the server's state; its exit code is 3 when it is not
// running (as init scripts' status).
func statusCmd(args []string, out io.Writer) (int, error) {
	fs := flag.NewFlagSet("status", flag.ExitOnError)
	dataDir := fs.String("data-dir", defaultDataDir(), "data directory")
	_ = fs.Parse(args)
	dir, _ := filepath.Abs(*dataDir)
	host := "not running"
	if c, err := net.DialTimeout("unix", socketPath(dir), time.Second); err == nil {
		c.Close()
		host = "running (" + socketPath(dir) + ")"
	}
	pid, url, ok := runningServer(dir)
	if !ok {
		fmt.Fprintf(out, "minbox is not running\n  data:          %s\n  terminal host: %s\n", dir, host)
		return 3, nil
	}
	state := "running"
	if !answers(url) {
		state = "running, but not answering"
	}
	up := ""
	if b, err := exec.Command("ps", "-o", "etime=", "-p", fmt.Sprint(pid)).Output(); err == nil {
		up = ", up " + strings.TrimSpace(string(b))
	}
	fmt.Fprintf(out, "minbox is %s (pid %d%s)\n  url:           %s\n  data:          %s\n  log:           %s\n  terminal host: %s\n",
		state, pid, up, url, dir, logPath(dir), host)
	return 0, nil
}

// runningServer is the server of a data directory, if its process lives.
func runningServer(dataDir string) (int, string, bool) {
	pid, url, err := readServerFile(dataDir)
	if err != nil || pid <= 0 || !alive(pid) || !isMinbox(pid) {
		return 0, "", false
	}
	return pid, url, true
}

func readServerFile(dataDir string) (int, string, error) {
	b, err := os.ReadFile(serverFile(dataDir))
	if err != nil {
		return 0, "", err
	}
	var v struct {
		URL string `json:"url"`
		PID int    `json:"pid"`
	}
	if err := json.Unmarshal(b, &v); err != nil {
		return 0, "", err
	}
	return v.PID, v.URL, nil
}

func alive(pid int) bool {
	err := syscall.Kill(pid, 0)
	return err == nil || errors.Is(err, syscall.EPERM)
}

// isMinbox: the pid is still a minbox process (not a reused pid).
func isMinbox(pid int) bool {
	b, err := exec.Command("ps", "-o", "command=", "-p", fmt.Sprint(pid)).Output()
	if err != nil {
		return false
	}
	return strings.Contains(string(b), "minbox")
}

// answers: the server at url responds.
func answers(url string) bool {
	if url == "" {
		return false
	}
	c := http.Client{Timeout: time.Second}
	res, err := c.Get(url + "/api/devices/me")
	if err != nil {
		return false
	}
	res.Body.Close()
	return res.StatusCode < 500
}

// withoutFlag drops a boolean flag (-name, --name, --name=…) from args.
func withoutFlag(args []string, name string) []string {
	var out []string
	for _, a := range args {
		n := strings.TrimLeft(a, "-")
		if strings.HasPrefix(a, "-") && (n == name || strings.HasPrefix(n, name+"=")) {
			continue
		}
		out = append(out, a)
	}
	return out
}

// logTail is the last n lines written to the log since offset.
func logTail(path string, offset int64, n int) string {
	f, err := os.Open(path)
	if err != nil {
		return ""
	}
	defer f.Close()
	_, _ = f.Seek(offset, io.SeekStart)
	var lines []string
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		lines = append(lines, sc.Text())
		if len(lines) > n {
			lines = lines[1:]
		}
	}
	return strings.Join(lines, "\n")
}
