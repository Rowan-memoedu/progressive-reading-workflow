import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import {
  CONTRACT_VERSION,
  PROCESSOR_VERSION,
  PROMPT_VERSION,
  REQUEST_SCHEMA_VERSION,
  RESULT_SCHEMA_VERSION,
  materialIdentityForRequest,
  processMaterial,
  renderReadingMarkdown,
  sha256,
  stableJson,
  validateRequest
} from "./lib/core.mjs";
import {
  diagnoseProducerConfig,
  ExternalProducer,
  WORKFLOW_ROUTER_PROMPT_VERSION,
  WORKFLOW_ROUTER_VERSION
} from "./lib/producer.mjs";
import { buildSplitManifest, buildSplitRequest, SPLIT_MANIFEST_VERSION, SPLIT_POLICY_VERSION } from "./lib/splitter.mjs";
import { requiredRouteLabels, resolveProcessingPlan, ROUTE_VALUES, WORKFLOW_PLAN_VERSION } from "./lib/workflow-plan.mjs";
import { requiredArtifactFailures } from "./lib/required-artifacts.mjs";
import { foldPublishedOriginal } from "./lib/original-section.mjs";
import { simplifyPublishedChinese } from "./lib/chinese-script.mjs";
import { normalizeReaderMath } from "./lib/reader-math.mjs";
import { GUIDE_COVERAGE_VERSION } from './lib/guide-coverage.mjs';

export { buildSplitManifest, buildSplitRequest, SPLIT_MANIFEST_VERSION, SPLIT_POLICY_VERSION };

export const CALLABLE_INTERFACE_VERSION = "1.3.0";

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const schemaDir = path.join(moduleDir, "contracts");
let validatorsPromise = null;

export class PreprocessInterfaceError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.name = "PreprocessInterfaceError";
    this.code = code;
    this.details = details;
  }
}

function ajvErrors(errors = []) {
  return (errors || []).map((error) => ({
    instance_path: error.instancePath || "",
    schema_path: error.schemaPath || "",
    keyword: error.keyword,
    message: error.message || "schema validation failed",
    params: error.params || {}
  }));
}

async function contractValidators() {
  if (!validatorsPromise) {
    validatorsPromise = (async () => {
      const [requestText, resultText, splitManifestText] = await Promise.all([
        fs.readFile(path.join(schemaDir, "request.schema.json"), "utf8"),
        fs.readFile(path.join(schemaDir, "result.schema.json"), "utf8"),
        fs.readFile(path.join(schemaDir, "split-manifest.schema.json"), "utf8")
      ]);
      const ajv = new Ajv2020({ allErrors: true, strict: false });
      return {
        request: ajv.compile(JSON.parse(requestText)),
        result: ajv.compile(JSON.parse(resultText)),
        splitManifest: ajv.compile(JSON.parse(splitManifestText))
      };
    })();
  }
  return validatorsPromise;
}

export function defaultPreprocessHome() {
  return path.resolve(process.env.PR_PREPROCESS_HOME || path.join(os.homedir(), ".pr-preprocess"));
}

export function standardMarkdownOptions(overrides = {}) {
  return {
    cleaning_mode: "source_voice_structuring",
    preserve_source_voice: true,
    attribute_unverified_claims: true,
    normalize_semantic_containers: true,
    insight_soft_min: 3,
    insight_soft_max: 12,
    insight_safety_cap: 24,
    ...overrides
  };
}

export function spokenMarkdownOptions(overrides = {}) {
  return {
    cleaning_mode: "lossless_spoken_to_written",
    preserve_source_voice: true,
    forbid_visible_timestamps: true,
    require_content_headings: true,
    attribute_unverified_claims: true,
    normalize_semantic_containers: true,
    insight_soft_min: 3,
    insight_soft_max: 12,
    insight_safety_cap: 24,
    ...overrides
  };
}

export function sourceTranslationOptions(overrides = {}) {
  return {
    cleaning_mode: "source_translation",
    translation_target_language: "zh-CN",
    preserve_source_voice: true,
    forbid_visible_timestamps: true,
    attribute_unverified_claims: true,
    normalize_semantic_containers: true,
    insight_soft_min: 3,
    insight_soft_max: 12,
    insight_safety_cap: 24,
    ...overrides
  };
}

export function mathLectureTranslationOptions(overrides = {}) {
  return {
    cleaning_mode: "source_translation",
    translation_target_language: "zh-CN",
    preserve_source_voice: true,
    forbid_visible_timestamps: true,
    attribute_unverified_claims: true,
    normalize_semantic_containers: true,
    insight_soft_min: 3,
    insight_soft_max: 12,
    insight_safety_cap: 24,
    ...overrides
  };
}

export function mathLectureStandardizationOptions(overrides = {}) {
  return standardMarkdownOptions(overrides);
}

export function standardWorkflowOptions(overrides = {}) {
  return {
    workflow_mode: "standard",
    input_form: "auto",
    content_profile: "auto",
    source_language: "auto",
    original_placement: "after_translation",
    preserve_source_voice: true,
    forbid_visible_timestamps: true,
    attribute_unverified_claims: true,
    normalize_semantic_containers: true,
    insight_soft_min: 3,
    insight_soft_max: 12,
    insight_safety_cap: 24,
    ...overrides
  };
}

export function buildPreprocessRequest({
  markdown,
  originalMarkdown = "",
  materialId,
  idempotencyKey,
  sourceType,
  sourceMetadata = {},
  userInstruction = "",
  processingOptions = standardWorkflowOptions()
}) {
  const request = {
    schema_version: REQUEST_SCHEMA_VERSION,
    contract_version: CONTRACT_VERSION,
    material: {
      markdown: String(markdown || ""),
      ...(originalMarkdown ? { original_markdown: String(originalMarkdown) } : {})
    },
    source_type: String(sourceType || ""),
    source_metadata: structuredClone(sourceMetadata || {}),
    user_instruction: String(userInstruction || ""),
    processing_options: structuredClone(processingOptions || {})
  };
  if (materialId) request.material_id = String(materialId);
  if (idempotencyKey) request.idempotency_key = String(idempotencyKey);
  return request;
}

