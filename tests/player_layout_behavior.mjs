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
  assert.doesNotMatch(css, /@container\s*\(max-width:\s*560px\)/, "fixed video-width breakpoints must not override the measured label gap");
  assert.match(css, /\.cp-loop\s*\{[^}]*left: var\(--loop-left, 50%\);[^}]*translateX\(-50%\) scale\(var\(--loop-scale, 1\)\)/);
  assert.match(css, /\.cp-loop\.raised\s*\{[^}]*bottom:\s*calc\(100% \+ var\(--control-h\) \+ 6px\)/);
  assert.match(css, /\.cp-loop::after\s*\{[^}]*height:\s*var\(--loop-bridge, 8px\)/);
  for (const selector of ["cp-clock", "player-circle", "cp-volume-box"]) {
    const rule = css.match(new RegExp("\\." + selector + "\\s*\\{([^}]+)\\}"));
    assert.ok(rule);
    assert.doesNotMatch(rule[1], /--loop-scale|scale\(/, "only the AB capsule may shrink, not " + selector);
  }
  assert.match(css, /\.cp-scrub:has\(:focus-visible\) \.cp-loop/);
  assert.doesNotMatch(css, /\.cp-scrub:focus-within \.cp-loop/, "mouse-click focus must not pin the capsule after pointer exit");
  console.log("ok  scaling is restricted to the AB capsule and retains pointer/focus access");
}

{
  const fit = new Function(`${extract("loopCapsuleFit")}; return loopCapsuleFit;`)();
  const base = { trackLeft: 0, trackRight: 347, timeRight: 145, muteLeft: 305, volumeLeft: 305, naturalWidth: 120, controlHeight: 42 };
  const portrait = fit(base);
  assert.equal(portrait.left, 225, "the 371px portrait frame uses the label-gap midpoint, not seek midpoint 173.5");
  assert.equal(portrait.scale, 1);
  assert.equal(portrait.raised, false);
  const wide = fit({ ...base, trackRight: 900, muteLeft: 858, volumeLeft: 858 });
  assert.equal(wide.scale, 1);
  let previous = 1;
  for (const muteLeft of [305, 290, 280, 275, 270, 265, 263]) {
    const value = fit({ ...base, muteLeft, volumeLeft: muteLeft });
    assert.ok(value.scale <= previous && value.scale >= 0.85);
    assert.equal(value.raised, false);
    assert.equal(value.left, (145 + muteLeft) / 2);
    assert.ok(Math.abs(value.bridgeHeight * value.scale - 8) < 0.00001);
    previous = value.scale;
  }
  const narrow = fit({ ...base, muteLeft: 260, volumeLeft: 260 });
  assert.equal(narrow.scale, 0.85);
  assert.equal(narrow.raised, true);
  assert.ok(Math.abs(narrow.bridgeHeight * narrow.scale - 54) < 0.00001, "the scaled bridge still spans the complete lifted-row gap");
  const volume = fit({ ...base, volumeLeft: 200 });
  assert.equal(volume.left, portrait.left, "expanded volume must not change the requested clock/mute midpoint");
  assert.equal(volume.raised, true);
  assert.equal(fit({ ...base, naturalWidth: 0 }), null);
  assert.equal(fit({ ...base, timeRight: NaN }), null);
  console.log("ok  AB fit smoothly scales within the measured label gap and lifts only below its readable floor");
}

{
  const ids = ["cpMediaFrame", "cpScrub", "cpClock", "cpMute", "cpVolumeBox", "cpLoop"];
  const nodes = Object.fromEntries(ids.map(id => [id, node()]));
  let muteLeft = 275;
  nodes.cpScrub.getBoundingClientRect = () => ({ left: 0, right: 400 });
  nodes.cpClock.getBoundingClientRect = () => ({ right: 145 });
  nodes.cpMute.getBoundingClientRect = () => ({ left: muteLeft });
  nodes.cpVolumeBox.getBoundingClientRect = () => ({ left: muteLeft });
  nodes.cpLoop.offsetWidth = 120; nodes.cpLoop.offsetHeight = 42;
  let raised = false, resize, frame = null, queued = 0;
  nodes.cpLoop.classList.toggle = (name, value) => { if (name === "raised") raised = value; };
  const observed = [], events = {};
  const scope = {
    $: id => nodes[id], requestAnimationFrame(fn) { frame = fn; queued++; return queued; },
    ResizeObserver: class { constructor(fn) { resize = fn; } observe(node) { observed.push(node); } },
    window: { addEventListener(type, fn) { events[type] = fn; } },
  };
  const controller = new Function(...Object.keys(scope), `
    let loopLayoutFrame = 0;
    ${["loopCapsuleFit", "scheduleLoopLayout", "bindLoopLayout"].map(name => extract(name)).join("\n")}
    bindLoopLayout(); return { scheduleLoopLayout };
  `)(...Object.values(scope));
  assert.equal(observed.length, 6);
  controller.scheduleLoopLayout(); resize();
  assert.equal(queued, 1, "multiple layout sources in one frame must coalesce");
  frame();
  assert.equal(Number(nodes.cpLoop.style["--loop-scale"]), 0.95);
  assert.equal(raised, false);
  nodes.cpLoop.offsetWidth = 140; // CLEAR can be wider than the repeat icon.
  resize(); frame();
  assert.equal(Number(nodes.cpLoop.style["--loop-scale"]), 0.85);
  assert.equal(raised, true);
  muteLeft = 500; nodes.cpScrub.getBoundingClientRect = () => ({ left: 0, right: 550 });
  events.resize(); frame();
  assert.equal(Number(nodes.cpLoop.style["--loop-scale"]), 1);
  assert.equal(nodes.cpLoop.style["--loop-left"], "322.5px");
  assert.equal(raised, false);
  for (const id of ids.filter(id => id !== "cpLoop")) assert.deepEqual(Object.keys(nodes[id].style), ["setProperty"], "other control sizes must remain untouched");
  assert.match(extract("paintLoopBar"), /scheduleLoopLayout\(\)/, "AB/CLEAR changes must explicitly refresh fit");
  assert.doesNotMatch(extract("paintScrub"), /scheduleLoopLayout|getBoundingClientRect/, "timeupdate rendering must not force layout measurements");
  assert.match(extract("bind"), /bindLoopLayout\(\)/);
  console.log("ok  AB natural-width changes and frame resize refit once per frame without measuring timeupdate");
}

console.log("Player layout and launcher behavior tests passed");
