package main

// Application-private task history. Media, account bindings and recovery journals
// remain in their existing gallery format; this database is not their authority.
import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"time"

	_ "modernc.org/sqlite"
)

type History struct {
	db        *sql.DB
	lease     *Lease
	once      sync.Once
	dir       string
	pendingMu sync.Mutex
	pending   map[string]pendingHistory
	cursorKey []byte
}

func openHistory(configPath string) (*History, error) {
	dir := filepath.Join(filepath.Dir(configPath), "stack-evo-state")
	if err := os.MkdirAll(dir, 0700); err != nil {
		return nil, err
	}
	if info, err := os.Lstat(dir); err != nil || !info.IsDir() || reparse(info) {
		return nil, errors.New("unsafe history directory")
	}
	lease, err := acquireLease(dir, ".owner.lock")
	if err != nil {
		return nil, err
	}
	path := filepath.Join(dir, "history.sqlite")
	for _, suffix := range []string{"", "-wal", "-shm", "-journal"} {
		if info, err := os.Lstat(path + suffix); err == nil {
			if !info.Mode().IsRegular() || reparse(info) {
				lease.Close()
				return nil, errors.New("unsafe history file")
			}
		} else if !os.IsNotExist(err) {
			lease.Close()
			return nil, err
		}
	}
	db, err := sql.Open("sqlite", path)
	if err != nil {
		lease.Close()
		return nil, err
	}
	h := &History{db: db, lease: lease, dir: dir, pending: map[string]pendingHistory{}, cursorKey: []byte(token())}
	db.SetMaxOpenConns(1)
	db.SetMaxIdleConns(1)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if _, err = db.ExecContext(ctx, "PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;"); err == nil {
		err = h.migrate(ctx)
	}
	if err == nil {
		_, err = db.ExecContext(ctx, "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;")
	}
	if err == nil {
		_, err = db.ExecContext(ctx, "CREATE INDEX IF NOT EXISTS runs_root_history_page ON runs(root,started_at_ns DESC,id DESC)")
	}
	if err == nil {
		h.Reconcile()
		_, err = db.ExecContext(ctx, "UPDATE runs SET phase='interrupted', finished_at=?, code='process_interrupted' WHERE phase='running'", time.Now().UTC().Format(time.RFC3339Nano))
	}
	if err != nil {
		h.Close()
		return nil, fmt.Errorf("task history unavailable; original database retained: %w", err)
	}
	return h, nil
}

func (h *History) migrate(ctx context.Context) error {
	tx, err := h.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	var version int
	if err = tx.QueryRowContext(ctx, "PRAGMA user_version").Scan(&version); err != nil {
		return err
	}
	if version > 3 {
		return errors.New("unsupported history schema")
	}
	if version == 0 {
		_, err = tx.ExecContext(ctx, `CREATE TABLE runs (
          id TEXT PRIMARY KEY, run_id INTEGER NOT NULL, root TEXT NOT NULL,
          started_at TEXT NOT NULL, finished_at TEXT NOT NULL DEFAULT '',
          phase TEXT NOT NULL, code TEXT NOT NULL DEFAULT '', published INTEGER NOT NULL DEFAULT 0,
          counts TEXT NOT NULL DEFAULT '{}', failures TEXT NOT NULL DEFAULT '[]',
          retry_of TEXT NOT NULL DEFAULT '');
          CREATE INDEX runs_root_started ON runs(root, started_at DESC);
          PRAGMA user_version=2;`)
		if err != nil {
			return err
		}
	} else if version == 1 {
		if _, err = tx.ExecContext(ctx, "ALTER TABLE runs ADD COLUMN retry_of TEXT NOT NULL DEFAULT ''; PRAGMA user_version=2;"); err != nil {
			return err
		}
	}
	if version < 3 {
		if _, err = tx.ExecContext(ctx, "ALTER TABLE runs ADD COLUMN started_at_ns INTEGER NOT NULL DEFAULT 0;"); err != nil {
			return err
		}
		rows, err := tx.QueryContext(ctx, "SELECT id, started_at FROM runs")
		if err != nil {
			return err
		}
		type stamp struct {
			id string
			ns int64
		}
		stamps := []stamp{}
		for rows.Next() {
			var id, value string
			if err = rows.Scan(&id, &value); err != nil {
				rows.Close()
				return err
			}
			parsed, parseErr := time.Parse(time.RFC3339Nano, value)
			if parseErr != nil || !parsed.Equal(time.Unix(0, parsed.UnixNano())) {
				rows.Close()
				return errors.New("invalid history timestamp; migration rolled back")
			}
			stamps = append(stamps, stamp{id, parsed.UnixNano()})
		}
		err = rows.Err()
		rows.Close()
		if err != nil {
			return err
		}
		for _, value := range stamps {
			if _, err = tx.ExecContext(ctx, "UPDATE runs SET started_at_ns=? WHERE id=?", value.ns, value.id); err != nil {
				return err
			}
		}
		if _, err = tx.ExecContext(ctx, "DROP INDEX IF EXISTS runs_root_started; CREATE INDEX runs_root_started_ns ON runs(root, started_at_ns DESC); PRAGMA user_version=3;"); err != nil {
			return err
		}
	}
	return tx.Commit()
}
func (h *History) Close() {
	if h != nil {
		h.once.Do(func() { h.db.Close(); h.lease.Close() })
	}
}
func (h *History) Start(id string, runID uint64, root string, retryOf ...string) error {
	h.Reconcile()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	parent := ""
	if len(retryOf) > 0 {
		parent = retryOf[0]
	}
	now := time.Now().UTC()
	_, err := h.db.ExecContext(ctx, "INSERT INTO runs(id, run_id, root, started_at, started_at_ns, phase, retry_of) VALUES(?,?,?,?,?, 'running', ?)", id, runID, root, now.Format(time.RFC3339Nano), now.UnixNano(), parent)
	return err
}
func (h *History) Finish(id string, result Obj) error {
	phase := "failed"
	if yes(result["stopped"]) {
		phase = "cancelled"
	} else if yes(result["ok"]) {
		phase = "succeeded"
	} else if yes(result["published"]) {
		phase = "partial"
	}
	counts, err := json.Marshal(result["counts"])
	if err != nil {
		return err
	}
	failures, err := json.Marshal(result["failures"])
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	finished := str(result["finishedAt"])
	if finished == "" {
		finished = time.Now().UTC().Format(time.RFC3339Nano)
	}
	_, err = h.db.ExecContext(ctx, "UPDATE runs SET phase=?, finished_at=?, code=?, published=?, counts=?, failures=? WHERE id=?", phase, finished, str(result["code"]), yes(result["published"]), string(counts), string(failures), id)
	return err
}

