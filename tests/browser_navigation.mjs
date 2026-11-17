import "./i18n_test_helpers.mjs";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// Exercise the shipped zero-build picker and its real event handlers. All paths
// and replies are fixtures: these tests never enumerate or modify a real library.
const source = readFileSync(new URL("../static/app.js", import.meta.url), "utf8");
const harness = readFileSync(new URL("./frontend_behavior.mjs", import.meta.url), "utf8");
const scanner = harness.slice(harness.indexOf("const REGEX_PRECEDERS"), harness.indexOf("const failures"));
const extract = new Function("assert", "source", scanner + "\nreturn extract;")(assert, source);
const bind = extract("bind");
const handlersStart = bind.indexOf('$("browserClose").addEventListener');
const handlersEnd = bind.indexOf('$("tagDialogClose").addEventListener', handlersStart);
assert.ok(handlersStart >= 0 && handlersEnd > handlersStart, "picker event handlers must exist");
const handlers = bind.slice(handlersStart, handlersEnd);
const tick = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
function deferred() {
  let resolve, reject;
  const promise = new Promise((ok, fail) => { resolve = ok; reject = fail; });
  return { promise, resolve, reject };
}
function node(props = {}, children = []) {
  return {
    hidden: false, disabled: false, value: "", textContent: "", title: "", children, listeners: {}, dataset: {}, attributes: {},
    addEventListener(type, callback) { this.listeners[type] = callback; },
    setAttribute(name, value) { this.attributes[name] = String(value); },
    contains(other) { return other === this || this.children.includes(other); },
    replaceChildren(...items) { this.children = items; },
    appendChild(item) { this.children.push(item); },
    focus() { this.focused = true; },
    ...props,
  };
}
const computer = () => ({
  ok: true, kind: "computer", path: "", parent: null, selectable: false,
  dirs: [{ name: "C:\\", path: "C:\\" }, { name: "D:\\", path: "D:\\" }], markers: [],
  places: [
    { name: "桌面", path: "C:\\Users\\fixture\\Desktop" },
    { name: "图片", path: "C:\\Users\\fixture\\Pictures" },
    { name: "视频", path: "C:\\Users\\fixture\\Videos" },
    { name: "文档", path: "C:\\Users\\fixture\\Documents" },
    { name: "下载", path: "C:\\Users\\fixture\\Downloads" },
  ],
});
const directory = (path, parent, extra = {}) => ({
  ok: true, kind: "directory", path, parent, selectable: true, dirs: [], markers: [], ...extra,
});
function fixture() {
  const nodes = Object.fromEntries([
    "browser", "browserPath", "browserUse", "browserCreate", "browserNewName", "browserUp",
    "browserError", "browserMarkers", "browserList", "browserClose", "browserPlaces", "browserPlacesBtn", "browserPlacesMenu",
  ].map(id => [id, node()]));
  nodes.browser.hidden = true;
  nodes.browserPlacesMenu.hidden = true;
  nodes.browserNewName.value = "fixture-library";
  const state = {
    root: "C:\\existing-library", browsePath: "C:\\previous-directory", browseParent: "C:\\",
    browseGeneration: 0, browseLoading: false, browseSelectable: false, browseAddressTimer: 0,
    browsePlaces: [], lightbox: { open: false },
  };
  const calls = [], opened = [], created = [], timers = new Map();
  let timerId = 0;
  const classes = new Set();
  const scope = {
    $: id => { assert.ok(nodes[id], `unexpected picker node: ${id}`); return nodes[id]; },
    state, document: { body: { classList: { add: name => classes.add(name), remove: name => classes.delete(name) } } },
    el: (tag, props = {}, children = []) => node({ tag, ...props }, children),
    withLibraryChange: async run => run(),
    api(url, options) { const d = deferred(); calls.push({ url, options, ...d }); return d.promise; },
    jsonOpts: (method, body) => ({ method, body }),
    openLibraryPath: async path => opened.push(path),
    afterLibraryCreated: async data => created.push(data),
    setTimeout(callback) { const id = ++timerId; timers.set(id, callback); return id; },
    clearTimeout(id) { timers.delete(id); },
  };
  const names = [
    "openLibraryFlow", "createLibraryFlow", "createLibraryHere", "openBrowser", "closeBrowser",
    "browserCanUse", "paintBrowserActions", "clearBrowserAddressTimer", "paintBrowserAddressStatus",
    "setBrowserPlacesOpen", "paintBrowserPlaces", "editBrowserAddress", "submitBrowserAddress", "refreshBrowser",
  ];
  const controller = new Function(...Object.keys(scope), `
    ${names.map(name => extract(name)).join("\n")}
    ${handlers}
    return { ${names.join(", ")} };
  `)(...Object.values(scope));
  return {
    ...controller, nodes, state, calls, opened, created, classes,
    runTimers() { const callbacks = [...timers.values()]; timers.clear(); callbacks.forEach(callback => callback()); },
    event(id, type = "click", event = {}) { return nodes[id].listeners[type](event); },
    requestedPath(index = calls.length - 1) {
      return new URL(calls[index].url, "http://127.0.0.1").searchParams.get("path");
    },
  };
}
function assertUnavailable(f) {
  assert.equal(f.browserCanUse(), false);
  for (const id of ["browserUse", "browserCreate", "browserNewName"]) {
    assert.equal(f.nodes[id].disabled, true, `${id} must not act on an unvalidated or virtual directory`);
  }
}
async function openAt(f, data) {
  const opening = f.openBrowser(data.path);
  f.calls.at(-1).resolve(data);
  await opening;
}

