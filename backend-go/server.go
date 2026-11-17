package main

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

type APIError struct {
	Code, Message string
	Status        int
	Extra         Obj
}

func (e *APIError) Error() string                 { return e.Message }
func fail(code, message string, status int) error { return &APIError{code, message, status, nil} }
func changed() error                              { return fail("library_changed", "图库已经切换，请重新操作。", 409) }

type Snapshot struct {
	Root, Mode string
	Generation uint64
}
type cachedGroup struct {
	Stamp string
	At    time.Time
	Card  Obj
	Items []Obj
}
type trashReadCache struct {
	root       string
	generation uint64
	at         time.Time
	records    map[string]Obj
	invalid    map[string]bool
	err        error
}
type Server struct {
	taskHistory    *History
	historyErr     string
	requests       chan struct{}
	trashMu        sync.Mutex
	trashRead      trashReadCache
	ctx            context.Context
	boot           Bootstrap
	origin, cookie string
	gate           sync.Mutex
	mu             sync.RWMutex
	root, mode     string
	generation     uint64
	rootRequest    atomic.Uint64
	cfgMu          sync.Mutex
	cfg            Obj
	cfgExists      bool
	cacheMu        sync.Mutex
	groups         map[string]cachedGroup
	groupFlights   map[string]chan struct{}
	cover          *CoverPool
	runMu          sync.Mutex
	run            *DownloadRun
	nextRun        uint64
	dedupMu        sync.Mutex
	dedupPlan      *DedupPlan
}

func NewServer(ctx context.Context, b Bootstrap) (*Server, error) {
	_, configErr := os.Lstat(b.Config)
	cfg, e := readJSON(b.Config)
	if e != nil {
		return nil, fmt.Errorf("configuration is unreadable; retained unchanged")
	}
	s := &Server{requests: make(chan struct{}, 64), ctx: ctx, boot: b, cfg: cfg, generation: 1, groups: map[string]cachedGroup{}, groupFlights: map[string]chan struct{}{}}
	s.cfgExists = !os.IsNotExist(configErr) || len(cfg) != 0
	s.taskHistory, e = openHistory(b.Config)
	if e != nil {
		// Keep gallery browsing available when the optional task-history database
		// is damaged or unavailable. Downloads fail closed until it is healthy.
		s.historyErr = e.Error()
	}
	s.cover = NewCoverPool(s)
	return s, nil
}
func (s *Server) close() {
	s.stopDownloads()
	s.runMu.Lock()
	run := s.run
	s.runMu.Unlock()
	if run != nil && run.done != nil {
		select {
		case <-run.done:
		case <-time.After(15 * time.Second):
		}
	}
	s.cover.Close()
	s.taskHistory.Close()
}
func (s *Server) snapshot() Snapshot {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return Snapshot{s.root, s.mode, s.generation}
}
func (s *Server) stale(p Snapshot) bool {
	q := s.snapshot()
	return p.Generation != q.Generation || p.Root != q.Root
}
func (s *Server) invalidate() {
	s.trashMu.Lock()
	s.trashRead = trashReadCache{}
	s.trashMu.Unlock()
	s.cacheMu.Lock()
	s.groups = map[string]cachedGroup{}
	s.cacheMu.Unlock()
}
func (s *Server) withWrite(p Obj, meta bool, fn func(Snapshot) (Obj, error)) (Obj, error) {
	snap := s.snapshot()
	if snap.Root == "" {
		return nil, changed()
	}
	if !sameRoot(str(p["expectedRoot"]), snap.Root) {
		return nil, changed()
	}
	if s.downloadActive() {
		return nil, fail("library_busy", "图库正在下载，请先停止。", 423)
	}
	s.gate.Lock()
	defer s.gate.Unlock()
	if s.stale(snap) || !sameRoot(str(p["expectedRoot"]), snap.Root) {
		return nil, changed()
	}
	lease, e := acquireLease(snap.Root, ".viewer-write.lock")
	if e != nil {
		return nil, e
	}
	defer lease.Close()
	if meta {
		m, e := acquireLease(snap.Root, ".viewer-meta.lock")
		if e != nil {
			return nil, e
		}
		defer m.Close()
	}
	out, e := fn(snap)
	if !meta {
		s.invalidate()
	}
	return out, e
}

