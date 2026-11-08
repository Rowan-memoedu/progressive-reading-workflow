import assert from "node:assert/strict";
import path from "node:path";
import { classifyStandardImportQuality, readingDocumentPathCandidates } from "./standard-import-quality.mjs";

function fixture(overrides = {}) {
  return {
    status: "completed_with_warnings",
    processing_state: "degraded",
    artifacts: {
      target_zone: "preprocess-review",
      quarantine_markdown: null,
      reading_markdown: "---\nprocessing_status: ready\n---\n\n# 可读文章\n\n完整正文。\n",
      body_blocks: [{ source_block_key: "src-1", markdown: "完整正文。" }]
    },
    receipt: {
      validations: [
        { name: "request_schema", status: "passed" },
        { name: "lossless_source_mapping", status: "passed" },
        { name: "block_coverage", status: "passed" },
        { name: "visible_body_anchor_pruning", status: "passed" },
        { name: "whole_article_cleaning", status: "failed" }
      ]
    },
    errors: [{ code: "producer_output_rejected", stage: "semantic_processing", message: "fixture", retryable: false, severity: "warning" }],
    ...overrides
  };
}

const warning = classifyStandardImportQuality(fixture());
assert.equal(warning.admissible, true);
assert.equal(warning.quality_status, "warning");
assert.deepEqual(warning.warning_codes, ["producer_output_rejected"]);

const lostBlocks = fixture();
lostBlocks.receipt.validations = lostBlocks.receipt.validations.map((item) => item.name === "block_coverage" ? { ...item, status: "failed" } : item);
assert.equal(classifyStandardImportQuality(lostBlocks).admissible, false);

const emptyBody = fixture();
emptyBody.artifacts = { ...emptyBody.artifacts, reading_markdown: "---\nprocessing_status: ready\n---\n", body_blocks: [] };
assert.equal(classifyStandardImportQuality(emptyBody).admissible, false);

const hardError = fixture({ errors: [{ code: "render_failed", stage: "rendering", message: "fixture", retryable: false, severity: "error" }] });
assert.equal(classifyStandardImportQuality(hardError).admissible, false);

const ready = fixture({
  status: "completed",
  processing_state: "rendered",
  artifacts: { ...fixture().artifacts, target_zone: "local-ir-reading" },
  errors: []
});
assert.equal(classifyStandardImportQuality(ready).quality_status, "ready");

const migratedCandidates = readingDocumentPathCandidates({
  workflowRoot: "D:\\Projects\\渐进阅读工作流",
  readingRoot: "D:\\Projects\\渐进阅读工作流\\阅读区",
  storedDocumentPath: "04 Projects/渐进阅读工作流/阅读区/浏览器高亮/Nenex--e2da78fae3.md"
});
assert.ok(migratedCandidates.includes(path.resolve("D:\\Projects\\渐进阅读工作流\\阅读区\\浏览器高亮\\Nenex--e2da78fae3.md")));

console.log(JSON.stringify({
  status: "passed",
  checks: ["readable_warning_admitted", "critical_loss_rejected", "empty_body_rejected", "hard_error_rejected", "ready_preserved", "migrated_reading_path_resolved"]
}, null, 2));
