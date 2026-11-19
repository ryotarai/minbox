package server

import (
	"context"
	"testing"

	"github.com/ryotarai/minbox/internal/notify"
	"github.com/ryotarai/minbox/internal/store"
)

func TestSlackInboundUsesTheReplyAndThreadPaths(t *testing.T) {
	e := newEnv(t)
	sess := e.createSession()
	ctx := context.Background()
	proj, err := e.st.GetProject(ctx, sess.ProjectID)
	if err != nil {
		t.Fatal(err)
	}
	in := slackInbound{e.srv}

	id, err := in.NewThread(ctx, "", proj.Name, "Please look at the build\nmore", nil)
	if err != nil {
		t.Fatal(err)
	}
	th, err := e.st.GetThread(ctx, id)
	if err != nil || th.Subject != "Please look at the build" || len(th.Messages) != 1 || th.Messages[0].Author != store.AuthorUser {
		t.Fatalf("thread = %+v %v", th, err)
	}
	if _, err := in.NewThread(ctx, "", "", "x", nil); err != notify.ErrNoTarget {
		t.Fatalf("no default: %v", err)
	}
	if _, err := in.NewThread(ctx, "nope", proj.Name, "x", nil); err != notify.ErrUnknownProject {
		t.Fatalf("unknown project: %v", err)
	}
	if err := in.DeliverReply(ctx, id, "", "and a reply", nil); err != nil {
		t.Fatal(err)
	}
	th, _ = e.st.GetThread(ctx, id)
	if len(th.Messages) != 2 || th.Messages[1].Body != "and a reply" || th.Messages[1].Author != store.AuthorUser {
		t.Fatalf("messages = %+v", th.Messages)
	}
	if err := in.DeliverReply(ctx, "thr_missing", "", "x", nil); err != notify.ErrGone {
		t.Fatalf("gone: %v", err)
	}
}

func TestSlackInboundFilesBecomeAttachments(t *testing.T) {
	e := newEnv(t)
	sess := e.createSession()
	ctx := context.Background()
	proj, err := e.st.GetProject(ctx, sess.ProjectID)
	if err != nil {
		t.Fatal(err)
	}
	in := slackInbound{e.srv}
	png := []byte("\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01\x08\x06\x00\x00\x00\x1f\x15\xc4\x89\x00\x00\x00\rIDATx\x9cc\xf8\xff\xff?\x00\x05\xfe\x02\xfe\xa7\x9a\x9c\x9f\x00\x00\x00\x00IEND\xaeB`\x82")
	files := []notify.InFile{{Name: "shot.png", Mime: "image/png", Data: png}, {Name: ".env", Mime: "text/plain", Data: []byte("A=1")}, {Name: "../x/note.txt", Mime: "text/plain", Data: []byte("hi")}}
	id, err := in.NewThread(ctx, "", proj.Name, "", files)
	if err != nil {
		t.Fatal(err)
	}
	th, err := e.st.GetThread(ctx, id)
	if err != nil || th.Subject != "shot.png" {
		t.Fatalf("thread = %+v %v", th, err)
	}
	atts, err := e.st.ListAttachments(ctx, id)
	if err != nil || len(atts) != 2 || atts[0].Author != store.AuthorUser || atts[0].Type != "image" || atts[1].Name != "note.txt" {
		t.Fatalf("attachments = %+v %v", atts, err)
	}
	if err := in.DeliverReply(ctx, id, "", "more", files[:1]); err != nil {
		t.Fatal(err)
	}
	atts, _ = e.st.ListAttachments(ctx, id)
	if len(atts) != 3 {
		t.Fatalf("after reply: %d attachments", len(atts))
	}
}

// A reply in a task's Slack thread reaches the agent's stream about that task, as a reply written
// in the task's view does.
func TestSlackInboundReplyInTaskThreadIsAboutTheTask(t *testing.T) {
	e := newEnv(t)
	sess := e.createSession()
	ctx := context.Background()
	task := e.newTask(sess, "Fix the login")
	stream, err := e.st.StreamThread(ctx, sess.ID)
	if err != nil {
		t.Fatal(err)
	}
	in := slackInbound{e.srv}
	if err := in.DeliverReply(ctx, stream, task, "from the task's Slack thread", nil); err != nil {
		t.Fatal(err)
	}
	if err := in.DeliverReply(ctx, stream, "", "from the agent's Slack thread", nil); err != nil {
		t.Fatal(err)
	}
	th, _ := e.st.GetThread(ctx, stream)
	var inTask, plain string
	for _, m := range th.Messages {
		switch m.Body {
		case "from the task's Slack thread":
			inTask = m.ID
		case "from the agent's Slack thread":
			plain = m.ID
		}
	}
	if inTask == "" || plain == "" {
		t.Fatalf("messages = %+v", th.Messages)
	}
	if got, _ := e.st.TaskOfMessage(ctx, inTask); got != task {
		t.Fatalf("the reply is in %q, want %q", got, task)
	}
	if got, _ := e.st.TaskOfMessage(ctx, plain); got != "" {
		t.Fatalf("the reply without a task is in %q", got)
	}
	// It is delivered to the agent like any message of the person.
	if p := e.takePending(sess); len(p) == 0 {
		t.Fatal("nothing pending for the agent")
	}
	// A task that is gone: the reply still arrives, about no task.
	if err := in.DeliverReply(ctx, stream, "tsk_gone", "late", nil); err != nil {
		t.Fatal(err)
	}
}
