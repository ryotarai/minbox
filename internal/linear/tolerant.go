package linear

import (
	"fmt"
	"regexp"
	"sort"
	"strconv"
	"strings"
)

// Tolerant reading of tool results whose shape is not known: keys are matched regardless of case
// and of _ / - (createdAt = created_at), items may be wrapped, and a result that is plain text
// (a markdown list or table) is read line by line.

func normKey(s string) string {
	var b strings.Builder
	for _, r := range strings.ToLower(s) {
		if r == '_' || r == '-' || r == ' ' {
			continue
		}
		b.WriteRune(r)
	}
	return b.String()
}

// field returns m[k] for the first of keys that is present with a non-nil value: exact match first,
// then ignoring case and _ / - in the key names.
func field(m map[string]any, keys ...string) any {
	if m == nil {
		return nil
	}
	for _, k := range keys {
		if v, ok := m[k]; ok && v != nil {
			return v
		}
	}
	names := make([]string, 0, len(m))
	for mk := range m {
		names = append(names, mk)
	}
	sort.Strings(names)
	for _, k := range keys {
		nk := normKey(k)
		for _, mk := range names {
			if m[mk] != nil && normKey(mk) == nk {
				return m[mk]
			}
		}
	}
	return nil
}

var (
	teamKeyRe = regexp.MustCompile(`^[A-Za-z][A-Za-z0-9]{1,9}$`)
	identTok  = regexp.MustCompile(`\b([A-Z][A-Z0-9]{1,9})-(\d{1,9})\b`)
)

// deriveIdentifier finds an issue's identifier ("ENG-123") in an item: its identifier field, an id
// that has that form, the URL, or the team key and number. "" when none.
func deriveIdentifier(m map[string]any) string {
	for _, k := range []string{"identifier", "key", "issueIdentifier", "shortId", "displayId", "id"} {
		if s := first(m, k); s != "" {
			if mm := identRe.FindStringSubmatch(s); mm != nil {
				return strings.ToUpper(mm[1]) + "-" + mm[2]
			}
		}
	}
	if u := first(m, "url", "link", "issueUrl", "webUrl"); u != "" {
		if id, err := ParseIssueRef(u); err == nil {
			return id
		}
	}
	if n := first(m, "number", "issueNumber"); n != "" {
		if _, err := strconv.Atoi(n); err == nil {
			key := ""
			switch t := field(m, "team").(type) {
			case map[string]any:
				key = first(t, "key", "identifier")
			case string:
				if teamKeyRe.MatchString(strings.TrimSpace(t)) {
					key = strings.TrimSpace(t)
				}
			}
			if key == "" {
				key = first(m, "teamKey")
			}
			if key != "" {
				return strings.ToUpper(key) + "-" + n
			}
		}
	}
	return ""
}

// ---- text results ----

var (
	mdLink     = regexp.MustCompile(`\[([^\]]*)\]\((https?://[^)\s]+)\)`)
	trailPar   = regexp.MustCompile(`\s*[(\[]([^()\[\]]{1,40})[)\]]\s*$`)
	statusKV   = regexp.MustCompile(`(?i)\b(?:status|state)\s*[:=]\s*([^,;|()\[\]]{1,40})`)
	prioKV     = regexp.MustCompile(`(?i)\bpriority\s*[:=]\s*([^,;|()\[\]]{1,20})`)
	listBullet = regexp.MustCompile(`^\s*(?:[-*+•]|\d+[.)])\s+`)
)

// TextIssueItems reads issues out of a plain-text or markdown result (a table with a header row, or
// one issue per line such as "- ENG-123: Title (In Progress)"). Each item is an issue-like object
// (identifier, title, status, priority, assignee, url); nil when no line carries an identifier.
func TextIssueItems(text string) []any {
	lines := strings.Split(strings.ReplaceAll(text, "\r", ""), "\n")
	var out []any
	seen := map[string]int{}
	add := func(m map[string]any) {
		if m == nil {
			return
		}
		id, _ := m["identifier"].(string)
		if id == "" {
			return
		}
		if i, ok := seen[id]; ok {
			prev := out[i].(map[string]any)
			for k, v := range m {
				if s, _ := prev[k].(string); s == "" {
					prev[k] = v
				}
			}
			return
		}
		seen[id] = len(out)
		out = append(out, m)
	}
	var header []string
	for i := 0; i < len(lines); i++ {
		ln := strings.TrimSpace(lines[i])
		if strings.HasPrefix(ln, "|") {
			cells := splitRow(ln)
			if i+1 < len(lines) && isSepRow(strings.TrimSpace(lines[i+1])) {
				header = cells
				for k := range header {
					header[k] = normKey(stripMD(header[k]))
				}
				i++
				continue
			}
			if isSepRow(ln) {
				continue
			}
			add(tableItem(header, cells))
			continue
		}
		header = nil
		if ln == "" {
			continue
		}
		add(lineItem(ln))
	}
	return out
}

