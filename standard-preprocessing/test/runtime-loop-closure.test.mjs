import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import { processMaterial, sha256 } from "../lib/core.mjs";
import { ExternalProducer } from "../lib/producer.mjs";

const producerConfig = {
  AI_PRODUCER_BASE_URL: "https://producer.invalid/v1",
  AI_PRODUCER_API_KEY: "synthetic-test-key",
  AI_PRODUCER_MODEL: "synthetic-model",
  AI_PRODUCER_TIMEOUT_MS: 10000
};

function jsonResponse(output) {
  return {
    ok: true,
    async json() {
      return {
        choices: [{ message: { content: JSON.stringify(output) } }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
      };
    }
  };
}

test("ExternalProducer success reports the actual pre-fetch call ledger length", async () => {
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    return jsonResponse({
      judgments: {
        value: { level: "medium", reason: "synthetic" },
        density: { level: "medium", reason: "synthetic" },
        continue_reading: { level: 2, reason: "synthetic" }
      },
      insights: [],
      translation: { is_bilingual: false, alignments: [] }
    });
  };
  try {
    const producer = new ExternalProducer(producerConfig);
    const result = await producer.generate({
      cleaning_policy: { mode: "semantic_only" },
      insight_policy: { soft_target: { min: 0, max: 1 }, safety_cap: 1 },
      blocks: [],
      source_metadata: {},
      user_instruction: ""
    });
    assert.equal(fetchCalls, 1);
    assert.equal(result.api_calls, 1);
    assert.equal(result.call_ledger.length, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("ExternalProducer workflow router calls the API with the versioned concise prompt", async () => {
  const originalFetch = globalThis.fetch;
  let requestBody = null;
  globalThis.fetch = async (_url, options) => {
    requestBody = JSON.parse(options.body);
    return jsonResponse({
      input_form: "written",
      content_profile: "natural_language",
      source_language: "bilingual",
      confidence: 0.94,
      reason: "正文包含完整中文与英文对应版本。"
    });
  };
  try {
    const producer = new ExternalProducer(producerConfig);
    const result = await producer.classifyWorkflow({ markdown: "中文正文。\n\nEnglish body.", fixed_labels: {} });
    assert.equal(result.output.source_language, "bilingual");
    assert.equal(result.api_calls, 1);
    assert.equal(result.attempts[0].status, "accepted");
    assert.match(requestBody.messages[0].content, /只分类，不翻译/u);
    assert.match(requestBody.messages[0].content, /bilingual 不需要再翻译/u);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("ExternalProducer follows mixed contract repair with short-description completion", async () => {
  const originalFetch = globalThis.fetch;
  const firstDescription = "作者指出本科四年应认真学习，把课程与基础能力学扎实，再根据真实能力缺口决定是否读硕士；这一顺序把继续深造建立在已经识别出的能力短板上。";
  const secondDescription = "多数单片机项目不需要完整互联网技术栈。";
  const blocks = [
    { source_block_key: "s0", markdown: "本科四年应认真学习，把课程与基础能力学扎实，再根据真实能力缺口决定是否读硕士。" },
    { source_block_key: "s1", markdown: "多数单片机项目不需要完整互联网技术栈；只有做 Android 或底层开发时，才需要补充更完整的操作系统与存储知识，并按目标任务决定学习深度。" }
  ];
  const responses = [
    { repairs: [
      {
        index: 0,
        title: "深造取决于能力缺口",
        description: "本科四年应认真学习，把课程与基础能力学扎实，再根据真实能力缺口决定是否读硕士；继续深造因此对应具体能力短板，而不是脱离学习结果的预设步骤。",
        target_block_key: "s0",
        evidence_phrases: ["把课程与基础能力学扎实", "真实能力缺口"]
      },
      {
        index: 1,
        title: "技术栈取决于任务",
        description: secondDescription,
        target_block_key: "s1",
        evidence_phrases: ["完整互联网技术栈"]
      }
    ] },
    { repairs: [{
      index: 1,
      title: "技术栈取决于任务",
      description: secondDescription,
      target_block_key: "s1",
      evidence_phrases: ["完整互联网技术栈"]
    }] },
    { repairs: [{
      index: 1,
      description: `${secondDescription}只有做 Android 或底层开发时，才需要补充更完整的操作系统与存储知识，并按目标任务决定学习深度。`,
      evidence_phrases: ["只有做 Android 或底层开发时", "按目标任务决定学习深度"]
    }] }
  ];
  let fetchCalls = 0;
  globalThis.fetch = async () => jsonResponse(responses[fetchCalls++]);
  try {
    const producer = new ExternalProducer(producerConfig);
    const result = await producer.repairInsights({
      payload: {
        blocks,
        insight_policy: { safety_cap: 4 }
      },
      semanticOutput: {
        cleaned_blocks: blocks,
        judgments: {
          value: { level: "high", reason: "包含明确建议。" },
          density: { level: "high", reason: "信息集中。" },
          continue_reading: { level: 3, reason: "适合阅读全文。" }
        },
        insights: [
          { title: "本科阶段优先学习", description: firstDescription, target_block_key: "s0" },
          { title: "技术栈取决于任务", description: secondDescription, target_block_key: "s1" }
        ],
        translation: { is_bilingual: false, alignments: [] }
      },
      validationFailures: ["insight_contains_attribution_boilerplate:0", "insight_description_too_brief:1:20/60"]
    });
    assert.equal(fetchCalls, 3);
    assert.equal(result.api_calls, 3);
    assert.deepEqual(result.failures, []);
    assert.deepEqual(result.repairedIndexes, [0, 1]);
    assert.doesNotMatch(result.output.insights[0].description, /作者指出/u);
    assert.ok(result.output.insights[1].description.startsWith(secondDescription));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("exhausted insight repair is terminal, counted exactly, and routed to preprocess-review", async () => {
  const originalFetch = globalThis.fetch;
  const source = "本科阶段应认真完成课程训练，并通过真实项目检验能力；如果已经具备解决实际问题的能力，就不应只为学历而盲目读研。";
  const sourceKey = `src-0001-${sha256(source).slice(0, 8)}`;
  const responses = [
    {
      cleaned_sections: [{
        source_block_keys: [sourceKey],
        markdown: `## 本科阶段的能力建设\n\n${source}`,
        reason: "将口述片段整理为书面段落"
      }]
    },
    {
      judgments: {
        value: { level: "high", reason: "包含明确的能力建设建议" },
        density: { level: "medium", reason: "观点集中" },
        continue_reading: { level: 2, reason: "适合阅读关键结论" }
      },
      insights: [{ title: "能力优先", description: "读研不能替代本科能力建设。", target_block_key: sourceKey }],
      translation: { is_bilingual: false, alignments: [] }
    },
    { repairs: [] },
    { repairs: [] }
  ];
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    const output = responses[fetchCalls];
    fetchCalls += 1;
    if (!output) throw new Error("unexpected_extra_fetch");
    return jsonResponse(output);
  };

  let observedError = null;
  const external = new ExternalProducer(producerConfig);
  const producer = {
    calls: 0,
    async generate(...args) {
      this.calls += 1;
      try {
        return await external.generate(...args);
      } catch (error) {
        observedError = error;
        throw error;
      }
    }
  };

  try {
    const result = await processMaterial({
      schema_version: "progressive-reading.preprocess.request/v1",
      contract_version: "1.0.0",
      material: { markdown: source },
      source_type: "synthetic_transcript",
      source_metadata: { title: "Synthetic terminal repair", source_is_original: true },
      user_instruction: "生成标准阅读稿",
      processing_options: {
        cleaning_mode: "lossless_spoken_to_written",
        preserve_source_voice: true,
        forbid_visible_timestamps: true,
        require_content_headings: false,
        attribute_unverified_claims: true,
        insight_soft_min: 1,
        insight_soft_max: 3,
        insight_safety_cap: 3
      }
    }, { producer });

    assert.equal(fetchCalls, 4, "one cleaning, one semantic generation, and exactly two repairs");
    assert.equal(producer.calls, 1, "terminal semantic rejection must stop the outer production loop");
    assert.equal(observedError?.terminal, true);
    assert.equal(observedError?.api_calls, 4);
    assert.match(observedError?.message || "", /^lossless_semantic_rejected:/u);
    assert.equal(result.receipt.model.calls, 4);
    assert.equal(result.receipt.model.attempts.length, 1);
    assert.equal(result.receipt.model.attempts[0].terminal, true);
    assert.equal(result.processing_state, "degraded");
    assert.equal(result.artifacts.target_zone, "preprocess-review");
    assert.notEqual(result.artifacts.target_zone, "local-ir-reading");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("result schema reserves preprocess-review for degraded output", async () => {
  const schema = JSON.parse(await fs.readFile(new URL("../contracts/result.schema.json", import.meta.url), "utf8"));
  assert(schema.$defs.artifacts.properties.target_zone.enum.includes("preprocess-review"));
  const degradedRule = schema.allOf.find((rule) => rule.if?.properties?.processing_state?.const === "degraded");
  assert(degradedRule, "degraded conditional schema must exist");
  assert.equal(degradedRule.then.properties.artifacts.properties.target_zone.const, "preprocess-review");
});
