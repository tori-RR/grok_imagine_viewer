package main

import (
	"context"
	"errors"
	"net/http"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func promptScanReservation(t *testing.T) (*Server, *DownloadRun, Obj) {
	t.Helper()
	s, root := fixture(t)
	promptSyncBind(t, root)
	w, reservation := call(t, s, http.MethodPost, "/internal/download/reserve", Obj{"root": root}, true)
	if w.Code != 200 {
		t.Fatal(w.Code, reservation)
	}
	return s, s.run, Obj{"runId": reservation["runId"], "root": root, "userId": "fixture-user"}
}

func TestPromptTargetScanDoesNotBlockStartOnSlowCard(t *testing.T) {
	s, run, request := promptScanReservation(t)
	entered, release := make(chan struct{}), make(chan struct{})
	var once, releaseOnce sync.Once
	releaseScan := func() { releaseOnce.Do(func() { close(release) }) }
	defer releaseScan()
	run.promptReadCard = func(path string) (Obj, error) {
		once.Do(func() { close(entered); <-release })
		return readJSON(path)
	}
	scanDone := make(chan error, 1)
	go func() { _, err := s.promptTargets(context.Background(), request); scanDone <- err }()
	select {
	case <-entered:
	case <-time.After(time.Second):
		t.Fatal("scan did not reach card fixture")
	}
	started := make(chan error, 1)
	go func() {
		_, err := s.startDownload(Obj{"runId": request["runId"], "userId": "fixture-user", "manifest": promptSyncManifest([]any{}, []any{})})
		started <- err
	}()
	select {
	case err := <-started:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(time.Second):
		t.Fatal("optional card I/O held the run mutex and blocked start")
	}
	releaseScan()
	select {
	case err := <-scanDone:
		if err == nil {
			t.Fatal("late scan installed targets after start")
		}
	case <-time.After(time.Second):
		t.Fatal("released scan did not finish")
	}
	run.mu.Lock()
	issued := len(run.promptTargets)
	run.mu.Unlock()
	if issued != 0 {
		t.Fatal("late scan changed run allowlist", issued)
	}
}

func TestPromptTargetScanBudgetReturnsTruncatedBeforeCardIO(t *testing.T) {
	s, run, request := promptScanReservation(t)
	var reads atomic.Int32
	run.promptReadCard = func(string) (Obj, error) {
		reads.Add(1)
		return nil, errors.New("zero-budget scan must not read cards")
	}
	response, err := s.promptTargetsWithBudget(context.Background(), request, 0)
	if err != nil || !yes(response["truncated"]) || len(rows(response["targets"])) != 0 || reads.Load() != 0 {
		t.Fatal(response, err, reads.Load())
	}
}

func TestPromptTargetScanHonorsRequestCancellation(t *testing.T) {
	s, run, request := promptScanReservation(t)
	ctx, cancel := context.WithCancel(context.Background())
	run.promptReadCard = func(path string) (Obj, error) { cancel(); return readJSON(path) }
	_, err := s.promptTargets(ctx, request)
	if !errors.Is(err, context.Canceled) {
		t.Fatal("request cancellation was ignored", err)
	}
	run.mu.Lock()
	issued := len(run.promptTargets)
	run.mu.Unlock()
	if issued != 0 {
		t.Fatal("cancelled scan installed targets", issued)
	}
}
