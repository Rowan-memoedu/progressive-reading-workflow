import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  REQUIRES_JS_RENDER,
  URL_COOKIE_ENV,
  URL_COOKIE_SCHEMA,
  URL_COOKIE_SETUP_ORIGIN,
  URL_COOKIE_SYNC_SCHEMA,
  UrlImportDegradedError,
  fetchUrlWithoutBrowser,
  isLoopbackAddress,
  mergeCookieSyncIntoProcessEnvironment,
  validateCookieSyncSetupOrigin,
  validateCookieSyncPayload,
  withoutUrlCookieEnvironment
} from "./url-background-fetch.mjs";

// Security regression for process-only authenticated URL imports.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appScript = path.join(__dirname, "progressive-reading-app.mjs");
const endpoint = "/api/browser-import/cookies/sync";
const setupOrigin = URL_COOKIE_SETUP_ORIGIN;
const retiredExtensionOrigin = `chrome-extension://${"a".repeat(32)}`;
const zhihuCookie = "zhihu_session=synthetic_zhihu_only; z_c0=synthetic_token_12345678";
const xCookie = "auth_token=synthetic_x_only; ct0=synthetic_csrf_12345678";
const allSecrets = /synthetic_zhihu_only|synthetic_token_12345678|synthetic_x_only|synthetic_csrf_12345678|synthetic_zhihu_replacement/u;
const workflowRoot = await fs.mkdtemp(path.join(os.tmpdir(), "local-ir-cookie-sync-e2e-"));

assert.equal(isLoopbackAddress("127.0.0.1"), true);
assert.equal(isLoopbackAddress("::1"), true);
assert.equal(isLoopbackAddress("192.168.1.9"), false);
assert.equal(validateCookieSyncSetupOrigin(setupOrigin), setupOrigin);
assert.throws(() => validateCookieSyncSetupOrigin("https://example.com"), /cookie_sync_origin_not_allowed/);
assert.throws(() => validateCookieSyncSetupOrigin(retiredExtensionOrigin), /cookie_sync_origin_not_allowed/);

function articleHtml(title = "合成认证文章") {
  const paragraph = "本段是纯合成材料，用来验证 Cookie 仅在精确 hostname 上参与后台认证抓取，并且不会进入日志、回执、Markdown 或磁盘状态。";
  return `<!doctype html><html><head><title>${title}</title></head><body><article><h1>${title}</h1>${Array.from({ length: 8 }, () => `<p>${paragraph}</p>`).join("")}</article></body></html>`;
}

