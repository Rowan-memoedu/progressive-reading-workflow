import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import Ajv2020 from "ajv/dist/2020.js";

import {
  loadSubscriptionRegistry,
  runSubscriptionBatch,
  SUBSCRIPTIONS_SCHEMA,
  validateSubscriptionRegistry
} from "../rss-source/subscriptions.mjs";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(testDir, "..");

function fixtureRegistry() {
  return {
    schema_version: SUBSCRIPTIONS_SCHEMA,
    registry_version: "1.0.0",
    subscriptions: [
      {
        id: "alpha-feed",
        display_name: "Alpha Feed",
        enabled: true,
        feed_url: "HTTPS://EXAMPLE.TEST:443/feed?utm_source=config",
        site_url: "https://example.test/",
        fetch_fulltext: false,
        user_instruction: "保留术语。"
      },
      {
        id: "disabled-feed",
        display_name: "Disabled Feed",
        enabled: false,
        feed_url: "https://disabled.example.test/feed",
        site_url: null,
        fetch_fulltext: true,
        user_instruction: ""
      }
    ]
  };
}

test("derives the report registry only from the third Markdown region", async (t) => {
  const fixtureRoot='D:/Artifacts/RSS-Routing-20260915/tests';await fs.mkdir(fixtureRoot,{recursive:true});
  const root = await fs.mkdtemp(path.join(fixtureRoot, "rss-subscriptions-"));
  t.after(async () => fs.rm(root, { recursive: true, force: true }));
  const configPath = path.join(root, "subscriptions.md");
  await fs.writeFile(configPath,'```json\n{}\n```\n## ① 标准流程导入\n标准：https://standard.example/feed\n## ② 原文直接导入\n原文：https://original.example/feed\n## ③ 日报与周报\nAlpha Feed：https://example.test/feed?utm_source=config\n');
  const registry = await loadSubscriptionRegistry(configPath);
  assert.equal(registry.subscriptions[0].feed_url, "https://example.test/feed");
  assert.equal(registry.subscriptions.length,1);
  assert.equal(registry.subscriptions[0].display_name,'Alpha Feed');
  assert.equal(registry.subscriptions[0].fetch_fulltext,true);
  await assert.rejects(loadSubscriptionRegistry(path.join(root,'old.json')),/three_section_markdown/);

  const schema = JSON.parse(await fs.readFile(path.join(projectRoot, "rss-source", "contracts", "subscriptions.v1.schema.json"), "utf8"));
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  ajv.addFormat("uri", (value) => value == null || (() => { try { return Boolean(new URL(value)); } catch { return false; } })());
  const validate = ajv.compile(schema);
  assert.equal(validate(registry), true, JSON.stringify(validate.errors));
});

test("rejects duplicate subscription identities and feed URLs", () => {
  const duplicateId = fixtureRegistry();
  duplicateId.subscriptions[1] = { ...duplicateId.subscriptions[0], feed_url: "https://other.example.test/feed" };
  assert.throws(() => validateSubscriptionRegistry(duplicateId), /duplicate_subscription_id_alpha-feed/u);

  const duplicateUrl = fixtureRegistry();
  duplicateUrl.subscriptions[1] = { ...duplicateUrl.subscriptions[1], id: "other-feed", feed_url: "https://example.test/feed" };
  assert.throws(() => validateSubscriptionRegistry(duplicateUrl), /duplicate_subscription_feed_url_https:\/\/example\.test\/feed/u);
});

test("syncs only enabled subscriptions and isolates individual feed failures", async () => {
  const registry = validateSubscriptionRegistry(fixtureRegistry());
  const calls = [];
  const result = await runSubscriptionBatch({
    registry,
    batchId: "fixture-batch",
    options: { limit: "3" },
    syncOne: async (subscription, options) => {
      calls.push({ subscription, options });
      return { status: "completed", feed_url: options["feed-url"], item_count: 1 };
    }
  });
  assert.equal(result.status, "completed");
  assert.equal(result.subscription_count, 1);
  assert.equal(result.degraded, 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.limit, "3");
  assert.equal(calls[0].options["user-instruction"], "保留术语。");
  assert.deepEqual(result.writes, { reading_area: false, remnote: false, logseq: false, browser: false });

  const failed = await runSubscriptionBatch({
    registry,
    batchId: "fixture-failure",
    syncOne: async () => { throw new Error("fixture_unavailable"); }
  });
  assert.equal(failed.status, "completed_with_failures");
  assert.equal(failed.failed, 1);
  assert.equal(failed.degraded, 0);
  assert.equal(failed.results[0].error.message, "fixture_unavailable");

  const degraded = await runSubscriptionBatch({
    registry,
    batchId: "fixture-degraded",
    syncOne: async () => ({ status: "completed_with_failures", counts: { fetch_failed: 1 } })
  });
  assert.equal(degraded.status, "completed_with_failures");
  assert.equal(degraded.succeeded, 1);
  assert.equal(degraded.failed, 0);
  assert.equal(degraded.degraded, 1);
});
