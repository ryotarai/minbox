package server

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"sort"
	"strings"
	"time"

	"github.com/ryotarai/minbox/internal/slackuser"
	"github.com/ryotarai/minbox/internal/store"
)

// The Slack screen's API: the list (grouped Needs reply / Maybe / Dismissed), a thread's detail,
// dismiss / snooze / mute. Nothing here polls Slack: the list is built from what the last refresh
// stored; a refresh (GET …?refresh=1) runs the pipeline of slackpipeline.go.

const (
	slackMaxSnooze  = 90 * 24 * time.Hour
	slackKeepDays   = 14 // items whose latest message is older than this are not listed
	slackDetailTTL  = 2 * time.Minute
	slackDetailCall = 8
)

type slackItemView struct {
	ID          string              `json:"id"`
	Channel     string              `json:"channel"`
	ThreadTS    string              `json:"thread_ts"`
	Group       string              `json:"group"` // needs_reply | maybe | dismissed
	State       string              `json:"state"` // active | dismissed | snoozed | muted
	SnoozeUntil *time.Time          `json:"snooze_until,omitempty"`
	Reappeared  bool                `json:"reappeared,omitempty"`
	Kind        string              `json:"kind"`
	Label       string              `json:"label"`
	People      []string            `json:"people"`
	LastTS      string              `json:"last_ts"`
	LastAt      *time.Time          `json:"last_at"`
	LastAuthor  string              `json:"last_author"`
	LastIsMe    bool                `json:"last_is_me"`
	Snippet     string              `json:"snippet"`
	Messages    int                 `json:"messages"`
	Unread      bool                `json:"unread"`
	Permalink   string              `json:"permalink"`
	Judgement   *slackJudgement     `json:"judgement"`
	Unjudged    bool                `json:"unjudged"`
	Stale       bool                `json:"stale,omitempty"`
	Thread      *store.LinkedThread `json:"minbox_thread"`
}

// itemViews builds the list from the store: judgement "no" items are counted, not listed; a dismissed
// item returns to its group when a newer message arrived (unless muted); a snooze ends with its time.
func (l *slackSvc) itemViews(ctx context.Context) (items []slackItemView, hidden int) {
	rows, err := l.s.store.SlackItems(ctx)
	if err != nil {
		return nil, 0
	}
	linked, _ := l.s.store.SlackLinkedThreads(ctx)
	now := l.now()
	cutoff := now.Add(-slackKeepDays * 24 * time.Hour)
	items = []slackItemView{}
	for _, r := range rows {
		if r.View == "" {
			continue
		}
		var v slackView
		if json.Unmarshal([]byte(r.View), &v) != nil {
			continue
		}
		if t := tsTime(v.LastTS); !t.IsZero() && t.Before(cutoff) {
			continue
		}
		it := slackItemView{ID: threadKey(r.Channel, r.ThreadTS), Channel: r.Channel, ThreadTS: r.ThreadTS, State: r.State, Kind: v.Kind, Label: v.Label, People: v.People,
			LastTS: v.LastTS, LastAuthor: v.LastAuthor, LastIsMe: v.LastIsMe, Snippet: v.Snippet, Messages: v.Messages, Unread: v.Unread && v.Kind == "dm", Permalink: v.Permalink}
		if it.People == nil {
			it.People = []string{}
		}
		if t := tsTime(v.LastTS); !t.IsZero() {
			it.LastAt = &t
		}
		if lt, ok := linked[it.ID]; ok {
			lt := lt
			it.Thread = &lt
		}
		if r.Judgement != "" {
			var j slackJudgement
			if json.Unmarshal([]byte(r.Judgement), &j) == nil && j.NeedsReply != "" {
				it.Judgement = &j
				it.Stale = r.JudgedLatestTS != v.LastTS
			}
		}
		it.Unjudged = it.Judgement == nil
		if it.Judgement != nil && it.Judgement.NeedsReply == "no" && !it.Stale {
			if it.Thread == nil {
				hidden++
				continue
			}
		}
		// The person's triage state.
		switch r.State {
		case "muted":
			it.Group = "dismissed"
		case "dismissed":
			if r.DismissedAtTS != "" && tsCmp(v.LastTS, r.DismissedAtTS) > 0 && !v.LastIsMe {
				it.State, it.Reappeared = "active", true
			} else {
				it.Group = "dismissed"
			}
		case "snoozed":
			if r.SnoozeUntil.After(now) {
				it.Group = "dismissed"
				it.SnoozeUntil = tpp(r.SnoozeUntil)
			} else {
				it.State = "active"
			}
		}
		if it.Group == "" {
			switch {
			case it.Judgement != nil && it.Judgement.NeedsReply == "yes":
				it.Group = "needs_reply"
			default: // maybe, unjudged, a stale "no", or a "no" that has a minbox thread

				it.Group = "maybe"
			}
		}
		items = append(items, it)
	}
	rank := map[string]int{"needs_reply": 0, "maybe": 1, "dismissed": 2}
	urg := map[string]int{"high": 0, "normal": 1, "low": 2}
	u := func(i slackItemView) int {
		if i.Judgement != nil {
			return urg[i.Judgement.Urgency]
		}
		return 1
	}
	sort.SliceStable(items, func(i, j int) bool {
		a, b := items[i], items[j]
		if rank[a.Group] != rank[b.Group] {
			return rank[a.Group] < rank[b.Group]
		}
		if u(a) != u(b) {
			return u(a) < u(b)
		}
		return tsCmp(a.LastTS, b.LastTS) > 0
	})
	return items, hidden
}

