package main

import (
	"bytes"
	"database/sql"
	"fmt"
	"net"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestRegressionF01RealTCPStalledBody(t *testing.T) {
	s, root, reserved, ticket := oneUpload(t)
	server := httptest.NewServer(s)
	defer server.Close()
	s.origin = server.URL
	conn, err := net.DialTimeout("tcp", server.Listener.Addr().String(), time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	header := fmt.Sprintf("POST /internal/download/upload/%s HTTP/1.1\r\nHost: %s\r\nOrigin: %s\r\nX-Giv-Admin: %s\r\nX-Giv-Mime: image/jpeg\r\nContent-Length: %d\r\n\r\n", str(ticket["ticket"]), server.Listener.Addr(), s.origin, s.boot.Secret, len(jpg))
	if _, err = conn.Write(append([]byte(header), jpg[:8]...)); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(2 * time.Second)
	admitted := false
	for time.Now().Before(deadline) {
		s.run.mu.Lock()
		admitted = s.run.Tickets[str(ticket["ticket"])].Uploading
		s.run.mu.Unlock()
		if admitted {
			break
		}
		time.Sleep(5 * time.Millisecond)
	}
	if !admitted {
		t.Fatal("real HTTP upload was not admitted")
	}
	stopStarted := time.Now()
	response, ack := call(t, s, "POST", "/internal/download/stop", Obj{"runId": reserved["runId"]}, true)
	if response.Code != 200 || !yes(ack["stopped"]) {
		t.Fatal(response.Code, ack)
	}
	state := awaitRun(t, s, func(v Obj) bool { return obj(v["result"]) != nil })
	if time.Since(stopStarted) >= 3*time.Second {
		t.Fatal("stop did not interrupt stalled TCP within 3 seconds")
	}
	if !yes(obj(state["result"])["stopped"]) {
		t.Fatal(state)
	}
	if !exists(filepath.Join(root, "_state", ".giv-go-download.json")) {
		t.Fatal("journal prematurely retired")
	}
	conn.Close()
	state = awaitRun(t, s, func(v Obj) bool { return obj(v["result"]) != nil })
	if str(obj(state["result"])["code"]) != "cancelled" {
		t.Fatal(state)
	}
	t.Log("stop interrupts real stalled TCP without peer close; terminal code cancelled")
}

func reviewFinishUpload(t *testing.T, s *Server, reserved, ticket Obj) Obj {
	t.Helper()
	response := httptest.NewRecorder()
	s.ServeHTTP(response, uploadRequest(s, ticket, bytes.NewReader(jpg)))
	if response.Code != 200 {
		t.Fatal(response.Code, response.Body.String())
	}
	awaitRun(t, s, func(v Obj) bool { return str(v["phase"]) == "verify_account" })
	if _, err := s.authorizeDownload(Obj{"runId": reserved["runId"], "userId": "fixture-user"}); err != nil {
		t.Fatal(err)
	}
	state := awaitRun(t, s, func(v Obj) bool { return obj(v["result"]) != nil })
	<-s.run.done
	return obj(state["result"])
}
func TestRegressionF02PurgeLeavesInboxBody(t *testing.T) {
	s, root, reserved, ticket := oneUpload(t)
	result := reviewFinishUpload(t, s, reserved, ticket)
	if !yes(result["published"]) {
		t.Fatal(result)
	}
	snap := s.snapshot()
	s.invalidate()
	removed, err := s.trashAdd(snap, Obj{"section": "combos", "folder": "0001_aaaaaaaa", "ids": []any{"upload-fixture"}})
	if err != nil || len(rows(removed["moved"])) != 1 || len(arr(removed["errors"])) != 0 {
		t.Fatal(removed, err)
	}
	id := rows(removed["moved"])[0]["id"]
	purged, err := s.trashChange(snap, Obj{"ids": []any{id}}, true)
	if err != nil || len(arr(purged["errors"])) != 0 || len(arr(purged["purged"])) != 1 {
		t.Fatal(purged, err)
	}
	body, err := os.ReadFile(filepath.Join(root, "_inbox", "0000_inbox", "upload-fixture.jpg"))
	if !os.IsNotExist(err) || len(body) != 0 {
		t.Fatal("purge retained inbox bytes", err)
	}
	trash, err := s.trashList(snap)
	if err != nil || len(rows(trash["items"])) != 0 {
		t.Fatal(trash, err)
	}
	t.Log("purge leaves neither trash body nor transaction-owned inbox reference")
}

func TestRegressionF03DedupSharedNewAsset(t *testing.T) {
	s, root := fixture(t)
	for _, folder := range []string{"0002_aaaaaaaa", "0003_aaaaaaaa"} {
		dir := filepath.Join(root, "combos", folder)
		writeFixture(t, filepath.Join(dir, "asset-one.jpg"), jpg)
		writeFixture(t, filepath.Join(dir, "new-shared-b.jpg"), append(append([]byte{}, jpg...), 42))
		jsonFixture(t, filepath.Join(dir, "card.json"), Obj{"id": "conversation-aaaaaaaa", "folder": folder, "items": []any{
			Obj{"id": "asset-one", "file": "asset-one.jpg", "mime": "image/jpeg"},
			Obj{"id": "new-shared-b", "file": "new-shared-b.jpg", "mime": "image/jpeg", "prompt": "synthetic B prompt", "created": "2026-01-01T00:00:00Z"},
		}})
	}
	s.invalidate()
	plan, err := s.dedup(Obj{"expectedRoot": root})
	if err != nil || len(rows(plan["groups"])) != 1 {
		t.Fatal(plan, err)
	}
	key := str(rows(plan["groups"])[0]["key"])
	applied, err := s.dedup(Obj{"expectedRoot": root, "apply": true, "planToken": plan["planToken"], "actions": Obj{key: "merge"}})
	if err != nil || len(arr(applied["errors"])) != 0 {
		t.Fatal(applied, err)
	}
	dir := filepath.Join(root, "combos", "0001_aaaaaaaa")
	a, err := os.ReadFile(filepath.Join(dir, "new-shared-b.jpg"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(dir, "new-shared-b~n1.jpg")); !os.IsNotExist(err) {
		t.Fatal("duplicate B retained", err)
	}
	if !bytes.Equal(a, append(append([]byte{}, jpg...), 42)) {
		t.Fatal("B bytes changed")
	}
	card, err := readJSON(filepath.Join(dir, "card.json"))
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, item := range rows(card["items"]) {
		if str(item["id"]) == "new-shared-b" {
			found = str(item["prompt"]) == "synthetic B prompt" && str(item["created"]) == "2026-01-01T00:00:00Z"
		}
	}
	if !found {
		t.Fatal("B metadata missing", card)
	}
	index, err := readJSON(filepath.Join(root, "_index.json"))
	if err != nil || num(rows(index["combos"])[0]["count"]) != 3 || len(arr(rows(index["combos"])[0]["memberIds"])) != 3 {
		t.Fatal("merged index summary is stale", index, err)
	}
	t.Log("shared B copied once; card preserves prompt and timestamp")
}

func TestRegressionF04RecoveryPublicationNotReported(t *testing.T) {
	s, root := fixture(t)
	if _, err := s.reserveDownload(Obj{"root": root}); err != nil {
		t.Fatal(err)
	}
	r := s.run
	r.User = "fixture-user"
	if err := r.bind(); err != nil {
		t.Fatal(err)
	}
	m := Manifest{Complete: true, Assets: []Asset{{ID: "recovery-review", Mime: "image/jpeg", Key: "recovery-review", Conv: "review-new-conversation"}}, Conversations: []Conversation{{ID: "review-new-conversation"}}}
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
	r.finish(false, "cancelled")
	reserved, err := s.reserveDownload(Obj{"root": root})
	if err != nil {
		t.Fatal(err)
	}
	manifest, err := decode(mustJSON(m))
	if err != nil {
		t.Fatal(err)
	}
	if _, err = s.startDownload(Obj{"runId": reserved["runId"], "userId": "fixture-user", "manifest": manifest}); err != nil {
		t.Fatal(err)
	}
	awaitRun(t, s, func(v Obj) bool { return str(v["phase"]) == "verify_account" })
	idx, err := readJSON(filepath.Join(root, "_index.json"))
	if err != nil || len(rows(idx["combos"])) != 2 {
		t.Fatal("recovery did not publish", idx, err)
	}
	s.stopDownloads()
	state := awaitRun(t, s, func(v Obj) bool { return obj(v["result"]) != nil })
	result := obj(state["result"])
	if !yes(result["stopped"]) || !yes(result["published"]) {
		t.Fatal("reported outcome defect did not reproduce", result)
	}
	t.Log("recovery publication survives subsequent stop")
}

func TestRegressionF05HistoryBusyWarning(t *testing.T) {
	s, _, reserved, ticket := oneUpload(t)
	db, err := sql.Open("sqlite", filepath.Join(filepath.Dir(s.boot.Config), "stack-evo-state", "history.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	db.SetMaxOpenConns(1)
	defer db.Close()
	if _, err = db.Exec("BEGIN IMMEDIATE"); err != nil {
		t.Fatal(err)
	}
	defer db.Exec("ROLLBACK")
	result := reviewFinishUpload(t, s, reserved, ticket)
	if !yes(result["ok"]) || !yes(result["published"]) || str(result["historyWarning"]) == "" {
		t.Fatal("history failure not reproduced", result)
	}
	if _, err = db.Exec("ROLLBACK"); err != nil {
		t.Fatal(err)
	}
	s.taskHistory.Reconcile()
	var phase string
	if err = s.taskHistory.db.QueryRow("SELECT phase FROM runs WHERE id=?", s.run.Token).Scan(&phase); err != nil || phase != "succeeded" {
		t.Fatal(phase, err)
	}
	t.Log("pending history warning retained; bounded reconciliation repairs outcome after lock release")
}

func TestRegressionF06HistoryOffsetIgnored(t *testing.T) {
	s, root := fixture(t)
	tx, err := s.taskHistory.db.Begin()
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback()
	for i := 0; i < 205; i++ {
		if _, err = tx.Exec("INSERT INTO runs(id,run_id,root,started_at,started_at_ns,phase) VALUES(?,?,?,?,?,?)", fmt.Sprintf("review-%03d", i), i+1, root, "2026-11-11T00:00:00Z", i+1, "failed"); err != nil {
			t.Fatal(err)
		}
	}
	if err = tx.Commit(); err != nil {
		t.Fatal(err)
	}
	w, first := call(t, s, "GET", "/api/download/history?limit=200", nil, false)
	if w.Code != 200 || len(rows(first["items"])) != 200 {
		t.Fatal(w.Code, first)
	}
	cursor := str(first["nextCursor"])
	if cursor == "" {
		t.Fatal("missing next cursor")
	}
	w, next := call(t, s, "GET", "/api/download/history?limit=200&cursor="+cursor, nil, false)
	if w.Code != 200 || len(rows(next["items"])) != 5 || str(next["nextCursor"]) != "" {
		t.Fatal(w.Code, next)
	}
	t.Log("205 records reachable through bounded cursor pages")
}
