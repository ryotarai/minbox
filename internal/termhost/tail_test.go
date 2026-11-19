package termhost

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"
)

// Tail gives the end of a terminal's output (the server reads a stuck agent's prompt from it).
func TestTail(t *testing.T) {
	h := New()
	sock := startHost(t, h)
	c := NewClient(sock, 1)
	ctx := context.Background()
	if _, err := c.Spawn(ctx, SpawnRequest{ID: "p", Argv: []string{"/bin/sh", "-c", "echo first; echo 'Do you trust the files in this folder?'; sleep 60"}, Cwd: "/", Env: []string{"PATH=/bin:/usr/bin"}}); err != nil {
		t.Fatal(err)
	}
	var got string
	for i := 0; i < 100; i++ {
		b, err := c.Tail(ctx, "p", 1<<10)
		if err != nil {
			t.Fatal(err)
		}
		if got = string(b); strings.Contains(got, "trust the files") {
			break
		}
		time.Sleep(50 * time.Millisecond)
	}
	if !strings.Contains(got, "first") || !strings.Contains(got, "Do you trust the files in this folder?") {
		t.Fatalf("tail = %q", got)
	}
	if b, _ := c.Tail(ctx, "p", 10); len(b) != 10 {
		t.Fatalf("tail of 10 bytes = %q", b)
	}
	var se *StatusError
	if _, err := c.Tail(ctx, "nope", 10); !errors.As(err, &se) || se.Status != 404 {
		t.Fatalf("unknown terminal: %v", err)
	}
}
