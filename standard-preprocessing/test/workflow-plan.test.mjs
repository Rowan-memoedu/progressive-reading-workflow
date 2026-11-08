import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildPreprocessRequest, classifyPreprocessWorkflow, runPreprocessingRequest, standardWorkflowOptions, validateResultContract } from "../index.mjs";
import { ExternalProducer } from "../lib/producer.mjs";
import { SyntheticProducer } from "../test-support/synthetic-producer.mjs";

const allOff = { spoken_to_written: false, structure_body: false, translate: false, include_reading_guide: false };
function request(options = {}, metadata = {}, markdown = "# 观察\n\n观察需要区分证据和假设，并记录判断的适用条件。") {
  return buildPreprocessRequest({ markdown, sourceType: "test_markdown", sourceMetadata: { source_url: "https://example.invalid/plan", source_is_original: true, ...metadata }, processingOptions: standardWorkflowOptions(options) });
}
function known(profile, language = "zh") { return { input_form: "written", content_profile: profile, language }; }
function stageProducer({ failGuide = false } = {}) {
  const semantic = new SyntheticProducer();
  return {
    calls: [], routing: 0, failGuide,
    async classifyWorkflow(input) { this.routing++; return semantic.classifyWorkflow(input); },
    async generate(payload) {
      this.calls.push(payload.cleaning_policy.mode);
      if (payload.cleaning_policy.mode === "source_translation") {
        assert.equal(payload.cleaning_policy.include_reading_guide, false);
        return { api_calls: 1, provider: "test", model: "translation", output: {
          cleaned_blocks: payload.blocks.map(block => ({ source_block_key: block.source_block_key, markdown: block.type === "heading" ? "# 观察" : "观察需要区分证据和假设，并记录判断的适用条件。" })),
          judgments: null, insights: [], translation: { is_bilingual: false, alignments: [] }
        } };
      }
      assert.equal(payload.cleaning_policy.mode, "semantic_only");
      if (this.failGuide) return { api_calls: 1, provider: "test", model: "guide", output: { judgments: {}, insights: [], translation: { is_bilingual: false, alignments: [] } } };
      return semantic.generate(payload);
    }
  };
}

test("explicit timestamp policy reaches translation without invalidating semantic guide defaults", async () => {
  for (const value of [false, true]) {
    const producer = stageProducer();
    const generate = producer.generate.bind(producer);
    const observed = [];
    producer.generate = async payload => {
      observed.push(payload.cleaning_policy.forbid_visible_timestamps);
      return generate(payload);
    };
    const {result} = await runPreprocessingRequest(request({forbid_visible_timestamps:value}, known("natural_language", "en"), "# Observation\n\nObservation distinguishes evidence from assumptions and records conditions."), {cacheDir:false,producer});
    assert.equal(result.status,"completed",JSON.stringify(result.errors));
    assert.deepEqual(observed,[value,false]);
  }
});

test("all explicit false choices bypass every classifier and producer without credentials", async () => {
  const producer = { classifyWorkflow() { throw Error("unexpected classification"); }, generate() { throw Error("unexpected generation"); } };
  const run = await runPreprocessingRequest(request(allOff), { cacheDir: false, producer });
  assert.equal(run.result.status, "completed");
  assert.equal(run.result.receipt.model.calls, 0);
  assert.equal(run.result.receipt.reading_guide.status, "skipped");
  assert.doesNotMatch(run.result.artifacts.reading_markdown, /阅读前置卡|核心洞察/);
  assert.equal((await validateResultContract(run.result)).valid, true);
});

test("all explicit true choices and explicit translation also bypass classification", async () => {
  const producer = { classifyWorkflow() { assert.fail("explicit choices must not ask for material type"); } };
  for (const options of [Object.fromEntries(Object.keys(allOff).map(key => [key, true])), { ...allOff, translate: true }]) {
    const route = await classifyPreprocessWorkflow(request(options), { producer });
    assert.equal(route.classifier.calls, 0);
    assert.equal(route.needs_classification, false);
    for (const [key, value] of Object.entries(options)) assert.equal(route.plan.choices[key].enabled, value);
  }
});

