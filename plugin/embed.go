// Package plugin holds the minbox Claude Code mod, the minbox Pi extension and the minbox OpenCode
// plugin, embedded into the binary and written out to the data directory for `claude --plugin-dir`,
// `pi -e` and OpenCode's OPENCODE_CONFIG_CONTENT.
package plugin

import (
	"crypto/sha256"
	"embed"
	"encoding/hex"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
)

//go:embed all:minbox
var files embed.FS

func skip(path string) bool {
	return strings.HasSuffix(path, ".test.ts") || strings.Contains(path, ".claude-plugin/types") || strings.HasSuffix(path, "tsconfig.json")
}

// Extract writes the mod under root/<content hash>/ and returns that folder.
// Each version gets its own folder, so a running session keeps the mod it
// started with while a new one picks up the update.
func Extract(root string) (string, error) {
	h := sha256.New()
	err := fs.WalkDir(files, "minbox", func(path string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() || skip(path) {
			return err
		}
		b, err := files.ReadFile(path)
		if err != nil {
			return err
		}
		h.Write([]byte(path))
		h.Write(b)
		return nil
	})
	if err != nil {
		return "", err
	}
	dir := filepath.Join(root, hex.EncodeToString(h.Sum(nil))[:12])
	if _, err := os.Stat(filepath.Join(dir, ".complete")); err == nil {
		return dir, nil
	}
	if err := os.MkdirAll(root, 0o755); err != nil {
		return "", err
	}
	tmp, err := os.MkdirTemp(root, ".extract-")
	if err != nil {
		return "", err
	}
	defer os.RemoveAll(tmp)
	err = fs.WalkDir(files, "minbox", func(path string, d fs.DirEntry, err error) error {
		if err != nil || skip(path) {
			return err
		}
		rel, _ := filepath.Rel("minbox", path)
		dst := filepath.Join(tmp, rel)
		if d.IsDir() {
			return os.MkdirAll(dst, 0o755)
		}
		b, err := files.ReadFile(path)
		if err != nil {
			return err
		}
		return os.WriteFile(dst, b, 0o644)
	})
	if err != nil {
		return "", err
	}
	if err := os.WriteFile(filepath.Join(tmp, ".complete"), nil, 0o644); err != nil {
		return "", err
	}
	if err := os.Rename(tmp, dir); err != nil {
		if _, serr := os.Stat(filepath.Join(dir, ".complete")); serr == nil {
			return dir, nil // another process extracted it first
		}
		return "", err
	}
	return dir, nil
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
	srcs, err := piSources()
	if err != nil {
		return "", err
	}
	dir, err := extractSources(root, srcs)
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
	srcs, err := openCodeSources()
	if err != nil {
		return "", err
	}
	dir, err := extractSources(root, srcs)
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, "opencode"), nil
}

// extractSources writes files under root/<content hash>/, each at its embedded path, and returns that
// folder; a folder that is complete already is reused.
func extractSources(root string, srcs []piSource) (string, error) {
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
	dir := filepath.Join(root, hex.EncodeToString(h.Sum(nil))[:12])
	if _, err := os.Stat(filepath.Join(dir, ".complete")); err == nil {
		return dir, nil
	}
	if err := os.MkdirAll(root, 0o755); err != nil {
		return "", err
	}
	tmp, err := os.MkdirTemp(root, ".extract-")
	if err != nil {
		return "", err
	}
	defer os.RemoveAll(tmp)
	for i, src := range srcs {
		dst := filepath.Join(tmp, filepath.FromSlash(src.path))
		if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
			return "", err
		}
		if err := os.WriteFile(dst, contents[i], 0o644); err != nil {
			return "", err
		}
	}
	if err := os.WriteFile(filepath.Join(tmp, ".complete"), nil, 0o644); err != nil {
		return "", err
	}
	if err := os.Rename(tmp, dir); err != nil {
		if _, serr := os.Stat(filepath.Join(dir, ".complete")); serr == nil {
			return dir, nil // another process extracted it first
		}
		return "", err
	}
	return dir, nil
}
