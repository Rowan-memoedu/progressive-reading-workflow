import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { processMaterial, PROCESSOR_VERSION } from "../lib/core.mjs";
import { generateChunkedSourceVoice, rejectLowFidelityWrittenPatches, shouldChunkSourceVoice, validateWrittenCleaningChunk } from "../lib/producer.mjs";
import { validateResultContract } from "../index.mjs";
import { SyntheticProducer } from "../test-support/synthetic-producer.mjs";

function requestFor(markdown, suffix = "table-test") {
  return {
    schema_version: "progressive-reading.preprocess.request/v1",
    contract_version: "1.0.0",
    source_type: "pdf",
    material_id: `synthetic-${suffix}`,
    material: { markdown },
    source_metadata: {
      source_url: `file:///synthetic/${suffix}.pdf`,
      title: `Synthetic ${suffix}`,
      language: "zh",
      source_is_original: true,
      translation: {
        is_translation: false,
        original_url: null,
        original_language: "zh",
        translation_language: "zh"
      }
    },
    user_instruction: "仅做来源忠实的结构化处理。",
    processing_options: {
      cleaning_mode: "source_voice_structuring",
      preserve_source_voice: true,
      forbid_visible_timestamps: true,
      require_content_headings: true,
      attribute_unverified_claims: true
    }
  };
}

test("source voice routes medium-long captures through bounded chunks before monolithic JSON can truncate", () => {
  assert.equal(shouldChunkSourceVoice({
    blocks: Array.from({ length: 194 }, () => ({ markdown: "正文" })),
    source_statistics: { non_whitespace_chars: 52000 }
  }), true);
  assert.equal(shouldChunkSourceVoice({
    blocks: Array.from({ length: 48 }, () => ({ markdown: "正文" })),
    source_statistics: { non_whitespace_chars: 12000 }
  }), false);
});

test("chunked source voice inherits a bilingual route and requires a ready alignment", async () => {
  const blocks = [
    { source_block_key: "zh-1", type: "paragraph", markdown: "这是一段完整中文原文。" },
    { source_block_key: "en-1", type: "paragraph", markdown: "This is the complete English translation." }
  ];
  const payload = {
    blocks,
    source_metadata: { language: "bilingual" },
    cleaning_policy: { mode: "source_voice_structuring" },
    insight_policy: { soft_target: { min: 1, max: 3 }, safety_cap: 6 },
    user_instruction: ""
  };
  const generated = await generateChunkedSourceVoice({}, payload, [], new Map(), async (_config, prompt) => {
    if (prompt.system.includes("来源忠实清洗器")) return { output: { cleaned_blocks: [] }, usage: null };
    assert.match(prompt.user, /完整原文与译文/u);
    return {
      output: {
        judgments: {
          value: { level: "medium", reason: "内容可用于验证双语长文分支。" },
          density: { level: "medium", reason: "原文和译文各占一个正文块。" },
          continue_reading: { level: 2, reason: "适合概览双语对应关系。" }
        },
        insights: [{
          title: "双语对应",
          description: "双语长文分块处理必须继承路由阶段已经确认的原文与译文关系，并在语义输出中保留至少一组可靠对应，才能进入正常阅读区并避免产生待对齐警告。",
          target_block_key: "zh-1"
        }],
        translation: {
          is_bilingual: true,
          alignments: [{ original_block_key: "zh-1", translation_block_key: "en-1", confidence: 0.95, status: "aligned" }]
        }
      },
      usage: null
    };
  });
  assert.equal(generated.output.translation.is_bilingual, true);
  assert.equal(generated.output.translation.alignments[0].status, "aligned");
});

const tableMarkdown = [
  "# 合成表格材料",
  "",
  "| 名称 | 数量 |",
  "| :--- | ---: |",
  "| Alpha | 2 |",
  "| Beta | 5 |",
  "",
  "## 第一部分",
  "",
  "第一部分正文保留表格的字段含义与阅读顺序。",
  "",
  "## 第二部分",
  "",
  "| 项目 | 状态 | 说明 |",
  "| --- | :---: | --- |",
  "| A | 完成 | 保持原样 |",
  "",
  "## 第三部分",
  "",
  "第三部分正文用于满足合成材料的导航结构。"
].join("\n");

