package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

const maxMedia int64 = 512 << 20
const maxTask int64 = 256 << 30

// Allow roughly 1 MiB/s plus setup, with finite per-stage bounds. Unknown sizes
// receive the maximum-media budget, rather than a faster-storage assumption.
func mediaTimeout(size *int64) time.Duration {
	bytes := maxMedia
	if size != nil && *size > 0 && *size <= maxMedia {
		bytes = *size
	}
	seconds := int64(30) + (bytes+(1<<20)-1)/(1<<20)
	return time.Duration(max(120, min(600, seconds))) * time.Second
}

var errLocalSizeMismatch = errors.New("local_size_mismatch")

var stableID = regexp.MustCompile(`^[A-Za-z0-9_-]{1,200}$`)
var keyPart = regexp.MustCompile(`^[A-Za-z0-9._~-]+$`)

type Asset struct {
	ID       string  `json:"id"`
	Mime     string  `json:"mime"`
	Size     *int64  `json:"sz"`
	Time     string  `json:"t"`
	Key      string  `json:"key"`
	Source   string  `json:"src"`
	Conv     string  `json:"conv"`
	RootConv string  `json:"rootConv"`
	Kind     string  `json:"kind"`
	Prompt   string  `json:"prompt"`
	Parent   *string `json:"parent"`
	Quality  string  `json:"quality"`
	Variant  *string `json:"variantOf"`
	Remote   string  `json:"remoteUrl"`
}
type Conversation struct {
	ID    string `json:"id"`
	Title string `json:"title"`
	Time  string `json:"t"`
}
type Manifest struct {
	Complete      bool           `json:"complete"`
	Assets        []Asset        `json:"assets"`
	Conversations []Conversation `json:"conversations"`
	PromptUpdates []PromptUpdate `json:"promptUpdates,omitempty"`
}

func assetExt(a Asset) string {
	switch a.Mime {
	case "image/jpeg":
		return ".jpg"
	case "image/png":
		return ".png"
	case "image/webp":
		return ".webp"
	case "image/gif":
		return ".gif"
	case "video/mp4":
		return ".mp4"
	case "video/webm":
		return ".webm"
	}
	return ""
}
func mediaURLFor(key string) (string, error) {
	if key == "" || len(key) > 1024 {
		return "", errors.New("invalid_asset_key")
	}
	u, _ := url.Parse("https://assets.grok.com/")
	parts := strings.Split(key, "/")
	for _, p := range parts {
		if p == "." || p == ".." || !keyPart.MatchString(p) {
			return "", errors.New("invalid_asset_key")
		}
	}
	u.Path = "/" + strings.Join(parts, "/")
	u.RawQuery = "cache=1"
	return u.String(), nil
}
func allowedMediaURL(u *url.URL) bool {
	return u.Scheme == "https" && (u.Hostname() == "assets.grok.com" || u.Hostname() == "imagine-public.x.ai") && (u.Port() == "" || u.Port() == "443") && u.User == nil && u.Fragment == ""
}
func validateManifest(p Obj) (Manifest, error) {
	var m Manifest
	b, e := json.Marshal(p)
	if e != nil {
		return m, e
	}
	if e = json.Unmarshal(b, &m); e != nil {
		return m, errors.New("invalid_manifest_types")
	}
	if !m.Complete || m.Assets == nil || m.Conversations == nil || len(m.Assets) > 200000 || len(m.Conversations) > 200000 {
		return m, errors.New("incomplete_manifest")
	}
	seen := map[string]bool{}
	var total int64
	for _, a := range m.Assets {
		key := strings.ToLower(a.ID)
		if !stableID.MatchString(a.ID) || seen[key] || len(a.Prompt) > 400000 || len(a.Mime) > 100 {
			return m, errors.New("invalid_or_duplicate_asset")
		}
		seen[key] = true
		if _, e = mediaURLFor(a.Key); e != nil {
			return m, e
		}
		for _, id := range []string{a.Conv, a.RootConv} {
			if id != "" && !stableID.MatchString(id) {
				return m, errors.New("invalid_group_id")
			}
		}
		if a.Size != nil {
			if *a.Size < 0 || *a.Size > 1<<30 {
				return m, errors.New("invalid_asset_size")
			}
			total += *a.Size
			if total > 2<<40 {
				return m, errors.New("manifest_budget")
			}
		}
	}
	seen = map[string]bool{}
	for _, c := range m.Conversations {
		key := strings.ToLower(c.ID)
		if !stableID.MatchString(c.ID) || seen[key] || len(c.Title) > 40000 {
			return m, errors.New("invalid_conversation")
		}
		seen[key] = true
	}
	if e = validatePromptUpdates(m.PromptUpdates); e != nil {
		return m, e
	}
	return m, nil
}

type transferError struct {
	Code       string
	Status     int
	RetryAfter time.Duration
}

func (e *transferError) Error() string { return e.Code }

type transferResult struct {
	Asset                Asset
	Part, Token, Backend string
	Bytes                int64
	Err                  error
	Attempt              int
	Elapsed              int64
}
type uploadTicket struct {
	Asset     Asset
	Part      string
	Done      chan transferResult
	Uploading bool
	Completed bool
	ctx       context.Context
	cancel    context.CancelCauseFunc
}
type DownloadRun struct {
	fallbackGate   chan struct{}
	s              *Server
	Snap           Snapshot
	ID             uint64
	Token, User    string
	RetryOf        string
	RetryAssetIDs  []string
	ctx            context.Context
	cancel         context.CancelFunc
	lease          *Lease
	mu             sync.Mutex
	Phase, Line    string
	Counts         Obj
	Failures       []any
	Tickets        map[string]*uploadTicket
	Result         Obj
	started        bool
	finishOnce     sync.Once
	done           chan struct{}
	authorize      chan string
	uploads        sync.WaitGroup
	uploadsClosed  bool
	taskBytes      atomic.Int64
	http           *http.Client
	linkMedia      func(string, string) error
	promptUser     string
	promptTargets  map[string]promptTargetBinding
	promptReadCard func(string) (Obj, error)
}

