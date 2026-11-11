package linear

import (
	"errors"
	"regexp"
	"strings"
)

// IssueItems finds the items of a list_issues value: the array of its JSON, else the issues a text
// list or table carries.
func IssueItems(v any) []any {
	items := Items(v, "issues")
	if len(items) == 0 {
		if t, ok := v.(string); ok {
			items = TextIssueItems(t)
		}
	}
	return items
}

// parseIssueText reads a get_issue result that is plain text: the first issue line gives the
// identifier, title and status; the whole text is kept as the description.
func parseIssueText(t string) (*Issue, error) {
	items := TextIssueItems(t)
	if len(items) == 0 {
		return nil, errors.New("linear: unreadable issue (a text without an identifier)")
	}
	is, err := ParseIssue(items[0])
	if err != nil || is == nil {
		return nil, errors.New("linear: unreadable issue")
	}
	if is.Description == "" {
		is.Description = strings.TrimSpace(t)
	}
	return is, nil
}

var (
	kvLine  = regexp.MustCompile(`(?im)^\s*[-*]?\s*\**(id|name|display ?name|email)\**\s*[:=]\s*(.+?)\s*$`)
	emailRe = regexp.MustCompile(`[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}`)
)

// parseUserText reads a get_user result that is plain text ("Name: ...", "Email: ...", "ID: ...").
func parseUserText(t string) *User {
	u := &User{}
	for _, m := range kvLine.FindAllStringSubmatch(t, -1) {
		v := strings.Trim(m[2], "*` ")
		switch strings.ReplaceAll(strings.ToLower(m[1]), " ", "") {
		case "id":
			if u.ID == "" {
				u.ID = v
			}
		case "name", "displayname":
			if u.Name == "" {
				u.Name = v
			}
		case "email":
			u.Email = v
		}
	}
	if u.Email == "" {
		u.Email = emailRe.FindString(t)
	}
	if u.ID == "" && u.Name == "" && u.Email == "" {
		return nil
	}
	return u
}
