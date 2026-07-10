import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { loadProducerConfig, resolvePackageData } from "./resolve-qa-queue.mjs";

const DEFAULT_QUEUE_DIR = "RemNote 导出队列";
const DEFAULT_MCP_URL = "http://127.0.0.1:3001/mcp";
const PARENT_TITLE = "渐进阅读导入队列";
const TARGET_DOCUMENTS = ["普通评论", "迷思 / 真相", "引用", "联想", "优化", "例子与观点", "问答卡", "挖空卡"];

const args = parseArgs(process.argv.slice(2));
const root = process.cwd();
const queueDir = path.resolve(root, args.queue || DEFAULT_QUEUE_DIR);
const mcpUrl = args.mcpUrl || process.env.REMNOTE_MCP_URL || DEFAULT_MCP_URL;

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

async function main() {
  const packages = await loadQueuePackages(queueDir);
  const pending = packages.filter(({ data }) => data.importStatus === "pending" || data.importStatus === "failed");

  if (pending.length === 0) {
    console.log("没有待导入的 RemNote 队列包。");
    return;
  }

  if (args.dryRun) {
    printDryRun(pending);
    return;
  }

  const client = new RemNoteMcpClient(mcpUrl);
  try {
    const status = await client.call("remnote_status", {});
    if (!status?.connected) {
      throw new Error("RemNote MCP 未连接。请打开 RemNote Automation Bridge 并点击 Reconnect Now。");
    }

    const parentId = await findOrCreateNote(client, PARENT_TITLE, null, true);
    const documentIds = {};
    for (const title of TARGET_DOCUMENTS) {
      documentIds[title] = await findOrCreateNote(client, title, parentId, true);
    }

    for (const item of pending) {
      await importPackage(client, item, parentId, documentIds);
    }
  } finally {
    await client.close();
  }
}

async function importPackage(client, item, parentId, documentIds) {
  const { filePath, data } = item;
  data.remnote ??= {};
  data.remnote.parentRemId = parentId;
  data.remnote.typeDocumentRemIds = { ...(data.remnote.typeDocumentRemIds || {}), ...documentIds };
  data.remnote.annotationRemIds ??= {};
  data.remnote.cardRemIds ??= {};
  data.remnote.clozeCardRemIds ??= {};

  try {
    if (getUnresolvedQaCards(data).length > 0) {
      const config = await loadProducerConfig();
      const result = await resolvePackageData(data, config);
      await savePackage(filePath, data);
      if (result.unresolved > 0 || getUnresolvedQaCards(data).length > 0) {
        throw new Error(`问答卡仍有未补全项：${result.unresolved}`);
      }
    }

    const importable = getImportableAnnotations(data);
    const qaCards = getResolvedQaCards(data);
    const clozeCards = getClozeCards(data);
    if (importable.length === 0 && qaCards.length === 0 && clozeCards.length === 0) {
      data.importStatus = "imported";
      data.importedAt = new Date().toISOString();
      data.importNote = "No direct RemNote import items; highlight-only content was requeued and article musings remain pending AI resolution.";
      await savePackage(filePath, data);
      console.log(`跳过 RemNote 写入：${data.title}`);
      return;
    }

    const grouped = groupBy(importable, (annotation) => normalizeTargetDocument(annotation.targetDocument || annotation.type));
    for (const [documentTitle, annotations] of Object.entries(grouped)) {
      const documentId = documentIds[documentTitle] || documentIds["普通评论"];

      for (const annotation of annotations) {
        if (data.remnote.annotationRemIds[annotation.id]) continue;
        const annotationId = await createAnnotationNode(client, documentId, data, annotation);
        data.remnote.annotationRemIds[annotation.id] = annotationId;
        await savePackage(filePath, data);
      }
    }

    const cardDocumentId = documentIds["问答卡"];
    for (const card of qaCards) {
      if (data.remnote.cardRemIds[card.id]) continue;
      const cardId = await createQaCardNode(client, cardDocumentId, data, card);
      data.remnote.cardRemIds[card.id] = cardId;
      card.status = "imported";
      card.importedAt = new Date().toISOString();
      await savePackage(filePath, data);
    }

    const clozeDocumentId = documentIds["挖空卡"];
    for (const card of clozeCards) {
      if (data.remnote.clozeCardRemIds[card.id]) continue;
      const clozeId = await createClozeCardNode(client, clozeDocumentId, data, card);
      data.remnote.clozeCardRemIds[card.id] = clozeId;
      card.status = "imported";
      card.importedAt = new Date().toISOString();
      await savePackage(filePath, data);
    }

    data.importStatus = "imported";
    data.importError = null;
    data.importedAt = new Date().toISOString();
    await savePackage(filePath, data);
    console.log(`已导入 RemNote：${data.title}`);
  } catch (error) {
    data.importStatus = "failed";
    data.importError = error instanceof Error ? error.message : String(error);
    data.failedAt = new Date().toISOString();
    await savePackage(filePath, data);
    throw error;
  }
}

