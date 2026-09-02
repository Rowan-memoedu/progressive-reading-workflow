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

const targetUrl = "https://local.test/article";
const otherUrl = "https://local.test/other";
const storage = {
  localIrBrowserDrafts: {
    [targetUrl]: { url: targetUrl },
    [otherUrl]: { url: otherUrl }
  },
  localIrDraftTabUrls: {
    7: targetUrl,
    8: targetUrl,
    9: otherUrl
  }
};
const sentMessages = [];
let runtimeListener = null;

const chrome = {
  runtime: {
    id: "fixture-extension",
    lastError: null,
    onInstalled: { addListener() {} },
    onStartup: { addListener() {} },
    onSuspend: { addListener() {} },
    onMessage: { addListener(listener) { runtimeListener = listener; } }
  },
  storage: {
    local: {
      get(defaults, done) { done({ ...defaults, ...storage }); },
      set(values, done) { Object.assign(storage, values); done(); }
    }
  },
  contextMenus: {
    removeAll(done) { done(); },
    create() {},
    onClicked: { addListener() {} }
  },
  tabs: {
    query(options, done) {
      assert.equal(options.url, targetUrl);
      done([{ id: 7 }, { id: 8 }]);
    },
    sendMessage(tabId, message, done) {
      sentMessages.push({ tabId, message });
      done?.({ ok: true });
    },
    create() {},
    get() {},
    remove() {},
    onUpdated: { addListener() {}, removeListener() {} },
    onRemoved: { addListener() {} }
  },
  scripting: {
    insertCSS() {},
    executeScript() {}
  },
  action: {
    setBadgeBackgroundColor(_options, done) { done(); },
    setBadgeText(_options, done) { done(); }
  },
  alarms: {
    create() {},
    onAlarm: { addListener() {} }
  }
};

const sandbox = {
  chrome,
  fetch: async () => new Response(JSON.stringify({ task: null }), { status: 200, headers: { "Content-Type": "application/json" } }),
  Response,
  AbortController,
  URL,
  URLSearchParams,
  console,
  setTimeout() { return 1; },
  clearTimeout() {}
};
const context = vm.createContext(sandbox);
sandbox.importScripts = (file) => {
  if (file !== "draft-core.js") throw new Error(`unexpected_import:${file}`);
  vm.runInContext(coreSource, context, { filename: file });
};
vm.runInContext(backgroundSource, context, { filename: "background.js" });
assert.ok(runtimeListener, "background message listener must be registered");

const response = await new Promise((resolve, reject) => {
  const timeout = globalThis.setTimeout(() => reject(new Error("draft_discard_response_timeout")), 1000);
  runtimeListener({ type: "draft-discard", url: targetUrl }, { tab: { id: 7 } }, (result) => {
    globalThis.clearTimeout(timeout);
    resolve(result);
  });
});

assert.equal(response.ok, true);
assert.equal(response.result.discarded, true);
assert.equal(storage.localIrBrowserDrafts[targetUrl], undefined, "target draft must be deleted");
assert.deepEqual(storage.localIrBrowserDrafts[otherUrl], { url: otherUrl }, "other drafts must be preserved");
assert.equal(storage.localIrDraftTabUrls[7], undefined, "sender tab mapping must be deleted");
assert.equal(storage.localIrDraftTabUrls[8], undefined, "all mappings for the discarded URL must be deleted");
assert.equal(storage.localIrDraftTabUrls[9], otherUrl, "unrelated tab mappings must be preserved");
assert.equal(JSON.stringify(sentMessages), JSON.stringify([
  { tabId: 7, message: { type: "draft-state", draft: null } },
  { tabId: 8, message: { type: "draft-state", draft: null } }
]), "all open tabs for the URL must receive an empty draft state");

console.log(JSON.stringify({
  status: "passed",
  checks: ["draft_deleted", "unrelated_draft_preserved", "tab_mappings_cleaned", "empty_state_broadcast"]
}, null, 2));
