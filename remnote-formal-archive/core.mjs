import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";

export const ENGINE_VERSION = "0.4.0";
export const PLAN_SCHEMA = "progressive-reading.remnote-archive-plan/v2";
export const RECEIPT_SCHEMA = "progressive-reading.remnote-archive-receipt/v2";
export const STATE_SCHEMA = "progressive-reading.remnote-archive-state/v1";
export const NORMALIZED_PACKAGE_SCHEMA = "progressive-reading.local-ir-export-package/v2";
export const TARGET_DOCUMENTS = ["普通评论", "迷思 / 真相", "引用", "联想", "优化", "例子与观点", "问答卡", "挖空卡", "文章随想"];
export const DISPOSITION_KINDS = ["remnote_import", "refined_reading", "codex_question_queue", "derived_to_qa_card"];
export const ARCHIVE_ELEMENT_KINDS = ["annotations", "articleMusings", "cards", "clozeCards"];

export async function buildDryRunPlan({ queueDir, stateDir, target = {} }) {
  const loaded = await loadAndNormalizeQueue(queueDir);
  const state = await loadState(stateDir);
  const duplicateAnalysis = analyzeDuplicates(loaded.valid);
  const packages = loaded.valid.map((entry) => {
    const duplicate = duplicateAnalysis.get(entry.filePath);
    const prior = state.packages[entry.package.packageId];
    let action = entry.package.items.length === 0 ? "archive_without_remnote_items" : "import";
    if (duplicate?.kind === "conflicting") action = "reject_conflicting_duplicate";
    else if (duplicate?.kind === "exact_duplicate") action = "skip_exact_duplicate";
    else if (prior?.status === "archived" && prior.payloadHash === entry.package.payloadHash) action = "skip_already_archived";
    else if (prior && prior.payloadHash !== entry.package.payloadHash) action = "reject_payload_conflict";
    else if (prior?.status === "partial_failure") action = "retry_partial";
    return {
      file: path.basename(entry.filePath),
      packageId: entry.package.packageId,
      packageRevision: entry.package.packageRevision,
      payloadHash: entry.package.payloadHash,
      producerCompatibility: entry.package.producerCompatibility,
      producerStatus: entry.package.producerStatus,
      normalizedStatus: entry.package.status,
      source: entry.package.source,
      action,
      counts: entry.package.counts,
      dispositionSummary: entry.package.dispositionSummary,
      dispositions: entry.package.dispositions,
      warnings: entry.package.warnings,
      remoteMode: entry.package.items.length === 0 ? "no_remnote_content" : "remnote_items",
      noRemnoteContentConfirmation: entry.package.localArchive?.noRemnoteContentConfirmation || null,
      items: entry.package.items.map((item) => ({
        itemKey: item.itemKey,
        sourceId: item.sourceId,
        kind: item.kind,
        targetDocument: item.targetDocument,
        payloadHash: item.payloadHash,
        title: item.title,
        creationMode: item.creationMode,
        cardSyntax: item.kind === "qa_card" ? ">>>" : item.kind === "cloze_card" ? "{{}}" : null,
        legacyRemId: item.legacyRemId || null
      }))
    };
  });
  packages.sort(compareBy((item) => `${item.packageId}\0${item.file}`));
  const invalid = loaded.invalid
    .map((entry) => ({ file: path.basename(entry.filePath), errors: entry.errors }))
    .sort(compareBy((item) => item.file));
  const plan = {
    schema: PLAN_SCHEMA,
    engineVersion: ENGINE_VERSION,
    queueDir: portablePath(queueDir),
    target: {
      parentRemId: target.parentRemId || null,
      parentTitle: target.parentTitle || null,
      childDocuments: [...TARGET_DOCUMENTS]
    },
    summary: summarizePlan(packages, invalid),
    invalid,
    packages
  };
  const { queueDir: _locationSpecificQueueDir, ...hashablePlan } = plan;
  return { ...plan, planHash: sha256(canonicalJson(hashablePlan)) };
}

export async function applyQueue({ queueDir, stateDir, receiptsDir, vaultRoot, target, client, clock = () => new Date(), faultInjector = null }) {
  requireExactTarget(target);
  const plan = await buildDryRunPlan({ queueDir, stateDir, target });
  if (plan.invalid.length > 0 || plan.packages.some((item) => item.action.startsWith("reject_"))) {
    throw new ArchiveError("PLAN_REJECTED", "dry-run 计划包含 schema 或重复冲突，已拒绝写入。", { plan });
  }

  const actionable = plan.packages.filter((item) => item.action === "import" || item.action === "archive_without_remnote_items" || item.action === "retry_partial");
  if (actionable.length === 0) {
    const state = await loadState(stateDir);
    let localStateNormalized = false;
    for (const item of plan.packages) {
      const packageState = state.packages[item.packageId];
      if (packageState?.status !== "archived") continue;
      if (Object.hasOwn(packageState, "lastError")) { delete packageState.lastError; localStateNormalized = true; }
      if (Object.hasOwn(packageState, "failedAt")) { delete packageState.failedAt; localStateNormalized = true; }
    }
    if (localStateNormalized) {
      await mkdir(stateDir, { recursive: true });
      await saveState(stateDir, state);
    }
    return {
      planHash: plan.planHash,
      target: { remId: target.parentRemId, title: target.parentTitle, validated: false },
      results: plan.packages.map((item) => ({
        packageId: item.packageId,
        status: item.action === "skip_already_archived" ? "already_archived" : "exact_duplicate_skipped"
      })),
      ok: true,
      noWrite: !localStateNormalized,
      noRemoteWrite: true,
      localStateNormalized
    };
  }

  await mkdir(stateDir, { recursive: true });
  await mkdir(receiptsDir, { recursive: true });
  const state = await loadState(stateDir);
  const targetInfo = await validateTarget(client, target);
  const loaded = await loadAndNormalizeQueue(queueDir);
  const actionableIds = new Set(actionable.map((item) => item.packageId));
  const requiredDocuments = [...new Set(loaded.valid
    .filter((entry) => actionableIds.has(entry.package.packageId))
    .flatMap((entry) => entry.package.items.map((item) => item.targetDocument)))];
  const documentIds = await ensureTargetDocuments(client, target.parentRemId, requiredDocuments);
  const duplicateAnalysis = analyzeDuplicates(loaded.valid);
  const results = [];

  for (const entry of loaded.valid.sort(compareBy((item) => item.package.packageId))) {
    const duplicate = duplicateAnalysis.get(entry.filePath);
    if (duplicate?.kind === "exact_duplicate") {
      results.push({ packageId: entry.package.packageId, status: "exact_duplicate_skipped", file: entry.filePath });
      continue;
    }
    const prior = state.packages[entry.package.packageId];
    if (prior?.status === "archived" && prior.payloadHash === entry.package.payloadHash) {
      results.push({ packageId: entry.package.packageId, status: "already_archived", receiptPath: prior.receiptPath });
      continue;
    }
    results.push(await applyPackage({
      entry,
      state,
      stateDir,
      receiptsDir,
      vaultRoot,
      target,
      targetInfo,
      documentIds,
      client,
      clock,
      faultInjector
    }));
  }

  const failed = results.filter((item) => item.status === "failed");
  return {
    planHash: plan.planHash,
    target: targetInfo,
    results,
    ok: failed.length === 0,
    noRemoteWrite: results.every((item) => item.noRemoteWrite !== false)
  };
}

