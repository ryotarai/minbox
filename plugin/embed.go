// Package plugin holds the minbox Claude Code mod, the minbox Pi extension and the minbox OpenCode
// plugin, embedded into the binary and written out to the data directory for `claude --plugin-dir`,
// `pi -e` and OpenCode's OPENCODE_CONFIG_CONTENT.
package plugin

import (
	"crypto/sha256"
	"embed"
	"encoding/hex"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

//go:embed all:minbox
var files embed.FS

func skip(path string) bool {
	return strings.HasSuffix(path, ".test.ts") || strings.Contains(path, ".claude-plugin/types") || strings.HasSuffix(path, "tsconfig.json")
}

// SourceEnv names a folder laid out like the repository's plugin/ (minbox/, pi/, opencode/). When it
// is set, Extract, ExtractPi and ExtractOpenCode return paths inside it instead of extracting the
// embedded copies, so a source checkout can run the live mod and extensions without rebuilding:
// MINBOX_PLUGIN_SOURCE=$PWD/plugin ./bin/minbox start. Releases leave it unset: the binary is all
// they need.
const SourceEnv = "MINBOX_PLUGIN_SOURCE"

// liveSource returns the folder SourceEnv names, checking that sub (e.g. "minbox/.claude-plugin")
// exists in it; "" when the variable is unset.
func liveSource(sub string) (string, error) {
	src := os.Getenv(SourceEnv)
	if src == "" {
		return "", nil
	}
	abs, err := filepath.Abs(src)
	if err != nil {
		return "", err
	}
	if _, err := os.Stat(filepath.Join(abs, filepath.FromSlash(sub))); err != nil {
		return "", fmt.Errorf("%s=%s: %w", SourceEnv, src, err)
	}
	return abs, nil
}

// Extract writes the mod under root/<content hash>/ and returns that folder (for `claude
// --plugin-dir`). Each version gets its own folder, so a running session keeps the mod it
// started with while a new one picks up the update.
func Extract(root string) (string, error) {
	if src, err := liveSource("minbox/.claude-plugin"); err != nil || src != "" {
		return filepath.Join(src, "minbox"), err
	}
	var srcs []piSource
	err := fs.WalkDir(files, "minbox", func(path string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() || skip(path) {
			return err
		}
		srcs = append(srcs, piSource{&files, path})
		return nil
	})
	if err != nil {
		return "", err
	}
	return extract(root, srcs, "minbox")
}

//go:embed all:pi
var piFiles embed.FS

// piSource is one file of the Pi extension, relative to the embedded roots.
type piSource struct {
	fs   *embed.FS
	path string
}

// piSources are the files of the Pi extensions: everything under pi/ (minbox.ts, subagent.ts, the
// busy marker they share, the role definitions in agents/) except tests, and the text helpers the
// extension shares with the Claude Code mod (it imports ../minbox/hooks/proxy.ts, so the extracted
// folder keeps that layout).
func piSources() ([]piSource, error) {
	var out []piSource
	err := fs.WalkDir(piFiles, "pi", func(path string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() || strings.HasSuffix(path, ".test.ts") {
			return err
		}
		out = append(out, piSource{&piFiles, path})
		return nil
	})
	if err != nil {
		return nil, err
	}
	return append(out, piSource{&files, "minbox/hooks/proxy.ts"}), nil
}

// PiSubagentPath is the subagent extension (for a second `pi -e`) next to the entry ExtractPi returned.
func PiSubagentPath(entry string) string { return filepath.Join(filepath.Dir(entry), "subagent.ts") }

// ExtractPi writes the Pi extensions under root/<content hash>/ (as pi/minbox.ts, pi/subagent.ts ...
// next to minbox/hooks/proxy.ts) and returns the path of minbox.ts, the file for `pi -e`; the
// subagent extension is PiSubagentPath of it. Like Extract, each version gets its own folder.
func ExtractPi(root string) (string, error) {
	if src, err := liveSource("pi/minbox.ts"); err != nil || src != "" {
		return filepath.Join(src, "pi", "minbox.ts"), err
	}
	srcs, err := piSources()
	if err != nil {
		return "", err
	}
	dir, err := extract(root, srcs, "")
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, "pi", "minbox.ts"), nil
}

//go:embed all:opencode
var openCodeFiles embed.FS

// openCodeSources are the files of the OpenCode plugin: everything under opencode/ except tests and
// their helpers (opencode/test), and the text helpers it shares with the Claude Code mod
// (../minbox/hooks/proxy.ts).
func openCodeSources() ([]piSource, error) {
	var out []piSource
	err := fs.WalkDir(openCodeFiles, "opencode", func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			if path == "opencode/test" {
				return fs.SkipDir
			}
			return nil
		}
		if strings.HasSuffix(path, ".test.ts") {
			return nil
		}
		out = append(out, piSource{&openCodeFiles, path})
		return nil
	})
	if err != nil {
		return nil, err
	}
	return append(out, piSource{&files, "minbox/hooks/proxy.ts"}), nil
}

