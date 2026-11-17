package main

import (
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"sync"
	"time"
)

var mediaMimes = map[string]string{".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp", ".gif": "image/gif", ".mp4": "video/mp4", ".webm": "video/webm"}

func mimeFor(file string) string { return mediaMimes[strings.ToLower(filepath.Ext(file))] }
func mediaKind(item Obj) string {
	m := str(item["mime"])
	if m == "" {
		m = mimeFor(str(item["file"]))
	}
	if strings.HasPrefix(m, "video/") {
		return "video"
	}
	if strings.HasPrefix(m, "image/") {
		return "image"
	}
	return ""
}
func groupKey(section, folder string) string {
	if section == "_root" {
		return section
	}
	return section + "/" + folder
}
func parseTime(v any) time.Time {
	s := str(v)
	for _, layout := range []string{time.RFC3339Nano, "2006-01-02T15:04:05.999999999", "2006-01-02 15:04:05.999999999", "2006-01-02"} {
		if t, e := time.Parse(layout, s); e == nil {
			return t
		}
	}
	return time.Time{}
}
func groupRel(snap Snapshot, section, folder string) (string, error) {
	if section == "" {
		section = "combos"
	}
	switch snap.Mode {
	case "single":
		if section == "_root" || section == "combos" {
			return "", nil
		}
	case "loose":
		if (section == "loose" || section == "combos") && safeName(folder) {
			return folder, nil
		}
	case "index", "combos":
		if (section == "combos" || section == "_other") && safeName(folder) {
			return filepath.Join(section, folder), nil
		}
	}
	return "", fail("invalid_group", "分组路径无效。", 400)
}
func mediaURL(section, folder, file string) string {
	if section == "_root" {
		return "/media/_root/" + url.PathEscape(file)
	}
	return "/media/" + url.PathEscape(section) + "/" + url.PathEscape(folder) + "/" + url.PathEscape(file)
}
func blankLibrary(root, mode, message string) Obj {
	return Obj{"ok": false, "root": root, "mode": mode, "error": message, "combos": []any{}, "other": []any{}, "hasOther": false, "hasTrash": false, "tags": []any{"ACG"}, "live": false, "metaError": "", "summary": Obj{}}
}
func detect(root string) (Obj, error) {
	if root == "" {
		return blankLibrary("", "empty", "尚未选择图库根目录。"), nil
	}
	real, e := canonical(root)
	if e != nil {
		return nil, fail("directory_unavailable", "目录不存在或不可访问。", 404)
	}
	root = real
	// Selecting the combos directory of an indexed export means its parent.
	if filepath.Base(root) == "combos" {
		if p, e := jailed(filepath.Dir(root), "_index.json"); e == nil {
			if _, e = regular(p); e == nil {
				root = filepath.Dir(root)
			}
		}
	}
	idxPath, e := jailed(root, "_index.json")
	if e != nil {
		return nil, e
	}
	index, e := readJSON(idxPath)
	if e != nil {
		return nil, fail("bad_index", "_index.json 无法读取，未覆盖原索引。", 409)
	}
	lib := Obj{"ok": true, "root": root, "error": nil, "combos": []any{}, "other": []any{}, "summary": Obj{}, "hasOther": false}
	if len(index) > 0 || exists(idxPath) {
		index, e = readableIndex(index)
		if e != nil {
			return nil, e
		}
		lib["mode"] = "index"
		lib["combos"] = index["combos"]
		lib["other"] = index["other"]
		lib["summary"] = obj(index["summary"])
	} else if p, e := jailed(root, "combos"); e == nil && isDir(p) {
		lib["mode"] = "combos"
	} else if p, e := jailed(root, "card.json"); e == nil && exists(p) {
		card, e := readJSON(p)
		if e != nil {
			card = Obj{"_cardReadError": "card_corrupt"}
		}
		lib["mode"] = "single"
		row := discoverySummary(card, filepath.Base(root))
		row["section"] = "_root"
		lib["combos"] = []any{row}
	} else {
		lib["mode"] = "loose"
	}
	mode := str(lib["mode"])
	if mode == "index" || mode == "combos" {
		for _, sec := range []string{"combos", "_other"} {
			key := "combos"
			if sec == "_other" {
				key = "other"
			}
			existing := rows(lib[key])
			seen := map[string]bool{}
			clean := []any{}
			for _, row := range existing {
				folder := str(row["folder"])
				if safeName(folder) && !seen[folder] {
					row = clone(row)
					row["section"] = sec
					clean = append(clean, row)
					seen[folder] = true
				}
			}
			parent, e := jailed(root, sec)
			if e != nil {
				return nil, e
			}
			entries, err := os.ReadDir(parent)
			if err != nil && !os.IsNotExist(err) {
				return nil, err
			}
			for _, de := range entries {
				if !de.IsDir() || !safeName(de.Name()) || seen[de.Name()] {
					continue
				}
				p, e := jailed(root, filepath.Join(sec, de.Name()))
				if e != nil {
					continue
				}
				card, e := readJSON(filepath.Join(p, "card.json"))
				if e != nil {
					if !hasMedia(p) {
						continue
					}
					card = Obj{"_cardReadError": "card_corrupt"}
				}
				if len(card) == 0 && !hasMedia(p) {
					continue
				}
				r := discoverySummary(card, de.Name())
				r["section"] = sec
				if mode == "index" {
					r["source"] = "disk_leftover"
				}
				clean = append(clean, r)
			}
			lib[key] = clean
		}
	} else if mode == "loose" {
		entries, e := os.ReadDir(root)
		if e != nil {
			return nil, e
		}
		out := []any{}
		for _, de := range entries {
			if !de.IsDir() || strings.HasPrefix(de.Name(), ".") || strings.HasPrefix(de.Name(), "_") {
				continue
			}
			p, e := jailed(root, de.Name())
			if e != nil {
				continue
			}
			card, e := readJSON(filepath.Join(p, "card.json"))
			if e != nil {
				if !hasMedia(p) {
					continue
				}
				card = Obj{"_cardReadError": "card_corrupt"}
			}
			if len(card) == 0 && !hasMedia(p) {
				continue
			}
			r := discoverySummary(card, de.Name())
			r["section"] = "loose"
			out = append(out, r)
		}
		lib["combos"] = out
		if len(out) == 0 {
			return blankLibrary(root, "unrecognized", "无法识别图库：未找到索引或组合。"), nil
		}
	}
	lib["hasOther"] = len(arr(lib["other"])) > 0 || isDir(filepath.Join(root, "_other"))
	return lib, nil
}
func exists(p string) bool { _, e := os.Lstat(p); return e == nil }
func isDir(p string) bool {
	f, e := os.Lstat(p)
	return e == nil && f.IsDir() && !reparse(f) && f.Mode()&os.ModeSymlink == 0
}
func hasMedia(p string) bool {
	ds, e := os.ReadDir(p)
	if e != nil {
		return false
	}
	for _, d := range ds {
		if mimeFor(d.Name()) != "" || strings.HasSuffix(d.Name(), ".trashed") {
			return true
		}
	}
	return false
}
func summary(card Obj, folder string) Obj {
	row := Obj{"folder": folder, "id": card["id"], "n": card["n"], "title": str(card["title"]), "created": str(card["created"]), "count": num(card["count"]), "images": 0, "videos": 0, "missing": num(card["missing"]), "source": str(card["source"])}
	items := rows(card["items"])
	if card["count"] == nil {
		row["count"] = len(items)
	}
	for _, it := range items {
		if mediaKind(it) == "video" {
			row["videos"] = num(row["videos"]) + 1
		} else if mediaKind(it) == "image" {
			row["images"] = num(row["images"]) + 1
		}
	}
	for _, k := range []string{"latestItemCreatedAt", "memberIds", "remoteUrl"} {
		if v, ok := card[k]; ok {
			row[k] = v
		}
	}
	return row
}
func (s *Server) selectRoot(path string) (Obj, error) {
	return s.activateRoot(path, true, true)
}

