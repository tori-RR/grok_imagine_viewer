package main

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"
)

type configStoreMutation struct {
	name string
	run  func(*Server) error
}

func configStoreMutations(remove, next string) []configStoreMutation {
	return []configStoreMutation{
		{"preferences", func(s *Server) error { _, err := s.savePreferences(Obj{"wheelVolumeStep": 7}); return err }},
		{"patch", func(s *Server) error { return s.configPatch(Obj{"accel": "compat"}) }},
		{"volume", func(s *Server) error { _, err := s.saveVolume(Obj{"level": 23, "muted": true}); return err }},
		{"remember", func(s *Server) error { return s.rememberRoot(next) }},
		{"history-remove", func(s *Server) error { _, err := s.editHistory(Obj{"path": remove}, false); return err }},
		{"history-clear", func(s *Server) error { _, err := s.editHistory(Obj{}, true); return err }},
	}
}

func configStoreCache(s *Server) []byte {
	s.cfgMu.Lock()
	defer s.cfgMu.Unlock()
	return append([]byte(nil), mustJSON(s.cfg)...)
}

func configStoreStatus(t *testing.T, err error, want int) {
	t.Helper()
	var api *APIError
	if !errors.As(err, &api) || api.Status != want {
		t.Fatalf("configuration write status: got %v, want API status %d", err, want)
	}
}

func configStoreUnchanged(t *testing.T, s *Server, disk, cached []byte) {
	t.Helper()
	after, err := os.ReadFile(s.boot.Config)
	if err != nil || !bytes.Equal(after, disk) {
		t.Fatalf("rejected write changed original configuration: %v", err)
	}
	if !bytes.Equal(configStoreCache(s), cached) {
		t.Fatal("rejected write changed last valid in-memory configuration")
	}
}

func TestConfigStoreExternalUpdatesPreservedByAllWriters(t *testing.T) {
	for n := range configStoreMutations("", "") {
		t.Run(configStoreMutations("", "")[n].name, func(t *testing.T) {
			s, root := fixture(t)
			other, next := t.TempDir(), t.TempDir()
			if err := s.configPatch(Obj{"externalChanged": "old"}); err != nil {
				t.Fatal(err)
			}
			external := Obj{
				"root": other, "history": []any{root, other}, "accel": "auto",
				"externalChanged": "external-update", "externalOnly": Obj{"nested": []any{"retain", 4}},
				"preferences": Obj{"version": 1, "language": "en", "wheelVolumeStep": 3, "externalPreference": Obj{"keep": true}, "shortcuts": Obj{"futureAction": Obj{"opaque": []any{"not-a-keybinding", 9}}}},
				"volume":      Obj{"level": 84, "muted": false, "externalVolume": Obj{"keep": true}},
			}
			jsonFixture(t, s.boot.Config, external)
			mutation := configStoreMutations(root, next)[n]
			if err := mutation.run(s); err != nil {
				t.Fatal(err)
			}
			got, err := readJSON(s.boot.Config)
			if err != nil {
				t.Fatal(err)
			}
			if str(got["externalChanged"]) != "external-update" || !equalJSON(got["externalOnly"], external["externalOnly"]) || !equalJSON(obj(got["preferences"])["externalPreference"], obj(external["preferences"])["externalPreference"]) {
				t.Fatal("write lost external changes or unknown fields", got)
			}
			if str(obj(got["preferences"])["language"]) != "en" {
				t.Fatal("write rolled back a newer preference", got)
			}
			if !equalJSON(obj(obj(got["preferences"])["shortcuts"])["futureAction"], obj(obj(external["preferences"])["shortcuts"])["futureAction"]) {
				t.Fatal("write lost an unknown shortcut field", got)
			}
			knownPreferences := obj(s.preferencesResponse()["preferences"])
			if _, exposed := obj(knownPreferences["shortcuts"])["futureAction"]; exposed {
				t.Fatal("unknown stored shortcut was exposed as a supported action")
			}
			wantStep := int64(3)
			if mutation.name == "preferences" {
				wantStep = 7
			}
			if num(obj(got["preferences"])["wheelVolumeStep"]) != wantStep {
				t.Fatal("write changed an unrelated preference", got)
			}
			if mutation.name == "volume" {
				if num(obj(got["volume"])["level"]) != 23 || !yes(obj(got["volume"])["muted"]) {
					t.Fatal("volume patch was not applied", got)
				}
				if !equalJSON(obj(got["volume"])["externalVolume"], obj(external["volume"])["externalVolume"]) {
					t.Fatal("volume patch lost an external unknown field", got)
				}
			} else if !equalJSON(got["volume"], external["volume"]) {
				t.Fatal("write rolled back newer volume", got)
			}
			wantRoot, wantHistory := other, []any{root, other}
			switch mutation.name {
			case "remember":
				wantRoot, wantHistory = next, []any{next, root, other}
			case "history-remove":
				wantHistory = []any{other}
			case "history-clear":
				wantRoot, wantHistory = "", []any{}
			}
			if str(got["root"]) != wantRoot || !equalJSON(got["history"], wantHistory) {
				t.Fatal("write lost or unexpectedly changed recent locations", got)
			}
			wantAccel := "auto"
			if mutation.name == "patch" {
				wantAccel = "compat"
			}
			if str(got["accel"]) != wantAccel || !bytes.Equal(configStoreCache(s), mustJSON(got)) {
				t.Fatal("successful write did not publish the complete merged snapshot", got)
			}
		})
	}
}

