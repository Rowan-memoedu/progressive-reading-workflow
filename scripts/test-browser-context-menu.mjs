import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const extensionRoot = path.join(__dirname, "..", "browser-highlight-extension");
const [coreSource, backgroundSource] = await Promise.all([
  fs.readFile(path.join(extensionRoot, "draft-core.js"), "utf8"),
  fs.readFile(path.join(extensionRoot, "background.js"), "utf8")
]);

const storage = {};
const menus = [];
const tabMessages = [];
const fetches = [];
const badges = [];
const createdTabs = [];
const removedTabs = [];
let installedListener = null;
let contextListener = null;
let removedListener = null;
const updatedListeners = new Set();

const chrome = {
  runtime: {
    lastError: null,
    onInstalled: { addListener(listener) { installedListener = listener; } },
    onStartup: { addListener() {} },
    onSuspend: { addListener() {} },
    onMessage: { addListener() {} }
  },
  storage: {
    local: {
      get(defaults, done) { done({ ...defaults, ...storage }); },
      set(values, done) { Object.assign(storage, values); done(); }
    }
  },
  contextMenus: {
    removeAll(done) { menus.length = 0; done(); },
    create(options) { menus.push(options); },
    onClicked: { addListener(listener) { contextListener = listener; } }
  },
  tabs: {
    query(_query, done) { done([]); },
    create(options, done) {
      const created = { id: 29, url: options.url, status: "complete", active: options.active };
      createdTabs.push(created);
      done(created);
    },
    get(tabId, done) {
      done(createdTabs.find((tab) => tab.id === tabId) || null);
    },
    remove(tabId, done) {
      removedTabs.push(tabId);
      done();
      removedListener?.(tabId);
    },
    sendMessage(tabId, message, done) {
      tabMessages.push({ tabId, message });
      if (message.type === "get-content-status") return done({ ok: true, initialized: false });
      if (message.type === "context-import-current-page") return done({ ok: true, result: { status: "saved_locked" } });
      if (message.type === "context-import-progress") return done({ ok: true });
      done({ ok: false, error: "unexpected_tab_message" });
    },
    onUpdated: {
      addListener(listener) { updatedListeners.add(listener); },
      removeListener(listener) { updatedListeners.delete(listener); }
    },
    onRemoved: { addListener(listener) { removedListener = listener; } }
  },
  scripting: {
    insertCSS(_options, done) { done(); },
    executeScript(_options, done) { done([]); }
  },
  action: {
    setBadgeBackgroundColor(options, done) { badges.push({ kind: "color", ...options }); done(); },
    setBadgeText(options, done) { badges.push({ kind: "text", ...options }); done(); }
  }
};