func (s *Server) slackFail(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, errSlackNotConnected):
		httpErrorCode(w, 409, err.Error(), "not_connected")
	default:
		httpError(w, 502, s.slack.scrub(err.Error()))
	}
}

func httpErrorCode(w http.ResponseWriter, status int, msg, code string) {
	writeJSON(w, status, map[string]any{"error": msg, "code": code})
}

// GET /api/slack/threads[?refresh=1][&cached=1]
func (s *Server) slackThreadsList(w http.ResponseWriter, r *http.Request) {
	l := s.slack
	ctx := r.Context()
	a := l.loadAuth(ctx)
	if a == nil {
		s.slackFail(w, errSlackNotConnected)
		return
	}
	var rerr error
	if !queryFlag(r, "cached") {
		rerr = l.refresh(ctx, queryFlag(r, "refresh"))
		if ctx.Err() != nil {
			return
		}
	}
	items, hidden := l.itemViews(ctx)
	if rerr != nil && len(items) == 0 {
		s.slackFail(w, rerr)
		return
	}
	l.mu.Lock()
	notes := append([]string{}, l.notes...)
	last := l.lastRefresh
	l.mu.Unlock()
	if rerr != nil {
		notes = append(notes, "Refresh failed: "+l.scrub(rerr.Error()))
	}
	counts := map[string]int{}
	for _, it := range items {
		counts[it.Group]++
	}
	if a2 := l.loadAuth(ctx); a2 != nil {
		a = a2 // the refresh may have switched to the legacy search
	}
	be, bn := l.effectiveBackend(a)
	writeJSON(w, 200, map[string]any{"items": items, "counts": counts, "hidden": hidden, "notes": notes, "fetched_at": tpp(last), "refresh": l.progressView(),
		"user": map[string]string{"id": a.UserID, "name": a.User}, "team": a.Team, "backend": be, "backend_note": bn})
}

// ---- detail ----

type slackMsgView struct {
	TS          string      `json:"ts"`
	At          string      `json:"at"`
	UserID      string      `json:"user_id"`
	Name        string      `json:"name"`
	IsMe        bool        `json:"is_me"`
	IsBot       bool        `json:"is_bot"`
	HTML        string      `json:"html"`
	Files       []slackLink `json:"files"`
	Attachments []slackLink `json:"attachments"`
}

type slackLink struct {
	Name string `json:"name"`
	URL  string `json:"url,omitempty"`
}

// threadData returns the thread's messages: the cache when fresh, else read from Slack. A read that
// fails keeps a cached copy (stale) when there is one.
func (l *slackSvc) threadData(ctx context.Context, a *slackUserAuth, channel, ts string, refresh bool) (*slackThreadData, string, error) {
	k := threadKey(channel, ts)
	l.mu.Lock()
	td := l.threads[k]
	l.mu.Unlock()
	if td != nil && !refresh && l.now().Sub(td.FetchedAt) < slackDetailTTL {
		return td, "", nil
	}
	c := slackCand{Channel: channel, ThreadTS: ts, IsDM: ts == "dm" || strings.HasPrefix(channel, "D")}
	if it, ok := l.s.store.SlackItem(ctx, channel, ts); ok && it.View != "" {
		var v slackView
		if json.Unmarshal([]byte(it.View), &v) == nil {
			c.ChannelName = strings.TrimPrefix(v.Label, "#")
		}
	}
	bud := &slackBudget{max: slackDetailCall}
	nt, err := l.fetchThread(ctx, c, bud, a.URL)
	if err != nil {
		if td != nil {
			return td, "Showing the last copy read from Slack: " + err.Msg, nil
		}
		return nil, "", errors.New(err.Msg)
	}
	if td != nil {
		nt.Peer, nt.Unread, nt.ChannelName, nt.IsGroup = td.Peer, td.Unread, firstNonEmpty(nt.ChannelName, td.ChannelName), td.IsGroup
	}
	if nt.IsDM && nt.Peer == "" {
		for _, m := range nt.Msgs {
			if m.User != "" && m.User != a.UserID {
				nt.Peer = m.User
				break
			}
		}
	}
	l.resolveUsers(ctx, threadUserIDs(nt), bud)
	l.mu.Lock()
	l.threads[threadKey(nt.Channel, nt.ThreadTS)] = nt
	l.mu.Unlock()
	return nt, "", nil
}