func splitRow(ln string) []string {
	ln = strings.Trim(strings.TrimSpace(ln), "|")
	parts := strings.Split(ln, "|")
	for i := range parts {
		parts[i] = strings.TrimSpace(parts[i])
	}
	return parts
}

func isSepRow(ln string) bool {
	if !strings.HasPrefix(ln, "|") && !strings.HasPrefix(ln, "-") {
		return false
	}
	return strings.Trim(ln, "|-: \t") == "" && strings.Contains(ln, "-")
}

func stripMD(s string) string {
	s = mdLink.ReplaceAllString(s, "$1")
	return strings.TrimSpace(strings.Trim(s, "*_`~ "))
}

func tableItem(header, cells []string) map[string]any {
	m := map[string]any{}
	for i, c := range cells {
		name := ""
		if i < len(header) {
			name = header[i]
		}
		val := stripMD(c)
		if l := mdLink.FindStringSubmatch(c); l != nil {
			if _, ok := m["url"]; !ok {
				m["url"] = l[2]
			}
		}
		switch name {
		case "id", "identifier", "issue", "key", "ticket", "issueid":
			if mm := identTok.FindString(c); mm != "" {
				m["identifier"] = mm
			} else if name != "id" {
				m["title"] = val
			}
		case "title", "name", "summary":
			m["title"] = val
		case "description":
			m["description"] = val
		case "status", "state":
			m["status"] = val
		case "priority":
			m["priority"] = val
		case "assignee":
			m["assignee"] = val
		case "project":
			m["project"] = val
		case "labels", "label":
			m["labels"] = val
		case "url", "link":
			m["url"] = val
		case "updated", "updatedat", "lastupdated":
			m["updatedAt"] = val
		case "due", "duedate":
			m["dueDate"] = val
		}
	}
	if _, ok := m["identifier"]; !ok {
		if mm := identTok.FindString(strings.Join(cells, " ")); mm != "" {
			m["identifier"] = mm
		}
	}
	return m
}

func lineItem(ln string) map[string]any {
	ln = listBullet.ReplaceAllString(ln, "")
	ln = strings.TrimLeft(ln, "#> ")
	var url string
	if l := mdLink.FindStringSubmatch(ln); l != nil {
		url = l[2]
	}
	ln = mdLink.ReplaceAllString(ln, "$1")
	ln = strings.ReplaceAll(ln, "**", "")
	ln = strings.ReplaceAll(ln, "`", "")
	loc := identTok.FindStringIndex(ln)
	if loc == nil {
		return nil
	}
	m := map[string]any{"identifier": ln[loc[0]:loc[1]]}
	if url != "" {
		m["url"] = url
	}
	rest := strings.TrimLeft(ln[loc[1]:], " \t:-–—|]*)·")
	rest = strings.TrimRight(rest, " \t")
	if s := statusKV.FindStringSubmatchIndex(rest); s != nil {
		m["status"] = strings.TrimSpace(rest[s[2]:s[3]])
		rest = strings.TrimSpace(rest[:s[0]] + " " + rest[s[1]:])
	}
	if s := prioKV.FindStringSubmatchIndex(rest); s != nil {
		m["priority"] = strings.TrimSpace(rest[s[2]:s[3]])
		rest = strings.TrimSpace(rest[:s[0]] + " " + rest[s[1]:])
	}
	if _, ok := m["status"]; !ok {
		if t := trailPar.FindStringSubmatchIndex(rest); t != nil {
			m["status"] = strings.TrimSpace(rest[t[2]:t[3]])
			rest = rest[:t[0]]
		}
	}
	m["title"] = strings.Trim(rest, " \t:-–—|*·,;()[]")
	return m
}

// ---- structure summaries ----

var (
	uuidRe   = regexp.MustCompile(`(?i)[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}`)
	digitsRe = regexp.MustCompile(`[0-9]+`)
	plainKey = regexp.MustCompile(`^[A-Za-z_][A-Za-z_]*[0-9]?$`)
)

