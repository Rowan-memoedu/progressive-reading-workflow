import assert from "node:assert/strict";
import test from "node:test";
import { insightContractRepairIndexes, repairInsightContract, repairShortInsightDescriptions } from "../lib/producer.mjs";

function semanticFixture() {
  return {
    judgments: {
      value: { level: "high", reason: "内容可直接指导学习选择。" },
      density: { level: "high", reason: "包含明确条件与结论。" },
      continue_reading: { level: 3, reason: "适合阅读全文。" }
    },
    insights: [
      {
        title: "本科阶段优先学习",
        description: "本科阶段应优先把课程与基础能力学扎实，再根据真实能力缺口决定是否读硕士。",
        target_block_key: "s0"
      },
      {
        title: "技术栈取决于任务",
        description: "多数单片机项目并不需要照搬大型互联网系统的完整技术栈；只有做 Android 或底层开发时，才需要补充更完整的操作系统与存储知识，并按目标任务选择学习深度。",
        target_block_key: "s1"
      }
    ],
    translation: { is_bilingual: false, alignments: [] }
  };
}

const cleanedSections = [
  {
    source_block_keys: ["s0"],
    markdown: "## 本科阶段的优先级\n\n本科四年应认真学习，把课程与基础能力学扎实，再根据真实能力缺口决定是否读硕士。"
  },
  {
    source_block_keys: ["s1"],
    markdown: "## 技术栈边界\n\n多数单片机项目不需要完整互联网技术栈；只有做 Android 或底层开发时，才需要补充更完整的操作系统与存储知识。"
  }
];

test("short insight repair changes only failed descriptions and accepts 60 non-whitespace characters", async () => {
  const initial = semanticFixture();
  const frozen = structuredClone(initial);
  const original = initial.insights[0].description;
  const calls = [];
  const result = await repairShortInsightDescriptions({
    config: {},
    semanticOutput: initial,
    semanticFailures: [`insight_0_description_${original.replace(/\s+/gu, "").length}_below_60`],
    cleanedSections,
    targetKeys: ["s0", "s1"],
    callModel: async (_config, prompt) => {
      calls.push(prompt);
      return {
        usage: { total_tokens: 10 },
        output: {
          repairs: [{
            index: 0,
            description: `${original}本科四年应认真学习，并以真实能力缺口作为是否继续深造的判断依据。`,
            evidence_phrases: ["本科四年应认真学习", "真实能力缺口"]
          }]
        }
      };
    }
  });

  assert.equal(calls.length, 1);
  assert.deepEqual(result.failures, []);
  assert.deepEqual(result.repairedIndexes, [0]);
  assert.ok(result.output.insights[0].description.startsWith(original));
  assert.ok(result.output.insights[0].description.replace(/\s+/gu, "").length >= 60);
  assert.deepEqual(result.output.judgments, frozen.judgments);
  assert.deepEqual(result.output.translation, frozen.translation);
  assert.deepEqual(result.output.insights[1], frozen.insights[1]);
  assert.equal(result.output.insights[0].title, frozen.insights[0].title);
  assert.equal(result.output.insights[0].target_block_key, frozen.insights[0].target_block_key);
});

test("the 60-character threshold counts punctuation and does not require a higher target", async () => {
  const original = "洞".repeat(55);
  const semantic = semanticFixture();
  semantic.insights[0].description = original;
  const sections = [{ source_block_keys: ["s0"], markdown: "正文包含真实证据，足以完成局部补全。" }];
  const exactSixty = `${original}真实证据。`;
  assert.equal(exactSixty.replace(/\s+/gu, "").length, 60);
  const result = await repairShortInsightDescriptions({
    config: {},
    semanticOutput: semantic,
    semanticFailures: ["insight_0_description_55_below_60"],
    cleanedSections: sections,
    targetKeys: ["s0", "s1"],
    callModel: async () => ({
      usage: null,
      output: { repairs: [{ index: 0, description: exactSixty, evidence_phrases: ["真实证据"] }] }
    })
  });
  assert.deepEqual(result.failures, []);
  assert.equal(result.output.insights[0].description, exactSixty);
});

