import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { IMPORT_RULES, zhihuColumnIdentity } from "./import-rule-catalog.mjs";
import { discoverZhihuColumn } from "./zhihu-column-import.mjs";
import { processCollectionTask } from "./collection-import.mjs";
import { BrowserImportBroker } from "./browser-import-broker.mjs";
import { resultView } from "./browser-import-web/client.mjs";

const column = "https://www.zhihu.com/column/c_fixture";
const cookieHeaderForUrl = () => "fixture_column_auth=synthetic-only";
const json = data => new Response(JSON.stringify(data), { headers: { "Content-Type": "application/json" } });
const article = id => ({ type: "article", id: String(id), title: `Article ${id}` });
function page(data, end = true, totals = data.length, next = null) { return { data, paging: { is_end: end, totals, next } }; }

test("rule catalog explicitly allows complex imports and only identifies column homepages", () => {
  assert.equal(IMPORT_RULES.advanced_imports_allowed, true);
  for (const url of [column, "https://zhuanlan.zhihu.com/c_fixture/", "http://zhuanlan.zhihu.com/slug?utm_source=test#top"]) assert.ok(zhihuColumnIdentity(url));
  for (const url of ["https://zhuanlan.zhihu.com/p/123", "https://www.zhihu.com/question/12", "https://evil.test/column/c_fixture", "https://www.zhihu.com:333/column/c_fixture", "https://user:secret@www.zhihu.com/column/c_fixture", "https://zhuanlan.zhihu.com/write"]) assert.equal(zhihuColumnIdentity(url), null);
});
test("all pages plus pinned articles, article-only filtering, dedupe and metadata", async () => {
  const calls = [];
  const result = await discoverZhihuColumn(column, { cookieHeaderForUrl, fetchImpl: async (url, options) => {
    calls.push(url); assert.equal(options.headers.Cookie, "fixture_column_auth=synthetic-only");
    if (url.includes("pinned-items")) return json({ data: [article(2), article(4)] });
    if (url.includes("offset=20")) return json(page([article(2), { type: "answer", id: "3" }], true, 3));
    return json(page([article(1)], false, 3, "/api/v4/columns/c_fixture/items?offset=20&limit=20"));
  } });
  assert.equal(calls.length, 3);
  assert.equal(result.complete, true);
  assert.equal(result.pages, 2);
  assert.equal(result.excluded_count, 1);
  assert.deepEqual(result.articles.map(item => item.id), ["1", "2", "4"]);
});
test("missing pages, unexpected origin, changing totals and pinned failures cannot claim a complete inventory", async () => {
  const cases = [
    { result: page([article(1)], false, 2), error: /next_page_missing/u },
    { result: page([article(1)], false, 2, "https://evil.test/api/v4/columns/c_fixture/items"), error: /origin_invalid/u },
    { result: page([article(1)], true, 2), error: /total_mismatch/u },
    { result: { data: [article(1)], paging: {} }, error: /paging_invalid/u }
  ];
  for (const item of cases) await assert.rejects(discoverZhihuColumn(column, { cookieHeaderForUrl, fetchImpl: async () => json(item.result) }), item.error);
  await assert.rejects(discoverZhihuColumn(column, { cookieHeaderForUrl, fetchImpl: async url => url.includes("pinned-items") ? new Response("restricted", { status: 403 }) : json(page([article(1)])) }), /zhihu_http_403/u);
});