function requestMarkdown(request) {
  if (typeof request?.material === "string") return request.material;
  if (request?.material && typeof request.material === "object") return request.material.markdown || "";
  return request?.input || "";
}

function normalizeInputForm(value) {
  return new Set(["spoken_transcript", "written"]).has(value) ? value : null;
}

function normalizeContentProfile(value) {
  return ROUTE_VALUES.content_profile.includes(value) ? value : null;
}

function normalizeSourceLanguage(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (!normalized || normalized === "auto") return null;
  if (new Set(["bilingual", "multilingual", "mixed", "双语"]).has(normalized)) return "bilingual";
  if (normalized === "zh" || normalized.startsWith("zh-")) return "zh";
  if (normalized === "en" || normalized.startsWith("en-")) return "en";
  if (normalized === "other" || normalized === "und") return "other";
  return null;
}

function fixedWorkflowLabels(request) {
  const options = request?.processing_options || {};
  const metadata = request?.source_metadata || {};
  const optionInput = normalizeInputForm(options.input_form);
  const metadataInput = normalizeInputForm(metadata.input_form);
  const optionProfile = normalizeContentProfile(options.content_profile);
  const metadataProfile = normalizeContentProfile(metadata.content_profile);
  const optionLanguage = normalizeSourceLanguage(options.source_language);
  const metadataLanguage = metadata.translation?.is_bilingual === true
    ? "bilingual"
    : normalizeSourceLanguage(metadata.language);
  return {
    values: {
      input_form: optionInput || metadataInput,
      content_profile: optionProfile || metadataProfile,
      source_language: optionLanguage || metadataLanguage
    },
    methods: {
      input_form: optionInput ? "request_override" : metadataInput ? "source_metadata" : null,
      content_profile: optionProfile ? "request_override" : metadataProfile ? "source_metadata" : null,
      source_language: optionLanguage ? "request_override" : metadataLanguage ? "source_metadata" : null
    }
  };
}

export async function classifyPreprocessWorkflow(request, { producer = null, markdown = requestMarkdown(request), cacheDir = false } = {}) {
  const fixed = fixedWorkflowLabels(request);
  const options = request.processing_options || {};
  const missing = requiredRouteLabels(options, fixed.values);
  let classified = null;
  if (missing.length) {
    if (!producer?.classifyWorkflow) {
      throw new PreprocessInterfaceError(
        "workflow_router_unavailable",
        "unmarked material requires an external AI workflow classifier",
        { missing_labels: missing }
      );
    }
    try {
      const routeCache = cacheDir ? path.join(cacheDir, "routing", `${sha256(stableJson({ markdown, fixed: fixed.values, missing, version: WORKFLOW_ROUTER_PROMPT_VERSION }))}.json`) : null;
      const cached = routeCache ? await fs.readFile(routeCache, "utf8").then(JSON.parse).catch(() => null) : null;
      if (cached && Number(cached.output?.confidence) >= 0.6 && missing.every(key => ROUTE_VALUES[key].includes(cached.output?.[key]))) {
        classified = { ...cached, api_calls: 0, attempts: [], call_ledger: [], cache_hit: true };
      } else {
        classified = await producer.classifyWorkflow({ markdown, fixed_labels: fixed.values, required_labels: missing });
        if (routeCache && !classified.needs_classification && Number(classified.output?.confidence) >= 0.6 && missing.every(key => ROUTE_VALUES[key].includes(classified.output?.[key]))) await writeJsonArtifact(routeCache, classified);
      }
    } catch (error) {
      throw new PreprocessInterfaceError(
        "workflow_routing_failed",
        error instanceof Error ? error.message : String(error),
        { missing_labels: missing, api_calls: Number(error?.api_calls || 0) }
      );
    }
  }
  const output = classified?.output || fixed.values;
  const insufficient = classified?.needs_classification || (classified && Number(output.confidence) < 0.6);
  const unresolved = missing.filter(key => insufficient || !ROUTE_VALUES[key].includes(output[key]));
  const decision = (key) => fixed.values[key]
    ? { value: fixed.values[key], method: fixed.methods[key], evidence: {} }
    : !missing.includes(key) ? { value: "not_needed", method: "not_needed", evidence: {} }
    : {
        value: unresolved.includes(key) ? "unresolved" : output[key],
        method: WORKFLOW_ROUTER_VERSION,
        evidence: { confidence: output.confidence, reason: output.reason }
      };
  const inputForm = decision("input_form");
  const contentProfile = decision("content_profile");
  const sourceLanguage = decision("source_language");
  const labels = { input_form: inputForm.value, content_profile: contentProfile.value, source_language: sourceLanguage.value };
  const plan = unresolved.length ? null : resolveProcessingPlan(options, labels);
  return {
    version: "progressive-reading.workflow-route/v1",
    input_form: inputForm,
    content_profile: contentProfile,
    source_language: sourceLanguage,
    translation_required: plan?.choices.translate.enabled ?? false,
    plan,
    needs_classification: unresolved.length > 0,
    missing_labels: unresolved,
    classification_reason: unresolved.length ? String(output.reason || "无法根据现有信息确定处理方案，请补充分类或直接指定处理选择。") : null,
    original_placement: "after_translation",
    classifier: classified
      ? {
          version: WORKFLOW_ROUTER_VERSION,
          prompt_version: WORKFLOW_ROUTER_PROMPT_VERSION,
          skipped: false,
          provider: classified.provider,
          model: classified.model,
          calls: classified.api_calls,
          attempts: classified.attempts,
          call_ledger: classified.call_ledger
        }
      : {
          version: WORKFLOW_ROUTER_VERSION,
          prompt_version: WORKFLOW_ROUTER_PROMPT_VERSION,
          skipped: true,
          reason: "all_required_choices_or_labels_supplied",
          calls: 0,
          attempts: [],
          call_ledger: []
        }
  };
}

