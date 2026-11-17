import "./i18n_test_helpers.mjs";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const source = readFileSync(new URL("../static/app.js", import.meta.url), "utf8");
const harness = readFileSync(new URL("./frontend_behavior.mjs", import.meta.url), "utf8");
const scanner = harness.slice(harness.indexOf("const REGEX_PRECEDERS"), harness.indexOf("const failures"));
const extract = new Function("assert", "source", scanner + "\nreturn extract;")(assert, source);
const tick = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

{
  const videos = [], timers = new Set();
  const scope = {
    document: { createElement() {
      const v = { duration: 6, released: false, removeAttribute() { this.released = true; }, load() {} };
      videos.push(v); return v;
    } },
    setTimeout(fn) { timers.add(fn); return fn; }, clearTimeout(fn) { timers.delete(fn); },
  };
  const control = new Function(...Object.keys(scope), `
    let mediaProbeChain = Promise.resolve(), mediaProbeCancel = null;
    ${extract("cancelDurationProbe")}
    ${extract("probeBrowserDuration")}
    return { probeBrowserDuration, cancelDurationProbe };
  `)(...Object.values(scope));
  let wanted = true;
  const first = control.probeBrowserDuration("/first", () => true);
  const second = control.probeBrowserDuration("/stale", () => wanted);
  await tick();
  assert.equal(videos.length, 1);
  wanted = false;
  control.cancelDurationProbe();
  assert.equal(await first, 0);
  assert.equal(await second, 0);
  assert.equal(videos.length, 1, "stale queued work must not create another decoder");
  assert.equal(videos[0].released, true);
  assert.equal(timers.size, 0);
  const third = control.probeBrowserDuration("/visible", () => true);
  await tick();
  videos[1].onloadedmetadata();
  assert.equal(await third, 6);
  assert.equal(timers.size, 0, "successful metadata reads also release the timeout");
  console.log("ok  queued probes recheck eligibility and active cancellation releases decoder and timer");
}

{
  const state = { root: "A", preview: { open: false } };
  const pending = [], saves = [], notes = [], probes = [];
  const scope = {
    state, window: { innerHeight: 600, innerWidth: 800 },
    setDurationBadge() {}, coverUrlFor: () => "/cover",
    readCoverDuration: () => new Promise(resolve => pending.push(resolve)),
    probeBrowserDuration: async (url, wanted) => { if (!wanted()) return 0; probes.push(url); return 6; },
    saveMeasuredDuration: (...args) => saves.push(args), noteDuration: (...args) => notes.push(args),
    setTimeout() { throw new Error("no polling should survive stale or hidden work"); },
  };
  const controls = new Function(...Object.keys(scope), `
    let rootGeneration = 1; const durationCache = new Map(), durationAsking = new Map();
    const DUR_POLL_MAX = 4, DUR_POLL_MS = 100;
    ${extract("durationNodeWanted")}
    ${extract("wantDuration")}
    return { wantDuration, durationNodeWanted, pending: durationAsking,
      switchRoot() { state.root = "B"; rootGeneration++; }, generation: () => rootGeneration };
  `)(...Object.values(scope));
  const visible = () => ({ isConnected: true, getBoundingClientRect: () => ({ width: 90, height: 90, top: 20, bottom: 110, left: 10, right: 100 }) });
  const staleNode = visible();
  controls.wantDuration(staleNode, "combos", "g", "same-id", "/A");
  await tick();
  assert.equal(pending.length, 1);
  controls.switchRoot();
  controls.wantDuration(visible(), "combos", "g", "same-id", "/B");
  await tick();
  assert.equal(pending.length, 2);
  pending[0](0);
  await tick();
  assert.equal(controls.pending.size, 1, "old-root cleanup must not remove the new-root request with the same ID");
  pending[1](0);
  await tick();
  assert.deepEqual(probes, ["/B"]);
  assert.equal(saves.length, 1);
  assert.equal(saves[0][2], "B");
  assert.equal(controls.pending.size, 0);
  const hidden = visible(); hidden.getBoundingClientRect = () => ({ width: 90, height: 90, top: 900, bottom: 990, left: 10, right: 100 });
  controls.wantDuration(hidden, "combos", "g", "offscreen", "/hidden");
  const detached = visible(); detached.isConnected = false;
  controls.wantDuration(detached, "combos", "g", "detached", "/detached");
  await tick();
  assert.equal(pending.length, 2);
  state.preview.open = true;
  controls.wantDuration(visible(), "combos", "g", "background", "/background");
  await tick();
  assert.equal(pending.length, 2, "an open foreground preview blocks new background cover HEAD/probe requests");
  assert.equal(controls.pending.size, 0);
  state.preview.open = false;
  const mounting = visible(); mounting.isConnected = false;
  controls.wantDuration(mounting, "combos", "g", "mounting", "/mounting");
  mounting.isConnected = true;
  await tick();
  assert.equal(pending.length, 3, "synchronous tile construction gets one microtask to attach before the visibility check");
  mounting.isConnected = false;
  pending[2](0);
  await tick();
  assert.equal(probes.length, 1, "scrolling away during HEAD also suppresses the decoder fallback");
  assert.equal(controls.pending.size, 0);
  assert.match(extract("showPreviewShell"), /cancelDurationProbe\(\)/);
  assert.match(extract("applyLibrary"), /cancelDurationProbe\(\)/);
  console.log("ok  duration work is root-owned, visible-only and yields to foreground preview");
}
console.log("Background media probe behavior tests passed");
