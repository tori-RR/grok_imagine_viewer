package main

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
)

var defaultShortcuts = Obj{"previousItem": "ArrowUp", "nextItem": "ArrowDown", "previousGroup": "Ctrl+ArrowLeft", "nextGroup": "Ctrl+ArrowRight", "seekBack": "ArrowLeft", "seekForward": "ArrowRight", "seekBackFar": "Shift+ArrowLeft", "seekForwardFar": "Shift+ArrowRight", "previousFrame": "KeyD", "nextFrame": "KeyF", "setA": "BracketLeft", "setB": "BracketRight", "clearAB": "Backslash", "loop": "KeyL", "play": "Space", "mute": "KeyM", "size50": "Ctrl+Digit1", "size100": "Ctrl+Digit2", "size150": "Ctrl+Digit3", "size150Alt": "Ctrl+Digit4", "fullscreen": "Ctrl+KeyF"}
var keyPattern = regexp.MustCompile(`^(Key[A-Z]|Digit[0-9]|F([1-9]|1[0-2])|Arrow(Up|Down|Left|Right)|Space|BracketLeft|BracketRight|Backslash|Comma|Period|Slash|Semicolon|Quote|Minus|Equal|Backquote|Home|End|PageUp|PageDown|Insert|Delete|Backspace|Enter|Numpad[0-9])$`)

func defaultMeta() Obj {
	return Obj{"version": 2, "revision": 0, "tags": []any{"ACG"}, "items": Obj{}, "groups": Obj{}, "grokUserId": ""}
}
func loadMeta(root string) (Obj, error) {
	if root == "" {
		return defaultMeta(), nil
	}
	p, e := jailed(root, ".viewer-meta.json")
	if e != nil {
		return nil, e
	}
	o, e := readJSON(p)
	if e != nil {
		return nil, fail("store_corrupt", "元数据无法读取，已停止写入以保留收藏和标签。", 409)
	}
	if len(o) == 0 {
		return defaultMeta(), nil
	}
	v := num(o["version"])
	if o["version"] == nil {
		v = 1
	}
	if v != 1 && v != 2 {
		return nil, fail("store_corrupt", "元数据版本不受支持，原文件已保留。", 409)
	}
	if v == 2 && (!numeric(o["revision"]) || num(o["revision"]) < 0 || num(o["revision"]) > 1<<53-1) {
		return nil, fail("store_corrupt", "元数据版本号无效。", 409)
	}
	if v == 1 {
		o["revision"] = 0
	}
	o["version"] = 2
	o["tags"] = unique(append([]any{"ACG"}, arr(o["tags"])...))
	for _, k := range []string{"items", "groups"} {
		if o[k] == nil {
			o[k] = Obj{}
		} else if _, ok := o[k].(map[string]any); !ok {
			if _, ok = o[k].(Obj); !ok {
				return nil, fail("store_corrupt", "元数据内容无效。", 409)
			}
		}
	}
	return o, nil
}

// MetadataReadView is display-only. An unreadable document is never replaced
// with these defaults: all mutation and account-binding paths use loadMeta.
type MetadataReadView struct {
	Meta  Obj
	Error string
}

func loadMetaRead(root string) MetadataReadView {
	meta, err := loadMeta(root)
	if err == nil {
		return MetadataReadView{Meta: meta}
	}
	return MetadataReadView{Meta: defaultMeta(), Error: err.Error()}
}

