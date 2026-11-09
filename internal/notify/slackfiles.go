package notify

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"
)

// Files, both ways. Out: the artifacts of a message are uploaded to its Slack thread with the
// external upload flow (files.getUploadURLExternal, a POST of the bytes, files.completeUploadExternal;
// scope files:write). In: files of a received message are downloaded with the bot token
// (url_private_download; scope files:read).

const (
	slackUploadMaxBytes = 20 << 20 // a file above this is skipped, with a log line
	slackUploadMaxFiles = 10       // per message
	// Received files.
	SlackInFileMaxBytes = 20 << 20
	SlackInFileMax      = 5
)

// InFile is a file received from Slack, downloaded.
type InFile struct {
	Name string
	Mime string
	Data []byte
}

// uploadFiles sends n.Files to the channel (in the thread when threadTS is set). A failure never
// asks for the message to be sent again (it is already posted): the error is not retryable.
func (s *SlackApp) uploadFiles(ctx context.Context, n Notification, channel, threadTS string) error {
	if !s.SendArtifacts || n.Test || len(n.Files) == 0 || channel == "" {
		return nil
	}
	files := n.Files
	if len(files) > slackUploadMaxFiles {
		log.Printf("slack: %s: %d artifacts in one message; sending the first %d", s.DestID, len(files), slackUploadMaxFiles)
		files = files[:slackUploadMaxFiles]
	}
	type done struct{ ID, Title string }
	var ready []done
	var notes []string
	for _, f := range files {
		st, err := os.Stat(f.Path)
		if err != nil || !st.Mode().IsRegular() {
			notes = append(notes, f.Name+": not readable")
			continue
		}
		if st.Size() > slackUploadMaxBytes {
			log.Printf("slack: %s: artifact %q is %d MB, above the %d MB limit; not sent to Slack", s.DestID, safeCode(f.Name), st.Size()>>20, slackUploadMaxBytes>>20)
			continue
		}
		if st.Size() == 0 {
			continue // Slack refuses empty files
		}
		id, err := s.uploadOne(ctx, f, st.Size())
		if err != nil {
			return s.uploadFail(err)
		}
		ready = append(ready, done{id, f.Name})
	}
	if len(ready) == 0 {
		if len(notes) > 0 {
			return &SendError{Msg: "Artifacts not sent to Slack (" + strings.Join(notes, "; ") + ")"}
		}
		return nil
	}
	var fl []map[string]string
	for _, d := range ready {
		fl = append(fl, map[string]string{"id": d.ID, "title": d.Title})
	}
	body := map[string]any{"files": fl, "channel_id": channel}
	if threadTS != "" {
		body["thread_ts"] = threadTS
	}
	if _, err := s.call(ctx, "files.completeUploadExternal", body); err != nil {
		return s.uploadFail(err)
	}
	return nil
}

// uploadFail words an upload failure; it is never retried (the message itself was delivered).
func (s *SlackApp) uploadFail(err error) error {
	var se *SendError
	if !errors.As(err, &se) {
		return err
	}
	e := *se
	e.Retry, e.RetryAfter = false, 0
	switch {
	case se.code == "missing_scope":
		e.Msg = "Message sent, but its files were not: the app lacks the files:write scope. Add it under OAuth & Permissions → Bot Token Scopes and reinstall the app (or turn off Send artifacts)"
	default:
		e.Msg = "Message sent, but uploading its files to Slack failed: " + se.Msg
	}
	return &e
}

// uploadOne gets an upload URL, sends the bytes there and returns the Slack file id.
func (s *SlackApp) uploadOne(ctx context.Context, f File, size int64) (string, error) {
	r, err := s.callForm(ctx, "files.getUploadURLExternal", url.Values{"filename": {f.Name}, "length": {strconv.FormatInt(size, 10)}})
	if err != nil {
		return "", err
	}
	if r.UploadURL == "" || r.FileID == "" {
		return "", &SendError{Msg: "Slack gave no upload URL"}
	}
	if !s.trustedURL(r.UploadURL) {
		return "", &SendError{Msg: "Slack gave an upload URL on an unexpected host"}
	}
	data, err := os.ReadFile(f.Path)
	if err != nil {
		return "", &SendError{Msg: "reading " + f.Name + ": " + withoutURL(err).Error()}
	}
	req, err := http.NewRequestWithContext(ctx, "POST", r.UploadURL, bytes.NewReader(data))
	if err != nil {
		return "", &SendError{Msg: "bad Slack upload URL"}
	}
	req.Header.Set("Content-Type", "application/octet-stream")
	// No Authorization header: the upload URL is signed.
	c := *s.Client
	c.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	resp, err := c.Do(req)
	if err != nil {
		return "", &SendError{Msg: s.scrub("upload failed: " + withoutURL(err).Error())}
	}
	defer resp.Body.Close()
	_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 1<<16))
	if resp.StatusCode/100 != 2 {
		return "", &SendError{Msg: fmt.Sprintf("Slack's upload URL answered %d", resp.StatusCode), Status: resp.StatusCode}
	}
	return r.FileID, nil
}

