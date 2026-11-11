package linear

import (
	"encoding/json"
	"strings"
)

// Helpers for paginated list results. MCP list tools take a limit and a cursor and answer with the
// page plus a cursor for the next one; the exact keys differ between catalogs, so they are read
// tolerantly.

// Items returns the array of objects of a list result (under one of keys, or the usual wrappers).
func Items(v any, keys ...string) []any { return list(v, keys...) }

// ItemID is the id of a list item (a bare object or {node: {...}}), "" when it has none.
func ItemID(e any) string { return first(nodeOf(e), "id") }

// NextCursor reads the cursor of the next page from a list result: nextCursor / next_cursor /
// endCursor at the top or under pageInfo (hasNextPage=false ends the list), or a top-level cursor.
// "" means there is no next page.
func NextCursor(v any) string {
	m := asMap(v)
	if m == nil {
		return ""
	}
	if pi := asMap(m["pageInfo"]); pi != nil {
		if b, ok := pi["hasNextPage"].(bool); ok && !b {
			return ""
		}
		if c := first(pi, "endCursor", "nextCursor", "next_cursor", "cursor"); c != "" {
			return c
		}
	}
	if b, ok := m["hasNextPage"].(bool); ok && !b {
		return ""
	}
	if b, ok := m["hasMore"].(bool); ok && !b {
		return ""
	}
	if c := first(m, "nextCursor", "next_cursor", "endCursor", "cursor", "next"); c != "" {
		return c
	}
	for _, k := range []string{"data", "result"} {
		if inner := asMap(m[k]); inner != nil {
			if c := NextCursor(inner); c != "" {
				return c
			}
		}
	}
	return ""
}

// EmbeddedJSON finds a JSON object or array inside prose (a text result such as "Found 3
// teams:\n[{...}]"), returning it decoded.
func EmbeddedJSON(text string) (any, bool) {
	for i := 0; i < len(text) && i < 4000; i++ {
		if text[i] != '{' && text[i] != '[' {
			continue
		}
		var v any
		if err := json.NewDecoder(strings.NewReader(text[i:])).Decode(&v); err == nil {
			switch v.(type) {
			case map[string]any, []any:
				return v, true
			}
		}
	}
	return nil, false
}