async function applyPackage({ entry, state, stateDir, receiptsDir, vaultRoot, target, targetInfo, documentIds, client, clock, faultInjector }) {
  const pkg = entry.package;
  const startedAt = clock().toISOString();
  const packageState = state.packages[pkg.packageId] || {
    payloadHash: pkg.payloadHash,
    status: "export_package_ready",
    itemMappings: {}
  };
  if (packageState.payloadHash !== pkg.payloadHash) {
    throw new ArchiveError("PAYLOAD_CONFLICT", `包 ${pkg.packageId} 与已有状态的 payloadHash 不一致。`);
  }
  state.packages[pkg.packageId] = packageState;
  const itemResults = [];

  try {
    for (let index = 0; index < pkg.items.length; index += 1) {
      const item = pkg.items[index];
      if (faultInjector) await faultInjector({ stage: "before_item", index, item, pkg });
      const mapping = packageState.itemMappings[item.itemKey];
      let remId = mapping?.remId || null;
      let action = "verified_existing_mapping";
      if (remId) {
        if (mapping.verificationMode === "legacy-v2-content") await verifyLegacyItemReadback(client, remId, documentIds[item.targetDocument], item);
        else await verifyItemReadback(client, remId, documentIds[item.targetDocument], item);
      } else if (item.legacyRemId) {
        remId = item.legacyRemId;
        action = "reconciled_legacy_mapping";
        await verifyLegacyItemReadback(client, remId, documentIds[item.targetDocument], item);
        packageState.itemMappings[item.itemKey] = {
          remId,
          targetDocument: item.targetDocument,
          payloadHash: item.payloadHash,
          verificationMode: "legacy-v2-content",
          verifiedAt: clock().toISOString()
        };
        packageState.status = "writing";
        await saveState(stateDir, state);
      } else {
        const matches = await findVerifiedExistingItems(client, item, documentIds[item.targetDocument]);
        if (matches.length > 1) {
          throw new ArchiveError("REMOTE_DUPLICATE", `RemNote 中存在多个同键节点：${item.title}`);
        }
        if (matches.length === 1) {
          remId = matches[0].remId;
          action = "reconciled_existing_remote";
        } else {
          const createPayload = item.creationMode === "markdown_tree"
            ? { parentId: documentIds[item.targetDocument], content: item.creationContent }
            : { title: item.title, parentId: documentIds[item.targetDocument], content: item.content };
          const created = await client.call("remnote_create_note", createPayload);
          remId = firstRemId(created);
          action = "created_and_verified";
          await verifyItemReadback(client, remId, documentIds[item.targetDocument], item);
        }
        packageState.itemMappings[item.itemKey] = {
          remId,
          targetDocument: item.targetDocument,
          payloadHash: item.payloadHash,
          verifiedAt: clock().toISOString()
        };
        packageState.status = "writing";
        await saveState(stateDir, state);
      }
      itemResults.push({ itemKey: item.itemKey, remId, action, verified: true });
    }

    const remoteWritePerformed = itemResults.some((item) => item.action === "created_and_verified");
    const noRemoteWrite = !remoteWritePerformed;
    packageState.status = "remnote_imported_and_verified";
    packageState.remoteOutcome = pkg.items.length === 0 ? "no_remnote_content_confirmed" : "remnote_items_verified";
    packageState.payloadHash = pkg.payloadHash;
    packageState.verifiedAt = clock().toISOString();
    delete packageState.lastError;
    delete packageState.failedAt;
    await saveState(stateDir, state);

    const local = await finalizeLocalArchive({ entry, pkg, stateDir, receiptsDir, vaultRoot, targetInfo, documentIds, itemResults, clock });
    packageState.status = "archived";
    packageState.archivedAt = local.receipt.completedAt;
    packageState.receiptPath = portablePath(local.receiptPath);
    packageState.packageFile = portablePath(entry.filePath);
    await saveState(stateDir, state);
    return {
      packageId: pkg.packageId,
      status: "archived",
      receiptPath: local.receiptPath,
      itemResults,
      remoteOutcome: packageState.remoteOutcome,
      noRemoteWrite
    };
  } catch (error) {
    packageState.status = "partial_failure";
    packageState.lastError = serializeError(error);
    packageState.failedAt = clock().toISOString();
    await saveState(stateDir, state);
    const receiptPath = await writeFailureReceipt({ entry, pkg, receiptsDir, target, itemResults, startedAt, error, clock });
    return { packageId: pkg.packageId, status: "failed", receiptPath, error: serializeError(error), itemResults };
  }
}

