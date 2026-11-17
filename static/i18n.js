/* Zero-build i18n. Catalog keys are the original Chinese messages; user data is
 * only interpolated, never scanned or translated. No network or storage access. */
(function (root) {
  "use strict";
  const english = root.GivEnglish || {};
  const listeners = new Set();
  const applied = new WeakMap();
  let preference = "auto", systemLanguage = "";
  const normalize = value => ["auto", "zh-CN", "en"].includes(value) ? value : "auto";
  function detect(language) {
    return /^zh(?:[-_]|$)/i.test(String(language || "").trim()) ? "zh-CN" : "en";
  }
  function locale() {
    const nav = root.navigator || {};
    return preference === "auto" ? detect(systemLanguage || nav.language || (nav.languages || [])[0]) : preference;
  }
  function t(key, values = {}) {
    let message = locale() === "en" && Object.hasOwn(english, key) ? english[key] : key;
    if (typeof message === "object") message = message[new Intl.PluralRules(locale()).select(Number(values.count))] || message.other;
    return String(message).replace(/\{(\w+)\}/g, (match, name) => Object.hasOwn(values, name) ? String(values[name]) : match);
  }
  // Used only at application-owned status/error boundaries, never on media,
  // prompts, filenames or tags. Known backend messages can share the catalog.
  function message(raw) {
    const value = String(raw == null ? "" : raw);
    if (Object.hasOwn(english, value)) return t(value);
    for (const [key, translated] of Object.entries(english)) {
      const variants = typeof translated === "object" ? Object.values(translated) : [translated];
      for (const template of [key, ...variants]) {
        if (template === value) return t(key);
        if (!template.includes("{")) continue;
        const names = [];
        const pattern = template.split(/(\{\w+\})/).map(part => {
          if (/^\{\w+\}$/.test(part)) {
            const name = part.slice(1, -1);
            names.push(name);
            return /^(count|current|total|page|seconds|success|failed|shown|groups|folders|files|mixed|conflicts|unique)$/.test(name) ? "(\\d+(?:\\.\\d+)?)" : "([\\s\\S]*?)";
          }
          return part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        }).join("");
        const match = value.match(new RegExp("^" + pattern + "$"));
        if (match) return t(key, Object.fromEntries(names.map((name, index) => [name, match[index + 1]])));
      }
    }
    return value;
  }
  function apply(scope = root.document) {
    if (!scope) return;
    if (root.document) root.document.documentElement.lang = locale();
    function update(node, attr, key) {
      const previous = applied.get(node) || {};
      const current = attr === "text" ? node.textContent : node.getAttribute(attr);
      // State-dependent labels may have changed since the last static pass.
      // Translate their current message rather than resetting them to defaults.
      const prior = previous[attr];
      const dynamic = !!prior && (prior.dynamic || current !== prior.value);
      const next = dynamic ? message(current) : t(key);
      if (attr === "text") node.textContent = next;
      else node.setAttribute(attr, next);
      previous[attr] = {value: next, dynamic};
      applied.set(node, previous);
    }
    for (const node of scope.querySelectorAll("[data-i18n]")) update(node, "text", node.getAttribute("data-i18n"));
    for (const attr of ["title", "aria-label", "placeholder", "alt"]) {
      for (const node of scope.querySelectorAll("[data-i18n-" + attr + "]")) update(node, attr, node.getAttribute("data-i18n-" + attr));
    }
    for (const node of scope.querySelectorAll("[data-language-select]")) node.value = preference;
  }
  function refresh() {
    apply();
    for (const listener of listeners) listener();
  }
  function setPreference(value) {
    const next = normalize(value);
    if (next === preference) { apply(); return; }
    preference = next;
    refresh();
  }
  function setSystemLanguage(value) {
    const before = locale();
    systemLanguage = typeof value === "string" ? value : "";
    if (locale() !== before) refresh();
  }
  root.GivI18n = Object.freeze({t, message, detect, normalize, locale, apply, setPreference, setSystemLanguage,
    preference: () => preference,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); }
  });
  if (root.addEventListener) root.addEventListener("languagechange", () => { if (preference === "auto" && !systemLanguage) refresh(); });
})(typeof window === "object" ? window : globalThis);
