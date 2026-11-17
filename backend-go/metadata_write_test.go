package main

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"
)

func TestMetadataWriteDownloadBindWaitsForShortLease(t *testing.T) {
	s, root := fixture(t)
	if _, err := s.reserveDownload(Obj{"root": root}); err != nil {
		t.Fatal(err)
	}
	r := s.run
	r.User = "fixture-user"
	lease, err := acquireLease(root, ".viewer-meta.lock")
	if err != nil {
		t.Fatal(err)
	}
	m := defaultMeta()
	obj(m["items"])["asset-one"] = Obj{"fav": true}
	m["revision"] = 4
	jsonFixture(t, filepath.Join(root, ".viewer-meta.json"), m)
	done := make(chan error, 1)
	go func() { done <- r.bind() }()
	select {
	case err := <-done:
		lease.Close()
		t.Fatal("short metadata contention aborted binding", err)
	case <-time.After(35 * time.Millisecond):
	}
	lease.Close()
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("bind lease retry stuck")
	}
	m, err = loadMeta(root)
	if err != nil || num(m["revision"]) != 5 || str(m["grokUserId"]) != "fixture-user" || !yes(obj(obj(m["items"])["asset-one"])["fav"]) {
		t.Fatal("binding lost concurrent metadata", m, err)
	}
}

func TestMetadataWriteDownloadBindContentionIsBoundedAndCancelable(t *testing.T) {
	for _, cancel := range []bool{false, true} {
		t.Run(fmt.Sprint(cancel), func(t *testing.T) {
			s, root := fixture(t)
			if _, err := s.reserveDownload(Obj{"root": root}); err != nil {
				t.Fatal(err)
			}
			r := s.run
			r.User = "fixture-user"
			lease, err := acquireLease(root, ".viewer-meta.lock")
			if err != nil {
				t.Fatal(err)
			}
			defer lease.Close()
			done := make(chan error, 1)
			go func() { done <- r.bind() }()
			if cancel {
				s.stopDownloads()
			}
			select {
			case err := <-done:
				if cancel && !errors.Is(err, context.Canceled) || !cancel && downloadBindCode(err) != "meta_busy" {
					t.Fatal("lock contention/cancel misclassified", err)
				}
			case <-time.After(3 * time.Second):
				t.Fatal("bind contention did not terminate")
			}
			if _, err := os.Stat(filepath.Join(root, ".viewer-meta.json")); !os.IsNotExist(err) {
				t.Fatal("failed/cancelled binding wrote metadata", err)
			}
		})
	}
}

func TestMetadataWriteDuringDownloadRetainsDestructiveGate(t *testing.T) {
	s, root := fixture(t)
	if _, err := s.reserveDownload(Obj{"root": root}); err != nil {
		t.Fatal(err)
	}
	p := Obj{"expectedRoot": root, "expectedRevision": 0, "item": Obj{"id": "asset-one", "fav": true, "tags": []any{"safe"}}, "group": Obj{"section": "combos", "folder": "0001_aaaaaaaa", "lastViewedId": "asset-one"}}
	w, out := call(t, s, http.MethodPut, "/api/meta", p, false)
	if w.Code != 200 || num(obj(out["meta"])["revision"]) != 1 {
		t.Fatal("download blocked descriptive metadata", w.Code, out)
	}
	if _, err := s.withWrite(Obj{"expectedRoot": root}, true, func(Snapshot) (Obj, error) { t.Fatal("native binding entered while downloading"); return nil, nil }); err == nil {
		t.Fatal("native account binding gate weakened")
	}
	w, _ = call(t, s, http.MethodPost, "/api/trash", Obj{"expectedRoot": root, "section": "combos", "folder": "0001_aaaaaaaa", "ids": []any{"asset-one"}}, false)
	if w.Code != 423 {
		t.Fatal("destructive write allowed during download", w.Code)
	}
	w, out = call(t, s, http.MethodPut, "/api/meta", p, false)
	if w.Code != 409 || str(out["code"]) != "meta_conflict" {
		t.Fatal("stale revision accepted during download", w.Code, out)
	}
	s.stopDownloads()
	m, err := loadMeta(root)
	if err != nil || !yes(obj(obj(m["items"])["asset-one"])["fav"]) || str(obj(obj(m["groups"])["combos/0001_aaaaaaaa"])["lastViewedId"]) != "asset-one" {
		t.Fatal("metadata did not survive stop", m, err)
	}
}

