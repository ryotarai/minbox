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

	id, err := in.NewThread(ctx, "", proj.Name, "Please look at the build\nmore")
	if err != nil {
		t.Fatal(err)
	}
	th, err := e.st.GetThread(ctx, id)
	if err != nil || th.Subject != "Please look at the build" || len(th.Messages) != 1 || th.Messages[0].Author != store.AuthorUser {
		t.Fatalf("thread = %+v %v", th, err)
	}
	if _, err := in.NewThread(ctx, "", "", "x"); err != notify.ErrNoTarget {
		t.Fatalf("no default: %v", err)
	}
	if _, err := in.NewThread(ctx, "nope", proj.Name, "x"); err != notify.ErrUnknownProject {
		t.Fatalf("unknown project: %v", err)
	}
	if err := in.DeliverReply(ctx, id, "and a reply"); err != nil {
		t.Fatal(err)
	}
	th, _ = e.st.GetThread(ctx, id)
	if len(th.Messages) != 2 || th.Messages[1].Body != "and a reply" || th.Messages[1].Author != store.AuthorUser {
		t.Fatalf("messages = %+v", th.Messages)
	}
	if err := in.DeliverReply(ctx, "thr_missing", "x"); err != notify.ErrGone {
		t.Fatalf("gone: %v", err)
	}
}
