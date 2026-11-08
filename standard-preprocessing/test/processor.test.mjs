import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { processMaterial, pruneUnreferencedReadingAnchors, PROCESSOR_VERSION } from "../lib/core.mjs";
import { bibliographicReferenceBlockKeys, chunkSourceTranslationBlocks, collapseDenseSourceTranslationBlocks, expandDenseSourceTranslationBlocks, extractProtectedHttpUrls, findEnglishNaturalLanguageResidues, isBibliographicReferenceBlock, isBilingualGlossaryBlock, mapConcurrentOrdered, normalizePureOralNoise, normalizeTranslationTokenWrappers, producerTranslationConcurrency, protectTranslationMarkdown, restoreTranslationMarkdown, stripUnexpectedTranslationInlineSyntax, translationLiteralBlockKeys, translationProtectedSyntax } from "../lib/producer.mjs";
import { validateMathLectureTerminology } from "../lib/math-lecture.mjs";
import { SyntheticProducer } from "../test-support/synthetic-producer.mjs";
import { GUIDE_COVERAGE_VERSION } from '../lib/guide-coverage.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtures = path.resolve(here, "..", "fixtures");

async function fixture(name) {
  return JSON.parse(await fs.readFile(path.join(fixtures, name), "utf8"));
}

test("bounded translation concurrency preserves chunk order", async () => {
  let active = 0;
  let peak = 0;
  const output = await mapConcurrentOrdered([40, 5, 20, 1, 10], 3, async (delay, index) => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, delay));
    active -= 1;
    return index;
  });
  assert.deepEqual(output, [0, 1, 2, 3, 4]);
  assert.equal(peak, 3);
  assert.equal(producerTranslationConcurrency({}), 4);
  assert.equal(producerTranslationConcurrency({ AI_PRODUCER_TRANSLATION_CONCURRENCY: "99" }), 8);
  assert.equal(producerTranslationConcurrency({ AI_PRODUCER_TRANSLATION_CONCURRENCY: "invalid" }), 4);
});

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
  assert.match(result.artifacts.reading_markdown, /- 是否继续阅读：4 精细阅读/);
  assert.match(result.artifacts.reading_markdown, /一、语义与渲染分离：/);
  assert.doesNotMatch(result.artifacts.reading_markdown, /具体用处/);
  for (const insight of result.artifacts.semantic.insights) {
    const target = result.artifacts.body_blocks.find((block) => block.source_block_key === insight.target_block_key);
    assert.ok(target);
    assert.match(result.artifacts.reading_markdown, new RegExp(`\\n\\[\\[#\\^${target.block_id}\\|正文跳转\\]\\]\\n\\n`));
    assert.match(result.artifacts.reading_markdown, new RegExp(`\\^${target.block_id}`));
  }
  const linkedBlockIds = new Set(result.artifacts.semantic.insights.map((insight) => (
    result.artifacts.body_blocks.find((block) => block.source_block_key === insight.target_block_key)?.block_id
  )));
  const unlinkedBlocks = result.artifacts.body_blocks.filter((block) => !linkedBlockIds.has(block.block_id));
  assert.ok(unlinkedBlocks.length > 0);
  for (const block of unlinkedBlocks) {
    assert.doesNotMatch(result.artifacts.reading_markdown, new RegExp(`^\\^${block.block_id}$`, "mu"));
  }
  const anchorValidation = result.receipt.validations.find((validation) => validation.name === "visible_body_anchor_pruning");
  assert.equal(anchorValidation.status, "passed");
  assert.equal(anchorValidation.details.visible_anchor_count, linkedBlockIds.size);
  assert.equal(anchorValidation.details.pruned_anchor_count, unlinkedBlocks.length);
});

test("a monolingual related-translation heading does not create a false bilingual alignment warning", async () => {
  const request = await fixture("monolingual.request.json");
  request.material.markdown += "\n\n## 相关译文\n\n[](https://example.invalid/translated-reference)";
  const result = await processMaterial(request, { producer: new SyntheticProducer() });
  assert.equal(result.status, "completed");
  assert.equal(result.translation_state, "not_translation");
  assert.equal(result.artifacts.bilingual.detection.bilingual, false);
  assert.equal(result.artifacts.bilingual.detection.has_translation, true);
  assert.ok(!result.errors.some((item) => item.code === "translation_alignment_pending"));
});

test("standalone programming statements are classified as protected code blocks", async () => {
  const producer = new SyntheticProducer();
  const request = await fixture("monolingual.request.json");
  request.material.markdown = [
    "# Programming example",
    "",
    "The following statement prints a greeting.",
    "",
    "System.out.println(\"Hello, World!\");",
    "",
    "public static void main(String[] args)"
  ].join("\n");
  const result = await processMaterial(request, { producer });
  assert.equal(result.status, "completed");
  const byMarkdown = new Map(producer.lastPayload.blocks.map((block) => [block.markdown, block.type]));
  assert.equal(byMarkdown.get('System.out.println("Hello, World!");'), "code");
  assert.equal(byMarkdown.get("public static void main(String[] args)"), "code");
  assert.equal(byMarkdown.get("The following statement prints a greeting."), "paragraph");
});

test("PDF structure comments do not hide fenced code from protected block classification", async () => {
  const producer = new SyntheticProducer();
  const request = await fixture("monolingual.request.json");
  request.material.markdown = [
    "# Programming example",
    "",
    "Translate this explanation.",
    "",
    "<!-- pdf-structure:code page=14 -->",
    "```java",
    "public class Welcome {",
    "    public static void main(String[] args) {}",
    "}",
    "```"
  ].join("\n");
  const result = await processMaterial(request, { producer });
  assert.equal(result.status, "completed");
  const code = producer.lastPayload.blocks.find((block) => block.markdown.includes("public class Welcome"));
  assert.equal(code?.type, "code");
  assert.match(result.artifacts.reading_markdown, /public class Welcome/u);
});

