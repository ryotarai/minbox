package main

import (
	"bufio"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"strings"
	"time"

	"github.com/mattn/go-isatty"
	"github.com/ryotarai/minbox/internal/devices"
	"github.com/ryotarai/minbox/internal/hostauth"
)

// Pairing is how anything gets to act on this machine's minbox: a browser (one on this machine
// too) pairs its key with the server, and another machine's server pairs its key with this
// machine's terminal host. Both ask the same way: the one asking shows a code and its key's
// fingerprint, and the person accepts that code, on a browser already paired (Settings ›
// Devices, browsers only) or here with `minbox pair accept <code>`.
//
// Accepting gives a browser everything the person can do in minbox, so `minbox pair accept`
// shows who asks and asks back on an interactive terminal; with stdin not a terminal (a coding
// agent's shell tool, a script) it refuses. There is no flag to skip that.

// pairIO is where `minbox pair` reads the answer and writes, and whether stdin is a terminal.
type pairIO struct {
	in  io.Reader
	out io.Writer
	tty bool
}

func stdPairIO() pairIO {
	return pairIO{in: os.Stdin, out: os.Stdout, tty: isatty.IsTerminal(os.Stdin.Fd()) || isatty.IsCygwinTerminal(os.Stdin.Fd())}
}

// pairCmd: `minbox pair list|accept|reject` on the server's (or host's) machine.
func pairCmd(args []string, pio pairIO) error {
	if len(args) == 0 {
		return errors.New(usage)
	}
	sub := args[0]
	fs := flag.NewFlagSet("pair "+sub, flag.ExitOnError)
	dataDir := fs.String("data-dir", defaultDataDir(), "the server's (or host's) data directory")
	// The code may come before or after the flags.
	rest := args[1:]
	var code string
	if len(rest) > 0 && !strings.HasPrefix(rest[0], "-") {
		code, rest = rest[0], rest[1:]
	}
	_ = fs.Parse(rest)
	if code == "" && fs.NArg() > 0 {
		code = fs.Arg(0)
	}
	out := pio.out
	now := time.Now()
	switch sub {
	case "list":
		ps, err := hostauth.ListPairings(*dataDir, now)
		if err != nil {
			return err
		}
		bs, err := devices.Pending(*dataDir, now)
		if err != nil {
			return err
		}
		if len(ps) == 0 && len(bs) == 0 {
			fmt.Fprint(out, hostauth.FormatList(nil))
			return nil
		}
		if len(ps) > 0 {
			fmt.Fprint(out, hostauth.FormatList(ps))
		}
		fmt.Fprint(out, devices.FormatList(bs))
		return nil
	case "accept":
		if code == "" {
			return errors.New("usage: minbox pair accept <code>   (the code the browser or server shows; minbox pair list lists them)")
		}
		code = browserCodeOf(*dataDir, code, now)
		if devices.Exists(*dataDir, code) {
			r, err := devices.GetByCode(*dataDir, code)
			if err != nil {
				return err
			}
			if st := r.Effective(now); st != "pending" && st != "accepted" {
				_, _, err := devices.Accept(*dataDir, code, now) // its message: expired / rejected
				return err
			}
			if r.Status == "pending" {
				from := r.IP
				if from == "127.0.0.1" || from == "::1" {
					from += " (this machine)"
				}
				if r.TailscaleLogin != "" {
					from += " · tailscale " + r.TailscaleLogin
				}
				ok, err := confirmPair(pio, "A browser asks to use this machine's minbox", [][2]string{
					{"code", r.Code}, {"browser", r.Name}, {"key", "ecdsa-p256 " + r.Fingerprint}, {"from", from}, {"asked", ago(now, r.CreatedAt)},
				}, "It will be able to do everything you can do in minbox: reply and answer as you, open terminals, change settings.")
				if err != nil || !ok {
					return err
				}
			}
			r, _, err = devices.Accept(*dataDir, code, now)
			if err != nil {
				return err
			}
			fmt.Fprintf(out, "paired the browser %s (ecdsa-p256 %s): it can use this machine's minbox now\n", r.Name, r.Fingerprint)
			return nil
		}
		p, err := hostauth.GetPairing(*dataDir, code)
		if err != nil {
			return err
		}
		if p.Effective(now) == "pending" {
			ok, err := confirmPair(pio, "A minbox server asks to use this machine's terminal host", [][2]string{
				{"code", p.Code}, {"server", p.ServerName}, {"key", "ed25519 " + p.Fingerprint}, {"asked", ago(now, p.CreatedAt)},
			}, "It will be able to start terminals and agents on this machine as you.")
			if err != nil || !ok {
				return err
			}
		}
		p, err = hostauth.Accept(*dataDir, code, now)
		if err != nil {
			return err
		}
		fmt.Fprintf(out, "paired %s (ed25519 %s): it can use this machine's host now\n", p.ServerName, p.Fingerprint)
		return nil
	case "reject":
		if code == "" {
			return errors.New("usage: minbox pair reject <code>")
		}
		code = browserCodeOf(*dataDir, code, now)
		if devices.Exists(*dataDir, code) {
			r, err := devices.Reject(*dataDir, code, now)
			if err != nil {
				return err
			}
			fmt.Fprintf(out, "rejected the browser %s (ecdsa-p256 %s)\n", r.Name, r.Fingerprint)
			return nil
		}
		p, err := hostauth.Reject(*dataDir, code, now)
		if err != nil {
			return err
		}
		fmt.Fprintf(out, "rejected %s (ed25519 %s)\n", p.ServerName, p.Fingerprint)
		return nil
	}
	return fmt.Errorf("unknown pair command %q\n%s", sub, usage)
}

