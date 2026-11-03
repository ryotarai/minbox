package server

import (
	"bytes"
	"encoding/json"
	"image"
	"image/png"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func pngFile(t *testing.T, path string, w, h int) []byte {
	t.Helper()
	var b bytes.Buffer
	_ = png.Encode(&b, image.NewRGBA(image.Rect(0, 0, w, h)))
	if path != "" {
		if err := os.WriteFile(path, b.Bytes(), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	return b.Bytes()
}

// get fetches a route and answers status, headers and body.
func (e *env) get(path string, header map[string]string) (int, http.Header, []byte) {
	e.t.Helper()
	req, _ := http.NewRequest("GET", e.ts.URL+path, nil)
	for k, v := range header {
		req.Header.Set(k, v)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		e.t.Fatal(err)
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, resp.Header, b
}

func (e *env) raw(method, path, ctype string, body []byte) (int, map[string]any) {
	e.t.Helper()
	req, _ := http.NewRequest(method, e.ts.URL+path, bytes.NewReader(body))
	req.Header.Set("Content-Type", ctype)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		e.t.Fatal(err)
	}
	defer resp.Body.Close()
	var obj map[string]any
	_ = json.NewDecoder(resp.Body).Decode(&obj)
	return resp.StatusCode, obj
}

func TestAgentAttachmentRules(t *testing.T) {
	e := newEnv(t)
	sess := e.createSession()
	write := func(name, text string) { _ = os.WriteFile(filepath.Join(e.dir, name), []byte(text), 0o644) }
	write(".env", "SECRET=1")
	write(".env.local", "SECRET=1")
	write(".env.example", "KEY=")
	write("big.log", strings.Repeat("x", 6<<20)) // over the old 5 MB cap: fine now
	_ = os.Mkdir(filepath.Join(e.dir, "dir"), 0o755)
	_ = os.Symlink(filepath.Join(e.dir, ".env"), filepath.Join(e.dir, "innocent.txt"))
	_ = os.Symlink(filepath.Join(e.dir, "big.log"), filepath.Join(e.dir, "link.log"))

	for _, c := range []struct {
		path, want string
	}{
		{".env", "attachments[0]: .env: .env files are never attached (they hold secrets)."},
		{".env.local", ".env files are never attached"},
		{"innocent.txt", "innocent.txt resolves to .env: .env files are never attached"},
		{"dir", "a folder. Attach the files in it, or a zip of them."},
		{"nope.md", "nope.md: no such file."},
	} {
		code, obj, _ := e.do("POST", "/api/agent/messages", map[string]any{"body": "x", "attachments": []string{c.path}}, bearer(sess))
		if code != 400 || !strings.Contains(obj["error"].(string), c.want) {
			t.Errorf("%s: %d %v", c.path, code, obj)
		}
	}
	code, sent, _ := e.do("POST", "/api/agent/messages", map[string]any{"body": "x", "attachments": []string{".env.example", "big.log", "link.log"}}, bearer(sess))
	if code != 201 {
		t.Fatalf("send: %d %v", code, sent)
	}
	atts := sent["attachments"].([]any)
	if len(atts) != 3 || atts[0].(map[string]any)["kind"] != "text" || atts[1].(map[string]any)["kind"] != "text" {
		t.Fatalf("attachments = %v", atts)
	}
	_, th, _ := e.do("GET", "/api/threads/"+sent["thread_id"].(string), nil, nil)
	link := th["messages"].([]any)[0].(map[string]any)["attachments"].([]any)[2].(map[string]any)
	if link["name"] != "big.log" || !strings.HasSuffix(link["named_path"].(string), "link.log") {
		t.Fatalf("symlink record = %v", link)
	}
	// Bytes live in the blob store.
	ents, _ := os.ReadDir(filepath.Join(e.dir, "blobs"))
	if len(ents) < 2 {
		t.Fatalf("blobs = %v", ents)
	}
}

func TestRawDownloadAndView(t *testing.T) {
	e := newEnv(t)
	sess := e.createSession()
	pngFile(t, filepath.Join(e.dir, "shot.png"), 4, 3)
	_ = os.WriteFile(filepath.Join(e.dir, "page.html"), []byte(`<html><head><title>x</title></head><body><img src="img/a.png"></body></html>`), 0o644)
	_ = os.Mkdir(filepath.Join(e.dir, "img"), 0o755)
	pngFile(t, filepath.Join(e.dir, "img", "a.png"), 2, 2)
	_ = os.WriteFile(filepath.Join(e.dir, ".secret"), []byte("no"), 0o644)
	_ = os.WriteFile(filepath.Join(e.dir, "doc.pdf"), []byte("%PDF-1.4 x"), 0o644)

	_, sent, _ := e.do("POST", "/api/agent/messages", map[string]any{"body": "x", "attachments": []string{"shot.png", "page.html", "doc.pdf"}}, bearer(sess))
	ids := []string{}
	for _, a := range sent["attachments"].([]any) {
		ids = append(ids, a.(map[string]any)["id"].(string))
	}
	_, att, _ := e.do("GET", "/api/attachments/"+ids[0], nil, nil)
	if att["type"] != "image" || att["width"].(float64) != 4 || att["height"].(float64) != 3 || att["mime"] != "image/png" {
		t.Fatalf("image att = %v", att)
	}
	code, h, _ := e.get("/api/attachments/"+ids[0]+"/raw?v=sent", nil)
	if code != 200 || h.Get("Content-Type") != "image/png" || h.Get("Content-Security-Policy") != cspImage || h.Get("X-Content-Type-Options") != "nosniff" {
		t.Fatalf("raw image: %d %v", code, h)
	}
	code, h, body := e.get("/api/attachments/"+ids[2]+"/download", nil)
	if code != 200 || h.Get("Content-Type") != "application/pdf" || !strings.HasPrefix(h.Get("Content-Disposition"), `attachment; filename="doc.pdf"`) || string(body) != "%PDF-1.4 x" {
		t.Fatalf("download: %d %v", code, h)
	}
	code, h, _ = e.get("/api/attachments/"+ids[1]+"/raw", nil)
	if h.Get("Content-Type") != "text/plain; charset=utf-8" || h.Get("Content-Security-Policy") != "sandbox" {
		t.Fatalf("raw html is served as text: %d %v", code, h)
	}

	// The view puts a <base> to the folder's assets in the document.
	_, view, _ := e.do("GET", "/api/attachments/"+ids[1]+"/view", nil, nil)
	html := view["html"].(string)
	i := strings.Index(html, `<base href="/api/html-assets/`)
	if i < 0 || !strings.HasPrefix(html, "<html><head><base") {
		t.Fatalf("view html = %q", html)
	}
	base := html[i+len(`<base href="`):]
	base = base[:strings.Index(base, `"`)]
	// A sandboxed frame (opaque origin) loads the page's own files.
	code, h, _ = e.get(base+"img/a.png", map[string]string{"Sec-Fetch-Site": "cross-site", "Origin": "null"})
	if code != 200 || h.Get("Content-Type") != "image/png" || h.Get("Content-Security-Policy") != cspHTML {
		t.Fatalf("asset: %d %v", code, h)
	}
	for _, p := range []string{".secret", "img/../.secret", "%2e%2e/x"} {
		if code, _, _ := e.get(base+p, nil); code != 403 && code != 404 {
			t.Errorf("%s: %d", p, code)
		}
	}
	if code, _, _ := e.get("/api/html-assets/ffffffffffffffffffffffffffffffff/img/a.png", nil); code != 404 {
		t.Errorf("unknown token: %d", code)
	}
}

func TestEmbeds(t *testing.T) {
	e := newEnv(t)
	code, obj := e.raw("POST", "/api/embeds", "application/json", []byte(`{"html":"<!doctype html><p>hi</p>"}`))
	if code != 200 || len(obj["id"].(string)) != 32 {
		t.Fatalf("post: %d %v", code, obj)
	}
	code, h, body := e.get(obj["url"].(string), map[string]string{"Sec-Fetch-Site": "same-origin"})
	if code != 200 || h.Get("Content-Security-Policy") != cspEmbed || !strings.Contains(string(body), "--chart-1:#4f6bed") ||
		!strings.HasSuffix(string(body), "<p>hi</p>") || strings.Count(strings.ToLower(string(body)), "<!doctype") != 1 {
		t.Fatalf("get: %d %v %s", code, h, body)
	}
	big := `{"html":"` + strings.Repeat("a", embedMaxBytes+1) + `"}`
	if code, _ := e.raw("POST", "/api/embeds", "application/json", []byte(big)); code != 413 {
		t.Fatalf("big embed: %d", code)
	}
}

func TestInlineImagesCapturedAtSend(t *testing.T) {
	e := newEnv(t)
	sess := e.createSession()
	pngFile(t, filepath.Join(e.dir, "ok.png"), 2, 2)
	body := "Look: ![shot](ok.png) and <img src='missing.png'> and ![r](https://x/y.png)\n\n```\n![code](ok.png)\n```\n![t](notes.txt)"
	code, sent, _ := e.do("POST", "/api/agent/messages", map[string]any{"body": body}, bearer(sess))
	if code != 201 {
		t.Fatalf("send: %d %v", code, sent)
	}
	ns := sent["images_not_shown"].([]any)
	if len(ns) != 2 || ns[0].(map[string]any)["ref"] != "missing.png" || ns[0].(map[string]any)["not_yet"] != true ||
		ns[1].(map[string]any)["reason"] != "not an image (png, jpg, gif, webp, svg, avif, bmp, ico)" {
		t.Fatalf("not shown = %v", ns)
	}
	mid := sent["message_id"].(string)
	_, th, _ := e.do("GET", "/api/threads/"+sent["thread_id"].(string), nil, nil)
	inl := th["messages"].([]any)[0].(map[string]any)["inline_images"].([]any)
	if len(inl) != 1 || inl[0].(map[string]any)["ref"] != "ok.png" || th["attachment_count"].(float64) != 0 {
		t.Fatalf("inline = %v", inl)
	}
	code, h, _ := e.get("/api/messages/"+mid+"/image?path="+url.QueryEscape("ok.png"), nil)
	if code != 200 || h.Get("Content-Type") != "image/png" {
		t.Fatalf("image: %d %v", code, h)
	}
	if code, _, _ := e.get("/api/messages/"+mid+"/image?path=other.png", nil); code != 404 {
		t.Fatalf("unknown image: %d", code)
	}
}

func TestUploadsBecomeReplyAttachments(t *testing.T) {
	e := newEnv(t)
	sess := e.createSession()
	_, sent, _ := e.do("POST", "/api/agent/messages", map[string]any{"body": "hello", "subject": "S"}, bearer(sess))
	tid := sent["thread_id"].(string)

	for _, name := range []string{".env", "a/b.txt", "", "x‮y.txt"} {
		code, obj := e.raw("POST", "/api/uploads?name="+url.QueryEscape(name), "application/octet-stream", []byte("x"))
		if code != 400 || obj["code"] != "upload_refused" {
			t.Errorf("name %q: %d %v", name, code, obj)
		}
	}
	code, up := e.raw("POST", "/api/uploads?name=notes.png", "application/octet-stream", pngFile(t, "", 3, 3))
	if code != 201 {
		t.Fatalf("upload: %d %v", code, up)
	}
	u := up["upload"].(map[string]any)
	if u["type"] != "image" || u["name"] != "notes.png" {
		t.Fatalf("upload = %v", u)
	}
	_, pt := e.raw("POST", "/api/uploads?name=pasted-text-2026-11-03-1000.txt", "application/octet-stream", []byte("long words"))
	ptID := pt["upload"].(map[string]any)["upload_id"].(string)
	if _, txt, _ := e.do("GET", "/api/uploads/"+ptID+"/text", nil, nil); txt["text"] != "long words" {
		t.Fatalf("put back = %v", txt)
	}

	// A reply of files alone.
	code, msg, _ := e.do("POST", "/api/threads/"+tid+"/reply", map[string]any{"words": "", "uploads": []string{u["upload_id"].(string), ptID}}, nil)
	if code != 201 {
		t.Fatalf("reply: %d %v", code, msg)
	}
	atts := msg["attachments"].([]any)
	a0 := atts[0].(map[string]any)
	if len(atts) != 2 || a0["author"] != "user" || !strings.Contains(a0["path"].(string), filepath.Join("uploads", a0["id"].(string), "notes.png")) {
		t.Fatalf("attachments = %v", atts)
	}
	if fi, err := os.Stat(a0["path"].(string)); err != nil || fi.Mode().Perm() != 0o400 {
		t.Fatalf("copy: %v %v", fi, err)
	}
	if msg["body"] != "" {
		t.Fatalf("the stored body has no Attached lines: %q", msg["body"])
	}
	// The agent reads them as Attached lines.
	_, _, pending := e.do("GET", "/api/agent/pending?owner=o", nil, bearer(sess))
	body := pending[0].(map[string]any)["body"].(string)
	if !strings.HasPrefix(body, "Attached: notes.png (") || !strings.Contains(body, "\nAttached: pasted-text-2026-11-03-1000.txt (") {
		t.Fatalf("pending body = %q", body)
	}
	// A used upload is gone.
	if code, _, _ := e.do("POST", "/api/threads/"+tid+"/reply", map[string]any{"words": "again", "uploads": []string{u["upload_id"].(string)}}, nil); code != 404 {
		t.Fatalf("reused upload: %d", code)
	}
	// Words + files.
	_, up2 := e.raw("POST", "/api/uploads?name=log.txt", "application/octet-stream", []byte("log"))
	_, msg, _ = e.do("POST", "/api/sessions/"+sess.ID+"/threads", map[string]any{"subject": "Logs", "body": "see", "uploads": []string{up2["upload"].(map[string]any)["upload_id"].(string)}}, nil)
	_, _, pending = e.do("GET", "/api/agent/pending?owner=o", nil, bearer(sess))
	last := pending[len(pending)-1].(map[string]any)["body"].(string)
	if !strings.HasPrefix(last, "see\n\nAttached: log.txt (") {
		t.Fatalf("compose body = %q", last)
	}
	// Search finds a person's file by its words.
	_, res, _ := e.do("GET", "/api/search?q=log", nil, nil)
	if len(res["files"].([]any)) == 0 {
		t.Fatalf("search = %v", res)
	}
}

func TestFeedbackComposition(t *testing.T) {
	e := newEnv(t)
	sess := e.createSession()
	_ = os.MkdirAll(filepath.Join(e.dir, "src"), 0o755)
	_ = os.WriteFile(filepath.Join(e.dir, "src", "retry.go"), []byte("package src\n"), 0o644)
	pngFile(t, filepath.Join(e.dir, "shot.png"), 100, 50)
	_, sent, _ := e.do("POST", "/api/agent/messages", map[string]any{"body": "look", "attachments": []string{"src/retry.go", "shot.png"}}, bearer(sess))
	atts := sent["attachments"].([]any)
	code := atts[0].(map[string]any)["id"].(string)
	img := atts[1].(map[string]any)["id"].(string)
	_, msg, _ := e.do("POST", "/api/threads/"+sent["thread_id"].(string)+"/reply", map[string]any{"words": "Thanks.", "annotations": []any{
		map[string]any{"kind": "comment", "attachment_id": code, "version": "current", "quote": "package src", "line_start": 1, "comment": "Rename it."},
		map[string]any{"kind": "comment", "attachment_id": code, "version": "current", "quote": "func A()", "line_start": 12, "line_end": 14, "comment": "Two lines\nof note."},
		map[string]any{"kind": "region", "attachment_id": img, "version": "sent", "comment": "This button.",
			"region": map[string]any{"x": 10, "y": 5, "w": 20, "h": 10, "natural_w": 100, "natural_h": 50}},
		map[string]any{"kind": "pen", "attachment_id": img, "version": "sent", "comment": "",
			"images": []any{map[string]any{"path": "/d/markups/abc.png", "name": "shot, marked up"}}},
	}}, nil)
	want := `Thanks.

# Feedback on the attached files

The following feedback is on the files you attached, one section per file and version.

## src/retry.go

I've reviewed this document and have 2 pieces of feedback:

### 1. (line 1) Feedback on: "package src"
> Rename it.

### 2. (lines 12–14) Feedback on: "func A()"
> Two lines
> of note.

---

## shot.png (the version you sent)

I've reviewed this document and have 2 pieces of feedback:

### 1. Feedback on a region of the image shot.png
Image: shot.png
Region: x=10 y=5 w=20 h=10 (of 100×50)
> This button.

### 2. Feedback on: "shot.png"
> See the marked-up image.

**Attached images:**
- [shot, marked up] ` + "`/d/markups/abc.png`" + `

---`
	if msg["body"] != want {
		t.Fatalf("body =\n%s\n--- want ---\n%s", msg["body"], want)
	}
}

func TestMarkups(t *testing.T) {
	e := newEnv(t)
	code, obj := e.raw("POST", "/api/markups", "image/png", pngFile(t, "", 2, 2))
	if code != 201 || !strings.HasPrefix(obj["path"].(string), filepath.Join(e.dir, "markups")) {
		t.Fatalf("markup: %d %v", code, obj)
	}
	if code, h, _ := e.get(obj["url"].(string), nil); code != 200 || h.Get("Content-Type") != "image/png" {
		t.Fatalf("get markup: %d", code)
	}
	if code, _ := e.raw("POST", "/api/markups", "text/plain", []byte("nope")); code != 415 {
		t.Fatalf("not an image: %d", code)
	}
}
