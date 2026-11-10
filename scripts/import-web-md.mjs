import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { JSDOM } from "jsdom";
import { Readability } from "@mozilla/readability";
import TurndownService from "turndown";
import { gfm } from "turndown-plugin-gfm";
import sanitize from "sanitize-filename";
import { preprocessNetworkMarkdown } from "../standard-preprocessing/integrations/network-import.mjs";
import { publishReadingArtifact } from "../standard-preprocessing/index.mjs";
import { sha256 } from "../standard-preprocessing/lib/core.mjs";
import { findSourcePublication, sourceReuseResult } from './reading-source-library.mjs';

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../../..");
const workflowRoot = path.resolve(__dirname, "..");
const defaultOutDir = path.join(workflowRoot, "imports", "Web Markdown Import Experiments");
const guidedRunName = `${new Date().toISOString().slice(0, 10)}-guided-wechat`;
const defaultGuidedOutDir = path.join(workflowRoot, "阅读区", "微信", guidedRunName);
const defaultGuidedStagingDir = path.join(workflowRoot, "imports", "wechat", guidedRunName);
const csdiyRepoUrl = "https://github.com/PKUFlyingPig/cs-self-learning.git";
const csdiyRawBase = "https://raw.githubusercontent.com/PKUFlyingPig/cs-self-learning/master/";
const csPlanRepoUrl = "https://github.com/MingLLuo/CS-Plan.git";
const csPlanRawBase = "https://raw.githubusercontent.com/MingLLuo/CS-Plan/main/";
const githubReadableMarkdownExtensions = new Set([".md", ".mdx"]);
const githubExcludedPathSegments = new Set([
  ".git",
  ".github",
  ".trae",
  ".vitepress",
  "node_modules",
  "dist",
  "build",
  "out",
  "coverage",
  ".next",
  ".vite"
]);
const githubExcludedFileNames = new Set(["AGENTS.md", "CLAUDE.md"]);

const args = process.argv.slice(2);
const urls = [];
let outDir = defaultOutDir;
let stagingDir = defaultGuidedStagingDir;
let importCsdiyFull = false;
let importCsPlanFull = false;
let guidedWechat = false;
let importInstruction = "";
let browserContentPath = "";
let receiptPath = "";
let processingOptions = {};

for (let i = 0; i < args.length; i += 1) {
  if (args[i] === "--out" && args[i + 1]) {
    outDir = path.resolve(args[i + 1]);
    i += 1;
  } else if (args[i] === "--staging" && args[i + 1]) {
    stagingDir = path.resolve(args[i + 1]);
    i += 1;
  } else if (args[i] === "--instruction" && args[i + 1]) {
    importInstruction = args[i + 1];
    i += 1;
  } else if (args[i] === "--processing-options" && args[i + 1]) {
    processingOptions = JSON.parse(await fs.readFile(path.resolve(args[++i]), "utf8"));
  } else if (args[i] === "--browser-content" && args[i + 1]) {
    browserContentPath = path.resolve(args[i + 1]);
    i += 1;
  } else if (args[i] === "--receipt" && args[i + 1]) {
    receiptPath = path.resolve(args[i + 1]);
    i += 1;
  } else if (args[i] === "--csdiy-full") {
    importCsdiyFull = true;
  } else if (args[i] === "--cs-plan-full") {
    importCsPlanFull = true;
  } else if (args[i] === "--guided-wechat") {
    guidedWechat = true;
  } else {
    urls.push(args[i]);
  }
}

if (guidedWechat && (importCsdiyFull || importCsPlanFull)) {
  console.error("--guided-wechat cannot be combined with full-site imports");
  process.exit(1);
}

if (guidedWechat && outDir === defaultOutDir) {
  outDir = defaultGuidedOutDir;
}

if (urls.length === 0 && !importCsdiyFull && !importCsPlanFull && !browserContentPath) {
  console.error("Usage: npm run import -- <url...> [--out <dir>] [--instruction <text>] [--receipt <path>]\n       npm run import -- --browser-content <capture.json> [--out <dir>] [--instruction <text>] [--receipt <path>]\n       npm run import:guided -- <wechat-url...> [--out <dir>] [--staging <dir>] [--instruction <text>]\n       npm run import:csdiy -- [--out <dir>]\n       npm run import:cs-plan -- [--out <dir>]");
  process.exit(1);
}

const turndown = new TurndownService({
  headingStyle: "atx",
  bulletListMarker: "-",
  codeBlockStyle: "fenced"
});
turndown.use(gfm);

function yamlString(value) {
  return JSON.stringify(String(value ?? ""));
}

function slugFromTitle(title, fallback) {
  const raw = sanitize((title || fallback || "untitled").replace(/\s+/g, " ").trim());
  return (raw || "untitled").slice(0, 120);
}

function sanitizePathSegment(segment) {
  return sanitize(segment) || "untitled";
}

function slugFromUrl(url) {
  const parsed = new URL(url);
  const pathSlug = parsed.pathname
    .split("/")
    .filter(Boolean)
    .slice(-4)
    .join("-");
  return slugFromTitle([parsed.hostname, pathSlug].filter(Boolean).join(" "), parsed.hostname);
}

function hasFeishuLoginShell(html, url) {
  return new URL(url).hostname.endsWith("feishu.cn")
    && /suite-passport|passport_service_url|login|登录|no_permission/i.test(html);
}

async function fetchText(url, extraHeaders = {}) {
  const headers = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml,text/markdown,text/plain;q=0.9,*/*;q=0.8",
    ...extraHeaders
  };

  try {
    const response = await fetch(url, {
      redirect: "follow",
      headers,
      signal: AbortSignal.timeout(45000)
    });
    const text = await response.text();
    return { response, text };
  } catch (error) {
    return fetchTextWithCurl(url, headers, error);
  }
}

async function fetchTextWithCurl(url, headers, originalError) {
  const marker = "\n__HTTP_STATUS__:";
  const args = [
    "-L",
    "-sS",
    "--compressed",
    "--max-time",
    "45",
    "-w",
    `${marker}%{http_code}`,
    "-A",
    headers["User-Agent"]
  ];
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === "user-agent") continue;
    args.push("-H", `${key}: ${value}`);
  }
  args.push(url);

  try {
    const { stdout } = await execFileAsync("curl.exe", args, {
      encoding: "utf8",
      maxBuffer: 50 * 1024 * 1024,
      windowsHide: true
    });
    const markerIndex = stdout.lastIndexOf(marker);
    if (markerIndex === -1) throw new Error("curl_missing_status");
    const text = stdout.slice(0, markerIndex);
    const status = Number(stdout.slice(markerIndex + marker.length).trim()) || 0;
    return {
      response: {
        ok: status >= 200 && status < 300,
        status,
        statusText: `curl_${status}`
      },
      text
    };
  } catch (curlError) {
    throw new Error(`fetch failed; curl fallback failed: ${curlError.message}; original: ${originalError.message}`);
  }
}

function isWechatMpUrl(url) {
  const parsed = new URL(url);
  return parsed.hostname === "mp.weixin.qq.com" || parsed.hostname.endsWith(".mp.weixin.qq.com");
}

function csdiyRawMarkdownUrl(url) {
  const parsed = new URL(url);
  if (parsed.hostname !== "csdiy.wiki") return null;

  let pathname = decodeURIComponent(parsed.pathname);
  pathname = pathname.replace(/^\/+|\/+$/g, "");
  const docPath = pathname ? `docs/${pathname}.md` : "docs/index.md";
  return `${csdiyRawBase}${encodeURI(docPath).replace(/%2F/g, "/")}`;
}

function githubRepoFromUrl(url) {
  const parsed = new URL(url);
  if (parsed.hostname !== "github.com" && parsed.hostname !== "www.github.com") return null;
  const parts = parsed.pathname.split("/").filter(Boolean);
  if (parts.length < 2) return null;
  if (parts[2] && !["tree", "blob"].includes(parts[2])) return null;
  return { owner: parts[0], repo: parts[1].replace(/\.git$/i, "") };
}

function githubRepoRootFromUrl(url) {
  const parsed = new URL(url);
  if (parsed.hostname !== "github.com" && parsed.hostname !== "www.github.com") return null;
  const parts = parsed.pathname.split("/").filter(Boolean);
  if (parts.length !== 2) return null;
  return { owner: parts[0], repo: parts[1].replace(/\.git$/i, "") };
}

function isDirectMarkdownUrl(url) {
  try {
    const parsed = new URL(url);
    return /\.mdx?$/i.test(parsed.pathname);
  } catch {
    return false;
  }
}

async function directMarkdownUrlSource(url) {
  if (!isDirectMarkdownUrl(url)) return null;
  const { response, text } = await fetchText(url, {
    "Accept": "text/markdown,text/plain,*/*;q=0.8"
  });
  if (!response.ok || !String(text || "").trim() || /^<!doctype html/i.test(String(text || "").trim())) return null;
  return {
    method: "direct_markdown_url",
    markdown: absolutizeMarkdownLinks(text.trim(), url),
    rawUrl: url,
    title: titleFromMarkdown(text, path.basename(new URL(url).pathname, path.extname(new URL(url).pathname)))
  };
}

