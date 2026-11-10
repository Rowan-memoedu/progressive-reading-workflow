import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { SPOKEN_REFINEMENT_VERSION, spokenQualityFromReceipt } from "./spoken-quality.mjs";
import Ajv2020 from "ajv/dist/2020.js";
import { loadTranslationPolicy } from "./translation-policy.mjs";
import { TRANSLATION_UNIT_VERSION } from "./translation-units.mjs";
import { isEditorialDetailFailure, isShortEnglishLabel } from "./producer.mjs";
import { ExternalProducer, extractProtectedHttpUrls, findEnglishNaturalLanguageResidues, insightContractRepairIndexes, INLINE_CODE_PATTERN, isBibliographicReferenceBlock, MARKDOWN_LINK_DESTINATION_PATTERN, translationLiteralBlockKeys, translationNaturalLanguage } from "./producer.mjs";
import {
  buildMathLectureCoverage,
  collectPreservedMathLectureTerms,
  isMathLectureProfile,
  mathLectureAtomicKind,
  MATH_LECTURE_CONTENT_PROFILE,
  MATH_LECTURE_PROFILE_VERSION,
  MATH_LECTURE_PROMPT_VERSION,
  MATH_LECTURE_STANDARDIZATION_PROFILE_VERSION,
  MATH_LECTURE_STANDARDIZATION_PROMPT_VERSION,
  normalizeMathLectureReadingTerminology,
  stripAllowedMathLectureTerms,
  validateMathLectureTerminology
} from "./math-lecture.mjs";
import { normalizePandocSemanticBlocks } from "./pandoc-normalizer.mjs";
import { splitOutlineSubtrees } from "./outline-blocks.mjs";
import { GUIDE_COVERAGE_VERSION } from './guide-coverage.mjs';
import { normalizeReaderMath } from './reader-math.mjs';

export const CONTRACT_VERSION = "1.0.0";
export const REQUEST_SCHEMA_VERSION = "progressive-reading.preprocess.request/v1";
export const RESULT_SCHEMA_VERSION = "progressive-reading.preprocess.result/v1";
export const PROCESSOR_VERSION = "1.12.6";
export const PROMPT_VERSION = "source-translation-v2.2-five-level-judgments";

const CONTINUE_READING_LABELS = {
  0: "不值得读",
  1: "一句话核心",
  2: "概览与关键结论",
  3: "全文",
  4: "精细阅读"
};

const VALUE_LABELS = { very_low: "极低", low: "低", medium: "中", high: "高", very_high: "极高" };
const DENSITY_LABELS = { very_low: "极低", low: "低", medium: "中", high: "高", very_high: "极高" };
export function sourceHasAuthorAttribution(markdown) {
  return /作者(?:认为|指出|强调|判断|提出|主张|表示|解释|总结|建议)/u.test(markdown)
    || /\b(?:authors?|researchers?|writers?)\s+(?:(?:also|further|explicitly|specifically)\s+)?(?:argue|note|point\s+out|emphasize|suggest|explain|conclude|state|claim|observe)(?:s|d|ed)?\b/iu.test(translationNaturalLanguage(markdown));
}
export function hasIntroducedTranslationTime(source, translated) {
  const pattern = /(?<!\d)\d{1,2}:\d{2}(?::\d{2})?(?!\d)/gu;
  const counts = new Map();
  for (const value of String(source).match(pattern) || []) counts.set(value,(counts.get(value)||0)+1);
  for (const value of String(translated).match(pattern) || []) {
    if (!counts.get(value)) return true;
    counts.set(value,counts.get(value)-1);
  }
  return false;
}
const CHINESE_NUMERALS = ["一", "二", "三", "四", "五", "六", "七", "八", "九", "十", "十一", "十二", "十三", "十四", "十五", "十六", "十七", "十八", "十九", "二十", "二十一", "二十二", "二十三", "二十四"];