func TestConfigStoreInvalidDiskPreservedByAllWriters(t *testing.T) {
	invalid := []struct{ name, raw string }{
		{"broken-json", "{broken"}, {"top-array", "[]"}, {"top-null", "null"},
		{"root-type", `{"root":42}`}, {"history-type", `{"history":{}}`}, {"history-member", `{"history":[42]}`},
		{"preferences-null", `{"preferences":null}`}, {"preferences-array", `{"preferences":[]}`},
		{"shortcuts-array", `{"preferences":{"shortcuts":[]}}`}, {"language-type", `{"preferences":{"language":4}}`},
		{"volume-null", `{"volume":null}`}, {"volume-array", `{"volume":[]}`},
		{"future-preferences", `{"preferences":{"version":2,"futureOnly":"retain"},"externalOnly":"keep"}`},
	}
	for _, bad := range invalid {
		for n := range configStoreMutations("", "") {
			t.Run(bad.name+"/"+configStoreMutations("", "")[n].name, func(t *testing.T) {
				s, root := fixture(t)
				cached := configStoreCache(s)
				writeFixture(t, s.boot.Config, []byte(bad.raw))
				err := configStoreMutations(root, t.TempDir())[n].run(s)
				configStoreStatus(t, err, 409)
				configStoreUnchanged(t, s, []byte(bad.raw), cached)
			})
		}
	}
}

func TestConfigStoreExistingFileRemovalDoesNotRecreateDefaults(t *testing.T) {
	for n := range configStoreMutations("", "") {
		t.Run(configStoreMutations("", "")[n].name, func(t *testing.T) {
			s, root := fixture(t)
			cached := configStoreCache(s)
			if err := os.Remove(s.boot.Config); err != nil {
				t.Fatal(err)
			}
			configStoreStatus(t, configStoreMutations(root, t.TempDir())[n].run(s), 503)
			if _, err := os.Lstat(s.boot.Config); !os.IsNotExist(err) || !bytes.Equal(configStoreCache(s), cached) {
				t.Fatal("removed configuration was silently recreated or cache changed", err)
			}
		})
	}
}

