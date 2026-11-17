// Existing extracted-function fixtures run in Chinese. Supply the same message
// dependency as the browser while keeping OS detection out of those fixtures.
import "../static/locales/en.js";
import "../static/i18n.js";
globalThis.GivI18n.setPreference("zh-CN");
globalThis.t = globalThis.GivI18n.t;
globalThis.translate = globalThis.GivI18n.message;