func (l *slackSvc) messageViews(td *slackThreadData, me string) []slackMsgView {
	rs := l.resolver()
	out := []slackMsgView{}
	for _, m := range td.Msgs {
		v := slackMsgView{TS: m.TS, UserID: m.User, IsMe: m.User == me, IsBot: m.BotID != "" || m.Subtype == "bot_message", Files: []slackLink{}, Attachments: []slackLink{}}
		v.Name = l.displayName(firstNonEmpty(m.User, m.BotID))
		if m.User == "" && m.Username != "" {
			v.Name = m.Username
		}
		if t := tsTime(m.TS); !t.IsZero() {
			v.At = t.UTC().Format(time.RFC3339)
		}
		v.HTML = slackuser.RenderHTML(m.Text, rs)
		for _, f := range m.Files {
			u := f.Permalink
			if !slackuser.SafeURL(u) {
				u = ""
			}
			v.Files = append(v.Files, slackLink{Name: firstNonEmpty(f.Name, f.Title, "file"), URL: u})
		}
		for _, at := range m.Attachments {
			if n := firstNonEmpty(at.Title, at.Fallback); n != "" {
				u := at.TitleLink
				if !slackuser.SafeURL(u) {
					u = ""
				}
				v.Attachments = append(v.Attachments, slackLink{Name: truncRunes(n, 160), URL: u})
			}
		}
		out = append(out, v)
	}
	return out
}

// GET /api/slack/threads/{id}[?refresh=1]
func (s *Server) slackThreadGet(w http.ResponseWriter, r *http.Request) {
	l := s.slack
	ctx := r.Context()
	a := l.loadAuth(ctx)
	if a == nil {
		s.slackFail(w, errSlackNotConnected)
		return
	}
	ch, ts, ok := slackItemKey(r.PathValue("id"))
	if !ok {
		httpError(w, 400, "bad thread id")
		return
	}
	td, note, err := l.threadData(ctx, a, ch, ts, queryFlag(r, "refresh"))
	if err != nil {
		if ctx.Err() != nil {
			return
		}
		s.slackFail(w, err)
		return
	}
	view := l.buildView(td, a.UserID)
	out := map[string]any{"id": threadKey(td.Channel, td.ThreadTS), "channel": td.Channel, "thread_ts": td.ThreadTS, "kind": view.Kind, "label": view.Label,
		"permalink": view.Permalink, "messages": l.messageViews(td, a.UserID), "earlier": td.More, "note": note, "fetched_at": td.FetchedAt, "team": a.Team, "me": a.UserID}
	if it, ok := s.store.SlackItem(ctx, td.Channel, td.ThreadTS); ok {
		var j slackJudgement
		if it.Judgement != "" && json.Unmarshal([]byte(it.Judgement), &j) == nil && j.NeedsReply != "" {
			out["judgement"] = j
			out["judgement_stale"] = it.JudgedLatestTS != td.LatestTS
		}
		out["state"] = it.State
		if !it.SnoozeUntil.IsZero() {
			out["snooze_until"] = it.SnoozeUntil
		}
	}
	if linked, _ := s.store.SlackLinkedThreads(ctx); linked != nil {
		if lt, ok := linked[threadKey(td.Channel, td.ThreadTS)]; ok {
			out["minbox_thread"] = lt
		}
	}
	writeJSON(w, 200, out)
}

// ---- dismiss / snooze / mute ----

type slackStateReq struct {
	Action string     `json:"action"` // dismiss | mute | snooze | restore
	Until  *time.Time `json:"until"`
}

// POST /api/slack/threads/{id}/state
func (s *Server) slackThreadState(w http.ResponseWriter, r *http.Request) {
	l := s.slack
	ctx := r.Context()
	if l.loadAuth(ctx) == nil {
		s.slackFail(w, errSlackNotConnected)
		return
	}
	ch, ts, ok := slackItemKey(r.PathValue("id"))
	if !ok {
		httpError(w, 400, "bad thread id")
		return
	}
	var req slackStateReq
	if !decode(w, r, &req) {
		return
	}
	latest := ""
	if it, ok := s.store.SlackItem(ctx, ch, ts); ok {
		var v slackView
		if json.Unmarshal([]byte(it.View), &v) == nil {
			latest = v.LastTS
		}
		if latest == "" {
			latest = it.LastSeenTS
		}
	}
	var err error
	switch req.Action {
	case "dismiss":
		err = s.store.SetSlackItemState(ctx, ch, ts, "dismissed", time.Time{}, latest)
	case "mute":
		err = s.store.SetSlackItemState(ctx, ch, ts, "muted", time.Time{}, latest)
	case "restore":
		err = s.store.SetSlackItemState(ctx, ch, ts, "active", time.Time{}, "")
	case "snooze":
		if req.Until == nil || !req.Until.After(l.now()) {
			httpError(w, 400, "snooze needs a time in the future (until)")
			return
		}
		if req.Until.After(l.now().Add(slackMaxSnooze)) {
			httpError(w, 400, "a snooze lasts at most 90 days")
			return
		}
		err = s.store.SetSlackItemState(ctx, ch, ts, "snoozed", *req.Until, latest)
	default:
		httpError(w, 400, "action must be dismiss, mute, snooze or restore")
		return
	}
	if err != nil {
		storeError(w, err)
		return
	}
	s.hub.publish(Event{Type: "slack"})
	writeJSON(w, 200, map[string]any{"ok": true})
}
