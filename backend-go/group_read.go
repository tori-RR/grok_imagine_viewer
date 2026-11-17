package main

import (
	"errors"
	"os"
)

func discoverySummary(card Obj, folder string) Obj {
	row := summary(card, folder)
	if str(card["_cardReadError"]) != "" {
		delete(row, "count")
		row["state"], row["countKnown"], row["metadataKnown"], row["cardError"] = "corrupt", false, false, "card_corrupt"
	}
	return row
}

// Only a confirmed absent group under a still-readable root is gone. All
// other local I/O failures remain unknown and must retain the previous card.
func (s *Server) groupReadError(snap Snapshot, section, folder string, err error) error {
	if s.stale(snap) {
		return changed()
	}
	var api *APIError
	if errors.As(err, &api) {
		return err
	}
	if os.IsNotExist(err) {
		rel, relErr := groupRel(snap, section, folder)
		dir, pathErr := jailed(snap.Root, rel)
		_, statErr := os.Lstat(dir)
		// Windows may classify ReadDir(file) as IsNotExist. Confirm the exact
		// group entry is absent rather than trusting the directory-read error.
		if st, rootErr := os.Stat(snap.Root); rootErr == nil && st.IsDir() && relErr == nil && pathErr == nil && os.IsNotExist(statErr) {
			return &APIError{"group_gone", "分组目录已不存在。", 404, Obj{"root": snap.Root, "generation": snap.Generation, "section": section, "folder": folder, "state": "gone", "gone": true, "countKnown": true}}
		}
	}
	return &APIError{"group_unavailable", "分组暂时无法读取，请稍后重试。", 503, Obj{"root": snap.Root, "generation": snap.Generation, "section": section, "folder": folder, "state": "unavailable", "unavailable": true, "countKnown": false}}
}

func groupErrorCard(section, folder string, err error) (Obj, bool) {
	var api *APIError
	if !errors.As(err, &api) || api.Code != "group_gone" && api.Code != "group_unavailable" {
		return nil, false
	}
	section, folder = str(api.Extra["section"]), str(api.Extra["folder"])
	card := Obj{"section": section, "folder": folder, "state": api.Extra["state"], "live": false, "countKnown": api.Extra["countKnown"], "error": api.Code, "warnings": []any{api.Code}}
	if api.Code == "group_gone" {
		card["gone"], card["count"], card["live"] = true, 0, true
	} else {
		card["unavailable"] = true
	}
	return card, true
}

func groupIssue(card Obj) Obj {
	state := str(card["state"])
	if state == "" || state == "available" {
		return nil
	}
	out := Obj{"section": card["section"], "folder": card["folder"], "state": state, "countKnown": card["countKnown"]}
	for _, key := range []string{"error", "cardError", "unavailableIds", "gone"} {
		if value, ok := card[key]; ok {
			out[key] = value
		}
	}
	return out
}

func addGroupReadDiagnostics(out Obj, cards []Obj) {
	issues, unavailable := []any{}, []any{}
	for _, card := range cards {
		if issue := groupIssue(card); issue != nil {
			issues = append(issues, issue)
			if card["countKnown"] == false {
				unavailable = append(unavailable, issue)
			}
		}
	}
	if len(issues) > 0 {
		out["groupIssues"] = issues
		out["warnings"] = unique(append(arr(out["warnings"]), "group_read_partial"))
	}
	if len(unavailable) > 0 {
		out["unavailableGroups"] = unavailable
	}
}
