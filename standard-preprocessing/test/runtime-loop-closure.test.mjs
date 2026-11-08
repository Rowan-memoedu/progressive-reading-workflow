import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import { processMaterial, sha256 } from "../lib/core.mjs";
import { ExternalProducer, protectTranslationMarkdown, restoreTranslationMarkdown } from "../lib/producer.mjs";
import { loadTranslationPolicy } from "../lib/translation-policy.mjs";
import { spokenQualityFromReceipt } from '../lib/spoken-quality.mjs';

const producerConfig = {
  AI_PRODUCER_BASE_URL: "https://producer.invalid/v1",
  DEEPSEEK_READING_API_KEY: "synthetic-test-key",
  AI_PRODUCER_MODEL: "synthetic-model",
  AI_PRODUCER_TIMEOUT_MS: 10000
};

test('real spoken-stage cache preserves review proof and rebuilds legacy proofless records', async () => {
  const originalFetch = globalThis.fetch;
  const source = '我们计划比较两个独立样本。如果偏差超过百分之三，就停止采样。设备必须经过校准，测量顺序也必须记录。';
  const sourceKey = `src-0001-${sha256(source).slice(0,8)}`;
  let calls = 0;
  const cacheDir = `D:/Quarantine/ProgressiveReading-tests/spoken-proof-${process.pid}-${Date.now()}`;
  const producer = new ExternalProducer(producerConfig);
  globalThis.fetch = async (_url, options) => {
    calls += 1;
    const input = JSON.parse(options.body);
    return jsonResponse(input.messages[0].content.includes('verdict')
      ? {verdict:'pass',issues:[]}
      : {cleaned_sections:[{source_block_keys:[sourceKey],markdown:`## 样本测量\n\n- 我们计划比较两个独立样本。\n  - 如果偏差超过百分之三，就停止采样。\n  - 设备必须经过校准，测量顺序也必须记录。`,reason:'整理条件。'}]});
  };
  try {
    const request={schema_version:'progressive-reading.preprocess.request/v1',contract_version:'1.0.0',
      material:{markdown:source},source_type:'synthetic_transcript',source_metadata:{title:'Independent cache proof',source_is_original:true},
      user_instruction:'',processing_options:{cleaning_mode:'lossless_spoken_to_written',include_reading_guide:false}};
    const first=await processMaterial(request,{producer,cacheDir});
    assert.ok(spokenQualityFromReceipt(first.receipt)?.chunks.length,JSON.stringify(first.errors));
    const replay=await processMaterial(request,{producer,cacheDir});
    assert.equal(replay.status,'idempotent_replay');assert.equal(calls,2);
    assert.deepEqual(spokenQualityFromReceipt(replay.receipt),spokenQualityFromReceipt(first.receipt));
    const legacy=structuredClone(replay);
    legacy.receipt.validations=legacy.receipt.validations.filter(item=>item.name!=='spoken_quality_review');
    await fs.writeFile(`${cacheDir}/${first.idempotency_key}.json`,JSON.stringify(legacy));
    const rebuilt=await processMaterial(request,{producer,cacheDir});
    assert.notEqual(rebuilt.status,'idempotent_replay');
    assert.ok(spokenQualityFromReceipt(rebuilt.receipt)?.chunks.length);
  } finally { globalThis.fetch=originalFetch; }
});

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

test("translated prose with retained English passes the producer without retry", async () => {
  const previousFetch = globalThis.fetch;
  let calls = 0;
  const mixed = "中文译文保留示例：" + "ordinary retained English expression ".repeat(15);
  globalThis.fetch = async () => {
    calls += 1;
    return jsonResponse({ translations: [{ source_block_key: "prose", markdown: mixed }] });
  };
  try {
    const result = await new ExternalProducer(producerConfig).generate({
      cleaning_policy: { mode: "source_translation", translation_target_language: "zh-CN", include_reading_guide: false },
      processing_profile: { id: "natural_language" },
      blocks: [{ source_block_key: "prose", type: "paragraph", markdown: "This paragraph contains an extended quotation that the translation may retain in English." }],
      user_instruction: "允许保留英文表达。"
    });
    assert.equal(calls, 1);
    assert.equal(result.output.cleaned_blocks[0].markdown, mixed);
  } finally { globalThis.fetch = previousFetch; }
});

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