async function finalizeLocalArchive({ entry, pkg, stateDir, receiptsDir, vaultRoot, targetInfo, documentIds, itemResults, clock }) {
  const backupsDir = path.join(stateDir, "backups");
  await mkdir(backupsDir, { recursive: true });
  const safeId = safeName(pkg.packageId);
  const backupPath = path.join(backupsDir, `${safeId}--${pkg.payloadHash.slice(0, 12)}.json`);
  await copyFile(entry.filePath, backupPath);

  let sourceMove = null;
  if (pkg.localArchive?.state === "export_package_ready") {
    sourceMove = await finalizeSourceMove(pkg.localArchive, vaultRoot);
  }

  const completedAt = clock().toISOString();
  const remoteWritePerformed = itemResults.some((item) => item.action === "created_and_verified");
  const receiptPath = path.join(receiptsDir, `${safeId}--${pkg.payloadHash.slice(0, 12)}.json`);
  const receipt = {
    schema: RECEIPT_SCHEMA,
    engineVersion: ENGINE_VERSION,
    status: "archived",
    packageId: pkg.packageId,
    packageRevision: pkg.packageRevision,
    payloadHash: pkg.payloadHash,
    packageFile: portablePath(entry.filePath),
    backupPath: portablePath(backupPath),
    producerCompatibility: pkg.producerCompatibility,
    source: pkg.source,
    dispositionCoverage: {
      verified: true,
      total: pkg.dispositions.length,
      summary: pkg.dispositionSummary,
      dispositions: pkg.dispositions
    },
    target: {
      parentRemId: targetInfo.remId,
      parentTitle: targetInfo.title,
      typeDocumentRemIds: documentIds
    },
    remoteOutcome: pkg.items.length === 0
      ? {
          mode: "no_remnote_content",
          remoteWritePerformed: false,
          confirmation: pkg.localArchive.noRemnoteContentConfirmation
        }
      : {
          mode: "remnote_items",
          remoteWritePerformed
        },
    readback: {
      verified: true,
      mode: pkg.items.length === 0 ? "no_remnote_content" : "remnote_items",
      targetVerified: true,
      itemCount: itemResults.length,
      items: itemResults
    },
    localFinalization: {
      status: "archived",
      sourceMove,
      compatibilityWarning: pkg.producerCompatibility === "legacy-v2"
        ? "Local IR 0.7.19 仍在导出时提前使用 archived 标签；本回执只证明正式导入状态，无法追溯改变旧生产者时序。"
        : null
    },
    completedAt
  };
  const raw = JSON.parse(stripBom(await readFile(entry.filePath, "utf8")));
  raw.status = "archived";
  raw.importStatus = "imported_and_verified";
  raw.formalArchive = {
    schema: "progressive-reading.formal-archive-marker/v2",
    status: "archived",
    packageId: pkg.packageId,
    packageRevision: pkg.packageRevision,
    payloadHash: pkg.payloadHash,
    receiptPath: portablePath(receiptPath),
    completedAt,
    remoteOutcome: receipt.remoteOutcome
  };
  await writeJson(entry.filePath, raw);
  await writeJson(receiptPath, receipt);
  return { receipt, receiptPath, backupPath };
}

async function finalizeSourceMove(localArchive, vaultRoot) {
  const from = resolveInside(vaultRoot, localArchive.sourcePath);
  const to = resolveInside(vaultRoot, localArchive.archivedSourcePath);
  const fromExists = await exists(from);
  const toExists = await exists(to);
  if (!fromExists && toExists) {
    return { action: "already_moved", from: portablePath(from), to: portablePath(to) };
  }
  if (!fromExists) throw new ArchiveError("LOCAL_SOURCE_MISSING", `待归档原文不存在：${from}`);
  if (toExists) throw new ArchiveError("LOCAL_ARCHIVE_CONFLICT", `已归档目标已存在：${to}`);
  await mkdir(path.dirname(to), { recursive: true });
  await rename(from, to);
  return { action: "moved_after_readback", from: portablePath(from), to: portablePath(to) };
}

export async function rollbackLocalReceipt({ receiptPath, stateDir, vaultRoot, clock = () => new Date() }) {
  const receipt = JSON.parse(stripBom(await readFile(receiptPath, "utf8")));
  if (![RECEIPT_SCHEMA, "progressive-reading.remnote-archive-receipt/v1"].includes(receipt.schema) || receipt.status !== "archived") {
    throw new ArchiveError("ROLLBACK_RECEIPT_INVALID", "只能回滚已成功的 v1/v2 正式归档回执。");
  }
  await copyFile(receipt.backupPath, receipt.packageFile);
  const move = receipt.localFinalization?.sourceMove;
  if (move?.action === "moved_after_readback") {
    const from = resolveInside(vaultRoot, move.from);
    const to = resolveInside(vaultRoot, move.to);
    if (!(await exists(from)) && await exists(to)) {
      await mkdir(path.dirname(from), { recursive: true });
      await rename(to, from);
    }
  }
  const state = await loadState(stateDir);
  if (state.packages[receipt.packageId]) {
    state.packages[receipt.packageId].status = "local_rolled_back";
    state.packages[receipt.packageId].rolledBackAt = clock().toISOString();
    state.packages[receipt.packageId].rollbackScope = "local_only_remote_rems_preserved";
    await saveState(stateDir, state);
  }
  const rollbackPath = receiptPath.replace(/\.json$/i, ".rollback.json");
  await writeJson(rollbackPath, {
    schema: "progressive-reading.remnote-archive-rollback-receipt/v1",
    packageId: receipt.packageId,
    status: "local_rolled_back",
    remoteRemsPreserved: true,
    rolledBackAt: clock().toISOString(),
    sourceReceipt: portablePath(receiptPath)
  });
  return rollbackPath;
}

export async function loadAndNormalizeQueue(queueDir) {
  const entries = await readdir(queueDir, { withFileTypes: true });
  const files = entries.filter((entry) => entry.isFile() && entry.name.endsWith(".json")).map((entry) => path.join(queueDir, entry.name));
  const valid = [];
  const invalid = [];
  for (const filePath of files.sort()) {
    try {
      const raw = JSON.parse(stripBom(await readFile(filePath, "utf8")));
      const normalized = normalizePackage(raw, filePath);
      const errors = validateNormalizedPackage(normalized);
      if (errors.length > 0) invalid.push({ filePath, errors });
      else valid.push({ filePath, raw, package: normalized });
    } catch (error) {
      invalid.push({ filePath, errors: [error instanceof Error ? error.message : String(error)] });
    }
  }
  return { valid, invalid };
}

