package termhost

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"os/exec"
	"strings"
	"time"
)

// AgentsProtocol is the lowest host protocol that runs Pi and OpenCode sessions: it fills in its own
// copies of the Pi extension and the OpenCode plugin (the placeholders below), runs short commands
// for the server (POST /exec: `opencode api …`, version probes) and finds executables on its PATH
// (POST /lookpath).
const AgentsProtocol = 5

// Placeholders for the Pi extension and the OpenCode plugin in a remote host's spawn (and exec)
// requests; the host replaces them with the files it extracted from its own binary.
const (
	PiExtensionPlaceholder    = "{{MINBOX_PI_EXTENSION}}"
	PiSubagentPlaceholder     = "{{MINBOX_PI_SUBAGENT}}"
	OpenCodePluginPlaceholder = "{{MINBOX_OPENCODE_PLUGIN}}"
)

// ExecRequest asks the host to run a short command (not in a PTY) and answer its output.
type ExecRequest struct {
	Argv []string `json:"argv"`
	Dir  string   `json:"dir,omitempty"`
	// Env is added to the host's own (cleaned) environment, as for a spawn with InheritEnv.
	Env   []string `json:"env,omitempty"`
	Stdin string   `json:"stdin,omitempty"`
	// TimeoutMs bounds the run (default 30 s, at most 10 min).
	TimeoutMs int `json:"timeout_ms,omitempty"`
}

// ExecResult is what the command did. A command that could not start has Error set (NotFound when
// its executable is not on the host's PATH); one that ran has ExitCode.
type ExecResult struct {
	ExitCode int    `json:"exit_code"`
	Stdout   []byte `json:"stdout"`
	Stderr   string `json:"stderr"`
	Error    string `json:"error,omitempty"`
	NotFound bool   `json:"not_found,omitempty"`
	TimedOut bool   `json:"timed_out,omitempty"`
}

// execOutputLimit caps what an exec answers per stream.
const execOutputLimit = 4 << 20

type capped struct {
	bytes.Buffer
	limit int
}

func (c *capped) Write(p []byte) (int, error) {
	if room := c.limit - c.Len(); room > 0 {
		if len(p) > room {
			c.Buffer.Write(p[:room])
		} else {
			c.Buffer.Write(p)
		}
	}
	return len(p), nil
}

// replacer fills in the host's own paths.
func (h *Host) replacer() *strings.Replacer {
	return strings.NewReplacer(
		PluginDirPlaceholder, h.PluginDir,
		ServerFilePlaceholder, h.ServerFile,
		PiExtensionPlaceholder, h.PiExtension,
		PiSubagentPlaceholder, h.PiSubagent,
		OpenCodePluginPlaceholder, h.OpenCodePlugin,
	)
}

// jsonReplacer fills in the same paths inside a JSON string (OPENCODE_CONFIG_CONTENT).
func (h *Host) jsonReplacer() *strings.Replacer {
	q := func(s string) string {
		b, _ := json.Marshal(s)
		return string(b[1 : len(b)-1])
	}
	return strings.NewReplacer(
		PluginDirPlaceholder, q(h.PluginDir),
		ServerFilePlaceholder, q(h.ServerFile),
		PiExtensionPlaceholder, q(h.PiExtension),
		PiSubagentPlaceholder, q(h.PiSubagent),
		OpenCodePluginPlaceholder, q(h.OpenCodePlugin),
	)
}

// openCodeConfigKey is OpenCode's inline configuration variable: the server puts its plugin entry
// there, and the host merges it into one its own environment already sets.
const openCodeConfigKey = "OPENCODE_CONFIG_CONTENT"

// substEnv fills in the placeholders of the request's variables. With base (the host's inherited
// environment) an OPENCODE_CONFIG_CONTENT of the request is merged into the host's own one.
func (h *Host) substEnv(base, env []string) []string {
	sub, jsub := h.replacer(), h.jsonReplacer()
	out := make([]string, 0, len(env))
	for _, kv := range env {
		k, v, _ := strings.Cut(kv, "=")
		if k == openCodeConfigKey {
			v = mergeOpenCodeConfig(envLookup(base, k), jsub.Replace(v))
			out = append(out, k+"="+v)
			continue
		}
		out = append(out, sub.Replace(kv))
	}
	return out
}

func envLookup(env []string, key string) string {
	v := ""
	for _, kv := range env {
		if k, val, ok := strings.Cut(kv, "="); ok && k == key {
			v = val
		}
	}
	return v
}