for (const [profile, expectedCalls] of [["natural_language", 1], ["math_lecture", 0], ["literature", 0]]) {
  test(`${profile} default guide rule has ${expectedCalls} production calls`, async () => {
    const producer = stageProducer();
    const { result } = await runPreprocessingRequest(request({}, known(profile)), { cacheDir: false, producer });
    assert.equal(result.status, "completed", JSON.stringify(result.errors));
    assert.equal(producer.routing, 0);
    assert.equal(producer.calls.length, expectedCalls);
    assert.equal(result.receipt.reading_guide.calls, expectedCalls);
    assert.equal(result.artifacts.reading_markdown.includes("## 阅读前置卡"), expectedCalls > 0);
  });
}

test("explicit true enables a literary guide and explicit false suppresses an ordinary guide", async () => {
  for (const [profile, enabled] of [["literature", true], ["natural_language", false]]) {
    const producer = stageProducer();
    const { result } = await runPreprocessingRequest(request({ include_reading_guide: enabled }, known(profile)), { cacheDir: false, producer });
    assert.equal(result.receipt.workflow_route.plan.choices.include_reading_guide.enabled, enabled);
    assert.equal(result.receipt.workflow_route.plan.choices.include_reading_guide.source, "explicit_request");
    assert.equal(producer.calls.length, Number(enabled));
  }
});

test("partial overrides classify only the input form that can still affect execution", async () => {
  let seen;
  const producer = { async classifyWorkflow(input) { seen = input; return { output: { input_form: "written", confidence: 0.9, reason: "正文为段落化书面材料。" }, provider: "test", model: "router", api_calls: 1, attempts: [], call_ledger: [] }; } };
  const route = await classifyPreprocessWorkflow(request({ translate: false, include_reading_guide: false }), { producer });
  assert.deepEqual(seen.required_labels, ["input_form"]);
  assert.equal(route.content_profile.value, "not_needed");
  assert.equal(route.plan.choices.translate.enabled, false);
});

test("uncertainty saves a pending result without production or publication and resumes after input", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pr-classification-"));
  const producer = { calls: 0, async classifyWorkflow() { this.calls++; return { output: { input_form: null, confidence: 0.2, reason: "片段缺少材料形态信息。" }, needs_classification: true, provider: "test", model: "router", api_calls: 1, attempts: [], call_ledger: [] }; }, generate() { throw Error("must wait"); } };
  const input = request({ translate: false, include_reading_guide: false });
  const options = { producer, outputDir: path.join(root, "audit"), publishPath: path.join(root, "reading.md"), cacheDir: path.join(root, "cache") };
  const pending = await runPreprocessingRequest(input, options);
  assert.equal(pending.result.status, "needs_classification");
  assert.deepEqual(pending.result.receipt.workflow_route.missing_labels, ["input_form"]);
  assert.equal(pending.publication, null);
  assert.equal(producer.calls, 1);
  assert.equal(await fs.stat(options.publishPath).then(() => true, () => false), false);
  input.processing_options.spoken_to_written = false;
  const resumed = await runPreprocessingRequest(input, options);
  assert.equal(resumed.result.status, "completed");
  assert.equal(resumed.publication.status, "published");
  assert.equal(producer.calls, 1);
});

