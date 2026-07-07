import fs from "node:fs/promises";
import path from "node:path";
import { execFile, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { JSDOM } from "jsdom";
import { Readability } from "@mozilla/readability";
import TurndownService from "turndown";
import { gfm } from "turndown-plugin-gfm";
import sanitize from "sanitize-filename";

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../../..");
const workflowRoot = path.resolve(__dirname, "..");
const defaultOutDir = path.join(workflowRoot, "imports", "Web Markdown Import Experiments");
const guidedRunName = `${new Date().toISOString().slice(0, 10)}-guided-wechat`;
const defaultGuidedOutDir = path.join(workflowRoot, "阅读区", "微信", guidedRunName);
const defaultGuidedStagingDir = path.join(workflowRoot, "imports", "wechat", guidedRunName);
const producerConfigDir = path.join(process.env.USERPROFILE || process.env.HOME || "", "Documents", "New project");
const producerConfigKeys = ["AI_PRODUCER_BASE_URL", "AI_PRODUCER_API_KEY", "AI_PRODUCER_MODEL"];
const csdiyRepoUrl = "https://github.com/PKUFlyingPig/cs-self-learning.git";
const csdiyRawBase = "https://raw.githubusercontent.com/PKUFlyingPig/cs-self-learning/master/";
const csPlanRepoUrl = "https://github.com/MingLLuo/CS-Plan.git";
const csPlanRawBase = "https://raw.githubusercontent.com/MingLLuo/CS-Plan/main/";

const args = process.argv.slice(2);
const urls = [];
let outDir = defaultOutDir;
let stagingDir = defaultGuidedStagingDir;
let importCsdiyFull = false;
let importCsPlanFull = false;
let guidedWechat = false;
let importInstruction = "";

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

if (urls.length === 0 && !importCsdiyFull && !importCsPlanFull) {
  console.error("Usage: npm run import -- <url...> [--out <dir>]\n       npm run import:guided -- <wechat-url...> [--out <dir>] [--staging <dir>] [--instruction <text>]\n       npm run import:csdiy -- [--out <dir>]\n       npm run import:cs-plan -- [--out <dir>]");
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

async function trySourceMarkdown(url) {
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

async function writeMarkdown(url, result) {
  await fs.mkdir(outDir, { recursive: true });
  const parsed = new URL(url);
  const title = result.title || result.markdown.match(/^#\s+(.+)$/m)?.[1] || parsed.hostname;
  const filename = `${slugFromTitle(title, parsed.hostname)}.md`;
  const target = path.join(outDir, filename);
  const now = new Date().toISOString();
  const sourceLine = result.rawUrl ? `source_markdown_url: ${yamlString(result.rawUrl)}\n` : "";
  const outline = await ensureMarkdownOutline({
    markdown: result.markdown,
    title,
    url,
    method: result.method
  });
  const guide = await generateReadingGuideForImport({
    markdown: result.markdown,
    title,
    url,
    author: result.author || "",
    publishedAt: result.publishedAt || ""
  });
  const body = [
    "---",
    `source_url: ${yamlString(url)}`,
    sourceLine.trim() || null,
    `source_title: ${yamlString(title)}`,
    `imported_at: ${yamlString(now)}`,
    `import_method: ${yamlString(result.method)}`,
    `outline_method: ${yamlString(outline.method)}`,
    `reading_guide_method: ${yamlString(guide.method)}`,
    "status: imported",
    "reading_guide: true",
    "---",
    "",
    "<!-- reading-guide:start -->",
    "",
    guide.markdown.trim(),
    "",
    "<!-- reading-guide:end -->",
    "",
    "---",
    "",
    "## 原文",
    "",
    outline.markdown.trim(),
    ""
  ].filter((line) => line !== null).join("\n");
  await fs.writeFile(target, body, "utf8");
  return target;
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

function chatCompletionsUrl(baseUrl) {
  const trimmed = String(baseUrl || "").replace(/\/+$/, "");
  if (/\/chat\/completions$/i.test(trimmed)) return trimmed;
  return `${trimmed}/chat/completions`;
}

function stripModelFences(text) {
  return String(text || "")
    .trim()
    .replace(/^```(?:markdown|md)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
}

function textForGuide(markdown, maxChars = 60000) {
  return markdown
    .replace(/^---[\s\S]*?---\s*/g, "")
    .replace(/!\[[^\]]*?\]\([^)]+?\)/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .slice(0, maxChars);
}

async function callDeepSeekForGuide(config, { title, url, author, publishedAt, markdown, instruction = "" }) {
  const prompt = [
    "你要为一篇即将进入渐进阅读流程的文章生成“阅读前置卡”。",
    "它不是传统摘要，不要复述全文，不要写成读后感，不要补充外部事实。",
    "这张卡的目标是先用极高密度判断这篇文章的核心、洞见、个人价值、信息密度、能解决的痛点、具体用处，以及是否急需阅读。",
    "",
    "必须输出 Markdown，且严格使用这些标题：",
    "## 阅读前置卡",
    "### 一句话核心",
    "### 核心洞见",
    "### 对我的价值判断",
    "### 信息密度判断",
    "### 能解决我的什么痛点",
    "### 具体用处",
    "### 是否急需阅读",
    "",
    "具体要求：",
    "- “一句话核心”只写 1 句话，直接概括这篇文章最核心的东西是什么。",
    "- “核心洞见”列 3-6 条，用高度凝练的转述表达最重要的观点、判断、模型、案例或概念，不要大段引用原文。",
    "- “对我的价值判断”必须给 高 / 中 / 低 / 跳过 之一，并用 1-3 句话说明对这个读者的价值性，不要泛泛夸奖。",
    "- “信息密度判断”必须给 高 / 中 / 低 之一，并说明密度来自新事实、新框架、真实案例、方法论、经验判断，还是只是观点重复。",
    "- “能解决我的什么痛点”列 2-5 条，必须结合读者背景，指出它能缓解或推进的具体问题。",
    "- “具体用处”列 2-5 条，说明它可用于 RemNote 卡片、渐进阅读高亮、AI 工作流、教育产品、课程/讲义、创业判断、研究选题或写作中的哪类沉淀。",
    "- “是否急需阅读”必须给 急需 / 近期 / 可延后 / 可跳过 之一，并给一句理由。",
    "- 不要写阅读路径，不要写带着哪些问题读，不要写传统摘要，不要写鸡汤式评价。",
    "- 不要输出 YAML，不要输出代码块。",
    "",
    "用户本次导入补充要求：",
    instruction.trim() || "无",
    "",
    "读者背景，只用于判断个人相关性，不要捏造额外事实：",
    "- 读者正在搭建以 RemNote、Codex、AI Agent、渐进阅读和卡片化沉淀为核心的个人知识与生产系统。",
    "- 读者关注 AI 工作流、Agent 编排、教育科技、学习科学、间隔重复、增量阅读、课程/讲义生产、创业与产品判断。",
    "- 读者偏好高密度、可操作、能沉淀为卡片或工作流的材料；反感空泛总结、营销式判断和低信息密度内容。",
    "",
    `标题：${title || ""}`,
    `链接：${url}`,
    `作者/账号：${author || ""}`,
    `发布时间：${publishedAt || ""}`,
    "",
    "原文 Markdown：",
    textForGuide(markdown)
  ].join("\n");

  const payload = {
    model: config.AI_PRODUCER_MODEL,
    temperature: 0.2,
    messages: [
      {
        role: "system",
        content: "你是面向渐进阅读的导读编辑。你只生成读前价值判断卡，不生成传统摘要，不新增外部事实。"
      },
      { role: "user", content: prompt }
    ]
  };

  let lastError = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(chatCompletionsUrl(config.AI_PRODUCER_BASE_URL), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${config.AI_PRODUCER_API_KEY}`
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(180000)
      });
      if (!response.ok) throw new Error(`api_${response.status}_${(await response.text()).slice(0, 500)}`);
      const data = await response.json();
      const guide = stripModelFences(data?.choices?.[0]?.message?.content || "");
      validateGuide(guide);
      return guide;
    } catch (error) {
      lastError = error;
      if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, attempt * 2000));
    }
  }
  throw lastError;
}

