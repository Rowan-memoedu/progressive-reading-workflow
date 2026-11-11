import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { youtubeVideoIdentity } from "./url-import-input.mjs";
import { buildPreprocessRequest, standardWorkflowOptions, validateRequestContract } from "../standard-preprocessing/index.mjs";
import { stableJson } from "../standard-preprocessing/lib/core.mjs";

const SCHEMA = "local-ir.browser-import-broker/v1";
export const DEFAULT_LEASE_MS = 12 * 60 * 1000;
export const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_RETRY_DELAY_MS = 1000;
const MAX_REQUESTS = 200;
export const BACKGROUND_FETCH_TRANSPORT = "background_fetch";
const DEGRADED_STATUSES = new Set(["requires_browser_auth", "requires_js_render"]);
const INPUT_REQUIRED = "needs_classification";

async function checkedProcessingOptions(value = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid_processing_options");
  const validation = await validateRequestContract(buildPreprocessRequest({ markdown: "validate", sourceType: "validation", processingOptions: standardWorkflowOptions(value) }));
  if (!validation.valid) throw new Error("invalid_processing_options:" + JSON.stringify(validation));
  return structuredClone(value);
}
export const URL_IMPORT_EXECUTION_CONTRACT = Object.freeze({
  schema: "local-ir.url-import-execution/v1",
  created_task: { transport: BACKGROUND_FETCH_TRANSPORT, status: "queued" },
  service_claim: { transport: BACKGROUND_FETCH_TRANSPORT, status: "queued" },
  extension_claim: { enabled: false, worker_status: "retired", claimable_statuses: [] },
  terminal_degraded_statuses: ["requires_browser_auth", "requires_js_render"]
});

function nowIso(now) {
  return new Date(now()).toISOString();
}

function terminalTask(task) {
  return task.status === "imported" || task.status === "failed" || task.status === INPUT_REQUIRED || DEGRADED_STATUSES.has(task.status);
}

function normalizeTransport(value) {
  return BACKGROUND_FETCH_TRANSPORT;
}

export function normalizeProcessingMode(value = 'standard_preprocess') {
  if (!['standard_preprocess','original_text'].includes(value)) throw new Error('unsupported_url_processing_mode');
  return value;
}

function normalizedUrlIdentity(value) {
  const video = youtubeVideoIdentity(value);
  if (video) return video.url;
  try {
    const parsed = new URL(String(value || ""));
    parsed.hash = "";
    const trackingKeys = [];
    parsed.searchParams.forEach((_item, key) => {
      if (/^utm_/iu.test(key) || /^(?:fbclid|gclid|mc_cid|mc_eid)$/iu.test(key)) trackingKeys.push(key);
    });
    for (const key of trackingKeys) parsed.searchParams.delete(key);
    parsed.searchParams.sort();
    if (parsed.pathname.length > 1) parsed.pathname = parsed.pathname.replace(/\/+$/u, "");
    return parsed.toString();
  } catch {
    return String(value || "").trim();
  }
}

function sanitizePersistedValue(value) {
  if (Array.isArray(value)) return value.map(sanitizePersistedValue);
  if (!value || typeof value !== "object") return value;
  const clean = {};
  for (const [key, item] of Object.entries(value)) {
    if (/^(?:cookie|cookies|set-cookie|cookie_header|cookieHeader)$/iu.test(key)) continue;
    clean[key] = sanitizePersistedValue(item);
  }
  return clean;
}

function normalizeTask(task, maxAttempts) {
  const degraded = DEGRADED_STATUSES.has(task?.status);
  return {
    ...task,
    attempts: Math.max(0, Number(task?.attempts || 0)),
    maxAttempts: Math.max(1, Number(task?.maxAttempts || maxAttempts)),
    availableAt: task?.availableAt || task?.createdAt || new Date(0).toISOString(),
    workerId: degraded ? null : task?.workerId || null,
    claimedAt: degraded ? null : task?.claimedAt || null,
    leaseToken: degraded ? null : task?.leaseToken || null,
    claimRequestId: degraded ? null : task?.claimRequestId || null,
    transport: normalizeTransport(task?.transport),
    source: String(task?.source || "unknown"),
    userInstruction: String(task?.userInstruction || ""),
    entryRoute: String(task?.entryRoute || "default"),
    destinationFolder: String(task?.destinationFolder || ""),
    processingMode: normalizeProcessingMode(task?.processingMode),
    processingOptions: structuredClone(task?.processingOptions || {}),
    handoffStatus: null,
    result: sanitizePersistedValue(task?.result)
  };
}