// Startup needs a validated root/mode, not the first page's card and duration
// reads. Keep activation shared with interactive selection, which still returns
// a hydrated library. Restoring a saved location must not rewrite configuration.
func (s *Server) activateRoot(path string, remember, hydrate bool) (Obj, error) {
	request := s.rootRequest.Add(1)
	if s.downloadActive() {
		return nil, fail("library_busy", "下载期间不能切换图库。", 423)
	}
	lib, e := detect(path)
	if e != nil {
		return nil, e
	}
	if !yes(lib["ok"]) {
		return Obj{"ok": true, "root": str(lib["root"]), "library": lib}, nil
	}
	s.gate.Lock()
	defer s.gate.Unlock()
	if request != s.rootRequest.Load() {
		return nil, changed()
	}
	if s.downloadActive() {
		return nil, fail("library_busy", "下载期间不能切换图库。", 423)
	}
	// Persist the selection before publishing it. A refused config update must
	// leave the process on its original gallery and generation.
	if remember {
		if e = s.rememberRoot(str(lib["root"])); e != nil {
			return nil, e
		}
	}
	s.mu.Lock()
	s.root = str(lib["root"])
	s.mode = str(lib["mode"])
	s.generation++
	s.mu.Unlock()
	s.invalidate()
	if hydrate {
		lib, e = s.library(false)
	}
	return Obj{"ok": e == nil, "root": s.snapshot().Root, "library": lib}, e
}
func (s *Server) createLibrary(p Obj) (Obj, error) {
	if s.downloadActive() {
		return nil, fail("library_busy", "请先停止下载。", 423)
	}
	path := str(p["root"])
	if path == "" {
		path = str(p["path"])
	}
	if path == "" {
		parent, e := canonical(str(p["parent"]))
		if e != nil {
			return nil, e
		}
		name := str(p["name"])
		if !safeName(name) {
			return nil, fail("bad_name", "文件夹名称无效。", 400)
		}
		path = filepath.Join(parent, name)
	}
	if !filepath.IsAbs(path) {
		return nil, fail("bad_path", "必须使用绝对目录。", 400)
	}
	parent, e := canonical(filepath.Dir(path))
	if e != nil {
		return nil, e
	}
	path, e = jailed(parent, filepath.Base(path))
	if e != nil {
		return nil, e
	}
	if e = os.Mkdir(path, 0700); e != nil {
		return nil, fail("directory_exists", "新图库目录必须尚不存在。", 409)
	}
	for _, n := range []string{"combos", "_other", "_state"} {
		if e = os.Mkdir(filepath.Join(path, n), 0700); e != nil {
			return nil, e
		}
	}
	if e = atomicJSON(filepath.Join(path, "_index.json"), Obj{"combos": []any{}, "other": []any{}, "summary": Obj{}}); e != nil {
		return nil, e
	}
	out, e := s.selectRoot(path)
	if out != nil {
		out["created"] = true
	}
	return out, e
}
func (s *Server) library(force bool) (Obj, error) {
	snap := s.snapshot()
	if force {
		s.invalidate()
	}
	lib, e := detect(snap.Root)
	if e != nil {
		return nil, e
	}
	if !yes(lib["ok"]) {
		return lib, nil
	}
	view := loadMetaRead(snap.Root)
	meta := view.Meta
	_, trashInvalid, trashErr := s.trashRecords(snap)
	if trashErr != nil {
		return nil, trashVisibilityError("trash_unavailable")
	}
	checked := 0
	readCards := []Obj{}
	for _, field := range []string{"combos", "other"} {
		for _, row := range rows(lib[field]) {
			sec := str(row["section"])
			folder := str(row["folder"])
			if sec == "_root" {
				folder = ""
			}
			attachGroup(row, sec, meta)
			view.decorate(row)
			if checked < 120 {
				result, err := s.combo(snap, sec, folder, view)
				card := obj(result["card"])
				if err != nil {
					var local bool
					card, local = groupErrorCard(sec, folder, err)
					if !local {
						return nil, err
					}
				}
				for k, v := range card {
					row[k] = v
				}
				view.decorate(row)
				readCards = append(readCards, card)
				checked++
			}
		}
	}
	if s.stale(snap) {
		return nil, changed()
	}
	lib["generation"] = snap.Generation
	lib["tags"] = unique(meta["tags"])
	addTrashReadDiagnostics(lib, trashInvalid)
	view.decorate(lib)
	addGroupReadDiagnostics(lib, readCards)
	lib["live"] = checked == len(rows(lib["combos"]))+len(rows(lib["other"]))
	for _, card := range readCards {
		if card["countKnown"] == false {
			lib["live"] = false
		}
	}
	// A leftover control record also keeps recovery discoverable, without
	// scanning media bodies or falsely claiming a damaged record is restorable.
	lib["hasTrash"] = false
	for _, sub := range []string{"by-id", "copies"} {
		dir, err := jailed(snap.Root, filepath.Join(".trash", sub))
		if err != nil {
			return nil, err
		}
		entries, err := os.ReadDir(dir)
		if err != nil && !os.IsNotExist(err) {
			return nil, err
		}
		if len(entries) > 0 {
			lib["hasTrash"] = true
		}
	}
	return lib, nil
}
func groupStamp(dir string) string {
	out := ""
	for _, path := range []string{dir, filepath.Join(dir, "card.json")} {
		if st, e := os.Stat(path); e == nil {
			out += fmt.Sprintf("%d/%d/", st.Size(), st.ModTime().UnixNano())
		}
	}
	return out
}

