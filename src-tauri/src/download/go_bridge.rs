//! Native browser adapter for the Go download coordinator. No browser credentials
//! leave WebView2; the only bytes uploaded to loopback are validated media bytes.
use super::*;
use serde_json::{json, Value};
use std::io::{self, Read};

const JSON_LIMIT: u64 = 2 * 1024 * 1024;

// Only finite categories cross into Go/history. Browser messages, URLs and
// HTTP response bodies never become diagnostics or retry policy inputs.
#[derive(Debug, PartialEq, Eq)]
struct TransferFailure {
    code: &'static str,
    http_status: Option<u64>,
}
impl TransferFailure {
    fn new(code: &'static str) -> Self {
        Self {
            code,
            http_status: None,
        }
    }
    fn page(f: windows_runtime::PageFailure) -> Self {
        let code = match f.code.as_str() {
            "cancelled" => "cancelled",
            "network" | "body" | "blob" => "network_body",
            "timeout" => "blob_capture_timeout",
            "page_not_ready" => "page_not_ready",
            "http" | "http_error" | "rate_limited" | "server_error" => "http_error",
            "not_logged_in" => "not_logged_in",
            "forbidden" => "forbidden",
            "mime" | "blob-mime" => "mime_mismatch",
            "length" | "length-mismatch" | "size" | "chunk" => "length_mismatch",
            "redirect" => "redirect_refused",
            _ => "protocol_error",
        };
        Self {
            code,
            http_status: f.http_status.filter(|n| (100..=599).contains(n)),
        }
    }
    fn capture(f: CaptureFailure) -> Self {
        Self::new(match f {
            CaptureFailure::Cancelled => "cancelled",
            CaptureFailure::StartTimedOut | CaptureFailure::FinishTimedOut => {
                "blob_capture_timeout"
            }
            CaptureFailure::Conflict => "stage_conflict",
            CaptureFailure::Uncertain => "commit_uncertain",
            CaptureFailure::SizeMismatch { .. } => "length_mismatch",
            CaptureFailure::SignatureInvalid => "signature_mismatch",
            CaptureFailure::Storage => "storage_failed",
            CaptureFailure::Failed | CaptureFailure::PathMismatch | CaptureFailure::MissingFile => {
                "protocol_error"
            }
        })
    }
    fn wire(code: &str) -> Self {
        Self::new(match code {
            "network" => "network",
            "network_body" => "network_body",
            "upload_timeout" => "upload_timeout",
            "cancelled" => "cancelled",
            "mime_mismatch" => "mime_mismatch",
            "length_mismatch" => "length_mismatch",
            "signature_mismatch" | "invalid_signature" => "signature_mismatch",
            "size_limit" => "size_limit",
            "storage_failed" => "storage_failed",
            "stage_conflict" => "stage_conflict",
            "commit_uncertain" => "commit_uncertain",
            _ => "protocol_error",
        })
    }
}

fn transport_failure(error: &ureq::Transport) -> TransferFailure {
    let mut source = std::error::Error::source(error);
    while let Some(cause) = source {
        if let Some(io) = cause.downcast_ref::<io::Error>() {
            if matches!(
                io.kind(),
                io::ErrorKind::TimedOut | io::ErrorKind::WouldBlock
            ) {
                return TransferFailure::new("upload_timeout");
            }
        }
        source = cause.source();
    }
    TransferFailure::new("network")
}

fn decode_upload_response(
    result: Result<ureq::Response, ureq::Error>,
) -> Result<(), TransferFailure> {
    let response = match result {
        Ok(r) | Err(ureq::Error::Status(_, r)) => r,
        Err(ureq::Error::Transport(e)) => return Err(transport_failure(&e)),
    };
    let status = response.status();
    let mut body = Vec::new();
    response
        .into_reader()
        .take(JSON_LIMIT + 1)
        .read_to_end(&mut body)
        .map_err(|_| TransferFailure::new("network_body"))?;
    if body.len() as u64 > JSON_LIMIT {
        return Err(TransferFailure::new("protocol_error"));
    }
    let value: Value =
        serde_json::from_slice(&body).map_err(|_| TransferFailure::new("protocol_error"))?;
    if status == 200 && value["ok"].as_bool() == Some(true) {
        return Ok(());
    }
    Err(TransferFailure::wire(
        value["code"].as_str().unwrap_or("protocol_error"),
    ))
}

