import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  CHROME_COOKIE_JAR_MAX_SYNC_BYTES,
  CHROME_COOKIE_JAR_SYNC_SCHEMA,
  ChromeCookieJar,
  validateChromeCookieSyncOrigin
} from "./chrome-cookie-jar.mjs";
import { URL_COOKIE_ENV, fetchUrlWithoutBrowser } from "./url-background-fetch.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appScript = path.join(__dirname, "progressive-reading-app.mjs");
const workflowRoot = await fs.mkdtemp(path.join(os.tmpdir(), "local-ir-chrome-cookie-jar-"));
const extensionOrigin = `chrome-extension://${"a".repeat(32)}`;
const nowSeconds = 2_000_000_000;
const secretPattern = /synthetic_secret_[0-9]+|synthetic_root_value|synthetic_secure_value|synthetic_other_value|synthetic_runtime_auth/u;

function syntheticCookie(overrides = {}) {
  return {
    name: "root_cookie",
    value: "synthetic_root_value",
    domain: "www.example.com",
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

assert.equal(validateChromeCookieSyncOrigin(extensionOrigin), extensionOrigin);
assert.throws(() => validateChromeCookieSyncOrigin("https://example.com"), /cookie_sync_origin_not_allowed/u);

const jar = new ChromeCookieJar();
const unitHealth = jar.replace({
  schema: CHROME_COOKIE_JAR_SYNC_SCHEMA,
  cookies: [
    syntheticCookie(),
    syntheticCookie({ name: "secure_cookie", value: "synthetic_secure_value", domain: ".example.com", hostOnly: false, path: "/account", secure: true }),
    syntheticCookie({ name: "other_cookie", value: "synthetic_other_value", domain: ".other.test", hostOnly: false }),
    syntheticCookie({ name: "expired_cookie", value: "expired_value", session: false, expirationDate: nowSeconds - 1 }),
    syntheticCookie({ name: "partitioned_cookie", value: "partitioned_value", partitionKey: { topLevelSite: "https://example.com" } })
  ]
}, { nowSeconds });
assert.equal(unitHealth.cookie_count, 3);
assert.equal(unitHealth.domain_count, 3);
assert.equal(unitHealth.skipped_partitioned_count, 1);
assert.equal(unitHealth.skipped_expired_count, 1);
assert.equal(jar.headerForUrl("https://www.example.com/account/settings", { nowSeconds }), "secure_cookie=synthetic_secure_value; root_cookie=synthetic_root_value");
assert.equal(jar.headerForUrl("http://www.example.com/account/settings", { nowSeconds }), "root_cookie=synthetic_root_value");
assert.equal(jar.headerForUrl("https://sub.example.com/account/settings", { nowSeconds }), "secure_cookie=synthetic_secure_value");
assert.equal(jar.headerForUrl("https://www.example.com/accounting", { nowSeconds }), "root_cookie=synthetic_root_value");
assert.equal(jar.headerForUrl("https://unrelated.test/", { nowSeconds }), null);

const beforeInvalid = jar.headerForUrl("https://www.example.com/", { nowSeconds });
assert.throws(() => jar.replace({
  schema: CHROME_COOKIE_JAR_SYNC_SCHEMA,
  cookies: [syntheticCookie(), syntheticCookie()]
}, { nowSeconds }), /chrome_cookie_sync_duplicate_identity/u);
assert.equal(jar.headerForUrl("https://www.example.com/", { nowSeconds }), beforeInvalid, "invalid replacement must not mutate the active jar");

const redirectCookies = [];
await fetchUrlWithoutBrowser("https://www.example.com/start", {
  cookieHeaderForUrl: (url) => jar.headerForUrl(url, { nowSeconds }),
  fetchImpl: async (url, options) => {
    redirectCookies.push({ url: String(url), cookie: options.headers.Cookie || null });
    if (String(url).includes("example.com")) return new Response(null, { status: 302, headers: { Location: "https://other.test/article" } });
    const paragraph = "这是纯合成正文，用于验证重定向后根据目标 URL 重新生成 Cookie header，不沿用前一个域的 Cookie。";
    return new Response(`<!doctype html><html><head><title>合成文章</title></head><body><article>${Array.from({ length: 8 }, () => `<p>${paragraph}</p>`).join("")}</article></body></html>`, {
      status: 200,
      headers: { "Content-Type": "text/html; charset=utf-8" }
    });
  }
});
assert.deepEqual(redirectCookies.map((item) => item.cookie), ["root_cookie=synthetic_root_value", "other_cookie=synthetic_other_value"]);

async function freePort() {
  for (let port = 37830; port <= 37849; port += 1) {
    const server = http.createServer();
    try {
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, "127.0.0.1", resolve);
      });
      await new Promise((resolve) => server.close(resolve));
      return port;
    } catch {
      await new Promise((resolve) => server.close(resolve)).catch(() => undefined);
    }
  }
  throw new Error("chrome_cookie_jar_test_no_free_port");
}