func TestConfigStoreLeaseBlocksAllWritersAndRemainsPermanent(t *testing.T) {
	s, root := fixture(t)
	lockName := filepath.Base(s.boot.Config) + ".lock"
	lease, err := acquireLease(filepath.Dir(s.boot.Config), lockName)
	if err != nil {
		t.Fatal(err)
	}
	lockPath := filepath.Join(filepath.Dir(s.boot.Config), lockName)
	beforeLock, err := os.Stat(lockPath)
	if err != nil {
		lease.Close()
		t.Fatal(err)
	}
	disk, _ := os.ReadFile(s.boot.Config)
	cached := configStoreCache(s)
	for _, mutation := range configStoreMutations(root, t.TempDir()) {
		t.Run(mutation.name, func(t *testing.T) {
			configStoreStatus(t, mutation.run(s), 423)
			configStoreUnchanged(t, s, disk, cached)
		})
	}
	lease.Close()
	if err := s.configPatch(Obj{"afterLease": "success"}); err != nil {
		t.Fatal(err)
	}
	afterLock, err := os.Stat(lockPath)
	if err != nil || !os.SameFile(beforeLock, afterLock) {
		t.Fatal("configuration lock was removed or replaced", err)
	}
}

func configStoreSecondServer(t *testing.T, first *Server) *Server {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	second, err := NewServer(ctx, first.boot)
	if err != nil {
		cancel()
		t.Fatal(err)
	}
	t.Cleanup(func() { cancel(); second.close() })
	return second
}

func TestConfigStoreIndependentServersMergeAndKeepDefaultLauncher(t *testing.T) {
	first, _ := fixture(t)
	second := configStoreSecondServer(t, first)
	before, _ := os.ReadFile(first.boot.Config)
	if err := second.restoreSelectedRoot(); err != nil || second.snapshot().Root != "" {
		t.Fatal("loading shared config selected a saved gallery", err)
	}
	after, _ := os.ReadFile(first.boot.Config)
	if !bytes.Equal(before, after) {
		t.Fatal("default startup changed recent locations")
	}
	if err := first.configPatch(Obj{"fromFirst": 1}); err != nil {
		t.Fatal(err)
	}
	if err := second.configPatch(Obj{"fromSecond": 2}); err != nil {
		t.Fatal(err)
	}
	if err := first.configPatch(Obj{"fromFirstAgain": 3}); err != nil {
		t.Fatal(err)
	}
	got, err := readJSON(first.boot.Config)
	if err != nil || num(got["fromFirst"]) != 1 || num(got["fromSecond"]) != 2 || num(got["fromFirstAgain"]) != 3 {
		t.Fatal("independent server snapshot lost another writer's fields", got, err)
	}
}

func TestConfigStoreConcurrentServersRetainEverySuccessfulPatch(t *testing.T) {
	first, _ := fixture(t)
	second := configStoreSecondServer(t, first)
	start := make(chan struct{})
	results := make(chan error, 2)
	var workers sync.WaitGroup
	for n, server := range []*Server{first, second} {
		workers.Add(1)
		go func(n int, server *Server) {
			defer workers.Done()
			<-start
			for item := 0; item < 8; item++ {
				key := fmt.Sprintf("writer-%d-item-%d", n, item)
				deadline := time.Now().Add(5 * time.Second)
				for {
					err := server.configPatch(Obj{key: item + 1})
					if err == nil {
						break
					}
					var api *APIError
					if !errors.As(err, &api) || api.Status != 423 || time.Now().After(deadline) {
						results <- fmt.Errorf("%s: %w", key, err)
						return
					}
					time.Sleep(time.Millisecond)
				}
			}
			results <- nil
		}(n, server)
	}
	close(start)
	workers.Wait()
	close(results)
	for err := range results {
		if err != nil {
			t.Fatal(err)
		}
	}
	got, err := readJSON(first.boot.Config)
	if err != nil {
		t.Fatal(err)
	}
	for writer := 0; writer < 2; writer++ {
		for item := 0; item < 8; item++ {
			key := fmt.Sprintf("writer-%d-item-%d", writer, item)
			if num(got[key]) != int64(item+1) {
				t.Fatalf("successful concurrent patch lost: %s", key)
			}
		}
	}
}

