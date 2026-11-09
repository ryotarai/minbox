package notify

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// uploadReply is a fake Slack that supports the external upload flow.
func uploadReply(uploaded *atomic.Int64, scopeMissing bool) func(appCall, int) (int, http.Header, string) {
	ok := okReply()
	return func(c appCall, n int) (int, http.Header, string) {
		switch {
		case c.method == "files.getUploadURLExternal":
			if scopeMissing {
				return 200, nil, `{"ok":false,"error":"missing_scope","needed":"files:write"}`
			}
			id := fmt.Sprintf("F%d", uploaded.Add(1))
			return 200, nil, `{"ok":true,"upload_url":"` + slackAPIBase + `/upload/` + id + `","file_id":"` + id + `"}`
		case strings.HasPrefix(c.method, "upload/"):
			return 200, nil, "OK - " + c.method
		case c.method == "files.completeUploadExternal":
			return 200, nil, `{"ok":true}`
		}
		return ok(c, n)
	}
}

func writeTemp(t *testing.T, name, content string) string {
	p := filepath.Join(t.TempDir(), name)
	if err := os.WriteFile(p, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	return p
}

func TestSlackAppUploadsArtifactsToTheThread(t *testing.T) {
	r := newRig(t)
	var up atomic.Int64
	f := newFakeSlackAPI(t, uploadReply(&up, false))
	r.addApp(t, nil)
	img := writeTemp(t, "shot.png", "PNGDATA")
	html := writeTemp(t, "report.html", "<h1>x</h1>")
	n := Notification{Title: "Hi", ThreadID: "thr_1", Body: "see", Files: []File{{Name: "shot.png", Path: img}, {Name: "report.html", Path: html}}}
	r.d.Dispatch(n)
	r.d.Wait()
	// Second message of the thread: the files go to the thread of the parent.
	r.d.Dispatch(n)
	r.d.Wait()
	m := methods(f)
	if m["chat.postMessage"] != 2 || m["files.getUploadURLExternal"] != 4 || m["files.completeUploadExternal"] != 2 {
		t.Fatalf("calls = %v", m)
	}
	var completes []appCall
	for _, c := range f.all() {
		if strings.HasPrefix(c.method, "upload/") && c.auth != "" {
			t.Fatalf("the bot token went to the upload URL: %+v", c)
		}
		if c.method == "files.getUploadURLExternal" && (c.body["filename"] == "" || c.body["length"] == "") {
			t.Fatalf("getUploadURL = %v", c.body)
		}
		if c.method == "files.completeUploadExternal" {
			completes = append(completes, c)
		}
	}
	for _, c := range completes {
		if c.body["channel_id"] != "C0123ABCD" || c.body["thread_ts"] != "1700000000.001" || len(c.body["files"].([]any)) != 2 {
			t.Fatalf("complete = %v", c.body)
		}
	}
}

func TestSlackAppArtifactsOffLimitsAndScope(t *testing.T) {
	r := newRig(t)
	var up atomic.Int64
	f := newFakeSlackAPI(t, uploadReply(&up, false))
	r.addApp(t, map[string]any{"send_artifacts": false})
	img := writeTemp(t, "a.png", "x")
	r.d.Dispatch(Notification{Title: "Hi", ThreadID: "thr_1", Body: "b", Files: []File{{Name: "a.png", Path: img}}})
	r.d.Wait()
	if m := methods(f); m["chat.postMessage"] != 1 || len(m) != 1 {
		t.Fatalf("send_artifacts off: %v", m)
	}

	// A file above the limit is skipped; the message is still sent.
	big := filepath.Join(t.TempDir(), "big.bin")
	fh, _ := os.Create(big)
	_ = fh.Truncate(slackUploadMaxBytes + 1)
	fh.Close()
	app := &SlackApp{Token: testToken, Channel: "C0123ABCD", SendArtifacts: true, Client: http.DefaultClient, Base: slackAPIBase}
	f2 := newFakeSlackAPI(t, uploadReply(&up, false))
	app.Base = slackAPIBase
	if err := app.Send(context.Background(), Notification{Title: "t", Body: "b", Files: []File{{Name: "big.bin", Path: big}}}); err != nil {
		t.Fatal(err)
	}
	if m := methods(f2); m["chat.postMessage"] != 1 || m["files.getUploadURLExternal"] != 0 {
		t.Fatalf("big file: %v", m)
	}

	// Missing scope: a clear message, not retried.
	f3 := newFakeSlackAPI(t, uploadReply(&up, true))
	app.Base = slackAPIBase
	err := app.Send(context.Background(), Notification{Title: "t", Body: "b", Files: []File{{Name: "a.png", Path: img}}})
	se, isSE := err.(*SendError)
	if !isSE || se.Retry || !strings.Contains(se.Msg, "files:write") || strings.Contains(se.Msg, testToken) {
		t.Fatalf("err = %v", err)
	}
	if m := methods(f3); m["chat.postMessage"] != 1 {
		t.Fatalf("calls = %v", m)
	}
}

func TestInboundDownloadsFilesWithTheBotToken(t *testing.T) {
	r := newInRig(t, nil)
	now := r.now.Unix()
	var gotAuth []string
	other := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		gotAuth = append(gotAuth, "OTHER:"+req.Header.Get("Authorization"))
	}))
	defer other.Close()
	var base string
	s := &slackScript{}
	api := newFakeSlackAPI(t, func(c appCall, n int) (int, http.Header, string) {
		base = slackAPIBase
		switch c.method {
		case "files/F1/pic.png":
			if c.auth != "Bearer "+testToken {
				return 403, nil, "no"
			}
			return 200, http.Header{"Content-Type": {"image/png"}}, "PNGBYTES"
		case "files/F4/redir.png":
			return 302, http.Header{"Location": {other.URL + "/steal"}}, ""
		case "files/F5/login.png":
			return 200, http.Header{"Content-Type": {"text/html"}}, "<html>sign in</html>"
		}
		return s.handler()(c, n)
	})
	_ = api
	base = slackAPIBase
	file := func(id, name, mime string) map[string]any {
		return map[string]any{"id": id, "name": name, "mimetype": mime, "size": 8,
			"url_private_download": base + "/files/" + id + "/" + name}
	}
	s.history = []map[string]any{
		msg("U0ME", "look at this", ts(now+10, 1), map[string]any{"subtype": "file_share", "files": []any{
			file("F1", "pic.png", "image/png"), file("F2", "app.zip", "application/zip"), file("F4", "redir.png", "image/png"), file("F5", "login.png", "image/png"),
		}}),
		msg("U0ME", "", ts(now+11, 1), map[string]any{"subtype": "file_share", "files": []any{file("F2", "app.zip", "application/zip")}}),
		msg("U0EVIL", "", ts(now+12, 1), map[string]any{"subtype": "file_share", "files": []any{file("F1", "pic.png", "image/png")}}),
	}
	r.in.names = nil
	r.worker(t).cycle(context.Background())
	if len(r.in.threads) != 1 || !strings.HasPrefix(r.in.threads[0], "|main|look at this") {
		t.Fatalf("threads = %q", r.in.threads)
	}
	if fmt.Sprint(r.in.files) != "[new:pic.png:8]" {
		t.Fatalf("files = %q", r.in.files)
	}
	for _, want := range []string{"app.zip", "not taken"} {
		if !strings.Contains(r.in.threads[0], want) {
			t.Fatalf("no note about %q: %q", want, r.in.threads[0])
		}
	}
	if len(gotAuth) != 0 {
		t.Fatalf("the redirect target was contacted: %v", gotAuth)
	}
}

