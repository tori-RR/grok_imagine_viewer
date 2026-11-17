package main

import (
	"bytes"
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

// Close requests cancellation, but the pending read deliberately cannot return
// until released. This models an in-flight operation that cannot be preempted.
type pendingUploadBody struct {
	entered, closed, release chan struct{}
	readOnce, closeOnce      sync.Once
}

func (b *pendingUploadBody) Read(p []byte) (int, error) {
	first := false
	b.readOnce.Do(func() { first = true; close(b.entered) })
	if !first {
		return 0, io.EOF
	}
	<-b.release
	return copy(p, jpg), nil
}
func (b *pendingUploadBody) Close() error { b.closeOnce.Do(func() { close(b.closed) }); return nil }

func oneUpload(t *testing.T) (*Server, string, Obj, Obj) {
	t.Helper()
	s, root := fixture(t)
	reserved, err := s.reserveDownload(Obj{"root": root})
	if err != nil {
		t.Fatal(err)
	}
	s.run.http.Transport = deniedPublicTransport{}
	m := Obj{"complete": true, "assets": []any{Obj{"id": "upload-fixture", "key": "upload-fixture", "mime": "image/jpeg", "sz": len(jpg), "conv": "conversation-aaaaaaaa"}}, "conversations": []any{Obj{"id": "conversation-aaaaaaaa"}}}
	if _, err = s.startDownload(Obj{"runId": reserved["runId"], "userId": "fixture-user", "manifest": m}); err != nil {
		t.Fatal(err)
	}
	state := awaitRun(t, s, func(v Obj) bool { return len(rows(v["tickets"])) == 1 })
	return s, root, reserved, rows(state["tickets"])[0]
}
func uploadRequest(s *Server, ticket Obj, body io.Reader) *http.Request {
	req := httptest.NewRequest("POST", s.origin+"/internal/download/upload/"+str(ticket["ticket"]), body)
	req.Header.Set("X-Giv-Admin", s.boot.Secret)
	req.Header.Set("Origin", s.origin)
	req.Header.Set("X-Giv-Mime", "image/jpeg")
	req.ContentLength = int64(len(jpg))
	return req
}
func waitSignal(t *testing.T, signal <-chan struct{}) {
	t.Helper()
	select {
	case <-signal:
	case <-time.After(2 * time.Second):
		t.Fatal("fixture operation did not complete")
	}
}

func TestUploadFailureAndDisconnectJoinPendingHandler(t *testing.T) {
	for _, mode := range []string{"native_timeout", "request_disconnect", "run_cancel"} {
		t.Run(mode, func(t *testing.T) {
			s, root, reserved, ticket := oneUpload(t)
			body := &pendingUploadBody{entered: make(chan struct{}), closed: make(chan struct{}), release: make(chan struct{})}
			defer body.closeOnce.Do(func() { close(body.closed) })
			var release sync.Once
			defer release.Do(func() { close(body.release) })
			req := uploadRequest(s, ticket, body)
			ctx, cancel := context.WithCancel(req.Context())
			defer cancel()
			req = req.WithContext(ctx)
			done := make(chan struct{})
			go func() { defer close(done); s.ServeHTTP(httptest.NewRecorder(), req) }()
			waitSignal(t, body.entered)
			s.run.mu.Lock()
			part := s.run.Tickets[str(ticket["ticket"])].Part
			s.run.mu.Unlock()
			switch mode {
			case "native_timeout":
				if _, err := s.uploadFailed(Obj{"runId": reserved["runId"], "ticket": ticket["ticket"], "code": "upload_timeout"}); err != nil {
					t.Fatal(err)
				}
			case "request_disconnect":
				cancel()
			case "run_cancel":
				s.run.cancel()
			}
			waitSignal(t, body.closed)
			select {
			case <-done:
				t.Fatal("handler returned before its pending operation")
			default:
			}
			state := s.downloadStatus()
			if obj(state["result"]) != nil || str(state["phase"]) == "verify_account" || num(obj(state["counts"])["attempted"]) != 0 {
				t.Fatal("worker advanced before handler cleanup", state)
			}
			if !exists(filepath.Join(root, "_state", ".giv-go-download.json")) {
				t.Fatal("journal was retired during upload")
			}
			release.Do(func() { close(body.release) })
			waitSignal(t, done)
			if exists(part) {
				t.Fatal("cancelled upload part retained")
			}
			if mode == "run_cancel" {
				awaitRun(t, s, func(v Obj) bool { return obj(v["result"]) != nil })
			} else {
				awaitRun(t, s, func(v Obj) bool { return str(v["phase"]) == "verify_account" })
				if _, err := s.authorizeDownload(Obj{"runId": reserved["runId"], "userId": "fixture-user"}); err != nil {
					t.Fatal(err)
				}
				state = awaitRun(t, s, func(v Obj) bool { return obj(v["result"]) != nil })
				failures := rows(obj(state["result"])["failures"])
				if len(failures) != 1 || !yes(failures[0]["retryable"]) {
					t.Fatal("transient upload failure lost retry classification", state)
				}
			}
		})
	}
}

type pendingResponse struct {
	*httptest.ResponseRecorder
	entered, release chan struct{}
}

func (w *pendingResponse) Write(b []byte) (int, error) {
	close(w.entered)
	<-w.release
	return w.ResponseRecorder.Write(b)
}

func TestLateFailureCannotReplaceSuccessfulUploadOrPublishBeforeResponse(t *testing.T) {
	s, _, reserved, ticket := oneUpload(t)
	w := &pendingResponse{httptest.NewRecorder(), make(chan struct{}), make(chan struct{})}
	var release sync.Once
	defer release.Do(func() { close(w.release) })
	done := make(chan struct{})
	go func() { defer close(done); s.ServeHTTP(w, uploadRequest(s, ticket, bytes.NewReader(jpg))) }()
	waitSignal(t, w.entered)
	if _, err := s.uploadFailed(Obj{"runId": reserved["runId"], "ticket": ticket["ticket"], "code": "network"}); err != nil {
		t.Fatal(err)
	}
	if str(s.downloadStatus()["phase"]) == "verify_account" {
		t.Fatal("publication advanced before handler returned")
	}
	release.Do(func() { close(w.release) })
	waitSignal(t, done)
	if w.Code != 200 {
		t.Fatal(w.Code)
	}
	awaitRun(t, s, func(v Obj) bool { return str(v["phase"]) == "verify_account" })
	// Replayed failure notifications after completion are harmless.
	if _, err := s.uploadFailed(Obj{"runId": reserved["runId"], "ticket": ticket["ticket"], "code": "upload_timeout"}); err != nil {
		t.Fatal(err)
	}
	if _, err := s.authorizeDownload(Obj{"runId": reserved["runId"], "userId": "fixture-user"}); err != nil {
		t.Fatal(err)
	}
	state := awaitRun(t, s, func(v Obj) bool { return obj(v["result"]) != nil })
	result := obj(state["result"])
	if !yes(result["published"]) || num(obj(result["counts"])["succeeded"]) != 1 {
		t.Fatal(result)
	}
}

type cancelOnRead struct{ cancel context.CancelFunc }

func (r cancelOnRead) Read(p []byte) (int, error) { r.cancel(); return copy(p, jpg), io.EOF }
func TestCancellationAfterReadCannotWriteReturnedBytes(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	part := filepath.Join(t.TempDir(), "cancelled.part")
	if n, err := receiveMedia(ctx, cancelOnRead{cancel}, part, "image/jpeg", int64(len(jpg))); n != 0 || !errors.Is(err, context.Canceled) || exists(part) {
		t.Fatal(n, err)
	}
}

type mixedAccessTransport struct {
	mu    sync.Mutex
	paths []string
}

func (m *mixedAccessTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	m.mu.Lock()
	m.paths = append(m.paths, req.URL.Path)
	m.mu.Unlock()
	if strings.Contains(req.URL.Path, "private") {
		return &http.Response{StatusCode: 403, Header: http.Header{}, Body: io.NopCloser(strings.NewReader(""))}, nil
	}
	return &http.Response{StatusCode: 200, ContentLength: int64(len(jpg)), Header: http.Header{"Content-Type": []string{"image/jpeg"}}, Body: io.NopCloser(bytes.NewReader(jpg))}, nil
}
func TestPrivateAssetDoesNotDisablePublicTransportForNextAsset(t *testing.T) {
	s, root := fixture(t)
	if _, err := s.reserveDownload(Obj{"root": root}); err != nil {
		t.Fatal(err)
	}
	r := s.run
	transport := &mixedAccessTransport{}
	r.http.Transport = transport
	private := make(chan transferResult, 1)
	go func() {
		private <- r.transfer(Asset{ID: "private-image", Key: "private-image", Mime: "image/jpeg"}, filepath.Join(t.TempDir(), "private.part"))
	}()
	state := awaitRun(t, s, func(v Obj) bool { return len(rows(v["tickets"])) == 1 })
	if _, err := s.uploadFailed(Obj{"runId": r.ID, "ticket": rows(state["tickets"])[0]["ticket"], "code": "forbidden"}); err != nil {
		t.Fatal(err)
	}
	<-private
	result := r.transfer(Asset{ID: "public-image", Key: "public-image", Mime: "image/jpeg"}, filepath.Join(t.TempDir(), "public.part"))
	if result.Err != nil || result.Backend != "go-http" {
		t.Fatal("public asset unnecessarily used native fallback", result)
	}
	transport.mu.Lock()
	defer transport.mu.Unlock()
	if len(transport.paths) != 2 {
		t.Fatal(transport.paths)
	}
}

func TestMediaTimeoutBudgetAndRetryCategories(t *testing.T) {
	for _, size := range []int64{1, 64 << 20, 512 << 20} {
		budget := mediaTimeout(&size)
		if budget < 120*time.Second || budget > 600*time.Second {
			t.Fatal(size, budget)
		}
		if size == maxMedia && budget < 9*time.Minute {
			t.Fatal("large media cannot use its bounded slow-transfer budget")
		}
	}
	for _, code := range []string{"network", "network_body", "upload_timeout", "blob_capture_timeout", "page_not_ready"} {
		if !retryableTransfer(&transferError{Code: code}) {
			t.Fatal(code)
		}
	}
	for _, code := range []string{"storage_failed", "signature_mismatch", "length_mismatch", "stage_conflict", "commit_uncertain", "protocol_error", "forbidden"} {
		if retryableTransfer(&transferError{Code: code}) {
			t.Fatal(code)
		}
	}
	for status, retry := range map[int]bool{403: false, 408: true, 429: true, 500: true, 599: true, 600: false} {
		if retryableTransfer(&transferError{Code: "http_error", Status: status}) != retry {
			t.Fatal(status)
		}
	}
}

type faultyMediaOutput struct {
	*os.File
	stage string
}

func (f *faultyMediaOutput) Write(b []byte) (int, error) {
	if f.stage == "write" {
		return 0, errors.New("fixture disk full")
	}
	return f.File.Write(b)
}
func (f *faultyMediaOutput) Sync() error {
	if f.stage == "sync" {
		return errors.New("fixture sync failure")
	}
	return f.File.Sync()
}
func (f *faultyMediaOutput) Close() error {
	err := f.File.Close()
	if f.stage == "close" {
		return errors.New("fixture close failure")
	}
	return err
}
func TestMediaDiskFailuresCloseAndRemoveOwnedPart(t *testing.T) {
	for _, stage := range []string{"write", "sync", "close"} {
		t.Run(stage, func(t *testing.T) {
			part := filepath.Join(t.TempDir(), "disk-fault.part")
			open := func(path string) (mediaOutput, error) {
				f, err := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
				if err != nil {
					return nil, err
				}
				return &faultyMediaOutput{f, stage}, nil
			}
			_, err := receiveMediaWithOutput(context.Background(), bytes.NewReader(jpg), part, "image/jpeg", int64(len(jpg)), open)
			if err == nil || transferFailure(err).Code != "storage_failed" || retryableTransfer(err) || exists(part) {
				t.Fatal("disk failure was retried or left an open part", err)
			}
		})
	}
}