function taskReceipt(task) {
  return {
    id: task.id,
    request_id: task.requestId,
    requested_url: task.requestedUrl,
    claimed_at: task.claimedAt,
    lease_token: task.leaseToken,
    attempt: task.attempts,
    max_attempts: task.maxAttempts,
    transport: task.transport,
    source: task.source,
    user_instruction: task.userInstruction,
    entry_route: task.entryRoute,
    destination_folder: task.destinationFolder,
    processing_mode: task.processingMode || 'standard_preprocess',
    processing_options: structuredClone(task.processingOptions || {}),
    ...(task.siteImport ? {site_import:structuredClone(task.siteImport)} : {}),
    ...(task.articleSource ? {article_source:structuredClone(task.articleSource)} : {}),
    capture_mode: task.browserSnapshot ? "page_snapshot" : "url_fetch",
    ...(task.result?.receipt?.pending_input_path ? { pending_input_path: task.result.receipt.pending_input_path } : {}),
    ...(task.result?.collection ? { collection: sanitizePersistedValue(task.result.collection) } : {})
  };
}

export class BrowserImportBroker {
  constructor({
    stateRoot,
    now = () => Date.now(),
    leaseMs = DEFAULT_LEASE_MS,
    maxAttempts = DEFAULT_MAX_ATTEMPTS,
    retryDelayMs = DEFAULT_RETRY_DELAY_MS,
    concurrency = 1
  } = {}) {
    if (!stateRoot) throw new Error("browser_import_broker_state_root_required");
    this.stateRoot = path.resolve(stateRoot);
    this.statePath = path.join(this.stateRoot, "state.json");
    this.now = now;
    this.leaseMs = leaseMs;
    this.maxAttempts = Math.max(1, Number(maxAttempts || DEFAULT_MAX_ATTEMPTS));
    this.retryDelayMs = Math.max(0, Number(retryDelayMs || 0));
    const requestedConcurrency = Number(concurrency || 1);
    this.concurrency = Number.isFinite(requestedConcurrency)
      ? Math.max(1, Math.min(8, Math.floor(requestedConcurrency)))
      : 1;
    this.state = { schema: SCHEMA, requests: [], tasks: [] };
    this.initialized = false;
    this.lock = Promise.resolve();
    this.waiters = new Set();
  }

