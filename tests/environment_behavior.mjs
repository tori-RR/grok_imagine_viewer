import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import vm from "node:vm";
const read = name => readFileSync(new URL("../" + name, import.meta.url), "utf8");
const flush = async () => { for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve)); };
const missing = {ffmpeg: {ready: false, tools: {ffmpeg: {ready: false, reason: "missing"}, ffprobe: {ready: false, reason: "missing"}}}};
const ready = {ffmpeg: {ready: true, tools: {ffmpeg: {ready: true}, ffprobe: {ready: true}}}};
const nativeReady = () => ({supported: true, winget: true, webview2: {ready: true}, install: {phase: "idle"}});
function target() {
  const listeners = new Map();
  return {addEventListener(name, cb) { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(cb); },
    removeEventListener(name, cb) { listeners.get(name)?.delete(cb); }, fire(name) { for (const cb of listeners.get(name) || []) cb(); }};
}
function fixture(api, bridge) {
  if (bridge) bridge = {shell: "tauri", capabilities: ["getEnvironmentStatus", "installEnvironmentComponent"], ...bridge};
  const events = target(), elements = {};
  const document = Object.assign(target(), {hidden: false, activeElement: null, documentElement: {}, querySelectorAll: () => [], getElementById: id => elements[id], createElement: () => node()});
  function node() {
    return Object.assign(target(), {children: [], hidden: false, disabled: false, textContent: "", attrs: {}, classList: {toggle() {}},
      append(...children) { for (const child of children) { this.children.push(child); child.parent = this; } },
      contains(value) { return value === this || this.children.some(child => child.contains(value)); },
      remove() { this.parent.children.splice(this.parent.children.indexOf(this), 1); },
      setAttribute(k, v) { this.attrs[k] = v; }, focus() { document.activeElement = this; }});
  }
  for (const id of ["launcher", "launcherOpen", "environmentPanel", "environmentComponents", "environmentHeading", "environmentMessage", "environmentRefresh"]) elements[id] = node();
  elements.environmentPanel.append(elements.environmentComponents);
  const timers = new Map(); let next = 0;
  const context = vm.createContext({Intl, navigator: {language: "zh-CN"}, document, setTimeout, clearTimeout});
  vm.runInContext(read("static/locales/en.js") + read("static/i18n.js") + read("static/environment.js"), context);
  const controller = context.GivEnvironment.create({api, bridge, document, events, schedule(cb) { const id = ++next; timers.set(id, () => { timers.delete(id); cb(); }); return id; }, cancel(id) { timers.delete(id); }});
  return {context, controller, elements, document, timers, button: () => elements.environmentComponents.children[0]?.children[1]};
}
{
  const f = fixture(async () => ready, {getEnvironmentStatus: async () => nativeReady(), installEnvironmentComponent() { throw Error("unexpected"); }});
  await flush();
  assert.equal(f.elements.environmentPanel.hidden, true, "healthy startup adds no visible content");
  f.controller.dispose();
}
{
  let health = missing, native = nativeReady(), installs = 0;
  const f = fixture(async () => health, {getEnvironmentStatus: async () => structuredClone(native), async installEnvironmentComponent(id) { assert.equal(id, "ffmpeg"); installs++; native.install = {phase: "running", component: id}; return structuredClone(native.install); }});
  await flush();
  assert.equal(f.elements.environmentPanel.hidden, false);
  assert.equal(f.elements.environmentComponents.children.length, 1);
  assert.equal(f.button().disabled, false);
  f.context.GivI18n.setPreference("en");
  assert.equal(f.elements.environmentHeading.textContent, "Missing components");
  assert.equal(f.button().textContent, "Install");
  f.button().fire("click"); f.button().fire("click");
  await flush();
  assert.equal(installs, 1, "double-click cannot launch duplicate installers");
  assert.equal(f.button().disabled, true);
  assert.equal(f.timers.size, 1);
  native.install = {phase: "finished", component: "ffmpeg", exitCode: 0};
  await f.controller.refresh();
  assert.equal(f.elements.environmentPanel.hidden, false, "exit zero alone does not prove installation");
  assert.match(f.elements.environmentMessage.textContent, /still unavailable/);
  assert.equal(f.timers.size, 1, "a final probe follows observed process completion");
  health = ready; f.document.activeElement = f.button();
  f.timers.values().next().value(); await flush();
  assert.equal(f.elements.environmentPanel.hidden, true);
  assert.equal(f.document.activeElement, f.elements.launcherOpen);
  assert.equal(f.timers.size, 0);
  f.controller.dispose();
}
{
  let native = {...nativeReady(), winget: false};
  const f = fixture(async () => missing, {getEnvironmentStatus: async () => native, installEnvironmentComponent: async () => { throw Error("fixture"); }});
  await flush();
  assert.equal(f.button().disabled, true);
  assert.match(f.elements.environmentMessage.textContent, /winget/);
  native = nativeReady(); await f.controller.refresh(); f.button().fire("click"); await flush();
  assert.equal(f.button().disabled, false);
  assert.match(f.elements.environmentMessage.textContent, /无法打开/);
  native.install = {phase: "finished", component: "ffmpeg", exitCode: 1};
  await f.controller.refresh();
  assert.match(f.elements.environmentMessage.textContent, /安装未完成/);
  f.controller.dispose();
}
{
  let resolveOld;
  const f = fixture(() => new Promise(resolve => { resolveOld = resolve; }), null);
  await flush();
  const old = resolveOld;
  const fresh = f.controller.refresh(); await flush(); resolveOld(ready); await fresh;
  old(missing); await flush();
  assert.equal(f.elements.environmentPanel.hidden, true, "stale startup response cannot restore a warning");
  f.controller.dispose();
}
for (const [api, bridge] of [[() => ({ok: false, error: "fixture bad JSON response"}), null], [() => ready, {getEnvironmentStatus() { throw Error("fixture synchronous bridge failure"); }, installEnvironmentComponent() {}}]]) {
  const f = fixture(api, bridge);
  await flush();
  assert.equal(f.elements.environmentHeading.textContent, "环境检测失败");
  assert.equal(f.elements.environmentComponents.children.length, 0);
  f.controller.dispose();
}
{
  const f = fixture(async () => { throw Error("fixture network failure"); }, null);
  await flush();
  assert.equal(f.elements.environmentHeading.textContent, "环境检测失败");
  assert.equal(f.elements.environmentComponents.children.length, 0, "a check failure is not reported as a missing component");
  f.controller.dispose();
}
{
  const f = fixture(async () => missing, {shell: "unknown", getEnvironmentStatus() { throw Error("untrusted bridge must not be invoked"); }, installEnvironmentComponent() { throw Error("unexpected"); }});
  await flush();
  assert.equal(f.button().disabled, true);
  assert.match(f.elements.environmentMessage.textContent, /Windows/);
  f.controller.dispose();
}
console.log("ok  environment UI: healthy/missing, i18n, serial installs, failure, missing winget, verified completion, focus and stale responses");
