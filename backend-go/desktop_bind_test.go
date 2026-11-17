package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

// Exercise the exact PUT and session-header contract emitted by backend.rs,
// not a direct call to the Go implementation.
func desktopBindCall(t *testing.T, s *Server, payload Obj, auth string) (*httptest.ResponseRecorder, Obj) {
	t.Helper()
	data, err := json.Marshal(payload)
	if err != nil {
		t.Fatal(err)
	}
	r := httptest.NewRequest(http.MethodPut, s.origin+"/api/download/bind", bytes.NewReader(data))
	r.Header.Set("Origin", s.origin)
	r.Header.Set("Content-Type", "application/json")
	switch auth {
	case "native":
		r.Header.Set("X-Viewer-Session", s.boot.Token)
	case "admin":
		r.Header.Set("X-Giv-Admin", s.boot.Secret)
	case "cookie":
		r.AddCookie(&http.Cookie{Name: s.cookie, Value: s.boot.Token})
	case "bad":
		r.Header.Set("X-Viewer-Session", "invalid")
		r.AddCookie(&http.Cookie{Name: s.cookie, Value: s.boot.Token})
	}
	w := httptest.NewRecorder()
	s.ServeHTTP(w, r)
	out, _ := decode(w.Body.Bytes())
	return w, out
}

func TestDesktopAccountBindingContract(t *testing.T) {
	s, root := fixture(t)
	s.boot.DownloadBindOnly = true
	file := filepath.Join(root, ".viewer-meta.json")
	before := defaultMeta()
	before["tags"] = []any{"ACG", "keep-me"}
	before["items"] = Obj{"asset-one": Obj{"fav": true, "tags": []any{"keep-me"}}}
	jsonFixture(t, file, before)
	original, _ := os.ReadFile(file)
	p := Obj{"expectedRoot": root, "grokUserId": "user-one", "commit": false}
	w, out := desktopBindCall(t, s, p, "native")
	if w.Code != 200 || !yes(out["ok"]) || yes(out["bound"]) || !sameRoot(str(out["root"]), root) {
		t.Fatalf("preflight: %d %s", w.Code, w.Body.String())
	}
	current, _ := os.ReadFile(file)
	if !bytes.Equal(original, current) {
		t.Fatal("preflight changed metadata")
	}
	p["commit"] = true
	w, out = desktopBindCall(t, s, p, "native")
	if w.Code != 200 || !yes(out["bound"]) {
		t.Fatalf("commit: %d %s", w.Code, w.Body.String())
	}
	meta, err := loadMeta(root)
	if err != nil || str(meta["grokUserId"]) != "user-one" || num(meta["revision"]) != 1 {
		t.Fatalf("meta: %#v %v", meta, err)
	}
	if !yes(obj(obj(meta["items"])["asset-one"])["fav"]) || len(arr(meta["tags"])) != 2 {
		t.Fatal("binding lost favorites or tags")
	}
	bound, _ := os.ReadFile(file)
	w, _ = desktopBindCall(t, s, p, "native")
	current, _ = os.ReadFile(file)
	if w.Code != 200 || !bytes.Equal(bound, current) {
		t.Fatal("same-account binding was not idempotent")
	}
	p["grokUserId"] = "user-two"
	for _, commit := range []bool{false, true} {
		p["commit"] = commit
		w, out = desktopBindCall(t, s, p, "native")
		current, _ = os.ReadFile(file)
		if w.Code != 409 || str(out["code"]) != "account_mismatch" || !bytes.Equal(bound, current) {
			t.Fatalf("mismatch changed data: %d %#v", w.Code, out)
		}
	}
}

