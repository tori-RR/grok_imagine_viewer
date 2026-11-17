package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"
)

var outputMu sync.Mutex
var appToolDirs []string

func emitNative(o Obj) {
	outputMu.Lock()
	defer outputMu.Unlock()
	_ = json.NewEncoder(os.Stdout).Encode(o)
}
func findTool(stem string) string {
	ff, fp := (ToolResolver{Dirs: appToolDirs}).Resolve()
	if stem == "ffmpeg" {
		return ff
	}
	if stem == "ffprobe" {
		return fp
	}
	return ""
}

type boundedOutput struct {
	buffer   bytes.Buffer // Do not promote Buffer.ReadFrom, which bypasses Write's limit.
	limit    int
	exceeded bool
}

func (b *boundedOutput) Len() int       { return b.buffer.Len() }
func (b *boundedOutput) String() string { return b.buffer.String() }

func (b *boundedOutput) Write(p []byte) (int, error) {
	n := len(p)
	left := b.limit - b.buffer.Len()
	if n > left {
		b.exceeded = true
		p = p[:left]
	}
	_, _ = b.buffer.Write(p)
	return n, nil // Drain excess output so the child cannot block on a full pipe.
}
func runTool(ctx context.Context, path string, args ...string) ([]byte, error) {
	cmd := exec.CommandContext(ctx, path, args...)
	hideCommand(cmd)
	out := &boundedOutput{limit: 1 << 20}
	cmd.Stdout = out
	cmd.Stderr = io.Discard
	cmd.WaitDelay = time.Second
	err := cmd.Run()
	if out.exceeded {
		return nil, errors.New("tool output exceeded limit")
	}
	return out.buffer.Bytes(), err
}
func (s *Server) environment() Obj {
	tools := Obj{}
	ready := true
	selected := s.cover.Status()
	for _, n := range []string{"ffmpeg", "ffprobe"} {
		path := str(selected[n])
		reason := "missing"
		ok := false
		version := ""
		if path != "" {
			ctx, cancel := context.WithTimeout(s.ctx, 3*time.Second)
			out, e := runTool(ctx, path, "-version")
			cancel()
			if e == nil {
				version = strings.SplitN(string(out), "\n", 2)[0]
				fields := strings.Fields(version)
				if len(fields) < 3 || fields[0] != n || fields[1] != "version" {
					tools[n] = Obj{"ready": false, "reason": "unavailable", "path": path, "version": version}
					ready = false
					continue
				}
				ok = true
				reason = ""
			} else {
				reason = "unavailable"
			}
		}
		ready = ready && ok
		tools[n] = Obj{"ready": ok, "reason": reason, "path": path, "version": version}
	}
	return Obj{"ok": true, "runtime": "mygo", "backend": "go", "ffmpeg": Obj{"ready": ready, "tools": tools}}
}

type CoverTask struct {
	Snap                         Snapshot
	Section, Folder, Key, Source string
	Item                         Obj
	Generation                   uint64
}
type CoverPool struct {
	s             *Server
	ctx           context.Context
	cancel        context.CancelFunc
	wg            sync.WaitGroup
	queue         chan CoverTask
	durationQueue chan CoverTask
	mu            sync.Mutex
	probe         sync.Mutex
	pending       map[string]bool
	failures      map[string]time.Time
	state         Obj
	generation    uint64
}

