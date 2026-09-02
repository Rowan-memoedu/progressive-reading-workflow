import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const extensionRoot = path.join(scriptDir, "..", "browser-highlight-extension");
const [coreSource, backgroundSource, popupSource, popupHtml, manifestSource, appSource] = await Promise.all([
  fs.readFile(path.join(extensionRoot, "draft-core.js"), "utf8"),
  fs.readFile(path.join(extensionRoot, "background.js"), "utf8"),
  fs.readFile(path.join(extensionRoot, "popup.js"), "utf8"),
  fs.readFile(path.join(extensionRoot, "popup.html"), "utf8"),
  fs.readFile(path.join(extensionRoot, "manifest.json"), "utf8"),
  fs.readFile(path.join(scriptDir, "progressive-reading-app.mjs"), "utf8")
]);
const manifest = JSON.parse(manifestSource);

const requests = [];
const createdTabs = [];
let runtimeMessageListener = null;
const chrome = {
  runtime: {
    id: "fixture-extension",
    lastError: null,
    onInstalled: { addListener() {} },
    onStartup: { addListener() {} },
    onSuspend: { addListener() {} },
    onMessage: { addListener(listener) { runtimeMessageListener = listener; } }
  },
  storage: {
    local: {
      get(defaults, done) { done(defaults); },
      set(_values, done) { done(); }
    }
  },
  contextMenus: {
    removeAll(done) { done(); },
    create() {},
    onClicked: { addListener() {} }
  },
  tabs: {
    create(options, done) { createdTabs.push(options); done?.({ id: 91, ...options }); },
    query(_options, done) { done([]); },
    sendMessage(_tabId, _message, done) { done?.({ ok: false, error: "unexpected_tab_message" }); },
    onRemoved: { addListener() {} }
  },
  scripting: {
    insertCSS(_options, done) { done(); },
    executeScript(_options, done) { done([]); }
  },
  action: {
    setBadgeBackgroundColor(_options, done) { done(); },
    setBadgeText(_options, done) { done(); }
  }
};

const sandbox = {
  chrome,
  fetch: async (url) => {
    requests.push(String(url));
    throw new Error("extension_import_worker_must_not_fetch");
  },
  Response,
  AbortController,
  URL,
  console,
  setTimeout,
  clearTimeout
};
const context = vm.createContext(sandbox);
sandbox.importScripts = (file) => {
  if (file !== "draft-core.js") throw new Error(`unexpected_import:${file}`);
  vm.runInContext(coreSource, context, { filename: file });
};
vm.runInContext(backgroundSource, context, { filename: "background.js" });
await new Promise((resolve) => setTimeout(resolve, 30));

assert.deepEqual(requests, [], "extension startup must not poll, claim, or execute broker tasks");
assert.deepEqual(createdTabs, [], "extension startup must not create visible or inactive tabs");
assert.equal(manifest.permissions?.includes("cookies"), false, "extension must not request cookies permission");
assert.deepEqual(
  [...(manifest.host_permissions || [])].sort(),
  ["http://127.0.0.1/*", "http://localhost/*"].sort(),
  "extension host permissions must remain loopback-only"
);

const retiredCapabilityPattern = /chrome\.cookies|COOKIE_SYNC_|cookies\/sync|url-cookie-sync|sync-social-login-state|syncSocialLoginState/iu;
assert.equal(retiredCapabilityPattern.test(backgroundSource), false, "background must not contain Cookie sync capability");
assert.equal(/syncLoginState|sync-social-login-state|同步知乎与 X 登录状态|cookieSync/iu.test(`${popupHtml}\n${popupSource}`), false, "popup must not contain Cookie sync UI");
assert.equal(backgroundSource.includes("/api/browser-import/tasks/claim"), false, "extension must not contain a broker claim path");
assert.equal(backgroundSource.includes('credentials: "include"'), false, "extension must not use browser credentials for URL imports");
assert.equal(backgroundSource.includes("chrome.permissions"), false, "extension must not expand site permissions dynamically");
assert.equal(backgroundSource.includes("chrome.tabs.create"), false, "background URL import must not create content tabs");
assert.equal(backgroundSource.includes("createBrowserImportRequest"), true, "URL submission through the shared broker must remain");
assert.equal(backgroundSource.includes("waitForBrowserImportRequest"), true, "unified broker receipt display must remain");
assert.match(
  appSource,
  /if \(!task\) \{[\s\S]*?getRequest\(requestId\)[\s\S]*?request\.terminal[\s\S]*?waitForTask\(25000,[\s\S]*?continue;/u,
  "background importer must keep polling nonterminal requests so expired claims recover after restart"
);

assert.equal(typeof runtimeMessageListener, "function", "runtime message listener must be registered");
const retiredMessageResponse = await new Promise((resolve, reject) => {
  const timeout = setTimeout(() => reject(new Error("runtime_message_timeout")), 1000);
  runtimeMessageListener({ type: "sync-social-login-state" }, {}, (response) => {
    clearTimeout(timeout);
    resolve(response);
  });
});
assert.equal(retiredMessageResponse?.ok, false, "retired sync message must not be routed");
assert.equal(retiredMessageResponse?.error, "unknown_message", "retired sync message must use the generic unknown route");
assert.deepEqual(requests, [], "retired sync message must not reach any endpoint");
assert.deepEqual(createdTabs, [], "retired sync message must not open a tab");

console.log(JSON.stringify({
  status: "passed",
  checks: [
    "extension_worker_retired",
    "no_broker_claim_polling",
    "no_cookie_permission",
    "loopback_only_host_permissions",
    "no_cookie_api_or_sync_endpoint",
    "no_cookie_sync_popup_or_runtime_route",
    "shared_url_submission_preserved",
    "unified_receipt_display_preserved",
    "no_tab_creation"
  ]
}, null, 2));