test("translation is cached independently from a toggled or failing guide, including explicit request ids", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pr-stage-cache-"));
  const producer = stageProducer();
  const input = request({ include_reading_guide: false }, known("natural_language", "en"), "# Observation\n\nObservation separates evidence from assumptions and records the conditions of a judgment.");
  input.idempotency_key = "same-user-id";
  const first = await runPreprocessingRequest(input, { cacheDir: root, producer });
  assert.equal(first.result.status, "completed");
  const originalId = first.result.material_id;
  input.processing_options.include_reading_guide = true;
  producer.failGuide = true;
  const failed = await runPreprocessingRequest(input, { cacheDir: root, producer });
  assert.equal(failed.result.status, "completed_with_warnings");
  assert.equal(failed.result.receipt.reading_guide.status, "failed");
  assert.equal(failed.result.artifacts.semantic.judgments, null);
  assert.doesNotMatch(failed.result.artifacts.reading_markdown, /待人工判断|阅读前置卡/);
  assert.match(failed.result.artifacts.reading_markdown, /观察需要区分证据和假设/);
  producer.failGuide = false;
  const recovered = await runPreprocessingRequest(input, { cacheDir: root, producer });
  assert.equal(recovered.result.status, "completed");
  assert.equal(recovered.result.material_id, originalId);
  assert.equal(producer.calls.filter(mode => mode === "source_translation").length, 1);
  assert.equal(recovered.result.receipt.model.calls, 1);
  assert.match(recovered.result.artifacts.reading_markdown, /## 原文\n\n# Observation/);
  assert.deepEqual(recovered.result.artifacts.cleaning_manifest, first.result.artifacts.cleaning_manifest);
  const replay = await runPreprocessingRequest(input, { cacheDir: root, producer });
  assert.equal(replay.result.receipt.model.calls, 0);
  assert.equal(replay.result.receipt.reading_guide.calls, 0);
});

test("a disabled body stage returning guide data fails instead of hiding it", async () => {
  const input = request({ structure_body: true, include_reading_guide: false }, known("natural_language"));
  input.processing_options.workflow_mode = 'single_stage';
  input.processing_options.cleaning_mode = 'source_voice_structuring';
  const producer = { generate(payload) { return new SyntheticProducer().generate({ ...payload, cleaning_policy: { ...payload.cleaning_policy, include_reading_guide: true } }); } };
  const { result } = await runPreprocessingRequest(input, { cacheDir: false, producer });
  assert.equal(result.status, "failed");
  assert.equal(result.artifacts.reading_markdown, undefined);
  assert.equal(result.errors[0].code, "disabled_reading_guide_must_be_empty");
});

test("a bilingual literary document is preserved without asking a model for alignments", async () => {
  const { result } = await runPreprocessingRequest(request({}, known("literature", "bilingual"), "# 原文\n\nThe moon rose.\n\n# 译文\n\n月亮升起来了。"), { cacheDir: false });
  assert.equal(result.status, "completed");
  assert.equal(result.translation_state, "preserved_bilingual");
  assert.equal(result.receipt.model.calls, 0);
  assert.match(result.artifacts.reading_markdown, /The moon rose/);
  assert.match(result.artifacts.reading_markdown, /月亮升起来了/);
});

test("ExternalProducer uncertainty uses one HTTP call and never guesses through retries", async () => {
  const saved = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({ content_profile: null, confidence: 0.2, reason: "无法从片段判定类型。" }) } }] }) }; };
  try {
    const producer = new ExternalProducer({ AI_PRODUCER_BASE_URL: "https://example.invalid/v1", DEEPSEEK_READING_API_KEY: "fixture", AI_PRODUCER_MODEL: "fixture", AI_PRODUCER_TIMEOUT_MS: 1000 });
    const { result } = await runPreprocessingRequest(request({ spoken_to_written: false, translate: false }), { producer, cacheDir: false });
    assert.equal(result.status, "needs_classification");
    assert.equal(calls, 1);
  } finally { globalThis.fetch = saved; }
});

