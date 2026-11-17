package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

var jpg = append([]byte{255, 216, 255, 224}, bytes.Repeat([]byte{64}, 128)...)

func writeFixture(t testing.TB, path string, data []byte) {
	t.Helper()
	if e := os.MkdirAll(filepath.Dir(path), 0700); e != nil {
		t.Fatal(e)
	}
	if e := os.WriteFile(path, data, 0600); e != nil {
		t.Fatal(e)
	}
}
func jsonFixture(t testing.TB, p string, o any) {
	t.Helper()
	if e := atomicJSON(p, o); e != nil {
		t.Fatal(e)
	}
}
func fixture(t *testing.T) (*Server, string) {
	t.Helper()
	base := t.TempDir()
	root := filepath.Join(base, "gallery")
	desktop := filepath.Join(base, "desktop")
	os.MkdirAll(desktop, 0700)
	group := filepath.Join(root, "combos", "0001_aaaaaaaa")
	writeFixture(t, filepath.Join(group, "asset-one.jpg"), jpg)
	writeFixture(t, filepath.Join(group, "asset-two.jpg"), jpg)
	items := []any{Obj{"id": "asset-one", "file": "asset-one.jpg", "mime": "image/jpeg", "created": "2026-08-01T12:00:00Z", "prompt": "提示词一", "status": "linked"}, Obj{"id": "asset-two", "file": "asset-two.jpg", "mime": "image/jpeg", "created": "2026-10-01T12:00:00Z", "prompt": "提示词二", "status": "linked"}}
	card := Obj{"id": "conversation-aaaaaaaa", "n": 1, "title": "原始标题", "created": "2026-07-01T12:00:00Z", "folder": "0001_aaaaaaaa", "items": items}
	jsonFixture(t, filepath.Join(group, "card.json"), card)
	jsonFixture(t, filepath.Join(root, "_index.json"), Obj{"combos": []any{summary(card, "0001_aaaaaaaa")}, "other": []any{}, "summary": Obj{}})
	ctx, cancel := context.WithCancel(context.Background())
	s, e := NewServer(ctx, Bootstrap{Secret: strings.Repeat("a", 64), Token: strings.Repeat("b", 64), Instance: "fixture", Static: filepath.Join(base, "static"), Config: filepath.Join(base, "settings.json"), Desktop: desktop, Language: "zh-CN"})
	if e != nil {
		t.Fatal(e)
	}
	t.Cleanup(func() { cancel(); s.stopDownloads(); s.close() })
	s.origin = "http://127.0.0.1:19123"
	s.cookie = "giv_19123"
	if _, e = s.selectRoot(root); e != nil {
		t.Fatal(e)
	}
	return s, s.snapshot().Root
}
func call(t *testing.T, s *Server, method, path string, p any, admin bool) (*httptest.ResponseRecorder, Obj) {
	t.Helper()
	var data []byte
	if p != nil {
		data, _ = json.Marshal(p)
	}
	r := httptest.NewRequest(method, s.origin+path, bytes.NewReader(data))
	r.Header.Set("Origin", s.origin)
	r.Header.Set("Content-Type", "application/json")
	if admin {
		r.Header.Set("X-Giv-Admin", s.boot.Secret)
	} else {
		r.AddCookie(&http.Cookie{Name: s.cookie, Value: s.boot.Token})
	}
	w := httptest.NewRecorder()
	s.ServeHTTP(w, r)
	o, _ := decode(w.Body.Bytes())
	return w, o
}
func TestAuthAndHTTPRange(t *testing.T) {
	s, root := fixture(t)
	_ = root
	t.Run("Unauthenticated", func(t *testing.T) {
		r := httptest.NewRequest("GET", s.origin+"/api/meta", nil)
		w := httptest.NewRecorder()
		s.ServeHTTP(w, r)
		if w.Code != 403 {
			t.Fatal(w.Code)
		}
	})
	t.Run("ExactHost", func(t *testing.T) {
		r := httptest.NewRequest("GET", s.origin+"/api/meta", nil)
		r.Host = "localhost:19123"
		r.Header.Set("X-Giv-Admin", s.boot.Secret)
		w := httptest.NewRecorder()
		s.ServeHTTP(w, r)
		if w.Code != 403 {
			t.Fatal(w.Code)
		}
	})
	t.Run("BadHeaderCannotUseCookie", func(t *testing.T) {
		r := httptest.NewRequest("GET", s.origin+"/api/meta", nil)
		r.Header.Set("X-Viewer-Session", "bad")
		r.AddCookie(&http.Cookie{Name: s.cookie, Value: s.boot.Token})
		w := httptest.NewRecorder()
		s.ServeHTTP(w, r)
		if w.Code != 403 {
			t.Fatal(w.Code)
		}
	})
	t.Run("NativeOnly", func(t *testing.T) {
		w, _ := call(t, s, "GET", "/internal/download/status", nil, false)
		if w.Code != 403 {
			t.Fatal(w.Code)
		}
	})
	t.Run("CrossOriginWrite", func(t *testing.T) {
		r := httptest.NewRequest("POST", s.origin+"/api/root", strings.NewReader(`{}`))
		r.Header.Set("Origin", "https://grok.com")
		r.Header.Set("Content-Type", "application/json")
		r.Header.Set("X-Giv-Admin", s.boot.Secret)
		w := httptest.NewRecorder()
		s.ServeHTTP(w, r)
		if w.Code != 403 {
			t.Fatal(w.Code)
		}
	})
	t.Run("RangeAndClose", func(t *testing.T) {
		r := httptest.NewRequest("GET", s.origin+"/media/combos/0001_aaaaaaaa/asset-one.jpg", nil)
		r.Header.Set("X-Giv-Admin", s.boot.Secret)
		r.Header.Set("Range", "bytes=0-3")
		w := httptest.NewRecorder()
		s.ServeHTTP(w, r)
		if w.Code != 206 || !bytes.Equal(w.Body.Bytes(), jpg[:4]) {
			t.Fatalf("%d %q", w.Code, w.Body.String())
		}
	})
	t.Run("NoSecretConfig", func(t *testing.T) {
		w, _ := call(t, s, "GET", "/api/config?minimal=1", nil, true)
		if w.Code != 200 || strings.Contains(w.Body.String(), s.boot.Secret) || strings.Contains(w.Body.String(), s.boot.Token) {
			t.Fatal(w.Body.String())
		}
	})
}
func TestLibraryAndMetaParity(t *testing.T) {
	s, root := fixture(t)
	w, lib := call(t, s, "GET", "/api/library", nil, true)
	if w.Code != 200 || len(arr(lib["combos"])) != 1 {
		t.Fatal(lib)
	}
	_, combo := call(t, s, "GET", "/api/combo?section=combos&folder=0001_aaaaaaaa", nil, true)
	if len(arr(combo["items"])) != 2 {
		t.Fatal(combo)
	}
	if str(obj(combo["card"])["created"]) != "2026-07-01T12:00:00Z" || str(obj(combo["card"])["latestItemCreatedAt"]) != "2026-10-01T12:00:00Z" {
		t.Fatal(combo)
	}
	_, flat := call(t, s, "GET", "/api/flat", nil, true)
	if len(arr(flat["items"])) != 2 {
		t.Fatal(flat)
	}
	p := Obj{"expectedRoot": root, "expectedRevision": 0, "item": Obj{"id": "asset-one", "fav": true, "tags": []any{"角色", "ACG"}}}
	w, m := call(t, s, "PUT", "/api/meta", p, false)
	if w.Code != 200 || num(obj(m["meta"])["revision"]) != 1 {
		t.Fatal(m)
	}
	_, combo = call(t, s, "GET", "/api/combo?section=combos&folder=0001_aaaaaaaa", nil, true)
	card := obj(combo["card"])
	if !yes(card["fav"]) || yes(card["ownFav"]) || len(arr(card["inheritedTags"])) != 2 {
		t.Fatal(card)
	}
	p["expectedRevision"] = 1
	p["item"] = Obj{"id": "asset-one", "fav": false, "tags": []any{}}
	w, m = call(t, s, "PUT", "/api/meta", p, false)
	if w.Code != 200 {
		t.Fatal(m)
	}
	_, combo = call(t, s, "GET", "/api/combo?section=combos&folder=0001_aaaaaaaa", nil, true)
	if yes(obj(combo["card"])["fav"]) || len(arr(obj(combo["card"])["tags"])) != 0 {
		t.Fatal(combo)
	}
	w, _ = call(t, s, "PUT", "/api/meta", p, false)
	if w.Code != 409 {
		t.Fatalf("stale revision accepted %d", w.Code)
	}
	p["expectedRevision"] = 2
	w, m = call(t, s, "PUT", "/api/meta", p, false)
	if w.Code != 200 || num(obj(m["meta"])["revision"]) != 2 {
		t.Fatal("no-op consumed revision", m)
	}
	p["expectedRoot"] = t.TempDir()
	w, _ = call(t, s, "PUT", "/api/meta", p, false)
	if w.Code != 409 {
		t.Fatal("wrong root accepted")
	}
	p["expectedRoot"] = root
	p["grokUserId"] = "other"
	w, _ = call(t, s, "PUT", "/api/meta", p, false)
	if w.Code != 400 {
		t.Fatal("binding override allowed")
	}
}
func TestCorruptAndFutureMetadataPreserved(t *testing.T) {
	for _, raw := range []string{"{bad", `{"version":99}`, `{"version":2,"revision":"1"}`} {
		t.Run(raw, func(t *testing.T) {
			s, root := fixture(t)
			p := filepath.Join(root, ".viewer-meta.json")
			writeFixture(t, p, []byte(raw))
			w, _ := call(t, s, "PUT", "/api/meta", Obj{"expectedRoot": root, "expectedRevision": 0, "addTag": "bad"}, true)
			b, _ := os.ReadFile(p)
			if w.Code != 409 || string(b) != raw {
				t.Fatal("corrupt metadata changed")
			}
		})
	}
}
func TestV1MigrationAndPrecision(t *testing.T) {
	s, root := fixture(t)
	p := filepath.Join(root, ".viewer-meta.json")
	jsonFixture(t, p, Obj{"version": 1, "tags": []any{"ACG"}, "items": Obj{}, "groups": Obj{}, "grokUserId": "user-one"})
	m, e := loadMeta(root)
	if e != nil || num(m["revision"]) != 0 {
		t.Fatal(m, e)
	}
	old, _ := readJSON(p)
	if num(old["version"]) != 1 {
		t.Fatal("read migrated file")
	}
	w, _ := call(t, s, "PUT", "/api/meta", Obj{"expectedRoot": root, "expectedRevision": 0, "addTag": "新"}, true)
	if w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	old, _ = readJSON(p)
	if str(old["grokUserId"]) != "user-one" || num(old["version"]) != 2 {
		t.Fatal(old)
	}
	v, e := decode([]byte(`{"mtimeNs":1788901234567890123}`))
	if e != nil || num(v["mtimeNs"]) != 1788901234567890123 {
		t.Fatal(v, e)
	}
}
func TestSaveCopyAndPreferences(t *testing.T) {
	s, root := fixture(t)
	w, p := call(t, s, "GET", "/api/preferences", nil, true)
	if w.Code != 200 || str(obj(p["preferences"])["saveDirectory"]) != s.boot.Desktop {
		t.Fatal(p)
	}
	w, p = call(t, s, "PUT", "/api/preferences", Obj{"language": "en", "wheelVolumeStep": 7}, true)
	if w.Code != 200 {
		t.Fatal(p)
	}
	for i := 0; i < 2; i++ {
		w, p = call(t, s, "POST", "/api/save-copy", Obj{"expectedRoot": root, "section": "combos", "folder": "0001_aaaaaaaa", "id": "asset-one"}, true)
		if w.Code != 200 {
			t.Fatal(p)
		}
		b, e := os.ReadFile(str(p["path"]))
		if e != nil || !bytes.Equal(b, jpg) {
			t.Fatal(e, p)
		}
	}
	if !exists(filepath.Join(s.boot.Desktop, "asset-one (1).jpg")) {
		t.Fatal("same-name copy overwritten")
	}
	if !exists(filepath.Join(root, "combos", "0001_aaaaaaaa", "asset-one.jpg")) {
		t.Fatal("original moved")
	}
}
func TestTrashRestorePurgeAndConflict(t *testing.T) {
	s, root := fixture(t)
	source := filepath.Join(root, "combos", "0001_aaaaaaaa", "asset-one.jpg")
	put := func() Obj {
		w, o := call(t, s, "POST", "/api/trash", Obj{"expectedRoot": root, "section": "combos", "folder": "0001_aaaaaaaa", "ids": []any{"asset-one"}}, true)
		if w.Code != 200 || len(arr(o["moved"])) != 1 || len(arr(o["errors"])) != 0 {
			t.Fatal(o)
		}
		return rows(o["moved"])[0]
	}
	put()
	if exists(source) {
		t.Fatal("source not quarantined")
	}
	_, o := call(t, s, "GET", "/api/trash", nil, true)
	if len(arr(o["items"])) != 1 {
		t.Fatal(o)
	}
	writeFixture(t, source, []byte("new user data"))
	_, o = call(t, s, "POST", "/api/trash/restore", Obj{"expectedRoot": root, "ids": []any{"asset-one"}}, true)
	b, _ := os.ReadFile(source)
	if len(arr(o["conflicts"])) != 1 || string(b) != "new user data" {
		t.Fatal(o)
	}
	os.Remove(source)
	_, o = call(t, s, "POST", "/api/trash/restore", Obj{"expectedRoot": root, "ids": []any{"asset-one"}}, true)
	if len(arr(o["restored"])) != 1 || !exists(source) {
		t.Fatal(o)
	}
	put()
	_, o = call(t, s, "POST", "/api/trash/purge", Obj{"expectedRoot": root, "ids": []any{"asset-one"}}, true)
	if len(arr(o["purged"])) != 1 || exists(source) {
		t.Fatal(o)
	}
	tomb, _ := readJSON(filepath.Join(root, ".trash", "by-id", "asset-one.json"))
	if str(tomb["phase"]) != "purged" {
		t.Fatal(tomb)
	}
}
func TestTrashTamperRefused(t *testing.T) {
	s, root := fixture(t)
	_, o := call(t, s, "POST", "/api/trash", Obj{"expectedRoot": root, "section": "combos", "folder": "0001_aaaaaaaa", "ids": []any{"asset-one"}}, true)
	row := rows(o["moved"])[0]
	body := filepath.Join(root, filepath.FromSlash(str(row["to"])))
	st, _ := os.Stat(body)
	wrong := bytes.Repeat([]byte{42}, len(jpg))
	writeFixture(t, body, wrong)
	os.Chtimes(body, st.ModTime(), st.ModTime())
	_, o = call(t, s, "POST", "/api/trash/purge", Obj{"expectedRoot": root, "ids": []any{"asset-one"}}, true)
	if len(arr(o["errors"])) != 1 || !exists(body) {
		t.Fatal("corrupt body purged", o)
	}
}
func TestDedupPlanCopyScope(t *testing.T) {
	s, root := fixture(t)
	old := filepath.Join(root, "combos", "0120_aaaaaaaa")
	writeFixture(t, filepath.Join(old, "asset-one.jpg"), jpg)
	_, plan := call(t, s, "POST", "/api/library/dedup", Obj{"expectedRoot": root}, true)
	if len(arr(plan["groups"])) != 1 {
		t.Fatal(plan)
	}
	key := str(rows(plan["groups"])[0]["key"])
	_, out := call(t, s, "POST", "/api/library/dedup", Obj{"expectedRoot": root, "apply": true, "planToken": plan["planToken"], "actions": Obj{key: "keep_newest"}}, true)
	if len(arr(out["moved"])) != 1 || len(arr(out["errors"])) != 0 {
		t.Fatal(out)
	}
	id := str(rows(out["moved"])[0]["id"])
	if !strings.HasPrefix(id, "copy:") || exists(filepath.Join(root, ".trash", "by-id", "asset-one.json")) {
		t.Fatal(out)
	}
	_, out = call(t, s, "POST", "/api/trash/restore", Obj{"expectedRoot": root, "ids": []any{id}}, true)
	if len(arr(out["restored"])) != 1 || !exists(filepath.Join(old, "asset-one.jpg")) {
		t.Fatal(out)
	}
	w, _ := call(t, s, "POST", "/api/library/dedup", Obj{"expectedRoot": root, "apply": true, "planToken": plan["planToken"], "actions": Obj{key: "keep_newest"}}, true)
	if w.Code != 409 {
		t.Fatal("reused plan accepted")
	}
}
func TestDedupStaleAndUniquePreserved(t *testing.T) {
	s, root := fixture(t)
	old := filepath.Join(root, "combos", "0120_aaaaaaaa")
	writeFixture(t, filepath.Join(old, "asset-one.jpg"), jpg)
	writeFixture(t, filepath.Join(old, "unique.jpg"), jpg)
	_, plan := call(t, s, "POST", "/api/library/dedup", Obj{"expectedRoot": root}, true)
	key := str(rows(plan["groups"])[0]["key"])
	source := filepath.Join(old, "asset-one.jpg")
	st, _ := os.Stat(source)
	writeFixture(t, source, append([]byte{0}, jpg[1:]...))
	os.Chtimes(source, st.ModTime(), st.ModTime())
	w, _ := call(t, s, "POST", "/api/library/dedup", Obj{"expectedRoot": root, "apply": true, "planToken": plan["planToken"], "actions": Obj{key: "keep_newest"}}, true)
	if w.Code != 409 || !exists(source) || !exists(filepath.Join(old, "unique.jpg")) {
		t.Fatal("stale plan applied")
	}
}
func TestPathLocksAndAtomicNoReplace(t *testing.T) {
	s, root := fixture(t)
	_ = s
	for _, name := range []string{"../outside", "CON", "a/b", "a\\b", "C:other", "trailing.", "a\x00b"} {
		if safeName(name) {
			t.Fatalf("unsafe name %q", name)
		}
	}
	for _, name := range []string{"../x", filepath.Join("..", "other"), "/absolute"} {
		if _, e := jailed(root, name); e == nil {
			t.Fatal(name)
		}
	}
	lock, e := acquireLease(root, ".viewer-write.lock")
	if e != nil {
		t.Fatal(e)
	}
	if second, e := acquireLease(root, ".viewer-write.lock"); e == nil {
		second.Close()
		t.Fatal("overlapping writers")
	}
	lock.Close()
	if !exists(filepath.Join(root, ".viewer-write.lock")) {
		t.Fatal("permanent lock deleted")
	}
	a, b := filepath.Join(root, "one"), filepath.Join(root, "two")
	writeFixture(t, a, []byte("one"))
	writeFixture(t, b, []byte("two"))
	if e = publishNoReplace(a, b); e == nil {
		t.Fatal("overwrote destination")
	}
	data, _ := os.ReadFile(b)
	if string(data) != "two" || !exists(a) {
		t.Fatal("no-overwrite violated")
	}
	outside := t.TempDir()
	link := filepath.Join(root, "link")
	if e = os.Symlink(outside, link); e == nil {
		if _, e = jailed(root, "link/x"); e == nil {
			t.Fatal("link escaped jail")
		}
	}
}
func TestRootCacheAndConcurrentReads(t *testing.T) {
	s, root := fixture(t)
	snap := s.snapshot()
	var wg sync.WaitGroup
	for n := 0; n < 16; n++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			c, e := s.combo(snap, "combos", "0001_aaaaaaaa")
			if e != nil || len(arr(c["items"])) != 2 {
				t.Error(e, c)
			}
		}()
	}
	wg.Wait()
	s.cacheMu.Lock()
	cached := len(s.groups)
	s.cacheMu.Unlock()
	if cached != 1 {
		t.Fatal(cached)
	}
	_, items, e := s.readGroup(snap, "combos", "0001_aaaaaaaa")
	if e != nil {
		t.Fatal(e)
	}
	items[0]["prompt"] = "modified returned array"
	_, again, _ := s.readGroup(snap, "combos", "0001_aaaaaaaa")
	if str(again[0]["prompt"]) == "modified returned array" {
		t.Fatal("caller changed cached data")
	}
	_, e = s.selectRoot(root)
	if e != nil {
		t.Fatal(e)
	}
	if !s.stale(snap) {
		t.Fatal("same-root refresh not versioned")
	}
}
func TestMediaReadBoundsAndCancellation(t *testing.T) {
	root := t.TempDir()
	p := filepath.Join(root, "one.part")
	if _, e := receiveMedia(context.Background(), bytes.NewReader(jpg), p, "image/jpeg", int64(len(jpg)+1)); e == nil || exists(p) {
		t.Fatal("short body kept")
	}
	if _, e := receiveMedia(context.Background(), bytes.NewReader([]byte("<html>login")), p, "image/jpeg", -1); e == nil || exists(p) {
		t.Fatal("HTML saved as jpg")
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, e := receiveMedia(ctx, bytes.NewReader(jpg), p, "image/jpeg", -1); e == nil || exists(p) {
		t.Fatal("cancelled output kept")
	}
	writeFixture(t, p, []byte("user file"))
	if _, e := receiveMedia(context.Background(), bytes.NewReader(jpg), p, "image/jpeg", -1); e == nil {
		t.Fatal("stage overwritten")
	}
	data, _ := os.ReadFile(p)
	if string(data) != "user file" {
		t.Fatal("unowned stage removed")
	}
}

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }
func waitRun(t *testing.T, s *Server, user string, upload bool) Obj {
	t.Helper()
	deadline := time.Now().Add(12 * time.Second)
	used := map[string]bool{}
	for time.Now().Before(deadline) {
		state := s.downloadStatus()
		if r := obj(state["result"]); len(r) > 0 {
			return r
		}
		if str(state["phase"]) == "verify_account" {
			s.authorizeDownload(Obj{"runId": state["runId"], "userId": user})
		}
		if upload {
			for _, ticket := range rows(state["tickets"]) {
				id := str(ticket["ticket"])
				if used[id] {
					continue
				}
				used[id] = true
				req := httptest.NewRequest("POST", s.origin+"/internal/download/upload/"+id, bytes.NewReader(jpg))
				req.Header.Set("X-Giv-Admin", s.boot.Secret)
				req.Header.Set("Origin", s.origin)
				req.Header.Set("X-Giv-Mime", "image/jpeg")
				w := httptest.NewRecorder()
				s.ServeHTTP(w, req)
				if w.Code != 200 {
					t.Fatal(w.Body.String())
				}
			}
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatal("run timed out", s.downloadStatus())
	return nil
}
func TestDownloadStreamingMixedAndStableLayout(t *testing.T) {
	s, root := fixture(t)
	w, reserve := call(t, s, "POST", "/internal/download/reserve", Obj{"root": root}, true)
	if w.Code != 200 {
		t.Fatal(reserve)
	}
	s.runMu.Lock()
	run := s.run
	s.runMu.Unlock()
	var requests atomic.Int32
	run.http.Transport = roundTripFunc(func(r *http.Request) (*http.Response, error) {
		requests.Add(1)
		if r.Header.Get("Cookie") != "" || r.Header.Get("Authorization") != "" {
			t.Error("credential crossed HTTP boundary")
		}
		status := 200
		data := jpg
		if strings.Contains(r.URL.Path, "asset-four") {
			status = 403
			data = []byte("private")
		}
		return &http.Response{StatusCode: status, Header: http.Header{"Content-Type": []string{"image/jpeg"}}, Body: io.NopCloser(bytes.NewReader(data)), ContentLength: int64(len(data)), Request: r}, nil
	})
	manifest := Obj{"complete": true, "assets": []any{Obj{"id": "asset-three", "key": "asset-three", "mime": "image/jpeg", "conv": "conversation-aaaaaaaa", "t": "2026-10-12T00:00:00Z"}, Obj{"id": "asset-four", "key": "asset-four", "mime": "image/jpeg", "conv": "conversation-aaaaaaaa", "t": "2026-10-13T00:00:00Z"}}, "conversations": []any{Obj{"id": "conversation-aaaaaaaa", "title": "更新标题", "t": "2026-07-01T12:00:00Z"}}}
	w, o := call(t, s, "POST", "/internal/download/start", Obj{"runId": reserve["runId"], "userId": "user-one", "manifest": manifest}, true)
	if w.Code != 200 {
		t.Fatal(o)
	}
	result := waitRun(t, s, "user-one", true)
	if !yes(result["ok"]) || !yes(result["published"]) || num(obj(result["counts"])["succeeded"]) != 2 {
		t.Fatal(result)
	}
	if requests.Load() < 1 {
		t.Fatal("no HTTP path")
	}
	index, _ := readJSON(filepath.Join(root, "_index.json"))
	if str(rows(index["combos"])[0]["folder"]) != "0001_aaaaaaaa" {
		t.Fatal("old folder renamed")
	}
	for _, id := range []string{"asset-one", "asset-two", "asset-three", "asset-four"} {
		if !exists(filepath.Join(root, "combos", "0001_aaaaaaaa", id+".jpg")) {
			t.Fatal("member lost", id)
		}
	}
	meta, _ := loadMeta(root)
	if str(meta["grokUserId"]) != "user-one" {
		t.Fatal(meta)
	}
	if exists(filepath.Join(root, "_state", ".giv-go-download.json")) {
		t.Fatal("active journal not finalized")
	}
}
func TestManifestGuardAndReservation(t *testing.T) {
	s, root := fixture(t)
	for _, m := range []Obj{{}, {"complete": true, "assets": []any{}}, {"complete": true, "assets": []any{}, "conversations": "bad"}} {
		if _, e := validateManifest(m); e == nil {
			t.Fatal("invalid manifest accepted", m)
		}
	}
	reserve, e := s.reserveDownload(Obj{"root": root})
	if e != nil {
		t.Fatal(e)
	}
	if _, e = s.reserveDownload(Obj{"root": root}); e == nil {
		t.Fatal("parallel reservation")
	}
	if _, e = s.selectRoot(root); e == nil {
		t.Fatal("switch while downloading")
	}
	if _, e = s.startDownload(Obj{"runId": reserve["runId"], "userId": "user-one", "manifest": Obj{"complete": true, "assets": []any{}, "conversations": []any{}}}); e != nil {
		t.Fatal(e)
	}
	result := waitRun(t, s, "user-one", false)
	if str(result["code"]) != "empty_manifest_guard" {
		t.Fatal(result)
	}
	if exists(filepath.Join(root, ".viewer-meta.json")) {
		t.Fatal("empty manifest bound account")
	}
}
func TestDownloadAccountMismatchAndLegacyJournal(t *testing.T) {
	for _, legacy := range []bool{false, true} {
		t.Run(map[bool]string{false: "account", true: "legacy"}[legacy], func(t *testing.T) {
			s, root := fixture(t)
			meta := defaultMeta()
			meta["grokUserId"] = "different-user"
			jsonFixture(t, filepath.Join(root, ".viewer-meta.json"), meta)
			if legacy {
				jsonFixture(t, filepath.Join(root, "_state", ".giv-download-journal-v1.json"), Obj{"version": 2, "phase": "publishing"})
			}
			res, e := s.reserveDownload(Obj{"root": root})
			if e != nil {
				t.Fatal(e)
			}
			m := Obj{"complete": true, "assets": []any{Obj{"id": "newasset", "key": "newasset", "mime": "image/jpeg"}}, "conversations": []any{}}
			_, e = s.startDownload(Obj{"runId": res["runId"], "userId": "user-one", "manifest": m})
			if e != nil {
				t.Fatal(e)
			}
			out := waitRun(t, s, "user-one", false)
			expected := "account_mismatch"
			if legacy {
				expected = "legacy_recovery_required"
			}
			if str(out["code"]) != expected {
				t.Fatal(out)
			}
			after, _ := loadMeta(root)
			if str(after["grokUserId"]) != "different-user" {
				t.Fatal("binding changed")
			}
		})
	}
}
func TestDownloadRecoveryUsesExactSnapshot(t *testing.T) {
	s, root := fixture(t)
	res, e := s.reserveDownload(Obj{"root": root})
	_ = res
	if e != nil {
		t.Fatal(e)
	}
	r := s.run
	r.User = "user-one"
	if e = r.bind(); e != nil {
		t.Fatal(e)
	}
	m := Manifest{Complete: true, Assets: []Asset{{ID: "recover-one", Mime: "image/jpeg", Key: "recover-one", Conv: "conversation-aaaaaaaa"}}, Conversations: []Conversation{{ID: "conversation-aaaaaaaa", Title: "recovered"}}}
	if e = r.journal("media", m); e != nil {
		t.Fatal(e)
	}
	tk := token()
	part, final, e := r.part(m.Assets[0], tk)
	if e != nil {
		t.Fatal(e)
	}
	writeFixture(t, part, jpg)
	if e = r.record(m.Assets[0], tk, int64(len(jpg)), "ready"); e != nil {
		t.Fatal(e)
	}
	if e = r.recoverPrevious(); e != nil {
		t.Fatal(e)
	}
	if exists(final) || exists(part) || !exists(filepath.Join(root, "combos", "0001_aaaaaaaa", "recover-one.jpg")) {
		t.Fatal("snapshot not recovered")
	}
	s.stopDownloads()
}
func TestDownloadRedirectAndBudget(t *testing.T) {
	for _, raw := range []string{"http://assets.grok.com/a", "https://assets.grok.com:8443/a", "https://assets.grok.com.evil/a", "https://user@assets.grok.com/a", "https://assets.grok.com/a#x"} {
		u, _ := url.Parse(raw)
		if allowedMediaURL(u) {
			t.Fatal(raw)
		}
	}
	for _, key := range []string{"../a", "/absolute", "bad?url", "a//b", "a/%2e%2e/b"} {
		if _, e := mediaURLFor(key); e == nil {
			t.Fatal(key)
		}
	}
	if !allowedMediaURL(&url.URL{Scheme: "https", Host: "assets.grok.com", Path: "/a"}) {
		t.Fatal("valid URL rejected")
	}
}
func TestCancellationDoesNotReleaseActiveUploadEarly(t *testing.T) {
	s, root := fixture(t)
	_, e := s.reserveDownload(Obj{"root": root})
	if e != nil {
		t.Fatal(e)
	}
	s.stopDownloads()
	state := s.downloadStatus()
	if yes(state["active"]) || !yes(obj(state["result"])["stopped"]) {
		t.Fatal(state)
	}
	lock, e := acquireLease(root, ".viewer-write.lock")
	if e != nil {
		t.Fatal(e)
	}
	lock.Close()
}
func TestReadFailureNeverBecomesEmptyIndex(t *testing.T) {
	s, root := fixture(t)
	before, _ := os.ReadFile(filepath.Join(root, "_index.json"))
	for _, raw := range []string{"{}", "{bad", `{"combos":{},"other":[]}`} {
		writeFixture(t, filepath.Join(root, "_index.json"), []byte(raw))
		if _, e := s.library(false); e == nil {
			t.Fatal("bad index used", raw)
		}
		data, _ := os.ReadFile(filepath.Join(root, "_index.json"))
		if string(data) != raw {
			t.Fatal("bad index overwritten")
		}
	}
	writeFixture(t, filepath.Join(root, "_index.json"), before)
}
func TestSmallBodiesAndIOErrors(t *testing.T) {
	r := errReader{}
	p := filepath.Join(t.TempDir(), "x.part")
	if _, e := receiveMedia(context.Background(), r, p, "image/jpeg", -1); e == nil || exists(p) {
		t.Fatal("I/O failure not cleaned")
	}
}

type errReader struct{}

func (errReader) Read([]byte) (int, error) { return 0, errors.New("fixture read error") }

func TestLibraryShellKeepsFrontendContract(t *testing.T) {
	s, root := fixture(t)
	lib, e := s.library(false)
	if e != nil {
		t.Fatal(e)
	}
	for _, key := range []string{"tags", "hasTrash", "live", "metaError", "combos", "other", "summary"} {
		if _, ok := lib[key]; !ok {
			t.Fatal("missing shell field", key)
		}
	}
	if yes(lib["hasTrash"]) {
		t.Fatal("empty trash advertised")
	}
	_, e = s.withWrite(Obj{"expectedRoot": root}, false, func(snap Snapshot) (Obj, error) {
		return s.trashAdd(snap, Obj{"section": "combos", "folder": "0001_aaaaaaaa", "ids": []any{"asset-one"}})
	})
	if e != nil {
		t.Fatal(e)
	}
	lib, e = s.library(false)
	if e != nil || !yes(lib["hasTrash"]) {
		t.Fatal(lib, e)
	}
}
func TestInterruptedTrashBeforeMoveIsDiscoverableAndUndoable(t *testing.T) {
	s, root := fixture(t)
	snap := s.snapshot()
	row, e := s.quarantine(snap, "combos", "0001_aaaaaaaa", Obj{"id": "asset-one", "file": "asset-one.jpg"}, false)
	if e != nil {
		t.Fatal(e)
	}
	rec, origin, body, _, e := trashPaths(snap, row)
	if e != nil {
		t.Fatal(e)
	}
	// A valid WAL before the move, as observed after a power loss or failed link.
	if e = moveNoReplace(body, origin); e != nil {
		t.Fatal(e)
	}
	row["phase"] = "trashing"
	jsonFixture(t, rec, row)
	s.invalidate()
	listing, e := s.trashList(snap)
	if e != nil || len(arr(listing["items"])) != 1 {
		t.Fatal(listing, e)
	}
	result, e := s.withWrite(Obj{"expectedRoot": root}, false, func(snap Snapshot) (Obj, error) { return s.trashChange(snap, Obj{"ids": []any{"asset-one"}}, false) })
	if e != nil || len(arr(result["restored"])) != 1 || !exists(origin) || exists(rec) {
		t.Fatal(result, e)
	}
}
func TestDownloadRecoveryRefusesUnknownSchemaAndSameSizeReplacement(t *testing.T) {
	s, root := fixture(t)
	_, e := s.reserveDownload(Obj{"root": root})
	if e != nil {
		t.Fatal(e)
	}
	r := s.run
	r.User = "user-one"
	a := Asset{ID: "recover-one", Mime: "image/jpeg", Key: "recover-one", Conv: "conversation-aaaaaaaa"}
	m := Manifest{Complete: true, Assets: []Asset{a}, Conversations: []Conversation{{ID: "conversation-aaaaaaaa"}}}
	if e = r.journal("media", m); e != nil {
		t.Fatal(e)
	}
	tk := token()
	part, _, _ := r.part(a, tk)
	writeFixture(t, part, jpg)
	if e = r.record(a, tk, int64(len(jpg)), "ready"); e != nil {
		t.Fatal(e)
	}
	bad := append([]byte{}, jpg...)
	bad[len(bad)-1] ^= 1
	writeFixture(t, part, bad)
	if e = r.recoverPrevious(); e == nil || !exists(part) {
		t.Fatal("replacement should retain recovery evidence", e)
	}
	writeFixture(t, part, jpg)
	header := filepath.Join(root, "_state", ".giv-go-download.json")
	o, _ := readJSON(header)
	o["unknown"] = true
	jsonFixture(t, header, o)
	if e = r.recoverPrevious(); e == nil || !exists(part) {
		t.Fatal("unknown control schema accepted", e)
	}
	s.stopDownloads()
}

func TestParseRetryAfter(t *testing.T) {
	now := time.Date(2026, 10, 26, 12, 0, 0, 0, time.UTC)
	cases := []struct {
		name string
		raw  string
		want time.Duration
	}{
		{name: "delta seconds", raw: "7", want: 7 * time.Second},
		{name: "negative seconds", raw: "-2", want: 0},
		{name: "past date", raw: now.Add(-time.Second).Format(http.TimeFormat), want: 0},
		{name: "future date", raw: now.Add(25 * time.Second).Format(http.TimeFormat), want: 25 * time.Second},
		{name: "clamped date", raw: now.Add(2 * time.Minute).Format(http.TimeFormat), want: 60 * time.Second},
		{name: "clamped seconds", raw: "999999999999999999999", want: 60 * time.Second},
		{name: "malformed", raw: "not-a-date", want: 0},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := parseRetryAfter(tc.raw, now); got != tc.want {
				t.Fatalf("parseRetryAfter(%q) = %s, want %s", tc.raw, got, tc.want)
			}
		})
	}
}

