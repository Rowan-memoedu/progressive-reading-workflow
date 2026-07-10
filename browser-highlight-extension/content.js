(() => {
  if (window.__localIrBrowserHighlightContentLoaded) return;
  window.__localIrBrowserHighlightContentLoaded = true;

  const STORAGE_KEY = "localIrHighlightEnabled";
  const MAX_PAGE_TEXT = 300000;
  const MAX_HTML = 1000000;
  const MAX_CONTEXT = 8000;
  let enabled = false;
  let highlighter = null;
  let lastCaptureKey = "";
  let lastCaptureAt = 0;
  let toastTimer = null;

  function trimText(value, maxChars) {
    return String(value || "")
      .replace(/\r\n?/g, "\n")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{4,}/g, "\n\n\n")
      .trim()
      .slice(0, maxChars);
  }

  function sendMessage(message) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage(message, (response) => {
        if (chrome.runtime.lastError) {
          resolve({ ok: false, error: chrome.runtime.lastError.message });
        } else {
          resolve(response || { ok: false, error: "empty_response" });
        }
      });
    });
  }

  function showToast(text, kind = "ok") {
    let node = document.getElementById("local-ir-browser-toast");
    if (!node) {
      node = document.createElement("div");
      node.id = "local-ir-browser-toast";
      document.documentElement.appendChild(node);
    }
    node.className = `local-ir-browser-toast ${kind === "error" ? "is-error" : "is-ok"}`;
    node.textContent = text;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => node.remove(), 2800);
  }

  function isEditableNode(node) {
    const element = node?.nodeType === Node.TEXT_NODE ? node.parentElement : node;
    if (!(element instanceof Element)) return false;
    return Boolean(element.closest("input, textarea, select, button, [contenteditable='true'], [contenteditable='']"));
  }

  function nearestReadableBlock(node) {
    const element = node?.nodeType === Node.TEXT_NODE ? node.parentElement : node;
    if (!(element instanceof Element)) return document.body;
    return element.closest("article, main, section, blockquote, li, p, div, td, th") || document.body;
  }

  function contextForRange(range, selectedText) {
    const block = nearestReadableBlock(range.commonAncestorContainer);
    const blockText = trimText(block.innerText || block.textContent || "", MAX_CONTEXT);
    if (!blockText) return "";
    const cleanSelected = trimText(selectedText, 1000);
    const index = blockText.indexOf(cleanSelected);
    if (index < 0) return blockText;
    const start = Math.max(0, index - 1400);
    const end = Math.min(blockText.length, index + cleanSelected.length + 1400);
    return trimText(blockText.slice(start, end), MAX_CONTEXT);
  }

  function initHighlighter() {
    if (highlighter || !window.Highlighter) return;
    highlighter = new window.Highlighter({
      wrapTag: "mark",
      exceptSelectors: ["input", "textarea", "select", "button", "[contenteditable='true']", "[contenteditable='']"]
    });
    highlighter.setOption({
      style: {
        className: "local-ir-browser-highlight"
      }
    });
  }

  async function captureSelection() {
    if (!enabled) return;
    initHighlighter();
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) return;
    if (isEditableNode(selection.anchorNode) || isEditableNode(selection.focusNode)) return;

    const selectedText = trimText(selection.toString(), 60000);
    if (!selectedText) return;
    const now = Date.now();
    const captureKey = `${location.href}\n${selectedText}`;
    if (captureKey === lastCaptureKey && now - lastCaptureAt < 3000) return;
    lastCaptureKey = captureKey;
    lastCaptureAt = now;

    const range = selection.getRangeAt(0).cloneRange();
    const context = contextForRange(range, selectedText);
    const sourceId = `browser-${now}-${Math.random().toString(16).slice(2, 8)}`;
    const pageText = trimText(document.body?.innerText || "", MAX_PAGE_TEXT);
    const html = trimText(document.documentElement?.outerHTML || "", MAX_HTML);

    try {
      if (highlighter) {
        highlighter.fromRange(range);
      }
      selection.removeAllRanges();
    } catch (error) {
      showToast(`网页高亮失败，但会尝试保存全文高亮：${error.message}`, "error");
    }

    showToast("正在保存网页全文高亮...");

    const response = await sendMessage({
      type: "capture-highlight",
      payload: {
        url: location.href,
        title: document.title || "",
        selectionText: selectedText,
        context,
        pageText,
        html,
        createdAt: new Date().toISOString(),
        sourceId
      }
    });

    if (response?.ok) {
      showToast("已保存网页全文高亮到 Local IR");
    } else {
      showToast(`保存失败，已暂存待重试：${response?.error || "unknown_error"}`, "error");
    }
  }

  chrome.storage.local.get({ [STORAGE_KEY]: false }, (data) => {
    enabled = Boolean(data[STORAGE_KEY]);
    if (enabled) initHighlighter();
  });

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local" || !changes[STORAGE_KEY]) return;
    enabled = Boolean(changes[STORAGE_KEY].newValue);
    if (enabled) {
      initHighlighter();
      showToast("Local IR 高亮模式已开启");
    } else {
      showToast("Local IR 高亮模式已关闭");
    }
  });

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "set-highlight-enabled") {
      enabled = Boolean(message.enabled);
      if (enabled) initHighlighter();
      sendResponse({ ok: true, enabled });
      return true;
    }
    if (message?.type === "get-content-status") {
      sendResponse({ ok: true, enabled, url: location.href, title: document.title || "" });
      return true;
    }
    return false;
  });

  document.addEventListener("mouseup", () => {
    window.setTimeout(() => {
      captureSelection().catch((error) => showToast(`保存失败：${error.message}`, "error"));
    }, 40);
  }, true);
})();
