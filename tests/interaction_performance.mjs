// Deterministic operation-count regressions against the shipped controller.
// No real media, credentials, clocks or GPU assumptions are used here.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const source = readFileSync(new URL("../static/app.js", import.meta.url), "utf8");
const harness = readFileSync(new URL("./frontend_behavior.mjs", import.meta.url), "utf8");
const scanner = harness.slice(harness.indexOf("const REGEX_PRECEDERS"), harness.indexOf("const failures"));
const extract = new Function("assert", "source", scanner + "\nreturn extract;")(assert, source);
let checks = 0;
function check(name, run) { run(); checks++; console.log("ok  " + name); }

class Node {
  constructor(tag = "div") {
    this.tagName = tag.toUpperCase(); this.children = []; this.parentNode = null;
    this.dataset = {}; this.attributes = new Map(); this.listeners = new Map();
    this.hidden = false; this.hovered = true; this.title = "";
    this.clientWidth = 600; this.clientHeight = 300; this.scrollTop = 0;
    this.writes = 0; this.removes = 0; this.heightWrites = 0;
    this.style = new Proxy({}, { set: (object, key, value) => {
      this.writes++; if (key === "height") this.heightWrites++;
      object[key] = value; return true;
    } });
    const classes = new Set();
    this.classList = {
      add: (...names) => names.forEach(name => classes.add(name)),
      contains: name => classes.has(name),
      toggle(name, force) {
        const on = force === undefined ? !classes.has(name) : force;
        if (on) classes.add(name); else classes.delete(name);
        return on;
      },
    };
  }
  get isConnected() { return !!this.root || !!this.parentNode?.isConnected; }
  get scrollHeight() { return Math.max(this.clientHeight, Number.parseFloat(this.children[0]?.style.height || "0")); }
  appendChild(child) {
    if (child.parentNode) child.parentNode.removeChild(child);
    this.children.push(child); child.parentNode = this; return child;
  }
  removeChild(child) {
    const i = this.children.indexOf(child); assert.ok(i >= 0);
    this.children.splice(i, 1); child.parentNode = null; this.removes++; return child;
  }
  querySelector(selector) {
    const matches = n => selector.startsWith(".") ? n.classList.contains(selector.slice(1)) : n.tagName === selector.toUpperCase();
    for (const child of this.children) {
      if (matches(child)) return child;
      const found = child.querySelector(selector); if (found) return found;
    }
    return null;
  }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  hasAttribute(name) { return this.attributes.has(name); }
  removeAttribute(name) { this.attributes.delete(name); }
  addEventListener(name, fn) { this.listeners.set(name, fn); }
  removeEventListener(name, fn) { if (this.listeners.get(name) === fn) this.listeners.delete(name); }
  emit(name) { this.listeners.get(name)?.({ target: this }); }
  matches(selector) { return selector === ":hover" && this.hovered; }
}