function validateGuide(guide) {
  const required = [
    "## 阅读前置卡",
    "### 一句话核心",
    "### 核心洞见",
    "### 对我的价值判断",
    "### 信息密度判断",
    "### 能解决我的什么痛点",
    "### 具体用处",
    "### 是否急需阅读"
  ];
  const missing = required.filter((heading) => !guide.includes(heading));
  if (missing.length) throw new Error(`guide_missing_sections_${missing.join("_")}`);
  if (guide.length < 350) throw new Error("guide_too_short");
}

async function generateReadingGuideForImport({ markdown, title, url, author = "", publishedAt = "" }) {
  try {
    const config = await loadProducerConfig();
    const guide = await callDeepSeekForGuide(config, {
      title,
      url,
      author,
      publishedAt,
      markdown,
      instruction: importInstruction
    });
    return { markdown: guide, method: "deepseek_reading_guide" };
  } catch (error) {
    return {
      markdown: [
        "## 阅读前置卡",
        "",
        "### 一句话核心",
        "",
        "- AI 前置卡生成失败，保留原文进入阅读流程。",
        "",
        "### 核心洞见",
        "",
        "- 待阅读时人工判断。",
        "",
        "### 对我的价值判断",
        "",
        "- 待判断。",
        "",
        "### 信息密度判断",
        "",
        "- 待判断。",
        "",
        "### 能解决我的什么痛点",
        "",
        "- 待判断。",
        "",
        "### 具体用处",
        "",
        "- 待判断。",
        "",
        "### 是否急需阅读",
        "",
        `- 待判断。生成失败原因：${error.message}`
      ].join("\n"),
      method: "fallback_after_ai_error"
    };
  }
}

