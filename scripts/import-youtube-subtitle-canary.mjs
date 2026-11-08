import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const producerConfigDir = path.join(process.env.USERPROFILE || process.env.HOME || "", "Documents", "New project");
const producerConfigKeys = ["AI_PRODUCER_BASE_URL", "DEEPSEEK_READING_API_KEY", "AI_PRODUCER_MODEL"];
const standardMarkdownProcessingRoute = {
  mode: "local_compatibility_fallback",
  future_interface_module: "standard-preprocessing/index.mjs",
  replacement_status: "pending_versioned_contract_and_synthetic_fixture",
};

function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key.startsWith("--")) continue;
    if (key === "--allow-batch") {
      values["allow-batch"] = true;
      continue;
    }
    if (!argv[index + 1]) continue;
    values[key.slice(2)] = argv[index + 1];
    index += 1;
  }
  return values;
}

function decodeEntities(text) {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ");
}

export function parseVtt(vtt) {
  const segments = [];
  let start = "";
  let lines = [];

  function flush() {
    if (!start || lines.length === 0) {
      lines = [];
      return;
    }
    const text = decodeEntities(lines.join(" ").replace(/<[^>]+>/g, ""))
      .replace(/\s+/g, " ")
      .trim();
    if (text && segments.at(-1)?.text !== text) segments.push({ start, text });
    start = "";
    lines = [];
  }

  for (const rawLine of String(vtt || "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line === "WEBVTT" || line.startsWith("Kind:") || line.startsWith("Language:")) {
      flush();
      continue;
    }
    if (/^\d+$/.test(line)) continue;
    if (line.includes("-->")) {
      flush();
      start = line.split("-->")[0].trim().replace(/\.\d+$/, "");
      continue;
    }
    lines.push(line);
  }
  flush();
  return segments;
}

function joinCaptionText(left, right) {
  if (!left) return right;
  const needsSpace = /[A-Za-z0-9]$/.test(left) && /^[A-Za-z0-9]/.test(right);
  return `${left}${needsSpace ? " " : ""}${right}`;
}

export function groupTranscriptSegments(segments, { minChars = 80, maxChars = 180 } = {}) {
  const paragraphs = [];
  let current = null;
  function flush() {
    if (current?.text) paragraphs.push(current);
    current = null;
  }
  for (const segment of segments) {
    if (!current) current = { start: segment.start, text: segment.text };
    else current.text = joinCaptionText(current.text, segment.text);
    if (current.text.length >= maxChars || (current.text.length >= minChars && /[。！？!?]$/.test(current.text))) flush();
  }
  flush();
  return paragraphs;
}

export function youtubeVideoId(rawUrl) {
  const url = new URL(rawUrl);
  let id = "";
  if (url.hostname === "youtu.be") id = url.pathname.slice(1).split("/")[0];
  else if (/(^|\.)youtube\.com$/i.test(url.hostname)) id = url.searchParams.get("v") || "";
  if (!/^[A-Za-z0-9_-]{11}$/.test(id)) throw new Error(`unsupported_youtube_url:${rawUrl}`);
  return id;
}

export function uniqueYoutubeInputs(tabs) {
  const byId = new Map();
  for (const tab of tabs) {
    const id = youtubeVideoId(tab.url);
    const current = byId.get(id) || { id, title: tab.title || "", urls: [] };
    current.urls.push(tab.url);
    if (!current.title && tab.title) current.title = tab.title;
    byId.set(id, current);
  }
  return [...byId.values()];
}

export function enforceCanaryScope(inputs, { allowBatch = false } = {}) {
  if (!allowBatch && inputs.length > 1) {
    throw new Error(`canary_requires_single_source:received_${inputs.length}`);
  }
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function yamlString(value) {
  return JSON.stringify(String(value ?? ""));
}

function safeFileName(value) {
  return String(value || "video")
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 110) || "video";
}

