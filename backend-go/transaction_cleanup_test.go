package main

import (
	"os"
	"path/filepath"
	"testing"
)

func publishedTransaction(t *testing.T) (*DownloadRun, string, string) {
	t.Helper()
	s, root := fixture(t)
	if _, err := s.reserveDownload(Obj{"root": root}); err != nil {
		t.Fatal(err)
	}
	r := s.run
	r.User = "fixture-user"
	if err := r.bind(); err != nil {
		t.Fatal(err)
	}
	m := Manifest{Complete: true, Assets: []Asset{{ID: "asset-one", Key: "asset-one", Mime: "image/jpeg", Conv: "conversation-aaaaaaaa"}}, Conversations: []Conversation{{ID: "conversation-aaaaaaaa", Title: "cleanup fixture"}}}
	if err := r.journal("publishing", m); err != nil {
		t.Fatal(err)
	}
	if err := r.publish(m, map[string]string{"asset-one": filepath.Join(root, "combos", "0001_aaaaaaaa", "asset-one.jpg")}, map[string]bool{}); err != nil {
		t.Fatal(err)
	}
	tx, err := r.transactionPath("")
	if err != nil {
		t.Fatal(err)
	}
	return r, tx, filepath.Join(root, "_state", ".giv-go-download.json")
}

func TestRetirePublishedTransactionKeepsHistoricalOrphansAndMedia(t *testing.T) {
	r, tx, header := publishedTransaction(t)
	orphan := filepath.Join(filepath.Dir(tx), token(), "keep.json")
	writeFixture(t, orphan, []byte("historical evidence"))
	media := filepath.Join(r.Snap.Root, "combos", "0001_aaaaaaaa", "asset-one.jpg")
	before, err := os.Stat(media)
	if err != nil {
		t.Fatal(err)
	}
	if err = r.retireTransaction(); err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{tx, header} {
		if _, err = os.Lstat(path); !os.IsNotExist(err) {
			t.Fatal("owned completed transaction retained", path, err)
		}
	}
	if !exists(orphan) {
		t.Fatal("historical orphan was swept")
	}
	after, err := os.Stat(media)
	if err != nil || !os.SameFile(before, after) || before.ModTime() != after.ModTime() {
		t.Fatal("published media changed", err)
	}
}

func TestRetirePreflightPreservesUnknownAndChangedTransactions(t *testing.T) {
	for _, mode := range []string{"unknown_file", "unknown_directory", "wrong_user", "pending_part", "header_changed"} {
		t.Run(mode, func(t *testing.T) {
			r, tx, header := publishedTransaction(t)
			switch mode {
			case "unknown_file":
				writeFixture(t, filepath.Join(tx, "future-record.json"), []byte("keep"))
			case "unknown_directory":
				if err := os.Mkdir(filepath.Join(tx, "future"), 0700); err != nil {
					t.Fatal(err)
				}
			case "wrong_user":
				r.User = "another-user"
			case "header_changed":
				jsonFixture(t, header, Obj{"version": 1, "runToken": token(), "manifestSha256": "different", "phase": "publishing"})
			case "pending_part":
				a := Asset{ID: "asset-one", Mime: "image/jpeg"}
				tk := token()
				part, _, err := r.part(a, tk)
				if err != nil {
					t.Fatal(err)
				}
				if err = r.record(a, tk, 0, "receiving"); err != nil {
					t.Fatal(err)
				}
				writeFixture(t, part, []byte("pending owned bytes"))
			}
			if err := r.retireTransaction(); err == nil {
				t.Fatal("uncertain transaction was removed")
			}
			for _, path := range []string{header, filepath.Join(tx, "manifest.json"), filepath.Join(tx, "layout", "conversation-aaaaaaaa.json")} {
				if !exists(path) {
					t.Fatal("preflight partially deleted evidence", path)
				}
			}
		})
	}
}

func TestRetireRefusesSymlinkWithoutFollowingIt(t *testing.T) {
	r, tx, header := publishedTransaction(t)
	outside := t.TempDir()
	keep := filepath.Join(outside, "asset-one.json")
	writeFixture(t, keep, []byte("outside transaction"))
	if err := os.Symlink(outside, filepath.Join(tx, "items")); err != nil {
		t.Skip("symlink fixture unavailable:", err)
	}
	if err := r.retireTransaction(); err == nil {
		t.Fatal("linked transaction directory accepted")
	}
	if !exists(keep) || !exists(header) || !exists(filepath.Join(tx, "manifest.json")) {
		t.Fatal("linked cleanup changed evidence")
	}
}