struct Client {
    session: crate::backend::BackendSession,
    agent: ureq::Agent,
}
impl Client {
    fn new(session: crate::backend::BackendSession) -> Result<Self, String> {
        if !session.verify_identity() {
            return Err("Go 服务身份验证失败。".into());
        }
        Ok(Self {
            session,
            agent: ureq::AgentBuilder::new()
                .redirects(0)
                .try_proxy_from_env(false)
                .timeout_connect(Duration::from_secs(3))
                .timeout_read(Duration::from_secs(10))
                .timeout_write(Duration::from_secs(10))
                .build(),
        })
    }
    fn json(&self, path: &str, body: Option<&Value>) -> Result<Value, String> {
        let request = self.session.native_download_request(
            &self.agent,
            if body.is_some() { "POST" } else { "GET" },
            path,
        )?;
        let result = if let Some(body) = body {
            let bytes = serde_json::to_vec(body).map_err(|_| "下载协议编码失败。")?;
            if bytes.len() > 32 * 1024 * 1024 {
                return Err("清单超过下载协议上限，未开始写入。".into());
            }
            request
                .set("Content-Type", "application/json")
                .send_bytes(&bytes)
        } else {
            request.call()
        };
        decode_response(result)
    }
}
fn decode_response(result: Result<ureq::Response, ureq::Error>) -> Result<Value, String> {
    let response = match result {
        Ok(r) | Err(ureq::Error::Status(_, r)) => r,
        Err(_) => return Err("无法连接受管 Go 下载服务。".into()),
    };
    let status = response.status();
    let mut body = Vec::new();
    response
        .into_reader()
        .take(JSON_LIMIT + 1)
        .read_to_end(&mut body)
        .map_err(|_| "下载服务响应读取失败。")?;
    if body.len() as u64 > JSON_LIMIT {
        return Err("下载服务响应超出上限。".into());
    }
    let value: Value = serde_json::from_slice(&body).map_err(|_| "下载服务响应格式错误。")?;
    if status != 200 || value["ok"].as_bool() != Some(true) {
        let code = value["code"].as_str().unwrap_or("protocol_error");
        return Err(format!("Go 下载请求被拒绝（{status}/{code}）。"));
    }
    Ok(value)
}
struct StopWatcher<'a>(&'a AtomicBool);
impl Drop for StopWatcher<'_> {
    fn drop(&mut self) {
        self.0.store(true, Ordering::Release);
    }
}
struct RunLease<'a> {
    client: &'a Client,
    id: u64,
}
impl Drop for RunLease<'_> {
    fn drop(&mut self) {
        let _ = self.client.json("stop", Some(&json!({"runId": self.id})));
    }
}
fn cancelled(control: &RunControl) -> bool {
    control.cancel.load(Ordering::Acquire) || !control.navigation.is_current()
}
fn verify_user<R: Runtime>(
    view: &Webview<R>,
    control: &RunControl,
    expected: &str,
) -> Result<(), String> {
    if cancelled(control) {
        return Err("下载已取消。".into());
    }
    let probe = windows_runtime::probe_user(view, &control.cancel, &control.navigation);
    if probe.ok && probe.user_id.as_deref() == Some(expected) {
        return Ok(());
    }
    Err(if probe.ok && probe.user_id.is_some() {
        "Grok 账号已经改变，停止下载。"
    } else {
        "无法确认 Grok 账号，停止下载。"
    }
    .into())
}

fn decode_prompt_targets(value: Value) -> Vec<PromptTarget> {
    let mut seen = HashSet::new();
    value["targets"].as_array().into_iter().flatten().take(8192)
        .filter_map(|target| serde_json::from_value::<PromptTarget>(target.clone()).ok())
        .filter(|target| target.token.len() == 32
            && target.token.bytes().all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
            && is_stable_id(&target.id)
            && (target.conv.is_empty() || is_stable_id(&target.conv))
            && seen.insert(target.token.clone()))
        .collect()
}

