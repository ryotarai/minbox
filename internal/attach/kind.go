// Package attach classifies attached files the way Plannotator Inbox does
// (docs/research/plannotator-attachments.md §2): by name first, then by bytes.
package attach

import (
	"bytes"
	"encoding/binary"
	"image"
	_ "image/gif"  // DecodeConfig
	_ "image/jpeg" // DecodeConfig
	_ "image/png"  // DecodeConfig
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"unicode/utf8"
)

// Types of attachment, as the viewer draws them.
const (
	Markdown = "markdown"
	Text     = "text"
	HTML     = "html"
	Mermaid  = "mermaid"
	Graphviz = "graphviz"
	Code     = "code"
	Image    = "image"
	Video    = "video"
	PDF      = "pdf"
	File     = "file"
)

// ViewMaxBytes bounds the text-read types: a larger file is a download.
const ViewMaxBytes = 16 * 1024 * 1024

// HeadBytes is how much of a file is used for sniffing.
const HeadBytes = 64 * 1024

var (
	htmlRe     = regexp.MustCompile(`(?i)\.html?$`)
	mermaidRe  = regexp.MustCompile(`(?i)\.(?:mmd|mermaid)$`)
	graphvizRe = regexp.MustCompile(`(?i)\.(?:dot|gv)$`)
	markdownRe = regexp.MustCompile(`(?i)\.mdx?$`)
	docRe      = regexp.MustCompile(`(?i)(?:\.(?:mdx?|txt|adoc|asciidoc|mmd|mermaid|dot|gv|html?|ya?ml|jsonc?|json5|toml|ini|cfg|conf|properties|csv|tsv|log|xml)|\.env\.example)$`)
	codeRe     = regexp.MustCompile(`(?i)(?:\.([cm]?[jt]s|[jt]sx|py|rb|go|rs|java|c|cpp|h|hpp|cs|swift|kt|scala|sh|bash|zsh|sql|graphql|json|ya?ml|toml|ini|css|scss|less|xml|tf|lua|r|dart|ex|exs|vue|svelte|astro|zig|proto)|(?:^|/)(Dockerfile|Makefile|Rakefile|Gemfile|Procfile|Vagrantfile|Brewfile|Justfile))$`)

	envRe1 = regexp.MustCompile(`(?i)(^|\.)env$`)
	envRe2 = regexp.MustCompile(`(?i)^\.envrc$`)
	envRe3 = regexp.MustCompile(`(?i)^\.env\.`)
)

// IsAnnotatableDoc: names Plannotator opens as documents.
func IsAnnotatableDoc(name string) bool { return docRe.MatchString(name) }

// IsCodeFile: names Plannotator opens as code.
func IsCodeFile(name string) bool { return codeRe.MatchString(name) }

// IsDotenv: the dotenv family, never attached (.env.example stays allowed).
func IsDotenv(name string) bool {
	name = filepath.Base(name)
	if envRe1.MatchString(name) || envRe2.MatchString(name) {
		return true
	}
	return envRe3.MatchString(name) && !IsAnnotatableDoc(name)
}

// ByName is the type a file's name suggests.
func ByName(name string) string {
	switch {
	case htmlRe.MatchString(name):
		return HTML
	case mermaidRe.MatchString(name):
		return Mermaid
	case graphvizRe.MatchString(name):
		return Graphviz
	case markdownRe.MatchString(name):
		return Markdown
	case IsAnnotatableDoc(name):
		return Text
	case IsCodeFile(name):
		return Code
	}
	return File
}

// Info is what classification found.
type Info struct {
	Type       string
	MediaType  string
	Width      int
	Height     int
	DurationMs int64
}

