use super::*;
use super::http_fetch;
use std::{
    collections::HashMap,
    ffi::OsString,
    fs,
    path::{Path, PathBuf},
    sync::{atomic::AtomicBool, mpsc, Arc, Mutex},
    thread,
    time::Duration,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct TaskBudget {
    actual_bytes: u64,
    remaining_known_bytes: u64,
    pending_layout_copy_bytes: u64,
}

impl TaskBudget {
    fn observe_unknown(&mut self, observed: &mut Option<u64>, size: u64) -> Result<(), String> {
        if let Some(previous) = *observed {
            return if previous == size {
                Ok(())
            } else {
                Err("同一媒体重试时返回了不同大小，已停止下载。".into())
            };
        }
        let next = self
            .actual_bytes
            .checked_add(size)
            .filter(|total| *total <= MAX_DOWNLOAD_TASK_BYTES)
            .ok_or_else(|| "本次下载媒体总量超过安全上限。".to_string())?;
        self.actual_bytes = next;
        *observed = Some(size);
        Ok(())
    }

    fn required_space(&self, current_unknown_bytes: u64) -> Result<u64, String> {
        let future_media = self
            .remaining_known_bytes
            .checked_add(current_unknown_bytes)
            .and_then(|bytes| bytes.checked_mul(2))
            .ok_or_else(|| "下载空间预算溢出。".to_string())?;
        MIN_FREE_BYTES
            .checked_add(self.pending_layout_copy_bytes)
            .and_then(|bytes| bytes.checked_add(future_media))
            .ok_or_else(|| "下载空间预算溢出。".to_string())
    }

    fn finish_asset(
        &mut self,
        declared_size: Option<u64>,
        committed_size: Option<u64>,
    ) -> Result<(), String> {
        if let Some(size) = declared_size {
            self.remaining_known_bytes = self
                .remaining_known_bytes
                .checked_sub(size)
                .ok_or_else(|| "下载空间预算状态冲突。".to_string())?;
        }
        if let Some(size) = committed_size {
            self.pending_layout_copy_bytes = self
                .pending_layout_copy_bytes
                .checked_add(size)
                .ok_or_else(|| "下载空间预算溢出。".to_string())?;
        }
        Ok(())
    }
}

fn build_task_budget(
    library: &Library,
    existing: &HashMap<String, PathBuf>,
    trashed: &std::collections::HashSet<String>,
) -> Result<(u64, TaskBudget), String> {
    let mut missing_total = 0_u64;
    let mut known_bytes = 0_u64;
    for asset in &library.assets {
        let lookup = asset.id.to_ascii_lowercase();
        if trashed.contains(&lookup) || existing.contains_key(&lookup) {
            continue;
        }
        missing_total = missing_total
            .checked_add(1)
            .ok_or_else(|| "本次下载媒体数量溢出。".to_string())?;
        if let Some(size) = asset.sz.filter(|size| *size > 0) {
            if size > MAX_MEDIA_BYTES {
                return Err("待下载媒体超过 512 MiB 单文件准入上限。".into());
            }
            known_bytes = known_bytes
                .checked_add(size)
                .filter(|total| *total <= MAX_DOWNLOAD_TASK_BYTES)
                .ok_or_else(|| "本次下载媒体总量超过 256 GiB 安全上限。".to_string())?;
        }
    }
    Ok((
        missing_total,
        TaskBudget {
            actual_bytes: known_bytes,
            remaining_known_bytes: known_bytes,
            pending_layout_copy_bytes: 0,
        },
    ))
}

fn commit_download_bind(
    session: &crate::backend::BackendSession,
    root: &Path,
    user_id: &str,
) -> Result<PathBuf, Box<DownloadRunResult>> {
    match crate::backend::bind_download_account(session, root, user_id, true) {
        Ok(crate::backend::DownloadBindOutcome::Bound(root)) => Ok(root),
        Ok(crate::backend::DownloadBindOutcome::AccountMismatch) => {
            Err(DownloadRunResult::failure("当前登录账号与这个图库不一致。").into())
        }
        Ok(crate::backend::DownloadBindOutcome::UnsupportedMode) => {
            Err(DownloadRunResult::failure("下载只支持带 _index.json 的完整图库。").into())
        }
        Ok(crate::backend::DownloadBindOutcome::RootChanged) => {
            Err(DownloadRunResult::failure("图库已经切换，这次下载没有写入任何文件。").into())
        }
        Err(error) => Err(DownloadRunResult::failure(error.to_string()).into()),
    }
}

fn recover_interrupted_publish(
    out_root: &Path,
    operation_id: &str,
    status: &StatusCallback,
    control: &Arc<RunControl>,
) -> Result<(), Box<DownloadRunResult>> {
    let _gallery_write_lease =
        match gallery_lock::GalleryWriteLease::try_acquire(out_root, operation_id) {
            Ok(lease) => lease,
            Err(error) => return Err(DownloadRunResult::failure(error.to_string()).into()),
        };
    let recovery = match journal::DownloadJournal::recover(out_root) {
        Ok(recovery) => recovery,
        Err(error) => return Err(DownloadRunResult::failure(error).into()),
    };
    let journal::RecoveryState::Publishing(recovery_library) = recovery else {
        return Ok(());
    };
    status("正在恢复上一次图库发布".into());
    let trashed = layout::load_trashed_ids(out_root);
    let recovery_existing = layout::scan_existing(out_root, &recovery_library);
    if let Err(error) = layout::write_state(out_root, &recovery_library) {
        return Err(DownloadRunResult::failure(error).into());
    }
    if let Err(error) = layout::write_layout(
        out_root,
        &recovery_library,
        &recovery_existing,
        &trashed,
        Some(status),
        Some(&control.cancel),
    ) {
        if control.cancel.load(Ordering::Acquire) {
            return Err(DownloadRunResult::stopped().into());
        }
        return Err(DownloadRunResult::failure(error).into());
    }
    if control.cancel.load(Ordering::Acquire) {
        return Err(DownloadRunResult::stopped().into());
    }
    if let Err(error) = journal::DownloadJournal::finish_recovered_publish(out_root) {
        return Err(DownloadRunResult::failure(error).into());
    }
    Ok(())
}

fn ensure_available_space(root: &Path, required: u64) -> Result<(), String> {
    let available =
        fs2::available_space(root).map_err(|_| "无法确认图库可用空间，已停止下载。".to_string())?;
    if !space_is_sufficient(available, required) {
        return Err("图库可用空间不足，已停止下载。".into());
    }
    Ok(())
}

/// Bounded backoff that still notices a stop request. Returns false when the
/// run was cancelled while waiting.
fn sleep_unless_cancelled(cancel: &AtomicBool, total: Duration) -> bool {
    let deadline = Instant::now() + total;
    while Instant::now() < deadline {
        if cancel.load(Ordering::Acquire) {
            return false;
        }
        let remaining = deadline.saturating_duration_since(Instant::now());
        thread::sleep(remaining.min(Duration::from_millis(100)));
    }
    !cancel.load(Ordering::Acquire)
}

fn retry_backoff(code: &str, attempt: u64) -> Duration {
    // 429 must not be hammered on the same 300/600 ms schedule as a flaky read.
    let base = if code == probe_code::RATE_LIMITED {
        2_000
    } else {
        300
    };
    Duration::from_millis((base * attempt).min(20_000))
}

fn space_is_sufficient(available: u64, required: u64) -> bool {
    available >= required
}

#[allow(clippy::too_many_arguments)]
pub(super) fn run<R: Runtime>(
    webview: Webview<R>,
    out_root: PathBuf,
    expected_user_id: String,
    status: StatusCallback,
    control: Arc<RunControl>,
    capture: DownloadCapture,
    run_id: u64,
    backend_session: crate::backend::BackendSession,
) -> DownloadRunResult {
    let out_root = match out_root.canonicalize() {
        Ok(root) if root.is_dir() => root,
        _ => return DownloadRunResult::failure("无法验证图库目录。"),
    };
    // Tag every progress line with the run that produced it, so a late line
    // from a stopped run cannot repaint the ring of the run after it.
    let status: StatusCallback = {
        let inner = status;
        Arc::new(move |text: String| inner(format!("run {run_id} {text}")))
    };
    if control.cancel.load(Ordering::Acquire) {
        return DownloadRunResult::stopped();
    }
    let recover_id = format!("tauri-download-recover-{}-{run_id}", std::process::id());
    if let Err(result) = recover_interrupted_publish(&out_root, &recover_id, &status, &control) {
        return *result;
    }

    status("正在确认 Grok 登录账号".into());
    if let Err(error) = verify_bound_user(
        &webview,
        &control.cancel,
        &control.navigation,
        &expected_user_id,
    ) {
        if control.cancel.load(Ordering::Acquire) {
            return DownloadRunResult::stopped();
        }
        return DownloadRunResult::coded(&error.0, error.1);
    }
    status("正在读取 Grok 图库列表".into());
    let library = match windows_runtime::fetch_library(
        &webview,
        &control.cancel,
        &control.navigation,
        &status,
    ) {
        Ok(library) => library,
        Err(_) if control.cancel.load(Ordering::Acquire) => return DownloadRunResult::stopped(),
        Err(failure) if failure.cancelled => return DownloadRunResult::stopped(),
        Err(failure) => return DownloadRunResult::coded(&failure.code, failure.message),
    };
    let library = match library.validate() {
        Ok(library) => library,
        Err(error) => return DownloadRunResult::coded(probe_code::SCHEMA, error),
    };
    // A complete but empty manifest over a populated index would erase every
    // visible entry. Refuse and keep the previous index instead of "fixing" a
    // read anomaly by publishing nothing.
    if library.assets.is_empty() && layout::indexed_item_count(&out_root) > 0 {
        return DownloadRunResult::coded(
            probe_code::EMPTY_MANIFEST_GUARD,
            describe_page_code(probe_code::EMPTY_MANIFEST_GUARD),
        );
    }
    status("正在重新核对 Grok 登录账号".into());
    if let Err(error) = verify_bound_user(
        &webview,
        &control.cancel,
        &control.navigation,
        &expected_user_id,
    ) {
        if control.cancel.load(Ordering::Acquire) {
            return DownloadRunResult::stopped();
        }
        return DownloadRunResult::coded(&error.0, error.1);
    }
    if control.cancel.load(Ordering::Acquire) {
        return DownloadRunResult::stopped();
    }
    status("正在核对图库账号绑定".into());
    if let Err(result) = commit_download_bind(&backend_session, &out_root, &expected_user_id) {
        return *result;
    }
    status("正在取得图库写入锁".into());
    let operation_id = format!("tauri-download-{}-{run_id}", std::process::id());
    let _gallery_write_lease =
        match gallery_lock::GalleryWriteLease::try_acquire(&out_root, &operation_id) {
            Ok(lease) => lease,
            Err(error) => return DownloadRunResult::failure(error.to_string()),
        };
    let recovery = match journal::DownloadJournal::recover(&out_root) {
        Ok(recovery) => recovery,
        Err(error) => return DownloadRunResult::failure(error),
    };

    let trashed = layout::load_trashed_ids(&out_root);
    if let journal::RecoveryState::Publishing(recovery_library) = recovery {
        status("正在恢复上一次图库发布".into());
        if let Err(error) = verify_bound_user(
            &webview,
            &control.cancel,
            &control.navigation,
            &expected_user_id,
        ) {
            if control.cancel.load(Ordering::Acquire) {
                return DownloadRunResult::stopped();
            }
            return DownloadRunResult::coded(&error.0, error.1);
        }
        let recovery_existing = layout::scan_existing(&out_root, &recovery_library);
        if let Err(error) = layout::write_state(&out_root, &recovery_library) {
            return DownloadRunResult::failure(error);
        }
        if let Err(error) = layout::write_layout(
            &out_root,
            &recovery_library,
            &recovery_existing,
            &trashed,
            Some(&status),
            Some(&control.cancel),
        ) {
            if control.cancel.load(Ordering::Acquire) {
                return DownloadRunResult::stopped();
            }
            return DownloadRunResult::failure(error);
        }
        if control.cancel.load(Ordering::Acquire) {
            return DownloadRunResult::stopped();
        }
        if let Err(error) = journal::DownloadJournal::finish_recovered_publish(&out_root) {
            return DownloadRunResult::failure(error);
        }
    }
    let mut existing = layout::scan_existing(&out_root, &library);
    let (missing_total, mut budget) = match build_task_budget(&library, &existing, &trashed) {
        Ok(plan) => plan,
        Err(error) => return DownloadRunResult::failure(error),
    };
    if missing_total > 0 {
        let required = match budget.required_space(0) {
            Ok(required) => required,
            Err(error) => return DownloadRunResult::failure(error),
        };
        if let Err(error) = ensure_available_space(&out_root, required) {
            return DownloadRunResult::failure(error);
        }
    }
    let mut journal = match journal::DownloadJournal::begin(&out_root, &library) {
        Ok(journal) => journal,
        Err(error) => return DownloadRunResult::failure(error),
    };

    let inbox = out_root.join("_inbox").join("0000_inbox");
    if let Err(error) = layout::ensure_safe_dir(&out_root, &inbox) {
        return DownloadRunResult::failure(error);
    }

    status(format!("local {} missing {missing_total}", existing.len()));

    let mut attempted = 0_u64;
    let mut succeeded = 0_u64;
    let mut failed = 0_u64;
    lock(&control.report).counts = DownloadCounts {
        total: missing_total, skipped: (library.assets.len() as u64).saturating_sub(missing_total),
        ..DownloadCounts::default()
    };
    let missing: Vec<&Asset> = library.assets.iter().filter(|asset| {
        let id = asset.id.to_ascii_lowercase(); !trashed.contains(&id) && !existing.contains_key(&id)
    }).collect();
    if let Some(first) = missing.first() {
        if let Some(backend) = select_http_backend(first, &control.cancel, &status) {
            status(format!("http {} {}", backend.label(), http_fetch::HTTP_WORKERS));
            match drain_http(
                backend,
                &missing,
                &out_root,
                &inbox,
                &mut journal,
                &mut existing,
                &mut budget,
                &mut attempted,
                &mut succeeded,
                &mut failed,
                missing_total,
                &control,
                &status,
            ) {
                Err(error) if control.cancel.load(Ordering::Acquire) || error == "下载已停止。" => {
                    return DownloadRunResult::stopped();
                }
                Err(error) => return DownloadRunResult::failure(error),
                Ok(()) => {}
            }
        }
    }
    let mut detached_probed = false;
    let mut prefetched: Option<prefetch::Prefetch<R>> = None;
    for (asset_index, asset) in missing.iter().enumerate() {
        if control.cancel.load(Ordering::Acquire) {
            return DownloadRunResult::stopped();
        }
        let lookup = asset.id.to_ascii_lowercase();
        if trashed.contains(&lookup) || existing.contains_key(&lookup) {
            continue;
        }

        attempted += 1;
        let mut trace = diagnostics::AssetTrace::new(&asset.id, Arc::clone(&control), Arc::clone(&status));
        let declared_size = asset.sz.filter(|size| *size > 0);
        let mut observed_unknown_size = None;
        let mut committed_size = None;
        let final_path = inbox.join(format!("{}{}", asset.id, layout::extension(asset)));
        let mut downloaded = false;
        let mut prepared_blob: Option<windows_runtime::PreparedBlob> = None;
        let mut trigger_retries = 0_u8;
        let mut prepare_tries = 0_u64;
        let mut attempt = 0_u64;
        loop {
            if control.cancel.load(Ordering::Acquire) {
                if let Some(prepared) = prepared_blob.as_ref() {
                    windows_runtime::revoke_blob(&webview, prepared, &control.cancel, &control.navigation);
                }
                return DownloadRunResult::stopped();
            }
            attempt += 1;
            if prepared_blob.is_none() {
                prepare_tries += 1;
                if prepare_tries > 3 {
                    break;
                }
                trace.stage("prepare", "network", attempt);
                let ahead = if prepare_tries == 1 {
                    prefetched.take().and_then(|prefetch| prefetch.take(&asset.id, &control.cancel))
                } else {
                    None
                };
                let probe_now = !detached_probed;
                if probe_now {
                    detached_probed = true;
                }
                let prepared_result = match ahead {
                    Some(Err(ref failure)) if ["size", "length", "length-mismatch"].contains(&failure.code.as_str()) =>
                        windows_runtime::prepare_asset(&webview, &asset.key, &asset.mime, &control.cancel, &control.navigation, probe_now),
                    Some(result) => result,
                    None => windows_runtime::prepare_asset(&webview, &asset.key, &asset.mime, &control.cancel, &control.navigation, probe_now),
                };
                let prepared = match prepared_result {
                    Ok(prepared) => {
                        if let Some(ref probe) = prepared.probe {
                            let mut line = format!("probe {} {}", probe.host, probe.status);
                            if prepared.size > 0 {
                                line.push_str(&format!(" {}", prepared.size));
                            }
                            if probe.accept_ranges {
                                line.push_str(" ranges");
                            }
                            if let Some(omit) = probe.omit_status {
                                line.push_str(&format!(" omit {omit}"));
                                if let Some(bytes) = probe.omit_bytes.filter(|bytes| *bytes > 0) {
                                    line.push_str(&format!(" {bytes}B"));
                                }
                            }
                            status(line);
                        }
                        prepared
                    }
                    Err(_) if control.cancel.load(Ordering::Acquire) => {
                        return DownloadRunResult::stopped()
                    }
                    Err(failure) if failure.cancelled => return DownloadRunResult::stopped(),
                    Err(failure) if failure.retryable && prepare_tries < 3 => {
                        trace.failure(failure.diagnostic(&asset.id, attempt));
                        let advised = Duration::from_secs(failure.retry_after_seconds.unwrap_or_default().min(120));
                        if !sleep_unless_cancelled(
                            &control.cancel,
                            retry_backoff(&failure.code, attempt).max(advised),
                        ) {
                            return DownloadRunResult::stopped();
                        }
                        continue;
                    }
                    Err(failure) => {
                        trace.failure(failure.diagnostic(&asset.id, attempt));
                        break;
                    }
                };
                if control.cancel.load(Ordering::Acquire) || !control.navigation.is_current() {
                    windows_runtime::revoke_blob(&webview, &prepared, &control.cancel, &control.navigation);
                    return DownloadRunResult::stopped();
                }
                if asset
                    .sz
                    .is_some_and(|expected| expected > 0 && expected != prepared.size)
                {
                    let mut detail = DownloadFailure::new(&asset.id, "validation", "manifest_size_mismatch", attempt);
                    detail.expected_bytes = asset.sz; detail.received_bytes = Some(prepared.size);
                    trace.failure(detail);
                    windows_runtime::revoke_blob(
                        &webview,
                        &prepared,
                        &control.cancel,
                        &control.navigation,
                    );
                    break;
                }
                trace.stage("space", "space_unavailable", attempt);
                let current_unknown_bytes = if declared_size.is_none() {
                    if let Err(error) =
                        budget.observe_unknown(&mut observed_unknown_size, prepared.size)
                    {
                        windows_runtime::revoke_blob(
                            &webview,
                            &prepared,
                            &control.cancel,
                            &control.navigation,
                        );
                        return DownloadRunResult::failure(error);
                    }
                    prepared.size
                } else {
                    0
                };
                let required = match budget.required_space(current_unknown_bytes) {
                    Ok(required) => required,
                    Err(error) => {
                        windows_runtime::revoke_blob(
                            &webview,
                            &prepared,
                            &control.cancel,
                            &control.navigation,
                        );
                        return DownloadRunResult::failure(error);
                    }
                };
                if let Err(error) = ensure_available_space(&out_root, required) {
                    windows_runtime::revoke_blob(
                        &webview,
                        &prepared,
                        &control.cancel,
                        &control.navigation,
                    );
                    return DownloadRunResult::failure(error);
                }
                if prefetched.is_none() {
                    if let Some(next) = missing.get(asset_index + 1) {
                        if prefetch::allowed(prepared.size, next.sz) {
                            prefetched = prefetch::Prefetch::start(webview.clone(), control.navigation.clone(), &next.id, &next.key, &next.mime);
                        }
                    }
                }
                prepared_blob = Some(prepared);
            }
            let (blob_url, blob_size) = match prepared_blob.as_ref() {
                Some(prepared) => (prepared.url.clone(), prepared.size),
                None => break,
            };
            trace.stage("journal", "journal_failed", attempt);
            let (part_path, expected_name, part_token) = match unique_attempt_paths(&final_path) {
                Ok(paths) => paths,
                Err(error) => {
                    if let Some(prepared) = prepared_blob.take() {
                        windows_runtime::revoke_blob(&webview, &prepared, &control.cancel, &control.navigation);
                    }
                    return DownloadRunResult::failure(error);
                }
            };
            if let Err(error) = journal.arm(
                &asset.id,
                layout::extension(asset),
                &part_token,
                blob_size,
            ) {
                if let Some(prepared) = prepared_blob.take() {
                    windows_runtime::revoke_blob(&webview, &prepared, &control.cancel, &control.navigation);
                }
                return DownloadRunResult::failure(error);
            }
            trace.stage("capture", "capture_failed", attempt);
            let ticket = match capture.arm(CaptureRequest {
                run_id,
                exact_blob_url: blob_url.clone(),
                expected_name: expected_name.clone(),
                expected_size: blob_size,
                cancel: Arc::clone(&control.cancel),
                part_path,
                final_path: final_path.clone(),
            }) {
                Ok(ticket) => ticket,
                Err(error) => {
                    if let Some(prepared) = prepared_blob.take() {
                        windows_runtime::revoke_blob(&webview, &prepared, &control.cancel, &control.navigation);
                    }
                    if let Err(journal_error) = journal.abort_active() {
                        return DownloadRunResult::failure(journal_error);
                    }
                    return DownloadRunResult::failure(error);
                }
            };
            let mut click_failed = false;
            match windows_runtime::click_asset(
                &webview,
                &blob_url,
                &expected_name,
                &control.cancel,
                &control.navigation,
            ) {
                Ok(true) => capture.mark_click_dispatched(ticket, true),
                Ok(false) | Err(_) => {
                    click_failed = true;
                    capture.mark_click_dispatched(ticket, false);
                    trace.stage("trigger", "click_failed", attempt);
                    capture.abort(ticket, CaptureFailure::Failed);
                },
            }
            let completion = capture.wait(ticket, &control.cancel, DOWNLOAD_TIMEOUT, || {
                let _ = windows_runtime::cancel_current(&webview, capture.guard_key());
            });
            let chain = capture.last_chain();
            let native_reason = chain.interrupt_reason.or_else(|| {
                if matches!(&completion, CaptureCompletion::Finished {success: false, ..} | CaptureCompletion::Aborted {..}) {
                    windows_runtime::current_interrupt_reason(&webview, capture.guard_key(), &blob_url)
                } else {
                    None
                }
            });
            let completion = match layout::promote_native_stage(completion) {
                Ok(completion) => completion,
                Err(failure) => {
                    let detail = DownloadFailure::capture(&asset.id, failure, attempt).with_chain(chain);
                    trace.failure(detail);
                    if let Some(prepared) = prepared_blob.take() {
                        windows_runtime::revoke_blob(&webview, &prepared, &control.cancel, &control.navigation);
                    }
                    if let Err(error) = journal.abort_active() {
                        return DownloadRunResult::failure(error);
                    }
                    continue;
                }
            };
            let prepared_capture = match layout::prepare_capture_commit(&out_root, completion) {
                Ok(prepared_capture) => prepared_capture,
                Err(CaptureFailure::Cancelled) => {
                    if let Some(prepared) = prepared_blob.take() {
                        windows_runtime::revoke_blob(&webview, &prepared, &control.cancel, &control.navigation);
                    }
                    if let Err(error) = journal.abort_active() {
                        return DownloadRunResult::failure(error);
                    }
                    return DownloadRunResult::stopped();
                }
                Err(CaptureFailure::Conflict) => {
                    trace.failure(DownloadFailure::capture(&asset.id, CaptureFailure::Conflict, attempt).with_chain(chain));
                    if let Some(prepared) = prepared_blob.take() {
                        windows_runtime::revoke_blob(&webview, &prepared, &control.cancel, &control.navigation);
                    }
                    if let Err(error) = journal.abort_active() {
                        return DownloadRunResult::failure(error);
                    }
                    return DownloadRunResult::failure("下载目标文件已存在，已停止以避免覆盖。");
                }
                Err(failure) => {
                    let retry = capture_retry_kind(
                        failure,
                        chain.native_download_start_seen,
                        chain.tauri_requested_seen,
                        trigger_retries,
                    );
                    let mut detail = if click_failed {
                        DownloadFailure::new(&asset.id, "trigger", "click_failed", attempt)
                    } else {
                        DownloadFailure::capture(&asset.id, failure, attempt)
                    };
                    if let Some(reason) = native_reason {
                        detail = DownloadFailure::new(&asset.id, "capture", "native_interrupted", attempt);
                        detail.native_reason = Some(reason);
                    }
                    trace.failure(detail.with_chain(chain));
                    if let Err(error) = journal.abort_active() {
                        if let Some(prepared) = prepared_blob.take() {
                            windows_runtime::revoke_blob(&webview, &prepared, &control.cancel, &control.navigation);
                        }
                        return DownloadRunResult::failure(error);
                    }
                    match retry {
                        CaptureRetry::Trigger => {
                            if !capture.release_unstarted_blob(&blob_url) {
                                break;
                            }
                            trigger_retries += 1;
                            if !sleep_unless_cancelled(&control.cancel, Duration::from_millis(300 * attempt)) {
                                if let Some(prepared) = prepared_blob.take() {
                                    windows_runtime::revoke_blob(&webview, &prepared, &control.cancel, &control.navigation);
                                }
                                return DownloadRunResult::stopped();
                            }
                            continue;
                        }
                        CaptureRetry::Prepare if prepare_tries < 3 => {
                            if let Some(prepared) = prepared_blob.take() {
                                windows_runtime::revoke_blob(&webview, &prepared, &control.cancel, &control.navigation);
                            }
                            trigger_retries = 0;
                            if !sleep_unless_cancelled(&control.cancel, Duration::from_millis(300 * attempt)) {
                                return DownloadRunResult::stopped();
                            }
                            continue;
                        }
                        CaptureRetry::Prepare | CaptureRetry::None => break,
                    }
                }
            };
            trace.stage("journal", "journal_failed", attempt);
            if let Err(error) = capture.disown_part(run_id, prepared_capture.part_path()) {
                if let Some(prepared) = prepared_blob.take() {
                    windows_runtime::revoke_blob(&webview, &prepared, &control.cancel, &control.navigation);
                }
                return DownloadRunResult::failure(error);
            }
            if let Err(error) = journal.mark_ready() {
                if let Some(prepared) = prepared_blob.take() {
                    windows_runtime::revoke_blob(&webview, &prepared, &control.cancel, &control.navigation);
                }
                return DownloadRunResult::failure(error);
            }
            trace.stage("commit", "commit_uncertain", attempt);
            if layout::finalize_capture(&out_root, prepared_capture).is_err() {
                if let Some(prepared) = prepared_blob.take() {
                    windows_runtime::revoke_blob(&webview, &prepared, &control.cancel, &control.navigation);
                }
                return DownloadRunResult::failure(
                    "下载文件落位结果不确定，已保留恢复记录并停止。",
                );
            }
            trace.succeeded();
            if let Err(error) = journal.clear_active() {
                if let Some(prepared) = prepared_blob.take() {
                    windows_runtime::revoke_blob(&webview, &prepared, &control.cancel, &control.navigation);
                }
                return DownloadRunResult::failure(error);
            }
            committed_size = Some(blob_size);
            downloaded = true;
            break;
        }
        if let Some(prepared) = prepared_blob.take() {
            windows_runtime::revoke_blob(&webview, &prepared, &control.cancel, &control.navigation);
        }

        if let Err(error) = budget.finish_asset(declared_size, committed_size) {
            return DownloadRunResult::failure(error);
        }
        if downloaded {
            succeeded += 1;
            existing.insert(lookup, final_path);
        } else {
            failed += 1;
        }
        drop(trace);
        status(format!(
            "download {attempted}/{missing_total} success {succeeded} failed {failed}"
        ));
    }

    status("正在完成前核对 Grok 登录账号".into());
    if let Err(error) = verify_bound_user(
        &webview,
        &control.cancel,
        &control.navigation,
        &expected_user_id,
    ) {
        if control.cancel.load(Ordering::Acquire) {
            return DownloadRunResult::stopped();
        }
        return DownloadRunResult::coded(&error.0, error.1);
    }
    if control.cancel.load(Ordering::Acquire) {
        return DownloadRunResult::stopped();
    }
    let publish_library = match journal.mark_publishing() {
        Ok(library) => library,
        Err(error) => return DownloadRunResult::failure(error),
    };
    if let Err(error) = layout::write_state(&out_root, &publish_library) {
        return DownloadRunResult::failure(error);
    }
    if let Err(error) = layout::write_layout(
        &out_root,
        &publish_library,
        &existing,
        &trashed,
        Some(&status),
        Some(&control.cancel),
    ) {
        if control.cancel.load(Ordering::Acquire) {
            return DownloadRunResult::stopped();
        }
        return DownloadRunResult::failure(error);
    }
    if control.cancel.load(Ordering::Acquire) {
        return DownloadRunResult::stopped();
    }
    if let Err(error) = journal.finish() {
        return DownloadRunResult::failure(error);
    }
    let counts = DownloadCounts {
        total: missing_total,
        attempted,
        succeeded,
        failed,
        skipped: (library.assets.len() as u64).saturating_sub(missing_total),
    };
    if failed == 0 {
        return DownloadRunResult::success()
            .with_counts(counts)
            .with_published(true);
    }
    // The successful media are already committed and the index already names
    // them. Report a partial run so the page refreshes without claiming a
    // clean finish.
    DownloadRunResult::coded(
        if succeeded > 0 { "partial" } else { "download_failed" },
        "请打开「失败详情」查看逐项原因；已成功的文件不会重复下载。",
    )
    .with_counts(counts)
    .with_published(true)
}

fn probe_matches_expected(probe: &ProbeResponse, expected_user_id: &str) -> bool {
    probe.ok
        && !probe.stopped
        && !expected_user_id.is_empty()
        && probe.user_id.as_deref() == Some(expected_user_id)
}

/// Only a second, valid and *different* account id proves the account changed.
/// A blank page, a 403 interstitial or a timed-out probe means "unverified",
/// which must not be reported as "someone switched accounts".
fn verify_bound_user<R: Runtime>(
    webview: &Webview<R>,
    cancel: &AtomicBool,
    navigation: &NavigationGuard,
    expected_user_id: &str,
) -> Result<(), (String, String)> {
    let probe = windows_runtime::probe_user(webview, cancel, navigation);
    if probe_matches_expected(&probe, expected_user_id) {
        return Ok(());
    }
    if probe.ok && probe.user_id.is_some() {
        return Err((
            probe_code::ACCOUNT_CHANGED.to_owned(),
            describe_page_code(probe_code::ACCOUNT_CHANGED),
        ));
    }
    if probe.is_inconclusive() {
        let detail = probe
            .code
            .as_deref()
            .map(describe_page_code)
            .unwrap_or_default();
        let base = describe_page_code(probe_code::ACCOUNT_UNVERIFIED);
        let message = if detail.is_empty() {
            base
        } else {
            format!("{base}（{detail}）")
        };
        return Err((probe_code::ACCOUNT_UNVERIFIED.to_owned(), message));
    }
    Err((
        probe_code::NOT_LOGGED_IN.to_owned(),
        describe_page_code(probe_code::NOT_LOGGED_IN),
    ))
}

fn select_http_backend(
    first: &Asset,
    cancel: &AtomicBool,
    status: &StatusCallback,
) -> Option<http_fetch::HttpBackend> {
    let backend = http_fetch::preferred_detached();
    match http_fetch::probe_asset(&backend, &first.key, &first.mime, cancel) {
        Ok(probe) => {
            status(probe.status_line());
            probe.detached_ok().then_some(backend)
        }
        Err(error) => {
            status(error.status_line());
            // Authentication remains inside the already isolated Grok WebView.
            None
        }
    }
}

/// Own a unique staging directory, not an arbitrary shared temporary path.
/// Dropping a queued result, a failed worker send or an early return cleans it.
struct HttpStage {
    directory: PathBuf,
    path: PathBuf,
    size: u64,
}

impl HttpStage {
    fn create() -> Result<Self, http_fetch::HttpFetchError> {
        let mut bytes = [0_u8; 16];
        getrandom::fill(&mut bytes).map_err(|_| http_fetch::HttpFetchError::Io)?;
        let token = bytes.iter().map(|b| format!("{b:02x}")).collect::<String>();
        let directory = std::env::temp_dir().join(format!("giv-http-{token}"));
        fs::create_dir(&directory).map_err(|_| http_fetch::HttpFetchError::Io)?;
        Ok(Self { path: directory.join("media.part"), directory, size: 0 })
    }
}

impl Drop for HttpStage {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.path);
        // Never recursively delete a directory that may now contain other files.
        let _ = fs::remove_dir(&self.directory);
    }
}