func TestServerKeepsGalleryAvailableWhenHistoryIsUnavailable(t *testing.T) {
	base := t.TempDir()
	config := filepath.Join(base, "settings.json")
	writeFixture(t, config, []byte("{}\n"))
	historyPath := filepath.Join(base, "stack-evo-state", "history.sqlite")
	original := []byte("corrupt sqlite fixture; preserve byte-for-byte")
	writeFixture(t, historyPath, original)

	ctx, cancel := context.WithCancel(context.Background())
	s, err := NewServer(ctx, Bootstrap{
		Secret: strings.Repeat("a", 64), Token: strings.Repeat("b", 64),
		Instance: "history-unavailable", Static: filepath.Join(base, "static"),
		Config: config, Desktop: base, Language: "zh-CN",
	})
	if err != nil {
		t.Fatalf("gallery server should start without optional history: %v", err)
	}
	s.origin = "http://127.0.0.1:19124"
	s.cookie = "giv_19124"
	t.Cleanup(func() { cancel(); s.close() })

	if s.taskHistory != nil || s.historyErr == "" {
		t.Fatal("expected degraded history state")
	}
	history, _ := call(t, s, "GET", "/api/download/history", nil, false)
	if history.Code != http.StatusServiceUnavailable {
		t.Fatalf("history endpoint: %d %s", history.Code, history.Body.String())
	}
	if _, err := s.reserveDownload(Obj{}); err == nil {
		t.Fatal("download did not fail closed")
	} else {
		var apiErr *APIError
		if !errors.As(err, &apiErr) || apiErr.Code != "history_unavailable" {
			t.Fatalf("unexpected download error: %v", err)
		}
	}
	rootResponse, _ := call(t, s, "GET", "/api/root", nil, false)
	if rootResponse.Code != http.StatusOK {
		t.Fatalf("gallery API unavailable: %d", rootResponse.Code)
	}
	after, err := os.ReadFile(historyPath)
	if err != nil || !bytes.Equal(after, original) {
		t.Fatalf("corrupt database was changed: %v", err)
	}
}

