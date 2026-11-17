package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestCompatIndexMissingOtherRemainsReadOnly(t *testing.T) {
	s, root := fixture(t)
	path := filepath.Join(root, "_index.json")
	index, err := readJSON(path)
	if err != nil {
		t.Fatal(err)
	}
	delete(index, "other")
	index["externalOnly"] = Obj{"keep": "unchanged"}
	jsonFixture(t, path, index)
	before, _ := os.ReadFile(path)
	w, out := call(t, s, http.MethodPut, "/api/root", Obj{"root": root}, false)
	if w.Code != 200 || !yes(out["ok"]) || str(obj(out["library"])["mode"]) != "index" {
		t.Fatalf("legacy optional other rejected: %d %#v", w.Code, out)
	}
	lib := obj(out["library"])
	if len(rows(lib["combos"])) != 1 || len(arr(lib["other"])) != 0 {
		t.Fatal(lib)
	}
	combo, err := s.combo(s.snapshot(), "combos", "0001_aaaaaaaa")
	if err != nil || len(rows(combo["items"])) != 2 {
		t.Fatal(combo, err)
	}
	after, _ := os.ReadFile(path)
	if !bytes.Equal(before, after) {
		t.Fatal("read compatibility rewrote the index")
	}
}

func TestCompatIndexRejectsExplicitInvalidCollections(t *testing.T) {
	for _, value := range []any{nil, "wrong", 4, true, Obj{}} {
		for _, field := range []string{"combos", "other"} {
			t.Run(field+"-"+string(mustJSON(value)), func(t *testing.T) {
				_, root := fixture(t)
				path := filepath.Join(root, "_index.json")
				index := Obj{"combos": []any{}, "other": []any{}, "summary": Obj{}}
				index[field] = value
				jsonFixture(t, path, index)
				before, _ := os.ReadFile(path)
				if _, err := detect(root); err == nil {
					t.Fatal("invalid collection accepted")
				}
				after, _ := os.ReadFile(path)
				if !bytes.Equal(before, after) {
					t.Fatal("invalid index changed")
				}
			})
		}
	}
	for _, raw := range []string{"{}", "{broken"} {
		_, root := fixture(t)
		path := filepath.Join(root, "_index.json")
		writeFixture(t, path, []byte(raw))
		if _, err := detect(root); err == nil {
			t.Fatal("missing required combos or corrupt index accepted")
		}
		if contents, _ := os.ReadFile(path); string(contents) != raw {
			t.Fatal("bad index rewritten")
		}
	}
}

func TestCompatIndexEmptyAndMissingAreDistinct(t *testing.T) {
	root := t.TempDir()
	if err := os.Mkdir(filepath.Join(root, "combos"), 0700); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(root, "_index.json")
	jsonFixture(t, path, Obj{"combos": []any{}, "summary": Obj{}})
	lib, err := detect(root)
	if err != nil || str(lib["mode"]) != "index" {
		t.Fatal(lib, err)
	}
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	lib, err = detect(root)
	if err != nil || str(lib["mode"]) != "combos" {
		t.Fatal(lib, err)
	}
}

func TestCompatPreferencesReadNormalizesWithoutWriting(t *testing.T) {
	cases := []struct {
		name                 string
		raw                  Obj
		previous, next, seek string
	}{
		{"defaults", Obj{}, "Ctrl+ArrowLeft", "Ctrl+ArrowRight", "ArrowLeft"},
		{"legacy", Obj{"shortcuts": Obj{"previousGroup": "ArrowLeft", "nextGroup": "ArrowRight"}}, "Ctrl+ArrowLeft", "Ctrl+ArrowRight", "ArrowLeft"},
		{"modern-custom", Obj{"shortcuts": Obj{"previousGroup": "ArrowLeft", "nextGroup": "ArrowRight", "seekBack": "KeyB"}}, "ArrowLeft", "ArrowRight", "KeyB"},
		{"legacy-custom", Obj{"shortcuts": Obj{"previousGroup": "Alt+KeyP", "nextGroup": "Shift+Ctrl+KeyY"}}, "Alt+KeyP", "Ctrl+Shift+KeyY", "ArrowLeft"},
		{"bad-fields", Obj{"shortcuts": Obj{"previousGroup": "Ctrl+Ctrl+KeyA", "nextGroup": 5, "seekBack": "Meta+KeyJ", "futureAction": "Alt+F4"}}, "Ctrl+ArrowLeft", "Ctrl+ArrowRight", "ArrowLeft"},
		{"reserved-and-wrong-container", Obj{"shortcuts": []any{"Alt+F4"}}, "Ctrl+ArrowLeft", "Ctrl+ArrowRight", "ArrowLeft"},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			s, _ := fixture(t)
			s.cfgMu.Lock()
			s.cfg["preferences"] = test.raw
			jsonFixture(t, s.boot.Config, s.cfg)
			s.cfgMu.Unlock()
			before, _ := os.ReadFile(s.boot.Config)
			w, out := call(t, s, http.MethodGet, "/api/preferences", nil, false)
			if w.Code != 200 {
				t.Fatal(w.Code, out)
			}
			keys := obj(obj(out["preferences"])["shortcuts"])
			if str(keys["previousGroup"]) != test.previous || str(keys["nextGroup"]) != test.next || str(keys["seekBack"]) != test.seek {
				t.Fatal(keys)
			}
			if _, exposed := keys["futureAction"]; exposed {
				t.Fatal("unknown action exposed")
			}
			after, _ := os.ReadFile(s.boot.Config)
			if !bytes.Equal(before, after) {
				t.Fatal("preferences GET rewrote old configuration")
			}
		})
	}
}

