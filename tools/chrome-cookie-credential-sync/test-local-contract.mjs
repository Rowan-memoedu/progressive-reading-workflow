import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const toolRoot = path.dirname(fileURLToPath(import.meta.url));
const workflowRoot = path.resolve(toolRoot, "..", "..");
const appScript = path.join(workflowRoot, "scripts", "progressive-reading-app.mjs");
const workerSource = await fs.readFile(path.join(toolRoot, "service-worker.js"), "utf8");
const isolatedRoot = await fs.mkdtemp(path.join(os.tmpdir(), "local-ir-cookie-sync-tool-"));
assert.equal(path.resolve(isolatedRoot).startsWith(path.resolve(os.tmpdir())), true, "temporary root must stay inside the system temp directory");

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
  throw new Error("cookie_sync_tool_test_no_free_port");
}

function startApp(port) {
  const child = spawn(process.execPath, [appScript], {
    cwd: workflowRoot,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      PROGRESSIVE_READING_URL_COOKIE_MAP_JSON: "",
      PROGRESSIVE_READING_WORKFLOW_ROOT: isolatedRoot,
      PROGRESSIVE_READING_APP_PORT: String(port),
      PROGRESSIVE_READING_WRITE_SERVER_INFO: "false",
      PROGRESSIVE_READING_BROWSER_PREPROCESS_TEST_PRODUCER: "synthetic",
      NODE_ENV: "test"
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
      // The isolated service starts asynchronously.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("cookie_sync_tool_health_timeout");
}

async function allFileText(root) {
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

const port = await freePort();
const baseUrl = `http://127.0.0.1:${port}`;
const extensionOrigin = `chrome-extension://${"a".repeat(32)}`;
const privateValues = ["root", "secure", "partitioned", "expired"].map((part) => `synthetic_${part}_private`);
const sourceCookies = [
  {
    name: "root_fixture",
    value: privateValues[0],
    domain: ".synthetic.test",
    hostOnly: false,
    path: "/",
    secure: false,
    httpOnly: true,
    sameSite: "lax",
    session: true,
    storeId: "0"
  },
  {
    name: "secure_fixture",
    value: privateValues[1],
    domain: "auth.synthetic.test",
    hostOnly: true,
    path: "/account",
    secure: true,
    httpOnly: true,
    sameSite: "strict",
    session: false,
    expirationDate: 2_000_000_000,
    storeId: "0"
  },
  {
    name: "partitioned_fixture",
    value: privateValues[2],
    domain: ".partitioned.test",
    hostOnly: false,
    path: "/",
    secure: true,
    httpOnly: false,
    sameSite: "no_restriction",
    session: true,
    storeId: "0",
    partitionKey: { topLevelSite: "https://top.synthetic" }
  },
  {
    name: "expired_fixture",
    value: privateValues[3],
    domain: ".expired.test",
    hostOnly: false,
    path: "/",
    secure: false,
    httpOnly: false,
    sameSite: "unspecified",
    session: false,
    expirationDate: 1,
    storeId: "0"
  }
];

let app = startApp(port);
try {
  const initialHealth = await waitForHealth(baseUrl);
  assert.equal(initialHealth.cookieSync.schema, "local-ir.chrome-cookie-jar-sync/v1");
  assert.equal(initialHealth.cookieSync.endpoint, "/api/browser-import/cookies/sync");
  assert.equal(initialHealth.cookieSync.maxCookies, 50_000);
  assert.equal(initialHealth.cookieSync.maxBodyBytes, 33_554_432);
  assert.equal(initialHealth.cookieSync.atomicReplace, true);
  assert.equal(initialHealth.cookieSync.state.cookie_count, 0);

  let listener = null;
  let cookieReadCount = 0;
  const chrome = {
    runtime: {
      lastError: null,
      onMessage: { addListener(value) { listener = value; } }
    },
    cookies: {
      getAll(details, done) {
        cookieReadCount += 1;
        assert.equal(Object.keys(details).length, 0);
        done(sourceCookies);
      }
    }
  };
  const routedFetch = async (url, options = {}) => {
    const parsed = new URL(String(url));
    if (parsed.hostname !== "127.0.0.1" || Number(parsed.port) !== port) {
      throw new Error("test_port_offline");
    }
    const headers = new Headers(options.headers || {});
    if (parsed.pathname === "/api/browser-import/cookies/sync") headers.set("Origin", extensionOrigin);
    return fetch(url, { ...options, headers });
  };
  const sandbox = {
    chrome,
    fetch: routedFetch,
    Response,
    Headers,
    AbortController,
    TextEncoder,
    URL,
    setTimeout,
    clearTimeout
  };
  vm.runInContext(workerSource, vm.createContext(sandbox), { filename: "service-worker.js" });
  assert.equal(cookieReadCount, 0, "worker startup must remain idle");

  const publicResponse = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("cookie_sync_tool_runtime_timeout")), 10_000);
    const keepAlive = listener({ type: "sync-all-chrome-cookies" }, {}, (value) => {
      clearTimeout(timer);
      resolve(value);
    });
    assert.equal(keepAlive, true);
  });
  assert.equal(cookieReadCount, 1, "one click must perform exactly one full Cookie read");
  assert.equal(publicResponse?.ok, true);
  assert.equal(publicResponse?.totalCount, 4);
  assert.equal(publicResponse?.domainCount, 2);
  assert.equal(publicResponse?.skippedCount, 2);
  assert.equal(privateValues.some((value) => JSON.stringify(publicResponse).includes(value)), false, "runtime receipt must not expose values");

  const configured = await waitForHealth(baseUrl, (health) => health.cookieSync.state.cookie_count === 2);
  assert.equal(configured.cookieSync.state.domain_count, 2);
  assert.equal(configured.cookieSync.state.skipped_count, 2);
  assert.equal(configured.cookieSync.state.skipped_partitioned_count, 1);
  assert.equal(configured.cookieSync.state.skipped_expired_count, 1);
  assert.equal(privateValues.some((value) => JSON.stringify(configured).includes(value)), false, "health must not expose values");
  assert.equal(privateValues.some((value) => `${app.output.stdout}\n${app.output.stderr}`.includes(value)), false, "service output must not expose values");
  const isolatedFileText = await allFileText(isolatedRoot);
  assert.equal(privateValues.some((value) => isolatedFileText.includes(value)), false, "isolated service files must not contain values");

  console.log(JSON.stringify({
    status: "passed",
    checks: [
      "real_local_health_contract",
      "real_atomic_cookie_jar_sync",
      "complete_attribute_transport",
      "partitioned_and_expired_skip_counts",
      "count_only_extension_receipt",
      "no_value_in_health_logs_or_files",
      "no_real_chrome_cookie_read"
    ]
  }, null, 2));
} finally {
  await stopApp(app.child).catch(() => undefined);
  await fs.rm(isolatedRoot, { recursive: true, force: true });
}