async function githubReadmeMarkdown(url) {
  const repo = githubRepoFromUrl(url);
  if (!repo) return null;
  try {
    const { stdout } = await execFileAsync("gh", [
      "api",
      `repos/${repo.owner}/${repo.repo}/readme`
    ], {
      encoding: "utf8",
      maxBuffer: 20 * 1024 * 1024,
      timeout: 60000,
      windowsHide: true
    });
    const data = JSON.parse(stdout);
    if (!data?.content || data.encoding !== "base64") throw new Error("github_readme_api_missing_base64_content");
    const markdown = Buffer.from(String(data.content).replace(/\s+/g, ""), "base64").toString("utf8");
    if (!markdown.trim()) throw new Error("github_readme_empty");
    return {
      method: "github_api_readme",
      markdown: absolutizeMarkdownLinks(markdown.trim(), data.html_url || url),
      rawUrl: data.download_url || "",
      title: titleFromMarkdown(markdown, `${repo.owner}/${repo.repo}`)
    };
  } catch (error) {
    throw new Error(`github_readme_fetch_failed_${repo.owner}/${repo.repo}: ${error.message}`);
  }
}

async function trySourceMarkdown(url) {
  const directMarkdown = await directMarkdownUrlSource(url);
  if (directMarkdown) return directMarkdown;

  const githubReadme = await githubReadmeMarkdown(url);
  if (githubReadme) return githubReadme;

  const rawUrl = csdiyRawMarkdownUrl(url);
  if (!rawUrl) return null;

  const { response, text } = await fetchText(rawUrl);
  if (!response.ok || /404: Not Found/i.test(text)) return null;
  return {
    method: "github_raw_markdown",
    markdown: absolutizeMarkdownLinks(text.trim(), url),
    rawUrl
  };
}

function isAbsoluteOrSpecialLink(target) {
  return /^(?:[a-z][a-z0-9+.-]*:|#|\/)/i.test(target);
}

function absolutizeMarkdownLinks(markdown, baseUrl) {
  return markdown.replace(/(!?\[[^\]]*?\]\()([^) \t\n]+)(\))/g, (match, prefix, target, suffix) => {
    if (isAbsoluteOrSpecialLink(target)) return match;
    try {
      const resolved = new URL(target, baseUrl);
      if (new URL(baseUrl).hostname === "csdiy.wiki" && resolved.pathname.endsWith(".md")) {
        resolved.pathname = `${resolved.pathname.slice(0, -3)}/`;
      }
      return `${prefix}${resolved.href}${suffix}`;
    } catch {
      return match;
    }
  });
}

function htmlToMarkdown(html, url) {
  const dom = new JSDOM(html, { url });
  const reader = new Readability(dom.window.document);
  const article = reader.parse();

  if (!article || !article.textContent || article.textContent.trim().length < 200) {
    throw new Error("No readable article body found");
  }

  const markdown = absolutizeMarkdownLinks(turndown.turndown(article.content).trim(), url);
  return {
    method: "readability_html",
    title: article.title,
    markdown
  };
}

function browserExtractedHtmlToMarkdown(record) {
  const url = String(record?.url || "");
  const title = String(record?.title || "").trim();
  const html = String(record?.html || "");
  if (!url || !title || !html) throw new Error("browser_capture_missing_url_title_or_html");

  const dom = new JSDOM(`<article id="browser-captured-content">${html}</article>`, { url });
  const content = dom.window.document.querySelector("#browser-captured-content");
  content.querySelectorAll("script, style, button, noscript").forEach((element) => element.remove());
  content.querySelectorAll("img").forEach((img) => {
    const src = img.getAttribute("data-original")
      || img.getAttribute("data-actualsrc")
      || img.getAttribute("data-src")
      || img.getAttribute("src");
    if (src) img.setAttribute("src", src);
  });

  const textLength = (content.textContent || "").replace(/\s+/g, "").length;
  if (textLength < 20) throw new Error(`browser_capture_body_too_short_${textLength}`);
  const converted = absolutizeMarkdownLinks(turndown.turndown(content.innerHTML).trim(), url);
  return {
    method: "browser_authenticated_dom",
    title,
    author: String(record?.author || "").trim(),
    publishedAt: String(record?.publishedAt || "").trim(),
    sourceColumn: String(record?.columnName || "").trim(),
    sourceColumnUrl: String(record?.columnUrl || "").trim(),
    sourceColumns: (Array.isArray(record?.sourceColumns) ? record.sourceColumns : [record?.columnName])
      .map((value) => String(value || "").trim())
      .filter(Boolean),
    sourceColumnUrls: (Array.isArray(record?.sourceColumnUrls) ? record.sourceColumnUrls : [record?.columnUrl])
      .map((value) => String(value || "").trim())
      .filter(Boolean),
    sourceItemId: String(record?.sourceItemId || "").trim(),
    markdown: `# ${title}\n\n${converted}`
  };
}

function firstMetaContent(document, selectors) {
  for (const selector of selectors) {
    const element = document.querySelector(selector);
    const value = element?.getAttribute("content") || element?.textContent;
    if (value?.trim()) return value.trim();
  }
  return "";
}

function cleanWechatContent(contentElement) {
  contentElement.querySelectorAll("script, style, iframe, mp-common-profile, wx-open-launch-app").forEach(element => element.remove());
  contentElement.querySelectorAll("img").forEach(img => {
    const src = img.getAttribute("data-src") || img.getAttribute("src");
    if (src) img.setAttribute("src", src);
    const alt = img.getAttribute("alt") || img.getAttribute("data-w");
    if (alt) img.setAttribute("alt", alt);
  });
  contentElement.querySelectorAll("a").forEach(link => {
    const href = link.getAttribute("data-linktype") === "2"
      ? link.getAttribute("href")
      : link.getAttribute("href");
    if (href) link.setAttribute("href", href);
  });
  return contentElement;
}

function wechatHtmlToMarkdown(html, url) {
  if (/wappoc_appmsgcaptcha|environment abnormal|captcha/i.test(html) || /环境异常|当前环境异常/.test(html)) {
    throw new Error("wechat_captcha_or_environment_check");
  }

  const dom = new JSDOM(html, { url });
  const { document } = dom.window;
  const contentElement = document.querySelector("#js_content") || document.querySelector(".rich_media_content");
  if (!contentElement) {
    throw new Error("wechat_article_body_not_found");
  }

  const textLength = contentElement.textContent.replace(/\s+/g, "").length;
  if (textLength < 500) {
    throw new Error(`wechat_article_body_too_short_${textLength}`);
  }

  const title = firstMetaContent(document, [
    'meta[property="og:title"]',
    'meta[name="twitter:title"]',
    "#activity-name",
    "title"
  ]).replace(/\s+/g, " ");
  const author = firstMetaContent(document, ["#js_name", 'meta[property="og:article:author"]']).replace(/\s+/g, " ");
  const publishedAt = firstMetaContent(document, ["#publish_time", 'meta[property="article:published_time"]']).replace(/\s+/g, " ");

  cleanWechatContent(contentElement);
  let markdown = absolutizeMarkdownLinks(turndown.turndown(contentElement.innerHTML).trim(), url);
  const headerLines = [
    title ? `# ${title}` : null,
    [author, publishedAt].filter(Boolean).join(" | ") || null
  ].filter(Boolean);
  if (headerLines.length) {
    markdown = `${headerLines.join("\n\n")}\n\n${markdown}`;
  }

  return {
    method: "wechat_mp_html",
    title,
    author,
    publishedAt,
    markdown
  };
}