// browserCodeOf: a browser's request may also be named by its key's fingerprint
// ("SHA256:…", as its pairing screen shows it); answers its code, or arg as given.
func browserCodeOf(dataDir, arg string, now time.Time) string {
	fp := strings.TrimPrefix(strings.TrimSpace(arg), "ecdsa-p256 ")
	if !strings.HasPrefix(fp, "SHA256:") {
		return arg
	}
	pending, err := devices.Pending(dataDir, now)
	if err != nil {
		return arg
	}
	for _, r := range pending {
		if r.Fingerprint == fp {
			return r.Code
		}
	}
	return arg
}

// confirmPair shows who asks and asks back. Only on an interactive terminal: anything else (a coding
// agent's shell tool, a pipe) is refused, so an agent cannot pair a key of its own and act as the person.
func confirmPair(pio pairIO, title string, rows [][2]string, effect string) (bool, error) {
	if !pio.tty {
		return false, &exitError{2, "minbox pair accept asks before it pairs anything, and stdin is not a terminal, so it cannot ask.\n" +
			"Run it yourself in a terminal on this machine (or, for a browser, accept it in Settings › Devices on a browser already paired)."}
	}
	out := pio.out
	fmt.Fprintf(out, "%s:\n", title)
	for _, r := range rows {
		if r[1] != "" {
			fmt.Fprintf(out, "  %-8s %s\n", r[0], r[1])
		}
	}
	fmt.Fprintf(out, "Check that the code and the key match what the %s shows.\n%s\n", map[bool]string{true: "browser's pairing screen", false: "server"}[strings.Contains(title, "browser")], effect)
	fmt.Fprint(out, "Accept it? [y/N] ")
	line, _ := bufio.NewReader(pio.in).ReadString('\n')
	switch strings.ToLower(strings.TrimSpace(line)) {
	case "y", "yes":
		return true, nil
	}
	return false, &exitError{1, "not accepted"}
}

func ago(now, t time.Time) string {
	if t.IsZero() {
		return ""
	}
	d := now.Sub(t).Round(time.Second)
	switch {
	case d < time.Minute:
		return fmt.Sprintf("%d seconds ago", int(d.Seconds()))
	case d < time.Hour:
		return fmt.Sprintf("%d minutes ago", int(d.Minutes()))
	}
	return t.Local().Format("2006-01-02 15:04")
}