func NewCoverPool(s *Server) *CoverPool {
	ctx, cancel := context.WithCancel(s.ctx)
	c := &CoverPool{s: s, ctx: ctx, cancel: cancel, queue: make(chan CoverTask, 512), durationQueue: make(chan CoverTask, 512), pending: map[string]bool{}, failures: map[string]time.Time{}}
	for i := 0; i < 2; i++ {
		c.wg.Add(1)
		go func() {
			defer c.wg.Done()
			for {
				select {
				case t := <-c.queue:
					c.work(t)
				case <-ctx.Done():
					return
				}
			}
		}()
	}
	c.wg.Add(1)
	go func() {
		defer c.wg.Done()
		for {
			select {
			case task := <-c.durationQueue:
				c.workDuration(task)
			case <-ctx.Done():
				return
			}
		}
	}()
	return c
}
func (c *CoverPool) Close() { c.cancel(); c.wg.Wait() }
func (c *CoverPool) Status() Obj {
	c.probe.Lock()
	defer c.probe.Unlock()
	ff, fp := c.s.resolvedTools()
	c.mu.Lock()
	if c.state != nil && str(c.state["ffmpeg"]) == ff && str(c.state["ffprobe"]) == fp {
		v := clone(c.state)
		c.mu.Unlock()
		return v
	}
	c.mu.Unlock()
	return c.probeLocked()
}
func (c *CoverPool) probeLocked() Obj {
	c.s.cfgMu.Lock()
	mode := str(c.s.cfg["accel"])
	pref := str(c.s.cfg["coverBackend"])
	c.s.cfgMu.Unlock()
	if mode != "compat" {
		mode = "auto"
	}
	if pref == "" {
		pref = "auto"
	}
	ff, fp := c.s.resolvedTools()
	compiled := []any{}
	if ff != "" {
		ctx, cancel := context.WithTimeout(c.ctx, 3*time.Second)
		out, e := runTool(ctx, ff, "-hide_banner", "-hwaccels")
		cancel()
		if e == nil {
			for _, line := range strings.Fields(string(out)) {
				switch line {
				case "cuda", "d3d11va", "dxva2", "qsv", "vaapi", "videotoolbox":
					compiled = append(compiled, line)
				}
			}
		}
	}
	order := []string{}
	switch runtime.GOOS {
	case "windows":
		order = []string{"d3d11va", "cuda", "dxva2", "qsv"}
	case "darwin":
		order = []string{"videotoolbox"}
	case "linux":
		order = []string{"vaapi", "cuda", "qsv"}
	}
	available := []any{}
	for _, candidate := range order {
		for _, v := range compiled {
			if str(v) == candidate {
				available = append(available, v)
			}
		}
	}
	choice := ""
	if mode == "auto" {
		if pref == "auto" && len(available) > 0 {
			choice = str(available[0])
		} else {
			for _, v := range available {
				if pref == str(v) {
					choice = pref
				}
			}
		}
	}
	candidate := first(choice, "cpu")
	effective := "compat"
	decode := "cpu"
	if choice != "" {
		effective = "hardware"
		decode = "hardware-then-cpu"
	}
	c.mu.Lock()
	c.generation++
	c.state = Obj{"mode": mode, "backendPreference": pref, "effective": effective, "hwaccel": choice, "candidateBackend": candidate, "decodeStatus": "not_observed", "availableBackends": available, "scaleBackend": "cpu", "encodeBackend": "cpu", "generation": c.generation, "hwaccels": compiled, "gpu": "", "ffmpeg": ff, "ffprobe": fp, "covers": ff != "", "durationProbe": fp != "", "coverDecode": decode, "fallback": "", "workers": 2}
	v := clone(c.state)
	c.mu.Unlock()
	return v
}
func (c *CoverPool) Set(p Obj) (Obj, error) {
	mode := str(p["mode"])
	pref := str(p["backend"])
	if mode != "auto" && mode != "compat" {
		return nil, fail("invalid_accel", "加速策略无效。", 400)
	}
	valid := pref == "" || pref == "auto"
	for _, name := range []string{"cuda", "d3d11va", "dxva2", "qsv", "vaapi", "videotoolbox"} {
		valid = valid || pref == name
	}
	if !valid {
		return nil, fail("invalid_accel", "封面后端无效。", 400)
	}
	c.probe.Lock()
	defer c.probe.Unlock()
	patch := Obj{"accel": mode}
	if pref != "" {
		patch["coverBackend"] = pref
	}
	if e := c.s.configPatch(patch); e != nil {
		return nil, e
	}
	v := c.probeLocked()
	v["ok"] = true
	return v, nil
}
func (c *CoverPool) paths(snap Snapshot, section, folder string, item Obj) (string, string, string, error) {
	source, e := c.s.resolve(snap, section, folder, str(item["file"]))
	if e != nil {
		return "", "", "", e
	}
	st, e := regular(source)
	if e != nil {
		return "", "", "", e
	}
	rel, _ := filepath.Rel(snap.Root, source)
	key := hash([]byte(fmt.Sprintf("cover-v1\n%s\n%d\n%d", filepath.ToSlash(rel), st.Size(), st.ModTime().UnixNano())))
	out, e := jailed(snap.Root, filepath.Join(".viewer-cache", "go-covers", key+".jpg"))
	return source, out, key, e
}
func (c *CoverPool) cached(snap Snapshot, section, folder string, item Obj) string {
	source, out, _, e := c.paths(snap, section, folder, item)
	if e != nil {
		return ""
	}
	if st, e := regular(out); e == nil && st.Size() > 0 {
		return out
	}
	id := str(item["id"])
	if !safeName(id) {
		return ""
	}
	old, e := jailed(snap.Root, filepath.Join(".viewer-cache", "covers", id+".json"))
	if e != nil {
		return ""
	}
	meta, e := readJSON(old)
	if e != nil {
		return ""
	}
	fi, e := regular(source)
	if e != nil {
		return ""
	}
	if num(meta["size"]) == fi.Size() && num(meta["mtime_ns"]) == fi.ModTime().UnixNano() {
		p := strings.TrimSuffix(old, ".json") + ".jpg"
		if st, e := regular(p); e == nil && st.Size() > 0 {
			return p
		}
	}
	return ""
}
func (c *CoverPool) durationValue(snap Snapshot, section, folder string, item Obj) float64 {
	if mediaKind(item) != "video" || mediaKind(Obj{"file": item["file"]}) != "video" {
		return 0
	}
	source, out, _, e := c.paths(snap, section, folder, item)
	if e != nil {
		return 0
	}
	meta, e := readJSON(strings.TrimSuffix(out, ".jpg") + ".json")
	if e == nil {
		if v := realnum(meta["duration"]); v > 0 && v <= 86400 {
			return v
		}
	}
	id := str(item["id"])
	if !safeName(id) {
		return 0
	}
	p, e := jailed(snap.Root, filepath.Join(".viewer-cache", "covers", id+".json"))
	if e != nil {
		return 0
	}
	meta, e = readJSON(p)
	fi, fe := regular(source)
	if e == nil && fe == nil && num(meta["size"]) == fi.Size() && num(meta["mtime_ns"]) == fi.ModTime().UnixNano() {
		if v := realnum(meta["duration"]); v > 0 && v <= 86400 {
			return v
		}
	}
	return 0
}
func (c *CoverPool) Duration(snap Snapshot, p Obj) (Obj, error) {
	v := realnum(p["duration"])
	// Durations are fractional seconds. numeric() is the integer-only
	// revision validator and must not be reused for this protocol field.
	number := false
	switch p["duration"].(type) {
	case json.Number, float64, int, int64, uint64:
		number = true
	}
	if !number || !(v > 0 && v <= 86400) {
		return nil, fail("invalid_duration", "时长无效。", 400)
	}
	if !safeName(str(p["id"])) {
		return nil, fail("missing_media", "找不到媒体。", 404)
	}
	c.s.trashMu.Lock()
	c.s.trashRead = trashReadCache{}
	c.s.trashMu.Unlock()
	current, it, e := c.s.coverTarget(str(p["section"]), str(p["folder"]), str(p["id"]))
	if e != nil {
		return nil, e
	}
	if c.s.stale(snap) || current != snap {
		return nil, changed()
	}
	if it == nil {
		return nil, fail("missing_media", "找不到媒体。", 404)
	}
	if mediaKind(it) != "video" || mediaKind(Obj{"file": it["file"]}) != "video" {
		return nil, fail("invalid_duration", "只有可见视频可以保存时长。", 400)
	}
	_, out, _, e := c.paths(snap, str(p["section"]), str(p["folder"]), it)
	if e != nil {
		return nil, e
	}
	e = c.writeDuration(out, v)
	return Obj{"ok": e == nil, "id": it["id"], "duration": v}, e
}
func (s *Server) coverTarget(section, folder, id string) (Snapshot, Obj, error) {
	snap := s.snapshot()
	if id != "" {
		if snap.Root == "" {
			return snap, nil, changed()
		}
		if section == "" {
			section = "combos"
		}
		if snap.Mode == "single" {
			section = "_root"
			folder = ""
		}
		if snap.Mode == "loose" {
			section = "loose"
		}
		_, items, e := s.readGroup(snap, section, folder)
		if e != nil {
			return snap, nil, e
		}
		for _, it := range items {
			if str(it["id"]) == id {
				delete(it, "_markerPresent") // Check this target's marker even on a warm group cache.
				hidden, e := s.mediaHidden(snap, it, section, folder)
				if e != nil {
					return snap, nil, e
				}
				if hidden {
					return snap, nil, nil
				}
				path, e := s.resolve(snap, section, folder, str(it["file"]))
				if e != nil {
					return snap, nil, e
				}
				if _, e = regular(path); e != nil {
					return snap, nil, e
				}
				if s.stale(snap) {
					return snap, nil, changed()
				}
				return snap, it, nil
			}
		}
		return snap, nil, nil
	}
	o, e := s.combo(snap, section, folder)
	if e != nil {
		return snap, nil, e
	}
	items := rows(o["items"])
	return snap, pickCover(items, str(o["lastViewedId"])), nil
}
func (s *Server) prepareCover(p Obj) (Obj, error) {
	section, folder := str(p["section"]), str(p["folder"])
	snap, item, e := s.coverTarget(section, folder, str(p["id"]))
	if e != nil {
		return nil, e
	}
	if item == nil {
		return Obj{"ok": true, "queued": false}, nil
	}
	source, _, key, e := s.cover.paths(snap, section, folder, item)
	if e != nil {
		return nil, e
	}
	state := s.cover.Status()
	c := s.cover
	coverQueued, durationQueued := false, false
	if mediaKind(item) == "video" && mediaKind(Obj{"file": item["file"]}) == "video" && str(state["ffprobe"]) != "" && c.durationValue(snap, section, folder, item) == 0 {
		durationQueued = c.enqueue(CoverTask{snap, section, folder, "duration:" + key, source, item, uint64(num(state["generation"]))}, true)
	}
	if (mediaKind(item) == "video" || yes(p["imageThumbnail"])) && yes(state["covers"]) && c.cached(snap, section, folder, item) == "" {
		coverQueued = c.enqueue(CoverTask{snap, section, folder, "cover:" + key, source, item, uint64(num(state["generation"]))}, false)
	}
	return Obj{"ok": true, "queued": coverQueued || durationQueued, "coverQueued": coverQueued, "durationQueued": durationQueued, "cacheState": c.cacheState(snap, section, folder, item)}, nil
}