type HttpResult = (Asset, Result<HttpStage, http_fetch::HttpFetchError>);

struct HttpWorkers {
    stop: Arc<AtomicBool>,
    jobs: Option<mpsc::SyncSender<Asset>>,
    results: Option<mpsc::Receiver<HttpResult>>,
    threads: Vec<thread::JoinHandle<()>>,
}

impl HttpWorkers {
    fn start(backend: http_fetch::HttpBackend, cancel: Arc<AtomicBool>) -> Result<Self, String> {
        let (job_tx, job_rx) = mpsc::sync_channel::<Asset>(http_fetch::HTTP_WORKERS);
        let (done_tx, done_rx) = mpsc::sync_channel::<HttpResult>(http_fetch::HTTP_WORKERS);
        let job_rx = Arc::new(Mutex::new(job_rx));
        let mut pool = Self { stop: Arc::new(AtomicBool::new(false)), jobs: Some(job_tx),
            results: Some(done_rx), threads: Vec::new() };
        for index in 0..http_fetch::HTTP_WORKERS {
            let job_rx = Arc::clone(&job_rx);
            let done_tx = done_tx.clone();
            let backend = backend.clone();
            let cancel = Arc::clone(&cancel);
            let stop = Arc::clone(&pool.stop);
            let worker = thread::Builder::new().name(format!("giv-http-{index}")).spawn(move || {
                let cancelled = || cancel.load(Ordering::Acquire) || stop.load(Ordering::Acquire);
                loop {
                    let asset = match lock(&job_rx).recv() { Ok(asset) => asset, Err(_) => return };
                    if cancelled() { return; }
                    let result = HttpStage::create().and_then(|mut staged| {
                        staged.size = http_fetch::fetch_asset(&backend, &asset, &staged.path, &cancelled)?;
                        Ok(staged)
                    });
                    if done_tx.send((asset, result)).is_err() { return; }
                }
            }).map_err(|_| "无法启动下载线程。".to_string())?;
            pool.threads.push(worker);
        }
        Ok(pool)
    }
}

