import "./i18n_test_helpers.mjs";
// Behaviour tests for the gallery front end.
//
// `static/app.js` is a single zero-build IIFE with no exports, so the functions
// under test are lifted out of the real file by name and evaluated with stubbed
// collaborators. That keeps the assertions tied to shipped code instead of a
// transcribed copy, which is what an earlier review bundle had to settle for.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, "..", "static", "app.js"), "utf8");

// Brace counting alone is not enough: the code contains `"{"` string literals
// and regex literals, so the scanner has to know what it is looking at.
const REGEX_PRECEDERS = new Set([
  "(", ",", "=", ":", "[", "!", "&", "|", "?", "{", "}", ";", "\n", "+", "-", "*", "%", "<", ">", "~", "^",
]);

function extract(name, kind = "function") {
  const needles =
    kind === "function"
      ? [`  function ${name}(`, `  async function ${name}(`]
      : [`  const ${name} =`];
  let start = -1;
  for (const needle of needles) {
    start = source.indexOf(needle);
    if (start !== -1) break;
  }
  assert.notEqual(start, -1, `${name} must exist in static/app.js`);

  let depth = 0;
  let opened = false;
  let lastMeaningful = "\n";
  let index = start;

  const skipTo = (terminator, escaped) => {
    index += terminator.length;
    while (index < source.length) {
      if (escaped && source[index] === "\\") {
        index += 2;
        continue;
      }
      if (source.startsWith(terminator, index)) {
        index += terminator.length;
        return;
      }
      index += 1;
    }
  };

  while (index < source.length) {
    const char = source[index];
    if (char === '"' || char === "'" || char === "`") {
      skipTo(char, true);
      lastMeaningful = char;
      continue;
    }
    if (source.startsWith("//", index)) {
      while (index < source.length && source[index] !== "\n") index += 1;
      continue;
    }
    if (source.startsWith("/*", index)) {
      skipTo("*/", false);
      continue;
    }
    if (char === "/" && REGEX_PRECEDERS.has(lastMeaningful)) {
      index += 1;
      let inClass = false;
      while (index < source.length) {
        const inner = source[index];
        if (inner === "\\") {
          index += 2;
          continue;
        }
        if (inner === "[") inClass = true;
        else if (inner === "]") inClass = false;
        else if (inner === "/" && !inClass) {
          index += 1;
          break;
        } else if (inner === "\n") break;
        index += 1;
      }
      lastMeaningful = "/";
      continue;
    }
    if (char === "{") {
      depth += 1;
      opened = true;
    } else if (char === "}") {
      depth -= 1;
      if (opened && depth === 0) {
        const end = index + 1;
        // A `const x = {...};` declaration needs its terminator.
        return source.slice(start, source[end] === ";" ? end + 1 : end);
      }
    }
    if (!/\s/.test(char)) lastMeaningful = char;
    else if (char === "\n") lastMeaningful = "\n";
    index += 1;
  }
  throw new Error(`could not delimit ${name}`);
}

const failures = [];
function check(name, run) {
  try {
    run();
    process.stdout.write(`ok   ${name}\n`);
  } catch (error) {
    failures.push(name);
    process.stdout.write(`FAIL ${name}\n${error && error.stack ? error.stack : error}\n`);
  }
}

/* ---- T04: progress lines carry counts and a run identity ---------------- */

const parseDownloadLine = new Function(
  `${extract("parseDownloadLine")}\nreturn parseDownloadLine;`
)();

check("progress keeps the shell's success and failure counts", () => {
  const line = parseDownloadLine("run 7 download 2/3 success 1 failed 1");
  assert.equal(line.kind, "file");
  assert.equal(line.run, 7);
  assert.equal(line.current, 2);
  assert.equal(line.of, 3);
  assert.equal(line.succeeded, 1);
  assert.equal(line.failed, 1);
});

check("older progress lines are still parsed without counts", () => {
  const line = parseDownloadLine("download 2/3");
  assert.equal(line.kind, "file");
  assert.equal(line.run, 0);
  assert.equal(line.succeeded, null);
  assert.equal(line.failed, null);
});

