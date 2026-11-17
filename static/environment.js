/* Startup dependencies are read-only until a user presses a fixed installer. */
(function (root) {
  "use strict";
  function validHealth(value) {
    const ffmpeg = value && value.ffmpeg, tools = ffmpeg && ffmpeg.tools;
    return !!(ffmpeg && typeof ffmpeg.ready === "boolean" && tools
      && ["ffmpeg", "ffprobe"].every(name => tools[name] && typeof tools[name].ready === "boolean"));
  }
  function validNative(value) {
    return !!(value && typeof value.supported === "boolean" && typeof value.winget === "boolean"
      && value.webview2 && typeof value.webview2.ready === "boolean" && value.install
      && ["idle", "running", "finished", "unknown"].includes(value.install.phase));
  }
  function view(health, native, failed, launching) {
    const rows = [];
    if (health && !health.ffmpeg.ready) {
      const tools = health.ffmpeg.tools;
      const missing = Object.keys(tools).filter(name => !tools[name].ready);
      rows.push({id: "ffmpeg", name: "FFmpeg / ffprobe", detail: missing.some(name => tools[name].reason !== "missing") ? "已找到组件，但无法运行" : "未安装"});
    }
    if (native && native.supported && !native.webview2.ready) rows.push({id: "webview2", name: "Microsoft Edge WebView2", detail: "未安装"});
    const install = launching ? {phase: "running", component: launching} : (native && native.install) || {};
    const busy = install.phase === "running" || install.phase === "unknown";
    let message = "将打开 PowerShell 安装窗口，请按提示完成安装。";
    if (failed) message = "环境检测失败，请重新检测。";
    else if (install.phase === "unknown") message = "无法确认安装进程状态，请检查 PowerShell 窗口后正常重启应用。";
    else if (busy) message = "请在 PowerShell 窗口中完成安装，完成后会自动重新检测。";
    else if (install.phase === "finished" && rows.some(row => row.id === install.component)) message = install.exitCode === 0
      ? "安装已结束，仍未检测到组件。请重新检测或重启应用。" : "安装未完成，请查看 PowerShell 提示后重试。";
    else if (!native || !native.supported) message = "请在 Windows 桌面应用中安装组件。";
    else if (!native.winget) message = "未检测到 winget，请先从 Microsoft Store 安装或更新“应用安装程序”，再重新检测。";
    if (native && native.simulation) message = busy ? "模拟安装中，不会更改系统组件。" : "环境模拟版：按钮仅演示安装，重启后重置。";
    return {rows, busy, component: install.component, visible: !!(rows.length || failed), heading: failed ? "环境检测失败" : native && native.simulation ? "缺失环境（模拟）" : "缺失环境",
      message, canInstall: !!(native && native.supported && native.winget && !busy && !failed)};
  }

  function create({api, bridge, document = root.document, events = root, schedule = root.setTimeout.bind(root), cancel = root.clearTimeout.bind(root)}) {
    const panel = document.getElementById("environmentPanel");
    if (!panel) return null;
    const launcher = document.getElementById("launcher"), list = document.getElementById("environmentComponents");
    const refreshButton = document.getElementById("environmentRefresh");
    const t = (...args) => root.GivI18n.t(...args);
    const nodes = new Map();
    let health = null, native = null, failed = false, checking = false, launching = "", installError = false;
    let generation = 0, timer = null, disposed = false;
    const hasNative = !!(bridge && bridge.shell === "tauri" && Array.isArray(bridge.capabilities)
      && ["getEnvironmentStatus", "installEnvironmentComponent"].every(name => bridge.capabilities.includes(name) && typeof bridge[name] === "function"));
    function paint() {
      const state = view(health, native, failed, launching);
      if (!state.visible && panel.contains(document.activeElement)) document.getElementById("launcherOpen").focus();
      panel.hidden = !state.visible;
      launcher.classList.toggle("has-environment", state.visible);
      document.getElementById("environmentHeading").textContent = t(state.heading);
      document.getElementById("environmentMessage").textContent = t(installError ? "无法打开安装窗口，请重新检测后重试。" : state.message);
      refreshButton.disabled = checking || !!launching;
      refreshButton.textContent = t(checking ? "检测中…" : "重新检测");
      for (const [id, node] of nodes) if (!state.rows.some(row => row.id === id)) { node.li.remove(); nodes.delete(id); }
      for (const row of state.rows) {
        let node = nodes.get(row.id);
        if (!node) {
          const li = document.createElement("li"), name = document.createElement("span"), detail = document.createElement("small"), button = document.createElement("button");
          li.className = "environment-component"; name.className = "environment-component-name";
          name.textContent = row.name; name.append(detail); button.type = "button"; button.className = "environment-install";
          button.addEventListener("click", () => void install(row.id));
          li.append(name, button); list.append(li); node = {li, detail, button}; nodes.set(row.id, node);
        }
        node.detail.textContent = t(row.detail);
        node.button.textContent = t(state.busy && state.component === row.id ? "安装中…" : "一键安装");
        node.button.setAttribute("aria-label", t("安装 {component}", {component: row.name}));
        node.button.disabled = !state.canInstall || checking;
      }
    }
    function poll(finalCheck = false) {
      if (timer !== null) cancel(timer);
      timer = null;
      if (!disposed && !document.hidden && (finalCheck || (native && native.install && native.install.phase === "running"))) timer = schedule(() => { timer = null; void refresh(); }, finalCheck ? 300 : 2000);
    }
    async function refresh() {
      if (disposed || launching) return;
      const current = ++generation;
      checking = true; paint();
      const results = await Promise.allSettled([Promise.resolve().then(() => api("/api/environment")),
        Promise.resolve().then(() => hasNative ? bridge.getEnvironmentStatus() : null)]);
      if (disposed || current !== generation) return;
      const wasInstalling = native && native.install && native.install.phase === "running";
      checking = false;
      health = results[0].status === "fulfilled" && validHealth(results[0].value) ? results[0].value : null;
      native = results[1].status === "fulfilled" && validNative(results[1].value) ? results[1].value : null;
      failed = !health || (hasNative && !native);
      installError = false;
      // Health and native status arrive independently. Check once more after
      // the child exits so an earlier missing-tool reply cannot win that race.
      paint(); poll(wasInstalling && native && native.install.phase === "finished");
    }
    async function install(component) {
      if (checking || launching || !view(health, native, failed, launching).canInstall || !["ffmpeg", "webview2"].includes(component)) return;
      ++generation; launching = component; installError = false; paint();
      try {
        const status = await bridge.installEnvironmentComponent(component);
        if (disposed) return;
        native = {...native, install: status};
      } catch (_) { installError = true; }
      launching = "";
      if (disposed) return;
      if (installError) { paint(); return; }
      await refresh();
    }
    function focused() { if (!document.hidden) void refresh(); }
    refreshButton.addEventListener("click", refresh);
    events.addEventListener("focus", focused);
    document.addEventListener("visibilitychange", focused);
    const unsubscribe = root.GivI18n.subscribe(paint);
    void refresh();
    return {refresh, dispose() { disposed = true; ++generation; if (timer !== null) cancel(timer); unsubscribe(); events.removeEventListener("focus", focused); document.removeEventListener("visibilitychange", focused); refreshButton.removeEventListener("click", refresh); }};
  }
  root.GivEnvironment = Object.freeze({create, view});
})(typeof window === "object" ? window : globalThis);
