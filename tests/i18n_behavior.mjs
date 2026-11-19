import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import vm from "node:vm";

const read = name => readFileSync(new URL("../" + name, import.meta.url), "utf8");
const catalog = read("static/locales/en.js"), runtime = read("static/i18n.js");
function fixture(language = "en-US", languages = []) {
  const events = {};
  const context = vm.createContext({Intl, navigator: {language, languages}, addEventListener: (name, handler) => { events[name] = handler; }});
  vm.runInContext(catalog + "\n" + runtime, context);
  return {i18n: context.GivI18n, catalog: context.GivEnglish, context, events};
}

for (const language of ["zh", "zh-CN", "zh-TW", "zh-Hant-HK", "zh_SG", " ZH-cn "]) {
  assert.equal(fixture(language).i18n.locale(), "zh-CN", language);
}
for (const language of ["en-US", "ja-JP", "ko-KR", "fr-FR", "C", "", "zhx"]) {
  assert.equal(fixture(language).i18n.locale(), "en", language);
}
assert.equal(fixture("en-US", ["en-US", "zh-CN"]).i18n.locale(), "en", "a secondary Chinese preference must not override the primary language");
assert.equal(fixture("", ["zh-TW"]).i18n.locale(), "zh-CN");
console.log("ok  Chinese locales select Chinese; every other primary language selects English");

{
  const {i18n} = fixture("zh-CN");
  i18n.setSystemLanguage("ja-JP");
  assert.equal(i18n.locale(), "en", "the OS UI language outranks browser preferences");
  i18n.setPreference("zh-CN");
  assert.equal(i18n.locale(), "zh-CN");
  i18n.setSystemLanguage("en-US");
  assert.equal(i18n.locale(), "zh-CN", "explicit choices override the OS");
  i18n.setPreference("auto");
  assert.equal(i18n.locale(), "en");
  i18n.setSystemLanguage("zh-TW");
  assert.equal(i18n.locale(), "zh-CN");
  i18n.setPreference("invalid");
  assert.equal(i18n.preference(), "auto");
  console.log("ok  system default, explicit overrides and invalid/legacy preferences resolve correctly");
}

{
  const {i18n} = fixture();
  assert.equal(i18n.t("{count} 个组合", {count: 1}), "1 group");
  assert.equal(i18n.t("{count} 个组合", {count: 2}), "2 groups");
  const tag = '<img src=x onerror="bad()">中文 {count}';
  assert.equal(i18n.t("已打标签「{tag}」· {count} 项", {tag, count: 2}), `Tagged 2 items with “${tag}”`);
  i18n.setPreference("zh-CN");
  assert.equal(i18n.t("{count} 个组合", {count: 2}), "2 个组合");
  assert.equal(i18n.t("unknown.key"), "unknown.key");
  console.log("ok  plural rules, source fallback and literal user interpolation preserve content");
}

{
  const {i18n} = fixture();
  assert.equal(i18n.message("读取清单 · 3s · 首次同步较慢"), "Reading manifest · 3s · Initial sync takes longer");
  assert.equal(i18n.message("清单 15 / 20"), "Manifest 15 / 20");
  assert.equal(i18n.message("1 个组合 · D:\\我的图库"), "1 group · D:\\我的图库");
  const path = "D:\\我的图库\\English";
  const translated = i18n.message("已新建空图库 " + path + " · 切到 Grok 登录后点「下载」拉取");
  assert.ok(translated.includes(path));
  i18n.setPreference("zh-CN");
  assert.equal(i18n.message("Manifest 15 / 20"), "清单 15 / 20");
  assert.equal(i18n.message(translated), "已新建空图库 " + path + " · 切到 Grok 登录后点「下载」拉取");
  assert.equal(i18n.message("unknown diagnostic 中文"), "unknown diagnostic 中文");
  assert.equal(i18n.message("unknown 2 项"), "unknown 2 项", "generic count formats must not consume arbitrary diagnostic text");
  console.log("ok  protocol progress and known status messages translate without altering paths");
}

{
  const {i18n, context, events} = fixture("zh-CN");
  function node(attrs, text = "") {
    return {attrs, textContent: text, value: "", getAttribute(key) { return this.attrs[key]; }, setAttribute(key, value) { this.attrs[key] = value; }};
  }
  const title = node({"data-i18n": "Imagine 图库"}, "Imagine 图库");
  const button = node({"data-i18n": "复制提示词"}, "复制提示词");
  const input = node({"data-i18n-placeholder": "搜索所有创作", placeholder: "搜索所有创作"});
  const selects = [node({"data-language-select": ""}), node({"data-language-select": ""})];
  const user = node({}, "我的作品 <script>");
  const all = [title, button, input, ...selects, user];
  context.document = {documentElement: {}, querySelectorAll(selector) { return all.filter(n => Object.hasOwn(n.attrs, selector.slice(1, -1))); }};
  i18n.apply();
  button.textContent = "已复制";
  i18n.setPreference("en");
  assert.equal(title.textContent, "Imagine Gallery");
  assert.equal(button.textContent, "Copied", "live state is translated rather than reset");
  assert.equal(input.attrs.placeholder, "Search all creations");
  assert.equal(context.document.documentElement.lang, "en");
  assert.deepEqual(selects.map(s => s.value), ["en", "en"]);
  assert.equal(user.textContent, "我的作品 <script>");
  i18n.setPreference("zh-CN");
  assert.equal(button.textContent, "已复制", "live state survives repeated language switches");
  let changes = 0;
  i18n.subscribe(() => changes++);
  i18n.setPreference("auto");
  context.navigator.language = "ja-JP";
  events.languagechange();
  assert.equal(i18n.locale(), "en");
  assert.ok(changes >= 2);
  console.log("ok  both selectors, document language, attributes and dynamic states update; user DOM stays untouched");
}

