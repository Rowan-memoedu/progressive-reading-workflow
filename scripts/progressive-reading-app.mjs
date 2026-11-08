import fs from "node:fs/promises";
import { createReadStream, existsSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";
import { Readability } from "@mozilla/readability";
import TurndownService from "turndown";
import { gfm } from "turndown-plugin-gfm";
import LocalIrDocumentCore from "../document-core/index.mjs";
import { preprocessBrowserCapture, browserCaptureProcessingOptions } from "../standard-preprocessing/integrations/browser-capture.mjs";
import { preprocessNetworkMarkdown } from "../standard-preprocessing/integrations/network-import.mjs";
import { PROCESSOR_VERSION as standardPreprocessProcessorVersion } from "../standard-preprocessing/lib/core.mjs";
import { GUIDE_COVERAGE_VERSION } from '../standard-preprocessing/lib/guide-coverage.mjs';
import { loadProducerConfig as loadUnifiedProducerConfig, requestProducerText } from '../standard-preprocessing/lib/producer.mjs';
import { classifyStandardImportQuality, readingDocumentPathCandidates } from "./standard-import-quality.mjs";
import { htmlArticleToMarkdown } from "./browser-page-markdown.mjs";
import { extractUrls, urlImportDedupeKey } from "./url-import-input.mjs";
import { IMPORT_RULES, zhihuColumnIdentity } from "./import-rule-catalog.mjs";
import { discoverZhihuColumn } from "./zhihu-column-import.mjs";
import { assertLocalRequest, handleSubscriptions } from '../subscription-workflow/http.mjs';
import { startSubscriptionWorker } from '../subscription-workflow/service.mjs';
import { processCollectionTask } from "./collection-import.mjs";
import { fetchYoutubeSubtitleDraft, youtubeVideoIdentity } from "./youtube-subtitle-import.mjs";
import { LiveCookieSnapshot, defaultCookieDataRoot, COOKIE_SNAPSHOT_ENDPOINT, COOKIE_STATUS_ENDPOINT, safeError as safeCookieSnapshotError } from "./live-cookie-snapshot.mjs";
import {
  BACKGROUND_FETCH_TRANSPORT,
  BrowserImportBroker,
  DEFAULT_LEASE_MS,
  DEFAULT_MAX_ATTEMPTS,
  URL_IMPORT_EXECUTION_CONTRACT
} from "./browser-import-broker.mjs";
import {
  inferImportEntryRoute,
  loadImportDestinationRoutes,
  normalizeRelativeDestinationFolder,
  resolveImportDestinationFolder,
  resolveReadingDestinationRoot
} from "./import-destination-routing.mjs";
import {
  URL_COOKIE_SYNC_ALLOWED_HOSTNAMES,
  URL_COOKIE_SETUP_ORIGIN,
  URL_COOKIE_SYNC_SCHEMA,
  UrlImportDegradedError,
  fetchUrlWithoutBrowser,
  isLoopbackAddress,
  mergeCookieSyncIntoProcessEnvironment,
  validateCookieSyncContentType,
  validateCookieSyncSetupOrigin,
  validateCookieSyncPayload,
  withoutUrlCookieEnvironment,
  loadDomainCookieMap
} from "./url-background-fetch.mjs";
import {
  CHROME_COOKIE_JAR_MAX_COOKIES,
  CHROME_COOKIE_JAR_MAX_SYNC_BYTES,
  CHROME_COOKIE_JAR_SYNC_SCHEMA,
  CHROME_COOKIE_SNAPSHOT_PATH_ENV,
  CHROME_COOKIE_SNAPSHOT_SCHEMA,
  CHROME_COOKIE_SNAPSHOT_SCHEMA_VERSION,
  ChromeCookieJar,
  validateChromeCookieSyncOrigin
} from "./chrome-cookie-jar.mjs";
import {
  discoverRecentZhihuLikes,
  discoverZhihuLikesSince,
  unlikeZhihuItems,
  verifyZhihuLikesRemoved
} from "./zhihu-social-archive.mjs";
import {
  addMaterialCandidate,
  createLearningProject,
  defaultLearningRoot,
  doctorLearningProject,
  getProjectStatus,
  listLearningProjects,
  promoteMaterialCandidate,
  recordLearningEvidence,
  resolveProject
} from "./learning-project-core.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const codeWorkflowRoot = path.resolve(__dirname, "..");

if (!LocalIrDocumentCore?.createDocumentState) {
  throw new Error("local_ir_document_core_unavailable");
}

function resolveWorkflowRoot() {
  const configuredRoot = String(process.env.PROGRESSIVE_READING_WORKFLOW_ROOT || "").trim();
  if (configuredRoot) return path.resolve(configuredRoot);

  try {
    const gitCommonDir = execFileSync(
      "git",
      ["-C", codeWorkflowRoot, "rev-parse", "--path-format=absolute", "--git-common-dir"],
      { encoding: "utf8", windowsHide: true }
    ).trim();
    const workspaceRoot = path.dirname(path.resolve(gitCommonDir));
    const canonicalWorkflowRoot = path.join(workspaceRoot, "04 Projects", "渐进阅读工作流");
    if (existsSync(canonicalWorkflowRoot)) return canonicalWorkflowRoot;
  } catch {
    // Non-Git deployments keep using the directory that contains this script.
  }

  return codeWorkflowRoot;
}

const workflowRoot = resolveWorkflowRoot();
const importScript = path.join(__dirname, "import-web-md.mjs");
const rssReadingScript = path.join(workflowRoot, "rss-reading", "cli.mjs");
const localTranscribeScript = path.join(__dirname, "local-whispercpp-transcribe.py");
const readingRoot = path.join(workflowRoot, "阅读区");
const importsRoot = path.join(workflowRoot, "imports");
const appRunsRoot = path.join(importsRoot, "app-runs");
const learningRoot = path.resolve(process.env.LEARNING_PROJECT_ROOT || defaultLearningRoot);
const browserHighlightRoot = path.join(readingRoot, "浏览器高亮");
const browserCompletedRoot = path.join(workflowRoot, "待归档原文");
const browserCompletedHighlightRoot = path.join(browserCompletedRoot, "浏览器高亮");
const browserStateRoot = path.join(workflowRoot, ".local-ir", "browser-document-state");
const browserPreprocessRoot = path.join(workflowRoot, ".local-ir", "browser-standard-preprocess");
const importDestinationRoutesPath = path.join(workflowRoot, "config", "import-destination-routes.json");
const importDestinationRoutes = await loadImportDestinationRoutes(importDestinationRoutesPath);
const requestedUrlImportConcurrency = Number(process.env.PROGRESSIVE_READING_URL_IMPORT_CONCURRENCY || 4);
const URL_IMPORT_CONCURRENCY = Number.isFinite(requestedUrlImportConcurrency)
  ? Math.max(1, Math.min(8, Math.floor(requestedUrlImportConcurrency)))
  : 4;
const browserImportBroker = new BrowserImportBroker({
  stateRoot: path.join(workflowRoot, ".local-ir", "browser-import-broker"),
  concurrency: URL_IMPORT_CONCURRENCY
});
let urlCookieConfig = loadDomainCookieMap(process.env);
const chromeCookieJar = new ChromeCookieJar();
const configuredCookieSnapshotPath = String(process.env[CHROME_COOKIE_SNAPSHOT_PATH_ENV] || "").trim();
const liveCookieSnapshot = new LiveCookieSnapshot({ jar: chromeCookieJar, workflowRoot,
  dataRoot: defaultCookieDataRoot(workflowRoot), explicitPath: configuredCookieSnapshotPath });
const legacyRuntimeCookieReplacementEnabled = process.env.PROGRESSIVE_READING_ENABLE_LEGACY_COOKIE_SYNC === "true";
const defaultPort = Number(process.env.PROGRESSIVE_READING_APP_PORT || 37829);
const producerConfigDir = path.join(process.env.USERPROFILE || process.env.HOME || "", "Documents", "New project");
const producerConfigKeys = ["AI_PRODUCER_BASE_URL", "DEEPSEEK_READING_API_KEY", "AI_PRODUCER_MODEL"];
const jobs = new Map();
const browserCommitLocks = new Map();
const backgroundImportRuns = new Map();
const cookieSyncEndpoint = "/api/browser-import/cookies/sync";

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

function importDestinationFolder({ source, entryRoute, destinationFolder, sourceUrl }) {
  return resolveImportDestinationFolder(importDestinationRoutes, { source, entryRoute, destinationFolder, sourceUrl });
}

function readingDestinationRoot(folder) {
  return resolveReadingDestinationRoot(readingRoot, folder);
}

function cookieSyncCorsHeaders(origin) {
  return {
    ...(origin ? { "Access-Control-Allow-Origin": origin } : {}),
    "Access-Control-Allow-Methods": "POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Cache-Control": "no-store, max-age=0",
    "Vary": "Origin"
  };
}

function cookieSyncOrigin(req) {
  if (!isLoopbackAddress(req.socket?.remoteAddress)) throw new Error("cookie_sync_loopback_only");
  const origin = String(req.headers.origin || "").trim();
  if (origin === URL_COOKIE_SETUP_ORIGIN) return validateCookieSyncSetupOrigin(origin);
  return validateChromeCookieSyncOrigin(origin);
}

function cookieSyncErrorStatus(error) {
  const code = String(error?.message || error || "");
  if (/^(?:cookie_sync_loopback_only|cookie_sync_origin_)/u.test(code)) return 403;
  if (code === "cookie_sync_content_type_must_be_application_json") return 415;
  if (code === "request_too_large") return 413;
  if (code === "cookie_sync_invalid_json") return 400;
  return /^(?:cookie_sync_|chrome_cookie_)/u.test(code) ? 422 : 400;
}

function importFailureHttpStatus(error) {
  if (["required_translation_missing", "required_reading_guide_missing", "standard_preprocess_not_ready"].includes(error?.code)) return 422;
  const message = String(error?.message || error || "");
  return /^(invalid_|unsupported_|empty_|no_url_found|too_many_urls|standard_preprocess_not_ready_after_)/u.test(message)
    ? 422
    : 503;
}

async function writeFileAtomic(target, contents) {
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, contents, "utf8");
    await fs.rename(temporary, target);
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

async function withBrowserCommitLock(key, operation) {
  const normalizedKey = String(key || "unknown");
  const previous = browserCommitLocks.get(normalizedKey) || Promise.resolve();
  const current = previous.catch(() => undefined).then(operation);
  browserCommitLocks.set(normalizedKey, current);
  try {
    return await current;
  } finally {
    if (browserCommitLocks.get(normalizedKey) === current) browserCommitLocks.delete(normalizedKey);
  }
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
      generateReadingGuide: wantsNoGuide ? false : null,
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
    "- YouTube 现成字幕已恢复导入；无字幕 ASR 和其他视频仍暂停，不要承诺自动转写。",
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
    const config = await loadUnifiedProducerConfig({requiredProvider:'codex_exec'});
    const data = await requestProducerText(config, {
      system: "你是本地导入工具的意图解析器，只输出可解析 JSON。",
      user: prompt
    });
    const parsed = JSON.parse(stripModelFences(data?.choices?.[0]?.message?.content || ""));
    return normalizeIntent({ ...parsed, source: "codex_exec" }, instruction, urls);
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
    const childEnv = withoutUrlCookieEnvironment(process.env);
    const child = spawn(command, args, { cwd, windowsHide: true, env: childEnv });
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
  return item?.status === "imported"
    || item?.status === "imported_with_warnings"
    || item?.status === "partial"
    || item?.status === "idempotent_replay";
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

async function runRssReadingCli(args, { timeoutMs = 900000 } = {}) {
  const result = await runProcess(process.execPath, [rssReadingScript, ...args], { timeoutMs });
  const parsed = parseJsonOutput(result.stdout);
  if (result.code !== 0) {
    const detail = parsed || { error: result.stderr || result.stdout || `rss_reading_cli_exit_${result.code}` };
    throw new Error(JSON.stringify(detail));
  }
  return parsed?.result || parsed || { stdout: result.stdout, stderr: result.stderr };
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
    // A conversion error must not silently replace formulas with flattened text.
    return htmlArticleToMarkdown({ html, sourceUrl, title });
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

async function browserDraftTarget(root, sourceUrl, title) {
  const parsed = new URL(sourceUrl);
  const suffix = `--浏览器加工--${shortHash(parsed.href)}.md`;
  const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
  const existing = entries.find((entry) => entry.isFile() && entry.name.endsWith(suffix));
  if (existing) return path.join(root, existing.name);
  return path.join(root, `${safeName(title || parsed.hostname || "browser-reading")}${suffix}`);
}

function browserDraftDocument({ draft, converted, documentStatus }) {
  const title = converted.title || draft.title || new URL(draft.url).hostname;
  const now = nowIso();
  return [
    "---",
    `source_url: ${yamlString(draft.url)}`,
    `source_title: ${yamlString(title)}`,
    `imported_at: ${yamlString(now)}`,
    `updated_at: ${yamlString(now)}`,
    "import_method: browser_draft_commit",
    "highlight_mode: virtual_metadata",
    `conversion_method: ${yamlString(converted.method)}`,
    `browser_draft_id: ${yamlString(draft.id)}`,
    `browser_draft_revision: ${Number(draft.revision || 0)}`,
    "browser_state_schema: local-ir.document-state/v1",
    `status: ${documentStatus === "done" ? "done" : "imported"}`,
    "---",
    "",
    `# ${title}`,
    "",
    `Source: [${draft.url}](${draft.url})`,
    "",
    normalizeMarkdownText(converted.markdown || "", 300000),
    ""
  ].join("\n");
}

async function browserPreprocessProducer() {
  const mode = String(process.env.PROGRESSIVE_READING_BROWSER_PREPROCESS_TEST_PRODUCER || "").trim();
  if (!mode) return undefined;
  if (process.env.NODE_ENV !== "test") throw new Error("browser_preprocess_test_producer_requires_test_environment");
  const { SyntheticProducer } = await import("../standard-preprocessing/test-support/synthetic-producer.mjs");
  if (mode === "synthetic") return new SyntheticProducer();
  if (mode === "synthetic-invalid") return new SyntheticProducer({ invalid: true });
  if (mode === "synthetic-uncertain") return new SyntheticProducer({ uncertain: true });
  throw new Error(`unsupported_browser_preprocess_test_producer:${mode}`);
}

async function standardizeBrowserDraft(draft, parsedUrl, converted, onProgress) {
  const outputDir = path.join(browserPreprocessRoot, shortHash(parsedUrl.href));
  const cacheDir = path.join(browserPreprocessRoot, ".cache");
  const youtubeTranscript = draft.sourceMetadata?.source_type === 'youtube_video_transcript';
  const preprocess = youtubeTranscript ? preprocessNetworkMarkdown : preprocessBrowserCapture;
  const run = await preprocess({
    markdown: converted.markdown,
    ...(youtubeTranscript ? {
      sourceType: 'youtube_video_transcript',
      spoken: true
    } : {}),
    processingOptions: { ...(youtubeTranscript ? { require_content_headings: true } : {}), ...(draft.processingOptions || {}) },
    sourceMetadata: {
      ...draft.sourceMetadata,
      source_url: String(draft.sourceMetadata?.source_url || parsedUrl.href),
      canonical_url: String(draft.sourceMetadata?.canonical_url || parsedUrl.href),
      title: converted.title || draft.title,
      source_is_original: true,
      capture_agent: String(draft.sourceMetadata?.capture_agent || "local_ir_browser_extension")
    },
    userInstruction: draft.userInstruction,
    outputDir,
    cacheDir,
    producer: await browserPreprocessProducer(),
    onProgress
  });
  const quality = classifyStandardImportQuality(run.result);
  if (run.result.status === "needs_classification") {
    const error = new Error(run.result.receipt.workflow_route.classification_reason);
    error.code = "needs_classification";
    error.details = { missing_labels: run.result.receipt.workflow_route.missing_labels, preprocess_output_dir: outputDir };
    throw error;
  }
  if (!quality.admissible) {
    const status = run.result?.status || "unknown";
    const state = run.result?.processing_state || "unknown";
    const zone = run.result?.artifacts?.target_zone || "unknown";
    const attempts = Math.max(1, Number(run.workflow_attempts?.length || 1));
    const missing = quality.critical_failures || [];
    const stage = missing.includes("required_translation_missing") ? "profile_translation"
      : missing.includes("required_reading_guide_missing") ? "reading_guide" : "preprocessing";
    const reason = stage === "profile_translation" ? "未生成所要求的译文" : stage === "reading_guide" ? "未生成所要求的导读" : "正文处理未完成";
    const error = new Error(`${reason}，未写入阅读区；可重试失败阶段。`);
    error.code = missing[0] || "standard_preprocess_not_ready";
    error.details = { stage, status, processing_state: state, target_zone: zone, attempts, preprocess_output_dir: outputDir,
      cause: run.result.errors?.map(item => item.message).join("; ") || null };
    throw error;
  }
  const rendered = String(run.result.artifacts.reading_markdown || "");
  if (!rendered.startsWith("---\n")) throw new Error("standard_preprocess_missing_frontmatter");
  const processorVersion = String(run.result.receipt?.processor_version || "unknown");
  const promptVersion = String(run.result.receipt?.prompt_version || "unknown");
  const conversionMethod = `progressive_reading_preprocess/${processorVersion}`;
  const markdown = updateFrontmatterFields(rendered, {
    source_url: String(draft.sourceMetadata?.source_url || parsedUrl.href),
    source_title: converted.title || draft.title,
    import_method: draft.sourceMetadata?.source_type === 'youtube_video_transcript' ? 'youtube_subtitle_standard_preprocess' : "browser_standard_preprocess",
    highlight_mode: "virtual_metadata",
    conversion_method: conversionMethod,
    browser_draft_id: draft.id,
    browser_draft_revision: Number(draft.revision || 0),
    browser_state_schema: "local-ir.document-state/v1",
    processing_status: quality.quality_status,
    status: "imported"
  });
  return {
    markdown,
    conversionMethod,
    outputDir: run.output_dir || outputDir,
    materialId: run.result.material_id,
    idempotencyKey: run.result.idempotency_key,
    processorVersion,
    promptVersion,
    status: run.result.status,
    processingState: run.result.processing_state,
    targetZone: run.result.artifacts.target_zone,
    qualityStatus: quality.quality_status,
    readableWithWarnings: quality.readable_with_warnings,
    warningCodes: quality.warning_codes,
    workflowAttempts: run.workflow_attempts || [],
    processingPlan: run.result.receipt.workflow_route?.plan,
    readingGuide: run.result.receipt.reading_guide,
    modelCalls: run.result.receipt.model.calls
  };
}

function assertUrlImportBodyIntegrity(draft, converted) {
  if (draft.sourceType !== "url_import") return;
  const sourceIntegrity = draft.sourceMetadata?.content_integrity || {};
  const markdownChars = String(converted.markdown || "").replace(/\s+/gu, "").length;
  const visibleChars = Math.max(0, Number(sourceIntegrity.visible_text_chars || 0));
  if (markdownChars < 80) throw new Error("url_content_integrity_failed:extracted_markdown_too_short");
  if (visibleChars >= 500 && markdownChars / visibleChars < 0.15) {
    throw new Error("url_content_integrity_failed:extracted_body_ratio_too_low");
  }
}

async function pathExists(target) {
  return fs.access(target).then(() => true, () => false);
}

async function migrateLegacyBrowserCompletedArtifacts() {
  const entries = await fs.readdir(browserCompletedRoot, { withFileTypes: true }).catch(() => []);
  const migrations = [];
  await fs.mkdir(browserCompletedHighlightRoot, { recursive: true });
  await fs.mkdir(browserStateRoot, { recursive: true });

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".md") || !entry.name.includes("--浏览器完成阅读--")) continue;
    const legacyMarkdown = path.join(browserCompletedRoot, entry.name);
    const legacySidecar = path.join(browserStateRoot, `${entry.name}.browser-ir.json`);
    const canonicalName = entry.name.replace("--浏览器完成阅读--", "--浏览器加工--");
    const canonicalMarkdown = path.join(browserCompletedHighlightRoot, canonicalName);
    const canonicalSidecar = path.join(browserStateRoot, `${canonicalName}.browser-ir.json`);
    if (await pathExists(canonicalMarkdown) || await pathExists(canonicalSidecar) || !(await pathExists(legacySidecar))) continue;

    let state;
    try {
      state = JSON.parse(await fs.readFile(legacySidecar, "utf8"));
    } catch {
      continue;
    }
    if (state?.schema !== LocalIrDocumentCore.DOCUMENT_STATE_SCHEMA || state?.document?.status !== "done") continue;

    const migratedAt = nowIso();
    const documentPath = path.relative(path.resolve(workflowRoot, "..", ".."), canonicalMarkdown).replaceAll("\\", "/");
    const migratedState = LocalIrDocumentCore.normalizeDocumentState({
      ...state,
      document: {
        ...state.document,
        path: documentPath,
        revision: Number(state.document.revision || 0) + 1,
        updatedAt: migratedAt,
        handoff: {
          ...state.document.handoff,
          state: "ready",
          owner: "obsidian",
          committedAt: migratedAt
        }
      },
      browser: {
        ...state.browser,
        destination: "completed",
        completionIntent: "pending_archive"
      }
    }, { path: documentPath });

    await fs.rename(legacyMarkdown, canonicalMarkdown);
    try {
      await writeFileAtomic(canonicalSidecar, `${JSON.stringify(migratedState, null, 2)}\n`);
      await fs.rm(legacySidecar, { force: true });
      migrations.push({ from: legacyMarkdown, to: canonicalMarkdown, annotations: migratedState.annotations.length });
    } catch (error) {
      await fs.rename(canonicalMarkdown, legacyMarkdown).catch(() => undefined);
      await fs.rm(canonicalSidecar, { force: true }).catch(() => undefined);
      throw error;
    }
  }
  return migrations;
}

