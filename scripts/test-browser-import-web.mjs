import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import { JSDOM } from "jsdom";
import { extractUrls, inspectUrls, urlImportDedupeKey } from "./url-import-input.mjs";
import { ImportSession, resultView, STORAGE_KEY } from "./browser-import-web/client.mjs";
import { mountImportPage } from "./browser-import-web/app.mjs";

const a = "https://example.test/article";
const b = "https://another.test/post";
const hash = "a".repeat(64);
function storage() { const map = new Map(); return { getItem: key => map.get(key), setItem: (key, value) => map.set(key, value) }; }
function success(url, warning = false) {
  return { requested_url: url, status: "imported", artifacts: [{ kind: "markdown", path: "D:/fixture/阅读区/example.test/article.md", sha256: hash }], receipt: {
    processing_mode: "standard_preprocess", preprocess_status: "completed", quality_status: warning ? "warning" : "ready", warning_codes: warning ? ["fixture_warning"] : []
  } };
}
function snapshot(urls, results, terminal = true, requestId = "request-1") {
  return { request_id: requestId, requested: urls.length, terminal, results, status: terminal ? "completed" : "processing" };
}
function response(value, status = 200) { return new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } }); }

test("mixed text, adjacent Markdown links, balanced parentheses, backticks and Chinese punctuation", () => {
  assert.deepEqual(extractUrls(`参考：[第一篇](${a})[第二篇](${b})，以及 \`https://en.test/wiki/Foo_(bar)\`。\n<https://x.test/path#part> ftp://ignore.test/x`), [a, b, "https://en.test/wiki/Foo_(bar)", "https://x.test/path"]);
  assert.deepEqual(extractUrls(`https://x.test/a)。\nhttps://x.test/b?x=1&y=2`), ["https://x.test/a", "https://x.test/b?x=1&y=2"]);
  assert.deepEqual(extractUrls("[文章](https://例子.测试/中文路径) https://[::1]:8080/article"), [new URL("https://例子.测试/中文路径").href, "https://[::1]:8080/article"]);
  assert.deepEqual(extractUrls(`${a},${b};https://third.test/p`), [a, b, "https://third.test/p"]);
});
test("Obsidian identity: fragments, trackers, sorted query and trailing slash deduplicate without changing retained source", () => {
  const first = "HTTPS://EXAMPLE.test:443/article/?b=2&utm_source=notes&a=1#one";
  const found = inspectUrls(`${first}\nhttps://example.test/article?a=1&b=2&fbclid=x\nhttps://example.test/article?b=3`);
  assert.equal(found.urls.length, 2);
  assert.equal(found.duplicates, 1);
  assert.equal(found.urls[0], "https://example.test/article/?b=2&utm_source=notes&a=1");
  assert.equal(urlImportDedupeKey(found.urls[0]), "https://example.test/article?a=1&b=2");
});
test("50 is accepted; 51 and empty input are rejected before a request is created", () => {
  const session = new ImportSession({ storage: storage() });
  assert.throws(() => session.start(), /至少一个/u);
  session.setDraft(Array.from({ length: 51 }, (_, i) => `${a}/${i}`).join("\n"), "");
  assert.throws(() => session.start(), /分批/u);
  assert.equal(session.state.attempts.length, 0);
  session.setDraft(Array.from({ length: 50 }, (_, i) => `${a}/${i}`).join("\n"), "");
  session.start();
  assert.equal(session.current.urls.length, 50);
});
test("uncertain POST persists before network and reuses id across reload, then polls GET only", async () => {
  const saved = storage();
  const requests = [];
  let lost = true;
  const fetchImpl = async (url, options) => {
    requests.push({ url, ...options });
    assert.ok(JSON.parse(saved.getItem(STORAGE_KEY)).attempts[0].id);
    if (lost) { lost = false; throw new Error("lost_response"); }
    return response(snapshot([a], options.method === "POST" ? [{ requested_url: a, status: "queued" }] : [success(a)], options.method !== "POST"), options.method === "POST" ? 202 : 200);
  };
  const first = new ImportSession({ storage: saved, fetchImpl });
  first.setDraft(a, "保留公式"); first.start(); await first.step();
  const restored = new ImportSession({ storage: saved, fetchImpl });
  await restored.step(); await restored.step();
  assert.equal(requests[0].body, requests[1].body);
  assert.equal(requests[2].method, "GET");
  assert.equal(restored.pending, false);
  const body = JSON.parse(requests[0].body);
  assert.equal(body.entry_route, "obsidian");
  assert.equal(body.source, "web_import_page");
  assert.equal(body.user_instruction, "保留公式");
});
test("GET failures never create a new request; explicit retry isolates failed/degraded URLs and retains prior evidence", async () => {
  const requests = [];
  let count = 0;
  const fetchImpl = async (url, options) => {
    requests.push({ url, ...options }); count += 1;
    if (count === 1) return response(snapshot([a, b], [{ requested_url: a, status: "queued" }, { requested_url: b, status: "queued" }], false), 202);
    if (count === 2) return response({ error: "temporarily_offline" }, 503);
    if (count === 3) return response(snapshot([a, b], [success(a), { requested_url: b, status: "requires_browser_auth", error: "login_required" }]));
    return response(snapshot([b], [success(b)], true, "request-2"), 202);
  };
  const session = new ImportSession({ storage: storage(), fetchImpl });
  session.setDraft(`${a}\n${b}`, ""); session.start();
  await session.step(); await session.step();
  assert.equal(session.pending, true);
  await session.step();
  const old = session.current.id;
  session.retryFailed();
  assert.notEqual(session.current.id, old);
  assert.deepEqual(session.current.urls, [b]);
  assert.equal(session.state.attempts[0].snapshot.results[1].error, "login_required");
  await session.step();
  assert.equal(requests.filter(item => item.method === "POST").length, 2);
  assert.equal(session.latestResults().filter(item => resultView(item).kind === "success").length, 2);
});
test("202, missing artifacts, warning replays, auth and render failures keep distinct meanings", () => {
  assert.equal(resultView({ status: "queued" }).kind, "pending");
  assert.equal(resultView({ status: "imported" }).kind, "unconfirmed");
  assert.equal(resultView({ ...success(a, true), status: "idempotent_replay" }).kind, "warning");
  assert.equal(resultView(success(a)).kind, "success");
  assert.equal(resultView({ ...success(a), receipt: { ...success(a).receipt, preprocess_status: "quarantined" } }).kind, "unconfirmed");
  for (const status of ["requires_browser_auth", "requires_js_render", "failed"]) assert.equal(resultView({ status }).retryable, true);
});
test("malformed receipt cannot silently lose URLs or claim completion", async () => {
  const session = new ImportSession({ storage: storage(), fetchImpl: async () => response(snapshot([a, b], [success(a)])) });
  session.setDraft(`${a}\n${b}`, ""); session.start(); await session.step();
  assert.equal(session.pending, true);
  assert.match(session.current.error, /回执/u);
  assert.equal(session.current.requestId, "request-1");
});
test("a terminal batch containing queued results remains unconfirmed and queryable", async () => {
  const session = new ImportSession({ storage: storage(), fetchImpl: async () => response(snapshot([a], [{ requested_url: a, status: "queued" }])) });
  session.setDraft(a, ""); session.start(); await session.step();
  assert.equal(session.pending, true);
  assert.match(session.current.error, /回执/u);
});
test("real page controls render safe text, disable >50, show quality warning and retry results", async () => {
  const html = await fs.readFile(new URL("./browser-import-web/index.html", import.meta.url), "utf8");
  const dom = new JSDOM(html, { url: "http://127.0.0.1/import" });
  const fetchImpl = async url => url.endsWith("health") ? response({ status: "ok", service: "local-ir-browser-highlight" }) : response(snapshot([a, b], [success(a, true), { requested_url: b, status: "failed", error: "<img src=x onerror=alert(1)>" }]));
  const mounted = mountImportPage(dom.window.document, { fetchImpl, storage: storage() });
  const doc = dom.window.document;
  const input = doc.getElementById("input");
  input.value = Array.from({ length: 51 }, (_, i) => `${a}/${i}`).join("\n"); input.dispatchEvent(new dom.window.Event("input"));
  assert.equal(doc.getElementById("start").disabled, true);
  input.value = `[a](${a}) [b](${b})`; input.dispatchEvent(new dom.window.Event("input")); doc.getElementById("start").click();
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.match(doc.getElementById("summary").textContent, /质量警告 1 · 失败 1/u);
  assert.equal(doc.querySelectorAll("#results img").length, 0);
  assert.match(doc.getElementById("results").textContent, /<img src=x/u);
  assert.equal(doc.getElementById("retry-all").hidden, false);
  mounted.stop(); dom.window.close();
});