export function normalizePackage(raw, filePath = "") {
  const schemaVersion = raw?.schemaVersion;
  const explicitV1 = raw?.schema === "progressive-reading.local-ir-export-package/v1";
  const explicitV2 = raw?.schema === NORMALIZED_PACKAGE_SCHEMA;
  if (schemaVersion !== 2 && !explicitV1 && !explicitV2) {
    throw new ArchiveError("UNSUPPORTED_SCHEMA", `不支持的 Local IR 包 schema：${raw?.schema ?? schemaVersion ?? "missing"}`);
  }
  const producerCompatibility = schemaVersion === 2 ? "legacy-v2" : explicitV2 ? "native-v2" : "native-v1";
  const sourcePath = String(raw.sourcePath || "").trim();
  const packageId = String(raw.packageId || `local-ir-legacy-${sha256(normalizePortable(sourcePath)).slice(0, 24)}`);
  const packageRevision = Number.isInteger(raw.packageRevision) && raw.packageRevision > 0 ? raw.packageRevision : 1;
  const base = {
    schema: NORMALIZED_PACKAGE_SCHEMA,
    packageId,
    packageRevision,
    producerCompatibility,
    producerStatus: String(raw.status || ""),
    status: raw.formalArchive?.status === "archived" ? "archived" : "export_package_ready",
    title: String(raw.title || "").trim(),
    sourcePath,
    source: normalizeSourceDescriptor(raw, sourcePath),
    currentSourcePath: String(raw.currentSourcePath || raw.archivedSourcePath || raw.sourcePath || "").trim(),
    archivedSourcePath: raw.archivedSourcePath ? String(raw.archivedSourcePath) : null,
    localArchive: normalizeLocalArchive(raw.localArchive),
    markdownExportPath: raw.markdownExportPath ? String(raw.markdownExportPath) : null,
    items: [],
    dispositions: [],
    warnings: [],
    sourceFile: filePath ? portablePath(filePath) : null
  };
  if (producerCompatibility === "legacy-v2" && raw.status === "archived" && raw.formalArchive?.status !== "archived") {
    base.warnings.push("legacy_producer_used_archived_before_remnote_verification");
  }
  const annotations = Array.isArray(raw.annotations) ? raw.annotations : [];
  const cards = Array.isArray(raw.cards) ? raw.cards : [];
  const clozeCards = Array.isArray(raw.clozeCards) ? raw.clozeCards : [];
  const articleMusings = Array.isArray(raw.articleMusings) ? raw.articleMusings : [];
  base.sourceElementCounts = {
    annotations: annotations.length,
    articleMusings: articleMusings.length,
    cards: cards.length,
    clozeCards: clozeCards.length
  };
  for (const annotation of annotations) {
    const annotationId = String(annotation?.id || "");
    if (annotation?.importable && annotation.route !== "codex_question_queue" && annotation.route !== "remnote_card" && annotation.route !== "refined_reading" && !annotation.highlightOnly && annotation.type !== "question" && annotation.type !== "qa_card") {
      const item = createItem(base, "annotation", annotationId, normalizeTargetDocument(annotation.targetDocument || annotation.type), renderAnnotationContent(base, annotation), annotation, raw.remnote?.annotationRemIds?.[annotationId]);
      base.items.push(item);
      base.dispositions.push(createDisposition("annotation", annotationId, "remnote_import", "covered", { itemKey: item.itemKey, targetDocument: item.targetDocument }));
    } else if (annotation?.route === "codex_question_queue" || annotation?.type === "question") {
      const artifactPath = raw.questionQueueJsonPath || raw.questionQueueMarkdownPath || null;
      base.dispositions.push(createDisposition("annotation", annotationId, "codex_question_queue", artifactPath ? "covered" : "blocked", { artifactPath }));
    } else if (annotation?.route === "remnote_card" || annotation?.type === "qa_card") {
      const linkedCard = cards.find((card) => card?.sourceAnnotationId === annotationId);
      base.dispositions.push(createDisposition("annotation", annotationId, "derived_to_qa_card", linkedCard ? "covered" : "blocked", { linkedSourceId: linkedCard?.id || null }));
    } else if (annotation?.route === "refined_reading" || annotation?.highlightOnly) {
      const artifactPath = raw.refinedReadingPath || null;
      base.dispositions.push(createDisposition("annotation", annotationId, "refined_reading", artifactPath ? "covered" : "blocked", { artifactPath }));
    } else {
      base.dispositions.push(createDisposition("annotation", annotationId, "unknown", "blocked"));
    }
  }
  const unresolved = cards.filter((card) => !String(card?.questionMarkdown || "").trim() || !String(card?.answerMarkdown || "").trim() || card?.needsQuestionGeneration || card?.needsAnswerGeneration);
  if (unresolved.length > 0) base.warnings.push(`unresolved_qa_cards:${unresolved.length}`);
  for (const card of cards) {
    const cardId = String(card?.id || "");
    if (unresolved.includes(card)) {
      base.dispositions.push(createDisposition("qa_card", cardId, "remnote_import", "blocked", { reason: "unresolved_qa_card" }));
      continue;
    }
    const item = createItem(base, "qa_card", cardId, "问答卡", renderQaCardContent(base, card), card, raw.remnote?.cardRemIds?.[cardId]);
    base.items.push(item);
    base.dispositions.push(createDisposition("qa_card", cardId, "remnote_import", "covered", { itemKey: item.itemKey, targetDocument: item.targetDocument }));
  }
  for (const card of clozeCards) {
    const cardId = String(card?.id || "");
    if (!String(card?.clozeMarkdown || "").trim()) {
      base.dispositions.push(createDisposition("cloze_card", cardId, "remnote_import", "blocked", { reason: "empty_cloze" }));
      continue;
    }
    const item = createItem(base, "cloze_card", cardId, "挖空卡", renderClozeCardContent(base, card), card, raw.remnote?.clozeCardRemIds?.[cardId]);
    base.items.push(item);
    base.dispositions.push(createDisposition("cloze_card", cardId, "remnote_import", "covered", { itemKey: item.itemKey, targetDocument: item.targetDocument }));
  }
  for (const musing of articleMusings) {
    const musingId = String(musing?.id || "");
    if (!String(musing?.bodyMarkdown || "").trim()) {
      base.dispositions.push(createDisposition("article_musing", musingId, "remnote_import", "blocked", { reason: "empty_article_musing" }));
      continue;
    }
    const item = createItem(base, "article_musing", musingId, "文章随想", renderArticleMusingContent(base, musing), musing, raw.remnote?.articleMusingRemIds?.[musingId]);
    base.items.push(item);
    base.dispositions.push(createDisposition("article_musing", musingId, "remnote_import", "covered", { itemKey: item.itemKey, targetDocument: item.targetDocument }));
  }
  base.items.sort(compareBy((item) => item.itemKey));
  base.dispositions.sort(compareBy((item) => `${item.sourceKind}\0${item.sourceId}\0${item.disposition}`));
  base.dispositionSummary = summarizeDispositions(base.dispositions);
  base.counts = {
    importItems: base.items.length,
    annotations: base.items.filter((item) => item.kind === "annotation").length,
    qaCards: base.items.filter((item) => item.kind === "qa_card").length,
    clozeCards: base.items.filter((item) => item.kind === "cloze_card").length,
    articleMusings: base.items.filter((item) => item.kind === "article_musing").length,
    unresolvedQaCards: unresolved.length,
    dispositions: base.dispositions.length,
    blockedDispositions: base.dispositions.filter((item) => item.status !== "covered").length
  };
  const immutable = {
    schema: base.schema,
    packageId: base.packageId,
    packageRevision: base.packageRevision,
    title: base.title,
    sourcePath: base.sourcePath,
    source: base.source,
    localArchive: base.localArchive,
    items: base.items.map(({ itemKey, sourceId, kind, targetDocument, payloadHash, title, content, creationMode, creationContent }) => ({ itemKey, sourceId, kind, targetDocument, payloadHash, title, content, creationMode, creationContent })),
    dispositions: base.dispositions
  };
  base.payloadHash = sha256(canonicalJson(immutable));
  return base;
}

