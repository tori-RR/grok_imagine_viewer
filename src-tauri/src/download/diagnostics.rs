//! Bounded diagnostics contain identifiers and numeric observations only.
//! Never capture HTTP bodies, request headers, cookies or signed media URLs.
use super::{lock, page_code_meaning, CaptureFailure, DownloadCounts, RunControl, StatusCallback};
use serde::Serialize;
use std::{sync::{atomic::Ordering, Arc}, time::Instant};

pub(super) const MAX_FAILURE_DETAILS: usize = 200;
pub(super) const MAX_PERMISSION_NOTES: usize = 16;
/// WebView2 `COREWEBVIEW2_PERMISSION_KIND_MULTIPLE_AUTOMATIC_DOWNLOADS`.
pub(crate) const PERMISSION_KIND_MULTIPLE_AUTOMATIC_DOWNLOADS: i32 = 7;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PermissionNote {
    pub(crate) kind: i32,
    /// `grok.com` or `other`. Never a full URI.
    pub(crate) host: String,
    pub(crate) state: i32,
    pub(crate) during_run: bool,
    pub(crate) allowed: bool,
}

#[derive(Debug, Clone, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CaptureChain {
    pub(crate) prepare_finished: bool,
    pub(crate) capture_armed: bool,
    pub(crate) click_dispatched: bool,
    pub(crate) native_download_start_seen: bool,
    pub(crate) tauri_requested_seen: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) native_uri_match: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) tauri_url_match: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) expected_name_match: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) native_state_changed: Option<i32>,
    pub(crate) tauri_finished_seen: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) interrupt_reason: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) blob_sha: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) permission_kind: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) permission_host: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) permission_state: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) permission_during_run: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) permission_allowed: Option<bool>,
}

impl CaptureChain {
    pub(super) fn apply_permission(&mut self, note: &PermissionNote) {
        self.permission_kind = Some(note.kind);
        self.permission_host = Some(note.host.clone());
        self.permission_state = Some(note.state);
        self.permission_during_run = Some(note.during_run);
        self.permission_allowed = Some(note.allowed);
    }
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DownloadFailure {
    pub(crate) asset_id: String,
    pub(crate) stage: String,
    pub(crate) code: String,
    pub(crate) message: String,
    pub(crate) attempt: u64,
    pub(crate) retryable: bool,
    pub(crate) elapsed_ms: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) http_status: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) retry_after_seconds: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) expected_bytes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) received_bytes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) native_reason: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) chain: Option<CaptureChain>,
}

impl DownloadFailure {
    pub(super) fn new(id: &str, stage: &str, code: &str, attempt: u64) -> Self {
        let message = match code {
            "manifest_size_mismatch" => "清单大小与实际响应大小不一致；已保留原图库并拒绝写入此项。".into(),
            "capture_timeout" => "等待 WebView2 下载或完成事件超时。".into(),
            "capture_start_timeout" => "WebView2 未发出下载开始事件。".into(),
            "capture_finish_timeout" => "WebView2 已开始下载但未完成。".into(),
            "native_interrupted" => "WebView2 中断了本次下载，详见原生中断码。".into(),
            "capture_failed" => "WebView2 下载未成功完成。".into(),
            "click_failed" => "未能触发受控的媒体下载。".into(),
            "path_mismatch" => "WebView2 报告的落盘路径与受控临时路径不一致。".into(),
            "file_missing" => "下载完成后找不到受控临时文件。".into(),
            "file_size_mismatch" => "已落盘的文件大小与响应大小不一致。".into(),
            "signature_invalid" => "下载文件格式签名与媒体扩展名不一致。".into(),
            "file_conflict" => "目标文件已经存在；已停止以免覆盖。".into(),
            "storage_failed" => "无法验证或持久化下载文件（可能是磁盘、权限或网络共享故障）。".into(),
            "commit_uncertain" => "文件最终落位结果不确定；已保留恢复记录并停止。".into(),
            "space_unavailable" => "图库空间不足或无法确认可用空间。".into(),
            "journal_failed" => "无法保存下载恢复记录；为保护图库已停止。".into(),
            _ => page_code_meaning(code, None).0,
        };
        Self { asset_id: id.to_owned(), stage: stage.into(), code: code.into(), message, attempt,
            retryable: false, elapsed_ms: 0, http_status: None, retry_after_seconds: None,
            expected_bytes: None, received_bytes: None, native_reason: None, chain: None }
    }

    pub(super) fn with_chain(mut self, chain: CaptureChain) -> Self {
        if let Some(reason) = chain.interrupt_reason {
            self.native_reason = Some(reason);
            if self.code == "native_interrupted" {
                self.message = interrupt_reason_message(reason);
            }
        }
        self.chain = Some(chain);
        self
    }

