package server

import (
	"net/http"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/ryotarai/minbox/internal/store"
)

// Denied commands: shell commands the agent tried to run and could not, because they were denied
// (a permission rule, the person rejecting the prompt, the mode, a hook or plugin blocking it). The
// agent's integration reports each one as it happens (the Claude Code mod, Pi's extension, OpenCode's
// plugin: POST /api/agent/denied-commands), and the reply area offers the latest one as
// "Run yourself: !command" (GET /api/threads/{id}/suggestions, field command). Nothing is guessed
// from message text. Kept in memory: a restart forgets them. See docs/thread-commands.md.

const (
	deniedPerSession  = 20  // kept per session, oldest dropped
	deniedMaxRunes    = 500 // a longer command is not offered
	deniedReasonRunes = 300
)

type deniedCommand struct {
	SessionID string
	// ThreadID is the thread whose turn it was; "" when the integration did not know: the session's
	// next agent message (send_message) gives it its thread.
	ThreadID string
	Command  string
	Reason   string
	At       time.Time
}

type deniedStore struct {
	mu        sync.Mutex
	bySession map[string][]deniedCommand // oldest first
}

func newDeniedStore() *deniedStore { return &deniedStore{bySession: map[string][]deniedCommand{}} }

// normCommand is the command as compared and offered: trimmed, a leading "!" or "$ " dropped.
func normCommand(cmd string) string {
	cmd = strings.TrimSpace(cmd)
	cmd = strings.TrimSpace(strings.TrimPrefix(cmd, "!"))
	cmd = strings.TrimSpace(strings.TrimPrefix(cmd, "$ "))
	return cmd
}

// add records a denial; the same command denied again in the session replaces the earlier entry.
func (d *deniedStore) add(c deniedCommand) {
	c.Command = normCommand(c.Command)
	if c.Command == "" {
		return
	}
	d.mu.Lock()
	defer d.mu.Unlock()
	list := d.bySession[c.SessionID]
	kept := list[:0:0]
	for _, x := range list {
		if x.Command != c.Command {
			kept = append(kept, x)
		}
	}
	kept = append(kept, c)
	if len(kept) > deniedPerSession {
		kept = kept[len(kept)-deniedPerSession:]
	}
	d.bySession[c.SessionID] = kept
}

// assign gives the session's denials that have no thread yet to threadID.
func (d *deniedStore) assign(sessionID, threadID string) {
	d.mu.Lock()
	defer d.mu.Unlock()
	for i := range d.bySession[sessionID] {
		if d.bySession[sessionID][i].ThreadID == "" {
			d.bySession[sessionID][i].ThreadID = threadID
		}
	}
}

// remove drops the session's denials that match (all of them when match is nil); reports whether any went.
func (d *deniedStore) remove(sessionID string, match func(deniedCommand) bool) bool {
	d.mu.Lock()
	defer d.mu.Unlock()
	list := d.bySession[sessionID]
	kept := list[:0:0]
	for _, x := range list {
		if match == nil || !match(x) {
			kept = append(kept, x)
		}
	}
	if len(kept) == 0 {
		delete(d.bySession, sessionID)
	} else {
		d.bySession[sessionID] = kept
	}
	return len(kept) != len(list)
}

// resolve: the command ran after all (the person ran it with "!", or the agent ran it later).
func (d *deniedStore) resolve(sessionID, command string) bool {
	command = normCommand(command)
	return d.remove(sessionID, func(x deniedCommand) bool { return x.Command == command })
}

// dismiss: the person dismissed the thread's command.
func (d *deniedStore) dismiss(sessionID, threadID string) bool {
	return d.remove(sessionID, func(x deniedCommand) bool { return x.ThreadID == threadID })
}

// latest is the thread's newest unresolved denial.
func (d *deniedStore) latest(threadID string) (deniedCommand, bool) {
	d.mu.Lock()
	defer d.mu.Unlock()
	var best deniedCommand
	found := false
	for _, list := range d.bySession {
		for _, x := range list {
			if x.ThreadID == threadID && (!found || !x.At.Before(best.At)) {
				best, found = x, true
			}
		}
	}
	return best, found
}

// offer is the thread's latest denied command as "!command" for the composer, or "": a command that
// spans lines or is very long is not offered (a "!" reply runs one line).
func (d *deniedStore) offer(threadID string) string {
	c, ok := d.latest(threadID)
	if !ok || strings.ContainsAny(c.Command, "\r\n") || utf8.RuneCountInString(c.Command) > deniedMaxRunes {
		return ""
	}
	return "!" + c.Command
}

// POST /api/agent/denied-commands {command, reason?, thread_id?, at?}: a shell command the agent
// tried and was denied.
func (s *Server) agentDeniedCommand(w http.ResponseWriter, r *http.Request, sess *store.Session) {
	var req struct {
		Command  string `json:"command"`
		Reason   string `json:"reason"`
		ThreadID string `json:"thread_id"`
		At       string `json:"at"`
	}
	if !decode(w, r, &req) {
		return
	}
	cmd := normCommand(req.Command)
	if cmd == "" {
		httpError(w, 400, "command is required")
		return
	}
	threadID := ""
	if req.ThreadID != "" {
		// Only a thread of this session; another (or an unknown id) waits for the next message.
		if th, err := s.store.GetThread(r.Context(), req.ThreadID); err == nil && th.SessionID == sess.ID {
			threadID = th.ID
		}
	}
	at := s.nowFn()
	if t, err := time.Parse(time.RFC3339Nano, req.At); err == nil && !t.After(at) {
		at = t
	}
	s.denied.add(deniedCommand{SessionID: sess.ID, ThreadID: threadID, Command: cmd, Reason: truncRunes(strings.TrimSpace(req.Reason), deniedReasonRunes), At: at})
	s.modLog(sess.ID, "denied-command", "thread=%q (%d characters)", threadID, utf8.RuneCountInString(cmd))
	if threadID != "" {
		s.publishThread(sess.ID, threadID)
	}
	writeJSON(w, 200, map[string]any{"ok": true, "thread_id": threadID})
}

// POST /api/agent/denied-commands/ran {command}: the agent ran a command it was denied earlier.
func (s *Server) agentRanCommand(w http.ResponseWriter, r *http.Request, sess *store.Session) {
	var req struct {
		Command string `json:"command"`
	}
	if !decode(w, r, &req) {
		return
	}
	writeJSON(w, 200, map[string]any{"ok": true, "cleared": s.denied.resolve(sess.ID, req.Command)})
}

// DELETE /api/threads/{id}/denied-command: the person dismissed the "Run yourself" command.
func (s *Server) dismissDeniedCommand(w http.ResponseWriter, r *http.Request) {
	th, err := s.store.GetThread(r.Context(), r.PathValue("id"))
	if err != nil {
		storeError(w, err)
		return
	}
	writeJSON(w, 200, map[string]any{"ok": true, "cleared": s.denied.dismiss(th.SessionID, th.ID)})
}
