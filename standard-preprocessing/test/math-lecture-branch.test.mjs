import assert from "node:assert/strict";
import test from "node:test";
import {
  buildPreprocessRequest,
  classifyPreprocessWorkflow,
  runPreprocessingRequest,
  standardMarkdownOptions,
  standardWorkflowOptions
} from "../index.mjs";
import {
  collectMathLectureTerminologyCandidates,
  MATH_LECTURE_PROFILE_VERSION,
  MATH_LECTURE_PROMPT_VERSION,
  MATH_LECTURE_STANDARDIZATION_PROFILE_VERSION,
  normalizeMathLectureInlineMathSpacing,
  normalizeMathLectureReadingTerminology,
  sanitizeDiscoveredMathLectureTerms,
  validateMathLectureTerminology
} from "../lib/math-lecture.mjs";
import {
  buildWorkflowRouterPrompt,
  prepareMathLectureAnchoredSegments,
  protectTranslationMarkdown,
  restoreTranslationMarkdown,
  validateWorkflowRouteOutput,
  resolveWorkflowRouteContradictions,
  WORKFLOW_ROUTER_VERSION
} from "../lib/producer.mjs";

function semantic(target) {
  return {
    judgments: {
      value: { level: "high", reason: "材料给出了可复用的概念框架和清晰例证。" },
      density: { level: "medium", reason: "概念、定义与例子分布均衡。" },
      continue_reading: { level: 3, reason: "适合阅读全文并核对关键定义。" }
    },
    insights: [{
      title: "概念与表示",
      description: "材料区分对象的表示方式与作用于表示的操作规则，并用完整定义、适用条件、具体例子和推导关系说明两者如何共同构成可执行、可验证且能继续扩展的分析框架。",
      target_block_key: target
    }],
    translation: { is_bilingual: false, alignments: [] }
  };
}

function routingResult(output) {
  return {
    output: { confidence: 0.96, reason: "合成路由判断。", ...output },
    provider: "synthetic",
    model: "workflow-router-test-v1",
    usage: null,
    api_calls: 1,
    call_ledger: [{ call: 1 }],
    attempts: [{ attempt: 1, status: "accepted", validation_errors: [], usage: null }]
  };
}

test("legacy single-stage presets remain unchanged while the standard workflow is explicit", () => {
  assert.equal(standardMarkdownOptions().cleaning_mode, "source_voice_structuring");
  assert.equal(standardMarkdownOptions().normalize_semantic_containers, true);
  assert.equal(standardWorkflowOptions().workflow_mode, "standard");
  assert.equal(standardWorkflowOptions().input_form, "auto");
  assert.equal(standardWorkflowOptions().content_profile, "auto");
  assert.equal(standardWorkflowOptions().original_placement, "after_translation");
});

test("unmarked workflow routing uses the external AI classifier", async () => {
  let calls = 0;
  const producer = {
    async classifyWorkflow() {
      calls += 1;
      return routingResult({ input_form: "spoken_transcript", content_profile: "natural_language", source_language: "en" });
    }
  };
  const spoken = buildPreprocessRequest({
    markdown: "Speaker 1: Can you hear me?\n\nSpeaker 2: Yes. We can begin.",
    sourceType: "transcript",
    sourceMetadata: {},
    processingOptions: standardWorkflowOptions()
  });
  const spokenRoute = await classifyPreprocessWorkflow(spoken, { producer });
  assert.equal(spokenRoute.input_form.value, "spoken_transcript");
  assert.equal(spokenRoute.content_profile.value, "natural_language");
  assert.equal(spokenRoute.source_language.value, "en");
  assert.equal(spokenRoute.translation_required, true);
  assert.equal(spokenRoute.input_form.method, WORKFLOW_ROUTER_VERSION);
  assert.equal(spokenRoute.classifier.skipped, false);
  assert.equal(calls, 1);
});

test("complete source labels skip AI routing and bilingual input skips translation", async () => {
  const bilingual = buildPreprocessRequest({
    markdown: "# 双语材料\n\n中文段落。\n\nEnglish paragraph.",
    sourceType: "markdown",
    sourceMetadata: {
      input_form: "written",
      content_profile: "natural_language",
      language: "bilingual"
    },
    processingOptions: standardWorkflowOptions()
  });
  const producer = { async classifyWorkflow() { throw new Error("classifier_must_be_skipped"); } };
  const route = await classifyPreprocessWorkflow(bilingual, { producer });
  assert.equal(route.input_form.method, "source_metadata");
  assert.equal(route.content_profile.method, "source_metadata");
  assert.equal(route.source_language.value, "bilingual");
  assert.equal(route.translation_required, false);
  assert.equal(route.classifier.skipped, true);
});

