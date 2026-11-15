// Package claudetrust marks a folder as trusted in Claude Code's global configuration, so the
// "Is this a project you created or one you trust?" dialog does not hold up a session minbox
// starts there.
//
// What Claude Code (2.1.x) does, read from its own code:
//
//   - The global configuration is $CLAUDE_CONFIG_DIR/.claude.json, or ~/.claude.json without
//     CLAUDE_CONFIG_DIR (".claude-custom-oauth.json" while CLAUDE_CODE_CUSTOM_OAUTH_URL is set).
//     A non-empty legacy <config dir>/.config.json takes its place when it exists.
//   - A folder is trusted when projects[<path>].hasTrustDialogAccepted is true for the folder or a
//     folder above it (up to the git repository's root inside one). The path is the absolute,
//     cleaned path; minbox writes the symlink-resolved path too when it differs (/tmp and
//     /private/tmp on macOS).
//   - The home folder's trust is never recorded (its answer holds for one session), and a record
//     there would trust every folder below it: minbox leaves the home folder (and /) alone.
//   - Claude Code saves the file under a lock, the directory <file>.lock (proper-lockfile), and
//     merges what is on disk when it saves, so an entry written by another process survives.
//   - Claude Code itself seeds new entries as {"hasTrustDialogAccepted": true} (its self-hosted
//     runner), so a minimal entry is enough.
//
// How minbox writes: only when the record is missing; under the same lock; everything else in the
// file is kept byte for byte (values are carried as raw JSON, so numbers keep their precision and
// key order is kept); to a temporary file in the same folder with the same permissions, synced,
// then renamed over the file, and only if the file did not change since it was read (else it tries
// again). A file that does not exist is not created (Claude Code has not run with that
// configuration yet and starts with its first-run setup anyway); one that is not a JSON object is
// left alone. Nothing here ever fails a spawn: callers log the outcome.
package claudetrust

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"log"
	"os"
	"os/user"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"
)

// Outcome says what Ensure did.
type Outcome string

const (
	// Trusted: every path already had the record; nothing was written.
	Trusted Outcome = "already trusted"
	// Written: the record was added.
	Written Outcome = "marked trusted"
	// NoConfig: the configuration file does not exist; nothing was written.
	NoConfig Outcome = "no Claude Code config file yet; left alone"
	// Skipped: the folder is not one to record (the home folder, /, not absolute).
	Skipped Outcome = "skipped"
)

// Tunables (tests shorten them).
var (
	// Attempts is how often the file is read and written again when it changed meanwhile.
	Attempts = 4
	// LockWait bounds the wait for Claude Code's lock on the file.
	LockWait = 3 * time.Second
	// LockStale is when a lock is old enough to belong to a process that died; minbox then gives
	// up instead of breaking it (the next Claude Code does that).
	LockStale = 20 * time.Second
)

// testHook runs between writing the temporary file and the last look at the original (tests).
var testHook func()

// EnsureLogged is Ensure for a spawn: it logs what happened (a "trust:" line) and never fails.
// who names the session or terminal in the log.
func EnsureLogged(dir string, env []string, who string) {
	out, path, err := Ensure(dir, env)
	switch {
	case err != nil:
		log.Printf("trust: %s: could not mark %q trusted in %s: %v", who, dir, path, err)
	case out == Written:
		log.Printf("trust: %s: marked %q trusted in %s", who, dir, path)
	case out == NoConfig:
		log.Printf("trust: %s: %s does not exist; %q not marked trusted", who, path, dir)
	}
}

// ConfigPath is the global configuration file a Claude Code started with env would use ("" when
// neither CLAUDE_CONFIG_DIR nor HOME is known).
func ConfigPath(env []string) string {
	cfgDir := lookup(env, "CLAUDE_CONFIG_DIR")
	home := lookup(env, "HOME")
	base := cfgDir
	if base == "" {
		base = home
	}
	if base == "" {
		return ""
	}
	dotDir := cfgDir
	if dotDir == "" {
		dotDir = filepath.Join(home, ".claude")
	}
	if st, err := os.Stat(filepath.Join(dotDir, ".config.json")); err == nil && st.Mode().IsRegular() && st.Size() > 0 {
		return filepath.Join(dotDir, ".config.json")
	}
	suffix := ""
	if lookup(env, "CLAUDE_CODE_CUSTOM_OAUTH_URL") != "" {
		suffix = "-custom-oauth"
	}
	return filepath.Join(base, ".claude"+suffix+".json")
}

// Keys are the projects keys written for dir: its cleaned absolute path and, when different, the
// symlink-resolved one. nil for a folder not to record (see the package comment).
func Keys(dir string, env []string) []string {
	if dir == "" || !filepath.IsAbs(dir) {
		return nil
	}
	clean := filepath.Clean(dir)
	keys := []string{clean}
	if real, err := filepath.EvalSymlinks(clean); err == nil && real != clean {
		keys = append(keys, real)
	}
	home := lookup(env, "HOME")
	homes := map[string]bool{"/": true}
	if home != "" {
		homes[filepath.Clean(home)] = true
		if real, err := filepath.EvalSymlinks(home); err == nil {
			homes[real] = true
		}
	}
	for _, k := range keys {
		if homes[k] {
			return nil
		}
	}
	return keys
}

