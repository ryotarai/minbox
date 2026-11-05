// Package notify sends a notification to the places the person wants to hear about a new
// message in a thread: one destination type (Slack incoming webhook first), a registry of
// types, and a dispatcher that sends asynchronously with retries.
package notify

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/ryotarai/minbox/internal/store"
)

// Notification is what a destination is told about.
type Notification struct {
	Project   string // project name ("" when none)
	Session   string // session name
	Title     string // thread subject
	ThreadID  string
	MessageID string
	From      string // who wrote it: the agent's name
	Body      string // Markdown
	Status    string // the thread's status, when it has one
	// NeedsAction: the message has open questions.
	NeedsAction bool
	// Link opens the thread ("" when no public URL is set).
	Link string
	// Test marks the sample notification of "Send test".
	Test bool
}

// Notifier sends notifications to one configured destination.
type Notifier interface {
	Send(ctx context.Context, n Notification) error
}

// Field describes one config field of a destination type; the UI builds its form from it.
type Field struct {
	Key         string   `json:"key"`
	Label       string   `json:"label"`
	Kind        string   `json:"kind"` // text | secret | bool | select
	Required    bool     `json:"required,omitempty"`
	Default     any      `json:"default,omitempty"`
	Placeholder string   `json:"placeholder,omitempty"`
	Hint        string   `json:"hint,omitempty"`
	Options     []Option `json:"options,omitempty"`

	validate func(string) error
}

// Option is one choice of a select field.
type Option struct {
	Value string `json:"value"`
	Label string `json:"label"`
}

// Type is a kind of destination.
type Type struct {
	ID     string  `json:"id"`
	Label  string  `json:"label"`
	Fields []Field `json:"fields"`
	// Help is a short text shown under the form (setup steps); lines are separated by \n.
	Help string `json:"help,omitempty"`

	new func(cfg map[string]any, c *http.Client, env Env) (Notifier, error)
}

// Env is what a notifier may need besides its config: the store (for state such as the Slack
// thread of a minbox thread) and the destination's id.
type Env struct {
	Store  *store.Store
	DestID string
}

// Tester is implemented by notifiers that do more than Send on "Send test": it verifies the
// credentials and returns a short description of what it connected to.
type Tester interface {
	Test(ctx context.Context, n Notification) (info string, err error)
}

// Events filter values (the "events" field of every type).
const (
	EventsAll    = "all"
	EventsAction = "action"
)

var types = []Type{slackType, slackAppType}

// Types lists the destination types.
func Types() []Type { return types }

// Lookup finds a destination type.
func Lookup(id string) (*Type, bool) {
	for i := range types {
		if types[i].ID == id {
			return &types[i], true
		}
	}
	return nil, false
}

// Notifier builds the sender for a stored config.
func (t *Type) Notifier(cfg map[string]any, c *http.Client, env Env) (Notifier, error) {
	if c == nil {
		c = http.DefaultClient
	}
	return t.new(cfg, c, env)
}

// MaskSecret shows where a secret URL points and its last 4 characters, never more.
func MaskSecret(s string) string {
	if s == "" {
		return ""
	}
	tail := s
	if len(tail) > 4 {
		tail = tail[len(tail)-4:]
	}
	// A Slack token keeps its kind: xoxb-…abcd.
	if strings.HasPrefix(s, "xox") {
		if i := strings.IndexByte(s, '-'); i > 0 && i <= 5 {
			return s[:i+1] + "…" + tail
		}
	}
	if u, err := url.Parse(s); err == nil && u.Scheme != "" && u.Host != "" {
		return u.Scheme + "://" + u.Host + "/…" + tail
	}
	return "…" + tail
}

// Normalize validates a config the person sent and merges it onto the stored one: unknown keys
// are dropped, defaults fill gaps, and a secret left out (or sent back masked) keeps its stored
// value. old is nil when the destination is new.
func (t *Type) Normalize(old, in map[string]any) (map[string]any, error) {
	out := map[string]any{}
	for _, f := range t.Fields {
		v, has := in[f.Key]
		oldV, hadOld := old[f.Key]
		switch f.Kind {
		case "bool":
			switch {
			case has:
				b, ok := v.(bool)
				if !ok {
					return nil, fmt.Errorf("%s must be true or false", f.Label)
				}
				out[f.Key] = b
			case hadOld:
				out[f.Key] = oldV
			default:
				out[f.Key], _ = f.Default.(bool)
			}
		case "select":
			s, _ := v.(string)
			if !has {
				s, _ = oldV.(string)
				if !hadOld {
					s, _ = f.Default.(string)
				}
			}
			ok := false
			for _, o := range f.Options {
				ok = ok || o.Value == s
			}
			if !ok {
				return nil, fmt.Errorf("%s: unknown choice %q", f.Label, s)
			}
			out[f.Key] = s
		default: // text, secret
			s, _ := v.(string)
			s = strings.TrimSpace(s)
			oldS, _ := oldV.(string)
			switch {
			case f.Kind == "secret" && (s == "" || s == MaskSecret(oldS)):
				s = oldS
			case !has && !hadOld:
				s, _ = f.Default.(string)
			case !has:
				s = oldS
			}
			if s == "" && f.Required {
				return nil, fmt.Errorf("%s is required", f.Label)
			}
			if s != "" && f.validate != nil {
				if err := f.validate(s); err != nil {
					return nil, fmt.Errorf("%s: %w", f.Label, err)
				}
			}
			out[f.Key] = s
		}
	}
	return out, nil
}

// Public is the config as the API shows it: secrets masked.
func (t *Type) Public(cfg map[string]any) map[string]any {
	out := map[string]any{}
	for _, f := range t.Fields {
		v, ok := cfg[f.Key]
		if !ok {
			continue
		}
		if f.Kind == "secret" {
			s, _ := v.(string)
			out[f.Key] = MaskSecret(s)
			continue
		}
		out[f.Key] = v
	}
	return out
}

// Wants reports whether a destination with this config wants the notification.
func Wants(cfg map[string]any, n Notification) bool {
	if n.Test {
		return true
	}
	if ev, _ := cfg["events"].(string); ev == EventsAction {
		return n.NeedsAction
	}
	return true
}

// SendError is a failed send: Retry says whether trying again can help.
type SendError struct {
	Msg        string
	Status     int
	RetryAfter time.Duration
	Retry      bool
	code       string // Slack's error code, when there was one
}

func (e *SendError) Error() string { return e.Msg }

func isRetryable(err error) (bool, time.Duration) {
	var se *SendError
	if errors.As(err, &se) {
		return se.Retry, se.RetryAfter
	}
	return false, 0
}

// withoutURL drops the request URL (a secret) from a transport error.
func withoutURL(err error) error {
	var ue *url.Error
	if errors.As(err, &ue) {
		return ue.Err
	}
	return err
}
