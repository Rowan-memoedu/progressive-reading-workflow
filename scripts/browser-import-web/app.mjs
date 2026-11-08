import { inspectUrls } from "../url-import-input.mjs";
import { ImportSession, MAX_URLS, resultView } from "./client.mjs";

export function mountImportPage(doc = document, { fetchImpl = globalThis.fetch.bind(globalThis), storage, pollMs = 1200 } = {}) {
  const el = id => doc.getElementById(id);
  const win = doc.defaultView;
  let storageUnavailable = false;
  if (!storage) { try { storage = win.sessionStorage; } catch { storageUnavailable = true; } }
  let timer;
  let healthTimer;
  let stopped = false;
  const session = new ImportSession({ storage, fetchImpl, onChange: render });
  if (storageUnavailable) session.storageError = "浏览器无法保存进度。请保持页面打开，并保留请求编号。";
  el("input").value = session.state.input;
  el("instruction").value = session.state.instruction;
  const controls = new Map();
  const choices = [
    ["content_profile", "材料类型", [["natural_language", "普通文章 / 技术文章"], ["math_lecture", "数理讲义"], ["literature", "文学"]]],
    ["input_form", "原文形式", [["written", "书面文字"], ["spoken_transcript", "口述转写"]]],
    ["source_language", "原文语言", [["zh", "中文"], ["en", "英文"], ["bilingual", "中英双语"], ["other", "其他语言"]]],
    ...[["spoken_to_written", "口语转书面"], ["structure_body", "强结构化整理"], ["translate", "翻译"], ["include_reading_guide", "生成导读"]].map(([key, label]) => [key, label, [["true", "开启"], ["false", "关闭"]]])
  ];
  for (const [key, label, options] of choices) {
    const wrapper = node("label", label);
    const select = doc.createElement("select");
    select.id = `processing-${key}`;
    wrapper.htmlFor = select.id;
    for (const [value, text] of [["", "自动"], ...options]) {
      const option = node("option", text); option.value = value; select.append(option);
    }
    select.value = String(session.state.processingOptions?.[key] ?? "");
    select.addEventListener("change", () => saveDraft());
    controls.set(key, select); wrapper.append(select); el("processing-options").append(wrapper);
  }

  function node(tag, text, className = "") {
    const result = doc.createElement(tag);
    result.textContent = text;
    if (className) result.className = className;
    return result;
  }

  function render() {
    const preview = inspectUrls(session.state.input);
    const overLimit = preview.urls.length > MAX_URLS;
    el("preview-count").textContent = `识别 ${preview.urls.length} 个链接${preview.duplicates ? ` · 已去重 ${preview.duplicates} 个` : ""}${preview.invalid ? ` · 无效 ${preview.invalid} 个` : ""}`;
    el("preview-list").replaceChildren(...preview.urls.map(url => node("li", url)));
    el("start").disabled = session.pending || session.awaitingInput || session.busy || !preview.urls.length || overLimit;
    el("start").textContent = session.pending ? "导入进行中" : `导入到阅读区${preview.urls.length ? `（${preview.urls.length}）` : ""}`;
    el("input-message").textContent = overLimit ? `当前 ${preview.urls.length} 个链接，超过单批 50 个限制。请分批提交。` : "";
    el("input-message").className = overLimit ? "error" : "hint";
    el("storage-message").textContent = session.storageError;
    const results = session.latestResults();
    const views = results.map(resultView);
    const counts = kind => views.filter(view => view.kind === kind).length;
    const finished = counts("success") + counts("warning") + counts("failed") + counts("unconfirmed");
    el("summary").textContent = results.length
      ? `${session.pending ? "进行中" : session.awaitingInput ? "等待补充分类" : "本批次已结束"} · 成功 ${counts("success")} · 质量警告 ${counts("warning")} · 失败 ${counts("failed")}${counts("needs_input") ? ` · 待补分类 ${counts("needs_input")}` : ""}${counts("unconfirmed") ? ` · 待核实 ${counts("unconfirmed")}` : ""} · 等待 ${counts("pending")}`
      : "添加链接后，这里会逐条显示进度与结果。";
    el("progress").hidden = !results.length;
    el("progress").max = Math.max(1, results.length);
    el("progress").value = finished;
    el("retry-all").hidden = !views.some(view => view.retryable);
    el("retry-all").disabled = session.pending || session.busy;
    el("connection").hidden = !session.current?.error;
    el("connection-message").textContent = session.current?.error ? `${session.current.error} 已保留当前请求，恢复连接后可继续。` : "";
    el("resume").disabled = session.busy;
    const openCollections = new Set([...doc.querySelectorAll("details[data-collection][open]")].map(item => item.dataset.collection));
    el("results").replaceChildren(...results.map((result, index) => {
      const view = views[index];
      const li = node("li", "", `result ${view.kind}`);
      li.dataset.status = result.status;
      li.append(node("span", view.label, "badge"), node("p", result.requested_url, "url"));
      if (result.attempt_count) li.append(node("p", `后台尝试 ${result.attempt_count} / ${result.max_attempts || "—"}`, "hint"));
      if (view.detail) li.append(node("p", view.detail, "detail"));
      if (view.path) li.append(node("p", view.path, "file-path"));
      if (result.collection?.results?.length) {
        const detail = node("details", "", "collection-details");
        detail.dataset.collection = result.requested_url;
        detail.open = openCollections.has(result.requested_url);
        detail.append(node("summary", `查看 ${result.collection.results.length} 篇文章的逐条结果`));
        const list = node("ol", "", "collection-results");
        for (const article of result.collection.results) {
          const itemView = resultView(article);
          const item = node("li", "", itemView.kind);
          item.append(node("span", itemView.label, "badge"), node("p", article.requested_url, "url"));
          if (itemView.detail) item.append(node("p", itemView.detail, "detail"));
          if (itemView.path) item.append(node("p", itemView.path, "file-path"));
          list.append(item);
        }
        detail.append(list); li.append(detail);
      }
      if (view.retryable) {
        const button = node("button", "重试此项", "secondary small");
        button.type = "button";
        button.disabled = session.pending || session.busy;
        button.addEventListener("click", () => perform(() => session.retryFailed(result.requested_url)));
        li.append(button);
      }
      if (view.kind === "needs_input") {
        const button = node("button", "使用当前分类与处理选择继续", "secondary small");
        button.type = "button"; button.disabled = session.pending || session.busy;
        button.addEventListener("click", () => perform(() => session.resumeClassification(result.requested_url)));
        li.append(button);
      }
      return li;
    }));
    el("history").hidden = !session.state.attempts.length;
    el("history-list").replaceChildren(...session.state.attempts.map((attempt, index) => {
      const item = node("div", "", "history-item");
      item.append(node("p", `第 ${index + 1} 次 · ${attempt.urls.length} 项 · ${attempt.snapshot?.status || "等待受理"}`), node("p", attempt.requestId || attempt.id, "file-path"));
      for (const result of attempt.snapshot?.results || []) {
        const view = resultView(result);
        if (view.kind === "failed" || view.kind === "warning" || view.kind === "unconfirmed") item.append(node("p", `${result.requested_url}：${view.label} ${view.detail}`, "detail"));
      }
      return item;
    }));
  }

  async function pump() {
    clearTimeout(timer);
    await session.step();
    if (!stopped && session.pending && !session.current.error) timer = setTimeout(pump, pollMs);
  }
  function perform(action) {
    try { action(); void pump(); }
    catch (error) { el("input-message").textContent = error.message; }
  }
  const saveDraft = () => session.setDraft(el("input").value, el("instruction").value,
    Object.fromEntries([...controls].filter(([, select]) => select.value !== "").map(([key, select]) =>
      [key, select.value === "true" ? true : select.value === "false" ? false : select.value])));
  el("input").addEventListener("input", saveDraft);
  el("instruction").addEventListener("input", saveDraft);
  el("start").addEventListener("click", () => perform(() => session.start()));
  el("retry-all").addEventListener("click", () => perform(() => session.retryFailed()));
  el("resume").addEventListener("click", () => void pump());
  el("clear").addEventListener("click", () => { el("input").value = ""; el("instruction").value = ""; for (const select of controls.values()) select.value = ""; saveDraft(); el("input").focus(); });
  const resume = () => { if (session.pending && !session.busy) void pump(); };
  win.addEventListener("online", resume);
  render();
  void fetchImpl("/api/browser-import/rules", { cache: "no-store", signal: AbortSignal.timeout(10000) }).then(async response => {
    if (!response.ok) throw new Error();
    const catalog = await response.json();
    if (catalog.schema !== "local-ir.import-rules/v1" || !Array.isArray(catalog.rules)) throw new Error();
    el("rules-list").replaceChildren(...catalog.rules.filter(rule => rule.enabled).map(rule => {
      const item = node("div", "", "rule");
      item.append(node("strong", rule.title), node("p", rule.match), node("p", rule.action), node("p", rule.boundary, "hint"));
      return item;
    }));
  }).catch(() => { el("rules-list").textContent = "规则清单暂时不可用，请检查本地服务是否已更新。"; });
  function updateHealth() {
    return fetchImpl("/api/highlights/health", { cache: "no-store", signal: AbortSignal.timeout(10000) }).then(async response => {
    if (!response.ok) throw new Error();
    const health = await response.json();
    if (health.status !== "ok" || health.service !== "local-ir-browser-highlight") throw new Error();
    const auth = health.cookieSnapshot;
    el("health").textContent = auth?.loaded
      ? `本地服务已连接 · ${auth.mode === "chrome_live_sync" ? "Chrome 登录态已同步" : "手动登录态快照已加载"}${auth.last_sync_at ? ` · ${new Date(auth.last_sync_at).toLocaleString()}` : ""}，各网站是否允许访问以导入结果为准`
      : auth?.status === "stale" ? "本地服务已连接 · Chrome 登录态超过 15 分钟未更新，请检查扩展同步状态；使用这些登录态的来源需恢复同步后重试"
      : auth?.mode === "manual_snapshot" && auth?.error ? "本地服务已连接 · 手动快照不可用，自动同步接收已关闭；需要修复服务启动配置"
      : auth?.error === "snapshot_file_not_found" ? "本地服务已连接 · 持续同步文件已丢失，请检查 Chrome Cookie 本地同步扩展的状态"
      : "本地服务已连接 · 等待 Chrome 登录态同步，需要登录的来源暂时无法导入";
    }).catch(() => { el("health").textContent = "本地服务暂时未连接。连接恢复后可继续提交或查询。"; })
      .finally(() => { if (!stopped) healthTimer = setTimeout(updateHealth, 30000); });
  }
  void updateHealth();
  if (session.pending) void pump();
  return { session, stop() { stopped = true; clearTimeout(timer); clearTimeout(healthTimer); win.removeEventListener("online", resume); } };
}

if (typeof document !== "undefined") mountImportPage();