export async function validateRequestContract(request) {
  const validators = await contractValidators();
  const schemaValid = validators.request(request);
  const runtimeErrors = validateRequest(request);
  return {
    valid: Boolean(schemaValid) && runtimeErrors.length === 0,
    schema: {
      version: REQUEST_SCHEMA_VERSION,
      valid: Boolean(schemaValid),
      errors: ajvErrors(validators.request.errors)
    },
    runtime: {
      valid: runtimeErrors.length === 0,
      errors: runtimeErrors
    }
  };
}

export async function validateSplitManifestContract(manifest) {
  const validators = await contractValidators();
  const valid = validators.splitManifest(manifest);
  return {
    valid: Boolean(valid),
    schema: {
      version: SPLIT_MANIFEST_VERSION,
      valid: Boolean(valid),
      errors: ajvErrors(validators.splitManifest.errors)
    }
  };
}

export async function validateResultContract(result) {
  const validators = await contractValidators();
  const valid = validators.result(result);
  return {
    valid: Boolean(valid),
    schema: {
      version: RESULT_SCHEMA_VERSION,
      valid: Boolean(valid),
      errors: ajvErrors(validators.result.errors)
    }
  };
}

async function replaceFileAtomic(target, content) {
  const directory = path.dirname(target);
  await fs.mkdir(directory, { recursive: true });
  const temporary = path.join(directory, `.${path.basename(target)}.${process.pid}.${crypto.randomUUID()}.tmp`);
  await fs.writeFile(temporary, content);
  try {
    await fs.rename(temporary, target);
  } catch (error) {
    if (!new Set(["EEXIST", "EPERM"]).has(error?.code)) throw error;
    await fs.rm(target, { force: true });
    await fs.rename(temporary, target);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

export async function writeJsonArtifact(target, value) {
  const resolved = path.resolve(target);
  await replaceFileAtomic(resolved, `${JSON.stringify(value, null, 2)}\n`);
  return resolved;
}

function fileRecord(outputDir, name, content) {
  const buffer = Buffer.isBuffer(content) ? content : Buffer.from(content, "utf8");
  return {
    path: path.join(outputDir, name),
    relative_path: name,
    bytes: buffer.byteLength,
    sha256: sha256(buffer)
  };
}

async function writeRunArtifacts(request, result, outputDir) {
  const resolvedOutput = path.resolve(outputDir);
  await fs.mkdir(resolvedOutput, { recursive: true });
  const requestJson = `${JSON.stringify(request, null, 2)}\n`;
  const resultJson = `${JSON.stringify(result, null, 2)}\n`;
  const contents = new Map([["request.json", requestJson], ["result.json", resultJson]]);
  if (result.artifacts?.reading_markdown) contents.set("reading.md", result.artifacts.reading_markdown);
  if (result.artifacts?.quarantine_markdown) contents.set("quarantine.md", result.artifacts.quarantine_markdown);

  for (const name of ["reading.md", "quarantine.md"]) {
    if (!contents.has(name)) await fs.rm(path.join(resolvedOutput, name), { force: true });
  }

  for (const [name, content] of contents) {
    if (name === "result.json") continue;
    await replaceFileAtomic(path.join(resolvedOutput, name), content);
  }

  const files = Object.fromEntries([...contents.entries()].map(([name, content]) => [name, fileRecord(resolvedOutput, name, content)]));
  const manifest = {
    interface_version: CALLABLE_INTERFACE_VERSION,
    created_at: new Date().toISOString(),
    status: result.status,
    processing_state: result.processing_state,
    target_zone: result.artifacts?.target_zone || null,
    material_id: result.material_id,
    idempotency_key: result.idempotency_key,
    files
  };
  const manifestJson = `${JSON.stringify(manifest, null, 2)}\n`;
  await replaceFileAtomic(path.join(resolvedOutput, "run-manifest.json"), manifestJson);
  files["run-manifest.json"] = fileRecord(resolvedOutput, "run-manifest.json", manifestJson);

  // result.json is the commit marker: callers only treat the run as visible after this rename succeeds.
  await replaceFileAtomic(path.join(resolvedOutput, "result.json"), resultJson);
  return { output_dir: resolvedOutput, files };
}

function localAssetReference(rawDestination) {
  const trimmed = String(rawDestination || "").trim();
  const wrapped = trimmed.startsWith("<") && trimmed.endsWith(">");
  const value = wrapped ? trimmed.slice(1, -1) : trimmed;
  if (!value || /^[a-z][a-z0-9+.-]*:/iu.test(value) || value.startsWith("//") || value.startsWith("#")) return null;
  let decoded;
  try {
    decoded = decodeURIComponent(value).replace(/\\/gu, "/");
  } catch {
    throw new PreprocessInterfaceError("invalid_publish_asset_path", `could not decode Markdown asset path: ${value}`);
  }
  const normalized = path.posix.normalize(decoded);
  if (!normalized.startsWith("assets/") || normalized.split("/").includes("..")) return null;
  return { relative: normalized.slice("assets/".length), wrapped };
}

function rewriteInlineImageDestinations(markdown, replace) {
  const pattern = /!\[(?:\\.|[^\]\\\n])*\]\(/gu;
  let output = "", copied = 0, match;
  while ((match = pattern.exec(markdown))) {
    const start = pattern.lastIndex;
    let cursor = start, depth = 0;
    if (markdown[cursor] === "<") {
      cursor += 1;
      while (cursor < markdown.length && markdown[cursor] !== ">" && markdown[cursor] !== "\n") cursor += markdown[cursor] === "\\" ? 2 : 1;
      if (markdown[cursor] !== ">") continue;
      cursor += 1;
    } else {
      while (cursor < markdown.length) {
        const ch = markdown[cursor];
        if (ch === "\\") { cursor += 2; continue; }
        if (/\s/u.test(ch) || (ch === ")" && depth === 0)) break;
        if (ch === "(") depth += 1;
        if (ch === ")") depth -= 1;
        cursor += 1;
      }
      if (depth !== 0) continue;
    }
    const destinationEnd = cursor;
    while (/[ \t]/u.test(markdown[cursor] || "")) cursor += 1;
    if (cursor > destinationEnd && ['"', "'", "("].includes(markdown[cursor])) {
      const close = markdown[cursor] === "(" ? ")" : markdown[cursor];
      cursor += 1;
      while (cursor < markdown.length && markdown[cursor] !== close && markdown[cursor] !== "\n") cursor += markdown[cursor] === "\\" ? 2 : 1;
      if (markdown[cursor] !== close) continue;
      cursor += 1;
      while (/[ \t]/u.test(markdown[cursor] || "")) cursor += 1;
    }
    if (markdown[cursor] !== ")") continue;
    const destination = markdown.slice(start, destinationEnd);
    const replacement = replace(destination);
    if (replacement !== null) {
      output += markdown.slice(copied, start) + replacement;
      copied = destinationEnd;
    }
    pattern.lastIndex = cursor + 1;
  }
  return output + markdown.slice(copied);
}

function transformOutsideFencedCode(markdown, transform) {
  const lines = String(markdown || "").split("\n");
  const output = [];
  let plain = [];
  let fence = null;
  const flush = () => {
    if (plain.length) output.push(transform(plain.join("\n")));
    plain = [];
  };
  for (const line of lines) {
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})/u)?.[1] || null;
    if (!fence && marker) {
      flush();
      fence = marker[0];
      output.push(line);
      continue;
    }
    if (fence && marker?.[0] === fence && marker.length >= 3) {
      output.push(line);
      fence = null;
      continue;
    }
    if (fence) output.push(line);
    else plain.push(line);
  }
  flush();
  return output.join("\n");
}

