#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod backend;
mod desktop;
mod environment;
mod download;
mod folder_dialog;
mod runtime_accel;
mod shell;
mod local_fixture;

use std::sync::{Arc, Mutex};
use tauri::{Manager, RunEvent};

fn show_startup_error(message: &str) {
    if local_fixture::current().is_some() { eprintln!("native smoke startup failed: {message}"); return; }
    #[cfg(windows)]
    {
        use windows::core::HSTRING;
        use windows::Win32::UI::WindowsAndMessaging::{MessageBoxW, MB_ICONERROR, MB_OK};
        let text = HSTRING::from(format!(
            "应用无法启动。\n\n{message}\n\n若提示 Go Sidecar 不可用，请检查应用文件是否完整。"
        ));
        let caption = HSTRING::from("Grok Imagine Viewer");
        unsafe {
            let _ = MessageBoxW(None, &text, &caption, MB_ICONERROR | MB_OK);
        }
    }
    #[cfg(not(windows))]
    {
        eprintln!("grok-imagine-viewer: {message}");
    }
}

fn main() {
    if let Err(error) = local_fixture::initialize() { eprintln!("{error}"); std::process::exit(2); }
    if local_fixture::current().is_some() && environment::webview_version().is_none() {
        eprintln!("native smoke requires an installed WebView2 runtime"); std::process::exit(2);
    }
    if !environment::ensure_webview() { return; }
    let server_slot = Arc::new(Mutex::new(None));
    let setup_slot = Arc::clone(&server_slot);

    let builder = tauri::Builder::default();
    let builder = if local_fixture::current().is_some() { builder } else { builder
        // This must be the first plugin: a second process exits before setup,
        // so it never starts or shares another Go backend.
        .plugin(tauri_plugin_single_instance::init(
            |app, _arguments, _working_directory| shell::focus_main_window(app),
        )) };
    let app = builder
        .manage(download::DownloadState::default())
        .manage(environment::EnvironmentState::default())
        .invoke_handler(tauri::generate_handler![
            shell::set_viewer_mode,
            shell::report_chrome_height,
            shell::reopen_grok,
            shell::start_download,
            shell::stop_download,
            shell::open_grok_media,
            shell::resize_for_media,
            shell::toggle_window_fullscreen,
            shell::set_grok_muted,
            shell::pick_library,
            shell::create_library,
            shell::get_playback_acceleration,
            shell::set_playback_acceleration,
            shell::get_environment_status,
            shell::install_environment_component
        ])
        .setup(move |app| {
            let started = (|| {
                let lease = backend::ServerLease::start(app.handle())?;
                shell::setup(app, lease.session().clone())?;
                let mut slot = setup_slot
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                *slot = Some(lease);
                Ok::<(), Box<dyn std::error::Error>>(())
            })();
            if let Err(error) = &started {
                show_startup_error(&error.to_string());
            }
            started
        })
        .build(tauri::generate_context!())
        .unwrap_or_else(|error| {
            show_startup_error(&error.to_string());
            panic!("failed to initialize the Tauri preview: {error}");
        });

    app.run(move |handle, event| {
        if matches!(event, RunEvent::Exit) {
            handle.state::<download::DownloadState>().request_stop();
            let lease = server_slot
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .take();
            drop(lease);
        }
    });
}
