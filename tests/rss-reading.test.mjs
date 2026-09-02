import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  applyDecision,
  generateSummaries,
  loadLedger,
  migrateLegacyOutputs,
  publicationGate,
  publishSelected,
  runCanary,
  scanCatalog,
  setDecision,
  workflowPaths
} from "../rss-reading/core.mjs";

function hash(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function writeJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function sourcePackage({ materialId, url, title, contentStatus, requestReady = true, paidRestricted = false }) {
  const ready = contentStatus === "fulltext_ready" && requestReady;
  return {
    schema_version: "progressive-reading.rss-source-package/v1",
    package_version: "1.0.0",
    material_id: materialId,
    status: contentStatus,
    content_status: contentStatus,
    sync_status: "new",
    identity: {
      normalized_feed_url: "https://example.test/feed.xml",
      normalized_item_url: url,
      guid: url,
      content_hash: "a".repeat(64)
    },
    source_metadata: {
      source_type: "rss",
      feed_url: "https://example.test/feed.xml",
      item_url: url,
      guid: url,
      title,
      author: "Fixture",
      published_at: "2026-08-22T05:00:00Z",
      fetched_at: "2026-08-22T06:00:00Z",
      content_completeness: contentStatus,
      original_source_ref: url,
      user_instruction: ""
    },
    artifacts: {
      source_markdown: "source.md",
      source_metadata: "source-metadata.json",
      raw_item: "raw/item.json",
      raw_feed_content: "raw/feed-content.txt",
      raw_item_page: paidRestricted ? "raw/item-page.html" : null,
      raw_item_page_response: paidRestricted ? "raw/item-page-response.json" : null,
      raw_feed_snapshot: "raw/feed.xml",
      preprocess_request: ready ? "preprocess-request.json" : null
    },
    hashes: {
      raw_feed_sha256: "b".repeat(64),
      raw_content_sha256: "c".repeat(64),
      source_markdown_sha256: "d".repeat(64)
    },
    receipt: {
      run_id: "fixture-run",
      source_id: "fixture-source",
      status_history: [contentStatus],
      previous_material_id: null,
      preprocessing_handoff: ready ? "request_ready" : "blocked_in_source_layer"
    },
    errors: paidRestricted ? [{
      code: "fulltext_fetch_failed",
      stage: "item_page_fetch",
      message: "fetched_article_access_restricted_paid_subscribers"
    }] : []
  };
}

async function createFixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rss-reading-test-"));
  const paths = workflowPaths(root);
  const legacyDecisions = Array.from({ length: 22 }, (_, index) => ({
    decision_id: `legacy-${index + 1}`,
    item_url: `https://legacy.test/${index + 1}`,
    title: `Legacy ${index + 1}`,
    decision: index < 14 ? "formal_selected" : "unresolved",
    source_file: "阅读区/RSS/待确认/legacy.md"
  }));
  await writeJson(paths.legacyLedgerPath, {
    schema_version: "progressive-reading.rss-legacy-review-ledger/v1",
    generated_at: "2026-08-22T00:00:00Z",
    note: "fixture",
    counts: { formal_selected: 14, unresolved: 8 },
    decisions: legacyDecisions
  });
  const fixtures = [
    {
      materialId: "rss-111111111111111111111111",
      url: "https://example.test/long",
      title: "Long fixture",
      contentStatus: "fulltext_ready",
      markdown: `# Long fixture\n\n${"Long content sentence. ".repeat(100)}`
    },
    {
      materialId: "rss-222222222222222222222222",
      url: "https://example.test/short",
      title: "Short fixture",
      contentStatus: "fulltext_ready",
      markdown: "# Short fixture\n\nA compact note."
    },
    {
      materialId: "rss-333333333333333333333333",
      url: "https://example.test/blocked",
      title: "Blocked fixture",
      contentStatus: "fetch_failed",
      requestReady: false,
      paidRestricted: true,
      markdown: ""
    }
  ];
  for (const fixture of fixtures) {
    const packageDir = path.join(paths.packagesRoot, "fixture-source", fixture.materialId);
    await writeJson(path.join(packageDir, "package.json"), sourcePackage(fixture));
    if (fixture.paidRestricted) {
      await fs.mkdir(path.join(packageDir, "raw"), { recursive: true });
      await fs.writeFile(path.join(packageDir, "raw", "item-page.html"), "<p>This post is for paid subscribers</p>\n", "utf8");
      await writeJson(path.join(packageDir, "raw", "item-page-response.json"), { status: 200 });
    }
    if (fixture.contentStatus === "fulltext_ready") {
      await writeJson(path.join(packageDir, "preprocess-request.json"), {
        schema_version: "progressive-reading.preprocess.request/v1",
        contract_version: "1.0.0",
        source_type: "rss",
        source_metadata: {
          original_url: fixture.url,
          title: fixture.title,
          source_is_original: true
        },
        user_instruction: "",
        material: { markdown: fixture.markdown }
      });
    }
  }
  await writeJson(path.join(paths.batchesRoot, "fixture-batch", "run.json"), {
    schema_version: "progressive-reading.rss-subscription-batch/v1",
    status: "completed_with_failures",
    batch_id: "fixture-batch",
    subscription_count: 1,
    succeeded: 1,
    failed: 0,
    degraded: 1,
    results: [{
      subscription_id: "fixture-source",
      ok: true,
      result: { status: "completed_with_failures", inventory_complete: true, item_count: 3, feed_item_count: 3, run_id: "fixture-run" }
    }]
  });
  await fs.mkdir(path.join(paths.readingRoot, "短文周报"), { recursive: true });
  await fs.writeFile(path.join(paths.readingRoot, "短文周报", "2026-W01 RSS 短文周报.md"), "# Legacy weekly\n", "utf8");
  await migrateLegacyOutputs(root);
  return { root, paths };
}