func TestDesktopBindingRejectsRendererAndMalformedRequests(t *testing.T) {
	for _, auth := range []string{"", "cookie", "bad"} {
		t.Run("auth-"+auth, func(t *testing.T) {
			s, root := fixture(t)
			s.boot.DownloadBindOnly = true
			w, _ := desktopBindCall(t, s, Obj{"expectedRoot": root, "grokUserId": "user-one", "commit": true}, auth)
			if w.Code != 403 {
				t.Fatalf("auth %q: got %d", auth, w.Code)
			}
			if exists(filepath.Join(root, ".viewer-meta.json")) {
				t.Fatal("unauthorized binding wrote metadata")
			}
		})
	}
	for _, bad := range []Obj{
		{"grokUserId": " "}, {"grokUserId": "user one"}, {"grokUserId": "../user"}, {"grokUserId": 7},
		{"expectedRoot": "relative"}, {"commit": "true"}, {"commit": 1}, {"commit": nil},
	} {
		t.Run("invalid", func(t *testing.T) {
			s, root := fixture(t)
			s.boot.DownloadBindOnly = true
			p := Obj{"expectedRoot": root, "grokUserId": "user-one", "commit": true}
			for k, v := range bad {
				p[k] = v
			}
			w, _ := desktopBindCall(t, s, p, "native")
			if w.Code != 400 {
				t.Fatalf("got %d for %#v", w.Code, bad)
			}
			if exists(filepath.Join(root, ".viewer-meta.json")) {
				t.Fatal("bad request wrote metadata")
			}
		})
	}
}

func TestDesktopBindingRejectsWrongRootModeAndBusyLibrary(t *testing.T) {
	s, root := fixture(t)
	s.boot.DownloadBindOnly = true
	p := Obj{"expectedRoot": t.TempDir(), "grokUserId": "user-one", "commit": true}
	w, out := desktopBindCall(t, s, p, "native")
	if w.Code != 409 || str(out["code"]) != "library_changed" {
		t.Fatalf("wrong root: %d %#v", w.Code, out)
	}
	p["expectedRoot"] = root
	s.mu.Lock()
	s.mode = "single"
	s.mu.Unlock()
	w, out = desktopBindCall(t, s, p, "native")
	if w.Code != 409 || str(out["code"]) != "unsupported_mode" {
		t.Fatalf("wrong mode: %d %#v", w.Code, out)
	}
	s.mu.Lock()
	s.mode = "index"
	s.mu.Unlock()
	lease, err := acquireLease(root, ".viewer-write.lock")
	if err != nil {
		t.Fatal(err)
	}
	w, _ = desktopBindCall(t, s, p, "native")
	lease.Close()
	if w.Code != 423 {
		t.Fatalf("write lock was bypassed: %d", w.Code)
	}
	if exists(filepath.Join(root, ".viewer-meta.json")) {
		t.Fatal("refused binding wrote metadata")
	}
}

func TestDesktopBindingPreservesCorruptAndExhaustedMetadata(t *testing.T) {
	for _, raw := range []string{`{broken`, `{"version":2,"revision":9007199254740991,"grokUserId":"","items":{},"groups":{}}`} {
		s, root := fixture(t)
		s.boot.DownloadBindOnly = true
		file := filepath.Join(root, ".viewer-meta.json")
		writeFixture(t, file, []byte(raw))
		w, _ := desktopBindCall(t, s, Obj{"expectedRoot": root, "grokUserId": "user-one", "commit": true}, "native")
		after, _ := os.ReadFile(file)
		if w.Code != 409 || string(after) != raw {
			t.Fatalf("unsafe metadata rewrite: %d", w.Code)
		}
	}
}