func (s *Server) downloadActive() bool {
	s.runMu.Lock()
	r := s.run
	s.runMu.Unlock()
	if r == nil {
		return false
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.Result == nil
}
func (s *Server) reserveDownload(p Obj) (Obj, error) {
	if s.taskHistory == nil {
		return nil, fail("history_unavailable", "任务历史数据库不可用；下载未开始，原有数据库已保留。", 503)
	}
	s.gate.Lock()
	defer s.gate.Unlock()
	snap := s.snapshot()
	if snap.Root == "" || snap.Mode != "index" {
		return nil, fail("unsupported_library", "下载需要完整的索引图库。", 409)
	}
	if !sameRoot(str(p["root"]), snap.Root) {
		return nil, changed()
	}
	if s.downloadActive() {
		return nil, fail("download_busy", "已有下载任务。", 423)
	}
	retryOf := str(p["retryOf"])
	retryAssetIDs := []string{}
	if raw, present := p["retryAssetIds"]; present {
		values, ok := raw.([]any)
		if !ok {
			return nil, fail("invalid_retry", "重试素材列表格式无效。", 400)
		}
		if len(values) > 200 {
			return nil, fail("invalid_retry", "单次最多重试 200 个素材。", 400)
		}
		seen := make(map[string]struct{}, len(values))
		for _, value := range values {
			id, ok := value.(string)
			if !ok || !stableID.MatchString(id) {
				return nil, fail("invalid_retry", "重试素材标识无效。", 400)
			}
			if _, exists := seen[id]; exists {
				return nil, fail("invalid_retry", "重试素材列表包含重复项目。", 400)
			}
			seen[id] = struct{}{}
			retryAssetIDs = append(retryAssetIDs, id)
		}
	}
	if (retryOf == "") != (len(retryAssetIDs) == 0) || len(retryOf) > 128 {
		return nil, fail("invalid_retry", "重试记录与素材列表必须同时提供。", 400)
	}
	lease, e := acquireLease(snap.Root, ".viewer-write.lock")
	if e != nil {
		return nil, e
	}
	ctx, cancel := context.WithCancel(s.ctx)
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.DialContext = (&net.Dialer{Timeout: 10 * time.Second, KeepAlive: 30 * time.Second}).DialContext
	transport.MaxIdleConnsPerHost = 4
	transport.MaxConnsPerHost = 4
	transport.ResponseHeaderTimeout = 15 * time.Second
	client := &http.Client{Transport: transport, Timeout: 10 * time.Minute, CheckRedirect: func(req *http.Request, via []*http.Request) error {
		if len(via) > 3 || !allowedMediaURL(req.URL) {
			return errors.New("redirect_refused")
		}
		req.Header.Del("Cookie")
		req.Header.Del("Authorization")
		return nil
	}}
	s.runMu.Lock()
	s.nextRun++
	r := &DownloadRun{s: s, Snap: snap, ID: s.nextRun, Token: token(), RetryOf: retryOf, RetryAssetIDs: retryAssetIDs, ctx: ctx, cancel: cancel, lease: lease, Phase: "listing", Counts: Obj{"total": 0, "attempted": 0, "succeeded": 0, "failed": 0, "skipped": 0}, Failures: []any{}, Tickets: map[string]*uploadTicket{}, authorize: make(chan string, 1), http: client, done: make(chan struct{}), fallbackGate: make(chan struct{}, 1)}
	if e = s.taskHistory.Start(r.Token, r.ID, snap.Root, r.RetryOf); e != nil {
		s.runMu.Unlock()
		cancel()
		lease.Close()
		client.CloseIdleConnections()
		return nil, fail("history_unavailable", "无法保存任务历史，未开始下载。", 503)
	}
	s.run = r
	s.runMu.Unlock()
	return Obj{"ok": true, "runId": r.ID, "root": snap.Root}, nil
}
func (s *Server) currentRun(p Obj) (*DownloadRun, error) {
	s.runMu.Lock()
	r := s.run
	s.runMu.Unlock()
	if r == nil || uint64(num(p["runId"])) != r.ID {
		return nil, fail("stale_run", "下载任务已失效。", 409)
	}
	return r, nil
}
func (s *Server) startDownload(p Obj) (Obj, error) {
	r, e := s.currentRun(p)
	if e != nil {
		return nil, e
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.started || r.Result != nil || r.ctx.Err() != nil {
		return nil, fail("stale_run", "下载任务已结束。", 409)
	}
	if e = validatePromptInput(obj(p["manifest"])); e != nil {
		return nil, fail("invalid_manifest", "提示词补全目标格式无效。", 409)
	}
	m, e := validateManifest(obj(p["manifest"]))
	if e != nil {
		return nil, fail("invalid_manifest", "清单不完整或格式异常；未写入图库。", 409)
	}
	user := str(p["userId"])
	if !stableID.MatchString(user) {
		return nil, fail("invalid_account", "账号校验失败。", 409)
	}
	if e = r.bindPromptUpdates(&m, user); e != nil {
		return nil, fail("invalid_manifest", "提示词补全目标已失效。", 409)
	}
	if r.RetryOf != "" {
		if e = s.taskHistory.ValidateRetry(r.Snap.Root, r.RetryOf, r.RetryAssetIDs); e != nil {
			return nil, e
		}
	}
	r.User = user
	r.started = true
	r.Phase = "starting"
	go r.process(m)
	return Obj{"ok": true, "runId": r.ID}, nil
}
func (s *Server) stopDownloads() {
	s.runMu.Lock()
	r := s.run
	s.runMu.Unlock()
	if r == nil {
		return
	}
	r.cancel()
	r.mu.Lock()
	started := r.started
	r.mu.Unlock()
	if !started {
		r.finish(false, "cancelled")
	}
}
func (r *DownloadRun) finish(published bool, code string) {
	r.finishOnce.Do(func() {
		if r.done != nil {
			defer close(r.done)
		}
		r.cancel()
		r.drainUploads()
		r.http.CloseIdleConnections()
		r.lease.Close()
		r.mu.Lock()
		defer r.mu.Unlock()
		stopped := code == "cancelled"
		ok := code == "" && num(r.Counts["failed"]) == 0
		result := Obj{"resultVersion": 1, "historyState": "unavailable", "warnings": []string{}, "finishedAt": time.Now().UTC().Format(time.RFC3339Nano), "ok": ok, "stopped": stopped, "published": published, "counts": clone(r.Counts), "failures": r.Failures, "runId": r.ID, "code": code}
		if !ok && !stopped {
			result["error"] = "部分素材未完成，请查看失败详情。"
			if code != "" {
				result["error"] = downloadMessage(code)
			}
		}
		r.Phase = "finished"
		if r.s.taskHistory != nil {
			state := r.s.taskHistory.Complete(r.Token, r.Snap.Root, result)
			result["historyState"] = state
			if state != "persisted" {
				result["warnings"] = []string{"history_persistence_pending"}
				result["historyWarning"] = "任务结果未能写入历史，请保留诊断。"
			}
		}
		r.Result = result
		r.Tickets = map[string]*uploadTicket{}
	})
}
func downloadMessage(code string) string {
	switch code {
	case "staging_cleanup_pending", "journal_cleanup_pending":
		return "素材已保存，清理临时文件尚未完成；下次同步会验证后继续整理。"
	case "account_mismatch":
		return "当前登录账号与这个图库不一致。"
	case "legacy_recovery_required":
		return "图库存在 Tauri 未完成的下载事务；请先用原版恢复完成，再使用此分支。"
	case "empty_manifest_guard":
		return "远端返回空清单，本地图库非空；已保留原索引。"
	case "local_size_mismatch":
		return "本地素材大小与远端清单不一致；已保留原文件，请检查后重试。"
	case "insufficient_space":
		return "磁盘空间不足，已有数据和恢复记录已保留。"
	case "account_unverified":
		return "未能再次确认同一登录账号，下载文件已保留，暂未发布索引。"
	case "recovery_invalid":
		return "下载恢复记录无效，已停止并保留现场。"
	default:
		return "下载或发布未完成，恢复记录已保留。"
	}
}
func (r *DownloadRun) line(text string) {
	r.mu.Lock()
	r.Line = fmt.Sprintf("run %d %s", r.ID, text)
	r.mu.Unlock()
}
func (s *Server) downloadStatus() Obj {
	s.runMu.Lock()
	r := s.run
	s.runMu.Unlock()
	if r == nil {
		return Obj{"ok": true, "active": false}
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	tickets := []any{}
	for id, t := range r.Tickets {
		if !t.Uploading && !t.Completed {
			tickets = append(tickets, Obj{"ticket": id, "asset": t.Asset, "timeoutSeconds": int64(mediaTimeout(t.Asset.Size) / time.Second)})
		}
	}
	return Obj{"ok": true, "active": r.Result == nil, "runId": r.ID, "phase": r.Phase, "counts": clone(r.Counts), "statusLine": r.Line, "tickets": tickets, "result": r.Result}
}
func (s *Server) authorizeDownload(p Obj) (Obj, error) {
	r, e := s.currentRun(p)
	if e != nil {
		return nil, e
	}
	r.mu.Lock()
	phase := r.Phase
	r.mu.Unlock()
	if phase != "verify_account" {
		return nil, fail("wrong_phase", "下载状态已经变化。", 409)
	}
	select {
	case r.authorize <- str(p["userId"]):
		return Obj{"ok": true}, nil
	default:
		return nil, fail("already_authorized", "确认已处理。", 409)
	}
}
func (r *DownloadRun) bind() error {
	if err := r.ctx.Err(); err != nil {
		return err
	}
	if r.s.stale(r.Snap) {
		return changed()
	}
	// A short descriptive update must not abort a download as an account
	// mismatch. Retain gallery -> metadata order, bounded contention waits,
	// and cancellation before both lease admission and publication.
	var lease *Lease
	var e error
	for attempt := 0; ; attempt++ {
		lease, e = acquireLease(r.Snap.Root, ".viewer-meta.lock")
		if e == nil {
			break
		}
		var api *APIError
		if !errors.As(e, &api) || api.Code != "library_busy" {
			return e
		}
		if attempt >= 7 {
			return fail("meta_busy", "元数据正在被另一个进程修改，请稍后重试。", 423)
		}
		delay := min(20*time.Millisecond*time.Duration(1<<attempt), 250*time.Millisecond)
		timer := time.NewTimer(delay)
		select {
		case <-r.ctx.Done():
			timer.Stop()
			return r.ctx.Err()
		case <-timer.C:
		}
	}
	defer lease.Close()
	if e = r.ctx.Err(); e != nil {
		return e
	}
	if r.s.stale(r.Snap) {
		return changed()
	}
	meta, e := loadMeta(r.Snap.Root)
	if e != nil {
		return e
	}
	bound := str(meta["grokUserId"])
	if value := meta["grokUserId"]; value != nil {
		if _, ok := value.(string); !ok || bound != "" && !stableID.MatchString(bound) {
			return fail("store_corrupt", "图库账号记录无效，原文件已保留。", 409)
		}
	}
	if bound != "" && bound != r.User {
		return errors.New("account_mismatch")
	}
	if bound == "" {
		if num(meta["revision"]) >= 1<<53-1 {
			return fail("revision_exhausted", "元数据版本已达上限。", 409)
		}
		meta["grokUserId"] = r.User
		meta["revision"] = num(meta["revision"]) + 1
		body, err := json.MarshalIndent(meta, "", "  ")
		if err != nil {
			return err
		}
		return atomicBytesGuarded(filepath.Join(r.Snap.Root, ".viewer-meta.json"), append(body, '\n'), func() error {
			if err := r.ctx.Err(); err != nil {
				return err
			}
			if r.s.stale(r.Snap) {
				return changed()
			}
			return nil
		})
	}
	return nil
}

func downloadBindCode(err error) string {
	if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
		return "cancelled"
	}
	var api *APIError
	if errors.As(err, &api) {
		return api.Code
	}
	if err.Error() == "account_mismatch" {
		return "account_mismatch"
	}
	return "metadata_write_failed"
}
func (r *DownloadRun) scanExisting(m Manifest) (map[string]string, map[string]bool, error) {
	want := map[string]Asset{}
	for _, a := range m.Assets {
		want[a.ID] = a
	}
	out := map[string]string{}
	trashed := map[string]bool{}
	trashDir, e := jailed(r.Snap.Root, filepath.Join(".trash", "by-id"))
	if e != nil {
		return nil, nil, e
	}
	entries, e := os.ReadDir(trashDir)
	if e != nil && !os.IsNotExist(e) {
		return nil, nil, e
	}
	for _, d := range entries {
		if strings.HasSuffix(d.Name(), ".json") {
			id := strings.TrimSuffix(d.Name(), ".json")
			if safeName(id) {
				trashed[id] = true
			}
		}
	}
	for _, section := range []string{"combos", "_other", "_inbox"} {
		parent, e := jailed(r.Snap.Root, section)
		if e != nil {
			return nil, nil, e
		}
		dirs, e := os.ReadDir(parent)
		if e != nil && !os.IsNotExist(e) {
			return nil, nil, e
		}
		for _, d := range dirs {
			if r.ctx.Err() != nil {
				return nil, nil, r.ctx.Err()
			}
			if !d.IsDir() || !safeName(d.Name()) {
				continue
			}
			dir, e := jailed(r.Snap.Root, filepath.Join(section, d.Name()))
			if e != nil {
				return nil, nil, e
			}
			files, e := os.ReadDir(dir)
			if e != nil {
				return nil, nil, e
			}
			for _, f := range files {
				if f.IsDir() {
					continue
				}
				name := f.Name()
				id := strings.TrimSuffix(name, filepath.Ext(name))
				a, ok := want[id]
				if !ok || out[id] != "" || trashed[id] || name != id+assetExt(a) {
					continue
				}
				p, e := jailed(dir, name)
				if e != nil {
					continue
				}
				if a.Size != nil && *a.Size > 0 {
					if st, err := regular(p); err == nil && st.Size() != *a.Size {
						return nil, nil, errLocalSizeMismatch
					}
				}
				if e = validateMediaFile(p, a.Mime, 0); e == nil {
					out[id] = p
				}
			}
		}
	}
	return out, trashed, nil
}
func (r *DownloadRun) transactionPath(rel string) (string, error) {
	return jailed(r.Snap.Root, filepath.Join("_state", ".giv-go-tx", r.Token, rel))
}
func (r *DownloadRun) journal(phase string, m Manifest) error {
	mp, e := r.transactionPath("manifest.json")
	if e != nil {
		return e
	}
	doc := Obj{"version": 1, "runToken": r.Token, "userId": r.User, "manifest": m}
	if !exists(mp) {
		if e = atomicJSON(mp, doc); e != nil {
			return e
		}
	}
	b, e := os.ReadFile(mp)
	if e != nil {
		return e
	}
	header, e := jailed(r.Snap.Root, filepath.Join("_state", ".giv-go-download.json"))
	if e != nil {
		return e
	}
	return atomicJSON(header, Obj{"version": 1, "runToken": r.Token, "manifestSha256": hash(b), "phase": phase})
}
func (r *DownloadRun) record(a Asset, tk string, n int64, state string) error {
	p, e := r.transactionPath(filepath.Join("items", a.ID+".json"))
	if e != nil {
		return e
	}
	o := Obj{"assetId": a.ID, "extension": assetExt(a), "partToken": tk, "bytes": n, "state": state}
	if state == "ready" || state == "committed" {
		part, final, err := r.part(a, tk)
		if err != nil {
			return err
		}
		path := part
		if state == "committed" {
			path = final
		}
		fp, err := fingerprint(path)
		if err != nil || num(fp["size"]) != n {
			return errors.New("record_fingerprint_failed")
		}
		o["hash"] = fp["hash"]
	}
	return atomicJSON(p, o)
}
func (r *DownloadRun) part(a Asset, tk string) (string, string, error) {
	rel := filepath.Join("_inbox", "0000_inbox", a.ID+assetExt(a))
	final, e := jailed(r.Snap.Root, rel)
	if e != nil {
		return "", "", e
	}
	return final + ".giv-go-" + tk + ".part", final, nil
}
func (r *DownloadRun) process(m Manifest) {
	published := false
	code := ""
	defer func() {
		if recover() != nil {
			code = "internal_error"
		}
		if r.ctx.Err() != nil && code == "" {
			code = "cancelled"
		}
		r.finish(published, code)
		r.s.invalidate()
	}()
	if legacy, e := jailed(r.Snap.Root, filepath.Join("_state", ".giv-download-journal-v1.json")); e != nil || exists(legacy) {
		code = "legacy_recovery_required"
		return
	}
	if len(m.Assets) == 0 && len(m.PromptUpdates) == 0 {
		idx, _ := readJSON(filepath.Join(r.Snap.Root, "_index.json"))
		if len(rows(idx["combos"]))+len(rows(idx["other"])) > 0 {
			code = "empty_manifest_guard"
			return
		}
	}
	if e := r.bind(); e != nil {
		code = downloadBindCode(e)
		return
	}
	recovered, recoveryErr := r.recoverPreviousOutcome()
	published = recovered.IndexPublished
	if recoveryErr != nil {
		code = "recovery_invalid"
		return
	}
	if len(m.Assets) == 0 && len(m.PromptUpdates) > 0 {
		if r.RetryOf != "" {
			code = "retry_manifest_mismatch"
			return
		}
		var promptPublished bool
		promptPublished, code = r.processPromptOnly(m)
		published = published || promptPublished
		return
	}
	selectedAssets := m.Assets
	if r.RetryOf != "" {
		selected := make(map[string]struct{}, len(r.RetryAssetIDs))
		for _, id := range r.RetryAssetIDs {
			selected[id] = struct{}{}
		}
		filtered := make([]Asset, 0, len(selected))
		for _, asset := range m.Assets {
			if _, ok := selected[asset.ID]; ok {
				filtered = append(filtered, asset)
				delete(selected, asset.ID)
			}
		}
		if len(selected) != 0 || len(filtered) == 0 {
			code = "retry_manifest_mismatch"
			return
		}
		// Retain the complete manifest in the journal and publication. Selection
		// limits transfers only; recovery and index totals still describe the library.
		selectedAssets = filtered
	}
	existing, trashed, e := r.scanExisting(m)
	if e != nil {
		code = "local_scan_failed"
		if errors.Is(e, errLocalSizeMismatch) {
			code = "local_size_mismatch"
		}
		return
	}
	tasks := []Asset{}
	var required int64
	skipped := 0
	for _, a := range selectedAssets {
		if assetExt(a) == "" || existing[a.ID] != "" || trashed[a.ID] {
			skipped++
			continue
		}
		tasks = append(tasks, a)
		size := maxMedia
		if a.Size != nil && *a.Size > 0 {
			size = *a.Size
		}
		required += size
		if required > maxTask {
			code = "task_budget"
			return
		}
	}
	if n, e := freeSpace(r.Snap.Root); e != nil || n < uint64(required*2+512<<20) {
		code = "insufficient_space"
		return
	}
	r.mu.Lock()
	r.Counts["total"] = len(tasks)
	r.Counts["skipped"] = skipped
	r.Phase = "transferring"
	r.mu.Unlock()
	r.line(fmt.Sprintf("local %d missing %d", len(existing), len(tasks)))
	if e = r.journal("media", m); e != nil {
		code = "journal_failed"
		return
	}
	dir, e := jailed(r.Snap.Root, filepath.Join("_inbox", "0000_inbox"))
	if e != nil {
		code = "unsafe_stage"
		return
	}
	if e = os.MkdirAll(dir, 0700); e != nil {
		code = "storage_failed"
		return
	}
	jobs := make(chan Asset)
	results := make(chan transferResult, 3)
	var workers sync.WaitGroup
	for i := 0; i < 3; i++ {
		workers.Add(1)
		go func() {
			defer workers.Done()
			for a := range jobs {
				if r.ctx.Err() != nil {
					continue
				}
				tk := token()
				part, _, e := r.part(a, tk)
				if e == nil {
					e = r.record(a, tk, 0, "receiving")
				}
				res := transferResult{Asset: a, Part: part, Token: tk, Err: e}
				if e == nil {
					res = r.transfer(a, part)
					res.Token = tk
				}
				results <- res
			}
		}()
	}
	go func() {
		defer close(jobs)
		for _, a := range tasks {
			select {
			case jobs <- a:
			case <-r.ctx.Done():
				return
			}
		}
	}()
	go func() { workers.Wait(); close(results) }()
	fatal := false
	for res := range results {
		if res.Err == nil && !fatal && r.ctx.Err() == nil {
			if r.taskBytes.Add(res.Bytes) > maxTask {
				res.Err = &transferError{Code: "task_size_limit"}
				fatal = true
				code = "task_size_limit"
				r.cancel()
			} else if n, e := freeSpace(r.Snap.Root); e != nil || n < uint64(res.Bytes+(512<<20)) {
				res.Err = &transferError{Code: "insufficient_space"}
				fatal = true
				code = "insufficient_space"
				r.cancel()
			} else if e = r.commit(res); e != nil {
				res.Err = &transferError{Code: "commit_uncertain"}
				fatal = true
				code = "commit_uncertain"
				r.cancel()
			} else {
				_, final, _ := r.part(res.Asset, res.Token)
				existing[res.Asset.ID] = final
			}
		}
		if res.Err != nil || fatal || r.ctx.Err() != nil {
			if !fatal && res.Part != "" {
				_ = os.Remove(res.Part)
			}
			r.mu.Lock()
			r.Counts["failed"] = num(r.Counts["failed"]) + 1
			if len(r.Failures) < 200 {
				errCode := "cancelled"
				status := 0
				var te *transferError
				if errors.As(res.Err, &te) {
					errCode = te.Code
					status = te.Status
				} else if res.Err != nil {
					errCode = "transfer_failed"
				}
				detail := Obj{"backend": res.Backend, "assetId": res.Asset.ID, "stage": "transfer", "code": errCode, "message": transferMessage(errCode), "retryable": retryableTransfer(res.Err), "attempt": res.Attempt, "elapsedMs": res.Elapsed, "receivedBytes": res.Bytes}
				if status > 0 {
					detail["httpStatus"] = status
				}
				if res.Asset.Size != nil {
					detail["expectedBytes"] = *res.Asset.Size
				}
				r.Failures = append(r.Failures, detail)
			}
			r.mu.Unlock()
		} else {
			r.mu.Lock()
			r.Counts["succeeded"] = num(r.Counts["succeeded"]) + 1
			r.mu.Unlock()
		}
		r.mu.Lock()
		r.Counts["attempted"] = num(r.Counts["attempted"]) + 1
		r.Line = fmt.Sprintf("run %d download %d/%d success %d failed %d", r.ID, num(r.Counts["attempted"]), len(tasks), num(r.Counts["succeeded"]), num(r.Counts["failed"]))
		r.mu.Unlock()
	}
	r.drainUploads()
	if fatal || r.ctx.Err() != nil {
		return
	}
	r.mu.Lock()
	r.Phase = "verify_account"
	r.mu.Unlock()
	select {
	case user := <-r.authorize:
		if user != r.User {
			code = "account_unverified"
			return
		}
	case <-time.After(60 * time.Second):
		code = "account_unverified"
		return
	case <-r.ctx.Done():
		return
	}
	if e = r.bind(); e != nil {
		code = downloadBindCode(e)
		return
	}
	if e = r.journal("publishing", m); e != nil {
		code = "journal_failed"
		return
	}
	r.mu.Lock()
	r.Phase = "publishing"
	r.mu.Unlock()
	if e = r.publish(m, existing, trashed); e != nil {
		code = "publish_failed"
		return
	}
	published = true
	if e = r.applyPromptUpdates(m); e != nil {
		code = "prompt_update_failed"
		return
	}
	if e = r.releasePublishedInbox(m); e != nil {
		code = "staging_cleanup_pending"
		return
	}
	if e = r.retireTransaction(); e != nil {
		code = "journal_cleanup_pending"
		return
	}
}
func (r *DownloadRun) commit(res transferResult) error {
	if e := validateMediaFile(res.Part, res.Asset.Mime, res.Bytes); e != nil {
		return e
	}
	if e := r.record(res.Asset, res.Token, res.Bytes, "ready"); e != nil {
		return e
	}
	_, final, e := r.part(res.Asset, res.Token)
	if e != nil {
		return e
	}
	if exists(final) {
		return errors.New("destination_exists")
	}
	e = publishNoReplace(res.Part, final)
	if e != nil {
		return e
	}
	if e = validateMediaFile(final, res.Asset.Mime, res.Bytes); e != nil {
		return e
	}
	return r.record(res.Asset, res.Token, res.Bytes, "committed")
}
func (r *DownloadRun) transfer(a Asset, part string) transferResult {
	started := time.Now()
	result := transferResult{Asset: a, Part: part, Backend: "go-http"}
	if a.Size != nil && *a.Size > maxMedia {
		result.Err = &transferError{Code: "size_limit"}
		return result
	}
	public := true
	var last error
	for attempt := 1; attempt <= 3; attempt++ {
		result.Attempt = attempt
		if r.ctx.Err() != nil {
			last = r.ctx.Err()
			break
		}
		if public {
			result.Bytes, last = r.fetchPublic(a, part)
			if last == nil {
				break
			}
			var te *transferError
			if errors.As(last, &te) && (te.Status == 401 || te.Status == 403) {
				public = false
				_ = os.Remove(part)
			} else if errors.As(last, &te) && te.Status == 429 {
				if attempt == 3 {
					break
				}
				wait := te.RetryAfter
				if wait < time.Second {
					wait = time.Duration(1<<attempt) * time.Second
				}
				if wait > 60*time.Second {
					wait = 60 * time.Second
				}
				select {
				case <-time.After(wait):
					continue
				case <-r.ctx.Done():
					last = r.ctx.Err()
				}
				break
			} else if !retryableTransfer(last) {
				break
			} else if attempt < 2 {
				select {
				case <-time.After(time.Duration(attempt) * time.Second):
					continue
				case <-r.ctx.Done():
					last = r.ctx.Err()
				}
				break
			} else {
				public = false
			}
		}
		if !public {
			result.Backend = "tauri-webview-session"
			reply := r.fallback(a, part)
			result.Bytes = reply.Bytes
			last = reply.Err
			break
		}
	}
	result.Elapsed = time.Since(started).Milliseconds()
	result.Err = last
	return result
}

// Retry only transient network/server failures. Validation and storage failures
// must not fall through to a second transport or overwrite their evidence.
func retryableTransfer(err error) bool {
	var te *transferError
	if !errors.As(err, &te) {
		return false
	}
	return te.Code == "network" || te.Code == "network_body" || te.Code == "timeout" ||
		te.Code == "page_not_ready" || te.Code == "blob_capture_failed" || te.Code == "blob_capture_timeout" ||
		te.Code == "upload_timeout" || te.Code == "authenticated_transfer_timeout" ||
		te.Code == "http_error" && (te.Status == 408 || te.Status == 429 || te.Status >= 500 && te.Status <= 599)
}

// parseRetryAfter accepts both RFC delta-seconds and HTTP-date forms. Clamp
// server-provided waits so a malformed or hostile response cannot stall a run
// indefinitely; callers apply bounded exponential backoff when the value is absent.
func parseRetryAfter(raw string, now time.Time) time.Duration {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return 0
	}
	digitsOnly := true
	for _, c := range raw {
		if c < '0' || c > '9' {
			digitsOnly = false
			break
		}
	}
	if digitsOnly {
		seconds, err := strconv.ParseUint(raw, 10, 64)
		if err != nil || seconds > 60 {
			return 60 * time.Second
		}
		return time.Duration(seconds) * time.Second
	}
	when, err := http.ParseTime(raw)
	if err != nil {
		return 0
	}
	wait := when.Sub(now)
	if wait <= 0 {
		return 0
	}
	if wait > 60*time.Second {
		return 60 * time.Second
	}
	return wait
}

func (r *DownloadRun) fetchPublic(a Asset, part string) (int64, error) {
	u, e := mediaURLFor(a.Key)
	if e != nil {
		return 0, &transferError{Code: "invalid_key"}
	}
	ctx, cancel := context.WithTimeout(r.ctx, mediaTimeout(a.Size))
	defer cancel()
	req, e := http.NewRequestWithContext(ctx, "GET", u, nil)
	if e != nil {
		return 0, e
	}
	req.Header.Set("Accept", "*/*")
	req.Header.Set("Accept-Encoding", "identity")
	resp, e := r.http.Do(req)
	if e != nil {
		return 0, &transferError{Code: "network"}
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		wait := parseRetryAfter(resp.Header.Get("Retry-After"), time.Now())
		return 0, &transferError{Code: "http_error", Status: resp.StatusCode, RetryAfter: wait}
	}
	if resp.ContentLength > maxMedia {
		return 0, &transferError{Code: "size_limit"}
	}
	if !mimeFamily(a.Mime, resp.Header.Get("Content-Type")) {
		return 0, &transferError{Code: "mime_mismatch"}
	}
	declared := resp.ContentLength
	if a.Size != nil && *a.Size > 0 {
		if declared >= 0 && declared != *a.Size {
			return 0, &transferError{Code: "length_mismatch"}
		}
		declared = *a.Size
	}
	return receiveMedia(ctx, resp.Body, part, a.Mime, declared)
}
func mimeFamily(expected, actual string) bool {
	actual = strings.ToLower(strings.TrimSpace(strings.Split(actual, ";")[0]))
	return actual == "" || actual == "application/octet-stream" || strings.Split(expected, "/")[0] == strings.Split(actual, "/")[0]
}

type mediaOutput interface {
	io.Writer
	Sync() error
	Close() error
}

func receiveMedia(ctx context.Context, body io.Reader, part, mime string, declared int64) (int64, error) {
	return receiveMediaWithOutput(ctx, body, part, mime, declared, func(path string) (mediaOutput, error) {
		return os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	})
}
func receiveMediaWithOutput(ctx context.Context, body io.Reader, part, mime string, declared int64, open func(string) (mediaOutput, error)) (int64, error) {
	if err := ctx.Err(); err != nil {
		return 0, transferContextError(ctx)
	}
	if declared > maxMedia {
		return 0, &transferError{Code: "size_limit"}
	}
	out, e := open(part)
	if e != nil {
		return 0, &transferError{Code: "stage_conflict"}
	}
	ok := false
	defer func() {
		out.Close()
		if !ok {
			os.Remove(part)
		}
	}()
	buf := make([]byte, 256<<10)
	var total int64
	for {
		if e = ctx.Err(); e != nil {
			return total, transferContextError(ctx)
		}
		n, re := body.Read(buf)
		if ctx.Err() != nil {
			return total, transferContextError(ctx)
		}
		if n > 0 {
			total += int64(n)
			if total > maxMedia {
				return total, &transferError{Code: "size_limit"}
			}
			if declared >= 0 && total > declared {
				return total, &transferError{Code: "length_mismatch"}
			}
			if _, e = out.Write(buf[:n]); e != nil {
				return total, &transferError{Code: "storage_failed"}
			}
		}
		if re == io.EOF {
			break
		}
		if re != nil {
			return total, &transferError{Code: "network_body"}
		}
	}
	if total == 0 || declared >= 0 && declared != total {
		return total, &transferError{Code: "length_mismatch"}
	}
	if ctx.Err() != nil {
		return total, transferContextError(ctx)
	}
	if e = out.Sync(); e != nil {
		return total, &transferError{Code: "storage_failed"}
	}
	if ctx.Err() != nil {
		return total, transferContextError(ctx)
	}
	if e = out.Close(); e != nil {
		return total, &transferError{Code: "storage_failed"}
	}
	if e = validateMediaFile(part, mime, total); e != nil {
		return total, &transferError{Code: "signature_mismatch"}
	}
	if ctx.Err() != nil {
		return total, transferContextError(ctx)
	}
	ok = true
	return total, nil
}
func validateMediaFile(path, mime string, size int64) error {
	f, e := openRegular(path)
	if e != nil {
		return e
	}
	defer f.Close()
	fi, e := f.Stat()
	if e != nil {
		return e
	}
	if fi.Size() <= 0 || fi.Size() > 1<<30 || size > 0 && fi.Size() != size {
		return errors.New("size_mismatch")
	}
	b := make([]byte, 64)
	n, _ := f.Read(b)
	b = b[:n]
	ok := false
	switch mime {
	case "image/jpeg":
		ok = n >= 3 && b[0] == 255 && b[1] == 216 && b[2] == 255
	case "image/png":
		ok = n >= 8 && string(b[:8]) == "\x89PNG\r\n\x1a\n"
	case "image/webp":
		ok = n >= 12 && string(b[:4]) == "RIFF" && string(b[8:12]) == "WEBP"
	case "image/gif":
		ok = n >= 6 && (string(b[:6]) == "GIF87a" || string(b[:6]) == "GIF89a")
	case "video/webm":
		ok = n >= 4 && string(b[:4]) == "\x1a\x45\xdf\xa3"
	case "video/mp4":
		ok = n >= 12 && (string(b[4:8]) == "ftyp" || string(b[4:8]) == "free" || string(b[4:8]) == "wide")
	}
	if !ok {
		return errors.New("signature_mismatch")
	}
	return nil
}
func (r *DownloadRun) fallback(a Asset, part string) transferResult {
	// The isolated WebView owns one native download at a time. Do not issue a
	// ticket (or start its timeout) while another worker is using that view.
	select {
	case r.fallbackGate <- struct{}{}:
		defer func() { <-r.fallbackGate }()
	case <-r.ctx.Done():
		return transferResult{Err: r.ctx.Err()}
	}

	ticket := token()
	ctx, cancel := context.WithCancelCause(r.ctx)
	defer cancel(context.Canceled)
	t := &uploadTicket{Asset: a, Part: part, Done: make(chan transferResult, 1), ctx: ctx, cancel: cancel}
	r.mu.Lock()
	if r.ctx.Err() != nil {
		r.mu.Unlock()
		return transferResult{Err: r.ctx.Err()}
	}
	r.Tickets[ticket] = t
	r.mu.Unlock()
	defer func() { r.mu.Lock(); delete(r.Tickets, ticket); r.mu.Unlock() }()
	select {
	case result := <-t.Done:
		return result
	case <-r.ctx.Done():
		r.failTicket(t, r.ctx.Err())
		return <-t.Done
	case <-time.After(6*time.Minute + 2*mediaTimeout(a.Size) + time.Minute):
		r.failTicket(t, &transferError{Code: "authenticated_transfer_timeout"})
		return <-t.Done
	}
}

type RecoveryOutcome struct {
	IndexPublished     bool
	TransactionRetired bool
}

func (r *DownloadRun) recoverPrevious() error { _, err := r.recoverPreviousOutcome(); return err }

func (r *DownloadRun) recoverPreviousOutcome() (out RecoveryOutcome, err error) {
	header := filepath.Join(r.Snap.Root, "_state", ".giv-go-download.json")
	o, e := readJSON(header)
	if e != nil {
		return out, e
	}
	if len(o) == 0 {
		return out, nil
	}
	if requireKeys(o, "version", "runToken", "manifestSha256", "phase") != nil || num(o["version"]) != 1 || (str(o["phase"]) != "media" && str(o["phase"]) != "publishing") || !tokenPattern.MatchString(str(o["runToken"])) {
		return out, errors.New("invalid_recovery")
	}
	oldToken := r.Token
	r.Token = str(o["runToken"])
	defer func() { r.Token = oldToken }()
	mp, e := r.transactionPath("manifest.json")
	if e != nil {
		return out, e
	}
	b, e := os.ReadFile(mp)
	if e != nil || hash(b) != str(o["manifestSha256"]) {
		return out, errors.New("snapshot_mismatch")
	}
	doc, e := decode(b)
	if e != nil || requireKeys(doc, "version", "runToken", "userId", "manifest") != nil || num(doc["version"]) != 1 || str(doc["userId"]) != r.User || str(doc["runToken"]) != r.Token {
		return out, errors.New("snapshot_account_mismatch")
	}
	m, e := validateManifest(obj(doc["manifest"]))
	if e != nil {
		return out, e
	}
	want := map[string]Asset{}
	for _, a := range m.Assets {
		want[a.ID] = a
	}
	dir, e := r.transactionPath("items")
	if e != nil {
		return out, e
	}
	records, e := os.ReadDir(dir)
	if e != nil && !os.IsNotExist(e) {
		return out, e
	}
	for _, entry := range records {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".json") {
			return out, errors.New("unknown_recovery_entry")
		}
		p, e := jailed(dir, entry.Name())
		if e != nil {
			return out, e
		}
		rec, e := readJSON(p)
		if e != nil {
			return out, e
		}
		id := str(rec["assetId"])
		a, ok := want[id]
		tk := str(rec["partToken"])
		if requireKeys(rec, "assetId", "extension", "partToken", "bytes", "state", "hash") != nil || !ok || entry.Name() != id+".json" || !tokenPattern.MatchString(tk) || str(rec["extension"]) != assetExt(a) {
			return out, errors.New("invalid_recovery_asset")
		}
		part, final, e := r.part(a, tk)
		if e != nil {
			return out, e
		}
		state := str(rec["state"])
		if state == "receiving" {
			if exists(part) {
				if _, e = regular(part); e != nil {
					return out, e
				}
				if e = os.Remove(part); e != nil {
					return out, e
				}
			}
		} else if state == "published" {
			if _, e = r.publishedAsset(a, rec); e != nil {
				return out, e
			}
		} else if state == "ready" || state == "committed" {
			size := num(rec["bytes"])
			if size <= 0 || size > 1<<30 || len(str(rec["hash"])) != 64 {
				return out, errors.New("invalid_recovery_size_or_hash")
			}
			check := final
			if !exists(final) {
				check = part
			}
			if !unchanged(check, Obj{"size": size, "hash": rec["hash"]}) {
				return out, errors.New("recovery_content_mismatch")
			}
			if exists(final) {
				if e = validateMediaFile(final, a.Mime, size); e != nil {
					return out, e
				}
				if exists(part) {
					fp, e := fingerprint(part)
					if e != nil || !unchanged(final, fp) {
						return out, errors.New("recovery_conflict")
					}
					if e = os.Remove(part); e != nil {
						return out, e
					}
				}
			} else {
				if e = validateMediaFile(part, a.Mime, size); e != nil {
					return out, e
				}
				if e = publishNoReplace(part, final); e != nil {
					return out, e
				}
			}
		} else {
			return out, errors.New("unknown_recovery_state")
		}
	}
	if len(m.Assets) == 0 && len(m.PromptUpdates) > 0 {
		if e = r.applyPromptUpdates(m); e != nil {
			return out, e
		}
		out.IndexPublished = true
		if e = r.retireTransaction(); e != nil {
			return out, e
		}
		out.TransactionRetired = true
		return out, nil
	}
	existing, trashed, e := r.scanExisting(m)
	if e != nil {
		return out, e
	}
	if e = r.publish(m, existing, trashed); e != nil {
		return out, e
	}
	out.IndexPublished = true
	if e = r.applyPromptUpdates(m); e != nil {
		return out, e
	}
	if e = r.releasePublishedInbox(m); e != nil {
		return out, e
	}
	if e = r.retireTransaction(); e != nil {
		return out, e
	}
	out.TransactionRetired = true
	return out, nil
}

