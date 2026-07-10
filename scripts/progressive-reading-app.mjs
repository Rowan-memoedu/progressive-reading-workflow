import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import http from "node:http";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";
import { Readability } from "@mozilla/readability";
import TurndownService from "turndown";
import { gfm } from "turndown-plugin-gfm";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const workflowRoot = path.resolve(__dirname, "..");
const importScript = path.join(__dirname, "import-web-md.mjs");
const rssScript = path.join(__dirname, "rss-workflow.mjs");
const localTranscribeScript = path.join(__dirname, "local-whispercpp-transcribe.py");
const readingRoot = path.join(workflowRoot, "阅读区");
const importsRoot = path.join(workflowRoot, "imports");
const appRunsRoot = path.join(importsRoot, "app-runs");
const browserHighlightRoot = path.join(readingRoot, "浏览器高亮");
const defaultPort = Number(process.env.PROGRESSIVE_READING_APP_PORT || 37829);
const producerConfigDir = path.join(process.env.USERPROFILE || process.env.HOME || "", "Documents", "New project");
const producerConfigKeys = ["AI_PRODUCER_BASE_URL", "AI_PRODUCER_API_KEY", "AI_PRODUCER_MODEL"];
const jobs = new Map();

const browserTurndown = new TurndownService({
  headingStyle: "atx",
  bulletListMarker: "-",
  codeBlockStyle: "fenced"
});
browserTurndown.use(gfm);

function nowIso() {
  return new Date().toISOString();
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function safeName(value, fallback = "untitled") {
  const cleaned = String(value || fallback)
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return (cleaned || fallback).slice(0, 120);
}

function yamlString(value) {
  return JSON.stringify(String(value ?? ""));
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type"
  };
}

function shortHash(value, length = 10) {
  return createHash("sha256").update(String(value || "")).digest("hex").slice(0, length);
}

function normalizeMarkdownText(value, maxChars = 200000) {
  return String(value || "")
    .replace(/\r\n?/g, "\n")
    .replace(/\u0000/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{4,}/g, "\n\n\n")
    .trim()
    .slice(0, maxChars);
}

function highlightMarkdown(value) {
  const text = normalizeMarkdownText(value, 60000).replace(/==/g, "＝");
  return text
    .split(/\n{2,}/)
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => `==${part}==`)
    .join("\n\n");
}

function quoteMarkdown(value) {
  const text = normalizeMarkdownText(value, 8000);
  if (!text) return "";
  return text.split(/\n/).map((line) => `> ${line}`).join("\n");
}

function cleanToolMessage(value) {
  return String(value || "")
    .replace(/[^\S\r\n]+/g, " ")
    .replace(/[^\x09\x0a\x0d\x20-\x7e\u4e00-\u9fff，。；：！？、（）《》“”‘’【】]/g, "")
    .trim();
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

async function readMarkdownProducerConfig() {
  try {
    const entries = await fs.readdir(producerConfigDir, { withFileTypes: true });
    const configFile = entries.find((entry) => entry.isFile() && /^DeepSeek API.*\.md$/i.test(entry.name));
    if (!configFile) return {};
    const text = await fs.readFile(path.join(producerConfigDir, configFile.name), "utf8");
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

async function loadProducerConfig() {
  const config = {};
  for (const key of producerConfigKeys) {
    config[key] = process.env[key] || readWindowsUserEnv(key) || "";
  }

  const markdownConfig = await readMarkdownProducerConfig();
  for (const key of producerConfigKeys) {
    if (!config[key] && markdownConfig[key]) config[key] = markdownConfig[key];
  }

  const missing = producerConfigKeys.filter((key) => !config[key]);
  if (missing.length) throw new Error(`missing_api_config_${missing.join("_")}`);
  return config;
}

function chatCompletionsUrl(baseUrl) {
  const trimmed = String(baseUrl || "").replace(/\/+$/, "");
  if (/\/chat\/completions$/i.test(trimmed)) return trimmed;
  return `${trimmed}/chat/completions`;
}

function stripModelFences(text) {
  return String(text || "")
    .trim()
    .replace(/^```(?:json|markdown|md)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
}

function extractUrls(text) {
  const matches = String(text || "").match(/https?:\/\/[^\s<>"'，。；、）)]+/g) || [];
  const seen = new Set();
  const urls = [];
  for (const raw of matches) {
    const url = raw.replace(/[，。；;、)）]+$/g, "");
    if (!seen.has(url)) {
      seen.add(url);
      urls.push(url);
    }
  }
  return urls;
}

function instructionFromText(text, urls) {
  let instruction = String(text || "");
  for (const url of urls) {
    instruction = instruction.replaceAll(url, " ");
  }
  return instruction.replace(/\s+/g, " ").trim();
}

function classifyUrl(url) {
  try {
    if (isWechatUrl(url)) return "wechat";
    if (isYouTubeUrl(url)) return "youtube";
    if (isBilibiliUrl(url)) return "bilibili";
    return "web";
  } catch {
    return "web";
  }
}

function fallbackIntent(instruction, urls, reason = "") {
  const text = String(instruction || "");
  const wantsNoGuide = /不要.*导读|无需.*导读|no\s+guide/i.test(text);
  const wantsBilingual = /双语|英文附录|中英|bilingual|English Appendix/i.test(text);
  const wantsExternalLinks = /外链|链接.*也.*导入|递归|include.*links/i.test(text);
  const directOnly = /只需要.*直接阅读|只要.*可读|不要.*外链|direct.*only/i.test(text);
  return {
    schema: "progressive-reading-import-intent/v1",
    source: reason ? "fallback_after_ai_error" : "fallback_rules",
    parseError: reason || "",
    action: "import_reading_material",
    outputTarget: "reading_area",
    urlCount: urls.length,
    urlTypes: [...new Set(urls.map(classifyUrl))],
    processing: {
      generateReadingGuide: !wantsNoGuide,
      cleanMarkdown: true,
      preserveOriginal: true,
      languageMode: wantsBilingual ? "zh_main_en_appendix" : "source_body_with_chinese_guide",
      guideStyle: "core_insights_value_density_pain_points_urgency",
      linkPolicy: wantsExternalLinks && !directOnly ? "include_direct_readable_external_links" : "direct_urls_only"
    },
    userNotes: text,
    warnings: reason ? [`AI 意图解析失败，已按默认规则继续：${reason}`] : []
  };
}

function normalizeIntent(candidate, instruction, urls) {
  const fallback = fallbackIntent(instruction, urls);
  const value = candidate && typeof candidate === "object" ? candidate : {};
  const processing = value.processing && typeof value.processing === "object" ? value.processing : {};
  const allowedLanguageModes = new Set(["source_body_with_chinese_guide", "zh_main_en_appendix", "zh_only"]);
  const allowedLinkPolicies = new Set(["direct_urls_only", "include_direct_readable_external_links", "skip_external_links"]);
  const intent = {
    ...fallback,
    source: value.source || "deepseek",
    action: value.action === "import_reading_material" ? value.action : fallback.action,
    outputTarget: value.outputTarget === "reading_area" ? value.outputTarget : fallback.outputTarget,
    urlCount: urls.length,
    urlTypes: [...new Set(urls.map(classifyUrl))],
    processing: {
      ...fallback.processing,
      generateReadingGuide: typeof processing.generateReadingGuide === "boolean" ? processing.generateReadingGuide : fallback.processing.generateReadingGuide,
      cleanMarkdown: processing.cleanMarkdown !== false,
      preserveOriginal: processing.preserveOriginal !== false,
      languageMode: allowedLanguageModes.has(processing.languageMode) ? processing.languageMode : fallback.processing.languageMode,
      guideStyle: String(processing.guideStyle || fallback.processing.guideStyle).slice(0, 160),
      linkPolicy: allowedLinkPolicies.has(processing.linkPolicy) ? processing.linkPolicy : fallback.processing.linkPolicy
    },
    userNotes: String(value.userNotes || instruction || "").slice(0, 2000),
    warnings: Array.isArray(value.warnings) ? value.warnings.map((item) => String(item).slice(0, 300)).slice(0, 8) : []
  };
  if (fallback.processing.languageMode === "zh_main_en_appendix") {
    intent.processing.languageMode = "zh_main_en_appendix";
  }
  if (fallback.processing.linkPolicy !== "direct_urls_only") {
    intent.processing.linkPolicy = fallback.processing.linkPolicy;
  }
  if (fallback.processing.generateReadingGuide === false) {
    intent.processing.generateReadingGuide = false;
  }
  return intent;
}

async function parseImportIntent({ instruction, urls }) {
  if (!String(instruction || "").trim()) return fallbackIntent("", urls);
  const classifiedUrls = urls.map((url) => ({ url, type: classifyUrl(url) }));
  const prompt = [
    "你要把用户在本地渐进阅读导入网页中输入的自然语言要求解析成结构化 JSON。",
    "你只负责理解意图，不执行文件操作，不添加外部事实，不决定不存在的能力。",
    "返回必须是纯 JSON 对象，不要 Markdown，不要解释。",
    "",
    "JSON schema:",
    JSON.stringify({
      schema: "progressive-reading-import-intent/v1",
      action: "import_reading_material",
      outputTarget: "reading_area",
      processing: {
        generateReadingGuide: true,
        cleanMarkdown: true,
        preserveOriginal: true,
        languageMode: "source_body_with_chinese_guide | zh_main_en_appendix | zh_only",
        guideStyle: "core_insights_value_density_pain_points_urgency",
        linkPolicy: "direct_urls_only | include_direct_readable_external_links | skip_external_links"
      },
      userNotes: "保留用户额外要求的中文短句",
      warnings: ["如果用户要求当前系统不支持的事情，在这里写明"]
    }, null, 2),
    "",
    "当前系统能力边界：",
    "- 可以导入用户直接提供的 URL。",
    "- 可以生成阅读前置卡。",
    "- 可以把微信和普通网页输出为阅读区 Markdown。",
    "- 视频工作流当前暂停，不要承诺视频转写。",
    "- 不绕过登录、验证码、权限墙。",
    "- AI 只负责解析意图和生成导读，文件写入由本地代码完成。",
    "",
    "用户输入中识别到的 URL：",
    JSON.stringify(classifiedUrls, null, 2),
    "",
    "URL 之外的自然语言要求：",
    instruction || "无"
  ].join("\n");

  try {
    const config = await loadProducerConfig();
    const response = await fetch(chatCompletionsUrl(config.AI_PRODUCER_BASE_URL), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${config.AI_PRODUCER_API_KEY}`
      },
      body: JSON.stringify({
        model: config.AI_PRODUCER_MODEL,
        temperature: 0,
        messages: [
          { role: "system", content: "你是本地导入工具的意图解析器，只输出可解析 JSON。" },
          { role: "user", content: prompt }
        ]
      }),
      signal: AbortSignal.timeout(120000)
    });
    if (!response.ok) throw new Error(`api_${response.status}_${(await response.text()).slice(0, 300)}`);
    const data = await response.json();
    const parsed = JSON.parse(stripModelFences(data?.choices?.[0]?.message?.content || ""));
    return normalizeIntent({ ...parsed, source: "deepseek" }, instruction, urls);
  } catch (error) {
    return fallbackIntent(instruction, urls, error.message);
  }
}