export function validateNormalizedPackage(pkg) {
  const errors = [];
  if (pkg.schema !== NORMALIZED_PACKAGE_SCHEMA) errors.push("schema must be progressive-reading.local-ir-export-package/v2");
  if (!pkg.packageId) errors.push("packageId is required");
  if (!pkg.title) errors.push("title is required");
  if (!pkg.sourcePath) errors.push("sourcePath is required");
  if (!pkg.source?.format) errors.push("source.format is required");
  if (!pkg.source?.materialType) errors.push("source.materialType is required");
  if (!Number.isInteger(pkg.packageRevision) || pkg.packageRevision < 1) errors.push("packageRevision must be a positive integer");
  if (pkg.counts.unresolvedQaCards > 0) errors.push("unresolved QA cards must be resolved before formal archive");
  const noRemnoteItems = pkg.items.length === 0;
  if (noRemnoteItems) {
    errors.push(...validateNoRemnoteContentConfirmation(pkg.localArchive?.noRemnoteContentConfirmation, getMissingArchiveElementKinds(pkg)));
  }
  if (pkg.dispositions.length === 0 && !noRemnoteItems) errors.push("formal archive requires disposition coverage");
  for (const disposition of pkg.dispositions) {
    if (!disposition.sourceId) errors.push(`disposition sourceId is required for ${disposition.sourceKind}`);
    if (!DISPOSITION_KINDS.includes(disposition.disposition)) errors.push(`unsupported disposition: ${disposition.disposition}`);
    if (disposition.status !== "covered") errors.push(`blocked disposition: ${disposition.sourceKind}/${disposition.sourceId}/${disposition.disposition}`);
  }
  const keys = new Set();
  for (const item of pkg.items) {
    if (!item.sourceId) errors.push(`item sourceId is required for ${item.kind}`);
    if (keys.has(item.itemKey)) errors.push(`duplicate itemKey: ${item.itemKey}`);
    keys.add(item.itemKey);
    if (!TARGET_DOCUMENTS.includes(item.targetDocument)) errors.push(`unsupported targetDocument: ${item.targetDocument}`);
  }
  if (pkg.producerCompatibility.startsWith("native-") && pkg.status !== "archived" && pkg.producerStatus !== "export_package_ready") {
    errors.push("native producer status must be export_package_ready");
  }
  if (pkg.producerCompatibility.startsWith("native-")) {
    if (!pkg.localArchive || pkg.localArchive.state !== "export_package_ready") errors.push("native localArchive.state must be export_package_ready");
    for (const [field, value] of Object.entries({ sourcePath: pkg.localArchive?.sourcePath, archivedSourcePath: pkg.localArchive?.archivedSourcePath })) {
      if (!value) errors.push(`native localArchive.${field} is required`);
      else if (path.isAbsolute(value) || normalizePortable(value).split("/").includes("..")) errors.push(`native localArchive.${field} must be vault-relative and cannot traverse parents`);
    }
  }
  return errors;
}

function createItem(pkg, kind, sourceId, targetDocument, body, raw, legacyRemId = null) {
  const normalizedSourceId = String(sourceId || "").trim();
  const itemKey = sha256(`${pkg.packageId}\0${kind}\0${normalizedSourceId}`);
  const rawHumanTitle = kind === "annotation"
    ? `${pkg.title} · 摘录 ${raw.index || ""} · ${raw.typeLabel || targetDocument}`.trim()
    : kind === "qa_card" ? getCardTitle(raw)
      : kind === "cloze_card" ? getClozeCardTitle(raw)
        : `${pkg.title} · 随想 ${raw.index || ""}`.trim();
  const title = normalizeRemNoteReadbackTitle(rawHumanTitle);
  const creationMode = kind === "qa_card" || kind === "cloze_card" ? "markdown_tree" : "note";
  const creationContent = kind === "qa_card"
    ? getQaCardMarkdown(raw)
    : kind === "cloze_card" ? normalizeClozeCardTree(raw) : null;
  const content = String(body || "").trim();
  const payloadHash = sha256(canonicalJson({ kind, sourceId: normalizedSourceId, targetDocument, title, content, creationMode, creationContent }));
  return {
    itemKey,
    sourceId: normalizedSourceId,
    kind,
    targetDocument,
    payloadHash,
    title,
    content,
    creationMode,
    creationContent,
    legacyRemId: legacyRemId ? String(legacyRemId) : null,
    legacyTitleCandidate: rawHumanTitle,
    legacySourcePath: pkg.sourcePath
  };
}

