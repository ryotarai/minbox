package termhost

import (
	"testing"
	"time"
)

func TestKillIsQuick(t *testing.T) {
	h := New()
	if _, err := h.Spawn(SpawnRequest{ID: "p", Argv: []string{"python3", "-c", "import sys,threading,time\nthreading.Thread(target=lambda: time.sleep(100), daemon=True).start()\nfor l in sys.stdin: pass"}, Cwd: "/", Env: []string{"PATH=/opt/homebrew/bin:/usr/bin:/bin"}}); err != nil {
		t.Fatal(err)
	}
	time.Sleep(300 * time.Millisecond)
	start := time.Now()
	if err := h.Kill("p"); err != nil {
		t.Fatal(err)
	}
	if d := time.Since(start); d > time.Second {
		t.Fatalf("kill took %v", d)
	}
}
