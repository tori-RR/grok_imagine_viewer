use serde::{Deserialize, Serialize};
use std::{
    error::Error,
    io,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Condvar, Mutex, OnceLock,
    },
    time::{Duration, Instant},
};
use tauri::{
    ipc::CapabilityBuilder,
    webview::{
        NewWindowFeatures, NewWindowResponse, PageLoadEvent, WebviewBuilder, WebviewWindowBuilder,
    },
    window::{Window, WindowBuilder},
    AppHandle, Manager, PhysicalPosition, PhysicalSize, Rect, Runtime, State, Webview, WebviewUrl,
    WindowEvent,
};
use url::Url;

pub(crate) const WINDOW_LABEL: &str = "main";
const GALLERY_LABEL: &str = "gallery";
const GROK_LABEL: &str = "grok";
const GROK_URL: &str = "https://grok.com/imagine";
const DEFAULT_CHROME_HEIGHT: f64 = 64.0;
const MAX_CHROME_HEIGHT: f64 = 400.0;
// Match static/style.css --bg while WebView2 waits for the next painted frame.
const WINDOW_BACKGROUND: tauri::window::Color = tauri::window::Color(7, 7, 8, 255);
const AUTH_POPUP_DESTROY_TIMEOUT: Duration = Duration::from_secs(5);
const WEBVIEW_DATA_DIRS: [&str; 2] = ["gallery-webview2", "grok-webview2"];
static GROK_AUTH_SEQUENCE: AtomicU64 = AtomicU64::new(1);
static AUTH_TRACE_START: OnceLock<Instant> = OnceLock::new();

/// Keep WebView2's cache/profile beside the portable executable on Windows.
///
/// The gallery itself owns its `.viewer-cache` under the selected library and
/// application settings remain in Tauri's config directory.  Only the two
/// isolated WebView data directories are portable runtime state here.
fn webview_data_dir<R: Runtime>(app: &AppHandle<R>, name: &str) -> Result<PathBuf, Box<dyn Error>> {
    if let Some(fixture) = crate::local_fixture::current() { return Ok(fixture.root.join("profiles").join(name)); }
    let legacy = app.path().app_local_data_dir()?.join(name);

    #[cfg(windows)]
    {
        let exe = std::env::current_exe()?;
        let exe_dir = exe
            .parent()
            .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "executable directory unavailable"))?;
        let target = exe_dir.join(name);
        migrate_webview_dir(&legacy, &target)?;
        std::fs::create_dir_all(&target)?;
        Ok(target)
    }

    #[cfg(not(windows))]
    {
        Ok(legacy)
    }
}

#[cfg(windows)]
fn migrate_webview_dir(legacy: &Path, target: &Path) -> Result<(), Box<dyn Error>> {
    if target.exists() {
        let metadata = std::fs::symlink_metadata(target)?;
        if !metadata.is_dir() || metadata.file_type().is_symlink() {
            return Err(io::Error::new(
                io::ErrorKind::AlreadyExists,
                format!("refusing unsafe WebView data directory: {}", target.display()),
            )
            .into());
        }
        return Ok(());
    }
    if !legacy.exists() {
        return Ok(());
    }

    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent)?;
    }

    // The usual case is a same-volume move, which keeps the existing Grok
    // login session without copying hundreds of megabytes.  If the user
    // moved the portable folder to another volume, copy into a temporary
    // sibling and retain the legacy source as a rollback/fallback copy.
    match std::fs::rename(legacy, target) {
        Ok(()) => Ok(()),
        Err(rename_error) => {
            let pid = std::process::id();
            let name = target
                .file_name()
                .and_then(|value| value.to_str())
                .unwrap_or("webview");
            let staging = target.with_file_name(format!(".{name}.migration-{pid}"));
            if staging.exists() {
                return Err(io::Error::new(
                    io::ErrorKind::AlreadyExists,
                    format!("WebView migration staging path already exists: {}", staging.display()),
                )
                .into());
            }
            if let Err(copy_error) = copy_webview_tree(legacy, &staging) {
                let _ = std::fs::remove_dir_all(&staging);
                return Err(io::Error::new(
                    copy_error.kind(),
                    format!(
                        "cannot move WebView data to {} (rename: {}; copy: {})",
                        target.display(), rename_error, copy_error
                    ),
                )
                .into());
            }
            std::fs::rename(&staging, target).map_err(|error| {
                let _ = std::fs::remove_dir_all(&staging);
                io::Error::new(
                    error.kind(),
                    format!("cannot activate WebView data directory {}: {error}", target.display()),
                )
            })?;
            Ok(())
        }
    }
}

#[cfg(windows)]
fn copy_webview_tree(source: &Path, target: &Path) -> io::Result<()> {
    let metadata = std::fs::symlink_metadata(source)?;
    if metadata.file_type().is_symlink() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("refusing symlink in WebView data: {}", source.display()),
        ));
    }
    if metadata.is_dir() {
        std::fs::create_dir_all(target)?;
        for entry in std::fs::read_dir(source)? {
            let entry = entry?;
            copy_webview_tree(&entry.path(), &target.join(entry.file_name()))?;
        }
        Ok(())
    } else if metadata.is_file() {
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::copy(source, target).map(|_| ())
    } else {
        Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("unsupported WebView data entry: {}", source.display()),
        ))
    }
}

pub(crate) struct ViewerState {
    gallery_origin: Url,
    backend_session: crate::backend::BackendSession,
    chrome_height: Arc<Mutex<f64>>,
    grok_visible: Arc<AtomicBool>,
    active_auth_popup: Arc<AuthPopupState>,
    auth_session_gate: Arc<Mutex<()>>,
    /// Set by `stop_download` so the pre-reservation page preparation can be
    /// interrupted. A reservation does not exist yet at that point, so the
    /// usual run cancellation flag cannot cover this window.
    grok_prepare_cancel: Arc<AtomicBool>,
}

#[derive(Default)]
struct AuthPopupState {
    active: Mutex<Option<String>>,
    changed: Condvar,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CloseRequest {
    Allow,
    BeginShutdown,
    Wait,
}

#[derive(Default)]
struct CloseLifecycle {
    stopping: AtomicBool,
    ready: AtomicBool,
}

impl CloseLifecycle {
    fn request(&self) -> CloseRequest {
        if self.ready.load(Ordering::Acquire) {
            return CloseRequest::Allow;
        }
        if self
            .stopping
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_ok()
        {
            CloseRequest::BeginShutdown
        } else {
            CloseRequest::Wait
        }
    }

