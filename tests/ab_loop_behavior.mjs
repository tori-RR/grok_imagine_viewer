import "./i18n_test_helpers.mjs";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../static/app.js", import.meta.url), "utf8");
const harness = readFileSync(new URL("./frontend_behavior.mjs", import.meta.url), "utf8");
const scanner = harness.slice(harness.indexOf("const REGEX_PRECEDERS"), harness.indexOf("const failures"));
const extract = new Function("assert", "source", scanner + "\nreturn extract;")(assert, source);

function node() {
  const classes = new Set();
  return {
    style: {}, attributes: {}, hidden: false, disabled: false,
    classList: {
      toggle(name, on) { if (on) classes.add(name); else classes.delete(name); },
      contains(name) { return classes.has(name); },
    },
    setAttribute(name, value) { this.attributes[name] = value; },
    replaceChildren(icon) { this.icon = icon; },
  };
}

function fixture() {
  const nodes = Object.fromEntries([
    "cpLoop", "cpLoopOn", "cpLoopA", "cpLoopB", "cpScrubWrap",
    "cpScrubAb", "cpScrubPlayed", "cpMarkA", "cpMarkB",
  ].map(name => [name, node()]));
  const video = {
    currentTime: 2, duration: 6, loop: false, paused: false, seeking: false, playCalls: 0,
    play() { this.playCalls += 1; this.paused = false; },
  };
  nodes.cpVideo = video;
  const errors = [];
  const scope = {
    $: id => nodes[id], document: { activeElement: null },
    currentPreviewItem: () => ({ media: "video" }),
    paintStageDuration() {}, schedulePlayerControlLayout() {}, state: { preview: { open: true }, volume: { muted: false, level: 100 } },
    fmtDuration: value => String(value),
    repeatSvg: on => ({ kind: "repeat", on }),
    setStatus: message => errors.push(message),
  };
  const names = [
    "loopMark", "videoDuration", "pct", "fmtClock", "loopRange", "abLooping",
    "loopPointError", "paintLoopPointButtons", "loopStateText", "applyLoopMode",
    "paintScrub", "paintLoopBar", "setLoopPoint", "clearAbLoop",
    "setLoopOn", "onLoopIconClick", "seekPreview", "onLoopTick", "jumpToLoopStart", "onLoopEnded",
  ];
  const controls = new Function(...Object.keys(scope), `
    const abLoop = { a: null, b: null };
    let loopOn = true, loopSeeking = false;
    ${names.map(name => extract(name)).join("\n")}
    return { setLoopPoint, onLoopIconClick, setLoopOn, paintLoopBar, paintScrub, seekPreview, onLoopTick, onLoopEnded,
      snapshot: () => ({ ...abLoop, loopOn, active: abLooping(), range: loopRange() }) };
  `)(...Object.values(scope));
  controls.paintLoopBar();
  return { nodes, video, errors, ...controls };
}

{
  const f = fixture();
  f.setLoopPoint("a");
  f.video.currentTime = 1;
  f.paintScrub();
  assert.equal(f.nodes.cpLoopB.disabled, true);
  f.setLoopPoint("b"); // Keyboard entry obeys the same guard as the disabled button.
  assert.deepEqual(f.snapshot().range, { a: 2, b: 6 });
  assert.equal(f.snapshot().b, null);
  assert.match(f.errors.at(-1), /B 点必须晚于/);
  f.video.currentTime = 2;
  f.setLoopPoint("b");
  assert.equal(f.snapshot().b, null);
  f.video.currentTime = 4;
  f.paintScrub();
  assert.equal(f.nodes.cpLoopB.disabled, false);
  f.setLoopPoint("b");
  assert.deepEqual(f.snapshot().range, { a: 2, b: 4 });
  f.video.currentTime = 5;
  f.setLoopPoint("a");
  assert.equal(f.snapshot().a, 2);
  assert.match(f.errors.at(-1), /A 点必须早于/);
  console.log("ok  A/B order is enforced for clicks, keyboard entry and edits");
}