func TestConfigStorePermissionFailurePreservesDiskAndCache(t *testing.T) {
	s, _ := fixture(t)
	disk, _ := os.ReadFile(s.boot.Config)
	cached := configStoreCache(s)
	path, mode, restore := s.boot.Config, os.FileMode(0444), os.FileMode(0644)
	if runtime.GOOS != "windows" {
		path, mode, restore = filepath.Dir(s.boot.Config), 0500, 0700
	}
	if err := os.Chmod(path, mode); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(path, restore) })
	if runtime.GOOS != "windows" {
		probe := filepath.Join(path, "permission-probe")
		if err := os.WriteFile(probe, nil, 0600); err == nil {
			_ = os.Remove(probe)
			t.Skip("privileged process bypasses directory permission fixture")
		}
	}
	configStoreStatus(t, s.configPatch(Obj{"mustNotPersist": true}), 503)
	configStoreUnchanged(t, s, disk, cached)
}

func TestConfigStoreRejectsReparseConfigurationWithoutChangingTarget(t *testing.T) {
	s, _ := fixture(t)
	cached := configStoreCache(s)
	out := filepath.Join(t.TempDir(), "external-config.json")
	original := []byte(`{"externalOnly":"never-overwrite"}`)
	writeFixture(t, out, original)
	if err := os.Rename(s.boot.Config, s.boot.Config+".fixture-backup"); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(out, s.boot.Config); err != nil {
		t.Skipf("symlink unavailable in fixture environment: %v", err)
	}
	configStoreStatus(t, s.configPatch(Obj{"mustNotPersist": true}), 503)
	after, err := os.ReadFile(out)
	info, statErr := os.Lstat(s.boot.Config)
	if err != nil || !bytes.Equal(after, original) || statErr != nil || info.Mode()&os.ModeSymlink == 0 || !bytes.Equal(configStoreCache(s), cached) {
		t.Fatal("reparse target/link/cache was changed", err, statErr)
	}
}

func TestConfigStoreRejectsReparseLeaseWithoutChangingTarget(t *testing.T) {
	s, _ := fixture(t)
	cached := configStoreCache(s)
	// Use a new test-owned config location rather than replace the existing
	// permanent lease that was already created by the fixture's valid writes.
	dir := t.TempDir()
	s.boot.Config = filepath.Join(dir, "separate-config.json")
	before := append(append([]byte(nil), cached...), '\n')
	writeFixture(t, s.boot.Config, before)
	outside := filepath.Join(t.TempDir(), "outside-lock")
	outsideBytes := []byte("must-not-open-or-replace")
	writeFixture(t, outside, outsideBytes)
	if err := os.Symlink(outside, s.boot.Config+".lock"); err != nil {
		t.Skipf("symlink unavailable in fixture environment: %v", err)
	}
	configStoreStatus(t, s.configPatch(Obj{"mustNotPersist": true}), 503)
	configStoreUnchanged(t, s, before, cached)
	after, err := os.ReadFile(outside)
	if err != nil || !bytes.Equal(after, outsideBytes) {
		t.Fatal("unsafe lease path changed its target", err)
	}
}

func TestConfigStoreObservedExternalEditReturnsConflict(t *testing.T) {
	for _, replaceIdentity := range []bool{false, true} {
		t.Run(fmt.Sprint("replace-identity-", replaceIdentity), func(t *testing.T) {
			s, _ := fixture(t)
			if err := s.configPatch(Obj{"externalState": "old"}); err != nil {
				t.Fatal(err)
			}
			before, err := os.ReadFile(s.boot.Config)
			if err != nil {
				t.Fatal(err)
			}
			cached := configStoreCache(s)
			originalInfo, err := os.Stat(s.boot.Config)
			if err != nil {
				t.Fatal(err)
			}
			external := append([]byte(nil), before...)
			if !replaceIdentity {
				external = bytes.Replace(before, []byte(`"old"`), []byte(`"new"`), 1)
				if bytes.Equal(external, before) || len(external) != len(before) {
					t.Fatal("external editor fixture must change bytes without changing length")
				}
			}
			_, err = s.updateAppConfig(func(doc Obj) (Obj, error) {
				doc["mustNotPersist"] = true
				if replaceIdentity {
					file, createErr := os.CreateTemp(filepath.Dir(s.boot.Config), ".external-editor-*.json")
					if createErr != nil {
						return nil, createErr
					}
					name := file.Name()
					defer os.Remove(name)
					if _, createErr = file.Write(external); createErr != nil {
						file.Close()
						return nil, createErr
					}
					if createErr = file.Close(); createErr != nil {
						return nil, createErr
					}
					if createErr = replaceFile(name, s.boot.Config); createErr != nil {
						return nil, createErr
					}
				} else if writeErr := os.WriteFile(s.boot.Config, external, 0600); writeErr != nil {
					return nil, writeErr
				}
				// This editor deliberately ignores the lease. Restore mtime so the
				// guard must compare content or identity, not just mtime and size.
				if timeErr := os.Chtimes(s.boot.Config, originalInfo.ModTime(), originalInfo.ModTime()); timeErr != nil {
					return nil, timeErr
				}
				return Obj{"ok": true}, nil
			})
			configStoreStatus(t, err, 409)
			configStoreUnchanged(t, s, external, cached)
			parts, globErr := filepath.Glob(filepath.Join(filepath.Dir(s.boot.Config), ".giv-write-*.part"))
			if globErr != nil || len(parts) != 0 {
				t.Fatal("rejected conflict leaked its staging file", parts, globErr)
			}
		})
	}
}

