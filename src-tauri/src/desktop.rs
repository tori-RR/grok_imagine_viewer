//! Pure window geometry and narrow native media controls. No generic URL,
//! script, path or shell-execution command is exposed to the remote webview.
use serde::Deserialize;
use tauri::{window::Monitor, AppHandle, PhysicalPosition, PhysicalSize, Window};
use url::Url;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct MediaSize {
    pub(crate) width: f64,
    pub(crate) height: f64,
    pub(crate) scale: f64,
    pub(crate) extra_width: f64,
    pub(crate) extra_height: f64,
}

fn finite_size(value: f64) -> bool { value.is_finite() && value > 0.0 && value <= 65_536.0 }

pub(crate) fn initial_size(width: u32, height: u32) -> PhysicalSize<u32> {
    let (w, h) = if width >= height {
        let h = f64::from(height) * 0.5;
        (h * 4.0 / 3.0, h)
    } else {
        let w = f64::from(width) * 0.8;
        (w, w * 3.0 / 4.0)
    };
    PhysicalSize::new(w.round().max(1.0) as u32, h.round().max(1.0) as u32)
}

fn media_size(args: &MediaSize, dpi: f64, max: PhysicalSize<u32>) -> Result<PhysicalSize<u32>, String> {
    if !finite_size(args.width) || !finite_size(args.height)
        || ![0.5, 1.0, 1.5].contains(&args.scale)
        || !dpi.is_finite() || !(0.5..=8.0).contains(&dpi)
        || ![args.extra_width, args.extra_height].iter().all(|v| v.is_finite() && (0.0..=4096.0).contains(v))
        || max.width == 0 || max.height == 0 {
        return Err("媒体尺寸或缩放比例无效。".into());
    }
    // Native media dimensions are physical pixels. Only DOM chrome is in CSS
    // pixels; multiplying the media dimensions by DPI again would double-scale.
    let chrome_w = (args.extra_width * dpi).min(f64::from(max.width) * 0.8);
    let chrome_h = (args.extra_height * dpi).min(f64::from(max.height) * 0.8);
    let desired_w = args.width * args.scale;
    let desired_h = args.height * args.scale;
    let fit = 1.0_f64.min((f64::from(max.width) - chrome_w) / desired_w)
        .min((f64::from(max.height) - chrome_h) / desired_h);
    Ok(PhysicalSize::new(
        (desired_w * fit + chrome_w).round().clamp(1.0, f64::from(max.width)) as u32,
        (desired_h * fit + chrome_h).round().clamp(1.0, f64::from(max.height)) as u32,
    ))
}

fn centered(origin: i32, available: u32, size: u32) -> i32 {
    (i64::from(origin) + i64::from(available.saturating_sub(size)) / 2)
        .clamp(i64::from(i32::MIN), i64::from(i32::MAX)) as i32
}

fn maximum_client(window: &Window, monitor: &Monitor) -> tauri::Result<PhysicalSize<u32>> {
    let inner = window.inner_size()?;
    let outer = window.outer_size()?;
    Ok(PhysicalSize::new(
        monitor.work_area().size.width.saturating_sub(outer.width.saturating_sub(inner.width)).max(1),
        monitor.work_area().size.height.saturating_sub(outer.height.saturating_sub(inner.height)).max(1),
    ))
}

fn apply_size(window: &Window, monitor: &Monitor, size: PhysicalSize<u32>) -> tauri::Result<()> {
    window.set_size(size)?;
    let actual = window.outer_size()?;
    let area = monitor.work_area();
    window.set_position(PhysicalPosition::new(
        centered(area.position.x, area.size.width, actual.width),
        centered(area.position.y, area.size.height, actual.height),
    ))
}

pub(crate) fn initialize_window(app: &AppHandle, window: &Window) -> tauri::Result<()> {
    let active = app.cursor_position().ok()
        .and_then(|cursor| app.monitor_from_point(cursor.x, cursor.y).ok().flatten())
        .or(app.primary_monitor()?);
    if let Some(monitor) = active {
        let available = maximum_client(window, &monitor)?;
        let requested = initial_size(monitor.work_area().size.width, monitor.work_area().size.height);
        apply_size(window, &monitor, PhysicalSize::new(requested.width.min(available.width), requested.height.min(available.height)))?;
    }
    Ok(())
}

pub(crate) fn resize_media(window: &Window, args: &MediaSize) -> Result<(), String> {
    let monitor = window.current_monitor().map_err(|e| e.to_string())?
        .or(window.primary_monitor().map_err(|e| e.to_string())?)
        .ok_or_else(|| "无法取得当前显示器。".to_string())?;
    if window.is_fullscreen().map_err(|e| e.to_string())? { window.set_fullscreen(false).map_err(|e| e.to_string())?; }
    if window.is_maximized().map_err(|e| e.to_string())? { window.unmaximize().map_err(|e| e.to_string())?; }
    let maximum = maximum_client(window, &monitor).map_err(|e| e.to_string())?;
    let size = media_size(args, monitor.scale_factor(), maximum)?;
    apply_size(window, &monitor, size).map_err(|e| e.to_string())
}

