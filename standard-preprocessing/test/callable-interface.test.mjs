import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  buildPreprocessRequest,
  getDoctorReport,
  isReadyResult,
  publishReadingArtifact,
  runPreprocessingRequest,
  sanitizePublishedMarkdown,
  spokenMarkdownOptions,
  validatePublishedMarkdownCleanliness,
  validateRequestContract
} from "../index.mjs";
import { SyntheticProducer } from "../test-support/synthetic-producer.mjs";
import { preprocessBrowserCapture } from "../integrations/browser-capture.mjs";
import { preprocessNetworkMarkdown } from "../integrations/network-import.mjs";
import { verifyChapterPublication } from "../../scripts/import-wiki-chapters.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const standardRoot = path.resolve(here, "..");
const projectRoot = path.resolve(standardRoot, "..");
const cliPath = path.join(standardRoot, "cli.mjs");
const monolingualFixture = path.join(standardRoot, "fixtures", "monolingual.request.json");

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

test("request builder publishes the standard spoken-material preset", async () => {
  const request = buildPreprocessRequest({
    markdown: "第一段口述。\n\n第二段口述。",
    sourceType: "synthetic_transcript",
    sourceMetadata: { source_url: "https://example.invalid/callable/spoken", source_is_original: true },
    userInstruction: "转成结构化书面文本。",
    processingOptions: spokenMarkdownOptions()
  });
  const validation = await validateRequestContract(request);
  assert.equal(validation.valid, true);
  assert.equal(request.processing_options.cleaning_mode, "lossless_spoken_to_written");
  assert.equal(request.processing_options.forbid_visible_timestamps, true);
  assert.equal(request.processing_options.require_content_headings, true);
});

test("network and browser adapters call the same validated interface", async () => {
  const sourceMetadata = {
    source_url: "https://example.invalid/callable/adapter",
    title: "适配器合成材料",
    source_is_original: true
  };
  const networkProducer = new SyntheticProducer();
  const network = await preprocessNetworkMarkdown({
    markdown: "# 标题\n\n网络导入工程只负责提供原始 Markdown，标准接口负责后续处理。",
    sourceType: "web_article_markdown",
    sourceMetadata,
    producer: networkProducer,
    cacheDir: false
  });
  assert.equal(isReadyResult(network.result), true);
  assert.equal(networkProducer.lastPayload.cleaning_policy.mode, "semantic_only");

  const browserProducer = new SyntheticProducer();
  const browser = await preprocessBrowserCapture({
    markdown: "# 标题\n\n浏览器采集只负责页面内容和来源元数据，标准接口负责后续处理。",
    sourceMetadata,
    producer: browserProducer,
    cacheDir: false
  });
  assert.equal(isReadyResult(browser.result), true);
  assert.equal(browserProducer.lastPayload.source_type, "browser_capture_markdown");
  assert.equal(browserProducer.lastPayload.cleaning_policy.mode, "semantic_only");
  assert.equal(browser.result.receipt.workflow_route.input_form.value, "written");
  assert.equal(browser.result.receipt.workflow_route.input_form.method, "source_metadata");
});

test("browser adapter leaves bounded retries to stages without rerunning the whole workflow", async () => {
  const invalid = new SyntheticProducer({ invalid: true });
  const valid = new SyntheticProducer();
  const producer = {
    calls: 0,
    async classifyWorkflow(...args) {
      return valid.classifyWorkflow(...args);
    },
    async generate(payload) {
      this.calls += 1;
      return this.calls <= 3 ? invalid.generate(payload) : valid.generate(payload);
    }
  };
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pr-browser-retry-"));
  const run = await preprocessBrowserCapture({
    markdown: "# 浏览器重试\n\n第一次完整处理可以失败，但同一标准合同应自动重新运行，并只把通过严格校验的结果交给阅读区。",
    sourceMetadata: {
      source_url: "https://example.invalid/browser-retry",
      title: "浏览器重试",
      source_is_original: true
    },
    producer,
    outputDir: path.join(root, "run"),
    cacheDir: path.join(root, "cache")
  });
  assert.equal(isReadyResult(run.result), false);
  assert.equal(producer.calls, 3);
  assert.deepEqual(run.workflow_attempts.map((attempt) => attempt.processing_state), ["degraded"]);
  assert.equal(run.result.receipt.reading_guide.status, "failed");
});

