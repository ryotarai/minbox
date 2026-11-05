package store

import (
	"context"
	"errors"
	"testing"
)

func TestDestinations(t *testing.T) {
	ctx := context.Background()
	s := newStore(t)
	d := &Destination{Type: "slack", Name: "team", Enabled: true, Config: map[string]any{"webhook_url": "https://h/x", "include_body": true}}
	if err := s.CreateDestination(ctx, d); err != nil || d.ID == "" {
		t.Fatalf("create: %v", err)
	}
	got, err := s.GetDestination(ctx, d.ID)
	if err != nil || got.Config["webhook_url"] != "https://h/x" || got.Config["include_body"] != true || !got.Enabled || got.LastOKAt != nil {
		t.Fatalf("get: %+v %v", got, err)
	}
	got.Name, got.Enabled = "ops", false
	got.Config["include_body"] = false
	if err := s.UpdateDestination(ctx, got); err != nil {
		t.Fatal(err)
	}
	again, _ := s.GetDestination(ctx, d.ID)
	if again.Name != "ops" || again.Enabled || again.Config["include_body"] != false {
		t.Fatalf("update: %+v", again)
	}
	if err := s.RecordDelivery(ctx, d.ID, s.now(), "Slack answered 500"); err != nil {
		t.Fatal(err)
	}
	again, _ = s.GetDestination(ctx, d.ID)
	if again.LastError != "Slack answered 500" || again.LastErrorAt == nil || again.LastOKAt != nil {
		t.Fatalf("failure: %+v", again)
	}
	if err := s.RecordDelivery(ctx, d.ID, s.now(), ""); err != nil {
		t.Fatal(err)
	}
	again, _ = s.GetDestination(ctx, d.ID)
	if again.LastError != "" || again.LastErrorAt != nil || again.LastOKAt == nil {
		t.Fatalf("success: %+v", again)
	}
	list, _ := s.ListDestinations(ctx)
	if len(list) != 1 {
		t.Fatalf("list = %d", len(list))
	}
	if err := s.DeleteDestination(ctx, d.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := s.GetDestination(ctx, d.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("after delete: %v", err)
	}
	if err := s.RecordDelivery(ctx, d.ID, s.now(), ""); !errors.Is(err, ErrNotFound) {
		t.Fatalf("record after delete: %v", err)
	}
}
