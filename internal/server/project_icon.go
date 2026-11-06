package server

import (
	"bytes"
	"errors"
	"fmt"
	"image"
	"image/color"
	_ "image/gif" // decoders for uploads
	_ "image/jpeg"
	"image/png"
	"io"
	"mime"
	"net/http"
	"strings"
	"unicode"
	"unicode/utf8"
)

const (
	iconMaxUpload = 2 << 20
	iconSize      = 128
	iconMaxEmoji  = 16 // bytes
)

// validEmoji checks an emoji icon: one to three grapheme-ish characters, short, no control
// characters, no letters or URL punctuation.
func validEmoji(s string) (string, error) {
	s = strings.TrimSpace(s)
	if s == "" {
		return "", errors.New("emoji is empty")
	}
	if len(s) > iconMaxEmoji {
		return "", errors.New("emoji is too long")
	}
	if !utf8.ValidString(s) {
		return "", errors.New("emoji is not valid text")
	}
	graphemes, joined, prevRI := 0, false, false
	for _, r := range s {
		switch {
		case unicode.IsControl(r), unicode.IsSpace(r):
			return "", errors.New("emoji has control or space characters")
		case r < 0x80 && !(r >= '0' && r <= '9' || r == '#' || r == '*'):
			return "", errors.New("not an emoji")
		}
		switch {
		case r == 0x200D: // zero width joiner: the next one belongs to the same character
			joined = true
			continue
		case r == 0xFE0F, r == 0xFE0E, r == 0x20E3, r >= 0x1F3FB && r <= 0x1F3FF, r >= 0xE0020 && r <= 0xE007F, unicode.Is(unicode.Mn, r):
			continue
		case r >= 0x1F1E6 && r <= 0x1F1FF: // flags: two regional indicators
			if prevRI {
				prevRI = false
				continue
			}
			prevRI = true
		default:
			prevRI = false
		}
		if joined {
			joined = false
			continue
		}
		graphemes++
	}
	if graphemes < 1 || graphemes > 3 {
		return "", errors.New("use one to three emoji")
	}
	return s, nil
}

// squareIcon crops the center square of src and scales it to size x size (a box filter, which
// also averages when shrinking), then encodes PNG.
func squareIcon(src image.Image, size int) ([]byte, error) {
	b := src.Bounds()
	side := min(b.Dx(), b.Dy())
	if side <= 0 {
		return nil, errors.New("empty image")
	}
	x0, y0 := b.Min.X+(b.Dx()-side)/2, b.Min.Y+(b.Dy()-side)/2
	dst := image.NewNRGBA64(image.Rect(0, 0, size, size))
	for y := 0; y < size; y++ {
		sy0, sy1 := y0+y*side/size, y0+(y+1)*side/size
		if sy1 <= sy0 {
			sy1 = sy0 + 1
		}
		for x := 0; x < size; x++ {
			sx0, sx1 := x0+x*side/size, x0+(x+1)*side/size
			if sx1 <= sx0 {
				sx1 = sx0 + 1
			}
			var r, g, bl, a, n uint64
			for sy := sy0; sy < sy1; sy++ {
				for sx := sx0; sx < sx1; sx++ {
					cr, cg, cb, ca := src.At(sx, sy).RGBA() // premultiplied, 16 bit
					r, g, bl, a, n = r+uint64(cr), g+uint64(cg), bl+uint64(cb), a+uint64(ca), n+1
				}
			}
			r, g, bl, a = r/n, g/n, bl/n, a/n
			dst.SetNRGBA64(x, y, color.NRGBA64{R: unpremul(r, a), G: unpremul(g, a), B: unpremul(bl, a), A: uint16(a)})
		}
	}
	var out bytes.Buffer
	if err := png.Encode(&out, dst); err != nil {
		return nil, err
	}
	return out.Bytes(), nil
}

func unpremul(c, a uint64) uint16 {
	if a == 0 {
		return 0
	}
	return uint16(min(c*0xffff/a, 0xffff))
}

func (s *Server) putProjectIcon(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if _, err := s.store.GetProject(r.Context(), id); err != nil {
		storeError(w, err)
		return
	}
	ctype, _, _ := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if ctype == "application/json" || ctype == "" {
		var req struct {
			Emoji string `json:"emoji"`
		}
		if !decode(w, r, &req) {
			return
		}
		e, err := validEmoji(req.Emoji)
		if err != nil {
			httpError(w, 400, err.Error())
			return
		}
		if err := s.store.SetProjectEmoji(r.Context(), id, e); err != nil {
			storeError(w, err)
			return
		}
		s.iconDone(w, r, id)
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, iconMaxUpload+64<<10)
	var data []byte
	var err error
	if ctype == "multipart/form-data" {
		if err = r.ParseMultipartForm(iconMaxUpload); err != nil {
			httpError(w, 400, "upload too large or malformed")
			return
		}
		f, _, ferr := r.FormFile("file")
		if ferr != nil {
			httpError(w, 400, "missing file field")
			return
		}
		defer f.Close()
		data, err = io.ReadAll(io.LimitReader(f, iconMaxUpload+1))
	} else {
		data, err = io.ReadAll(io.LimitReader(r.Body, iconMaxUpload+1))
	}
	if err != nil || len(data) > iconMaxUpload {
		httpError(w, 400, "image is over 2 MB")
		return
	}
	cfg, _, err := image.DecodeConfig(bytes.NewReader(data))
	if err != nil || cfg.Width <= 0 || cfg.Height <= 0 || cfg.Width*cfg.Height > 64<<20 {
		httpError(w, 400, "not a PNG, JPEG or GIF image")
		return
	}
	img, _, err := image.Decode(bytes.NewReader(data))
	if err != nil {
		httpError(w, 400, "not a PNG, JPEG or GIF image")
		return
	}
	out, err := squareIcon(img, iconSize)
	if err != nil {
		httpError(w, 400, err.Error())
		return
	}
	if err := s.store.SetProjectImage(r.Context(), id, out); err != nil {
		storeError(w, err)
		return
	}
	s.iconDone(w, r, id)
}

func (s *Server) iconDone(w http.ResponseWriter, r *http.Request, id string) {
	p, err := s.store.GetProject(r.Context(), id)
	if err != nil {
		storeError(w, err)
		return
	}
	s.publishProjects(false)
	writeJSON(w, 200, s.projectJSON(r, *p)[0])
}

func (s *Server) deleteProjectIcon(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if err := s.store.ClearProjectIcon(r.Context(), id); err != nil {
		storeError(w, err)
		return
	}
	s.iconDone(w, r, id)
}

func (s *Server) getProjectIcon(w http.ResponseWriter, r *http.Request) {
	b, err := s.store.ProjectIconPNG(r.Context(), r.PathValue("id"))
	if err != nil {
		storeError(w, err)
		return
	}
	w.Header().Set("Content-Type", "image/png")
	w.Header().Set("Content-Length", fmt.Sprint(len(b)))
	w.Header().Set("Cache-Control", "private, max-age=31536000, immutable")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	_, _ = w.Write(b)
}
