package termhost

import "strings"

// inheritedMarkers are variables minbox's own environment may carry that
// would mislead the Claude Code it starts:
//   - those a parent Claude Code sets for its child processes (when minbox
//     itself was started from one): with CLAUDE_CODE_CHILD_SESSION, Claude
//     Code stops saving the transcript, and --resume finds nothing;
//   - those of the terminal minbox was started in: the PTY is not that terminal.
var inheritedMarkers = map[string]bool{
	"CLAUDECODE":                   true,
	"CLAUDE_CODE_ENTRYPOINT":       true,
	"CLAUDE_CODE_CHILD_SESSION":    true,
	"CLAUDE_CODE_EXECPATH":         true,
	"CLAUDE_CODE_MESSAGING_SOCKET": true,
	"CLAUDE_CODE_MESSAGING_TOKEN":  true,
	"CLAUDE_CODE_SESSION_ATTENDED": true,
	"CLAUDE_CODE_SESSION_ID":       true,
	"CLAUDE_CODE_SSE_PORT":         true,
	"CLAUDE_EFFORT":                true,
	"CLAUDE_PID":                   true,
	"TERM":                         true,
	"COLORTERM":                    true,
	"TERM_PROGRAM":                 true,
	"TERM_PROGRAM_VERSION":         true,
	"TERM_SESSION_ID":              true,
	"LC_TERMINAL":                  true,
	"LC_TERMINAL_VERSION":          true,
	"ITERM_SESSION_ID":             true,
	"ITERM_PROFILE":                true,
	"REX_BLOCK":                    true,
	"REX_SESSION":                  true,
}

var inheritedPrefixes = []string{"MINBOX_", "KITTY_", "GHOSTTY_", "WEZTERM_", "VSCODE_", "ALACRITTY_"}

func inherited(key string) bool {
	if inheritedMarkers[key] {
		return true
	}
	for _, p := range inheritedPrefixes {
		if strings.HasPrefix(key, p) {
			return true
		}
	}
	return false
}

// CleanEnv is environ without the variables of the parent Claude Code and
// of the terminal minbox (or the host) was started from.
func CleanEnv(environ []string) []string {
	var env []string
	for _, kv := range environ {
		k, _, _ := strings.Cut(kv, "=")
		if inherited(k) {
			continue
		}
		env = append(env, kv)
	}
	return env
}
