package store

import (
	"context"
	"testing"
)

func TestSlackThreads(t *testing.T) {
	ctx := context.Background()
	s := newStore(t)
	if _, ok, err := s.GetSlackThread(ctx, "dst_1", "thr_1"); ok || err != nil {
		t.Fatalf("empty: %v %v", ok, err)
	}
	if err := s.PutSlackThread(ctx, "dst_1", "thr_1", SlackThread{ChannelID: "C1", TS: "1.1"}); err != nil {
		t.Fatal(err)
	}
	if err := s.PutSlackThread(ctx, "dst_1", "thr_1", SlackThread{ChannelID: "C1", TS: "2.2"}); err != nil {
		t.Fatal(err)
	}
	_ = s.PutSlackThread(ctx, "dst_1", "thr_2", SlackThread{ChannelID: "C1", TS: "3.3"})
	_ = s.PutSlackThread(ctx, "dst_2", "thr_1", SlackThread{ChannelID: "C9", TS: "4.4"})
	if got, ok, _ := s.GetSlackThread(ctx, "dst_1", "thr_1"); !ok || got.TS != "2.2" {
		t.Fatalf("replace: %+v", got)
	}
	if err := s.DeleteSlackThreads(ctx, "dst_1"); err != nil {
		t.Fatal(err)
	}
	if _, ok, _ := s.GetSlackThread(ctx, "dst_1", "thr_2"); ok {
		t.Fatal("not deleted")
	}
	if _, ok, _ := s.GetSlackThread(ctx, "dst_2", "thr_1"); !ok {
		t.Fatal("another destination's row deleted")
	}
	d := &Destination{Type: "slack_app", Name: "x", Config: map[string]any{}}
	_ = s.CreateDestination(ctx, d)
	_ = s.PutSlackThread(ctx, d.ID, "thr_1", SlackThread{ChannelID: "C1", TS: "5.5"})
	_ = s.DeleteDestination(ctx, d.ID)
	if _, ok, _ := s.GetSlackThread(ctx, d.ID, "thr_1"); ok {
		t.Fatal("destination delete kept the row")
	}
}
