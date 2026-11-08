import { execFileSync } from "node:child_process";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";
import {loadBatchProducerConfig, requestProducerText} from '../standard-preprocessing/lib/producer.mjs';

const DEFAULT_QUEUE_DIR = "RemNote 导出队列";
const CONFIG_DIR = path.join(os.homedir(), "Documents", "New project");
const REQUIRED_CONFIG = ["AI_PRODUCER_BASE_URL", "DEEPSEEK_READING_API_KEY", "AI_PRODUCER_MODEL"];

const args = parseArgs(process.argv.slice(2));
const root = process.cwd();
const queueDir = path.resolve(root, args.queue || DEFAULT_QUEUE_DIR);

if (fileURLToPath(import.meta.url) === path.resolve(process.argv[1] || "")) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

async function main() {
  const packages = await loadQueuePackages(queueDir);
  const tasks = packages.filter((item) => getUnresolvedCards(item.data).length > 0);

  if (tasks.length === 0) {
    console.log("没有需要 API 补全的问答卡。");
    return;
  }

  console.log(`需要补全问答卡的导出包：${tasks.length}`);
  if (args.dryRun) {
    for (const item of tasks) {
      const cards = getUnresolvedCards(item.data);
      console.log(`- ${item.data.title}: ${cards.length}`);
      for (const card of cards) {
        console.log(`  - ${card.id}: question=${card.needsQuestionGeneration ? "待生成" : "已存在"} answer=${card.needsAnswerGeneration ? "待生成" : "已存在"}`);
      }
    }
    return;
  }

  const config = await loadBatchProducerConfig();
  for (const item of tasks) {
    const result = await resolvePackageData(item.data, config);
    if (result.changed) await savePackage(item.filePath, item.data);
    console.log(`已处理问答卡：${item.data.title} / changed=${result.changed ? "yes" : "no"} unresolved=${result.unresolved}`);
  }
}

export async function resolvePackageData(data, config) {
  let changed = false;
  let unresolved = 0;
  const cards = Array.isArray(data.cards) ? data.cards : [];
  for (const card of cards) {
    if (!needsResolution(card)) continue;
    try {
      const resolved = await resolveCard(config, data, card);
      if (card.needsQuestionGeneration && resolved.questionMarkdown) {
        card.questionMarkdown = resolved.questionMarkdown.trim();
        card.needsQuestionGeneration = false;
        changed = true;
      }
      if (card.needsAnswerGeneration && resolved.answerMarkdown) {
        card.answerMarkdown = resolved.answerMarkdown.trim();
        card.needsAnswerGeneration = false;
        changed = true;
      }
      card.cardMarkdown = renderRemNoteMultiLineCard(card.questionMarkdown || "待生成问题", card.answerMarkdown || card.answerSourceText || "待生成答案");
      card.qaResolvedAt = new Date().toISOString();
      card.qaResolveReason = resolved.reason || null;
      card.qaResolveConfidence = normalizeConfidence(resolved.confidence);
      card.status = "pending";
    } catch (error) {
      unresolved += 1;
      card.status = "failed";
      card.qaResolveError = error instanceof Error ? error.message : String(error);
      card.qaResolveFailedAt = new Date().toISOString();
      changed = true;
    }
  }
  return { changed, unresolved };
}

export async function loadProducerConfig() {
  const config = {};
  for (const key of REQUIRED_CONFIG) {
    config[key] = process.env[key] || readWindowsUserEnv(key) || "";
  }

  const markdownConfig = await readMarkdownConfig();
  for (const key of REQUIRED_CONFIG) {
    if (!config[key] && markdownConfig[key]) config[key] = markdownConfig[key];
  }

  const missing = REQUIRED_CONFIG.filter((key) => !config[key]);
  if (missing.length > 0) throw new Error(`缺少 API 配置：${missing.join(", ")}`);
  return config;
}

function getUnresolvedCards(data) {
  if (!Array.isArray(data.cards)) return [];
  return data.cards.filter(needsResolution);
}

function needsResolution(card) {
  return Boolean(card && (card.needsQuestionGeneration || card.needsAnswerGeneration || !String(card.questionMarkdown || "").trim() || !String(card.answerMarkdown || "").trim()));
}

