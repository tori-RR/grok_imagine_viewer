import "./i18n_test_helpers.mjs";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../static/app.js", import.meta.url), "utf8");
const harness = readFileSync(new URL("./frontend_behavior.mjs", import.meta.url), "utf8");
const scanner = harness.slice(harness.indexOf("const REGEX_PRECEDERS"), harness.indexOf("const failures"));
const extract = new Function("assert", "source", scanner + "\nreturn extract;")(assert, source);

function node() {
  const listeners = {};
  return {
    children: [], attrs: {}, hidden: false, scrollTop: 0,
    style: { setProperty(k, v) { this[k] = v; } },
    classList: { toggle() {} },
    addEventListener(k, fn) { (listeners[k] ||= []).push(fn); },
    removeEventListener(k, fn) { listeners[k] = (listeners[k] || []).filter(f => f !== fn); },
    emit(k, extra = {}) {
      const event = { target: this, preventDefault() { this.prevented = true; }, stopPropagation() {}, ...extra };
      for (const fn of listeners[k] || []) fn(event);
      return event;
    },
    setAttribute(k, v) { this.attrs[k] = v; },
    appendChild(child) {
      if (child.parentNode) child.parentNode.removeChild(child);
      child.parentNode = this; this.children.push(child); return child;
    },
    removeChild(child) { this.children.splice(this.children.indexOf(child), 1); child.parentNode = null; },
    replaceChildren(...children) { this.children = []; children.forEach(c => this.appendChild(c)); },
    contains(child) { return this === child || this.children.some(c => c.contains ? c.contains(child) : c === child); },
  };
}

{
  const button = node(), menu = node(), wrap = node(), row = node();
  wrap.appendChild(button); wrap.appendChild(menu); menu.appendChild(row);
  menu.hidden = true;
  menu.querySelector = () => row;
  button.closest = () => wrap;
  const document = { activeElement: null };
  row.focus = () => { document.activeElement = row; wrap.emit("focusin", { target: row }); };
  button.focus = () => { document.activeElement = button; wrap.emit("focusin", { target: button }); };
  let opens = 0, paints = 0, timeout = null;
  new Function("$", "document", "closeNavMenus", "paintPlusMenu", "openLibraryFlow", "setTimeout", "clearTimeout", `${extract("bindPlusMenu")}; bindPlusMenu();`)(
    id => id === "plusBtn" ? button : menu, document,
    except => { if (except !== "plusMenu") { menu.hidden = true; button.attrs["aria-expanded"] = "false"; } },
    () => paints++, () => opens++, fn => { timeout = fn; return 1; }, () => { timeout = null; },
  );
  wrap.emit("pointerenter", { pointerType: "mouse" });
  assert.equal(menu.hidden, false);
  wrap.emit("pointerenter", { pointerType: "mouse" });
  assert.equal(paints, 1, "moving inside the menu must not replace the focused rows");
  wrap.emit("pointerleave");
  assert.equal(menu.hidden, true);
  button.emit("click");
  assert.equal(opens, 1);
  assert.equal(menu.hidden, true);
  wrap.emit("keydown", { target: button, key: "ArrowDown" });
  assert.equal(menu.hidden, false);
  assert.equal(document.activeElement, row);
  wrap.emit("pointerleave");
  assert.equal(menu.hidden, false, "pointer departure cannot hide keyboard focus inside the menu");
  wrap.emit("keydown", { target: row, key: "Escape" });
  assert.equal(menu.hidden, true);
  assert.equal(document.activeElement, button);
  button.emit("pointerdown", { pointerType: "touch" });
  assert.equal(typeof timeout, "function");
  timeout();
  button.emit("pointerup");
  button.emit("click");
  assert.equal(opens, 1, "the click following a touch hold must not also open the picker");
  assert.equal(menu.hidden, false);
  button.emit("pointerdown", { pointerType: "touch" });
  button.emit("pointerup");
  button.emit("click");
  assert.equal(opens, 2, "an ordinary tap opens the picker directly");
  console.log("ok  library launcher supports direct click, hover history, focus and touch hold");
}

