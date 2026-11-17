package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"time"
)

var groupSuffix = regexp.MustCompile(`^(\d+)_([A-Za-z0-9-]{6,})$`)

type DedupPlan struct {
	Snap             Snapshot
	Token, Signature string
	Created          time.Time
	Groups           []Obj
	Private          map[string][]Obj
}

func (s *Server) dedupScan(snap Snapshot) (*DedupPlan, error) {
	if snap.Mode != "index" && snap.Mode != "combos" {
		return nil, fail("unsupported_library", "整理重复组合仅支持完整图库。", 409)
	}
	lib, e := detect(snap.Root)
	if e != nil {
		return nil, e
	}
	indexed := map[string]bool{}
	if snap.Mode == "index" {
		idx, e := readJSON(filepath.Join(snap.Root, "_index.json"))
		if e != nil {
			return nil, e
		}
		for _, field := range []string{"combos", "other"} {
			sec := "combos"
			if field == "other" {
				sec = "_other"
			}
			for _, r := range rows(idx[field]) {
				indexed[groupKey(sec, str(r["folder"]))] = true
			}
		}
	}
	buckets := map[string][]Obj{}
	for _, field := range []string{"combos", "other"} {
		for _, row := range rows(lib[field]) {
			m := groupSuffix.FindStringSubmatch(str(row["folder"]))
			if m != nil {
				k := str(row["section"]) + "/" + m[2]
				buckets[k] = append(buckets[k], row)
			}
		}
	}
	keys := []string{}
	for k := range buckets {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	plan := &DedupPlan{Snap: snap, Token: token(), Created: time.Now(), Groups: []Obj{}, Private: map[string][]Obj{}}
	for _, key := range keys {
		members := buckets[key]
		if len(members) < 2 {
			continue
		}
		sort.SliceStable(members, func(i, j int) bool {
			ai, bi := indexed[groupKey(str(members[i]["section"]), str(members[i]["folder"]))], indexed[groupKey(str(members[j]["section"]), str(members[j]["folder"]))]
			if ai != bi {
				return ai
			}
			return str(members[i]["folder"]) > str(members[j]["folder"])
		})
		keep := members[0]
		private := []Obj{}
		for i, row := range members {
			if i > 0 && indexed[groupKey(str(row["section"]), str(row["folder"]))] {
				continue
			}
			card, items, e := s.readGroup(snap, str(row["section"]), str(row["folder"]))
			if e != nil {
				return nil, e
			}
			files := Obj{}
			for _, it := range items {
				if s.hidden(snap, it, str(row["section"]), str(row["folder"])) {
					continue
				}
				path, e := s.resolve(snap, str(row["section"]), str(row["folder"]), str(it["file"]))
				if e != nil {
					return nil, e
				}
				fp, e := fingerprint(path)
				if e != nil {
					return nil, e
				}
				id := str(it["id"])
				if _, ok := files[id]; ok {
					return nil, fail("ambiguous_asset", "同组存在同 ID 不同文件，请手动核对。", 409)
				}
				files[id] = Obj{"item": it, "fp": fp}
			}
			private = append(private, Obj{"section": row["section"], "folder": row["folder"], "n": row["n"], "files": files, "cardHash": hash(mustJSON(card))})
		}
		if len(private) < 2 {
			continue
		}
		held := obj(private[0]["files"])
		others := []any{}
		related := []Obj{private[0]}
		conflicts, uniques := []any{}, []any{}
		identical := true
		would := 0
		for _, other := range private[1:] {
			shared := false
			for id := range obj(other["files"]) {
				if held[id] != nil {
					shared = true
					break
				}
			}
			if !shared {
				continue
			}
			related = append(related, other)
			others = append(others, Obj{"section": other["section"], "folder": other["folder"], "n": other["n"]})
			for id, v := range obj(other["files"]) {
				would++
				entry := obj(v)
				a := obj(held[id])
				if len(a) == 0 {
					identical = false
					uniques = append(uniques, Obj{"id": id, "folder": other["folder"]})
				} else if str(obj(a["fp"])["hash"]) != str(obj(entry["fp"])["hash"]) {
					identical = false
					conflicts = append(conflicts, Obj{"id": id, "keepFolder": keep["folder"], "otherFolder": other["folder"], "keepSize": obj(a["fp"])["size"], "otherSize": obj(entry["fp"])["size"]})
				}
			}
		}
		if len(others) == 0 {
			continue
		}
		plan.Private[key] = related
		plan.Groups = append(plan.Groups, Obj{"key": key, "identical": identical, "keep": Obj{"section": keep["section"], "folder": keep["folder"], "n": keep["n"]}, "others": others, "files": len(held) + would, "wouldTrash": would, "oversized": would > 10000 || len(others) > 100, "reason": "", "conflicts": conflicts, "uniqueOthers": uniques})
	}
	plan.Signature = hash(mustJSON(Obj{"groups": plan.Private, "indexed": indexed}))
	return plan, nil
}
func mustJSON(v any) []byte { b, _ := json.Marshal(v); return b }
func (s *Server) dedup(p Obj) (Obj, error) {
	snap := s.snapshot()
	if !sameRoot(str(p["expectedRoot"]), snap.Root) {
		return nil, changed()
	}
	if !yes(p["apply"]) {
		plan, e := s.dedupScan(snap)
		if e != nil {
			return nil, e
		}
		if s.stale(snap) {
			return nil, changed()
		}
		groups := plan.Groups
		if len(groups) > 80 {
			groups = groups[:80]
		}
		plan.Groups = groups
		s.dedupMu.Lock()
		s.dedupPlan = plan
		s.dedupMu.Unlock()
		same, mixed, folders, would := 0, 0, 0, int64(0)
		for _, g := range groups {
			if yes(g["identical"]) {
				same++
			} else {
				mixed++
			}
			folders += len(arr(g["others"]))
			would += num(g["wouldTrash"])
		}
		return Obj{"ok": true, "root": snap.Root, "planToken": plan.Token, "groups": asAny(groups), "identical": same, "mixed": mixed, "leftoverFolders": folders, "wouldTrash": would, "truncated": len(plan.Private) > 80}, nil
	}
	return s.withWrite(p, false, func(snap Snapshot) (Obj, error) {
		s.dedupMu.Lock()
		plan := s.dedupPlan
		s.dedupPlan = nil
		s.dedupMu.Unlock()
		if plan == nil || plan.Token != str(p["planToken"]) || time.Since(plan.Created) > 15*time.Minute || plan.Snap != snap {
			return nil, fail("dedup_preview_required", "预览已失效，请重新扫描。", 409)
		}
		actions := obj(p["actions"])
		allowed := map[string]bool{}
		for _, g := range plan.Groups {
			allowed[str(g["key"])] = true
		}
		for k, v := range actions {
			if !allowed[k] || str(v) != "skip" && str(v) != "keep_newest" && str(v) != "merge" {
				return nil, fail("invalid_dedup_selection", "只能执行预览中明确选择的操作。", 409)
			}
		}
		s.invalidate()
		fresh, e := s.dedupScan(snap)
		if e != nil {
			return nil, e
		}
		if fresh.Signature != plan.Signature {
			return nil, fail("dedup_plan_changed", "预览后文件已变化，没有清理，请重新扫描。", 409)
		}
		moved, errs := []any{}, []any{}
		for _, g := range plan.Groups {
			key := str(g["key"])
			action := str(actions[key])
			if action == "" || action == "skip" {
				continue
			}
			if yes(g["oversized"]) {
				errs = append(errs, Obj{"folder": obj(g["keep"])["folder"], "error": "oversized_group"})
				continue
			}
			members := plan.Private[key]
			keep := members[0]
			held := obj(keep["files"])
			keepRel, e := groupRel(snap, str(keep["section"]), str(keep["folder"]))
			if e != nil {
				return nil, e
			}
			keepDir, e := jailed(snap.Root, keepRel)
			if e != nil {
				return nil, e
			}
			for _, other := range members[1:] {
				ids := []string{}
				for id := range obj(other["files"]) {
					ids = append(ids, id)
				}
				sort.Strings(ids)
				for _, id := range ids {
					entry := obj(obj(other["files"])[id])
					it := obj(entry["item"])
					fp := obj(entry["fp"])
					heldEntry := obj(held[id])
					same := len(heldEntry) > 0 && str(obj(heldEntry["fp"])["hash"]) == str(fp["hash"])
					if len(heldEntry) > 0 && !same {
						errs = append(errs, Obj{"id": id, "error": "dedup_asset_content_conflict"})
						continue
					}
					if !same && action != "merge" {
						continue
					}
					source, e := s.resolve(snap, str(other["section"]), str(other["folder"]), str(it["file"]))
					if e != nil || !unchanged(source, fp) {
						errs = append(errs, Obj{"id": id, "error": "dedup_source_changed"})
						continue
					}
					retained := ""
					if same {
						retained = filepath.Join(keepDir, str(obj(heldEntry["item"])["file"]))
						if !unchanged(retained, obj(heldEntry["fp"])) {
							errs = append(errs, Obj{"id": id, "error": "dedup_kept_changed"})
							continue
						}
					}
					if !same {
						file := str(it["file"])
						retained = filepath.Join(keepDir, file)
						if exists(retained) {
							errs = append(errs, Obj{"id": id, "error": "copy_name_conflict"})
							continue
						}
						tmp := filepath.Join(keepDir, ".dedup-stage-"+token()+".part")
						if e = copyFileChecked(source, tmp); e != nil {
							errs = append(errs, Obj{"id": id, "error": "copy_failed"})
							continue
						}
						if !unchanged(tmp, fp) {
							os.Remove(tmp)
							errs = append(errs, Obj{"id": id, "error": "copy_changed"})
							continue
						}
						if e = publishNoReplace(tmp, retained); e != nil {
							errs = append(errs, Obj{"id": id, "error": "publish_uncertain"})
							continue
						}
						if !unchanged(retained, fp) {
							errs = append(errs, Obj{"id": id, "error": "dedup_copy_publish_changed"})
							continue
						}
					}
					merged, mergeErr := mergeDedupCard(filepath.Join(keepDir, "card.json"), it, filepath.Base(retained))
					if mergeErr != nil {
						errs = append(errs, Obj{"id": id, "error": "dedup_metadata_pending"})
						continue
					}
					retainedFP, fpErr := fingerprint(retained)
					if fpErr != nil || str(retainedFP["hash"]) != str(fp["hash"]) {
						errs = append(errs, Obj{"id": id, "error": "dedup_kept_changed"})
						continue
					}
					if e = refreshDedupIndex(snap, keep, keepDir); e != nil {
						errs = append(errs, Obj{"id": id, "error": "dedup_index_pending"})
						continue
					}
					held[id] = Obj{"item": merged, "fp": retainedFP}
					row, e := s.quarantine(snap, str(other["section"]), str(other["folder"]), it, true)
					if e != nil {
						errs = append(errs, Obj{"id": id, "error": "copy_quarantine_pending"})
					} else {
						moved = append(moved, row)
					}
				}
			}
		}
		return Obj{"ok": true, "moved": moved, "errors": errs, "groups": len(plan.Groups)}, nil
	})
}
