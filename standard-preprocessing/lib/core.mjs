import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { ExternalProducer } from "./producer.mjs";

export const CONTRACT_VERSION = "1.0.0";
export const REQUEST_SCHEMA_VERSION = "progressive-reading.preprocess.request/v1";
export const RESULT_SCHEMA_VERSION = "progressive-reading.preprocess.result/v1";
export const PROCESSOR_VERSION = "1.0.0";
export const PROMPT_VERSION = "whole-article-cleaning-v1";

const CONTINUE_READING_LABELS = {
  0: "不值得读",
  1: "一句话核心",
  2: "概览",
  3: "概览与关键结论",
  4: "选择性全文",
  5: "全文",
  6: "精细阅读",
  7: "精细阅读并加工"
};

const VALUE_LABELS = { high: "高", medium: "中", low: "低", skip: "跳过" };
const DENSITY_LABELS = { high: "高", medium: "中", low: "低" };
const CHINESE_NUMERALS = ["一", "二", "三", "四", "五", "六", "七", "八", "九", "十", "十一", "十二", "十三", "十四", "十五", "十六", "十七", "十八", "十九", "二十", "二十一", "二十二", "二十三", "二十四"];

export function sha256(value) {
  return createHash("sha256").update(String(value), "utf8").digest("hex");
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
  }
  return value;
}

export function stableJson(value) {
  return JSON.stringify(stableValue(value));
}

function errorItem(code, stage, message, { retryable = false, severity = "error" } = {}) {
  return { code, stage, message, retryable, severity };
}

function normalizeNewlines(value) {
  return String(value || "").replace(/^\uFEFF/u, "").replace(/\r\n?/gu, "\n");
}

