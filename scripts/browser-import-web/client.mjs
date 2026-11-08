import { extractUrls, urlImportDedupeKey } from "../url-import-input.mjs";

export const MAX_URLS = 50;
export const STORAGE_KEY = "local-ir.web-import.v1";
const SUCCESS = new Set(["imported", "imported_with_warnings", "idempotent_replay"]);
const RETRYABLE = new Set(["failed", "requires_browser_auth", "requires_js_render"]);

export function resultView(result = {}) {
  const status = result.status || "queued";
  const receipt = result.receipt || {};
  if (status === "needs_classification") {
    const labels = { content_profile: "材料类型", input_form: "书面 / 口述", source_language: "原文语言" };
    const missing = receipt.missing_labels || [...new Set((result.collection?.results || []).flatMap(row => row.receipt?.missing_labels || []))];
    return { kind: "needs_input", label: "等待补充分类", retryable: false,
      detail: `请在左侧补充${missing.map(key => labels[key] || key).join("、") || "分类或处理选择"}后继续。已保留原文与完成的步骤。` };
  }
  if (result.collection) {
    const collection = result.collection;
    const articles = collection.inventory?.articles || [];
    const rows = collection.results || [];
    const views = rows.map(resultView);
    const success = views.filter(view => view.kind === "success").length;
    const warnings = views.filter(view => view.kind === "warning").length;
    const failed = views.filter(view => ["failed", "unconfirmed"].includes(view.kind)).length;
    const detail = `文章 ${articles.length || collection.discovery?.discovered || 0} 篇 · 成功 ${success} · 警告 ${warnings} · 失败 ${failed}${collection.inventory?.excluded_count ? ` · 非文章条目 ${collection.inventory.excluded_count}` : ""}`;
    if (["queued", "claimed"].includes(status)) return { kind: "pending", label: collection.phase === "discovering" ? `枚举专栏中 · 已读取 ${collection.discovery?.pages || 0} 页` : "专栏逐篇导入中", detail, retryable: false };
    if (!collection.inventory?.complete || RETRYABLE.has(status)) return { kind: "failed", label: status === "requires_browser_auth" ? "专栏需要登录或访问权限" : "专栏未完整导入", detail: `${detail}。${collection.error || result.error || "可重试专栏，已有文章由后端复用。"}`, retryable: true };
    const expected = new Set(articles.map(article => article.url));
    if (rows.length !== expected.size || new Set(rows.map(row => row.requested_url)).size !== expected.size
      || rows.some(row => !expected.has(row.requested_url)) || success + warnings !== rows.length) {
      return { kind: "unconfirmed", label: "专栏回执待核实", detail, retryable: false };
    }
    return { kind: warnings ? "warning" : "success", label: articles.length ? warnings ? "专栏已导入 · 质量警告" : "专栏已全部导入" : "专栏没有文章", detail, retryable: false };
  }
  const artifact = (Array.isArray(result.artifacts) ? result.artifacts : []).find(item => item.kind === "markdown" && item.path);
  const message = [result.error, ...(result.errors || []).map(item => item.message || item.code)].filter(Boolean).join("；");
  if (SUCCESS.has(status)) {
    const hash = artifact?.sha256 || receipt.final_markdown_sha256;
    if (!artifact || !/^[a-f0-9]{64}$/iu.test(hash || "") || receipt.processing_mode !== "standard_preprocess"
      || !["ready", "warning"].includes(receipt.quality_status)
      || !["completed", "completed_with_warnings", "idempotent_replay"].includes(receipt.preprocess_status)) {
      return { kind: "unconfirmed", label: "落盘回执不完整", detail: "服务已返回结果，但缺少可核验的正式文件回执。", retryable: false };
    }
    const warning = status === "imported_with_warnings" || receipt.quality_status === "warning";
    return {
      kind: warning ? "warning" : "success",
      label: warning ? "已导入 · 质量警告" : status === "idempotent_replay" ? "已在阅读区 · 复用" : "已导入",
      detail: warning ? (receipt.warning_codes || []).join("；") || "正文可读，部分加工未达到完整质量要求。" : "",
      path: artifact.path, hash, retryable: false
    };
  }
  if (RETRYABLE.has(status)) {
    const labels = { failed: "导入失败", requires_browser_auth: "需要登录", requires_js_render: "需要网页渲染" };
    const help = { requires_browser_auth: "同步可用登录态后再重试。", requires_js_render: "当前后台抓取无法获得完整正文，直接重试可能仍失败。",
      ...(/existing_article_.*preserved/u.test(message) ? { failed: "已有文章已保留。内容与历史回执不一致，需要检查后处理。" } : {}) };
    return { kind: "failed", label: labels[status], detail: [help[status], message].filter(Boolean).join(" "), retryable: true };
  }
  if (status === "queued" || status === "claimed") {
    return { kind: "pending", label: status === "claimed" ? "抓取与标准加工中" : "排队中", detail: message, retryable: false };
  }
  return { kind: "unconfirmed", label: "状态待核实", detail: String(status), retryable: false };
}

