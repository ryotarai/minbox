// Package plugin holds the minbox Claude Code mod, embedded into the binary
// and written out to the data directory for `claude --plugin-dir`.
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