{
  for (const entry of ["openBrowser", "openLibraryFlow", "createLibraryFlow"]) {
    const f = fixture();
    const pending = f[entry]();
    assert.equal(f.requestedPath(), "", `${entry} must start at This PC, even with an existing library and previous directory`);
    assertUnavailable(f);
    f.calls[0].resolve(computer()); await pending;
    assert.equal(f.nodes.browser.hidden, false);
    assert.equal(f.nodes.browserUp.disabled, true);
    assert.equal(f.nodes.browserList.children.length, 2);
    assertUnavailable(f);
    await f.event("browserUse"); await f.createLibraryHere();
    assert.deepEqual(f.opened, []);
    assert.equal(f.calls.length, 1, "virtual This PC cannot be used as a library or creation parent");
  }
  console.log("ok  all picker entry points open This PC and virtual roots cannot be selected");
}

{
  const f = fixture(); await openAt(f, computer());
  f.nodes.browserList.children[0].children[0].onclick();
  assert.equal(f.requestedPath(), "C:\\");
  f.calls.at(-1).resolve(directory("C:\\", "")); await tick();
  assert.equal(f.nodes.browserUp.disabled, false, "a drive root has an empty-string virtual parent, not no parent");
  assert.equal(f.browserCanUse(), true);
  f.event("browserUp");
  assert.equal(f.requestedPath(), "", "Up from C:\\ must return to This PC");
  f.calls.at(-1).resolve(computer()); await tick();
  assertUnavailable(f);
  f.nodes.browserList.children[1].children[0].onclick();
  assert.equal(f.requestedPath(), "D:\\");
  f.calls.at(-1).resolve(directory("D:\\", "")); await tick();
  await f.event("browserUse");
  assert.deepEqual(f.opened, ["D:\\"]);
  assert.equal(f.nodes.browser.hidden, true);
  console.log("ok  drive root Up returns to This PC and a different drive can be selected");
}

