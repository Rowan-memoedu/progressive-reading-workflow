importScripts("draft-core.js");

const Core = globalThis.LocalIrDraftCore;
const VERSION = "0.5.17";
const DEFAULT_PORT = 37829;
const PORT_SCAN_START = 37829;
const PORT_SCAN_END = 37849;
const HEALTH_TIMEOUT_MS = 900;
const REQUEST_TIMEOUT_MS = 30000;
const STANDARD_IMPORT_TIMEOUT_MS = 10 * 60 * 1000;
const FAILED_LIMIT = 20;
const DRAFTS_KEY = "localIrBrowserDrafts";
const TAB_URLS_KEY = "localIrDraftTabUrls";
const TRANSPORT_MAX_ATTEMPTS = 3;

function chromeCallback(call) {
  return new Promise((resolve) => {
    try {
      call((result) => {
        const error = chrome.runtime.lastError;
        if (error) resolve({ ok: false, error: error.message });
        else resolve({ ok: true, result });
      });
    } catch (error) {
      resolve({ ok: false, error: error.message });
    }
  });
}

async function storageGet(defaults) {
  const response = await chromeCallback((done) => chrome.storage.local.get(defaults, done));
  return response.ok ? response.result || defaults : defaults;
}

async function storageSet(values) {
  const response = await chromeCallback((done) => chrome.storage.local.set(values, done));
  if (!response.ok) throw new Error(response.error || "storage_set_failed");
}

async function getSettings() {
  const values = await storageGet({
    localIrPort: DEFAULT_PORT,
    localIrFailedCaptures: [],
    [DRAFTS_KEY]: {},
    [TAB_URLS_KEY]: {}
  });
  return {
    port: Number(values.localIrPort || DEFAULT_PORT),
    failedCaptures: Array.isArray(values.localIrFailedCaptures) ? values.localIrFailedCaptures : [],
    drafts: values[DRAFTS_KEY] && typeof values[DRAFTS_KEY] === "object" ? values[DRAFTS_KEY] : {},
    tabUrls: values[TAB_URLS_KEY] && typeof values[TAB_URLS_KEY] === "object" ? values[TAB_URLS_KEY] : {}
  };
}

function normalizePort(value) {
  const port = Number(value || DEFAULT_PORT);
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : DEFAULT_PORT;
}

function localBaseUrl(port) {
  return `http://127.0.0.1:${normalizePort(port)}`;
}

function portCandidates(preferredPort) {
  const candidates = [normalizePort(preferredPort), DEFAULT_PORT];
  for (let port = PORT_SCAN_START; port <= PORT_SCAN_END; port += 1) candidates.push(port);
  return [...new Set(candidates)];
}

