import fs from "node:fs/promises";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { PROCESSOR_VERSION } from '../standard-preprocessing/lib/core.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const workflowRoot = path.resolve(__dirname, "..");
const appScript = path.join(__dirname, "progressive-reading-app.mjs");
const port = Number(process.env.BROWSER_HIGHLIGHT_TEST_PORT || 39229);
const baseUrl = `http://127.0.0.1:${port}`;
const useLivePreprocess = process.env.BROWSER_HIGHLIGHT_TEST_LIVE_PREPROCESS === "1";

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, options);
  const text = await response.text();
  const data = text ? JSON.parse(text) : {};
  if (!response.ok) {
    const error = new Error(data.error || `http_${response.status}`);
    error.status = response.status;
    throw error;
  }
  return data;
}

async function requestRaw(url, options = {}) {
  return fetch(url, options);
}

async function waitForHealth() {
  let lastError = null;
  for (let i = 0; i < 50; i += 1) {
    try {
      return await requestJson(`${baseUrl}/api/highlights/health`);
    } catch (error) {
      lastError = error;
      await delay(250);
    }
  }
  throw lastError || new Error("server_not_ready");
}

async function run() {
  const artifactsRoot = 'D:/Artifacts/ProgressiveReading/browser-workflow-tests';
  await fs.mkdir(artifactsRoot, {recursive:true});
  const testWorkspaceRoot = await fs.mkdtemp(path.join(artifactsRoot, "fixture-"));
  const testWorkflowRoot = path.join(testWorkspaceRoot, "04 Projects", "渐进阅读工作流");
  await fs.mkdir(testWorkflowRoot, { recursive: true });
  await fs.mkdir(path.join(testWorkflowRoot, "config"), { recursive: true });
  await fs.copyFile(
    path.join(workflowRoot, "config", "import-destination-routes.json"),
    path.join(testWorkflowRoot, "config", "import-destination-routes.json")
  );
  const legacyCompletedRoot = path.join(testWorkflowRoot, "待归档原文");
  const legacyStateRoot = path.join(testWorkflowRoot, ".local-ir", "browser-document-state");
  const legacyCompletedName = "Legacy Complete--浏览器完成阅读--1234567890.md";
  const canonicalCompletedName = "Legacy Complete--浏览器加工--1234567890.md";
  const legacyCompletedMarkdown = path.join(legacyCompletedRoot, legacyCompletedName);
  const legacyCompletedSidecar = path.join(legacyStateRoot, `${legacyCompletedName}.browser-ir.json`);
  await fs.mkdir(legacyCompletedRoot, { recursive: true });
  await fs.mkdir(legacyStateRoot, { recursive: true });
  await fs.writeFile(legacyCompletedMarkdown, "---\nstatus: done\n---\n\n# Legacy Complete\n\nLegacy body.\n", "utf8");
  await fs.writeFile(legacyCompletedSidecar, `${JSON.stringify({
    schema: "local-ir.document-state",
    schemaVersion: 1,
    document: {
      id: "legacy-completed-document",
      path: `04 Projects/渐进阅读工作流/待归档原文/${legacyCompletedName}`,
      title: "Legacy Complete",
      sourceUrl: "https://local.test/legacy-complete",
      sourceType: "browser_page",
      status: "done",
      revision: 1,
      createdAt: "2026-08-16T00:00:00.000Z",
      updatedAt: "2026-08-16T00:00:01.000Z",
      handoff: { direction: "browser_to_obsidian", state: "ready", owner: "obsidian", committedAt: "2026-08-16T00:00:01.000Z" }
    },
    content: { markdownSha256: "legacy", rawMarkdownSha256: "legacy", conversionMethod: "readability_html" },
    annotations: [{ id: "legacy-annotation", path: `04 Projects/渐进阅读工作流/待归档原文/${legacyCompletedName}`, selectedText: "Legacy body." }],
    articleMusing: null,
    qaCards: [],
    browser: { destination: "completed", userInstruction: "", sourceMetadata: {}, completionIntent: "pending_archive" }
  }, null, 2)}\n`, "utf8");
  const child = spawn(process.execPath, [appScript], {
    cwd: workflowRoot,
    env: {
      ...process.env,
      PROGRESSIVE_READING_WORKFLOW_ROOT: testWorkflowRoot,
      PROGRESSIVE_READING_APP_PORT: String(port),
      PROGRESSIVE_READING_WRITE_SERVER_INFO: "false",
      NODE_ENV: useLivePreprocess ? "production" : "test",
      PROGRESSIVE_READING_BROWSER_PREPROCESS_TEST_PRODUCER: useLivePreprocess ? "" : "synthetic"
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true
  });

  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
  child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });

  const createdTargets = new Set();
  try {
    const health = await waitForHealth();
    if (health.status !== "ok") throw new Error("health_not_ok");
    if (!health.browserStateRoot.includes(`${path.sep}.local-ir${path.sep}browser-document-state`)) throw new Error("browser_state_root_not_internal");
    if (health.browserStateRoot.startsWith(health.browserHighlightRoot)) throw new Error("browser_state_root_inside_reading_folder");
    if (!health.browserCompletedHighlightRoot.includes(`${path.sep}待归档原文${path.sep}浏览器高亮`)) throw new Error("completed_highlight_root_not_nested");
    if (!health.browserPreprocessRoot.includes(`${path.sep}.local-ir${path.sep}browser-standard-preprocess`)) throw new Error("browser_preprocess_root_not_internal");
    if (health.standardImport?.urlBatchEndpoint !== "/api/highlights/import-local-urls"
      || health.standardImport?.sharedRequestEndpoint !== "/api/browser-import/requests"
      || health.standardImport?.defaultTransport !== "background_fetch"
      || health.standardImport?.browserTabCreatedOnNormalPath !== false) {
      throw new Error("shared_background_standard_import_health_capability_missing");
    }
    if (health.standardImport?.maxWorkflowAttempts !== 1 || health.standardImport?.processorVersion !== PROCESSOR_VERSION) throw new Error("standard_import_retry_health_capability_missing");
    if (health.standardImport?.transportMaxAttempts !== 3 || health.standardImport?.serializedBySourceUrl !== true) throw new Error("standard_import_transport_reliability_missing");
    if (health.standardImport?.batchConcurrency !== 4 || health.standardImport?.readableWarningCreatesMarkdown !== true) throw new Error("standard_import_quality_or_concurrency_capability_missing");
    if (health.browserImportBroker?.createRequestEndpoint !== "/api/browser-import/requests" || health.browserImportBroker?.claimTaskEndpoint !== "/api/browser-import/tasks/claim") throw new Error("browser_import_broker_health_capability_missing");
    if (health.browserImportBroker?.maxTaskAttempts !== 3 || health.browserImportBroker?.claimLeaseMs < 10 * 60 * 1000 || health.browserImportBroker?.idempotentRequestCreation !== true || health.browserImportBroker?.idempotentTaskClaim !== true) throw new Error("browser_import_broker_reliability_missing");
    const canonicalCompletedMarkdown = path.join(health.browserCompletedHighlightRoot, canonicalCompletedName);
    const canonicalCompletedSidecar = path.join(legacyStateRoot, `${canonicalCompletedName}.browser-ir.json`);
    if (!(await fs.stat(canonicalCompletedMarkdown).catch(() => null))) throw new Error("legacy_complete_markdown_not_migrated");
    if (!(await fs.stat(canonicalCompletedSidecar).catch(() => null))) throw new Error("legacy_complete_sidecar_not_migrated");
    if (await fs.stat(legacyCompletedMarkdown).catch(() => null)) throw new Error("legacy_complete_markdown_left_in_root");
    if (await fs.stat(legacyCompletedSidecar).catch(() => null)) throw new Error("legacy_complete_sidecar_left_behind");
    const migratedCompletedState = JSON.parse(await fs.readFile(canonicalCompletedSidecar, "utf8"));
    if (!migratedCompletedState.document.path.includes("待归档原文/浏览器高亮/")) throw new Error("legacy_complete_document_path_not_migrated");
    if (migratedCompletedState.annotations.length !== 1 || migratedCompletedState.annotations[0].path !== migratedCompletedState.document.path) throw new Error("legacy_complete_annotations_not_preserved");

    const testPageResponse = await requestRaw(`${baseUrl}/browser-highlight-test`);
    if (testPageResponse.status !== 200) throw new Error("browser_highlight_test_page_not_available");
    const testPageHtml = await testPageResponse.text();
    if (!testPageHtml.includes("Local IR 浏览器高亮测试页")) throw new Error("browser_highlight_test_page_content_missing");

    const optionsResponse = await requestRaw(`${baseUrl}/api/highlights/capture`, { method: "OPTIONS" });
    if (optionsResponse.status !== 204) throw new Error("options_preflight_not_supported");
    if (optionsResponse.headers.get("access-control-allow-origin") !== "*") {
      throw new Error("cors_allow_origin_missing");
    }

    const testUrl = "https://local.test/browser-highlight-workflow";
    const testHtml = `<!doctype html>
<html>
<head><title>Browser Highlight Workflow Test A</title></head>
<body>
  <main>
    <article>
      <h1>Browser Highlight Workflow Test A</h1>
      <p>This paragraph belongs to the full article body. First synthetic browser highlight. It should remain readable after conversion.</p>
      <p>A later paragraph contains Second synthetic browser highlight. This sentence verifies that the second capture updates the same Markdown file.</p>
      <p>The page also includes enough surrounding prose for Readability to treat it as an article instead of a tiny fragment.</p>
    </article>
  </main>
</body>
</html>`;
    const testPageText = [
      "Browser Highlight Workflow Test A",
      "This paragraph belongs to the full article body. First synthetic browser highlight. It should remain readable after conversion.",
      "A later paragraph contains Second synthetic browser highlight. This sentence verifies that the second capture updates the same Markdown file.",
      "The page also includes enough surrounding prose for Readability to treat it as an article instead of a tiny fragment."
    ].join("\n\n");
    const first = await requestJson(`${baseUrl}/api/highlights/capture`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url: testUrl,
        title: "Browser Highlight Workflow Test A",
        selectionText: "First synthetic browser highlight.",
        context: "Before. First synthetic browser highlight. After.",
        pageText: testPageText,
        html: testHtml,
        createdAt: "2026-07-08T00:00:01.000Z",
        sourceId: "synthetic-a"
      })
    });
    createdTargets.add(first.target);

    const second = await requestJson(`${baseUrl}/api/highlights/capture`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url: testUrl,
        title: "Browser Highlight Workflow Test B",
        selectionText: "Second synthetic browser highlight.",
        context: "Before. Second synthetic browser highlight. After.",
        pageText: testPageText,
        html: testHtml,
        createdAt: "2026-07-08T00:00:02.000Z",
        sourceId: "synthetic-b"
      })
    });
    createdTargets.add(second.target);

    if (first.target !== second.target) throw new Error("same_url_did_not_append_to_same_file");
    const content = await fs.readFile(first.target, "utf8");
    for (const expected of [
      "import_method: browser_page_highlight",
      "highlight_mode: full_page",
      "This paragraph belongs to the full article body.",
      "==First synthetic browser highlight.==",
      "==Second synthetic browser highlight.=="
    ]) {
      if (!content.includes(expected)) throw new Error(`missing_expected_content:${expected}`);
    }

    const unlocated = await requestJson(`${baseUrl}/api/highlights/capture`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url: "https://local.test/browser-highlight-unlocated",
        title: "Browser Highlight Unlocated Test",
        selectionText: "This selected text cannot be found in the converted Markdown.",
        context: "A context block that is also absent from the converted Markdown.",
        pageText: "The converted page body exists, but it does not contain the missing selected phrase.",
        html: "<!doctype html><html><body><main><article><h1>Browser Highlight Unlocated Test</h1><p>The converted page body exists, but it does not contain the missing selected phrase.</p><p>Additional text keeps the fallback readable.</p></article></main></body></html>",
        createdAt: "2026-07-08T00:00:03.000Z",
        sourceId: "synthetic-unlocated"
      })
    });
    createdTargets.add(unlocated.target);
    const unlocatedContent = await fs.readFile(unlocated.target, "utf8");
    for (const expected of [
      "import_method: browser_page_highlight",
      "## 未定位高亮",
      "==This selected text cannot be found in the converted Markdown.=="
    ]) {
      if (!unlocatedContent.includes(expected)) throw new Error(`missing_unlocated_content:${expected}`);
    }

    const draftPayload = {
      id: "synthetic-browser-draft",
      url: "https://local.test/browser-draft-commit",
      title: "Browser Draft Commit Test",
      sourceType: "browser_page",
      sourceMetadata: { source_url: "https://local.test/browser-draft-commit", capture_id: "synthetic-draft" },
      userInstruction: "保留技术术语",
      pageText: "Browser Draft Commit Test\n\nThis body stays unchanged while virtual highlight metadata remains separate.",
      html: "<!doctype html><html><body><main><article><h1>Browser Draft Commit Test</h1><p>This body stays unchanged while virtual highlight metadata remains separate.</p><p>Additional prose keeps the article conversion stable for the synthetic test.</p></article></main></body></html>",
      annotations: [{
        id: "annotation-a",
        selectedText: "virtual highlight metadata",
        currentText: "virtual highlight metadata",
        type: "comment",
        commentMarkdown: "本地批注",
        rewriteMarkdown: "",
        markKind: "highlight",
        ranges: [{ start: 57, end: 83 }],
        createdAt: "2026-08-15T00:00:01.000Z",
        updatedAt: "2026-08-15T00:00:01.000Z"
      }],
      articleMusing: { id: "musing-a", bodyMarkdown: "合成随想" },
      qaCards: [{ id: "qa-a", questionMarkdown: "What stays separate?", answerMarkdown: "Metadata." }],
      revision: 3,
      createdAt: "2026-08-15T00:00:00.000Z",
      updatedAt: "2026-08-15T00:00:02.000Z"
    };
    const committed = await requestJson(`${baseUrl}/api/highlights/commit`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ draft: draftPayload })
    });
    if (committed.status !== "saved_locked") throw new Error("draft_commit_not_locked");
    for (const artifact of committed.artifacts || []) createdTargets.add(artifact.path);
    const markdownArtifact = committed.artifacts.find((artifact) => artifact.kind === "markdown");
    const metadataArtifact = committed.artifacts.find((artifact) => artifact.kind === "browser_ir_metadata");
    if (!markdownArtifact || !metadataArtifact) throw new Error("draft_commit_artifacts_missing");
    const committedMarkdown = await fs.readFile(markdownArtifact.path, "utf8");
    if (!committedMarkdown.includes('highlight_mode: "virtual_metadata"')) throw new Error("draft_commit_missing_virtual_mode");
    if (!committedMarkdown.includes('browser_state_schema: "local-ir.document-state/v1"')) throw new Error("draft_commit_missing_state_schema");
    if (committedMarkdown.includes("browser_metadata_file:")) throw new Error("draft_commit_exposes_internal_json_path");
    if (committedMarkdown.includes("==virtual highlight metadata==")) throw new Error("draft_commit_embedded_virtual_highlight");
    if (!metadataArtifact.path.includes(`${path.sep}.local-ir${path.sep}browser-document-state${path.sep}`)) throw new Error("draft_commit_metadata_not_internal");
    if (metadataArtifact.path.startsWith(path.dirname(markdownArtifact.path))) throw new Error("draft_commit_metadata_in_reading_folder");
    const readingEntries = await fs.readdir(path.dirname(markdownArtifact.path));
    if (readingEntries.some((name) => name.endsWith(".browser-ir.json"))) throw new Error("reading_folder_contains_browser_state_json");
    const committedMetadata = JSON.parse(await fs.readFile(metadataArtifact.path, "utf8"));
    if (committedMetadata.schema !== "local-ir.document-state" || committedMetadata.schemaVersion !== 1) throw new Error("draft_commit_wrong_document_state_schema");
    if (committedMetadata.annotations.length !== 1) throw new Error("draft_commit_missing_annotations");
    if (committedMetadata.browser.userInstruction !== "保留技术术语") throw new Error("draft_commit_missing_instruction");
    const expectedDocumentPath = path.relative(path.resolve(testWorkflowRoot, "..", ".."), markdownArtifact.path).replaceAll(path.sep, "/");
    if (committedMetadata.document.path !== expectedDocumentPath) throw new Error("draft_commit_wrong_document_path");
    if (committedMetadata.annotations[0].path !== committedMetadata.document.path) throw new Error("draft_commit_annotation_path_mismatch");
    const committedRange = committedMetadata.annotations[0].range;
    if (!committedRange || committedMarkdown.slice(committedRange.start, committedRange.end) !== committedMetadata.annotations[0].originalText) throw new Error("draft_commit_annotation_not_anchored_to_markdown");
    if (committedMetadata.articleMusing.path !== committedMetadata.document.path) throw new Error("draft_commit_musing_path_mismatch");
    if (committedMetadata.qaCards[0].path !== committedMetadata.document.path) throw new Error("draft_commit_card_path_mismatch");

    const standardDraft = {
      ...draftPayload,
      id: "synthetic-browser-standard-import",
      url: "https://local.test/browser-standard-import",
      title: "浏览器标准导入测试",
      sourceMetadata: { source_url: "https://local.test/browser-standard-import", capture_id: "synthetic-standard-import" },
      userInstruction: "保留技术术语并生成标准阅读前置卡",
      pageText: "浏览器标准导入测试\n\n标准接口负责语义加工，本地服务负责确定性写入。\n\n最终阅读区只保留 Markdown，审计 JSON 留在内部状态目录。",
      html: "<!doctype html><html><body><main><article><h1>浏览器标准导入测试</h1><p>标准接口负责语义加工，本地服务负责确定性写入。</p><p>最终阅读区只保留 Markdown，审计 JSON 留在内部状态目录。</p><p>这一段补足稳定的合成测试正文，确保浏览器提取器得到完整文章。</p></article></main></body></html>",
      annotations: [],
      articleMusing: null,
      qaCards: [],
      revision: 0
    };
    const standardImported = await requestJson(`${baseUrl}/api/highlights/import-local`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ draft: standardDraft })
    });
    if (standardImported.status !== "saved_locked") throw new Error("standard_import_not_locked");
    for (const artifact of standardImported.artifacts || []) createdTargets.add(artifact.path);
    const standardMarkdownArtifact = standardImported.artifacts.find((artifact) => artifact.kind === "markdown");
    const standardMetadataArtifact = standardImported.artifacts.find((artifact) => artifact.kind === "browser_ir_metadata");
    const standardAuditArtifact = standardImported.artifacts.find((artifact) => artifact.kind === "standard_preprocess_audit");
    if (!standardMarkdownArtifact || !standardMetadataArtifact || !standardAuditArtifact) throw new Error("standard_import_artifacts_missing");
    if (!standardMarkdownArtifact.path.includes(`${path.sep}阅读区${path.sep}浏览器高亮${path.sep}`)) throw new Error("standard_import_not_in_reading_area");
    const standardMarkdown = await fs.readFile(standardMarkdownArtifact.path, "utf8");
    for (const expected of [
      "import_method: \"browser_standard_preprocess\"",
      "highlight_mode: \"virtual_metadata\"",
      'processing_status: "ready"',
      "## 阅读前置卡",
      "## 核心洞察"
    ]) {
      if (!standardMarkdown.includes(expected)) throw new Error(`standard_import_missing_content:${expected}`);
    }
    for (const name of ["request.json", "result.json", "run-manifest.json", "reading.md"]) {
      if (!(await fs.stat(path.join(standardAuditArtifact.path, name)).catch(() => null))) throw new Error(`standard_import_audit_missing:${name}`);
    }
    const standardRequest = JSON.parse(await fs.readFile(path.join(standardAuditArtifact.path, "request.json"), "utf8"));
    if (standardRequest.source_metadata?.input_form !== "written") throw new Error("browser_standard_import_not_fixed_as_written_input");
    const standardMetadata = JSON.parse(await fs.readFile(standardMetadataArtifact.path, "utf8"));
    if (!standardMetadata.content.conversionMethod.startsWith("progressive_reading_preprocess/")) throw new Error("standard_import_wrong_conversion_method");
    if (!standardMetadata.browser.sourceMetadata.standard_preprocess?.material_id) throw new Error("standard_import_receipt_missing_from_state");
    const standardReadingEntries = await fs.readdir(path.dirname(standardMarkdownArtifact.path));
    if (standardReadingEntries.some((name) => name.endsWith(".json"))) throw new Error("standard_import_put_json_in_reading_folder");

    const duplicateRequest = {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ draft: standardDraft })
    };
    const duplicateImports = await Promise.all([
      requestJson(`${baseUrl}/api/highlights/import-local`, duplicateRequest),
      requestJson(`${baseUrl}/api/highlights/import-local`, duplicateRequest)
    ]);
    const duplicateTargets = duplicateImports.map((item) => item.artifacts.find((artifact) => artifact.kind === "markdown")?.path);
    if (!duplicateTargets.every((target) => target === standardMarkdownArtifact.path)) throw new Error("same_url_concurrent_import_not_idempotent");
    JSON.parse(await fs.readFile(standardMetadataArtifact.path, "utf8"));

    const crossEntryReplay = await requestJson(`${baseUrl}/api/highlights/import-local-urls`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: standardDraft.url,
        source: "obsidian_local_ir",
        entry_route: "obsidian",
        client_request_id: "cross-entry-ready-document-replay"
      })
    });
    const crossEntryResult = crossEntryReplay.results?.[0];
    const crossEntryMarkdown = crossEntryResult?.artifacts?.find((artifact) => artifact.kind === "markdown");
    if (crossEntryReplay.status !== "completed"
      || crossEntryResult?.status !== "idempotent_replay"
      || crossEntryMarkdown?.path !== standardMarkdownArtifact.path
      || crossEntryResult?.receipt?.browser_tab_created !== false) {
      throw new Error("cross_entry_ready_document_not_reused");
    }

    const batchUrlOne = `${baseUrl}/browser-highlight-test?batch=one`;
    const batchUrlTwo = `${baseUrl}/browser-highlight-test?batch=two`;
    const batchImported = await requestJson(`${baseUrl}/api/highlights/import-local-urls`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: `第一篇（${batchUrlOne}）。\n第二篇：[链接](${batchUrlTwo})。\n重复追踪链接：${batchUrlOne}&utm_source=duplicate`
      })
    });
    if (batchImported.status !== "completed" || batchImported.requested !== 2 || batchImported.imported !== 2 || batchImported.failed !== 0) {
      throw new Error(`batch_standard_import_summary_invalid:${JSON.stringify(batchImported)}`);
    }
    if (batchImported.concurrency !== 2) throw new Error("batch_standard_import_concurrency_not_applied");
    if (batchImported.transport !== "background_fetch") throw new Error("batch_standard_import_not_on_shared_background_transport");
    for (const item of batchImported.results) {
      if (item.status !== "imported") throw new Error(`batch_standard_import_failed:${item.error || "unknown"}`);
      const itemMarkdown = item.artifacts.find((artifact) => artifact.kind === "markdown");
      const itemAudit = item.artifacts.find((artifact) => artifact.kind === "standard_preprocess_audit");
      if (!itemMarkdown || !itemAudit) throw new Error("batch_standard_import_artifacts_missing");
      const expectedDomainFolder = new URL(item.requested_url).hostname;
      if (!itemMarkdown.path.includes(`${path.sep}阅读区${path.sep}${expectedDomainFolder}${path.sep}`)) {
        throw new Error("batch_standard_import_wrong_target");
      }
      for (const artifact of item.artifacts) createdTargets.add(artifact.path);
    }
    let invalidBatchRejected = false;
    try {
      await requestJson(`${baseUrl}/api/highlights/import-local-urls`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "ftp://local.test/not-supported" })
      });
    } catch (error) {
      invalidBatchRejected = error.status === 422 && /no_url_found/.test(error.message);
    }
    if (!invalidBatchRejected) throw new Error("batch_invalid_urls_not_rejected");

    const brokerRequest = await requestJson(`${baseUrl}/api/browser-import/requests`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        urls: [`${baseUrl}/browser-highlight-test?broker=one`, `${baseUrl}/browser-highlight-test?broker=two`],
        source: "integration_test",
        client_request_id: "integration-broker-request",
        transport: "browser_capture"
      })
    });
    if (brokerRequest.status !== "queued" || brokerRequest.transport !== "background_fetch" || brokerRequest.requested !== 2 || !brokerRequest.request_id) throw new Error("browser_import_broker_request_invalid");
    const brokerDuplicate = await requestJson(`${baseUrl}/api/browser-import/requests`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ urls: [`${baseUrl}/browser-highlight-test?broker=one`, `${baseUrl}/browser-highlight-test?broker=two`], source: "integration_test", client_request_id: "integration-broker-request" })
    });
    if (brokerDuplicate.request_id !== brokerRequest.request_id) throw new Error("browser_import_broker_request_not_idempotent");
    const retiredClaim = await requestJson(`${baseUrl}/api/browser-import/tasks/claim?worker_id=test-worker&wait_ms=0`);
    if (retiredClaim.task !== null || retiredClaim.status !== "extension_worker_retired" || retiredClaim.claim_enabled !== false) {
      throw new Error("browser_import_extension_worker_not_retired");
    }
    let brokerCompleted = null;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      brokerCompleted = await requestJson(`${baseUrl}/api/browser-import/requests/${encodeURIComponent(brokerRequest.request_id)}`);
      if (brokerCompleted.terminal) break;
      await delay(100);
    }
    if (!brokerCompleted.terminal || brokerCompleted.status !== "completed" || brokerCompleted.imported !== 2 || brokerCompleted.failed !== 0) {
      throw new Error("browser_import_broker_receipt_invalid");
    }

    const completed = await requestJson(`${baseUrl}/api/highlights/complete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ draft: draftPayload })
    });
    if (completed.status !== "completed_pending_archive") throw new Error("complete_status_invalid");
    for (const artifact of completed.artifacts || []) createdTargets.add(artifact.path);
    const completedMarkdownArtifact = completed.artifacts.find((artifact) => artifact.kind === "markdown");
    const completedMetadataArtifact = completed.artifacts.find((artifact) => artifact.kind === "browser_ir_metadata");
    if (!completedMarkdownArtifact || !completedMetadataArtifact) throw new Error("complete_artifacts_missing");
    if (!completedMarkdownArtifact.path.includes(`${path.sep}待归档原文${path.sep}浏览器高亮${path.sep}`)) throw new Error("complete_not_in_pending_archive_highlight_folder");
    if (completedMarkdownArtifact.path.includes(`${path.sep}阅读区${path.sep}`)) throw new Error("complete_wrote_reading_area");
    if (path.basename(completedMarkdownArtifact.path) !== path.basename(markdownArtifact.path)) throw new Error("complete_changed_save_filename_contract");
    if (!path.basename(completedMarkdownArtifact.path).includes("--浏览器加工--")) throw new Error("complete_changed_save_filename_label");
    const completedMarkdown = await fs.readFile(completedMarkdownArtifact.path, "utf8");
    if (!completedMarkdown.includes('import_method: "browser_standard_preprocess"')) throw new Error("complete_changed_import_method");
    if (!completedMarkdown.includes('status: "done"')) throw new Error("complete_missing_done_status");
    if (completedMarkdown.includes("browser_complete_reading") || completedMarkdown.includes("浏览器完成阅读")) throw new Error("complete_kept_parallel_save_contract");
    const stripFrontmatter = (value) => value.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "");
    if (stripFrontmatter(completedMarkdown) !== stripFrontmatter(committedMarkdown)) throw new Error("complete_changed_readable_markdown_body");
    const completedMetadata = JSON.parse(await fs.readFile(completedMetadataArtifact.path, "utf8"));
    if (completedMetadata.document.status !== "done") throw new Error("complete_document_state_not_done");
    if (completedMetadata.annotations.length !== committedMetadata.annotations.length) throw new Error("complete_lost_annotations");
    if (completedMetadata.articleMusing?.bodyMarkdown !== committedMetadata.articleMusing?.bodyMarkdown) throw new Error("complete_changed_article_musing");
    if (completedMetadata.qaCards[0]?.questionMarkdown !== committedMetadata.qaCards[0]?.questionMarkdown) throw new Error("complete_changed_qa_card");
    if (completedMetadata.annotations[0]?.commentMarkdown !== committedMetadata.annotations[0]?.commentMarkdown) throw new Error("complete_changed_annotation_comment");

    let invalidRejected = false;
    try {
      await requestJson(`${baseUrl}/api/highlights/capture`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: testUrl, title: "Invalid", selectionText: "" })
      });
    } catch (error) {
      invalidRejected = error.status === 422 && /empty_selection/.test(error.message);
    }
    if (!invalidRejected) throw new Error("empty_selection_was_not_rejected");

    console.log(JSON.stringify({
      status: "passed",
      health: health.status,
      preprocessProducer: useLivePreprocess ? "live" : "synthetic",
      target: first.target,
      checks: ["health", "completed_highlight_subfolder", "legacy_completed_artifact_migration", "test_page", "cors_preflight", "legacy_full_page_capture", "same_url_update", "legacy_inline_highlight", "unlocated_fallback", "draft_commit", "shared_document_state", "state_json_outside_reading_folder", "virtual_metadata_separation", "standard_import_endpoint", "standard_preprocess_contract", "browser_capture_fixed_written", "standard_import_to_reading", "standard_audit_outside_reading", "same_url_concurrent_serialization", "cross_entry_ready_document_reuse", "batch_url_extraction", "batch_url_deduplication", "shared_background_standard_import", "batch_invalid_url_rejection", "browser_import_broker_request", "browser_import_broker_request_idempotency", "extension_worker_retired_no_claim", "browser_import_broker_receipt", "complete_reuses_save_contract", "complete_to_pending_archive", "invalid_payload"]
    }, null, 2));
  } finally {
    for (const target of createdTargets) {
      await fs.rm(target, { force: true }).catch(() => {});
    }
    await fs.rm(testWorkspaceRoot, { recursive: true, force: true }).catch(() => {});
    child.kill();
    await delay(250);
    if (process.platform === "win32" && child.pid) {
      spawnSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true });
    } else if (child.exitCode === null) {
      child.kill("SIGKILL");
    }
    if (process.env.BROWSER_HIGHLIGHT_TEST_DEBUG) {
      console.error(stdout);
      console.error(stderr);
    }
  }
}

run().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