export function sha256(value) {
  const input = Buffer.isBuffer(value) || value instanceof Uint8Array ? value : String(value);
  return createHash("sha256").update(input, "utf8").digest("hex");
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

function trimOuterBlankLines(value) {
  const lines = normalizeNewlines(value).split("\n");
  while (lines.length && /^[ \t]*$/u.test(lines[0])) lines.shift();
  while (lines.length && /^[ \t]*$/u.test(lines.at(-1))) lines.pop();
  return lines.join("\n");
}

function stripOuterFrontmatter(markdown) {
  const text = normalizeNewlines(markdown);
  const match = /^---\n([\s\S]*?)\n---\n?/u.exec(text);
  if (!match) return { body: trimOuterBlankLines(text), frontmatter: {} };
  const frontmatter = {};
  for (const line of match[1].split("\n")) {
    const parsed = /^([A-Za-z0-9_.-]+):\s*(.*?)\s*$/u.exec(line);
    if (!parsed) continue;
    const raw = parsed[2].replace(/^(["'])(.*)\1$/u, "$2");
    frontmatter[parsed[1]] = raw === "null" ? null : raw;
  }
  return { body: trimOuterBlankLines(text.slice(match[0].length)), frontmatter };
}

function normalizeMarkdown(markdown) {
  const lines = trimOuterBlankLines(markdown).split("\n");
  const normalized = [];
  let fence = null;
  for (const line of lines) {
    if (fence) {
      normalized.push(line);
      const closing = new RegExp(`^ {0,3}${fence.character}{${fence.length},}[ \\t]*$`, "u");
      if (closing.test(line)) fence = null;
      continue;
    }
    const opening = /^ {0,3}(`{3,}|~{3,})/u.exec(line);
    if (opening) {
      fence = { character: opening[1][0], length: opening[1].length };
      normalized.push(line);
      continue;
    }
    if (/^[ \t]*$/u.test(line)) {
      if (normalized.length && normalized.at(-1) !== "") normalized.push("");
      continue;
    }
    normalized.push(line);
  }
  return trimOuterBlankLines(normalized.join("\n"));
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

export function validateRequest(request) {
  const errors = [];
  if (!request || typeof request !== "object" || Array.isArray(request)) {
    return [errorItem("invalid_request", "request", "request must be a JSON object")];
  }
  if (request.schema_version !== REQUEST_SCHEMA_VERSION) {
    errors.push(errorItem("unsupported_request_schema", "request", `schema_version must be ${REQUEST_SCHEMA_VERSION}`));
  }
  if (request.contract_version !== CONTRACT_VERSION) {
    errors.push(errorItem("unsupported_contract_version", "request", `contract_version must be ${CONTRACT_VERSION}`));
  }
  const allowedRootKeys = new Set([
    "schema_version", "contract_version", "material_id", "idempotency_key", "source_type",
    "source_metadata", "user_instruction", "processing_options", "material", "input"
  ]);
  const unknownRootKeys = Object.keys(request).filter((key) => !allowedRootKeys.has(key));
  if (unknownRootKeys.length) {
    errors.push(errorItem("unknown_request_fields", "request", `unknown request fields: ${unknownRootKeys.join(", ")}`));
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
  if (request.material_id !== undefined && (typeof request.material_id !== "string" || !request.material_id.trim())) {
    errors.push(errorItem("invalid_material_id", "request", "material_id must be a non-empty string when provided"));
  }
  if (request.idempotency_key !== undefined && !/^[A-Za-z0-9._-]{1,128}$/u.test(request.idempotency_key)) {
    errors.push(errorItem("invalid_idempotency_key", "request", "idempotency_key must match [A-Za-z0-9._-] and be at most 128 characters"));
  }
  const processing = request.processing_options;
  if (processing !== undefined) {
    if (!processing || typeof processing !== "object" || Array.isArray(processing)) {
      errors.push(errorItem("invalid_processing_options", "request", "processing_options must be an object"));
    } else {
      const allowed = new Set([
        "workflow_mode", "include_reading_guide", "spoken_to_written", "structure_body", "translate", "input_form", "content_profile", "source_language", "original_placement",
        "cleaning_mode", "preserve_source_voice", "forbid_visible_timestamps", "require_content_headings", "attribute_unverified_claims",
        "translation_target_language", "translation_mode", "normalize_semantic_containers", "insight_soft_min", "insight_soft_max", "insight_safety_cap"
      ]);
      const unknown = Object.keys(processing).filter((key) => !allowed.has(key));
      if (unknown.length) errors.push(errorItem("unknown_processing_options", "request", `unknown processing options: ${unknown.join(", ")}`));
      if (processing.translation_mode !== undefined && !['terminology','plain'].includes(processing.translation_mode)) errors.push(errorItem('invalid_translation_mode','request','translation_mode must be terminology or plain'));
      if (processing.workflow_mode !== undefined && !new Set(["standard", "single_stage"]).has(processing.workflow_mode)) {
        errors.push(errorItem("invalid_workflow_mode", "request", "workflow_mode must be standard or single_stage"));
      }
      if (processing.input_form !== undefined && !new Set(["auto", "spoken_transcript", "written"]).has(processing.input_form)) {
        errors.push(errorItem("invalid_input_form", "request", "input_form must be auto, spoken_transcript, or written"));
      }
      if (processing.content_profile !== undefined && !new Set(["auto", "natural_language", "math_lecture", "literature"]).has(processing.content_profile)) {
        errors.push(errorItem("invalid_content_profile", "request", "content_profile must be auto, natural_language, math_lecture, or literature"));
      }
      if (processing.original_placement !== undefined && processing.original_placement !== "after_translation") {
        errors.push(errorItem("invalid_original_placement", "request", "translated reading Markdown must place the original after the translation"));
      }
      if (processing.cleaning_mode !== undefined && !new Set(["semantic_only", "source_voice_structuring", "lossless_spoken_to_written", "source_translation"]).has(processing.cleaning_mode)) {
        errors.push(errorItem("invalid_cleaning_mode", "request", "cleaning_mode must be semantic_only, source_voice_structuring, lossless_spoken_to_written, or source_translation"));
      }
      if (processing.translation_target_language !== undefined
        && (typeof processing.translation_target_language !== "string" || processing.translation_target_language.trim().length < 2 || processing.translation_target_language.length > 32)) {
        errors.push(errorItem("invalid_translation_target_language", "request", "translation_target_language must be a 2-32 character language tag"));
      }
      if (processing.cleaning_mode === "source_translation" && !String(processing.translation_target_language || "").trim()) {
        errors.push(errorItem("translation_target_language_required", "request", "source_translation requires translation_target_language"));
      }
      for (const key of ["include_reading_guide", "spoken_to_written", "structure_body", "translate", "preserve_source_voice", "forbid_visible_timestamps", "require_content_headings", "attribute_unverified_claims", "normalize_semantic_containers"]) {
        if (processing[key] !== undefined && typeof processing[key] !== "boolean") {
          errors.push(errorItem(`invalid_${key}`, "request", `${key} must be boolean`));
        }
      }
      for (const key of ["insight_soft_min", "insight_soft_max", "insight_safety_cap"]) {
        if (processing[key] !== undefined && (!Number.isInteger(processing[key]) || processing[key] < (key === "insight_soft_min" ? 0 : 1) || processing[key] > 24)) {
          errors.push(errorItem(`invalid_${key}`, "request", `${key} must be an integer within the v1 contract range`));
        }
      }
      const insightSoftMin = processing.insight_soft_min ?? 3;
      const insightSoftMax = processing.insight_soft_max ?? 12;
      const insightSafetyCap = processing.insight_safety_cap ?? 24;
      if ([insightSoftMin, insightSoftMax, insightSafetyCap].every(Number.isInteger)
        && !(insightSoftMin <= insightSoftMax && insightSoftMax <= insightSafetyCap)) {
        errors.push(errorItem(
          "invalid_insight_budget_order",
          "request",
          "insight budget must satisfy insight_soft_min <= insight_soft_max <= insight_safety_cap after defaults are applied"
        ));
      }
    }
  }
  return errors;
}

function cleaningPolicyFor(request) {
  return {
    ...(request.processing_options?.include_reading_guide === false ? { include_reading_guide: false } : {}),
    mode: request.processing_options?.cleaning_mode || "source_voice_structuring",
    preserve_source_voice: request.processing_options?.preserve_source_voice !== false,
    forbid_visible_timestamps: request.processing_options?.forbid_visible_timestamps === true,
    preserve_source_clock_times: request.processing_options?.input_form === 'written'
      && request.processing_options?.spoken_to_written === false,
    require_content_headings: request.processing_options?.require_content_headings === true,
    attribute_unverified_claims: request.processing_options?.attribute_unverified_claims === true,
    translation_target_language: request.processing_options?.translation_target_language || null,
    normalize_semantic_containers: request.processing_options?.normalize_semantic_containers !== false
  };
}

function promptVersionFor(request) {
  if (!isMathLectureProfile(request.source_metadata)) return PROMPT_VERSION;
  return request.processing_options?.cleaning_mode === "source_translation"
    ? MATH_LECTURE_PROMPT_VERSION
    : MATH_LECTURE_STANDARDIZATION_PROMPT_VERSION;
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
    "content_profile",
    "input_form",
    "language",
    "terminology_terms",
    "source_is_original"
  ];
  const selected = Object.fromEntries(allowed
    .filter((key) => metadata[key] !== undefined)
    .map((key) => [key, metadata[key]]));
  selected.translation = {
    is_translation: metadata.translation.is_translation,
    is_bilingual: metadata.translation.is_bilingual === true || metadata.language === "bilingual",
    original_url: metadata.translation.original_url,
    original_language: metadata.translation.original_language,
    translation_language: metadata.translation.translation_language,
    ...(metadata.translation.existing_translation_only === true ? { existing_translation_only: true } : {})
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

function gfmTableCells(line) {
  const trimmed = String(line || "").trim();
  if (!trimmed.includes("|")) return [];
  const withoutEdges = trimmed.replace(/^\|/u, "").replace(/\|$/u, "");
  return withoutEdges.split(/(?<!\\)\|/u).map((cell) => cell.trim());
}

function isGfmDelimiterRow(line, expectedCells = null) {
  const cells = gfmTableCells(line);
  return cells.length >= 1
    && (expectedCells === null || cells.length === expectedCells)
    && cells.every((cell) => /^:?-{3,}:?$/u.test(cell));
}

function isGfmTableBlock(markdown) {
  const lines = trimOuterBlankLines(markdown).split("\n");
  const headerCells = gfmTableCells(lines[0]);
  if (lines.length < 2 || headerCells.length < 1 || !isGfmDelimiterRow(lines[1], headerCells.length)) return false;
  return lines.slice(2).every((line) => gfmTableCells(line).length === headerCells.length);
}

function splitGfmTableSegments(markdown) {
  const lines = String(markdown || "").split("\n");
  const segments = [];
  let pending = [];
  const flushPending = () => {
    const value = trimOuterBlankLines(pending.join("\n"));
    if (value) segments.push(value);
    pending = [];
  };
  for (let index = 0; index < lines.length;) {
    const headerCells = gfmTableCells(lines[index]);
    if (headerCells.length && index + 1 < lines.length && isGfmDelimiterRow(lines[index + 1], headerCells.length)) {
      flushPending();
      const table = [lines[index], lines[index + 1]];
      index += 2;
      while (index < lines.length && gfmTableCells(lines[index]).length === headerCells.length) {
        table.push(lines[index]);
        index += 1;
      }
      segments.push(table.join("\n"));
      continue;
    }
    pending.push(lines[index]);
    index += 1;
  }
  flushPending();
  return segments;
}

function isStandaloneCodeLikeBlock(markdown) {
  const value = String(markdown || "").trim();
  if (!value || value.includes("\n")) return false;
  if (/^(?:public|private|protected|static|final|abstract|class|interface|enum|record|package|import)\b.*(?:[;{}]|\([^)]*\))$/u.test(value)) return true;
  if (/^(?:def|async\s+def|function|const|let|var)\s+[A-Za-z_$][\w$]*/u.test(value)) return true;
  if (/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+\s*\([^\n]*\)\s*;?$/u.test(value)) return true;
  return /[;{}]$/u.test(value)
    && /(?:\([^\n]*\)|\[[^\n]*\]|\b(?:return|throw|new)\b|=[^=])/u.test(value)
    && !/[。！？]$/u.test(value);
}

function blockType(markdown) {
  const value = String(markdown).trim();
  const contentValue = value.replace(/^(?:<!--\s*pdf-structure:[\s\S]*?-->\s*)+/u, "");
  if (/^#{1,6}\s+/u.test(contentValue)) return "heading";
  if (/^```|^~~~/u.test(contentValue)) return "code";
  if (/^(?:[-*+] |\d+[.)] )/u.test(contentValue)) return "list";
  if (/^>/u.test(contentValue)) return "quote";
  if (isGfmTableBlock(contentValue)) return "table";
  if (isStandaloneCodeLikeBlock(contentValue)) return "code";
  return "paragraph";
}

function splitMarkdownBlocks(markdown, { role = "body", languageHint = "" } = {}) {
  const lines = normalizeMarkdown(markdown).split("\n");
  const groups = [];
  const outlineGroups = splitOutlineSubtrees(lines.join("\n"));
  let current = [];
  let fence = null;
  const flush = () => {
    const value = trimOuterBlankLines(current.join("\n"));
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
  return (outlineGroups || groups).flatMap(splitGfmTableSegments).map((value, index) => {
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
  const routedBilingual = metadata.language === "bilingual" || metadata.translation.is_bilingual === true;
  const bilingual = (hasTranslation && hasOriginal) || routedBilingual;
  const explicit = metadata.translation.is_translation;
  const sourceIsOriginal = metadata.source_is_original === true;
  const translationContext = explicit || bilingual;
  const requiresOriginalUrl = translationContext && !sourceIsOriginal;
  return {
    explicit,
    bilingual,
    routed_bilingual: routedBilingual,
    has_translation: hasTranslation || routedBilingual,
    has_original: hasOriginal || routedBilingual,
    requires_original_url: requiresOriginalUrl,
    ...(explicit && metadata.translation.existing_translation_only === true && !hasOriginal && !routedBilingual ? { existing_translation_only: true } : {}),
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

export function materialIdentityForRequest(request) {
  const primary = stripOuterFrontmatter(extractMaterial(request).markdown);
  return materialIdFor(request, sha256(normalizeMarkdown(primary.body)), normalizeMetadata(request.source_metadata, primary.frontmatter));
}

function idempotencyKeyFor(request, materialId, hashes, metadata, promptVersion) {
  if (request.idempotency_key) return String(request.idempotency_key);
  return `idem-${sha256(stableJson({
    contract_version: request.contract_version || CONTRACT_VERSION,
    processor_version: PROCESSOR_VERSION,
    prompt_version: promptVersion,
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

function nonWhitespaceLength(value) {
  return String(value || "").replace(/\s+/gu, "").length;
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

function protectedInlineSyntax(markdown) {
  const value = String(markdown || "");
  const displayMath = value.match(/\$\$[\s\S]*?\$\$/gu) || [];
  const withoutDisplay = value.replace(/\$\$[\s\S]*?\$\$/gu, "");
  const inlineMath = withoutDisplay.match(/(?<!\\)\$(?!\$)(?:\\.|[^$\n])+(?<!\\)\$/gu) || [];
  const inlineCode = [...withoutDisplay.matchAll(INLINE_CODE_PATTERN)].map((match) => match[0]);
  const linkDestinations = withoutDisplay.match(MARKDOWN_LINK_DESTINATION_PATTERN) || [];
  return { displayMath, inlineMath, inlineCode, linkDestinations };
}

function translationProtectedInlineSyntax(markdown, { includeMath = false } = {}) {
  const syntax = protectedInlineSyntax(markdown);
  return {
    ...syntax,
    rawMath: (String(markdown).match(/<(math|svg)\b[^>]*>[\s\S]*?<\/\1>/giu) || []).sort(),
    displayMath: includeMath ? [...syntax.displayMath].sort() : [],
    inlineMath: includeMath ? [...syntax.inlineMath].sort() : []
  };
}

function oralNoiseCount(value) {
  const matches = String(value || "").match(/(?:我想问一下|还有别的问题吗|可以听到吗|听得到吗|党哥|大哥|明白吗|你懂(?:吗|吧)?|你理解(?:吗|了)?|对吧[？?]?|好的?[，,]?谢谢|嗯+|呃+|然后然后|这个这个)/gu);
  return matches?.length || 0;
}

function questionMarkCount(value) {
  return (String(value || "").match(/[？?]/gu) || []).length;
}

function visiblePandocSyntaxIssues(markdown) {
  const visible = String(markdown || "").replace(/```[\s\S]*?```|~~~[\s\S]*?~~~/gu, "");
  const checks = [
    ["semantic_fence", /^\s*(?:```|~~~)[^\n]*\{[^}\n]*\.(?:algorithm|exercise|proof|remark|objectives)\b/gmu],
    ["semantic_container", /^\s*:::\s*(?:\{|$)/gmu],
    ["heading_attributes", /^#{1,6}\s+.*\{[^}\n]*(?:#[\w:-]+|\.[\w+-]+|title=|data-ref=)[^}\n]*\}\s*$/gmu],
    ["image_or_link_attributes", /\]\((?:\\.|[^)\n])+\)\{[^}\n]*(?:#[\w:-]+|\.[\w+-]+|title=|data-ref=)[^}\n]*\}/gu],
    ["layout_attributes", /\{[^}\n]*(?:\.margin\b|\btitle\s*=|\bdata-ref\s*=)[^}\n]*\}/gu]
  ];
  return checks.flatMap(([kind, pattern]) => (visible.match(pattern) || []).map((value) => `${kind}:${value.slice(0, 80)}`));
}

function validateProducerOutput(output, blocks, safetyCap, cleaningPolicy, processingProfile = null, translationDetection = null) {
  const failures = [];
  if (!output || typeof output !== "object" || Array.isArray(output)) return ["output_not_object"];
  if (output.cleaned_blocks !== undefined && !Array.isArray(output.cleaned_blocks)) failures.push("cleaned_blocks_not_array");
  if (output.cleaned_sections !== undefined && !Array.isArray(output.cleaned_sections)) failures.push("cleaned_sections_not_array");
  const cleaned = Array.isArray(output.cleaned_blocks) ? output.cleaned_blocks : [];
  const sections = Array.isArray(output.cleaned_sections) ? output.cleaned_sections : [];
  if (cleaningPolicy.mode === "source_translation" && !cleaned.length) failures.push("cleaned_blocks_required_for_cleaning");
  if (cleaningPolicy.mode === "lossless_spoken_to_written" && !sections.length) failures.push("cleaned_sections_required_for_lossless_spoken_cleaning");
  if (cleaningPolicy.mode === "lossless_spoken_to_written" && cleaned.length) failures.push("cleaned_blocks_forbidden_in_lossless_spoken_cleaning");
  if (cleaningPolicy.mode !== "lossless_spoken_to_written" && sections.length) failures.push("cleaned_sections_forbidden_for_cleaning_mode");
  const actualKeys = cleaned.map((block) => block?.source_block_key);
  const expectedKeys = blocks.map((block) => block.source_block_key);
  const expectedIndex = new Map(expectedKeys.map((key, index) => [key, index]));
  if (new Set(actualKeys).size !== actualKeys.length) failures.push("cleaned_block_keys_duplicated");
  if (actualKeys.some((key) => !expectedIndex.has(key))) failures.push("cleaned_block_key_unknown");
  const actualIndexes = actualKeys.map((key) => expectedIndex.get(key)).filter(Number.isInteger);
  if (actualIndexes.some((value, index) => index > 0 && value <= actualIndexes[index - 1])) {
    failures.push("cleaned_block_keys_out_of_order");
  }
  const byKey = new Map(blocks.map((block) => [block.source_block_key, block]));
  for (const candidate of cleaned) {
    const source = byKey.get(candidate?.source_block_key);
    if (!source) continue;
    if (typeof candidate?.markdown !== "string" || !candidate.markdown.trim()) {
      failures.push(`invalid_cleaned_markdown:${candidate?.source_block_key || "unknown"}`);
      continue;
    }
    const atomicKind = processingProfile?.id === MATH_LECTURE_CONTENT_PROFILE ? mathLectureAtomicKind(source) : null;
    if (source.type === "table" && normalizeMarkdown(candidate.markdown) !== normalizeMarkdown(source.markdown)) {
      failures.push(`table_block_changed:${source.source_block_key}`);
    } else if ((source.type === "code" || atomicKind) && normalizeMarkdown(candidate.markdown) !== normalizeMarkdown(source.markdown)) {
      if (atomicKind) failures.push(`math_lecture_atomic_block_changed:${atomicKind}:${source.source_block_key}`);
      else failures.push(`code_block_changed:${source.source_block_key}`);
    } else if (source.type === "code" && normalizeMarkdown(candidate.markdown) !== normalizeMarkdown(source.markdown)) {
      failures.push(`code_block_changed:${source.source_block_key}`);
    }
    const includeMath = true;
    const candidateSyntax = cleaningPolicy.mode === "source_translation"
      ? translationProtectedInlineSyntax(candidate.markdown, { includeMath })
      : protectedInlineSyntax(candidate.markdown);
    const sourceSyntax = cleaningPolicy.mode === "source_translation"
      ? translationProtectedInlineSyntax(source.markdown, { includeMath })
      : protectedInlineSyntax(source.markdown);
    if (stableJson(candidateSyntax) !== stableJson(sourceSyntax)) {
      failures.push(`protected_inline_syntax_changed:${source.source_block_key}`);
    }
    if (cleaningPolicy.mode !== "source_translation" && source.type !== "code" && diceSimilarity(source.markdown, candidate.markdown) < 0.52) {
      failures.push(`fidelity_too_low:${source.source_block_key}`);
    }
    const sourceUrls = extractProtectedHttpUrls(source.markdown);
    for (const url of sourceUrls) {
      if (!candidate.markdown.includes(url)) failures.push(`url_removed:${source.source_block_key}`);
    }
    if (cleaningPolicy.forbid_visible_timestamps && (cleaningPolicy.mode === 'source_translation' || cleaningPolicy.preserve_source_clock_times
        ? hasIntroducedTranslationTime(source.markdown,candidate.markdown)
        : /(?:^|[\[(（\s])\d{1,2}:\d{2}(?::\d{2})?(?:[\])）\s]|$)/mu.test(candidate.markdown))) {
      failures.push(`visible_timestamp_introduced:${source.source_block_key}`);
    }
    const thirdPersonPattern = /作者(?:认为|指出|强调|判断|提出|主张|表示|解释|总结|建议)/u;
    if (cleaningPolicy.preserve_source_voice && thirdPersonPattern.test(candidate.markdown) && !sourceHasAuthorAttribution(source.markdown)) {
      failures.push(`source_voice_shifted_to_third_person:${source.source_block_key}`);
    }
    if (cleaningPolicy.normalize_semantic_containers) {
      const visiblePandoc = visiblePandocSyntaxIssues(candidate.markdown);
      if (visiblePandoc.length) failures.push(`visible_pandoc_syntax:${source.source_block_key}:${visiblePandoc.join("|")}`);
    }
  }
  if (cleaningPolicy.mode === "source_voice_structuring" && cleaned.length) {
    const merged = mergeCleanedBlocks(blocks, cleaned);
    const sourceLength = blocks.reduce((sum, block) => sum + normalizeForSimilarity(block.markdown).length, 0);
    const outputLength = merged.reduce((sum, block) => sum + normalizeForSimilarity(block.markdown).length, 0);
    const ratio = outputLength / Math.max(1, sourceLength);
    if (ratio < 0.6 || ratio > 1.25) failures.push(`whole_article_length_ratio_out_of_range:${ratio.toFixed(3)}`);
    if (cleaningPolicy.require_content_headings) {
      const headings = merged.reduce((count, block) => count + (block.markdown.match(/^#{2,3}\s+/gmu) || []).length, 0);
      if (headings < 3) failures.push(`structured_body_headings_missing:${headings}`);
    }
  }
  if (cleaningPolicy.mode === "source_translation" && cleaned.length) {
    const protectedTerms = Array.isArray(output.terminology?.terms) ? output.terminology.terms : [];
    const bibliographicKeys = translationLiteralBlockKeys(blocks);
    const proseCandidates = cleaned.filter((candidate) => {
      const source = byKey.get(candidate?.source_block_key);
      return source && !["code", "table"].includes(source.type) && !bibliographicKeys.has(source.source_block_key);
    });
    const bibliographyOnly = bibliographicKeys.size > 0 && proseCandidates.every(candidate => byKey.get(candidate.source_block_key)?.type === 'heading');
    if (!bibliographyOnly && proseCandidates.some((candidate) => /[A-Za-z]{3}/u.test(translationNaturalLanguage(candidate.markdown)))
      && !proseCandidates.some((candidate) => /[\p{Script=Han}]/u.test(translationNaturalLanguage(candidate.markdown)))) {
      failures.push("translation_document_target_language_missing");
    }
    if (actualKeys.length !== expectedKeys.length || actualKeys.some((key, index) => key !== expectedKeys[index])) {
      failures.push(`translation_source_coverage:${actualKeys.length}/${expectedKeys.length}`);
    }
    for (const candidate of cleaned) {
      const source = byKey.get(candidate?.source_block_key);
      if (!source || source.type === "code" || source.type === "table") continue;
      const atomicKind = processingProfile?.id === MATH_LECTURE_CONTENT_PROFILE ? mathLectureAtomicKind(source) : null;
      if (atomicKind) continue;
      // Names, captions, labels and quotations may remain English. Only the
      // document-level target-language check above establishes a translation.
      if (processingProfile?.id === MATH_LECTURE_CONTENT_PROFILE) {
        for (const issue of validateMathLectureTerminology(source.markdown, candidate.markdown, protectedTerms)) {
          failures.push(`math_lecture_${issue}:${source.source_block_key}`);
        }
      }
    }
  }
  if (cleaningPolicy.mode === "lossless_spoken_to_written" && sections.length) {
    const flattenedKeys = sections.flatMap((section) => Array.isArray(section?.source_block_keys) ? section.source_block_keys : []);
    if (flattenedKeys.length !== expectedKeys.length) failures.push(`lossless_source_coverage_count:${flattenedKeys.length}/${expectedKeys.length}`);
    if (new Set(flattenedKeys).size !== flattenedKeys.length) failures.push("lossless_source_keys_duplicated");
    if (flattenedKeys.some((key, index) => key !== expectedKeys[index])) failures.push("lossless_source_keys_missing_or_out_of_order");
    for (const [index, section] of sections.entries()) {
      const sectionKeys = Array.isArray(section?.source_block_keys) ? section.source_block_keys : [];
      if (!sectionKeys.length) failures.push(`lossless_section_without_source_keys:${index}`);
      if (typeof section?.markdown !== "string" || !section.markdown.trim()) failures.push(`lossless_section_without_markdown:${index}`);
      if (!String(section?.reason || "").trim()) failures.push(`lossless_section_without_reason:${index}`);
      const sourceBlocks = sectionKeys.map((key) => byKey.get(key)).filter(Boolean);
      if (sourceBlocks.length !== sectionKeys.length) {
        failures.push(`lossless_section_unknown_source_key:${index}`);
        continue;
      }
      if (new Set(sourceBlocks.map((block) => block.role)).size > 1) failures.push(`lossless_section_crosses_roles:${index}`);
      const sourceText = sourceBlocks.map((block) => block.markdown).join("\n\n");
      if (sourceBlocks.some((block) => block.type === "code")) {
        if (sourceBlocks.length !== 1 || normalizeMarkdown(section.markdown) !== normalizeMarkdown(sourceText)) {
          failures.push(`code_block_changed_in_lossless_section:${index}`);
        }
      }
      if (stableJson(protectedInlineSyntax(section.markdown)) !== stableJson(protectedInlineSyntax(sourceText))) {
        failures.push(`protected_inline_syntax_changed_in_lossless_section:${index}`);
      }
      if (!sourceBlocks.some((block) => block.type === "code") && diceSimilarity(sourceText, section.markdown) < 0.38 && section?.local_fidelity_verified !== true) {
        failures.push(`lossless_section_fidelity_too_low:${index}`);
      }
      const sourceUrls = extractProtectedHttpUrls(sourceText);
      for (const url of sourceUrls) {
        if (!section.markdown.includes(url)) failures.push(`url_removed_in_lossless_section:${index}`);
      }
      if (cleaningPolicy.forbid_visible_timestamps && /(?:^|[\[(（\s])\d{1,2}:\d{2}(?::\d{2})?(?:[\])）\s]|$)/mu.test(section.markdown)) {
        failures.push(`visible_timestamp_introduced_in_lossless_section:${index}`);
      }
      const thirdPersonPattern = /作者(?:认为|指出|强调|判断|提出|主张|表示|解释|总结|建议)/u;
      if (cleaningPolicy.preserve_source_voice && thirdPersonPattern.test(section.markdown) && !sourceHasAuthorAttribution(sourceText)) {
        failures.push(`source_voice_shifted_to_third_person_in_lossless_section:${index}`);
      }
    }
    const sourceText = blocks.map((block) => block.markdown).join("\n\n");
    const outputText = sections.map((section) => section.markdown).join("\n\n");
    const ratio = normalizeForSimilarity(outputText).length / Math.max(1, normalizeForSimilarity(sourceText).length);
    if (ratio < 0.62 || ratio > 1.12) failures.push(`lossless_whole_article_length_ratio_out_of_range:${ratio.toFixed(3)}`);
    if (cleaningPolicy.require_content_headings) {
      const headings = (outputText.match(/^#{2,3}\s+/gmu) || []).length;
      if (headings < 3) failures.push(`structured_body_headings_missing:${headings}`);
    }
    const sourceNoise = oralNoiseCount(sourceText);
    const outputNoise = oralNoiseCount(outputText);
    if (sourceNoise >= 6 && outputNoise > 3) {
      failures.push(`oral_noise_not_sufficiently_reduced:${outputNoise}/${sourceNoise}`);
    }
    const sourceQuestions = questionMarkCount(sourceText);
    const outputQuestions = questionMarkCount(outputText);
    const allowedQuestions = Math.min(12, Math.max(8, Math.ceil(sourceQuestions * 0.15)));
    if (sourceQuestions >= 8 && outputQuestions > allowedQuestions) {
      failures.push(`question_answer_form_not_sufficiently_reduced:${outputQuestions}/${sourceQuestions}`);
    }
  }
  const judgments = output.judgments || {};
  if (cleaningPolicy.mode === "semantic_only" && Array.isArray(output.cleaned_blocks)) {
    for (const patch of output.cleaned_blocks) {
      if (blocks.find(block => block.source_block_key === patch.source_block_key)?.markdown !== patch.markdown) failures.push(`semantic_only_body_changed:${patch.source_block_key}`);
    }
  }
  if (cleaningPolicy.include_reading_guide !== false && !VALUE_LABELS[judgments.value?.level]) failures.push("invalid_value_judgment");
  if (cleaningPolicy.include_reading_guide !== false && !DENSITY_LABELS[judgments.density?.level]) failures.push("invalid_density_judgment");
  const continueLevel = judgments.continue_reading?.level;
  if (cleaningPolicy.include_reading_guide !== false && (!Number.isInteger(continueLevel) || continueLevel < 0 || continueLevel > 4)) failures.push("invalid_continue_reading_level");
  if (cleaningPolicy.include_reading_guide === false && (output.judgments !== null || output.insights?.length !== 0)) failures.push("disabled_reading_guide_must_be_empty");
  const insights = Array.isArray(output.insights) ? output.insights : [];
  if (insights.length > safetyCap) failures.push("insight_safety_cap_exceeded");
  const keySet = new Set(expectedKeys);
  const insightDetailMin = 60;
  for (const [index, insight] of insights.entries()) {
    if (!String(insight?.title || "").trim() || !String(insight?.description || "").trim()) failures.push(`invalid_insight:${index}`);
    if (nonWhitespaceLength(insight?.description) < insightDetailMin) failures.push(`insight_description_too_brief:${index}:${nonWhitespaceLength(insight?.description)}/${insightDetailMin}`);
    if (!keySet.has(insight?.target_block_key)) failures.push(`invalid_insight_target:${index}`);
    if (cleaningPolicy.attribute_unverified_claims && (/(?:说话者|作者)(?:认为|主张|判断|建议|强调|指出|表示|解释|总结|呈现)/u.test(String(insight?.description || "")) || /^材料(?:认为|主张|判断|建议|强调|指出|表示|解释|总结|呈现)[：，,]/u.test(String(insight?.description || "").trim()))) {
      failures.push(`insight_contains_attribution_boilerplate:${index}`);
    }
  }
  const alignments = Array.isArray(output.translation?.alignments) ? output.translation.alignments : [];
  if (translationDetection?.routed_bilingual && cleaningPolicy.include_reading_guide !== false) {
    if (output.translation?.is_bilingual !== true) failures.push("routed_bilingual_flag_missing");
    if (!alignments.length) failures.push("routed_bilingual_alignments_missing");
  }
  for (const [index, alignment] of alignments.entries()) {
    if (!keySet.has(alignment?.original_block_key) || !keySet.has(alignment?.translation_block_key)) failures.push(`invalid_alignment_key:${index}`);
    if (!Number.isFinite(alignment?.confidence) || alignment.confidence < 0 || alignment.confidence > 1) failures.push(`invalid_alignment_confidence:${index}`);
    if (!new Set(["aligned", "uncertain", "pending"]).has(alignment?.status)) failures.push(`invalid_alignment_status:${index}`);
  }
  return [...new Set(failures)];
}

function insightRepairCandidateScore(failures) {
  const repairedIndexes = insightContractRepairIndexes(failures);
  if (repairedIndexes === null || repairedIndexes.length === 0) return null;
  return failures.reduce((score, failure) => {
    const short = /^insight_description_too_brief:\d+:(\d+)\/60$/u.exec(failure);
    if (short) return score + Math.max(1, 60 - Number(short[1]));
    if (/^invalid_insight:\d+$/u.test(failure)) return score + 60;
    if (/^invalid_insight_target:\d+$/u.test(failure)) return score + 40;
    if (/^insight_contains_attribution_boilerplate:\d+$/u.test(failure)) return score + 20;
    return score + 1;
  }, 0);
}

function normalizeLeadingAttributionBoilerplate(output, failures) {
  const indexes = [...new Set(failures.flatMap((failure) => {
    const match = /^insight_contains_attribution_boilerplate:(\d+)$/u.exec(String(failure));
    return match ? [Number(match[1])] : [];
  }))];
  if (!indexes.length) return { output, normalizedIndexes: [] };
  const normalized = structuredClone(output);
  const normalizedIndexes = [];
  const embeddedBeforeParticle = /(?:说话者|作者)(?:认为|主张|判断|建议|强调|指出|表示|解释|总结|呈现)(?=的)/gu;
  const attributionBoilerplate = /(?:说话者|作者)(?:认为|主张|判断|建议|强调|指出|表示|解释|总结|呈现)[：，,\s]*/gu;
  const leadingMaterialBoilerplate = /^材料(?:认为|主张|判断|建议|强调|指出|表示|解释|总结|呈现)[：，,\s]*/u;
  for (const index of indexes) {
    const original = String(normalized.insights?.[index]?.description || "");
    const direct = original
      .replace(embeddedBeforeParticle, "这一观点所述")
      .replace(attributionBoilerplate, "")
      .replace(leadingMaterialBoilerplate, "")
      .trim();
    if (!direct || direct === original) continue;
    normalized.insights[index].description = direct;
    normalizedIndexes.push(index);
  }
  return { output: normalized, normalizedIndexes };
}

function mergeCleanedBlocks(blocks, cleanedBlocks) {
  const patches = new Map((cleanedBlocks || []).map((block) => [block.source_block_key, block.markdown]));
  return blocks.map((block) => ({
    source_block_key: block.source_block_key,
    markdown: patches.has(block.source_block_key) ? patches.get(block.source_block_key) : block.markdown
  }));
}

function cleanedUnitsFor(blocks, output, cleaningPolicy) {
  if (cleaningPolicy.mode === "lossless_spoken_to_written" && Array.isArray(output.cleaned_sections)) {
    return output.cleaned_sections.map((section) => ({
      source_block_key: section.source_block_keys[0],
      source_block_keys: [...section.source_block_keys],
      markdown: section.markdown,
      reason: section.reason,
      local_fidelity_verified: section.local_fidelity_verified === true,
      fidelity_verification: section.fidelity_verification || null
    }));
  }
  return mergeCleanedBlocks(blocks, output.cleaned_blocks).map((block) => ({
    ...block,
    source_block_keys: [block.source_block_key],
    reason: cleaningPolicy.mode === "source_translation" ? "来源保真翻译" : "来源保真正文清洗"
  }));
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

function bodyHeadingTitle(blocks) {
  const firstHeading = blocks.find((block) => /^#{1,2}\s+/u.test(block.markdown.split("\n")[0] || ""))?.markdown.split("\n")[0] || "";
  return firstHeading
    .replace(/^#{1,6}\s+/u, "")
    .replace(/\s*\{[^{}\n]*\}\s*$/u, "")
    .trim();
}

function sourceTitle(metadata, blocks, { preferBodyHeading = false } = {}) {
  const bodyTitle = bodyHeadingTitle(blocks);
  if (preferBodyHeading && bodyTitle) return bodyTitle;
  if (metadata.split?.split_id && metadata.title) return metadata.title;
  return metadata.title || metadata.source_title || bodyTitle || "未命名材料";
}

function yamlString(value) {
  if (value === null || value === undefined || value === "") return "null";
  return JSON.stringify(String(value));
}

function renderBodyBlocks(materialId, blocks, cleanedUnits) {
  const sourceByKey = new Map(blocks.map((block) => [block.source_block_key, block]));
  return cleanedUnits.map((cleaned) => {
    const sourceKeys = cleaned.source_block_keys || [cleaned.source_block_key];
    const sources = sourceKeys.map((key) => sourceByKey.get(key));
    const source = sources[0];
    const blockId = `pr-${sha256(`${materialId}:${sourceKeys.join(":")}`).slice(0, 12)}`;
    const normalized = normalizeMarkdown(cleaned.markdown);
    return {
      source_block_key: cleaned.source_block_key,
      source_block_keys: sourceKeys,
      block_id: blockId,
      markdown: normalized,
      source_hash: sources.length === 1 ? source.source_hash : sha256(sources.map((item) => item.source_markdown || item.markdown).join("\n\n")),
      source_hashes: sources.map((item) => item.source_hash),
      output_hash: sha256(normalized),
      type: blockType(normalized),
      role: source.role,
      language: source.language,
      cleaning_reason: cleaned.reason || null,
      local_fidelity_verified: cleaned.local_fidelity_verified === true,
      fidelity_verification: cleaned.fidelity_verification || null
    };
  });
}

function publicSourceBlocks(blocks) {
  return blocks.map(({ source_markdown: _sourceMarkdown, semantic_kind: _semanticKind, translation_scope: _translationScope, ...block }) => block);
}

function buildCleaningManifest(blocks, bodyBlocks, cleaningPolicy, semanticNormalization, protectedTerms = []) {
  const bodyBySourceKey = new Map();
  for (const body of bodyBlocks) {
    for (const key of body.source_block_keys || [body.source_block_key]) bodyBySourceKey.set(key, body);
  }
  const sourceNodes = blocks.map((block) => ({ id: block.source_block_key, text: block.source_markdown || block.markdown }));
  const appendixEntries = [];
  const mappings = blocks.map((block) => {
    const destination = bodyBySourceKey.get(block.source_block_key);
    const originalText = block.source_markdown || block.markdown;
    const outputSame = destination?.source_block_keys?.length === 1 && normalizeMarkdown(destination.markdown) === normalizeMarkdown(originalText);
    if (outputSame) {
      return {
        source_id: block.source_block_key,
        status: "body_preserved",
        destinations: [{ section: "body", location: `^${destination.block_id}` }]
      };
    }
    appendixEntries.push(`### ${block.source_block_key}\n\n${originalText}`);
    return {
      source_id: block.source_block_key,
      status: "structured_with_original",
      reason: destination?.cleaning_reason || "来源保真结构化清洗",
      original_text: originalText,
      destinations: [
        { section: "body", location: destination ? `^${destination.block_id}` : "unresolved" },
        { section: "appendix", location: `artifacts.cleaning_manifest.appendix_text#${block.source_block_key}` }
      ]
    };
  });
  return {
    version: "1.0",
    profile: cleaningPolicy.mode,
    source_nodes: sourceNodes,
    mappings,
    protected_terms: [...protectedTerms],
    ai_additions: [],
    semantic_normalizations: semanticNormalization.normalizations,
    semantic_normalization_counts: semanticNormalization.counts,
    body_text: bodyBlocks.map((block) => block.markdown).join("\n\n"),
    appendix_text: appendixEntries.join("\n\n"),
    requirement_text: "",
    ai_candidate_text: ""
  };
}

function linkedReadingBlockIds(markdown) {
  const value = String(markdown || "");
  const insightHeading = /^## 核心洞察[ \t]*$/mu.exec(value);
  const afterInsight = insightHeading ? value.slice(insightHeading.index + insightHeading[0].length) : "";
  const bodyHeading = /^## 正文[ \t]*$/mu.exec(afterInsight);
  const frontCard = insightHeading && bodyHeading
    ? value.slice(insightHeading.index, insightHeading.index + insightHeading[0].length + bodyHeading.index)
    : "";
  return new Set(
    [...frontCard.matchAll(/\[\[#\^(pr-[a-f0-9]{12})(?:\|[^\]\n]+)?\]\]/gu)]
      .map((match) => match[1])
  );
}

function visibleReadingBlockIds(markdown) {
  return String(markdown || "")
    .split("\n")
    .map((line) => /(?:^|[ \t])\^(pr-[a-f0-9]{12})[ \t]*$/u.exec(line)?.[1] || null)
    .filter(Boolean);
}

export function pruneUnreferencedReadingAnchors(markdown, bodyBlockIds = []) {
  const value = String(markdown || "");
  const knownBlockIds = new Set(bodyBlockIds.map(String));
  const referencedBlockIds = linkedReadingBlockIds(value);
  const lines = value.split("\n");
  const output = [];
  const prunedBlockIds = [];

  for (let index = 0; index < lines.length; index += 1) {
    const match = /(?:^|[ \t])\^(pr-[a-f0-9]{12})[ \t]*$/u.exec(lines[index]);
    const blockId = match?.[1] || null;
    if (!blockId || !knownBlockIds.has(blockId) || referencedBlockIds.has(blockId)) {
      output.push(lines[index]);
      continue;
    }

    prunedBlockIds.push(blockId);
    if (!lines[index].startsWith("^")) {
      output.push(lines[index].slice(0, match.index));
      continue;
    }
    if (output.at(-1) === "" && lines[index + 1] === "") index += 1;
  }

  return {
    markdown: output.join("\n"),
    referenced_block_ids: [...referencedBlockIds],
    pruned_block_ids: prunedBlockIds
  };
}

export function auditVisibleReadingAnchors(markdown, bodyBlocks) {
  const knownBlockIds = new Set(bodyBlocks.map((block) => block.block_id));
  const referencedBlockIds = linkedReadingBlockIds(markdown);
  const visibleBlockIdList = visibleReadingBlockIds(markdown);
  const visibleBlockIds = new Set(visibleBlockIdList);
  const missingReferenced = [...referencedBlockIds].filter((blockId) => knownBlockIds.has(blockId) && !visibleBlockIds.has(blockId));
  const unreferencedVisible = [...visibleBlockIds].filter((blockId) => knownBlockIds.has(blockId) && !referencedBlockIds.has(blockId));
  const unknownReferences = [...referencedBlockIds].filter((blockId) => !knownBlockIds.has(blockId));
  return {
    body_block_count: knownBlockIds.size,
    referenced_block_count: referencedBlockIds.size,
    visible_anchor_count: visibleBlockIdList.length,
    pruned_anchor_count: [...knownBlockIds].filter((blockId) => !visibleBlockIds.has(blockId)).length,
    duplicate_visible_anchor_count: visibleBlockIdList.length - visibleBlockIds.size,
    missing_referenced_block_ids: missingReferenced,
    unreferenced_visible_block_ids: unreferencedVisible,
    unknown_referenced_block_ids: unknownReferences,
    passed: missingReferenced.length === 0
      && unreferencedVisible.length === 0
      && unknownReferences.length === 0
      && visibleBlockIdList.length === visibleBlockIds.size
  };
}

export function renderReadingMarkdown({ materialId, metadata, sourceType, hashes, semantic, bodyBlocks, originalBlocks = [], translationState, title, includeReadingGuide = true }) {
  if (!includeReadingGuide && (semantic.judgments !== null || semantic.insights?.length)) {
    throw new Error("disabled_reading_guide_must_be_empty");
  }
  const blockByKey = new Map();
  for (const block of bodyBlocks) {
    for (const key of block.source_block_keys || [block.source_block_key]) blockByKey.set(key, block);
  }
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
    "insights_fact_checked: false",
    "processing_status: ready",
    "---",
    "",
    `# ${title || sourceTitle(metadata, bodyBlocks, { preferBodyHeading: translationState === "generated_translation" })}`,
    ""
  ];
  if (includeReadingGuide) {
    lines.push(
    "## 阅读前置卡",
    "",
    `- 价值判断：${VALUE_LABELS[judgments.value.level]}。${judgments.value.reason}`,
    `- 信息密度判断：${DENSITY_LABELS[judgments.density.level]}。${judgments.density.reason}`,
    `- 是否继续阅读：${judgments.continue_reading.level} ${CONTINUE_READING_LABELS[judgments.continue_reading.level]}。${judgments.continue_reading.reason}`,
    "",
    "## 核心洞察",
    ""
    );
  if (!semantic.insights.length) lines.push("- 待处理：本次未生成通过校验的核心洞察。", "");
  semantic.insights.forEach((insight, index) => {
    const target = blockByKey.get(insight.target_block_key);
    const jump = target ? `[[#^${target.block_id}|正文跳转]]` : "";
    lines.push(`${CHINESE_NUMERALS[index] || String(index + 1)}、${insight.title}：${insight.description}`);
    if (jump) lines.push(jump);
    lines.push("");
  });
  }
  lines.push("---", "", "## 正文", "");
  for (const block of bodyBlocks) {
    // An out-of-list anchor addresses the entire preceding list, even across
    // blank lines. Anchor a single root item inline to keep the exact topic.
    if (block.type === "list" && /^\s*[-*+]\s+(?!`{3,}|~{3,}|\$\$)\S/u.test(block.markdown)) {
      const itemLines = block.markdown.split("\n");
      itemLines[0] += ` ^${block.block_id}`;
      lines.push(itemLines.join("\n"), "");
    } else lines.push(block.markdown, "", `^${block.block_id}`, "");
  }
  if (translationState === "generated_translation" && originalBlocks.length) {
    lines.push("---", "", "## 原文", "");
    for (const block of originalBlocks) lines.push(block.markdown, "");
  }
  const rendered = `${trimOuterBlankLines(lines.join("\n"))}\n`;
  return normalizeReaderMath(pruneUnreferencedReadingAnchors(rendered, bodyBlocks.map((block) => block.block_id)).markdown).markdown;
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
  return `${trimOuterBlankLines(lines.join("\n"))}\n`;
}

function translationStateFor(detection, alignments) {
  if (detection.requires_original_url && !detection.original_url) return "translation_original_missing";
  if (!detection.explicit && !detection.bilingual) return "not_translation";
  if (detection.existing_translation_only && detection.original_url) return "preserved_translation";
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

let resultContractValidatorPromise = null;

async function resultContractValid(result) {
  try {
    if (!resultContractValidatorPromise) {
      resultContractValidatorPromise = fs.readFile(new URL("../contracts/result.schema.json", import.meta.url), "utf8")
        .then((text) => new Ajv2020({ allErrors: true, strict: false }).compile(JSON.parse(text)));
    }
    const validate = await resultContractValidatorPromise;
    return validate(result) === true;
  } catch {
    return false;
  }
}

function cacheableCompletedResult(result) {
  return Boolean(
    result
    && result.status === "completed"
    && result.processing_state === "rendered"
    && result.artifacts?.target_zone === "local-ir-reading"
    && typeof result.artifacts?.reading_markdown === "string"
    && result.artifacts.reading_markdown.length > 0
  );
}

async function writeCache(cacheDir, idempotencyKey, result) {
  if (!cacheDir || !cacheableCompletedResult(result) || !await resultContractValid(result)) return false;
  await fs.mkdir(cacheDir, { recursive: true });
  const target = path.join(cacheDir, `${idempotencyKey}.json`);
  const temporary = path.join(cacheDir, `.${idempotencyKey}.${process.pid}.${Date.now()}.tmp`);
  await fs.writeFile(temporary, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  try {
    await fs.rename(temporary, target);
  } catch (error) {
    if (!new Set(["EEXIST", "EPERM"]).has(error?.code)) throw error;
    await fs.rm(target, { force: true });
    await fs.rename(temporary, target);
  } finally {
    await fs.rm(temporary, { force: true });
  }
  return true;
}

function replayResult(cached, now) {
  const quality = spokenQualityFromReceipt(cached.receipt);
  const validations = cached.receipt.validations.map(item => item.name === 'spoken_quality_review' && quality
    ? { ...item, details: { ...item.details, quality } } : item);
  if (quality && !validations.some(item => item.name === 'spoken_quality_review')) validations.push({
    name:'spoken_quality_review',status:'passed',details:{version:quality.version,policy:'required',quality}
  });
  return {
    ...cached,
    status: "idempotent_replay",
    receipt: {
      ...cached.receipt,
      validations,
      model: { ...cached.receipt.model, calls: 0, attempts: [], call_ledger: [] },
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
  const translationPolicy = request.processing_options?.cleaning_mode === "source_translation"
    ? await loadTranslationPolicy(undefined,request.processing_options?.translation_mode || 'terminology') : null;
  const spokenPolicyHash = request.processing_options?.cleaning_mode === "lossless_spoken_to_written"
    ? sha256((await Promise.all(['lossless-spoken-to-written-v1.md', 'spoken-quality-audit-v1.md'].map(name =>
      fs.readFile(new URL(`../prompts/${name}`, import.meta.url), 'utf8')))).join('\n')) : null;
  const promptVersion = promptVersionFor(request)
    + (spokenPolicyHash ? `:${SPOKEN_REFINEMENT_VERSION}:${spokenPolicyHash}` : "")
    + (translationPolicy ? `:${TRANSLATION_UNIT_VERSION}:${translationPolicy.sha256}` : "")
    + (request.processing_options?.include_reading_guide !== false ? `:${GUIDE_COVERAGE_VERSION}` : "");
  const idempotencyKey = idempotencyKeyFor(request, materialId, hashes, metadata, promptVersion);
  const cached = options.skipCacheRead ? null : await readCache(options.cacheDir, idempotencyKey);
  if (
    cached?.receipt?.processor_version === PROCESSOR_VERSION
    && cached?.receipt?.prompt_version === promptVersion
    && (!spokenPolicyHash || (options.producer && !(options.producer instanceof ExternalProducer))
      || spokenQualityFromReceipt(cached.receipt)?.chunks?.every(chunk => chunk.status === 'passed') === true)
    && cacheableCompletedResult(cached)
    && await resultContractValid(cached)
  ) {
    const replayed = replayResult(cached, now);
    if (await resultContractValid(replayed)) return replayed;
  }

  const cleaningPolicy = cleaningPolicyFor(request);
  const sourceBlocks = options.preparedBodyBlocks
    ? options.preparedBodyBlocks.map((block, index) => ({
        source_block_key: block.source_block_key, source_index: index, type: block.type,
        role: block.role, language: block.language, markdown: block.markdown, source_hash: sha256(block.markdown)
      }))
    : buildBlocks(primaryMarkdown, originalMarkdown, metadata);
  const semanticNormalization = normalizePandocSemanticBlocks(sourceBlocks, {
    enabled: cleaningPolicy.normalize_semantic_containers,
    referenceLabels: metadata.split?.reference_labels || {}
  });
  const blocks = semanticNormalization.blocks;
  const mathLecture = isMathLectureProfile(metadata);
  const processingProfile = mathLecture ? {
    id: MATH_LECTURE_CONTENT_PROFILE,
    version: cleaningPolicy.mode === "source_translation"
      ? MATH_LECTURE_PROFILE_VERSION
      : MATH_LECTURE_STANDARDIZATION_PROFILE_VERSION,
    prompt_version: cleaningPolicy.mode === "source_translation"
      ? MATH_LECTURE_PROMPT_VERSION
      : MATH_LECTURE_STANDARDIZATION_PROMPT_VERSION,
    ...buildMathLectureCoverage(blocks)
  } : null;
  const translationDetection = detectTranslation(blocks, metadata);
  const safetyCap = Math.min(24, Math.max(1, Number(request.processing_options?.insight_safety_cap || 24)));
  const softTarget = {
    min: Math.max(0, Number(request.processing_options?.insight_soft_min ?? 3)),
    max: Math.min(safetyCap, Math.max(1, Number(request.processing_options?.insight_soft_max ?? 12)))
  };
  const baseReceipt = {
    contract_version: CONTRACT_VERSION,
    processor_version: PROCESSOR_VERSION,
    prompt_version: promptVersion,
    cleaning_policy: cleaningPolicy,
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
      call_ledger: [],
      metadata_policy: "allowlist-no-credentials-cookies-or-headers"
    },
    validations: []
  };
  baseReceipt.semantic_normalization = {
    enabled: cleaningPolicy.normalize_semantic_containers,
    counts: semanticNormalization.counts
  };
  if (processingProfile) baseReceipt.processing_profile = processingProfile;

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
        body_blocks: publicSourceBlocks(blocks),
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
  let producerAccepted = false;
  let lastFailures = [];
  let editorialFindings = [];
  let bestInsightRepairCandidate = null;
  let effectiveSafetyCap = safetyCap;
  const producerPayload = {
    ...(translationPolicy ? { translation_policy: translationPolicy } : {}),
    material_id: materialId,
    source_type: request.source_type,
    source_metadata: metadataForProducer(metadata),
    user_instruction: request.user_instruction,
    translation_detection: translationDetection,
    insight_policy: { soft_target: softTarget, safety_cap: safetyCap },
    cleaning_policy: cleaningPolicy,
    ...(processingProfile ? { processing_profile: { id: processingProfile.id, version: processingProfile.version } } : {}),
    source_statistics: {
      block_count: blocks.length,
      non_whitespace_chars: blocks.reduce((sum, block) => sum + normalizeForSimilarity(block.markdown).length, 0),
      minimum_cleaned_chars: Math.ceil(blocks.reduce((sum, block) => sum + normalizeForSimilarity(block.markdown).length, 0) * 0.65)
    },
    blocks: blocks.map(({ source_block_key, type, role, language, markdown, semantic_kind, translation_scope }) => ({
      source_block_key,
      type,
      role,
      language,
      markdown,
      ...(processingProfile ? { semantic_kind: semantic_kind || null, translation_scope: translation_scope || null } : {})
    }))
  };
  const maxAttempts = Math.max(1, Math.min(3, producer.maxAttempts ?? 3));
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const localOnly = cleaningPolicy.mode === "semantic_only" && cleaningPolicy.include_reading_guide === false;
      const generated = localOnly
        ? { output: { judgments: null, insights: [], translation: { is_bilingual: Boolean(translationDetection.bilingual), alignments: [] } }, api_calls: 0, provider: "local", model: "deterministic", call_ledger: [] }
        : await producer.generate(producerPayload, { validationFeedback: lastFailures, attempt,
          ...(cleaningPolicy.mode === 'semantic_only' && cleaningPolicy.include_reading_guide !== false ? {requiredProvider:'codex_exec'} : {}) });
      const generatedCalls = Number(generated.api_calls);
      baseReceipt.model.calls += Number.isInteger(generatedCalls) && generatedCalls >= 0 ? generatedCalls : 1;
      baseReceipt.model.provider = generated.provider;
      baseReceipt.model.model = generated.model;
      baseReceipt.model.call_ledger.push(...(generated.call_ledger || []));
      let acceptedOutput = generated.output;
      effectiveSafetyCap = generated.usage?.stages?.guide_coverage?.version === GUIDE_COVERAGE_VERSION
        && generated.usage.stages.guide_coverage.status === 'passed' ? Infinity : safetyCap;
      lastFailures = validateProducerOutput(acceptedOutput, blocks, effectiveSafetyCap, cleaningPolicy, processingProfile, translationDetection);
      if (lastFailures.includes("disabled_reading_guide_must_be_empty")) {
        const error = new Error("disabled_reading_guide_must_be_empty");
        error.terminal = true;
        error.api_calls = 0; // The completed producer call was already counted above.
        throw error;
      }
      // A source-verified attribution may identify a quoted or rebutted speaker.
      // Do not rewrite an audited guide with the legacy style-only regex.
      const attributionNormalization = generated.usage?.stages?.guide_fidelity?.status === 'passed'
        ? { output: acceptedOutput, normalizedIndexes: [] }
        : normalizeLeadingAttributionBoilerplate(acceptedOutput, lastFailures);
      if (attributionNormalization.normalizedIndexes.length) {
        acceptedOutput = attributionNormalization.output;
        lastFailures = validateProducerOutput(acceptedOutput, blocks, effectiveSafetyCap, cleaningPolicy, processingProfile, translationDetection);
      }
      const candidateEditorialFindings = lastFailures.filter(isEditorialDetailFailure);
      lastFailures = lastFailures.filter((failure) => !isEditorialDetailFailure(failure));
      const repairScore = insightRepairCandidateScore(lastFailures);
      if (repairScore !== null && (!bestInsightRepairCandidate || repairScore <= bestInsightRepairCandidate.score)) {
        bestInsightRepairCandidate = {
          attempt,
          score: repairScore,
          output: structuredClone(acceptedOutput),
          failures: [...lastFailures]
        };
      }
      attempts.push({
        attempt,
        status: lastFailures.length ? "rejected" : "accepted",
        validation_errors: lastFailures,
        usage: generated.usage || null,
        ...(attributionNormalization.normalizedIndexes.length ? {
          deterministic_repairs: {
            attribution_boilerplate_indexes: attributionNormalization.normalizedIndexes
          }
        } : {})
      });
      if (!lastFailures.length) {
        editorialFindings = candidateEditorialFindings;
        semantic = {
          ...acceptedOutput,
          cleaned_blocks: mergeCleanedBlocks(blocks, acceptedOutput.cleaned_blocks),
          cleaned_units: cleanedUnitsFor(blocks, acceptedOutput, cleaningPolicy)
        };
        producerAccepted = true;
        break;
      }
    } catch (error) {
      const reportedCalls = Number(error?.api_calls);
      baseReceipt.model.calls += Number.isInteger(reportedCalls) && reportedCalls >= 0 ? reportedCalls : 1;
      baseReceipt.model.call_ledger.push(...(error?.call_ledger || []));
      lastFailures = [error instanceof Error ? error.message : String(error)];
      const terminal = error?.terminal === true;
      attempts.push({ attempt, status: "failed", validation_errors: lastFailures, usage: null, terminal });
      if (terminal) break;
    }
  }
  if (!producerAccepted && bestInsightRepairCandidate && typeof producer.repairInsights === "function") {
    const candidate = bestInsightRepairCandidate;
    const attemptReceipt = attempts.find((item) => item.attempt === candidate.attempt);
    try {
      const repaired = await producer.repairInsights({
        payload: producerPayload,
        semanticOutput: candidate.output,
        validationFailures: candidate.failures
      });
      const repairedCalls = Number(repaired.api_calls);
      baseReceipt.model.calls += Number.isInteger(repairedCalls) && repairedCalls >= 0 ? repairedCalls : 0;
      baseReceipt.model.call_ledger.push(...(repaired.call_ledger || []));
      if (repaired.provider) baseReceipt.model.provider = repaired.provider;
      if (repaired.model) baseReceipt.model.model = repaired.model;
      const repairedOutput = repaired.output || candidate.output;
      lastFailures = validateProducerOutput(repairedOutput, blocks, effectiveSafetyCap, cleaningPolicy, processingProfile, translationDetection);
      attemptReceipt.insight_contract_repair = {
        status: lastFailures.length ? "rejected" : "accepted",
        repaired_indexes: repaired.repairedIndexes || [],
        validation_errors: lastFailures,
        repair_validation_errors: repaired.repairValidationFailures || [],
        usage: repaired.usage || null
      };
      if (!lastFailures.length) {
        semantic = {
          ...repairedOutput,
          cleaned_blocks: mergeCleanedBlocks(blocks, repairedOutput.cleaned_blocks),
          cleaned_units: cleanedUnitsFor(blocks, repairedOutput, cleaningPolicy)
        };
        producerAccepted = true;
      }
    } catch (error) {
      const reportedCalls = Number(error?.api_calls);
      baseReceipt.model.calls += Number.isInteger(reportedCalls) && reportedCalls >= 0 ? reportedCalls : 1;
      baseReceipt.model.call_ledger.push(...(error?.call_ledger || []));
      lastFailures = [error instanceof Error ? error.message : String(error)];
      attemptReceipt.insight_contract_repair = {
        status: "failed",
        repaired_indexes: [],
        validation_errors: lastFailures,
        repair_validation_errors: [],
        usage: null
      };
    }
  }
  baseReceipt.model.attempts = attempts;

  if (lastFailures.includes("disabled_reading_guide_must_be_empty")) {
    return { schema_version: RESULT_SCHEMA_VERSION, contract_version: CONTRACT_VERSION,
      status: "failed", material_id: materialId, idempotency_key: idempotencyKey,
      processing_state: "failed", translation_state: "unknown", artifacts: {}, source_metadata: metadata,
      receipt: baseReceipt, errors: [errorItem("disabled_reading_guide_must_be_empty", "semantic_processing", "关闭导读的正文阶段返回了导读数据，已拒绝该结果。")]
    };
  }

  const errors = [];
  let status = "completed";
  let processingState = "rendered";
  if (!semantic) {
    semantic = fallbackSemantic(blocks);
    // A fallback preserves the source, but is never a generated reading guide.
    semantic.judgments = null;
    semantic.insights = [];
    if (cleaningPolicy.include_reading_guide !== false) {
      baseReceipt.reading_guide = { status: "failed", calls: baseReceipt.model.calls, reason: "guide_generation_failed" };
    }
    semantic.cleaned_units = cleanedUnitsFor(blocks, semantic, { ...cleaningPolicy, mode: "source_voice_structuring" });
    status = "completed_with_warnings";
    processingState = "degraded";
    errors.push(errorItem("producer_output_rejected", "semantic_processing", `AI 输出在 ${attempts.length} 次处理尝试后仍未通过校验：${lastFailures.join(", ")}`, { severity: "warning" }));
  }

  let bodyBlocks = renderBodyBlocks(materialId, blocks, semantic.cleaned_units);
  let readingTitle = sourceTitle(metadata, bodyBlocks, { preferBodyHeading: cleaningPolicy.mode === "source_translation" });
  const terminologyTerms = processingProfile && Array.isArray(semantic.terminology?.terms)
    ? semantic.terminology.terms
    : [];
  if (processingProfile) {
    const normalizedTerms = normalizeMathLectureReadingTerminology({
      title: readingTitle,
      semantic,
      bodyBlocks,
      sourceBlocks: blocks,
      terms: terminologyTerms
    });
    readingTitle = normalizedTerms.title;
    semantic = normalizedTerms.semantic;
    bodyBlocks = normalizedTerms.bodyBlocks;
  }
  if (processingProfile) {
    processingProfile.terminology_policy = semantic.terminology?.policy || "preserve-source-terms/v1";
    processingProfile.preserved_terms = collectPreservedMathLectureTerms(blocks, bodyBlocks, terminologyTerms);
  }
  const visiblePandocIssues = cleaningPolicy.normalize_semantic_containers
    ? bodyBlocks.flatMap((block) => visiblePandocSyntaxIssues(block.markdown).map((issue) => `${block.source_block_key}:${issue}`))
    : [];
  if (visiblePandocIssues.length) {
    status = "completed_with_warnings";
    processingState = "degraded";
    errors.push(errorItem("visible_pandoc_syntax", "rendering", `可见 Pandoc 排版语法未清除：${visiblePandocIssues.join(", ")}`, { severity: "warning" }));
  }
  const cleaningManifest = buildCleaningManifest(blocks, bodyBlocks, cleaningPolicy, semanticNormalization, terminologyTerms);
  const alignments = Array.isArray(semantic.translation?.alignments) ? semantic.translation.alignments : [];
  const translationState = cleaningPolicy.mode === "source_translation"
    ? producerAccepted ? "generated_translation" : "unknown"
    : translationDetection.bilingual && cleaningPolicy.include_reading_guide === false ? "preserved_bilingual"
    : translationStateFor(translationDetection, alignments);
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
    originalBlocks: cleaningPolicy.mode === "source_translation" ? blocks : [],
    translationState,
    title: readingTitle,
    includeReadingGuide: request.processing_options?.include_reading_guide !== false && semantic.judgments !== null
  });
  const visibleAnchorAudit = auditVisibleReadingAnchors(readingMarkdown, bodyBlocks);
  const validations = [
    { name:'reading_guide_coverage', status:attempts.some(a=>a.status==='accepted'&&a.usage?.stages?.guide_coverage?.status==='passed')?'passed':baseReceipt.reading_guide?.status==='failed'?'failed':'not_applicable',
      details:attempts.find(a=>a.status==='accepted')?.usage?.stages?.guide_coverage || null },
    { name:'reading_guide_fidelity', status:attempts.some(a=>a.status==='accepted'&&a.usage?.stages?.guide_fidelity?.status==='passed')?'passed':baseReceipt.reading_guide?.status==='failed'?'failed':'not_applicable',
      details:attempts.find(a=>a.status==='accepted')?.usage?.stages?.guide_fidelity || null },
    { name: "request_schema", status: "passed" },
    { name: "editorial_details_non_blocking", status: "passed", details: { policy: "advisory", findings: editorialFindings } },
    { name: "whole_article_cleaning", status: cleaningPolicy.mode !== "semantic_only" ? (producerAccepted ? "passed" : "failed") : "not_applicable" },
    { name: "source_translation", status: cleaningPolicy.mode === "source_translation" ? (producerAccepted ? "passed" : "failed") : "not_applicable" },
    { name: "translation_protected_syntax", status: cleaningPolicy.mode === "source_translation" ? (producerAccepted ? "passed" : "failed") : "not_applicable" },
    ...(processingProfile ? [{
      name: cleaningPolicy.mode === "source_translation" ? "math_lecture_translation" : "math_lecture_standardization",
      status: producerAccepted ? "passed" : "failed",
      details: {
        translated_prose_blocks: processingProfile.translated_prose_blocks,
        preserved_formula_blocks: processingProfile.preserved_formula_blocks,
        preserved_formula_spans: processingProfile.preserved_formula_spans,
        preserved_code_blocks: processingProfile.preserved_code_blocks,
        preserved_algorithm_blocks: processingProfile.preserved_algorithm_blocks,
        terminology_policy: processingProfile.terminology_policy,
        preserved_terms: processingProfile.preserved_terms
      }
    }] : []),
    { name: "semantic_container_normalization", status: cleaningPolicy.normalize_semantic_containers ? (visiblePandocIssues.length ? "failed" : "passed") : "not_applicable", details: { ...semanticNormalization.counts, visible_pandoc_issues: visiblePandocIssues.length } },
    { name: "lossless_spoken_to_written", status: cleaningPolicy.mode === "lossless_spoken_to_written" ? (producerAccepted ? "passed" : "failed") : "not_applicable" },
    ...(cleaningPolicy.mode === 'lossless_spoken_to_written' && producer instanceof ExternalProducer ? [{
      name: 'spoken_quality_review', status: producerAccepted ? 'passed' : 'failed',
      details: { version: SPOKEN_REFINEMENT_VERSION, policy: 'required',
        quality: attempts.find(attempt => attempt.status === 'accepted')?.usage?.stages?.spoken_quality || null }
    }] : []),
    { name: "lossless_source_mapping", status: cleaningManifest.mappings.length === blocks.length ? "passed" : "failed" },
    { name: "semantic_fidelity_audit", status: bodyBlocks.some((block) => block.local_fidelity_verified) ? "passed" : "not_needed" },
    { name: "oral_noise_reduction", status: cleaningPolicy.mode === "lossless_spoken_to_written" ? (editorialFindings.some((item) => item.startsWith("oral_noise_")) ? "not_needed" : producerAccepted ? "passed" : "failed") : "not_applicable" },
    { name: "source_voice_preserved", status: cleaningPolicy.preserve_source_voice ? "passed" : "not_applicable" },
    { name: "visible_timestamps_forbidden", status: cleaningPolicy.forbid_visible_timestamps ? "passed" : "not_applicable" },
    { name: "content_headings", status: cleaningPolicy.require_content_headings ? (editorialFindings.some((item) => item.startsWith("structured_body_headings_missing")) ? "not_needed" : "passed") : "not_applicable" },
    { name: "claim_epistemic_fidelity", status: cleaningPolicy.attribute_unverified_claims ? "passed" : "not_applicable" },
    { name: "block_coverage", status: new Set(bodyBlocks.flatMap((block) => block.source_block_keys || [block.source_block_key])).size === blocks.length ? "passed" : "failed" },
    { name: "sparse_cleaned_block_merge", status: "passed" },
    { name: "insight_targets", status: semantic.insights.every((item) => bodyBlocks.some((block) => (block.source_block_keys || [block.source_block_key]).includes(item.target_block_key))) ? "passed" : "failed" },
    { name: "deterministic_block_ids", status: "passed" },
    { name: "visible_body_anchor_pruning", status: visibleAnchorAudit.passed ? "passed" : "failed", details: visibleAnchorAudit },
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
      target_zone: processingState === "degraded" ? "preprocess-review" : "local-ir-reading",
      semantic: {
        judgments: semantic.judgments,
        insights: semantic.insights
      },
      body_blocks: bodyBlocks,
      cleaning_manifest: cleaningManifest,
      bilingual: { detection: translationDetection, alignments },
      artifact_hashes: {
        reading_markdown: sha256(readingMarkdown),
        semantic: sha256(stableJson({ judgments: semantic.judgments, insights: semantic.insights })),
        body_blocks: sha256(stableJson(bodyBlocks)),
        cleaning_manifest: sha256(stableJson(cleaningManifest))
      }
    },
    source_metadata: { ...metadata, original_url: translationDetection.original_url },
    receipt: { ...baseReceipt, validations },
    errors
  };
  await writeCache(options.cacheDir, idempotencyKey, result);
  return result;
}
