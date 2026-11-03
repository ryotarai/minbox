package server

import (
	"errors"
	"fmt"
	"math"
	"path/filepath"
	"sort"
	"strings"

	"github.com/ryotarai/minbox/internal/attach"
	"github.com/ryotarai/minbox/internal/store"
)

// The person's comments on attached files, composed into the reply the agent
// reads the way Plannotator does (docs/research/plannotator-attachments.md §4.1).

const markupOnlyText = "See the marked-up image."

var annotationKinds = map[string]bool{"comment": true, "region": true, "pen": true, "video": true, "element": true, "diagram": true}

func validateAnnotations(in []store.Annotation) ([]store.Annotation, error) {
	if len(in) > 500 {
		return nil, errors.New("too many annotations")
	}
	var out []store.Annotation
	for _, a := range in {
		a.Comment = strings.TrimSpace(a.Comment)
		if a.ImagePath != "" && len(a.Images) == 0 {
			a.Images = []store.AnnotationImage{{Path: a.ImagePath, Name: strings.TrimSuffix(filepath.Base(a.ImagePath), filepath.Ext(a.ImagePath)) + ", marked up"}}
		}
		if a.Comment == "" && len(a.Images) == 0 {
			continue
		}
		if a.Kind == "" {
			a.Kind = "comment"
		}
		if !annotationKinds[a.Kind] {
			return nil, fmt.Errorf("unknown annotation kind %q", a.Kind)
		}
		switch a.Version {
		case "":
			a.Version = "current"
		case "current", "sent":
		default:
			return nil, fmt.Errorf("annotation version must be current or sent")
		}
		if a.LineStart == 0 && a.Line > 0 {
			a.LineStart = a.Line
		}
		if a.LineEnd < a.LineStart {
			a.LineEnd = a.LineStart
		}
		if len([]rune(a.Comment)) > 20000 || len([]rune(a.Quote)) > 20000 {
			return nil, errors.New("annotation is too long")
		}
		out = append(out, a)
	}
	return out, nil
}

// feedbackGroup is one file (and version) the person commented on.
type feedbackGroup struct {
	label string
	att   *store.Attachment
	anns  []store.Annotation
}

// composeFeedback is the "# Feedback on the attached files" part of a reply.
// atts finds an attachment by id; cwd is the session's folder.
func composeFeedback(anns []store.Annotation, atts map[string]*store.Attachment, cwd string, timeOf func(*store.Attachment) string) string {
	if len(anns) == 0 {
		return ""
	}
	var groups []*feedbackGroup
	byKey := map[string]*feedbackGroup{}
	anyInline := false
	for _, a := range anns {
		key := a.AttachmentID + "\x00" + a.Version
		g, ok := byKey[key]
		if !ok {
			at := atts[a.AttachmentID]
			label := a.Name
			switch {
			case at != nil && at.Inline:
				anyInline = true
				label = at.Ref + " (image in your " + timeOf(at) + " message)"
			case at != nil:
				label = labelOf(at.Path, cwd)
			}
			if label == "" {
				label = "a file"
			}
			if a.Version == "sent" {
				label += " (the version you sent)"
			}
			g = &feedbackGroup{label: label, att: at}
			byKey[key] = g
			groups = append(groups, g)
		}
		g.anns = append(g.anns, a)
	}
	var b strings.Builder
	b.WriteString("# Feedback on the attached files\n\n")
	if anyInline {
		b.WriteString("The following feedback is on the files you attached and the images your messages showed, one section per file and version.\n")
	} else {
		b.WriteString("The following feedback is on the files you attached, one section per file and version.\n")
	}
	for _, g := range groups {
		// Video comments read in time order.
		sort.SliceStable(g.anns, func(i, j int) bool {
			ti, tj := g.anns[i].Time, g.anns[j].Time
			return ti != nil && tj != nil && *ti < *tj
		})
		n := len(g.anns)
		piece := "pieces"
		if n == 1 {
			piece = "piece"
		}
		fmt.Fprintf(&b, "\n## %s\n\nI've reviewed this document and have %d %s of feedback:\n", g.label, n, piece)
		for i, a := range g.anns {
			b.WriteString("\n")
			writeEntry(&b, i+1, a, g)
		}
		b.WriteString("\n---\n")
	}
	return strings.TrimRight(b.String(), "\n")
}

func labelOf(path, cwd string) string {
	for _, dir := range []string{cwd, realDir(cwd)} {
		if dir != "" && strings.HasPrefix(path, dir+string(filepath.Separator)) {
			return path[len(dir)+1:]
		}
	}
	return path
}

// realDir is a folder's real path ("" stays "").
func realDir(dir string) string {
	if dir == "" {
		return ""
	}
	if r, err := filepath.EvalSymlinks(dir); err == nil {
		return r
	}
	return dir
}

func writeEntry(b *strings.Builder, n int, a store.Annotation, g *feedbackGroup) {
	name := a.Name
	if g.att != nil {
		name = g.att.Name
		if g.att.Inline {
			name = g.att.Ref
		}
	}
	quote := oneLine(a.Quote, 400)
	loc := ""
	switch {
	case a.LineStart > 0 && a.LineEnd > a.LineStart:
		loc = fmt.Sprintf("(lines %d–%d) ", a.LineStart, a.LineEnd)
	case a.LineStart > 0:
		loc = fmt.Sprintf("(line %d) ", a.LineStart)
	}
	var extra []string
	switch {
	case a.Kind == "region" && a.Region != nil:
		fmt.Fprintf(b, "### %d. Feedback on a region of the image %s\n", n, name)
		r := a.Region
		extra = append(extra, "Image: "+name, fmt.Sprintf("Region: x=%d y=%d w=%d h=%d (of %d×%d)",
			int(math.Round(r.X)), int(math.Round(r.Y)), int(math.Round(r.W)), int(math.Round(r.H)), int(math.Round(r.NaturalW)), int(math.Round(r.NaturalH))))
	case a.Kind == "video" && a.Time != nil:
		at := videoTime(*a.Time)
		fmt.Fprintf(b, "### %d. Feedback on: \"%s at %s\"\n", n, name, at)
		of := ""
		if g.att != nil && g.att.DurationMs > 0 {
			of = " of " + videoTime(float64(g.att.DurationMs)/1000)
		}
		extra = append(extra, fmt.Sprintf("At %s (%.1f s%s)", at, *a.Time, of))
	case quote == "" && g.att != nil && g.att.Type == attach.Image:
		fmt.Fprintf(b, "### %d. Feedback on: %q\n", n, name)
	case quote == "":
		fmt.Fprintf(b, "### %d. %sFeedback on: %q\n", n, loc, name)
	default:
		fmt.Fprintf(b, "### %d. %sFeedback on: \"%s\"\n", n, loc, quote)
	}
	for _, l := range extra {
		b.WriteString(l + "\n")
	}
	text := a.Comment
	if text == "" && len(a.Images) > 0 {
		text = markupOnlyText
	}
	for _, l := range strings.Split(text, "\n") {
		b.WriteString("> " + l + "\n")
	}
	if len(a.Images) > 0 {
		b.WriteString("\n**Attached images:**\n")
		for _, im := range a.Images {
			fmt.Fprintf(b, "- [%s] `%s`\n", im.Name, im.Path)
		}
	}
}

// videoTime: m:ss, or h:mm:ss from an hour, floored.
func videoTime(sec float64) string {
	t := int(math.Floor(sec))
	if t >= 3600 {
		return fmt.Sprintf("%d:%02d:%02d", t/3600, t%3600/60, t%60)
	}
	return fmt.Sprintf("%d:%02d", t/60, t%60)
}
