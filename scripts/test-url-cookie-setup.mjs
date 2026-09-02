import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { URL_COOKIE_ENV, URL_COOKIE_SCHEMA, URL_COOKIE_SETUP_ORIGIN } from "./url-background-fetch.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appScript = path.join(__dirname, "progressive-reading-app.mjs");
const setupScript = path.join(__dirname, "setup-url-cookie-map.mjs");
const workflowRoot = await fs.mkdtemp(path.join(os.tmpdir(), "local-ir-cookie-setup-"));
const syntheticSecrets = /synthetic_setup_zhihu|synthetic_setup_x|synthetic_foreign_secret/u;

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
  throw new Error("url_cookie_setup_test_no_free_port");
}

function spawnCaptured(command, args, options = {}) {
  const child = spawn(command, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"], ...options });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
  child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
  const completed = new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal, stdout, stderr })));
  return { child, completed, output: () => ({ stdout, stderr }) };
}

async function waitForHealth(baseUrl, predicate = () => true) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/api/highlights/health`);
      const health = await response.json();
      if (response.ok && predicate(health)) return health;
    } catch {
      // App startup is asynchronous.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("url_cookie_setup_test_health_timeout");
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

const port = await freePort();
const baseUrl = `http://127.0.0.1:${port}`;
const app = spawnCaptured(process.execPath, [appScript], {
  cwd: __dirname,
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

try {
  const initial = await waitForHealth(baseUrl);
  assert.equal(initial.cookieSync.legacySchema, "local-ir.url-cookie-sync/v1");
  assert.equal(initial.cookieSync.legacySetupOrigin, URL_COOKIE_SETUP_ORIGIN);
  assert.equal(initial.standardImport.authenticatedFetch.configured, false);

  const validMap = JSON.stringify({
    schema: URL_COOKIE_SCHEMA,
    cookies: {
      "www.zhihu.com": "z_c0=synthetic_setup_zhihu",
      "x.com": "auth_token=synthetic_setup_x"
    }
  });
  const setup = spawnCaptured(process.execPath, [setupScript, "--port", String(port), "--json"], {
    cwd: __dirname,
    env: { ...process.env, [URL_COOKIE_ENV]: validMap }
  });
  const setupResult = await setup.completed;
  assert.equal(setupResult.code, 0, setupResult.stderr);
  assert.equal(setupResult.stderr, "");
  assert.doesNotMatch(setupResult.stdout, syntheticSecrets);
  const receipt = JSON.parse(setupResult.stdout);
  assert.equal(receipt.status, "synchronized");
  assert.equal(receipt.port, port);
  assert.equal(receipt.cookie_count, 2);
  assert.equal(receipt.domain_count, 2);
  assert.equal(receipt.skipped_count, 0);
  assert.match(receipt.fingerprint, /^sha256:[a-f0-9]{64}$/u);
  assert.equal(receipt.cookie_values_exposed, false);

  const configured = await waitForHealth(baseUrl, (health) => health.standardImport.authenticatedFetch.domain_count === 2);
  assert.equal(configured.standardImport.authenticatedFetch.configured, true);
  assert.doesNotMatch(JSON.stringify(configured), syntheticSecrets);

  const invalid = spawnCaptured(process.execPath, [setupScript, "--port", String(port)], {
    cwd: __dirname,
    env: {
      ...process.env,
      [URL_COOKIE_ENV]: JSON.stringify({ schema: URL_COOKIE_SCHEMA, cookies: { "example.com": "foreign=synthetic_foreign_secret" } })
    }
  });
  const invalidResult = await invalid.completed;
  assert.equal(invalidResult.code, 1);
  assert.match(invalidResult.stderr, /url_cookie_setup_hostname_not_allowed/u);
  assert.doesNotMatch(`${invalidResult.stdout}\n${invalidResult.stderr}`, syntheticSecrets);

  const missing = spawnCaptured(process.execPath, [setupScript, "--port", String(port)], {
    cwd: __dirname,
    env: { ...process.env, [URL_COOKIE_ENV]: "" }
  });
  const missingResult = await missing.completed;
  assert.equal(missingResult.code, 1);
  assert.match(missingResult.stderr, /url_cookie_setup_env_required/u);

  assert.doesNotMatch(`${app.output().stdout}\n${app.output().stderr}`, syntheticSecrets);
  assert.doesNotMatch(await allTextFiles(workflowRoot), syntheticSecrets);

  console.log(JSON.stringify({
    status: "passed",
    checks: [
      "independent_network_setup_tool",
      "process_environment_input_only",
      "exact_allowed_hostnames_only",
      "loopback_service_contract_probe",
      "count_and_fingerprint_only_receipt",
      "no_secret_in_cli_output_service_output_health_or_disk",
      "normal_url_import_chain_unchanged"
    ]
  }, null, 2));
} finally {
  if (app.child.exitCode === null) {
    app.child.kill();
    await app.completed;
  }
  await fs.rm(workflowRoot, { recursive: true, force: true });
}
