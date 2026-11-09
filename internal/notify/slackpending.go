package notify

import (
	"context"
	"encoding/json"
	"errors"
	"log"
	"net/url"
	"sort"
	"strings"

	"github.com/ryotarai/minbox/internal/store"
)

// A DM that starts a new thread, when Claude Haiku cannot tell the project: minbox asks in the
// Slack thread (listing the projects) and holds the message, with its files, until the person
// answers there. The answer goes to Haiku together with the earlier conversation; still
// unknown: ask again, up to slackAskRounds times.

type pendingPayload struct {
	Orig    string   `json:"orig"`    // the message that started it
	Answers []string `json:"answers"` // the person's replies, oldest first
	Files   []InFile `json:"files"`
}

// conversation is what the project picker reads: the message and what was said since.
func (p *pendingPayload) conversation() string {
	var b strings.Builder
	b.WriteString("Message:\n" + pickText(p.Orig))
	for _, a := range p.Answers {
		b.WriteString("\n\nI asked which project this is for. The answer:\n" + a)
	}
	return b.String()
}

// newThread decides the project of a new thread: an explicit #project prefix (no model), else the
// model's pick; when the model is unsure the person is asked in the Slack thread. Only called for
// a message of an allowed member.
func (w *pollWorker) newThread(ctx context.Context, channel, threadTS, text string, files []InFile) error {
	if m := projectPrefix.FindStringSubmatch(text); m != nil {
		_, err := w.p.In.NewThread(ctx, m[1], w.project, m[2], files)
		if !errors.Is(err, ErrUnknownProject) {
			if err == nil {
				log.Printf("slack inbound: %s: new thread: project from the #prefix", w.dest.ID)
			}
			return err
		}
		// Not a project name: the whole text is the message.
	}
	why := "the fallback project"
	if !w.pick {
		why = "the fallback project (Claude pick is off)"
	} else if !w.takePick() {
		why = "the fallback project (Claude pick rate cap reached)"
		log.Printf("slack inbound: %s: more than %d project picks in a minute; using the fallback project", w.dest.ID, slackPickPerMinute)
	} else if p, err := w.p.In.PickProject(ctx, pickText(text)); err != nil {
		why = "the fallback project (Claude pick failed)"
	} else if p == "" {
		pp := &pendingPayload{Orig: text, Files: files}
		asked, err := w.askProject(ctx, channel, threadTS, pp, 1, "")
		if err != nil {
			return err
		}
		if asked {
			log.Printf("slack inbound: %s: the model was unsure; asked in the Slack thread which project", w.dest.ID)
			return nil
		}
		why = "the fallback project (Claude was unsure and no project can be asked about)"
	} else {
		_, err := w.p.In.NewThread(ctx, p, w.project, text, files)
		if err == nil {
			log.Printf("slack inbound: %s: new thread: project picked by Claude", w.dest.ID)
			return nil
		}
		if !errors.Is(err, ErrUnknownProject) && !errors.Is(err, ErrNoTarget) {
			return err
		}
		why = "the fallback project (the picked project has no session)"
	}
	_, err := w.p.In.NewThread(ctx, "", w.project, text, files)
	if err == nil {
		log.Printf("slack inbound: %s: new thread: %s", w.dest.ID, why)
	}
	if errors.Is(err, ErrNoTarget) && !w.noTargetWarned {
		w.noTargetWarned = true
		log.Printf("slack inbound: %s: a DM arrived but no project could be chosen (Claude pick off or unsure, no valid 'Fallback project'); ignoring DMs that start threads", w.dest.ID)
	}
	return err
}

// post replies in a Slack thread; it returns the new message's ts.
func (w *pollWorker) post(ctx context.Context, channel, threadTS, text string) (string, error) {
	if err := w.take(); err != nil {
		return "", err
	}
	r, err := w.app.call(ctx, "chat.postMessage", map[string]any{"channel": channel, "thread_ts": threadTS, "text": text,
		"unfurl_links": false, "unfurl_media": false})
	return r.TS, err
}

// askProject asks which project in the Slack thread and stores the pending state. false (and no
// error) when there is no project to ask about.
func (w *pollWorker) askProject(ctx context.Context, channel, threadTS string, pp *pendingPayload, round int, lead string) (bool, error) {
	names, err := w.p.In.ProjectNames(ctx)
	if err != nil {
		return false, err
	}
	if len(names) == 0 {
		return false, nil
	}
	var list []string
	for _, n := range names {
		list = append(list, "`"+strings.ReplaceAll(strings.Join(strings.Fields(n), " "), "`", "'")+"`")
	}
	if lead == "" {
		lead = "Which project is this for?"
	}
	q := lead + " Reply in this thread with the project name. Projects: " + strings.Join(list, ", ")
	ts, err := w.post(ctx, channel, threadTS, q)
	if err != nil {
		return false, err
	}
	return true, w.savePending(ctx, channel, threadTS, ts, round, pp)
}

func (w *pollWorker) savePending(ctx context.Context, channel, threadTS, cursor string, round int, pp *pendingPayload) error {
	b, err := json.Marshal(pp)
	if err != nil {
		return err
	}
	return w.p.Store.PutSlackPending(ctx, w.dest.ID, store.SlackPending{ChannelID: channel, ThreadTS: threadTS, Rounds: round, ReplyCursor: cursor, Payload: string(b)})
}