function clock() {
  let id = 0; const frames = new Map(), timers = new Map();
  return {
    frames, timers,
    requestAnimationFrame(fn) { frames.set(++id, fn); return id; },
    cancelAnimationFrame(key) { frames.delete(key); },
    setTimeout(fn) { timers.set(++id, fn); return id; },
    clearTimeout(key) { timers.delete(key); },
    frame() { const next = [...frames.values()]; frames.clear(); next.forEach(fn => fn()); },
    timeouts() { const next = [...timers.values()]; timers.clear(); next.forEach(fn => fn()); },
  };
}
function wall({ count = 100, width = 600, height = 300, masonry = false } = {}) {
  const time = clock(), main = new Node(); main.root = true;
  const state = { grid: null, select: { on: false, picked: new Map() } };
  let renders = 0, stops = 0, resize;
  const rows = Array.from({ length: count }, (_, i) => ({ id: "row-" + i, ratio: 0.6 + (i % 7) * 0.23 }));
  const deps = {
    state, resetMain: () => main,
    el(tag, attrs) { const n = new Node(tag); n.classList.add(attrs.class); if (attrs.class === "grid-scroll") { n.clientWidth = width; n.clientHeight = height; } return n; },
    t: text => text,
    ...time,
    ResizeObserver: class { constructor(fn) { resize = fn; } observe() {} disconnect() {} },
    WALL_GAP: 3, COMPACT_MIN: 180, BAND: 400, OVERSCAN_PX: 0, POOL_MAX: 320,
  };
  const control = new Function(...Object.keys(deps), `
    let hoverTile = null, hoverIntent = null;
    const stopHoverVideo = () => { onStop(); hoverTile = null; hoverIntent = null; };
    ${extract("syncTileSelection")}
    ${extract("mountWall")}
    return { mountWall, setHover: tile => { hoverTile = tile; }, setIntent: tile => { hoverIntent = { tile }; } };
  `.replace("onStop()", "state.stop()"))(...Object.values(deps));
  state.stop = () => { stops++; };
  const renderTile = item => {
    renders++;
    const tile = new Node(); tile.classList.add("tile");
    tile.appendChild(new Node("img"));
    const check = new Node("button"); check.classList.add("tile-check"); check.dataset.selectionKey = "i:" + item.id;
    tile.appendChild(check); return tile;
  };
  control.mountWall(rows, renderTile, { minWidth: 180, masonry, keyOf: row => "item:" + row.id, ratioOf: row => row.ratio });
  const scroller = main.children[0], surface = scroller.children[0];
  return { state, rows, scroller, surface, time, control, resize: () => resize(),
    renders: () => renders, stops: () => stops, grid: state.grid,
    scroll(value) { scroller.scrollTop = value; scroller.emit("scroll"); time.frame(); } };
}
function selection(w) {
  const body = new Node(), button = new Node();
  const deps = { state: w.state, document: { body }, $: () => button, syncSelBar() {}, stopHoverVideo() {},
    selKeyOf: target => "i:" + target.item.id, tileKeyOf: target => "item:" + target.item.id };
  return new Function(...Object.keys(deps), `${extract("syncSelectionTiles")}\n${extract("setSelectMode")}\n${extract("toggleSelect")}\nreturn { setSelectMode, toggleSelect };`)(...Object.values(deps));
}
const yOf = tile => Number(/translate\([^,]+,([\d.-]+)px\)/.exec(tile.style.transform)[1]);

