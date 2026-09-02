const VERSION = "0.5.14";
const DEFAULT_PORT = 37829;
const PORT_SCAN_LABEL = "37829-37849";

const portInput = document.getElementById("port");
const healthButton = document.getElementById("health");
const diagnoseButton = document.getElementById("diagnose");
const openTestButton = document.getElementById("openTest");
const saveDraftButton = document.getElementById("saveDraft");
const completeReadingButton = document.getElementById("completeReading");
const retryFailedButton = document.getElementById("retryFailed");
const statusEl = document.getElementById("status");

function setStatus(text) {
  statusEl.textContent = text;
}

function appendStatus(line) {
  statusEl.textContent = `${statusEl.textContent}\n${line}`;
}

function isSupportedPage(url) {
  return /^https?:\/\//.test(String(url || ""));
}

function readableError(error) {
  const text = String(error && error.message ? error.message : error || "unknown_error");
  if (/Cannot access|cannot be scripted|The extensions gallery|chrome:\/\/|edge:\/\//i.test(text)) {
    return "当前页面不支持注入。请换普通网页，chrome://、edge://、扩展商店和浏览器内置页不能使用。";
  }
  if (/service_unavailable_ports/i.test(text)) {
    return `本地服务不可用。请在渐进阅读工作流目录运行 npm run app；插件正在探测端口 ${PORT_SCAN_LABEL}。`;
  }
  if (/Receiving end does not exist/i.test(text)) {
    return "当前页还没有注入 Local IR 脚本。";
  }
  return text;
}

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

async function sendRuntimeMessage(message) {
  const response = await chromeCallback((done) => chrome.runtime.sendMessage(message, done));
  if (!response.ok) return response;
  return response.result || { ok: false, error: "empty_response" };
}

async function activeTab() {
  const response = await chromeCallback((done) => chrome.tabs.query({ active: true, currentWindow: true }, done));
  if (!response.ok) return null;
  const tabs = Array.isArray(response.result) ? response.result : [];
  return tabs[0] || null;
}

async function sendTabMessageTo(tabId, message) {
  const response = await chromeCallback((done) => chrome.tabs.sendMessage(tabId, message, done));
  if (!response.ok) return response;
  return response.result || { ok: false, error: "empty_response" };
}

async function insertCss(tabId) {
  return chromeCallback((done) => chrome.scripting.insertCSS({ target: { tabId }, files: ["content.css"] }, done));
}

async function executeScript(tabId, files) {
  return chromeCallback((done) => chrome.scripting.executeScript({ target: { tabId }, files }, done));
}

async function createTab(url) {
  return chromeCallback((done) => chrome.tabs.create({ url }, done));
}

async function ensureContentScript(tab, report = () => {}) {
  if (!tab || !tab.id) return { ok: false, error: "no_active_tab" };
  if (!isSupportedPage(tab.url)) {
    return { ok: false, error: "当前页面不是可高亮的 http/https 页面。请换普通网页。" };
  }

  report("检查 content script。");
  const existing = await sendTabMessageTo(tab.id, { type: "get-content-status" });
  if (existing && existing.ok) return existing;

  report("当前页未响应，开始主动注入。");
  const css = await insertCss(tab.id);
  if (!css.ok) return { ok: false, error: `CSS 注入失败：${readableError(css.error)}` };

  const core = await executeScript(tab.id, ["draft-core.js"]);
  if (!core.ok) return { ok: false, error: `draft core 注入失败：${readableError(core.error)}` };

  const highlighter = await executeScript(tab.id, ["lib/web-highlighter.min.js"]);
  if (!highlighter.ok) return { ok: false, error: `web-highlighter 注入失败：${readableError(highlighter.error)}` };

  const content = await executeScript(tab.id, ["content.js"]);
  if (!content.ok) return { ok: false, error: `content.js 注入失败：${readableError(content.error)}` };

  const injected = await sendTabMessageTo(tab.id, { type: "get-content-status" });
  if (injected && injected.ok) return injected;
  return { ok: false, error: `注入后 content script 仍未响应：${readableError(injected && injected.error)}` };
}

async function refreshFailedCount() {
  const data = await storageGet({ localIrFailedCaptures: [] });
  const count = Array.isArray(data.localIrFailedCaptures) ? data.localIrFailedCaptures.length : 0;
  retryFailedButton.textContent = count ? `重试暂存 (${count})` : "重试暂存";
  retryFailedButton.disabled = count === 0;
}

function healthPort(response) {
  return response && response.result && response.result.port ? response.result.port : DEFAULT_PORT;
}

function healthRoot(response) {
  if (!response || !response.result) return "";
  return response.result.result && response.result.result.browserHighlightRoot
    ? response.result.result.browserHighlightRoot
    : response.result.browserHighlightRoot || "";
}

async function refreshHealthStatus(showBusy = true) {
  if (showBusy) setStatus(`正在健康检查：探测本地服务端口 ${PORT_SCAN_LABEL}。`);
  const response = await sendRuntimeMessage({ type: "health" });
  if (response.ok) {
    const port = healthPort(response);
    const root = healthRoot(response);
    portInput.value = String(port);
    setStatus(root ? `服务正常：端口 ${port}\n写入：${root}` : `服务正常：端口 ${port}`);
  } else {
    setStatus(`服务不可用：${readableError(response.error)}`);
  }
  return response;
}

