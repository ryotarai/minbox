// Package hostauth is how a minbox server proves itself to a host on another
// machine: the server signs every request with its ed25519 key; the host
// accepts the keys a person paired on that machine (`minbox pair accept`).
package hostauth

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Scheme is the Authorization scheme of signed requests.
const Scheme = "Minbox-Sig"

// MaxSkew is how far a request's time may be from the host's clock.
const MaxSkew = 120 * time.Second

// PairingTTL is how long a pairing code waits for accept.
const PairingTTL = 10 * time.Minute

// ---- keys ----

// LoadOrCreateKey reads the server's private key (PEM, PKCS#8-free raw seed),
// creating it (0600) on first use.
func LoadOrCreateKey(path string) (ed25519.PrivateKey, error) {
	if b, err := os.ReadFile(path); err == nil {
		blk, _ := pem.Decode(b)
		if blk == nil || blk.Type != "MINBOX ED25519 SEED" || len(blk.Bytes) != ed25519.SeedSize {
			return nil, fmt.Errorf("%s is not a minbox server key", path)
		}
		return ed25519.NewKeyFromSeed(blk.Bytes), nil
	} else if !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}
	_, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return nil, err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return nil, err
	}
	b := pem.EncodeToMemory(&pem.Block{Type: "MINBOX ED25519 SEED", Bytes: priv.Seed()})
	if err := os.WriteFile(path, b, 0o600); err != nil {
		return nil, err
	}
	return priv, nil
}

// EncodePublicKey is the wire form of a public key: base64 of its 32 bytes.
func EncodePublicKey(pub ed25519.PublicKey) string { return base64.StdEncoding.EncodeToString(pub) }

// DecodePublicKey reverses EncodePublicKey.
func DecodePublicKey(s string) (ed25519.PublicKey, error) {
	b, err := base64.StdEncoding.DecodeString(strings.TrimSpace(s))
	if err != nil || len(b) != ed25519.PublicKeySize {
		return nil, errors.New("not an ed25519 public key")
	}
	return ed25519.PublicKey(b), nil
}

// Fingerprint is "SHA256:<base64 without padding>" of the key, as ssh shows it.
func Fingerprint(pub ed25519.PublicKey) string {
	sum := sha256.Sum256(pub)
	return "SHA256:" + base64.RawStdEncoding.EncodeToString(sum[:])
}

// ---- signing (the server) ----

// Signer signs requests with the server's key.
type Signer struct {
	Key ed25519.PrivateKey
	Now func() time.Time
}

func (s *Signer) Public() ed25519.PublicKey { return s.Key.Public().(ed25519.PublicKey) }

func (s *Signer) Fingerprint() string { return Fingerprint(s.Public()) }

func message(method, requestURI, ts, nonce string) []byte {
	return []byte(method + "\n" + requestURI + "\n" + ts + "\n" + nonce)
}

// Header is the Authorization value for METHOD requestURI (path?query).
func (s *Signer) Header(method, requestURI string) string {
	now := time.Now
	if s.Now != nil {
		now = s.Now
	}
	ts := strconv.FormatInt(now().Unix(), 10)
	nb := make([]byte, 16)
	_, _ = rand.Read(nb)
	nonce := hex.EncodeToString(nb)
	sig := ed25519.Sign(s.Key, message(method, requestURI, ts, nonce))
	return fmt.Sprintf("%s key=%s, ts=%s, nonce=%s, sig=%s", Scheme, s.Fingerprint(), ts, nonce, base64.StdEncoding.EncodeToString(sig))
}

// Sign sets the request's Authorization header.
func (s *Signer) Sign(r *http.Request) {
	r.Header.Set("Authorization", s.Header(r.Method, r.URL.RequestURI()))
}

// ---- the host's side ----