async function requestJsonAtPort(port, path, options = {}) {
  const timeoutMs = Number(options.timeoutMs || REQUEST_TIMEOUT_MS);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${localBaseUrl(port)}${path}`, {
      ...options,
      signal: controller.signal,
      headers: { "Content-Type": "application/json", ...(options.headers || {}) }
    });
    const text = await response.text();
    const data = text ? JSON.parse(text) : {};
    if (!response.ok) {
      const error = new Error(data.error || `http_${response.status}`);
      error.status = response.status;
      throw error;
    }
    return data;
  } catch (error) {
    if (error.name === "AbortError") throw new Error(`request_timeout_${timeoutMs}ms`);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function findServicePort() {
  const settings = await getSettings();
  for (const port of portCandidates(settings.port)) {
    try {
      const result = await requestJsonAtPort(port, "/api/highlights/health", { timeoutMs: HEALTH_TIMEOUT_MS });
      await storageSet({ localIrPort: port });
      return { port, result, probedPorts: `${PORT_SCAN_START}-${PORT_SCAN_END}` };
    } catch {
      // Continue probing the bounded local range.
    }
  }
  throw new Error(`service_unavailable_ports_${PORT_SCAN_START}_${PORT_SCAN_END}`);
}

async function requestJson(path, options = {}) {
  const { port } = await findServicePort();
  return requestJsonAtPort(port, path, options);
}

function retryableTransportError(error) {
  const status = Number(error?.status || 0);
  if (status) return status === 408 || status === 425 || status === 429 || status >= 500;
  const message = String(error?.message || error || "");
  return !/^(invalid_|unsupported_|empty_|no_url_found|too_many_urls|draft_not_found|draft_locked|requires_browser_auth|requires_js_render|browser_auth_)/u.test(message);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function requestJsonReliable(path, options = {}, maxAttempts = TRANSPORT_MAX_ATTEMPTS) {
  let lastError = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await requestJson(path, options);
    } catch (error) {
      lastError = error;
      if (attempt >= maxAttempts || !retryableTransportError(error)) break;
      await delay(300 * (2 ** (attempt - 1)));
    }
  }
  throw lastError || new Error("local_service_request_failed");
}

async function saveDraftMap(drafts) {
  await storageSet({ [DRAFTS_KEY]: drafts });
}

async function getDraft(url) {
  const { drafts } = await getSettings();
  const draft = drafts[url] ? Core.normalizeDraft(drafts[url]) : null;
  if (draft?.status === "submitting" && draft.submitMode === "standard_preprocess" && !draft.importJob) {
    const interrupted = Core.markFailed(draft, "上次导入没有收到完成回执，来源草稿已保留，请重新导入。");
    const latest = await getSettings();
    latest.drafts[url] = interrupted;
    await saveDraftMap(latest.drafts);
    return interrupted;
  }
  if (draft?.status === "submitting" && draft.submitMode === "standard_preprocess" && draft.importJob) {
    return refreshStandardImport(draft);
  }
  return draft;
}

// Persist the client key before dispatch. A lost response or suspended worker
// resumes the same server job rather than repeating generation/publication.
const refreshingImports = new Map();
async function refreshStandardImport(draft) {
  if (refreshingImports.has(draft.url)) return refreshingImports.get(draft.url);
  const run = (async () => {
    try {
      let request;
      if (draft.importJob.requestId) {
        request = await requestJsonReliable(`/api/browser-import/requests/${encodeURIComponent(draft.importJob.requestId)}`);
      } else {
        request = await requestJsonReliable("/api/highlights/import-local", {
          method: "POST", body: JSON.stringify({ draft, async: true, client_request_id: draft.importJob.clientRequestId })
        });
        draft.importJob.requestId = request.request_id;
      }
      const result = request.results?.[0];
      draft.importJob.stage = result?.stage || (request.terminal ? request.status : "queued");
      draft.lastError = null;
      if (request.terminal) {
        draft.importJob.terminal = true;
        if (["saved_locked", "imported", "imported_with_warnings", "idempotent_replay"].includes(result?.status)) {
          draft = Core.markSaved(draft, result);
        } else draft = Core.markFailed(draft, result?.error || result?.errors?.[0]?.message || request.status);
      }
    } catch (error) {
      // Connection loss does not mean that the durable task failed.
      if (error.status >= 400 && error.status < 500) {
        draft = Core.markFailed(draft, error.message);
        draft.importJob.terminal = true;
      } else draft.lastError = "暂时无法连接本地服务；任务和输入已保留，将自动查询结果。";
    }
    const latest = await getSettings();
    if (latest.drafts[draft.url]?.importJob?.clientRequestId !== draft.importJob.clientRequestId) return latest.drafts[draft.url] || null;
    latest.drafts[draft.url] = draft;
    await saveDraftMap(latest.drafts);
    await notifyDraftState(draft.url, draft);
    return draft;
  })();
  refreshingImports.set(draft.url, run);
  try { return await run; } finally { refreshingImports.delete(draft.url); }
}

async function upsertDraft(rawDraft, tabId = null) {
  const draft = Core.normalizeDraft(rawDraft);
  if (!/^https?:\/\//.test(draft.url)) throw new Error("invalid_draft_url");
  const settings = await getSettings();
  settings.drafts[draft.url] = draft;
  const values = { [DRAFTS_KEY]: settings.drafts };
  if (Number.isInteger(tabId)) {
    settings.tabUrls[String(tabId)] = draft.url;
    values[TAB_URLS_KEY] = settings.tabUrls;
  }
  await storageSet(values);
  return draft;
}

async function notifyDraftState(url, draft) {
  const response = await chromeCallback((done) => chrome.tabs.query({ url }, done));
  if (!response.ok) return;
  for (const tab of response.result || []) {
    if (!tab.id) continue;
    chrome.tabs.sendMessage(tab.id, { type: "draft-state", draft }, () => void chrome.runtime.lastError);
  }
}

async function submitDraft(url, destination = "reading", options = {}) {
  const settings = await getSettings();
  const current = settings.drafts[url];
  if (!current) throw new Error("draft_not_found");
  let draft = Core.normalizeDraft(current);
  if (draft.status === "submitting" && draft.importJob && !draft.importJob.terminal) {
    draft = await refreshStandardImport(draft);
    return { draft, result: draft.receipt, pending: draft.status === "submitting" };
  }
  if (draft.locked && !options.force) return { draft, result: draft.receipt };
  if (draft.locked && options.force) {
    draft = {
      ...draft,
      locked: false,
      dirty: true,
      status: "editing",
      lastError: null
    };
  }
  const submitMode = options.mode === "standard_preprocess"
    ? "standard_preprocess"
    : options.mode === "local"
      ? "local"
      : draft.submitMode;
  draft.submitDestination = submitMode === "standard_preprocess"
    ? "reading"
    : destination === "completed" ? "completed" : "reading";
  draft.submitMode = submitMode;
  draft = Core.markPending(draft);
  draft.status = "submitting";
  if (submitMode === "standard_preprocess") {
    draft.importJob = { clientRequestId: `snapshot-${crypto.randomUUID()}`, requestId: null, stage: "queued", terminal: false, forceReimport: options.force === true };
  }
  settings.drafts[url] = draft;
  await saveDraftMap(settings.drafts);
  await notifyDraftState(url, draft);
  if (submitMode === "standard_preprocess") {
    draft = await refreshStandardImport(draft);
    return { draft, result: draft.status === "submitting" ? { status: "queued", request_id: draft.importJob.requestId } : draft.receipt,
      pending: draft.status === "submitting", ...(draft.status === "error" ? { error: draft.lastError } : {}) };
  }
  try {
    const endpoint = submitMode === "standard_preprocess"
      ? "/api/highlights/import-local"
      : draft.submitDestination === "completed" ? "/api/highlights/complete" : "/api/highlights/commit";
    const result = await requestJsonReliable(endpoint, {
      method: "POST",
      body: JSON.stringify({ draft }),
      ...(submitMode === "standard_preprocess" ? { timeoutMs: STANDARD_IMPORT_TIMEOUT_MS } : {})
    });
    draft = draft.submitDestination === "completed" ? Core.markCompleted(draft, result) : Core.markSaved(draft, result);
    settings.drafts[url] = draft;
    await saveDraftMap(settings.drafts);
    await notifyDraftState(url, draft);
    return { draft, result };
  } catch (error) {
    draft = Core.markFailed(draft, error.message);
    settings.drafts[url] = draft;
    await saveDraftMap(settings.drafts);
    await notifyDraftState(url, draft);
    throw error;
  }
}

async function markDirtyDraftsPending() {
  const settings = await getSettings();
  let changed = false;
  for (const [url, value] of Object.entries(settings.drafts)) {
    const draft = Core.normalizeDraft(value);
    if (!draft.locked && draft.dirty && !draft.importJob) {
      settings.drafts[url] = Core.markPending(draft);
      changed = true;
    }
  }
  if (changed) await saveDraftMap(settings.drafts);
}

async function retryPendingDrafts() {
  const settings = await getSettings();
  const imported = [];
  const failed = [];
  for (const draft of Object.values(settings.drafts)) {
    if (draft.status === "submitting" && draft.importJob) {
      await refreshStandardImport(Core.normalizeDraft(draft));
      continue;
    }
    if (draft.locked || !["editing", "pending_submit", "error"].includes(draft.status)) continue;
    try {
      imported.push(await submitDraft(draft.url, draft.submitDestination || "reading"));
    } catch (error) {
      failed.push({ url: draft.url, error: error.message });
    }
  }
  return { imported: imported.length, failed };
}

async function rememberFailedCapture(payload, reason) {
  const settings = await getSettings();
  const failedCaptures = [...settings.failedCaptures, {
    payload,
    reason: String(reason || "capture_failed"),
    failedAt: new Date().toISOString()
  }].slice(-FAILED_LIMIT);
  await storageSet({ localIrFailedCaptures: failedCaptures });
  return failedCaptures.length;
}

async function captureHighlight(payload) {
  try {
    return { ok: true, result: await requestJsonReliable("/api/highlights/capture", { method: "POST", body: JSON.stringify(payload) }) };
  } catch (error) {
    return { ok: false, error: error.message, failedCount: await rememberFailedCapture(payload, error.message) };
  }
}

async function retryFailedCaptures() {
  const settings = await getSettings();
  const remaining = [];
  const imported = [];
  for (const item of settings.failedCaptures) {
    try {
      imported.push(await requestJsonReliable("/api/highlights/capture", { method: "POST", body: JSON.stringify(item.payload) }));
    } catch (error) {
      remaining.push({ ...item, reason: error.message, failedAt: new Date().toISOString() });
    }
  }
  await storageSet({ localIrFailedCaptures: remaining.slice(-FAILED_LIMIT) });
  const drafts = await retryPendingDrafts();
  return { imported, remaining: remaining.length, drafts };
}

async function discardDraft(url, tabId = null) {
  const normalizedUrl = String(url || "").trim();
  if (!/^https?:\/\//.test(normalizedUrl)) throw new Error("invalid_draft_url");
  const settings = await getSettings();
  const discarded = Boolean(settings.drafts[normalizedUrl]);
  delete settings.drafts[normalizedUrl];
  for (const [key, mappedUrl] of Object.entries(settings.tabUrls)) {
    if (mappedUrl === normalizedUrl || (Number.isInteger(tabId) && key === String(tabId))) delete settings.tabUrls[key];
  }
  await storageSet({ [DRAFTS_KEY]: settings.drafts, [TAB_URLS_KEY]: settings.tabUrls });
  await notifyDraftState(normalizedUrl, null);
  return { discarded };
}

function isSupportedPageUrl(value) {
  return /^https?:\/\//u.test(String(value || ""));
}

async function sendTabMessage(tabId, message) {
  if (!Number.isInteger(tabId)) return { ok: false, error: "tab_id_required" };
  const response = await chromeCallback((done) => chrome.tabs.sendMessage(tabId, message, done));
  if (!response.ok) return response;
  return response.result || { ok: false, error: "empty_response" };
}

async function injectContentScript(tabId) {
  const css = await chromeCallback((done) => chrome.scripting.insertCSS({ target: { tabId }, files: ["content.css"] }, done));
  if (!css.ok) throw new Error(`content_css_injection_failed:${css.error}`);
  for (const files of [["draft-core.js"], ["lib/web-highlighter.min.js"], ["content.js"]]) {
    const injected = await chromeCallback((done) => chrome.scripting.executeScript({ target: { tabId }, files }, done));
    if (!injected.ok) throw new Error(`content_script_injection_failed:${injected.error}`);
  }
}

async function ensureContentScript(tab) {
  if (!tab?.id || !isSupportedPageUrl(tab.url)) throw new Error("unsupported_context_page");
  const existing = await sendTabMessage(tab.id, { type: "get-content-status" });
  if (existing.ok) return existing;
  await injectContentScript(tab.id);
  const injected = await sendTabMessage(tab.id, { type: "get-content-status" });
  if (!injected.ok) throw new Error(`content_script_unavailable:${injected.error || "unknown"}`);
  return injected;
}

async function setContextBadge(tabId, text, color) {
  if (!Number.isInteger(tabId) || !chrome.action) return;
  await chromeCallback((done) => chrome.action.setBadgeBackgroundColor({ tabId, color }, done));
  await chromeCallback((done) => chrome.action.setBadgeText({ tabId, text }, done));
}

function clearContextBadgeLater(tabId, delayMs = 6000) {
  setTimeout(() => {
    if (!Number.isInteger(tabId) || !chrome.action) return;
    chrome.action.setBadgeText({ tabId, text: "" }, () => void chrome.runtime.lastError);
  }, delayMs);
}

async function notifyContextProgress(tabId, phase, message, details = null) {
  await sendTabMessage(tabId, { type: "context-import-progress", phase, message, details });
}

async function importUrlsStandard(text) {
  return requestJsonReliable("/api/highlights/import-local-urls", {
    method: "POST",
    body: JSON.stringify({ text, source: "browser_extension", entry_route: "browser_extension" }),
    timeoutMs: STANDARD_IMPORT_TIMEOUT_MS
  });
}

async function createBrowserImportRequest(url, source = "browser_context_link") {
  return requestJsonReliable("/api/browser-import/requests", {
    method: "POST",
    body: JSON.stringify({
      urls: [url],
      source,
      entry_route: "browser_extension",
      client_request_id: `${source}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
    }),
    timeoutMs: REQUEST_TIMEOUT_MS
  });
}

