import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import Ajv2020 from "ajv/dist/2020.js";

import {
  discoverFeedCandidates,
  normalizeUrl,
  parseFeedDocument,
  readConditionalHeaders,
  renameWithRetry,
  syncFeedDocument
} from "../rss-source/core.mjs";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(testDir, "..");

const fixtureFeed = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/">
  <channel>
    <title>Fixture Feed</title>
    <link>https://example.test/</link>
    <description>RSS source contract fixture</description>
    <item>
      <title>Full item</title>
      <link>https://example.test/full?utm_source=mail</link>
      <guid>fixture-full</guid>
      <pubDate>Fri, 21 Aug 2026 00:00:00 GMT</pubDate>
      <content:encoded><![CDATA[<article><h2>Full body</h2><p>This complete body is supplied by content encoded.</p></article>]]></content:encoded>
    </item>
    <item>
      <title>Fetch succeeds</title>
      <link>https://example.test/fetch-success</link>
      <guid>fixture-fetch-success</guid>
      <description><![CDATA[Short summary that requires the item page.]]></description>
    </item>
    <item>
      <title>Fetch fails</title>
      <link>https://example.test/fetch-fails</link>
      <guid>fixture-fetch-fails</guid>
      <description><![CDATA[Another summary whose item page is unavailable.]]></description>
    </item>
    <item>
      <title>Summary without item URL</title>
      <guid>fixture-summary-only</guid>
      <description><![CDATA[Summary stays a summary because there is no item URL.]]></description>
    </item>
  </channel>
</rss>`;

const fixtureAtom = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Fixture Atom</title>
  <link href="https://atom.example.test/" />
  <updated>2026-08-21T00:00:00Z</updated>
  <id>https://atom.example.test/feed</id>
  <entry>
    <title>Atom full item</title>
    <link href="https://atom.example.test/full" />
    <id>urn:fixture:atom:full</id>
    <updated>2026-08-21T00:00:00Z</updated>
    <content type="html"><![CDATA[<p>Atom content is the full source body.</p>]]></content>
  </entry>
  <entry>
    <title>Atom summary item</title>
    <link href="https://atom.example.test/summary" />
    <id>urn:fixture:atom:summary</id>
    <updated>2026-08-21T00:00:00Z</updated>
    <summary>Only an Atom summary is available.</summary>
  </entry>
</feed>`;

