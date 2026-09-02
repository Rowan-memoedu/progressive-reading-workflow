import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { processMaterial } from "../lib/core.mjs";
import { validateSplitManifestContract } from "../index.mjs";
import { normalizePandocSemanticBlocks } from "../lib/pandoc-normalizer.mjs";
import { buildSplitManifest, buildSplitRequest, parseSplitSourceBlocks } from "../lib/splitter.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturePath = path.join(here, "..", "fixtures", "pandoc-semantic-split.request.json");

async function fixture() {
  return JSON.parse(await fs.readFile(fixturePath, "utf8"));
}

test("semantic splitter uses heading boundaries and produces an exact child request", async () => {
  const request = await fixture();
  const manifest = buildSplitManifest(request, {
    titleOverrides: {},
    filenameOverrides: {}
  });
  assert.equal(manifest.manifest_version, "progressive-reading.split-manifest/v2");
  assert.equal((await validateSplitManifestContract(manifest)).valid, true);
  assert.equal(manifest.split_policy_version, "heading-semantic-hierarchy-v2");
  assert.match(manifest.line_basis, /material\.markdown/u);
  assert.equal(manifest.source_unit_count, 3);
  assert.equal(manifest.leaf_split_count, 3);
  assert.equal(manifest.split_count, 3);
  assert.equal(manifest.reference_labels["alg-school"], "Grade-school multiplication");
  assert.equal(manifest.reference_labels["fig-multiply"], "A multiplication diagram");
  const target = manifest.splits.find((item) => item.source_title === "Integer multiplication: an example of an algorithm");
  assert.ok(target);
  assert.equal(target.split_reason, "source_heading_boundary");
  assert.equal(target.source_heading, target.source_title);
  assert.equal(target.leaf_count, 1);
  assert.equal(target.special_structures.algorithm, 2);
  assert.equal(target.special_structures.remark, 1);
  assert.equal(target.special_structures.display_math, 0);
  assert.ok(target.source_boundary.start.line < target.source_boundary.end.line);
  const child = buildSplitRequest(request, manifest, target.split_id);
  assert.match(child.material.markdown, /^## Integer multiplication:/u);
  assert.match(child.material.markdown, /Grade-school multiplication/u);
  assert.doesNotMatch(child.material.markdown, /Other semantic containers/u);
  assert.equal(child.source_metadata.split.source_boundary.start.source_block_key, target.source_boundary.start.source_block_key);
  assert.equal(child.source_metadata.split.parent_unit_id, target.parent_unit_id);
  assert.equal(child.source_metadata.split.split_reason, "source_heading_boundary");
  assert.equal(child.source_metadata.split.reference_labels["alg-school"], "Grade-school multiplication");
  assert.equal(child.processing_options.normalize_semantic_containers, true);
  const wrongManifest = structuredClone(manifest);
  wrongManifest.source_sha256 = "0".repeat(64);
  assert.throws(() => buildSplitRequest(request, wrongManifest, target.split_id), /split_manifest_source_hash_mismatch/u);
});

test("hierarchical manifest keeps source units distinct from semantic leaves", async () => {
  const filler = "A paragraph explains the mathematical idea and its consequences in enough detail to make this source unit exceed the configured semantic splitting threshold. ".repeat(14);
  const request = {
    schema_version: "progressive-reading.preprocess.request/v1",
    contract_version: "1.0.0",
    material: { markdown: `# Introduction\n\nOpening unit.\n\n## Extended Example: Faster multiplication\n\n${filler}\n\n\`\`\` {.algorithm title="Karatsuba multiplication"}\nINPUT: $x,y$\nOUTPUT: $x\\cdot y$\nreturn $x\\cdot y$\n\`\`\`\n\n${filler}\n\n> ### {.lemma #efficient}\nThe algorithm is efficient.\n\n${filler}\n\n::: {.remark title="Matrix Multiplication (advanced note)"}\nThe same idea extends to matrices.\n:::` },
    source_type: "synthetic_math_lecture",
    source_metadata: { source_url: "https://example.invalid/hierarchy", source_is_original: true, content_profile: "math_lecture" },
    user_instruction: "Build only the split manifest.",
    processing_options: { cleaning_mode: "source_translation", translation_target_language: "zh-CN" }
  };
  const manifest = buildSplitManifest(request, { maxChars: 900, maxLines: 200 });
  assert.equal((await validateSplitManifestContract(manifest)).valid, true);
  assert.equal(manifest.source_unit_count, 2);
  assert.equal(manifest.leaf_split_count, 5);
  const parent = manifest.units.find((unit) => unit.source_heading === "Extended Example: Faster multiplication");
  assert.ok(parent);
  assert.equal(parent.leaf_count, 4);
  assert.equal(parent.split_reason, "long_source_unit_semantic_split");
  const leaves = manifest.splits.filter((split) => split.parent_unit_id === parent.unit_id);
  assert.deepEqual(leaves.map((split) => split.source_title), Array(4).fill("Extended Example: Faster multiplication"));
  assert.deepEqual(leaves.map((split) => split.semantic_role), ["principles", "algorithm_correctness", "efficiency_progress", "topic_extension"]);
  assert.deepEqual(leaves.map((split) => split.split_reason), Array(4).fill("long_source_unit_semantic_split"));
  assert.match(leaves[2].title, /效率分析及后续进展/u);
  assert.match(leaves[3].title, /矩阵乘法扩展/u);
});

test("Pandoc semantic containers become readable Markdown while true code and protected syntax survive", async () => {
  const request = await fixture();
  const blocks = parseSplitSourceBlocks(request.material.markdown);
  const normalized = normalizePandocSemanticBlocks(blocks);
  const markdown = normalized.blocks.map((block) => block.markdown).join("\n\n");
  assert.equal(normalized.counts.algorithm, 2);
  assert.equal(normalized.counts.exercise, 1);
  assert.equal(normalized.counts.proof, 1);
  assert.equal(normalized.counts.remark, 1);
  assert.equal(normalized.counts.objectives, 1);
  assert.equal(normalized.counts.true_code_fence, 1);
  assert.match(markdown, /### Algorithm: Multiplication via repeated addition/u);
  assert.match(markdown, /\*\*Input:\*\* integers \$x,y\$/u);
  assert.match(markdown, /#### Steps/u);
  assert.match(markdown, /## Exercise 1: Trace the algorithm/u);
  assert.match(markdown, /### Proof/u);
  assert.match(markdown, /### Remark: Specification, implementation, and analysis of algorithms\./u);
  assert.match(markdown, /### Learning objectives/u);
  assert.match(markdown, /```python\ndef multiply\(x, y\):\n    return x \* y\n```/u);
  assert.match(markdown, /\$x\\cdot y\$/u);
  assert.match(markdown, /\[@synthetic2026\]/u);
  assert.match(markdown, /https:\/\/example\.invalid\/source/u);
  assert.doesNotMatch(markdown, /\.algorithm|:::\s*\{|\{#(?:chap|fig|proof|goals|ex)|data-ref=|title=/u);
});

test("processed split keeps every insight target and jump inside the same reading file", async () => {
  const parent = await fixture();
  const manifest = buildSplitManifest(parent);
  const target = manifest.splits.find((item) => item.source_title === "Integer multiplication: an example of an algorithm");
  const request = buildSplitRequest(parent, manifest, target.split_id);
  const producer = {
    async generate(payload) {
      const targetBlock = payload.blocks.find((block) => /Algorithm: Multiplication via repeated addition/u.test(block.markdown));
      return {
        provider: "synthetic",
        model: "semantic-container-v1",
        usage: null,
        output: {
          judgments: {
            value: { level: "high", reason: "同时展示算法规范、实现步骤与资源分析。" },
            density: { level: "high", reason: "两个算法和说明块集中呈现关键方法。" },
            continue_reading: { level: 4, reason: "适合选择性全文阅读并核对算法步骤。" }
          },
          insights: [{
            title: "算法由任务、步骤与分析共同构成",
            description: "整数乘法示例把输入输出规范、可执行步骤与资源消耗区分开来：重复加法给出直观基线，竖式乘法借助位值结构减少工作量，说明算法评价不能只看结果是否正确。",
            target_block_key: targetBlock.source_block_key
          }],
          translation: { is_bilingual: false, alignments: [] }
        }
      };
    }
  };
  const result = await processMaterial(request, { producer });
  assert.equal(result.status, "completed");
  assert.equal(result.processing_state, "rendered");
  assert.equal(result.errors.length, 0);
  assert.equal(result.artifacts.cleaning_manifest.source_nodes.length, result.artifacts.cleaning_manifest.mappings.length);
  for (const insight of result.artifacts.semantic.insights) {
    const body = result.artifacts.body_blocks.find((block) => block.source_block_keys.includes(insight.target_block_key));
    assert.ok(body);
    assert.match(result.artifacts.reading_markdown, new RegExp(`\\[\\[#\\^${body.block_id}\\|正文跳转\\]\\]`));
  }
  assert.doesNotMatch(result.artifacts.reading_markdown, /\.algorithm|:::\s*\{|data-ref=|title=/u);
});

test("split metadata title wins when a continuation starts with a level-three semantic heading", async () => {
  const request = {
    schema_version: "progressive-reading.preprocess.request/v1",
    contract_version: "1.0.0",
    material: { markdown: "``` {.algorithm title=\"Continuation algorithm\"}\nINPUT: $x$\nOUTPUT: $x$\nreturn $x$\n```" },
    source_type: "synthetic_split_continuation",
    source_metadata: {
      title: "扩展示例：续篇算法与正确性",
      source_url: "https://example.invalid/continuation",
      source_is_original: true,
      content_profile: "math_lecture",
      split: { split_id: "split-continuation" }
    },
    user_instruction: "保持分篇标题。",
    processing_options: { cleaning_mode: "semantic_only", normalize_semantic_containers: true, insight_soft_min: 1 }
  };
  const producer = {
    async generate(payload) {
      return { provider: "synthetic", model: "title-test", usage: null, output: {
        judgments: {
          value: { level: "medium", reason: "验证续分片标题。" },
          density: { level: "medium", reason: "验证续分片标题。" },
          continue_reading: { level: 2, reason: "适合概览。" }
        },
        insights: [{ title: "续篇标题保持稳定", description: "长章节按语义继续拆分后，即使正文从三级算法或引理标题开始，阅读文件仍应采用清单中定义的分篇标题，避免把局部结构误当成整篇名称。", target_block_key: payload.blocks[0].source_block_key }],
        translation: { is_bilingual: false, alignments: [] }
      }};
    }
  };
  const result = await processMaterial(request, { producer });
  assert.match(result.artifacts.reading_markdown, /^---[\s\S]*?\n# 扩展示例：续篇算法与正确性\n/mu);
  assert.doesNotMatch(result.artifacts.reading_markdown, /\n# Algorithm/u);
});

test("visible Pandoc syntax reintroduced by a producer is rejected and cannot complete", async () => {
  const request = await fixture();
  request.material.markdown = "## Clean heading\n\nReadable source paragraph.";
  request.processing_options.cleaning_mode = "source_voice_structuring";
  const producer = {
    calls: 0,
    async generate(payload) {
      this.calls += 1;
      return { provider: "synthetic", model: "bad-pandoc", usage: null, output: {
        cleaned_blocks: payload.blocks.map((block) => ({ source_block_key: block.source_block_key, markdown: `${block.markdown}\n\n::: {.remark title=\"leaked\"}` })),
        judgments: {
          value: { level: "medium", reason: "验证语法审计。" },
          density: { level: "medium", reason: "验证语法审计。" },
          continue_reading: { level: 2, reason: "验证语法审计。" }
        },
        insights: [{ title: "可见排版语法必须失败", description: "确定性规范化完成后，模型若重新引入 Pandoc 容器或排版属性，处理器必须拒绝该次输出并进入重试，不能把受污染正文标记为可进入阅读区的完成产物。", target_block_key: payload.blocks.at(-1).source_block_key }],
        translation: { is_bilingual: false, alignments: [] }
      }};
    }
  };
  const result = await processMaterial(request, { producer });
  assert.equal(producer.calls, 3);
  assert.equal(result.processing_state, "degraded");
  assert.notEqual(result.status, "completed");
  assert.ok(result.receipt.model.attempts.every((attempt) => attempt.validation_errors.some((error) => error.includes("visible_pandoc_syntax"))));
});

test("splitter accepts the request-v1 root input form", async () => {
  const request = await fixture();
  const inputRequest = { ...request, input: request.material.markdown };
  delete inputRequest.material;
  const manifest = buildSplitManifest(inputRequest);
  assert.equal(manifest.split_count, 3);
  const child = buildSplitRequest(inputRequest, manifest, manifest.splits[1].split_id);
  assert.match(child.material.markdown, /^## Integer multiplication:/u);
});
