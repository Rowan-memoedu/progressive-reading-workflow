import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  CHROME_COOKIE_SNAPSHOT_PATH_ENV,
  CHROME_COOKIE_SNAPSHOT_SCHEMA,
  CHROME_COOKIE_SNAPSHOT_SCHEMA_VERSION,
  ChromeCookieJar
} from "./chrome-cookie-jar.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
const appScript = path.join(__dirname, "progressive-reading-app.mjs");
const localIrSource = path.resolve(process.env.OBSIDIAN_LOCAL_IR_SOURCE || path.join(projectRoot, '..', 'ObsidianLocalIR', 'main.ts'));
const browserBackground = path.join(projectRoot, "browser-highlight-extension", "background.js");
const testBase = "D:/Artifacts/ProgressiveReading/auth-tests";
await fs.mkdir(testBase, { recursive: true });
const testRoot = await fs.mkdtemp(path.join(testBase, "shared-snapshot-"));
const workflowRoot = path.join(testRoot, "workflow");
const snapshotPath = path.join(testRoot, "synthetic-cookie-snapshot-v1.json");
const secretPattern = /fixture_(?:root|path|secure|expired|cross|domain|hostonly|partitioned)_secret/u;
const observations = [];
const crossObservations = [];
let crossBase = "";
let protectedArticleResponses = 0;

function cookie(overrides = {}) {
  return {
    name: "root_cookie",
    value: "fixture_root_secret",
    domain: "127.0.0.1",
    hostOnly: true,
    path: "/",
    secure: false,
    httpOnly: true,
    sameSite: "lax",
    session: true,
    expirationDate: null,
    storeId: "0",
    partitionKey: null,
    ...overrides
  };
}

function buildSnapshot() {
  return {
    schema: CHROME_COOKIE_SNAPSHOT_SCHEMA,
    schemaVersion: CHROME_COOKIE_SNAPSHOT_SCHEMA_VERSION,
    sensitivity: "local_sensitive_credential",
    snapshotId: "12345678-1234-4123-8123-123456789abc",
    generatedAt: "2026-08-23T00:00:00.000Z",
    producer: {
      name: "chrome-cookie-sync-extension",
      version: "1.0.0",
      api: "chrome.cookies.getAll",
      partitionQuery: "all_partition_keys"
    },
    profile: {
      browser: "Google Chrome",
      scope: "current_regular_profile",
      storeIds: ["0"]
    },
    cookies: [
      cookie(),
      cookie({ name: "path_cookie", value: "fixture_path_secret", path: "/protected" }),
      cookie({ name: "secure_cookie", value: "fixture_secure_secret", secure: true }),
      cookie({ name: "expired_cookie", value: "fixture_expired_secret", session: false, expirationDate: 1_600_000_000 }),
      cookie({ name: "cross_cookie", value: "fixture_cross_secret", domain: "localhost", hostOnly: true }),
      cookie({ name: "domain_cookie", value: "fixture_domain_secret", domain: ".example.test", hostOnly: false, path: "/account" }),
      cookie({ name: "hostonly_cookie", value: "fixture_hostonly_secret", domain: "example.test", hostOnly: true }),
      cookie({ name: "scope_cookie", value: "fixture_domain_secret", domain: ".scope.test", hostOnly: false }),
      cookie({ name: "scope_cookie", value: "fixture_hostonly_secret", domain: "scope.test", hostOnly: true }),
      cookie({ name: "partitioned_cookie", value: "fixture_partitioned_secret", partitionKey: { topLevelSite: "https://top.test" } })
    ]
  };
}

function articleHtml(title) {
  const paragraph = "这是纯合成本地正文，用于验证两个 URL 入口共享同一 broker、同一后台执行器、同一标准 Markdown 前置处理接口，同时不创建浏览器标签页，也不在日志、回执或磁盘中保存 Cookie 凭据。";
  return `<!doctype html><html><head><title>${title}</title></head><body><article><h1>${title}</h1>${Array.from({ length: 10 }, () => `<p>${paragraph}</p>`).join("")}</article></body></html>`;
}

async function listen(server, host) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, host, resolve);
  });
  return server.address().port;
}

async function close(server) {
  await new Promise((resolve) => server.close(resolve));
}

async function stopChild(child) {
  if (child.exitCode !== null) return;
  child.kill();
  await new Promise((resolve) => child.once("exit", resolve));
}

async function freePort() {
  const server = http.createServer();
  const port = await listen(server, "127.0.0.1");
  await close(server);
  return port;
}

async function waitForJson(url, predicate, timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      last = await response.json();
      if (response.ok && predicate(last)) return last;
    } catch {
      // The local service may still be starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`timed_out_waiting_for_local_json:${JSON.stringify(last)}`);
}

async function postJson(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  const result = await response.json();
  if (!response.ok) throw new Error(`local_http_${response.status}:${JSON.stringify(result)}`);
  return result;
}

async function allTextFiles(root) {
  const values = [];
  async function visit(current) {
    for (const entry of await fs.readdir(current, { withFileTypes: true }).catch(() => [])) {
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) await visit(target);
      else values.push(await fs.readFile(target, "utf8").catch(() => ""));
    }
  }
  await visit(root);
  return values.join("\n");
}