func (h *History) ValidateRetry(root, historyID string, assetIDs []string) error {
	if h == nil {
		return fail("history_unavailable", "任务历史数据库不可用。", 503)
	}
	if historyID == "" || len(assetIDs) == 0 || len(assetIDs) > 200 {
		return fail("invalid_retry", "重试记录或素材列表无效。", 400)
	}
	requested := make(map[string]struct{}, len(assetIDs))
	for _, id := range assetIDs {
		if !stableID.MatchString(id) {
			return fail("invalid_retry", "重试素材标识无效。", 400)
		}
		if _, exists := requested[id]; exists {
			return fail("invalid_retry", "重试素材列表包含重复项目。", 400)
		}
		requested[id] = struct{}{}
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	var phase, rawFailures string
	err := h.db.QueryRowContext(ctx, "SELECT phase, failures FROM runs WHERE id=? AND root=?", historyID, root).Scan(&phase, &rawFailures)
	if errors.Is(err, sql.ErrNoRows) {
		return fail("retry_history_not_found", "找不到当前图库中的原始下载记录。", 404)
	}
	if err != nil {
		return err
	}
	switch phase {
	case "partial", "failed", "cancelled", "interrupted":
	default:
		return fail("retry_not_allowed", "该下载记录当前没有可重试状态。", 409)
	}
	var failures []any
	if err = json.Unmarshal([]byte(rawFailures), &failures); err != nil {
		return fail("history_corrupt", "下载历史失败明细损坏。", 409)
	}
	allowed := make(map[string]struct{}, len(failures))
	for _, value := range failures {
		item := obj(value)
		id := str(item["assetId"])
		if yes(item["retryable"]) && stableID.MatchString(id) {
			allowed[id] = struct{}{}
		}
	}
	for id := range requested {
		if _, ok := allowed[id]; !ok {
			return fail("retry_not_allowed", "所选素材不属于该记录的可重试失败项目。", 409)
		}
	}
	return nil
}

func (h *History) List(root string, limit int) (Obj, error) { return h.ListPage(root, limit, "") }
func (h *History) ListPage(root string, limit int, cursor string) (Obj, error) {
	h.Reconcile()
	if limit < 1 || limit > 200 {
		limit = 50
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	page, err := h.historyPage(ctx, root, cursor)
	if err != nil {
		return nil, err
	}
	query := "SELECT id,run_id,started_at,finished_at,phase,code,published,counts,failures,retry_of,started_at_ns FROM runs WHERE root=? AND rowid<=?"
	args := []any{root, page.Snapshot}
	if cursor != "" {
		query += " AND (started_at_ns<? OR (started_at_ns=? AND id<?))"
		args = append(args, page.BeforeNS, page.BeforeNS, page.BeforeID)
	}
	query += " ORDER BY started_at_ns DESC,id DESC LIMIT ?"
	args = append(args, limit+1)
	rows, err := h.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := []any{}
	more := false
	for rows.Next() {
		if len(items) == limit {
			more = true
			break
		}
		var id, started, finished, phase, code, counts, failures, retryOf string
		var runID uint64
		var published bool
		var startedNS int64
		if err = rows.Scan(&id, &runID, &started, &finished, &phase, &code, &published, &counts, &failures, &retryOf, &startedNS); err != nil {
			return nil, err
		}
		var c Obj
		var f []any
		if err = json.Unmarshal([]byte(counts), &c); err != nil {
			return nil, err
		}
		if err = json.Unmarshal([]byte(failures), &f); err != nil {
			return nil, err
		}
		if c == nil {
			c = Obj{}
		}
		if f == nil {
			f = []any{}
		}
		items = append(items, Obj{"id": id, "runId": runID, "startedAt": started, "finishedAt": finished, "phase": phase, "code": code, "published": published, "counts": c, "failures": f, "retryOf": retryOf})
		page.BeforeNS, page.BeforeID = startedNS, id
	}
	next := ""
	if more {
		next = h.encodeHistoryPage(page)
	}
	return Obj{"ok": true, "root": root, "items": items, "schemaVersion": 3, "nextCursor": next}, rows.Err()
}
