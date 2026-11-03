package attach

import (
	"bytes"
	"encoding/binary"
	"image"
	"image/png"
	"os"
	"path/filepath"
	"testing"
)

func pngBytes(w, h int) []byte {
	var b bytes.Buffer
	_ = png.Encode(&b, image.NewRGBA(image.Rect(0, 0, w, h)))
	return b.Bytes()
}

func box(typ string, body []byte) []byte {
	b := make([]byte, 8, 8+len(body))
	binary.BigEndian.PutUint32(b, uint32(8+len(body)))
	copy(b[4:], typ)
	return append(b, body...)
}

func TestDecide(t *testing.T) {
	text := []byte("hello\n")
	pdf := []byte("%PDF-1.7\n...")
	mp4 := box("ftyp", []byte("isomxxxxisommp41"))
	m4a := box("ftyp", []byte("M4A xxxxM4A mp42"))
	svg := []byte("<?xml version=\"1.0\"?>\n<!-- c -->\n<svg xmlns=\"http://www.w3.org/2000/svg\"></svg>")
	htmlSVG := []byte("<html><body><svg></svg></body></html>")
	cases := []struct {
		name   string
		head   []byte
		isText bool
		size   int64
		want   string
	}{
		{"plan.md", text, true, 6, Markdown},
		{"doc.mdx", text, true, 6, Markdown},
		{"page.html", text, true, 6, HTML},
		{"flow.mmd", text, true, 6, Mermaid},
		{"g.dot", text, true, 6, Graphviz},
		{"notes.txt", text, true, 6, Text},
		{"conf.yaml", text, true, 6, Text},
		{"data.json", text, true, 6, Text},
		{".env.example", text, true, 6, Text},
		{"main.go", text, true, 6, Code},
		{"Dockerfile", text, true, 6, Code},
		{"script.unknownext", text, true, 6, Code},
		{"binary.md", []byte{0, 1, 2}, false, 3, File},
		{"huge.md", text, true, ViewMaxBytes + 1, File},
		{"shot.dat", pngBytes(3, 2), false, 100, Image},
		{"x.svg", svg, true, int64(len(svg)), Image},
		{"x.svg", htmlSVG, true, int64(len(htmlSVG)), Code},
		{"doc.pdf", pdf, false, 12, PDF},
		{"clip.mp4", mp4, false, 24, Video},
		{"sound.m4a", m4a, false, 24, File},
		{"blob.bin", []byte{0, 0, 0}, false, 3, File},
	}
	for _, c := range cases {
		if got := Decide(c.name, c.head, c.isText, c.size, "").Type; got != c.want {
			t.Errorf("Decide(%q) = %s, want %s", c.name, got, c.want)
		}
	}
	info := Decide("shot.png", pngBytes(1280, 800), false, 100, "")
	if info.MediaType != "image/png" || info.Width != 1280 || info.Height != 800 {
		t.Errorf("png info = %+v", info)
	}
}

func TestDotenv(t *testing.T) {
	for name, want := range map[string]bool{
		".env": true, ".env.local": true, ".env.production": true, ".envrc": true, "prod.env": true, "env": true,
		".env.example": false, "environment.ts": false, "dotenv.md": false, "src/.env": true,
	} {
		if got := IsDotenv(name); got != want {
			t.Errorf("IsDotenv(%q) = %v, want %v", name, got, want)
		}
	}
}

func TestLabel(t *testing.T) {
	for _, c := range [][4]string{
		{Markdown, "a.md", "", "Markdown"}, {Text, "a.txt", "", "Text"}, {Text, "a.json", "", "JSON"},
		{Code, "a.go", "", "Code (.go)"}, {Code, "Makefile", "", "Code (Makefile)"},
		{Image, "a.png", "image/png", "PNG image"}, {Video, "a.mov", "video/quicktime", "MOV video"},
		{PDF, "a.pdf", "", "PDF"}, {File, "a.zip", "", "ZIP file"},
	} {
		if got := Label(c[0], c[1], c[2]); got != c[3] {
			t.Errorf("Label(%v) = %q, want %q", c, got, c[3])
		}
	}
}

func TestVideoProbe(t *testing.T) {
	// ftyp + moov{mvhd(timescale 1000, duration 5000), trak{tkhd(640x360), mdia{hdlr vide}}}
	mvhd := make([]byte, 100)
	binary.BigEndian.PutUint32(mvhd[12:], 1000)
	binary.BigEndian.PutUint32(mvhd[16:], 5000)
	tkhd := make([]byte, 84)
	binary.BigEndian.PutUint32(tkhd[76:], 640<<16)
	binary.BigEndian.PutUint32(tkhd[80:], 360<<16)
	hdlr := make([]byte, 24)
	copy(hdlr[8:], "vide")
	file := append(box("ftyp", []byte("isomxxxxisom")), box("moov", append(box("mvhd", mvhd), box("trak", append(box("tkhd", tkhd), box("mdia", box("hdlr", hdlr))...))...))...)
	p := filepath.Join(t.TempDir(), "v.mp4")
	_ = os.WriteFile(p, file, 0o644)
	info := Decide("v.mp4", file, false, int64(len(file)), p)
	if info.Type != Video || info.DurationMs != 5000 || info.Width != 640 || info.Height != 360 {
		t.Fatalf("video info = %+v", info)
	}
}
