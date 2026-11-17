package main

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"time"
)

type pendingHistory struct {
	ID, Root string
	Result   Obj
}

func (h *History) pendingPath(id string) (string, error) {
	if !stableID.MatchString(id) {
		return "", errors.New("invalid_history_id")
	}
	return jailed(h.dir, filepath.Join("pending", id+".json"))
}

// A durable outcome checkpoint is independent of SQLite's write lock. Retrying
// history never schedules media transfers and preserves the original end time.
func (h *History) Complete(id, root string, result Obj) string {
	h.pendingMu.Lock()
	defer h.pendingMu.Unlock()
	canonical, _ := decode(mustJSON(result))
	entry := pendingHistory{id, root, canonical}
	h.pending[id] = entry
	path, pathErr := h.pendingPath(id)
	saved := pathErr == nil && atomicJSON(path, Obj{"version": 1, "id": id, "root": root, "result": entry.Result}) == nil
	if err := h.Finish(id, result); err == nil {
		delete(h.pending, id)
		if saved {
			h.removePending(id, root)
		}
		return "persisted"
	}
	if saved {
		return "pending"
	}
	return "unavailable"
}

func (h *History) removePending(id, root string) {
	path, err := h.pendingPath(id)
	if err != nil {
		return
	}
	rec, err := readJSON(path)
	if err != nil || str(rec["id"]) != id || str(rec["root"]) != root {
		return
	}
	if _, err = regular(path); err == nil {
		_ = os.Remove(path)
	}
}

func (h *History) Reconcile() {
	h.pendingMu.Lock()
	defer h.pendingMu.Unlock()
	dir, err := jailed(h.dir, "pending")
	if err != nil {
		return
	}
	entries, err := os.ReadDir(dir)
	if err != nil && !os.IsNotExist(err) {
		return
	}
	for _, entry := range entries {
		if len(h.pending) >= 32 {
			break
		}
		if entry.IsDir() || filepath.Ext(entry.Name()) != ".json" {
			continue
		}
		path, err := jailed(dir, entry.Name())
		if err != nil {
			continue
		}
		rec, err := readJSON(path)
		id := str(rec["id"])
		if err != nil || requireKeys(rec, "version", "id", "root", "result") != nil || num(rec["version"]) != 1 || !stableID.MatchString(id) || entry.Name() != id+".json" || validateDownloadResult(obj(rec["result"])) != nil {
			continue
		}
		if _, exists := h.pending[id]; !exists {
			h.pending[id] = pendingHistory{id, str(rec["root"]), obj(rec["result"])}
		}
	}
	deadline := time.Now().Add(350 * time.Millisecond)
	for id, entry := range h.pending {
		if time.Now().After(deadline) {
			break
		}
		ctx, cancel := context.WithDeadline(context.Background(), deadline)
		var root string
		err := h.db.QueryRowContext(ctx, "SELECT root FROM runs WHERE id=?", id).Scan(&root)
		if err == nil && root == entry.Root {
			// The connection busy timeout is interruptible by this bounded context.
			result := entry.Result
			phase := "failed"
			if yes(result["stopped"]) {
				phase = "cancelled"
			} else if yes(result["ok"]) {
				phase = "succeeded"
			} else if yes(result["published"]) {
				phase = "partial"
			}
			_, err = h.db.ExecContext(ctx, "UPDATE runs SET phase=?,finished_at=?,code=?,published=?,counts=?,failures=? WHERE id=? AND root=?", phase, str(result["finishedAt"]), str(result["code"]), yes(result["published"]), string(mustJSON(result["counts"])), string(mustJSON(result["failures"])), id, root)
			if err == nil {
				delete(h.pending, id)
				h.removePending(id, root)
			}
		}
		cancel()
	}
}
