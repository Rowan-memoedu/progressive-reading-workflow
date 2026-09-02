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
  processMaterial,
  sha256,
  validateRequest
} from "./lib/core.mjs";
import {
  diagnoseProducerConfig,
  ExternalProducer,
  WORKFLOW_ROUTER_PROMPT_VERSION,
  WORKFLOW_ROUTER_VERSION
} from "./lib/producer.mjs";
import { buildSplitManifest, buildSplitRequest, SPLIT_MANIFEST_VERSION, SPLIT_POLICY_VERSION } from "./lib/splitter.mjs";

export { buildSplitManifest, buildSplitRequest, SPLIT_MANIFEST_VERSION, SPLIT_POLICY_VERSION };

export const CALLABLE_INTERFACE_VERSION = "1.2.0";

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
  return new Set(["natural_language", "math_lecture"]).has(value) ? value : null;
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

export async function classifyPreprocessWorkflow(request, { producer = null, markdown = requestMarkdown(request) } = {}) {
  const fixed = fixedWorkflowLabels(request);
  const missing = Object.entries(fixed.values).filter(([, value]) => !value).map(([key]) => key);
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
      classified = await producer.classifyWorkflow({ markdown, fixed_labels: fixed.values });
    } catch (error) {
      throw new PreprocessInterfaceError(
        "workflow_routing_failed",
        error instanceof Error ? error.message : String(error),
        { missing_labels: missing, api_calls: Number(error?.api_calls || 0) }
      );
    }
  }
  const output = classified?.output || fixed.values;
  const decision = (key) => fixed.values[key]
    ? { value: fixed.values[key], method: fixed.methods[key], evidence: {} }
    : {
        value: output[key],
        method: WORKFLOW_ROUTER_VERSION,
        evidence: { confidence: output.confidence, reason: output.reason }
      };
  const inputForm = decision("input_form");
  const contentProfile = decision("content_profile");
  const sourceLanguage = decision("source_language");
  return {
    version: "progressive-reading.workflow-route/v1",
    input_form: inputForm,
    content_profile: contentProfile,
    source_language: sourceLanguage,
    translation_required: sourceLanguage.value === "en",
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
          reason: "all_route_labels_supplied_by_request_or_source_metadata",
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

  const staleArtifact = result.artifacts?.reading_markdown ? "quarantine.md" : "reading.md";
  await fs.rm(path.join(resolvedOutput, staleArtifact), { force: true });

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
  now = null
} = {}) {
  if (!isReadyResult(result)) {
    throw new PreprocessInterfaceError(
      "publish_result_not_ready",
      "only completed local-ir-reading results may be published"
    );
  }
  const resolvedPublish = path.resolve(String(publishPath || ""));
  if (!publishPath || path.extname(resolvedPublish).toLowerCase() !== ".md") {
    throw new PreprocessInterfaceError("invalid_publish_path", "--publish must name one final .md file");
  }
  const originalMarkdown = String(result.artifacts?.reading_markdown || "");
  if (!originalMarkdown) {
    throw new PreprocessInterfaceError("missing_reading_markdown", "ready result has no reading Markdown to publish");
  }

  const sanitized = sanitizePublishedMarkdown(originalMarkdown);

  const publishDir = path.dirname(resolvedPublish);
  const materialSlug = path.basename(resolvedPublish, path.extname(resolvedPublish));
  const assetSource = assetSourceDir ? path.resolve(assetSourceDir) : null;
  const assetRecords = new Map();
  const imagePattern = /(!\[[^\]\n]*\]\()(<[^>\n]+>|[^)\n]+)(\))/gu;
  const publishedMarkdown = sanitized.markdown.replace(imagePattern, (match, prefix, destination, suffix) => {
    const local = localAssetReference(destination);
    if (!local) return match;
    if (!assetSource) {
      throw new PreprocessInterfaceError(
        "missing_publish_asset_source",
        `reading Markdown references ${destination}, but no --asset-source was supplied`
      );
    }
    const publishRelative = path.posix.join("_assets", materialSlug, local.relative);
    assetRecords.set(local.relative, publishRelative);
    const rendered = local.wrapped ? `<${publishRelative}>` : publishRelative;
    return `${prefix}${rendered}${suffix}`;
  });
  const cleanliness = validatePublishedMarkdownCleanliness(publishedMarkdown);
  if (!cleanliness.valid) {
    throw new PreprocessInterfaceError(
      "publish_markdown_not_clean",
      `final Markdown still contains non-reading intermediate syntax: ${cleanliness.failures.join(", ")}`,
      cleanliness
    );
  }

  const existingMarkdownHash = await existingFileHash(resolvedPublish);
  const publishedMarkdownHash = sha256(Buffer.from(publishedMarkdown, "utf8"));
  if (existingMarkdownHash && existingMarkdownHash !== publishedMarkdownHash) {
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

  if (!existingMarkdownHash) await replaceFileAtomic(resolvedPublish, publishedMarkdown);
  const publication = {
    interface_version: CALLABLE_INTERFACE_VERSION,
    published_at: now || new Date().toISOString(),
    status: "published",
    material_id: result.material_id,
    idempotency_key: result.idempotency_key,
    markdown: {
      path: resolvedPublish,
      bytes: Buffer.byteLength(publishedMarkdown, "utf8"),
      sha256: publishedMarkdownHash
    },
    cleanliness: { ...sanitized.report, valid: true, failures: [] },
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
    skipCacheRead: options.skipCacheRead === true
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
  if (!requestValidation.valid) {
    return runPreprocessingStage(request, options);
  }
  const workflowProducer = options.producer || new ExternalProducer();
  const stageOptions = { ...options, producer: workflowProducer };
  const workflowOptions = request.processing_options || {};
  const stages = [];
  let workingMarkdown = requestMarkdown(request);
  const route = await classifyPreprocessWorkflow(request, { producer: workflowProducer, markdown: workingMarkdown });
  let preliminary = null;

  if (route.input_form.value === "spoken_transcript") {
    const spokenRequest = stageRequest(request, workingMarkdown, {
      sourceMetadata: { ...request.source_metadata, input_form: "spoken_transcript", language: route.source_language.value },
      processingOptions: spokenMarkdownOptions(Object.fromEntries([
        ["insight_soft_min", workflowOptions.insight_soft_min],
        ["insight_soft_max", workflowOptions.insight_soft_max],
        ["insight_safety_cap", workflowOptions.insight_safety_cap]
      ].filter(([, value]) => Number.isInteger(value)))),
      idempotencyKey: stageIdempotencyKey(request.idempotency_key, "spoken")
    });
    preliminary = await runPreprocessingStage(spokenRequest, { ...stageOptions, outputDir: undefined });
    stages.push(workflowStageRecord("spoken_to_written", preliminary.result));
    if (!isReadyResult(preliminary.result)) {
      const written = options.outputDir ? await writeRunArtifacts(request, preliminary.result, options.outputDir) : { output_dir: null, files: {} };
      return { ...preliminary, ...written };
    }
    workingMarkdown = preliminary.result.artifacts.cleaning_manifest.body_text;
  }

  const profile = route.content_profile.value;
  const commonOverrides = Object.fromEntries([
    ["insight_soft_min", workflowOptions.insight_soft_min],
    ["insight_soft_max", workflowOptions.insight_soft_max],
    ["insight_safety_cap", workflowOptions.insight_safety_cap]
  ].filter(([, value]) => Number.isInteger(value)));
  const finalProcessingOptions = route.translation_required
    ? profile === "math_lecture"
      ? mathLectureTranslationOptions(commonOverrides)
      : sourceTranslationOptions(commonOverrides)
    : profile === "math_lecture"
      ? mathLectureStandardizationOptions(commonOverrides)
      : standardMarkdownOptions(commonOverrides);
  const finalRequest = stageRequest(request, workingMarkdown, {
    sourceMetadata: {
      ...request.source_metadata,
      input_form: "written",
      content_profile: profile,
      language: route.source_language.value
    },
    processingOptions: finalProcessingOptions,
    idempotencyKey: request.idempotency_key
  });
  const finalRun = await runPreprocessingStage(finalRequest, { ...stageOptions, outputDir: undefined });
  const result = structuredClone(finalRun.result);
  if (route.translation_required) {
    stages.push({ ...workflowStageRecord("profile_translation", result), execution: "dedicated_api_calls_within_profile_pipeline" });
    stages.push({
      id: "profile_standardization",
      status: result.status,
      processing_state: result.processing_state,
      processor_version: result.receipt?.processor_version || null,
      prompt_version: result.receipt?.prompt_version || null,
      execution: "dedicated_semantic_api_call_after_translation"
    });
  } else {
    stages.push({ ...workflowStageRecord("profile_standardization", result), execution: "profile_producer_pipeline" });
  }
  result.receipt.model.calls += Number(route.classifier?.calls || 0) + (preliminary?.result.receipt?.model?.calls || 0);
  result.receipt.model.attempts = [
    ...(route.classifier?.attempts || []).map((attempt) => ({ ...attempt, workflow_stage: "workflow_routing" })),
    ...(preliminary?.result.receipt?.model?.attempts || []).map((attempt) => ({ ...attempt, workflow_stage: "spoken_to_written" })),
    ...(result.receipt.model.attempts || []).map((attempt) => ({ ...attempt, workflow_stage: "final" }))
  ];
  result.receipt.model.call_ledger = [
    ...(route.classifier?.call_ledger || []).map((entry) => ({ ...entry, workflow_stage: "workflow_routing" })),
    ...(preliminary?.result.receipt?.model?.call_ledger || []).map((entry) => ({ ...entry, workflow_stage: "spoken_to_written" })),
    ...(result.receipt.model.call_ledger || []).map((entry) => ({ ...entry, workflow_stage: "final" }))
  ];
  result.receipt.workflow_route = { ...route, stages };
  result.receipt.validations = [
    {
      name: "workflow_ai_routing",
      status: route.classifier.skipped ? "not_needed" : "passed",
      details: {
        version: route.classifier.version,
        prompt_version: route.classifier.prompt_version,
        calls: route.classifier.calls,
        skipped: route.classifier.skipped
      }
    },
    { name: "workflow_input_form_classification", status: "passed", details: route.input_form },
    { name: "workflow_content_profile_classification", status: "passed", details: route.content_profile },
    { name: "workflow_source_language_classification", status: "passed", details: route.source_language },
    {
      name: "workflow_bilingual_translation_skip",
      status: route.source_language.value === "bilingual" ? (route.translation_required ? "failed" : "passed") : "not_applicable"
    },
    {
      name: "translation_original_appended",
      status: route.translation_required
        ? result.artifacts?.reading_markdown?.includes("\n## 原文\n") ? "passed" : "failed"
        : "not_applicable"
    },
    ...result.receipt.validations
  ];
  result.source_metadata = { ...result.source_metadata, input_form: "written", content_profile: profile, language: route.source_language.value };
  const resultValidation = await validateResultContract(result);
  if (!resultValidation.valid) {
    throw new PreprocessInterfaceError("result_contract_violation", "standard workflow returned a result outside the published result schema", resultValidation);
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
      prompt: PROMPT_VERSION
    }
  };
}
