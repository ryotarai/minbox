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

func TestMainSessionAPI(t *testing.T) {
	e := newEnv(t)
	dir := e.mkdir("main")
	mk := func(extra map[string]any) map[string]any {
		body := map[string]any{"cwd": dir}
		for k, v := range extra {
			body[k] = v
		}
		code, obj, _ := e.do("POST", "/api/sessions", body, nil)
		if code != 201 {
			t.Fatalf("create: %d %v", code, obj)
		}
		return obj
	}
	a := mk(nil)
	b := mk(nil)
	if a["is_main"] != true || b["is_main"] != false {
		t.Fatalf("first is main: %v %v", a["is_main"], b["is_main"])
	}
	pid := a["project_id"].(string)
	if ps := e.projects(""); ps[0]["main_session_id"] != a["id"] {
		t.Fatalf("project main = %v", ps[0]["main_session_id"])
	}
	c := mk(map[string]any{"main": true, "project_id": pid})
	if c["is_main"] != true {
		t.Fatalf("main:true: %v", c)
	}
	// Promote with PATCH.
	if code, got, _ := e.do("PATCH", "/api/projects/"+pid, map[string]any{"main_session_id": b["id"]}, nil); code != 200 || got["main_session_id"] != b["id"] {
		t.Fatalf("promote: %d %v", code, got)
	}
	if code, _, _ := e.do("PATCH", "/api/projects/"+pid, map[string]any{"main_session_id": "ses_nope"}, nil); code != 400 {
		t.Fatalf("promote unknown: %d", code)
	}
	// The main session cannot be archived or deleted without a successor.
	bid := b["id"].(string)
	e.do("POST", "/api/sessions/"+bid+"/stop", nil, nil)
	if code, _, _ := e.do("POST", "/api/sessions/"+bid+"/archive", nil, nil); code != 409 {
		t.Fatalf("archive main: %d", code)
	}
	if code, _, _ := e.do("DELETE", "/api/sessions/"+bid, nil, nil); code != 409 {
		t.Fatalf("delete main: %d", code)
	}
	if code, _, _ := e.do("DELETE", "/api/sessions/"+bid+"?promote="+a["id"].(string), nil, nil); code != 200 {
		t.Fatalf("delete main with promote: %d", code)
	}
	if ps := e.projects(""); ps[0]["main_session_id"] != a["id"] {
		t.Fatalf("main after promote-delete = %v", ps[0]["main_session_id"])
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

	// Archive is refused while sessions are live (delete is not: see TestDeleteProjectCascades).
	if code, _, _ := e.do("POST", "/api/projects/"+id+"/archive", nil, nil); code != 409 {
		t.Fatalf("archive with live sessions: %d", code)
	}
	for _, sid := range []string{s["id"].(string), s2["id"].(string)} {
		if code, _, _ := e.do("POST", "/api/sessions/"+sid+"/stop", nil, nil); code != 200 {
			t.Fatalf("stop: %d", code)
		}
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

func TestDeleteProjectCascades(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	doomed := e.mkdir("doomed")
	keep := e.mkdir("keep")
	if err := os.WriteFile(filepath.Join(doomed, "notes.txt"), []byte("mine"), 0o644); err != nil {
		t.Fatal(err)
	}
	mk := func(cwd string) map[string]any {
		code, obj, _ := e.do("POST", "/api/sessions", map[string]string{"cwd": cwd}, nil)
		if code != 201 {
			t.Fatalf("create: %d %v", code, obj)
		}
		return obj
	}
	a, b := mk(doomed), mk(doomed) // a is main; b is a second Claude Code session
	k := mk(keep)
	pid := a["project_id"].(string)
	aid, bid, kid := a["id"].(string), b["id"].(string), k["id"].(string)
	// b has ended; a and the other project's session keep running.
	e.do("POST", "/api/sessions/"+bid+"/stop", nil, nil)

	th, msg, err := e.st.CreateThread(ctx, aid, "doomed thread", store.NewMessage{Author: store.AuthorAgent, Body: "hi"})
	if err != nil {
		t.Fatal(err)
	}
	if err := e.st.AddAttachment(ctx, &store.Attachment{ThreadID: th.ID, MessageID: msg.ID, Kind: store.AttachmentFile, Name: "n.txt", Type: "text"}, []byte("x"), ""); err != nil {
		t.Fatal(err)
	}
	if err := e.st.PutSlackThread(ctx, "dest", th.ID, store.SlackThread{ChannelID: "C", TS: "1"}); err != nil {
		t.Fatal(err)
	}
	kth, _, err := e.st.CreateThread(ctx, kid, "kept thread", store.NewMessage{Author: store.AuthorAgent, Body: "yo"})
	if err != nil {
		t.Fatal(err)
	}

	code, pre, _ := e.do("GET", "/api/projects/"+pid+"/delete-preview", nil, nil)
	if code != 200 || pre["sessions"] != float64(2) || pre["running_sessions"] != float64(1) || pre["threads"] != float64(1) || pre["messages"] != float64(1) {
		t.Fatalf("preview: %d %v", code, pre)
	}
	if code, _, _ := e.do("GET", "/api/projects/nope/delete-preview", nil, nil); code != 404 {
		t.Fatalf("preview unknown: %d", code)
	}

	// The main session cannot be deleted alone while another Claude Code session lives...
	if code, _, _ := e.do("DELETE", "/api/sessions/"+aid, nil, nil); code != 409 {
		t.Fatalf("delete main alone: %d", code)
	}
	// ...but a project delete takes everything, the running session included.
	if code, obj, _ := e.do("DELETE", "/api/projects/"+pid, nil, nil); code != 200 {
		t.Fatalf("delete project: %d %v", code, obj)
	}
	for _, id := range []string{aid, bid} {
		if _, err := e.st.GetSession(ctx, id); err == nil {
			t.Fatalf("session %s survived", id)
		}
	}
	e.host.mu.Lock()
	for id, tm := range e.host.terms {
		if (id == aid || id == bid || id == shellTermID(aid) || id == shellTermID(bid)) && tm.Running {
			t.Fatalf("terminal %s still running", id)
		}
	}
	e.host.mu.Unlock()
	if _, err := e.st.GetProject(ctx, pid); err == nil {
		t.Fatal("project row survived")
	}
	if _, err := e.st.GetThread(ctx, th.ID); err == nil {
		t.Fatal("thread survived")
	}
	if atts, _ := e.st.ListAttachments(ctx, th.ID); len(atts) != 0 {
		t.Fatalf("attachments survived: %v", atts)
	}
	if _, ok, _ := e.st.GetSlackThread(ctx, "dest", th.ID); ok {
		t.Fatal("slack thread mapping survived")
	}
	if got, err := os.ReadFile(filepath.Join(doomed, "notes.txt")); err != nil || string(got) != "mine" {
		t.Fatalf("project folder touched: %q %v", got, err)
	}
	if ps := e.projects(""); len(ps) != 1 || ps[0]["dir"] != keep {
		t.Fatalf("projects left: %v", ps)
	}
	if _, err := e.st.GetSession(ctx, kid); err != nil {
		t.Fatalf("other session: %v", err)
	}
	if _, err := e.st.GetThread(ctx, kth.ID); err != nil {
		t.Fatalf("other thread: %v", err)
	}
	if code, _, _ := e.do("DELETE", "/api/projects/"+pid, nil, nil); code != 404 {
		t.Fatalf("delete twice: %d", code)
	}
}
