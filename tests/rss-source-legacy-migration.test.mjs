import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { generateLegacyAudit } from "../rss-source/legacy-migration.mjs";

function legacySource({ key, sourceId, sourceType, url, title, contentHash, body }) {
  return `<!-- rss-source-meta
${JSON.stringify({
    schema: "progressive-reading-rss-source-entry/v1",
    key,
    sourceId,
    sourceType,
    platform: sourceType === "rss" ? "rss" : "x",
    title,
    url,
    publishedAt: "2026-07-01T00:00:00.000Z",
    author: "Fixture Author",
    fetchMethod: "fixture",
    contentHash
  }, null, 2)}
-->

# ${title}

${body}
`;
}

test("preserves legacy evidence and separates source facts from review decisions", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rss-legacy-audit-"));
  t.after(async () => fs.rm(root, { recursive: true, force: true }));
  const rssEntries = path.join(root, "imports", "rss", "source-layer", "entries", "rss-fixture");
  const xEntries = path.join(root, "imports", "rss", "source-layer", "entries", "x-fixture");
  const pending = path.join(root, "阅读区", "RSS", "待确认");
  const weekly = path.join(root, "阅读区", "RSS", "短文周报");
  const runDir = path.join(root, "imports", "rss", "runs", "fixture-run");
  const activePackage = path.join(root, "imports", "rss", "source-v1", "packages", "rss-active", "rss-item");
  await Promise.all([rssEntries, xEntries, pending, weekly, runDir, activePackage, path.join(root, "config"), path.join(root, "scripts")].map((dir) => fs.mkdir(dir, { recursive: true })));

  await fs.writeFile(path.join(root, "config", "rss-sources.json"), `${JSON.stringify({
    version: 1,
    sources: [
      { id: "rss-fixture", type: "rss", displayName: "Fixture RSS", feedUrl: "https://example.test/feed" },
      { id: "x-fixture", type: "x-user", displayName: "Fixture X" }
    ]
  }, null, 2)}\n`, "utf8");
  const body = "Complete-looking legacy text whose completeness still cannot be proven from Markdown alone.";
  const rssUrl = "https://example.test/article";
  const rssHash = "a".repeat(64);
  await fs.writeFile(path.join(rssEntries, "one.md"), legacySource({ key: "rss-fixture:one", sourceId: "rss-fixture", sourceType: "rss", url: rssUrl, title: "RSS article", contentHash: rssHash, body }), "utf8");
  await fs.writeFile(path.join(rssEntries, "duplicate.md"), legacySource({ key: "rss-fixture:alias", sourceId: "rss-fixture", sourceType: "rss", url: `${rssUrl}?utm_source=alias`, title: "RSS article", contentHash: rssHash, body }), "utf8");
  await fs.writeFile(path.join(xEntries, "post.md"), legacySource({ key: "x-fixture:one", sourceId: "x-fixture", sourceType: "x-user", url: "https://x.com/example/status/1", title: "X post", contentHash: "b".repeat(64), body: "Post text" }), "utf8");
  await fs.writeFile(path.join(activePackage, "source-metadata.json"), `${JSON.stringify({ item_url: rssUrl })}\n`, "utf8");
  await fs.writeFile(path.join(runDir, "raw.json"), "{\"fixture\":true}\n", "utf8");
  await fs.writeFile(path.join(root, "imports", "rss", "state.json"), "{\"version\":1}\n", "utf8");
  await fs.writeFile(path.join(root, "scripts", "rss-workflow.mjs"), "// legacy fixture\n", "utf8");
  await fs.writeFile(path.join(root, "scripts", "rss-sync-daily.cmd"), "@echo off\n", "utf8");
  await fs.writeFile(path.join(pending, "2026-07-01 RSS 长文待确认.md"), `# Pending

### 1. RSS article
[原文链接](${rssUrl})
- [x] 正式入库
- [ ] 删除

### 2. Missing source article
[原文链接](https://missing.example.test/article)
- [ ] 正式入库
- [ ] 删除
`, "utf8");
  await fs.writeFile(path.join(weekly, "2026-W27 RSS 短文周报.md"), "# Weekly\n\n[Original](https://weekly.example.test/item)\n", "utf8");

  const outputRoot = path.join(root, "imports", "rss", "legacy-v0");
  const result = await generateLegacyAudit({ projectRoot: root, outputRoot, generatedAt: "2026-08-22T00:00:00.000Z" });
  assert.equal(result.status, "completed");
  assert.equal(result.stats.legacy_source_files, 3);
  assert.equal(result.stats.rss_source_files, 2);
  assert.equal(result.stats.rss_unique_candidates, 1);
  assert.equal(result.stats.rss_duplicate_files, 1);
  assert.equal(result.stats.non_rss_source_files, 1);
  assert.equal(result.stats.review_decisions, 2);
  assert.deepEqual(result.stats.review_decision_counts, { formal_selected: 1, unresolved: 1 });
  assert.equal(result.stats.reading_unique_item_urls, 3);
  assert.equal(result.stats.reading_urls_with_source_layer_match, 1);
  assert.equal(result.stats.reading_only_item_urls, 2);
  assert.equal(result.stats.legacy_candidates_already_in_v1, 1);
  assert.equal(result.safety.moved_or_deleted_legacy_files, false);

  const candidates = JSON.parse(await fs.readFile(result.migration_candidates, "utf8"));
  assert.equal(candidates.rss_candidates[0].legacy_content_status, "unverified_legacy");
  assert.equal(candidates.rss_candidates[0].recommended_action, "refetch_required");
  assert.equal(candidates.non_rss_legacy_entries.length, 1);
  const ledger = JSON.parse(await fs.readFile(result.review_decisions, "utf8"));
  assert.equal(ledger.note.includes("not publication authorization"), true);
  assert.equal(await fs.readFile(path.join(rssEntries, "one.md"), "utf8").then((text) => text.includes("RSS article")), true);

  const manifest = JSON.parse(await fs.readFile(result.manifest, "utf8"));
  const preserved = manifest.files.find((item) => item.relative_path.endsWith("fixture-run/raw.json"));
  assert.ok(preserved.evidence_blob);
  assert.equal(await fs.readFile(path.join(outputRoot, ...preserved.evidence_blob.split("/")), "utf8"), "{\"fixture\":true}\n");
});
