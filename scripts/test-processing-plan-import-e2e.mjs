import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { once } from "node:events";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const base = "D:/Artifacts/ProgressiveReading/processing-plan-repair-20260928";
await fs.mkdir(base, { recursive: true });
const root = await fs.mkdtemp(path.join(base, "import-e2e-"));
const workflowRoot = path.join(root, "workflow");
await fs.mkdir(path.join(workflowRoot, "config"), { recursive: true });
await fs.copyFile(path.join(project, "config/import-destination-routes.json"), path.join(workflowRoot, "config/import-destination-routes.json"));
const body = "窗外的雨落在旧书封面上，她把书挪到灯下，继续读那封没有署名的信。清晨的车站还没有乘客，值班员慢慢打开窗户，听见远处传来的钟声。信纸上的字迹已经褪色，末尾仍然可以辨认出一句约定：明年春天，我们还会在河边相遇。她将信重新折好，放回书页之间，走出车站，街角的树上已经发出新芽。";
let fetches = 0;
const source = http.createServer((_req, res) => { fetches++; res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }); res.end(`<html><head><title>候车室</title></head><body><article><h1>候车室</h1><p>${body}</p><p>${body}</p></article></body></html>`); });
source.listen(0, "127.0.0.1"); await once(source, "listening");
const sourceBase = `http://127.0.0.1:${source.address().port}`;
const probe = http.createServer(); probe.listen(0, "127.0.0.1"); await once(probe, "listening");
const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
const apiBase = `http://127.0.0.1:${port}`;
const child = spawn(process.execPath, [path.join(project, "scripts/progressive-reading-app.mjs")], { cwd: project, windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env: {
  ...process.env, NODE_ENV: "test", PROGRESSIVE_READING_WORKFLOW_ROOT: workflowRoot,
  PROGRESSIVE_READING_APP_PORT: String(port), PROGRESSIVE_READING_WRITE_SERVER_INFO: "false",
  PROGRESSIVE_READING_BROWSER_PREPROCESS_TEST_PRODUCER: "synthetic-uncertain"
} });
let logs = ""; child.stdout.on("data", chunk => { logs += chunk; }); child.stderr.on("data", chunk => { logs += chunk; });
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function json(endpoint, data) {
  const response = await fetch(apiBase + endpoint, data === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) });
  const value = await response.json();
  assert.ok(response.ok, JSON.stringify(value)); return value;
}
async function settled(requestId) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const result = await json(`/api/browser-import/requests/${requestId}`);
    if (result.terminal) return result;
    await pause(100);
  }
  throw Error("broker did not settle");
}
const allOff = { spoken_to_written: false, structure_body: false, translate: false, include_reading_guide: false };
try {
  let health;
  for (let attempt = 0; attempt < 80; attempt++) {
    try { health = await json("/api/highlights/health"); break; } catch { await pause(100); }
  }
  assert.ok(health, logs);
  assert.equal(health.standardImport.maxWorkflowAttempts, 1);
  const created = await json("/api/browser-import/requests", { urls: [`${sourceBase}/pending`], processing_options: { spoken_to_written: false, translate: false } });
  const pending = await settled(created.request_id);
  assert.equal(pending.status, "needs_classification", JSON.stringify(pending));
  assert.equal(pending.failed, 0);
  assert.equal(pending.awaiting_input, true);
  assert.deepEqual(pending.results[0].receipt.missing_labels, ["content_profile"]);
  assert.equal(fetches, 1);
  assert.equal(pending.results[0].artifacts?.length || 0, 0);
  await fs.access(pending.results[0].receipt.pending_input_path);
  await json(`/api/browser-import/requests/${created.request_id}/classification`, { processing_options: { content_profile: "literature" } });
  const complete = await settled(created.request_id);
  assert.equal(complete.status, "completed", JSON.stringify(complete));
  assert.equal(fetches, 1, "classification resume must reuse frozen source");
  assert.equal(complete.results[0].receipt.model_calls, 0);
  assert.equal(complete.results[0].receipt.reading_guide.status, "skipped");
  const markdown = await fs.readFile(complete.results[0].artifacts.find(a => a.kind === "markdown").path, "utf8");
  assert.ok(markdown.includes(body));
  assert.doesNotMatch(markdown, /## 阅读前置卡|核心洞察|阅读前置卡:start/u);
  const alias = await json("/api/highlights/import-local-urls", { urls: [`${sourceBase}/all-off`], processing_options: allOff });
  assert.equal(alias.status, "completed", JSON.stringify(alias));
  assert.equal(alias.results[0].receipt.model_calls, 0);
  const direct = await json("/api/highlights/import-local", { processing_options: allOff, draft: {
    id: "all-off-direct", url: `${sourceBase}/direct`, title: "直接输入", pageText: body,
    html: `<article><h1>直接输入</h1><p>${body}</p></article>`, annotations: [], qaCards: [], revision: 0
  } });
  assert.equal(direct.receipt.model_calls, 0);
  const optionsFile = path.join(root, "options.json");
  const captureFile = path.join(root, "capture.json");
  await fs.writeFile(optionsFile, JSON.stringify(allOff));
  await fs.writeFile(captureFile, JSON.stringify({ layout: "flat", items: [{ url: `${sourceBase}/legacy`, title: "书面文学", html: `<h1>书面文学</h1><p>${body}</p>` }] }));
  const cli = await promisify(execFile)(process.execPath, [path.join(project, "scripts/import-web-md.mjs"), "--browser-content", captureFile, "--processing-options", optionsFile, "--out", path.join(root, "legacy"), "--staging", path.join(root, "staging")], { cwd: project, windowsHide: true });
  const cliResult = JSON.parse(cli.stdout)[0];
  assert.equal(cliResult.status, "imported", cli.stdout);
  assert.equal(cliResult.receipt.model_calls, 0);
  assert.doesNotMatch(await fs.readFile(cliResult.target, "utf8"), /阅读前置卡|核心洞察/u);
  const report = { status: "passed", evidence: "isolated real HTTP service with synthetic uncertainty; deterministic stages use no model", source_fetches: fetches, request_id: created.request_id, checks: ["pending_not_failed", "frozen_source_resume", "literature_default_off", "zero_calls", "alias_options", "direct_capture_options", "legacy_cli_shared_pipeline"] };
  await fs.writeFile(path.join(root, "acceptance.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ ...report, artifacts: root }, null, 2));
} finally {
  child.kill(); await once(child, "exit").catch(() => {});
  await new Promise(resolve => source.close(resolve));
  await fs.writeFile(path.join(root, "service.log"), logs);
}