// Ordinary descriptive metadata has its own permanent lease. Lock order is
// gate -> metadata; native binding remains gate -> gallery -> metadata, and a
// download owns gallery -> metadata without taking gate while holding either.
// All OS lease acquisitions are nonblocking, so contention cannot form a wait
// cycle. Holding gate through revision validation and commit prevents a local
// root switch from publishing a different generation midway through a write.
func (s *Server) withMetadataWrite(p Obj, fn func(Snapshot) (Obj, error)) (Obj, error) {
	snap := s.snapshot()
	if snap.Root == "" || !sameRoot(str(p["expectedRoot"]), snap.Root) {
		return nil, changed()
	}
	s.gate.Lock()
	defer s.gate.Unlock()
	if s.stale(snap) || !sameRoot(str(p["expectedRoot"]), snap.Root) {
		return nil, changed()
	}
	lease, err := acquireLease(snap.Root, ".viewer-meta.lock")
	if err != nil {
		var api *APIError
		if errors.As(err, &api) && api.Code == "library_busy" {
			return nil, fail("meta_busy", "元数据正在被另一个进程修改，请稍后重试。", 423)
		}
		return nil, err
	}
	defer lease.Close()
	return fn(snap)
}

type Lease struct{ f *os.File }

func acquireLease(root, name string) (*Lease, error) {
	p, e := jailed(root, name)
	if e != nil {
		return nil, e
	}
	f, e := os.OpenFile(p, os.O_CREATE|os.O_RDWR, 0600)
	if e != nil {
		return nil, fail("lock_unavailable", "无法打开图库写锁。", 503)
	}
	before, statErr := f.Stat()
	after, pathErr := os.Lstat(p)
	if statErr != nil || pathErr != nil || !after.Mode().IsRegular() || reparse(after) || !os.SameFile(before, after) {
		f.Close()
		return nil, fail("lock_unavailable", "图库锁路径发生变化。", 503)
	}
	if e = lockFile(f); e != nil {
		f.Close()
		return nil, fail("library_busy", "图库正在被另一个进程修改。", 423)
	}
	return &Lease{f}, nil
}
func (l *Lease) Close() { unlockFile(l.f); l.f.Close() }
func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Referrer-Policy", "no-referrer")
	w.Header().Set("Cross-Origin-Resource-Policy", "same-origin")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Content-Security-Policy", "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'; font-src 'self' data:; base-uri 'none'; frame-ancestors 'none'; form-action 'none'")
	defer func() {
		if recover() != nil {
			sendError(w, fail("internal_error", "操作未完成，请查看本地诊断。", 500))
		}
	}()
	if r.Host != strings.TrimPrefix(s.origin, "http://") {
		sendError(w, fail("invalid_host", "Forbidden", 403))
		return
	}
	if len(r.Header.Values("X-Giv-Admin")) > 1 || len(r.Header.Values("X-Viewer-Session")) > 1 || len(r.Header.Values("Origin")) > 1 {
		sendError(w, fail("invalid_headers", "Forbidden", 403))
		return
	}
	native := subtle.ConstantTimeCompare([]byte(r.Header.Get("X-Giv-Admin")), []byte(s.boot.Secret)) == 1
	if r.URL.Path == "/api/identity" && r.Method == "GET" {
		challenge, err := hex.DecodeString(r.Header.Get("X-Viewer-Challenge"))
		instanceID, instanceErr := hex.DecodeString(s.boot.Instance)
		parsed, parseErr := net.ResolveTCPAddr("tcp4", strings.TrimPrefix(s.origin, "http://"))
		if err != nil || len(challenge) != 32 || instanceErr != nil || len(instanceID) != 16 || parseErr != nil || parsed.Port <= 0 || parsed.Port > 65535 {
			sendError(w, fail("bad_challenge", "Invalid challenge", 400))
			return
		}
		key, _ := hex.DecodeString(s.boot.Secret)
		port := uint16(parsed.Port)
		pid := uint32(os.Getpid())
		message := make([]byte, 0, 16+32+16+2+4+1)
		message = append(message, []byte("giv-identity-v3\x00")...)
		message = append(message, challenge...)
		message = append(message, instanceID...)
		message = append(message, byte(port>>8), byte(port))
		message = append(message, byte(pid>>24), byte(pid>>16), byte(pid>>8), byte(pid))
		message = append(message, 1)
		h := hmac.New(sha256.New, key)
		_, _ = h.Write(message)
		sendJSON(w, Obj{
			"app":               "grok_imagine_viewer",
			"protocolVersion":   s.boot.ProtocolVersion,
			"instanceId":        s.boot.Instance,
			"pid":               pid,
			"port":              port,
			"serverPath":        s.boot.ServerPath,
			"staticDir":         s.boot.Static,
			"configPath":        s.boot.Config,
			"downloadBindOnly":  s.boot.DownloadBindOnly,
			"challengeResponse": hex.EncodeToString(h.Sum(nil)),
		})
		return
	}
	auth := native
	if !auth {
		if header, ok := r.Header["X-Viewer-Session"]; ok {
			auth = len(header) == 1 && subtle.ConstantTimeCompare([]byte(header[0]), []byte(s.boot.Token)) == 1
		} else if c, e := r.Cookie(s.cookie); e == nil {
			auth = subtle.ConstantTimeCompare([]byte(c.Value), []byte(s.boot.Token)) == 1
		}
	}
	if !auth || strings.HasPrefix(r.URL.Path, "/internal/") && !native {
		sendError(w, fail("unauthorized", "Forbidden", 403))
		return
	}
	// Bound browser-origin work independently of native stop/status/upload requests.
	// Reject overload instead of accumulating goroutines waiting on filesystem scans.
	if !native {
		select {
		case s.requests <- struct{}{}:
			defer func() { <-s.requests }()
		default:
			sendError(w, fail("server_busy", "请求过多，请稍后重试。", 503))
			return
		}
	}
	if r.Method != "GET" && r.Method != "HEAD" {
		if r.Header.Get("Origin") != s.origin || r.Method != "POST" && r.Method != "PUT" {
			sendError(w, fail("invalid_origin", "Forbidden", 403))
			return
		}
	}
	if native && strings.HasPrefix(r.URL.Path, "/internal/download/upload/") {
		s.receiveUpload(w, r)
		return
	}
	var p Obj
	if r.Method == "POST" || r.Method == "PUT" {
		if len(r.TransferEncoding) > 0 || r.ContentLength < 0 {
			sendError(w, fail("invalid_length", "Explicit JSON length required", 400))
			return
		}
		if strings.Split(r.Header.Get("Content-Type"), ";")[0] != "application/json" {
			sendError(w, fail("invalid_content_type", "JSON required", 415))
			return
		}
		limit := int64(1 << 20)
		if native {
			limit = 32 << 20
		}
		b, e := io.ReadAll(http.MaxBytesReader(w, r.Body, limit))
		if e != nil {
			sendError(w, fail("payload_too_large", "请求超过上限。", 413))
			return
		}
		p, e = decode(b)
		if e != nil {
			sendError(w, fail("bad_json", "请求格式无效。", 400))
			return
		}
	}
	q := r.URL.Query()
	path := r.URL.Path
	if path == "/api/health" && r.Method == "GET" {
		port := uint16(0)
		if parsed, err := net.ResolveTCPAddr("tcp4", strings.TrimPrefix(s.origin, "http://")); err == nil && parsed.Port > 0 && parsed.Port <= 65535 {
			port = uint16(parsed.Port)
		}
		if port == 0 {
			sendError(w, fail("backend_unavailable", "Backend is not ready", 503))
			return
		}
		sendJSON(w, Obj{
			"app":             "grok_imagine_viewer",
			"backend":         "go",
			"protocolVersion": s.boot.ProtocolVersion,
			"instanceId":      s.boot.Instance,
			"pid":             os.Getpid(),
			"port":            port,
		})
		return
	}
	var out Obj
	var err error
	if r.Method == "GET" || r.Method == "HEAD" {
		switch path {
		case "/", "/index.html":
			s.serveStatic(w, r, "index.html")
			return
		case "/favicon.ico":
			s.serveStatic(w, r, "../grok_imagine_viewer.ico")
			return
		case "/api/config":
			out, err = s.config(q.Get("minimal") == "1")
		case "/api/environment":
			out = s.environment()
		case "/api/library":
			out, err = s.library(q.Get("refresh") == "1")
		case "/api/combo":
			out, err = s.combo(s.snapshot(), q.Get("section"), q.Get("folder"))
		case "/api/flat":
			out, err = s.flat()
		case "/api/meta":
			snap := s.snapshot()
			view := loadMetaRead(snap.Root)
			out = Obj{"ok": true, "root": snap.Root, "generation": snap.Generation, "meta": view.Meta}
			view.decorate(out)
			if s.stale(snap) {
				err = changed()
			}
		case "/api/views":
			out, err = s.getViews()
		case "/api/preferences":
			out = s.preferencesResponse()
		case "/api/accel":
			out = s.cover.Status()
		case "/api/browse":
			out, err = s.browse(q.Get("path"))
		case "/api/root":
			out = Obj{"ok": true, "root": s.snapshot().Root}
		case "/api/trash":
			out, err = s.trashList(s.snapshot())
		case "/api/trash/file", "/resource/trash/file":
			s.serveTrash(w, r, q.Get("id"))
			return
		case "/api/cover", "/resource/cover":
			s.serveCover(w, r)
			return
		case "/api/download/history":
			if s.taskHistory == nil {
				err = fail("history_unavailable", "任务历史数据库不可用；原有数据库已保留。", 503)
			} else {
				root := s.snapshot().Root
				limit := 50
				if raw := q.Get("limit"); raw != "" {
					if parsed, parseErr := strconv.Atoi(raw); parseErr == nil && parsed >= 1 && parsed <= 200 && len(q["limit"]) == 1 {
						limit = parsed
					} else {
						err = fail("invalid_limit", "历史记录数量参数无效。", 400)
					}
				}
				if expected := q.Get("expectedRoot"); expected != "" && !sameRoot(expected, root) {
					err = changed()
				}
				if err == nil {
					if len(q["cursor"]) > 1 || q.Has("offset") {
						err = fail("invalid_history_cursor", "历史分页已失效，请刷新历史。", 400)
					} else {
						out, err = s.taskHistory.ListPage(root, limit, q.Get("cursor"))
					}
				}
			}
		case "/api/trash/legacy/preview":
			out, err = s.legacyTrashPreview(q.Get("expectedRoot"), q.Get("id"))
		case "/api/download/status":
			status := s.downloadStatus()
			out = Obj{"ok": true, "active": status["active"], "runId": status["runId"], "phase": status["phase"], "counts": status["counts"], "statusLine": status["statusLine"]}
		case "/internal/download/status":
			out = s.downloadStatus()
		default:
			if strings.HasPrefix(path, "/static/") {
				s.serveStatic(w, r, strings.TrimPrefix(path, "/static/"))
				return
			}
			if strings.HasPrefix(path, "/media/") {
				s.serveMedia(w, r)
				return
			}
			err = fail("not_found", "Not found", 404)
		}
	} else {
		switch path {
		case "/api/root":
			root := str(p["root"])
			if root == "" {
				root = str(p["path"])
			}
			out, err = s.selectRoot(root)
		case "/api/download/bind":
			// The Rust native client sends the session header explicitly. An
			// HttpOnly browser cookie is sufficient for ordinary gallery APIs,
			// but must not grant authority to bind a Grok account.
			if !s.boot.DownloadBindOnly {
				err = fail("not_found", "Not found", 404)
			} else if !native && r.Header.Get("X-Viewer-Session") == "" {
				err = fail("unauthorized", "Native account verification required", 403)
			} else if r.Method != http.MethodPut {
				err = fail("method_not_allowed", "PUT required", 405)
			} else {
				out, err = s.bindDownloadAccount(p)
			}
		case "/api/library/create":
			out, err = s.createLibrary(p)
		case "/api/history/remove", "/api/history/clear":
			out, err = s.editHistory(p, path == "/api/history/clear")
		case "/api/preferences":
			out, err = s.savePreferences(p)
		case "/api/volume":
			out, err = s.saveVolume(p)
		case "/api/views":
			out, err = s.withWrite(p, false, func(snap Snapshot) (Obj, error) {
				file, e := jailed(snap.Root, ".viewer-config.json")
				if e != nil {
					return nil, e
				}
				cfg, e := readJSON(file)
				if e != nil {
					return nil, e
				}
				views := normalizeViews(p["views"])
				cfg["views"] = views
				e = atomicJSON(file, cfg)
				return Obj{"ok": e == nil, "root": snap.Root, "views": views}, e
			})
		case "/api/meta":
			out, err = s.withMetadataWrite(p, func(snap Snapshot) (Obj, error) { return s.patchMeta(snap, p) })
		case "/api/cards":
			out, err = s.cards(p)
		case "/api/duration":
			out, err = s.withWrite(p, false, func(snap Snapshot) (Obj, error) { return s.cover.Duration(snap, p) })
		case "/api/cover/prepare":
			out, err = s.prepareCover(p)
		case "/api/accel":
			out, err = s.cover.Set(p)
		case "/api/save-copy":
			out, err = s.withWrite(p, false, func(snap Snapshot) (Obj, error) { return s.saveCopy(snap, p) })
		case "/api/trash":
			out, err = s.withWrite(p, false, func(snap Snapshot) (Obj, error) { return s.trashAdd(snap, p) })
		case "/api/trash/restore", "/api/trash/purge":
			out, err = s.withWrite(p, false, func(snap Snapshot) (Obj, error) { return s.trashChange(snap, p, path == "/api/trash/purge") })
		case "/api/library/dedup":
			out, err = s.dedup(p)
		case "/api/reveal":
			out, err = s.reveal(p)
		case "/internal/download/reserve":
			out, err = s.reserveDownload(p)
		case "/internal/download/prompt-targets":
			out, err = s.promptTargets(r.Context(), p)
		case "/internal/download/start":
			out, err = s.startDownload(p)
		case "/internal/download/stop":
			var run *DownloadRun
			run, err = s.currentRun(p)
			if err == nil {
				run.cancel()
				run.mu.Lock()
				started := run.started
				run.mu.Unlock()
				if !started {
					run.finish(false, "cancelled")
				}
				out = Obj{"ok": true, "stopped": true}
			}
		case "/internal/download/authorize":
			out, err = s.authorizeDownload(p)
		case "/internal/download/failure":
			out, err = s.uploadFailed(p)
		case "/internal/acceleration":
			out, err = s.savePlayback(p)
		default:
			err = fail("not_found", "Not found", 404)
		}
	}
	if err != nil {
		sendError(w, err)
	} else {
		if r.Method == "HEAD" {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(200)
		} else {
			sendJSON(w, out)
		}
	}
}
func sendJSON(w http.ResponseWriter, o any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	_ = json.NewEncoder(w).Encode(o)
}
func sendError(w http.ResponseWriter, e error) {
	out := Obj{"ok": false, "code": "io_error", "error": "读取或写入失败；原有数据已保留。"}
	status := 503
	var a *APIError
	if errors.As(e, &a) {
		out["code"] = a.Code
		out["error"] = a.Message
		status = a.Status
		for k, v := range a.Extra {
			out[k] = v
		}
	}
	out["status"] = status
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(out)
}
func (s *Server) serveStatic(w http.ResponseWriter, r *http.Request, rel string) {
	root := s.boot.Static
	if rel == "../grok_imagine_viewer.ico" {
		root = filepath.Dir(root)
		rel = "grok_imagine_viewer.ico"
	}
	p, e := jailed(root, rel)
	if e != nil {
		sendError(w, fail("invalid_path", "Forbidden", 403))
		return
	}
	serveLocal(w, r, p, false)
}
func serveLocal(w http.ResponseWriter, r *http.Request, p string, media bool) {
	f, e := openRegular(p)
	if e != nil {
		sendError(w, fail("missing_file", "文件不存在或不可访问。", 404))
		return
	}
	defer f.Close()
	st, e := f.Stat()
	if e != nil {
		sendError(w, e)
		return
	}
	if media {
		w.Header().Set("Cache-Control", "private, max-age=0, must-revalidate")
	}
	w.Header().Set("ETag", fmt.Sprintf("\"%x-%x\"", st.Size(), st.ModTime().UnixNano()))
	http.ServeContent(w, r, filepath.Base(p), st.ModTime(), f)
}
