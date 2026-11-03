// Package devices is how a browser on another machine (a phone, a laptop on
// the tailnet) gets to use a minbox server: it makes an ECDSA P-256 key pair
// with WebCrypto, asks to pair with its public key, a person accepts the code
// (in a trusted minbox window or with `minbox pair accept`), and from then on
// the browser proves itself by signing a challenge.
//
// Files in the server's data directory (shared with the CLI):
//
//	devices.json                 the accepted browsers
//	device-pairing/<code>.json   browsers waiting to be accepted
package devices

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"math/big"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

// RequestTTL is how long a pairing code waits for accept.
const RequestTTL = 10 * time.Minute

// Device is a browser a person accepted.
type Device struct {
	ID          string    `json:"id"`
	Name        string    `json:"name"`
	PublicKey   string    `json:"public_key"` // base64 SPKI DER
	Fingerprint string    `json:"fingerprint"`
	CreatedAt   time.Time `json:"created_at"`
	LastSeen    time.Time `json:"last_seen"`
}

// Request is a browser waiting to be accepted.
type Request struct {
	ID             string    `json:"id"`
	Code           string    `json:"code"`
	Name           string    `json:"name"`
	PublicKey      string    `json:"public_key"`
	Fingerprint    string    `json:"fingerprint"`
	CreatedAt      time.Time `json:"created_at"`
	ExpiresAt      time.Time `json:"expires_at"`
	Status         string    `json:"status"` // pending | accepted | rejected
	IP             string    `json:"ip,omitempty"`
	TailscaleLogin string    `json:"tailscale_login,omitempty"`
	DeviceID       string    `json:"device_id,omitempty"` // once accepted
}

// Effective is the status, with expiry.
func (r Request) Effective(now time.Time) string {
	if r.Status == "pending" && now.After(r.ExpiresAt) {
		return "expired"
	}
	return r.Status
}

func File(dataDir string) string       { return filepath.Join(dataDir, "devices.json") }
func PairingDir(dataDir string) string { return filepath.Join(dataDir, "device-pairing") }

// ---- keys ----

// ParsePublicKey reads a base64 SPKI DER ECDSA P-256 public key.
func ParsePublicKey(b64 string) (*ecdsa.PublicKey, []byte, error) {
	der, err := base64.StdEncoding.DecodeString(strings.TrimSpace(b64))
	if err != nil {
		return nil, nil, errors.New("the public key is not base64")
	}
	k, err := x509.ParsePKIXPublicKey(der)
	if err != nil {
		return nil, nil, errors.New("the public key is not an SPKI key")
	}
	ek, ok := k.(*ecdsa.PublicKey)
	if !ok || ek.Curve != elliptic.P256() {
		return nil, nil, errors.New("the public key must be ECDSA P-256")
	}
	return ek, der, nil
}

// Fingerprint is "SHA256:<base64 without padding>" of the SPKI DER.
func Fingerprint(der []byte) string {
	sum := sha256.Sum256(der)
	return "SHA256:" + base64.RawStdEncoding.EncodeToString(sum[:])
}

// Verify checks an IEEE P1363 (r||s) ECDSA P-256 signature over msg with
// SHA-256: what WebCrypto's ECDSA sign produces.
func Verify(pub *ecdsa.PublicKey, msg, sig []byte) bool {
	if len(sig) != 64 {
		return false
	}
	h := sha256.Sum256(msg)
	r := new(big.Int).SetBytes(sig[:32])
	s := new(big.Int).SetBytes(sig[32:])
	return ecdsa.Verify(pub, h[:], r, s)
}

// ---- files ----

func writeJSONFile(path string, v any) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	b, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return err
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, b, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

// List reads the accepted browsers.
func List(dataDir string) ([]Device, error) {
	b, err := os.ReadFile(File(dataDir))
	if errors.Is(err, os.ErrNotExist) {
		return []Device{}, nil
	}
	if err != nil {
		return nil, err
	}
	var out []Device
	if err := json.Unmarshal(b, &out); err != nil {
		return nil, fmt.Errorf("%s: %v", File(dataDir), err)
	}
	if out == nil {
		out = []Device{}
	}
	return out, nil
}

