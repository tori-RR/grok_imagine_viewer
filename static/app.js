/* 本机 Imagine 图库预览。用户数据一律走 DOM API，不用 innerHTML 拼标题。 */

(function () {
  "use strict";

  const t = (...args) => window.GivI18n.t(...args);
  const translate = (...args) => window.GivI18n.message(...args);
  const $ = (id) => document.getElementById(id);
  const COMPACT_MIN = 160;
  const EXPANDED_MIN = 220;
  const TILE_MIN = 96;
  const TILE_MAX = 240;
  const WALL_GAP = 3;
  const OVERSCAN_PX = 420;
  const BAND = 400;
  const POOL_MAX = 320;
  const IMG_POOL_MAX = 600;
  const CARDS_BATCH = 40;
  const TRASH_WRITE_BATCH = 64;
  const COVER_RETRY_MS = 900;
  const COVER_RETRY_MAX = 6;
  // B1: the length rides on the cover response, which answers 204 until ffprobe
  // has run. A few spaced-out HEADs cover that gap without polling the share.
  const DUR_POLL_MS = 1100;
  const DUR_POLL_MAX = 4;

  // B4: a menu, not a two-way toggle. Older configs only held asc / desc.
  const SORT_MODES = ["desc", "asc", "fav", "count"];
  const SORT_LABELS = {
    desc: "日期倒序",
    asc: "日期正序",
    fav: "喜欢优先",
    count: "数量优先",
  };

  const defaultView = () => ({ density: "compact", sort: "desc", cats: [], tile: 0 });

  const state = {
    root: "",
    library: null,
    metaKnown: true,
    view: "combos",
    filter: "all",
    // gallery = 本地图库; grok = Tauri 的独立远端 WebView 覆盖内容区。
    mode: "gallery",
    grokEngine: "",
    grokDocked: false,
    volume: { level: 100, muted: false },
    query: "",
    flat: null,
    flatIncomplete: null,
    flatPromise: null,
    flatPromiseGen: 0,
    flatPromiseRoot: "",
    preview: { open: false, section: "", folder: "", card: null, items: [], index: 0, savedId: "", token: "", gen: 0 },
    lightbox: { open: false, items: [], index: 0 },
    grid: null,
    browsePath: "",
    browseParent: null,
    browseSelectable: false,
    browseGeneration: 0,
    browseLoading: false,
    browseAddressTimer: 0,
    browsePlaces: [],
    meta: { version: 2, revision: 0, tags: ["ACG"], items: {}, groups: {}, grokUserId: "" },
    views: { combos: defaultView(), flat: defaultView(), other: defaultView() },
    ctx: null,
    tagTarget: null,
    tagTargetRoot: "",
    config: null,
    accel: null,
    select: { on: false, picked: new Map() },
    cards: new Map(),
    ratios: new Map(),
    trash: [],
    launcher: false,
  };

  let playerUI = null;
  let trashBusy = false;
  const imgPool = new Map();
  const FILM_THUMB = 64;
  const FILM_GAP = 10;
  const FILM_OVERSCAN = 8;
  let hoverVideoEl = null;
  let hoverTile = null;
  let hoverVideoGeneration = 0;
  let hoverVideoLoad = null;
  let hoverIntent = null;
  // B2: A-B loop for the video on the stage. Cleared whenever the stage changes,
  // so a mark can never leak onto the next clip. The switch is not: it is the
  // user's setting and survives stepping through items and combos.
  const abLoop = { a: null, b: null };
  let loopOn = true;
  let loopSeeking = false;
  let previewWheelLock = 0;
  let renderGen = 0;
  let previewGen = 0;
  let previewMediaGeneration = 0;
  let previewMediaLoad = null;
  let metaWriteGen = 0;
  let metaRevision = 0;
  let metaRevisionRoot = "";
  let metaWriteTail = Promise.resolve();
  let metaPending = 0;
  let viewsWriteTail = Promise.resolve();
  let sideStateLoadGen = 0;
  let libraryChangePending = 0;
  let rootGeneration = 0;
  let libraryAbort = null;
  let filmStrip = null;
  let loadingDepth = 0;
  let cardsTimer = 0;
  const cardsWanted = new Set();
  const cardsInflight = new Set();

  function el(tag, attrs, children) {
    const node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach((key) => {
        const value = attrs[key];
        if (value == null || value === false) return;
        if (key === "class") node.className = value;
        else if (key === "dataset") Object.assign(node.dataset, value);
        else if (key.slice(0, 2) === "on") node.addEventListener(key.slice(2).toLowerCase(), value);
        else if (key === "text") node.textContent = value;
        else if (value === true) node.setAttribute(key, "");
        else node.setAttribute(key, String(value));
      });
    }
    (children || []).forEach((child) => {
      if (child == null) return;
      node.appendChild(typeof child === "string" ? document.createTextNode(child) : child);
    });
    return node;
  }

  async function api(url, options) {
    const res = await fetch(url, options);
    const type = res.headers.get("content-type") || "";
    if (!type.includes("application/json")) {
      if (!res.ok) throw new Error("HTTP " + res.status);
      return null;
    }
    return res.json();
  }

  function jsonOpts(method, body, extra) {
    const opts = {
      method: method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body || {}),
    };
    if (extra) Object.assign(opts, extra);
    return opts;
  }

  function fmtDate(value) {
    if (!value) return "";
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return String(value).slice(0, 10);
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return d.getFullYear() + "-" + m + "-" + day;
  }

  /* B1: `0:15` like the site, `1:02:03` once a clip runs past an hour. */
  function fmtDuration(seconds) {
    const total = Math.round(Number(seconds) || 0);
    if (!(total > 0)) return "";
    const pad = (n) => String(n).padStart(2, "0");
    const s = total % 60;
    const m = Math.floor(total / 60) % 60;
    const h = Math.floor(total / 3600);
    if (h > 0) return h + ":" + pad(m) + ":" + pad(s);
    return m + ":" + pad(s);
  }

  /* The badge belongs on the cover, above the caption gradient rather than on
     top of the title, so it is placed inside the fade block as its own row. A
     node without a caption (filmstrip thumb) keeps the absolute corner. */
  function setDurationBadge(node, seconds) {
    if (!node) return false;
    const text = fmtDuration(seconds);
    if (!text) return false;
    let badge = node.querySelector(".dur-badge");
    if (!badge) {
      badge = el("span", { class: "dur-badge" });
      const fade = node.querySelector(".tile-fade");
      if (fade) fade.insertBefore(badge, fade.firstChild);
      else node.appendChild(badge);
    }
    badge.textContent = text;
    return true;
  }

  // Lengths already learned this session, so a tile scrolling back into the pool
  // does not ask the server again.
  const durationCache = new Map();
  const durationAsking = new Map();

  function knownDuration(id, fallback) {
    if (fallback > 0) return Number(fallback);
    const hit = id ? durationCache.get(id) : 0;
    return hit > 0 ? hit : 0;
  }

  async function readCoverDuration(url) {
    try {
      const res = await fetch(url, { method: "HEAD" });
      return Number(res.headers.get("X-Cover-Duration") || 0) || 0;
    } catch (err) {
      return 0;
    }
  }

  /* Windows portable has no ffprobe. Reading just enough of the file for
     `loadedmetadata` is how the badge still appears. One element at a time so
     a CIFS library is not hit with a decoder per tile. */
  let mediaProbeChain = Promise.resolve();
  let mediaProbeCancel = null;
  function cancelDurationProbe() {
    if (mediaProbeCancel) mediaProbeCancel();
  }

  function durationNodeWanted(node, expectedRoot, generation) {
    if (state.root !== expectedRoot || rootGeneration !== generation || !node.isConnected || state.preview.open) return false;
    const rect = node.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.right > 0
      && rect.top < window.innerHeight && rect.left < window.innerWidth;
  }

  function probeBrowserDuration(url, wanted) {
    if (!url) return Promise.resolve(0);
    const run = () => {
      // A serial queue can outlive the tile, library or preview that queued it.
      if (!wanted()) return Promise.resolve(0);
      return new Promise((resolve) => {
        const v = document.createElement("video");
        v.preload = "metadata";
        v.muted = true;
        v.playsInline = true;
        let done = false;
        let timer = 0;
        const cancel = () => finish(0);
        const finish = (n) => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          if (mediaProbeCancel === cancel) mediaProbeCancel = null;
          v.onloadedmetadata = null;
          v.onerror = null;
          v.removeAttribute("src");
          try { v.load(); } catch (err) { /* ignore */ }
          const seconds = Number(n);
          resolve(wanted() && Number.isFinite(seconds) && seconds > 0 ? seconds : 0);
        };
        mediaProbeCancel = cancel;
        v.onloadedmetadata = () => finish(v.duration);
        v.onerror = () => finish(0);
        timer = setTimeout(() => finish(0), 12000);
        v.src = url;
      });
    };
    const next = mediaProbeChain.then(run, run);
    mediaProbeChain = next.then(() => 0, () => 0);
    return next;
  }

  /* B1: sidecar first (cheap HEAD). If the pack has no ffprobe the header stays
     empty, then the page measures the clip itself and writes it back. */
  function wantDuration(node, section, folder, id, mediaUrl) {
    if (!node || !id) return;
    const expectedRoot = state.root;
    const generation = rootGeneration;
    const cached = durationCache.get(id);
    if (cached > 0) {
      setDurationBadge(node, cached);
      return;
    }
    const prior = durationAsking.get(id);
    if (prior && prior.root === expectedRoot && prior.generation === generation) return;
    const request = { root: expectedRoot, generation: generation };
    durationAsking.set(id, request);
    const wanted = () => durationAsking.get(id) === request && durationNodeWanted(node, expectedRoot, generation);
    const done = () => { if (durationAsking.get(id) === request) durationAsking.delete(id); };
    let url = "";
    let tries = 0;
    const ask = async () => {
      if (!wanted()) { done(); return; }
      tries += 1;
      if (!url) url = coverUrlFor(section, folder, id);
      let seconds = await readCoverDuration(url);
      if (!wanted()) { done(); return; }
      if (!(seconds > 0) && mediaUrl && tries === 1) {
        seconds = await probeBrowserDuration(mediaUrl, wanted);
        if (!wanted()) { done(); return; }
        if (seconds > 0) {
          saveMeasuredDuration({ id: id, section: section, folder: folder }, seconds, expectedRoot);
        }
      }
      if (seconds > 0) {
        done();
        noteDuration(id, seconds);
        return;
      }
      if (tries >= DUR_POLL_MAX || !node.isConnected) {
        done();
        return;
      }
      setTimeout(ask, DUR_POLL_MS * tries);
    };
    // Constructors call this before mounting the tile. Check visibility after
    // that synchronous mount, not before it (which would skip every new tile).
    Promise.resolve().then(ask);
  }

  /* One length, everywhere it can show: the card rows the wall was built from,
     the mounted tiles, the open preview and its filmstrip. */
  function noteDuration(id, seconds) {
    if (!id || !(seconds > 0)) return;
    durationCache.set(id, seconds);
    if (Array.isArray(state.flat)) {
      state.flat.forEach((item) => {
        if (item.id === id) item.duration = seconds;
      });
    }
    (state.preview.items || []).forEach((item) => {
      if (item.id === id) item.duration = seconds;
    });
    ["combos", "other"].forEach((key) => {
      const list = state.library && state.library[key];
      if (!Array.isArray(list)) return;
      list.forEach((entry) => {
        if ((entry.coverId || "") === id) entry.duration = seconds;
      });
    });
    state.cards.forEach((row) => {
      if ((row.coverId || "") === id) row.duration = seconds;
    });
    // The wall is virtualized, so this only walks what is actually on screen;
    // a tile is tagged with the asset its cover came from, group card or not.
    document.querySelectorAll("#main .tile, #cpFilm .cp-thumb").forEach((node) => {
      if (node.dataset.coverId === id) setDurationBadge(node, seconds);
    });
    const cur = currentPreviewItem();
    if (cur && cur.id === id) paintStageDuration();
  }

  /* The browser decoded the clip to play it, so its metadata is a free second
     source when ffprobe is missing or could not read the container. */
  async function saveMeasuredDuration(item, seconds, expectedRoot) {
    expectedRoot = String(expectedRoot || "");
    if (!item || !item.id || !(seconds > 0) || state.root !== expectedRoot) return;
    noteDuration(item.id, seconds);
    try {
      await api(
        "/api/duration",
        jsonOpts("POST", {
          section: item.section,
          folder: item.folder || "",
          id: item.id,
          duration: seconds,
          expectedRoot: expectedRoot,
        })
      );
    } catch (err) { /* the badge is already up; the sidecar can wait */ }
  }

  function setStatus(text, isError) {
    const box = $("status");
    if (!text) {
      box.hidden = true;
      box.textContent = "";
      box.classList.remove("error");
      return;
    }
    box.hidden = false;
    box.textContent = translate(text);
    box.classList.toggle("error", !!isError);
  }

  function titleOf(entry) {
    return (entry && (entry.title || entry.folder)) || t("未命名");
  }

  function viewKey() {
    if (state.view === "flat") return "flat";
    if (state.view === "other") return "other";
    return "combos";
  }

  function currentView() {
    const key = viewKey();
    if (!state.views[key]) state.views[key] = defaultView();
    return state.views[key];
  }

  function minWidthFor(view) {
    const tile = view && Number(view.tile);
    if (tile && tile >= TILE_MIN && tile <= TILE_MAX) return tile;
    return (view && view.density === "expanded") ? EXPANDED_MIN : COMPACT_MIN;
  }

  function isMasonry(view) {
    return !!(view && view.density === "expanded");
  }

  function setLoading(on, text) {
    loadingDepth = Math.max(0, loadingDepth + (on ? 1 : -1));
    const veil = $("loading");
    if (!veil) return;
    if (loadingDepth > 0) {
      if (text) $("loadingText").textContent = text;
      veil.hidden = false;
    } else {
      veil.hidden = true;
    }
  }

  async function withLoading(text, run) {
    setLoading(true, text);
    try {
      return await run();
    } finally {
      setLoading(false);
    }
  }

  function catsMode(cats) {
    const list = cats || [];
    if (!list.length || list.indexOf("default") >= 0) return "default";
    if (list.indexOf("all") >= 0) return "all";
    return "filter";
  }

  function groupKey(section, folder) {
    if (section === "_root") return "_root";
    return (section || "combos") + "/" + (folder || "");
  }

  function flagBool(local, rec) {
    if (local === true || local === false) return local;
    return !!rec;
  }

  function itemFlags(item) {
    const rec = (state.meta.items || {})[item && item.id] || {};
    return {
      fav: flagBool(item && item.fav, rec.fav),
      dislike: flagBool(item && item.dislike, rec.dislike),
      tags: Array.isArray(item && item.tags) ? item.tags : (rec.tags || []),
    };
  }

  function groupOwnFlags(section, folder, entry) {
    const rec = (state.meta.groups || {})[groupKey(section, folder)];
    return rec || { fav: !!(entry && entry.ownFav), dislike: !!(entry && entry.dislike), tags: (entry && entry.ownTags) || [] };
  }

  function groupFlags(section, folder, entry) {
    const own = groupOwnFlags(section, folder, entry);
    const ids = entry && entry.memberIds;
    const children = Array.isArray(ids) ? ids.map((id) => (state.meta.items || {})[id] || {}) : [];
    const inheritedTags = Array.isArray(ids) ? children.flatMap((it) => it.tags || []) : (entry && entry.inheritedTags) || [];
    const inheritedFav = Array.isArray(ids) ? children.some((it) => it.fav) : !!(entry && entry.inheritedFav);
    return { fav: !!own.fav || inheritedFav, dislike: !!own.dislike,
      tags: [...new Set((own.tags || []).concat(inheritedTags))],
      ownFav: !!own.fav, inheritedFav: inheritedFav };
  }

  function catPass(flags) {
    if (state.metaKnown === false) return true;
    const cats = currentView().cats || [];
    const mode = catsMode(cats);
    if (mode === "default") return !flags.dislike;
    if (mode === "all") return true;
    const tags = flags.tags || [];
    const ungrouped = !flags.fav && !flags.dislike && !tags.length;
    return cats.some((cat) => {
      if (cat === "default" || cat === "all") return false;
      if (cat === "fav") return !!flags.fav;
      if (cat === "dislike") return !!flags.dislike;
      if (cat === "ungrouped") return ungrouped;
      return tags.indexOf(cat) >= 0;
    });
  }

  function comboFilterPass(entry, section) {
    // A. a combo with nothing live in it never shows up on the wall.
    if (entry.countKnown !== false && entry.count === 0) return false;
    if (entry.countKnown !== false && state.filter === "image") {
      if (typeof entry.images === "number" && entry.images <= 0) return false;
    }
    if (entry.countKnown !== false && state.filter === "video") {
      if (typeof entry.videos === "number" && entry.videos <= 0) return false;
    }
    return entry.metadataKnown === false || catPass(groupFlags(section, entry.folder || "", entry));
  }

  function itemFilterPass(item) {
    if (state.filter === "image" && item.media !== "image") return false;
    if (state.filter === "video" && item.media !== "video") return false;
    return item.metadataKnown === false || catPass(itemFlags(item));
  }

  function matchesQuery(haystacks) {
    const q = state.query.trim().toLowerCase();
    if (!q) return true;
    return haystacks.some((s) => String(s || "").toLowerCase().includes(q));
  }

  function sortMode() {
    const value = currentView().sort;
    return SORT_MODES.indexOf(value) >= 0 ? value : "desc";
  }

  // A flat tile has no count of its own. "数量" means the size of the combo the
  // media belongs to, so sisters out of one big combo stay together.
  function comboCountOf(item) {
    const row = state.cards.get(cardKey(item.section, item.folder || ""));
    if (row && typeof row.count === "number") return row.count;
    const entry = libListFor(item.section).find((e) => (e.folder || "") === (item.folder || ""));
    return entry && typeof entry.count === "number" ? entry.count : 1;
  }

  // One pass over the library instead of a linear search inside every
  // comparison, which on a large flat wall was O(n log n * combos).
  function comboCountMap(rows) {
    const entries = new Map();
    ["combos", "_other"].forEach((section) => {
      libListFor(section).forEach((entry) => {
        entries.set(cardKey(entry.section || section, entry.folder || ""), entry);
      });
    });
    const counts = new Map();
    rows.forEach((item) => {
      const key = cardKey(item.section, item.folder || "");
      if (counts.has(key)) return;
      const card = state.cards.get(key);
      if (card && typeof card.count === "number") {
        counts.set(key, card.count);
        return;
      }
      const entry = entries.get(key);
      counts.set(key, entry && typeof entry.count === "number" ? entry.count : 1);
    });
    return counts;
  }

  // `2026-09-10T01:00:00+09:00` is earlier than `2026-09-09T23:00:00Z`, and the
  // fractional-seconds part is optional, so the raw strings cannot be compared.
  const timeValueCache = new Map();

  function timeValue(raw) {
    if (typeof raw !== "string" || !raw) return null;
    if (timeValueCache.has(raw)) return timeValueCache.get(raw);
    const parsed = Date.parse(raw);
    const value = Number.isFinite(parsed) ? parsed : null;
    if (timeValueCache.size > 20000) timeValueCache.clear();
    timeValueCache.set(raw, value);
    return value;
  }

  function stableRowId(row, kind) {
    if (kind === "item") return String((row && (row.id || row.file)) || "");
    return String((row && (row.id || row.folder)) || "");
  }

  /* B4: date either way, hearts first, or fullest combo first. */
  function sortWall(list, kind, section) {
    const mode = sortMode();
    const dir = mode === "asc" ? 1 : -1;
    const combo = kind === "group" && section !== "_other";
    const counts = mode === "count" && kind === "item" ? comboCountMap(list) : null;
    // Derive expensive inherited flags/date keys once, not for every comparison.
    // Keys live only for this sort: a metadata mutation cannot leave stale keys.
    const rows = list.map(row => ({
      row,
      id: stableRowId(row, kind),
      date: (combo ? timeValue(row.latestItemCreatedAt) : null) ?? timeValue(row.created),
      fav: mode === "fav" ? !!(kind === "item" ? itemFlags(row).fav : groupFlags(section, row.folder || "", row).fav) : false,
      count: mode === "count" ? (kind === "item"
        ? (counts.get(cardKey(row.section, row.folder || "")) ?? 1)
        : (typeof row.count === "number" ? row.count : 0)) : 0,
    }));
    const byDate = (a, b) => {
      const byId = a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
      if (a.date === null && b.date === null) return byId;
      if (a.date === null) return 1;
      if (b.date === null) return -1;
      if (a.date === b.date) return byId;
      return a.date < b.date ? -dir : dir;
    };
    rows.sort((a, b) => {
      if (mode === "fav") return Number(b.fav) - Number(a.fav) || byDate(a, b);
      if (mode === "count") return b.count - a.count || byDate(a, b);
      return byDate(a, b);
    });
    return rows.map(entry => entry.row);
  }

  async function ensureFlat() {
    if (state.flatIncomplete && (state.flatIncomplete.root !== state.root || state.flatIncomplete.generation !== rootGeneration)) {
      state.flatIncomplete = null;
    }
    if (state.flat && !state.flatIncomplete) return state.flat;
    if (state.flatPromise) return state.flatPromise;
    const expectedRoot = state.root;
    const expectedGen = rootGeneration;
    const request = api("/api/flat").then((data) => {
      if (state.flatPromise !== request || expectedGen !== rootGeneration || state.root !== expectedRoot) {
        if (state.flatPromise === request) state.flatPromise = null;
        return state.flat || [];
      }
      const metadataUnknown = data && data.metaKnown === false;
      const corruptGroups = data && Array.isArray(data.groupIssues) && data.groupIssues.some((issue) => issue.state === "corrupt" || issue.cardError);
      const incomplete = data && (!data.ok || metadataUnknown || corruptGroups || (Array.isArray(data.unavailableGroups) && data.unavailableGroups.length));
      if (incomplete) {
        if (metadataUnknown) state.metaKnown = false;
        const message = metadataUnknown ? t("收藏和标签暂不可用，当前显示可读取的媒体。请修复后刷新。") : corruptGroups ? t("部分组合记录无法核验，当前显示可读取的媒体。请修复后刷新。") : t("部分素材暂不可用，当前列表可能不完整。请刷新重试。");
        state.flat = null;
        state.flatIncomplete = { root: expectedRoot, generation: expectedGen, code: data.code || "records_unavailable", message: message };
        state.flatPromise = null;
        setStatus(message, true);
        return data.ok ? data.items || [] : [];
      }
      if (data && data.ok) clearFlatReadWarning();
      if (data && data.warnings) {
        const warning = trashReadWarning(data);
        if (warning) setStatus(warning, true);
      }
      state.flat = data && data.ok ? data.items || [] : [];
      if (data && data.ok) state.flatIncomplete = null;
      state.flatPromise = null;
      return state.flat;
    }).catch(() => {
      if (state.flatPromise === request && expectedGen === rootGeneration && state.root === expectedRoot) {
        state.flatPromise = null;
        state.flat = null;
        state.flatIncomplete = { root: expectedRoot, generation: expectedGen, code: "read_unavailable", message: t("部分素材暂不可用，当前列表可能不完整。请刷新重试。") };
        setStatus(state.flatIncomplete.message, true);
      } else if (state.flatPromise === request) {
        state.flatPromise = null;
      }
      return state.flat || [];
    });
    state.flatPromise = request;
    state.flatPromiseGen = expectedGen;
    state.flatPromiseRoot = expectedRoot;
    return request;
  }

  function promptsByFolder(items, section) {
    const map = {};
    (items || []).forEach((item) => {
      if (section && item.section !== section) return;
      const key = item.folder || "";
      if (!map[key]) map[key] = [];
      if (item.prompt) map[key].push(item.prompt);
    });
    return map;
  }

  function safeRevision(value) {
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
  }

  function cloneJson(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function applyMeta(meta, root) {
    if (!meta || typeof meta !== "object") return;
    const revision = safeRevision(meta.revision);
    if (revision == null) return;
    root = String(root || "");
    if (root === metaRevisionRoot && revision < metaRevision) return;
    metaRevision = revision;
    metaRevisionRoot = root;
    state.metaKnown = true;
    state.meta = {
      version: 2,
      revision: revision,
      tags: Array.isArray(meta.tags) && meta.tags.length ? meta.tags.slice() : ["ACG"],
      items: meta.items && typeof meta.items === "object" ? meta.items : {},
      groups: meta.groups && typeof meta.groups === "object" ? meta.groups : {},
      grokUserId: String(meta.grokUserId || ""),
    };
  }

  function applyViews(views) {
    ["combos", "flat", "other"].forEach((key) => {
      const src = views && views[key];
      const tile = Number(src && src.tile) || 0;
      state.views[key] = {
        density: src && src.density === "expanded" ? "expanded" : "compact",
        sort: SORT_MODES.indexOf(src && src.sort) >= 0 ? src.sort : "desc",
        cats: Array.isArray(src && src.cats) ? src.cats.slice() : [],
        tile: tile >= TILE_MIN && tile <= TILE_MAX ? tile : 0,
      };
    });
  }

  async function loadSideState(expectedRoot) {
    expectedRoot = String(expectedRoot || "");
    const gen = ++sideStateLoadGen;
    if (expectedRoot && expectedRoot !== metaRevisionRoot) {
      state.metaKnown = false;
      metaRevision = 0;
      metaRevisionRoot = expectedRoot;
      state.meta = {
        version: 2,
        revision: 0,
        tags: ["ACG"],
        items: {},
        groups: {},
        grokUserId: "",
      };
      applyViews(null);
    }
    try {
      const meta = await api("/api/meta");
      if (
        gen === sideStateLoadGen
        && expectedRoot
        && meta && meta.ok
        && String(meta.root || "") === expectedRoot
      ) {
        if (meta.metaKnown === false) state.metaKnown = false;
        else applyMeta(meta.meta, expectedRoot);
      }
    } catch (err) { if (gen === sideStateLoadGen) state.metaKnown = false; }
    try {
      const views = await api("/api/views");
      if (
        gen === sideStateLoadGen
        && expectedRoot
        && views && views.ok
        && String(views.root || "") === expectedRoot
      ) {
        applyViews(views.views);
      }
    } catch (err) { /* keep defaults */ }
  }

  function saveViews(expectedRoot, capturedViews, fromTimer) {
    if (!fromTimer) {
      if (viewsTimer) clearTimeout(viewsTimer);
      viewsTimer = 0;
      viewsTimerGen += 1;
    }
    expectedRoot = String(expectedRoot || state.root || "");
    if (!expectedRoot || state.root !== expectedRoot) return Promise.resolve(null);
    const snapshot = capturedViews || cloneJson(state.views);
    const run = async () => {
      if (state.root !== expectedRoot) return null;
      const data = await api(
        "/api/views",
        jsonOpts("PUT", { views: snapshot, expectedRoot: expectedRoot })
      );
      if (!data || !data.ok) throw new Error((data && data.error) || t("视图写入失败。"));
      if (String(data.root || "") !== expectedRoot || state.root !== expectedRoot) return null;
      return data;
    };
    const task = viewsWriteTail.then(run);
    viewsWriteTail = task.catch(() => null);
    return task.catch(() => null);
  }

  let viewsTimer = 0;
  let viewsTimerGen = 0;
  function saveViewsSoon() {
    if (viewsTimer) clearTimeout(viewsTimer);
    const gen = ++viewsTimerGen;
    const expectedRoot = String(state.root || "");
    viewsTimer = setTimeout(() => {
      viewsTimer = 0;
      if (gen !== viewsTimerGen || state.root !== expectedRoot) return;
      saveViews(expectedRoot, cloneJson(state.views), true);
    }, 400);
  }

  function metaPatchReplaySafe(payload) {
    if (!payload || typeof payload !== "object") return true;
    if (payload.replace || Array.isArray(payload.tags)) return false;
    const carriesTags = (patch) => (
      patch && typeof patch === "object"
      && Object.prototype.hasOwnProperty.call(patch, "tags")
    );
    if (carriesTags(payload.item) || carriesTags(payload.group)) return false;
    if (Array.isArray(payload.itemPatches) && payload.itemPatches.some(carriesTags)) return false;
    if (Array.isArray(payload.groupPatches) && payload.groupPatches.some(carriesTags)) return false;
    return true;
  }

  function metaRootCurrent(root) {
    return state.root === root && metaRevisionRoot === root;
  }

  async function putMetaNow(payload, expectedRoot, gen) {
    const busyDelays = [75, 150, 300];
    let busyAttempt = 0;
    let conflictReplay = 0;
    while (true) {
      if (
        !expectedRoot
        || state.root !== expectedRoot
        || metaRevisionRoot !== expectedRoot
      ) {
        throw new Error(t("图库已经切换，已取消元数据写入。"));
      }
      const body = Object.assign({}, payload, {
        expectedRoot: expectedRoot,
        expectedRevision: metaRevision,
      });
      const data = await api("/api/meta", jsonOpts("PUT", body));
      if (data && data.ok && data.meta) {
        if (String(data.root || "") !== expectedRoot || state.root !== expectedRoot) {
          throw new Error(t("图库在写入期间发生了切换。"));
        }
        const revision = safeRevision(data.meta.revision);
        if (revision == null || metaRevisionRoot !== expectedRoot) {
          throw new Error(t("服务端返回了无效的元数据版本。"));
        }
        metaRevision = revision;
        if (gen === metaWriteGen) {
          applyMeta(data.meta, expectedRoot);
          rerenderTiles();
          resortWallSoon();
        }
        return data;
      }
      if (data && data.code === "meta_conflict" && conflictReplay < 1) {
        if (String(data.root || "") !== expectedRoot || state.root !== expectedRoot) {
          throw new Error(t("图库在写入期间发生了切换。"));
        }
        const revision = safeRevision(
          data.meta && data.meta.revision != null ? data.meta.revision : data.actualRevision
        );
        if (revision == null || metaRevisionRoot !== expectedRoot) {
          throw new Error(t("服务端返回了无效的元数据冲突版本。"));
        }
        if (!metaPatchReplaySafe(payload)) {
          // Absolute tag arrays cannot be rebased without knowing the user's
          // semantic add/remove intent. Keep the authoritative document and
          // surface the conflict instead of overwriting another window's edit.
          if (gen === metaWriteGen) applyMeta(data.meta, expectedRoot);
          throw new Error(t("元数据已在另一窗口更新，请重试这次标签操作。"));
        }
        // A later queued mutation may already exist optimistically in state.meta.
        // Advance only the CAS token; the newest success reconciles the document.
        metaRevision = revision;
        conflictReplay += 1;
        continue;
      }
      if (data && data.code === "meta_busy" && busyAttempt < busyDelays.length) {
        const wait = busyDelays[busyAttempt++];
        await delay(wait);
        continue;
      }
      throw new Error((data && data.error) || t("元数据写入失败。"));
    }
  }

  function putMeta(payload, expectedRoot) {
    if (state.metaKnown === false) return Promise.reject(new Error(t("元数据无法核验，已暂停编辑；请修复后刷新。")));
    expectedRoot = String(expectedRoot || "");
    if (!expectedRoot || state.root !== expectedRoot) {
      return Promise.reject(new Error(t("图库已经切换，已取消元数据写入。")));
    }
    const patch = cloneJson(payload || {});
    if (!metaPatchReplaySafe(patch) && metaPending > 0) {
      return Promise.reject(new Error(t("另一项元数据写入尚未完成，请重试。")));
    }
    const gen = ++metaWriteGen;
    metaPending += 1;
    const task = metaWriteTail.then(() => putMetaNow(patch, expectedRoot, gen));
    // A failed mutation must not poison the queue for every later user action.
    metaWriteTail = task.catch(() => null);
    task.then(
      () => { metaPending = Math.max(0, metaPending - 1); },
      () => { metaPending = Math.max(0, metaPending - 1); }
    );
    return task;
  }

  function downloadBlocksLibraryChange() {
    return dlBusy || dlStopping;
  }

  function libraryChangeAllowed() {
    if (!downloadBlocksLibraryChange()) return true;
    setStatus(dlStopping ? t("正在停止下载，请稍候再切换图库。") : t("请先停止下载，再切换或新建图库。"), true);
    return false;
  }

  async function withLibraryChange(run) {
    if (!libraryChangeAllowed()) return null;
    libraryChangePending += 1;
    rootGeneration += 1;
    updateDownloadHistory();
    if (libraryAbort) libraryAbort.abort();
    libraryAbort = new AbortController();
    try {
      return await run();
    } catch (err) {
      if (err && err.name === "AbortError") return { skipped: true };
      throw err;
    } finally {
      libraryChangePending = Math.max(0, libraryChangePending - 1);
      updateDownloadHistory();
    }
  }

  function applyLibrary(lib, root) {
    cancelDurationProbe();
    clearComboCache();
    hideComboPreview();
    closeLightbox();
    closeCtx();
    imgPool.clear();
    state.cards.clear();
    state.ratios.clear();
    cardsWanted.clear();
    cardsInflight.clear();
    setSelectMode(false);
    const nextRoot = (lib && lib.root) || root || state.root;
    if (nextRoot !== state.root) {
      if (viewsTimer) clearTimeout(viewsTimer);
      viewsTimer = 0;
      viewsTimerGen += 1;
      metaWriteGen += 1;
      durationCache.clear();
      durationAsking.clear();
      stopHoverVideo();
    }
    state.library = lib || null;
    if (lib && lib.metaKnown === false) state.metaKnown = false;
    state.root = nextRoot;
    updateDownloadHistory();
    state.flat = null;
    state.flatIncomplete = null;
    state.flatPromise = null;
    state.flatPromiseGen = 0;
    state.flatPromiseRoot = "";
    state.wallItems = null;
    state.wallSection = "";
    if (lib && lib.ok) hideLauncher();
    const hasOther = !!(lib && lib.hasOther);
    if (!hasOther && state.view === "other") state.view = "combos";
    if (lib && lib.metaKnown !== false && Array.isArray(lib.tags) && lib.tags.length) {
      state.meta.tags = lib.tags.slice();
    }
    syncNav();
    if (!lib || !lib.ok) {
      setStatus((lib && lib.error) || t("请选择图库根目录。"), true);
    } else {
      const n = (lib.combos || []).length;
      const o = (lib.other || []).length;
      const path = lib.root || "";
      let line = t("{count} 个组合 · {path}", {count: n, path});
      if (lib.hasOther) line = t("{count} 个组合 · {other} 组其它 · {path}", {count: n, other: o, path});
      if (lib.mode === "single") line = t("单个组合 · {path}", {path});
      if (state.view === "trash") line = t("回收站 · {path}", {path});
      setStatus(line);
      if (lib.warnings) {
        const warning = trashReadWarning(lib);
        if (warning) setStatus(warning, true);
      }
    }
    render();
  }

  async function loadLibrary() {
    const expectedGen = rootGeneration;
    return withLoading(t("正在读取图库…"), async () => {
      const lib = await api("/api/library");
      if (expectedGen !== rootGeneration) return { skipped: true };
      await loadSideState(lib && lib.root);
      if (expectedGen !== rootGeneration) return { skipped: true };
      applyLibrary(lib, lib && lib.root);
      return lib;
    });
  }

  async function setRoot(path) {
    return withLibraryChange(() => withLoading(t("正在打开图库…"), async () => {
      const expectedGen = rootGeneration;
      const data = await api(
        "/api/root",
        jsonOpts("POST", { root: path }, { signal: libraryAbort ? libraryAbort.signal : undefined })
      );
      if (expectedGen !== rootGeneration || (data && data.skipped) || (data && data.code === "stale_root_request")) {
        return { skipped: true };
      }
      if (!data) return null;
      await loadSideState(data.root);
      if (expectedGen !== rootGeneration) return { skipped: true };
      applyLibrary(data.library, data.root);
      if (data.library && data.library.ok) refreshConfig();
      return data.library;
    }));
  }

  function createLauncherStarfield(canvas) {
    const noop = { start() {}, stop() {} };
    if (!canvas || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return noop;
    const ctx = canvas.getContext("2d", { alpha: true });
    if (!ctx) return noop;

    const stars = [];
    const mouse = { x: -999, y: -999, on: false };
    let width = 0;
    let height = 0;
    let frameId = 0;
    let running = false;
    let resizePending = false;
    let pixelRatio = 0;

    function resize() {
      const nextWidth = canvas.clientWidth;
      const nextHeight = canvas.clientHeight;
      if (!nextWidth || !nextHeight) return false;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      if (nextWidth === width && nextHeight === height && dpr === pixelRatio) return true;
      width = nextWidth;
      height = nextHeight;
      pixelRatio = dpr;
      const pixelWidth = Math.floor(width * dpr);
      const pixelHeight = Math.floor(height * dpr);
      if (canvas.width !== pixelWidth) canvas.width = pixelWidth;
      if (canvas.height !== pixelHeight) canvas.height = pixelHeight;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      seed();
      return true;
    }

    function seed() {
      const count = Math.round((width * height) / 2800);
      stars.length = 0;
      for (let i = 0; i < count; i += 1) {
        stars.push({
          x: Math.random() * width,
          y: Math.random() * height,
          size: Math.random() < 0.16 ? 2 : 1,
          base: 0.22 + Math.random() * 0.34,
          phase: Math.random() * Math.PI * 2,
          speed: 0.7 + Math.random() * 1.5,
        });
      }
    }

    function frame(stamp) {
      if (!running) return;
      if (resizePending) {
        resizePending = false;
        resize();
      }
      ctx.clearRect(0, 0, width, height);
      const t = stamp * 0.001;
      const radius = 100;
      for (const star of stars) {
        const pulse = 0.5 + 0.5 * Math.sin(t * star.speed + star.phase);
        const twinkle = 0.18 + 0.82 * pulse * pulse;
        let alpha = star.base * twinkle;
        if (mouse.on) {
          const dx = star.x - mouse.x;
          const dy = star.y - mouse.y;
          const dist = Math.hypot(dx, dy);
          if (dist < radius) {
            const falloff = 1 - dist / radius;
            alpha = Math.min(1, alpha + falloff * falloff * 0.95);
          }
        }
        ctx.fillStyle = `rgba(232,234,238,${alpha})`;
        const x = star.x | 0;
        const y = star.y | 0;
        ctx.fillRect(x, y, star.size, star.size);
        if (alpha > 0.6 && star.size === 2) {
          ctx.fillRect(x - 1, y, 1, 1);
          ctx.fillRect(x + star.size, y, 1, 1);
          ctx.fillRect(x, y - 1, 1, 1);
          ctx.fillRect(x, y + star.size, 1, 1);
        }
      }
      frameId = window.requestAnimationFrame(frame);
    }

    function start() {
      if (running || !resize()) return;
      running = true;
      frameId = window.requestAnimationFrame(frame);
    }

    function stop() {
      running = false;
      resizePending = false;
      if (frameId) window.cancelAnimationFrame(frameId);
      frameId = 0;
      mouse.on = false;
      ctx.clearRect(0, 0, width, height);
    }

    window.addEventListener("resize", () => {
      // Reuse the animation frame: a drag can emit several resize events
      // before paint, and resetting a canvas reallocates its backing bitmap.
      if (running) resizePending = true;
    });
    window.addEventListener("mousemove", (event) => {
      if (!running) return;
      mouse.x = event.clientX;
      mouse.y = event.clientY;
      mouse.on = true;
    });
    document.addEventListener("mouseleave", () => {
      mouse.on = false;
    });

    return { start, stop };
  }

  const launcherStarfield = createLauncherStarfield($("launcherStarfield"));

  /* F. launcher: nothing is scanned until the user points at a directory. */
  function showLauncher(errorText) {
    closeBrowser();
    state.launcher = true;
    document.body.classList.add("launcher-open");
    $("launcher").hidden = false;
    launcherStarfield.start();
    const err = $("launcherError");
    if (errorText) {
      err.hidden = false;
      err.textContent = translate(errorText);
    } else {
      err.hidden = true;
      err.textContent = "";
    }
    paintHistory();
  }

  function hideLauncher() {
    closeBrowser();
    state.launcher = false;
    document.body.classList.remove("launcher-open");
    $("launcher").hidden = true;
    launcherStarfield.stop();
  }

  function applyHistory(rows) {
    if (!state.config) state.config = {};
    state.config.history = Array.isArray(rows) ? rows : [];
    if (state.launcher) paintHistory();
    if ($("plusMenu") && !$("plusMenu").hidden) paintPlusMenu();
  }

  async function forgetHistoryPath(path, ev) {
    if (ev) {
      ev.preventDefault();
      ev.stopPropagation();
    }
    if (!path) return;
    const data = await api("/api/history/remove", jsonOpts("POST", { path: path }));
    if (!data || !data.ok) {
      setStatus((data && data.error) || t("无法更新图库历史。"), true);
      return;
    }
    applyHistory(data.history);
  }

  async function clearLibraryHistory() {
    if (!window.confirm(t("清除全部图库历史？不会删除磁盘上的文件。"))) return;
    const data = await api("/api/history/clear", jsonOpts("POST", {}));
    if (!data || !data.ok) {
      setStatus((data && data.error) || t("无法清除图库历史。"), true);
      return;
    }
    applyHistory(data.history);
  }

  function historyForgetButton(path) {
    return el("button", {
      type: "button",
      class: "history-forget",
      text: "×",
      title: t("从历史中移除"),
      "aria-label": t("从历史中移除"),
      onclick: (ev) => void forgetHistoryPath(path, ev),
    });
  }

  function paintHistory() {
    const list = $("launcherHistory");
    const rows = (state.config && state.config.history) || [];
    list.replaceChildren();
    $("launcherHint").hidden = !rows.length;
    rows.forEach((row) => {
      const bits = [];
      if (!row.exists) bits.push(t("路径不在了"));
      const open = el("div", {
        class: "history-open",
        role: "button",
        tabindex: "0",
        onclick: () => openLibraryPath(row.path),
        onkeydown: (ev) => {
          if (ev.key === "Enter") openLibraryPath(row.path);
        },
      }, [
        el("span", { class: "history-name", text: row.name || row.path }),
        el("span", { class: "history-path", text: row.path }),
        bits.length ? el("span", { class: "history-mark", text: bits.join(" · ") }) : null,
      ]);
      list.appendChild(el("li", {
        class: "history-row" + (row.exists ? "" : " missing"),
      }, [open, historyForgetButton(row.path)]));
    });
    const clear = $("launcherHistoryClear");
    if (clear) {
      clear.hidden = !rows.length;
    }
  }

  async function refreshConfig() {
    try {
      const cfg = await api("/api/config");
      if (cfg) {
        state.config = cfg;
        if (cfg.accel) applyAccel(cfg.accel);
        if (state.launcher) paintHistory();
      }
      return cfg;
    } catch (err) {
      return null;
    }
  }

  async function openLibraryPath(path) {
    if (!path) return;
    if (!libraryChangeAllowed()) return;
    closeBrowser();
    const lib = await setRoot(path);
    if (lib && lib.skipped) return;
    if (!lib || !lib.ok) {
      showLauncher((lib && lib.error) || t("无法识别这个目录。"));
      await refreshConfig();
    }
  }

  function applyAccel(accel) {
    state.accel = accel || null;
    const btn = $("accelBtn");
    if (!btn || !accel) return;
    const hardware = accel.effective === "hardware";
    btn.textContent = t("封面 · ") + (hardware ? t("自动回退") : "CPU");
    btn.classList.toggle("active", hardware);
    const bits = [t("模式：") + (accel.mode === "compat" ? t("兼容（强制软解）") : t("硬件加速（自动探测）"))];
    bits.push(t("候选解码：") + (hardware ? accel.hwaccel : "CPU") + t("（不是实际解码器观测）"));
    bits.push(t("封面缩放 / JPEG 编码：CPU；解码可尝试候选硬件后端"));
    bits.push("ffmpeg：" + (accel.ffmpeg || t("未找到（视频封面暂不可用）")));
    if (accel.gpu) bits.push("GPU：" + accel.gpu);
    if (accel.fallback) bits.push(t("回退原因：") + accel.fallback);
    btn.title = bits.join("\n");
    paintAccelMenu();
  }

  function paintAccelMenu() {
    const menu = $("accelMenu");
    if (!menu || menu.hidden) return;
    const accel = state.accel || {};
    menu.replaceChildren();
    [
      { key: "auto", label: t("硬件加速（探测可用则用）") },
      { key: "compat", label: t("兼容（强制软解，不用 GPU）") },
    ].forEach((opt) => {
      const box = el("input", { type: "radio", name: "accelMode" });
      box.checked = (accel.mode || "auto") === opt.key;
      box.addEventListener("change", () => setAccelMode(opt.key));
      menu.appendChild(el("label", {}, [box, document.createTextNode(opt.label)]));
    });
    const hardware = accel.effective === "hardware";
    menu.appendChild(
      el("div", { class: "hint", text: t("候选解码：{backend}", {backend: hardware ? (accel.hwaccel || "") : "CPU"}) })
    );
    menu.appendChild(el("div", { class: "hint", text: t("封面缩放与 JPEG 编码：CPU；硬件解码失败只回退该文件") }));
    menu.appendChild(
      el("div", { class: "hint", text: "ffmpeg：" + (accel.ffmpeg || t("未找到，视频封面用占位")) })
    );
    if (accel.fallback) menu.appendChild(el("div", { class: "hint", text: accel.fallback }));
  }

  async function setAccelMode(mode) {
    try {
      const data = await api("/api/accel", jsonOpts("PUT", { mode: mode }));
      if (data && data.ok) {
        applyAccel(data);
        setStatus(t("封面解码候选：") + (data.hwaccel || "CPU"));
      } else {
        setStatus((data && data.error) || t("无法切换加速模式。"), true);
      }
    } catch (err) {
      setStatus(t("无法切换加速模式。"), true);
    }
  }

  async function loadAccel() {
    try {
      const data = await api("/api/accel");
      if (data && data.ok) applyAccel(data);
    } catch (err) { /* keep the button label */ }
  }

  /* ---- v0.2.0 navbar: official /imagine/saved chrome. ------------------- */

  function syncNav() {
    const grok = state.mode === "grok";
    document.body.classList.toggle("grok-mode", grok);
    $("modeGrok").classList.toggle("active", grok);
    $("modeGallery").classList.toggle("active", !grok);
    if ($("grokGuest")) $("grokGuest").hidden = !grok || !!state.grokDocked;
    const trashView = state.view === "trash";
    // Trash keeps 查看 (its exit lives there) and Select; filters and search
    // only make sense on the live walls.
    $("catPills").hidden = trashView;
    $("searchWrap").hidden = trashView;
    paintCatPills();
    // Keep the hidden 查看 menu populated (cheap, and the DOM is inspectable),
    // but never repaint it while open: its rows repaint themselves, and a
    // repaint mid-drag would yank the tile slider out from under the mouse.
    if ($("viewMenu").hidden) paintViewMenu();
    paintVolume();
  }

  function closeNavMenus(except) {
    stopHoverVideo();
    ["plusMenu", "viewMenu", "catMenu", "selTagMenu", "selUntagMenu"].forEach((id) => {
      if (id === except) return;
      const menu = $(id);
      if (menu && !menu.hidden) menu.hidden = true;
    });
    $("plusBtn").setAttribute("aria-expanded", $("plusMenu").hidden ? "false" : "true");
    $("viewBtn").setAttribute("aria-expanded", $("viewMenu").hidden ? "false" : "true");
  }

  function anyNavMenuOpen() {
    return ["plusMenu", "viewMenu", "catMenu", "selTagMenu", "selUntagMenu"].some((id) => {
      const menu = $(id);
      return menu && !menu.hidden;
    });
  }

  function setCats(next) {
    currentView().cats = next;
    saveViews();
    render();
  }

  function toggleCat(key) {
    const view = currentView();
    let next = (view.cats || []).filter((cat) => cat !== "all");
    const i = next.indexOf(key);
    if (i >= 0) {
      next.splice(i, 1);
    } else {
      next.push(key);
      if (key === "fav") next = next.filter((cat) => cat !== "dislike");
      if (key === "dislike") next = next.filter((cat) => cat !== "fav");
    }
    view.cats = next;
    saveViews();
    render();
  }

  /* Left cluster: 所有的 / Liked / custom tags / … — pill per filter, active
     pill lights up. The … pill re-hosts the old checkbox menu (全部 / 不喜欢 /
     未分组 / multi-tag combos) plus 新建标签. */
  function paintCatPills() {
    const box = $("catPills");
    const oldMenu = $("catMenu");
    const menuWasOpen = !!(oldMenu && !oldMenu.hidden);
    box.replaceChildren();
    if (!state.library || !state.library.ok || state.view === "trash") return;
    const prefs = currentView();
    const mode = catsMode(prefs.cats);
    const chosen = new Set(mode === "filter" ? prefs.cats : []);

    box.appendChild(el("button", {
      type: "button",
      class: "pill" + (mode === "default" ? " active" : ""),
      text: t("所有的"),
      title: t("默认视图（隐藏「不喜欢」）"),
      onclick: () => setCats([]),
    }));

    const likedOn = chosen.has("fav");
    const heartWrap = el("span", { class: "pill-heart" });
    heartWrap.appendChild(heartSvg(likedOn));
    box.appendChild(el("button", {
      type: "button",
      class: "pill liked" + (likedOn ? " active" : ""),
      title: t("只看收藏"),
      onclick: () => toggleCat("fav"),
    }, [heartWrap, "Liked"]));

    (state.meta.tags || []).forEach((tag) => {
      box.appendChild(el("button", {
        type: "button",
        class: "pill" + (chosen.has(tag) ? " active" : ""),
        text: tag,
        onclick: () => toggleCat(tag),
      }));
    });

    const wrap = el("div", { class: "cat-wrap" });
    wrap.appendChild(el("button", {
      type: "button",
      id: "catMoreBtn",
      class: "pill more" + (mode === "all" || chosen.has("dislike") || chosen.has("ungrouped") ? " active" : ""),
      text: "…",
      title: t("更多筛选"),
      "aria-haspopup": "true",
      onclick: (ev) => {
        ev.stopPropagation();
        const menu = $("catMenu");
        closeNavMenus("catMenu");
        menu.hidden = !menu.hidden;
        if (!menu.hidden) paintCatMenu();
      },
    }));
    wrap.appendChild(el("div", { id: "catMenu", class: "cat-menu", hidden: true }));
    box.appendChild(wrap);
    if (menuWasOpen) {
      $("catMenu").hidden = false;
      paintCatMenu();
    }
  }

  function menuRow(label, on, handler) {
    return el("button", {
      type: "button",
      class: "menu-row" + (on ? " on" : ""),
      // Row handlers repaint the menu; a bubbled click would then see a
      // detached target and the outside-click closer would shut the menu.
      onclick: (ev) => {
        ev.stopPropagation();
        handler();
      },
    }, [el("span", { text: label }), el("span", { class: "check", text: "✓" })]);
  }

  function switchView(next) {
    if (state.view === next) return;
    state.view = next;
    setSelectMode(false);
    hideComboPreview();
    render();
  }

  /* 查看 swallows the old tabs/density/filters/sort/tile-size toolbar:
     类别 (组合/扁平/其它) · 查看 (完整的/紧凑的) · 媒体 (全部/图片/视频) ·
     排序 · 磁贴大小 · 回收站. */
  function paintViewMenu() {
    const menu = $("viewMenu");
    menu.replaceChildren();
    const repaint = () => paintViewMenu();

    menu.appendChild(el("div", { class: "menu-head", text: t("类别") }));
    menu.appendChild(menuRow(t("组合"), state.view === "combos", () => {
      switchView("combos");
      repaint();
    }));
    menu.appendChild(menuRow(t("扁平"), state.view === "flat", () => {
      switchView("flat");
      repaint();
    }));
    if (state.library && state.library.hasOther) {
      menu.appendChild(menuRow(t("其它"), state.view === "other", () => {
        switchView("other");
        repaint();
      }));
    }

    const prefs = currentView();
    menu.appendChild(el("div", { class: "menu-sep" }));
    menu.appendChild(el("div", { class: "menu-head", text: t("查看") }));
    menu.appendChild(menuRow(t("完整的"), prefs.density === "expanded", () => {
      applyDensity("expanded");
      repaint();
    }));
    menu.appendChild(menuRow(t("紧凑的"), prefs.density === "compact", () => {
      applyDensity("compact");
      repaint();
    }));

    menu.appendChild(el("div", { class: "menu-sep" }));
    menu.appendChild(el("div", { class: "menu-head", text: t("媒体") }));
    [["all", t("全部")], ["image", t("图片")], ["video", t("视频")]].forEach(([key, label]) => {
      menu.appendChild(menuRow(label, state.filter === key, () => {
        state.filter = key;
        render();
        repaint();
      }));
    });

    menu.appendChild(el("div", { class: "menu-sep" }));
    menu.appendChild(el("div", { class: "menu-head", text: t("排序") }));
    SORT_MODES.forEach((key) => {
      menu.appendChild(menuRow(t(SORT_LABELS[key]), sortMode() === key, () => {
        currentView().sort = key;
        saveViews();
        render();
        repaint();
      }));
    });

    menu.appendChild(el("div", { class: "menu-sep" }));
    const slider = el("input", {
      type: "range",
      min: String(TILE_MIN),
      max: String(TILE_MAX),
      step: "1",
      value: String(minWidthFor(prefs)),
    });
    slider.addEventListener("input", (ev) => applyTileSize(ev.target.value));
    menu.appendChild(el("div", { class: "menu-slider" }, [t("磁贴"), slider]));

    menu.appendChild(el("div", { class: "menu-sep" }));
    menu.appendChild(menuRow(t("回收站"), state.view === "trash", () => {
      menu.hidden = true;
      switchView(state.view === "trash" ? "combos" : "trash");
    }));
  }

  /* The primary + action opens the picker; its popup is only recent roots. */
  function paintPlusMenu() {
    const menu = $("plusMenu");
    menu.replaceChildren();
    const rows = ((state.config && state.config.history) || []).slice(0, 12);
    menu.appendChild(el("div", { class: "menu-head", text: t("最近打开") }));
    if (rows.length) {
      rows.forEach((row) => {
        menu.appendChild(el("div", { class: "menu-history-row" }, [
          el("button", {
            type: "button",
            class: "menu-item",
            text: row.name || row.path,
            title: row.path,
            onclick: () => {
              closeNavMenus("");
              openLibraryPath(row.path);
            },
          }),
          historyForgetButton(row.path),
        ]));
      });
      menu.appendChild(el("button", {
        type: "button",
        class: "history-clear",
        text: t("清除图库历史"),
        onclick: () => void clearLibraryHistory(),
      }));
    } else {
      menu.appendChild(el("div", { class: "menu-head", text: t("暂无记录，点击 + 打开图库") }));
    }
  }

  function bindPlusMenu() {
    const button = $("plusBtn");
    const menu = $("plusMenu");
    const wrap = button.closest(".cat-wrap");
    let touchTimer = 0;
    let longPressed = false;
    function show() {
      closeNavMenus("plusMenu");
      if (menu.hidden) paintPlusMenu();
      menu.hidden = false;
      button.setAttribute("aria-expanded", "true");
    }
    function hide() {
      menu.hidden = true;
      button.setAttribute("aria-expanded", "false");
    }
    function cancelHold() { clearTimeout(touchTimer); touchTimer = 0; }
    wrap.addEventListener("pointerenter", ev => { if (ev.pointerType !== "touch") show(); });
    wrap.addEventListener("pointerleave", () => {
      cancelHold();
      if (!menu.contains(document.activeElement)) hide();
    });
    wrap.addEventListener("focusin", show);
    wrap.addEventListener("focusout", ev => { if (!wrap.contains(ev.relatedTarget)) hide(); });
    button.addEventListener("pointerdown", ev => {
      cancelHold();
      longPressed = false;
      if (ev.pointerType === "touch") touchTimer = setTimeout(() => { longPressed = true; show(); }, 500);
    });
    button.addEventListener("pointerup", cancelHold);
    button.addEventListener("pointercancel", () => { cancelHold(); longPressed = false; });
    button.addEventListener("click", ev => {
      ev.stopPropagation();
      cancelHold();
      if (longPressed) { longPressed = false; return; }
      closeNavMenus("");
      openLibraryFlow();
    });
    wrap.addEventListener("keydown", ev => {
      if (ev.key === "ArrowDown" && ev.target === button) {
        ev.preventDefault();
        show();
        const first = menu.querySelector("button");
        if (first) first.focus();
      } else if (ev.key === "Escape" && !menu.hidden) {
        ev.preventDefault();
        ev.stopPropagation();
        button.focus();
        hide();
      }
    });
  }

  async function openLibraryFlow() {
    return withLibraryChange(async () => {
      return openBrowser();
    });
  }

  async function afterLibraryCreated(data) {
    await loadSideState(data.root);
    applyLibrary(data.library, data.root);
    refreshConfig();
    setStatus(t("已新建空图库 {path} · 切到 Grok 登录后点「下载」拉取", {path: data.root || ""}));
  }

  /* 新建库文件夹: always the in-app directory list. The skeleton itself
     (combos/ + _other/ + empty _index.json) is python's job. */
  async function createLibraryFlow() {
    return withLibraryChange(async () => {
    await openBrowser();
    (browserCanUse() ? $("browserNewName") : $("browserPath")).focus();
    });
  }

  async function createLibraryHere() {
    return withLibraryChange(async () => {
    if (!browserCanUse()) return;
    const name = $("browserNewName").value.trim();
    const err = $("browserError");
    if (!name) {
      err.hidden = false;
      err.textContent = t("请输入新图库文件夹名。");
      return;
    }
    let data = null;
    try {
      data = await api("/api/library/create", jsonOpts("POST", { parent: state.browsePath, name: name }));
    } catch (e) {
      data = null;
    }
    if (!data || !data.ok) {
      err.hidden = false;
      err.textContent = translate((data && data.error) || t("无法创建图库。"));
      return;
    }
    $("browserNewName").value = "";
    closeBrowser();
    await afterLibraryCreated(data);
    });
  }

  /* ---- search: circle expands into the field. -------------------------- */

  function openSearch() {
    $("searchWrap").classList.add("open");
    const input = $("searchInput");
    input.tabIndex = 0;
    input.focus();
    $("searchClear").hidden = !input.value;
  }

  function closeSearch(clear) {
    const input = $("searchInput");
    if (clear && input.value) {
      input.value = "";
      if (state.query) {
        state.query = "";
        render();
      }
    }
    $("searchWrap").classList.remove("open");
    $("searchClear").hidden = true;
    input.tabIndex = -1;
    input.blur();
  }

  /* ---- volume: one knob for every local <video> + the grok guest. ------- */

  function paintVolume() {
    const vol = state.volume;
    const silent = vol.muted || vol.level === 0;
    const btn = $("volBtn");
    btn.replaceChildren(speakerSvg(silent));
    btn.classList.toggle("muted", silent);
    btn.title = vol.muted ? t("取消静音") : t("静音");
    if (playerUI) playerUI.updateVolume();
  }

  function applyVolumeToMedia() {
    const vol = state.volume;
    ["cpVideo", "lbVideo"].forEach((id) => {
      const video = $(id);
      if (!video) return;
      video.volume = vol.level / 100;
      video.muted = vol.muted;
    });
    // hover previews stay muted by design — only level 0 would matter anyway.
  }

  let volTimer = 0;
  function setVolume(patch, persist) {
    const vol = state.volume;
    if (patch && typeof patch.level === "number" && Number.isFinite(patch.level)) {
      vol.level = Math.max(0, Math.min(100, Math.round(patch.level)));
    }
    if (patch && typeof patch.muted === "boolean") vol.muted = patch.muted;
    paintVolume();
    applyVolumeToMedia();
    if (persist === false) return;
    clearTimeout(volTimer);
    volTimer = setTimeout(() => {
      api("/api/volume", jsonOpts("PUT", { level: vol.level, muted: vol.muted }))
        .then(data => { if (!data || !data.ok) throw new Error(t("音量保存失败。")); })
        .catch(() => setStatus(t("音量已调整，但无法保存设置。"), true));
    }, 350);
  }

  /* ---- Grok / 图库 mode toggle. ----------------------------------------- */

  function reportChromeHeight() {
    if (!(window.viewer && window.viewer.reportChrome)) return;
    const bar = $("topBar");
    if (bar) window.viewer.reportChrome(Math.ceil(bar.getBoundingClientRect().height));
  }

  function paintGrokGuest(info) {
    const title = $("grokGuestTitle");
    const text = $("grokGuestText");
    const btn = $("grokGuestOpen");
    if (!title || !text || !btn) return;
    const engine = info && info.engine;
    state.grokEngine = engine || "";
    state.grokDocked = !!(info && info.docked);
    if ($("grokGuest")) $("grokGuest").hidden = state.mode !== "grok" || state.grokDocked;
    if (state.grokDocked) return;
    title.textContent = t("Grok 页面未就绪");
    text.textContent = t("Grok 使用应用内独立的 WebView，不使用日常浏览器的登录资料。请重试打开页面。");
    btn.textContent = t("重新打开 Grok");
  }

  // Desktop integration requires the current Tauri bridge's declared identity.
  function isTauriDownloadShell() {
    return !!(window.viewer && window.viewer.shell === "tauri");
  }

  function shellCan(name) {
    const viewer = window.viewer;
    return isTauriDownloadShell()
      && Array.isArray(viewer.capabilities)
      && viewer.capabilities.indexOf(name) >= 0
      && typeof viewer[name] === "function";
  }

  function tauriGrokLocked() {
    return isTauriDownloadShell() && (dlBusy || dlStopping);
  }

  async function setMode(mode, force) {
    mode = mode === "grok" ? "grok" : "gallery";
    if (state.mode === mode && !force) return true;
    if (mode === "grok" && tauriGrokLocked()) {
      setStatus(t("下载期间不能切换 Grok 账号，请先停止下载。"), true);
      return false;
    }
    if (mode === "grok" && !shellCan("setMode")) {
      setStatus(t("Grok 模式需要在桌面应用里使用（浏览器无法内嵌 grok.com）。"), true);
      return false;
    }
    state.mode = mode;
    syncNav();
    reportChromeHeight();
    if (!(window.viewer && window.viewer.setMode)) return true;
    try {
      const res = await window.viewer.setMode(mode);
      if (mode === "grok") paintGrokGuest(res || {});
      if (res && res.ok === false) setStatus(res.error || t("无法打开 Grok 页面。"), true);
      return !(res && res.ok === false);
    } catch (err) {
      setStatus(String((err && err.message) || err || t("切换模式失败。")), true);
      return false;
    }
  }

  /* ---- 下载: Tauri probes the logged-in Grok user and authoritatively binds
     the selected indexed library before any media/state write. */
  let dlBusy = false;
  let dlStopping = false;
  let dlGeneration = 0;
  let dlPhase = "idle";
  let dlDoneTimer = 0;
  let dlListTimer = 0;
  const DL_STOP_TIMEOUT_MS = 20000;
  const DL_CIRC = 2 * Math.PI * 14;
  const DL_LIST_STEP = 10;
  const DL_LIST_TICK_MS = 40;
  // Run ids from the shell only ever increase, so a line from a stopped run can
  // be dropped without knowing which run is current.
  let dlRunSeen = 0;
  const dlProg = {
    page: 0,
    added: 0,
    current: 0,
    of: 0,
    listCurrent: 0,
    listTarget: 0,
    listOf: 0,
    pct: null,
    local: 0,
    note: "",
    succeeded: 0,
    failed: 0,
  };

  function resetDlProg() {
    stopDlListAnimation();
    dlProg.page = 0;
    dlProg.added = 0;
    dlProg.current = 0;
    dlProg.of = 0;
    dlProg.listCurrent = 0;
    dlProg.listTarget = 0;
    dlProg.listOf = 0;
    dlProg.pct = null;
    dlProg.local = 0;
    dlProg.note = "";
    dlProg.succeeded = 0;
    dlProg.failed = 0;
  }

  function stopDlListAnimation() {
    if (dlListTimer) clearTimeout(dlListTimer);
    dlListTimer = 0;
  }

  function advanceDlListCount() {
    dlListTimer = 0;
    const gap = Math.max(0, dlProg.listTarget - dlProg.listCurrent);
    if (!gap) return;
    dlProg.listCurrent += Math.min(DL_LIST_STEP, gap);
    paintDlProgress();
    if (dlBusy && !dlStopping) setStatus(formatDlStatus());
    if (dlProg.listCurrent < dlProg.listTarget) {
      dlListTimer = setTimeout(advanceDlListCount, DL_LIST_TICK_MS);
    }
  }

  function queueDlListCount(current, of) {
    const confirmed = Math.max(0, Number(current) || 0);
    dlProg.listTarget = Math.max(dlProg.listTarget, confirmed);
    dlProg.listOf = Math.max(0, Number(of) || 0);
    if (!dlListTimer && dlProg.listCurrent < dlProg.listTarget) advanceDlListCount();
  }

  function parseDownloadLine(raw) {
    let text = String(raw || "").replace(/^下载：/, "").trim();
    if (!text || text.charAt(0) === "{") return { kind: "ignore" };
    let run = 0;
    const tagged = text.match(/^run\s+(\d+)\s+([\s\S]*)$/i);
    if (tagged) {
      run = +tagged[1];
      text = tagged[2].trim();
    }
    let m = text.match(/page\s+(\d+)\s+added\s+(\d+)\s+total\s+(\d+)/i);
    if (m) return { kind: "page", run: run, page: +m[1], added: +m[2], total: +m[3] };
    m = text.match(/download\s+(\d+)\s*\/\s*(\d+)(?:\s+success\s+(\d+)\s+failed\s+(\d+))?/i);
    if (m) {
      return {
        kind: "file",
        run: run,
        current: +m[1],
        of: +m[2],
        succeeded: m[3] === undefined ? null : +m[3],
        failed: m[4] === undefined ? null : +m[4],
      };
    }
    m = text.match(/local\s+(\d+)\s+missing\s+(\d+)/i);
    if (m) return { kind: "plan", run: run, local: +m[1], missing: +m[2] };
    m = text.match(/list reuse\s+\w+\s+(\d+)/i);
    if (m) return { kind: "reuse", run: run, total: +m[1] };
    m = text.match(/list resume\s+\w+\s+page\s+(\d+)\s+have\s+(\d+)/i);
    if (m) return { kind: "page", run: run, page: +m[1], added: 0, total: +m[2] };
    m = text.match(/index\s+(combos|other)\s+(\d+)\s*\/\s*(\d+)/i);
    if (m) return { kind: "index", run: run, section: m[1], current: +m[2], of: +m[3] };
    if (/index skip unchanged/i.test(text)) return { kind: "note", run: run, text: "没有新增" };
    if (/scan local/i.test(text)) return { kind: "note", run: run, text: "核对本地" };
    if (/正在恢复上一次图库发布/.test(text)) {
      return { kind: "note", run: run, text: "恢复上次发布" };
    }
    m = text.match(/list wait\s+(\d+)s/i);
    if (m) return { kind: "note", run: run, text: "读取清单 · " + m[1] + "s · 首次同步较慢" };
    m = text.match(/^list\s+(\d+)\s*\/\s*(\d+)$/i);
    if (m) return { kind: "listcount", run: run, current: +m[1], of: +m[2] };
    m = text.match(/^list\s+(\d+)$/i);
    if (m) return { kind: "listcount", run: run, current: +m[1], of: 0 };
    m = text.match(/^http\s+(native|aria2)(?:\s+(\d+))?/i);
    if (m) {
      return {
        kind: "note",
        run: run,
        text: m[1] === "aria2" ? ("分片 " + (m[2] || "3")) : ("并发 " + (m[2] || "3")),
      };
    }
    m = text.match(/^probe\s+(assets\.grok\.com|imagine-public\.x\.ai)\s+(\d+)\b(.*)$/i);
    if (m) {
      const extra = String(m[3] || "").replace(/[^a-z0-9 ]/gi, " ").replace(/\s+/g, " ").trim();
      return { kind: "note", run: run, text: extra ? ("探测 " + m[2] + " " + extra) : ("探测 " + m[2]) };
    }
    if (/正在读取 Grok 图库列表/.test(text)) {
      return { kind: "note", run: run, text: "读取清单" };
    }
    if (/正在确认 Grok 登录|正在重新核对 Grok 登录|正在完成前核对 Grok 登录/.test(text)) {
      return { kind: "note", run: run, text: "核对账号" };
    }
    if (/正在核对图库账号绑定/.test(text)) {
      return { kind: "note", run: run, text: "核对绑定" };
    }
    if (/正在取得图库写入锁/.test(text)) {
      return { kind: "note", run: run, text: "取得写锁" };
    }
    if (/检查.*登录|还没登录|notLoggedIn/i.test(text)) {
      return { kind: "note", run: run, text: "检查登录" };
    }
    if (/页面还没准备好|正在加载 Grok/.test(text)) {
      return { kind: "note", run: run, text: "准备 Grok 页面" };
    }
    if (/登录正常|开始导出|ensureGuest|attach/i.test(text)) {
      return { kind: "note", run: run, text: "连接 Grok" };
    }
    if (/list probe failed|list cache/i.test(text)) {
      return { kind: "note", run: run, text: "读取清单缓存" };
    }
    return { kind: "ignore" };
  }

  function formatDlCounts() {
    if (!dlProg.failed) return "";
    return t("（成功 {success} · 失败 {failed}）", {success: dlProg.succeeded, failed: dlProg.failed});
  }

  function listSyncHint() {
    const summary = (state.library && state.library.summary) || {};
    return summary.assets || summary.fetchedAt ? t("逐页读取中") : t("首次同步逐页读取，请耐心等待");
  }

  function formatDlStatus() {
    if (dlProg.note && dlProg.note.indexOf("整理") === 0 && dlProg.of > 0) {
      return translate(dlProg.note) + " " + dlProg.current + " / " + dlProg.of;
    }
    if (dlProg.of > 0) return t("下载 {current} / {total}", {current: dlProg.current, total: dlProg.of}) + formatDlCounts();
    if (dlProg.listOf > 0) return t("清单 {current} / {total}", {current: dlProg.listCurrent, total: dlProg.listOf}) + " · " + listSyncHint();
    if (dlProg.listCurrent > 0) return t("清单 {count}", {count: dlProg.listCurrent}) + " · " + listSyncHint();
    if (dlProg.page > 0) return t("同步中 第 {page} 页 {count}", {page: dlProg.page, count: dlProg.added || 0}) + " · " + listSyncHint();
    if (dlProg.added > 0) return t("同步中 清单 {count}", {count: dlProg.added});
    if (dlProg.note) {
      return dlProg.note.indexOf("读取清单") === 0
        ? t("同步中 · ") + translate(dlProg.note) + (dlProg.note.indexOf("首次") >= 0 ? "" : " · " + listSyncHint())
        : t("同步中 · ") + translate(dlProg.note);
    }
    return t("同步中 · ") + listSyncHint();
  }

  function formatDlStopped() {
    if (dlProg.of > 0) return t("已停止 · {current} / {total}", {current: dlProg.current, total: dlProg.of});
    if (dlProg.page > 0) return t("已停止 · 第 {page} 页 {count}", {page: dlProg.page, count: dlProg.added || 0});
    if (dlProg.added > 0) return t("已停止 · 清单 {count}", {count: dlProg.added});
    return t("已停止下载。");
  }

  function formatDlTooltip() {
    if (dlPhase === "done") return t("下载完成");
    if (dlPhase === "finishing") return t("正在整理图库");
    if (dlStopping) return t("正在停止下载");
    if (!dlBusy) return t("下载");
    if (dlProg.of > 0) {
      const pct = Math.max(0, Math.min(100, Math.round((100 * dlProg.current) / dlProg.of)));
      return pct + "% " + dlProg.current + " / " + dlProg.of;
    }
    if (dlProg.listOf > 0) {
      return t("清单 {current} / {total}", {current: dlProg.listCurrent, total: dlProg.listOf});
    }
    if (dlProg.listCurrent > 0) return t("清单 {count}", {count: dlProg.listCurrent});
    return t("同步中");
  }

  function paintDlProgress() {
    updateDownloadHistory();
    const btn = $("dlBtn");
    const ring = $("dlRing");
    const arc = $("dlArc");
    if (!btn) return;
    const stopEl = $("dlStop");
    const doneEl = $("dlDone");
    if (dlPhase === "done") {
      btn.classList.remove("busy", "indeterminate");
      btn.disabled = dlBusy;
      btn.classList.add("done");
      if (ring) ring.hidden = true;
      if (stopEl) stopEl.hidden = true;
      if (doneEl) doneEl.hidden = false;
      btn.title = t("下载完成");
      btn.setAttribute("aria-label", t("下载完成"));
      return;
    }
    btn.classList.remove("done");
    if (doneEl) doneEl.hidden = true;
    if (!dlBusy) {
      btn.classList.remove("busy", "indeterminate");
      btn.disabled = false;
      if (ring) ring.hidden = true;
      if (stopEl) stopEl.hidden = true;
      btn.title = t("下载");
      btn.setAttribute("aria-label", t("下载"));
      return;
    }
    btn.classList.add("busy");
    btn.disabled = dlStopping || dlPhase === "finishing";
    if (ring) ring.hidden = false;
    if (stopEl) stopEl.hidden = dlStopping || dlPhase === "finishing";
    const ringCurrent = dlProg.of > 0 ? dlProg.current : dlProg.listCurrent;
    const ringOf = dlProg.of > 0 ? dlProg.of : dlProg.listOf;
    const determinate = ringOf > 0;
    btn.classList.toggle("indeterminate", !determinate);
    if (arc) {
      if (determinate) {
        const pct = Math.max(0, Math.min(100, Math.round((100 * ringCurrent) / ringOf)));
        dlProg.pct = pct;
        const visual = ringCurrent > 0 ? Math.max(pct, 8) : pct;
        arc.style.strokeDasharray = String(DL_CIRC);
        arc.style.strokeDashoffset = String(DL_CIRC * (1 - visual / 100));
      } else {
        dlProg.pct = null;
        arc.style.strokeDasharray = "";
        arc.style.strokeDashoffset = "";
      }
    }
    const tip = formatDlTooltip();
    btn.title = tip;
    btn.setAttribute("aria-label", tip);
  }

  function applyDownloadStatus(raw) {
    if (playerUI && playerUI.consumeDownloadStatus(raw)) return;
    const ev = parseDownloadLine(raw);
    if (ev.kind === "ignore") return;
    // Progress from an older run must not repaint the ring of the current one.
    if (ev.run) {
      if (ev.run < dlRunSeen) return;
      dlRunSeen = ev.run;
    }
    if (ev.kind === "page") {
      dlProg.page = ev.page;
      dlProg.added = ev.total;
    } else if (ev.kind === "reuse") {
      dlProg.added = ev.total;
      dlProg.note = "清单 " + ev.total;
    } else if (ev.kind === "plan") {
      stopDlListAnimation();
      dlProg.local = ev.local || 0;
      dlProg.of = ev.missing;
      dlProg.current = 0;
      dlProg.listCurrent = 0;
      dlProg.listTarget = 0;
      dlProg.listOf = 0;
      if (ev.missing === 0) dlProg.pct = 100;
    } else if (ev.kind === "listcount") {
      queueDlListCount(ev.current, ev.of);
      dlProg.note = "";
    } else if (ev.kind === "file") {
      dlProg.current = ev.current;
      dlProg.of = ev.of;
      dlProg.added = ev.of;
      dlProg.note = "";
      if (ev.succeeded !== null) dlProg.succeeded = ev.succeeded;
      if (ev.failed !== null) dlProg.failed = ev.failed;
    } else if (ev.kind === "index") {
      dlProg.current = ev.current;
      dlProg.of = ev.of;
      dlProg.note = ev.section === "other" ? "整理其它" : "整理组合";
    } else if (ev.kind === "note" && ev.text) {
      dlProg.note = ev.text;
    }
    paintDlProgress();
    if (dlBusy && !dlStopping) setStatus(formatDlStatus());
  }

  function clearDlDone() {
    if (dlDoneTimer) {
      clearTimeout(dlDoneTimer);
      dlDoneTimer = 0;
    }
    if (dlPhase === "done") dlPhase = "idle";
  }

  function playDlDone() {
    dlPhase = "done";
    paintDlProgress();
    const mark = document.querySelector("#dlDone .dl-check");
    if (mark) {
      mark.style.animation = "none";
      void mark.getBoundingClientRect();
      mark.style.animation = "";
    }
    return new Promise((resolve) => {
      if (dlDoneTimer) clearTimeout(dlDoneTimer);
      dlDoneTimer = setTimeout(() => {
        dlDoneTimer = 0;
        if (dlPhase === "done") {
          dlPhase = "idle";
          paintDlProgress();
        }
        resolve();
      }, 900);
    });
  }

  function currentDownload(generation, root) {
    return generation === dlGeneration && state.root === root;
  }

  async function stopDownload() {
    if (!dlBusy || dlStopping || dlPhase === "finishing" || dlPhase === "done") return;
    if (!(window.viewer && window.viewer.stopDownload)) {
      setStatus(t("当前桌面外壳不能停止下载。"), true);
      return;
    }
    const generation = dlGeneration;
    const downloadRoot = state.root;
    dlStopping = true;
    dlPhase = "busy";
    dlProg.note = "正在停止";
    paintDlProgress();
    setStatus(t("正在停止下载…"));
    let timer = 0;
    let result = null;
    try {
      result = await Promise.race([
        window.viewer.stopDownload(),
        new Promise((resolve) => {
          timer = setTimeout(() => resolve({ timeout: true }), DL_STOP_TIMEOUT_MS);
        }),
      ]);
    } catch (err) {
      result = { error: String(err && err.message ? err.message : err) };
    } finally {
      if (timer) clearTimeout(timer);
    }
    if (!currentDownload(generation, downloadRoot)) return;
    if (result && result.stopped === true) {
      // Keep the pending start result valid: it may have published before stop.
      dlPhase = "finishing";
      paintDlProgress();
      let refreshError = "";
      try { await loadLibrary(); }
      catch (err) { refreshError = String(err && err.message ? err.message : err); }
      if (!currentDownload(generation, downloadRoot)) return;
      stopDlListAnimation();
      dlStopping = false;
      dlBusy = false;
      dlPhase = "idle";
      dlProg.note = "";
      paintDlProgress();
      const warning = describeDownloadWarnings(result);
      setStatus(refreshError ? t("下载已停止，刷新图库失败：") + refreshError : formatDlStopped() + warning, !!refreshError || !!warning);
      return;
    }
    dlStopping = false;
    dlPhase = "busy";
    dlProg.note = "";
    paintDlProgress();
    if (result && result.timeout) {
      setStatus(t("停止请求超时，下载仍在进行。"), true);
    } else if (result && result.error) {
      setStatus(t("停止失败，下载仍在进行：") + result.error, true);
    } else {
      setStatus(t("外壳没有确认下载已停止，任务仍按进行中处理。"), true);
    }
  }

  function describeDownloadCounts(counts, error) {
    const parts = [];
    if (counts.succeeded) parts.push(t("成功 {count} 项", {count: counts.succeeded}));
    if (counts.failed) parts.push(t("失败 {count} 项", {count: counts.failed}));
    if (counts.skipped) parts.push(t("已有 {count} 项", {count: counts.skipped}));
    const head = parts.length ? t("部分完成：") + parts.join("，") : t("部分完成");
    // Older shells repeated the same totals in error. Keep meaningful reasons,
    // not a second rendering of the statistics.
    const detail = String(error || "").replace(/^成功\s*\d+\s*个[，,]\s*失败\s*\d+\s*个[。.]?\s*/, "");
    return detail ? head + "。" + detail : head + "。";
  }

  function describeDownloadWarnings(result) {
    if (!result || !Array.isArray(result.warnings) || !result.warnings.includes("history_persistence_pending")) return "";
    return " " + t(result.historyState === "unavailable"
      ? "下载结果尚未保存到历史，请保留诊断并刷新历史重试。"
      : "下载结果尚未写入历史，刷新历史时会补记；已发布的素材无需重新下载。");
  }

  function updateDownloadHistory() {
    if (!window.GivDownloadHistory) return;
    const root = state.root;
    const generation = rootGeneration;
    window.GivDownloadHistory.update({
      root,
      active: dlBusy || dlStopping,
      pending: libraryChangePending > 0,
      onRetry: async (historyId, assetIds) => {
        if (root !== state.root || generation !== rootGeneration || libraryChangePending > 0) {
          throw new Error(t("图库已切换，请重新选择下载记录。"));
        }
        if (dlBusy || dlStopping) throw new Error(t("请先停止下载，再重试失败项目。"));
        await startDownload(historyId ? { historyId, assetIds } : undefined);
      },
    });
  }

  async function startDownload(retry) {
    if (dlBusy || dlStopping) return;
    if (libraryChangePending > 0) {
      setStatus(t("图库正在切换或创建，请完成后再下载。"), true);
      return;
    }
    clearDlDone();
    if (!shellCan("startDownload")) {
      setStatus(t("下载需要在桌面应用里使用。"), true);
      return;
    }
    if (!state.root || !state.library || !state.library.ok) {
      setStatus(t("请先打开或新建一个图库。"), true);
      return;
    }
    const downloadRoot = state.root;
    const generation = ++dlGeneration;
    let createAfterFinish = false;
    let openGrokAfterFinish = false;
    dlBusy = true;
    dlPhase = "busy";
    resetDlProg();
    if (playerUI) playerUI.downloadStarted(downloadRoot);
    paintDlProgress();
    const summary = (state.library && state.library.summary) || {};
    setStatus(summary.assets || summary.fetchedAt
      ? t("同步中 · 正在读取 Grok 清单")
      : t("同步中 · 首次读取清单要逐页拉取，可能需要几分钟，请耐心等待"));
    try {
      if (state.mode === "grok") {
        const switched = await setMode("gallery");
        if (!currentDownload(generation, downloadRoot)) return;
        if (!switched) {
          setStatus(t("无法在下载前隐藏 Grok 页面，已取消下载。"), true);
          return;
        }
      }
      const args = { root: downloadRoot };
      if (retry) {
        args.retryOf = retry.historyId;
        args.retryAssetIds = retry.assetIds;
      }
      const res = await window.viewer.startDownload(args);
      if (!currentDownload(generation, downloadRoot)) return;
      if (playerUI) playerUI.downloadFinished(res);
      if (!res) {
        setStatus(t("下载失败：外壳没有返回结果。"), true);
        return;
      }
      if (res.notLoggedIn) {
        setStatus(t("还没登录 grok.com。"), true);
        openGrokAfterFinish = window.confirm(t("还没登录 grok.com。\n\n现在切到 Grok 模式登录？"));
        return;
      }
      if (res.mismatch) {
        setStatus(t("当前登录账号与这个图库不一致。"), true);
        createAfterFinish = window.confirm(
          t("当前登录账号与这个图库不一致，请新建图库。\n\n现在新建库文件夹？")
        );
        return;
      }
      if (res.stopped) {
        if (res.published) {
          await loadLibrary();
          if (!currentDownload(generation, downloadRoot)) return;
        }
        if (!dlStopping) setStatus(formatDlStopped() + describeDownloadWarnings(res), !!describeDownloadWarnings(res));
        return;
      }
      if (!res.ok) {
        // A partial run already committed media and rewrote the index. Refresh
        // so the successful files are visible, but never claim a clean finish.
        if (res.published) {
          const counts = res.counts || {};
          const summary = describeDownloadCounts(counts, res.error);
          dlPhase = "finishing";
          dlProg.note = "正在整理图库";
          paintDlProgress();
          await loadLibrary();
          if (!currentDownload(generation, downloadRoot)) return;
          setStatus(summary + describeDownloadWarnings(res), true);
          return;
        }
        setStatus(t("下载失败：") + (res.error || t("未知错误")) + describeDownloadWarnings(res), true);
        return;
      }
      dlPhase = "finishing";
      dlProg.note = "正在整理图库";
      paintDlProgress();
      if (state.mode === "grok") {
        await setMode("gallery");
        if (!currentDownload(generation, downloadRoot)) return;
      }
      setStatus(t("下载完成，正在刷新图库…"));
      await loadLibrary();
      if (!currentDownload(generation, downloadRoot)) return;
      const warning = describeDownloadWarnings(res);
      setStatus(t("下载完成。") + warning, !!warning);
      await playDlDone();
      if (!currentDownload(generation, downloadRoot)) return;
    } catch (err) {
      if (currentDownload(generation, downloadRoot) && !dlStopping) {
        setStatus(t("下载失败：") + String(err && err.message ? err.message : err), true);
      }
    } finally {
      if (generation === dlGeneration && !dlStopping) {
        stopDlListAnimation();
        dlBusy = false;
        if (dlPhase !== "done") dlPhase = "idle";
        paintDlProgress();
      }
      if (createAfterFinish && generation === dlGeneration) {
        setTimeout(() => {
          if (!downloadBlocksLibraryChange()) void createLibraryFlow();
        }, 0);
      }
      if (openGrokAfterFinish && generation === dlGeneration) {
        setTimeout(() => {
          if (!tauriGrokLocked()) void setMode("grok");
        }, 0);
      }
    }
  }

  const coverPreparePending = new Set();

  function prepareCover(section, folder, id) {
    const key = [section || "", folder || "", id || ""].join("\n");
    if (coverPreparePending.has(key)) return;
    coverPreparePending.add(key);
    api(
      "/api/cover/prepare",
      jsonOpts("POST", { section: section || "", folder: folder || "", id: id || "", imageThumbnail: true })
    ).catch(() => {}).finally(() => coverPreparePending.delete(key));
  }

  function comboCoverUrl(section, folder, coverId) {
    prepareCover(section, folder, coverId);
    let url = "/resource/cover?section=" + encodeURIComponent(section) + "&folder=" + encodeURIComponent(folder || "");
    if (coverId) url += "&id=" + encodeURIComponent(coverId);
    return url;
  }

  function hoverVideoNode() {
    if (!hoverVideoEl) {
      hoverVideoEl = document.createElement("video");
      hoverVideoEl.className = "tile-hover-video";
      hoverVideoEl.muted = true;
      hoverVideoEl.defaultMuted = true;
      hoverVideoEl.loop = true;
      hoverVideoEl.playsInline = true;
      hoverVideoEl.setAttribute("muted", "");
      hoverVideoEl.setAttribute("playsinline", "");
      hoverVideoEl.setAttribute("loop", "");
      hoverVideoEl.preload = "auto";
    }
    return hoverVideoEl;
  }

  function clearHoverVideoLoad(video) {
    const load = hoverVideoLoad;
    hoverVideoGeneration += 1;
    hoverVideoLoad = null;
    if (!load || load.video !== video) return;
    video.removeEventListener("loadedmetadata", load.onMeta);
  }

  function onHoverVideoMeta(load) {
    if (!load || load !== hoverVideoLoad || load.video !== hoverVideoEl) return;
    if (load.tile !== hoverTile || state.root !== load.root) return;
    if (!load.video.currentSrc
        || new URL(load.video.currentSrc, window.location.href).href !== load.src) return;
    const seconds = Number(load.video.duration);
    if (!Number.isFinite(seconds) || seconds <= 0) return;
    saveMeasuredDuration(load.item, seconds, load.root);
  }

  function hoverVideoAllowed(tile) {
    return !!tile && tile.isConnected && !document.hidden && state.mode === "gallery"
      && !state.select.on && !state.preview.open && !state.lightbox.open
      && !anyNavMenuOpen() && $("ctxMenu").hidden && $("browser").hidden
      && $("tagDialog").hidden && !document.querySelector("dialog[open]");
  }

  function stopHoverVideo() {
    if (hoverIntent) {
      clearTimeout(hoverIntent.timer);
      hoverIntent = null;
    }
    const video = hoverVideoEl;
    hoverTile = null;
    clearHoverVideoLoad(video);
    if (!video) return;
    video.pause();
    if (video.hasAttribute("src")) {
      video.removeAttribute("src");
      try { video.load(); } catch (err) { /* ignore */ }
    }
    if (video.parentNode) video.parentNode.removeChild(video);
  }

  function startHoverVideo(tile, url, item) {
    if (!url || !item || !hoverVideoAllowed(tile)) return;
    if (hoverTile === tile && hoverVideoEl && hoverVideoEl.parentNode === tile) return;
    stopHoverVideo();
    const video = hoverVideoNode();
    const target = new URL(url, window.location.href);
    target.searchParams.set("_givHover", String(hoverVideoGeneration));
    const load = {
      generation: hoverVideoGeneration,
      root: String(state.root || ""),
      src: target.href,
      video: video,
      tile: tile,
      item: {
        id: String(item.id || ""),
        section: String(item.section || ""),
        folder: String(item.folder || ""),
      },
      onMeta: null,
    };
    load.onMeta = () => onHoverVideoMeta(load);
    hoverTile = tile;
    hoverVideoLoad = load;
    video.addEventListener("loadedmetadata", load.onMeta);
    video.src = target.href;
    tile.appendChild(video);
    const play = video.play();
    if (play && play.catch) play.catch(function () {});
  }

  function bindHoverVideo(tile, url, item) {
    tile.addEventListener("mouseenter", function () {
      stopHoverVideo();
      if (!hoverVideoAllowed(tile)) return;
      const intent = { tile, root: state.root, generation: rootGeneration, timer: 0 };
      hoverIntent = intent;
      intent.timer = setTimeout(() => {
        if (hoverIntent !== intent) return;
        hoverIntent = null;
        if (intent.root !== state.root || intent.generation !== rootGeneration || !tile.matches(":hover")) return;
        startHoverVideo(tile, url, item);
      }, 150);
    });
    tile.addEventListener("mouseleave", function () {
      if (hoverTile === tile || (hoverIntent && hoverIntent.tile === tile)) stopHoverVideo();
    });
  }

  function destroyGrid() {
    stopHoverVideo();
    if (state.grid && state.grid.destroy) state.grid.destroy();
    state.grid = null;
  }

  function resetMain() {
    destroyGrid();
    const main = $("main");
    main.replaceChildren();
    return main;
  }

  function showMessage(text, cls) {
    const main = resetMain();
    main.appendChild(el("div", { class: cls || "empty", text: translate(text) }));
  }

  function pooledImg(src, alt) {
    let img = imgPool.get(src);
    if (!img) {
      if (imgPool.size >= IMG_POOL_MAX) {
        const oldest = imgPool.keys().next();
        if (!oldest.done) imgPool.delete(oldest.value);
      }
      img = document.createElement("img");
      img.alt = alt || "";
      img.decoding = "async";
      img.src = src;
      imgPool.set(src, img);
    } else if (alt) {
      img.alt = alt;
    }
    return img;
  }

  function noteRatio(key, width, height) {
    if (!key || !width || !height) return;
    const ratio = Math.min(2.4, Math.max(0.45, height / width));
    const prev = state.ratios.get(key);
    if (prev != null && Math.abs(prev - ratio) < 0.02) return;
    state.ratios.set(key, ratio);
    if (state.grid && state.grid.relayoutSoon) state.grid.relayoutSoon();
  }

  /* Wall: absolute placement + band virtualization, uniform or masonry. */
  function mountWall(list, renderTile, options) {
    const opts = options || {};
    const main = resetMain();
    const gap = opts.gap != null ? opts.gap : WALL_GAP;
    const keyOf = opts.keyOf || ((_item, i) => String(i));
    const ratioOf = opts.ratioOf || (() => 1);
    let minWidth = opts.minWidth || COMPACT_MIN;
    let masonry = !!opts.masonry;
    let items = (list || []).slice();
    const pool = new Map();
    const scroller = el("div", { class: "grid-scroll" });
    const surface = el("div", { class: "wall" });
    scroller.appendChild(surface);
    if (opts.header) main.appendChild(opts.header);
    main.appendChild(scroller);

    let positions = [];
    let bands = [];
    let keyIndices = new Map(items.map((item, i) => [keyOf(item, i), i]));
    let raf = 0;
    let relayoutTimer = 0;
    let layoutDirty = false;
    let destroyed = false;
    let measuredWidth = scroller.clientWidth;

    function layout() {
      measuredWidth = scroller.clientWidth;
      const inner = Math.max(measuredWidth, 160);
      const avail = Math.max(minWidth, inner - gap * 2);
      const cols = Math.max(1, Math.floor((avail + gap) / (minWidth + gap)));
      const cardW = (avail - gap * (cols - 1)) / cols;
      positions = new Array(items.length);
      bands = [];
      let total = gap;
      if (masonry) {
        const colY = new Array(cols).fill(gap);
        for (let i = 0; i < items.length; i++) {
          let c = 0;
          for (let k = 1; k < cols; k++) {
            if (colY[k] < colY[c] - 0.5) c = k;
          }
          const h = Math.max(72, Math.round(cardW * ratioOf(items[i], i)));
          positions[i] = { x: gap + c * (cardW + gap), y: colY[c], w: cardW, h: h };
          colY[c] += h + gap;
        }
        for (let k = 0; k < cols; k++) total = Math.max(total, colY[k]);
      } else {
        const h = Math.round(cardW * (opts.ratio || 1));
        for (let i = 0; i < items.length; i++) {
          const r = Math.floor(i / cols);
          positions[i] = { x: gap + (i % cols) * (cardW + gap), y: gap + r * (h + gap), w: cardW, h: h };
        }
        total = gap + Math.ceil(items.length / cols) * (h + gap);
      }
      for (let i = 0; i < items.length; i++) {
        const p = positions[i];
        const first = Math.floor(p.y / BAND);
        const last = Math.floor((p.y + p.h) / BAND);
        for (let b = first; b <= last; b++) {
          if (!bands[b]) bands[b] = [];
          bands[b].push(i);
        }
      }
      surface.style.height = Math.round(total) + "px";
    }

    function detach(tile) {
      if (hoverTile === tile || (hoverIntent && hoverIntent.tile === tile)) stopHoverVideo();
      if (tile.parentNode === surface) surface.removeChild(tile);
    }

    function paint() {
      if (destroyed) return;
      const top = scroller.scrollTop - OVERSCAN_PX;
      const bottom = scroller.scrollTop + scroller.clientHeight + OVERSCAN_PX;
      const firstBand = Math.max(0, Math.floor(top / BAND));
      const lastBand = Math.max(0, Math.floor(bottom / BAND));
      const seen = new Set();
      const visible = [];
      for (let b = firstBand; b <= lastBand; b++) {
        const bucket = bands[b];
        if (!bucket) continue;
        for (let n = 0; n < bucket.length; n++) {
          const i = bucket[n];
          const p = positions[i];
          if (!p || p.y > bottom || p.y + p.h < top) continue;
          const key = keyOf(items[i], i);
          if (seen.has(key)) continue;
          seen.add(key);
          visible.push(items[i]);
          let tile = pool.get(key);
          if (!tile) {
            tile = renderTile(items[i], i);
            tile.dataset.poolKey = key;
            pool.set(key, tile);
          }
          const transform = "translate(" + Math.round(p.x) + "px," + Math.round(p.y) + "px)";
          const width = Math.round(p.w) + "px";
          const height = Math.round(p.h) + "px";
          if (tile.style.transform !== transform) tile.style.transform = transform;
          if (tile.style.width !== width) tile.style.width = width;
          if (tile.style.height !== height) tile.style.height = height;
          if (tile.parentNode !== surface) {
            // A pooled off-screen tile may have missed selection changes.
            syncTileSelection(tile);
            surface.appendChild(tile);
          }
        }
      }
      for (const tile of Array.from(surface.children)) {
        if (!seen.has(tile.dataset.poolKey)) detach(tile);
      }
      if (pool.size > POOL_MAX) {
        for (const key of pool.keys()) {
          if (pool.size <= POOL_MAX / 2) break;
          if (!seen.has(key)) pool.delete(key);
        }
      }
      if (opts.onVisible) opts.onVisible(visible);
    }

    // Scroll, resize, decoded aspect ratios and slider input share one frame.
    // Only this callback owns raf; synchronous paints cannot lose its handle.
    function schedule() {
      if (raf || destroyed) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        if (destroyed) return;
        if (layoutDirty) relayout();
        else paint();
      });
    }

    function scheduleLayout() {
      if (destroyed) return;
      layoutDirty = true;
      schedule();
    }

    function anchorIndex() {
      const top = scroller.scrollTop;
      // Bands already index all overlapping cards, including tall masonry
      // cards that started above this band. Preserve the old lowest-index rule.
      for (let b = Math.max(0, Math.floor(top / BAND)); b < bands.length; b++) {
        let index = -1;
        for (const i of bands[b] || []) {
          const p = positions[i];
          if (p && p.y + p.h > top && (index < 0 || i < index)) index = i;
        }
        if (index >= 0) return { i: index, key: keyOf(items[index], index), delta: positions[index].y - top };
      }
      return null;
    }

    function anchorPosition(keep) {
      if (!keep) return null;
      const i = keyIndices.get(keep.key);
      return positions[i === undefined ? keep.i : i] || null;
    }

    function relayout(anchor) {
      if (destroyed) return;
      layoutDirty = false;
      const keep = anchor === undefined ? anchorIndex() : anchor;
      layout();
      const position = anchorPosition(keep);
      if (position) scroller.scrollTop = Math.max(0, position.y - keep.delta);
      const maxScroll = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
      if (scroller.scrollTop > maxScroll) scroller.scrollTop = maxScroll;
      paint();
    }

    function onScroll() {
      stopHoverVideo();
      schedule();
    }

    const ro = new ResizeObserver(() => {
      if (scroller.clientWidth !== measuredWidth) scheduleLayout();
      else schedule();
    });
    layout();
    paint();
    scroller.addEventListener("scroll", onScroll, { passive: true });
    ro.observe(scroller);

    state.grid = {
      sig: opts.sig || "",
      destroy() {
        destroyed = true;
        scroller.removeEventListener("scroll", onScroll);
        ro.disconnect();
        if (raf) cancelAnimationFrame(raf);
        if (relayoutTimer) clearTimeout(relayoutTimer);
        raf = relayoutTimer = 0;
        stopHoverVideo();
        pool.clear();
      },
      count() { return items.length; },
      updateLayout(nextMin, nextMasonry) {
        const width = nextMin || minWidth;
        const next = nextMasonry == null ? masonry : !!nextMasonry;
        if (width === minWidth && next === masonry) return;
        minWidth = width;
        masonry = next;
        scheduleLayout();
      },
      relayoutSoon() {
        if (relayoutTimer || destroyed) return;
        relayoutTimer = setTimeout(() => {
          relayoutTimer = 0;
          scheduleLayout();
        }, 140);
      },
      setItems(next, keepScroll) {
        // Capture against OLD items and OLD geometry before replacing either.
        const anchor = keepScroll ? anchorIndex() : null;
        items = (next || []).slice();
        keyIndices = new Map(items.map((item, i) => [keyOf(item, i), i]));
        for (const [key, tile] of pool) {
          if (!keyIndices.has(key)) { detach(tile); pool.delete(key); }
        }
        if (!keepScroll) scroller.scrollTop = 0;
        relayout(anchor);
      },
      refresh(keys) {
        (keys || Array.from(pool.keys())).forEach((key) => {
          const tile = pool.get(key);
          if (tile) detach(tile);
          pool.delete(key);
        });
        paint();
      },
      refreshSelection(keys) {
        // Selection is presentation-only: never invalidate media/cache nodes.
        if (keys) {
          for (const key of keys) {
            const tile = pool.get(key);
            if (tile) syncTileSelection(tile);
          }
        } else {
          for (const tile of surface.children) syncTileSelection(tile);
        }
      },
      repaint() { paint(); },
    };
  }

  function placeholder(isVideo) {
    const node = el("div", { class: "ph" });
    if (isVideo) node.appendChild(el("div", { class: "play-mark" }));
    else {
      node.dataset.i18n = "无封面";
      node.textContent = t("无封面");
    }
    return node;
  }

  function svgEl(tag, attrs) {
    const node = document.createElementNS("http://www.w3.org/2000/svg", tag);
    Object.keys(attrs || {}).forEach((key) => node.setAttribute(key, attrs[key]));
    return node;
  }

  /* A clearer ♥ than the old squiggle: the classic two-lobe heart, filled when on. */
  function heartSvg(filled) {
    const svg = svgEl("svg", { viewBox: "0 0 24 24", "aria-hidden": "true" });
    svg.appendChild(svgEl("path", {
      d: "M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z",
      fill: filled ? "currentColor" : "none",
      stroke: "currentColor",
      "stroke-width": "1.7",
      "stroke-linejoin": "round",
    }));
    return svg;
  }

  function searchSvg() {
    const svg = svgEl("svg", { viewBox: "0 0 24 24", "aria-hidden": "true" });
    svg.appendChild(svgEl("circle", {
      cx: "11", cy: "11", r: "7", fill: "none", stroke: "currentColor", "stroke-width": "2",
    }));
    svg.appendChild(svgEl("line", {
      x1: "16.7", y1: "16.7", x2: "21", y2: "21", stroke: "currentColor", "stroke-width": "2", "stroke-linecap": "round",
    }));
    return svg;
  }

  function lucideSvg(parts) {
    const svg = svgEl("svg", {
      viewBox: "0 0 24 24",
      fill: "none",
      stroke: "currentColor",
      "stroke-width": "2",
      "stroke-linecap": "round",
      "stroke-linejoin": "round",
      "aria-hidden": "true",
    });
    (parts || []).forEach((part) => {
      if (typeof part === "string") svg.appendChild(svgEl("path", { d: part }));
      else svg.appendChild(svgEl(part[0], part[1]));
    });
    return svg;
  }

  function repeatSvg(on) {
    const arrows = [
      "m17 2 4 4-4 4",
      "M3 11v-1a4 4 0 0 1 4-4h14",
      "m7 22-4-4 4-4",
      "M21 13v1a4 4 0 0 1-4 4H3",
    ];
    return lucideSvg(on ? arrows : arrows.concat("m2 2 20 20"));
  }

  function speakerSvg(muted) {
    const svg = svgEl("svg", { viewBox: "0 0 24 24", "aria-hidden": "true" });
    svg.appendChild(svgEl("path", {
      d: "M4 9v6h4l5 4V5L8 9H4z",
      fill: "currentColor",
    }));
    if (muted) {
      svg.appendChild(svgEl("line", {
        x1: "16", y1: "9", x2: "21", y2: "14", stroke: "currentColor", "stroke-width": "2", "stroke-linecap": "round",
      }));
      svg.appendChild(svgEl("line", {
        x1: "21", y1: "9", x2: "16", y2: "14", stroke: "currentColor", "stroke-width": "2", "stroke-linecap": "round",
      }));
    } else {
      svg.appendChild(svgEl("path", {
        d: "M15.5 8.4a4.6 4.6 0 010 7.2M17.8 6a8 8 0 010 12",
        fill: "none", stroke: "currentColor", "stroke-width": "1.8", "stroke-linecap": "round",
      }));
    }
    return svg;
  }

  function selKeyOf(target) {
    if (target.kind === "item") return "i:" + (target.item.id || target.item.file || "");
    if (target.kind === "trash") return "t:" + (target.item.id || "");
    return "g:" + groupKey(target.section, (target.entry && target.entry.folder) || "");
  }

  function isSelected(target) {
    return state.select.picked.has(selKeyOf(target));
  }

  function tileKeyOf(target) {
    if (target.kind === "item") return mediaTileKey(target.item);
    if (target.kind === "trash") return "trash:" + (target.item.id || target.item.file || "");
    return comboTileKey(target.section, (target.entry && target.entry.folder) || "");
  }

  function rerenderTiles() {
    // Content invalidation only. Selection must use syncSelectionTiles().
    if (!state.grid || !state.grid.refresh) return;
    const keys = [];
    document.querySelectorAll("#main .tile[data-pool-key]").forEach((tile) => {
      keys.push(tile.dataset.poolKey);
    });
    state.grid.refresh(keys);
  }

  function syncTileSelection(tile) {
    const check = tile.querySelector(".tile-check");
    const key = check && check.dataset.selectionKey;
    if (!key) return; // Read-only legacy trash has no selection control.
    const picked = state.select.picked.has(key);
    tile.classList.toggle("picked", picked);
    check.classList.toggle("on", picked);
    const label = picked ? t("取消选择") : t("选择");
    if (check.title !== label) check.title = label;
    const pressed = String(picked);
    if (check.getAttribute("aria-pressed") !== pressed) check.setAttribute("aria-pressed", pressed);
  }

  function syncSelectionTiles(keys) {
    if (state.grid && state.grid.refreshSelection) state.grid.refreshSelection(keys);
  }

  function setSelectMode(on) {
    state.select.on = !!on;
    if (!state.select.on) state.select.picked.clear();
    stopHoverVideo();
    document.body.classList.toggle("selecting", state.select.on);
    $("selectBtn").classList.toggle("active", state.select.on);
    syncSelBar();
    syncSelectionTiles();
  }

  function toggleSelect(target, force) {
    const key = selKeyOf(target);
    const want = force == null ? !state.select.picked.has(key) : !!force;
    if (want) state.select.picked.set(key, target);
    else state.select.picked.delete(key);
    if (want && !state.select.on) {
      setSelectMode(true);
      return;
    }
    syncSelectionTiles([tileKeyOf(target)]);
    syncSelBar();
  }

  function selectedTargets() {
    return Array.from(state.select.picked.values());
  }

  function syncSelBar() {
    const bar = $("selBar");
    if (!bar) return;
    const n = state.select.picked.size;
    bar.hidden = !state.select.on && !trashBusy;
    bar.classList.toggle("working", trashBusy);
    $("selCount").textContent = t("已选择 {count} 项", {count: n});
    const trashView = state.view === "trash";
    $("selTag").hidden = trashView;
    $("selUntag").hidden = trashView;
    $("selDelete").hidden = trashView;
    $("selRestore").hidden = !trashView;
    $("selPurge").hidden = !trashView;
    ["selTag", "selUntag", "selDelete", "selRestore", "selPurge"].forEach((id) => {
      $(id).disabled = trashBusy || n === 0;
    });
    if ($("selAll")) $("selAll").disabled = trashBusy;
    if ($("selDone")) $("selDone").disabled = trashBusy;
    if (!state.select.on && !trashBusy) {
      $("selTagMenu").hidden = true;
      $("selUntagMenu").hidden = true;
    }
  }

  function checkButton(target, picked) {
    const btn = el("button", {
      class: "tile-check" + (picked ? " on" : ""),
      type: "button",
      title: picked ? t("取消选择") : t("选择"),
      onclick: (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        toggleSelect(target);
      },
    });
    btn.dataset.selectionKey = selKeyOf(target);
    btn.setAttribute("aria-pressed", String(picked));
    btn.appendChild(el("span", { class: "tile-check-dot" }));
    return btn;
  }

  function heartButton(on, handler, known) {
    const btn = el("button", {
      class: "heart" + (on ? " on" : ""),
      type: "button",
      title: on ? t("取消收藏") : t("添加到收藏"),
      onclick: (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        handler();
      },
    });
    btn.disabled = state.metaKnown === false || known === false;
    btn.appendChild(heartSvg(on));
    return btn;
  }

  const coverSession = Date.now().toString(36) + Math.random().toString(36).slice(2);

  function coverUrlFor(section, folder, id, attempt, asMedia) {
    if (!asMedia) prepareCover(section, folder, id);
    let url = "/resource/cover?section=" + encodeURIComponent(section) + "&folder=" + encodeURIComponent(folder || "");
    if (id) url += "&id=" + encodeURIComponent(id);
    if (attempt) url += "&r=" + attempt;
    if (asMedia) url += "&as=media";
    else url += "&thumb=1&scope=" + coverSession + "-" + rootGeneration;
    return url;
  }

  /* Cover art: placeholder first, swap in the image, retry while ffmpeg works. */
  function mountCover(tile, spec) {
    const ph = placeholder(!!spec.isVideo);
    tile.appendChild(ph);
    let attempt = 0;

    function attach(img) {
      if (ph.parentNode) ph.remove();
      if (img.parentNode !== tile) tile.insertBefore(img, tile.firstChild);
      noteRatio(spec.ratioKey, img.naturalWidth, img.naturalHeight);
      // Only after a retry: the first try means the still (and its duration)
      // already existed when the tile was built.
      if (attempt > 0 && spec.onExtracted) spec.onExtracted();
    }

    function retry() {
      if (attempt >= COVER_RETRY_MAX) return;
      attempt += 1;
      setTimeout(() => {
        if (tile.isConnected) load(coverUrlFor(spec.section, spec.folder, spec.id, attempt));
      }, COVER_RETRY_MS * attempt);
    }

    function load(src) {
      const img = pooledImg(src, spec.alt || "");
      if (img.complete) {
        if (img.naturalWidth) attach(img);
        else retry();
        return;
      }
      img.addEventListener("load", () => attach(img), { once: true });
      img.addEventListener("error", retry, { once: true });
    }

    if (spec.url) load(spec.url);
  }

  function comboTileKey(section, folder) {
    return "combo:" + groupKey(section, folder || "");
  }

  function comboTile(entry, section) {
    const flags = groupFlags(section, entry.folder || "", entry);
    const folder = entry.folder || "";
    const target = { kind: "group", section: section, entry: entry };
    const picked = isSelected(target);
    const tile = el("div", {
      class: "tile" + (flags.fav ? " fav" : "") + (flags.dislike ? " disliked" : "") + (picked ? " picked" : ""),
      role: "button",
      tabindex: "0",
      dataset: { groupKey: groupKey(section, folder) },
      onclick: (ev) => {
        if (state.select.on) {
          ev.preventDefault();
          toggleSelect(target);
          return;
        }
        openCombo(section, entry);
      },
      onkeydown: (ev) => {
        if (ev.key !== "Enter") return;
        if (state.select.on) toggleSelect(target);
        else openCombo(section, entry);
      },
      oncontextmenu: (ev) => openCtx(ev, target),
    });
    // A card whose only media is a clip is a video card even before /api/cards
    // has said which item the cover is; a mixed card waits for coverMedia so a
    // still cover never gets a made-up length.
    const knownVideo = entry.coverMedia === "video";
    const onlyVideo = (entry.videos || 0) > 0 && !(entry.images > 0) && entry.coverMedia !== "image";
    const videoCover = knownVideo || onlyVideo;
    if (videoCover && entry.coverId) tile.dataset.coverId = entry.coverId;
    // A still cover comes straight from /media once /api/cards tells us the file.
    // Before that we hold the placeholder rather than make the server re-derive the
    // cover per tile, which on a network share doubles the work of the first paint.
    let coverSrc = "";
    if (videoCover) coverSrc = coverUrlFor(section, folder, entry.coverId || "");
    else if (entry.coverUrl) coverSrc = coverUrlFor(section, folder, entry.coverId || "");
    else if (entry.live) coverSrc = coverUrlFor(section, folder, entry.coverId || "");
    mountCover(tile, {
      url: coverSrc,
      section: section,
      folder: folder,
      id: entry.coverId || "",
      alt: titleOf(entry),
      isVideo: videoCover,
      ratioKey: comboTileKey(section, folder),
      onExtracted: videoCover && entry.coverId
        ? () => wantDuration(tile, section, folder, entry.coverId, entry.coverUrl || coverUrlFor(section, folder, entry.coverId || "", 0, true))
        : null,
    });
    if (videoCover) {
      bindHoverVideo(
        tile,
        entry.coverUrl || coverUrlFor(section, folder, entry.coverId || "", 0, true),
        { id: entry.coverId || "", section: section, folder: folder }
      );
    }
    const count = typeof entry.count === "number" ? entry.count : 0;
    const videos = typeof entry.videos === "number" ? entry.videos : 0;
    const meta = (entry.countKnown === false ? t("部分素材暂不可用") : t("{count} 张", {count: count}) + (videos ? " · " + t("{count} 视频", {count: videos}) : "")) + (entry.created ? " · " + fmtDate(entry.created) : "");
    tile.appendChild(
      el("div", { class: "tile-fade" }, [
        el("div", { class: "tile-title", text: titleOf(entry) }),
        el("div", { class: "tile-meta", text: meta }),
      ])
    );
    if (videoCover) {
      const seconds = knownDuration(entry.coverId, entry.duration);
      if (seconds) setDurationBadge(tile, seconds);
      else if (entry.coverId) wantDuration(tile, section, folder, entry.coverId, entry.coverUrl || coverUrlFor(section, folder, entry.coverId || "", 0, true));
    }
    tile.appendChild(checkButton(target, picked));
    if (flags.tags.length) {
      tile.title = t("组合标签：{tags}", {tags: flags.tags.join(" · ")});
      const tags = el("div", { class: "group-tags", text: flags.tags.slice(0, 3).join(" · "), title: flags.tags.join("、") });
      tile.appendChild(tags);
    }
    const heart = heartButton(flags.fav, () => toggleGroupFav(section, entry), entry.metadataKnown);
    heart.title = flags.ownFav ? t("取消组合自身收藏") : flags.inheritedFav ? t("组合内有喜欢项；点击可单独收藏组合") : t("收藏组合");
    tile.appendChild(heart);
    return tile;
  }

  function mediaTileKey(item) {
    return "item:" + (item.id || item.url || item.file || "");
  }

  function mediaTile(item) {
    const flags = itemFlags(item);
    const target = { kind: "item", item: item };
    const picked = isSelected(target);
    const tile = el("div", {
      class: "tile" + (flags.fav ? " fav" : "") + (flags.dislike ? " disliked" : "") + (picked ? " picked" : ""),
      role: "button",
      tabindex: "0",
      dataset: { assetId: item.id || "" },
      onclick: (ev) => {
        if (state.select.on) {
          ev.preventDefault();
          toggleSelect(target);
          return;
        }
        openItemInCombo(item);
      },
      onkeydown: (ev) => {
        if (ev.key !== "Enter") return;
        if (state.select.on) toggleSelect(target);
        else openItemInCombo(item);
      },
      oncontextmenu: (ev) => openCtx(ev, target),
    });
    const isVideo = item.media === "video";
    if (isVideo && item.id) tile.dataset.coverId = item.id;
    mountCover(tile, {
      url: coverUrlFor(item.section, item.folder || "", item.id || ""),
      section: item.section,
      folder: item.folder || "",
      id: item.id || "",
      alt: item.prompt || item.file || "",
      isVideo: isVideo,
      ratioKey: mediaTileKey(item),
      onExtracted: isVideo && item.id
        ? () => wantDuration(tile, item.section, item.folder || "", item.id, item.url)
        : null,
    });
    if (isVideo && item.url) bindHoverVideo(tile, item.url, item);
    const bits = [];
    if (item.kind) bits.push(item.kind);
    if (item.created) bits.push(fmtDate(item.created));
    tile.appendChild(
      el("div", { class: "tile-fade" }, [
        el("div", { class: "tile-title", text: item.title || item.prompt || item.file || "" }),
        el("div", { class: "tile-meta", text: bits.join(" · ") }),
      ])
    );
    if (isVideo) {
      const seconds = knownDuration(item.id, item.duration);
      if (seconds) setDurationBadge(tile, seconds);
      else if (item.id) wantDuration(tile, item.section, item.folder || "", item.id, item.url);
    }
    tile.appendChild(checkButton(target, picked));
    tile.appendChild(heartButton(flags.fav, () => toggleItemFav(item), item.metadataKnown));
    return tile;
  }

  function isVideoName(name) {
    const ext = String(name || "").split(".").pop().toLowerCase();
    return ext === "mp4" || ext === "webm" || ext === "mov" || ext === "m4v";
  }

  function trashPreviewItem(item) {
    const isVid = isVideoName(item.file);
    return {
      media: isVid ? "video" : "image",
      url: item.cover,
      kind: "",
      created: item.deletedAt,
      prompt: item.file || item.id || "",
      file: item.file,
    };
  }

  function legacyTrashReason(reason) {
    const messages = {
      legacy_identity_mismatch: "记录与素材身份不一致，无法确认归属。",
      legacy_path_unverified: "记录路径无法核验。",
      legacy_card_unverified: "组合记录无法核验，无法确认素材归属。",
      legacy_card_identity_mismatch: "组合记录无法核验，无法确认素材归属。",
      legacy_marker_unverified: "原位置删除标记无法核验。",
      legacy_marker_mismatch: "原位置删除标记无法核验。",
      legacy_target_conflict: "原位置已有文件，不能覆盖。",
      legacy_target_unavailable: "原位置暂时无法访问。",
      legacy_body_unavailable: "回收站正文缺失或无法安全读取。",
      legacy_fingerprint_mismatch: "正文与已有指纹不一致。",
      legacy_body_changed: "核验期间正文发生变化，请重试。",
      legacy_evidence_changed: "核验期间记录发生变化，请重试。",
      legacy_recovery_required: "历史记录需要在兼容旧版中核验恢复。",
    };
    return t(messages[reason] || "历史记录尚未完成核验。");
  }

  async function previewLegacyTrash(item) {
    const expectedRoot = state.root;
    const expectedGeneration = rootGeneration;
    const data = await api("/api/trash/legacy/preview?id=" + encodeURIComponent(item.id) + "&expectedRoot=" + encodeURIComponent(expectedRoot));
    if (state.root !== expectedRoot || rootGeneration !== expectedGeneration) return;
    if (!data || !data.ok || data.root !== expectedRoot) {
      setStatus((data && data.error) || t("历史回收站记录无法读取，原文件已保留。"), true);
      return;
    }
    const lines = [t("历史回收站记录（只读）"), t("文件：{file}", { file: data.file || data.id }), data.verified ? t("路径、标记及组合记录已核验。") : legacyTrashReason(data.reason)];
    if (Number.isSafeInteger(data.size)) lines.push(t("大小：{bytes} 字节", { bytes: data.size }));
    if (data.hash) lines.push("SHA-256: " + data.hash);
    lines.push(translate(data.recoveryHint || ""));
    window.alert(lines.join("\n\n"));
  }

  function legacyTrashTile(item) {
    return el("div", { class: "tile" }, [
      placeholder(false),
      el("div", { class: "tile-fade" }, [
        el("div", { class: "tile-title", text: item.file || item.id }),
        el("div", { class: "tile-meta", text: t("历史记录 · 需核验") }),
      ]),
      el("div", { class: "tile-actions" }, [el("button", {
        type: "button", text: t("核验与恢复说明"), onclick: (event) => {
          event.stopPropagation();
          previewLegacyTrash(item).catch(() => setStatus(t("历史回收站记录无法读取，原文件已保留。"), true));
        },
      })]),
    ]);
  }

  function trashTile(item) {
    if (item.legacy) return legacyTrashTile(item);
    const target = { kind: "trash", item: item };
    const picked = isSelected(target);
    const tile = el("div", { class: "tile" + (picked ? " picked" : "") });
    if (item.exists && item.cover) {
      const isVid = isVideoName(item.file);
      // A trashed clip has no still to show: an <img> pointing at the mp4 would
      // just render as a broken image, so keep the play placeholder instead.
      if (isVid) tile.appendChild(placeholder(true));
      else tile.appendChild(pooledImg(item.cover, item.file || item.id || ""));
      tile.setAttribute("role", "button");
      tile.tabIndex = 0;
      tile.addEventListener("click", (ev) => {
        if (state.select.on) {
          ev.preventDefault();
          toggleSelect(target);
          return;
        }
        openLightbox([trashPreviewItem(item)], 0);
      });
      tile.addEventListener("keydown", (ev) => {
        if (ev.key !== "Enter") return;
        if (state.select.on) toggleSelect(target);
        else openLightbox([trashPreviewItem(item)], 0);
      });
    } else {
      tile.appendChild(placeholder(false));
      tile.addEventListener("click", (ev) => {
        if (!state.select.on) return;
        ev.preventDefault();
        toggleSelect(target);
      });
    }
    tile.appendChild(checkButton(target, picked));
    tile.appendChild(
      el("div", { class: "tile-fade" }, [
        el("div", { class: "tile-title", text: item.file || item.id || t("已删") }),
        el("div", { class: "tile-meta", text: (item.folder || item.section || "") + (item.deletedAt ? " · " + fmtDate(item.deletedAt) : "") }),
      ])
    );
    tile.appendChild(
      el("div", { class: "tile-actions" }, [
        el("button", {
          type: "button",
          text: t("恢复"),
          onclick: (ev) => {
            ev.stopPropagation();
            restoreIds([item.id]);
          },
        }),
        el("button", {
          type: "button",
          text: t("彻底删除"),
          onclick: (ev) => {
            ev.stopPropagation();
            purgeIds([item.id]);
          },
        }),
      ])
    );
    return tile;
  }

  async function filteredCombos(section) {
    const lib = state.library;
    if (!lib || !lib.ok) return [];
    const entries = section === "_other" ? lib.other || [] : lib.combos || [];
    const q = state.query.trim();
    let promptMap = {};
    if (q) {
      const items = await ensureFlat();
      const mode = state.library.mode;
      let want = section;
      if (mode === "single") want = "_root";
      if (mode === "loose") want = "loose";
      promptMap = promptsByFolder(items, want);
      if (mode === "single") {
        const merged = [];
        Object.keys(promptMap).forEach((key) => {
          merged.push.apply(merged, promptMap[key]);
        });
        entries.forEach((entry) => {
          promptMap[entry.folder || ""] = merged;
        });
      }
    }
    const tileSection = state.library.mode === "single" ? "_root" : state.library.mode === "loose" ? "loose" : section;
    return sortWall(entries.filter((entry) => {
      if (!comboFilterPass(entry, tileSection)) return false;
      if (!q) return true;
      const prompts = promptMap[entry.folder || ""] || [];
      return matchesQuery([entry.title, entry.folder, entry.id].concat(prompts));
    }), "group", tileSection);
  }

  function cardKey(section, folder) {
    return (section || "") + "/" + (folder || "");
  }

  function libListFor(section) {
    if (!state.library) return [];
    return section === "_other" ? state.library.other || [] : state.library.combos || [];
  }

  function wantCards(section, entries) {
    if (!entries || !entries.length) return;
    let added = false;
    entries.forEach((entry) => {
      const key = cardKey(section, entry.folder || "");
      if (state.cards.has(key) || cardsInflight.has(key)) return;
      cardsWanted.add(key);
      added = true;
    });
    if (added && !cardsTimer) cardsTimer = setTimeout(flushCards, 60);
  }

  async function flushCards() {
    cardsTimer = 0;
    if (!state.library || !state.library.ok || !cardsWanted.size) return;
    const forRoot = state.root;
    const forGeneration = rootGeneration;
    const bySection = new Map();
    let taken = 0;
    for (const key of Array.from(cardsWanted)) {
      if (taken >= CARDS_BATCH) break;
      cardsWanted.delete(key);
      cardsInflight.add(key);
      taken += 1;
      const cut = key.indexOf("/");
      const section = key.slice(0, cut);
      const folder = key.slice(cut + 1);
      if (!bySection.has(section)) bySection.set(section, []);
      bySection.get(section).push(folder);
    }
    for (const [section, folders] of bySection) {
      try {
        const data = await api("/api/cards", jsonOpts("POST", { section: section, folders: folders }));
        // Same-root reopens bump the generation too, and the response names the
        // root it was built from: comparing the local string alone would accept
        // numbers computed for a library the user already left.
        const sameLibrary =
          forGeneration === rootGeneration &&
          state.root === forRoot &&
          (!data || !data.root || data.root === forRoot);
        if (data && data.ok && sameLibrary) applyCardRows(section, data.cards || []);
      } catch (err) {
        /* leave the tile on its cheap numbers */
      }
      folders.forEach((folder) => cardsInflight.delete(cardKey(section, folder)));
    }
    if (cardsWanted.size && !cardsTimer) cardsTimer = setTimeout(flushCards, 30);
  }

  function sameTagList(left, right) {
    const a = Array.isArray(left) ? left : [];
    const b = Array.isArray(right) ? right : [];
    return a.length === b.length && a.every((tag, index) => tag === b[index]);
  }

  function trashReadWarning(data) {
    if (data && data.metaKnown === false) return t("收藏和标签暂不可用，当前显示可读取的媒体。请修复后刷新。");
    const issues = data && Array.isArray(data.groupIssues) ? data.groupIssues : [];
    if (data && (data.metadataKnown === false || data.cardError || issues.some((issue) => issue.state === "corrupt" || issue.cardError))) return t("部分组合记录无法核验，当前显示可读取的媒体。请修复后刷新。");
    if (issues.some((issue) => issue.state === "unavailable")) return t("部分素材暂不可用，当前列表可能不完整。请刷新重试。");
    return data && Array.isArray(data.warnings) && data.warnings.includes("trash_records_corrupt")
      ? t("部分回收站记录损坏，相关素材暂不可用；原文件已保留。")
      : "";
  }

  function clearFlatReadWarning() {
    const box = $("status");
    // A download or another action may have published a newer status while a
    // retry was pending. Clear only this read failure's own message.
    if (box && [t("部分素材暂不可用，当前列表可能不完整。请刷新重试。"), t("收藏和标签暂不可用，当前显示可读取的媒体。请修复后刷新。"), t("部分组合记录无法核验，当前显示可读取的媒体。请修复后刷新。")].includes(box.textContent)) setStatus("");
  }

  function applyCardRows(section, rows) {
    const list = libListFor(section);
    const byFolder = new Map();
    list.forEach((entry) => byFolder.set(entry.folder || "", entry));
    const dropped = [];
    const touched = [];
    // A corrected count, heart or date changes where the tile belongs. Repainting
    // it in place would leave the wall sorted by the numbers we already replaced.
    let orderChanged = false;
    rows.forEach((row) => {
      const folder = row.folder || "";
      const entry = byFolder.get(folder);
      if (row.metaKnown === false) state.metaKnown = false;
      if (row.warnings) {
        const warning = trashReadWarning(row);
        if (warning) setStatus(warning, true);
      }
      if (row.countKnown === false) {
        // Unreadable deletion evidence does not establish an empty group.
        // Retain last known numbers, but never keep a thumbnail whose ID is
        // absent from the backend's verified visible members.
        if (entry) {
          const visibleIds = Array.isArray(row.memberIds) ? row.memberIds : [];
          if (!entry.coverId || !visibleIds.includes(entry.coverId)) {
            const safeCover = row.coverId && visibleIds.includes(row.coverId);
            entry.coverId = safeCover ? row.coverId : "";
            entry.coverMedia = safeCover ? row.coverMedia || "" : "";
            entry.coverFile = safeCover ? row.coverFile || "" : "";
            entry.coverUrl = safeCover ? row.coverUrl || "" : "";
            entry.coverReady = !!(safeCover && row.coverReady);
            entry.duration = safeCover ? row.duration || 0 : 0;
          }
          entry.memberIds = visibleIds;
          if (!visibleIds.includes(entry.lastViewedId)) {
            entry.lastViewedId = visibleIds.includes(row.lastViewedId) ? row.lastViewedId : "";
          }
          entry.countKnown = false;
          entry.metaKnown = row.metaKnown !== false;
          entry.metadataKnown = row.metadataKnown !== false;
          entry.state = "unavailable";
          entry.unavailable = true;
          entry.warnings = row.warnings || [];
          entry.unavailableIds = row.unavailableIds || [];
          state.cards.set(cardKey(section, folder), { ...entry });
          touched.push(comboTileKey(section, folder));
        }
        return;
      }
      state.cards.set(cardKey(section, folder), row);
      if (!entry) return;
      if (row.gone || row.count === 0) {
        dropped.push(folder);
        return;
      }
      const created = row.created || entry.created || "";
      if (
        entry.count !== row.count ||
        entry.images !== row.images ||
        entry.videos !== row.videos ||
        !!entry.fav !== !!row.fav ||
        !!entry.dislike !== !!row.dislike ||
        (entry.created || "") !== created ||
        !sameTagList(entry.tags, row.tags)
      ) {
        orderChanged = true;
      }
      entry.count = row.count;
      entry.images = row.images;
      entry.videos = row.videos;
      if (entry.latestItemCreatedAt !== row.latestItemCreatedAt) orderChanged = true;
      entry.latestItemCreatedAt = row.latestItemCreatedAt || "";
      entry.memberIds = row.memberIds || entry.memberIds || [];
      const flagsKnown = row.metaKnown !== false && row.metadataKnown !== false;
      if (flagsKnown) {
        entry.ownFav = !!row.ownFav;
        entry.ownTags = row.ownTags || [];
        entry.inheritedFav = !!row.inheritedFav;
        entry.inheritedTags = row.inheritedTags || [];
      }
      entry.created = created;
      entry.coverId = row.coverId || "";
      entry.coverMedia = row.coverMedia || "";
      entry.coverUrl = row.coverUrl || "";
      entry.coverReady = !!row.coverReady;
      entry.duration = row.duration || 0;
      if (flagsKnown) {
        entry.lastViewedId = row.lastViewedId || "";
        entry.fav = !!row.fav;
        entry.dislike = !!row.dislike;
        entry.tags = row.tags || [];
      }
      entry.metaKnown = row.metaKnown !== false;
      entry.metadataKnown = row.metadataKnown !== false;
      entry.live = true;
      entry.countKnown = true;
      entry.state = row.state || "available";
      entry.unavailable = !!row.unavailable;
      entry.warnings = row.warnings || [];
      entry.unavailableIds = row.unavailableIds || [];
      if (!flagsKnown) state.cards.set(cardKey(section, folder), { ...row, ...entry });
      touched.push(comboTileKey(section, folder));
    });
    if (dropped.length) dropGroupsFromWall(section, dropped);
    if (touched.length && state.grid && state.grid.refresh) state.grid.refresh(touched);
    if (orderChanged) resortWallSoon();
  }

  // Batched so a scroll that resolves forty cards re-sorts once, not forty times.
  let resortTimer = 0;

  function resortWallSoon() {
    if (resortTimer) return;
    resortTimer = setTimeout(() => {
      resortTimer = 0;
      if (!state.library || !state.library.ok) return;
      if (state.view === "trash") return;
      void render({ keepScroll: true });
    }, 140);
  }

  /* A. emptied combos leave the wall right away, no full reload. */
  function dropGroupsFromWall(section, folders) {
    const gone = new Set(folders);
    ["combos", "other"].forEach((key) => {
      const list = state.library && state.library[key];
      if (!Array.isArray(list)) return;
      state.library[key] = list.filter((entry) => !((entry.section || section) === section && gone.has(entry.folder || "")));
    });
    if (!state.wallItems || state.wallSection !== section) return;
    state.wallItems = state.wallItems.filter((entry) => !gone.has(entry.folder || ""));
    folders.forEach((folder) => {
      state.select.picked.delete("g:" + groupKey(section, folder));
    });
    syncSelBar();
    if (state.grid && state.grid.setItems) {
      state.grid.setItems(state.wallItems, true);
      if (!state.wallItems.length) showMessage(t("没有匹配的组合。"));
    }
  }

  function dropItemsFromWall(ids) {
    const gone = new Set(ids.filter(Boolean));
    if (!gone.size) return;
    if (Array.isArray(state.flat)) state.flat = state.flat.filter((item) => !gone.has(item.id));
    gone.forEach((id) => state.select.picked.delete("i:" + id));
    syncSelBar();
    if (state.view !== "flat" || !state.wallItems) return;
    state.wallItems = state.wallItems.filter((item) => !gone.has(item.id));
    if (state.grid && state.grid.setItems) {
      state.grid.setItems(state.wallItems, true);
      if (!state.wallItems.length) showMessage(t("没有匹配的媒体。"));
    }
  }

  function wallSignature(kind, section) {
    const view = currentView();
    return [kind, section, view.density, minWidthFor(view)].join("|");
  }

  async function renderWall(section, gen, keepScroll) {
    if (!state.library || !state.library.ok) {
      showMessage((state.library && state.library.error) || t("请选择图库根目录。"));
      return;
    }
    const items = await filteredCombos(section);
    if (gen != null && gen !== renderGen) return;
    const tileSection = state.library.mode === "single" ? "_root" : state.library.mode === "loose" ? "loose" : section;
    state.wallItems = items;
    state.wallSection = tileSection;
    if (!items.length) {
      showMessage(t("没有匹配的组合。"));
      return;
    }
    const view = currentView();
    const sig = wallSignature("combos", tileSection);
    if (keepScroll && state.grid && state.grid.sig === sig && state.grid.setItems) {
      state.grid.setItems(items, true);
      return;
    }
    mountWall(items, (entry) => comboTile(entry, tileSection), {
      sig: sig,
      minWidth: minWidthFor(view),
      masonry: isMasonry(view),
      ratio: 1,
      keyOf: (entry) => comboTileKey(tileSection, entry.folder || ""),
      ratioOf: (entry) => state.ratios.get(comboTileKey(tileSection, entry.folder || "")) || 1,
      onVisible: (visible) => wantCards(tileSection, visible),
    });
  }

  async function renderFlat(gen, keepScroll) {
    if (!state.library || !state.library.ok) {
      showMessage((state.library && state.library.error) || t("请选择图库根目录。"));
      return;
    }
    const all = state.flat && !state.flatIncomplete ? state.flat : await withLoading(t("正在载入扁平列表…"), ensureFlat);
    if (gen != null && gen !== renderGen) return;
    const items = sortWall(
      all.filter((item) => itemFilterPass(item) && matchesQuery([item.title, item.prompt, item.file, item.folder])),
      "item"
    );
    state.wallItems = items;
    state.wallSection = "flat";
    if (!items.length) {
      const incomplete = state.flatIncomplete && state.flatIncomplete.root === state.root && state.flatIncomplete.generation === rootGeneration;
      showMessage(incomplete ? state.flatIncomplete.message || t("部分素材暂不可用，当前列表可能不完整。请刷新重试。") : t("没有匹配的媒体。"));
      return;
    }
    const view = currentView();
    const sig = wallSignature("flat", "flat");
    if (keepScroll && state.grid && state.grid.sig === sig && state.grid.setItems) {
      state.grid.setItems(items, true);
      return;
    }
    mountWall(items, (item) => mediaTile(item), {
      sig: sig,
      minWidth: minWidthFor(view),
      masonry: isMasonry(view),
      ratio: 1,
      keyOf: (item) => mediaTileKey(item),
      ratioOf: (item) => state.ratios.get(mediaTileKey(item)) || 1,
    });
  }

  const comboRequests = new Map();
  const comboResponses = new Map();
  // GPT6PRO_CACHE_EPOCH: same-root refreshes and mutations invalidate snapshots too.
  let comboCacheEpoch = 0;
  function clearComboCache() {
    comboCacheEpoch += 1;
    comboResponses.clear();
    comboRequests.clear();
  }

  async function loadCombo(section, folder) {
    const root = state.root, generation = rootGeneration, epoch = comboCacheEpoch;
    const key = JSON.stringify([root, generation, epoch, state.meta.revision, section, folder || ""]);
    const hit = comboResponses.get(key);
    if (hit && Date.now() - hit.at < 2000) return hit.data;
    if (comboRequests.has(key)) return comboRequests.get(key);
    const task = api("/api/combo?section=" + encodeURIComponent(section) + "&folder=" + encodeURIComponent(folder || "")).then((data) => {
      if (epoch !== comboCacheEpoch || state.root !== root || rootGeneration !== generation || (data && data.root && data.root !== root)) {
        return { ok: false, stale: true, error: t("图库已经切换。") };
      }
      if (!data || !data.ok) return { ok: false, error: (data && data.error) || t("无法打开组合。") };
      if (data.warnings) {
        const warning = trashReadWarning(data);
        if (warning) {
          setStatus(warning, true);
          if (data.card && data.card.countKnown === false && !(data.items || []).length) {
            return { ok: false, code: "trash_record_corrupt", error: warning };
          }
        }
      }
      if (data.metaKnown === false) state.metaKnown = false;
      if (data.metaKnown === false || (data.card && (data.card.metadataKnown === false || data.card.countKnown === false))) return data;
      comboResponses.set(key, { at: Date.now(), data: data });
      while (comboResponses.size > 32) comboResponses.delete(comboResponses.keys().next().value);
      return data;
    }).catch((error) => ({ ok: false, error: String(error.message || error) })).finally(() => {
      if (comboRequests.get(key) === task) comboRequests.delete(key);
    });
    comboRequests.set(key, task);
    return task;
  }

  function previewToken(section, folder) {
    return String(section || "") + "\0" + String(folder || "");
  }

  function previewStill(gen, token) {
    return state.preview.open && state.preview.gen === gen && state.preview.token === token;
  }

  function destroyFilmstrip() {
    if (filmStrip && filmStrip.destroy) filmStrip.destroy();
    filmStrip = null;
    const film = $("cpFilm");
    if (film) film.replaceChildren();
  }

  /* B3: the combos ← / → walk through, in the order the wall shows them. */
  function comboListForPreview() {
    const section = state.preview.section || "";
    // Prefer the wall the user is actually looking at, so the arrows follow the
    // visible order and filters instead of some other sort of the same library.
    if (
      state.view !== "flat" &&
      state.view !== "trash" &&
      state.wallSection === section &&
      Array.isArray(state.wallItems)
    ) {
      return state.wallItems;
    }
    if (!state.library || !state.library.ok) return [];
    const raw = section === "_other" ? state.library.other || [] : state.library.combos || [];
    return sortWall(raw.filter((entry) => comboFilterPass(entry, section)), "group", section);
  }

  function comboIndexInWall() {
    const list = comboListForPreview();
    const folder = state.preview.folder || "";
    return { list: list, at: list.findIndex((entry) => (entry.folder || "") === folder) };
  }

  async function stepCombo(delta) {
    if (!state.preview.open) return;
    const { list, at } = comboIndexInWall();
    if (!list.length) return;
    if (at < 0) {
      // A filter or a re-sort under an open preview can leave the current combo
      // out of the list. Walking in from the near end beats dead arrows.
      await openCombo(state.preview.section, delta > 0 ? list[0] : list[list.length - 1]);
      return;
    }
    const next = at + delta;
    // Stop at the ends rather than wrapping the whole wall around.
    if (next < 0 || next >= list.length) return;
    // openCombo bumps previewGen, so a slow load for the combo we just left
    // cannot paint over the one we are opening now.
    await openCombo(state.preview.section, list[next]);
  }

  function sortVariants(list) {
    return list.slice().sort((left, right) => {
      const sizeLeft = Number(left.bytes || left.size || 0);
      const sizeRight = Number(right.bytes || right.size || 0);
      if (sizeRight !== sizeLeft) return sizeRight - sizeLeft;
      return String(right.created || "").localeCompare(String(left.created || ""));
    });
  }

  function variantFamily(item, items) {
    if (!item || item.media !== "video") return [];
    const videos = (items || []).filter((row) => row && row.media === "video");
    const ids = {};
    videos.forEach((row) => { ids[row.id] = true; });
    const related = videos.filter((row) => {
      if (row.id === item.id) return true;
      if (item.variantOf && (row.id === item.variantOf || row.variantOf === item.variantOf || row.variantOf === item.id)) return true;
      if (row.variantOf === item.id) return true;
      if (item.parent && ids[item.parent] && (row.id === item.parent || row.parent === item.parent || row.variantOf === item.parent)) return true;
      if (row.parent && ids[row.parent] && row.parent === item.id) return true;
      if (item.remoteUrl && row.remoteUrl && item.remoteUrl === row.remoteUrl) return true;
      return false;
    });
    if (related.length >= 2) return sortVariants(related);
    const prompt = String(item.prompt || "").trim();
    if (!prompt) return [];
    const same = videos.filter((row) => String(row.prompt || "").trim() === prompt);
    if (same.length !== 2) return [];
    const sizes = same.map((row) => Number(row.bytes || row.size || 0)).filter((n) => n > 0);
    if (sizes.length === 2 && Math.max(sizes[0], sizes[1]) >= Math.min(sizes[0], sizes[1]) * 1.4) return sortVariants(same);
    return [];
  }

  function resolutionLabel(item) {
    const quality = String((item && item.quality) || "").trim();
    if (quality) return quality;
    const video = $("cpVideo");
    const current = currentPreviewItem();
    if (current && item && item.id === current.id && video && video.videoHeight) {
      const edge = Math.max(video.videoWidth || 0, video.videoHeight || 0);
      if (edge >= 1000) return "1080p";
      if (edge >= 700) return "720p";
      if (edge >= 400) return "480p";
    }
    const bytes = Number((item && (item.bytes || item.size)) || 0);
    if (bytes >= 8 * 1024 * 1024) return t("高清");
    if (bytes >= 2 * 1024 * 1024) return t("标清");
    if (bytes) return Math.max(1, Math.round(bytes / 1024 / 1024)) + " MB";
    return t("版本");
  }

  function closeResolutionMenu() {
    const menu = $("cpResMenu");
    const button = $("cpRes");
    if (menu) menu.hidden = true;
    if (button) button.setAttribute("aria-expanded", "false");
  }

  function paintResolutionButton() {
    const wrap = $("cpResWrap");
    const button = $("cpRes");
    const menu = $("cpResMenu");
    if (!wrap || !button || !menu) return;
    const item = currentPreviewItem();
    const family = variantFamily(item, state.preview.items || []);
    if (family.length < 2) {
      wrap.hidden = true;
      closeResolutionMenu();
      return;
    }
    wrap.hidden = false;
    button.textContent = t("选择分辨率 · {resolution}", {resolution: resolutionLabel(item)});
    menu.replaceChildren();
    family.forEach((row) => {
      const choice = document.createElement("button");
      choice.type = "button";
      choice.textContent = resolutionLabel(row) + (row.id === item.id ? t("（当前）") : "");
      choice.className = row.id === item.id ? "current" : "";
      choice.addEventListener("click", (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        closeResolutionMenu();
        const at = (state.preview.items || []).findIndex((it) => it.id === row.id);
        if (at < 0 || at === state.preview.index) return;
        state.preview.index = at;
        paintPreview();
      });
      menu.appendChild(choice);
    });
  }

  function syncPreviewNav() {
    const inGroup = (state.preview.items || []).length > 1;
    if ($("cpUp")) $("cpUp").hidden = !inGroup;
    if ($("cpDown")) $("cpDown").hidden = !inGroup;
    const { list, at } = comboIndexInWall();
    const lost = at < 0;
    const prev = $("cpPrevCombo");
    const next = $("cpNextCombo");
    if (prev) {
      prev.disabled = !list.length || (!lost && at === 0);
      prev.setAttribute("aria-disabled", String(prev.disabled));
    }
    if (next) {
      next.disabled = !list.length || (!lost && at === list.length - 1);
      next.setAttribute("aria-disabled", String(next.disabled));
    }
    paintResolutionButton();
  }

  function showPreviewShell(partial) {
    cancelDurationProbe();
    stopHoverVideo();
    closeLightbox();
    closeCtx();
    destroyFilmstrip();
    const gen = ++previewGen;
    const token = previewToken(partial.section, partial.folder);
    state.preview = {
      open: true,
      section: partial.section || "",
      folder: partial.folder || "",
      card: partial.card || {},
      items: partial.items || [],
      index: Math.max(0, partial.index || 0),
      savedId: "",
      token: token,
      gen: gen,
    };
    $("comboPreview").hidden = false;
    document.body.classList.add("preview-open");
    $("cpTitle").textContent = titleOf(partial.card || {});
    $("cpDate").textContent = "";
    $("cpKind").textContent = "";
    $("cpKind").hidden = true;
    $("cpPrompt").textContent = t("载入中…");
    const flags = $("cpFlags");
    if (flags) flags.hidden = true;
    clearAbLoop();
    syncPreviewNav();
    const img = $("cpImage");
    const video = $("cpVideo");
    img.classList.remove("show");
    video.classList.remove("show");
    clearPreviewMediaLoad(video);
    video.pause();
    video.removeAttribute("src");
    if (partial.coverUrl && img) {
      img.src = partial.coverUrl;
      img.classList.add("show");
    }
    if (partial.items && partial.items.length) {
      mountFilmstrip(partial.items);
      if (partial.items[state.preview.index]) paintPreview();
    }
    return { gen: gen, token: token };
  }

  async function openCombo(section, entry) {
    const folder = entry.folder || "";
    // Reuse an already loaded flat listing while authoritative combo metadata is
    // refreshed. A missing cover stays on the existing loading shell, never an
    // unrelated first clip. openComboPreview still verifies the selected file.
    const seed = previewSeed(section, folder, entry.coverId);
    const opened = showPreviewShell({
      section: section,
      folder: folder,
      card: entry,
      coverUrl: seed.items.length ? "" : comboCoverUrl(section, folder, entry.coverId || ""),
      items: seed.items,
      index: seed.index,
    });
    const data = await loadCombo(section, folder);
    if (!previewStill(opened.gen, opened.token)) return;
    if (!data || data.ok === false) {
      $("cpPrompt").textContent = translate((data && data.error) || t("无法打开组合。"));
      setStatus((data && data.error) || t("无法打开组合。"), true);
      return;
    }
    const coverId = data.coverId || entry.coverId || "";
    let index = 0;
    if (coverId) {
      const i = (data.items || []).findIndex((it) => it.id === coverId);
      if (i >= 0) index = i;
    }
    openComboPreview(data, index, opened);
  }

  // Membership is immutable within a /api/flat snapshot. Deletion, root switch
  // and refresh replace the array; metadata edits keep the referenced items live.
  const flatGroupIndexes = new WeakMap();
  function flatGroupMembers(rows, section, folder) {
    if (!Array.isArray(rows)) return [];
    let cached = flatGroupIndexes.get(rows);
    if (!cached || cached.length !== rows.length) {
      const sections = new Map();
      for (const item of rows) {
        const key = item.section;
        let groups = sections.get(key);
        if (!groups) { groups = new Map(); sections.set(key, groups); }
        const group = item.folder || "";
        let members = groups.get(group);
        if (!members) { members = []; groups.set(group, members); }
        members.push(item);
      }
      cached = {length: rows.length, sections};
      flatGroupIndexes.set(rows, cached);
    }
    const groups = cached.sections.get(section);
    // A preview may reorder its list, but must not mutate the shared index.
    return groups && groups.has(folder || "") ? groups.get(folder || "").slice() : [];
  }

  function previewSeed(section, folder, coverId) {
    const items = flatGroupMembers(state.flat, section, folder).filter(it => it.url);
    const index = coverId ? items.findIndex(it => it.id === coverId) : -1;
    return index >= 0 ? { items: items, index: index } : { items: [], index: 0 };
  }

  async function openItemInCombo(item) {
    const siblings = flatGroupMembers(state.flat, item.section, item.folder || "");
    const initial = siblings.length ? siblings : (item.url ? [item] : []);
    const initialIndex = Math.max(0, initial.findIndex((it) => it.id === item.id));
    const opened = showPreviewShell({
      section: item.section,
      folder: item.folder || "",
      card: item,
      items: initial,
      index: initialIndex,
    });
    const data = await loadCombo(item.section, item.folder || "");
    if (!previewStill(opened.gen, opened.token)) return;
    if (!data || data.ok === false) {
      $("cpPrompt").textContent = translate((data && data.error) || t("无法打开组合。"));
      setStatus((data && data.error) || t("无法打开组合。"), true);
      return;
    }
    let index = 0;
    if (item.id) {
      const i = (data.items || []).findIndex((it) => it.id === item.id);
      if (i >= 0) index = i;
    }
    openComboPreview(data, index, opened);
  }

  function filmThumb(item, i) {
    const isVideo = item.media === "video";
    const src = isVideo
      ? coverUrlFor(item.section, item.folder || "", item.id || "")
      : (item.url || "");
    const thumb = el("button", {
      type: "button",
      class: "cp-thumb" + (i === state.preview.index ? " current" : ""),
      dataset: isVideo && item.id ? { coverId: item.id } : null,
      onclick: () => {
        if (state.preview.index === i) return;
        state.preview.index = i;
        paintPreview();
      },
      oncontextmenu: (ev) => openCtx(ev, { kind: "item", item: item }),
    });
    const ph = placeholder(isVideo);
    thumb.appendChild(ph);
    if (src) {
      const img = document.createElement("img");
      img.alt = "";
      img.addEventListener("load", () => {
        if (ph.parentNode) ph.remove();
        thumb.insertBefore(img, thumb.firstChild);
      }, { once: true });
      img.src = src;
    }
    if (isVideo) {
      const seconds = knownDuration(item.id, item.duration);
      if (seconds) setDurationBadge(thumb, seconds);
      else if (item.id) wantDuration(thumb, item.section, item.folder || "", item.id, item.url);
    }
    return thumb;
  }

  function mountFilmstrip(items) {
    destroyFilmstrip();
    const film = $("cpFilm");
    if (!film) return;
    const list = items || [];
    const spacer = el("div", { class: "cp-film-spacer" });
    const windowEl = el("div", { class: "cp-film-window" });
    film.appendChild(spacer);
    film.appendChild(windowEl);
    let thumbSize = FILM_THUMB;
    let rowH = thumbSize + FILM_GAP;
    function measure() {
      // clientWidth excludes the native scrollbar, including non-overlay Windows scrollbars.
      const next = Math.max(1, Math.min(FILM_THUMB, (film.clientWidth || FILM_THUMB + 8) - 8));
      if (next !== thumbSize) {
        const row = film.scrollTop / rowH;
        thumbSize = next;
        rowH = thumbSize + FILM_GAP;
        film.scrollTop = row * rowH;
      }
      film.style.setProperty("--film-thumb-size", thumbSize + "px");
      spacer.style.height = (list.length * thumbSize + Math.max(0, list.length - 1) * FILM_GAP) + "px";
    }
    const pool = new Map();

    function thumbAt(i) {
      let thumb = pool.get(i);
      if (!thumb) {
        thumb = filmThumb(list[i], i);
        pool.set(i, thumb);
      }
      thumb.classList.toggle("current", i === state.preview.index);
      return thumb;
    }

    function paint() {
      measure();
      const n = list.length;
      if (!n) {
        windowEl.replaceChildren();
        return;
      }
      const viewH = film.clientHeight || 1;
      const maxIdx = n - 1;
      let start = Math.max(0, Math.floor(film.scrollTop / rowH) - FILM_OVERSCAN);
      const end = Math.min(maxIdx, Math.ceil((film.scrollTop + viewH) / rowH) + FILM_OVERSCAN);
      if (start > end) start = end;
      windowEl.style.transform = "translateY(" + (start * rowH) + "px)";
      const wanted = [];
      for (let i = start; i <= end; i++) wanted.push(thumbAt(i));
      wanted.forEach((thumb) => windowEl.appendChild(thumb));
      Array.prototype.slice.call(windowEl.children).forEach((child) => {
        if (wanted.indexOf(child) < 0) windowEl.removeChild(child);
      });
    }

    function scrollNearest(idx) {
      if (idx < 0 || idx >= list.length) return;
      const itemTop = idx * rowH;
      const itemBottom = itemTop + thumbSize;
      const viewTop = film.scrollTop;
      const viewBottom = viewTop + film.clientHeight;
      if (itemTop < viewTop) film.scrollTop = itemTop;
      else if (itemBottom > viewBottom) film.scrollTop = Math.max(0, itemBottom - film.clientHeight);
    }

    function onScroll() {
      paint();
    }

    const ro = new ResizeObserver(() => paint());
    film.addEventListener("scroll", onScroll, { passive: true });
    ro.observe(film);
    filmStrip = {
      destroy() {
        film.removeEventListener("scroll", onScroll);
        ro.disconnect();
        pool.clear();
      },
      paint() {
        paint();
      },
      showIndex(idx) {
        measure();
        scrollNearest(idx);
        paint();
      },
    };
    filmStrip.showIndex(state.preview.index);
  }

  function paintFilmCurrent() {
    if (filmStrip && filmStrip.showIndex) filmStrip.showIndex(state.preview.index);
  }

  function rememberPreviewItem() {
    const preview = state.preview;
    const item = preview.items[preview.index];
    if (!item || !item.id) return;
    if (state.metaKnown === false || item.metadataKnown === false) return;
    if (preview.savedId === item.id) return;
    const expectedRoot = state.root;
    const expectedGeneration = rootGeneration;
    preview.savedId = item.id;
    const gkey = groupKey(preview.section, preview.folder);
    if (!state.meta.groups[gkey]) {
      state.meta.groups[gkey] = { fav: false, dislike: false, tags: [], lastViewedId: item.id };
    } else {
      state.meta.groups[gkey].lastViewedId = item.id;
    }
    if (state.library) {
      const list = preview.section === "_other" ? state.library.other : state.library.combos;
      (list || []).forEach((entry) => {
        if ((entry.folder || "") === (preview.folder || "")) {
          entry.coverId = item.id;
          entry.coverMedia = item.media;
          entry.lastViewedId = item.id;
        }
      });
    }
    putMeta({
      group: {
        section: preview.section,
        folder: preview.folder,
        lastViewedId: item.id,
      },
    }, expectedRoot).catch(function (error) {
      if (state.root !== expectedRoot || rootGeneration !== expectedGeneration) return;
      if (state.preview === preview && preview.savedId === item.id) preview.savedId = "";
      setStatus(t("最后浏览位置未保存：{error}", { error: translate(error && error.message || t("元数据写入失败。")) }), true);
    });
  }

  /* B2: A / B in-and-out points on the current clip. */
  function loopMark(seconds) {
    const value = Number(seconds);
    return Number.isFinite(value) && value >= 0 ? value : null;
  }

  function videoDuration() {
    const video = $("cpVideo");
    const value = video ? Number(video.duration) : 0;
    return Number.isFinite(value) && value > 0 ? value : 0;
  }

  function paintStageDuration() {
    const badge = $("cpDur");
    if (!badge) return;
    const item = currentPreviewItem();
    const video = $("cpVideo");
    const showing = !!(item && item.media === "video" && video && video.classList.contains("show"));
    const seconds = showing ? (videoDuration() || knownDuration(item.id, item.duration)) : 0;
    const text = fmtDuration(seconds);
    badge.hidden = !text;
    badge.textContent = text || "";
  }

  function pct(part, whole) {
    if (!(whole > 0)) return 0;
    return Math.max(0, Math.min(100, (100 * part) / whole));
  }

  function paintScrub() {
    const wrap = $("cpScrubWrap");
    const item = currentPreviewItem();
    const video = $("cpVideo");
    const isVideo = !!(item && item.media === "video" && video);
    if (wrap) wrap.hidden = !isVideo;
    paintStageDuration();
    if (!isVideo) return;
    paintLoopPointButtons();
    const dur = videoDuration();
    const currentTime = Number(video.currentTime) || 0;
    const seek = $("cpSeek");
    if (seek && dur > 0 && document.activeElement !== seek) {
      seek.value = String(Math.round((currentTime / dur) * 1000));
    }
    const played = $("cpScrubPlayed");
    if (played) played.style.width = pct(currentTime, dur) + "%";
    const range = loopOn ? loopRange() : null;
    const ab = $("cpScrubAb");
    if (ab) {
      if (range && dur > 0) {
        ab.hidden = false;
        ab.style.left = pct(range.a, dur) + "%";
        ab.style.width = pct(range.b - range.a, dur) + "%";
      } else {
        ab.hidden = true;
      }
    }
    function placeMark(el, at) {
      if (!el) return;
      if (at == null || !(dur > 0)) {
        el.hidden = true;
        return;
      }
      el.hidden = false;
      el.style.left = pct(at, dur) + "%";
    }
    placeMark($("cpMarkA"), abLoop.a);
    placeMark($("cpMarkB"), abLoop.b);
    const clock = $("cpClock");
    if (clock) clock.textContent = (fmtDuration(currentTime) || "0:00") + " / " + (fmtDuration(dur) || "0:00");
    const play = $("cpPlay");
    if (play) play.textContent = video.paused ? "▶" : "❚❚";
    const mute = $("cpMute");
    if (mute) {
      const silent = state.volume.muted || state.volume.level === 0;
      mute.replaceChildren(speakerSvg(silent));
      mute.setAttribute("aria-label", silent ? t("取消静音") : t("静音"));
    }
    if (play) play.setAttribute("aria-label", video.paused ? t("播放") : t("暂停"));
  }

  function togglePreviewPlay() {
    const video = $("cpVideo");
    const item = currentPreviewItem();
    if (!video || !item || item.media !== "video") return;
    if (video.paused) {
      const play = video.play();
      if (play && play.catch) play.catch(function () {});
    } else {
      video.pause();
    }
    paintScrub();
  }

  function seekPreview(delta) {
    const video = $("cpVideo");
    const item = currentPreviewItem();
    if (!video || !item || item.media !== "video") return;
    const duration = videoDuration() || video.duration || 0;
    if (!(duration > 0) || !Number.isFinite(delta)) return;
    let next = (video.currentTime || 0) + delta;
    const range = loopOn ? loopRange() : null;
    if (range) next = Math.min(range.b, Math.max(range.a, next));
    else next = Math.min(duration, Math.max(0, next));
    video.currentTime = next;
    paintScrub();
  }

  function stepPreviewFrame(direction) {
    const video = $("cpVideo");
    const item = currentPreviewItem();
    if (!video || !item || item.media !== "video") return;
    video.pause();
    seekPreview((direction < 0 ? -1 : 1) / 30);
  }

  /* The window actually being repeated, or null for "the whole clip".
     A alone runs to the tail, B alone starts at the head, and A >= B is
     nonsense that gets ignored rather than trapping playback. */
  function loopRange() {
    if (abLoop.a == null && abLoop.b == null) return null;
    const a = abLoop.a == null ? 0 : abLoop.a;
    const b = abLoop.b == null ? videoDuration() : abLoop.b;
    if (!(b > 0) || !(a < b)) return null;
    return { a: a, b: b };
  }

  /* The whole-clip case is what `video.loop` is for: letting the element repeat
     itself is seamless, where the old timeupdate seek stuttered every pass. Only
     a real A-B window needs us to move the playhead at all. */
  function applyLoopMode() {
    const video = $("cpVideo");
    if (!video) return;
    video.loop = loopOn && !loopRange();
  }

  function loopStateText() {
    if (!loopOn) return t("循环已关（整段播完即停）");
    const range = loopRange();
    if (range) return t("循环区间 {a} – {b}", {a: fmtClock(range.a), b: fmtClock(range.b)});
    // An A with no B needs the clip's length before it is a range at all, and
    // that only arrives with the metadata.
    if (abLoop.a != null && abLoop.b == null) return t("正在读取时长，暂按整段循环");
    if (abLoop.a != null || abLoop.b != null) return t("A ≥ B，已忽略，整段循环");
    return t("整段循环");
  }

  function abLooping() {
    return !!(loopOn && loopRange());
  }

  function loopPointError(which, at) {
    const duration = videoDuration();
    if (!(duration > 0) || at == null || at < 0 || at > duration) return t("请等待视频时长就绪后再设置循环点。");
    if (which === "a") {
      if (!(at < (abLoop.b == null ? duration : abLoop.b))) return t("A 点必须早于 B 点或视频结尾。");
    } else if (which === "b") {
      if (!(at > (abLoop.a == null ? 0 : abLoop.a))) return t("B 点必须晚于 A 点或视频开头。");
    } else {
      return t("未知的循环点。");
    }
    return "";
  }

  function paintLoopPointButtons() {
    const video = $("cpVideo");
    const at = video ? loopMark(video.currentTime) : null;
    ["a", "b"].forEach(which => {
      const button = $(which === "a" ? "cpLoopA" : "cpLoopB");
      if (!button) return;
      const error = loopPointError(which, at);
      const mark = abLoop[which];
      const label = which.toUpperCase();
      button.disabled = !!error;
      button.classList.toggle("on", mark != null);
      button.setAttribute("aria-pressed", String(mark != null));
      button.title = (mark == null ? t("设置 {point} 点", {point: label}) : t("{point} 点 {time}", {point: label, time: fmtClock(mark)})) + (error ? "；" + error : "");
    });
  }

  function loopCapsuleFit(metrics) {
    const { trackLeft, trackRight, timeRight, muteLeft, volumeLeft, naturalWidth, controlHeight } = metrics;
    if (![trackLeft, trackRight, timeRight, muteLeft, volumeLeft, naturalWidth, controlHeight].every(Number.isFinite)
        || trackRight <= trackLeft || naturalWidth <= 0 || controlHeight <= 0) return null;
    const center = (timeRight + muteLeft) / 2;
    const gap = 8;
    // The label gap owns the center, even when an expanded volume slider
    // temporarily occupies part of it. In that case lift instead of covering it.
    const leftEdge = Math.max(trackLeft, timeRight);
    const rightEdge = Math.min(trackRight, muteLeft, volumeLeft);
    const room = 2 * Math.max(0, Math.min(center - leftEdge - gap, rightEdge - center - gap));
    const minScale = 0.85;
    const scale = Math.max(minScale, Math.min(1, room / naturalWidth));
    const raised = room < naturalWidth * minScale;
    return { left: center - trackLeft, scale: scale, raised: raised,
      bridgeHeight: (raised ? controlHeight + 12 : 8) / scale };
  }

  let loopLayoutFrame = 0;
  function scheduleLoopLayout() {
    if (loopLayoutFrame) return;
    loopLayoutFrame = requestAnimationFrame(() => {
      loopLayoutFrame = 0;
      const bar = $("cpLoop"), track = $("cpScrub"), clock = $("cpClock"), mute = $("cpMute"), volume = $("cpVolumeBox");
      if (!bar || bar.hidden || !track || !clock || !mute || !volume) return;
      const trackRect = track.getBoundingClientRect();
      const fit = loopCapsuleFit({ trackLeft: trackRect.left, trackRight: trackRect.right,
        timeRight: clock.getBoundingClientRect().right, muteLeft: mute.getBoundingClientRect().left,
        volumeLeft: volume.getBoundingClientRect().left, naturalWidth: bar.offsetWidth, controlHeight: bar.offsetHeight });
      if (!fit) return;
      // offsetWidth/Height are the natural layout size, unaffected by our scale.
      bar.style.setProperty("--loop-left", fit.left + "px");
      bar.style.setProperty("--loop-scale", String(fit.scale));
      bar.style.setProperty("--loop-bridge", fit.bridgeHeight + "px");
      bar.classList.toggle("raised", fit.raised);
    });
  }

  function bindLoopLayout() {
    // Follow the frame dimensions produced by the player's existing layout
    // observer. Also watch intrinsic control widths (clock digits / CLEAR /
    // volume expansion); never measure layout from the timeupdate handler.
    if (typeof ResizeObserver === "function") {
      const observer = new ResizeObserver(scheduleLoopLayout);
      ["cpMediaFrame", "cpScrub", "cpClock", "cpMute", "cpVolumeBox", "cpLoop"].forEach(id => {
        const node = $(id);
        if (node) observer.observe(node);
      });
    }
    window.addEventListener("resize", scheduleLoopLayout);
    scheduleLoopLayout();
  }

  function paintLoopBar() {
    const bar = $("cpLoop");
    const item = currentPreviewItem();
    const isVideo = !!(item && item.media === "video");
    if (bar) bar.hidden = !isVideo;
    applyLoopMode();
    paintScrub();
    if (!isVideo || !bar) return;
    const toggle = $("cpLoopOn");
    const ranged = abLooping();
    if (toggle) {
      if (ranged) toggle.textContent = "CLEAR";
      else toggle.replaceChildren(repeatSvg(loopOn));
      toggle.classList.toggle("off", !loopOn);
      toggle.classList.toggle("ab", ranged);
      toggle.setAttribute("aria-pressed", String(!!loopOn));
      const action = abLoop.a != null || abLoop.b != null
        ? t("清除 A/B 点，恢复整段循环") : (loopOn ? t("关闭循环") : t("开启整段循环"));
      toggle.setAttribute("aria-label", action);
      toggle.title = loopStateText() + "；" + action;
    }
    paintLoopPointButtons();
    scheduleLoopLayout();
  }

  function fmtClock(seconds) {
    const total = Math.max(0, Number(seconds) || 0);
    const whole = Math.floor(total);
    const tenth = Math.floor((total - whole) * 10);
    return Math.floor(whole / 60) + ":" + String(whole % 60).padStart(2, "0") + "." + tenth;
  }

  /* Drops the marks only. The switch is the user's, so a clip that was looping
     keeps looping — over its whole length again. */
  function clearAbLoop() {
    abLoop.a = null;
    abLoop.b = null;
    loopSeeking = false;
    paintLoopBar();
  }

  function setLoopPoint(which) {
    const video = $("cpVideo");
    const item = currentPreviewItem();
    if (!video || !item || item.media !== "video") return;
    const at = loopMark(video.currentTime);
    const error = loopPointError(which, at);
    if (error) {
      setStatus(error, true);
      paintLoopPointButtons();
      return;
    }
    if (which === "a") abLoop.a = at;
    else abLoop.b = at;
    loopSeeking = false;
    loopOn = true;
    paintLoopBar();
  }

  function onLoopIconClick() {
    if (abLoop.a != null || abLoop.b != null) {
      loopOn = true;
      clearAbLoop();
      return;
    }
    setLoopOn(!loopOn);
  }

  function setLoopOn(on) {
    loopOn = !!on;
    paintLoopBar();
  }

  /* One seek per pass, guarded by a lock the `seeked` event clears. The old
     version reassigned currentTime on every timeupdate once the playhead was
     past B, which is what made the A-B loop stutter. */
  function jumpToLoopStart() {
    const range = loopRange();
    const video = $("cpVideo");
    if (!range || !video || loopSeeking) return;
    loopSeeking = true;
    try {
      video.currentTime = range.a;
    } catch (err) {
      loopSeeking = false;
      return;
    }
    const play = video.play();
    if (play && play.catch) play.catch(function () {});
  }

  function onLoopTick() {
    if (!state.preview.open || !loopOn) return;
    const range = loopRange();
    if (!range) return;
    const video = $("cpVideo");
    if (!video || video.paused || video.seeking || loopSeeking) return;
    // Keep the early-seek tolerance inside even a sub-frame A/B range.
    const tolerance = Math.min(0.03, (range.b - range.a) / 2);
    if (video.currentTime < range.b - tolerance) return;
    jumpToLoopStart();
  }

  /* B alone (or B at the very tail) never crosses the threshold above, because
     playback simply ends. */
  function onLoopEnded() {
    if (!state.preview.open || !loopOn) return;
    if (!loopRange()) return;
    jumpToLoopStart();
  }

  function clearPreviewMediaLoad(video) {
    const load = previewMediaLoad;
    previewMediaGeneration += 1;
    previewMediaLoad = null;
    if (!load || load.video !== video) return;
    video.removeEventListener("loadedmetadata", load.onMeta);
    video.removeEventListener("durationchange", load.onMeta);
  }

  function bindPreviewMediaLoad(video, item) {
    clearPreviewMediaLoad(video);
    const root = String(state.root || "");
    const target = new URL(item.url, window.location.href);
    target.searchParams.set("_givPreview", String(previewMediaGeneration));
    const load = {
      generation: previewMediaGeneration,
      root: root,
      id: String(item.id || ""),
      section: String(item.section || ""),
      folder: String(item.folder || ""),
      src: target.href,
      item: {
        id: item.id,
        section: item.section,
        folder: item.folder || "",
      },
      video: video,
      onMeta: null,
    };
    load.onMeta = () => onPreviewVideoMeta(load);
    previewMediaLoad = load;
    video.addEventListener("loadedmetadata", load.onMeta);
    video.addEventListener("durationchange", load.onMeta);
    video.src = load.src;
  }

  function onPreviewVideoMeta(load) {
    const item = currentPreviewItem();
    const video = $("cpVideo");
    if (!load || load !== previewMediaLoad || !video || load.video !== video) return;
    if (state.root !== load.root || !item || String(item.id || "") !== load.id) return;
    if (String(item.section || "") !== load.section || String(item.folder || "") !== load.folder) return;
    if (!video.currentSrc || new URL(video.currentSrc, window.location.href).href !== load.src) return;
    const seconds = videoDuration();
    paintLoopBar();
    paintScrub();
    if (!item || item.media !== "video" || !seconds || !video) return;
    if (!video.classList.contains("show")) return;
    saveMeasuredDuration(load.item, seconds, load.root);
    paintResolutionButton();
  }

  function paintPreview(preserveMedia) {
    const { items, index, card } = state.preview;
    const item = items[index];
    if (!item) return;
    if (!preserveMedia) clearAbLoop();
    const img = $("cpImage");
    const video = $("cpVideo");
    if (!preserveMedia) {
    img.classList.remove("show");
    video.classList.remove("show");
    if (item.media === "video") {
      img.removeAttribute("src");
      bindPreviewMediaLoad(video, item);
      video.classList.add("show");
      video.volume = state.volume.level / 100;
      video.muted = state.volume.muted;
      applyLoopMode();
      const play = video.play();
      if (play && play.catch) play.catch(function () {});
      const known = knownDuration(item.id, item.duration);
      if (known) paintStageDuration();
    } else {
      clearPreviewMediaLoad(video);
      video.pause();
      video.removeAttribute("src");
      video.load();
      img.src = item.url;
      img.classList.add("show");
    }
    }
    paintScrub();
    $("cpTitle").textContent = titleOf(card || item);
    $("cpDate").textContent = fmtDate(item.created);
    $("cpKind").textContent = item.kind || "";
    $("cpKind").hidden = !item.kind;
    $("cpPrompt").textContent = item.prompt || "";
    $("cpCopy").textContent = t("复制提示词");
    syncPreviewNav();
    paintLoopBar();
    paintPreviewFlags();
    paintFilmCurrent();
    rememberPreviewItem();
    if (typeof playerUI !== "undefined" && playerUI) playerUI.mediaChanged();
  }

  function openComboPreview(data, index, opened) {
    if (opened && !previewStill(opened.gen, opened.token)) return;
    if (!state.preview.open) return;
    const items = data.items || [];
    if (!items.length) {
      setStatus(t("这个组合没有可见媒体。"), true);
      return;
    }
    stopHoverVideo();
    closeLightbox();
    const previous = currentPreviewItem();
    const selected = previous && items.findIndex((it) => it.id === previous.id && it.url === previous.url && it.file === previous.file && it.size === previous.size);
    const preserve = selected >= 0 && previous && state.preview.section === data.section && state.preview.folder === data.folder;
    if (preserve) index = selected;
    state.preview.section = data.section || state.preview.section || "";
    state.preview.folder = data.folder || state.preview.folder || "";
    state.preview.card = data.card || state.preview.card || {};
    state.preview.items = items;
    state.preview.index = Math.max(0, Math.min(index || 0, items.length - 1));
    if (!preserve) state.preview.savedId = "";
    if (opened) {
      state.preview.token = opened.token;
      state.preview.gen = opened.gen;
    } else if (!state.preview.token) {
      state.preview.token = previewToken(state.preview.section, state.preview.folder);
    }
    $("comboPreview").hidden = false;
    document.body.classList.add("preview-open");
    mountFilmstrip(items);
    paintPreview(!!preserve);
  }

  function stepPreview(delta) {
    const n = state.preview.items.length;
    if (!n || !state.preview.open) return;
    state.preview.index = (state.preview.index + delta + n) % n;
    paintPreview();
  }

  function hideComboPreview() {
    if (playerUI) playerUI.closed();
    previewGen += 1;
    closeCtx();
    destroyFilmstrip();
    const video = $("cpVideo");
    if (video) {
      clearPreviewMediaLoad(video);
      video.pause();
      video.removeAttribute("src");
      video.load();
      video.classList.remove("show");
    }
    const img = $("cpImage");
    if (img) {
      img.removeAttribute("src");
      img.classList.remove("show");
    }
    state.preview = {
      open: false,
      section: "",
      folder: "",
      card: null,
      items: [],
      index: 0,
      savedId: "",
      token: "",
      gen: previewGen,
    };
    closeResolutionMenu();
    $("comboPreview").hidden = true;
    document.body.classList.remove("preview-open");
    if ($("cpDur")) $("cpDur").hidden = true;
    if ($("cpScrubWrap")) $("cpScrubWrap").hidden = true;
    clearAbLoop();
    if ($("lightbox").hidden && $("browser").hidden && $("tagDialog").hidden) {
      document.body.classList.remove("modal-open");
    }
  }

  function closeComboPreview() {
    hideComboPreview();
  }

  async function renderTrash(gen) {
    if (!state.library || !state.library.ok) {
      showMessage((state.library && state.library.error) || t("请选择图库根目录。"));
      return;
    }
    const data = await withLoading(t("正在载入回收站…"), () => api("/api/trash"));
    if (gen != null && gen !== renderGen) return;
    if (!data || !data.ok) {
      showMessage((data && data.error) || t("回收站记录暂时无法读取，未将图库判为空。"));
      return;
    }
    const items = (data.items || []).concat(data.legacyItems || []);
    state.trash = items;
    state.wallItems = items;
    state.wallSection = "trash";
    if (!items.length) {
      showMessage(t(data.warnings ? "部分回收站记录无法核验，原文件已保留。" : "回收站是空的。"));
      return;
    }
    setStatus(t("回收站 · {count} 项 · {path}", {count: items.length, path: state.root || ""}));
    if ((data.legacyItems || []).length || data.warnings) setStatus(t("部分回收站记录需要核验，请查看条目中的恢复说明；原文件已保留。"), true);
    mountWall(items, (item) => trashTile(item), {
      sig: wallSignature("trash", "trash"),
      minWidth: minWidthFor(currentView()),
      masonry: false,
      ratio: 1,
      keyOf: (item) => "trash:" + (item.id || item.file),
    });
  }

  function closeLightbox() {
    state.lightbox.open = false;
    $("lightbox").hidden = true;
    document.body.classList.remove("modal-open");
    const video = $("lbVideo");
    video.pause();
    video.removeAttribute("src");
    video.load();
    $("lbImage").removeAttribute("src");
  }

  function paintLightbox() {
    const { items, index } = state.lightbox;
    const item = items[index];
    if (!item) return;
    const img = $("lbImage");
    const video = $("lbVideo");
    img.classList.remove("show");
    video.classList.remove("show");
    if (item.media === "video") {
      img.removeAttribute("src");
      video.src = item.url;
      video.volume = state.volume.level / 100;
      video.muted = state.volume.muted;
      video.classList.add("show");
    } else {
      video.pause();
      video.removeAttribute("src");
      img.src = item.url;
      img.classList.add("show");
    }
    $("lbKind").textContent = item.kind || "";
    $("lbKind").hidden = !item.kind;
    $("lbDate").textContent = fmtDate(item.created);
    $("lbPrompt").textContent = item.prompt || "";
    $("lbCopy").textContent = t("复制提示词");
  }

  function openLightbox(items, index) {
    state.lightbox = { open: true, items: items, index: index };
    $("lightbox").hidden = false;
    document.body.classList.add("modal-open");
    paintLightbox();
  }

  function stepLightbox(delta) {
    const n = state.lightbox.items.length;
    if (!n) return;
    state.lightbox.index = (state.lightbox.index + delta + n) % n;
    paintLightbox();
  }

  async function render(opts) {
    const keepScroll = !!(opts && opts.keepScroll);
    const gen = ++renderGen;
    syncNav();
    paintCatMenu();
    syncSelBar();
    if (state.view === "trash") {
      await renderTrash(gen);
      return;
    }
    if (state.view === "flat") {
      await renderFlat(gen, keepScroll);
      return;
    }
    if (state.view === "other") {
      await renderWall("_other", gen, keepScroll);
      return;
    }
    await renderWall(state.library && state.library.mode === "loose" ? "loose" : "combos", gen, keepScroll);
  }

  function applyDensity(density) {
    const view = currentView();
    view.density = density;
    syncNav();
    saveViews();
    // Masonry vs square is a different layout: remount, keep everything else.
    render({ keepScroll: false });
  }

  function applyTileSize(px) {
    const view = currentView();
    const size = Math.max(TILE_MIN, Math.min(TILE_MAX, Number(px) || 0));
    view.tile = size;
    if (state.grid && state.grid.updateLayout) {
      state.grid.sig = wallSignature(state.view === "flat" ? "flat" : state.view === "trash" ? "trash" : "combos", state.wallSection || "");
      state.grid.updateLayout(size, isMasonry(view));
    } else {
      render({ keepScroll: true });
    }
    saveViewsSoon();
  }

  async function hardReloadLibrary() {
    return withLoading(t("正在重新加载图库…"), async () => {
      await refreshAfterChange();
      if (state.root) await loadSideState(state.root);
      if (state.preview.open) paintPreviewFlags();
    });
  }

  async function refreshAfterChange() {
    clearComboCache();
    const expectedGen = rootGeneration;
    state.flat = null;
    state.flatIncomplete = null;
    state.flatPromise = null;
    state.flatPromiseGen = 0;
    state.flatPromiseRoot = "";
    state.cards.clear();
    const lib = await api("/api/library");
    if (expectedGen !== rootGeneration) return;
    state.library = lib || state.library;
    if (lib && lib.metaKnown === false) state.metaKnown = false;
    if (state.preview.open) {
      const gen = state.preview.gen;
      const token = state.preview.token;
      const data = await loadCombo(state.preview.section, state.preview.folder);
      if (expectedGen !== rootGeneration) return;
      if (previewStill(gen, token)) {
        if (data && (data.items || []).length) {
          const saved = state.preview.savedId;
          state.preview.items = data.items;
          state.preview.card = data.card;
          let idx = saved ? data.items.findIndex((it) => it.id === saved) : -1;
          if (idx < 0) idx = Math.min(state.preview.index, data.items.length - 1);
          state.preview.index = Math.max(0, idx);
          state.preview.savedId = "";
          mountFilmstrip(data.items);
          paintPreview();
        } else {
          hideComboPreview();
        }
      }
    }
    if (expectedGen !== rootGeneration) return;
    await render({ keepScroll: true });
  }

  function paintTileFlags(tile, flags) {
    if (!tile) return;
    tile.classList.toggle("fav", !!flags.fav);
    tile.classList.toggle("disliked", !!flags.dislike);
    const heart = tile.querySelector("button.heart");
    if (!heart) return;
    const on = !!flags.fav;
    heart.classList.toggle("on", on);
    heart.title = on ? t("取消收藏") : t("添加到收藏");
    heart.replaceChildren(heartSvg(on));
  }

  function currentPreviewItem() {
    if (!state.preview.open) return null;
    return state.preview.items[state.preview.index] || null;
  }

  function paintPreviewFlags() {
    const wrap = $("cpFlags");
    const item = currentPreviewItem();
    if (!wrap) return;
    if (!item) {
      wrap.hidden = true;
      return;
    }
    wrap.hidden = false;
    const flags = itemFlags(item);
    paintTileFlags(wrap, flags);
    const metadataDisabled = state.metaKnown === false || item.metadataKnown === false;
    const heart = wrap.querySelector("button.heart");
    if (heart) heart.disabled = metadataDisabled;
    const dislike = $("cpDislike");
    if (dislike) {
      dislike.disabled = metadataDisabled;
      dislike.classList.toggle("on", !!flags.dislike);
      dislike.textContent = flags.dislike ? t("取消不喜欢") : t("不喜欢");
    }
  }

  function paintFlagTargets(attr, value, flags) {
    if (value) {
      const tiles = document.querySelectorAll(".tile");
      for (let i = 0; i < tiles.length; i++) {
        if (tiles[i].getAttribute(attr) === value) paintTileFlags(tiles[i], flags);
      }
    }
    if (state.preview.open) paintPreviewFlags();
  }

  function mutexPatch(patch) {
    const next = Object.assign({}, patch);
    if (next.fav === true) next.dislike = false;
    if (next.dislike === true) next.fav = false;
    return next;
  }

  function patchFlagRecord(rec, patch) {
    const next = {
      fav: !!(rec && rec.fav),
      dislike: !!(rec && rec.dislike),
      tags: ((rec && rec.tags) || []).slice(),
    };
    if (rec && rec.lastViewedId) next.lastViewedId = rec.lastViewedId;
    if ("fav" in patch) next.fav = !!patch.fav;
    if ("dislike" in patch) next.dislike = !!patch.dislike;
    if ("tags" in patch) next.tags = (patch.tags || []).slice();
    if (next.fav) next.dislike = false;
    if (next.dislike) next.fav = false;
    return next;
  }

  function applyLocalFlags(target, patch) {
    const dest = target.kind === "item" ? target.item : target.entry;
    if (target.kind === "item") {
      const id = dest && dest.id;
      if (id) state.meta.items[id] = patchFlagRecord(state.meta.items[id], patch);
    } else {
      const key = groupKey(target.section, dest.folder || "");
      state.meta.groups[key] = patchFlagRecord(state.meta.groups[key], patch);
    }
    if ("fav" in patch) dest.fav = !!patch.fav;
    if ("dislike" in patch) dest.dislike = !!patch.dislike;
    if ("tags" in patch) dest.tags = patch.tags;
    if (dest.fav) dest.dislike = false;
    if (dest.dislike) dest.fav = false;
    return target.kind === "item"
      ? itemFlags(target.item)
      : groupFlags(target.section, target.entry.folder || "", target.entry);
  }

  async function settleFlagChange(target, flags) {
    rerenderTiles();
    resortWallSoon();
    if (catPass(flags)) {
      if (target.kind === "item") paintFlagTargets("data-asset-id", target.item.id, flags);
      else paintFlagTargets("data-group-key", groupKey(target.section, target.entry.folder || ""), flags);
      return;
    }
    await render();
    if (state.preview.open) paintPreviewFlags();
  }

  async function toggleItemFav(item) {
    const operationRoot = state.root;
    const prev = itemFlags(item);
    const patch = mutexPatch({ fav: !prev.fav });
    const flags = applyLocalFlags({ kind: "item", item: item }, patch);
    paintFlagTargets("data-asset-id", item.id, flags);
    try {
      await putMeta({
        item: Object.assign({ id: item.id, section: item.section, folder: item.folder }, patch),
        section: item.section,
        folder: item.folder,
      }, operationRoot);
    } catch (err) {
      if (!metaRootCurrent(operationRoot)) return;
      applyLocalFlags({ kind: "item", item: item }, { fav: prev.fav, dislike: prev.dislike });
      paintFlagTargets("data-asset-id", item.id, prev);
      setStatus(t("收藏没写上。"), true);
      return;
    }
    if (!metaRootCurrent(operationRoot)) return;
    await settleFlagChange({ kind: "item", item: item }, flags);
  }

  async function toggleGroupFav(section, entry) {
    const operationRoot = state.root;
    const prev = groupOwnFlags(section, entry.folder || "", entry);
    const patch = mutexPatch({ fav: !prev.fav });
    const flags = applyLocalFlags({ kind: "group", section: section, entry: entry }, patch);
    paintFlagTargets("data-group-key", groupKey(section, entry.folder || ""), flags);
    try {
      await putMeta({
        group: Object.assign(
          { key: groupKey(section, entry.folder || ""), section: section, folder: entry.folder || "" },
          patch
        ),
      }, operationRoot);
    } catch (err) {
      if (!metaRootCurrent(operationRoot)) return;
      applyLocalFlags({ kind: "group", section: section, entry: entry }, { fav: prev.fav, dislike: prev.dislike });
      paintFlagTargets("data-group-key", groupKey(section, entry.folder || ""), prev);
      setStatus(t("收藏没写上。"), true);
      return;
    }
    if (!metaRootCurrent(operationRoot)) return;
    await settleFlagChange({ kind: "group", section: section, entry: entry }, flags);
  }

  async function setFlags(target, patch, expectedRoot) {
    expectedRoot = String(expectedRoot || state.root || "");
    patch = mutexPatch(patch);
    if (target.kind === "item") {
      await putMeta({
        item: Object.assign({ id: target.item.id, section: target.item.section, folder: target.item.folder }, patch),
        section: target.item.section,
        folder: target.item.folder,
      }, expectedRoot);
    } else {
      await putMeta({
        group: Object.assign(
          { key: groupKey(target.section, target.entry.folder || ""), section: target.section, folder: target.entry.folder || "" },
          patch
        ),
      }, expectedRoot);
    }
    if (!metaRootCurrent(expectedRoot)) return;
    const flags = applyLocalFlags(target, patch);
    if (patch.tags != null || !catPass(flags)) {
      await refreshAfterChange();
      return;
    }
    await settleFlagChange(target, flags);
  }

  async function revealTarget(target) {
    const section = target.kind === "item" ? target.item.section : target.section;
    const folder = target.kind === "item" ? target.item.folder : (target.entry.folder || "");
    const file = target.kind === "item" ? target.item.file : "";
    const payload = { section: section, folder: folder };
    if (file) payload.file = file;
    const data = await api("/api/reveal", jsonOpts("POST", payload));
    if (!data || !data.ok) {
      setStatus((data && (data.path || data.error)) || t("无法打开路径。"), true);
    } else if (!data.opened) {
      setStatus(data.path || t("已定位文件。"));
    }
  }

  function describeTrashResult(data, successKey, successLabel) {
    const succeeded = (data && data[successKey]) || [];
    const conflicts = (data && data.conflicts) || [];
    const errors = (data && data.errors) || [];
    const parts = [];
    if (succeeded.length) parts.push(successLabel + t("{count} 项", {count: succeeded.length}));
    if (conflicts.length) parts.push(t("冲突 {count} 项", {count: conflicts.length}));
    if (errors.length) parts.push(t("失败 {count} 项", {count: errors.length}));
    if (!parts.length) parts.push((data && data.error) || t("没有可处理的项目"));
    return {
      line: parts.join("，"),
      failed: !data || !data.ok || errors.length + conflicts.length > 0,
      succeeded,
      conflicts,
      errors,
    };
  }

  function trashResultIds(rows) {
    return new Set((rows || []).map((row) => (typeof row === "string" ? row : row && row.id)).filter(Boolean));
  }

  function chunkIds(ids, size) {
    const out = [];
    const step = Math.max(1, size | 0);
    for (let i = 0; i < ids.length; i += step) out.push(ids.slice(i, i + step));
    return out;
  }

  function formatTrashProgress(verb, done, total) {
    return verb + " " + done + " / " + total;
  }

  function paintTrashProgress(verb, done, total) {
    const wrap = $("selProgress");
    if (!wrap) return;
    if (!total) {
      wrap.hidden = true;
      wrap.removeAttribute("aria-valuenow");
      if ($("selProgressFill")) $("selProgressFill").style.width = "0";
      if ($("selProgressText")) $("selProgressText").textContent = "";
      return;
    }
    wrap.hidden = false;
    wrap.setAttribute("role", "progressbar");
    wrap.setAttribute("aria-valuemin", "0");
    wrap.setAttribute("aria-valuemax", String(total));
    wrap.setAttribute("aria-valuenow", String(done));
    wrap.setAttribute("aria-label", formatTrashProgress(verb, done, total));
    if ($("selProgressFill")) $("selProgressFill").style.width = Math.max(0, Math.min(100, (100 * done) / total)) + "%";
    if ($("selProgressText")) $("selProgressText").textContent = formatTrashProgress(verb, done, total);
  }

  async function postTrashWrite(path, body) {
    const delays = [400, 900, 1800];
    let attempt = 0;
    while (true) {
      const data = await api(path, jsonOpts("POST", body));
      if (data && data.code === "library_busy" && attempt < delays.length) {
        setStatus(t("写入锁占用，稍后重试… ") + (attempt + 1));
        await new Promise((resolve) => setTimeout(resolve, delays[attempt]));
        attempt += 1;
        continue;
      }
      return data;
    }
  }

  async function runTrashWrite(path, ids, verb, successKey, successLabel) {
    if (!ids || !ids.length || trashBusy) return;
    trashBusy = true;
    document.body.classList.add("trash-busy");
    syncSelBar();
    const operationRoot = state.root;
    const targets = selectedTargets();
    const merged = { ok: true, [successKey]: [], conflicts: [], errors: [] };
    let done = 0;
    try {
      paintTrashProgress(verb, 0, ids.length);
      setStatus(formatTrashProgress(verb, 0, ids.length));
      for (const batch of chunkIds(ids, TRASH_WRITE_BATCH)) {
        if (state.root !== operationRoot) {
          merged.ok = false;
          merged.errors.push({ error: "root_changed" });
          setStatus(t("图库已切换，{action}已停止。", {action: verb}), true);
          break;
        }
        const data = await postTrashWrite(path, { ids: batch, expectedRoot: operationRoot });
        if (!data || !data.ok) {
          merged.ok = false;
          setStatus((data && data.error) || (verb + t("失败。")), true);
          break;
        }
        merged[successKey].push.apply(merged[successKey], data[successKey] || []);
        merged.conflicts.push.apply(merged.conflicts, data.conflicts || []);
        merged.errors.push.apply(merged.errors, data.errors || []);
        done += batch.length;
        paintTrashProgress(verb, done, ids.length);
        setStatus(formatTrashProgress(verb, done, ids.length));
      }
      if (merged[successKey].length || merged.conflicts.length || merged.errors.length) {
        const summary = describeTrashResult(merged, successKey, successLabel);
        if (merged.ok || merged[successKey].length) setStatus(summary.line, summary.failed);
        keepFailedTrashSelection(targets, summary);
      }
      await refreshAfterChange();
    } finally {
      trashBusy = false;
      document.body.classList.remove("trash-busy");
      paintTrashProgress("", 0, 0);
      syncSelBar();
    }
  }

  function keepFailedTrashSelection(targets, summary) {
    const succeeded = trashResultIds(summary.succeeded);
    if (!summary.failed) {
      setSelectMode(false);
      return;
    }
    const next = new Map();
    (targets || []).forEach((target) => {
      const id = (target.kind === "item" || target.kind === "trash")
        ? target.item && target.item.id
        : "";
      if (id && succeeded.has(id)) return;
      next.set(selKeyOf(target), target);
    });
    if (!next.size) {
      setSelectMode(false);
      return;
    }
    state.select.on = true;
    state.select.picked = next;
    document.body.classList.add("selecting");
    $("selectBtn").classList.add("active");
    syncSelBar();
    rerenderTiles();
  }

  async function deleteTarget(target) {
    const operationRoot = state.root;
    let body;
    if (target.kind === "item") {
      body = {
        section: target.item.section,
        folder: target.item.folder,
        ids: [target.item.id],
        expectedRoot: operationRoot,
      };
    } else {
      body = {
        section: target.section,
        folder: target.entry.folder || "",
        expectedRoot: operationRoot,
      };
    }
    // Optimistic: the card goes now, the library reload only confirms it.
    if (target.kind === "item") dropItemsFromWall([target.item.id]);
    else dropGroupsFromWall(target.section, [target.entry.folder || ""]);
    const data = await api("/api/trash", jsonOpts("POST", body));
    const summary = describeTrashResult(data, "moved", t("已移到回收站："));
    setStatus(summary.line, summary.failed);
    if (state.lightbox.open) closeLightbox();
    await refreshAfterChange();
  }

  async function deleteSelection() {
    const operationRoot = state.root;
    const targets = selectedTargets();
    if (!targets.length) return;
    const byFolder = new Map();
    const groups = [];
    const itemIds = [];
    const wholeGroups = [];
    targets.forEach((target) => {
      if (target.kind === "item") {
        const key = (target.item.section || "") + "/" + (target.item.folder || "");
        if (!byFolder.has(key)) {
          byFolder.set(key, { section: target.item.section, folder: target.item.folder || "", ids: [] });
        }
        byFolder.get(key).ids.push(target.item.id);
        itemIds.push(target.item.id);
      } else if (target.kind === "group") {
        groups.push({ section: target.section, folder: (target.entry && target.entry.folder) || "" });
        wholeGroups.push({ section: target.section, folder: (target.entry && target.entry.folder) || "" });
      }
    });
    byFolder.forEach((row) => groups.push(row));
    if (!groups.length) return;
    if (!window.confirm(t("把选中的 {count} 项移到回收站？", {count: targets.length}))) return;
    if (itemIds.length) dropItemsFromWall(itemIds);
    wholeGroups.forEach((row) => dropGroupsFromWall(row.section, [row.folder]));
    const data = await api("/api/trash", jsonOpts("POST", {
      groups: groups,
      expectedRoot: operationRoot,
    }));
    const summary = describeTrashResult(data, "moved", t("已移到回收站："));
    setStatus(summary.line, summary.failed);
    keepFailedTrashSelection(targets, summary);
    await refreshAfterChange();
  }

  function selectedTrashIds() {
    return selectedTargets()
      .filter((target) => target.kind === "trash" && !target.item.legacy)
      .map((target) => target.item.id)
      .filter(Boolean);
  }

  async function restoreIds(ids) {
    await runTrashWrite("/api/trash/restore", ids, t("正在恢复"), "restored", t("已恢复："));
  }

  async function purgeIds(ids) {
    if (!ids || !ids.length || trashBusy) return;
    if (!window.confirm(t("彻底删除 {count} 项后无法从回收站恢复（墓碑会保留以免重新下载）。确定？", {count: ids.length}))) return;
    await runTrashWrite("/api/trash/purge", ids, t("正在彻底删除"), "purged", t("已彻底删除："));
  }

  /* B. one meta write for the whole selection. */
  async function tagSelection(tag) {
    const operationRoot = state.root;
    const name = String(tag || "").trim();
    const targets = selectedTargets();
    if (!name || !targets.length) return;
    const payload = { addTag: name, itemPatches: [], groupPatches: [] };
    const local = [];
    targets.forEach((target) => {
      const dest = target.kind === "item" ? target.item : target.entry;
      if (!dest) return;
      const tags = (target.kind === "item"
        ? itemFlags(target.item).tags
        : groupOwnFlags(target.section, dest.folder || "", dest).tags).slice();
      if (tags.indexOf(name) < 0) tags.push(name);
      local.push({ dest: dest, tags: tags });
      if (target.kind === "item") {
        payload.itemPatches.push({
          id: target.item.id,
          section: target.item.section,
          folder: target.item.folder,
          tags: tags,
        });
      } else {
        payload.groupPatches.push({ section: target.section, folder: dest.folder || "", tags: tags });
      }
    });
    if (!payload.itemPatches.length && !payload.groupPatches.length) return;
    const count = targets.length;
    try {
      await putMeta(payload, operationRoot);
    } catch (err) {
      setStatus(t("标签没写上。"), true);
      return;
    }
    if (!metaRootCurrent(operationRoot)) return;
    local.forEach((row) => {
      row.dest.tags = row.tags;
    });
    // The picks stay: tagging is often two labels in a row, or tag then delete.
    setStatus(t("已打标签「{tag}」· {count} 项", {tag: name, count: count}));
    await render({ keepScroll: true });
  }

  /* Selection bar 从标签移除 — same one-write shape as tagSelection. */
  async function untagSelection(tag) {
    const operationRoot = state.root;
    const name = String(tag || "").trim();
    const targets = selectedTargets();
    if (!name || !targets.length) return;
    const payload = { itemPatches: [], groupPatches: [] };
    const local = [];
    targets.forEach((target) => {
      const dest = target.kind === "item" ? target.item : target.entry;
      if (!dest) return;
      const tags = (target.kind === "item"
        ? itemFlags(target.item).tags
        : groupOwnFlags(target.section, dest.folder || "", dest).tags).slice();
      const i = tags.indexOf(name);
      if (i < 0) return;
      tags.splice(i, 1);
      local.push({ dest: dest, tags: tags });
      if (target.kind === "item") {
        payload.itemPatches.push({
          id: target.item.id,
          section: target.item.section,
          folder: target.item.folder,
          tags: tags,
        });
      } else {
        payload.groupPatches.push({ section: target.section, folder: dest.folder || "", tags: tags });
      }
    });
    if (!payload.itemPatches.length && !payload.groupPatches.length) {
      setStatus(t("选中的项都没有「{tag}」标签。", {tag: name}));
      return;
    }
    const count = payload.itemPatches.length + payload.groupPatches.length;
    try {
      await putMeta(payload, operationRoot);
    } catch (err) {
      setStatus(t("标签没移除。"), true);
      return;
    }
    if (!metaRootCurrent(operationRoot)) return;
    local.forEach((row) => {
      row.dest.tags = row.tags;
    });
    setStatus(t("已从「{tag}」移除 {count} 项", {tag: name, count: count}));
    await render({ keepScroll: true });
  }

  function closeCtx() {
    const menu = $("ctxMenu");
    menu.hidden = true;
    menu.replaceChildren();
    state.ctx = null;
  }

  function openCtx(ev, target) {
    stopHoverVideo();
    ev.preventDefault();
    ev.stopPropagation();
    const flags = target.kind === "item"
      ? itemFlags(target.item)
      : groupOwnFlags(target.section, target.entry.folder || "", target.entry);
    state.ctx = target;
    const menu = $("ctxMenu");
    menu.replaceChildren();
    const add = (label, handler, cls) => {
      menu.appendChild(el("button", {
        type: "button",
        class: cls || "",
        text: label,
        onclick: async (clickEv) => {
          clickEv.stopPropagation();
          closeCtx();
          await handler();
        },
      }));
    };
    add(flags.fav ? t("取消收藏") : t("添加到收藏"), () => (
      target.kind === "item" ? toggleItemFav(target.item) : toggleGroupFav(target.section, target.entry)
    ));
    add(flags.dislike ? t("取消不喜欢") : t("不喜欢"), () => setFlags(target, { dislike: !flags.dislike }));
    menu.appendChild(el("div", { class: "hint", text: t("添加标签") }));
    const sub = el("div", { class: "sub" });
    (state.meta.tags || ["ACG"]).forEach((tag) => {
      const has = (flags.tags || []).indexOf(tag) >= 0;
      sub.appendChild(el("button", {
        type: "button",
        text: (has ? "✓ " : "") + tag,
        onclick: async (clickEv) => {
          clickEv.stopPropagation();
          const next = (flags.tags || []).slice();
          const i = next.indexOf(tag);
          if (i >= 0) next.splice(i, 1);
          else next.push(tag);
          closeCtx();
          await setFlags(target, { tags: next });
        },
      }));
    });
    menu.appendChild(sub);
    add(t("自定义标签"), () => openTagDialog(target));
    add(t("在资源管理器打开"), () => revealTarget(target));
    add(t("删除"), () => deleteTarget(target), "danger");
    menu.hidden = false;
    const x = Math.min(ev.clientX, window.innerWidth - 220);
    const y = Math.min(ev.clientY, window.innerHeight - 12);
    menu.style.left = x + "px";
    menu.style.top = y + "px";
  }

  function openTagDialog(target) {
    const entry = target && (target.item || target.entry);
    if (state.metaKnown === false || (entry && entry.metadataKnown === false)) { setStatus(t("元数据无法核验，已暂停编辑；请修复后刷新。"), true); return; }
    state.tagTarget = target;
    state.tagTargetRoot = state.root;
    $("tagDialog").hidden = false;
    document.body.classList.add("modal-open");
    $("tagDialogTitle").textContent = target && target.kind === "tagOnly" ? t("新建标签") : t("自定义标签");
    $("tagDialogOk").textContent = target && target.kind === "tagOnly" ? t("添加") : t("添加并打上");
    $("tagDialogInput").value = "";
    $("tagDialogInput").focus();
  }

  function closeTagDialog() {
    $("tagDialog").hidden = true;
    state.tagTarget = null;
    state.tagTargetRoot = "";
    if ($("lightbox").hidden && $("browser").hidden) document.body.classList.remove("modal-open");
  }

  async function confirmTagDialog() {
    const name = $("tagDialogInput").value.trim();
    const target = state.tagTarget;
    const operationRoot = state.tagTargetRoot;
    closeTagDialog();
    if (!name || !target || !operationRoot || !metaRootCurrent(operationRoot)) return;
    if (target.kind === "tagOnly") {
      // 新建标签 from the … pill: add to the list, become a pill, tag nothing.
      try {
        await putMeta({ addTag: name }, operationRoot);
      } catch (err) {
        setStatus(t("标签没写上。"), true);
        return;
      }
      if (!metaRootCurrent(operationRoot)) return;
      syncNav();
      return;
    }
    if (target.kind === "selection") {
      await tagSelection(name);
      return;
    }
    const flags = target.kind === "item"
      ? itemFlags(target.item)
      : groupOwnFlags(target.section, target.entry.folder || "", target.entry);
    const tags = flags.tags.slice();
    if (tags.indexOf(name) < 0) tags.push(name);
    const payload = { addTag: name };
    if (target.kind === "item") {
      payload.item = {
        id: target.item.id,
        section: target.item.section,
        folder: target.item.folder,
        tags: tags,
      };
    } else {
      payload.group = {
        key: groupKey(target.section, target.entry.folder || ""),
        section: target.section,
        folder: target.entry.folder || "",
        tags: tags,
      };
    }
    try {
      await putMeta(payload, operationRoot);
    } catch (err) {
      setStatus(t("标签没写上；若另一窗口刚改过，请再试一次。"), true);
      return;
    }
    if (!metaRootCurrent(operationRoot)) return;
    syncNav();
    await refreshAfterChange();
  }

  function paintCatMenu() {
    // Lives inside the dynamically painted … pill, so it may not exist yet.
    const menu = $("catMenu");
    if (!menu || menu.hidden) return;
    const prefs = currentView();
    const mode = catsMode(prefs.cats);
    const chosen = new Set(prefs.cats || []);
    const options = ["default", "all", "fav", "dislike"].concat(state.meta.tags || []).concat(["ungrouped"]);
    const labels = { default: t("默认"), all: t("全部"), fav: t("收藏"), dislike: t("不喜欢"), ungrouped: t("未分组") };
    menu.replaceChildren();
    options.forEach((key) => {
      const box = el("input", { type: "checkbox" });
      if (key === "default") box.checked = mode === "default";
      else if (key === "all") box.checked = mode === "all";
      else box.checked = mode === "filter" && chosen.has(key);
      box.addEventListener("change", async () => {
        const view = currentView();
        if (key === "default") {
          view.cats = [];
        } else if (key === "all") {
          view.cats = box.checked ? ["all"] : [];
        } else {
          let next = (view.cats || []).filter((cat) => cat !== "default" && cat !== "all");
          if (box.checked) {
            if (next.indexOf(key) < 0) next.push(key);
            if (key === "fav") next = next.filter((cat) => cat !== "dislike");
            if (key === "dislike") next = next.filter((cat) => cat !== "fav");
          } else {
            next = next.filter((cat) => cat !== key);
          }
          view.cats = next;
        }
        syncNav();
        saveViews();
        render();
      });
      menu.appendChild(el("label", {
        // Keep the menu open across checkbox toggles (repaint detaches the
        // clicked node, which the outside-click closer reads as "outside").
        onclick: (ev) => ev.stopPropagation(),
      }, [box, document.createTextNode(labels[key] || key)]));
    });
    menu.appendChild(el("div", { class: "menu-sep" }));
    menu.appendChild(el("button", {
      type: "button",
      class: "menu-item",
      text: t("新建标签…"),
      onclick: (ev) => {
        ev.stopPropagation();
        menu.hidden = true;
        openTagDialog({ kind: "tagOnly" });
      },
    }));
  }

  function paintSelTagMenu() {
    const menu = $("selTagMenu");
    if (!menu || menu.hidden) return;
    menu.replaceChildren();
    menu.appendChild(el("div", { class: "hint", text: t("打到选中的 {count} 项", {count: state.select.picked.size}) }));
    (state.meta.tags || ["ACG"]).forEach((tag) => {
      menu.appendChild(
        el("button", {
          type: "button",
          text: tag,
          onclick: async (ev) => {
            ev.stopPropagation();
            menu.hidden = true;
            await tagSelection(tag);
          },
        })
      );
    });
    menu.appendChild(
      el("button", {
        type: "button",
        text: t("自定义标签…"),
        onclick: (ev) => {
          ev.stopPropagation();
          menu.hidden = true;
          openTagDialog({ kind: "selection" });
        },
      })
    );
  }

  function paintSelUntagMenu() {
    const menu = $("selUntagMenu");
    if (!menu || menu.hidden) return;
    menu.replaceChildren();
    // Offer only tags actually present on the picked rows.
    const present = new Set();
    selectedTargets().forEach((target) => {
      const flags = target.kind === "item"
        ? itemFlags(target.item)
        : target.kind === "group"
          ? groupFlags(target.section, (target.entry && target.entry.folder) || "", target.entry)
          : null;
      ((flags && flags.tags) || []).forEach((tag) => present.add(tag));
    });
    if (!present.size) {
      menu.appendChild(el("div", { class: "hint", text: t("选中的项没有标签。") }));
      return;
    }
    menu.appendChild(el("div", { class: "hint", text: t("从选中的 {count} 项移除", {count: state.select.picked.size}) }));
    Array.from(present).sort().forEach((tag) => {
      menu.appendChild(
        el("button", {
          type: "button",
          text: tag,
          onclick: async (ev) => {
            ev.stopPropagation();
            menu.hidden = true;
            await untagSelection(tag);
          },
        })
      );
    });
  }

  async function openBrowser(start = "") {
    $("browser").hidden = false;
    document.body.classList.add("modal-open");
    paintBrowserPlaces();
    await refreshBrowser(start);
  }

  function closeBrowser() {
    clearBrowserAddressTimer();
    state.browseGeneration++;
    state.browseSelectable = false;
    setBrowserPlacesOpen(false);
    $("browser").hidden = true;
    if (!state.lightbox.open) document.body.classList.remove("modal-open");
  }

  function browserCanUse() {
    return !$("browser").hidden && !state.browseLoading && state.browseSelectable
      && !!state.browsePath && $("browserPath").value === state.browsePath;
  }

  function paintBrowserActions() {
    const usable = browserCanUse();
    $("browserUse").disabled = !usable;
    $("browserCreate").disabled = !usable;
    $("browserNewName").disabled = !usable;
    $("browserUp").disabled = !usable || state.browseParent == null;
  }

  function clearBrowserAddressTimer() {
    if (state.browseAddressTimer) clearTimeout(state.browseAddressTimer);
    state.browseAddressTimer = 0;
  }

  function paintBrowserAddressStatus(kind = "", detail = "") {
    const status = $("browserError");
    status.hidden = !kind;
    status.dataset.state = kind;
    status.textContent = kind === "invalid" ? t("地址无效") : (kind === "checking" ? t("检测中…") : "");
    status.title = translate(detail || "");
  }

  function setBrowserPlacesOpen(open) {
    $("browserPlacesMenu").hidden = !open;
    $("browserPlacesBtn").setAttribute("aria-expanded", open ? "true" : "false");
  }

  function paintBrowserPlaces() {
    const menu = $("browserPlacesMenu");
    menu.replaceChildren();
    const rows = [{ name: t("此电脑"), path: "" }].concat(state.browsePlaces || []);
    rows.forEach((place) => {
      if (!place || typeof place.name !== "string" || typeof place.path !== "string") return;
      menu.appendChild(el("button", {
        type: "button", role: "menuitem", text: t(place.name), title: place.path || t("此电脑"),
        onclick: () => {
          setBrowserPlacesOpen(false);
          void refreshBrowser(place.path);
        },
      }));
    });
  }

  function editBrowserAddress(ev) {
    // An edited address invalidates even an already pending directory reply.
    clearBrowserAddressTimer();
    state.browseGeneration++;
    state.browseLoading = false;
    state.browseSelectable = false;
    $("browserMarkers").hidden = true;
    paintBrowserAddressStatus("checking");
    paintBrowserActions();
    if (ev && ev.isComposing) return;
    const path = $("browserPath").value.trim();
    state.browseAddressTimer = setTimeout(() => {
      state.browseAddressTimer = 0;
      void refreshBrowser(path);
    }, 360);
  }

  function submitBrowserAddress() {
    clearBrowserAddressTimer();
    void refreshBrowser($("browserPath").value.trim());
  }

  async function refreshBrowser(path = state.browsePath) {
    clearBrowserAddressTimer();
    const generation = ++state.browseGeneration;
    state.browseLoading = true;
    state.browseSelectable = false;
    $("browserPath").value = path;
    const markers = $("browserMarkers");
    const list = $("browserList");
    list.replaceChildren();
    markers.hidden = true;
    paintBrowserAddressStatus(path ? "checking" : "");
    paintBrowserActions();
    let data;
    try {
      data = await api("/api/browse?path=" + encodeURIComponent(path));
    } catch (_) {
      data = { ok: false, error: t("无法浏览目录，请检查路径或连接后重试。") };
    }
    if (generation !== state.browseGeneration || $("browser").hidden) return;
    state.browseLoading = false;
    if (!data || !data.ok) {
      paintBrowserAddressStatus("invalid", (data && data.error) || t("无法浏览目录。"));
      paintBrowserActions();
      return;
    }
    state.browsePath = data.path;
    state.browseParent = data.parent;
    state.browseSelectable = data.selectable === true && data.kind !== "computer";
    if (Array.isArray(data.places)) {
      state.browsePlaces = data.places;
      paintBrowserPlaces();
    }
    $("browserPath").value = data.path;
    paintBrowserAddressStatus();
    paintBrowserActions();
    if (data.markers && data.markers.length) {
      markers.hidden = false;
      markers.textContent = t("可识别：") + data.markers.join(" · ");
    } else {
      markers.hidden = true;
      markers.textContent = "";
    }
    (data.dirs || []).forEach((dir) => {
      list.appendChild(
        el("li", {}, [el("button", {
          type: "button", text: dir.name,
          onclick: () => void refreshBrowser(dir.path),
        })])
      );
    });
    if (!(data.dirs || []).length && !data.error) {
      list.appendChild(el("li", { text: data.kind === "computer" ? t("未找到磁盘，可在地址栏输入完整路径。") : t("（没有子目录）") }));
    }
  }

  function bind() {
    window.addEventListener("blur", stopHoverVideo);
    document.addEventListener("visibilitychange", () => { if (document.hidden) stopHoverVideo(); });
    bindPlusMenu();
    bindLoopLayout();
    $("modeGrok").addEventListener("click", () => setMode("grok"));
    $("modeGallery").addEventListener("click", () => setMode("gallery"));
    if ($("grokGuestOpen")) {
      $("grokGuestOpen").addEventListener("click", () => {
        if (tauriGrokLocked()) {
          setStatus(t("下载期间不能重开 Grok 页面，请先停止下载。"), true);
          return;
        }
        if (window.viewer && window.viewer.reopenGrok) {
          window.viewer.reopenGrok().then(paintGrokGuest).catch((err) => {
            setStatus(String((err && err.message) || err || t("无法重开 Grok。")), true);
          });
        }
        else setMode("grok", true);
      });
    }
    $("viewBtn").addEventListener("click", (ev) => {
      ev.stopPropagation();
      const menu = $("viewMenu");
      closeNavMenus("viewMenu");
      menu.hidden = !menu.hidden;
      $("viewBtn").setAttribute("aria-expanded", menu.hidden ? "false" : "true");
      if (!menu.hidden) paintViewMenu();
    });
    $("searchBtn").appendChild(searchSvg());
    $("searchBtn").addEventListener("click", (ev) => {
      ev.stopPropagation();
      if ($("searchWrap").classList.contains("open") && !$("searchInput").value) closeSearch(false);
      else openSearch();
    });
    // mousedown, or the input's blur swallows the click.
    $("searchClear").addEventListener("mousedown", (ev) => ev.preventDefault());
    $("searchClear").addEventListener("click", (ev) => {
      ev.stopPropagation();
      const input = $("searchInput");
      input.value = "";
      state.query = "";
      $("searchClear").hidden = true;
      input.focus();
      render();
    });
    $("searchInput").addEventListener("blur", () => {
      if (!$("searchInput").value) closeSearch(false);
    });
    $("searchInput").addEventListener("keydown", (ev) => {
      if (ev.key === "Escape") {
        ev.preventDefault();
        ev.stopPropagation();
        closeSearch(true);
      }
    });
    $("dlBtn").addEventListener("click", () => {
      if (dlBusy) stopDownload();
      else startDownload();
    });
    $("downloadHistoryBtn").addEventListener("click", async () => {
      if (!window.GivDownloadHistory) {
        setStatus(t("下载历史需要使用 Go 桌面版本。"), true);
        return;
      }
      if (state.mode === "grok" && !await setMode("gallery")) return;
      updateDownloadHistory();
      window.GivDownloadHistory.open();
    });
    $("volBtn").addEventListener("click", () => {
      setVolume({ muted: !state.volume.muted });
    });
    $("browserCreate").addEventListener("click", () => {
      createLibraryHere();
    });
    $("browserNewName").addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") {
        ev.preventDefault();
        createLibraryHere();
      }
    });
    $("selectBtn").addEventListener("click", () => {
      setSelectMode(!state.select.on);
    });
    $("selDone").addEventListener("click", () => setSelectMode(false));
    $("selAll").addEventListener("click", () => {
      const items = state.wallItems || [];
      const trashView = state.view === "trash";
      const section = state.wallSection;
      items.forEach((row) => {
        if (trashView) { if (!row.legacy) state.select.picked.set("t:" + (row.id || ""), { kind: "trash", item: row }); }
        else if (state.view === "flat") state.select.picked.set("i:" + (row.id || row.file || ""), { kind: "item", item: row });
        else state.select.picked.set("g:" + groupKey(section, row.folder || ""), { kind: "group", section: section, entry: row });
      });
      if (!state.select.on) setSelectMode(true);
      else {
        syncSelBar();
        syncSelectionTiles();
      }
    });
    $("selDelete").addEventListener("click", () => deleteSelection());
    $("selRestore").addEventListener("click", () => restoreIds(selectedTrashIds()));
    $("selPurge").addEventListener("click", () => purgeIds(selectedTrashIds()));
    $("selTag").addEventListener("click", (ev) => {
      ev.stopPropagation();
      const menu = $("selTagMenu");
      closeNavMenus("selTagMenu");
      menu.hidden = !menu.hidden;
      if (!menu.hidden) paintSelTagMenu();
    });
    $("selUntag").addEventListener("click", (ev) => {
      ev.stopPropagation();
      const menu = $("selUntagMenu");
      closeNavMenus("selUntagMenu");
      menu.hidden = !menu.hidden;
      if (!menu.hidden) paintSelUntagMenu();
    });
    $("launcherOpen").addEventListener("click", () => {
      openLibraryFlow();
    });
    $("launcherHistoryClear").addEventListener("click", () => void clearLibraryHistory());
    let searchTimer = 0;
    $("searchInput").addEventListener("input", () => {
      state.query = $("searchInput").value;
      $("searchClear").hidden = !state.query;
      clearTimeout(searchTimer);
      searchTimer = setTimeout(render, 160);
    });
    $("browserClose").addEventListener("click", closeBrowser);
    $("browserPlaces").addEventListener("pointerenter", (ev) => {
      if (ev.pointerType !== "touch") setBrowserPlacesOpen(true);
    });
    $("browserPlaces").addEventListener("pointerleave", () => setBrowserPlacesOpen(false));
    $("browserPlaces").addEventListener("focusin", () => setBrowserPlacesOpen(true));
    $("browserPlaces").addEventListener("focusout", (ev) => {
      if (!$("browserPlaces").contains(ev.relatedTarget)) setBrowserPlacesOpen(false);
    });
    $("browserPlacesBtn").addEventListener("click", (ev) => {
      ev.stopPropagation();
      setBrowserPlacesOpen(true);
    });
    $("browserPath").addEventListener("input", editBrowserAddress);
    $("browserPath").addEventListener("compositionend", editBrowserAddress);
    $("browserPath").addEventListener("keydown", (ev) => {
      if (ev.key === "Enter" && !ev.isComposing) {
        ev.preventDefault();
        submitBrowserAddress();
      }
    });
    $("browserUp").addEventListener("click", () => {
      if (!state.browseLoading && state.browseParent != null) void refreshBrowser(state.browseParent);
    });
    $("browserUse").addEventListener("click", async () => {
      if (!browserCanUse()) return;
      const path = state.browsePath;
      closeBrowser();
      if (path) await openLibraryPath(path);
    });
    $("tagDialogClose").addEventListener("click", closeTagDialog);
    $("tagDialogOk").addEventListener("click", confirmTagDialog);
    $("tagDialogInput").addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") {
        ev.preventDefault();
        confirmTagDialog();
      }
    });
    $("cpBack").addEventListener("click", closeComboPreview);
    $("cpCopy").addEventListener("click", async () => {
      const item = state.preview.items[state.preview.index];
      const text = (item && item.prompt) || "";
      try {
        await navigator.clipboard.writeText(text);
        $("cpCopy").textContent = t("已复制");
      } catch (err) {
        $("cpCopy").textContent = t("复制失败");
      }
    });
    $("cpHeart").appendChild(heartSvg(false));
    $("cpHeart").addEventListener("click", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      const item = currentPreviewItem();
      if (item) toggleItemFav(item);
    });
    $("cpDislike").addEventListener("click", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      const item = currentPreviewItem();
      if (!item) return;
      setFlags({ kind: "item", item: item }, { dislike: !itemFlags(item).dislike });
    });
    $("cpPrevCombo").addEventListener("click", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      if (!$("cpPrevCombo").disabled) stepCombo(-1);
    });
    $("cpNextCombo").addEventListener("click", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      if (!$("cpNextCombo").disabled) stepCombo(1);
    });
    $("cpRes").addEventListener("click", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      const menu = $("cpResMenu");
      if (!menu || $("cpResWrap").hidden) return;
      menu.hidden = !menu.hidden;
      $("cpRes").setAttribute("aria-expanded", menu.hidden ? "false" : "true");
    });
    $("cpUp").addEventListener("click", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      stepPreview(-1);
    });
    $("cpDown").addEventListener("click", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      stepPreview(1);
    });
    document.addEventListener("click", (ev) => {
      if (!ev.target.closest("#cpResWrap")) closeResolutionMenu();
    });
    $("cpLoopA").addEventListener("click", (ev) => {
      ev.stopPropagation();
      setLoopPoint("a");
    });
    $("cpLoopB").addEventListener("click", (ev) => {
      ev.stopPropagation();
      setLoopPoint("b");
    });
    $("cpLoopOn").addEventListener("click", (ev) => {
      ev.stopPropagation();
      onLoopIconClick();
    });
    $("cpVideo").addEventListener("timeupdate", () => {
      onLoopTick();
      paintScrub();
    });
    $("cpVideo").addEventListener("ended", onLoopEnded);
    $("cpVideo").addEventListener("seeked", () => {
      loopSeeking = false;
      paintScrub();
    });
    $("cpVideo").addEventListener("play", paintScrub);
    $("cpVideo").addEventListener("pause", paintScrub);
    $("cpVideo").addEventListener("click", (ev) => {
      ev.stopPropagation();
      togglePreviewPlay();
    });
    $("cpPlay").addEventListener("click", (ev) => {
      ev.stopPropagation();
      togglePreviewPlay();
    });
    $("cpMute").addEventListener("click", (ev) => {
      ev.stopPropagation();
      const video = $("cpVideo");
      if (!video) return;
      setVolume({muted: !state.volume.muted});
      paintScrub();
    });
    $("cpFs").addEventListener("click", (ev) => {
      ev.stopPropagation();
      const stage = $("cpStage");
      if (!stage) return;
      if (document.fullscreenElement) document.exitFullscreen();
      else if (stage.requestFullscreen) stage.requestFullscreen();
    });
    $("cpSeek").addEventListener("input", (ev) => {
      const video = $("cpVideo");
      const dur = videoDuration();
      if (!video || !(dur > 0)) return;
      video.currentTime = (Number(ev.target.value) / 1000) * dur;
      paintScrub();
    });
    $("cpScrubWrap").addEventListener("click", (ev) => ev.stopPropagation());
    const previewCtx = (ev) => {
      const item = currentPreviewItem();
      if (!item) return;
      openCtx(ev, { kind: "item", item: item });
    };
    $("cpStage").addEventListener("contextmenu", previewCtx);
    $("cpSide").addEventListener("contextmenu", previewCtx);
    $("lbClose").addEventListener("click", closeLightbox);
    $("lbPrev").addEventListener("click", () => stepLightbox(-1));
    $("lbNext").addEventListener("click", () => stepLightbox(1));
    $("lbCopy").addEventListener("click", async () => {
      const item = state.lightbox.items[state.lightbox.index];
      const text = (item && item.prompt) || "";
      try {
        await navigator.clipboard.writeText(text);
        $("lbCopy").textContent = t("已复制");
      } catch (err) {
        $("lbCopy").textContent = t("复制失败");
      }
    });
    $("browser").addEventListener("click", (ev) => {
      if (ev.target.id === "browser") closeBrowser();
    });
    $("tagDialog").addEventListener("click", (ev) => {
      if (ev.target.id === "tagDialog") closeTagDialog();
    });
    document.addEventListener("click", (ev) => {
      // Close every popup whose own wrap was not clicked.
      ["plusMenu", "viewMenu", "catMenu", "selTagMenu", "selUntagMenu"].forEach((id) => {
        const menu = $(id);
        if (!menu || menu.hidden) return;
        const wrap = menu.closest(".cat-wrap");
        if (wrap && wrap.contains(ev.target)) return;
        menu.hidden = true;
      });
      $("plusBtn").setAttribute("aria-expanded", $("plusMenu").hidden ? "false" : "true");
      $("viewBtn").setAttribute("aria-expanded", $("viewMenu").hidden ? "false" : "true");
      if (!$("ctxMenu").hidden && !ev.target.closest("#ctxMenu")) closeCtx();
    });
    document.addEventListener("contextmenu", (ev) => {
      if (ev.target.closest(".tile") || ev.target.closest(".cp-thumb") || ev.target.closest("#cpStage") || ev.target.closest("#cpSide")) return;
      closeCtx();
    });
    document.addEventListener("keydown", (ev) => {
      if (document.querySelector("dialog[open]")) return;
      if (ev.key === "Escape") {
        if (!$("ctxMenu").hidden) {
          closeCtx();
          return;
        }
        if (anyNavMenuOpen()) {
          closeNavMenus("");
          return;
        }
        if (!$("tagDialog").hidden) {
          closeTagDialog();
          return;
        }
        if (state.select.on && !state.preview.open) {
          setSelectMode(false);
          return;
        }
        if (state.preview.open) {
          closeComboPreview();
          return;
        }
        if (state.lightbox.open) closeLightbox();
        else if (!$("browser").hidden) closeBrowser();
        return;
      }
      if (!$("tagDialog").hidden) return;
      // Preview keys are claimed in the capture phase, see previewKeys below.
      if (state.preview.open) return;
      if (!state.lightbox.open) return;
      if (ev.key === "ArrowLeft") stepLightbox(-1);
      if (ev.key === "ArrowRight") stepLightbox(1);
    });
    // B3: the stage runs a real <video controls>, and once those controls have
    // focus the browser turns the arrow keys into a seek / volume change of its
    // own. Bubbling listeners never get a say, so the preview takes the keys on
    // the way down and stops them there.
    window.addEventListener("keydown", previewKeys, true);
  }

  function typingTarget(node) {
    if (!node) return false;
    const tag = String(node.tagName || "").toLowerCase();
    if (tag === "input" || tag === "textarea" || tag === "select") return true;
    return !!node.isContentEditable;
  }

  function previewKeys(ev) {
    if (typeof playerUI !== "undefined" && playerUI) { playerUI.handleKey(ev); return; }
    if (!state.preview.open || ev.defaultPrevented) return;
    if (ev.metaKey || ev.altKey) return;
    if (ev.isComposing) return;
    const slider = ev.target && ev.target.id === "cpSeek" && ev.target.type === "range";
    if (typingTarget(ev.target) && !(slider && ["[", "]", "\\", "l", "L"].includes(ev.key))) return;
    if (ev.ctrlKey) {
      if (ev.key === "ArrowLeft") stepCombo(-1);
      else if (ev.key === "ArrowRight") stepCombo(1);
      else return;
      ev.preventDefault();
      ev.stopPropagation();
      return;
    }
    switch (ev.key) {
      case "ArrowUp":
        stepPreview(-1);
        break;
      case "ArrowDown":
        stepPreview(1);
        break;
      case "ArrowLeft":
        seekPreview(ev.shiftKey ? -3 : -1.5);
        break;
      case "ArrowRight":
        seekPreview(ev.shiftKey ? 3 : 1.5);
        break;
      case "d":
      case "D":
        stepPreviewFrame(-1);
        break;
      case "f":
      case "F":
        stepPreviewFrame(1);
        break;
      case "[":
        setLoopPoint("a");
        break;
      case "]":
        setLoopPoint("b");
        break;
      case "\\":
        clearAbLoop();
        break;
      case "l":
      case "L":
        onLoopIconClick();
        break;
      case " ":
        togglePreviewPlay();
        break;
      default:
        return;
    }
    ev.preventDefault();
    ev.stopPropagation();
  }

  async function init() {
    window.GivI18n.apply();
    bind();
    if (window.GivEnvironment) window.GivEnvironment.create({api, bridge: window.viewer});
    if (window.GivPlayer) {
      playerUI = window.GivPlayer.create({
        api: api, status: setStatus, volume: () => state.volume,
        setVolume: patch => { setVolume(patch); paintScrub(); },
        item: currentPreviewItem, previewOpen: () => state.preview.open,
        mode: () => state.mode, root: () => state.root,
        downloadBusy: () => dlBusy || dlStopping, downloadRun: () => dlRunSeen,
        flags: itemFlags, tags: () => state.meta.tags || [],
        setTags: (item, tags, root) => setFlags({kind: "item", item: item}, {tags: tags}, root),
        newTag: item => openTagDialog({kind: "item", item: item}),
        deleteItem: item => deleteTarget({kind: "item", item: item}),
        remoteOpened: () => { hideComboPreview(); void setMode("grok"); },
        accelChanged: data => { state.accel = data; paintAccelMenu(); },
        reloadLibrary: () => hardReloadLibrary(),
        languageChanged: () => {
          syncNav(); paintViewMenu(); paintPlusMenu(); paintCatMenu(); syncSelBar();
          if (state.launcher) paintHistory();
          for (const id of ["status", "launcherError", "browserError", "loadingText"]) {
            const node = $(id); if (node) node.textContent = translate(node.textContent);
          }
          for (const node of document.querySelectorAll("#main > .empty")) node.textContent = translate(node.textContent);
          if (state.library && state.library.ok) {
            // Remount only wall cards; leave the active media element untouched.
            if (state.grid && state.grid.refresh) state.grid.refresh();
          }
          if (state.preview.open) {
            paintPreviewFlags(); paintResolutionButton(); paintScrub(); paintLoopBar();
          }
          paintDlProgress();
          if (dlBusy) setStatus(formatDlStatus());
          reportChromeHeight();
        },
        actions: {
          previousItem: () => stepPreview(-1), nextItem: () => stepPreview(1),
          previousGroup: () => void stepCombo(-1), nextGroup: () => void stepCombo(1),
          seekBack: () => seekPreview(-1.5), seekForward: () => seekPreview(1.5),
          seekBackFar: () => seekPreview(-3), seekForwardFar: () => seekPreview(3),
          previousFrame: () => stepPreviewFrame(-1), nextFrame: () => stepPreviewFrame(1),
          setA: () => setLoopPoint("a"), setB: () => setLoopPoint("b"), clearAB: clearAbLoop,
          loop: onLoopIconClick, play: togglePreviewPlay
        }
      });
    }
    if (window.viewer) {
      if (window.viewer.onDownloadStatus) {
        // Exporter progress lines (assets / missing / done), never cookies.
        window.viewer.onDownloadStatus((text) => {
          if (text) applyDownloadStatus(text);
        });
      }
      // The grok view sits below the navbar; tell the shell how tall the
      // chrome is now and again whenever wrapping/status changes it.
      if (window.viewer.reportChrome && typeof ResizeObserver === "function") {
        new ResizeObserver(() => reportChromeHeight()).observe($("topBar"));
      }
      reportChromeHeight();
    }
    const cfg = await refreshConfig();
    if (cfg && cfg.volume) setVolume(cfg.volume, false);
    else paintVolume();
    loadAccel();
    if (playerUI) await playerUI.load();
    // Only a root already chosen for this process opens straight away.
    if (cfg && cfg.root && cfg.ok) {
      await loadLibrary();
      return;
    }
    await loadSideState("");
    syncNav();
    showLauncher();
  }

  init().catch((err) => {
    setStatus(String(err && err.message ? err.message : err), true);
  });
})();
