use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
#[cfg(any(windows, test))]
use std::fs;
use std::{
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Condvar, Mutex,
    },
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};
use tauri::{webview::DownloadEvent, Runtime, Webview};
use url::Url;

#[cfg(windows)]
#[path = "gallery_lock.rs"]
mod gallery_lock;
#[cfg(windows)]
#[path = "journal.rs"]
mod journal;
#[path = "layout.rs"]
mod layout;
#[path = "diagnostics.rs"]
mod diagnostics;
pub(crate) use diagnostics::{DownloadFailure, PermissionNote};
#[path = "primordials.rs"]
mod primordials;
pub(crate) use primordials::grok_primordials_initialization_script;
#[cfg(windows)]
#[path = "prefetch.rs"]
mod prefetch;
#[cfg(windows)]
#[path = "http_fetch.rs"]
mod http_fetch;
#[cfg(windows)]
#[path = "go_bridge.rs"]
mod go_bridge;
#[cfg(windows)]
#[path = "sync.rs"]
mod sync;
#[cfg(windows)]
#[path = "windows_runtime.rs"]
mod windows_runtime;

pub(crate) type StatusCallback = Arc<dyn Fn(String) + Send + Sync + 'static>;

#[cfg(not(windows))]
const UNSUPPORTED: &str = "当前平台尚不支持 Grok 下载。";
pub(super) const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(10 * 60);
pub(super) const MAX_MEDIA_BYTES: u64 = 512 * 1024 * 1024;
const MAX_MANIFEST_ASSET_BYTES: u64 = 1024 * 1024 * 1024;
const MAX_MANIFEST_BYTES: u64 = 2 * 1024 * 1024 * 1024 * 1024;
pub(super) const MAX_DOWNLOAD_TASK_BYTES: u64 = 256 * 1024 * 1024 * 1024;
pub(super) const MIN_FREE_BYTES: u64 = 512 * 1024 * 1024;
#[cfg(not(test))]
const NATIVE_CANCEL_GRACE: Duration = Duration::from_secs(5);
#[cfg(test)]
const NATIVE_CANCEL_GRACE: Duration = Duration::from_millis(50);
/// How long to wait for DownloadStarting / Requested after click().
/// Do not "fix" missing start events by raising this.
#[cfg(not(test))]
const CAPTURE_START_TIMEOUT: Duration = Duration::from_secs(5);
#[cfg(test)]
const CAPTURE_START_TIMEOUT: Duration = Duration::from_millis(80);

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProbeResponse {
    pub(crate) ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) user_id: Option<String>,
    pub(crate) stopped: bool,
    /// Why the probe could not name an account. Only `not_logged_in` means the
    /// session is really gone; everything else is a transient or page problem
    /// and must not be reported to the user as a sign-in prompt.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) error: Option<String>,
}

impl ProbeResponse {
    pub(super) fn logged_in(user_id: String) -> Self {
        Self {
            ok: true,
            user_id: Some(user_id),
            stopped: false,
            code: None,
            error: None,
        }
    }

    pub(super) fn failed(code: &str) -> Self {
        Self {
            ok: false,
            user_id: None,
            stopped: false,
            code: Some(code.to_owned()),
            error: None,
        }
    }

    #[cfg(test)]
    pub(super) fn not_logged_in() -> Self {
        Self::failed(probe_code::NOT_LOGGED_IN)
    }

    pub(super) fn stopped() -> Self {
        Self {
            ok: false,
            user_id: None,
            stopped: true,
            code: None,
            error: None,
        }
    }

    pub(crate) fn stopped_public() -> Self {
        Self::stopped()
    }

    /// A probe that neither named an account nor proved the session is gone.
    pub(super) fn is_inconclusive(&self) -> bool {
        !self.ok && !self.stopped && self.code.as_deref() != Some(probe_code::NOT_LOGGED_IN)
    }

    #[cfg(not(windows))]
    fn unsupported() -> Self {
        Self {
            ok: false,
            user_id: None,
            stopped: false,
            code: Some(probe_code::UNSUPPORTED.into()),
            error: Some(UNSUPPORTED.into()),
        }
    }
}

/// Shared vocabulary for page-side failures. The same strings cross the JS
/// scripts, Rust and the gallery bridge so no layer has to guess a category
/// back out of a localized sentence.
pub(super) mod probe_code {
    pub(crate) const NOT_LOGGED_IN: &str = "not_logged_in";
    pub(crate) const PAGE_NOT_READY: &str = "page_not_ready";
    pub(crate) const TIMEOUT: &str = "timeout";
    pub(crate) const NETWORK: &str = "network";
    pub(crate) const SCHEMA: &str = "schema_error";
    pub(crate) const INCOMPLETE: &str = "incomplete_manifest";
    pub(crate) const RATE_LIMITED: &str = "rate_limited";
    pub(crate) const FORBIDDEN: &str = "forbidden";
    pub(crate) const SERVER: &str = "server_error";
    pub(crate) const HTTP: &str = "http_error";
    pub(crate) const ACCOUNT_CHANGED: &str = "account_changed";
    pub(crate) const ACCOUNT_UNVERIFIED: &str = "account_unverified";
    pub(crate) const EMPTY_MANIFEST_GUARD: &str = "empty_manifest_guard";
    #[cfg(not(windows))]
    pub(crate) const UNSUPPORTED: &str = "unsupported_platform";
}

/// One place that decides what a category means to the user and whether it is
/// worth another attempt. A 403 interstitial, a 429 and a real sign-out all
/// used to arrive as "please log in again"; only the first two are retryable
/// and none of them share a message.
pub(super) fn page_code_meaning(code: &str, status: Option<u64>) -> (String, bool) {
    match code {
        probe_code::NOT_LOGGED_IN => ("还没登录 grok.com。".into(), false),
        probe_code::FORBIDDEN => (
            "grok.com 拒绝了这次请求（HTTP 403），可能需要先在 Grok 页面完成人工验证。".into(),
            false,
        ),
        probe_code::RATE_LIMITED => (
            "grok.com 暂时限流（HTTP 429），稍后会自动重试。".into(),
            true,
        ),
        probe_code::SERVER => ("grok.com 暂时不可用（HTTP 5xx）。".into(), true),
        probe_code::NETWORK => ("与 grok.com 的网络请求失败。".into(), true),
        probe_code::TIMEOUT => ("Grok 页面操作超时。".into(), true),
        probe_code::PAGE_NOT_READY => ("Grok 页面还没准备好，无法读取登录状态。".into(), true),
        probe_code::SCHEMA => (
            "Grok 返回的数据结构异常，已停止以保护本地索引。".into(),
            false,
        ),
        probe_code::INCOMPLETE => (
            "Grok 清单没有读取完整，已停止以保护本地索引。".into(),
            false,
        ),
        probe_code::EMPTY_MANIFEST_GUARD => (
            "Grok 这次返回了空清单，但本地图库并不是空的，已停止以保护现有索引。".into(),
            false,
        ),
        probe_code::ACCOUNT_CHANGED => (
            "Grok 登录账号在下载期间发生变化，请重新开始下载。".into(),
            false,
        ),
        probe_code::ACCOUNT_UNVERIFIED => (
            "无法确认 Grok 登录账号是否仍然一致，已停止下载。".into(),
            true,
        ),
        probe_code::HTTP => (
            match status {
                Some(status) => format!("grok.com 返回了意外状态（HTTP {status}）。"),
                None => "grok.com 返回了意外状态。".into(),
            },
            false,
        ),
        "mime" | "blob-mime" => ("Grok 返回的媒体类型与清单不一致。".into(), false),
        "length" | "length-mismatch" | "size" | "chunk" => {
            ("Grok 返回的媒体大小不一致。".into(), false)
        }
        "redirect" => ("媒体地址被重定向到未授权的主机。".into(), false),
        "body" | "blob" => ("WebView2 无法准备媒体下载。".into(), true),
        "payload" => ("Grok 清单超过安全上限。".into(), false),
        "primordials" | "input" => ("Grok 页面脚本环境校验失败。".into(), false),
        _ => ("Grok 页面操作失败。".into(), false),
    }
}

pub(crate) fn describe_page_code(code: &str) -> String {
    page_code_meaning(code, None).0
}

pub(crate) const PROBE_NOT_LOGGED_IN: &str = probe_code::NOT_LOGGED_IN;
pub(crate) const PROBE_PAGE_NOT_READY: &str = probe_code::PAGE_NOT_READY;

/// Categories worth another attempt from the shell's point of view: a page that
/// has not finished loading, a timeout, a transient network or server fault.
pub(crate) fn page_code_is_transient(code: &str) -> bool {
    page_code_meaning(code, None).1
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct StartDownloadResponse {
    pub(crate) ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) run_id: Option<u64>,
    pub(crate) stopped: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) error: Option<String>,
}

/// Media outcome for one run. `attempted` is not a success count: a run can
/// publish real files and still report failures, so the page needs both.
#[derive(Debug, Clone, Copy, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DownloadCounts {
    pub(crate) total: u64,
    pub(crate) attempted: u64,
    pub(crate) succeeded: u64,
    pub(crate) failed: u64,
    pub(crate) skipped: u64,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DownloadPersistence {
    pub(crate) result_version: u32,
    pub(crate) history_state: String,
    pub(crate) warnings: Vec<String>,
}

impl Default for DownloadPersistence {
    fn default() -> Self {
        Self { result_version: 1, history_state: "not_applicable".into(), warnings: Vec::new() }
    }
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DownloadRunResult {
    #[serde(flatten)]
    pub(crate) persistence: Box<DownloadPersistence>,
    pub(crate) ok: bool,
    pub(crate) stopped: bool,
    /// True when this run committed media and rewrote `_state` / cards /
    /// `_index.json`, even if some media failed.
    pub(crate) published: bool,
    pub(crate) counts: DownloadCounts,
    pub(crate) failures: Vec<DownloadFailure>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) error: Option<String>,
}

impl DownloadRunResult {
    fn blank(ok: bool, stopped: bool) -> Self {
        Self {
            persistence: Box::default(),
            ok,
            stopped,
            published: false,
            counts: DownloadCounts::default(),
            failures: Vec::new(),
            code: None,
            error: None,
        }
    }