test("health text distinguishes broken service configuration from a stopped sync heartbeat", async () => {
  const html = await fs.readFile(new URL("./browser-import-web/index.html", import.meta.url), "utf8");
  for (const [auth, expected] of [
    [{ mode: "manual_snapshot", error: "snapshot_file_not_found" }, /修复服务启动配置/u],
    [{ mode: "chrome_live_sync", status: "stale" }, /使用这些登录态的来源/u]
  ]) {
    const dom = new JSDOM(html, { url: "http://127.0.0.1/import" });
    const mounted = mountImportPage(dom.window.document, { storage: storage(), fetchImpl: async url =>
      response(url.endsWith("health") ? { status: "ok", service: "local-ir-browser-highlight", cookieSnapshot: auth } : { rules: [] }) });
    try {
      await new Promise(resolve => setTimeout(resolve, 30));
      assert.match(dom.window.document.getElementById("health").textContent, expected);
    } finally { mounted.stop(); dom.window.close(); }
  }
});

test("explicit false survives submission; missing classification resumes the original request after a lost response", async () => {
  const saved = storage();
  const calls = [];
  let loseResume = true;
  const fetchImpl = async (url, options) => {
    calls.push({ url, ...options });
    if (url.endsWith("/classification") && loseResume) { loseResume = false; throw new Error("lost_response"); }
    if (url.endsWith("/classification")) return response(snapshot([a], [{ requested_url: a, status: "queued" }], false));
    if (options.method === "GET") return response(snapshot([a], [success(a)]));
    return response({ ...snapshot([a], [{ requested_url: a, status: "needs_classification", receipt: { missing_labels: ["content_profile"] } }]), status: "needs_classification", awaiting_input: true });
  };
  const session = new ImportSession({ storage: saved, fetchImpl });
  session.setDraft(a, "", { translate: false, spoken_to_written: false }); session.start(); await session.step();
  assert.equal(session.awaitingInput, true);
  assert.equal(session.pending, false);
  assert.match(resultView(session.latestResults()[0]).detail, /材料类型/u);
  assert.throws(() => session.start(), /补充/u);
  session.setDraft(a, "", { translate: false, spoken_to_written: false, content_profile: "literature" });
  session.resumeClassification(a); await session.step();
  const restored = new ImportSession({ storage: saved, fetchImpl });
  await restored.step(); await restored.step();
  assert.equal(calls.filter(call => call.url === "/api/browser-import/requests").length, 1);
  assert.equal(calls[1].body, calls[2].body);
  assert.equal(JSON.parse(calls[0].body).processing_options.translate, false);
  assert.equal(restored.state.attempts.length, 1);
  assert.equal(restored.awaitingInput, false);
  assert.equal(restored.pending, false);
});