async function waitForBrowserImportRequest(requestId, timeoutMs = STANDARD_IMPORT_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const request = await requestJsonReliable(`/api/browser-import/requests/${encodeURIComponent(requestId)}`, {
      timeoutMs: REQUEST_TIMEOUT_MS
    });
    if (request?.terminal) {
      const result = Array.isArray(request.results) ? request.results[0] : null;
      if (result?.status === "imported" || result?.status === "imported_with_warnings" || result?.status === "idempotent_replay") return result;
      const degradedStatus = new Set(["requires_browser_auth", "requires_js_render"]);
      const status = String(result?.status || request.status || "");
      if (degradedStatus.has(status)) throw new Error(status);
      throw new Error(String(result?.error || status || "browser_import_request_failed"));
    }
    await delay(350);
  }
  throw new Error("browser_import_request_timeout");
}

async function importCurrentPageFromContext(tab) {
  await ensureContentScript(tab);
  const response = await sendTabMessage(tab.id, { type: "context-import-current-page" });
  if (!response.ok) throw new Error(response.error || "current_page_import_failed");
  return response.result || response;
}

async function importLinkFromContext(url, tab) {
  if (!isSupportedPageUrl(url)) throw new Error("invalid_context_link_url");
  if (tab?.id && isSupportedPageUrl(tab.url)) {
    await ensureContentScript(tab);
    await notifyContextProgress(tab.id, "started", "正在后台静默导入链接…");
  }
  const request = await createBrowserImportRequest(url);
  return waitForBrowserImportRequest(request.request_id);
}

