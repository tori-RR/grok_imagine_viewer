//! Fixed component installers. The gallery command layer checks caller/origin;
//! neither a script path nor a command/package string crosses that boundary.
use serde::{Deserialize, Serialize};
use std::{
    path::{Path, PathBuf},
    process::{Child, Command},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub(crate) enum Component {
    Ffmpeg,
    Webview2,
}

impl Component {
    fn argument(self) -> &'static str {
        match self {
            Self::Ffmpeg => "ffmpeg",
            Self::Webview2 => "webview2",
        }
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct InstallStatus {
    phase: &'static str,
    component: Option<Component>,
    exit_code: Option<i32>,
}

impl Default for InstallStatus {
    fn default() -> Self {
        Self {
            phase: "idle",
            component: None,
            exit_code: None,
        }
    }
}

#[derive(Default)]
struct InstallRecord {
    child: Option<Child>,
    status: InstallStatus,
}

#[derive(Clone, Default)]
pub(crate) struct EnvironmentState {
    record: Arc<Mutex<InstallRecord>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct EnvironmentStatus {
    supported: bool,
    webview2: RuntimeStatus,
    winget: bool,
    install: InstallStatus,
}

#[derive(Serialize)]
struct RuntimeStatus {
    ready: bool,
    version: Option<String>,
}

fn script_for_exe(exe: &Path) -> Option<PathBuf> {
    exe.parent()
        .map(|dir| dir.join("viewer/install-environment.ps1"))
}

fn installer_script() -> Result<PathBuf, String> {
    let script = if cfg!(debug_assertions) {
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .map(|dir| dir.join("scripts/install-environment.ps1"))
    } else {
        std::env::current_exe()
            .ok()
            .as_deref()
            .and_then(script_for_exe)
    }
    .ok_or("environment-installer-unavailable")?;
    let metadata =
        std::fs::symlink_metadata(&script).map_err(|_| "environment-installer-unavailable")?;
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return Err("environment-installer-unavailable".into());
    }
    Ok(script)
}

fn installer_arguments(script: &Path, component: Component) -> Vec<std::ffi::OsString> {
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File"]
        .into_iter()
        .map(Into::into)
        .chain([
            script.as_os_str().to_owned(),
            "-Component".into(),
            component.argument().into(),
        ])
        .collect()
}

fn spawn_installer(script: &Path, component: Component) -> Result<Child, String> {
    if cfg!(feature = "environment-preview") {
        return Err("environment-preview-install-disabled".into());
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // The visible console is intentional: the FFmpeg command may ask the
        // user to accept source/package terms; no hidden interactive prompt.
        let powershell =
            PathBuf::from(std::env::var_os("SystemRoot").ok_or("powershell-unavailable")?)
                .join("System32/WindowsPowerShell/v1.0/powershell.exe");
        Command::new(powershell)
            .args(installer_arguments(script, component))
            .creation_flags(0x0000_0010)
            .spawn()
            .map_err(|_| "environment-installer-unavailable".into())
    }
    #[cfg(not(windows))]
    {
        let _ = (script, component);
        Err("environment-install-unsupported".into())
    }
}

pub(crate) fn webview_version() -> Option<String> {
    #[cfg(windows)]
    unsafe {
        use webview2_com::Microsoft::Web::WebView2::Win32::GetAvailableCoreWebView2BrowserVersionString;
        use windows::core::{PCWSTR, PWSTR};
        use windows::Win32::System::Com::CoTaskMemFree;
        let mut value = PWSTR::null();
        let result = GetAvailableCoreWebView2BrowserVersionString(PCWSTR::null(), &mut value);
        if result.is_err() || value.is_null() {
            return None;
        }
        let version = value.to_string().ok();
        CoTaskMemFree(Some(value.0.cast()));
        version.filter(|text| !text.is_empty())
    }
    #[cfg(not(windows))]
    {
        None
    }
}

fn winget_available() -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let mut command = Command::new("winget.exe");
        command
            .arg("--version")
            .creation_flags(0x0800_0000)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null());
        let Ok(mut child) = command.spawn() else {
            return false;
        };
        let deadline = Instant::now() + Duration::from_secs(3);
        loop {
            match child.try_wait() {
                Ok(Some(status)) => return status.success(),
                Ok(None) if Instant::now() < deadline => {
                    std::thread::sleep(Duration::from_millis(30))
                }
                _ => {
                    let _ = child.kill();
                    let _ = child.wait();
                    return false;
                }
            }
        }
    }
    #[cfg(not(windows))]
    {
        false
    }
}

impl EnvironmentState {
    pub(crate) fn status(&self) -> EnvironmentStatus {
        let mut record = self.record.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(child) = record.child.as_mut() {
            match child.try_wait() {
                Ok(Some(exit)) => {
                    record.status.phase = "finished";
                    record.status.exit_code = exit.code();
                    record.child = None;
                }
                Err(_) => {
                    // Never kill a system installer on a status-query failure.
                    record.status.phase = "unknown";
                }
                Ok(None) => {
                    record.status.phase = "running";
                }
            }
        }
        let install = record.status.clone();
        drop(record);
        let version = webview_version();
        EnvironmentStatus {
            supported: cfg!(windows),
            webview2: RuntimeStatus {
                ready: version.is_some(),
                version,
            },
            winget: winget_available(),
            install,
        }
    }

    pub(crate) fn install(&self, component: Component) -> Result<InstallStatus, String> {
        let mut record = self.record.lock().unwrap_or_else(|e| e.into_inner());
        if record.child.is_some() {
            return Err("environment-install-busy".into());
        }
        let child = spawn_installer(&installer_script()?, component)?;
        record.child = Some(child);
        record.status = InstallStatus {
            phase: "running",
            component: Some(component),
            exit_code: None,
        };
        Ok(record.status.clone())
    }
}