func TestDesktopBindingConcurrentAccounts(t *testing.T) {
	s, root := fixture(t)
	s.boot.DownloadBindOnly = true
	var wg sync.WaitGroup
	statuses := make(chan int, 2)
	for _, id := range []string{"user-one", "user-two"} {
		wg.Add(1)
		go func(id string) {
			defer wg.Done()
			w, _ := desktopBindCall(t, s, Obj{"expectedRoot": root, "grokUserId": id, "commit": true}, "native")
			statuses <- w.Code
		}(id)
	}
	wg.Wait()
	close(statuses)
	counts := map[int]int{}
	for code := range statuses {
		counts[code]++
	}
	if counts[200] != 1 || counts[409] != 1 {
		t.Fatalf("concurrent outcome: %#v", counts)
	}
	meta, err := loadMeta(root)
	if err != nil || num(meta["revision"]) != 1 || !strings.HasPrefix(str(meta["grokUserId"]), "user-") {
		t.Fatal("invalid concurrent binding")
	}
}

func TestDesktopRestoreSelectedRoot(t *testing.T) {
	s, root := fixture(t)
	s.boot.Root = root
	s.mu.Lock()
	s.root = ""
	s.mode = "empty"
	s.generation++
	s.mu.Unlock()
	if err := s.restoreSelectedRoot(); err != nil || !sameRoot(s.snapshot().Root, root) {
		t.Fatalf("explicit startup gallery not selected: %v", err)
	}
	s.boot.Root = filepath.Join(t.TempDir(), "absent-explicit-root")
	if err := s.restoreSelectedRoot(); err == nil {
		t.Fatal("explicit missing root silently fell back")
	}
}

func TestDesktopOfflineRootRetainsConfiguration(t *testing.T) {
	s, _ := fixture(t)
	missing := filepath.Join(t.TempDir(), "offline")
	s.cfgMu.Lock()
	s.cfg["root"] = missing
	err := atomicJSON(s.boot.Config, s.cfg)
	s.cfgMu.Unlock()
	if err != nil {
		t.Fatal(err)
	}
	before, _ := os.ReadFile(s.boot.Config)
	s.mu.Lock()
	s.root = ""
	s.mode = "empty"
	s.generation++
	s.mu.Unlock()
	if err = s.restoreSelectedRoot(); err != nil {
		t.Fatal("offline history prevented startup")
	}
	after, _ := os.ReadFile(s.boot.Config)
	if !bytes.Equal(before, after) || s.snapshot().Root != "" {
		t.Fatal("offline history was changed")
	}
}

func TestDesktopRestoreDefersLibraryHydration(t *testing.T) {
	for _, explicit := range []bool{false, true} {
		t.Run(fmt.Sprint("explicit-", explicit), func(t *testing.T) {
			s, root := fixture(t)
			// The fixture has already loaded cards through interactive selection.
			s.invalidate()
			s.mu.Lock()
			s.root, s.mode = "", "empty"
			s.generation++
			s.mu.Unlock()
			if explicit {
				s.boot.Root = root
			}
			before, err := os.ReadFile(s.boot.Config)
			if err != nil {
				t.Fatal(err)
			}
			if err := s.restoreSelectedRoot(); err != nil {
				t.Fatal(err)
			}
			if explicit {
				if !sameRoot(s.snapshot().Root, root) || s.snapshot().Mode != "index" {
					t.Fatal("startup lost the explicit gallery")
				}
			} else if s.snapshot().Root != "" || s.snapshot().Mode != "empty" {
				t.Fatal("saved gallery bypassed the launcher")
			}
			s.cacheMu.Lock()
			cached := len(s.groups)
			s.cacheMu.Unlock()
			if cached != 0 {
				t.Fatal("startup eagerly read group members before readiness")
			}
			after, err := os.ReadFile(s.boot.Config)
			if err != nil || !bytes.Equal(before, after) {
				t.Fatal("restoring the current root rewrote configuration")
			}
			if !explicit {
				w, out := call(t, s, http.MethodPut, "/api/root", Obj{"root": root}, false)
				if w.Code != 200 || !yes(out["ok"]) {
					t.Fatalf("recent gallery selection failed: %d %#v", w.Code, out)
				}
			}
			// Card hydration remains available through the normal gallery request.
			w, lib := call(t, s, http.MethodGet, "/api/library", nil, false)
			if w.Code != 200 || len(rows(lib["combos"])) != 1 || num(rows(lib["combos"])[0]["count"]) != 2 || !yes(lib["live"]) {
				t.Fatalf("library did not hydrate after startup: %d %#v", w.Code, lib)
			}
		})
	}
}