test("router prompt is concise and validates bilingual as a no-translation class", () => {
  const prompt = buildWorkflowRouterPrompt({ markdown: "中文。\n\nEnglish.", fixed_labels: {} });
  assert.match(prompt.system, /bilingual 不需要再翻译/u);
  assert.match(prompt.system, /已段落化或正式发布的文章.*written/u);
  assert.match(prompt.system, /一般编程教程.*natural_language/u);
  assert.ok(prompt.system.length < 900);
  assert.deepEqual(validateWorkflowRouteOutput({
    input_form: "written",
    content_profile: "natural_language",
    source_language: "bilingual",
    confidence: 0.9,
    reason: "正文同时包含完整原文与译文。"
  }), []);
  assert.deepEqual(validateWorkflowRouteOutput({
    input_form: "written",
    content_profile: "natural_language",
    source_language: "bilingual",
    confidence: 0.9,
    reason: "正文夹杂英文术语，但并非完整双语版本。"
  }), ["bilingual_reason_contradiction"]);
  assert.equal(resolveWorkflowRouteContradictions({
    input_form: "written",
    content_profile: "natural_language",
    source_language: "bilingual",
    confidence: 0.9,
    reason: "正文夹杂英文术语，但并非完整双语版本。"
  }, "中文正文包含大量信息，并夹杂 API、workflow 等英文术语。", {}).source_language, "zh");
  assert.deepEqual(validateWorkflowRouteOutput({
    input_form: "written",
    content_profile: "math_lecture",
    source_language: "en",
    confidence: 0.9,
    reason: "包含算法与证明。"
  }, { content_profile: "natural_language" }), ["fixed_content_profile_changed"]);
});

test("math terminology candidates come from the material instead of a sample registry", () => {
  const blocks = [{
    source_block_key: "src-1",
    type: "paragraph",
    markdown: "An _algorithm_ operates on a _data structure_; the author calls the description \"recipe\". Alan Turing introduced TCS."
  }];
  const terms = collectMathLectureTerminologyCandidates(blocks);
  assert.ok(terms.includes("algorithm"));
  assert.ok(terms.includes("data structure"));
  assert.ok(terms.includes("recipe"));
  assert.ok(terms.includes("Alan Turing"));
  assert.ok(terms.includes("TCS"));
  assert.equal(terms.includes("grade-school multiplication"), false);
  assert.deepEqual(validateMathLectureTerminology(blocks[0].markdown, "algorithm 作用于 data structure，并保留 recipe、Alan Turing 与 TCS。", terms), []);
  assert.ok(validateMathLectureTerminology(blocks[0].markdown, "算法作用于 data structure。", terms).length >= 1);
});

test("model-discovered terminology accepts exact domain spans and rejects invented or sentence-sized values", () => {
  const blocks = [{
    source_block_key: "src-1",
    type: "paragraph",
    markdown: "An algorithm operates on a data structure. A binary search tree supports efficient lookup."
  }];
  assert.deepEqual(
    sanitizeDiscoveredMathLectureTerms(blocks, [
      "algorithm",
      "data structure",
      "binary search tree",
      "invented term",
      "An algorithm operates on a data structure. A binary search tree"
    ]),
    ["binary search tree", "data structure", "algorithm"]
  );
});

test("generic terminology spacing skips formulas and atomic code", () => {
  const normalized = normalizeMathLectureReadingTerminology({
    title: "algorithm 导论",
    semantic: {
      ...semantic("prose"),
      insights: [{ title: "data structure", description: "algorithm 与 data structure 构成完整框架，正文继续提供定义、条件、例子、边界、操作步骤和可核对结论。", target_block_key: "prose" }]
    },
    bodyBlocks: [
      { source_block_key: "prose", markdown: "中文连接algorithm与data structure。" },
      { source_block_key: "code", markdown: "```text\nalgorithm data structure\n```" }
    ],
    sourceBlocks: [
      { source_block_key: "prose", type: "paragraph", markdown: "algorithm and data structure" },
      { source_block_key: "code", type: "code", markdown: "```text\nalgorithm data structure\n```" }
    ],
    terms: ["algorithm", "data structure"]
  });
  assert.equal(normalized.title, "algorithm 导论");
  assert.equal(normalized.bodyBlocks[0].markdown, "中文连接 algorithm 与 data structure。" );
  assert.equal(normalized.bodyBlocks[1].markdown, "```text\nalgorithm data structure\n```");
});