async function handleContextMenuClick(info, tab) {
  const tabId = tab?.id;
  await setContextBadge(tabId, "…", "#1f5fbf");
  try {
    if (info.menuItemId === "local-ir-import-page") {
      const result = await importCurrentPageFromContext(tab);
      if (result?.status === "queued") {
        await setContextBadge(tabId, "…", "#1f5fbf");
        return;
      }
      if (result?.receipt?.quality_status === "warning") {
        await setContextBadge(tabId, "!", "#d97706");
        return;
      }
    } else if (info.menuItemId === "local-ir-import-link") {
      const result = await importLinkFromContext(info.linkUrl, tab);
      if (tabId && isSupportedPageUrl(tab?.url)) {
        await notifyContextProgress(tabId, result?.receipt?.quality_status === "warning" ? "warning" : "succeeded",
          result?.receipt?.quality_status === "warning"
            ? "链接已导入，但生成的 Markdown 有瑕疵，请复核。"
            : "链接已标准化并导入本地阅读区");
      }
      if (result?.receipt?.quality_status === "warning") {
        await setContextBadge(tabId, "!", "#d97706");
        return;
      }
    } else {
      return;
    }
    await setContextBadge(tabId, "✓", "#067647");
  } catch (error) {
    if (tabId && isSupportedPageUrl(tab?.url)) {
      await notifyContextProgress(tabId, "failed", `导入失败：${error.message}`);
    }
    await setContextBadge(tabId, "!", "#b42318");
  } finally {
    clearContextBadgeLater(tabId);
  }
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    const documentUrlPatterns = ["http://*/*", "https://*/*"];
    chrome.contextMenus.create({ id: "local-ir-import-link", title: "导入链接到渐进阅读", contexts: ["link"], documentUrlPatterns });
    chrome.contextMenus.create({ id: "local-ir-import-page", title: "导入当前页到渐进阅读", contexts: ["page"], documentUrlPatterns });
  });
});

