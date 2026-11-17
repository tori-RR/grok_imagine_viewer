use super::*;
use super::primordials::fixed_expression;
use serde_json::{json, Value};
use std::path::Path;
use std::{
    cell::RefCell,
    collections::HashMap,
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc,
    },
    thread,
    time::{Duration, Instant},
};
use webview2_com::{
    take_pwstr, BytesReceivedChangedEventHandler, CallDevToolsProtocolMethodCompletedHandler,
    DownloadStartingEventHandler, PermissionRequestedEventHandler, StateChangedEventHandler,
    Microsoft::Web::WebView2::Win32::{
        ICoreWebView2DownloadOperation, ICoreWebView2_4,
        COREWEBVIEW2_DOWNLOAD_INTERRUPT_REASON, COREWEBVIEW2_DOWNLOAD_STATE,
        COREWEBVIEW2_DOWNLOAD_STATE_COMPLETED, COREWEBVIEW2_DOWNLOAD_STATE_INTERRUPTED,
        COREWEBVIEW2_PERMISSION_KIND, COREWEBVIEW2_PERMISSION_STATE,
        COREWEBVIEW2_PERMISSION_STATE_ALLOW,
    },
};
use windows::core::{Interface, HSTRING, PWSTR};

thread_local! {
    static ACTIVE_DOWNLOADS: RefCell<HashMap<u64, (String, ICoreWebView2DownloadOperation)>> =
        RefCell::new(HashMap::new());
}

pub(super) fn cancel_current<R: Runtime>(
    webview: &Webview<R>,
    guard_key: u64,
) -> Result<(), String> {
    let (sender, receiver) = mpsc::sync_channel(1);
    webview
        .with_webview(move |_| {
            let cancelled = ACTIVE_DOWNLOADS.with(|downloads| {
                downloads
                    .borrow()
                    .get(&guard_key)
                    .map_or(true, |(_, operation)| unsafe { operation.Cancel() }.is_ok())
            });
            let _ = sender.send(cancelled);
        })
        .map_err(|_| "Could not dispatch WebView2 download cancellation.".to_string())?;
    match receiver.recv_timeout(Duration::from_secs(5)) {
        Ok(true) => Ok(()),
        _ => Err("WebView2 download cancellation did not complete.".into()),
    }
}
pub(super) fn current_interrupt_reason<R: Runtime>(webview: &Webview<R>, guard_key: u64, blob_url: &str) -> Option<u32> {
    use webview2_com::Microsoft::Web::WebView2::Win32::{COREWEBVIEW2_DOWNLOAD_INTERRUPT_REASON, COREWEBVIEW2_DOWNLOAD_STATE, COREWEBVIEW2_DOWNLOAD_STATE_INTERRUPTED};
    let expected = blob_url.to_owned();
    let (sender, receiver) = mpsc::sync_channel(1);
    webview.with_webview(move |_| {
        let reason = ACTIVE_DOWNLOADS.with(|downloads| {
            let downloads = downloads.borrow();
            let (uri, operation) = downloads.get(&guard_key)?;
            if uri != &expected { return None; }
            let mut state = COREWEBVIEW2_DOWNLOAD_STATE(0);
            unsafe { operation.State(&mut state).ok()?; }
            if state != COREWEBVIEW2_DOWNLOAD_STATE_INTERRUPTED { return None; }
            let mut reason = COREWEBVIEW2_DOWNLOAD_INTERRUPT_REASON(0);
            unsafe { operation.InterruptReason(&mut reason).ok()?; }
            u32::try_from(reason.0).ok()
        });
        let _ = sender.send(reason);
    }).ok()?;
    receiver.recv_timeout(Duration::from_secs(3)).ok().flatten()
}

fn apply_native_download_state(
    capture: &DownloadCapture,
    uri: &str,
    operation: &ICoreWebView2DownloadOperation,
    guard_key: u64,
) -> windows::core::Result<()> {
    let mut state = COREWEBVIEW2_DOWNLOAD_STATE(0);
    unsafe { operation.State(&mut state)? };
    if state == COREWEBVIEW2_DOWNLOAD_STATE_COMPLETED {
        capture.native_on_finished(uri, true, None, state.0);
        ACTIVE_DOWNLOADS.with(|downloads| {
            downloads.borrow_mut().remove(&guard_key);
        });
    } else if state == COREWEBVIEW2_DOWNLOAD_STATE_INTERRUPTED {
        let mut reason = COREWEBVIEW2_DOWNLOAD_INTERRUPT_REASON(0);
        unsafe { operation.InterruptReason(&mut reason)? };
        capture.native_on_finished(uri, false, u32::try_from(reason.0).ok(), state.0);
        ACTIVE_DOWNLOADS.with(|downloads| {
            downloads.borrow_mut().remove(&guard_key);
        });
    } else {
        capture.native_note_state(state.0);
    }
    Ok(())
}

pub(super) fn install_download_guard<R: Runtime>(
    webview: &Webview<R>,
    capture: DownloadCapture,
    download_state: DownloadState,
) -> Result<(), String> {
    let (sender, receiver) = mpsc::sync_channel(1);
    let guard_key = capture.guard_key();
    webview
        .with_webview(move |platform| {
            let result = (|| -> windows::core::Result<()> {
                let controller = platform.controller();
                let core = unsafe { controller.CoreWebView2()? };
                let core4: ICoreWebView2_4 = core.cast()?;
                let permission_capture = capture.clone();
                let permission_state = download_state;
                let permission = PermissionRequestedEventHandler::create(Box::new(move |_, args| {
                    let Some(args) = args else {
                        return Ok(());
                    };
                    let mut raw_uri = PWSTR::null();
                    unsafe { args.Uri(&mut raw_uri)? };
                    let uri = take_pwstr(raw_uri);
                    let mut kind = COREWEBVIEW2_PERMISSION_KIND(0);
                    unsafe { args.PermissionKind(&mut kind)? };
                    let mut state = COREWEBVIEW2_PERMISSION_STATE(0);
                    unsafe { args.State(&mut state)? };
                    let grok_origin = is_strict_grok_https_origin(&uri);
                    let during_run = permission_state.is_busy();
                    let allowed = decide_automatic_download_permission(
                        kind.0,
                        grok_origin,
                        during_run,
                    );
                    permission_capture.record_permission(PermissionNote {
                        kind: kind.0,
                        host: permission_host_label(&uri).to_owned(),
                        state: state.0,
                        during_run,
                        allowed,
                    });
                    if allowed {
                        unsafe { args.SetState(COREWEBVIEW2_PERMISSION_STATE_ALLOW)? };
                    }
                    Ok(())
                }));
                let mut permission_token = 0_i64;
                unsafe { core.add_PermissionRequested(&permission, &mut permission_token)? };

                let handler_capture = capture;
                let handler = DownloadStartingEventHandler::create(Box::new(move |_, args| {
                    let Some(args) = args else {
                        return Ok(());
                    };
                    let operation = unsafe { args.DownloadOperation()? };
                    let mut raw_uri = PWSTR::null();
                    unsafe { operation.Uri(&mut raw_uri)? };
                    let uri = take_pwstr(raw_uri);
                    if handler_capture.native_should_cancel(&uri) {
                        let _ = unsafe { operation.Cancel() };
                        return Ok(());
                    }
                    let mut raw_suggested = PWSTR::null();
                    unsafe { args.ResultFilePath(&mut raw_suggested)? };
                    let suggested = take_pwstr(raw_suggested);
                    let suggested_name = Path::new(&suggested)
                        .file_name()
                        .and_then(|name| name.to_str())
                        .map(str::to_owned);
                    match handler_capture
                        .native_on_starting(&uri, suggested_name.as_deref())
                    {
                        NativeStart::Reject => {
                            let _ = unsafe { operation.Cancel() };
                            return Ok(());
                        }
                        NativeStart::Accept(part_path) => {
                            let path = HSTRING::from(part_path.to_string_lossy().as_ref());
                            unsafe { args.SetResultFilePath(&path)? };
                            unsafe { args.SetHandled(true)? };
                        }
                    }
                    ACTIVE_DOWNLOADS.with(|downloads| {
                        downloads
                            .borrow_mut()
                            .insert(guard_key, (uri.clone(), operation.clone()));
                    });
                    let progress_capture = handler_capture.clone();
                    let progress_uri = uri.clone();
                    let progress =
                        BytesReceivedChangedEventHandler::create(Box::new(move |operation, _| {
                            if let Some(operation) = operation {
                                if progress_capture.native_should_cancel(&progress_uri) {
                                    let _ = unsafe { operation.Cancel() };
                                }
                            }
                            Ok(())
                        }));
                    let mut progress_token = 0_i64;
                    unsafe { operation.add_BytesReceivedChanged(&progress, &mut progress_token)? };
                    let state_capture = handler_capture.clone();
                    let state_uri = uri.clone();
                    let state_changed = StateChangedEventHandler::create(Box::new(move |operation, _| {
                        let Some(operation) = operation else {
                            return Ok(());
                        };
                        apply_native_download_state(&state_capture, &state_uri, &operation, guard_key)
                    }));
                    let mut state_token = 0_i64;
                    unsafe { operation.add_StateChanged(&state_changed, &mut state_token)? };
                    // A memory-backed blob can finish before the handler is
                    // attached. Read the current state so Completed is not lost.
                    apply_native_download_state(&handler_capture, &uri, &operation, guard_key)?;
                    if handler_capture.native_should_cancel(&uri) {
                        let _ = unsafe { operation.Cancel() };
                    }
                    Ok(())
                }));
                let mut token = 0_i64;
                unsafe { core4.add_DownloadStarting(&handler, &mut token) }
            })();
            let _ = sender.send(result.is_ok());
        })
        .map_err(|_| "无法安装 WebView2 下载取消护栏。".to_string())?;
    match receiver.recv_timeout(Duration::from_secs(5)) {
        Ok(true) => Ok(()),
        _ => Err("无法安装 WebView2 下载取消护栏。".into()),
    }
}
const USER_PROBE: &str = r#"(async (_input, p) => {
  if (!p
      || p.brand !== "giv-native-primordials-v1"
      || typeof p.validate !== "function"
      || p.validate(p) !== true) {
    return { ok: false, code: "primordials" };
  }
  let worst = "";
  let worstRank = -1;
  let worstStatus = null;
  const rank = (code) => {
    if (code === "forbidden" || code === "rate_limited") return 5;
    if (code === "server_error") return 4;
    if (code === "network") return 3;
    if (code === "schema_error") return 2;
    if (code === "http_error") return 1;
    return 0;
  };
  const note = (code, status) => {
    const value = rank(code);
    if (value > worstRank) {
      worstRank = value;
      worst = code;
      worstStatus = typeof status === "number" ? status : null;
    }
  };
  const classify = (status) => {
    if (status === 401) return "not_logged_in";
    if (status === 403) return "forbidden";
    if (status === 429) return "rate_limited";
    if (status >= 500) return "server_error";
    return "http_error";
  };
  const read = async (url) => {
    try {
      const response = await p.fetch(url, {
        credentials: "include",
        headers: { accept: "application/json" }
      });
      const status = p.responseStatus(response);
      if (!p.responseOk(response)) {
        note(classify(status), status);
        return null;
      }
      const contentType = p.header(p.responseHeaders(response), "content-type") || "";
      if (!p.stringIncludes(contentType, "json")) {
        note("schema_error", status);
        return null;
      }
      return await p.responseJson(response);
    } catch (_) {
      note("network", null);
      return null;
    }
  };
  const pick = (value) => {
    if (!value || typeof value !== "object") return "";
    const flat = value.user && typeof value.user === "object" ? value.user : value;
    const keys = ["userId", "id", "sub"];
    for (let index = 0; index < keys.length; index += 1) {
      const key = keys[index];
      const id = flat[key];
      if (typeof id === "string" && id.length >= 6 && id.length <= 200) return id;
    }
    return "";
  };
  const endpoints = ["/rest/auth/get-user", "/api/auth/session", "/rest/user", "/rest/me"];
  for (let index = 0; index < endpoints.length; index += 1) {
    const userId = pick(await read(endpoints[index]));
    if (userId) return { ok: true, userId };
  }
  return { ok: false, code: worst || "not_logged_in", status: worstStatus };
})"#;