function startApp(port) {
  const child = spawn(process.execPath, [appScript], {
    cwd: __dirname,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      [URL_COOKIE_ENV]: "",
      NODE_ENV: "test",
      PROGRESSIVE_READING_WORKFLOW_ROOT: workflowRoot,
      PROGRESSIVE_READING_APP_PORT: String(port),
      PROGRESSIVE_READING_WRITE_SERVER_INFO: "false",
      PROGRESSIVE_READING_BROWSER_PREPROCESS_TEST_PRODUCER: "synthetic"
    }
  });
  const output = { stdout: "", stderr: "" };
  child.stdout.on("data", (chunk) => { output.stdout += chunk.toString(); });
  child.stderr.on("data", (chunk) => { output.stderr += chunk.toString(); });
  return { child, output };
}

async function stopApp(child) {
  if (child.exitCode !== null) return;
  child.kill();
  await new Promise((resolve) => child.once("exit", resolve));
}

async function waitForHealth(baseUrl, predicate = () => true) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/api/highlights/health`);
      const health = await response.json();
      if (response.ok && predicate(health)) return health;
    } catch {
      // Startup is asynchronous.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("chrome_cookie_jar_health_timeout");
}

async function postSync(baseUrl, payload, { origin = extensionOrigin, contentType = "application/json" } = {}) {
  const headers = {};
  if (origin !== null) headers.Origin = origin;
  if (contentType !== null) headers["Content-Type"] = contentType;
  const response = await fetch(`${baseUrl}/api/browser-import/cookies/sync`, {
    method: "POST",
    headers,
    body: JSON.stringify(payload)
  });
  const text = await response.text();
  return { response, text, data: JSON.parse(text) };
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

async function waitForImport(baseUrl, requestId) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const response = await fetch(`${baseUrl}/api/browser-import/requests/${encodeURIComponent(requestId)}`);
    const state = await response.json();
    if (response.ok && state.terminal) return state;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("chrome_cookie_jar_import_timeout");
}

let observedRuntimeCookie = null;
const sourceServer = http.createServer((request, response) => {
  observedRuntimeCookie = String(request.headers.cookie || "");
  if (!observedRuntimeCookie.includes("runtime_auth=synthetic_runtime_auth")) {
    response.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("authentication required");
    return;
  }
  const paragraph = "这是纯合成的本地认证文章，用于证明正常 broker URL 导入链会从进程内 Chrome Cookie Jar 为当前 URL 生成请求头。";
  response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  response.end(`<!doctype html><html><head><title>Cookie Jar 合成 E2E</title></head><body><article>${Array.from({ length: 10 }, () => `<p>${paragraph}</p>`).join("")}</article></body></html>`);
});
await new Promise((resolve, reject) => {
  sourceServer.once("error", reject);
  sourceServer.listen(0, "127.0.0.1", resolve);
});
const sourcePort = sourceServer.address().port;

const port = await freePort();
const baseUrl = `http://127.0.0.1:${port}`;
let app = startApp(port);
try {
  const initial = await waitForHealth(baseUrl);
  assert.equal(initial.cookieSync.schema, CHROME_COOKIE_JAR_SYNC_SCHEMA);
  assert.equal(initial.cookieSync.atomicReplace, true);
  assert.equal(initial.cookieSync.state.cookie_count, 0);

  const largeCookies = Array.from({ length: 5_000 }, (_, index) => syntheticCookie({
    name: `synthetic_cookie_${index}`,
    value: `synthetic_secret_${index}`,
    domain: ".synthetic.test",
    hostOnly: false,
    path: `/p${index}`
  }));
  largeCookies.push(syntheticCookie({
    name: "partitioned_large",
    value: "partitioned_large_value",
    domain: ".synthetic.test",
    hostOnly: false,
    partitionKey: { topLevelSite: "https://top.test" }
  }));
  const accepted = await postSync(baseUrl, { schema: CHROME_COOKIE_JAR_SYNC_SCHEMA, cookies: largeCookies });
  assert.equal(accepted.response.status, 200);
  assert.equal(accepted.data.cookie_count, 5_000);
  assert.equal(accepted.data.domain_count, 1);
  assert.equal(accepted.data.skipped_partitioned_count, 1);
  assert.match(accepted.data.fingerprint, /^sha256:[a-f0-9]{64}$/u);
  assert.doesNotMatch(accepted.text, secretPattern);
  assert.doesNotMatch(accepted.text, /synthetic_cookie_/u);

  const configured = await waitForHealth(baseUrl, (health) => health.cookieSync.state.cookie_count === 5_000);
  assert.equal(configured.cookieSync.state.domain_count, 1);
  assert.equal(configured.cookieSync.state.skipped_count, 1);
  assert.doesNotMatch(JSON.stringify(configured), secretPattern);
  assert.doesNotMatch(JSON.stringify(configured), /synthetic_cookie_/u);

  const missingOrigin = await postSync(baseUrl, { schema: CHROME_COOKIE_JAR_SYNC_SCHEMA, cookies: [] }, { origin: null });
  assert.equal(missingOrigin.response.status, 403);
  const webOrigin = await postSync(baseUrl, { schema: CHROME_COOKIE_JAR_SYNC_SCHEMA, cookies: [] }, { origin: "https://example.com" });
  assert.equal(webOrigin.response.status, 403);
  const wrongType = await postSync(baseUrl, { schema: CHROME_COOKIE_JAR_SYNC_SCHEMA, cookies: [] }, { contentType: "text/plain" });
  assert.equal(wrongType.response.status, 415);
  const invalidSchema = await postSync(baseUrl, { schema: "invalid", cookies: [] });
  assert.equal(invalidSchema.response.status, 422);

  const afterRejected = await waitForHealth(baseUrl);
  assert.equal(afterRejected.cookieSync.state.cookie_count, 5_000, "rejected sync must preserve the previous jar atomically");

  const runtimeSync = await postSync(baseUrl, {
    schema: CHROME_COOKIE_JAR_SYNC_SCHEMA,
    cookies: [syntheticCookie({
      name: "runtime_auth",
      value: "synthetic_runtime_auth",
      domain: "127.0.0.1",
      hostOnly: true
    })]
  });
  assert.equal(runtimeSync.response.status, 200);
  assert.equal(runtimeSync.data.cookie_count, 1);
  const importResponse = await fetch(`${baseUrl}/api/browser-import/requests`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      urls: [`http://127.0.0.1:${sourcePort}/protected-article`],
      source: "synthetic_chrome_cookie_jar_e2e",
      client_request_id: "synthetic-chrome-cookie-jar-e2e"
    })
  });
  const importRequest = await importResponse.json();
  assert.equal(importResponse.status, 202);
  const importState = await waitForImport(baseUrl, importRequest.request_id);
  assert.equal(importState.status, "completed");
  assert.equal(importState.results[0].status, "imported");
  assert.equal(observedRuntimeCookie, "runtime_auth=synthetic_runtime_auth");
  assert.doesNotMatch(`${app.output.stdout}\n${app.output.stderr}`, secretPattern);
  assert.doesNotMatch(await allTextFiles(workflowRoot), secretPattern);

  await stopApp(app.child);
  app = startApp(port);
  const restarted = await waitForHealth(baseUrl);
  assert.equal(restarted.cookieSync.state.configured, false);
  assert.equal(restarted.cookieSync.state.cookie_count, 0);

  const oversizedStatus = await new Promise((resolve, reject) => {
    const request = http.request({
      hostname: "127.0.0.1",
      port,
      path: "/api/browser-import/cookies/sync",
      method: "POST",
      headers: {
        Origin: extensionOrigin,
        "Content-Type": "application/json",
        "Content-Length": CHROME_COOKIE_JAR_MAX_SYNC_BYTES + 1
      }
    }, (response) => {
      response.resume();
      response.on("end", () => resolve(response.statusCode));
    });
    request.on("error", reject);
    request.end();
  });
  assert.equal(oversizedStatus, 413);

  console.log(JSON.stringify({
    status: "passed",
    checks: [
      "strict_chrome_extension_origin",
      "full_cookie_attribute_validation",
      "host_only_and_domain_matching",
      "rfc_path_matching",
      "secure_and_expiration_rules",
      "cross_domain_header_regeneration",
      "partitioned_cookie_skip_count",
      "large_atomic_replace_5000",
      "rejected_sync_preserves_active_jar",
      "normal_broker_import_uses_process_memory_jar",
      "response_health_logs_and_disk_redaction",
      "restart_clears_process_memory_jar",
      "legacy_env_not_required",
      "normal_url_import_fetch_contract_unchanged"
    ]
  }, null, 2));
} finally {
  await stopApp(app.child).catch(() => undefined);
  await new Promise((resolve) => sourceServer.close(resolve));
  await fs.rm(workflowRoot, { recursive: true, force: true });
}