check("selection retains mounted tile/image identity and never renders media", () => {
  const w = wall(), api = selection(w), nodes = [...w.surface.children], images = nodes.map(n => n.querySelector("img"));
  const before = w.renders(), removed = w.surface.removes;
  for (let i = 0; i < 30; i++) {
    api.setSelectMode(true); api.toggleSelect({ kind: "item", item: w.rows[0] }); api.setSelectMode(false);
  }
  assert.equal(w.renders(), before); assert.equal(w.surface.removes, removed);
  assert.deepEqual(w.surface.children, nodes);
  nodes.forEach((node, i) => {
    assert.equal(node.querySelector("img"), images[i]);
    assert.equal(node.querySelector(".tile-check").getAttribute("aria-pressed"), "false");
    assert.equal(node.classList.contains("picked"), false);
  });
});
check("selection patches only the requested pooled tile", () => {
  const w = wall(), api = selection(w), first = w.surface.children[0];
  api.toggleSelect({ kind: "item", item: w.rows[0] });
  assert.equal(first.classList.contains("picked"), true);
  assert.equal(first.querySelector(".tile-check").getAttribute("aria-pressed"), "true");
  assert.equal(first.querySelector(".tile-check").title, "取消选择");
  assert.equal(w.surface.children[1].classList.contains("picked"), false);
});
check("off-screen pooled selection is reconciled before reattachment", () => {
  const w = wall(), api = selection(w), first = w.surface.children[0];
  api.toggleSelect({ kind: "item", item: w.rows[0] }); w.scroll(1100);
  assert.equal(first.isConnected, false); api.setSelectMode(false); w.scroll(0);
  assert.equal(w.surface.children.find(n => n.dataset.poolKey === "item:row-0"), first);
  assert.equal(first.classList.contains("picked"), false);
  assert.equal(first.querySelector(".tile-check").getAttribute("aria-pressed"), "false");
});
check("select-all presentation scales with mounted nodes, not library size", () => {
  const w = wall({ count: 10000 }); const before = w.renders();
  for (const row of w.rows) w.state.select.picked.set("i:" + row.id, row);
  w.grid.refreshSelection();
  assert.equal(w.renders(), before);
  assert.ok(w.surface.children.length < 20);
  assert.ok(w.surface.children.every(n => n.classList.contains("picked")));
});
check("slider input bursts coalesce into one layout with the final size", () => {
  const w = wall({ count: 10000 }), before = w.surface.heightWrites;
  for (let i = 0; i < 100; i++) w.grid.updateLayout(181 + i, false);
  assert.equal(w.surface.heightWrites, before); assert.equal(w.time.frames.size, 1);
  w.time.frame(); assert.equal(w.surface.heightWrites, before + 1);
  w.grid.updateLayout(280, false); assert.equal(w.time.frames.size, 0);
});
check("same-width ResizeObserver callbacks do not rebuild all positions", () => {
  const w = wall(), before = w.surface.heightWrites;
  w.scroller.clientHeight = 500; w.resize(); w.resize(); w.time.frame();
  assert.equal(w.surface.heightWrites, before);
  w.scroller.clientWidth = 700; w.resize(); w.time.frame();
  assert.equal(w.surface.heightWrites, before + 1);
});
check("unchanged paints perform no geometry writes", () => {
  const w = wall(), before = w.surface.children.map(n => n.writes);
  w.grid.repaint(); w.grid.repaint();
  assert.deepEqual(w.surface.children.map(n => n.writes), before);
});
check("synchronous repaint does not lose ownership of a queued frame", () => {
  const w = wall(); w.scroller.emit("scroll"); assert.equal(w.time.frames.size, 1);
  w.grid.repaint(); assert.equal(w.time.frames.size, 1);
  w.grid.destroy(); assert.equal(w.time.frames.size, 0);
});
check("destroy cancels queued frames and aspect-ratio work", () => {
  const w = wall(); w.grid.updateLayout(210, true); w.grid.relayoutSoon();
  const before = w.renders(); w.grid.destroy();
  assert.equal(w.time.frames.size, 0); assert.equal(w.time.timers.size, 0);
  w.time.frame(); w.time.timeouts(); w.resize(); w.grid.updateLayout(230, false);
  assert.equal(w.renders(), before); assert.equal(w.time.frames.size, 0);
});
for (const masonry of [false, true]) check("stable scroll anchor survives data reorder (masonry=" + masonry + ")", () => {
  const w = wall({ count: 200, masonry }); w.scroll(1500);
  const visible = w.surface.children.filter(n => yOf(n) + Number.parseFloat(n.style.height) > w.scroller.scrollTop);
  visible.sort((a, b) => Number(a.dataset.poolKey.split("-").at(-1)) - Number(b.dataset.poolKey.split("-").at(-1)));
  const old = visible[0], key = old.dataset.poolKey, delta = yOf(old) - w.scroller.scrollTop;
  w.grid.setItems([...w.rows].reverse(), true);
  const same = w.surface.children.find(n => n.dataset.poolKey === key);
  assert.ok(same, "anchored card must remain mounted");
  assert.equal(same, old); assert.ok(Math.abs(yOf(same) - w.scroller.scrollTop - delta) <= 1);
});
check("refreshing/detaching an active hover releases its decoder", () => {
  const w = wall(), tile = w.surface.children[0]; w.control.setHover(tile);
  const before = w.stops(); w.grid.refresh([tile.dataset.poolKey]); assert.equal(w.stops(), before + 1);
  const next = w.surface.children[0]; w.control.setIntent(next);
  w.grid.setItems(w.rows.filter(row => "item:" + row.id !== next.dataset.poolKey), true);
  assert.ok(w.stops() > before + 1);
});
check("favorite sort derives flags once per item and keeps chronological tie rules", () => {
  let calls = 0, mode = "fav";
  const deps = { sortMode: () => mode, comboCountMap: () => new Map(), stableRowId: row => row.id,
    timeValue: raw => Number.isFinite(Date.parse(raw)) ? Date.parse(raw) : null,
    itemFlags: row => { calls++; return { fav: !!row.fav }; },
    groupFlags: (_section, _folder, row) => { calls++; return { fav: !!row.fav }; }, cardKey: (s, f) => s + "/" + f };
  const sort = new Function(...Object.keys(deps), extract("sortWall") + ";return sortWall;")(...Object.values(deps));
  const rows = Array.from({ length: 10000 }, (_, i) => ({ id: "r" + i, fav: i % 3 === 0, created: "2026-01-01T00:00:00Z" }));
  const original = [...rows]; sort(rows, "group", "combos"); assert.equal(calls, rows.length); assert.deepEqual(rows, original);
  mode = "asc";
  const dates = [{ id: "b", created: "2026-09-09T23:00:00Z" }, { id: "a", created: "2026-09-10T01:00:00+09:00" }, { id: "z", created: "bad" }];
  assert.deepEqual(sort(dates, "item").map(r => r.id), ["a", "b", "z"]);
  mode = "desc"; assert.deepEqual(sort(dates, "item").map(r => r.id), ["b", "a", "z"]);
});

