//! Local-gallery WebView2 policy. This never reads a browser profile or accepts
//! arbitrary Chromium arguments. Grok keeps its separate, unchanged environment.
use serde::{Deserialize, Serialize};
use std::{fs, io::{self, Read, Write}, path::{Path, PathBuf}, sync::Mutex};

const CONFIG_NAME: &str = "runtime-accel.json";
const MAX_CONFIG_BYTES: u64 = 4096;
// Supplying additional_browser_args replaces wry 0.55.1 defaults, so preserve
// its mini-menu behavior and autoplay policy for the local gallery only.
const WRY_DEFAULT_ARGS: &str = "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection --autoplay-policy=no-user-gesture-required";

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum PlaybackMode {
    #[default]
    Auto,
    Gpu,
    Cpu,
    Compat,
}

impl PlaybackMode {
    pub(crate) fn browser_args(self) -> Option<String> {
        // These are Chromium switches used by WebView2, not decoder guarantees.
        // Keep driver blocklists and the browser's codec fallback intact.
        let flags = match self {
            Self::Auto => return None,
            Self::Gpu => "--force_high_performance_gpu",
            Self::Cpu => "--disable-accelerated-video-decode",
            Self::Compat => "--disable-gpu --disable-accelerated-video-decode",
        };
        Some(format!("{WRY_DEFAULT_ARGS} {flags}"))
    }
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Config {
    version: u8,
    mode: PlaybackMode,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PlaybackAccelerationStatus {
    supported: bool,
    scope: &'static str,
    engine: &'static str,
    requested: PlaybackMode,
    // The policy passed at startup, NOT observation of the active decoder.
    effective: PlaybackMode,
    restart_required: bool,
    warning: Option<String>,
}

struct Selection {
    requested: PlaybackMode,
    warning: Option<String>,
}

pub(crate) struct PlaybackAccelerationState {
    path: PathBuf,
    effective: PlaybackMode,
    selection: Mutex<Selection>,
    external_override: bool,
}

impl PlaybackAccelerationState {
    pub(crate) fn load(config_dir: &Path) -> Self {
        let path = config_dir.join(CONFIG_NAME);
        let (mode, warning) = match read_config(&path) {
            Ok(mode) => (mode, None),
            Err(_) => (PlaybackMode::Auto, Some("播放加速配置无法识别，已按自动模式启动；原配置未改动。".into())),
        };
        Self {
            path,
            effective: if cfg!(windows) { mode } else { PlaybackMode::Auto },
            selection: Mutex::new(Selection { requested: mode, warning }),
            // Do not expose contents: externally set arguments can override
            // app options. Registry/enterprise policy can also override them.
            external_override: std::env::var_os("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS").is_some(),
        }
    }

    pub(crate) fn effective(&self) -> PlaybackMode { self.effective }

    pub(crate) fn status(&self) -> PlaybackAccelerationStatus {
        let selected = self.selection.lock().unwrap_or_else(|e| e.into_inner());
        self.status_for(&selected)
    }

    fn status_for(&self, selected: &Selection) -> PlaybackAccelerationStatus {
        let warning = if self.external_override {
            Some("检测到外部 WebView2 启动参数，实际解码可能受其覆盖；这里仅显示应用启动策略。".into())
        } else { selected.warning.clone() };
        PlaybackAccelerationStatus {
            supported: cfg!(windows), scope: "gallery",
            engine: if cfg!(windows) { "WebView2" } else { "system" },
            requested: selected.requested, effective: self.effective,
            restart_required: cfg!(windows) && selected.requested != self.effective,
            warning,
        }
    }

    pub(crate) fn set(&self, mode: PlaybackMode) -> Result<PlaybackAccelerationStatus, String> {
        if !cfg!(windows) { return Err("此播放加速设置仅支持 Windows WebView2。".into()); }
        let mut selected = self.selection.lock().unwrap_or_else(|e| e.into_inner());
        // Never silently replace an unknown schema or corrupt config. Only
        // update requested state after a successful atomic publication.
        read_config(&self.path).map_err(|_| "播放加速配置损坏或不可访问，已保留原文件并停止保存。".to_string())?;
        write_config(&self.path, mode).map_err(|_| "播放加速设置未能保存，当前启动策略未改变。".to_string())?;
        selected.requested = mode;
        selected.warning = None;
        Ok(self.status_for(&selected))
    }
}

fn is_link(info: &fs::Metadata) -> bool {
    #[cfg(windows)]
    { use std::os::windows::fs::MetadataExt; info.file_attributes() & 0x400 != 0 }
    #[cfg(not(windows))]
    { info.file_type().is_symlink() }
}

fn invalid() -> io::Error { io::Error::new(io::ErrorKind::InvalidData, "invalid playback config") }

fn read_config(path: &Path) -> io::Result<PlaybackMode> {
    let info = match fs::symlink_metadata(path) {
        Ok(info) => info,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(PlaybackMode::Auto),
        Err(error) => return Err(error),
    };
    if !info.is_file() || is_link(&info) || info.len() > MAX_CONFIG_BYTES { return Err(invalid()); }
    let mut bytes = Vec::new();
    fs::File::open(path)?.take(MAX_CONFIG_BYTES + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > MAX_CONFIG_BYTES { return Err(invalid()); }
    let config: Config = serde_json::from_slice(&bytes).map_err(|_| invalid())?;
    if config.version != 1 { return Err(invalid()); }
    Ok(config.mode)
}

fn write_config(path: &Path, mode: PlaybackMode) -> io::Result<()> {
    let parent = path.parent().ok_or_else(invalid)?;
    let info = fs::symlink_metadata(parent)?;
    if !info.is_dir() || is_link(&info) { return Err(invalid()); }
    let mut random = [0u8; 16];
    getrandom::fill(&mut random).map_err(|_| invalid())?;
    let token: String = random.iter().map(|byte| format!("{byte:02x}")).collect();
    let temporary = parent.join(format!(".runtime-accel-{token}.tmp"));
    let mut file = fs::OpenOptions::new().write(true).create_new(true).open(&temporary)?;
    let result = (|| {
        let bytes = serde_json::to_vec(&Config { version: 1, mode }).map_err(|_| invalid())?;
        file.write_all(&bytes)?;
        file.sync_all()?;
        drop(file);
        // Revalidate the destination immediately before replacing. No unlink
        // first: a failed rename leaves the previous settings recoverable.
        read_config(path)?;
        replace(&temporary, path)
    })();
    if result.is_err() { let _ = fs::remove_file(&temporary); }
    result
}

#[cfg(windows)]
fn replace(source: &Path, destination: &Path) -> io::Result<()> {
    use windows::{core::HSTRING, Win32::Storage::FileSystem::{MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH}};
    unsafe {
        MoveFileExW(&HSTRING::from(source), &HSTRING::from(destination), MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH)
            .map_err(|_| io::Error::last_os_error())
    }
}

#[cfg(not(windows))]
fn replace(source: &Path, destination: &Path) -> io::Result<()> { fs::rename(source, destination) }

#[cfg(test)]
mod tests {
    use super::*;
    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let mut id = [0u8; 16]; getrandom::fill(&mut id).unwrap();
            let name: String = id.iter().map(|byte| format!("{byte:02x}")).collect();
            let path = std::env::temp_dir().join(format!("giv-playback-test-{name}"));
            fs::create_dir(&path).unwrap(); Self(path)
        }
        fn path(&self) -> PathBuf { self.0.join(CONFIG_NAME) }
    }
    impl Drop for Fixture { fn drop(&mut self) { let _ = fs::remove_dir_all(&self.0); } }

    #[test]
    fn only_fixed_modes_and_safe_flags_are_accepted() {
        for mode in [PlaybackMode::Auto, PlaybackMode::Gpu, PlaybackMode::Cpu, PlaybackMode::Compat] {
            let encoded = serde_json::to_string(&mode).unwrap();
            assert_eq!(serde_json::from_str::<PlaybackMode>(&encoded).unwrap(), mode);
            let flags = mode.browser_args().unwrap_or_default();
            assert!(!flags.contains("ignore-gpu-blocklist"));
            assert!(!flags.contains("remote-debugging"));
            assert!(!flags.contains("no-sandbox"));
        }
        for invalid in ["hardware", "GPU", "auto --remote-debugging-port=9222", "", "custom"] {
            assert!(serde_json::from_value::<PlaybackMode>(serde_json::json!(invalid)).is_err());
        }
        assert!(PlaybackMode::Auto.browser_args().is_none());
        assert!(!PlaybackMode::Cpu.browser_args().unwrap().split_whitespace().any(|x| x == "--disable-gpu"));
        assert!(PlaybackMode::Compat.browser_args().unwrap().split_whitespace().any(|x| x == "--disable-gpu"));
    }

    #[test]
    fn roundtrip_is_versioned_and_preserves_unknown_or_corrupt_data() {
        let fixture = Fixture::new();
        assert_eq!(read_config(&fixture.path()).unwrap(), PlaybackMode::Auto);
        write_config(&fixture.path(), PlaybackMode::Cpu).unwrap();
        assert_eq!(read_config(&fixture.path()).unwrap(), PlaybackMode::Cpu);
        write_config(&fixture.path(), PlaybackMode::Gpu).unwrap();
        assert_eq!(read_config(&fixture.path()).unwrap(), PlaybackMode::Gpu);
        for invalid in [r#"{"version":2,"mode":"cpu"}"#, r#"{"version":1,"mode":"cpu","args":"oops"}"#, "broken", "[]"] {
            fs::write(fixture.path(), invalid).unwrap();
            assert!(read_config(&fixture.path()).is_err());
            assert!(write_config(&fixture.path(), PlaybackMode::Auto).is_err());
            assert_eq!(fs::read_to_string(fixture.path()).unwrap(), invalid);
        }
        assert_eq!(fs::read_dir(&fixture.0).unwrap().count(), 1);
    }

    #[test]
    fn bounded_config_and_non_files_are_rejected() {
        let fixture = Fixture::new();
        fs::write(fixture.path(), vec![b' '; MAX_CONFIG_BYTES as usize + 1]).unwrap();
        assert!(read_config(&fixture.path()).is_err());
        fs::remove_file(fixture.path()).unwrap();
        fs::create_dir(fixture.path()).unwrap();
        assert!(read_config(&fixture.path()).is_err());
    }

    #[cfg(windows)]
    #[test]
    fn saves_are_pending_until_restart_and_errors_do_not_change_state() {
        let fixture = Fixture::new();
        let state = PlaybackAccelerationState::load(&fixture.0);
        let status = state.set(PlaybackMode::Cpu).unwrap();
        assert_eq!(status.effective, PlaybackMode::Auto);
        assert_eq!(status.requested, PlaybackMode::Cpu);
        assert!(status.restart_required);
        let restarted = PlaybackAccelerationState::load(&fixture.0);
        assert_eq!(restarted.status().effective, PlaybackMode::Cpu);
        assert!(!restarted.status().restart_required);
        fs::write(fixture.path(), "corrupt").unwrap();
        assert!(state.set(PlaybackMode::Gpu).is_err());
        assert_eq!(state.status().requested, PlaybackMode::Cpu);
        let corrupt = PlaybackAccelerationState::load(&fixture.0);
        assert_eq!(corrupt.effective(), PlaybackMode::Auto);
        assert!(corrupt.status().warning.is_some());
        assert_eq!(fs::read_to_string(fixture.path()).unwrap(), "corrupt");
    }
}