    pub(super) fn success() -> Self {
        Self::blank(true, false)
    }

    pub(super) fn stopped() -> Self {
        Self::blank(true, true)
    }

    pub(super) fn failure(message: impl Into<String>) -> Self {
        Self {
            error: Some(message.into()),
            ..Self::blank(false, false)
        }
    }

    pub(super) fn coded(code: &str, message: impl Into<String>) -> Self {
        Self {
            code: Some(code.to_owned()),
            ..Self::failure(message)
        }
    }

    pub(super) fn with_counts(mut self, counts: DownloadCounts) -> Self {
        self.counts = counts;
        self
    }

    pub(super) fn with_published(mut self, published: bool) -> Self {
        self.published = published;
        self
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum CaptureRetry {
    None,
    Trigger,
    Prepare,
}

pub(super) fn capture_retry_kind(
    failure: CaptureFailure,
    native_start_seen: bool,
    tauri_requested_seen: bool,
    trigger_retries: u8,
) -> CaptureRetry {
    if native_start_seen || tauri_requested_seen {
        return CaptureRetry::None;
    }
    match failure {
        CaptureFailure::StartTimedOut | CaptureFailure::Failed if trigger_retries < 1 => {
            CaptureRetry::Trigger
        }
        CaptureFailure::Storage => CaptureRetry::Prepare,
        _ => CaptureRetry::None,
    }
}

pub(super) fn is_strict_grok_https_origin(uri: &str) -> bool {
    Url::parse(uri).ok().is_some_and(|url| {
        url.scheme() == "https"
            && url.host_str() == Some("grok.com")
            && url.username().is_empty()
            && url.password().is_none()
            && url.port_or_known_default() == Some(443)
    })
}

pub(super) fn permission_host_label(uri: &str) -> &'static str {
    if is_strict_grok_https_origin(uri) {
        "grok.com"
    } else {
        "other"
    }
}

pub(super) fn decide_automatic_download_permission(
    kind: i32,
    grok_origin: bool,
    run_active: bool,
) -> bool {
    kind == diagnostics::PERMISSION_KIND_MULTIPLE_AUTOMATIC_DOWNLOADS && grok_origin && run_active
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct StopDownloadResponse {
    pub(crate) ok: bool,
    pub(crate) stopped: bool,
    pub(crate) published: bool,
    #[serde(flatten)]
    pub(crate) persistence: Box<DownloadPersistence>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub(super) struct Asset {
    pub(super) id: String,
    #[serde(default)]
    pub(super) mime: String,
    #[serde(default)]
    pub(super) sz: Option<u64>,
    #[serde(default)]
    pub(super) t: String,
    pub(super) key: String,
    #[serde(default)]
    pub(super) src: String,
    #[serde(default)]
    pub(super) conv: String,
    #[serde(default, rename = "rootConv")]
    pub(super) root_conv: String,
    #[serde(default)]
    pub(super) kind: String,
    #[serde(default)]
    pub(super) prompt: String,
    #[serde(default)]
    pub(super) parent: Option<String>,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub(super) quality: String,
    #[serde(default, rename = "variantOf", skip_serializing_if = "Option::is_none")]
    pub(super) variant_of: Option<String>,
    // Optional explicit source link only. Never treat an asset id as a post id.
    // Omitting empty links preserves old canonical journal snapshots.
    #[serde(default, rename = "remoteUrl", skip_serializing_if = "String::is_empty")]
    pub(super) remote_url: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub(super) struct Conversation {
    pub(super) id: String,
    #[serde(default)]
    pub(super) title: String,
    #[serde(default)]
    pub(super) t: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub(super) struct Library {
    pub(super) assets: Vec<Asset>,
    pub(super) conversations: Vec<Conversation>,
}

// Optional metadata repair belongs to the Go run's canonical target allowlist.
// Keep it outside Library so legacy immutable journal serialization is unchanged.
#[cfg(windows)]
#[derive(Debug, Clone, Deserialize, Serialize)]
pub(super) struct PromptTarget {
    pub(super) token: String,
    pub(super) id: String,
    #[serde(default)]
    pub(super) conv: String,
}

#[cfg(windows)]
#[derive(Debug, Clone, Deserialize, Serialize)]
pub(super) struct PromptUpdate {
    pub(super) token: String,
    pub(super) id: String,
    #[serde(default)]
    pub(super) conv: String,
    pub(super) prompt: String,
}

#[cfg(windows)]
#[derive(Debug, Deserialize)]
pub(super) struct PromptLibrary {
    #[serde(flatten)]
    pub(super) library: Library,
    #[serde(default, rename = "promptUpdates")]
    pub(super) prompt_updates: Vec<PromptUpdate>,
}

impl Library {
    pub(super) fn validate(mut self) -> Result<Self, String> {
        if self.assets.len() > 200_000 || self.conversations.len() > 200_000 {
            return Err("Grok 返回的图库规模超出安全上限。".into());
        }
        let mut asset_ids = std::collections::HashSet::new();
        let mut declared_bytes = 0_u64;
        for asset in &mut self.assets {
            if !is_stable_id(&asset.id)
                || !is_asset_key(&asset.key)
                || (!asset.conv.is_empty() && !is_stable_id(&asset.conv))
                || (!asset.root_conv.is_empty() && !is_stable_id(&asset.root_conv))
                || asset.parent.as_deref().is_some_and(|id| !is_stable_id(id))
                || asset.variant_of.as_deref().is_some_and(|id| !is_stable_id(id))
            {
                return Err("Grok 返回了无效的媒体标识。".into());
            }
            if asset.variant_of.as_deref() == Some(asset.id.as_str()) {
                asset.variant_of = None;
            }
            truncate_on_char_boundary(&mut asset.quality, 40);
            if !asset_ids.insert(asset.id.to_ascii_lowercase()) {
                return Err("Grok 返回了重复的媒体标识。".into());
            }
            asset.remote_url = crate::desktop::trusted_post_url(&asset.remote_url)
                .map(|url| url.to_string()).unwrap_or_default();
            if !is_supported_media_mime(&asset.mime) {
                return Err("Grok 返回了不支持的媒体类型。".into());
            }
            if let Some(size) = asset.sz.filter(|size| *size > 0) {
                if size > MAX_MANIFEST_ASSET_BYTES {
                    return Err("Grok 返回的媒体超过清单兼容上限。".into());
                }
                declared_bytes = declared_bytes
                    .checked_add(size)
                    .filter(|total| *total <= MAX_MANIFEST_BYTES)
                    .ok_or_else(|| "Grok 返回的媒体清单总量超出安全上限。".to_string())?;
            }
            truncate_on_char_boundary(&mut asset.prompt, 100_000);
        }
        let mut conversation_ids = std::collections::HashSet::new();
        for conversation in &mut self.conversations {
            if !is_stable_id(&conversation.id)
                || !conversation_ids.insert(conversation.id.to_ascii_lowercase())
            {
                return Err("Grok 返回了无效或重复的会话标识。".into());
            }
            truncate_on_char_boundary(&mut conversation.title, 10_000);
        }
        Ok(self)
    }
}

/// `String::truncate` takes a byte index and panics unless it lands on a UTF-8
/// boundary. The page limits these strings by character count, so a byte budget
/// can cut a multi-byte code point in half; with `panic = "abort"` in release
/// that would take the whole shell down instead of failing the run.
pub(super) fn truncate_on_char_boundary(text: &mut String, max_bytes: usize) {
    if text.len() <= max_bytes {
        return;
    }
    let mut end = max_bytes;
    while end > 0 && !text.is_char_boundary(end) {
        end -= 1;
    }
    text.truncate(end);
}

#[derive(Clone, Default)]
pub(crate) struct DownloadCapture {
    shared: Arc<CaptureShared>,
}

#[derive(Default)]
struct CaptureShared {
    next_ticket: AtomicU64,
    pending: Mutex<Option<PendingDownload>>,
    // Blob URLs are opaque capabilities created for one native attempt. Keep
    // their digests for the process lifetime so a late event can never match a
    // later ticket that tries to reuse the same URL.
    seen_blob_urls: Mutex<HashSet<[u8; 32]>>,
    owned_parts: Mutex<HashMap<u64, Vec<PathBuf>>>,
    last_chain: Mutex<diagnostics::CaptureChain>,
    permissions: Mutex<Vec<PermissionNote>>,
    changed: Condvar,
}

struct PendingDownload {
    ticket: u64,
    run_id: u64,
    exact_blob_url: String,
    expected_name: String,
    expected_size: u64,
    part_path: PathBuf,
    /// Where WebView2 actually writes. On Windows this is a local temp file:
    /// Chromium downloads often FILE_FAILED on UNC/SMB gallery paths.
    native_write_path: PathBuf,
    final_path: PathBuf,
    cancel: Arc<AtomicBool>,
    armed_at: Instant,
    requested: bool,
    /// Native `DownloadStarting` accepted this ticket and will write the `.part`.
    /// Tauri `Finished` is then observer-only: WebView2 still emits it after
    /// `SetHandled(true)`, often as `success: false`, which must not end the wait.
    native_authority: bool,
    native_finished: bool,
    finished: Option<FinishedRecord>,
    forced_failure: Option<CaptureFailure>,
    chain: diagnostics::CaptureChain,
}

#[derive(Debug)]
struct FinishedRecord {
    success: bool,
    path: Option<PathBuf>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum CaptureFailure {
    Cancelled,
    Conflict,
    Failed,
    StartTimedOut,
    FinishTimedOut,
    Uncertain,
    PathMismatch,
    MissingFile,
    SizeMismatch { expected: u64, received: u64 },
    SignatureInvalid,
    Storage,
}

#[derive(Debug)]
pub(super) enum CaptureCompletion {
    Aborted {
        failure: CaptureFailure,
        part_path: PathBuf,
    },
    Finished {
        success: bool,
        reported_path: Option<PathBuf>,
        expected_size: u64,
        part_path: PathBuf,
        final_path: PathBuf,
        forced_failure: Option<CaptureFailure>,
    },
}

pub(super) struct CaptureRequest {
    pub(super) run_id: u64,
    pub(super) exact_blob_url: String,
    pub(super) expected_name: String,
    pub(super) expected_size: u64,
    pub(super) cancel: Arc<AtomicBool>,
    pub(super) part_path: PathBuf,
    pub(super) final_path: PathBuf,
}

#[derive(Debug)]
pub(super) enum NativeStart {
    Accept(PathBuf),
    Reject,
}

impl DownloadCapture {
    pub(crate) fn handle(&self, event: DownloadEvent<'_>) -> bool {
        match event {
            DownloadEvent::Requested { url, destination } => {
                let mut pending = lock(&self.shared.pending);
                let Some(pending) = pending.as_mut() else {
                    return false;
                };
                let url_match =
                    url.as_str() == pending.exact_blob_url && is_grok_blob_url(url.as_str());
                pending.chain.tauri_requested_seen = true;
                pending.chain.tauri_url_match = Some(url_match);
                let name_match = destination.file_name().and_then(|name| name.to_str())
                    == Some(pending.expected_name.as_str());
                pending.chain.expected_name_match = Some(name_match);
                if !url_match {
                    return false;
                }
                if pending.finished.is_some() {
                    *destination = pending.part_path.clone();
                    return true;
                }
                if pending.requested {
                    *destination = pending.part_path.clone();
                    self.shared.changed.notify_all();
                    return true;
                }
                let valid = name_match
                    && !pending.cancel.load(Ordering::Acquire)
                    && pending.forced_failure.is_none();
                if !valid {
                    pending.forced_failure.get_or_insert(CaptureFailure::Failed);
                    pending.finished = Some(FinishedRecord {
                        success: false,
                        path: None,
                    });
                    self.shared.changed.notify_all();
                    return false;
                }
                *destination = pending.part_path.clone();
                pending.requested = true;
                self.shared.changed.notify_all();
                true
            }
            DownloadEvent::Finished { url, path, success } => {
                let mut pending = lock(&self.shared.pending);
                let Some(pending) = pending.as_mut() else {
                    return false;
                };
                let url_match =
                    url.as_str() == pending.exact_blob_url && is_grok_blob_url(url.as_str());
                pending.chain.tauri_finished_seen = true;
                pending.chain.tauri_url_match = Some(url_match);
                if !url_match {
                    return false;
                }
                if pending.native_authority {
                    self.shared.changed.notify_all();
                    return true;
                }
                if pending.finished.is_some() {
                    return true;
                }
                if !pending.requested {
                    pending.forced_failure.get_or_insert(CaptureFailure::Failed);
                    self.shared.changed.notify_all();
                    return false;
                }
                pending.finished = Some(FinishedRecord { success, path });
                self.shared.changed.notify_all();
                true
            }
            _ => false,
        }
    }

    pub(super) fn native_on_starting(&self, url: &str, suggested_name: Option<&str>) -> NativeStart {
        let mut pending = lock(&self.shared.pending);
        let Some(pending) = pending.as_mut() else {
            return NativeStart::Reject;
        };
        let uri_match = pending.exact_blob_url == url && is_grok_blob_url(url);
        pending.chain.native_download_start_seen = true;
        pending.chain.native_uri_match = Some(uri_match);
        let name_match = suggested_name_matches(pending, suggested_name);
        if suggested_name.is_some() {
            pending.chain.expected_name_match = Some(name_match);
        }
        // Tauri's on_download is another DownloadStarting handler. If it runs
        // first it already set requested and may have rewritten ResultFilePath
        // to our .part. That is the same ticket, not a second download: Accept
        // and take native authority. Reject+Cancel here is what produced the
        // 25ms capture_failed + noNativeState storm.
        if !uri_match
            || pending.finished.is_some()
            || pending.cancel.load(Ordering::Acquire)
            || pending.forced_failure.is_some()
        {
            return NativeStart::Reject;
        }
        if !name_match {
            pending.forced_failure.get_or_insert(CaptureFailure::Failed);
            return NativeStart::Reject;
        }
        pending.requested = true;
        pending.native_authority = true;
        self.shared.changed.notify_all();
        NativeStart::Accept(pending.native_write_path.clone())
    }

    pub(super) fn native_note_state(&self, state: i32) {
        if let Some(pending) = lock(&self.shared.pending).as_mut() {
            pending.chain.native_state_changed = Some(state);
        }
    }

    pub(super) fn native_on_finished(
        &self,
        url: &str,
        success: bool,
        interrupt: Option<u32>,
        state: i32,
    ) {
        let mut pending = lock(&self.shared.pending);
        let Some(pending) = pending.as_mut() else {
            return;
        };
        pending.chain.native_state_changed = Some(state);
        if interrupt.is_some() {
            pending.chain.interrupt_reason = interrupt;
        }
        if pending.exact_blob_url != url || !is_grok_blob_url(url) {
            pending.chain.native_uri_match = Some(false);
            return;
        }
        if pending.native_finished {
            return;
        }
        if pending.finished.is_some() && !pending.native_authority {
            return;
        }
        if !pending.requested {
            pending.forced_failure.get_or_insert(CaptureFailure::Failed);
            self.shared.changed.notify_all();
            return;
        }
        if !success {
            pending.forced_failure.get_or_insert(CaptureFailure::Failed);
        }
        pending.native_finished = true;
        pending.finished = Some(FinishedRecord {
            success,
            path: Some(pending.native_write_path.clone()),
        });
        self.shared.changed.notify_all();
    }

    pub(super) fn record_permission(&self, note: PermissionNote) {
        {
            let mut notes = lock(&self.shared.permissions);
            if notes.len() < diagnostics::MAX_PERMISSION_NOTES {
                notes.push(note.clone());
            }
        }
        if let Some(pending) = lock(&self.shared.pending).as_mut() {
            pending.chain.apply_permission(&note);
        }
        self.shared.changed.notify_all();
    }

    pub(super) fn last_chain(&self) -> diagnostics::CaptureChain {
        lock(&self.shared.last_chain).clone()
    }

    pub(super) fn mark_click_dispatched(&self, ticket: u64, ok: bool) {
        let mut pending = lock(&self.shared.pending);
        if let Some(item) = pending.as_mut().filter(|item| item.ticket == ticket) {
            item.chain.click_dispatched = ok;
        }
    }

    pub(super) fn release_unstarted_blob(&self, blob_url: &str) -> bool {
        if lock(&self.shared.pending).is_some() {
            return false;
        }
        let chain = lock(&self.shared.last_chain);
        if chain.native_download_start_seen || chain.tauri_requested_seen {
            return false;
        }
        drop(chain);
        let digest: [u8; 32] = Sha256::digest(blob_url.as_bytes()).into();
        lock(&self.shared.seen_blob_urls).remove(&digest)
    }

    #[cfg(windows)]
    pub(crate) fn install_native_guard<R: Runtime>(
        &self,
        webview: &Webview<R>,
        download_state: &DownloadState,
    ) -> Result<(), String> {
        windows_runtime::install_download_guard(webview, self.clone(), download_state.clone())
    }

    #[cfg(not(windows))]
    pub(crate) fn install_native_guard<R: Runtime>(
        &self,
        _webview: &Webview<R>,
        _download_state: &DownloadState,
    ) -> Result<(), String> {
        Ok(())
    }

    #[cfg(windows)]
    fn cancel_native<R: Runtime>(&self, webview: &Webview<R>) -> Result<(), String> {
        windows_runtime::cancel_current(webview, self.guard_key())
    }

    pub(super) fn guard_key(&self) -> u64 {
        Arc::as_ptr(&self.shared) as usize as u64
    }

    pub(super) fn native_should_cancel(&self, url: &str) -> bool {
        let pending = lock(&self.shared.pending);
        !matches!(
            pending.as_ref(),
            Some(item)
                if item.exact_blob_url == url
                    && is_grok_blob_url(url)
                    && !item.cancel.load(Ordering::Acquire)
                    && item.forced_failure.is_none()
        )
    }

    pub(super) fn arm(&self, request: CaptureRequest) -> Result<u64, String> {
        let CaptureRequest {
            run_id,
            exact_blob_url,
            expected_name,
            expected_size,
            cancel,
            part_path,
            final_path,
        } = request;
        if !is_grok_blob_url(&exact_blob_url)
            || !(1..=MAX_MEDIA_BYTES).contains(&expected_size)
            || !part_path.is_absolute()
            || !final_path.is_absolute()
            || !is_owned_part_path(&part_path, &final_path, &expected_name)
        {
            return Err("下载目标验证失败。".into());
        }
        let mut pending = lock(&self.shared.pending);
        if pending.is_some() {
            return Err("上一个媒体下载尚未结束。".into());
        }
        let blob_digest: [u8; 32] = Sha256::digest(exact_blob_url.as_bytes()).into();
        if !lock(&self.shared.seen_blob_urls).insert(blob_digest) {
            return Err("媒体下载句柄已经使用过。".into());
        }
        let ticket = self.shared.next_ticket.fetch_add(1, Ordering::Relaxed) + 1;
        let native_write_path = resolve_native_write_path(&part_path, &expected_name);
        let tracked_part = part_path.clone();
        let tracked_native = native_write_path.clone();
        let mut chain = diagnostics::CaptureChain {
            prepare_finished: true,
            capture_armed: true,
            blob_sha: Some(blob_sha12(&exact_blob_url)),
            ..diagnostics::CaptureChain::default()
        };
        if let Some(note) = lock(&self.shared.permissions).last() {
            chain.apply_permission(note);
        }
        *pending = Some(PendingDownload {
            ticket,
            run_id,
            exact_blob_url,
            expected_name,
            expected_size,
            part_path,
            native_write_path,
            final_path,
            cancel,
            armed_at: Instant::now(),
            requested: false,
            native_authority: false,
            native_finished: false,
            finished: None,
            forced_failure: None,
            chain,
        });
        {
            let mut owned = lock(&self.shared.owned_parts);
            let parts = owned.entry(run_id).or_default();
            parts.push(tracked_part);
            if tracked_native != parts[parts.len() - 1] {
                parts.push(tracked_native);
            }
        }
        Ok(ticket)
    }

    pub(super) fn abort(&self, ticket: u64, failure: CaptureFailure) {
        let mut pending = lock(&self.shared.pending);
        if let Some(item) = pending.as_mut().filter(|item| item.ticket == ticket) {
            item.forced_failure.get_or_insert(failure);
            if !item.requested {
                item.finished = Some(FinishedRecord {
                    success: false,
                    path: None,
                });
            }
            self.shared.changed.notify_all();
        }
    }

    pub(super) fn wait<F>(
        &self,
        ticket: u64,
        cancel: &AtomicBool,
        timeout: Duration,
        cancel_native: F,
    ) -> CaptureCompletion
    where
        F: Fn(),
    {
        let deadline = Instant::now() + timeout;
        let mut native_cancel_sent = None;
        let mut pending = lock(&self.shared.pending);
        loop {
            let Some(item) = pending.as_mut().filter(|item| item.ticket == ticket) else {
                return CaptureCompletion::Aborted {
                    failure: CaptureFailure::Failed,
                    part_path: PathBuf::new(),
                };
            };
            if cancel.load(Ordering::Acquire) {
                item.forced_failure.get_or_insert(CaptureFailure::Cancelled);
            } else if item.requested && Instant::now() >= deadline {
                item.forced_failure.get_or_insert(CaptureFailure::FinishTimedOut);
            } else if !item.requested
                && (item.armed_at.elapsed() >= CAPTURE_START_TIMEOUT || Instant::now() >= deadline)
            {
                item.forced_failure.get_or_insert(CaptureFailure::StartTimedOut);
            }
            if item.forced_failure.is_some() && !item.requested && item.finished.is_none() {
                item.finished = Some(FinishedRecord {
                    success: false,
                    path: None,
                });
            }
            if item.requested && item.forced_failure.is_some() && native_cancel_sent.is_none() {
                native_cancel_sent = Some(Instant::now());
                drop(pending);
                cancel_native();
                pending = lock(&self.shared.pending);
                continue;
            }
            if item.requested
                && item.forced_failure.is_some()
                && native_cancel_sent.is_some_and(|sent| sent.elapsed() >= NATIVE_CANCEL_GRACE)
                && item.finished.is_none()
            {
                *lock(&self.shared.last_chain) = item.chain.clone();
                let completion = CaptureCompletion::Finished {
                    success: false,
                    reported_path: None,
                    expected_size: item.expected_size,
                    part_path: item.part_path.clone(),
                    final_path: item.final_path.clone(),
                    forced_failure: item.forced_failure,
                };
                *pending = None;
                self.shared.changed.notify_all();
                return completion;
            }
            if let Some(finished) = item.finished.take() {
                *lock(&self.shared.last_chain) = item.chain.clone();
                let completion = if item.requested {
                    CaptureCompletion::Finished {
                        success: finished.success,
                        reported_path: finished.path,
                        expected_size: item.expected_size,
                        part_path: item.part_path.clone(),
                        final_path: item.final_path.clone(),
                        forced_failure: item.forced_failure,
                    }
                } else {
                    CaptureCompletion::Aborted {
                        failure: item.forced_failure.unwrap_or(CaptureFailure::Failed),
                        part_path: item.part_path.clone(),
                    }
                };
                *pending = None;
                self.shared.changed.notify_all();
                return completion;
            }
            pending = self
                .shared
                .changed
                .wait_timeout(pending, Duration::from_millis(100))
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .0;
        }
    }

    fn cancel_run(&self, run_id: u64) {
        let mut pending = lock(&self.shared.pending);
        if let Some(item) = pending.as_mut().filter(|item| item.run_id == run_id) {
            item.forced_failure.get_or_insert(CaptureFailure::Cancelled);
            if !item.requested {
                item.finished = Some(FinishedRecord {
                    success: false,
                    path: None,
                });
            }
            self.shared.changed.notify_all();
        }
    }

    pub(super) fn disown_part(&self, run_id: u64, part_path: &Path) -> Result<(), String> {
        if lock(&self.shared.pending)
            .as_ref()
            .is_some_and(|item| item.run_id == run_id && item.part_path == part_path)
        {
            return Err("媒体下载门禁尚未解除。".into());
        }
        let mut owned = lock(&self.shared.owned_parts);
        let remove_entry = {
            let paths = owned
                .get_mut(&run_id)
                .ok_or_else(|| "下载临时文件没有登记。".to_string())?;
            let index = paths
                .iter()
                .position(|path| path == part_path)
                .ok_or_else(|| "下载临时文件登记不匹配。".to_string())?;
            paths.swap_remove(index);
            paths.is_empty()
        };
        if remove_entry {
            owned.remove(&run_id);
        }
        Ok(())
    }

    #[cfg(any(windows, test))]
    fn finalize_run<F>(&self, run_id: u64, cancel_native: F)
    where
        F: Fn(),
    {
        let ticket = {
            let mut pending = lock(&self.shared.pending);
            pending
                .as_mut()
                .filter(|item| item.run_id == run_id)
                .map(|item| {
                    item.cancel.store(true, Ordering::Release);
                    item.forced_failure.get_or_insert(CaptureFailure::Cancelled);
                    if !item.requested {
                        item.finished = Some(FinishedRecord {
                            success: false,
                            path: None,
                        });
                    }
                    self.shared.changed.notify_all();
                    item.ticket
                })
        };

        if let Some(ticket) = ticket {
            let forced_cancel = AtomicBool::new(true);
            let _ = self.wait(
                ticket,
                &forced_cancel,
                NATIVE_CANCEL_GRACE.saturating_add(Duration::from_millis(250)),
                cancel_native,
            );
        }

        let mut pending = lock(&self.shared.pending);
        if matches!(pending.as_ref(), Some(item) if item.run_id == run_id) {
            *pending = None;
            self.shared.changed.notify_all();
        }
        drop(pending);

        let owned_parts = lock(&self.shared.owned_parts)
            .remove(&run_id)
            .unwrap_or_default();
        for part_path in owned_parts {
            cleanup_owned_part(&part_path);
        }
    }

    #[cfg(test)]
    fn has_pending(&self) -> bool {
        lock(&self.shared.pending).is_some()
    }
}
#[derive(Clone)]
pub(crate) struct DownloadState {
    shared: Arc<SharedState>,
    capture: DownloadCapture,
    navigation_epoch: Arc<AtomicU64>,
}

struct SharedState {
    next_run_id: AtomicU64,
    slot: Mutex<Slot>,
    changed: Condvar,
}

enum Slot {
    Idle,
    Reserved {
        run_id: u64,
        cancel: Arc<AtomicBool>,
    },
    Running {
        run_id: u64,
        control: Arc<RunControl>,
        join: Option<JoinHandle<()>>,
        reaping: bool,
    },
}

pub(super) struct RunControl {
    pub(super) cancel: Arc<AtomicBool>,
    pub(super) navigation: NavigationGuard,
    result: Mutex<Option<DownloadRunResult>>,
    report: Mutex<diagnostics::RunReport>,
    done: Condvar,
}

impl RunControl {
    fn new(cancel: Arc<AtomicBool>, navigation: NavigationGuard) -> Self {
        Self {
            cancel,
            navigation,
            result: Mutex::new(None),
            report: Mutex::new(diagnostics::RunReport::default()),
            done: Condvar::new(),
        }
    }

    fn finish(&self, mut result: DownloadRunResult) {
        let report = lock(&self.report);
        if report.counts.total > 0 {
            result.counts = report.counts;
            result.failures = report.failures.clone();
        }
        drop(report);
        *lock(&self.result) = Some(result);
        self.done.notify_all();
    }

    fn wait(&self) -> DownloadRunResult {
        let mut result = lock(&self.result);
        loop {
            if let Some(result) = result.clone() {
                return result;
            }
            result = self
                .done
                .wait(result)
                .unwrap_or_else(|poisoned| poisoned.into_inner());
        }
    }

    fn wait_timeout(&self, timeout: Duration) -> Option<DownloadRunResult> {
        let result = lock(&self.result);
        if result.is_some() {
            return result.clone();
        }
        self.done
            .wait_timeout_while(result, timeout, |value| value.is_none())
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .0
            .clone()
    }

    fn is_finished(&self) -> bool {
        lock(&self.result).is_some()
    }
}

#[derive(Clone, Debug)]
pub(crate) struct DownloadRetry {
    pub history_id: String,
    pub asset_ids: Vec<String>,
}

pub(crate) struct DownloadReservation {
    state: DownloadState,
    run_id: u64,
    cancel: Arc<AtomicBool>,
    navigation: NavigationGuard,
    armed: bool,
}

impl DownloadReservation {
    pub(crate) fn is_cancelled(&self) -> bool {
        self.cancel.load(Ordering::Acquire) || !self.navigation.is_current()
    }
}

#[derive(Clone)]
pub(super) struct NavigationGuard {
    epoch: Arc<AtomicU64>,
    expected: u64,
}

impl NavigationGuard {
    pub(super) fn is_current(&self) -> bool {
        self.epoch.load(Ordering::Acquire) == self.expected
    }
}

impl Drop for DownloadReservation {
    fn drop(&mut self) {
        if self.armed {
            self.state.release_reservation(self.run_id);
        }
    }
}

impl Default for DownloadState {
    fn default() -> Self {
        Self {
            shared: Arc::new(SharedState {
                next_run_id: AtomicU64::new(1),
                slot: Mutex::new(Slot::Idle),
                changed: Condvar::new(),
            }),
            capture: DownloadCapture::default(),
            navigation_epoch: Arc::new(AtomicU64::new(1)),
        }
    }
}

impl DownloadState {
    pub(crate) fn capture(&self) -> DownloadCapture {
        self.capture.clone()
    }

    fn navigation_guard(&self) -> NavigationGuard {
        NavigationGuard {
            epoch: Arc::clone(&self.navigation_epoch),
            expected: self.navigation_epoch.load(Ordering::Acquire),
        }
    }

    /// Invalidate page work dispatched before this top-level navigation and
    /// stop the reservation/run that was bound to the previous document.
    pub(crate) fn navigation_started(&self) {
        self.navigation_epoch.fetch_add(1, Ordering::AcqRel);
        self.request_stop();
    }

    pub(crate) fn is_busy(&self) -> bool {
        !matches!(*lock(&self.shared.slot), Slot::Idle)
    }

    pub(crate) fn reserve(&self) -> Result<DownloadReservation, String> {
        self.reap_finished();
        let mut slot = lock(&self.shared.slot);
        if !matches!(*slot, Slot::Idle) {
            return Err("已有一次下载在进行。".into());
        }
        let run_id = self.shared.next_run_id.fetch_add(1, Ordering::Relaxed);
        let cancel = Arc::new(AtomicBool::new(false));
        *slot = Slot::Reserved {
            run_id,
            cancel: Arc::clone(&cancel),
        };
        Ok(DownloadReservation {
            state: self.clone(),
            run_id,
            cancel,
            navigation: self.navigation_guard(),
            armed: true,
        })
    }

    fn release_reservation(&self, run_id: u64) {
        let mut slot = lock(&self.shared.slot);
        if matches!(&*slot, Slot::Reserved { run_id: current, .. } if *current == run_id) {
            *slot = Slot::Idle;
            self.shared.changed.notify_all();
        }
    }

    fn reap_finished(&self) {
        let finished = {
            let slot = lock(&self.shared.slot);
            match &*slot {
                Slot::Running {
                    run_id, control, ..
                } if control.is_finished() => Some(*run_id),
                _ => None,
            }
        };
        if let Some(run_id) = finished {
            let _ = self.wait(run_id);
        }
    }

    pub(crate) fn wait(&self, run_id: u64) -> DownloadRunResult {
        let control = {
            let slot = lock(&self.shared.slot);
            match &*slot {
                Slot::Running {
                    run_id: current,
                    control,
                    ..
                } if *current == run_id => Arc::clone(control),
                _ => return DownloadRunResult::failure("下载任务已结束或不存在。"),
            }
        };
        let result = control.wait();
        self.reap(run_id);
        result
    }

    fn reap(&self, run_id: u64) {
        let join = loop {
            let mut slot = lock(&self.shared.slot);
            match &mut *slot {
                Slot::Running {
                    run_id: current,
                    join,
                    reaping,
                    ..
                } if *current == run_id => {
                    if !*reaping {
                        *reaping = true;
                        break join.take();
                    }
                    drop(
                        self.shared
                            .changed
                            .wait(slot)
                            .unwrap_or_else(|poisoned| poisoned.into_inner()),
                    );
                }
                _ => return,
            }
        };
        if let Some(join) = join {
            let _ = join.join();
        }
        let mut slot = lock(&self.shared.slot);
        if matches!(&*slot, Slot::Running { run_id: current, .. } if *current == run_id) {
            *slot = Slot::Idle;
            self.shared.changed.notify_all();
        }
    }

    fn signal_stop(&self) -> Option<(u64, Arc<RunControl>)> {
        let mut slot = lock(&self.shared.slot);
        match &*slot {
            Slot::Idle => None,
            Slot::Reserved { cancel, .. } => {
                cancel.store(true, Ordering::Release);
                *slot = Slot::Idle;
                self.shared.changed.notify_all();
                None
            }
            Slot::Running {
                run_id, control, ..
            } => {
                control.cancel.store(true, Ordering::Release);
                self.capture.cancel_run(*run_id);
                Some((*run_id, Arc::clone(control)))
            }
        }
    }

    pub(crate) fn request_stop(&self) {
        let _ = self.signal_stop();
    }

    #[cfg(windows)]
    pub(crate) fn stop<R: Runtime>(&self, webview: &Webview<R>) -> StopDownloadResponse {
        let running = self.signal_stop();
        let _ = self.capture.cancel_native(webview);
        let mut published = false;
        let mut persistence = Box::default();
        let stopped = if let Some((run_id, control)) = running {
            if let Some(result) = control.wait_timeout(Duration::from_secs(15)) {
                published = result.published;
                persistence = result.persistence;
                self.reap(run_id);
                result.code.as_deref() != Some("stop_pending")
            } else {
                false
            }
        } else {
            true
        };
        StopDownloadResponse {
            ok: stopped,
            stopped,
            published,
            persistence,
        }
    }

    #[cfg(not(windows))]
    pub(crate) fn stop<R: Runtime>(&self, _webview: &Webview<R>) -> StopDownloadResponse {
        let running = self.signal_stop();
        let mut published = false;
        let mut persistence = Box::default();
        if let Some((run_id, control)) = running {
            if let Some(result) = control.wait_timeout(Duration::from_secs(15)) {
                published = result.published;
                persistence = result.persistence;
                self.reap(run_id);
            }
        }
        StopDownloadResponse {
            ok: true,
            stopped: true,
            published,
            persistence,
        }
    }
}

#[cfg(windows)]
impl DownloadReservation {
    pub(crate) fn start<R: Runtime>(
        mut self,
        webview: Webview<R>,
        out_root: PathBuf,
        expected_user_id: String,
        status: StatusCallback,
        retry: Option<DownloadRetry>,
        backend_session: crate::backend::BackendSession,
    ) -> StartDownloadResponse {
        if self.is_cancelled() {
            self.armed = false;
            return StartDownloadResponse {
                ok: true,
                run_id: Some(self.run_id),
                stopped: true,
                error: None,
            };
        }
        if !out_root.is_absolute() || !out_root.is_dir() {
            return self.failed_start("图库目录不存在或不是绝对路径。");
        }

        let control = Arc::new(RunControl::new(
            Arc::clone(&self.cancel),
            self.navigation.clone(),
        ));
        let worker_control = Arc::clone(&control);
        let capture = self.state.capture();
        let run_id = self.run_id;
        let join = thread::Builder::new()
            .name(format!("giv-download-{run_id}"))
            .spawn(move || {
                let cleanup_webview = webview.clone();
                let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    if cfg!(feature = "legacy-rust-download") {
                        if retry.is_some() {
                            DownloadRunResult::failure("选择性重试需要 Go 下载协调器，旧版恢复模式不支持。")
                        } else {
                            sync::run(webview, out_root, expected_user_id, status, Arc::clone(&worker_control), capture.clone(), run_id, backend_session)
                        }
                    } else {
                        go_bridge::run(webview, out_root, expected_user_id, status, Arc::clone(&worker_control), capture.clone(), run_id, backend_session, retry)
                    }
                }))
                .unwrap_or_else(|_| DownloadRunResult::failure("下载运行时异常退出。"));
                capture.finalize_run(run_id, || {
                    let _ = capture.cancel_native(&cleanup_webview);
                });
                worker_control.finish(result);
            });

        let join = match join {
            Ok(join) => join,
            Err(_) => return self.failed_start("无法启动下载任务。"),
        };
        let mut slot = lock(&self.state.shared.slot);
        if !matches!(&*slot, Slot::Reserved { run_id: current, .. } if *current == run_id) {
            self.cancel.store(true, Ordering::Release);
            drop(slot);
            let _ = join.join();
            self.armed = false;
            return StartDownloadResponse {
                ok: true,
                run_id: Some(run_id),
                stopped: true,
                error: None,
            };
        }
        *slot = Slot::Running {
            run_id,
            control,
            join: Some(join),
            reaping: false,
        };
        self.state.shared.changed.notify_all();
        self.armed = false;
        StartDownloadResponse {
            ok: true,
            run_id: Some(run_id),
            stopped: false,
            error: None,
        }
    }

    fn failed_start(&mut self, message: &str) -> StartDownloadResponse {
        self.state.release_reservation(self.run_id);
        self.armed = false;
        StartDownloadResponse {
            ok: false,
            run_id: None,
            stopped: false,
            error: Some(message.into()),
        }
    }
}

#[cfg(not(windows))]
impl DownloadReservation {
    pub(crate) fn start<R: Runtime>(
        mut self,
        _webview: Webview<R>,
        _out_root: PathBuf,
        _expected_user_id: String,
        _status: StatusCallback,
        _retry: Option<DownloadRetry>,
        _backend_session: crate::backend::BackendSession,
    ) -> StartDownloadResponse {
        self.state.release_reservation(self.run_id);
        self.armed = false;
        StartDownloadResponse {
            ok: false,
            run_id: None,
            stopped: false,
            error: Some(UNSUPPORTED.into()),
        }
    }
}

#[cfg(windows)]
pub(crate) fn probe_grok_user<R: Runtime>(
    webview: &Webview<R>,
    reservation: &DownloadReservation,
) -> ProbeResponse {
    windows_runtime::probe_user(webview, &reservation.cancel, &reservation.navigation)
}

#[cfg(not(windows))]
pub(crate) fn probe_grok_user<R: Runtime>(
    _webview: &Webview<R>,
    _reservation: &DownloadReservation,
) -> ProbeResponse {
    ProbeResponse::unsupported()
}

fn is_grok_blob_url(value: &str) -> bool {
    value.starts_with("blob:https://grok.com/") && value.len() <= 512
}

fn blob_sha12(url: &str) -> String {
    Sha256::digest(url.as_bytes())
        .iter()
        .take(6)
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn suggested_name_matches(pending: &PendingDownload, suggested_name: Option<&str>) -> bool {
    let Some(name) = suggested_name else {
        return true;
    };
    name == pending.expected_name
        || pending
            .part_path
            .file_name()
            .and_then(|part| part.to_str())
            == Some(name)
        || pending
            .native_write_path
            .file_name()
            .and_then(|part| part.to_str())
            == Some(name)
}

fn native_stage_dir() -> PathBuf {
    std::env::temp_dir().join("giv-webview2-capture")
}

fn token_from_expected_name(expected_name: &str) -> Option<&str> {
    let token = expected_name
        .strip_prefix("giv-")?
        .strip_suffix(".download")?;
    (token.len() == 32 && token.bytes().all(|byte| byte.is_ascii_hexdigit())).then_some(token)
}

pub(super) fn is_native_stage_path(path: &Path) -> bool {
    let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
        return false;
    };
    let Some(token) = name.strip_suffix(".part") else {
        return false;
    };
    token.len() == 32
        && token.bytes().all(|byte| byte.is_ascii_hexdigit())
        && path.parent().is_some_and(|parent| {
            parent.file_name().and_then(|name| name.to_str()) == Some("giv-webview2-capture")
        })
}

fn resolve_native_write_path(part_path: &Path, expected_name: &str) -> PathBuf {
    #[cfg(test)]
    {
        let _ = expected_name;
        part_path.to_path_buf()
    }
    #[cfg(not(test))]
    {
        let Some(token) = token_from_expected_name(expected_name) else {
            return part_path.to_path_buf();
        };
        let dir = native_stage_dir();
        if std::fs::create_dir_all(&dir).is_err() {
            return part_path.to_path_buf();
        }
        dir.join(format!("{token}.part"))
    }
}

fn is_owned_part_path(part_path: &Path, final_path: &Path, expected_name: &str) -> bool {
    if part_path.parent().is_none()
        || part_path.parent() != final_path.parent()
        || part_path == final_path
    {
        return false;
    }
    let (Some(part_name), Some(final_name)) = (
        part_path.file_name().and_then(|name| name.to_str()),
        final_path.file_name().and_then(|name| name.to_str()),
    ) else {
        return false;
    };
    let Some(token) = part_name
        .strip_prefix(final_name)
        .and_then(|suffix| suffix.strip_prefix(".giv-"))
        .and_then(|suffix| suffix.strip_suffix(".part"))
    else {
        return false;
    };
    token.len() == 32
        && token.bytes().all(|byte| byte.is_ascii_hexdigit())
        && expected_name == format!("giv-{token}.download")
}

#[cfg(any(windows, test))]
fn cleanup_owned_part(path: &Path) {
    if fs::symlink_metadata(path)
        .ok()
        .is_some_and(|metadata| metadata.is_file() && !metadata.file_type().is_symlink())
    {
        let _ = fs::remove_file(path);
    }
}

pub(super) fn is_stable_id(value: &str) -> bool {
    (6..=200).contains(&value.len())
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
        && !matches!(value, "." | "..")
}

pub(super) fn is_stable_user_id(value: &str) -> bool {
    is_stable_id(value) && !value.contains('.')
}

pub(super) fn is_supported_media_mime(value: &str) -> bool {
    matches!(
        value,
        "image/jpeg" | "image/png" | "image/webp" | "video/mp4" | "video/webm"
    )
}

pub(super) fn is_asset_key(value: &str) -> bool {
    if value.is_empty()
        || value.len() > 1024
        || value.starts_with('/')
        || value.ends_with('/')
        || value.contains('\\')
        || value.contains('?')
        || value.contains('#')
    {
        return false;
    }
    value.split('/').all(|segment| {
        !segment.is_empty()
            && !matches!(segment, "." | "..")
            && segment.bytes().all(|byte| {
                byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~')
            })
    })
}

pub(super) fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn manifest_asset(index: u64, size: Option<u64>) -> Asset {
        let id = format!("asset-{index:06}");
        Asset {
            id: id.clone(),
            mime: "image/jpeg".into(),
            sz: size,
            t: String::new(),
            key: format!("assets/{id}/file.jpg"),
            src: String::new(),
            conv: String::new(),
            root_conv: String::new(),
            kind: String::new(),
            prompt: String::new(),
            parent: None,
            quality: String::new(),
            variant_of: None,
            remote_url: String::new(),
        }
    }

    #[test]
    fn oversized_multibyte_text_is_cut_on_a_char_boundary() {
        // The page limits these by character count, so a byte budget can land
        // inside a code point. `String::truncate` would panic there, and with
        // `panic = "abort"` in release that ends the process.
        for (text, limit) in [
            ("中".repeat(33_334), 100_000),
            ("😀".repeat(30_000), 100_000),
            ("中a😀".repeat(20_000), 10_000),
            ("한국어".repeat(5_000), 10_000),
        ] {
            assert!(text.len() > limit, "fixture must exceed the budget");
            let mut value = text.clone();
            truncate_on_char_boundary(&mut value, limit);
            assert!(value.len() <= limit);
            assert!(text.starts_with(&value));
            assert!(value.chars().count() > 0);
        }

        let mut exact = "中".repeat(10);
        truncate_on_char_boundary(&mut exact, 30);
        assert_eq!(exact.len(), 30);

        let mut ascii = "abcdef".to_string();
        truncate_on_char_boundary(&mut ascii, 3);
        assert_eq!(ascii, "abc");

        let mut short = "中".to_string();
        truncate_on_char_boundary(&mut short, 100);
        assert_eq!(short, "中");
    }

    #[test]
    fn validate_survives_multibyte_text_at_both_byte_budgets() {
        let mut asset = manifest_asset(1, Some(1));
        asset.prompt = "中".repeat(33_334);
        let library = Library {
            assets: vec![asset],
            conversations: vec![Conversation {
                id: "conversation-000001".into(),
                title: "中".repeat(3_334),
                t: String::new(),
            }],
        };
        let validated = library.validate().expect("validate must not panic");
        assert!(validated.assets[0].prompt.len() <= 100_000);
        assert!(validated.conversations[0].title.len() <= 10_000);
        assert!(validated.assets[0].prompt.ends_with('中'));
        assert!(validated.conversations[0].title.ends_with('中'));
    }

    #[test]
    fn partial_run_reports_counts_and_publication() {
        let counts = DownloadCounts {
            total: 3,
            attempted: 3,
            succeeded: 2,
            failed: 1,
            skipped: 4,
        };
        let partial = DownloadRunResult::coded("partial", "成功 2 个，失败 1 个")
            .with_counts(counts)
            .with_published(true);
        assert!(!partial.ok);
        assert!(!partial.stopped);
        assert!(partial.published);
        assert_eq!(partial.counts.succeeded, 2);
        assert_eq!(partial.counts.failed, 1);
        assert_eq!(partial.code.as_deref(), Some("partial"));

        let clean = DownloadRunResult::success()
            .with_counts(counts)
            .with_published(true);
        assert!(clean.ok);
        assert!(clean.published);

        let stopped = DownloadRunResult::stopped();
        assert!(stopped.stopped);
        assert!(!stopped.published);
    }

    #[test]
    fn reservation_is_exclusive_and_drop_releases_it() {
        let state = DownloadState::default();
        assert!(!state.is_busy());
        let first = state.reserve().unwrap();
        assert!(state.is_busy());
        assert!(state.reserve().is_err());
        drop(first);
        assert!(!state.is_busy());
        assert!(state.reserve().is_ok());
    }

    #[test]
    fn identifiers_and_asset_keys_reject_traversal() {
        assert!(is_stable_id("abc123-DEF_456"));
        assert!(is_asset_key("assets/abc123/file-name.jpg"));
        for bad in [
            "../secret",
            "assets/../secret",
            "/root",
            "a?token=x",
            "a\\b",
        ] {
            assert!(!is_asset_key(bad), "{bad}");
        }
        assert!(!is_stable_id("../secret"));
    }

    #[test]
    fn manifest_compatibility_is_separate_from_new_download_admission() {
        let legacy = Library {
            assets: vec![manifest_asset(1, Some(768 * 1024 * 1024))],
            conversations: vec![],
        };
        assert!(legacy.validate().is_ok());

        let oversized = Library {
            assets: vec![manifest_asset(1, Some(MAX_MANIFEST_ASSET_BYTES + 1))],
            conversations: vec![],
        };
        assert!(oversized.validate().is_err());
    }

    #[test]
    fn manifest_declared_total_uses_a_checked_two_tib_cap() {
        let exact_count = MAX_MANIFEST_BYTES / MAX_MANIFEST_ASSET_BYTES;
        let exact = Library {
            assets: (0..exact_count)
                .map(|index| manifest_asset(index, Some(MAX_MANIFEST_ASSET_BYTES)))
                .collect(),
            conversations: vec![],
        };
        assert!(exact.validate().is_ok());

        let too_large = Library {
            assets: (0..=exact_count)
                .map(|index| manifest_asset(index, Some(MAX_MANIFEST_ASSET_BYTES)))
                .collect(),
            conversations: vec![],
        };
        assert!(too_large.validate().is_err());
    }

    #[test]
    fn capture_binds_exact_blob_and_cleans_aborted_part() {
        let root = std::env::temp_dir().join(format!(
            "giv-capture-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&root).unwrap();
        let token = "00000000000000000000000000000001";
        let part = root.join(format!("asset.jpg.giv-{token}.part"));
        fs::write(&part, b"partial").unwrap();
        let capture = DownloadCapture::default();
        let ticket = capture
            .arm(CaptureRequest {
                run_id: 1,
                exact_blob_url: "blob:https://grok.com/00000000-0000-4000-8000-000000000000".into(),
                expected_name: format!("giv-{token}.download"),
                expected_size: 7,
                cancel: Arc::new(AtomicBool::new(false)),
                part_path: part.clone(),
                final_path: root.join("asset.jpg"),
            })
            .unwrap();
        capture.abort(ticket, CaptureFailure::Cancelled);
        assert!(matches!(
            capture.wait(
                ticket,
                &AtomicBool::new(false),
                Duration::from_secs(1),
                || {}
            ),
            CaptureCompletion::Aborted {
                failure: CaptureFailure::Cancelled,
                ..
            }
        ));
        assert!(!capture.has_pending());
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn requested_cancel_without_finished_has_bounded_grace() {
        let root = std::env::temp_dir().join(format!(
            "giv-cancel-grace-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&root).unwrap();
        let token = "00000000000000000000000000000007";
        let part = root.join(format!("asset.jpg.giv-{token}.part"));
        fs::write(&part, b"partial").unwrap();
        let cancellation = Arc::new(AtomicBool::new(false));
        let capture = DownloadCapture::default();
        let ticket = capture
            .arm(CaptureRequest {
                run_id: 7,
                exact_blob_url: "blob:https://grok.com/00000000-0000-4000-8000-000000000007".into(),
                expected_name: format!("giv-{token}.download"),
                expected_size: 7,
                cancel: Arc::clone(&cancellation),
                part_path: part.clone(),
                final_path: root.join("asset.jpg"),
            })
            .unwrap();
        let mut suggested = root.join(format!("giv-{token}.download"));
        assert!(capture.handle(DownloadEvent::Requested {
            url: url::Url::parse("blob:https://grok.com/00000000-0000-4000-8000-000000000007",)
                .unwrap(),
            destination: &mut suggested,
        }));
        cancellation.store(true, Ordering::Release);
        let cancel_calls = AtomicU64::new(0);
        let completion = capture.wait(ticket, &cancellation, Duration::from_secs(1), || {
            cancel_calls.fetch_add(1, Ordering::Relaxed);
        });
        assert_eq!(cancel_calls.load(Ordering::Relaxed), 1);
        assert!(matches!(
            completion,
            CaptureCompletion::Finished {
                forced_failure: Some(CaptureFailure::Cancelled),
                ..
            }
        ));
        assert!(!capture.has_pending());
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn worker_finalizer_releases_gate_and_only_cleans_owned_parts() {
        let root = std::env::temp_dir().join(format!(
            "giv-worker-finalize-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&root).unwrap();
        let final_path = root.join("asset.jpg");
        let token = "00000000000000000000000000000042";
        let part = root.join(format!("asset.jpg.giv-{token}.part"));
        let unrelated = root.join("unrelated.part");
        fs::write(&part, b"partial").unwrap();
        fs::write(&unrelated, b"keep").unwrap();

        let capture = DownloadCapture::default();
        capture
            .arm(CaptureRequest {
                run_id: 42,
                exact_blob_url: "blob:https://grok.com/00000000-0000-4000-8000-000000000042".into(),
                expected_name: format!("giv-{token}.download"),
                expected_size: 7,
                cancel: Arc::new(AtomicBool::new(false)),
                part_path: part.clone(),
                final_path: final_path.clone(),
            })
            .unwrap();
        let mut suggested = root.join(format!("giv-{token}.download"));
        assert!(capture.handle(DownloadEvent::Requested {
            url: url::Url::parse("blob:https://grok.com/00000000-0000-4000-8000-000000000042",)
                .unwrap(),
            destination: &mut suggested,
        }));

        let cancel_calls = AtomicU64::new(0);
        capture.finalize_run(42, || {
            cancel_calls.fetch_add(1, Ordering::Relaxed);
        });
        assert_eq!(cancel_calls.load(Ordering::Relaxed), 1);
        assert!(!capture.has_pending());
        assert!(!part.exists());
        assert_eq!(fs::read(&unrelated).unwrap(), b"keep");

        let next_token = "00000000000000000000000000000043";
        let next_part = root.join(format!("asset.jpg.giv-{next_token}.part"));
        fs::write(&next_part, b"next").unwrap();
        capture
            .arm(CaptureRequest {
                run_id: 43,
                exact_blob_url: "blob:https://grok.com/00000000-0000-4000-8000-000000000043".into(),
                expected_name: format!("giv-{next_token}.download"),
                expected_size: 4,
                cancel: Arc::new(AtomicBool::new(false)),
                part_path: next_part.clone(),
                final_path,
            })
            .unwrap();
        let mut suggested = root.join(format!("giv-{next_token}.download"));
        let url =
            url::Url::parse("blob:https://grok.com/00000000-0000-4000-8000-000000000043").unwrap();
        assert!(capture.handle(DownloadEvent::Requested {
            url: url.clone(),
            destination: &mut suggested,
        }));
        assert!(capture.handle(DownloadEvent::Finished {
            url,
            path: Some(next_part.clone()),
            success: true,
        }));
        let ticket = lock(&capture.shared.pending).as_ref().unwrap().ticket;
        assert!(matches!(
            capture.wait(
                ticket,
                &AtomicBool::new(false),
                Duration::from_secs(1),
                || {}
            ),
            CaptureCompletion::Finished { .. }
        ));
        capture.disown_part(43, &next_part).unwrap();
        capture.finalize_run(43, || {});
        assert!(!capture.has_pending());
        assert!(next_part.exists());
        assert_eq!(fs::read(&unrelated).unwrap(), b"keep");
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn blob_url_is_one_shot_and_late_events_cannot_poison_the_next_ticket() {
        let root = std::env::temp_dir().join(format!(
            "giv-capture-replay-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&root).unwrap();
        let capture = DownloadCapture::default();
        let old_url = "blob:https://grok.com/00000000-0000-4000-8000-000000000050";
        let old_token = "00000000000000000000000000000050";
        let old_part = root.join(format!("old.jpg.giv-{old_token}.part"));
        let old_final = root.join("old.jpg");
        fs::write(&old_part, b"old").unwrap();
        let old_cancel = Arc::new(AtomicBool::new(false));
        let old_ticket = capture
            .arm(CaptureRequest {
                run_id: 50,
                exact_blob_url: old_url.into(),
                expected_name: format!("giv-{old_token}.download"),
                expected_size: 3,
                cancel: Arc::clone(&old_cancel),
                part_path: old_part.clone(),
                final_path: old_final.clone(),
            })
            .unwrap();
        let old_parsed = url::Url::parse(old_url).unwrap();
        let mut old_destination = root.join(format!("giv-{old_token}.download"));
        assert!(capture.handle(DownloadEvent::Requested {
            url: old_parsed.clone(),
            destination: &mut old_destination,
        }));
        old_cancel.store(true, Ordering::Release);
        assert!(matches!(
            capture.wait(old_ticket, &old_cancel, Duration::from_secs(1), || {}),
            CaptureCompletion::Finished {
                forced_failure: Some(CaptureFailure::Cancelled),
                ..
            }
        ));
        assert!(!capture.has_pending());

        let replay_token = "00000000000000000000000000000051";
        let replay_part = root.join(format!("replay.jpg.giv-{replay_token}.part"));
        assert!(capture
            .arm(CaptureRequest {
                run_id: 51,
                exact_blob_url: old_url.into(),
                expected_name: format!("giv-{replay_token}.download"),
                expected_size: 3,
                cancel: Arc::new(AtomicBool::new(false)),
                part_path: replay_part,
                final_path: root.join("replay.jpg"),
            })
            .is_err());

        let next_url = "blob:https://grok.com/00000000-0000-4000-8000-000000000052";
        let next_token = "00000000000000000000000000000052";
        let next_part = root.join(format!("next.jpg.giv-{next_token}.part"));
        let next_final = root.join("next.jpg");
        fs::write(&next_part, b"next").unwrap();
        let next_ticket = capture
            .arm(CaptureRequest {
                run_id: 52,
                exact_blob_url: next_url.into(),
                expected_name: format!("giv-{next_token}.download"),
                expected_size: 4,
                cancel: Arc::new(AtomicBool::new(false)),
                part_path: next_part.clone(),
                final_path: next_final,
            })
            .unwrap();

        let mut late_destination = root.join(format!("giv-{old_token}.download"));
        assert!(!capture.handle(DownloadEvent::Requested {
            url: old_parsed.clone(),
            destination: &mut late_destination,
        }));
        assert!(!capture.handle(DownloadEvent::Finished {
            url: old_parsed,
            path: Some(old_part),
            success: true,
        }));
        {
            let pending = lock(&capture.shared.pending);
            let pending = pending.as_ref().unwrap();
            assert_eq!(pending.ticket, next_ticket);
            assert!(!pending.requested);
            assert!(pending.finished.is_none());
            assert!(pending.forced_failure.is_none());
        }
        assert!(capture.native_should_cancel(old_url));
        assert!(!capture.native_should_cancel(next_url));

        let next_parsed = url::Url::parse(next_url).unwrap();
        let mut next_destination = root.join(format!("giv-{next_token}.download"));
        assert!(capture.handle(DownloadEvent::Requested {
            url: next_parsed.clone(),
            destination: &mut next_destination,
        }));
        assert!(capture.handle(DownloadEvent::Finished {
            url: next_parsed,
            path: Some(next_part.clone()),
            success: true,
        }));
        assert!(matches!(
            capture.wait(
                next_ticket,
                &AtomicBool::new(false),
                Duration::from_secs(1),
                || {}
            ),
            CaptureCompletion::Finished {
                success: true,
                forced_failure: None,
                ..
            }
        ));
        capture.disown_part(52, &next_part).unwrap();
        fs::remove_dir_all(&root).unwrap();
    }

    fn capture_fixture(label: &str) -> (std::path::PathBuf, DownloadCapture, u64, String, std::path::PathBuf, std::path::PathBuf) {
        let root = std::env::temp_dir().join(format!(
            "giv-{label}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&root).unwrap();
        let token = "00000000000000000000000000000060";
        let url = "blob:https://grok.com/00000000-0000-4000-8000-000000000060".to_string();
        let part = root.join(format!("asset.jpg.giv-{token}.part"));
        let final_path = root.join("asset.jpg");
        fs::write(&part, b"partial").unwrap();
        let capture = DownloadCapture::default();
        let ticket = capture
            .arm(CaptureRequest {
                run_id: 60,
                exact_blob_url: url.clone(),
                expected_name: format!("giv-{token}.download"),
                expected_size: 7,
                cancel: Arc::new(AtomicBool::new(false)),
                part_path: part.clone(),
                final_path: final_path.clone(),
            })
            .unwrap();
        (root, capture, ticket, url, part, final_path)
    }

    #[test]
    fn missing_start_event_is_start_timeout_and_blob_can_be_reused() {
        let (root, capture, ticket, url, _part, _final_path) = capture_fixture("start-timeout");
        assert!(matches!(
            capture.wait(ticket, &AtomicBool::new(false), Duration::from_secs(1), || {}),
            CaptureCompletion::Aborted {
                failure: CaptureFailure::StartTimedOut,
                ..
            }
        ));
        let chain = capture.last_chain();
        assert!(!chain.native_download_start_seen);
        assert!(!chain.tauri_requested_seen);
        assert_eq!(chain.blob_sha.as_deref().map(str::len), Some(12));
        assert!(capture.release_unstarted_blob(&url));
        let token = "00000000000000000000000000000061";
        let part = root.join(format!("asset.jpg.giv-{token}.part"));
        fs::write(&part, b"retry").unwrap();
        assert!(capture
            .arm(CaptureRequest {
                run_id: 61,
                exact_blob_url: url,
                expected_name: format!("giv-{token}.download"),
                expected_size: 5,
                cancel: Arc::new(AtomicBool::new(false)),
                part_path: part,
                final_path: root.join("asset.jpg"),
            })
            .is_ok());
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn started_capture_without_finish_is_finish_timeout() {
        let (root, capture, ticket, url, _part, _final_path) = capture_fixture("finish-timeout");
        let mut suggested = root.join("giv-00000000000000000000000000000060.download");
        assert!(capture.handle(DownloadEvent::Requested {
            url: url::Url::parse(&url).unwrap(),
            destination: &mut suggested,
        }));
        assert!(matches!(
            capture.wait(
                ticket,
                &AtomicBool::new(false),
                Duration::from_millis(80),
                || {}
            ),
            CaptureCompletion::Finished {
                forced_failure: Some(CaptureFailure::FinishTimedOut),
                ..
            }
        ));
        assert!(!capture.release_unstarted_blob(&url));
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn native_start_is_authoritative_and_tauri_requested_is_idempotent() {
        let (root, capture, ticket, url, part, _final_path) = capture_fixture("native-auth");
        match capture.native_on_starting(&url, Some("giv-00000000000000000000000000000060.download")) {
            NativeStart::Accept(path) => assert_eq!(path, part),
            NativeStart::Reject => panic!("expected accept"),
        }
        let mut suggested = root.join("giv-00000000000000000000000000000060.download");
        assert!(capture.handle(DownloadEvent::Requested {
            url: url::Url::parse(&url).unwrap(),
            destination: &mut suggested,
        }));
        capture.native_on_finished(&url, true, None, 2);
        assert!(matches!(
            capture.wait(ticket, &AtomicBool::new(false), Duration::from_secs(1), || {}),
            CaptureCompletion::Finished {
                success: true,
                forced_failure: None,
                ..
            }
        ));
        let chain = capture.last_chain();
        assert!(chain.native_download_start_seen);
        assert!(chain.tauri_requested_seen);
        assert_eq!(chain.native_uri_match, Some(true));
        assert!(!capture.release_unstarted_blob(&url));
        assert!(capture.native_should_cancel("blob:https://grok.com/00000000-0000-4000-8000-000000000099"));
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn tauri_finished_false_cannot_fail_a_native_owned_download() {
        let (root, capture, ticket, url, part, _final_path) = capture_fixture("tauri-false");
        match capture.native_on_starting(&url, Some("giv-00000000000000000000000000000060.download")) {
            NativeStart::Accept(path) => assert_eq!(path, part),
            NativeStart::Reject => panic!("expected accept"),
        }
        let parsed = url::Url::parse(&url).unwrap();
        let mut suggested = root.join("giv-00000000000000000000000000000060.download");
        assert!(capture.handle(DownloadEvent::Requested {
            url: parsed.clone(),
            destination: &mut suggested,
        }));
        assert!(capture.handle(DownloadEvent::Finished {
            url: parsed,
            path: None,
            success: false,
        }));
        {
            let pending = lock(&capture.shared.pending);
            let pending = pending.as_ref().unwrap();
            assert!(pending.native_authority);
            assert!(pending.finished.is_none());
            assert!(pending.forced_failure.is_none());
            assert!(pending.chain.tauri_finished_seen);
        }
        capture.native_on_finished(&url, true, None, 2);
        assert!(matches!(
            capture.wait(ticket, &AtomicBool::new(false), Duration::from_secs(1), || {}),
            CaptureCompletion::Finished {
                success: true,
                forced_failure: None,
                ..
            }
        ));
        let chain = capture.last_chain();
        assert!(chain.tauri_finished_seen);
        assert_eq!(chain.native_state_changed, Some(2));
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn native_owned_download_without_state_change_is_finish_timeout() {
        let (root, capture, ticket, url, _part, _final_path) = capture_fixture("native-no-state");
        match capture.native_on_starting(
            &url,
            Some("giv-00000000000000000000000000000060.download"),
        ) {
            NativeStart::Accept(_) => {}
            NativeStart::Reject => panic!("expected accept"),
        }
        assert!(capture.handle(DownloadEvent::Finished {
            url: url::Url::parse(&url).unwrap(),
            path: None,
            success: false,
        }));
        assert!(matches!(
            capture.wait(
                ticket,
                &AtomicBool::new(false),
                Duration::from_millis(80),
                || {}
            ),
            CaptureCompletion::Finished {
                forced_failure: Some(CaptureFailure::FinishTimedOut),
                ..
            }
        ));
        let chain = capture.last_chain();
        assert!(chain.native_download_start_seen);
        assert!(chain.tauri_finished_seen);
        assert!(chain.native_state_changed.is_none());
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn tauri_first_then_native_still_accepts_the_same_ticket() {
        let (root, capture, ticket, url, part, _final_path) = capture_fixture("tauri-first");
        let parsed = url::Url::parse(&url).unwrap();
        let mut suggested = root.join("giv-00000000000000000000000000000060.download");
        assert!(capture.handle(DownloadEvent::Requested {
            url: parsed.clone(),
            destination: &mut suggested,
        }));
        assert_eq!(suggested, part);
        match capture.native_on_starting(&url, part.file_name().and_then(|name| name.to_str())) {
            NativeStart::Accept(path) => assert_eq!(path, part),
            NativeStart::Reject => panic!("Tauri-first must not cancel the same blob"),
        }
        assert!(capture.handle(DownloadEvent::Finished {
            url: parsed,
            path: None,
            success: false,
        }));
        {
            let pending = lock(&capture.shared.pending);
            let pending = pending.as_ref().unwrap();
            assert!(pending.native_authority);
            assert!(pending.finished.is_none());
            assert!(pending.forced_failure.is_none());
        }
        capture.native_on_finished(&url, true, None, 2);
        assert!(matches!(
            capture.wait(ticket, &AtomicBool::new(false), Duration::from_secs(1), || {}),
            CaptureCompletion::Finished {
                success: true,
                forced_failure: None,
                ..
            }
        ));
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn tauri_first_keeps_the_original_suggested_download_name() {
        let (root, capture, _ticket, url, part, _final_path) = capture_fixture("tauri-first-name");
        let mut suggested = root.join("giv-00000000000000000000000000000060.download");
        assert!(capture.handle(DownloadEvent::Requested {
            url: url::Url::parse(&url).unwrap(),
            destination: &mut suggested,
        }));
        match capture.native_on_starting(
            &url,
            Some("giv-00000000000000000000000000000060.download"),
        ) {
            NativeStart::Accept(path) => assert_eq!(path, part),
            NativeStart::Reject => panic!("original click name must still match"),
        }
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn permission_note_is_copied_onto_the_armed_ticket() {
        let (root, capture, ticket, _url, ..) = capture_fixture("perm-note");
        capture.record_permission(PermissionNote {
            kind: 7,
            host: "grok.com".into(),
            state: 0,
            during_run: true,
            allowed: true,
        });
        capture.abort(ticket, CaptureFailure::StartTimedOut);
        let _ = capture.wait(ticket, &AtomicBool::new(false), Duration::from_secs(1), || {});
        let chain = capture.last_chain();
        assert_eq!(chain.permission_kind, Some(7));
        assert_eq!(chain.permission_host.as_deref(), Some("grok.com"));
        assert_eq!(chain.permission_allowed, Some(true));
        assert_eq!(chain.permission_during_run, Some(true));
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn automatic_download_permission_is_only_allowed_for_an_active_grok_run() {
        assert!(decide_automatic_download_permission(7, true, true));
        assert!(!decide_automatic_download_permission(7, true, false));
        assert!(!decide_automatic_download_permission(7, false, true));
        assert!(!decide_automatic_download_permission(1, true, true));
        assert!(is_strict_grok_https_origin("https://grok.com/imagine"));
        assert!(!is_strict_grok_https_origin("https://grok.com.evil.test/imagine"));
        assert!(!is_strict_grok_https_origin("https://user:pass@grok.com/imagine"));
        assert!(!is_strict_grok_https_origin("https://grok.com:444/imagine"));
        assert_eq!(permission_host_label("https://grok.com/imagine"), "grok.com");
        assert_eq!(permission_host_label("https://example.com/"), "other");
    }

    #[test]
    fn capture_retry_reuses_blob_only_when_no_download_started() {
        assert_eq!(
            capture_retry_kind(CaptureFailure::StartTimedOut, false, false, 0),
            CaptureRetry::Trigger
        );
        assert_eq!(
            capture_retry_kind(CaptureFailure::StartTimedOut, false, false, 1),
            CaptureRetry::None
        );
        assert_eq!(
            capture_retry_kind(CaptureFailure::StartTimedOut, true, false, 0),
            CaptureRetry::None
        );
        assert_eq!(
            capture_retry_kind(CaptureFailure::FinishTimedOut, true, false, 0),
            CaptureRetry::None
        );
        assert_eq!(
            capture_retry_kind(CaptureFailure::Failed, false, false, 0),
            CaptureRetry::Trigger
        );
        assert_eq!(
            capture_retry_kind(CaptureFailure::Storage, false, false, 0),
            CaptureRetry::Prepare
        );
    }

    #[test]
    fn navigation_epoch_invalidates_a_reserved_download() {
        let state = DownloadState::default();
        let reservation = state.reserve().unwrap();
        let old_navigation = reservation.navigation.clone();
        assert!(old_navigation.is_current());
        assert!(!reservation.is_cancelled());

        state.navigation_started();
        assert!(!old_navigation.is_current());
        assert!(reservation.is_cancelled());

        let next = state.reserve().unwrap();
        assert!(next.navigation.is_current());
        assert!(!next.is_cancelled());
    }

    #[test]
    fn unrelated_blob_is_not_a_valid_pending_target() {
        assert!(is_grok_blob_url(
            "blob:https://grok.com/00000000-0000-4000-8000-000000000000"
        ));
        assert!(!is_grok_blob_url(
            "blob:https://evil.example/00000000-0000-4000-8000-000000000000"
        ));
    }

    #[test]
    fn native_stage_paths_are_only_the_local_capture_temp() {
        let token = "0123456789abcdef0123456789abcdef";
        assert_eq!(
            token_from_expected_name(&format!("giv-{token}.download")),
            Some(token)
        );
        assert_eq!(
            native_stage_dir().file_name().and_then(|name| name.to_str()),
            Some("giv-webview2-capture")
        );
        let staged = native_stage_dir().join(format!("{token}.part"));
        assert!(is_native_stage_path(&staged));
        assert!(!is_native_stage_path(&PathBuf::from(format!(
            "\\\\nas\\gallery\\_inbox\\0000_inbox\\asset.jpg.giv-{token}.part"
        ))));
        assert!(!is_native_stage_path(
            &std::env::temp_dir().join(format!("{token}.part"))
        ));
        assert!(!is_native_stage_path(
            &native_stage_dir().join("not-a-token.part")
        ));
    }
}
