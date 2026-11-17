package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"path/filepath"
	"reflect"
	"testing"
	"time"
)

func TestCloneIsolationAndPrecision(t *testing.T) {
	original := Obj{"nested": Obj{"list": []any{Obj{"id": "keep"}, json.Number("9007199254740993")}}, "rows": []Obj{{"x": 1}}, "strings": []string{"keep"}}
	copied := clone(original)
	obj(arr(obj(copied["nested"])["list"])[0])["id"] = "changed"
	copied["rows"].([]Obj)[0]["x"] = 2
	copied["strings"].([]string)[0] = "changed"
	if str(obj(arr(obj(original["nested"])["list"])[0])["id"]) != "keep" || original["rows"].([]Obj)[0]["x"] != 1 || original["strings"].([]string)[0] != "keep" {
		t.Fatal("clone aliases mutable source")
	}
	if arr(obj(copied["nested"])["list"])[1] != json.Number("9007199254740993") {
		t.Fatal("integer precision lost")
	}
}
func TestRetryClassification(t *testing.T) {
	for _, code := range []string{"mime_mismatch", "size_limit", "length_mismatch", "stage_conflict", "storage_failed", "signature_mismatch", "invalid_key"} {
		if retryableTransfer(&transferError{Code: code}) {
			t.Fatal("retried permanent failure", code)
		}
	}
	for _, status := range []int{206, 400, 401, 403, 404} {
		if retryableTransfer(&transferError{Code: "http_error", Status: status}) {
			t.Fatal(status)
		}
	}
	for _, status := range []int{408, 429, 500, 503} {
		if !retryableTransfer(&transferError{Code: "http_error", Status: status}) {
			t.Fatal(status)
		}
	}
	if retryableTransfer(context.Canceled) || retryableTransfer(errors.New("disk")) {
		t.Fatal("unknown error retried")
	}
}
func TestPublicManifestSizeEnforced(t *testing.T) {
	size := int64(len(jpg) + 1)
	r := &DownloadRun{ctx: context.Background(), http: &http.Client{Transport: roundTripFunc(func(*http.Request) (*http.Response, error) {
		return &http.Response{StatusCode: 200, Header: http.Header{"Content-Type": []string{"image/jpeg"}}, ContentLength: int64(len(jpg)), Body: io.NopCloser(bytes.NewReader(jpg))}, nil
	})}}
	part := filepath.Join(t.TempDir(), "media.part")
	if _, err := r.fetchPublic(Asset{Key: "fixture.jpg", Mime: "image/jpeg", Size: &size}, part); err == nil || exists(part) {
		t.Fatal("manifest size mismatch accepted")
	}
}
func TestDeclaredOversizeDoesNotCreateStage(t *testing.T) {
	part := filepath.Join(t.TempDir(), "media.part")
	if _, err := receiveMedia(context.Background(), bytes.NewReader(jpg), part, "image/jpeg", maxMedia+1); err == nil || exists(part) {
		t.Fatal("oversize created stage")
	}
	if _, err := receiveMedia(context.Background(), bytes.NewReader(jpg), part, "image/jpeg", 1); err == nil || exists(part) {
		t.Fatal("long body retained")
	}
}
func TestBoundedToolOutput(t *testing.T) {
	b := &boundedOutput{limit: 4}
	if n, err := b.Write([]byte("123456")); n != 6 || err != nil || !b.exceeded || b.String() != "1234" {
		t.Fatal("output bound not enforced")
	}
	b.Write([]byte("more"))
	if b.Len() != 4 {
		t.Fatal("output grew beyond limit")
	}
}
func BenchmarkCachedCardClone(b *testing.B) {
	card := Obj{"id": "fixture", "items": []any{}}
	for i := 0; i < 100; i++ {
		card["items"] = append(arr(card["items"]), Obj{"id": "asset", "created": "2026-10-01T12:00:00Z", "prompt": "fixture prompt", "size": json.Number("9007199254740993")})
	}
	encoded, _ := json.Marshal(card)
	copied := clone(card)
	got, _ := json.Marshal(copied)
	if !reflect.DeepEqual(encoded, got) {
		b.Fatal("JSON contract changed")
	}
	b.Run("direct", func(b *testing.B) {
		b.ReportAllocs()
		for i := 0; i < b.N; i++ {
			_ = clone(card)
		}
	})
	b.Run("json-roundtrip-reference", func(b *testing.B) {
		b.ReportAllocs()
		for i := 0; i < b.N; i++ {
			data, _ := json.Marshal(card)
			_, _ = decode(data)
		}
	})
}

func TestBrowserAdmissionDoesNotBlockNativeControl(t *testing.T) {
	s, _ := fixture(t)
	for i := 0; i < cap(s.requests); i++ {
		s.requests <- struct{}{}
	}
	defer func() {
		for len(s.requests) > 0 {
			<-s.requests
		}
	}()
	w, _ := call(t, s, "GET", "/api/root", nil, false)
	if w.Code != 503 {
		t.Fatal("browser overload accepted", w.Code)
	}
	w, _ = call(t, s, "GET", "/internal/download/status", nil, true)
	if w.Code != 200 {
		t.Fatal("native control blocked by browser overload", w.Code)
	}
}

func TestAuthenticatedFallbackAdmissionAndCancellation(t *testing.T) {
	s, root := fixture(t)
	if _, err := s.reserveDownload(Obj{"root": root}); err != nil {
		t.Fatal(err)
	}
	r := s.run
	results := make(chan transferResult, 5)
	for i := 0; i < 5; i++ {
		go func() { results <- r.fallback(Asset{ID: "fixture"}, "unused-fixture-path") }()
	}
	for completed := 0; completed < 2; completed++ {
		deadline := time.Now().Add(time.Second)
		var ticket *uploadTicket
		for time.Now().Before(deadline) {
			r.mu.Lock()
			if len(r.Tickets) > 1 {
				r.mu.Unlock()
				t.Fatal("overlapping native fallback tickets")
			}
			for _, v := range r.Tickets {
				ticket = v
			}
			r.mu.Unlock()
			if ticket != nil {
				break
			}
			time.Sleep(time.Millisecond)
		}
		if ticket == nil {
			t.Fatal("fallback never admitted")
		}
		r.mu.Lock()
		r.completeTicketLocked(ticket, transferResult{Bytes: 1})
		r.mu.Unlock()
		select {
		case result := <-results:
			if result.Err != nil {
				t.Fatal(result.Err)
			}
		case <-time.After(time.Second):
			t.Fatal("fallback did not complete")
		}
	}
	r.cancel()
	// One active ticket and two queued workers must all exit without waiting for TTL.
	for remaining := 0; remaining < 3; remaining++ {
		select {
		case result := <-results:
			if !errors.Is(result.Err, context.Canceled) {
				t.Fatal(result.Err)
			}
		case <-time.After(time.Second):
			t.Fatal("waiting fallback did not cancel")
		}
	}
}