async function ensureMarkdownOutline({ markdown, title, url, method }) {
  const normalized = String(markdown || "").trim();
  if (hasUsableOutline(normalized)) {
    return { markdown: normalized, method: "existing_headings" };
  }

  try {
    const config = await loadProducerConfig();
    const structured = await callDeepSeekForOutline(config, {
      title,
      url,
      method,
      markdown: normalized
    });
    if (hasUsableOutline(structured)) {
      return { markdown: structured, method: "deepseek_outline" };
    }
    return {
      markdown: fallbackOutlineMarkdown(normalized, title),
      method: "fallback_body_heading_after_ai_validation_failed"
    };
  } catch (error) {
    console.error(`outline generation failed for ${url}: ${error.message}`);
    return {
      markdown: fallbackOutlineMarkdown(normalized, title),
      method: "fallback_body_heading_after_ai_error"
    };
  }
}

async function callDeepSeekForOutline(config, { title, url, method, markdown }) {
  const prompt = [
    "你要把一篇即将进入 Obsidian 渐进阅读流程的 Markdown 文章补出简洁层级标题。",
    "目标：让 Obsidian 右侧 Outline 能看到文章结构，方便逐层阅读。",
    "",
    "严格要求：",
    "- 只在合适位置插入 Markdown 标题，不写目录，不写摘要，不写阅读建议。",
    "- 尽量保留原文全部段落、列表、引用、链接和顺序。",
    "- 不要改写原文句子，不要删除原文内容，不要新增外部事实。",
    "- 如果已有一级标题，可以保留；正文中补 3-10 个二级/三级标题。",
    "- 标题要短，像真实文章小标题，不要写“第一部分/第二部分”这种空标题。",
    "- 输出完整 Markdown 正文，不要输出 YAML，不要输出代码块。",
    "",
    `标题：${title || ""}`,
    `链接：${url}`,
    `导入方法：${method || ""}`,
    "",
    "原文 Markdown：",
    textForGuide(markdown, 90000)
  ].join("\n");

  const payload = {
    model: config.AI_PRODUCER_MODEL,
    temperature: 0.1,
    messages: [
      {
        role: "system",
        content: "你是 Markdown 结构化编辑。你只能插入标题来组织原文，不做摘要和改写。"
      },
      { role: "user", content: prompt }
    ]
  };

  let lastError = null;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const response = await fetch(chatCompletionsUrl(config.AI_PRODUCER_BASE_URL), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${config.AI_PRODUCER_API_KEY}`
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(180000)
      });
      if (!response.ok) throw new Error(`api_${response.status}_${(await response.text()).slice(0, 500)}`);
      const data = await response.json();
      return stripModelFences(data?.choices?.[0]?.message?.content || "");
    } catch (error) {
      lastError = error;
      if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, attempt * 2000));
    }
  }
  throw lastError;
}

function hasUsableOutline(markdown) {
  const lines = stripFrontmatter(String(markdown || "")).split(/\r?\n/);
  const headings = lines
    .map((line) => /^(#{1,6})\s+\S/.exec(line))
    .filter(Boolean)
    .map((match) => match[1].length);
  return headings.some((level) => level >= 2);
}

function fallbackOutlineMarkdown(markdown, title) {
  const body = String(markdown || "").trim();
  if (!body) return `# ${title || "Untitled"}\n\n## 正文\n`;
  if (/^#\s+\S/m.test(body)) {
    return body.replace(/^#\s+(.+)$/m, (match) => `${match}\n\n## 正文`);
  }
  return `# ${title || "Untitled"}\n\n## 正文\n\n${body}\n`;
}

function keepsEnoughSourceText(source, structured) {
  const sourceText = normalizeOutlineComparable(source);
  const structuredText = normalizeOutlineComparable(structured);
  if (sourceText.length < 1000) return structuredText.length >= Math.floor(sourceText.length * 0.75);
  const sample = sourceText.slice(Math.floor(sourceText.length * 0.2), Math.floor(sourceText.length * 0.2) + 500);
  return structuredText.length >= Math.floor(sourceText.length * 0.75) && structuredText.includes(sample.slice(0, 120));
}

function normalizeOutlineComparable(value) {
  return stripFrontmatter(String(value || ""))
    .replace(/^#{1,6}\s+.+$/gm, "")
    .replace(/\s+/g, "");
}

function stripFrontmatter(value) {
  return String(value || "").replace(/^---\s*[\s\S]*?\n---\s*/, "");
}

async function writeGuidedMarkdown(url, result, guide) {
  await fs.mkdir(outDir, { recursive: true });
  const parsed = new URL(url);
  const title = result.title || result.markdown.match(/^#\s+(.+)$/m)?.[1] || parsed.hostname;
  const filename = `${slugFromTitle(title, parsed.hostname)}.md`;
  const target = path.join(outDir, filename);
  const now = new Date().toISOString();
  const outline = await ensureMarkdownOutline({
    markdown: result.markdown,
    title,
    url,
    method: result.method
  });
  const body = [
    "---",
    `source_url: ${yamlString(url)}`,
    `source_title: ${yamlString(title)}`,
    `imported_at: ${yamlString(now)}`,
    `import_method: ${yamlString(`${result.method}+deepseek_reading_guide`)}`,
    `outline_method: ${yamlString(outline.method)}`,
    importInstruction.trim() ? `import_instruction: ${yamlString(importInstruction.trim())}` : null,
    "status: imported",
    "reading_guide: true",
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
    "## 原文",
    "",
    outline.markdown.trim(),
    ""
  ].join("\n");
  await fs.writeFile(target, body, "utf8");
  return target;
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

  let guide = "";
  try {
    const config = await loadProducerConfig();
    guide = await callDeepSeekForGuide(config, {
      title: converted.title,
      url,
      author: converted.author,
      publishedAt: converted.publishedAt,
      markdown: converted.markdown,
      instruction: importInstruction
    });
  } catch (error) {
    const target = await writeGuidedFailure(url, "guide", error.message, `Raw Markdown: ${resolvedRawMarkdownPath}`);
    return { url, status: "failed", stage: "guide", reason: error.message, target, raw: resolvedRawMarkdownPath };
  }

  const guidePath = path.join(stagingDir, `${slug}.guide.md`);
  await fs.writeFile(guidePath, `${guide.trim()}\n`, "utf8");
  const target = await writeGuidedMarkdown(url, converted, guide);
  const metaPath = path.join(stagingDir, `${slug}.meta.json`);
  await fs.writeFile(metaPath, `${JSON.stringify({
    url,
    title: converted.title,
    method: converted.method,
    output: target,
    rawMarkdown: resolvedRawMarkdownPath,
    guide: guidePath,
    cachedRaw,
    instruction: importInstruction.trim() || undefined,
    importedAt: new Date().toISOString()
  }, null, 2)}\n`, "utf8");
  return { url, status: "imported", method: cachedRaw ? "guided_wechat_cached_raw" : "guided_wechat", target, raw: resolvedRawMarkdownPath, guide: guidePath };
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

for (const url of urls) {
  try {
    if (guidedWechat) {
      summary.push(await importGuidedWechatUrl(url));
      continue;
    }

    const sourceMarkdown = await trySourceMarkdown(url);
    if (sourceMarkdown) {
      const target = await writeMarkdown(url, sourceMarkdown);
      summary.push({ url, status: "imported", method: sourceMarkdown.method, target });
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
    const target = await writeMarkdown(url, converted);
    summary.push({ url, status: "imported", method: converted.method, target });
  } catch (error) {
    const target = await writeFailure(url, error.message);
    summary.push({ url, status: "failed", reason: error.message, target });
  }
}

console.log(JSON.stringify(summary, null, 2));