test("programmatic interface validates, writes committed artifacts, removes stale alternates, and replays idempotently", async () => {
  const request = await readJson(monolingualFixture);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pr-preprocess-interface-"));
  const outputOne = path.join(root, "run-one");
  const outputTwo = path.join(root, "run-two");
  const publishedMarkdown = path.join(root, "阅读区", "PDF", "合成材料.md");
  const cacheDir = path.join(root, "cache");
  await fs.mkdir(outputOne, { recursive: true });
  await fs.writeFile(path.join(outputOne, "quarantine.md"), "stale quarantine", "utf8");

  const first = await runPreprocessingRequest(request, {
    producer: new SyntheticProducer(),
    outputDir: outputOne,
    publishPath: publishedMarkdown,
    cacheDir,
    now: "2026-08-16T00:00:00.000Z"
  });
  assert.equal(first.result_validation.valid, true);
  assert.equal(isReadyResult(first.result), true);
  assert.equal(first.result.status, "completed");
  assert.equal(await fs.stat(path.join(outputOne, "result.json")).then(() => true), true);
  assert.equal(await fs.stat(path.join(outputOne, "reading.md")).then(() => true), true);
  assert.equal(await fs.stat(path.join(outputOne, "request.json")).then(() => true), true);
  assert.equal(await fs.stat(path.join(outputOne, "run-manifest.json")).then(() => true), true);
  await assert.rejects(fs.stat(path.join(outputOne, "quarantine.md")), { code: "ENOENT" });
  assert.match(await fs.readFile(path.join(outputOne, "reading.md"), "utf8"), /\[\[#\^pr-[a-f0-9]{12}\|正文跳转\]\]\n\n/u);
  assert.equal(await fs.readFile(publishedMarkdown, "utf8"), await fs.readFile(path.join(outputOne, "reading.md"), "utf8"));
  assert.equal(first.publication.markdown.path, publishedMarkdown);
  assert.equal(await fs.stat(path.join(outputOne, "publication.json")).then(() => true), true);
  await assert.rejects(fs.stat(path.join(root, "阅读区", "PDF", "合成材料", "reading.md")), { code: "ENOENT" });

  const second = await runPreprocessingRequest(request, {
    producer: { async generate() { throw new Error("producer_must_not_run_on_replay"); } },
    outputDir: outputTwo,
    cacheDir,
    now: "2026-08-16T00:01:00.000Z"
  });
  assert.equal(second.result.status, "idempotent_replay");
  assert.equal(isReadyResult(second.result), true);
});

test("publisher writes one flat Markdown file and relocates relative image assets", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pr-preprocess-publish-"));
  const assetSource = path.join(root, "run", "assets");
  const runDir = path.join(root, "run");
  const publishPath = path.join(root, "阅读区", "PDF", "带图片材料.md");
  await fs.mkdir(assetSource, { recursive: true });
  const imageBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0x80, 0x0a]);
  await fs.writeFile(path.join(assetSource, "figure.png"), imageBytes);
  const result = {
    status: "completed",
    processing_state: "rendered",
    material_id: "mat-publish-fixture",
    idempotency_key: "idem-publish-fixture",
    artifacts: {
      target_zone: "local-ir-reading",
      reading_markdown: "# 带图片材料\n\n![Figure](assets/figure.png)\n"
    }
  };

  const publication = await publishReadingArtifact(result, {
    publishPath,
    assetSourceDir: assetSource,
    runDir,
    now: "2026-08-21T00:00:00.000Z"
  });

  const published = await fs.readFile(publishPath, "utf8");
  assert.match(published, /!\[Figure\]\(_assets\/带图片材料\/figure\.png\)/u);
  const publishedImage = await fs.readFile(path.join(root, "阅读区", "PDF", "_assets", "带图片材料", "figure.png"));
  assert.deepEqual(publishedImage, imageBytes);
  assert.equal(publication.assets.length, 1);
  assert.equal(publication.assets[0].sha256, crypto.createHash("sha256").update(imageBytes).digest("hex"));
  assert.equal(await fs.stat(path.join(runDir, "publication.json")).then(() => true), true);
  await assert.rejects(fs.stat(path.join(root, "阅读区", "PDF", "带图片材料", "reading.md")), { code: "ENOENT" });
});

