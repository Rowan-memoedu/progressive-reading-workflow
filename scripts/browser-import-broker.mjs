import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

const SCHEMA = "local-ir.browser-import-broker/v1";
export const DEFAULT_LEASE_MS = 12 * 60 * 1000;
export const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_RETRY_DELAY_MS = 1000;
const MAX_REQUESTS = 200;
export const BACKGROUND_FETCH_TRANSPORT = "background_fetch";
const DEGRADED_STATUSES = new Set(["requires_browser_auth", "requires_js_render"]);
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
  return task.status === "imported" || task.status === "failed" || DEGRADED_STATUSES.has(task.status);
}

function normalizeTransport(value) {
  return BACKGROUND_FETCH_TRANSPORT;
}

function normalizedUrlIdentity(value) {
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
    destination_folder: task.destinationFolder
  };
}

export class BrowserImportBroker {
  constructor({
    stateRoot,
    now = () => Date.now(),
    leaseMs = DEFAULT_LEASE_MS,
    maxAttempts = DEFAULT_MAX_ATTEMPTS,
    retryDelayMs = DEFAULT_RETRY_DELAY_MS
  } = {}) {
    if (!stateRoot) throw new Error("browser_import_broker_state_root_required");
    this.stateRoot = path.resolve(stateRoot);
    this.statePath = path.join(this.stateRoot, "state.json");
    this.now = now;
    this.leaseMs = leaseMs;
    this.maxAttempts = Math.max(1, Number(maxAttempts || DEFAULT_MAX_ATTEMPTS));
    this.retryDelayMs = Math.max(0, Number(retryDelayMs || 0));
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
    destinationFolder = ""
  } = {}) {
    return this.withLock(async () => {
      const normalized = [...new Set((urls || []).map((value) => String(value || "").trim()).filter(Boolean))];
      if (!normalized.length) throw new Error("browser_import_urls_required");
      const normalizedClientRequestId = String(clientRequestId || "").trim() || null;
      if (normalizedClientRequestId) {
        const existing = this.state.requests.find((item) => item.clientRequestId === normalizedClientRequestId);
        if (existing) return this.requestSummary(existing.id);
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
        createdAt,
        updatedAt: createdAt
      };
      this.state.requests.push(request);
      for (const url of normalized) {
        this.state.tasks.push({
          id: `browser-import-task-${randomUUID()}`,
          requestId: request.id,
          requestedUrl: url,
          source: String(source || "unknown"),
          transport: normalizedTransport,
          userInstruction: String(userInstruction || ""),
          entryRoute: String(entryRoute || "default"),
          destinationFolder: String(destinationFolder || ""),
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
          .filter((item) => this.requestSummary(item.id)?.terminal)
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
      const normalizedDegradedStatus = DEGRADED_STATUSES.has(degradedStatus) ? degradedStatus : null;
      const canRetry = !ok && retryable && Number(task.attempts || 0) < Number(task.maxAttempts || this.maxAttempts);
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
      if (canRetry) this.notifyWaiters();
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
    const degraded = requiresBrowserAuth + requiresJsRender;
    const active = tasks.filter((item) => item.status === "claimed").length;
    const queued = tasks.filter((item) => item.status === "queued").length;
    const terminal = imported + failed + degraded === tasks.length;
    let status = active > 0 ? "processing" : "queued";
    if (terminal) {
      if (failed > 0) status = imported + degraded > 0 ? "completed_with_failures" : "failed";
      else if (degraded > 0 && imported > 0) status = "completed_with_degradations";
      else if (requiresBrowserAuth === tasks.length) status = "requires_browser_auth";
      else if (requiresJsRender === tasks.length) status = "requires_js_render";
      else if (degraded > 0) status = "degraded";
      else status = "completed";
    }
    return {
      request_id: request.id,
      source: request.source,
      client_request_id: request.clientRequestId || null,
      entry_route: request.entryRoute || "default",
      destination_folder: request.destinationFolder || "",
      transport: request.transport || BACKGROUND_FETCH_TRANSPORT,
      status,
      terminal,
      requested: tasks.length,
      imported,
      failed,
      degraded,
      requires_browser_auth: requiresBrowserAuth,
      requires_js_render: requiresJsRender,
      active,
      queued,
      created_at: request.createdAt,
      updated_at: request.updatedAt,
      results: tasks.map((task) => ({
        requested_url: task.requestedUrl,
        transport: task.transport,
        status: task.status === "imported" ? String(task.result?.status || "imported") : task.status,
        ...(task.result?.final_url ? { final_url: task.result.final_url } : {}),
        ...(task.result?.redirect_chain ? { redirect_chain: task.result.redirect_chain } : {}),
        ...(task.result?.source_metadata ? { source_metadata: task.result.source_metadata } : {}),
        ...(task.result?.artifacts ? { artifacts: task.result.artifacts } : {}),
        ...(task.result?.receipt ? { receipt: task.result.receipt } : {}),
        ...(task.result?.errors ? { errors: task.result.errors } : {}),
        ...(task.error ? { error: task.error } : {}),
        attempt_count: Number(task.attempts || 0),
        max_attempts: Number(task.maxAttempts || this.maxAttempts)
      }))
    };
  }

  async getRequest(requestId) {
    return this.withLock(async () => this.requestSummary(requestId));
  }

  async findSuccessfulResultForUrl(requestedUrl, { excludeTaskId = null } = {}) {
    return this.withLock(async () => {
      const identity = normalizedUrlIdentity(requestedUrl);
      const task = [...this.state.tasks].reverse().find((item) => item.id !== excludeTaskId
        && item.status === "imported"
        && normalizedUrlIdentity(item.requestedUrl) === identity
        && new Set(["imported", "idempotent_replay"]).has(String(item.result?.status || "imported"))
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

  async waitForTask(timeoutMs = 20000, { transport = null } = {}) {
    await this.initialize();
    const now = this.now();
    if (transport && transport !== BACKGROUND_FETCH_TRANSPORT) throw new Error("browser_import_wait_transport_not_supported");
    const normalizedTransport = transport ? normalizeTransport(transport) : null;
    const queued = this.state.tasks.filter((item) => item.status === "queued" && (!normalizedTransport || item.transport === normalizedTransport));
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