func TestConfigStoreRejectedPatchDoesNotPublishMemory(t *testing.T) {
	s, _ := fixture(t)
	before, _ := os.ReadFile(s.boot.Config)
	cached := configStoreCache(s)
	_, err := s.updateAppConfig(func(doc Obj) (Obj, error) {
		doc["mustNotPersist"] = true
		return nil, fail("invalid_preferences", "fixture rejected patch", 400)
	})
	configStoreStatus(t, err, 400)
	configStoreUnchanged(t, s, before, cached)
}

func TestConfigStoreRejectedRootSelectionKeepsActiveSnapshot(t *testing.T) {
	for _, blocked := range []string{"corrupt-config", "lease-busy"} {
		t.Run(blocked, func(t *testing.T) {
			s, originalRoot := fixture(t)
			next := t.TempDir()
			jsonFixture(t, filepath.Join(next, "_index.json"), Obj{"combos": []any{}, "other": []any{}, "summary": Obj{}})
			beforeSnapshot, beforeCache := s.snapshot(), configStoreCache(s)
			want := 423
			if blocked == "corrupt-config" {
				writeFixture(t, s.boot.Config, []byte("{broken"))
				want = 409
			} else {
				lease, err := acquireLease(filepath.Dir(s.boot.Config), filepath.Base(s.boot.Config)+".lock")
				if err != nil {
					t.Fatal(err)
				}
				t.Cleanup(lease.Close)
			}
			beforeDisk, err := os.ReadFile(s.boot.Config)
			if err != nil {
				t.Fatal(err)
			}
			_, err = s.selectRoot(next)
			configStoreStatus(t, err, want)
			if s.snapshot() != beforeSnapshot || !sameRoot(s.snapshot().Root, originalRoot) {
				t.Fatal("refused configuration write activated a different gallery")
			}
			configStoreUnchanged(t, s, beforeDisk, beforeCache)
		})
	}
}

func TestConfigStoreOversizedPatchPreservesDiskAndCache(t *testing.T) {
	s, _ := fixture(t)
	before, err := os.ReadFile(s.boot.Config)
	if err != nil {
		t.Fatal(err)
	}
	cached := configStoreCache(s)
	_, err = s.updateAppConfig(func(doc Obj) (Obj, error) {
		// Generate this only in memory: the store must reject a document that
		// its own bounded reader cannot reopen, before writing any staged file.
		doc["oversizedUnknownField"] = strings.Repeat("x", 32<<20)
		return Obj{"ok": true}, nil
	})
	configStoreStatus(t, err, 409)
	configStoreUnchanged(t, s, before, cached)
	parts, globErr := filepath.Glob(filepath.Join(filepath.Dir(s.boot.Config), ".giv-write-*.part"))
	if globErr != nil || len(parts) != 0 {
		t.Fatal("oversized configuration left a staging file", parts, globErr)
	}
}