func TestInboundReplyWithFile(t *testing.T) {
	r := newInRig(t, nil)
	ctx := context.Background()
	r.st.TouchSlackThread(ctx, r.dest.ID, "thr_1")
	parent := "1699999000.000100"
	s := &slackScript{}
	var base string
	newFakeSlackAPI(t, func(c appCall, n int) (int, http.Header, string) {
		base = slackAPIBase
		if c.method == "files/F9/x.png" {
			return 200, http.Header{"Content-Type": {"image/png"}}, "12345"
		}
		return s.handler()(c, n)
	})
	base = slackAPIBase
	s.replies = map[string][]map[string]any{parent: {
		msg("U0ME", "", ts(r.now.Unix()+10, 1), map[string]any{"thread_ts": parent, "subtype": "file_share",
			"files": []any{map[string]any{"id": "F9", "name": "x.png", "mimetype": "image/png", "size": 5, "url_private_download": base + "/files/F9/x.png"}}}),
	}}
	r.worker(t).cycle(ctx)
	if fmt.Sprint(r.in.replies) != "[thr_1:]" || fmt.Sprint(r.in.files) != "[thr_1:x.png:5]" {
		t.Fatalf("replies=%q files=%q", r.in.replies, r.in.files)
	}
}

// ---- asking which project ----