// Decide classifies a file from its name, first bytes, whether all of it is
// UTF-8 without NUL, and its size. path (optional) lets video headers be
// walked for duration and size.
func Decide(name string, head []byte, isText bool, size int64, path string) Info {
	fits := size <= ViewMaxBytes
	byName := ByName(name)
	if byName != Code && byName != File {
		if isText && fits {
			return Info{Type: byName}
		}
		return Info{Type: File}
	}
	if mt, w, h, ok := SniffImage(head); ok {
		return Info{Type: Image, MediaType: mt, Width: w, Height: h}
	}
	if IsPDF(head) {
		return Info{Type: PDF, MediaType: "application/pdf"}
	}
	if v, ok := SniffVideo(head, path); ok {
		return v
	}
	if isText && fits {
		return Info{Type: Code}
	}
	return Info{Type: File}
}

// Label is a type's short human name (Plannotator's inboxAttachmentKindLabel).
func Label(typ, name, mediaType string) string {
	ext := strings.TrimPrefix(strings.ToLower(filepath.Ext(name)), ".")
	switch typ {
	case Markdown:
		return "Markdown"
	case HTML:
		return "HTML"
	case Mermaid:
		return "Mermaid"
	case Graphviz:
		return "Graphviz"
	case Text:
		if ext == "txt" || ext == "" {
			return "Text"
		}
		return strings.ToUpper(ext)
	case Code:
		if ext == "" {
			return "Code (" + name + ")"
		}
		return "Code (." + ext + ")"
	case Image:
		if l := imageLabels[mediaType]; l != "" {
			return l + " image"
		}
		return "Image"
	case Video:
		switch mediaType {
		case "video/quicktime":
			return "MOV video"
		case "video/webm":
			return "WebM video"
		}
		return "MP4 video"
	case PDF:
		return "PDF"
	}
	if ext != "" {
		return strings.ToUpper(ext) + " file"
	}
	return "File"
}

var imageLabels = map[string]string{"image/png": "PNG", "image/jpeg": "JPEG", "image/gif": "GIF", "image/webp": "WebP",
	"image/avif": "AVIF", "image/bmp": "BMP", "image/x-icon": "ICO", "image/svg+xml": "SVG"}

// IsTextType: types read as text (all but image, video, pdf and file).
func IsTextType(t string) bool {
	return t != Image && t != Video && t != PDF && t != File && t != ""
}

// IsPDF: "%PDF-" within the first 1024 bytes.
func IsPDF(head []byte) bool {
	return bytes.Contains(head[:min(len(head), 1024)], []byte("%PDF-"))
}

// SniffImage recognizes images by their magic bytes (an SVG by its first element).
func SniffImage(b []byte) (mediaType string, w, h int, ok bool) {
	if bytes.HasPrefix(b, []byte("version https://git-lfs.github.com/spec")) {
		return "", 0, 0, false
	}
	switch {
	case bytes.HasPrefix(b, []byte{0x89, 'P', 'N', 'G', 0x0D, 0x0A, 0x1A, 0x0A}):
		w, h = decodeDims(b)
		return "image/png", w, h, true
	case bytes.HasPrefix(b, []byte{0xFF, 0xD8, 0xFF}):
		w, h = decodeDims(b)
		return "image/jpeg", w, h, true
	case bytes.HasPrefix(b, []byte("GIF87a")) || bytes.HasPrefix(b, []byte("GIF89a")):
		w, h = decodeDims(b)
		return "image/gif", w, h, true
	case len(b) >= 12 && string(b[0:4]) == "RIFF" && string(b[8:12]) == "WEBP":
		w, h = webpDims(b)
		return "image/webp", w, h, true
	case isAVIF(b):
		return "image/avif", 0, 0, true
	case len(b) >= 26 && b[0] == 'B' && b[1] == 'M':
		w = int(int32(binary.LittleEndian.Uint32(b[18:22])))
		h = int(int32(binary.LittleEndian.Uint32(b[22:26])))
		if h < 0 {
			h = -h
		}
		return "image/bmp", w, h, true
	case len(b) >= 22 && b[0] == 0 && b[1] == 0 && b[2] == 1 && b[3] == 0:
		w, h = int(b[6]), int(b[7])
		if w == 0 {
			w = 256
		}
		if h == 0 {
			h = 256
		}
		return "image/x-icon", w, h, true
	case isSVG(b):
		return "image/svg+xml", 0, 0, true
	}
	return "", 0, 0, false
}