function importerInstruction(job) {
  const parts = [];
  if (job.intent) {
    parts.push("结构化导入意图：");
    parts.push(JSON.stringify(job.intent, null, 2));
  }
  if (job.instruction) {
    parts.push("用户原始补充要求：");
    parts.push(job.instruction);
  }
  return parts.join("\n\n").trim();
}

function isWechatUrl(url) {
  return new URL(url).hostname === "mp.weixin.qq.com";
}

function isYouTubeUrl(url) {
  const host = new URL(url).hostname.replace(/^www\./, "");
  return host === "youtube.com" || host === "youtu.be" || host.endsWith(".youtube.com");
}

function isBilibiliUrl(url) {
  const host = new URL(url).hostname.replace(/^www\./, "");
  return host === "bilibili.com" || host.endsWith(".bilibili.com") || host === "b23.tv";
}

function bvFromUrl(url) {
  const match = String(url).match(/BV[0-9A-Za-z]+/);
  return match?.[0] || "";
}

function toolExe(name) {
  const home = process.env.USERPROFILE || process.env.HOME || "";
  const venvScripts = path.join(home, ".agent-reach-venv", "Scripts");
  const exe = path.join(venvScripts, `${name}.exe`);
  return exe;
}

function bvFromInfo(info, url) {
  return info?.id || bvFromUrl(url);
}

function publicJob(job) {
  return {
    id: job.id,
    status: job.status,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    instruction: job.instruction,
    intent: job.intent || null,
    urls: job.urls,
    runDir: job.runDir,
    outputs: job.outputs,
    failures: job.failures,
    logs: job.logs
  };
}

async function writeJob(job) {
  if (!job.runDir) return;
  await fs.mkdir(job.runDir, { recursive: true });
  await fs.writeFile(path.join(job.runDir, "run.json"), `${JSON.stringify(publicJob(job), null, 2)}\n`, "utf8");
}

async function log(job, message) {
  job.logs.push({ at: nowIso(), message });
  job.updatedAt = nowIso();
  await writeJob(job);
}

function runProcess(command, args, { cwd = workflowRoot, timeoutMs = 600000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd, windowsHide: true });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      stderr += `\nTIMEOUT after ${timeoutMs}ms`;
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: `${stderr}\n${error.message}` });
    });
  });
}

function parseSummary(stdout) {
  const match = String(stdout || "").match(/(\[\s*\{[\s\S]*\}\s*\])\s*$/);
  if (!match) return null;
  try {
    return JSON.parse(match[1]);
  } catch {
    return null;
  }
}

function isSuccessfulImportItem(item) {
  return item?.status === "imported" || item?.status === "partial";
}

function outputDetails(item) {
  const details = [];
  if (typeof item.files === "number") details.push(`文件 ${item.files}`);
  if (typeof item.skipped === "number") details.push(`跳过 ${item.skipped}`);
  if (typeof item.failures === "number" && item.failures > 0) details.push(`失败 ${item.failures}`);
  if (item.method) details.push(item.method);
  return details.join(" / ");
}