async function writeMarkdown(url, result, options = processingOptions) {
  const existingSource = await findSourcePublication(workflowRoot, url);
  if (existingSource) return { ...sourceReuseResult(url, existingSource), target: existingSource.path };
  await fs.mkdir(outDir, { recursive: true });
  const parsed = new URL(url);
  const title = result.title || result.markdown.match(/^#\s+(.+)$/m)?.[1] || parsed.hostname;
  const titleSlug = slugFromTitle(title, parsed.hostname);
  let target = path.join(outDir, `${titleSlug}.md`);
  try {
    const existing = await fs.readFile(target, "utf8");
    if (!existing.includes(`source_url: ${yamlString(url)}`)) {
      const sourceId = sanitizePathSegment(parsed.pathname.split("/").filter(Boolean).at(-1) || slugFromUrl(url));
      target = path.join(outDir, `${titleSlug} [${sourceId}].md`);
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const outputDir = path.join(stagingDir, "standard-preprocessing", sha256(url).slice(0, 16));
  const run = await preprocessNetworkMarkdown({
    markdown: result.markdown, sourceType: result.method || "network_markdown",
    sourceMetadata: {
      source_url: url, title, input_form: "written", source_is_original: true,
      author: result.author || "", published_at: result.publishedAt || "",
      ...(result.rawUrl ? { source_markdown_url: result.rawUrl } : {}),
      ...(result.sourceColumns ? { source_columns: result.sourceColumns } : {}),
      ...(result.sourceColumnUrls ? { source_column_urls: result.sourceColumnUrls } : {})
    },
    userInstruction: importInstruction, processingOptions: options, outputDir,
    cacheDir: path.join(workflowRoot, ".local-ir", "browser-standard-preprocess", ".cache")
  });
  const receipt = {
    processing_mode: "standard_preprocess", preprocess_status: run.result.status,
    processor_version: run.result.receipt.processor_version, processing_plan: run.result.receipt.workflow_route?.plan,
    reading_guide: run.result.receipt.reading_guide, model_calls: run.result.receipt.model.calls,
    missing_labels: run.result.receipt.workflow_route?.missing_labels || [], preprocess_output_dir: outputDir
  };
  if (run.result.status === "needs_classification") return { status: "needs_classification", target: null, receipt };
  const publication = await publishReadingArtifact(run.result, { publishPath: target, runDir: outputDir });
  return { target: publication.markdown.path, status: publication.preserved_existing ? 'idempotent_replay' : publication.quality_status === "warning" ? "imported_with_warnings" : "imported",
    artifacts: [{ kind: "markdown", ...publication.markdown }],
    receipt: { ...receipt, quality_status: publication.quality_status, final_markdown_sha256: publication.markdown.sha256 } };
}

async function writeGuidedFailure(url, stage, reason, detail = "") {
  await fs.mkdir(stagingDir, { recursive: true });
  const parsed = new URL(url);
  const target = path.join(stagingDir, `FAILED ${slugFromUrl(url)}.md`);
  const now = new Date().toISOString();
  const body = [
    "---",
    `source_url: ${yamlString(url)}`,
    `source_title: ${yamlString(parsed.hostname)}`,
    `imported_at: ${yamlString(now)}`,
    "import_method: guided_wechat_failed",
    "status: failed",
    `failure_stage: ${yamlString(stage)}`,
    `failure_reason: ${yamlString(reason)}`,
    "---",
    "",
    `# Guided import failed: ${parsed.hostname}`,
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

async function findCachedGuidedRaw(url) {
  const searchRoots = [
    stagingDir,
    path.join(workflowRoot, "imports", "wechat")
  ];
  const seen = new Set();

  for (const root of searchRoots) {
    const metaFiles = await listFilesBySuffix(root, ".meta.json");
    for (const metaPath of metaFiles) {
      if (seen.has(metaPath)) continue;
      seen.add(metaPath);
      const cached = await readCachedGuidedRaw(url, metaPath);
      if (cached) return cached;
    }
  }

  return null;
}

async function listFilesBySuffix(root, suffix) {
  const results = [];
  async function walk(current) {
    let entries = [];
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(fullPath);
      else if (entry.isFile() && entry.name.endsWith(suffix)) results.push(fullPath);
    }
  }
  await walk(root);
  return results;
}

async function readCachedGuidedRaw(url, metaPath) {
  try {
    const meta = JSON.parse(await fs.readFile(metaPath, "utf8"));
    if (meta.url !== url || !meta.rawMarkdown) return null;

    const rawMarkdownPath = path.resolve(meta.rawMarkdown);
    const markdown = await fs.readFile(rawMarkdownPath, "utf8");
    return {
      rawMarkdownPath,
      converted: {
        method: `${meta.method || "wechat_mp_html"}_cached_raw`,
        title: meta.title || titleFromMarkdown(markdown, slugFromUrl(url)),
        author: meta.author || "",
        publishedAt: meta.publishedAt || "",
        markdown
      }
    };
  } catch {
    return null;
  }
}

async function finishGuidedWechatImport(url, converted, { rawMarkdownPath = "", cachedRaw = false } = {}) {
  await fs.mkdir(stagingDir, { recursive: true });
  const slug = slugFromTitle(converted.title, slugFromUrl(url));
  const resolvedRawMarkdownPath = rawMarkdownPath || path.join(stagingDir, `${slug}.raw.md`);

  if (!rawMarkdownPath) {
    await fs.writeFile(resolvedRawMarkdownPath, `${converted.markdown.trim()}\n`, "utf8");
  }

  const processed = await writeMarkdown(url, converted);
  const metaPath = path.join(stagingDir, `${slug}.meta.json`);
  await fs.writeFile(metaPath, `${JSON.stringify({
    url, title: converted.title, method: converted.method, output: processed.target,
    rawMarkdown: resolvedRawMarkdownPath, cachedRaw, status: processed.status,
    preprocess: processed.receipt, instruction: importInstruction.trim() || undefined,
    importedAt: new Date().toISOString()
  }, null, 2)}\n`, "utf8");
  return { url, ...processed, method: cachedRaw ? "guided_wechat_cached_raw" : "guided_wechat", raw: resolvedRawMarkdownPath };
}

async function importGuidedWechatUrl(url) {
  let html = "";
  let converted = null;
  try {
    if (!isWechatMpUrl(url)) {
      const target = await writeGuidedFailure(url, "fetch", "guided_wechat_requires_mp_weixin_url");
      return { url, status: "failed", stage: "fetch", reason: "guided_wechat_requires_mp_weixin_url", target };
    }

    const { response, text } = await fetchText(url, {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36 MicroMessenger/8.0"
    });
    html = text;
    await fs.mkdir(stagingDir, { recursive: true });
    const htmlPath = path.join(stagingDir, `${slugFromUrl(url)}.html`);
    await fs.writeFile(htmlPath, html, "utf8");

    if (!response.ok) {
      const target = await writeGuidedFailure(url, "fetch", `http_${response.status}`, `HTML: ${htmlPath}`);
      return { url, status: "failed", stage: "fetch", reason: `http_${response.status}`, target };
    }

    try {
      converted = wechatHtmlToMarkdown(html, url);
    } catch (error) {
      const cached = await findCachedGuidedRaw(url);
      if (cached) {
        return finishGuidedWechatImport(url, cached.converted, {
          rawMarkdownPath: cached.rawMarkdownPath,
          cachedRaw: true
        });
      }
      const target = await writeGuidedFailure(url, "convert", error.message, `HTML: ${htmlPath}`);
      return { url, status: "failed", stage: "convert", reason: error.message, target };
    }

    return finishGuidedWechatImport(url, converted);
  } catch (error) {
    const target = await writeGuidedFailure(url, converted ? "write" : "fetch", error.message);
    return { url, status: "failed", stage: converted ? "write" : "fetch", reason: error.message, target };
  }
}

function csdiySourceUrlFromDocsRelative(relativePath) {
  const normalized = relativePath.replace(/\\/g, "/").replace(/\.md$/i, "");
  if (normalized === "index") return "https://csdiy.wiki/";
  return `https://csdiy.wiki/${encodeURI(normalized).replace(/%2F/g, "/")}/`;
}

function titleFromMarkdown(markdown, fallback) {
  return markdown.match(/^#\s+(.+)$/m)?.[1]?.trim() || fallback;
}

function frontmatter({ sourceUrl, sourceMarkdownUrl, title, method, status, extra = {} }) {
  const now = new Date().toISOString();
  const extraLines = Object.entries(extra)
    .map(([key, value]) => `${key}: ${yamlString(value)}`)
    .join("\n");
  const lines = [
    "---",
    `source_url: ${yamlString(sourceUrl)}`,
    sourceMarkdownUrl ? `source_markdown_url: ${yamlString(sourceMarkdownUrl)}` : null,
    `source_title: ${yamlString(title)}`,
    `imported_at: ${yamlString(now)}`,
    `import_method: ${yamlString(method)}`,
    `status: ${status}`,
    extraLines || null,
    "---",
    ""
  ].filter(Boolean);
  return `${lines.join("\n")}\n\n`;
}

async function pathExists(target) {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

async function ensureCsdiyRepo() {
  return ensureGitRepo("cs-self-learning", csdiyRepoUrl, "master");
}

async function ensureCsPlanRepo() {
  return ensureGitRepo("cs-plan", csPlanRepoUrl, "main");
}

async function ensureGitRepo(cacheName, repoUrl, branch) {
  const cacheDir = path.join(workflowRoot, ".cache");
  const cloneDir = path.join(cacheDir, cacheName);
  await fs.mkdir(cacheDir, { recursive: true });

  if (await pathExists(path.join(cloneDir, ".git"))) {
    await execFileAsync("git", ["-C", cloneDir, "fetch", "--depth=1", "origin", branch], { maxBuffer: 1024 * 1024 * 8 });
    await execFileAsync("git", ["-C", cloneDir, "checkout", "--force", "FETCH_HEAD"], { maxBuffer: 1024 * 1024 * 8 });
  } else {
    await execFileAsync("git", ["clone", "--depth=1", "--branch", branch, repoUrl, cloneDir], { maxBuffer: 1024 * 1024 * 8 });
  }

  const { stdout } = await execFileAsync("git", ["-C", cloneDir, "rev-parse", "HEAD"]);
  return { cloneDir, commit: stdout.trim() };
}

async function ghApiJson(endpoint, options = {}) {
  try {
    const { stdout } = await execFileAsync("gh", ["api", endpoint], {
      encoding: "utf8",
      maxBuffer: options.maxBuffer || 80 * 1024 * 1024,
      timeout: options.timeout || 120000,
      windowsHide: true
    });
    return JSON.parse(stdout);
  } catch (error) {
    throw new Error(`github_api_failed_${endpoint}: ${error.message}`);
  }
}

function encodeGithubPath(filePath) {
  return String(filePath || "")
    .split("/")
    .filter(Boolean)
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

function githubBlobUrl(repo, branch, filePath) {
  return `https://github.com/${repo.owner}/${repo.repo}/blob/${encodeURIComponent(branch)}/${encodeGithubPath(filePath)}`;
}

function githubRawUrl(repo, branch, filePath) {
  return `https://raw.githubusercontent.com/${repo.owner}/${repo.repo}/${encodeURIComponent(branch)}/${encodeGithubPath(filePath)}`;
}

function isReadableGithubMarkdownPath(filePath) {
  const normalized = String(filePath || "").replace(/\\/g, "/");
  const segments = normalized.split("/").filter(Boolean);
  if (segments.some((segment) => githubExcludedPathSegments.has(segment))) return false;
  if (githubExcludedFileNames.has(path.posix.basename(normalized))) return false;
  return githubReadableMarkdownExtensions.has(path.posix.extname(normalized).toLowerCase());
}

function isGithubLocaleSegment(segment) {
  return /^[a-z]{2}(?:-[a-z]{2})?$/i.test(String(segment || ""));
}

function isGithubChineseLocaleSegment(segment) {
  return /^zh(?:-|$)/i.test(String(segment || ""));
}

function preferredGithubChineseLocale(entries) {
  const localeSegments = entries.flatMap((entry) => entry.path.split("/").filter(isGithubChineseLocaleSegment));
  if (/繁体|正體|zh[-_]?TW|traditional/i.test(importInstruction) && localeSegments.some((segment) => /^zh-tw$/i.test(segment))) {
    return "zh-tw";
  }
  if (/简体|簡體|zh[-_]?CN|simplified/i.test(importInstruction) && localeSegments.some((segment) => /^zh-cn$/i.test(segment))) {
    return "zh-cn";
  }
  if (localeSegments.some((segment) => /^zh-cn$/i.test(segment))) return "zh-cn";
  if (localeSegments.some((segment) => /^zh-tw$/i.test(segment))) return "zh-tw";
  return "";
}

function shouldPreferGithubChineseSource(entries) {
  if (/全部语言|所有语言|多语言|all\s+languages/i.test(importInstruction)) return false;
  if (/中文|中文版|中文原文|不用双语|不要双语|Chinese|zh[-_]?CN|zh[-_]?TW/i.test(importInstruction)) return true;
  return entries.some((entry) => entry.path.split("/").some(isGithubChineseLocaleSegment));
}

function chooseGithubMarkdownEntries(entries) {
  const sorted = entries.slice().sort((a, b) => a.path.localeCompare(b.path));
  if (!shouldPreferGithubChineseSource(sorted)) {
    return { entries: sorted, selection: "all_readable_markdown" };
  }

  const preferredChinese = preferredGithubChineseLocale(sorted);
  const filtered = sorted.filter((entry) => {
    const segments = entry.path.split("/");
    return !segments.some((segment) => {
      if (!isGithubLocaleSegment(segment)) return false;
      if (!isGithubChineseLocaleSegment(segment)) return true;
      return preferredChinese && segment.toLowerCase() !== preferredChinese;
    });
  });
  if (filtered.length) {
    return { entries: filtered, selection: preferredChinese ? `chinese_source_markdown_${preferredChinese}` : "chinese_source_markdown" };
  }
  return { entries: sorted, selection: "all_readable_markdown_no_chinese_locale_found" };
}

function resolveGithubRelativeTarget(basePath, target) {
  const value = String(target || "").trim();
  const hashIndex = value.indexOf("#");
  const beforeHash = hashIndex >= 0 ? value.slice(0, hashIndex) : value;
  const hash = hashIndex >= 0 ? value.slice(hashIndex) : "";
  const queryIndex = beforeHash.indexOf("?");
  const rawPath = queryIndex >= 0 ? beforeHash.slice(0, queryIndex) : beforeHash;
  const query = queryIndex >= 0 ? beforeHash.slice(queryIndex) : "";
  if (!rawPath) return { path: "", suffix: `${query}${hash}` };

  const rootRelative = rawPath.startsWith("/");
  const baseDir = path.posix.dirname(String(basePath || "").replace(/\\/g, "/"));
  const joined = rootRelative
    ? rawPath.replace(/^\/+/, "")
    : path.posix.join(baseDir === "." ? "" : baseDir, rawPath);
  const normalized = path.posix.normalize(joined).replace(/^(\.\.\/)+/, "");
  return { path: normalized, suffix: `${query}${hash}` };
}

function rewriteGithubMarkdownLinks(markdown, { repo, branch, filePath, importedPaths }) {
  return String(markdown || "").replace(/(!?\[[^\]]*?\]\()([^) \t\n]+)(\))/g, (match, prefix, target, suffix) => {
    if (/^(?:[a-z][a-z0-9+.-]*:|#)/i.test(target)) return match;
    const resolved = resolveGithubRelativeTarget(filePath, target);
    if (!resolved.path) return match;

    const ext = path.posix.extname(resolved.path).toLowerCase();
    if (!prefix.startsWith("!") && githubReadableMarkdownExtensions.has(ext) && importedPaths.has(resolved.path)) {
      return match;
    }

    const absolute = prefix.startsWith("!")
      ? githubRawUrl(repo, branch, resolved.path)
      : githubBlobUrl(repo, branch, resolved.path);
    return `${prefix}${absolute}${resolved.suffix}${suffix}`;
  });
}

async function fetchGithubBlobMarkdown(repo, entry) {
  const data = await ghApiJson(`repos/${repo.owner}/${repo.repo}/git/blobs/${entry.sha}`, {
    maxBuffer: 120 * 1024 * 1024
  });
  if (!data?.content || data.encoding !== "base64") {
    throw new Error("github_blob_missing_base64_content");
  }
  return Buffer.from(String(data.content).replace(/\s+/g, ""), "base64").toString("utf8");
}

async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      results[currentIndex] = await worker(items[currentIndex], currentIndex);
    }
  });
  await Promise.all(workers);
  return results;
}

function githubRepoDirectoryMap(imported, maxLines = 80) {
  const groups = new Map();
  for (const item of imported) {
    const parts = item.relativePath.split("/");
    const key = parts.length >= 3 ? `${parts[0]}/${parts[1]}/${parts[2]}` : parts.slice(0, -1).join("/") || ".";
    groups.set(key, (groups.get(key) || 0) + 1);
  }
  return [...groups.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, maxLines)
    .map(([key, count]) => `- ${key}: ${count} 个文件`)
    .join("\n");
}

function githubRepoBriefInput(imported, maxChars = 35000) {
  const preferred = imported
    .slice()
    .sort((a, b) => {
      const score = (item) => {
        const lower = item.relativePath.toLowerCase();
        if (/(^|\/)readme\.mdx?$/.test(lower)) return 0;
        if (/(^|\/)(index|intro|introduction|guide|quickstart)\.mdx?$/.test(lower)) return 1;
        if (lower.includes("docs/")) return 2;
        return 3;
      };
      return score(a) - score(b) || a.relativePath.localeCompare(b.relativePath);
    });

  const parts = [];
  let length = 0;
  for (const item of preferred) {
    const excerpt = textForGuide(item.markdown, 3000);
    const block = [
      `FILE: ${item.relativePath}`,
      `TITLE: ${item.title}`,
      "",
      excerpt
    ].join("\n");
    if (length + block.length > maxChars) break;
    parts.push(block);
    length += block.length;
  }
  return parts.join("\n\n---\n\n");
}

function fallbackGithubRepoBrief({ repo, url, branch, imported, failures, reason = "" }) {
  const sample = imported.slice(0, 40).map((item, index) => `${index + 1}. ${item.relativePath}`).join("\n");
  const directoryMap = githubRepoDirectoryMap(imported);
  return [
    `# ${repo.owner}/${repo.repo} 项目导读`,
    "",
    "## 一句话项目核心",
    "",
    `- 这是一个从 GitHub 仓库导入的可读 Markdown 项目材料包，原文已按仓库目录结构落到本地阅读区。`,
    "",
    "## 材料地图",
    "",
    directoryMap || "- 未能生成目录地图。",
    "",
    "代表性文件：",
    "",
    sample || "- 未能列出文件。",
    "",
    "## 建议阅读顺序",
    "",
    "- 先读 README 或入口文档，再按目录进入教程、指南、案例或章节材料。",
    "",
    "## 最值得读的部分",
    "",
    "- 优先看 README、docs 目录、guide / intro / quickstart 类文件，以及标题最接近当前任务的章节。",
    "",
    "## 信息密度与价值判断",
    "",
    `- 待人工判断。已导入 ${imported.length} 个 Markdown 文件，失败 ${failures.length} 个。`,
    "",
    "## 对当前渐进阅读工作流的用途",
    "",
    "- 适合作为项目级材料包进入阅读区，后续可以按文件高亮、批注，再沉淀到 RemNote。",
    "",
    "## 导入注意事项",
    "",
    `- 仓库链接：${url}`,
    `- 分支：${branch}`,
    reason ? `- AI 项目导读生成失败，已使用保底导读：${reason}` : null
  ].filter(Boolean).join("\n");
}

function validateGithubRepoBrief(brief) {
  const required = [
    "# ",
    "## 一句话项目核心",
    "## 材料地图",
    "## 建议阅读顺序",
    "## 最值得读的部分",
    "## 信息密度与价值判断",
    "## 对当前渐进阅读工作流的用途"
  ];
  const missing = required.filter((heading) => !String(brief || "").includes(heading));
  if (missing.length) throw new Error(`github_repo_brief_missing_sections_${missing.join("_")}`);
  if (String(brief || "").length < 300) throw new Error("github_repo_brief_too_short");
}

async function generateGithubRepoBrief({ repo, url, branch, imported, failures }) {
  if (imported.length > 120) {
    return {
      markdown: fallbackGithubRepoBrief({
        repo,
        url,
        branch,
        imported,
        failures,
        reason: `仓库 Markdown 文件较多（${imported.length} 个），为避免导入阻塞，本次跳过 AI 项目导读，使用结构化保底导读。`
      }),
      method: "fallback_github_repo_brief_large_repo"
    };
  }

  try {
    const config = await loadProducerConfig();
    const fileMap = imported.map((item) => `- ${item.relativePath} (${item.title})`).join("\n");
    const prompt = [
      "你要为一个即将进入本地渐进阅读区的 GitHub 项目材料包生成一份项目级导读。",
      "这不是每篇文章的摘要，也不是双语翻译；只生成一份中文项目导读，帮助读者决定怎么读这个仓库里的 Markdown 材料。",
      "不要补充外部事实，只基于仓库文件名、README 和提供的 Markdown 摘录判断。",
      "原始材料已有中文版时，不要生成英文附录，不要做双语排版。",
      "",
      "必须使用以下 Markdown 结构：",
      `# ${repo.owner}/${repo.repo} 项目导读`,
      "## 一句话项目核心",
      "## 材料地图",
      "## 建议阅读顺序",
      "## 最值得读的部分",
      "## 信息密度与价值判断",
      "## 对当前渐进阅读工作流的用途",
      "## 导入注意事项",
      "",
      "具体要求：",
      "- 一句话项目核心：只写 1 句话。",
      "- 材料地图：按实际目录/文件组织说明这个项目包含哪些可读材料。",
      "- 建议阅读顺序：给 3-7 步，面向真实阅读和高亮操作。",
      "- 最值得读的部分：点名具体文件或目录，不要泛泛而谈。",
      "- 信息密度与价值判断：给 高 / 中 / 低 之一，并说明理由。",
      "- 对当前渐进阅读工作流的用途：说明它能怎样服务渐进阅读、AI 工作流、RemNote 卡片或学习/产品判断。",
      "- 导入注意事项：说明这是 GitHub Markdown 全量导入、未下载图片和非 Markdown 附件；如果有失败文件，简要提醒。",
      "- 不要输出 YAML，不要输出代码块。",
      "",
      "用户本次导入补充要求：",
      importInstruction.trim() || "无",
      "",
      `仓库链接：${url}`,
      `默认分支：${branch}`,
      `已导入 Markdown 文件数：${imported.length}`,
      `失败文件数：${failures.length}`,
      "",
      "文件地图：",
      fileMap,
      "",
      "关键 Markdown 摘录：",
      githubRepoBriefInput(imported)
    ].join("\n");

    const response = await fetch(chatCompletionsUrl(config.AI_PRODUCER_BASE_URL), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${config.DEEPSEEK_READING_API_KEY}`
      },
      body: JSON.stringify({
        model: config.AI_PRODUCER_MODEL,
        temperature: 0.2,
        messages: [
          { role: "system", content: "你是面向渐进阅读的项目级材料导读编辑，只基于输入材料生成中文导读。" },
          { role: "user", content: prompt }
        ]
      }),
      signal: AbortSignal.timeout(90000)
    });
    if (!response.ok) throw new Error(`api_${response.status}_${(await response.text()).slice(0, 500)}`);
    const data = await response.json();
    const brief = stripModelFences(data?.choices?.[0]?.message?.content || "");
    validateGithubRepoBrief(brief);
    return { markdown: brief, method: "deepseek_github_repo_brief" };
  } catch (error) {
    return {
      markdown: fallbackGithubRepoBrief({ repo, url, branch, imported, failures, reason: error.message }),
      method: "fallback_github_repo_brief_after_ai_error"
    };
  }
}

async function importGithubRepoMarkdown(url, repo) {
  const repoInfo = await ghApiJson(`repos/${repo.owner}/${repo.repo}`);
  const branch = repoInfo.default_branch;
  if (!branch) throw new Error("github_repo_missing_default_branch");

  const tree = await ghApiJson(`repos/${repo.owner}/${repo.repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`);
  const blobs = Array.isArray(tree.tree) ? tree.tree.filter((entry) => entry.type === "blob") : [];
  const candidateEntries = blobs
    .filter((entry) => isReadableGithubMarkdownPath(entry.path))
    .sort((a, b) => a.path.localeCompare(b.path));
  const { entries: markdownEntries, selection } = chooseGithubMarkdownEntries(candidateEntries);
  if (!markdownEntries.length) throw new Error("github_repo_no_readable_markdown");

  const targetRoot = path.join(outDir, `${sanitizePathSegment(repo.owner)}-${sanitizePathSegment(repo.repo)}`);
  await fs.mkdir(targetRoot, { recursive: true });
  const importedPaths = new Set(markdownEntries.map((entry) => entry.path.replace(/\\/g, "/")));
  const results = await mapWithConcurrency(markdownEntries, 16, async (entry) => {
    const relativePath = entry.path.replace(/\\/g, "/");
    try {
      const outputPath = path.join(targetRoot, outputRelativePathForDocsFile(relativePath));
      let original = "";
      if (await pathExists(outputPath)) {
        original = await fs.readFile(outputPath, "utf8");
      } else {
        original = await fetchGithubBlobMarkdown(repo, entry);
      }
      const markdown = rewriteGithubMarkdownLinks(original.trim(), {
        repo,
        branch,
        filePath: relativePath,
        importedPaths
      });
      await fs.mkdir(path.dirname(outputPath), { recursive: true });
      await fs.writeFile(outputPath, `${markdown}\n`, "utf8");
      return {
        ok: true,
        relativePath,
        sourceUrl: githubBlobUrl(repo, branch, relativePath),
        sourceMarkdownUrl: githubRawUrl(repo, branch, relativePath),
        target: outputPath,
        title: titleFromMarkdown(original, path.basename(relativePath, path.extname(relativePath))),
        markdown
      };
    } catch (error) {
      return { ok: false, file: relativePath, reason: error.message };
    }
  });

  const imported = results
    .filter((item) => item?.ok)
    .map(({ ok, ...item }) => item)
    .sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  const failures = results
    .filter((item) => item && !item.ok)
    .map(({ ok, ...item }) => item)
    .sort((a, b) => a.file.localeCompare(b.file));

  if (!imported.length) throw new Error(`github_repo_markdown_fetch_failed_all_${failures.map((item) => `${item.file}: ${item.reason}`).join("; ")}`);

  const brief = await generateGithubRepoBrief({ repo, url, branch, imported, failures });
  const briefPath = path.join(targetRoot, "00 项目导读.md");
  await fs.writeFile(briefPath, `${brief.markdown.trim()}\n`, "utf8");

  const reportPath = path.join(targetRoot, "IMPORT-REPORT.md");
  const reportLines = [
    "# GitHub repo import report",
    "",
    `- Source repo: https://github.com/${repo.owner}/${repo.repo}`,
    `- Default branch: ${branch}`,
    `- Selection: ${selection}`,
    `- Candidate markdown files: ${candidateEntries.length}`,
    `- Imported markdown files: ${imported.length}`,
    `- Skipped repository blobs: ${Math.max(0, blobs.length - markdownEntries.length)}`,
    `- Failed markdown files: ${failures.length}`,
    `- Output directory: ${targetRoot}`,
    `- Project brief: ${briefPath}`,
    `- Project brief method: ${brief.method}`,
    tree.truncated ? "- Warning: GitHub tree response was truncated." : null
  ].filter(Boolean);
  if (failures.length) {
    reportLines.push("", "## Failures", "", ...failures.map((item) => `- ${item.file}: ${item.reason}`));
  }
  await fs.writeFile(reportPath, `${reportLines.join("\n")}\n`, "utf8");

  return {
    url,
    status: failures.length ? "partial" : "imported",
    method: "github_repo_markdown_full",
    target: targetRoot,
    brief: briefPath,
    report: reportPath,
    files: imported.length,
    skipped: Math.max(0, blobs.length - markdownEntries.length),
    candidate_files: candidateEntries.length,
    failures: failures.length,
    default_branch: branch,
    selection,
    brief_method: brief.method
  };
}

function easyVibeSiteFromUrl(url) {
  const parsed = new URL(url);
  if (parsed.hostname !== "datawhalechina.github.io") return null;
  const parts = parsed.pathname.split("/").filter(Boolean);
  if (parts[0] !== "easy-vibe") return null;
  const locale = (parts[1] || "zh-cn").toLowerCase();
  if (!/^zh-cn$/i.test(locale)) return null;
  if (/\.mdx?$/i.test(parsed.pathname)) return null;
  return {
    locale,
    siteRoot: `https://datawhalechina.github.io/easy-vibe/${locale}/`,
    publicBase: `https://datawhalechina.github.io/easy-vibe`,
    routePrefix: `/${locale}/`
  };
}

function normalizeEasyVibeRoute(value, site) {
  if (!value) return "";
  let route = String(value)
    .replace(/&quot;/g, "\"")
    .replace(/&amp;/g, "&")
    .replace(/\\u002F/g, "/")
    .trim();
  if (/^https?:\/\//i.test(route)) {
    try {
      const parsed = new URL(route);
      if (parsed.hostname !== "datawhalechina.github.io") return "";
      route = parsed.pathname;
    } catch {
      return "";
    }
  }
  route = route.split("#")[0].split("?")[0];
  if (route.startsWith("/easy-vibe/")) route = route.slice("/easy-vibe".length);
  if (!route.startsWith(site.routePrefix)) return "";
  if (/\.(?:png|jpe?g|gif|svg|webp|css|js|json|ico|woff2?)$/i.test(route)) return "";
  route = route.replace(/\/index\.html\/?$/i, "/");
  route = route.replace(/\.html\/?$/i, "/");
  if (!route.endsWith("/") && !route.endsWith(".html") && !/\/[^/]+$/i.test(route)) return "";
  if (!route.endsWith("/")) route = `${route}/`;
  return route || site.routePrefix;
}

function extractEasyVibeRoutes(html, site) {
  const routes = new Set([site.routePrefix]);
  const text = String(html || "");
  const patterns = [
    /href="([^"]+)"/g,
    /"link":"([^"]+)"/g,
    /"link":"(\\\/[^"]+)"/g
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const route = normalizeEasyVibeRoute(match[1], site);
      if (route) routes.add(route);
    }
  }
  return [...routes].sort((a, b) => a.localeCompare(b));
}

