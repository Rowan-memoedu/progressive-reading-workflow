import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import Parser from "rss-parser";
import sanitizeFilename from "sanitize-filename";
import TurndownService from "turndown";
import { gfm } from "turndown-plugin-gfm";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const workflowRoot = path.resolve(__dirname, "..");
const readingRoot = path.join(workflowRoot, "阅读区");
const importsRoot = path.join(workflowRoot, "imports");
const rssRoot = path.join(importsRoot, "rss");
const rssRunsRoot = path.join(rssRoot, "runs");
const rssFulltextRoot = path.join(rssRoot, "fulltext");
const rssSourceLayerRoot = path.join(rssRoot, "source-layer");
const rssSourceEntriesRoot = path.join(rssSourceLayerRoot, "entries");
const rssSourceConfigPath = path.join(rssRoot, "source-layer.json");
const statePath = path.join(rssRoot, "state.json");
const configDir = path.join(workflowRoot, "config");
const sourcesPath = path.join(configDir, "rss-sources.json");
const envPath = path.join(workflowRoot, ".env");
const envExamplePath = path.join(workflowRoot, ".env.example");
const composePath = path.join(workflowRoot, "docker-compose.rss.yml");
const importScript = path.join(__dirname, "import-web-md.mjs");
const dailyCmdPath = path.join(__dirname, "rss-sync-daily.cmd");
const pendingDir = path.join(readingRoot, "RSS", "待确认");
const finalDir = path.join(readingRoot, "RSS", "正式入库");
const shortWeeklyDir = path.join(readingRoot, "RSS", "短文周报");
const lowValueDir = path.join(readingRoot, "RSS", "低价值归档");
const discardedDir = path.join(rssRoot, "discarded");
const resolvedDigestsDir = path.join(rssRoot, "resolved-digests");
const bullettyToolRoot = path.join(rssRoot, "tools", "bulletty");
const bullettyLocalExe = path.join(bullettyToolRoot, "bulletty.exe");
const defaultBullettyDataDir = path.join(process.env.USERPROFILE || process.env.HOME || "", ".local", "share", "bulletty");
const producerConfigDir = path.join(process.env.USERPROFILE || process.env.HOME || "", "Documents", "New project");
const producerConfigKeys = ["AI_PRODUCER_BASE_URL", "AI_PRODUCER_API_KEY", "AI_PRODUCER_MODEL"];
const defaultShortThreshold = 1200;
const parser = new Parser({ timeout: 45000 });
const turndown = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced" });
turndown.use(gfm);

function nowIso() {
  return new Date().toISOString();
}

function localDate(date = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(date);
}

function localDateTime(date = new Date()) {
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).format(date);
}

function runStamp() {
  return localDateTime().replace(/[-:]/g, "").replace(" ", "-");
}

function safeName(value, fallback = "untitled") {
  const cleaned = sanitizeFilename(String(value || fallback))
    .replace(/\s+/g, " ")
    .trim();
  return (cleaned || fallback).slice(0, 120);
}

function yamlString(value) {
  return JSON.stringify(String(value ?? ""));
}

function hashText(value) {
  return createHash("sha256").update(String(value || "")).digest("hex");
}

function stripModelFences(text) {
  return String(text || "")
    .trim()
    .replace(/^```(?:json|markdown|md)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
}

function normalizeWhitespace(text) {
  return String(text || "").replace(/\r\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

function truncate(text, maxChars) {
  const value = String(text || "");
  return value.length > maxChars ? `${value.slice(0, maxChars)}\n...[truncated]` : value;
}

function stripMarkdownFrontmatter(text) {
  return String(text || "").replace(/^\s*(---|\+\+\+)\r?\n[\s\S]*?\r?\n\1\s*/u, "");
}

function cleanMarkdownForReading(text, { maxChars = 0 } = {}) {
  let value = stripMarkdownFrontmatter(text);
  value = value
    .replace(/^<!-- rss-source-meta\n[\s\S]*?\n-->\s*/u, "")
    .replace(/<!--[\s\S]*?-->/gu, "")
    .replace(/<script[\s\S]*?<\/script>/giu, "")
    .replace(/<style[\s\S]*?<\/style>/giu, "")
    .replace(/<details[\s\S]*?<\/details>/giu, "")
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+\n/g, "\n");
  const lines = value.split("\n").filter((raw) => {
    const line = raw.trim();
    if (!line) return true;
    if (/^(subscribe|unsubscribe|share this|view in browser|read online|privacy policy|terms of service)$/i.test(line)) return false;
    if (/^(订阅|取消订阅|分享|在浏览器中查看|阅读原文|阅读全文|广告|推广|点击查看)$/u.test(line)) return false;
    if (/^\[?(subscribe|unsubscribe|upgrade|sign up|log in|read more)\]?$/i.test(line.replace(/\W+/g, " ").trim())) return false;
    return true;
  });
  value = normalizeWhitespace(lines.join("\n"));
  return maxChars && value.length > maxChars ? truncate(value, maxChars) : value;
}

function meaningfulText(text) {
  return normalizeWhitespace(String(text || "")
    .replace(/https?:\/\/\S+/gu, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/gu, " ")
    .replace(/\[[^\]]*\]\([^)]*\)/gu, " ")
    .replace(/[#@][\p{L}\p{N}_-]+/gu, " ")
    .replace(/[^\p{L}\p{N}\s]/gu, " "));
}

function markdownLink(label, url) {
  const href = String(url || "").trim();
  if (!href) return "";
  const safeLabel = String(label || href).replace(/]/g, "\\]");
  return `[${safeLabel}](${href})`;
}

function htmlToMarkdown(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  if (!/[<][a-zA-Z!/]/.test(text)) return normalizeWhitespace(text);
  return normalizeWhitespace(turndown.turndown(text));
}

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) {
      out._.push(arg);
      continue;
    }
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) out[key] = true;
    else {
      out[key] = next;
      i += 1;
    }
  }
  return out;
}

function normalizeOptions(options = {}) {
  return {
    ...options,
    dryRun: Boolean(options.dryRun || options["dry-run"]),
    mockAi: Boolean(options.mockAi || options["mock-ai"]),
    noMiniflux: Boolean(options.noMiniflux || options["no-miniflux"]),
    noFulltext: Boolean(options.noFulltext || options["no-fulltext"]),
    installDocker: Boolean(options.installDocker || options["install-docker"]),
    backfillDays: options.backfillDays || options["backfill-days"],
    opencliTimeoutMs: options.opencliTimeoutMs || options["opencli-timeout-ms"],
    noSourceSync: Boolean(options.noSourceSync || options["no-source-sync"]),
    noBulletty: Boolean(options.noBulletty || options["no-bulletty"]),
    noInstall: Boolean(options.noInstall || options["no-install"]),
    threshold: Number(options.threshold || options["short-threshold"] || defaultShortThreshold)
  };
}

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch {
    return fallback;
  }
}

async function writeJson(file, data) {
  await ensureDir(path.dirname(file));
  await fs.writeFile(file, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

async function fileExists(file) {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

function parseDotEnv(text) {
  const env = {};
  for (const raw of String(text || "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (!match) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    env[match[1]] = value;
  }
  return env;
}

async function loadLocalEnv() {
  let fileEnv = {};
  try {
    fileEnv = parseDotEnv(await fs.readFile(envPath, "utf8"));
  } catch {
    fileEnv = {};
  }
  return { ...fileEnv, ...process.env };
}

function envValue(env, ...keys) {
  for (const key of keys) {
    if (env[key]) return env[key];
  }
  return "";
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

function killProcessTree(child) {
  if (!child?.pid) return;
  if (process.platform === "win32") {
    spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    return;
  }
  child.kill();
}

function runCommand(command, args = [], { cwd = workflowRoot, timeoutMs = 60000, env = process.env } = {}) {
  return new Promise((resolve) => {
    const executable = resolveCommand(command, env);
    const useShell = process.platform === "win32" && /\.(cmd|bat)$/i.test(executable);
    const child = useShell
      ? spawn([executable, ...args].map(windowsShellQuote).join(" "), [], { cwd, env, windowsHide: true, shell: true })
      : spawn(executable, args, { cwd, env, windowsHide: true });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      stderr += `\nTIMEOUT after ${timeoutMs}ms`;
      killProcessTree(child);
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: timedOut ? 124 : code, stdout, stderr, timedOut });
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: `${stderr}\n${error.message}` });
    });
  });
}

function windowsShellQuote(value) {
  const text = String(value);
  if (!/[()\s^&|<>"]/g.test(text)) return text;
  return `"${text.replace(/"/g, '""')}"`;
}

function resolveCommand(command, env = process.env) {
  if (process.platform !== "win32" || path.extname(command)) return command;
  const common = [
    command === "docker" ? "C:\\Program Files\\Docker\\Docker\\resources\\bin\\docker.exe" : "",
    command === "opencli" ? path.join(env.APPDATA || "", "npm", "opencli.cmd") : "",
    command === "agent-reach" ? path.join(env.APPDATA || "", "npm", "agent-reach.cmd") : ""
  ].filter(Boolean);
  for (const candidate of common) {
    if (existsSync(candidate)) return candidate;
  }
  const pathValue = env.Path || env.PATH || "";
  const pathExt = (env.PATHEXT || ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean);
  for (const dir of pathValue.split(";").filter(Boolean)) {
    for (const ext of pathExt) {
      const candidate = path.join(dir, `${command}${ext.toLowerCase()}`);
      if (existsSync(candidate)) return candidate;
      const upper = path.join(dir, `${command}${ext.toUpperCase()}`);
      if (existsSync(upper)) return upper;
    }
  }
  return command;
}

function parseJsonLoose(text) {
  const value = String(text || "").trim();
  if (!value) throw new Error("empty_json_output");
  try {
    return JSON.parse(stripModelFences(value));
  } catch {
    const start = value.indexOf("[");
    const end = value.lastIndexOf("]");
    if (start >= 0 && end > start) return JSON.parse(value.slice(start, end + 1));
    const objectStart = value.indexOf("{");
    const objectEnd = value.lastIndexOf("}");
    if (objectStart >= 0 && objectEnd > objectStart) return JSON.parse(value.slice(objectStart, objectEnd + 1));
    throw new Error("json_parse_failed");
  }
}

async function loadSources() {
  const config = await readJson(sourcesPath, { version: 1, sources: [] });
  return { version: config.version || 1, sources: Array.isArray(config.sources) ? config.sources : [] };
}

async function saveSources(config) {
  await writeJson(sourcesPath, config);
}

async function loadState() {
  const state = await readJson(statePath, { version: 1, entries: {} });
  return { version: state.version || 1, entries: state.entries || {}, sourceEntries: state.sourceEntries || {} };
}

async function saveState(state) {
  await writeJson(statePath, state);
}

function rssHubBase(env) {
  return String(env.RSSHUB_BASE_URL || `http://127.0.0.1:${env.RSSHUB_PORT || "1200"}`).replace(/\/+$/, "");
}

function sourceFeedUrl(source, env) {
  if (source.feedUrl) return source.feedUrl;
  if (source.rsshub?.enabled !== false && source.rsshub?.path) return `${rssHubBase(env)}${source.rsshub.path}`;
  return "";
}

