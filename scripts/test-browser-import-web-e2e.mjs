import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { JSDOM } from "jsdom";
import { startFixture } from "./browser-import-web/fixture.mjs";
import { mountImportPage } from "./browser-import-web/app.mjs";
import { resultView } from "./browser-import-web/client.mjs";

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate) {
  const deadline = Date.now() + 90000;
  while (Date.now() < deadline) { if (predicate()) return; await delay(100); }
  throw new Error("fixture_timeout");
}
const sha256 = text => createHash("sha256").update(text).digest("hex");
async function verifyFile(item, fixture) {
  const view = resultView(item);
  assert.ok(["success", "warning"].includes(view.kind), JSON.stringify(item));
  assert.ok(path.resolve(view.path).startsWith(`${path.resolve(fixture.workflowRoot)}${path.sep}`));
  assert.equal(path.basename(path.dirname(view.path)), "127.0.0.1");
  const content = await fs.readFile(view.path, "utf8");
  assert.ok(content.length > 300);
  assert.match(content, /仅用于网页导入验收的合成材料/u);
  assert.equal(sha256(content), view.hash);
  assert.equal(item.receipt.browser_tab_created, false);
  return { path: view.path, sha256: view.hash, bytes: Buffer.byteLength(content), quality: view.kind };
}