async function runDiagnostics() {
  setStatus(`popup 脚本已加载 v${VERSION}`);

  const ping = await sendRuntimeMessage({ type: "diagnose-ping" });
  appendStatus(ping.ok ? "1. service worker：正常" : `1. service worker：失败，${readableError(ping.error)}`);

  const health = await sendRuntimeMessage({ type: "health" });
  if (health.ok) {
    appendStatus(`2. 本地服务：正常，端口 ${healthPort(health)}`);
  } else {
    appendStatus(`2. 本地服务：失败，${readableError(health.error)}`);
  }

  const tab = await activeTab();
  if (!tab || !tab.id) {
    appendStatus("3. 当前页：失败，找不到 active tab");
    return;
  }
  appendStatus(`3. 当前页：${tab.url || "unknown"}`);

  if (!isSupportedPage(tab.url)) {
    appendStatus("4. 注入权限：当前页不支持，请用普通 http/https 页面或测试页。");
    return;
  }

  const injected = await ensureContentScript(tab, (line) => appendStatus(`4. ${line}`));
  if (injected.ok) {
    appendStatus(`5. content script：正常，${injected.initialized ? "当前页已有草稿" : "请在网页操作面板点击初始化加工"}；模式 ${injected.mode || "off"}。`);
  } else {
    appendStatus(`5. content script：失败，${readableError(injected.error)}`);
  }
}

async function loadState() {
  setStatus(`popup 脚本已加载 v${VERSION}\n正在初始化。`);
  const data = await storageGet({
    localIrPort: DEFAULT_PORT
  });
  portInput.value = String(data.localIrPort || DEFAULT_PORT);
  await refreshFailedCount();
  appendStatus("popup 初始化完成。网页草稿请从页面右下角手动初始化；加工/挖空模式也在页面面板切换。");
}

async function withButton(button, action) {
  button.disabled = true;
  try {
    await action();
  } catch (error) {
    setStatus(`操作失败：${readableError(error)}`);
  } finally {
    button.disabled = false;
  }
}

portInput.addEventListener("change", () => {
  withButton(portInput, async () => {
    const port = Number(portInput.value || DEFAULT_PORT);
    const normalized = Number.isInteger(port) && port >= 1 && port <= 65535 ? port : DEFAULT_PORT;
    portInput.value = String(normalized);
    await storageSet({ localIrPort: normalized });
    setStatus(`端口已设置为 ${normalized}。健康检查仍会自动探测 ${PORT_SCAN_LABEL}。`);
  });
});

healthButton.addEventListener("click", () => withButton(healthButton, () => refreshHealthStatus(true)));

diagnoseButton.addEventListener("click", () => withButton(diagnoseButton, runDiagnostics));

openTestButton.addEventListener("click", () => {
  withButton(openTestButton, async () => {
    setStatus("正在打开本地测试页。");
    const health = await sendRuntimeMessage({ type: "health" });
    if (!health.ok) {
      setStatus(`无法打开测试页：${readableError(health.error)}`);
      return;
    }
    const port = healthPort(health);
    portInput.value = String(port);
    const opened = await createTab(`http://127.0.0.1:${port}/browser-highlight-test`);
    setStatus(opened.ok ? "已打开测试页。请在页面右下角点击初始化加工，再选择加工或挖空模式。" : `打开测试页失败：${readableError(opened.error)}`);
  });
});

async function submitCurrentDraft(destination) {
  const tab = await activeTab();
  if (!tab || !tab.id || !tab.url || !isSupportedPage(tab.url)) {
    setStatus("当前页不是可加工的 http/https 页面。");
    return;
  }
  const injected = await ensureContentScript(tab);
  if (!injected.ok) {
    setStatus(`当前页不可用：${readableError(injected.error)}`);
    return;
  }
  const response = await sendTabMessageTo(tab.id, { type: "save-draft", destination });
  if (!response.ok) {
    setStatus(`提交失败：${readableError(response.error)}`);
    return;
  }
  setStatus(destination === "completed" ? "已完成阅读，Markdown 已进入待归档原文。" : "当前版本已保存并锁定。");
}

saveDraftButton.addEventListener("click", () => withButton(saveDraftButton, () => submitCurrentDraft("reading")));
completeReadingButton.addEventListener("click", () => withButton(completeReadingButton, () => submitCurrentDraft("completed")));

retryFailedButton.addEventListener("click", () => {
  withButton(retryFailedButton, async () => {
    setStatus("正在重试暂存高亮。");
    const response = await sendRuntimeMessage({ type: "retry-failed" });
    if (response.ok) {
      setStatus(`重试完成：成功 ${response.result.imported.length}，剩余 ${response.result.remaining}`);
    } else {
      setStatus(`重试失败：${readableError(response.error)}`);
    }
    await refreshFailedCount();
  });
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === "local" && changes.localIrFailedCaptures) refreshFailedCount();
});

loadState().catch((error) => setStatus(`初始化失败：${readableError(error)}`));
