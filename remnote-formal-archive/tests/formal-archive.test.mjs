import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import Ajv2020 from "ajv/dist/2020.js";
import { applyQueue, buildDryRunPlan, normalizePackage, rollbackLocalReceipt, TARGET_DOCUMENTS, validateNormalizedPackage } from "../core.mjs";

const fixturesDir = path.resolve(import.meta.dirname, "../fixtures");
const target = { parentRemId: "root-parent", parentTitle: "Formal Archive Canary" };
const fixedClock = () => new Date("2026-08-15T00:00:00.000Z");

test("published CLI initializes the live client class before invoking main", async () => {
  const cliSource = await readFile(path.resolve(import.meta.dirname, "../../scripts/import-remnote-queue.mjs"), "utf8");
  const classIndex = cliSource.indexOf("export class RemNoteMcpClient");
  const invokeIndex = cliSource.lastIndexOf("main().catch");
  assert.ok(classIndex >= 0, "RemNoteMcpClient class missing");
  assert.ok(invokeIndex > classIndex, "main must run after RemNoteMcpClient initialization");
});

test("dry-run is deterministic and performs zero writes", async () => {
  const env = await makeEnv("native-v1.valid.json");
  const secondLocation = await makeEnv("native-v1.valid.json");
  const before = await readFile(env.packagePath, "utf8");
  const first = await buildDryRunPlan({ queueDir: env.queueDir, stateDir: env.stateDir, target });
  const second = await buildDryRunPlan({ queueDir: env.queueDir, stateDir: env.stateDir, target });
  const relocated = await buildDryRunPlan({ queueDir: secondLocation.queueDir, stateDir: secondLocation.stateDir, target });
  assert.deepEqual(first, second);
  assert.equal(first.planHash, relocated.planHash);
  assert.equal(first.planHash.length, 64);
  assert.equal(first.summary.itemCount, 4);
  assert.equal(first.packages[0].dispositionSummary["remnote_import:covered"], 4);
  assert.equal(await exists(path.join(env.stateDir, "state.v1.json")), false);
  assert.equal(await readFile(env.packagePath, "utf8"), before);
});

test("invalid schema content is rejected before any RemNote call", async () => {
  const env = await makeEnv("invalid-unresolved-qa.json");
  const plan = await buildDryRunPlan({ queueDir: env.queueDir, stateDir: env.stateDir, target });
  assert.equal(plan.invalid.length, 1);
  assert.match(plan.invalid[0].errors.join(" "), /unresolved QA cards/);
});

test("native v2 preserves explicit source descriptors for representative formats", () => {
  const sources = [
    ["document", "pdf-derived-markdown", "file:///fixture.pdf"],
    ["document", "word-derived-markdown", "file:///fixture.docx"],
    ["book", "epub-derived-markdown", "file:///fixture.epub"],
    ["video_transcript", "youtube-transcript-markdown", "https://www.youtube.com/watch?v=fixture"],
    ["web_article", "web-markdown", "https://example.test/fixture"]
  ];
  for (const [materialType, format, origin] of sources) {
    const normalized = normalizePackage(makeNativeV2Package({ packageId: `source-${format}`, source: { materialType, format, origin } }));
    assert.deepEqual(normalized.source, { materialType, format, origin });
    assert.deepEqual(validateNormalizedPackage(normalized), []);
  }
});

test("published v2 package schema accepts the native producer contract", async () => {
  const schema = JSON.parse(await readFile(path.resolve(import.meta.dirname, "../schemas/local-ir-export-package.v2.schema.json"), "utf8"));
  const validate = new Ajv2020({ strict: false, validateFormats: false }).compile(schema);
  const raw = makeNativeV2Package();
  assert.equal(validate(raw), true, JSON.stringify(validate.errors));
  const confirmedZero = makeConfirmedZeroItemPackage();
  assert.equal(validate(confirmedZero), true, JSON.stringify(validate.errors));
});

test("zero RemNote items fail closed without explicit user confirmation", () => {
  const normalized = normalizePackage(makeNativeV2Package({
    packageId: "zero-items-unconfirmed",
    annotations: [],
    cards: [],
    clozeCards: [],
    articleMusings: []
  }));
  assert.match(validateNormalizedPackage(normalized).join(" "), /explicit user confirmation/);
});