async function createAnnotationNode(client, parentId, data, annotation) {
  const result = await client.call("remnote_create_note", {
    title: `[IR] ${data.title} · 摘录 ${annotation.index || ""} · ${annotation.typeLabel || normalizeTargetDocument(annotation.type)}`.trim(),
    parentId,
    content: renderAnnotationContent(data, annotation)
  });
  return firstRemId(result);
}

function renderAnnotationContent(data, annotation) {
  const currentText = annotation.expandedText || annotation.currentText || annotation.originalText || "";
  if (annotation.type === "example_viewpoint" || annotation.targetDocument === "例子与观点") {
    const lines = [
      "- 例子",
      ...indentedText(currentText),
      "- 观点",
      ...indentedText(annotation.commentMarkdown || "待补充"),
      "- 原文高亮文本",
      ...indentedText(annotation.originalText || annotation.currentText || ""),
      "- 对应英文原文",
      ...indentedText(annotation.bilingual?.englishText || "无"),
      `- 来源文章：${data.title}`,
      `- Obsidian source path：${data.sourcePath}`
    ];
    if (annotation.bilingual?.detected) lines.push(`- bilingualConfidence：${annotation.bilingual.confidence || "none"}`);
    if (annotation.bilingual?.needsApiResolution) lines.push("- bilingualNeedsApiResolution：true");
    if (annotation.orphaned) lines.push("- orphaned：true");
    return lines.join("\n");
  }
  const lines = [
    "- 摘录 / 当前文本",
    ...indentedText(currentText),
    "- 原文高亮文本",
    ...indentedText(annotation.originalText || annotation.currentText || ""),
    "- 层级扩展范围",
    ...indentedText(annotation.scope && annotation.scope !== "selection" ? `${annotation.scope}${Array.isArray(annotation.headingPath) && annotation.headingPath.length ? ` / ${annotation.headingPath.join(" > ")}` : ""}` : "无"),
    "- 对应英文原文",
    ...indentedText(annotation.bilingual?.englishText || "无"),
    `- 评论结构类型：${annotation.typeLabel || annotation.type || "普通评论"}`,
    "- 评论内容",
    ...indentedText(annotation.commentMarkdown || "无"),
    "- 改写稿",
    ...indentedText(annotation.rewriteMarkdown || "无"),
    `- 来源文章：${data.title}`,
    `- Obsidian source path：${data.sourcePath}`
  ];
  if (annotation.bilingual?.detected) lines.push(`- bilingualConfidence：${annotation.bilingual.confidence || "none"}`);
  if (annotation.bilingual?.needsApiResolution) lines.push("- bilingualNeedsApiResolution：true");
  if (annotation.orphaned) lines.push("- orphaned：true");
  if (annotation.rewriteApplied) lines.push("- rewriteApplied：true");
  return lines.join("\n");
}

async function createQaCardNode(client, parentId, data, card) {
  const title = getCardTitle(card);
  const result = await client.call("remnote_create_note", {
    title,
    parentId,
    content: renderQaCardContent(data, card)
  });
  return firstRemId(result);
}

async function createClozeCardNode(client, parentId, data, card) {
  const title = getClozeCardTitle(card);
  const result = await client.call("remnote_create_note", {
    title,
    parentId,
    content: renderClozeCardContent(data, card)
  });
  return firstRemId(result);
}

function getCardTitle(card) {
  const markdown = card.cardMarkdown || renderRemNoteMultiLineCard(card.questionMarkdown || "待生成问题", card.answerMarkdown || "待生成答案");
  const first = markdown.split(/\r?\n/)[0] || "- 待生成问题 >>>";
  return first.replace(/^-\s*/, "").trim();
}

function getClozeCardTitle(card) {
  const markdown = stripIrMarkup(card.clozeMarkdown || "");
  const first = markdown.split(/\r?\n/).find((line) => line.trim()) || "{{待生成挖空}}";
  return first.replace(/^-\s*/, "").trim();
}

function renderQaCardContent(data, card) {
  const markdown = card.cardMarkdown || renderRemNoteMultiLineCard(card.questionMarkdown || "待生成问题", card.answerMarkdown || "待生成答案");
  const answerLines = markdown.split(/\r?\n/).slice(1).map((line) => line.replace(/^ {4}/, "")).filter((line) => line.trim());
  const lines = [
    ...answerLines,
    "- #[[Extra Card Detail]]",
    `  - 来源文章：${data.title}`,
    `  - Obsidian source path：${data.sourcePath}`,
    `  - source：${card.source || "article"}`,
    `  - scope：${card.scope || "selection"}`
  ];
  if (Array.isArray(card.headingPath) && card.headingPath.length > 0) lines.push(`  - headingPath：${card.headingPath.join(" > ")}`);
  return lines.join("\n");
}

