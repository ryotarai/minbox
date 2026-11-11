package linear

import (
	"errors"
	"fmt"
	"net/url"
	"regexp"
	"strings"
	"time"
)

// The shapes of Linear's MCP tool results are not documented precisely (and differ between tool
// catalogs), so everything below reads them tolerantly: names are looked up under several keys,
// a field may be a string or an object, and a missing field is simply empty.

var identRe = regexp.MustCompile(`^([A-Za-z][A-Za-z0-9]{0,9})-(\d{1,9})$`)

// ParseIssueRef reads an issue identifier ("ENG-123") or an issue URL
// (https://linear.app/<any-workspace>/issue/ENG-123/slug). The workspace of a URL is not
// checked: the login decides which workspace can be read (an issue it cannot see fails at the
// lookup). It returns the upper-cased identifier.
func ParseIssueRef(in string) (string, error) {
	in = strings.TrimSpace(in)
	if m := identRe.FindStringSubmatch(in); m != nil {
		return strings.ToUpper(m[1]) + "-" + m[2], nil
	}
	u, err := url.Parse(in)
	if err == nil && (u.Scheme == "https" || u.Scheme == "http") && strings.EqualFold(u.Hostname(), "linear.app") {
		parts := strings.Split(strings.Trim(u.Path, "/"), "/")
		// /<workspace>/issue/<ID>[/<slug>]
		if len(parts) >= 3 && parts[1] == "issue" {
			if m := identRe.FindStringSubmatch(parts[2]); m != nil {
				return strings.ToUpper(m[1]) + "-" + m[2], nil
			}
		}
	}
	return "", errors.New("not a Linear issue: use an identifier like ENG-123 or an issue URL like https://linear.app/<workspace>/issue/ENG-123/…")
}

// Issue is what minbox keeps of a Linear issue.
type Issue struct {
	ID, Identifier, URL, Title string
	State, StateType           string
	Assignee                   string
	TeamID, TeamName           string
	// Read by the My issues screen (the list and the detail); empty when the tool does not say.
	Description  string
	Priority     int // 0 none, 1 urgent, 2 high, 3 medium, 4 low
	PriorityName string
	TeamKey      string
	Project      string
	Labels       []string
	Estimate     string
	DueDate      string
	AssigneeID   string
	CreatedAt    time.Time
	UpdatedAt    time.Time
}

// Comment is a Linear comment.
type Comment struct {
	ID, Body, URL                 string
	Author, AuthorEmail, AuthorID string
	CreatedAt                     time.Time
}

// Status is a workflow state of a team.
type Status struct{ ID, Name, Type string }

// User is the logged-in Linear user.
type User struct {
	ID    string `json:"id"`
	Name  string `json:"name"`
	Email string `json:"email"`
}

func str(v any) string {
	switch x := v.(type) {
	case string:
		return strings.TrimSpace(x)
	case float64:
		return fmt.Sprintf("%g", x)
	}
	return ""
}

func asMap(v any) map[string]any { m, _ := v.(map[string]any); return m }

// first returns the first non-empty string under keys of m.
func first(m map[string]any, keys ...string) string {
	for _, k := range keys {
		if s := str(m[k]); s != "" {
			return s
		}
	}
	return ""
}

// objOrName reads a field that is a name string or an object with a name.
func objOrName(v any) (name, id, email, typ, key string) {
	switch x := v.(type) {
	case string:
		return strings.TrimSpace(x), "", "", "", ""
	case map[string]any:
		return first(x, "name", "displayName", "title"), first(x, "id"), first(x, "email"), first(x, "type"), first(x, "key")
	}
	return
}

// unwrap digs the object of an issue/comment/user out of a result: the value itself, or under one
// of the wrapper keys, or the first element of a list.
func unwrap(v any, keys ...string) map[string]any {
	for depth := 0; depth < 3; depth++ {
		switch x := v.(type) {
		case []any:
			if len(x) == 0 {
				return nil
			}
			v = x[0]
			continue
		case map[string]any:
			for _, k := range keys {
				if inner, ok := x[k]; ok && inner != nil {
					if _, isStr := inner.(string); !isStr {
						v = inner
						goto next
					}
				}
			}
			return x
		default:
			return nil
		}
	next:
	}
	return asMap(v)
}