{
  const f = fixture();
  f.setLoopPoint("a");
  assert.equal(f.video.loop, false);
  assert.equal(f.snapshot().active, true);
  assert.equal(f.nodes.cpLoopOn.textContent, "CLEAR");
  assert.equal(f.nodes.cpMarkA.hidden, false);
  assert.equal(f.nodes.cpMarkB.hidden, true);
  assert.equal(f.nodes.cpScrubAb.hidden, false);
  assert.equal(f.nodes.cpScrubAb.style.left, (100 / 3) + "%");
  f.onLoopIconClick();
  assert.equal(f.snapshot().a, null);
  assert.equal(f.snapshot().b, null);
  assert.equal(f.video.loop, true);
  assert.equal(f.nodes.cpScrubAb.hidden, true);
  assert.equal(f.nodes.cpMarkA.hidden, true);
  assert.deepEqual(f.nodes.cpLoopOn.icon, { kind: "repeat", on: true });
  f.onLoopIconClick();
  assert.equal(f.video.loop, false);
  assert.deepEqual(f.nodes.cpLoopOn.icon, { kind: "repeat", on: false });
  f.onLoopIconClick();
  assert.equal(f.video.loop, true);
  console.log("ok  one loop button clears marks, then toggles whole-clip looping");
}

{
  const f = fixture();
  f.video.currentTime = 3;
  f.setLoopPoint("b");
  assert.deepEqual(f.snapshot().range, { a: 0, b: 3 });
  assert.equal(f.nodes.cpLoopOn.textContent, "CLEAR");
  f.setLoopOn(false);
  assert.equal(f.nodes.cpScrubAb.hidden, true);
  f.video.currentTime = 5;
  f.seekPreview(-1);
  assert.equal(f.video.currentTime, 4); // Disabled range must not clamp keyboard seeking.
  f.onLoopIconClick();
  assert.equal(f.snapshot().b, null);
  assert.equal(f.video.loop, true);
  console.log("ok  single-B range and disabled-loop visuals match actual playback");
}

{
  const f = fixture();
  for (const [which, time] of [["a", 6], ["b", 0], ["a", NaN], ["b", Infinity]]) {
    f.video.currentTime = time;
    f.setLoopPoint(which);
    assert.equal(f.snapshot().a, null);
    assert.equal(f.snapshot().b, null);
  }
  f.video.duration = NaN;
  f.video.currentTime = 2;
  f.paintScrub();
  assert.equal(f.nodes.cpLoopA.disabled, true);
  assert.equal(f.nodes.cpLoopB.disabled, true);
  f.setLoopPoint("a");
  assert.equal(f.snapshot().a, null);
  console.log("ok  zero-length endpoints and unavailable metadata cannot create ranges");
}

{
  const f = fixture();
  f.setLoopPoint("a");
  f.video.currentTime = 4;
  f.setLoopPoint("b");
  f.video.paused = true;
  f.onLoopTick();
  assert.equal(f.video.currentTime, 4);
  assert.equal(f.video.playCalls, 0);
  assert.equal(f.video.paused, true);
  f.video.paused = false;
  f.onLoopTick();
  assert.equal(f.video.currentTime, 2);
  assert.equal(f.video.playCalls, 1);
  console.log("ok  paused seeking stays paused while playing across B still loops");
}

{
  const f = fixture();
  f.setLoopPoint("a");
  f.video.currentTime = 2.01;
  f.setLoopPoint("b");
  f.video.currentTime = 2;
  f.onLoopTick();
  assert.equal(f.video.playCalls, 0);
  f.video.currentTime = 2.01;
  f.onLoopTick();
  assert.equal(f.video.currentTime, 2);
  assert.equal(f.video.playCalls, 1);
  const tail = fixture();
  tail.setLoopPoint("a");
  tail.video.currentTime = 6;
  tail.video.paused = true; // Natural media end pauses the element before ended.
  tail.onLoopEnded();
  assert.equal(tail.video.currentTime, 2);
  assert.equal(tail.video.playCalls, 1);
  console.log("ok  short ranges do not loop at A and natural clip-end still loops");
}

assert.match(extract("previewKeys"), /onLoopIconClick\(\)/);
assert.match(extract("init"), /loop: onLoopIconClick/);
assert.doesNotMatch(extract("bind"), /cpLoopClear/);
console.log("A/B loop behavior tests passed");
