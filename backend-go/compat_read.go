package main

import (
	"path/filepath"
	"strings"
	"unicode/utf8"
)

// The existing index format has no declared version field. Only `other` is an
// optional legacy collection; an explicit null/wrong type is not a missing key.
// Normalize the in-memory read view without changing the caller or disk file.
func readableIndex(index Obj) (Obj, error) {
	if _, ok := index["combos"].([]any); !ok {
		return nil, fail("bad_index", "索引组合列表无效。", 409)
	}
	view := clone(index)
	if other, present := index["other"]; present {
		if _, ok := other.([]any); !ok {
			return nil, fail("bad_index", "索引其它列表无效。", 409)
		}
	} else {
		view["other"] = []any{}
	}
	return view, nil
}

// Match the preserved preference reader: invalid known fields fall back one at
// a time, while valid custom values and unknown stored data are never rewritten
// by a GET. Writers still validate the original document through ConfigStore.
func readablePreferences(cfg Obj, desktop string) Obj {
	view := Obj{"version": 1, "language": "auto", "saveDirectory": desktop, "audioOutputId": "", "wheelVolumeStep": 5, "sidebarCollapsed": false, "shortcuts": clone(defaultShortcuts)}
	raw := obj(cfg["preferences"])
	if language, ok := raw["language"].(string); ok && (language == "auto" || language == "zh-CN" || language == "en") {
		view["language"] = language
	}
	if directory, ok := raw["saveDirectory"].(string); ok && filepath.IsAbs(directory) {
		view["saveDirectory"] = directory
	}
	if output, ok := raw["audioOutputId"].(string); ok && utf8.RuneCountInString(output) <= 512 {
		view["audioOutputId"] = output
	}
	// JSON uses Number with an integral spelling; a float is not an old valid
	// integer preference (even when its mathematical value happens to be whole).
	if _, floating := raw["wheelVolumeStep"].(float64); !floating && numeric(raw["wheelVolumeStep"]) && num(raw["wheelVolumeStep"]) >= 1 && num(raw["wheelVolumeStep"]) <= 20 {
		view["wheelVolumeStep"] = num(raw["wheelVolumeStep"])
	}
	if collapsed, ok := raw["sidebarCollapsed"].(bool); ok {
		view["sidebarCollapsed"] = collapsed
	}
	keys := obj(raw["shortcuts"])
	bindings := obj(view["shortcuts"])
	for action := range defaultShortcuts {
		if chord, ok := keys[action].(string); ok {
			if normalized, err := normalizeChord(chord); err == nil {
				bindings[action] = normalized
			}
		}
	}
	legacy := true
	for _, action := range []string{"seekBack", "seekForward", "seekBackFar", "seekForwardFar", "previousFrame", "nextFrame"} {
		if _, present := keys[action]; present {
			legacy = false
			break
		}
	}
	if legacy {
		if str(bindings["previousGroup"]) == "ArrowLeft" && str(bindings["seekBack"]) == "ArrowLeft" {
			bindings["previousGroup"] = "Ctrl+ArrowLeft"
		}
		if str(bindings["nextGroup"]) == "ArrowRight" && str(bindings["seekForward"]) == "ArrowRight" {
			bindings["nextGroup"] = "Ctrl+ArrowRight"
		}
	}
	return view
}

// Accept the single pair commonly included by Windows "Copy as path". Do not
// unescape, expand variables, strip nested quotes, or infer a parent directory.
func copiedDirectoryInput(path string) string {
	path = strings.TrimSpace(path)
	if len(path) > 2 && path[0] == '"' && path[len(path)-1] == '"' {
		return path[1 : len(path)-1]
	}
	return path
}
