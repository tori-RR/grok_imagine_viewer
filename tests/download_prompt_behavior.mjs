// Execute the shipped fixed WebView script with captured production primordials.
// Every response below is synthetic; this test never contacts Grok or a gallery.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
function rustString(file, name) {
  const source = readFileSync(join(root, file), "utf8");
  const match = source.match(new RegExp(`const ${name}: &str = r#"([\\s\\S]*?)"#;`));
  assert.ok(match, `${name} must remain available in production source`);
  return match[1];
}
const listScript = rustString("src-tauri/src/download/runtime_impl.rs", "LIST_SCRIPT");
const initialization = rustString("src-tauri/src/download/primordials.rs", "INITIALIZATION_SCRIPT");
const token = "a".repeat(32);
const conversation = "conversation-fixture";
const rootId = "asset-root-cat";
const editId = "asset-edit-drinking";
const videoId = "asset-video-dancing";

const asset = (id, responseId, conv = conversation, extra = {}) => ({
  assetId: id, responseId, sourceConversationId: conv,
  mimeType: id === videoId ? "video/mp4" : "image/jpeg",
  key: `fixture/${id}.jpg`, ...extra,
});
const attachment = (id, responseId, block, conv = conversation) => ({
  assetId: id, responseId, sourceConversationId: conv, mediaGenInput: block,
});
const row = (attachments, extra = {}) => ({
  responseId: "container-message", fileAttachmentAssetMetadata: attachments, ...extra,
});
const response = (data, status = 200) => new Response(JSON.stringify(data), {
  status, headers: { "content-type": "application/json" },
});

async function run({ assets = [], pages, histories = {}, fetchHistory, fetchPost, cancel = false,
  promptTargets = [], timerDelays = {} } = {}) {
  const calls = [];
  let active = 0;
  let peak = 0;
  let context;
  class TestAnchor {
    set href(value) { this.value = value; }
    get href() { return this.value; }
    set download(value) { this.filename = value; }
    get download() { return this.filename; }
    click() {}
  }
  class TestDocument { createElement() { return new TestAnchor(); } }
  const sandbox = {
    console, URL, URLSearchParams, Blob, AbortController, AbortSignal, Uint8Array,
    DOMException, Response, Headers, ReadableStream, ReadableStreamDefaultReader,
    EventTarget, Document: TestDocument, HTMLAnchorElement: TestAnchor,
    document: new TestDocument(),
    // Retry/backoff logic is exercised without waiting through production delays.
    setTimeout: (fn, ms) => setTimeout(fn, Object.hasOwn(timerDelays, ms)
      ? timerDelays[ms] : (ms === 5000 || ms === 60000 ? ms : 0)), clearTimeout,
    fetch: async (raw, options) => {
      const url = new URL(raw);
      calls.push({ url, options });
      assert.equal(url.origin, "https://grok.com");
      assert.equal(options.credentials, "include");
      assert.ok(options.signal instanceof AbortSignal);
      if (url.pathname === "/rest/media/post/get") {
        assert.equal(options.method, "POST");
        assert.deepEqual(Object.keys(options.headers), ["accept", "content-type"]);
        assert.equal(options.headers["content-type"], "application/json");
        active += 1;
        peak = Math.max(peak, active);
        try {
          return fetchPost ? await fetchPost(JSON.parse(options.body).id, options) : response({}, 404);
        } finally { active -= 1; }
      }
      assert.deepEqual(Object.keys(options.headers), ["accept"]);
      if (url.pathname === "/rest/assets") {
        const page = Number(url.searchParams.get("pageToken") || 0);
        return response(pages ? pages[page] : { assets });
      }
      if (url.pathname === "/rest/app-chat/conversations") {
        return response({ conversations: [] });
      }
      const match = url.pathname.match(/^\/rest\/app-chat\/conversations\/([^/]+)\/responses$/);
      assert.ok(match, `unexpected request: ${url}`);
      assert.equal(url.searchParams.get("conversationKind"), "CONVERSATION_KIND_IMAGINE");
      const conv = decodeURIComponent(match[1]);
      active += 1;
      peak = Math.max(peak, active);
      try {
        if (cancel) {
          const p = context.__giv_native_primordials_v1_6f36b8f2;
          p.abortController(p.getOperation(token).controller);
          throw new DOMException("Aborted", "AbortError");
        }
        if (fetchHistory) return await fetchHistory(conv, options);
        assert.ok(Object.hasOwn(histories, conv), `unplanned conversation ${conv}`);
        return response(histories[conv]);
      } finally {
        active -= 1;
      }
    },
  };
  context = vm.createContext(sandbox);
  vm.runInContext(initialization, context);
  const p = context.__giv_native_primordials_v1_6f36b8f2;
  const execute = vm.runInContext(`(${listScript})`, context);
  const result = JSON.parse(JSON.stringify(await execute({ opToken: token, promptTargets }, p)));
  assert.equal(p.getOperation(token), undefined, "operation registry must be released");
  for (let i = 1; i <= calls.length; i += 1) {
    assert.equal(p.getOperation(`${token}-optional-${i}`), undefined, "optional controller must be released");
  }
  return { result, calls, peak };
}

