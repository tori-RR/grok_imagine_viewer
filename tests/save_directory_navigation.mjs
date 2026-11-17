import "./i18n_test_helpers.mjs";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../static/player-settings.js", import.meta.url), "utf8");
const harness = readFileSync(new URL("./frontend_behavior.mjs", import.meta.url), "utf8");
const scanner = harness.slice(harness.indexOf("const REGEX_PRECEDERS"), harness.indexOf("const failures"));
const extract = new Function("assert", "source", scanner + "\nreturn extract;")(assert, source);
const tick = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
function deferred() {
  let resolve, reject;
  const promise = new Promise((ok, fail) => { resolve = ok; reject = fail; });
  return { promise, resolve, reject };
}
function element() {
  return { open: false, disabled: false, textContent: "", children: [], listeners: {},
    addEventListener(type, callback) { (this.listeners[type] ||= []).push(callback); },
    dispatch(type) { for (const callback of this.listeners[type] || []) callback(); },
    showModal() { this.open = true; },
    close() { this.open = false; this.dispatch("close"); },
    replaceChildren() { this.children = []; },
    appendChild(child) { this.children.push(child); },
  };
}
function fixture() {
  const nodes = Object.fromEntries(["saveBrowse", "saveDirDialog", "saveDirClose", "saveDirUse", "saveDirList", "saveDirPath", "saveDirError"].map(id => [id, element()]));
  const requests = [], saves = [];
  const scope = {
    $: id => nodes[id], document: { createElement: element },
    api(url) { const next = deferred(); requests.push({ url, ...next }); return next.promise; },
    savePrefs(patch) { const next = deferred(); saves.push({ patch, ...next }); return next.promise; },
  };
  const bindings = source.slice(source.indexOf('    $("saveBrowse").addEventListener'), source.indexOf('    $("cpSideToggle").addEventListener'));
  const controller = new Function(...Object.keys(scope), `
    let dirVersion = 0, browsePath = "", prefs = {saveDirectory: ${JSON.stringify("C:\\saved")}};
    ${extract("browseDirectory")}
    ${extract("useSaveDirectory")}
    ${bindings}
    return { browseDirectory, useSaveDirectory };
  `)(...Object.values(scope));
  nodes.saveDirDialog.showModal();
  return { ...controller, nodes, requests, saves };
}
const directory = (path, parent = "") => ({ ok: true, kind: "directory", path, parent, selectable: true, dirs: [] });
const computer = { ok: true, kind: "computer", path: "", parent: null, selectable: false, dirs: [{ name: "D:\\", path: "D:\\" }] };

{
  const f = fixture();
  const root = f.browseDirectory("C:\\");
  f.requests[0].resolve(directory("C:\\")); await root;
  assert.equal(f.nodes.saveDirList.children[0].textContent, "↑ 此电脑");
  f.nodes.saveDirList.children[0].dispatch("click");
  assert.equal(f.requests[1].url, "/api/browse?path=", "empty parent must remain the virtual computer, not fall back to the saved directory");
  assert.equal(f.nodes.saveDirUse.disabled, true);
  f.requests[1].resolve(computer); await tick();
  assert.equal(f.nodes.saveDirPath.textContent, "此电脑");
  await f.useSaveDirectory(); assert.equal(f.saves.length, 0);
  f.nodes.saveDirList.children[0].dispatch("click");
  assert.equal(decodeURIComponent(f.requests[2].url), "/api/browse?path=D:\\");
  f.requests[2].resolve(directory("D:\\")); await tick();
  const save = f.useSaveDirectory();
  assert.deepEqual(f.saves[0].patch, { saveDirectory: "D:\\" });
  f.saves[0].resolve({ ok: true }); await save;
  assert.equal(f.nodes.saveDirDialog.open, false);
  console.log("ok  save-copy picker returns from a drive root to This PC and selects a different drive");
}

{
  const f = fixture();
  const initial = f.browseDirectory("C:\\saved"); f.requests[0].resolve(directory("C:\\saved", "C:\\")); await initial;
  const loading = f.browseDirectory("D:\\missing");
  await f.useSaveDirectory(); assert.equal(f.saves.length, 0, "in-flight navigation invalidates the previous destination");
  f.requests[1].resolve({ ok: false, error: "missing directory" }); await loading;
  await f.useSaveDirectory(); assert.equal(f.saves.length, 0);
  assert.equal(f.nodes.saveDirUse.disabled, true);
  assert.equal(f.nodes.saveDirError.textContent, "missing directory");
  const failed = f.browseDirectory("D:\\offline"); f.requests[2].reject(new Error("offline")); await failed;
  await f.useSaveDirectory(); assert.equal(f.saves.length, 0);
  console.log("ok  pending or failed navigation cannot save a stale destination");
}

{
  const f = fixture();
  const stale = f.browseDirectory("C:\\"), latest = f.browseDirectory("D:\\");
  f.requests[1].resolve(directory("D:\\")); await latest;
  f.requests[0].resolve(directory("C:\\")); await stale;
  assert.equal(f.nodes.saveDirPath.textContent, "D:\\");
  const save = f.useSaveDirectory();
  await f.useSaveDirectory(); assert.equal(f.saves.length, 1, "double activation does not enqueue duplicate saves");
  assert.deepEqual(f.saves[0].patch, { saveDirectory: "D:\\" });
  const navigation = f.browseDirectory("");
  f.saves[0].resolve({ ok: true }); await save;
  assert.equal(f.nodes.saveDirDialog.open, true, "old save completion cannot close a newer navigation");
  assert.equal(f.nodes.saveDirUse.disabled, true, "old save finally cannot enable a pending destination");
  f.requests[2].resolve(computer); await navigation;
  assert.equal(f.nodes.saveDirUse.disabled, true);
  console.log("ok  stale browse and save completions preserve the current navigation");
}

{
  const f = fixture();
  const closed = f.browseDirectory("C:\\");
  f.nodes.saveDirDialog.close(); f.requests[0].reject(new Error("late closed failure")); await closed;
  assert.notEqual(f.nodes.saveDirError.textContent, "late closed failure");
  await f.useSaveDirectory(); assert.equal(f.saves.length, 0);
  f.nodes.saveDirDialog.showModal();
  const opening = f.browseDirectory("D:\\"); f.requests[1].resolve(directory("D:\\")); await opening;
  const save = f.useSaveDirectory();
  f.nodes.saveDirDialog.close(); f.nodes.saveDirDialog.showModal();
  const reopen = f.browseDirectory("C:\\"); f.requests[2].resolve(directory("C:\\")); await reopen;
  f.saves[0].resolve({ ok: true }); await save;
  assert.equal(f.nodes.saveDirDialog.open, true);
  assert.equal(f.nodes.saveDirPath.textContent, "C:\\");
  const retry = f.useSaveDirectory(); f.saves[1].resolve(null); await retry;
  assert.equal(f.nodes.saveDirDialog.open, true);
  assert.equal(f.nodes.saveDirUse.disabled, false, "a current failed save can be retried");
  console.log("ok  dialog close invalidates old work and a failed current save remains retryable");
}

console.log("4 save-directory navigation behavior groups passed");
