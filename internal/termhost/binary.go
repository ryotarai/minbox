package termhost

import (
	"crypto/sha256"
	"encoding/hex"
	"io"
	"os"
	"sync"
)

var binaryID = sync.OnceValue(func() string {
	exe, err := os.Executable()
	if err != nil {
		return ""
	}
	f, err := os.Open(exe)
	if err != nil {
		return ""
	}
	defer f.Close()
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return ""
	}
	return hex.EncodeToString(h.Sum(nil))[:16]
})

// BinaryID identifies the build of the running executable: a hash of its file,
// read the first time it is asked (so call it at start, before a newer build can
// replace the file). "" when the file cannot be read.
func BinaryID() string { return binaryID() }
