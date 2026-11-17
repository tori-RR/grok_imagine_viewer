package main

import (
	"bytes"
	"crypto/sha256"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"
)

// Extraction is tested by the native manifest tests. This exercises its Go
// consumer end to end: an all-existing sync still refreshes each item's prompt
// without replacing media, losing local-only rows, or moving the group.
func TestPerMediaPromptSyncRefreshesExistingMediaWithoutTransfers(t *testing.T) {
	s, root := fixture(t)
	const folder = "0001_aaaaaaaa"
	const conversation = "conversation-aaaaaaaa"
	dir := filepath.Join(root, "combos", folder)
	cardPath := filepath.Join(dir, "card.json")
	card, err := readJSON(cardPath)
	if err != nil {
		t.Fatal(err)
	}
	groupTitle := str(card["title"])
	const wrong = "old shared prompt from the first item"
	items := rows(card["items"])
	for _, item := range items {
		item["prompt"] = wrong
	}
	video := []byte("\x00\x00\x00\x18ftypisom\x00\x00\x02\x00isomiso2\x00\x00\x00\x10mdat\x00\x00\x00\x00\x00\x00\x00\x00")
	writeFixture(t, filepath.Join(dir, "asset-three.mp4"), video)
	items = append(items, Obj{"id": "asset-three", "file": "asset-three.mp4", "mime": "video/mp4", "created": "2026-11-01T00:00:00Z", "prompt": wrong, "status": "linked"})
	localOnly := Obj{"id": "local-only", "file": "local-only.jpg", "mime": "image/jpeg", "created": "2026-11-02T00:00:00Z", "prompt": "local-only prompt must survive", "status": "linked", "externalField": Obj{"keep": true}}
	writeFixture(t, filepath.Join(dir, "local-only.jpg"), append(append([]byte{}, jpg...), 17))
	items = append(items, localOnly)
	card["items"] = asAny(items)
	card["count"] = len(items)
	card["externalGroupField"] = "preserve"
	jsonFixture(t, cardPath, card)
	jsonFixture(t, filepath.Join(root, "_index.json"), Obj{"combos": []any{summary(card, folder)}, "other": []any{}, "summary": Obj{}})
	s.invalidate()

	type mediaSnapshot struct {
		hash [32]byte
		info os.FileInfo
	}
	before := map[string]mediaSnapshot{}
	for i, name := range []string{"asset-one.jpg", "asset-two.jpg", "asset-three.mp4", "local-only.jpg"} {
		path := filepath.Join(dir, name)
		stamp := time.Date(2026, 1, 2, 3, 4, i, 0, time.UTC)
		if err := os.Chtimes(path, stamp, stamp); err != nil {
			t.Fatal(err)
		}
		body, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		info, err := os.Stat(path)
		if err != nil {
			t.Fatal(err)
		}
		before[name] = mediaSnapshot{sha256.Sum256(body), info}
	}
	// Warm the normal display cache with the old incorrect values. Publication
	// must make the corrected metadata visible without restarting the server.
	w, initial := call(t, s, http.MethodGet, "/api/combo?section=combos&folder="+folder, nil, false)
	if w.Code != 200 || len(rows(initial["items"])) != 4 {
		t.Fatal(w.Code, initial)
	}
	for _, item := range rows(initial["items"]) {
		if str(item["id"]) != "local-only" && str(item["prompt"]) != wrong {
			t.Fatal("old-prompt fixture did not reach the read API", item)
		}
	}

	prompts := map[string]string{"asset-one": "  first image\nkeep surrounding whitespace  ", "asset-two": "第二张图片 <literal> & 独立提示词", "asset-three": "A different video prompt 🎬"}
	assets := []any{}
	for _, item := range items[:3] {
		id := str(item["id"])
		assets = append(assets, Obj{"id": id, "key": id, "mime": item["mime"], "sz": before[str(item["file"])].info.Size(), "conv": conversation, "t": item["created"], "prompt": prompts[id]})
	}
	manifest := Obj{"complete": true, "assets": assets, "conversations": []any{Obj{"id": conversation, "title": groupTitle, "t": card["created"]}}}
	var transfers, relocations atomic.Int32
	for round := 0; round < 2; round++ {
		w, reserved := call(t, s, http.MethodPost, "/internal/download/reserve", Obj{"root": root}, true)
		if w.Code != 200 {
			t.Fatal(w.Code, reserved)
		}
		s.runMu.Lock()
		run := s.run
		s.runMu.Unlock()
		run.http.Transport = roundTripFunc(func(*http.Request) (*http.Response, error) {
			transfers.Add(1)
			return nil, errors.New("existing-media prompt sync must not transfer bytes")
		})
		run.linkMedia = func(string, string) error {
			relocations.Add(1)
			return errors.New("prompt-only sync must reuse the existing mapped files")
		}
		w, started := call(t, s, http.MethodPost, "/internal/download/start", Obj{"runId": reserved["runId"], "userId": "fixture-user", "manifest": manifest}, true)
		if w.Code != 200 {
			t.Fatal(w.Code, started)
		}
		result := waitRun(t, s, "fixture-user", false)
		if !yes(result["ok"]) || !yes(result["published"]) || num(obj(result["counts"])["skipped"]) != 3 || num(obj(result["counts"])["total"]) != 0 || transfers.Load() != 0 || relocations.Load() != 0 {
			t.Fatal("existing media were not reused for metadata publication", result, transfers.Load(), relocations.Load())
		}
		updated, err := readJSON(cardPath)
		if err != nil || str(updated["title"]) != groupTitle || str(updated["externalGroupField"]) != "preserve" {
			t.Fatal("group title or unrelated metadata changed", updated, err)
		}
		assertPrompts := func(label string, values []Obj) {
			t.Helper()
			if len(values) != 4 {
				t.Fatalf("%s lost local or remote members: %#v", label, values)
			}
			seen := map[string]bool{}
			for _, item := range values {
				id := str(item["id"])
				seen[id] = true
				want := prompts[id]
				if id == "local-only" {
					want = str(localOnly["prompt"])
				}
				if str(item["prompt"]) != want {
					t.Fatalf("%s prompt mismatch for %s: got %q want %q", label, id, str(item["prompt"]), want)
				}
			}
			for _, id := range []string{"asset-one", "asset-two", "asset-three", "local-only"} {
				if !seen[id] {
					t.Fatal(label, "missing member", id)
				}
			}
		}
		assertPrompts("card", rows(updated["items"]))
		for _, item := range rows(updated["items"]) {
			if str(item["id"]) == "local-only" && !bytes.Equal(mustJSON(item), mustJSON(localOnly)) {
				t.Fatal("local-only metadata changed", item)
			}
		}
		for _, route := range []string{"/api/combo?section=combos&folder=" + folder, "/api/flat"} {
			w, out := call(t, s, http.MethodGet, route, nil, false)
			if w.Code != 200 {
				t.Fatal(route, w.Code, out)
			}
			assertPrompts(route, rows(out["items"]))
		}
		index, err := readJSON(filepath.Join(root, "_index.json"))
		if err != nil || len(rows(index["combos"])) != 1 || str(rows(index["combos"])[0]["folder"]) != folder || num(rows(index["combos"])[0]["n"]) != 1 || str(rows(index["combos"])[0]["title"]) != groupTitle {
			t.Fatal("existing folder mapping or group title changed", index, err)
		}
		folders, err := os.ReadDir(filepath.Join(root, "combos"))
		if err != nil || len(folders) != 1 || folders[0].Name() != folder {
			t.Fatal("sync created another combo folder", folders, err)
		}
		for name, prior := range before {
			path := filepath.Join(dir, name)
			body, err := os.ReadFile(path)
			if err != nil || sha256.Sum256(body) != prior.hash {
				t.Fatal("media bytes changed", name, err)
			}
			info, err := os.Stat(path)
			if err != nil || !info.ModTime().Equal(prior.info.ModTime()) || !os.SameFile(prior.info, info) {
				t.Fatal("media was replaced or its mtime changed", name, err)
			}
		}
	}
	t.Log("two prompt-only syncs: three distinct prompts; zero transfers/relocations; media hashes, mtimes, identities and folder mapping unchanged")
}
