package agent

import (
	"context"
	"fmt"
	"strconv"
	"strings"
	"time"
)

// Agents on another machine (a remote host). The server cannot look at that machine's PATH itself:
// the host finds executables (LookPathFunc) and runs short commands (Runner) for it. What is checked:
//
//   - Claude Code: its executable is on the host's PATH (it is not run).
//   - Pi: its executable is on the host's PATH, and `node --version` there is 22.19 or later (Pi 1.x
//     is a Node program and needs it; Pi itself is not run).
//   - OpenCode: `opencode --version` there is 2.x, as on the server's machine.

// LookPathFunc finds executables on a machine's PATH: the path of each name, "" when not found.
type LookPathFunc func(ctx context.Context, names []string) (map[string]string, error)

// PiNodeMin is the lowest Node.js version Pi 1.x runs on.
var PiNodeMin = [3]int{22, 19, 0}

// JudgeNodeForPi reads `node --version` output ("v22.19.0") and says whether Pi can run on it.
func JudgeNodeForPi(out string) (version string, ok bool, reason string) {
	m := versionRe.FindStringSubmatch(out)
	if m == nil {
		return "", false, fmt.Sprintf("could not read the Node.js version from %q (Pi needs Node %d.%d+)", truncate(strings.TrimSpace(out), 80), PiNodeMin[0], PiNodeMin[1])
	}
	var v [3]int
	for i := range v {
		v[i], _ = strconv.Atoi(m[i+1])
	}
	for i := range v {
		if v[i] != PiNodeMin[i] {
			if v[i] < PiNodeMin[i] {
				return m[0], false, fmt.Sprintf("Node.js %s is too old: Pi needs Node %d.%d or later", m[0], PiNodeMin[0], PiNodeMin[1])
			}
			break
		}
	}
	return m[0], true, ""
}

// JudgeOpenCodeVersion reads `opencode --version` output: the version, whether minbox runs it (2.x),
// and why not.
func JudgeOpenCodeVersion(out string) (version string, ok bool, reason string) {
	return judgeOpenCodeVersion(out)
}

// ProbeTimeout bounds one version probe on a host.
var ProbeTimeout = 20 * time.Second

// ProbeHost describes every agent on another machine, in Kinds order, from what its host finds
// (look) and runs (run) there. Node is looked up next to the commands; nothing reads the server's PATH.
func ProbeHost(ctx context.Context, cmds Commands, look LookPathFunc, run Runner) []Info {
	names := []string{"node"}
	for _, k := range Kinds {
		if c := cmds[k]; len(c) > 0 {
			names = append(names, c[0])
		}
	}
	paths, lookErr := look(ctx, names)
	var out []Info
	for _, k := range Kinds {
		a := Must(k)
		info := Info{Kind: k, Label: a.Label(), Command: strings.Join(cmds[k], " "), Caps: a.Caps()}
		if lookErr != nil {
			info.Reason = fmt.Sprintf("could not ask the host (%v)", lookErr)
			out = append(out, info)
			continue
		}
		c := cmds[k]
		if len(c) == 0 || paths[c[0]] == "" {
			info.Reason = "not installed"
			out = append(out, info)
			continue
		}
		info.Installed, info.Path = true, paths[c[0]]
		switch k {
		case Claude:
			info.Supported = true
		case Pi:
			if paths["node"] == "" {
				info.Reason = fmt.Sprintf("Node.js is not on the host's PATH (Pi needs Node %d.%d+)", PiNodeMin[0], PiNodeMin[1])
				break
			}
			pctx, cancel := context.WithTimeout(ctx, ProbeTimeout)
			b, err := run(pctx, []string{paths["node"], "--version"}, "", nil, "")
			cancel()
			if err != nil {
				info.Reason = fmt.Sprintf("`node --version` failed on the host (%v)", err)
				break
			}
			var node string
			node, info.Supported, info.Reason = JudgeNodeForPi(string(b))
			info.Version = "node " + node
		case OpenCode:
			argv := append([]string{info.Path}, OpenCodeBase(c)[1:]...)
			pctx, cancel := context.WithTimeout(ctx, ProbeTimeout)
			b, err := run(pctx, append(argv, "--version"), "", nil, "")
			cancel()
			if err != nil {
				info.Reason = fmt.Sprintf("`%s --version` failed on the host (%v)", strings.Join(argv, " "), err)
				break
			}
			info.Version, info.Supported, info.Reason = judgeOpenCodeVersion(strings.TrimSpace(string(b)))
		}
		out = append(out, info)
	}
	return out
}

// UsableIn reports whether the agent of kind is installed and supported in infos.
func UsableIn(infos []Info, kind string) bool {
	for _, i := range infos {
		if i.Kind == kind {
			return i.Installed && i.Supported
		}
	}
	return false
}

// ChooseIn is Commands.Choose over a list of infos (another machine's agents).
func ChooseIn(infos []Info, preferred string) string {
	if Valid(preferred) && UsableIn(infos, preferred) {
		return preferred
	}
	for _, k := range Kinds {
		if UsableIn(infos, k) {
			return k
		}
	}
	if Valid(preferred) {
		return preferred
	}
	return Claude
}