test("translated publication folds only the original and preserves source checks and old replays", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pr-original-fold-"));
  const source = "    indentedCode()\n\n# Source heading\n\n> Existing quotation\n\n- Item\n  - Nested item\n\n```js\nconst value = 1;\n```\n\n$$x^2$$\n\n[Reference](https://example.invalid/source)";
  const prefix = "# Reading\n\n## 正文\n\n完整译文保持不变。\n\n---\n\n## 原文\n\n";
  const expanded = prefix + source + "\n";
  const result = {
    status: "completed", processing_state: "rendered", translation_state: "generated_translation",
    material_id: "mat-original-fold", idempotency_key: "idem-original-fold",
    artifacts: { target_zone: "local-ir-reading", reading_markdown: expanded, semantic: { judgments: null, insights: [] } },
    receipt: { cleaning_policy: { include_reading_guide: false } }
  };
  const before = structuredClone(result);
  const publishPath = path.join(root, "new.md");
  const publication = await publishReadingArtifact(result, { publishPath });
  const published = await fs.readFile(publishPath, "utf8");
  assert.ok(published.startsWith(prefix + "> [!quote]- 原文\n"));
  const quoted = published.slice((prefix + "> [!quote]- 原文\n").length).trimEnd();
  assert.equal(quoted.split("\n").map(line => line.replace(/^> ?/u, "")).join("\n"), source);
  assert.deepEqual(result, before);
  const verified = verifyChapterPublication({ result, request: { material: { markdown: source } }, publication, markdown: published, sourceMarkdown: source });
  assert.equal(verified.original_complete, true);
  assert.throws(() => verifyChapterPublication({ result, request: { material: { markdown: source } }, publication, markdown: published.replace("Existing quotation", "Missing"), sourceMarkdown: source }), /published_original_incomplete/u);
  const replay = await publishReadingArtifact(result, { publishPath });
  assert.equal(replay.markdown.sha256, publication.markdown.sha256);
  const legacyPath = path.join(root, "existing-expanded.md");
  await fs.writeFile(legacyPath, expanded);
  await publishReadingArtifact(result, { publishPath: legacyPath });
  assert.equal(await fs.readFile(legacyPath, "utf8"), expanded);
  for (const translation_state of ["not_translation", "bilingual", "unknown"]) {
    const untouchedPath = path.join(root, `${translation_state}.md`);
    await publishReadingArtifact({ ...result, translation_state }, { publishPath: untouchedPath });
    assert.equal(await fs.readFile(untouchedPath, "utf8"), expanded);
  }
});

test("publisher fails closed on a conflicting flat Markdown target", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pr-preprocess-publish-conflict-"));
  const publishPath = path.join(root, "阅读区", "Epub", "冲突材料.md");
  await fs.mkdir(path.dirname(publishPath), { recursive: true });
  await fs.writeFile(publishPath, "existing content", "utf8");
  const result = {
    status: "completed",
    processing_state: "rendered",
    material_id: "mat-conflict-fixture",
    idempotency_key: "idem-conflict-fixture",
    artifacts: { target_zone: "local-ir-reading", reading_markdown: "new content" }
  };

  await assert.rejects(
    publishReadingArtifact(result, { publishPath, runDir: path.join(root, "run") }),
    (error) => error?.code === "publish_target_conflict"
  );
  assert.equal(await fs.readFile(publishPath, "utf8"), "existing content");
});