export class ImportSession {
  constructor({ storage, fetchImpl = globalThis.fetch.bind(globalThis), makeId = () => globalThis.crypto.randomUUID(), onChange = () => {} } = {}) {
    this.storage = storage;
    this.fetchImpl = fetchImpl;
    this.makeId = makeId;
    this.onChange = onChange;
    this.busy = false;
    this.storageError = "";
    this.state = { version: 1, input: "", instruction: "", processingOptions: {}, attempts: [] };
    try {
      const saved = JSON.parse(storage?.getItem(STORAGE_KEY) || "null");
      if (saved) {
        if (saved.version !== 1 || !Array.isArray(saved.attempts) || saved.attempts.some(a =>
          !a.id || !Array.isArray(a.urls) || !a.urls.length || a.urls.length > MAX_URLS || extractUrls(a.urls.join("\n")).length !== a.urls.length)) {
          throw new Error("invalid_saved_import");
        }
        this.state = saved;
      }
    } catch { this.storageError = "无法恢复浏览器中的记录；请保留已有请求编号，避免重复提交。"; }
  }

  get current() { return this.state.attempts.find(attempt => attempt.id === this.state.activeAttemptId) || this.state.attempts.at(-1); }
  get pending() { return Boolean(this.current && (this.current.pendingResume || !this.current.snapshot?.terminal)); }
  get awaitingInput() { return this.latestResults().some(row => resultView(row).kind === "needs_input"); }

  save() {
    try { this.storage?.setItem(STORAGE_KEY, JSON.stringify(this.state)); }
    catch { this.storageError = "浏览器无法保存进度。请保持页面打开，并保留请求编号。"; }
    this.onChange(this);
  }

  setDraft(input, instruction, processingOptions = this.state.processingOptions || {}) {
    this.state.input = input;
    this.state.instruction = instruction;
    this.state.processingOptions = structuredClone(processingOptions);
    this.save();
  }

  addAttempt(urls, instruction, processingOptions = this.state.processingOptions || {}) {
    const id = `web-import-${this.makeId()}`;
    this.state.attempts.push({ id, urls, instruction, processingOptions: structuredClone(processingOptions), requestId: null, snapshot: null, error: "" });
    this.state.activeAttemptId = id;
    // Persist the id before the first POST; an uncertain response must reuse it.
    this.save();
  }

  start() {
    if (this.pending || this.busy) throw new Error("请先等待当前批次结束，或恢复其状态查询。");
    if (this.awaitingInput) throw new Error("请先补充当前批次的分类并继续处理。");
    const urls = extractUrls(this.state.input);
    if (!urls.length) throw new Error("请粘贴至少一个 HTTP(S) 链接。");
    if (urls.length > MAX_URLS) throw new Error(`每批最多 ${MAX_URLS} 个链接，当前 ${urls.length} 个；请分批提交。`);
    this.state.attempts = [];
    this.addAttempt(urls, this.state.instruction);
  }

  latestResults() {
    const byUrl = new Map();
    for (const attempt of this.state.attempts) {
      const results = new Map((attempt.snapshot?.results || []).map(item => [urlImportDedupeKey(item.requested_url), item]));
      for (const url of attempt.urls) {
        const result = results.get(urlImportDedupeKey(url)) || { requested_url: url, status: "queued" };
        byUrl.set(urlImportDedupeKey(url), { ...result, attemptId: attempt.id });
      }
    }
    return [...byUrl.values()];
  }

