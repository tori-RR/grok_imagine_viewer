package main

import (
	"bytes"
	"context"
	"database/sql"
	"errors"
	"fmt"
	"net"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestNativeFailureInterruptsRealStalledUpload(t *testing.T) {
	s, _, reserved, ticket := oneUpload(t)
	server := httptest.NewServer(s)
	defer server.Close()
	s.origin = server.URL
	conn, err := net.DialTimeout("tcp", server.Listener.Addr().String(), time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	fmt.Fprintf(conn, "POST /internal/download/upload/%s HTTP/1.1\r\nHost: %s\r\nOrigin: %s\r\nX-Giv-Admin: %s\r\nX-Giv-Mime: image/jpeg\r\nContent-Length: %d\r\n\r\n", str(ticket["ticket"]), server.Listener.Addr(), s.origin, s.boot.Secret, len(jpg))
	conn.Write(jpg[:8])
	deadline := time.Now().Add(time.Second)
	for {
		s.run.mu.Lock()
		active := s.run.Tickets[str(ticket["ticket"])].Uploading
		s.run.mu.Unlock()
		if active {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("upload not admitted")
		}
		time.Sleep(time.Millisecond)
	}
	for i := 0; i < 2; i++ {
		if _, err = s.uploadFailed(Obj{"runId": reserved["runId"], "ticket": ticket["ticket"], "code": "upload_timeout"}); err != nil {
			t.Fatal(err)
		}
	}
	awaitRun(t, s, func(v Obj) bool { return str(v["phase"]) == "verify_account" })
	if _, err = s.authorizeDownload(Obj{"runId": reserved["runId"], "userId": "fixture-user"}); err != nil {
		t.Fatal(err)
	}
	state := awaitRun(t, s, func(v Obj) bool { return obj(v["result"]) != nil })
	failures := rows(obj(state["result"])["failures"])
	if len(failures) != 1 || str(failures[0]["code"]) != "upload_timeout" || !yes(failures[0]["retryable"]) {
		t.Fatal(state)
	}
}

func TestInboxReleasedAfterLinkAndCopyPublication(t *testing.T) {
	for _, copyOnly := range []bool{false, true} {
		t.Run(fmt.Sprint(copyOnly), func(t *testing.T) {
			s, root, reserved, ticket := oneUpload(t)
			copied := false
			if copyOnly {
				s.run.linkMedia = func(string, string) error { copied = true; return errors.New("fixture no hardlink") }
			}
			result := reviewFinishUpload(t, s, reserved, ticket)
			if !yes(result["published"]) || copyOnly && !copied {
				t.Fatal(result)
			}
			if _, err := os.Stat(filepath.Join(root, "_inbox", "0000_inbox", "upload-fixture.jpg")); !os.IsNotExist(err) {
				t.Fatal("owned inbox not released", err)
			}
			data, err := os.ReadFile(filepath.Join(root, "combos", "0001_aaaaaaaa", "upload-fixture.jpg"))
			if err != nil || !bytes.Equal(data, jpg) {
				t.Fatal("formal media lost", err)
			}
			snap := s.snapshot()
			s.invalidate()
			deleted, err := s.trashAdd(snap, Obj{"section": "combos", "folder": "0001_aaaaaaaa", "ids": []any{"upload-fixture"}})
			if err != nil || len(rows(deleted["moved"])) != 1 {
				t.Fatal(deleted, err)
			}
			id := rows(deleted["moved"])[0]["id"]
			restored, err := s.trashChange(snap, Obj{"ids": []any{id}}, false)
			if err != nil || len(arr(restored["errors"])) > 0 {
				t.Fatal(restored, err)
			}
			if data, err = os.ReadFile(filepath.Join(root, "combos", "0001_aaaaaaaa", "upload-fixture.jpg")); err != nil || !bytes.Equal(data, jpg) {
				t.Fatal("restore lost media", err)
			}
		})
	}
}

func TestReleasedInboxRecoveryAndHistoricalOrphanPreservation(t *testing.T) {
	for _, releaseBeforeCrash := range []bool{false, true} {
		t.Run(fmt.Sprint(releaseBeforeCrash), func(t *testing.T) {
			s, root := fixture(t)
			if _, err := s.reserveDownload(Obj{"root": root}); err != nil {
				t.Fatal(err)
			}
			r := s.run
			r.User = "fixture-user"
			if err := r.bind(); err != nil {
				t.Fatal(err)
			}
			m := Manifest{Complete: true, Assets: []Asset{{ID: "crash-inbox", Mime: "image/jpeg", Key: "crash-inbox", Conv: "conversation-aaaaaaaa"}}, Conversations: []Conversation{{ID: "conversation-aaaaaaaa"}}}
			if err := r.journal("publishing", m); err != nil {
				t.Fatal(err)
			}
			tk := token()
			part, inbox, err := r.part(m.Assets[0], tk)
			if err != nil {
				t.Fatal(err)
			}
			writeFixture(t, part, jpg)
			if err = r.commit(transferResult{Asset: m.Assets[0], Part: part, Token: tk, Bytes: int64(len(jpg))}); err != nil {
				t.Fatal(err)
			}
			orphan := filepath.Join(filepath.Dir(inbox), "historical-orphan.jpg")
			writeFixture(t, orphan, jpg)
			if err = r.publish(m, map[string]string{"crash-inbox": inbox}, map[string]bool{}); err != nil {
				t.Fatal(err)
			}
			if releaseBeforeCrash {
				if err = r.releasePublishedInbox(m); err != nil {
					t.Fatal(err)
				}
			}
			r.finish(false, "cancelled")
			if _, err = s.reserveDownload(Obj{"root": root}); err != nil {
				t.Fatal(err)
			}
			s.run.User = "fixture-user"
			out, err := s.run.recoverPreviousOutcome()
			if err != nil || !out.IndexPublished || !out.TransactionRetired {
				t.Fatal(out, err)
			}
			if exists(inbox) || !exists(orphan) {
				t.Fatal("staging ownership lost")
			}
			if data, err := os.ReadFile(filepath.Join(root, "combos", "0001_aaaaaaaa", "crash-inbox.jpg")); err != nil || !bytes.Equal(data, jpg) {
				t.Fatal("recovered media lost", err)
			}
		})
	}
}

func TestHistoryPendingOutcomeSurvivesRestartAndTransientDBFailure(t *testing.T) {
	for _, mode := range []string{"readonly", "closed_connection"} {
		t.Run(mode, func(t *testing.T) {
			cfg := filepath.Join(t.TempDir(), "app.json")
			h, err := openHistory(cfg)
			if err != nil {
				t.Fatal(err)
			}
			if err = h.Start("pending-result", 1, "root-A"); err != nil {
				t.Fatal(err)
			}
			path := filepath.Join(h.dir, "history.sqlite")
			h.db.Close()
			if mode == "readonly" {
				h.db, err = sql.Open("sqlite", "file:"+filepath.ToSlash(path)+"?mode=ro")
				if err != nil {
					t.Fatal(err)
				}
			}
			result := Obj{"resultVersion": 1, "historyState": "pending", "warnings": []string{}, "ok": true, "stopped": false, "published": true, "counts": Obj{"total": 1, "attempted": 1, "succeeded": 1, "failed": 0, "skipped": 0}, "failures": []any{}, "finishedAt": "2026-11-11T00:00:00Z"}
			if state := h.Complete("pending-result", "root-A", result); state != "pending" {
				t.Fatal(state)
			}
			h.Close()
			next, err := openHistory(cfg)
			if err != nil {
				t.Fatal(err)
			}
			defer next.Close()
			out, err := next.List("root-A", 50)
			if err != nil || len(rows(out["items"])) != 1 {
				t.Fatal(out, err)
			}
			item := rows(out["items"])[0]
			if str(item["phase"]) != "succeeded" || !yes(item["published"]) || str(item["finishedAt"]) != "2026-11-11T00:00:00Z" {
				t.Fatal("durable outcome not replayed", item)
			}
		})
	}
}

func TestHistoryCursorThousandTiesAndConcurrentInsert(t *testing.T) {
	h, err := openHistory(filepath.Join(t.TempDir(), "app.json"))
	if err != nil {
		t.Fatal(err)
	}
	defer h.Close()
	tx, err := h.db.Begin()
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback()
	for i := 0; i < 1000; i++ {
		if _, err = tx.Exec("INSERT INTO runs(id,run_id,root,started_at,started_at_ns,phase) VALUES(?,?,?,?,?,?)", fmt.Sprintf("history-%04d", i), i+1, "root-A", "2026-11-11T00:00:00Z", int64(1234), "failed"); err != nil {
			t.Fatal(err)
		}
	}
	if err = tx.Commit(); err != nil {
		t.Fatal(err)
	}
	page, err := h.ListPage("root-A", 50, "")
	if err != nil {
		t.Fatal(err)
	}
	cursor := str(page["nextCursor"])
	for _, root := range []string{"root-B"} {
		if _, err = h.ListPage(root, 50, cursor); err == nil {
			t.Fatal("cross-root cursor accepted")
		}
	}
	if _, err = h.ListPage("root-A", 50, cursor+"x"); err == nil {
		t.Fatal("tampered cursor accepted")
	}
	parsed, err := h.historyPage(context.Background(), "root-A", cursor)
	if err != nil {
		t.Fatal(err)
	}
	parsed.Expires = 1
	if _, err = h.ListPage("root-A", 50, h.encodeHistoryPage(parsed)); err == nil {
		t.Fatal("expired cursor accepted")
	}
	if _, err = h.db.Exec("INSERT INTO runs(id,run_id,root,started_at,started_at_ns,phase) VALUES('history-000-new',1001,'root-A','2026-11-11T00:00:00Z',1234,'failed')"); err != nil {
		t.Fatal(err)
	}
	seen := map[string]bool{}
	for {
		for _, item := range rows(page["items"]) {
			id := str(item["id"])
			if seen[id] || id == "history-000-new" {
				t.Fatal("duplicate or post-snapshot insertion", id)
			}
			seen[id] = true
		}
		cursor = str(page["nextCursor"])
		if cursor == "" {
			break
		}
		page, err = h.ListPage("root-A", 50, cursor)
		if err != nil {
			t.Fatal(err)
		}
	}
	if len(seen) != 1000 {
		t.Fatal("history rows skipped", len(seen))
	}
}
