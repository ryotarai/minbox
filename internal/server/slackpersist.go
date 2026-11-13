package server

import (
	"context"
	"encoding/json"
	"time"

	"github.com/ryotarai/minbox/internal/store"
)

// Persistence of what was read from Slack (slack_threads, slack_users; see docs/slack-personal.md).
// The in-memory maps stay the working copy; every fetch is written through, and the first use after
// a start loads the rows, so a restart does not read again what the TTLs still call fresh. The
// token and other secrets are never written here.

const (
	slackThreadMaxBytes = 256 << 10 // stored JSON per thread
	slackMsgTextMax     = 4000      // a message's text when a thread is over the cap
	slackPruneAfter     = 30 * 24 * time.Hour
)

// loadPersisted fills the memory caches from the database once (rows already in memory win).
func (l *slackSvc) loadPersisted(ctx context.Context) {
	l.mu.Lock()
	if l.loaded {
		l.mu.Unlock()
		return
	}
	l.loaded = true
	l.mu.Unlock()
	rows, err := l.s.store.SlackThreads(ctx)
	if err != nil {
		return
	}
	users, uerr := l.s.store.SlackUsers(ctx)
	l.mu.Lock()
	defer l.mu.Unlock()
	for _, r := range rows {
		k := threadKey(r.Channel, r.ThreadTS)
		if _, ok := l.threads[k]; ok {
			continue
		}
		var td slackThreadData
		if json.Unmarshal([]byte(r.Data), &td) != nil || td.Channel == "" {
			continue
		}
		td.FetchedAt = r.FetchedAt
		l.threads[k] = &td
	}
	if uerr == nil {
		for _, u := range users {
			if _, ok := l.users[u.ID]; !ok {
				l.users[u.ID] = slackUserEntry{at: u.FetchedAt, name: u.Name, bot: u.Bot}
			}
		}
	}
}

// capThreadJSON marshals a thread within slackThreadMaxBytes: over the cap, attachments and files go,
// then message texts are cut; still over, it is not stored ("" is returned).
func capThreadJSON(td *slackThreadData) string {
	b, err := json.Marshal(td)
	if err != nil {
		return ""
	}
	if len(b) <= slackThreadMaxBytes {
		return string(b)
	}
	c := *td
	c.Msgs = append(c.Msgs[:0:0], td.Msgs...)
	for i := range c.Msgs {
		c.Msgs[i].Files, c.Msgs[i].Attachments = nil, nil
		if r := []rune(c.Msgs[i].Text); len(r) > slackMsgTextMax {
			c.Msgs[i].Text = string(r[:slackMsgTextMax])
		}
	}
	b, err = json.Marshal(&c)
	if err != nil || len(b) > slackThreadMaxBytes {
		return ""
	}
	return string(b)
}

// persistThread writes a fetched thread through to the database.
func (l *slackSvc) persistThread(ctx context.Context, td *slackThreadData) {
	if td == nil {
		return
	}
	data := capThreadJSON(td)
	if data == "" {
		return
	}
	_ = l.s.store.SaveSlackThread(ctx, store.SlackThreadRow{Channel: td.Channel, ThreadTS: td.ThreadTS, LatestTS: td.LatestTS, FetchedAt: td.FetchedAt, SeenAt: l.now(), Data: data})
}

func (l *slackSvc) persistUser(ctx context.Context, id string, e slackUserEntry) {
	_ = l.s.store.SaveSlackUser(ctx, store.SlackUserRow{ID: id, Name: e.name, Bot: e.bot, FetchedAt: e.at})
}

// pruneFetched forgets threads not seen for 30 days (and names not looked up for that long).
func (l *slackSvc) pruneFetched(ctx context.Context) {
	cut := l.now().Add(-slackPruneAfter)
	_ = l.s.store.PruneSlackFetched(ctx, cut)
	l.mu.Lock()
	for k, t := range l.threads {
		if t.FetchedAt.Before(cut) {
			delete(l.threads, k)
		}
	}
	l.mu.Unlock()
}