  async initialize() {
    if (this.initialized) return;
    await fs.mkdir(this.stateRoot, { recursive: true });
    try {
      const parsed = JSON.parse(await fs.readFile(this.statePath, "utf8"));
      if (parsed?.schema === SCHEMA && Array.isArray(parsed.requests) && Array.isArray(parsed.tasks)) {
        const requiresMigration = parsed.requests.some((request) => request.transport !== BACKGROUND_FETCH_TRANSPORT)
          || parsed.tasks.some((task) => task.transport !== BACKGROUND_FETCH_TRANSPORT || task.handoffStatus || task.result?.cookie || task.result?.cookies);
        this.state = {
          ...parsed,
          requests: parsed.requests.map((request) => ({ ...request, transport: BACKGROUND_FETCH_TRANSPORT })),
          tasks: parsed.tasks.map((task) => normalizeTask(task, this.maxAttempts))
        };
        if (requiresMigration) await this.save();
      }
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    this.initialized = true;
  }

  async withLock(operation) {
    const run = this.lock.then(async () => {
      await this.initialize();
      return operation();
    });
    this.lock = run.catch(() => undefined);
    return run;
  }

  async save() {
    const temporary = `${this.statePath}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(temporary, `${JSON.stringify(this.state, null, 2)}\n`, "utf8");
    try {
      await fs.rename(temporary, this.statePath);
    } catch (error) {
      if (!new Set(["EEXIST", "EPERM"]).has(error?.code)) throw error;
      await fs.rm(this.statePath, { force: true });
      await fs.rename(temporary, this.statePath);
    }
  }

  notifyWaiters() {
    for (const resolve of this.waiters) resolve();
    this.waiters.clear();
  }

  async createRequest(urls, {
    source = "unknown",
    clientRequestId = null,
    userInstruction = "",
    entryRoute = "default",
    destinationFolder = "",
    processingMode = 'standard_preprocess',
    processingOptions = {},
    browserSnapshot = null,
    siteImport = null,
    articleSource = null,
    subscriptionMaterialId = null
  } = {}) {
    const normalizedMode = normalizeProcessingMode(processingMode);
    if(subscriptionMaterialId!==null&&!/^[A-Za-z0-9_.-]{1,120}$/u.test(subscriptionMaterialId))throw new Error('invalid_subscription_material_id');
    const normalizedOptions = await checkedProcessingOptions(processingOptions);
    return this.withLock(async () => {
      const normalized = [...new Set((urls || []).map((value) => String(value || "").trim()).filter(Boolean))];
      if (!normalized.length) throw new Error("browser_import_urls_required");
      if (browserSnapshot && (normalized.length !== 1 || normalizedUrlIdentity(browserSnapshot.draft?.url) !== normalizedUrlIdentity(normalized[0]))) throw new Error("browser_snapshot_url_mismatch");
      const normalizedClientRequestId = String(clientRequestId || "").trim() || null;
      if (normalizedClientRequestId) {
        const existing = this.state.requests.find((item) => item.clientRequestId === normalizedClientRequestId);
        if (existing) {
          if((existing.subscriptionMaterialId||null)!==subscriptionMaterialId)throw new Error('browser_import_client_request_context_conflict');
          if (normalizeProcessingMode(existing.processingMode)!==normalizedMode) throw new Error('browser_import_client_request_mode_conflict');
          if (stableJson(existing.processingOptions || {}) !== stableJson(normalizedOptions)) throw new Error('browser_import_client_request_options_conflict');
          return this.requestSummary(existing.id);
        }
      }
      const createdAt = nowIso(this.now);
      const normalizedTransport = BACKGROUND_FETCH_TRANSPORT;
      const request = {
        id: `browser-import-request-${randomUUID()}`,
        source,
        clientRequestId: normalizedClientRequestId,
        transport: normalizedTransport,
        userInstruction: String(userInstruction || ""),
        entryRoute: String(entryRoute || "default"),
        destinationFolder: String(destinationFolder || ""),
        processingMode: normalizedMode,
        processingOptions: normalizedOptions,
        ...(subscriptionMaterialId?{subscriptionMaterialId}:{}),
        createdAt,
        updatedAt: createdAt
      };
      this.state.requests.push(request);
      for (const url of normalized) {
        const taskId = `browser-import-task-${randomUUID()}`;
        if (browserSnapshot) {
          await fs.mkdir(path.join(this.stateRoot, "snapshots"), { recursive: true });
          await fs.writeFile(path.join(this.stateRoot, "snapshots", `${taskId}.json`), JSON.stringify(sanitizePersistedValue(browserSnapshot)), "utf8");
        }
        this.state.tasks.push({
          id: taskId,
          browserSnapshot: Boolean(browserSnapshot),
          requestId: request.id,
          requestedUrl: url,
          source: String(source || "unknown"),
          transport: normalizedTransport,
          userInstruction: String(userInstruction || ""),
          entryRoute: String(entryRoute || "default"),
          destinationFolder: String(destinationFolder || ""),
          processingMode: normalizedMode,
          processingOptions: normalizedOptions,
          ...(siteImport ? {siteImport:structuredClone(siteImport)} : {}),
          ...(articleSource ? {articleSource:structuredClone(articleSource)} : {}),
          status: "queued",
          attempts: 0,
          maxAttempts: this.maxAttempts,
          availableAt: createdAt,
          workerId: null,
          claimedAt: null,
          leaseToken: null,
          claimRequestId: null,
          createdAt,
          updatedAt: createdAt,
          result: null,
          error: null
        });
      }
      if (this.state.requests.length > MAX_REQUESTS) {
        const removable = this.state.requests
          .filter((item) => { const summary = this.requestSummary(item.id); return summary?.terminal && !summary.awaiting_input; })
          .slice(0, this.state.requests.length - MAX_REQUESTS);
        const ids = new Set(removable.map((item) => item.id));
        this.state.requests = this.state.requests.filter((item) => !ids.has(item.id));
        this.state.tasks = this.state.tasks.filter((item) => !ids.has(item.requestId));
      }
      await this.save();
      this.notifyWaiters();
      return this.requestSummary(request.id);
    });
  }

  recoverExpiredClaims() {
    const cutoff = this.now() - this.leaseMs;
    let changed = false;
    for (const task of this.state.tasks) {
      if (task.status !== "claimed" || !task.claimedAt || Date.parse(task.claimedAt) > cutoff) continue;
      const exhausted = Number(task.attempts || 0) >= Number(task.maxAttempts || this.maxAttempts);
      task.status = exhausted ? "failed" : "queued";
      task.workerId = null;
      task.claimedAt = null;
      task.leaseToken = null;
      task.claimRequestId = null;
      task.availableAt = nowIso(this.now);
      if (exhausted) task.error = "browser_import_worker_lease_expired_after_max_attempts";
      task.updatedAt = nowIso(this.now);
      changed = true;
    }
    return changed;
  }

  async recoverExitedSourceWorkers(previousOwnerPid, {before=this.now(),isAlive=pid=>{
    try{process.kill(pid,0);return true;}catch(error){if(error.code==='ESRCH')return false;return true;}
  }}={}) {
    if(!Number.isSafeInteger(previousOwnerPid)||previousOwnerPid<=0||previousOwnerPid===process.pid||isAlive(previousOwnerPid))return {recovered:0};
    return this.withLock(async()=>{
      let recovered=0;
      for(const task of this.state.tasks){
        // Only frozen source captures / repository discovery are model-free.
        // Ordinary model jobs keep their original lease and retry semantics.
        if(task.status!=='claimed'||task.processingMode!=='original_text'||!/^local-background-url-fetcher-/u.test(task.workerId||'')
          || !(task.articleSource?.run_id || task.siteImport?.settings?.repository || (task.siteImport && task.result?.collection?.inventory?.complete))
          || !(Date.parse(task.claimedAt)<before))continue;
        task.interruptedClaims=[...(task.interruptedClaims||[]),{previous_owner_pid:previousOwnerPid,claimed_at:task.claimedAt,recovered_at:nowIso(this.now)}].slice(-25);
        task.status='queued';task.workerId=null;task.claimedAt=null;task.leaseToken=null;task.claimRequestId=null;
        // A proven process interruption is recorded separately from failed work.
        task.attempts=Math.max(0,Number(task.attempts||0)-1);
        task.availableAt=nowIso(this.now);task.updatedAt=task.availableAt;recovered++;
      }
      if(recovered){await this.save();this.notifyWaiters();}
      return {recovered};
    });
  }

  async claimTask(workerId, claimRequestId = null, { transport = null, requestId = null } = {}) {
    return this.withLock(async () => {
      const recovered = this.recoverExpiredClaims();
      const normalizedWorkerId = String(workerId || "browser-extension");
      const normalizedClaimRequestId = String(claimRequestId || "").trim() || null;
      if (transport && transport !== BACKGROUND_FETCH_TRANSPORT) throw new Error("browser_import_claim_transport_not_supported");
      const normalizedTransport = transport ? normalizeTransport(transport) : null;
      if (normalizedClaimRequestId) {
        const existing = this.state.tasks.find((item) => item.status === "claimed"
          && item.workerId === normalizedWorkerId
          && item.claimRequestId === normalizedClaimRequestId
          && (!normalizedTransport || item.transport === normalizedTransport)
          && (!requestId || item.requestId === requestId));
        if (existing) {
          if (recovered) await this.save();
          return taskReceipt(existing);
        }
      }
      const now = this.now();
      const task = this.state.tasks.find((item) => {
        if (requestId && item.requestId !== requestId) return false;
        return item.status === "queued"
          && Date.parse(item.availableAt || 0) <= now
          && (!normalizedTransport || item.transport === normalizedTransport);
      });
      if (!task) {
        if (recovered) await this.save();
        return null;
      }
      task.status = "claimed";
      task.attempts = Math.max(0, Number(task.attempts || 0)) + 1;
      task.workerId = normalizedWorkerId;
      task.claimedAt = nowIso(this.now);
      task.leaseToken = randomUUID();
      task.claimRequestId = normalizedClaimRequestId;
      task.updatedAt = task.claimedAt;
      await this.save();
      return taskReceipt(task);
    });
  }

  async getTaskSnapshot(taskId) {
    return this.withLock(async () => {
      const task = this.state.tasks.find(item => item.id === taskId);
      if (!task?.browserSnapshot) return null;
      return JSON.parse(await fs.readFile(path.join(this.stateRoot, "snapshots", `${task.id}.json`), "utf8"));
    });
  }

  async updateTaskProgress(taskId, result, leaseToken) {
    return this.withLock(async () => {
      const task = this.state.tasks.find(item => item.id === taskId);
      if (!task || task.status !== "claimed" || task.leaseToken !== leaseToken) throw new Error("browser_import_task_stale_lease");
      task.result = { ...(task.result || {}), ...sanitizePersistedValue(result) };
      task.claimedAt = nowIso(this.now);
      task.updatedAt = task.claimedAt;
      await this.save();
    });
  }

  async completeTask(taskId, {
    ok,
    result = null,
    error = null,
    retryable = false,
    leaseToken = null,
    degradedStatus = null
  } = {}) {
    return this.withLock(async () => {
      const task = this.state.tasks.find((item) => item.id === taskId);
      if (!task) throw new Error("browser_import_task_not_found");
      if (terminalTask(task)) return this.requestSummary(task.requestId);
      if (leaseToken && task.leaseToken && leaseToken !== task.leaseToken) {
        throw new Error("browser_import_task_stale_lease");
      }
      const normalizedDegradedStatus = DEGRADED_STATUSES.has(degradedStatus) || degradedStatus === INPUT_REQUIRED ? degradedStatus : null;
      const canRetry = !normalizedDegradedStatus && !ok && retryable && Number(task.attempts || 0) < Number(task.maxAttempts || this.maxAttempts);
      task.status = normalizedDegradedStatus || (ok ? "imported" : canRetry ? "queued" : "failed");
      task.result = sanitizePersistedValue(result);
      task.error = ok ? null : String(error || normalizedDegradedStatus || "browser_import_failed");
      task.workerId = null;
      task.claimedAt = null;
      task.leaseToken = null;
      task.claimRequestId = null;
      task.availableAt = canRetry
        ? new Date(this.now() + this.retryDelayMs * Math.max(1, Number(task.attempts || 1))).toISOString()
        : nowIso(this.now);
      task.updatedAt = nowIso(this.now);
      const request = this.state.requests.find((item) => item.id === task.requestId);
      if (request) request.updatedAt = task.updatedAt;
      await this.save();
      this.notifyWaiters();
      return this.requestSummary(task.requestId);
    });
  }

  requestSummary(requestId) {
    const request = this.state.requests.find((item) => item.id === requestId);
    if (!request) return null;
    const tasks = this.state.tasks.filter((item) => item.requestId === requestId);
    const imported = tasks.filter((item) => item.status === "imported").length;
    const failed = tasks.filter((item) => item.status === "failed").length;
    const requiresBrowserAuth = tasks.filter((item) => item.status === "requires_browser_auth").length;
    const requiresJsRender = tasks.filter((item) => item.status === "requires_js_render").length;
    const needsClassification = tasks.filter(item => item.status === INPUT_REQUIRED).length;
    const degraded = requiresBrowserAuth + requiresJsRender;
    const active = tasks.filter((item) => item.status === "claimed").length;
    const queued = tasks.filter((item) => item.status === "queued").length;
    const warnings = tasks.filter((item) => item.status === "imported" && item.result?.receipt?.quality_status === "warning").length;
    const terminal = imported + failed + degraded + needsClassification === tasks.length;
    let status = active > 0 ? "processing" : "queued";
    if (terminal) {
      if (needsClassification > 0) status = INPUT_REQUIRED;
      else if (failed > 0) status = imported + degraded > 0 ? "completed_with_failures" : "failed";
      else if (degraded > 0 && imported > 0) status = "completed_with_degradations";
      else if (requiresBrowserAuth === tasks.length) status = "requires_browser_auth";
      else if (requiresJsRender === tasks.length) status = "requires_js_render";
      else if (degraded > 0) status = "degraded";
      else status = warnings > 0 ? "completed_with_warnings" : "completed";
    }
    return {
      request_id: request.id,
      source: request.source,
      ...(request.subscriptionMaterialId?{subscription_material_id:request.subscriptionMaterialId}:{}),
      client_request_id: request.clientRequestId || null,
      entry_route: request.entryRoute || "default",
      destination_folder: request.destinationFolder || "",
      processing_mode: request.processingMode || 'standard_preprocess',
      processing_options: request.processingOptions || {},
      transport: request.transport || BACKGROUND_FETCH_TRANSPORT,
      status,
      terminal,
      awaiting_input: needsClassification > 0,
      needs_classification: needsClassification,
      requested: tasks.length,
      imported,
      failed,
      degraded,
      warnings,
      concurrency: Math.min(this.concurrency, Math.max(1, tasks.length)),
      requires_browser_auth: requiresBrowserAuth,
      requires_js_render: requiresJsRender,
      active,
      queued,
      created_at: request.createdAt,
      updated_at: request.updatedAt,
      results: tasks.map((task) => ({
        task_id: task.id,
        requested_url: task.requestedUrl,
        transport: task.transport,
        status: task.status === "imported" ? String(task.result?.status || "imported") : task.status,
        ...(task.result?.final_url ? { final_url: task.result.final_url } : {}),
        ...(task.result?.redirect_chain ? { redirect_chain: task.result.redirect_chain } : {}),
        ...(task.result?.source_metadata ? { source_metadata: task.result.source_metadata } : {}),
        ...(task.result?.artifacts ? { artifacts: task.result.artifacts } : {}),
        ...(task.result?.receipt ? { receipt: task.result.receipt } : {}),
        ...(task.result?.errors ? { errors: task.result.errors } : {}),
        ...(task.result?.warnings ? { warnings: task.result.warnings } : {}),
        ...(task.result?.stage ? { stage: task.result.stage } : {}),
        ...(task.result?.collection ? { collection: task.result.collection } : {}),
        ...(task.error ? { error: task.error } : {}),
        attempt_count: Number(task.attempts || 0),
        max_attempts: Number(task.maxAttempts || this.maxAttempts)
      }))
    };
  }

  async resumeClassification(requestId, { processingOptions = {}, urls = null } = {}) {
    const additions = await checkedProcessingOptions(processingOptions);
    if (!Object.keys(additions).length) throw new Error("classification_information_required");
    return this.withLock(async () => {
      const request = this.state.requests.find(item => item.id === requestId);
      if (!request) throw new Error("browser_import_request_not_found");
      const selected = urls ? new Set(urls.map(normalizedUrlIdentity)) : null;
      const requeue = task => {
        if (task.status !== INPUT_REQUIRED) return;
        task.processingOptions = { ...task.processingOptions, ...additions };
        task.status = "queued";
        task.error = null;
        task.attempts = Math.max(0, task.attempts - 1);
        task.availableAt = task.updatedAt = nowIso(this.now);
        for (const batch of task.result?.collection?.batches || []) {
          const children = this.state.tasks.filter(item => item.requestId === batch.request_id && item.status === INPUT_REQUIRED);
          if (children.length) batch.terminal = false;
          children.forEach(requeue);
        }
      };
      for (const task of this.state.tasks) {
        if (task.requestId !== requestId || task.status !== INPUT_REQUIRED || (selected && !selected.has(normalizedUrlIdentity(task.requestedUrl)))) continue;
        requeue(task);
      }
      request.updatedAt = nowIso(this.now);
      await this.save();
      this.notifyWaiters();
      return this.requestSummary(requestId);
    });
  }

  async getRequest(requestId) {
    return this.withLock(async () => this.requestSummary(requestId));
  }

  async listRequestSummaries({sources=null,limit=25}={}) {
    return this.withLock(()=>this.state.requests.filter(request=>!sources||sources.includes(request.source)).slice(-limit).reverse().map(request=>this.requestSummary(request.id)));
  }

  async relocateSourceArtifacts(entries,hashEntries){
    const {remapReceipts}=await import('../site-import/organization.mjs');
    return this.withLock(async()=>{const mapping=new Map(entries),hashes=new Map(hashEntries);for(const task of this.state.tasks)if(task.result)task.result=remapReceipts(task.result,mapping,path.dirname(path.dirname(this.stateRoot)),hashes);await this.save();});
  }

  async findSuccessfulResultForUrl(requestedUrl, { excludeTaskId = null } = {}) {
    return this.withLock(async () => {
      const identity = normalizedUrlIdentity(requestedUrl);
      const task = [...this.state.tasks].reverse().find((item) => item.id !== excludeTaskId
        && item.status === "imported"
        && normalizedUrlIdentity(item.requestedUrl) === identity
        && new Set(["imported", "imported_with_warnings", "idempotent_replay"]).has(String(item.result?.status || "imported"))
        && Array.isArray(item.result?.artifacts));
      return task ? sanitizePersistedValue(task.result) : null;
    });
  }

  async listPendingRequestIds({ transport = null } = {}) {
    return this.withLock(async () => {
      const recovered = this.recoverExpiredClaims();
      const normalizedTransport = transport ? normalizeTransport(transport) : null;
      const requestIds = [...new Set(this.state.tasks
        .filter((task) => !terminalTask(task) && (!normalizedTransport || task.transport === normalizedTransport))
        .map((task) => task.requestId))];
      if (recovered) await this.save();
      return requestIds;
    });
  }

  async waitForTask(timeoutMs = 20000, { transport = null, requestId = null } = {}) {
    await this.initialize();
    const now = this.now();
    if (transport && transport !== BACKGROUND_FETCH_TRANSPORT) throw new Error("browser_import_wait_transport_not_supported");
    const normalizedTransport = transport ? normalizeTransport(transport) : null;
    const queued = this.state.tasks.filter((item) => item.status === "queued" && (!normalizedTransport || item.transport === normalizedTransport)
      && (!requestId || item.requestId === requestId));
    if (queued.some((item) => Date.parse(item.availableAt || 0) <= now)) return;
    const nextAvailableAt = queued.length
      ? Math.min(...queued.map((item) => Date.parse(item.availableAt || 0)).filter(Number.isFinite))
      : Number.POSITIVE_INFINITY;
    await new Promise((resolve) => {
      const boundedTimeout = Math.max(0, Math.min(Number(timeoutMs) || 0, 25000));
      const availabilityDelay = Number.isFinite(nextAvailableAt) ? Math.max(0, nextAvailableAt - now) : boundedTimeout;
      const timer = setTimeout(() => {
        this.waiters.delete(done);
        resolve();
      }, Math.min(boundedTimeout, availabilityDelay));
      const done = () => {
        clearTimeout(timer);
        this.waiters.delete(done);
        resolve();
      };
      this.waiters.add(done);
    });
  }
}
