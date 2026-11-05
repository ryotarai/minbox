package notify

import (
	"regexp"
	"strings"
)

// escapeSlack escapes the three characters Slack treats as markup.
func escapeSlack(s string) string {
	s = strings.ReplaceAll(s, "&", "&amp;")
	s = strings.ReplaceAll(s, "<", "&lt;")
	return strings.ReplaceAll(s, ">", "&gt;")
}

var (
	inlineRe  = regexp.MustCompile("`[^`\n]+`|\\[([^\\]\n]+)\\]\\(([^)\\s]+)\\)|\\*\\*(.+?)\\*\\*|__(.+?)__|~~(.+?)~~|\\*([^*\\s][^*\n]*?)\\*")
	headingRe = regexp.MustCompile(`^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$`)
	bulletRe  = regexp.MustCompile(`^(\s*)[-*+]\s+`)
	ruleRe    = regexp.MustCompile(`^\s{0,3}(-{3,}|\*{3,}|_{3,})\s*$`)
	tableRe   = regexp.MustCompile(`^\s*\|.*\|\s*$`)
)

// inline converts the Markdown inside one line: bold, italic, strike, links; code is kept.
func inline(s string) string {
	var b strings.Builder
	last := 0
	for _, m := range inlineRe.FindAllStringSubmatchIndex(s, -1) {
		b.WriteString(escapeSlack(s[last:m[0]]))
		last = m[1]
		tok := s[m[0]:m[1]]
		switch {
		case tok[0] == '`':
			b.WriteString("`" + escapeSlack(tok[1:len(tok)-1]) + "`")
		case tok[0] == '[':
			text, href := s[m[2]:m[3]], s[m[4]:m[5]]
			b.WriteString("<" + strings.ReplaceAll(href, "&", "&amp;") + "|" + escapeSlack(text) + ">")
		case strings.HasPrefix(tok, "**"):
			b.WriteString("*" + inline(s[m[6]:m[7]]) + "*")
		case strings.HasPrefix(tok, "__"):
			b.WriteString("*" + inline(s[m[8]:m[9]]) + "*")
		case strings.HasPrefix(tok, "~~"):
			b.WriteString("~" + inline(s[m[10]:m[11]]) + "~")
		default:
			b.WriteString("_" + inline(s[m[12]:m[13]]) + "_")
		}
	}
	b.WriteString(escapeSlack(s[last:]))
	return b.String()
}

// Mrkdwn converts Markdown to Slack's mrkdwn on a best-effort basis: **bold** becomes *bold*,
// [t](u) becomes <u|t>, headings become bold lines, lists get bullets, tables go into a code
// block, code fences are kept, and & < > are escaped.
func Mrkdwn(md string) string {
	lines := strings.Split(strings.ReplaceAll(md, "\r\n", "\n"), "\n")
	var out []string
	fence, table := false, false
	closeTable := func() {
		if table {
			out = append(out, "```")
			table = false
		}
	}
	for _, l := range lines {
		if strings.HasPrefix(strings.TrimLeft(l, " "), "```") {
			closeTable()
			fence = !fence
			out = append(out, "```")
			continue
		}
		if fence {
			out = append(out, escapeSlack(l))
			continue
		}
		if tableRe.MatchString(l) {
			if !table {
				out = append(out, "```")
				table = true
			}
			out = append(out, escapeSlack(l))
			continue
		}
		closeTable()
		switch {
		case headingRe.MatchString(l):
			h := headingRe.FindStringSubmatch(l)[1]
			h = strings.NewReplacer("**", "", "__", "").Replace(h)
			out = append(out, "*"+inline(h)+"*")
		case ruleRe.MatchString(l):
			out = append(out, "──────────")
		case strings.HasPrefix(l, ">"):
			out = append(out, "> "+inline(strings.TrimSpace(strings.TrimLeft(l, "> "))))
		case bulletRe.MatchString(l):
			out = append(out, inlineBullet(l))
		default:
			out = append(out, inline(l))
		}
	}
	closeTable()
	return strings.Join(out, "\n")
}

func inlineBullet(l string) string {
	m := bulletRe.FindStringSubmatch(l)
	return m[1] + "• " + inline(l[len(m[0]):])
}

// splitMrkdwn cuts s into pieces of at most max characters, at line ends where it can, and keeps
// code fences balanced across the cuts.
func splitMrkdwn(s string, max int) []string {
	rs := []rune(s)
	budget := max - 8 // room to close and reopen a fence
	var parts []string
	prefix := ""
	for {
		room := budget - len([]rune(prefix))
		if len(rs) <= room {
			parts = append(parts, prefix+string(rs))
			return parts
		}
		cut := room
		for i := room; i > room/2; i-- {
			if rs[i-1] == '\n' {
				cut = i
				break
			}
		}
		if cut == room {
			for i := room; i > room/2; i-- {
				if rs[i-1] == ' ' {
					cut = i
					break
				}
			}
		}
		chunk := prefix + strings.TrimRight(string(rs[:cut]), "\n")
		rs = rs[cut:]
		prefix = ""
		if strings.Count(chunk, "```")%2 == 1 {
			chunk += "\n```"
			prefix = "```\n"
		}
		parts = append(parts, chunk)
	}
}
