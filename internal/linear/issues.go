package linear

import (
	"fmt"
	"strconv"
	"strings"
)

// Parsers for the My issues screen: the list of issues assigned to the person and the extra fields
// of an issue (description, priority, labels, ...). Like the rest of this package they read the
// tools' results tolerantly.

var priorityNames = map[string]int{"urgent": 1, "high": 2, "medium": 3, "normal": 3, "low": 4, "no priority": 0, "none": 0}

// PriorityLabel is Linear's name of a priority number.
func PriorityLabel(p int) string {
	switch p {
	case 1:
		return "Urgent"
	case 2:
		return "High"
	case 3:
		return "Medium"
	case 4:
		return "Low"
	}
	return "No priority"
}

// parseIssueExtras reads the fields only the My issues screen needs: description, priority,
// labels, project, estimate, due date, times, the team key and the assignee's id.
func parseIssueExtras(m map[string]any, is *Issue) {
	if d, ok := field(m, "description", "body").(string); ok {
		is.Description = strings.TrimSpace(d)
	}
	pv := field(m, "priority")
	if pv == nil {
		pv = field(m, "priorityLabel", "priorityName")
	}
	switch p := pv.(type) {
	case float64:
		is.Priority = int(p)
	case string:
		is.PriorityName = strings.TrimSpace(p)
		if v, ok := priorityNames[strings.ToLower(is.PriorityName)]; ok {
			is.Priority = v
		} else if n, err := strconv.Atoi(is.PriorityName); err == nil {
			is.Priority, is.PriorityName = n, ""
		}
	case map[string]any:
		if v, ok := field(p, "value", "priority", "number").(float64); ok {
			is.Priority = int(v)
		} else if v, err := strconv.Atoi(first(p, "value")); err == nil {
			is.Priority = v
		}
		is.PriorityName = first(p, "name", "label")
		if v, ok := priorityNames[strings.ToLower(is.PriorityName)]; ok && is.Priority == 0 {
			is.Priority = v
		}
	}
	if is.Priority < 0 || is.Priority > 4 {
		is.Priority = 0
	}
	if is.PriorityName == "" {
		is.PriorityName = PriorityLabel(is.Priority)
	}
	switch lv := field(m, "labels", "labelNames", "issueLabels").(type) {
	case string:
		for _, p := range strings.Split(lv, ",") {
			if p = strings.TrimSpace(p); p != "" {
				is.Labels = append(is.Labels, p)
			}
		}
	default:
		for _, e := range list(lv, "labels") {
			if n, _, _, _, _ := objOrName(nodeOf(e)); n != "" {
				is.Labels = append(is.Labels, n)
			} else if s := str(e); s != "" {
				is.Labels = append(is.Labels, s)
			}
		}
	}
	if n, _, _, _, _ := objOrName(field(m, "project")); n != "" {
		is.Project = n
	} else {
		is.Project = first(m, "projectName")
	}
	switch e := field(m, "estimate").(type) {
	case float64:
		is.Estimate = fmt.Sprintf("%g", e)
	case string:
		is.Estimate = strings.TrimSpace(e)
	case map[string]any:
		if v, ok := e["value"].(float64); ok {
			is.Estimate = fmt.Sprintf("%g", v)
		} else {
			is.Estimate = first(e, "name", "label")
		}
	}
	is.DueDate = first(m, "dueDate", "due_date")
	is.CreatedAt = parseTime(first(m, "createdAt", "created_at"))
	is.UpdatedAt = parseTime(first(m, "updatedAt", "updated_at"))
	if _, id, _, _, _ := objOrName(field(m, "assignee")); id != "" {
		is.AssigneeID = id
	} else {
		is.AssigneeID = first(m, "assigneeId", "assignee_id")
	}
	if tm := asMap(field(m, "team")); tm != nil {
		is.TeamKey = first(tm, "key", "identifier")
	}
	if is.TeamKey == "" {
		is.TeamKey = first(m, "teamKey")
	}
	if is.TeamKey == "" {
		if mm := identRe.FindStringSubmatch(is.Identifier); mm != nil {
			is.TeamKey = strings.ToUpper(mm[1])
		}
	}
}

// ParseIssues reads a list_issues result: the issues it holds (an item that cannot be read is
// skipped). An item needs a usable identifier (its own, or derived from the URL / team key and
// number), or an id and a title; a text result (markdown list or table) is read line by line.
func ParseIssues(v any) []Issue {
	var out []Issue
	if s, ok := v.(string); ok {
		v = TextIssueItems(s)
	}
	for _, e := range list(v, "issues") {
		out = append(out, parseListItem(e, 0)...)
	}
	return out
}

func parseListItem(e any, depth int) []Issue {
	if s, ok := e.(string); ok {
		var out []Issue
		for _, it := range TextIssueItems(s) {
			out = append(out, parseListItem(it, depth+1)...)
		}
		return out
	}
	m := nodeOf(e)
	if m == nil {
		return nil
	}
	is, err := ParseIssue(m)
	if err == nil && is != nil && (is.Identifier != "" || is.ID != "") {
		if is.Identifier == "" {
			if is.Title == "" {
				return nil
			}
			is.Identifier = is.ID // the tool shows no identifier: the id still opens the issue
		}
		return []Issue{*is}
	}
	// A group ({"state": "...", "issues": [...]}): read the issues inside.
	if depth < 2 {
		var out []Issue
		for _, e2 := range list(field(m, "issues", "items", "nodes"), "issues") {
			out = append(out, parseListItem(e2, depth+1)...)
		}
		return out
	}
	return nil
}

// TypeByName guesses a workflow state type from its name, for a tool that shows only the name.
func TypeByName(name string) string {
	n := strings.ToLower(strings.TrimSpace(name))
	switch {
	case n == "":
		return ""
	case strings.Contains(n, "cancel"), strings.Contains(n, "duplicate"), strings.Contains(n, "won't"), strings.Contains(n, "wont"), strings.Contains(n, "obsolete"):
		return "canceled"
	case strings.Contains(n, "done"), strings.Contains(n, "complete"), strings.Contains(n, "closed"), strings.Contains(n, "shipped"), strings.Contains(n, "released"), strings.Contains(n, "merged"), strings.Contains(n, "resolved"):
		return "completed"
	case strings.Contains(n, "backlog"), strings.Contains(n, "icebox"):
		return "backlog"
	case strings.Contains(n, "triage"):
		return "triage"
	case strings.Contains(n, "progress"), strings.Contains(n, "review"), strings.Contains(n, "doing"), strings.Contains(n, "testing"), strings.Contains(n, "started"):
		return "started"
	}
	return "unstarted"
}

// Closed: the state type is a finished one (completed or canceled).
func Closed(stateType string) bool {
	switch strings.ToLower(stateType) {
	case "completed", "canceled", "cancelled":
		return true
	}
	return false
}