// Layout intent is durable before creating a directory. A replay must use the
// same location even when _index.json was not yet published when the process died.
func (r *DownloadRun) layoutPlan(id string) (Obj, string, error) {
	if !stableID.MatchString(id) {
		return nil, "", errors.New("invalid_layout_id")
	}
	path, err := r.transactionPath(filepath.Join("layout", id+".json"))
	if err != nil {
		return nil, "", err
	}
	plan, err := readJSON(path)
	if err != nil || len(plan) == 0 {
		return nil, path, err
	}
	row := obj(plan["row"])
	sec, folder := str(row["section"]), str(row["folder"])
	if num(plan["version"]) != 1 || str(plan["runToken"]) != r.Token || str(plan["userId"]) != r.User || str(row["id"]) != id || (sec != "combos" && sec != "_other") || !safeName(folder) || num(row["n"]) < 0 {
		return nil, "", errors.New("invalid_layout_plan")
	}
	return row, path, nil
}
func (r *DownloadRun) publish(m Manifest, existing map[string]string, trashed map[string]bool) error {
	if r.s.stale(r.Snap) {
		return changed()
	}
	root := r.Snap.Root
	index, e := readJSON(filepath.Join(root, "_index.json"))
	if e != nil {
		return e
	}
	mapping := map[string]Obj{}
	maxN := map[string]int64{"combos": 0, "_other": 0}
	for _, field := range []string{"combos", "other"} {
		sec := "combos"
		if field == "other" {
			sec = "_other"
		}
		for _, row := range rows(index[field]) {
			id, folder := str(row["id"]), str(row["folder"])
			if id == "" || !safeName(folder) {
				return errors.New("invalid_folder_mapping")
			}
			row = clone(row)
			row["section"] = sec
			if _, exists := mapping[id]; exists {
				return errors.New("ambiguous_folder_mapping")
			}
			mapping[id] = row
			if n := num(row["n"]); n > maxN[sec] {
				maxN[sec] = n
			}
		}
	}
	convs := map[string]Conversation{}
	for _, c := range m.Conversations {
		convs[c.ID] = c
	}
	grouped := map[string][]Asset{}
	for _, a := range m.Assets {
		if assetExt(a) == "" {
			continue
		}
		group := a.Conv
		if group == "" {
			group = a.RootConv
		}
		if _, ok := convs[a.Conv]; !ok {
			if _, ok = convs[a.RootConv]; ok {
				group = a.RootConv
			}
		}
		if group == "" {
			group = a.ID
		}
		grouped[group] = append(grouped[group], a)
	}
	ids := []string{}
	for id := range grouped {
		ids = append(ids, id)
	}
	sort.Slice(ids, func(i, j int) bool {
		a, b := parseTime(convs[ids[i]].Time), parseTime(convs[ids[j]].Time)
		if a.Equal(b) {
			return ids[i] < ids[j]
		}
		return a.Before(b)
	})
	nextCombos, nextOther := []any{}, []any{}
	seen := map[string]bool{}
	for i, id := range ids {
		if r.ctx.Err() != nil {
			return r.ctx.Err()
		}
		c, known := convs[id]
		row := mapping[id]
		planned, planPath, err := r.layoutPlan(id)
		if err != nil {
			return err
		}
		if planned != nil {
			if row != nil && (str(row["section"]) != str(planned["section"]) || str(row["folder"]) != str(planned["folder"])) {
				return errors.New("layout_mapping_changed")
			}
			row = planned
		}
		sec := "_other"
		if known {
			sec = "combos"
		}
		if row != nil {
			sec = str(row["section"])
		} else {
			maxN[sec]++
			folder := fmt.Sprintf("%04d_%s", maxN[sec], id[:min(8, len(id))])
			for {
				p, e := jailed(root, filepath.Join(sec, folder))
				if e != nil {
					return e
				}
				if !exists(p) {
					break
				}
				maxN[sec]++
				folder = fmt.Sprintf("%04d_%s", maxN[sec], id[:min(8, len(id))])
			}
			row = Obj{"id": id, "n": maxN[sec], "folder": folder, "section": sec, "created": c.Time, "title": c.Title}
		}
		if n := num(row["n"]); n > maxN[sec] {
			maxN[sec] = n
		}
		if planned == nil {
			if e := atomicJSON(planPath, Obj{"version": 1, "runToken": r.Token, "userId": r.User, "row": row}); e != nil {
				return e
			}
		}
		dir, e := jailed(root, filepath.Join(sec, str(row["folder"])))
		if e != nil {
			return e
		}
		if e = os.MkdirAll(dir, 0700); e != nil {
			return e
		}
		card, e := readJSON(filepath.Join(dir, "card.json"))
		if e != nil {
			return e
		}
		if cardID := str(card["id"]); cardID != "" && cardID != id {
			return errors.New("layout_card_conflict")
		}
		members := grouped[id]
		sort.SliceStable(members, func(i, j int) bool { return parseTime(members[i].Time).Before(parseTime(members[j].Time)) })
		items := []any{}
		memberIDs := []any{}
		latest := ""
		images, videos, missing := 0, 0, 0
		for _, a := range members {
			filename := a.ID + assetExt(a)
			dest, e := jailed(dir, filename)
			if e != nil {
				return e
			}
			status := "missing"
			if trashed[a.ID] {
				status = "trashed"
			} else if exists(dest) {
				size := int64(0)
				if a.Size != nil {
					size = *a.Size
				}
				if e = validateMediaFile(dest, a.Mime, size); e != nil {
					return e
				}
				status = "exists"
			} else if src := existing[a.ID]; src != "" {
				if !sameFile(src, dest) {
					link := r.linkMedia
					if link == nil {
						link = os.Link
					}
					if e = link(src, dest); e != nil {
						tmp := filepath.Join(dir, ".giv-layout-"+token()+".part")
						if e = copyFileChecked(src, tmp); e != nil {
							return e
						}
						if e = publishNoReplace(tmp, dest); e != nil {
							return e
						}
					}
				}
				status = "linked"
			}
			prompt := a.Prompt
			if strings.TrimSpace(prompt) == "" {
				// Missing remote metadata must not erase a previously saved prompt.
				// Only the same member in this already-mapped card is a fallback.
				matches := 0
				oldPrompt := ""
				for _, old := range rows(card["items"]) {
					if str(old["id"]) == a.ID {
						matches++
						oldPrompt = str(old["prompt"])
					}
				}
				if matches == 1 {
					prompt = oldPrompt
				}
			}
			item := Obj{"id": a.ID, "mime": a.Mime, "kind": a.Kind, "created": a.Time, "file": filename, "status": status, "prompt": prompt, "parent": a.Parent, "variantOf": a.Variant, "quality": a.Quality, "conversationId": a.Conv, "rootConversationId": a.RootConv}
			if validRemote(a.Remote) {
				item["remoteUrl"] = a.Remote
			}
			if a.Size != nil {
				item["sizeBytes"] = *a.Size
			}
			items = append(items, item)
			if status == "missing" {
				missing++
			}
			if status != "missing" && status != "trashed" {
				memberIDs = append(memberIDs, a.ID)
				if parseTime(a.Time).After(parseTime(latest)) {
					latest = a.Time
				}
			}
			if strings.HasPrefix(a.Mime, "video/") {
				videos++
			} else {
				images++
			}
		}
		// Preserve local members and their metadata that are absent from a remote list.
		remoteIDs := map[string]bool{}
		for _, a := range members {
			remoteIDs[a.ID] = true
		}
		for _, old := range rows(card["items"]) {
			if !remoteIDs[str(old["id"])] {
				items = append(items, old)
			}
		}
		images, videos, missing = 0, 0, 0
		memberIDs = []any{}
		latest = ""
		for _, it := range rows(items) {
			st := str(it["status"])
			if st == "missing" {
				missing++
			}
			if strings.HasPrefix(str(it["mime"]), "video/") {
				videos++
			} else {
				images++
			}
			if st != "missing" && st != "trashed" && safeName(str(it["file"])) {
				memberIDs = append(memberIDs, it["id"])
				if parseTime(it["created"]).After(parseTime(latest)) {
					latest = str(it["created"])
				}
			}
		}
		for k, v := range row {
			if k != "section" {
				card[k] = v
			}
		}
		if card["created"] == nil || str(card["created"]) == "" {
			card["created"] = c.Time
		}
		if known {
			card["title"] = c.Title
		}
		card["items"] = items
		card["count"] = len(items)
		card["images"] = images
		card["videos"] = videos
		card["missing"] = missing
		card["memberIds"] = memberIDs
		card["latestItemCreatedAt"] = latest
		card["source"] = "imagine_conversation"
		if sec == "_other" {
			card["source"] = "other"
		}
		if e = atomicJSON(filepath.Join(dir, "card.json"), card); e != nil {
			return e
		}
		sum := summary(card, str(row["folder"]))
		if sec == "combos" {
			nextCombos = append(nextCombos, sum)
		} else {
			nextOther = append(nextOther, sum)
		}
		seen[id] = true
		r.line(fmt.Sprintf("index combos %d/%d", i+1, len(ids)))
	}
	// A shrinking remote result never silently discards older local groups.
	for id, row := range mapping {
		if seen[id] {
			continue
		}
		copy := clone(row)
		delete(copy, "section")
		if str(row["section"]) == "combos" {
			nextCombos = append(nextCombos, copy)
		} else {
			nextOther = append(nextOther, copy)
		}
	}
	index["combos"] = nextCombos
	index["other"] = nextOther
	index["summary"] = Obj{"assets": len(m.Assets), "web_combos": len(nextCombos), "other_groups": len(nextOther), "fetchedAt": time.Now().UTC().Format(time.RFC3339Nano)}
	return atomicJSON(filepath.Join(root, "_index.json"), index)
}
func sameFile(a, b string) bool {
	x, e := os.Stat(a)
	y, f := os.Stat(b)
	return e == nil && f == nil && os.SameFile(x, y)
}
func validRemote(raw string) bool {
	u, e := url.Parse(raw)
	if e != nil {
		return false
	}
	if u.Scheme != "https" || u.Host != "grok.com" || u.User != nil || u.Fragment != "" || !strings.HasPrefix(u.Path, "/imagine/post/") || !safeName(strings.TrimPrefix(u.Path, "/imagine/post/")) {
		return false
	}
	q, err := url.ParseQuery(u.RawQuery)
	if err != nil {
		return false
	}
	for k, values := range q {
		if k != "conversation" || len(values) != 1 || !safeName(values[0]) {
			return false
		}
	}
	return true
}

