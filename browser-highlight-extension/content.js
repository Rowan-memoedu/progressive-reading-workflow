(() => {
  if (window.__localIrBrowserHighlightContentLoaded) return;
  window.__localIrBrowserHighlightContentLoaded = true;

  const Core = globalThis.LocalIrDraftCore;
  if (!Core) throw new Error("local_ir_draft_core_missing");

  const LEGACY_MODE_KEY = "localIrHighlightEnabled";
  const MODE_KEY = "localIrAuthoringMode";
  const DOCK_POSITION_KEY = "localIrDockPosition";
  const MAX_PAGE_TEXT = 300000;
  const MAX_HTML = 4000000;
  let importPollTimer = null;
  let importPollRunning = false;
  const MAX_CONTEXT = 8000;
  const TYPE_LABELS = {
    highlight: "仅高亮",
    comment: "普通评论",
    myth_truth: "迷思 / 真相",
    rebuttal: "反驳",
    sample_quote: "引用",
    later: "稍后处理",
    rewrite: "改写",
    refine: "精炼",
    add_viewpoint: "联想",
    rebuttal_rewrite: "反驳后改写",
    question: "提问",
    optimize: "优化",
    example_viewpoint: "例子与观点",
    qa_card: "问答卡"
  };

  let authoringMode = "off";
  let draft = null;
  let mergeSelection = [];
  let lastCaptureKey = "";
  let lastCaptureAt = 0;
  let toastTimer = null;
  let ui = null;
  let standardImportBusy = false;
  let dockPosition = null;

  function positionDock(value = dockPosition) {
    if (!ui || !Number.isFinite(value?.x) || !Number.isFinite(value?.y)) return;
    const rect = ui.dock.getBoundingClientRect();
    const position = {
      x: Math.max(8, Math.min(value.x, Math.max(8, window.innerWidth - rect.width - 8))),
      y: Math.max(8, Math.min(value.y, Math.max(8, window.innerHeight - rect.height - 8)))
    };
    Object.assign(ui.dock.style, { left: `${position.x}px`, top: `${position.y}px`, right: "auto", bottom: "auto" });
    return position;
  }

  function makeDockMovable(dock, handle) {
    let drag = null;
    const remember = () => {
      dockPosition = positionDock();
      if (dockPosition) chrome.storage.local.set({ [DOCK_POSITION_KEY]: dockPosition }, () => { void chrome.runtime.lastError; });
    };
    handle.addEventListener("pointerdown", (event) => {
      if (event.button !== 0 || event.isPrimary === false) return;
      event.preventDefault();
      const rect = dock.getBoundingClientRect();
      drag = { id: event.pointerId, x: event.clientX, y: event.clientY, left: rect.left, top: rect.top };
      dock.classList.add("is-dragging");
      handle.setPointerCapture?.(event.pointerId);
    });
    window.addEventListener("pointermove", (event) => {
      if (!drag || event.pointerId !== drag.id) return;
      event.preventDefault();
      dockPosition = positionDock({ x: drag.left + event.clientX - drag.x, y: drag.top + event.clientY - drag.y });
    }, { passive: false });
    const finish = (event) => {
      if (!drag || event.pointerId !== drag.id) return;
      const id = drag.id;
      drag = null;
      dock.classList.remove("is-dragging");
      if (handle.hasPointerCapture?.(id)) handle.releasePointerCapture(id);
      remember();
    };
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", finish);
    handle.addEventListener("lostpointercapture", finish);
    handle.addEventListener("keydown", (event) => {
      const directions = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
      const direction = directions[event.key];
      if (!direction) return;
      event.preventDefault();
      const rect = dock.getBoundingClientRect();
      const step = event.shiftKey ? 40 : 10;
      dockPosition = positionDock({ x: rect.left + direction[0] * step, y: rect.top + direction[1] * step });
      remember();
    });
    window.addEventListener("resize", () => positionDock());
    if (typeof ResizeObserver === "function") new ResizeObserver(() => positionDock()).observe(dock);
    positionDock();
  }

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
        if (chrome.runtime.lastError) resolve({ ok: false, error: chrome.runtime.lastError.message });
        else resolve(response || { ok: false, error: "empty_response" });
      });
    });
  }

  function showToast(text, kind = "ok", timeoutMs = 3200) {
    let node = document.getElementById("local-ir-browser-toast");
    if (!node) {
      node = document.createElement("div");
      node.id = "local-ir-browser-toast";
      document.documentElement.appendChild(node);
    }
    node.className = `local-ir-browser-toast ${kind === "error" ? "is-error" : kind === "warning" ? "is-warning" : "is-ok"}`;
    node.textContent = text;
    clearTimeout(toastTimer);
    toastTimer = timeoutMs > 0 ? setTimeout(() => node.remove(), timeoutMs) : null;
  }

  function sourceSnapshot() {
    const clone = document.documentElement.cloneNode(true);
    clone.querySelectorAll("#local-ir-browser-toast, #local-ir-browser-workbench").forEach((node) => node.remove());
    clone.querySelectorAll("mark.local-ir-browser-highlight").forEach((mark) => mark.replaceWith(...mark.childNodes));
    clone.querySelectorAll("style,script:not([type^='math/tex'])").forEach(node => node.remove());
    const html = `<!doctype html>\n${clone.outerHTML}`;
    if (html.length > MAX_HTML) throw new Error("页面超过完整捕获上限，已停止导入以免截断公式和正文。");
    return {
      url: location.href,
      title: document.title || "",
      pageText: trimText(document.body?.innerText || "", MAX_PAGE_TEXT),
      sourceText: String(document.body?.textContent || "").slice(0, MAX_PAGE_TEXT),
      html,
      sourceType: "browser_page",
      sourceMetadata: {
        source_url: location.href,
        source_title: document.title || "",
        captured_at: new Date().toISOString(),
        capture_agent: "local_ir_browser_extension"
      }
    };
  }

  function requireDraft() {
    if (!draft) throw new Error("draft_not_initialized");
    return draft;
  }

  function isAuthoringInitialized() {
    if (!draft) return false;
    const explicit = draft.sourceMetadata?.local_ir_authoring_initialized;
    if (typeof explicit === "boolean") return explicit;
    return draft.submitMode !== "standard_preprocess";
  }

  async function initializeDraft(options = {}) {
    const authoring = options.authoring !== false;
    let changed = false;
    if (!draft) {
      draft = Core.createDraft(sourceSnapshot());
      changed = true;
    }
    if (draft.sourceMetadata?.local_ir_authoring_initialized !== authoring && (authoring || changed)) {
      draft.sourceMetadata = {
        ...draft.sourceMetadata,
        local_ir_authoring_initialized: authoring
      };
      changed = true;
    }
    if (changed) await persistDraft();
    else renderStatus();
    if (authoring) showToast("当前网页已初始化，可以选择加工模式");
    return draft;
  }

  async function setAuthoringMode(requested) {
    authoringMode = Core.toggleAuthoringMode(authoringMode, requested);
    await new Promise((resolve, reject) => {
      chrome.storage.local.set({ [MODE_KEY]: authoringMode }, () => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else resolve();
      });
    });
    renderStatus();
    const label = authoringMode === "processing" ? "加工模式已开启" : authoringMode === "cloze" ? "挖空模式已开启" : "加工模式与挖空模式均已关闭";
    showToast(label);
  }

  async function persistDraft() {
    if (!draft) return;
    const response = await sendMessage({ type: "draft-upsert", draft });
    if (!response.ok) throw new Error(response.error || "draft_persist_failed");
    draft = Core.normalizeDraft(response.draft || draft);
    renderStatus();
  }

  function isEditableNode(node) {
    const element = node?.nodeType === Node.TEXT_NODE ? node.parentElement : node;
    if (!(element instanceof Element)) return false;
    return Boolean(element.closest("input, textarea, select, button, [contenteditable='true'], [contenteditable=''], #local-ir-browser-workbench"));
  }

  function contextForRange(range, selectedText) {
    const element = range.commonAncestorContainer.nodeType === Node.TEXT_NODE
      ? range.commonAncestorContainer.parentElement
      : range.commonAncestorContainer;
    const block = element?.closest?.("article, main, section, blockquote, li, p, div, td, th") || document.body;
    const blockText = trimText(block?.innerText || block?.textContent || "", MAX_CONTEXT);
    const index = blockText.indexOf(trimText(selectedText, 1000));
    if (index < 0) return { before: blockText.slice(0, 1400), after: "" };
    return {
      before: trimText(blockText.slice(Math.max(0, index - 1400), index), 1400),
      after: trimText(blockText.slice(index + selectedText.length, index + selectedText.length + 1400), 1400)
    };
  }

  function boundaryOffset(container, offset, entries) {
    if (container.nodeType === Node.TEXT_NODE) {
      const entry = entries.find((item) => item.node === container);
      if (entry) return entry.start + Math.max(0, Math.min(offset, container.nodeValue.length));
    }
    for (const entry of entries) {
      const nodeRange = document.createRange();
      nodeRange.selectNodeContents(entry.node);
      try {
        if (nodeRange.comparePoint(container, offset) < 0) return entry.start;
      } catch {
        continue;
      }
    }
    return entries.at(-1)?.end || 0;
  }

  function rangeOffsets(range) {
    const entries = textNodes();
    return {
      start: boundaryOffset(range.startContainer, range.startOffset, entries),
      end: boundaryOffset(range.endContainer, range.endOffset, entries)
    };
  }

  function unwrapVirtualMarks() {
    document.querySelectorAll("mark.local-ir-browser-highlight[data-local-ir-annotation-id]").forEach((mark) => {
      const parent = mark.parentNode;
      if (!parent) return;
      while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
      mark.remove();
      parent.normalize();
    });
  }

  function textNodes() {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (!node.nodeValue) return NodeFilter.FILTER_REJECT;
        const parent = node.parentElement;
        if (!parent || parent.closest("script, style, noscript, textarea, #local-ir-browser-workbench")) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    const nodes = [];
    let offset = 0;
    let node;
    while ((node = walker.nextNode())) {
      const start = offset;
      offset += node.nodeValue.length;
      nodes.push({ node, start, end: offset });
    }
    return nodes;
  }

  function wrapVirtualRange(annotation, range) {
    const segments = textNodes().filter((entry) => entry.end > range.start && entry.start < range.end);
    for (const entry of segments.reverse()) {
      const localStart = Math.max(0, range.start - entry.start);
      const localEnd = Math.min(entry.node.nodeValue.length, range.end - entry.start);
      if (localEnd <= localStart) continue;
      const selected = entry.node.splitText(localStart);
      selected.splitText(localEnd - localStart);
      const mark = document.createElement("mark");
      mark.className = `local-ir-browser-highlight${annotation.markKind === "cloze" ? " is-cloze" : ""}`;
      mark.dataset.localIrAnnotationId = annotation.id;
      selected.parentNode.replaceChild(mark, selected);
      mark.appendChild(selected);
    }
  }

  function renderHighlights() {
    unwrapVirtualMarks();
    if (!draft) return;
    const work = draft.annotations
      .flatMap((annotation) => annotation.ranges.map((range) => ({ annotation, range })))
      .sort((a, b) => b.range.start - a.range.start || b.range.end - a.range.end);
    for (const item of work) wrapVirtualRange(item.annotation, item.range);
  }

  function renderStatus() {
    if (!ui) return;
    const summary = draft ? Core.summary(draft) : null;
    const authoringInitialized = isAuthoringInitialized();
    ui.initializer.hidden = authoringInitialized;
    ui.importLocal.hidden = authoringInitialized;
    ui.controls.hidden = !authoringInitialized;
    ui.dock.classList.toggle("is-compact", !authoringInitialized);
    if (!summary) ui.status.textContent = "尚未初始化";
    else if (summary.status === "saved_locked") ui.status.textContent = `已保存并锁定 · ${summary.annotations} 条批注`;
    else if (summary.status === "completed_pending_archive") ui.status.textContent = `已完成阅读 · 待归档 · ${summary.annotations} 条批注`;
    else if (summary.status === "submitting" && summary.submitMode === "standard_preprocess") {
      const stages = { queued: "等待后台处理", capture_conversion: "正在提取正文与公式", workflow_routing: "正在确定处理步骤",
        profile_translation: "正在翻译", reading_guide: "正在生成导读", spoken_to_written: "正在转为书面语", body_structuring: "正在整理正文", profile_standardization: "正在整理格式" };
      ui.status.textContent = summary.lastError || `${stages[draft.importJob?.stage] || "正在导入"}…（可刷新页面）`;
    }
    else if (summary.status === "submitting") ui.status.textContent = "正在保存…";
    else if (summary.status === "error") ui.status.textContent = `提交失败，已保留草稿 · ${summary.lastError || "unknown"}`;
    else ui.status.textContent = `未保存 v${summary.revision} · ${summary.annotations} 条批注 · ${summary.qaCards} 张卡`;
    const locked = Boolean(summary?.locked);
    const canReimport = summary?.status === "saved_locked";
    const submitting = summary?.status === "submitting";
    ui.initializer.disabled = submitting;
    ui.importLocal.disabled = submitting;
    ui.status.title = ui.status.textContent;
    const retryStandardImport = summary?.status === "error" && summary.submitMode === "standard_preprocess";
    for (const button of [ui.processing, ui.cloze, ui.undo, ui.musing, ui.qa, ui.complete]) button.disabled = locked || submitting;
    ui.abandon.disabled = submitting;
    ui.save.disabled = submitting || (locked && !canReimport);
    ui.save.textContent = canReimport ? "重新导入" : retryStandardImport ? "重试导入本地" : "保存";
    ui.importLocal.textContent = canReimport || retryStandardImport ? "重新导入" : submitting ? "导入中…" : "导入本地";
    ui.processing.classList.toggle("is-active", authoringMode === "processing");
    ui.cloze.classList.toggle("is-active", authoringMode === "cloze");
    if (submitting && draft.importJob) scheduleImportPoll();
    else { clearTimeout(importPollTimer); importPollTimer = null; }
  }

  function scheduleImportPoll() {
    if (importPollTimer || importPollRunning) return;
    importPollTimer = setTimeout(async () => {
      importPollTimer = null;
      importPollRunning = true;
      try {
        const response = await sendMessage({ type: "draft-get", url: location.href });
        if (response.ok && response.draft) applyDraftUpdate(response.draft);
      } catch {
        if (draft?.status === "submitting") {
          draft.lastError = "暂时无法查询进度，已保留任务，正在恢复连接…";
          renderStatus();
        }
      } finally {
        importPollRunning = false;
        if (draft?.status === "submitting") scheduleImportPoll();
      }
    }, 1500);
  }

  function applyDraftUpdate(value) {
    const wasImporting = draft?.status === "submitting" && draft?.submitMode === "standard_preprocess";
    draft = value ? Core.normalizeDraft(value) : null;
    if (wasImporting && draft?.status === "saved_locked") {
      const warning = draft.receipt?.receipt?.quality_status === "warning" || draft.receipt?.warnings?.length;
      showToast(warning ? "已导入阅读区；部分格式保留了原始表示，请查看导入记录。" : "译文和导读已按所选步骤完成，已导入本地阅读区。", warning ? "warning" : "ok", warning ? 8000 : 4200);
    } else if (wasImporting && draft?.status === "error") showToast(`导入失败：${draft.lastError}`, "error", 8000);
    renderStatus();
  }

  function closeDialog() {
    ui?.dialog?.replaceChildren();
    ui?.overlay?.classList.remove("is-open");
  }

  function openDialog(title, build) {
    ensureUi();
    ui.dialog.replaceChildren();
    const heading = document.createElement("h2");
    heading.textContent = title;
    ui.dialog.appendChild(heading);
    build(ui.dialog);
    ui.overlay.classList.add("is-open");
  }

  function field(container, label, value = "") {
    const wrapper = document.createElement("label");
    wrapper.className = "field";
    const caption = document.createElement("span");
    caption.textContent = label;
    const input = document.createElement("textarea");
    input.value = value;
    wrapper.append(caption, input);
    container.appendChild(wrapper);
    return input;
  }

  function actionRow(container, actions) {
    const row = document.createElement("div");
    row.className = "dialog-actions";
    for (const action of actions) {
      const button = document.createElement("button");
      button.textContent = action.label;
      if (action.primary) button.className = "primary";
      button.addEventListener("click", action.onClick);
      row.appendChild(button);
    }
    container.appendChild(row);
  }

  function openAnnotation(annotationId) {
    const annotation = draft?.annotations.find((item) => item.id === annotationId);
    if (!annotation || draft.locked) return;
    openDialog(annotation.markKind === "cloze" ? "挖空加工" : "高亮加工", (container) => {
      const types = document.createElement("div");
      types.className = "type-buttons";
      let selectedType = annotation.type;
      const buttons = new Map();
      for (const type of Core.ANNOTATION_TYPES) {
        const button = document.createElement("button");
        button.textContent = TYPE_LABELS[type] || type;
        button.classList.toggle("is-active", type === selectedType);
        button.addEventListener("click", () => {
          selectedType = type;
          for (const [key, node] of buttons) node.classList.toggle("is-active", key === type);
        });
        buttons.set(type, button);
        types.appendChild(button);
      }
      container.appendChild(types);
      const current = field(container, "当前高亮文本", annotation.currentText);
      const comment = field(container, "评论 / 结构化加工", annotation.commentMarkdown);
      const rewrite = field(container, "改写稿", annotation.rewriteMarkdown);
      actionRow(container, [
        { label: "删除记录", onClick: async () => {
          draft = Core.deleteAnnotation(draft, annotation.id);
          await persistDraft();
          renderHighlights();
          closeDialog();
        } },
        { label: "用改写稿替换", onClick: async () => {
          if (!rewrite.value.trim()) return showToast("改写稿为空", "error");
          ({ draft } = Core.updateAnnotation(draft, annotation.id, {
            type: selectedType,
            currentText: rewrite.value.trim(),
            selectedText: rewrite.value.trim(),
            commentMarkdown: comment.value,
            rewriteMarkdown: rewrite.value,
            rewriteApplied: true
          }));
          await persistDraft();
          closeDialog();
        } },
        { label: "保存并关闭", primary: true, onClick: async () => {
          ({ draft } = Core.updateAnnotation(draft, annotation.id, {
            type: selectedType,
            currentText: current.value,
            selectedText: current.value,
            commentMarkdown: comment.value,
            rewriteMarkdown: rewrite.value
          }));
          await persistDraft();
          closeDialog();
        } }
      ]);
    });
  }

  function openMusing() {
    if (!draft || draft.locked) return;
    openDialog("文章随想", (container) => {
      const body = field(container, "全文批注或随想", draft?.articleMusing?.bodyMarkdown || "");
      actionRow(container, [
        { label: "取消", onClick: closeDialog },
        { label: "保存随想", primary: true, onClick: async () => {
          draft = Core.saveMusing(requireDraft(), body.value);
          await persistDraft();
          closeDialog();
        } }
      ]);
    });
  }

  function openQaCards() {
    if (!draft || draft.locked) return;
    openDialog("文章问答卡", (container) => {
      const list = document.createElement("div");
      list.className = "qa-list";
      for (const card of draft?.qaCards || []) {
        const row = document.createElement("div");
        row.textContent = card.questionMarkdown;
        const remove = document.createElement("button");
        remove.textContent = "删除";
        remove.addEventListener("click", async () => {
          draft = Core.deleteQaCard(draft, card.id);
          await persistDraft();
          openQaCards();
        });
        row.appendChild(remove);
        list.appendChild(row);
      }
      container.appendChild(list);
      const question = field(container, "问题", "");
      const answer = field(container, "答案（可留空）", "");
      actionRow(container, [
        { label: "关闭", onClick: closeDialog },
        { label: "添加问答卡", primary: true, onClick: async () => {
          try {
            ({ draft } = Core.addQaCard(requireDraft(), { questionMarkdown: question.value, answerMarkdown: answer.value }));
            await persistDraft();
            openQaCards();
          } catch (error) {
            showToast(error.message === "question_required" ? "请先输入问题" : error.message, "error");
          }
        } }
      ]);
    });
  }

  async function undo() {
    if (!draft || draft.locked) return;
    const result = Core.undo(draft);
    draft = result.draft;
    if (!result.restored) return showToast("没有可撤销的操作", "error");
    await persistDraft();
    renderHighlights();
    showToast("已撤销最近一次加工");
  }

  async function submit(destination, options = {}) {
    if (!draft) throw new Error("draft_not_initialized");
    const force = Boolean(options.force);
    if (draft.locked && !force) return { ok: true, draft, result: draft.receipt || null, skipped: true };
    if (!draft.locked) await persistDraft();
    const standardize = options.mode === "standard_preprocess";
    const response = await sendMessage({
      type: standardize ? "draft-import-local" : force ? "draft-resubmit" : "draft-submit",
      url: location.href,
      destination,
      force,
      mode: options.mode
    });
    if (!response.ok) {
      const error = response.error || "unknown";
      showToast(`提交失败，草稿已保留：${error}`, "error", 8000);
      return { ok: false, error };
    }
    draft = Core.normalizeDraft(response.draft);
    renderStatus();
    if (draft.status === "error") {
      showToast(`导入失败：${draft.lastError}`, "error", 8000);
      return { ok: false, error: draft.lastError };
    }
    if (response.pending || draft.status === "submitting") {
      showToast("已提交后台处理，进度会持续显示；刷新或关闭页面后任务仍会继续。", "ok", 5000);
      return { ok: true, draft, result: response.result || { status: "queued" }, pending: true };
    }
    const resolvedDestination = draft.submitDestination === "completed" ? "completed" : "reading";
    const qualityStatus = String(response.result?.receipt?.quality_status || "ready");
    if (standardize && qualityStatus === "warning") {
      showToast("已导入本地阅读区，但生成的 Markdown 有瑕疵，请复核。", "warning", 8000);
    } else {
      showToast(force
        ? resolvedDestination === "completed" ? "已重新导入待归档区" : "已重新导入本地阅读区"
        : standardize ? "已标准化并导入本地阅读区"
          : destination === "completed" ? "已完成阅读并进入待归档区" : "已保存并锁定当前版本");
    }
    return { ok: true, draft, result: response.result || null };
  }

  async function discardCurrentDraft() {
    if (!draft) return;
    const response = await sendMessage({ type: "draft-discard", url: location.href });
    if (!response.ok) throw new Error(response.error || "draft_discard_failed");
    draft = null;
    mergeSelection = [];
    closeDialog();
    renderHighlights();
    renderStatus();
    showToast("已放弃阅读并清除本页加工记录");
  }

  function setImportLaunchersDisabled(disabled) {
    if (!ui) return;
    ui.initializer.disabled = disabled;
    ui.importLocal.disabled = disabled;
  }

  async function importCurrentPageStandard() {
    if (standardImportBusy) throw new Error("standard_import_already_running");
    standardImportBusy = true;
    ensureUi();
    setImportLaunchersDisabled(true);
    try {
      await initializeDraft({ authoring: false });
      showToast("正在调用标准接口加工并导入本地…", "ok", 0);
      const submitted = await submit("reading", { mode: "standard_preprocess", force: Boolean(draft?.locked) });
      if (!submitted.ok) throw new Error(submitted.error || "standard_import_failed");
      return submitted;
    } catch (error) {
      showToast(`导入失败，草稿已保留：${error.message}`, "error", 8000);
      throw error;
    } finally {
      standardImportBusy = false;
      setImportLaunchersDisabled(draft?.status === "submitting");
    }
  }

  function ensureUi() {
    if (ui) return ui;
    const host = document.createElement("div");
    host.id = "local-ir-browser-workbench";
    document.documentElement.appendChild(host);
    const shadow = host.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = `
      :host{all:initial}[hidden]{display:none!important}.dock{position:fixed;right:18px;bottom:18px;z-index:2147483646;max-width:calc(100vw - 16px);box-sizing:border-box;display:flex;flex-wrap:wrap;align-items:center;gap:6px;padding:8px;background:#fff;border:1px solid #d0d5dd;border-radius:12px;box-shadow:0 8px 28px rgba(16,24,40,.18);font:12px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif;color:#344054}.dock.is-compact{padding:6px}.controls{display:flex;flex-wrap:wrap;align-items:center;gap:6px}.dock-handle{flex:0 0 18px;align-self:stretch;padding:2px 0;border-color:transparent;cursor:grab;touch-action:none;user-select:none;color:#667085}.dock.is-dragging,.dock.is-dragging .dock-handle{cursor:grabbing}.dock-handle:focus-visible{outline:2px solid #1f5fbf;outline-offset:2px}.mode{font-weight:650}.mode.is-active{border-color:#1f5fbf;background:#eef4ff;color:#174a96}button{border:1px solid #c9d0dc;border-radius:7px;padding:6px 9px;background:#fff;color:#1d2939;cursor:pointer;font:inherit}button:hover,button.is-active{border-color:#1f5fbf;background:#eef4ff}button.initialize{background:#1f5fbf;color:#fff;border-color:#1f5fbf;font-weight:650}button.primary{background:#1f5fbf;color:#fff;border-color:#1f5fbf}button.complete{background:#067647;color:#fff;border-color:#067647}button.abandon{background:#d92d20;color:#fff;border-color:#d92d20}button.abandon:hover{background:#b42318;border-color:#b42318}button:disabled{opacity:.45;cursor:not-allowed}.status{max-width:min(320px,50vw);white-space:normal;overflow-wrap:anywhere}.overlay{display:none;position:fixed;inset:0;z-index:2147483647;background:rgba(16,24,40,.38);align-items:center;justify-content:center}.overlay.is-open{display:flex}.dialog{width:min(900px,92vw);max-height:84vh;overflow:auto;background:#fff;border-radius:14px;padding:18px;box-shadow:0 24px 64px rgba(16,24,40,.28);font:13px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif;color:#1d2939}.dialog h2{margin:0 0 14px;font-size:18px}.field{display:grid;gap:5px;margin:12px 0}.field span{font-weight:650}.field textarea{box-sizing:border-box;width:100%;min-height:92px;border:1px solid #c9d0dc;border-radius:8px;padding:9px;font:13px/1.5 ui-monospace,SFMono-Regular,Consolas,monospace}.type-buttons,.dialog-actions{display:flex;flex-wrap:wrap;gap:7px}.dialog-actions{justify-content:flex-end;margin-top:16px}.qa-list{display:grid;gap:7px}.qa-list>div{display:flex;justify-content:space-between;gap:10px;padding:8px;border:1px solid #eaecf0;border-radius:7px}`;
    const dock = document.createElement("div");
    dock.className = "dock";
    const dragHandle = document.createElement("button");
    dragHandle.className = "dock-handle";
    dragHandle.type = "button";
    dragHandle.textContent = "⋮⋮";
    dragHandle.title = "拖动工具框；聚焦后可用方向键移动";
    dragHandle.setAttribute("aria-label", "拖动工具框");
    const initializer = document.createElement("button");
    initializer.className = "initialize";
    initializer.textContent = "初始化加工";
    initializer.addEventListener("click", async () => {
      initializer.disabled = true;
      importLocal.disabled = true;
      try {
        await initializeDraft();
      } catch (error) {
        showToast(`初始化失败：${error.message}`, "error");
      } finally {
        initializer.disabled = false;
        importLocal.disabled = false;
      }
    });
    const importLocal = document.createElement("button");
    importLocal.className = "import-local";
    importLocal.textContent = "导入本地";
    importLocal.addEventListener("click", () => void importCurrentPageStandard().catch(() => {}));
    const controls = document.createElement("div");
    controls.className = "controls";
    const makeButton = (label, handler, className = "") => {
      const button = document.createElement("button");
      button.textContent = label;
      button.className = className;
      button.addEventListener("click", handler);
      controls.appendChild(button);
      return button;
    };
    const changeMode = (mode) => void setAuthoringMode(mode).catch((error) => showToast(`模式切换失败：${error.message}`, "error"));
    const processing = makeButton("加工模式", () => changeMode("processing"), "mode");
    const cloze = makeButton("挖空模式", () => changeMode("cloze"), "mode");
    const undoButton = makeButton("撤销", () => void undo());
    const musing = makeButton("随想", openMusing);
    const qa = makeButton("问答卡", openQaCards);
    const save = makeButton("保存", () => void submit("reading", {
      force: Boolean(draft?.locked),
      mode: draft?.submitMode === "standard_preprocess" ? "standard_preprocess" : "local"
    }).catch((error) => showToast(`保存失败：${error.message}`, "error", 8000)), "primary");
    const complete = makeButton("完成阅读", () => void submit("completed").catch((error) => showToast(`完成阅读失败：${error.message}`, "error", 8000)), "complete");
    const abandon = makeButton("放弃阅读", () => void discardCurrentDraft().catch((error) => showToast(`放弃阅读失败：${error.message}`, "error", 8000)), "abandon");
    const status = document.createElement("span");
    status.className = "status";
    dock.append(dragHandle, initializer, importLocal, controls, status);
    const overlay = document.createElement("div");
    overlay.className = "overlay";
    const dialog = document.createElement("div");
    dialog.className = "dialog";
    overlay.appendChild(dialog);
    overlay.addEventListener("click", (event) => { if (event.target === overlay) closeDialog(); });
    shadow.append(style, dock, overlay);
    ui = { dock, initializer, importLocal, controls, processing, cloze, undo: undoButton, musing, qa, save, complete, abandon, status, overlay, dialog };
    makeDockMovable(dock, dragHandle);
    renderStatus();
    return ui;
  }

  async function captureRange(range, selection = null) {
    if (!draft || draft.locked || authoringMode === "off") return;
    const selectedText = trimText(range.toString(), 60000);
    if (!selectedText) return;
    const now = Date.now();
    const captureKey = `${location.href}\n${selectedText}`;
    if (captureKey === lastCaptureKey && now - lastCaptureAt < 1000) return;
    lastCaptureKey = captureKey;
    lastCaptureAt = now;
    const offsets = rangeOffsets(range);
    const context = contextForRange(range, selectedText);
    selection?.removeAllRanges();
    try {
      ({ draft } = Core.addAnnotation(requireDraft(), {
        selectedText,
        currentText: selectedText,
        markKind: authoringMode === "cloze" ? "cloze" : "highlight",
        ranges: [offsets],
        contextBefore: context.before,
        contextAfter: context.after
      }));
      await persistDraft();
      renderHighlights();
      showToast(authoringMode === "cloze" ? "已添加虚拟挖空" : "已添加虚拟高亮");
    } catch (error) {
      showToast(`高亮失败：${error.message}`, "error");
    }
  }

  async function captureSelection() {
    if (!draft || draft.locked || authoringMode === "off") return;
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) return;
    if (isEditableNode(selection.anchorNode) || isEditableNode(selection.focusNode)) return;
    await captureRange(selection.getRangeAt(0).cloneRange(), selection);
  }

  async function captureClickedParagraph(event) {
    if (!event.ctrlKey || event.altKey || event.metaKey || !draft || draft.locked || authoringMode === "off") return false;
    const target = event.target instanceof Element ? event.target : event.target?.parentElement;
    if (!target || target.closest("#local-ir-browser-workbench") || isEditableNode(target)) return false;
    const paragraph = target.closest("p, li, blockquote, pre, figcaption, dd, dt, h1, h2, h3, h4, h5, h6, td, th");
    if (!paragraph || paragraph.closest("#local-ir-browser-workbench")) return false;
    const range = document.createRange();
    range.selectNodeContents(paragraph);
    if (!trimText(range.toString(), 60000)) return false;
    event.preventDefault();
    event.stopPropagation();
    await captureRange(range);
    return true;
  }

  document.addEventListener("click", (event) => {
    const mark = event.target.closest?.("mark.local-ir-browser-highlight[data-local-ir-annotation-id]");
    if (mark && draft && (event.altKey || event.metaKey)) {
      event.preventDefault();
      event.stopPropagation();
      const id = mark.dataset.localIrAnnotationId;
      if (!mergeSelection.includes(id)) mergeSelection.push(id);
      mark.classList.add("is-merge-selected");
      if (mergeSelection.length >= 2) {
        try {
          ({ draft } = Core.mergeAnnotations(draft, mergeSelection));
          mergeSelection = [];
          void persistDraft().then(renderHighlights);
          showToast("已合并高亮");
        } catch (error) {
          mergeSelection = [];
          showToast(`合并失败：${error.message}`, "error");
        }
      } else showToast("已选择 1 条高亮，再按 Alt 点击另一条合并");
      return;
    }
    if (event.ctrlKey && !event.altKey && !event.metaKey) {
      void captureClickedParagraph(event);
      return;
    }
    if (!mark || !draft) return;
    event.preventDefault();
    event.stopPropagation();
    const id = mark.dataset.localIrAnnotationId;
    openAnnotation(id);
  }, true);

  chrome.storage.local.get({ [MODE_KEY]: null, [LEGACY_MODE_KEY]: false, [DOCK_POSITION_KEY]: null }, async (data) => {
    dockPosition = data[DOCK_POSITION_KEY];
    authoringMode = Core.normalizeAuthoringMode(data[MODE_KEY], Boolean(data[LEGACY_MODE_KEY]));
    if (data[MODE_KEY] !== authoringMode) chrome.storage.local.set({ [MODE_KEY]: authoringMode });
    const response = await sendMessage({ type: "draft-get", url: location.href });
    if (response.ok && response.draft) {
      draft = Core.normalizeDraft(response.draft);
      renderHighlights();
    }
    ensureUi();
    renderStatus();
  });

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local") return;
    if (changes[DOCK_POSITION_KEY]) {
      dockPosition = changes[DOCK_POSITION_KEY].newValue;
      positionDock();
    }
    if (changes[MODE_KEY]) {
      authoringMode = Core.normalizeAuthoringMode(changes[MODE_KEY].newValue);
      renderStatus();
    }
  });

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    (async () => {
      if (message?.type === "set-highlight-enabled") {
        authoringMode = message.enabled ? "processing" : "off";
        await new Promise((resolve) => chrome.storage.local.set({ [MODE_KEY]: authoringMode }, resolve));
        renderStatus();
        sendResponse({ ok: true, enabled: authoringMode !== "off", mode: authoringMode });
        return;
      }
      if (message?.type === "get-content-status") {
        sendResponse({ ok: true, initialized: Boolean(draft), mode: authoringMode, url: location.href, title: document.title || "", draft: draft ? Core.summary(draft) : null });
        return;
      }
      if (message?.type === "save-draft") {
        const submitted = await submit(message.destination === "completed" ? "completed" : "reading");
        if (!submitted.ok) throw new Error(submitted.error || "draft_submit_failed");
        sendResponse({ ok: true, draft: draft ? Core.summary(draft) : null });
        return;
      }
      if (message?.type === "context-import-current-page") {
        const submitted = await importCurrentPageStandard();
        sendResponse({ ok: true, result: submitted.result || null, draft: draft ? Core.summary(draft) : null });
        return;
      }
      if (message?.type === "context-import-progress") {
        const phase = String(message.phase || "started");
        const text = String(message.message || "正在导入到渐进阅读…");
        showToast(text, phase === "failed" ? "error" : phase === "warning" ? "warning" : "ok", phase === "started" ? 0 : new Set(["failed", "warning"]).has(phase) ? 8000 : 4200);
        sendResponse({ ok: true });
        return;
      }
      if (message?.type === "draft-state") {
        applyDraftUpdate(message.draft);
        if (!draft) {
          mergeSelection = [];
          closeDialog();
        }
        renderHighlights();
        renderStatus();
        sendResponse({ ok: true });
        return;
      }
      sendResponse({ ok: false, error: "unknown_message" });
    })().catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  });

  document.addEventListener("mouseup", (event) => {
    if (isEditableNode(event.target)) return;
    window.setTimeout(() => void captureSelection(), 35);
  }, true);
})();
