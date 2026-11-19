package server

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"regexp"
	"strings"

	"github.com/ryotarai/minbox/internal/store"
)

// agentEnv is the environment variables the person gives a new agent (POST /api/sessions "env",
// POST /api/v3/new "env"). It is stored with the session (store.Session.Env) and added to the
// agent's environment at every start, on this machine and on a remote host, on top of the inherited
// (cleaned) environment. The values may be secrets: they are never logged and no API returns them.
//
// JSON: an object {"KEY": "value"}, or a list of pairs: [{"key": "KEY", "value": "v"}] or
// [["KEY", "v"]]. A later pair of the same key wins.
type agentEnv map[string]string

func (e *agentEnv) UnmarshalJSON(b []byte) error {
	b = bytes.TrimSpace(b)
	if len(b) == 0 || string(b) == "null" {
		*e = nil
		return nil
	}
	out := agentEnv{}
	switch b[0] {
	case '{':
		var m map[string]string
		if err := json.Unmarshal(b, &m); err != nil {
			return errors.New("env: an object of strings, or a list of key/value pairs")
		}
		for k, v := range m {
			out[k] = v
		}
	case '[':
		var list []json.RawMessage
		if err := json.Unmarshal(b, &list); err != nil {
			return errors.New("env: an object of strings, or a list of key/value pairs")
		}
		for _, raw := range list {
			var pair struct {
				Key   *string `json:"key"`
				Value *string `json:"value"`
			}
			var arr []string
			switch {
			case json.Unmarshal(raw, &arr) == nil && len(arr) == 2:
				out[arr[0]] = arr[1]
			case json.Unmarshal(raw, &pair) == nil && pair.Key != nil:
				v := ""
				if pair.Value != nil {
					v = *pair.Value
				}
				out[*pair.Key] = v
			default:
				return errors.New(`env: each pair is {"key": ..., "value": ...} or ["KEY", "value"]`)
			}
		}
	default:
		return errors.New("env: an object of strings, or a list of key/value pairs")
	}
	*e = out
	return nil
}

var envKeyRe = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*$`)

// reservedEnv are the variables minbox sets itself for an agent: the person cannot set them.
// Every MINBOX_* variable is reserved too.
var reservedEnv = map[string]bool{
	"TERM":                    true,
	"COLORTERM":               true,
	"OPENCODE_CONFIG_CONTENT": true,
}

const (
	maxAgentEnvVars  = 200
	maxAgentEnvBytes = 64 << 10
)

// reservedEnvKey says whether minbox sets key itself.
func reservedEnvKey(key string) bool {
	return reservedEnv[key] || strings.HasPrefix(strings.ToUpper(key), "MINBOX_")
}

// validateAgentEnv refuses keys that are not variable names, minbox's own variables, values with a
// NUL byte and oversized sets. The error names keys only, never values.
func validateAgentEnv(env map[string]string) error {
	if len(env) > maxAgentEnvVars {
		return fmt.Errorf("env: at most %d variables", maxAgentEnvVars)
	}
	size := 0
	var reserved []string
	for _, k := range store.EnvKeys(env) {
		v := env[k]
		if !envKeyRe.MatchString(k) {
			return fmt.Errorf("env: %q is not a variable name (letters, digits and _, not starting with a digit)", k)
		}
		if reservedEnvKey(k) {
			reserved = append(reserved, k)
			continue
		}
		if strings.ContainsRune(v, 0) {
			return fmt.Errorf("env: the value of %s contains a NUL byte", k)
		}
		size += len(k) + len(v) + 1
	}
	if len(reserved) > 0 {
		return fmt.Errorf("env: %s cannot be set: minbox sets MINBOX_*, TERM, COLORTERM and OPENCODE_CONFIG_CONTENT itself", strings.Join(reserved, ", "))
	}
	if size > maxAgentEnvBytes {
		return fmt.Errorf("env: at most %d KB in all", maxAgentEnvBytes>>10)
	}
	return nil
}

// envPairs is env as KEY=value entries (sorted by key), without reserved keys (stored ones from
// before a rule change are skipped rather than allowed to override minbox's own).
func envPairs(env map[string]string) []string {
	out := make([]string, 0, len(env))
	for _, k := range store.EnvKeys(env) {
		if !envKeyRe.MatchString(k) || reservedEnvKey(k) {
			continue
		}
		out = append(out, k+"="+env[k])
	}
	return out
}

// envID names the variables a start of sess gets (envPairs), for telling later whether they changed
// since (stale.go, "env"). Salted with the session's token so that the stored hash says nothing about
// the values; never empty ("" means "not recorded").
func envID(sess *store.Session) string {
	h := sha256.New()
	h.Write([]byte(sess.Token))
	for _, kv := range envPairs(sess.Env) {
		h.Write([]byte{0})
		h.Write([]byte(kv))
	}
	return "e" + hex.EncodeToString(h.Sum(nil))[:16]
}

// patchSessionEnv changes an agent's environment variables (PATCH /api/sessions/{id}/env; the
// browser only: a paired device, never an agent's token). The values never travel back to the
// browser, so the change names only what changes:
//
//	{"set": {"KEY": "value"}, "unset": ["KEY"]}
//
// set adds or replaces, unset removes, and every other stored variable keeps its value. The same
// rules as at creation (validateAgentEnv). They take effect at the agent's next start (a restart, a
// resume, the companion shell's next start); a running agent shows as stale ("env") until then.
// The answer has the keys only. Values are never logged.
func (s *Server) patchSessionEnv(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Set   agentEnv `json:"set"`
		Unset []string `json:"unset"`
	}
	if !decode(w, r, &req) {
		return
	}
	for _, k := range req.Unset {
		if _, both := req.Set[k]; both {
			httpError(w, 400, fmt.Sprintf("env: %s is both set and unset", k))
			return
		}
	}
	if err := validateAgentEnv(req.Set); err != nil {
		httpError(w, 400, err.Error())
		return
	}
	s.envMu.Lock()
	defer s.envMu.Unlock()
	ctx := r.Context()
	sess, err := s.store.GetSession(ctx, r.PathValue("id"))
	if err != nil {
		storeError(w, err)
		return
	}
	if sess.Kind == store.KindShell {
		httpError(w, 400, "a shell has no environment variables of its own")
		return
	}
	env := map[string]string{}
	for k, v := range sess.Env {
		// A stored key the rules refuse (an older rule) is never applied (envPairs): drop it.
		if envKeyRe.MatchString(k) && !reservedEnvKey(k) {
			env[k] = v
		}
	}
	for _, k := range req.Unset {
		delete(env, k)
	}
	for k, v := range req.Set {
		env[k] = v
	}
	if err := validateAgentEnv(env); err != nil {
		httpError(w, 400, err.Error())
		return
	}
	if err := s.store.SetSessionEnv(ctx, sess.ID, env); err != nil {
		storeError(w, err)
		return
	}
	s.hub.publish(Event{Type: "sessions"})
	writeJSON(w, 200, map[string]any{"ok": true, "env_keys": store.EnvKeys(env)})
}