async function fixturePreviewRunner({ item, request }) {
  const short = item.route === "short_aggregate";
  assert.equal(request.processing_options.workflow_mode, short ? "standard" : "single_stage");
  return {
    result: {
      schema_version: "progressive-reading.preprocess.result/v1",
      contract_version: "1.0.0",
      status: "completed",
      material_id: item.material_id,
      idempotency_key: `preview-${item.material_id}`,
      processing_state: "rendered",
      translation_state: short ? "generated_translation" : "not_translation",
      artifacts: {
        target_zone: "local-ir-reading",
        reading_markdown: short
          ? `# 短文译文\n\n## 阅读前置卡\n\n- 价值判断：中。测试。\n\n---\n\n## 正文\n\n# 短文译文\n\n这是一段可直接阅读的中文正文。\n\n---\n\n## 原文\n\n${request.material.markdown}`
          : request.material.markdown,
        semantic: {
          judgments: {
            value: { level: short ? "medium" : "high", reason: short ? "内容简洁并有明确观点。" : "内容具体，可用于形成行动判断。" },
            density: { level: "high", reason: "信息集中。" },
            continue_reading: { level: 3, reason: "值得继续阅读。" }
          },
          insights: [{ title: "核心判断", description: short ? "找到契合的目标后，持续投入会更有意义。" : "长文提供了一套可以落实到行动中的核心方法。" }]
        }
      },
      source_metadata: request.source_metadata,
      receipt: { processor_version: "fixture", prompt_version: "fixture" },
      errors: []
    }
  };
}

function generationOptions(extra = {}) {
  return { date: "2026-08-22", week: "2026-W34", mode: "all", previewRunner: fixturePreviewRunner, executeDecisions: false, ...extra };
}

async function fixturePublicationRunner({ outputDir, publishPath }) {
  const markdown = "# Verified fixture\n\nPublished through isolated pr-preprocess contract stub.\n";
  await fs.mkdir(outputDir, { recursive: true });
  await fs.mkdir(path.dirname(publishPath), { recursive: true });
  await fs.writeFile(publishPath, markdown, "utf8");
  await writeJson(path.join(outputDir, "result.json"), {
    status: "completed",
    processing_state: "rendered",
    artifacts: { target_zone: "local-ir-reading" }
  });
  await writeJson(path.join(outputDir, "publication.json"), {
    status: "published",
    markdown: { path: publishPath, sha256: hash(markdown) },
    cleanliness: { valid: true }
  });
}

test("catalog routes only fulltext_ready requests and preserves blocked source state", async (t) => {
  const fixture = await createFixture();
  t.after(() => fs.rm(fixture.root, { recursive: true, force: true }));
  const catalog = await scanCatalog(fixture.root);
  assert.equal(catalog.items.length, 3);
  assert.equal(catalog.items.filter((item) => item.eligible).length, 2);
  assert.equal(catalog.items.find((item) => item.materialId.includes("111"))?.route, "long_review");
  assert.equal(catalog.items.find((item) => item.materialId.includes("222"))?.route, "short_aggregate");
  assert.equal(catalog.items.find((item) => item.materialId.includes("333"))?.route, "blocked");
  assert.equal(catalog.items.find((item) => item.materialId.includes("333"))?.requestPath, null);
});