async function resolveCard(config, data, card) {
  const payload = {
    model: config.AI_PRODUCER_MODEL,
    temperature: 0.2,
    messages: [
      {
        role: "system",
        content: [
          "你负责把渐进阅读归档内容补全为 RemNote 问答卡。",
          "制卡原则：卡片是检索任务，不是摘要；问题要具体，答案要能由材料支持。",
          "最终导入会使用 RemNote 多行卡语法 `- 问题 >>>`，答案作为缩进子项。",
          "不要输出 Markdown 卡片本体，只输出 JSON。",
          "JSON 字段：questionMarkdown, answerMarkdown, confidence, reason。",
          "如果已有字段不需要生成，就原样返回对应字段。",
          "answerMarkdown 必须只基于给定 sourceText / answerSourceText，不要引入外部事实。"
        ].join("\n")
      },
      {
        role: "user",
        content: JSON.stringify({
          sourceTitle: data.title,
          sourcePath: data.sourcePath,
          headingPath: card.headingPath || [],
          needsQuestionGeneration: Boolean(card.needsQuestionGeneration || !card.questionMarkdown),
          needsAnswerGeneration: Boolean(card.needsAnswerGeneration || !card.answerMarkdown),
          questionMarkdown: card.questionMarkdown || "",
          answerMarkdown: card.answerMarkdown || "",
          answerSourceText: card.answerSourceText || "",
          sourceMode: card.source || "article"
        }, null, 2)
      }
    ]
  };

  if (config.AI_PRODUCER_PROVIDER === 'codex_exec') {
    const raw = await requestProducerText(config, {
      system:payload.messages[0].content, user:payload.messages[1].content
    });
    return parseJsonObject(raw.choices?.[0]?.message?.content || '');
  }
  const response = await fetch(chatCompletionsUrl(config.AI_PRODUCER_BASE_URL), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${config.DEEPSEEK_READING_API_KEY}`
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(120000)
  });

  if (!response.ok) {
    throw new Error(`API ${response.status}: ${await response.text()}`);
  }

  const dataJson = await response.json();
  const text = dataJson?.choices?.[0]?.message?.content || "";
  return parseJsonObject(text);
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

function readWindowsUserEnv(key) {
  if (process.platform !== "win32") return "";
  try {
    return execFileSync("powershell.exe", [
      "-NoProfile",
      "-Command",
      `[Environment]::GetEnvironmentVariable('${key}', 'User')`
    ], { encoding: "utf8", windowsHide: true }).trim();
  } catch {
    return "";
  }
}

async function readMarkdownConfig() {
  try {
    const entries = await readdir(CONFIG_DIR, { withFileTypes: true });
    const configFile = entries.find((entry) => entry.isFile() && /^DeepSeek API.*\.md$/i.test(entry.name));
    if (!configFile) return {};
    const text = await readFile(path.join(CONFIG_DIR, configFile.name), "utf8");
    const config = {};
    for (const line of text.split(/\r?\n/)) {
      const match = /^(AI_PRODUCER_[A-Z_]+)\s*=\s*(.+?)\s*$/.exec(line.trim());
      if (match) config[match[1]] = match[2];
    }
    return config;
  } catch {
    return {};
  }
}

function chatCompletionsUrl(baseUrl) {
  const trimmed = baseUrl.replace(/\/+$/, "");
  if (/\/chat\/completions$/i.test(trimmed)) return trimmed;
  return `${trimmed}/chat/completions`;
}

function parseJsonObject(text) {
  const trimmed = String(text || "").trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const match = /\{[\s\S]*\}/.exec(trimmed);
    if (!match) throw new Error(`API 未返回 JSON：${trimmed.slice(0, 200)}`);
    return JSON.parse(match[0]);
  }
}

function normalizeConfidence(value) {
  return value === "high" || value === "medium" || value === "low" ? value : "low";
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

function parseArgs(argv) {
  const parsed = { dryRun: false, queue: "" };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--dry-run") parsed.dryRun = true;
    else if (arg === "--queue") parsed.queue = argv[++index] || "";
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return parsed;
}