fn validated_prompt_updates(updates: Vec<PromptUpdate>, targets: &[PromptTarget]) -> Vec<PromptUpdate> {
    let allowed: std::collections::HashMap<_, _> = targets.iter()
        .map(|target| (target.token.as_str(), (target.id.as_str(), target.conv.as_str())))
        .collect();
    let mut seen = HashSet::new();
    let mut safe: Vec<_> = updates.into_iter().take(8192).filter(|update|
        allowed.get(update.token.as_str()) == Some(&(update.id.as_str(), update.conv.as_str()))
            && !update.prompt.trim().is_empty() && seen.insert(update.token.clone())
    ).collect();
    for update in &mut safe { truncate_on_char_boundary(&mut update.prompt, 100_000); }
    // Go disables HTML escaping but still escapes the two JavaScript separators.
    // Charge the same bytes here so an optional repair cannot reject start.
    let over_budget = serde_json::to_string(&safe).map_or(true, |encoded| {
        let separators = encoded.matches('\u{2028}').count() + encoded.matches('\u{2029}').count();
        encoded.len() + separators * 3 > 4 * 1024 * 1024
    });
    if over_budget {
        safe.clear();
    }
    safe
}

#[allow(clippy::too_many_arguments)]
pub(super) fn run<R: Runtime>(
    view: Webview<R>,
    root: PathBuf,
    user: String,
    status: StatusCallback,
    control: Arc<RunControl>,
    capture: DownloadCapture,
    native_id: u64,
    session: crate::backend::BackendSession,
    retry: Option<crate::download::DownloadRetry>,
) -> DownloadRunResult {
    let execute = || -> Result<DownloadRunResult, String> {
        let client = Client::new(session.clone())?;
        verify_user(&view, &control, &user)?;
        let reserve_payload = if let Some(request) = retry.as_ref() {
            json!({"root": root, "retryOf": request.history_id, "retryAssetIds": request.asset_ids})
        } else {
            json!({"root": root})
        };
        let reservation = client.json("reserve", Some(&reserve_payload))?;
        let id = reservation["runId"]
            .as_u64()
            .filter(|id| *id > 0)
            .ok_or("Go 下载没有返回任务编号。")?;
        let _lease = RunLease {
            client: &client,
            id,
        };
        // The stop watcher is needed while WebView2 prepares a blob or uploads it.
        // It is joined before this worker returns, never detached from its owner.
        let done = AtomicBool::new(false);
        thread::scope(|scope| {
            let watcher = scope.spawn(|| {
                while !done.load(Ordering::Acquire) {
                    if cancelled(&control) {
                        let _ = client.json("stop", Some(&json!({"runId": id})));
                        break;
                    }
                    thread::sleep(Duration::from_millis(100));
                }
            });
            let stop_watcher = StopWatcher(&done);
            let result = (|| {
                // Optional local metadata identities are scoped by Go to this
                // reserved run/root/account. Failure never expands the asset list.
                let targets = client.json("prompt-targets", Some(&json!({
                    "runId": id, "root": root, "userId": user
                }))).map(decode_prompt_targets).unwrap_or_default();
                verify_user(&view, &control, &user)?;
                status(format!("run {native_id} 正在读取 Grok 图库列表"));
                let fetched = windows_runtime::fetch_library_with_prompt_targets(
                    &view,
                    &control.cancel,
                    &control.navigation,
                    &status,
                    &targets,
                )
                .map_err(|e| e.message)?;
                let library = fetched.library.validate()?;
                let prompt_updates = validated_prompt_updates(fetched.prompt_updates, &targets);
                verify_user(&view, &control, &user)?;
                client.json("start", Some(&json!({"runId":id,"userId":user,"manifest":{
                    "complete":true,"assets":library.assets,"conversations":library.conversations,
                    "promptUpdates":prompt_updates}})))?;
                let mut handled = HashSet::new();
                let mut authorized = false;
                let mut last_line = String::new();
                loop {
                    let state = match client.json("status", None) {
                        Ok(state) => state,
                        Err(_) if cancelled(&control) => {
                            return Ok(DownloadRunResult::coded(
                                "stop_pending",
                                "尚未确认 Go 下载任务已停止。",
                            ))
                        }
                        Err(e) => return Err(e),
                    };
                    if state["runId"].as_u64() != Some(id) {
                        return Err("Go 下载任务身份已改变。".into());
                    }
                    if let Some(line) = state["statusLine"].as_str().filter(|s| !s.is_empty()) {
                        if line != last_line {
                            last_line = line.to_owned();
                            // The legacy gallery follows the shell run id, not the sidecar counter.
                            let text = line.strip_prefix(&format!("run {id} ")).unwrap_or(line);
                            status(format!("run {native_id} {text}"));
                        }
                    }
                    if state["result"].is_object() {
                        return decode_result(&state["result"]);
                    }
                    if cancelled(&control) {
                        // The sidecar may have published immediately before stop.
                        // Keep polling its terminal state instead of inventing an
                        // unpublished result from the local cancellation flag.
                        thread::sleep(Duration::from_millis(100));
                        continue;
                    }
                    if state["phase"].as_str() == Some("verify_account") && !authorized {
                        verify_user(&view, &control, &user)?;
                        client.json("authorize", Some(&json!({"runId":id,"userId":user})))?;
                        authorized = true;
                    }
                    if let Some(tickets) = state["tickets"].as_array() {
                        for ticket in tickets {
                            let key = ticket["ticket"]
                                .as_str()
                                .filter(|s| valid_ticket(s))
                                .ok_or("无效的媒体传输票据。")?;
                            if !handled.insert(key.to_owned()) {
                                continue;
                            }
                            let asset: Asset = serde_json::from_value(ticket["asset"].clone())
                                .map_err(|_| "无效的媒体传输请求。")?;
                            if !is_stable_id(&asset.id)
                                || !is_asset_key(&asset.key)
                                || !is_supported_media_mime(&asset.mime)
                            {
                                return Err("媒体传输请求校验失败。".into());
                            }
                            verify_user(&view, &control, &user)?;
                            let timeout = Duration::from_secs(
                                ticket["timeoutSeconds"]
                                    .as_u64()
                                    .unwrap_or(120)
                                    .clamp(120, 600),
                            );
                            if let Err(failure) = transfer_blob(
                                &client, &view, &control, &capture, native_id, key, &asset, &user,
                                timeout,
                            ) {
                                client.json("failure", Some(&json!({"runId":id,"ticket":key,
                                    "code": if cancelled(&control) {"cancelled"} else {failure.code}, "httpStatus":failure.http_status})))?;
                            }
                        }
                    }
                    thread::sleep(Duration::from_millis(200));
                }
            })();
            drop(stop_watcher);
            let _ = watcher.join();
            result
        })
    };
    match execute() {
        Ok(result) => result,
        Err(_) if cancelled(&control) => {
            DownloadRunResult::coded("stop_pending", "尚未确认 Go 下载任务的最终状态。")
        }
        Err(error) => DownloadRunResult::coded("go_bridge_failed", error),
    }
}
fn valid_ticket(value: &str) -> bool {
    value.len() == 32
        && value
            .bytes()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
}