    pub(super) fn capture(id: &str, failure: CaptureFailure, attempt: u64) -> Self {
        let (stage, code) = match failure {
            CaptureFailure::StartTimedOut => ("capture", "capture_start_timeout"),
            CaptureFailure::FinishTimedOut => ("capture", "capture_finish_timeout"),
            CaptureFailure::PathMismatch => ("validation", "path_mismatch"),
            CaptureFailure::MissingFile => ("validation", "file_missing"),
            CaptureFailure::SizeMismatch { .. } => ("validation", "file_size_mismatch"),
            CaptureFailure::SignatureInvalid => ("validation", "signature_invalid"),
            CaptureFailure::Conflict => ("commit", "file_conflict"),
            CaptureFailure::Uncertain => ("commit", "commit_uncertain"),
            CaptureFailure::Storage => ("validation", "storage_failed"),
            _ => ("capture", "capture_failed"),
        };
        let mut result = Self::new(id, stage, code, attempt);
        result.retryable = matches!(
            failure,
            CaptureFailure::Failed | CaptureFailure::StartTimedOut | CaptureFailure::Storage
        );
        if let CaptureFailure::SizeMismatch { expected, received } = failure {
            result.expected_bytes = Some(expected); result.received_bytes = Some(received);
        }
        result
    }
}

fn interrupt_reason_message(reason: u32) -> String {
    match reason {
        1 => "WebView2 无法写入目标文件（FILE_FAILED）。图库在网络盘或 UNC 路径时很常见。".into(),
        2 => "WebView2 没有目标文件的写入权限（FILE_ACCESS_DENIED）。".into(),
        3 => "磁盘空间不足（FILE_NO_SPACE）。".into(),
        12 => "WebView2 网络中断（NETWORK_FAILED）。".into(),
        other => format!("WebView2 中断了本次下载，原生中断码 {other}。"),
    }
}

#[derive(Default)]
pub(super) struct RunReport {
    pub(super) counts: DownloadCounts,
    pub(super) failures: Vec<DownloadFailure>,
}

/// All early exits retain the current stage and successful earlier files.
/// A cancelled current item is not mislabeled as a failed download.
#[cfg(windows)]
pub(super) struct AssetTrace {
    id: String,
    started: Instant,
    control: Arc<RunControl>,
    status: StatusCallback,
    latest: DownloadFailure,
    success: bool,
}

#[cfg(windows)]
impl AssetTrace {
    pub(super) fn new(id: &str, control: Arc<RunControl>, status: StatusCallback) -> Self {
        lock(&control.report).counts.attempted += 1;
        Self { id: id.into(), started: Instant::now(), control, status,
            latest: DownloadFailure::new(id,"prepare","network",1), success: false }
    }
    pub(super) fn stage(&mut self, stage: &str, code: &str, attempt: u64) {
        self.latest = DownloadFailure::new(&self.id, stage, code, attempt);
    }
    pub(super) fn failure(&mut self, failure: DownloadFailure) { self.latest = failure; }
    pub(super) fn succeeded(&mut self) { self.success = true; }
}

#[cfg(windows)]
impl Drop for AssetTrace {
    fn drop(&mut self) {
        let mut report = lock(&self.control.report);
        if self.success { report.counts.succeeded += 1; return; }
        if self.control.cancel.load(Ordering::Acquire) || !self.control.navigation.is_current() { return; }
        report.counts.failed += 1;
        self.latest.elapsed_ms = self.started.elapsed().as_millis().min(u128::from(u64::MAX)) as u64;
        if report.failures.len() < MAX_FAILURE_DETAILS { report.failures.push(self.latest.clone()); }
        drop(report);
        if let Ok(json) = serde_json::to_string(&self.latest) { (self.status)(format!("diagnostic {json}")); }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn distinct_validation_observations_survive_serialization() {
        let failure = DownloadFailure::capture("asset-123", CaptureFailure::SizeMismatch {expected:32,received:16}, 2);
        let json = serde_json::to_value(&failure).unwrap();
        assert_eq!(json["code"], "file_size_mismatch");
        assert_eq!(json["expectedBytes"],32); assert_eq!(json["receivedBytes"],16);
        assert!(json.get("url").is_none()); assert!(json.get("httpStatus").is_none());
        assert!(!failure.retryable);
        let start = DownloadFailure::capture("asset-1", CaptureFailure::StartTimedOut, 1);
        assert_eq!(start.code, "capture_start_timeout");
        assert!(start.retryable);
        let finish = DownloadFailure::capture("asset-1", CaptureFailure::FinishTimedOut, 1);
        assert_eq!(finish.code, "capture_finish_timeout");
        assert!(!finish.retryable);
        let serialized = serde_json::to_string(&start.with_chain(CaptureChain {
            blob_sha: Some("abc123def456".into()),
            native_download_start_seen: false,
            ..CaptureChain::default()
        })).unwrap();
        assert!(serialized.contains("abc123def456"));
        assert!(!serialized.contains("blob:"));
        assert!(!serialized.contains("http"));
    }
    #[test]
    fn details_are_bounded_but_counts_remain_complete() {
        let mut report = RunReport::default();
        for _ in 0..1000 {
            report.counts.failed += 1;
            if report.failures.len() < MAX_FAILURE_DETAILS { report.failures.push(DownloadFailure::new("asset-1","prepare","network",3)); }
        }
        assert_eq!(report.counts.failed,1000); assert_eq!(report.failures.len(),200);
    }

    #[test]
    fn native_interrupt_one_is_file_failed() {
        let detail = DownloadFailure::new("asset-1", "capture", "native_interrupted", 1).with_chain(
            CaptureChain {
                interrupt_reason: Some(1),
                ..CaptureChain::default()
            },
        );
        assert_eq!(detail.native_reason, Some(1));
        assert!(detail.message.contains("FILE_FAILED"));
        assert!(!detail.message.contains("\\\\"));
        assert!(!detail.message.contains("http"));
    }
}