// Only finite, locally authored diagnostics reach the gallery; response text,
// signed URLs and authentication data never become error strings.
func transferMessage(code string) string {
	switch code {
	case "not_logged_in", "forbidden":
		return "媒体需要登录或远端拒绝访问。"
	case "network", "network_body", "blob_capture_failed", "page_not_ready":
		return "媒体连接中断，请检查网络后重试。"
	case "timeout", "blob_capture_timeout", "upload_timeout":
		return "媒体传输超时；未发布不完整文件。"
	case "rate_limited":
		return "远端限制下载频率，请稍后重试。"
	case "mime_mismatch", "invalid_signature", "signature_mismatch":
		return "媒体格式或文件签名校验失败。"
	case "size_limit":
		return "媒体超过本次下载大小上限。"
	case "size_mismatch", "length_mismatch":
		return "接收字节数与响应声明不一致。"
	case "redirect_refused":
		return "媒体跳转不符合允许的主机和协议规则。"
	case "commit_uncertain":
		return "文件提交结果无法确认，已保留恢复记录。"
	case "cancelled":
		return "此项下载已取消。"
	case "fallback_timeout", "authenticated_transfer_timeout":
		return "等待已登录浏览器传输超时。"
	default:
		return "媒体传输失败，错误类别见诊断代码。"
	}
}