{
  const html = readFileSync(new URL("../static/index.html", import.meta.url), "utf8");
  const css = readFileSync(new URL("../static/style.css", import.meta.url), "utf8");
  assert.match(html, /class="nav-left launcher-hidden"/);
  assert.match(html, /id="volBtn" class="nav-circle launcher-hidden"/);
  assert.match(html, /id="status" class="status launcher-hidden"/);
  assert.match(css, /body\.launcher-open \.launcher-hidden\s*\{\s*display:\s*none !important;/);
  assert.doesNotMatch(html, /id="settingsBtn"[^>]*launcher-hidden/);
  assert.doesNotMatch(html, /id="launcherCreate"/);
  assert.doesNotMatch(source, /\$\("launcherCreate"\)/);
  console.log("ok  launcher header hides library actions and keeps language and settings available");
}

{
  const html = readFileSync(new URL("../static/index.html", import.meta.url), "utf8");
  const css = readFileSync(new URL("../static/style.css", import.meta.url), "utf8");
  assert.match(html, /<div id="launcher"[^>]*>[\s\S]*?<canvas id="launcherStarfield" class="launcher-starfield" aria-hidden="true"><\/canvas>/);
  assert.match(css, /\.launcher-starfield\s*\{[^}]*position:\s*absolute;[^}]*pointer-events:\s*none;/);
  assert.match(css, /\.launcher-card\s*\{[^}]*position:\s*relative;[^}]*z-index:\s*1;/);
  assert.match(source, /prefers-reduced-motion:\s*reduce/);
  assert.match(extract("showLauncher"), /launcherStarfield\.start\(\)/);
  assert.match(extract("hideLauncher"), /launcherStarfield\.stop\(\)/);
  assert.match(extract("createLauncherStarfield"), /cancelAnimationFrame\(frameId\)/);
  console.log("ok  animated starfield is scoped to the launcher and pauses after it closes");
}

{
  const film = node(); film.clientWidth = 55; film.clientHeight = 200;
  let resized;
  const mount = new Function("$", "el", "filmThumb", "ResizeObserver", `
    let filmStrip; const state = { preview: { index: 0 } };
    const FILM_THUMB = 64, FILM_GAP = 10, FILM_OVERSCAN = 2;
    function destroyFilmstrip() { filmStrip = null; }
    ${extract("mountFilmstrip")}
    mountFilmstrip(Array.from({length: 100}, (_,i) => ({id: i})));
    return () => filmStrip;
  `)(() => film, () => node(), () => node(), class { constructor(fn) { resized = fn; } observe() {} disconnect() {} });
  assert.equal(film.style["--film-thumb-size"], "47px");
  assert.equal(film.children[0].style.height, "5690px");
  mount().showIndex(10);
  assert.equal(film.scrollTop, 417);
  film.clientWidth = 35;
  resized();
  assert.equal(film.style["--film-thumb-size"], "27px");
  assert.equal(film.children[0].style.height, "3690px");
  assert.ok(Math.abs(film.scrollTop - 417 * 37 / 57) < 0.001, "resize preserves the virtual scroll row");
  mount().showIndex(99);
  assert.equal(film.scrollTop, 3490);
  assert.ok(film.children[1].children.length < 20, "narrow rail still virtualizes thumbnails");
  assert.doesNotMatch(extract("mountFilmstrip"), /scrollIntoView/, "film selection must not scroll outer containers sideways");
  const css = readFileSync(new URL("../static/style.css", import.meta.url), "utf8");
  assert.match(css, /\.cp-film\s*\{[^}]*overflow-x: hidden;[^}]*scrollbar-gutter: stable;/);
  console.log("ok  filmstrip fits scrollbar-reduced width and keeps virtual rows aligned after resize");
}

{
  const current = { id: "cover", section: "combos", folder: "group", url: "/media/current" };
  const state = { flat: [
    { ...current, folder: "different", url: "/media/wrong-folder" },
    { ...current, section: "_other", url: "/media/wrong-section" }, current,
    { ...current, id: "next", url: "/media/next" },
  ] };
  const seed = new Function("state", `const flatGroupIndexes = new WeakMap(); ${extract("flatGroupMembers")} ${extract("previewSeed")}; return previewSeed;`)(state);
  assert.deepEqual(seed("combos", "group", "cover"), { items: state.flat.slice(2), index: 0 });
  assert.deepEqual(seed("combos", "group", "missing"), { items: [], index: 0 });
  assert.deepEqual(seed("combos", "group", ""), { items: [], index: 0 });
  assert.match(extract("openCombo"), /items: seed.items/);
  assert.match(extract("openCombo"), /const data = await loadCombo/);
  console.log("ok  combo preview can start from a matching loaded cover while refreshing authoritative metadata");
}