check("plan and index lines carry the run identity", () => {
  assert.equal(parseDownloadLine("run 9 local 4 missing 2").run, 9);
  assert.equal(parseDownloadLine("run 9 local 4 missing 2").missing, 2);
  const index = parseDownloadLine("run 9 index combos 3/8");
  assert.equal(index.kind, "index");
  assert.equal(index.run, 9);
  assert.equal(index.current, 3);
});

check("list fetch notes are not swallowed as 连接 Grok", () => {
  assert.equal(parseDownloadLine("run 3 正在读取 Grok 图库列表").text, "读取清单");
  assert.equal(parseDownloadLine("run 3 list wait 45s").text, "读取清单 · 45s · 首次同步较慢");
  assert.equal(parseDownloadLine("run 3 正在确认 Grok 登录账号").text, "核对账号");
  assert.equal(parseDownloadLine("下载：登录正常，开始导出…").text, "连接 Grok");
});

check("list progress carries a running count and optional total", () => {
  const counted = parseDownloadLine("run 3 list 122/12345");
  assert.equal(counted.kind, "listcount");
  assert.equal(counted.run, 3);
  assert.equal(counted.current, 122);
  assert.equal(counted.of, 12345);
  const running = parseDownloadLine("run 3 list 122");
  assert.equal(running.kind, "listcount");
  assert.equal(running.current, 122);
  assert.equal(running.of, 0);
  assert.equal(parseDownloadLine("run 3 list reuse keep 5816").kind, "reuse");
  const probe = parseDownloadLine("run 3 probe assets.grok.com 200 4096 ranges omit 403");
  assert.equal(probe.kind, "note");
  assert.equal(probe.text, "探测 200 4096 ranges omit 403");
});

check("list progress display advances by truthful ten-item steps", () => {
  const queued = new Map();
  let timerId = 0;
  let dlListTimer = 0;
  const dlProg = { listCurrent: 0, listTarget: 0, listOf: 0 };
  const painted = [];
  const scope = {
    dlProg,
    dlListTimer,
    DL_LIST_STEP: 10,
    DL_LIST_TICK_MS: 40,
    dlBusy: true,
    dlStopping: false,
    setTimeout(callback) { const id = ++timerId; queued.set(id, callback); return id; },
    clearTimeout(id) { queued.delete(id); },
    paintDlProgress() { painted.push(dlProg.listCurrent); },
    setStatus() {},
    formatDlStatus() { return ""; },
  };
  const run = new Function(...Object.keys(scope), `
    ${extract("stopDlListAnimation")}
    ${extract("advanceDlListCount")}
    ${extract("queueDlListCount")}
    return { queueDlListCount, stopDlListAnimation };
  `)(...Object.values(scope));
  run.queueDlListCount(55, 0);
  assert.equal(dlProg.listCurrent, 10);
  run.stopDlListAnimation();
  assert.equal(queued.size, 0, "stop/end must cancel the display-only count timer");
  run.queueDlListCount(55, 0);
  while (queued.size) {
    const [id, callback] = queued.entries().next().value;
    queued.delete(id);
    callback();
  }
  assert.deepEqual(painted, [10, 20, 30, 40, 50, 55]);
  assert.equal(dlProg.listCurrent, 55);
  assert.equal(dlProg.listTarget, 55);
});

/* ---- T06: sorting compares instants and stays stable ------------------- */

function makeSortWall(mode, cards = new Map(), library = null) {
  const scope = {
    state: { cards, library, view: "combos" },
    sortMode: () => mode,
    itemFlags: (row) => ({ fav: !!row.fav, dislike: !!row.dislike }),
    groupFlags: (_section, _folder, row) => ({ fav: !!row.fav, dislike: !!row.dislike }),
    cardKey: (section, folder) => `${section || ""}/${folder || ""}`,
    libListFor: (section) =>
      !library ? [] : section === "_other" ? library.other || [] : library.combos || [],
  };
  const body = [
    extract("timeValueCache", "const"),
    extract("timeValue"),
    extract("stableRowId"),
    extract("comboCountMap"),
    extract("sortWall"),
    "return sortWall;",
  ].join("\n");
  const names = Object.keys(scope);
  return new Function(...names, body)(...names.map((name) => scope[name]));
}