function minifluxHeaders(env) {
  const headers = { "Content-Type": "application/json" };
  if (env.MINIFLUX_API_KEY) {
    headers["X-Auth-Token"] = env.MINIFLUX_API_KEY;
    return headers;
  }
  const user = envValue(env, "MINIFLUX_USERNAME", "MINIFLUX_ADMIN_USERNAME");
  const password = envValue(env, "MINIFLUX_PASSWORD", "MINIFLUX_ADMIN_PASSWORD");
  if (!user || !password) throw new Error("miniflux_credentials_missing");
  headers.Authorization = `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}`;
  return headers;
}

async function minifluxRequest(env, apiPath, options = {}) {
  const base = String(env.MINIFLUX_BASE_URL || `http://127.0.0.1:${env.MINIFLUX_PORT || "8080"}`).replace(/\/+$/, "");
  const response = await fetch(`${base}${apiPath}`, {
    ...options,
    headers: { ...minifluxHeaders(env), ...(options.headers || {}) },
    signal: AbortSignal.timeout(options.timeoutMs || 20000)
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`miniflux_${response.status}_${text.slice(0, 300)}`);
  if (!text.trim()) return {};
  return JSON.parse(text);
}

async function ensureMinifluxCategory(env, title = "Progressive Reading") {
  const categories = await minifluxRequest(env, "/v1/categories");
  const list = Array.isArray(categories) ? categories : categories.categories || [];
  const existing = list.find((item) => item.title === title);
  if (existing) return existing;
  try {
    return await minifluxRequest(env, "/v1/categories", {
      method: "POST",
      body: JSON.stringify({ title })
    });
  } catch {
    const refreshed = await minifluxRequest(env, "/v1/categories");
    const refreshedList = Array.isArray(refreshed) ? refreshed : refreshed.categories || [];
    const created = refreshedList.find((item) => item.title === title);
    if (created) return created;
    throw new Error("miniflux_category_create_failed");
  }
}

async function ensureMinifluxFeed(env, feedUrl) {
  const category = await ensureMinifluxCategory(env);
  const feeds = await minifluxRequest(env, "/v1/feeds");
  const list = Array.isArray(feeds) ? feeds : feeds.feeds || [];
  const existing = list.find((feed) => feed.feed_url === feedUrl);
  if (existing) return existing;
  await minifluxRequest(env, "/v1/feeds", {
    method: "POST",
    body: JSON.stringify({ feed_url: feedUrl, category_id: category.id })
  });
  const refreshed = await minifluxRequest(env, "/v1/feeds");
  const refreshedList = Array.isArray(refreshed) ? refreshed : refreshed.feeds || [];
  const created = refreshedList.find((feed) => feed.feed_url === feedUrl);
  if (!created) throw new Error("miniflux_feed_create_failed");
  return created;
}

async function fetchMinifluxEntries(source, env, feedUrl, options = {}) {
  const feed = await ensureMinifluxFeed(env, feedUrl);
  try {
    await minifluxRequest(env, `/v1/feeds/${feed.id}/refresh`, { method: "PUT", timeoutMs: 45000 });
  } catch {
    // Refresh support and timing vary; reading existing entries is still useful.
  }
  const limit = Number(options.limit || source.limit || 100);
  const data = await minifluxRequest(env, `/v1/feeds/${feed.id}/entries?limit=${limit}&order=published_at&direction=desc`);
  const entries = Array.isArray(data) ? data : data.entries || [];
  return entries.map((entry) => ({
    sourceId: source.id,
    sourceDisplayName: source.displayName || source.id,
    sourceType: source.type || "rss",
    platform: source.platform || "rss",
    platformId: entry.id ? `miniflux-${entry.id}` : "",
    title: entry.title || entry.url || "Untitled RSS item",
    url: entry.url || "",
    publishedAt: entry.published_at || entry.created_at || "",
    author: entry.author || feed.title || source.displayName || "",
    content: normalizeWhitespace(htmlToMarkdown(entry.content || entry.summary || "")),
    mediaUrls: [],
    raw: entry,
    fetchMethod: "miniflux_api"
  }));
}

async function fetchDirectFeed(source, env, feedUrl) {
  const response = await fetch(feedUrl, { signal: AbortSignal.timeout(45000) });
  const text = await response.text();
  if (!response.ok) throw new Error(`rss_fetch_${response.status}_${text.slice(0, 200)}`);
  if (/<!doctype html|<html[\s>]/i.test(text) && !/<rss|<feed/i.test(text)) {
    throw new Error("rss_fetch_returned_html");
  }
  const feed = await parser.parseString(text);
  return (feed.items || []).map((item) => {
    const content = item["content:encoded"] || item.content || item.summary || item.contentSnippet || "";
    return {
      sourceId: source.id,
      sourceDisplayName: source.displayName || feed.title || source.id,
      sourceType: source.type || "rss",
      platform: source.platform || "rss",
      platformId: item.guid || "",
      title: item.title || item.link || "Untitled RSS item",
      url: item.link || "",
      publishedAt: item.isoDate || item.pubDate || "",
      author: item.creator || item.author || feed.title || source.displayName || "",
      content: normalizeWhitespace(htmlToMarkdown(content)),
      mediaUrls: [],
      raw: item,
      fetchMethod: "direct_rss"
    };
  });
}

async function fetchOpenCliTweets(source, options = {}) {
  if (source.type !== "x-user" || !source.handle) throw new Error("opencli_source_not_x_user");
  const limit = Number(options.limit || source.limit || 100);
  const timeoutMs = Number(options.opencliTimeoutMs || 210000);
  const browserTimeoutSeconds = Math.max(90, Math.min(180, Math.floor(timeoutMs / 1000) - 10));
  const commandEnv = {
    ...process.env,
    OPENCLI_BROWSER_COMMAND_TIMEOUT: process.env.OPENCLI_BROWSER_COMMAND_TIMEOUT || String(browserTimeoutSeconds)
  };
  const result = await runCommand("opencli", [
    "twitter",
    "tweets",
    source.handle,
    "--limit",
    String(limit),
    "--page-delay",
    "1",
    "-f",
    "json"
  ], { timeoutMs, env: commandEnv });
  if (result.code !== 0) throw new Error(`opencli_${result.code}_${(result.stderr || result.stdout).slice(0, 500)}`);
  const rows = parseJsonLoose(result.stdout);
  const list = Array.isArray(rows) ? rows : rows.tweets || rows.items || [];
  return list.map((tweet) => ({
    sourceId: source.id,
    sourceDisplayName: source.displayName || source.handle,
    sourceType: source.type,
    platform: "x",
    platformId: tweet.id || "",
    title: firstLine(tweet.text) || tweet.url || `Tweet ${tweet.id || ""}`.trim(),
    url: tweet.url || (tweet.id ? `https://x.com/${source.handle}/status/${tweet.id}` : ""),
    publishedAt: tweet.created_at || tweet.createdAt || "",
    author: tweet.author || source.displayName || source.handle,
    content: normalizeWhitespace(tweet.text || ""),
    mediaUrls: [
      ...(Array.isArray(tweet.media_urls) ? tweet.media_urls : []),
      ...(Array.isArray(tweet.media_posters) ? tweet.media_posters : [])
    ].filter(Boolean),
    quotedTweet: tweet.quoted_tweet || null,
    metrics: {
      likes: tweet.likes,
      retweets: tweet.retweets,
      replies: tweet.replies,
      views: tweet.views
    },
    raw: tweet,
    fetchMethod: "opencli_twitter_tweets"
  }));
}

function firstLine(text) {
  return String(text || "").split(/\r?\n/).map((line) => line.trim()).find(Boolean) || "";
}

function normalizeUrl(value) {
  try {
    const url = new URL(value);
    for (const key of [...url.searchParams.keys()]) {
      if (/^utm_|^spm_|^vd_source$|^si$|^ref$/i.test(key)) url.searchParams.delete(key);
    }
    url.hash = "";
    return url.toString();
  } catch {
    return "";
  }
}

function isXUrl(value) {
  try {
    const host = new URL(value).hostname.replace(/^www\./, "");
    return host === "x.com" || host === "twitter.com";
  } catch {
    return false;
  }
}

function xStatusHandle(value) {
  try {
    const url = new URL(value);
    const host = url.hostname.replace(/^www\./, "");
    if (host !== "x.com" && host !== "twitter.com") return "";
    const [handle, status] = url.pathname.split("/").filter(Boolean);
    return status === "status" ? String(handle || "").toLowerCase() : "";
  } catch {
    return "";
  }
}

function xRetweetInfo(entry) {
  const text = firstLine(entry.content || entry.title || "");
  const match = /^RT @([A-Za-z0-9_]+):\s+(.+)/.exec(text);
  if (!match) return null;
  return {
    handle: match[1].toLowerCase(),
    text: match[2]
  };
}

function normalizeXTextForDedupe(text) {
  return String(text || "")
    .replace(/\u2026/g, " ")
    .replace(/https?:\/\/t\.co\/\S+/gi, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function xTextAlias(entry) {
  if (entry.platform !== "x" || !isXUrl(entry.url)) return null;
  const retweet = xRetweetInfo(entry);
  const urlHandle = xStatusHandle(entry.url);
  const handle = retweet?.handle || urlHandle;
  if (!handle) return null;
  if (retweet && urlHandle && retweet.handle !== urlHandle) return null;
  const text = normalizeXTextForDedupe(retweet?.text || entry.content || entry.title || "");
  if (text.length < 60) return null;
  return {
    key: `x-text:${entry.sourceId}:${handle}:${text.slice(0, 80)}`,
    isRetweet: Boolean(retweet)
  };
}

function entryCanonicalKey(entry) {
  const url = normalizeUrl(entry.url);
  if ((entry.platform === "rss" || entry.sourceType === "rss") && url) return `url:${url}`;
  if (entry.platform && entry.platformId) return `${entry.platform}:${entry.platformId}`;
  if (url) return `url:${url}`;
  return `hash:${hashText(`${entry.title}\n${entry.content}`).slice(0, 32)}`;
}

function attachEntryKey(entry) {
  const canonical = entryCanonicalKey(entry);
  return {
    ...entry,
    canonicalKey: canonical,
    key: `${entry.sourceId}:${hashText(canonical).slice(0, 16)}`
  };
}

function mergeDuplicateEntry(existing, rawEntry) {
  const sourceIds = [...new Set([...(existing.sourceIds || []), rawEntry.sourceId])];
  const existingAlias = xTextAlias(existing);
  const rawAlias = xTextAlias(rawEntry);
  const preferRaw =
    (existingAlias?.isRetweet && !rawAlias?.isRetweet)
    || ((rawEntry.content || "").length > (existing.content || "").length && rawAlias?.isRetweet !== true);
  const target = preferRaw ? { ...existing, ...rawEntry } : existing;
  Object.assign(existing, target);
  existing.sourceIds = sourceIds;
  existing.mergedCanonicalKeys = [...new Set([...(existing.mergedCanonicalKeys || []), rawEntry.canonicalKey])];
  if (!existing.mediaUrls?.length && rawEntry.mediaUrls?.length) existing.mediaUrls = rawEntry.mediaUrls;
  return existing;
}

function dedupeEntries(entries) {
  const byCanonical = new Map();
  const byXText = new Map();
  for (const rawEntry of entries.map(attachEntryKey)) {
    const alias = xTextAlias(rawEntry);
    const aliasExisting = alias ? byXText.get(alias.key) : null;
    const existing = byCanonical.get(rawEntry.canonicalKey) || aliasExisting;
    if (!existing) {
      const created = { ...rawEntry, sourceIds: [rawEntry.sourceId] };
      byCanonical.set(rawEntry.canonicalKey, created);
      if (alias) byXText.set(alias.key, created);
      continue;
    }
    mergeDuplicateEntry(existing, rawEntry);
    byCanonical.set(rawEntry.canonicalKey, existing);
    if (alias) byXText.set(alias.key, existing);
  }
  return [...new Set(byCanonical.values())];
}

function isAfterSince(entry, since) {
  if (!since) return true;
  if (!entry.publishedAt) return true;
  const date = new Date(entry.publishedAt);
  if (Number.isNaN(date.getTime())) return true;
  return date >= since;
}

function mockEntriesForSource(source) {
  return [
    {
      sourceId: source.id,
      sourceDisplayName: source.displayName || "Dan Koe",
      sourceType: source.type || "x-user",
      platform: source.platform || "x",
      platformId: "mock-001",
      title: "Super individual systems compound faster than scattered effort",
      url: `https://x.com/${source.handle || "thedankoe"}/status/mock001`,
      publishedAt: nowIso(),
      author: source.displayName || "Dan Koe",
      content: "Super individuals do not win by doing more random tasks. They win by turning repeatable insight, content, distribution, and product feedback into one tight operating system.",
      mediaUrls: [],
      raw: { mock: true },
      fetchMethod: "mock"
    },
    {
      sourceId: source.id,
      sourceDisplayName: source.displayName || "Dan Koe",
      sourceType: source.type || "x-user",
      platform: source.platform || "x",
      platformId: "mock-002",
      title: "AI creator companies need leverage, taste, and distribution",
      url: `https://x.com/${source.handle || "thedankoe"}/status/mock002`,
      publishedAt: nowIso(),
      author: source.displayName || "Dan Koe",
      content: "An AI creator company is not just automated posting. The leverage comes from combining taste, audience understanding, offers, and fast feedback loops.",
      mediaUrls: [],
      raw: { mock: true },
      fetchMethod: "mock"
    }
  ];
}

async function fetchSourceEntries(source, env, options, warnings) {
  if (options.mock) return mockEntriesForSource(source);
  const feedUrl = sourceFeedUrl(source, env);
  const errors = [];
  if (feedUrl && options.noMiniflux !== true) {
    try {
      return await fetchMinifluxEntries(source, env, feedUrl, options);
    } catch (error) {
      errors.push(`miniflux: ${error.message}`);
      warnings.push({ sourceId: source.id, stage: "miniflux", reason: error.message });
    }
  }
  if (feedUrl) {
    try {
      return await fetchDirectFeed(source, env, feedUrl);
    } catch (error) {
      errors.push(`direct_rss: ${error.message}`);
      warnings.push({ sourceId: source.id, stage: "direct_rss", reason: error.message });
    }
  }
  if (source.type === "x-user" && source.fallback?.opencli !== false) {
    try {
      return await fetchOpenCliTweets(source, options);
    } catch (error) {
      errors.push(`opencli: ${error.message}`);
    }
  }
  throw new Error(errors.join(" | ") || "no_fetch_backend_available");
}

function fallbackJudgment(entry, reason = "") {
  const core = firstLine(entry.content) || entry.title || "这一条需要人工快速判断。";
  return {
    id: entry.key,
    core: truncate(core, 180),
    value: reason ? "待判断" : "中",
    density: "中",
    should_import: "待确认",
    use_cases: "可作为渐进阅读候选，先看原文再决定是否沉淀。",
    pain_points: "帮助发现可转成卡片、工作流判断或内容素材的输入。",
    note: reason ? `AI 判断失败：${reason}` : ""
  };
}

async function generateEntryJudgments(entries, options = {}) {
  if (!entries.length) return new Map();
  if (options.mockAi) return new Map(entries.map((entry) => [entry.key, fallbackJudgment(entry)]));
  const config = await loadProducerConfig();
  const payloadEntries = entries.map((entry) => ({
    id: entry.key,
    source: entry.sourceDisplayName,
    title: entry.title,
    url: entry.url,
    publishedAt: entry.publishedAt,
    text: truncate(`${entry.title}\n\n${entry.content}`, 1600)
  }));
  const prompt = [
    "你要为 RSS 待确认日报中的每条内容生成紧凑判断。",
    "不要过滤条目，不要丢弃条目，不要新增外部事实，只基于输入文本判断。",
    "读者背景：正在搭建 RemNote、Codex、AI Agent、渐进阅读、卡片化沉淀和教育科技产品相关工作流；偏好高密度、可操作、可沉淀的材料，反感空泛总结和营销口号。",
    "",
    "请输出 JSON 数组。每个对象必须包含：",
    "- id：原样返回",
    "- core：中文一句话核心",
    "- value：高 / 中 / 低 / 跳过 / 待判断",
    "- density：高 / 中 / 低",
    "- should_import：急需 / 近期 / 可延后 / 可跳过 / 待确认",
    "- pain_points：它可能解决读者什么具体痛点，1 句",
    "- use_cases：它可用于什么具体沉淀方向，1 句",
    "- note：必要的注意事项，没有就空字符串",
    "",
    "RSS 条目：",
    JSON.stringify(payloadEntries, null, 2)
  ].join("\n");
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
        { role: "system", content: "你是渐进阅读 RSS 日报的筛选编辑，只输出可解析 JSON。" },
        { role: "user", content: prompt }
      ]
    }),
    signal: AbortSignal.timeout(180000)
  });
  if (!response.ok) throw new Error(`api_${response.status}_${(await response.text()).slice(0, 500)}`);
  const data = await response.json();
  const parsed = parseJsonLoose(data?.choices?.[0]?.message?.content || "");
  if (!Array.isArray(parsed)) throw new Error("ai_judgment_not_array");
  const byId = new Map();
  for (const item of parsed) {
    if (!item?.id) continue;
    byId.set(item.id, {
      id: item.id,
      core: String(item.core || "").trim(),
      value: String(item.value || "待判断").trim(),
      density: String(item.density || "待判断").trim(),
      should_import: String(item.should_import || "待确认").trim(),
      pain_points: String(item.pain_points || "").trim(),
      use_cases: String(item.use_cases || "").trim(),
      note: String(item.note || "").trim()
    });
  }
  return byId;
}

