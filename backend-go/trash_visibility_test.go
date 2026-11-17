package main

import (
	"bytes"
	"net/http"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func trashVisibilityFixture(t *testing.T, s *Server, root, id string, body []byte) string {
	t.Helper()
	path := filepath.Join(root, ".trash", "by-id", id+".json")
	writeFixture(t, path, body)
	s.invalidate()
	return path
}

func assertTrashBytesRetained(t *testing.T, path string, body []byte) {
	t.Helper()
	if current, err := os.ReadFile(path); err != nil || !bytes.Equal(current, body) {
		t.Fatalf("bad recovery evidence changed: %s %v", path, err)
	}
}

func TestTrashVisibilityUnrelatedCorruptionDoesNotHideMedia(t *testing.T) {
	s, root := fixture(t)
	bad := []byte("{broken recovery record")
	path := trashVisibilityFixture(t, s, root, "unrelated", bad)
	for _, endpoint := range []string{"/api/combo?section=combos&folder=0001_aaaaaaaa", "/api/flat"} {
		w, out := call(t, s, http.MethodGet, endpoint, nil, false)
		if w.Code != http.StatusOK || !yes(out["ok"]) || len(rows(out["items"])) != 2 {
			t.Fatalf("unrelated bad record hid normal items: %s %d %#v", endpoint, w.Code, out)
		}
		if len(arr(out["trashIssues"])) != 1 || str(rows(out["trashIssues"])[0]["id"]) != "unrelated" {
			t.Fatalf("missing per-record diagnostics: %#v", out)
		}
	}
	w, out := call(t, s, http.MethodGet, "/api/library", nil, false)
	if w.Code != 200 || num(rows(out["combos"])[0]["count"]) != 2 {
		t.Fatal("library looked empty after unrelated record corruption", w.Code, out)
	}
	for _, file := range []string{"asset-one.jpg", "asset-two.jpg"} {
		w, _ = call(t, s, http.MethodGet, "/media/combos/0001_aaaaaaaa/"+file, nil, false)
		if w.Code != http.StatusOK || !bytes.Equal(w.Body.Bytes(), jpg) {
			t.Fatalf("normal media unavailable: %s %d", file, w.Code)
		}
	}
	assertTrashBytesRetained(t, path, bad)
}

func TestTrashVisibilityBadIDIsUnavailableNotEmpty(t *testing.T) {
	s, root := fixture(t)
	bad := []byte("{bad asset-one record")
	path := trashVisibilityFixture(t, s, root, "asset-one", bad)
	w, out := call(t, s, http.MethodGet, "/api/combo?section=combos&folder=0001_aaaaaaaa", nil, false)
	if w.Code != 200 || len(rows(out["items"])) != 1 || str(rows(out["items"])[0]["id"]) != "asset-two" {
		t.Fatal("bad ID contaminated healthy sibling", w.Code, out)
	}
	card := obj(out["card"])
	if str(card["state"]) != "unavailable" || !yes(card["unavailable"]) || card["countKnown"] != false {
		t.Fatal("unknown visibility advertised as a normal available card", card)
	}
	if _, hasCount := card["count"]; hasCount {
		t.Fatal("unknown count must not be published as an exact count", card)
	}
	w, errOut := call(t, s, http.MethodGet, "/media/combos/0001_aaaaaaaa/asset-one.jpg", nil, false)
	if w.Code != 503 || str(errOut["code"]) != "trash_record_corrupt" || errOut["countKnown"] != false {
		t.Fatal("unknown visibility was misreported as deleted or available", w.Code, errOut)
	}
	w, _ = call(t, s, http.MethodGet, "/media/combos/0001_aaaaaaaa/asset-two.jpg", nil, false)
	if w.Code != 200 {
		t.Fatal("unrelated healthy media blocked", w.Code)
	}
	w, cards := call(t, s, http.MethodPost, "/api/cards", Obj{"section": "combos", "folders": []any{"0001_aaaaaaaa"}}, false)
	if w.Code != 200 || rows(cards["cards"])[0]["countKnown"] != false {
		t.Fatal("cards discarded unknown visibility state", cards)
	}
	w, flat := call(t, s, http.MethodGet, "/api/flat", nil, false)
	if w.Code != 200 || len(rows(flat["items"])) != 1 || len(rows(flat["unavailableGroups"])) != 1 {
		t.Fatal("flat lost healthy media or diagnostics", flat)
	}
	for _, endpoint := range []string{"/api/trash/restore", "/api/trash/purge"} {
		w, result := call(t, s, http.MethodPost, endpoint, Obj{"expectedRoot": root, "ids": []any{"asset-one"}}, true)
		if w.Code != 200 || len(rows(result["errors"])) != 1 {
			t.Fatal("corrupt record bypassed strict recovery", endpoint, w.Code, result)
		}
		assertTrashBytesRetained(t, path, bad)
	}
	if current, err := os.ReadFile(filepath.Join(root, "combos", "0001_aaaaaaaa", "asset-one.jpg")); err != nil || !bytes.Equal(current, jpg) {
		t.Fatal("unproven mutation touched live media", err)
	}
}

func TestTrashVisibilityAllUnknownDoesNotPublishZero(t *testing.T) {
	s, root := fixture(t)
	for _, id := range []string{"asset-one", "asset-two"} {
		trashVisibilityFixture(t, s, root, id, []byte("{broken"))
	}
	w, out := call(t, s, http.MethodGet, "/api/combo?section=combos&folder=0001_aaaaaaaa", nil, false)
	card := obj(out["card"])
	if w.Code != 200 || len(rows(out["items"])) != 0 || card["countKnown"] != false || !yes(card["unavailable"]) {
		t.Fatal("unknown visibility is not an available empty group", w.Code, out)
	}
	if _, ok := card["count"]; ok {
		t.Fatal("unknown group must not carry a false zero count", card)
	}
	w, lib := call(t, s, http.MethodGet, "/api/library", nil, false)
	if w.Code != 200 || num(rows(lib["combos"])[0]["count"]) != 2 || rows(lib["combos"])[0]["countKnown"] != false {
		t.Fatal("library lost its last known summary", lib)
	}
}

func TestTrashVisibilityDirectoryFailureIsExplicit(t *testing.T) {
	s, root := fixture(t)
	path := filepath.Join(root, ".trash", "by-id")
	body := []byte("not a directory; preserve this evidence")
	writeFixture(t, path, body)
	s.invalidate()
	for _, endpoint := range []string{"/api/library", "/api/combo?section=combos&folder=0001_aaaaaaaa", "/api/flat", "/media/combos/0001_aaaaaaaa/asset-one.jpg"} {
		w, out := call(t, s, http.MethodGet, endpoint, nil, false)
		if w.Code != 503 || str(out["code"]) != "trash_unavailable" || str(out["state"]) != "unavailable" || out["countKnown"] != false {
			t.Fatalf("directory failure looked like empty/deleted media: %s %d %#v", endpoint, w.Code, out)
		}
	}
	assertTrashBytesRetained(t, path, body)
}

func TestTrashVisibilityKnownDeletedItemStaysHiddenWithBadNeighbor(t *testing.T) {
	s, root := fixture(t)
	w, moved := call(t, s, http.MethodPost, "/api/trash", Obj{"expectedRoot": root, "section": "combos", "folder": "0001_aaaaaaaa", "ids": []any{"asset-one"}}, true)
	if w.Code != 200 || len(rows(moved["moved"])) != 1 {
		t.Fatal(moved)
	}
	trashVisibilityFixture(t, s, root, "unrelated", []byte("{broken"))
	w, out := call(t, s, http.MethodGet, "/api/combo?section=combos&folder=0001_aaaaaaaa", nil, false)
	if w.Code != 200 || len(rows(out["items"])) != 1 || str(rows(out["items"])[0]["id"]) != "asset-two" {
		t.Fatal("confirmed deletion leaked or healthy media disappeared", out)
	}
	w, out = call(t, s, http.MethodGet, "/media/combos/0001_aaaaaaaa/asset-one.jpg", nil, false)
	if w.Code != 404 || str(out["code"]) != "trashed" {
		t.Fatal("known deleted file must stay hidden", w.Code, out)
	}
}

func TestTrashVisibilityMismatchedRecordCannotAffectAnotherID(t *testing.T) {
	s, root := fixture(t)
	bad := []byte(`{"id":"asset-two","phase":"trashed"}`)
	path := trashVisibilityFixture(t, s, root, "asset-one", bad)
	w, out := call(t, s, http.MethodGet, "/api/combo?section=combos&folder=0001_aaaaaaaa", nil, false)
	if w.Code != 200 || len(rows(out["items"])) != 1 || str(rows(out["items"])[0]["id"]) != "asset-two" {
		t.Fatal("untrusted record identity escaped its filename binding", out)
	}
	assertTrashBytesRetained(t, path, bad)
}

func TestTrashVisibilityCachedDirectoryFaultsRemainUnavailable(t *testing.T) {
	for _, fault := range []error{os.ErrPermission, os.ErrClosed} {
		t.Run(fault.Error(), func(t *testing.T) {
			s, _ := fixture(t)
			snap := s.snapshot()
			// The read cache stores directory errors from permission/network I/O.
			// Inject that completed-read state to exercise the HTTP policy on all
			// platforms, including Windows where chmod does not deny directory I/O.
			s.trashMu.Lock()
			s.trashRead = trashReadCache{root: snap.Root, generation: snap.Generation, at: time.Now(), err: fault}
			s.trashMu.Unlock()
			for _, endpoint := range []string{"/api/library", "/api/combo?section=combos&folder=0001_aaaaaaaa", "/api/flat", "/media/combos/0001_aaaaaaaa/asset-one.jpg"} {
				w, out := call(t, s, http.MethodGet, endpoint, nil, false)
				if w.Code != 503 || str(out["code"]) != "trash_unavailable" || out["countKnown"] != false {
					t.Fatal("cached directory fault became an empty or deleted result", endpoint, w.Code, out)
				}
			}
			s.invalidate()
			w, out := call(t, s, http.MethodGet, "/api/combo?section=combos&folder=0001_aaaaaaaa", nil, false)
			if w.Code != 200 || len(rows(out["items"])) != 2 {
				t.Fatal("a transient directory fault poisoned later healthy reads", out)
			}
		})
	}
}

func TestTrashVisibilityRecoversAfterRecordRepair(t *testing.T) {
	s, root := fixture(t)
	path := trashVisibilityFixture(t, s, root, "asset-one", []byte("{broken"))
	w, out := call(t, s, http.MethodGet, "/api/combo?section=combos&folder=0001_aaaaaaaa", nil, false)
	if w.Code != 200 || obj(out["card"])["countKnown"] != false {
		t.Fatal(out)
	}
	// This is our synthetic damaged fixture, not a historical/user record.
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	s.invalidate()
	w, out = call(t, s, http.MethodGet, "/api/combo?section=combos&folder=0001_aaaaaaaa", nil, false)
	if w.Code != 200 || len(rows(out["items"])) != 2 || yes(obj(out["card"])["unavailable"]) || len(arr(out["warnings"])) != 0 {
		t.Fatal("repaired deletion evidence remained unavailable", out)
	}
}
