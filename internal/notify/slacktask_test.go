package notify

import (
	"context"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/ryotarai/minbox/internal/store"
)

// blocksText is every mrkdwn text of a call's blocks, joined.
func blocksText(c appCall) string {
	var out []string
	bs, _ := c.body["blocks"].([]any)
	for _, b := range bs {
		m, _ := b.(map[string]any)
		if t, ok := m["text"].(map[string]any); ok {
			out = append(out, t["text"].(string))
		}
		els, _ := m["elements"].([]any)
		for _, e := range els {
			em, _ := e.(map[string]any)
			if s, ok := em["text"].(string); ok {
				out = append(out, s)
			}
			if t, ok := em["text"].(map[string]any); ok {
				out = append(out, t["text"].(string))
			}
			if u, ok := em["url"].(string); ok {
				out = append(out, u)
			}
		}
	}
	return strings.Join(out, "\n")
}

func TestSlackAppOneThreadPerTask(t *testing.T) {
	r := newRig(t)
	f := newFakeSlackAPI(t, okReply())
	d := r.addApp(t, map[string]any{"channel": "U0ME"})
	base := Notification{Project: "api", Session: "alpha", ThreadID: "thr_stream", From: "Claude", Title: "x"}
	send := func(task, title, body string) {
		n := base
		n.TaskID, n.TaskTitle, n.TaskStatus, n.TaskLink, n.Body = task, title, store.TaskWorking, "https://m.example/#v=task&k="+task, body
		r.d.Dispatch(n)
		r.d.Wait()
	}
	send("tsk_a", "Fix the login", "first about A")
	send("tsk_a", "Fix the login", "second about A")
	send("tsk_b", "Write docs", "first about B")
	// A message about no task keeps the thread of its minbox thread.
	n := base
	n.Body = "no task"
	r.d.Dispatch(n)
	r.d.Wait()

	calls := f.all()
	if len(calls) != 6 {
		t.Fatalf("calls = %d: %+v", len(calls), calls)
	}
	for _, c := range calls {
		if c.method != "chat.postMessage" {
			t.Fatalf("method = %s", c.method)
		}
	}
	parentA, replyA1, replyA2, parentB, replyB, noTask := calls[0], calls[1], calls[2], calls[3], calls[4], calls[5]
	if _, has := parentA.body["thread_ts"]; has {
		t.Fatal("the task's parent is a reply")
	}
	pa := blocksText(parentA)
	if !strings.Contains(pa, "Fix the login") || !strings.Contains(pa, "api / alpha") || !strings.Contains(pa, "https://m.example/#v=task&k=tsk_a") ||
		!strings.HasPrefix(parentA.body["text"].(string), "<@U0ME> ") || strings.Contains(pa, "first about A") {
		t.Fatalf("parent A = %q / %v", pa, parentA.body["text"])
	}
	tsA, _, _ := r.st.GetSlackTaskThread(context.Background(), d.ID, "tsk_a")
	tsB, _, _ := r.st.GetSlackTaskThread(context.Background(), d.ID, "tsk_b")
	if tsA.TS == "" || tsB.TS == "" || tsA.TS == tsB.TS || tsA.ThreadID != "thr_stream" {
		t.Fatalf("threads A=%+v B=%+v", tsA, tsB)
	}
	if replyA1.body["thread_ts"] != tsA.TS || !strings.Contains(blocksText(replyA1), "first about A") {
		t.Fatalf("reply A1 = %v", replyA1.body)
	}
	if replyA2.body["thread_ts"] != tsA.TS || !strings.Contains(blocksText(replyA2), "second about A") {
		t.Fatalf("reply A2 = %v", replyA2.body)
	}
	if _, has := parentB.body["thread_ts"]; has || !strings.Contains(blocksText(parentB), "Write docs") {
		t.Fatalf("parent B = %v", parentB.body)
	}
	if replyB.body["thread_ts"] != tsB.TS || !strings.Contains(blocksText(replyB), "first about B") {
		t.Fatalf("reply B = %v", replyB.body)
	}
	// The message about no task starts the thread of its minbox thread (not a task's).
	if _, has := noTask.body["thread_ts"]; has || !strings.Contains(blocksText(noTask), "no task") {
		t.Fatalf("no task = %v", noTask.body)
	}
	if st, ok, _ := r.st.GetSlackThread(context.Background(), d.ID, "thr_stream"); !ok || st.TS == tsA.TS || st.TS == tsB.TS {
		t.Fatalf("stream thread = %+v %v", st, ok)
	}
}

