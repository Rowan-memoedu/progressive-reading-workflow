import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { startFixture } from "./browser-import-web/fixture.mjs";
import { COOKIE_SYNC_EXTENSION_ID } from "./live-cookie-snapshot.mjs";
const extensionRoot = process.env.CHROME_COOKIE_SYNC_PROJECT_ROOT || "D:/Projects/ChromeCookieSync";
const { createLiveSync } = await import(pathToFileURL(path.join(extensionRoot, "extension/live-sync.js")));
const origin = `chrome-extension://${COOKIE_SYNC_EXTENSION_ID}`;
const fixture = await startFixture(); let restarted;
const report = { kind: "synthetic_chrome_api_real_http", production_credentials_read: false, checks: [] };
const check = (name, value) => { assert.ok(value, name); report.checks.push(name); };
const json = async (url, options) => { const response = await fetch(url, options); return { status: response.status, body: await response.json() }; };
async function importOne(sourceUrl) {
  const accepted = await json(`${fixture.baseUrl}/api/browser-import/requests`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ urls: [sourceUrl], source: "web_import_page", entry_route: "obsidian", request_id: `cookie-e2e-${crypto.randomUUID()}` }) });
  assert.equal(accepted.status, 202);
  for (let i = 0; i < 600; i++) {
    const response = await json(`${fixture.baseUrl}/api/browser-import/requests/${accepted.body.request_id}`);
    if (response.body.terminal) return response.body.results[0];
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error("cookie_e2e_import_timeout");
}
try {
  const denied = await json(`${fixture.baseUrl}/api/browser-import/cookies/snapshot`, { method: "POST", headers: { Origin: "https://untrusted.test", "Content-Type": "application/json" }, body: "{}" });
  check("untrusted_origin_denied", denied.status === 403);
  const before = await importOne(`${fixture.sourceUrl}/cookie-required/before`);
  check("logged_out_fetch_cannot_publish", before.status === "requires_browser_auth" && (before.artifacts || []).length === 0);
  let cookies = [{ name: "fixture_auth", value: "synthetic-live", domain: "127.0.0.1", hostOnly: true, path: "/cookie-required", secure: false, httpOnly: true, sameSite: "lax", session: true, storeId: "0" }];
  const settings = { enabled: true }; const alarms = new Map();
  const sync = createLiveSync({
    storage: { local: { get: async () => ({ ...settings }), set: async value => { Object.assign(settings, value); } } },
    cookies: { getAll: async () => cookies, getAllCookieStores: async () => [{ id: "0" }] },
    alarms: { get: async name => alarms.get(name), create: async (name, value) => alarms.set(name, value), clear: async name => alarms.delete(name) }
  }, { origin: fixture.baseUrl, fetchImpl: (url, options) => fetch(url, { ...options, headers: { ...options.headers, Origin: origin } }) });
  await sync.start(); check("extension_core_received_persistent_ack", settings.syncStatus?.state === "synchronized");
  const after = await importOne(`${fixture.sourceUrl}/cookie-required/after`);
  check("authenticated_shared_worker_published", after.status === "imported" && after.artifacts.some(item => item.kind === "markdown"));
  for (const artifact of after.artifacts.filter(item => item.kind === "markdown")) {
    const body = await fs.readFile(artifact.path);
    assert.ok(body.length > 300); assert.equal(createHash("sha256").update(body).digest("hex"), artifact.sha256);
  }
  report.checks.push("formal_artifacts_hash_readback");
  const health = (await json(`${fixture.baseUrl}/api/browser-import/cookies/status`)).body;
  check("health_has_no_cookie_values", !JSON.stringify(health).includes("synthetic-live") && !JSON.stringify(health).includes("fixture_auth"));
  restarted = await startFixture({ cookieDataRoot: path.join(fixture.workflowRoot, ".local-ir/synthetic-credentials") });
  const reloadHealth = (await json(`${restarted.baseUrl}/api/browser-import/cookies/status`)).body;
  check("new_service_process_restores_snapshot", reloadHealth.loaded && reloadHealth.cookie_count === 1);
  const snapshotPath = path.join(fixture.workflowRoot, ".local-ir/synthetic-credentials/chrome-current.json");
  const staleInput = JSON.parse(await fs.readFile(snapshotPath, "utf8"));
  staleInput.generatedAt = new Date(Date.now() - 16 * 60_000).toISOString();
  await fs.writeFile(snapshotPath, JSON.stringify(staleInput));
  await new Promise(resolve => setTimeout(resolve, 1100));
  const expiredAuth = await importOne(`${fixture.sourceUrl}/cookie-required/stale`);
  check("stale_matching_credentials_still_block_import", expiredAuth.status === "requires_browser_auth" && expiredAuth.error === "cookie_sync_stale_refresh_chrome");
  const publicRead = await importOne(`${fixture.sourceUrl}/public-without-cookie`);
  check("stale_unrelated_cookie_path_allows_public_import", publicRead.status === "imported" && publicRead.artifacts.some(item => item.kind === "markdown"));
  await sync.sync();
  check("fresh_sync_recovers_without_reload", settings.syncStatus?.state === "synchronized");
  cookies = []; await sync.sync();
  const logout = await importOne(`${fixture.sourceUrl}/cookie-required/logout`);
  check("logout_removes_auth_without_reload", logout.status === "requires_browser_auth" && (logout.artifacts || []).length === 0);
  const reloadedLogout = (await json(`${restarted.baseUrl}/api/browser-import/cookies/status`)).body;
  // Let the bounded file poll observe the replacement; no process restart is needed.
  if (reloadedLogout.cookie_count !== 0) await new Promise(resolve => setTimeout(resolve, 1100));
  check("other_consumer_hot_reloads_logout", (await json(`${restarted.baseUrl}/api/browser-import/cookies/status`)).body.cookie_count === 0);
  report.status = "passed";
} catch (error) { report.status = "failed"; report.error = error.message; throw error; }
finally {
  if (restarted) await restarted.stop(); await fixture.stop();
  await fs.writeFile(path.join(fixture.root, "cookie-live-acceptance.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ status: report.status, receipt: path.join(fixture.root, "cookie-live-acceptance.json"), checks: report.checks }));
}