const idsOf = (rows) => rows.map((row) => row.id);

check("mixed UTC offsets sort by real time, not lexically", () => {
  const rows = [
    { id: "older", created: "2026-09-10T01:00:00+09:00" },
    { id: "newer", created: "2026-09-09T23:00:00Z" },
  ];
  assert.ok(rows[0].created > rows[1].created, "the raw strings sort the wrong way");
  assert.deepEqual(idsOf(makeSortWall("desc")(rows, "group", "combos")), ["newer", "older"]);
  assert.deepEqual(idsOf(makeSortWall("asc")(rows, "group", "combos")), ["older", "newer"]);
});

check("optional fractional seconds do not reverse the order", () => {
  const rows = [
    { id: "zero", created: "2026-09-09T23:00:00Z" },
    { id: "later", created: "2026-09-09T23:00:00.250Z" },
  ];
  assert.deepEqual(idsOf(makeSortWall("desc")(rows, "group", "combos")), ["later", "zero"]);
  assert.deepEqual(idsOf(makeSortWall("asc")(rows, "group", "combos")), ["zero", "later"]);
});

check("equal dates fall back to a stable id order in both directions", () => {
  const rows = [
    { id: "b", created: "2026-09-09T23:00:00Z" },
    { id: "a", created: "2026-09-09T23:00:00Z" },
    { id: "c", created: "2026-09-09T23:00:00Z" },
  ];
  assert.deepEqual(idsOf(makeSortWall("desc")(rows, "group", "combos")), ["a", "b", "c"]);
  assert.deepEqual(idsOf(makeSortWall("asc")(rows, "group", "combos")), ["a", "b", "c"]);
});

check("missing or unparseable dates stay last in both directions", () => {
  const rows = [
    { id: "none", created: "" },
    { id: "bad", created: "not-a-date" },
    { id: "dated", created: "2026-09-09T23:00:00Z" },
  ];
  assert.equal(idsOf(makeSortWall("desc")(rows, "group", "combos"))[0], "dated");
  assert.equal(idsOf(makeSortWall("asc")(rows, "group", "combos"))[0], "dated");
});

check("count sort uses the corrected card numbers", () => {
  const library = {
    combos: [
      { section: "combos", folder: "f-a", count: 1 },
      { section: "combos", folder: "f-b", count: 2 },
    ],
    other: [],
  };
  const cards = new Map([["combos/f-a", { count: 3 }]]);
  const rows = [
    { id: "b", section: "combos", folder: "f-b", created: "2026-09-09T23:00:00Z" },
    { id: "a", section: "combos", folder: "f-a", created: "2026-09-09T23:00:00Z" },
  ];
  const sorted = makeSortWall("count", cards, library)(rows, "item");
  assert.deepEqual(idsOf(sorted), ["a", "b"], "the corrected count must win");
});

/* ---- T04: partial runs are summarised, never announced as complete ----- */

const describeDownloadCounts = new Function(
  `${extract("describeDownloadCounts")}\nreturn describeDownloadCounts;`
)();

check("partial summary names successes, failures and skips", () => {
  const text = describeDownloadCounts(
    { total: 3, attempted: 3, succeeded: 2, failed: 1, skipped: 4 },
    "最后一次失败：网络请求失败。"
  );
  assert.match(text, /部分完成/);
  assert.match(text, /成功 2 项/);
  assert.match(text, /失败 1 项/);
  assert.match(text, /已有 4 项/);
  assert.doesNotMatch(text, /下载完成/);
});

/* ---- O03: shell identity decides capability, not method sniffing ------- */

const shellDetectors = new Function(
  `${extract("isTauriDownloadShell")}\n${extract("shellCan")}\nreturn { isTauriDownloadShell, shellCan };`
)();

