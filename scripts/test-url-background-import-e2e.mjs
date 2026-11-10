import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { URL_COOKIE_ENV, URL_COOKIE_SCHEMA, loadDomainCookieMap } from "./url-background-fetch.mjs";
import {
  CHROME_COOKIE_SNAPSHOT_PATH_ENV,
  CHROME_COOKIE_SNAPSHOT_SCHEMA,
  CHROME_COOKIE_SNAPSHOT_SCHEMA_VERSION
} from "./chrome-cookie-jar.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appScript = path.join(__dirname, "progressive-reading-app.mjs");
const testRoot = await fs.mkdtemp(path.join(os.tmpdir(), "local-ir-url-background-e2e-"));
const workflowRoot = path.join(testRoot, "workflow");
const snapshotPath = path.join(testRoot, "synthetic-cookie-snapshot-v1.json");
const observedCookies = [];
const crossHostCookies = [];
const syntheticCookie = "synthetic_session=fixture_only_not_real";
let crossHostBase = "";

assert.throws(
  () => loadDomainCookieMap({ [URL_COOKIE_ENV]: JSON.stringify({ schema: URL_COOKIE_SCHEMA, cookies: { "*": syntheticCookie } }) }),
  /url_cookie_map_invalid_exact_hostname/
);

await fs.mkdir(path.join(workflowRoot, "config"), { recursive: true });
await fs.copyFile(
  path.resolve(__dirname, "..", "config", "import-destination-routes.json"),
  path.join(workflowRoot, "config", "import-destination-routes.json")
);
await fs.writeFile(snapshotPath, `${JSON.stringify({
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
  profile: { browser: "Google Chrome", scope: "current_regular_profile", storeIds: ["0"] },
  cookies: [{
    name: "synthetic_session",
    value: "fixture_only_not_real",
    domain: "127.0.0.1",
    hostOnly: true,
    path: "/",
    secure: false,
    httpOnly: true,
    sameSite: "lax",
    session: true,
    expirationDate: null,
    storeId: "0",
    partitionKey: null
  }]
}, null, 2)}\n`, "utf8");

function articleHtml() {
  const paragraphs = Array.from({ length: 10 }, (_, index) => `<p>第 ${index + 1} 节说明后台网址导入必须在本地服务中静默完成。正文保留作者原有视角、论证顺序、来源链接和关键细节；重定向、完整性、失败原因与幂等回执都必须可以独立核验，不能用浏览器标签页或伪成功掩盖采集边界。</p>`).join("\n");
  return `<!doctype html><html lang="zh-CN"><head><title>后台静默导入合成文章</title></head><body><main><article><h1>后台静默导入合成文章</h1>${paragraphs}</article></main></body></html>`;
}

async function listen(server, host = "127.0.0.1") {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, host, resolve);
  });
  return server.address().port;
}

async function close(server) {
  await new Promise((resolve) => server.close(resolve));
}

async function freePort() {
  const probe = http.createServer();
  const port = await listen(probe);
  await close(probe);
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
      // The child service may still be starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`timed_out_waiting_for:${url}:${JSON.stringify(last)}`);
}

async function postJson(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  const result = await response.json();
  if (!response.ok) throw new Error(`http_${response.status}:${JSON.stringify(result)}`);
  return result;
}

async function allTextFiles(root) {
  const output = [];
  async function visit(current) {
    for (const entry of await fs.readdir(current, { withFileTypes: true }).catch(() => [])) {
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) await visit(target);
      else output.push(await fs.readFile(target, "utf8").catch(() => ""));
    }
  }
  await visit(root);
  return output.join("\n");
}