const LIST_SCRIPT: &str = r#"(async (input, p) => {
  if (!p
      || p.brand !== "giv-native-primordials-v1"
      || typeof p.validate !== "function"
      || p.validate(p) !== true) {
    return { ok: false, code: "primordials" };
  }
  if (!input || !p.regexpTest(/^[0-9a-f]{32}$/, input.opToken || "")) {
    return { ok: false, code: "input" };
  }
  const entry = p.beginOperation(input.opToken);
  entry.assetHave = 0;
  entry.assetTotal = 0;
  const signal = p.abortSignal(entry.controller);
  let optionalTimer = 0;
  let optionalStopped = false;
  let optionalSequence = 0;
  const sleep = (ms) => p.makePromise((resolve, reject) => {
    let timer = 0;
    const aborted = () => {
      p.clearTimer(timer);
      reject(p.makeAbortError());
    };
    if (p.signalAborted(signal)) return aborted();
    timer = p.setTimer(() => {
      p.signalRemove(signal, "abort", aborted);
      resolve();
    }, ms);
    p.signalAdd(signal, "abort", aborted, { once: true });
  });
  const classify = (status) => {
    if (status === 401) return "not_logged_in";
    if (status === 403) return "forbidden";
    if (status === 429) return "rate_limited";
    if (status >= 500) return "server_error";
    return "http_error";
  };
  const request = async (url, attempts = 9, requestSignal = signal, body = null) => {
    for (let attempt = 0; attempt < attempts; attempt++) {
      try {
        const options = {
          credentials: "include",
          headers: { accept: "application/json" },
          signal: requestSignal
        };
        if (body !== null) {
          options.method = "POST";
          options.headers["content-type"] = "application/json";
          options.body = p.jsonStringify(body);
        }
        const response = await p.fetch(url, options);
        const status = p.responseStatus(response);
        if (status === 429) {
          if (attempt + 1 >= attempts) return { ok: false, code: "rate_limited" };
          await sleep(p.min(20000, 800 * (2 ** (attempt + 1))));
          continue;
        }
        if (!p.responseOk(response)) {
          return { ok: false, code: classify(status), status };
        }
        const contentType = p.header(p.responseHeaders(response), "content-type") || "";
        if (!p.stringIncludes(contentType, "json")) {
          return { ok: false, code: "schema_error", status };
        }
        return { ok: true, data: await p.responseJson(response) };
      } catch (_) {
        return { ok: false, code: p.signalAborted(signal) ? "cancelled" : "network" };
      }
    }
    return { ok: false, code: "rate_limited" };
  };
  const text = (value, max) =>
    typeof value === "string" ? p.stringSlice(value, 0, max) : "";
  const compactAsset = (asset) => {
    const mediaInput = asset && asset.mediaGenInput !== null
      && typeof asset.mediaGenInput === "object" && !p.arrayIsArray(asset.mediaGenInput)
      ? asset.mediaGenInput
      : {};
    let kind = "";
    let prompt = "";
    let parent = "";
    let quality = "";
    let variantOf = "";
    const take = (block, nextKind, asVariant) => {
      if (!block || typeof block !== "object") return;
      if (!kind && nextKind) kind = nextKind;
      if (!prompt) prompt = text(block.prompt, 100000);
      const inputs = block.inputAssets;
      const input = text(p.arrayIsArray(inputs) ? inputs[0] : "", 200);
      if (asVariant) {
        if (!variantOf && input) variantOf = input;
      } else if (!parent && input) {
        parent = input;
      }
      if (!quality) quality = text(block.quality || block.resolution || block.videoQuality || block.resolutionName || "", 40);
    };
    take(mediaInput.imageToVideo, "i2v", false);
    take(mediaInput.imageToImage, "i2i", false);
    take(mediaInput.textToImage, "t2i", false);
    take(mediaInput.textToVideo, "t2v", false);
    take(mediaInput.videoToVideo, "v2v", true);
    take(mediaInput.videoEnhance, "hd", true);
    take(mediaInput.enhance, "hd", true);
    take(mediaInput.upscale, "hd", true);
    take(mediaInput.videoUpscale, "hd", true);
    quality = quality || text((asset && (asset.quality || asset.resolution)) || "", 40);
    variantOf = variantOf || text((asset && (asset.originalAssetId || asset.sourceVideoId || asset.hdOf)) || "", 200);
    const id = text(asset && asset.assetId, 200);
    if (variantOf && variantOf === id) variantOf = "";
    return {
      id,
      mime: text(asset && asset.mimeType, 100),
      sz: p.numberIsSafeInteger(asset && asset.sizeBytes) && asset.sizeBytes >= 0
        ? asset.sizeBytes
        : null,
      t: text(asset && asset.createTime, 100),
      key: text(asset && asset.key, 1024),
      src: text(asset && asset.fileSource, 100),
      conv: text(asset && asset.sourceConversationId, 200),
      rootConv: text(asset && asset.rootAssetSourceConversationId, 200),
      kind,
      prompt,
      parent: parent || null,
      quality,
      variantOf: variantOf || null,
      // These are optional hints, not required schema. Native code accepts
      // only a concrete HTTPS Grok post URL and strips any query/fragment.
      remoteUrl: text(asset && (asset.postUrl || asset.shareUrl), 2048)
    };
  };
  // A page is only "the last page" when the server stops handing out a cursor.
  // A missing or wrongly typed collection is a schema error, never an empty
  // library: an empty index published over a real one loses the gallery.
  const collect = async (buildUrl, field, map, trackAssets) => {
    const rows = [];
    const seenTokens = [];
    let token = "";
    for (let page = 0; page < 200; page += 1) {
      const batch = await request(p.urlToString(buildUrl(token)));
      if (!batch.ok) return { ok: false, code: batch.code, status: batch.status };
      const data = batch.data;
      if (!data || typeof data !== "object" || p.arrayIsArray(data)) {
        return { ok: false, code: "schema_error" };
      }
      const list = data[field];
      if (!p.arrayIsArray(list)) return { ok: false, code: "schema_error" };
      for (let index = 0; index < list.length; index += 1) {
        p.arrayPush(rows, map(list[index]));
      }
      if (trackAssets) {
        if (!entry.assetTotal) {
          const rawTotal = data.totalCount;
          const altTotal = data.totalSize;
          const chosen = p.numberIsSafeInteger(rawTotal) && rawTotal > 0 && rawTotal <= 2000000
            ? rawTotal
            : (p.numberIsSafeInteger(altTotal) && altTotal > 0 && altTotal <= 2000000 ? altTotal : 0);
          if (chosen > 0) entry.assetTotal = chosen;
        }
        entry.assetHave = rows.length;
      }
      const next = text(data.nextPageToken, 4096);
      if (!next) return { ok: true, rows };
      if (list.length === 0) return { ok: false, code: "incomplete_manifest" };
      for (let index = 0; index < seenTokens.length; index += 1) {
        if (seenTokens[index] === next) {
          return { ok: false, code: "incomplete_manifest" };
        }
      }
      p.arrayPush(seenTokens, next);
      token = next;
      await sleep(20);
    }
    return { ok: false, code: "incomplete_manifest" };
  };
  // /rest/assets may omit mediaGenInput. Keep its response identity only in
  // this operation: the compact manifest schema and media identity stay intact.
  const promptGroups = [];
  const promptGroupsById = { __proto__: null };
  const currentAssets = { __proto__: null };
  const currentAssetsById = { __proto__: null };
  const historical = [];
  const stableId = (value) => typeof value === "string"
    && p.regexpTest(/^[A-Za-z0-9._-]{6,200}$/, value)
    && !p.stringIncludes(value, "..");
  const promptGroup = (id) => {
    let group = promptGroupsById[id];
    if (!group) {
      group = { id, required: false, targets: { __proto__: null }, historical: { __proto__: null } };
      promptGroupsById[id] = group;
      p.arrayPush(promptGroups, group);
    }
    return group;
  };
  const compactForDownload = (asset) => {
    const compact = compactAsset(asset);
    if (stableId(compact.id)) {
      currentAssets[compact.id + "/" + compact.conv] = compact;
      currentAssetsById[compact.id] = compact;
    }
    if (!p.stringTrim(compact.prompt) && stableId(asset && asset.assetId)
      && stableId(asset.responseId) && stableId(asset.sourceConversationId)) {
      const group = promptGroup(asset.sourceConversationId);
      group.required = true;
      const key = asset.assetId + "/" + asset.responseId;
      let target = group.targets[key];
      if (!target) {
        target = { assets: [], signature: "" };
        group.targets[key] = target;
      }
      p.arrayPush(target.assets, compact);
    }
    return compact;
  };
  const optionalRequest = async (url, body = null) => {
    if (optionalStopped || p.signalAborted(signal)) {
      return { ok: false, code: p.signalAborted(signal) ? "cancelled" : "optional_budget" };
    }
    if (!optionalTimer) optionalTimer = p.setTimer(() => { optionalStopped = true; }, 60000);
    const key = input.opToken + "-optional-" + (optionalSequence += 1);
    const local = p.beginOperation(key);
    const localSignal = p.abortSignal(local.controller);
    const abort = () => p.abortController(local.controller);
    p.signalAdd(signal, "abort", abort, { once: true });
    const timer = p.setTimer(abort, 5000);
    try {
      if (p.signalAborted(signal)) abort();
      // Optional history never retries access denial or rate limiting. It has
      // a short independent deadline without cancelling the normal manifest.
      const result = await request(url, 1, localSignal, body);
      if (result.status === 401 || result.status === 403 || result.code === "rate_limited") {
        optionalStopped = true;
      }
      return result;
    } finally {
      p.clearTimer(timer);
      p.signalRemove(signal, "abort", abort);
      p.deleteOperation(key);
    }
  };
  const prepareHistorical = () => {
    const targets = p.arrayIsArray(input.promptTargets) ? input.promptTargets : [];
    const tokens = { __proto__: null };
    const conversations = { __proto__: null };
    let conversationCount = 0;
    for (let index = 0; index < p.min(8192, targets.length); index += 1) {
      const target = targets[index];
      if (!target || !p.regexpTest(/^[0-9a-f]{32}$/, target.token || "")
        || tokens[target.token] || !stableId(target.id)
        || (target.conv !== "" && !stableId(target.conv))) continue;
      tokens[target.token] = true;
      const item = { token: target.token, id: target.id, conv: target.conv, prompt: "", ambiguous: false };
      p.arrayPush(historical, item);
      const current = item.conv ? currentAssets[item.id + "/" + item.conv] : currentAssetsById[item.id];
      if (current && p.stringTrim(current.prompt)) {
        item.prompt = current.prompt;
        continue;
      }
      if (!item.conv) continue;
      const existing = promptGroupsById[item.conv];
      if (!(existing && existing.required) && !conversations[item.conv]) {
        if (conversationCount >= 1024) continue;
        conversations[item.conv] = true;
        conversationCount += 1;
      }
      const group = promptGroup(item.conv);
      if (!group.historical[item.id]) group.historical[item.id] = [];
      p.arrayPush(group.historical[item.id], item);
    }
  };
  const enrichPromptGroup = async (group) => {
    if (p.signalAborted(signal)) return { ok: false, code: "cancelled" };
    const url = p.makeURL("https://grok.com/rest/app-chat/conversations/"
      + p.encodeURIComponent(group.id) + "/responses");
    p.setURLSearchParam(url, "conversationKind", "CONVERSATION_KIND_IMAGINE");
    const batch = group.required ? await request(p.urlToString(url)) : await optionalRequest(p.urlToString(url));
    // Old deleted conversations need not prevent the remaining library from
    // downloading. Never replace their absent metadata with another prompt.
    if (!batch.ok) return batch.status === 404 || batch.status === 410
      ? { ok: true } : batch;
    const data = batch.data;
    if (!data || typeof data !== "object" || p.arrayIsArray(data)
      || !p.arrayIsArray(data.responses)) return { ok: false, code: "schema_error" };
    if (text(data.nextPageToken, 4096)) return { ok: false, code: "incomplete_manifest" };
    for (let index = 0; index < data.responses.length; index += 1) {
      const response = data.responses[index];
      if (!response || typeof response !== "object" || p.arrayIsArray(response)) {
        return { ok: false, code: "schema_error" };
      }
      const attachments = response.fileAttachmentAssetMetadata;
      if (attachments === undefined || attachments === null) continue;
      if (!p.arrayIsArray(attachments)) return { ok: false, code: "schema_error" };
      for (let item = 0; item < attachments.length; item += 1) {
        const attachment = attachments[item];
        if (!attachment || typeof attachment !== "object" || p.arrayIsArray(attachment)) {
          return { ok: false, code: "schema_error" };
        }
        if (attachment.sourceConversationId !== group.id
          || !stableId(attachment.assetId) || !stableId(attachment.responseId)) continue;
        const target = group.targets[attachment.assetId + "/" + attachment.responseId];
        const old = group.historical[attachment.assetId];
        if (!target && !old) continue;
        // A human message can attach an older image while describing a new
        // edit. Only the attachment's own generation input belongs to that ID;
        // the container responseId/mediaGenInput must never supply its prompt.
        const generated = compactAsset(attachment);
        if (!p.stringTrim(generated.prompt)) continue;
        const signature = p.jsonStringify([
          generated.prompt, generated.kind, generated.parent,
          generated.quality, generated.variantOf
        ]);
        if (target && target.signature && target.signature !== signature) {
          return { ok: false, code: "schema_error" };
        }
        if (target) {
          target.signature = signature;
          for (let member = 0; member < target.assets.length; member += 1) {
            const asset = target.assets[member];
            asset.prompt = generated.prompt;
            asset.kind = generated.kind || asset.kind;
            asset.parent = generated.parent || asset.parent;
            asset.quality = generated.quality || asset.quality;
            asset.variantOf = generated.variantOf || asset.variantOf;
          }
        }
        if (old) {
          for (let member = 0; member < old.length; member += 1) {
            const item = old[member];
            if (item.prompt && item.prompt !== generated.prompt) item.ambiguous = true;
            item.prompt = generated.prompt;
          }
        }
      }
    }
    return { ok: true };
  };
  const enrichPrompts = async () => {
    let next = 0;
    let failure = null;
    const worker = async () => {
      while (!failure && next < promptGroups.length) {
        if (p.signalAborted(signal)) {
          failure = { ok: false, code: "cancelled" };
          return;
        }
        const group = promptGroups[next];
        next += 1;
        const result = await enrichPromptGroup(group);
        if (!result.ok && !group.required && !p.signalAborted(signal)) {
          // Discard partial optional results if a later row was malformed.
          for (let index = 0; index < historical.length; index += 1) {
            if (historical[index].conv === group.id) historical[index].prompt = "";
          }
          continue;
        }
        if (!result.ok && !failure) {
          failure = { ok: false, code: result.code, status: result.status };
          p.abortController(entry.controller);
        }
      }
    };
    const workers = [];
    for (let index = 0; index < p.min(4, promptGroups.length); index += 1) {
      p.arrayPush(workers, worker());
    }
    // Await every worker so no request outlives the operation registry entry.
    for (let index = 0; index < workers.length; index += 1) await workers[index];
    return failure || (p.signalAborted(signal)
      ? { ok: false, code: "cancelled" } : { ok: true });
  };
  const enrichHistoricalPosts = async () => {
    const posts = [];
    const byId = { __proto__: null };
    for (let index = 0; index < historical.length; index += 1) {
      const item = historical[index];
      if (item.prompt || item.ambiguous) continue;
      const current = item.conv ? currentAssets[item.id + "/" + item.conv] : currentAssetsById[item.id];
      if (current && p.stringTrim(current.prompt)) {
        item.prompt = current.prompt;
        continue;
      }
      let post = byId[item.id];
      if (!post) {
        if (posts.length >= 1024) continue;
        post = { id: item.id, targets: [] };
        byId[item.id] = post;
        p.arrayPush(posts, post);
      }
      p.arrayPush(post.targets, item);
    }
    let next = 0;
    const worker = async () => {
      while (!optionalStopped && !p.signalAborted(signal) && next < posts.length) {
        const target = posts[next];
        next += 1;
        const batch = await optionalRequest("https://grok.com/rest/media/post/get", { id: target.id });
        if (!batch.ok) continue;
        const post = batch.data && batch.data.post;
        if (!post || p.arrayIsArray(post) || post.id !== target.id) continue;
        let prompt = text(post.originalPrompt, 100000);
        if (!p.stringTrim(prompt)) prompt = text(post.prompt, 100000);
        if (!p.stringTrim(prompt)) continue;
        // Never borrow childPosts/images/videos prompts or infer visibility.
        for (let index = 0; index < target.targets.length; index += 1) target.targets[index].prompt = prompt;
      }
    };
    const workers = [];
    for (let index = 0; index < p.min(4, posts.length); index += 1) p.arrayPush(workers, worker());
    for (let index = 0; index < workers.length; index += 1) await workers[index];
  };
  const promptUpdates = () => {
    const updates = [];
    let bytes = 2;
    for (let index = 0; index < historical.length; index += 1) {
      const item = historical[index];
      if (!p.stringTrim(item.prompt) || item.ambiguous) continue;
      let prompt = item.prompt;
      // Rust/Go use a 100,000-byte prompt budget. Do not split a surrogate pair
      // while trimming the optional page projection to the same UTF-8 limit.
      if (p.blobSize(p.makeBlob([prompt])) > 100000) {
        let low = 0;
        let high = prompt.length;
        while (low < high) {
          const middle = (low + high + 1) >>> 1;
          if (p.blobSize(p.makeBlob([p.stringSlice(prompt, 0, middle)])) <= 100000) low = middle;
          else high = middle - 1;
        }
        prompt = p.stringSlice(prompt, 0, low);
      }
      if (p.regexpTest(/[\uD800-\uDBFF]$/, prompt)) prompt = p.stringSlice(prompt, 0, prompt.length - 1);
      if (!prompt) continue;
      const update = { token: item.token, id: item.id, conv: item.conv, prompt };
      const size = p.blobSize(p.makeBlob([p.jsonStringify(update)]));
      if (bytes + size + 1 > 4194304) continue;
      bytes += size + 1;
      p.arrayPush(updates, update);
    }
    return updates;
  };
  try {
    // Overlap the two paginated reads. A 5800-item library is ~30 pages at
    // pageSize 200; doing conversations after assets doubled the wait.
    const assetWork = collect(
      (token) => {
        const url = p.makeURL("https://grok.com/rest/assets");
        p.setURLSearchParam(url, "pageSize", "200");
        p.setURLSearchParam(url, "orderBy", "ORDER_BY_CREATE_TIME");
        p.setURLSearchParam(url, "workspaceKind", "WORKSPACE_KIND_IMAGINE_ALL");
        if (token) p.setURLSearchParam(url, "pageToken", token);
        return url;
      },
      "assets",
      compactForDownload,
      true
    );
    const conversationWork = collect(
      (token) => {
        const url = p.makeURL("https://grok.com/rest/app-chat/conversations");
        p.setURLSearchParam(url, "pageSize", "200");
        p.setURLSearchParam(url, "kind", "CONVERSATION_KIND_IMAGINE");
        if (token) p.setURLSearchParam(url, "pageToken", token);
        return url;
      },
      "conversations",
      (row) => ({
        id: text(row && (row.conversationId || row.id), 200),
        title: text(row && row.title, 10000),
        t: text(row && (row.createTime || row.createdAt), 100)
      }),
      false
    );
    const assetPage = await assetWork;
    if (!assetPage.ok) {
      p.abortController(entry.controller);
      return { ok: false, code: assetPage.code, status: assetPage.status };
    }
    const conversationPage = await conversationWork;
    if (!conversationPage.ok) {
      return { ok: false, code: conversationPage.code, status: conversationPage.status };
    }

    prepareHistorical();
    const enriched = await enrichPrompts();
    if (!enriched.ok) return enriched;
    await enrichHistoricalPosts();
    if (p.signalAborted(signal)) return { ok: false, code: "cancelled" };

    const payload = {
      ok: true,
      complete: true,
      assets: assetPage.rows,
      conversations: conversationPage.rows
    };
    const updates = promptUpdates();
    if (updates.length) payload.promptUpdates = updates;
    // The native bridge budgets UTF-8 bytes, not JavaScript UTF-16 code units.
    if (p.blobSize(p.makeBlob([p.jsonStringify(payload)], { type: "application/json" })) > 25165824) {
      // Optional repairs cannot make an otherwise valid normal manifest fail.
      delete payload.promptUpdates;
      if (p.blobSize(p.makeBlob([p.jsonStringify(payload)])) > 25165824) return { ok: false, code: "payload" };
    }
    return payload;
  } finally {
    if (optionalTimer) p.clearTimer(optionalTimer);
    p.deleteOperation(input.opToken);
  }
})"#;