func TestMetadataWriteCrossServerRevisionAndLockContention(t *testing.T) {
	s, root := fixture(t)
	other, _ := fixture(t)
	if _, err := other.activateRoot(root, false, false); err != nil {
		t.Fatal(err)
	}
	if _, err := s.reserveDownload(Obj{"root": root}); err != nil {
		t.Fatal(err)
	}
	s.run.User = "fixture-user"
	if err := s.run.bind(); err != nil {
		t.Fatal(err)
	}
	for round := 0; round < 12; round++ {
		m, err := loadMeta(root)
		if err != nil {
			t.Fatal(err)
		}
		start := make(chan struct{})
		results := make(chan Obj, 2)
		for i, server := range []*Server{s, other} {
			go func(i int, server *Server) {
				<-start
				p := Obj{"expectedRoot": root, "expectedRevision": m["revision"], "addTag": fmt.Sprintf("round-%d-writer-%d", round, i)}
				for attempts := 0; attempts < 30; attempts++ {
					w, out := call(t, server, http.MethodPut, "/api/meta", p, false)
					if w.Code != 423 {
						out["httpStatus"] = w.Code
						results <- out
						return
					}
					time.Sleep(time.Millisecond)
				}
				results <- Obj{"httpStatus": 423}
			}(i, server)
		}
		close(start)
		statuses := map[int64]int{}
		for i := 0; i < 2; i++ {
			select {
			case out := <-results:
				statuses[num(out["httpStatus"])]++
			case <-time.After(3 * time.Second):
				t.Fatal("cross-server metadata deadlock")
			}
		}
		if statuses[200] != 1 || statuses[409] != 1 {
			t.Fatal("one revision authorized more than one winner", statuses)
		}
		latest, err := loadMeta(root)
		if err != nil || num(latest["revision"]) != num(m["revision"])+1 || str(latest["grokUserId"]) != "fixture-user" {
			t.Fatal("revision/account damaged", latest, err)
		}
	}
	s.stopDownloads()
}

func TestMetadataWriteRootSwitchWaitsForCommit(t *testing.T) {
	s, root := fixture(t)
	_, nextRoot := fixture(t)
	entered, release := make(chan struct{}), make(chan struct{})
	writeDone := make(chan error, 1)
	go func() {
		_, err := s.withMetadataWrite(Obj{"expectedRoot": root}, func(snap Snapshot) (Obj, error) {
			close(entered)
			<-release
			return s.patchMeta(snap, Obj{"expectedRevision": 0, "addTag": "old-root-only"})
		})
		writeDone <- err
	}()
	<-entered
	switchDone := make(chan error, 1)
	go func() { _, err := s.activateRoot(nextRoot, false, false); switchDone <- err }()
	select {
	case err := <-switchDone:
		close(release)
		t.Fatal("root switch bypassed metadata gate", err)
	case <-time.After(20 * time.Millisecond):
	}
	if s.snapshot().Root != root {
		close(release)
		t.Fatal("root changed before commit")
	}
	close(release)
	for _, done := range []chan error{writeDone, switchDone} {
		select {
		case err := <-done:
			if err != nil {
				t.Fatal(err)
			}
		case <-time.After(3 * time.Second):
			t.Fatal("root/meta deadlock")
		}
	}
	if _, err := os.Stat(filepath.Join(nextRoot, ".viewer-meta.json")); !os.IsNotExist(err) {
		t.Fatal("old write leaked into new root", err)
	}
	w, out := call(t, s, http.MethodPut, "/api/meta", Obj{"expectedRoot": root, "expectedRevision": 1, "addTag": "late"}, false)
	if w.Code != 409 || str(out["code"]) != "library_changed" {
		t.Fatal("late old-root write accepted", w.Code, out)
	}
}

func TestMetadataWriteStopDoesNotCancelDescriptiveCommit(t *testing.T) {
	s, root := fixture(t)
	if _, err := s.reserveDownload(Obj{"root": root}); err != nil {
		t.Fatal(err)
	}
	var wg sync.WaitGroup
	wg.Add(2)
	go func() { defer wg.Done(); s.stopDownloads() }()
	go func() {
		defer wg.Done()
		w, out := call(t, s, http.MethodPut, "/api/meta", Obj{"expectedRoot": root, "expectedRevision": 0, "addTag": "survives-stop"}, false)
		if w.Code != 200 {
			t.Error(w.Code, out)
		}
	}()
	done := make(chan struct{})
	go func() { wg.Wait(); close(done) }()
	select {
	case <-done:
	case <-time.After(3 * time.Second):
		t.Fatal("stop/meta deadlock")
	}
	m, err := loadMeta(root)
	if err != nil || num(m["revision"]) != 1 {
		t.Fatal("stop lost metadata write", m, err)
	}
}

func TestMetadataWriteUsesOwnPermanentLease(t *testing.T) {
	s, root := fixture(t)
	gallery, err := acquireLease(root, ".viewer-write.lock")
	if err != nil {
		t.Fatal(err)
	}
	defer gallery.Close()
	meta, err := acquireLease(root, ".viewer-meta.lock")
	if err != nil {
		t.Fatal(err)
	}
	p := Obj{"expectedRoot": root, "expectedRevision": 0, "addTag": "independent"}
	w, out := call(t, s, http.MethodPut, "/api/meta", p, false)
	if w.Code != 423 || str(out["code"]) != "meta_busy" {
		meta.Close()
		t.Fatal("metadata contention missing diagnostic", w.Code, out)
	}
	meta.Close()
	w, out = call(t, s, http.MethodPut, "/api/meta", p, false)
	if w.Code != 200 {
		t.Fatal("gallery lease blocked metadata domain", w.Code, out)
	}
	p["expectedRoot"] = t.TempDir()
	w, out = call(t, s, http.MethodPut, "/api/meta", p, false)
	if w.Code != 409 || str(out["code"]) != "library_changed" {
		t.Fatal(w.Code, out)
	}
	free, err := acquireLease(root, ".viewer-meta.lock")
	if err != nil {
		t.Fatal("metadata lease was not released", err)
	}
	free.Close()
}