check("desktop commands require Tauri identity, declared capability and implementation", () => {
  global.window = {
    viewer: {
      shell: "tauri",
      capabilities: ["setMode", "startDownload"],
      startDownload() {},
      // Additional APIs must not change the declared shell identity.
      pickLibrary() {},
    },
  };
  assert.equal(shellDetectors.isTauriDownloadShell(), true);
  assert.equal(shellDetectors.shellCan("startDownload"), true);
  assert.equal(shellDetectors.shellCan("pickLibrary"), false);

  global.window = { viewer: { shell: "electron", pickLibrary() {}, getConfig() {} } };
  assert.equal(shellDetectors.isTauriDownloadShell(), false);
  assert.equal(shellDetectors.shellCan("pickLibrary"), false);

  // Bridges without an identity are no longer supported.
  global.window = { viewer: { startDownload() {}, pickLibrary() {}, getConfig() {} } };
  assert.equal(shellDetectors.isTauriDownloadShell(), false);
  assert.equal(shellDetectors.shellCan("startDownload"), false);

  global.window = { viewer: { startDownload() {} } };
  assert.equal(shellDetectors.isTauriDownloadShell(), false);
  assert.equal(shellDetectors.shellCan("startDownload"), false);

  global.window = { viewer: { shell: "tauri", startDownload() {} } };
  assert.equal(shellDetectors.shellCan("startDownload"), false);

  global.window = { viewer: { shell: "tauri", capabilities: ["startDownload"] } };
  assert.equal(shellDetectors.shellCan("startDownload"), false);

  global.window = { viewer: null };
  assert.equal(shellDetectors.isTauriDownloadShell(), false);
  assert.equal(shellDetectors.shellCan("setMode"), false);
});

check("Grok placeholder describes the app WebView, not an external browser", () => {
  const nodes = Object.fromEntries(
    ["grokGuestTitle", "grokGuestText", "grokGuestOpen", "grokGuest"].map(id => [id, {}])
  );
  const state = { mode: "grok" };
  const paint = new Function("$", "state", `${extract("paintGrokGuest")}\nreturn paintGrokGuest;`)(
    id => nodes[id], state
  );
  paint({ engine: "webview2", docked: true });
  assert.equal(nodes.grokGuest.hidden, true);
  paint({ engine: "webview2", docked: false });
  assert.equal(nodes.grokGuest.hidden, false);
  assert.match(nodes.grokGuestText.textContent, /WebView/);
  assert.doesNotMatch(nodes.grokGuestText.textContent, /Chrome|安装|系统浏览器/);
  state.mode = "gallery";
  paint({});
  assert.equal(nodes.grokGuest.hidden, true);
});

{
  const calls = [];
  const bridge = {
    shell: "tauri",
    capabilities: ["startDownload"],
    // Old-looking methods cannot select the retired post-download binding path.
    pickLibrary() {},
    getConfig() {},
    async startDownload(args) {
      calls.push(["download", args]);
      return { ok: true, userId: "fixture-user" };
    },
  };
  const run = new Function("window", "calls", `
    let dlBusy = false, dlStopping = false, libraryChangePending = 0;
    let dlGeneration = 0, dlPhase = "idle";
    const state = { root: "fixture-root", mode: "grok", library: { ok: true },
      config: { downloadBindOnly: false }, meta: { grokUserId: "old-user" } };
    const dlProg = {}, playerUI = null;
    const clearDlDone = () => {}, resetDlProg = () => {}, stopDlListAnimation = () => {}, paintDlProgress = () => {};
    const setStatus = () => {}, currentDownload = () => true;
    const setMode = async mode => { calls.push(["mode", mode]); state.mode = mode; return true; };
    const loadLibrary = async () => { calls.push(["reload"]); };
    const playDlDone = async () => {};
    const putMeta = async () => { throw new Error("renderer must not bind download accounts"); };
    ${extract("isTauriDownloadShell")}
    ${extract("shellCan")}
    ${extract("describeDownloadWarnings")}
    ${extract("startDownload")}
    return startDownload;
  `)({ viewer: bridge }, calls);
  await run();
  assert.deepEqual(calls, [["mode", "gallery"], ["download", { root: "fixture-root" }], ["reload"]]);
  calls.length = 0;
  await run({ historyId: "history-fixture", assetIds: ["asset-retry"] });
  assert.deepEqual(calls, [["download", {root: "fixture-root", retryOf: "history-fixture", retryAssetIds: ["asset-retry"]}], ["reload"]]);
  console.log("ok   Tauri downloads hide Grok and leave account binding to the backend");
}

