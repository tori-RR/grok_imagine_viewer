import "./i18n_test_helpers.mjs";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../static/player-settings.js", import.meta.url), "utf8");
const harness = readFileSync(new URL("./frontend_behavior.mjs", import.meta.url), "utf8");
const scanner = harness.slice(harness.indexOf("const REGEX_PRECEDERS"), harness.indexOf("const failures"));
const extract = new Function("assert", "source", scanner + "\nreturn extract;")(assert, source);
const tick = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
function deferred() {
  let resolve, reject;
  const promise = new Promise((ok, fail) => { resolve = ok; reject = fail; });
  return { promise, resolve, reject };
}

function modalFixture() {
  const nodes = {
    settingsDialog: { open: false, showCalls: 0, showModal() { assert.equal(this.open, false); this.open = true; this.showCalls++; } },
    settingsMessage: { textContent: "" },
    dedupDialog: { open: false, close() { this.open = false; } },
  };
  const calls = [], errors = [];
  let nativeMode = "grok", busy = false, activeCalls = 0, peakCalls = 0;
  const scope = {
    $: id => nodes[id], root: { viewer: { setMode() {} } },
    adapter: { mode: () => "grok", downloadBusy: () => busy },
    native(name, mode) {
      assert.equal(name, "setMode");
      const d = deferred(); activeCalls++; peakCalls = Math.max(peakCalls, activeCalls);
      calls.push({ mode, resolve() { nativeMode = mode; activeCalls--; d.resolve(); }, reject() { activeCalls--; d.reject(new Error("fixture mode failure")); } });
      return d.promise;
    },
    cancelRecord() {}, listAudio: async () => {}, loadPlaybackAccel: async () => {}, loadCoverAccel: async () => {}, error: err => errors.push(String(err)),
  };
  const controller = new Function(...Object.keys(scope), `
    let guestRestore = false, modalGeneration = 0, settingsOpening = false, playbackVersion = 0, coverVersion = 0;
    let guestModeTail = Promise.resolve();
    ${["queueGuestMode", "openSettings", "closeSettings"].map(name => extract(name)).join("\n")}
    return { openSettings, closeSettings, queueGuestMode, snapshot: () => ({ modalGeneration, settingsOpening, guestRestore }) };
  `)(...Object.values(scope));
  return { ...controller, nodes, calls, errors,
    close() { nodes.settingsDialog.open = false; controller.closeSettings(); },
    busy(value) { busy = value; }, nativeMode: () => nativeMode, peakCalls: () => peakCalls,
  };
}

{
  const f = modalFixture();
  const first = f.openSettings(), second = f.openSettings();
  await tick();
  assert.deepEqual(f.calls.map(c => c.mode), ["gallery"]);
  assert.equal(f.nodes.settingsDialog.open, false, "the native Grok child must be hidden before showing a DOM modal");
  f.calls[0].resolve();
  await Promise.all([first, second]);
  assert.equal(f.nodes.settingsDialog.showCalls, 1);
  assert.equal(f.snapshot().settingsOpening, false);
  assert.equal(f.nativeMode(), "gallery");
  f.close(); await tick();
  assert.equal(f.calls[1].mode, "grok");
  f.calls[1].resolve(); await tick();
  assert.equal(f.nativeMode(), "grok");
  console.log("ok  double-open settings hides Grok once, shows one modal and restores on close");
}

{
  const f = modalFixture();
  const stale = f.openSettings(); await tick();
  f.close();
  const current = f.openSettings();
  f.calls[0].resolve(); await tick();
  assert.deepEqual(f.calls.map(c => c.mode), ["gallery", "gallery"], "a queued old restore must be invalidated by the new generation");
  assert.equal(f.nodes.settingsDialog.showCalls, 0, "the cancelled opening must not show a stale dialog");
  f.calls[1].resolve(); await Promise.all([stale, current]);
  assert.equal(f.nodes.settingsDialog.showCalls, 1);
  assert.equal(f.nativeMode(), "gallery");
  assert.equal(f.peakCalls(), 1);
  console.log("ok  close/reopen during pending hide invalidates the old dialog and queued restore");
}

{
  const f = modalFixture();
  const opened = f.openSettings(); await tick(); f.calls[0].resolve(); await opened;
  f.close(); await tick();
  assert.equal(f.calls[1].mode, "grok"); // Already in flight; it cannot be cancelled.
  const reopened = f.openSettings(); await tick();
  assert.equal(f.calls.length, 2, "new hide must wait for an in-flight native restore");
  assert.equal(f.nodes.settingsDialog.open, false);
  f.calls[1].resolve(); await tick();
  assert.equal(f.calls[2].mode, "gallery");
  assert.equal(f.nodes.settingsDialog.open, false, "new dialog must not show over the restored Grok child");
  f.calls[2].resolve(); await reopened;
  assert.equal(f.nodes.settingsDialog.open, true);
  assert.equal(f.nativeMode(), "gallery");
  assert.equal(f.peakCalls(), 1, "native mode transitions must never overlap");
  console.log("ok  an in-flight old restore settles before the new hide and cannot cover the reopened dialog");
}

