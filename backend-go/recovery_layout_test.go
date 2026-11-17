package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestPublishingRecoveryKeepsDurableFolderMapping(t *testing.T) {
	s, root := fixture(t)
	if _, err := s.reserveDownload(Obj{"root": root}); err != nil {
		t.Fatal(err)
	}
	r := s.run
	r.User = "user-one"
	if err := r.bind(); err != nil {
		t.Fatal(err)
	}
	m := Manifest{Complete: true, Assets: []Asset{{ID: "recovery-new-asset", Mime: "image/jpeg", Key: "recovery-new-asset", Conv: "new-conversation"}}, Conversations: []Conversation{{ID: "new-conversation", Title: "Recovery fixture"}}}
	initial, err := os.ReadFile(filepath.Join(root, "_index.json"))
	if err != nil {
		t.Fatal(err)
	}
	if err = r.journal("publishing", m); err != nil {
		t.Fatal(err)
	}
	tk := token()
	part, final, err := r.part(m.Assets[0], tk)
	if err != nil {
		t.Fatal(err)
	}
	writeFixture(t, part, jpg)
	if err = r.record(m.Assets[0], tk, int64(len(jpg)), "ready"); err != nil {
		t.Fatal(err)
	}
	if err = publishNoReplace(part, final); err != nil {
		t.Fatal(err)
	}
	if err = r.publish(m, map[string]string{m.Assets[0].ID: final}, map[string]bool{}); err != nil {
		t.Fatal(err)
	}
	planned, _, err := r.layoutPlan("new-conversation")
	if err != nil || planned == nil {
		t.Fatal("missing durable plan", err)
	}
	folder := str(planned["folder"])
	// Recreate the disk state of a crash after card/media publication but before
	// the last _index.json replacement. All operations touch only this fixture.
	for attempt := 0; attempt < 2; attempt++ {
		if attempt == 0 {
			writeFixture(t, filepath.Join(root, "_index.json"), initial)
			if err = r.journal("publishing", m); err != nil {
				t.Fatal(err)
			}
		}
		if err = r.recoverPrevious(); err != nil {
			t.Fatal(err)
		}
		index, err := readJSON(filepath.Join(root, "_index.json"))
		if err != nil {
			t.Fatal(err)
		}
		found := false
		for _, row := range rows(index["combos"]) {
			if str(row["id"]) == "new-conversation" {
				found = true
				if str(row["folder"]) != folder {
					t.Fatal("mapping changed")
				}
			}
		}
		if !found {
			t.Fatal("recovered group absent")
		}
		dirs, err := os.ReadDir(filepath.Join(root, "combos"))
		if err != nil || len(dirs) != 2 {
			t.Fatal("duplicate recovery directories", len(dirs), err)
		}
	}
	// Transaction-bound mapping must not accept another user's or escaped path.
	_, path, _ := r.layoutPlan("new-conversation")
	jsonFixture(t, path, Obj{"version": 1, "runToken": r.Token, "userId": "wrong-user", "row": planned})
	if _, _, err = r.layoutPlan("new-conversation"); err == nil {
		t.Fatal("unbound plan accepted")
	}
}
func TestExistingKnownSizeMismatchPreservesOriginal(t *testing.T) {
	s, root := fixture(t)
	if _, err := s.reserveDownload(Obj{"root": root}); err != nil {
		t.Fatal(err)
	}
	size := int64(len(jpg) + 1)
	m := Manifest{Assets: []Asset{{ID: "asset-one", Mime: "image/jpeg", Size: &size}}}
	if _, _, err := s.run.scanExisting(m); err == nil || err.Error() != "local_size_mismatch" {
		t.Fatal("existing size mismatch accepted", err)
	}
	data, err := os.ReadFile(filepath.Join(root, "combos", "0001_aaaaaaaa", "asset-one.jpg"))
	if err != nil || string(data) != string(jpg) {
		t.Fatal("original file changed")
	}
}

func TestInterruptedMediaRecoveryKeepsUnownedFilesAndVerifiedMedia(t *testing.T) {
	s, root := fixture(t)
	if _, err := s.reserveDownload(Obj{"root": root}); err != nil {
		t.Fatal(err)
	}
	r := s.run
	r.User = "fixture-user"
	if err := r.bind(); err != nil {
		t.Fatal(err)
	}
	m := Manifest{Complete: true, Assets: []Asset{
		{ID: "recovered-image", Mime: "image/jpeg", Key: "recovered-image", Conv: "conversation-aaaaaaaa"},
		{ID: "interrupted-image", Mime: "image/jpeg", Key: "interrupted-image", Conv: "conversation-aaaaaaaa"},
	}, Conversations: []Conversation{{ID: "conversation-aaaaaaaa", Title: "Recovery fixture"}}}
	if err := r.journal("media", m); err != nil {
		t.Fatal(err)
	}
	readyToken, receivingToken := token(), token()
	ready, _, err := r.part(m.Assets[0], readyToken)
	if err != nil {
		t.Fatal(err)
	}
	writeFixture(t, ready, jpg)
	if err = r.record(m.Assets[0], readyToken, int64(len(jpg)), "ready"); err != nil {
		t.Fatal(err)
	}
	partial, _, err := r.part(m.Assets[1], receivingToken)
	if err != nil {
		t.Fatal(err)
	}
	writeFixture(t, partial, []byte("owned incomplete fixture"))
	if err = r.record(m.Assets[1], receivingToken, 0, "receiving"); err != nil {
		t.Fatal(err)
	}
	unowned := filepath.Join(filepath.Dir(partial), "unrelated.part")
	writeFixture(t, unowned, []byte("keep unrelated fixture"))
	r.finish(false, "cancelled")
	if _, err = s.reserveDownload(Obj{"root": root}); err != nil {
		t.Fatal(err)
	}
	next := s.run
	next.User = "another-user"
	if err = next.recoverPrevious(); err == nil {
		t.Fatal("cross-account recovery was accepted")
	}
	if _, err = os.Stat(ready); err != nil {
		t.Fatal("rejected recovery changed owned media", err)
	}
	next.User = "fixture-user"
	if err = next.recoverPrevious(); err != nil {
		t.Fatal(err)
	}
	if _, err = os.Stat(partial); !os.IsNotExist(err) {
		t.Fatal("owned incomplete partial was not recovered", err)
	}
	if data, err := os.ReadFile(filepath.Join(root, "combos", "0001_aaaaaaaa", "recovered-image.jpg")); err != nil || string(data) != string(jpg) {
		t.Fatal("ready bytes lost", err)
	}
	if data, err := os.ReadFile(unowned); err != nil || string(data) != "keep unrelated fixture" {
		t.Fatal("unowned file touched", err)
	}
	if err = next.recoverPrevious(); err != nil {
		t.Fatal("recovery replay was not idempotent", err)
	}
}