{
  const sent = [];
  const context = new Function("window", "startDownload", `
    const state = {root: "root-A"}; let rootGeneration = 1, libraryChangePending = 0, dlBusy = false, dlStopping = false;
    ${extract("updateDownloadHistory")}
    return {update: updateDownloadHistory, switchRoot() { state.root = "root-B"; rootGeneration++; }, busy() { dlBusy = true; }};
  `)({GivDownloadHistory: {update: value => sent.push(value)}}, async value => sent.push(value));
  context.update();
  const original = sent[0];
  await original.onRetry("history", ["asset"]);
  assert.deepEqual(sent[1], {historyId: "history", assetIds: ["asset"]});
  context.busy();
  await assert.rejects(original.onRetry("history", ["asset"]));
  context.switchRoot();
  await assert.rejects(original.onRetry("history", ["asset"]));
  console.log("ok   production history retries use the existing controller and reject stale/busy gallery contexts");
}

/* ---- T05: a late flat response may not overwrite the current library --- */

check("history warnings use finite copy and preserve the published media outcome", () => {
  const describe = new Function(`${extract("describeDownloadWarnings")}\nreturn describeDownloadWarnings;`)();
  assert.ok(describe({historyState:"pending",warnings:["history_persistence_pending"]}).length>0);
  assert.ok(describe({historyState:"unavailable",warnings:["history_persistence_pending"]}).length>0);
  assert.equal(describe({warnings:["fixture-private-response"]}),"");
});

{
  function downloadController() {
    const calls = [], waiting = {};
    const bridge = {shell: "tauri", capabilities: ["startDownload", "stopDownload"],
      startDownload: () => new Promise(resolve => { waiting.start = resolve; }),
      stopDownload: () => new Promise(resolve => { waiting.stop = resolve; })};
    const controller = new Function("window", "calls", `
      let dlBusy=false,dlStopping=false,libraryChangePending=0,dlGeneration=0,dlPhase="idle";
      const DL_STOP_TIMEOUT_MS=1000, dlProg={},playerUI=null;
      const state={root:"root-A",mode:"gallery",library:{ok:true}};
      const clearDlDone=()=>{},resetDlProg=()=>{},stopDlListAnimation=()=>{},paintDlProgress=()=>{};
      const setStatus=(...args)=>calls.push(["status",...args]);
      const loadLibrary=async()=>calls.push(["reload",state.root]);
      const playDlDone=async()=>{},formatDlStopped=()=>"stopped";
      ${extract("isTauriDownloadShell")}
      ${extract("shellCan")}
      ${extract("currentDownload")}
      ${extract("describeDownloadCounts")}
      ${extract("describeDownloadWarnings")}
    ${extract("startDownload")}
      ${extract("stopDownload")}
      return {start:startDownload,stop:stopDownload, switchRoot(){state.root="root-B";dlGeneration++},
        state:()=>({busy:dlBusy,stopping:dlStopping,generation:dlGeneration})};
    `)({viewer:bridge}, calls);
    return {controller,calls,waiting};
  }
  // Both delivery orders must retain a published terminal result and refresh.
  for (const stopFirst of [true,false]) {
    const {controller,calls,waiting}=downloadController();
    const start=controller.start(),stop=controller.stop();
    if (stopFirst) { waiting.stop({stopped:true,published:true});await stop;waiting.start({stopped:true,published:true}); }
    else { waiting.start({stopped:true,published:true});await start;waiting.stop({stopped:true,published:true}); }
    await Promise.all([start,stop]);
    assert.ok(calls.some(row=>row[0]==="reload" && row[1]==="root-A"));
    assert.deepEqual(controller.state(),{busy:false,stopping:false,generation:1});
  }
  const {controller,calls,waiting}=downloadController();
  const start=controller.start(),stop=controller.stop();
  controller.switchRoot();
  waiting.stop({stopped:true,published:true});waiting.start({stopped:true,published:true});
  await Promise.all([start,stop]);
  assert.ok(!calls.some(row=>row[0]==="reload"),"late stop/start result refreshed another root");
  console.log("ok   published stop results refresh in either delivery order and reject a changed root");
}

