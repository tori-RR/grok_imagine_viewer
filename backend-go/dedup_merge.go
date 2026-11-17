package main

import (
	"errors"
	"path/filepath"
)

// A copied body is recoverable while the source is still present. Persist its
// metadata before quarantining that source; replay can finish a copy-before-card
// interruption by filling missing target fields from the surviving source card.
func mergeDedupCard(path string, source Obj, retainedFile string) (Obj, error) {
	card, err := readJSON(path)
	if err != nil {
		return nil, err
	}
	items := rows(card["items"])
	id := str(source["id"])
	found := -1
	for i, item := range items {
		if str(item["id"]) == id {
			if found >= 0 || str(item["file"]) != retainedFile {
				return nil, errors.New("dedup_metadata_conflict")
			}
			found = i
		}
	}
	source = clone(source)
	for _, key := range []string{"media", "title", "_markerPresent"} {
		delete(source, key)
	}
	merged := clone(source)
	if found >= 0 {
		merged = clone(items[found])
		for key, value := range source {
			if merged[key] == nil || merged[key] == "" {
				merged[key] = value
			}
		}
	}
	merged["id"], merged["file"], merged["status"] = id, retainedFile, "linked"
	if found >= 0 {
		items[found] = merged
	} else {
		items = append(items, merged)
	}
	card["items"], card["count"] = asAny(items), len(items)
	images, videos, missing := 0, 0, 0
	members := []any{}
	latest := ""
	for _, item := range items {
		if mediaKind(item) == "video" {
			videos++
		} else {
			images++
		}
		status := str(item["status"])
		if status == "missing" {
			missing++
		}
		if status != "missing" && status != "trashed" {
			members = append(members, item["id"])
			if parseTime(str(item["created"])).After(parseTime(latest)) {
				latest = str(item["created"])
			}
		}
	}
	card["images"], card["videos"], card["missing"] = images, videos, missing
	card["memberIds"], card["latestItemCreatedAt"] = members, latest
	if err = atomicJSON(path, card); err != nil {
		return nil, err
	}
	return merged, nil
}

func refreshDedupIndex(snap Snapshot, keep Obj, keepDir string) error {
	if snap.Mode != "index" {
		return nil
	}
	indexPath, err := jailed(snap.Root, "_index.json")
	if err != nil {
		return err
	}
	index, err := readJSON(indexPath)
	if err != nil {
		return err
	}
	card, err := readJSON(filepath.Join(keepDir, "card.json"))
	if err != nil {
		return err
	}
	field := "combos"
	if str(keep["section"]) == "_other" {
		field = "other"
	}
	entries := rows(index[field])
	found := false
	for _, row := range entries {
		if str(row["folder"]) == str(keep["folder"]) {
			if found {
				return errors.New("dedup_index_mapping_changed")
			}
			found = true
			for key, value := range summary(card, str(keep["folder"])) {
				row[key] = value
			}
		}
	}
	if !found {
		return errors.New("dedup_index_mapping_changed")
	}
	index[field] = asAny(entries)
	return atomicJSON(indexPath, index)
}
