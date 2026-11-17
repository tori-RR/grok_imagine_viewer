package main

import (
	"bytes"
	"context"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// A copied test executable supplies deterministic tools without shells or an
// installed FFmpeg dependency. The parent tests never enter this branch.
func TestMain(m *testing.M) {
	if os.Getenv("GIV_TEST_TOOL_PROCESS") == "1" {
		stem := strings.TrimSuffix(filepath.Base(os.Args[0]), ".exe")
		args := os.Args[1:]
		for _, arg := range args {
			if arg == "-test-flood" {
				fmt.Print(strings.Repeat("x", (1<<20)+1))
				os.Exit(0)
			}
			if arg == "-test-sleep" {
				time.Sleep(5 * time.Second)
				os.Exit(0)
			}
			if arg == "-version" {
				fmt.Println(stem + " version synthetic-test")
				os.Exit(0)
			}
			if arg == "-hwaccels" {
				fmt.Println("Hardware acceleration methods:")
				os.Exit(0)
			}
		}
		if stem == "ffprobe" {
			if os.Getenv("GIV_TEST_PROBE_FAIL") == "1" {
				os.Exit(2)
			}
			fmt.Println("1.25")
			os.Exit(0)
		}
		if os.Getenv("GIV_TEST_FRAME_FAIL") == "1" {
			os.Exit(2)
		}
		source := ""
		for i, arg := range args {
			if arg == "-i" && i+1 < len(args) {
				source = args[i+1]
			}
		}
		if source == "" {
			os.Exit(2)
		}
		if barrier := os.Getenv("GIV_TEST_FRAME_BARRIER"); barrier != "" {
			name := filepath.Base(source)
			_ = os.WriteFile(filepath.Join(barrier, name+".ready"), nil, 0600)
			deadline := time.Now().Add(8 * time.Second)
			for !exists(filepath.Join(barrier, "release")) && time.Now().Before(deadline) {
				time.Sleep(5 * time.Millisecond)
			}
			_ = os.WriteFile(filepath.Join(barrier, name+".done"), nil, 0600)
		}
		if len(args) == 0 {
			os.Exit(2)
		}
		if err := os.WriteFile(args[len(args)-1], jpg, 0600); err != nil {
			os.Exit(2)
		}
		os.Exit(0)
	}
	os.Exit(m.Run())
}

func coverTool(t *testing.T, dir, stem string) string {
	t.Helper()
	self, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	name := stem
	if filepath.Ext(self) == ".exe" {
		name += ".exe"
	}
	path := filepath.Join(dir, name)
	if err := os.MkdirAll(dir, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.Link(self, path); err != nil {
		b, err := os.ReadFile(self)
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, b, 0700); err != nil {
			t.Fatal(err)
		}
	}
	return path
}
func coverToolEnvironment(t *testing.T) string {
	t.Helper()
	base := t.TempDir()
	t.Setenv("GIV_TEST_TOOL_PROCESS", "1")
	t.Setenv("VIEWER_FFMPEG", "")
	t.Setenv("VIEWER_FFPROBE", "")
	t.Setenv("PATH", base)
	t.Setenv("LOCALAPPDATA", base)
	t.Setenv("ProgramFiles", base)
	return base
}
func coverVideo(t *testing.T, s *Server, root string) Obj {
	t.Helper()
	item := Obj{"id": "clip-one", "file": "clip-one.mp4", "mime": "video/mp4", "status": "linked"}
	writeFixture(t, filepath.Join(root, "combos", "0001_aaaaaaaa", "clip-one.mp4"), []byte("synthetic video"))
	s.invalidate()
	return item
}
func coverWait(t *testing.T, what string, condition func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for !condition() {
		if time.Now().After(deadline) {
			t.Fatal("timed out: " + what)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func TestCoverParityToolOverrides(t *testing.T) {
	for _, scenario := range []string{"env-before-config", "config-before-path", "invalid-env-falls-through", "explicit-probe-before-pair", "probe-pairs-with-selected-ffmpeg"} {
		t.Run(scenario, func(t *testing.T) {
			base := coverToolEnvironment(t)
			s, _ := fixture(t)
			envFF := coverTool(t, filepath.Join(base, "环境 tools"), "ffmpeg")
			envFP := coverTool(t, filepath.Dir(envFF), "ffprobe")
			cfgFF := coverTool(t, filepath.Join(base, "配置 tools"), "ffmpeg")
			cfgFP := coverTool(t, filepath.Dir(cfgFF), "ffprobe")
			pathFF := coverTool(t, base, "ffmpeg")
			_ = coverTool(t, base, "ffprobe")
			wantFF, wantFP := envFF, envFP
			s.cfg["ffmpeg"], s.cfg["ffprobe"] = cfgFF, cfgFP
			t.Setenv("VIEWER_FFMPEG", envFF)
			switch scenario {
			case "env-before-config":
				t.Setenv("VIEWER_FFPROBE", envFP)
			case "config-before-path":
				t.Setenv("VIEWER_FFMPEG", "")
				wantFF, wantFP = cfgFF, cfgFP
			case "invalid-env-falls-through":
				t.Setenv("VIEWER_FFMPEG", filepath.Join(base, "missing.exe"))
				t.Setenv("VIEWER_FFPROBE", "missing-probe")
				wantFF, wantFP = cfgFF, cfgFP
			case "explicit-probe-before-pair":
				t.Setenv("VIEWER_FFPROBE", cfgFP)
				wantFP = cfgFP
			case "probe-pairs-with-selected-ffmpeg":
				delete(s.cfg, "ffprobe")
			}
			_ = pathFF
			tools := obj(obj(s.environment()["ffmpeg"])["tools"])
			if str(obj(tools["ffmpeg"])["path"]) != wantFF || str(obj(tools["ffprobe"])["path"]) != wantFP || !yes(obj(tools["ffmpeg"])["ready"]) || !yes(obj(tools["ffprobe"])["ready"]) {
				t.Fatalf("selection/health differs: %v; want %s, %s", tools, wantFF, wantFP)
			}
			state := s.cover.Status()
			if str(state["ffmpeg"]) != wantFF || str(state["ffprobe"]) != wantFP {
				t.Fatal("execution does not use the displayed tools", state)
			}
		})
	}
}

func TestCoverParityDurationRejectsNonVisibleVideo(t *testing.T) {
	for _, scenario := range []string{"image", "hidden", "unknown", "invalid-string", "nan", "infinity", "over-limit"} {
		t.Run(scenario, func(t *testing.T) {
			s, root := fixture(t)
			item := coverVideo(t, s, root)
			duration := any(1.25)
			switch scenario {
			case "image":
				item = Obj{"id": "asset-one", "file": "asset-one.jpg"}
			case "hidden":
				writeFixture(t, filepath.Join(root, "combos", "0001_aaaaaaaa", "clip-one.mp4.trashed"), []byte("legacy marker"))
				s.invalidate()
			case "unknown":
				writeFixture(t, filepath.Join(root, ".trash", "by-id", "clip-one.json"), []byte("{bad"))
				s.invalidate()
			case "invalid-string":
				duration = "1.25"
			case "nan":
				duration = math.NaN()
			case "infinity":
				duration = math.Inf(1)
			case "over-limit":
				duration = 86400.1
			}
			_, out, _, err := s.cover.paths(s.snapshot(), "combos", "0001_aaaaaaaa", item)
			if err != nil {
				t.Fatal(err)
			}
			_, err = s.cover.Duration(s.snapshot(), Obj{"section": "combos", "folder": "0001_aaaaaaaa", "id": item["id"], "duration": duration})
			if err == nil {
				t.Fatal("unsafe duration accepted", scenario)
			}
			if exists(strings.TrimSuffix(out, ".jpg") + ".json") {
				t.Fatal("rejected duration wrote cache")
			}
		})
	}
}

func TestCoverParityDurationHeaderWithoutJPEG(t *testing.T) {
	s, root := fixture(t)
	item := coverVideo(t, s, root)
	_, out, _, err := s.cover.paths(s.snapshot(), "combos", "0001_aaaaaaaa", item)
	if err != nil {
		t.Fatal(err)
	}
	jsonFixture(t, strings.TrimSuffix(out, ".jpg")+".json", Obj{"duration": 1.25})
	for _, method := range []string{"GET", "HEAD"} {
		w, _ := call(t, s, method, "/api/cover?section=combos&folder=0001_aaaaaaaa&id=clip-one", nil, false)
		if w.Code != 204 || w.Header().Get("X-Cover-Duration") != "1.250" {
			t.Fatalf("%s: %d %v", method, w.Code, w.Header())
		}
	}
}

func TestCoverParityIndependentProbeAndFailedFrame(t *testing.T) {
	for _, scenario := range []string{"probe-only", "frame-fails", "frame-only", "no-tools"} {
		t.Run(scenario, func(t *testing.T) {
			base := coverToolEnvironment(t)
			s, root := fixture(t)
			item := coverVideo(t, s, root)
			if scenario != "frame-only" && scenario != "no-tools" {
				t.Setenv("VIEWER_FFPROBE", coverTool(t, filepath.Join(base, "probe"), "ffprobe"))
			}
			if scenario == "frame-fails" || scenario == "frame-only" {
				t.Setenv("VIEWER_FFMPEG", coverTool(t, filepath.Join(base, "frame"), "ffmpeg"))
			}
			if scenario == "frame-fails" {
				t.Setenv("GIV_TEST_FRAME_FAIL", "1")
			}
			result, err := s.prepareCover(Obj{"section": "combos", "folder": "0001_aaaaaaaa", "id": "clip-one"})
			if err != nil {
				t.Fatal(err)
			}
			if scenario == "probe-only" || scenario == "frame-fails" {
				if !yes(result["queued"]) {
					t.Fatal("available independent probe not queued", result)
				}
				coverWait(t, "independent duration", func() bool { return s.cover.durationValue(s.snapshot(), "combos", "0001_aaaaaaaa", item) == 1.25 })
			}
			if scenario == "frame-only" {
				coverWait(t, "frame without probe", func() bool { return s.cover.cached(s.snapshot(), "combos", "0001_aaaaaaaa", item) != "" })
			}
			if scenario == "no-tools" && yes(result["queued"]) {
				t.Fatal("queued without tools")
			}
		})
	}
}

func TestCoverParityLeaseContentionDoesNotDropTwoWorkers(t *testing.T) {
	base := coverToolEnvironment(t)
	s, root := fixture(t)
	t.Setenv("VIEWER_FFMPEG", coverTool(t, filepath.Join(base, "tools"), "ffmpeg"))
	t.Setenv("PATH", filepath.Join(base, "tools"))
	barrier := filepath.Join(base, "barrier")
	if err := os.Mkdir(barrier, 0700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("GIV_TEST_FRAME_BARRIER", barrier)
	lease, err := acquireLease(root, ".viewer-write.lock")
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		if lease != nil {
			lease.Close()
		}
	}()
	for _, id := range []string{"asset-one", "asset-two"} {
		if _, err := s.prepareCover(Obj{"section": "combos", "folder": "0001_aaaaaaaa", "id": id, "imageThumbnail": true}); err != nil {
			t.Fatal(err)
		}
	}
	coverWait(t, "both FFmpeg processes", func() bool { matches, _ := filepath.Glob(filepath.Join(barrier, "*.ready")); return len(matches) == 2 })
	writeFixture(t, filepath.Join(barrier, "release"), nil)
	coverWait(t, "both FFmpeg outputs", func() bool { matches, _ := filepath.Glob(filepath.Join(barrier, "*.done")); return len(matches) == 2 })
	// Both generated files meet a genuinely held OS lease. Old workers finish
	// and silently discard them; repaired workers retain pending publication.
	time.Sleep(200 * time.Millisecond)
	lease.Close()
	lease = nil
	coverWait(t, "both cache publications after lease release", func() bool {
		files, _ := filepath.Glob(filepath.Join(root, ".viewer-cache", "go-covers", "*.jpg"))
		n := 0
		for _, p := range files {
			if !strings.HasPrefix(filepath.Base(p), ".") {
				n++
			}
		}
		return n == 2
	})
}

func TestCoverParityLegacyCacheIsNotBlindlyTrustedOrDeleted(t *testing.T) {
	base := coverToolEnvironment(t)
	s, root := fixture(t)
	item := coverVideo(t, s, root)
	legacy := filepath.Join(root, ".viewer-cache", "covers", "clip-one.jpg")
	writeFixture(t, legacy, jpg)
	meta := strings.TrimSuffix(legacy, ".jpg") + ".json"
	jsonFixture(t, meta, Obj{"duration": 99})
	before, _ := os.ReadFile(meta)
	if s.cover.cached(s.snapshot(), "combos", "0001_aaaaaaaa", item) != "" || s.cover.durationValue(s.snapshot(), "combos", "0001_aaaaaaaa", item) != 0 {
		t.Fatal("unverified legacy identity trusted")
	}
	t.Setenv("VIEWER_FFMPEG", coverTool(t, filepath.Join(base, "tools"), "ffmpeg"))
	t.Setenv("VIEWER_FFPROBE", coverTool(t, filepath.Join(base, "tools"), "ffprobe"))
	if result, err := s.prepareCover(Obj{"section": "combos", "folder": "0001_aaaaaaaa", "id": "clip-one"}); err != nil {
		t.Fatal(err)
	} else if str(result["cacheState"]) != "legacy_unverified" {
		t.Fatal("legacy migration status missing", result)
	}
	coverWait(t, "controlled legacy rebuild", func() bool {
		return s.cover.cached(s.snapshot(), "combos", "0001_aaaaaaaa", item) != "" && s.cover.durationValue(s.snapshot(), "combos", "0001_aaaaaaaa", item) == 1.25
	})
	after, _ := os.ReadFile(meta)
	image, _ := os.ReadFile(legacy)
	if !bytes.Equal(before, after) || !bytes.Equal(image, jpg) {
		t.Fatal("original legacy cache was changed")
	}
}

func TestCoverParityFingerprintClassesAndDurationLimits(t *testing.T) {
	for _, scenario := range []string{"verified", "stale", "partial", "unverified"} {
		t.Run(scenario, func(t *testing.T) {
			s, root := fixture(t)
			item := coverVideo(t, s, root)
			source := filepath.Join(root, "combos", "0001_aaaaaaaa", "clip-one.mp4")
			st, err := regular(source)
			if err != nil {
				t.Fatal(err)
			}
			legacy := filepath.Join(root, ".viewer-cache", "covers", "clip-one.jpg")
			writeFixture(t, legacy, jpg)
			meta := Obj{"duration": 86400, "size": st.Size(), "mtime_ns": st.ModTime().UnixNano()}
			want := "verified"
			switch scenario {
			case "stale":
				meta["size"] = st.Size() + 1
				want = "legacy_stale"
			case "partial":
				delete(meta, "size")
				want = "legacy_unverified"
			case "unverified":
				delete(meta, "size")
				delete(meta, "mtime_ns")
				want = "legacy_unverified"
			}
			jsonFixture(t, strings.TrimSuffix(legacy, ".jpg")+".json", meta)
			if state := s.cover.cacheState(s.snapshot(), "combos", "0001_aaaaaaaa", item); state != want {
				t.Fatal(state, want)
			}
			if scenario == "verified" {
				if d := s.cover.durationValue(s.snapshot(), "combos", "0001_aaaaaaaa", item); d != 86400 {
					t.Fatal("inclusive duration limit", d)
				}
			} else if s.cover.durationValue(s.snapshot(), "combos", "0001_aaaaaaaa", item) != 0 {
				t.Fatal("stale/unverified duration trusted")
			}
		})
	}
}

func TestCoverParityPublicationRevalidatesTarget(t *testing.T) {
	for _, scenario := range []string{"changed-source", "hidden-after-queue", "unknown-after-queue", "root-switch", "accel-generation"} {
		t.Run(scenario, func(t *testing.T) {
			base := coverToolEnvironment(t)
			s, root := fixture(t)
			t.Setenv("VIEWER_FFMPEG", coverTool(t, filepath.Join(base, "tools"), "ffmpeg"))
			barrier := filepath.Join(base, "barrier")
			if err := os.Mkdir(barrier, 0700); err != nil {
				t.Fatal(err)
			}
			t.Setenv("GIV_TEST_FRAME_BARRIER", barrier)
			if _, err := s.prepareCover(Obj{"section": "combos", "folder": "0001_aaaaaaaa", "id": "asset-one", "imageThumbnail": true}); err != nil {
				t.Fatal(err)
			}
			coverWait(t, "frame in progress", func() bool { return exists(filepath.Join(barrier, "asset-one.jpg.ready")) })
			switch scenario {
			case "changed-source":
				writeFixture(t, filepath.Join(root, "combos", "0001_aaaaaaaa", "asset-one.jpg"), append(jpg, 42))
			case "hidden-after-queue":
				writeFixture(t, filepath.Join(root, "combos", "0001_aaaaaaaa", "asset-one.jpg.trashed"), []byte("marker"))
			case "unknown-after-queue":
				writeFixture(t, filepath.Join(root, ".trash", "by-id", "asset-one.json"), []byte("{bad"))
			case "root-switch":
				other := filepath.Join(base, "other")
				jsonFixture(t, filepath.Join(other, "_index.json"), Obj{"combos": []any{}, "other": []any{}})
				if _, err := s.selectRoot(other); err != nil {
					t.Fatal(err)
				}
			case "accel-generation":
				if _, err := s.cover.Set(Obj{"mode": "compat"}); err != nil {
					t.Fatal(err)
				}
			}
			writeFixture(t, filepath.Join(barrier, "release"), nil)
			coverWait(t, "stale publication discarded", func() bool { s.cover.mu.Lock(); defer s.cover.mu.Unlock(); return len(s.cover.pending) == 0 })
			files, _ := filepath.Glob(filepath.Join(root, ".viewer-cache", "go-covers", "*.jpg"))
			for _, path := range files {
				if !strings.HasPrefix(filepath.Base(path), ".") {
					t.Fatal("invalidated source published", scenario, path)
				}
			}
		})
	}
}

func TestCoverParityToolsHaveBoundedOutputAndRuntime(t *testing.T) {
	base := coverToolEnvironment(t)
	tool := coverTool(t, base, "ffmpeg")
	if _, err := runTool(context.Background(), tool, "-test-flood"); err == nil {
		t.Fatal("oversize output accepted")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	started := time.Now()
	if _, err := runTool(ctx, tool, "-test-sleep"); err == nil || time.Since(started) > 2*time.Second {
		t.Fatal("tool timeout not bounded", err, time.Since(started))
	}
}

func TestCoverParityAutomaticToolPrecedence(t *testing.T) {
	for _, scenario := range []string{"bootstrap", "portable", "runtime", "path", "winget-user", "winget-machine", "invalid-explicit-fallback", "path-alias"} {
		t.Run(scenario, func(t *testing.T) {
			base := coverToolEnvironment(t)
			program := filepath.Join(base, "program", "viewer", "app.exe")
			tools := filepath.Join(base, "bootstrap")
			pathDir := filepath.Join(base, "path")
			local := filepath.Join(base, "local")
			machine := filepath.Join(base, "machine")
			t.Setenv("PATH", pathDir)
			t.Setenv("LOCALAPPDATA", local)
			t.Setenv("ProgramFiles", machine)
			resolver := ToolResolver{Executable: program, Config: Obj{}}
			want := ""
			switch scenario {
			case "bootstrap":
				want = coverTool(t, tools, "ffmpeg")
				resolver.Dirs = []string{tools}
				coverTool(t, filepath.Join(base, "program", "video-tools"), "ffmpeg")
			case "portable", "invalid-explicit-fallback":
				want = coverTool(t, filepath.Join(base, "program", "video-tools"), "ffmpeg")
				coverTool(t, pathDir, "ffmpeg")
				if scenario == "invalid-explicit-fallback" {
					t.Setenv("VIEWER_FFMPEG", filepath.Join(base, "missing.exe"))
					resolver.Config["ffmpeg"] = "missing-command"
				}
			case "runtime":
				want = coverTool(t, filepath.Join(filepath.Dir(program), "runtime", "win64"), "ffmpeg")
				coverTool(t, pathDir, "ffmpeg")
			case "path":
				want = coverTool(t, pathDir, "ffmpeg")
				coverTool(t, filepath.Join(local, "Microsoft", "WinGet", "Links"), "ffmpeg")
			case "winget-user":
				want = coverTool(t, filepath.Join(local, "Microsoft", "WinGet", "Links"), "ffmpeg")
				coverTool(t, filepath.Join(machine, "WinGet", "Links"), "ffmpeg")
			case "winget-machine":
				want = coverTool(t, filepath.Join(machine, "WinGet", "Links"), "ffmpeg")
			case "path-alias":
				want = coverTool(t, pathDir, "custom-encoder")
				t.Setenv("VIEWER_FFMPEG", "custom-encoder")
			}
			if scenario == "winget-user" || scenario == "winget-machine" {
				if filepath.Ext(want) != ".exe" {
					t.Skip("WinGet is Windows-only")
				}
			}
			ff, _ := resolver.Resolve()
			if ff != want {
				t.Fatal("wrong precedence", ff, want)
			}
		})
	}
}

func TestCoverParityDurationSnapshotAndMissingID(t *testing.T) {
	s, root := fixture(t)
	coverVideo(t, s, root)
	snap := s.snapshot()
	for _, id := range []string{"", "../clip-one"} {
		if _, err := s.cover.Duration(snap, Obj{"section": "combos", "folder": "0001_aaaaaaaa", "id": id, "duration": 1.25}); err == nil {
			t.Fatal("missing/invalid ID wrote arbitrary selected video")
		}
	}
	snap.Generation--
	if _, err := s.cover.Duration(snap, Obj{"section": "combos", "folder": "0001_aaaaaaaa", "id": "clip-one", "duration": 1.25}); err == nil {
		t.Fatal("stale root-generation accepted")
	}
}

func TestCoverParityFractionalDurationPublicAPI(t *testing.T) {
	s, root := fixture(t)
	item := coverVideo(t, s, root)
	for _, duration := range []float64{3.5, 123.456, 86400} {
		response, result := call(t, s, "POST", "/api/duration", Obj{"expectedRoot": root, "section": "combos", "folder": "0001_aaaaaaaa", "id": "clip-one", "duration": duration}, false)
		if response.Code != 200 || !yes(result["ok"]) || s.cover.durationValue(s.snapshot(), "combos", "0001_aaaaaaaa", item) != duration {
			t.Fatal("fractional/limit duration refused", response.Code, result, duration)
		}
	}
}

func TestCoverParityProbeFailureDoesNotBlockFrame(t *testing.T) {
	base := coverToolEnvironment(t)
	s, root := fixture(t)
	item := coverVideo(t, s, root)
	t.Setenv("VIEWER_FFMPEG", coverTool(t, base, "ffmpeg"))
	t.Setenv("VIEWER_FFPROBE", coverTool(t, base, "ffprobe"))
	t.Setenv("GIV_TEST_PROBE_FAIL", "1")
	if _, err := s.prepareCover(Obj{"section": "combos", "folder": "0001_aaaaaaaa", "id": "clip-one"}); err != nil {
		t.Fatal(err)
	}
	coverWait(t, "independent work completed", func() bool { s.cover.mu.Lock(); defer s.cover.mu.Unlock(); return len(s.cover.pending) == 0 })
	if s.cover.cached(s.snapshot(), "combos", "0001_aaaaaaaa", item) == "" || s.cover.durationValue(s.snapshot(), "combos", "0001_aaaaaaaa", item) != 0 {
		t.Fatal("probe failure affected independent frame")
	}
}

func TestCoverParityToolConfigurationChangeInvalidatesSelection(t *testing.T) {
	base := coverToolEnvironment(t)
	s, _ := fixture(t)
	first := coverTool(t, filepath.Join(base, "first"), "ffmpeg")
	second := coverTool(t, filepath.Join(base, "second"), "ffmpeg")
	if err := s.configPatch(Obj{"ffmpeg": first}); err != nil {
		t.Fatal(err)
	}
	old := s.cover.Status()
	if err := s.configPatch(Obj{"ffmpeg": second}); err != nil {
		t.Fatal(err)
	}
	next := s.cover.Status()
	if str(next["ffmpeg"]) != second || num(next["generation"]) <= num(old["generation"]) {
		t.Fatal("cached execution selection survived tool patch", old, next)
	}
	tools := obj(obj(s.environment()["ffmpeg"])["tools"])
	if str(obj(tools["ffmpeg"])["path"]) != second {
		t.Fatal("health/worker mismatch")
	}
}

func TestCoverParityCancelledWorkerDoesNotPublish(t *testing.T) {
	base := coverToolEnvironment(t)
	s, root := fixture(t)
	t.Setenv("VIEWER_FFMPEG", coverTool(t, base, "ffmpeg"))
	barrier := filepath.Join(base, "barrier")
	if err := os.Mkdir(barrier, 0700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("GIV_TEST_FRAME_BARRIER", barrier)
	if _, err := s.prepareCover(Obj{"section": "combos", "folder": "0001_aaaaaaaa", "id": "asset-one", "imageThumbnail": true}); err != nil {
		t.Fatal(err)
	}
	coverWait(t, "running frame", func() bool { return exists(filepath.Join(barrier, "asset-one.jpg.ready")) })
	started := time.Now()
	s.cover.Close()
	if time.Since(started) > 2*time.Second {
		t.Fatal("cancellation did not bound shutdown")
	}
	files, _ := filepath.Glob(filepath.Join(root, ".viewer-cache", "go-covers", "*.jpg"))
	if len(files) != 0 {
		t.Fatal("cancelled worker left JPEG", files)
	}
}

func TestCoverParityLongBusyPublicationRetainsPendingResult(t *testing.T) {
	base := coverToolEnvironment(t)
	s, root := fixture(t)
	t.Setenv("VIEWER_FFMPEG", coverTool(t, base, "ffmpeg"))
	lease, err := acquireLease(root, ".viewer-write.lock")
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		if lease != nil {
			lease.Close()
		}
	}()
	request := Obj{"section": "combos", "folder": "0001_aaaaaaaa", "id": "asset-one", "imageThumbnail": true}
	if _, err := s.prepareCover(request); err != nil {
		t.Fatal(err)
	}
	time.Sleep(3200 * time.Millisecond)
	s.cover.mu.Lock()
	pending := len(s.cover.pending)
	s.cover.mu.Unlock()
	if pending == 0 {
		t.Fatal("long-held lease discarded queued result")
	}
	lease.Close()
	lease = nil
	coverWait(t, "original publication without another prepare request", func() bool {
		files, _ := filepath.Glob(filepath.Join(root, ".viewer-cache", "go-covers", "*.jpg"))
		return len(files) == 1
	})
}

func TestCoverParityGateWaitIsCancelledWithoutPublication(t *testing.T) {
	base := coverToolEnvironment(t)
	s, _ := fixture(t)
	t.Setenv("VIEWER_FFMPEG", coverTool(t, base, "ffmpeg"))
	state := s.cover.Status()
	item := Obj{"id": "asset-one", "file": "asset-one.jpg", "mime": "image/jpeg"}
	source, _, key, err := s.cover.paths(s.snapshot(), "combos", "0001_aaaaaaaa", item)
	if err != nil {
		t.Fatal(err)
	}
	task := CoverTask{s.snapshot(), "combos", "0001_aaaaaaaa", "cover:" + key, source, item, uint64(num(state["generation"]))}
	s.gate.Lock()
	locked := true
	defer func() {
		if locked {
			s.gate.Unlock()
		}
	}()
	started := make(chan struct{})
	result := make(chan bool, 1)
	applied := make(chan struct{}, 1)
	go func() {
		close(started)
		result <- s.cover.publish(task, func(string) error { applied <- struct{}{}; return nil })
	}()
	<-started
	s.cover.cancel()
	select {
	case ok := <-result:
		if ok {
			t.Fatal("cancelled gate wait succeeded")
		}
	case <-time.After(time.Second):
		t.Fatal("cancelled publication remained blocked by gate")
	}
	s.gate.Unlock()
	locked = false
	select {
	case <-applied:
		t.Fatal("cancelled publication applied after gate release")
	default:
	}
}