func decodeDims(b []byte) (int, int) {
	c, _, err := image.DecodeConfig(bytes.NewReader(b))
	if err != nil {
		return 0, 0
	}
	return c.Width, c.Height
}

func webpDims(b []byte) (int, int) {
	if len(b) < 30 {
		return 0, 0
	}
	switch string(b[12:16]) {
	case "VP8X":
		w := int(b[24]) | int(b[25])<<8 | int(b[26])<<16
		h := int(b[27]) | int(b[28])<<8 | int(b[29])<<16
		return w + 1, h + 1
	case "VP8L":
		if b[20] != 0x2f {
			return 0, 0
		}
		v := binary.LittleEndian.Uint32(b[21:25])
		return int(v&0x3fff) + 1, int((v>>14)&0x3fff) + 1
	case "VP8 ":
		return int(binary.LittleEndian.Uint16(b[26:28]) & 0x3fff), int(binary.LittleEndian.Uint16(b[28:30]) & 0x3fff)
	}
	return 0, 0
}

func isAVIF(b []byte) bool {
	if len(b) < 16 || string(b[4:8]) != "ftyp" {
		return false
	}
	size := int(binary.BigEndian.Uint32(b[0:4]))
	if size < 16 || size > len(b) {
		size = min(len(b), 64)
	}
	for i := 8; i+4 <= size; i += 4 {
		if i == 12 {
			continue // minor version
		}
		if br := string(b[i : i+4]); br == "avif" || br == "avis" {
			return true
		}
	}
	return false
}

var (
	svgSkipRe = regexp.MustCompile(`^(?s)\s*(?:<\?xml.*?\?>|<!--.*?-->|<\?.*?\?>|<!DOCTYPE[^>]*>)`)
	svgRe     = regexp.MustCompile(`(?i)^\s*<svg[\s>/]`)
)

func isSVG(b []byte) bool {
	if !utf8.Valid(trimPartialRune(b)) {
		return false
	}
	s := strings.TrimPrefix(string(b), "\uFEFF")
	for {
		loc := svgSkipRe.FindStringIndex(s)
		if loc == nil {
			break
		}
		s = s[loc[1]:]
	}
	return svgRe.MatchString(s)
}

// trimPartialRune drops an incomplete UTF-8 sequence at the end of a head.
func trimPartialRune(b []byte) []byte {
	for i := 1; i <= 3 && i <= len(b); i++ {
		if utf8.RuneStart(b[len(b)-i]) {
			if !utf8.FullRune(b[len(b)-i:]) {
				return b[:len(b)-i]
			}
			break
		}
	}
	return b
}

var (
	videoBrands    = map[string]bool{"isom": true, "iso2": true, "iso4": true, "iso5": true, "iso6": true, "mp41": true, "mp42": true, "avc1": true, "M4V ": true, "M4VH": true, "M4VP": true, "qt  ": true, "dash": true, "msnv": true, "3gp4": true, "3gp5": true, "3g2a": true, "mmp4": true, "hvc1": true, "av01": true}
	notVideoMajors = map[string]bool{"M4A ": true, "M4B ": true, "M4P ": true, "avif": true, "avis": true, "heic": true, "heix": true, "mif1": true, "msf1": true, "crx ": true}
)

// SniffVideo recognizes MP4/MOV (ftyp brands) and WebM (EBML DocType). With
// a path, an MP4's boxes are walked for its duration and video size; one with
// tracks but no video track (audio-only) is not a video.
func SniffVideo(b []byte, path string) (Info, bool) {
	if len(b) >= 12 && string(b[4:8]) == "ftyp" {
		major := string(b[8:12])
		if notVideoMajors[major] {
			return Info{}, false
		}
		size := int(binary.BigEndian.Uint32(b[0:4]))
		if size < 16 || size > len(b) {
			size = min(len(b), 64)
		}
		ok := videoBrands[major]
		for i := 16; i+4 <= size && !ok; i += 4 {
			ok = videoBrands[string(b[i:i+4])]
		}
		if !ok {
			return Info{}, false
		}
		info := Info{Type: Video, MediaType: "video/mp4"}
		if major == "qt  " {
			info.MediaType = "video/quicktime"
		}
		if path != "" {
			if m, err := probeMP4(path); err == nil {
				if m.tracks > 0 && !m.hasVideo {
					return Info{}, false
				}
				info.DurationMs, info.Width, info.Height = m.durationMs, m.width, m.height
			}
		}
		return info, true
	}
	if len(b) >= 4 && bytes.Equal(b[:4], []byte{0x1A, 0x45, 0xDF, 0xA3}) && bytes.Contains(b[:min(len(b), 4096)], []byte("webm")) {
		return Info{Type: Video, MediaType: "video/webm"}, true
	}
	return Info{}, false
}