test("incremental generation conserves legacy decisions and splits long review from direct short weekly reading", async (t) => {
  const fixture = await createFixture();
  t.after(() => fs.rm(fixture.root, { recursive: true, force: true }));
  const result = await generateSummaries(fixture.root, generationOptions());
  assert.equal(result.legacy_conservation.total, 22);
  assert.equal(result.legacy_conservation.selected, 14);
  assert.equal(result.legacy_conservation.unresolved, 8);
  assert.ok(result.outputs.daily.path.startsWith(fixture.paths.summaryRoot));
  assert.ok(result.outputs.long_weekly.path.startsWith(fixture.paths.summaryRoot));
  assert.ok(result.outputs.short_weekly.path.startsWith(fixture.paths.shortWeeklyRoot));
  const readingEntries = await fs.readdir(fixture.paths.readingRoot, { withFileTypes: true });
  assert.equal(readingEntries.filter((entry) => entry.isFile() && entry.name.endsWith(".md")).length, 0);
  assert.equal(await fs.readFile(path.join(fixture.paths.legacySummaryArchiveRoot, "短文周报", "2026-W01 RSS 短文周报.md"), "utf8"), "# Legacy weekly\n");
  const daily = await fs.readFile(result.outputs.daily.path, "utf8");
  const longWeekly = await fs.readFile(result.outputs.long_weekly.path, "utf8");
  const shortWeekly = await fs.readFile(result.outputs.short_weekly.path, "utf8");
  assert.match(daily, /# 2026-08-22 RSS 长文日报/u);
  assert.match(daily, /\*\*一句话核心\*\*：/u);
  assert.match(daily, /\*\*为什么值得读\*\*：/u);
  assert.match(daily, /\*\*可能新增量\*\*：/u);
  assert.match(daily, /\*\*预计阅读成本\*\*：/u);
  assert.match(daily, /\*\*建议读法\*\*：/u);
  assert.match(daily, /正文仅对付费订阅者开放/u);
  assert.doesNotMatch(daily, /fetched_article_access_restricted_paid_subscribers/u);
  assert.doesNotMatch(daily, /保持未决/u);
  assert.doesNotMatch(daily, /Material ID|来源状态：|产品分流：|内容长度：|处理门禁：/u);
  assert.doesNotMatch(daily, /Short fixture/u);
  assert.match(daily, /\[2026-W34 RSS 长文周报\.md\]\(<2026-W34 RSS 长文周报\.md>\)/u);
  assert.doesNotMatch(daily, /应用筛选面板/u);
  assert.match(longWeekly, /RSS 长文周报/u);
  assert.match(longWeekly, /Long fixture/u);
  assert.match(longWeekly, /- \[ \] 正式入库（自动处理并发布）/u);
  assert.match(shortWeekly, /## 中文主文/u);
  assert.match(shortWeekly, /这是一段可直接阅读的中文正文/u);
  assert.match(shortWeekly, /## English Appendix/u);
  assert.match(shortWeekly, /A compact note\./u);
  assert.doesNotMatch(shortWeekly, /rss-reading:item|正式入库|稍后再看|不保留/u);
  assert.doesNotMatch(shortWeekly, /Material ID|来源状态：|产品分流：|内容长度：|处理门禁：/u);
  const ledger = await loadLedger(fixture.root);
  const current = ledger.items["rss-111111111111111111111111"];
  assert.equal(current.decision, "unresolved");
  assert.equal(current.delivery.daily_report_key, "2026-08-22");
  assert.equal(ledger.items["rss-222222222222222222222222"].delivery.short_weekly_key, "2026-W34");
});

test("publication gate requires selected plus explicit summary authorization and verifies receipts", async (t) => {
  const fixture = await createFixture();
  t.after(() => fs.rm(fixture.root, { recursive: true, force: true }));
  await generateSummaries(fixture.root, generationOptions());
  const materialId = "rss-111111111111111111111111";
  await assert.rejects(() => publishSelected(fixture.root, materialId, { runner: async () => assert.fail("runner must not be called") }), /decision_unresolved/);
  await setDecision(fixture.root, materialId, "selected", { authorize: true, source: "isolated_test" });
  const result = await publishSelected(fixture.root, materialId, {
    runner: fixturePublicationRunner
  });
  assert.equal(result.status, "published");
  assert.equal(path.dirname(result.path), fixture.paths.readingRoot);
  assert.equal(publicationGate({ decision: "unresolved" }).allowed, false);
});

test("realistic canary verifies authorized zones, direct short weekly, unchanged flat long area, ledger, and source batch", async (t) => {
  const fixture = await createFixture();
  t.after(() => fs.rm(fixture.root, { recursive: true, force: true }));
  const canary = await runCanary(fixture.root, generationOptions({ validatePreprocess: false }));
  assert.equal(canary.status, "passed");
  assert.deepEqual(canary.blocking_checks, []);
  assert.equal(canary.catalog.package_count, 3);
  assert.equal(canary.checks.current_reports_in_authorized_zones, true);
  assert.equal(canary.checks.no_unapproved_flat_long_publication, true);
  assert.equal(canary.checks.all_required_previews_ready, true);
  assert.equal(canary.checks.daily_human_review_format, true);
  assert.equal(canary.checks.blocked_source_states_explained, true);
  assert.equal(canary.checks.paid_restrictions_human_readable, true);
  assert.equal(canary.checks.latest_source_batch_has_complete_inventory, true);
  assert.equal(canary.checks.long_weekly_rolls_all_active_unresolved, true);
  assert.equal(canary.checks.short_weekly_human_reading_format, true);
  assert.equal(canary.checks.preserved_historical_short_weeklies_verified, true);
  assert.equal(canary.checks.superseded_current_weekly_removed_after_verified_archive, true);
});

test("canary fails closed when a declared historical short weekly is missing, then passes after hash-identical restoration", async (t) => {
  const fixture = await createFixture();
  t.after(() => fs.rm(fixture.root, { recursive: true, force: true }));
  const active = path.join(fixture.paths.shortWeeklyRoot, "2026-W01 RSS 短文周报.md");
  const archived = path.join(fixture.paths.legacySummaryArchiveRoot, "短文周报", "2026-W01 RSS 短文周报.md");
  await fs.unlink(active);
  const blocked = await runCanary(fixture.root, generationOptions({ validatePreprocess: false }));
  assert.equal(blocked.status, "blocked");
  assert.equal(blocked.checks.preserved_historical_short_weeklies_verified, false);
  assert.equal(blocked.preserved_historical_short_weeklies[0].exists, false);
  await fs.copyFile(archived, active);
  const restored = await runCanary(fixture.root, generationOptions({ validatePreprocess: false }));
  assert.equal(restored.status, "passed");
  assert.equal(restored.preserved_historical_short_weeklies[0].verified, true);
});

test("split weekly generation archives the obsolete combined weekly only after replacements and hash verification", async (t) => {
  const fixture = await createFixture();
  t.after(() => fs.rm(fixture.root, { recursive: true, force: true }));
  const obsolete = path.join(fixture.paths.summaryRoot, "2026-W34 RSS 周报.md");
  const obsoleteText = "# 2026-W34 RSS 短文周报\n\n旧合并周报已由长短周报拆分取代。\n";
  await fs.mkdir(path.dirname(obsolete), { recursive: true });
  await fs.writeFile(obsolete, obsoleteText, "utf8");
  const generated = await generateSummaries(fixture.root, generationOptions());
  assert.equal(generated.superseded_weekly_report.status, "archived");
  assert.equal(generated.superseded_weekly_report.verified, true);
  await assert.rejects(() => fs.access(obsolete));
  const archived = path.join(fixture.paths.supersededSummaryArchiveRoot, "2026-W34 RSS 周报.md");
  assert.equal(await fs.readFile(archived, "utf8"), obsoleteText);
  assert.equal(generated.superseded_weekly_report.archive_sha256, hash(obsoleteText));
});

test("checking formal admission auto-publishes, while Later publishes first and writes a verified seven-day sidecar", async (t) => {
  const fixture = await createFixture();
  t.after(() => fs.rm(fixture.root, { recursive: true, force: true }));
  const generated = await generateSummaries(fixture.root, generationOptions());
  const activePath = generated.outputs.long_weekly.path;
  const original = await fs.readFile(activePath, "utf8");
  const updated = original.replace(
    /(<!-- rss-reading:item rss-111111111111111111111111 -->[\s\S]*?)- \[ \] 正式入库（自动处理并发布）/u,
    "$1- [x] 正式入库（自动处理并发布）"
  );
  assert.notEqual(updated, original);
  await fs.writeFile(activePath, updated, "utf8");
  const acted = await generateSummaries(fixture.root, generationOptions({ mode: "daily", executeDecisions: true, publicationRunner: fixturePublicationRunner }));
  assert.equal(acted.decision_actions.completed[0].status, "published");
  let ledger = await loadLedger(fixture.root);
  let item = ledger.items["rss-111111111111111111111111"];
  assert.equal(item.decision, "selected");
  assert.equal(item.publication.status, "published");

  const sidecarRoot = path.join(fixture.root, ".local-ir", "browser-document-state");
  const later = await applyDecision(fixture.root, item.material_id, "deferred", {
    source: "isolated_test",
    runner: fixturePublicationRunner,
    date: "2026-08-22",
    vaultRoot: fixture.root,
    sidecarRoot
  });
  assert.equal(later.status, "published_and_deferred");
  assert.equal(later.later.defer_until, "2026-08-29");
  const state = JSON.parse(await fs.readFile(later.later.sidecar_path, "utf8"));
  assert.equal(state.document.status, "later");
  assert.equal(state.document.deferUntil, "2026-08-29");
  ledger = await loadLedger(fixture.root);
  item = ledger.items[item.material_id];
  assert.equal(item.decision, "deferred");
  assert.equal(item.later.status, "handoff_ready");
});

test("incremental cursor appends same-day discoveries, skips empty next-day files, and does not duplicate short weekly", async (t) => {
  const fixture = await createFixture();
  t.after(() => fs.rm(fixture.root, { recursive: true, force: true }));
  const first = await generateSummaries(fixture.root, generationOptions());
  const firstDaily = await fs.readFile(first.outputs.daily.path, "utf8");
  const firstShort = await fs.readFile(first.outputs.short_weekly.path, "utf8");
  const legacyDaily = firstDaily.replace(
    /> 本页为历史快照；请在 \[[^\]]+\]\(<[^>]+>\) 完成审批。/u,
    "> 本页已成为历史快照；请在最新长文周报或应用筛选面板中操作。"
  );
  assert.notEqual(legacyDaily, firstDaily);
  await fs.writeFile(first.outputs.daily.path, legacyDaily, "utf8");

  const sameDay = await generateSummaries(fixture.root, generationOptions());
  assert.equal(sameDay.outputs.short_weekly, null);
  assert.equal(await fs.readFile(first.outputs.daily.path, "utf8"), firstDaily);
  assert.equal(await fs.readFile(first.outputs.short_weekly.path, "utf8"), firstShort);

  const nextDay = await generateSummaries(fixture.root, generationOptions({ date: "2026-08-23", week: "2026-W34", mode: "daily" }));
  assert.equal(nextDay.outputs.daily, null);
  await assert.rejects(() => fs.access(path.join(fixture.paths.summaryRoot, "2026-08-23 RSS 日报.md")));
});

test("active package, app, and docs reference the new consumer instead of the legacy RSS workflow", async () => {
  const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const packageJson = JSON.parse(await fs.readFile(path.join(projectRoot, "package.json"), "utf8"));
  const app = await fs.readFile(path.join(projectRoot, "scripts", "progressive-reading-app.mjs"), "utf8");
  const readme = await fs.readFile(path.join(projectRoot, "README.md"), "utf8");
  const docs = await fs.readFile(path.join(projectRoot, "docs", "RSS_WORKFLOW.md"), "utf8");
  const release = JSON.parse(await fs.readFile(path.join(projectRoot, "rss-source", "release.json"), "utf8"));
  const scriptsText = JSON.stringify(packageJson.scripts);
  assert.match(scriptsText, /rss-reading\/cli\.mjs/u);
  assert.doesNotMatch(scriptsText, /rss-workflow\.mjs/u);
  assert.match(app, /\/api\/rss-reading\/queue/u);
  assert.match(app, /生成今日增量/u);
  assert.match(app, /RSS 运行状态/u);
  assert.doesNotMatch(app, /class="[^"]*rss-decision/u);
  assert.doesNotMatch(app, /class="[^"]*rss-publish/u);
  assert.doesNotMatch(`${readme}\n${docs}`, /应用筛选面板/u);
  assert.doesNotMatch(app, /rssOutput\.textContent\s*=\s*JSON\.stringify/u);
  assert.doesNotMatch(app, /rss-workflow\.mjs/u);
  assert.doesNotMatch(app, /\/api\/rss\/(?:health|sources|sync|resolve|promote)/u);
  assert.match(`${readme}\n${docs}`, /摘要区\/RSS/u);
  assert.match(`${readme}\n${docs}`, /阅读区\/RSS\/短文周报/u);
  assert.doesNotMatch(`${readme}\n${docs}`, /阅读区\/RSS\/待确认/u);
  assert.match(`${readme}\n${docs}`, new RegExp(`v${release.version.replaceAll(".", "\\.")}`, "u"));
});