  retryFailed(url = null) {
    if (this.pending || this.busy) throw new Error("请等待当前尝试结束后再重试。");
    const urls = this.latestResults().filter(item => resultView(item).retryable
      && (!url || urlImportDedupeKey(item.requested_url) === urlImportDedupeKey(url))).map(item => item.requested_url);
    if (!urls.length) throw new Error("没有可重试的失败条目。");
    // A terminal broker request is immutable. An explicit rerun is a new attempt.
    this.addAttempt(urls, this.current.instruction, { ...this.current.processingOptions, ...this.state.processingOptions });
  }

  resumeClassification(url) {
    if (this.pending || this.busy) throw new Error("请等待当前处理结束后再补充分类。");
    const row = this.latestResults().find(item => urlImportDedupeKey(item.requested_url) === urlImportDedupeKey(url) && resultView(item).kind === "needs_input");
    if (!row) throw new Error("此项当前不需要补充分类。");
    const options = this.state.processingOptions || {};
    if (!Object.keys(options).length) throw new Error("请先选择材料类型，或明确指定需要的处理步骤。");
    const attempt = this.state.attempts.find(item => item.id === row.attemptId);
    attempt.pendingResume = { processing_options: structuredClone(options), urls: [row.requested_url] };
    this.state.activeAttemptId = attempt.id;
    this.save();
  }

  async step() {
    if (this.busy || !this.pending) return;
    const attempt = this.current;
    this.busy = true;
    this.onChange(this);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20000);
    try {
      const creating = !attempt.requestId;
      const resuming = Boolean(attempt.pendingResume);
      const requestUrl = creating ? "/api/browser-import/requests" : `/api/browser-import/requests/${encodeURIComponent(attempt.requestId)}${resuming ? "/classification" : ""}`;
      const response = await this.fetchImpl(requestUrl, {
        method: creating || resuming ? "POST" : "GET", cache: "no-store", signal: controller.signal,
        ...(creating || resuming ? {
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(resuming ? attempt.pendingResume : { urls: attempt.urls, source: "web_import_page", entry_route: "obsidian", client_request_id: attempt.id, user_instruction: attempt.instruction, processing_options: attempt.processingOptions || {} })
        } : {})
      });
      const value = await response.json();
      if (!response.ok) throw new Error(typeof value.error === "string" ? value.error : `HTTP ${response.status}`);
      // Keep the returned id even if the remainder is malformed; recovery then only queries.
      if (creating && typeof value.request_id === "string" && value.request_id) attempt.requestId = value.request_id;
      const expected = new Set(attempt.urls.map(urlImportDedupeKey));
      const actual = new Set((Array.isArray(value.results) ? value.results : []).map(item => urlImportDedupeKey(item.requested_url)));
      if (!attempt.requestId || value.request_id !== attempt.requestId || typeof value.terminal !== "boolean"
        || value.requested !== expected.size || actual.size !== expected.size || value.results.length !== expected.size
        || [...actual].some(key => !expected.has(key)) || (value.client_request_id && value.client_request_id !== attempt.id)
        || (value.terminal && value.results.some(item => ["queued", "claimed"].includes(item.status)))) {
        throw new Error("服务回执与当前批次不一致；请继续查询，暂不确认完成。");
      }
      attempt.snapshot = {
        request_id: value.request_id, terminal: value.terminal, status: value.status, awaiting_input: Boolean(value.awaiting_input),
        results: value.results.map(({ requested_url, status, artifacts, receipt, error, errors, attempt_count, max_attempts, collection }) =>
          ({ requested_url, status, artifacts, receipt, error, errors, attempt_count, max_attempts, collection }))
      };
      delete attempt.pendingResume;
      attempt.error = "";
    } catch (error) {
      attempt.error = error.name === "AbortError" ? "连接超时，导入可能仍在后台进行。" : error.message;
    } finally {
      clearTimeout(timeout);
      this.busy = false;
      this.save();
    }
  }
}
