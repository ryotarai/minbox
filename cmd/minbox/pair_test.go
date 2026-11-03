package main

import (
	"crypto/ed25519"
	"strings"
	"testing"
	"time"

	"bytes"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"encoding/base64"
	"github.com/ryotarai/minbox/internal/devices"
	"github.com/ryotarai/minbox/internal/hostauth"
)

func TestPairCommand(t *testing.T) {
	dir := t.TempDir()
	pub, _, _ := ed25519.GenerateKey(nil)
	p, err := hostauth.NewPairing(dir, "ryota-mbp", hostauth.EncodePublicKey(pub), time.Now())
	if err != nil {
		t.Fatal(err)
	}
	run := func(args ...string) (string, error) {
		var b strings.Builder
		err := pairCmd(args, &b)
		return b.String(), err
	}
	out, err := run("list", "--data-dir", dir)
	if err != nil || out != p.Code+"  ryota-mbp  ed25519 "+hostauth.Fingerprint(pub)+"\n" {
		t.Fatalf("list = %q %v", out, err)
	}
	out, err = run("accept", strings.ReplaceAll(p.Code, "-", ""), "--data-dir", dir)
	if err != nil || !strings.HasPrefix(out, "paired ryota-mbp (ed25519 SHA256:") {
		t.Fatalf("accept = %q %v", out, err)
	}
	if out, _ := run("list", "--data-dir", dir); out != "no pairing requests are waiting\n" {
		t.Fatalf("list after accept = %q", out)
	}
	if _, err := run("reject", "--data-dir", dir, p.Code); err == nil {
		t.Fatal("rejected an accepted code")
	}
	if _, err := run("accept", "--data-dir", dir); err == nil {
		t.Fatal("accept without a code")
	}
}

func TestPairCommandBrowsers(t *testing.T) {
	dir := t.TempDir()
	priv, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	der, _ := x509.MarshalPKIXPublicKey(&priv.PublicKey)
	r, err := devices.NewRequest(dir, "Safari on iPhone", base64.StdEncoding.EncodeToString(der), "", "", time.Now(), nil)
	if err != nil {
		t.Fatal(err)
	}
	var out bytes.Buffer
	if err := pairCmd([]string{"list", "--data-dir", dir}, &out); err != nil {
		t.Fatal(err)
	}
	want := r.Code + "  browser  Safari on iPhone  ecdsa-p256 " + r.Fingerprint + "\n"
	if out.String() != want {
		t.Fatalf("list = %q, want %q", out.String(), want)
	}
	out.Reset()
	if err := pairCmd([]string{"accept", r.Code, "--data-dir", dir}, &out); err != nil {
		t.Fatal(err)
	}
	if got := out.String(); got != "paired the browser Safari on iPhone (ecdsa-p256 "+r.Fingerprint+"): it can use this machine's minbox now\n" {
		t.Fatalf("accept = %q", got)
	}
	list, _ := devices.List(dir)
	if len(list) != 1 || list[0].Fingerprint != r.Fingerprint {
		t.Fatalf("devices = %v", list)
	}
	r2, _ := devices.NewRequest(dir, "Other", base64.StdEncoding.EncodeToString(der), "", "", time.Now(), nil)
	out.Reset()
	if err := pairCmd([]string{"reject", r2.Code, "--data-dir", dir}, &out); err != nil {
		t.Fatal(err)
	}
	if got := out.String(); got != "rejected the browser Other (ecdsa-p256 "+r2.Fingerprint+")\n" {
		t.Fatalf("reject = %q", got)
	}
}