await fs.mkdir(workflowRoot, { recursive: true });
await fs.mkdir(path.join(workflowRoot, "config"), { recursive: true });
await fs.copyFile(path.join(projectRoot, "config/import-destination-routes.json"), path.join(workflowRoot, "config/import-destination-routes.json"));
await fs.writeFile(snapshotPath, `${JSON.stringify(buildSnapshot(), null, 2)}\n`, "utf8");

const unitJar = new ChromeCookieJar();
const unitHealth = await unitJar.loadSnapshotFile(snapshotPath, { nowSeconds: 2_000_000_000 });
assert.equal(unitHealth.source, "versioned_local_snapshot");
assert.equal(unitHealth.cookie_count, 8);
assert.equal(unitHealth.skipped_expired_count, 1);
assert.equal(unitHealth.skipped_partitioned_count, 1);
assert.equal(unitJar.headerForUrl("http://127.0.0.1/protected/article", { nowSeconds: 2_000_000_000 }), "path_cookie=fixture_path_secret; root_cookie=fixture_root_secret");
assert.equal(unitJar.headerForUrl("https://127.0.0.1/", { nowSeconds: 2_000_000_000 }), "root_cookie=fixture_root_secret; secure_cookie=fixture_secure_secret");
assert.equal(unitJar.headerForUrl("http://sub.example.test/account/item", { nowSeconds: 2_000_000_000 }), "domain_cookie=fixture_domain_secret");
assert.equal(unitJar.headerForUrl("http://example.test/", { nowSeconds: 2_000_000_000 }), "hostonly_cookie=fixture_hostonly_secret");
assert.equal(unitJar.headerForUrl("http://sub.example.test/", { nowSeconds: 2_000_000_000 }), null);
assert.equal(unitJar.headerForUrl("http://scope.test/", { nowSeconds: 2_000_000_000 }), "scope_cookie=fixture_hostonly_secret; scope_cookie=fixture_domain_secret");
assert.equal(unitJar.headerForUrl("http://sub.scope.test/", { nowSeconds: 2_000_000_000 }), "scope_cookie=fixture_domain_secret");

const sourceServer = http.createServer((request, response) => {
  observations.push({ path: request.url, cookie: request.headers.cookie || null });
  if (request.url === "/redirect") {
    response.writeHead(302, { Location: "/protected/article" });
    response.end();
    return;
  }
  if (request.url === "/protected/article") {
    protectedArticleResponses += 1;
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end(articleHtml(`浏览器入口合成文章 ${protectedArticleResponses}`));
    return;
  }
  if (request.url === "/cross") {
    response.writeHead(302, { Location: `${crossBase}/target` });
    response.end();
    return;
  }
  response.writeHead(404);
  response.end("not found");
});

const crossServer = http.createServer((request, response) => {
  crossObservations.push({ path: request.url, cookie: request.headers.cookie || null });
  response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  response.end(articleHtml("Obsidian 入口合成文章"));
});

const sourcePort = await listen(sourceServer, "127.0.0.1");
const crossPort = await listen(crossServer, "localhost");
crossBase = `http://localhost:${crossPort}`;
const appPort = await freePort();
const sourceBase = `http://127.0.0.1:${sourcePort}`;
const appBase = `http://127.0.0.1:${appPort}`;
let stdout = "";
let stderr = "";
const app = spawn(process.execPath, [appScript], {
  cwd: __dirname,
  windowsHide: true,
  stdio: ["ignore", "pipe", "pipe"],
  env: {
    ...process.env,
    NODE_ENV: "test",
    PROGRESSIVE_READING_WORKFLOW_ROOT: workflowRoot,
    PROGRESSIVE_READING_APP_PORT: String(appPort),
    PROGRESSIVE_READING_WRITE_SERVER_INFO: "false",
    PROGRESSIVE_READING_BROWSER_PREPROCESS_TEST_PRODUCER: "synthetic",
    PROGRESSIVE_READING_URL_COOKIE_MAP_JSON: "",
    [CHROME_COOKIE_SNAPSHOT_PATH_ENV]: snapshotPath
  }
});
app.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
app.stderr.on("data", (chunk) => { stderr += chunk.toString(); });