// AuthorizedServer is a server key a person accepted on the host's machine.
type AuthorizedServer struct {
	Name        string    `json:"name"`
	PublicKey   string    `json:"public_key"`
	Fingerprint string    `json:"fingerprint"`
	AddedAt     time.Time `json:"added_at"`
}

// Files in a host's data directory.
func AuthorizedFile(dataDir string) string { return filepath.Join(dataDir, "authorized-servers.json") }
func PairingDir(dataDir string) string     { return filepath.Join(dataDir, "pairing") }

// ReadAuthorized lists the accepted server keys.
func ReadAuthorized(dataDir string) ([]AuthorizedServer, error) {
	b, err := os.ReadFile(AuthorizedFile(dataDir))
	if errors.Is(err, os.ErrNotExist) {
		return []AuthorizedServer{}, nil
	}
	if err != nil {
		return nil, err
	}
	var out []AuthorizedServer
	if err := json.Unmarshal(b, &out); err != nil {
		return nil, fmt.Errorf("%s: %v", AuthorizedFile(dataDir), err)
	}
	return out, nil
}

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

func writeAuthorized(dataDir string, list []AuthorizedServer) error {
	return writeJSONFile(AuthorizedFile(dataDir), list)
}

// Forget removes a server key (by fingerprint); it answers whether it was there.
func Forget(dataDir, fingerprint string) (bool, error) {
	list, err := ReadAuthorized(dataDir)
	if err != nil {
		return false, err
	}
	out := list[:0]
	found := false
	for _, a := range list {
		if a.Fingerprint == fingerprint {
			found = true
			continue
		}
		out = append(out, a)
	}
	if !found {
		return false, nil
	}
	return true, writeAuthorized(dataDir, out)
}

// Verifier checks signed requests against the accepted keys, reloading the
// file when it changes (`minbox pair accept` writes it while the host runs).
type Verifier struct {
	DataDir string
	Now     func() time.Time

	mu      sync.Mutex
	modTime time.Time
	size    int64
	keys    map[string]AuthorizedServer // by fingerprint
	nonces  map[string]time.Time        // fingerprint+nonce → seen
}

func (v *Verifier) now() time.Time {
	if v.Now != nil {
		return v.Now()
	}
	return time.Now()
}

func (v *Verifier) load() error {
	fi, err := os.Stat(AuthorizedFile(v.DataDir))
	if errors.Is(err, os.ErrNotExist) {
		v.keys, v.modTime, v.size = map[string]AuthorizedServer{}, time.Time{}, 0
		return nil
	}
	if err != nil {
		return err
	}
	if v.keys != nil && fi.ModTime().Equal(v.modTime) && fi.Size() == v.size {
		return nil
	}
	list, err := ReadAuthorized(v.DataDir)
	if err != nil {
		return err
	}
	v.keys = map[string]AuthorizedServer{}
	for _, a := range list {
		v.keys[a.Fingerprint] = a
	}
	v.modTime, v.size = fi.ModTime(), fi.Size()
	return nil
}

// ErrUnauthorized is a request no accepted key signed.
var ErrUnauthorized = errors.New("unauthorized")

func parseHeader(h string) (map[string]string, bool) {
	rest, ok := strings.CutPrefix(strings.TrimSpace(h), Scheme+" ")
	if !ok {
		return nil, false
	}
	out := map[string]string{}
	for _, part := range strings.Split(rest, ",") {
		k, val, ok := strings.Cut(strings.TrimSpace(part), "=")
		if !ok {
			return nil, false
		}
		out[k] = val
	}
	for _, k := range []string{"key", "ts", "nonce", "sig"} {
		if out[k] == "" {
			return nil, false
		}
	}
	return out, true
}