{
  const f = modalFixture();
  const opened = f.openSettings(); await tick(); f.calls[0].resolve(); await opened;
  f.close(); const reopened = f.openSettings(); await tick();
  assert.deepEqual(f.calls.map(c => c.mode), ["gallery", "gallery"]);
  f.calls[1].resolve(); await reopened;
  f.busy(true); f.close(); await tick();
  assert.equal(f.calls.length, 2, "closing settings during a download must not restore Grok");
  assert.equal(f.nativeMode(), "gallery");
  console.log("ok  immediate reopen skips a queued restore and download activity blocks restoration");
}

{
  const f = modalFixture();
  const failed = f.openSettings(); const expected = assert.rejects(failed, /fixture mode failure/);
  await tick(); f.calls[0].reject(); await expected;
  assert.equal(f.snapshot().settingsOpening, false);
  assert.equal(f.nodes.settingsDialog.open, false);
  const retry = f.openSettings(); await tick(); f.calls[1].resolve(); await retry;
  assert.equal(f.nodes.settingsDialog.showCalls, 1);
  assert.equal(f.peakCalls(), 1);
  console.log("ok  a failed native hide releases the opening guard and does not poison the serial queue");
}

function playbackFixture() {
  const nodes = { playbackAccel: { disabled: false, value: "auto" }, playbackAccelHint: { textContent: "" } };
  const calls = [], errors = [];
  const scope = {
    $: id => nodes[id], root: { viewer: { getPlaybackAcceleration() {} } },
    PLAYBACK_MODES: { auto: "自动", gpu: "GPU 优先", cpu: "CPU 解码", compat: "兼容" },
    playbackAccelText: data => data ? data.requested : "unsupported", error: err => errors.push(String(err)),
    native(name, mode) { const d = deferred(); calls.push({ name, mode, ...d }); return d.promise; },
  };
  const controller = new Function(...Object.keys(scope), `
    let playbackVersion = 0, playbackRequested = "auto", playbackSupported = true;
    ${["paintPlaybackAccel", "loadPlaybackAccel", "savePlaybackAccel"].map(name => extract(name)).join("\n")}
    return { loadPlaybackAccel, savePlaybackAccel, invalidate: () => ++playbackVersion,
      supported: value => playbackSupported = value };
  `)(...Object.values(scope));
  return { ...controller, nodes, calls, errors };
}
const policy = requested => ({ supported: true, requested, effective: "auto", restartRequired: requested !== "auto" });

{
  const f = playbackFixture();
  const old = f.savePlaybackAccel("cpu"), latest = f.savePlaybackAccel("gpu");
  f.calls[0].resolve(policy("cpu")); await old;
  assert.equal(f.nodes.playbackAccel.disabled, true, "an old finally must not unlock a newer pending save");
  assert.equal(f.nodes.playbackAccel.value, "auto");
  f.calls[1].resolve(policy("gpu")); await latest;
  assert.equal(f.nodes.playbackAccel.value, "gpu");
  assert.equal(f.nodes.playbackAccel.disabled, false);
  const staleFailure = f.savePlaybackAccel("cpu"), newest = f.savePlaybackAccel("compat");
  f.calls[3].resolve(policy("compat")); await newest;
  f.calls[2].reject(new Error("outdated error")); await staleFailure;
  assert.equal(f.nodes.playbackAccel.value, "compat");
  assert.equal(f.errors.length, 0, "old failures cannot revert the latest selection or paint stale errors");
  console.log("ok  playback saves ignore old success, old failure and stale finally callbacks");
}

{
  const f = playbackFixture();
  const loading = f.loadPlaybackAccel(), save = f.savePlaybackAccel("gpu");
  f.calls[1].resolve(policy("gpu")); await save;
  f.calls[0].resolve(policy("cpu")); await loading;
  assert.equal(f.nodes.playbackAccel.value, "gpu", "slow initial reads cannot overwrite a newer save");
  const failed = f.savePlaybackAccel("cpu");
  f.calls[2].reject(new Error("current failure")); await failed;
  assert.equal(f.nodes.playbackAccel.value, "gpu");
  assert.equal(f.nodes.playbackAccel.disabled, false);
  assert.match(f.errors[0], /current failure/);
  await f.savePlaybackAccel("invalid"); f.supported(false); await f.savePlaybackAccel("cpu");
  assert.equal(f.calls.length, 3);
  const closing = playbackFixture(); const pending = closing.savePlaybackAccel("cpu");
  closing.invalidate(); closing.calls[0].resolve(policy("cpu")); await pending;
  assert.equal(closing.nodes.playbackAccel.value, "auto", "dialog-close invalidation discards its outstanding UI update");
  assert.match(extract("closeSettings"), /\+\+playbackVersion/);
  console.log("ok  playback reads, current failures, invalid modes and close invalidation honor version ownership");
}

console.log("7 asynchronous settings behavior groups passed");
