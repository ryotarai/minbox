package termhost

import (
	"context"
	"net/http/httptest"
	"os"
	"testing"
	"time"
)

func TestVersionReportsStartAndBuild(t *testing.T) {
	if id := BinaryID(); len(id) != 16 || BinaryID() != id {
		t.Fatalf("BinaryID = %q (again %q)", id, BinaryID())
	}
	h := New()
	h.Version, h.Binary = "v9", BinaryID()
	ts := httptest.NewServer(h.Handler())
	defer ts.Close()
	v, err := NewHTTPClient(ts.URL, nil, 1).Version(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if v.Version != "v9" || v.Binary != BinaryID() || v.PID != os.Getpid() || v.StartedAt == nil || time.Since(*v.StartedAt) > time.Minute {
		t.Fatalf("version = %+v", v)
	}
}