const sourceServer = http.createServer((req, res) => {
  observedCookies.push(req.headers.cookie || null);
  if (req.url === "/redirect") {
    res.writeHead(302, {
      Location: "/article",
      "Set-Cookie": "ignored_response_cookie=must_not_be_retained; HttpOnly; Path=/"
    });
    res.end();
    return;
  }
  if (req.url === "/protected") {
    if (req.headers.cookie !== syntheticCookie) {
      res.writeHead(401);
      res.end("authentication required");
      return;
    }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(articleHtml().replaceAll("后台静默导入合成文章", "精确域名 Cookie 合成文章"));
    return;
  }
  if (req.url === "/cross-redirect") {
    res.writeHead(302, { Location: `${crossHostBase}/cross-target` });
    res.end();
    return;
  }
  if (req.url === "/article") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(articleHtml());
    return;
  }
  if (req.url === "/auth") {
    res.writeHead(302, { Location: "/login" });
    res.end();
    return;
  }
  if (req.url === "/login") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end('<!doctype html><html><body><form action="/login"><input type="password"><button>登录</button></form></body></html>');
    return;
  }
  if (req.url === "/js") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end('<!doctype html><html><body><div id="app"></div><noscript>Please enable JavaScript</noscript><script src="/app.js"></script></body></html>');
    return;
  }
  res.writeHead(404);
  res.end("not found");
});

const crossHostServer = http.createServer((req, res) => {
  crossHostCookies.push(req.headers.cookie || null);
  if (req.url === "/cross-target") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(articleHtml().replaceAll("后台静默导入合成文章", "跨 hostname 重定向合成文章"));
    return;
  }
  res.writeHead(404);
  res.end("not found");
});

const sourcePort = await listen(sourceServer);
const crossHostPort = await listen(crossHostServer, "localhost");
crossHostBase = `http://localhost:${crossHostPort}`;
const appPort = await freePort();
const sourceBase = `http://127.0.0.1:${sourcePort}`;
const appBase = `http://127.0.0.1:${appPort}`;
const invalidCookieApp = spawn(process.execPath, [appScript], {
  cwd: path.dirname(appScript),
  windowsHide: true,
  stdio: ["ignore", "ignore", "pipe"],
  env: {
    ...process.env,
    NODE_ENV: "test",
    PROGRESSIVE_READING_WORKFLOW_ROOT: workflowRoot,
    PROGRESSIVE_READING_APP_PORT: String(appPort),
    PROGRESSIVE_READING_WRITE_SERVER_INFO: "false",
    [URL_COOKIE_ENV]: JSON.stringify({ schema: URL_COOKIE_SCHEMA, cookies: { "*.invalid.test": syntheticCookie } })
  }
});
let invalidCookieStderr = "";
invalidCookieApp.stderr.on("data", (chunk) => { invalidCookieStderr += chunk.toString(); });
const invalidCookieExit = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("invalid_cookie_config_did_not_fail_startup")), 10_000);
  invalidCookieApp.once("exit", (code) => {
    clearTimeout(timer);
    resolve(code);
  });
});
assert.notEqual(invalidCookieExit, 0);
assert.match(invalidCookieStderr, /url_cookie_map_invalid_exact_hostname/);
assert.doesNotMatch(invalidCookieStderr, /fixture_only_not_real/);

let stderr = "";
const app = spawn(process.execPath, [appScript], {
  cwd: path.dirname(appScript),
  windowsHide: true,
  stdio: ["ignore", "pipe", "pipe"],
  env: {
    ...process.env,
    NODE_ENV: "test",
    PROGRESSIVE_READING_WORKFLOW_ROOT: workflowRoot,
    PROGRESSIVE_READING_APP_PORT: String(appPort),
    PROGRESSIVE_READING_WRITE_SERVER_INFO: "false",
    PROGRESSIVE_READING_BROWSER_PREPROCESS_TEST_PRODUCER: "synthetic",
    [URL_COOKIE_ENV]: "",
    [CHROME_COOKIE_SNAPSHOT_PATH_ENV]: snapshotPath
  }
});
app.stderr.on("data", (chunk) => { stderr += chunk.toString(); });

