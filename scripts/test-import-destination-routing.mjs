import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  inferImportEntryRoute,
  loadImportDestinationRoutes,
  normalizeRelativeDestinationFolder,
  resolveImportDestinationFolder,
  resolveReadingDestinationRoot
} from "./import-destination-routing.mjs";
import { relocateReadingArtifacts } from "./reading-artifact-relocation.mjs";

const workflowRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const routes = await loadImportDestinationRoutes(path.join(workflowRoot, "config", "import-destination-routes.json"));
assert.equal(inferImportEntryRoute("browser_context_link"), "browser_extension");
assert.equal(resolveImportDestinationFolder(routes, {
  source: "browser_extension",
  sourceUrl: "https://example.com/a"
}), "浏览器高亮");
assert.equal(resolveImportDestinationFolder(routes, {
  source: "obsidian_local_ir",
  sourceUrl: "https://www.zhihu.com/question/1"
}), "zhihu.com");
assert.equal(resolveImportDestinationFolder(routes, {
  source: "archive-social-reading:zhihu-likes-since",
  entryRoute: "ai",
  destinationFolder: "知乎/知乎点赞",
  sourceUrl: "https://www.zhihu.com/question/1"
}), "知乎/知乎点赞");
assert.throws(() => resolveImportDestinationFolder(routes, {
  source: "ai",
  entryRoute: "ai",
  sourceUrl: "https://example.com/a"
}), /destination_folder_required_for_ai/);
assert.throws(() => normalizeRelativeDestinationFolder("../outside"), /destination_folder_invalid/);

const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "reading-destination-route-"));
try {
  const readingRoot = path.join(tempRoot, "阅读区");
  const stateRoot = path.join(tempRoot, ".local-ir", "browser-document-state");
  const sourceRoot = path.join(readingRoot, "浏览器高亮");
  await fs.mkdir(sourceRoot, { recursive: true });
  await fs.mkdir(stateRoot, { recursive: true });
  const fileName = "fixture--浏览器加工--1234567890.md";
  const markdown = '---\nsource_url: "https://zhuanlan.zhihu.com/p/1"\n---\n\n# fixture\n';
  await fs.writeFile(path.join(sourceRoot, fileName), markdown, "utf8");
  await fs.writeFile(path.join(stateRoot, `${fileName}.browser-ir.json`), JSON.stringify({
    document: { path: `阅读区/浏览器高亮/${fileName}` },
    browser: { sourceMetadata: {} }
  }), "utf8");
  const result = await relocateReadingArtifacts({
    readingRoot,
    stateRoot,
    workspaceRoot: tempRoot,
    destinationFolder: "知乎/知乎点赞",
    urls: ["https://zhuanlan.zhihu.com/p/1"],
    requireComplete: true
  });
  assert.equal(result.moved, 1);
  assert.equal(result.destination_count, 1);
  assert.equal(result.source_count, 0);
  assert.equal(result.global_identity_count, 1);
  assert.equal(result.global_duplicate_count, 0);
  assert.equal(result.wrong_folder_count, 0);
  assert.equal(await fs.readFile(path.join(resolveReadingDestinationRoot(readingRoot, "知乎/知乎点赞"), fileName), "utf8"), markdown);
  const sidecar = JSON.parse(await fs.readFile(path.join(stateRoot, `${fileName}.browser-ir.json`), "utf8"));
  assert.equal(sidecar.document.path, `阅读区/知乎/知乎点赞/${fileName}`);
  assert.equal(sidecar.browser.sourceMetadata.destination_folder, "知乎/知乎点赞");
} finally {
  await fs.rm(tempRoot, { recursive: true, force: true });
}

console.log(JSON.stringify({
  status: "passed",
  checks: ["browser_fixed_route", "obsidian_domain_route", "ai_explicit_route", "path_guard", "artifact_relocation", "sidecar_update"]
}, null, 2));