// ExtractOpenCode writes the OpenCode plugin under root/<content hash>/ (opencode/index.ts ... next to
// minbox/hooks/proxy.ts) and returns the plugin's folder: the "package" of the plugins entry minbox
// puts in OPENCODE_CONFIG_CONTENT. Like Extract, each version gets its own folder.
func ExtractOpenCode(root string) (string, error) {
	if src, err := liveSource("opencode/index.ts"); err != nil || src != "" {
		return filepath.Join(src, "opencode"), err
	}
	srcs, err := openCodeSources()
	if err != nil {
		return "", err
	}
	dir, err := extract(root, srcs, "")
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, "opencode"), nil
}

// Extracted folders are private to the user: the data directory is too, but the folders do not rely
// on it.
const (
	dirMode  = 0o700
	fileMode = 0o600
)

// extract writes files under root/<content hash>/, each at its embedded path less the strip prefix,
// and returns that folder. A folder that is complete already is reused; a new one is written to a
// temporary folder next to it and renamed into place, so a concurrent reader never sees half of one.
// Old versions are pruned (see prune).
func extract(root string, srcs []piSource, strip string) (string, error) {
	h := sha256.New()
	contents := make([][]byte, len(srcs))
	for i, src := range srcs {
		b, err := src.fs.ReadFile(src.path)
		if err != nil {
			return "", err
		}
		contents[i] = b
		h.Write([]byte(src.path))
		h.Write(b)
	}
	name := hex.EncodeToString(h.Sum(nil))[:12]
	dir := filepath.Join(root, name)
	if _, err := os.Stat(filepath.Join(dir, ".complete")); err == nil {
		now := time.Now()
		_ = os.Chtimes(dir, now, now) // in use: keep it the newest for prune
		prune(root, name, now)
		return dir, nil
	}
	if err := os.MkdirAll(root, dirMode); err != nil {
		return "", err
	}
	tmp, err := os.MkdirTemp(root, ".extract-") // 0700
	if err != nil {
		return "", err
	}
	defer os.RemoveAll(tmp)
	for i, src := range srcs {
		rel := src.path
		if strip != "" {
			rel = strings.TrimPrefix(rel, strip+"/")
		}
		dst := filepath.Join(tmp, filepath.FromSlash(rel))
		if err := os.MkdirAll(filepath.Dir(dst), dirMode); err != nil {
			return "", err
		}
		if err := os.WriteFile(dst, contents[i], fileMode); err != nil {
			return "", err
		}
	}
	if err := os.WriteFile(filepath.Join(tmp, ".complete"), nil, fileMode); err != nil {
		return "", err
	}
	if err := os.Rename(tmp, dir); err != nil {
		if _, serr := os.Stat(filepath.Join(dir, ".complete")); serr == nil {
			return dir, nil // another process extracted it first
		}
		return "", err
	}
	prune(root, name, time.Now())
	return dir, nil
}

// Pruning keeps the keepVersions most recently used versions besides the current one, and any
// version used within keepFor: a session started before an upgrade still runs the mod it started
// with until it is restarted, so a version is removed only once it is long unused.
const (
	keepVersions = 3
	keepFor      = 30 * 24 * time.Hour
	staleExtract = time.Hour
)

// prune removes old versions under root (folders named like a content hash, other than current) and
// temporary folders a crashed extract left behind. Errors are ignored: pruning is best effort.
func prune(root, current string, now time.Time) {
	entries, err := os.ReadDir(root)
	if err != nil {
		return
	}
	type version struct {
		name string
		mod  time.Time
	}
	var old []version
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		info, err := e.Info()
		if err != nil {
			continue
		}
		switch {
		case strings.HasPrefix(e.Name(), ".extract-"):
			if now.Sub(info.ModTime()) > staleExtract {
				os.RemoveAll(filepath.Join(root, e.Name()))
			}
		case e.Name() != current && isHashName(e.Name()):
			old = append(old, version{e.Name(), info.ModTime()})
		}
	}
	sort.Slice(old, func(i, j int) bool { return old[i].mod.After(old[j].mod) })
	for i, v := range old {
		if i >= keepVersions && now.Sub(v.mod) > keepFor {
			os.RemoveAll(filepath.Join(root, v.name))
		}
	}
}

func isHashName(s string) bool {
	if len(s) != 12 {
		return false
	}
	_, err := hex.DecodeString(s)
	return err == nil
}
