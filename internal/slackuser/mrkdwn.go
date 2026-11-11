package slackuser

import (
	"html"
	"regexp"
	"strconv"
	"strings"
)

// Resolver names users and channels for rendering (either may be nil or return "").
type Resolver struct {
	User    func(id string) string
	Channel func(id string) string
}

var (
	fenceRe  = regexp.MustCompile("(?s)```(.*?)```")
	inlineRe = regexp.MustCompile("`([^`\n]+)`")
	angleRe  = regexp.MustCompile(`<([^<>\n]+)>`)
	boldRe   = regexp.MustCompile(`\*([^*\n]+)\*`)
	italicRe = regexp.MustCompile(`(^|[\s(>])_([^_\n]+)_($|[\s).,!?:;<])`)
	strikeRe = regexp.MustCompile(`~([^~\n]+)~`)
	phRe     = regexp.MustCompile("\x00(\\d+)\x00")
)

// SafeURL: only http, https and mailto links are ever made clickable.
func SafeURL(u string) bool {
	l := strings.ToLower(strings.TrimSpace(u))
	return strings.HasPrefix(l, "http://") || strings.HasPrefix(l, "https://") || strings.HasPrefix(l, "mailto:")
}

func plain(s string) string {
	// Slack escapes only & < > in text.
	s = strings.NewReplacer("&lt;", "<", "&gt;", ">", "&amp;", "&").Replace(s)
	return html.EscapeString(s)
}

// RenderHTML turns Slack mrkdwn into HTML that is safe to insert: everything is escaped first, only
// the tags written here (b, i, s, code, pre, blockquote, a, br, span) can appear, and links are
// limited to http, https and mailto. Emoji shortcodes stay as text. Raw HTML in the message is shown
// as text.
func RenderHTML(text string, rs Resolver) string {
	text = strings.ReplaceAll(text, "\x00", "")
	var ph []string
	put := func(h string) string {
		ph = append(ph, h)
		return "\x00" + strconv.Itoa(len(ph)-1) + "\x00"
	}
	text = fenceRe.ReplaceAllStringFunc(text, func(m string) string {
		in := fenceRe.FindStringSubmatch(m)[1]
		return put("<pre><code>" + plain(strings.Trim(in, "\n")) + "</code></pre>")
	})
	text = inlineRe.ReplaceAllStringFunc(text, func(m string) string {
		return put("<code>" + plain(inlineRe.FindStringSubmatch(m)[1]) + "</code>")
	})
	text = angleRe.ReplaceAllStringFunc(text, func(m string) string {
		return put(renderAngle(angleRe.FindStringSubmatch(m)[1], rs))
	})
	// Escape the rest, then the inline formats.
	text = plain(text)
	text = boldRe.ReplaceAllString(text, "<b>$1</b>")
	for i := 0; i < 2; i++ { // twice: adjacent matches share a delimiter
		text = italicRe.ReplaceAllString(text, "$1<i>$2</i>$3")
	}
	text = strikeRe.ReplaceAllString(text, "<s>$1</s>")
	// Block quotes: consecutive lines starting with ">" (escaped: &gt;).
	lines := strings.Split(text, "\n")
	var out []string
	var quote []string
	flush := func() {
		if len(quote) > 0 {
			out = append(out, "<blockquote>"+strings.Join(quote, "<br>")+"</blockquote>")
			quote = nil
		}
	}
	for _, l := range lines {
		if strings.HasPrefix(l, "&gt;") {
			quote = append(quote, strings.TrimPrefix(strings.TrimPrefix(l, "&gt;"), " "))
			continue
		}
		flush()
		out = append(out, l)
	}
	flush()
	var b strings.Builder
	for i, l := range out {
		if i > 0 && !strings.HasPrefix(l, "<blockquote>") && !strings.HasSuffix(out[i-1], "</blockquote>") {
			b.WriteString("<br>")
		}
		b.WriteString(l)
	}
	res := b.String()
	// Placeholders may nest (a link inside nothing here, but code was cut first): one pass is enough.
	return phRe.ReplaceAllStringFunc(res, func(m string) string {
		n, _ := strconv.Atoi(phRe.FindStringSubmatch(m)[1])
		if n >= 0 && n < len(ph) {
			return ph[n]
		}
		return ""
	})
}

func renderAngle(in string, rs Resolver) string {
	target, label, _ := strings.Cut(in, "|")
	switch {
	case strings.HasPrefix(target, "@"):
		id := strings.TrimPrefix(target, "@")
		name := ""
		if rs.User != nil {
			name = rs.User(id)
		}
		name = firstNonEmpty(name, strings.TrimPrefix(label, "@"), id)
		return `<span class="mention">@` + plain(name) + `</span>`
	case strings.HasPrefix(target, "#"):
		id := strings.TrimPrefix(target, "#")
		name := label
		if name == "" && rs.Channel != nil {
			name = rs.Channel(id)
		}
		return `<span class="mention">#` + plain(firstNonEmpty(name, id)) + `</span>`
	case strings.HasPrefix(target, "!"):
		cmd := strings.TrimPrefix(target, "!")
		if strings.HasPrefix(cmd, "subteam^") {
			return `<span class="mention">` + plain(firstNonEmpty(label, "@group")) + `</span>`
		}
		if strings.HasPrefix(cmd, "date") {
			return plain(firstNonEmpty(label, "(date)"))
		}
		name := cmd
		if label != "" {
			name = strings.TrimPrefix(label, "@")
		}
		return `<span class="mention">@` + plain(name) + `</span>`
	case SafeURL(target):
		t := html.UnescapeString(target)
		return `<a href="` + html.EscapeString(t) + `" target="_blank" rel="noopener noreferrer">` + plain(firstNonEmpty(label, strings.TrimPrefix(target, "mailto:"))) + `</a>`
	}
	return plain("<" + in + ">") // anything else is shown as text
}

// PlainText flattens mrkdwn to one readable line (mentions resolved, links shown by their label).
func PlainText(text string, rs Resolver) string {
	t := angleRe.ReplaceAllStringFunc(text, func(m string) string {
		in := angleRe.FindStringSubmatch(m)[1]
		target, label, _ := strings.Cut(in, "|")
		switch {
		case strings.HasPrefix(target, "@"):
			id := strings.TrimPrefix(target, "@")
			name := ""
			if rs.User != nil {
				name = rs.User(id)
			}
			return "@" + firstNonEmpty(name, strings.TrimPrefix(label, "@"), id)
		case strings.HasPrefix(target, "#"):
			return "#" + firstNonEmpty(label, strings.TrimPrefix(target, "#"))
		case strings.HasPrefix(target, "!"):
			return "@" + firstNonEmpty(strings.TrimPrefix(label, "@"), strings.TrimPrefix(target, "!"))
		}
		return firstNonEmpty(label, target)
	})
	return strings.NewReplacer("&lt;", "<", "&gt;", ">", "&amp;", "&").Replace(t)
}