async function writeBrowserDraftCommitUnlocked(rawBody, destination = "reading", options = {}) {
  const rawDraft = rawBody?.draft || {};
  if (String(rawDraft.html || "").length > 4000000) throw new Error("page_snapshot_too_large:页面超过完整捕获上限，已停止导入以免截断内容。");
  const draft = {
    ...rawDraft,
    url: String(rawDraft.url || "").trim(),
    title: String(rawDraft.title || "").trim(),
    pageText: normalizeMarkdownText(rawDraft.pageText || "", 300000),
    html: normalizeMarkdownText(rawDraft.html || "", 4000000),
    annotations: Array.isArray(rawDraft.annotations) ? rawDraft.annotations : [],
    qaCards: Array.isArray(rawDraft.qaCards) ? rawDraft.qaCards : [],
    articleMusing: rawDraft.articleMusing || null,
    sourceType: String(rawDraft.sourceType || "browser_page"),
    sourceMetadata: rawDraft.sourceMetadata && typeof rawDraft.sourceMetadata === "object" ? rawDraft.sourceMetadata : {},
    userInstruction: String(rawDraft.userInstruction || ""),
    processingOptions: { ...(rawBody?.processing_options || rawDraft.processingOptions || {}), ...(options.processingOptions || {}) },
    destinationFolder: normalizeRelativeDestinationFolder(rawDraft.destinationFolder || "")
  };
  let parsed;
  try {
    parsed = new URL(draft.url);
  } catch {
    throw new Error("invalid_url");
  }
  if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("unsupported_url_protocol");
  const cachedRssMarkdown = options.cachedRssMarkdown;
  if (!draft.html && !draft.pageText && !cachedRssMarkdown) throw new Error("empty_page_content");

  const converted = cachedRssMarkdown
    ? { markdown: cachedRssMarkdown, title: draft.title, method: "retained_rss_fulltext" }
    : browserPageToMarkdown({
    html: draft.html,
    pageText: draft.pageText,
    sourceUrl: parsed.href,
    title: draft.title
  });
  if (!cachedRssMarkdown) assertUrlImportBodyIntegrity(draft, converted);
  const standardize = options.standardize !== false;
  const resolvedDestination = destination;
  const completed = resolvedDestination === "completed";
  const root = completed
    ? browserCompletedHighlightRoot
    : (standardize || draft.sourceType === 'url_import') && draft.destinationFolder
      ? readingDestinationRoot(draft.destinationFolder)
      : browserHighlightRoot;
  const documentStatus = completed ? "done" : "inbox";
  await fs.mkdir(root, { recursive: true });
  await fs.mkdir(browserStateRoot, { recursive: true });
  const target = await browserDraftTarget(root, parsed.href, converted.title || draft.title);
  const metadataTarget = path.join(browserStateRoot, `${path.basename(target)}.browser-ir.json`);
  if (standardize && draft.sourceType !== "url_import" && await pathExists(target)) {
    const previous = await fs.readFile(metadataTarget, "utf8").then(JSON.parse).catch(() => null);
    const contents = await fs.readFile(target);
    if (!previous?.content?.markdownSha256 || createHash("sha256").update(contents).digest("hex") !== previous.content.markdownSha256) {
      throw new Error("existing_article_changed_preserved:本地文章已有后续修改，已保留文章与批注，未覆盖。");
    }
  }
  if (draft.sourceType === "url_import"
    && (await pathExists(target) || await pathExists(metadataTarget))) {
    throw new Error("existing_article_preserved_review_required");
  }
  const preprocessing = standardize
    ? await standardizeBrowserDraft(draft, parsed, converted, options.onProgress)
    : null;
  const originalImport = !standardize && draft.sourceType === 'url_import';
  const originalMarkdown = browserDraftDocument({
    draft: { ...draft, url: parsed.href },
    converted,
    documentStatus
  });
  const markdown = preprocessing ? updateFrontmatterFields(preprocessing.markdown, { status: completed ? 'done' : 'imported' }) : (originalImport ? updateFrontmatterFields(originalMarkdown, {
    import_method:'url_original_text',processing_mode:'original_text',processing_status:'original',llm_used:false
  }) : originalMarkdown);
  const rawMarkdownSha256 = createHash("sha256").update(converted.markdown).digest("hex");
  const finalMarkdownSha256 = createHash("sha256").update(markdown).digest("hex");
  const documentPath = path.relative(path.resolve(workflowRoot, "..", ".."), target).replaceAll("\\", "/");
  const stateDraft = preprocessing ? {
    ...draft,
    sourceMetadata: {
      ...draft.sourceMetadata,
      destination_folder: draft.destinationFolder || "浏览器高亮",
      standard_preprocess: {
        material_id: preprocessing.materialId,
        idempotency_key: preprocessing.idempotencyKey,
        processor_version: preprocessing.processorVersion,
        prompt_version: preprocessing.promptVersion,
        output_dir: preprocessing.outputDir,
        workflow_attempts: preprocessing.workflowAttempts,
        processing_plan: preprocessing.processingPlan,
        reading_guide: preprocessing.readingGuide,
        model_calls: preprocessing.modelCalls,
        quality_status: preprocessing.qualityStatus,
        readable_with_warnings: preprocessing.readableWithWarnings,
        warning_codes: preprocessing.warningCodes
      }
    }
  } : originalImport ? {
    ...draft, sourceMetadata:{...draft.sourceMetadata,destination_folder:draft.destinationFolder || '浏览器高亮',
      original_import:{processing_mode:'original_text',llm_used:false,conversion_method:converted.method}}
  } : draft;
  const metadata = LocalIrDocumentCore.createDocumentState(stateDraft, {
    path: documentPath,
    title: converted.title || draft.title,
    sourceUrl: String(draft.sourceMetadata?.source_url || parsed.href),
    destination: resolvedDestination,
    documentStatus,
    markdownSha256: finalMarkdownSha256,
    rawMarkdownSha256,
    conversionMethod: preprocessing?.conversionMethod || converted.method,
    committedAt: nowIso()
  });
  metadata.annotations = LocalIrDocumentCore.anchorAnnotationsToMarkdown(metadata.annotations, markdown, documentPath);
  await writeFileAtomic(target, markdown);
  await writeFileAtomic(metadataTarget, `${JSON.stringify(metadata, null, 2)}\n`);
  return {
    status: completed ? "completed_pending_archive" : "saved_locked",
    artifacts: [
      { kind: "markdown", path: target, sha256: finalMarkdownSha256 },
      { kind: "browser_ir_metadata", path: metadataTarget },
      ...(preprocessing ? [{ kind: "standard_preprocess_audit", path: preprocessing.outputDir }] : [])
    ],
    source_metadata: metadata.browser.sourceMetadata,
    receipt: {
      draft_id: draft.id,
      revision: Number(draft.revision || 0),
      destination: resolvedDestination,
      committed_at: nowIso(),
      conversion_fidelity: converted.fidelity || null,
      ...(preprocessing ? {
        processing_mode: "standard_preprocess",
        preprocess_status: preprocessing.status,
        material_id: preprocessing.materialId,
        idempotency_key: preprocessing.idempotencyKey,
        processor_version: preprocessing.processorVersion,
        prompt_version: preprocessing.promptVersion,
        workflow_attempts: preprocessing.workflowAttempts,
        processing_plan: preprocessing.processingPlan,
        reading_guide: preprocessing.readingGuide,
        model_calls: preprocessing.modelCalls,
        quality_status: preprocessing.qualityStatus,
        readable_with_warnings: preprocessing.readableWithWarnings,
        warning_codes: preprocessing.warningCodes
      } : originalImport ? {processing_mode:'original_text',llm_used:false,quality_status:'ready'} : {}),
      raw_markdown_sha256: rawMarkdownSha256,
      final_markdown_sha256: finalMarkdownSha256
    },
    warnings: [...(preprocessing?.warningCodes || []), ...(converted.fidelity?.warnings || [])],
    errors: []
  };
}

