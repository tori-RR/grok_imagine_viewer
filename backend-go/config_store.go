package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
)

type appConfigSnapshot struct {
	data []byte
	info os.FileInfo
	doc  Obj
}

func configUnreadable() error {
	return fail("config_unavailable", "配置无法读取，原文件已保留。", 503)
}
func configCorrupt() error {
	return fail("config_corrupt", "配置内容损坏，已停止保存并保留原文件。", 409)
}
func configConflict() error {
	return fail("config_conflict", "配置已被其他程序修改，请重试。", 409)
}

func appConfigObject(value any) (Obj, bool) {
	switch fields := value.(type) {
	case Obj:
		return fields, fields != nil
	case map[string]any:
		return Obj(fields), fields != nil
	}
	return nil, false
}

// Config updates never traverse a link/reparse point, including their parents.
func plainConfigParents(path string) error {
	if !filepath.IsAbs(path) {
		return configUnreadable()
	}
	for dir := filepath.Dir(path); ; dir = filepath.Dir(dir) {
		info, err := os.Lstat(dir)
		if err != nil || !info.IsDir() || reparse(info) || info.Mode()&os.ModeSymlink != 0 {
			return configUnreadable()
		}
		if filepath.Dir(dir) == dir {
			return nil
		}
	}
}

// Missing fields and unknown fields are allowed. Known containers/types must
// remain interpretable before any writer can replace the document. Value/default
// migration is deliberately separate from this write-safety check.
func validateAppConfig(doc Obj) error {
	for _, key := range []string{"root", "accel", "coverBackend"} {
		if value, exists := doc[key]; exists {
			if _, ok := value.(string); !ok {
				return configCorrupt()
			}
		}
	}
	if value, exists := doc["history"]; exists {
		items, ok := value.([]any)
		if !ok {
			return configCorrupt()
		}
		for _, item := range items {
			if _, ok := item.(string); !ok {
				return configCorrupt()
			}
		}
	}
	for _, key := range []string{"preferences", "volume"} {
		value, exists := doc[key]
		if !exists {
			continue
		}
		fields, ok := appConfigObject(value)
		if !ok {
			return configCorrupt()
		}
		number, boolean := "level", "muted"
		if key == "preferences" {
			number, boolean = "wheelVolumeStep", "sidebarCollapsed"
		}
		if value, exists := fields[number]; exists && !numeric(value) {
			return configCorrupt()
		}
		if value, exists := fields[boolean]; exists {
			if _, ok := value.(bool); !ok {
				return configCorrupt()
			}
		}
		if key == "preferences" {
			if version, exists := fields["version"]; exists && (!numeric(version) || num(version) != 1) {
				return fail("future_preferences", "设置版本无法识别，已停止写入。", 409)
			}
			for _, name := range []string{"language", "saveDirectory", "audioOutputId"} {
				if v, exists := fields[name]; exists {
					if _, ok := v.(string); !ok {
						return configCorrupt()
					}
				}
			}
			if value, exists := fields["shortcuts"]; exists {
				shortcuts, ok := appConfigObject(value)
				if !ok {
					return configCorrupt()
				}
				for name, value := range shortcuts {
					if defaultShortcuts[name] != nil {
						if _, ok := value.(string); !ok {
							return configCorrupt()
						}
					}
				}
			}
		}
	}
	return nil
}

func readAppConfig(path string) (appConfigSnapshot, error) {
	if err := plainConfigParents(path); err != nil {
		return appConfigSnapshot{}, err
	}
	f, err := openRegular(path)
	if os.IsNotExist(err) {
		return appConfigSnapshot{doc: Obj{}}, nil
	}
	if err != nil {
		return appConfigSnapshot{}, configUnreadable()
	}
	defer f.Close()
	before, err := f.Stat()
	if err != nil {
		return appConfigSnapshot{}, configUnreadable()
	}
	data, err := io.ReadAll(io.LimitReader(f, 32<<20+1))
	if err != nil {
		return appConfigSnapshot{}, configUnreadable()
	}
	if len(data) > 32<<20 {
		return appConfigSnapshot{}, configCorrupt()
	}
	after, err := os.Lstat(path)
	if err != nil || reparse(after) || !after.Mode().IsRegular() || !os.SameFile(before, after) || before.Size() != after.Size() || before.ModTime() != after.ModTime() || int64(len(data)) != after.Size() {
		return appConfigSnapshot{}, configConflict()
	}
	doc, err := decode(data)
	if err != nil {
		return appConfigSnapshot{}, configCorrupt()
	}
	if err := validateAppConfig(doc); err != nil {
		return appConfigSnapshot{}, err
	}
	return appConfigSnapshot{data, after, doc}, nil
}

// Lock order: cfgMu -> permanent OS lease -> read/merge/stage/recheck/replace.
// All cooperating Go writers use the same lease. The last recheck also detects
// observed edits by non-cooperating programs; it is not an OS atomic CAS against
// an editor that writes in the final recheck-to-rename interval.
func (s *Server) updateAppConfig(change func(Obj) (Obj, error)) (Obj, error) {
	s.cfgMu.Lock()
	defer s.cfgMu.Unlock()
	if err := plainConfigParents(s.boot.Config); err != nil {
		return nil, err
	}
	lease, err := acquireLease(filepath.Dir(s.boot.Config), filepath.Base(s.boot.Config)+".lock")
	if err != nil {
		var api *APIError
		if errors.As(err, &api) && api.Status == 423 {
			return nil, fail("config_busy", "配置正在被其他进程修改，请稍后重试。", 423)
		}
		return nil, configUnreadable()
	}
	defer lease.Close()
	before, err := readAppConfig(s.boot.Config)
	if err != nil {
		return nil, err
	}
	if before.info == nil && s.cfgExists {
		return nil, configUnreadable()
	}
	next := clone(before.doc)
	out, err := change(next)
	if err != nil {
		return nil, err
	}
	if err := validateAppConfig(next); err != nil {
		return nil, err
	}
	data, err := json.MarshalIndent(next, "", "  ")
	if err != nil {
		return nil, configCorrupt()
	}
	data = append(data, '\n')
	if len(data) > 32<<20 {
		return nil, configCorrupt()
	}
	err = atomicBytesGuarded(s.boot.Config, data, func() error {
		current, err := readAppConfig(s.boot.Config)
		if err != nil {
			return err
		}
		if (before.info == nil) != (current.info == nil) || !bytes.Equal(before.data, current.data) {
			return configConflict()
		}
		if before.info != nil && (!os.SameFile(before.info, current.info) || before.info.Size() != current.info.Size() || before.info.ModTime() != current.info.ModTime()) {
			return configConflict()
		}
		return nil
	})
	if err != nil {
		var api *APIError
		if errors.As(err, &api) {
			return nil, err
		}
		return nil, configUnreadable()
	}
	s.cfg, s.cfgExists = next, true
	return out, nil
}