function renderAnnotationContent(data, annotation) {
  const currentText = annotation.expandedText || annotation.currentText || annotation.originalText || "";
  if (annotation.type === "example_viewpoint" || annotation.targetDocument === "例子与观点") {
    return [
      "- 例子", ...indentedText(currentText), "- 观点", ...indentedText(annotation.commentMarkdown || "待补充"),
      "- 原文高亮文本", ...indentedText(annotation.originalText || annotation.currentText || ""),
      "- 对应英文原文", ...indentedText(annotation.bilingual?.englishText || "无")
    ].join("\n");
  }
  return [
    "- 摘录 / 当前文本", ...indentedText(currentText), "- 原文高亮文本", ...indentedText(annotation.originalText || annotation.currentText || ""),
    "- 层级扩展范围", ...indentedText(annotation.scope && annotation.scope !== "selection" ? `${annotation.scope}${Array.isArray(annotation.headingPath) && annotation.headingPath.length ? ` / ${annotation.headingPath.join(" > ")}` : ""}` : "无"),
    "- 对应英文原文", ...indentedText(annotation.bilingual?.englishText || "无"),
    `- 评论结构类型：${annotation.typeLabel || annotation.type || "普通评论"}`, "- 评论内容", ...indentedText(annotation.commentMarkdown || "无"),
    "- 改写稿", ...indentedText(annotation.rewriteMarkdown || "无")
  ].join("\n");
}

function renderQaCardContent(_data, card) {
  return getQaCardMarkdown(card).split(/\r?\n/).slice(1).map((line) => line.replace(/^ {4}/, "")).filter((line) => line.trim()).join("\n");
}

function renderClozeCardContent(_data, card) {
  return normalizeClozeCardTree(card).split(/\r?\n/).slice(1).map((line) => line.replace(/^ {4}/, "")).filter((line) => line.trim()).join("\n");
}

function renderArticleMusingContent(_data, musing) {
  return [
    "- 随想内容",
    ...indentedText(musing.bodyMarkdown)
  ].join("\n");
}

async function validateTarget(client, target) {
  const status = await client.call("remnote_status", {});
  if (!status?.connected) throw new ArchiveError("REMNOTE_NOT_CONNECTED", "RemNote MCP 未连接。");
  const note = await client.call("remnote_read_note", { remId: target.parentRemId, depth: 0, contentMode: "none", view: "compact" });
  if (note?.remId !== target.parentRemId) throw new ArchiveError("TARGET_ID_MISMATCH", "RemNote 父节点回读 ID 不一致。");
  const actualTitle = note.title || note.headline || "";
  if (actualTitle !== target.parentTitle) throw new ArchiveError("TARGET_TITLE_MISMATCH", `RemNote 父节点标题不一致：${actualTitle}`);
  return { remId: note.remId, title: actualTitle };
}

async function ensureTargetDocuments(client, parentRemId, requiredDocuments) {
  const ids = {};
  for (const title of requiredDocuments) {
    const matches = await findExactNotes(client, title, parentRemId);
    if (matches.length > 1) throw new ArchiveError("TARGET_DOCUMENT_DUPLICATE", `目标父节点下有多个同名文档：${title}`);
    let remId = matches[0]?.remId;
    if (!remId) remId = firstRemId(await client.call("remnote_create_note", { title, parentId: parentRemId, asDocument: true }));
    const readback = await client.call("remnote_read_note", { remId, depth: 0, contentMode: "none", view: "compact" });
    if (readback?.remId !== remId || readback?.parentRemId !== parentRemId || (readback.title || readback.headline) !== title) {
      throw new ArchiveError("TARGET_DOCUMENT_READBACK_MISMATCH", `目标文档回读不一致：${title}`);
    }
    ids[title] = remId;
  }
  return ids;
}

async function findExactNotes(client, title, parentRemId) {
  const result = await client.call("remnote_search", { query: title, parentRemId, limit: 20, view: "compact", contentMode: "none", ancestorDepth: 1 });
  return (Array.isArray(result?.results) ? result.results : []).filter((note) => (note.title || note.headline) === title && note.parentRemId === parentRemId);
}

async function findVerifiedExistingItems(client, item, parentRemId) {
  const result = await client.call("remnote_search", { query: item.title, parentRemId, limit: 50, view: "compact", contentMode: "none", ancestorDepth: 1 });
  const candidates = (Array.isArray(result?.results) ? result.results : []).filter((note) => {
    const title = note.title || note.headline || "";
    return note.parentRemId === parentRemId && normalizeRemNoteReadbackTitle(title) === item.title;
  });
  const verified = [];
  for (const candidate of candidates) {
    try {
      await verifyItemReadback(client, candidate.remId, parentRemId, item);
      verified.push(candidate);
    } catch (error) {
      if (!["READBACK_IDENTITY_MISMATCH", "READBACK_CONTENT_MISMATCH", "READBACK_CARD_DIRECTION_MISMATCH", "READBACK_VISIBLE_METADATA"].includes(error?.code)) throw error;
    }
  }
  return verified;
}

async function verifyItemReadback(client, remId, expectedParentId, item) {
  const note = await client.call("remnote_read_note", { remId, depth: 2, childLimit: 100, contentMode: "markdown", view: "full", maxContentLength: 100000 });
  const content = String(note?.content || "");
  const actualTitle = note.title || note.headline || "";
  if (note?.remId !== remId || note?.parentRemId !== expectedParentId || normalizeRemNoteReadbackTitle(actualTitle) !== item.title) {
    throw new ArchiveError("READBACK_IDENTITY_MISMATCH", `RemNote 回读身份不一致：${item.itemKey}`);
  }
  if (item.kind === "qa_card" && note?.cardDirection !== "forward") {
    throw new ArchiveError("READBACK_CARD_DIRECTION_MISMATCH", `RemNote 问答卡方向回读不一致：${item.itemKey}`);
  }
  if (/formalArchive(ItemKey|PayloadHash|PackageId)|source(MaterialType|Format|Origin)|Obsidian source path|aiStatus/i.test(content)) {
    throw new ArchiveError("READBACK_VISIBLE_METADATA", `RemNote 回读包含不应展示的技术元数据：${item.itemKey}`);
  }
  const expectedLines = semanticContentLines(item.content);
  const actualLines = semanticContentLines(content);
  if (canonicalJson(actualLines) !== canonicalJson(expectedLines)) {
    throw new ArchiveError("READBACK_CONTENT_MISMATCH", `RemNote 回读的人类可见内容不一致：${item.itemKey}`);
  }
  return true;
}

async function verifyLegacyItemReadback(client, remId, expectedParentId, item) {
  const note = await client.call("remnote_read_note", { remId, depth: 2, childLimit: 100, contentMode: "markdown", view: "full", maxContentLength: 100000 });
  const title = note?.title || note?.headline || "";
  const content = String(note?.content || "");
  const titleMatches = title === item.legacyTitleCandidate || title === `[IR] ${item.legacyTitleCandidate}`;
  if (note?.remId !== remId || note?.parentRemId !== expectedParentId || !titleMatches) {
    throw new ArchiveError("LEGACY_READBACK_IDENTITY_MISMATCH", `legacy RemNote 映射身份不一致：${item.itemKey}`);
  }
  if (!content.includes(item.legacySourcePath)) {
    throw new ArchiveError("LEGACY_READBACK_CONTENT_MISMATCH", `legacy RemNote 映射缺少来源路径：${item.itemKey}`);
  }
  return true;
}

