package termhost

import (
	"context"
	"fmt"
	"os"
	"os/signal"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/creack/pty"
)

// TestMain doubles as the app in winchRig: with MINBOX_TEST_WINCH set, the test binary
// prints its terminal size on every SIGWINCH.
func TestMain(m *testing.M) {
	if os.Getenv("MINBOX_TEST_WINCH") == "1" {
		ch := make(chan os.Signal, 16)
		signal.Notify(ch, syscall.SIGWINCH)
		fmt.Print("READY\r\n")
		for range ch {
			if rows, cols, err := pty.Getsize(os.Stdin); err == nil {
				fmt.Printf("WINCH %d %d\r\n", rows, cols)
			}
		}
	}
	os.Exit(m.Run())
}

func TestModesFollowSplitSequencesAndRestoreThem(t *testing.T) {
	m := newModes()
	in := "hello\x1b[?1049h\x1b[?1000;1006h\x1b[?2004h\x1b[>1u\x1b[=3;2u\x1b[?25l\x1b[2J\x1b[?1000l\x1b[?1002h"
	// Fed one byte at a time: a sequence split across reads is still seen.
	for i := 0; i < len(in); i++ {
		m.feed([]byte{in[i]})
	}
	if got := m.replayPrefix(int64(len("hello")) + 1); got != "\x1b[?1049h" {
		t.Fatalf("prefix after the entry was cut = %q", got)
	}
	if got := m.replayPrefix(int64(len("hello"))); got != "" {
		t.Fatalf("prefix with the entry kept = %q", got)
	}
	want := "\x1b[?25l\x1b[?1000l\x1b[?1002h\x1b[?1006h\x1b[?2004h\x1b[<99u\x1b[>3u"
	if got := m.replaySuffix(); got != want {
		t.Fatalf("suffix = %q, want %q", got, want)
	}
	// Leaving the alternate screen, popping the flags, and a reset.
	m.feed([]byte("\x1b[?1049l\x1b[<u"))
	if m.replayPrefix(1<<40) != "" || strings.Contains(m.replaySuffix(), "u") {
		t.Fatalf("after leaving: prefix %q suffix %q", m.replayPrefix(1<<40), m.replaySuffix())
	}
	m.feed([]byte("\x1b[?1003h\x1bc"))
	if got := m.replaySuffix(); got != "" {
		t.Fatalf("after RIS = %q", got)
	}
}

// A replay whose start was cut off gets the modes that start set: the alternate screen
// before it, mouse reporting and the kitty flags after it. It starts at an escape.
func TestACutReplayPutsTheModesBack(t *testing.T) {
	old := scrollbackLimit
	scrollbackLimit = 4096
	t.Cleanup(func() { scrollbackLimit = old })
	h := New()
	sock := startHost(t, h)
	c := NewClient(sock, 1)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	// Full screen app: enter the alternate screen and set modes once, then draw only
	// what changes (a spinner), far more than the scrollback keeps.
	script := `printf '\033[?1049h\033[?1000h\033[?1006h\033[>1uFULL SCREEN'; i=0; while [ $i -lt 600 ]; do printf '\033[1;1Hspin%03d' $i; i=$((i+1)); done; printf 'DONE'; sleep 5`
	if _, err := c.Spawn(ctx, SpawnRequest{ID: "cut", Argv: []string{"/bin/sh", "-c", script}, Cwd: "/", Env: []string{"PATH=/bin:/usr/bin"}, Cols: 80, Rows: 24}); err != nil {
		t.Fatal(err)
	}
	var replay string
	for deadline := time.Now().Add(5 * time.Second); time.Now().Before(deadline); time.Sleep(50 * time.Millisecond) {
		conn, err := c.Attach(ctx, "cut")
		if err != nil {
			t.Fatal(err)
		}
		_, data, err := conn.Read(ctx)
		conn.CloseNow()
		if err != nil {
			t.Fatal(err)
		}
		if replay = string(data); strings.Contains(replay, "DONE") {
			break
		}
	}
	if !strings.Contains(replay, "DONE") {
		t.Fatalf("no full replay: %q", replay)
	}
	if strings.Contains(replay, "FULL SCREEN") {
		t.Fatal("the start was not cut off")
	}
	if !strings.HasPrefix(replay, "\x1b[?1049h\x1b[1;1H") {
		t.Fatalf("replay starts %q", replay[:min(40, len(replay))])
	}
	if !strings.HasSuffix(replay, "DONE\x1b[?1000h\x1b[?1006h\x1b[<99u\x1b[>1u") {
		t.Fatalf("replay ends %q", replay[max(0, len(replay)-60):])
	}
}

