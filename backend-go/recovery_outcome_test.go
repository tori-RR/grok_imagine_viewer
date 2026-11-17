package main

import (
	"path/filepath"
	"testing"
)

func TestRecoveredPublicationSurvivesLaterScanOrCleanupFailure(t *testing.T) {
	for _, mode := range []string{"later_scan_failure", "recovery_cleanup_failure"} {
		t.Run(mode, func(t *testing.T) {
			s, root := fixture(t)
			if _, err := s.reserveDownload(Obj{"root": root}); err != nil {
				t.Fatal(err)
			}
			r := s.run
			r.User = "fixture-user"
			if err := r.bind(); err != nil {
				t.Fatal(err)
			}
			m := Manifest{Complete: true, Assets: []Asset{{ID: "recovered-side-effect", Key: "recovered-side-effect", Mime: "image/jpeg", Conv: "review-recovery-group"}}, Conversations: []Conversation{{ID: "review-recovery-group"}}}
			if err := r.journal("media", m); err != nil {
				t.Fatal(err)
			}
			tk := token()
			part, _, err := r.part(m.Assets[0], tk)
			if err != nil {
				t.Fatal(err)
			}
			writeFixture(t, part, jpg)
			if err = r.record(m.Assets[0], tk, int64(len(jpg)), "ready"); err != nil {
				t.Fatal(err)
			}
			if mode == "recovery_cleanup_failure" {
				path, _ := r.transactionPath("unknown-evidence.json")
				writeFixture(t, path, []byte("keep unknown evidence"))
			}
			r.finish(false, "cancelled")
			reserved, err := s.reserveDownload(Obj{"root": root})
			if err != nil {
				t.Fatal(err)
			}
			size := int64(len(jpg) + 1)
			next := Manifest{Complete: true, Assets: []Asset{{ID: "asset-one", Key: "asset-one", Mime: "image/jpeg", Size: &size, Conv: "conversation-aaaaaaaa"}}, Conversations: []Conversation{{ID: "conversation-aaaaaaaa"}}}
			decoded, err := decode(mustJSON(next))
			if err != nil {
				t.Fatal(err)
			}
			if _, err = s.startDownload(Obj{"runId": reserved["runId"], "userId": "fixture-user", "manifest": decoded}); err != nil {
				t.Fatal(err)
			}
			state := awaitRun(t, s, func(v Obj) bool { return obj(v["result"]) != nil })
			result := obj(state["result"])
			if yes(result["ok"]) || !yes(result["published"]) {
				t.Fatal("known recovery publication was lost", result)
			}
			index, err := readJSON(filepath.Join(root, "_index.json"))
			if err != nil || len(rows(index["combos"])) != 2 {
				t.Fatal("recovered index missing", index, err)
			}
			found := false
			for _, row := range rows(index["combos"]) {
				if str(row["id"]) == "review-recovery-group" {
					found = exists(filepath.Join(root, "combos", str(row["folder"]), "recovered-side-effect.jpg"))
				}
			}
			if !found {
				t.Fatal("recovered formal media missing")
			}
		})
	}
}
