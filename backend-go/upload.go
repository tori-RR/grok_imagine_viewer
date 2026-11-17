package main

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"time"
)

// All ticket state is protected by the owning run's mutex. Once an upload has
// been admitted, only its handler can complete the ticket, after file cleanup.
func (r *DownloadRun) completeTicketLocked(t *uploadTicket, result transferResult) {
	if t.Completed {
		return
	}
	t.Completed = true
	t.Done <- result
}

func (r *DownloadRun) failTicket(t *uploadTicket, failure error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if t.Completed {
		return
	}
	t.cancel(failure)
	if !t.Uploading {
		r.completeTicketLocked(t, transferResult{Err: failure})
	}
}

func (r *DownloadRun) drainUploads() {
	r.mu.Lock()
	r.uploadsClosed = true
	r.mu.Unlock()
	r.uploads.Wait()
}

func transferContextError(ctx context.Context) error {
	if cause := context.Cause(ctx); cause != nil {
		return cause
	}
	return ctx.Err()
}

func transferFailure(err error) *transferError {
	var failure *transferError
	if errors.As(err, &failure) {
		return failure
	}
	if errors.Is(err, context.Canceled) {
		return &transferError{Code: "cancelled"}
	}
	if errors.Is(err, context.DeadlineExceeded) {
		return &transferError{Code: "upload_timeout"}
	}
	return &transferError{Code: "storage_failed"}
}

func (s *Server) receiveUpload(w http.ResponseWriter, req *http.Request) {
	s.runMu.Lock()
	r := s.run
	s.runMu.Unlock()
	if r == nil {
		sendError(w, changed())
		return
	}
	key := strings.TrimPrefix(req.URL.Path, "/internal/download/upload/")
	r.mu.Lock()
	t := r.Tickets[key]
	if t == nil || t.Uploading || t.Completed || r.uploadsClosed || r.Result != nil || r.ctx.Err() != nil || req.Method != "POST" {
		r.mu.Unlock()
		sendError(w, fail("invalid_ticket", "Invalid transfer ticket", 409))
		return
	}
	t.Uploading = true
	r.uploads.Add(1)
	r.mu.Unlock()
	result := transferResult{Asset: t.Asset, Part: t.Part, Backend: "tauri-webview-session", Err: &transferError{Code: "storage_failed"}}
	// Both a native failure notification and the HTTP request's own cancellation
	// stop this ticket. HTTP/1 Body.Close can itself wait for a blocked Read;
	// expire this request's read deadline first. Join the callback before returning
	// so it never accesses a writer belonging to the next keep-alive request.
	controller := http.NewResponseController(w)
	deadlineErr := controller.SetReadDeadline(time.Now().Add(mediaTimeout(t.Asset.Size) + 30*time.Second))
	stopRequest := context.AfterFunc(req.Context(), func() {
		code := "network_body"
		if errors.Is(req.Context().Err(), context.DeadlineExceeded) {
			code = "upload_timeout"
		}
		t.cancel(&transferError{Code: code})
	})
	cancelDone := make(chan struct{})
	stopBody := context.AfterFunc(t.ctx, func() {
		defer close(cancelDone)
		_ = controller.SetReadDeadline(time.Now())
		_ = req.Body.Close()
	})
	defer func() {
		stopRequest()
		if !stopBody() {
			<-cancelDone
		}
		_ = controller.SetReadDeadline(time.Time{})
		t.cancel(context.Canceled)
		r.mu.Lock()
		r.completeTicketLocked(t, result)
		r.mu.Unlock()
		r.uploads.Done()
	}()
	if deadlineErr != nil && !errors.Is(deadlineErr, http.ErrNotSupported) {
		result.Err = &transferError{Code: "protocol_error"}
		sendError(w, fail("protocol_error", transferMessage("protocol_error"), 503))
		return
	}
	if !mimeFamily(t.Asset.Mime, req.Header.Get("X-Giv-Mime")) {
		result.Err = &transferError{Code: "mime_mismatch"}
	} else {
		declared := req.ContentLength
		if t.Asset.Size != nil && *t.Asset.Size > 0 {
			if declared >= 0 && declared != *t.Asset.Size {
				result.Err = &transferError{Code: "length_mismatch"}
				sendError(w, fail("length_mismatch", transferMessage("length_mismatch"), 422))
				return
			}
			declared = *t.Asset.Size
		}
		result.Bytes, result.Err = receiveMedia(t.ctx, req.Body, t.Part, t.Asset.Mime, declared)
	}
	if result.Err != nil {
		failure := transferFailure(result.Err)
		sendError(w, fail(failure.Code, transferMessage(failure.Code), 422))
		return
	}
	sendJSON(w, Obj{"ok": true, "bytes": result.Bytes})
}

func (s *Server) uploadFailed(p Obj) (Obj, error) {
	r, err := s.currentRun(p)
	if err != nil {
		return nil, err
	}
	r.mu.Lock()
	t := r.Tickets[str(p["ticket"])]
	r.mu.Unlock()
	if t == nil {
		return Obj{"ok": true}, nil
	}
	code := str(p["code"])
	switch code {
	case "network", "network_body", "timeout", "http_error", "page_not_ready", "blob_capture_failed", "blob_capture_timeout", "upload_timeout",
		"mime_mismatch", "length_mismatch", "signature_mismatch", "redirect_refused", "cancelled", "account_mismatch", "account_unverified",
		"storage_failed", "stage_conflict", "commit_uncertain", "size_limit", "not_logged_in", "forbidden", "protocol_error":
	default:
		code = "authenticated_transfer_failed"
	}
	status := int(num(p["httpStatus"]))
	if status < 100 || status > 599 {
		status = 0
	}
	r.failTicket(t, &transferError{Code: code, Status: status})
	return Obj{"ok": true}, nil
}
