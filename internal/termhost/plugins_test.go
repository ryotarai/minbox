package termhost

import (
	"encoding/json"
	"net/http/httptest"
	"testing"
)

// /version names the host's minbox plugins, so the server can tell whether a restart of an agent
// there would load another one.
func TestVersionReportsPlugins(t *testing.T) {
	h := New()
	h.PluginDir, h.PiExtension = "/d/plugin/abc", "/d/pi/def/pi/minbox.ts"
	rec := httptest.NewRecorder()
	h.Handler().ServeHTTP(rec, httptest.NewRequest("GET", "/version", nil))
	var v VersionInfo
	if err := json.Unmarshal(rec.Body.Bytes(), &v); err != nil {
		t.Fatalf("%d %s", rec.Code, rec.Body)
	}
	if v.Plugins["claude"] != PluginID("/d/plugin/abc") || v.Plugins["pi"] != PluginID("/d/pi/def/pi/minbox.ts") || v.Plugins["opencode"] != "" {
		t.Fatalf("plugins = %v", v.Plugins)
	}
	if PluginID("/d/plugin/abc") == PluginID("/d/plugin/abd") || PluginID("") != "" {
		t.Fatal("PluginID")
	}
}
