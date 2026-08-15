importScripts("draft-core.js");

const Core = globalThis.LocalIrDraftCore;
const VERSION = "0.4.0";
const DEFAULT_PORT = 37829;
const PORT_SCAN_START = 37829;
const PORT_SCAN_END = 37849;
const HEALTH_TIMEOUT_MS = 900;
const REQUEST_TIMEOUT_MS = 30000;
const FAILED_LIMIT = 20;
const DRAFTS_KEY = "localIrBrowserDrafts";
const TAB_URLS_KEY = "localIrDraftTabUrls";

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
    if (!response.ok) throw new Error(data.error || `http_${response.status}`);
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

async function saveDraftMap(drafts) {
  await storageSet({ [DRAFTS_KEY]: drafts });
}

async function getDraft(url) {
  const { drafts } = await getSettings();
  return drafts[url] ? Core.normalizeDraft(drafts[url]) : null;
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

async function submitDraft(url, destination = "reading") {
  const settings = await getSettings();
  const current = settings.drafts[url];
  if (!current) throw new Error("draft_not_found");
  let draft = Core.normalizeDraft(current);
  if (draft.locked) return { draft, result: draft.receipt };
  draft.submitDestination = destination === "completed" ? "completed" : "reading";
  draft = Core.markPending(draft);
  draft.status = "submitting";
  settings.drafts[url] = draft;
  await saveDraftMap(settings.drafts);
  try {
    const endpoint = destination === "completed" ? "/api/highlights/complete" : "/api/highlights/commit";
    const result = await requestJson(endpoint, { method: "POST", body: JSON.stringify({ draft }) });
    draft = destination === "completed" ? Core.markCompleted(draft, result) : Core.markSaved(draft, result);
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
    if (!draft.locked && draft.dirty) {
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
    return { ok: true, result: await requestJson("/api/highlights/capture", { method: "POST", body: JSON.stringify(payload) }) };
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
      imported.push(await requestJson("/api/highlights/capture", { method: "POST", body: JSON.stringify(item.payload) }));
    } catch (error) {
      remaining.push({ ...item, reason: error.message, failedAt: new Date().toISOString() });
    }
  }
  await storageSet({ localIrFailedCaptures: remaining.slice(-FAILED_LIMIT) });
  const drafts = await retryPendingDrafts();
  return { imported, remaining: remaining.length, drafts };
}

async function importUrl(text) {
  return requestJson("/api/import", { method: "POST", body: JSON.stringify({ text }) });
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: "local-ir-import-link", title: "导入链接到渐进阅读", contexts: ["link"] });
    chrome.contextMenus.create({ id: "local-ir-import-page", title: "导入当前页到渐进阅读", contexts: ["page"] });
  });
});

chrome.runtime.onStartup.addListener(() => void retryPendingDrafts());
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
  const text = info.menuItemId === "local-ir-import-link" ? info.linkUrl : tab?.url;
  if (text) void importUrl(text);
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    if (message?.type === "diagnose-ping") return sendResponse({ ok: true, result: { version: VERSION, now: new Date().toISOString() } });
    if (message?.type === "capture-highlight") return sendResponse(await captureHighlight(message.payload || {}));
    if (message?.type === "health") return sendResponse({ ok: true, result: await findServicePort() });
    if (message?.type === "retry-failed") return sendResponse({ ok: true, result: await retryFailedCaptures() });
    if (message?.type === "import-current-url") return sendResponse({ ok: true, result: await importUrl(message.url || "") });
    if (message?.type === "draft-get") return sendResponse({ ok: true, draft: await getDraft(String(message.url || "")) });
    if (message?.type === "draft-upsert") return sendResponse({ ok: true, draft: await upsertDraft(message.draft || {}, sender.tab?.id) });
    if (message?.type === "draft-submit") {
      const submitted = await submitDraft(String(message.url || ""), message.destination === "completed" ? "completed" : "reading");
      return sendResponse({ ok: true, ...submitted });
    }
    sendResponse({ ok: false, error: "unknown_message" });
  })().catch((error) => sendResponse({ ok: false, error: error.message }));
  return true;
});