// winchRig spawns an app that prints its size on every SIGWINCH, and waits until it listens.
func winchRig(t *testing.T, id string) (*Client, context.Context) {
	t.Helper()
	oldWait, oldGap := repaintWait, repaintGap
	repaintWait, repaintGap = 300*time.Millisecond, 300*time.Millisecond
	t.Cleanup(func() { repaintWait, repaintGap = oldWait, oldGap })
	h := New()
	sock := startHost(t, h)
	c := NewClient(sock, 1)
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	t.Cleanup(cancel)
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	if _, err := c.Spawn(ctx, SpawnRequest{ID: id, Argv: []string{exe}, Cwd: "/", Env: []string{"MINBOX_TEST_WINCH=1"}, Cols: 90, Rows: 30}); err != nil {
		t.Fatal(err)
	}
	v := watch(t, ctx, c, id, false)
	for deadline := time.Now().Add(5 * time.Second); ; time.Sleep(20 * time.Millisecond) {
		if out, _ := v.after(0); strings.Contains(out, "READY") {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("the app did not start")
		}
		v.seen = 0
	}
	v.conn.CloseNow()
	return c, ctx
}

// view is an attached client that keeps what it is sent.
type view struct {
	conn  *websocket.Conn
	mu    sync.Mutex
	out   strings.Builder
	texts []string
	seen  int
}

func watch(t *testing.T, ctx context.Context, c *Client, id string, repaint bool) *view {
	t.Helper()
	attach := c.Attach
	if repaint {
		attach = c.AttachRepaint
	}
	conn, err := attach(ctx, id)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { conn.CloseNow() })
	v := &view{conn: conn}
	go func() {
		for {
			typ, data, err := conn.Read(ctx)
			if err != nil {
				return
			}
			v.mu.Lock()
			if typ == websocket.MessageText {
				v.texts = append(v.texts, string(data))
			} else {
				v.out.Write(data)
			}
			v.mu.Unlock()
		}
	}()
	return v
}

// after waits d and returns the output and the text frames since the last call.
func (v *view) after(d time.Duration) (string, []string) {
	time.Sleep(d)
	v.mu.Lock()
	defer v.mu.Unlock()
	s := v.out.String()
	out := s[v.seen:]
	v.seen = len(s)
	texts := v.texts
	v.texts = nil
	return out, texts
}

func (v *view) size(t *testing.T, ctx context.Context, size string) {
	t.Helper()
	if err := v.conn.Write(ctx, websocket.MessageText, []byte(`{"type":"resize",`+size+`,"lease":true}`)); err != nil {
		t.Fatal(err)
	}
}

// A view that attaches for repaint and fits the PTY's size as it is (so nothing resizes)
// makes the app repaint: the PTY is one row shorter for a moment, then back. The views are
// sent no size frame for it.
func TestARepaintAttachNudgesThePTYSize(t *testing.T) {
	c, ctx := winchRig(t, "rp")
	first := watch(t, ctx, c, "rp", true)
	first.size(t, ctx, `"cols":90,"rows":30`)
	out, texts := first.after(1200 * time.Millisecond)
	if !strings.Contains(out, "WINCH 29 90") || !strings.Contains(out, "WINCH 30 90") {
		t.Fatalf("first view: %q", out)
	}
	if len(texts) != 1 || texts[0] != `{"type":"size","cols":90,"rows":30}` {
		t.Fatalf("size frames = %v", texts)
	}

	// A second view: the app repaints again, and the first view sees it with no size frame.
	second := watch(t, ctx, c, "rp", true)
	second.size(t, ctx, `"cols":90,"rows":30`)
	out, texts = first.after(1200 * time.Millisecond)
	if strings.Count(out, "WINCH 29 90") != 1 || strings.Count(out, "WINCH 30 90") != 1 {
		t.Fatalf("first view while the second attached: %q", out)
	}
	if len(texts) != 0 {
		t.Fatalf("first view got size frames %v", texts)
	}
}

// A plain attach (a shell) does not nudge; nor does a repaint attach whose size resizes
// the PTY (that resize repaints already); a view that never tells its size is nudged
// after repaintWait.
func TestRepaintOnlyWhenAskedAndNothingResized(t *testing.T) {
	c, ctx := winchRig(t, "rq")
	plain := watch(t, ctx, c, "rq", false)
	plain.size(t, ctx, `"cols":90,"rows":30`)
	if out, _ := plain.after(time.Second); strings.Contains(out, "WINCH") {
		t.Fatalf("plain attach: %q", out)
	}

	small := watch(t, ctx, c, "rq", true)
	small.size(t, ctx, `"cols":60,"rows":20`)
	if out, _ := plain.after(1200 * time.Millisecond); strings.Count(out, "WINCH") != 1 || !strings.Contains(out, "WINCH 20 60") {
		t.Fatalf("resizing attach: %q", out)
	}
	small.conn.Close(websocket.StatusNormalClosure, "")
	if out, _ := plain.after(800 * time.Millisecond); !strings.Contains(out, "WINCH 30 90") {
		t.Fatalf("after the small view left: %q", out)
	}

	_ = watch(t, ctx, c, "rq", true) // never tells its size
	if out, _ := plain.after(1200 * time.Millisecond); !strings.Contains(out, "WINCH 29 90") || !strings.Contains(out, "WINCH 30 90") {
		t.Fatalf("silent view: %q", out)
	}
}