function durationString(seconds) {
  const value = Number(seconds || 0);
  const hours = Math.floor(value / 3600);
  const minutes = Math.floor((value % 3600) / 60);
  const rest = Math.floor(value % 60);
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(rest).padStart(2, "0")}`
    : `${minutes}:${String(rest).padStart(2, "0")}`;
}

function readWindowsUserEnv(key) {
  if (process.platform !== "win32") return "";
  try {
    return execFileSync("powershell.exe", [
      "-NoProfile",
      "-Command",
      `[Environment]::GetEnvironmentVariable('${key}', 'User')`,
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
      if (match) config[match[1]] = match[2].replace(/^['"]|['"]$/g, "");
    }
    return config;
  } catch {
    return {};
  }
}

async function loadProducerConfig() {
  const config = {};
  for (const key of producerConfigKeys) config[key] = process.env[key] || readWindowsUserEnv(key) || "";
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
  return /\/chat\/completions$/i.test(trimmed) ? trimmed : `${trimmed}/chat/completions`;
}

function stripModelFences(text) {
  return String(text || "")
    .trim()
    .replace(/^```(?:markdown|md)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
}

function transcriptForEditor(paragraphs) {
  return paragraphs.map((paragraph) => `[${paragraph.start}] ${paragraph.text}`).join("\n\n");
}

