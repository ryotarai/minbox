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
	if err := in.DeliverReply(ctx, id, "and a reply", nil); err != nil {
		t.Fatal(err)
	}
	th, _ = e.st.GetThread(ctx, id)
	if len(th.Messages) != 2 || th.Messages[1].Body != "and a reply" || th.Messages[1].Author != store.AuthorUser {
		t.Fatalf("messages = %+v", th.Messages)
	}
	if err := in.DeliverReply(ctx, "thr_missing", "x", nil); err != notify.ErrGone {
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
	if err := in.DeliverReply(ctx, id, "more", files[:1]); err != nil {
		t.Fatal(err)
	}
	atts, _ = e.st.ListAttachments(ctx, id)
	if len(atts) != 3 {
		t.Fatalf("after reply: %d attachments", len(atts))
	}
}
