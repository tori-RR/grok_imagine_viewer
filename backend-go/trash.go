package main

import (
	"errors"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"
)

var tokenPattern = regexp.MustCompile(`^[0-9a-f]{32}$`)

func trashPaths(snap Snapshot, t Obj) (record, origin, body, marker string, err error) {
	id := str(t["id"])
	file, section, folder := str(t["file"]), str(t["section"]), str(t["folder"])
	if !safeName(file) || mimeFor(file) == "" {
		err = errors.New("invalid tombstone filename")
		return
	}
	rel, e := groupRel(snap, section, folder)
	if e != nil {
		err = e
		return
	}
	originRel := filepath.ToSlash(filepath.Join(rel, file))
	copyToken := strings.TrimPrefix(id, "copy:")
	var bodyRel, recordRel string
	if strings.HasPrefix(id, "copy:") {
		if !tokenPattern.MatchString(copyToken) || str(t["scope"]) != "copy" || str(t["token"]) != copyToken || str(t["assetId"]) != strings.TrimSuffix(file, filepath.Ext(file)) || len(str(t["hash"])) != 64 {
			err = errors.New("invalid copy record")
			return
		}
		recordRel = filepath.Join(".trash", "copies", copyToken, "record.json")
		bodyRel = filepath.ToSlash(filepath.Join(".trash", "copies", copyToken, file))
		marker, err = jailed(snap.Root, filepath.Join(".trash", "copies", copyToken, "binding.json"))
	} else {
		if !safeName(id) || id != strings.TrimSuffix(file, filepath.Ext(file)) {
			err = errors.New("invalid tombstone identity")
			return
		}
		recordRel = filepath.Join(".trash", "by-id", id+".json")
		if section == "_root" {
			bodyRel = filepath.ToSlash(filepath.Join(".trash", "_root", file))
		} else {
			bodyRel = filepath.ToSlash(filepath.Join(".trash", section, folder, file))
		}
	}
	if err != nil {
		return
	}
	if str(t["from"]) != originRel || str(t["to"]) != bodyRel {
		err = errors.New("tombstone path mismatch")
		return
	}
	record, err = jailed(snap.Root, recordRel)
	if err != nil {
		return
	}
	origin, err = jailed(snap.Root, originRel)
	if err != nil {
		return
	}
	body, err = jailed(snap.Root, bodyRel)
	if marker == "" {
		marker = origin + ".trashed"
	}
	return
}
func markerFor(t Obj) Obj {
	o := Obj{"phase": "trashing"}
	for _, k := range []string{"id", "file", "section", "folder", "from", "to", "token", "size", "mtimeNs"} {
		o[k] = t[k]
	}
	if str(t["scope"]) == "copy" {
		for _, k := range []string{"scope", "assetId", "hash"} {
			o[k] = t[k]
		}
	}
	return o
}
func validateMarker(path string, t Obj, optional bool) error {
	if !tokenPattern.MatchString(str(t["token"])) {
		return errors.New("invalid recovery token")
	}
	if !exists(path) && optional {
		return nil
	}
	o, e := readJSON(path)
	if e != nil {
		return e
	}
	if !tokenPattern.MatchString(str(t["token"])) {
		return errors.New("legacy tombstone requires original viewer recovery")
	}
	if !equalJSON(o, markerFor(t)) {
		return errors.New("trash binding mismatch")
	}
	return nil
}
func verifyTrashBody(path string, t Obj, full bool) error {
	fi, e := regular(path)
	if e != nil {
		return e
	}
	if fi.Size() != num(t["size"]) || fi.ModTime().UnixNano() != num(t["mtimeNs"]) {
		return errors.New("trash fingerprint mismatch")
	}
	if full && str(t["hash"]) != "" && !unchanged(path, t) {
		return errors.New("trash content mismatch")
	}
	return nil
}
func (s *Server) loadTomb(snap Snapshot, id string) (Obj, error) {
	var rel string
	if strings.HasPrefix(id, "copy:") {
		tk := strings.TrimPrefix(id, "copy:")
		if !tokenPattern.MatchString(tk) {
			return nil, errors.New("invalid copy id")
		}
		rel = filepath.Join(".trash", "copies", tk, "record.json")
	} else {
		if !safeName(id) {
			return nil, errors.New("invalid asset id")
		}
		rel = filepath.Join(".trash", "by-id", id+".json")
	}
	p, e := jailed(snap.Root, rel)
	if e != nil {
		return nil, e
	}
	t, e := readJSON(p)
	if e != nil {
		return nil, e
	}
	if str(t["id"]) != id {
		return nil, errors.New("invalid trash record")
	}
	_, origin, body, marker, e := trashPaths(snap, t)
	if e != nil {
		return nil, e
	}
	group, ge := groupRel(snap, str(t["section"]), str(t["folder"]))
	if ge != nil {
		return nil, ge
	}
	cardPath, ge := jailed(snap.Root, filepath.Join(group, "card.json"))
	if ge != nil {
		return nil, ge
	}
	if exists(cardPath) {
		card, ge := readJSON(cardPath)
		if ge != nil {
			return nil, ge
		}
		expectedID := str(t["id"])
		if str(t["scope"]) == "copy" {
			expectedID = str(t["assetId"])
		}
		foundFile, foundID := false, false
		for _, it := range rows(card["items"]) {
			if str(it["file"]) == str(t["file"]) {
				foundFile = true
				if str(it["id"]) == expectedID {
					foundID = true
				}
			}
		}
		if foundFile && !foundID {
			return nil, errors.New("trash card identity mismatch")
		}
	}
	phase := str(t["phase"])
	if phase != "trashing" && phase != "trashed" && phase != "restoring" && phase != "purging" && phase != "purged" {
		return nil, errors.New("unknown recovery phase")
	}
	optional := phase == "trashing" && !exists(body) && exists(origin) || phase == "purged" || phase == "purging" && !exists(body) || phase == "restoring" && !exists(body) && exists(origin)
	if e = validateMarker(marker, t, optional); e != nil {
		return nil, e
	}
	return t, nil
}