function parseJsonOutput(stdout) {
  const text = String(stdout || "").trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    const objectStart = text.indexOf("{");
    const objectEnd = text.lastIndexOf("}");
    if (objectStart >= 0 && objectEnd > objectStart) {
      try {
        return JSON.parse(text.slice(objectStart, objectEnd + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}

async function runRssCli(args, { timeoutMs = 900000 } = {}) {
  const result = await runProcess(process.execPath, [rssScript, ...args, "--json"], { timeoutMs });
  const parsed = parseJsonOutput(result.stdout);
  if (result.code !== 0) {
    const detail = parsed || { error: result.stderr || result.stdout || `rss_cli_exit_${result.code}` };
    throw new Error(JSON.stringify(detail));
  }
  return parsed || { stdout: result.stdout, stderr: result.stderr };
}

async function writeFailureReport({ dir, url, stage, reason, detail = "" }) {
  await fs.mkdir(dir, { recursive: true });
  const target = path.join(dir, `FAILED ${safeName(new URL(url).hostname)} ${safeName(url).slice(0, 60)}.md`);
  const body = [
    "---",
    `source_url: ${yamlString(url)}`,
    `imported_at: ${yamlString(nowIso())}`,
    "import_method: app_import_failed",
    "status: failed",
    `failure_stage: ${yamlString(stage)}`,
    `failure_reason: ${yamlString(reason)}`,
    "---",
    "",
    "# Import failed",
    "",
    `- URL: ${url}`,
    `- Stage: ${stage}`,
    `- Reason: ${reason}`,
    detail ? `- Detail: ${detail}` : "",
    ""
  ].filter(Boolean).join("\n");
  await fs.writeFile(target, body, "utf8");
  return target;
}

async function browserHighlightTarget(sourceUrl, title) {
  const parsed = new URL(sourceUrl);
  const suffix = `--网页全文高亮--${shortHash(parsed.href)}.md`;
  const entries = await fs.readdir(browserHighlightRoot, { withFileTypes: true }).catch(() => []);
  const existing = entries.find((entry) => entry.isFile() && entry.name.endsWith(suffix));
  if (existing) return path.join(browserHighlightRoot, existing.name);
  const base = safeName(title || parsed.hostname || "browser-highlight");
  return path.join(browserHighlightRoot, `${base}${suffix}`);
}

function isAbsoluteOrSpecialLink(target) {
  return /^(?:[a-z][a-z0-9+.-]*:|#|\/)/i.test(target);
}

function absolutizeMarkdownLinks(markdown, baseUrl) {
  return String(markdown || "").replace(/(!?\[[^\]]*?\]\()([^) \t\n]+)(\))/g, (match, prefix, target, suffix) => {
    if (isAbsoluteOrSpecialLink(target)) return match;
    try {
      return `${prefix}${new URL(target, baseUrl).href}${suffix}`;
    } catch {
      return match;
    }
  });
}

function unwrapElement(element) {
  const parent = element.parentNode;
  if (!parent) return;
  while (element.firstChild) parent.insertBefore(element.firstChild, element);
  parent.removeChild(element);
  if (typeof parent.normalize === "function") parent.normalize();
}

function cleanBrowserCaptureDocument(document) {
  document.querySelectorAll("#local-ir-browser-toast").forEach((element) => element.remove());
  document.querySelectorAll(".local-ir-browser-highlight").forEach((element) => unwrapElement(element));
}

function pageTextToMarkdown(pageText) {
  return normalizeMarkdownText(pageText, 300000)
    .split(/\n{2,}/)
    .map((part) => part.trim())
    .filter(Boolean)
    .join("\n\n");
}

function browserPageToMarkdown({ html, pageText, sourceUrl, title }) {
  if (html) {
    try {
      const dom = new JSDOM(html, { url: sourceUrl });
      cleanBrowserCaptureDocument(dom.window.document);
      const article = new Readability(dom.window.document).parse();
      if (article?.content && article?.textContent?.trim().length >= 80) {
        return {
          method: "readability_html",
          title: article.title || title,
          markdown: absolutizeMarkdownLinks(browserTurndown.turndown(article.content).trim(), sourceUrl)
        };
      }
    } catch {
      // Fall back to page text below.
    }
  }

  const fallbackMarkdown = pageTextToMarkdown(pageText);
  if (!fallbackMarkdown) throw new Error("empty_page_content");
  return {
    method: "page_text_fallback",
    title,
    markdown: fallbackMarkdown
  };
}

function browserHighlightFrontmatter({ sourceUrl, title, createdAt, updatedAt, conversionMethod }) {
  return [
    "---",
    `source_url: ${yamlString(sourceUrl)}`,
    `source_title: ${yamlString(title)}`,
    `imported_at: ${yamlString(createdAt)}`,
    `updated_at: ${yamlString(updatedAt || createdAt)}`,
    "import_method: browser_page_highlight",
    "highlight_mode: full_page",
    `conversion_method: ${yamlString(conversionMethod)}`,
    "status: imported",
    "---",
    "",
    `# ${title || new URL(sourceUrl).hostname}`,
    "",
    `Source: [${sourceUrl}](${sourceUrl})`,
    ""
  ].join("\n");
}

function browserPageHighlightDocument({ sourceUrl, title, createdAt, converted }) {
  const effectiveTitle = converted.title || title || new URL(sourceUrl).hostname;
  const frontmatter = browserHighlightFrontmatter({
    sourceUrl,
    title: effectiveTitle,
    createdAt,
    updatedAt: createdAt,
    conversionMethod: converted.method
  });
  const body = normalizeMarkdownText(converted.markdown || "", 300000);
  return `${frontmatter}\n${body}\n`;
}

function browserHighlightEntry(payload) {
  const selected = highlightMarkdown(payload.selectionText);
  const context = quoteMarkdown(payload.context || "");
  const lines = [
    `### ${payload.createdAt}`,
    "",
    selected,
    "",
    `- Source URL: ${payload.url}`,
    payload.title ? `- Page title: ${payload.title}` : "",
    payload.sourceId ? `- Browser highlight id: ${payload.sourceId}` : "",
    context ? "" : "",
    context ? "Context:" : "",
    context,
    ""
  ];
  return lines.filter((line) => line !== "").join("\n");
}

function normalizedIndex(value) {
  const text = String(value || "");
  const chars = [];
  const map = [];
  let previousWasSpace = true;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (/\s/.test(char)) {
      if (!previousWasSpace) {
        chars.push(" ");
        map.push(i);
        previousWasSpace = true;
      }
    } else {
      chars.push(char);
      map.push(i);
      previousWasSpace = false;
    }
  }
  while (chars.length && chars[chars.length - 1] === " ") {
    chars.pop();
    map.pop();
  }
  return { text: chars.join(""), map };
}

function findNormalizedRange(haystack, needle) {
  const cleanNeedle = normalizeMarkdownText(needle || "", 60000);
  if (!cleanNeedle) return null;

  const exactIndex = haystack.indexOf(cleanNeedle);
  if (exactIndex >= 0) return { start: exactIndex, end: exactIndex + cleanNeedle.length };

  const normalizedHaystack = normalizedIndex(haystack);
  const normalizedNeedle = normalizedIndex(cleanNeedle);
  if (!normalizedNeedle.text) return null;
  const normalizedIndexOfNeedle = normalizedHaystack.text.indexOf(normalizedNeedle.text);
  if (normalizedIndexOfNeedle < 0) return null;

  const normalizedEnd = normalizedIndexOfNeedle + normalizedNeedle.text.length - 1;
  const start = normalizedHaystack.map[normalizedIndexOfNeedle];
  const end = normalizedHaystack.map[normalizedEnd] + 1;
  if (!Number.isInteger(start) || !Number.isInteger(end) || end <= start) return null;
  return { start, end };
}

function trimMarkdownRange(markdown, range) {
  let { start, end } = range;
  while (start < end && /\s/.test(markdown[start])) start += 1;
  while (end > start && /\s/.test(markdown[end - 1])) end -= 1;
  return { start, end };
}

function isRangeAlreadyHighlighted(markdown, range) {
  const { start, end } = range;
  if (markdown.slice(Math.max(0, start - 2), start) === "==" && markdown.slice(end, end + 2) === "==") return true;
  const markersBeforeStart = (markdown.slice(0, start).match(/==/g) || []).length;
  const markersBeforeEnd = (markdown.slice(0, end).match(/==/g) || []).length;
  return markersBeforeStart % 2 === 1 && markersBeforeEnd % 2 === 1;
}

function wrapMarkdownHighlightRange(value) {
  return String(value || "")
    .split(/(\n{2,})/)
    .map((part) => {
      if (!part || /^\n{2,}$/.test(part) || !part.trim()) return part;
      const match = part.match(/^(\s*)([\s\S]*?)(\s*)$/);
      const leading = match?.[1] || "";
      const body = (match?.[2] || part).replace(/==/g, "＝");
      const trailing = match?.[3] || "";
      return `${leading}==${body}==${trailing}`;
    })
    .join("");
}

function findHighlightRange(markdown, selectionText, context) {
  if (context) {
    const contextRange = findNormalizedRange(markdown, context);
    if (contextRange) {
      const selectedInsideContext = findNormalizedRange(markdown.slice(contextRange.start, contextRange.end), selectionText);
      if (selectedInsideContext) {
        return {
          start: contextRange.start + selectedInsideContext.start,
          end: contextRange.start + selectedInsideContext.end
        };
      }
    }
  }
  return findNormalizedRange(markdown, selectionText);
}

function applyInlineBrowserHighlight(markdown, payload) {
  const range = findHighlightRange(markdown, payload.selectionText, payload.context);
  if (!range) return { markdown, highlightStatus: "unlocated" };

  const trimmed = trimMarkdownRange(markdown, range);
  if (trimmed.end <= trimmed.start) return { markdown, highlightStatus: "unlocated" };
  if (isRangeAlreadyHighlighted(markdown, trimmed)) {
    return { markdown, highlightStatus: "already_highlighted" };
  }

  return {
    markdown: `${markdown.slice(0, trimmed.start)}${wrapMarkdownHighlightRange(markdown.slice(trimmed.start, trimmed.end))}${markdown.slice(trimmed.end)}`,
    highlightStatus: "inline_highlighted"
  };
}

function appendUnlocatedHighlight(markdown, payload) {
  const sectionHeading = "## 未定位高亮";
  const prefix = markdown.includes(sectionHeading) ? "" : `\n\n${sectionHeading}\n`;
  const sourceIdLine = payload.sourceId ? `\n- Browser highlight id: ${payload.sourceId}` : "";
  const context = quoteMarkdown(payload.context || "");
  const entry = [
    prefix,
    `\n### ${payload.createdAt}`,
    "",
    highlightMarkdown(payload.selectionText),
    sourceIdLine,
    context ? "\nContext:" : "",
    context
  ].filter((line) => line !== "").join("\n");
  return `${markdown.trimEnd()}\n${entry}\n`;
}

function updateFrontmatterFields(markdown, fields) {
  if (!markdown.startsWith("---\n")) return markdown;
  const end = markdown.indexOf("\n---", 4);
  if (end < 0) return markdown;
  const lines = markdown.slice(4, end).split("\n");
  for (const [key, value] of Object.entries(fields)) {
    const line = `${key}: ${yamlString(value)}`;
    const index = lines.findIndex((existing) => existing.startsWith(`${key}:`));
    if (index >= 0) {
      lines[index] = line;
    } else {
      lines.push(line);
    }
  }
  return `---\n${lines.join("\n")}${markdown.slice(end)}`;
}

async function writeBrowserHighlightCapture(rawPayload) {
  const payload = {
    url: String(rawPayload?.url || "").trim(),
    title: String(rawPayload?.title || "").trim(),
    selectionText: normalizeMarkdownText(rawPayload?.selectionText || "", 60000),
    context: normalizeMarkdownText(rawPayload?.context || "", 8000),
    pageText: normalizeMarkdownText(rawPayload?.pageText || "", 300000),
    html: normalizeMarkdownText(rawPayload?.html || "", 1000000),
    createdAt: String(rawPayload?.createdAt || nowIso()),
    sourceId: String(rawPayload?.sourceId || "").trim()
  };

  let parsed;
  try {
    parsed = new URL(payload.url);
  } catch {
    throw new Error("invalid_url");
  }
  if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("unsupported_url_protocol");
  if (!payload.selectionText) throw new Error("empty_selection");

  await fs.mkdir(browserHighlightRoot, { recursive: true });
  const target = await browserHighlightTarget(parsed.href, payload.title);
  const exists = await fs.stat(target).then(() => true).catch(() => false);
  let markdown;
  let conversionMethod = "existing_file";

  if (!exists) {
    const converted = browserPageToMarkdown({
      html: payload.html,
      pageText: payload.pageText,
      sourceUrl: parsed.href,
      title: payload.title
    });
    conversionMethod = converted.method;
    markdown = browserPageHighlightDocument({
      sourceUrl: parsed.href,
      title: payload.title,
      createdAt: payload.createdAt,
      converted
    });
  } else {
    markdown = await fs.readFile(target, "utf8");
  }

  const applied = applyInlineBrowserHighlight(markdown, { ...payload, url: parsed.href });
  markdown = applied.highlightStatus === "unlocated"
    ? appendUnlocatedHighlight(applied.markdown, { ...payload, url: parsed.href })
    : applied.markdown;
  markdown = updateFrontmatterFields(markdown, { updated_at: payload.createdAt });
  if (!exists) {
    markdown = updateFrontmatterFields(markdown, { conversion_method: conversionMethod });
  }
  await fs.writeFile(target, markdown.endsWith("\n") ? markdown : `${markdown}\n`, "utf8");

  return {
    status: "captured",
    mode: "full_page",
    target,
    sourceUrl: parsed.href,
    title: payload.title,
    selectedChars: payload.selectionText.length,
    highlightStatus: applied.highlightStatus,
    conversionMethod
  };
}

async function moveWebFailures(results, failureDir) {
  await fs.mkdir(failureDir, { recursive: true });
  for (const result of results) {
    if (result.status !== "failed" || !result.target) continue;
    try {
      const target = path.resolve(result.target);
      const moved = path.join(failureDir, path.basename(target));
      await fs.rename(target, moved);
      result.target = moved;
    } catch (error) {
      result.moveFailureReportError = error.message;
    }
  }
}

async function importWechat(job, urls, runName) {
  const outDir = path.join(readingRoot, "微信", runName);
  const stagingDir = path.join(job.runDir, "wechat");
  await log(job, `微信导入开始：${urls.length} 个链接`);
  const args = [
    importScript,
    "--guided-wechat",
    ...urls,
    "--out",
    outDir,
    "--staging",
    stagingDir
  ];
  const instruction = importerInstruction(job);
  if (instruction) args.push("--instruction", instruction);
  const result = await runProcess(process.execPath, args);
  await fs.writeFile(path.join(stagingDir, "command.stdout.txt"), result.stdout, "utf8").catch(() => {});
  await fs.writeFile(path.join(stagingDir, "command.stderr.txt"), result.stderr, "utf8").catch(() => {});
  const summary = parseSummary(result.stdout) || [];
  for (const item of summary) {
    if (isSuccessfulImportItem(item)) job.outputs.push(item);
    else job.failures.push(item);
  }
  if (result.code !== 0 && summary.length === 0) {
    job.failures.push({ status: "failed", stage: "command", reason: result.stderr || `exit_${result.code}` });
  }
  await log(job, `微信导入完成：成功 ${summary.filter(isSuccessfulImportItem).length}，失败 ${summary.filter((item) => !isSuccessfulImportItem(item)).length}`);
}

async function importWeb(job, urls, runName) {
  const outDir = path.join(readingRoot, "网页", runName);
  const failureDir = path.join(job.runDir, "web-failures");
  await log(job, `普通网页导入开始：${urls.length} 个链接`);
  const args = [importScript, ...urls, "--out", outDir];
  const instruction = importerInstruction(job);
  if (instruction) args.push("--instruction", instruction);
  const result = await runProcess(process.execPath, args);
  await fs.mkdir(path.join(job.runDir, "web"), { recursive: true });
  await fs.writeFile(path.join(job.runDir, "web", "command.stdout.txt"), result.stdout, "utf8");
  await fs.writeFile(path.join(job.runDir, "web", "command.stderr.txt"), result.stderr, "utf8");
  const summary = parseSummary(result.stdout) || [];
  await moveWebFailures(summary, failureDir);
  for (const item of summary) {
    if (isSuccessfulImportItem(item)) job.outputs.push(item);
    else job.failures.push(item);
  }
  if (result.code !== 0 && summary.length === 0) {
    const target = await writeFailureReport({
      dir: failureDir,
      url: urls[0],
      stage: "command",
      reason: result.stderr || `exit_${result.code}`
    });
    job.failures.push({ url: urls[0], status: "failed", stage: "command", reason: result.stderr || `exit_${result.code}`, target });
  }
  await log(job, `普通网页导入完成：成功 ${summary.filter(isSuccessfulImportItem).length}，失败 ${summary.filter((item) => !isSuccessfulImportItem(item)).length}`);
}

async function readAgentReachDoctor(job) {
  const result = await runProcess(toolExe("agent-reach"), ["doctor", "--json"], { timeoutMs: 180000 });
  await fs.mkdir(path.join(job.runDir, "tool-health"), { recursive: true });
  await fs.writeFile(path.join(job.runDir, "tool-health", "agent-reach-doctor.json"), result.stdout || result.stderr, "utf8");
  if (result.code !== 0) throw new Error(result.stderr || "agent_reach_doctor_failed");
  return JSON.parse(result.stdout);
}

function cleanVtt(text) {
  const lines = [];
  const seen = new Set();
  for (const raw of String(text || "").split(/\r?\n/)) {
    const line = raw
      .replace(/<[^>]+>/g, "")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/\s+/g, " ")
      .trim();
    if (!line) continue;
    if (/^(WEBVTT|Kind:|Language:)/i.test(line)) continue;
    if (/^\d+$/.test(line)) continue;
    if (/-->|align:|position:|line:/i.test(line)) continue;
    if (seen.has(line)) continue;
    seen.add(line);
    lines.push(line);
  }
  return lines.join("\n\n");
}

function transcriptForGuide(transcript, maxChars = 50000) {
  return String(transcript || "")
    .replace(/\n{3,}/g, "\n\n")
    .slice(0, maxChars);
}

function mathLikeVideo(info, transcript) {
  const source = [
    info?.title,
    Array.isArray(info?.tags) ? info.tags.join(" ") : "",
    info?.description,
    transcript
  ].join("\n");
  return /数学|线性代数|高等数学|微积分|概率|统计|证明|推导|公式|矩阵|向量|空间|变换|特征值|math|algebra|calculus|matrix|vector|proof|theorem|linear/i.test(source);
}

async function callDeepSeekForVideoGuide({ info, url, transcript, instruction = "" }) {
  const isMath = mathLikeVideo(info, transcript);
  const prompt = [
    "你要为一个即将进入渐进阅读流程的视频转录稿生成“阅读前置卡”。",
    "它不是普通摘要，不要复述全文，不要补充外部事实。目标是帮助读者判断这段材料是否值得读、如何抓核心、如何沉淀成 RemNote 卡片。",
    isMath
      ? "这是一类数理/技术内容，请特别关注概念定义、数学对象、直觉解释、符号/例子、推导关系、常见误解和卡片化沉淀。"
      : "如果内容不是数理材料，也要保持高密度、判断型导读。",
    "",
    "必须输出 Markdown，且严格使用这些标题：",
    "## 阅读前置卡",
    "### 一句话核心",
    "### 核心洞见",
    "### 数理学习抓手",
    "### 对我的价值判断",
    "### 信息密度判断",
    "### 能解决我的什么痛点",
    "### 具体用处",
    "### 是否急需阅读",
    "",
    "具体要求：",
    "- “一句话核心”只写 1 句话。",
    "- “核心洞见”列 3-6 条，提炼最重要的概念、模型、解释路径或判断。",
    "- “数理学习抓手”必须列出：核心数学对象、前置知识、关键例子/图像直觉、需要警惕的误解；如果视频不是数理内容，也说明“不适用”并给出理由。",
    "- “对我的价值判断”给 高 / 中 / 低 / 跳过 之一，结合读者正在搭建 RemNote、Codex、渐进阅读、AI 工作流和教育科技系统的背景判断。",
    "- “信息密度判断”给 高 / 中 / 低 之一，说明密度来自概念澄清、推导结构、例子、学习策略，还是只是泛泛科普。",
    "- “能解决我的什么痛点”列 2-5 条，必须具体到学习、课程/讲义、卡片化、渐进阅读或教育产品。",
    "- “具体用处”列 2-5 条，说明可沉淀为哪些 RemNote 卡片、课程片段、讲义解释或学习路径。",
    "- “是否急需阅读”给 急需 / 近期 / 可延后 / 可跳过 之一，并给一句理由。",
    "- 不要输出 YAML，不要输出代码块，不要写空泛鼓励。",
    "",
    "用户本次导入补充要求：",
    instruction.trim() || "无",
    "",
    `标题：${info?.title || ""}`,
    `链接：${url}`,
    `频道：${info?.channel || info?.uploader || ""}`,
    `时长：${info?.duration_string || info?.duration || ""}`,
    "",
    "转录稿：",
    transcriptForGuide(transcript)
  ].join("\n");

  const config = await loadProducerConfig();
  const response = await fetch(chatCompletionsUrl(config.AI_PRODUCER_BASE_URL), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${config.AI_PRODUCER_API_KEY}`
    },
    body: JSON.stringify({
      model: config.AI_PRODUCER_MODEL,
      temperature: 0.15,
      messages: [
        {
          role: "system",
          content: "你是面向渐进阅读和数理学习的导读编辑。只生成读前价值判断和学习抓手，不新增外部事实。"
        },
        { role: "user", content: prompt }
      ]
    }),
    signal: AbortSignal.timeout(180000)
  });
  if (!response.ok) throw new Error(`api_${response.status}_${(await response.text()).slice(0, 500)}`);
  const data = await response.json();
  const guide = stripModelFences(data?.choices?.[0]?.message?.content || "");
  validateVideoGuide(guide);
  return guide;
}

function validateVideoGuide(guide) {
  const required = [
    "## 阅读前置卡",
    "### 一句话核心",
    "### 核心洞见",
    "### 数理学习抓手",
    "### 对我的价值判断",
    "### 信息密度判断",
    "### 能解决我的什么痛点",
    "### 具体用处",
    "### 是否急需阅读"
  ];
  const missing = required.filter((heading) => !guide.includes(heading));
  if (missing.length) throw new Error(`video_guide_missing_sections_${missing.join("_")}`);
  if (guide.length < 450) throw new Error("video_guide_too_short");
}

function preferredVtt(files) {
  const preference = ["zh-Hans", "zh", "en"];
  return files.sort((a, b) => {
    const ap = preference.findIndex((part) => a.includes(part));
    const bp = preference.findIndex((part) => b.includes(part));
    return (ap === -1 ? 99 : ap) - (bp === -1 ? 99 : bp);
  })[0];
}

async function listFilesRecursive(dir, suffix) {
  const found = [];
  async function walk(current) {
    let entries = [];
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.name.endsWith(suffix)) found.push(full);
    }
  }
  await walk(dir);
  return found;
}

async function listAudioFiles(dir) {
  const found = [];
  const extensions = new Set([".mp3", ".m4a", ".wav", ".webm", ".opus", ".flac", ".m4s"]);
  async function walk(current) {
    let entries = [];
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (extensions.has(path.extname(entry.name).toLowerCase())) found.push(full);
    }
  }
  await walk(dir);
  return found;
}

function preferAudioFile(files) {
  const priority = [".mp3", ".m4a", ".wav", ".webm", ".opus", ".flac", ".m4s"];
  return files.sort((a, b) => {
    const ap = priority.indexOf(path.extname(a).toLowerCase());
    const bp = priority.indexOf(path.extname(b).toLowerCase());
    return (ap === -1 ? 99 : ap) - (bp === -1 ? 99 : bp);
  })[0];
}

async function transcribeLocal(audioPath, stageDir, baseName, language = "zh") {
  const transcriptPath = path.join(stageDir, `${safeName(baseName)}.local-whispercpp.txt`);
  const jsonPath = path.join(stageDir, `${safeName(baseName)}.local-whispercpp.json`);
  const result = await runProcess("py", [
    "-3",
    localTranscribeScript,
    audioPath,
    "--out",
    transcriptPath,
    "--json",
    jsonPath,
    "--language",
    language,
    "--threads",
    process.env.PROGRESSIVE_READING_WHISPER_THREADS || "1",
    "--chunk-seconds",
    process.env.PROGRESSIVE_READING_WHISPER_CHUNK_SECONDS || "45",
    "--work-name",
    safeName(baseName)
  ], { timeoutMs: 7200000 });
  await fs.writeFile(path.join(stageDir, `${safeName(baseName)}.local-whispercpp.stdout.txt`), result.stdout, "utf8");
  await fs.writeFile(path.join(stageDir, `${safeName(baseName)}.local-whispercpp.stderr.txt`), result.stderr, "utf8");
  if (result.code !== 0) {
    throw new Error(cleanToolMessage(result.stderr || result.stdout || `local_whispercpp_exit_${result.code}`));
  }
  return {
    transcriptPath,
    jsonPath,
    transcript: await fs.readFile(transcriptPath, "utf8")
  };
}

async function writeVideoReadingFile({ job, info, url, runName, transcript, transcriptSource, transcriptPath, guide, guidePath }) {
  const outDir = path.join(readingRoot, "视频", runName);
  await fs.mkdir(outDir, { recursive: true });
  const target = path.join(outDir, `${safeName(info.title || info.id || "video")}.md`);
  const body = [
    "---",
    `source_url: ${yamlString(url)}`,
    `source_title: ${yamlString(info.title || "")}`,
    `imported_at: ${yamlString(nowIso())}`,
    `import_method: ${yamlString(`agent_reach_video_${transcriptSource}+deepseek_reading_guide`)}`,
    "status: imported",
    `transcript_source: ${yamlString(transcriptSource)}`,
    `transcript_file: ${yamlString(transcriptPath)}`,
    guidePath ? `guide_file: ${yamlString(guidePath)}` : null,
    "---",
    "",
    "<!-- reading-guide:start -->",
    "",
    guide.trim(),
    "",
    "<!-- reading-guide:end -->",
    "",
    "---",
    "",
    `# ${info.title || url}`,
    "",
    "## 转录稿",
    "",
    transcript.trim(),
    ""
  ].filter((line) => line !== null).join("\n");
  await fs.writeFile(target, body, "utf8");
  job.outputs.push({ url, status: "imported", method: `agent_reach_video_${transcriptSource}`, target, transcript: transcriptPath, guide: guidePath });
}

async function importYouTube(job, url, runName, doctor) {
  const stageDir = path.join(job.runDir, "video", safeName(url));
  const failureDir = path.join(job.runDir, "video-failures");
  await fs.mkdir(stageDir, { recursive: true });
  if (doctor.youtube?.status !== "ok") {
    const target = await writeFailureReport({ dir: failureDir, url, stage: "video_backend", reason: doctor.youtube?.message || "youtube_backend_unavailable" });
    job.failures.push({ url, status: "failed", stage: "video_backend", reason: "youtube_backend_unavailable", target });
    return;
  }

  const meta = await runProcess(toolExe("yt-dlp"), ["--dump-json", "--skip-download", url], { timeoutMs: 180000 });
  await fs.writeFile(path.join(stageDir, "yt-dlp.metadata.json"), meta.stdout || meta.stderr, "utf8");
  if (meta.code !== 0) {
    const target = await writeFailureReport({ dir: failureDir, url, stage: "video_metadata", reason: meta.stderr || `exit_${meta.code}` });
    job.failures.push({ url, status: "failed", stage: "video_metadata", reason: meta.stderr || `exit_${meta.code}`, target });
    return;
  }

  const info = JSON.parse(meta.stdout);
  const outputTemplate = path.join(stageDir, `${safeName(info.id || "youtube")}.%(ext)s`);
  const subtitle = await runProcess(toolExe("yt-dlp"), [
    "--write-sub",
    "--write-auto-sub",
    "--sub-lang",
    "zh-Hans,zh,en",
    "--skip-download",
    "--no-warnings",
    "-o",
    outputTemplate,
    url
  ], { timeoutMs: 240000 });
  await fs.writeFile(path.join(stageDir, "yt-dlp.subtitles.stdout.txt"), subtitle.stdout, "utf8");
  await fs.writeFile(path.join(stageDir, "yt-dlp.subtitles.stderr.txt"), subtitle.stderr, "utf8");

  const vtts = await listFilesRecursive(stageDir, ".vtt");
  let transcript = "";
  let transcriptSource = "";
  let transcriptPath = "";
  if (vtts.length) {
    const vttPath = preferredVtt(vtts);
    transcript = cleanVtt(await fs.readFile(vttPath, "utf8"));
    transcriptSource = "youtube_subtitle";
    transcriptPath = vttPath;
  } else {
    const audioTemplate = path.join(stageDir, `${safeName(info.id || "youtube")}.%(ext)s`);
    const audio = await runProcess(toolExe("yt-dlp"), [
      "-f",
      "ba/bestaudio",
      "-x",
      "--audio-format",
      "mp3",
      "--audio-quality",
      "5",
      "--no-warnings",
      "-o",
      audioTemplate,
      url,
    ], { timeoutMs: 900000 });
    await fs.writeFile(path.join(stageDir, "yt-dlp.audio.stdout.txt"), audio.stdout, "utf8");
    await fs.writeFile(path.join(stageDir, "yt-dlp.audio.stderr.txt"), audio.stderr, "utf8");
    if (audio.code !== 0) {
      const reason = cleanToolMessage(audio.stderr || audio.stdout || `exit_${audio.code}`);
      const target = await writeFailureReport({
        dir: failureDir,
        url,
        stage: "video_audio_download",
        reason,
        detail: "No YouTube subtitles were available, and audio download did not complete."
      });
      job.failures.push({ url, status: "failed", stage: "video_audio_download", reason: "audio_download_failed", target });
      return;
    }

    const audioFiles = await listAudioFiles(stageDir);
    const audioPath = preferAudioFile(audioFiles);
    if (!audioPath) {
      const target = await writeFailureReport({ dir: failureDir, url, stage: "video_audio_download", reason: "audio_file_not_found" });
      job.failures.push({ url, status: "failed", stage: "video_audio_download", reason: "audio_file_not_found", target });
      return;
    }

    try {
      const transcribed = await transcribeLocal(audioPath, stageDir, info.id || "youtube", "zh");
      transcript = transcribed.transcript;
      transcriptPath = transcribed.transcriptPath;
      transcriptSource = "local_whispercpp";
    } catch (error) {
      const target = await writeFailureReport({ dir: failureDir, url, stage: "video_transcribe", reason: error.message });
      job.failures.push({ url, status: "failed", stage: "video_transcribe", reason: error.message, target });
      return;
    }
  }

  if (transcript.replace(/\s+/g, "").length < 80) {
    const target = await writeFailureReport({ dir: failureDir, url, stage: "video_transcript", reason: "transcript_too_short", detail: transcriptPath });
    job.failures.push({ url, status: "failed", stage: "video_transcript", reason: "transcript_too_short", target });
    return;
  }

  let guide = "";
  let guidePath = "";
  try {
    guide = await callDeepSeekForVideoGuide({
      info,
      url,
      transcript,
      instruction: importerInstruction(job)
    });
    guidePath = path.join(stageDir, `${safeName(info.id || "youtube")}.guide.md`);
    await fs.writeFile(guidePath, `${guide.trim()}\n`, "utf8");
  } catch (error) {
    const target = await writeFailureReport({
      dir: failureDir,
      url,
      stage: "video_guide",
      reason: error.message,
      detail: `Transcript: ${transcriptPath}`
    });
    job.failures.push({ url, status: "failed", stage: "video_guide", reason: error.message, target });
    return;
  }

  await writeVideoReadingFile({ job, info, url, runName, transcript, transcriptSource, transcriptPath, guide, guidePath });
}

function parseBiliInfo(text, url, bv) {
  const title = text.match(/title:\s*(.+)/)?.[1]?.trim() || bv;
  const duration = text.match(/duration:\s*'([^']+)'/)?.[1]?.trim()
    || text.match(/duration_seconds:\s*(\d+)/)?.[1]?.trim()
    || "";
  const channel = text.match(/name:\s*(.+)/)?.[1]?.trim() || "";
  const description = text.match(/description:\s*(.+)/)?.[1]?.trim() || "";
  return {
    id: bv,
    title,
    duration_string: duration,
    channel,
    uploader: channel,
    description,
    webpage_url: url,
  };
}

