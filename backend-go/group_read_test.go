package main

import (
	"bytes"
	"net/http"
	"os"
	"path/filepath"
	"testing"
)

// Includes a real missing directory and a file in place of a directory, so the
// unavailable assertion is portable and does not rely on POSIX permissions.
func partialReadFixture(t *testing.T) (*Server, string, string) {
	t.Helper()
	s, root := fixture(t)
	bad := filepath.Join(root, "combos", "bad-card", "card.json")
	writeFixture(t, filepath.Join(filepath.Dir(bad), "safe.jpg"), jpg)
	writeFixture(t, bad, []byte("{broken card"))
	writeFixture(t, filepath.Join(root, "combos", "blocked"), []byte("not a directory"))
	jsonFixture(t, filepath.Join(root, "_index.json"), Obj{"combos": []any{
		Obj{"folder": "0001_aaaaaaaa", "count": 2}, Obj{"folder": "missing", "count": 7},
		Obj{"folder": "blocked", "count": 9}, Obj{"folder": "bad-card", "count": 3},
	}, "other": []any{}})
	s.invalidate()
	return s, root, bad
}

func TestGroupReadBatchIsolatesMissingUnavailableAndCorrupt(t *testing.T) {
	s, root, bad := partialReadFixture(t)
	w, out := call(t, s, http.MethodPost, "/api/cards", Obj{"section": "combos", "folders": []any{"missing", "0001_aaaaaaaa", "blocked", "bad-card"}}, false)
	if w.Code != 200 || len(rows(out["cards"])) != 4 || str(out["root"]) != root || num(out["generation"]) == 0 {
		t.Fatal("one bad group discarded healthy cards", w.Code, out)
	}
	cards := rows(out["cards"])
	if !yes(cards[0]["gone"]) || cards[0]["countKnown"] != true || num(cards[0]["count"]) != 0 || num(cards[1]["count"]) != 2 {
		t.Fatal("missing/healthy group contract", cards)
	}
	if cards[2]["countKnown"] != false || str(cards[2]["state"]) != "unavailable" {
		t.Fatal("unreadable group is not empty", cards[2])
	}
	if _, ok := cards[2]["count"]; ok {
		t.Fatal("unknown count published as zero", cards[2])
	}
	if str(cards[3]["state"]) != "corrupt" || num(cards[3]["count"]) != 1 || str(cards[3]["title"]) != "" {
		t.Fatal("corrupt card did not produce safe media-only view", cards[3])
	}
	w, out = call(t, s, http.MethodGet, "/api/flat", nil, false)
	if w.Code != 200 || len(rows(out["items"])) != 3 || len(rows(out["unavailableGroups"])) != 1 || len(rows(out["groupIssues"])) != 3 {
		t.Fatal("flat discarded healthy items or error states", w.Code, out)
	}
	w, out = call(t, s, http.MethodGet, "/api/library", nil, false)
	if w.Code != 200 || len(rows(out["combos"])) != 4 || num(rows(out["combos"])[2]["count"]) != 9 || rows(out["combos"])[2]["countKnown"] != false {
		t.Fatal("library lost unknown group's last known summary", w.Code, out)
	}
	if b, err := os.ReadFile(bad); err != nil || !bytes.Equal(b, []byte("{broken card")) {
		t.Fatal("read fallback overwrote corrupt card", err)
	}
	// A display cache must never become authority for destructive callers.
	if _, _, err := s.readGroup(s.snapshot(), "combos", "bad-card"); err == nil {
		t.Fatal("strict read consumed permissive display cache")
	}
	w, out = call(t, s, http.MethodPost, "/api/trash", Obj{"expectedRoot": root, "section": "combos", "folder": "bad-card", "ids": []any{"safe"}}, false)
	if w.Code != 200 || len(rows(out["moved"])) != 0 || len(rows(out["errors"])) != 1 {
		t.Fatal("corrupt display card authorized destructive mutation", w.Code, out)
	}
	if b, err := os.ReadFile(filepath.Join(filepath.Dir(bad), "safe.jpg")); err != nil || !bytes.Equal(b, jpg) {
		t.Fatal("fallback media was changed", err)
	}
	// Repair is observable immediately instead of remaining a permanent fallback.
	jsonFixture(t, bad, Obj{"title": "repaired", "items": []any{Obj{"id": "real-id", "file": "safe.jpg", "prompt": "restored prompt"}}})
	w, out = call(t, s, http.MethodGet, "/api/combo?section=combos&folder=bad-card", nil, false)
	if w.Code != 200 || str(obj(out["card"])["state"]) != "available" || str(rows(out["items"])[0]["prompt"]) != "restored prompt" {
		t.Fatal("card repair remained stale", w.Code, out)
	}
}

