package notify

import (
	"context"
	"errors"
	"strings"
	"sync"

	"github.com/ryotarai/minbox/internal/store"
)

// One Slack thread per task: the first message about a task posts a parent that names the task and
// its agent (and links to the task); the message itself and every later one about the task are
// replies in that thread, whichever agent writes them. The person's replies there go to the agent
// that wrote in it last, tagged with the task (the poller reads store.SlackThreadRef.TaskID). When
// the task is renamed or its status changes, the parent is edited (UpdateTask).

// taskStatusLabel is how a task status reads in the parent.
func taskStatusLabel(s string) string {
	if s == store.TaskNeedsYou {
		return "needs you"
	}
	return strings.ReplaceAll(s, "_", " ")
}

// BuildSlackTaskParent lays out the parent message of a task's Slack thread: the task's title, the
// project and agent, its status, and an "Open task" button when there is a link.
func BuildSlackTaskParent(n Notification) SlackPayload {
	title := strings.TrimSpace(n.TaskTitle)
	if title == "" {
		title = "(untitled task)"
	}
	icon := ":clipboard:"
	if n.TaskStatus == store.TaskDone {
		icon = ":white_check_mark:"
	}
	where := strings.TrimSpace(n.Project)
	if n.Session != "" {
		if where != "" {
			where += " / "
		}
		where += n.Session
	}
	var ctx []string
	if where != "" {
		ctx = append(ctx, escapeSlack(where))
	}
	if l := taskStatusLabel(n.TaskStatus); l != "" {
		ctx = append(ctx, escapeSlack(l))
	}
	fallback := "Task: " + title
	if where != "" {
		fallback += " (" + where + ")"
	}
	if n.TaskStatus == store.TaskDone {
		fallback += " - done"
	}
	blocks := []SlackBlock{mrkdwnBlock(icon + " *" + escapeSlack(title) + "*")}
	if len(ctx) > 0 {
		blocks = append(blocks, SlackBlock{Type: "context", Elements: []SlackElement{{Type: "mrkdwn", Text: strings.Join(ctx, " · ")}}})
	}
	if n.TaskLink != "" {
		blocks = append(blocks, SlackBlock{Type: "actions", Elements: []SlackElement{{Type: "button", Text: "Open task", URL: n.TaskLink}}})
	}
	return SlackPayload{Text: escapeSlack(fallback), Blocks: blocks}
}

// taskParent is the parent's payload, mentioning the person when that is on (Slack notifies about
// the replies of a thread one is mentioned in; an edit keeps the mention and notifies nobody).
func (s *SlackApp) taskParent(n Notification) SlackPayload {
	p := BuildSlackTaskParent(n)
	if id := s.mentionID(); id != "" {
		m := "<@" + id + "> "
		p.Text = m + p.Text
		b := *p.Blocks[0].Text
		b.Text = m + b.Text
		p.Blocks[0].Text = &b
	}
	return p
}

func slackTaskLock(destID, taskID string) *sync.Mutex {
	return slackThreadLock(destID, "\x00task\x00"+taskID)
}

// sendTask posts a message about a task in the task's Slack thread, starting the thread first.
func (s *SlackApp) sendTask(ctx context.Context, n Notification) error {
	mu := slackTaskLock(s.DestID, n.TaskID)
	mu.Lock()
	defer mu.Unlock()
	parent, ok, err := s.Store.GetSlackTaskThread(ctx, s.DestID, n.TaskID)
	if err != nil {
		return &SendError{Msg: "reading the task's Slack thread: " + err.Error()}
	}
	if ok {
		_, err := s.post(ctx, n, parent.ChannelID, parent.TS, false)
		if err == nil {
			_ = s.Store.TouchSlackTaskThread(ctx, s.DestID, n.TaskID, n.ThreadID)
			return s.uploadFiles(ctx, n, parent.ChannelID, parent.TS)
		}
		var se *SendError
		if !errors.As(err, &se) || (se.code != "thread_not_found" && se.code != "message_not_found") {
			return err
		}
		// The parent was deleted in Slack: the task gets a new thread.
	}
	p := s.taskParent(n)
	r, err := s.call(ctx, "chat.postMessage", map[string]any{
		"channel": s.Channel, "text": p.Text, "blocks": p.Blocks,
		"unfurl_links": false, "unfurl_media": false,
	})
	if err != nil {
		return err
	}
	ch := r.Channel
	if ch == "" {
		ch = s.Channel
	}
	if strings.HasPrefix(ch, "D") && s.DestID != "" {
		// The DM channel (D…) is where the replies and the DMs to the bot are read from.
		_ = s.Store.SetSlackState(ctx, s.DestID, "dm_channel", ch)
	}
	if r.TS == "" {
		return &SendError{Msg: "Slack did not say where the task's thread is"}
	}
	if e := s.Store.PutSlackTaskThread(ctx, s.DestID, n.TaskID, n.ThreadID, store.SlackThread{ChannelID: ch, TS: r.TS}); e != nil {
		return &SendError{Msg: "storing the task's Slack thread: " + e.Error()}
	}
	if _, err := s.post(ctx, n, ch, r.TS, false); err != nil {
		return err
	}
	return s.uploadFiles(ctx, n, ch, r.TS)
}

// UpdateTask edits the parent of the task's Slack thread to show the task's title and status now
// (✅ when done). Nothing happens when this destination never started a thread for the task.
func (s *SlackApp) UpdateTask(ctx context.Context, n Notification) error {
	if s.Store == nil || n.TaskID == "" {
		return nil
	}
	mu := slackTaskLock(s.DestID, n.TaskID)
	mu.Lock()
	defer mu.Unlock()
	parent, ok, err := s.Store.GetSlackTaskThread(ctx, s.DestID, n.TaskID)
	if err != nil || !ok {
		return err
	}
	if n.Session == "" && parent.ThreadID != "" {
		// The agent the replies go to.
		if th, err := s.Store.GetThread(ctx, parent.ThreadID); err == nil {
			if sess, err := s.Store.GetSession(ctx, th.SessionID); err == nil {
				n.Session = sess.Name
			}
		}
	}
	p := s.taskParent(n)
	_, err = s.call(ctx, "chat.update", map[string]any{
		"channel": parent.ChannelID, "ts": parent.TS, "text": p.Text, "blocks": p.Blocks,
	})
	var se *SendError
	if errors.As(err, &se) && (se.code == "message_not_found" || se.code == "cant_update_message" || se.code == "thread_not_found") {
		return nil // the parent is gone (or not the bot's): nothing to show it on
	}
	return err
}