type pendRig struct {
	*inRig
	s    *slackScript
	f    *fakeSlackAPI
	w    *pollWorker
	n    int
	base string
	orig string
}

func newPendRig(t *testing.T, cfg map[string]any, seq ...string) *pendRig {
	p := &pendRig{inRig: newInRig(t, cfg), s: &slackScript{}}
	p.orig = ts(p.now.Unix()+10, 1)
	p.in.names = []string{"api", "web"}
	p.in.pickSeq = seq
	var cnt atomic.Int64
	p.f = newFakeSlackAPI(t, func(c appCall, n int) (int, http.Header, string) {
		switch {
		case c.method == "chat.postMessage":
			return 200, nil, fmt.Sprintf(`{"ok":true,"channel":"D0DM","ts":"1700001000.%06d"}`, cnt.Add(1))
		case c.method == "files/F1/pic.png":
			return 200, http.Header{"Content-Type": {"image/png"}}, "PNG"
		}
		return p.s.handler()(c, n)
	})
	p.base = slackAPIBase
	p.w = p.worker(t)
	return p
}

func (p *pendRig) dm(text string, extra map[string]any) {
	if extra == nil {
		extra = map[string]any{}
	}
	p.s.history = append(p.s.history, msg("U0ME", text, p.orig, extra))
}

func (p *pendRig) reply(text string, sec int64) {
	if p.s.replies == nil {
		p.s.replies = map[string][]map[string]any{}
	}
	p.s.replies[p.orig] = append(p.s.replies[p.orig], msg("U0ME", text, ts(p.now.Unix()+100+sec, 1), map[string]any{"thread_ts": p.orig}))
}

func (p *pendRig) posts() []string {
	var out []string
	for _, c := range p.f.all() {
		if c.method == "chat.postMessage" {
			if c.body["thread_ts"] != p.orig {
				panic("post outside the thread")
			}
			out = append(out, c.body["text"].(string))
		}
	}
	return out
}

func (p *pendRig) cycle() { p.w.pauseUntil = time.Time{}; p.w.cycle(context.Background()) }

func TestPendingIdentifiedFirstTime(t *testing.T) {
	p := newPendRig(t, nil, "proj_api")
	p.dm("fix the build", nil)
	p.cycle()
	if fmt.Sprint(p.in.threads) != "[proj_api|main|fix the build]" || len(p.posts()) != 0 {
		t.Fatalf("threads=%q posts=%q", p.in.threads, p.posts())
	}
}

func TestPendingAskThenIdentified(t *testing.T) {
	p := newPendRig(t, nil, "", "proj_api")
	p.dm("see the picture", map[string]any{"subtype": "file_share", "files": []any{
		map[string]any{"id": "F1", "name": "pic.png", "mimetype": "image/png", "size": 3, "url_private_download": p.base + "/files/F1/pic.png"}}})
	p.cycle()
	if len(p.in.threads) != 0 {
		t.Fatalf("a thread was created: %q", p.in.threads)
	}
	posts := p.posts()
	if len(posts) != 1 || !strings.Contains(posts[0], "`api`") || !strings.Contains(posts[0], "`web`") {
		t.Fatalf("posts = %q", posts)
	}
	pend, _ := p.st.ListSlackPending(context.Background(), p.dest.ID, dmChan)
	if len(pend) != 1 || pend[0].Rounds != 1 || pend[0].ThreadTS != p.orig {
		t.Fatalf("pending = %+v", pend)
	}
	// A cycle with no answer asks nothing more and calls no replies method.
	p.cycle()
	if len(p.posts()) != 1 || methods(p.f)["conversations.replies"] != 0 {
		t.Fatalf("calls = %v", methods(p.f))
	}
	p.reply("the api one", 1)
	p.cycle()
	if fmt.Sprint(p.in.threads) != "[proj_api|main|see the picture]" || fmt.Sprint(p.in.files) != "[new:pic.png:3]" {
		t.Fatalf("threads=%q files=%q", p.in.threads, p.in.files)
	}
	if len(p.in.picked) != 2 || !strings.Contains(p.in.picked[1], "see the picture") || !strings.Contains(p.in.picked[1], "the api one") {
		t.Fatalf("picked = %q", p.in.picked)
	}
	if pend, _ := p.st.ListSlackPending(context.Background(), p.dest.ID, dmChan); len(pend) != 0 {
		t.Fatalf("still pending: %+v", pend)
	}
	// The Slack thread now belongs to the minbox thread: a later reply goes there, once.
	if ref, ok, _ := p.st.GetSlackThread(context.Background(), p.dest.ID, "thr_new"); !ok || ref.TS != p.orig {
		t.Fatalf("slack thread = %+v %v", ref, ok)
	}
	p.reply("and one more thing", 5)
	p.cycle()
	p.cycle()
	if fmt.Sprint(p.in.replies) != "[thr_new:and one more thing]" || len(p.in.threads) != 1 {
		t.Fatalf("replies=%q threads=%q", p.in.replies, p.in.threads)
	}
}

