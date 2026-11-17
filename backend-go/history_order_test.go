package main

import (
	"database/sql"
	"os"
	"path/filepath"
	"testing"
)

func legacyHistoryV2(t *testing.T, stamps []string) string {
	t.Helper()
	cfg := filepath.Join(t.TempDir(), "app.json")
	dir := filepath.Join(filepath.Dir(cfg), "stack-evo-state")
	if err := os.MkdirAll(dir, 0700); err != nil {
		t.Fatal(err)
	}
	db, err := sql.Open("sqlite", filepath.Join(dir, "history.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	_, err = db.Exec(`CREATE TABLE runs(id TEXT PRIMARY KEY,run_id INTEGER NOT NULL,root TEXT NOT NULL,started_at TEXT NOT NULL,finished_at TEXT NOT NULL DEFAULT '',phase TEXT NOT NULL,code TEXT NOT NULL DEFAULT '',published INTEGER NOT NULL DEFAULT 0,counts TEXT NOT NULL DEFAULT '{}',failures TEXT NOT NULL DEFAULT '[]',retry_of TEXT NOT NULL DEFAULT ''); CREATE INDEX runs_root_started ON runs(root,started_at DESC); PRAGMA user_version=2;`)
	if err != nil {
		t.Fatal(err)
	}
	for i, stamp := range stamps {
		if _, err = db.Exec("INSERT INTO runs(id,run_id,root,started_at,phase,retry_of) VALUES(?,?,?,?,?,?)", string(rune('a'+i)), i+1, "root-A", stamp, "failed", "parent"); err != nil {
			t.Fatal(err)
		}
	}
	return cfg
}

func TestHistoryV2MigrationSortsNanosecondsAndStableTies(t *testing.T) {
	cfg := legacyHistoryV2(t, []string{"2026-11-10T00:00:00Z", "2026-11-10T00:00:00.1Z", "2026-11-10T00:00:00.11Z", "2026-11-10T00:00:00.110000000Z", "2026-11-10T01:00:00.109999999+01:00"})
	h, err := openHistory(cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer h.Close()
	out, err := h.List("root-A", 50)
	if err != nil {
		t.Fatal(err)
	}
	items := rows(out["items"])
	if len(items) != 5 || num(out["schemaVersion"]) != 3 {
		t.Fatal(out)
	}
	for i, id := range []string{"d", "c", "e", "b", "a"} {
		if str(items[i]["id"]) != id || str(items[i]["retryOf"]) != "parent" {
			t.Fatal("incorrect chronological/tie order or lineage", items)
		}
	}
	var ns int64
	if err = h.db.QueryRow("SELECT started_at_ns FROM runs WHERE id='e'").Scan(&ns); err != nil || ns%1_000_000_000 != 109999999 {
		t.Fatal("timestamp precision lost", ns, err)
	}
	var integrity string
	if err = h.db.QueryRow("PRAGMA integrity_check").Scan(&integrity); err != nil || integrity != "ok" {
		t.Fatal(integrity, err)
	}
}

func TestHistoryBadLegacyTimestampRollsBackWithoutRebuilding(t *testing.T) {
	for _, stamp := range []string{"not-a-time", "2500-01-01T00:00:00Z"} {
		t.Run(stamp, func(t *testing.T) {
			cfg := legacyHistoryV2(t, []string{stamp})
			if h, err := openHistory(cfg); err == nil {
				h.Close()
				t.Fatal("unsafe timestamp migrated")
			}
			db, err := sql.Open("sqlite", filepath.Join(filepath.Dir(cfg), "stack-evo-state", "history.sqlite"))
			if err != nil {
				t.Fatal(err)
			}
			defer db.Close()
			var version, count int
			var retained string
			if err = db.QueryRow("PRAGMA user_version").Scan(&version); err != nil || version != 2 {
				t.Fatal("migration was not rolled back", version, err)
			}
			if err = db.QueryRow("SELECT COUNT(*),started_at FROM runs").Scan(&count, &retained); err != nil || count != 1 || retained != stamp {
				t.Fatal("legacy history lost", count, retained, err)
			}
			if _, err = db.Exec("SELECT started_at_ns FROM runs"); err == nil {
				t.Fatal("partial schema migration retained")
			}
		})
	}
}