async function verifyRetainedRss() {
  const requestsBeforeCache = observedCookies.length;
  for (const mode of ["original_text", "standard_preprocess"]) {
    const cached = await postJson(`${appBase}/api/browser-import/requests`, {
      urls: [`${sourceBase}/retained-rss-${mode}`],
      source: "rss_auto_import",
      destination_folder: "RSS/保留正文",
      processing_mode: mode,
      cached_rss_article: {
        title: "已接收的旧文章",
        markdown: "先前收到的完整正文。\n\n- 保留来源段落。\n- 保留列表格式。",
        published_at: "2026-08-31T16:00:00Z"
      }
    });
    const done = await waitForJson(`${appBase}/api/browser-import/requests/${cached.request_id}`, value => value.terminal);
    const result = done.results[0];
    assert.ok(["imported", "imported_with_warnings"].includes(result.status), JSON.stringify(result));
    assert.equal(result.receipt.processing_mode, mode);
    assert.equal(result.receipt.source_reused, "retained_rss_fulltext");
    if (mode === "original_text") assert.equal(result.receipt.llm_used, false);
    const file = result.artifacts.find(artifact => artifact.kind === "markdown").path;
    assert.ok(file.includes(path.join("RSS","保留正文")));
    assert.match(await fs.readFile(file,"utf8"), /先前收到的完整正文/u);
  }
  assert.equal(observedCookies.length, requestsBeforeCache, "retained RSS must not refetch the source page");
}