test("minimal and mixed GFM tables remain protected atomic body blocks", async () => {
  const result = await processMaterial(requestFor(tableMarkdown), { producer: new SyntheticProducer() });
  assert.equal(result.status, "completed");
  assert.equal(result.processing_state, "rendered");
  const tables = result.artifacts.body_blocks.filter((block) => block.type === "table");
  assert.equal(tables.length, 2);
  assert.equal(tables[0].markdown, "| 名称 | 数量 |\n| :--- | ---: |\n| Alpha | 2 |\n| Beta | 5 |");
  assert.equal(tables[1].markdown, "| 项目 | 状态 | 说明 |\n| --- | :---: | --- |\n| A | 完成 | 保持原样 |");
  assert.match(result.artifacts.reading_markdown, /\| Alpha \| 2 \|/u);
  assert.equal((await validateResultContract(result)).valid, true);
});

test("a producer modification to a GFM table fails closed with table_block_changed", async () => {
  const base = new SyntheticProducer();
  const producer = {
    calls: 0,
    async generate(payload) {
      this.calls += 1;
      const generated = await base.generate(payload);
      const table = payload.blocks.find((block) => block.type === "table");
      generated.output.cleaned_blocks = generated.output.cleaned_blocks.map((block) => block.source_block_key === table.source_block_key
        ? { ...block, markdown: block.markdown.replace("Alpha", "Changed") }
        : block);
      return generated;
    }
  };
  const result = await processMaterial(requestFor(tableMarkdown, "changed-table"), { producer });
  assert.equal(result.status, "completed_with_warnings");
  assert.equal(result.processing_state, "degraded");
  assert.equal(producer.calls, 3);
  assert.ok(result.errors.some((error) => error.message.includes("table_block_changed")));
  assert.deepEqual(validateWrittenCleaningChunk({ cleaned_blocks: [{
    source_block_key: "table-key",
    markdown: "| A | B |\n| --- | --- |\n| changed | 1 |"
  }] }, [{
    source_block_key: "table-key",
    type: "table",
    markdown: "| A | B |\n| --- | --- |\n| original | 1 |"
  }]), ["table_block_changed:table-key"]);
  assert.deepEqual(validateWrittenCleaningChunk({ cleaned_blocks: [{
    source_block_key: "paragraph-key",
    markdown: "完全不同且删除了原始信息的短句。"
  }] }, [{
    source_block_key: "paragraph-key",
    type: "paragraph",
    markdown: "原始正文包含需要完整保留的条件、依据、例子、数字、专名、边界和最终结论，不能被摘要或替换。"
  }]), ["fidelity_too_low:paragraph-key"]);
});

test("a result that fails the result contract is not written to the idempotency cache", async () => {
  const cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), "pr-invalid-result-cache-"));
  const result = await processMaterial(requestFor(tableMarkdown, "invalid-result"), {
    producer: new SyntheticProducer(),
    cacheDir,
    now: {}
  });
  assert.equal((await validateResultContract(result)).valid, false);
  await assert.rejects(fs.access(path.join(cacheDir, `${result.idempotency_key}.json`)));
});

test("a stale invalid cache entry is not replayed", async () => {
  const cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), "pr-stale-result-cache-"));
  const request = requestFor(tableMarkdown, "stale-cache");
  const first = await processMaterial(request, { producer: new SyntheticProducer(), cacheDir });
  const cachePath = path.join(cacheDir, `${first.idempotency_key}.json`);
  const stale = JSON.parse(await fs.readFile(cachePath, "utf8"));
  stale.receipt.processor_version = "1.9.0";
  stale.artifacts.body_blocks[0].type = "invalid-old-type";
  await fs.writeFile(cachePath, `${JSON.stringify(stale, null, 2)}\n`, "utf8");
  const producer = new SyntheticProducer();
  const second = await processMaterial(request, { producer, cacheDir });
  assert.equal(second.status, "completed");
  assert.equal(producer.calls, 1);
  assert.equal(second.receipt.processor_version, PROCESSOR_VERSION);
});