for (const producer of ["synthetic", "synthetic-invalid"]) {
  const fixture = await startFixture({ producer });
  let mounted; let dom;
  const evidence = { producer, root: fixture.root, source: "local_synthetic_only", externalAI: false, productionMaterials: false, checks: [], files: [] };
  console.log(`fixture_started: ${producer} ${fixture.root}`);
  try {
    const health = await (await fetch(`${fixture.baseUrl}/api/highlights/health`)).json();
    assert.equal(health.cookieSnapshot.configured, false);
    assert.equal(health.standardImport.defaultTransport, "background_fetch");
    const page = await fetch(`${fixture.baseUrl}/import`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get("Content-Security-Policy"), /script-src 'self'/u);
    const html = await page.text();
    for (const route of ["/import/app.mjs", "/import/client.mjs", "/url-import-input.mjs"]) {
      const asset = await fetch(`${fixture.baseUrl}${route}`);
      assert.equal(asset.status, 200); assert.match(asset.headers.get("Content-Type"), /text\/javascript/u);
    }
    assert.match(await (await fetch(`${fixture.baseUrl}/`)).text(), /导入管理/u);
    const oversize = await fetch(`${fixture.baseUrl}/api/browser-import/requests`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ urls: Array.from({ length: 51 }, (_, i) => `${fixture.sourceUrl}/article/${i}`) }) });
    assert.equal(oversize.status, 400);
    evidence.checks.push("page_assets_and_legacy_root", "backend_50_limit");

    const observed = [];
    let losePostResponse = true;
    const fetchImpl = async (route, options) => {
      const response = await fetch(`${fixture.baseUrl}${route}`, options);
      if (options?.method === "POST") {
        observed.push(JSON.parse(options.body));
        if (losePostResponse) { losePostResponse = false; await response.text(); throw new Error("synthetic_response_lost_after_acceptance"); }
      }
      return response;
    };
    dom = new JSDOM(html, { url: `${fixture.baseUrl}/import` });
    mounted = mountImportPage(dom.window.document, { fetchImpl, pollMs: 100 });
    const doc = dom.window.document;
    const input = doc.getElementById("input");
    const article = `${fixture.sourceUrl}/article`;
    input.value = producer === "synthetic"
      ? `[材料](${article})[重复](${article}#section)\n${fixture.sourceUrl}/flaky\n${fixture.sourceUrl}/auth\n${fixture.sourceUrl}/js`
      : `[质量警告材料](${article})`;
    input.dispatchEvent(new dom.window.Event("input"));
    doc.getElementById("start").click();
    await until(() => !mounted.session.busy && Boolean(mounted.session.current?.error));
    assert.equal(mounted.session.pending, true);
    const idBefore = mounted.session.current.id;
    doc.getElementById("resume").click();
    await until(() => !mounted.session.pending && !mounted.session.busy);
    assert.equal(mounted.session.current.error, "");
    assert.equal(observed[0].client_request_id, observed[1].client_request_id);
    assert.equal(mounted.session.current.id, idBefore);
    const brokerPath = path.join(fixture.workflowRoot, ".local-ir/browser-import-broker/state.json");
    let broker = JSON.parse(await fs.readFile(brokerPath, "utf8"));
    assert.equal(broker.requests.length, 1, "lost 202 response must not duplicate broker requests");
    assert.equal(observed[0].entry_route, "obsidian");
    evidence.checks.push("page_POST_GET_shared_interface", "uncertain_POST_same_id_one_broker_request");
    console.log(`initial_batch_complete: ${producer}`);

    const results = mounted.session.latestResults();
    const main = results.find(item => item.requested_url === article);
    if (producer === "synthetic-invalid") {
      assert.equal(resultView(main).kind, "failed");
      assert.match(main.error, /未生成所要求的导读/u);
      assert.equal((await fs.readdir(path.join(fixture.workflowRoot,"阅读区"), {recursive:true})).filter(name=>name.endsWith(".md")).length,0);
      evidence.checks.push("missing_required_guide_visible_without_publication");
      evidence.status = "passed";
      await fs.writeFile(path.join(fixture.root,"evidence.json"),JSON.stringify(evidence,null,2));
      console.log(JSON.stringify(evidence));
      continue;
    }
    evidence.files.push(await verifyFile(main, fixture));
    if (producer === "synthetic") {
      assert.equal(resultView(main).kind, "success");
      assert.equal(results.find(item => item.requested_url.endsWith("/flaky")).status, "failed");
      assert.equal(results.find(item => item.requested_url.endsWith("/auth")).status, "requires_browser_auth");
      assert.equal(results.find(item => item.requested_url.endsWith("/js")).status, "requires_js_render");
      assert.equal(doc.querySelectorAll("#results .success").length, 1);
      assert.equal(doc.querySelectorAll("#results .failed").length, 3);
      evidence.checks.push("success_auth_js_and_failure_visible");
      const originalHash = evidence.files[0].sha256;
      const beforeRetryId = mounted.session.current.id;
      fixture.recover();
      const failedRow = [...doc.querySelectorAll("#results li")].find(item => item.textContent.includes("/flaky"));
      failedRow.querySelector("button").click();
      await until(() => !mounted.session.pending && !mounted.session.busy);
      assert.notEqual(mounted.session.current.id, beforeRetryId);
      assert.deepEqual(observed.at(-1).urls, [`${fixture.sourceUrl}/flaky`]);
      assert.equal(mounted.session.state.attempts[0].snapshot.results.find(item => item.requested_url.endsWith("/flaky")).status, "failed");
      assert.equal(sha256(await fs.readFile(evidence.files[0].path)), originalHash);
      evidence.files.push(await verifyFile(mounted.session.latestResults().find(item => item.requested_url.endsWith("/flaky")), fixture));
      evidence.checks.push("explicit_retry_only_failed_item", "previous_failure_retained", "successful_article_unchanged");
    } else {
      assert.equal(resultView(main).kind, "warning");
      assert.match(doc.getElementById("results").textContent, /质量警告/u);
      evidence.checks.push("warning_visible_and_formally_written");
    }

    // A different entry still resolves to the same formal article and does not rewrite it.
    const filesBefore = (await fs.readdir(path.dirname(evidence.files[0].path))).filter(name => name.endsWith(".md"));
    const replayPost = await fetch(`${fixture.baseUrl}/api/browser-import/requests`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ urls: [article], source: "browser_extension_entry", entry_route: "browser_extension", client_request_id: "cross-entry-fixture" }) });
    const replayId = (await replayPost.json()).request_id;
    let replay;
    const deadline = Date.now() + 60000;
    do { replay = await (await fetch(`${fixture.baseUrl}/api/browser-import/requests/${replayId}`)).json(); if (replay.terminal) break; await delay(100); } while (Date.now() < deadline);
    assert.equal(replay.results[0].status, "idempotent_replay", JSON.stringify(replay));
    assert.equal(replay.results[0].artifacts.find(item => item.kind === "markdown").path, evidence.files[0].path);
    assert.equal(sha256(await fs.readFile(evidence.files[0].path)), evidence.files[0].sha256);
    assert.deepEqual((await fs.readdir(path.dirname(evidence.files[0].path))).filter(name => name.endsWith(".md")), filesBefore);
    assert.equal((await fs.readdir(path.join(fixture.workflowRoot, "阅读区/浏览器高亮")).catch(() => [])).filter(name => name.endsWith(".md")).length, 0);
    evidence.checks.push("cross_entry_global_dedupe", "file_hash_readback_and_domain_routing");
    if (producer === "synthetic") {
      const sidecar = main.artifacts.find(item => item.kind === "browser_ir_metadata").path;
      const originalState = await fs.readFile(sidecar);
      const edited = (await fs.readFile(evidence.files[0].path, "utf8")) + "\n用户人工备注：保留这段文字和既有标注。\n";
      await fs.writeFile(evidence.files[0].path, edited);
      const changed = await fetch(`${fixture.baseUrl}/api/browser-import/requests`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ urls: [article], source: "web_import_page", entry_route: "obsidian", client_request_id: "preserve-edited-fixture" }) });
      const changedId = (await changed.json()).request_id;
      let checked;
      const checkedDeadline = Date.now() + 60000;
      do { checked = await (await fetch(`${fixture.baseUrl}/api/browser-import/requests/${changedId}`)).json(); if (checked.terminal) break; await delay(100); } while (Date.now() < checkedDeadline);
      assert.equal(checked.results[0].status, "idempotent_replay");
      assert.equal(checked.results[0].receipt.existing_article_preserved, true);
      assert.equal(checked.results[0].artifacts.find(item=>item.kind==='markdown').sha256,sha256(edited));
      assert.equal(await fs.readFile(evidence.files[0].path, "utf8"), edited);
      assert.deepEqual(await fs.readFile(sidecar), originalState);
      evidence.checks.push("manually_edited_body_and_sidecar_preserved");
      evidence.editedFixture = { path: evidence.files[0].path, sha256: sha256(edited), note: "Explicit synthetic manual-edit test after initial publication readback" };
    }
    evidence.status = "passed";
  } catch (error) {
    evidence.status = "failed"; evidence.error = error.stack;
    throw error;
  } finally {
    mounted?.stop(); dom?.window.close();
    await fs.writeFile(path.join(fixture.root, "acceptance.json"), JSON.stringify(evidence, null, 2));
    await fixture.stop();
    console.log(`${evidence.status}: ${fixture.root}/acceptance.json`);
  }
}