{
  const f = fixture(); await openAt(f, directory("C:\\valid", "C:\\"));
  f.nodes.browserPath.value = "  \\\\NAS\\media\\图库  ";
  f.event("browserPath", "input");
  assertUnavailable(f);
  await f.event("browserUse"); await f.createLibraryHere();
  assert.equal(f.calls.length, 1, "typing cannot create under the previous validated directory");
  assert.equal(f.nodes.browserError.textContent, "检测中…");
  f.runTimers();
  assert.equal(f.requestedPath(), "\\\\NAS\\media\\图库", "manual UNC addresses must survive encoding and trim outer whitespace");
  f.calls.at(-1).resolve(directory("\\\\NAS\\media\\图库", "\\\\NAS\\media")); await tick();
  assert.equal(f.browserCanUse(), true);
  await f.event("browserUse");
  assert.deepEqual(f.opened, ["\\\\NAS\\media\\图库"]);
  const html = readFileSync(new URL("../static/index.html", import.meta.url), "utf8");
  assert.match(html, /id="browserPlacesBtn"[^>]*>▾<\/button>[\s\S]*?<input\b[^>]*id="browserPath"[^>]*>/);
  assert.match(html, /id="browserUp"[^>]*aria-label="上一级"[^>]*>[\s\S]*?class="lucide lucide-reply"[\s\S]*?<\/button>/);
  assert.doesNotMatch(html.match(/<button\b[^>]*id="browserUp"[^>]*>[\s\S]*?<\/button>/)[0], />上一级</);
  assert.doesNotMatch(html, /id="browserGo"/);
  assert.doesNotMatch(html.match(/<input\b[^>]*id="browserPath"[^>]*>/)[0], /\b(?:readonly|disabled)\b/);
  console.log("ok  editing invalidates the old directory and automatically validates a manual UNC path");
}

{
  const f = fixture(); await openAt(f, computer());
  assert.deepEqual(f.nodes.browserPlacesMenu.children.map(row => row.text), ["此电脑", "桌面", "图片", "视频", "文档", "下载"]);
  f.event("browserPlaces", "pointerenter", { pointerType: "mouse" });
  assert.equal(f.nodes.browserPlacesMenu.hidden, false, "hover must open the common-location menu");
  f.nodes.browserPlacesMenu.children[1].onclick();
  assert.equal(f.nodes.browserPlacesMenu.hidden, true);
  assert.equal(f.requestedPath(), "C:\\Users\\fixture\\Desktop");
  f.calls.at(-1).resolve(directory("C:\\Users\\fixture\\Desktop", "C:\\Users\\fixture")); await tick();
  assert.equal(f.browserCanUse(), true);
  console.log("ok  triangle hover menu exposes This PC and redirected common locations");
}

