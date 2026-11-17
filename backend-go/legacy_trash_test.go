package main

import (
	"bytes"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"testing"
)

func legacyTrashFixture(t *testing.T, s *Server, root string) (string, string, string) {
	t.Helper()
	origin := filepath.Join(root, "combos", "0001_aaaaaaaa", "asset-one.jpg")
	body := filepath.Join(root, ".trash", "combos", "0001_aaaaaaaa", "asset-one.jpg")
	writeFixture(t, body, jpg)
	if err := os.Remove(origin); err != nil {
		t.Fatal(err)
	}
	record := filepath.Join(root, ".trash", "by-id", "asset-one.json")
	jsonFixture(t, record, Obj{"id": "asset-one", "file": "asset-one.jpg", "section": "combos", "folder": "0001_aaaaaaaa", "from": "combos/0001_aaaaaaaa/asset-one.jpg", "to": ".trash/combos/0001_aaaaaaaa/asset-one.jpg", "deletedAt": "2026-01-02T00:00:00Z"})
	marker := origin + ".trashed"
	jsonFixture(t, marker, Obj{"id": "asset-one", "file": "asset-one.jpg"})
	s.invalidate()
	return record, marker, body
}

func legacyPreview(t *testing.T, s *Server, root string) (int, Obj) {
	t.Helper()
	w, out := call(t, s, http.MethodGet, "/api/trash/legacy/preview?id=asset-one&expectedRoot="+url.QueryEscape(root), nil, false)
	return w.Code, out
}

func TestLegacyTrashDiscoveryAndPreviewAreReadOnly(t *testing.T) {
	s, root := fixture(t)
	record, marker, body := legacyTrashFixture(t, s, root)
	before := map[string][]byte{}
	for _, path := range []string{record, marker, body} {
		before[path], _ = os.ReadFile(path)
	}
	w, listing := call(t, s, http.MethodGet, "/api/trash", nil, false)
	legacy := rows(listing["legacyItems"])
	if w.Code != 200 || len(legacy) != 1 || !yes(legacy[0]["legacy"]) || yes(legacy[0]["recoverable"]) || str(legacy[0]["id"]) != "asset-one" {
		t.Fatalf("legacy record was not discoverable with a separate recovery boundary: %d %#v", w.Code, listing)
	}
	status, preview := legacyPreview(t, s, root)
	if status != 200 || !yes(preview["ok"]) || !yes(preview["verified"]) || yes(preview["recoverable"]) || str(preview["hash"]) != hash(jpg) || str(preview["recoveryHint"]) == "" {
		t.Fatalf("missing verified read-only preview and recovery instructions: %d %#v", status, preview)
	}
	for _, endpoint := range []string{"/api/trash/restore", "/api/trash/purge"} {
		_, out := call(t, s, http.MethodPost, endpoint, Obj{"expectedRoot": root, "ids": []any{"asset-one"}}, false)
		if len(arr(out["restored"])) != 0 || len(arr(out["purged"])) != 0 || len(arr(out["errors"])) != 1 {
			t.Fatalf("legacy evidence authorized a strict write: %#v", out)
		}
	}
	for path, data := range before {
		current, err := os.ReadFile(path)
		if err != nil || !bytes.Equal(current, data) {
			t.Fatalf("legacy evidence changed: %s %v", path, err)
		}
	}
}

func TestLegacyTrashPreviewRefusesUnprovenOwnership(t *testing.T) {
	for _, kind := range []string{"outside", "identity", "card-missing", "card-conflict", "marker-conflict", "body-missing", "target-conflict", "fingerprint"} {
		t.Run(kind, func(t *testing.T) {
			s, root := fixture(t)
			record, marker, body := legacyTrashFixture(t, s, root)
			tomb, _ := readJSON(record)
			switch kind {
			case "outside":
				tomb["to"] = "../outside.jpg"
				jsonFixture(t, record, tomb)
			case "identity":
				tomb["id"] = "asset-two"
				jsonFixture(t, record, tomb)
			case "card-missing":
				os.Remove(filepath.Join(root, "combos", "0001_aaaaaaaa", "card.json"))
			case "card-conflict":
				jsonFixture(t, filepath.Join(root, "combos", "0001_aaaaaaaa", "card.json"), Obj{"items": []any{Obj{"id": "different-id", "file": "asset-one.jpg"}}})
			case "marker-conflict":
				jsonFixture(t, marker, Obj{"id": "different-id", "file": "asset-one.jpg"})
			case "body-missing":
				os.Remove(body)
			case "target-conflict":
				writeFixture(t, marker[:len(marker)-len(".trashed")], jpg)
			case "fingerprint":
				tomb["hash"] = "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"
				jsonFixture(t, record, tomb)
			}
			original, _ := os.ReadFile(record)
			status, out := legacyPreview(t, s, root)
			if status != 200 || !yes(out["ok"]) || yes(out["verified"]) || yes(out["recoverable"]) || str(out["reason"]) == "" {
				t.Fatalf("unproven record looked verified: %d %#v", status, out)
			}
			current, _ := os.ReadFile(record)
			if !bytes.Equal(current, original) {
				t.Fatal("preview changed the original record")
			}
		})
	}
}

func TestLegacyTrashPreviewRejectsWrongRootAndInvalidModernToken(t *testing.T) {
	s, root := fixture(t)
	record, _, _ := legacyTrashFixture(t, s, root)
	w, _ := call(t, s, http.MethodGet, "/api/trash/legacy/preview?id=asset-one&expectedRoot="+url.QueryEscape(t.TempDir()), nil, false)
	if w.Code != 409 {
		t.Fatal("wrong-root preview was accepted", w.Code)
	}
	tomb, _ := readJSON(record)
	tomb["token"] = "invalid-modern-token"
	jsonFixture(t, record, tomb)
	status, _ := legacyPreview(t, s, root)
	if status != 404 {
		t.Fatal("invalid modern token was downgraded into legacy format", status)
	}
}