// mergeOpenCodeConfig adds the "plugins" of ours to the host's own OPENCODE_CONFIG_CONTENT (plain
// JSON); our other keys win. One that is not plain JSON is replaced, as on the server's machine.
func mergeOpenCodeConfig(existing, ours string) string {
	if strings.TrimSpace(existing) == "" {
		return ours
	}
	var base, add map[string]any
	if json.Unmarshal([]byte(existing), &base) != nil || base == nil || json.Unmarshal([]byte(ours), &add) != nil || add == nil {
		return ours
	}
	for k, v := range add {
		if k == "plugins" {
			have, _ := base["plugins"].([]any)
			more, _ := v.([]any)
			base["plugins"] = append(have, more...)
			continue
		}
		base[k] = v
	}
	b, err := json.Marshal(base)
	if err != nil {
		return ours
	}
	return string(b)
}

// Exec runs a short command on this machine with the host's environment.
func (h *Host) Exec(ctx context.Context, req ExecRequest) ExecResult {
	if len(req.Argv) == 0 {
		return ExecResult{ExitCode: -1, Error: "argv is required"}
	}
	timeout := 30 * time.Second
	if req.TimeoutMs > 0 {
		timeout = time.Duration(req.TimeoutMs) * time.Millisecond
	}
	if timeout > 10*time.Minute {
		timeout = 10 * time.Minute
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	sub := h.replacer()
	argv := make([]string, len(req.Argv))
	for i, a := range req.Argv {
		argv[i] = sub.Replace(a)
	}
	base := CleanEnv(os.Environ())
	env := append(append([]string{}, base...), h.substEnv(base, req.Env)...)
	path, err := lookPathIn(argv[0], env)
	if err != nil {
		return ExecResult{ExitCode: -1, Error: err.Error(), NotFound: true}
	}
	cmd := exec.CommandContext(ctx, path, argv[1:]...)
	cmd.Dir = req.Dir
	cmd.Env = env
	cmd.Stdin = strings.NewReader(req.Stdin)
	out, errb := &capped{limit: execOutputLimit}, &capped{limit: execOutputLimit}
	cmd.Stdout, cmd.Stderr = out, errb
	cmd.WaitDelay = 2 * time.Second
	err = cmd.Run()
	res := ExecResult{Stdout: out.Bytes(), Stderr: errb.String()}
	if ctx.Err() == context.DeadlineExceeded {
		res.TimedOut = true
	}
	if err != nil {
		var ee *exec.ExitError
		if errors.As(err, &ee) {
			res.ExitCode = ee.ExitCode()
		} else {
			res.ExitCode = -1
			res.Error = err.Error()
		}
	}
	return res
}

// lookPathIn finds name like exec.LookPath, but on the PATH of env (the host's environment).
func lookPathIn(name string, env []string) (string, error) {
	if strings.Contains(name, "/") {
		return exec.LookPath(name)
	}
	path := envLookup(env, "PATH")
	for _, dir := range strings.Split(path, ":") {
		if dir == "" {
			dir = "."
		}
		p := dir + "/" + name
		if st, err := os.Stat(p); err == nil && !st.IsDir() && st.Mode()&0o111 != 0 {
			return p, nil
		}
	}
	return "", &exec.Error{Name: name, Err: exec.ErrNotFound}
}

// LookPath finds executables on the host's PATH: the path of each name found ("" when not).
func (h *Host) LookPath(names []string) map[string]string {
	env := CleanEnv(os.Environ())
	out := map[string]string{}
	for _, n := range names {
		if p, err := lookPathIn(n, env); err == nil {
			out[n] = p
		} else {
			out[n] = ""
		}
	}
	return out
}

func (h *Host) execRoute(w http.ResponseWriter, r *http.Request) {
	var req ExecRequest
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 8<<20)).Decode(&req); err != nil {
		httpError(w, 400, err.Error())
		return
	}
	writeJSON(w, 200, h.Exec(r.Context(), req))
}

func (h *Host) lookPathRoute(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Names []string `json:"names"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<16)).Decode(&req); err != nil {
		httpError(w, 400, err.Error())
		return
	}
	writeJSON(w, 200, map[string]any{"paths": h.LookPath(req.Names)})
}

// Exec runs a short command on the host (protocol AgentsProtocol or later).
func (c *Client) Exec(ctx context.Context, req ExecRequest) (ExecResult, error) {
	var out ExecResult
	err := c.do(ctx, "POST", "/exec", req, &out)
	return out, err
}

// LookPath finds executables on the host's PATH (protocol AgentsProtocol or later).
func (c *Client) LookPath(ctx context.Context, names []string) (map[string]string, error) {
	var out struct {
		Paths map[string]string `json:"paths"`
	}
	err := c.do(ctx, "POST", "/lookpath", map[string]any{"names": names}, &out)
	return out.Paths, err
}