test("ExternalProducer retries malformed JSON without weakening output validation", async () => {
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    if (fetchCalls === 1) {
      return {
        ok: true,
        async json() {
          return { choices: [{ message: { content: '{"judgments":[' } }], usage: null };
        }
      };
    }
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
    const producer = new ExternalProducer({ ...producerConfig, AI_PRODUCER_MAX_RETRIES: 2 });
    const result = await producer.generate({
      cleaning_policy: { mode: "semantic_only" },
      insight_policy: { soft_target: { min: 0, max: 1 }, safety_cap: 1 },
      blocks: [],
      source_metadata: {},
      user_instruction: ""
    });
    assert.equal(fetchCalls, 2);
    assert.equal(result.api_calls, 2);
    assert.equal(result.call_ledger.length, 2);
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

test("ExternalProducer source translation keeps GFM tables out and protects display math", async () => {
  const originalFetch = globalThis.fetch;
  const seenBodies = [];
  let fetchCalls = 0;
  globalThis.fetch = async (_url, options) => {
    const requestBody = JSON.parse(options.body);
    seenBodies.push(requestBody);
    fetchCalls += 1;
    if (fetchCalls === 1) {
      return jsonResponse({
        translations: [
          { source_block_key: "heading", markdown: "ZXQPRP0000QXZ数据表" },
          { source_block_key: "formula", markdown: "ZXQPRP0001QXZ" },
          { source_block_key: "terms-heading", markdown: "ZXQPRP0002QXZ附录——术语" }
        ]
      });
    }
    return jsonResponse({
      judgments: {
        value: { level: "medium", reason: "验证表格原样保护。" },
        density: { level: "low", reason: "材料只包含一个小表格。" },
        continue_reading: { level: 1, reason: "适合直接查看表格。" }
      },
      insights: [],
      translation: { is_bilingual: false, alignments: [] }
    });
  };
  try {
    const producer = new ExternalProducer(producerConfig);
    const table = "| Name | Count |\n| --- | ---: |\n| Alpha | 2 |";
    const formula = "$$\n\\text { int } a = 6; \\quad \\text { int } b = + + a;\n$$";
    const result = await producer.generate({
      cleaning_policy: { mode: "source_translation", translation_target_language: "zh-CN" },
      processing_profile: { id: "natural_language" },
      insight_policy: { soft_target: { min: 0, max: 1 }, safety_cap: 1 },
      blocks: [
        { source_block_key: "heading", type: "heading", markdown: "# Data table" },
        { source_block_key: "formula", type: "paragraph", markdown: formula },
        { source_block_key: "table", type: "table", markdown: table },
        { source_block_key: "terms-heading", type: "heading", markdown: "## Appendix – Terms" },
        { source_block_key: "terms", type: "list", markdown: "- Standard input/output 标准输入输出 Assignment operator 赋值运算符" }
      ],
      source_metadata: {},
      user_instruction: "完整翻译为简体中文。"
    });
    assert.equal(fetchCalls, 2);
    assert.equal(seenBodies[0].thinking.type, "disabled");
    assert.match(seenBodies[0].messages[0].content, /WORKFLOW OUTPUT ADAPTER/u);
    assert.ok(seenBodies[0].messages[0].content.includes((await loadTranslationPolicy()).text));
    assert.match(seenBodies[0].messages[1].content, /Read-only complete document prose context/u);
    assert.doesNotMatch(seenBodies[0].messages[1].content, /"table"/u);
    assert.doesNotMatch(seenBodies[0].messages[1].content, /"terms"/u);
    assert.doesNotMatch(seenBodies[0].messages[1].content, /int \} a/u);
    assert.equal(result.output.cleaned_blocks[1].markdown, formula);
    assert.equal(result.output.cleaned_blocks[2].markdown, table);
    assert.equal(result.output.cleaned_blocks[4].markdown, "- Standard input/output 标准输入输出 Assignment operator 赋值运算符");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("ExternalProducer falls back to anchored per-block translation after three protected-order-only batch failures", async () => {
  const originalFetch = globalThis.fetch;
  const seenBodies = [];
  let fetchCalls = 0;
  let batchCalls = 0;
  globalThis.fetch = async (_url, options) => {
    const requestBody = JSON.parse(options.body);
    seenBodies.push(requestBody);
    fetchCalls += 1;
    const system = requestBody.messages[0].content;
    if (/普通自然语言 Markdown 的来源保真翻译器/u.test(system)) {
      batchCalls += 1;
      return jsonResponse({
        translations: [
          {
            source_block_key: "multi",
            markdown: "使用 ZXQPRP0000QXZ 阅读[工具]ZXQPRP0002QXZ，再计算 ZXQPRP0001QXZ。"
          },
          { source_block_key: "single", markdown: "继续前先阅读 ZXQPRP0003QXZ。" }
        ]
      });
    }
    if (/普通自然语言 Markdown 的锚定片段翻译器/u.test(system)) {
      return jsonResponse({
        source_block_key: "multi",
        translated_segments: ["使用[工具](", ")运行", "，然后计算", "。"]
      });
    }
    if (/普通自然语言 Markdown 的来源保真单块翻译器/u.test(system)) {
      return jsonResponse({
        translations: [{ source_block_key: "single", markdown: "继续前先阅读 ZXQPRP0003QXZ。" }]
      });
    }
    return jsonResponse({
      judgments: {
        value: { level: "medium", reason: "验证保护语法的确定性恢复。" },
        density: { level: "medium", reason: "示例包含链接、代码与公式。" },
        continue_reading: { level: 2, reason: "适合核对翻译保真。" }
      },
      insights: [],
      translation: { is_bilingual: false, alignments: [] }
    });
  };
  try {
    const producer = new ExternalProducer(producerConfig);
    const multi = "Use [the tool](https://example.invalid/tool) with `grep -n` before evaluating $x+1$.";
    const single = "Read `man ls` before continuing.";
    const protectedMulti = protectTranslationMarkdown(multi, { includeMath: true });
    const reordered = protectedMulti.protectedMarkdown
      .replace("ZXQPRP0002QXZ", "ZXQPRPSWAPQXZ")
      .replace("ZXQPRP0000QXZ", "ZXQPRP0002QXZ")
      .replace("ZXQPRPSWAPQXZ", "ZXQPRP0000QXZ");
    assert.throws(
      () => restoreTranslationMarkdown(reordered, protectedMulti.values),
      /translation_protected_token_order:expected=.*:actual=/u
    );

    const result = await producer.generate({
      cleaning_policy: { mode: "source_translation", translation_target_language: "zh-CN" },
      processing_profile: { id: "natural_language" },
      insight_policy: { soft_target: { min: 0, max: 1 }, safety_cap: 1 },
      blocks: [
        { source_block_key: "multi", type: "paragraph", markdown: multi },
        { source_block_key: "single", type: "paragraph", markdown: single }
      ],
      source_metadata: {},
      user_instruction: "完整翻译为简体中文，保护语法逐字保留。"
    });

    assert.equal(fetchCalls, 5);
    assert.equal(batchCalls, 3);
    assert.equal(result.api_calls, 5);
    assert.equal(result.call_ledger.length, 5);
    assert.equal(result.usage.stages.translation_calls, 4);
    assert.match(seenBodies[3].messages[0].content, /锚定片段翻译器/u);
    assert.ok(seenBodies.every(body => !/来源保真单块翻译器/u.test(body.messages[0].content)));
    assert.equal(
      result.output.cleaned_blocks[0].markdown,
      "使用[工具](https://example.invalid/tool)运行`grep -n`，然后计算$x+1$。"
    );
    assert.equal(result.output.cleaned_blocks[1].markdown, "继续前先阅读 `man ls`。" );
    assert.match(result.output.cleaned_blocks[0].markdown, /\(https:\/\/example\.invalid\/tool\).*`grep -n`.*\$x\+1\$/u);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("ExternalProducer falls back to anchored per-block translation after three marker-only batch failures", async () => {
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  let batchCalls = 0;
  globalThis.fetch = async (_url, options) => {
    const requestBody = JSON.parse(options.body);
    fetchCalls += 1;
    const system = requestBody.messages[0].content;
    if (/普通自然语言 Markdown 的来源保真翻译器/u.test(system)) {
      batchCalls += 1;
      return jsonResponse({
        translations: [{
          source_block_key: "redirects",
          markdown: "- 重定向 ZXQPRP0000QXZ、ZXQPRP0001QXZ、ZXQPRP0002QXZ 和 ZXQPRP0003QXZ。"
        }]
      });
    }
    if (/普通自然语言 Markdown 的锚定片段翻译器/u.test(system)) {
      return jsonResponse({
        source_block_key: "redirects",
        translated_segments: ["重定向 ", "、", "、", " 和 ", " 会控制程序的输入与输出。"]
      });
    }
    return jsonResponse({
      judgments: {
        value: { level: "medium", reason: "验证 Markdown 标记保持不变。" },
        density: { level: "medium", reason: "示例包含四个重定向操作符。" },
        continue_reading: { level: 2, reason: "适合核对翻译保真。" }
      },
      insights: [],
      translation: { is_bilingual: false, alignments: [] }
    });
  };
  try {
    const producer = new ExternalProducer(producerConfig);
    const result = await producer.generate({
      cleaning_policy: { mode: "source_translation", translation_target_language: "zh-CN" },
      processing_profile: { id: "natural_language" },
      insight_policy: { soft_target: { min: 0, max: 1 }, safety_cap: 1 },
      blocks: [{
        source_block_key: "redirects",
        type: "paragraph",
        markdown: "First, redirects: `>file`, `file`, `>>file`, and `<file` control program input and output."
      }],
      source_metadata: {},
      user_instruction: "完整翻译为简体中文，Markdown 标记保持不变。"
    });

    assert.equal(fetchCalls, 5);
    assert.equal(batchCalls, 3);
    assert.equal(result.api_calls, 5);
    assert.equal(result.usage.stages.translation_calls, 4);
    assert.equal(
      result.output.cleaned_blocks[0].markdown,
      "重定向 `>file`、`file`、`>>file` 和 `<file` 会控制程序的输入与输出。"
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("ExternalProducer keeps short descriptions after structural repair", async () => {
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
    assert.equal(fetchCalls, 2);
    assert.equal(result.api_calls, 2);
    assert.deepEqual(result.failures, []);
    assert.deepEqual(result.repairedIndexes, [0]);
    assert.doesNotMatch(result.output.insights[0].description, /作者指出/u);
    assert.ok(result.output.insights[1].description.startsWith(secondDescription));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a short generated guide completes without insight repair calls", async () => {
  const originalFetch = globalThis.fetch;
  const source = "本科阶段应认真完成课程训练，并通过真实项目检验能力；如果已经具备解决实际问题的能力，就不应只为学历而盲目读研。".repeat(2);
  const sourceKey = `src-0001-${sha256(source).slice(0, 8)}`;
  const responses = [
    {
      cleaned_sections: [{
        source_block_keys: [sourceKey],
        markdown: `## 本科阶段的能力建设\n\n- ${source}`,
        reason: "将口述片段整理为书面段落"
      }]
    },
    { verdict: 'pass', issues: [] },
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

    assert.equal(fetchCalls, 3, JSON.stringify({error: observedError?.message, errors: result.errors, attempts:result.receipt.model.attempts}));
    assert.equal(producer.calls, 1);
    assert.equal(observedError, null);
    assert.equal(result.receipt.model.calls, 3);
    assert.equal(result.receipt.model.attempts.length, 1);
    assert.equal(result.processing_state, "rendered");
    assert.equal(result.artifacts.target_zone, "local-ir-reading");
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