{
  const paint = extract("paintPlusMenu");
  assert.doesNotMatch(paint, /openLibraryFlow|createLibraryFlow/);
  assert.match(paint, /historyForgetButton/);
  assert.match(extract("historyForgetButton"), /forgetHistoryPath\(path, ev\)/);
  assert.match(extract("forgetHistoryPath"), /stopPropagation/);
  console.log("ok  recent list has no duplicate picker actions and forget does not open a library");
}

{
  const css = readFileSync(new URL("../static/player.css", import.meta.url), "utf8");
  assert.match(css, /\.cp-scrub-wrap\s*\{[^}]*transform: scale\(var\(--cp-controls-scale, 1\)\)/);
  assert.match(css, /\.cp-clock\s*\{[^}]*flex: none;[^}]*width: max-content;/, "preserve the natural width of the entire timecode");
  assert.match(css, /\.cp-loop\.raised::after\s*\{[^}]*height:\s*calc\(var\(--control-h\) \+ 12px\)/);
  assert.match(css, /\.cp-scrub:has\(:focus-visible\) \.cp-loop/);
  assert.doesNotMatch(css, /\.cp-scrub:focus-within \.cp-loop/, "mouse-click focus must not pin the capsule after pointer exit");
  console.log("ok  controls share a single scale and the raised A/B capsule retains hover and focus access");
}

{
  const fit = new Function(`${extract("playerControlFit")}; return playerControlFit;`)();
  const base = { frameWidth: 371, frameHeight: 557, inset: 16, gap: 8, playWidth: 36, clockWidth: 105,
    muteWidth: 36, volumeWidth: 36, loopWidth: 126, inlineHeight: 136, raisedHeight: 186 };
  const portrait = fit(base);
  assert.equal(portrait.left, 226, "center the capsule between the timecode and the sound button");
  assert.equal(portrait.scale, 1);
  assert.equal(portrait.raised, false);
  assert.equal(fit({...base, frameWidth: 359}).scale, 1, "keep the original size up to first contact");
  assert.equal(fit({...base, frameWidth: 320}).scale, 320 / 359);
  assert.equal(fit({...base, frameWidth: 280}).scale, 0.85);
  const narrow = fit({ ...base, frameWidth: 176 });
  assert.equal(narrow.scale, 176 / 225);
  assert.equal(narrow.raised, true);
  assert.ok(narrow.left + base.loopWidth / 2 <= 176 / narrow.scale - 2 * base.inset + 0.001);
  const volume = fit({ ...base, volumeWidth: 150 });
  assert.equal(volume.left, portrait.left, "expanded volume must not change the requested clock/mute midpoint");
  assert.equal(volume.raised, true);
  assert.equal(fit({...base, frameWidth: 176, clockWidth: 165}).scale, 176 / 285, "hour-length timecodes take part in the fit");
  assert.equal(fit({...base, frameWidth: 185, frameHeight: 90}).raised, false, "short landscape frames can fit better on one row");
  assert.equal(fit({ ...base, loopWidth: 0 }), null);
  assert.equal(fit({ ...base, frameWidth: NaN }), null);
  console.log("ok  the fitted timecode, slider and A/B capsule share one scale in narrow or short frames");
}