func TestPendingAskTwice(t *testing.T) {
	p := newPendRig(t, nil, "", "", "proj_web")
	p.dm("deploy it", nil)
	p.cycle()
	p.reply("hmm", 1)
	p.cycle()
	if len(p.posts()) != 2 || !strings.Contains(p.posts()[1], "still") || len(p.in.threads) != 0 {
		t.Fatalf("posts=%q threads=%q", p.posts(), p.in.threads)
	}
	p.reply("web", 2)
	p.cycle()
	if fmt.Sprint(p.in.threads) != "[proj_web|main|deploy it]" {
		t.Fatalf("threads = %q", p.in.threads)
	}
}

func TestPendingCapFallsBackOrStops(t *testing.T) {
	p := newPendRig(t, nil, "")
	p.dm("who knows", nil)
	p.cycle()
	for i := int64(1); i <= 3; i++ {
		p.reply("dunno", i)
		p.cycle()
	}
	// Asked three times, then gave up into the fallback project.
	posts := p.posts() // 3 questions, then the notice that the fallback project was used
	if len(posts) != 4 || fmt.Sprint(p.in.threads) != "[|main|who knows]" {
		t.Fatalf("posts=%q threads=%q", posts, p.in.threads)
	}
	if len(p.in.picked) != 4 {
		t.Fatalf("picked = %d", len(p.in.picked))
	}

	// Without a fallback project: the person is told, nothing is created.
	q := newPendRig(t, map[string]any{"default_project": ""}, "")
	q.dm("who knows", nil)
	q.cycle()
	for i := int64(1); i <= 3; i++ {
		q.reply("dunno", i)
		q.cycle()
	}
	qp := q.posts()
	if len(q.in.threads) != 0 || len(qp) != 4 || !strings.Contains(qp[3], "dropped") {
		t.Fatalf("posts=%q threads=%q", qp, q.in.threads)
	}
	if pend, _ := q.st.ListSlackPending(context.Background(), q.dest.ID, dmChan); len(pend) != 0 {
		t.Fatalf("pending left: %+v", pend)
	}
}

func TestPendingModelErrorKeepsFallback(t *testing.T) {
	p := newPendRig(t, nil)
	p.in.pickErr = fmt.Errorf("claude missing")
	p.dm("hello", nil)
	p.cycle()
	if fmt.Sprint(p.in.threads) != "[|main|hello]" || len(p.posts()) != 0 {
		t.Fatalf("threads=%q posts=%q", p.in.threads, p.posts())
	}
}

func TestPendingOnlyAllowedUsersAnswer(t *testing.T) {
	p := newPendRig(t, nil, "", "proj_api")
	p.dm("hello", nil)
	p.cycle()
	p.s.replies = map[string][]map[string]any{p.orig: {msg("U0EVIL", "api", ts(p.now.Unix()+101, 1), map[string]any{"thread_ts": p.orig})}}
	p.cycle()
	if len(p.in.threads) != 0 || len(p.in.picked) != 1 {
		t.Fatalf("a stranger answered: threads=%q picked=%q", p.in.threads, p.in.picked)
	}
}