test("page classification controls forward booleans and render waiting as incomplete", async () => {
  const dom = new JSDOM(await fs.readFile(new URL("./browser-import-web/index.html", import.meta.url), "utf8"), { url: "http://127.0.0.1/import" });
  let body;
  const mounted = mountImportPage(dom.window.document, { storage: storage(), fetchImpl: async (url, options) => {
    if (!options?.body) return response(url.endsWith("health") ? { status: "ok", service: "local-ir-browser-highlight" } : { schema: "local-ir.import-rules/v1", rules: [] });
    body = JSON.parse(options.body);
    return response({ ...snapshot([a], [{ requested_url: a, status: "needs_classification", receipt: { missing_labels: ["source_language"] } }]), awaiting_input: true, status: "needs_classification" });
  } });
  try {
    const doc = dom.window.document;
    const set = (id, value, event) => { const el = doc.getElementById(id); el.value = value; el.dispatchEvent(new dom.window.Event(event)); };
    set("input", a, "input");
    set("processing-content_profile", "literature", "change");
    set("processing-include_reading_guide", "false", "change");
    doc.getElementById("start").click(); await new Promise(resolve => setTimeout(resolve, 30));
    assert.deepEqual(body.processing_options, { content_profile: "literature", include_reading_guide: false });
    assert.match(doc.getElementById("summary").textContent, /等待补充分类/u);
    assert.doesNotMatch(doc.getElementById("summary").textContent, /本批次已结束/u);
    assert.match(doc.getElementById("results").textContent, /使用当前分类与处理选择继续/u);
  } finally { mounted.stop(); dom.window.close(); }
});