test("zero-content confirmation must exactly match frozen package elements", () => {
  const wrongKinds = normalizePackage(makeConfirmedZeroItemPackage({
    packageId: "zero-items-wrong-kinds",
    localArchive: {
      state: "export_package_ready",
      sourcePath: "staging/native-v2.md",
      archivedSourcePath: "archive/native-v2.md",
      noRemnoteContentConfirmation: makeNoRemnoteContentConfirmation({ missingElementKinds: ["annotations"] })
    }
  }));
  assert.match(validateNormalizedPackage(wrongKinds).join(" "), /must match the package elements/);

  const nonIso = normalizePackage(makeConfirmedZeroItemPackage({
    packageId: "zero-items-non-iso",
    localArchive: {
      state: "export_package_ready",
      sourcePath: "staging/native-v2.md",
      archivedSourcePath: "archive/native-v2.md",
      noRemnoteContentConfirmation: makeNoRemnoteContentConfirmation({ confirmedAt: "2026-08-23" })
    }
  }));
  assert.match(validateNormalizedPackage(nonIso).join(" "), /must be an ISO date-time/);
});

test("confirmed zero-content package has a deterministic no-remote dry-run", async () => {
  const env = await makeEnv("native-v1.valid.json");
  const raw = makeConfirmedZeroItemPackage({ packageId: "zero-items-plan" });
  await writeFile(env.packagePath, `${JSON.stringify(raw, null, 2)}\n`, "utf8");
  const first = await buildDryRunPlan({ queueDir: env.queueDir, stateDir: env.stateDir, target });
  const second = await buildDryRunPlan({ queueDir: env.queueDir, stateDir: env.stateDir, target });
  assert.equal(first.invalid.length, 0);
  assert.equal(first.planHash, second.planHash);
  assert.equal(first.summary.itemCount, 0);
  assert.equal(first.packages[0].action, "archive_without_remnote_items");
  assert.equal(first.packages[0].remoteMode, "no_remnote_content");
  assert.equal(first.packages[0].noRemnoteContentConfirmation.confirmed, true);
});

test("confirmed packages with only refined-reading or question routes remain valid", () => {
  const onlyHighlight = normalizePackage(makeConfirmedZeroItemPackage({
    packageId: "only-highlight-confirmed",
    refinedReadingPath: "artifacts/refined.md",
    annotations: [{ id: "highlight-1", type: "highlight", route: "refined_reading", highlightOnly: true, importable: false }],
    localArchive: {
      state: "export_package_ready",
      sourcePath: "staging/native-v2.md",
      archivedSourcePath: "archive/native-v2.md",
      noRemnoteContentConfirmation: makeNoRemnoteContentConfirmation({ missingElementKinds: ["articleMusings", "cards", "clozeCards"] })
    }
  }));
  assert.equal(onlyHighlight.items.length, 0);
  assert.equal(onlyHighlight.dispositionSummary["refined_reading:covered"], 1);
  assert.deepEqual(validateNormalizedPackage(onlyHighlight), []);

  const onlyQuestion = normalizePackage(makeConfirmedZeroItemPackage({
    packageId: "only-question-confirmed",
    questionQueueJsonPath: "artifacts/questions.json",
    annotations: [{ id: "question-1", type: "question", route: "codex_question_queue", importable: false }],
    localArchive: {
      state: "export_package_ready",
      sourcePath: "staging/native-v2.md",
      archivedSourcePath: "archive/native-v2.md",
      noRemnoteContentConfirmation: makeNoRemnoteContentConfirmation({ missingElementKinds: ["articleMusings", "cards", "clozeCards"] })
    }
  }));
  assert.equal(onlyQuestion.items.length, 0);
  assert.equal(onlyQuestion.dispositionSummary["codex_question_queue:covered"], 1);
  assert.deepEqual(validateNormalizedPackage(onlyQuestion), []);
});