function sourceAnchorMappings(markdown) {
  const anchors = [];
  const pattern = /^\s*<a\s+(?:id|name)=["']((?:pdf-page|epub-chapter|docx-)[^"']*)["'][^>]*><\/a>\s*$/gimu;
  for (const match of markdown.matchAll(pattern)) {
    const following = markdown.slice((match.index || 0) + match[0].length);
    const block = following.match(/^\s*\^(pr-[a-f0-9]{12})\s*$/imu)?.[1] || null;
    anchors.push({ id: match[1], block });
  }
  return anchors;
}

export function sanitizePublishedMarkdown(markdown) {
  const original = String(markdown || "").replace(/\r\n?/gu, "\n");
  const mappings = sourceAnchorMappings(original);
  const targetById = new Map(mappings.filter((item) => item.block).map((item) => [item.id, item.block]));
  let internal_links_rewritten = 0;
  let comments_removed = 0;
  let anchors_removed = 0;
  let invisible_characters_removed = 0;
  let cleaned = transformOutsideFencedCode(original, (segment) => {
    let value = segment.replace(/\[([^\]\n]+)\]\(#([^)\n]+)\)/gu, (match, label, rawId) => {
      let id = rawId;
      try { id = decodeURIComponent(rawId); } catch { /* keep the literal fragment */ }
      const block = targetById.get(id);
      if (!block) return match;
      internal_links_rewritten += 1;
      return `[[#^${block}|${label}]]`;
    });
    value = value.replace(/<!--[\s\S]*?-->/gu, () => {
      comments_removed += 1;
      return "";
    });
    value = value.replace(/^\s*<a\s+(?:id|name)=["'](?:pdf-page|epub-chapter|docx-)[^"']*["'][^>]*><\/a>\s*$/gimu, () => {
      anchors_removed += 1;
      return "";
    });
    return value;
  });
  cleaned = cleaned.replace(/[\u00ad\u200b\u2060\ufeff]/gu, () => {
    invisible_characters_removed += 1;
    return "";
  });
  cleaned = cleaned
    .replace(/\u00a0/gu, " ")
    .replace(/[ \t]+$/gmu, "")
    .replace(/\n{3,}/gu, "\n\n")
    .trimEnd() + "\n";
  return {
    markdown: cleaned,
    report: {
      comments_removed,
      anchors_removed,
      internal_links_rewritten,
      invisible_characters_removed
    }
  };
}