function runtimeCookieHeaderForUrl(value) {
  if (legacyRuntimeCookieReplacementEnabled && chromeCookieJar.health.source === "runtime_payload") return chromeCookieJar.headerForUrl(value);
  try { return liveCookieSnapshot.headerForUrl(value); }
  catch (error) {
    if (error.message === "cookie_sync_stale_refresh_chrome") throw new UrlImportDegradedError("requires_browser_auth", error.message);
    throw error;
  }
}

function authenticatedCookieHealth() {
  return {
    schema: CHROME_COOKIE_SNAPSHOT_SCHEMA,
    schema_version: CHROME_COOKIE_SNAPSHOT_SCHEMA_VERSION,
    configured: chromeCookieJar.health.configured,
    source: chromeCookieJar.health.source,
    cookie_count: chromeCookieJar.health.cookie_count,
    domain_count: chromeCookieJar.health.domain_count,
    skipped_count: chromeCookieJar.health.skipped_count,
    skipped_partitioned_count: chromeCookieJar.health.skipped_partitioned_count,
    skipped_expired_count: chromeCookieJar.health.skipped_expired_count,
    snapshot_generated_at: chromeCookieJar.health.snapshot_generated_at || null,
    snapshot_cookie_count: chromeCookieJar.health.snapshot_cookie_count || 0,
    fingerprint: chromeCookieJar.health.fingerprint,
    values_exposed: false
  };
}

async function fetchUrlImportDraft(requestedUrl) {
  if (youtubeVideoIdentity(requestedUrl)) {
    return fetchYoutubeSubtitleDraft(requestedUrl, { liveSnapshot: liveCookieSnapshot });
  }
  const fetched = await fetchUrlWithoutBrowser(requestedUrl, { cookieHeaderForUrl: runtimeCookieHeaderForUrl });
  const capturedAt = nowIso();
  return {
    requestedUrl: fetched.requestedUrl,
    finalUrl: fetched.finalUrl,
    redirectChain: fetched.redirectChain,
    fetchReceipt: fetched.fetchReceipt,
    draft: {
      id: `local-ir-url-${shortHash(fetched.finalUrl, 16)}`,
      url: fetched.finalUrl,
      title: fetched.title,
      pageText: fetched.isPlainText ? fetched.body : fetched.visibleText,
      html: fetched.isHtml ? fetched.body : "",
      annotations: [],
      qaCards: [],
      articleMusing: null,
      sourceType: "url_import",
      sourceMetadata: fetched.sourceMetadata,
      userInstruction: "",
      revision: 0,
      createdAt: capturedAt,
      updatedAt: capturedAt
    }
  };
}

async function writeBrowserDraftCommit(rawBody, destination = "reading", options = {}) {
  const rawUrl = String(rawBody?.draft?.url || "").trim();
  let lockKey = rawUrl;
  try {
    lockKey = new URL(rawUrl).href;
  } catch {
    // Invalid input is still serialized under its raw value and rejected by the core validator.
  }
  return withBrowserCommitLock(lockKey, () => writeBrowserDraftCommitUnlocked(rawBody, destination, options));
}