const LIST_PROGRESS_SCRIPT: &str = r#"((input, p) => {
  if (!p
      || p.brand !== "giv-native-primordials-v1"
      || typeof p.validate !== "function"
      || p.validate(p) !== true) {
    return { ok: false };
  }
  if (!input || !p.regexpTest(/^[0-9a-f]{32}$/, input.opToken || "")) {
    return { ok: false };
  }
  const entry = p.getOperation(input.opToken);
  if (!entry) return { ok: false };
  const have = p.numberIsSafeInteger(entry.assetHave) ? entry.assetHave : 0;
  const total = p.numberIsSafeInteger(entry.assetTotal) ? entry.assetTotal : 0;
  return { ok: true, have, total };
})"#;

const PREPARE_SCRIPT: &str = r#"(async (input, p) => {
  if (!p
      || p.brand !== "giv-native-primordials-v1"
      || typeof p.validate !== "function"
      || p.validate(p) !== true) {
    return { ok: false, code: "primordials" };
  }
  const keyParts = typeof input.key === "string" ? p.stringSplit(input.key, "/") : [];
  let validParts = keyParts.length > 0;
  for (let index = 0; index < keyParts.length; index += 1) {
    const part = keyParts[index];
    if (!part
        || part === "."
        || part === ".."
        || !p.regexpTest(/^[A-Za-z0-9._~-]+$/, part)) {
      validParts = false;
      break;
    }
  }
  const validKey = typeof input.key === "string"
    && input.key.length > 0
    && input.key.length <= 1024
    && !p.stringStartsWith(input.key, "/")
    && !p.stringEndsWith(input.key, "/")
    && !p.regexpTest(/[\\?#]/, input.key)
    && validParts;
  const validMime = typeof input.mime === "string"
    && p.regexpTest(/^(image\/(jpeg|png|webp)|video\/[A-Za-z0-9.+-]+)$/, input.mime);
  const validToken = p.regexpTest(/^[0-9a-f]{32}$/, input.opToken || "");
  const validMaxBytes = p.numberIsSafeInteger(input.maxBytes) && input.maxBytes > 0;
  if (!validKey || !validMime || !validToken || !validMaxBytes) {
    return { ok: false, code: "input" };
  }
  const maxBytes = input.maxBytes;

  const entry = p.beginOperation(input.opToken);
  const signal = p.abortSignal(entry.controller);
  try {
    const encodedParts = [];
    for (let index = 0; index < keyParts.length; index += 1) {
      p.arrayPush(encodedParts, p.encodeURIComponent(keyParts[index]));
    }
    const url = p.makeURL("https://assets.grok.com/");
    p.setURLPathname(url, "/" + p.arrayJoin(encodedParts, "/"));
    p.setURLSearchParam(url, "cache", "1");
    const response = await p.fetch(p.urlToString(url), {
      credentials: "include",
      headers: { accept: "*/*" },
      signal
    });
    if (!p.responseOk(response)) {
      const retryHeader = p.header(p.responseHeaders(response), "retry-after") || "";
      const retrySeconds = p.regexpTest(/^[0-9]{1,6}$/, retryHeader) ? p.toNumber(retryHeader) : null;
      return { ok: false, code: "http", status: p.responseStatus(response), retryAfterSeconds: retrySeconds };
    }
    const finalUrl = p.makeURL(p.responseUrl(response));
    const finalHostname = p.urlHostname(finalUrl);
    if (p.urlProtocol(finalUrl) !== "https:"
        || (finalHostname !== "assets.grok.com"
          && finalHostname !== "imagine-public.x.ai")) {
      return { ok: false, code: "redirect" };
    }
    const rawContentType = p.header(p.responseHeaders(response), "content-type") || "";
    const contentTypeParts = p.stringSplit(rawContentType, ";");
    const contentType = p.stringToLowerCase(p.stringTrim(contentTypeParts[0] || ""));
    const sameFamily =
      (p.stringStartsWith(input.mime, "image/")
        && p.stringStartsWith(contentType, "image/"))
      || (p.stringStartsWith(input.mime, "video/")
        && p.stringStartsWith(contentType, "video/"));
    if (!sameFamily) return { ok: false, code: "mime" };
    const acceptRaw = p.header(p.responseHeaders(response), "accept-ranges") || "";
    const acceptRanges = p.stringIncludes(p.stringToLowerCase(acceptRaw), "bytes");
    let probeOmitStatus = null;
    let probeOmitBytes = 0;
    if (input.probeDetached === true) {
      try {
        const detached = await p.fetch(p.responseUrl(response), {
          credentials: "omit",
          headers: { accept: "*/*", range: "bytes=0-1023" },
          signal
        });
        const detachedUrl = p.makeURL(p.responseUrl(detached));
        const detachedHost = p.urlHostname(detachedUrl);
        if (p.urlProtocol(detachedUrl) === "https:"
            && (detachedHost === "assets.grok.com" || detachedHost === "imagine-public.x.ai")) {
          probeOmitStatus = p.responseStatus(detached);
          const detachedBody = p.responseBody(detached);
          if (detachedBody) {
            const detachedReader = p.streamReader(detachedBody);
            let got = 0;
            while (got < 2048) {
              const item = await p.readerRead(detachedReader);
              if (item.done) break;
              if (!p.isUint8Array(item.value)) break;
              got += p.uint8ByteLength(item.value);
            }
            try { await p.readerCancel(detachedReader, "probe"); } catch (_) {}
            probeOmitBytes = got;
          }
        }
      } catch (_) {}
    }
    const body = p.responseBody(response);
    if (!body) {
      try { p.abortController(entry.controller); } catch (_) {}
      return { ok: false, code: "body" };
    }
    const reader = p.streamReader(body);
    let declaredLength = null;
    let received = 0;
    const stopReading = async (code) => {
      try { await p.readerCancel(reader, code); } catch (_) {}
      try { p.abortController(entry.controller); } catch (_) {}
      return { ok: false, code, expectedBytes: declaredLength, receivedBytes: received };
    };
    const rawLength = p.header(p.responseHeaders(response), "content-length");
    if (rawLength !== null) {
      if (!p.regexpTest(/^[0-9]+$/, rawLength)) return await stopReading("length");
      declaredLength = p.toNumber(rawLength);
      if (!p.numberIsSafeInteger(declaredLength)
          || declaredLength <= 0
          || declaredLength > maxBytes) {
        return await stopReading("length");
      }
    }
    const chunks = [];
    while (true) {
      if (p.signalAborted(signal)) return await stopReading("cancelled");
      const item = await p.readerRead(reader);
      if (p.signalAborted(signal)) return await stopReading("cancelled");
      if (item.done) break;
      if (!p.isUint8Array(item.value)) return await stopReading("chunk");
      const chunkLength = p.uint8ByteLength(item.value);
      const next = received + chunkLength;
      if (!p.numberIsSafeInteger(next) || next > maxBytes) {
        return await stopReading("size");
      }
      if (declaredLength !== null && next > declaredLength) {
        return await stopReading("length-mismatch");
      }
      if (chunkLength > 0) p.arrayPush(chunks, item.value);
      received = next;
    }
    if (received <= 0) return await stopReading("size");
    if (declaredLength !== null && received !== declaredLength) {
      return await stopReading("length-mismatch");
    }
    const blob = p.makeBlob(chunks, { type: contentType });
    if (p.signalAborted(signal)) return await stopReading("cancelled");
    const blobSize = p.blobSize(blob);
    const blobType = p.blobType(blob);
    if (!blob || blobSize !== received || blobSize > maxBytes) {
      return await stopReading("size");
    }
    if (blobType) {
      const blobFamily =
        (p.stringStartsWith(input.mime, "image/")
          && p.stringStartsWith(blobType, "image/"))
        || (p.stringStartsWith(input.mime, "video/")
          && p.stringStartsWith(blobType, "video/"));
      if (!blobFamily) return { ok: false, code: "blob-mime" };
    }
    const blobUrl = p.createObjectURL(blob);
    if (typeof blobUrl !== "string"
        || !p.stringStartsWith(blobUrl, "blob:https://grok.com/")) {
      try { p.revokeObjectURL(blobUrl); } catch (_) {}
      return { ok: false, code: "blob" };
    }
    entry.blobUrl = blobUrl;
    if (p.signalAborted(signal)) {
      p.revokeObjectURL(blobUrl);
      entry.blobUrl = "";
      return { ok: false, code: "cancelled" };
    }
    return {
      ok: true,
      blobUrl,
      size: blobSize,
      probeHost: finalHostname,
      probeStatus: p.responseStatus(response),
      probeAcceptRanges: acceptRanges,
      probeOmitStatus,
      probeOmitBytes
    };
  } catch (_) {
    return { ok: false, code: p.signalAborted(signal) ? "cancelled" : "network" };
  } finally {
    if (!entry.blobUrl) p.deleteOperation(input.opToken);
  }
})"#;
const CLICK_SCRIPT: &str = r#"((input, p) => {
  if (!p
      || p.brand !== "giv-native-primordials-v1"
      || typeof p.validate !== "function"
      || p.validate(p) !== true) {
    return { ok: false, code: "primordials" };
  }
  if (typeof input.blobUrl !== "string"
      || !p.stringStartsWith(input.blobUrl, "blob:https://grok.com/")
      || typeof input.name !== "string"
      || !p.regexpTest(/^giv-[0-9a-f-]+\.download$/, input.name)) {
    return { ok: false };
  }
  try {
    const link = p.createAnchor();
    if (!link) return { ok: false };
    p.setAnchorHref(link, input.blobUrl);
    p.setAnchorDownload(link, input.name);
    p.clickAnchor(link);
    return { ok: true };
  } catch (_) {
    return { ok: false };
  }
})"#;