async function fetchEasyVibeSitemapRoutes(site) {
  try {
    const sitemapUrl = `${site.publicBase}/sitemap.xml`;
    const { response, text } = await fetchText(sitemapUrl, {
      "Accept": "application/xml,text/xml,text/plain,*/*;q=0.8"
    });
    if (!response.ok) return [];
    const routes = new Set();
    for (const match of String(text || "").matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/gi)) {
      const route = normalizeEasyVibeRoute(match[1], site);
      if (route) routes.add(route);
    }
    return [...routes].sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
}

function easyVibeMarkdownCandidates(route, site) {
  let normalized = route.replace(/\/index\.html\/?$/i, "/");
  normalized = normalized.replace(/\.html\/?$/i, "");
  normalized = normalized.replace(/\/+$/g, "");
  if (!normalized || normalized === `/${site.locale}`) {
    return [`${site.publicBase}/${site.locale}/index.md`];
  }
  const withoutPrefix = normalized.replace(new RegExp(`^/${site.locale}/?`), "");
  if (!withoutPrefix) return [`${site.publicBase}/${site.locale}/index.md`];
  const base = `${site.publicBase}/${site.locale}/${withoutPrefix}`;
  return [`${base}/index.md`, `${base}.md`];
}

const easyVibeHumanDirs = {
  stage1: "01 零基础入门",
  stage2: "02 初中级开发",
  stage3: "03 高级开发",
  appendix: "04 附录",
  stories: "05 用户故事",
  other: "99 其他",
  introduction: "00 项目介绍.md",
  overview: "00 概览.md",
  learningMap: "00 学习地图.md",
  stage2Groups: {
    frontend: "01 前端开发",
    backend: "02 后端开发",
    assignments: "03 大作业",
    "ai-capabilities": "04 AI 能力扩展"
  },
  stage3Groups: {
    "core-skills": "01 核心技能",
    "cross-platform": "02 多平台开发",
    "personal-brand": "03 个人品牌",
    "ai-advanced": "04 AI 能力附录"
  },
  appendixGroups: {
    "1-computer-fundamentals": "01 计算机是怎么回事",
    "2-development-tools": "02 开发环境与工具",
    "3-browser-and-frontend": "03 浏览器与前端",
    "4-server-and-backend": "04 服务器与后端",
    "5-data": "05 数据",
    "6-architecture-and-system-design": "06 架构与系统设计",
    "7-infrastructure-and-operations": "07 基础设施与运维",
    "8-artificial-intelligence": "08 人工智能",
    "9-engineering-excellence": "09 工程素养"
  }
};

