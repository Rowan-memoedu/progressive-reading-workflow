import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const [manifestText, workerSource, popupSource, popupHtml] = await Promise.all([
  fs.readFile(path.join(root, "manifest.json"), "utf8"),
  fs.readFile(path.join(root, "service-worker.js"), "utf8"),
  fs.readFile(path.join(root, "popup.js"), "utf8"),
  fs.readFile(path.join(root, "popup.html"), "utf8")
]);
const manifest = JSON.parse(manifestText);

assert.equal(manifest.manifest_version, 3);
assert.deepEqual(manifest.permissions, ["cookies"], "named permission surface must be exact");
assert.deepEqual(manifest.host_permissions, ["<all_urls>"], "host permission surface must be exact");
assert.equal("content_scripts" in manifest, false, "tool must not inject content scripts");
assert.equal("optional_permissions" in manifest, false, "tool must not request optional permissions");
assert.equal("optional_host_permissions" in manifest, false, "tool must not request optional hosts");
assert.equal("externally_connectable" in manifest, false, "web pages must not message the tool");

const combinedRuntime = `${workerSource}\n${popupSource}`;
for (const forbidden of [
  /chrome\.storage/iu,
  /console\.(?:log|info|warn|error|debug)/iu,
  /chrome\.tabs/iu,
  /chrome\.contextMenus/iu,
  /chrome\.alarms/iu,
  /onStartup|onInstalled|setInterval/iu,
  /browser-import\/requests|tasks\/claim|createBrowserImportRequest/iu,
  /capture-highlight|draft-submit|import-current-url|web-highlighter|content-script/iu
]) {
  assert.equal(forbidden.test(combinedRuntime), false, `forbidden runtime capability:${forbidden}`);
}
assert.equal(workerSource.includes("chrome.cookies.getAll({}"), true, "explicit click route must read all accessible cookies");
assert.equal(workerSource.includes('message?.type !== "sync-all-chrome-cookies"'), true, "worker must expose only the explicit sync message");
assert.equal(popupHtml.includes("同步全部 Chrome Cookie"), true, "popup must expose the exact explicit button");
assert.equal(/response\.(?:name|value|domain|path|fingerprint)\b|response\[(?:"|')(?:name|value|domain|path|fingerprint)(?:"|')\]/iu.test(popupSource), false, "popup must not render Cookie fields or fingerprints");

let listener = null;
let cookieReadCount = 0;
let requestCount = 0;
let payloadValid = false;
let payloadDiagnostics = null;
const privateValue = ["synthetic", "private", "value"].join("_");
const chrome = {
  runtime: {
    lastError: null,
    onMessage: { addListener(value) { listener = value; } }
  },
  cookies: {
    getAll(details, done) {
      cookieReadCount += 1;
      assert.equal(Object.keys(details).length, 0);
      done([{
        name: "fixture_name",
        value: privateValue,
        domain: ".fixture.test",
        hostOnly: false,
        path: "/account",
        secure: true,
        httpOnly: true,
        sameSite: "lax",
        session: false,
        expirationDate: 2_000_000_000,
        storeId: "0",
        partitionKey: { topLevelSite: "https://top.fixture" }
      }]);
    }
  }
};
const sandbox = {
  chrome,
  fetch: async (url, options = {}) => {
    requestCount += 1;
    const parsed = new URL(String(url));
    if (parsed.pathname === "/api/highlights/health") {
      return new Response(JSON.stringify({
        status: "ok",
        service: "local-ir-browser-highlight",
        cookieSync: {
          endpoint: "/api/browser-import/cookies/sync",
          schema: "local-ir.chrome-cookie-jar-sync/v1",
          maxCookies: 50_000,
          maxBodyBytes: 33_554_432,
          atomicReplace: true
        }
      }), { status: 200 });
    }
    if (parsed.pathname === "/api/browser-import/cookies/sync") {
      const payload = JSON.parse(String(options.body || "{}"));
      const cookie = payload.cookies?.[0];
      payloadDiagnostics = {
        schema: payload.schema,
        cookieCount: Array.isArray(payload.cookies) ? payload.cookies.length : -1,
        keys: cookie ? Object.keys(cookie).sort() : [],
        attributeTypes: cookie ? Object.fromEntries(Object.entries(cookie).map(([key, value]) => [key, value === null ? "null" : typeof value])) : {}
      };
      payloadValid = payload.schema === "local-ir.chrome-cookie-jar-sync/v1"
        && Array.isArray(payload.cookies)
        && payload.cookies.length === 1
        && cookie?.value === privateValue
        && cookie?.domain === ".fixture.test"
        && cookie?.hostOnly === false
        && cookie?.path === "/account"
        && cookie?.secure === true
        && cookie?.httpOnly === true
        && cookie?.sameSite === "lax"
        && cookie?.session === false
        && cookie?.expirationDate === 2_000_000_000
        && cookie?.storeId === "0"
        && cookie?.partitionKey?.topLevelSite === "https://top.fixture";
      return new Response(JSON.stringify({
        status: "synchronized",
        schema: "local-ir.chrome-cookie-jar-sync/v1",
        cookie_count: 0,
        domain_count: 0,
        skipped_count: 1,
        skipped_partitioned_count: 1,
        skipped_expired_count: 0,
        fingerprint: `sha256:${"a".repeat(64)}`,
        cookie_values_exposed: false
      }), { status: 200 });
    }
    throw new Error("unexpected_request");
  },
  Response,
  AbortController,
  TextEncoder,
  URL,
  setTimeout,
  clearTimeout
};
vm.runInContext(workerSource, vm.createContext(sandbox), { filename: "service-worker.js" });

assert.equal(typeof listener, "function", "worker must register its explicit message route");
assert.equal(cookieReadCount, 0, "loading the worker must not read cookies");
assert.equal(requestCount, 0, "loading the worker must not contact the service");
assert.equal(listener({ type: "unrelated" }, {}, () => {}), false, "unrelated messages must be ignored");
assert.equal(cookieReadCount, 0, "unrelated messages must not read cookies");

const response = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("explicit_sync_timeout")), 2_000);
  const keepAlive = listener({ type: "sync-all-chrome-cookies" }, {}, (value) => {
    clearTimeout(timer);
    resolve(value);
  });
  assert.equal(keepAlive, true);
});
assert.equal(payloadValid, true, `all contract attributes must be preserved in memory transport:${JSON.stringify({ payloadDiagnostics, requestCount, response })}`);
assert.equal(response?.ok, true);
assert.equal(response?.totalCount, 1);
assert.equal(response?.domainCount, 0);
assert.equal(response?.skippedCount, 1);
assert.equal(JSON.stringify(response).includes(privateValue), false, "public runtime response must not expose Cookie values");

console.log(JSON.stringify({
  status: "passed",
  checks: [
    "exact_mv3_permissions",
    "no_content_or_external_message_surface",
    "no_storage_console_tabs_or_automation",
    "single_explicit_click_route",
    "complete_attribute_mapping",
    "count_only_runtime_receipt",
    "no_url_import_highlight_or_broker_worker"
  ]
}, null, 2));