const REVOKE_SCRIPT: &str = r#"((input, p) => {
  if (!p
      || p.brand !== "giv-native-primordials-v1"
      || typeof p.validate !== "function"
      || p.validate(p) !== true) {
    return { ok: false, code: "primordials" };
  }
  if (typeof input.blobUrl !== "string"
      || !p.stringStartsWith(input.blobUrl, "blob:https://grok.com/")
      || !p.regexpTest(/^[0-9a-f]{32}$/, input.opToken || "")) {
    return { ok: false };
  }
  const entry = p.getOperation(input.opToken);
  if (entry && entry.blobUrl && entry.blobUrl !== input.blobUrl) {
    return { ok: false };
  }
  p.revokeObjectURL(input.blobUrl);
  p.deleteOperation(input.opToken);
  return { ok: true };
})"#;

const ABORT_SCRIPT: &str = r#"((input, p) => {
  if (!p
      || p.brand !== "giv-native-primordials-v1"
      || typeof p.validate !== "function"
      || p.validate(p) !== true) {
    return { ok: false, code: "primordials" };
  }
  if (!p.regexpTest(/^[0-9a-f]{32}$/, input && input.opToken || "")) {
    return { ok: false };
  }
  const entry = p.getOperation(input.opToken);
  if (!entry) return { ok: true };
  try { p.abortController(entry.controller); } catch (_) {}
  if (entry.blobUrl) {
    try { p.revokeObjectURL(entry.blobUrl); } catch (_) {}
  }
  p.deleteOperation(input.opToken);
  return { ok: true };
})"#;
fn operation_token() -> Result<String, String> {
    let mut bytes = [0_u8; 16];
    getrandom::fill(&mut bytes).map_err(|_| "Could not create operation token.".to_string())?;
    Ok(bytes
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>())
}

