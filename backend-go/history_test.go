package main

import (
	"bytes"
	"context"
	"database/sql"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestHistoryPersistenceAndInterruptedRecovery(t *testing.T) {
	cfg := filepath.Join(t.TempDir(), "app.json")
	h, err := openHistory(cfg)
	if err != nil {
		t.Fatal(err)
	}
	if err = h.Start("completed", 1, "root-A"); err != nil {
		t.Fatal(err)
	}
	result := Obj{"ok": false, "stopped": false, "published": true, "counts": Obj{"total": 2, "succeeded": 1, "failed": 1}, "failures": []any{Obj{"assetId": "one"}}}
	if err = h.Finish("completed", result); err != nil {
		t.Fatal(err)
	}
	if err = h.Start("unfinished", 2, "root-A"); err != nil {
		t.Fatal(err)
	}
	h.Close()
	h, err = openHistory(cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer h.Close()
	out, err := h.List("root-A", 50)
	if err != nil {
		t.Fatal(err)
	}
	items := rows(out["items"])
	if len(items) != 2 || str(items[0]["phase"]) != "interrupted" || str(items[1]["phase"]) != "partial" {
		t.Fatalf("history: %#v", out)
	}
	other, err := h.List("root-B", 50)
	if err != nil || len(rows(other["items"])) != 0 {
		t.Fatal("cross-root history leak", other, err)
	}
}
func TestHistoryRefusesNewerSchemaAndRetainsCorruption(t *testing.T) {
	cfg := filepath.Join(t.TempDir(), "app.json")
	h, err := openHistory(cfg)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = h.db.Exec("PRAGMA user_version=99"); err != nil {
		t.Fatal(err)
	}
	h.Close()
	if next, err := openHistory(cfg); err == nil {
		next.Close()
		t.Fatal("accepted future schema")
	}
	broken := filepath.Join(t.TempDir(), "app.json")
	p := filepath.Join(filepath.Dir(broken), "stack-evo-state", "history.sqlite")
	original := []byte("intentionally broken database; preserve this evidence")
	writeFixture(t, p, original)
	if next, err := openHistory(broken); err == nil {
		next.Close()
		t.Fatal("accepted broken db")
	}
	data, err := os.ReadFile(p)
	if err != nil || !bytes.Equal(data, original) {
		t.Fatal("corrupt database changed", err)
	}
}

type deniedPublicTransport struct{}

func (deniedPublicTransport) RoundTrip(*http.Request) (*http.Response, error) {
	return &http.Response{StatusCode: 403, Header: make(http.Header), Body: io.NopCloser(bytes.NewReader(nil))}, nil
}
func awaitRun(t *testing.T, s *Server, predicate func(Obj) bool) Obj {
	t.Helper()
	deadline := time.Now().Add(8 * time.Second)
	for time.Now().Before(deadline) {
		v := s.downloadStatus()
		if predicate(v) {
			return v
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("download did not reach expected phase: %#v", s.downloadStatus())
	return nil
}
func TestGoCoordinatorNativeBlobProtocolAndHistory(t *testing.T) {
	s, root := fixture(t)
	reserved, err := s.reserveDownload(Obj{"root": root})
	if err != nil {
		t.Fatal(err)
	}
	id := reserved["runId"]
	s.run.http.Transport = deniedPublicTransport{}
	manifest := Obj{"complete": true, "assets": []any{Obj{"id": "new-image", "key": "users/fixture/new.jpg", "mime": "image/jpeg", "sz": len(jpg), "conv": "new-conversation"}}, "conversations": []any{Obj{"id": "new-conversation", "title": "Fixture"}}}
	if _, err = s.startDownload(Obj{"runId": id, "userId": "fixture-user", "manifest": manifest}); err != nil {
		t.Fatal(err)
	}
	status := awaitRun(t, s, func(v Obj) bool { return len(rows(v["tickets"])) == 1 })
	ticket := str(rows(status["tickets"])[0]["ticket"])
	// Browser credentials never authorize a native upload or internal status.
	forbidden, _ := call(t, s, "GET", "/internal/download/status", nil, false)
	if forbidden.Code != 403 {
		t.Fatal("internal state leaked")
	}
	req := httptest.NewRequest("POST", s.origin+"/internal/download/upload/"+ticket, bytes.NewReader(jpg))
	req.Header.Set("X-Giv-Admin", s.boot.Secret)
	req.Header.Set("Origin", s.origin)
	req.Header.Set("X-Giv-Mime", "image/jpeg")
	response := httptest.NewRecorder()
	s.ServeHTTP(response, req)
	if response.Code != 200 {
		t.Fatal(response.Code, response.Body.String())
	}
	// A ticket is one-shot, including while the coordinator is consuming it.
	response = httptest.NewRecorder()
	s.ServeHTTP(response, req.Clone(context.Background()))
	if response.Code == 200 {
		t.Fatal("ticket replay accepted")
	}
	awaitRun(t, s, func(v Obj) bool { return str(v["phase"]) == "verify_account" })
	if _, err = s.authorizeDownload(Obj{"runId": id, "userId": "fixture-user"}); err != nil {
		t.Fatal(err)
	}
	status = awaitRun(t, s, func(v Obj) bool { return obj(v["result"])["ok"] == true })
	if !yes(obj(status["result"])["published"]) {
		t.Fatal("index was not published")
	}
	history, err := s.taskHistory.List(root, 50)
	if err != nil || len(rows(history["items"])) != 1 || str(rows(history["items"])[0]["phase"]) != "succeeded" {
		t.Fatal(history, err)
	}
	second, err := s.reserveDownload(Obj{"root": root})
	if err != nil {
		t.Fatal(err)
	}
	stale, _ := call(t, s, "POST", "/internal/download/stop", Obj{"runId": id}, true)
	if stale.Code != 409 || !s.downloadActive() {
		t.Fatal("old run stopped new run", stale.Code)
	}
	stopped, _ := call(t, s, "POST", "/internal/download/stop", second, true)
	if stopped.Code != 200 {
		t.Fatal(stopped.Code)
	}
}

func TestDownloadHistoryHTTPAuthRootScopeAndUnavailable(t *testing.T) {
	s, root := fixture(t)
	if err := s.taskHistory.Start("history-one", 101, root); err != nil {
		t.Fatal(err)
	}
	if err := s.taskHistory.Finish("history-one", Obj{
		"ok": false, "stopped": false, "published": true,
		"code": "partial", "counts": Obj{"total": 3, "attempted": 3, "succeeded": 2, "failed": 1, "skipped": 0},
		"failures": []any{Obj{"assetId": "asset-failed", "code": "network", "retryable": true}},
	}); err != nil {
		t.Fatal(err)
	}

	// The browser's authenticated session may read history, but an anonymous
	// caller must not learn local gallery paths, account activity, or failures.
	unauth := httptest.NewRequest(http.MethodGet, s.origin+"/api/download/history", nil)
	denied := httptest.NewRecorder()
	s.ServeHTTP(denied, unauth)
	if denied.Code != http.StatusForbidden {
		t.Fatalf("anonymous history status: %d", denied.Code)
	}

	response, body := call(t, s, http.MethodGet, "/api/download/history", nil, false)
	if response.Code != http.StatusOK || str(body["root"]) != root || num(body["schemaVersion"]) != 3 {
		t.Fatalf("history response: %d %#v", response.Code, body)
	}
	items := rows(body["items"])
	if len(items) != 1 || str(items[0]["phase"]) != "partial" || !yes(items[0]["published"]) {
		t.Fatalf("history item: %#v", items)
	}
	if num(obj(items[0]["counts"])["succeeded"]) != 2 || len(arr(items[0]["failures"])) != 1 {
		t.Fatalf("history details: %#v", items[0])
	}

	limited, limitedBody := call(t, s, http.MethodGet, "/api/download/history?limit=1", nil, false)
	if limited.Code != http.StatusOK || len(rows(limitedBody["items"])) != 1 {
		t.Fatalf("bounded history query: %d %#v", limited.Code, limitedBody)
	}
	invalid, invalidBody := call(t, s, http.MethodGet, "/api/download/history?limit=abc", nil, false)
	if invalid.Code != http.StatusBadRequest || str(invalidBody["code"]) != "invalid_limit" {
		t.Fatalf("invalid history limit: %d %#v", invalid.Code, invalidBody)
	}

	other, err := s.taskHistory.List(filepath.Join(t.TempDir(), "other-gallery"), 50)
	if err != nil || len(rows(other["items"])) != 0 {
		t.Fatalf("history leaked across gallery roots: %#v %v", other, err)
	}

	history := s.taskHistory
	s.taskHistory = nil
	response, body = call(t, s, http.MethodGet, "/api/download/history", nil, false)
	s.taskHistory = history
	if response.Code != http.StatusServiceUnavailable || str(body["code"]) != "history_unavailable" {
		t.Fatalf("unavailable history: %d %#v", response.Code, body)
	}
}

func TestHistorySelectiveRetryValidation(t *testing.T) {
	cfg := filepath.Join(t.TempDir(), "app.json")
	h, err := openHistory(cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer h.Close()
	if err = h.Start("retry-source", 9, "root-A"); err != nil {
		t.Fatal(err)
	}
	if err = h.Finish("retry-source", Obj{
		"ok": false, "published": true, "stopped": false,
		"counts": Obj{"total": 2, "attempted": 2, "succeeded": 1, "failed": 1},
		"failures": []any{
			Obj{"assetId": "retryable-one", "retryable": true},
			Obj{"assetId": "permanent-one", "retryable": false},
		},
	}); err != nil {
		t.Fatal(err)
	}
	if err = h.ValidateRetry("root-A", "retry-source", []string{"retryable-one"}); err != nil {
		t.Fatalf("valid retry rejected: %v", err)
	}
	for _, tc := range []struct {
		name, root, history string
		ids                 []string
	}{
		{"wrong-root", "root-B", "retry-source", []string{"retryable-one"}},
		{"missing-history", "root-A", "missing", []string{"retryable-one"}},
		{"non-retryable", "root-A", "retry-source", []string{"permanent-one"}},
		{"unknown-asset", "root-A", "retry-source", []string{"not-in-failure-list"}},
		{"duplicate", "root-A", "retry-source", []string{"retryable-one", "retryable-one"}},
		{"empty", "root-A", "retry-source", nil},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if err := h.ValidateRetry(tc.root, tc.history, tc.ids); err == nil {
				t.Fatal("unsafe retry selection was accepted")
			}
		})
	}
}

func TestGoCoordinatorSelectiveRetrySchedulesOnlyAuthorizedFailures(t *testing.T) {
	s, root := fixture(t)
	if err := s.taskHistory.Start("retry-source", 88, root); err != nil {
		t.Fatal(err)
	}
	if err := s.taskHistory.Finish("retry-source", Obj{
		"ok": false, "published": true, "stopped": false,
		"counts": Obj{"total": 2, "attempted": 2, "succeeded": 0, "failed": 2},
		"failures": []any{
			Obj{"assetId": "retry-this", "retryable": true},
			Obj{"assetId": "do-not-retry", "retryable": false},
		},
	}); err != nil {
		t.Fatal(err)
	}
	reserved, err := s.reserveDownload(Obj{"root": root, "retryOf": "retry-source", "retryAssetIds": []any{"retry-this"}})
	if err != nil {
		t.Fatal(err)
	}
	s.run.http.Transport = deniedPublicTransport{}
	manifest := Obj{"complete": true, "assets": []any{
		Obj{"id": "retry-this", "key": "users/fixture/retry.jpg", "mime": "image/jpeg", "sz": len(jpg), "conv": "retry-conversation"},
		Obj{"id": "unselected", "key": "users/fixture/unselected.jpg", "mime": "image/jpeg", "sz": len(jpg), "conv": "retry-conversation"},
		Obj{"id": "do-not-retry", "key": "users/fixture/permanent.jpg", "mime": "image/jpeg", "sz": len(jpg), "conv": "retry-conversation"},
	}, "conversations": []any{Obj{"id": "retry-conversation", "title": "Retry fixture"}}}
	if _, err = s.startDownload(Obj{"runId": reserved["runId"], "userId": "fixture-user", "manifest": manifest}); err != nil {
		t.Fatal(err)
	}
	state := awaitRun(t, s, func(v Obj) bool { return len(rows(v["tickets"])) == 1 })
	tickets := rows(state["tickets"])
	if len(tickets) != 1 || tickets[0]["asset"].(Asset).ID != "retry-this" {
		t.Fatalf("retry scheduled assets outside the approved failure set: %#v", tickets)
	}
	s.stopDownloads()
	awaitRun(t, s, func(v Obj) bool { return obj(v["result"]) != nil })
}

func TestGoCoordinatorRejectsNonRetryableHistoryAsset(t *testing.T) {
	s, root := fixture(t)
	if err := s.taskHistory.Start("retry-source", 89, root); err != nil {
		t.Fatal(err)
	}
	if err := s.taskHistory.Finish("retry-source", Obj{
		"ok": false, "published": true, "stopped": false,
		"counts":   Obj{"total": 1, "attempted": 1, "succeeded": 0, "failed": 1},
		"failures": []any{Obj{"assetId": "permanent-one", "retryable": false}},
	}); err != nil {
		t.Fatal(err)
	}
	reserved, err := s.reserveDownload(Obj{"root": root, "retryOf": "retry-source", "retryAssetIds": []any{"permanent-one"}})
	if err != nil {
		t.Fatal(err)
	}
	_, err = s.startDownload(Obj{"runId": reserved["runId"], "userId": "fixture-user", "manifest": Obj{"complete": true, "assets": []any{}, "conversations": []any{}}})
	if err == nil {
		t.Fatal("non-retryable historical asset was accepted")
	}
	s.stopDownloads()
}

func TestHistoryMigratesV1RetryLineage(t *testing.T) {
	cfg := filepath.Join(t.TempDir(), "app.json")
	dir := filepath.Join(filepath.Dir(cfg), "stack-evo-state")
	if err := os.MkdirAll(dir, 0700); err != nil {
		t.Fatal(err)
	}
	db, err := sql.Open("sqlite", filepath.Join(dir, "history.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	_, err = db.Exec(`CREATE TABLE runs (
		id TEXT PRIMARY KEY, run_id INTEGER NOT NULL, root TEXT NOT NULL,
		started_at TEXT NOT NULL, finished_at TEXT NOT NULL DEFAULT '',
		phase TEXT NOT NULL, code TEXT NOT NULL DEFAULT '', published INTEGER NOT NULL DEFAULT 0,
		counts TEXT NOT NULL DEFAULT '{}', failures TEXT NOT NULL DEFAULT '[]');
		CREATE INDEX runs_root_started ON runs(root, started_at DESC);
		PRAGMA user_version=1;`)
	if err != nil {
		t.Fatal(err)
	}
	if err = db.Close(); err != nil {
		t.Fatal(err)
	}
	h, err := openHistory(cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer h.Close()
	var version int
	if err = h.db.QueryRow("PRAGMA user_version").Scan(&version); err != nil {
		t.Fatal(err)
	}
	if version != 3 {
		t.Fatalf("schema version = %d, want 3", version)
	}
	columns, err := h.db.Query("PRAGMA table_info(runs)")
	if err != nil {
		t.Fatal(err)
	}
	defer columns.Close()
	found := false
	for columns.Next() {
		var cid int
		var name, kind string
		var notNull, primary int
		var defaultValue any
		if err = columns.Scan(&cid, &name, &kind, &notNull, &defaultValue, &primary); err != nil {
			t.Fatal(err)
		}
		if name == "retry_of" {
			found = true
		}
	}
	if err = columns.Err(); err != nil {
		t.Fatal(err)
	}
	if !found {
		t.Fatal("v1 migration did not add retry_of")
	}
	if err = h.Start("new-run", 3, "root-A", "old-run"); err != nil {
		t.Fatal(err)
	}
	out, err := h.List("root-A", 50)
	if err != nil {
		t.Fatal(err)
	}
	items := rows(out["items"])
	if len(items) != 1 || str(items[0]["retryOf"]) != "old-run" {
		t.Fatalf("retry lineage missing: %#v", out)
	}
}

func TestSelectiveRetryPublishesCompleteManifestAndSkipsExistingFiles(t *testing.T) {
	s, root := fixture(t)
	original := filepath.Join(root, "combos", "0001_aaaaaaaa", "asset-one.jpg")
	before, err := os.Stat(original)
	if err != nil {
		t.Fatal(err)
	}
	if err = s.taskHistory.Start("retry-parent", 10, root); err != nil {
		t.Fatal(err)
	}
	if err = s.taskHistory.Finish("retry-parent", Obj{
		"published": true, "failures": []any{
			Obj{"assetId": "asset-one", "retryable": true}, Obj{"assetId": "new-image", "retryable": true},
		},
	}); err != nil {
		t.Fatal(err)
	}
	reserved, err := s.reserveDownload(Obj{"root": root, "retryOf": "retry-parent", "retryAssetIds": []any{"asset-one", "new-image"}})
	if err != nil {
		t.Fatal(err)
	}
	s.run.http.Transport = deniedPublicTransport{}
	assets := []any{}
	for _, id := range []string{"asset-one", "asset-two", "new-image", "unselected-image"} {
		assets = append(assets, Obj{"id": id, "key": "users/fixture/" + id + ".jpg", "mime": "image/jpeg", "sz": len(jpg), "conv": "conversation-aaaaaaaa"})
	}
	manifest := Obj{"complete": true, "assets": assets, "conversations": []any{Obj{"id": "conversation-aaaaaaaa", "title": "Retry fixture"}}}
	if _, err = s.startDownload(Obj{"runId": reserved["runId"], "userId": "fixture-user", "manifest": manifest}); err != nil {
		t.Fatal(err)
	}
	state := awaitRun(t, s, func(v Obj) bool { return len(rows(v["tickets"])) == 1 })
	ticket := rows(state["tickets"])[0]
	if ticket["asset"].(Asset).ID != "new-image" {
		t.Fatal("existing or unselected asset scheduled", ticket)
	}
	req := httptest.NewRequest("POST", s.origin+"/internal/download/upload/"+str(ticket["ticket"]), bytes.NewReader(jpg))
	req.Header.Set("X-Giv-Admin", s.boot.Secret)
	req.Header.Set("Origin", s.origin)
	req.Header.Set("X-Giv-Mime", "image/jpeg")
	response := httptest.NewRecorder()
	s.ServeHTTP(response, req)
	if response.Code != 200 {
		t.Fatal(response.Code, response.Body.String())
	}
	awaitRun(t, s, func(v Obj) bool { return str(v["phase"]) == "verify_account" })
	if _, err = s.authorizeDownload(Obj{"runId": reserved["runId"], "userId": "fixture-user"}); err != nil {
		t.Fatal(err)
	}
	state = awaitRun(t, s, func(v Obj) bool { return obj(v["result"]) != nil })
	result := obj(state["result"])
	if !yes(result["ok"]) || num(obj(result["counts"])["succeeded"]) != 1 || num(obj(result["counts"])["skipped"]) != 1 {
		t.Fatal(result)
	}
	index, err := readJSON(filepath.Join(root, "_index.json"))
	if err != nil || num(obj(index["summary"])["assets"]) != 4 {
		t.Fatal("selective retry truncated the complete index", index, err)
	}
	card, err := readJSON(filepath.Join(root, "combos", "0001_aaaaaaaa", "card.json"))
	if err != nil || len(rows(card["items"])) != 4 {
		t.Fatal("library members lost", card, err)
	}
	after, err := os.Stat(original)
	if err != nil || !os.SameFile(before, after) || before.ModTime() != after.ModTime() {
		t.Fatal("verified file was replaced", err)
	}
	if data, err := os.ReadFile(original); err != nil || !bytes.Equal(data, jpg) {
		t.Fatal("original bytes changed", err)
	}
	if _, err := os.Stat(filepath.Join(root, "combos", "0001_aaaaaaaa", "unselected-image.jpg")); !os.IsNotExist(err) {
		t.Fatal("unselected asset downloaded", err)
	}
	history, err := s.taskHistory.List(root, 50)
	if err != nil {
		t.Fatal("retry lineage missing", history, err)
	}
	// Windows can timestamp parent and retry in the same clock tick. Their ID
	// tie-break order is valid; lineage belongs to this run, not the first row.
	found := false
	for _, row := range rows(history["items"]) {
		if str(row["id"]) == s.run.Token && str(row["retryOf"]) == "retry-parent" && num(row["runId"]) == num(reserved["runId"]) {
			found = true
		}
	}
	if !found {
		t.Fatal("retry lineage missing", history)
	}
}

func TestHistoryRejectsStaleRootAndOutOfRangeLimits(t *testing.T) {
	s, root := fixture(t)
	for _, value := range []string{"0", "-1", "201", "1&limit=2"} {
		response, _ := call(t, s, "GET", "/api/download/history?limit="+value, nil, false)
		if response.Code != 400 {
			t.Fatalf("limit %q accepted: %d", value, response.Code)
		}
	}
	response, _ := call(t, s, "GET", "/api/download/history?expectedRoot="+url.QueryEscape(filepath.Join(root, "other")), nil, false)
	if response.Code != 409 {
		t.Fatalf("stale root accepted: %d", response.Code)
	}
	if err := s.taskHistory.Start("running", 1, root); err != nil {
		t.Fatal(err)
	}
	response, body := call(t, s, "GET", "/api/download/history?expectedRoot="+url.QueryEscape(root), nil, false)
	if response.Code != 200 || len(rows(body["items"])) != 1 {
		t.Fatal(body)
	}
	if rows(body["items"])[0]["failures"] == nil {
		t.Fatal("running history must expose an array")
	}
}
