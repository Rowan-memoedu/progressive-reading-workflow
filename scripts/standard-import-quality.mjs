import { isReadyResult } from "../standard-preprocessing/index.mjs";
import path from "node:path";
import { requiredArtifactFailures } from "../standard-preprocessing/lib/required-artifacts.mjs";

const CRITICAL_READABILITY_VALIDATIONS = Object.freeze([
  "request_schema",
  "lossless_source_mapping",
  "block_coverage",
  "visible_body_anchor_pruning"
]);

function warningCodes(result) {
  return [...new Set((Array.isArray(result?.errors) ? result.errors : [])
    .filter((item) => item?.severity === "warning" && item?.code)
    .map((item) => String(item.code)))];
}

function hasReadableBody(result) {
  const rendered = String(result?.artifacts?.reading_markdown || "");
  const bodyBlocks = Array.isArray(result?.artifacts?.body_blocks) ? result.artifacts.body_blocks : [];
  return rendered.startsWith("---\n")
    && rendered.replace(/^---\n[\s\S]*?\n---\n/u, "").trim().length > 0
    && bodyBlocks.some((block) => String(block?.markdown || "").trim().length > 0);
}

export function classifyStandardImportQuality(result) {
  if (result?.receipt?.validations?.some(item => item.name === 'spoken_quality_review' && item.status !== 'passed')) return {
    admissible: false, quality_status: 'failed', readable_with_warnings: false,
    warning_codes: warningCodes(result), critical_failures: ['spoken_quality_review']
  };
  const missing = requiredArtifactFailures(result);
  if (missing.length) return {
    admissible: false, quality_status: "failed", readable_with_warnings: false,
    warning_codes: warningCodes(result), critical_failures: missing
  };
  if (isReadyResult(result)) {
    return {
      admissible: true,
      quality_status: "ready",
      readable_with_warnings: false,
      warning_codes: []
    };
  }

  const validations = new Map((Array.isArray(result?.receipt?.validations) ? result.receipt.validations : [])
    .map((item) => [String(item?.name || ""), String(item?.status || "")]));
  const criticalFailures = CRITICAL_READABILITY_VALIDATIONS.filter((name) => validations.get(name) !== "passed");
  const errors = Array.isArray(result?.errors) ? result.errors : [];
  const warningsOnly = errors.length > 0 && errors.every((item) => item?.severity === "warning");
  const readableWarning = result?.status === "completed_with_warnings"
    && result?.processing_state === "degraded"
    && result?.artifacts?.target_zone === "preprocess-review"
    && result?.artifacts?.quarantine_markdown == null
    && warningsOnly
    && criticalFailures.length === 0
    && hasReadableBody(result);

  if (readableWarning) {
    return {
      admissible: true,
      quality_status: "warning",
      readable_with_warnings: true,
      warning_codes: warningCodes(result)
    };
  }

  return {
    admissible: false,
    quality_status: "failed",
    readable_with_warnings: false,
    warning_codes: warningCodes(result),
    critical_failures: criticalFailures
  };
}

export function readingDocumentPathCandidates({ workflowRoot, readingRoot, storedDocumentPath }) {
  const normalized = String(storedDocumentPath || "").replaceAll("\\", "/");
  const candidates = [path.resolve(workflowRoot, "..", "..", normalized)];
  const marker = "/阅读区/";
  const markerIndex = normalized.indexOf(marker);
  if (markerIndex >= 0) candidates.push(path.resolve(readingRoot, normalized.slice(markerIndex + marker.length)));
  return [...new Set(candidates)];
}