function analyzeDuplicates(entries) {
  const result = new Map();
  const groups = groupBy(entries, (entry) => entry.package.packageId);
  for (const group of Object.values(groups)) {
    const hashes = new Set(group.map((entry) => entry.package.payloadHash));
    if (hashes.size > 1) {
      for (const entry of group) result.set(entry.filePath, { kind: "conflicting" });
      continue;
    }
    const sorted = [...group].sort(compareBy((entry) => entry.filePath));
    for (let index = 1; index < sorted.length; index += 1) result.set(sorted[index].filePath, { kind: "exact_duplicate", canonicalFile: sorted[0].filePath });
  }
  return result;
}

async function writeFailureReceipt({ entry, pkg, receiptsDir, target, itemResults, startedAt, error, clock }) {
  await mkdir(receiptsDir, { recursive: true });
  const receiptPath = path.join(receiptsDir, `${safeName(pkg.packageId)}--${pkg.payloadHash.slice(0, 12)}--failed.json`);
  await writeJson(receiptPath, {
    schema: RECEIPT_SCHEMA,
    engineVersion: ENGINE_VERSION,
    status: "partial_failure",
    packageId: pkg.packageId,
    packageRevision: pkg.packageRevision,
    payloadHash: pkg.payloadHash,
    packageFile: portablePath(entry.filePath),
    source: pkg.source,
    dispositionCoverage: {
      verified: false,
      total: pkg.dispositions.length,
      summary: pkg.dispositionSummary,
      dispositions: pkg.dispositions
    },
    target,
    itemResults,
    error: serializeError(error),
    startedAt,
    failedAt: clock().toISOString()
  });
  return receiptPath;
}

async function loadState(stateDir) {
  const filePath = path.join(stateDir, "state.v1.json");
  if (!(await exists(filePath))) return { schema: STATE_SCHEMA, engineVersion: ENGINE_VERSION, packages: {} };
  const state = JSON.parse(stripBom(await readFile(filePath, "utf8")));
  if (state.schema !== STATE_SCHEMA || typeof state.packages !== "object") throw new ArchiveError("STATE_SCHEMA_INVALID", `无效状态文件：${filePath}`);
  return state;
}

async function saveState(stateDir, state) {
  await mkdir(stateDir, { recursive: true });
  await writeJson(path.join(stateDir, "state.v1.json"), state);
}

function normalizeLocalArchive(value) {
  if (!value || typeof value !== "object") return null;
  return {
    state: String(value.state || ""),
    sourcePath: String(value.sourcePath || ""),
    archivedSourcePath: String(value.archivedSourcePath || ""),
    noRemnoteContentConfirmation: normalizeNoRemnoteContentConfirmation(value.noRemnoteContentConfirmation)
  };
}

function normalizeNoRemnoteContentConfirmation(value) {
  if (!value || typeof value !== "object") return null;
  return {
    schema: String(value.schema || ""),
    confirmed: value.confirmed === true,
    confirmedAt: String(value.confirmedAt || ""),
    missingElementKinds: (Array.isArray(value.missingElementKinds) ? value.missingElementKinds : []).map((item) => String(item))
  };
}

function getMissingArchiveElementKinds(pkg) {
  return ARCHIVE_ELEMENT_KINDS.filter((kind) => Number(pkg?.sourceElementCounts?.[kind] || 0) === 0);
}

function validateNoRemnoteContentConfirmation(value, expectedMissingKinds) {
  const errors = [];
  if (!value) return ["zero RemNote items require explicit user confirmation"];
  if (value.schema !== "progressive-reading.no-remnote-content-confirmation/v1") {
    errors.push("noRemnoteContentConfirmation.schema is invalid");
  }
  if (value.confirmed !== true) errors.push("noRemnoteContentConfirmation.confirmed must be true");
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(value.confirmedAt) || Number.isNaN(Date.parse(value.confirmedAt))) {
    errors.push("noRemnoteContentConfirmation.confirmedAt must be an ISO date-time");
  }
  const allowed = new Set(ARCHIVE_ELEMENT_KINDS);
  if (!Array.isArray(value.missingElementKinds) || value.missingElementKinds.length === 0) {
    errors.push("noRemnoteContentConfirmation.missingElementKinds must be non-empty");
  } else {
    for (const kind of value.missingElementKinds) {
      if (!allowed.has(kind)) errors.push(`unsupported missing element kind: ${kind}`);
    }
    if (new Set(value.missingElementKinds).size !== value.missingElementKinds.length) {
      errors.push("noRemnoteContentConfirmation.missingElementKinds must be unique");
    }
    if (JSON.stringify(value.missingElementKinds) !== JSON.stringify([...value.missingElementKinds].sort())) {
      errors.push("noRemnoteContentConfirmation.missingElementKinds must be deterministically sorted");
    }
    if (JSON.stringify(value.missingElementKinds) !== JSON.stringify(expectedMissingKinds)) {
      errors.push("noRemnoteContentConfirmation.missingElementKinds must match the package elements");
    }
  }
  return errors;
}

function normalizeSourceDescriptor(raw, sourcePath) {
  const inferred = inferSourceDescriptor(sourcePath);
  return {
    materialType: String(raw?.source?.materialType || raw?.materialType || inferred.materialType).trim(),
    format: String(raw?.source?.format || raw?.sourceFormat || inferred.format).trim(),
    origin: String(raw?.source?.origin || raw?.sourceUrl || raw?.url || inferred.origin || "").trim() || null
  };
}

