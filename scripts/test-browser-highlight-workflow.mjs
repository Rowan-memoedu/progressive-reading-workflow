import fs from "node:fs/promises";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const workflowRoot = path.resolve(__dirname, "..");
const appScript = path.join(__dirname, "progressive-reading-app.mjs");
const serverInfoPath = path.join(workflowRoot, "imports", "app-server.json");
const port = Number(process.env.BROWSER_HIGHLIGHT_TEST_PORT || 39229);
const baseUrl = `http://127.0.0.1:${port}`;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, options);
  const text = await response.text();
  const data = text ? JSON.parse(text) : {};
  if (!response.ok) {
    const error = new Error(data.error || `http_${response.status}`);
    error.status = response.status;
    throw error;
  }
  return data;
}

async function requestRaw(url, options = {}) {
  return fetch(url, options);
}

async function waitForHealth() {
  let lastError = null;
  for (let i = 0; i < 50; i += 1) {
    try {
      return await requestJson(`${baseUrl}/api/highlights/health`);
    } catch (error) {
      lastError = error;
      await delay(250);
    }
  }
  throw lastError || new Error("server_not_ready");
}

async function run() {
  const previousServerInfo = await fs.readFile(serverInfoPath, "utf8").catch(() => null);
  await fs.rm(serverInfoPath, { force: true }).catch(() => {});
  const child = spawn(process.execPath, [appScript], {
    cwd: workflowRoot,
    env: { ...process.env, PROGRESSIVE_READING_APP_PORT: String(port), PROGRESSIVE_READING_WRITE_SERVER_INFO: "false" },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true
  });

  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
  child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });

  const createdTargets = new Set();
  try {
    const health = await waitForHealth();
    if (health.status !== "ok") throw new Error("health_not_ok");

    const testPageResponse = await requestRaw(`${baseUrl}/browser-highlight-test`);
    if (testPageResponse.status !== 200) throw new Error("browser_highlight_test_page_not_available");
    const testPageHtml = await testPageResponse.text();
    if (!testPageHtml.includes("Local IR 浏览器高亮测试页")) throw new Error("browser_highlight_test_page_content_missing");

    const optionsResponse = await requestRaw(`${baseUrl}/api/highlights/capture`, { method: "OPTIONS" });
    if (optionsResponse.status !== 204) throw new Error("options_preflight_not_supported");
    if (optionsResponse.headers.get("access-control-allow-origin") !== "*") {
      throw new Error("cors_allow_origin_missing");
    }

    const testUrl = "https://local.test/browser-highlight-workflow";
    const testHtml = `<!doctype html>
<html>
<head><title>Browser Highlight Workflow Test A</title></head>
<body>
  <main>
    <article>
      <h1>Browser Highlight Workflow Test A</h1>
      <p>This paragraph belongs to the full article body. First synthetic browser highlight. It should remain readable after conversion.</p>
      <p>A later paragraph contains Second synthetic browser highlight. This sentence verifies that the second capture updates the same Markdown file.</p>
      <p>The page also includes enough surrounding prose for Readability to treat it as an article instead of a tiny fragment.</p>
    </article>
  </main>
</body>
</html>`;
    const testPageText = [
      "Browser Highlight Workflow Test A",
      "This paragraph belongs to the full article body. First synthetic browser highlight. It should remain readable after conversion.",
      "A later paragraph contains Second synthetic browser highlight. This sentence verifies that the second capture updates the same Markdown file.",
      "The page also includes enough surrounding prose for Readability to treat it as an article instead of a tiny fragment."
    ].join("\n\n");
    const first = await requestJson(`${baseUrl}/api/highlights/capture`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url: testUrl,
        title: "Browser Highlight Workflow Test A",
        selectionText: "First synthetic browser highlight.",
        context: "Before. First synthetic browser highlight. After.",
        pageText: testPageText,
        html: testHtml,
        createdAt: "2026-07-08T00:00:01.000Z",
        sourceId: "synthetic-a"
      })
    });
    createdTargets.add(first.target);

    const second = await requestJson(`${baseUrl}/api/highlights/capture`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url: testUrl,
        title: "Browser Highlight Workflow Test B",
        selectionText: "Second synthetic browser highlight.",
        context: "Before. Second synthetic browser highlight. After.",
        pageText: testPageText,
        html: testHtml,
        createdAt: "2026-07-08T00:00:02.000Z",
        sourceId: "synthetic-b"
      })
    });
    createdTargets.add(second.target);

    if (first.target !== second.target) throw new Error("same_url_did_not_append_to_same_file");
    const content = await fs.readFile(first.target, "utf8");
    for (const expected of [
      "import_method: browser_page_highlight",
      "highlight_mode: full_page",
      "This paragraph belongs to the full article body.",
      "==First synthetic browser highlight.==",
      "==Second synthetic browser highlight.=="
    ]) {
      if (!content.includes(expected)) throw new Error(`missing_expected_content:${expected}`);
    }

    const unlocated = await requestJson(`${baseUrl}/api/highlights/capture`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url: "https://local.test/browser-highlight-unlocated",
        title: "Browser Highlight Unlocated Test",
        selectionText: "This selected text cannot be found in the converted Markdown.",
        context: "A context block that is also absent from the converted Markdown.",
        pageText: "The converted page body exists, but it does not contain the missing selected phrase.",
        html: "<!doctype html><html><body><main><article><h1>Browser Highlight Unlocated Test</h1><p>The converted page body exists, but it does not contain the missing selected phrase.</p><p>Additional text keeps the fallback readable.</p></article></main></body></html>",
        createdAt: "2026-07-08T00:00:03.000Z",
        sourceId: "synthetic-unlocated"
      })
    });
    createdTargets.add(unlocated.target);
    const unlocatedContent = await fs.readFile(unlocated.target, "utf8");
    for (const expected of [
      "import_method: browser_page_highlight",
      "## 未定位高亮",
      "==This selected text cannot be found in the converted Markdown.=="
    ]) {
      if (!unlocatedContent.includes(expected)) throw new Error(`missing_unlocated_content:${expected}`);
    }

    let invalidRejected = false;
    try {
      await requestJson(`${baseUrl}/api/highlights/capture`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: testUrl, title: "Invalid", selectionText: "" })
      });
    } catch (error) {
      invalidRejected = error.status === 400 && /empty_selection/.test(error.message);
    }
    if (!invalidRejected) throw new Error("empty_selection_was_not_rejected");

    console.log(JSON.stringify({
      status: "passed",
      health: health.status,
      target: first.target,
      checks: ["health", "test_page", "cors_preflight", "full_page_capture", "same_url_update", "inline_highlight_markdown", "unlocated_fallback", "invalid_payload"]
    }, null, 2));
  } finally {
    for (const target of createdTargets) {
      await fs.rm(target, { force: true }).catch(() => {});
    }
    await fs.rm(serverInfoPath, { force: true }).catch(() => {});
    child.kill();
    await delay(250);
    if (process.platform === "win32" && child.pid) {
      spawnSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true });
    } else if (child.exitCode === null) {
      child.kill("SIGKILL");
    }
    if (previousServerInfo !== null) {
      await fs.mkdir(path.dirname(serverInfoPath), { recursive: true });
      await fs.writeFile(serverInfoPath, previousServerInfo, "utf8").catch(() => {});
    }
    if (process.env.BROWSER_HIGHLIGHT_TEST_DEBUG) {
      console.error(stdout);
      console.error(stderr);
    }
  }
}

run().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