// Read-only visibility cache: mutations NEVER use this shortcut for validation.
func (s *Server) trashRecords(snap Snapshot) (map[string]Obj, map[string]bool, error) {
	if snap.Root == "" {
		return map[string]Obj{}, map[string]bool{}, nil
	}
	s.trashMu.Lock()
	defer s.trashMu.Unlock()
	c := s.trashRead
	if c.root == snap.Root && c.generation == snap.Generation && time.Since(c.at) < 2*time.Second {
		return c.records, c.invalid, c.err
	}
	records := map[string]Obj{}
	invalid := map[string]bool{}
	dir, err := jailed(snap.Root, filepath.Join(".trash", "by-id"))
	if err == nil {
		// Distinguish a genuinely absent index from an existing non-directory
		// or an I/O failure. Neither proves an available empty trash index.
		var info os.FileInfo
		info, err = os.Lstat(dir)
		if err == nil && !info.IsDir() {
			err = errors.New("trash index is not a directory")
		} else if os.IsNotExist(err) {
			// jailed() permits a missing suffix. Check its parent as well so an
			// ENOTDIR from a damaged .trash entry is not treated as absence.
			parent, parentErr := os.Lstat(filepath.Dir(dir))
			if parentErr == nil && !parent.IsDir() {
				err = errors.New("trash parent is not a directory")
			} else if parentErr == nil || os.IsNotExist(parentErr) {
				err = nil
			}
			info = nil
		}
		if err == nil && info != nil {
			var entries []os.DirEntry
			entries, err = os.ReadDir(dir)
			for _, de := range entries {
				if !strings.HasSuffix(de.Name(), ".json") {
					continue
				}
				id := strings.TrimSuffix(de.Name(), ".json")
				p, e := jailed(dir, de.Name())
				var row Obj
				if e == nil {
					row, e = readJSON(p)
				}
				if e != nil || !safeName(id) || str(row["id"]) != id {
					invalid[id] = true
					continue
				}
				phase := str(row["phase"])
				if phase != "trashing" && phase != "trashed" && phase != "restoring" && phase != "purging" && phase != "purged" {
					invalid[id] = true
					continue
				}
				if _, _, _, _, e = trashPaths(snap, row); e != nil {
					invalid[id] = true
					continue
				}
				records[id] = row
			}
		}
	}
	s.trashRead = trashReadCache{root: snap.Root, generation: snap.Generation, at: time.Now(), records: records, invalid: invalid, err: err}
	return records, invalid, err
}