func (view MetadataReadView) decorate(out Obj) {
	out["metaKnown"] = view.Error == ""
	out["metaError"] = view.Error
	if view.Error != "" {
		out["warnings"] = unique(append(arr(out["warnings"]), "metadata_unavailable"))
	}
}
func normalizeFlags(o Obj) Obj {
	r := Obj{"fav": yes(o["fav"]), "dislike": yes(o["dislike"]), "tags": unique(o["tags"])}
	if o["lastViewedId"] != nil {
		r["lastViewedId"] = str(o["lastViewedId"])
	}
	return r
}
func patchFlags(rec, patch Obj) Obj {
	rec = normalizeFlags(rec)
	if v, ok := patch["fav"]; ok {
		rec["fav"] = yes(v)
		if yes(v) {
			rec["dislike"] = false
		}
	}
	if v, ok := patch["dislike"]; ok {
		rec["dislike"] = yes(v)
		if yes(v) {
			rec["fav"] = false
		}
	}
	if v, ok := patch["tags"]; ok {
		rec["tags"] = unique(v)
	}
	return rec
}
func (s *Server) patchMeta(snap Snapshot, p Obj) (Obj, error) {
	if _, ok := p["grokUserId"]; ok {
		return nil, fail("binding_endpoint_required", "账号只能由下载流程绑定。", 400)
	}
	meta, e := loadMeta(snap.Root)
	if e != nil {
		return nil, e
	}
	if !numeric(p["expectedRevision"]) || num(p["expectedRevision"]) != num(meta["revision"]) {
		return nil, &APIError{"meta_conflict", "元数据已被更新，请重试。", 409, Obj{"root": snap.Root, "meta": meta, "actualRevision": meta["revision"]}}
	}
	before := clone(meta)
	if v, ok := p["tags"]; ok {
		meta["tags"] = unique(append([]any{"ACG"}, arr(v)...))
	}
	if tag := strings.TrimSpace(first(str(p["addTag"]), str(p["add_tag"]))); tag != "" {
		meta["tags"] = unique(append(arr(meta["tags"]), tag))
	}
	applyItem := func(patch Obj) error {
		id := str(patch["id"])
		if !safeName(id) {
			return fail("invalid_id", "素材标识无效。", 400)
		}
		items := obj(meta["items"])
		items[id] = patchFlags(obj(items[id]), patch)
		return nil
	}
	applyGroup := func(patch Obj) error {
		section := first(str(patch["section"]), str(p["section"]))
		folder := first(str(patch["folder"]), str(p["folder"]))
		key := first(str(patch["key"]), groupKey(section, folder))
		if key != "_root" {
			parts := strings.Split(key, "/")
			if len(parts) != 2 || !safeName(parts[1]) || parts[0] != "combos" && parts[0] != "_other" && parts[0] != "loose" {
				return fail("invalid_group", "分组标识无效。", 400)
			}
		}
		groups := obj(meta["groups"])
		rec := patchFlags(obj(groups[key]), patch)
		if v, ok := patch["lastViewedId"]; ok {
			last := str(v)
			if last != "" && !safeName(last) {
				return fail("invalid_id", "媒体标识无效。", 400)
			}
			rec["lastViewedId"] = last
		}
		if rec["lastViewedId"] == nil {
			rec["lastViewedId"] = ""
		}
		groups[key] = rec
		return nil
	}
	if it := obj(p["item"]); len(it) > 0 {
		if str(it["id"]) == "" {
			it["id"] = p["id"]
		}
		if e = applyItem(it); e != nil {
			return nil, e
		}
	}
	if gr := obj(p["group"]); len(gr) > 0 {
		if e = applyGroup(gr); e != nil {
			return nil, e
		}
	}
	for _, patch := range rows(p["itemPatches"]) {
		if e = applyItem(patch); e != nil {
			return nil, e
		}
	}
	for _, patch := range rows(p["groupPatches"]) {
		if e = applyGroup(patch); e != nil {
			return nil, e
		}
	}
	if !equalJSON(before, meta) {
		if num(meta["revision"]) >= 1<<53-1 {
			return nil, fail("revision_exhausted", "元数据版本已达上限。", 409)
		}
		meta["revision"] = num(meta["revision"]) + 1
		if e = atomicJSON(filepath.Join(snap.Root, ".viewer-meta.json"), meta); e != nil {
			return nil, e
		}
	}
	return Obj{"ok": true, "root": snap.Root, "meta": meta}, nil
}
func normalizeViews(v any) Obj {
	raw := obj(v)
	if nested, ok := raw["views"]; ok {
		raw = obj(nested)
	}
	out := Obj{}
	for _, k := range []string{"combos", "flat", "other"} {
		r := obj(raw[k])
		density := "compact"
		if str(r["density"]) == "expanded" {
			density = "expanded"
		}
		sm := str(r["sort"])
		if sm != "asc" && sm != "fav" && sm != "count" {
			sm = "desc"
		}
		tile := num(r["tile"])
		if tile > 0 {
			if tile < 96 {
				tile = 96
			}
			if tile > 240 {
				tile = 240
			}
		} else {
			tile = 0
		}
		out[k] = Obj{"density": density, "sort": sm, "tile": tile, "cats": unique(r["cats"])}
	}
	return out
}
func (s *Server) getViews() (Obj, error) {
	snap := s.snapshot()
	if snap.Root == "" {
		return Obj{"ok": true, "views": normalizeViews(nil)}, nil
	}
	p, e := jailed(snap.Root, ".viewer-config.json")
	if e != nil {
		return nil, e
	}
	o, e := readJSON(p)
	if e != nil {
		return nil, e
	}
	return Obj{"ok": true, "root": snap.Root, "views": normalizeViews(o), "configError": ""}, nil
}
func (s *Server) preferencesLocked() Obj {
	return s.preferencesFrom(s.cfg)
}
func (s *Server) preferencesFrom(cfg Obj) Obj {
	return readablePreferences(cfg, s.boot.Desktop)
}
func (s *Server) preferencesResponse() Obj {
	s.cfgMu.Lock()
	defer s.cfgMu.Unlock()
	return Obj{"ok": true, "preferences": s.preferencesLocked(), "systemLanguage": s.boot.Language}
}
func normalizeChord(raw string) (string, error) {
	if len(raw) > 120 {
		return "", fmt.Errorf("快捷键过长")
	}
	seen := map[string]bool{}
	keys := []string{}
	for _, k := range strings.Split(raw, "+") {
		if seen[k] {
			return "", fmt.Errorf("快捷键重复")
		}
		seen[k] = true
		if k == "Meta" {
			return "", fmt.Errorf("系统保留组合不可用")
		}
		if k != "Ctrl" && k != "Alt" && k != "Shift" {
			if !keyPattern.MatchString(k) {
				return "", fmt.Errorf("快捷键无效")
			}
			keys = append(keys, k)
		}
	}
	if len(keys) < 1 || len(keys) > 3 {
		return "", fmt.Errorf("快捷键无效")
	}
	sort.Strings(keys)
	all := []string{}
	for _, m := range []string{"Ctrl", "Alt", "Shift"} {
		if seen[m] {
			all = append(all, m)
		}
	}
	all = append(all, keys...)
	v := strings.Join(all, "+")
	for _, reserved := range []string{"Alt+F4", "Ctrl+KeyW", "Ctrl+KeyR", "Ctrl+KeyT", "Ctrl+KeyN", "Ctrl+KeyL", "Ctrl+KeyQ", "Ctrl+Shift+KeyW", "Ctrl+Shift+KeyR", "Ctrl+Alt+Delete"} {
		if v == reserved {
			return "", fmt.Errorf("系统保留组合不可用")
		}
	}
	return v, nil
}
func (s *Server) savePreferences(p Obj) (Obj, error) {
	return s.updateAppConfig(func(next Obj) (Obj, error) {
		raw := obj(next["preferences"])
		if raw["version"] != nil && num(raw["version"]) != 1 {
			return nil, fail("future_preferences", "设置版本无法识别，已停止写入。", 409)
		}
		prefs := s.preferencesFrom(next)
		for k, v := range p {
			switch k {
			case "language":
				if str(v) != "auto" && str(v) != "zh-CN" && str(v) != "en" {
					return nil, fail("invalid_preferences", "界面语言无效。", 400)
				}
			case "saveDirectory":
				path, e := canonical(str(v))
				if e != nil {
					return nil, fail("invalid_preferences", "请选一个存在的另存为目录。", 400)
				}
				v = path
			case "audioOutputId":
				if _, ok := v.(string); !ok || len(str(v)) > 512 || strings.ContainsRune(str(v), 0) {
					return nil, fail("invalid_preferences", "音频设备无效。", 400)
				}
			case "wheelVolumeStep":
				if !numeric(v) || num(v) < 1 || num(v) > 20 {
					return nil, fail("invalid_preferences", "音量步长应为 1–20%。", 400)
				}
			case "sidebarCollapsed":
				if _, ok := v.(bool); !ok {
					return nil, fail("invalid_preferences", "侧栏设置无效。", 400)
				}
			case "shortcuts":
				keys := clone(obj(prefs["shortcuts"]))
				for name, chord := range obj(v) {
					if defaultShortcuts[name] == nil {
						return nil, fail("invalid_preferences", "快捷键操作无效。", 400)
					}
					value, e := normalizeChord(str(chord))
					if e != nil {
						return nil, fail("invalid_preferences", e.Error(), 400)
					}
					keys[name] = value
				}
				seen := map[string]bool{}
				for _, v := range keys {
					if seen[str(v)] {
						return nil, fail("invalid_preferences", "快捷键与另一项操作重复。", 400)
					}
					seen[str(v)] = true
				}
				if shortcutPrefix(keys) {
					return nil, fail("invalid_preferences", "快捷键是另一组合的子集。", 400)
				}
				v = keys
			default:
				return nil, fail("invalid_preferences", "设置字段无效。", 400)
			}
			prefs[k] = v
		}
		merged := clone(raw)
		for k, v := range prefs {
			if k == "shortcuts" {
				shortcuts := clone(obj(raw[k]))
				for name, chord := range obj(v) {
					shortcuts[name] = chord
				}
				merged[k] = shortcuts
			} else {
				merged[k] = v
			}
		}
		next["preferences"] = merged
		return Obj{"ok": true, "preferences": prefs}, nil
	})
}
func shortcutPrefix(keys Obj) bool {
	xs := []map[string]bool{}
	for _, v := range keys {
		m := map[string]bool{}
		for _, k := range strings.Split(str(v), "+") {
			m[k] = true
		}
		xs = append(xs, m)
	}
	for i, a := range xs {
		for j, b := range xs {
			if i == j || len(a) >= len(b) || a["Ctrl"] != b["Ctrl"] || a["Alt"] != b["Alt"] || a["Shift"] != b["Shift"] {
				continue
			}
			subset := true
			for k := range a {
				if !b[k] {
					subset = false
				}
			}
			if subset {
				return true
			}
		}
	}
	return false
}
func volume(v any) Obj {
	o := obj(v)
	level := int64(100)
	if o["level"] != nil {
		level = num(o["level"])
	}
	if level < 0 {
		level = 0
	}
	if level > 100 {
		level = 100
	}
	return Obj{"level": level, "muted": yes(o["muted"])}
}
func (s *Server) saveVolume(p Obj) (Obj, error) {
	v := volume(p)
	return s.updateAppConfig(func(next Obj) (Obj, error) {
		merged := clone(obj(next["volume"]))
		for key, value := range v {
			merged[key] = value
		}
		next["volume"] = merged
		return Obj{"ok": true, "volume": v}, nil
	})
}
func (s *Server) configPatch(p Obj) error {
	_, err := s.updateAppConfig(func(next Obj) (Obj, error) {
		for k, v := range p {
			next[k] = v
		}
		return nil, nil
	})
	return err
}
func (s *Server) rememberRoot(root string) error {
	_, err := s.updateAppConfig(func(next Obj) (Obj, error) {
		history := []any{root}
		for _, v := range arr(next["history"]) {
			if str(v) != "" && str(v) != root && len(history) < 12 {
				history = append(history, v)
			}
		}
		next["history"] = history
		next["root"] = root
		return nil, nil
	})
	return err
}
func (s *Server) history() []any {
	s.cfgMu.Lock()
	history := append([]any{}, arr(s.cfg["history"])...)
	s.cfgMu.Unlock()
	out := []any{}
	for _, v := range history {
		p := str(v)
		out = append(out, Obj{"path": p, "name": filepath.Base(p), "exists": isDir(p), "markers": []any{}})
	}
	return out
}
func (s *Server) editHistory(p Obj, all bool) (Obj, error) {
	_, e := s.updateAppConfig(func(next Obj) (Obj, error) {
		hs := []any{}
		for _, v := range arr(next["history"]) {
			if !all && str(v) != str(p["path"]) {
				hs = append(hs, v)
			}
		}
		next["history"] = hs
		if all || str(next["root"]) == str(p["path"]) {
			next["root"] = ""
		}
		return nil, nil
	})
	if e != nil {
		return nil, e
	}
	return Obj{"ok": true, "history": s.history()}, nil
}
func (s *Server) config(minimal bool) (Obj, error) {
	snap := s.snapshot()
	o := Obj{"app": "grok_imagine_viewer", "backend": "go", "staticDir": s.boot.Static, "configPath": s.boot.Config, "root": snap.Root, "downloadBindOnly": true}
	if minimal {
		return o, nil
	}
	s.cfgMu.Lock()
	cfg := clone(s.cfg)
	s.cfgMu.Unlock()
	o["lastRoot"] = str(cfg["root"])
	o["history"] = s.history()
	o["defaultRoot"] = ""
	o["exists"] = snap.Root != "" && isDir(snap.Root)
	o["ok"] = snap.Root != ""
	o["volume"] = volume(cfg["volume"])
	o["accel"] = s.cover.Status()
	return o, nil
}
func (s *Server) saveCopy(snap Snapshot, p Obj) (Obj, error) {
	id := str(p["id"])
	if !safeName(id) {
		return nil, fail("invalid_id", "媒体标识无效。", 400)
	}
	_, items, e := s.readGroup(snap, str(p["section"]), str(p["folder"]))
	if e != nil {
		return nil, e
	}
	var item Obj
	for _, it := range items {
		if str(it["id"]) == id {
			item = it
			break
		}
	}
	if item == nil || s.hidden(snap, item, str(p["section"]), str(p["folder"])) {
		return nil, fail("missing_media", "媒体不存在或已进入回收站。", 404)
	}
	file := str(item["file"])
	if strings.TrimSuffix(file, filepath.Ext(file)) != id {
		return nil, fail("identity_mismatch", "媒体身份不一致。", 409)
	}
	src, e := s.resolve(snap, str(p["section"]), str(p["folder"]), file)
	if e != nil {
		return nil, e
	}
	s.cfgMu.Lock()
	dest := str(s.preferencesLocked()["saveDirectory"])
	s.cfgMu.Unlock()
	dir, e := canonical(dest)
	if e != nil {
		return nil, e
	}
	if contained(snap.Root, dir) {
		return nil, fail("invalid_destination", "另存为目录不能位于图库内。", 409)
	}
	before, e := os.Stat(dir)
	if e != nil {
		return nil, e
	}
	part := filepath.Join(dir, ".giv-save-"+token()+".part")
	if e = copyFileChecked(src, part); e != nil {
		return nil, e
	}
	defer os.Remove(part)
	now, e := os.Stat(dir)
	if e != nil || !os.SameFile(before, now) {
		return nil, fail("directory_changed", "另存为目录已变化。", 409)
	}
	stem := strings.TrimSuffix(file, filepath.Ext(file))
	for i := 0; i < 1000; i++ {
		name := file
		if i > 0 {
			name = fmt.Sprintf("%s (%d)%s", stem, i, filepath.Ext(file))
		}
		target := filepath.Join(dir, name)
		if exists(target) {
			continue
		}
		if e = publishNoReplace(part, target); e == nil {
			fi, _ := os.Stat(target)
			return Obj{"ok": true, "root": snap.Root, "path": target, "name": name, "bytes": fi.Size()}, nil
		}
		if exists(target) && exists(part) {
			continue
		}
		return nil, e
	}
	return nil, fail("name_conflict", "同名文件过多，未覆盖任何文件。", 409)
}
func (s *Server) reveal(p Obj) (Obj, error) {
	snap := s.snapshot()
	if str(p["expectedRoot"]) != "" && !sameRoot(str(p["expectedRoot"]), snap.Root) {
		return nil, changed()
	}
	file := str(p["file"])
	if file == "" {
		_, items, e := s.readGroup(snap, str(p["section"]), str(p["folder"]))
		if e != nil {
			return nil, e
		}
		for _, it := range items {
			if str(it["id"]) == str(p["id"]) {
				file = str(it["file"])
				break
			}
		}
	}
	target, e := s.resolve(snap, str(p["section"]), str(p["folder"]), file)
	if e != nil {
		return nil, e
	}
	if _, e = regular(target); e != nil {
		return nil, e
	}
	emitNative(Obj{"type": "reveal", "path": target})
	return Obj{"ok": true}, nil
}
func (s *Server) savePlayback(p Obj) (Obj, error) {
	m := str(p["mode"])
	if m != "auto" && m != "gpu" && m != "cpu" && m != "compat" {
		return nil, fail("invalid_mode", "播放策略无效。", 400)
	}
	e := s.configPatch(Obj{"playbackMode": m})
	return Obj{"ok": e == nil, "requested": m}, e
}
