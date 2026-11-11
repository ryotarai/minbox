package linear

// Parsers of the lists the Create-issue dialog offers (teams, labels, projects). Like the rest of
// this package they read the tools' results tolerantly.

// Team is a Linear team.
type Team struct{ ID, Name, Key string }

// Label is an issue label (TeamID is empty for a workspace label).
type Label struct{ ID, Name, Color, TeamID string }

// Project is a Linear project (TeamIDs: the teams it belongs to, when the tool says).
type Project struct {
	ID, Name string
	TeamIDs  []string
}

func nodeOf(e any) map[string]any {
	m := asMap(e)
	if node := asMap(m["node"]); node != nil {
		return node
	}
	return m
}

// ParseTeams reads a list_teams result.
func ParseTeams(v any) []Team {
	var out []Team
	for _, e := range list(v, "teams") {
		m := nodeOf(e)
		t := Team{ID: first(m, "id"), Name: first(m, "name"), Key: first(m, "key", "identifier")}
		if t.Name == "" {
			t.Name = t.Key
		}
		if t.ID != "" && t.Name != "" {
			out = append(out, t)
		}
	}
	return out
}

// ParseLabels reads a list_issue_labels result.
func ParseLabels(v any) []Label {
	var out []Label
	for _, e := range list(v, "labels", "issueLabels") {
		m := nodeOf(e)
		l := Label{ID: first(m, "id"), Name: first(m, "name"), Color: first(m, "color")}
		if _, id, _, _, _ := objOrName(m["team"]); id != "" {
			l.TeamID = id
		} else {
			l.TeamID = first(m, "teamId")
		}
		if l.ID != "" && l.Name != "" {
			out = append(out, l)
		}
	}
	return out
}

// ParseProjects reads a list_projects result.
func ParseProjects(v any) []Project {
	var out []Project
	for _, e := range list(v, "projects") {
		m := nodeOf(e)
		p := Project{ID: first(m, "id"), Name: first(m, "name", "title")}
		for _, k := range []string{"teams", "teamIds"} {
			for _, t := range list(m[k], "nodes") {
				if _, id, _, _, _ := objOrName(t); id != "" {
					p.TeamIDs = append(p.TeamIDs, id)
				} else if s := str(t); s != "" {
					p.TeamIDs = append(p.TeamIDs, s)
				}
			}
		}
		if p.ID != "" && p.Name != "" {
			out = append(out, p)
		}
	}
	return out
}