function inferSourceDescriptor(sourcePath) {
  const normalized = normalizePortable(sourcePath).toLowerCase();
  if (normalized.includes("/pdf/") || normalized.endsWith(".pdf.md")) return { materialType: "document", format: "pdf-derived-markdown", origin: null };
  if (normalized.includes("/word/") || normalized.includes("/docx/") || normalized.endsWith(".docx.md")) return { materialType: "document", format: "word-derived-markdown", origin: null };
  if (normalized.includes("/epub/") || normalized.endsWith(".epub.md")) return { materialType: "book", format: "epub-derived-markdown", origin: null };
  if (normalized.includes("/youtube/") || normalized.includes("youtube")) return { materialType: "video_transcript", format: "youtube-transcript-markdown", origin: null };
  if (normalized.includes("/浏览器高亮/") || normalized.includes("/网页/") || normalized.includes("/知乎/") || normalized.includes("/微信/")) {
    return { materialType: "web_article", format: "web-markdown", origin: null };
  }
  return { materialType: "markdown_document", format: "markdown", origin: null };
}

function createDisposition(sourceKind, sourceId, disposition, status, details = {}) {
  return {
    sourceKind,
    sourceId: String(sourceId || ""),
    disposition,
    status,
    ...details
  };
}

function summarizeDispositions(dispositions) {
  const grouped = groupBy(dispositions, (item) => `${item.disposition}:${item.status}`);
  return Object.fromEntries(Object.entries(grouped).sort(([left], [right]) => left.localeCompare(right, "en")).map(([key, values]) => [key, values.length]));
}

function requireExactTarget(target) {
  if (!target?.parentRemId || !target?.parentTitle) {
    throw new ArchiveError("EXACT_TARGET_REQUIRED", "apply 必须同时提供 --parent-rem-id 和 --parent-title。");
  }
}

function summarizePlan(packages, invalid) {
  const actions = groupBy(packages, (item) => item.action);
  return {
    packageCount: packages.length,
    invalidCount: invalid.length,
    itemCount: packages.reduce((sum, item) => sum + item.items.length, 0),
    actions: Object.fromEntries(Object.entries(actions).map(([key, values]) => [key, values.length]))
  };
}

function normalizeTargetDocument(value) {
  if (value === "问答卡" || value === "qa_card") return "问答卡";
  if (value === "迷思 / 真相" || value === "myth_truth") return "迷思 / 真相";
  if (value === "引用" || value === "sample_quote") return "引用";
  if (value === "联想" || value === "add_viewpoint") return "联想";
  if (value === "优化" || value === "optimize") return "优化";
  if (value === "例子与观点" || value === "example_viewpoint") return "例子与观点";
  return "普通评论";
}

function getCardTitle(card) {
  const markdown = getQaCardMarkdown(card);
  return (markdown.split(/\r?\n/)[0] || "- 待生成问题 >>>").replace(/^-\s*/, "").trim();
}

function getClozeCardTitle(card) {
  return (normalizeClozeCardTree(card).split(/\r?\n/).find((line) => line.trim()) || "- {{待生成挖空}}").replace(/^-\s*/, "").trim();
}

function normalizeRemNoteReadbackTitle(value) {
  return String(value || "")
    .replace(/\s*>>>\s*$/, "")
    .replace(/\{\{([^{}]+)\}\}/g, "$1")
    .trim();
}

function semanticContentLines(value) {
  return String(value || "")
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/^[-*+]\s*/, "").replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

function renderRemNoteMultiLineCard(question, answer) {
  const q = stripIrMarkup(question).replace(/\s+/g, " ").trim() || "待生成问题";
  const answerLines = stripIrMarkup(answer).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  return [`- ${q} >>>`, ...(answerLines.length ? answerLines.map((line) => `    - ${line.replace(/^[-*+]\s+/, "")}`) : ["    - 待生成答案"])].join("\n");
}

function getQaCardMarkdown(card) {
  return renderRemNoteMultiLineCard(card.questionMarkdown || "待生成问题", card.answerMarkdown || "待生成答案");
}

function normalizeClozeCardTree(card) {
  const lines = stripIrMarkup(card.clozeMarkdown || "").split(/\r?\n/).map((line) => line.trimEnd()).filter((line) => line.trim());
  if (lines.length === 0) return "- {{待生成挖空}}";
  const [first, ...rest] = lines;
  const root = /^\s*[-*+]\s+/.test(first) ? first.replace(/^\s*[-*+]\s+/, "- ") : `- ${first.trim()}`;
  return [root, ...rest.map((line) => `    - ${line.trim().replace(/^[-*+]\s+/, "")}`)].join("\n");
}

function stripIrMarkup(value) {
  return String(value || "").replace(/<mark\b[^>]*>/gi, "").replace(/<\/mark>/gi, "").replace(/==([\s\S]*?)==/g, "$1").replace(/\r\n/g, "\n");
}

function indentedText(value) {
  const lines = String(value || "").trim().split(/\r?\n/).filter((line) => line.trim());
  return lines.length ? lines.map((line) => `  - ${line}`) : ["  - 无"];
}

function firstRemId(result) {
  if (Array.isArray(result?.remIds) && result.remIds[0]) return result.remIds[0];
  if (typeof result?.remId === "string") return result.remId;
  throw new ArchiveError("CREATE_NO_REM_ID", `remnote_create_note 未返回 Rem ID：${JSON.stringify(result)}`);
}

function resolveInside(root, candidate) {
  const resolvedRoot = path.resolve(root);
  const resolved = path.isAbsolute(candidate) ? path.resolve(candidate) : path.resolve(resolvedRoot, candidate);
  const relative = path.relative(resolvedRoot, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new ArchiveError("PATH_OUTSIDE_VAULT", `路径超出 vault root：${candidate}`);
  return resolved;
}

async function exists(filePath) {
  try { await stat(filePath); return true; } catch (error) { if (error?.code === "ENOENT") return false; throw error; }
}

async function writeJson(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

function sha256(value) { return createHash("sha256").update(String(value), "utf8").digest("hex"); }
function stripBom(text) { return String(text || "").replace(/^\uFEFF/, ""); }
function normalizePortable(value) { return String(value || "").replace(/\\/g, "/").replace(/^\.\//, ""); }
function portablePath(value) { return normalizePortable(path.resolve(value)); }
function safeName(value) { return String(value).replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 120); }
function compareBy(getValue) { return (left, right) => String(getValue(left)).localeCompare(String(getValue(right)), "en"); }
function groupBy(items, getKey) { return items.reduce((acc, item) => { const key = getKey(item); (acc[key] ??= []).push(item); return acc; }, {}); }
function serializeError(error) { return { code: error?.code || "UNEXPECTED_ERROR", message: error instanceof Error ? error.message : String(error) }; }

export class ArchiveError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.name = "ArchiveError";
    this.code = code;
    this.details = details;
  }
}
