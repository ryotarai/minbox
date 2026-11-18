package store

import (
	"context"
	"errors"
)

// ErrNoQuestions: the message has no question (or none with the key) to ignore.
var ErrNoQuestions = errors.New("the message has no such question")

// IgnoreQuestions marks questions of an agent message as ignored by the person (a moot question: it
// stops waiting on them; nothing is sent to the agent), or, with ignore false, reopens them. keys
// empty means every question of the message. It returns the message's thread.
func (s *Store) IgnoreQuestions(ctx context.Context, messageID string, keys []string, ignore bool) (threadID string, err error) {
	m, err := s.GetMessage(ctx, messageID)
	if err != nil {
		return "", err
	}
	if m.Author != AuthorAgent || len(m.Questions) == 0 {
		return "", ErrNoQuestions
	}
	has := map[string]bool{}
	for _, q := range m.Questions {
		has[q.Key] = true
	}
	if len(keys) == 0 {
		for _, q := range m.Questions {
			keys = append(keys, q.Key)
		}
	}
	cur := map[string]int64{}
	for k, t := range m.Ignored {
		cur[k] = ms(t)
	}
	now := ms(s.now())
	for _, k := range keys {
		if !has[k] {
			return "", ErrNoQuestions
		}
		if !ignore {
			delete(cur, k)
		} else if _, ok := cur[k]; !ok {
			cur[k] = now
		}
	}
	if err := s.exec(ctx, `UPDATE messages SET ignored=? WHERE id=?`, jsonOf(cur), messageID); err != nil {
		return "", err
	}
	return m.ThreadID, nil
}
