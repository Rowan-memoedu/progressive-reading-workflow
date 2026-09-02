import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ChromeCookieJar } from "./chrome-cookie-jar.mjs";
import { relocateReadingArtifacts } from "./reading-artifact-relocation.mjs";
import {
  buildProgressiveReadingHandoffCommand,
  discoverZhihuLikesSince,
  unlikeZhihuItems,
  verifyZhihuLikesRemoved
} from "./zhihu-social-archive.mjs";

const STANDARD_IMPORT_BATCH_CONCURRENCY = 3;

const args = parseArgs(process.argv.slice(2));
const baseUrl = await findServiceBase();

if (args.command === "zhihu-likes") {
  const limit = Number(args.limit || 10);
  const receiptPath = path.resolve(args.receipt || path.join("imports", "social-reading-archive", `zhihu-recent-${limit}-${Date.now()}.json`));
  let inventory;
  if (args.resume) {
    inventory = JSON.parse(await fs.readFile(path.resolve(args.resume), "utf8"));
    if (!Array.isArray(inventory.items) || !inventory.items.length) throw new Error("resume_inventory_items_required");
  } else {
    inventory = await requestJson(`${baseUrl}/api/social-archive/zhihu/recent-likes`, {
      method: "POST",
      body: { profile_token: args.profile, limit, action: "preview" }
    });
  }
  const handoffCommand = buildProgressiveReadingHandoffCommand(inventory.urls);
  await atomicWriteJson(receiptPath, { ...inventory, status: "inventory_frozen", receipt_path: receiptPath, handoff_command: handoffCommand });
  if (!args.unlike && !args.resume) {
    console.log(JSON.stringify({ status: "previewed", urls: inventory.urls.length, receipt: receiptPath, handoff_command: handoffCommand }, null, 2));
  } else {
    let result = await requestJson(`${baseUrl}/api/social-archive/zhihu/recent-likes`, {
      method: "POST",
      body: { profile_token: inventory.profile_token, action: "verify", items: inventory.items }
    });
    if (result.status !== "cleanup_verified" && args.unlike) {
      const remainingUrls = new Set(result.verification?.remaining || inventory.urls);
      const remainingItems = inventory.items.filter((item) => remainingUrls.has(item.source_url));
      result = await requestJson(`${baseUrl}/api/social-archive/zhihu/recent-likes`, {
        method: "POST",
        body: {
          profile_token: inventory.profile_token,
          action: "unlike",
          items: remainingItems,
          allow_account_mutation: true
        }
      });
    }
    const finalReceipt = { ...inventory, ...result, receipt_path: receiptPath, handoff_command: handoffCommand };
    await atomicWriteJson(receiptPath, finalReceipt);
    if (result.status !== "cleanup_verified") throw new Error(`zhihu_cleanup_not_verified_${result.status}`);
    console.log(JSON.stringify({ status: result.status, urls: inventory.urls.length, receipt: receiptPath, handoff_command: handoffCommand }, null, 2));
  }
} else if (args.command === "zhihu-likes-since") {
  await runZhihuLikesSince(args, baseUrl, await loadZhihuRuntime());
} else {
  throw new Error("command_required_zhihu-likes_or_zhihu-likes-since");
}

