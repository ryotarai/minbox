package store

import (
	"context"
	"database/sql"
	"errors"
	"strings"
	"unicode"
)

// TaskOfThread is the task a thread of before v3 is about: the task made from it (or from one of its
// topics), else the task most of its messages are about; an open one first, then the newest. "" when
// there is none.
func (s *Store) TaskOfThread(ctx context.Context, threadID string) (string, error) {
	var id string
	err := s.db.QueryRowContext(ctx, `SELECT t.id FROM tasks t
	  LEFT JOIN (SELECT mt.task_id, count(*) n FROM message_tasks mt JOIN messages m ON m.id=mt.message_id WHERE m.thread_id=?1 GROUP BY mt.task_id) c ON c.task_id=t.id
	  WHERE t.origin='thread:'||?1 OR t.origin IN (SELECT 'topic:'||id FROM topics WHERE thread_id=?1) OR c.n > 0
	  ORDER BY (t.status='done'), (t.origin='thread:'||?1 OR t.origin IN (SELECT 'topic:'||id FROM topics WHERE thread_id=?1)) DESC, COALESCE(c.n,0) DESC, t.updated_at DESC LIMIT 1`, threadID).Scan(&id)
	if errors.Is(err, sql.ErrNoRows) {
		return "", nil
	}
	return id, err
}

// OpenTaskTitled is an open task of the session (it is an agent of) with that title (case, spaces and
// punctuation aside), or "".
func (s *Store) OpenTaskTitled(ctx context.Context, sessionID, title string) (string, error) {
	want := normTitle(title)
	if want == "" {
		return "", nil
	}
	ts, err := s.ListTasks(ctx, TaskQuery{SessionID: sessionID})
	if err != nil {
		return "", err
	}
	for _, t := range ts {
		if t.Status != TaskDone && normTitle(t.Title) == want {
			return t.ID, nil
		}
	}
	return "", nil
}

func normTitle(s string) string {
	var b strings.Builder
	for _, r := range strings.ToLower(s) {
		if unicode.IsLetter(r) || unicode.IsDigit(r) {
			b.WriteRune(r)
		}
	}
	return b.String()
}

// SimilarTitles: are two task titles about the same work? Equal, or one inside the other (letters and
// digits only, case aside), or most of their character pairs shared.
func SimilarTitles(a, b string) bool {
	x, y := normTitle(a), normTitle(b)
	if x == "" || y == "" {
		return false
	}
	if x == y {
		return true
	}
	rx, ry := []rune(x), []rune(y)
	if min(len(rx), len(ry)) >= 4 && (strings.Contains(x, y) || strings.Contains(y, x)) {
		return true
	}
	pairs := func(r []rune) map[string]int {
		m := map[string]int{}
		for i := 0; i+1 < len(r); i++ {
			m[string(r[i:i+2])]++
		}
		return m
	}
	px, py := pairs(rx), pairs(ry)
	shared, total := 0, 0
	for k, n := range px {
		shared += min(n, py[k])
		total += n
	}
	for _, n := range py {
		total += n
	}
	return total > 0 && float64(2*shared)/float64(total) >= 0.6
}

// SetTaskOrigin records where a task came from (topic:<id>, thread:<id>): what the migration does.
func (s *Store) SetTaskOrigin(ctx context.Context, taskID, origin string) error {
	return s.exec(ctx, `UPDATE tasks SET origin=? WHERE id=?`, origin, taskID)
}
