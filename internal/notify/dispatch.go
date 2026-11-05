package notify

import (
	"context"
	"errors"
	"log"
	"net/http"
	"sync"
	"time"

	"github.com/ryotarai/minbox/internal/store"
)

// DefaultDelays are the waits before the retries of a failed send.
var DefaultDelays = []time.Duration{time.Second, 5 * time.Second, 20 * time.Second}

// Dispatcher sends a notification to every enabled destination that wants it, in the
// background, and records each destination's last result.
type Dispatcher struct {
	Store  *store.Store
	Client *http.Client
	// Delays: the waits before retry 1, 2, ... (so len(Delays)+1 attempts at most).
	Delays []time.Duration
	// Sleep waits d or until ctx ends (tests replace it).
	Sleep func(ctx context.Context, d time.Duration) error
	Now   func() time.Time
	// Changed is called after a destination's last result changed.
	Changed func()
	Ctx     context.Context

	wg sync.WaitGroup
}

// NewDispatcher builds a dispatcher with the real clock and the default backoff.
func NewDispatcher(st *store.Store) *Dispatcher {
	return &Dispatcher{
		Store: st, Client: &http.Client{Timeout: 15 * time.Second}, Delays: DefaultDelays, Now: time.Now, Ctx: context.Background(),
		Sleep: func(ctx context.Context, d time.Duration) error {
			t := time.NewTimer(d)
			defer t.Stop()
			select {
			case <-t.C:
				return nil
			case <-ctx.Done():
				return ctx.Err()
			}
		},
	}
}

// Wait blocks until every send started so far has finished (for tests and shutdown).
func (d *Dispatcher) Wait() { d.wg.Wait() }

// Dispatch returns at once; the sends happen in the background.
func (d *Dispatcher) Dispatch(n Notification) {
	d.wg.Add(1)
	go func() {
		defer d.wg.Done()
		dests, err := d.Store.ListDestinations(d.Ctx)
		if err != nil {
			log.Printf("notify: %v", err)
			return
		}
		for _, dest := range dests {
			if !dest.Enabled || !Wants(dest.Config, n) {
				continue
			}
			dest := dest
			d.wg.Add(1)
			go func() {
				defer d.wg.Done()
				err := d.sendWithRetry(d.Ctx, &dest, n)
				d.record(&dest, err)
			}()
		}
	}()
}

// Test sends once, without retries, and returns the failure (a destination can be disabled).
func (d *Dispatcher) Test(ctx context.Context, dest *store.Destination, n Notification) error {
	n.Test = true
	err := d.send(ctx, dest, n)
	d.record(dest, err)
	return err
}

func (d *Dispatcher) send(ctx context.Context, dest *store.Destination, n Notification) error {
	t, ok := Lookup(dest.Type)
	if !ok {
		return &SendError{Msg: "unknown destination type " + dest.Type}
	}
	nt, err := t.Notifier(dest.Config, d.Client)
	if err != nil {
		return &SendError{Msg: err.Error()}
	}
	return nt.Send(ctx, n)
}

func (d *Dispatcher) sendWithRetry(ctx context.Context, dest *store.Destination, n Notification) error {
	var err error
	for attempt := 0; ; attempt++ {
		err = d.send(ctx, dest, n)
		if err == nil {
			return nil
		}
		retry, after := isRetryable(err)
		if !retry || attempt >= len(d.Delays) {
			return err
		}
		wait := d.Delays[attempt]
		if after > 0 {
			wait = after
		}
		if e := d.Sleep(ctx, wait); e != nil {
			return errors.Join(err, e)
		}
	}
}

func (d *Dispatcher) record(dest *store.Destination, err error) {
	msg := ""
	if err != nil {
		msg = err.Error()
		log.Printf("notify: %s (%s) failed: %s", dest.ID, dest.Type, msg)
	}
	if e := d.Store.RecordDelivery(context.Background(), dest.ID, d.Now(), msg); e != nil && !errors.Is(e, store.ErrNotFound) {
		log.Printf("notify: record: %v", e)
	}
	if d.Changed != nil {
		d.Changed()
	}
}