try {
  const health = await waitForJson(`${appBase}/api/highlights/health`, (value) => value.status === "ok");
  if (process.argv.includes("--retained-rss")) {
    await verifyRetainedRss();
    console.log(JSON.stringify({status:"passed",check:"retained_rss_fulltext_both_import_modes"}));
  } else {
  assert.equal(health.standardImport.defaultTransport, "background_fetch");
  assert.equal(health.standardImport.browserTabCreatedOnNormalPath, false);
  assert.equal(health.standardImport.cookiePolicy, "versioned_local_snapshot_domain_hostonly_path_secure_expiry_matching");
  assert.equal(health.standardImport.authenticatedFetch.configured, true);
  assert.equal(health.standardImport.authenticatedFetch.source, "versioned_local_snapshot");
  assert.equal(health.standardImport.authenticatedFetch.cookie_count, 1);
  assert.equal(health.standardImport.authenticatedFetch.domain_count, 1);
  assert.equal(health.standardImport.authenticatedFetch.values_exposed, false);
  assert.deepEqual(health.browserImportBroker.executionContract.extension_claim, {
    enabled: false,
    worker_status: "retired",
    claimable_statuses: []
  });
  assert.doesNotMatch(JSON.stringify(health), /synthetic_session|127\.0\.0\.1/);

  const created = await postJson(`${appBase}/api/browser-import/requests`, {
    urls: [`${sourceBase}/redirect`, `${sourceBase}/protected`, `${sourceBase}/cross-redirect`, `${sourceBase}/auth`, `${sourceBase}/js`],
    source: "browser_extension_entry",
    client_request_id: "browser-entry-fixture-1",
    user_instruction: "只整理结构，保留作者原有视角",
    transport: "browser_capture"
  });
  assert.equal(created.transport, "background_fetch");
  const completed = await waitForJson(
    `${appBase}/api/browser-import/requests/${encodeURIComponent(created.request_id)}`,
    (value) => value.terminal === true
  );
  assert.equal(completed.status, "completed_with_degradations");
  assert.equal(completed.imported, 3);
  assert.equal(completed.requires_browser_auth, 1);
  assert.equal(completed.requires_js_render, 1);
  assert.deepEqual(completed.results.map((item) => item.status), ["imported", "imported", "imported", "requires_browser_auth", "requires_js_render"]);
  assert.equal(completed.results[0].final_url, `${sourceBase}/article`);
  assert.deepEqual(completed.results[0].redirect_chain, [{ status: 302, from_url: `${sourceBase}/redirect`, to_url: `${sourceBase}/article` }]);
  assert.equal(completed.results[0].source_metadata.source_url, `${sourceBase}/redirect`);
  assert.equal(completed.results[0].source_metadata.canonical_url, `${sourceBase}/article`);
  assert.match(await fs.readFile(completed.results[0].artifacts[0].path, "utf8"), new RegExp(`^source_url: ${JSON.stringify(`${sourceBase}/redirect`).replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}$`, "mu"));
  assert.equal(completed.results[0].source_metadata.content_integrity.complete, true);
  assert.equal(completed.results[0].receipt.browser_tab_created, false);
  assert.equal(completed.results[0].receipt.cookie_policy, "versioned_snapshot_cookie_matching_no_store");
  assert.equal(completed.results[1].receipt.authenticated_fetch, true);
  assert.equal(completed.results[2].final_url, `${crossHostBase}/cross-target`);

  const duplicate = await postJson(`${appBase}/api/browser-import/requests`, {
    urls: [`${sourceBase}/redirect`, `${sourceBase}/protected`, `${sourceBase}/cross-redirect`, `${sourceBase}/auth`, `${sourceBase}/js`],
    source: "browser_extension_entry",
    client_request_id: "browser-entry-fixture-1"
  });
  assert.equal(duplicate.request_id, created.request_id);

  const browserClaim = await fetch(`${appBase}/api/browser-import/tasks/claim?worker_id=fixture-browser&claim_id=auth-only-check`).then((response) => response.json());
  assert.equal(browserClaim.task, null);
  assert.equal(browserClaim.status, "extension_worker_retired");
  assert.equal(browserClaim.claim_enabled, false);
  assert.deepEqual(browserClaim.claimable_statuses, []);

  const hitsBeforeReuse = observedCookies.length;
  const obsidianFirst = await postJson(`${appBase}/api/highlights/import-local-urls`, {
    urls: [`${sourceBase}/article`],
    source: "obsidian_local_ir",
    client_request_id: "obsidian-entry-fixture-1",
    user_instruction: "只整理结构，保留作者原有视角"
  });
  assert.equal(obsidianFirst.transport, "background_fetch");
  assert.equal(obsidianFirst.status, "completed", JSON.stringify(obsidianFirst.results));
  assert.equal(obsidianFirst.results[0].status, "idempotent_replay");
  assert.equal(obsidianFirst.results[0].artifacts[0].path, completed.results[0].artifacts[0].path, 'the canonical URL must reuse the redirect import across entry routes');
  assert.equal(obsidianFirst.results[0].receipt.model_calls, 0);

  const obsidianReplay = await postJson(`${appBase}/api/highlights/import-local-urls`, {
    urls: [`${sourceBase}/article`],
    source: "obsidian_local_ir",
    client_request_id: "obsidian-entry-fixture-2",
    user_instruction: "只整理结构，保留作者原有视角"
  });
  assert.equal(obsidianReplay.results[0].status, "idempotent_replay");
  assert.equal(obsidianReplay.results[0].receipt.existing_article_preserved, true);
  assert.equal(obsidianReplay.results[0].artifacts[0].path, obsidianFirst.results[0].artifacts[0].path);

  assert.equal(observedCookies.length, hitsBeforeReuse, 'reuse must not fetch or process the source again');
  assert.ok(observedCookies.length >= 6);
  assert.ok(observedCookies.every((value) => value === syntheticCookie), "the configured synthetic Cookie must apply only to its exact hostname");
  assert.ok(crossHostCookies.length >= 1 && crossHostCookies.every((value) => value === null), "redirects to another hostname must strip the source hostname Cookie");
  await verifyRetainedRss();
  assert.doesNotMatch(await allTextFiles(workflowRoot), /synthetic_session|fixture_only_not_real/, "broker, receipts, Markdown and audit files must not persist Cookie values");

  console.log(JSON.stringify({
    status: "passed",
    checks: [
      "browser_and_obsidian_share_background_broker",
      "server_exclusive_normal_claim",
      "extension_worker_retired_no_claim",
      "manual_redirect_chain",
      "body_integrity_receipt",
      "requires_browser_auth",
      "requires_js_render",
      "standard_preprocess",
      "idempotent_replay",
      "retained_rss_fulltext_both_import_modes",
      "versioned_snapshot_exact_hostname_cookie",
      "invalid_cookie_config_fails_startup_without_secret_echo",
      "cross_hostname_cookie_stripping",
      "no_cookie_persistence",
      "redacted_health"
    ],
    request_status: completed.status,
    obsidian_replay_status: obsidianReplay.results[0].status
  }, null, 2));
  }
} catch (error) {
  error.message = `${error.message}\napp_stderr=${stderr}`;
  throw error;
} finally {
  app.kill();
  await close(sourceServer);
  await close(crossHostServer);
  await fs.rm(testRoot, { recursive: true, force: true });
}
