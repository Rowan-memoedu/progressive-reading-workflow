#!/usr/bin/env node
import { mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ENGINE_VERSION, normalizePackage, validateNormalizedPackage } from "../core.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const runId = readArg("--run-id") || "v0.3.0-matrix";
if (!/^[a-zA-Z0-9._-]+$/.test(runId)) throw new Error("--run-id 仅允许字母、数字、点、下划线和连字符");
const runRoot = path.join(here, "runs", runId);
const manifestPath = path.join(runRoot, "canary-manifest.json");
if (await exists(manifestPath)) throw new Error(`Canary run 已存在，拒绝覆盖：${manifestPath}`);

const groups = [
  {
    id: "source-formats",
    title: "来源格式 Canary",
    scenarios: [
      sourceScenario("pdf", "PDF 派生 Markdown", "document", "pdf-derived-markdown", "file:///canary/source.pdf"),
      sourceScenario("word", "Word 派生 Markdown", "document", "word-derived-markdown", "file:///canary/source.docx"),
      sourceScenario("epub", "EPUB 派生 Markdown", "book", "epub-derived-markdown", "file:///canary/source.epub"),
      sourceScenario("youtube", "YouTube 字幕 Markdown", "video_transcript", "youtube-transcript-markdown", "https://www.youtube.com/watch?v=canary"),
      sourceScenario("web", "网页 Markdown", "web_article", "web-markdown", "https://example.test/progressive-reading-canary")
    ]
  },
  {
    id: "annotation-types",
    title: "加工类型 Canary",
    scenarios: [
      annotationScenario("comment", "普通评论", "普通评论"),
      annotationScenario("myth-truth", "myth_truth", "迷思 / 真相"),
      annotationScenario("sample-quote", "sample_quote", "引用"),
      annotationScenario("add-viewpoint", "add_viewpoint", "联想"),
      annotationScenario("optimize", "optimize", "优化"),
      annotationScenario("example-viewpoint", "example_viewpoint", "例子与观点")
    ]
  },
  {
    id: "cards-and-routes",
    title: "卡片与路由 Canary",
    scenarios: [
      qaScenario(),
      clozeScenario(),
      musingScenario(),
      refinedReadingScenario(),
      questionQueueScenario(),
      derivedQaScenario()
    ]
  }
];

const manifest = {
  schema: "progressive-reading.remnote-formal-archive-canary-manifest/v1",
  engineVersion: ENGINE_VERSION,
  runId,
  safety: {
    isolatedRemNoteParentsRequired: true,
    sourceMaterials: "synthetic_representative_snapshots",
    existingKnowledgeBaseNodesModified: false
  },
  groups: []
};

for (const group of groups) {
  const groupRoot = path.join(runRoot, group.id);
  const queueDir = path.join(groupRoot, "queue");
  const vaultRoot = path.join(groupRoot, "vault");
  await mkdir(queueDir, { recursive: true });
  await mkdir(path.join(vaultRoot, "staging"), { recursive: true });
  await mkdir(path.join(vaultRoot, "artifacts"), { recursive: true });
  const manifestScenarios = [];
  for (const scenario of group.scenarios) {
    const sourceFile = `staging/${scenario.id}.md`;
    const archiveFile = `archive/${scenario.id}.md`;
    const raw = {
      ...scenario.package,
      schema: "progressive-reading.local-ir-export-package/v2",
      packageId: `canary-${runId}-${group.id}-${scenario.id}`,
      packageRevision: 1,
      status: "export_package_ready",
      sourcePath: sourceFile,
      localArchive: { state: "export_package_ready", sourcePath: sourceFile, archivedSourcePath: archiveFile }
    };
    const normalized = normalizePackage(raw);
    const errors = validateNormalizedPackage(normalized);
    if (errors.length > 0) throw new Error(`${raw.packageId} 无法生成：${errors.join("; ")}`);
    await writeText(path.join(vaultRoot, sourceFile), `# ${raw.title}\n\n这是隔离 Canary 的合成代表性快照，不来自用户原文。\n`);
    if (raw.refinedReadingPath) await writeText(path.join(vaultRoot, raw.refinedReadingPath), "# 精读派生产物 Canary\n");
    if (raw.questionQueueJsonPath) await writeJson(path.join(vaultRoot, raw.questionQueueJsonPath), { questions: [{ id: "question-route", status: "queued" }] });
    const packageFile = path.join(queueDir, `${scenario.id}.json`);
    await writeJson(packageFile, raw);
    manifestScenarios.push({
      id: scenario.id,
      purpose: scenario.purpose,
      packageId: raw.packageId,
      packageFile: portable(packageFile),
      expectedItems: normalized.items.length,
      expectedDispositions: normalized.dispositionSummary,
      source: normalized.source
    });
  }
  manifest.groups.push({
    id: group.id,
    title: group.title,
    root: portable(groupRoot),
    queueDir: portable(queueDir),
    stateDir: portable(path.join(groupRoot, "state")),
    receiptsDir: portable(path.join(groupRoot, "receipts")),
    vaultRoot: portable(vaultRoot),
    scenarios: manifestScenarios
  });
}

await writeJson(manifestPath, manifest);
process.stdout.write(`${JSON.stringify({ ok: true, runRoot: portable(runRoot), manifestPath: portable(manifestPath), groups: manifest.groups.map((group) => ({ id: group.id, scenarios: group.scenarios.length })) }, null, 2)}\n`);

