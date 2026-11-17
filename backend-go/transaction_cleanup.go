package main

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
)

type ownedTransactionEntry struct {
	path string
	info os.FileInfo
}

// Retire only the exact transaction whose index publication has succeeded.
// Unknown entries and interrupted transactions are evidence, never garbage.
// There is deliberately no scan of .giv-go-tx and no recursive deletion.
func (r *DownloadRun) retireTransaction() error {
	if !tokenPattern.MatchString(r.Token) || r.s.stale(r.Snap) {
		return errors.New("transaction_owner_changed")
	}
	header, err := jailed(r.Snap.Root, filepath.Join("_state", ".giv-go-download.json"))
	if err != nil {
		return err
	}
	headerInfo, err := regular(header)
	if err != nil {
		return err
	}
	h, err := readJSON(header)
	if err != nil || requireKeys(h, "version", "runToken", "manifestSha256", "phase") != nil || num(h["version"]) != 1 || str(h["runToken"]) != r.Token || (str(h["phase"]) != "media" && str(h["phase"]) != "publishing") {
		return errors.New("transaction_header_changed")
	}
	mp, err := r.transactionPath("manifest.json")
	if err != nil {
		return err
	}
	manifestInfo, err := regular(mp)
	if err != nil {
		return err
	}
	b, err := os.ReadFile(mp)
	if err != nil || hash(b) != str(h["manifestSha256"]) {
		return errors.New("transaction_manifest_changed")
	}
	doc, err := decode(b)
	if err != nil || requireKeys(doc, "version", "runToken", "userId", "manifest") != nil || num(doc["version"]) != 1 || str(doc["runToken"]) != r.Token || str(doc["userId"]) != r.User {
		return errors.New("transaction_owner_changed")
	}
	m, err := validateManifest(obj(doc["manifest"]))
	if err != nil {
		return err
	}
	assets := map[string]Asset{}
	groups := map[string]bool{}
	conversations := map[string]bool{}
	for _, c := range m.Conversations {
		conversations[c.ID] = true
	}
	for _, a := range m.Assets {
		assets[a.ID] = a
		group := a.Conv
		if group == "" {
			group = a.RootConv
		}
		if !conversations[a.Conv] && conversations[a.RootConv] {
			group = a.RootConv
		}
		if group == "" {
			group = a.ID
		}
		groups[group] = true
	}
	txDir, err := r.transactionPath("")
	if err != nil {
		return err
	}
	txInfo, err := os.Lstat(txDir)
	if err != nil || !txInfo.IsDir() || reparse(txInfo) {
		return errors.New("unsafe_transaction_directory")
	}
	files := []ownedTransactionEntry{}
	dirs := []ownedTransactionEntry{}
	entries, err := os.ReadDir(txDir)
	if err != nil {
		return err
	}
	for _, entry := range entries {
		if entry.Name() == "manifest.json" {
			continue
		}
		if entry.Name() != "items" && entry.Name() != "layout" {
			return errors.New("unknown_transaction_entry")
		}
		dir, err := r.transactionPath(entry.Name())
		if err != nil {
			return err
		}
		info, err := os.Lstat(dir)
		if err != nil || !info.IsDir() || reparse(info) {
			return errors.New("unsafe_transaction_directory")
		}
		children, err := os.ReadDir(dir)
		if err != nil {
			return err
		}
		for _, child := range children {
			id := strings.TrimSuffix(child.Name(), ".json")
			if !stableID.MatchString(id) || child.Name() != id+".json" {
				return errors.New("unknown_transaction_entry")
			}
			path, err := jailed(dir, child.Name())
			if err != nil {
				return err
			}
			info, err := regular(path)
			if err != nil {
				return err
			}
			if entry.Name() == "layout" {
				plan, err := readJSON(path)
				if err != nil || requireKeys(plan, "version", "runToken", "userId", "row") != nil {
					return errors.New("invalid_transaction_layout")
				}
				row, _, err := r.layoutPlan(id)
				if err != nil || row == nil || !groups[id] {
					return errors.New("invalid_transaction_layout")
				}
			} else {
				rec, err := readJSON(path)
				a, ok := assets[id]
				state, tk := str(rec["state"]), str(rec["partToken"])
				if err != nil || requireKeys(rec, "assetId", "extension", "partToken", "bytes", "state", "hash") != nil || !ok || str(rec["assetId"]) != id || str(rec["extension"]) != assetExt(a) || !tokenPattern.MatchString(tk) || (state != "receiving" && state != "ready" && state != "committed" && state != "published") {
					return errors.New("invalid_transaction_item")
				}
				if state != "receiving" && (num(rec["bytes"]) <= 0 || len(str(rec["hash"])) != 64) {
					return errors.New("invalid_transaction_item")
				}
				part, _, err := r.part(a, tk)
				if err != nil {
					return err
				}
				if _, err = os.Lstat(part); !os.IsNotExist(err) {
					return errors.New("transaction_part_pending")
				}
			}
			files = append(files, ownedTransactionEntry{path, info})
		}
		dirs = append(dirs, ownedTransactionEntry{dir, info})
	}
	// Preflight completes before any deletion. Recheck identity immediately before
	// each unlink; a failed/uncertain header removal leaves transaction evidence.
	remove := func(entry ownedTransactionEntry) error {
		rel, err := filepath.Rel(r.Snap.Root, entry.path)
		if err != nil {
			return err
		}
		path, err := jailed(r.Snap.Root, rel)
		if err != nil {
			return err
		}
		current, err := os.Lstat(path)
		if err != nil || reparse(current) || !os.SameFile(current, entry.info) {
			return errors.New("transaction_entry_changed")
		}
		return os.Remove(path)
	}
	if err = remove(ownedTransactionEntry{header, headerInfo}); err != nil {
		return err
	}
	if _, err = os.Lstat(header); !os.IsNotExist(err) {
		return errors.New("transaction_header_uncertain")
	}
	for _, file := range files {
		if err = remove(file); err != nil {
			return err
		}
	}
	for _, dir := range dirs {
		if err = remove(dir); err != nil {
			return err
		}
	}
	if err = remove(ownedTransactionEntry{mp, manifestInfo}); err != nil {
		return err
	}
	return remove(ownedTransactionEntry{txDir, txInfo})
}