function ajv() {
  const validator = new Ajv2020({ strict: false, allErrors: true, allowUnionTypes: true });
  validator.addFormat("uri", (value) => {
    try { return Boolean(new URL(value)); } catch { return false; }
  });
  return validator;
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

test("normalizes tracking aliases and discovers RSS/Atom candidates", () => {
  assert.equal(
    normalizeUrl("HTTPS://Example.TEST:443/post?b=2&utm_source=x&a=1#part"),
    "https://example.test/post?a=1&b=2"
  );
  const html = `<!doctype html><html><head>
    <link rel="alternate" type="application/rss+xml" href="/feed.xml?utm_source=page" title="RSS">
    <link rel="alternate" type="application/atom+xml" href="https://example.test/atom.xml" title="Atom">
    <link rel="stylesheet" href="/style.css">
  </head></html>`;
  assert.deepEqual(discoverFeedCandidates(html, "https://example.test/articles/start"), [
    {
      feed_url: "https://example.test/feed.xml",
      type: "application/rss+xml",
      title: "RSS",
      discovered_from: "https://example.test/articles/start"
    },
    {
      feed_url: "https://example.test/atom.xml",
      type: "application/atom+xml",
      title: "Atom",
      discovered_from: "https://example.test/articles/start"
    }
  ]);
});

test("retries transient Windows rename failures before committing atomically", async () => {
  let calls = 0;
  await renameWithRetry("source", "target", {
    attempts: 4,
    delayMs: 0,
    rename: async () => {
      calls += 1;
      if (calls < 3) {
        const error = new Error("fixture transient lock");
        error.code = "EPERM";
        throw error;
      }
    }
  });
  assert.equal(calls, 3);
});

test("parses feed content without promoting summaries to full text", async () => {
  const parsed = await parseFeedDocument(fixtureFeed, "https://example.test/feed.xml");
  assert.equal(parsed.format, "rss");
  assert.equal(parsed.item_count, 4);
  assert.equal(parsed.items[0].feed_content.status, "fulltext_ready");
  assert.equal(parsed.items[0].feed_content.ref, "feed-content-encoded");
  assert.equal(parsed.items[1].feed_content.status, "summary_only");
  assert.equal(parsed.items[1].feed_content.ref, "feed-summary");

  const truncated = fixtureFeed.replace(
    "<article><h2>Full body</h2><p>This complete body is supplied by content encoded.</p></article>",
    "<article><p>Opening teaser...</p><a class=\"read-more\" href=\"https://example.test/full\">Read more</a></article>"
  );
  const truncatedParsed = await parseFeedDocument(truncated, "https://example.test/feed.xml");
  assert.equal(truncatedParsed.items[0].feed_content.status, "summary_only");
  assert.equal(truncatedParsed.items[0].feed_content.ref, "feed-content-encoded-truncated");
});

test("parses Atom content and keeps Atom summaries incomplete", async () => {
  const parsed = await parseFeedDocument(fixtureAtom, "https://atom.example.test/feed");
  assert.equal(parsed.format, "atom");
  assert.equal(parsed.item_count, 2);
  assert.equal(parsed.items[0].guid, "urn:fixture:atom:full");
  assert.equal(parsed.items[0].feed_content.status, "fulltext_ready");
  assert.equal(parsed.items[0].feed_content.ref, "atom-content");
  assert.equal(parsed.items[1].feed_content.status, "summary_only");
});

test("limits a live canary without changing the feed inventory count", async (t) => {
  const outputRoot = await fs.mkdtemp(path.join(os.tmpdir(), "rss-source-limit-"));
  t.after(async () => fs.rm(outputRoot, { recursive: true, force: true }));
  const result = await syncFeedDocument({
    feedUrl: "https://example.test/feed.xml",
    xml: fixtureFeed,
    response: { status: 200, final_url: "https://example.test/feed.xml", headers: {} },
    outputRoot,
    maxItems: 1,
    fetchedAt: "2026-08-21T00:00:00.000Z",
    runId: "fixture-limit"
  });
  assert.equal(result.feed_item_count, 4);
  assert.equal(result.item_count, 1);
  assert.equal(result.inventory_complete, false);
  assert.deepEqual(result.counts, { fulltext_ready: 1 });
  assert.deepEqual(await readConditionalHeaders(outputRoot, "https://example.test/feed.xml"), {});
});

test("writes traceable source packages, preserves status transitions, and deduplicates a second sync", async (t) => {
  const outputRoot = await fs.mkdtemp(path.join(os.tmpdir(), "rss-source-contract-"));
  t.after(async () => fs.rm(outputRoot, { recursive: true, force: true }));
  const articleFetcher = async (itemUrl) => {
    if (itemUrl.endsWith("/fetch-fails")) throw new Error("fixture_page_unavailable");
    return {
      html: `<!doctype html><html><head><title>Fetched full text</title></head><body><article><h1>Fetched full text</h1><p>This complete public article is retained as raw HTML before any Markdown conversion. It contains substantially more material than the feed summary.</p><p>The second paragraph proves that the item page supplied an actual readable body rather than another teaser or subscription prompt.</p></article></body></html>`
    };
  };
  const response = {
    status: 200,
    final_url: "https://example.test/feed.xml",
    headers: { content_type: "application/rss+xml", etag: '"fixture-v1"', last_modified: "Fri, 21 Aug 2026 00:00:00 GMT" }
  };
  const first = await syncFeedDocument({
    feedUrl: "https://example.test/feed.xml?utm_source=alias",
    xml: fixtureFeed,
    response,
    outputRoot,
    userInstruction: "保留定义与原始链接。",
    fetchFulltext: true,
    articleFetcher,
    fetchedAt: "2026-08-21T01:00:00.000Z",
    runId: "fixture-first"
  });

  assert.equal(first.status, "completed_with_failures");
  assert.equal(first.inventory_complete, true);
  assert.deepEqual(first.counts, { fulltext_ready: 2, fetch_failed: 1, summary_only: 1 });
  assert.deepEqual(first.writes, { reading_area: false, remnote: false, logseq: false, browser: false });
  const fetched = first.items.find((item) => item.identity.guid === "fixture-fetch-success");
  const failed = first.items.find((item) => item.identity.guid === "fixture-fetch-fails");
  const summary = first.items.find((item) => item.identity.guid === "fixture-summary-only");
  assert.deepEqual(fetched.status_history, ["summary_only", "fetch_required", "fulltext_ready"]);
  assert.deepEqual(failed.status_history, ["summary_only", "fetch_required", "fetch_failed"]);
  assert.deepEqual(summary.status_history, ["summary_only"]);

  const packageSchema = await readJson(path.join(projectRoot, "rss-source", "contracts", "source-package.v1.schema.json"));
  const requestSchema = await readJson(path.join(projectRoot, "standard-preprocessing", "contracts", "request.schema.json"));
  const packageValidator = ajv().compile(packageSchema);
  const requestValidator = ajv().compile(requestSchema);
  for (const item of first.items) {
    const packageJson = await readJson(path.join(item.package_path, "package.json"));
    assert.equal(packageValidator(packageJson), true, JSON.stringify(packageValidator.errors));
    const rawFeedPath = path.resolve(item.package_path, packageJson.artifacts.raw_feed_snapshot);
    assert.equal(await fs.readFile(rawFeedPath, "utf8"), fixtureFeed);
    const requestPath = path.join(item.package_path, "preprocess-request.json");
    if (item.content_status === "fulltext_ready") {
      const request = await readJson(requestPath);
      assert.equal(requestValidator(request), true, JSON.stringify(requestValidator.errors));
      assert.equal(request.source_type, "rss");
      assert.equal(request.source_metadata.feed_url, "https://example.test/feed.xml");
      assert.equal(request.user_instruction, "保留定义与原始链接。");
    } else {
      await assert.rejects(fs.access(requestPath));
    }
  }

  assert.deepEqual(await readConditionalHeaders(outputRoot, "https://example.test/feed.xml"), {
    "If-None-Match": '"fixture-v1"',
    "If-Modified-Since": "Fri, 21 Aug 2026 00:00:00 GMT"
  });

  const second = await syncFeedDocument({
    feedUrl: "https://example.test/feed.xml",
    xml: fixtureFeed,
    response,
    outputRoot,
    fetchFulltext: true,
    articleFetcher,
    fetchedAt: "2026-08-21T02:00:00.000Z",
    runId: "fixture-second"
  });
  assert.equal(second.status, "completed_with_failures");
  assert.deepEqual(second.counts, { duplicate: 3, fetch_failed: 1 });
  assert.equal(second.items.filter((item) => item.status === "duplicate").length, 3);
  assert.equal(second.items.find((item) => item.identity.guid === "fixture-fetch-fails").updated_existing_package, true);
});

test("upgrades existing summary packages in place after subscription-level public-page fetch is enabled", async (t) => {
  const outputRoot = await fs.mkdtemp(path.join(os.tmpdir(), "rss-source-upgrade-"));
  t.after(async () => fs.rm(outputRoot, { recursive: true, force: true }));
  const response = {
    status: 200,
    final_url: "https://example.test/feed.xml",
    headers: { content_type: "application/rss+xml" }
  };
  const first = await syncFeedDocument({
    feedUrl: "https://example.test/feed.xml",
    xml: fixtureFeed,
    response,
    outputRoot,
    fetchFulltext: false,
    fetchedAt: "2026-08-21T03:00:00.000Z",
    runId: "fixture-before-fulltext-policy"
  });
  assert.deepEqual(first.counts, { fulltext_ready: 1, fetch_required: 2, summary_only: 1 });
  const before = new Map(first.items.map((item) => [item.identity.guid, item]));

  const articleFetcher = async (itemUrl) => {
    if (itemUrl.endsWith("/fetch-fails")) {
      return {
        html: "<!doctype html><html><body><article><h1>Paid preview</h1><p>This public preview stops before the complete article.</p><h2>This post is for paid subscribers</h2></article></body></html>",
        response: { status: 200, final_url: itemUrl, headers: { content_type: "text/html" } }
      };
    }
    return {
      html: `<!doctype html><html><head><title>Public article</title></head><body><article><h1>Public article</h1><p>This is the complete public article for ${itemUrl}, retained as raw HTML and substantially longer than the feed summary.</p><p>A second complete paragraph provides enough readable evidence for the fulltext gate.</p></article></body></html>`,
      response: { status: 200, final_url: itemUrl, headers: { content_type: "text/html" } }
    };
  };
  const upgraded = await syncFeedDocument({
    feedUrl: "https://example.test/feed.xml",
    xml: fixtureFeed,
    response,
    outputRoot,
    fetchFulltext: true,
    articleFetcher,
    fetchedAt: "2026-08-21T04:00:00.000Z",
    runId: "fixture-after-fulltext-policy"
  });

  assert.deepEqual(upgraded.counts, { duplicate: 2, fulltext_ready: 1, fetch_failed: 1 });
  const upgradedItems = upgraded.items.filter((item) => item.upgraded_existing_package);
  assert.equal(upgradedItems.length, 1);
  for (const item of upgradedItems) {
    assert.equal(item.material_id, before.get(item.identity.guid).material_id);
    assert.equal(item.updated_from_status, "fetch_required");
    assert.deepEqual(item.status_history, ["summary_only", "fetch_required", "fulltext_ready"]);
    const packageJson = await readJson(path.join(item.package_path, "package.json"));
    assert.equal(packageJson.content_status, "fulltext_ready");
    assert.equal(packageJson.receipt.preprocessing_handoff, "request_ready");
    assert.equal(packageJson.receipt.update_from_status, "fetch_required");
    assert.equal(packageJson.artifacts.raw_item_page, "raw/item-page.html");
    assert.equal(packageJson.artifacts.preprocess_request, "preprocess-request.json");
    assert.equal((await fs.readFile(path.join(item.package_path, "raw", "item-page.html"), "utf8")).includes("complete public article"), true);
    assert.equal((await readJson(path.join(item.package_path, "preprocess-request.json"))).source_metadata.content_completeness, "fulltext_ready");
  }
  const failed = upgraded.items.find((item) => item.identity.guid === "fixture-fetch-fails");
  assert.equal(failed.updated_existing_package, true);
  assert.equal(failed.upgraded_existing_package, false);
  assert.equal(failed.updated_from_status, "fetch_required");
  assert.deepEqual(failed.status_history, ["summary_only", "fetch_required", "fetch_failed"]);
  const failedPackage = await readJson(path.join(failed.package_path, "package.json"));
  assert.equal(failedPackage.content_status, "fetch_failed");
  assert.equal(failedPackage.receipt.preprocessing_handoff, "blocked_in_source_layer");
  assert.equal(failedPackage.errors[0].message, "fetched_article_access_restricted_paid_subscribers");
  assert.equal(failedPackage.artifacts.raw_item_page, "raw/item-page.html");
  assert.equal((await fs.readFile(path.join(failed.package_path, "raw", "item-page.html"), "utf8")).includes("paid subscribers"), true);
  await assert.rejects(fs.access(path.join(failed.package_path, "preprocess-request.json")));
  const packageFiles = (await fs.readdir(path.join(outputRoot, "packages", first.source_id))).sort();
  assert.equal(packageFiles.length, 4, "an in-place completeness upgrade must not create extra active packages");
});
