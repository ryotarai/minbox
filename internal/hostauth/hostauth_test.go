package hostauth

import (
	"crypto/ed25519"
	"errors"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func newKey(t *testing.T) ed25519.PrivateKey {
	_, k, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatal(err)
	}
	return k
}

// authorize puts the signer's key in the host's accepted servers, through a pairing.
func authorize(t *testing.T, dir string, s *Signer) {
	t.Helper()
	p, err := NewPairing(dir, "laptop", EncodePublicKey(s.Public()), time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if _, err := Accept(dir, p.Code, time.Now()); err != nil {
		t.Fatal(err)
	}
}

func TestVerify(t *testing.T) {
	dir := t.TempDir()
	good := &Signer{Key: newKey(t)}
	authorize(t, dir, good)
	v := &Verifier{DataDir: dir}

	r := httptest.NewRequest("GET", "/terminals?x=1", nil)
	good.Sign(r)
	srv, err := v.Verify(r)
	if err != nil || srv.Name != "laptop" || srv.Fingerprint != good.Fingerprint() {
		t.Fatalf("good: %v %v", srv, err)
	}
	// The same request again: a replay.
	if _, err := v.Verify(r); err == nil || !strings.Contains(err.Error(), "replayed") {
		t.Fatalf("replay: %v", err)
	}
	// Signed for another path: bad signature.
	r2 := httptest.NewRequest("GET", "/terminals?x=2", nil)
	r2.Header.Set("Authorization", good.Header("GET", "/terminals?x=1"))
	if _, err := v.Verify(r2); err == nil || !strings.Contains(err.Error(), "bad signature") {
		t.Fatalf("wrong path: %v", err)
	}
	// Another key: not paired.
	other := &Signer{Key: newKey(t)}
	r3 := httptest.NewRequest("POST", "/terminals", nil)
	other.Sign(r3)
	if _, err := v.Verify(r3); !errors.Is(err, ErrUnauthorized) || !strings.Contains(err.Error(), "not paired") {
		t.Fatalf("wrong key: %v", err)
	}
	// A request from long ago.
	stale := &Signer{Key: good.Key, Now: func() time.Time { return time.Now().Add(-5 * time.Minute) }}
	r4 := httptest.NewRequest("GET", "/terminals", nil)
	stale.Sign(r4)
	if _, err := v.Verify(r4); err == nil || !strings.Contains(err.Error(), "off") {
		t.Fatalf("stale: %v", err)
	}
	// No signature.
	if _, err := v.Verify(httptest.NewRequest("GET", "/terminals", nil)); !errors.Is(err, ErrUnauthorized) {
		t.Fatalf("unsigned: %v", err)
	}
	// Forgotten: refused, and the verifier sees the file change.
	if ok, err := Forget(dir, good.Fingerprint()); !ok || err != nil {
		t.Fatalf("forget: %v %v", ok, err)
	}
	time.Sleep(10 * time.Millisecond)
	r5 := httptest.NewRequest("GET", "/terminals", nil)
	good.Sign(r5)
	if _, err := v.Verify(r5); err == nil {
		t.Fatal("a forgotten key still works")
	}
}

func TestPairingLifecycle(t *testing.T) {
	dir := t.TempDir()
	s := &Signer{Key: newKey(t)}
	now := time.Now()
	p, err := NewPairing(dir, "ryota-mbp", EncodePublicKey(s.Public()), now)
	if err != nil {
		t.Fatal(err)
	}
	if len(p.Code) != 7 || p.Code[3] != '-' {
		t.Fatalf("code %q", p.Code)
	}
	ps, _ := ListPairings(dir, now)
	if got := FormatList(ps); got != p.Code+"  ryota-mbp  ed25519 "+s.Fingerprint()+"\n" {
		t.Fatalf("list = %q", got)
	}
	// Codes are typed with or without the dash.
	if q, err := GetPairing(dir, strings.ReplaceAll(p.Code, "-", "")); err != nil || q.Code != p.Code {
		t.Fatalf("no dash: %v %v", q, err)
	}
	// Expired after ten minutes.
	if _, err := Accept(dir, p.Code, now.Add(11*time.Minute)); err == nil || !strings.Contains(err.Error(), "expired") {
		t.Fatalf("accept late: %v", err)
	}
	if _, err := Accept(dir, p.Code, now); err != nil {
		t.Fatal(err)
	}
	list, _ := ReadAuthorized(dir)
	if len(list) != 1 || list[0].Name != "ryota-mbp" {
		t.Fatalf("authorized = %v", list)
	}
	if ps, _ := ListPairings(dir, now); len(ps) != 0 {
		t.Fatalf("still listed after accept: %v", ps)
	}
	if fi, _ := os.Stat(AuthorizedFile(dir)); fi.Mode().Perm() != 0o600 {
		t.Fatalf("authorized-servers.json mode %v", fi.Mode())
	}
	if _, err := Reject(dir, p.Code, now); err == nil {
		t.Fatal("rejected an accepted pairing")
	}
	if _, err := NewPairing(dir, "x", "not a key", now); err == nil {
		t.Fatal("took a bad key")
	}
}

func TestLoadOrCreateKey(t *testing.T) {
	path := filepath.Join(t.TempDir(), "server-key")
	k1, err := LoadOrCreateKey(path)
	if err != nil {
		t.Fatal(err)
	}
	k2, err := LoadOrCreateKey(path)
	if err != nil || !k1.Equal(k2) {
		t.Fatalf("reload: %v", err)
	}
	if fi, _ := os.Stat(path); fi.Mode().Perm() != 0o600 {
		t.Fatalf("mode %v", fi.Mode())
	}
}