fn is_conversation_query(raw: &str) -> bool {
    let bytes = raw.as_bytes();
    if bytes.len() == 8 {
        return bytes.iter().all(|b| b.is_ascii_hexdigit());
    }
    bytes.len() == 36 && raw.bytes().enumerate().all(|(i, b)| {
        if [8, 13, 18, 23].contains(&i) { b == b'-' } else { b.is_ascii_hexdigit() }
    })
}

pub(crate) fn trusted_post_url(raw: &str) -> Option<Url> {
    if raw.len() > 2048 { return None; }
    let mut url = Url::parse(raw).ok()?;
    if url.scheme() != "https" || url.host_str() != Some("grok.com")
        || !url.username().is_empty() || url.password().is_some()
        || url.port_or_known_default() != Some(443) { return None; }
    let id = url.path().strip_prefix("/imagine/post/")?.trim_end_matches('/');
    if id.len() != 36 || !id.bytes().enumerate().all(|(i, b)| {
        if [8,13,18,23].contains(&i) { b == b'-' } else { b.is_ascii_hexdigit() }
    }) { return None; }
    let conversation = url.query_pairs().find(|(key, _)| key == "conversation").map(|(_, value)| value.into_owned());
    url.set_query(None); url.set_fragment(None);
    if let Some(conversation) = conversation.filter(|value| is_conversation_query(value)) {
        url.set_query(Some(&format!("conversation={}", conversation.to_ascii_lowercase())));
    }
    Some(url)
}

#[cfg(windows)]
pub(crate) fn set_muted(webview: tauri::Webview, muted: bool) -> Result<(), String> {
    use std::{sync::mpsc, time::Duration};
    use windows::core::Interface;
    use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2_8;
    let (sender, receiver) = mpsc::sync_channel(1);
    webview.with_webview(move |platform| {
        let result = (|| -> windows::core::Result<()> {
            let core = unsafe { platform.controller().CoreWebView2()? };
            let audio: ICoreWebView2_8 = core.cast()?;
            unsafe { audio.SetIsMuted(muted) }
        })();
        let _ = sender.send(result.is_ok());
    }).map_err(|_| "无法调整 Grok 静音状态。".to_string())?;
    match receiver.recv_timeout(Duration::from_secs(3)) {
        Ok(true) => Ok(()),
        _ => Err("系统 WebView2 未确认静音调整。".into()),
    }
}

#[cfg(not(windows))]
pub(crate) fn set_muted(_webview: tauri::Webview, _muted: bool) -> Result<(), String> {
    Err("当前平台不支持 Grok 页面静音控制。".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn startup_fits_landscape_and_portrait_at_four_to_three() {
        assert_eq!(initial_size(1920,1080), PhysicalSize::new(720,540));
        assert_eq!(initial_size(1080,1920), PhysicalSize::new(864,648));
        assert_eq!(initial_size(3840,2160), PhysicalSize::new(1440,1080));
    }
    #[test]
    fn pixel_scale_applies_dpi_only_to_the_chrome() {
        let args = MediaSize{width:640.0,height:360.0,scale:1.0,extra_width:100.0,extra_height:50.0};
        assert_eq!(media_size(&args,2.0,PhysicalSize::new(3000,2000)).unwrap(), PhysicalSize::new(840,460));
        let fit = media_size(&args,2.0,PhysicalSize::new(500,400)).unwrap();
        assert!(fit.width<=500 && fit.height<=400);
    }
    #[test]
    fn invalid_media_and_multimonitor_coordinates_are_safe() {
        let args = MediaSize{width:f64::NAN,height:360.0,scale:1.0,extra_width:0.0,extra_height:0.0};
        assert!(media_size(&args,1.0,PhysicalSize::new(1920,1080)).is_err());
        assert_eq!(centered(-1920,1920,720),-1320);
    }
    #[test]
    fn only_explicit_grok_post_links_are_allowed() {
        let base="https://grok.com/imagine/post/12345678-1234-4321-8123-123456789abc";
        assert_eq!(trusted_post_url(&format!("{base}?token=secret#anything")).unwrap().as_str(),base);
        assert_eq!(trusted_post_url(&format!("{base}?conversation=019f9fea&token=secret")).unwrap().as_str(), format!("{base}?conversation=019f9fea"));
        assert_eq!(trusted_post_url(&format!("{base}?conversation=019f9fea-c066-7080-b4c7-5ffd2a1d5100")).unwrap().as_str(), format!("{base}?conversation=019f9fea-c066-7080-b4c7-5ffd2a1d5100"));
        for bad in ["https://evil.example/imagine/post/12345678-1234-4321-8123-123456789abc", "javascript:alert(1)", "https://grok.com:444/imagine/post/12345678-1234-4321-8123-123456789abc", "https://u@grok.com/imagine/post/12345678-1234-4321-8123-123456789abc", "https://grok.com/imagine/post/------------------------------------"] {
            assert!(trusted_post_url(bad).is_none());
        }
    }
}
