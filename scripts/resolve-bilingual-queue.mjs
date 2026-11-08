import { execFileSync } from "node:child_process";
import { readdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {loadBatchProducerConfig, requestProducerText} from '../standard-preprocessing/lib/producer.mjs';

const DEFAULT_QUEUE_DIR = "RemNote 导出队列";
const CONFIG_DIR = path.join(os.homedir(), "Documents", "New project");
const REQUIRED_CONFIG = ["AI_PRODUCER_BASE_URL", "DEEPSEEK_READING_API_KEY", "AI_PRODUCER_MODEL"];

const args = parseArgs(process.argv.slice(2));
const root = process.cwd();
const queueDir = path.resolve(root, args.queue || DEFAULT_QUEUE_DIR);

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

async function main() {
  const packages = await loadQueuePackages(queueDir);
  const tasks = [];
  for (const item of packages) {
    const annotations = Array.isArray(item.data.annotations) ? item.data.annotations : [];
    for (const annotation of annotations) {
      if (needsResolution(annotation)) tasks.push({ item, annotation });
    }
  }

  if (tasks.length === 0) {
    console.log("没有需要 API 对齐的双语条目。");
    return;
  }

  console.log(`需要对齐的双语条目：${tasks.length}`);
  if (args.dryRun) {
    for (const { item, annotation } of tasks) {
      console.log(`- ${item.data.title} / ${annotation.id} / candidates: ${annotation.bilingual.candidates.length}`);
    }
    return;
  }

  const config = await loadBatchProducerConfig();
  for (const { item, annotation } of tasks) {
    try {
      const result = await resolveAnnotation(config, item.data, annotation);
      annotation.bilingual.englishText = result.englishText || "";
      annotation.bilingual.englishParagraphIndex = typeof result.candidateIndex === "number" ? result.candidateIndex : annotation.bilingual.englishParagraphIndex;
      annotation.bilingual.confidence = normalizeConfidence(result.confidence);
      annotation.bilingual.strategy = `api-${annotation.bilingual.strategy}`;
      annotation.bilingual.needsApiResolution = false;
      annotation.bilingual.warning = result.reason ? `API 对齐：${result.reason}` : null;
      annotation.bilingual.resolvedAt = new Date().toISOString();
      await savePackage(item.filePath, item.data);
      console.log(`已对齐：${item.data.title} / ${annotation.id}`);
    } catch (error) {
      annotation.bilingual.apiError = error instanceof Error ? error.message : String(error);
      annotation.bilingual.apiFailedAt = new Date().toISOString();
      await savePackage(item.filePath, item.data);
      console.error(`对齐失败：${item.data.title} / ${annotation.id} / ${annotation.bilingual.apiError}`);
    }
  }
}

function needsResolution(annotation) {
  return Boolean(
    annotation?.bilingual?.detected &&
    annotation.bilingual.needsApiResolution &&
    Array.isArray(annotation.bilingual.candidates) &&
    annotation.bilingual.candidates.length > 0
  );
}

async function resolveAnnotation(config, data, annotation) {
  const payload = {
    model: config.AI_PRODUCER_MODEL,
    temperature: 0,
    messages: [
      {
        role: "system",
        content: [
          "你负责双语资料的中英文摘录对齐。",
          "用户只高亮了中文译文，需要你从英文候选段里找出最对应的英文原文。",
          "不要解释长篇理由。只输出 JSON。",
          "JSON 字段：englishText, candidateIndex, confidence, reason。",
          "candidateIndex 使用候选里的 index 原值；confidence 只能是 high / medium / low。",
          "如果没有可靠对应，englishText 为空字符串，confidence 为 low。"
        ].join("\n")
      },
      {
        role: "user",
        content: JSON.stringify({
          title: data.title,
          sourcePath: data.sourcePath,
          chineseHighlight: annotation.currentText || annotation.originalText || "",
          chineseParagraph: annotation.bilingual.chineseText || "",
          candidates: annotation.bilingual.candidates
        }, null, 2)
      }
    ]
  };

  const dataJson = await requestProducerText(config, {
    system:payload.messages[0].content, user:payload.messages[1].content
  });
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

async function loadProducerConfig() {
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
