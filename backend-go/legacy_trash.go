package main

import (
	"errors"
	"os"
	"path/filepath"
)

const legacyRecoveryHint = "这是缺少恢复凭据的早期记录。请先备份图库，再在副本中使用兼容旧版核验恢复；当前版本不会自动迁移、恢复或彻底删除这些文件。"

// Legacy discovery is a separate read-only view. It never authorizes loadTomb,
// restore or purge, and never invents a token for unbound historical evidence.
func (s *Server) inspectLegacyTrash(snap Snapshot, id string, content bool) (Obj, error) {
	if !safeName(id) {
		return nil, errors.New("invalid legacy id")
	}
	record, err := jailed(snap.Root, filepath.Join(".trash", "by-id", id+".json"))
	if err != nil {
		return nil, err
	}
	tomb, err := readJSON(record)
	if err != nil {
		return nil, err
	}
	if _, modern := tomb["token"]; modern {
		return nil, errors.New("not an early record")
	}
	if _, phased := tomb["phase"]; phased {
		return nil, errors.New("not an early record")
	}
	if _, scoped := tomb["scope"]; scoped {
		return nil, errors.New("not an early record")
	}
	row := Obj{"id": id, "file": str(tomb["file"]), "section": str(tomb["section"]), "folder": str(tomb["folder"]), "deletedAt": str(tomb["deletedAt"]), "legacy": true, "recoverable": false, "verified": false, "exists": false, "state": "legacy", "reason": "legacy_unverified", "recoveryHint": legacyRecoveryHint}
	blocked := func(reason string) (Obj, error) {
		row["reason"] = reason
		row["state"] = "legacy_blocked"
		return row, nil
	}
	if str(tomb["id"]) != id {
		return blocked("legacy_identity_mismatch")
	}
	_, origin, body, marker, err := trashPaths(snap, tomb)
	if err != nil {
		return blocked("legacy_path_unverified")
	}
	row["from"], row["to"] = tomb["from"], tomb["to"]
	group, err := groupRel(snap, str(tomb["section"]), str(tomb["folder"]))
	if err != nil {
		return blocked("legacy_path_unverified")
	}
	cardPath, err := jailed(snap.Root, filepath.Join(group, "card.json"))
	if err != nil {
		return blocked("legacy_card_unverified")
	}
	card, err := readJSON(cardPath)
	if err != nil {
		return blocked("legacy_card_unverified")
	}
	items, ok := card["items"].([]any)
	if !ok {
		return blocked("legacy_card_unverified")
	}
	matches := 0
	for _, value := range items {
		item := obj(value)
		if str(item["id"]) == id || str(item["file"]) == str(tomb["file"]) {
			if str(item["id"]) != id || str(item["file"]) != str(tomb["file"]) {
				return blocked("legacy_card_identity_mismatch")
			}
			matches++
		}
	}
	if matches != 1 {
		return blocked("legacy_card_identity_mismatch")
	}
	binding, err := readJSON(marker)
	if err != nil {
		return blocked("legacy_marker_unverified")
	}
	if _, signed := binding["token"]; signed {
		return blocked("legacy_marker_mismatch")
	}
	if str(binding["id"]) != id || str(binding["file"]) != str(tomb["file"]) {
		return blocked("legacy_marker_mismatch")
	}
	for _, key := range []string{"section", "folder", "from", "to"} {
		if value, present := binding[key]; present && !equalJSON(value, tomb[key]) {
			return blocked("legacy_marker_mismatch")
		}
	}
	if _, err := os.Lstat(origin); err == nil {
		return blocked("legacy_target_conflict")
	} else if !os.IsNotExist(err) {
		return blocked("legacy_target_unavailable")
	}
	info, err := regular(body)
	if err != nil {
		return blocked("legacy_body_unavailable")
	}
	row["exists"], row["size"] = true, info.Size()
	for key, actual := range map[string]int64{"size": info.Size(), "mtimeNs": info.ModTime().UnixNano()} {
		if value, present := tomb[key]; present && (!numeric(value) || num(value) != actual) {
			return blocked("legacy_fingerprint_mismatch")
		}
	}
	if content {
		fp, err := fingerprint(body)
		if err != nil {
			return blocked("legacy_body_unavailable")
		}
		after, err := regular(body)
		if err != nil || !os.SameFile(info, after) || info.Size() != after.Size() || info.ModTime() != after.ModTime() {
			return blocked("legacy_body_changed")
		}
		if expected, present := tomb["hash"]; present && (str(expected) == "" || str(expected) != str(fp["hash"])) {
			return blocked("legacy_fingerprint_mismatch")
		}
		// Re-read identity documents after potentially slow content hashing.
		for path, expected := range map[string]Obj{record: tomb, marker: binding, cardPath: card} {
			current, err := readJSON(path)
			if err != nil || !equalJSON(current, expected) {
				return blocked("legacy_evidence_changed")
			}
		}
		row["hash"] = fp["hash"]
		row["verified"] = true
	}
	row["reason"] = "legacy_recovery_required"
	return row, nil
}

func (s *Server) legacyTrashPreview(expectedRoot, id string) (Obj, error) {
	snap := s.snapshot()
	if snap.Root == "" || expectedRoot != snap.Root {
		return nil, changed()
	}
	row, err := s.inspectLegacyTrash(snap, id, true)
	if err != nil {
		return nil, fail("legacy_record_unavailable", "历史回收站记录无法读取，原文件已保留。", 404)
	}
	if s.stale(snap) {
		return nil, changed()
	}
	row["ok"], row["root"], row["generation"] = true, snap.Root, snap.Generation
	return row, nil
}
