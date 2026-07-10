const VERSION = "0.2.0";
const DEFAULT_PORT = 37829;
const PORT_SCAN_START = 37829;
const PORT_SCAN_END = 37849;
const HEALTH_TIMEOUT_MS = 900;
const REQUEST_TIMEOUT_MS = 15000;
const FAILED_LIMIT = 20;

function chromeCallback(call) {
  return new Promise((resolve) => {
    try {
      call((result) => {
        const error = chrome.runtime.lastError;
        if (error) {
          resolve({ ok: false, error: error.message });
        } else {
          resolve({ ok: true, result });
        }
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
  return chromeCallback((done) => chrome.storage.local.set(values, done));
}

function normalizePort(value) {
  const port = Number(value || DEFAULT_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return DEFAULT_PORT;
  return port;
}

function localBaseUrl(port) {
  return `http://127.0.0.1:${normalizePort(port)}`;
}

function portCandidates(preferredPort) {
  const candidates = [normalizePort(preferredPort), DEFAULT_PORT];
  for (let port = PORT_SCAN_START; port <= PORT_SCAN_END; port += 1) {
    candidates.push(port);
  }
  return [...new Set(candidates)];
}

async function getSettings() {
  const data = await storageGet({
    localIrPort: DEFAULT_PORT,
    localIrHighlightEnabled: false,
    localIrFailedCaptures: []
  });
  return {
    port: data.localIrPort || DEFAULT_PORT,
    enabled: Boolean(data.localIrHighlightEnabled),
    failedCaptures: Array.isArray(data.localIrFailedCaptures) ? data.localIrFailedCaptures : []
  };
}

async function requestJsonAtPort(port, path, options = {}) {
  const { timeoutMs = REQUEST_TIMEOUT_MS, headers, ...fetchOptions } = options;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${localBaseUrl(port)}${path}`, {
      ...fetchOptions,
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        ...(headers || {})
      }
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
  const candidates = portCandidates(settings.port);
  for (const port of candidates) {
    try {
      const result = await requestJsonAtPort(port, "/api/highlights/health", { timeoutMs: HEALTH_TIMEOUT_MS });
      await storageSet({ localIrPort: port });
      return { port, result, probedPorts: `${PORT_SCAN_START}-${PORT_SCAN_END}` };
    } catch {
      // Try the next candidate.
    }
  }
  throw new Error(`service_unavailable_ports_${PORT_SCAN_START}_${PORT_SCAN_END}`);
}

async function requestJson(path, options = {}) {
  const { port } = await findServicePort();
  return requestJsonAtPort(port, path, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {})
    }
  });
}

async function rememberFailedCapture(payload, reason) {
  const settings = await getSettings();
  const failedCaptures = [
    ...settings.failedCaptures,
    {
      payload,
      reason: String(reason || "capture_failed"),
      failedAt: new Date().toISOString()
    }
  ].slice(-FAILED_LIMIT);
  await storageSet({ localIrFailedCaptures: failedCaptures });
  return failedCaptures.length;
}

async function captureHighlight(payload) {
  try {
    const result = await requestJson("/api/highlights/capture", {
      method: "POST",
      body: JSON.stringify(payload)
    });
    return { ok: true, result };
  } catch (error) {
    const failedCount = await rememberFailedCapture(payload, error.message);
    return { ok: false, error: error.message, failedCount };
  }
}

async function retryFailedCaptures() {
  const settings = await getSettings();
  const remaining = [];
  const imported = [];
  for (const item of settings.failedCaptures) {
    try {
      const result = await requestJson("/api/highlights/capture", {
        method: "POST",
        body: JSON.stringify(item.payload)
      });
      imported.push(result);
    } catch (error) {
      remaining.push({ ...item, reason: error.message, failedAt: new Date().toISOString() });
    }
  }
  await storageSet({ localIrFailedCaptures: remaining.slice(-FAILED_LIMIT) });
  return { imported, remaining: remaining.length };
}

async function importUrl(text) {
  return requestJson("/api/import", {
    method: "POST",
    body: JSON.stringify({ text })
  });
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: "local-ir-import-link",
      title: "导入链接到渐进阅读",
      contexts: ["link"]
    });
    chrome.contextMenus.create({
      id: "local-ir-import-page",
      title: "导入当前页到渐进阅读",
      contexts: ["page"]
    });
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  const text = info.menuItemId === "local-ir-import-link" ? info.linkUrl : tab && tab.url;
  if (!text) return;
  importUrl(text).catch((error) => {
    storageSet({
      localIrLastImportError: {
        message: error.message,
        at: new Date().toISOString(),
        url: text
      }
    });
  });
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  (async () => {
    if (message && message.type === "diagnose-ping") {
      sendResponse({ ok: true, result: { version: VERSION, now: new Date().toISOString() } });
      return;
    }
    if (message && message.type === "capture-highlight") {
      sendResponse(await captureHighlight(message.payload || {}));
      return;
    }
    if (message && message.type === "health") {
      sendResponse({ ok: true, result: await findServicePort() });
      return;
    }
    if (message && message.type === "retry-failed") {
      sendResponse({ ok: true, result: await retryFailedCaptures() });
      return;
    }
    if (message && message.type === "import-current-url") {
      sendResponse({ ok: true, result: await importUrl(message.url || "") });
      return;
    }
    sendResponse({ ok: false, error: "unknown_message" });
  })().catch((error) => sendResponse({ ok: false, error: error.message }));
  return true;
});