function assertAssetSchema(item) {
  assert.deepEqual(Object.keys(item).sort(), [
    "id", "mime", "sz", "t", "key", "src", "conv", "rootConv", "kind",
    "prompt", "parent", "quality", "variantOf", "remoteUrl",
  ].sort(), "response identity is temporary and must not extend the manifest");
}
const cases = [];
const test = (name, fn) => cases.push({ name, fn });

test("three resources retain their own prompts, including a root attached to human messages", async () => {
  const cat = attachment(rootId, "response-root", { textToImage: { prompt: "dancing cat" } });
  const history = { responses: [
    row([cat], { sender: "human", mediaGenInput: { imageToImage: { prompt: "drinking" } } }),
    row([attachment(editId, "response-edit", { imageToImage: { prompt: "drinking", inputAssets: [rootId] } })]),
    row([cat], { sender: "human", mediaGenInput: { imageToVideo: { prompt: "dancing and drinking" } } }),
    row([attachment(videoId, "response-video", { imageToVideo: {
      prompt: "dancing and drinking", inputAssets: [rootId], resolutionName: "720p",
    } })]),
  ] };
  const { result, calls } = await run({
    pages: [
      { assets: [asset(videoId, "response-video")], nextPageToken: "1" },
      { assets: [asset(rootId, "response-root"), asset(editId, "response-edit")] },
    ], histories: { [conversation]: history },
  });
  assert.equal(result.ok, true);
  assert.equal(result.complete, true);
  assert.deepEqual(result.assets.map((a) => [a.id, a.prompt, a.kind, a.parent]), [
    [videoId, "dancing and drinking", "i2v", rootId],
    [rootId, "dancing cat", "t2i", null],
    [editId, "drinking", "i2i", rootId],
  ]);
  assert.equal(result.assets[0].quality, "720p");
  result.assets.forEach(assertAssetSchema);
  assert.equal(calls.filter((c) => c.url.pathname.endsWith("/responses")).length, 1);
});

test("nonempty resource prompts and assets without complete identity need no enrichment", async () => {
  const { result, calls } = await run({ assets: [
    asset(rootId, "response-root", conversation, { mediaGenInput: { textToImage: { prompt: "already own prompt" } } }),
    asset(editId, undefined),
    asset(videoId, "response-video", "../escape"),
  ] });
  assert.equal(result.ok, true);
  assert.deepEqual(result.assets.map((a) => a.prompt), ["already own prompt", "", ""]);
  assert.equal(calls.length, 2);
});

test("identity mismatches and container prompts never supply an attachment prompt", async () => {
  const { result } = await run({ assets: [asset(rootId, "response-root")], histories: {
    [conversation]: { responses: [
      row([attachment(rootId, "response-wrong", { textToImage: { prompt: "wrong response" } })]),
      row([attachment(rootId, "response-root", { textToImage: { prompt: "wrong conversation" } }, "conversation-other")]),
      row([attachment("asset-other", "response-root", { textToImage: { prompt: "wrong asset" } })]),
      row([attachment(rootId, "response-root", {})], { mediaGenInput: { textToImage: { prompt: "container only" } } }),
    ] },
  } });
  assert.equal(result.ok, true);
  assert.equal(result.assets[0].prompt, "");
});