func TestDownloadHistoryHTTPAuthAndRootScope(t *testing.T) {
	s, root := fixture(t)
	if err := s.taskHistory.Start("history-http-fixture", 77, root); err != nil {
		t.Fatal(err)
	}
	if err := s.taskHistory.Finish("history-http-fixture", Obj{
		"ok": true, "stopped": false, "published": true,
		"counts":   Obj{"total": 1, "attempted": 1, "succeeded": 1, "failed": 0, "skipped": 0},
		"failures": []any{},
	}); err != nil {
		t.Fatal(err)
	}

	unauthenticated := httptest.NewRequest("GET", s.origin+"/api/download/history", nil)
	unauthenticated.Header.Set("Origin", s.origin)
	denied := httptest.NewRecorder()
	s.ServeHTTP(denied, unauthenticated)
	if denied.Code != http.StatusForbidden {
		t.Fatalf("unauthenticated history request: %d", denied.Code)
	}

	response, payload := call(t, s, "GET", "/api/download/history", nil, false)
	if response.Code != http.StatusOK || !yes(payload["ok"]) || str(payload["root"]) != root {
		t.Fatalf("history response: %d %#v", response.Code, payload)
	}
	items := arr(payload["items"])
	if len(items) != 1 {
		t.Fatalf("unexpected history rows: %#v", payload)
	}
	row := obj(items[0])
	if str(row["id"]) != "history-http-fixture" || str(row["phase"]) != "succeeded" ||
		!yes(row["published"]) || num(obj(row["counts"])["succeeded"]) != 1 {
		t.Fatalf("unexpected history item: %#v", row)
	}
}