func (c *CoverPool) cacheState(snap Snapshot, section, folder string, item Obj) string {
	if c.cached(snap, section, folder, item) != "" {
		return "verified"
	}
	id := str(item["id"])
	if !safeName(id) {
		return "missing"
	}
	path, err := jailed(snap.Root, filepath.Join(".viewer-cache", "covers", id+".jpg"))
	if err != nil {
		return "unavailable"
	}
	if _, err = regular(path); err != nil {
		return "missing"
	}
	meta, err := readJSON(strings.TrimSuffix(path, ".jpg") + ".json")
	if err != nil || meta["size"] == nil || meta["mtime_ns"] == nil {
		return "legacy_unverified"
	}
	return "legacy_stale"
}
func (c *CoverPool) enqueue(task CoverTask, duration bool) bool {
	c.mu.Lock()
	full := fmt.Sprintf("%d:%d:%s:%s", task.Generation, task.Snap.Generation, task.Snap.Root, task.Key)
	if c.pending[full] || time.Since(c.failures[full]) < 5*time.Minute {
		c.mu.Unlock()
		return false
	}
	c.pending[full] = true
	c.mu.Unlock()
	task.Key = full
	queue := c.queue
	if duration {
		queue = c.durationQueue
	}
	select {
	case queue <- task:
		return true
	default:
		c.mu.Lock()
		delete(c.pending, full)
		c.mu.Unlock()
		return false
	}
}
func (s *Server) serveCover(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	section, folder := q.Get("section"), q.Get("folder")
	snap, item, e := s.coverTarget(section, folder, q.Get("id"))
	if e != nil {
		sendError(w, e)
		return
	}
	if item == nil {
		w.WriteHeader(204)
		return
	}
	p, e := s.resolve(snap, section, folder, str(item["file"]))
	if e != nil {
		sendError(w, e)
		return
	}
	if q.Get("as") == "media" {
		serveLocal(w, r, p, true)
		return
	}
	if mediaKind(item) == "video" {
		if d := s.cover.durationValue(snap, section, folder, item); d > 0 {
			w.Header().Set("X-Cover-Duration", fmt.Sprintf("%.3f", d))
		}
	}
	if cached := s.cover.cached(snap, section, folder, item); cached != "" {
		serveLocal(w, r, cached, true)
		return
	}
	if mediaKind(item) == "image" {
		serveLocal(w, r, p, true)
		return
	}
	w.WriteHeader(204)
}
func (c *CoverPool) work(t CoverTask) {
	defer func() { c.mu.Lock(); delete(c.pending, t.Key); c.mu.Unlock() }()
	if c.s.stale(t.Snap) {
		return
	}
	state := c.Status()
	if uint64(num(state["generation"])) != t.Generation {
		return
	}
	source, out, _, e := c.paths(t.Snap, t.Section, t.Folder, t.Item)
	if e != nil {
		return
	}
	if e = os.MkdirAll(filepath.Dir(out), 0700); e != nil {
		return
	}
	tmp := filepath.Join(filepath.Dir(out), ".cover-"+token()+".jpg")
	defer os.Remove(tmp)
	success := false
	backend := str(state["hwaccel"])
	attempts := []string{backend}
	if backend != "" {
		attempts = append(attempts, "")
	}
	for _, hw := range attempts {
		if c.s.stale(t.Snap) {
			return
		}
		args := []string{"-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-threads", "1", "-protocol_whitelist", "file,pipe"}
		if hw != "" {
			args = append(args, "-hwaccel", hw)
		}
		if mediaKind(t.Item) == "video" {
			args = append(args, "-ss", "0")
		}
		args = append(args, "-i", source, "-map", "0:v:0", "-frames:v", "1", "-vf", "scale=480:-2", "-threads", "1", "-q:v", "3", tmp)
		ctx, cancel := context.WithTimeout(c.ctx, 12*time.Second)
		started := time.Now()
		_, e = runTool(ctx, str(state["ffmpeg"]), args...)
		cancel()
		c.mu.Lock()
		if c.generation == t.Generation {
			c.state["lastAttempt"] = Obj{"backend": first(hw, "cpu"), "succeeded": e == nil, "elapsedMs": time.Since(started).Milliseconds()}
			c.state["decodeStatus"] = "command_failed"
			if e == nil {
				c.state["decodeStatus"] = "command_succeeded"
			}
		}
		c.mu.Unlock()
		if e == nil {
			success = true
			break
		}
	}
	if !success {
		c.mu.Lock()
		if len(c.failures) > 256 {
			c.failures = map[string]time.Time{}
		}
		c.failures[t.Key] = time.Now()
		c.mu.Unlock()
		return
	}
	if c.s.stale(t.Snap) {
		return
	}
	_, current, keyErr := func() (string, string, error) {
		a, b, _, e := c.paths(t.Snap, t.Section, t.Folder, t.Item)
		return a, b, e
	}()
	if keyErr != nil || current != out {
		return
	}
	if bytes, e := os.ReadFile(tmp); e != nil || len(bytes) < 3 || bytes[0] != 0xff || bytes[1] != 0xd8 {
		return
	}
	c.publish(t, func(current string) error { return replaceFile(tmp, current) })
}