// Ensure records dir as trusted in the configuration of a Claude Code started with env. It returns
// what it did and the file it looked at.
func Ensure(dir string, env []string) (Outcome, string, error) {
	keys := Keys(dir, env)
	if keys == nil {
		return Skipped, "", nil
	}
	path := ConfigPath(env)
	if path == "" {
		return Skipped, "", errors.New("neither HOME nor CLAUDE_CONFIG_DIR is set")
	}
	if testing.Testing() && underRealHome(path) {
		// A test binary never writes the person's own configuration, whatever its environment says.
		return Skipped, path, errors.New("refusing to write under the real home folder from a test")
	}
	out, err := ensureFile(path, keys)
	return out, path, err
}

// underRealHome reports whether path is in the user's home folder from the user database (not
// $HOME, which a test points elsewhere).
func underRealHome(path string) bool {
	u, err := user.Current()
	if err != nil || u.HomeDir == "" || u.HomeDir == "/" {
		return true // unknown: refuse
	}
	rel, err := filepath.Rel(u.HomeDir, path)
	return err == nil && rel != ".." && !strings.HasPrefix(rel, "../")
}

func ensureFile(path string, keys []string) (Outcome, error) {
	// Quick look without the lock: nothing to do in the usual case.
	data, err := os.ReadFile(path)
	if errors.Is(err, fs.ErrNotExist) {
		return NoConfig, nil
	}
	if err != nil {
		return "", err
	}
	if _, changed, err := addTrust(data, keys); err != nil {
		return "", err
	} else if !changed {
		return Trusted, nil
	}

	unlock, err := lock(path)
	if err != nil {
		return "", err
	}
	defer unlock()
	for attempt := 0; attempt < Attempts; attempt++ {
		out, retry, err := writeOnce(path, keys)
		if !retry {
			return out, err
		}
		time.Sleep(time.Duration(20*(attempt+1)) * time.Millisecond)
	}
	return "", errors.New("the file kept changing while it was being updated; left alone")
}

// writeOnce reads, updates and replaces the file once; retry is set when it changed meanwhile.
func writeOnce(path string, keys []string) (out Outcome, retry bool, err error) {
	// Write next to the file itself when ~/.claude.json is a link (dotfiles): the link stays.
	target := path
	if real, err := filepath.EvalSymlinks(path); err == nil {
		target = real
	}
	before, err := os.Stat(target)
	if errors.Is(err, fs.ErrNotExist) {
		return NoConfig, false, nil
	}
	if err != nil {
		return "", false, err
	}
	data, err := os.ReadFile(target)
	if err != nil {
		return "", false, err
	}
	if after, err := os.Stat(target); err != nil || !same(before, after) {
		return "", true, nil
	}
	updated, changed, err := addTrust(data, keys)
	if err != nil {
		return "", false, err
	}
	if !changed {
		return Trusted, false, nil
	}

	tmp, err := os.CreateTemp(filepath.Dir(target), "."+filepath.Base(target)+".minbox-*")
	if err != nil {
		return "", false, err
	}
	tmpName := tmp.Name()
	done := false
	defer func() {
		if !done {
			_ = os.Remove(tmpName)
		}
	}()
	if err := tmp.Chmod(before.Mode().Perm()); err != nil {
		tmp.Close()
		return "", false, err
	}
	if st, ok := before.Sys().(*syscall.Stat_t); ok {
		_ = tmp.Chown(int(st.Uid), int(st.Gid))
	}
	if _, err := tmp.Write(updated); err != nil {
		tmp.Close()
		return "", false, err
	}
	if err := tmp.Sync(); err != nil {
		tmp.Close()
		return "", false, err
	}
	if err := tmp.Close(); err != nil {
		return "", false, err
	}
	if testHook != nil {
		testHook()
	}
	// Optimistic concurrency: a process that wrote without the lock meanwhile wins; try again.
	if now, err := os.Stat(target); err != nil || !same(before, now) {
		return "", true, nil
	}
	if err := os.Rename(tmpName, target); err != nil {
		return "", false, err
	}
	done = true
	if d, err := os.Open(filepath.Dir(target)); err == nil {
		_ = d.Sync()
		d.Close()
	}
	return Written, false, nil
}

func same(a, b os.FileInfo) bool {
	return a.Size() == b.Size() && a.ModTime().Equal(b.ModTime()) && os.SameFile(a, b)
}