test("ExternalProducer accepts only missing labels without asking the model to repeat trusted metadata", async () => {
  const saved = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({ content_profile: "literature", source_language: "en", confidence: 0.99, reason: "小说片段。" }) } }] }) }; };
  try {
    const producer = new ExternalProducer({ AI_PRODUCER_BASE_URL: "https://example.invalid/v1", DEEPSEEK_READING_API_KEY: "fixture", AI_PRODUCER_MODEL: "fixture", AI_PRODUCER_TIMEOUT_MS: 1000 });
    const route = await classifyPreprocessWorkflow(request({}, { input_form: "written" }), { producer });
    assert.equal(calls, 1);
    assert.equal(route.needs_classification, false);
    assert.equal(route.input_form.method, "source_metadata");
    assert.equal(route.plan.choices.include_reading_guide.enabled, false);
  } finally { globalThis.fetch = saved; }
});

for (const enabled of [false, true]) {
  test(`spoken workflow stages produce ${enabled ? "one final guide" : "no guide"}`, async () => {
    const saved = globalThis.fetch;
    const calls = [];
    globalThis.fetch = async (_url, options) => {
      const messages = JSON.parse(options.body).messages;
      const system = messages[0].content;
      const user = messages[1].content;
      let output;
      if (system.includes("信息无损口语转书面清洗器")) {
        calls.push("spoken");
        const blocks = JSON.parse(user.split("输入 blocks：\n").at(-1));
        output = { cleaned_sections: blocks.map(block => ({ source_block_keys: [block.source_block_key], markdown: "## 观察与记录\n\n" + block.markdown, reason: "保留全部信息并添加导航标题。" })) };
        output.cleaned_sections[0].markdown = output.cleaned_sections[0].markdown.replace('\n\n', '\n\n- ');
      } else if (system.includes('候选结构化书面正文')) {
        calls.push('review');
        const auditInput=JSON.parse(user);
        assert.ok(auditInput.original_blocks.length);
        output={verdict:'pass',issues:[]};
      } else {
        calls.push("guide");
        assert.equal(enabled, true, "disabled workflow called a guide producer");
        const payload = JSON.parse(user.split("处理请求：\n").at(-1));
        assert.equal(payload.cleaning_policy.mode, "semantic_only");
        output = (await new SyntheticProducer().generate(payload)).output;
      }
      return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify(output) } }] }) };
    };
    try {
      const producer = new ExternalProducer({ AI_PRODUCER_BASE_URL: "https://example.invalid/v1", DEEPSEEK_READING_API_KEY: "fixture", AI_PRODUCER_MODEL: "fixture", AI_PRODUCER_TIMEOUT_MS: 1000 });
      const input = request({ include_reading_guide: enabled }, { ...known("natural_language"), input_form: "spoken_transcript" }, "我们今天先讨论如何记录观察。每次观察都要写清楚发生的时间、适用的条件和实际看到的现象，并且把已经获得的证据与还没有经过验证的假设分开记录，避免把推测当成已经确定的结论。");
      producer.refineFullText = async data => {
        calls.push('spoken');
        assert.equal(data.markdown,input.material.markdown);
        assert.equal(data.mode,'spoken_to_written');
        return new SyntheticProducer().refineFullText(data);
      };
      producer.generate = async (payload, settings) => {
        assert.equal(enabled, true);
        assert.equal(settings.requiredProvider, 'codex_exec');
        assert.equal(payload.cleaning_policy.mode, 'semantic_only');
        calls.push('guide');
        return new SyntheticProducer().generate(payload);
      };
      const { result } = await runPreprocessingRequest(input, { producer, cacheDir: false });
      assert.equal(result.status, "completed", JSON.stringify(result.errors));
      assert.deepEqual(calls, enabled ? ["spoken", "guide"] : ["spoken"]);
      assert.equal(result.receipt.reading_guide.calls, Number(enabled));
      assert.equal(result.artifacts.reading_markdown.includes("## 阅读前置卡"), enabled);
      for (const insight of result.artifacts.semantic.insights) assert.ok(result.artifacts.body_blocks.some(block => block.source_block_key === insight.target_block_key));
    } finally { globalThis.fetch = saved; }
  });
}