function renderClozeCardContent(data, card) {
  const markdown = stripIrMarkup(card.clozeMarkdown || "");
  const rest = markdown.split(/\r?\n/).slice(1).filter((line) => line.trim());
  const lines = [
    ...rest,
    "- #[[Extra Card Detail]]",
    `  - 来源文章：${data.title}`,
    `  - Obsidian source path：${data.sourcePath}`,
    `  - sourceAnnotationId：${card.sourceAnnotationId || "无"}`,
    `  - scope：${card.scope || "selection"}`
  ];
  if (Array.isArray(card.headingPath) && card.headingPath.length > 0) lines.push(`  - headingPath：${card.headingPath.join(" > ")}`);
  if (card.contextText) {
    lines.push("  - contextText：");
    for (const line of stripIrMarkup(card.contextText).split(/\r?\n/).filter((item) => item.trim())) {
      lines.push(`    - ${line.trim()}`);
    }
  }
  return lines.join("\n");
}

function indentedText(value) {
  const lines = String(value || "").trim().split(/\r?\n/).filter((line) => line.trim());
  if (lines.length === 0) return ["  - 无"];
  return lines.map((line) => `  - ${line}`);
}

async function findOrCreateNote(client, title, parentId, asDocument) {
  const existing = await findExistingNote(client, title, parentId);
  if (existing) return existing;
  const payload = { title, asDocument };
  if (parentId) payload.parentId = parentId;
  const result = await client.call("remnote_create_note", payload);
  return firstRemId(result);
}

async function findExistingNote(client, title, parentId) {
  const result = await client.call("remnote_search", {
    query: title,
    limit: 20,
    view: "compact",
    contentMode: "none",
    ancestorDepth: parentId ? 2 : 0
  });
  const results = Array.isArray(result?.results) ? result.results : [];
  const exact = results.find((note) => {
    const noteTitle = note.title || note.headline;
    if (noteTitle !== title) return false;
    if (!parentId) return true;
    return note.parentRemId === parentId || (Array.isArray(note.ancestors) && note.ancestors.some((ancestor) => ancestor.remId === parentId));
  });
  return exact?.remId || null;
}

function firstRemId(result) {
  const ids = result?.remIds;
  if (Array.isArray(ids) && ids[0]) return ids[0];
  if (typeof result?.remId === "string") return result.remId;
  throw new Error(`RemNote create_note did not return a Rem ID: ${JSON.stringify(result)}`);
}

async function loadQueuePackages(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = entries.filter((entry) => entry.isFile() && entry.name.endsWith(".json"));
  const packages = [];
  for (const file of files) {
    const filePath = path.join(dir, file.name);
    const data = JSON.parse(stripBom(await readFile(filePath, "utf8")));
    packages.push({ filePath, data });
  }
  return packages;
}