#[derive(Debug, Clone)]
pub(super) struct DetachedProbe {
    pub(super) host: String,
    pub(super) status: u64,
    pub(super) accept_ranges: bool,
    pub(super) omit_status: Option<u64>,
    pub(super) omit_bytes: Option<u64>,
}

#[derive(Debug)]
pub(super) struct PreparedBlob {
    pub(super) url: String,
    pub(super) size: u64,
    pub(super) operation_token: String,
    pub(super) probe: Option<DetachedProbe>,
}

/// One page-side failure, kept as a category rather than a sentence so the
/// retry policy and the gallery message can be decided independently.
#[derive(Debug, Clone)]
pub(super) struct PageFailure {
    pub(super) code: String,
    pub(super) message: String,
    pub(super) retryable: bool,
    pub(super) cancelled: bool,
    pub(super) http_status: Option<u64>,
    pub(super) retry_after_seconds: Option<u64>,
    pub(super) expected_bytes: Option<u64>,
    pub(super) received_bytes: Option<u64>,
}

impl PageFailure {
    fn cancelled() -> Self {
        Self {
            code: "cancelled".into(),
            message: "下载已停止。".into(),
            retryable: false,
            cancelled: true,
            http_status: None, retry_after_seconds: None, expected_bytes: None, received_bytes: None,
        }
    }

    fn from_code(code: &str, status: Option<u64>) -> Self {
        // PREPARE historically returned "http", while the shared vocabulary
        // only understood http_error. Preserve status and classify consistently.
        let code = if code == "http" || code == probe_code::HTTP {
            match status { Some(401) => probe_code::NOT_LOGGED_IN, Some(403) => probe_code::FORBIDDEN,
                Some(429) => probe_code::RATE_LIMITED, Some(500..=599) => probe_code::SERVER, _ => probe_code::HTTP }
        } else { code };
        let (message, retryable) = page_code_meaning(code, status);
        Self {
            code: code.to_owned(),
            message,
            retryable,
            cancelled: false,
            http_status: status, retry_after_seconds: None, expected_bytes: None, received_bytes: None,
        }
    }

    fn from_value(value: &Value, fallback: &str) -> Self {
        let code = value
            .get("code")
            .and_then(Value::as_str)
            .filter(|code| !code.is_empty())
            .unwrap_or(fallback);
        if code == "cancelled" {
            return Self::cancelled();
        }
        let mut failure = Self::from_code(code, value.get("status").and_then(Value::as_u64));
        failure.retry_after_seconds = value.get("retryAfterSeconds").and_then(Value::as_u64).map(|n| n.min(120));
        failure.expected_bytes = value.get("expectedBytes").and_then(Value::as_u64);
        failure.received_bytes = value.get("receivedBytes").and_then(Value::as_u64);
        failure
    }

    pub(super) fn diagnostic(&self, asset_id: &str, attempt: u64) -> DownloadFailure {
        let mut detail = DownloadFailure::new(asset_id, "prepare", &self.code, attempt);
        detail.message = self.message.clone();
        detail.retryable = self.retryable;
        detail.http_status = self.http_status;
        detail.retry_after_seconds = self.retry_after_seconds;
        detail.expected_bytes = self.expected_bytes;
        detail.received_bytes = self.received_bytes;
        detail
    }

    fn from_evaluate(failure: EvaluateFailure) -> Self {
        match failure {
            EvaluateFailure::Cancelled | EvaluateFailure::Navigated => Self::cancelled(),
            EvaluateFailure::Timeout => Self::from_code(probe_code::TIMEOUT, None),
            EvaluateFailure::Dispatch => Self::from_code(probe_code::PAGE_NOT_READY, None),
        }
    }
}

pub(super) fn probe_user<R: Runtime>(
    webview: &Webview<R>,
    cancel: &AtomicBool,
    navigation: &NavigationGuard,
) -> ProbeResponse {
    match evaluate_fixed(
        webview,
        fixed_expression(USER_PROBE, "null"),
        cancel,
        navigation,
        Duration::from_secs(30),
        None,
    ) {
        Ok(value) => {
            let user_id = value
                .get("userId")
                .and_then(Value::as_str)
                .filter(|value| is_stable_user_id(value))
                .map(str::to_owned);
            match user_id {
                Some(user_id) => ProbeResponse::logged_in(user_id),
                // A blank page, a 403 interstitial and a real sign-out all end
                // up here; only the reported category tells them apart.
                None => {
                    let failure = PageFailure::from_value(&value, probe_code::NOT_LOGGED_IN);
                    if failure.cancelled {
                        ProbeResponse::stopped()
                    } else {
                        ProbeResponse::failed(&failure.code)
                    }
                }
            }
        }
        Err(EvaluateFailure::Cancelled | EvaluateFailure::Navigated) => ProbeResponse::stopped(),
        Err(failure) => ProbeResponse::failed(&PageFailure::from_evaluate(failure).code),
    }
}

pub(super) fn fetch_library<R: Runtime>(
    webview: &Webview<R>,
    cancel: &AtomicBool,
    navigation: &NavigationGuard,
    status: &StatusCallback,
) -> Result<Library, PageFailure> {
    fetch_library_with_prompt_targets(webview, cancel, navigation, status, &[])
        .map(|result| result.library)
}