func (c *CoverPool) writeDuration(out string, duration float64) error {
	path := strings.TrimSuffix(out, ".jpg") + ".json"
	doc, err := readJSON(path)
	if err != nil {
		return err
	}
	doc["duration"] = duration
	return atomicJSON(path, doc)
}

// Extraction/probing never hold a gallery lease. A bounded worker keeps its
// generated result pending until publication is possible or its context/root/
// tool generation becomes stale. Long downloads must not silently drop frames.
func (c *CoverPool) publish(task CoverTask, apply func(string) error) bool {
	ctx := c.ctx
	for {
		select {
		case <-ctx.Done():
			return false
		default:
		}
		if c.s.stale(task.Snap) {
			return false
		}
		c.mu.Lock()
		sameGeneration := c.generation == task.Generation
		c.mu.Unlock()
		if !sameGeneration {
			return false
		}
		// Match all foreground mutations: gate, then the gallery lease. Never
		// keep the gate while waiting for an external lease, so switching roots
		// and foreground playback controls are not queued behind retry sleeps.
		if !c.s.gate.TryLock() {
			select {
			case <-ctx.Done():
				return false
			case <-time.After(15 * time.Millisecond):
				continue
			}
		}
		lease, err := acquireLease(task.Snap.Root, ".viewer-write.lock")
		if err == nil {
			defer c.s.gate.Unlock()
			defer lease.Close()
			select {
			case <-ctx.Done():
				return false
			default:
			}
			c.s.trashMu.Lock()
			c.s.trashRead = trashReadCache{}
			c.s.trashMu.Unlock()
			_, item, e := c.s.coverTarget(task.Section, task.Folder, str(task.Item["id"]))
			if e != nil || item == nil || str(item["file"]) != str(task.Item["file"]) {
				return false
			}
			_, out, key, e := c.paths(task.Snap, task.Section, task.Folder, item)
			if e != nil || !strings.HasSuffix(task.Key, ":"+key) || c.s.stale(task.Snap) {
				return false
			}
			c.mu.Lock()
			sameGeneration = c.generation == task.Generation
			c.mu.Unlock()
			if !sameGeneration {
				return false
			}
			select {
			case <-ctx.Done():
				return false
			default:
			}
			return apply(out) == nil
		}
		c.s.gate.Unlock()
		var api *APIError
		if !errors.As(err, &api) || api.Status != 423 {
			return false
		}
		select {
		case <-ctx.Done():
			return false
		case <-time.After(15 * time.Millisecond):
		}
	}
}
func (c *CoverPool) workDuration(task CoverTask) {
	defer func() { c.mu.Lock(); delete(c.pending, task.Key); c.mu.Unlock() }()
	if c.s.stale(task.Snap) {
		return
	}
	state := c.Status()
	if uint64(num(state["generation"])) != task.Generation {
		return
	}
	probe := str(state["ffprobe"])
	if probe == "" {
		return
	}
	ctx, cancel := context.WithTimeout(c.ctx, 8*time.Second)
	b, err := runTool(ctx, probe, "-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", task.Source)
	cancel()
	duration, parseErr := strconv.ParseFloat(strings.TrimSpace(string(b)), 64)
	if err != nil || parseErr != nil || !(duration > 0 && duration <= 86400) {
		c.mu.Lock()
		if len(c.failures) > 256 {
			c.failures = map[string]time.Time{}
		}
		c.failures[task.Key] = time.Now()
		c.mu.Unlock()
		return
	}
	c.publish(task, func(out string) error { return c.writeDuration(out, duration) })
}
