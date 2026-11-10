// Isolated HTTP acceptance fixture. No external sources, models, real cookies or user articles.
import fs from "node:fs/promises";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
export async function startFixture({ producer = "synthetic", columnFixture = false, cookieDataRoot = "", sitePlanPath = "" } = {}) {
  const artifactsRoot = process.env.WEB_IMPORT_TEST_ROOT || "D:/Artifacts/ProgressiveReading/web-import";
  await fs.mkdir(artifactsRoot, { recursive: true });
  const root = await fs.mkdtemp(path.join(artifactsRoot, "fixture-"));
  const workflowRoot = path.join(root, "workflow");
  await fs.mkdir(path.join(workflowRoot, "config"), { recursive: true });
  await fs.copyFile(path.join(projectRoot, "config/import-destination-routes.json"), path.join(workflowRoot, "config/import-destination-routes.json"));
  const syntheticSnapshotPath = path.join(root, "synthetic-column-cookie.json");
  if (columnFixture) await fs.writeFile(syntheticSnapshotPath, JSON.stringify({
    schema: "local.chrome-cookie-snapshot", schemaVersion: 1, sensitivity: "local_sensitive_credential",
    snapshotId: crypto.randomUUID(), generatedAt: new Date().toISOString(),
    producer: { name: "chrome-cookie-sync-extension", version: "1.1.0", api: "chrome.cookies.getAll", partitionQuery: "all_partition_keys" },
    profile: { browser: "Google Chrome", scope: "current_regular_profile", storeIds: ["0"] },
    cookies: [{ name: "fixture_column_auth", value: "synthetic-only", domain: ".zhihu.com", hostOnly: false, path: "/", secure: true, httpOnly: true, sameSite: "lax", session: true, expirationDate: null, storeId: "0", partitionKey: null }]
  }));
  let recovered = false;
  const hits = [];
  const source = http.createServer(async (req, res) => {
    hits.push(req.url);
    let titlePath = req.url;
    if (req.url.startsWith("/fixture-fetch?")) {
      const requested = new URL(new URL(req.url, "http://127.0.0.1").searchParams.get("url"));
      titlePath = requested.pathname;
      if (/^\/api\/(?:v4\/)?columns\//u.test(requested.pathname)) {
        res.setHeader("Content-Type", "application/json");
        const article = id => ({ type: "article", id: String(id), title: `合成文章 ${id}` });
        if (requested.pathname.includes("c_incomplete")) { res.end(JSON.stringify({ data: [article(2000)], paging: { is_end: false, totals: 3 } })); return; }
        if (requested.pathname.includes("pinned-items")) { res.end(JSON.stringify({ data: [article(2000), article(2100)] })); return; }
        const all = [...Array.from({ length: 53 }, (_, i) => article(2000 + i)), { type: "answer", id: "3000" }];
        const offset = Number(requested.searchParams.get("offset") || 0);
        res.end(JSON.stringify({ data: all.slice(offset, offset + 20), paging: { totals: all.length, is_end: offset + 20 >= all.length,
          next: `https://zhuanlan.zhihu.com${requested.pathname}?offset=${offset+20}&limit=20` } })); return;
      }
      if (requested.pathname === "/p/2001" && !recovered) { res.writeHead(503); res.end("fixture_article_unavailable"); return; }
    }
    if (req.url === "/auth") { res.writeHead(401); res.end("sign in required"); return; }
    if (req.url.startsWith("/cookie-required") && req.headers.cookie !== "fixture_auth=synthetic-live") { res.writeHead(401); res.end("sign in required"); return; }
    if (req.url === "/flaky" && !recovered) { res.writeHead(503); res.end("synthetic_unavailable"); return; }
    if (req.url === "/js") { res.setHeader("Content-Type", "text/html"); res.end('<html><body><div id="app"></div><script src="/app.js"></script><noscript>Please enable JavaScript</noscript></body></html>'); return; }
    if (req.url.startsWith("/slow")) await wait(1500);
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    const text = "这是一篇仅用于网页导入验收的合成材料。材料说明，批量提交时应先识别来源链接，并检查每一项结果；正式文件与回执一致后才能确认导入完成。如果网络暂时断开，应保留已有请求并继续查询。已存在的正文和人工标注需要保留，失败原因也应能在重试后回溯。";
    res.end(`<!doctype html><html lang="zh"><head><title>网页导入合成材料 ${titlePath}</title></head><body><main><article><h1>网页导入合成材料</h1>${Array.from({ length: 8 }, (_, i) => `<p>第 ${i + 1} 段：${text}</p>`).join("")}</article></main></body></html>`);
  });
  await new Promise(resolve => source.listen(0, "127.0.0.1", resolve));
  const sourceUrl = `http://127.0.0.1:${source.address().port}`;
  const env = { ...process.env, NODE_ENV: "test", PROGRESSIVE_READING_WORKFLOW_ROOT: workflowRoot,
    PROGRESSIVE_READING_APP_PORT: "0", PROGRESSIVE_READING_WRITE_SERVER_INFO: "false",
    PROGRESSIVE_READING_BROWSER_PREPROCESS_TEST_PRODUCER: producer,
    PROGRESSIVE_READING_SITE_IMPORT_TEST_PLAN: sitePlanPath,
    PROGRESSIVE_READING_COOKIE_SNAPSHOT_PATH: columnFixture ? syntheticSnapshotPath : "", PROGRESSIVE_READING_URL_COOKIE_MAP_JSON: "",
    PROGRESSIVE_READING_COOKIE_DATA_ROOT: cookieDataRoot,
    PROGRESSIVE_READING_FIXTURE_ORIGIN: columnFixture ? sourceUrl : "",
    LEARNING_PROJECT_ROOT: path.join(root, "learning") };
  // The app prints the actual listening port for ephemeral fixture instances.
  const child = spawn(process.execPath, [...(columnFixture ? ["--import", pathToFileURL(path.join(projectRoot, "scripts/browser-import-web/fixture-fetch.mjs")).href] : []), path.join(projectRoot, "scripts/progressive-reading-app.mjs")], { cwd: projectRoot, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = ""; let stderr = "";
  child.stdout.on("data", data => { stdout += data.toString(); });
  child.stderr.on("data", data => { stderr += data.toString(); });
  let baseUrl;
  for (let attempt = 0; attempt < 900; attempt += 1) {
    baseUrl = stdout.match(/Progressive reading app: (http:\/\/127\.0\.0\.1:\d+)/u)?.[1];
    if (baseUrl || child.exitCode !== null) break;
    await wait(100);
  }
  if (!baseUrl) { child.kill(); await new Promise(resolve => source.close(resolve)); await fs.writeFile(path.join(root, "startup-failure.log"), stdout + stderr); throw new Error(`fixture_start_failed:${root}`); }
  return {
    root, workflowRoot, baseUrl, sourceUrl, hits, recover() { recovered = true; },
    async stop() {
      child.kill();
      await Promise.race([new Promise(resolve => child.once("exit", resolve)), wait(3000)]);
      source.closeAllConnections(); await new Promise(resolve => source.close(resolve));
      await fs.writeFile(path.join(root, "service.log"), stdout + stderr);
      await fs.writeFile(path.join(root, "source-hits.json"), JSON.stringify(hits,null,2));
    }
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const fixture = await startFixture({ producer: process.argv.includes("--warning") ? "synthetic-invalid" : "synthetic" });
  console.log(JSON.stringify({ root: fixture.root, page: `${fixture.baseUrl}/import`, source: fixture.sourceUrl }));
  for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, async () => { await fixture.stop(); process.exit(0); });
}