test("column enumeration requires synchronized site Cookies before any network request", async () => {
  let calls = 0;
  await assert.rejects(discoverZhihuColumn(column, { cookieHeaderForUrl: () => null, fetchImpl: async () => { calls++; return json(page([])); } }), /zhihu_cookie_not_synced/u);
  assert.equal(calls, 0);
});
test("redirect credentials are never followed and auth failure remains explicit", async () => {
  let called = false;
  await assert.rejects(discoverZhihuColumn(column, { cookieHeaderForUrl: url => { assert.equal(new URL(url).hostname, "www.zhihu.com"); return "synthetic=test_only"; }, fetchImpl: async (_url, options) => {
    called = true; assert.equal(options.redirect, "error"); assert.equal(options.headers.Cookie, "synthetic=test_only"); return new Response("forbidden", { status: 403 });
  } }), /zhihu_http_403/u);
  assert.equal(called, true);
});
test("large article identifiers use the exact URL and unknown entry types block completeness", async () => {
  const exact = "1931415477860669105";
  const result = await discoverZhihuColumn(column, { cookieHeaderForUrl, fetchImpl: async url => json(url.includes("pinned-items") ? { data: [] } : page([{ type: "article", id: Number(exact), url: `https://zhuanlan.zhihu.com/p/${exact}` }])) });
  assert.equal(result.articles[0].id, exact);
  await assert.rejects(discoverZhihuColumn(column, { cookieHeaderForUrl, fetchImpl: async () => json(page([{ type: "new_unknown_type", id: "1" }])) }), /unknown_item_type/u);
});
test("large collections reuse broker 50-item batches, preserve failure rows and resume frozen inventory", async () => {
  const base = "D:/Artifacts/ProgressiveReading/web-import";
  await fs.mkdir(base, { recursive: true });
  const root = await fs.mkdtemp(path.join(base, "rule-broker-"));
  const broker = new BrowserImportBroker({ stateRoot: root });
  const created = await broker.createRequest([column], { source: "web_import_page", entryRoute: "obsidian", clientRequestId: "large-column" });
  const task = await broker.claimTask("fixture", null, { requestId: created.request_id });
  const articleUrls = Array.from({ length: 121 }, (_, i) => `https://zhuanlan.zhihu.com/p/${1000+i}`);
  const inventory = { complete: true, articles: articleUrls.map(url => ({ url })), excluded_count: 0 };
  const sizes = [];
  const runRequest = async id => {
    sizes.push((await broker.getRequest(id)).requested);
    for (;;) {
      const child = await broker.claimTask("child", null, { requestId: id });
      if (!child) break;
      const ok = !child.requested_url.endsWith("1001");
      await broker.completeTask(child.id, { ok, leaseToken: child.lease_token, error: ok ? null : "fixture_article_failure", result: ok ? {
        status: "imported", artifacts: [{ kind: "markdown", path: "D:/fixture.md", sha256: "a".repeat(64) }], receipt: { processing_mode: "standard_preprocess", quality_status: "ready", preprocess_status: "completed" }
      } : { status: "failed" } });
    }
  };
  await processCollectionTask(task, { broker, discover: async () => inventory, runRequest, pollMs: 1 });
  const result = await broker.getRequest(created.request_id);
  assert.deepEqual(sizes, [50, 50, 21]);
  assert.equal(result.status, "failed");
  assert.equal(result.results[0].collection.results.length, 121);
  assert.equal(result.results[0].receipt.imported, 120);
  assert.equal(result.results[0].receipt.failed, 1);
  assert.equal(resultView(result.results[0]).kind, "failed");
  // Model a worker lease recovery using persisted collection progress, not a new inventory.
  const retry = await broker.createRequest([column], { source: "web_import_page", clientRequestId: "frozen-resume" });
  const retryTask = await broker.claimTask("fixture", null, { requestId: retry.request_id });
  retryTask.collection = result.results[0].collection;
  await processCollectionTask(retryTask, { broker, discover: async () => { throw new Error("must_not_rediscover"); }, runRequest: async () => { throw new Error("must_not_recreate_terminal_batches"); }, pollMs: 1 });
  assert.equal((await broker.getRequest(retry.request_id)).results[0].collection.results.length, 121);
  await fs.writeFile(path.join(root, "acceptance.json"), JSON.stringify({ status: "passed", checks: ["121_articles", "50_50_21_batches", "failure_retained", "frozen_inventory_resume"], source: "synthetic_only" }, null, 2));
});
test("enumeration failure persists as parent failure and never starts article import", async () => {
  const root = await fs.mkdtemp("D:/Artifacts/ProgressiveReading/web-import/rule-auth-");
  const broker = new BrowserImportBroker({ stateRoot: root });
  const request = await broker.createRequest([column]);
  const task = await broker.claimTask("fixture", null, { requestId: request.request_id });
  await processCollectionTask(task, { broker, discover: async () => { throw new Error("zhihu_http_403"); }, runRequest: async () => { assert.fail("must not import an incomplete inventory"); } });
  const result = await broker.getRequest(request.request_id);
  assert.equal(result.status, "requires_browser_auth");
  assert.equal(result.results[0].collection.phase, "failed");
  assert.equal(resultView(result.results[0]).kind, "failed");
  assert.equal(broker.state.requests.length, 1);
});

test("collection resumes only articles awaiting classification and keeps completed siblings", async () => {
  const root = await fs.mkdtemp("D:/Artifacts/ProgressiveReading/web-import/classification-");
  const broker = new BrowserImportBroker({ stateRoot: root });
  const created = await broker.createRequest([column], { processingOptions: { translate: false } });
  const articleUrls = ["https://example.test/done", "https://example.test/uncertain"];
  const visits = [];
  let resumed = false;
  const runRequest = async requestId => {
    for (;;) {
      const child = await broker.claimTask("child", null, { requestId });
      if (!child) return;
      visits.push(child.requested_url);
      assert.equal(child.processing_options.translate, false);
      const needsInput = child.requested_url.endsWith("uncertain") && !resumed;
      if (resumed) assert.equal(child.processing_options.content_profile, "literature");
      await broker.completeTask(child.id, { ok: !needsInput, leaseToken: child.lease_token,
        degradedStatus: needsInput ? "needs_classification" : null,
        result: needsInput ? { status: "needs_classification", receipt: { missing_labels: ["content_profile"], pending_input_path: "D:/fixture/pending-source.json" } }
          : { status: "imported", artifacts: [{ kind: "markdown", path: "D:/fixture.md", sha256: "a".repeat(64) }], receipt: { processing_mode: "standard_preprocess", quality_status: "ready", preprocess_status: "completed" } } });
    }
  };
  await processCollectionTask(await broker.claimTask("parent", null, { requestId: created.request_id }), { broker, discover: async () => ({ complete: true, articles: articleUrls.map(url => ({ url })) }), runRequest, pollMs: 1 });
  const waiting = await broker.getRequest(created.request_id);
  assert.equal(waiting.status, "needs_classification");
  assert.equal(waiting.failed, 0);
  assert.equal(waiting.awaiting_input, true);
  assert.equal(resultView(waiting.results[0]).kind, "needs_input");
  assert.deepEqual(await broker.listPendingRequestIds(), []);
  await assert.rejects(broker.resumeClassification(created.request_id, { processingOptions: { include_reading_guide: "false" } }), /invalid_processing_options/u);
  resumed = true;
  await broker.resumeClassification(created.request_id, { processingOptions: { content_profile: "literature" } });
  await processCollectionTask(await broker.claimTask("parent", null, { requestId: created.request_id }), { broker, discover: async () => assert.fail("must reuse inventory"), runRequest, pollMs: 1 });
  const result = await broker.getRequest(created.request_id);
  assert.equal(result.status, "completed");
  assert.deepEqual(visits, [articleUrls[0], articleUrls[1], articleUrls[1]]);
  assert.equal(broker.state.requests.length, 2);
});
