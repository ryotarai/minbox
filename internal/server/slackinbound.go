package server

import (
	"bytes"
	"context"
	"errors"
	"log"
	"path/filepath"
	"strings"

	"github.com/ryotarai/minbox/internal/notify"
	"github.com/ryotarai/minbox/internal/store"
)

// slackInbound turns messages received from Slack into what the person's own messages are in the
// web UI: the same store calls as POST /api/threads/{id}/reply and POST /api/sessions/{id}/threads.
type slackInbound struct{ s *Server }

func (in slackInbound) DeliverReply(ctx context.Context, threadID, text string, files []notify.InFile) error {
	s := in.s
	th, err := s.store.GetThread(ctx, threadID)
	if errors.Is(err, store.ErrNotFound) {
		return notify.ErrGone
	}
	if err != nil {
		return err
	}
	_, _ = s.store.MarkThreadRead(ctx, threadID) // replying means the person has seen the thread
	ups := in.storeFiles(ctx, files)
	msg, err := s.store.AddMessage(ctx, threadID, store.NewMessage{Author: store.AuthorUser, Body: text, Words: text})
	if err != nil {
		return err
	}
	if err := s.attachUploads(ctx, ups, threadID, msg.ID); err != nil {
		return err
	}
	s.publishThread(th.SessionID, threadID)
	s.wakePending(th.SessionID)
	return nil
}

func (in slackInbound) NewThread(ctx context.Context, project, defaultProject, text string, files []notify.InFile) (string, error) {
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
		if projects[i].ID == name || strings.EqualFold(projects[i].Name, name) {
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
	ups := in.storeFiles(ctx, files)
	subject := firstLine(text)
	if subject == "" && len(ups) > 0 {
		subject = ups[0].Name
	}
	th, msg, err := s.store.CreateThread(ctx, target.MainSessionID, subject, store.NewMessage{Author: store.AuthorUser, Body: text, Words: text})
	if err != nil {
		return "", err
	}
	if err := s.attachUploads(ctx, ups, th.ID, msg.ID); err != nil {
		return "", err
	}
	s.publishThread(target.MainSessionID, th.ID)
	s.wakePending(target.MainSessionID)
	return th.ID, nil
}

// RunSlackInbound polls Slack for the destinations that receive messages, until ctx ends.
func (s *Server) RunSlackInbound(ctx context.Context) {
	s.poller.Run(ctx)
}

// ProjectNames are the names of the projects a Slack DM can start a thread in.
func (in slackInbound) ProjectNames(ctx context.Context) ([]string, error) {
	cands, err := in.s.pickCandidates(ctx)
	if err != nil {
		return nil, err
	}
	var out []string
	for _, c := range cands {
		out = append(out, c.name)
	}
	return out, nil
}

// storeFiles keeps files received from Slack as the uploads a person's attachment would be in the
// web UI (blobs), ready for attachUploads. A file that cannot be kept is skipped with a log line.
func (in slackInbound) storeFiles(ctx context.Context, files []notify.InFile) []*store.Upload {
	s := in.s
	var ups []*store.Upload
	for _, f := range files {
		name := strings.Map(func(r rune) rune {
			if r < 0x20 || r == '/' || r == '\\' {
				return '_'
			}
			return r
		}, filepath.Base(strings.TrimSpace(f.Name)))
		if name == "" || name == "." || name == ".." {
			name = "slack-file"
		}
		if msg := uploadNameError(name); msg != "" {
			log.Printf("slack inbound: file %q not taken: %s", name, msg)
			continue
		}
		b, err := s.putBlobReader(bytes.NewReader(f.Data), uploadMaxBytes)
		if err != nil {
			log.Printf("slack inbound: file %q not taken: %v", name, err)
			continue
		}
		a := s.fileAttachment(name, "", b)
		u := &store.Upload{Name: name, Size: b.Size, Type: a.Type, SHA256: b.Sum, Mime: a.Mime, Width: a.Width, Height: a.Height,
			DurationMs: a.DurationMs, SearchText: a.SearchText}
		if err := s.store.AddUpload(ctx, u); err != nil {
			log.Printf("slack inbound: file %q not taken: %v", name, err)
			continue
		}
		ups = append(ups, u)
	}
	return ups
}