/// A WebView cannot render an in-page missing-WebView warning. Handle that
/// case before Tauri creates its runtime, with an explicit native choice.
pub(crate) fn ensure_webview() -> bool {
    #[cfg(windows)]
    {
        if webview_version().is_some() {
            return true;
        }
        use windows::core::HSTRING;
        use windows::Win32::UI::WindowsAndMessaging::{
            MessageBoxW, IDYES, MB_ICONWARNING, MB_OK, MB_YESNO,
        };
        let zh = unsafe { windows::Win32::Globalization::GetUserDefaultUILanguage() } & 0x03ff == 4;
        let prompt = if zh {
            "缺少 Microsoft Edge WebView2 Runtime，暂时无法显示主界面。\n\n是否打开 PowerShell，通过 winget 安装后继续启动？"
        } else {
            "Microsoft Edge WebView2 Runtime is missing, so the main window cannot open.\n\nOpen PowerShell to install it with WinGet, then continue?"
        };
        let title = HSTRING::from("Grok Imagine Viewer");
        if cfg!(feature = "environment-preview") {
            let message = if zh {
                "此环境模拟版需要已有 WebView2 才能显示预览，不会安装系统组件。"
            } else {
                "This environment preview requires an existing WebView2 runtime. It does not install system components."
            };
            unsafe {
                let _ = MessageBoxW(
                    None,
                    &HSTRING::from(message),
                    &title,
                    MB_OK | MB_ICONWARNING,
                );
            }
            return false;
        }
        if unsafe {
            MessageBoxW(
                None,
                &HSTRING::from(prompt),
                &title,
                MB_YESNO | MB_ICONWARNING,
            )
        } != IDYES
        {
            return false;
        }
        let installed = installer_script()
            .and_then(|script| spawn_installer(&script, Component::Webview2))
            .and_then(|mut child| {
                child
                    .wait()
                    .map_err(|_| "environment-install-failed".into())
            })
            .is_ok_and(|exit| exit.success());
        if installed && webview_version().is_some() {
            return true;
        }
        let failed = if zh {
            "仍未检测到 WebView2。请确认 winget（Microsoft 应用安装程序）可用，并重试安装。\n\nhttps://developer.microsoft.com/microsoft-edge/webview2/"
        } else {
            "WebView2 is still unavailable. Check WinGet (Microsoft App Installer) and retry.\n\nhttps://developer.microsoft.com/microsoft-edge/webview2/"
        };
        unsafe {
            let _ = MessageBoxW(None, &HSTRING::from(failed), &title, MB_OK | MB_ICONWARNING);
        }
        false
    }
    #[cfg(not(windows))]
    {
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(feature = "environment-preview")]
    #[test]
    fn preview_binary_cannot_start_a_real_installer() {
        for component in [Component::Ffmpeg, Component::Webview2] {
            assert!(
                matches!(spawn_installer(Path::new("never-run.ps1"), component), Err(message) if message == "environment-preview-install-disabled")
            );
        }
    }
    #[test]
    fn installer_accepts_only_fixed_components_and_keeps_path_as_one_argument() {
        assert!(serde_json::from_str::<Component>("\"ffmpeg; calc\"").is_err());
        let script = Path::new("C:/portable app/viewer/install-environment.ps1");
        let args = installer_arguments(script, Component::Ffmpeg);
        assert_eq!(args[4], script.as_os_str());
        assert_eq!(args[6], "ffmpeg");
        assert!(!args.iter().any(|arg| arg == "-Command"));
        assert_eq!(
            script_for_exe(Path::new("C:/portable app/viewer.exe")).unwrap(),
            script
        );
    }
    #[test]
    fn scripts_have_the_requested_package_commands_and_no_arbitrary_evaluation() {
        let script = include_str!("../../scripts/install-environment.ps1");
        assert!(script.contains("@('install', '-e', '--id', 'Gyan.FFmpeg')"));
        assert!(script.contains("'Microsoft.EdgeWebView2Runtime', '--silent', '--accept-package-agreements', '--accept-source-agreements'"));
        assert!(script.contains("ValidateSet('ffmpeg', 'webview2')"));
        assert!(!script.contains("Invoke-Expression"));
    }

    #[cfg(windows)]
    #[test]
    fn status_reaps_owned_child_and_busy_guard_never_starts_an_installer() {
        use std::os::windows::process::CommandExt;
        // A harmless, already-finished fixture process; never run the PS1.
        let mut child = Command::new(
            PathBuf::from(std::env::var_os("SystemRoot").unwrap())
                .join("System32/WindowsPowerShell/v1.0/powershell.exe"),
        )
        .args(["-NoProfile", "-NonInteractive", "-Command", "exit 7"])
        .creation_flags(0x0800_0000)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .unwrap();
        child.wait().unwrap();
        let state = EnvironmentState::default();
        {
            let mut record = state.record.lock().unwrap();
            record.child = Some(child);
            record.status = InstallStatus {
                phase: "running",
                component: Some(Component::Ffmpeg),
                exit_code: None,
            };
        }
        assert!(
            matches!(state.install(Component::Ffmpeg), Err(message) if message == "environment-install-busy")
        );
        let snapshot = state.status();
        assert_eq!(snapshot.install.phase, "finished");
        assert_eq!(snapshot.install.exit_code, Some(7));
        assert!(state.record.lock().unwrap().child.is_none());
        println!(
            "read-only native environment snapshot: {}",
            serde_json::to_string(&snapshot).unwrap()
        );
    }
}