function hover() {
  const time = clock(), state = { root: "A", mode: "gallery", select: { on: false }, preview: { open: false }, lightbox: { open: false } };
  const document = { hidden: false, querySelector: () => null };
  const video = new Node("video"); let plays = 0, loads = 0;
  Object.defineProperty(video, "src", { get() { return this.getAttribute("src"); }, set(value) { this.setAttribute("src", value); } });
  video.pause = () => {}; video.load = () => { loads++; }; video.play = () => { plays++; return Promise.resolve(); };
  let menu = false;
  const deps = { ...time, state, document, video, URL, window: { location: { href: "http://127.0.0.1:12345/" } },
    $: () => ({ hidden: true }), anyNavMenuOpen: () => menu, onHoverVideoMeta() {} };
  const api = new Function(...Object.keys(deps), `
    let hoverIntent = null, hoverVideoEl = null, hoverTile = null, hoverVideoLoad = null, hoverVideoGeneration = 0, rootGeneration = 1;
    const hoverVideoNode = () => (hoverVideoEl = video);
    const clearHoverVideoLoad = () => { hoverVideoGeneration++; hoverVideoLoad = null; };
    ${extract("hoverVideoAllowed")}\n${extract("stopHoverVideo")}\n${extract("startHoverVideo")}\n${extract("bindHoverVideo")}
    return { bindHoverVideo, stopHoverVideo, switchRoot() { state.root = "B"; rootGeneration++; } };
  `)(...Object.values(deps));
  const tile = new Node(); tile.root = true; api.bindHoverVideo(tile, "/media/clip.mp4", { id: "clip" });
  return { api, tile, state, document, time, video, plays: () => plays, loads: () => loads, menu(value) { menu = value; } };
}
check("hover intent cancels transient crossings and starts only after a dwell", () => {
  const h = hover();
  for (let i = 0; i < 100; i++) { h.tile.emit("mouseenter"); h.tile.emit("mouseleave"); }
  h.time.timeouts(); assert.equal(h.plays(), 0); assert.equal(h.time.timers.size, 0);
  h.tile.emit("mouseenter"); assert.equal(h.plays(), 0); h.time.timeouts(); assert.equal(h.plays(), 1);
  h.api.stopHoverVideo(); assert.equal(h.loads(), 1); h.api.stopHoverVideo(); assert.equal(h.loads(), 1);
});
check("selection, menus, hidden pages and root changes reject hover work", () => {
  for (const block of [h => { h.state.select.on = true; }, h => h.menu(true), h => { h.document.hidden = true; }, h => h.api.switchRoot(), h => { h.tile.root = false; }]) {
    const h = hover(); h.tile.emit("mouseenter"); block(h); h.time.timeouts(); assert.equal(h.plays(), 0);
  }
  const h = hover(); h.state.select.on = true; h.tile.emit("mouseenter"); assert.equal(h.time.timers.size, 0);
});
function starfield() {
  const time = clock(), win = new Node(), doc = new Node();
  const stats = { reads: 0, widthWrites: 0, heightWrites: 0, transforms: [] };
  let width = 600, height = 300, bitmapWidth = 300, bitmapHeight = 150;
  const canvas = {
    get clientWidth() { stats.reads++; return width; },
    get clientHeight() { stats.reads++; return height; },
    get width() { return bitmapWidth; },
    set width(value) { stats.widthWrites++; bitmapWidth = value; },
    get height() { return bitmapHeight; },
    set height(value) { stats.heightWrites++; bitmapHeight = value; },
    getContext() { return {
      setTransform: (...args) => stats.transforms.push(args), clearRect() {}, fillRect() {},
    }; },
  };
  Object.assign(win, time, { devicePixelRatio: 1.25, matchMedia: () => ({ matches: false }) });
  const api = new Function("window", "document", `${extract("createLauncherStarfield")}\nreturn createLauncherStarfield;`)(win, doc)(canvas);
  return { api, canvas, stats, time, win,
    resize(w = width, h = height) { width = w; height = h; win.emit("resize"); } };
}
check("starfield batches a resize burst into one bitmap update with the final dimensions", () => {
  const h = starfield(); h.api.start();
  const reads = h.stats.reads, writes = h.stats.widthWrites, transforms = h.stats.transforms.length;
  for (let i = 1; i <= 100; i++) h.resize(600 + i, 300 + i);
  assert.equal(h.stats.reads, reads);
  assert.equal(h.stats.widthWrites, writes);
  assert.equal(h.time.frames.size, 1);
  h.time.frame();
  assert.equal(h.stats.reads, reads + 2);
  assert.equal(h.stats.widthWrites, writes + 1);
  assert.equal(h.stats.transforms.length, transforms + 1);
  assert.equal(h.canvas.width, 875); assert.equal(h.canvas.height, 500);
  h.api.stop();
});
check("starfield leaves unchanged bitmap axes intact and updates scale on a DPI change", () => {
  const h = starfield(); h.api.start();
  const writes = h.stats.widthWrites, heights = h.stats.heightWrites, transforms = h.stats.transforms.length;
  for (let i = 0; i < 100; i++) h.resize();
  h.time.frame();
  assert.equal(h.stats.widthWrites, writes); assert.equal(h.stats.heightWrites, heights);
  assert.equal(h.stats.transforms.length, transforms);
  h.resize(600, 400); h.time.frame();
  assert.equal(h.stats.widthWrites, writes); assert.equal(h.stats.heightWrites, heights + 1);
  h.win.devicePixelRatio = 1.5; h.resize(); h.time.frame();
  assert.equal(h.canvas.width, 900); assert.equal(h.canvas.height, 600);
  assert.deepEqual(h.stats.transforms.at(-1), [1.5, 0, 0, 1.5, 0, 0]);
  h.api.stop();
});
check("starfield ignores zero-sized and stopped work, then resumes at the latest size", () => {
  const h = starfield(); h.api.start();
  const writes = h.stats.widthWrites;
  h.resize(0, 0); h.time.frame();
  assert.equal(h.stats.widthWrites, writes);
  h.resize(800, 500); h.api.stop(); h.time.frame();
  assert.equal(h.stats.widthWrites, writes); assert.equal(h.time.frames.size, 0);
  h.resize(900, 600); h.api.start();
  assert.equal(h.canvas.width, 1125); assert.equal(h.canvas.height, 750);
  assert.equal(h.time.frames.size, 1);
  h.api.stop(); h.api.start();
  assert.equal(h.time.frames.size, 1);
  h.api.stop();
});
console.log(`Interaction performance regressions passed (${checks} checks)`);