// Verify checks the request's signature; it answers the server that signed it.
func (v *Verifier) Verify(r *http.Request) (*AuthorizedServer, error) {
	p, ok := parseHeader(r.Header.Get("Authorization"))
	if !ok {
		return nil, fmt.Errorf("%w: no %s signature", ErrUnauthorized, Scheme)
	}
	ts, err := strconv.ParseInt(p["ts"], 10, 64)
	if err != nil {
		return nil, fmt.Errorf("%w: bad time", ErrUnauthorized)
	}
	now := v.now()
	if d := now.Sub(time.Unix(ts, 0)); d > MaxSkew || d < -MaxSkew {
		return nil, fmt.Errorf("%w: the request's time is %s off (clocks out of step?)", ErrUnauthorized, d.Round(time.Second))
	}
	v.mu.Lock()
	defer v.mu.Unlock()
	if err := v.load(); err != nil {
		return nil, err
	}
	a, ok := v.keys[p["key"]]
	if !ok {
		return nil, fmt.Errorf("%w: this server is not paired with the host", ErrUnauthorized)
	}
	pub, err := DecodePublicKey(a.PublicKey)
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrUnauthorized, err)
	}
	sig, err := base64.StdEncoding.DecodeString(p["sig"])
	if err != nil || !ed25519.Verify(pub, message(r.Method, r.URL.RequestURI(), p["ts"], p["nonce"]), sig) {
		return nil, fmt.Errorf("%w: bad signature", ErrUnauthorized)
	}
	if v.nonces == nil {
		v.nonces = map[string]time.Time{}
	}
	for k, t := range v.nonces { // forget nonces older than the window
		if now.Sub(t) > 2*MaxSkew {
			delete(v.nonces, k)
		}
	}
	nk := a.Fingerprint + "/" + p["nonce"]
	if _, seen := v.nonces[nk]; seen {
		return nil, fmt.Errorf("%w: replayed request", ErrUnauthorized)
	}
	v.nonces[nk] = now
	return &a, nil
}

// ---- pairing (the host's side; the CLI and the host share the files) ----

// Pairing is a server waiting for a person to accept its key on this machine.
type Pairing struct {
	Code        string    `json:"code"`
	ServerName  string    `json:"server_name"`
	PublicKey   string    `json:"public_key"`
	Fingerprint string    `json:"fingerprint"`
	CreatedAt   time.Time `json:"created_at"`
	ExpiresAt   time.Time `json:"expires_at"`
	Status      string    `json:"status"` // pending | accepted | rejected
}

// Effective is the status, with expiry.
func (p Pairing) Effective(now time.Time) string {
	if p.Status == "pending" && now.After(p.ExpiresAt) {
		return "expired"
	}
	return p.Status
}

