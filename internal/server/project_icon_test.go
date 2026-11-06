package server

import (
	"bytes"
	"image"
	"image/color"
	"image/jpeg"
	"image/png"
	"strings"
	"testing"
)

func iconTestPNG(w, h int) []byte {
	img := image.NewNRGBA(image.Rect(0, 0, w, h))
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			img.Set(x, y, color.NRGBA{R: 200, G: uint8(x % 256), B: 30, A: 255})
		}
	}
	var b bytes.Buffer
	_ = png.Encode(&b, img)
	return b.Bytes()
}

func TestProjectIcon(t *testing.T) {
	e := newEnv(t)
	dir := e.mkdir("iconp")
	_, obj, _ := e.do("POST", "/api/sessions", map[string]string{"cwd": dir}, nil)
	pid := obj["project_id"].(string)
	icon := func() any {
		for _, p := range e.projects("") {
			if p["id"] == pid {
				return p["icon"]
			}
		}
		t.Fatal("project missing")
		return nil
	}
	if icon() != nil {
		t.Fatalf("icon = %v, want null", icon())
	}

	// Emoji: set, validate.
	if code, o, _ := e.do("PUT", "/api/projects/"+pid+"/icon", map[string]string{"emoji": "🚀"}, nil); code != 200 {
		t.Fatalf("set emoji: %d %v", code, o)
	}
	if m, _ := icon().(map[string]any); m["kind"] != "emoji" || m["emoji"] != "🚀" {
		t.Fatalf("icon = %v", icon())
	}
	for _, ok := range []string{"👩‍💻", "🇯🇵", "🚀🔥✨", "1️⃣"} {
		if code, _, _ := e.do("PUT", "/api/projects/"+pid+"/icon", map[string]string{"emoji": ok}, nil); code != 200 {
			t.Errorf("emoji %q: %d", ok, code)
		}
	}
	for _, bad := range []string{"", "  ", "abc", "http://x.y", "🚀🚀🚀🚀", "a🚀", "🚀\x01", strings.Repeat("🚀", 5)} {
		if code, _, _ := e.do("PUT", "/api/projects/"+pid+"/icon", map[string]string{"emoji": bad}, nil); code != 400 {
			t.Errorf("emoji %q: %d, want 400", bad, code)
		}
	}
	if code, _, _ := e.do("PUT", "/api/projects/nope/icon", map[string]string{"emoji": "🚀"}, nil); code != 404 {
		t.Errorf("unknown project: %d", code)
	}
	if code, _, _ := e.get("/api/projects/"+pid+"/icon", nil); code != 404 {
		t.Errorf("GET icon of an emoji project: %d", code)
	}

	// Image: a wide PNG becomes a 128x128 square PNG.
	if code, o := e.raw("PUT", "/api/projects/"+pid+"/icon", "image/png", iconTestPNG(300, 100)); code != 200 {
		t.Fatalf("upload: %d %v", code, o)
	}
	m, _ := icon().(map[string]any)
	url, _ := m["url"].(string)
	if m["kind"] != "image" || !strings.HasPrefix(url, "/api/projects/"+pid+"/icon?v=") {
		t.Fatalf("icon = %v", m)
	}
	code, hdr, body := e.get(url, nil)
	if code != 200 || hdr.Get("Content-Type") != "image/png" || !strings.Contains(hdr.Get("Cache-Control"), "immutable") || !strings.Contains(hdr.Get("Cache-Control"), "max-age=31536000") {
		t.Fatalf("GET icon: %d %v", code, hdr)
	}
	cfg, err := png.DecodeConfig(bytes.NewReader(body))
	if err != nil || cfg.Width != 128 || cfg.Height != 128 {
		t.Fatalf("icon is %dx%d (%v)", cfg.Width, cfg.Height, err)
	}
	// The list stays light: no bytes in it.
	if _, _, list := e.get("/api/projects", nil); len(list) > 2000 || bytes.Contains(list, []byte("iVBOR")) {
		t.Fatalf("project list carries image bytes (%d bytes)", len(list))
	}
	// JPEG works too.
	var jb bytes.Buffer
	_ = jpeg.Encode(&jb, image.NewRGBA(image.Rect(0, 0, 40, 60)), nil)
	if code, o := e.raw("PUT", "/api/projects/"+pid+"/icon", "image/jpeg", jb.Bytes()); code != 200 {
		t.Fatalf("jpeg: %d %v", code, o)
	}
	// Garbage and oversize are 400.
	if code, _ := e.raw("PUT", "/api/projects/"+pid+"/icon", "image/png", []byte("not an image")); code != 400 {
		t.Errorf("garbage: %d", code)
	}
	if code, _ := e.raw("PUT", "/api/projects/"+pid+"/icon", "image/png", append(iconTestPNG(10, 10), make([]byte, 2<<20)...)); code != 400 {
		t.Errorf("oversize: %d", code)
	}

	// Clear.
	if code, _, _ := e.do("DELETE", "/api/projects/"+pid+"/icon", nil, nil); code != 200 {
		t.Fatalf("clear: %d", code)
	}
	if icon() != nil {
		t.Fatalf("icon after clear = %v", icon())
	}
	if code, _, _ := e.get("/api/projects/"+pid+"/icon", nil); code != 404 {
		t.Errorf("GET after clear: %d", code)
	}

	// Delete takes the icon with the project.
	e.raw("PUT", "/api/projects/"+pid+"/icon", "image/png", iconTestPNG(20, 20))
	if code, _, _ := e.do("DELETE", "/api/projects/"+pid, nil, nil); code != 200 {
		t.Fatalf("delete project: %d", code)
	}
	if code, _, _ := e.get("/api/projects/"+pid+"/icon", nil); code != 404 {
		t.Errorf("GET after project delete: %d", code)
	}
}