func write(dataDir string, list []Device) error { return writeJSONFile(File(dataDir), list) }

// Revoke forgets a browser; it answers whether it was there.
func Revoke(dataDir, id string) (bool, error) {
	list, err := List(dataDir)
	if err != nil {
		return false, err
	}
	out := list[:0]
	found := false
	for _, d := range list {
		if d.ID == id {
			found = true
			continue
		}
		out = append(out, d)
	}
	if !found {
		return false, nil
	}
	return true, write(dataDir, out)
}

// Touch records when a browser was last seen.
func Touch(dataDir, id string, at time.Time) error {
	list, err := List(dataDir)
	if err != nil {
		return err
	}
	for i := range list {
		if list[i].ID == id {
			list[i].LastSeen = at
			return write(dataDir, list)
		}
	}
	return nil
}

func randomHex(n int) string {
	b := make([]byte, n)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

func requestPath(dataDir, code string) string {
	return filepath.Join(PairingDir(dataDir), code+".json")
}

// NormalizeCode accepts "482913" and "482-913".
func NormalizeCode(code string) string {
	c := strings.TrimSpace(code)
	if len(c) == 6 && !strings.Contains(c, "-") {
		c = c[:3] + "-" + c[3:]
	}
	return c
}

func validCode(code string) bool {
	if len(code) != 7 || code[3] != '-' {
		return false
	}
	for i, c := range code {
		if i != 3 && (c < '0' || c > '9') {
			return false
		}
	}
	return true
}

// NewRequest records a browser's request to pair. taken reports codes already
// in use elsewhere (the host's pairings share `minbox pair accept`).
func NewRequest(dataDir, name, publicKey, ip, tsLogin string, now time.Time, taken func(code string) bool) (*Request, error) {
	_, der, err := ParsePublicKey(publicKey)
	if err != nil {
		return nil, err
	}
	name = strings.TrimSpace(name)
	if name == "" {
		name = "Browser"
	}
	if r := []rune(name); len(r) > 100 {
		name = string(r[:100])
	}
	name = strings.Map(func(c rune) rune {
		if c < 0x20 || c == 0x7f {
			return ' '
		}
		return c
	}, name)
	for i := 0; i < 50; i++ {
		b := make([]byte, 4)
		_, _ = rand.Read(b)
		n := (uint32(b[0])<<24 | uint32(b[1])<<16 | uint32(b[2])<<8 | uint32(b[3])) % 1_000_000
		code := fmt.Sprintf("%03d-%03d", n/1000, n%1000)
		if _, err := os.Stat(requestPath(dataDir, code)); err == nil {
			continue
		}
		if taken != nil && taken(code) {
			continue
		}
		r := &Request{ID: "dpr_" + randomHex(10), Code: code, Name: name, PublicKey: base64.StdEncoding.EncodeToString(der),
			Fingerprint: Fingerprint(der), CreatedAt: now, ExpiresAt: now.Add(RequestTTL), Status: "pending", IP: ip, TailscaleLogin: tsLogin}
		return r, writeJSONFile(requestPath(dataDir, code), r)
	}
	return nil, errors.New("could not pick a pairing code")
}

// GetByCode reads one request by its code.
func GetByCode(dataDir, code string) (*Request, error) {
	code = NormalizeCode(code)
	if !validCode(code) {
		return nil, fmt.Errorf("%q is not a pairing code (like 482-913)", code)
	}
	b, err := os.ReadFile(requestPath(dataDir, code))
	if errors.Is(err, os.ErrNotExist) {
		return nil, fmt.Errorf("no pairing with the code %s", code)
	}
	if err != nil {
		return nil, err
	}
	var r Request
	if err := json.Unmarshal(b, &r); err != nil {
		return nil, err
	}
	return &r, nil
}

// All lists every request on file (any status), oldest first; ones expired for
// more than a day are swept.
func All(dataDir string, now time.Time) ([]Request, error) {
	ents, err := os.ReadDir(PairingDir(dataDir))
	if errors.Is(err, os.ErrNotExist) {
		return []Request{}, nil
	}
	if err != nil {
		return nil, err
	}
	out := []Request{}
	for _, e := range ents {
		code := strings.TrimSuffix(e.Name(), ".json")
		if !validCode(code) {
			continue
		}
		r, err := GetByCode(dataDir, code)
		if err != nil {
			continue
		}
		if now.Sub(r.ExpiresAt) > 24*time.Hour {
			_ = os.Remove(requestPath(dataDir, code))
			continue
		}
		out = append(out, *r)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].CreatedAt.Before(out[j].CreatedAt) })
	return out, nil
}