try {
  const health = await waitForJson(`${appBase}/api/highlights/health`, (value) => value.status === "ok");
  assert.equal(health.standardImport.defaultTransport, "background_fetch");
  assert.equal(health.standardImport.browserTabCreatedOnNormalPath, false);
  assert.equal(health.standardImport.authenticatedFetch.source, "versioned_local_snapshot");
  assert.equal(health.cookieSnapshot.loaded, true);
  assert.equal(health.cookieSnapshot.snapshotPathExposed, false);
  assert.equal(health.cookieSync.runtimeReplacementEnabled, false);
  assert.equal(health.cookieSync.status, "retired_use_versioned_snapshot");
  assert.doesNotMatch(JSON.stringify(health), secretPattern);
  assert.doesNotMatch(JSON.stringify(health), /127\.0\.0\.1|localhost|example\.test/u);

  const browserRequest = await postJson(`${appBase}/api/browser-import/requests`, {
    urls: [`${sourceBase}/redirect`],
    source: "browser_extension_entry",
    client_request_id: "synthetic-browser-entry"
  });
  const browserResult = await waitForJson(
    `${appBase}/api/browser-import/requests/${encodeURIComponent(browserRequest.request_id)}`,
    (value) => value.terminal === true
  );

  const obsidianRequest = await postJson(`${appBase}/api/browser-import/requests`, {
    urls: [`${sourceBase}/cross`],
    source: "obsidian_local_ir",
    client_request_id: "synthetic-obsidian-entry"
  });
  const obsidianResult = await waitForJson(
    `${appBase}/api/browser-import/requests/${encodeURIComponent(obsidianRequest.request_id)}`,
    (value) => value.terminal === true
  );

  const browserMarkdown = browserResult.results[0].artifacts.find((item) => item.kind === "markdown");
  const replayRequest = await postJson(`${appBase}/api/browser-import/requests`, {
    urls: [`${sourceBase}/redirect`],
    source: "obsidian_local_ir",
    client_request_id: "synthetic-obsidian-replay"
  });
  const replayResult = await waitForJson(
    `${appBase}/api/browser-import/requests/${encodeURIComponent(replayRequest.request_id)}`,
    (value) => value.terminal === true
  );

  for (const result of [browserResult, obsidianResult]) {
    assert.equal(result.status, "completed");
    assert.equal(result.imported, 1);
    assert.equal(result.results[0].status, "imported");
    assert.equal(result.results[0].source_metadata.capture_agent, "local_background_url_fetch");
    assert.equal(result.results[0].source_metadata.fetch_transport, "background_fetch");
    assert.equal(result.results[0].receipt.processing_mode, "standard_preprocess");
    assert.equal(result.results[0].receipt.browser_tab_created, false);
    assert.equal(result.results[0].receipt.cookie_policy, "versioned_snapshot_cookie_matching_no_store");
  }
  assert.equal(browserResult.source, "browser_extension_entry");
  assert.equal(obsidianResult.source, "obsidian_local_ir");
  assert.equal(replayResult.status, "completed");
  assert.equal(replayResult.results[0].status, "idempotent_replay");
  assert.equal(replayResult.results[0].receipt.preprocess_status, "idempotent_replay");
  assert.equal(replayResult.results[0].receipt.idempotent_replay_basis, "normalized_requested_url");
  assert.equal(replayResult.results[0].receipt.browser_tab_created, false);
  assert.equal(replayResult.results[0].receipt.cookie_policy, "versioned_snapshot_cookie_matching_no_store");
  const replayMarkdown = replayResult.results[0].artifacts.find((item) => item.kind === "markdown");
  assert.equal(replayMarkdown.path, browserMarkdown.path);
  assert.equal(replayMarkdown.sha256, browserMarkdown.sha256);
  assert.equal(protectedArticleResponses, 1, "cross-entry replay must not refetch or overwrite dynamic source content");

  assert.deepEqual(observations, [
    { path: "/redirect", cookie: "root_cookie=fixture_root_secret" },
    { path: "/protected/article", cookie: "path_cookie=fixture_path_secret; root_cookie=fixture_root_secret" },
    { path: "/cross", cookie: "root_cookie=fixture_root_secret" }
  ]);
  assert.deepEqual(crossObservations, [{ path: "/target", cookie: "cross_cookie=fixture_cross_secret" }]);

  const [browserSource, localIrText] = await Promise.all([
    fs.readFile(browserBackground, "utf8"),
    fs.readFile(localIrSource, "utf8")
  ]);
  assert.equal(browserSource.includes('requestJsonReliable("/api/browser-import/requests"'), true);
  assert.equal(browserSource.includes("chrome.tabs.create"), false);
  assert.equal(localIrText.includes('requestBrowserImportApi("/api/browser-import/requests"'), true);

  assert.doesNotMatch(`${stdout}\n${stderr}`, secretPattern);
  assert.doesNotMatch(await allTextFiles(workflowRoot), secretPattern);

  console.log(JSON.stringify({
    status: "passed",
    checks: [
      "browser_and_obsidian_same_request_endpoint",
      "single_server_background_executor",
      "versioned_snapshot_v1_loaded",
      "host_only_and_domain_matching",
      "rfc_path_matching",
      "secure_and_expired_filtering",
      "redirect_cookie_recomputed_each_hop",
      "standard_markdown_preprocess_interface",
      "cross_entry_normalized_url_idempotent_replay",
      "unified_receipt",
      "no_browser_tabs",
      "no_cookie_credentials_in_health_logs_receipts_or_disk"
    ],
    browser_status: browserResult.status,
    obsidian_status: obsidianResult.status,
    sensitive_values_exposed: false
  }, null, 2));
} finally {
  await stopChild(app).catch(() => undefined);
  await close(sourceServer);
  await close(crossServer);
  await fs.writeFile(path.join(testRoot, "service.log"), stdout + stderr);
}
