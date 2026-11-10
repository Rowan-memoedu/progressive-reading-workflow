import assert from "node:assert/strict";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appPath = path.join(__dirname, "progressive-reading-app.mjs");

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function waitFor(url, timeoutMs = 15000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error("learning_app_start_timeout");
}

async function main() {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "learning-app-test-"));
  const port = await freePort();
  const child = spawn(process.execPath, [appPath], {
    env: {
      ...process.env,
      PROGRESSIVE_READING_APP_PORT: String(port),
      PROGRESSIVE_READING_WRITE_SERVER_INFO: "false",
      LEARNING_PROJECT_ROOT: path.join(temp, "projects")
    },
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
  try {
    const base = `http://127.0.0.1:${port}`;
    await waitFor(`${base}/api/learning/projects`);
    let page = await fetch(base);
    assert.ok((await page.text()).includes("GitHub 项目学习"));
    let response = await fetch(`${base}/api/learning/projects`);
    let body = await response.json();
    assert.deepEqual(body.projects, []);

    response = await fetch(`${base}/api/learning/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ repoUrl: "https://example.com/not-github" })
    });
    assert.equal(response.status, 400);

    response = await fetch(`${base}/api/learning/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ repoUrl: "https://github.com/example/api-fixture", goal: "API 验证" })
    });
    body = await response.json();
    assert.equal(response.status, 201);
    assert.equal(body.created, true);
    const id = body.manifest.id;

    response = await fetch(`${base}/api/learning/projects`);
    body = await response.json();
    assert.equal(body.projects.length, 1);
    assert.equal(body.projects[0].id, id);

    response = await fetch(`${base}/api/learning/projects/${encodeURIComponent(id)}`);
    body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.state.projectId, id);

    response = await fetch(`${base}/api/learning/projects/${encodeURIComponent(id)}/doctor`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}"
    });
    body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.status, "needs_action");
    assert.ok(body.userActions.some((item) => item.id === "fetch_workspace"));
    process.stdout.write(`${JSON.stringify({ ok: true, apiProjectId: id, port }, null, 2)}\n`);
  } finally {
    child.kill("SIGTERM");
    await new Promise((resolve) => child.once("close", resolve));
    await fs.rm(temp, { recursive: true, force: true });
  }
  if (stderr.trim()) throw new Error(stderr.trim());
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exit(1);
});