test("all generation fields come from the exact resource attachment", async () => {
  const { result } = await run({ assets: [asset(videoId, "response-video")], histories: {
    [conversation]: { responses: [row([attachment(videoId, "response-video", {
      videoToVideo: { prompt: "my enhanced video", inputAssets: [rootId], quality: "1080p" },
    })])] },
  } });
  const item = result.assets[0];
  assert.equal(item.prompt, "my enhanced video");
  assert.equal(item.kind, "v2v");
  assert.equal(item.variantOf, rootId);
  assert.equal(item.parent, null);
  assert.equal(item.quality, "1080p");
});

test("conflicting duplicate resource attachments fail closed", async () => {
  const { result } = await run({ assets: [asset(rootId, "response-root")], histories: {
    [conversation]: { responses: [row([
      attachment(rootId, "response-root", { textToImage: { prompt: "one" } }),
      attachment(rootId, "response-root", { textToImage: { prompt: "two" } }),
    ])] },
  } });
  assert.deepEqual(result, { ok: false, code: "schema_error" });
});

test("missing conversations do not block other conversations or invent prompts", async () => {
  for (const status of [404, 410]) {
    const { result, calls } = await run({ assets: [
      asset(rootId, "response-root", "conversation-gone"),
      asset(editId, "response-edit", "conversation-live"),
    ], fetchHistory: async (conv) => conv === "conversation-gone" ? response({}, status) : response({
      responses: [row([attachment(editId, "response-edit", { textToImage: { prompt: "live own prompt" } }, conv)])],
    }) });
    assert.equal(result.ok, true);
    assert.deepEqual(result.assets.map((a) => a.prompt), ["", "live own prompt"]);
    assert.equal(calls.filter((c) => c.url.pathname.endsWith("/responses")).length, 2);
  }
});

test("bounded conversation workers process each conversation once", async () => {
  const assets = [];
  const seen = new Map();
  for (let i = 0; i < 11; i += 1) {
    assets.push(asset(`asset-number-${i}`, `response-number-${i}`, `conversation-number-${i}`));
    assets.push(asset(`asset-twin-${i}`, `response-twin-${i}`, `conversation-number-${i}`));
  }
  const { result, peak } = await run({ assets, fetchHistory: async (conv) => {
    seen.set(conv, (seen.get(conv) || 0) + 1);
    await new Promise((resolve) => setTimeout(resolve, 3));
    return response({ responses: [] });
  } });
  assert.equal(result.ok, true);
  assert.equal(seen.size, 11);
  assert.ok([...seen.values()].every((count) => count === 1));
  assert.ok(peak > 1 && peak <= 4, `active requests: ${peak}`);
});

test("HTTP, JSON, schema and transport failures do not publish incomplete enrichment", async () => {
  const failures = [
    [() => response({}, 401), "not_logged_in", 401],
    [() => response({}, 403), "forbidden", 403],
    [() => response({}, 500), "server_error", 500],
    [() => response({}, 429), "rate_limited", undefined],
    [() => response({ wrong: [] }), "schema_error", undefined],
    [() => response({ responses: {} }), "schema_error", undefined],
    [() => new Response("not json", { headers: { "content-type": "text/html" } }), "schema_error", 200],
    [() => new Response("{", { headers: { "content-type": "application/json" } }), "network", undefined],
    [() => { throw new Error("synthetic transport error"); }, "network", undefined],
  ];
  for (const [fetchHistory, code, status] of failures) {
    const { result, calls } = await run({ assets: [asset(rootId, "response-root")], fetchHistory });
    assert.deepEqual(result, { ok: false, code, ...(status === undefined ? {} : { status }) });
    if (code === "rate_limited") {
      assert.equal(calls.filter((c) => c.url.pathname.endsWith("/responses")).length, 9);
    }
  }
});

test("cancellation propagates and stops queued conversation work", async () => {
  const { result, calls } = await run({
    assets: Array.from({ length: 9 }, (_, i) => asset(`asset-number-${i}`, `response-number-${i}`, `conversation-number-${i}`)),
    cancel: true,
  });
  assert.deepEqual(result, { ok: false, code: "cancelled" });
  assert.ok(calls.filter((c) => c.url.pathname.endsWith("/responses")).length <= 4);
});

