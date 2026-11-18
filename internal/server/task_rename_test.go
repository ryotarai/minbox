package server

import (
	"context"
	"strings"
	"testing"

	"github.com/ryotarai/minbox/internal/store"
)

// Renaming a task: the agent with update_task title, the person with PATCH /api/v3/tasks/{id}. Each
// rename is a line in the timeline; once the person has named a task, an agent's rename is not
// applied and the tool result says so.
func TestTaskRename(t *testing.T) {
	p := newProto(t)
	ctx := context.Background()
	o := p.tool("create_task", map[string]any{"title": "Look into login"})
	text := o["text"].(string)
	id := strings.TrimSuffix(strings.Fields(strings.TrimPrefix(text, "Task created (task_id "))[0], ").")
	tk, _ := p.st.GetTask(ctx, id)
	if tk.TitleBy != store.TitleByAgent {
		t.Fatalf("title_by after create_task = %q", tk.TitleBy)
	}

	// The agent renames it as the scope becomes clear.
	o = p.tool("update_task", map[string]any{"task_id": id, "title": "Fix login redirect loop"})
	if !strings.Contains(o["text"].(string), "Task updated.\n- "+id+" [working] Fix login redirect loop") {
		t.Fatal(o)
	}
	evs, _ := p.st.TaskEvents(ctx, id)
	last := evs[len(evs)-1]
	if last.Kind != "title" || last.Text != "Renamed: Look into login → Fix login redirect loop" || last.SessionID != p.sess.ID {
		t.Fatalf("agent rename event = %+v", last)
	}

	// The person renames it: the event says so, and the task is theirs to name now.
	code, obj, _ := p.do("PATCH", "/api/v3/tasks/"+id, map[string]any{"title": "  Login loop   on Safari "}, nil)
	if code != 200 || obj["title"] != "Login loop on Safari" || obj["title_by"] != "person" {
		t.Fatalf("person rename: %d %v", code, obj)
	}
	evs, _ = p.st.TaskEvents(ctx, id)
	if last := evs[len(evs)-1]; last.Kind != "title" || last.Text != "Renamed: Fix login redirect loop → Login loop on Safari (you)" || last.SessionID != "" {
		t.Fatalf("person rename event = %+v", last)
	}
	if code, _, _ := p.do("PATCH", "/api/v3/tasks/"+id, map[string]any{"title": "   "}, nil); code != 400 {
		t.Fatalf("empty title: %d", code)
	}

	// The agent's later rename is not applied; the rest of the call is, and the result says why.
	n := len(evs)
	o = p.tool("update_task", map[string]any{"task_id": id, "title": "Something else", "report": "Found it."})
	if s := o["text"].(string); !strings.Contains(s, "The person named this task themselves, so its title stays “Login loop on Safari”") || !strings.Contains(s, "[working] Login loop on Safari") {
		t.Fatal(o)
	}
	tk, _ = p.st.GetTask(ctx, id)
	if tk.Title != "Login loop on Safari" || tk.Report != "Found it." || tk.TitleBy != store.TitleByPerson {
		t.Fatalf("task = %+v", tk)
	}
	evs, _ = p.st.TaskEvents(ctx, id)
	for _, e := range evs[n:] {
		if e.Kind == "title" {
			t.Fatalf("agent rename recorded: %+v", e)
		}
	}
	// Sending the same title again is no rename, and no note.
	o = p.tool("update_task", map[string]any{"task_id": id, "title": "Login loop on Safari"})
	if strings.Contains(o["text"].(string), "named this task") {
		t.Fatal(o)
	}

	// A task the person created is theirs to name as well.
	code, mine, _ := p.do("POST", "/api/v3/tasks", map[string]any{"project_id": p.sess.ProjectID, "title": "My own"}, nil)
	if code != 201 || mine["title_by"] != "person" {
		t.Fatalf("person create: %d %v", code, mine)
	}
}

// The agent is told to keep titles accurate, in the tool's description and the standing instructions.
func TestTaskRenameGuidance(t *testing.T) {
	if !strings.Contains(taskDescription["update_task"], "title: rename it when the work's scope becomes clear or changes, not on every step.") {
		t.Fatal(taskDescription["update_task"])
	}
	props := taskSchema("update_task")["properties"].(jobj)
	if d := props["title"].(jobj)["description"].(string); !strings.Contains(d, "2 to 8 words") || !strings.Contains(d, "A name the person gave the task is kept.") {
		t.Fatal(d)
	}
	if !strings.Contains(AgentSystemPrompt, "Keep a task's title accurate") {
		t.Fatal("system prompt")
	}
}