func TestSlackAppTaskQuestionsAndFilesGoToTheThread(t *testing.T) {
	r := newRig(t)
	var up atomic.Int64
	f := newFakeSlackAPI(t, uploadReply(&up, false))
	r.addApp(t, nil)
	p := writeTemp(t, "a.txt", "hello")
	n := Notification{Session: "alpha", ThreadID: "thr_1", TaskID: "tsk_q", TaskTitle: "Ask", Body: "Pick one\n\nCommands to run: approve in minbox", NeedsAction: true,
		Files: []File{{Name: "a.txt", Path: p}}}
	r.d.Dispatch(n)
	r.d.Wait()
	calls := f.all()
	if calls[0].method != "chat.postMessage" || calls[1].method != "chat.postMessage" {
		t.Fatalf("calls = %+v", calls)
	}
	parentTS := "1700000000.001"
	reply := blocksText(calls[1])
	if calls[1].body["thread_ts"] != parentTS || !strings.Contains(reply, "needs your answer") || !strings.Contains(reply, "approve in minbox") {
		t.Fatalf("reply = %v", calls[1].body)
	}
	sawComplete := false
	for _, c := range calls {
		if c.method == "files.completeUploadExternal" {
			sawComplete = c.body["thread_ts"] == parentTS
		}
	}
	if !sawComplete {
		t.Fatalf("the file did not go to the task's thread: %+v", calls)
	}
}

func TestSlackAppTaskParentEditedOnChange(t *testing.T) {
	r := newRig(t)
	f := newFakeSlackAPI(t, okReply())
	d := r.addApp(t, map[string]any{"mention_me": false})
	// No thread for the task yet: nothing to edit.
	r.d.DispatchTask(Notification{TaskID: "tsk_a", TaskTitle: "Renamed", TaskStatus: store.TaskDone})
	r.d.Wait()
	if len(f.all()) != 0 {
		t.Fatalf("calls = %+v", f.all())
	}
	r.d.Dispatch(Notification{Session: "alpha", ThreadID: "thr_1", TaskID: "tsk_a", TaskTitle: "Old", TaskStatus: store.TaskWorking, Body: "hi"})
	r.d.Wait()
	th, _, _ := r.st.GetSlackTaskThread(context.Background(), d.ID, "tsk_a")
	r.d.DispatchTask(Notification{Project: "api", TaskID: "tsk_a", TaskTitle: "Renamed", TaskStatus: store.TaskDone})
	r.d.Wait()
	calls := f.all()
	last := calls[len(calls)-1]
	if last.method != "chat.update" || last.body["ts"] != th.TS || last.body["channel"] != th.ChannelID {
		t.Fatalf("last = %+v", last)
	}
	txt := blocksText(last)
	if !strings.Contains(txt, ":white_check_mark: *Renamed*") || !strings.Contains(txt, "done") {
		t.Fatalf("update = %q", txt)
	}
}

func TestInboundReplyInTaskThreadCarriesTheTask(t *testing.T) {
	r := newInRig(t, nil)
	ctx := context.Background()
	now := r.now.Unix()
	parent := "1699999500.000100"
	if err := r.st.PutSlackTaskThread(ctx, r.dest.ID, "tsk_a", "thr_stream", store.SlackThread{ChannelID: dmChan, TS: parent}); err != nil {
		t.Fatal(err)
	}
	s := &slackScript{replies: map[string][]map[string]any{
		parent:              {msg("U0BOT", "parent", parent, nil), msg("U0ME", "about A", ts(now+10, 1), map[string]any{"thread_ts": parent})},
		"1699999000.000100": {msg("U0ME", "not a task", ts(now+11, 1), map[string]any{"thread_ts": "1699999000.000100"})},
	}}
	newFakeSlackAPI(t, s.handler())
	w := r.worker(t)
	w.cycle(ctx)
	got := map[string]bool{}
	for _, x := range r.in.replies {
		got[x] = true
	}
	if len(r.in.replies) != 2 || !got["thr_stream#tsk_a:about A"] || !got["thr_1:not a task"] {
		t.Fatalf("replies = %q", r.in.replies)
	}
	// The cursor of the task's thread moved: the reply is not delivered twice.
	w.cycle(ctx)
	if len(r.in.replies) != 2 {
		t.Fatalf("again: %q", r.in.replies)
	}
}