test("null generation input stays unknown without borrowing a container prompt", async () => {
  const { result } = await run({
    assets: [asset(rootId, "response-root", conversation, { mediaGenInput: null })],
    histories: { [conversation]: { responses: [row([
      attachment(rootId, "response-root", null),
    ], { mediaGenInput: { textToImage: { prompt: "not the attachment prompt" } } })] } },
  });
  assert.equal(result.ok, true);
  assert.equal(result.assets[0].prompt, "");
});

test("an enrichment failure cancels and drains sibling workers before returning", async () => {
  let siblingsAborted = 0;
  const { result, calls } = await run({
    assets: Array.from({ length: 8 }, (_, i) => asset(`asset-number-${i}`, `response-number-${i}`, `conversation-number-${i}`)),
    fetchHistory: async (conv, options) => {
      if (conv === "conversation-number-0") return response({}, 403);
      return await new Promise((resolve, reject) => {
        const abort = () => {
          siblingsAborted += 1;
          reject(new DOMException("Aborted", "AbortError"));
        };
        if (options.signal.aborted) abort();
        else options.signal.addEventListener("abort", abort, { once: true });
      });
    },
  });
  assert.deepEqual(result, { ok: false, code: "forbidden", status: 403 });
  assert.equal(siblingsAborted, 3);
  assert.equal(calls.filter((c) => c.url.pathname.endsWith("/responses")).length, 4);
});

test("UTF-8 manifest payloads over 24 MiB fail even below the UTF-16 length limit", async () => {
  const prompt = "字".repeat(100000);
  assert.ok(prompt.length * 90 < 25165824);
  assert.ok(Buffer.byteLength(prompt, "utf8") * 90 > 25165824);
  const { result } = await run({ assets: Array.from({ length: 90 }, (_, i) =>
    asset(`asset-budget-${i}`, `response-budget-${i}`, conversation, {
      mediaGenInput: { textToImage: { prompt } },
    })) });
  assert.equal(result.ok, false, "UTF-8 payloads larger than 24 MiB must be rejected");
  assert.equal(result.code, "payload");
});

test("ASCII manifest payloads within the UTF-8 budget remain complete", async () => {
  const prompt = "a".repeat(100000);
  const { result } = await run({ assets: Array.from({ length: 90 }, (_, i) =>
    asset(`asset-budget-${i}`, `response-budget-${i}`, conversation, {
      mediaGenInput: { textToImage: { prompt } },
    })) });
  assert.equal(result.ok, true);
  assert.equal(result.complete, true);
  assert.equal(result.assets.length, 90);
  assert.equal(result.assets[89].prompt, prompt);
  assert.ok(Buffer.byteLength(JSON.stringify(result), "utf8") < 25165824);
});

test("historical targets produce prompt-only updates without reviving download assets", async () => {
  const target = { token: "b".repeat(32), id: rootId, conv: conversation };
  const { result, calls } = await run({ promptTargets: [target], histories: {
    [conversation]: { responses: [row([
      attachment(rootId, "response-root", { textToImage: { prompt: "dancing cat" } }),
    ], { sender: "human", mediaGenInput: { imageToImage: { prompt: "wrong edit" } } })] },
  } });
  assert.equal(result.ok, true);
  assert.deepEqual(result.assets, []);
  assert.deepEqual(result.promptUpdates, [{ ...target, prompt: "dancing cat" }]);
  assert.equal(calls.filter((c) => c.url.pathname.endsWith("/responses")).length, 1);
});

