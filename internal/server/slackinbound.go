package server

import (
	"context"
	"errors"
	"strings"

	"github.com/ryotarai/minbox/internal/notify"
	"github.com/ryotarai/minbox/internal/store"
)

// slackInbound turns messages received from Slack into what the person's own messages are in the
// web UI: the same store calls as POST /api/threads/{id}/reply and POST /api/sessions/{id}/threads.
type slackInbound struct{ s *Server }

func (in slackInbound) DeliverReply(ctx context.Context, threadID, text string) error {
	s := in.s
	th, err := s.store.GetThread(ctx, threadID)
	if errors.Is(err, store.ErrNotFound) {
		return notify.ErrGone
	}
	if err != nil {
		return err
	}
	_, _ = s.store.MarkThreadRead(ctx, threadID) // replying means the person has seen the thread
	if _, err := s.store.AddMessage(ctx, threadID, store.NewMessage{Author: store.AuthorUser, Body: text, Words: text}); err != nil {
		return err
	}
	s.publishThread(th.SessionID, threadID)
	s.wakePending(th.SessionID)
	return nil
}

func (in slackInbound) NewThread(ctx context.Context, project, defaultProject, text string) (string, error) {
	s := in.s
	name, explicit := strings.TrimSpace(project), project != ""
	if !explicit {
		name = strings.TrimSpace(defaultProject)
	}
	if name == "" {
		return "", notify.ErrNoTarget
	}
	projects, err := s.store.ListProjects(ctx, false)
	if err != nil {
		return "", err
	}
	var target *store.Project
	for i := range projects {
		if strings.EqualFold(projects[i].Name, name) {
			target = &projects[i]
			break
		}
	}
	if target == nil {
		if explicit {
			return "", notify.ErrUnknownProject
		}
		return "", notify.ErrNoTarget
	}
	if target.MainSessionID == "" {
		return "", notify.ErrNoTarget
	}
	th, _, err := s.store.CreateThread(ctx, target.MainSessionID, firstLine(text), store.NewMessage{Author: store.AuthorUser, Body: text, Words: text})
	if err != nil {
		return "", err
	}
	s.publishThread(target.MainSessionID, th.ID)
	s.wakePending(target.MainSessionID)
	return th.ID, nil
}

// RunSlackInbound polls Slack for the destinations that receive messages, until ctx ends.
func (s *Server) RunSlackInbound(ctx context.Context) {
	p := notify.NewPoller(s.store, slackInbound{s})
	p.Changed = func() { s.hub.publish(Event{Type: "notifications"}) }
	p.Run(ctx)
}