async function savePackage(filePath, data) {
  await writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

function printDryRun(items) {
  console.log(`待导入包：${items.length}`);
  console.log(`目标父级：${PARENT_TITLE}`);
  console.log(`目标文档：${TARGET_DOCUMENTS.join(" / ")}`);
  for (const { data } of items) {
    const importable = getImportableAnnotations(data);
    const qaCards = Array.isArray(data.cards) ? data.cards : [];
    const resolvedQaCards = getResolvedQaCards(data);
    const unresolvedQaCards = getUnresolvedQaCards(data);
    const clozeCards = getClozeCards(data);
    const articleMusings = getArticleMusings(data);
    const highlightOnly = Array.isArray(data.annotations) ? data.annotations.filter((annotation) => annotation.highlightOnly) : [];
    const questions = Array.isArray(data.annotations) ? data.annotations.filter((annotation) => annotation.route === "codex_question_queue" || annotation.type === "question") : [];
    console.log("");
    console.log(`- ${data.title}`);
    console.log(`  source: ${data.sourcePath}`);
    console.log(`  RemNote加工条目: ${importable.length}`);
    console.log(`  Codex提问题目: ${questions.length}`);
    console.log(`  问答卡: ${resolvedQaCards.length} 可导入 / ${unresolvedQaCards.length} 待补全 / ${qaCards.length} 总数`);
    console.log(`  挖空卡: ${clozeCards.length}`);
    console.log(`  随想待 AI 解析: ${articleMusings.length}`);
    console.log(`  仅高亮回流条目: ${highlightOnly.length}`);
    console.log(`  二次阅读稿: ${data.refinedReadingPath || "无"}`);
    console.log(`  提问队列: ${data.questionQueueMarkdownPath || data.questionQueueJsonPath || "无"}`);
    const grouped = groupBy(importable, (annotation) => normalizeTargetDocument(annotation.targetDocument || annotation.type));
    for (const [documentTitle, annotations] of Object.entries(grouped)) {
      console.log(`  ${documentTitle}: ${annotations.length}`);
    }
  }
}

function getImportableAnnotations(data) {
  if (!Array.isArray(data.annotations)) return [];
  return data.annotations.filter((annotation) => annotation.importable && annotation.route !== "codex_question_queue" && annotation.route !== "remnote_card" && annotation.type !== "question" && annotation.type !== "qa_card");
}

function getResolvedQaCards(data) {
  if (!Array.isArray(data.cards)) return [];
  return data.cards.filter((card) => String(card.questionMarkdown || "").trim() && String(card.answerMarkdown || "").trim() && !card.needsQuestionGeneration && !card.needsAnswerGeneration);
}

function getUnresolvedQaCards(data) {
  if (!Array.isArray(data.cards)) return [];
  return data.cards.filter((card) => !String(card.questionMarkdown || "").trim() || !String(card.answerMarkdown || "").trim() || card.needsQuestionGeneration || card.needsAnswerGeneration);
}

function getClozeCards(data) {
  if (!Array.isArray(data.clozeCards)) return [];
  return data.clozeCards.filter((card) => String(card.clozeMarkdown || "").trim() && card.status !== "imported");
}

function getArticleMusings(data) {
  if (!Array.isArray(data.articleMusings)) return [];
  return data.articleMusings.filter((musing) => String(musing.bodyMarkdown || "").trim() && (musing.aiStatus || "pending") === "pending");
}

function normalizeTargetDocument(value) {
  if (value === "问答卡" || value === "qa_card") return "问答卡";
  if (value === "迷思 / 真相" || value === "myth_truth") return "迷思 / 真相";
  if (value === "引用" || value === "sample_quote") return "引用";
  if (value === "联想" || value === "add_viewpoint") return "联想";
  if (value === "优化" || value === "optimize") return "优化";
  if (value === "例子与观点" || value === "example_viewpoint") return "例子与观点";
  return "普通评论";
}

function renderRemNoteMultiLineCard(question, answer) {
  const q = stripIrMarkup(question).replace(/\s+/g, " ").trim() || "待生成问题";
  const answerLines = stripIrMarkup(answer).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const back = answerLines.length > 0 ? answerLines.map((line) => `    - ${line.replace(/^[-*+]\s+/, "")}`) : ["    - 待生成答案"];
  return [`- ${q} >>>`, ...back].join("\n");
}

function stripIrMarkup(value) {
  return String(value || "")
    .replace(/<mark\b[^>]*>/gi, "")
    .replace(/<\/mark>/gi, "")
    .replace(/==([\s\S]*?)==/g, "$1")
    .replace(/\r\n/g, "\n");
}

function stripBom(text) {
  return String(text || "").replace(/^\uFEFF/, "");
}

function groupBy(items, getKey) {
  return items.reduce((acc, item) => {
    const key = getKey(item);
    acc[key] ??= [];
    acc[key].push(item);
    return acc;
  }, {});
}

function parseArgs(argv) {
  const parsed = { dryRun: false, queue: "", mcpUrl: "" };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--dry-run") parsed.dryRun = true;
    else if (arg === "--queue") parsed.queue = argv[++index] || "";
    else if (arg === "--mcp-url") parsed.mcpUrl = argv[++index] || "";
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return parsed;
}

class RemNoteMcpClient {
  constructor(url) {
    this.url = url;
    this.client = null;
    this.transport = null;
  }

  async call(name, payload) {
    await this.connect();
    const result = await this.client.callTool({ name, arguments: payload });
    if (result.isError) throw new Error(extractText(result));
    return parseToolResult(result);
  }

  async connect() {
    if (this.client) return;
    this.transport = new StreamableHTTPClientTransport(new URL(this.url));
    this.client = new Client({ name: "local-ir-remnote-importer", version: "0.4.0" });
    await this.client.connect(this.transport);
  }

  async close() {
    try {
      if (this.transport) await this.transport.terminateSession();
    } catch {
      // Ignore cleanup errors.
    }
    try {
      if (this.client) await this.client.close();
    } catch {
      // Ignore cleanup errors.
    }
  }
}

function parseToolResult(result) {
  if (result.structuredContent && typeof result.structuredContent === "object") return result.structuredContent;
  const text = extractText(result);
  try {
    return JSON.parse(text);
  } catch {
    return { _raw: text };
  }
}

function extractText(result) {
  const item = result.content?.find((entry) => entry.type === "text" && entry.text);
  return item?.text || JSON.stringify(result);
}