export function validatePublishedMarkdownCleanliness(markdown) {
  const inspectedLines = [];
  let fence = null;
  for (const line of String(markdown || "").split("\n")) {
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})/u)?.[1] || null;
    if (!fence && marker) {
      fence = marker[0];
      inspectedLines.push("");
      continue;
    }
    if (fence && marker?.[0] === fence && marker.length >= 3) {
      fence = null;
      inspectedLines.push("");
      continue;
    }
    inspectedLines.push(fence ? "" : line);
  }
  const inspected = inspectedLines.join("\n");
  const failures = [];
  const checks = [
    ["html_comment", /<!--[\s\S]*?-->/u],
    ["source_anchor", /^\s*<a\s+(?:id|name)=["'](?:pdf-page|epub-chapter|docx-)/imu],
    ["pandoc_fenced_div", /^\s*:{3,}(?:\s+.*)?$/mu],
    ["pandoc_attribute", /(?:^|\n)\s*(?:\{[#.][^}\n]+\}|#{1,6}[^\n]*\{[#.][^}\n]+\})\s*(?:\n|$)/u],
    ["raw_ooxml", /<\/?(?:w|wp|a|m|v):[A-Za-z][^>]*>/u],
    ["replacement_character", /\ufffd/u],
    ["invisible_control", /[\u00ad\u200b\u2060\ufeff]/u]
  ];
  for (const [code, pattern] of checks) {
    if (pattern.test(inspected)) failures.push(code);
  }
  return { valid: failures.length === 0, failures };
}

async function existingFileHash(filePath) {
  try {
    return sha256(await fs.readFile(filePath));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

export async function publishReadingArtifact(result, {
  publishPath,
  assetSourceDir = null,
  runDir = null,
  now = null,
  expectedExistingSha256 = null
} = {}) {
  const { classifyStandardImportQuality } = await import("../scripts/standard-import-quality.mjs");
  const quality = classifyStandardImportQuality(result);
  if (!quality.admissible) {
    throw new PreprocessInterfaceError(
      "publish_result_not_ready",
      "result has no admissible readable artifact"
    );
  }
  const resolvedPublish = path.resolve(String(publishPath || ""));
  if (!publishPath || path.extname(resolvedPublish).toLowerCase() !== ".md") {
    throw new PreprocessInterfaceError("invalid_publish_path", "--publish must name one final .md file");
  }
  let originalMarkdown = String(result.artifacts?.reading_markdown || "");
  if (!originalMarkdown) {
    throw new PreprocessInterfaceError("missing_reading_markdown", "ready result has no reading Markdown to publish");
  }

  let duplicateOriginalRemoved = false;
  if (quality.readable_with_warnings) {
    // Quality details remain in the audit log, never in the reading body.
    originalMarkdown = originalMarkdown.replace(/^processing_status:.*$/mu, 'processing_status: imported');
    const bodyStart = originalMarkdown.indexOf('\n## 正文\n');
    const originalStart = originalMarkdown.indexOf('\n---\n\n## 原文\n', bodyStart);
    if (bodyStart >= 0 && originalStart > bodyStart) {
      const body = originalMarkdown.slice(bodyStart + '\n## 正文\n'.length, originalStart).trim();
      const original = originalMarkdown.slice(originalStart + '\n---\n\n## 原文\n'.length).trim();
      if (body === original) {
        originalMarkdown = originalMarkdown.slice(0, originalStart).trimEnd() + '\n';
        originalMarkdown = originalMarkdown.replace(/^translation_state:.*$/mu, 'translation_state: not_translation');
        duplicateOriginalRemoved = true;
      }
    }
  }
  const sanitized = sanitizePublishedMarkdown(originalMarkdown);
  const readerMath = normalizeReaderMath(sanitized.markdown);
  const simplified = simplifyPublishedChinese(readerMath.markdown);

  const publishDir = path.dirname(resolvedPublish);
  const materialSlug = path.basename(resolvedPublish, path.extname(resolvedPublish));
  const assetSource = assetSourceDir ? path.resolve(assetSourceDir) : null;
  const assetRecords = new Map();
  let publishedMarkdown = transformOutsideFencedCode(simplified.markdown, segment => rewriteInlineImageDestinations(segment, destination => {
    const local = localAssetReference(destination);
    if (!local) return null;
    if (!assetSource) {
      throw new PreprocessInterfaceError(
        "missing_publish_asset_source",
        `reading Markdown references ${destination}, but no --asset-source was supplied`
      );
    }
    const publishRelative = path.posix.join("_assets", materialSlug, local.relative);
    assetRecords.set(local.relative, publishRelative);
    const rendered = local.wrapped || /[\s()]/u.test(publishRelative) ? `<${publishRelative}>` : publishRelative;
    return rendered;
  }));
  const cleanliness = validatePublishedMarkdownCleanliness(publishedMarkdown);
  if (!cleanliness.valid) {
    throw new PreprocessInterfaceError(
      "publish_markdown_not_clean",
      `final Markdown still contains non-reading intermediate syntax: ${cleanliness.failures.join(", ")}`,
      cleanliness
    );
  }

  const expandedMarkdown = publishedMarkdown;
  if (result.translation_state === "generated_translation") {
    publishedMarkdown = foldPublishedOriginal(publishedMarkdown);
  }
  const existingMarkdownHash = await existingFileHash(resolvedPublish);
  // Replaying a previously published expanded note must neither rewrite it nor conflict.
  if (existingMarkdownHash === sha256(Buffer.from(expandedMarkdown, "utf8"))) {
    publishedMarkdown = expandedMarkdown;
  }
  const publishedMarkdownHash = sha256(Buffer.from(publishedMarkdown, "utf8"));
  const guardedReplacement = typeof expectedExistingSha256 === "string"
    && /^[a-f0-9]{64}$/u.test(expectedExistingSha256) && existingMarkdownHash === expectedExistingSha256;
  if (expectedExistingSha256 !== null && !guardedReplacement) {
    throw new PreprocessInterfaceError("publish_source_changed", `source changed before replacement: ${resolvedPublish}`);
  }
  if (existingMarkdownHash && existingMarkdownHash !== publishedMarkdownHash && !guardedReplacement) {
    throw new PreprocessInterfaceError(
      "publish_target_conflict",
      `final Markdown already exists with different content: ${resolvedPublish}`
    );
  }

  const publishedAssets = [];
  for (const [sourceRelative, publishRelative] of [...assetRecords.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    const sourcePath = path.resolve(assetSource, sourceRelative);
    if (sourcePath !== assetSource && !sourcePath.startsWith(`${assetSource}${path.sep}`)) {
      throw new PreprocessInterfaceError("publish_asset_path_escape", `asset escaped source directory: ${sourceRelative}`);
    }
    const data = await fs.readFile(sourcePath);
    const targetPath = path.resolve(publishDir, ...publishRelative.split("/"));
    if (targetPath !== publishDir && !targetPath.startsWith(`${publishDir}${path.sep}`)) {
      throw new PreprocessInterfaceError("publish_asset_path_escape", `asset escaped publish directory: ${publishRelative}`);
    }
    const sourceHash = sha256(data);
    const targetHash = await existingFileHash(targetPath);
    if (targetHash && targetHash !== sourceHash) {
      throw new PreprocessInterfaceError("publish_asset_conflict", `published asset exists with different content: ${targetPath}`);
    }
    if (!targetHash) await replaceFileAtomic(targetPath, data);
    publishedAssets.push({
      source_path: sourcePath,
      published_path: targetPath,
      markdown_path: publishRelative,
      bytes: data.byteLength,
      sha256: sourceHash
    });
  }

  if (!existingMarkdownHash || (guardedReplacement && existingMarkdownHash !== publishedMarkdownHash)) {
    if (await existingFileHash(resolvedPublish) !== existingMarkdownHash) {
      throw new PreprocessInterfaceError("publish_source_changed", `source changed before replacement: ${resolvedPublish}`);
    }
    await replaceFileAtomic(resolvedPublish, publishedMarkdown);
  }
  const publication = {
    interface_version: CALLABLE_INTERFACE_VERSION,
    published_at: now || new Date().toISOString(),
    status: "published",
    quality_status: quality.quality_status,
    warning_codes: quality.warning_codes,
    failed_validations: (result.receipt?.validations || []).filter(item => item.status === 'failed'),
    source_errors: result.errors || [],
    duplicate_original_removed: duplicateOriginalRemoved,
    material_id: result.material_id,
    idempotency_key: result.idempotency_key,
    markdown: {
      path: resolvedPublish,
      bytes: Buffer.byteLength(publishedMarkdown, "utf8"),
      sha256: publishedMarkdownHash
    },
    cleanliness: { ...sanitized.report, valid: true, failures: [] },
    chinese_script: simplified.report,
    math_delimiters: readerMath.report,
    assets: publishedAssets
  };
  if (runDir) await writeJsonArtifact(path.join(path.resolve(runDir), "publication.json"), publication);
  return publication;
}

async function writeAndPublishRun(request, result, options = {}) {
  const written = options.outputDir
    ? await writeRunArtifacts(request, result, options.outputDir)
    : { output_dir: null, files: {} };
  const publication = options.publishPath
    ? await publishReadingArtifact(result, {
        publishPath: options.publishPath,
        assetSourceDir: options.assetSourceDir,
        runDir: written.output_dir,
        now: options.now
      })
    : null;
  return { ...written, publication };
}

async function runPreprocessingStage(request, options = {}) {
  const requestValidation = await validateRequestContract(request);
  const cacheDir = options.cacheDir === false
    ? null
    : path.resolve(options.cacheDir || path.join(defaultPreprocessHome(), "cache"));
  const result = await processMaterial(request, {
    producer: options.producer,
    cacheDir,
    now: options.now,
    skipCacheRead: options.skipCacheRead === true,
    preparedBodyBlocks: options.preparedBodyBlocks
  });
  const resultValidation = await validateResultContract(result);
  if (!resultValidation.valid) {
    throw new PreprocessInterfaceError(
      "result_contract_violation",
      "processor returned a result that does not satisfy the published result schema",
      resultValidation
    );
  }
  const written = await writeAndPublishRun(request, result, options);
  return {
    interface_version: CALLABLE_INTERFACE_VERSION,
    request_validation: requestValidation,
    result_validation: resultValidation,
    result,
    ...written
  };
}

function stageIdempotencyKey(value, suffix) {
  if (!value) return undefined;
  return `${String(value).slice(0, Math.max(1, 127 - suffix.length))}.${suffix}`;
}

function stageRequest(request, markdown, { sourceMetadata, processingOptions, idempotencyKey }) {
  return {
    ...structuredClone(request),
    material: { markdown: String(markdown || "") },
    source_metadata: structuredClone(sourceMetadata),
    processing_options: structuredClone(processingOptions),
    ...(idempotencyKey ? { idempotency_key: idempotencyKey } : {})
  };
}

function workflowStageRecord(id, result) {
  return {
    id,
    status: result.status,
    processing_state: result.processing_state,
    processor_version: result.receipt?.processor_version || null,
    prompt_version: result.receipt?.prompt_version || null,
    model_calls: result.receipt?.model?.calls || 0
  };
}

export async function runStandardPreprocessingWorkflow(request, options = {}) {
  const requestValidation = await validateRequestContract(request);
  if (!requestValidation.valid) return runPreprocessingStage(request, options);
  const producer = options.producer || new ExternalProducer();
  const cacheDir = options.cacheDir === false ? false : path.resolve(options.cacheDir || path.join(defaultPreprocessHome(), "cache"));
  await options.onProgress?.({ stage: "workflow_routing" });
  const route = await classifyPreprocessWorkflow(request, { producer, cacheDir });
  const materialId = materialIdentityForRequest(request);
  const stageRuns = [];
  if (route.needs_classification) {
    const result = {
      schema_version: RESULT_SCHEMA_VERSION, contract_version: CONTRACT_VERSION,
      status: "needs_classification", processing_state: "needs_classification",
      material_id: materialId, idempotency_key: request.idempotency_key || null,
      translation_state: "unknown", artifacts: {}, source_metadata: request.source_metadata,
      receipt: {
        processor_version: PROCESSOR_VERSION, prompt_version: PROMPT_VERSION,
        created_at: options.now || new Date().toISOString(),
        model: { provider: route.classifier.provider || null, model: route.classifier.model || null, calls: route.classifier.calls, attempts: route.classifier.attempts, call_ledger: route.classifier.call_ledger, metadata_policy: "allowlist-no-credentials-cookies-or-headers" },
        workflow_route: { ...route, stages: [] }, validations: []
      },
      errors: [{ code: "needs_classification", stage: "workflow_routing", message: route.classification_reason, retryable: false, severity: "warning" }]
    };
    const resultValidation = await validateResultContract(result);
    if (!resultValidation.valid) throw new PreprocessInterfaceError("result_contract_violation", "invalid pending classification result", resultValidation);
    const written = options.outputDir ? await writeRunArtifacts(request, result, options.outputDir) : { output_dir: null, files: {} };
    return { interface_version: CALLABLE_INTERFACE_VERSION, request_validation: requestValidation, result_validation: resultValidation, result, ...written, publication: null };
  }

  const choices = route.plan.choices;
  const supplied = request.processing_options || {};
  const common = {};
  for (const key of ["preserve_source_voice", "attribute_unverified_claims", "normalize_semantic_containers", "insight_soft_min", "insight_soft_max", "insight_safety_cap"]) {
    if (supplied[key] !== undefined) common[key] = supplied[key];
  }
  const sourceMetadata = { ...request.source_metadata };
  for (const [key, destination] of [["input_form", "input_form"], ["content_profile", "content_profile"], ["source_language", "language"]]) {
    if (route[key].value !== "not_needed") sourceMetadata[destination] = route[key].value;
  }
  let workingMarkdown = requestMarkdown(request);
  let bodyRefinement = null;
  let translated = null;
  let guideRun = null;
  async function stage(id, stageOptions, metadata = sourceMetadata, preparedBodyBlocks = undefined) {
    const stageInput = stageRequest(request, workingMarkdown, {
      sourceMetadata: metadata, processingOptions: stageOptions, idempotencyKey: undefined
    });
    stageInput.material_id = materialId;
    // Explicit caller ids identify the request, but never bypass stage content/options hashing.
    delete stageInput.idempotency_key;
    if (!stageRuns.length && request.material?.original_markdown) stageInput.material.original_markdown = request.material.original_markdown;
    stageInput.idempotency_key = "stage-" + sha256(stableJson({
      version: WORKFLOW_PLAN_VERSION, processor: PROCESSOR_VERSION, id,
      ...(id === 'reading_guide' ? { guide_coverage:GUIDE_COVERAGE_VERSION } : {}),
      input: stageInput, caller_id: request.idempotency_key || null, prepared_body: preparedBodyBlocks || null
    })).slice(0, 40);
    await options.onProgress?.({ stage: id });
    // The outer guide stage runs once; its source-point coverage engine owns
    // bounded local repairs and reuses completed stages without replaying the body.
    const stageProducer = bodyRefinement && id === "reading_guide" ? {
      maxAttempts: 1,
      generate: (payload, settings) => producer.generate(payload, { ...settings, singleAttempt: true })
    } : producer;
    const run = await runPreprocessingStage(stageInput, {
      ...options, cacheDir, producer: stageProducer, preparedBodyBlocks, publishPath: undefined,
      outputDir: options.outputDir ? path.join(options.outputDir, "stages", id) : undefined
    });
    stageRuns.push({ id, run });
    if (run.result.artifacts?.cleaning_manifest?.body_text) workingMarkdown = run.result.artifacts.cleaning_manifest.body_text;
    return run;
  }

  let bodyRun;
  if (route.plan.body_mode !== "preserve") {
    if (typeof producer.refineFullText !== "function") throw new Error("full_text_body_producer_required");
    await options.onProgress?.({ stage: route.plan.body_mode });
    const refined = await producer.refineFullText({markdown: workingMarkdown, mode: route.plan.body_mode,
      cacheDir, outputDir: options.outputDir ? path.join(options.outputDir, "body-refinement") : undefined});
    if (!refined?.markdown?.trim() || refined.receipt?.status !== "completed") throw new Error("full_text_body_incomplete");
    bodyRefinement = refined.receipt;
    workingMarkdown = refined.markdown;
  }
  if ((!bodyRun || isReadyResult(bodyRun.result)) && choices.translate.enabled) {
    const preset = route.content_profile.value === "math_lecture" ? mathLectureTranslationOptions : sourceTranslationOptions;
    bodyRun = await stage("profile_translation", preset({
      ...common,
      ...(supplied.forbid_visible_timestamps !== undefined ? {forbid_visible_timestamps:supplied.forbid_visible_timestamps} : {}),
      include_reading_guide: false,
      translation_target_language: route.plan.translation_target_language
    }));
    if (isReadyResult(bodyRun.result)) translated = bodyRun.result;
  }
  if (!bodyRun) {
    bodyRun = await stage("profile_standardization", standardMarkdownOptions({
      ...common, cleaning_mode: "semantic_only", include_reading_guide: false
    }));
  }
  if (isReadyResult(bodyRun.result) && choices.include_reading_guide.enabled) {
    guideRun = await stage("reading_guide", standardMarkdownOptions({
      ...common, cleaning_mode: "semantic_only", include_reading_guide: true
    }), {
      ...sourceMetadata,
      ...(translated ? { language: route.plan.translation_target_language, translation: { is_translation: false, is_bilingual: false } } : {})
    }, bodyRun.result.artifacts.body_blocks);
  }
  const result = structuredClone((guideRun || bodyRun).result);
  const bodyResult = bodyRun.result;
  const hasGuide = Boolean(guideRun?.result.artifacts?.semantic?.judgments);
  const guideStatus = !choices.include_reading_guide.enabled ? "skipped" : hasGuide ? "generated" : "failed";
  result.material_id = materialId;
  result.idempotency_key = "workflow-" + sha256(stableJson({ version: WORKFLOW_PLAN_VERSION, processor: PROCESSOR_VERSION, request, plan: route.plan })).slice(0, 40);
  result.receipt.material_id = materialId;
  result.receipt.idempotency_key = result.idempotency_key;
  result.receipt.reading_guide = {
    status: guideStatus,
    decision: choices.include_reading_guide,
    calls: guideRun?.result.receipt?.model?.calls || 0,
    reason: guideStatus === "failed" ? (guideRun ? "guide_generation_failed" : "body_not_ready") : choices.include_reading_guide.source
  };
  if (bodyRefinement) result.receipt.body_refinement = structuredClone(bodyRefinement);
  if (guideRun && result.artifacts.reading_markdown) {
    result.artifacts.body_blocks = structuredClone(bodyResult.artifacts.body_blocks);
    result.artifacts.cleaning_manifest = structuredClone(bodyResult.artifacts.cleaning_manifest);
    result.artifacts.artifact_hashes.body_blocks = bodyResult.artifacts.artifact_hashes.body_blocks;
    result.artifacts.artifact_hashes.cleaning_manifest = bodyResult.artifacts.artifact_hashes.cleaning_manifest;
    result.receipt.hashes = structuredClone(stageRuns[0].run.result.receipt.hashes);
    if (translated) {
      result.translation_state = translated.translation_state;
      result.source_metadata = { ...result.source_metadata, original_url: translated.source_metadata.original_url };
      if (translated.receipt.processing_profile) result.receipt.processing_profile = structuredClone(translated.receipt.processing_profile);
    }
    result.artifacts.reading_markdown = renderReadingMarkdown({
      materialId, metadata: result.source_metadata, sourceType: request.source_type,
      hashes: result.receipt.hashes, semantic: result.artifacts.semantic,
      bodyBlocks: result.artifacts.body_blocks,
      originalBlocks: translated ? translated.artifacts.cleaning_manifest.source_nodes.map(node => ({ markdown: node.text })) : [],
      translationState: result.translation_state, includeReadingGuide: hasGuide
    });
    result.artifacts.artifact_hashes.reading_markdown = sha256(result.artifacts.reading_markdown);
  }
  const bodyCalls = bodyRefinement?.api_calls_this_run || 0;
  result.receipt.model.calls = bodyCalls + route.classifier.calls + stageRuns.reduce((sum, item) => sum + item.run.result.receipt.model.calls, 0);
  result.receipt.model.attempts = [
    ...(bodyCalls ? [{attempt:1,status:"accepted",validation_errors:[],usage:bodyRefinement.usage || null,workflow_stage:route.plan.body_mode}] : []),
    ...route.classifier.attempts.map(item => ({ ...item, workflow_stage: "workflow_routing" })),
    ...stageRuns.flatMap(({ id, run }) => run.result.receipt.model.attempts.map(item => ({ ...item, workflow_stage: id })))
  ];
  result.receipt.model.call_ledger = [
    ...(bodyCalls ? [{sequence:1,workflow_stage:route.plan.body_mode,thinking:"disabled",model:bodyRefinement.model}] : []),
    ...route.classifier.call_ledger.map(item => ({ ...item, workflow_stage: "workflow_routing" })),
    ...stageRuns.flatMap(({ id, run }) => (run.result.receipt.model.call_ledger || []).map(item => ({ ...item, workflow_stage: id })))
  ];
  result.receipt.workflow_route = {
    ...route,
    stages: [...(bodyRefinement ? [{id:route.plan.body_mode,status:"completed",processing_state:"rendered",
      model_calls:bodyCalls,audit_dir:bodyRefinement.audit_dir || null,
      input_hash:bodyRefinement.input_sha256,body_hash:bodyRefinement.body_sha256,cache_hit:bodyCalls === 0}] : []),
    ...stageRuns.map(({ id, run }) => ({
      ...workflowStageRecord(id, run.result),
      audit_dir: run.output_dir || null,
      input_hash: run.result.receipt.hashes?.input || null,
      body_hash: run.result.artifacts?.artifact_hashes?.body_blocks || null,
      cache_hit: run.result.status === "idempotent_replay"
    }))]
  };
  result.receipt.validations = [
    { name: "workflow_ai_routing", status: route.classifier.skipped ? "not_needed" : "passed", details: route.classifier },
    { name: "workflow_bilingual_translation_skip", status: route.source_language.value === "bilingual" && !choices.translate.enabled ? "passed" : "not_applicable" },
    { name: "reading_guide_plan", status: guideStatus === "failed" ? "failed" : "passed", details: result.receipt.reading_guide },
    { name: "translation_original_appended", status: translated ? result.artifacts.reading_markdown?.includes("\n## 原文\n") ? "passed" : "failed" : "not_applicable" },
    ...result.receipt.validations
  ];
  const resultValidation = await validateResultContract(result);
  if (!resultValidation.valid) throw new PreprocessInterfaceError("result_contract_violation", "standard workflow returned an invalid result", resultValidation);
  const written = await writeAndPublishRun(request, result, options);
  return { interface_version: CALLABLE_INTERFACE_VERSION, request_validation: requestValidation, result_validation: resultValidation, result, ...written };
}

export async function runPreprocessingRequest(request, options = {}) {
  return request?.processing_options?.workflow_mode === "standard"
    ? runStandardPreprocessingWorkflow(request, options)
    : runPreprocessingStage(request, options);
}

export function isReadyResult(result) {
  return Boolean(
    result
    && new Set(["completed", "idempotent_replay"]).has(result.status)
    && result.processing_state === "rendered"
    && result.artifacts?.target_zone === "local-ir-reading"
    && requiredArtifactFailures(result).length === 0
  );
}

export async function getDoctorReport() {
  let schemas;
  try {
    await contractValidators();
    schemas = { ready: true, request: REQUEST_SCHEMA_VERSION, result: RESULT_SCHEMA_VERSION, split_manifest: SPLIT_MANIFEST_VERSION };
  } catch (error) {
    schemas = { ready: false, error: error instanceof Error ? error.message : String(error) };
  }
  const producer = await diagnoseProducerConfig();
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  const runtime = { ready: Number.isInteger(nodeMajor) && nodeMajor >= 20, node: process.versions.node, platform: process.platform };
  return {
    interface_version: CALLABLE_INTERFACE_VERSION,
    ready: runtime.ready && schemas.ready && producer.ready,
    runtime,
    schemas,
    producer,
    defaults: {
      home: defaultPreprocessHome(),
      cache: path.join(defaultPreprocessHome(), "cache")
    },
    versions: {
      contract: CONTRACT_VERSION,
      processor: PROCESSOR_VERSION,
      guide_coverage: GUIDE_COVERAGE_VERSION,
      prompt: PROMPT_VERSION
    }
  };
}