async function importUrlThroughStandardWorkflow(url, { userInstruction = "", destinationFolder = "", processingMode = 'standard_preprocess', processingOptions = {}, pendingInputPath = null, cachedRssDraft = null, onProgress } = {}) {
  if (!['standard_preprocess','original_text'].includes(processingMode)) throw new Error('unsupported_url_processing_mode');
  let fetched;
  if (pendingInputPath) {
    const savedPath = path.resolve(pendingInputPath);
    if (!savedPath.startsWith(path.resolve(browserPreprocessRoot) + path.sep) || path.basename(savedPath) !== "pending-source.json") throw new Error("invalid_pending_source_path");
    fetched = JSON.parse(await fs.readFile(savedPath, "utf8"));
    if (urlImportDedupeKey(fetched.requestedUrl) !== urlImportDedupeKey(url)) throw new Error("pending_source_identity_mismatch");
  } else if (cachedRssDraft) {
    fetched = { requestedUrl:url, finalUrl:url, redirectChain:[],
      draft:cachedRssDraft, fetchReceipt:{ source_reused:"retained_rss_fulltext", browser_tab_created:false } };
  } else fetched = await fetchUrlImportDraft(url);
  fetched.draft.userInstruction = String(userInstruction || "");
  fetched.draft.destinationFolder = normalizeRelativeDestinationFolder(destinationFolder);
  fetched.draft.processingOptions = structuredClone(processingOptions);
  let result;
  try {
    result = await writeBrowserDraftCommit({ draft: fetched.draft }, "reading", {
      standardize: processingMode==='standard_preprocess', onProgress, cachedRssMarkdown:fetched.draft.cachedRssMarkdown
    });
  } catch (error) {
    if (error.code === "needs_classification") {
      const frozenPath = path.join(error.details.preprocess_output_dir, "pending-source.json");
      await writeFileAtomic(frozenPath, JSON.stringify(fetched));
      error.details.pending_input_path = frozenPath;
    }
    throw error;
  }
  return {
    requested_url: fetched.requestedUrl,
    final_url: fetched.finalUrl,
    redirect_chain: fetched.redirectChain,
    status: result.receipt?.preprocess_status === "idempotent_replay"
      ? "idempotent_replay"
      : result.receipt?.quality_status === "warning" ? "imported_with_warnings" : "imported",
    artifacts: result.artifacts,
    source_metadata: result.source_metadata,
    warnings: result.warnings || [],
    receipt: {
      ...result.receipt,
      destination_folder: fetched.draft.destinationFolder || "浏览器高亮",
      ...fetched.fetchReceipt
    }
  };
}

async function replayExistingUrlImport(existing, requestedUrl, { processingMode = "standard_preprocess", processingOptions = {} } = {}) {
  if (!existing || !Array.isArray(existing.artifacts)) return null;
  const previous = existing.source_metadata?.standard_preprocess || {};
  const mode = existing.receipt?.processing_mode || (existing.source_metadata?.original_import ? "original_text" : "standard_preprocess");
  const plan = existing.receipt?.processing_plan || previous.processing_plan;
  if (mode !== processingMode || Object.entries(processingOptions).some(([key, value]) => typeof value === "boolean" && plan?.choices?.[key] && plan.choices[key].enabled !== value)) {
    throw new Error("既有文章的处理选项不同，已保留原文件；请通过当前页“重新导入”执行新选项。");
  }
  if (mode === "standard_preprocess") {
    const auditDir = previous.output_dir || existing.artifacts.find(item => item.kind === "standard_preprocess_audit")?.path;
    if (auditDir) {
      const audit = await fs.readFile(path.join(auditDir, "result.json"), "utf8").then(JSON.parse).catch(() => null);
      if (audit && !classifyStandardImportQuality(audit).admissible) throw new Error("既有导入缺少必需的译文或导读，不能复用为成功结果；请重新导入。");
    }
  }
  const markdownArtifact = existing.artifacts.find((item) => item?.kind === "markdown" && item?.path);
  if (!markdownArtifact) return null;
  const markdown = await fs.readFile(markdownArtifact.path, "utf8").catch(() => null);
  if (markdown === null || !markdown.trim()) return null;
  const currentSha256 = createHash("sha256").update(markdown).digest("hex");
  const recordedSha256 = String(markdownArtifact.sha256 || existing.receipt?.final_markdown_sha256 || "");
  if (recordedSha256 && recordedSha256 !== currentSha256) throw new Error("existing_article_changed_preserved");
  return {
    ...existing,
    requested_url: requestedUrl,
    status: "idempotent_replay",
    artifacts: existing.artifacts.map((item) => item?.kind === "markdown"
      ? { ...item, sha256: currentSha256 }
      : item),
    receipt: {
      ...existing.receipt,
      preprocess_status: "idempotent_replay",
      final_markdown_sha256: currentSha256,
      browser_tab_created: false,
      cookie_policy: "versioned_snapshot_cookie_matching_no_store",
      idempotent_replay_basis: "normalized_requested_url",
      existing_article_preserved: true
    },
    warnings: Array.isArray(existing.warnings) ? existing.warnings : existing.receipt?.warning_codes || [],
    errors: []
  };
}

async function findReadyDocumentStateImportForUrl(requestedUrl) {
  const requestedKey = urlImportDedupeKey(requestedUrl);
  const entries = await fs.readdir(browserStateRoot, { withFileTypes: true }).catch(() => []);
  const workspaceRoot = path.resolve(workflowRoot, "..", "..");
  const readingPrefix = `${path.resolve(readingRoot)}${path.sep}`;
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".browser-ir.json")) continue;
    const metadataPath = path.join(browserStateRoot, entry.name);
    let state;
    try {
      state = JSON.parse(await fs.readFile(metadataPath, "utf8"));
    } catch {
      continue;
    }
    const sourceMetadata = state?.browser?.sourceMetadata || {};
    const preprocess = sourceMetadata.standard_preprocess || {};
    const originalReady = sourceMetadata.original_import?.processing_mode === 'original_text' && sourceMetadata.original_import?.llm_used === false;
    const matchingUrl = [state?.document?.sourceUrl, sourceMetadata.source_url, sourceMetadata.canonical_url]
      .find((value) => value && urlImportDedupeKey(value) === requestedKey);
    const finalAttempt = Array.isArray(preprocess.workflow_attempts) ? preprocess.workflow_attempts.at(-1) : null;
    const fullyReady = new Set(["completed", "idempotent_replay"]).has(finalAttempt?.status)
      && finalAttempt?.processing_state === "rendered"
      && finalAttempt?.target_zone === "local-ir-reading";
    const warningReady = preprocess.quality_status === "warning"
      && finalAttempt?.status === "completed_with_warnings"
      && finalAttempt?.processing_state === "degraded"
      && finalAttempt?.target_zone === "preprocess-review";
    if (!matchingUrl
      || state?.document?.handoff?.state !== "ready"
      || (!originalReady && (!preprocess.material_id || !preprocess.idempotency_key || (!fullyReady && !warningReady)))) continue;

    const pathCandidates = readingDocumentPathCandidates({
      workflowRoot,
      readingRoot,
      storedDocumentPath: state.document.path
    });
    let markdownPath = null;
    let markdown = null;
    for (const candidate of [...new Set(pathCandidates)]) {
      if (!candidate.startsWith(readingPrefix)) continue;
      const contents = await fs.readFile(candidate, "utf8").catch(() => null);
      if (!contents?.trim()) continue;
      markdownPath = candidate;
      markdown = contents;
      break;
    }
    if (!markdown?.trim()) continue;
    const markdownSha256 = createHash("sha256").update(markdown).digest("hex");
    if (state.content?.markdownSha256 && state.content.markdownSha256 !== markdownSha256) throw new Error("existing_article_changed_preserved");
    return {
      requested_url: requestedUrl,
      final_url: String(sourceMetadata.canonical_url || matchingUrl),
      redirect_chain: [],
      status: warningReady ? "imported_with_warnings" : "imported",
      artifacts: [
        { kind: "markdown", path: markdownPath, sha256: markdownSha256 },
        { kind: "browser_ir_metadata", path: metadataPath },
        ...(preprocess.output_dir ? [{ kind: "standard_preprocess_audit", path: preprocess.output_dir }] : [])
      ],
      source_metadata: sourceMetadata,
      receipt: {
        processing_mode: originalReady ? 'original_text' : 'standard_preprocess',
        ...(originalReady ? {llm_used:false} : {}),
        preprocess_status: "completed",
        material_id: preprocess.material_id,
        idempotency_key: preprocess.idempotency_key,
        processor_version: preprocess.processor_version,
        prompt_version: preprocess.prompt_version,
        workflow_attempts: preprocess.workflow_attempts,
        quality_status: warningReady ? "warning" : "ready",
        readable_with_warnings: warningReady,
        warning_codes: Array.isArray(preprocess.warning_codes) ? preprocess.warning_codes : [],
        destination_folder: sourceMetadata.destination_folder || "浏览器高亮",
        final_markdown_sha256: markdownSha256,
        browser_tab_created: false,
        global_content_identity: "normalized_source_url"
      },
      errors: []
    };
  }
  return null;
}

async function processBackgroundImportWorker(requestId, workerIndex) {
  while (true) {
    const task = await browserImportBroker.claimTask(
      `local-background-url-fetcher-${workerIndex + 1}`,
      `background-${requestId}-${randomUUID()}`,
      { transport: BACKGROUND_FETCH_TRANSPORT, requestId }
    );
    if (!task) {
      const request = await browserImportBroker.getRequest(requestId);
      if (!request || request.terminal) break;
      await browserImportBroker.waitForTask(25000, { transport: BACKGROUND_FETCH_TRANSPORT });
      continue;
    }
    let currentStage = task.capture_mode === "page_snapshot" ? "capture_conversion" : "source_fetch";
    const onProgress = async ({ stage }) => {
      currentStage = stage;
      await browserImportBroker.updateTaskProgress(task.id, { status: "processing", stage }, task.lease_token);
    };
    const videoHeartbeat = setInterval(() => {
      onProgress({ stage: currentStage }).catch(() => {});
    }, 45000);
    try {
      await withBrowserCommitLock(`url-import:${urlImportDedupeKey(task.requested_url)}`, async () => {
        const retainedRss = task.capture_mode === "page_snapshot" && task.source === "rss_auto_import";
        if (task.capture_mode === "page_snapshot" && !retainedRss) {
          await onProgress({ stage: "capture_conversion" });
          const snapshot = await browserImportBroker.getTaskSnapshot(task.id);
          const result = await writeBrowserDraftCommit(snapshot, "reading", { standardize: true, onProgress });
          await browserImportBroker.completeTask(task.id, { ok: true, result, leaseToken: task.lease_token });
          return;
        }
        if (zhihuColumnIdentity(task.requested_url) && task.processing_mode !== 'original_text') {
          await processCollectionTask(task, {
            broker: browserImportBroker,
            discover: (value, onProgress) => discoverZhihuColumn(value, { cookieHeaderForUrl: runtimeCookieHeaderForUrl, onProgress }),
            runRequest: processBackgroundImportRequest
          });
          return;
        }
        const existing = await browserImportBroker.findSuccessfulResultForUrl(task.requested_url, {
          excludeTaskId: task.id
        }) || await findReadyDocumentStateImportForUrl(task.requested_url);
        const destinationFolder = importDestinationFolder({
          source: task.source,
          entryRoute: task.entry_route,
          destinationFolder: task.destination_folder,
          sourceUrl: task.requested_url
        });
        const existingSourceUrl = String(existing?.source_metadata?.source_url || "");
        const sourceIdentityMatches = existingSourceUrl
          && urlImportDedupeKey(existingSourceUrl) === urlImportDedupeKey(task.requested_url);
        // Source identity is global; a different entry route must not create another body.
        const replay = sourceIdentityMatches
          ? await replayExistingUrlImport(existing, task.requested_url, { processingMode: task.processing_mode, processingOptions: task.processing_options })
          : null;
        const result = replay || await importUrlThroughStandardWorkflow(task.requested_url, {
            userInstruction: task.user_instruction,
            destinationFolder,
            processingMode: task.processing_mode || 'standard_preprocess',
            processingOptions: task.processing_options || {},
            pendingInputPath: task.pending_input_path || null,
            cachedRssDraft: retainedRss ? (await browserImportBroker.getTaskSnapshot(task.id)).draft : null,
            onProgress
          });
        await browserImportBroker.completeTask(task.id, {
          ok: true,
          result,
          leaseToken: task.lease_token
        });
      });
    } catch (error) {
      if (error.code === "needs_classification") {
        await browserImportBroker.completeTask(task.id, {
          ok: false, degradedStatus: "needs_classification", error: error.message,
          result: { status: "needs_classification", requested_url: task.requested_url,
            receipt: { ...error.details, classification_reason: error.message, browser_tab_created: false },
            errors: [{ code: "needs_classification", message: error.message }] },
          leaseToken: task.lease_token
        });
      } else if (error instanceof UrlImportDegradedError) {
        await browserImportBroker.completeTask(task.id, {
          ok: false,
          degradedStatus: error.status,
          error: error.message,
          result: {
            status: error.status,
            requested_url: task.requested_url,
            final_url: error.details?.final_url || task.requested_url,
            redirect_chain: error.details?.redirect_chain || [],
            source_metadata: {
              source_url: task.requested_url,
              canonical_url: error.details?.final_url || task.requested_url,
              redirect_chain: error.details?.redirect_chain || [],
              response_status: error.details?.response_status || null,
              content_type: error.details?.content_type || null,
              content_integrity: error.details?.content_integrity || null,
              capture_agent: "local_background_url_fetch",
              fetch_transport: BACKGROUND_FETCH_TRANSPORT
            },
            receipt: {
              browser_tab_created: false,
              cookie_policy: "versioned_snapshot_cookie_matching_no_store"
            },
            errors: [{ code: error.status, message: error.message }]
          },
          leaseToken: task.lease_token
        });
      } else {
        await browserImportBroker.completeTask(task.id, {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
          result: {
            status: "failed",
            requested_url: task.requested_url,
            receipt: {
              browser_tab_created: false,
              cookie_policy: "versioned_snapshot_cookie_matching_no_store"
            },
            stage: error.details?.stage || currentStage,
            errors: [{ code: error.code || "background_url_import_failed", message: error instanceof Error ? error.message : String(error), details: error.details || null }]
          },
          leaseToken: task.lease_token
        });
      }
    } finally {
      if (videoHeartbeat) clearInterval(videoHeartbeat);
    }
  }
}