// MaskText shortens s to n runes and hides what could identify something: uuids, digits and long
// tokens.
func MaskText(s string, n int) string {
	r := []rune(s)
	if len(r) > 4*n {
		r = r[:4*n]
	}
	s = uuidRe.ReplaceAllString(string(r), "<uuid>")
	s = digitsRe.ReplaceAllString(s, "#")
	words := strings.Fields(strings.ReplaceAll(s, "\n", " ⏎ "))
	for i, w := range words {
		if len([]rune(w)) >= 20 {
			words[i] = "<long>"
		}
	}
	r = []rune(strings.Join(words, " "))
	if len(r) > n {
		r = append(r[:n], '…')
	}
	return string(r)
}

func safeKey(k string) string {
	if len(k) > 40 || uuidRe.MatchString(k) || !plainKey.MatchString(k) {
		return MaskText(k, 40)
	}
	return k
}

// Shape describes the structure of a decoded value: key names with value types, never the values.
func Shape(v any, depth int) string {
	switch x := v.(type) {
	case nil:
		return "null"
	case string:
		if strings.TrimSpace(x) == "" {
			return "string(empty)"
		}
		return "string"
	case float64:
		return "number"
	case bool:
		return "boolean"
	case []any:
		if depth <= 0 || len(x) == 0 {
			return fmt.Sprintf("array[%d]", len(x))
		}
		return fmt.Sprintf("array[%d]<%s>", len(x), Shape(x[0], depth-1))
	case map[string]any:
		if depth <= 0 {
			return fmt.Sprintf("object(%d keys)", len(x))
		}
		keys := make([]string, 0, len(x))
		for k := range x {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		var parts []string
		for i, k := range keys {
			if i >= 30 {
				parts = append(parts, fmt.Sprintf("…+%d", len(keys)-30))
				break
			}
			parts = append(parts, safeKey(k)+":"+Shape(x[k], depth-1))
		}
		return "object{" + strings.Join(parts, ", ") + "}"
	}
	return fmt.Sprintf("%T", v)
}

// IdentPattern shows an identifier's form ("ENG-###") when it is one, else "".
func IdentPattern(s string) string {
	if m := identRe.FindStringSubmatch(strings.TrimSpace(s)); m != nil {
		return strings.ToUpper(m[1]) + "-" + strings.Repeat("#", len(m[2]))
	}
	return ""
}

// Diagnose summarizes a tool result for a person to paste back when it could not be read: the tool,
// the content blocks, the structure of the value and of its first two items. It holds no values,
// except the form of identifiers and (withText) the start of a non-JSON text, masked.
func Diagnose(tool string, r *Result, items []any, withText bool) string {
	var b strings.Builder
	fmt.Fprintf(&b, "tool: %s\n", tool)
	if r == nil {
		b.WriteString("result: none\n")
		return b.String()
	}
	var types, sizes []string
	for _, bl := range r.Blocks {
		t := bl.Type
		if t == "" {
			t = "(none)"
		}
		types = append(types, t)
		sizes = append(sizes, strconv.Itoa(len([]rune(bl.Text))))
	}
	fmt.Fprintf(&b, "content blocks: %d [%s], text sizes [%s], structuredContent: %v\n", len(r.Blocks), strings.Join(types, ","), strings.Join(sizes, ","), r.Structured != nil)
	v := r.Value()
	fmt.Fprintf(&b, "value: %s\n", Shape(v, 3))
	for i, it := range items {
		if i >= 2 {
			break
		}
		fmt.Fprintf(&b, "item[%d]: %s\n", i, Shape(it, 3))
		if m := nodeOf(it); m != nil {
			if p := IdentPattern(first(m, "identifier", "id", "key")); p != "" {
				fmt.Fprintf(&b, "item[%d] identifier form: %s\n", i, p)
			}
		}
	}
	if len(items) == 0 {
		b.WriteString("items found: 0\n")
	}
	if s, ok := v.(string); ok && withText {
		fmt.Fprintf(&b, "text start (masked): %s\n", MaskText(strings.TrimSpace(s), 200))
	}
	return b.String()
}

// OneLine is a diagnosis for a log line.
func OneLine(s string) string {
	return strings.Join(strings.Fields(strings.ReplaceAll(s, "\n", " | ")), " ")
}