function sourceScenario(id, title, materialType, format, origin) {
  return {
    id,
    purpose: `验证 ${format} 来源描述、写入、回读与本地归档`,
    package: {
      title: `Canary｜${title}`,
      source: { materialType, format, origin },
      annotations: [basicAnnotation(`${id}-annotation`, "comment", "普通评论")],
      cards: [],
      clozeCards: [],
      articleMusings: []
    }
  };
}

function annotationScenario(id, type, targetDocument) {
  return {
    id,
    purpose: `验证 ${targetDocument} 批注的目标文档、内容与回读`,
    package: {
      title: `Canary｜${targetDocument}`,
      source: { materialType: "markdown_document", format: "markdown", origin: null },
      annotations: [basicAnnotation(`${id}-annotation`, type, targetDocument)],
      cards: [],
      clozeCards: [],
      articleMusings: []
    }
  };
}

function qaScenario() {
  return {
    id: "qa-card",
    purpose: "验证问答卡正式导入",
    package: {
      title: "Canary｜问答卡",
      source: markdownSource(), annotations: [],
      cards: [{ id: "qa-1", questionMarkdown: "正式归档何时成功？", answerMarkdown: "RemNote 写入并回读成功后。", needsQuestionGeneration: false, needsAnswerGeneration: false, source: "article" }],
      clozeCards: [], articleMusings: []
    }
  };
}

function clozeScenario() {
  return {
    id: "cloze-card",
    purpose: "验证挖空卡正式导入",
    package: {
      title: "Canary｜挖空卡",
      source: markdownSource(), annotations: [], cards: [],
      clozeCards: [{ id: "cloze-1", sourceAnnotationId: "source-1", clozeMarkdown: "- 只有 RemNote 写入并{{回读成功}}后才是正式归档。" }],
      articleMusings: []
    }
  };
}

function musingScenario() {
  return {
    id: "article-musing",
    purpose: "验证文章随想不再静默留在本地",
    package: {
      title: "Canary｜文章随想",
      source: markdownSource(), annotations: [], cards: [], clozeCards: [],
      articleMusings: [{ id: "musing-1", bodyMarkdown: "导出包准备好不等于正式归档。", aiStatus: "pending" }]
    }
  };
}

function refinedReadingScenario() {
  return {
    id: "refined-reading-route",
    purpose: "验证精读派生产物有显式去向，同时保留一个可回读随想",
    package: {
      title: "Canary｜精读路由",
      source: markdownSource(),
      refinedReadingPath: "artifacts/refined-reading.md",
      annotations: [{ id: "refined-1", type: "comment", route: "refined_reading", highlightOnly: true, importable: true, originalText: "精读片段" }],
      cards: [], clozeCards: [],
      articleMusings: [{ id: "musing-1", bodyMarkdown: "精读派生产物已经落盘。", aiStatus: "pending" }]
    }
  };
}

function questionQueueScenario() {
  return {
    id: "question-queue-route",
    purpose: "验证 Codex 问题队列有显式去向，同时保留一个可回读随想",
    package: {
      title: "Canary｜问题队列路由",
      source: markdownSource(),
      questionQueueJsonPath: "artifacts/questions.json",
      annotations: [{ id: "question-1", type: "question", route: "codex_question_queue", importable: false, originalText: "为什么导出不等于归档？" }],
      cards: [], clozeCards: [],
      articleMusings: [{ id: "musing-1", bodyMarkdown: "问题派生产物已经落盘。", aiStatus: "pending" }]
    }
  };
}

function derivedQaScenario() {
  return {
    id: "derived-qa-route",
    purpose: "验证批注到问答卡的派生关系及问答卡回读",
    package: {
      title: "Canary｜派生问答卡",
      source: markdownSource(),
      annotations: [{ id: "annotation-to-card", type: "qa_card", route: "remnote_card", importable: false, originalText: "正式归档定义" }],
      cards: [{ id: "derived-card", sourceAnnotationId: "annotation-to-card", questionMarkdown: "生成包后是否已归档？", answerMarkdown: "否，必须等待 RemNote 写入与回读。", needsQuestionGeneration: false, needsAnswerGeneration: false, source: "annotation" }],
      clozeCards: [], articleMusings: []
    }
  };
}

function basicAnnotation(id, type, targetDocument) {
  return {
    id, index: 1, type, typeLabel: targetDocument, targetDocument,
    route: "remnote", importable: true,
    originalText: `这是 ${targetDocument} Canary 的原文片段。`,
    currentText: `这是 ${targetDocument} Canary 的原文片段。`,
    commentMarkdown: `这是 ${targetDocument} Canary 的评论。`, rewriteMarkdown: ""
  };
}

function markdownSource() {
  return { materialType: "markdown_document", format: "markdown", origin: null };
}

function readArg(flag) {
  const index = process.argv.indexOf(flag);
  if (index < 0) return "";
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}

async function writeJson(filePath, value) {
  await writeText(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

async function writeText(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, value, { encoding: "utf8", flag: "wx" });
}

async function exists(filePath) {
  try { await stat(filePath); return true; } catch (error) { if (error?.code === "ENOENT") return false; throw error; }
}

function portable(value) {
  return path.resolve(value).replace(/\\/g, "/");
}
