package main

import (
	"errors"
	"os"
	"path/filepath"
)

func (r *DownloadRun) publishedAsset(a Asset, rec Obj) (string, error) {
	group := a.Conv
	if group == "" {
		group = a.RootConv
	}
	if group == "" {
		group = a.ID
	}
	// The durable plan is authoritative, including root-conversation fallback.
	row, _, err := r.layoutPlan(group)
	if err != nil {
		return "", err
	}
	if row == nil && a.RootConv != "" {
		row, _, err = r.layoutPlan(a.RootConv)
	}
	if row == nil && group == "" {
		row, _, err = r.layoutPlan(a.ID)
	}
	if err != nil || row == nil {
		return "", errors.New("published_layout_missing")
	}
	path, err := jailed(r.Snap.Root, filepath.Join(str(row["section"]), str(row["folder"]), a.ID+assetExt(a)))
	if err != nil {
		return "", err
	}
	if !unchanged(path, Obj{"size": rec["bytes"], "hash": rec["hash"]}) {
		return "", errors.New("published_content_changed")
	}
	if err = validateMediaFile(path, a.Mime, num(rec["bytes"])); err != nil {
		return "", err
	}
	return path, nil
}

// Only journal-owned bodies are staging. Never scan or sweep historical inbox
// files. Persist the released-body state before unlinking; recovery then proves
// the formal copy instead of requiring the now intentionally absent inbox body.
func (r *DownloadRun) releasePublishedInbox(m Manifest) error {
	for _, a := range m.Assets {
		recordPath, err := r.transactionPath(filepath.Join("items", a.ID+".json"))
		if err != nil {
			return err
		}
		rec, err := readJSON(recordPath)
		if err != nil {
			return err
		}
		if len(rec) == 0 {
			continue
		}
		state, tk := str(rec["state"]), str(rec["partToken"])
		if state == "receiving" {
			continue
		}
		if requireKeys(rec, "assetId", "extension", "partToken", "bytes", "state", "hash") != nil || str(rec["assetId"]) != a.ID || str(rec["extension"]) != assetExt(a) || !tokenPattern.MatchString(tk) || (state != "ready" && state != "committed" && state != "published") || num(rec["bytes"]) <= 0 || len(str(rec["hash"])) != 64 {
			return errors.New("invalid_staging_owner")
		}
		if _, err = r.publishedAsset(a, rec); err != nil {
			return err
		}
		part, inbox, err := r.part(a, tk)
		if err != nil {
			return err
		}
		if _, err = os.Lstat(part); !os.IsNotExist(err) {
			return errors.New("staging_part_pending")
		}
		info, err := regular(inbox)
		if os.IsNotExist(err) && state == "published" {
			continue
		}
		if err != nil {
			return err
		}
		if !unchanged(inbox, Obj{"size": rec["bytes"], "hash": rec["hash"]}) {
			return errors.New("staging_content_changed")
		}
		rec["state"] = "published"
		if err = atomicJSON(recordPath, rec); err != nil {
			return err
		}
		current, err := regular(inbox)
		if err != nil || !os.SameFile(info, current) {
			return errors.New("staging_identity_changed")
		}
		if err = os.Remove(inbox); err != nil {
			if _, check := os.Lstat(inbox); !os.IsNotExist(check) {
				return err
			}
		}
		if _, err = os.Lstat(inbox); !os.IsNotExist(err) {
			return errors.New("staging_release_uncertain")
		}
	}
	return nil
}