test("repair retries only still-invalid indexes and seals accepted repairs", async () => {
  const initial = semanticFixture();
  initial.insights.push({
    title: "深造取决于缺口",
    description: "是否读硕士取决于本科结束时仍有哪些真实能力缺口。",
    target_block_key: "s0"
  });
  const firstOriginal = initial.insights[0].description;
  const secondOriginal = initial.insights[2].description;
  const prompts = [];
  let attempt = 0;
  const result = await repairShortInsightDescriptions({
    config: {},
    semanticOutput: initial,
    semanticFailures: [
      `insight_0_description_${firstOriginal.replace(/\s+/gu, "").length}_below_60`,
      `insight_2_description_${secondOriginal.replace(/\s+/gu, "").length}_below_60`
    ],
    cleanedSections,
    targetKeys: ["s0", "s1"],
    callModel: async (_config, prompt) => {
      prompts.push(prompt.user);
      attempt += 1;
      if (attempt === 1) {
        return {
          usage: null,
          output: {
            repairs: [
              {
                index: 0,
                description: `${firstOriginal}本科四年应认真学习，并以真实能力缺口作为是否继续深造的判断依据。`,
                evidence_phrases: ["本科四年应认真学习", "真实能力缺口"]
              },
              {
                index: 2,
                description: `${secondOriginal}预计需要补上 2035 年才出现的新课程。`,
                evidence_phrases: ["不存在的证据短语"]
              }
            ]
          }
        };
      }
      return {
        usage: null,
        output: {
          repairs: [{
            index: 2,
            description: `${secondOriginal}本科四年应认真学习，把课程与基础能力学扎实，并把真实能力缺口作为继续深造的具体判断依据。`,
            evidence_phrases: ["本科四年应认真学习", "真实能力缺口"]
          }]
        }
      };
    }
  });

  assert.equal(attempt, 2);
  assert.deepEqual(result.failures, []);
  assert.deepEqual(result.repairedIndexes, [0, 2]);
  assert.match(prompts[1], /"index": 2/u);
  assert.doesNotMatch(prompts[1], /"index": 0/u);
});

test("repair rejects changed prefixes, out-of-context evidence, new numbers or URLs, and attribution boilerplate", async () => {
  const initial = semanticFixture();
  const original = initial.insights[0].description;
  let calls = 0;
  const result = await repairShortInsightDescriptions({
    config: {},
    semanticOutput: initial,
    semanticFailures: [`insight_0_description_${original.replace(/\s+/gu, "").length}_below_60`],
    cleanedSections,
    targetKeys: ["s0", "s1"],
    callModel: async () => {
      calls += 1;
      return {
        usage: null,
        output: {
          repairs: [{
            index: 0,
            description: "作者认为原描述应被替换，并新增 2035 年的数据，详情见 https://invalid.example/。",
            evidence_phrases: ["正文中不存在的证据"]
          }]
        }
      };
    }
  });

  assert.equal(calls, 2);
  assert.equal(result.output.insights[0].description, original);
  assert.deepEqual(result.failures, []);
  assert.ok(result.repairValidationFailures.some((failure) => /original_description_not_preserved_as_prefix/u.test(failure)));
  assert.ok(result.repairValidationFailures.some((failure) => /evidence_phrase_not_in_context/u.test(failure)));
  assert.ok(result.repairValidationFailures.some((failure) => /introduced_number/u.test(failure)));
  assert.ok(result.repairValidationFailures.some((failure) => /introduced_url/u.test(failure)));
  assert.ok(result.repairValidationFailures.some((failure) => /attribution_boilerplate/u.test(failure)));
  assert.equal(initial.insights[0].description, original);
});

test("non-length semantic failures do not enter the local description repair loop", async () => {
  let calls = 0;
  const result = await repairShortInsightDescriptions({
    config: {},
    semanticOutput: semanticFixture(),
    semanticFailures: ["invalid_value_judgment"],
    cleanedSections,
    targetKeys: ["s0", "s1"],
    callModel: async () => {
      calls += 1;
      throw new Error("must not be called");
    }
  });
  assert.equal(calls, 0);
  assert.equal(result.output, null);
  assert.deepEqual(result.failures, ["invalid_value_judgment"]);
  assert.deepEqual(result.repairValidationFailures, []);
});

test("insight contract repair fixes only rejected insights with grounded targets", async () => {
  const initial = semanticFixture();
  initial.insights[0].description = `作者指出${"本科阶段应优先把课程与基础能力学扎实".repeat(3)}`;
  initial.insights[0].target_block_key = "invented-key";
  const frozen = structuredClone(initial);
  const blocks = [
    { source_block_key: "s0", markdown: "本科四年应认真学习，把课程与基础能力学扎实，再根据真实能力缺口决定是否读硕士。" },
    { source_block_key: "s1", markdown: "多数单片机项目不需要完整互联网技术栈，学习深度应由目标任务决定。" }
  ];
  let calls = 0;
  const result = await repairInsightContract({
    config: {},
    semanticOutput: initial,
    validationFailures: ["invalid_insight_target:0", "insight_contains_attribution_boilerplate:0"],
    blocks,
    callModel: async () => {
      calls += 1;
      return {
        usage: null,
        output: {
          repairs: [{
            index: 0,
            title: "本科阶段优先学习",
            description: "本科四年应认真学习，把课程与基础能力学扎实，再根据真实能力缺口决定是否读硕士；这一顺序把继续深造建立在已经识别出的能力短板上。",
            target_block_key: "s0",
            evidence_phrases: ["把课程与基础能力学扎实", "真实能力缺口"]
          }]
        }
      };
    }
  });

  assert.equal(calls, 1);
  assert.deepEqual(result.failures, []);
  assert.deepEqual(result.repairedIndexes, [0]);
  assert.equal(result.output.insights[0].target_block_key, "s0");
  assert.doesNotMatch(result.output.insights[0].description, /作者指出/u);
  assert.deepEqual(result.output.insights[1], frozen.insights[1]);
  assert.deepEqual(result.output.judgments, frozen.judgments);
  assert.deepEqual(result.output.translation, frozen.translation);
});