type mp4Meta struct {
	durationMs    int64
	width, height int
	tracks        int
	hasVideo      bool
}

// probeMP4 walks the box tree for mvhd (duration) and the first video trak (size).
func probeMP4(path string) (mp4Meta, error) {
	f, err := os.Open(path)
	if err != nil {
		return mp4Meta{}, err
	}
	defer f.Close()
	fi, err := f.Stat()
	if err != nil {
		return mp4Meta{}, err
	}
	var m mp4Meta
	boxes := 0
	var walk func(off, end int64, depth int) error
	walk = func(off, end int64, depth int) error {
		for off+8 <= end && boxes < 4096 {
			boxes++
			hdr := make([]byte, 16)
			if _, err := f.ReadAt(hdr[:8], off); err != nil {
				return err
			}
			size := int64(binary.BigEndian.Uint32(hdr[0:4]))
			typ := string(hdr[4:8])
			hlen := int64(8)
			if size == 1 {
				if _, err := f.ReadAt(hdr[8:16], off+8); err != nil {
					return err
				}
				size = int64(binary.BigEndian.Uint64(hdr[8:16]))
				hlen = 16
			} else if size == 0 {
				size = end - off
			}
			if size < hlen || off+size > end {
				return nil
			}
			body := off + hlen
			switch typ {
			case "moov", "mdia", "minf":
				if err := walk(body, off+size, depth+1); err != nil {
					return err
				}
			case "trak":
				save := m
				m = mp4Meta{}
				if err := walk(body, off+size, depth+1); err != nil {
					return err
				}
				t := m
				m = save
				m.tracks++
				if t.hasVideo {
					if !m.hasVideo {
						m.width, m.height = t.width, t.height
					}
					m.hasVideo = true
				}
			case "mvhd":
				buf := make([]byte, min(size-hlen, 40))
				if _, err := f.ReadAt(buf, body); err == nil && len(buf) >= 20 {
					if buf[0] == 1 && len(buf) >= 32 {
						ts := binary.BigEndian.Uint32(buf[20:24])
						d := binary.BigEndian.Uint64(buf[24:32])
						if ts > 0 {
							m.durationMs = int64(d * 1000 / uint64(ts))
						}
					} else {
						ts := binary.BigEndian.Uint32(buf[12:16])
						d := binary.BigEndian.Uint32(buf[16:20])
						if ts > 0 {
							m.durationMs = int64(uint64(d) * 1000 / uint64(ts))
						}
					}
				}
			case "tkhd":
				buf := make([]byte, min(size-hlen, 96))
				if _, err := f.ReadAt(buf, body); err == nil && len(buf) >= 84 {
					wOff := 76
					if buf[0] == 1 {
						wOff = 88
					}
					if len(buf) >= wOff+8 {
						m.width = int(binary.BigEndian.Uint32(buf[wOff:wOff+4]) >> 16)
						m.height = int(binary.BigEndian.Uint32(buf[wOff+4:wOff+8]) >> 16)
					}
				}
			case "hdlr":
				buf := make([]byte, 12)
				if _, err := f.ReadAt(buf, body); err == nil && string(buf[8:12]) == "vide" {
					m.hasVideo = true
				}
			}
			off += size
		}
		return nil
	}
	if err := walk(0, fi.Size(), 0); err != nil && err != io.EOF {
		return m, err
	}
	return m, nil
}
