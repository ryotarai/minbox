package main

import (
	"bytes"
	"crypto/ecdsa"
	"crypto/ed25519"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"encoding/base64"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/ryotarai/minbox/internal/devices"
	"github.com/ryotarai/minbox/internal/hostauth"
)

// tty: an interactive terminal where the person types answer.
func tty(answer string, out *bytes.Buffer) pairIO {
	return pairIO{in: strings.NewReader(answer), out: out, tty: true}
}

func TestPairCommand(t *testing.T) {
	dir := t.TempDir()
	pub, _, _ := ed25519.GenerateKey(nil)
	p, err := hostauth.NewPairing(dir, "ryota-mbp", hostauth.EncodePublicKey(pub), time.Now())
	if err != nil {
		t.Fatal(err)
	}
	run := func(answer string, args ...string) (string, error) {
		var b bytes.Buffer
		err := pairCmd(args, tty(answer, &b))
		return b.String(), err
	}
	out, err := run("", "list", "--data-dir", dir)
	if err != nil || out != p.Code+"  ryota-mbp  ed25519 "+hostauth.Fingerprint(pub)+"\n" {
		t.Fatalf("list = %q %v", out, err)
	}
	// Not on a terminal: refused, nothing paired.
	var b bytes.Buffer
	err = pairCmd([]string{"accept", p.Code, "--data-dir", dir}, pairIO{in: strings.NewReader("y\n"), out: &b, tty: false})
	var ee *exitError
	if !errors.As(err, &ee) || ee.code != 2 || !strings.Contains(ee.msg, "stdin is not a terminal") {
		t.Fatalf("accept without a terminal = %v", err)
	}
	out, err = run("y\n", "accept", strings.ReplaceAll(p.Code, "-", ""), "--data-dir", dir)
	if err != nil || !strings.Contains(out, "server   ryota-mbp") || !strings.Contains(out, "key      ed25519 "+hostauth.Fingerprint(pub)) || !strings.HasSuffix(out, "paired ryota-mbp (ed25519 "+hostauth.Fingerprint(pub)+"): it can use this machine's host now\n") {
		t.Fatalf("accept = %q %v", out, err)
	}
	if out, _ := run("", "list", "--data-dir", dir); out != "no pairing requests are waiting\n" {
		t.Fatalf("list after accept = %q", out)
	}
	if _, err := run("", "reject", "--data-dir", dir, p.Code); err == nil {
		t.Fatal("rejected an accepted code")
	}
	if _, err := run("", "accept", "--data-dir", dir); err == nil {
		t.Fatal("accept without a code")
	}
}

func newRequest(t *testing.T, dir, name, ip string) *devices.Request {
	t.Helper()
	priv, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	der, _ := x509.MarshalPKIXPublicKey(&priv.PublicKey)
	r, err := devices.NewRequest(dir, name, base64.StdEncoding.EncodeToString(der), ip, "", time.Now(), nil)
	if err != nil {
		t.Fatal(err)
	}
	return r
}

func TestPairCommandBrowsers(t *testing.T) {
	dir := t.TempDir()
	r := newRequest(t, dir, "Safari on iPhone", "100.64.0.7")
	var out bytes.Buffer
	if err := pairCmd([]string{"list", "--data-dir", dir}, tty("", &out)); err != nil {
		t.Fatal(err)
	}
	want := r.Code + "  browser  Safari on iPhone  ecdsa-p256 " + r.Fingerprint + "\n"
	if out.String() != want {
		t.Fatalf("list = %q, want %q", out.String(), want)
	}
	out.Reset()
	if err := pairCmd([]string{"accept", r.Code, "--data-dir", dir}, tty("y\n", &out)); err != nil {
		t.Fatal(err)
	}
	got := out.String()
	for _, w := range []string{"A browser asks to use this machine's minbox:", "code     " + r.Code, "browser  Safari on iPhone", "key      ecdsa-p256 " + r.Fingerprint, "from     100.64.0.7", "Accept it? [y/N] ",
		"paired the browser Safari on iPhone (ecdsa-p256 " + r.Fingerprint + "): it can use this machine's minbox now\n"} {
		if !strings.Contains(got, w) {
			t.Fatalf("accept output lacks %q:\n%s", w, got)
		}
	}
	list, _ := devices.List(dir)
	if len(list) != 1 || list[0].Fingerprint != r.Fingerprint {
		t.Fatalf("devices = %v", list)
	}
	r2 := newRequest(t, dir, "Other", "")
	out.Reset()
	if err := pairCmd([]string{"reject", r2.Code, "--data-dir", dir}, tty("", &out)); err != nil {
		t.Fatal(err)
	}
	if got := out.String(); got != "rejected the browser Other (ecdsa-p256 "+r2.Fingerprint+")\n" {
		t.Fatalf("reject = %q", got)
	}
}

// A browser on this machine pairs the same way: its code, shown on its pairing screen, accepted
// in a terminal. Only on a terminal, and only with a yes: a coding agent's shell tool (no
// terminal) cannot pair a key of its own.
func TestPairAcceptBrowserNeedsATerminalAndAYes(t *testing.T) {
	dir := t.TempDir()
	r := newRequest(t, dir, "Chrome on Mac", "127.0.0.1")
	var out bytes.Buffer
	err := pairCmd([]string{"accept", r.Code, "--data-dir", dir}, pairIO{in: strings.NewReader("y\n"), out: &out, tty: false})
	var ee *exitError
	if !errors.As(err, &ee) || ee.code != 2 {
		t.Fatalf("no terminal: %v", err)
	}
	for _, answer := range []string{"\n", "n\n", "", "yes please\n"} {
		out.Reset()
		err := pairCmd([]string{"accept", r.Code, "--data-dir", dir}, tty(answer, &out))
		if !errors.As(err, &ee) || ee.code != 1 || ee.msg != "not accepted" {
			t.Fatalf("answer %q: %v", answer, err)
		}
	}
	if list, _ := devices.List(dir); len(list) != 0 {
		t.Fatalf("paired without a yes: %v", list)
	}
	// By the key's fingerprint, as the pairing screen shows it, too.
	out.Reset()
	if err := pairCmd([]string{"accept", "ecdsa-p256 " + r.Fingerprint, "--data-dir", dir}, tty("Y\n", &out)); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out.String(), "from     127.0.0.1 (this machine)") {
		t.Fatalf("output:\n%s", out.String())
	}
	if list, _ := devices.List(dir); len(list) != 1 || list[0].Name != "Chrome on Mac" {
		t.Fatalf("devices = %v", list)
	}
	// Accepting it again asks nothing and changes nothing.
	out.Reset()
	if err := pairCmd([]string{"accept", r.Code, "--data-dir", dir}, pairIO{in: strings.NewReader(""), out: &out}); err != nil {
		t.Fatal(err)
	}
}