test("formula protection and external CJK spacing remain generic", () => {
  const source = "Use _algorithm_ for $x\\cdot y$ and $n^2$.";
  const protectedValue = protectTranslationMarkdown(source, { includeMath: true, protectedTerms: ["algorithm"] });
  assert.equal(restoreTranslationMarkdown(protectedValue.protectedMarkdown, protectedValue.values), source);
  assert.equal(normalizeMathLectureInlineMathSpacing("涉及$n^2$次运算"), "涉及 $n^2$ 次运算");
  const anchored = prepareMathLectureAnchoredSegments(source, ["algorithm"]);
  assert.ok(anchored);
  assert.equal(anchored.protected_values.filter((item) => /^\$/u.test(item.value)).length, 2);
});

test("anchored translation also preserves multiple non-math code and link tokens", () => {
  const source = "Call `compile()` before `run()` and read [the guide](https://example.invalid/guide).";
  const anchored = prepareMathLectureAnchoredSegments(source);
  assert.ok(anchored);
  assert.equal(anchored.protected_values.length, 3);
  assert.equal(anchored.source_segments.length, 4);
});

test("English math workflow preserves discovered terms and appends the normalized original", async () => {
  const request = buildPreprocessRequest({
    markdown: "# Definitions\n\nAn _algorithm_ operates on a _data structure_, described here as a \"recipe\", and maps $f(x)$ to $g(x)$.\n\n$T(n)=2T(n/2)+n$",
    idempotencyKey: "workflow-math-terms",
    sourceType: "synthetic_lecture",
    sourceMetadata: { source_url: "https://example.invalid/lecture", source_is_original: true },
    userInstruction: "保留专业术语原文。",
    processingOptions: standardWorkflowOptions()
  });
  const producer = {
    async classifyWorkflow() {
      return routingResult({ input_form: "written", content_profile: "math_lecture", source_language: "en" });
    },
    async generate(payload) {
      const terms = ["algorithm", "data structure", "recipe"];
      return {
        provider: "synthetic",
        model: "workflow-v1",
        usage: null,
        output: {
          cleaned_blocks: payload.blocks.map((block) => ({
            source_block_key: block.source_block_key,
            markdown: block.type === "heading"
              ? "# 定义"
              : block.markdown.includes("algorithm")
                ? "algorithm 作用于 data structure；这里将这种说明称为 recipe，并将 $f(x)$ 映射到 $g(x)$。"
                : block.markdown
          })),
          ...semantic(payload.blocks.find((block) => block.markdown.includes("algorithm")).source_block_key),
          terminology: { policy: "preserve-source-terms/v1", terms }
        }
      };
    }
  };
  const run = await runPreprocessingRequest(request, { producer, cacheDir: false });
  const result = run.result;
  assert.equal(result.status, "completed", JSON.stringify(result.errors));
  assert.equal(result.receipt.workflow_route.content_profile.value, "math_lecture");
  assert.deepEqual(result.receipt.workflow_route.stages.map((stage) => stage.id), ["profile_translation", "profile_standardization"]);
  assert.equal(result.receipt.processing_profile.version, MATH_LECTURE_PROFILE_VERSION);
  assert.equal(result.receipt.processing_profile.prompt_version, MATH_LECTURE_PROMPT_VERSION);
  assert.deepEqual(result.artifacts.cleaning_manifest.protected_terms, ["algorithm", "data structure", "recipe"]);
  assert.match(result.artifacts.reading_markdown, /algorithm 作用于 data structure/u);
  assert.match(result.artifacts.reading_markdown, /## 原文\n\n# Definitions/u);
  assert.ok(result.artifacts.reading_markdown.indexOf("## 原文") > result.artifacts.reading_markdown.indexOf("## 正文"));
  assert.equal(result.receipt.validations.find((item) => item.name === "translation_original_appended")?.status, "passed");
});

test("English natural-language workflow appends the normalized original without math routing", async () => {
  const request = buildPreprocessRequest({
    markdown: "# A practical note\n\nCareful observation improves judgment because it separates evidence from assumption.",
    idempotencyKey: "workflow-natural-original-after-translation",
    sourceType: "synthetic_article",
    sourceMetadata: {
      source_url: "https://example.invalid/article",
      source_is_original: true,
      input_form: "written",
      content_profile: "natural_language",
      language: "en"
    },
    userInstruction: "完整翻译为简体中文。",
    processingOptions: standardWorkflowOptions({ content_profile: "natural_language" })
  });
  const producer = {
    async generate(payload) {
      return {
        provider: "synthetic",
        model: "workflow-natural-v1",
        usage: null,
        output: {
          cleaned_blocks: payload.blocks.map((block) => ({
            source_block_key: block.source_block_key,
            markdown: block.type === "heading"
              ? "# 一则实践笔记"
              : "细致观察能把证据与假设区分开来，从而改善判断。"
          })),
          ...semantic(payload.blocks.find((block) => block.type === "paragraph").source_block_key)
        }
      };
    }
  };
  const { result } = await runPreprocessingRequest(request, { producer, cacheDir: false });
  assert.equal(result.status, "completed", JSON.stringify(result.errors));
  assert.equal(result.receipt.workflow_route.content_profile.value, "natural_language");
  assert.deepEqual(result.receipt.workflow_route.stages.map((stage) => stage.id), ["profile_translation", "profile_standardization"]);
  assert.equal(result.receipt.processing_profile, undefined);
  assert.match(result.artifacts.reading_markdown, /细致观察能把证据与假设区分开来/u);
  assert.match(result.artifacts.reading_markdown, /## 原文\n\n# A practical note/u);
  assert.equal(result.receipt.validations.find((item) => item.name === "translation_original_appended")?.status, "passed");
});

test("AI-routed bilingual material is standardized without entering translation", async () => {
  const request = buildPreprocessRequest({
    markdown: "# Bilingual note\n\n证据与假设需要区分。\n\nEvidence and assumptions must be distinguished.",
    idempotencyKey: "workflow-bilingual-no-translation",
    sourceType: "synthetic_bilingual_article",
    sourceMetadata: { source_url: "https://example.invalid/bilingual", source_is_original: true },
    processingOptions: standardWorkflowOptions()
  });
  const producer = {
    async classifyWorkflow() {
      return routingResult({ input_form: "written", content_profile: "natural_language", source_language: "bilingual" });
    },
    async generate(payload) {
      const target = payload.blocks.find((block) => block.type === "paragraph").source_block_key;
      return {
        provider: "synthetic",
        model: "workflow-bilingual-v1",
        usage: null,
        output: {
          cleaned_blocks: [{ source_block_key: target, markdown: payload.blocks.find((block) => block.source_block_key === target).markdown }],
          ...semantic(target),
          translation: {
            is_bilingual: true,
            alignments: [{ original_block_key: target, translation_block_key: target, confidence: 0.9, status: "aligned" }]
          }
        }
      };
    }
  };
  const { result } = await runPreprocessingRequest(request, { producer, cacheDir: false });
  assert.equal(result.status, "completed", JSON.stringify(result.errors));
  assert.equal(result.receipt.workflow_route.source_language.value, "bilingual");
  assert.equal(result.receipt.workflow_route.translation_required, false);
  assert.deepEqual(result.receipt.workflow_route.stages.map((stage) => stage.id), ["profile_standardization"]);
  assert.equal(result.receipt.validations.find((item) => item.name === "workflow_bilingual_translation_skip")?.status, "passed");
  assert.doesNotMatch(result.artifacts.reading_markdown, /\n## 原文\n/u);
});

test("bilingual math lecture uses math standardization without translation", async () => {
  const request = buildPreprocessRequest({
    markdown: "# 定理 / Theorem\n\n对所有 $n$，结论成立。 For every $n$, the claim holds.\n\n$$T(n)=2T(n/2)+n$$",
    idempotencyKey: "workflow-bilingual-math-standardization",
    sourceType: "synthetic_bilingual_math_lecture",
    sourceMetadata: {
      source_url: "https://example.invalid/bilingual-math",
      source_is_original: true,
      input_form: "written",
      content_profile: "math_lecture",
      language: "bilingual"
    },
    processingOptions: standardWorkflowOptions()
  });
  const producer = {
    async generate(payload) {
      assert.equal(payload.processing_profile.version, MATH_LECTURE_STANDARDIZATION_PROFILE_VERSION);
      const target = payload.blocks.find((block) => block.type === "paragraph").source_block_key;
      return {
        provider: "synthetic",
        model: "math-standardization-v1",
        usage: null,
        output: {
          cleaned_blocks: payload.blocks.map((block) => ({ source_block_key: block.source_block_key, markdown: block.markdown })),
          ...semantic(target),
          translation: {
            is_bilingual: true,
            alignments: [{ original_block_key: target, translation_block_key: target, confidence: 0.9, status: "aligned" }]
          }
        }
      };
    }
  };
  const { result } = await runPreprocessingRequest(request, { producer, cacheDir: false });
  assert.equal(result.status, "completed", JSON.stringify(result.errors));
  assert.equal(result.receipt.workflow_route.translation_required, false);
  assert.equal(result.receipt.processing_profile.version, MATH_LECTURE_STANDARDIZATION_PROFILE_VERSION);
  assert.equal(result.artifacts.bilingual.detection.bilingual, true);
  assert.equal(result.receipt.validations.find((item) => item.name === "math_lecture_standardization")?.status, "passed");
  assert.doesNotMatch(result.artifacts.reading_markdown, /\n## 原文\n/u);
});