func pairingPath(dataDir, code string) string {
	return filepath.Join(PairingDir(dataDir), code+".json")
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

// NormalizeCode accepts "482913" and "482-913".
func NormalizeCode(code string) string {
	c := strings.TrimSpace(code)
	if len(c) == 6 && !strings.Contains(c, "-") {
		c = c[:3] + "-" + c[3:]
	}
	return c
}

// NewPairing records a server's request to pair; it answers the code a
// person types on this machine.
func NewPairing(dataDir, serverName, publicKey string, now time.Time) (*Pairing, error) {
	pub, err := DecodePublicKey(publicKey)
	if err != nil {
		return nil, err
	}
	name := strings.TrimSpace(serverName)
	if name == "" || len(name) > 200 || strings.ContainsAny(name, "\n\r\t") {
		return nil, errors.New("a server name (one line, at most 200 characters) is required")
	}
	for i := 0; i < 20; i++ {
		b := make([]byte, 4)
		_, _ = rand.Read(b)
		n := (uint32(b[0])<<24 | uint32(b[1])<<16 | uint32(b[2])<<8 | uint32(b[3])) % 1_000_000
		code := fmt.Sprintf("%03d-%03d", n/1000, n%1000)
		if _, err := os.Stat(pairingPath(dataDir, code)); err == nil {
			continue
		}
		p := &Pairing{Code: code, ServerName: name, PublicKey: EncodePublicKey(pub), Fingerprint: Fingerprint(pub),
			CreatedAt: now, ExpiresAt: now.Add(PairingTTL), Status: "pending"}
		return p, writeJSONFile(pairingPath(dataDir, code), p)
	}
	return nil, errors.New("could not pick a pairing code")
}

// GetPairing reads one pairing.
func GetPairing(dataDir, code string) (*Pairing, error) {
	code = NormalizeCode(code)
	if !validCode(code) {
		return nil, fmt.Errorf("%q is not a pairing code (like 482-913)", code)
	}
	b, err := os.ReadFile(pairingPath(dataDir, code))
	if errors.Is(err, os.ErrNotExist) {
		return nil, fmt.Errorf("no pairing with the code %s", code)
	}
	if err != nil {
		return nil, err
	}
	var p Pairing
	if err := json.Unmarshal(b, &p); err != nil {
		return nil, err
	}
	return &p, nil
}

// ListPairings lists the pairings still waiting, oldest first; expired ones
// older than a day are swept.
func ListPairings(dataDir string, now time.Time) ([]Pairing, error) {
	ents, err := os.ReadDir(PairingDir(dataDir))
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var out []Pairing
	for _, e := range ents {
		code := strings.TrimSuffix(e.Name(), ".json")
		if !validCode(code) {
			continue
		}
		p, err := GetPairing(dataDir, code)
		if err != nil {
			continue
		}
		if now.Sub(p.ExpiresAt) > 24*time.Hour {
			_ = os.Remove(pairingPath(dataDir, code))
			continue
		}
		if p.Effective(now) == "pending" {
			out = append(out, *p)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].CreatedAt.Before(out[j].CreatedAt) })
	return out, nil
}

// Accept adds the pairing's key to the accepted servers.
func Accept(dataDir, code string, now time.Time) (*Pairing, error) {
	p, err := GetPairing(dataDir, code)
	if err != nil {
		return nil, err
	}
	switch p.Effective(now) {
	case "expired":
		return nil, fmt.Errorf("the code %s expired; pair again from minbox", p.Code)
	case "rejected":
		return nil, fmt.Errorf("the code %s was rejected", p.Code)
	case "accepted":
		return p, nil
	}
	list, err := ReadAuthorized(dataDir)
	if err != nil {
		return nil, err
	}
	out := list[:0]
	for _, a := range list { // a server pairing again replaces its entry
		if a.Fingerprint != p.Fingerprint {
			out = append(out, a)
		}
	}
	out = append(out, AuthorizedServer{Name: p.ServerName, PublicKey: p.PublicKey, Fingerprint: p.Fingerprint, AddedAt: now})
	if err := writeAuthorized(dataDir, out); err != nil {
		return nil, err
	}
	p.Status = "accepted"
	return p, writeJSONFile(pairingPath(dataDir, p.Code), p)
}

// Reject turns a pairing down.
func Reject(dataDir, code string, now time.Time) (*Pairing, error) {
	p, err := GetPairing(dataDir, code)
	if err != nil {
		return nil, err
	}
	if p.Effective(now) != "pending" {
		return nil, fmt.Errorf("the code %s is %s", p.Code, p.Effective(now))
	}
	p.Status = "rejected"
	return p, writeJSONFile(pairingPath(dataDir, p.Code), p)
}

// FormatList is `minbox pair list`'s output: "CODE  SERVER-NAME  ed25519 SHA256:…".
func FormatList(ps []Pairing) string {
	if len(ps) == 0 {
		return "no pairing requests are waiting\n"
	}
	var b strings.Builder
	for _, p := range ps {
		fmt.Fprintf(&b, "%s  %s  ed25519 %s\n", p.Code, p.ServerName, p.Fingerprint)
	}
	return b.String()
}

// PairingExists reports whether a host pairing with that code is on file.
func PairingExists(dataDir, code string) bool {
	_, err := os.Stat(pairingPath(dataDir, NormalizeCode(code)))
	return err == nil
}
