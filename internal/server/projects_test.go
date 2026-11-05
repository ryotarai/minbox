package server

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"github.com/ryotarai/minbox/internal/store"
)

func (e *env) mkdir(name string) string {
	e.t.Helper()
	d := filepath.Join(e.dir, name)
	if err := os.MkdirAll(d, 0o755); err != nil {
		e.t.Fatal(err)
	}
	return d
}

func (e *env) projects(query string) []map[string]any {
	e.t.Helper()
	code, _, arr := e.do("GET", "/api/projects"+query, nil, nil)
	if code != 200 {
		e.t.Fatalf("list projects: %d", code)
	}
	out := []map[string]any{}
	for _, v := range arr {
		out = append(out, v.(map[string]any))
	}
	return out
}

func TestSessionsResolveTheirProjectByHostAndDir(t *testing.T) {
	e := newEnv(t)
	api := e.mkdir("api")
	docs := e.mkdir("docs")
	create := func(cwd string) map[string]any {
		code, obj, _ := e.do("POST", "/api/sessions", map[string]string{"cwd": cwd}, nil)
		if code != 201 {
			t.Fatalf("create: %d %v", code, obj)
		}
		return obj
	}
	// No project_id (old clients, the CLI): the project is found or created by (host, cwd).
	a := create(api)
	b := create(api + "/") // same folder
	c := create(docs)
	if a["project_id"] == "" || a["project_id"] != b["project_id"] || a["project_id"] == c["project_id"] {
		t.Fatalf("project ids: %v %v %v", a["project_id"], b["project_id"], c["project_id"])
	}
	ps := e.projects("")
	if len(ps) != 2 {
		t.Fatalf("projects = %v", ps)
	}
	byName := map[string]map[string]any{}
	for _, p := range ps {
		byName[p["name"].(string)] = p
	}
	if p := byName["api"]; p == nil || p["dir"] != api || p["host_id"] != "local" || p["host_name"] != "local" || p["session_count"] != float64(2) {
		t.Fatalf("api project = %v", p)
	}

	// Threads carry their project.
	ctx := context.Background()
	if _, _, err := e.st.CreateThread(ctx, a["id"].(string), "Hello", store.NewMessage{Author: store.AuthorAgent, Body: "hi"}); err != nil {
		t.Fatal(err)
	}
	_, _, threads := e.do("GET", "/api/threads", nil, nil)
	th := threads[0].(map[string]any)
	if th["project_id"] != a["project_id"] || th["project_name"] != "api" {
		t.Fatalf("thread = %v", th)
	}
	// ...and sessions list it.
	_, _, sessions := e.do("GET", "/api/sessions", nil, nil)
	for _, v := range sessions {
		s := v.(map[string]any)
		if s["project_id"] == "" || s["project_id"] == nil {
			t.Fatalf("session without project: %v", s)
		}
	}
}