pub(super) fn fetch_library_with_prompt_targets<R: Runtime>(
    webview: &Webview<R>,
    cancel: &AtomicBool,
    navigation: &NavigationGuard,
    status: &StatusCallback,
    prompt_targets: &[PromptTarget],
) -> Result<PromptLibrary, PageFailure> {
    let operation_token =
        operation_token().map_err(|_| PageFailure::from_code("input", None))?;
    let input = serde_json::to_string(&json!({ "opToken": operation_token, "promptTargets": prompt_targets }))
        .map_err(|_| PageFailure::from_code("input", None))?;
    let expression = fixed_expression(LIST_SCRIPT, &input);
    let stop = Arc::new(AtomicBool::new(false));
    let poller = {
        let stop_hb = Arc::clone(&stop);
        let status = Arc::clone(status);
        let webview = webview.clone();
        let token = operation_token.clone();
        let navigation = navigation.clone();
        thread::spawn(move || {
            let never = AtomicBool::new(false);
            let started = Instant::now();
            let mut last_have = 0_u64;
            let mut last_wait = 0_u64;
            while !stop_hb.load(Ordering::Acquire) {
                thread::sleep(Duration::from_millis(400));
                if stop_hb.load(Ordering::Acquire) {
                    break;
                }
                if let Some((have, total)) =
                    poll_list_progress(&webview, &token, &never, &navigation)
                {
                    if have != last_have || total > 0 {
                        last_have = have;
                        if total > 0 && have <= total {
                            status(format!("list {have}/{total}"));
                        } else if have > 0 {
                            status(format!("list {have}"));
                        }
                    }
                } else {
                    let secs = started.elapsed().as_secs();
                    if secs >= 5 && secs.saturating_sub(last_wait) >= 5 {
                        last_wait = secs;
                        status(format!("list wait {secs}s"));
                    }
                }
            }
        })
    };
    let value = evaluate_fixed(
        webview,
        expression,
        cancel,
        navigation,
        Duration::from_secs(6 * 60),
        Some(&operation_token),
    );
    stop.store(true, Ordering::Release);
    let _ = poller.join();
    let value = value.map_err(PageFailure::from_evaluate)?;
    if value.get("ok").and_then(Value::as_bool) != Some(true) {
        return Err(PageFailure::from_value(&value, probe_code::SCHEMA));
    }
    // Only a manifest the page proved it read to the end may replace an index.
    if value.get("complete").and_then(Value::as_bool) != Some(true) {
        return Err(PageFailure::from_code(probe_code::INCOMPLETE, None));
    }
    serde_json::from_value(value).map_err(|_| PageFailure::from_code(probe_code::SCHEMA, None))
}

fn poll_list_progress<R: Runtime>(
    webview: &Webview<R>,
    operation_token: &str,
    cancel: &AtomicBool,
    navigation: &NavigationGuard,
) -> Option<(u64, u64)> {
    let input = serde_json::to_string(&json!({ "opToken": operation_token })).ok()?;
    let expression = fixed_expression(LIST_PROGRESS_SCRIPT, &input);
    let value = evaluate_fixed(
        webview,
        expression,
        cancel,
        navigation,
        Duration::from_secs(2),
        None,
    )
    .ok()?;
    if value.get("ok").and_then(Value::as_bool) != Some(true) {
        return None;
    }
    let have = value.get("have").and_then(Value::as_u64)?;
    let total = value.get("total").and_then(Value::as_u64).unwrap_or(0);
    Some((have, total))
}

pub(super) fn prepare_asset<R: Runtime>(
    webview: &Webview<R>,
    key: &str,
    mime: &str,
    cancel: &AtomicBool,
    navigation: &NavigationGuard,
    probe_detached: bool,
) -> Result<PreparedBlob, PageFailure> {
    prepare_asset_limited(webview, key, mime, cancel, navigation, MAX_MEDIA_BYTES, probe_detached)
}

pub(super) fn prepare_asset_limited<R: Runtime>(
    webview: &Webview<R>, key: &str, mime: &str, cancel: &AtomicBool,
    navigation: &NavigationGuard, max_bytes: u64, probe_detached: bool,
) -> Result<PreparedBlob, PageFailure> {
    if !(1..=MAX_MEDIA_BYTES).contains(&max_bytes) { return Err(PageFailure::from_code("input", None)); }
    if !is_asset_key(key) || !is_supported_mime(mime) {
        return Err(PageFailure::from_code("input", None));
    }
    let operation_token =
        operation_token().map_err(|_| PageFailure::from_code("input", None))?;
    let input = serde_json::to_string(&json!({
        "key": key,
        "mime": mime,
        "opToken": operation_token,
        "maxBytes": max_bytes,
        "probeDetached": probe_detached
    }))
    .map_err(|_| PageFailure::from_code("input", None))?;
    let expression = fixed_expression(PREPARE_SCRIPT, &input);
    let value = evaluate_fixed(
        webview,
        expression,
        cancel,
        navigation,
        Duration::from_secs(6 * 60),
        Some(&operation_token),
    )
    .map_err(PageFailure::from_evaluate)?;
    if value.get("ok").and_then(Value::as_bool) != Some(true) {
        return Err(PageFailure::from_value(&value, probe_code::NETWORK));
    }
    let url = value
        .get("blobUrl")
        .and_then(Value::as_str)
        .filter(|url| is_grok_blob_url(url))
        .ok_or_else(|| PageFailure::from_code("blob", None))?
        .to_owned();
    let size = value
        .get("size")
        .and_then(Value::as_u64)
        .filter(|size| (1..=MAX_MEDIA_BYTES).contains(size))
        .ok_or_else(|| PageFailure::from_code("size", None))?;
    let host = value
        .get("probeHost")
        .and_then(Value::as_str)
        .filter(|host| *host == "assets.grok.com" || *host == "imagine-public.x.ai")
        .map(str::to_owned);
    let probe = host.map(|host| DetachedProbe {
        host,
        status: value.get("probeStatus").and_then(Value::as_u64).unwrap_or(0),
        accept_ranges: value.get("probeAcceptRanges").and_then(Value::as_bool) == Some(true),
        omit_status: value.get("probeOmitStatus").and_then(Value::as_u64),
        omit_bytes: value.get("probeOmitBytes").and_then(Value::as_u64),
    });
    Ok(PreparedBlob {
        url,
        size,
        operation_token,
        probe,
    })
}

#[cfg(test)]
fn prepare_request_json(key: &str, mime: &str, operation_token: &str) -> Result<String, String> {
    serde_json::to_string(&json!({
        "key": key,
        "mime": mime,
        "opToken": operation_token,
        "maxBytes": MAX_MEDIA_BYTES
    }))
    .map_err(|_| "媒体请求编码失败。".to_string())
}

pub(super) fn click_asset<R: Runtime>(
    webview: &Webview<R>,
    blob_url: &str,
    name: &str,
    cancel: &AtomicBool,
    navigation: &NavigationGuard,
) -> Result<bool, String> {
    if !is_grok_blob_url(blob_url) || !is_suggested_name(name) {
        return Err("媒体下载句柄验证失败。".into());
    }
    let input = serde_json::to_string(&json!({ "blobUrl": blob_url, "name": name }))
        .map_err(|_| "媒体下载请求编码失败。".to_string())?;
    let expression = fixed_expression(CLICK_SCRIPT, &input);
    let value = evaluate_fixed(
        webview,
        expression,
        cancel,
        navigation,
        Duration::from_secs(30),
        None,
    )
    .map_err(evaluate_message)?;
    Ok(value.get("ok").and_then(Value::as_bool) == Some(true))
}

pub(super) fn revoke_blob<R: Runtime>(
    webview: &Webview<R>,
    prepared: &PreparedBlob,
    cancel: &AtomicBool,
    navigation: &NavigationGuard,
) {
    if !is_grok_blob_url(&prepared.url) {
        return;
    }
    let input = match serde_json::to_string(
        &json!({ "blobUrl": prepared.url, "opToken": prepared.operation_token }),
    ) {
        Ok(input) => input,
        Err(_) => return,
    };
    let expression = fixed_expression(REVOKE_SCRIPT, &input);
    let never_cancelled = AtomicBool::new(false);
    let cancellation = if cancel.load(Ordering::Acquire) {
        &never_cancelled
    } else {
        cancel
    };
    let _ = evaluate_fixed(
        webview,
        expression,
        cancellation,
        navigation,
        Duration::from_secs(10),
        None,
    );
}

fn is_suggested_name(value: &str) -> bool {
    value.len() <= 96
        && value.starts_with("giv-")
        && value.ends_with(".download")
        && value
            .trim_start_matches("giv-")
            .trim_end_matches(".download")
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() || byte == b'-')
}

#[derive(Debug, Clone, Copy)]
enum EvaluateFailure {
    Cancelled,
    Navigated,
    Dispatch,
    Timeout,
}

fn evaluate_message(failure: EvaluateFailure) -> String {
    match failure {
        EvaluateFailure::Cancelled | EvaluateFailure::Navigated => "下载已停止。".into(),
        EvaluateFailure::Dispatch | EvaluateFailure::Timeout => {
            "WebView2 页面操作失败或超时。".into()
        }
    }
}

fn evaluate_fixed<R: Runtime>(
    webview: &Webview<R>,
    expression: String,
    cancel: &AtomicBool,
    navigation: &NavigationGuard,
    timeout: Duration,
    abort_token: Option<&str>,
) -> Result<Value, EvaluateFailure> {
    ensure_navigation_current(navigation)?;
    if !is_grok_page(webview) {
        return Err(EvaluateFailure::Dispatch);
    }
    let parameters = json!({
        "expression": expression,
        "awaitPromise": true,
        "returnByValue": true,
        "timeout": timeout.as_millis().min(u128::from(u32::MAX)) as u64
    })
    .to_string();
    let (sender, receiver) = mpsc::sync_channel(1);
    webview
        .with_webview(move |platform| {
            let callback_sender = sender.clone();
            let immediate_sender = sender;
            let result = (|| -> windows::core::Result<()> {
                let controller = platform.controller();
                let core = unsafe { controller.CoreWebView2()? };
                let handler = CallDevToolsProtocolMethodCompletedHandler::create(Box::new(
                    move |status, result| {
                        let reply = if status.is_ok() { Some(result) } else { None };
                        let _ = callback_sender.send(reply);
                        Ok(())
                    },
                ));
                let method = HSTRING::from("Runtime.evaluate");
                let parameters = HSTRING::from(parameters);
                unsafe { core.CallDevToolsProtocolMethod(&method, &parameters, &handler) }
            })();
            if result.is_err() {
                let _ = immediate_sender.send(None);
            }
        })
        .map_err(|_| EvaluateFailure::Dispatch)?;

    let deadline = Instant::now() + timeout + Duration::from_secs(5);
    loop {
        ensure_navigation_current(navigation)?;
        if cancel.load(Ordering::Acquire) {
            if let Some(token) = abort_token {
                dispatch_abort(webview, token);
            }
            return Err(EvaluateFailure::Cancelled);
        }
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            if let Some(token) = abort_token {
                dispatch_abort(webview, token);
            }
            return Err(EvaluateFailure::Timeout);
        }
        match receiver.recv_timeout(remaining.min(Duration::from_millis(100))) {
            Ok(Some(raw)) => return extract_current_value(&raw, navigation),
            Ok(None) | Err(mpsc::RecvTimeoutError::Disconnected) => {
                return Err(EvaluateFailure::Dispatch)
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {}
        }
    }
}