{
  const ids = ["cpMediaFrame", "cpScrubWrap", "cpScrub", "cpPlay", "cpClock", "cpMute", "cpVolumeBox", "cpLoop", "cpFs"];
  const nodes = Object.fromEntries(ids.map(id => [id, node()]));
  let width = 320;
  nodes.cpMediaFrame.getBoundingClientRect = () => ({ width, height: 480 });
  nodes.cpScrub.offsetHeight = nodes.cpScrubWrap.offsetHeight = 32;
  nodes.cpClock.offsetWidth = 105;
  nodes.cpClock.parentElement = {offsetTop: -39};
  nodes.cpPlay.offsetWidth = nodes.cpMute.offsetWidth = nodes.cpVolumeBox.offsetWidth = 36;
  nodes.cpLoop.offsetWidth = 126; nodes.cpLoop.offsetHeight = nodes.cpFs.offsetHeight = 42;
  let raised = false, resize, frame = null, queued = 0;
  nodes.cpLoop.classList.toggle = (name, value) => { if (name === "raised") raised = value; };
  const observed = [];
  const scope = {
    $: id => nodes[id], requestAnimationFrame(fn) { frame = fn; queued++; return queued; },
    ResizeObserver: class { constructor(fn) { resize = fn; } observe(node) { observed.push(node); } },
    getComputedStyle: () => ({ getPropertyValue: key => ({"--cp-inset": "16px", "--cp-gap": "8px", "--cp-fullscreen-inset": "12px"})[key] }),
  };
  const controller = new Function(...Object.keys(scope), `
    let playerControlLayoutFrame = 0;
    ${["playerControlFit", "schedulePlayerControlLayout", "bindPlayerControlLayout"].map(name => extract(name)).join("\n")}
    bindPlayerControlLayout(); return { schedulePlayerControlLayout };
  `)(...Object.values(scope));
  assert.equal(observed.length, 6);
  controller.schedulePlayerControlLayout(); resize();
  assert.equal(queued, 1, "multiple layout sources in one frame must coalesce");
  frame();
  assert.equal(Number(nodes.cpMediaFrame.style["--cp-controls-scale"]), 320 / 359);
  assert.equal(raised, false);
  nodes.cpLoop.offsetWidth = 160; // A wider CLEAR action consumes more of the row.
  resize(); frame();
  assert.equal(Number(nodes.cpMediaFrame.style["--cp-controls-scale"]), 0.85);
  assert.equal(raised, true);
  width = 600;
  resize(); frame();
  assert.equal(Number(nodes.cpMediaFrame.style["--cp-controls-scale"]), 1);
  assert.equal(nodes.cpLoop.style["--loop-left"], "340.5px");
  assert.equal(raised, false);
  assert.match(extract("paintLoopBar"), /schedulePlayerControlLayout\(\)/, "AB/CLEAR changes must explicitly refresh fit");
  assert.doesNotMatch(extract("paintScrub"), /schedulePlayerControlLayout|getBoundingClientRect/, "timeupdate rendering must not force layout measurements");
  assert.match(extract("bind"), /bindPlayerControlLayout\(\)/);
  console.log("ok  intrinsic control widths and media resize refit once per frame without measuring timeupdate");
}

{
  const frame = node(), video = node(), seek = node(), played = node();
  const window = node(), document = node(), touch = node();
  let hovered = true, pendingFrames = 0, plays = 0;
  frame.matches = () => hovered;
  const classes = new Set();
  frame.classList = {add: name => classes.add(name), remove: name => classes.delete(name)};
  Object.assign(video, {
    paused: false, readyState: 4, duration: 10, currentTime: 3,
    pause() { this.paused = true; this.emit("pause"); },
    async play() { plays++; this.paused = false; this.emit("playing"); },
  });
  const nodes = {cpMediaFrame: frame, cpVideo: video, cpSeek: seek, cpScrubPlayed: played};
  const scope = {
    $: id => nodes[id], window, document, matchMedia: () => touch, state: {preview: {open: true}},
    pct: (time, duration) => 100 * time / duration, videoDuration: () => video.duration, paintScrub() {},
    requestAnimationFrame() { pendingFrames++; return 1; }, cancelAnimationFrame() { pendingFrames--; },
  };
  const switchClip = new Function(...Object.keys(scope), `
    let previewMediaLoad = {};
    ${extract("bindPreviewScrubber")}
    bindPreviewScrubber();
    return () => { previewMediaLoad = {}; };
  `)(...Object.values(scope));
  video.emit("playing");
  assert.equal(pendingFrames, 1);
  assert.equal(played.style.width, "30%");
  hovered = false;
  frame.emit("mouseleave");
  await Promise.resolve();
  assert.equal(pendingFrames, 0, "an invisible seek bar must stop scheduling frames");

  const pointer = {isPrimary: true, button: 0, pointerId: 1};
  seek.emit("pointerdown", pointer);
  window.emit("pointerup", {pointerId: 2});
  assert.equal(video.paused, true, "another pointer must not end this drag");
  switchClip();
  window.emit("pointerup", pointer);
  assert.equal(plays, 0, "a release from the previous clip must not start this clip");
  assert.equal(classes.has("control-drag"), false);
  video.paused = false;
  seek.emit("pointerdown", pointer);
  window.emit("pointercancel", pointer);
  assert.equal(plays, 1, "an interrupted drag on the same playing clip restores playback");
  video.pause();
  seek.emit("pointerdown", pointer);
  window.emit("pointerup", pointer);
  assert.equal(plays, 1, "a clip that started paused stays paused");
  console.log("ok  preview scrubbing restores playback only for the original clip and animates visible progress");
}

console.log("Player layout and launcher behavior tests passed");