// One in-flight directory read per snapshot/group. Cache holds raw members;
// metadata and flags are overlaid per response, so tag writes do not rescan NAS.
func (s *Server) readGroup(snap Snapshot, section, folder string) (Obj, []Obj, error) {
	return s.readGroupMode(snap, section, folder, false)
}

func (s *Server) readGroupForDisplay(snap Snapshot, section, folder string) (Obj, []Obj, error) {
	return s.readGroupMode(snap, section, folder, true)
}

func (s *Server) readGroupMode(snap Snapshot, section, folder string, display bool) (Obj, []Obj, error) {
	rel, e := groupRel(snap, section, folder)
	if e != nil {
		return nil, nil, e
	}
	dir, e := jailed(snap.Root, rel)
	if e != nil {
		return nil, nil, e
	}
	key := fmt.Sprintf("%d\n%s\n%s", snap.Generation, snap.Root, rel)
	if display {
		// A synthesized display card must never satisfy a strict mutation read.
		key = "display\n" + key
	}
	stamp := groupStamp(dir)
	for {
		s.cacheMu.Lock()
		if c, ok := s.groups[key]; ok && c.Stamp == stamp && time.Since(c.At) < 2*time.Second {
			s.cacheMu.Unlock()
			return clone(c.Card), cloneRows(c.Items), nil
		}
		if wait := s.groupFlights[key]; wait != nil {
			s.cacheMu.Unlock()
			select {
			case <-wait:
				continue
			case <-s.ctx.Done():
				return nil, nil, s.ctx.Err()
			}
		}
		s.groupFlights[key] = make(chan struct{})
		s.cacheMu.Unlock()
		break
	}
	defer func() { s.cacheMu.Lock(); close(s.groupFlights[key]); delete(s.groupFlights, key); s.cacheMu.Unlock() }()
	entries, e := os.ReadDir(dir)
	if e != nil {
		return nil, nil, e
	}
	names := map[string]bool{}
	for _, de := range entries {
		if de.Type().IsRegular() {
			names[de.Name()] = true
		}
	}
	card, e := readJSON(filepath.Join(dir, "card.json"))
	if e == nil && card["items"] != nil {
		if _, ok := card["items"].([]any); !ok {
			e = errors.New("invalid card members")
		}
	}
	if e != nil {
		if !display {
			return nil, nil, e
		}
		// Only the verified directory's ordinary media is recoverable here.
		// Keep the corrupt document intact and never infer prompts or identity.
		card = Obj{"_cardReadError": "card_corrupt"}
	}
	if len(card) == 0 || str(card["_cardReadError"]) != "" {
		cardError := card["_cardReadError"]
		card = Obj{"id": folder, "folder": folder, "title": "", "created": "", "items": []any{}}
		if cardError != nil {
			card["_cardReadError"] = cardError
		}
	}
	items := []Obj{}
	seen := map[string]bool{}
	for _, raw := range rows(card["items"]) {
		file := str(raw["file"])
		if !safeName(file) || mimeFor(file) == "" {
			continue
		}
		if names[file] {
			it := clone(raw)
			if str(it["id"]) == "" {
				it["id"] = strings.TrimSuffix(file, filepath.Ext(file))
			}
			it["mime"] = first(str(it["mime"]), mimeFor(file))
			it["media"] = mediaKind(it)
			it["prompt"] = str(it["prompt"])
			it["title"] = str(card["title"])
			it["created"] = str(it["created"])
			it["_markerPresent"] = names[file+".trashed"]
			items = append(items, it)
			seen[file] = true
		}
	}
	for _, de := range entries {
		file := de.Name()
		if seen[file] || de.IsDir() || !safeName(file) || mimeFor(file) == "" {
			continue
		}
		p, e := jailed(dir, file)
		if e != nil {
			continue
		}
		if _, e = regular(p); e != nil {
			continue
		}
		items = append(items, Obj{"id": strings.TrimSuffix(file, filepath.Ext(file)), "file": file, "mime": mimeFor(file), "media": mediaKind(Obj{"file": file}), "prompt": "", "created": "", "status": "linked", "kind": nil, "title": str(card["title"]), "_markerPresent": names[file+".trashed"]})
	}
	sort.SliceStable(items, func(i, j int) bool {
		a, b := parseTime(items[i]["created"]), parseTime(items[j]["created"])
		if a.Equal(b) {
			return str(items[i]["file"]) < str(items[j]["file"])
		}
		return a.Before(b)
	})
	if !s.stale(snap) {
		s.cacheMu.Lock()
		if len(s.groups) >= 1024 {
			var oldest string
			var at time.Time
			for k, v := range s.groups {
				if oldest == "" || v.At.Before(at) {
					oldest = k
					at = v.At
				}
			}
			delete(s.groups, oldest)
		}
		s.groups[key] = cachedGroup{stamp, time.Now(), clone(card), cloneRows(items)}
		s.cacheMu.Unlock()
	}
	return card, items, nil
}
func first(xs ...string) string {
	for _, s := range xs {
		if s != "" {
			return s
		}
	}
	return ""
}
func (s *Server) combo(snap Snapshot, section, folder string, metas ...MetadataReadView) (Obj, error) {
	if snap.Root == "" {
		return nil, changed()
	}
	if section == "" {
		section = "combos"
	}
	if snap.Mode == "single" {
		section = "_root"
		folder = ""
	}
	if snap.Mode == "loose" {
		section = "loose"
	}
	card, raw, e := s.readGroupForDisplay(snap, section, folder)
	if e != nil {
		return nil, s.groupReadError(snap, section, folder, e)
	}
	var view MetadataReadView
	if len(metas) > 0 {
		view = metas[0]
	} else {
		view = loadMetaRead(snap.Root)
	}
	meta := view.Meta
	items := []Obj{}
	records, invalid, visibilityErr := s.trashRecords(snap)
	if visibilityErr != nil {
		return nil, trashVisibilityError("trash_unavailable")
	}
	unavailableIDs := []any{}
	for _, it := range raw {
		hidden, visibilityErr := visibilityWithRecords(snap, it, section, folder, records, invalid)
		if visibilityErr != nil {
			unavailableIDs = append(unavailableIDs, it["id"])
			continue
		}
		if hidden {
			continue
		}
		delete(it, "_markerPresent")
		it["section"] = section
		it["folder"] = folder
		it["url"] = mediaURL(section, folder, str(it["file"]))
		flags := obj(obj(meta["items"])[str(it["id"])])
		it["fav"] = yes(flags["fav"])
		it["dislike"] = yes(flags["dislike"])
		it["tags"] = unique(flags["tags"])
		it["metaKnown"] = view.Error == ""
		it["metadataKnown"] = str(card["_cardReadError"]) == ""
		if mediaKind(it) == "video" {
			if d := s.cover.durationValue(snap, section, folder, it); d > 0 {
				it["duration"] = d
			}
		}
		items = append(items, it)
	}
	sum := summary(card, folder)
	sum["section"] = section
	sum["count"] = len(items)
	sum["images"] = 0
	sum["videos"] = 0
	sum["live"] = true
	sum["countKnown"] = true
	sum["state"] = "available"
	sum["unavailable"] = false
	sum["metadataKnown"] = true
	sum["cardError"] = ""
	if cardError := str(card["_cardReadError"]); cardError != "" {
		sum["state"] = "corrupt"
		sum["cardError"] = cardError
		sum["metadataKnown"] = false
		sum["warnings"] = []any{cardError}
	}
	if len(invalid) != 0 {
		sum["warnings"] = unique(append(arr(sum["warnings"]), "trash_records_corrupt"))
		sum["trashIssueCount"] = len(invalid)
	}
	if len(unavailableIDs) != 0 {
		// A blocked ID is not proof of deletion or an exact empty group. The
		// library may keep its cheap last-known count; cards omit exact counts.
		delete(sum, "count")
		sum["countKnown"] = false
		sum["live"] = false
		sum["state"] = "unavailable"
		sum["unavailable"] = true
		sum["unavailableIds"] = unavailableIDs
	}
	members := []any{}
	latest := time.Time{}
	sum["latestItemCreatedAt"] = ""
	for _, it := range items {
		members = append(members, it["id"])
		if mediaKind(it) == "video" {
			sum["videos"] = num(sum["videos"]) + 1
		} else {
			sum["images"] = num(sum["images"]) + 1
		}
		if t := parseTime(it["created"]); t.After(latest) {
			latest = t
			sum["latestItemCreatedAt"] = it["created"]
		}
	}
	sum["memberIds"] = members
	attachGroup(sum, section, meta)
	view.decorate(sum)
	last := str(obj(obj(meta["groups"])[groupKey(section, folder)])["lastViewedId"])
	sum["lastViewedId"] = last
	cover := pickCover(items, last)
	sum["coverId"] = ""
	sum["coverMedia"] = ""
	sum["coverFile"] = ""
	sum["coverUrl"] = ""
	sum["coverReady"] = false
	sum["duration"] = 0
	if cover != nil {
		sum["coverId"] = cover["id"]
		sum["coverMedia"] = cover["media"]
		sum["coverFile"] = cover["file"]
		sum["coverUrl"] = cover["url"]
		sum["coverReady"] = mediaKind(cover) != "video" || s.cover.cached(snap, section, folder, cover) != ""
		if d := cover["duration"]; d != nil {
			sum["duration"] = d
		}
	}
	if s.stale(snap) {
		return nil, changed()
	}
	out := Obj{"ok": true, "root": snap.Root, "generation": snap.Generation, "section": section, "folder": folder, "items": asAny(items), "card": sum, "lastViewedId": last, "coverId": sum["coverId"], "coverMedia": sum["coverMedia"]}
	if len(metas) == 0 {
		addTrashReadDiagnostics(out, invalid)
	}
	view.decorate(out)
	addGroupReadDiagnostics(out, []Obj{sum})
	return out, nil
}
func attachGroup(row Obj, section string, meta Obj) {
	own := obj(obj(meta["groups"])[groupKey(section, str(row["folder"]))])
	inherit := []any{}
	fav := false
	for _, id := range arr(row["memberIds"]) {
		rec := obj(obj(meta["items"])[str(id)])
		fav = fav || yes(rec["fav"])
		inherit = append(inherit, arr(rec["tags"])...)
	}
	inherit = unique(inherit)
	sort.Slice(inherit, func(i, j int) bool { return str(inherit[i]) < str(inherit[j]) })
	row["ownFav"] = yes(own["fav"])
	row["inheritedFav"] = fav
	row["fav"] = yes(own["fav"]) || fav
	row["dislike"] = yes(own["dislike"])
	row["ownTags"] = unique(own["tags"])
	row["inheritedTags"] = inherit
	row["tags"] = unique(append(unique(own["tags"]), inherit...))
}
func pickCover(items []Obj, last string) Obj {
	var image, video Obj
	for _, it := range items {
		if str(it["id"]) == last && last != "" {
			return it
		}
		if mediaKind(it) == "image" {
			image = it
		} else if mediaKind(it) == "video" {
			video = it
		}
	}
	if image != nil {
		return image
	}
	return video
}
func (s *Server) cards(p Obj) (Obj, error) {
	snap := s.snapshot()
	out := []any{}
	view := loadMetaRead(snap.Root)
	readCards := []Obj{}
	section := str(p["section"])
	for i, folder := range arr(p["folders"]) {
		if i >= 120 {
			break
		}
		o, e := s.combo(snap, section, str(folder), view)
		card := obj(o["card"])
		if e != nil {
			var local bool
			card, local = groupErrorCard(section, str(folder), e)
			if !local {
				return nil, e
			}
		}
		view.decorate(card)
		out = append(out, card)
		readCards = append(readCards, card)
	}
	if s.stale(snap) {
		return nil, changed()
	}
	response := Obj{"ok": true, "root": snap.Root, "generation": snap.Generation, "section": section, "cards": out}
	view.decorate(response)
	addGroupReadDiagnostics(response, readCards)
	return response, nil
}
func (s *Server) flat() (Obj, error) {
	snap := s.snapshot()
	lib, e := detect(snap.Root)
	if e != nil {
		return nil, e
	}
	view := loadMetaRead(snap.Root)
	tasks := []Obj{}
	for _, key := range []string{"combos", "other"} {
		tasks = append(tasks, rows(lib[key])...)
	}
	result := make([][]Obj, len(tasks))
	readCards := make([]Obj, len(tasks))
	errs := make([]error, len(tasks))
	work := make(chan int)
	var wg sync.WaitGroup
	for n := 0; n < 4; n++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for i := range work {
				row := tasks[i]
				c, e := s.combo(snap, str(row["section"]), str(row["folder"]), view)
				if e != nil {
					var local bool
					readCards[i], local = groupErrorCard(str(row["section"]), str(row["folder"]), e)
					if !local {
						errs[i] = e
					}
				} else {
					result[i] = rows(c["items"])
					readCards[i] = obj(c["card"])
				}
			}
		}()
	}
	for i := range tasks {
		work <- i
	}
	close(work)
	wg.Wait()
	if s.stale(snap) {
		return nil, changed()
	}
	all := []Obj{}
	for i, r := range result {
		if errs[i] != nil {
			return nil, errs[i]
		}
		all = append(all, r...)
	}
	if s.stale(snap) {
		return nil, changed()
	}
	sort.SliceStable(all, func(i, j int) bool { return parseTime(all[i]["created"]).Before(parseTime(all[j]["created"])) })
	out := Obj{"ok": true, "root": snap.Root, "generation": snap.Generation, "items": asAny(all)}
	_, invalid, trashErr := s.trashRecords(snap)
	if trashErr != nil {
		return nil, trashVisibilityError("trash_unavailable")
	}
	addTrashReadDiagnostics(out, invalid)
	view.decorate(out)
	addGroupReadDiagnostics(out, readCards)
	return out, nil
}
func (s *Server) resolve(snap Snapshot, section, folder, file string) (string, error) {
	if !safeName(file) || mimeFor(file) == "" {
		return "", fail("invalid_media", "媒体路径无效。", 400)
	}
	rel, e := groupRel(snap, section, folder)
	if e != nil {
		return "", e
	}
	p, e := jailed(snap.Root, filepath.Join(rel, file))
	if e != nil {
		return "", e
	}
	return p, nil
}
func (s *Server) serveMedia(w http.ResponseWriter, r *http.Request) {
	parts := strings.Split(strings.TrimPrefix(r.URL.Path, "/media/"), "/")
	section, folder, file := "", "", ""
	if len(parts) == 2 && parts[0] == "_root" {
		section = parts[0]
		file = parts[1]
	} else if len(parts) == 3 {
		section = parts[0]
		folder = parts[1]
		file = parts[2]
	} else {
		sendError(w, fail("invalid_media", "Forbidden", 403))
		return
	}
	snap := s.snapshot()
	p, e := s.resolve(snap, section, folder, file)
	if e != nil {
		sendError(w, e)
		return
	}
	hidden, visibilityErr := s.mediaHidden(snap, Obj{"id": strings.TrimSuffix(file, filepath.Ext(file)), "file": file}, section, folder)
	if visibilityErr != nil {
		sendError(w, visibilityErr)
		return
	}
	if hidden {
		sendError(w, fail("trashed", "文件已进入回收站。", 404))
		return
	}
	serveLocal(w, r, p, true)
}
func (s *Server) browse(path string) (Obj, error) {
	path = copiedDirectoryInput(path)
	places := s.boot.Places
	if places == nil {
		places = []Obj{}
	}
	out := Obj{"ok": true, "kind": "computer", "path": "", "parent": nil, "dirs": []any{}, "places": places, "markers": []any{}, "selectable": false, "error": nil}
	if path == "" {
		ds := []any{}
		if runtime.GOOS == "windows" {
			for c := 'A'; c <= 'Z'; c++ {
				p := fmt.Sprintf("%c:\\", c)
				if isDir(p) {
					ds = append(ds, Obj{"name": p, "path": p})
				}
			}
		} else {
			ds = append(ds, Obj{"name": "/", "path": "/"})
			if home, e := os.UserHomeDir(); e == nil {
				ds = append(ds, Obj{"name": "主目录", "path": home})
			}
		}
		out["dirs"] = ds
		return out, nil
	}
	p, e := canonical(path)
	if e != nil {
		return nil, fail("invalid_directory", "目录无效或不可访问。", 400)
	}
	parent := filepath.Dir(p)
	if parent == p {
		parent = ""
	}
	entries, e := os.ReadDir(p)
	if e != nil {
		return nil, e
	}
	dirs := []any{}
	for _, d := range entries {
		if d.IsDir() && !strings.HasPrefix(d.Name(), ".") {
			dirs = append(dirs, Obj{"name": d.Name(), "path": filepath.Join(p, d.Name())})
		}
	}
	markers := []any{}
	for _, n := range []string{"_index.json", "card.json", "combos", "_other"} {
		if exists(filepath.Join(p, n)) {
			markers = append(markers, n)
		}
	}
	out["kind"] = "directory"
	out["path"] = p
	out["parent"] = parent
	out["dirs"] = dirs
	out["markers"] = markers
	out["selectable"] = true
	return out, nil
}