function originalText(entry) {
  const parts = [entry.content || ""];
  if (entry.quotedTweet) parts.push(`Quoted tweet:\n${JSON.stringify(entry.quotedTweet, null, 2)}`);
  if (entry.mediaUrls?.length) parts.push(`Media:\n${entry.mediaUrls.join("\n")}`);
  return normalizeWhitespace(parts.filter(Boolean).join("\n\n"));
}

function cleanEntryText(entry, options = {}) {
  return cleanMarkdownForReading(originalText(entry), options);
}

function shortEntryValue(entry) {
  const raw = cleanEntryText(entry, { maxChars: 2500 });
  const meaningful = meaningfulText(raw);
  const urlCount = (raw.match(/https?:\/\/\S+/gu) || []).length;
  const linkOnly = meaningful.length < 120 && urlCount > 0;
  const titleOnly = meaningful.length < 80 && meaningfulText(entry.title || "").length >= meaningful.length;
  const ctaLike = /subscribe|unsubscribe|upgrade|newsletter|sign up|read more|view in browser|订阅|取消订阅|阅读原文|阅读全文|推广/iu.test(raw);
  if (!meaningful) return { keep: false, reason: "empty_after_cleaning" };
  if (meaningful.length < 60) return { keep: false, reason: "too_short_after_cleaning" };
  if (linkOnly) return { keep: false, reason: "link_only" };
  if (titleOnly && ctaLike) return { keep: false, reason: "cta_or_title_only" };
  return { keep: true, reason: "readable_short_text", text: raw };
}