async function runZhihuLikesSince(options, serviceBase, zhihuRuntime) {
  const since = parseShanghaiDate(options.since);
  const destinationFolder = normalizeDestinationFolder(options.destinationFolder || "知乎/知乎点赞");
  const batchSize = Number(options.batchSize || 10);
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 50) throw new Error("batch_size_out_of_range");
  const importConcurrency = Number(options.importConcurrency || STANDARD_IMPORT_BATCH_CONCURRENCY);
  if (!Number.isInteger(importConcurrency) || importConcurrency < 1 || importConcurrency > 4) {
    throw new Error("import_concurrency_out_of_range");
  }
  const repairCycle = Number(options.repairCycle || 0);
  if (!Number.isInteger(repairCycle) || repairCycle < 0 || repairCycle > 99) {
    throw new Error("repair_cycle_out_of_range");
  }
  const runDir = path.resolve(options.runDir || path.join(
    "imports",
    "social-reading",
    "zhihu",
    `${new Date().toISOString().slice(0, 10)}-since-${since.date}`
  ));
  const inventoryPath = path.join(runDir, "inventory.json");
  const runPath = path.join(runDir, "run.json");
  let inventory;
  try {
    inventory = JSON.parse(await fs.readFile(inventoryPath, "utf8"));
    if (inventory.since_epoch !== since.epoch || !Array.isArray(inventory.items)) {
      throw new Error("existing_inventory_scope_mismatch");
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    inventory = await discoverZhihuLikesSince({
      profileToken: options.profile,
      sinceEpoch: since.epoch,
      maxPages: Number(options.maxPages || 200),
      cookieHeaderForUrl: zhihuRuntime.cookieHeaderForUrl
    });
    if (!new Set(["activity_before_since", "feed_end"]).has(inventory.boundary_reason)) {
      throw new Error("zhihu_since_inventory_boundary_unverified");
    }
    await atomicWriteJson(inventoryPath, {
      ...inventory,
      status: "inventory_frozen",
      frozen_at: new Date().toISOString(),
      inventory_path: inventoryPath
    });
  }
  const frozen = { ...inventory, status: "inventory_frozen", inventory_path: inventoryPath };
  await atomicWriteJson(runPath, {
    schema: "local-ir.zhihu-social-archive-run/v1",
    status: options.unlike ? "inventory_frozen" : "previewed",
    since: since.date,
    since_epoch: since.epoch,
    inventory_sha256: frozen.inventory_sha256,
    unique_urls: frozen.urls.length,
    batch_size: batchSize,
    import_concurrency: importConcurrency,
    entry_route: "ai",
    destination_folder: destinationFolder,
    cleanup_requested: options.unlike === true,
    standard_import_requested: options.import === true,
    run_dir: runDir
  });

  if (!options.unlike && !options.import) {
    console.log(JSON.stringify({
      status: "previewed",
      since: since.date,
      urls: frozen.urls.length,
      pages_read: frozen.pages_read,
      boundary: frozen.boundary,
      inventory: inventoryPath,
      run_dir: runDir
    }, null, 2));
    return;
  }
  if (!options.unlike) throw new Error("cleanup_before_standard_import_required_for_this_mode");

  const batches = chunk(frozen.items, batchSize);
  const cleanupReceipts = [];
  for (let index = 0; index < batches.length; index += 1) {
    const batchNumber = index + 1;
    const receiptPath = path.join(runDir, `cleanup-part-${String(batchNumber).padStart(2, "0")}.json`);
    let existing = null;
    try {
      existing = JSON.parse(await fs.readFile(receiptPath, "utf8"));
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    if (existing?.status === "cleanup_verified") {
      cleanupReceipts.push(existing);
      continue;
    }
    const items = batches[index];
    const priorOperations = Array.isArray(existing?.operations) ? existing.operations : [];
    let result = await verifyFrozenZhihuItems(frozen.profile_token, items, zhihuRuntime);
    if (result.status === "cleanup_verified") {
      result = {
        ...result,
        operations: priorOperations,
        mutation_skipped: true,
        verification_basis: "pre_batch_source_readback",
        recovered_prior_operations: priorOperations.length
      };
    }
    if (result.status !== "cleanup_verified") {
      const remainingUrls = new Set(result.verification?.remaining || items.map((item) => item.source_url));
      const mutationItems = items.filter((item) => remainingUrls.has(item.source_url));
      const mutationResult = await cleanupFrozenZhihuItems(frozen.profile_token, mutationItems, zhihuRuntime);
      result = {
        ...mutationResult,
        operations: [...priorOperations, ...(mutationResult.operations || [])],
        resumed_from_partial_receipt: priorOperations.length > 0,
        mutation_urls: mutationItems.map((item) => item.source_url)
      };
      if (mutationResult.status === "cleanup_verified" && mutationItems.length < items.length) {
        const fullVerification = await verifyFrozenZhihuItems(
          frozen.profile_token,
          items,
          zhihuRuntime,
          result.operations
        );
        result = {
          ...result,
          status: fullVerification.status,
          verification: fullVerification.verification,
          full_batch_readback: true
        };
      }
    }
    const receipt = {
      ...result,
      batch_number: batchNumber,
      batch_count: batches.length,
      inventory_sha256: frozen.inventory_sha256,
      urls: items.map((item) => item.source_url),
      receipt_path: receiptPath,
      written_at: new Date().toISOString()
    };
    await atomicWriteJson(receiptPath, receipt);
    if (result.status !== "cleanup_verified") throw new Error(`zhihu_cleanup_batch_${batchNumber}_not_verified_${result.status}`);
    cleanupReceipts.push(receipt);
    console.error(`cleanup ${batchNumber}/${batches.length}: ${items.length} verified`);
  }

  const cleanupVerificationPath = path.join(runDir, "cleanup-verification.json");
  let cleanupVerification = null;
  try {
    const existingCleanupVerification = JSON.parse(await fs.readFile(cleanupVerificationPath, "utf8"));
    if (existingCleanupVerification.status === "cleanup_verified"
      && existingCleanupVerification.inventory_sha256 === frozen.inventory_sha256
      && Number(existingCleanupVerification.original_targets) === frozen.items.length) {
      cleanupVerification = existingCleanupVerification;
      console.error(`cleanup final verification replay: ${frozen.items.length} verified`);
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  if (!cleanupVerification) {
  const rangeVerification = await discoverZhihuLikesSince({
    profileToken: frozen.profile_token,
    sinceEpoch: since.epoch,
    maxPages: Number(options.maxPages || 200),
    cookieHeaderForUrl: zhihuRuntime.cookieHeaderForUrl
  });
  const targetUrls = new Set(frozen.urls);
  const finalTargetChecks = [];
  const remainingTargets = [];
  const allCleanupOperations = cleanupReceipts.flatMap((receipt) => receipt.operations || []);
  const finalCheckBatches = chunk(frozen.items, 50);
  for (let index = 0; index < finalCheckBatches.length; index += 1) {
    const items = finalCheckBatches[index];
    const check = await verifyFrozenZhihuItems(
      frozen.profile_token,
      items,
      zhihuRuntime,
      allCleanupOperations
    );
    finalTargetChecks.push(check);
    remainingTargets.push(...(check.verification?.remaining || items.map((item) => item.source_url)));
    console.error(`cleanup final check ${index + 1}/${finalCheckBatches.length}: ${items.length} verified`);
  }
  const historicalArticleEvents = rangeVerification.items.filter((item) => (
    item.content_type === "article" && targetUrls.has(item.source_url)
  ));
  cleanupVerification = {
    status: remainingTargets.length === 0 ? "cleanup_verified" : "cleanup_unverified",
    since: since.date,
    inventory_sha256: frozen.inventory_sha256,
    original_targets: frozen.items.length,
    remaining_targets: remainingTargets,
    newly_observed_non_targets: rangeVerification.items.filter((item) => !targetUrls.has(item.source_url)).map((item) => item.source_url),
    historical_article_events_observed: historicalArticleEvents.map((item) => item.source_url),
    target_check_receipts: finalTargetChecks,
    reread_pages: rangeVerification.pages_read,
    boundary_reason: rangeVerification.boundary_reason,
    boundary: rangeVerification.boundary,
    batch_receipts: cleanupReceipts.map((item) => item.receipt_path)
  };
  await atomicWriteJson(cleanupVerificationPath, cleanupVerification);
  }
  if (cleanupVerification.status !== "cleanup_verified") throw new Error("zhihu_since_cleanup_not_verified");

  const importReceipts = [];
  let destinationVerification = null;
  if (options.import) {
    const workflowRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    const relocationOptions = {
      readingRoot: path.join(workflowRoot, "阅读区"),
      stateRoot: path.join(workflowRoot, ".local-ir", "browser-document-state"),
      workspaceRoot: path.resolve(workflowRoot, "..", ".."),
      destinationFolder,
      urls: frozen.urls
    };
    const initialRelocation = await relocateReadingArtifacts(relocationOptions);
    await atomicWriteJson(path.join(runDir, "destination-relocation-initial.json"), initialRelocation);
    const urlBatches = chunk(frozen.urls, batchSize);
    const completedBatches = new Array(urlBatches.length);
    let nextBatchIndex = 0;
    const importBatch = async (index) => {
      const batchNumber = index + 1;
      const terminalPath = path.join(runDir, `standard-import-receipt-part-${String(batchNumber).padStart(2, "0")}.json`);
      let terminal = null;
      try {
        terminal = JSON.parse(await fs.readFile(terminalPath, "utf8"));
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
      const clientRequestId = `zhihu-since-${since.date}-${frozen.inventory_sha256.slice(0, 16)}-${String(batchNumber).padStart(2, "0")}`;
      if (!terminal) {
        const request = await requestJson(`${serviceBase}/api/browser-import/requests`, {
          method: "POST",
          body: {
            urls: urlBatches[index],
            source: "archive-social-reading:zhihu-likes-since",
            entry_route: "ai",
            destination_folder: destinationFolder,
            client_request_id: clientRequestId,
            user_instruction: `导入知乎 ${since.date} 以来点赞归档链接；按规范化 URL 全局去重。`
          }
        });
        await atomicWriteJson(path.join(runDir, `standard-import-request-part-${String(batchNumber).padStart(2, "0")}.json`), request);
        terminal = await waitForImportRequest(serviceBase, request.request_id);
        await atomicWriteJson(terminalPath, terminal);
      }
      if (!isSuccessfulStandardImport(terminal, urlBatches[index].length) && terminal?.terminal) {
        terminal = await repairStandardImportBatch({
          serviceBase,
          runDir,
          batchNumber,
          expectedUrls: urlBatches[index],
          clientRequestId,
          terminal,
          repairCycle,
          destinationFolder
        });
        await atomicWriteJson(terminalPath, terminal);
      }
      if (!isSuccessfulStandardImport(terminal, urlBatches[index].length)) {
        throw new Error(`standard_import_batch_${batchNumber}_not_verified_${terminal?.status || "unknown"}`);
      }
      completedBatches[index] = terminal;
      console.error(`import ${batchNumber}/${urlBatches.length}: ${urlBatches[index].length} verified`);
    };
    const worker = async () => {
      while (true) {
        const index = nextBatchIndex;
        nextBatchIndex += 1;
        if (index >= urlBatches.length) return;
        await importBatch(index);
      }
    };
    await Promise.all(Array.from(
      { length: Math.min(importConcurrency, urlBatches.length) },
      () => worker()
    ));
    importReceipts.push(...completedBatches);
    destinationVerification = await relocateReadingArtifacts({ ...relocationOptions, requireComplete: true });
    await atomicWriteJson(path.join(runDir, "destination-relocation-final.json"), destinationVerification);
  }

  const final = {
    schema: "local-ir.zhihu-social-archive-final/v1",
    status: options.import ? "final_verified" : "cleanup_verified",
    since: since.date,
    inventory_sha256: frozen.inventory_sha256,
    unique_urls: frozen.urls.length,
    cleanup: {
      verified: true,
      batches: cleanupReceipts.length,
      remaining_targets: 0
    },
    standard_import: {
      requested: options.import === true,
      verified: options.import ? importReceipts.length === batches.length : false,
      batches: importReceipts.length,
      imported_or_idempotent: importReceipts.reduce((sum, item) => sum + item.results.filter((result) => new Set(["imported", "idempotent_replay"]).has(result.status)).length, 0),
      entry_route: "ai",
      destination_folder: destinationFolder,
      destination_verified: destinationVerification?.verified === true,
      destination_count: destinationVerification?.destination_count || 0,
      source_residue_count: destinationVerification?.source_count || 0,
      global_duplicate_count: destinationVerification?.global_duplicate_count || 0,
      wrong_folder_count: destinationVerification?.wrong_folder_count || 0
    },
    boundary: cleanupVerification.boundary,
    boundary_reason: cleanupVerification.boundary_reason,
    completed_at: new Date().toISOString(),
    run_dir: runDir
  };
  await atomicWriteJson(path.join(runDir, "final-verification.json"), final);
  await atomicWriteJson(runPath, { ...JSON.parse(await fs.readFile(runPath, "utf8")), status: final.status, completed_at: final.completed_at });
  console.log(JSON.stringify(final, null, 2));
}

async function findServiceBase() {
  for (let port = 37829; port <= 37849; port += 1) {
    const base = `http://127.0.0.1:${port}`;
    try {
      const health = await requestJson(`${base}/api/highlights/health`, { timeoutMs: 500 });
      if (health?.status === "ok") return base;
    } catch {
      // Continue within the documented local port range.
    }
  }
  throw new Error("progressive_reading_service_unavailable");
}

async function loadZhihuRuntime() {
  const workflowRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const pointerPath = path.join(workflowRoot, ".local-ir", "cookie-snapshot.path");
  const snapshotPath = String(await fs.readFile(pointerPath, "utf8")).trim();
  if (!path.isAbsolute(snapshotPath)) throw new Error("zhihu_cookie_snapshot_path_invalid");
  const jar = new ChromeCookieJar();
  await jar.loadSnapshotFile(snapshotPath);
  return {
    cookieHeaderForUrl: (url) => jar.headerForUrl(url)
  };
}

async function verifyFrozenZhihuItems(profileToken, items, zhihuRuntime, operationEvidence = []) {
  const verification = await verifyZhihuLikesRemoved({
    profileToken,
    removedItems: items,
    cookieHeaderForUrl: zhihuRuntime.cookieHeaderForUrl
  });
  return reconcileUnverifiableCleanup({
    status: verification.status === "verified" ? "cleanup_verified" : "cleanup_unverified",
    verification
  }, operationEvidence);
}

async function cleanupFrozenZhihuItems(profileToken, items, zhihuRuntime) {
  const operations = await unlikeZhihuItems(items, {
    cookieHeaderForUrl: zhihuRuntime.cookieHeaderForUrl,
    allowAccountMutation: true
  });
  try {
    const verification = await verifyZhihuLikesRemoved({
      profileToken,
      removedItems: items,
      cookieHeaderForUrl: zhihuRuntime.cookieHeaderForUrl
    });
    return reconcileUnverifiableCleanup({
      status: verification.status === "verified" ? "cleanup_verified" : "cleanup_applied_verification_failed",
      operations,
      verification
    }, operations);
  } catch (error) {
    return {
      status: "cleanup_applied_verification_failed",
      operations,
      verification_error: error.message
    };
  }
}

function reconcileUnverifiableCleanup(result, operations) {
  if (result.status === "cleanup_verified") return result;
  const states = [
    ...(result.verification?.answer_states || []),
    ...(result.verification?.article_states || [])
  ];
  const migratedUrls = new Set(states
    .filter((item) => item.state === "migrated_project" && item.voting == null)
    .map((item) => item.source_url));
  const neutralOperationUrls = new Set((operations || [])
    .filter((item) => item.response_verified === true
      && (item.response_state?.voting === 0
        || item.response_state?.is_upped === false
        || item.response_state?.reaction_state === false))
    .map((item) => item.source_url));
  const remaining = result.verification?.remaining || [];
  const reconciled = remaining.filter((url) => migratedUrls.has(url) && neutralOperationUrls.has(url));
  const unresolved = remaining.filter((url) => !reconciled.includes(url));
  if (unresolved.length) return result;
  return {
    ...result,
    status: "cleanup_verified",
    verification: {
      ...result.verification,
      status: "verified_with_api_state_evidence",
      remaining: [],
      migrated_api_state_evidence: reconciled
    }
  };
}

async function requestJson(url, { method = "GET", body = null, timeoutMs = 30000 } = {}) {
  const response = await fetch(url, {
    method,
    headers: body == null ? undefined : { "Content-Type": "application/json" },
    body: body == null ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs)
  });
  const text = await response.text();
  if (!response.ok) throw new Error(JSON.parse(text || "{}").error || `http_${response.status}`);
  return JSON.parse(text || "{}");
}

async function atomicWriteJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  try {
    await fs.rename(temporary, file);
  } catch (error) {
    if (!new Set(["EEXIST", "EPERM"]).has(error?.code)) throw error;
    await fs.rm(file, { force: true });
    await fs.rename(temporary, file);
  }
}

async function waitForImportRequest(serviceBase, requestId) {
  const deadline = Date.now() + 30 * 60 * 1000;
  while (Date.now() < deadline) {
    const request = await requestJson(`${serviceBase}/api/browser-import/requests/${encodeURIComponent(requestId)}`);
    if (request.terminal) return request;
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw new Error(`standard_import_timeout_${requestId}`);
}

async function repairStandardImportBatch({
  serviceBase,
  runDir,
  batchNumber,
  expectedUrls,
  clientRequestId,
  terminal,
  repairCycle = 0,
  destinationFolder
}) {
  let consolidated = terminal;
  const cycleSuffix = repairCycle > 0 ? `-cycle-${String(repairCycle).padStart(2, "0")}` : "";
  const prefix = `standard-import-repair-part-${String(batchNumber).padStart(2, "0")}${cycleSuffix}`;
  await atomicWriteJson(path.join(runDir, `${prefix}-base.json`), terminal);
  for (let attempt = 1; attempt <= 3 && !isSuccessfulStandardImport(consolidated, expectedUrls.length); attempt += 1) {
    const failedUrls = consolidated.results
      .filter((item) => !new Set(["imported", "idempotent_replay"]).has(item.status))
      .map((item) => item.requested_url);
    if (!failedUrls.length) break;
    const requestPath = path.join(runDir, `${prefix}-${String(attempt).padStart(2, "0")}-request.json`);
    const receiptPath = path.join(runDir, `${prefix}-${String(attempt).padStart(2, "0")}-receipt.json`);
    let repair = null;
    try {
      repair = JSON.parse(await fs.readFile(receiptPath, "utf8"));
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    if (!repair?.terminal) {
      const request = await requestJson(`${serviceBase}/api/browser-import/requests`, {
        method: "POST",
        body: {
          urls: failedUrls,
          source: "archive-social-reading:zhihu-likes-since:repair",
          entry_route: "ai",
          destination_folder: destinationFolder,
          client_request_id: `${clientRequestId}-repair${cycleSuffix}-${String(attempt).padStart(2, "0")}`,
          user_instruction: "仅重试前一标准导入批次中的失败 URL；成功 URL 不重复提交。"
        }
      });
      await atomicWriteJson(requestPath, request);
      repair = await waitForImportRequest(serviceBase, request.request_id);
      await atomicWriteJson(receiptPath, repair);
    }
    consolidated = mergeStandardImportReceipts(consolidated, repair, expectedUrls);
    console.error(`import repair ${batchNumber}.${attempt}: ${failedUrls.length} retried`);
  }
  return consolidated;
}

function mergeStandardImportReceipts(base, repair, expectedUrls) {
  const byUrl = new Map((base.results || []).map((item) => [item.requested_url, item]));
  for (const item of repair?.results || []) byUrl.set(item.requested_url, item);
  const results = expectedUrls.map((url) => byUrl.get(url) || { requested_url: url, status: "failed", error: "missing_terminal_result" });
  const imported = results.filter((item) => new Set(["imported", "idempotent_replay"]).has(item.status)).length;
  const degraded = results.filter((item) => new Set(["requires_browser_auth", "requires_js_render"]).has(item.status)).length;
  const failed = results.length - imported - degraded;
  return {
    ...base,
    status: failed > 0 ? "completed_with_failures" : degraded > 0 ? "completed_with_degradations" : "completed",
    terminal: true,
    requested: results.length,
    imported,
    failed,
    degraded,
    active: 0,
    queued: 0,
    results,
    repair_request_ids: [...new Set([...(base.repair_request_ids || []), repair?.request_id].filter(Boolean))]
  };
}

function isSuccessfulStandardImport(receipt, expected) {
  return receipt?.terminal === true
    && receipt.status === "completed"
    && receipt.failed === 0
    && receipt.degraded === 0
    && Array.isArray(receipt.results)
    && receipt.results.length === expected
    && receipt.results.every((item) => new Set(["imported", "idempotent_replay"]).has(item.status));
}

function parseShanghaiDate(value) {
  const date = String(value || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(date)) throw new Error("since_date_required_yyyy_mm_dd");
  const epoch = Math.floor(Date.parse(`${date}T00:00:00+08:00`) / 1000);
  if (!Number.isInteger(epoch) || epoch < 1) throw new Error("since_date_invalid");
  return { date, epoch };
}

function normalizeDestinationFolder(value) {
  const normalized = String(value || "").trim().replaceAll("\\", "/");
  if (!normalized || normalized.startsWith("/") || /^[A-Za-z]:/u.test(normalized)) {
    throw new Error("destination_folder_must_be_relative");
  }
  const segments = normalized.split("/").filter(Boolean);
  if (!segments.length || segments.some((item) => item === "." || item === ".." || /[<>:"\\|?*\u0000-\u001f]/u.test(item))) {
    throw new Error("destination_folder_invalid");
  }
  return segments.join("/");
}

function chunk(values, size) {
  const result = [];
  for (let index = 0; index < values.length; index += size) result.push(values.slice(index, index + size));
  return result;
}

function parseArgs(argv) {
  const result = { command: argv[0] || null };
  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--unlike") result.unlike = true;
    else if (token === "--import") result.import = true;
    else if (token.startsWith("--")) result[toCamel(token.slice(2))] = argv[++index];
    else throw new Error(`unknown_argument_${token}`);
  }
  return result;
}

function toCamel(value) {
  return value.replace(/-([a-z])/gu, (_match, letter) => letter.toUpperCase());
}