test("publisher removes source-layer markers while preserving intentional Local IR syntax", async () => {
  const source = [
    "<!-- pdf-page:1 -->",
    '<a id="pdf-page-1"></a>',
    "[页内链接](#pdf-page-1)",
    "^pr-123456789abc",
    "",
    "```html",
    "<!-- code example must remain -->",
    "```",
    "\u200b正文"
  ].join("\n");
  const sanitized = sanitizePublishedMarkdown(source);
  assert.doesNotMatch(sanitized.markdown, /pdf-page:1|<a id=|\u200b/u);
  assert.match(sanitized.markdown, /\[\[#\^pr-123456789abc\|页内链接\]\]/u);
  assert.match(sanitized.markdown, /<!-- code example must remain -->/u);
  assert.deepEqual(validatePublishedMarkdownCleanliness(sanitized.markdown), { valid: true, failures: [] });
  assert.equal(sanitized.report.comments_removed, 1);
  assert.equal(sanitized.report.anchors_removed, 1);
  assert.equal(sanitized.report.internal_links_rewritten, 1);
});

test("publisher brackets relocated image destinations with whitespace or parentheses", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pr-image-destination-"));
  const assetSource = path.join(root, "source-assets");
  await fs.mkdir(assetSource, { recursive: true });
  const imageBytes = Buffer.from("source-image-content");
  await fs.writeFile(path.join(assetSource, "figure.png"), imageBytes);
  const result = {
    status: "completed", processing_state: "rendered", material_id: "image-path-fixture",
    idempotency_key: "image-path-fixture", translation_state: "not_translation",
    receipt: {}, errors: [],
    artifacts: { target_zone: "local-ir-reading", reading_markdown: "# Fixture\n\n![Figure](assets/figure.png)\n" }
  };
  for (const title of ["Field notes", "独立例子(草稿)"]) {
    const publication = await publishReadingArtifact(result, {
      publishPath: path.join(root, "阅读区", title + ".md"), assetSourceDir: assetSource
    });
    const markdown = await fs.readFile(publication.markdown.path, "utf8");
    assert.ok(markdown.includes(`![Figure](<_assets/${title}/figure.png>)`));
    assert.deepEqual(await fs.readFile(publication.assets[0].published_path), imageBytes);
    const replay = await publishReadingArtifact(result, {
      publishPath: publication.markdown.path, assetSourceDir: assetSource
    });
    assert.equal(replay.markdown.sha256, publication.markdown.sha256);
  }
});

test("publisher preserves image titles separately from balanced destinations", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pr-image-title-"));
  const source = path.join(root, "source");
  await fs.mkdir(source, { recursive: true });
  const bytes = Buffer.from("independent-image-title-fixture");
  await fs.writeFile(path.join(source, "figure(2).png"), bytes);
  for (const [index, syntax] of [
    '![Figure](assets/figure(2).png "Caption (detail)")',
    "![Figure](<assets/figure(2).png> 'Another caption')",
    '![Figure](assets/figure(2).png (Image title))'
  ].entries()) {
    const result = { status: "completed", processing_state: "rendered", material_id: "title-fixture", idempotency_key: "title-fixture", translation_state: "not_translation", receipt: {}, errors: [],
      artifacts: { target_zone: "local-ir-reading", reading_markdown: `# Images\n\n${syntax}\n\n\`\`\`markdown\n${syntax}\n\`\`\`\n` } };
    const publication = await publishReadingArtifact(result, { publishPath: path.join(root, `Article ${index}.md`), assetSourceDir: source });
    const markdown = await fs.readFile(publication.markdown.path, "utf8");
    assert.ok(markdown.includes(syntax.replace(/(?:<)?assets\/figure\(2\)\.png>?/u, `<_assets/Article ${index}/figure(2).png>`)));
    assert.ok(markdown.includes(`\`\`\`markdown\n${syntax}\n\`\`\``));
    assert.equal(publication.assets.length, 1);
    assert.deepEqual(await fs.readFile(publication.assets[0].published_path), bytes);
  }
});

test("cleanliness gate rejects Pandoc and raw OOXML leakage outside code fences", () => {
  const validation = validatePublishedMarkdownCleanliness("::: note\n正文\n:::\n<w:p>leak</w:p>\n");
  assert.equal(validation.valid, false);
  assert.deepEqual(validation.failures, ["pandoc_fenced_div", "raw_ooxml"]);
});

test("doctor reports config provenance without exposing the API key", async () => {
  const original = {
    provider: process.env.AI_PRODUCER_PROVIDER,
    base: process.env.AI_PRODUCER_BASE_URL,
    key: process.env.DEEPSEEK_READING_API_KEY,
    model: process.env.AI_PRODUCER_MODEL
  };
  const secret = "doctor-secret-must-not-appear";
  process.env.AI_PRODUCER_PROVIDER = 'deepseek';
  process.env.AI_PRODUCER_BASE_URL = "https://api.example.invalid";
  process.env.DEEPSEEK_READING_API_KEY = secret;
  process.env.AI_PRODUCER_MODEL = "fixture-model";
  try {
    const report = await getDoctorReport();
    assert.equal(report.ready, true);
    assert.equal(report.producer.auth_source, "env");
    assert.equal(report.producer.auth_available, true);
    assert.equal(JSON.stringify(report).includes(secret), false);
  } finally {
    for (const [key, value] of Object.entries({
      AI_PRODUCER_PROVIDER: original.provider,
      AI_PRODUCER_BASE_URL: original.base,
      DEEPSEEK_READING_API_KEY: original.key,
      AI_PRODUCER_MODEL: original.model
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("CLI validates from another working directory and emits stable JSON errors", () => {
  const validated = JSON.parse(execFileSync(process.execPath, [
    cliPath,
    "--json",
    "validate",
    "--request",
    monolingualFixture
  ], { cwd: os.tmpdir(), encoding: "utf8", windowsHide: true }));
  assert.equal(validated.ok, true);
  assert.equal(validated.command, "validate");
  assert.equal(validated.valid, true);

  const failed = spawnSync(process.execPath, [cliPath, "--json", "unknown"], {
    cwd: projectRoot,
    encoding: "utf8",
    windowsHide: true
  });
  assert.equal(failed.status, 1);
  const envelope = JSON.parse(failed.stdout);
  assert.equal(envelope.ok, false);
  assert.equal(envelope.error.code, "unknown_command");
});

test("CLI dry-run validates without requiring output or calling the producer", () => {
  const result = JSON.parse(execFileSync(process.execPath, [
    cliPath,
    "--json",
    "run",
    "--request",
    monolingualFixture,
    "--dry-run"
  ], { cwd: os.tmpdir(), encoding: "utf8", windowsHide: true }));
  assert.equal(result.ok, true);
  assert.equal(result.command, "validate");
  assert.equal(result.dry_run, true);
  assert.equal(result.valid, true);
});
