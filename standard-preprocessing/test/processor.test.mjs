import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { processMaterial } from "../lib/core.mjs";
import { SyntheticProducer } from "../test-support/synthetic-producer.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtures = path.resolve(here, "..", "fixtures");

async function fixture(name) {
  return JSON.parse(await fs.readFile(path.join(fixtures, name), "utf8"));
}

test("monolingual material renders the locked reading-front-card contract and real block links", async () => {
  const producer = new SyntheticProducer();
  const result = await processMaterial(await fixture("monolingual.request.json"), {
    producer,
    now: "2026-08-14T00:00:00.000Z"
  });
  assert.equal(result.status, "completed");
  assert.equal(result.processing_state, "rendered");
  assert.equal(result.translation_state, "not_translation");
  assert.match(result.artifacts.reading_markdown, /- 价值判断：高/);
  assert.match(result.artifacts.reading_markdown, /- 信息密度判断：高/);
  assert.match(result.artifacts.reading_markdown, /- 是否继续阅读：6 精细阅读/);
  assert.match(result.artifacts.reading_markdown, /一、语义与渲染分离：/);
  assert.doesNotMatch(result.artifacts.reading_markdown, /具体用处/);
  for (const insight of result.artifacts.semantic.insights) {
    const target = result.artifacts.body_blocks.find((block) => block.source_block_key === insight.target_block_key);
    assert.ok(target);
    assert.match(result.artifacts.reading_markdown, new RegExp(`\\[\\[#\\^${target.block_id}\\|正文跳转\\]\\]`));
    assert.match(result.artifacts.reading_markdown, new RegExp(`\\^${target.block_id}`));
  }
});

test("identical requests replay from idempotency cache without another model call", async () => {
  const cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), "pr-preprocess-cache-"));
  const producer = new SyntheticProducer();
  const request = await fixture("monolingual.request.json");
  const first = await processMaterial(request, { producer, cacheDir, now: "2026-08-14T00:00:00.000Z" });
  const second = await processMaterial(request, { producer, cacheDir, now: "2026-08-14T00:01:00.000Z" });
  assert.equal(first.status, "completed");
  assert.equal(second.status, "idempotent_replay");
  assert.equal(second.material_id, first.material_id);
  assert.equal(second.idempotency_key, first.idempotency_key);
  assert.deepEqual(second.artifacts, first.artifacts);
  assert.equal(producer.calls, 1);
});

test("translation without original URL is quarantined before any model call", async () => {
  const producer = new SyntheticProducer();
  const result = await processMaterial(await fixture("translation-missing-original.request.json"), { producer });
  assert.equal(result.status, "quarantined");
  assert.equal(result.translation_state, "translation_original_missing");
  assert.equal(result.artifacts.target_zone, "translation-quarantine");
  assert.equal(result.artifacts.reading_markdown, null);
  assert.match(result.artifacts.quarantine_markdown, /未进入正常阅读池/);
  assert.equal(producer.calls, 0);
});

test("injecting original URL and Markdown restores the same material_id with a new idempotency key", async () => {
  const missing = await processMaterial(await fixture("translation-missing-original.request.json"), { producer: new SyntheticProducer() });
  const restored = await processMaterial(await fixture("translation-restored.request.json"), { producer: new SyntheticProducer() });
  assert.equal(restored.material_id, missing.material_id);
  assert.notEqual(restored.idempotency_key, missing.idempotency_key);
  assert.equal(restored.status, "completed");
  assert.equal(restored.translation_state, "aligned");
  assert.equal(restored.artifacts.target_zone, "local-ir-reading");
  assert.ok(restored.artifacts.bilingual.alignments.length >= 1);
  assert.ok(restored.artifacts.bilingual.alignments.every((item) => item.status === "aligned"));
});

test("invalid model output retries three times and degrades without losing body blocks", async () => {
  const producer = new SyntheticProducer({ invalid: true });
  const result = await processMaterial(await fixture("monolingual.request.json"), { producer });
  assert.equal(result.status, "completed_with_warnings");
  assert.equal(result.processing_state, "degraded");
  assert.equal(producer.calls, 3);
  assert.equal(result.receipt.model.calls, 3);
  assert.equal(result.artifacts.body_blocks.length, 4);
  assert.ok(result.errors.some((item) => item.code === "producer_output_rejected"));
  assert.match(result.artifacts.reading_markdown, /本次未生成通过校验的核心洞察/);
});

test("external producer payload uses a source-metadata allowlist", async () => {
  const producer = new SyntheticProducer();
  const request = await fixture("monolingual.request.json");
  request.source_metadata.cookie = "must-not-leave-local-process";
  request.source_metadata.authorization = "Bearer secret";
  request.source_metadata.headers = { "x-private": "secret" };
  await processMaterial(request, { producer });
  assert.equal(producer.lastPayload.source_metadata.cookie, undefined);
  assert.equal(producer.lastPayload.source_metadata.authorization, undefined);
  assert.equal(producer.lastPayload.source_metadata.headers, undefined);
  assert.equal(producer.lastPayload.source_metadata.source_url, request.source_metadata.source_url);
});