async function freePort() {
  const server = http.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitForHealth(baseUrl, predicate = () => true, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/api/highlights/health`);
      last = await response.json();
      if (response.ok && predicate(last)) return last;
    } catch {
      // Service startup is asynchronous.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`cookie_sync_health_timeout:${JSON.stringify(last)}`);
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

async function request(baseUrl, {
  method = "POST",
  origin = setupOrigin,
  contentType = "application/json",
  body = null,
  headers = {}
} = {}) {
  const requestHeaders = { ...headers };
  if (origin !== null) requestHeaders.Origin = origin;
  if (contentType !== null) requestHeaders["Content-Type"] = contentType;
  const response = await fetch(`${baseUrl}${endpoint}`, {
    method,
    headers: requestHeaders,
    ...(body === null ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) })
  });
  const text = await response.text();
  return { response, text, data: text ? JSON.parse(text) : null };
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

const validPayload = {
  schema: URL_COOKIE_SYNC_SCHEMA,
  cookies: {
    "www.zhihu.com": zhihuCookie,
    "x.com": xCookie
  }
};
const validated = validateCookieSyncPayload(validPayload);
assert.deepEqual(validated.domains.map((item) => [item.hostname, item.cookie_count]), [["www.zhihu.com", 2], ["x.com", 2]]);
assert.ok(validated.domains.every((item) => /^sha256:[a-f0-9]{64}$/u.test(item.fingerprint)));
assert.doesNotMatch(JSON.stringify(validated.domains), allSecrets);

const syntheticEnv = {};
const merged = mergeCookieSyncIntoProcessEnvironment(new Map(), validated.cookies, syntheticEnv);
assert.equal(merged.cookies.get("www.zhihu.com"), zhihuCookie);
assert.equal(JSON.parse(syntheticEnv[URL_COOKIE_ENV]).schema, URL_COOKIE_SCHEMA);
assert.equal(withoutUrlCookieEnvironment(syntheticEnv)[URL_COOKIE_ENV], undefined);

const observedHeaders = [];
const redirected = await fetchUrlWithoutBrowser("https://www.zhihu.com/redirect", {
  cookieByHostname: merged.cookies,
  fetchImpl: async (url, options) => {
    observedHeaders.push({ url: String(url), cookie: options.headers.Cookie || null });
    if (String(url).includes("www.zhihu.com")) {
      return new Response(null, { status: 302, headers: { Location: "https://x.com/article" } });
    }
    return new Response(articleHtml("X 合成认证文章"), { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" } });
  }
});
assert.equal(redirected.finalUrl, "https://x.com/article");
assert.deepEqual(observedHeaders.map((item) => item.cookie), [zhihuCookie, xCookie]);
assert.notEqual(observedHeaders[1].cookie, zhihuCookie, "cross-host redirects must not carry the source hostname Cookie");

await assert.rejects(
  fetchUrlWithoutBrowser("https://x.com/js-only", {
    cookieByHostname: merged.cookies,
    fetchImpl: async (_url, options) => {
      assert.equal(options.headers.Cookie, xCookie);
      return new Response('<!doctype html><html><body><div id="app"></div><script src="/app.js"></script></body></html>', {
        status: 200,
        headers: { "Content-Type": "text/html; charset=utf-8" }
      });
    }
  }),
  (error) => error instanceof UrlImportDegradedError && error.status === REQUIRES_JS_RENDER
);

const port = await freePort();
const baseUrl = `http://127.0.0.1:${port}`;
let first = startApp(port);
try {
  const initialHealth = await waitForHealth(baseUrl);
  assert.equal(initialHealth.standardImport.authenticatedFetch.configured, false);
  assert.equal(initialHealth.cookieSync.endpoint, endpoint);
  assert.equal(initialHealth.cookieSync.loopbackOnly, true);
  assert.equal(initialHealth.cookieSync.legacySchema, URL_COOKIE_SYNC_SCHEMA);
  assert.equal(initialHealth.cookieSync.legacySetupOrigin, setupOrigin);
  assert.equal(initialHealth.cookieSync.persistence, "current_service_process");
  assert.equal(initialHealth.cookieSync.resyncRequiredAfterRestart, true);
  assert.equal(initialHealth.cookieSync.childProcessInheritance, false);

  const preflight = await request(baseUrl, {
    method: "OPTIONS",
    contentType: null,
    headers: {
      "Access-Control-Request-Method": "POST",
      "Access-Control-Request-Headers": "content-type"
    }
  });
  assert.equal(preflight.response.status, 204);
  assert.equal(preflight.response.headers.get("access-control-allow-origin"), setupOrigin);

  const accepted = await request(baseUrl, { body: validPayload });
  assert.equal(accepted.response.status, 200);
  assert.equal(accepted.response.headers.get("access-control-allow-origin"), setupOrigin);
  assert.equal(accepted.data.status, "synchronized");
  assert.equal(accepted.data.persistence.scope, "current_service_process");
  assert.equal(accepted.data.persistence.resync_required_after_restart, true);
  assert.equal(accepted.data.cookie_count, 4);
  assert.equal(accepted.data.domain_count, 2);
  assert.equal(accepted.data.skipped_count, 0);
  assert.match(accepted.data.fingerprint, /^sha256:[a-f0-9]{64}$/u);
  assert.doesNotMatch(accepted.text, allSecrets);

  const mergedUpdate = await request(baseUrl, {
    body: { schema: URL_COOKIE_SYNC_SCHEMA, cookies: { "www.zhihu.com": "z_c0=synthetic_zhihu_replacement" } }
  });
  assert.equal(mergedUpdate.response.status, 200);
  assert.equal(mergedUpdate.data.cookie_count, 1);
  assert.equal(mergedUpdate.data.domain_count, 1);
  const updatedHealth = await waitForHealth(baseUrl, (health) => health.standardImport.authenticatedFetch.domain_count === 2);
  assert.equal(updatedHealth.standardImport.authenticatedFetch.configured, true);
  assert.doesNotMatch(JSON.stringify(updatedHealth), allSecrets);

  const missingOrigin = await request(baseUrl, { origin: null, body: validPayload });
  assert.equal(missingOrigin.response.status, 403);
  assert.equal(missingOrigin.response.headers.get("access-control-allow-origin"), null);
  const retiredExtension = await request(baseUrl, { origin: retiredExtensionOrigin, body: validPayload });
  assert.equal(retiredExtension.response.status, 422);
  const webOrigin = await request(baseUrl, { origin: "http://127.0.0.1:9999", body: validPayload });
  assert.equal(webOrigin.response.status, 403);
  const wrongType = await request(baseUrl, { contentType: "text/plain", body: validPayload });
  assert.equal(wrongType.response.status, 415);
  const wildcard = await request(baseUrl, { body: { schema: URL_COOKIE_SYNC_SCHEMA, cookies: { "*.zhihu.com": zhihuCookie } } });
  assert.equal(wildcard.response.status, 422);
  const foreignDomain = await request(baseUrl, { body: { schema: URL_COOKIE_SYNC_SCHEMA, cookies: { "example.com": zhihuCookie } } });
  assert.equal(foreignDomain.response.status, 422);
  const malformedCookie = await request(baseUrl, { body: { schema: URL_COOKIE_SYNC_SCHEMA, cookies: { "x.com": "bad name=value" } } });
  assert.equal(malformedCookie.response.status, 422);
  const oversizedCookie = await request(baseUrl, { body: { schema: URL_COOKIE_SYNC_SCHEMA, cookies: { "x.com": `token=${"x".repeat(8192)}` } } });
  assert.equal(oversizedCookie.response.status, 422);
  const extraField = await request(baseUrl, { body: { ...validPayload, unexpected: true } });
  assert.equal(extraField.response.status, 422);
  const invalidJson = await request(baseUrl, { body: "{not-json" });
  assert.equal(invalidJson.response.status, 400);
  assert.doesNotMatch(`${first.output.stdout}\n${first.output.stderr}`, allSecrets);
  assert.doesNotMatch(await allTextFiles(workflowRoot), allSecrets);
  await stopApp(first.child);

  const second = startApp(port);
  first = second;
  const restartedHealth = await waitForHealth(baseUrl);
  assert.equal(restartedHealth.standardImport.authenticatedFetch.configured, false);
  assert.equal(restartedHealth.standardImport.authenticatedFetch.domain_count, 0);

  console.log(JSON.stringify({
    status: "passed",
    checks: [
      "loopback_address_policy",
      "independent_setup_origin_validation",
      "retired_extension_origin_rejected",
      "json_content_type_and_preflight",
      "allowed_exact_hostnames_only",
      "cookie_header_validation_and_size_limits",
      "process_environment_merge",
      "child_environment_redaction",
      "per_domain_counts_and_irreversible_fingerprints",
      "authenticated_background_fetch",
      "cross_hostname_cookie_reselection",
      "cookie_does_not_bypass_js_render_degradation",
      "no_secret_in_response_health_logs_or_disk",
      "restart_requires_resync",
      "extension_worker_remains_retired"
    ]
  }, null, 2));
} finally {
  await stopApp(first.child).catch(() => undefined);
  await fs.rm(workflowRoot, { recursive: true, force: true });
}