fn ensure_navigation_current(navigation: &NavigationGuard) -> Result<(), EvaluateFailure> {
    navigation
        .is_current()
        .then_some(())
        .ok_or(EvaluateFailure::Navigated)
}

fn extract_current_value(
    raw: &str,
    navigation: &NavigationGuard,
) -> Result<Value, EvaluateFailure> {
    ensure_navigation_current(navigation)?;
    let value = extract_value(raw)?;
    ensure_navigation_current(navigation)?;
    Ok(value)
}

fn dispatch_abort<R: Runtime>(webview: &Webview<R>, operation_token: &str) {
    if operation_token.len() != 32 || !operation_token.bytes().all(|byte| byte.is_ascii_hexdigit())
    {
        return;
    }
    let input = match serde_json::to_string(&json!({ "opToken": operation_token })) {
        Ok(input) => input,
        Err(_) => return,
    };
    let expression = fixed_expression(ABORT_SCRIPT, &input);
    let parameters = json!({
        "expression": expression,
        "awaitPromise": true,
        "returnByValue": false
    })
    .to_string();
    let _ = webview.with_webview(move |platform| {
        let result = (|| -> windows::core::Result<()> {
            let controller = platform.controller();
            let core = unsafe { controller.CoreWebView2()? };
            let handler =
                CallDevToolsProtocolMethodCompletedHandler::create(Box::new(move |_, _| Ok(())));
            let method = HSTRING::from("Runtime.evaluate");
            let parameters = HSTRING::from(parameters);
            unsafe { core.CallDevToolsProtocolMethod(&method, &parameters, &handler) }
        })();
        let _ = result;
    });
}

fn extract_value(raw: &str) -> Result<Value, EvaluateFailure> {
    if raw.len() > 32 * 1024 * 1024 {
        return Err(EvaluateFailure::Dispatch);
    }
    let response: Value = serde_json::from_str(raw).map_err(|_| EvaluateFailure::Dispatch)?;
    if response.get("exceptionDetails").is_some() {
        return Err(EvaluateFailure::Dispatch);
    }
    response
        .get("result")
        .and_then(|result| result.get("value"))
        .cloned()
        .ok_or(EvaluateFailure::Dispatch)
}

fn is_supported_mime(value: &str) -> bool {
    is_supported_media_mime(value)
}