test("a legacy degraded cache entry is a cache miss and only a publishable completion can replay", async () => {
  const cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), "pr-degraded-result-cache-"));
  const request = requestFor(tableMarkdown, "degraded-cache");
  const degraded = await processMaterial(request, {
    producer: new SyntheticProducer({ invalid: true }),
    cacheDir
  });
  const cachePath = path.join(cacheDir, `${degraded.idempotency_key}.json`);
  assert.equal(degraded.status, "completed_with_warnings");
  assert.equal(degraded.processing_state, "degraded");
  await assert.rejects(fs.access(cachePath));

  // Simulate a cache written by an older processor version with the same published contract.
  await fs.writeFile(cachePath, `${JSON.stringify(degraded, null, 2)}\n`, "utf8");
  const repairedProducer = new SyntheticProducer();
  const repaired = await processMaterial(request, { producer: repairedProducer, cacheDir });
  assert.equal(repaired.status, "completed");
  assert.equal(repaired.processing_state, "rendered");
  assert.equal(repaired.artifacts.target_zone, "local-ir-reading");
  assert.equal(repaired.receipt.replay_of_status, undefined);
  assert.equal(repairedProducer.calls, 1);

  const replayed = await processMaterial(request, {
    producer: { async generate() { throw new Error("ready_result_must_replay_without_producer"); } },
    cacheDir
  });
  assert.equal(replayed.status, "idempotent_replay");
  assert.equal(replayed.processing_state, "rendered");
});

test("written patch rejection applies valid edits and preserves source when optional paragraph patches violate fidelity or protected syntax", () => {
  const blocks = [
    { source_block_key: "valid", type: "paragraph", markdown: "这是一段来源正文，包含完整条件、依据和结论。" },
    { source_block_key: "low", type: "paragraph", markdown: "另一段来源正文完整保留数字、专名、适用边界和最终结论。" }
  ];
  const mixed = rejectLowFidelityWrittenPatches({ cleaned_blocks: [
    { source_block_key: "valid", markdown: "这是一段来源正文，包含完整条件、依据，以及结论。" },
    { source_block_key: "low", markdown: "被摘要替代。" }
  ] }, blocks);
  assert.deepEqual(mixed.output.cleaned_blocks, [{ source_block_key: "valid", markdown: "这是一段来源正文，包含完整条件、依据，以及结论。" }]);
  assert.deepEqual(mixed.rejectedPatches, [{ source_block_key: "low", reason: "fidelity_too_low:low" }]);

  const allLow = rejectLowFidelityWrittenPatches({ cleaned_blocks: blocks.map((block) => ({
    source_block_key: block.source_block_key,
    markdown: "无关摘要。"
  })) }, blocks);
  assert.deepEqual(allLow.output.cleaned_blocks, []);
  assert.equal(allLow.rejectedPatches.length, 2);

  const protectedBlocks = [
    { source_block_key: "table", type: "table", markdown: "| A | B |\n| --- | --- |\n| 原值 | 1 |" },
    { source_block_key: "code", type: "code", markdown: "```js\nconst value = 1;\n```" },
    { source_block_key: "anchor", type: "paragraph", markdown: "<a id=\"page-1\"></a>\n\n保留 `$x$` 与 [链接](https://example.test/a)。" }
  ];
  const protectedOutput = { cleaned_blocks: [
    { source_block_key: "table", markdown: "| A | B |\n| --- | --- |\n| 改值 | 1 |" },
    { source_block_key: "code", markdown: "```js\nconst value = 2;\n```" },
    { source_block_key: "anchor", markdown: "删除锚点、公式和链接。" }
  ] };
  const protectedFiltered = rejectLowFidelityWrittenPatches(protectedOutput, protectedBlocks);
  assert.equal(protectedFiltered.rejectedPatches.length, 1);
  assert.deepEqual(protectedFiltered.output.cleaned_blocks.map((item) => item.source_block_key), ["table", "code"]);
  const protectedFailures = validateWrittenCleaningChunk(protectedFiltered.output, protectedBlocks);
  assert.ok(protectedFailures.includes("table_block_changed:table"));
  assert.ok(protectedFailures.includes("code_block_changed:code"));
  assert.equal(protectedFailures.some((failure) => failure.endsWith(":anchor")), false);
});