async function importBilibili(job, url, runName, doctor) {
  const failureDir = path.join(job.runDir, "video-failures");
  const stageDir = path.join(job.runDir, "video", safeName(url));
  await fs.mkdir(stageDir, { recursive: true });
  const bv = bvFromUrl(url);
  if (!bv) {
    const target = await writeFailureReport({ dir: failureDir, url, stage: "video_metadata", reason: "bilibili_bv_not_found" });
    job.failures.push({ url, status: "failed", stage: "video_metadata", reason: "bilibili_bv_not_found", target });
    return;
  }
  if (doctor.bilibili?.status !== "ok") {
    const target = await writeFailureReport({ dir: failureDir, url, stage: "video_backend", reason: doctor.bilibili?.message || "bilibili_backend_unavailable" });
    job.failures.push({ url, status: "failed", stage: "video_backend", reason: "bilibili_backend_unavailable", target });
    return;
  }

  const meta = await runProcess(toolExe("bili"), ["video", bv], { timeoutMs: 180000 });
  await fs.writeFile(path.join(stageDir, "bili.video.txt"), meta.stdout || meta.stderr, "utf8");
  if (meta.code !== 0) {
    const target = await writeFailureReport({ dir: failureDir, url, stage: "video_metadata", reason: cleanToolMessage(meta.stderr || meta.stdout || `exit_${meta.code}`) });
    job.failures.push({ url, status: "failed", stage: "video_metadata", reason: "metadata_failed", target });
    return;
  }

  const info = parseBiliInfo(meta.stdout, url, bv);
  const audio = await runProcess(toolExe("bili"), ["audio", bv, "--no-split", "-o", stageDir], { timeoutMs: 900000 });
  await fs.writeFile(path.join(stageDir, "bili.audio.stdout.txt"), audio.stdout, "utf8");
  await fs.writeFile(path.join(stageDir, "bili.audio.stderr.txt"), audio.stderr, "utf8");
  if (audio.code !== 0) {
    const target = await writeFailureReport({ dir: failureDir, url, stage: "video_audio_download", reason: cleanToolMessage(audio.stderr || audio.stdout || `exit_${audio.code}`) });
    job.failures.push({ url, status: "failed", stage: "video_audio_download", reason: "audio_download_failed", target });
    return;
  }

  const audioPath = preferAudioFile(await listAudioFiles(stageDir));
  if (!audioPath) {
    const target = await writeFailureReport({ dir: failureDir, url, stage: "video_audio_download", reason: "audio_file_not_found" });
    job.failures.push({ url, status: "failed", stage: "video_audio_download", reason: "audio_file_not_found", target });
    return;
  }

  let transcript = "";
  let transcriptPath = "";
  try {
    const transcribed = await transcribeLocal(audioPath, stageDir, bv, "zh");
    transcript = transcribed.transcript;
    transcriptPath = transcribed.transcriptPath;
  } catch (error) {
    const target = await writeFailureReport({ dir: failureDir, url, stage: "video_transcribe", reason: error.message });
    job.failures.push({ url, status: "failed", stage: "video_transcribe", reason: error.message, target });
    return;
  }

  if (transcript.replace(/\s+/g, "").length < 80) {
    const target = await writeFailureReport({ dir: failureDir, url, stage: "video_transcript", reason: "transcript_too_short", detail: transcriptPath });
    job.failures.push({ url, status: "failed", stage: "video_transcript", reason: "transcript_too_short", target });
    return;
  }

  let guide = "";
  let guidePath = "";
  try {
    guide = await callDeepSeekForVideoGuide({
      info,
      url,
      transcript,
      instruction: importerInstruction(job)
    });
    guidePath = path.join(stageDir, `${safeName(bv)}.guide.md`);
    await fs.writeFile(guidePath, `${guide.trim()}\n`, "utf8");
  } catch (error) {
    const target = await writeFailureReport({ dir: failureDir, url, stage: "video_guide", reason: error.message, detail: `Transcript: ${transcriptPath}` });
    job.failures.push({ url, status: "failed", stage: "video_guide", reason: error.message, target });
    return;
  }

  await writeVideoReadingFile({
    job,
    info,
    url,
    runName,
    transcript,
    transcriptSource: "local_whispercpp_bili_audio",
    transcriptPath,
    guide,
    guidePath
  });
}