async function processBackgroundImportRequestUnlocked(requestId) {
  const request = await browserImportBroker.getRequest(requestId);
  const workerCount = Math.min(URL_IMPORT_CONCURRENCY, Math.max(1, Number(request?.requested || 1)));
  await Promise.all(Array.from({ length: workerCount }, (_unused, workerIndex) => (
    processBackgroundImportWorker(requestId, workerIndex)
  )));
  return browserImportBroker.getRequest(requestId);
}

async function processBackgroundImportRequest(requestId) {
  const key = String(requestId);
  const existing = backgroundImportRuns.get(key);
  if (existing) return existing;
  const run = processBackgroundImportRequestUnlocked(key).finally(() => {
    if (backgroundImportRuns.get(key) === run) backgroundImportRuns.delete(key);
  });
  backgroundImportRuns.set(key, run);
  return run;
}

async function submitSharedUrlImport(urls, {
  source = "unknown",
  clientRequestId = null,
  userInstruction = "",
  entryRoute = "",
  destinationFolder = "",
  processingOptions = {},
  wait = false
} = {}) {
  const request = await browserImportBroker.createRequest(urls, {
    source,
    clientRequestId,
    transport: BACKGROUND_FETCH_TRANSPORT,
    userInstruction,
    processingOptions,
    entryRoute: inferImportEntryRoute(source, entryRoute),
    destinationFolder: normalizeRelativeDestinationFolder(destinationFolder)
  });
  const run = processBackgroundImportRequest(request.request_id);
  return wait ? run : request;
}

async function resumePendingBackgroundImports() {
  const requestIds = await browserImportBroker.listPendingRequestIds({ transport: BACKGROUND_FETCH_TRANSPORT });
  for (const requestId of requestIds) {
    processBackgroundImportRequest(requestId).catch((error) => console.error(error));
  }
  return requestIds.length;
}

async function importUrlsThroughStandardWorkflow(rawBody) {
  const urls = Array.isArray(rawBody?.urls)
    ? extractUrls(rawBody.urls.join("\n"))
    : extractUrls(rawBody?.text || "");
  if (!urls.length) throw new Error("no_url_found");
  if (urls.length > 50) throw new Error("too_many_urls_max_50");
  return submitSharedUrlImport(urls, {
    source: String(rawBody?.source || "obsidian_local_ir"),
    clientRequestId: rawBody?.client_request_id || null,
    userInstruction: String(rawBody?.user_instruction || rawBody?.userInstruction || ""),
    entryRoute: String(rawBody?.entry_route || rawBody?.entryRoute || "obsidian"),
    destinationFolder: String(rawBody?.destination_folder || rawBody?.destinationFolder || ""),
    processingOptions: rawBody?.processing_options || {},
    wait: true
  });
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
  await fs.mkdir(stagingDir, { recursive: true });
  const optionsPath = path.join(stagingDir, "processing-options.json");
  await fs.writeFile(optionsPath, JSON.stringify(job.processingOptions || {}), "utf8");
  args.push("--processing-options", optionsPath);
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
  await log(job, `普通网页后台静默导入开始：${urls.length} 个链接`);
  const summary = await submitSharedUrlImport(urls, {
    source: "production_interaction",
    clientRequestId: `app-job-${job.id}`,
    userInstruction: importerInstruction(job),
    processingOptions: job.processingOptions || {},
    wait: true
  });
  await fs.mkdir(path.join(job.runDir, "web"), { recursive: true });
  await fs.writeFile(path.join(job.runDir, "web", "broker-receipt.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  for (const item of summary.results || []) {
    if (isSuccessfulImportItem(item)) job.outputs.push(item);
    else job.failures.push(item);
  }
  await log(job, `普通网页后台静默导入完成：成功 ${summary.imported || 0}，降级 ${summary.degraded || 0}，失败 ${summary.failed || 0}`);
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
      "Authorization": `Bearer ${config.DEEPSEEK_READING_API_KEY}`
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
  const youtubeUrls = urls.filter(url => youtubeVideoIdentity(url));
  if (youtubeUrls.length) {
    await log(job, `YouTube 字幕导入：${youtubeUrls.length} 个链接`);
    const request = await browserImportBroker.createRequest(youtubeUrls, {
      source: 'local-app-video', entryRoute: 'ai', destinationFolder: 'YouTube',
      userInstruction: importerInstruction(job), processingOptions: job.processingOptions || {}, transport: BACKGROUND_FETCH_TRANSPORT
    });
    await processBackgroundImportRequest(request.request_id);
    const summary = await browserImportBroker.getRequest(request.request_id);
    for (const result of summary.results) {
      const target = result.artifacts?.find(item => item.kind === 'markdown')?.path;
      if (target) job.outputs.push({ url: result.requested_url, status: result.status, method: 'youtube_subtitle_standard_preprocess', target, request_id: request.request_id });
      else job.failures.push({ url: result.requested_url, status: result.status, stage: 'youtube_subtitles', reason: result.error, request_id: request.request_id });
    }
  }
  for (const url of urls.filter(url => !youtubeVideoIdentity(url))) {
    const reason = "当前仅恢复 YouTube 现成字幕导入；其他视频与无字幕 ASR 仍暂停。";
    const target = await writeFailureReport({
      dir: path.join(job.runDir, "video-suspended"),
      url,
      stage: "video_suspended",
      reason,
      detail: "不要将无字幕视频的低质量 ASR 草稿写入阅读区。后续恢复条件见 docs/VIDEO_WORKFLOW_STATUS.md。"
    });
    job.failures.push({ url, status: "suspended", stage: "video_suspended", reason, target });
  }
  await log(job, "视频链接处理完成");
}

async function runJob(job) {
  job.status = "running";
  job.updatedAt = nowIso();
  job.runDir = path.join(appRunsRoot, job.id);
  await writeJob(job);

  try {
    const runName = `${today()}-app-import`;
    // The standard workflow resolves only missing classifications. Intake itself needs no model call.
    job.intent = fallbackIntent(job.instruction, job.urls);
    job.processingOptions = { ...(job.intent.processing.generateReadingGuide === false ? { include_reading_guide: false } : {}), ...job.processingOptions };
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

    job.status = job.failures.some(item => item.status === "needs_classification") ? "needs_classification" : job.failures.length ? "completed_with_failures" : "completed";
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

function readCookieSyncRequest(req, maxBytes = 48 * 1024) {
  return new Promise((resolve, reject) => {
    const declaredLength = Number(req.headers["content-length"] || 0);
    if (declaredLength > maxBytes) {
      reject(new Error("request_too_large"));
      req.resume();
      return;
    }
    const chunks = [];
    let totalBytes = 0;
    let rejected = false;
    req.on("data", (chunk) => {
      if (rejected) return;
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      totalBytes += bytes.byteLength;
      if (totalBytes > maxBytes) {
        rejected = true;
        reject(new Error("request_too_large"));
        return;
      }
      chunks.push(bytes);
    });
    req.on("end", () => {
      if (!rejected) resolve(Buffer.concat(chunks).toString("utf8"));
    });
    req.on("error", reject);
  });
}

function sendCookieSyncJson(res, status, data, origin = null) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    ...cookieSyncCorsHeaders(origin)
  });
  res.end(JSON.stringify(data));
}

