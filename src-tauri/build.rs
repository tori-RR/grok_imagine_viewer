const APP_COMMANDS: &[&str] = &[
    "set_viewer_mode",
    "report_chrome_height",
    "reopen_grok",
    "start_download",
    "stop_download",
    "open_grok_media",
    "resize_for_media",
    "toggle_window_fullscreen",
    "set_grok_muted",
    "pick_library",
    "create_library",
    "get_playback_acceleration",
    "set_playback_acceleration",
    "get_environment_status",
    "install_environment_component",
];

fn main() {
    let attributes = tauri_build::Attributes::new()
        .app_manifest(tauri_build::AppManifest::new().commands(APP_COMMANDS));
    tauri_build::try_build(attributes).expect("failed to build Tauri ACL manifest");
}