{
  const {catalog: en} = fixture();
  const needed = new Set();
  for (const file of ["static/app.js", "static/player-settings.js", "static/environment.js"]) {
    for (const match of read(file).matchAll(/\bt\(("(?:[^"\\]|\\.)*")/g)) needed.add(JSON.parse(match[1]));
  }
  for (const match of read("static/index.html").matchAll(/data-i18n(?:-[\w-]+)?="([^"]+)"/g)) needed.add(match[1].replaceAll("&quot;", '"').replaceAll("&amp;", "&"));
  for (const key of needed) assert.ok(Object.hasOwn(en, key), "Missing English translation: " + key);
  for (const [key, entry] of Object.entries(en)) {
    for (const value of typeof entry === "object" ? Object.values(entry) : [entry]) {
      assert.equal(/[\p{Script=Han}]/u.test(value), false, "Untranslated English value: " + key);
      const placeholders = text => [...new Set(text.match(/\{\w+\}/g) || [])].sort();
      assert.deepEqual(placeholders(value), placeholders(key), "Translation placeholder mismatch: " + key);
    }
  }
  assert.ok(read("static/index.html").indexOf('/static/i18n.js') < read("static/index.html").indexOf('/static/app.js'));
  for (const match of read("static/index.html").matchAll(/<([a-z][\w-]*)\b[^>]*\bdata-i18n="[^"]+"[^>]*>([\s\S]*?)<\/\1>/g)) {
    assert.equal(/<[a-z]/i.test(match[2]), false, "Translation must not replace nested controls: " + match[0]);
  }
  assert.equal(/<script\b[^>]*>\s*GivI18n/.test(read("static/index.html")), false, "desktop CSP requires external scripts");
  console.log(`ok  English catalog covers ${needed.size} UI messages with matching interpolation fields`);
}

{
  const {i18n} = fixture();
  const harness = read("tests/frontend_behavior.mjs");
  const scanner = harness.slice(harness.indexOf("const REGEX_PRECEDERS"), harness.indexOf("const failures"));
  const extract = new Function("assert", "source", scanner + "\nreturn extract;")(assert, read("static/app.js"));
  const nodes = new Proxy({}, {get(target, key) {
    if (target[key]) return target[key];
    const classes = new Set();
    return target[key] = {
      style: {}, attrs: {},
      replaceChildren(icon) { this.icon = icon; },
      setAttribute(name, value) { this.attrs[name] = value; },
      classList: { contains: name => classes.has(name), toggle: (name, on) => on ? classes.add(name) : classes.delete(name) },
    };
  }});
  Object.assign(nodes.cpVideo, {currentTime: 4.8, paused: true});
  const volume = {muted: false, level: 50};
  const scope = {$: id => nodes[id], currentPreviewItem: () => ({media: "video"}), paintStageDuration() {}, paintLoopPointButtons() {}, videoDuration: () => 10,
    document: {activeElement: null}, pct: (n, total) => 100 * n / total, loopOn: false, loopRange: () => null, abLoop: {a: null, b: null},
    fmtDuration: n => String(n), state: {volume}, playerUI: null, speakerSvg: silent => ({silent}), t: i18n.t};
  const {paintScrub, paintVolume} = new Function(...Object.keys(scope),
    `${extract("paintScrub")}\n${extract("paintVolume")}\nreturn {paintScrub, paintVolume};`)(...Object.values(scope));
  paintScrub();
  paintVolume();
  assert.equal(nodes.cpPlay.attrs["aria-label"], "Play");
  assert.equal(nodes.cpMute.attrs["aria-label"], "Mute");
  assert.equal(nodes.cpSeek.value, "480");
  assert.equal(nodes.cpClock.textContent, "4 / 10", "the clock shows elapsed whole seconds");
  assert.equal(nodes.cpVolumeBox.classList.contains("is-muted"), false);
  volume.muted = true;
  paintVolume();
  assert.equal(nodes.cpMute.attrs["aria-label"], "Unmute");
  assert.equal(nodes.cpVolumeBox.classList.contains("is-muted"), true);
  nodes.cpVideo.paused = false;
  paintScrub();
  assert.equal(nodes.cpPlay.attrs["aria-label"], "Pause");
  assert.equal(nodes.cpPlay.classList.contains("is-playing"), true);
  assert.equal(nodes.cpMuteIcon.classList.contains("is-silent"), true, "time updates preserve the mute icon state");
  Object.assign(volume, {muted: false, level: 0});
  paintVolume();
  assert.equal(nodes.cpVolumeBox.classList.contains("is-muted"), false, "zero volume is controlled by the slider");
  assert.equal(nodes.cpMuteIcon.classList.contains("is-silent"), true);
  assert.equal(nodes.cpMute.attrs["aria-label"], "Mute");
  console.log("ok  translated playback and unmute actions update with the player state");
}