// trustedURL: u is https on slack.com (or a subdomain), or on the same scheme and host as the
// API base (a fake Slack in tests).
func (s *SlackApp) trustedURL(raw string) bool {
	u, err := url.Parse(raw)
	if err != nil || u.Host == "" {
		return false
	}
	if b, err := url.Parse(s.Base); err == nil && u.Scheme == b.Scheme && u.Host == b.Host {
		return true
	}
	h := strings.ToLower(u.Hostname())
	return u.Scheme == "https" && (h == "slack.com" || strings.HasSuffix(h, ".slack.com"))
}

// errSkipFile means this file is not taken (and why); other errors are worth retrying.
type errSkipFile struct{ why string }

func (e *errSkipFile) Error() string { return e.why }

// acceptedMime: images and text-like files.
func acceptedMime(m string) bool {
	m, _, _ = strings.Cut(strings.ToLower(strings.TrimSpace(m)), ";")
	m = strings.TrimSpace(m)
	switch {
	case m == "image/svg+xml":
		return false
	case strings.HasPrefix(m, "image/"), strings.HasPrefix(m, "text/"):
		return true
	}
	return m == "application/json" || m == "application/pdf"
}

// download fetches one received file with the bot token. The token goes only to Slack's own
// hosts, and a redirect is followed only within the same host.
func (s *SlackApp) download(ctx context.Context, f slackFile) ([]byte, error) {
	u := f.URLPrivateDownload
	if u == "" {
		u = f.URLPrivate
	}
	if u == "" {
		return nil, &errSkipFile{"no download URL"}
	}
	if !s.trustedURL(u) {
		return nil, &errSkipFile{"download URL on an unexpected host"}
	}
	c := *s.Client
	c.CheckRedirect = func(req *http.Request, via []*http.Request) error {
		if len(via) >= 3 {
			return errors.New("too many redirects")
		}
		if req.URL.Host != via[0].URL.Host || req.URL.Scheme != via[0].URL.Scheme {
			return http.ErrUseLastResponse
		}
		return nil
	}
	var last error
	for try := 0; try < 2; try++ {
		req, err := http.NewRequestWithContext(ctx, "GET", u, nil)
		if err != nil {
			return nil, &errSkipFile{"bad download URL"}
		}
		req.Header.Set("Authorization", "Bearer "+s.Token)
		resp, err := c.Do(req)
		if err != nil {
			last = &SendError{Msg: s.scrub("download failed: " + withoutURL(err).Error()), Retry: true}
			select {
			case <-ctx.Done():
				return nil, last
			case <-time.After(500 * time.Millisecond):
			}
			continue
		}
		data, err := func() ([]byte, error) {
			defer resp.Body.Close()
			switch {
			case resp.StatusCode == http.StatusTooManyRequests || resp.StatusCode >= 500:
				return nil, &SendError{Msg: fmt.Sprintf("Slack answered %d for a file", resp.StatusCode), Status: resp.StatusCode, Retry: true}
			case resp.StatusCode/100 == 3:
				return nil, &errSkipFile{"Slack redirected the download to another host"}
			case resp.StatusCode == 401 || resp.StatusCode == 403 || resp.StatusCode == 404:
				return nil, &errSkipFile{fmt.Sprintf("Slack answered %d (the app may lack the files:read scope)", resp.StatusCode)}
			case resp.StatusCode/100 != 2:
				return nil, &errSkipFile{fmt.Sprintf("Slack answered %d", resp.StatusCode)}
			}
			// Without files:read Slack answers 200 with a sign-in page.
			if ct := strings.ToLower(resp.Header.Get("Content-Type")); strings.HasPrefix(ct, "text/html") && !strings.HasPrefix(strings.ToLower(f.Mimetype), "text/html") {
				return nil, &errSkipFile{"Slack sent a web page instead of the file (add the files:read scope and reinstall the app)"}
			}
			b, err := io.ReadAll(io.LimitReader(resp.Body, SlackInFileMaxBytes+1))
			if err != nil {
				return nil, &SendError{Msg: "download failed: " + withoutURL(err).Error(), Retry: true}
			}
			if len(b) > SlackInFileMaxBytes {
				return nil, &errSkipFile{"larger than the limit"}
			}
			return b, nil
		}()
		if err == nil {
			return data, nil
		}
		var se *SendError
		if !errors.As(err, &se) {
			return nil, err
		}
		last = err
	}
	return nil, last
}