function easyVibeFlattenIndex(parts) {
  const copy = [...parts];
  const last = copy.pop();
  if (last === "index.md") {
    const base = copy.pop();
    return [...copy, `${base}.md`];
  }
  return parts;
}

function easyVibeHumanRelativePath(relativePath) {
  const parts = relativePath.replace(/\\/g, "/").split("/").filter(Boolean);
  const dirs = easyVibeHumanDirs;
  if (parts[0] === "stage-1") {
    if (parts.length === 3 && parts[2] === "index.md") {
      return path.join(dirs.stage1, parts[1] === "learning-map" ? dirs.learningMap : `${parts[1]}.md`);
    }
    return path.join(dirs.stage1, ...easyVibeFlattenIndex(parts.slice(1)));
  }
  if (parts[0] === "stage-2") {
    if (parts.length === 2 && parts[1] === "index.md") return path.join(dirs.stage2, dirs.overview);
    return path.join(dirs.stage2, dirs.stage2Groups[parts[1]] || parts[1], ...easyVibeFlattenIndex(parts.slice(2)));
  }
  if (parts[0] === "stage-3") {
    if (parts.length === 2 && parts[1] === "index.md") return path.join(dirs.stage3, dirs.overview);
    return path.join(dirs.stage3, dirs.stage3Groups[parts[1]] || parts[1], ...easyVibeFlattenIndex(parts.slice(2)));
  }
  if (parts[0] === "appendix") {
    if (parts.length === 2 && parts[1] === "index.md") return path.join(dirs.appendix, dirs.overview);
    return path.join(dirs.appendix, dirs.appendixGroups[parts[1]] || parts[1], ...easyVibeFlattenIndex(parts.slice(2)));
  }
  if (parts[0] === "vibe-stories") return path.join(dirs.stories, ...easyVibeFlattenIndex(parts.slice(1)));
  if (parts[0] === "guide" && parts[1] === "introduction.md") return dirs.introduction;
  if (parts[0] === "guide") return path.join(dirs.other, ...easyVibeFlattenIndex(parts));
  return path.join(dirs.other, ...easyVibeFlattenIndex(parts));
}