fn is_grok_page<R: Runtime>(webview: &Webview<R>) -> bool {
    webview.url().ok().is_some_and(|url| {
        url.scheme() == "https"
            && url.host_str() == Some("grok.com")
            && url.username().is_empty()
            && url.password().is_none()
            && url.port_or_known_default() == Some(443)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn legacy_http_errors_keep_status_and_retry_advice() {
        let failure = PageFailure::from_value(&json!({"code":"http","status":429,"retryAfterSeconds":19}), "network");
        assert_eq!(failure.code, "rate_limited"); assert!(failure.retryable);
        let detail = failure.diagnostic("asset-1", 3);
        assert_eq!(detail.http_status, Some(429)); assert_eq!(detail.retry_after_seconds, Some(19));
        let missing = PageFailure::from_value(&json!({"code":"http","status":404}), "network");
        assert!(!missing.retryable); assert_eq!(missing.http_status, Some(404));
        assert_eq!(PageFailure::from_code("http", Some(403)).code, "forbidden");
    }


    #[test]
    fn evaluate_reply_from_an_old_navigation_epoch_is_rejected() {
        let state = DownloadState::default();
        let navigation = state.navigation_guard();
        let raw = r#"{"result":{"type":"object","value":{"ok":true}}}"#;
        assert_eq!(
            extract_current_value(raw, &navigation).unwrap()["ok"],
            Value::Bool(true)
        );

        state.navigation_started();
        assert!(matches!(
            extract_current_value(raw, &navigation),
            Err(EvaluateFailure::Navigated)
        ));
    }

    #[test]
    fn scripts_have_no_credential_extraction_apis() {
        let scripts = [
            USER_PROBE,
            LIST_SCRIPT,
            LIST_PROGRESS_SCRIPT,
            PREPARE_SCRIPT,
            CLICK_SCRIPT,
            REVOKE_SCRIPT,
            ABORT_SCRIPT,
        ]
        .join("\n");
        for forbidden in [
            "getCookies",
            "CookieManager",
            "document.cookie",
            "localStorage",
            "sessionStorage",
            "Authorization",
        ] {
            assert!(!scripts.contains(forbidden), "{forbidden}");
        }
    }

    #[test]
    fn fixed_scripts_do_not_resolve_page_mutable_native_apis() {
        let scripts = [
            USER_PROBE,
            LIST_SCRIPT,
            LIST_PROGRESS_SCRIPT,
            PREPARE_SCRIPT,
            CLICK_SCRIPT,
            REVOKE_SCRIPT,
            ABORT_SCRIPT,
        ]
        .join("\n");
        assert_eq!(scripts.matches("p.validate(p)").count(), 7);
        for required in [
            "p.fetch(",
            "p.makeURL(",
            "p.makeBlob(",
            "p.createObjectURL(",
            "p.revokeObjectURL(",
            "p.beginOperation(",
            "p.isUint8Array(",
            "p.uint8ByteLength(",
            "p.createAnchor(",
            "p.clickAnchor(",
        ] {
            assert!(scripts.contains(required), "{required}");
        }
        for forbidden in [
            "window.fetch",
            "globalThis.fetch",
            "await fetch(",
            "new URL(",
            "URL.createObjectURL",
            "URL.revokeObjectURL",
            "new Blob(",
            "new Map(",
            "new AbortController(",
            "instanceof Uint8Array",
            ".byteLength",
            "document.createElement",
            ".click()",
            "Number.isSafeInteger",
            "Array.isArray",
            "JSON.stringify",
            "new Promise(",
        ] {
            assert!(!scripts.contains(forbidden), "{forbidden}");
        }
    }

    #[test]
    fn captured_primordials_survive_page_monkeypatches() {
        use std::{
            io::Write,
            process::{Command, Stdio},
        };

        let click_input = r#"{"blobUrl":"blob:https://grok.com/00000000-0000-4000-8000-000000000001","name":"giv-00000000000000000000000000000001.download"}"#;
        let click_expression = fixed_expression(CLICK_SCRIPT, click_input);
        let probe_expression = fixed_expression(USER_PROBE, "null");
        let script = [
            r#"const assert = require("node:assert/strict");
(async () => {
  const missing = await "#,
            &click_expression,
            r#";
  assert.equal(missing.code, "primordials");

  let nativeFetches = 0;
  let nativeCreates = 0;
  let nativeRevokes = 0;
  let nativeClicks = 0;
  class TestAnchor {
    set href(value) { this.savedHref = value; }
    get href() { return this.savedHref; }
    set download(value) { this.savedDownload = value; }
    get download() { return this.savedDownload; }
    click() { nativeClicks += 1; }
  }
  class TestDocument {
    createElement(name) {
      assert.equal(name, "a");
      return new TestAnchor();
    }
  }
  Object.defineProperty(globalThis, "Document", {
    value: TestDocument, configurable: true, writable: true
  });
  Object.defineProperty(globalThis, "HTMLAnchorElement", {
    value: TestAnchor, configurable: true, writable: true
  });
  Object.defineProperty(globalThis, "document", {
    value: new TestDocument(), configurable: true, writable: true
  });
  globalThis.fetch = async () => {
    nativeFetches += 1;
    return new Response('{"userId":"native-user-123"}', {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  };
  Object.defineProperty(URL, "createObjectURL", {
    value: () => {
      nativeCreates += 1;
      return "blob:https://grok.com/00000000-0000-4000-8000-000000000001";
    },
    configurable: true,
    writable: true
  });
  Object.defineProperty(URL, "revokeObjectURL", {
    value: () => { nativeRevokes += 1; },
    configurable: true,
    writable: true
  });
  const nativeBytes = new Uint8Array([1, 2, 3]);
  const NativeURL = globalThis.URL;
  const NativeBlob = globalThis.Blob;
  const NativeMap = globalThis.Map;
  const NativeAbortController = globalThis.AbortController;
  const NativeUint8Array = globalThis.Uint8Array;
  const nativeResponseJson = Response.prototype.json;
  const nativeTypedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype);
  const nativeByteLength = Object.getOwnPropertyDescriptor(
    nativeTypedArrayPrototype,
    "byteLength"
  );
"#,
            grok_primordials_initialization_script(),
            r#"
  const key = "__giv_native_primordials_v1_6f36b8f2";
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, key);
  const p = descriptor.value;
  assert.equal(descriptor.configurable, false);
  assert.equal(descriptor.writable, false);
  assert.equal(Object.isFrozen(p), true);
  assert.equal(p.validate(p), true);

  globalThis.fetch = async () => { throw new Error("poisoned fetch"); };
  Response.prototype.json = async () => { throw new Error("poisoned json"); };
  TestDocument.prototype.createElement = () => { throw new Error("poisoned createElement"); };
  TestAnchor.prototype.click = () => { throw new Error("poisoned click"); };

  const probe = await "#,
            &probe_expression,
            r#";
  assert.equal(probe.ok, true);
  assert.equal(probe.userId, "native-user-123");
  assert.equal(nativeFetches, 1);
  Response.prototype.json = nativeResponseJson;

  globalThis.URL = class PoisonedURL {};
  const url = p.makeURL("https://grok.com/imagine");
  assert.equal(p.urlHostname(url), "grok.com");
  globalThis.URL = NativeURL;

  globalThis.Blob = class PoisonedBlob {};
  const blob = p.makeBlob([nativeBytes], { type: "image/png" });
  assert.equal(p.blobSize(blob), 3);
  globalThis.Blob = NativeBlob;

  globalThis.Uint8Array = class PoisonedUint8Array {};
  Object.defineProperty(nativeTypedArrayPrototype, "byteLength", {
    get() { throw new Error("poisoned byteLength"); },
    configurable: true
  });
  assert.equal(p.isUint8Array(nativeBytes), true);
  assert.equal(p.uint8ByteLength(nativeBytes), 3);
  Object.defineProperty(nativeTypedArrayPrototype, "byteLength", nativeByteLength);
  globalThis.Uint8Array = NativeUint8Array;

  NativeURL.createObjectURL = () => { throw new Error("poisoned createObjectURL"); };
  NativeURL.revokeObjectURL = () => { throw new Error("poisoned revokeObjectURL"); };
  const blobUrl = p.createObjectURL(blob);
  assert.equal(nativeCreates, 1);
  p.revokeObjectURL(blobUrl);
  assert.equal(nativeRevokes, 1);

  globalThis.Map = class PoisonedMap {};
  globalThis.AbortController = class PoisonedAbortController {};
  const entry = p.beginOperation("00000000000000000000000000000001");
  const signal = p.abortSignal(entry.controller);
  assert.equal(p.signalAborted(signal), false);
  p.abortController(entry.controller);
  assert.equal(p.signalAborted(signal), true);
  p.deleteOperation("00000000000000000000000000000001");
  globalThis.Map = NativeMap;
  globalThis.AbortController = NativeAbortController;

  const clicked = await "#,
            &click_expression,
            r#";
  assert.equal(clicked.ok, true);
  assert.equal(nativeClicks, 1);
})().catch((error) => {
  console.error(error && error.stack || error);
  process.exitCode = 1;
});
"#,
        ]
        .concat();

        let mut child = Command::new("node")
            .arg("-")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("node is required by the repository test toolchain");
        child
            .stdin
            .take()
            .unwrap()
            .write_all(script.as_bytes())
            .unwrap();
        let output = child.wait_with_output().unwrap();
        assert!(
            output.status.success(),
            "node behavior test failed ({}): stdout={} stderr={}",
            output.status,
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr),
        );
    }

    /// Runs the production list script against scripted responses. A malformed
    /// or truncated manifest must never surface as a successful empty library,
    /// because publishing that would wipe the visible index.
    #[test]
    fn list_script_rejects_malformed_and_truncated_manifests() {
        use std::{
            io::Write,
            process::{Command, Stdio},
        };

        let expression = fixed_expression(
            LIST_SCRIPT,
            r#"{"opToken":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}"#,
        );
        let script = [
            r#"const assert = require("node:assert/strict");
// The primordials capture reaches for the anchor download chain at document
// start; this test only exercises the list script, so stubs are enough.
class TestAnchor {
  set href(value) { this.savedHref = value; }
  get href() { return this.savedHref; }
  set download(value) { this.savedDownload = value; }
  get download() { return this.savedDownload; }
  click() {}
}
class TestDocument {
  createElement() { return new TestAnchor(); }
}
Object.defineProperty(globalThis, "Document", {
  value: TestDocument, configurable: true, writable: true
});
Object.defineProperty(globalThis, "HTMLAnchorElement", {
  value: TestAnchor, configurable: true, writable: true
});
Object.defineProperty(globalThis, "document", {
  value: new TestDocument(), configurable: true, writable: true
});
const scenarios = {
  malformed_object: [{}],
  wrong_type: [{ assets: { rows: [] }, nextPageToken: "" }],
  empty_page_with_cursor: [{ assets: [], nextPageToken: "cursor-1" }],
  repeated_cursor: [
    { assets: [], nextPageToken: "cursor-1" },
    { assets: [], nextPageToken: "cursor-1" }
  ],
  null_body: [null],
  array_body: [[]],
  legitimately_empty: [{ assets: [] }],
  two_pages: [
    { assets: [{ assetId: "asset-000001", mimeType: "image/jpeg", key: "a/b.jpg" }],
      nextPageToken: "cursor-1" },
    { assets: [{ assetId: "asset-000002", mimeType: "image/jpeg", key: "a/c.jpg" }] }
  ],
  forbidden: [{ __status: 403 }],
  server_error: [{ __status: 500 }],
  not_json: [{ __text: "<html></html>" }],
  // One 429 then a good page: proves the retry path still completes instead of
  // reporting an empty library.
  rate_limited_once: [{ __status: 429 }, { assets: [] }]
};
let current = null;
let assetPage = 0;
globalThis.fetch = async (url) => {
  const isAssets = String(url).indexOf("/rest/assets") >= 0;
  if (!isAssets) {
    return new Response(JSON.stringify({ conversations: [] }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  }
  const plan = scenarios[current];
  const page = plan[Math.min(assetPage, plan.length - 1)];
  assetPage += 1;
  if (page && page.__status) {
    return new Response("nope", {
      status: page.__status,
      headers: { "content-type": "text/plain" }
    });
  }
  if (page && page.__text) {
    return new Response(page.__text, {
      status: 200,
      headers: { "content-type": "text/html" }
    });
  }
  return new Response(JSON.stringify(page), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
};
"#,
            grok_primordials_initialization_script(),
            r#"
const run = async (name) => {
  current = name;
  assetPage = 0;
  return await "#,
            &expression,
            r#";
};
(async () => {
  for (const name of ["malformed_object", "wrong_type", "null_body", "array_body"]) {
    const result = await run(name);
    assert.equal(result.ok, false, name);
    assert.equal(result.code, "schema_error", name);
  }

  for (const name of ["empty_page_with_cursor", "repeated_cursor"]) {
    const result = await run(name);
    assert.equal(result.ok, false, name);
    assert.equal(result.code, "incomplete_manifest", name);
  }

  const forbidden = await run("forbidden");
  assert.equal(forbidden.code, "forbidden");
  assert.equal(forbidden.status, 403);

  const server = await run("server_error");
  assert.equal(server.code, "server_error");
  assert.equal(server.status, 500);

  const notJson = await run("not_json");
  assert.equal(notJson.code, "schema_error");

  const limited = await run("rate_limited_once");
  assert.equal(limited.ok, true);
  assert.equal(limited.complete, true);

  // A real empty account is still allowed through, and only a manifest read to
  // the end is marked complete.
  const empty = await run("legitimately_empty");
  assert.equal(empty.ok, true);
  assert.equal(empty.complete, true);
  assert.deepEqual(empty.assets, []);

  const paged = await run("two_pages");
  assert.equal(paged.ok, true);
  assert.equal(paged.complete, true);
  assert.equal(paged.assets.length, 2);
  assert.equal(paged.assets[0].id, "asset-000001");
  assert.equal(paged.assets[1].id, "asset-000002");
})().catch((error) => {
  console.error(error && error.stack || error);
  process.exitCode = 1;
});
"#,
        ]
        .concat();

        let mut child = Command::new("node")
            .arg("-")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("node is required by the repository test toolchain");
        child
            .stdin
            .take()
            .unwrap()
            .write_all(script.as_bytes())
            .unwrap();
        let output = child.wait_with_output().unwrap();
        assert!(
            output.status.success(),
            "list script behavior test failed ({}): stdout={} stderr={}",
            output.status,
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr),
        );
    }

    #[test]
    fn probe_failures_keep_their_category() {
        for (code, expect_retry) in [
            (probe_code::NOT_LOGGED_IN, false),
            (probe_code::FORBIDDEN, false),
            (probe_code::RATE_LIMITED, true),
            (probe_code::SERVER, true),
            (probe_code::NETWORK, true),
            (probe_code::TIMEOUT, true),
            (probe_code::PAGE_NOT_READY, true),
            (probe_code::SCHEMA, false),
            (probe_code::INCOMPLETE, false),
            ("mime", false),
        ] {
            let failure = PageFailure::from_code(code, None);
            assert_eq!(failure.code, code);
            assert_eq!(failure.retryable, expect_retry, "{code}");
            assert!(!failure.message.is_empty(), "{code}");
            assert!(!failure.cancelled, "{code}");
        }

        // A blank or still-loading document is a page problem, not a sign-out.
        assert_eq!(
            PageFailure::from_evaluate(EvaluateFailure::Dispatch).code,
            probe_code::PAGE_NOT_READY
        );
        assert_eq!(
            PageFailure::from_evaluate(EvaluateFailure::Timeout).code,
            probe_code::TIMEOUT
        );
        assert!(PageFailure::from_evaluate(EvaluateFailure::Navigated).cancelled);
        assert!(PageFailure::from_evaluate(EvaluateFailure::Cancelled).cancelled);

        let http = PageFailure::from_value(
            &json!({ "code": "http_error", "status": 418 }),
            probe_code::NETWORK,
        );
        assert!(http.message.contains("418"));
        assert!(PageFailure::from_value(&json!({ "code": "cancelled" }), probe_code::NETWORK).cancelled);
    }

    #[test]
    fn prepare_script_streams_through_a_bounded_accumulator() {
        assert!(!PREPARE_SCRIPT.contains("response.blob()"));
        assert!(!PREPARE_SCRIPT.contains("1073741824"));
        for required in [
            "p.responseBody(response)",
            "p.streamReader(body)",
            "await p.readerRead(reader)",
            "await p.readerCancel(reader, code)",
            "p.abortController(entry.controller)",
            "next > maxBytes",
            "next > declaredLength",
            "p.makeBlob(chunks",
            "input.maxBytes",
        ] {
            assert!(PREPARE_SCRIPT.contains(required), "{required}");
        }
    }

    #[test]
    fn prepare_request_uses_the_rust_download_limit() {
        let raw = prepare_request_json(
            "assets/example/file.jpg",
            "image/jpeg",
            "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        )
        .unwrap();
        let value: Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(
            value.get("maxBytes").and_then(Value::as_u64),
            Some(MAX_MEDIA_BYTES)
        );
        assert_eq!(MAX_MEDIA_BYTES, 512 * 1024 * 1024);
    }

    #[test]
    fn suggested_name_is_narrow() {
        assert!(is_suggested_name(
            "giv-0000000000000001-0000000000000002-01.download"
        ));
        assert!(!is_suggested_name("../escape.download"));
        assert!(!is_suggested_name("giv-token.exe"));
    }

    #[test]
    fn probe_parser_does_not_return_account_payload() {
        let raw = r#"{"result":{"value":{"ok":true,"userId":"abc123-DEF_456","email":"x@y"}}}"#;
        let value = extract_value(raw).unwrap();
        assert_eq!(
            value.get("userId").and_then(Value::as_str),
            Some("abc123-DEF_456")
        );
        assert!(is_stable_user_id("abc123-DEF_456"));
    }
}
