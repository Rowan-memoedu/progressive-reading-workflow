#!/usr/bin/env node
import { mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ENGINE_VERSION, normalizePackage, validateNormalizedPackage } from "../core.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const runId = readArg("--run-id") || "v0.3.0-format-fix-a";
if (!/^[a-zA-Z0-9._-]+$/.test(runId)) throw new Error("invalid run id");
const root = path.join(here, "runs", runId);
const manifestPath = path.join(root, "canary-manifest.json");
if (await exists(manifestPath)) throw new Error(`run already exists: ${manifestPath}`);

const groupRoot = path.join(root, "format-fix");
const queueDir = path.join(groupRoot, "queue");
const vaultRoot = path.join(groupRoot, "vault");
await mkdir(queueDir, { recursive: true });
await mkdir(path.join(vaultRoot, "staging"), { recursive: true });

const scenarios = [
  {
    id: "qa-multiline-clean",
    purpose: "原生 >>> 多行问答卡且无可见技术元数据",
    cards: [{ id: "qa-clean", questionMarkdown: "什么才算正式归档成功？", answerMarkdown: "RemNote 写入成功。\n逐项回读验证成功。\n本地 receipt 与状态推进完成。", needsQuestionGeneration: false, needsAnswerGeneration: false }]
  },
  {
    id: "annotation-clean",
    purpose: "批注只保留人类可读正文",
    annotations: [{ id: "ann-clean", index: 1, type: "comment", typeLabel: "普通评论", targetDocument: "普通评论", route: "remnote", importable: true, originalText: "导出包准备好不等于正式归档。", currentText: "导出包准备好不等于正式归档。", commentMarkdown: "正式状态必须等待远端回读。" }]
  },
  {
    id: "musing-clean",
    purpose: "随想不显示 aiStatus、路径或哈希",
    articleMusings: [{ id: "musing-clean", bodyMarkdown: "面向人的知识内容与机器审计记录应分层保存。", aiStatus: "pending" }]
  }
];

const manifestScenarios = [];
for (const scenario of scenarios) {
  const sourcePath = `staging/${scenario.id}.md`;
  const archivedSourcePath = `archive/${scenario.id}.md`;
  const raw = {
    schema: "progressive-reading.local-ir-export-package/v2",
    packageId: `canary-${runId}-${scenario.id}`,
    packageRevision: 1,
    status: "export_package_ready",
    title: `Canary｜${scenario.id}`,
    sourcePath,
    source: { materialType: "markdown_document", format: "markdown", origin: null },
    localArchive: { state: "export_package_ready", sourcePath, archivedSourcePath },
    annotations: scenario.annotations || [],
    cards: scenario.cards || [],
    clozeCards: [],
    articleMusings: scenario.articleMusings || []
  };
  const normalized = normalizePackage(raw);
  const errors = validateNormalizedPackage(normalized);
  if (errors.length) throw new Error(`${scenario.id}: ${errors.join("; ")}`);
  const visible = normalized.items.map((item) => `${item.title}\n${item.content}\n${item.creationContent || ""}`).join("\n");
  if (/\[IR:|formalArchive|payloadHash|packageId|sourceMaterialType|sourceFormat|sourceOrigin|Obsidian source path|aiStatus/i.test(visible)) {
    throw new Error(`${scenario.id}: visible technical metadata detected`);
  }
  if (scenario.id === "qa-multiline-clean" && !normalized.items[0].creationContent.includes(" >>>\n    - ")) {
    throw new Error("QA multiline card syntax missing");
  }
  const packageFile = path.join(queueDir, `${scenario.id}.json`);
  await writeJson(packageFile, raw);
  await writeText(path.join(vaultRoot, sourcePath), `# ${raw.title}\n\n隔离格式修正 Canary。\n`);
  manifestScenarios.push({
    id: scenario.id,
    purpose: scenario.purpose,
    packageId: raw.packageId,
    packageFile: portable(packageFile),
    expectedItems: 1,
    expectedDispositions: normalized.dispositionSummary,
    source: normalized.source
  });
}

await writeJson(manifestPath, {
  schema: "progressive-reading.remnote-formal-archive-canary-manifest/v1",
  engineVersion: ENGINE_VERSION,
  runId,
  safety: { isolatedRemNoteParentsRequired: true, sourceMaterials: "synthetic_representative_snapshots", existingKnowledgeBaseNodesModified: false },
  groups: [{
    id: "format-fix",
    title: "格式修正 Canary",
    root: portable(groupRoot),
    queueDir: portable(queueDir),
    stateDir: portable(path.join(groupRoot, "state")),
    receiptsDir: portable(path.join(groupRoot, "receipts")),
    vaultRoot: portable(vaultRoot),
    scenarios: manifestScenarios
  }]
});

process.stdout.write(`${JSON.stringify({ ok: true, runId, manifestPath: portable(manifestPath), packages: scenarios.length }, null, 2)}\n`);

function readArg(flag) {
  const index = process.argv.indexOf(flag);
  if (index < 0) return "";
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}

async function writeJson(filePath, value) { await writeText(filePath, `${JSON.stringify(value, null, 2)}\n`); }
async function writeText(filePath, value) { await mkdir(path.dirname(filePath), { recursive: true }); await writeFile(filePath, value, { encoding: "utf8", flag: "wx" }); }
async function exists(filePath) { try { await stat(filePath); return true; } catch (error) { if (error?.code === "ENOENT") return false; throw error; } }
function portable(value) { return path.resolve(value).replace(/\\/g, "/"); }