check("preview combo arrows live in the sidebar and do not click the stage", () => {
  const nav = extract("syncPreviewNav");
  const bind = extract("bind");
  const family = extract("variantFamily");
  assert.ok(nav.includes("cpPrevCombo"), "syncPreviewNav must drive the sidebar previous button");
  assert.ok(nav.includes("cpNextCombo"), "syncPreviewNav must drive the sidebar next button");
  assert.ok(!bind.includes('id === "cpPrev"') && !bind.includes("$(\"cpPrev\")"), "stage left arrow must be gone");
  assert.ok(!bind.includes("stepCombo(-1)") || bind.includes("cpPrevCombo"), "combo walking stays on the sidebar buttons");
  assert.ok(!bind.includes("rect.width / 2"), "the stage must not change combos by half-click");
  assert.ok(family.includes("variantOf"), "resolution grouping must honor variantOf");
});

check("open and create library stay on the in-app directory list", () => {
  const open = extract("openLibraryFlow");
  const create = extract("createLibraryFlow");
  assert.ok(open.includes("openBrowser("), "openLibraryFlow must open the HTML directory list");
  assert.ok(!open.includes("pickLibrary"), "openLibraryFlow must not call the native picker");
  assert.ok(create.includes("openBrowser("), "createLibraryFlow must open the HTML directory list");
  assert.ok(create.includes("browserNewName"), "createLibraryFlow must focus the new-folder name");
  assert.ok(!create.includes("createLibrary("), "createLibraryFlow must not call the native save dialog");
});

check("library history can be removed one by one or cleared", () => {
  const plus = extract("paintPlusMenu");
  const launch = extract("paintHistory");
  assert.ok(plus.includes("historyForgetButton"), "plus menu rows must have a forget control");
  assert.ok(plus.includes("清除图库历史"), "plus menu must offer a clear-history action");
  assert.ok(launch.includes("historyForgetButton"), "launcher history rows must have a forget control");
  assert.ok(extract("forgetHistoryPath").includes("/api/history/remove"), "forget must hit the history API");
  assert.ok(extract("clearLibraryHistory").includes("/api/history/clear"), "clear must hit the history API");
});

check("launcher hide and history open dismiss the leftover directory modal", () => {
  const hide = extract("hideLauncher");
  const show = extract("showLauncher");
  const open = extract("openLibraryPath");
  assert.ok(hide.includes("closeBrowser()"), "hideLauncher must close the HTML directory modal");
  assert.ok(show.includes("closeBrowser()"), "showLauncher must close the HTML directory modal");
  assert.ok(open.includes("closeBrowser()"), "openLibraryPath must close the HTML directory modal");
});

