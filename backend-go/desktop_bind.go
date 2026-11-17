package main

import (
	"path/filepath"
	"strings"
)

// bindDownloadAccount implements the native Rust desktop's preflight/commit
// contract. It does not start a Go download or imply that the legacy Rust
// transfer coordinator has migrated. Both coordinators share the same locks
// and authoritative metadata; the renderer is never allowed to bind accounts.
func (s *Server) bindDownloadAccount(p Obj) (Obj, error) {
	root, rootOK := p["expectedRoot"].(string)
	user, userOK := p["grokUserId"].(string)
	if !rootOK || !filepath.IsAbs(root) || strings.TrimSpace(root) != root || root == "" {
		return nil, fail("invalid_root", "预期图库路径无效。", 400)
	}
	if !userOK || !stableID.MatchString(user) {
		return nil, fail("invalid_account", "Grok 账号标识无效。", 400)
	}
	commit := true // Preserve the original API's default; Rust always supplies it.
	if value, present := p["commit"]; present {
		var ok bool
		commit, ok = value.(bool)
		if !ok {
			return nil, fail("invalid_commit", "commit 必须是布尔值。", 400)
		}
	}
	return s.withWrite(p, true, func(snap Snapshot) (Obj, error) {
		if snap.Mode != "index" {
			return nil, fail("unsupported_mode", "下载只支持带 _index.json 的完整图库。", 409)
		}
		meta, err := loadMeta(snap.Root)
		if err != nil {
			return nil, err
		}
		bound := str(meta["grokUserId"])
		// An unrecognized stored identity must not be silently treated as unbound.
		if value := meta["grokUserId"]; value != nil {
			if _, ok := value.(string); !ok || bound != "" && !stableID.MatchString(bound) {
				return nil, fail("store_corrupt", "图库账号记录无效，原文件已保留。", 409)
			}
		}
		if bound != "" && bound != user {
			return nil, &APIError{"account_mismatch", "当前登录账号与这个图库不一致。", 409, Obj{"mismatch": true}}
		}
		if bound == "" && !commit {
			return Obj{"ok": true, "root": snap.Root, "bound": false}, nil
		}
		if bound == "" {
			if num(meta["revision"]) >= 1<<53-1 {
				return nil, fail("revision_exhausted", "元数据版本已达上限，原文件已保留。", 409)
			}
			meta["grokUserId"] = user
			meta["revision"] = num(meta["revision"]) + 1
			if err = atomicJSON(filepath.Join(snap.Root, ".viewer-meta.json"), meta); err != nil {
				return nil, err
			}
			s.invalidate()
		}
		return Obj{"ok": true, "root": snap.Root, "bound": true}, nil
	})
}

// Only an explicit startup root bypasses the launcher. Saved root/history are
// recent locations, not an active selection for this process; leave them intact
// until the user chooses a gallery. Explicit errors must never fall back.
func (s *Server) restoreSelectedRoot() error {
	root := s.boot.Root
	if root == "" {
		return nil
	}
	_, err := s.activateRoot(root, true, false)
	return err
}