test("final anchor pruning removes only known unreferenced generated anchors", () => {
  const linked = "pr-111111111111";
  const unlinked = "pr-222222222222";
  const sourceOwned = "pr-333333333333";
  const input = [
    "## 核心洞察",
    "",
    `一、测试：洞察内容。`,
    `[[#^${linked}|正文跳转]]`,
    "",
    "## 正文",
    "",
    "第一段。",
    "",
    `^${linked}`,
    "",
    "第二段。",
    `正文内的普通链接不算前置卡引用：[[#^${unlinked}|其他链接]]。`,
    "",
    `^${unlinked}`,
    "",
    "原文自带锚点。",
    "",
    `^${sourceOwned}`,
    "",
    "^custom-anchor",
    ""
  ].join("\n");
  const finalized = pruneUnreferencedReadingAnchors(input, [linked, unlinked]);
  assert.match(finalized.markdown, new RegExp(`^\\^${linked}$`, "mu"));
  assert.doesNotMatch(finalized.markdown, new RegExp(`^\\^${unlinked}$`, "mu"));
  assert.match(finalized.markdown, new RegExp(`^\\^${sourceOwned}$`, "mu"));
  assert.match(finalized.markdown, /^\^custom-anchor$/mu);
  assert.deepEqual(finalized.referenced_block_ids, [linked]);
  assert.deepEqual(finalized.pruned_block_ids, [unlinked]);
  assert.doesNotMatch(finalized.markdown, /第二段。\n\n\n原文自带锚点。/u);
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

test("explicit existing-translation-only input preserves provenance without demanding an unavailable original body", async () => {
  const request = await fixture("translation-missing-original.request.json");
  request.source_metadata.original_url = "https://example.test/member-only-original";
  request.source_metadata.translation.existing_translation_only = true;
  const result = await processMaterial(request, { producer: new SyntheticProducer() });
  assert.equal(result.status, "completed");
  assert.equal(result.translation_state, "preserved_translation");
  assert.equal(result.artifacts.target_zone, "local-ir-reading");
  assert.equal(result.source_metadata.translation.is_translation, true);
  assert.equal(result.artifacts.bilingual.detection.has_original, false);
  delete request.source_metadata.original_url;
  const missing = await processMaterial(request, { producer: new SyntheticProducer() });
  assert.equal(missing.status, "quarantined");
  delete request.source_metadata.translation.existing_translation_only;
  request.source_metadata.original_url = "https://example.test/member-only-original";
  const ordinary = await processMaterial(request, { producer: new SyntheticProducer() });
  assert.equal(ordinary.translation_state, "alignment_pending");
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
  assert.equal(result.artifacts.semantic.judgments, null);
  assert.doesNotMatch(result.artifacts.reading_markdown, /本次未生成通过校验的核心洞察/);
});

test("five-level judgments render both extremes without changing the reading-depth scale", async () => {
  class FiveLevelProducer extends SyntheticProducer {
    async generate(payload) {
      const response = await super.generate(payload);
      response.output.judgments.value.level = "very_low";
      response.output.judgments.density.level = "very_high";
      return response;
    }
  }

  const result = await processMaterial(await fixture("monolingual.request.json"), {
    producer: new FiveLevelProducer(),
    now: "2026-08-21T00:00:00.000Z"
  });
  assert.equal(result.status, "completed");
  assert.match(result.artifacts.reading_markdown, /- 价值判断：极低/);
  assert.match(result.artifacts.reading_markdown, /- 信息密度判断：极高/);
  assert.match(result.artifacts.reading_markdown, /- 是否继续阅读：4 精细阅读/);
});

test("third rejected generation can enter the bounded insight-contract repair path", async () => {
  const base = new SyntheticProducer();
  const producer = {
    calls: 0,
    repairCalls: 0,
    validOutput: null,
    async generate(payload) {
      this.calls += 1;
      const generated = await base.generate(payload);
      this.validOutput = structuredClone(generated.output);
      generated.output.insights[0].description = `作者指出${generated.output.insights[0].description}`;
      generated.output.insights[0].target_block_key = "invented-key";
      return generated;
    },
    async repairInsights() {
      this.repairCalls += 1;
      return {
        output: structuredClone(this.validOutput),
        failures: [],
        repairValidationFailures: [],
        repairedIndexes: [0],
        provider: "synthetic",
        model: "synthetic-repair-v1",
        usage: null,
        api_calls: 1,
        call_ledger: [{ sequence: 1, attempted_at: "2026-08-20T00:00:00.000Z" }]
      };
    }
  };
  const result = await processMaterial(await fixture("monolingual.request.json"), { producer });
  assert.equal(result.status, "completed");
  assert.equal(producer.calls, 3);
  assert.equal(producer.repairCalls, 1);
  assert.equal(result.receipt.model.calls, 4);
  assert.equal(result.receipt.model.attempts[2].insight_contract_repair.status, "accepted");
  assert.deepEqual(result.receipt.model.attempts[2].insight_contract_repair.repaired_indexes, [0]);
});

test("a valid target and short generated description end retries immediately", async () => {
  const base = new SyntheticProducer();
  const producer = {
    calls: 0,
    repairCalls: 0,
    selectedDescription: null,
    validOutput: null,
    async generate(payload) {
      this.calls += 1;
      const generated = await base.generate(payload);
      this.validOutput = structuredClone(generated.output);
      if (this.calls === 1) {
        for (const insight of generated.output.insights) insight.target_block_key = "first-regression";
      } else if (this.calls === 2) {
        generated.output.insights[0].description = "这是一条仅需局部补全的说明。";
      } else {
        generated.output.insights[0].description = "更短。";
      }
      return generated;
    },
    async repairInsights({ semanticOutput }) {
      this.repairCalls += 1;
      this.selectedDescription = semanticOutput.insights[0].description;
      return {
        output: structuredClone(this.validOutput),
        failures: [],
        repairValidationFailures: [],
        repairedIndexes: [0],
        provider: "synthetic",
        model: "synthetic-repair-v1",
        usage: null,
        api_calls: 1,
        call_ledger: [{ sequence: 1, attempted_at: "2026-08-21T00:00:00.000Z" }]
      };
    }
  };
  const result = await processMaterial(await fixture("monolingual.request.json"), { producer });
  assert.equal(result.status, "completed");
  assert.equal(producer.calls, 2);
  assert.equal(producer.repairCalls, 0);
  assert.equal(result.artifacts.semantic.insights[0].description, "这是一条仅需局部补全的说明。");
  assert.equal(result.receipt.model.attempts.length, 2);
});

test("attribution boilerplate is removed deterministically anywhere in an insight without another model attempt", async () => {
  const base = new SyntheticProducer();
  const producer = {
    calls: 0,
    async generate(payload) {
      this.calls += 1;
      const generated = await base.generate(payload);
      generated.output.insights[0].description = `这段洞察重述了作者认为的核心判断：${generated.output.insights[0].description}`;
      return generated;
    }
  };
  const request = await fixture("monolingual.request.json");
  request.processing_options = { ...request.processing_options, attribute_unverified_claims: true };
  const result = await processMaterial(request, { producer });
  assert.equal(result.status, "completed");
  assert.equal(producer.calls, 1);
  assert.doesNotMatch(result.artifacts.semantic.insights[0].description, /作者认为/u);
  assert.match(result.artifacts.semantic.insights[0].description, /这一观点所述的核心判断/u);
  assert.deepEqual(result.receipt.model.attempts[0].deterministic_repairs.attribution_boilerplate_indexes, [0]);
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

test("runtime enforces contract version, root fields, processing options, and safe idempotency keys", async () => {
  const base = await fixture("monolingual.request.json");
  const cases = [
    { ...base, contract_version: "9.9.9" },
    { ...base, unexpected_field: true },
    { ...base, processing_options: { insight_safety_cap: "invalid" } },
    { ...base, idempotency_key: "../escape" }
  ];
  for (const request of cases) {
    const result = await processMaterial(request, { producer: new SyntheticProducer() });
    assert.equal(result.status, "failed");
    assert.equal(result.processing_state, "failed");
    assert.ok(result.errors.length >= 1);
  }
});

test("source-voice cleaning accepts ordered faithful patches with headings", async () => {
  const request = {
    schema_version: "progressive-reading.preprocess.request/v1",
    contract_version: "1.0.0",
    material: { markdown: "# 口述材料\n\n我觉得这个问题需要先拆开来讲。\n\n然后然后，第一步是保留原始判断，第二步是整理结构。\n\n我最后会检查全文是否仍然保持原来的视角。" },
    source_type: "synthetic_video_transcript",
    source_metadata: { source_url: "https://example.invalid/video", source_is_original: true },
    user_instruction: "保留第一人称，不出现时间戳。",
    processing_options: { cleaning_mode: "source_voice_structuring", preserve_source_voice: true, forbid_visible_timestamps: true, require_content_headings: true, attribute_unverified_claims: true }
  };
  const producer = {
    async generate(payload) {
      return {
        provider: "synthetic",
        model: "source-voice-cleaner-v1",
        usage: null,
        output: {
          cleaned_blocks: [
            {
              source_block_key: payload.blocks[1].source_block_key,
              markdown: "## 拆开问题\n\n我觉得这个问题需要先拆开来讲。"
            },
            {
              source_block_key: payload.blocks[2].source_block_key,
              markdown: "## 两步结构\n\n第一步是保留原始判断，第二步是整理结构。"
            },
            {
              source_block_key: payload.blocks[3].source_block_key,
              markdown: "## 检查视角\n\n我最后会检查全文是否仍然保持原来的视角。"
            }
          ],
          judgments: {
            value: { level: "medium", reason: "有可复用的方法。" },
            density: { level: "medium", reason: "信息集中。" },
            continue_reading: { level: 2, reason: "适合查看关键结论。" }
          },
          insights: [{ title: "保留视角", description: "结构化清洗不能改变原说话者视角，也不能把直接陈述改成第三人称转述；清理只能处理断句、机械重复和段落组织，并且必须保留原有判断力度、条件、依据和结论。", target_block_key: payload.blocks[1].source_block_key }],
          translation: { is_bilingual: false, alignments: [] }
        }
      };
    }
  };
  const result = await processMaterial(request, { producer });
  assert.equal(result.status, "completed");
  assert.match(result.artifacts.reading_markdown, /## 两步结构/u);
  assert.doesNotMatch(result.artifacts.reading_markdown, /然后然后/u);
  assert.doesNotMatch(result.artifacts.reading_markdown, /\d{1,2}:\d{2}/u);
});

test("long material accepts sparse cleaned-block patches and reconstructs full body locally", async () => {
  const paragraphs = Array.from({ length: 120 }, (_, index) => `第 ${index + 1} 段保真正文，包含足够的技术细节供长文回归验证。`);
  const request = {
    schema_version: "progressive-reading.preprocess.request/v1",
    contract_version: "1.0.0",
    material: { markdown: `# 长文稀疏补丁回归\n\n${paragraphs.join("\n\n")}` },
    source_type: "synthetic_long_markdown",
    source_metadata: {
      source_url: "https://example.invalid/synthetic/long",
      title: "长文稀疏补丁回归",
      source_is_original: true
    },
    user_instruction: "正文已确认无需修改，只生成语义层。",
    processing_options: { cleaning_mode: "semantic_only" }
  };
  const producer = {
    calls: 0,
    async generate(payload) {
      this.calls += 1;
      return {
        provider: "synthetic",
        model: "sparse-patch-v1",
        usage: null,
        output: {
          judgments: {
            value: { level: "high", reason: "长文合同值得验证。" },
            density: { level: "high", reason: "包含多个独立正文块。" },
            continue_reading: { level: 3, reason: "正文需完整保留。" }
          },
          insights: [{
            title: "稀疏输出",
            description: "未修改正文不需要由模型逐段回显；模型只返回语义结果，本地程序依据稳定 source key 补回全部正文，从而同时降低长文输出压力并保持逐块内容完整。",
            target_block_key: payload.blocks[1].source_block_key
          }],
          translation: { is_bilingual: false, alignments: [] }
        }
      };
    }
  };
  const result = await processMaterial(request, { producer });
  assert.equal(result.status, "completed");
  assert.equal(producer.calls, 1);
  assert.equal(result.artifacts.body_blocks.length, 121);
  assert.ok(result.artifacts.body_blocks.every((block) => block.source_hash === block.output_hash));
  assert.equal(result.receipt.validations.find((item) => item.name === "sparse_cleaned_block_merge")?.status, "passed");
});

test("sparse patches that alter LaTeX are rejected and degraded without changing the formula", async () => {
  const request = {
    schema_version: "progressive-reading.preprocess.request/v1",
    contract_version: "1.0.0",
    material: { markdown: "# 公式保护\n\n原式为 $x+y$，不得改动。" },
    source_type: "synthetic_math_markdown",
    source_metadata: { source_url: "https://example.invalid/synthetic/math", source_is_original: true },
    user_instruction: "保留 LaTeX。"
  };
  const producer = {
    calls: 0,
    async generate(payload) {
      this.calls += 1;
      return {
        provider: "synthetic",
        model: "invalid-math-patch-v1",
        usage: null,
        output: {
          cleaned_blocks: [{
            source_block_key: payload.blocks[1].source_block_key,
            markdown: "原式为 $x-y$，不得改动。"
          }],
          judgments: {
            value: { level: "medium", reason: "测试。" },
            density: { level: "medium", reason: "测试。" },
            continue_reading: { level: 2, reason: "测试。" }
          },
          insights: [],
          translation: { is_bilingual: false, alignments: [] }
        }
      };
    }
  };
  const result = await processMaterial(request, { producer });
  assert.equal(result.status, "completed_with_warnings");
  assert.equal(producer.calls, 3);
  assert.match(result.errors[0].message, /protected_inline_syntax_changed/u);
  assert.match(result.artifacts.reading_markdown, /\$x\+y\$/u);
  assert.doesNotMatch(result.artifacts.reading_markdown, /\$x-y\$/u);
});

test("source translation renders Chinese prose while preserving formulas, code, and URLs", async () => {
  const request = {
    schema_version: "progressive-reading.preprocess.request/v1",
    contract_version: "1.0.0",
    material: { markdown: "# Multiplication\n\nWe compute $x \\cdot y$ with `multiply(x, y)` and keep [the reference](https://example.invalid/ref).\n\n$$\nT(n)=3T(n/2)+O(n)\n$$\n\n```python\nprint(100 * 100)\n```" },
    source_type: "synthetic_cs_math_chapter",
    source_metadata: { source_url: "https://example.invalid/chapter", source_is_original: true, content_profile: "math_lecture" },
    user_instruction: "翻译成简体中文，公式、代码与链接保持不变。",
    processing_options: {
      cleaning_mode: "source_translation",
      translation_target_language: "zh-CN",
      preserve_source_voice: true,
      forbid_visible_timestamps: true,
      attribute_unverified_claims: true
    }
  };
  const producer = {
    async generate(payload) {
      const [heading, paragraph, displayMath, code] = payload.blocks;
      return {
        provider: "synthetic",
        model: "source-translation-v1",
        usage: null,
        output: {
          cleaned_blocks: [
            { source_block_key: heading.source_block_key, markdown: "# 乘法" },
            { source_block_key: paragraph.source_block_key, markdown: "我们使用 `multiply(x, y)` 计算 $x \\cdot y$，并保留[参考链接](https://example.invalid/ref)。" },
            { source_block_key: displayMath.source_block_key, markdown: displayMath.markdown },
            { source_block_key: code.source_block_key, markdown: code.markdown }
          ],
          judgments: {
            value: { level: "medium", reason: "包含基础算法概念。" },
            density: { level: "medium", reason: "信息集中。" },
            continue_reading: { level: 2, reason: "适合阅读关键结论。" }
          },
          insights: [{
            title: "乘法示例",
            description: "这一小节用乘法函数说明技术文本翻译必须同时保留数学表达式、函数调用和来源链接；自然语言可以转为中文，但受保护的公式、代码和 URL 仍需逐字一致。",
            target_block_key: paragraph.source_block_key
          }],
          translation: { is_bilingual: false, alignments: [] }
        }
      };
    }
  };
  const result = await processMaterial(request, { producer });
  assert.equal(result.status, "completed");
  assert.equal(result.translation_state, "generated_translation");
  assert.match(result.artifacts.reading_markdown, /# 乘法/u);
  assert.match(result.artifacts.reading_markdown, /\$x \\cdot y\$/u);
  assert.match(result.artifacts.reading_markdown, /T\(n\)=3T\(n\/2\)\+O\(n\)/u);
  assert.match(result.artifacts.reading_markdown, /`multiply\(x, y\)`/u);
  assert.match(result.artifacts.reading_markdown, /https:\/\/example\.invalid\/ref/u);
  assert.match(result.artifacts.reading_markdown, /print\(100 \* 100\)/u);
  assert.equal(result.receipt.validations.find((item) => item.name === "source_translation")?.status, "passed");
  assert.equal(result.receipt.validations.find((item) => item.name === "translation_protected_syntax")?.status, "passed");
});

test("translation URL protection stops at an inline-code fence before adjacent CJK prose", () => {
  const url = "https://arxiv.org/abs/2023.1234";
  const source = `Run \`download-paper ${url}\` command to add the paper.`;
  const translated = `运行 \`download-paper ${url}\`命令，将论文加入日志。`;
  const sourceSyntax = translationProtectedSyntax(source);
  const translatedSyntax = translationProtectedSyntax(translated);

  assert.deepEqual(sourceSyntax.urls, [url]);
  assert.deepEqual(translatedSyntax.urls, [url]);
  assert.deepEqual(translatedSyntax.inlineCode, sourceSyntax.inlineCode);
  assert.deepEqual(extractProtectedHttpUrls(`\`(retrieve '${url}')\` and \`${url}\`?`), [url, url]);
});

test("source translation accepts preserved inline-code URLs next to translated punctuation", async () => {
  const url = "https://arxiv.org/abs/2023.1234";
  const request = {
    schema_version: "progressive-reading.preprocess.request/v1",
    contract_version: "1.0.0",
    material: { markdown: `# Retrieval\n\nUse \`(retrieve '${url}')\` and later ask about \`${url}\`?` },
    source_type: "browser_capture_markdown",
    source_metadata: { source_url: "https://example.invalid/retrieval", source_is_original: true },
    user_instruction: "翻译成简体中文，代码与 URL 保持不变。",
    processing_options: {
      cleaning_mode: "source_translation",
      input_form: "written",
      translation_target_language: "zh-CN",
      preserve_source_voice: true,
      forbid_visible_timestamps: true,
      attribute_unverified_claims: true
    }
  };
  const producer = {
    async generate(payload) {
      const [heading, paragraph] = payload.blocks;
      return {
        provider: "synthetic",
        model: "inline-code-url-boundary-v1",
        usage: null,
        output: {
          cleaned_blocks: [
            { source_block_key: heading.source_block_key, markdown: "# 检索" },
            { source_block_key: paragraph.source_block_key, markdown: `使用 \`(retrieve '${url}')\`，随后询问 \`${url}\`？` }
          ],
          judgments: {
            value: { level: "medium", reason: "包含检索命令示例。" },
            density: { level: "medium", reason: "信息集中。" },
            continue_reading: { level: 2, reason: "适合阅读关键结论。" }
          },
          insights: [{
            title: "检索命令保持原样",
            description: "这一示例说明技术文章翻译时，反引号中的检索命令与 URL 必须逐字保留；中文标点可以紧随代码围栏出现，但不能因此被错误识别为 URL 内容变化。",
            target_block_key: paragraph.source_block_key
          }],
          translation: { is_bilingual: false, alignments: [] }
        }
      };
    }
  };

  const result = await processMaterial(request, { producer });
  assert.equal(result.status, "completed");
  assert.equal(result.processing_state, "rendered");
  assert.deepEqual(result.errors, []);
});

test("translation protection restores Markdown list markers and formulas byte-for-byte", () => {
  const source = "* Compute $x+y$ with `sum(x, y)` and see [the local copy](assets/example.py).";
  const protectedValue = protectTranslationMarkdown(source, { includeMath: true });
  assert.doesNotMatch(protectedValue.protectedMarkdown, /^\* /u);
  const translated = protectedValue.protectedMarkdown.replace("Compute", "计算").replace("with", "并使用").replace("and see", "，参见");
  const restored = restoreTranslationMarkdown(translated, protectedValue.values);
  assert.match(restored, /^\* /u);
  assert.match(restored, /\$x\+y\$/u);
  assert.match(restored, /`sum\(x, y\)`/u);
  assert.match(restored, /\]\(assets\/example\.py\)/u);
});

test("translation protection rejects reordered formulas instead of silently changing meaning", () => {
  const source = "It takes $1,600$ seconds to compute $x\\cdot y$.";
  const protectedValue = protectTranslationMarkdown(source, { includeMath: true });
  const [first, second] = protectedValue.values.map((item) => item.token);
  const reordered = `计算 ${second} 大约需要 ${first} 秒。`;
  assert.throws(
    () => restoreTranslationMarkdown(reordered, protectedValue.values),
    /translation_protected_token_order:expected=.*:actual=/u
  );
});

test("translation chunking isolates blocks with many protected tokens", () => {
  const dense = Array.from({ length: 12 }, (_item, index) => `$x_${index}$`).join(" ");
  const blocks = [
    { source_block_key: "a", markdown: "plain introduction" },
    { source_block_key: "b", markdown: dense },
    { source_block_key: "c", markdown: "plain conclusion" }
  ];
  assert.deepEqual(chunkSourceTranslationBlocks(blocks).map((chunk) => chunk.map((block) => block.source_block_key)), [["a"], ["b"], ["c"]]);
});

test("dense multiline paragraphs translate as line units and collapse to the original source key", () => {
  const formulas = Array.from({ length: 12 }, (_item, index) => `$x_${index}$`).join(" ");
  const source = [{ source_block_key: "src-dense", type: "paragraph", markdown: `First ${formulas}.\nSecond sentence.` }];
  const expanded = expandDenseSourceTranslationBlocks(source);
  assert.deepEqual(expanded.units.map((block) => block.source_block_key), ["src-dense::line-01", "src-dense::line-02"]);
  const collapsed = collapseDenseSourceTranslationBlocks(expanded.groups, [
    { source_block_key: "src-dense::line-01", markdown: `第一句 ${formulas}。` },
    { source_block_key: "src-dense::line-02", markdown: "第二句。" }
  ]);
  assert.deepEqual(collapsed, [{ source_block_key: "src-dense", markdown: `第一句 ${formulas}。\n第二句。` }]);
});

test("math translation terminology validation is driven by the current material term set", () => {
  const source = "An _algorithm_ operates on a _data structure_.";
  const terms = ["algorithm", "data structure"];
  assert.deepEqual(validateMathLectureTerminology(source, "algorithm 对 data structure 执行操作。", terms), []);
  assert.deepEqual(
    validateMathLectureTerminology(source, "算法对 data structure 执行操作。", terms),
    ["preserved_term_count_algorithm"]
  );
});

test("translation protection does not mistake TeX-style opening quotes for empty inline code", () => {
  const source = "It seems like the ``obviously best'' way to multiply; use `multiply(x, y)` for the implementation.";
  const protectedValue = protectTranslationMarkdown(source);
  assert.match(protectedValue.protectedMarkdown, /``obviously best''/u);
  assert.equal(protectedValue.values.length, 1);
  assert.equal(protectedValue.values[0].value, "`multiply(x, y)`");

  const translated = protectedValue.protectedMarkdown.replace(
    "It seems like the ``obviously best'' way to multiply; use",
    "这似乎是相乘时“显然最优”的方法；实现时使用"
  ).replace("for the implementation.", "。 ");
  const restored = restoreTranslationMarkdown(translated, protectedValue.values);
  assert.match(restored, /“显然最优”/u);
  assert.match(restored, /`multiply\(x, y\)`/u);
});

test("source translation core validation shares the TeX-quote-safe inline-code rule", async () => {
  const request = {
    schema_version: "progressive-reading.preprocess.request/v1",
    contract_version: "1.0.0",
    material: {
      markdown: "# Quoted algorithm\n\nIt seems like the ``obviously best'' way to multiply $n$ digit numbers."
    },
    source_type: "synthetic_cs_math_chapter",
    source_metadata: { source_url: "https://example.invalid/tex-quotes", source_is_original: true, content_profile: "math_lecture" },
    user_instruction: "完整翻译成简体中文，公式保持不变。",
    processing_options: {
      cleaning_mode: "source_translation",
      translation_target_language: "zh-CN",
      preserve_source_voice: true
    }
  };
  const producer = {
    async generate(payload) {
      return {
        provider: "synthetic",
        model: "tex-quote-safe-v1",
        usage: null,
        output: {
          cleaned_blocks: [
            { source_block_key: payload.blocks[0].source_block_key, markdown: "# 带引号的算法" },
            { source_block_key: payload.blocks[1].source_block_key, markdown: "这似乎是将 $n$ 位数字相乘时“显然最优”的方法。" }
          ],
          judgments: {
            value: { level: "medium", reason: "验证技术翻译保护规则。" },
            density: { level: "medium", reason: "包含算法与数学表达式。" },
            continue_reading: { level: 2, reason: "适合查看算法结论。" }
          },
          insights: [{
            title: "技术引号与公式分离处理",
            description: "TeX 风格的双反引号只是英文排版中的开引号，不能误识别为行内代码；翻译时应将自然语言引号正常转换，同时逐字保留其中真正受保护的数学公式。",
            target_block_key: payload.blocks[1].source_block_key
          }],
          translation: { is_bilingual: false, alignments: [] }
        }
      };
    }
  };
  const result = await processMaterial(request, { producer });
  assert.equal(result.status, "completed");
  assert.equal(result.processing_state, "rendered");
  assert.equal(result.translation_state, "generated_translation");
  assert.deepEqual(result.errors, []);
  assert.match(result.artifacts.reading_markdown, /“显然最优”/u);
  assert.match(result.artifacts.reading_markdown, /\$n\$/u);
});

test("source translation renders its accepted body heading instead of untranslated source metadata", async () => {
  const request = {
    schema_version: "progressive-reading.preprocess.request/v1",
    contract_version: "1.0.0",
    material: { markdown: "# Introduction {#intro}\n\nThis chapter introduces theoretical computer science." },
    source_type: "synthetic_cs_chapter",
    source_metadata: {
      source_url: "https://example.invalid/introduction",
      source_is_original: true,
      title: "Introduction to Theoretical Computer Science: Introduction",
      split: { split_id: "split-introduction" }
    },
    user_instruction: "完整翻译成简体中文。",
    processing_options: { cleaning_mode: "source_translation", translation_target_language: "zh-CN" }
  };
  const producer = {
    async generate(payload) {
      return {
        provider: "synthetic",
        model: "translated-title-v1",
        usage: null,
        output: {
          cleaned_blocks: [
            { source_block_key: payload.blocks[0].source_block_key, markdown: "# 引言" },
            { source_block_key: payload.blocks[1].source_block_key, markdown: "本章介绍理论计算机科学。" }
          ],
          judgments: {
            value: { level: "medium", reason: "介绍基础主题。" },
            density: { level: "medium", reason: "内容集中。" },
            continue_reading: { level: 2, reason: "适合查看关键结论。" }
          },
          insights: [{
            title: "理论计算机科学导论",
            description: "本章通过基础概念说明理论计算机科学研究的对象与方法，并为后续算法、计算模型和复杂度分析等主题建立统一的阅读起点，使读者能够沿着明确的论证顺序继续理解全书结构。",
            target_block_key: payload.blocks[1].source_block_key
          }],
          translation: { is_bilingual: false, alignments: [] }
        }
      };
    }
  };
  const result = await processMaterial(request, { producer });
  assert.equal(result.status, "completed");
  assert.match(result.artifacts.reading_markdown, /^# 引言$/mu);
  assert.doesNotMatch(result.artifacts.reading_markdown, /^# Introduction to Theoretical Computer Science/mu);
});

test("retained English is observable but does not reject a mixed Chinese translation", async () => {
  assert.deepEqual(findEnglishNaturalLanguageResidues("引语， attributed to Edsger Dijkstra。"), []);
  assert.deepEqual(findEnglishNaturalLanguageResidues("可以 asking for help，也可以 depend on others，利用 gains from trade。"), []);
  assert.deepEqual(findEnglishNaturalLanguageResidues("保留 one two three four five six seven eight nine ten。"), []);
  assert.deepEqual(findEnglishNaturalLanguageResidues("示例 " + "word ".repeat(40)), []);
  assert.deepEqual(findEnglishNaturalLanguageResidues("残留 " + "word ".repeat(41)), ["word ".repeat(41).trim()]);
  assert.deepEqual(findEnglishNaturalLanguageResidues("署名：Edsger Dijkstra；主题涉及 NP 与 RSA。"), []);
  assert.deepEqual(findEnglishNaturalLanguageResidues("该名称来自 Bourne Again SHell，并缩写为 BASH。"), []);
  assert.deepEqual(findEnglishNaturalLanguageResidues("This Ordinary sentence Has internal capitals and remains completely untranslated in the output."), []);
  const request = {
    schema_version: "progressive-reading.preprocess.request/v1",
    contract_version: "1.0.0",
    material: { markdown: "# Quotation\n\nThe quotation is attributed to Edsger Dijkstra and explains the role of computers." },
    source_type: "synthetic_cs_chapter",
    source_metadata: { source_url: "https://example.invalid/quotation", source_is_original: true },
    user_instruction: "完整翻译成简体中文。",
    processing_options: { cleaning_mode: "source_translation", translation_target_language: "zh-CN" }
  };
  const producer = {
    calls: 0,
    async generate(payload) {
      this.calls += 1;
      return {
        provider: "synthetic",
        model: "residual-english-v1",
        usage: null,
        output: {
          cleaned_blocks: [
            { source_block_key: payload.blocks[0].source_block_key, markdown: "# 引语" },
            { source_block_key: payload.blocks[1].source_block_key, markdown: "这句话解释了计算机的作用， " + "ordinary untranslated prose remains in the output ".repeat(6) }
          ],
          judgments: {
            value: { level: "medium", reason: "验证翻译完整性。" },
            density: { level: "medium", reason: "包含一条引语。" },
            continue_reading: { level: 2, reason: "适合查看关键结论。" }
          },
          insights: [],
          translation: { is_bilingual: false, alignments: [] }
        }
      };
    }
  };
  const result = await processMaterial(request, { producer });
  assert.equal(producer.calls, 1);
  assert.equal(result.status, "completed");
  assert.deepEqual(result.errors, []);
});

test("translation completeness allows unchanged bibliographic references but not ordinary English prose", async () => {
  assert.equal(isBibliographicReferenceBlock("- P. Deitel, H. Deitel, Java: How to Program"), true);
  assert.equal(isBibliographicReferenceBlock("- Y. Daniel Liang, Introduction to Java Programming, 2020."), true);
  assert.equal(isBibliographicReferenceBlock("The quotation is attributed to Edsger Dijkstra."), false);
  const fragmented = [
    { source_block_key: "heading", markdown: "## Reference books" },
    { source_block_key: "authors", markdown: "- Allen B. Downey and Chris Mayfield." },
    { source_block_key: "title", markdown: "Think Java, How to Think Like a" },
    { source_block_key: "tail", markdown: "Computer Scientist, O'Reilly, 2016." },
    { source_block_key: "next", markdown: "## Course syllabus" },
    { source_block_key: "prose", markdown: "This ordinary English sentence must be translated." }
  ];
  assert.deepEqual([...bibliographicReferenceBlockKeys(fragmented)], ["authors", "title", "tail"]);
  assert.equal(isBilingualGlossaryBlock("- Standard input/output 标准输入输出 Assignment operator 赋值运算符"), true);
  assert.equal(isBilingualGlossaryBlock("This ordinary English sentence includes 中文。"), false);
  const glossary = [
    { source_block_key: "glossary-heading", markdown: "## Appendix – Terms" },
    { source_block_key: "glossary-entry", markdown: "- Standard input/output 标准输入输出 Assignment operator 赋值运算符" },
    { source_block_key: "next-heading", markdown: "## Exercises" },
    { source_block_key: "exercise", markdown: "Translate this ordinary English instruction." }
  ];
  assert.deepEqual([...translationLiteralBlockKeys(glossary)], ["glossary-entry"]);
  const request = {
    schema_version: "progressive-reading.preprocess.request/v1",
    contract_version: "1.0.0",
    material: { markdown: "# References\n\n- P. Deitel, H. Deitel, Java: How to Program" },
    source_type: "synthetic_bibliography",
    source_metadata: { source_url: "https://example.invalid/bibliography", source_is_original: true },
    user_instruction: "正文翻译为简体中文，书目记录原样保留。",
    processing_options: { cleaning_mode: "source_translation", translation_target_language: "zh-CN" }
  };
  const producer = {
    async generate(payload) {
      return {
        provider: "synthetic",
        model: "bibliography-preservation-v1",
        usage: null,
        output: {
          cleaned_blocks: [
            { source_block_key: payload.blocks[0].source_block_key, markdown: "# 参考文献" },
            { source_block_key: payload.blocks[1].source_block_key, markdown: payload.blocks[1].markdown }
          ],
          judgments: {
            value: { level: "medium", reason: "验证书目保真。" },
            density: { level: "low", reason: "仅包含书目记录。" },
            continue_reading: { level: 1, reason: "用于核对来源。" }
          },
          insights: [],
          translation: { is_bilingual: false, alignments: [] }
        }
      };
    }
  };
  const result = await processMaterial(request, { producer });
  assert.equal(result.status, "completed");
  assert.match(result.artifacts.reading_markdown, /P\. Deitel, H\. Deitel, Java: How to Program/u);
});

test("source translation preserves English GFM tables as protected atomic blocks", async () => {
  const table = "| Name | Count |\n| --- | ---: |\n| Alpha | 2 |";
  const request = {
    schema_version: "progressive-reading.preprocess.request/v1",
    contract_version: "1.0.0",
    material: { markdown: `# Data table\n\n${table}` },
    source_type: "synthetic_table_translation",
    source_metadata: { source_url: "https://example.invalid/table", source_is_original: true },
    user_instruction: "正文翻译为简体中文，表格原样保护。",
    processing_options: { cleaning_mode: "source_translation", translation_target_language: "zh-CN" }
  };
  const producer = {
    async generate(payload) {
      return {
        provider: "synthetic",
        model: "table-preservation-v1",
        usage: null,
        output: {
          cleaned_blocks: [
            { source_block_key: payload.blocks[0].source_block_key, markdown: "# 数据表" },
            { source_block_key: payload.blocks[1].source_block_key, markdown: payload.blocks[1].markdown }
          ],
          judgments: {
            value: { level: "medium", reason: "验证表格保真。" },
            density: { level: "low", reason: "仅包含一个表格。" },
            continue_reading: { level: 1, reason: "用于查看表格。" }
          },
          insights: [],
          translation: { is_bilingual: false, alignments: [] }
        }
      };
    }
  };
  const result = await processMaterial(request, { producer });
  assert.equal(result.status, "completed");
  assert.match(result.artifacts.reading_markdown, /\| Name \| Count \|/u);
});

test("translation restoration preserves display-math dollar delimiters literally", () => {
  const source = "$$\nT(n)=3T(n/2)+O(n)\n$$";
  const protectedValue = protectTranslationMarkdown(source, { includeMath: true });
  const restored = restoreTranslationMarkdown(protectedValue.protectedMarkdown, protectedValue.values);
  assert.equal(restored, source);
  assert.equal(stripUnexpectedTranslationInlineSyntax(restored, source, { includeMath: true }), source);
});

test("translation token wrapper normalization removes model-added math and code delimiters", () => {
  const source = "Use $x+y$ in the proof.";
  const protectedValue = protectTranslationMarkdown(source, { includeMath: true });
  const token = protectedValue.values[0].token;
  for (const wrapped of [`\`${token}\``, `\`  ${token} \``, `$${token}$`, `$$ ${token} $$`, `\\(${token}\\)`, `\\( ${token} \\)`, `\\[${token}\\]`]) {
    const normalized = normalizeTranslationTokenWrappers(`在证明中使用 ${wrapped}。`, protectedValue.values);
    const restored = restoreTranslationMarkdown(normalized, protectedValue.values);
    assert.equal(restored, "在证明中使用 $x+y$。");
  }
});

test("translation inline normalization keeps source syntax and unwraps model-added syntax", () => {
  const source = "Compare $x$ with `value` in the proof.";
  const candidate = "在证明中，将 $x$ 与 `value` 以及新增的 $T(n)$、`complexity` 比较。";
  const normalized = stripUnexpectedTranslationInlineSyntax(candidate, source, { includeMath: true });
  assert.match(normalized, /\$x\$/u);
  assert.match(normalized, /`value`/u);
  assert.match(normalized, /T\(n\)/u);
  assert.match(normalized, /complexity/u);
  assert.doesNotMatch(normalized, /\$T\(n\)\$|`complexity`/u);
});

test("deterministic normalization preserves fenced-code whitespace exactly", async () => {
  const code = [
    "```python",
    "x = 1  ",
    "",
    "",
    "y = 2",
    "```"
  ].join("\n");
  const request = {
    schema_version: "progressive-reading.preprocess.request/v1",
    contract_version: "1.0.0",
    material: { markdown: `# 代码空白保护\n\n${code}` },
    source_type: "synthetic_code_markdown",
    source_metadata: { source_url: "https://example.invalid/synthetic/code", source_is_original: true },
    user_instruction: "代码块逐字保留。",
    processing_options: { cleaning_mode: "semantic_only" }
  };
  const producer = {
    async generate(payload) {
      return {
        provider: "synthetic",
        model: "semantic-only-v1",
        usage: null,
        output: {
          judgments: {
            value: { level: "medium", reason: "验证代码保真。" },
            density: { level: "medium", reason: "验证代码保真。" },
            continue_reading: { level: 2, reason: "验证代码保真。" }
          },
          insights: [{
            title: "代码保真",
            description: "围栏代码块内部的空白、连续空行和行尾空格都不应被正文规范化逻辑改写；本地渲染必须逐字保存受保护语法，使输入与输出哈希能够证明代码内容没有发生变化。",
            target_block_key: payload.blocks[1].source_block_key
          }],
          translation: { is_bilingual: false, alignments: [] }
        }
      };
    }
  };
  const result = await processMaterial(request, { producer });
  const codeBlock = result.artifacts.body_blocks.find((block) => block.type === "code");
  assert.equal(result.status, "completed");
  assert.equal(codeBlock.markdown, code);
  assert.equal(codeBlock.source_hash, codeBlock.output_hash);
  assert.equal(result.receipt.processor_version, PROCESSOR_VERSION);
  assert.equal(result.receipt.prompt_version, "source-translation-v2.2-five-level-judgments:" + GUIDE_COVERAGE_VERSION);
});

test("deterministic oral-noise normalization removes only known conversation mechanics", () => {
  const normalized = normalizePureOralNoise("我想问一下，我现在该怎么呃，学 Agent？还有别的问题吗？然后然后先转组，大哥。");
  assert.equal(normalized, "我现在该怎么学 Agent？然后先转组。");
  assert.doesNotMatch(normalized, /我想问一下|呃|还有别的问题吗|然后然后|大哥/u);
  assert.match(normalized, /学 Agent|先转组/u);
});

test("lossless spoken-to-written cleaning merges adjacent transcript blocks with complete auditable coverage", async () => {
  const request = {
    schema_version: "progressive-reading.preprocess.request/v1",
    contract_version: "1.0.0",
    material: { markdown: "我想问一下，明白吗？嵌入式到底需要多少计算机基础？\n\n明白。嗯，我觉得大多数单片机项目只需要较简单的操作系统与存储知识。\n\n然后然后，除非做 Android 或底层开发，否则不必照搬大型互联网系统的完整技术栈。\n\n大哥，还有别的问题吗？没有了，谢谢。" },
    source_type: "synthetic_video_transcript",
    source_metadata: { source_url: "https://example.invalid/video/lossless", source_is_original: true },
    user_instruction: "转成结构化书面文本。",
    processing_options: {
      cleaning_mode: "lossless_spoken_to_written",
      preserve_source_voice: true,
      forbid_visible_timestamps: true,
      require_content_headings: false
    }
  };
  const producer = {
    async generate(payload) {
      const keys = payload.blocks.map((block) => block.source_block_key);
      return {
        provider: "synthetic",
        model: "lossless-spoken-cleaner-v1",
        usage: null,
        output: {
          cleaned_sections: [
            {
              source_block_keys: keys.slice(0, 2),
              markdown: "## 嵌入式所需的计算机基础\n\n我觉得，大多数单片机项目只需要较简单的操作系统与存储知识。",
              reason: "把提问背景并入直接论述，删除确认语和口头填充"
            },
            {
              source_block_keys: keys.slice(2),
              markdown: "## 与大型互联网技术栈的区别\n\n除非做 Android 或底层开发，否则不必照搬大型互联网系统的完整技术栈。",
              reason: "删除机械重复和会话收尾，并补充纯导航标题"
            }
          ],
          judgments: {
            value: { level: "medium", reason: "解释了学习边界。" },
            density: { level: "medium", reason: "结论集中。" },
            continue_reading: { level: 2, reason: "适合查看关键结论。" }
          },
          insights: [{ title: "学习边界", description: "多数单片机项目只需要较简单的操作系统与存储知识，不必照搬大型互联网系统的完整技术栈；只有进入 Android 或底层开发等目标时，才需要补充相应知识并调整学习深度。", target_block_key: keys[1] }],
          translation: { is_bilingual: false, alignments: [] }
        }
      };
    }
  };
  const result = await processMaterial(request, { producer });
  assert.equal(result.status, "completed");
  assert.equal(result.artifacts.body_blocks.length, 2);
  assert.equal(result.artifacts.cleaning_manifest.source_nodes.length, 4);
  assert.equal(result.artifacts.cleaning_manifest.mappings.length, 4);
  assert.ok(result.artifacts.cleaning_manifest.mappings.every((item) => item.status === "structured_with_original"));
  assert.doesNotMatch(result.artifacts.reading_markdown, /我想问一下|明白吗|还有别的问题吗|谢谢/u);
  assert.match(result.artifacts.reading_markdown, /## 嵌入式所需的计算机基础/u);
  const linkedBlock = result.artifacts.body_blocks[0];
  assert.match(result.artifacts.reading_markdown, new RegExp(`\\[\\[#\\^${linkedBlock.block_id}\\|正文跳转\\]\\]`));
});