test("confirmed zero-content package archives with receipt and zero RemNote writes", async () => {
  const env = await makeEnv("native-v1.valid.json", true);
  const raw = makeConfirmedZeroItemPackage({
    packageId: "zero-items-apply",
    sourcePath: "staging/article.md",
    localArchive: {
      state: "export_package_ready",
      sourcePath: "staging/article.md",
      archivedSourcePath: "archive/article.md",
      noRemnoteContentConfirmation: makeNoRemnoteContentConfirmation()
    }
  });
  await writeFile(env.packagePath, `${JSON.stringify(raw, null, 2)}\n`, "utf8");
  const client = new FakeRemNote(target);
  const result = await applyQueue({ ...env, target, client, clock: fixedClock });
  assert.equal(result.ok, true);
  assert.equal(result.noRemoteWrite, true);
  assert.equal(result.results[0].status, "archived");
  assert.equal(result.results[0].remoteOutcome, "no_remnote_content_confirmed");
  assert.equal(client.itemCreateCount, 0);
  assert.equal(await exists(path.join(env.vaultRoot, "staging/article.md")), false);
  assert.equal(await exists(path.join(env.vaultRoot, "archive/article.md")), true);
  const receipt = JSON.parse(await readFile(result.results[0].receiptPath, "utf8"));
  assert.equal(receipt.remoteOutcome.mode, "no_remnote_content");
  assert.equal(receipt.remoteOutcome.remoteWritePerformed, false);
  assert.equal(receipt.remoteOutcome.confirmation.confirmed, true);
  assert.equal(receipt.readback.verified, true);
  assert.equal(receipt.readback.targetVerified, true);
  assert.equal(receipt.readback.itemCount, 0);
});