    fn finish(&self) {
        self.ready.store(true, Ordering::Release);
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct StartDownloadArgs {
    root: String,
    #[serde(default)]
    retry_of: Option<String>,
    #[serde(default)]
    retry_asset_ids: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DownloadResponse {
    #[serde(flatten)]
    persistence: Box<crate::download::DownloadPersistence>,
    ok: bool,
    stopped: bool,
    not_logged_in: bool,
    mismatch: bool,
    /// Media were committed and the index was rewritten. True for a clean run
    /// and for a partial one, so the page knows a refresh is worth doing.
    published: bool,
    /// Some media succeeded and some failed. `ok` stays false.
    partial: bool,
    counts: crate::download::DownloadCounts,
    failures: Vec<crate::download::DownloadFailure>,
    #[serde(skip_serializing_if = "Option::is_none")]
    code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    user_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

impl DownloadResponse {
    fn blank(ok: bool, stopped: bool) -> Self {
        Self {
            persistence: Box::default(),
            ok,
            stopped,
            not_logged_in: false,
            mismatch: false,
            published: false,
            partial: false,
            counts: crate::download::DownloadCounts::default(),
            failures: Vec::new(),
            code: None,
            user_id: None,
            error: None,
        }
    }

    fn success() -> Self {
        Self::blank(true, false)
    }

    fn stopped() -> Self {
        Self::blank(true, true)
    }

    fn not_logged_in() -> Self {
        Self {
            not_logged_in: true,
            code: Some(crate::download::PROBE_NOT_LOGGED_IN.to_owned()),
            ..Self::blank(false, false)
        }
    }

    fn mismatch() -> Self {
        Self {
            mismatch: true,
            code: Some("account_mismatch".to_owned()),
            ..Self::blank(false, false)
        }
    }

    fn failure(error: impl Into<String>) -> Self {
        Self {
            error: Some(error.into()),
            ..Self::blank(false, false)
        }
    }

    fn coded(code: &str, error: impl Into<String>) -> Self {
        Self {
            code: Some(code.to_owned()),
            ..Self::failure(error)
        }
    }

    /// Preserve the run's category, counts and publication state instead of
    /// collapsing everything into a single boolean.
    pub(crate) fn from_run(result: crate::download::DownloadRunResult) -> Self {
        if result.stopped {
            return Self {
                persistence: result.persistence,
                counts: result.counts,
                failures: result.failures,
                published: result.published,
                ..Self::stopped()
            };
        }
        if result.ok {
            return Self {
                persistence: result.persistence,
                counts: result.counts,
                failures: result.failures,
                published: result.published,
                ..Self::success()
            };
        }
        let partial = result.code.as_deref() == Some("partial");
        Self {
            partial,
            persistence: result.persistence,
            published: result.published,
            counts: result.counts,
            failures: result.failures,
            code: result.code,
            error: Some(result.error.unwrap_or_else(|| "下载失败。".into())),
            ..Self::blank(false, false)
        }
    }

    fn from_probe(probe: &crate::download::ProbeResponse) -> Self {
        match probe.code.as_deref() {
            Some(crate::download::PROBE_NOT_LOGGED_IN) | None => Self::not_logged_in(),
            Some(code) => Self::coded(code, crate::download::describe_page_code(code)),
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ModeResponse {
    ok: bool,
    mode: &'static str,
    engine: &'static str,
    browser: &'static str,
    reused: bool,
    docked: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

impl ModeResponse {
    fn success(mode: &'static str) -> Self {
        Self {
            ok: true,
            mode,
            engine: "webview2",
            browser: "WebView2",
            reused: true,
            docked: mode == "grok",
            error: None,
        }
    }

    fn failure(mode: &'static str, error: impl Into<String>) -> Self {
        Self {
            ok: false,
            mode,
            engine: "webview2",
            browser: "WebView2",
            reused: true,
            docked: false,
            error: Some(error.into()),
        }
    }
}

fn exact_gallery_origin(url: &Url) -> io::Result<String> {
    if url.scheme() != "http"
        || url.host_str() != Some("127.0.0.1")
        || url.port().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "gallery URL is not an exact loopback HTTP origin",
        ));
    }
    Ok(url.origin().ascii_serialization())
}

fn normalized_chrome_height(height: f64) -> Option<f64> {
    height
        .is_finite()
        .then(|| height.round().clamp(0.0, MAX_CHROME_HEIGHT))
}

fn host_is_or_subdomain(host: &str, root: &str) -> bool {
    host == root
        || host
            .strip_suffix(root)
            .is_some_and(|prefix| prefix.ends_with('.'))
}

fn normalized_https_host(url: &Url) -> Option<&str> {
    if url.scheme() != "https"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port_or_known_default() != Some(443)
    {
        return None;
    }
    let host = url.host_str()?;
    (host.is_ascii() && !host.ends_with('.')).then_some(host)
}

fn is_about_blank(url: &Url) -> bool {
    url.scheme() == "about"
        && url.cannot_be_a_base()
        && url.path() == "blank"
        && url.query().is_none()
        && url.fragment().is_none()
}

fn is_allowed_grok_navigation(url: &Url) -> bool {
    if is_about_blank(url) {
        return true;
    }
    let Some(host) = normalized_https_host(url) else {
        return false;
    };
    ["grok.com", "x.ai", "x.com", "twitter.com"]
        .iter()
        .any(|root| host_is_or_subdomain(host, root))
        || matches!(host, "accounts.google.com" | "appleid.apple.com")
}

fn auth_trace_target(url: &Url) -> String {
    format!(
        "scheme={} host={}",
        url.scheme(),
        url.host_str().unwrap_or("<none>")
    )
}

fn trace_auth_event(event: &str, url: &Url, decision: Option<bool>) {
    if std::env::var("GIV_AUTH_TRACE").as_deref() != Ok("1") {
        return;
    }
    let elapsed = AUTH_TRACE_START
        .get_or_init(Instant::now)
        .elapsed()
        .as_millis();
    let decision = match decision {
        Some(true) => "allow",
        Some(false) => "deny",
        None => "observe",
    };
    eprintln!(
        "giv-auth elapsed_ms={elapsed} event={event} decision={decision} {}",
        auth_trace_target(url)
    );
}

fn traced_grok_navigation(event: &str, url: &Url) -> bool {
    let allowed = is_allowed_grok_navigation(url);
    trace_auth_event(event, url, Some(allowed));
    allowed
}

fn managed_grok_popup<R: Runtime>(
    app: &AppHandle<R>,
    active_popup: &Arc<AuthPopupState>,
    session_gate: &Arc<Mutex<()>>,
    url: Url,
    features: NewWindowFeatures,
) -> NewWindowResponse<R> {
    let _session_guard = session_gate
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if app
        .try_state::<crate::download::DownloadState>()
        .is_some_and(|state| state.is_busy())
    {
        trace_auth_event("popup-download-busy", &url, Some(false));
        return NewWindowResponse::Deny;
    }
    if !traced_grok_navigation("popup-request", &url) {
        return NewWindowResponse::Deny;
    }

    let existing = active_popup
        .active
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .clone();
    if let Some(label) = existing {
        if let Some(popup) = app.get_webview_window(&label) {
            trace_auth_event("popup-duplicate", &url, Some(false));
            let _ = popup.show();
            let _ = popup.set_focus();
            return NewWindowResponse::Deny;
        }
        let mut active = active_popup
            .active
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if active.as_deref() == Some(label.as_str()) {
            *active = None;
            drop(active);
            active_popup.changed.notify_all();
        }
    }

    let sequence = GROK_AUTH_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    let label = format!("grok-auth-{sequence}");
    let blank = Url::parse("about:blank").expect("about:blank must parse");
    // window_features() copies opener size/position and, on Windows, the
    // opener ICoreWebView2Environment. That is the official Tauri 2.11 path
    // for NewWindowResponse::Create; do not build a second environment.
    let popup = WebviewWindowBuilder::new(app, &label, WebviewUrl::External(blank))
        .window_features(features)
        .title("Grok 登录")
        .inner_size(720.0, 820.0)
        .min_inner_size(480.0, 600.0)
        .center()
        .devtools(false)
        .on_navigation(|candidate| traced_grok_navigation("popup-navigation", candidate))
        .on_new_window(|nested, _| {
            trace_auth_event("popup-nested", &nested, Some(false));
            NewWindowResponse::Deny
        })
        .on_page_load(|_, payload| {
            let event = match payload.event() {
                PageLoadEvent::Started => "popup-load-start",
                PageLoadEvent::Finished => "popup-load-finish",
            };
            trace_auth_event(event, payload.url(), None);
        })
        .on_download(|_, _| false)
        .build();

    let popup = match popup {
        Ok(popup) => popup,
        Err(_) => {
            trace_auth_event("popup-build", &url, Some(false));
            return NewWindowResponse::Deny;
        }
    };

    *active_popup
        .active
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(label.clone());
    let closed_popup = Arc::clone(active_popup);
    let closed_label = label;
    let focus_app = app.clone();
    popup.on_window_event(move |event| {
        if matches!(event, WindowEvent::Destroyed) {
            let mut active = closed_popup
                .active
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            let mut cleared = false;
            if active.as_deref() == Some(closed_label.as_str()) {
                *active = None;
                cleared = true;
            }
            drop(active);
            if cleared {
                closed_popup.changed.notify_all();
            }
            let download_busy = focus_app
                .try_state::<crate::download::DownloadState>()
                .is_some_and(|state| state.is_busy());
            let target = if download_busy {
                GALLERY_LABEL
            } else {
                GROK_LABEL
            };
            if let Some(webview) = focus_app.get_webview(target) {
                let _ = webview.set_focus();
            }
        }
    });

    NewWindowResponse::Create { window: popup }
}

fn request_destroy_active_auth_popup<R: Runtime>(
    app: &AppHandle<R>,
    active_popup: &Arc<AuthPopupState>,
) -> Result<Option<String>, String> {
    let label = active_popup
        .active
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .clone();
    let Some(label) = label else {
        return Ok(None);
    };
    if let Some(popup) = app.get_webview_window(&label) {
        popup
            .destroy()
            .map_err(|_| "无法关闭登录窗口，下载没有启动。".to_string())?;
        return Ok(Some(label));
    }

    let mut active = active_popup
        .active
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if active.as_deref() == Some(label.as_str()) {
        *active = None;
        drop(active);
        active_popup.changed.notify_all();
    }
    Ok(None)
}

fn wait_for_auth_popup_destroyed(
    active_popup: &AuthPopupState,
    label: &str,
    timeout: Duration,
) -> bool {
    let active = active_popup
        .active
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let (active, _) = active_popup
        .changed
        .wait_timeout_while(active, timeout, |value| value.as_deref() == Some(label))
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    active.as_deref() != Some(label)
}

const GALLERY_BRIDGE_VERSION: u32 = 3;

fn gallery_bridge_script(origin: &str) -> String {
    let origin = serde_json::to_string(origin).expect("loopback origin must serialize");
    let shell_version = serde_json::to_string(env!("CARGO_PKG_VERSION"))
        .expect("shell version must serialize");
    let bridge_version = GALLERY_BRIDGE_VERSION;
    format!(
        r#"
(() => {{
  if (window !== window.top || window.location.origin !== {origin}) return;
  if (!window.__TAURI_INTERNALS__ || window.viewer) return;
  const invoke = (command, args) => window.__TAURI_INTERNALS__.invoke(command, args || {{}});
  const viewer = Object.freeze({{
    // Declared identity and capabilities for the Tauri-only desktop bridge.
    shell: "tauri",
    shellVersion: {shell_version},
    bridgeVersion: {bridge_version},
    capabilities: Object.freeze([
      "setMode",
      "reopenGrok",
      "reportChrome",
      "startDownload",
      "stopDownload", "openGrokMedia", "resizeForMedia", "toggleWindowFullscreen", "setGuestMuted",
      "pickLibrary", "createLibrary", "getPlaybackAcceleration", "setPlaybackAcceleration",
      "getEnvironmentStatus", "installEnvironmentComponent"
    ]),
    setMode: (mode) => invoke("set_viewer_mode", {{ mode }}),
    reopenGrok: () => invoke("reopen_grok"),
    pickLibrary: () => invoke("pick_library"),
    createLibrary: () => invoke("create_library"),
    getPlaybackAcceleration: () => invoke("get_playback_acceleration"),
    setPlaybackAcceleration: (mode) => invoke("set_playback_acceleration", {{ mode }}),
    getEnvironmentStatus: () => invoke("get_environment_status"),
    installEnvironmentComponent: (component) => invoke("install_environment_component", {{ component }}),
    startDownload: (args) => invoke("start_download", {{ args }}),
    stopDownload: () => invoke("stop_download"),
    openGrokMedia: (url) => invoke("open_grok_media", {{ url }}),
    resizeForMedia: (args) => invoke("resize_for_media", {{ args }}),
    toggleWindowFullscreen: () => invoke("toggle_window_fullscreen"),
    setGuestMuted: (muted) => invoke("set_grok_muted", {{ muted }}),
    onDownloadStatus: (callback) => {{
      if (typeof callback !== "function") return () => {{}};
      const handler = (event) => callback(String(event.detail || ""));
      window.addEventListener("giv-download-status", handler);
      return () => window.removeEventListener("giv-download-status", handler);
    }},
    reportChrome: (height) => {{
      void invoke("report_chrome_height", {{ height }}).catch(() => {{}});
    }}
  }});
  Object.defineProperty(window, "viewer", {{
    configurable: false,
    enumerable: false,
    writable: false,
    value: viewer
  }});
}})();
"#
    )
}

fn physical_top(height: f64, scale_factor: f64, total_height: u32) -> u32 {
    (height * scale_factor)
        .round()
        .clamp(0.0, total_height as f64) as u32
}

fn layout_children(
    gallery: &Webview,
    grok: &Webview,
    size: PhysicalSize<u32>,
    scale_factor: f64,
    chrome_height: f64,
    resize_grok: bool,
) -> tauri::Result<()> {
    // Minimized windows must not force zero-sized WebView layouts.
    if size.width == 0 || size.height == 0 {
        return Ok(());
    }
    gallery.set_bounds(Rect {
        position: PhysicalPosition::<i32>::new(0, 0).into(),
        size: size.into(),
    })?;
    if !resize_grok {
        return Ok(());
    }
    let top = physical_top(chrome_height, scale_factor, size.height);
    grok.set_bounds(Rect {
        position: PhysicalPosition::<i32>::new(0, top as i32).into(),
        size: PhysicalSize::<u32>::new(size.width, size.height.saturating_sub(top)).into(),
    })
}

fn require_gallery_caller(caller: &Webview, state: &ViewerState) -> Result<(), String> {
    if caller.label() != GALLERY_LABEL {
        return Err("desktop command denied for this webview".into());
    }
    let current = caller
        .url()
        .map_err(|_| "cannot verify desktop command origin")?;
    if !crate::backend::same_origin(&state.gallery_origin, &current) {
        return Err("desktop command denied for this origin".into());
    }
    Ok(())
}

fn same_canonical_path(left: &Path, right: &Path) -> bool {
    #[cfg(windows)]
    {
        left.to_string_lossy()
            .eq_ignore_ascii_case(&right.to_string_lossy())
    }
    #[cfg(not(windows))]
    {
        left == right
    }
}

#[cfg(windows)]
fn windows_attributes_are_reparse_point(attributes: u32) -> bool {
    // Win32 FILE_ATTRIBUTE_REPARSE_POINT. Keep the mask local so this check
    // remains compatible with the project's Rust 1.77.2 MSRV.
    const FILE_ATTRIBUTE_REPARSE_POINT_MASK: u32 = 0x0000_0400;
    attributes & FILE_ATTRIBUTE_REPARSE_POINT_MASK != 0
}

fn metadata_is_reparse_point(metadata: &std::fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;

        windows_attributes_are_reparse_point(metadata.file_attributes())
    }
    #[cfg(not(windows))]
    {
        let _ = metadata;
        false
    }
}

fn reject_linked_gallery_root(path: &Path, unavailable: &str) -> Result<(), String> {
    let metadata = std::fs::symlink_metadata(path).map_err(|_| unavailable.to_string())?;
    if metadata.file_type().is_symlink() || metadata_is_reparse_point(&metadata) {
        return Err("图库根目录不能是符号链接或重解析点。".into());
    }
    Ok(())
}

fn validated_gallery_root(requested: &str, configured: Option<PathBuf>) -> Result<PathBuf, String> {
    let requested = requested.trim();
    if requested.is_empty() {
        return Err("没有图库路径。".into());
    }
    let configured = configured.ok_or_else(|| "当前没有打开图库。".to_string())?;
    let requested = PathBuf::from(requested);
    if !requested.is_absolute() || !configured.is_absolute() {
        return Err("图库目录必须是绝对路径。".into());
    }
    reject_linked_gallery_root(&requested, "前端请求的图库目录不存在或无法访问。")?;
    reject_linked_gallery_root(&configured, "当前图库目录不存在或无法访问。")?;
    let requested = std::fs::canonicalize(&requested)
        .map_err(|_| "前端请求的图库目录不存在或无法访问。".to_string())?;
    let configured = std::fs::canonicalize(&configured)
        .map_err(|_| "当前图库目录不存在或无法访问。".to_string())?;
    if !requested.is_dir() || !configured.is_dir() || !same_canonical_path(&requested, &configured)
    {
        return Err("下载目标与当前图库不一致。".into());
    }
    Ok(configured)
}

fn download_status_script(text: &str) -> String {
    let text: String = text.chars().take(4096).collect();
    let detail = serde_json::to_string(&text).expect("download status must serialize");
    format!("window.dispatchEvent(new CustomEvent(\"giv-download-status\",{{detail:{detail}}}));")
}

fn current_handles(app: &AppHandle) -> Result<(Window, Webview, Webview), String> {
    let window = app
        .get_window(WINDOW_LABEL)
        .ok_or_else(|| "main window is unavailable".to_string())?;
    let gallery = app
        .get_webview(GALLERY_LABEL)
        .ok_or_else(|| "gallery webview is unavailable".to_string())?;
    let grok = app
        .get_webview(GROK_LABEL)
        .ok_or_else(|| "Grok webview is unavailable".to_string())?;
    Ok((window, gallery, grok))
}

fn relayout(app: &AppHandle, state: &ViewerState) -> Result<(), String> {
    let (window, gallery, grok) = current_handles(app)?;
    let size = window.inner_size().map_err(|error| error.to_string())?;
    let scale_factor = window.scale_factor().map_err(|error| error.to_string())?;
    let height = *state
        .chrome_height
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    // Also prepare the hidden Grok view before showing it after a mode switch.
    layout_children(&gallery, &grok, size, scale_factor, height, true)
        .map_err(|error| error.to_string())
}

fn require_download_idle(app: &AppHandle) -> Result<(), String> {
    if app
        .try_state::<crate::download::DownloadState>()
        .is_some_and(|state| state.is_busy())
    {
        return Err("请先停止下载，再打开或重开 Grok。".into());
    }
    Ok(())
}

#[allow(clippy::result_large_err)]
fn bind_download_root(
    session: &crate::backend::BackendSession,
    root: &Path,
    user_id: &str,
    commit: bool,
) -> Result<PathBuf, DownloadResponse> {
    match crate::backend::bind_download_account(session, root, user_id, commit) {
        Ok(crate::backend::DownloadBindOutcome::Bound(root)) => Ok(root),
        Ok(crate::backend::DownloadBindOutcome::AccountMismatch) => {
            Err(DownloadResponse::mismatch())
        }
        Ok(crate::backend::DownloadBindOutcome::UnsupportedMode) => {
            Err(DownloadResponse::failure("下载只支持带 _index.json 的完整图库。"))
        }
        Ok(crate::backend::DownloadBindOutcome::RootChanged) => {
            Err(DownloadResponse::failure("图库已经切换，这次下载没有写入任何文件。"))
        }
        Err(error) => Err(DownloadResponse::failure(error.to_string())),
    }
}

fn apply_mode(
    app: &AppHandle,
    state: &ViewerState,
    mode: &'static str,
    reload: bool,
) -> ModeResponse {
    let result = (|| -> Result<(), String> {
        let (_, gallery, grok) = current_handles(app)?;
        if mode == "gallery" {
            grok.hide().map_err(|error| error.to_string())?;
            state.grok_visible.store(false, Ordering::Release);
            gallery.show().map_err(|error| error.to_string())?;
            gallery.set_focus().map_err(|error| error.to_string())?;
            return Ok(());
        }

        let needs_initial_load = grok
            .url()
            .map(|url| url.as_str() == "about:blank")
            .unwrap_or(true);
        if reload || needs_initial_load {
            let url = Url::parse(GROK_URL).map_err(|error| error.to_string())?;
            grok.navigate(url).map_err(|error| error.to_string())?;
        }
        relayout(app, state)?;
        grok.show().map_err(|error| error.to_string())?;
        state.grok_visible.store(true, Ordering::Release);
        grok.set_focus().map_err(|error| error.to_string())
    })();

    match result {
        Ok(()) => ModeResponse::success(mode),
        Err(error) => ModeResponse::failure(mode, error),
    }
}

#[tauri::command]
pub(crate) fn set_viewer_mode(
    mode: String,
    caller: Webview,
    app: AppHandle,
    state: State<'_, ViewerState>,
) -> Result<ModeResponse, String> {
    require_gallery_caller(&caller, &state)?;
    let mode = if mode == "grok" { "grok" } else { "gallery" };
    if mode == "grok" {
        require_download_idle(&app)?;
    }
    Ok(apply_mode(&app, &state, mode, false))
}

#[tauri::command]
pub(crate) fn report_chrome_height(
    height: f64,
    caller: Webview,
    app: AppHandle,
    state: State<'_, ViewerState>,
) -> Result<(), String> {
    require_gallery_caller(&caller, &state)?;
    let Some(height) = normalized_chrome_height(height) else {
        return Ok(());
    };
    {
        let mut current = state
            .chrome_height
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if *current == height {
            return Ok(());
        }
        *current = height;
    }
    relayout(&app, &state)
}

#[tauri::command]
pub(crate) fn reopen_grok(
    caller: Webview,
    app: AppHandle,
    state: State<'_, ViewerState>,
) -> Result<ModeResponse, String> {
    require_gallery_caller(&caller, &state)?;
    require_download_idle(&app)?;
    Ok(apply_mode(&app, &state, "grok", true))
}

fn run_download(
    requested_root: String,
    backend_session: crate::backend::BackendSession,
    grok: Webview,
    status_gallery: Webview,
    state: crate::download::DownloadState,
    reservation: crate::download::DownloadReservation,
    retry: Option<crate::download::DownloadRetry>,
) -> DownloadResponse {
    let configured = match crate::backend::current_gallery_root(&backend_session) {
        Ok(root) => root,
        Err(error) => return DownloadResponse::failure(error.to_string()),
    };
    let root = match validated_gallery_root(&requested_root, configured) {
        Ok(root) => root,
        Err(error) => return DownloadResponse::failure(error),
    };
    if reservation.is_cancelled() {
        return DownloadResponse::stopped();
    }
    let emit: crate::download::StatusCallback = Arc::new(move |text| {
        let script = download_status_script(&text);
        let _ = status_gallery.eval(&script);
    });
    emit("下载：正在检查 grok.com 登录…".into());
    let probe = probe_grok_user_with_retry(&grok, &reservation);
    if probe.stopped {
        return DownloadResponse::stopped();
    }
    if !probe.ok {
        return match probe.error {
            Some(error) => DownloadResponse::failure(error),
            None => DownloadResponse::from_probe(&probe),
        };
    }
    let Some(user_id) = probe.user_id else {
        return DownloadResponse::not_logged_in();
    };
    if reservation.is_cancelled() {
        return DownloadResponse::stopped();
    }

    emit("下载：正在核对图库账号…".into());
    let root = match bind_download_root(&backend_session, &root, &user_id, false) {
        Ok(root) => root,
        Err(response) => return response,
    };
    if reservation.is_cancelled() {
        return DownloadResponse::stopped();
    }
    emit("下载：登录正常，开始导出…".into());
    let started = reservation.start(grok, root, user_id, emit, retry, backend_session);
    if started.stopped {
        return DownloadResponse::stopped();
    }
    if !started.ok {
        return DownloadResponse::failure(
            started.error.unwrap_or_else(|| "无法启动下载任务。".into()),
        );
    }
    let Some(run_id) = started.run_id else {
        return DownloadResponse::failure("下载任务没有返回运行编号。");
    };
    DownloadResponse::from_run(state.wait(run_id))
}

const PROBE_ATTEMPTS: u32 = 5;

/// A cold start leaves the Grok webview on a freshly loaded document. The first
/// probe can fail because the page is not ready yet, which is not the same as a
/// missing session, so retry the transient categories before giving up.
fn probe_grok_user_with_retry(
    grok: &Webview,
    reservation: &crate::download::DownloadReservation,
) -> crate::download::ProbeResponse {
    let mut last = crate::download::probe_grok_user(grok, reservation);
    for attempt in 1..PROBE_ATTEMPTS {
        if last.ok || last.stopped || reservation.is_cancelled() {
            return last;
        }
        let transient = last
            .code
            .as_deref()
            .is_some_and(crate::download::page_code_is_transient);
        if !transient {
            return last;
        }
        std::thread::sleep(Duration::from_millis(400 * u64::from(attempt)));
        if reservation.is_cancelled() {
            return crate::download::ProbeResponse::stopped_public();
        }
        last = crate::download::probe_grok_user(grok, reservation);
    }
    last
}

const GROK_PAGE_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Debug, PartialEq, Eq)]
enum PagePrepare {
    Ready,
    Stopped,
    Failed(String),
}

fn grok_page_is_loaded(grok: &Webview) -> bool {
    grok.url().ok().is_some_and(|url| {
        url.scheme() == "https"
            && url.host_str() == Some("grok.com")
            && url.port_or_known_default() == Some(443)
    })
}

/// Load the Grok document once, before a reservation exists.
///
/// Every allowed top-level navigation bumps the download epoch and stops the
/// active run, so navigating after `reserve()` would cancel the very download
/// being started. An already loaded page is left alone: re-navigating on each
/// download would throw away a working session view for no reason.
fn prepare_grok_page(grok: &Webview, cancel: &AtomicBool) -> PagePrepare {
    if grok_page_is_loaded(grok) {
        return PagePrepare::Ready;
    }
    if cancel.load(Ordering::Acquire) {
        return PagePrepare::Stopped;
    }
    let url = match Url::parse(GROK_URL) {
        Ok(url) => url,
        Err(_) => return PagePrepare::Failed("Grok 页面地址无效。".into()),
    };
    if grok.navigate(url).is_err() {
        return PagePrepare::Failed("无法加载 Grok 页面，下载没有启动。".into());
    }
    let deadline = Instant::now() + GROK_PAGE_TIMEOUT;
    while Instant::now() < deadline {
        if cancel.load(Ordering::Acquire) {
            return PagePrepare::Stopped;
        }
        if grok_page_is_loaded(grok) {
            return PagePrepare::Ready;
        }
        std::thread::sleep(Duration::from_millis(150));
    }
    PagePrepare::Failed("Grok 页面加载超时，下载没有启动。".into())
}

#[tauri::command]
pub(crate) async fn start_download(
    args: StartDownloadArgs,
    caller: Webview,
    app: AppHandle,
    viewer_state: State<'_, ViewerState>,
    download_state: State<'_, crate::download::DownloadState>,
) -> Result<DownloadResponse, String> {
    require_gallery_caller(&caller, &viewer_state)?;
    let backend_session = viewer_state.backend_session.clone();
    let grok = app
        .get_webview(GROK_LABEL)
        .ok_or_else(|| "Grok webview is unavailable".to_string())?;
    let state = download_state.inner().clone();
    let prepare_cancel = Arc::clone(&viewer_state.grok_prepare_cancel);
    prepare_cancel.store(false, Ordering::Release);
    let prepared = {
        let grok = grok.clone();
        let prepare_cancel = Arc::clone(&prepare_cancel);
        tauri::async_runtime::spawn_blocking(move || prepare_grok_page(&grok, &prepare_cancel))
            .await
            .unwrap_or_else(|_| PagePrepare::Failed("Grok 页面准备异常退出。".into()))
    };
    match prepared {
        PagePrepare::Ready => {}
        PagePrepare::Stopped => return Ok(DownloadResponse::stopped()),
        PagePrepare::Failed(error) => {
            return Ok(DownloadResponse::coded(
                crate::download::PROBE_PAGE_NOT_READY,
                error,
            ))
        }
    }
    let (reservation, popup_label) = {
        let _session_guard = viewer_state
            .auth_session_gate
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let reservation = match state.reserve() {
            Ok(reservation) => reservation,
            Err(error) => return Ok(DownloadResponse::failure(error)),
        };
        let popup_label =
            match request_destroy_active_auth_popup(&app, &viewer_state.active_auth_popup) {
                Ok(label) => label,
                Err(error) => return Ok(DownloadResponse::failure(error)),
            };
        (reservation, popup_label)
    };
    if let Some(label) = popup_label {
        let active_popup = Arc::clone(&viewer_state.active_auth_popup);
        let destroyed = tauri::async_runtime::spawn_blocking(move || {
            wait_for_auth_popup_destroyed(&active_popup, &label, AUTH_POPUP_DESTROY_TIMEOUT)
        })
        .await
        .unwrap_or(false);
        if reservation.is_cancelled() {
            return Ok(DownloadResponse::stopped());
        }
        if !destroyed {
            return Ok(DownloadResponse::failure(
                "登录窗口没有及时关闭，下载没有启动。",
            ));
        }
    }
    let retry = match (args.retry_of, args.retry_asset_ids.is_empty()) {
        (None, true) => None,
        (Some(history_id), false) if !history_id.trim().is_empty() && args.retry_asset_ids.len() <= 200 => {
            let mut unique = std::collections::HashSet::new();
            if args.retry_asset_ids.iter().any(|id| id.is_empty() || id.len() > 200 || !unique.insert(id.clone())) {
                return Err("重试素材列表无效或包含重复项目。".into());
            }
            Some(crate::download::DownloadRetry { history_id, asset_ids: args.retry_asset_ids })
        }
        _ => return Err("重试记录与素材列表必须同时提供。".into()),
    };
    let requested_root = args.root;

    let response = tauri::async_runtime::spawn_blocking(move || {
        run_download(
            requested_root,
            backend_session,
            grok,
            caller,
            state,
            reservation,
            retry,
        )
    })
    .await
    .unwrap_or_else(|_| DownloadResponse::failure("下载任务异常退出。"));
    Ok(response)
}

#[tauri::command]
pub(crate) async fn stop_download(
    caller: Webview,
    app: AppHandle,
    viewer_state: State<'_, ViewerState>,
    download_state: State<'_, crate::download::DownloadState>,
) -> Result<crate::download::StopDownloadResponse, String> {
    require_gallery_caller(&caller, &viewer_state)?;
    let grok = app
        .get_webview(GROK_LABEL)
        .ok_or_else(|| "Grok webview is unavailable".to_string())?;
    // Stop also has to reach a download that is still waiting for the Grok
    // document, before any reservation exists.
    viewer_state
        .grok_prepare_cancel
        .store(true, Ordering::Release);
    let state = download_state.inner().clone();
    let response = tauri::async_runtime::spawn_blocking(move || state.stop(&grok))
        .await
        .unwrap_or(crate::download::StopDownloadResponse {
            ok: false,
            stopped: false,
            published: false,
            persistence: Box::default(),
        });
    Ok(response)
}
#[tauri::command]
pub(crate) fn open_grok_media(
    url: String, caller: Webview, app: AppHandle, state: State<'_, ViewerState>,
) -> Result<ModeResponse, String> {
    require_gallery_caller(&caller, &state)?;
    let _guard = state.auth_session_gate.lock().unwrap_or_else(|e| e.into_inner());
    require_download_idle(&app)?;
    let url = crate::desktop::trusted_post_url(&url)
        .ok_or_else(|| "没有可验证的 Grok 作品链接。".to_string())?;
    let grok = app.get_webview(GROK_LABEL).ok_or_else(|| "Grok 页面不可用。".to_string())?;
    grok.navigate(url).map_err(|e| e.to_string())?;
    Ok(apply_mode(&app, &state, "grok", false))
}

#[tauri::command]
pub(crate) fn resize_for_media(
    args: crate::desktop::MediaSize, caller: Webview, app: AppHandle, state: State<'_, ViewerState>,
) -> Result<(), String> {
    require_gallery_caller(&caller, &state)?;
    let window = app.get_window(WINDOW_LABEL).ok_or_else(|| "主窗口不可用。".to_string())?;
    crate::desktop::resize_media(&window, &args)
}

#[tauri::command]
pub(crate) fn toggle_window_fullscreen(
    caller: Webview, app: AppHandle, state: State<'_, ViewerState>,
) -> Result<bool, String> {
    require_gallery_caller(&caller, &state)?;
    let window = app.get_window(WINDOW_LABEL).ok_or_else(|| "主窗口不可用。".to_string())?;
    let next = !window.is_fullscreen().map_err(|e| e.to_string())?;
    window.set_fullscreen(next).map_err(|e| e.to_string())?;
    Ok(next)
}

#[tauri::command]
pub(crate) async fn set_grok_muted(
    muted: bool, caller: Webview, app: AppHandle, state: State<'_, ViewerState>,
) -> Result<(), String> {
    require_gallery_caller(&caller, &state)?;
    let grok = app.get_webview(GROK_LABEL).ok_or_else(|| "Grok 页面不可用。".to_string())?;
    tauri::async_runtime::spawn_blocking(move || crate::desktop::set_muted(grok, muted))
        .await.map_err(|_| "Grok 静音操作未完成。".to_string())?
}

fn require_library_change_idle(app: &AppHandle) -> Result<(), String> {
    if app
        .try_state::<crate::download::DownloadState>()
        .is_some_and(|state| state.is_busy())
    {
        return Err("请先停止下载，再切换或新建图库。".into());
    }
    Ok(())
}

#[cfg(windows)]
type FolderDialogOwner = windows::Win32::Foundation::HWND;
#[cfg(not(windows))]
type FolderDialogOwner = ();

fn folder_dialog_owner(window: &Window) -> Result<FolderDialogOwner, String> {
    #[cfg(windows)]
    {
        window.hwnd().map_err(|error| error.to_string())
    }
    #[cfg(not(windows))]
    {
        let _ = window;
        Ok(())
    }
}

fn run_gallery_folder_dialog<F>(app: &AppHandle, picker: F) -> Result<Option<String>, String>
where
    F: FnOnce(FolderDialogOwner) -> Result<Option<PathBuf>, String> + Send + 'static,
{
    let app_for_ui = app.clone();
    let (sender, receiver) = std::sync::mpsc::sync_channel(1);
    app.run_on_main_thread(move || {
        let result = (|| {
            let window = app_for_ui
                .get_window(WINDOW_LABEL)
                .ok_or_else(|| "主窗口不可用。".to_string())?;
            picker(folder_dialog_owner(&window)?)
        })();
        let _ = sender.send(result);
    })
    .map_err(|error| error.to_string())?;
    match receiver.recv() {
        Ok(Ok(Some(path))) => Ok(Some(path.to_string_lossy().into_owned())),
        Ok(Ok(None)) => Ok(None),
        Ok(Err(error)) => Err(error),
        Err(_) => Err("目录对话框未完成。".into()),
    }
}

#[tauri::command]
pub(crate) fn pick_library(
    caller: Webview,
    app: AppHandle,
    state: State<'_, ViewerState>,
) -> Result<Option<String>, String> {
    require_gallery_caller(&caller, &state)?;
    require_library_change_idle(&app)?;
    run_gallery_folder_dialog(&app, crate::folder_dialog::pick_existing_folder)
}

#[tauri::command]
pub(crate) fn create_library(
    caller: Webview,
    app: AppHandle,
    state: State<'_, ViewerState>,
) -> Result<Option<String>, String> {
    require_gallery_caller(&caller, &state)?;
    require_library_change_idle(&app)?;
    run_gallery_folder_dialog(&app, crate::folder_dialog::pick_new_library_path)
}

#[tauri::command]
pub(crate) fn get_playback_acceleration(
    caller: Webview, state: State<'_, ViewerState>,
    acceleration: State<'_, crate::runtime_accel::PlaybackAccelerationState>,
) -> Result<crate::runtime_accel::PlaybackAccelerationStatus, String> {
    require_gallery_caller(&caller, &state)?;
    Ok(acceleration.status())
}

#[tauri::command]
pub(crate) fn set_playback_acceleration(
    mode: crate::runtime_accel::PlaybackMode, caller: Webview, state: State<'_, ViewerState>,
    acceleration: State<'_, crate::runtime_accel::PlaybackAccelerationState>,
) -> Result<crate::runtime_accel::PlaybackAccelerationStatus, String> {
    require_gallery_caller(&caller, &state)?;
    acceleration.set(mode)
}

pub(crate) fn focus_main_window(app: &AppHandle) {
    if let Some(window) = app.get_window(WINDOW_LABEL) {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

#[tauri::command]
pub(crate) async fn get_environment_status(
    caller: Webview,
    state: State<'_, ViewerState>,
    environment: State<'_, crate::environment::EnvironmentState>,
) -> Result<crate::environment::EnvironmentStatus, String> {
    require_gallery_caller(&caller, &state)?;
    let environment = environment.inner().clone();
    tauri::async_runtime::spawn_blocking(move || environment.status()).await
        .map_err(|_| "environment-check-failed".into())
}

#[tauri::command]
pub(crate) fn install_environment_component(
    component: crate::environment::Component,
    caller: Webview,
    state: State<'_, ViewerState>,
    environment: State<'_, crate::environment::EnvironmentState>,
) -> Result<crate::environment::InstallStatus, String> {
    require_gallery_caller(&caller, &state)?;
    environment.install(component)
}

pub(crate) fn setup(
    app: &mut tauri::App,
    backend_session: crate::backend::BackendSession,
) -> Result<(), Box<dyn Error>> {
    let allowed_origin = backend_session.url().clone();
    let gallery_cookie = backend_session.gallery_cookie()?;
    let navigation_origin = allowed_origin.clone();
    let navigation_session = backend_session.clone();
    let gallery_origin = exact_gallery_origin(&allowed_origin)?;
    app.add_capability(
        CapabilityBuilder::new("gallery-runtime")
            .local(false)
            .remote(gallery_origin.clone())
            .webview(GALLERY_LABEL)
            .permission("allow-set-viewer-mode")
            .permission("allow-report-chrome-height")
            .permission("allow-reopen-grok")
            .permission("allow-start-download")
            .permission("allow-stop-download")
            .permission("allow-open-grok-media")
            .permission("allow-resize-for-media")
            .permission("allow-toggle-window-fullscreen")
            .permission("allow-set-grok-muted")
            .permission("allow-pick-library")
            .permission("allow-create-library")
            .permission("allow-get-playback-acceleration")
            .permission("allow-set-playback-acceleration")
            .permission("allow-get-environment-status")
            .permission("allow-install-environment-component"),
    )?;

    let chrome_height = Arc::new(Mutex::new(DEFAULT_CHROME_HEIGHT));
    let grok_visible = Arc::new(AtomicBool::new(false));
    let active_auth_popup = Arc::new(AuthPopupState::default());
    let auth_session_gate = Arc::new(Mutex::new(()));
    app.manage(ViewerState {
        gallery_origin: allowed_origin.clone(),
        backend_session,
        chrome_height: Arc::clone(&chrome_height),
        grok_visible: Arc::clone(&grok_visible),
        active_auth_popup: Arc::clone(&active_auth_popup),
        auth_session_gate: Arc::clone(&auth_session_gate),
        grok_prepare_cancel: Arc::new(AtomicBool::new(false)),
    });

    let window = WindowBuilder::new(app, WINDOW_LABEL)
        .title("Grok Imagine Viewer")
        .inner_size(1280.0, 820.0)
        .min_inner_size(320.0, 240.0)
        .decorations(true)
        .resizable(true)
        .background_color(WINDOW_BACKGROUND)
        .center()
        .visible(false)
        .build()?;

    crate::desktop::initialize_window(app.handle(), &window)?;
    let initial_size = window.inner_size()?;
    let blank_url = Url::parse("about:blank")?;
    let config_dir = if let Some(fixture) = crate::local_fixture::current() { fixture.config.clone() } else { app.path().app_config_dir()? };
    let acceleration = crate::runtime_accel::PlaybackAccelerationState::load(&config_dir);
    // A gallery-only environment isolates software/CPU policy from Grok and
    // its authenticated popup environment. Both isolated WebViews are
    // portable runtime state; the gallery's own `.viewer-cache` is separate.
    let gallery_data_dir = webview_data_dir(app.handle(), WEBVIEW_DATA_DIRS[0])?;
    std::fs::create_dir_all(&gallery_data_dir)?;
    let gallery_builder = WebviewBuilder::new(GALLERY_LABEL, WebviewUrl::External(blank_url))
        .background_color(WINDOW_BACKGROUND)
        .data_directory(gallery_data_dir);
    #[cfg(windows)]
    let gallery_builder = if let Some(arguments) = acceleration.effective().browser_args() {
        gallery_builder.additional_browser_args(&arguments)
    } else { gallery_builder };
    app.manage(acceleration);
    let gallery = window.add_child(
        gallery_builder
            .initialization_script(gallery_bridge_script(&gallery_origin))
            .on_navigation(move |candidate| {
                candidate.as_str() == "about:blank"
                    || (crate::backend::same_origin(&navigation_origin, candidate)
                        && navigation_session.verify_identity())
            })
            .on_new_window(|_, _| NewWindowResponse::Deny),
        PhysicalPosition::<i32>::new(0, 0),
        initial_size,
    )?;
    gallery.set_cookie(gallery_cookie.clone())?;
    if let Err(error) = gallery.navigate(allowed_origin.clone()) {
        let _ = gallery.delete_cookie(gallery_cookie.clone());
        return Err(Box::new(error));
    }

    let grok_data_dir = webview_data_dir(app.handle(), WEBVIEW_DATA_DIRS[1])?;
    std::fs::create_dir_all(&grok_data_dir)?;
    let auth_popup_app = app.handle().clone();
    let auth_popup_state = Arc::clone(&active_auth_popup);
    let auth_popup_gate = Arc::clone(&auth_session_gate);
    // Create the isolated WebView during setup, but avoid remote traffic and
    // page CPU work until the user explicitly switches to Grok mode.
    let grok_url = Url::parse("about:blank")?;
    let grok_navigation_download_state = app
        .state::<crate::download::DownloadState>()
        .inner()
        .clone();
    let download_capture = app.state::<crate::download::DownloadState>().capture();
    let native_download_guard = download_capture.clone();
    let grok_permission_state = grok_navigation_download_state.clone();
    let grok = window.add_child(
        WebviewBuilder::new(GROK_LABEL, WebviewUrl::External(grok_url))
            .background_color(WINDOW_BACKGROUND)
            .initialization_script(crate::download::grok_primordials_initialization_script())
            .data_directory(grok_data_dir)
            .devtools(false)
            .on_navigation(move |candidate| {
                let allowed = traced_grok_navigation("navigation", candidate);
                if allowed {
                    grok_navigation_download_state.navigation_started();
                }
                allowed
            })
            .on_new_window(move |url, features| {
                managed_grok_popup(
                    &auth_popup_app,
                    &auth_popup_state,
                    &auth_popup_gate,
                    url,
                    features,
                )
            })
            .on_page_load(|_, payload| {
                let event = match payload.event() {
                    PageLoadEvent::Started => "load-start",
                    PageLoadEvent::Finished => "load-finish",
                };
                trace_auth_event(event, payload.url(), None);
            })
            .on_download(move |_, event| download_capture.handle(event)),
        PhysicalPosition::<i32>::new(0, 0),
        initial_size,
    )?;
    native_download_guard.install_native_guard(&grok, &grok_permission_state)?;

    let scale_factor = window.scale_factor()?;
    let current_scale = Arc::new(Mutex::new(scale_factor));
    layout_children(
        &gallery,
        &grok,
        initial_size,
        scale_factor,
        DEFAULT_CHROME_HEIGHT,
        true,
    )?;
    grok.hide()?;
    gallery.show()?;
    gallery.set_focus()?;

    let resized_gallery = gallery.clone();
    let resized_grok = grok.clone();
    let resized_height = Arc::clone(&chrome_height);
    let resized_scale = Arc::clone(&current_scale);
    let resized_grok_visible = Arc::clone(&grok_visible);
    let close_popup_app = app.handle().clone();
    let close_popup_state = Arc::clone(&active_auth_popup);
    let close_download_state = app
        .state::<crate::download::DownloadState>()
        .inner()
        .clone();
    let close_grok = grok.clone();
    let close_gallery = gallery.clone();
    let close_gallery_cookie = gallery_cookie.clone();
    let close_window = window.clone();
    let close_lifecycle = Arc::new(CloseLifecycle::default());
    window.on_window_event(move |event| {
        let height = *resized_height
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let close_popup = || {
            let label = close_popup_state
                .active
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .clone();
            if let Some(label) = label {
                if let Some(popup) = close_popup_app.get_webview_window(&label) {
                    let _ = popup.close();
                } else {
                    let mut active = close_popup_state
                        .active
                        .lock()
                        .unwrap_or_else(|poisoned| poisoned.into_inner());
                    if active.as_deref() == Some(label.as_str()) {
                        *active = None;
                        drop(active);
                        close_popup_state.changed.notify_all();
                    }
                }
            }
        };
        match event {
            WindowEvent::Resized(size) => {
                let scale = *resized_scale
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                let _ = layout_children(
                    &resized_gallery,
                    &resized_grok,
                    *size,
                    scale,
                    height,
                    resized_grok_visible.load(Ordering::Acquire),
                );
            }
            WindowEvent::ScaleFactorChanged {
                scale_factor,
                new_inner_size,
                ..
            } => {
                *resized_scale
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner()) = *scale_factor;
                let _ = layout_children(
                    &resized_gallery,
                    &resized_grok,
                    *new_inner_size,
                    *scale_factor,
                    height,
                    resized_grok_visible.load(Ordering::Acquire),
                );
            }
            WindowEvent::CloseRequested { api, .. } => {
                close_popup();
                match close_lifecycle.request() {
                    CloseRequest::Allow => {}
                    CloseRequest::BeginShutdown => {
                        api.prevent_close();
                        let _ = close_gallery.delete_cookie(close_gallery_cookie.clone());
                        let lifecycle = Arc::clone(&close_lifecycle);
                        let download_state = close_download_state.clone();
                        let grok = close_grok.clone();
                        let window = close_window.clone();
                        tauri::async_runtime::spawn(async move {
                            let _ = tauri::async_runtime::spawn_blocking(move || {
                                download_state.stop(&grok)
                            })
                            .await;
                            lifecycle.finish();
                            let _ = window.close();
                        });
                    }
                    CloseRequest::Wait => api.prevent_close(),
                }
            }
            WindowEvent::Destroyed => close_popup(),
            _ => {}
        }
    });
    window.show()?;
    window.set_focus()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn auth_popup_destroy_wait_requires_the_matching_destroyed_signal() {
        let popup = AuthPopupState::default();
        assert!(wait_for_auth_popup_destroyed(
            &popup,
            "grok-auth-test",
            Duration::ZERO
        ));

        *popup
            .active
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some("grok-auth-test".into());
        assert!(!wait_for_auth_popup_destroyed(
            &popup,
            "grok-auth-test",
            Duration::ZERO
        ));
    }

    #[test]
    fn close_lifecycle_stops_once_then_allows_the_second_close() {
        let lifecycle = CloseLifecycle::default();
        assert_eq!(lifecycle.request(), CloseRequest::BeginShutdown);
        assert_eq!(lifecycle.request(), CloseRequest::Wait);
        lifecycle.finish();
        assert_eq!(lifecycle.request(), CloseRequest::Allow);
    }
    #[test]
    fn gallery_origin_requires_exact_loopback_http_port() {
        let good = Url::parse("http://127.0.0.1:19706/path").unwrap();
        assert_eq!(
            exact_gallery_origin(&good).unwrap(),
            "http://127.0.0.1:19706"
        );
        for bad in [
            "http://127.0.0.1/path",
            "http://localhost:19706/",
            "https://127.0.0.1:19706/",
            "http://user@127.0.0.1:19706/",
        ] {
            assert!(exact_gallery_origin(&Url::parse(bad).unwrap()).is_err());
        }
    }

    #[test]
    fn chrome_height_is_finite_rounded_and_clamped() {
        assert_eq!(normalized_chrome_height(-5.0), Some(0.0));
        assert_eq!(normalized_chrome_height(63.6), Some(64.0));
        assert_eq!(normalized_chrome_height(999.0), Some(400.0));
        assert_eq!(normalized_chrome_height(f64::NAN), None);
    }

    #[test]
    fn physical_top_respects_scale_and_window_height() {
        assert_eq!(physical_top(64.0, 1.5, 820), 96);
        assert_eq!(physical_top(400.0, 2.0, 600), 600);
    }

    #[test]
    fn grok_navigation_is_normalized_https_and_allowlisted() {
        for allowed in [
            "about:blank",
            "HTTPS://GrOk.CoM:443/imagine",
            "https://accounts.x.ai/login",
            "https://x.com/i/flow/login",
            "https://mobile.twitter.com/login",
            "https://accounts.google.com:443/o/oauth2/v2/auth",
            "https://appleid.apple.com/auth/authorize",
        ] {
            let url = Url::parse(allowed).unwrap();
            assert!(
                is_allowed_grok_navigation(&url),
                "{allowed} normalized as {url}"
            );
        }
        for denied in [
            "about:blank#fragment",
            "about:blank?query",
            "http://grok.com/imagine",
            "https://grok.com:444/imagine",
            "https://grok.com./imagine",
            "https://accounts.google.com./o/oauth2/v2/auth",
            "https://user@grok.com/imagine",
            "https://user:password@accounts.google.com/",
            "https://grok.com.evil.example/",
            "https://evil.grok.com.example/",
            "https://example.com/",
            "https://xn--grok-7za.com/",
            "https://grok.com.xn--e1awd7f.com/",
            "file:///C:/Windows/System32/",
        ] {
            let url = Url::parse(denied).unwrap();
            assert!(
                !is_allowed_grok_navigation(&url),
                "{denied} normalized as {url}"
            );
        }
    }

    #[test]
    fn auth_trace_target_omits_url_secrets() {
        let url = Url::parse(
            "https://user:password@unknown.example/private/email?code=secret&state=hidden#token",
        )
        .unwrap();
        let target = auth_trace_target(&url);
        assert_eq!(target, "scheme=https host=unknown.example");
        for secret in [
            "user", "password", "private", "email", "code", "secret", "state", "hidden", "token",
        ] {
            assert!(!target.contains(secret));
        }
    }
    #[test]
    fn managed_popup_uses_opener_window_features() {
        let source = include_str!("shell.rs");
        let builder = source
            .find("WebviewWindowBuilder::new(app, &label")
            .unwrap();
        let features = source[builder..]
            .find(".window_features(features)")
            .unwrap();
        let finished = source[builder..].find(".build()").unwrap();
        assert!(features < finished);
    }

    #[test]
    fn grok_mode_commands_require_download_idle() {
        let source = include_str!("shell.rs");
        let set_mode = source.find("pub(crate) fn set_viewer_mode").unwrap();
        let reopen = source.find("pub(crate) fn reopen_grok").unwrap();
        assert!(source[set_mode..reopen].contains("require_download_idle"));
        assert!(source[reopen..].contains("require_download_idle"));
    }

    #[test]
    fn gallery_bridge_exposes_download_commands_and_status_events() {
        let bridge = gallery_bridge_script("http://127.0.0.1:19706");
        for expected in [
            "startDownload",
            "stopDownload",
            "onDownloadStatus",
            "giv-download-status",
            "pickLibrary",
            "createLibrary",
            "pick_library",
            "create_library",
            "getPlaybackAcceleration",
            "setPlaybackAcceleration",
            "get_playback_acceleration",
            "set_playback_acceleration",
        ] {
            assert!(bridge.contains(expected));
        }
    }

    #[test]
    fn gallery_bridge_declares_the_shell_identity() {
        let bridge = gallery_bridge_script("http://127.0.0.1:19706");
        assert!(bridge.contains(r#"shell: "tauri""#));
        assert!(bridge.contains(&format!("bridgeVersion: {GALLERY_BRIDGE_VERSION}")));
        assert!(bridge.contains(&format!(
            "shellVersion: {}",
            serde_json::to_string(env!("CARGO_PKG_VERSION")).unwrap()
        )));
        for capability in [
            "setMode",
            "reopenGrok",
            "reportChrome",
            "startDownload",
            "stopDownload",
            "pickLibrary",
            "createLibrary",
        ] {
            assert!(
                bridge.contains(&format!("\"{capability}\"")),
                "capability {capability} must be declared"
            );
        }
    }

    #[test]
    fn download_status_is_json_escaped() {
        let text = "\";window.injected=true;//\nnext";
        let script = download_status_script(text);
        assert!(script.contains("\\\";window.injected=true;//\\nnext"));
        assert!(!script.contains("detail:\";window.injected"));
    }

    #[test]
    fn playback_policy_is_gallery_only_and_caller_checked() {
        // Windows clones may check this source out with CRLF while include_str!
        // preserves those bytes. Normalize before locating Rust item boundaries.
        let normalized = include_str!("shell.rs").replace("\r\n", "\n");
        let source = normalized.as_str();
        for command in ["get_playback_acceleration", "set_playback_acceleration"] {
            let start = source.find(&format!("pub(crate) fn {command}(")).unwrap();
            let body = &source[start..source[start..].find("\n}\n").map(|i| start + i).unwrap()];
            assert!(body.contains("require_gallery_caller(&caller, &state)?;"));
            assert!(include_str!("../build.rs").contains(&format!("\"{command}\"")));
            assert!(include_str!("main.rs").contains(&format!("shell::{command}")));
        }
        let setup = &source[source.find("pub(crate) fn setup(").unwrap()..];
        let grok = setup.find("let grok = window.add_child(").unwrap();
        assert!(setup[..grok].contains(".additional_browser_args(&arguments)"));
        assert!(!setup[grok..setup[grok..].find("native_download_guard.install").unwrap() + grok].contains("additional_browser_args"));
        assert!(setup.contains("webview_data_dir(app.handle(), WEBVIEW_DATA_DIRS[0])"));
        assert!(setup.contains("webview_data_dir(app.handle(), WEBVIEW_DATA_DIRS[1])"));
        assert!(source.contains("current_exe()"));
        assert!(source.contains("migrate_webview_dir"));
    }

    #[test]
    fn environment_commands_are_gallery_only_and_fixed() {
        let source = include_str!("shell.rs").replace("\r\n", "\n");
        for command in ["get_environment_status", "install_environment_component"] {
            let signature = if command == "get_environment_status" { "async fn" } else { "fn" };
            let start = source.find(&format!("pub(crate) {signature} {command}(")).unwrap();
            let body = &source[start..source[start..].find("\n}\n").map(|i| start + i).unwrap()];
            assert!(body.contains("require_gallery_caller(&caller, &state)?;"));
            assert!(include_str!("../build.rs").contains(&format!("\"{command}\"")));
            assert!(include_str!("main.rs").contains(&format!("shell::{command}")));
            assert!(source.contains(&format!(".permission(\"allow-{}\")", command.replace('_', "-"))));
        }
        assert!(gallery_bridge_script("http://127.0.0.1:19706").contains("installEnvironmentComponent"));
    }

    #[test]
    fn gallery_root_must_match_the_authoritative_directory() {
        let configured = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        let requested = configured.to_string_lossy();
        assert!(validated_gallery_root(&requested, Some(configured.clone())).is_ok());

        let parent = configured.parent().unwrap().to_path_buf();
        assert!(validated_gallery_root(&parent.to_string_lossy(), Some(configured)).is_err());
    }

    #[cfg(windows)]
    #[test]
    fn windows_reparse_attribute_is_detected() {
        assert!(windows_attributes_are_reparse_point(0x0000_0400));
        assert!(windows_attributes_are_reparse_point(0x0000_0410));
        assert!(!windows_attributes_are_reparse_point(0x0000_0010));
    }

    #[cfg(unix)]
    #[test]
    fn gallery_root_rejects_symlink_identity_before_canonicalization() {
        use std::os::unix::fs::symlink;
        use std::time::{SystemTime, UNIX_EPOCH};

        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let fixture = std::env::temp_dir().join(format!(
            "grok-imagine-viewer-root-link-{}-{nonce}",
            std::process::id()
        ));
        let target = fixture.join("target");
        let link = fixture.join("linked-root");
        std::fs::create_dir_all(&target).unwrap();
        symlink(&target, &link).unwrap();

        let requested_link = validated_gallery_root(&link.to_string_lossy(), Some(target.clone()));
        let configured_link = validated_gallery_root(&target.to_string_lossy(), Some(link.clone()));

        std::fs::remove_file(&link).unwrap();
        std::fs::remove_dir_all(&fixture).unwrap();

        assert_eq!(
            requested_link.unwrap_err(),
            "图库根目录不能是符号链接或重解析点。"
        );
        assert_eq!(
            configured_link.unwrap_err(),
            "图库根目录不能是符号链接或重解析点。"
        );
    }
}