check("AB capsule uses the measured time/mute gap center with CLEAR and repeat modes", () => {
  const paint = extract("paintLoopBar");
  const icon = extract("repeatSvg");
  const setPoint = extract("setLoopPoint");
  const click = extract("onLoopIconClick");
  const html = readFileSync(join(here, "..", "static", "index.html"), "utf8");
  const css = readFileSync(join(here, "..", "static", "player.css"), "utf8");
  assert.ok(paint.includes("repeatSvg(loopOn)"), "plain loop must draw Lucide repeat");
  assert.ok(paint.includes('toggle.textContent = "CLEAR"'), "A/B loop must show the compact CLEAR action");
  assert.ok(!paint.includes("cpLoopInfo"), "capsule must not paint a status caption");
  assert.ok(icon.includes("m17 2 4 4-4 4"), "on state must use Lucide repeat arrows");
  assert.ok(icon.includes("m2 2 20 20"), "off state must use Lucide repeat-off slash");
  assert.ok(setPoint.includes("loopOn = true"), "setting both A/B points must enter loop");
  assert.ok(click.includes("clearAbLoop"), "A/B icon click must leave the range and keep normal loop");
  assert.ok(!html.includes("cpLoopClear"), "loop icon replaces the separate Clear button");
  assert.ok(html.indexOf('id="cpLoopA"') < html.indexOf('id="cpLoopB"') && html.indexOf('id="cpLoopB"') < html.indexOf('id="cpLoopOn"'), "capsule order must be A, B, loop");
  assert.ok(html.indexOf('id="cpScrub"') < html.indexOf('id="cpLoop"'), "loop capsule must belong to the seek hover/focus region");
  assert.ok(css.includes(".cp-scrub:hover .cp-loop, .cp-scrub:has(:focus-visible) .cp-loop"), "only seek hover or visible keyboard focus reveals the capsule");
  assert.ok(css.includes("left: var(--loop-left, 50%)") && css.includes("transform: translateX(-50%)"), "capsule stays centered in the fitted control space");
  assert.ok(css.includes(".cp-loop::after"), "capsule must bridge the small gap to the seek hit region");
  assert.ok(!html.includes("id=\"cpLoopInfo\""), "capsule HTML must drop the status caption");
  assert.ok(!html.includes("<span>循环</span>"), "capsule must not keep the loop checkbox label");
  assert.ok(css.includes("--control-h: 42px"), "capsule must share the play and volume control height");
  assert.match(css, /#cpPlay, \.cp-volume-box, \.cp-loop\s*\{[^}]*backdrop-filter: blur\(36px\) saturate\(1\.6\);[^}]*box-shadow: var\(--cp-glass-rim\)/, "capsule shares the playback glass and rim");
  assert.doesNotMatch(html, /cp-unmute-label/, "sound keeps its localized accessible name without a visible text prompt");
  assert.ok(css.includes(".cp-loop button.on { color: #fff; background: transparent; }"), "set A/B marks use light, not a tint");
  assert.ok(css.includes("button.cp-loop-icon.off"), "loop-off must dim the Lucide mark");
  assert.ok(css.includes("rgba(56,164,196,.5)"), "A/B range on the bar must be lake blue");
  assert.ok(css.includes("text-shadow: 0 1px 2px #1c1c1f"), "A/B captions must be white on a dark shadow");
});

check("settings reload clears caches and open-on-X uses the asset id", () => {
  const hard = extract("hardReloadLibrary");
  const init = extract("init");
  assert.ok(hard.includes("refreshAfterChange()"), "hard reload must refetch the library");
  assert.ok(hard.includes("loadSideState"), "hard reload must reread meta");
  assert.ok(init.includes("hardReloadLibrary"), "settings reload must use the hard path");
});

check("trash restore batches and ignores a second click", () => {
  const chunkIds = new Function(`${extract("chunkIds")}\nreturn chunkIds;`)();
  const formatTrashProgress = new Function(`${extract("formatTrashProgress")}\nreturn formatTrashProgress;`)();
  const trashResultIds = new Function(`${extract("trashResultIds")}\nreturn trashResultIds;`)();
  assert.deepEqual(chunkIds(["a", "b", "c", "d", "e"], 2), [["a", "b"], ["c", "d"], ["e"]]);
  assert.equal(formatTrashProgress("正在恢复", 64, 5052), "正在恢复 64 / 5052");
  assert.deepEqual([...trashResultIds(["id-1", { id: "id-2" }, ""])].sort(), ["id-1", "id-2"]);
  const restore = extract("restoreIds");
  const write = extract("runTrashWrite");
  const retry = extract("postTrashWrite");
  assert.ok(write.includes("if (!ids || !ids.length || trashBusy) return"), "a second restore must no-op while busy");
  assert.ok(write.includes("paintTrashProgress"), "restore must paint a progress bar");
  assert.ok(retry.includes("library_busy"), "restore retries when the write lease is held");
  assert.ok(restore.includes("runTrashWrite"), "restoreIds must go through the batched writer");
});

check("flat requests are owned by a generation and a promise identity", () => {
  const body = extract("ensureFlat");
  for (const guard of ["rootGeneration", "state.flatPromise !== request", "expectedRoot"]) {
    assert.ok(body.includes(guard), `ensureFlat must check ${guard}`);
  }
  const cards = extract("flushCards");
  for (const guard of ["forGeneration === rootGeneration", "data.root === forRoot"]) {
    assert.ok(cards.includes(guard), `flushCards must check ${guard}`);
  }
});

if (failures.length) {
  process.stdout.write(`\n${failures.length} frontend behavior test(s) failed\n`);
  process.exitCode = 1;
} else {
  process.stdout.write("\nfrontend behavior tests passed\n");
}