test("QA cards use a content-only RemNote multiline >>> tree with no visible technical metadata", async () => {
  const env = await makeEnv("native-v1.valid.json", true);
  const raw = makeNativeV2Package({
    packageId: "clean-multiline-card",
    sourcePath: "staging/article.md",
    localArchive: { state: "export_package_ready", sourcePath: "staging/article.md", archivedSourcePath: "archive/article.md" },
    cards: [{ id: "qa-clean", questionMarkdown: "多行卡格式正确吗？", answerMarkdown: "第一行答案\n第二行答案", needsQuestionGeneration: false, needsAnswerGeneration: false }],
    articleMusings: []
  });
  await writeFile(env.packagePath, `${JSON.stringify(raw, null, 2)}\n`, "utf8");
  const normalized = normalizePackage(raw);
  const item = normalized.items[0];
  assert.equal(item.title, "多行卡格式正确吗？");
  assert.equal(item.creationMode, "markdown_tree");
  assert.equal(item.creationContent, "- 多行卡格式正确吗？ >>>\n    - 第一行答案\n    - 第二行答案");
  assert.doesNotMatch(`${item.title}\n${item.content}\n${item.creationContent}`, /\[IR:|formalArchive|payloadHash|packageId|sourceFormat|Obsidian source path|aiStatus/i);

  const client = new FakeRemNote(target);
  const applied = await applyQueue({ ...env, target, client, clock: fixedClock });
  assert.equal(applied.ok, true);
  assert.equal(client.createPayloads.length, 1);
  assert.equal(client.createPayloads[0].title, undefined);
  assert.match(client.createPayloads[0].content, /^- 多行卡格式正确吗？ >>>/);
  const created = [...client.notes.values()].find((note) => note.title === "多行卡格式正确吗？");
  assert.equal(created.cardDirection, "forward");
  assert.equal(created.content, "- 第一行答案\n- 第二行答案");
});

test("annotations and musings keep audit metadata local instead of rendering it in RemNote", () => {
  const normalized = normalizePackage(makeNativeV2Package({
    packageId: "clean-human-content",
    annotations: [{ id: "ann-clean", index: 1, type: "comment", typeLabel: "普通评论", targetDocument: "普通评论", route: "remnote", importable: true, originalText: "原文", currentText: "原文", commentMarkdown: "评论" }],
    articleMusings: [{ id: "musing-clean", bodyMarkdown: "一条随想", aiStatus: "pending" }]
  }));
  assert.equal(normalized.items.length, 2);
  for (const item of normalized.items) {
    assert.doesNotMatch(`${item.title}\n${item.content}`, /\[IR:|formalArchive|payloadHash|packageId|sourceMaterialType|sourceFormat|sourceOrigin|Obsidian source path|aiStatus/i);
  }
});

test("all Local IR annotation target types have explicit covered dispositions", () => {
  const types = [
    ["comment", "普通评论"],
    ["myth_truth", "迷思 / 真相"],
    ["sample_quote", "引用"],
    ["add_viewpoint", "联想"],
    ["optimize", "优化"],
    ["example_viewpoint", "例子与观点"]
  ];
  const raw = makeNativeV2Package({
    packageId: "all-annotation-types",
    annotations: types.map(([type, targetDocument], index) => ({
      id: `ann-${index + 1}`,
      index: index + 1,
      type,
      typeLabel: targetDocument,
      targetDocument,
      route: "remnote",
      importable: true,
      originalText: `原文 ${index + 1}`,
      currentText: `原文 ${index + 1}`,
      commentMarkdown: `评论 ${index + 1}`
    })),
    articleMusings: []
  });
  const normalized = normalizePackage(raw);
  assert.deepEqual(normalized.items.map((item) => item.targetDocument).sort(), types.map(([, target]) => target).sort());
  assert.equal(normalized.dispositions.length, types.length);
  assert.equal(normalized.dispositions.every((item) => item.status === "covered" && item.disposition === "remnote_import"), true);
  assert.deepEqual(validateNormalizedPackage(normalized), []);
});

test("derived routes require their exact artifacts and never silently disappear", () => {
  const covered = makeNativeV2Package({
    packageId: "covered-derived-routes",
    refinedReadingPath: "artifacts/refined.md",
    questionQueueJsonPath: "artifacts/questions.json",
    annotations: [
      { id: "refined-1", type: "comment", route: "refined_reading", highlightOnly: true, importable: true, originalText: "精读材料" },
      { id: "question-1", type: "question", route: "codex_question_queue", importable: false, originalText: "问题材料" }
    ]
  });
  const normalized = normalizePackage(covered);
  assert.equal(normalized.items.length, 1);
  assert.equal(normalized.dispositionSummary["refined_reading:covered"], 1);
  assert.equal(normalized.dispositionSummary["codex_question_queue:covered"], 1);
  assert.deepEqual(validateNormalizedPackage(normalized), []);

  delete covered.refinedReadingPath;
  delete covered.questionQueueJsonPath;
  const blocked = normalizePackage({ ...covered, packageId: "blocked-derived-routes" });
  const errors = validateNormalizedPackage(blocked).join(" ");
  assert.match(errors, /blocked disposition: annotation\/refined-1\/refined_reading/);
  assert.match(errors, /blocked disposition: annotation\/question-1\/codex_question_queue/);
});

test("empty article musings are represented as blocked dispositions", () => {
  const normalized = normalizePackage(makeNativeV2Package({
    packageId: "empty-musing",
    articleMusings: [{ id: "musing-empty", bodyMarkdown: "" }]
  }));
  assert.match(validateNormalizedPackage(normalized).join(" "), /blocked disposition: article_musing\/musing-empty\/remnote_import/);
});

test("exact duplicate is skipped and divergent duplicate is rejected", async () => {
  const env = await makeEnv("native-v1.valid.json");
  const original = JSON.parse(await readFile(env.packagePath, "utf8"));
  await writeFile(path.join(env.queueDir, "duplicate.json"), `${JSON.stringify(original, null, 2)}\n`);
  let plan = await buildDryRunPlan({ queueDir: env.queueDir, stateDir: env.stateDir, target });
  assert.equal(plan.packages.filter((item) => item.action === "skip_exact_duplicate").length, 1);
  const conflict = { ...original, title: "Divergent title" };
  await writeFile(path.join(env.queueDir, "conflict.json"), `${JSON.stringify(conflict, null, 2)}\n`);
  plan = await buildDryRunPlan({ queueDir: env.queueDir, stateDir: env.stateDir, target });
  assert.equal(plan.packages.every((item) => item.action === "reject_conflicting_duplicate"), true);
});

test("successful apply is idempotent, read back, receipted, and locally archived", async () => {
  const env = await makeEnv("native-v1.valid.json", true);
  const client = new FakeRemNote(target);
  const first = await applyQueue({ ...env, target, client, clock: fixedClock });
  assert.equal(first.ok, true);
  assert.equal(first.results[0].status, "archived");
  assert.equal(client.itemCreateCount, 4);
  assert.equal(await exists(path.join(env.vaultRoot, "staging/article.md")), false);
  assert.equal(await exists(path.join(env.vaultRoot, "archive/article.md")), true);
  const packageData = JSON.parse(await readFile(env.packagePath, "utf8"));
  assert.equal(packageData.importStatus, "imported_and_verified");
  assert.equal(packageData.formalArchive.status, "archived");
  const receipt = JSON.parse(await readFile(first.results[0].receiptPath, "utf8"));
  assert.equal(receipt.readback.verified, true);
  assert.equal(receipt.readback.itemCount, 4);
  assert.equal(receipt.dispositionCoverage.verified, true);
  assert.equal(receipt.dispositionCoverage.total, 4);
  assert.deepEqual(receipt.source, { materialType: "markdown_document", format: "markdown", origin: null });
  const receiptSchema = JSON.parse(await readFile(path.resolve(import.meta.dirname, "../schemas/archive-receipt.v2.schema.json"), "utf8"));
  const validateReceipt = new Ajv2020({ strict: false, validateFormats: false }).compile(receiptSchema);
  assert.equal(validateReceipt(receipt), true, JSON.stringify(validateReceipt.errors));

  const staleStatePath = path.join(env.stateDir, "state.v1.json");
  const staleState = JSON.parse(await readFile(staleStatePath, "utf8"));
  staleState.packages["fixture-article-001"].lastError = { code: "STALE_ERROR" };
  staleState.packages["fixture-article-001"].failedAt = fixedClock().toISOString();
  await writeFile(staleStatePath, `${JSON.stringify(staleState, null, 2)}\n`, "utf8");
  const second = await applyQueue({ ...env, target, client, clock: fixedClock });
  assert.equal(second.ok, true);
  assert.equal(second.results[0].status, "already_archived");
  assert.equal(second.noRemoteWrite, true);
  assert.equal(second.localStateNormalized, true);
  assert.equal(client.itemCreateCount, 4);
  const normalizedState = JSON.parse(await readFile(staleStatePath, "utf8"));
  assert.equal(normalizedState.packages["fixture-article-001"].lastError, undefined);
  assert.equal(normalizedState.packages["fixture-article-001"].failedAt, undefined);
});

test("partial failure preserves verified mappings and retry creates only remaining items", async () => {
  const env = await makeEnv("native-v1.valid.json", true);
  const client = new FakeRemNote(target);
  const failed = await applyQueue({
    ...env,
    target,
    client,
    clock: fixedClock,
    faultInjector: ({ index }) => { if (index === 1) throw new Error("fixture interruption"); }
  });
  assert.equal(failed.ok, false);
  assert.equal(failed.results[0].status, "failed");
  assert.equal(client.itemCreateCount, 1);
  assert.equal(await exists(path.join(env.vaultRoot, "staging/article.md")), true);
  const stateAfterFailure = JSON.parse(await readFile(path.join(env.stateDir, "state.v1.json"), "utf8"));
  assert.equal(Object.keys(stateAfterFailure.packages["fixture-article-001"].itemMappings).length, 1);

  const retried = await applyQueue({ ...env, target, client, clock: fixedClock });
  assert.equal(retried.ok, true);
  assert.equal(client.itemCreateCount, 4);
  assert.equal(retried.results[0].itemResults[0].action, "verified_existing_mapping");
  const stateAfterRetry = JSON.parse(await readFile(path.join(env.stateDir, "state.v1.json"), "utf8"));
  assert.equal(stateAfterRetry.packages["fixture-article-001"].lastError, undefined);
  assert.equal(stateAfterRetry.packages["fixture-article-001"].failedAt, undefined);
});

test("readback mismatch fails closed and does not advance local archive", async () => {
  const env = await makeEnv("native-v1.valid.json", true);
  const client = new FakeRemNote(target, { corruptItemReadback: true });
  const result = await applyQueue({ ...env, target, client, clock: fixedClock });
  assert.equal(result.ok, false);
  assert.equal(result.results[0].error.code, "READBACK_CONTENT_MISMATCH");
  assert.equal(await exists(path.join(env.vaultRoot, "staging/article.md")), true);
  assert.equal(await exists(path.join(env.vaultRoot, "archive/article.md")), false);
  const packageData = JSON.parse(await readFile(env.packagePath, "utf8"));
  assert.equal(packageData.status, "export_package_ready");
  assert.equal(packageData.formalArchive, undefined);
});

test("retry reconciles a RemNote-normalized card created before mapping persistence", async () => {
  const env = await makeEnv("native-v1.valid.json", true);
  const raw = makeNativeV2Package({
    packageId: "normalized-card-retry",
    sourcePath: "staging/article.md",
    localArchive: { state: "export_package_ready", sourcePath: "staging/article.md", archivedSourcePath: "archive/article.md" },
    cards: [{ id: "qa-retry", questionMarkdown: "回读失败后会重复吗？", answerMarkdown: "不会，按稳定 itemKey 对账。", needsQuestionGeneration: false, needsAnswerGeneration: false }],
    articleMusings: []
  });
  await writeFile(env.packagePath, `${JSON.stringify(raw, null, 2)}\n`, "utf8");
  const client = new FakeRemNote(target, { corruptItemReadbackOnce: true });
  const failed = await applyQueue({ ...env, target, client, clock: fixedClock });
  assert.equal(failed.ok, false);
  assert.equal(client.itemCreateCount, 1);
  const retried = await applyQueue({ ...env, target, client, clock: fixedClock });
  assert.equal(retried.ok, true);
  assert.equal(retried.results[0].itemResults[0].action, "reconciled_existing_remote");
  assert.equal(client.itemCreateCount, 1);
});

test("legacy v2 Rem ID mapping is read back instead of duplicated", async () => {
  const env = await makeEnv("legacy-v2.valid.json");
  const raw = JSON.parse(await readFile(env.packagePath, "utf8"));
  raw.remnote = { annotationRemIds: { "legacy-ann-001": "legacy-rem-001" } };
  await writeFile(env.packagePath, `${JSON.stringify(raw, null, 2)}\n`, "utf8");
  const client = new FakeRemNote(target);
  const quoteDocument = [...client.notes.values()].find((note) => note.title === "引用");
  client.notes.set("legacy-rem-001", {
    remId: "legacy-rem-001",
    title: "[IR] Legacy v2 样例 · 摘录 1 · 引用",
    parentRemId: quoteDocument.remId,
    content: "- Obsidian source path：04 Projects/渐进阅读工作流/阅读区/legacy.md"
  });
  const result = await applyQueue({ ...env, target, client, clock: fixedClock });
  assert.equal(result.ok, true);
  assert.equal(result.results[0].itemResults[0].action, "reconciled_legacy_mapping");
  assert.equal(client.itemCreateCount, 0);
});

test("local rollback restores package and staged source without deleting remote notes", async () => {
  const env = await makeEnv("native-v1.valid.json", true);
  const client = new FakeRemNote(target);
  const applied = await applyQueue({ ...env, target, client, clock: fixedClock });
  const rollbackPath = await rollbackLocalReceipt({ receiptPath: applied.results[0].receiptPath, stateDir: env.stateDir, vaultRoot: env.vaultRoot, clock: fixedClock });
  assert.equal(await exists(rollbackPath), true);
  assert.equal(await exists(path.join(env.vaultRoot, "staging/article.md")), true);
  assert.equal(await exists(path.join(env.vaultRoot, "archive/article.md")), false);
  assert.equal(client.itemCreateCount, 4);
  const packageData = JSON.parse(await readFile(env.packagePath, "utf8"));
  assert.equal(packageData.status, "export_package_ready");
});

async function makeEnv(fixtureName, createSource = false) {
  const root = await mkdtemp(path.join(os.tmpdir(), "formal-archive-test-"));
  const queueDir = path.join(root, "queue");
  const stateDir = path.join(root, "state");
  const receiptsDir = path.join(root, "receipts");
  const vaultRoot = path.join(root, "vault");
  await mkdir(queueDir, { recursive: true });
  await mkdir(vaultRoot, { recursive: true });
  const fixture = await readFile(path.join(fixturesDir, fixtureName), "utf8");
  const packagePath = path.join(queueDir, "package.json");
  await writeFile(packagePath, fixture, "utf8");
  if (createSource) {
    await mkdir(path.join(vaultRoot, "staging"), { recursive: true });
    await writeFile(path.join(vaultRoot, "staging/article.md"), "# fixture\n", "utf8");
  }
  return { root, queueDir, stateDir, receiptsDir, vaultRoot, packagePath };
}

async function exists(filePath) {
  try { await stat(filePath); return true; } catch (error) { if (error?.code === "ENOENT") return false; throw error; }
}

class FakeRemNote {
  constructor(exactTarget, options = {}) {
    this.options = options;
    this.corruptItemReadbackRemaining = options.corruptItemReadbackOnce ? 1 : 0;
    this.notes = new Map();
    this.counter = 0;
    this.itemCreateCount = 0;
    this.createPayloads = [];
    this.createdItemIds = new Set();
    this.notes.set(exactTarget.parentRemId, { remId: exactTarget.parentRemId, title: exactTarget.parentTitle, content: "" });
    for (const title of TARGET_DOCUMENTS) {
      const remId = `doc-${++this.counter}`;
      this.notes.set(remId, { remId, title, parentRemId: exactTarget.parentRemId, content: "" });
    }
  }

  async call(name, payload) {
    if (name === "remnote_status") return { connected: true };
    if (name === "remnote_search") {
      return {
        results: [...this.notes.values()].filter((note) => note.parentRemId === payload.parentRemId && note.title.includes(payload.query))
      };
    }
    if (name === "remnote_create_note") {
      const remId = `rem-${++this.counter}`;
      const lines = String(payload.content || "").split(/\r?\n/);
      const rawTitle = payload.title || (lines[0] || "").replace(/^\s*[-*+]\s+/, "");
      const title = rawTitle.replace(/\s*>>>\s*$/, "").replace(/\{\{([^{}]+)\}\}/g, "$1");
      const content = payload.title
        ? payload.content || ""
        : lines.slice(1).map((line) => line.replace(/^ {4}/, "")).filter((line) => line.trim()).join("\n");
      const note = { remId, title, parentRemId: payload.parentId, content };
      if (/\s*>>>\s*$/.test(rawTitle)) note.cardDirection = "forward";
      this.notes.set(remId, note);
      this.createPayloads.push(structuredClone(payload));
      this.createdItemIds.add(remId);
      this.itemCreateCount += 1;
      return { remId };
    }
    if (name === "remnote_read_note") {
      const note = this.notes.get(payload.remId);
      if (!note) throw new Error(`missing fake note ${payload.remId}`);
      if (this.options.corruptItemReadback && this.createdItemIds.has(payload.remId)) return { ...note, content: "corrupted" };
      if (this.corruptItemReadbackRemaining > 0 && this.createdItemIds.has(payload.remId)) {
        this.corruptItemReadbackRemaining -= 1;
        return { ...note, content: "corrupted-once" };
      }
      return { ...note };
    }
    throw new Error(`unsupported fake call: ${name}`);
  }
}

function makeNativeV2Package(overrides = {}) {
  return {
    schema: "progressive-reading.local-ir-export-package/v2",
    packageId: "native-v2-fixture",
    packageRevision: 1,
    status: "export_package_ready",
    title: "Native v2 fixture",
    sourcePath: "staging/native-v2.md",
    source: { materialType: "markdown_document", format: "markdown", origin: null },
    localArchive: {
      state: "export_package_ready",
      sourcePath: "staging/native-v2.md",
      archivedSourcePath: "archive/native-v2.md"
    },
    annotations: [],
    cards: [],
    clozeCards: [],
    articleMusings: [{ id: "musing-1", bodyMarkdown: "随想内容", aiStatus: "pending" }],
    ...overrides
  };
}

function makeNoRemnoteContentConfirmation(overrides = {}) {
  return {
    schema: "progressive-reading.no-remnote-content-confirmation/v1",
    confirmed: true,
    confirmedAt: "2026-08-23T00:00:00.000Z",
    missingElementKinds: ["annotations", "articleMusings", "cards", "clozeCards"],
    ...overrides
  };
}

function makeConfirmedZeroItemPackage(overrides = {}) {
  const sourcePath = overrides.sourcePath || "staging/native-v2.md";
  return makeNativeV2Package({
    sourcePath,
    localArchive: {
      state: "export_package_ready",
      sourcePath,
      archivedSourcePath: sourcePath.replace(/^staging\//, "archive/"),
      noRemnoteContentConfirmation: makeNoRemnoteContentConfirmation()
    },
    annotations: [],
    cards: [],
    clozeCards: [],
    articleMusings: [],
    ...overrides
  });
}