test("insight contract repair retries rejected evidence and seals a grounded replacement", async () => {
  const initial = semanticFixture();
  initial.insights[0].target_block_key = "bad-key";
  const blocks = [
    { source_block_key: "s0", markdown: "本科四年应认真学习，把课程与基础能力学扎实，再根据真实能力缺口决定是否读硕士。" },
    { source_block_key: "s1", markdown: "多数单片机项目不需要完整互联网技术栈，学习深度应由目标任务决定。" }
  ];
  let calls = 0;
  const result = await repairInsightContract({
    config: {},
    semanticOutput: initial,
    validationFailures: ["invalid_insight_target:0"],
    blocks,
    callModel: async () => {
      calls += 1;
      return calls === 1
        ? {
            usage: null,
            output: { repairs: [{ index: 0, title: "错误", description: "不存在的未来数据".repeat(12), target_block_key: "s0", evidence_phrases: ["正文没有这句话"] }] }
          }
        : {
            usage: null,
            output: { repairs: [{
              index: 0,
              title: "深造取决于能力缺口",
              description: "本科四年应认真学习，把课程与基础能力学扎实，再根据真实能力缺口决定是否读硕士；继续深造因此对应的是具体能力短板，而不是脱离学习结果的预设步骤。",
              target_block_key: "s0",
              evidence_phrases: ["本科四年应认真学习", "真实能力缺口"]
            }] }
          };
    }
  });

  assert.equal(calls, 2);
  assert.deepEqual(result.failures, []);
  assert.deepEqual(result.repairedIndexes, [0]);
  assert.equal(result.output.insights[0].target_block_key, "s0");
});

test("insight contract repair preserves accepted items when only short descriptions remain", async () => {
  const initial = semanticFixture();
  initial.insights[0].description = "本科四年应认真学习，把课程与基础能力学扎实，再根据真实能力缺口决定是否读硕士；这一顺序把继续深造建立在已经识别出的能力短板上。";
  initial.insights[0].target_block_key = "bad-key";
  initial.insights[1].description = "多数单片机项目不需要完整互联网技术栈。";
  const blocks = [
    { source_block_key: "s0", markdown: "本科四年应认真学习，把课程与基础能力学扎实，再根据真实能力缺口决定是否读硕士。" },
    { source_block_key: "s1", markdown: "多数单片机项目不需要完整互联网技术栈；只有做 Android 或底层开发时，才需要补充更完整的操作系统与存储知识。" }
  ];
  let calls = 0;
  const result = await repairInsightContract({
    config: {},
    semanticOutput: initial,
    validationFailures: ["invalid_insight_target:0", "insight_description_too_brief:1:20/60"],
    blocks,
    callModel: async () => {
      calls += 1;
      const repairs = [];
      if (calls === 1) {
        repairs.push({
          index: 0,
          title: "深造取决于能力缺口",
          description: "本科四年应认真学习，把课程与基础能力学扎实，再根据真实能力缺口决定是否读硕士；继续深造因此对应具体能力短板，而不是脱离学习结果的预设步骤。",
          target_block_key: "s0",
          evidence_phrases: ["把课程与基础能力学扎实", "真实能力缺口"]
        });
      }
      repairs.push({
        index: 1,
        title: "技术栈取决于任务",
        description: "多数单片机项目不需要完整互联网技术栈。",
        target_block_key: "s1",
        evidence_phrases: ["完整互联网技术栈"]
      });
      return { usage: null, output: { repairs } };
    }
  });

  assert.equal(calls, 2);
  assert.deepEqual(result.repairedIndexes, [0]);
  assert.ok(result.output);
  assert.equal(result.output.insights[0].target_block_key, "s0");
  assert.deepEqual(result.failures, []);
});

test("insight contract repair refuses mixed non-insight failures", async () => {
  let calls = 0;
  assert.equal(insightContractRepairIndexes(["invalid_insight_target:0", "invalid_value_judgment"]), null);
  const result = await repairInsightContract({
    config: {},
    semanticOutput: semanticFixture(),
    validationFailures: ["invalid_insight_target:0", "invalid_value_judgment"],
    blocks: [{ source_block_key: "s0", markdown: "正文" }],
    callModel: async () => {
      calls += 1;
      throw new Error("must not be called");
    }
  });
  assert.equal(calls, 0);
  assert.equal(result.output, null);
  assert.deepEqual(result.failures, ["invalid_insight_target:0", "invalid_value_judgment"]);
});