{
  const f = fixture(); await openAt(f, directory("C:\\valid", "C:\\"));
  f.nodes.browserPath.value = "D:\\typed-now";
  let prevented = false;
  f.event("browserPath", "keydown", { key: "Enter", isComposing: false, preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  assert.equal(f.requestedPath(), "D:\\typed-now");
  f.calls.at(-1).resolve(directory("D:\\typed-now", "D:\\")); await tick();
  assert.equal(f.browserCanUse(), true);
  console.log("ok  Enter remains an immediate shortcut for automatic address validation");
}

{
  const f = fixture(); await openAt(f, directory("C:\\valid", "C:\\"));
  const old = f.refreshBrowser("C:\\slow");
  f.nodes.browserPath.value = "D:\\typed";
  f.event("browserPath", "input");
  f.calls.at(-1).resolve(directory("C:\\slow", "C:\\")); await old;
  assert.equal(f.nodes.browserPath.value, "D:\\typed", "a reply cannot replace an address typed while the request was in flight");
  assertUnavailable(f);
  await f.event("browserUse"); await f.createLibraryHere();
  assert.deepEqual(f.opened, []);
  assert.equal(f.calls.length, 2);
  console.log("ok  pending navigation cannot validate or overwrite an address edited afterwards");
}

{
  for (const reject of [false, true]) {
    const f = fixture(); await openAt(f, directory("C:\\valid", "C:\\"));
    const pending = f.refreshBrowser("D:\\missing");
    if (reject) f.calls.at(-1).reject(new Error("offline"));
    else f.calls.at(-1).resolve({ ok: false, error: "directory not found" });
    await pending;
    assert.equal(f.nodes.browserError.hidden, false);
    assert.equal(f.nodes.browserError.textContent, "地址无效");
    assert.ok(f.nodes.browserError.title.length, "the compact inline error keeps diagnostic detail as a tooltip");
    assertUnavailable(f);
    await f.event("browserUse"); await f.createLibraryHere();
    assert.deepEqual(f.opened, []);
    assert.equal(f.calls.length, 2, "failed navigation must not fall back to creating in the last valid directory");
    f.nodes.browserPlacesMenu.children[0].onclick(); f.calls.at(-1).resolve(computer()); await tick();
    assert.equal(f.nodes.browserError.hidden, true);
    assert.equal(f.nodes.browserList.children.length, 2);
  }
  console.log("ok  server errors and disconnected paths remain unusable and can recover through This PC");
}

{
  const f = fixture();
  const older = f.openBrowser("C:\\slow"), latest = f.refreshBrowser("D:\\current");
  f.calls[1].resolve(directory("D:\\current", "D:\\", { dirs: [{ name: "current child", path: "D:\\current\\child" }] }));
  await latest;
  f.calls[0].resolve(directory("C:\\slow", "C:\\", { dirs: [{ name: "old child", path: "C:\\slow\\child" }] }));
  await older;
  assert.equal(f.nodes.browserPath.value, "D:\\current");
  assert.equal(f.nodes.browserList.children[0].children[0].text, "current child");
  assert.equal(f.browserCanUse(), true);
  const failing = f.refreshBrowser("C:\\offline"), good = f.refreshBrowser("D:\\newer");
  f.calls[3].resolve(directory("D:\\newer", "D:\\")); await good;
  f.calls[2].reject(new Error("obsolete failure")); await failing;
  assert.equal(f.nodes.browserPath.value, "D:\\newer");
  assert.equal(f.nodes.browserError.hidden, true);
  assert.equal(f.browserCanUse(), true);
  console.log("ok  competing navigation ignores older success and failure without changing current actions");
}

{
  const f = fixture();
  const pending = f.openBrowser("C:\\slow");
  f.event("browserClose");
  f.calls[0].resolve(directory("C:\\slow", "C:\\")); await pending;
  assert.equal(f.nodes.browser.hidden, true);
  assert.equal(f.browserCanUse(), false);
  assert.equal(f.classes.has("modal-open"), false);
  const old = f.openBrowser("C:\\older");
  f.event("browserClose");
  const reopened = f.openLibraryFlow();
  assert.equal(f.requestedPath(), "");
  f.calls[2].resolve(computer()); await reopened;
  f.calls[1].resolve(directory("C:\\older", "C:\\")); await old;
  assert.equal(f.nodes.browser.hidden, false);
  assert.equal(f.nodes.browserPath.value, "");
  assert.equal(f.nodes.browserList.children.length, 2);
  assertUnavailable(f);
  console.log("ok  close and reopen discard earlier replies without reviving closed or obsolete locations");
}

{
  const f = fixture(); await openAt(f, directory("D:\\parent", "D:\\"));
  const created = f.createLibraryHere();
  assert.equal(f.calls.at(-1).url, "/api/library/create");
  assert.deepEqual(f.calls.at(-1).options, { method: "POST", body: { parent: "D:\\parent", name: "fixture-library" } });
  const result = { ok: true, root: "D:\\parent\\fixture-library" };
  f.calls.at(-1).resolve(result); await created;
  assert.deepEqual(f.created, [result]);
  assert.equal(f.nodes.browser.hidden, true);
  assert.equal(f.nodes.browserNewName.value, "");
  console.log("ok  a validated directory remains usable as the explicit parent for a new library");
}

console.log("10 directory picker behavior groups passed");
