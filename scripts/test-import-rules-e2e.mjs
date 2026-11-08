import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { JSDOM } from "jsdom";
import { startFixture } from "./browser-import-web/fixture.mjs";
import { mountImportPage } from "./browser-import-web/app.mjs";
import { resultView } from "./browser-import-web/client.mjs";

const fixture = await startFixture({ columnFixture: true });
const evidence = { source: "local_synthetic_only", external_requests: false, checks: [], root: fixture.root };
let mounted; let dom;
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function complete() {
  const deadline = Date.now() + 180000;
  while (Date.now() < deadline) {
    if (!mounted.session.pending && !mounted.session.busy) return mounted.session.latestResults()[0];
    if (mounted.session.current?.error) throw new Error(mounted.session.current.error);
    await wait(100);
  }
  throw new Error("column_e2e_timeout");
}
try {
  console.log(`column_http_fixture: ${fixture.root}`);
  const html = await (await fetch(`${fixture.baseUrl}/import`)).text();
  dom = new JSDOM(html, { url: `${fixture.baseUrl}/import` });
  mounted = mountImportPage(dom.window.document, { fetchImpl: (route, options) => fetch(`${fixture.baseUrl}${route}`, options), pollMs: 100 });
  const doc = dom.window.document;
  const input = doc.getElementById("input");
  input.value = "https://www.zhihu.com/column/c_fixture";
  input.dispatchEvent(new dom.window.Event("input")); doc.getElementById("start").click();
  const first = await complete();
  assert.match(doc.getElementById("rules-list").textContent, /全部文章/u);
  assert.equal(first.status, "failed");
  assert.equal(first.collection.inventory.articles.length, 54);
  assert.equal(first.collection.inventory.pages, 3);
  assert.equal(first.collection.inventory.excluded_count, 1);
  assert.equal(first.receipt.imported, 53);
  assert.equal(first.receipt.failed, 1);
  assert.equal(doc.querySelectorAll(".collection-results li").length, 54);
  evidence.checks.push("rules_list_visible", "all_pages_and_pinned_54_articles", "53_published_one_failed", "each_article_visible");
  const hashes = new Map();
  for (const artifact of first.artifacts) hashes.set(artifact.path, createHash("sha256").update(await fs.readFile(artifact.path)).digest("hex"));
  fixture.recover();
  doc.getElementById("retry-all").click();
  const second = await complete();
  assert.equal(resultView(second).kind, "success");
  assert.equal(second.receipt.imported, 54);
  assert.equal(second.receipt.failed, 0);
  assert.equal(mounted.session.state.attempts[0].snapshot.results[0].receipt.failed, 1);
  for (const [file, hash] of hashes) assert.equal(createHash("sha256").update(await fs.readFile(file)).digest("hex"), hash);
  for (const artifact of second.artifacts) {
    assert.equal(path.basename(path.dirname(artifact.path)), "zhuanlan.zhihu.com");
    assert.equal(createHash("sha256").update(await fs.readFile(artifact.path)).digest("hex"), artifact.sha256);
  }
  const files = await fs.readdir(path.join(fixture.workflowRoot, "阅读区/zhuanlan.zhihu.com"));
  assert.equal(files.filter(file => file.endsWith(".md")).length, 54);
  const broker = JSON.parse(await fs.readFile(path.join(fixture.workflowRoot, ".local-ir/browser-import-broker/state.json"), "utf8"));
  const childSizes = broker.requests.filter(request => request.clientRequestId?.includes(":articles:")).map(request => broker.tasks.filter(task => task.requestId === request.id).length);
  assert.deepEqual(childSizes, [50, 4, 50, 4]);
  evidence.checks.push("automatic_50_4_batches", "retry_reuses_53_unchanged_articles", "54_formal_files_with_hash_readback", "previous_failure_preserved");
  const before = files.filter(file => file.endsWith(".md")).length;
  input.value = "https://www.zhihu.com/column/c_incomplete";
  input.dispatchEvent(new dom.window.Event("input")); doc.getElementById("start").click();
  const incomplete = await complete();
  assert.equal(incomplete.status, "failed");
  assert.match(incomplete.error, /next_page_missing/u);
  assert.equal((await fs.readdir(path.join(fixture.workflowRoot, "阅读区/zhuanlan.zhihu.com"))).filter(file => file.endsWith(".md")).length, before);
  evidence.checks.push("incomplete_inventory_zero_article_writes");
  evidence.status = "passed";
} catch (error) { evidence.status = "failed"; evidence.error = error.stack; throw error; }
finally {
  mounted?.stop(); dom?.window.close();
  await fs.writeFile(path.join(fixture.root, "column-acceptance.json"), JSON.stringify(evidence, null, 2));
  await fixture.stop();
  console.log(`${evidence.status}: ${fixture.root}/column-acceptance.json`);
}