test("live and historical targets share one conversation request and preserve separate tokens", async () => {
  const one = { token: "b".repeat(32), id: rootId, conv: conversation };
  const two = { token: "c".repeat(32), id: rootId, conv: conversation };
  const { result, calls } = await run({
    assets: [asset(editId, "response-edit")], promptTargets: [one, two], histories: {
      [conversation]: { responses: [row([
        attachment(rootId, "response-root", { textToImage: { prompt: "dancing cat" } }),
        attachment(editId, "response-edit", { imageToImage: { prompt: "drinking" } }),
      ])] },
    },
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.assets.map((item) => item.id), [editId]);
  assert.deepEqual(result.promptUpdates, [one, two].map((target) => ({ ...target, prompt: "dancing cat" })));
  assert.equal(calls.filter((c) => c.url.pathname.endsWith("/responses")).length, 1);
});

test("a verified live resource prompt can update an allowlisted local copy without another request", async () => {
  const target = { token: "b".repeat(32), id: rootId, conv: conversation };
  const { result, calls } = await run({
    assets: [asset(rootId, "response-root", conversation, { mediaGenInput: { textToImage: { prompt: "own resource" } } })],
    promptTargets: [target],
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.promptUpdates, [{ ...target, prompt: "own resource" }]);
  assert.equal(calls.length, 2);
});

test("historical request failures and ambiguous prompts are best effort", async () => {
  const target = { token: "b".repeat(32), id: rootId, conv: conversation };
  const histories = [
    () => response({}, 403),
    () => response({}, 429),
    () => { throw new Error("synthetic failure"); },
    () => response({ responses: {} }),
    () => response({ responses: [row([
      attachment(rootId, "response-root", { textToImage: { prompt: "one" } }),
      attachment(rootId, "response-other", { textToImage: { prompt: "two" } }),
    ])] }),
  ];
  for (const fetchHistory of histories) {
    const { result, calls } = await run({ promptTargets: [target], fetchHistory });
    assert.equal(result.ok, true);
    assert.equal(result.promptUpdates, undefined);
    assert.deepEqual(result.assets, []);
    assert.equal(calls.filter((c) => c.url.pathname.endsWith("/responses")).length, 1);
  }
});

test("historical targets still require an exact source conversation and valid run token", async () => {
  const target = { token: "b".repeat(32), id: rootId, conv: conversation };
  const { result, calls } = await run({ promptTargets: [target,
    { token: "not-a-token", id: editId, conv: "conversation-invalid" },
  ], histories: {
    [conversation]: { responses: [row([
      attachment(rootId, "response-root", { textToImage: { prompt: "wrong conversation" } }, "conversation-other"),
    ])] },
  } });
  assert.equal(result.ok, true);
  assert.equal(result.promptUpdates, undefined);
  assert.equal(calls.filter((c) => c.url.pathname.endsWith("/responses")).length, 1);
});

test("own-post fallback is ID-exact, shared per ID and never uses child prompt fields", async () => {
  const first = { token: "b".repeat(32), id: rootId, conv: "" };
  const second = { ...first, token: "c".repeat(32) };
  const { result, calls } = await run({ promptTargets: [first, second], fetchPost: async (id) => response({
    post: { id, originalPrompt: "  own original prompt  ", prompt: "other summary",
      childPosts: [{ id: "child-post", prompt: "wrong child" }], mediaUrl: "https://never-fetch.invalid/media.jpg" },
  }) });
  assert.deepEqual(result.assets, []);
  assert.deepEqual(result.promptUpdates, [first, second].map((target) => ({ ...target, prompt: "  own original prompt  " })));
  assert.equal(calls.filter((c) => c.url.pathname === "/rest/media/post/get").length, 1);
  for (const post of [
    { id: "wrong-post-id", prompt: "wrong ID" },
    { id: rootId, prompt: "", originalPrompt: "", childPosts: [{ prompt: "wrong child" }], images: [{ prompt: "wrong image" }] },
    { id: rootId, prompt: " \n ", originalPrompt: "\t" },
  ]) {
    const failed = await run({ promptTargets: [first], fetchPost: async () => response({ post }) });
    assert.equal(failed.result.ok, true);
    assert.equal(failed.result.promptUpdates, undefined);
  }
});

test("historical and current targets share one conversation request without adding assets", async () => {
  const target = { token: "b".repeat(32), id: rootId, conv: conversation };
  const { result, calls } = await run({
    assets: [asset(editId, "response-edit")], promptTargets: [target], histories: {
      [conversation]: { responses: [row([
        attachment(rootId, "response-root", { textToImage: { prompt: "dancing cat" } }),
        attachment(editId, "response-edit", { imageToImage: { prompt: "drinking", inputAssets: [rootId] } }),
      ])] },
    },
  });
  assert.deepEqual(result.assets.map((item) => item.id), [editId]);
  assert.equal(result.assets[0].prompt, "drinking");
  assert.deepEqual(result.promptUpdates, [{ ...target, prompt: "dancing cat" }]);
  assert.equal(calls.filter((c) => c.url.pathname.endsWith("/responses")).length, 1);
});

test("optional access denial and rate limiting stop further history and post queries", async () => {
  for (const status of [401, 403, 429]) {
    const { result, calls } = await run({ promptTargets: Array.from({ length: 9 }, (_, i) => ({
      token: i.toString(16).padStart(32, "0"), id: `asset-number-${i}`, conv: `conversation-number-${i}`,
    })), fetchHistory: async () => response({}, status) });
    assert.equal(result.ok, true);
    assert.equal(result.promptUpdates, undefined);
    assert.ok(calls.filter((c) => c.url.pathname.endsWith("/responses")).length <= 4);
    assert.equal(calls.filter((c) => c.url.pathname === "/rest/media/post/get").length, 0);
  }
});

test("optional history deadlines preserve the normal manifest and drain child controllers", async () => {
  const target = { token: "b".repeat(32), id: rootId, conv: conversation };
  const waitForAbort = async (_, options) => new Promise((resolve, reject) => {
    const abort = () => reject(new DOMException("Aborted", "AbortError"));
    if (options.signal.aborted) abort();
    else options.signal.addEventListener("abort", abort, { once: true });
  });
  const { result } = await run({
    assets: [asset(editId, "response-edit", conversation, { mediaGenInput: { textToImage: { prompt: "normal own prompt" } } })],
    promptTargets: [target], fetchHistory: waitForAbort, fetchPost: waitForAbort,
    timerDelays: { 5000: 2 },
  });
  assert.equal(result.ok, true);
  assert.equal(result.assets[0].prompt, "normal own prompt");
  assert.equal(result.promptUpdates, undefined);
  const budget = await run({ promptTargets: Array.from({ length: 9 }, (_, i) => ({
    token: i.toString(16).padStart(32, "0"), id: `asset-number-${i}`, conv: `conversation-number-${i}`,
  })), timerDelays: { 60000: 1 }, fetchHistory: async () => {
    await new Promise((resolve) => setTimeout(resolve, 8));
    return response({ responses: [] });
  } });
  assert.equal(budget.result.ok, true);
  assert.equal(budget.calls.filter((c) => c.url.pathname.endsWith("/responses")).length, 4);
  assert.equal(budget.calls.filter((c) => c.url.pathname === "/rest/media/post/get").length, 0);
});

test("historical cancellation remains terminal rather than a best-effort miss", async () => {
  const { result } = await run({
    promptTargets: [{ token: "b".repeat(32), id: rootId, conv: conversation }], cancel: true,
  });
  assert.deepEqual(result, { ok: false, code: "cancelled" });
});

test("historical prompt updates have independent UTF-8 and overall payload budgets", async () => {
  const promptTargets = [];
  const attachments = [];
  for (let i = 0; i < 50; i += 1) {
    promptTargets.push({ token: i.toString(16).padStart(32, "0"), id: `asset-history-${i}`, conv: conversation });
    attachments.push(attachment(`asset-history-${i}`, `response-history-${i}`, {
      textToImage: { prompt: "字".repeat(100000) },
    }));
  }
  const { result } = await run({ promptTargets, histories: {
    [conversation]: { responses: [row(attachments)] },
  } });
  assert.equal(result.ok, true);
  assert.deepEqual(result.assets, []);
  assert.ok(result.promptUpdates.length > 0 && result.promptUpdates.length < 50);
  assert.ok(Buffer.byteLength(JSON.stringify(result.promptUpdates), "utf8") <= 4 * 1024 * 1024);
  assert.ok(result.promptUpdates.every((update) => Buffer.byteLength(update.prompt, "utf8") <= 100000));
});

test("optional prompt updates cannot overflow a valid normal manifest", async () => {
  const promptTargets = [];
  const attachments = [];
  for (let i = 0; i < 50; i += 1) {
    promptTargets.push({ token: i.toString(16).padStart(32, "0"), id: `asset-history-${i}`, conv: conversation });
    attachments.push(attachment(`asset-history-${i}`, `response-history-${i}`, {
      textToImage: { prompt: "a".repeat(100000) },
    }));
  }
  const { result } = await run({
    assets: Array.from({ length: 75 }, (_, i) => asset(`asset-budget-${i}`, `response-budget-${i}`, conversation, {
      mediaGenInput: { textToImage: { prompt: "字".repeat(100000) } },
    })), promptTargets, histories: { [conversation]: { responses: [row(attachments)] } },
  });
  assert.equal(result.ok, true);
  assert.equal(result.complete, true);
  assert.equal(result.assets.length, 75);
  assert.equal(result.promptUpdates, undefined);
  assert.ok(Buffer.byteLength(JSON.stringify(result), "utf8") <= 24 * 1024 * 1024);
});

test("optional whitespace-only prompts stay missing and meaningful whitespace is preserved", async () => {
  const target = { token: "b".repeat(32), id: rootId, conv: conversation };
  for (const prompt of [" \t \n", "  exact prompt\n "]) {
    const { result } = await run({ promptTargets: [target], histories: {
      [conversation]: { responses: [row([
        attachment(rootId, "response-root", { textToImage: { prompt } }),
      ])] },
    }, fetchPost: async () => response({ post: { id: rootId, originalPrompt: " \t", prompt: "\n " } }) });
    assert.equal(result.ok, true);
    if (prompt.trim()) assert.deepEqual(result.promptUpdates, [{ ...target, prompt }]);
    else assert.equal(result.promptUpdates, undefined);
  }
});

test("required conversation requests do not consume the optional history conversation budget", async () => {
  const count = 1025;
  const { result, calls } = await run({
    assets: Array.from({ length: count }, (_, i) => asset(`asset-current-${i}`, `response-current-${i}`, `conversation-number-${i}`)),
    promptTargets: Array.from({ length: count }, (_, i) => ({
      token: i.toString(16).padStart(32, "0"), id: `asset-history-${i}`, conv: `conversation-number-${i}`,
    })), fetchHistory: async (conv) => {
      const i = conv.slice("conversation-number-".length);
      return response({ responses: [row([
        attachment(`asset-current-${i}`, `response-current-${i}`, { textToImage: { prompt: `current-${i}` } }, conv),
        attachment(`asset-history-${i}`, `response-history-${i}`, { textToImage: { prompt: `historical-${i}` } }, conv),
      ])] });
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.promptUpdates.length, count);
  assert.equal(result.promptUpdates.at(-1).prompt, "historical-1024");
  assert.equal(calls.filter((c) => c.url.pathname.endsWith("/responses")).length, count);
  assert.equal(calls.filter((c) => c.url.pathname === "/rest/media/post/get").length, 0);
});

test("an old copy without a conversation can reuse an enriched current resource prompt", async () => {
  const target = { token: "b".repeat(32), id: rootId, conv: "" };
  const { result, calls } = await run({ assets: [asset(rootId, "response-root")], promptTargets: [target], histories: {
    [conversation]: { responses: [row([
      attachment(rootId, "response-root", { textToImage: { prompt: "own resource prompt" } }),
    ])] },
  } });
  assert.equal(result.ok, true);
  assert.deepEqual(result.promptUpdates, [{ ...target, prompt: "own resource prompt" }]);
  assert.equal(calls.filter((c) => c.url.pathname === "/rest/media/post/get").length, 0);
});

test("ID-only historical lookups respect the distinct-ID and total-target bounds", async () => {
  const limited = await run({ promptTargets: Array.from({ length: 1025 }, (_, i) => ({
    token: i.toString(16).padStart(32, "0"), id: `asset-optional-${i}`, conv: "",
  })), fetchPost: async (id) => response({ post: { id, prompt: "own prompt" } }) });
  assert.equal(limited.result.ok, true);
  assert.equal(limited.result.promptUpdates.length, 1024);
  assert.equal(limited.calls.filter((c) => c.url.pathname === "/rest/media/post/get").length, 1024);
  assert.ok(limited.peak <= 4);
  const copies = await run({ promptTargets: Array.from({ length: 8193 }, (_, i) => ({
    token: i.toString(16).padStart(32, "0"), id: rootId, conv: "",
  })), fetchPost: async (id) => response({ post: { id, prompt: "own prompt" } }) });
  assert.equal(copies.result.ok, true);
  assert.equal(copies.result.promptUpdates.length, 8192);
  assert.equal(copies.calls.filter((c) => c.url.pathname === "/rest/media/post/get").length, 1);
});

for (const { name, fn } of cases) {
  await fn();
  console.log(`PASS ${name}`);
}
console.log(`${cases.length} download prompt behavior tests passed`);