// Pending lists the requests still waiting.
func Pending(dataDir string, now time.Time) ([]Request, error) {
	all, err := All(dataDir, now)
	if err != nil {
		return nil, err
	}
	out := []Request{}
	for _, r := range all {
		if r.Effective(now) == "pending" {
			out = append(out, r)
		}
	}
	return out, nil
}

// GetByID finds a request by its id.
func GetByID(dataDir, id string, now time.Time) (*Request, error) {
	all, err := All(dataDir, now)
	if err != nil {
		return nil, err
	}
	for _, r := range all {
		if r.ID == id {
			return &r, nil
		}
	}
	return nil, errors.New("no such pairing request")
}

// Accept makes the request's browser a device.
func Accept(dataDir, code string, now time.Time) (*Request, *Device, error) {
	r, err := GetByCode(dataDir, code)
	if err != nil {
		return nil, nil, err
	}
	switch r.Effective(now) {
	case "expired":
		return nil, nil, fmt.Errorf("the code %s expired; pair the browser again", r.Code)
	case "rejected":
		return nil, nil, fmt.Errorf("the code %s was rejected", r.Code)
	}
	list, err := List(dataDir)
	if err != nil {
		return nil, nil, err
	}
	if r.Status == "accepted" {
		for _, d := range list {
			if d.ID == r.DeviceID {
				return r, &d, nil
			}
		}
	}
	out := list[:0]
	for _, d := range list { // the same key pairing again replaces its entry
		if d.Fingerprint != r.Fingerprint {
			out = append(out, d)
		}
	}
	d := Device{ID: "dev_" + randomHex(10), Name: r.Name, PublicKey: r.PublicKey, Fingerprint: r.Fingerprint, CreatedAt: now, LastSeen: now}
	out = append(out, d)
	if err := write(dataDir, out); err != nil {
		return nil, nil, err
	}
	r.Status = "accepted"
	r.DeviceID = d.ID
	return r, &d, writeJSONFile(requestPath(dataDir, r.Code), r)
}

// Reject turns a request down.
func Reject(dataDir, code string, now time.Time) (*Request, error) {
	r, err := GetByCode(dataDir, code)
	if err != nil {
		return nil, err
	}
	if r.Effective(now) != "pending" {
		return nil, fmt.Errorf("the code %s is %s", r.Code, r.Effective(now))
	}
	r.Status = "rejected"
	return r, writeJSONFile(requestPath(dataDir, r.Code), r)
}

// Exists reports whether a request with that code is on file.
func Exists(dataDir, code string) bool {
	_, err := os.Stat(requestPath(dataDir, NormalizeCode(code)))
	return err == nil
}

// FormatList is the browser half of `minbox pair list`:
// "CODE  browser  NAME  ecdsa-p256 SHA256:…".
func FormatList(rs []Request) string {
	var b strings.Builder
	for _, r := range rs {
		fmt.Fprintf(&b, "%s  browser  %s  ecdsa-p256 %s\n", r.Code, r.Name, r.Fingerprint)
	}
	return b.String()
}