chrome.runtime.onStartup.addListener(() => {
  void retryPendingDrafts();
});
chrome.runtime.onSuspend.addListener(() => void markDirtyDraftsPending());

chrome.tabs.onRemoved.addListener((tabId) => {
  void (async () => {
    const settings = await getSettings();
    const url = settings.tabUrls[String(tabId)];
    if (!url) return;
    delete settings.tabUrls[String(tabId)];
    await storageSet({ [TAB_URLS_KEY]: settings.tabUrls });
    const draft = settings.drafts[url];
    if (draft && !draft.locked && draft.dirty) {
      await submitDraft(url, draft.submitDestination || "reading").catch(() => {});
    }
  })();
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  void handleContextMenuClick(info, tab);
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    if (message?.type === "diagnose-ping") return sendResponse({ ok: true, result: { version: VERSION, now: new Date().toISOString() } });
    if (message?.type === "capture-highlight") return sendResponse(await captureHighlight(message.payload || {}));
    if (message?.type === "health") return sendResponse({ ok: true, result: await findServicePort() });
    if (message?.type === "retry-failed") return sendResponse({ ok: true, result: await retryFailedCaptures() });
    if (message?.type === "import-current-url") return sendResponse({ ok: true, result: await importUrlsStandard(message.url || "") });
    if (message?.type === "draft-get") return sendResponse({ ok: true, draft: await getDraft(String(message.url || "")) });
    if (message?.type === "draft-upsert") return sendResponse({ ok: true, draft: await upsertDraft(message.draft || {}, sender.tab?.id) });
    if (message?.type === "draft-discard") return sendResponse({ ok: true, result: await discardDraft(message.url, sender.tab?.id) });
    if (message?.type === "draft-submit") {
      const submitted = await submitDraft(String(message.url || ""), message.destination === "completed" ? "completed" : "reading", { mode: "local" });
      return sendResponse({ ok: true, ...submitted });
    }
    if (message?.type === "draft-import-local") {
      const submitted = await submitDraft(String(message.url || ""), "reading", { mode: "standard_preprocess", force: Boolean(message.force) });
      return sendResponse({ ok: true, ...submitted });
    }
    if (message?.type === "draft-resubmit") {
      const url = String(message.url || "");
      const current = await getDraft(url);
      const destination = current?.submitDestination === "completed" ? "completed" : "reading";
      const submitted = await submitDraft(url, destination, { force: true, ...(message.mode ? { mode: message.mode } : {}) });
      return sendResponse({ ok: true, ...submitted });
    }
    sendResponse({ ok: false, error: "unknown_message" });
  })().catch((error) => sendResponse({ ok: false, error: error.message }));
  return true;
});
