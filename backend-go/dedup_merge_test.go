package main

import (
	"bytes"
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func TestDedupMergeRecoversCopyBeforeMetadataAndRejectsContentConflict(t *testing.T) {
	for _, mode := range []string{"copy_before_metadata", "content_conflict", "metadata_write_failure"} {
		t.Run(mode, func(t *testing.T) {
			if mode == "metadata_write_failure" && runtime.GOOS != "windows" {
				t.Skip("Windows readonly replacement fault; ordinary merge coverage is cross-platform")
			}
			s, root := fixture(t)
			keepDir := filepath.Join(root, "combos", "0001_aaaaaaaa")
			sourceDir := filepath.Join(root, "combos", "0002_aaaaaaaa")
			b := append(append([]byte{}, jpg...), 42)
			writeFixture(t, filepath.Join(sourceDir, "asset-one.jpg"), jpg)
			writeFixture(t, filepath.Join(sourceDir, "merge-b.jpg"), b)
			source := Obj{"id": "merge-b", "file": "merge-b.jpg", "mime": "image/jpeg", "prompt": "preserve B", "created": "2026-01-01T00:00:00Z", "remoteUrl": "https://grok.com/imagine/post/merge-b"}
			jsonFixture(t, filepath.Join(sourceDir, "card.json"), Obj{"id": "conversation-aaaaaaaa", "folder": "0002_aaaaaaaa", "items": []any{Obj{"id": "asset-one", "file": "asset-one.jpg", "mime": "image/jpeg"}, source}})
			if mode == "copy_before_metadata" {
				writeFixture(t, filepath.Join(keepDir, "merge-b.jpg"), b)
			}
			if mode == "content_conflict" {
				writeFixture(t, filepath.Join(keepDir, "merge-b.jpg"), append(append([]byte{}, jpg...), 99))
			}
			if mode == "metadata_write_failure" {
				if err := os.Chmod(filepath.Join(keepDir, "card.json"), 0444); err != nil {
					t.Fatal(err)
				}
				defer os.Chmod(filepath.Join(keepDir, "card.json"), 0644)
			}
			s.invalidate()
			plan, err := s.dedup(Obj{"expectedRoot": root})
			if err != nil || len(rows(plan["groups"])) != 1 {
				t.Fatal(plan, err)
			}
			key := str(rows(plan["groups"])[0]["key"])
			result, err := s.dedup(Obj{"expectedRoot": root, "apply": true, "planToken": plan["planToken"], "actions": Obj{key: "merge"}})
			if err != nil {
				t.Fatal(err)
			}
			if mode == "copy_before_metadata" {
				if len(arr(result["errors"])) != 0 {
					t.Fatal(result)
				}
				card, err := readJSON(filepath.Join(keepDir, "card.json"))
				if err != nil {
					t.Fatal(err)
				}
				found := false
				for _, item := range rows(card["items"]) {
					if str(item["id"]) == "merge-b" {
						found = str(item["prompt"]) == "preserve B" && str(item["remoteUrl"]) == str(source["remoteUrl"])
					}
				}
				if !found {
					t.Fatal("replay lost source metadata", card)
				}
			} else {
				if len(arr(result["errors"])) == 0 {
					t.Fatal("conflict/write failure was hidden", result)
				}
				if data, err := os.ReadFile(filepath.Join(sourceDir, "merge-b.jpg")); err != nil || !bytes.Equal(data, b) {
					t.Fatal("source removed before durable metadata", err)
				}
			}
			if exists(filepath.Join(keepDir, "merge-b~n1.jpg")) {
				t.Fatal("content identity was silently renamed")
			}
		})
	}
}