export function validateStructuredReadingBody(markdown) {
  const required = [
    "<!-- reading-guide:start -->",
    "## 阅读前置卡",
    "### 一句话核心",
    "### 核心洞见",
    "### 对我的价值判断",
    "### 信息密度判断",
    "### 能解决我的什么痛点",
    "### 具体用处",
    "### 是否急需阅读",
    "<!-- reading-guide:end -->",
    "## 结构化正文",
  ];
  const missing = required.filter((heading) => !markdown.includes(heading));
  if (missing.length) throw new Error(`structured_body_missing_sections:${missing.join("|")}`);
  if ((markdown.match(/^###\s+/gm) || []).length < 11) throw new Error("structured_body_outline_too_shallow");
  const body = markdown.split("## 结构化正文")[1] || "";
  if (/(?:\[|\(|（)?\d{1,2}:\d{2}(?::\d{2})?(?:\s*[—–-]\s*\d{1,2}:\d{2}(?::\d{2})?)?(?:\]|\)|）)?/.test(markdown)) {
    throw new Error("structured_body_contains_timestamps");
  }
  if (/作者(?:认为|指出|强调|判断|提出|主张|表示|解释|总结|建议)/.test(body)) {
    throw new Error("structured_body_shifted_to_third_person");
  }
  if (body.replace(/\s+/g, "").length < 2600) throw new Error("structured_body_too_short");
  const fillerCount = (body.match(/(?:嗯|呃|就是说|这个这个|然后然后)/g) || []).length;
  if (fillerCount > 4) throw new Error(`structured_body_too_oral:filler_count_${fillerCount}`);
}

async function generateStructuredReadingBody({ info, paragraphs, instruction = "", readerContext = "" }) {
  const config = await loadProducerConfig();
  const source = transcriptForEditor(paragraphs);
  const prompt = [
    "请把下面的中文视频字幕编辑成可直接进入 Obsidian 渐进阅读区的结构化书面文本。",
    "这是来源忠实的编辑任务，不是扩写、事实核查或观点背书。",
    "",
    "输出必须是完整 Markdown 正文片段，严格按以下顺序：",
    "<!-- reading-guide:start -->",
    "## 阅读前置卡",
    "### 一句话核心",
    "### 核心洞见",
    "### 对我的价值判断",
    "### 信息密度判断",
    "### 能解决我的什么痛点",
    "### 具体用处",
    "### 是否急需阅读",
    "<!-- reading-guide:end -->",
    "---",
    "## 结构化正文",
    "### 4-8 个具体内容标题",
    "",
    "阅读前置卡要求：",
    "- 一句话核心只写一句话。",
    "- 核心洞见列 3-6 条，压缩视频中的关键主张、条件和判断。",
    "- 对我的价值判断必须给 高 / 中 / 低 / 跳过 之一，并用 1-3 句话说明。",
    "- 信息密度判断必须给 高 / 中 / 低 之一，并说明依据。",
    "- 必须区分“论点很多”和“证据密度高”；如果主要是个人判断、重复强调、缺少来源与案例，不能因为覆盖话题多就判为高密度。",
    "- 痛点与具体用处各列 2-5 条，不绑定 RemNote、Logseq 或其他知识库平台。",
    "- 是否急需阅读必须给 急需 / 近期 / 可延后 / 可跳过 之一，并给一句理由。",
    "- 它是读前价值判断卡，不写阅读路径、不写传统摘要、不补充外部事实。",
    "",
    "结构化正文要求：",
    "- 把口语转成自然、连贯、克制的中文书面表达；删除口头禅、重复、停顿、无意义承接词和字幕切分痕迹。",
    "- 不按每个时间戳分段；按论证结构组织 3-8 个三级标题，每节可合并多个相邻时间段。",
    "- 保留原视频的主要论点、重要条件、例外、比较对象和结论，不得偷换立场或新增事实。",
    "- 正文不是转述稿。必须保持原说话者的第一人称视角、原有判断力度和表达风格，不得改成“作者认为、作者指出、作者判断”等第三人称叙述。",
    "- 只做忠实清理：修复断句、删除无意义口头禅与机械重复、合并碎片、划分段落并补充内容型标题；不要中和、点评、概括或重写原意。",
    "- 强烈评价、概括性断言和攻击性措辞仍保留为原说话者的表达；文件中的来源说明会统一声明正文未做事实核查，不需要逐段改写成第三人称归因。",
    "- 阅读前置卡是独立的编辑层，可以判断材料价值与证据密度，但不要把其中的概括替代到正文中。",
    "- 可以纠正明显的字幕断句和同音错字；不确定的人名、机构、术语不要擅自补全。",
    "- 正文长度不少于 2600 个非空白字符，避免过度压缩。",
    "- 最终 Markdown 中完全不出现时间戳，包括标题、段落、括号、列表和来源说明。时间只属于原始字幕审计层。",
    "- 不输出 YAML、一级标题、来源列表、代码块或额外说明。",
    "",
    `视频标题：${info.title || ""}`,
    `频道：${info.channel || info.uploader || ""}`,
    `时长：${info.duration_string || durationString(info.duration)}`,
    `用户本次要求：${instruction || "无"}`,
    `读者背景：${readerContext || "仅结合用户本次要求判断相关性，不得捏造个人背景。"}`,
    "",
    "带时间戳的字幕：",
    source,
  ].join("\n");

  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(chatCompletionsUrl(config.AI_PRODUCER_BASE_URL), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${config.DEEPSEEK_READING_API_KEY}`,
        },
        body: JSON.stringify({
          model: config.AI_PRODUCER_MODEL,
          temperature: 0.15,
          messages: [
            {
              role: "system",
              content: "你是渐进阅读的中文编辑。你的职责是把视频字幕忠实整理为结构化书面文本，并生成严格格式的阅读前置卡。",
            },
            { role: "user", content: prompt },
          ],
        }),
        signal: AbortSignal.timeout(180000),
      });
      if (!response.ok) throw new Error(`api_${response.status}_${(await response.text()).slice(0, 500)}`);
      const data = await response.json();
      const markdown = stripModelFences(data?.choices?.[0]?.message?.content || "");
      validateStructuredReadingBody(markdown);
      return { markdown, method: "deepseek_source_voice_structuring_v2", attempts: attempt };
    } catch (error) {
      lastError = error;
      if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, attempt * 2000));
    }
  }
  throw lastError;
}

async function processStandardMarkdown(input) {
  // Future replacement point: call the independent standard-Markdown preprocessing
  // interface here after it publishes a versioned contract and synthetic fixture.
  // Until then, keep the already-validated local path so the active Canary is not blocked.
  return generateStructuredReadingBody(input);
}

function renderStructuredReadingMarkdown({ info, structuredBody, canaryId, editorMethod }) {
  const canonicalUrl = `https://www.youtube.com/watch?v=${info.id}`;
  const bodyHeading = "## 结构化正文";
  const headingIndex = structuredBody.indexOf(bodyHeading);
  if (headingIndex < 0) throw new Error("structured_body_missing_body_heading");
  const readingGuide = structuredBody.slice(0, headingIndex).trim().replace(/\n---\s*$/, "").trim();
  const writtenBody = structuredBody.slice(headingIndex + bodyHeading.length).trim();
  return [
    "---",
    `source_url: ${yamlString(canonicalUrl)}`,
    'source_platform: "YouTube"',
    'source_type: "web_video"',
    `source_id: ${yamlString(info.id)}`,
    `source_title: ${yamlString(info.title || "")}`,
    `source_channel: ${yamlString(info.channel || info.uploader || "")}`,
    `source_duration_seconds: ${Number(info.duration || 0)}`,
    'subtitle_language: "zh-Hans"',
    'subtitle_kind: "manual"',
    'content_form: "source_voice_structured_text"',
    'reading_guide: true',
    `editor_method: ${yamlString(editorMethod)}`,
    `canary_id: ${yamlString(canaryId)}`,
    'status: "staged_needs_review"',
    "---",
    "",
    readingGuide,
    "",
    "---",
    "",
    `# ${info.title || info.id}`,
    "",
    `> 来源：[YouTube](${canonicalUrl}) · 频道：${info.channel || info.uploader || ""} · 字幕：人工上传 zh-Hans`,
    "",
    "> 文本形态：在保留原说话者视角、立场与表达风格的前提下，对字幕做断句、去冗余、分段和标题结构化；未做事实核查，不代表编者立场。当前为 Canary 待审核，尚未进入正式阅读区。",
    "",
    bodyHeading,
    "",
    writtenBody,
  ].join("\n").trimEnd() + "\n";
}

async function readJson(filePath) {
  return JSON.parse((await fs.readFile(filePath, "utf8")).replace(/^\uFEFF/, ""));
}

export async function runCanary({ requestPath, probeDir, outDir, allowBatch = false }) {
  const request = await readJson(requestPath);
  if (request.schema !== "network-import-request/v1") throw new Error("unsupported_request_schema");
  if (request.source_type !== "browser_tab_group_video") throw new Error("unsupported_source_type");
  const tabs = request.input?.tabs;
  if (!Array.isArray(tabs) || tabs.length === 0) throw new Error("missing_input_tabs");

  const inputs = uniqueYoutubeInputs(tabs);
  enforceCanaryScope(inputs, { allowBatch });
  const canaryId = request.material?.canary_id || "browser-tab-group-video-canary";
  const startedAt = new Date().toISOString();
  const rawDir = path.join(outDir, "raw");
  const artifactDir = path.join(outDir, "artifacts");
  await fs.mkdir(rawDir, { recursive: true });
  await fs.mkdir(artifactDir, { recursive: true });

  const artifacts = [];
  const sourceMetadata = [];
  const errors = [];
  let ytDlpVersion = "";

  for (const input of inputs) {
    const infoPath = path.join(probeDir, `${input.id}.info.json`);
    let info;
    try {
      info = await readJson(infoPath);
      ytDlpVersion ||= info?._version?.version || "";
    } catch (error) {
      errors.push({ source_id: input.id, code: "metadata_missing", message: error.message });
      continue;
    }

    const metadata = {
      source_id: input.id,
      source_url: `https://www.youtube.com/watch?v=${input.id}`,
      source_title: info.title || input.title || "",
      source_channel: info.channel || info.uploader || "",
      duration_seconds: Number(info.duration || 0),
      upload_date: info.upload_date || "",
      original_occurrences: input.urls.length,
      original_urls: input.urls,
      subtitle_languages: Object.keys(info.subtitles || {}),
    };
    sourceMetadata.push(metadata);

    const hasManualZhHans = Object.prototype.hasOwnProperty.call(info.subtitles || {}, "zh-Hans");
    const vttPath = path.join(probeDir, `${input.id}.zh-Hans.vtt`);
    if (!hasManualZhHans) {
      errors.push({
        source_id: input.id,
        source_url: metadata.source_url,
        code: "no_acceptable_subtitle",
        message: "No manual zh-Hans subtitle; ASR fallback disabled by the canary quality gate.",
      });
      continue;
    }

    let vtt;
    try {
      vtt = await fs.readFile(vttPath, "utf8");
    } catch (error) {
      errors.push({ source_id: input.id, code: "subtitle_file_missing", message: error.message });
      continue;
    }
    const segments = parseVtt(vtt);
    const transcriptChars = segments.reduce((sum, segment) => sum + segment.text.length, 0);
    if (segments.length < 3 || transcriptChars < 200) {
      errors.push({
        source_id: input.id,
        code: "subtitle_quality_gate_failed",
        message: `segments=${segments.length}; transcript_chars=${transcriptChars}`,
      });
      continue;
    }

    const rawTarget = path.join(rawDir, `${input.id}.zh-Hans.vtt`);
    await fs.copyFile(vttPath, rawTarget);
    const paragraphs = groupTranscriptSegments(segments);
    let structured;
    try {
      structured = await processStandardMarkdown({
        info,
        paragraphs,
        instruction: request.user_instruction || "",
        readerContext: request.material?.reader_context || "",
      });
    } catch (error) {
      errors.push({ source_id: input.id, code: "structured_editor_failed", message: error.message });
      continue;
    }
    const markdown = renderStructuredReadingMarkdown({
      info,
      structuredBody: structured.markdown,
      canaryId,
      editorMethod: structured.method,
    });
    validateStructuredReadingBody(markdown);
    const artifactName = `${safeFileName(info.title || input.id)}--${input.id}.md`;
    const artifactPath = path.join(artifactDir, artifactName);
    await fs.writeFile(artifactPath, markdown, "utf8");
    artifacts.push({
      source_id: input.id,
      type: "staged_structured_reading_markdown",
      status: "needs_review",
      path: path.relative(outDir, artifactPath).replaceAll(path.sep, "/"),
      raw_subtitle_path: path.relative(outDir, rawTarget).replaceAll(path.sep, "/"),
      sha256: sha256(markdown),
      raw_segment_count: segments.length,
      normalized_transcript_paragraph_count: paragraphs.length,
      transcript_chars: transcriptChars,
      editor_method: structured.method,
      editor_attempts: structured.attempts,
    });
  }

  const finishedAt = new Date().toISOString();
  const receipt = {
    receipt_id: crypto.randomUUID(),
    canary_id: canaryId,
    started_at: startedAt,
    finished_at: finishedAt,
    browser_group: request.material?.browser_group || "",
    input_tab_count: tabs.length,
    unique_source_count: inputs.length,
    duplicate_tab_count: tabs.length - inputs.length,
    staged_artifact_count: artifacts.length,
    error_count: errors.length,
    quality_gate: "single_source_by_default; manual_zh-Hans_only; reading_guide_required; no_visible_timestamps; source_voice_preserved; structure_only_no_third_person_retelling; staging_needs_review; no_ASR_fallback",
    acquisition_tool: "yt-dlp",
    acquisition_tool_version: ytDlpVersion,
    standard_markdown_processing: standardMarkdownProcessingRoute,
    request_sha256: sha256(JSON.stringify(request)),
  };
  const result = {
    schema: "network-import-result/v1",
    status: errors.length === 0 ? "staged" : artifacts.length > 0 ? "partial" : "failed",
    artifacts,
    source_metadata: sourceMetadata,
    receipt,
    errors,
  };
  await fs.writeFile(path.join(outDir, "request.json"), `${JSON.stringify(request, null, 2)}\n`, "utf8");
  await fs.writeFile(path.join(outDir, "receipt.json"), `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
  await fs.writeFile(path.join(outDir, "result.json"), `${JSON.stringify(result, null, 2)}\n`, "utf8");
  return result;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const args = parseArgs(process.argv.slice(2));
  if (!args.request || !args["probe-dir"] || !args.out) {
    console.error("Usage: node scripts/import-youtube-subtitle-canary.mjs --request <request.json> --probe-dir <metadata-and-vtt-dir> --out <output-dir>");
    process.exitCode = 2;
  } else {
    const result = await runCanary({
      requestPath: path.resolve(args.request),
      probeDir: path.resolve(args["probe-dir"]),
      outDir: path.resolve(args.out),
      allowBatch: args["allow-batch"] === true,
    });
    console.log(JSON.stringify({
      status: result.status,
      artifacts: result.artifacts.length,
      sources: result.source_metadata.length,
      errors: result.errors.length,
      receipt_id: result.receipt.receipt_id,
    }, null, 2));
  }
}