// ParseIssue reads a get_issue / save_issue result.
func ParseIssue(v any) (*Issue, error) {
	m := unwrap(v, "issue", "data")
	if m == nil {
		return nil, errors.New("linear: unreadable issue")
	}
	is := &Issue{ID: first(m, "id", "uuid"), Identifier: first(m, "identifier", "key"), URL: first(m, "url"), Title: first(m, "title", "name")}
	if is.Identifier == "" && is.ID == "" {
		return nil, errors.New("linear: unreadable issue (no id)")
	}
	for _, k := range []string{"state", "status", "workflowState"} {
		if n, _, _, t, _ := objOrName(m[k]); n != "" {
			is.State, is.StateType = n, t
			break
		}
	}
	if t := first(m, "stateType", "statusType"); t != "" {
		is.StateType = t
	}
	is.StateType = strings.ToLower(is.StateType)
	for _, k := range []string{"assignee", "assigneeName"} {
		if n, _, e, _, _ := objOrName(m[k]); n != "" || e != "" {
			is.Assignee = n
			if n == "" {
				is.Assignee = e
			}
			break
		}
	}
	if n, id, _, _, key := objOrName(m["team"]); n != "" || id != "" {
		is.TeamName, is.TeamID = n, id
		if is.TeamName == "" {
			is.TeamName = key
		}
	}
	if is.TeamID == "" {
		is.TeamID = first(m, "teamId")
	}
	if is.TeamName == "" {
		is.TeamName = first(m, "teamName")
	}
	parseIssueExtras(m, is)
	return is, nil
}

func parseTime(s string) time.Time {
	for _, l := range []string{time.RFC3339Nano, time.RFC3339, "2006-01-02T15:04:05.999Z07:00", "2006-01-02 15:04:05", "2006-01-02"} {
		if t, err := time.Parse(l, s); err == nil {
			return t
		}
	}
	return time.Time{}
}

// list finds the array of objects of a result.
func list(v any, keys ...string) []any {
	switch x := v.(type) {
	case []any:
		return x
	case map[string]any:
		for _, k := range keys {
			if inner, ok := x[k]; ok {
				if l := list(inner, keys...); l != nil {
					return l
				}
			}
		}
		for _, k := range []string{"nodes", "items", "results", "data", "edges"} {
			if inner, ok := x[k]; ok {
				if l := list(inner, keys...); l != nil {
					return l
				}
			}
		}
	}
	return nil
}

// ParseComments reads a list_comments result. A comment without an id is dropped (it cannot be diffed).
func ParseComments(v any) ([]Comment, error) {
	arr := list(v, "comments")
	if arr == nil {
		if m := asMap(v); m != nil {
			if _, ok := m["comments"]; ok {
				return nil, nil // an empty list in an odd shape
			}
		}
		if s, ok := v.(string); ok && strings.TrimSpace(s) == "" {
			return nil, nil
		}
		return nil, errors.New("linear: unreadable comment list")
	}
	var out []Comment
	for _, e := range arr {
		m := asMap(e)
		if node := asMap(m["node"]); node != nil {
			m = node
		}
		if m == nil {
			continue
		}
		c := Comment{ID: first(m, "id"), Body: first(m, "body", "content", "text"), URL: first(m, "url"),
			CreatedAt: parseTime(first(m, "createdAt", "created_at", "created"))}
		for _, k := range []string{"user", "author", "createdBy", "creator"} {
			if n, id, em, _, _ := objOrName(m[k]); n != "" || id != "" || em != "" {
				c.Author, c.AuthorID, c.AuthorEmail = n, id, em
				break
			}
		}
		if c.Author == "" {
			c.Author = first(m, "userName", "authorName", "user_name")
		}
		if c.ID == "" {
			continue
		}
		out = append(out, c)
	}
	return out, nil
}

// CommentID finds the id of a comment in a create/update result (the comment's own id, not the
// issue's); "" when the result does not show one.
func CommentID(v any) string {
	m := unwrap(v, "comment", "data")
	if m == nil {
		return ""
	}
	if c := asMap(m["comment"]); c != nil {
		m = c
	}
	return first(m, "id")
}

// ParseStatuses reads a list_issue_statuses result.
func ParseStatuses(v any) []Status {
	var out []Status
	for _, e := range list(v, "statuses", "states", "issueStatuses", "workflowStates") {
		m := asMap(e)
		if m == nil {
			continue
		}
		s := Status{ID: first(m, "id"), Name: first(m, "name"), Type: strings.ToLower(first(m, "type"))}
		if s.Name != "" {
			out = append(out, s)
		}
	}
	return out
}

// ParseUser reads a get_user result.
func ParseUser(v any) *User {
	m := unwrap(v, "user", "viewer", "data")
	if m == nil {
		return nil
	}
	u := &User{ID: first(m, "id"), Name: first(m, "name", "displayName"), Email: first(m, "email")}
	if u.ID == "" && u.Name == "" && u.Email == "" {
		return nil
	}
	return u
}

// NotStarted: the state type is one that "work started" moves to a started state.
func NotStarted(stateType string) bool {
	switch strings.ToLower(stateType) {
	case "backlog", "unstarted", "triage":
		return true
	}
	return false
}

// PickStarted chooses the state to move to: the started state named "In Progress", else the
// first started one.
func PickStarted(sts []Status) *Status {
	var firstStarted *Status
	for i := range sts {
		if sts[i].Type != "started" {
			continue
		}
		if strings.EqualFold(sts[i].Name, "In Progress") {
			return &sts[i]
		}
		if firstStarted == nil {
			firstStarted = &sts[i]
		}
	}
	return firstStarted
}