async function importVideos(job, urls, runName) {
  await log(job, `视频链接已暂停处理：${urls.length} 个链接`);
  for (const url of urls) {
    const reason = "视频工作流暂停：本地 tiny ASR 产物未通过阅读质量验收。当前只保留文字导入；视频需等待高质量转写/现成工具调研后恢复。";
    const target = await writeFailureReport({
      dir: path.join(job.runDir, "video-suspended"),
      url,
      stage: "video_suspended",
      reason,
      detail: "不要将无字幕视频的低质量 ASR 草稿写入阅读区。后续恢复条件见 docs/VIDEO_WORKFLOW_STATUS.md。"
    });
    job.failures.push({ url, status: "suspended", stage: "video_suspended", reason, target });
  }
  await log(job, "视频链接暂停报告已生成");
}

async function runJob(job) {
  job.status = "running";
  job.updatedAt = nowIso();
  job.runDir = path.join(appRunsRoot, job.id);
  await writeJob(job);

  try {
    const runName = `${today()}-app-import`;
    job.intent = await parseImportIntent({ instruction: job.instruction, urls: job.urls });
    await fs.writeFile(path.join(job.runDir, "intent.json"), `${JSON.stringify(job.intent, null, 2)}\n`, "utf8");
    await log(job, `意图解析完成：${job.intent.source} / ${job.intent.processing?.languageMode || ""} / ${job.intent.processing?.linkPolicy || ""}`);

    const wechat = [];
    const web = [];
    const video = [];
    for (const url of job.urls) {
      if (isWechatUrl(url)) wechat.push(url);
      else if (isYouTubeUrl(url) || isBilibiliUrl(url)) video.push(url);
      else web.push(url);
    }

    await log(job, `任务开始：微信 ${wechat.length}，网页 ${web.length}，视频 ${video.length}`);
    if (wechat.length) await importWechat(job, wechat, runName);
    if (web.length) await importWeb(job, web, runName);
    if (video.length) await importVideos(job, video, runName);

    job.status = job.failures.length ? "completed_with_failures" : "completed";
    job.updatedAt = nowIso();
    await writeJob(job);
  } catch (error) {
    job.status = "failed";
    job.failures.push({ status: "failed", stage: "app", reason: error.stack || error.message });
    job.updatedAt = nowIso();
    await writeJob(job);
  }
}