func TestCompatPreferenceFieldsPreserveValidValues(t *testing.T) {
	s, _ := fixture(t)
	offline := filepath.Join(t.TempDir(), "not-mounted-yet")
	s.cfgMu.Lock()
	s.cfg["preferences"] = Obj{"language": "en", "saveDirectory": offline, "audioOutputId": "设备-输出", "wheelVolumeStep": json.Number("7"), "sidebarCollapsed": true}
	s.cfgMu.Unlock()
	prefs := obj(s.preferencesResponse()["preferences"])
	if str(prefs["language"]) != "en" || str(prefs["saveDirectory"]) != offline || str(prefs["audioOutputId"]) != "设备-输出" || num(prefs["wheelVolumeStep"]) != 7 || !yes(prefs["sidebarCollapsed"]) {
		t.Fatal(prefs)
	}
	s.cfgMu.Lock()
	s.cfg["preferences"] = Obj{"language": "xx", "saveDirectory": "relative", "audioOutputId": strings.Repeat("x", 513), "wheelVolumeStep": json.Number("3.0"), "sidebarCollapsed": 1}
	s.cfgMu.Unlock()
	prefs = obj(s.preferencesResponse()["preferences"])
	if str(prefs["language"]) != "auto" || str(prefs["saveDirectory"]) != s.boot.Desktop || str(prefs["audioOutputId"]) != "" || num(prefs["wheelVolumeStep"]) != 5 || yes(prefs["sidebarCollapsed"]) {
		t.Fatal(prefs)
	}
}

func TestCompatExplicitModernShortcutConflictIsNotSilentlyReset(t *testing.T) {
	s, _ := fixture(t)
	s.cfgMu.Lock()
	s.cfg["preferences"] = Obj{"shortcuts": Obj{"previousGroup": "ArrowLeft", "seekBack": "ArrowLeft"}}
	jsonFixture(t, s.boot.Config, s.cfg)
	s.cfgMu.Unlock()
	before, _ := os.ReadFile(s.boot.Config)
	keys := obj(obj(s.preferencesResponse()["preferences"])["shortcuts"])
	if str(keys["previousGroup"]) != "ArrowLeft" || str(keys["seekBack"]) != "ArrowLeft" {
		t.Fatal("explicit custom bindings reset", keys)
	}
	w, _ := call(t, s, http.MethodPut, "/api/preferences", Obj{"shortcuts": Obj{"previousGroup": "ArrowLeft"}}, false)
	if w.Code != 400 {
		t.Fatal("explicit conflict bypassed write validation", w.Code)
	}
	after, _ := os.ReadFile(s.boot.Config)
	if !bytes.Equal(before, after) {
		t.Fatal("rejected shortcut write changed disk")
	}
}

func TestCompatAnyModernSeekKeyPreventsLegacyMigration(t *testing.T) {
	for _, action := range []string{"seekBack", "seekForward", "seekBackFar", "seekForwardFar", "previousFrame", "nextFrame"} {
		t.Run(action, func(t *testing.T) {
			raw := Obj{"preferences": Obj{"shortcuts": Obj{"previousGroup": "ArrowLeft", "nextGroup": "ArrowRight", action: defaultShortcuts[action], "futureAction": "KeyZ"}}}
			before := mustJSON(raw)
			keys := obj(readablePreferences(raw, t.TempDir())["shortcuts"])
			if str(keys["previousGroup"]) != "ArrowLeft" || str(keys["nextGroup"]) != "ArrowRight" {
				t.Fatal("modern intent was mistaken for historical defaults", keys)
			}
			if !bytes.Equal(before, mustJSON(raw)) {
				t.Fatal("normalization changed caller data")
			}
		})
	}
}

func TestCompatCopiedPathsDoNotExpandOrInfer(t *testing.T) {
	for _, path := range []string{`C:\图库 with spaces\folder`, `Z:\映射盘\folder`, `\\offline-server\share\图库`, `$HOME`, `%TEMP%`} {
		if got := copiedDirectoryInput(`"` + path + `"`); got != path {
			t.Fatal("literal path changed", path, got)
		}
		if got := copiedDirectoryInput(`""` + path + `""`); got != `"`+path+`"` {
			t.Fatal("more than one pair stripped", got)
		}
	}
	if copiedDirectoryInput(`""`) == "" {
		t.Fatal("invalid quoted empty path became the computer view")
	}
}

func TestCompatBrowseOuterQuotesAndLiteralPaths(t *testing.T) {
	s, root := fixture(t)
	path := filepath.Join(t.TempDir(), "图库 with spaces $(literal) & %name%")
	if err := os.Mkdir(path, 0700); err != nil {
		t.Fatal(err)
	}
	before := s.snapshot()
	for _, input := range []string{path, `"` + path + `"`, " \t\"" + path + "\"\r\n"} {
		w, out := call(t, s, http.MethodGet, "/api/browse?path="+url.QueryEscape(input), nil, false)
		if w.Code != 200 || !yes(out["selectable"]) || !sameRoot(str(out["path"]), path) {
			t.Fatalf("quoted directory rejected: %d %#v", w.Code, out)
		}
		if s.snapshot() != before {
			t.Fatal("browse selected a gallery")
		}
	}
	for _, input := range []string{`"` + path, path + `"`, `""` + path + `""`, `"relative"`, `"` + filepath.Join(path, "missing-child") + `"`, `"$HOME"`, `"%TEMP%"`} {
		w, out := call(t, s, http.MethodGet, "/api/browse?path="+url.QueryEscape(input), nil, false)
		if w.Code != 400 || yes(out["selectable"]) {
			t.Fatal("invalid browse fell back", input, w.Code, out)
		}
	}
	if !sameRoot(s.snapshot().Root, root) {
		t.Fatal("invalid browse switched active root")
	}
}