function visibleContentLength(entry) {
  return normalizeWhitespace(originalText(entry)
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/[#@][\p{L}\p{N}_-]+/gu, " "))
    .length;
}

function classifyEntry(entry, options = {}) {
  const textLength = visibleContentLength(entry);
  const raw = originalText(entry);
  const urlCount = (raw.match(/https?:\/\/\S+/g) || []).length;
  const linkOnly = textLength < 240 && urlCount > 0;
  const isSingleXPost = entry.platform === "x" || entry.sourceType === "x-user";
  const hasLongBody = textLength >= Number(options.threshold || defaultShortThreshold);
  const hasTranscript = /\b(transcript|podcast|full transcript)\b/i.test(`${entry.title}\n${raw}`);
  const kind = hasLongBody || hasTranscript ? "long" : "short";
  const reason = kind === "short"
    ? (isSingleXPost ? "single_x_post" : linkOnly ? "link_only" : `text_length_${textLength}`)
    : (hasTranscript ? "transcript_or_podcast" : `text_length_${textLength}`);
  return {
    kind: isSingleXPost && !hasLongBody && !hasTranscript ? "short" : kind,
    reason: isSingleXPost && !hasLongBody && !hasTranscript ? "single_x_post" : reason,
    textLength,
    linkOnly,
    threshold: Number(options.threshold || defaultShortThreshold)
  };
}

function isoWeekString(date = new Date()) {
  const value = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const day = value.getUTCDay() || 7;
  value.setUTCDate(value.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(value.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((value - yearStart) / 86400000) + 1) / 7);
  return `${value.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

function sourceEntryMeta(entry) {
  return {
    schema: "progressive-reading-rss-source-entry/v1",
    key: entry.key,
    canonicalKey: entry.canonicalKey,
    sourceId: entry.sourceId,
    sourceIds: entry.sourceIds || [entry.sourceId],
    sourceDisplayName: entry.sourceDisplayName || entry.sourceId,
    sourceType: entry.sourceType || "rss",
    platform: entry.platform || "rss",
    platformId: entry.platformId || "",
    title: entry.title || "",
    url: entry.url || "",
    publishedAt: entry.publishedAt || "",
    author: entry.author || "",
    mediaUrls: entry.mediaUrls || [],
    fetchMethod: entry.fetchMethod || "",
    contentHash: hashText(originalText(entry))
  };
}

function sourceEntryMarkdown(entry) {
  const meta = sourceEntryMeta(entry);
  const title = entry.title || entry.url || entry.key;
  const content = originalText(entry) || entry.content || "";
  return [
    "<!-- rss-source-meta",
    JSON.stringify(meta, null, 2),
    "-->",
    "",
    `# ${title}`,
    "",
    content
  ].join("\n").trim() + "\n";
}

function stripSourceMeta(text) {
  const match = /^<!-- rss-source-meta\n([\s\S]*?)\n-->\s*/.exec(String(text || ""));
  if (!match) return { meta: null, body: String(text || "") };
  return {
    meta: JSON.parse(match[1]),
    body: String(text || "").slice(match[0].length)
  };
}

async function writeSourceEntry(entry, options = {}) {
  const dated = entry.publishedAt && !Number.isNaN(new Date(entry.publishedAt).getTime())
    ? localDate(new Date(entry.publishedAt))
    : localDate();
  const sourceDir = path.join(rssSourceEntriesRoot, safeName(entry.sourceId || "rss"));
  const filename = `${dated} - ${safeName(entry.title || entry.key)} - ${hashText(entry.key).slice(0, 10)}.md`;
  const target = path.join(sourceDir, filename);
  await ensureDir(sourceDir);
  if (!options.force && existsSync(target)) return { path: target, written: false };
  await fs.writeFile(target, sourceEntryMarkdown(entry), "utf8");
  return { path: target, written: true };
}

async function parseSourceEntryFile(file) {
  const text = await fs.readFile(file, "utf8");
  const { meta, body } = stripSourceMeta(text);
  if (!meta?.key) return null;
  const content = normalizeWhitespace(body.replace(/^# .+?\n+/, ""));
  return attachEntryKey({
    sourceId: meta.sourceId,
    sourceIds: meta.sourceIds || [meta.sourceId],
    sourceDisplayName: meta.sourceDisplayName || meta.sourceId,
    sourceType: meta.sourceType || "rss",
    platform: meta.platform || "rss",
    platformId: meta.platformId || "",
    title: meta.title || "",
    url: meta.url || "",
    publishedAt: meta.publishedAt || "",
    author: meta.author || "",
    content,
    mediaUrls: meta.mediaUrls || [],
    raw: { sourceLayerPath: file },
    fetchMethod: meta.fetchMethod || "source_layer",
    sourceLayerPath: file
  });
}

async function readSourceLayerEntries(options = {}) {
  const files = await findMarkdownFiles(rssSourceEntriesRoot);
  const parsed = [];
  for (const file of files) {
    try {
      const entry = await parseSourceEntryFile(file);
      if (!entry) continue;
      if (options.source && entry.sourceId !== options.source) continue;
      parsed.push(entry);
    } catch {
      // Broken source-layer files are ignored here; sync runs keep raw failures under imports/rss/runs.
    }
  }
  return parsed;
}

function parseSimpleTomlValue(value) {
  const trimmed = String(value || "").trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function parseBullettyMeta(text) {
  const match = /^(\+\+\+|---)\n([\s\S]*?)\n\1\s*/.exec(String(text || ""));
  if (!match) return { meta: {}, body: String(text || "") };
  const meta = {};
  for (const raw of match[2].split(/\r?\n/)) {
    const line = raw.trim();
    const pair = /^([A-Za-z0-9_-]+)\s*=\s*(.+)$/.exec(line) || /^([A-Za-z0-9_-]+):\s*(.+)$/.exec(line);
    if (pair) meta[pair[1]] = parseSimpleTomlValue(pair[2]);
  }
  return { meta, body: String(text || "").slice(match[0].length) };
}

async function readBullettyEntries(options = {}) {
  const sourceConfig = await readJson(rssSourceConfigPath, {});
  const roots = [...new Set([sourceConfig.bullettyDataDir, defaultBullettyDataDir].filter(Boolean))];
  const entries = [];
  for (const root of roots) {
    if (!existsSync(root)) continue;
    const files = (await findMarkdownFiles(root)).filter((file) => {
      const base = path.basename(file).toLowerCase();
      return base !== "about.md" && !base.startsWith(".");
    });
    for (const file of files) {
      try {
        const text = await fs.readFile(file, "utf8");
        const { meta, body } = parseBullettyMeta(text);
        const title = meta.title || (/^#\s+(.+)$/m.exec(body)?.[1]) || path.basename(file, ".md");
        const url = meta.url || meta.link || meta.source || "";
        const publishedAt = meta.published || meta.published_at || meta.date || "";
        const sourceName = path.basename(path.dirname(file));
        const sourceId = `bulletty-${hashText(sourceName).slice(0, 10)}`;
        if (options.source && options.source !== sourceId) continue;
        entries.push(attachEntryKey({
          sourceId,
          sourceDisplayName: sourceName,
          sourceType: "rss",
          platform: "rss",
          platformId: meta.id || meta.guid || "",
          title,
          url,
          publishedAt,
          author: meta.author || sourceName,
          content: normalizeWhitespace(body.replace(/^# .+?\n+/, "")),
          mediaUrls: [],
          raw: { bullettyPath: file },
          fetchMethod: "bulletty_markdown",
          sourceLayerPath: file
        }));
      } catch {
        // Bulletty is a user-facing local library; skip files we cannot parse safely.
      }
    }
  }
  return entries;
}

async function readSourceEntryMarkdown(record) {
  const file = record?.sourceLayerPath || record?.entry?.sourceLayerPath || record?.entry?.raw?.sourceLayerPath || "";
  if (!file || !(await fileExists(file))) return "";
  const text = await fs.readFile(file, "utf8");
  const { body } = stripSourceMeta(text);
  return normalizeWhitespace(body.replace(/^# .+?\n+/, ""));
}

async function uniquePath(dir, filename) {
  await ensureDir(dir);
  const ext = path.extname(filename);
  const stem = filename.slice(0, filename.length - ext.length);
  let candidate = path.join(dir, filename);
  let index = 2;
  while (existsSync(candidate)) {
    candidate = path.join(dir, `${stem} ${index}${ext}`);
    index += 1;
  }
  return candidate;
}

async function findExecutableUnder(dir, name) {
  if (!existsSync(dir)) return "";
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const found = await findExecutableUnder(full, name);
      if (found) return found;
    } else if (entry.name.toLowerCase() === name.toLowerCase()) {
      return full;
    }
  }
  return "";
}

async function probeBulletty(candidate) {
  const result = await runCommand(candidate, ["help"], { timeoutMs: 20000 });
  if (result.code !== 0) return { available: false, binary: candidate, detail: (result.stderr || result.stdout || "").trim() };
  return { available: true, binary: candidate, detail: (result.stdout || result.stderr || "").split(/\r?\n/).slice(0, 3).join("\n").trim() };
}

async function detectBulletty() {
  const sourceConfig = await readJson(rssSourceConfigPath, {});
  const localFound = await findExecutableUnder(bullettyToolRoot, "bulletty.exe");
  const candidates = [
    process.env.BULLETTY_EXE,
    sourceConfig.bullettyBinary,
    localFound,
    bullettyLocalExe,
    "bulletty"
  ].filter(Boolean);
  const tried = [];
  for (const candidate of [...new Set(candidates)]) {
    const result = await probeBulletty(candidate);
    tried.push(result);
    if (result.available) return { ...result, tried };
  }
  return { available: false, binary: "", detail: "bulletty_not_available", tried };
}

function psLiteral(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

async function installBullettyLocal() {
  await ensureDir(bullettyToolRoot);
  const api = await fetch("https://api.github.com/repos/CrociDB/bulletty/releases/latest", {
    headers: { "User-Agent": "progressive-reading-rss-workflow" },
    signal: AbortSignal.timeout(60000)
  });
  if (!api.ok) throw new Error(`bulletty_release_api_${api.status}_${(await api.text()).slice(0, 300)}`);
  const release = await api.json();
  const asset = (release.assets || []).find((item) => /x86_64-pc-windows-msvc\.zip$/i.test(item.name || ""));
  if (!asset?.browser_download_url) throw new Error("bulletty_windows_asset_not_found");
  const zipPath = path.join(bullettyToolRoot, asset.name);
  const download = await fetch(asset.browser_download_url, {
    headers: { "User-Agent": "progressive-reading-rss-workflow" },
    signal: AbortSignal.timeout(180000)
  });
  if (!download.ok) throw new Error(`bulletty_download_${download.status}_${(await download.text()).slice(0, 300)}`);
  await fs.writeFile(zipPath, Buffer.from(await download.arrayBuffer()));
  const extractDir = path.join(bullettyToolRoot, release.tag_name || "latest");
  await ensureDir(extractDir);
  const expand = await runCommand("powershell.exe", [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
    `Expand-Archive -LiteralPath ${psLiteral(zipPath)} -DestinationPath ${psLiteral(extractDir)} -Force`
  ], { timeoutMs: 180000 });
  if (expand.code !== 0) throw new Error(`bulletty_extract_${expand.code}_${expand.stderr || expand.stdout}`);
  const exe = await findExecutableUnder(extractDir, "bulletty.exe");
  if (!exe) throw new Error("bulletty_exe_not_found_after_extract");
  return { binary: exe, version: release.tag_name || "", zipPath, extractDir, asset: asset.name };
}

async function detectBullettyDataDir(binary) {
  if (binary) {
    const result = await runCommand(binary, ["dirs"], { timeoutMs: 20000 });
    const text = `${result.stdout}\n${result.stderr}`;
    const line = text.split(/\r?\n/).find((item) => /bulletty/i.test(item) && /data|share|AppData|\.local/i.test(item));
    const match = line && /([A-Za-z]:\\[^\r\n]+|\/[^\r\n]+)/.exec(line);
    if (match) return match[1].trim();
  }
  return defaultBullettyDataDir;
}

async function runSourceSetup(options = {}) {
  options = normalizeOptions(options);
  await ensureRuntimeFiles();
  const before = await detectBulletty();
  let install = null;
  if (!before.available && !options.noInstall) {
    install = await installBullettyLocal();
  }
  const after = await detectBulletty();
  const dataDir = await detectBullettyDataDir(after.available ? after.binary : "");
  const config = {
    version: 1,
    updatedAt: nowIso(),
    provider: "bulletty",
    available: after.available,
    bullettyBinary: after.binary || install?.binary || "",
    bullettyDataDir: dataDir,
    localSourceLayerDir: rssSourceEntriesRoot,
    install,
    lastProbe: after
  };
  await writeJson(rssSourceConfigPath, config);
  return {
    status: after.available ? "ok" : "degraded",
    provider: "bulletty",
    binary: config.bullettyBinary,
    dataDir,
    localSourceLayerDir: rssSourceEntriesRoot,
    installed: Boolean(install),
    probe: after
  };
}

async function syncBullettySource(source, bulletty, warnings) {
  if (!bulletty.available || !source.feedUrl) return null;
  const add = await runCommand(bulletty.binary, ["add", source.feedUrl, source.displayName || "Progressive Reading"], { timeoutMs: 60000 });
  if (add.code !== 0 && !/already|exists|duplicate/i.test(`${add.stdout}\n${add.stderr}`)) {
    warnings.push({ sourceId: source.id, stage: "bulletty_add", reason: (add.stderr || add.stdout).slice(0, 300) });
  }
  const attempts = [];
  for (const args of [["sync"], ["update"], ["refresh"]]) {
    const result = await runCommand(bulletty.binary, args, { timeoutMs: 120000 });
    attempts.push({ args, code: result.code, stdout: result.stdout.slice(0, 300), stderr: result.stderr.slice(0, 300) });
    if (result.code === 0) return { add, sync: attempts };
  }
  warnings.push({ sourceId: source.id, stage: "bulletty_sync", reason: "no_noninteractive_sync_command_succeeded" });
  return { add, sync: attempts };
}

async function runSourceSync(options = {}) {
  options = normalizeOptions(options);
  await ensureRuntimeFiles();
  const runId = `${runStamp()}-source-${randomUUID().slice(0, 8)}`;
  const runDir = path.join(rssRunsRoot, runId);
  await ensureDir(runDir);
  const env = await loadLocalEnv();
  const config = await loadSources();
  const state = await loadState();
  const selectedSources = config.sources.filter((source) => source.enabled !== false && (!options.source || source.id === options.source));
  const failures = [];
  const warnings = [];
  const fetched = [];
  const bulletty = options.noBulletty ? { available: false, binary: "", detail: "disabled" } : await detectBulletty();

  for (const source of selectedSources) {
    try {
      if (source.type === "rss" && source.feedUrl && bulletty.available) {
        await syncBullettySource(source, bulletty, warnings);
      }
      const entries = await fetchSourceEntries(source, env, { ...options, noMiniflux: true }, warnings);
      const backfillDays = Number(options.backfillDays || source.backfillDays || 30);
      const since = new Date(Date.now() - backfillDays * 24 * 60 * 60 * 1000);
      fetched.push(...entries.filter((entry) => isAfterSince(entry, since)));
    } catch (error) {
      failures.push({ sourceId: source.id, stage: "source_fetch", reason: error.message });
    }
  }

  const deduped = dedupeEntries(fetched);
  const written = [];
  const skipped = [];
  for (const entry of deduped) {
    try {
      const result = await writeSourceEntry(entry, { force: options.force });
      const record = {
        key: entry.key,
        canonicalKey: entry.canonicalKey,
        sourceId: entry.sourceId,
        sourceDisplayName: entry.sourceDisplayName,
        title: entry.title,
        url: entry.url,
        publishedAt: entry.publishedAt,
        sourceLayerPath: result.path,
        sourceSyncedAt: nowIso()
      };
      state.sourceEntries[entry.key] = { ...(state.sourceEntries[entry.key] || {}), ...record };
      (result.written ? written : skipped).push(record);
    } catch (error) {
      failures.push({ sourceId: entry.sourceId, entryKey: entry.key, stage: "source_write", reason: error.message });
    }
  }

  await saveState(state);
  await writeJson(path.join(runDir, "fetched.json"), fetched);
  await writeJson(path.join(runDir, "source-written.json"), written);
  await writeJson(path.join(runDir, "failures.json"), { failures, warnings });
  const result = {
    status: failures.length ? "completed_with_failures" : "completed",
    runDir,
    sources: selectedSources.map((source) => source.id),
    fetchedCount: fetched.length,
    writtenCount: written.length,
    skippedCount: skipped.length,
    sourceLayerDir: rssSourceEntriesRoot,
    bulletty: { available: bulletty.available, binary: bulletty.binary || "" },
    failures,
    warnings
  };
  await writeJson(path.join(runDir, "run.json"), result);
  return result;
}

async function moveExistingToLegacy(target, runDir) {
  if (!target || !existsSync(target)) return "";
  const legacyDir = path.join(runDir || rssRunsRoot, "legacy-output");
  const legacyPath = await uniquePath(legacyDir, path.basename(target));
  await fs.rename(target, legacyPath);
  return legacyPath;
}

function extractDigestSelections(text) {
  const selections = { byKey: new Map(), byUrl: new Map() };
  const chunks = String(text || "")
    .split(/(?=^###\s+\d+\.|^<!-- rss-entry:start)/mu)
    .map((item) => item.trim())
    .filter(Boolean);
  for (const chunk of chunks) {
    const key = /rss-entry:start\s+([^>\s]+)\s*-->/u.exec(chunk)?.[1]
      || /rss-entry:([^>\s]+)\s*-->/u.exec(chunk)?.[1]
      || /rss-entry-key:([^>]+)-->/u.exec(chunk)?.[1]?.trim()
      || "";
    const url = /\[原文链接\]\(([^)]+)\)/u.exec(chunk)?.[1]
      || /-\s*链接：\s*(\S+)/u.exec(chunk)?.[1]
      || "";
    const selection = {
      importChecked: /-\s*\[[xX]\]\s*正式入库/u.test(chunk),
      deleteChecked: /-\s*\[[xX]\]\s*删除/u.test(chunk)
    };
    if (key) selections.byKey.set(key, selection);
    if (url && url !== "无") selections.byUrl.set(normalizeUrl(url), selection);
  }
  return selections;
}

function selectionForEntry(entry, selections) {
  const byUrl = entry.url ? selections.byUrl.get(normalizeUrl(entry.url)) : null;
  const byKey = selections.byKey.get(entry.key);
  return byUrl || byKey || { importChecked: false, deleteChecked: false };
}

function checkboxLine(label, checked) {
  return `- [${checked ? "x" : " "}] ${label}`;
}

function digestEntryBlock(entry, index, selection = {}) {
  const judgment = entry.judgment || fallbackJudgment(entry);
  const title = entry.title || entry.url || entry.key;
  const link = markdownLink("原文链接", entry.url);
  return [
    `### ${index}. ${title}`,
    "",
    link || `<!-- rss-entry-key:${entry.key} -->`,
    "",
    checkboxLine("正式入库", selection.importChecked),
    checkboxLine("删除", selection.deleteChecked),
    "",
    `**一句话核心**：${judgment.core || "待判断"}`,
    "",
    `**价值判断**：${judgment.value || "待判断"}${judgment.use_cases ? `；${judgment.use_cases}` : ""}`,
    ""
  ].filter((line) => line !== null && line !== "").join("\n");
}

async function writeDigest({ entries, failures, warnings, runDir, options = {} }) {
  const date = localDate();
  const fixedTarget = path.join(pendingDir, `${date} RSS 长文待确认.md`);
  let target = fixedTarget;
  let selections = { byKey: new Map(), byUrl: new Map() };
  if (existsSync(fixedTarget)) {
    const existing = await fs.readFile(fixedTarget, "utf8");
    selections = extractDigestSelections(existing);
    if (options.force) await moveExistingToLegacy(fixedTarget, runDir);
    else target = await uniquePath(pendingDir, `${date} RSS 长文待确认.md`);
  }

  const grouped = new Map();
  for (const entry of entries) {
    const key = entry.sourceDisplayName || entry.sourceId || "RSS";
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(entry);
  }
  const lines = [
    `# ${date} RSS 长文待确认`,
    "",
    "只处理长文。勾选“正式入库”会生成正式阅读文件；勾选“删除”会移入废弃档；两个都不勾会归档到低价值区。",
    failures.length || warnings.length ? "本轮有失败或降级，失败报告会单独生成，不混入正文。" : "",
    ""
  ].filter(Boolean);
  for (const [sourceName, sourceEntries] of grouped) {
    lines.push(`## ${sourceName}`, "");
    sourceEntries.forEach((entry, index) => {
      lines.push(digestEntryBlock(entry, index + 1, selectionForEntry(entry, selections)), "");
    });
  }
  await fs.writeFile(target, `${lines.join("\n").trim()}\n`, "utf8");
  return target;
}

function fallbackShortTranslation(entry) {
  const title = entry.title || entry.url || entry.key;
  const text = cleanEntryText(entry, { maxChars: 2200 }) || title;
  return {
    chineseTitle: `中文：${title}`,
    chineseBody: text
  };
}

async function generateShortTranslations(entries, options = {}, state = null) {
  const result = new Map();
  const missing = [];
  for (const entry of entries) {
    const cached = state?.entries?.[entry.key]?.shortTranslation;
    if (!options.force && cached?.chineseBody) {
      result.set(entry.key, cached);
    } else if (options.mockAi) {
      result.set(entry.key, fallbackShortTranslation(entry));
    } else {
      missing.push(entry);
    }
  }
  if (!missing.length) return result;

  const config = await loadProducerConfig();
  const payload = missing.map((entry) => ({
    id: entry.key,
    title: entry.title || "",
    source: entry.sourceDisplayName || entry.sourceId || "",
    url: entry.url || "",
    text: truncate(cleanEntryText(entry, { maxChars: 3500 }), 3500)
  }));
  const prompt = [
    "你要把 RSS 短文翻译成可直接阅读的中文周报条目。",
    "要求：忠实翻译，不新增外部事实；去掉订阅、推广、登录、分享尾巴；保留有信息量的正文；不要输出 Markdown 表格。",
    "只返回 JSON 数组，每项格式为：",
    "[{\"id\":\"...\",\"chinese_title\":\"...\",\"chinese_body\":\"...\"}]",
    "",
    JSON.stringify(payload, null, 2)
  ].join("\n");
  const response = await fetch(chatCompletionsUrl(config.AI_PRODUCER_BASE_URL), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${config.AI_PRODUCER_API_KEY}`
    },
    body: JSON.stringify({
      model: config.AI_PRODUCER_MODEL,
      temperature: 0.1,
      messages: [
        { role: "system", content: "你是 RSS 短文翻译编辑，只输出可解析 JSON。" },
        { role: "user", content: prompt }
      ]
    }),
    signal: AbortSignal.timeout(180000)
  });
  if (!response.ok) throw new Error(`api_${response.status}_${(await response.text()).slice(0, 500)}`);
  const data = await response.json();
  const text = stripModelFences(data?.choices?.[0]?.message?.content || "");
  const parsed = JSON.parse(text);
  if (!Array.isArray(parsed)) throw new Error("short_translation_not_array");
  for (const item of parsed) {
    if (!item?.id || !item.chinese_body) continue;
    result.set(item.id, {
      chineseTitle: normalizeWhitespace(item.chinese_title || missing.find((entry) => entry.key === item.id)?.title || ""),
      chineseBody: cleanMarkdownForReading(item.chinese_body)
    });
  }
  for (const entry of missing) {
    if (!result.has(entry.key)) throw new Error(`short_translation_missing_${entry.key}`);
  }
  return result;
}

function groupEntries(entries) {
  const grouped = new Map();
  for (const entry of entries) {
    const key = entry.sourceDisplayName || entry.sourceId || "RSS";
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(entry);
  }
  return grouped;
}

function nextWeeklyNumber(existing) {
  let max = 0;
  for (const match of String(existing || "").matchAll(/^####\s+(\d+)\./gmu)) {
    max = Math.max(max, Number(match[1]));
  }
  return max + 1;
}

function renderWeeklySections(entries, translations, startIndex = 1) {
  let number = startIndex;
  const chinese = [];
  const english = [];
  for (const [sourceName, sourceEntries] of groupEntries(entries)) {
    chinese.push(`### ${sourceName}`, "");
    english.push(`### ${sourceName}`, "");
    for (const entry of sourceEntries) {
      const current = number;
      number += 1;
      const translated = translations.get(entry.key) || fallbackShortTranslation(entry);
      const original = cleanEntryText(entry, { maxChars: 2200 }) || entry.title || entry.url || "";
      chinese.push(
        `#### ${current}. ${translated.chineseTitle || entry.title || "未命名"}`,
        "",
        translated.chineseBody,
        "",
        markdownLink("原文链接", entry.url),
        ""
      );
      english.push(
        `#### ${current}. ${entry.title || entry.url || "Untitled"}`,
        "",
        original,
        "",
        markdownLink("Original", entry.url),
        ""
      );
    }
  }
  return { chinese: chinese.join("\n").trim(), english: english.join("\n").trim() };
}

function mergeWeekly(existing, additions, week) {
  const header = `# ${week} RSS 短文周报`;
  if (!existing.trim()) {
    return [
      header,
      "",
      "## 中文主文",
      "",
      additions.chinese,
      "",
      "## English Appendix",
      "",
      additions.english
    ].join("\n").trim() + "\n";
  }
  const marker = "\n## English Appendix\n";
  const index = existing.indexOf(marker);
  if (index < 0) {
    return [
      header,
      "",
      "## 中文主文",
      "",
      additions.chinese,
      "",
      "## English Appendix",
      "",
      additions.english
    ].join("\n").trim() + "\n";
  }
  const chinesePart = existing.slice(0, index).trim();
  const englishPart = existing.slice(index + marker.length).trim();
  return [
    chinesePart,
    "",
    additions.chinese,
    "",
    "## English Appendix",
    "",
    englishPart,
    "",
    additions.english
  ].join("\n").trim() + "\n";
}

async function appendMonthlyArchive(dir, filename, title, blocks) {
  if (!blocks.length) return "";
  await ensureDir(dir);
  const target = path.join(dir, filename);
  let existing = "";
  if (existsSync(target)) existing = await fs.readFile(target, "utf8");
  const prefix = existing.trim() ? `${existing.trim()}\n\n` : `# ${title}\n\n`;
  await fs.writeFile(target, `${prefix}${blocks.join("\n\n").trim()}\n`, "utf8");
  return target;
}

async function appendLowValueEntries(entries, reason) {
  const month = localDate().slice(0, 7);
  const blocks = entries.map((entry) => [
    `## ${entry.title || entry.url || entry.key}`,
    "",
    `归档原因：${reason || shortEntryValue(entry).reason}`,
    "",
    markdownLink("原文链接", entry.url),
    "",
    cleanEntryText(entry, { maxChars: 1200 })
  ].filter(Boolean).join("\n"));
  return appendMonthlyArchive(lowValueDir, `${month} RSS 低价值归档.md`, `${month} RSS 低价值归档`, blocks);
}

async function appendShortWeekly({ entries, runDir, options = {}, state = null, failures = [] }) {
  if (!entries.length) return "";
  await ensureDir(shortWeeklyDir);
  const week = isoWeekString(new Date());
  const target = path.join(shortWeeklyDir, `${week} RSS 短文周报.md`);
  let existing = "";
  if (existsSync(target)) {
    existing = await fs.readFile(target, "utf8");
    const dirty = /rss-short-entry|^---\n|<!--/mu.test(existing) || !existing.includes("## English Appendix");
    if (options.force || dirty) {
      await moveExistingToLegacy(target, runDir);
      existing = "";
    }
  }

  const readable = [];
  const lowValue = [];
  for (const entry of entries) {
    const value = shortEntryValue(entry);
    if (value.keep) readable.push(entry);
    else lowValue.push({ ...entry, lowValueReason: value.reason });
  }
  if (lowValue.length) await appendLowValueEntries(lowValue, "短内容信息量过低或只剩链接/订阅噪声");
  if (!readable.length) return "";

  let translations;
  try {
    translations = await generateShortTranslations(readable, options, state);
  } catch (error) {
    failures.push({ sourceId: "ai", stage: "short_translation", reason: error.message });
    return "";
  }
  for (const entry of readable) {
    entry.shortTranslation = translations.get(entry.key);
  }
  const additions = renderWeeklySections(readable, translations, nextWeeklyNumber(existing));
  await fs.writeFile(target, mergeWeekly(existing, additions, week), "utf8");
  return target;
}

async function writeFailureReport({ failures, warnings, kind = "sync", runDir }) {
  if (!failures.length && !warnings.length) return "";
  const date = localDate();
  const target = await uniquePath(pendingDir, `${date} RSS 失败报告.md`);
  const lines = [
    "---",
    "type: rss_failure_report",
    `kind: ${yamlString(kind)}`,
    `created_at: ${yamlString(nowIso())}`,
    `run_dir: ${yamlString(runDir || "")}`,
    "---",
    "",
    `# ${date} RSS 失败报告`,
    "",
    "## 失败",
    "",
    failures.length ? failures.map((item) => `- ${item.sourceId || item.entryKey || "unknown"} / ${item.stage || "unknown"}：${item.reason || ""}`).join("\n") : "- 无",
    "",
    "## 降级与警告",
    "",
    warnings.length ? warnings.map((item) => `- ${item.sourceId || item.entryKey || "unknown"} / ${item.stage || "unknown"}：${item.reason || ""}`).join("\n") : "- 无",
    ""
  ];
  await fs.writeFile(target, `${lines.join("\n").trim()}\n`, "utf8");
  return target;
}

async function runSync(options = {}) {
  options = normalizeOptions(options);
  await ensureRuntimeFiles();
  const runId = `${runStamp()}-${randomUUID().slice(0, 8)}`;
  const runDir = path.join(rssRunsRoot, runId);
  await ensureDir(runDir);
  const state = await loadState();
  const failures = [];
  const warnings = [];

  let sourceSync = null;
  if (!options.noSourceSync) {
    try {
      sourceSync = await runSourceSync({ ...options, noSourceSync: true });
    } catch (error) {
      failures.push({ sourceId: "source_layer", stage: "source_sync", reason: error.message });
    }
  }

  const sourceLayerEntries = await readSourceLayerEntries(options);
  const bullettyEntries = await readBullettyEntries(options);
  const deduped = dedupeEntries([...sourceLayerEntries, ...bullettyEntries]);
  const newEntries = options.force
    ? deduped
    : deduped.filter((entry) => !state.entries[entry.key]?.digestPath && !state.entries[entry.key]?.seenAt);
  const classifiedEntries = newEntries.map((entry) => {
    const classification = classifyEntry(entry, options);
    return { ...entry, kind: classification.kind, classification };
  });
  const longEntries = classifiedEntries.filter((entry) => entry.kind === "long");
  const shortEntries = classifiedEntries.filter((entry) => entry.kind === "short");

  let aiFailure = "";
  let judgments = new Map();
  try {
    judgments = await generateEntryJudgments(longEntries, options);
  } catch (error) {
    aiFailure = error.message;
    failures.push({ sourceId: "ai", stage: "daily_judgment", reason: error.message });
  }
  for (const entry of longEntries) {
    entry.judgment = judgments.get(entry.key) || fallbackJudgment(entry, aiFailure);
  }

  await writeJson(path.join(runDir, "source-layer-entries.json"), sourceLayerEntries);
  await writeJson(path.join(runDir, "bulletty-entries.json"), bullettyEntries);
  await writeJson(path.join(runDir, "new-entries.json"), classifiedEntries);
  await writeJson(path.join(runDir, "failures.json"), { failures, warnings });

  if (options.dryRun) {
    const result = {
      status: failures.length ? "dry_run_with_failures" : "dry_run",
      dryRun: true,
      runDir,
      sourceSync,
      sourceLayerCount: sourceLayerEntries.length,
      bullettyCount: bullettyEntries.length,
      newCount: classifiedEntries.length,
      longCount: longEntries.length,
      shortCount: shortEntries.length,
      digestPath: "",
      shortWeeklyPath: "",
      failureReportPath: "",
      failures,
      warnings
    };
    await writeJson(path.join(runDir, "run.json"), result);
    return result;
  }

  let digestPath = "";
  let shortWeeklyPath = "";
  if (longEntries.length) digestPath = await writeDigest({ entries: longEntries, failures, warnings, runDir, options });
  if (shortEntries.length) shortWeeklyPath = await appendShortWeekly({ entries: shortEntries, runDir, options, state, failures });
  const failureReportPath = await writeFailureReport({ failures, warnings, kind: "sync", runDir });
  await writeJson(path.join(runDir, "failures.json"), { failures, warnings });

  for (const entry of classifiedEntries) {
    const existing = state.entries[entry.key] || {};
    state.entries[entry.key] = {
      ...existing,
      key: entry.key,
      canonicalKey: entry.canonicalKey,
      sourceId: entry.sourceId,
      sourceIds: entry.sourceIds || [entry.sourceId],
      sourceDisplayName: entry.sourceDisplayName,
      title: entry.title,
      url: entry.url,
      publishedAt: entry.publishedAt,
      firstSeenAt: existing.firstSeenAt || nowIso(),
      seenAt: nowIso(),
      kind: entry.kind,
      classification: entry.classification,
      digestPath: entry.kind === "long" ? digestPath : existing.digestPath || "",
      weeklyPath: entry.kind === "short" ? shortWeeklyPath : existing.weeklyPath || "",
      sourceLayerPath: entry.sourceLayerPath || entry.raw?.sourceLayerPath || "",
      entry,
      judgment: entry.judgment,
      shortTranslation: entry.shortTranslation || existing.shortTranslation || null
    };
  }
  await saveState(state);
  const result = {
    status: failures.length ? "completed_with_failures" : "completed",
    runDir,
    sourceSync,
    sourceLayerCount: sourceLayerEntries.length,
    bullettyCount: bullettyEntries.length,
    newCount: classifiedEntries.length,
    longCount: longEntries.length,
    shortCount: shortEntries.length,
    digestPath,
    shortWeeklyPath,
    failureReportPath,
    failures,
    warnings
  };
  await writeJson(path.join(runDir, "run.json"), result);
  return result;
}

async function findMarkdownFiles(dir) {
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
      else if (entry.name.toLowerCase().endsWith(".md")) found.push(full);
    }
  }
  await walk(dir);
  return found;
}

async function importFulltextWithExistingChain(entry) {
  if (!entry.url || isXUrl(entry.url)) return { markdown: "", file: "", method: "" };
  const stageDir = path.join(rssFulltextRoot, entry.key);
  await ensureDir(stageDir);
  const before = new Set(await findMarkdownFiles(stageDir));
  const result = await runCommand(process.execPath, [importScript, entry.url, "--out", stageDir], { timeoutMs: 900000 });
  await fs.writeFile(path.join(stageDir, "import.stdout.txt"), result.stdout, "utf8");
  await fs.writeFile(path.join(stageDir, "import.stderr.txt"), result.stderr, "utf8");
  if (result.code !== 0) throw new Error(`fulltext_import_${result.code}_${(result.stderr || result.stdout).slice(0, 500)}`);
  const after = await findMarkdownFiles(stageDir);
  const candidates = after.filter((file) => !before.has(file) && !path.basename(file).startsWith("FAILED"));
  const file = candidates[0] || after.find((item) => !path.basename(item).startsWith("FAILED")) || "";
  if (!file) throw new Error("fulltext_import_no_markdown");
  return { markdown: await fs.readFile(file, "utf8"), file, method: "existing_import_web_md" };
}

async function generatePromotedMarkdown(entry, { fulltextMarkdown = "", fulltextFile = "", mockAi = false } = {}) {
  const sourceText = normalizeWhitespace(fulltextMarkdown || originalText(entry));
  const longForm = sourceText.length > 1200 || Boolean(fulltextMarkdown);
  if (mockAi) {
    const guide = longForm
      ? [
          "## 阅读前置卡",
          "### 一句话核心",
          `- ${entry.judgment?.core || fallbackJudgment(entry).core}`,
          "### 核心洞见",
          "- 这条内容适合作为 RSS 入库流程的长内容测试样本。",
          "### 对我的价值判断",
          `- ${entry.judgment?.value || "中"}：${entry.judgment?.pain_points || "可作为渐进阅读候选。"} `,
          "### 信息密度判断",
          `- ${entry.judgment?.density || "中"}。`,
          "### 能解决我的什么痛点",
          `- ${entry.judgment?.pain_points || "帮助判断是否值得沉淀。"} `,
          "### 具体用处",
          `- ${entry.judgment?.use_cases || "可沉淀为卡片或工作流判断。"} `,
          "### 是否急需阅读",
          `- ${entry.judgment?.should_import || "待确认"}。`
        ].join("\n")
      : [
          "## 阅读前置卡",
          `- 一句话核心：${entry.judgment?.core || fallbackJudgment(entry).core}`,
          `- 价值判断：${entry.judgment?.value || "中"}`,
          `- 信息密度：${entry.judgment?.density || "中"}`,
          `- 是否急需阅读：${entry.judgment?.should_import || "待确认"}`
        ].join("\n");
    return cleanMarkdownForReading(`${guide}\n\n## 中文主文\n\n${entry.judgment?.core || entry.content || entry.title}\n`);
  }

  const config = await loadProducerConfig();
  const guideShape = longForm
    ? "完整阅读前置卡：必须包含 一句话核心、核心洞见、对我的价值判断、信息密度判断、能解决我的什么痛点、具体用处、是否急需阅读。"
    : "紧凑阅读前置卡：只保留一句话核心、价值判断、信息密度、是否急需阅读。";
  const prompt = [
    "你要把一个 RSS 条目转成正式入库的渐进阅读 Markdown。",
    "不要新增外部事实，不要把原文扩写成虚构内容。中文主文应忠实表达原意，适合读者直接阅读和高亮。",
    guideShape,
    "",
    "必须输出如下结构：",
    "## 阅读前置卡",
    "...",
    "## 中文主文",
    "...",
    "",
    "读者背景：正在搭建 RemNote、Codex、AI Agent、渐进阅读、卡片化沉淀和教育科技产品相关工作流；偏好高密度、可操作、可沉淀的材料。",
    "",
    `标题：${entry.title || ""}`,
    `来源：${entry.sourceDisplayName || entry.sourceId}`,
    `链接：${entry.url || ""}`,
    `发布时间：${entry.publishedAt || ""}`,
    fulltextFile ? `全文导入中间稿：${fulltextFile}` : "",
    "",
    "日报紧凑判断：",
    JSON.stringify(entry.judgment || {}, null, 2),
    "",
    "原始内容：",
    truncate(sourceText, 50000)
  ].filter(Boolean).join("\n");
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
        { role: "system", content: "你是渐进阅读入库编辑，只输出指定 Markdown 结构。" },
        { role: "user", content: prompt }
      ]
    }),
    signal: AbortSignal.timeout(180000)
  });
  if (!response.ok) throw new Error(`api_${response.status}_${(await response.text()).slice(0, 500)}`);
  const data = await response.json();
  const markdown = cleanMarkdownForReading(stripModelFences(data?.choices?.[0]?.message?.content || ""));
  if (!markdown.includes("## 阅读前置卡") || !markdown.includes("## 中文主文")) {
    throw new Error("promoted_markdown_missing_required_sections");
  }
  return markdown;
}

async function writePromotedEntry(entry, markdown, fulltextInfo = {}) {
  const sourceDir = path.join(finalDir, safeName(entry.sourceDisplayName || entry.sourceId || "RSS"));
  const date = entry.publishedAt && !Number.isNaN(new Date(entry.publishedAt).getTime())
    ? localDate(new Date(entry.publishedAt))
    : localDate();
  const target = await uniquePath(sourceDir, `${date} - ${safeName(entry.title || entry.key)}.md`);
  const original = cleanMarkdownForReading(fulltextInfo.markdown || originalText(entry));
  const body = [
    `# ${entry.title || entry.url || entry.key}`,
    "",
    markdownLink("原文链接", entry.url),
    "",
    markdown.trim(),
    "",
    "---",
    "",
    "## English Appendix",
    "",
    original,
    "",
    markdownLink("Original", entry.url),
    ""
  ].filter((line) => line !== null).join("\n");
  await fs.writeFile(target, body, "utf8");
  return target;
}

function stateIndexes(state) {
  const byKey = new Map();
  const byUrl = new Map();
  for (const [key, record] of Object.entries(state.entries || {})) {
    byKey.set(key, record);
    const url = record.url || record.entry?.url || "";
    if (url) byUrl.set(normalizeUrl(url), { key, record });
  }
  return { byKey, byUrl };
}

function extractReviewBlocks(text) {
  const blocks = [];
  const preamble = [];
  let current = null;
  let currentSource = "";
  function pushCurrent() {
    if (!current) return;
    current.text = current.lines.join("\n").trim();
    if (current.text) blocks.push(current);
    current = null;
  }
  for (const line of String(text || "").split(/\r?\n/u)) {
    if (/^##\s+/.test(line) && !/^###\s+/.test(line)) {
      pushCurrent();
      currentSource = line.replace(/^##\s+/u, "").trim();
      continue;
    }
    if (/^###\s+\d+\./u.test(line) || /^<!-- rss-entry:start/u.test(line)) {
      pushCurrent();
      current = { sourceName: currentSource, lines: [line] };
      continue;
    }
    if (current) current.lines.push(line);
    else preamble.push(line);
  }
  pushCurrent();
  return { preamble: preamble.join("\n").trim(), blocks };
}

function reviewBlockInfo(block, indexes) {
  const text = block.text || "";
  const key = /rss-entry:start\s+([^>\s]+)\s*-->/u.exec(text)?.[1]
    || /rss-entry:([^>\s]+)\s*-->/u.exec(text)?.[1]
    || /rss-entry-key:([^>]+)-->/u.exec(text)?.[1]?.trim()
    || "";
  const url = /\[原文链接\]\(([^)]+)\)/u.exec(text)?.[1]
    || /-\s*链接：\s*(\S+)/u.exec(text)?.[1]
    || "";
  const byUrl = url ? indexes.byUrl.get(normalizeUrl(url)) : null;
  const record = byUrl?.record || indexes.byKey.get(key) || null;
  const recordKey = byUrl?.key || key || record?.key || record?.entry?.key || "";
  return {
    key: recordKey,
    url,
    record,
    importChecked: /-\s*\[[xX]\]\s*正式入库/u.test(text),
    deleteChecked: /-\s*\[[xX]\]\s*删除/u.test(text),
    title: /^###\s+\d+\.\s*(.+)$/mu.exec(text)?.[1]?.trim() || record?.title || record?.entry?.title || url || key || "未命名"
  };
}

function cleanReviewBlockForArchive(block, info, action) {
  const record = info.record || {};
  const url = info.url || record.url || record.entry?.url || "";
  return cleanMarkdownForReading([
    `## ${info.title}`,
    "",
    `处理：${action}`,
    record.sourceDisplayName || record.entry?.sourceDisplayName ? `来源：${record.sourceDisplayName || record.entry?.sourceDisplayName}` : "",
    markdownLink("原文链接", url),
    "",
    String(block.text || "")
      .replace(/-\s*\[[ xX]\]\s*正式入库.*$/gmu, "")
      .replace(/-\s*\[[ xX]\]\s*删除.*$/gmu, "")
  ].filter(Boolean).join("\n"));
}

function renderRemainingDigest(originalTextValue, remainingBlocks) {
  const title = /^#\s+.+$/mu.exec(originalTextValue)?.[0] || `# ${localDate()} RSS 长文待确认`;
  const lines = [
    title,
    "",
    "以下条目尚未完成处理。勾选“正式入库”会生成正式阅读文件；勾选“删除”会移入废弃档；两个都不勾会归档到低价值区。",
    ""
  ];
  const grouped = new Map();
  for (const item of remainingBlocks) {
    const sourceName = item.sourceName || item.info?.record?.sourceDisplayName || item.info?.record?.entry?.sourceDisplayName || "RSS";
    if (!grouped.has(sourceName)) grouped.set(sourceName, []);
    grouped.get(sourceName).push(item.text);
  }
  for (const [sourceName, blocks] of grouped) {
    lines.push(`## ${sourceName}`, "");
    for (const block of blocks) lines.push(block.trim(), "");
  }
  return `${lines.join("\n").trim()}\n`;
}

async function promoteRecord(record, digestFile, options, warnings) {
  const entry = { ...record.entry, judgment: record.judgment || record.entry?.judgment };
  let fulltextInfo = { markdown: "", file: "", method: "" };
  if (options.noFulltext !== true && entry.url && !isXUrl(entry.url)) {
    try {
      fulltextInfo = await importFulltextWithExistingChain(entry);
    } catch (error) {
      warnings.push({ entryKey: entry.key, stage: "fulltext", reason: error.message });
    }
  }
  if (!fulltextInfo.markdown) {
    const sourceMarkdown = await readSourceEntryMarkdown(record);
    if (sourceMarkdown) {
      fulltextInfo = {
        markdown: sourceMarkdown,
        file: record.sourceLayerPath || entry.sourceLayerPath || "",
        method: "source_layer_markdown"
      };
    }
  }
  const markdown = await generatePromotedMarkdown(entry, {
    fulltextMarkdown: fulltextInfo.markdown,
    fulltextFile: fulltextInfo.file,
    mockAi: options.mockAi
  });
  const target = await writePromotedEntry(entry, markdown, fulltextInfo);
  return { target, digestFile };
}

async function resolveDigestFile(file, state, options, runDir, result) {
  const text = await fs.readFile(file, "utf8");
  const parsed = extractReviewBlocks(text);
  const indexes = stateIndexes(state);
  const remaining = [];
  const discardBlocks = [];
  const archiveBlocks = [];

  for (const block of parsed.blocks) {
    const info = reviewBlockInfo(block, indexes);
    block.info = info;
    if (info.importChecked && info.deleteChecked) {
      result.conflicts.push({ file, entryKey: info.key, title: info.title, reason: "both_import_and_delete_checked" });
      result.failures.push({ entryKey: info.key || info.title, stage: "resolve_conflict", reason: "both_import_and_delete_checked" });
      remaining.push(block);
      continue;
    }
    if (info.importChecked) {
      if (!info.record?.entry) {
        result.failures.push({ entryKey: info.key || info.title, stage: "lookup", reason: "entry_not_found_in_state" });
        remaining.push(block);
        continue;
      }
      if (info.record.promotedAt && !options.force) {
        result.skipped.push({ entryKey: info.key, reason: "already_promoted", target: info.record.promotedPath || "" });
      } else if (info.record.kind === "short") {
        result.skipped.push({ entryKey: info.key, reason: "short_entry_weekly_only", target: info.record.weeklyPath || "" });
      } else {
        try {
          const promoted = await promoteRecord(info.record, file, options, result.warnings);
          state.entries[info.key] = {
            ...info.record,
            promotedAt: nowIso(),
            promotedPath: promoted.target,
            promotedFromDigest: file,
            resolution: "promoted",
            resolvedAt: nowIso()
          };
          result.promoted.push({ entryKey: info.key, target: promoted.target });
        } catch (error) {
          result.failures.push({ entryKey: info.key, stage: "promote", reason: error.message });
          remaining.push(block);
        }
      }
      continue;
    }
    if (info.deleteChecked) {
      discardBlocks.push(cleanReviewBlockForArchive(block, info, "删除"));
      if (info.key && info.record) {
        state.entries[info.key] = { ...info.record, resolution: "discarded", resolvedAt: nowIso() };
      }
      result.discarded.push({ entryKey: info.key || "", title: info.title });
      continue;
    }

    archiveBlocks.push(cleanReviewBlockForArchive(block, info, "低价值归档"));
    if (info.key && info.record) {
      state.entries[info.key] = { ...info.record, resolution: "archived_low_value", resolvedAt: nowIso() };
    }
    result.archived.push({ entryKey: info.key || "", title: info.title });
  }

  const month = localDate().slice(0, 7);
  if (discardBlocks.length) {
    result.discardedPath = await appendMonthlyArchive(discardedDir, `${month} RSS 删除记录.md`, `${month} RSS 删除记录`, discardBlocks);
  }
  if (archiveBlocks.length) {
    result.archivedPath = await appendMonthlyArchive(lowValueDir, `${month} RSS 低价值归档.md`, `${month} RSS 低价值归档`, archiveBlocks);
  }

  if (!remaining.length) {
    const resolvedPath = await uniquePath(resolvedDigestsDir, path.basename(file));
    await fs.rename(file, resolvedPath);
    result.resolvedDigests.push({ from: file, to: resolvedPath });
  } else {
    await fs.writeFile(file, renderRemainingDigest(text, remaining), "utf8");
  }
}

async function digestFilesForResolve(options = {}) {
  if (options.digest) return [path.resolve(String(options.digest))];
  const files = await findMarkdownFiles(pendingDir);
  return files.filter((file) => {
    const name = path.basename(file);
    return name.includes("RSS 长文待确认") && !name.includes("失败报告");
  });
}

async function runResolve(options = {}) {
  options = normalizeOptions(options);
  await ensureRuntimeFiles();
  const runId = `${runStamp()}-resolve-${randomUUID().slice(0, 8)}`;
  const runDir = path.join(rssRunsRoot, runId);
  await ensureDir(runDir);
  const state = await loadState();
  const files = await digestFilesForResolve(options);
  const result = {
    status: "completed",
    runDir,
    files,
    promoted: [],
    discarded: [],
    archived: [],
    conflicts: [],
    skipped: [],
    failures: [],
    warnings: [],
    resolvedDigests: [],
    discardedPath: "",
    archivedPath: "",
    failureReportPath: ""
  };
  for (const file of files) {
    try {
      await resolveDigestFile(file, state, options, runDir, result);
    } catch (error) {
      result.failures.push({ file, stage: "resolve_file", reason: error.message });
    }
  }
  result.failureReportPath = await writeFailureReport({ failures: result.failures, warnings: result.warnings, kind: "resolve", runDir });
  if (result.failures.length || result.conflicts.length) result.status = "completed_with_failures";
  await saveState(state);
  await writeJson(path.join(runDir, "run.json"), result);
  return result;
}

async function runPromote(options = {}) {
  return runResolve(options);
}

async function runSetup(options = {}) {
  options = normalizeOptions(options);
  await ensureRuntimeFiles();
  const created = [];
  if (!existsSync(envPath) && existsSync(envExamplePath)) {
    await fs.copyFile(envExamplePath, envPath);
    created.push(envPath);
  }
  const docker = await runCommand("docker", ["--version"], { timeoutMs: 15000 });
  let dockerInstall = null;
  if (docker.code !== 0 && options.installDocker) {
    dockerInstall = await runCommand("winget", [
      "install",
      "--id",
      "Docker.DockerDesktop",
      "-e",
      "--accept-package-agreements",
      "--accept-source-agreements"
    ], { timeoutMs: 900000 });
  }
  return {
    status: "completed",
    created,
    envPath,
    sourcesPath,
    composePath,
    dockerAvailable: docker.code === 0,
    dockerMessage: docker.stdout || docker.stderr,
    dockerInstall
  };
}

async function runSchedule(options = {}) {
  options = normalizeOptions(options);
  const time = String(options.time || "08:00");
  const taskName = String(options.name || "ProgressiveReadingRSSDaily");
  const result = await runCommand("schtasks.exe", [
    "/Create",
    "/TN",
    taskName,
    "/SC",
    "DAILY",
    "/ST",
    time,
    "/TR",
    `"${dailyCmdPath}"`,
    "/F"
  ], { timeoutMs: 60000 });
  if (result.code !== 0) throw new Error(`schtasks_${result.code}_${result.stderr || result.stdout}`);
  return { status: "completed", taskName, time, launcher: dailyCmdPath, stdout: result.stdout.trim() };
}

async function runHealth() {
  await ensureRuntimeFiles();
  const env = await loadLocalEnv();
  const checks = [];
  async function check(name, fn) {
    try {
      const detail = await fn();
      checks.push({ name, status: "ok", detail });
    } catch (error) {
      checks.push({ name, status: "fail", detail: error.message });
    }
  }
  await check("docker", async () => {
    const result = await runCommand("docker", ["--version"], { timeoutMs: 15000 });
    if (result.code !== 0) throw new Error((result.stderr || result.stdout || "docker_not_available").trim());
    return result.stdout.trim();
  });
  await check("docker_engine", async () => {
    const result = await runCommand("docker", ["info", "--format", "{{.ServerVersion}}"], { timeoutMs: 30000 });
    if (result.code !== 0) throw new Error((result.stderr || result.stdout || "docker_engine_not_available").trim().slice(0, 500));
    return result.stdout.trim();
  });
  await check("docker_compose", async () => {
    const result = await runCommand("docker", ["compose", "version"], { timeoutMs: 15000 });
    if (result.code !== 0) throw new Error((result.stderr || result.stdout || "docker_compose_not_available").trim());
    return result.stdout.trim();
  });
  await check("miniflux_api", async () => {
    const me = await minifluxRequest(env, "/v1/me", { timeoutMs: 12000 });
    return me.username || me.id || "connected";
  });
  await check("rsshub_health", async () => {
    const response = await fetch(`${rssHubBase(env)}/healthz`, { signal: AbortSignal.timeout(12000) });
    const text = await response.text();
    if (!response.ok) throw new Error(`rsshub_${response.status}_${text.slice(0, 120)}`);
    return text.trim() || "ok";
  });
  await check("rsshub_x_route", async () => {
    const response = await fetch(`${rssHubBase(env)}/twitter/user/thedankoe`, { signal: AbortSignal.timeout(15000) });
    const text = await response.text();
    if (!response.ok || !/<rss|<feed/i.test(text)) throw new Error(`rsshub_x_${response.status}_${text.slice(0, 160)}`);
    return "x_route_returned_feed";
  });
  await check("opencli_twitter", async () => {
    const result = await runCommand("opencli", ["twitter", "--help"], { timeoutMs: 30000 });
    if (result.code !== 0) throw new Error((result.stderr || result.stdout || "opencli_not_available").slice(0, 300));
    return "opencli twitter command available";
  });
  await check("bulletty", async () => {
    const result = await detectBulletty();
    if (!result.available) throw new Error(result.detail || "bulletty_not_available");
    const dataDir = await detectBullettyDataDir(result.binary);
    return { binary: result.binary, dataDir };
  });
  await check("source_layer", async () => {
    await ensureDir(rssSourceEntriesRoot);
    const files = await findMarkdownFiles(rssSourceEntriesRoot);
    return { dir: rssSourceEntriesRoot, markdownFiles: files.length };
  });
  const hasFailure = checks.some((item) => item.status !== "ok");
  return { status: hasFailure ? "degraded" : "ok", checkedAt: nowIso(), checks };
}

async function runServices(command = "up") {
  await ensureRuntimeFiles();
  const args = ["compose", "-p", "progressive-reading-rss", "-f", composePath, "--env-file", envPath];
  if (command === "up") args.push("up", "-d");
  else if (command === "down") args.push("down");
  else if (command === "ps") args.push("ps");
  else throw new Error(`unsupported_services_command_${command}`);
  const result = await runCommand("docker", args, { timeoutMs: command === "up" ? 900000 : 120000 });
  if (result.code !== 0) throw new Error(`docker_compose_${command}_${result.code}_${result.stderr || result.stdout}`);
  return { status: "completed", command, stdout: result.stdout.trim(), stderr: result.stderr.trim() };
}

async function listSources() {
  await ensureRuntimeFiles();
  return await loadSources();
}

function sourceFromOptions(options) {
  const type = String(options.type || "x-user");
  if (type === "x-user") {
    const handle = String(options.handle || "").replace(/^@/, "").trim();
    if (!handle) throw new Error("handle_required");
    return {
      id: String(options.id || `x-${handle.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`).replace(/^-|-$/g, ""),
      enabled: options.enabled !== "false",
      type: "x-user",
      platform: "x",
      displayName: String(options.displayName || options["display-name"] || handle),
      handle,
      language: "zh-CN",
      mode: "daily_digest",
      backfillDays: Number(options.backfillDays || options["backfill-days"] || 30),
      include: { replies: true, reposts: true, quotes: true, mediaOnly: true },
      rsshub: { enabled: true, path: `/twitter/user/${handle}` },
      fallback: { opencli: true }
    };
  }
  if (type === "rss") {
    const feedUrl = String(options.feedUrl || options["feed-url"] || "").trim();
    if (!feedUrl) throw new Error("feed_url_required");
    const displayName = String(options.displayName || options["display-name"] || new URL(feedUrl).hostname);
    return {
      id: String(options.id || `rss-${hashText(feedUrl).slice(0, 10)}`),
      enabled: options.enabled !== "false",
      type: "rss",
      platform: "rss",
      displayName,
      feedUrl,
      language: "zh-CN",
      mode: "daily_digest",
      backfillDays: Number(options.backfillDays || options["backfill-days"] || 30),
      include: { fulltextAfterPromotion: true }
    };
  }
  throw new Error(`unsupported_source_type_${type}`);
}

async function addSource(options) {
  await ensureRuntimeFiles();
  const config = await loadSources();
  const source = options.payload ? JSON.parse(String(options.payload)) : sourceFromOptions(options);
  const index = config.sources.findIndex((item) => item.id === source.id);
  if (index >= 0) config.sources[index] = { ...config.sources[index], ...source };
  else config.sources.push(source);
  await saveSources(config);
  return { status: index >= 0 ? "updated" : "added", source };
}

async function ensureRuntimeFiles() {
  await ensureDir(configDir);
  await ensureDir(rssRoot);
  await ensureDir(rssRunsRoot);
  await ensureDir(rssFulltextRoot);
  await ensureDir(rssSourceLayerRoot);
  await ensureDir(rssSourceEntriesRoot);
  await ensureDir(pendingDir);
  await ensureDir(finalDir);
  await ensureDir(shortWeeklyDir);
  await ensureDir(lowValueDir);
  await ensureDir(discardedDir);
  await ensureDir(resolvedDigestsDir);
  if (!existsSync(sourcesPath)) {
    await writeJson(sourcesPath, {
      version: 1,
      sources: [
        sourceFromOptions({ type: "x-user", handle: "thedankoe", displayName: "Dan Koe" }),
        sourceFromOptions({ type: "rss", feedUrl: "https://www.justinmath.com/feed.xml", displayName: "Justin Skycak" }),
        sourceFromOptions({ type: "rss", feedUrl: "https://letters.thedankoe.com/feed", displayName: "Dan Koe Letters" })
      ]
    });
  }
}

function printResult(result, asJson) {
  if (asJson) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(JSON.stringify(result, null, 2));
}

async function main() {
  const command = process.argv[2] || "help";
  const options = parseArgs(process.argv.slice(3));
  try {
    let result = null;
    if (command === "setup") result = await runSetup(options);
    else if (command === "source-setup") result = await runSourceSetup(options);
    else if (command === "source-sync") result = await runSourceSync(options);
    else if (command === "sync") result = await runSync(options);
    else if (command === "resolve") result = await runResolve(options);
    else if (command === "promote") result = await runPromote(options);
    else if (command === "health") result = await runHealth();
    else if (command === "sources") result = await listSources();
    else if (command === "add-source") result = await addSource(options);
    else if (command === "schedule") result = await runSchedule(options);
    else if (command === "services-up") result = await runServices("up");
    else if (command === "services-down") result = await runServices("down");
    else if (command === "services-ps") result = await runServices("ps");
    else {
      result = {
        commands: ["setup", "source-setup", "source-sync", "sync", "resolve", "promote", "health", "sources", "add-source", "schedule", "services-up", "services-down", "services-ps"],
        examples: [
          "npm run rss:source:setup",
          "npm run rss:source:sync",
          "npm run rss:sync -- --force",
          "npm run rss:resolve",
          "npm run rss:promote",
          "npm run rss:schedule"
        ]
      };
    }
    printResult(result, Boolean(options.json));
  } catch (error) {
    if (options.json) console.log(JSON.stringify({ status: "failed", error: error.message }, null, 2));
    else console.error(error.stack || error.message);
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}

export {
  addSource,
  listSources,
  runHealth,
  runPromote,
  runResolve,
  runSchedule,
  runSetup,
  runSourceSetup,
  runSourceSync,
  runSync
};
