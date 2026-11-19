/* Player chrome, application preferences and keyboard recording.
 * Kept separate from gallery state; only the injected, narrow adapter can
 * mutate metadata, navigate a trusted native view, or copy a local file.
 */
(function (root) {
  "use strict";
  const t = (key, values = {}) => root.GivI18n ? root.GivI18n.t(key, values) : key.replace(/\{(\w+)\}/g, (match, name) => Object.hasOwn(values, name) ? String(values[name]) : match);
  const DEFAULT_SHORTCUTS = Object.freeze({
    previousItem: "ArrowUp", nextItem: "ArrowDown", previousGroup: "Ctrl+ArrowLeft", nextGroup: "Ctrl+ArrowRight",
    seekBack: "ArrowLeft", seekForward: "ArrowRight", seekBackFar: "Shift+ArrowLeft", seekForwardFar: "Shift+ArrowRight",
    previousFrame: "KeyD", nextFrame: "KeyF",
    setA: "BracketLeft", setB: "BracketRight", clearAB: "Backslash", loop: "KeyL", play: "Space", mute: "KeyM",
    size50: "Ctrl+Digit1", size100: "Ctrl+Digit2", size150: "Ctrl+Digit3", size150Alt: "Ctrl+Digit4", fullscreen: "Ctrl+KeyF"
  });
  const SEEK_REPEAT = new Set(["seekBack", "seekForward", "seekBackFar", "seekForwardFar"]);
  const LABELS = { previousItem: "上一项媒体", nextItem: "下一项媒体", previousGroup: "上一个组合", nextGroup: "下一个组合",
    seekBack: "倒退 1.5 秒", seekForward: "快进 1.5 秒", seekBackFar: "倒退 3 秒", seekForwardFar: "快进 3 秒",
    previousFrame: "上一帧", nextFrame: "下一帧",
    setA: "设置循环 A 点", setB: "设置循环 B 点", clearAB: "清除 A/B", loop: "循环模式", play: "播放／暂停", mute: "静音开关",
    size50: "窗口：媒体 50%", size100: "窗口：媒体 100%", size150: "窗口：媒体 150%", size150Alt: "窗口：媒体 150%（备用）", fullscreen: "程序窗口全屏" };
  const MODIFIERS = ["Ctrl", "Alt", "Shift", "Meta"];
  const MODIFIER_CODES = { ControlLeft: "Ctrl", ControlRight: "Ctrl", AltLeft: "Alt", AltRight: "Alt", ShiftLeft: "Shift", ShiftRight: "Shift", MetaLeft: "Meta", MetaRight: "Meta" };
  const CODE = /^(Key[A-Z]|Digit[0-9]|F(?:[1-9]|1[0-2])|Arrow(?:Up|Down|Left|Right)|Space|BracketLeft|BracketRight|Backslash|Comma|Period|Slash|Semicolon|Quote|Minus|Equal|Backquote|Home|End|PageUp|PageDown|Insert|Delete|Backspace|Enter|Numpad[0-9])$/;
  const RESERVED = new Set(["Alt+F4", "Ctrl+KeyW", "Ctrl+KeyR", "Ctrl+KeyT", "Ctrl+KeyN", "Ctrl+KeyL", "Ctrl+KeyQ", "Ctrl+Shift+KeyW", "Ctrl+Shift+KeyR", "Ctrl+Alt+Delete"]);
  const ICONS = {
    settings: [
      ["path", {d: "M9.671 4.136a2.34 2.34 0 0 1 4.659 0 2.34 2.34 0 0 0 3.319 1.915 2.34 2.34 0 0 1 2.33 4.033 2.34 2.34 0 0 0 0 3.831 2.34 2.34 0 0 1-2.33 4.033 2.34 2.34 0 0 0-3.319 1.915 2.34 2.34 0 0 1-4.659 0 2.34 2.34 0 0 0-3.32-1.915 2.34 2.34 0 0 1-2.33-4.033 2.34 2.34 0 0 0 0-3.831A2.34 2.34 0 0 1 6.35 6.051a2.34 2.34 0 0 0 3.319-1.915"}],
      ["circle", {cx: "12", cy: "12", r: "3"}]
    ],
    fullscreen: "M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5M3 3l6 6m12-6-6 6M3 21l6-6m12 6-6-6",
    sidebar: "M4 4h16v16H4zM15 4v16",
    download: "M12 3v12m-5-5 5 5 5-5M4 15v5h16v-5",
    more: "M5 11v2m7-2v2m7-2v2",
    open: "M14 3h7v7m0-7L10 14M10 4H4v16h16v-6",
    copy: "M8 8h12v12H8zM16 8V4H4v12h4"
  };
  function icon(name) {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    for (const [key, value] of Object.entries({viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", "stroke-width": "1.7", "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true"})) svg.setAttribute(key, value);
    const spec = ICONS[name] || ICONS.more;
    const parts = typeof spec === "string" ? [["path", {d: spec}]] : spec;
    for (const [tag, attrs] of parts) {
      const node = document.createElementNS(svg.namespaceURI, tag);
      for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
      svg.appendChild(node);
    }
    return svg;
  }
  function normalizeChord(parts) {
    const unique = new Set(Array.isArray(parts) ? parts.map(code => MODIFIER_CODES[code] || code) : String(parts).split("+"));
    const keys = [...unique].filter(key => !MODIFIERS.includes(key)).sort();
    if (!keys.length || keys.length > 3 || keys.some(key => !CODE.test(key))) return "";
    const chord = [...MODIFIERS.filter(key => unique.has(key)), ...keys].join("+");
    return unique.has("Meta") || RESERVED.has(chord) ? "" : chord;
  }
  function eventChord(ev, held) {
    const keys = [...(held || [])].filter(key => !MODIFIER_CODES[key]);
    if (!MODIFIER_CODES[ev.code] && !keys.includes(ev.code)) keys.push(ev.code);
    return normalizeChord([...(ev.ctrlKey ? ["Ctrl"] : []), ...(ev.altKey ? ["Alt"] : []), ...(ev.shiftKey ? ["Shift"] : []), ...(ev.metaKey ? ["Meta"] : []), ...keys]);
  }
  function prettyChord(chord) {
    return String(chord).replace(/Key([A-Z])/g, "$1").replace(/Digit([0-9])/g, "$1").replace("BracketLeft", "[").replace("BracketRight", "]").replace("Backslash", "\\").replace("Space", t("空格")).replace("ArrowUp", "↑").replace("ArrowDown", "↓").replace("ArrowLeft", "←").replace("ArrowRight", "→");
  }
  function editable(node) {
    return !!(node && (node.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(node.tagName)));
  }
  // Close only a stationary pointer gesture that began and ended on the backdrop.
  // Waiting for click avoids passing its release through to the page underneath.
  function bindDialogBackdrop(dialog) {
    let down = null;
    const outside = ev => {
      const box = dialog.getBoundingClientRect();
      return ev.target === dialog && (ev.clientX < box.left || ev.clientX > box.right || ev.clientY < box.top || ev.clientY > box.bottom);
    };
    dialog.addEventListener("pointerdown", ev => {
      down = ev.button === 0 && outside(ev) ? {x: ev.clientX, y: ev.clientY, id: ev.pointerId} : null;
    });
    dialog.addEventListener("pointerup", ev => {
      if (!down || ev.pointerId !== down.id || !outside(ev) || Math.hypot(ev.clientX - down.x, ev.clientY - down.y) > 6) down = null;
    });
    dialog.addEventListener("click", ev => {
      const close = down && ev.detail > 0 && outside(ev) && Math.hypot(ev.clientX - down.x, ev.clientY - down.y) <= 6;
      down = null;
      if (close && dialog.open) dialog.close();
    });
    for (const event of ["pointercancel", "close", "cancel"]) dialog.addEventListener(event, () => { down = null; });
  }
  function coverAccelText(data) {
    if (!data || !data.covers) return t("未找到 FFmpeg；视频封面使用现有兼容路径。");
    const backend = data.candidateBackend || data.hwaccel || "cpu";
    const selected = backend === "cpu" ? t("CPU 解码") : t("候选解码后端：{backend}（不等于已验证硬件解码）", {backend: backend});
    const last = data.lastAttempt;
    return selected + t("；缩放：CPU；JPEG 编码：CPU。")
      + (last ? t(" 最近一次 {backend} 抽帧命令{result}。", {backend: last.backend, result: last.succeeded ? t("成功") : t("失败")}) : "")
      + (data.fallback ? " " + data.fallback : "")
      + t(" 单文件硬件失败只回退该文件，不关闭其他媒体的硬件尝试。");
  }
  const PLAYBACK_MODES = Object.freeze({auto: "自动", gpu: "GPU 优先", cpu: "CPU 解码", compat: "兼容（软件渲染）"});
  function playbackAccelText(data) {
    if (!data || !data.supported) return t("仅 Windows 桌面版可调整播放器策略；浏览器使用自己的硬件加速设置。");
    const active = t(PLAYBACK_MODES[data.effective] || "自动");
    const requested = t(PLAYBACK_MODES[data.requested] || "自动");
    const pending = data.restartRequired ? t("；已保存为“{mode}”，正常退出并重启应用后生效", {mode: requested}) : "";
    return t("本次启动策略：{mode}{pending}。仅影响本地图库，不改变 Grok。GPU 优先不保证每种编码都能硬解。", {mode: active, pending: pending}) + (data.warning ? " " + String(data.warning) : "");
  }
  function dedupRequest(rootPath, apply, actions, plan) {
    if (!rootPath) throw new Error(t("请先打开图库。"));
    if (apply && (!plan || plan.root !== rootPath || !plan.token)) throw new Error(t("图库或预览已变化，请重新检查重复组。"));
    return {expectedRoot: rootPath, apply: !!apply, actions: actions || {}, ...(apply ? {planToken: plan.token} : {})};
  }
  function containedSize(width, height, availableWidth, availableHeight) {
    if (![width, height, availableWidth, availableHeight].every(n => Number.isFinite(n) && n > 0)) return null;
    const ratio = Math.min(availableWidth / width, availableHeight / height);
    return { width: width * ratio, height: height * ratio };
  }
  function isImaginePostId(id) {
    return typeof id === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
  }
  function isConversationQuery(id) {
    return isImaginePostId(id) || (typeof id === "string" && /^[0-9a-f]{8}$/i.test(id));
  }
  function conversationQueryOf(item) {
    const raw = item && (item.conversationId || item.rootConversationId || item.conversation);
    if (!isConversationQuery(raw)) return "";
    const value = String(raw).toLowerCase();
    return value.length === 36 ? value.slice(0, 8) : value;
  }
  function safeRemoteUrl(raw) {
    try {
      const url = new URL(raw);
      if (url.protocol !== "https:" || url.hostname !== "grok.com" || url.port || url.username || url.password || !/^\/imagine\/post\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/?$/i.test(url.pathname)) return null;
      const conversation = url.searchParams.get("conversation");
      url.search = "";
      url.hash = "";
      if (isConversationQuery(conversation)) url.search = "?conversation=" + conversation.toLowerCase();
      return url.href;
    } catch (_) { return null; }
  }
  function remoteUrlForItem(item) {
    const stored = safeRemoteUrl(item && (item.remoteUrl || item.postUrl || item.shareUrl));
    const conversation = conversationQueryOf(item);
    if (stored) {
      if (conversation && stored.indexOf("conversation=") < 0) {
        return safeRemoteUrl(stored + "?conversation=" + conversation);
      }
      return stored;
    }
    if (!isImaginePostId(item && item.id)) return null;
    return safeRemoteUrl("https://grok.com/imagine/post/" + String(item.id).toLowerCase() + (conversation ? "?conversation=" + conversation : ""));
  }
  function cleanFailure(raw) {
    if (!raw || typeof raw !== "object") return null;
    const result = {};
    for (const name of ["assetId", "stage", "code"]) {
      const value = raw[name];
      if (typeof value !== "string" || !/^[a-zA-Z0-9_-]{1,200}$/.test(value)) return null;
      result[name] = value;
    }
    // Messages originate in fixed Rust categories, not response bodies.
    result.message = typeof raw.message === "string" ? raw.message.slice(0, 300) : raw.code;
    if (/https?:\/\/|cookie|authorization|bearer/i.test(result.message)) result.message = result.code;
    for (const name of ["attempt", "httpStatus", "expectedBytes", "receivedBytes", "elapsedMs", "nativeReason", "retryAfterSeconds"]) {
      if (Number.isSafeInteger(raw[name]) && raw[name] >= 0) result[name] = raw[name];
    }
    result.retryable = raw.retryable === true;
    const chain = cleanChain(raw.chain);
    if (chain) result.chain = chain;
    return result;
  }
  function cleanChain(raw) {
    if (!raw || typeof raw !== "object") return null;
    const result = {};
    for (const name of ["prepareFinished", "captureArmed", "clickDispatched", "nativeDownloadStartSeen", "tauriRequestedSeen", "tauriFinishedSeen", "nativeUriMatch", "tauriUrlMatch", "expectedNameMatch", "permissionDuringRun", "permissionAllowed"]) {
      if (raw[name] === true || raw[name] === false) result[name] = raw[name];
    }
    for (const name of ["nativeStateChanged", "interruptReason", "permissionKind", "permissionState"]) {
      if (Number.isSafeInteger(raw[name]) && raw[name] >= 0 && raw[name] <= 0xffffffff) result[name] = raw[name];
    }
    if (typeof raw.blobSha === "string" && /^[0-9a-f]{8,12}$/.test(raw.blobSha)) result.blobSha = raw.blobSha;
    if (raw.permissionHost === "grok.com" || raw.permissionHost === "other") result.permissionHost = raw.permissionHost;
    return Object.keys(result).length ? result : null;
  }
  function cleanPermission(raw) {
    if (!raw || typeof raw !== "object") return null;
    if (raw.host !== "grok.com" && raw.host !== "other") return null;
    const result = {host: raw.host};
    if (Number.isSafeInteger(raw.kind) && raw.kind >= 0 && raw.kind <= 32) result.kind = raw.kind;
    if (Number.isSafeInteger(raw.state) && raw.state >= 0 && raw.state <= 2) result.state = raw.state;
    if (raw.duringRun === true || raw.duringRun === false) result.duringRun = raw.duringRun;
    if (raw.allowed === true || raw.allowed === false) result.allowed = raw.allowed;
    return result;
  }
  function create(adapter) {
    const $ = id => document.getElementById(id);
    const api = adapter.api;
    let prefs = {language: "auto", saveDirectory: "", audioOutputId: "", wheelVolumeStep: 5, sidebarCollapsed: false, shortcuts: {...DEFAULT_SHORTCUTS}};
    let settingsTail = Promise.resolve(), settingsVersion = 0, audioTail = Promise.resolve(), confirmedLanguage = "auto";
    let recording = null, held = new Set(), layoutFrame = 0, volumeTimer = 0, volumeAt = 0, volumeHover = false, volumeDrag = false;
    let wheelAt = 0, dirVersion = 0, browsePath = "", guestRestore = false, nativeMuted = null;
    let failures = [], report = null, reportRun = 0, downloadRoot = "", copying = false, openingRemote = false, reloadingLibrary = false;
    let dedupPlan = null, dedupBusy = false, playbackVersion = 0, playbackRequested = "auto", playbackSupported = false;
    let coverVersion = 0, coverConfirmed = null, coverTail = Promise.resolve();
    let modalGeneration = 0, settingsOpening = false, guestModeTail = Promise.resolve();
    const error = message => { const text = root.GivI18n.message(message); $("settingsMessage").textContent = text; adapter.status(text, true); };
    const notice = message => { $("playerNotice").textContent = root.GivI18n.message(message); $("playerNotice").hidden = false; };
    function native(name, args) {
      if (!(root.viewer && typeof root.viewer[name] === "function")) return Promise.reject(new Error(t("当前桌面外壳尚不支持此操作。")));
      return Promise.resolve(root.viewer[name](args));
    }
    function updateVolume() {
      const volume = adapter.volume();
      $("cpVolume").value = String(volume.level);
      $("cpVolume").setAttribute("aria-valuetext", volume.muted ? t("已静音") : volume.level + "%");
      $("cpMute").title = volume.muted ? t("取消静音（M）") : t("静音（M）");
      const mute = volume.muted || volume.level === 0;
      if (root.viewer && root.viewer.setGuestMuted && nativeMuted !== mute) {
        nativeMuted = mute;
        void root.viewer.setGuestMuted(mute).catch(() => { nativeMuted = null; });
      }
    }
    function volumeKeep() {
      return volumeHover || volumeDrag || $("cpVolumeBox").matches(":focus-within") && [$("cpVolume"), $("cpMute")].some(node => node.matches(":focus-visible"));
    }
    function fadeVolume() {
      clearTimeout(volumeTimer);
      if (volumeKeep()) return;
      const wait = 2000 - (performance.now() - volumeAt);
      if (wait > 0) { volumeTimer = setTimeout(fadeVolume, wait); return; }
      $("cpVolumeBox").classList.remove("volume-visible");
      $("cpVolume").tabIndex = -1;
    }
    function showVolume(adjusted) {
      if (adjusted) volumeAt = performance.now();
      $("cpVolumeBox").classList.add("volume-visible"); $("cpVolume").tabIndex = 0;
      clearTimeout(volumeTimer); volumeTimer = setTimeout(fadeVolume, 2000);
    }
    function adjustVolume(delta) {
      const current = adapter.volume();
      adapter.setVolume({level: Math.max(0, Math.min(100, current.level + delta)), muted: false});
      showVolume(true);
    }
    function mediaDimensions() {
      const item = adapter.item(); if (!item) return null;
      const media = item.media === "video" ? $("cpVideo") : $("cpImage");
      const width = item.media === "video" ? media.videoWidth : media.naturalWidth;
      const height = item.media === "video" ? media.videoHeight : media.naturalHeight;
      return width > 0 && height > 0 ? {width, height} : null;
    }
    function layout() {
      if (layoutFrame) return;
      layoutFrame = requestAnimationFrame(() => {
        layoutFrame = 0;
        if (!adapter.previewOpen()) return;
        const stage = $("cpStage"), frame = $("cpMediaFrame"), size = mediaDimensions();
        const fit = containedSize(size ? size.width : 16, size ? size.height : 9, Math.max(1, stage.clientWidth - 24), Math.max(1, stage.clientHeight - 24));
        if (fit) { frame.style.width = fit.width + "px"; frame.style.height = fit.height + "px"; }
      });
    }
    function applyPrefs(next) {
      prefs = {...prefs, ...next, shortcuts: {...DEFAULT_SHORTCUTS, ...(next.shortcuts || prefs.shortcuts)}};
      root.GivI18n.setPreference(prefs.language);
      $("saveDirectory").value = prefs.saveDirectory;
      $("wheelStep").value = String(prefs.wheelVolumeStep);
      $("comboPreview").classList.toggle("side-collapsed", !!prefs.sidebarCollapsed);
      $("cpSide").inert = !!prefs.sidebarCollapsed;
      $("cpSideToggle").setAttribute("aria-expanded", String(!prefs.sidebarCollapsed));
      $("cpSideToggle").title = prefs.sidebarCollapsed ? t("展开侧栏") : t("折叠侧栏");
      paintShortcuts(); layout();
    }
    function savePrefs(patch) {
      $("settingsMessage").textContent = "";
      const generation = ++settingsVersion;
      applyPrefs({...prefs, ...patch, shortcuts: {...prefs.shortcuts, ...(patch.shortcuts || {})}});
      const task = settingsTail.then(async () => {
        const data = await api("/api/preferences", {method: "PUT", headers: {"Content-Type": "application/json"}, body: JSON.stringify(patch)});
        if (!data || !data.ok) throw new Error(data && data.error || t("设置保存失败。"));
        confirmedLanguage = root.GivI18n.normalize(data.preferences.language);
        if (generation === settingsVersion) applyPrefs(data.preferences);
        return data;
      });
      settingsTail = task.catch(() => null);
      return task.catch(async err => {
        if (Object.hasOwn(patch, "language") && prefs.language === patch.language) applyPrefs({...prefs, language: confirmedLanguage});
        error(String(err.message || err));
        if (generation === settingsVersion) {
          try { const data = await api("/api/preferences"); if (data.ok) applyPrefs(data.preferences); } catch (_) {}
        }
        return null;
      });
    }
    async function setAudio(id, persist) {
      const request = String(id || "");
      audioTail = audioTail.catch(() => {}).then(async () => {
        try {
          for (const element of [$("cpVideo"), $("lbVideo")]) {
            if (typeof element.setSinkId !== "function") {
              if (request) throw new Error(t("系统 WebView2 不支持选择音频输出；使用系统默认。"));
              continue;
            }
            await element.setSinkId(request);
          }
          if (persist) await savePrefs({audioOutputId: request});
          $("audioOutput").value = request;
        } catch (_) {
          for (const element of [$("cpVideo"), $("lbVideo")]) {
            if (typeof element.setSinkId === "function") await element.setSinkId("").catch(() => {});
          }
          $("audioOutput").value = "";
          await savePrefs({audioOutputId: ""});
          error(t("无法使用该音频设备，已回退系统默认。未申请麦克风权限。"));
        }
      });
      return audioTail;
    }
    async function listAudio() {
      const select = $("audioOutput"); select.replaceChildren(new Option(t("系统默认"), ""));
      if (!(navigator.mediaDevices && navigator.mediaDevices.enumerateDevices && typeof $("cpVideo").setSinkId === "function")) {
        select.disabled = true; $("audioAuthorize").hidden = true;
        $("audioHint").textContent = t("当前 WebView2 仅提供系统默认输出。"); return;
      }
      try {
        const devices = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === "audiooutput" && d.deviceId && d.deviceId !== "default");
        for (const [index, device] of devices.entries()) select.add(new Option(device.label || t("音频设备 {count}", {count: index + 1}), device.deviceId));
        $("audioAuthorize").hidden = typeof navigator.mediaDevices.selectAudioOutput !== "function";
        $("audioHint").textContent = t("仅控制本地播放器。Grok 网页沿用系统默认设备；不请求麦克风权限。");
        select.value = prefs.audioOutputId;
        if (select.selectedIndex < 0) { select.value = ""; if (prefs.audioOutputId) await setAudio("", true); }
      } catch (_) { $("audioHint").textContent = t("无法枚举音频设备；仍可使用系统默认输出。"); }
    }
    function cancelRecord() {
      recording = null; held.clear(); paintShortcuts();
    }
    function recordKey(ev, down) {
      if (!recording) return false;
      ev.preventDefault(); ev.stopImmediatePropagation();
      if (ev.key === "Escape" || ev.isComposing) { cancelRecord(); return true; }
      if (down) {
        if (ev.repeat) return true;
        recording.pressed.add(ev.code); recording.seen.add(ev.code);
        recording.started = true; recording.button.textContent = [...recording.seen].map(code => MODIFIER_CODES[code] || prettyChord(code)).join(" + ");
      } else {
        recording.pressed.delete(ev.code);
        if (recording.started && recording.pressed.size === 0) {
          const {action, seen} = recording; cancelRecord();
          const chord = normalizeChord([...seen]);
          if (!chord) error(t("请选择包含普通按键、且未被系统保留的组合。"));
          else if (Object.entries(prefs.shortcuts).some(([name, value]) => name !== action && value === chord)) error(t("此快捷键已绑定其他操作。"));
          else void savePrefs({shortcuts: {[action]: chord}});
        }
      }
      return true;
    }
    function paintShortcuts() {
      if (recording) return;
      const list = $("hotkeyList"); list.replaceChildren();
      for (const [action, label] of Object.entries(LABELS)) {
        const row = document.createElement("div"); row.className = "shortcut-row";
        const name = document.createElement("span"); name.textContent = t(label);
        const button = document.createElement("button"); button.type = "button"; button.className = "key-record"; button.textContent = prettyChord(prefs.shortcuts[action]); button.setAttribute("aria-label", t("录制：{action}", {action: t(label)}));
        button.addEventListener("click", () => { cancelRecord(); const current = list.querySelector('[data-action="' + action + '"]'); current.focus(); recording = {action, button: current, seen: new Set(), pressed: new Set(), started: false}; current.textContent = t("按下组合键…"); });
        button.dataset.action = action;
        const reset = document.createElement("button"); reset.type = "button"; reset.textContent = t("默认");
        reset.addEventListener("click", () => { cancelRecord(); void savePrefs({shortcuts: {[action]: DEFAULT_SHORTCUTS[action]}}); });
        row.append(name, button, reset); list.appendChild(row);
      }
    }
    function queueGuestMode(mode, current) {
      const task = guestModeTail.catch(() => null).then(() => current() ? native("setMode", mode) : null);
      guestModeTail = task.catch(() => null);
      return task;
    }
    async function openSettings() {
      if ($("settingsDialog").open || settingsOpening) return;
      settingsOpening = true;
      const generation = ++modalGeneration;
      $("settingsMessage").textContent = "";
      // Native child webviews are above the DOM. Hide (do not navigate) the
      // guest while the independent dialog is open, then restore its mode.
      guestRestore = adapter.mode() === "grok";
      try {
      if (guestRestore && root.viewer && root.viewer.setMode) await queueGuestMode("gallery", () => generation === modalGeneration);
      if (generation !== modalGeneration) return;
      $("settingsDialog").showModal();
      await Promise.all([listAudio(), loadPlaybackAccel(), loadCoverAccel()]);
      } finally { if (generation === modalGeneration) settingsOpening = false; }
    }
    function coverRequest(options) {
      const task = coverTail.catch(() => null).then(() => api("/api/accel", options));
      coverTail = task.catch(() => null);
      return task;
    }
    function paintCoverAccel(data) {
      coverConfirmed = data;
      $("accelToggle").checked = data.mode !== "compat";
      $("accelToggle").disabled = false;
      const selector = $("accelBackend");
      selector.value = data.backendPreference || "auto";
      selector.disabled = data.mode === "compat" || !data.covers;
      for (const option of selector.options) {
        option.disabled = option.value !== "auto" && !(data.availableBackends || []).includes(option.value);
      }
      $("accelHint").textContent = coverAccelText(data);
    }
    async function loadCoverAccel() {
      const version = ++coverVersion;
      $("accelToggle").disabled = $("accelBackend").disabled = true;
      try {
        const data = await coverRequest();
        if (version === coverVersion) paintCoverAccel(data);
      } catch (_) {
        if (version === coverVersion) $("accelHint").textContent = t("无法读取封面加速状态；未更改设置。");
      }
    }
    async function saveCoverAccel() {
      const version = ++coverVersion;
      const patch = {mode: $("accelToggle").checked ? "auto" : "compat", backend: $("accelBackend").value};
      $("accelToggle").disabled = $("accelBackend").disabled = true;
      try {
        const data = await coverRequest({method: "PUT", headers: {"Content-Type": "application/json"}, body: JSON.stringify(patch)});
        if (!data || !data.ok) throw new Error(data && data.error || t("封面设置保存失败。"));
        if (version === coverVersion) { paintCoverAccel(data); adapter.accelChanged(data); }
      } catch (err) {
        if (version === coverVersion) {
          if (coverConfirmed) paintCoverAccel(coverConfirmed);
          error(String(err.message || err));
        }
      }
    }
    function paintPlaybackAccel(data) {
      paintPlaybackAccel.lastData = data;
      playbackSupported = !!(data && data.supported);
      playbackRequested = data && Object.hasOwn(PLAYBACK_MODES, data.requested) ? data.requested : "auto";
      $("playbackAccel").value = playbackRequested;
      $("playbackAccel").disabled = !playbackSupported;
      $("playbackAccelHint").textContent = playbackAccelText(data);
    }
    async function loadPlaybackAccel() {
      const version = ++playbackVersion;
      $("playbackAccel").disabled = true;
      if (!(root.viewer && typeof root.viewer.getPlaybackAcceleration === "function")) { paintPlaybackAccel(null); return; }
      try {
        const data = await native("getPlaybackAcceleration");
        if (version === playbackVersion) paintPlaybackAccel(data);
      } catch (_) {
        if (version === playbackVersion) { playbackSupported = false; $("playbackAccelHint").textContent = t("无法读取播放器策略，未更改设置。"); }
      }
    }
    async function savePlaybackAccel(mode) {
      if (!playbackSupported || !Object.hasOwn(PLAYBACK_MODES, mode)) return;
      const version = ++playbackVersion;
      $("playbackAccel").disabled = true;
      try { const data = await native("setPlaybackAcceleration", mode); if (version === playbackVersion) paintPlaybackAccel(data); }
      catch (err) { if (version === playbackVersion) { $("playbackAccel").value = playbackRequested; error(t("播放器策略保存失败：") + String(err.message || err)); } }
      finally { if (version === playbackVersion) $("playbackAccel").disabled = !playbackSupported; }
    }
    function closeSettings() {
      cancelRecord();
      const generation = ++modalGeneration;
      ++playbackVersion;
      ++coverVersion;
      settingsOpening = false;
      if ($("dedupDialog") && $("dedupDialog").open) $("dedupDialog").close();
      if (guestRestore && root.viewer && root.viewer.setMode) {
        void queueGuestMode("grok", () => generation === modalGeneration && !$("settingsDialog").open && !settingsOpening && !adapter.downloadBusy()).catch(error);
      }
      guestRestore = false;
    }
    function dedupActionLabel(group) {
      return group.identical ? "keep_newest" : "skip";
    }
    function paintDedupGroups(groups) {
      const list = $("dedupList");
      list.replaceChildren();
      for (const group of groups) {
        const row = document.createElement("article");
        row.className = "dedup-group";
        const title = document.createElement("strong");
        title.textContent = t("{folder} · 旧组 {count} 个", {folder: group.keep && group.keep.folder, count: (group.others || []).length});
        const detail = document.createElement("p");
        detail.textContent = group.oversized
          ? t("这组过大，已跳过以免误删正式组合。")
          : group.identical
            ? t("完整内容核对相同，将隔离旧副本，不标记正式素材为已删除。")
            : (t("同名异内容 {conflicts} 项，旧组独有 {unique} 项（默认跳过）。合并只复制媒体，不合并原 card 元数据。", {conflicts: (group.conflicts || []).length, unique: (group.uniqueOthers || []).length}));
        const select = document.createElement("select");
        select.dataset.key = group.key;
        [["keep_newest", t("仅隔离完全相同的旧副本")], ["merge", t("显式合并媒体副本（保留原 card，可恢复）")], ["skip", t("跳过")]].forEach(([value, label]) => {
          select.add(new Option(label, value));
        });
        select.value = group.oversized ? "skip" : dedupActionLabel(group);
        if (group.oversized) select.disabled = true;
        row.append(title, detail, select);
        list.appendChild(row);
      }
    }
    async function runDedup(apply, actions) {
      const rootPath = adapter.root();
      const payload = dedupRequest(rootPath, apply, actions, dedupPlan);
      if (apply) dedupPlan = null;
      const data = await api("/api/library/dedup", {method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify(payload)});
      if (!data || !data.ok) throw new Error(data && data.error || t("去重失败。"));
      if (adapter.root() !== rootPath) throw new Error(t("图库已切换，请重新检查重复组。"));
      if (!apply) dedupPlan = {root: rootPath, token: data.planToken, groups: data.groups || []};
      return data;
    }
    function setDedupBusy(value) {
      dedupBusy = value;
      $("dedupScan").disabled = value;
      $("dedupApply").disabled = value || !(dedupPlan && dedupPlan.token);
    }
    async function applyDedup(actions) {
      if (dedupBusy) return;
      setDedupBusy(true);
      $("settingsMessage").textContent = t("正在修复重复组…");
      try {
        const data = await runDedup(true, actions);
        if (typeof adapter.reloadLibrary === "function") await adapter.reloadLibrary();
        const moved = (data.moved || []).length;
        const errors = data.errors || [];
        const detail = errors.slice(0, 3).map(entry => String(entry.error || entry.message || entry).slice(0, 250)).join("；");
        $("settingsMessage").textContent = t("已隔离 {count} 个旧副本，可在回收站恢复。", {count: moved}) + (errors.length ? t("失败 {count} 项：{detail}", {count: errors.length, detail: detail}) : t("未改动正式素材的删除状态。"));
        adapter.status($("settingsMessage").textContent, errors.length > 0);
        if ($("dedupDialog").open) $("dedupDialog").close();
      } finally { setDedupBusy(false); }
    }
    async function scanDedup() {
      if (dedupBusy) return;
      setDedupBusy(true);
      dedupPlan = null;
      $("settingsMessage").textContent = t("正在对比重复组…");
      try {
      const data = await runDedup(false);
      const groups = (data.groups || []).filter(group => !group.oversized);
      if (data.oversized) {
        $("settingsMessage").textContent = t("有 {count} 组过大，已跳过以免误伤正式组合。", {count: data.oversized});
      }
      if (!groups.length) {
        if (!data.oversized) $("settingsMessage").textContent = t("没有发现可清理的旧下载组。");
        return;
      }
      const leftover = data.leftoverFolders || groups.reduce((n, group) => n + (group.others || []).length, 0);
      const files = data.wouldTrash || groups.reduce((n, group) => n + (group.wouldTrash || 0), 0);
      const mixed = groups.filter(group => !group.identical);
      $("dedupSummary").textContent = t("本次展示 {groups} 组；扫描发现 {folders} 个旧目录、约 {files} 个文件，其中本页 {mixed} 组内容不同（默认跳过）。仅执行本页明确选择，未展示组不处理。预览后文件变化需重新检查。", {groups: groups.length, folders: leftover, files: files, mixed: mixed.length});
      paintDedupGroups(data.groups || []);
      $("dedupDialog").showModal();
      if (!data.oversized) $("settingsMessage").textContent = "";
      } finally { setDedupBusy(false); }
    }
    async function browseDirectory(path = prefs.saveDirectory) {
      const generation = ++dirVersion;
      browsePath = "";
      $("saveDirUse").disabled = true;
      $("saveDirPath").textContent = path || t("此电脑");
      $("saveDirList").replaceChildren();
      $("saveDirError").textContent = t("读取目录…");
      try {
        const data = await api("/api/browse?path=" + encodeURIComponent(path));
        if (generation !== dirVersion || !$("saveDirDialog").open) return;
        if (!data.ok) throw new Error(data.error || t("无法读取目录。"));
        browsePath = data.selectable === true && typeof data.path === "string" ? data.path : "";
        $("saveDirUse").disabled = !browsePath;
        $("saveDirPath").textContent = data.kind === "computer" ? t("此电脑") : data.path;
        $("saveDirError").textContent = "";
        const list = $("saveDirList"); list.replaceChildren();
        const add = (name, target) => { const b = document.createElement("button"); b.type = "button"; b.textContent = name; b.addEventListener("click", () => void browseDirectory(target)); list.appendChild(b); };
        if (typeof data.parent === "string" && data.parent !== data.path) add(data.parent === "" ? t("↑ 此电脑") : t("↑ 上一级"), data.parent);
        for (const entry of data.dirs || []) add(entry.name, entry.path);
      } catch (err) {
        if (generation === dirVersion && $("saveDirDialog").open) {
          browsePath = ""; $("saveDirUse").disabled = true;
          $("saveDirError").textContent = String(err.message || err);
        }
      }
    }
    async function useSaveDirectory() {
      if (!browsePath || $("saveDirUse").disabled || !$("saveDirDialog").open) return;
      const generation = dirVersion, path = browsePath;
      $("saveDirUse").disabled = true;
      try {
        const result = await savePrefs({saveDirectory: path});
        if (result && generation === dirVersion && $("saveDirDialog").open) $("saveDirDialog").close();
      } finally {
        if (generation === dirVersion && $("saveDirDialog").open) $("saveDirUse").disabled = !browsePath;
      }
    }
    function openMore() {
      const menu = $("cpMoreMenu"), item = adapter.item(); if (!item) return;
      menu.hidden = !menu.hidden; $("cpMore").setAttribute("aria-expanded", String(!menu.hidden));
      $("cpDelete").textContent = item.media === "video" ? t("删除视频") : t("删除图片");
      $("cpTagList").hidden = true;
    }
    function closeMore() { $("cpMoreMenu").hidden = true; $("cpMore").setAttribute("aria-expanded", "false"); }
    function showTags() {
      const item = adapter.item(); if (!item) return;
      const targetRoot = adapter.root(), list = $("cpTagList"); list.replaceChildren();
      const flags = adapter.flags(item);
      for (const tag of adapter.tags()) {
        const button = document.createElement("button"); button.type = "button"; button.textContent = (flags.tags.includes(tag) ? "✓ " : "") + tag;
        button.addEventListener("click", () => {
          if (adapter.root() !== targetRoot) return;
          const current = adapter.flags(item).tags;
          closeMore(); void adapter.setTags(item, current.includes(tag) ? current.filter(t => t !== tag) : [...current, tag], targetRoot).catch(err => notice(String(err.message || err)));
        }); list.appendChild(button);
      }
      const add = document.createElement("button"); add.type = "button"; add.textContent = t("＋ 新建标签");
      add.addEventListener("click", () => { closeMore(); if (adapter.root() === targetRoot) adapter.newTag(item); }); list.appendChild(add); list.hidden = false;
    }
    async function saveCopy() {
      if (copying) return;
      const item = adapter.item(), currentRoot = adapter.root(); if (!item) return;
      copying = true; $("cpSave").disabled = true; notice(t("正在从图库复制到另存为目录…"));
      try {
        const result = await api("/api/save-copy", {method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify({expectedRoot: currentRoot, id: item.id, section: item.section, folder: item.folder || ""})});
        if (!result || !result.ok) throw new Error(result && result.error || t("另存为失败。"));
        if (adapter.root() === currentRoot && adapter.item() && adapter.item().id === item.id) notice(t("已复制到：") + result.path);
        else adapter.status(t("另存为已完成：") + result.name);
      } catch (err) {
        if (adapter.root() === currentRoot) notice(String(err.message || err));
        else adapter.status(t("另存为失败：") + String(err.message || err), true);
      }
      finally { copying = false; $("cpSave").disabled = false; }
    }
    async function reloadLibrary() {
      if (reloadingLibrary) return;
      if (typeof adapter.reloadLibrary !== "function") throw new Error(t("当前界面不能重新加载图库。"));
      reloadingLibrary = true;
      if ($("libraryReload")) $("libraryReload").disabled = true;
      $("settingsMessage").textContent = t("正在重新加载图库…");
      try {
        await adapter.reloadLibrary();
        $("settingsMessage").textContent = t("图库已重新加载。");
        adapter.status(t("图库已重新加载。"));
      } finally {
        reloadingLibrary = false;
        if ($("libraryReload")) $("libraryReload").disabled = false;
      }
    }
    async function openRemote() {
      const item = adapter.item(); if (!item || openingRemote) return;
      if (adapter.downloadBusy()) { notice(t("请先停止下载，再打开 Grok 作品页。")); return; }
      const url = remoteUrlForItem(item);
      if (!url) { notice(t("此素材没有可用的 Grok 作品页地址。")); return; }
      openingRemote = true;
      try { const result = await native("openGrokMedia", url); if (result && result.ok === false) throw new Error(result.error); adapter.remoteOpened(result); } catch (err) { notice(String(err.message || err)); }
      finally { openingRemote = false; }
    }
    async function resize(scale) {
      const size = mediaDimensions(); if (!size) { notice(t("媒体尺寸尚未就绪。")); return; }
      if (document.fullscreenElement) await document.exitFullscreen();
      const stage = $("cpStage");
      try { await native("resizeForMedia", {width: size.width, height: size.height, scale, extraWidth: Math.max(0, window.innerWidth - stage.clientWidth) + 24, extraHeight: Math.max(0, window.innerHeight - stage.clientHeight) + 24}); }
      catch (err) { notice(String(err.message || err)); }
    }
    function handleKey(ev) {
      if (recordKey(ev, true)) return;
      if (ev.isComposing || ev.defaultPrevented) return;
      if (document.querySelector("dialog[open]") || !$("tagDialog").hidden || !$("browser").hidden) return;
      held.add(ev.code);
      const chord = eventChord(ev, held);
      const action = Object.keys(prefs.shortcuts).find(name => prefs.shortcuts[name] === chord);
      if (!action) return;
      if (ev.repeat && !SEEK_REPEAT.has(action)) return;
      const slider = ev.target && ["cpSeek", "cpVolume"].includes(ev.target.id);
      if (editable(ev.target) && !(slider && ["setA", "setB", "clearAB", "loop", "mute", "play", "seekBack", "seekForward", "seekBackFar", "seekForwardFar", "previousGroup", "nextGroup", "previousFrame", "nextFrame", "previousItem", "nextItem"].includes(action))) return;
      if (!adapter.previewOpen() && !["mute", "fullscreen"].includes(action)) return;
      ev.preventDefault(); ev.stopImmediatePropagation();
      if (action.startsWith("size")) { void resize(action === "size50" ? .5 : action === "size100" ? 1 : 1.5); return; }
      if (action === "fullscreen") {
        void (async () => { if (document.fullscreenElement) await document.exitFullscreen(); await native("toggleWindowFullscreen"); })().catch(err => error(String(err.message || err))); return;
      }
      if (action === "mute") { adapter.setVolume({muted: !adapter.volume().muted}); showVolume(true); return; }
      if (typeof adapter.actions[action] === "function") adapter.actions[action]();
    }
    function drawFailures() {
      const list = $("failureList"); list.replaceChildren();
      const counts = report && report.counts || {};
      $("failureSummary").textContent = t("失败 {count} 项；展示 {shown} 项（最多 200 项）。不包含登录凭据或下载签名地址。", {count: counts.failed == null ? failures.length : counts.failed, shown: failures.length});
      for (const failure of failures) {
        const row = document.createElement("article");
        const title = document.createElement("strong"); title.textContent = failure.assetId;
        const body = document.createElement("p"); body.textContent = root.GivI18n.message(failure.message);
        const chain = failure.chain || {};
        const meta = document.createElement("code"); meta.textContent = [failure.stage, failure.code, t("尝试 ") + failure.attempt, failure.httpStatus && "HTTP " + failure.httpStatus, failure.nativeReason != null && t("WebView2 中断码 ") + failure.nativeReason, failure.expectedBytes != null && t("预期 ") + failure.expectedBytes + " B", failure.receivedBytes != null && t("实收 ") + failure.receivedBytes + " B", failure.elapsedMs != null && failure.elapsedMs + " ms", chain.nativeDownloadStartSeen ? "nativeStart" : "noNativeStart", chain.tauriRequestedSeen ? "tauriReq" : chain.tauriRequestedSeen === false ? "noTauriReq" : null, chain.tauriFinishedSeen ? "tauriFin" : chain.tauriFinishedSeen === false ? "noTauriFin" : null, chain.nativeStateChanged != null ? "nativeState " + chain.nativeStateChanged : (chain.nativeDownloadStartSeen || chain.tauriRequestedSeen ? "noNativeState" : null), chain.nativeUriMatch === false ? "uriMiss" : null, chain.expectedNameMatch === false ? "nameMiss" : null, chain.permissionAllowed === true ? "permAllow" : chain.permissionKind != null ? "permKind " + chain.permissionKind : null, chain.blobSha && "blob " + chain.blobSha].filter(v => v !== false && v != null && v !== "").join(" · ");
        row.append(title, body, meta); list.appendChild(row);
      }
    }
    function recordFailure(raw) {
      const entry = cleanFailure(raw); if (!entry) return;
      const at = failures.findIndex(f => f.assetId === entry.assetId);
      if (at >= 0) failures[at] = entry;
      else if (failures.length < 200) failures.push(entry);
      $("dlDetails").hidden = false; $("dlDetails").textContent = t("失败详情 {count}", {count: failures.length});
      $("dlDetails").title = entry.message;
      if ($("downloadDetails").open) drawFailures();
    }
    for (const [id, name] of [["settingsBtn", "settings"], ["cpFs", "fullscreen"], ["cpSideToggle", "sidebar"], ["cpSave", "download"], ["cpMore", "more"]]) $(id).replaceChildren(icon(name));
    for (const id of ["launcherLanguage", "settingsLanguage"]) {
      $(id).addEventListener("change", async () => {
        for (const control of ["launcherLanguage", "settingsLanguage"]) $(control).disabled = true;
        try { await savePrefs({language: $(id).value}); }
        finally { for (const control of ["launcherLanguage", "settingsLanguage"]) $(control).disabled = false; }
      });
    }
    root.GivI18n.subscribe(() => {
      paintShortcuts(); updateVolume();
      $("cpSideToggle").title = prefs.sidebarCollapsed ? t("展开侧栏") : t("折叠侧栏");
      if (coverConfirmed) $("accelHint").textContent = coverAccelText(coverConfirmed);
      if (Object.hasOwn(paintPlaybackAccel, "lastData")) $("playbackAccelHint").textContent = playbackAccelText(paintPlaybackAccel.lastData);
      if (failures.length) {
        $("dlDetails").textContent = t("失败详情 {count}", {count: failures.length});
        if ($("downloadDetails").open) drawFailures();
      }
      for (const id of ["settingsMessage", "playerNotice", "saveDirError", "dedupSummary"]) {
        const node = $(id); node.textContent = root.GivI18n.message(node.textContent);
      }
      // Refresh labels without enumerating devices, changing playback or issuing
      // native commands. Device names, folders and media content stay verbatim.
      for (const option of $("audioOutput").options) {
        if (!option.value) option.textContent = t("系统默认");
      }
      if (dedupPlan && $("dedupDialog").open) {
        const selected = [...$("dedupList").querySelectorAll("select")].map(node => node.value);
        paintDedupGroups(dedupPlan.groups || []);
        [...$("dedupList").querySelectorAll("select")].forEach((node, index) => { if (selected[index]) node.value = selected[index]; });
      }
      if (adapter.languageChanged) adapter.languageChanged();
    });
    $("settingsBtn").addEventListener("click", () => void openSettings().catch(err => error(String(err))));
    $("settingsClose").addEventListener("click", () => $("settingsDialog").close());
    $("libraryReload").addEventListener("click", () => void reloadLibrary().catch(err => error(String(err.message || err))));
    $("dedupScan").addEventListener("click", () => void scanDedup().catch(err => error(String(err.message || err))));
    $("dedupClose").addEventListener("click", () => $("dedupDialog").close());
    $("dedupApply").addEventListener("click", () => {
      const actions = {};
      $("dedupList").querySelectorAll("select[data-key]").forEach(select => { actions[select.dataset.key] = select.value; });
      void applyDedup(actions).catch(err => {
        const message = String(err.message || err);
        $("dedupSummary").textContent = message + t(" 请关闭此窗口后重新检查。");
        error(message);
      });
    });
    $("settingsDialog").addEventListener("close", closeSettings);
    $("settingsDialog").addEventListener("cancel", cancelRecord);
    bindDialogBackdrop($("settingsDialog"));
    bindDialogBackdrop($("downloadDetails"));
    $("settingsDialog").addEventListener("focusout", () => { if (recording) queueMicrotask(() => { if (recording && document.activeElement !== recording.button) cancelRecord(); }); });
    $("saveDirectory").addEventListener("change", ev => void savePrefs({saveDirectory: ev.target.value}));
    $("wheelStep").addEventListener("change", ev => void savePrefs({wheelVolumeStep: Number(ev.target.value)}));
    $("playbackAccel").addEventListener("change", ev => void savePlaybackAccel(ev.target.value));
    $("accelToggle").addEventListener("change", () => void saveCoverAccel());
    $("accelBackend").addEventListener("change", () => void saveCoverAccel());
    $("audioOutput").addEventListener("change", ev => void setAudio(ev.target.value, true));
    $("audioAuthorize").addEventListener("click", async () => {
      try { const device = await navigator.mediaDevices.selectAudioOutput(); await setAudio(device.deviceId, true); await listAudio(); } catch (_) { error(t("没有获得音频输出设备授权，保留当前设备。")); }
    });
    if (navigator.mediaDevices && navigator.mediaDevices.addEventListener) navigator.mediaDevices.addEventListener("devicechange", () => void listAudio());
    $("saveBrowse").addEventListener("click", () => { $("saveDirDialog").showModal(); void browseDirectory(prefs.saveDirectory); });
    $("saveDirClose").addEventListener("click", () => $("saveDirDialog").close());
    $("saveDirDialog").addEventListener("close", () => { dirVersion++; browsePath = ""; $("saveDirUse").disabled = true; });
    $("saveDirUse").addEventListener("click", () => void useSaveDirectory());
    $("cpSideToggle").addEventListener("click", () => void savePrefs({sidebarCollapsed: !prefs.sidebarCollapsed}));
    $("cpMore").addEventListener("click", ev => { ev.stopPropagation(); openMore(); });
    $("cpAddTag").addEventListener("click", showTags);
    $("cpDislike").addEventListener("click", closeMore);
    $("cpDelete").addEventListener("click", () => { closeMore(); const item = adapter.item(); if (item) void adapter.deleteItem(item); });
    $("cpSave").addEventListener("click", () => void saveCopy());
    $("cpOpenRemote").addEventListener("click", () => void openRemote());
    document.addEventListener("click", ev => { if (!ev.target.closest("#cpMoreMenu,#cpMore")) closeMore(); });
    $("cpVolumeBox").addEventListener("pointerenter", () => { volumeHover = true; showVolume(false); });
    $("cpVolumeBox").addEventListener("pointerleave", () => { volumeHover = false; fadeVolume(); });
    $("cpVolumeBox").addEventListener("focusin", () => showVolume(false));
    $("cpVolumeBox").addEventListener("focusout", () => setTimeout(fadeVolume, 0));
    $("cpVolume").addEventListener("pointerdown", () => { volumeDrag = true; showVolume(false); });
    window.addEventListener("pointerup", () => { volumeDrag = false; fadeVolume(); });
    window.addEventListener("pointercancel", () => { volumeDrag = false; fadeVolume(); });
    $("cpVolume").addEventListener("input", ev => { adapter.setVolume({level: Number(ev.target.value), muted: false}); showVolume(true); });
    $("cpMediaFrame").addEventListener("wheel", ev => {
      if (!adapter.previewOpen() || ev.ctrlKey || document.querySelector("dialog[open]")) return;
      if (!ev.deltaY) return; ev.preventDefault(); ev.stopPropagation();
      const now = performance.now(); if (now - wheelAt < 45) return; wheelAt = now;
      adjustVolume((ev.deltaY < 0 ? 1 : -1) * prefs.wheelVolumeStep);
    }, {passive: false});
    $("cpScrub").addEventListener("pointerenter", () => $("cpScrubWrap").classList.add("seek-hover"));
    $("cpScrubWrap").addEventListener("pointerleave", () => $("cpScrubWrap").classList.remove("seek-hover"));
    for (const media of [$("cpImage"), $("cpVideo")]) for (const event of ["load", "loadedmetadata", "resize"]) media.addEventListener(event, layout);
    new ResizeObserver(layout).observe($("cpStage"));
    document.addEventListener("fullscreenchange", layout);
    window.addEventListener("resize", layout);
    window.addEventListener("keyup", ev => { if (!recordKey(ev, false)) held.delete(ev.code); }, true);
    window.addEventListener("blur", () => { cancelRecord(); volumeDrag = false; fadeVolume(); });
    $("dlDetails").addEventListener("click", () => { drawFailures(); $("downloadDetails").showModal(); });
    $("failureClose").addEventListener("click", () => $("downloadDetails").close());
    $("failureCopy").addEventListener("click", async () => {
      const data = {schema: 1, version: root.viewer && root.viewer.shellVersion || "browser", runId: reportRun, counts: report && report.counts || null, failures, permissions: (report && report.permissions || []).map(cleanPermission).filter(Boolean)};
      try { await navigator.clipboard.writeText(JSON.stringify(data, null, 2)); $("failureCopy").textContent = t("已复制脱敏诊断"); } catch (_) { $("failureCopy").textContent = t("复制失败，请选中详情复制"); }
    });
    paintShortcuts(); updateVolume();
    return {
      handleKey, updateVolume, layout,
      async load() {
        const generation = settingsVersion;
        try {
          const data = await api("/api/preferences");
          if (!data || !data.ok) throw new Error(data && data.error || t("设置读取失败。"));
          root.GivI18n.setSystemLanguage(data.systemLanguage);
          if (generation === settingsVersion) {
            confirmedLanguage = root.GivI18n.normalize(data.preferences.language);
            applyPrefs(data.preferences);
          }
          void listAudio().then(() => setAudio(prefs.audioOutputId, false)).catch(err => error(String(err.message || err)));
        } catch (err) { error(String(err.message || err)); }
        finally { for (const id of ["launcherLanguage", "settingsLanguage"]) $(id).disabled = false; }
      },
      mediaChanged() { layout(); closeMore(); $("playerNotice").hidden = true; },
      closed() { held.clear(); closeMore(); clearTimeout(volumeTimer); $("cpVolumeBox").classList.remove("volume-visible"); },
      downloadStarted(rootPath) { failures = []; report = null; reportRun = adapter.downloadRun() + 1; downloadRoot = rootPath; $("dlDetails").hidden = true; },
      consumeDownloadStatus(raw) {
        const match = String(raw).match(/^run (\d+) diagnostic (\{.*\})$/s); if (!match) return false;
        const id = Number(match[1]);
        if (!adapter.downloadBusy() || adapter.root() !== downloadRoot || id < reportRun || id < adapter.downloadRun()) return true;
        try { reportRun = id; recordFailure(JSON.parse(match[2])); } catch (_) {}
        return true;
      },
      downloadFinished(result) { report = result || null; for (const failure of result && result.failures || []) recordFailure(failure); }
    };
  }
  root.GivPlayer = Object.freeze({create, DEFAULT_SHORTCUTS, normalizeChord, eventChord, prettyChord, containedSize, safeRemoteUrl, remoteUrlForItem, cleanFailure, cleanPermission, bindDialogBackdrop, playbackAccelText, coverAccelText, dedupRequest});
})(typeof window === "object" ? window : globalThis);