// pollPending reads the replies in a thread that asked which project.
func (w *pollWorker) pollPending(ctx context.Context, pd store.SlackPending, cursor string) error {
	r, err := w.call(ctx, "conversations.replies", url.Values{"channel": {pd.ChannelID}, "ts": {pd.ThreadTS}, "oldest": {cursor}, "limit": {"50"}, "inclusive": {"false"}})
	if err != nil {
		var se *SendError
		if errors.As(err, &se) && (se.code == "thread_not_found" || se.code == "message_not_found") {
			return w.p.Store.DeleteSlackPending(ctx, w.dest.ID, pd.ChannelID, pd.ThreadTS)
		}
		return err
	}
	msgs := r.Messages
	sort.SliceStable(msgs, func(i, j int) bool { return tsCmp(msgs[i].TS, msgs[j].TS) < 0 })
	done := false
	for _, m := range msgs {
		if tsCmp(m.TS, cursor) <= 0 || m.TS == pd.ThreadTS {
			continue
		}
		before := w.cyc.delivered
		err := w.accept(ctx, pd.ChannelID, m, func(ctx context.Context, text string, files []InFile) error {
			fin, err := w.resolvePending(ctx, &pd, m.TS, text, files)
			done = fin
			return err
		})
		w.cyc.threads += w.cyc.delivered - before
		if err != nil {
			return err
		}
		if done {
			return nil
		}
		cursor = m.TS
	}
	cursor = maxTS(cursor, pd.ReplyCursor)
	if cursor != pd.ReplyCursor {
		pd.ReplyCursor = cursor
		return w.p.Store.PutSlackPending(ctx, w.dest.ID, pd)
	}
	return nil
}

// resolvePending handles one answer: pick again; start the thread, ask again or give up. done: the
// pending state is gone.
func (w *pollWorker) resolvePending(ctx context.Context, pd *store.SlackPending, replyTS, text string, files []InFile) (bool, error) {
	var pp pendingPayload
	if err := json.Unmarshal([]byte(pd.Payload), &pp); err != nil {
		_ = w.p.Store.DeleteSlackPending(ctx, w.dest.ID, pd.ChannelID, pd.ThreadTS)
		return true, nil
	}
	pp.Answers = append(pp.Answers, text)
	for _, f := range files {
		if len(pp.Files) < SlackInFileMax {
			pp.Files = append(pp.Files, f)
		}
	}
	if !w.takePick() {
		return false, errBudget // try again next cycle
	}
	project, err := w.p.In.PickProject(ctx, pp.conversation())
	if err != nil {
		log.Printf("slack inbound: %s: Claude pick failed for a pending thread; using the fallback project", w.dest.ID)
		return true, w.startPending(ctx, pd, replyTS, &pp, "")
	}
	if project == "" {
		if pd.Rounds >= slackAskRounds {
			log.Printf("slack inbound: %s: the project is still unknown after %d questions", w.dest.ID, pd.Rounds)
			return true, w.startPending(ctx, pd, replyTS, &pp, "")
		}
		asked, err := w.askProject(ctx, pd.ChannelID, pd.ThreadTS, &pp, pd.Rounds+1, "I still could not tell which project this is for.")
		if err != nil {
			return false, err
		}
		if !asked {
			return true, w.startPending(ctx, pd, replyTS, &pp, "")
		}
		// askProject stored the new state (round, cursor past the question): carry it on.
		if ps, err := w.p.Store.ListSlackPending(ctx, w.dest.ID, pd.ChannelID); err == nil {
			for _, x := range ps {
				if x.ThreadTS == pd.ThreadTS {
					*pd = x
				}
			}
		}
		return false, nil
	}
	return true, w.startPending(ctx, pd, replyTS, &pp, project)
}

// startPending creates the minbox thread of a pending Slack thread (project "": the fallback
// project, if one is set; else the person is told it stops here) and links the Slack thread to it.
func (w *pollWorker) startPending(ctx context.Context, pd *store.SlackPending, replyTS string, pp *pendingPayload, project string) error {
	del := func() error { return w.p.Store.DeleteSlackPending(ctx, w.dest.ID, pd.ChannelID, pd.ThreadTS) }
	if project == "" && strings.TrimSpace(w.project) == "" {
		_, _ = w.post(ctx, pd.ChannelID, pd.ThreadTS, "I could not tell which project this is for, and no fallback project is set, so I dropped the message. Start again with #project-name at the beginning of a new DM.")
		return del()
	}
	tid, err := w.p.In.NewThread(ctx, project, w.project, pp.Orig, pp.Files)
	if errors.Is(err, ErrUnknownProject) || errors.Is(err, ErrNoTarget) {
		_, _ = w.post(ctx, pd.ChannelID, pd.ThreadTS, "I could not start a thread there (no project session). The message was dropped.")
		return del()
	}
	if err != nil {
		return err
	}
	if e := w.p.Store.PutSlackThread(ctx, w.dest.ID, tid, store.SlackThread{ChannelID: pd.ChannelID, TS: pd.ThreadTS}); e != nil {
		return e
	}
	_ = w.p.Store.SetSlackReplyCursor(ctx, w.dest.ID, tid, replyTS)
	if project == "" {
		_, _ = w.post(ctx, pd.ChannelID, pd.ThreadTS, "I still could not tell, so I used the fallback project.")
	} else {
		_, _ = w.post(ctx, pd.ChannelID, pd.ThreadTS, "Started a thread. Replies here go to it.")
	}
	return del()
}