function readRequest(req, { maxBytes = 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk.toString();
      if (body.length > maxBytes) {
        reject(new Error("request_too_large"));
        req.destroy();
      }
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function sendJson(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", ...corsHeaders() });
  res.end(JSON.stringify(data, null, 2));
}

function browserHighlightTestHtml() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Local IR Browser Highlight Test</title>
  <style>
    :root { color-scheme: light; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif; }
    body { margin: 0; color: #1d2430; background: #f7f8fa; }
    main { max-width: 760px; margin: 0 auto; padding: 32px 20px; }
    h1 { margin: 0 0 8px; font-size: 24px; line-height: 1.25; font-weight: 650; letter-spacing: 0; }
    p, li { font-size: 16px; line-height: 1.75; }
    section { margin-top: 18px; padding: 18px; border: 1px solid #d9dee7; border-radius: 8px; background: #fff; }
    code { font-family: ui-monospace, SFMono-Regular, Consolas, monospace; }
  </style>
</head>
<body>
  <main>
    <h1>Local IR 浏览器高亮测试页</h1>
    <p>这是一个普通的本地 HTTP 页面，用来验证浏览器扩展是否能注入、选区是否能高亮、摘录是否能写入本地 Markdown。</p>
    <section>
      <h2>测试文本</h2>
      <p>请开启 Local IR Browser Highlight 的高亮模式，然后选中这一整句话。成功时，页面会出现视觉高亮，并且阅读区的浏览器高亮文件夹会出现一条 Obsidian 旧高亮格式摘录。</p>
      <p>你也可以从右往左选择这句话，检查反向选择是否能正常保存。</p>
      <ul>
        <li>目标目录：<code>阅读区/浏览器高亮</code></li>
        <li>保存格式：<code>==选中文本==</code></li>
        <li>后续加工：回到 Obsidian Local IR 里处理。</li>
      </ul>
    </section>
  </main>
</body>
</html>`;
}

function html() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>渐进阅读导入</title>
  <style>
    :root { color-scheme: light; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif; }
    body { margin: 0; background: #f6f7f9; color: #1d2430; }
    main { max-width: 1180px; margin: 0 auto; padding: 24px; }
    h1 { font-size: 24px; line-height: 1.2; margin: 0 0 6px; font-weight: 650; letter-spacing: 0; }
    .subtitle { margin: 0 0 18px; color: #667085; font-size: 14px; }
    .layout { display: grid; grid-template-columns: minmax(0, 1.16fr) minmax(340px, .84fr); gap: 16px; align-items: start; }
    section { background: #fff; border: 1px solid #d9dee7; border-radius: 8px; padding: 16px; }
    .rss-panel { grid-column: 1 / -1; }
    label { display: block; font-size: 13px; font-weight: 650; margin-bottom: 8px; color: #384253; }
    textarea, input, select { width: 100%; box-sizing: border-box; border: 1px solid #c9d0dc; border-radius: 6px; padding: 10px 12px; font: 14px/1.55 ui-monospace, SFMono-Regular, Consolas, monospace; }
    textarea { min-height: 300px; resize: vertical; }
    button { margin-top: 12px; min-height: 36px; border: 1px solid #1f5fbf; background: #1f5fbf; color: #fff; border-radius: 6px; padding: 0 14px; font-size: 14px; cursor: pointer; }
    button.secondary { border-color: #c9d0dc; background: #fff; color: #1d2430; }
    button:disabled { opacity: .55; cursor: wait; }
    .toolbar { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
    .row { display: grid; grid-template-columns: 140px minmax(0, 1fr); gap: 10px; align-items: end; margin-top: 10px; }
    .actions { display: flex; flex-wrap: wrap; gap: 8px; }
    .hint { color: #667085; font-size: 13px; line-height: 1.55; margin: -2px 0 10px; }
    .url-preview { margin-top: 12px; border: 1px solid #eef1f5; background: #fafbfc; border-radius: 8px; padding: 12px; }
    .preview-title { display: flex; justify-content: space-between; gap: 12px; color: #384253; font-size: 13px; font-weight: 650; margin-bottom: 8px; }
    .url-chips { display: flex; flex-wrap: wrap; gap: 6px; min-height: 26px; }
    .chip { max-width: 100%; border: 1px solid #c9d0dc; background: #fff; border-radius: 999px; padding: 4px 9px; color: #344054; font-size: 12px; overflow-wrap: anywhere; }
    .intent-box { margin-top: 12px; border: 1px solid #eef1f5; background: #fafbfc; border-radius: 8px; padding: 10px 12px; font-size: 13px; line-height: 1.55; color: #344054; }
    .intent-box strong { color: #1d2430; }
    .status { font-size: 14px; line-height: 1.6; }
    .paths { display: grid; gap: 8px; margin-top: 12px; }
    .item { border-top: 1px solid #eef1f5; padding-top: 8px; overflow-wrap: anywhere; }
    .item a { color: inherit; }
    .ok { color: #116329; }
    .fail { color: #9b1c1c; }
    .muted { color: #667085; font-size: 13px; }
    pre { background: #101828; color: #e5e7eb; border-radius: 6px; padding: 12px; overflow: auto; min-height: 160px; max-height: 380px; font-size: 12px; line-height: 1.5; }
    @media (max-width: 820px) { .layout { grid-template-columns: 1fr; } main { padding: 16px; } }
  </style>
</head>
<body>
  <main>
    <h1>渐进阅读导入台</h1>
    <p class="subtitle">粘贴网页、微信、知乎、RSS 文章链接，也可以同时写上导入要求；完成后会把可读 Markdown 放进阅读区。</p>
    <div class="layout">
      <section class="import-panel">
        <label for="input">链接和导入要求</label>
        <p class="hint">每行一个链接最稳，也可以把一段自然语言说明一起粘进来。系统会自动抽取链接，正文导入和导读卡仍由后端工作流处理。</p>
        <textarea id="input" placeholder="例如：
https://mp.weixin.qq.com/s/...
https://example.com/article

导入到渐进阅读区，生成阅读前置卡，保留原文。"></textarea>
        <div class="toolbar">
          <button id="run">导入到阅读区</button>
          <button class="secondary" id="parseIntent">先解析要求</button>
          <button class="secondary" id="clearInput">清空</button>
        </div>
        <div class="url-preview">
          <div class="preview-title">
            <span>识别到的链接</span>
            <span id="urlCount">0</span>
          </div>
          <div class="url-chips" id="urlPreview"><span class="muted">还没有识别到链接。</span></div>
        </div>
      </section>
      <section class="status-panel">
        <label>任务结果</label>
        <div class="status" id="status">空闲</div>
        <div class="intent-box" id="intentBox">还没有解析导入意图。</div>
        <div class="paths" id="paths"></div>
        <pre id="logs"></pre>
      </section>
      <section class="rss-panel">
        <label>RSS</label>
        <p class="hint">RSS 这边处理订阅源、日报、周报和三状态归档；普通链接直接用左侧导入区。</p>
        <div class="actions">
          <button class="secondary" id="rssHealth">健康检查</button>
          <button class="secondary" id="rssSources">刷新源</button>
          <button class="secondary" id="rssSourceSetup">源层设置</button>
          <button class="secondary" id="rssSourceSync">同步源层</button>
          <button id="rssSync">生成日报</button>
          <button id="rssPromote">处理选择</button>
        </div>
        <div class="row">
          <div>
            <label for="rssType">类型</label>
            <select id="rssType">
              <option value="x-user">X 账号</option>
              <option value="rss">RSS URL</option>
            </select>
          </div>
          <div>
            <label for="rssName">名称</label>
            <input id="rssName" placeholder="Dan Koe">
          </div>
        </div>
        <div class="row">
          <div>
            <label for="rssHandle">账号</label>
            <input id="rssHandle" placeholder="thedankoe">
          </div>
          <div>
            <label for="rssFeedUrl">Feed URL</label>
            <input id="rssFeedUrl" placeholder="https://example.com/feed.xml">
          </div>
        </div>
        <button class="secondary" id="rssAdd">添加源</button>
        <div class="paths" id="rssSourceList"></div>
        <pre id="rssOutput"></pre>
      </section>
    </div>
  </main>
  <script>
    const run = document.getElementById('run');
    const parseIntentButton = document.getElementById('parseIntent');
    const clearInput = document.getElementById('clearInput');
    const input = document.getElementById('input');
    const statusEl = document.getElementById('status');
    const intentBox = document.getElementById('intentBox');
    const pathsEl = document.getElementById('paths');
    const logsEl = document.getElementById('logs');
    const urlPreview = document.getElementById('urlPreview');
    const urlCount = document.getElementById('urlCount');
    const rssOutput = document.getElementById('rssOutput');
    const rssSourceList = document.getElementById('rssSourceList');
    const rssButtons = ['rssHealth', 'rssSources', 'rssSourceSetup', 'rssSourceSync', 'rssSync', 'rssPromote', 'rssAdd'].map(id => document.getElementById(id));
    let timer = null;

    function extractClientUrls(text) {
      return Array.from(new Set(String(text || '').match(/https?:\/\/[^\s<>"']+/g) || []))
        .map(url => url.replace(/[),.;，。！？!?]+$/g, ''));
    }

    function renderInputPreview() {
      const urls = extractClientUrls(input.value);
      urlCount.textContent = String(urls.length);
      if (!urls.length) {
        urlPreview.innerHTML = '<span class="muted">还没有识别到链接。</span>';
        return urls;
      }
      urlPreview.innerHTML = urls.map(url => '<span class="chip">' + escapeHtml(url) + '</span>').join('');
      return urls;
    }

    function fileHref(target) {
      return '/files/' + encodeURIComponent(target);
    }

    function outputLink(target) {
      if (!target) return '';
      return '<a href="' + fileHref(target) + '" target="_blank" rel="noreferrer">' + escapeHtml(target) + '</a>';
    }

    function renderIntent(intent) {
      if (!intent) {
        intentBox.textContent = '还没有解析导入意图。';
        return;
      }
      const processing = intent.processing || {};
      const rows = [
        '<strong>理解来源：</strong>' + escapeHtml(intent.source || ''),
        '<strong>输出位置：</strong>' + escapeHtml(intent.outputTarget || ''),
        '<strong>导读卡：</strong>' + (processing.generateReadingGuide === false ? '关闭' : '开启'),
        '<strong>语言模式：</strong>' + escapeHtml(processing.languageMode || ''),
        '<strong>外链策略：</strong>' + escapeHtml(processing.linkPolicy || '')
      ];
      if (intent.userNotes) rows.push('<strong>补充要求：</strong>' + escapeHtml(intent.userNotes));
      if (Array.isArray(intent.warnings) && intent.warnings.length) rows.push('<strong>注意：</strong>' + escapeHtml(intent.warnings.join('；')));
      intentBox.innerHTML = rows.map(row => '<div>' + row + '</div>').join('');
    }

    function render(job) {
      statusEl.textContent = '状态：' + job.status + '｜链接：' + job.urls.length + '｜运行目录：' + (job.runDir || '');
      renderIntent(job.intent);
      logsEl.textContent = (job.logs || []).map(x => '[' + x.at + '] ' + x.message).join('\\n');
      const rows = [];
      for (const item of job.outputs || []) {
        const main = item.target ? outputLink(item.target) : escapeHtml(item.url || '');
        const parts = ['成功：' + main];
        const details = outputDetails(item);
        if (details) parts.push('<div class="muted">' + escapeHtml(details) + '</div>');
        if (item.brief) parts.push('<div>导读：' + outputLink(item.brief) + '</div>');
        if (item.report) parts.push('<div>报告：' + outputLink(item.report) + '</div>');
        rows.push('<div class="item ok">' + parts.join('') + '</div>');
      }
      for (const item of job.failures || []) rows.push('<div class="item fail">失败：' + escapeHtml((item.reason || '') + ' ' + (item.target || item.url || '')) + '</div>');
      pathsEl.innerHTML = rows.join('') || '<div class="item muted">还没有输出文件。</div>';
      if (!['queued', 'running'].includes(job.status)) {
        run.disabled = false;
        if (timer) clearInterval(timer);
      }
    }

    function renderRss(data) {
      rssOutput.textContent = JSON.stringify(data, null, 2);
      if (data && Array.isArray(data.sources)) {
        rssSourceList.innerHTML = data.sources.map(source => (
          '<div class="item">' + escapeHtml(source.displayName || source.id) +
          '<div class="muted">' + escapeHtml(source.type + ' / ' + (source.handle || source.feedUrl || '')) + '</div></div>'
        )).join('');
      }
    }

    async function rssCall(path, body) {
      rssButtons.forEach(button => button.disabled = true);
      try {
        const res = await fetch(path, body ? {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body)
        } : undefined);
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'rss_failed');
        renderRss(data);
        return data;
      } catch (error) {
        rssOutput.textContent = error.message;
      } finally {
        rssButtons.forEach(button => button.disabled = false);
      }
      return null;
    }

    function escapeHtml(s) {
      return String(s).replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
    }

    async function poll(id) {
      const res = await fetch('/api/jobs/' + id);
      render(await res.json());
    }

    async function previewIntent() {
      const urls = renderInputPreview();
      if (!urls.length) {
        statusEl.textContent = '没有识别到链接。';
        return;
      }
      parseIntentButton.disabled = true;
      intentBox.textContent = '正在解析导入意图。';
      try {
        const res = await fetch('/api/intent', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: input.value })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'intent_failed');
        statusEl.textContent = '意图解析完成。';
        renderIntent(data.intent);
      } catch (error) {
        statusEl.textContent = '意图解析失败：' + error.message;
      } finally {
        parseIntentButton.disabled = false;
      }
    }

    run.addEventListener('click', async () => {
      const urls = renderInputPreview();
      if (!urls.length) {
        statusEl.textContent = '没有识别到链接。';
        return;
      }
      run.disabled = true;
      statusEl.textContent = '提交中';
      intentBox.textContent = '正在解析导入意图。';
      pathsEl.innerHTML = '';
      logsEl.textContent = '';
      if (timer) clearInterval(timer);
      try {
        const res = await fetch('/api/import', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: input.value })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'submit_failed');
        render(data);
        timer = setInterval(() => poll(data.id).catch(console.error), 1200);
      } catch (error) {
        statusEl.textContent = '提交失败：' + error.message;
        run.disabled = false;
      }
    });

    input.addEventListener('input', renderInputPreview);
    parseIntentButton.addEventListener('click', previewIntent);
    clearInput.addEventListener('click', () => {
      input.value = '';
      renderInputPreview();
      statusEl.textContent = '空闲';
      intentBox.textContent = '还没有解析导入意图。';
      pathsEl.innerHTML = '';
      logsEl.textContent = '';
    });

    document.getElementById('rssHealth').addEventListener('click', () => rssCall('/api/rss/health'));
    document.getElementById('rssSources').addEventListener('click', () => rssCall('/api/rss/sources'));
    document.getElementById('rssSourceSetup').addEventListener('click', () => rssCall('/api/rss/source/setup', {}));
    document.getElementById('rssSourceSync').addEventListener('click', () => rssCall('/api/rss/source/sync', {}));
    document.getElementById('rssSync').addEventListener('click', () => rssCall('/api/rss/sync', {}));
    document.getElementById('rssPromote').addEventListener('click', () => rssCall('/api/rss/resolve', {}));
    document.getElementById('rssAdd').addEventListener('click', () => {
      const type = document.getElementById('rssType').value;
      rssCall('/api/rss/sources', {
        type,
        displayName: document.getElementById('rssName').value,
        handle: document.getElementById('rssHandle').value,
        feedUrl: document.getElementById('rssFeedUrl').value
      }).then(() => rssCall('/api/rss/sources'));
    });
    renderInputPreview();
    rssCall('/api/rss/sources');
  </script>
</body>
</html>`;
}

async function handle(req, res) {
  const url = new URL(req.url || "/", "http://127.0.0.1");
  if (req.method === "OPTIONS") {
    res.writeHead(204, corsHeaders());
    res.end();
    return;
  }
  if (req.method === "GET" && url.pathname === "/") {
    res.writeHead(200, {
      ...corsHeaders(),
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store, max-age=0"
    });
    res.end(html());
    return;
  }
  if (req.method === "GET" && url.pathname === "/browser-highlight-test") {
    res.writeHead(200, {
      ...corsHeaders(),
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store, max-age=0"
    });
    res.end(browserHighlightTestHtml());
    return;
  }
  if (req.method === "GET" && url.pathname.startsWith("/api/jobs/")) {
    const id = decodeURIComponent(url.pathname.slice("/api/jobs/".length));
    const job = jobs.get(id);
    if (!job) return sendJson(res, 404, { error: "job_not_found" });
    return sendJson(res, 200, publicJob(job));
  }
  if (req.method === "GET" && url.pathname.startsWith("/files/")) {
    const target = path.resolve(decodeURIComponent(url.pathname.slice("/files/".length)));
    if (!target.startsWith(workflowRoot)) return sendJson(res, 403, { error: "forbidden" });
    createReadStream(target).pipe(res);
    return;
  }
  if (req.method === "GET" && url.pathname === "/api/highlights/health") {
    return sendJson(res, 200, {
      status: "ok",
      service: "local-ir-browser-highlight",
      readingRoot,
      browserHighlightRoot,
      now: nowIso()
    });
  }
  if (req.method === "POST" && url.pathname === "/api/highlights/capture") {
    try {
      const body = JSON.parse(await readRequest(req, { maxBytes: 8 * 1024 * 1024 }) || "{}");
      return sendJson(res, 200, await writeBrowserHighlightCapture(body));
    } catch (error) {
      return sendJson(res, 400, { error: error.message });
    }
  }
  if (req.method === "POST" && url.pathname === "/api/intent") {
    try {
      const body = JSON.parse(await readRequest(req) || "{}");
      const text = String(body.text || "").trim();
      if (!text) return sendJson(res, 400, { error: "empty_input" });
      const urls = extractUrls(text);
      if (!urls.length) return sendJson(res, 400, { error: "no_url_found" });
      const instruction = instructionFromText(text, urls);
      const intent = await parseImportIntent({ instruction, urls });
      return sendJson(res, 200, { instruction, urls, intent });
    } catch (error) {
      return sendJson(res, 400, { error: error.message });
    }
  }
  if (req.method === "GET" && url.pathname === "/api/rss/health") {
    try {
      return sendJson(res, 200, await runRssCli(["health"], { timeoutMs: 180000 }));
    } catch (error) {
      return sendJson(res, 500, { error: error.message });
    }
  }
  if (req.method === "GET" && url.pathname === "/api/rss/sources") {
    try {
      return sendJson(res, 200, await runRssCli(["sources"], { timeoutMs: 60000 }));
    } catch (error) {
      return sendJson(res, 500, { error: error.message });
    }
  }
  if (req.method === "POST" && url.pathname === "/api/rss/sources") {
    try {
      const body = JSON.parse(await readRequest(req) || "{}");
      const args = ["add-source", "--type", String(body.type || "x-user")];
      if (body.displayName) args.push("--display-name", String(body.displayName));
      if (body.handle) args.push("--handle", String(body.handle));
      if (body.feedUrl) args.push("--feed-url", String(body.feedUrl));
      return sendJson(res, 200, await runRssCli(args, { timeoutMs: 60000 }));
    } catch (error) {
      return sendJson(res, 400, { error: error.message });
    }
  }
  if (req.method === "POST" && url.pathname === "/api/rss/sync") {
    try {
      return sendJson(res, 200, await runRssCli(["sync"], { timeoutMs: 1200000 }));
    } catch (error) {
      return sendJson(res, 500, { error: error.message });
    }
  }
  if (req.method === "POST" && url.pathname === "/api/rss/source/setup") {
    try {
      return sendJson(res, 200, await runRssCli(["source-setup"], { timeoutMs: 600000 }));
    } catch (error) {
      return sendJson(res, 500, { error: error.message });
    }
  }
  if (req.method === "POST" && url.pathname === "/api/rss/source/sync") {
    try {
      return sendJson(res, 200, await runRssCli(["source-sync"], { timeoutMs: 1200000 }));
    } catch (error) {
      return sendJson(res, 500, { error: error.message });
    }
  }
  if (req.method === "POST" && url.pathname === "/api/rss/resolve") {
    try {
      return sendJson(res, 200, await runRssCli(["resolve"], { timeoutMs: 1200000 }));
    } catch (error) {
      return sendJson(res, 500, { error: error.message });
    }
  }
  if (req.method === "POST" && url.pathname === "/api/rss/promote") {
    try {
      return sendJson(res, 200, await runRssCli(["resolve"], { timeoutMs: 1200000 }));
    } catch (error) {
      return sendJson(res, 500, { error: error.message });
    }
  }
  if (req.method === "POST" && url.pathname === "/api/import") {
    try {
      const body = JSON.parse(await readRequest(req) || "{}");
      const text = String(body.text || "").trim();
      if (!text) return sendJson(res, 400, { error: "empty_input" });
      const urls = extractUrls(text);
      if (!urls.length) return sendJson(res, 400, { error: "no_url_found" });
      const id = `${today()}-${new Date().toISOString().slice(11, 19).replace(/:/g, "")}-${randomUUID().slice(0, 8)}`;
      const job = {
        id,
        status: "queued",
        createdAt: nowIso(),
        updatedAt: nowIso(),
        instruction: instructionFromText(text, urls),
        intent: null,
        urls,
        runDir: "",
        outputs: [],
        failures: [],
        logs: []
      };
      jobs.set(id, job);
      runJob(job);
      return sendJson(res, 202, publicJob(job));
    } catch (error) {
      return sendJson(res, 400, { error: error.message });
    }
  }
  sendJson(res, 404, { error: "not_found" });
}

async function listen(port) {
  const server = http.createServer((req, res) => {
    handle(req, res).catch((error) => sendJson(res, 500, { error: error.message }));
  });
  return new Promise((resolve, reject) => {
    server.once("error", (error) => {
      if (error.code === "EADDRINUSE") {
        reject(new Error(`port_${port}_in_use_close_existing_progressive_reading_app`));
        return;
      }
      reject(error);
    });
    server.listen(port, "127.0.0.1", async () => {
      const info = { url: `http://127.0.0.1:${port}`, port, startedAt: nowIso(), pid: process.pid };
      await fs.mkdir(importsRoot, { recursive: true });
      await fs.writeFile(path.join(importsRoot, "app-server.json"), `${JSON.stringify(info, null, 2)}\n`, "utf8");
      console.log(`Progressive reading app: ${info.url}`);
      resolve(server);
    });
  });
}

listen(defaultPort).catch((error) => {
  console.error(error);
  process.exit(1);
});