struct Stage {
    dir: PathBuf,
    part: PathBuf,
}
impl Drop for Stage {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.part);
        // Only the exact owned part and empty, newly-created directory are removed.
        let _ = fs::remove_dir(&self.dir);
    }
}
struct CancelReader<'a> {
    file: fs::File,
    control: &'a RunControl,
}
impl Read for CancelReader<'_> {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        if cancelled(self.control) {
            return Err(io::Error::other("download cancelled"));
        }
        self.file.read(buf)
    }
}
#[allow(clippy::too_many_arguments)]
fn transfer_blob<R: Runtime>(
    client: &Client,
    view: &Webview<R>,
    control: &RunControl,
    capture: &DownloadCapture,
    run_id: u64,
    ticket: &str,
    asset: &Asset,
    user: &str,
    timeout: Duration,
) -> Result<(), TransferFailure> {
    let prepared = windows_runtime::prepare_asset(
        view,
        &asset.key,
        &asset.mime,
        &control.cancel,
        &control.navigation,
        false,
    )
    .map_err(TransferFailure::page)?;
    let result = (|| {
        if prepared.size == 0
            || prepared.size > MAX_MEDIA_BYTES
            || asset.sz.is_some_and(|n| n > 0 && n != prepared.size)
        {
            return Err(TransferFailure::new("length_mismatch"));
        }
        let mut bytes = [0_u8; 16];
        getrandom::fill(&mut bytes).map_err(|_| TransferFailure::new("storage_failed"))?;
        let token: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
        let dir = std::env::temp_dir().join(format!("giv-go-transfer-{token}"));
        fs::create_dir(&dir).map_err(|_| TransferFailure::new("storage_failed"))?;
        let dir = dir
            .canonicalize()
            .map_err(|_| TransferFailure::new("storage_failed"))?;
        let final_path = dir.join(format!("{}{}", asset.id, layout::extension(asset)));
        let stage = Stage {
            part: dir.join(format!(
                "{}.giv-{token}.part",
                final_path.file_name().unwrap().to_string_lossy()
            )),
            dir,
        };
        let free =
            fs2::available_space(&stage.dir).map_err(|_| TransferFailure::new("storage_failed"))?;
        if free
            < prepared
                .size
                .saturating_mul(2)
                .saturating_add(MIN_FREE_BYTES)
        {
            return Err(TransferFailure::new("storage_failed"));
        }
        let name = format!("giv-{token}.download");
        let capture_id = capture
            .arm(CaptureRequest {
                run_id,
                exact_blob_url: prepared.url.clone(),
                expected_name: name.clone(),
                expected_size: prepared.size,
                cancel: Arc::clone(&control.cancel),
                part_path: stage.part.clone(),
                final_path,
            })
            .map_err(|_| TransferFailure::new("stage_conflict"))?;
        match windows_runtime::click_asset(
            view,
            &prepared.url,
            &name,
            &control.cancel,
            &control.navigation,
        ) {
            Ok(true) => capture.mark_click_dispatched(capture_id, true),
            _ => {
                capture.mark_click_dispatched(capture_id, false);
                capture.abort(capture_id, CaptureFailure::Failed);
            }
        }
        let completed = capture.wait(capture_id, &control.cancel, timeout, || {
            let _ = windows_runtime::cancel_current(view, capture.guard_key());
        });
        let completed =
            layout::promote_native_stage(completed).map_err(TransferFailure::capture)?;
        let checked = layout::prepare_capture_commit(&stage.dir, completed)
            .map_err(TransferFailure::capture)?;
        if cancelled(control) {
            return Err(TransferFailure::new("cancelled"));
        }
        let probe = windows_runtime::probe_user(view, &control.cancel, &control.navigation);
        if !probe.ok || probe.user_id.as_deref() != Some(user) {
            return Err(TransferFailure::new(if probe.ok {
                "account_mismatch"
            } else {
                "account_unverified"
            }));
        }
        let file = fs::File::open(checked.part_path())
            .map_err(|_| TransferFailure::new("storage_failed"))?;
        let agent = ureq::AgentBuilder::new()
            .redirects(0)
            .try_proxy_from_env(false)
            .timeout_connect(Duration::from_secs(3))
            .timeout_read(timeout)
            .timeout_write(timeout)
            .build();
        let request = client
            .session
            .native_download_request(&agent, "POST", &format!("upload/{ticket}"))
            .map_err(|_| TransferFailure::new("protocol_error"))?
            .set("Content-Type", "application/octet-stream")
            .set("X-Giv-Mime", &asset.mime)
            .set("Content-Length", &prepared.size.to_string())
            .timeout(timeout);
        decode_upload_response(request.send(CancelReader { file, control }))?;
        capture
            .disown_part(run_id, checked.part_path())
            .map_err(|_| TransferFailure::new("stage_conflict"))?;
        Ok(())
    })();
    windows_runtime::revoke_blob(view, &prepared, &control.cancel, &control.navigation);
    result
}
fn decode_result(v: &Value) -> Result<DownloadRunResult, String> {
    if v["resultVersion"].as_u64() != Some(1) {
        return Err("下载结果协议版本无效。".into());
    }
    let history_state = v["historyState"]
        .as_str()
        .filter(|s| {
            matches!(
                *s,
                "persisted" | "pending" | "unavailable" | "not_applicable"
            )
        })
        .ok_or("下载结果缺少历史状态。")?
        .to_owned();
    let warnings = v["warnings"]
        .as_array()
        .ok_or("下载结果缺少警告状态。")?
        .iter()
        .map(|w| {
            w.as_str()
                .filter(|s| *s == "history_persistence_pending")
                .map(str::to_owned)
                .ok_or_else(|| "下载结果警告类别无效。".to_owned())
        })
        .collect::<Result<Vec<_>, _>>()?;
    let boolean = |key: &str| {
        v[key]
            .as_bool()
            .ok_or_else(|| "下载结果缺少状态。".to_string())
    };
    let n = |key: &str| {
        v["counts"][key]
            .as_u64()
            .ok_or_else(|| "下载结果缺少计数。".to_string())
    };
    let mut failures = Vec::new();
    if let Some(rows) = v["failures"].as_array() {
        for row in rows.iter().take(200) {
            let mut f = DownloadFailure::new(
                row["assetId"].as_str().unwrap_or(""),
                row["stage"].as_str().unwrap_or("transfer"),
                row["code"].as_str().unwrap_or("transfer_failed"),
                row["attempt"].as_u64().unwrap_or(1),
            );
            f.message = row["message"]
                .as_str()
                .unwrap_or("媒体传输失败。")
                .chars()
                .take(2048)
                .collect();
            f.retryable = row["retryable"].as_bool().unwrap_or(false);
            f.elapsed_ms = row["elapsedMs"].as_u64().unwrap_or(0);
            f.http_status = row["httpStatus"].as_u64();
            f.expected_bytes = row["expectedBytes"].as_u64();
            f.received_bytes = row["receivedBytes"].as_u64();
            failures.push(f);
        }
    }
    Ok(DownloadRunResult {
        persistence: Box::new(DownloadPersistence {
            result_version: 1,
            history_state,
            warnings,
        }),
        ok: boolean("ok")?,
        stopped: boolean("stopped")?,
        published: boolean("published")?,
        counts: DownloadCounts {
            total: n("total")?,
            attempted: n("attempted")?,
            succeeded: n("succeeded")?,
            failed: n("failed")?,
            skipped: n("skipped")?,
        },
        failures,
        code: v["code"]
            .as_str()
            .filter(|s| !s.is_empty())
            .map(str::to_owned),
        error: v["error"].as_str().map(str::to_owned),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn prompt_repairs_keep_exact_run_targets_and_utf8_limits() {
        let token = "ab".repeat(16);
        let targets = decode_prompt_targets(json!({"targets":[
            {"token":token,"id":"asset-history","conv":""},
            {"token":"invalid","id":"asset-other","conv":"conversation-history"}
        ]}));
        assert_eq!(targets.len(), 1);
        let updates = vec![
            PromptUpdate { token: token.clone(), id: "asset-forged".into(), conv: String::new(), prompt: "wrong ID".into() },
            PromptUpdate { token: token.clone(), id: "asset-history".into(), conv: "conversation-other".into(), prompt: "wrong conversation".into() },
            PromptUpdate { token: token.clone(), id: "asset-history".into(), conv: String::new(), prompt: " \t ".into() },
            PromptUpdate { token: token.clone(), id: "asset-history".into(), conv: String::new(), prompt: "字".repeat(100_000) },
            PromptUpdate { token, id: "asset-history".into(), conv: String::new(), prompt: "duplicate".into() },
        ];
        let safe = validated_prompt_updates(updates, &targets);
        assert_eq!(safe.len(), 1);
        assert!(safe[0].prompt.len() <= 100_000);
        assert!(safe[0].prompt.ends_with('字'));
    }

    #[test]
    fn prompt_repairs_do_not_change_legacy_library_snapshots() {
        let response: PromptLibrary = serde_json::from_value(json!({
            "assets":[],"conversations":[],
            "promptUpdates":[{"token":"ab".repeat(16),"id":"asset-history","conv":"","prompt":"own prompt"}]
        })).unwrap();
        assert_eq!(response.prompt_updates.len(), 1);
        assert_eq!(serde_json::to_value(response.library).unwrap(), json!({"assets":[],"conversations":[]}));
        let old: PromptLibrary = serde_json::from_value(json!({"assets":[],"conversations":[]})).unwrap();
        assert!(old.prompt_updates.is_empty());
    }

    #[test]
    fn prompt_repair_budget_matches_go_separator_escaping_without_html_escaping() {
        let targets: Vec<_> = (0..23).map(|i| PromptTarget {
            token: format!("{i:032x}"), id: format!("asset-history-{i}"), conv: String::new()
        }).collect();
        let updates = |prompt: &str| targets.iter().map(|target| PromptUpdate {
            token: target.token.clone(), id: target.id.clone(), conv: target.conv.clone(), prompt: prompt.into()
        }).collect();
        assert_eq!(validated_prompt_updates(updates(&"<".repeat(100_000)), &targets).len(), 23);
        assert!(validated_prompt_updates(updates(&"\u{2028}".repeat(33_333)), &targets).is_empty());
    }
    #[test]
    fn shared_download_result_contract_reaches_the_shell() {
        let cases: Value = serde_json::from_str(include_str!(
            "../../../tests/fixtures/download-result-v1.json"
        ))
        .unwrap();
        for case in cases.as_array().unwrap() {
            let result = decode_result(&case["result"]);
            assert_eq!(
                result.is_ok(),
                case["valid"].as_bool().unwrap(),
                "{}",
                case["name"]
            );
            if let Ok(result) = result {
                let shell =
                    serde_json::to_value(crate::shell::DownloadResponse::from_run(result)).unwrap();
                for field in [
                    "resultVersion",
                    "historyState",
                    "warnings",
                    "published",
                    "stopped",
                    "counts",
                ] {
                    assert_eq!(
                        shell[field], case["result"][field],
                        "{field}: {}",
                        case["name"]
                    );
                }
            }
        }
    }
    #[test]
    fn native_transfer_failures_keep_finite_categories() {
        for (code, status, expected) in [
            ("network", None, "network_body"),
            ("timeout", None, "blob_capture_timeout"),
            ("rate_limited", Some(429), "http_error"),
            ("server_error", Some(503), "http_error"),
            ("forbidden", Some(403), "forbidden"),
            ("mime", None, "mime_mismatch"),
            ("length-mismatch", None, "length_mismatch"),
            ("primordials", None, "protocol_error"),
            (
                "https://example.invalid/?secret=fixture",
                None,
                "protocol_error",
            ),
        ] {
            let f = windows_runtime::PageFailure {
                code: code.into(),
                message: "untrusted detail".into(),
                retryable: true,
                cancelled: false,
                http_status: status,
                retry_after_seconds: None,
                expected_bytes: None,
                received_bytes: None,
            };
            let result = TransferFailure::page(f);
            assert_eq!(result.code, expected);
            assert_eq!(result.http_status, status);
        }
        for (failure, code) in [
            (CaptureFailure::StartTimedOut, "blob_capture_timeout"),
            (CaptureFailure::SignatureInvalid, "signature_mismatch"),
            (CaptureFailure::Storage, "storage_failed"),
            (CaptureFailure::Uncertain, "commit_uncertain"),
            (
                CaptureFailure::SizeMismatch {
                    expected: 12,
                    received: 11,
                },
                "length_mismatch",
            ),
        ] {
            assert_eq!(TransferFailure::capture(failure).code, code);
        }
    }
    #[test]
    fn upload_response_preserves_validation_and_transport_errors() {
        for (code, expected) in [
            ("signature_mismatch", "signature_mismatch"),
            ("storage_failed", "storage_failed"),
            ("unknown private response", "protocol_error"),
        ] {
            let response = ureq::Response::new(
                422,
                "Rejected",
                &json!({"ok":false,"code":code,"error":"private detail"}).to_string(),
            )
            .unwrap();
            assert_eq!(
                decode_upload_response(Err(ureq::Error::Status(422, response)))
                    .unwrap_err()
                    .code,
                expected
            );
        }
        assert!(decode_upload_response(ureq::Response::new(200, "OK", r#"{"ok":true}"#)).is_ok());
        let timeout: ureq::Error = io::Error::new(io::ErrorKind::TimedOut, "private detail").into();
        assert_eq!(
            decode_upload_response(Err(timeout)).unwrap_err().code,
            "upload_timeout"
        );
        let disconnected: ureq::Error =
            io::Error::new(io::ErrorKind::ConnectionReset, "private detail").into();
        assert_eq!(
            decode_upload_response(Err(disconnected)).unwrap_err().code,
            "network"
        );
    }
    #[test]
    fn tickets_are_strict_native_tokens() {
        assert!(valid_ticket(&"ab".repeat(16)));
        for t in ["", "../x", &"AB".repeat(16), &"a".repeat(31)] {
            assert!(!valid_ticket(t));
        }
    }
    #[test]
    fn results_keep_partial_publication_and_counts() {
        let value = json!({"resultVersion":1,"historyState":"persisted","warnings":[],"ok":false,"stopped":false,"published":true,"counts":{"total":2,"attempted":2,"succeeded":1,"failed":1,"skipped":5},"failures":[{"assetId":"one","code":"network","retryable":true}],"code":""});
        let result = decode_result(&value).unwrap();
        assert!(result.published);
        assert!(!result.ok);
        assert_eq!(result.counts.skipped, 5);
        assert!(result.failures[0].retryable);
        assert!(decode_result(&json!({"ok":true})).is_err());
    }
}