function easyVibeOutputRelativePath(route, mdUrl, site) {
  const parsed = new URL(mdUrl);
  let relative = decodeURIComponent(parsed.pathname)
    .replace(/^\/easy-vibe\//, "")
    .replace(new RegExp(`^${site.locale}/?`), "");
  if (!relative) relative = "index.md";
  return outputRelativePathForDocsFile(easyVibeHumanRelativePath(relative));
}

function transformMarkdownOutsideCodeFences(markdown, transform) {
  const text = String(markdown || "");
  const fencePattern = /^ {0,3}```[\s\S]*?^ {0,3}```[^\n]*\n?/gm;
  let result = "";
  let cursor = 0;
  for (const match of text.matchAll(fencePattern)) {
    result += transform(text.slice(cursor, match.index));
    result += match[0];
    cursor = match.index + match[0].length;
  }
  result += transform(text.slice(cursor));
  return result;
}

function reportNumber(report, label) {
  const escaped = String(label).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = String(report || "").match(new RegExp(`- ${escaped}:\\s*(\\d+)`, "i"));
  return match ? Number(match[1]) : 0;
}

function cleanEasyVibeMarkdown(markdown) {
  const withoutFrontmatter = String(markdown || "")
    .replace(/^\uFEFF?---\r?\n[\s\S]*?\r?\n---\s*/, "");
  return transformMarkdownOutsideCodeFences(withoutFrontmatter, (part) => part
    .replace(/<script\s+setup[^>]*>[\s\S]*?<\/script>\s*/gi, "")
    .replace(/<ClientOnly>[\s\S]*?<\/ClientOnly>\s*/gi, "")
    .replace(/<RelatedArticles[^>]*\/>\s*/gi, "")
    .replace(/<[A-Z][A-Za-z0-9]*\b[^>]*\/>\s*/g, "")
    .replace(/<\/?[A-Z][A-Za-z0-9]*\b[^>]*>\s*/g, "\n"))
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

async function archiveStaleEasyVibeOutput(targetRoot, relativePath, reason) {
  const stalePath = path.join(targetRoot, relativePath);
  try {
    await fs.access(stalePath);
  } catch {
    return "";
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const archiveRoot = path.join(workflowRoot, "imports", "web", "easy-vibe-stale", stamp);
  const archivePath = path.join(archiveRoot, relativePath);
  await fs.mkdir(path.dirname(archivePath), { recursive: true });
  await fs.rename(stalePath, archivePath);
  const notePath = path.join(archiveRoot, "STALE-REASON.txt");
  await fs.writeFile(notePath, `${reason}\nSource output: ${stalePath}\nArchived file: ${archivePath}\n`, "utf8");
  return archivePath;
}

async function fetchEasyVibeMarkdownForRoute(route, site) {
  const candidates = easyVibeMarkdownCandidates(route, site);
  const attempts = [];
  for (const mdUrl of candidates) {
    try {
      const { response, text } = await fetchText(mdUrl, {
        "Accept": "text/markdown,text/plain,*/*;q=0.8"
      });
      attempts.push(`${mdUrl} -> ${response.status}`);
      const trimmed = String(text || "").trim();
      if (response.ok && trimmed && !/^<!doctype html/i.test(trimmed)) {
        return { route, mdUrl, markdown: cleanEasyVibeMarkdown(trimmed) };
      }
    } catch (error) {
      attempts.push(`${mdUrl} -> ${error.message}`);
    }
  }
  throw new Error(`no_markdown_download_found: ${attempts.join("; ")}`);
}

function easyVibeSiteBrief({ url, site, imported, failures }) {
  const groups = new Map();
  for (const item of imported) {
    const parts = item.relativePath.replace(/\\/g, "/").split("/");
    const key = parts.length >= 2 ? parts.slice(0, 2).join("/") : ".";
    groups.set(key, (groups.get(key) || 0) + 1);
  }
  const mapLines = [...groups.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([key, count]) => `- ${key}: ${count} 个文件`);
  const samples = imported.slice(0, 50).map((item, index) => `${index + 1}. ${item.relativePath}`).join("\n");
  return [
    "# Easy-Vibe 站点导读",
    "",
    "## 一句话项目核心",
    "",
    "- 这是 Easy-Vibe 简体中文站点按公开 Markdown 下载入口导入的本地阅读材料包，结构更接近网站目录，而不是 GitHub 仓库源码目录。",
    "",
    "## 材料地图",
    "",
    ...mapLines,
    "",
    "## 建议阅读顺序",
    "",
    "- 先读 `index.md` 和 `stage-1`，建立 Vibe Coding 的学习地图。",
    "- 再读 `stage-2` 的前端、后端和综合项目，抽取可复用工作流。",
    "- 最后按需进入 `stage-3` 与 `appendix`，把工具、工程、AI 能力和系统设计拆成卡片。",
    "",
    "## 代表性文件",
    "",
    samples || "- 未能列出文件。",
    "",
    "## 导入注意事项",
    "",
    `- 来源站点：${url}`,
    `- 语言：${site.locale}`,
    `- 成功导入：${imported.length} 个 Markdown`,
    `- 失败：${failures.length} 个`,
    "- 本次通过站点公开 Markdown 下载入口导入；没有使用 GitHub repo tree/API 反查。",
    "- 原文文件已清理 VitePress frontmatter、script setup 和 RelatedArticles 组件，便于直接阅读。"
  ].join("\n");
}

async function importEasyVibeSiteMarkdown(url, site) {
  let siteHtml = "";
  let siteFetchError = "";
  try {
    const { response, text } = await fetchText(site.siteRoot);
    if (response.ok) {
      siteHtml = text;
    } else {
      siteFetchError = `easy_vibe_site_http_${response.status}`;
    }
  } catch (error) {
    siteFetchError = error.message;
  }
  const routes = [...new Set([
    ...await fetchEasyVibeSitemapRoutes(site),
    ...extractEasyVibeRoutes(siteHtml, site)
  ])].sort((a, b) => a.localeCompare(b));
  if (!routes.length) throw new Error(siteFetchError ? `easy_vibe_no_routes_found: ${siteFetchError}` : "easy_vibe_no_routes_found");

  const targetRoot = path.join(outDir, `easy-vibe-${site.locale}-site`);
  await fs.mkdir(targetRoot, { recursive: true });
  const results = await mapWithConcurrency(routes, 16, async (route) => {
    try {
      if (route === site.routePrefix) {
        const relativePath = "index.md";
        const archived = await archiveStaleEasyVibeOutput(targetRoot, relativePath, "root_home_page_has_no_readable_markdown_body");
        return {
          ok: false,
          skipped: true,
          route,
          mdUrl: `${site.publicBase}/${site.locale}/index.md`,
          relativePath,
          reason: "root_home_page_has_no_readable_markdown_body",
          archived
        };
      }
      const item = await fetchEasyVibeMarkdownForRoute(route, site);
      const relativePath = easyVibeOutputRelativePath(route, item.mdUrl, site);
      if (!item.markdown) {
        const archived = await archiveStaleEasyVibeOutput(targetRoot, relativePath, "empty_markdown_after_cleaning");
        return {
          ok: false,
          skipped: true,
          route,
          mdUrl: item.mdUrl,
          relativePath,
          reason: "empty_markdown_after_cleaning",
          archived
        };
      }
      const outputPath = path.join(targetRoot, relativePath);
      const pageUrl = new URL(route.replace(/^\//, ""), site.publicBase.endsWith("/") ? site.publicBase : `${site.publicBase}/`).toString();
      const markdown = absolutizeMarkdownLinks(item.markdown, pageUrl);
      await fs.mkdir(path.dirname(outputPath), { recursive: true });
      await fs.writeFile(outputPath, `${markdown.trim()}\n`, "utf8");
      return {
        ok: true,
        route,
        mdUrl: item.mdUrl,
        relativePath,
        target: outputPath,
        title: titleFromMarkdown(markdown, path.basename(relativePath, path.extname(relativePath))),
        markdown
      };
    } catch (error) {
      return { ok: false, route, reason: error.message };
    }
  });

  const imported = results
    .filter((item) => item?.ok)
    .map(({ ok, ...item }) => item)
    .sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  const skipped = results
    .filter((item) => item?.skipped)
    .map(({ skipped: _skipped, ...item }) => item)
    .sort((a, b) => a.route.localeCompare(b.route));
  const failures = results
    .filter((item) => item && !item.ok && !item.skipped)
    .map(({ ok, ...item }) => item)
    .sort((a, b) => a.route.localeCompare(b.route));

  const briefPath = path.join(targetRoot, "00 站点导读.md");
  const reportPath = path.join(targetRoot, "IMPORT-REPORT.md");

  if (!imported.length) {
    const existingFiles = await listMarkdownFiles(targetRoot).catch(() => []);
    const existingReadableFiles = existingFiles.filter((file) => {
      const name = path.basename(file);
      return name !== "IMPORT-REPORT.md" && !name.startsWith("00 ");
    });
    const existingReport = await fs.readFile(reportPath, "utf8").catch(() => "");
    if (existingReadableFiles.length && existingReport.includes("vitepress_site_markdown_download")) {
      return {
        url,
        status: "imported",
        method: "vitepress_site_markdown_download",
        target: targetRoot,
        brief: briefPath,
        report: reportPath,
        files: reportNumber(existingReport, "Imported markdown files") || existingReadableFiles.length,
        routes: reportNumber(existingReport, "Routes found") || routes.length,
        failures: reportNumber(existingReport, "Failed routes"),
        skipped: reportNumber(existingReport, "Skipped non-readable routes") || skipped.length,
        locale: site.locale,
        cached: true,
        note: "used_existing_easy_vibe_site_output_after_fetch_failure"
      };
    }
    throw new Error(`easy_vibe_markdown_fetch_failed_all_${failures.map((item) => `${item.route}: ${item.reason}`).join("; ")}`);
  }

  await fs.writeFile(briefPath, `${easyVibeSiteBrief({ url, site, imported, failures })}\n`, "utf8");

  const reportLines = [
    "# Easy-Vibe site Markdown import report",
    "",
    `- Source site: ${url}`,
    `- Site root: ${site.siteRoot}`,
    `- Method: vitepress_site_markdown_download`,
    `- Routes found: ${routes.length}`,
    `- Imported markdown files: ${imported.length}`,
    `- Skipped non-readable routes: ${skipped.length}`,
    `- Failed routes: ${failures.length}`,
    `- Output directory: ${targetRoot}`,
    `- Site brief: ${briefPath}`,
    "",
    "## Notes",
    "",
    "- Imported from public site Markdown download endpoints.",
    "- Did not use GitHub repo tree/API fallback.",
    "- VitePress frontmatter and local component wrappers were cleaned for reading."
  ];
  if (failures.length) {
    reportLines.push("", "## Failures", "", ...failures.map((item) => `- ${item.route}: ${item.reason}`));
  }
  if (skipped.length) {
    reportLines.push(
      "",
      "## Skipped non-readable routes",
      "",
      ...skipped.map((item) => {
        const archived = item.archived ? `; archived stale file: ${item.archived}` : "";
        return `- ${item.route}: ${item.reason}${archived}`;
      })
    );
  }
  await fs.writeFile(reportPath, `${reportLines.join("\n")}\n`, "utf8");

  return {
    url,
    status: failures.length ? "partial" : "imported",
    method: "vitepress_site_markdown_download",
    target: targetRoot,
    brief: briefPath,
    report: reportPath,
    files: imported.length,
    routes: routes.length,
    failures: failures.length,
    skipped: skipped.length,
    locale: site.locale
  };
}

async function listMarkdownFiles(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listMarkdownFiles(fullPath));
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
      files.push(fullPath);
    }
  }
  return files;
}

function outputRelativePathForDocsFile(relativePath) {
  const segments = relativePath.split(/[\\/]+/).map(sanitizePathSegment);
  return path.join(...segments);
}

async function importCsdiySite() {
  const targetRoot = path.join(outDir, "csdiy-full");
  const { cloneDir, commit } = await ensureCsdiyRepo();
  const docsDir = path.join(cloneDir, "docs");
  const files = await listMarkdownFiles(docsDir);
  const imported = [];
  const failures = [];

  for (const filePath of files) {
    const relativePath = path.relative(docsDir, filePath);
    try {
      const sourceUrl = csdiySourceUrlFromDocsRelative(relativePath);
      const rawRelative = `docs/${relativePath.replace(/\\/g, "/")}`;
      const sourceMarkdownUrl = `${csdiyRawBase}${encodeURI(rawRelative).replace(/%2F/g, "/")}`;
      const original = await fs.readFile(filePath, "utf8");
      const title = titleFromMarkdown(original, path.basename(relativePath, ".md"));
      const markdown = absolutizeMarkdownLinks(original.trim(), sourceUrl);
      const outputPath = path.join(targetRoot, outputRelativePathForDocsFile(relativePath));
      await fs.mkdir(path.dirname(outputPath), { recursive: true });
      const body = `${frontmatter({
        sourceUrl,
        sourceMarkdownUrl,
        title,
        method: "github_repo_markdown_full",
        status: "imported",
        extra: {
          source_repo: csdiyRepoUrl,
          source_commit: commit,
          source_file: rawRelative
        }
      })}${markdown}\n`;
      await fs.writeFile(outputPath, body, "utf8");
      imported.push({ sourceUrl, target: outputPath });
    } catch (error) {
      failures.push({ file: relativePath, reason: error.message });
    }
  }

  const reportPath = path.join(targetRoot, "IMPORT-REPORT.md");
  const reportLines = [
    "# CSDIY full import report",
    "",
    `- Source site: https://csdiy.wiki/`,
    `- Source repo: ${csdiyRepoUrl}`,
    `- Source commit: ${commit}`,
    `- Imported files: ${imported.length}`,
    `- Failed files: ${failures.length}`,
    `- Output directory: ${targetRoot}`,
    "",
    "## Notes",
    "",
    "- Markdown source was imported from the public GitHub repository instead of rendered HTML.",
    "- Relative Markdown links and image links were rewritten to csdiy.wiki absolute URLs.",
    "- The original directory structure under `docs/` was preserved.",
  ];
  if (failures.length) {
    reportLines.push("", "## Failures", "", ...failures.map(item => `- ${item.file}: ${item.reason}`));
  }
  await fs.writeFile(reportPath, `${reportLines.join("\n")}\n`, "utf8");

  return {
    status: failures.length ? "partial" : "imported",
    method: "github_repo_markdown_full",
    files: imported.length,
    failures: failures.length,
    target: targetRoot,
    report: reportPath,
    source_commit: commit
  };
}

function csPlanSourceUrlFromDocsRelative(relativePath) {
  const normalized = relativePath.replace(/\\/g, "/").replace(/\.md$/i, "");
  if (normalized === "index") return "https://cs-plan.com/";
  return `https://cs-plan.com/${encodeURI(normalized).replace(/%2F/g, "/")}/`;
}

async function importCsPlanSite() {
  const targetRoot = path.join(outDir, "cs-plan-full");
  const { cloneDir, commit } = await ensureCsPlanRepo();
  const docsDir = path.join(cloneDir, "docs");
  const files = await listMarkdownFiles(docsDir);
  const imported = [];
  const failures = [];

  for (const filePath of files) {
    const relativePath = path.relative(docsDir, filePath);
    try {
      const sourceUrl = csPlanSourceUrlFromDocsRelative(relativePath);
      const rawRelative = `docs/${relativePath.replace(/\\/g, "/")}`;
      const sourceMarkdownUrl = `${csPlanRawBase}${encodeURI(rawRelative).replace(/%2F/g, "/")}`;
      const original = await fs.readFile(filePath, "utf8");
      const title = titleFromMarkdown(original, path.basename(relativePath, ".md"));
      const markdown = absolutizeMarkdownLinks(original.trim(), sourceUrl);
      const outputPath = path.join(targetRoot, outputRelativePathForDocsFile(relativePath));
      await fs.mkdir(path.dirname(outputPath), { recursive: true });
      const body = `${frontmatter({
        sourceUrl,
        sourceMarkdownUrl,
        title,
        method: "github_repo_markdown_full",
        status: "imported",
        extra: {
          source_repo: csPlanRepoUrl,
          source_commit: commit,
          source_file: rawRelative
        }
      })}${markdown}\n`;
      await fs.writeFile(outputPath, body, "utf8");
      imported.push({ sourceUrl, target: outputPath });
    } catch (error) {
      failures.push({ file: relativePath, reason: error.message });
    }
  }

  const reportPath = path.join(targetRoot, "IMPORT-REPORT.md");
  const reportLines = [
    "# CS Plan full import report",
    "",
    "- Source site: https://cs-plan.com/",
    `- Source repo: ${csPlanRepoUrl}`,
    `- Source commit: ${commit}`,
    `- Imported files: ${imported.length}`,
    `- Failed files: ${failures.length}`,
    `- Output directory: ${targetRoot}`,
    "",
    "## Notes",
    "",
    "- Markdown source was imported from the public GitHub repository instead of rendered HTML.",
    "- Relative Markdown links and image links were rewritten to cs-plan.com absolute URLs where possible.",
    "- The original directory structure under `docs/` was preserved."
  ];
  if (failures.length) {
    reportLines.push("", "## Failures", "", ...failures.map(item => `- ${item.file}: ${item.reason}`));
  }
  await fs.writeFile(reportPath, `${reportLines.join("\n")}\n`, "utf8");

  return {
    status: failures.length ? "partial" : "imported",
    method: "github_repo_markdown_full",
    files: imported.length,
    failures: failures.length,
    target: targetRoot,
    report: reportPath,
    source_commit: commit
  };
}

async function writeFailure(url, reason, detail = "") {
  await fs.mkdir(outDir, { recursive: true });
  const parsed = new URL(url);
  const filename = `FAILED ${slugFromUrl(url)}.md`;
  const target = path.join(outDir, filename);
  const now = new Date().toISOString();
  const body = `---\nsource_url: ${yamlString(url)}\nsource_title: ${yamlString(parsed.hostname)}\nimported_at: ${yamlString(now)}\nimport_method: failed\nstatus: failed\nfailure_reason: ${yamlString(reason)}\n---\n\n# Import failed: ${parsed.hostname}\n\n- URL: ${url}\n- Reason: ${reason}\n${detail ? `- Detail: ${detail}\n` : ""}\n`;
  await fs.writeFile(target, body, "utf8");
  return target;
}

const summary = [];

if (importCsdiyFull) {
  try {
    summary.push(await importCsdiySite());
  } catch (error) {
    summary.push({
      url: "https://csdiy.wiki/",
      status: "failed",
      method: "github_repo_markdown_full",
      reason: error.message
    });
  }
}

if (importCsPlanFull) {
  try {
    summary.push(await importCsPlanSite());
  } catch (error) {
    summary.push({
      url: "https://cs-plan.com/",
      status: "failed",
      method: "github_repo_markdown_full",
      reason: error.message
    });
  }
}

if (browserContentPath) {
  const capture = JSON.parse(await fs.readFile(browserContentPath, "utf8"));
  if (!Array.isArray(capture?.items) || capture.items.length === 0) {
    throw new Error("browser_capture_items_missing");
  }
  const baseOutDir = outDir;
  for (let index = 0; index < capture.items.length; index += 1) {
    const item = capture.items[index];
    const sourceUrl = String(item?.url || "");
    const itemIndex = Number(item?.index) || index + 1;
    outDir = capture.layout === "column_folders"
      ? path.join(baseOutDir, sanitizePathSegment(String(item?.columnName || "未分类专栏")))
      : capture.layout === "flat"
        ? baseOutDir
        : path.join(baseOutDir, String(itemIndex).padStart(3, "0"));
    console.error(`[browser-content ${index + 1}/${capture.items.length}] ${sourceUrl}`);
    try {
      const converted = browserExtractedHtmlToMarkdown(item);
      const processed = await writeMarkdown(sourceUrl, converted, { ...processingOptions, ...item.processing_options });
      summary.push({
        index: itemIndex,
        url: sourceUrl,
        ...processed,
        method: converted.method,
        column: converted.sourceColumn || ""
      });
    } catch (error) {
      const target = await writeFailure(sourceUrl, error.message);
      summary.push({
        index: itemIndex,
        url: sourceUrl,
        status: "failed",
        reason: error.message,
        target
      });
    }
  }
  outDir = baseOutDir;
}

for (const url of urls) {
  try {
    if (guidedWechat) {
      summary.push(await importGuidedWechatUrl(url));
      continue;
    }

    const easyVibeSite = easyVibeSiteFromUrl(url);
    if (easyVibeSite) {
      summary.push(await importEasyVibeSiteMarkdown(url, easyVibeSite));
      continue;
    }

    const githubRepo = githubRepoRootFromUrl(url);
    if (githubRepo) {
      summary.push(await importGithubRepoMarkdown(url, githubRepo));
      continue;
    }

    const sourceMarkdown = await trySourceMarkdown(url);
    if (sourceMarkdown) {
      const processed = await writeMarkdown(url, sourceMarkdown);
      summary.push({ url, ...processed, method: sourceMarkdown.method });
      continue;
    }

    const fetchOptions = isWechatMpUrl(url)
      ? {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36 MicroMessenger/8.0"
        }
      : {};
    const { response, text } = await fetchText(url, fetchOptions);
    if (hasFeishuLoginShell(text, url)) {
      const target = await writeFailure(url, "login_required_or_no_public_html", `HTTP ${response.status}`);
      summary.push({ url, status: "failed", reason: "login_required_or_no_public_html", target });
      continue;
    }

    if (!response.ok) {
      const target = await writeFailure(url, `http_${response.status}`);
      summary.push({ url, status: "failed", reason: `http_${response.status}`, target });
      continue;
    }

    const converted = isWechatMpUrl(url) ? wechatHtmlToMarkdown(text, url) : htmlToMarkdown(text, url);
    const processed = await writeMarkdown(url, converted);
    summary.push({ url, ...processed, method: converted.method });
  } catch (error) {
    const target = await writeFailure(url, error.message);
    summary.push({ url, status: "failed", reason: error.message, target });
  }
}

if (receiptPath) {
  await fs.mkdir(path.dirname(receiptPath), { recursive: true });
  await fs.writeFile(receiptPath, `${JSON.stringify({
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    browserContentPath: browserContentPath || null,
    outDir,
    summary
  }, null, 2)}\n`, "utf8");
}

console.log(JSON.stringify(summary, null, 2));
