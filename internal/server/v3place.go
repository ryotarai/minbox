package server

import (
	"context"
	"strings"

	"github.com/ryotarai/minbox/internal/store"
)

// Every message belongs to exactly one task (docs/v3/redesign.md §4.5). The agent places its messages and the
// person's (send_message task_id, create_task / update_task message_ids); minbox never picks a task for
// it, and does not ask it after a turn to place what it left in no task.

// withTurns adds to message ids the person's messages that an agent reply among them answered and
// that are in no task yet: putting a reply in a task puts its turn there too.
func (s *Server) withTurns(ctx context.Context, ids []string) []string {
	out := append([]string{}, ids...)
	for _, id := range ids {
		m, err := s.store.GetMessage(ctx, id)
		if err != nil || m.Author != store.AuthorAgent || len(m.TurnOf) == 0 {
			continue
		}
		untagged, _ := s.untaggedOf(ctx, m.TurnOf)
		for _, u := range untagged {
			out = appendNew(out, u)
		}
	}
	return out
}

// unplacedNote is what send_message answers when the message went in no task.
func unplacedNote(ids []string) string {
	return "This message is in no task yet, nor are the person's messages it answers (" + strings.Join(ids, ", ") + "). Every message must be about a task: put them in one now with update_task (task_id, message_ids) or create_task (message_ids; status done for a quick exchange that is over), and pass task_id on your next send_message."
}