// lock takes Claude Code's lock on the file: the directory <file>.lock, made atomically.
func lock(path string) (func(), error) {
	dir := path + ".lock"
	deadline := time.Now().Add(LockWait)
	for wait := 10 * time.Millisecond; ; wait = min(wait*2, 200*time.Millisecond) {
		err := os.Mkdir(dir, 0o755)
		if err == nil {
			return func() { _ = os.Remove(dir) }, nil
		}
		if !errors.Is(err, fs.ErrExist) {
			return nil, fmt.Errorf("cannot take the lock: %w", err)
		}
		if st, err := os.Stat(dir); err == nil && time.Since(st.ModTime()) > LockStale {
			return nil, errors.New("a stale lock is on the file (left by a Claude Code that ended?); left alone")
		}
		if time.Now().After(deadline) {
			return nil, errors.New("another process held the lock on the file too long; left alone")
		}
		time.Sleep(wait)
	}
}

// member is one key of a JSON object with its value as it was written.
type member struct {
	key string
	raw json.RawMessage
}

// parseObject reads a JSON object into its members, in order, values untouched. ok is false when
// data is not an object.
func parseObject(data []byte) (members []member, ok bool) {
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.UseNumber()
	if t, err := dec.Token(); err != nil || t != json.Delim('{') {
		return nil, false
	}
	for dec.More() {
		t, err := dec.Token()
		if err != nil {
			return nil, false
		}
		k, isKey := t.(string)
		if !isKey {
			return nil, false
		}
		var raw json.RawMessage
		if err := dec.Decode(&raw); err != nil {
			return nil, false
		}
		members = append(members, member{k, raw})
	}
	if t, err := dec.Token(); err != nil || t != json.Delim('}') {
		return nil, false
	}
	if _, err := dec.Token(); err == nil {
		return nil, false // something after the object
	}
	return members, true
}

// encodeKey writes a key as JSON.stringify does (no HTML escaping of <, > and &).
func encodeKey(k string) []byte {
	var b bytes.Buffer
	enc := json.NewEncoder(&b)
	enc.SetEscapeHTML(false)
	_ = enc.Encode(k)
	return bytes.TrimRight(b.Bytes(), "\n")
}

func writeObject(members []member) []byte {
	var b bytes.Buffer
	b.WriteByte('{')
	for i, m := range members {
		if i > 0 {
			b.WriteByte(',')
		}
		b.Write(encodeKey(m.key))
		b.WriteByte(':')
		b.Write(m.raw)
	}
	b.WriteByte('}')
	return b.Bytes()
}

// last is the index of the last member named key (JSON.parse keeps the last), -1 when none.
func last(members []member, key string) int {
	for i := len(members) - 1; i >= 0; i-- {
		if members[i].key == key {
			return i
		}
	}
	return -1
}

func isNull(raw json.RawMessage) bool { return strings.TrimSpace(string(raw)) == "null" }

var errNotObject = errors.New("the file is not a JSON object as Claude Code writes it; left alone")

// addTrust sets projects[key].hasTrustDialogAccepted = true for each key in the configuration data
// and answers the new file (indented as Claude Code writes it), or changed=false when every key
// already had it.
func addTrust(data []byte, keys []string) (out []byte, changed bool, err error) {
	top, ok := parseObject(data)
	if !ok {
		return nil, false, errNotObject
	}
	pi := last(top, "projects")
	var projects []member
	if pi >= 0 && !isNull(top[pi].raw) {
		if projects, ok = parseObject(top[pi].raw); !ok {
			return nil, false, errNotObject
		}
	}
	for _, key := range keys {
		ei := last(projects, key)
		var entry []member
		if ei >= 0 && !isNull(projects[ei].raw) {
			if entry, ok = parseObject(projects[ei].raw); !ok {
				return nil, false, errNotObject
			}
		}
		ti := last(entry, "hasTrustDialogAccepted")
		if ti >= 0 && strings.TrimSpace(string(entry[ti].raw)) == "true" {
			continue
		}
		changed = true
		if ti >= 0 {
			entry[ti].raw = json.RawMessage("true")
		} else {
			entry = append(entry, member{"hasTrustDialogAccepted", json.RawMessage("true")})
		}
		if ei >= 0 {
			projects[ei].raw = writeObject(entry)
		} else {
			projects = append(projects, member{key, writeObject(entry)})
		}
	}
	if !changed {
		return nil, false, nil
	}
	if pi >= 0 {
		top[pi].raw = writeObject(projects)
	} else {
		top = append(top, member{"projects", writeObject(projects)})
	}
	var b bytes.Buffer
	if err := json.Indent(&b, writeObject(top), "", "  "); err != nil {
		return nil, false, err
	}
	if bytes.HasSuffix(bytes.TrimRight(data, " \t\r"), []byte("\n")) {
		b.WriteByte('\n')
	}
	return b.Bytes(), true, nil
}

func lookup(env []string, key string) string {
	v := ""
	for _, kv := range env {
		if k, val, ok := strings.Cut(kv, "="); ok && k == key {
			v = val
		}
	}
	return v
}