const fetch = async (url, options = {}) => {
  fetches.push({ url: String(url), options });
  if (String(url).endsWith("/api/highlights/health")) {
    return new Response(JSON.stringify({ status: "ok" }), { status: 200, headers: { "Content-Type": "application/json" } });
  }
  if (String(url).endsWith("/api/browser-import/requests") && options.method === "POST") {
    const submitted = JSON.parse(options.body);
    const requestId = submitted.urls[0] === "https://target.test/auth" ? "request-auth" : "request-context";
    return new Response(JSON.stringify({ request_id: requestId, terminal: false }), { status: 202, headers: { "Content-Type": "application/json" } });
  }
  if (String(url).endsWith("/api/browser-import/requests/request-context")) {
    return new Response(JSON.stringify({
      request_id: "request-context",
      terminal: true,
      status: "completed",
      results: [{ requested_url: "https://target.test/article", status: "imported", artifacts: [{ kind: "markdown", path: "fixture.md" }] }]
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  }
  if (String(url).endsWith("/api/browser-import/requests/request-auth")) {
    return new Response(JSON.stringify({
      request_id: "request-auth",
      terminal: true,
      status: "requires_browser_auth",
      results: [{ requested_url: "https://target.test/auth", status: "requires_browser_auth", error: "requires_browser_auth" }]
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  }
  return new Response(JSON.stringify({ error: "unexpected_endpoint" }), { status: 404, headers: { "Content-Type": "application/json" } });
};

const sandbox = {
  chrome,
  fetch,
  Response,
  AbortController,
  URL,
  console,
  setTimeout(callback, delay) {
    const timer = setTimeout(callback, delay);
    timer.unref?.();
    return timer;
  },
  clearTimeout
};
const context = vm.createContext(sandbox);
sandbox.importScripts = (...files) => {
  for (const file of files) {
    if (file !== "draft-core.js") throw new Error(`unexpected_import:${file}`);
    vm.runInContext(coreSource, context, { filename: file });
  }
};
vm.runInContext(backgroundSource, context, { filename: "background.js" });

assert.ok(installedListener, "context menus must be registered on install");
assert.ok(contextListener, "context click listener must be registered");
installedListener();
assert.equal(menus.length, 2);
assert.ok(menus.every((menu) => menu.documentUrlPatterns.includes("https://*/*")));

const tab = { id: 17, url: "https://source.test/current" };
contextListener({ menuItemId: "local-ir-import-page", pageUrl: tab.url }, tab);
await new Promise((resolve) => setTimeout(resolve, 30));
assert.ok(tabMessages.some((item) => item.message.type === "context-import-current-page"), "current-page menu must call the shared content import action");
assert.equal(fetches.some((item) => item.url.endsWith("/api/import")), false, "current-page menu must never use the legacy import job endpoint");
assert.ok(badges.some((item) => item.kind === "text" && item.text === "✓"));

tabMessages.length = 0;
badges.length = 0;
contextListener({ menuItemId: "local-ir-import-link", linkUrl: "https://target.test/auth", pageUrl: tab.url }, tab);
await new Promise((resolve) => setTimeout(resolve, 40));
assert.ok(tabMessages.some((item) => item.message.type === "context-import-progress"
  && item.message.phase === "failed"
  && item.message.message.includes("requires_browser_auth")), "shared broker degradation must be displayed without browser fallback");
assert.ok(badges.some((item) => item.kind === "text" && item.text === "!"));
assert.equal(fetches.some((item) => item.url.includes("/api/browser-import/tasks/claim")), false, "browser entry must not poll or claim service tasks");
assert.deepEqual(createdTabs, [], "degraded status must not open a browser tab");

tabMessages.length = 0;
badges.length = 0;
contextListener({ menuItemId: "local-ir-import-link", linkUrl: "https://target.test/article", pageUrl: tab.url }, tab);
await new Promise((resolve) => setTimeout(resolve, 40));
assert.deepEqual(createdTabs, [], "link menu must not create a visible or inactive browser tab");
assert.deepEqual(removedTabs, [], "link menu must not need temporary-tab cleanup");
assert.ok(fetches.some((item) => item.url.endsWith("/api/browser-import/requests") && item.options.method === "POST"), "link menu must submit to the shared broker");
const brokerCreate = fetches.find((item) => item.url.endsWith("/api/browser-import/requests")
  && item.options.method === "POST"
  && JSON.parse(item.options.body).urls[0] === "https://target.test/article");
assert.deepEqual(JSON.parse(brokerCreate.options.body).urls, ["https://target.test/article"]);
assert.equal(JSON.parse(brokerCreate.options.body).source, "browser_context_link");
assert.ok(fetches.some((item) => item.url.endsWith("/api/browser-import/requests/request-context")), "link menu must consume the shared broker receipt");
assert.equal(fetches.some((item) => item.url.endsWith("/api/import")), false, "link menu must never use the legacy import job endpoint");
assert.ok(tabMessages.some((item) => item.message.type === "context-import-progress" && item.message.phase === "started"));
assert.ok(tabMessages.some((item) => item.message.type === "context-import-progress" && item.message.phase === "succeeded"));
assert.ok(badges.some((item) => item.kind === "text" && item.text === "✓"));

console.log(JSON.stringify({
  status: "passed",
  checks: [
    "context_menu_http_scope",
    "current_page_reuses_content_standard_import",
    "link_uses_shared_broker",
    "link_opens_no_tabs",
    "shared_broker_receipt",
    "shared_degraded_status_display",
    "no_broker_task_claim",
    "legacy_import_endpoint_not_used",
    "page_progress_feedback",
    "action_badge_feedback"
  ]
}, null, 2));