func trashVisibilityError(code string) error {
	message := "回收站记录暂时无法读取，未将图库判为空。"
	if code == "trash_record_corrupt" {
		message = "部分回收站记录损坏，相关素材暂不可用；原文件已保留。"
	}
	return &APIError{Code: code, Message: message, Status: 503, Extra: Obj{"state": "unavailable", "countKnown": false}}
}

func addTrashReadDiagnostics(out Obj, invalid map[string]bool) {
	if len(invalid) == 0 {
		return
	}
	ids := make([]string, 0, len(invalid))
	for id := range invalid {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	// Diagnostics are bounded even when a directory contains many damaged
	// records. The visibility map still retains every ID for fail-closed reads.
	out["trashIssueCount"] = len(ids)
	if len(ids) > 64 {
		ids = ids[:64]
	}
	issues := make([]any, 0, len(ids))
	for _, id := range ids {
		issues = append(issues, Obj{"id": id, "code": "trash_record_corrupt"})
	}
	out["warnings"] = []any{"trash_records_corrupt"}
	out["trashIssues"] = issues
}

func visibilityWithRecords(snap Snapshot, item Obj, section, folder string, records map[string]Obj, invalid map[string]bool) (bool, error) {
	file, id := str(item["file"]), str(item["id"])
	if !safeName(id) || !safeName(file) {
		return true, nil
	}
	if invalid[id] {
		return false, trashVisibilityError("trash_record_corrupt")
	}
	t := records[id]
	if len(t) > 0 {
		phase := str(t["phase"])
		if phase == "restoring" {
			_, origin, body, _, e := trashPaths(snap, t)
			if e == nil && exists(origin) && !exists(body) {
				return false, nil
			}
		}
		return true, nil
	}
	if marked, ok := item["_markerPresent"].(bool); ok {
		return marked, nil
	}
	rel, e := groupRel(snap, section, folder)
	if e != nil {
		return true, nil
	}
	marker, e := jailed(snap.Root, filepath.Join(rel, file+".trashed"))
	return e != nil || exists(marker), nil
}

func (s *Server) mediaHidden(snap Snapshot, item Obj, section, folder string) (bool, error) {
	records, invalid, err := s.trashRecords(snap)
	if err != nil {
		return false, trashVisibilityError("trash_unavailable")
	}
	return visibilityWithRecords(snap, item, section, folder, records, invalid)
}

// Mutations retain fail-closed behavior; read APIs propagate uncertainty instead
// of converting it to a deletion or a successful empty group.
func (s *Server) hidden(snap Snapshot, item Obj, section, folder string) bool {
	hidden, err := s.mediaHidden(snap, item, section, folder)
	return hidden || err != nil
}
func (s *Server) trashList(snap Snapshot) (Obj, error) {
	if snap.Root == "" {
		return Obj{"ok": true, "items": []any{}}, nil
	}
	ids := []string{}
	for _, dir := range []string{"by-id", "copies"} {
		p, e := jailed(snap.Root, filepath.Join(".trash", dir))
		if e != nil {
			return nil, e
		}
		entries, e := os.ReadDir(p)
		if e != nil && !os.IsNotExist(e) {
			return nil, e
		}
		for _, entry := range entries {
			if dir == "by-id" && !entry.IsDir() && strings.HasSuffix(entry.Name(), ".json") {
				ids = append(ids, strings.TrimSuffix(entry.Name(), ".json"))
			} else if dir == "copies" && entry.IsDir() && tokenPattern.MatchString(entry.Name()) {
				ids = append(ids, "copy:"+entry.Name())
			}
		}
	}
	out := []Obj{}
	legacy := []Obj{}
	warnings := 0
	for _, id := range ids {
		t, e := s.loadTomb(snap, id)
		if e != nil {
			if row, legacyErr := s.inspectLegacyTrash(snap, id, false); legacyErr == nil {
				legacy = append(legacy, row)
			}
			warnings++
			continue
		}
		if str(t["phase"]) == "purged" {
			continue
		}
		_, origin, body, _, e := trashPaths(snap, t)
		if e != nil {
			warnings++
			continue
		}
		if !exists(body) {
			if (str(t["phase"]) == "trashing" || str(t["phase"]) == "restoring") && exists(origin) && verifyTrashBody(origin, t, true) == nil {
				body = origin // Interrupted move: show a recoverable, verified source.
			} else {
				continue
			}
		}
		if e = verifyTrashBody(body, t, false); e != nil {
			warnings++
			continue
		}
		row := clone(t)
		row["cover"] = "/resource/trash/file?id=" + url.QueryEscape(id)
		row["exists"] = true
		row["media"] = mediaKind(row)
		row["mime"] = mimeFor(str(row["file"]))
		out = append(out, row)
	}
	sort.SliceStable(out, func(i, j int) bool { return str(out[i]["deletedAt"]) > str(out[j]["deletedAt"]) })
	if s.stale(snap) { return nil, changed() }
	return Obj{"ok": true, "root": snap.Root, "generation":snap.Generation, "items": asAny(out), "legacyItems":asAny(legacy), "warnings": warnings}, nil
}
func (s *Server) quarantine(snap Snapshot, section, folder string, item Obj, isCopy bool) (Obj, error) {
	file, id := str(item["file"]), str(item["id"])
	if id != strings.TrimSuffix(file, filepath.Ext(file)) {
		return nil, errors.New("asset filename mismatch")
	}
	origin, e := s.resolve(snap, section, folder, file)
	if e != nil {
		return nil, e
	}
	fp, e := fingerprint(origin)
	if e != nil {
		return nil, e
	}
	rel, _ := filepath.Rel(snap.Root, origin)
	tk := token()
	t := Obj{"id": id, "file": file, "section": section, "folder": folder, "from": filepath.ToSlash(rel), "deletedAt": time.Now().UTC().Format(time.RFC3339Nano), "token": tk, "size": fp["size"], "mtimeNs": fp["mtimeNs"], "hash": fp["hash"], "phase": "trashing"}
	if isCopy {
		t["id"] = "copy:" + tk
		t["scope"] = "copy"
		t["assetId"] = id
		t["to"] = filepath.ToSlash(filepath.Join(".trash", "copies", tk, file))
	} else if section == "_root" {
		t["to"] = filepath.ToSlash(filepath.Join(".trash", "_root", file))
	} else {
		t["to"] = filepath.ToSlash(filepath.Join(".trash", section, folder, file))
	}
	rec, origin, body, marker, e := trashPaths(snap, t)
	if e != nil {
		return nil, e
	}
	if exists(body) || exists(marker) || exists(rec) {
		return nil, errors.New("existing recovery evidence retained")
	}
	if e = os.MkdirAll(filepath.Dir(body), 0700); e != nil {
		return nil, e
	}
	if e = atomicJSON(rec, t); e != nil {
		return nil, e
	}
	if e = atomicJSON(marker, markerFor(t)); e != nil {
		return nil, e
	}
	if e = verifyTrashBody(origin, t, true); e != nil {
		return nil, e
	}
	if e = moveNoReplace(origin, body); e != nil {
		return nil, e
	}
	if e = verifyTrashBody(body, t, true); e != nil {
		return nil, e
	}
	t["phase"] = "trashed"
	if e = atomicJSON(rec, t); e != nil {
		return nil, e
	}
	return t, nil
}
func (s *Server) trashAdd(snap Snapshot, p Obj) (Obj, error) {
	groups := rows(p["groups"])
	if len(groups) == 0 {
		groups = []Obj{p}
	}
	moved, errs := []any{}, []any{}
	for _, g := range groups {
		section, folder := str(g["section"]), str(g["folder"])
		if snap.Mode == "single" {
			section = "_root"
			folder = ""
		}
		if snap.Mode == "loose" {
			section = "loose"
		}
		_, items, e := s.readGroup(snap, section, folder)
		if e != nil {
			errs = append(errs, Obj{"folder": folder, "error": "invalid_group"})
			continue
		}
		ids, files := map[string]bool{}, map[string]bool{}
		for _, v := range arr(g["ids"]) {
			ids[str(v)] = true
		}
		for _, v := range arr(g["files"]) {
			files[str(v)] = true
		}
		for _, it := range items {
			if g["ids"] != nil || g["files"] != nil {
				if !ids[str(it["id"])] && !files[str(it["file"])] {
					continue
				}
			}
			if s.hidden(snap, it, section, folder) {
				continue
			}
			row, e := s.quarantine(snap, section, folder, it, false)
			if e != nil {
				errs = append(errs, Obj{"id": it["id"], "file": it["file"], "error": "trash_incomplete_recovery_retained"})
			} else {
				moved = append(moved, row)
			}
		}
	}
	return Obj{"ok": true, "moved": moved, "errors": errs, "root": snap.Root}, nil
}
func (s *Server) trashChange(snap Snapshot, p Obj, purge bool) (Obj, error) {
	if len(arr(p["ids"])) == 0 {
		return nil, fail("invalid_ids", "请选择回收站条目。", 400)
	}
	done, conflicts, errs := []any{}, []any{}, []any{}
	for _, v := range arr(p["ids"]) {
		id := str(v)
		t, e := s.loadTomb(snap, id)
		if e != nil {
			errs = append(errs, Obj{"id": id, "error": "invalid_recovery_record"})
			continue
		}
		record, origin, body, marker, e := trashPaths(snap, t)
		if e != nil {
			errs = append(errs, Obj{"id": id, "error": "invalid_recovery_path"})
			continue
		}
		work := func() error {
			if purge {
				if str(t["phase"]) == "purged" {
					return nil
				}
				if exists(body) {
					if e := verifyTrashBody(body, t, true); e != nil {
						return e
					}
				} else if str(t["phase"]) != "purging" {
					return errors.New("missing_body")
				}
				t["phase"] = "purging"
				if e := atomicJSON(record, t); e != nil {
					return e
				}
				if exists(body) {
					if e := os.Remove(body); e != nil {
						return e
					}
				}
				if exists(marker) {
					if _, e := regular(marker); e != nil {
						return e
					}
					if e := os.Remove(marker); e != nil {
						return e
					}
				}
				t["phase"] = "purged"
				return atomicJSON(record, t)
			}
			if !exists(body) {
				if (str(t["phase"]) != "restoring" && str(t["phase"]) != "trashing") || !exists(origin) {
					return errors.New("missing_body")
				}
				if e := verifyTrashBody(origin, t, true); e != nil {
					return e
				}
				t["phase"] = "restoring"
				if e := atomicJSON(record, t); e != nil {
					return e
				}
			} else {
				if exists(origin) {
					return os.ErrExist
				}
				if e := verifyTrashBody(body, t, true); e != nil {
					return e
				}
				t["phase"] = "restoring"
				if e := atomicJSON(record, t); e != nil {
					return e
				}
				if e := os.MkdirAll(filepath.Dir(origin), 0700); e != nil {
					return e
				}
				if e := moveNoReplace(body, origin); e != nil {
					return e
				}
				if e := verifyTrashBody(origin, t, true); e != nil {
					return e
				}
			}
			if exists(marker) {
				if _, e := regular(marker); e != nil {
					return e
				}
				if e := os.Remove(marker); e != nil {
					return e
				}
			}
			return os.Remove(record)
		}
		e = work()
		if errors.Is(e, os.ErrExist) {
			conflicts = append(conflicts, Obj{"id": id, "error": "restore_conflict"})
		} else if e != nil {
			errs = append(errs, Obj{"id": id, "error": "recovery_incomplete_evidence_retained"})
		} else {
			done = append(done, id)
		}
	}
	field := "restored"
	if purge {
		field = "purged"
	}
	return Obj{"ok": true, field: done, "conflicts": conflicts, "errors": errs, "root": snap.Root}, nil
}
func (s *Server) serveTrash(w http.ResponseWriter, r *http.Request, id string) {
	snap := s.snapshot()
	t, e := s.loadTomb(snap, id)
	if e != nil {
		sendError(w, fail("invalid_trash", "回收站条目不可用。", 404))
		return
	}
	_, origin, body, _, e := trashPaths(snap, t)
	if e != nil {
		sendError(w, e)
		return
	}
	if !exists(body) && (str(t["phase"]) == "trashing" || str(t["phase"]) == "restoring") && verifyTrashBody(origin, t, true) == nil {
		body = origin
	}
	if e = verifyTrashBody(body, t, false); e != nil {
		sendError(w, e)
		return
	}
	serveLocal(w, r, body, true)
}