func TestDesktopDefaultStartupPreservesRecentLocationsWithoutSelecting(t *testing.T) {
	for _, corrupt := range []bool{false, true} {
		t.Run(fmt.Sprint("corrupt-index-", corrupt), func(t *testing.T) {
			s, root := fixture(t)
			missing := filepath.Join(t.TempDir(), "offline-recent")
			s.cfgMu.Lock()
			s.cfg["history"] = []any{root, missing}
			jsonFixture(t, s.boot.Config, s.cfg)
			s.cfgMu.Unlock()
			before, err := os.ReadFile(s.boot.Config)
			if err != nil {
				t.Fatal(err)
			}
			if corrupt {
				writeFixture(t, filepath.Join(root, "_index.json"), []byte("{broken"))
			}
			s.invalidate()
			s.mu.Lock()
			s.root, s.mode = "", "empty"
			s.generation++
			s.mu.Unlock()
			snapshot, request := s.snapshot(), s.rootRequest.Load()
			if err := s.restoreSelectedRoot(); err != nil {
				t.Fatal(err)
			}
			if s.snapshot() != snapshot || s.rootRequest.Load() != request {
				t.Fatal("default startup attempted to select or scan a saved gallery")
			}
			cfg, err := s.config(true)
			if err != nil || str(cfg["root"]) != "" {
				t.Fatal("minimal config exposes a saved root as active", cfg, err)
			}
			// History remains available without reading the saved gallery's index.
			history := s.history()
			if len(history) != 2 || str(obj(history[0])["path"]) != root || !yes(obj(history[0])["exists"]) || str(obj(history[1])["path"]) != missing || yes(obj(history[1])["exists"]) {
				t.Fatal("recent locations or missing-path state lost", history)
			}
			after, err := os.ReadFile(s.boot.Config)
			if err != nil || !bytes.Equal(before, after) {
				t.Fatal("default startup changed the saved configuration")
			}
		})
	}
}

func TestDesktopRestoreKeepsCorruptMetadataForGalleryError(t *testing.T) {
	s, root := fixture(t)
	meta := filepath.Join(root, ".viewer-meta.json")
	writeFixture(t, meta, []byte("{broken"))
	s.boot.Root = root
	if err := s.restoreSelectedRoot(); err != nil {
		t.Fatalf("metadata prevented service readiness: %v", err)
	}
	w, out := call(t, s, http.MethodGet, "/api/library", nil, false)
	if w.Code != 200 || !yes(out["ok"]) || out["metaKnown"] != false || str(out["metaError"]) == "" || len(rows(out["combos"])) != 1 || num(rows(out["combos"])[0]["count"]) != 2 {
		t.Fatalf("gallery did not retain read-only media with a metadata warning: %d %#v", w.Code, out)
	}
	w, out = call(t, s, http.MethodGet, "/api/combo?section=combos&folder=0001_aaaaaaaa", nil, false)
	if w.Code != 200 || out["metaKnown"] != false || len(rows(out["items"])) != 2 {
		t.Fatalf("preserved bad metadata prevented ordinary media browsing: %d %#v", w.Code, out)
	}
	w, out = call(t, s, http.MethodPut, "/api/meta", Obj{"expectedRoot": root, "expectedRevision": 0, "item": Obj{"id": "asset-one", "fav": true}}, false)
	if w.Code != 409 || str(out["code"]) != "store_corrupt" {
		t.Fatalf("display fallback authorized a metadata write: %d %#v", w.Code, out)
	}
	if contents, err := os.ReadFile(meta); err != nil || string(contents) != "{broken" {
		t.Fatal("startup changed corrupt metadata")
	}
}