function synchronizeUrlCookies(payload, origin) {
  if (payload?.schema === CHROME_COOKIE_JAR_SYNC_SCHEMA) {
    if (!legacyRuntimeCookieReplacementEnabled) throw new Error("cookie_sync_runtime_replacement_retired_use_snapshot");
    if (!String(origin || "").startsWith("chrome-extension://")) throw new Error("chrome_cookie_sync_extension_origin_required");
    const health = chromeCookieJar.replace(payload);
    return {
      status: "synchronized",
      schema: CHROME_COOKIE_JAR_SYNC_SCHEMA,
      cookie_count: health.cookie_count,
      domain_count: health.domain_count,
      skipped_count: health.skipped_count,
      skipped_partitioned_count: health.skipped_partitioned_count,
      skipped_expired_count: health.skipped_expired_count,
      fingerprint: health.fingerprint,
      persistence: {
        scope: "current_service_process",
        resync_required_after_restart: true
      },
      cookie_values_exposed: false
    };
  }
  if (origin !== URL_COOKIE_SETUP_ORIGIN) throw new Error("cookie_sync_legacy_setup_origin_required");
  const validated = validateCookieSyncPayload(payload);
  urlCookieConfig = mergeCookieSyncIntoProcessEnvironment(urlCookieConfig.cookies, validated.cookies, process.env);
  const cookieCount = validated.domains.reduce((sum, domain) => sum + domain.cookie_count, 0);
  const fingerprint = `sha256:${createHash("sha256").update(validated.domains.map((domain) => domain.fingerprint).sort().join("\n")).digest("hex")}`;
  return {
    status: "synchronized",
    schema: URL_COOKIE_SYNC_SCHEMA,
    cookie_count: cookieCount,
    domain_count: validated.domains.length,
    skipped_count: 0,
    fingerprint,
    persistence: {
      scope: "current_service_process",
      resync_required_after_restart: true
    },
    cookie_values_exposed: false
  };
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
      <p>请开启 Local IR Browser Highlight 的加工模式，然后选中这一整句话。成功时，页面会出现虚拟高亮，并且阅读区的浏览器高亮文件夹只会出现可直接阅读的 Markdown。</p>
      <p>你也可以从右往左选择这句话，检查反向选择是否能正常保存。</p>
      <ul>
        <li>目标目录：<code>阅读区/浏览器高亮</code></li>
        <li>保存格式：阅读区只保留 <code>文章.md</code>；Local IR 状态保存在项目内部目录。</li>
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
    .rss-panel, .learning-panel { grid-column: 1 / -1; }
    label { display: block; font-size: 13px; font-weight: 650; margin-bottom: 8px; color: #384253; }
    textarea, input, select { width: 100%; box-sizing: border-box; border: 1px solid #c9d0dc; border-radius: 6px; padding: 10px 12px; font: 14px/1.55 ui-monospace, SFMono-Regular, Consolas, monospace; }
    input[type="checkbox"] { width: auto; }
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
      <section class="learning-panel">
        <label>项目学习编排</label>
        <p class="hint">从 GitHub 仓库建立可恢复的学习项目：复用现有阅读导入，记录环境、先修关系、学习证据、下一任务与材料候选。</p>
        <div class="row">
          <div>
            <label for="learningRepo">GitHub 仓库</label>
            <input id="learningRepo" placeholder="https://github.com/owner/repo">
          </div>
          <div>
            <label for="learningGoal">实际成果目标</label>
            <input id="learningGoal" value="理解项目并完成一项可验证改动">
          </div>
        </div>
        <div class="toolbar">
          <label><input type="checkbox" id="learningClone" checked> 克隆可执行源码</label>
          <label><input type="checkbox" id="learningReading" checked> 导入 Markdown 阅读材料</label>
        </div>
        <div class="actions">
          <button id="learningCreate">创建学习项目</button>
          <button class="secondary" id="learningRefresh">刷新项目</button>
        </div>
        <div class="paths" id="learningProjects"></div>
        <pre id="learningOutput"></pre>
      </section>
      ${existsSync(path.join(workflowRoot, 'imports', 'subscriptions', 'active.json')) ? '<section class="rss-panel"><label>订阅管理</label><p><a href="/subscriptions">管理 RSS、B 站与知乎订阅</a></p><p class="hint">来源配置、队列和运行安排统一在订阅页；在 Markdown 日报、周报中勾选材料。</p></section>' : ''}
      <section class="rss-panel" ${existsSync(path.join(workflowRoot, 'imports', 'subscriptions', 'active.json')) ? 'hidden' : ''}>
        <label>RSS 运行状态</label>
        <p class="hint">本页只查看运行状态和生成摘要，不提供审批。长文唯一审批入口是摘要区中的最新 RSS 长文周报；短文周报直接进入阅读区。</p>
        <div class="actions">
          <button class="secondary" id="rssStatus">状态</button>
          <button class="secondary" id="rssQueue">刷新候选</button>
          <button id="rssDaily">生成今日增量</button>
          <button id="rssWeekly">生成本周周报</button>
          <button class="secondary" id="rssCanary">运行 Canary</button>
        </div>
        <div class="paths" id="rssQueueList"></div>
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
    const rssQueueList = document.getElementById('rssQueueList');
    const learningOutput = document.getElementById('learningOutput');
    const learningProjects = document.getElementById('learningProjects');
    const learningButtons = ['learningCreate', 'learningRefresh'].map(id => document.getElementById(id));
    const rssButtons = ['rssStatus', 'rssQueue', 'rssDaily', 'rssWeekly', 'rssCanary'].map(id => document.getElementById(id));
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
        '<strong>导读卡：</strong>' + (processing.generateReadingGuide === false ? '关闭' : processing.generateReadingGuide === true ? '开启' : '按材料类型'),
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
      if (data && Array.isArray(data.items)) {
        const ready = data.items.filter(item => item.review_preview && item.review_preview.status === 'ready').length;
        const blocked = data.items.filter(item => item.route === 'blocked').length;
        rssOutput.textContent = '长文候选 ' + data.items.length + ' 篇｜摘要卡就绪 ' + ready + ' 篇｜正文未就绪 ' + blocked + ' 篇。审批请前往摘要区最新 RSS 长文周报。';
        rssQueueList.innerHTML = data.items.map(item => (
          '<div class="item"><strong>' + escapeHtml(item.title || item.material_id) + '</strong>' +
          '<div class="muted">' + escapeHtml(item.route === 'blocked' ? '正文尚未就绪' : '长文候选') + '｜' + escapeHtml(item.decision === 'selected' ? (item.publication && item.publication.status === 'published' ? '已正式入库' : (item.publication_authorized ? '正在自动发布' : '历史已选，等待本次确认')) : item.decision === 'deferred' ? ('已入库，Later 至 ' + ((item.later && item.later.defer_until || '').slice(0, 10))) : item.decision === 'dismissed' ? '不保留' : '未决') + '</div>' +
          (item.review_preview && item.review_preview.core ? '<div><strong>一句话核心：</strong>' + escapeHtml(item.review_preview.core) + '</div>' : '') +
          (item.review_preview && item.review_preview.value_reason ? '<div><strong>为什么值得读：</strong>' + escapeHtml(({ high: '高', medium: '中', low: '低' }[item.review_preview.value_level] || '待判断') + '；' + item.review_preview.value_reason) + '</div>' : '') +
          (item.review_preview && item.review_preview.novelty ? '<div><strong>可能新增量：</strong>' + escapeHtml(item.review_preview.novelty) + '</div>' : '') +
          (item.review_preview && item.review_preview.reading_cost ? '<div><strong>预计阅读成本：</strong>' + escapeHtml(item.review_preview.reading_cost) + '｜<strong>建议读法：</strong>' + escapeHtml(item.review_preview.suggested_route || '待判断') + '</div>' : '') +
          (item.publication_failure ? '<div class="fail">自动发布失败：' + escapeHtml(item.publication_failure.message || item.publication_failure.error || '请在最新长文周报重新处理') + '</div>' : '') +
          (item.item_url ? '<div><a href="' + escapeHtml(item.item_url) + '" target="_blank" rel="noreferrer">查看原文</a></div>' : '') +
          '</div>'
        )).join('');
      } else if (data && data.outputs) {
        const daily = data.outputs.daily && (data.outputs.daily.path || data.outputs.daily);
        const longWeekly = data.outputs.long_weekly && (data.outputs.long_weekly.path || data.outputs.long_weekly);
        const shortWeekly = data.outputs.short_weekly && (data.outputs.short_weekly.path || data.outputs.short_weekly);
        rssOutput.textContent = 'RSS 产物已更新。\n长文日报：' + (daily || '本次无新增，不生成空文件') + '\n长文周报：' + (longWeekly || '本次未生成') + '\n短文周报：' + (shortWeekly || '本次无新增，不生成空文件');
      } else if (data && data.status) {
        rssOutput.textContent = data.status === 'passed' ? 'Canary 已通过。' : 'RSS 状态：' + data.status;
      } else {
        rssOutput.textContent = '操作已完成。';
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

    async function learningCall(path, body) {
      learningButtons.forEach(button => button.disabled = true);
      try {
        const res = await fetch(path, body ? {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body)
        } : undefined);
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'learning_project_failed');
        learningOutput.textContent = JSON.stringify(data, null, 2);
        if (Array.isArray(data.projects)) {
          learningProjects.innerHTML = data.projects.map(project => (
            '<div class="item"><strong>' + escapeHtml(project.title || project.id) + '</strong>' +
            '<div class="muted">' + escapeHtml((project.status || '') + ' / ' + (project.goal || '')) + '</div></div>'
          )).join('') || '<div class="item muted">还没有学习项目。</div>';
        }
        return data;
      } catch (error) {
        learningOutput.textContent = error.message;
      } finally {
        learningButtons.forEach(button => button.disabled = false);
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

    document.getElementById('rssStatus').addEventListener('click', () => rssCall('/api/rss-reading/status'));
    document.getElementById('rssQueue').addEventListener('click', () => rssCall('/api/rss-reading/queue'));
    document.getElementById('rssDaily').addEventListener('click', () => rssCall('/api/rss-reading/generate', { mode: 'daily' }).then(() => rssCall('/api/rss-reading/queue')));
    document.getElementById('rssWeekly').addEventListener('click', () => rssCall('/api/rss-reading/generate', { mode: 'weekly' }).then(() => rssCall('/api/rss-reading/queue')));
    document.getElementById('rssCanary').addEventListener('click', () => rssCall('/api/rss-reading/canary', {}));
    document.getElementById('learningRefresh').addEventListener('click', () => learningCall('/api/learning/projects'));
    document.getElementById('learningCreate').addEventListener('click', () => learningCall('/api/learning/projects', {
      repoUrl: document.getElementById('learningRepo').value,
      goal: document.getElementById('learningGoal').value,
      clone: document.getElementById('learningClone').checked,
      fetchReading: document.getElementById('learningReading').checked
    }).then(() => learningCall('/api/learning/projects')));
    renderInputPreview();
    if (!${existsSync(path.join(workflowRoot, 'imports', 'subscriptions', 'active.json'))}) rssCall('/api/rss-reading/queue');
    learningCall('/api/learning/projects');
  </script>
</body>
</html>`;
}

async function handle(req, res) {
  const url = new URL(req.url || "/", "http://127.0.0.1");
  if (await handleSubscriptions(req, res, workflowRoot)) return;
  if (req.method === 'POST' && url.pathname.startsWith('/api/rss-reading/') && existsSync(path.join(workflowRoot, 'imports', 'subscriptions', 'active.json'))) {
    return sendJson(res, 409, { error: '已切换统一订阅流程，请在 /subscriptions 管理订阅，并在 Markdown 报告中勾选材料。' });
  }
  if (url.pathname === COOKIE_STATUS_ENDPOINT && req.method === "GET") {
    liveCookieSnapshot.refresh();
    return sendJson(res, 200, { service: "local-ir-browser-highlight", schema: "local-ir.chrome-live-sync/v1",
      receiver_enabled: !configuredCookieSnapshotPath, ...liveCookieSnapshot.health() });
  }
  if (url.pathname === COOKIE_SNAPSHOT_ENDPOINT) {
    let origin = null;
    try {
      origin = cookieSyncOrigin(req);
      liveCookieSnapshot.validateOrigin(origin);
      if (req.method === "OPTIONS") {
        if (String(req.headers["access-control-request-method"] || "").toUpperCase() !== "POST") throw new Error("cookie_sync_preflight_method_not_allowed");
        if (String(req.headers["access-control-request-headers"] || "").split(",").some(value => value.trim() && value.trim().toLowerCase() !== "content-type")) throw new Error("cookie_sync_preflight_headers_not_allowed");
        res.writeHead(204, cookieSyncCorsHeaders(origin)); res.end(); return;
      }
      if (req.method !== "POST") return sendCookieSyncJson(res, 405, { error: "method_not_allowed" }, origin);
      validateCookieSyncContentType(req.headers["content-type"]);
      const raw = await readCookieSyncRequest(req, CHROME_COOKIE_JAR_MAX_SYNC_BYTES);
      let payload;
      try { payload = JSON.parse(raw); } catch { throw new Error("cookie_sync_invalid_json"); }
      return sendCookieSyncJson(res, 200, await liveCookieSnapshot.accept(payload, origin), origin);
    } catch (error) {
      const message = safeCookieSnapshotError(error);
      console.warn("cookie_snapshot_rejected", message);
      return sendCookieSyncJson(res, cookieSyncErrorStatus(error), { error: message }, origin);
    }
  }
  if (url.pathname === cookieSyncEndpoint && req.method === "OPTIONS") {
    let origin = null;
    try {
      origin = cookieSyncOrigin(req);
      if (String(req.headers["access-control-request-method"] || "").toUpperCase() !== "POST") {
        throw new Error("cookie_sync_preflight_method_not_allowed");
      }
      const requestedHeaders = String(req.headers["access-control-request-headers"] || "")
        .split(",")
        .map((value) => value.trim().toLowerCase())
        .filter(Boolean);
      if (requestedHeaders.length !== 1 || requestedHeaders[0] !== "content-type") {
        throw new Error("cookie_sync_preflight_headers_not_allowed");
      }
      res.writeHead(204, cookieSyncCorsHeaders(origin));
      res.end();
      return;
    } catch (error) {
      return sendCookieSyncJson(res, cookieSyncErrorStatus(error), { error: error.message }, origin);
    }
  }
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
  const importWebAssets = {
    "/import": ["browser-import-web/index.html", "text/html"],
    "/import/": ["browser-import-web/index.html", "text/html"],
    "/import/app.mjs": ["browser-import-web/app.mjs", "text/javascript"],
    "/import/client.mjs": ["browser-import-web/client.mjs", "text/javascript"],
    "/url-import-input.mjs": ["url-import-input.mjs", "text/javascript"],
    "/import/style.css": ["browser-import-web/style.css", "text/css"]
  };
  if (req.method === "GET" && Object.hasOwn(importWebAssets, url.pathname)) {
    const [asset, type] = importWebAssets[url.pathname];
    const content = await fs.readFile(path.join(__dirname, asset));
    res.writeHead(200, {
      "Content-Type": `${type}; charset=utf-8`,
      "Cache-Control": "no-store, max-age=0",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "Content-Security-Policy": "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'"
    });
    res.end(content);
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
    if (!(legacyRuntimeCookieReplacementEnabled && chromeCookieJar.health.source === "runtime_payload")) liveCookieSnapshot.refresh();
    return sendJson(res, 200, {
      status: "ok",
      service: "local-ir-browser-highlight",
      readingRoot,
      browserHighlightRoot,
      browserCompletedRoot,
      browserCompletedHighlightRoot,
      browserStateRoot,
      browserPreprocessRoot,
      importDestinationRouting: {
        configPath: importDestinationRoutesPath,
        schema: importDestinationRoutes.schema,
        routes: importDestinationRoutes.routes
      },
      standardImport: {
        processingModes: ['standard_preprocess','original_text'],
        draftEndpoint: "/api/highlights/import-local",
        draftAsyncSupported: true,
        requiredArtifactsBeforePublication: true,
        urlBatchEndpoint: "/api/highlights/import-local-urls",
        sharedRequestEndpoint: "/api/browser-import/requests",
        defaultTransport: BACKGROUND_FETCH_TRANSPORT,
        browserTabCreatedOnNormalPath: false,
        cookiePolicy: "versioned_local_snapshot_domain_hostonly_path_secure_expiry_matching",
        authenticatedFetch: authenticatedCookieHealth(),
        maxWorkflowAttempts: 1,
        processingOptionsSupported: true,
        classificationResumeEndpoint: "/api/browser-import/requests/:requestId/classification",
        processorVersion: standardPreprocessProcessorVersion,
        guideCoverageVersion: GUIDE_COVERAGE_VERSION,
        transportMaxAttempts: 3,
        serializedBySourceUrl: true,
        batchConcurrency: URL_IMPORT_CONCURRENCY,
        qualityStatuses: ["ready", "warning", "failed"],
        readableWarningCreatesMarkdown: true
      },
      cookieSync: {
        endpoint: cookieSyncEndpoint,
        schema: CHROME_COOKIE_JAR_SYNC_SCHEMA,
        legacySchema: URL_COOKIE_SYNC_SCHEMA,
        loopbackOnly: true,
        origin: "chrome-extension://<32-char-extension-id>",
        legacySetupOrigin: URL_COOKIE_SETUP_ORIGIN,
        maxCookies: CHROME_COOKIE_JAR_MAX_COOKIES,
        maxBodyBytes: CHROME_COOKIE_JAR_MAX_SYNC_BYTES,
        atomicReplace: true,
        partitionedCookies: "skipped_and_counted",
        state: { ...chromeCookieJar.health },
        persistence: "current_service_process",
        resyncRequiredAfterRestart: true,
        childProcessInheritance: false,
        cookieValuesExposed: false,
        runtimeReplacementEnabled: legacyRuntimeCookieReplacementEnabled,
        status: legacyRuntimeCookieReplacementEnabled ? "legacy_compatibility_enabled" : "retired_use_versioned_snapshot"
      },
      cookieSnapshot: {
        pathEnvironmentVariable: CHROME_COOKIE_SNAPSHOT_PATH_ENV,
        schema: CHROME_COOKIE_SNAPSHOT_SCHEMA,
        schemaVersion: CHROME_COOKIE_SNAPSHOT_SCHEMA_VERSION,
        ...liveCookieSnapshot.health(),
        state: authenticatedCookieHealth(),
        snapshotPathExposed: false,
        cookieValuesExposed: false
      },
      browserImportBroker: {
        createRequestEndpoint: "/api/browser-import/requests",
        claimTaskEndpoint: "/api/browser-import/tasks/claim",
        requestStatusEndpoint: "/api/browser-import/requests/:requestId",
        completeTaskEndpoint: "/api/browser-import/tasks/:taskId/complete",
        backgroundTransport: BACKGROUND_FETCH_TRANSPORT,
        extensionWorker: "retired",
        extensionClaimEnabled: false,
        maxTaskAttempts: DEFAULT_MAX_ATTEMPTS,
        claimLeaseMs: DEFAULT_LEASE_MS,
        batchConcurrency: URL_IMPORT_CONCURRENCY,
        idempotentRequestCreation: true,
        idempotentTaskClaim: true,
        executionContract: URL_IMPORT_EXECUTION_CONTRACT
      },
      now: nowIso()
    });
  }
  if (req.method === "GET" && url.pathname === "/api/browser-import/rules") {
    return sendJson(res, 200, IMPORT_RULES);
  }
  if (req.method === "POST" && url.pathname === cookieSyncEndpoint) {
    let origin = null;
    try {
      origin = cookieSyncOrigin(req);
      validateCookieSyncContentType(req.headers["content-type"]);
      const rawBody = await readCookieSyncRequest(req, CHROME_COOKIE_JAR_MAX_SYNC_BYTES);
      let payload;
      try {
        payload = JSON.parse(rawBody || "{}");
      } catch {
        throw new Error("cookie_sync_invalid_json");
      }
      return sendCookieSyncJson(res, 200, synchronizeUrlCookies(payload, origin), origin);
    } catch (error) {
      return sendCookieSyncJson(res, cookieSyncErrorStatus(error), { error: error.message }, origin);
    }
  }
  if (req.method === "POST" && url.pathname === "/api/highlights/capture") {
    try {
      const body = JSON.parse(await readRequest(req, { maxBytes: 8 * 1024 * 1024 }) || "{}");
      return sendJson(res, 200, await writeBrowserHighlightCapture(body));
    } catch (error) {
      return sendJson(res, importFailureHttpStatus(error), { error: error.message });
    }
  }
  if (req.method === "POST" && url.pathname === "/api/highlights/commit") {
    try {
      const body = JSON.parse(await readRequest(req, { maxBytes: 8 * 1024 * 1024 }) || "{}");
      return sendJson(res, 200, await writeBrowserDraftCommit(body, "reading", {
        processingOptions: browserCaptureProcessingOptions('save', body.processing_options || body.draft?.processingOptions)
      }));
    } catch (error) {
      return sendJson(res, importFailureHttpStatus(error), { error: error.message });
    }
  }
  if (req.method === "POST" && url.pathname === "/api/highlights/complete") {
    try {
      const body = JSON.parse(await readRequest(req, { maxBytes: 8 * 1024 * 1024 }) || "{}");
      return sendJson(res, 200, await writeBrowserDraftCommit(body, "completed", {
        processingOptions: browserCaptureProcessingOptions('save', body.processing_options || body.draft?.processingOptions)
      }));
    } catch (error) {
      return sendJson(res, importFailureHttpStatus(error), { error: error.message });
    }
  }
  if (req.method === "POST" && url.pathname === "/api/browser-import/requests") {
    try {
      const body = JSON.parse(await readRequest(req, { maxBytes: 1024 * 1024 }) || "{}");
      const urls = Array.isArray(body.urls) ? extractUrls(body.urls.join("\n")) : extractUrls(body.text || "");
      if (!urls.length) throw new Error("no_url_found");
      if (urls.length > 50) throw new Error("too_many_urls_max_50");
      let browserSnapshot = null;
      if (body.cached_rss_article != null) {
        assertLocalRequest(req);
        const cached = body.cached_rss_article;
        if (body.source !== "rss_auto_import" || urls.length !== 1 || typeof cached.markdown !== "string"
          || !cached.markdown.trim() || cached.markdown.length > 300000 || Buffer.byteLength(cached.markdown) > 700000) {
          throw new Error("invalid_retained_rss_article");
        }
        const url = urls[0];
        browserSnapshot = { draft: { url, title: String(cached.title || ""), sourceType:"url_import",
          cachedRssMarkdown:cached.markdown, sourceMetadata:{ source_url:url, canonical_url:url,
            published_at:typeof cached.published_at === "string" ? cached.published_at : null, source_is_original:true } } };
      }
      const request = await browserImportBroker.createRequest(urls, {
        source: String(body.source || "unknown"),
        clientRequestId: body.client_request_id || null,
        transport: BACKGROUND_FETCH_TRANSPORT,
        browserSnapshot,
        userInstruction: String(body.user_instruction || body.userInstruction || ""),
        entryRoute: inferImportEntryRoute(body.source, body.entry_route || body.entryRoute),
        destinationFolder: normalizeRelativeDestinationFolder(body.destination_folder || body.destinationFolder || ""),
        processingMode: body.processing_mode ?? 'standard_preprocess',
        processingOptions: body.processing_options || {}
      });
      if (request.transport === BACKGROUND_FETCH_TRANSPORT) processBackgroundImportRequest(request.request_id).catch((error) => console.error(error));
      return sendJson(res, 202, request);
    } catch (error) {
      return sendJson(res, 400, { error: error.message });
    }
  }
  if (req.method === "POST" && url.pathname === "/api/social-archive/zhihu/recent-likes") {
    try {
      const body = JSON.parse(await readRequest(req, { maxBytes: 64 * 1024 }) || "{}");
      if (body.action === "preview" || !body.action) {
        const inventory = body.since_epoch
          ? await discoverZhihuLikesSince({
              profileToken: body.profile_token,
              sinceEpoch: Number(body.since_epoch),
              maxPages: Number(body.max_pages || 200),
              cookieHeaderForUrl: runtimeCookieHeaderForUrl
            })
          : await discoverRecentZhihuLikes({
              profileToken: body.profile_token,
              limit: Number(body.limit || 10),
              cookieHeaderForUrl: runtimeCookieHeaderForUrl
            });
        return sendJson(res, 200, { status: "previewed", ...inventory });
      }
      const items = Array.isArray(body.items) ? body.items : [];
      if (!items.length || items.length > 50) throw new Error("frozen_zhihu_items_required");
      if (body.action === "verify") {
        const verification = await verifyZhihuLikesRemoved({
          profileToken: body.profile_token,
          removedItems: items,
          cookieHeaderForUrl: runtimeCookieHeaderForUrl
        });
        return sendJson(res, 200, { status: verification.status === "verified" ? "cleanup_verified" : "cleanup_unverified", verification });
      }
      if (body.action !== "unlike") throw new Error("zhihu_social_archive_action_invalid");
      const operations = await unlikeZhihuItems(items, {
        cookieHeaderForUrl: runtimeCookieHeaderForUrl,
        allowAccountMutation: body.allow_account_mutation === true
      });
      let verification;
      try {
        verification = await verifyZhihuLikesRemoved({
          profileToken: body.profile_token,
          removedItems: items,
          cookieHeaderForUrl: runtimeCookieHeaderForUrl
        });
      } catch (error) {
        return sendJson(res, 200, {
          status: "cleanup_applied_verification_failed",
          operations,
          verification_error: error.message
        });
      }
      if (verification.status !== "verified") {
        return sendJson(res, 200, {
          status: "cleanup_applied_verification_failed",
          operations,
          verification
        });
      }
      return sendJson(res, 200, {
        status: "cleanup_verified",
        operations,
        verification
      });
    } catch (error) {
      return sendJson(res, 400, { error: error.message });
    }
  }
  const classificationResumeMatch = url.pathname.match(/^\/api\/browser-import\/requests\/([^/]+)\/classification$/u);
  if (req.method === "POST" && classificationResumeMatch) {
    try {
      const body = JSON.parse(await readRequest(req, { maxBytes: 64 * 1024 }) || "{}");
      const resumed = await browserImportBroker.resumeClassification(decodeURIComponent(classificationResumeMatch[1]), { processingOptions: body.processing_options || {}, urls: body.urls || null });
      processBackgroundImportRequest(resumed.request_id).catch(error => console.error(error));
      return sendJson(res, 202, resumed);
    } catch (error) { return sendJson(res, 400, { error: error.message }); }
  }
  const browserImportRequestMatch = url.pathname.match(/^\/api\/browser-import\/requests\/([^/]+)$/u);
  if (req.method === "GET" && browserImportRequestMatch) {
    const request = await browserImportBroker.getRequest(decodeURIComponent(browserImportRequestMatch[1]));
    return request ? sendJson(res, 200, request) : sendJson(res, 404, { error: "browser_import_request_not_found" });
  }
  if (req.method === "GET" && url.pathname === "/api/browser-import/tasks/claim") {
    return sendJson(res, 200, {
      task: null,
      status: "extension_worker_retired",
      claim_enabled: false,
      claimable_statuses: []
    });
  }
  const browserImportCompleteMatch = url.pathname.match(/^\/api\/browser-import\/tasks\/([^/]+)\/complete$/u);
  if (req.method === "POST" && browserImportCompleteMatch) {
    try {
      const body = JSON.parse(await readRequest(req, { maxBytes: 1024 * 1024 }) || "{}");
      const request = await browserImportBroker.completeTask(decodeURIComponent(browserImportCompleteMatch[1]), {
        ok: body.ok === true,
        result: body.result || null,
        error: body.error || null,
        retryable: body.retryable === true,
        leaseToken: body.lease_token || null,
        degradedStatus: body.degraded_status || null
      });
      return sendJson(res, 200, request);
    } catch (error) {
      const status = error.message === "browser_import_task_not_found"
        ? 404
        : error.message === "browser_import_task_stale_lease" ? 409 : 400;
      return sendJson(res, status, { error: error.message });
    }
  }
  if (req.method === "POST" && url.pathname === "/api/highlights/import-local") {
    try {
      const body = JSON.parse(await readRequest(req, { maxBytes: 16 * 1024 * 1024 }) || "{}");
      body.processing_options = browserCaptureProcessingOptions('import', body.processing_options || body.draft?.processingOptions);
      if (body.async === true) {
        const parsed = new URL(String(body.draft?.url || ""));
        if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("unsupported_url_protocol");
        if (!body.draft?.html && !body.draft?.pageText) throw new Error("empty_page_content");
        const request = await browserImportBroker.createRequest([parsed.href], {
          source: "browser_page_snapshot", clientRequestId: body.client_request_id,
          processingOptions: body.processing_options || body.draft.processingOptions || {},
          browserSnapshot: { draft: body.draft, processing_options: body.processing_options || body.draft.processingOptions || {} }
        });
        processBackgroundImportRequest(request.request_id).catch(error => console.error(error));
        return sendJson(res, 202, request);
      }
      return sendJson(res, 200, await writeBrowserDraftCommit(body, "reading", { standardize: true }));
    } catch (error) {
      return sendJson(res, importFailureHttpStatus(error), { error: error.message, code: error.code, details: error.details });
    }
  }
  if (req.method === "POST" && url.pathname === "/api/highlights/import-local-urls") {
    try {
      const body = JSON.parse(await readRequest(req, { maxBytes: 1024 * 1024 }) || "{}");
      return sendJson(res, 200, await importUrlsThroughStandardWorkflow(body));
    } catch (error) {
      return sendJson(res, importFailureHttpStatus(error), { error: error.message });
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
  if (req.method === "GET" && url.pathname === "/api/learning/projects") {
    try {
      return sendJson(res, 200, { projects: await listLearningProjects(learningRoot) });
    } catch (error) {
      return sendJson(res, 500, { error: error.message });
    }
  }
  if (req.method === "POST" && url.pathname === "/api/learning/projects") {
    try {
      const body = JSON.parse(await readRequest(req) || "{}");
      return sendJson(res, 201, await createLearningProject({
        repoUrl: body.repoUrl,
        goal: body.goal,
        clone: body.clone === true,
        fetchReading: body.fetchReading === true,
        root: learningRoot
      }));
    } catch (error) {
      return sendJson(res, 400, { error: error.message });
    }
  }
  const learningMatch = /^\/api\/learning\/projects\/([^/]+)(?:\/(doctor|evidence|material|promote))?$/.exec(url.pathname);
  if (learningMatch) {
    try {
      const projectDir = await resolveProject(decodeURIComponent(learningMatch[1]), learningRoot);
      const action = learningMatch[2] || "status";
      if (req.method === "GET" && action === "status") return sendJson(res, 200, await getProjectStatus(projectDir));
      if (req.method !== "POST") return sendJson(res, 405, { error: "method_not_allowed" });
      const body = JSON.parse(await readRequest(req) || "{}");
      if (action === "doctor") return sendJson(res, 200, await doctorLearningProject(projectDir, { apply: body.apply === true }));
      if (action === "evidence") return sendJson(res, 200, await recordLearningEvidence(projectDir, body));
      if (action === "material") return sendJson(res, 200, await addMaterialCandidate(projectDir, body));
      if (action === "promote") return sendJson(res, 200, await promoteMaterialCandidate(projectDir, body.materialId, body.evidence));
      return sendJson(res, 404, { error: "learning_action_not_found" });
    } catch (error) {
      return sendJson(res, 400, { error: error.message });
    }
  }
  if (req.method === "GET" && url.pathname === "/api/rss-reading/status") {
    try {
      return sendJson(res, 200, await runRssReadingCli(["status"], { timeoutMs: 180000 }));
    } catch (error) {
      return sendJson(res, 500, { error: error.message });
    }
  }
  if (req.method === "GET" && url.pathname === "/api/rss-reading/queue") {
    try {
      return sendJson(res, 200, await runRssReadingCli(["queue"], { timeoutMs: 180000 }));
    } catch (error) {
      return sendJson(res, 500, { error: error.message });
    }
  }
  if (req.method === "POST" && url.pathname === "/api/rss-reading/generate") {
    try {
      const body = JSON.parse(await readRequest(req) || "{}");
      const args = ["generate"];
      if (body.mode) args.push("--mode", String(body.mode));
      if (body.skipSummaryIngest) args.push("--skip-summary-ingest");
      return sendJson(res, 200, await runRssReadingCli(args, { timeoutMs: 300000 }));
    } catch (error) {
      return sendJson(res, 500, { error: error.message });
    }
  }
  if (req.method === "POST" && url.pathname === "/api/rss-reading/canary") {
    try {
      return sendJson(res, 200, await runRssReadingCli(["canary"], { timeoutMs: 300000 }));
    } catch (error) {
      return sendJson(res, 500, { error: error.message });
    }
  }
  if (req.method === "POST" && url.pathname === "/api/rss-reading/decision") {
    try {
      const body = JSON.parse(await readRequest(req) || "{}");
      if (!body.materialId || !body.decision) return sendJson(res, 400, { error: "decision_requires_material_id_and_decision" });
      const args = ["decision", "--material-id", String(body.materialId), "--decision", String(body.decision)];
      return sendJson(res, 200, await runRssReadingCli(args, { timeoutMs: 1200000 }));
    } catch (error) {
      return sendJson(res, 400, { error: error.message });
    }
  }
  if (req.method === "POST" && url.pathname === "/api/rss-reading/publish") {
    try {
      const body = JSON.parse(await readRequest(req) || "{}");
      if (!body.materialId) return sendJson(res, 400, { error: "publish_requires_material_id" });
      return sendJson(res, 200, await runRssReadingCli(["publish", "--material-id", String(body.materialId)], { timeoutMs: 1200000 }));
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
        processingOptions: body.processing_options || {},
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
      const boundPort = server.address().port;
      const info = { url: `http://127.0.0.1:${boundPort}`, port: boundPort, startedAt: nowIso(), pid: process.pid };
      await fs.mkdir(importsRoot, { recursive: true });
      if (process.env.PROGRESSIVE_READING_WRITE_SERVER_INFO !== "false") {
        await fs.writeFile(path.join(importsRoot, "app-server.json"), `${JSON.stringify(info, null, 2)}\n`, "utf8");
      }
      console.log(`Progressive reading app: ${info.url}`);
      resolve(server);
    });
  });
}

async function start() {
  liveCookieSnapshot.refresh({ force: true });
  await migrateLegacyBrowserCompletedArtifacts();
  await listen(defaultPort);
  await resumePendingBackgroundImports();
  startSubscriptionWorker(workflowRoot);
}

start().catch((error) => {
  console.error(error);
  process.exit(1);
});