test("written source_voice_structuring over 300 blocks uses bounded cleaning chunks and an independent semantic pass", async () => {
  const blocks = ["# 长篇合成材料", "## 第一节", "## 第二节", "## 第三节"];
  for (let index = 0; index < 302; index += 1) blocks.push(`第 ${index + 1} 个合成段落保留唯一编号、原始顺序和来源信息。`);
  const request = requestFor(blocks.join("\n\n"), "long-written");
  let cleaningCalls = 0;
  let semanticCalls = 0;
  let repairCalls = 0;
  const producer = {
    async generate(payload, { validationFeedback = [] } = {}) {
      const generated = await generateChunkedSourceVoice({}, payload, validationFeedback, new Map(), async (_config, prompt) => {
        if (prompt.system.includes("来源忠实清洗器")) {
          cleaningCalls += 1;
          const chunk = JSON.parse(prompt.user.split("输入 blocks：\n").at(-1));
          return {
            output: { cleaned_blocks: chunk.map((block) => ({
              source_block_key: block.source_block_key,
              markdown: block.source_block_key === payload.blocks[4].source_block_key
                ? "被摘要替代。"
                : block.source_block_key === payload.blocks[5].source_block_key
                ? `${block.markdown} 断句已核对。`
                : block.markdown
            })) },
            usage: null
          };
        }
        if (prompt.system.includes("局部修复器")) {
          repairCalls += 1;
          return {
            output: { repairs: [{
              index: 0,
              title: "有界分块保持完整",
              description: "第 1 个合成段落保留唯一编号、原始顺序和来源信息；长篇 written 材料先进行有界清洗，再由独立语义阶段生成判断与洞察，全部来源 key 仍按原顺序进入本地门禁并接受完整性验证。",
              target_block_key: payload.blocks[4].source_block_key,
              evidence_phrases: ["第 1 个合成段落"]
            }] },
            usage: null
          };
        }
        semanticCalls += 1;
        return {
          output: {
            judgments: {
              value: { level: "high", reason: "长篇合成材料可验证分块与顺序完整性。" },
              density: { level: "medium", reason: "段落结构规则且包含大量独立编号。" },
              continue_reading: { level: 3, reason: "需要全文核验段落覆盖与顺序。" }
            },
            insights: [{
              title: "有界分块保持完整",
              description: "作者指出长篇 written 材料先按块数与字符数进行有界清洗，再由独立语义阶段生成判断与洞察，因此清洗 JSON 不会随全文块数线性膨胀并截断，全部来源 key 仍按原顺序进入本地门禁。",
              target_block_key: payload.blocks[4].source_block_key
            }],
            translation: { is_bilingual: false, alignments: [] }
          },
          usage: null
        };
      });
      return { ...generated, provider: "synthetic", model: "synthetic-long-written-v1" };
    }
  };
  const result = await processMaterial(request, { producer });
  assert.equal(result.status, "completed");
  assert.equal(result.processing_state, "rendered");
  assert.equal(result.artifacts.target_zone, "local-ir-reading");
  assert.equal(result.artifacts.body_blocks.length, 306);
  assert.equal(result.artifacts.body_blocks[4].markdown, "第 1 个合成段落保留唯一编号、原始顺序和来源信息。");
  assert.match(result.artifacts.body_blocks[5].markdown, /断句已核对/u);
  assert.ok(cleaningCalls > 1);
  assert.equal(semanticCalls, 1);
  assert.equal(repairCalls, 0);
  assert.equal(result.receipt.model.attempts[0].status, "accepted");
  assert.equal(result.receipt.model.attempts[0].usage.stages.rejected_patch_count, 1);
  assert.deepEqual(result.receipt.model.attempts[0].usage.stages.rejected_patches, [{
    source_block_key: result.artifacts.body_blocks[4].source_block_key,
    reason: `fidelity_too_low:${result.artifacts.body_blocks[4].source_block_key}`
  }]);
  assert.equal((await validateResultContract(result)).valid, true);
});