function stripOuterFrontmatter(markdown) {
  const text = normalizeNewlines(markdown);
  const match = /^---\n([\s\S]*?)\n---\n?/u.exec(text);
  if (!match) return { body: text.trim(), frontmatter: {} };
  const frontmatter = {};
  for (const line of match[1].split("\n")) {
    const parsed = /^([A-Za-z0-9_.-]+):\s*(.*?)\s*$/u.exec(line);
    if (!parsed) continue;
    const raw = parsed[2].replace(/^(["'])(.*)\1$/u, "$2");
    frontmatter[parsed[1]] = raw === "null" ? null : raw;
  }
  return { body: text.slice(match[0].length).trim(), frontmatter };
}

function normalizeMarkdown(markdown) {
  return normalizeNewlines(markdown)
    .replace(/[ \t]+$/gmu, "")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
}

function extractMaterial(request) {
  const source = request.material ?? request.input;
  if (typeof source === "string") return { markdown: source, original_markdown: "" };
  if (source && typeof source === "object") {
    return {
      markdown: source.markdown ?? source.input ?? "",
      original_markdown: source.original_markdown ?? source.originalMarkdown ?? ""
    };
  }
  return { markdown: "", original_markdown: "" };
}

function validateRequest(request) {
  const errors = [];
  if (!request || typeof request !== "object" || Array.isArray(request)) {
    return [errorItem("invalid_request", "request", "request must be a JSON object")];
  }
  if (request.schema_version !== REQUEST_SCHEMA_VERSION) {
    errors.push(errorItem("unsupported_request_schema", "request", `schema_version must be ${REQUEST_SCHEMA_VERSION}`));
  }
  const material = extractMaterial(request);
  if (!String(material.markdown || "").trim()) errors.push(errorItem("empty_markdown", "request", "material markdown is required"));
  if (!String(request.source_type || "").trim()) errors.push(errorItem("missing_source_type", "request", "source_type is required"));
  if (!request.source_metadata || typeof request.source_metadata !== "object" || Array.isArray(request.source_metadata)) {
    errors.push(errorItem("invalid_source_metadata", "request", "source_metadata must be an object"));
  }
  if (typeof request.user_instruction !== "string") {
    errors.push(errorItem("invalid_user_instruction", "request", "user_instruction must be a string, including an empty string when unused"));
  }
  return errors;
}

function normalizeMetadata(metadata, embeddedFrontmatter) {
  const explicit = metadata && typeof metadata === "object" ? structuredClone(metadata) : {};
  const translation = explicit.translation && typeof explicit.translation === "object"
    ? structuredClone(explicit.translation)
    : {};
  const originalUrl = explicit.original_url || translation.original_url || null;
  const sourceUrl = explicit.canonical_url || explicit.source_url || embeddedFrontmatter.source_url || null;
  return {
    ...explicit,
    source_url: sourceUrl,
    original_url: originalUrl,
    translation: {
      ...translation,
      is_translation: Boolean(translation.is_translation ?? explicit.is_translation ?? false),
      original_url: originalUrl,
      original_language: translation.original_language || explicit.original_language || "en",
      translation_language: translation.translation_language || explicit.translation_language || "zh"
    },
    embedded_frontmatter: embeddedFrontmatter
  };
}

function metadataForProducer(metadata) {
  const allowed = [
    "source_url",
    "original_url",
    "title",
    "source_title",
    "author",
    "source_name",
    "published_at",
    "language",
    "source_is_original"
  ];
  const selected = Object.fromEntries(allowed
    .filter((key) => metadata[key] !== undefined)
    .map((key) => [key, metadata[key]]));
  selected.translation = {
    is_translation: metadata.translation.is_translation,
    original_url: metadata.translation.original_url,
    original_language: metadata.translation.original_language,
    translation_language: metadata.translation.translation_language
  };
  if (metadata.capture && typeof metadata.capture === "object") {
    selected.capture = {
      method: metadata.capture.method || null,
      source_evidence_id: metadata.capture.source_evidence_id || null
    };
  }
  return selected;
}

function languageOf(text) {
  const cjk = (String(text).match(/[\p{Script=Han}]/gu) || []).length;
  const latin = (String(text).match(/[A-Za-z]/gu) || []).length;
  if (cjk > latin * 0.45 && cjk >= 4) return "zh";
  if (latin >= 4) return "en";
  return "und";
}

function blockType(markdown) {
  const value = String(markdown).trim();
  if (/^#{1,6}\s+/u.test(value)) return "heading";
  if (/^```|^~~~/u.test(value)) return "code";
  if (/^(?:[-*+] |\d+[.)] )/u.test(value)) return "list";
  if (/^>/u.test(value)) return "quote";
  if (/^\|.*\|$/mu.test(value)) return "table";
  return "paragraph";
}

function splitMarkdownBlocks(markdown, { role = "body", languageHint = "" } = {}) {
  const lines = normalizeMarkdown(markdown).split("\n");
  const groups = [];
  let current = [];
  let fence = null;
  const flush = () => {
    const value = current.join("\n").trim();
    if (value) groups.push(value);
    current = [];
  };
  for (const line of lines) {
    const marker = /^\s*(```|~~~)/u.exec(line)?.[1] || null;
    if (marker) {
      if (!fence) fence = marker;
      else if (fence === marker) fence = null;
      current.push(line);
      continue;
    }
    if (!fence && !line.trim()) flush();
    else current.push(line);
  }
  flush();

  let currentRole = role;
  return groups.map((value, index) => {
    const heading = /^#{1,6}\s+(.+)$/u.exec(value)?.[1]?.trim() || "";
    if (heading) {
      if (/译文|中文译文|translation|translated/iu.test(heading)) currentRole = "translation";
      else if (/英文原文|原文|english|original/iu.test(heading)) currentRole = "original";
    }
    const sourceHash = sha256(value);
    return {
      source_block_key: `src-${String(index + 1).padStart(4, "0")}-${sourceHash.slice(0, 8)}`,
      source_index: index,
      type: blockType(value),
      role: currentRole,
      language: languageHint || languageOf(value),
      markdown: value,
      source_hash: sourceHash
    };
  });
}

function buildBlocks(primaryMarkdown, originalMarkdown, metadata) {
  const translated = splitMarkdownBlocks(primaryMarkdown, {
    role: metadata.translation.is_translation ? "translation" : "body",
    languageHint: metadata.translation.is_translation ? metadata.translation.translation_language : ""
  });
  if (!String(originalMarkdown || "").trim()) return translated;
  const original = splitMarkdownBlocks(originalMarkdown, {
    role: "original",
    languageHint: metadata.translation.original_language
  }).map((block, index) => ({
    ...block,
    source_block_key: block.source_block_key.replace(/^src-/u, "orig-"),
    source_index: translated.length + index
  }));
  return [...translated, ...original];
}

function detectTranslation(blocks, metadata) {
  const hasTranslation = blocks.some((block) => block.role === "translation");
  const hasOriginal = blocks.some((block) => block.role === "original");
  const bilingual = hasTranslation && hasOriginal;
  const explicit = metadata.translation.is_translation;
  const sourceIsOriginal = metadata.source_is_original === true;
  const translationContext = explicit || bilingual || hasTranslation;
  const requiresOriginalUrl = translationContext && !sourceIsOriginal;
  return {
    explicit,
    bilingual,
    has_translation: hasTranslation,
    has_original: hasOriginal,
    requires_original_url: requiresOriginalUrl,
    original_url: translationContext
      ? metadata.original_url || (sourceIsOriginal ? metadata.source_url : null)
      : metadata.original_url
  };
}

function materialIdFor(request, primaryHash, metadata) {
  if (request.material_id) return String(request.material_id).replace(/[^A-Za-z0-9._-]/gu, "-");
  const identity = metadata.source_url || metadata.source_id || metadata.title || request.source_type;
  return `mat-${sha256(`${request.source_type}\n${identity}\n${primaryHash}`).slice(0, 20)}`;
}

function idempotencyKeyFor(request, materialId, hashes, metadata) {
  if (request.idempotency_key) return String(request.idempotency_key);
  return `idem-${sha256(stableJson({
    contract_version: request.contract_version || CONTRACT_VERSION,
    material_id: materialId,
    input_hash: hashes.input,
    original_input_hash: hashes.original_input,
    source_type: request.source_type,
    source_metadata: metadata,
    user_instruction: request.user_instruction,
    processing_options: request.processing_options || {}
  })).slice(0, 32)}`;
}

function normalizeForSimilarity(value) {
  return String(value || "").toLowerCase().replace(/\s+/gu, "").replace(/[^\p{L}\p{N}]/gu, "");
}

function bigrams(value) {
  const text = normalizeForSimilarity(value);
  const result = new Map();
  if (text.length < 2) return result;
  for (let index = 0; index < text.length - 1; index += 1) {
    const gram = text.slice(index, index + 2);
    result.set(gram, (result.get(gram) || 0) + 1);
  }
  return result;
}

function diceSimilarity(a, b) {
  const left = bigrams(a);
  const right = bigrams(b);
  const leftCount = [...left.values()].reduce((sum, count) => sum + count, 0);
  const rightCount = [...right.values()].reduce((sum, count) => sum + count, 0);
  if (!leftCount && !rightCount) return 1;
  let overlap = 0;
  for (const [gram, count] of left) overlap += Math.min(count, right.get(gram) || 0);
  return (2 * overlap) / Math.max(1, leftCount + rightCount);
}

function validateProducerOutput(output, blocks, safetyCap) {
  const failures = [];
  if (!output || typeof output !== "object" || Array.isArray(output)) return ["output_not_object"];
  const cleaned = Array.isArray(output.cleaned_blocks) ? output.cleaned_blocks : [];
  const expectedKeys = blocks.map((block) => block.source_block_key);
  const actualKeys = cleaned.map((block) => block?.source_block_key);
  if (stableJson(actualKeys) !== stableJson(expectedKeys)) failures.push("cleaned_block_keys_or_order_mismatch");
  const byKey = new Map(blocks.map((block) => [block.source_block_key, block]));
  for (const candidate of cleaned) {
    const source = byKey.get(candidate?.source_block_key);
    if (!source || typeof candidate?.markdown !== "string" || !candidate.markdown.trim()) continue;
    if (source.type === "code" && normalizeMarkdown(candidate.markdown) !== normalizeMarkdown(source.markdown)) {
      failures.push(`code_block_changed:${source.source_block_key}`);
    }
    if (source.type !== "code" && diceSimilarity(source.markdown, candidate.markdown) < 0.52) {
      failures.push(`fidelity_too_low:${source.source_block_key}`);
    }
    const sourceUrls = source.markdown.match(/https?:\/\/[^\s)\]>]+/gu) || [];
    for (const url of sourceUrls) {
      if (!candidate.markdown.includes(url)) failures.push(`url_removed:${source.source_block_key}`);
    }
  }
  const judgments = output.judgments || {};
  if (!VALUE_LABELS[judgments.value?.level]) failures.push("invalid_value_judgment");
  if (!DENSITY_LABELS[judgments.density?.level]) failures.push("invalid_density_judgment");
  const continueLevel = judgments.continue_reading?.level;
  if (!Number.isInteger(continueLevel) || continueLevel < 0 || continueLevel > 7) failures.push("invalid_continue_reading_level");
  const insights = Array.isArray(output.insights) ? output.insights : [];
  if (insights.length > safetyCap) failures.push("insight_safety_cap_exceeded");
  const keySet = new Set(expectedKeys);
  for (const [index, insight] of insights.entries()) {
    if (!String(insight?.title || "").trim() || !String(insight?.description || "").trim()) failures.push(`invalid_insight:${index}`);
    if (!keySet.has(insight?.target_block_key)) failures.push(`invalid_insight_target:${index}`);
  }
  const alignments = Array.isArray(output.translation?.alignments) ? output.translation.alignments : [];
  for (const [index, alignment] of alignments.entries()) {
    if (!keySet.has(alignment?.original_block_key) || !keySet.has(alignment?.translation_block_key)) failures.push(`invalid_alignment_key:${index}`);
    if (!Number.isFinite(alignment?.confidence) || alignment.confidence < 0 || alignment.confidence > 1) failures.push(`invalid_alignment_confidence:${index}`);
    if (!new Set(["aligned", "uncertain", "pending"]).has(alignment?.status)) failures.push(`invalid_alignment_status:${index}`);
  }
  return [...new Set(failures)];
}

function fallbackSemantic(blocks) {
  return {
    cleaned_blocks: blocks.map((block) => ({
      source_block_key: block.source_block_key,
      markdown: normalizeMarkdown(block.markdown)
    })),
    judgments: {
      value: { level: "medium", reason: "待人工判断；AI 语义处理未通过校验。" },
      density: { level: "medium", reason: "待人工判断；正文已保真保留。" },
      continue_reading: { level: 2, reason: "先做概览，待语义处理恢复后再决定阅读深度。" }
    },
    insights: [],
    translation: { is_bilingual: false, alignments: [] }
  };
}

function sourceTitle(metadata, blocks) {
  return metadata.title || metadata.source_title || blocks
    .find((block) => block.type === "heading")
    ?.markdown.replace(/^#{1,6}\s+/u, "").trim() || "未命名材料";
}

function yamlString(value) {
  if (value === null || value === undefined || value === "") return "null";
  return JSON.stringify(String(value));
}

function renderBodyBlocks(materialId, blocks, cleanedBlocks) {
  const sourceByKey = new Map(blocks.map((block) => [block.source_block_key, block]));
  return cleanedBlocks.map((cleaned) => {
    const source = sourceByKey.get(cleaned.source_block_key);
    const blockId = `pr-${sha256(`${materialId}:${cleaned.source_block_key}`).slice(0, 12)}`;
    return {
      source_block_key: cleaned.source_block_key,
      block_id: blockId,
      markdown: normalizeMarkdown(cleaned.markdown),
      source_hash: source.source_hash,
      output_hash: sha256(normalizeMarkdown(cleaned.markdown)),
      type: source.type,
      role: source.role,
      language: source.language
    };
  });
}

function renderReadingMarkdown({ materialId, metadata, sourceType, hashes, semantic, bodyBlocks, translationState }) {
  const blockByKey = new Map(bodyBlocks.map((block) => [block.source_block_key, block]));
  const judgments = semantic.judgments;
  const lines = [
    "---",
    `material_id: ${yamlString(materialId)}`,
    `contract_version: ${yamlString(CONTRACT_VERSION)}`,
    `source_type: ${yamlString(sourceType)}`,
    `source_url: ${yamlString(metadata.source_url)}`,
    `original_url: ${yamlString(metadata.original_url)}`,
    `translation_state: ${yamlString(translationState)}`,
    `input_sha256: ${yamlString(hashes.input)}`,
    "processing_status: ready",
    "---",
    "",
    `# ${sourceTitle(metadata, bodyBlocks)}`,
    "",
    "## 阅读前置卡",
    "",
    `- 价值判断：${VALUE_LABELS[judgments.value.level]}。${judgments.value.reason}`,
    `- 信息密度判断：${DENSITY_LABELS[judgments.density.level]}。${judgments.density.reason}`,
    `- 是否继续阅读：${judgments.continue_reading.level} ${CONTINUE_READING_LABELS[judgments.continue_reading.level]}。${judgments.continue_reading.reason}`,
    "",
    "## 核心洞察",
    ""
  ];
  if (!semantic.insights.length) lines.push("- 待处理：本次未生成通过校验的核心洞察。", "");
  semantic.insights.forEach((insight, index) => {
    const target = blockByKey.get(insight.target_block_key);
    const jump = target ? `＋[[#^${target.block_id}|正文跳转]]` : "";
    lines.push(`${CHINESE_NUMERALS[index] || String(index + 1)}、${insight.title}：${insight.description}${jump}`, "");
  });
  lines.push("---", "", "## 正文", "");
  for (const block of bodyBlocks) lines.push(block.markdown, "", `^${block.block_id}`, "");
  return `${lines.join("\n").replace(/\n{3,}/gu, "\n\n").trim()}\n`;
}

function renderQuarantineMarkdown({ materialId, metadata, sourceType, hashes, blocks }) {
  const lines = [
    "---",
    `material_id: ${yamlString(materialId)}`,
    `contract_version: ${yamlString(CONTRACT_VERSION)}`,
    `source_type: ${yamlString(sourceType)}`,
    `source_url: ${yamlString(metadata.source_url)}`,
    "original_url: null",
    "translation_state: translation_original_missing",
    `input_sha256: ${yamlString(hashes.input)}`,
    "processing_status: quarantined",
    "---",
    "",
    `# ${sourceTitle(metadata, blocks)}`,
    "",
    "> 当前材料被识别为译文或双语材料，但缺少可验证的原文链接，因此未进入正常阅读池。",
    "",
    "## 恢复条件",
    "",
    "- 在 source_metadata.original_url 或 source_metadata.translation.original_url 注入原文链接。",
    "- 如能获得原文 Markdown，同时写入 material.original_markdown，以启用对应关系校验。",
    "- 保持 material_id 不变；重新调用接口会以新的幂等键恢复处理。",
    "",
    "## 隔离原文",
    ""
  ];
  for (const block of blocks) lines.push(block.markdown, "");
  return `${lines.join("\n").replace(/\n{3,}/gu, "\n\n").trim()}\n`;
}

function translationStateFor(detection, alignments) {
  if (detection.requires_original_url && !detection.original_url) return "translation_original_missing";
  if (!detection.explicit && !detection.bilingual && !detection.has_translation) return "not_translation";
  if (!detection.has_original) return "alignment_pending";
  if (!alignments.length || alignments.some((item) => item.status !== "aligned")) return "alignment_pending";
  return "aligned";
}

async function readCache(cacheDir, idempotencyKey) {
  if (!cacheDir) return null;
  try {
    return JSON.parse(await fs.readFile(path.join(cacheDir, `${idempotencyKey}.json`), "utf8"));
  } catch {
    return null;
  }
}

async function writeCache(cacheDir, idempotencyKey, result) {
  if (!cacheDir) return;
  await fs.mkdir(cacheDir, { recursive: true });
  await fs.writeFile(path.join(cacheDir, `${idempotencyKey}.json`), `${JSON.stringify(result, null, 2)}\n`, "utf8");
}

function replayResult(cached, now) {
  return {
    ...cached,
    status: "idempotent_replay",
    receipt: {
      ...cached.receipt,
      replay_of_status: cached.status,
      replayed_at: now
    }
  };
}

export async function processMaterial(request, options = {}) {
  const now = options.now || new Date().toISOString();
  const requestErrors = validateRequest(request);
  if (requestErrors.length) {
    return {
      schema_version: RESULT_SCHEMA_VERSION,
      contract_version: CONTRACT_VERSION,
      status: "failed",
      material_id: request?.material_id || null,
      idempotency_key: request?.idempotency_key || null,
      processing_state: "failed",
      translation_state: "unknown",
      artifacts: {},
      source_metadata: request?.source_metadata || {},
      receipt: { processor_version: PROCESSOR_VERSION, prompt_version: PROMPT_VERSION, created_at: now, validations: [] },
      errors: requestErrors
    };
  }

  const material = extractMaterial(request);
  const primary = stripOuterFrontmatter(material.markdown);
  const original = stripOuterFrontmatter(material.original_markdown);
  const primaryMarkdown = normalizeMarkdown(primary.body);
  const originalMarkdown = normalizeMarkdown(original.body);
  const metadata = normalizeMetadata(request.source_metadata, primary.frontmatter);
  const hashes = {
    input: sha256(primaryMarkdown),
    original_input: originalMarkdown ? sha256(originalMarkdown) : null,
    user_instruction: sha256(request.user_instruction)
  };
  const materialId = materialIdFor(request, hashes.input, metadata);
  const idempotencyKey = idempotencyKeyFor(request, materialId, hashes, metadata);
  const cached = await readCache(options.cacheDir, idempotencyKey);
  if (cached) return replayResult(cached, now);

  const blocks = buildBlocks(primaryMarkdown, originalMarkdown, metadata);
  const translationDetection = detectTranslation(blocks, metadata);
  const safetyCap = Math.min(24, Math.max(1, Number(request.processing_options?.insight_safety_cap || 24)));
  const softTarget = {
    min: Math.max(0, Number(request.processing_options?.insight_soft_min ?? 3)),
    max: Math.min(safetyCap, Math.max(1, Number(request.processing_options?.insight_soft_max ?? 12)))
  };
  const baseReceipt = {
    contract_version: CONTRACT_VERSION,
    processor_version: PROCESSOR_VERSION,
    prompt_version: PROMPT_VERSION,
    material_id: materialId,
    idempotency_key: idempotencyKey,
    created_at: now,
    hashes,
    deterministic: {
      material_id: true,
      idempotency_key: true,
      body_block_ids: true,
      markdown_rendering: true
    },
    model: {
      provider: null,
      model: null,
      calls: 0,
      attempts: [],
      metadata_policy: "allowlist-no-credentials-cookies-or-headers"
    },
    validations: []
  };

  if (translationDetection.requires_original_url && !translationDetection.original_url) {
    const quarantineMarkdown = renderQuarantineMarkdown({ materialId, metadata, sourceType: request.source_type, hashes, blocks });
    const result = {
      schema_version: RESULT_SCHEMA_VERSION,
      contract_version: CONTRACT_VERSION,
      status: "quarantined",
      material_id: materialId,
      idempotency_key: idempotencyKey,
      processing_state: "quarantined",
      translation_state: "translation_original_missing",
      artifacts: {
        reading_markdown: null,
        quarantine_markdown: quarantineMarkdown,
        target_zone: "translation-quarantine",
        semantic: null,
        body_blocks: blocks,
        bilingual: { detection: translationDetection, alignments: [] },
        artifact_hashes: { quarantine_markdown: sha256(quarantineMarkdown) }
      },
      source_metadata: { ...metadata, original_url: null },
      receipt: {
        ...baseReceipt,
        validations: [{ name: "original_url_required", status: "failed" }]
      },
      errors: [errorItem("translation_original_url_missing", "translation", "译文或双语材料缺少原文链接，已进入隔离区。", { severity: "warning" })]
    };
    await writeCache(options.cacheDir, idempotencyKey, result);
    return result;
  }

  const producer = options.producer || new ExternalProducer();
  const attempts = [];
  let semantic = null;
  let lastFailures = [];
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      baseReceipt.model.calls += 1;
      const generated = await producer.generate({
        material_id: materialId,
        source_type: request.source_type,
        source_metadata: metadataForProducer(metadata),
        user_instruction: request.user_instruction,
        translation_detection: translationDetection,
        insight_policy: { soft_target: softTarget, safety_cap: safetyCap },
        blocks: blocks.map(({ source_block_key, type, role, language, markdown }) => ({ source_block_key, type, role, language, markdown }))
      }, { validationFeedback: lastFailures, attempt });
      baseReceipt.model.provider = generated.provider;
      baseReceipt.model.model = generated.model;
      lastFailures = validateProducerOutput(generated.output, blocks, safetyCap);
      attempts.push({ attempt, status: lastFailures.length ? "rejected" : "accepted", validation_errors: lastFailures, usage: generated.usage || null });
      if (!lastFailures.length) {
        semantic = generated.output;
        break;
      }
    } catch (error) {
      lastFailures = [error instanceof Error ? error.message : String(error)];
      attempts.push({ attempt, status: "failed", validation_errors: lastFailures, usage: null });
    }
  }
  baseReceipt.model.attempts = attempts;

  const errors = [];
  let status = "completed";
  let processingState = "rendered";
  if (!semantic) {
    semantic = fallbackSemantic(blocks);
    status = "completed_with_warnings";
    processingState = "degraded";
    errors.push(errorItem("producer_output_rejected", "semantic_processing", `AI 输出在 3 次尝试后仍未通过校验：${lastFailures.join(", ")}`, { severity: "warning" }));
  }

  const bodyBlocks = renderBodyBlocks(materialId, blocks, semantic.cleaned_blocks);
  const alignments = Array.isArray(semantic.translation?.alignments) ? semantic.translation.alignments : [];
  const translationState = translationStateFor(translationDetection, alignments);
  if (translationState === "alignment_pending") {
    status = status === "completed" ? "completed_with_warnings" : status;
    errors.push(errorItem("translation_alignment_pending", "translation", "原文与译文尚未全部可靠对应，已保留置信度和待处理状态。", { severity: "warning" }));
  }
  const readingMarkdown = renderReadingMarkdown({
    materialId,
    metadata: { ...metadata, original_url: translationDetection.original_url },
    sourceType: request.source_type,
    hashes,
    semantic,
    bodyBlocks,
    translationState
  });
  const validations = [
    { name: "request_schema", status: "passed" },
    { name: "block_coverage", status: semantic.cleaned_blocks.length === blocks.length ? "passed" : "failed" },
    { name: "insight_targets", status: semantic.insights.every((item) => bodyBlocks.some((block) => block.source_block_key === item.target_block_key)) ? "passed" : "failed" },
    { name: "deterministic_block_ids", status: "passed" },
    { name: "original_url", status: translationDetection.requires_original_url ? "passed" : "not_applicable" }
  ];
  const result = {
    schema_version: RESULT_SCHEMA_VERSION,
    contract_version: CONTRACT_VERSION,
    status,
    material_id: materialId,
    idempotency_key: idempotencyKey,
    processing_state: processingState,
    translation_state: translationState,
    artifacts: {
      reading_markdown: readingMarkdown,
      quarantine_markdown: null,
      target_zone: "local-ir-reading",
      semantic: {
        judgments: semantic.judgments,
        insights: semantic.insights
      },
      body_blocks: bodyBlocks,
      bilingual: { detection: translationDetection, alignments },
      artifact_hashes: {
        reading_markdown: sha256(readingMarkdown),
        semantic: sha256(stableJson({ judgments: semantic.judgments, insights: semantic.insights })),
        body_blocks: sha256(stableJson(bodyBlocks))
      }
    },
    source_metadata: { ...metadata, original_url: translationDetection.original_url },
    receipt: { ...baseReceipt, validations },
    errors
  };
  await writeCache(options.cacheDir, idempotencyKey, result);
  return result;
}
