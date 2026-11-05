package termhost

import (
	"context"
	"strconv"
	"testing"
	"time"

	"github.com/coder/websocket"
)

// sizeRig spawns a 90x30 terminal and returns helpers to read size frames and send wants.
func sizeRig(t *testing.T, id string) (c *Client, ctx context.Context, next func(*websocket.Conn) string, want func(*websocket.Conn, int, int)) {
	t.Helper()
	h := New()
	sock := startHost(t, h)
	c = NewClient(sock, 1)
	var cancel context.CancelFunc
	ctx, cancel = context.WithTimeout(context.Background(), 10*time.Second)
	t.Cleanup(cancel)
	if _, err := c.Spawn(ctx, SpawnRequest{ID: id, Argv: []string{"/bin/sh", "-c", "sleep 5"}, Cwd: "/", Env: []string{"PATH=/bin:/usr/bin"}, Cols: 90, Rows: 30}); err != nil {
		t.Fatal(err)
	}
	next = func(conn *websocket.Conn) string {
		for {
			typ, data, err := conn.Read(ctx)
			if err != nil {
				t.Fatal(err)
			}
			if typ == websocket.MessageText {
				return string(data)
			}
		}
	}
	want = func(conn *websocket.Conn, cols, rows int) {
		if err := conn.Write(ctx, websocket.MessageText, []byte(`{"type":"resize","cols":`+strconv.Itoa(cols)+`,"rows":`+strconv.Itoa(rows)+`}`)); err != nil {
			t.Fatal(err)
		}
	}
	return
}

func TestThePTYReturnsToItsStartSizeWhenNoClientWantsOne(t *testing.T) {
	c, ctx, next, want := sizeRig(t, "s2")
	phone, err := c.Attach(ctx, "s2")
	if err != nil {
		t.Fatal(err)
	}
	defer phone.CloseNow()
	_ = next(phone)
	want(phone, 40, 20)
	if got := next(phone); got != `{"type":"size","cols":40,"rows":20}` {
		t.Fatalf("phone alone = %s", got)
	}
	// A watcher that never sends a size sees the PTY go back when the phone leaves.
	watcher, err := c.Attach(ctx, "s2")
	if err != nil {
		t.Fatal(err)
	}
	defer watcher.CloseNow()
	_ = next(watcher)
	phone.Close(websocket.StatusNormalClosure, "")
	if got := next(watcher); got != `{"type":"size","cols":90,"rows":30}` {
		t.Fatalf("after the phone left = %s", got)
	}
}

func shortLeases(t *testing.T, ttl time.Duration) {
	oldTTL, oldCheck := leaseTTL, leaseCheck
	leaseTTL, leaseCheck = ttl, 50*time.Millisecond
	t.Cleanup(func() { leaseTTL, leaseCheck = oldTTL, oldCheck })
}

func TestTheLastLeaseExpiringReturnsToTheStartSize(t *testing.T) {
	shortLeases(t, 300*time.Millisecond)
	c, ctx, next, _ := sizeRig(t, "s5")
	phone, err := c.Attach(ctx, "s5")
	if err != nil {
		t.Fatal(err)
	}
	defer phone.CloseNow()
	_ = next(phone)
	if err := phone.Write(ctx, websocket.MessageText, []byte(`{"type":"resize","cols":40,"rows":20,"lease":true}`)); err != nil {
		t.Fatal(err)
	}
	if got := next(phone); got != `{"type":"size","cols":40,"rows":20}` {
		t.Fatalf("phone = %s", got)
	}
	if got := next(phone); got != `{"type":"size","cols":90,"rows":30}` {
		t.Fatalf("after the lease expired = %s", got)
	}
}

func TestALeaseExpiresUnlessSentAgain(t *testing.T) {
	shortLeases(t, 400*time.Millisecond)
	c, ctx, next, want := sizeRig(t, "s4")
	desk, err := c.Attach(ctx, "s4")
	if err != nil {
		t.Fatal(err)
	}
	defer desk.CloseNow()
	_ = next(desk)
	want(desk, 160, 48) // no lease: never expires
	_ = next(desk)
	phone, err := c.Attach(ctx, "s4")
	if err != nil {
		t.Fatal(err)
	}
	defer phone.CloseNow()
	_ = next(phone)
	lease := func() {
		if err := phone.Write(ctx, websocket.MessageText, []byte(`{"type":"resize","cols":40,"rows":20,"lease":true}`)); err != nil {
			t.Fatal(err)
		}
	}
	lease()
	if got := next(desk); got != `{"type":"size","cols":40,"rows":20}` {
		t.Fatalf("with the phone = %s", got)
	}
	// Sent again within the TTL, it stays: no size frame arrives meanwhile.
	for i := 0; i < 4; i++ {
		time.Sleep(200 * time.Millisecond)
		lease()
	}
	// Then it stops while the connection stays open: the lease expires.
	if got := next(desk); got != `{"type":"size","cols":160,"rows":48}` {
		t.Fatalf("after the lease expired = %s", got)
	}
}

func TestThePTYGrowsToTheDesktopWhenThePhoneLeaves(t *testing.T) {
	c, ctx, next, want := sizeRig(t, "s3")
	desk, err := c.Attach(ctx, "s3")
	if err != nil {
		t.Fatal(err)
	}
	defer desk.CloseNow()
	_ = next(desk)
	want(desk, 160, 48)
	_ = next(desk)
	phone, err := c.Attach(ctx, "s3")
	if err != nil {
		t.Fatal(err)
	}
	_ = next(phone)
	want(phone, 40, 20)
	if got := next(desk); got != `{"type":"size","cols":40,"rows":20}` {
		t.Fatalf("with the phone = %s", got)
	}
	phone.Close(websocket.StatusNormalClosure, "")
	if got := next(desk); got != `{"type":"size","cols":160,"rows":48}` {
		t.Fatalf("after the phone left = %s", got)
	}
}