impl Drop for HttpWorkers {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
        // Disconnect before joining: no sender may block behind an abandoned result.
        self.jobs.take();
        self.results.take();
        for worker in self.threads.drain(..) { let _ = worker.join(); }
    }
}

fn commit_http_file(
    journal: &mut journal::DownloadJournal,
    root: &Path,
    inbox: &Path,
    asset: &Asset,
    source: &Path,
    size: u64,
) -> Result<PathBuf, String> {
    let final_path = inbox.join(format!("{}{}", asset.id, layout::extension(asset)));
    let (part_path, _, token) = unique_attempt_paths(&final_path)?;
    journal.arm(&asset.id, layout::extension(asset), &token, size)?;
    let copied = (|| -> std::io::Result<()> {
        let mut input = fs::File::open(source)?;
        let mut output = fs::OpenOptions::new().write(true).create_new(true).open(&part_path)?;
        std::io::copy(&mut input, &mut output)?;
        output.sync_all()
    })();
    if copied.is_err() {
        journal.abort_active()?;
        return Err("无法写入下载临时文件。".into());
    }
    let completion = CaptureCompletion::Finished {
        success: true,
        reported_path: Some(part_path.clone()),
        expected_size: size,
        part_path,
        final_path: final_path.clone(),
        forced_failure: None,
    };
    match layout::prepare_capture_commit(root, completion) {
        Ok(prepared) => {
            journal.mark_ready()?;
            if layout::finalize_capture(root, prepared).is_err() {
                return Err("下载文件落位结果不确定，已保留恢复记录并停止。".into());
            }
            journal.clear_active()?;
            Ok(final_path)
        }
        Err(_) => {
            journal.abort_active()?;
            Err("下载文件校验失败。".into())
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn drain_http(
    backend: http_fetch::HttpBackend,
    missing: &[&Asset],
    root: &Path,
    inbox: &Path,
    journal: &mut journal::DownloadJournal,
    existing: &mut HashMap<String, PathBuf>,
    budget: &mut TaskBudget,
    attempted: &mut u64,
    succeeded: &mut u64,
    failed: &mut u64,
    missing_total: u64,
    control: &Arc<RunControl>,
    status: &StatusCallback,
) -> Result<(), String> {
    let pool = HttpWorkers::start(backend, Arc::clone(&control.cancel))?;
    let job_tx = pool.jobs.as_ref().expect("live HTTP job queue");
    let done_rx = pool.results.as_ref().expect("live HTTP result queue");
    let mut next = 0_usize;
    let mut inflight = 0_usize;
    let mut stop_queue = false;
    loop {
        if control.cancel.load(Ordering::Acquire) || !control.navigation.is_current() {
            return Err("下载已停止。".into());
        }
        while !stop_queue && inflight < http_fetch::HTTP_WORKERS && next < missing.len() {
            let asset = missing[next];
            next += 1;
            if existing.contains_key(&asset.id.to_ascii_lowercase()) { continue; }
            job_tx.send(asset.clone()).map_err(|_| "下载线程已停止。".to_string())?;
            inflight += 1;
        }
        if inflight == 0 && (stop_queue || next >= missing.len()) { break; }
        let (asset, result) = match done_rx.recv_timeout(Duration::from_millis(200)) {
            Ok(item) => item,
            Err(mpsc::RecvTimeoutError::Timeout) => {
                if pool.threads.iter().any(|worker| worker.is_finished()) {
                    return Err("下载线程意外退出；已停止并回收本次暂存文件。".into());
                }
                continue;
            }
            Err(_) => return Err("下载线程已停止。".into()),
        };
        inflight = inflight.saturating_sub(1);
        if control.cancel.load(Ordering::Acquire) || !control.navigation.is_current() {
            return Err("下载已停止。".into());
        }
        match result {
            Ok(staged) => {
                let mut trace = diagnostics::AssetTrace::new(&asset.id, Arc::clone(control), Arc::clone(status));
                trace.stage("http_commit", "storage_failed", 1);
                *attempted += 1;
                let declared = asset.sz.filter(|value| *value > 0);
                if declared.is_none() {
                    let mut observed = None;
                    budget.observe_unknown(&mut observed, staged.size)?;
                }
                let required = budget.required_space(if declared.is_none() { staged.size } else { 0 })?;
                ensure_available_space(root, required)?;
                let committed = commit_http_file(journal, root, inbox, &asset, &staged.path, staged.size)?;
                budget.finish_asset(declared, Some(staged.size))?;
                *succeeded += 1;
                trace.succeeded();
                drop(trace); // Report and ring must agree before emitting progress.
                existing.insert(asset.id.to_ascii_lowercase(), committed);
            }
            Err(http_fetch::HttpFetchError::Cancelled) => return Err("下载已停止。".into()),
            Err(error) => {
                stop_queue |= error.stops_queue();
                status(error.status_line());
                // A backend attempt is not a failed media item. The untouched
                // items go through the authenticated WebView path below once.
            }
        }
        status(format!("download {attempted}/{missing_total} success {succeeded} failed {failed}"));
    }
    Ok(())
}

fn unique_attempt_paths(final_path: &Path) -> Result<(PathBuf, String, String), String> {
    for _ in 0..8 {
        let mut bytes = [0_u8; 16];
        getrandom::fill(&mut bytes).map_err(|_| "无法生成安全的下载临时名。".to_string())?;
        let token = bytes
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        let mut value = OsString::from(final_path.as_os_str());
        value.push(format!(".giv-{token}.part"));
        let part = PathBuf::from(value);
        if part.symlink_metadata().is_err() {
            return Ok((part, format!("giv-{token}.download"), token));
        }
    }
    Err("无法生成唯一的下载临时路径。".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn asset(id: &str, size: Option<u64>) -> Asset {
        Asset {
            id: id.into(),
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
    fn idle_http_workers_are_joined_and_dropped_queue_results_are_cleaned() {
        let pool = HttpWorkers::start(http_fetch::preferred_detached(), Arc::new(AtomicBool::new(true))).unwrap();
        drop(pool); // No queued asset: this must not block waiting for input.
        let stage = HttpStage::create().unwrap();
        fs::write(&stage.path, b"fixture").unwrap();
        let path = stage.path.clone(); let dir = stage.directory.clone();
        let (tx, rx) = mpsc::sync_channel::<HttpStage>(1);
        tx.send(stage).ok().unwrap(); drop(rx);
        assert!(!path.exists()); assert!(!dir.exists());
    }

    #[test]
    fn http_success_is_preserved_by_the_shared_run_report() {
        let state = DownloadState::default();
        let control = Arc::new(RunControl::new(Arc::new(AtomicBool::new(false)), state.navigation_guard()));
        lock(&control.report).counts.total = 2;
        let status: StatusCallback = Arc::new(|_| {});
        // One HTTP success followed by one WebView success: transport failures
        // before fallback do not construct a final-media trace.
        for id in ["http-asset", "webview-asset"] {
            let mut trace = diagnostics::AssetTrace::new(id, Arc::clone(&control), Arc::clone(&status));
            trace.succeeded();
        }
        control.finish(DownloadRunResult::success());
        let result = control.wait();
        assert_eq!(result.counts.attempted, 2);
        assert_eq!(result.counts.succeeded, 2);
        assert_eq!(result.counts.failed, 0);
    }

    #[test]
    fn abandoned_http_stage_is_removed_but_unowned_files_survive() {
        let staged = HttpStage::create().unwrap();
        fs::write(&staged.path, b"fixture").unwrap();
        let dir = staged.directory.clone();
        let path = staged.path.clone();
        let other = dir.join("unowned");
        fs::write(&other, b"keep").unwrap();
        drop(staged);
        assert!(!path.exists());
        assert_eq!(fs::read(&other).unwrap(), b"keep");
        fs::remove_file(other).unwrap(); fs::remove_dir(dir).unwrap();
    }

    #[test]
    fn part_path_is_unique_and_stays_next_to_final_file() {
        let final_path = PathBuf::from(r"C:\gallery\_inbox\asset.jpg");
        let (first, first_name, first_token) = unique_attempt_paths(&final_path).unwrap();
        let (second, second_name, second_token) = unique_attempt_paths(&final_path).unwrap();
        assert_eq!(first.parent(), final_path.parent());
        assert_eq!(second.parent(), final_path.parent());
        assert_ne!(first, second);
        assert_ne!(first_name, second_name);
        assert_ne!(first_token, second_token);
        assert!(first.to_string_lossy().ends_with(".part"));
        assert!(first_name.starts_with("giv-") && first_name.ends_with(".download"));
        assert_eq!(first_token.len(), 32);
    }

    #[test]
    fn bound_user_probe_requires_the_same_logged_in_account() {
        let matching = ProbeResponse::logged_in("account-a".into());
        let changed = ProbeResponse::logged_in("account-b".into());
        let logged_out = ProbeResponse::not_logged_in();

        assert!(probe_matches_expected(&matching, "account-a"));
        assert!(!probe_matches_expected(&matching, ""));
        assert!(!probe_matches_expected(&changed, "account-a"));
        assert!(!probe_matches_expected(&logged_out, "account-a"));
    }

    #[test]
    fn only_a_second_valid_account_counts_as_an_account_change() {
        // A page that never answered is "unverified" and retryable; a real
        // sign-out and a different account are separate categories.
        assert!(!ProbeResponse::logged_in("account-b".into()).is_inconclusive());
        assert!(!ProbeResponse::not_logged_in().is_inconclusive());
        assert!(ProbeResponse::failed(probe_code::PAGE_NOT_READY).is_inconclusive());
        assert!(ProbeResponse::failed(probe_code::FORBIDDEN).is_inconclusive());
        assert!(ProbeResponse::failed(probe_code::TIMEOUT).is_inconclusive());
        assert!(!ProbeResponse::stopped().is_inconclusive());

        assert!(page_code_is_transient(probe_code::PAGE_NOT_READY));
        assert!(page_code_is_transient(probe_code::RATE_LIMITED));
        assert!(page_code_is_transient(probe_code::SERVER));
        assert!(!page_code_is_transient(probe_code::FORBIDDEN));
        assert!(!page_code_is_transient(probe_code::NOT_LOGGED_IN));
        assert!(!page_code_is_transient(probe_code::SCHEMA));
        assert!(!page_code_is_transient(probe_code::INCOMPLETE));
    }

    #[test]
    fn rate_limited_backoff_is_longer_and_bounded() {
        assert_eq!(retry_backoff(probe_code::NETWORK, 1).as_millis(), 300);
        assert_eq!(retry_backoff(probe_code::RATE_LIMITED, 1).as_millis(), 2_000);
        assert_eq!(retry_backoff(probe_code::RATE_LIMITED, 2).as_millis(), 4_000);
        assert!(retry_backoff(probe_code::RATE_LIMITED, 1_000).as_millis() <= 20_000);
    }

    #[test]
    fn account_is_rechecked_after_list_fetch_before_state_write() {
        let source = include_str!("sync.rs");
        let fetch = source.find("fetch_library").unwrap();
        let recheck = fetch
            + source[fetch..]
                .find("verify_bound_user")
                .expect("account recheck after list fetch");
        let asset_loop = source.find("for asset in &library.assets").unwrap();
        let final_status = source.find("正在完成前核对 Grok 登录账号").unwrap();
        let final_recheck = final_status
            + source[final_status..]
                .find("verify_bound_user")
                .expect("final account recheck after media loop");
        let publishing = final_recheck
            + source[final_recheck..]
                .find("journal.mark_publishing")
                .unwrap();
        let state_write = publishing + source[publishing..].find("layout::write_state").unwrap();
        let layout_write =
            state_write + source[state_write..].find("layout::write_layout").unwrap();

        assert!(source.contains("正在读取 Grok 图库列表"));
        assert!(fetch < recheck);
        assert!(asset_loop < final_recheck);
        assert!(final_recheck < publishing);
        assert!(publishing < state_write);
        assert!(state_write < layout_write);
    }

    #[test]
    fn interrupted_publish_is_recovered_before_beginning_a_new_transaction() {
        let source = include_str!("sync.rs");
        let recover_fn = source.find("fn recover_interrupted_publish").unwrap();
        let recover = source.find("DownloadJournal::recover").unwrap();
        let recovered_publish = source
            .find("RecoveryState::Publishing(recovery_library)")
            .unwrap();
        let recovered_state = recover_fn + source[recover_fn..].find("layout::write_state").unwrap();
        let finish_recovery = source.find("finish_recovered_publish").unwrap();
        let first_fetch = source.find("fetch_library").unwrap();
        let bind = source.find("commit_download_bind(&backend_session").unwrap();
        let budget_plan = source.find("build_task_budget(&library").unwrap();
        let space_preflight = budget_plan
            + source[budget_plan..]
                .find("ensure_available_space(&out_root")
                .unwrap();
        let begin = source.find("DownloadJournal::begin").unwrap();
        let inbox = source[begin..].find("ensure_safe_dir").unwrap() + begin;
        let asset_loop = source[begin..]
            .find("for asset in &library.assets")
            .unwrap()
            + begin;

        assert!(recover_fn < recover);
        assert!(recover < recovered_publish);
        assert!(recovered_publish < recovered_state);
        assert!(recovered_state < finish_recovery);
        assert!(finish_recovery < first_fetch);
        assert!(first_fetch < bind);
        assert!(bind < budget_plan);
        assert!(budget_plan < space_preflight);
        assert!(space_preflight < begin);
        assert!(begin < inbox);
        assert!(begin < asset_loop);
    }

    #[test]
    fn task_budget_excludes_existing_and_trashed_before_enforcing_limits() {
        let library = Library {
            assets: vec![
                asset("asset-missing", Some(MAX_MEDIA_BYTES)),
                asset("asset-unknown", None),
                asset("asset-existing", Some(MAX_MEDIA_BYTES + 1)),
                asset("asset-trashed", Some(MAX_MEDIA_BYTES + 1)),
            ],
            conversations: vec![],
        };
        let mut existing = HashMap::new();
        existing.insert("asset-existing".into(), PathBuf::from("existing.jpg"));
        let mut trashed = std::collections::HashSet::new();
        trashed.insert("asset-trashed".into());

        let (count, budget) = build_task_budget(&library, &existing, &trashed).unwrap();
        assert_eq!(count, 2);
        assert_eq!(budget.actual_bytes, MAX_MEDIA_BYTES);
        assert_eq!(budget.remaining_known_bytes, MAX_MEDIA_BYTES);

        assert!(build_task_budget(&library, &HashMap::new(), &trashed).is_err());
    }

    #[test]
    fn task_budget_rejects_known_total_above_256_gib() {
        let count = MAX_DOWNLOAD_TASK_BYTES / MAX_MEDIA_BYTES + 1;
        let library = Library {
            assets: (0..count)
                .map(|index| asset(&format!("asset-{index:06}"), Some(MAX_MEDIA_BYTES)))
                .collect(),
            conversations: vec![],
        };
        assert!(
            build_task_budget(&library, &HashMap::new(), &std::collections::HashSet::new())
                .is_err()
        );
    }

    #[test]
    fn unknown_sizes_count_once_and_cannot_change_between_retries() {
        let mut budget = TaskBudget {
            actual_bytes: 100,
            remaining_known_bytes: 100,
            pending_layout_copy_bytes: 5,
        };
        let mut observed = None;
        budget.observe_unknown(&mut observed, 50).unwrap();
        budget.observe_unknown(&mut observed, 50).unwrap();
        assert_eq!(budget.actual_bytes, 150);
        assert!(budget.observe_unknown(&mut observed, 51).is_err());

        assert_eq!(
            budget.required_space(50).unwrap(),
            MIN_FREE_BYTES + 5 + 2 * 150
        );
        budget.finish_asset(Some(100), Some(100)).unwrap();
        assert_eq!(budget.remaining_known_bytes, 0);
        assert_eq!(budget.pending_layout_copy_bytes, 105);
        budget.finish_asset(None, Some(50)).unwrap();
        assert_eq!(budget.pending_layout_copy_bytes, 155);

        let mut capped = TaskBudget {
            actual_bytes: MAX_DOWNLOAD_TASK_BYTES,
            remaining_known_bytes: 0,
            pending_layout_copy_bytes: 0,
        };
        assert!(capped.observe_unknown(&mut None, 1).is_err());
    }

    #[test]
    fn available_space_threshold_is_inclusive() {
        let required = MIN_FREE_BYTES + 123;
        assert!(space_is_sufficient(required, required));
        assert!(!space_is_sufficient(required - 1, required));
    }
}