func TestProjectsAPI(t *testing.T) {
	e := newEnv(t)
	web := e.mkdir("web")

	// Create: folder must exist on the host; name defaults to the folder.
	if code, obj, _ := e.do("POST", "/api/projects", map[string]string{"dir": filepath.Join(e.dir, "nope")}, nil); code != 400 {
		t.Fatalf("missing folder: %d %v", code, obj)
	}
	if code, _, _ := e.do("POST", "/api/projects", map[string]string{"dir": web, "host_id": "nohost"}, nil); code != 400 {
		t.Fatalf("unknown host: %d", code)
	}
	code, p, _ := e.do("POST", "/api/projects", map[string]string{"dir": web}, nil)
	if code != 201 || p["name"] != "web" || p["dir"] != web || p["session_count"] != float64(0) {
		t.Fatalf("create: %d %v", code, p)
	}
	id := p["id"].(string)
	if code, _, _ := e.do("POST", "/api/projects", map[string]string{"dir": web, "name": "again"}, nil); code != 409 {
		t.Fatalf("same folder twice: %d", code)
	}

	// A session inside it: folder from the project, host from the project.
	code, s, _ := e.do("POST", "/api/sessions", map[string]string{"project_id": id}, nil)
	if code != 201 || s["cwd"] != web || s["project_id"] != id {
		t.Fatalf("session in project: %d %v", code, s)
	}
	// A sub-folder override stays in the project.
	sub := e.mkdir("web/sub")
	code, s2, _ := e.do("POST", "/api/sessions", map[string]string{"project_id": id, "cwd": sub}, nil)
	if code != 201 || s2["cwd"] != sub || s2["project_id"] != id {
		t.Fatalf("override: %d %v", code, s2)
	}
	if code, _, _ := e.do("POST", "/api/sessions", map[string]string{"project_id": "prj_nope"}, nil); code != 400 {
		t.Fatalf("unknown project: %d", code)
	}
	if code, _, _ := e.do("POST", "/api/sessions", map[string]string{"project_id": id, "host_id": "other"}, nil); code != 400 {
		t.Fatalf("host mismatch: %d", code)
	}

	// Rename works; moving does not once there are sessions.
	if code, got, _ := e.do("PATCH", "/api/projects/"+id, map[string]any{"name": "Website"}, nil); code != 200 || got["name"] != "Website" {
		t.Fatalf("rename: %d %v", code, got)
	}
	if code, _, _ := e.do("PATCH", "/api/projects/"+id, map[string]any{"dir": e.mkdir("other")}, nil); code != 409 {
		t.Fatalf("dir change with sessions: %d", code)
	}
	if code, _, _ := e.do("PATCH", "/api/projects/"+id, map[string]any{"name": " "}, nil); code != 400 {
		t.Fatalf("empty name: %d", code)
	}
	if code, got, _ := e.do("PATCH", "/api/projects/"+id, map[string]any{"pinned": true}, nil); code != 200 || got["pinned_at"] == nil {
		t.Fatalf("pin: %d %v", code, got)
	}
	if code, _, _ := e.do("PATCH", "/api/projects/prj_nope", map[string]any{"name": "x"}, nil); code != 404 {
		t.Fatalf("patch missing: %d", code)
	}

	// Delete and archive are refused while sessions are live; delete stays refused afterwards.
	if code, _, _ := e.do("DELETE", "/api/projects/"+id, nil, nil); code != 409 {
		t.Fatalf("delete with sessions: %d", code)
	}
	if code, _, _ := e.do("POST", "/api/projects/"+id+"/archive", nil, nil); code != 409 {
		t.Fatalf("archive with live sessions: %d", code)
	}
	for _, sid := range []string{s["id"].(string), s2["id"].(string)} {
		if code, _, _ := e.do("POST", "/api/sessions/"+sid+"/stop", nil, nil); code != 200 {
			t.Fatalf("stop: %d", code)
		}
	}
	if code, _, _ := e.do("DELETE", "/api/projects/"+id, nil, nil); code != 409 {
		t.Fatalf("delete with ended sessions: %d", code)
	}
	if code, _, _ := e.do("POST", "/api/projects/"+id+"/archive", nil, nil); code != 200 {
		t.Fatalf("archive: %d", code)
	}
	if len(e.projects("")) != 0 || len(e.projects("?archived=1")) != 1 {
		t.Fatal("archived project listing")
	}
	if code, _, _ := e.do("POST", "/api/projects/"+id+"/unarchive", nil, nil); code != 200 || len(e.projects("")) != 1 {
		t.Fatalf("unarchive: %d", code)
	}

	// An empty project can go.
	_, q, _ := e.do("POST", "/api/projects", map[string]string{"dir": e.mkdir("empty")}, nil)
	if code, _, _ := e.do("DELETE", "/api/projects/"+q["id"].(string), nil, nil); code != 200 {
		t.Fatalf("delete empty: %d", code)
	}
	if code, _, _ := e.do("DELETE", "/api/projects/"+q["id"].(string), nil, nil); code != 404 {
		t.Fatalf("delete twice: %d", code)
	}
	// Moving an empty project works.
	_, r, _ := e.do("POST", "/api/projects", map[string]string{"dir": e.mkdir("movable")}, nil)
	moveTo := e.mkdir("moved")
	if code, got, _ := e.do("PATCH", "/api/projects/"+r["id"].(string), map[string]any{"dir": moveTo}, nil); code != 200 || got["dir"] != moveTo {
		t.Fatalf("move empty: %d %v", code, got)
	}
}