func TestGroupReadCorruptMetadataStillBrowsesButCannotWrite(t *testing.T) {
	for _, raw := range []string{"{broken meta", `{"version":99,"revision":9}`} {
		t.Run(raw, func(t *testing.T) {
			s, root := fixture(t)
			path := filepath.Join(root, ".viewer-meta.json")
			writeFixture(t, path, []byte(raw))
			for _, endpoint := range []string{"/api/meta", "/api/library", "/api/combo?section=combos&folder=0001_aaaaaaaa", "/api/flat"} {
				w, out := call(t, s, http.MethodGet, endpoint, nil, false)
				if w.Code != 200 || out["metaKnown"] != false || str(out["metaError"]) == "" {
					t.Fatal("metadata corruption blocked ordinary browsing or looked authoritative", endpoint, w.Code, out)
				}
			}
			w, out := call(t, s, http.MethodPost, "/api/cards", Obj{"section": "combos", "folders": []any{"0001_aaaaaaaa"}}, false)
			if w.Code != 200 || rows(out["cards"])[0]["metaKnown"] != false {
				t.Fatal("cards metadata must be unknown", w.Code, out)
			}
			w, _ = call(t, s, http.MethodPut, "/api/meta", Obj{"expectedRoot": root, "expectedRevision": 0, "addTag": "do-not-save"}, false)
			if w.Code != 409 {
				t.Fatal("corrupt metadata write allowed", w.Code)
			}
			if b, err := os.ReadFile(path); err != nil || string(b) != raw {
				t.Fatal("corrupt metadata bytes changed", err)
			}
			m := defaultMeta()
			obj(m["items"])["asset-one"] = Obj{"fav": true}
			jsonFixture(t, path, m)
			w, out = call(t, s, http.MethodGet, "/api/combo?section=combos&folder=0001_aaaaaaaa", nil, false)
			if w.Code != 200 || out["metaKnown"] != true || str(out["metaError"]) != "" || !yes(rows(out["items"])[0]["fav"]) {
				t.Fatal("metadata repair remained degraded", w.Code, out)
			}
		})
	}
}

func TestGroupReadCorruptCardDiscoveryAcrossModes(t *testing.T) {
	for _, mode := range []string{"single", "loose", "combos"} {
		t.Run(mode, func(t *testing.T) {
			s, _ := fixture(t)
			root := t.TempDir()
			dir := root
			if mode == "loose" {
				dir = filepath.Join(root, "group")
			}
			if mode == "combos" {
				dir = filepath.Join(root, "combos", "group")
			}
			writeFixture(t, filepath.Join(dir, "safe.jpg"), jpg)
			writeFixture(t, filepath.Join(dir, "card.json"), []byte("{corrupt"))
			if _, err := s.activateRoot(root, false, true); err != nil {
				t.Fatal("corrupt card prevented discovery", err)
			}
			w, out := call(t, s, http.MethodGet, "/api/flat", nil, false)
			if w.Code != 200 || len(rows(out["items"])) != 1 || rows(out["items"])[0]["metadataKnown"] != false || str(rows(out["items"])[0]["prompt"]) != "" {
				t.Fatal("mode did not provide safe read view", w.Code, out)
			}
			if b, _ := os.ReadFile(filepath.Join(dir, "card.json")); string(b) != "{corrupt" {
				t.Fatal("discovery overwrote card")
			}
		})
	}
}
