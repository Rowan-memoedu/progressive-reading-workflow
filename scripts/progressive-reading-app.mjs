import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import http from "node:http";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const workflowRoot = path.resolve(__dirname, "..");
const importScript = path.join(__dirname, "import-web-md.mjs");
const rssScript = path.join(__dirname, "rss-workflow.mjs");
const localTranscribeScript = path.join(__dirname, "local-whispercpp-transcribe.py");
const readingRoot = path.join(workflowRoot, "阅读区");
const importsRoot = path.join(workflowRoot, "imports");
const appRunsRoot = path.join(importsRoot, "app-runs");
const defaultPort = Number(process.env.PROGRESSIVE_READING_APP_PORT || 37829);
const producerConfigDir = path.join(process.env.USERPROFILE || process.env.HOME || "", "Documents", "New project");
const producerConfigKeys = ["AI_PRODUCER_BASE_URL", "AI_PRODUCER_API_KEY", "AI_PRODUCER_MODEL"];
const jobs = new Map();

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
    .replace(/^```(?:markdown|md)?\s*/i, "")
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
  if (job.instruction) args.push("--instruction", job.instruction);
  const result = await runProcess(process.execPath, args);
  await fs.writeFile(path.join(stagingDir, "command.stdout.txt"), result.stdout, "utf8").catch(() => {});
  await fs.writeFile(path.join(stagingDir, "command.stderr.txt"), result.stderr, "utf8").catch(() => {});
  const summary = parseSummary(result.stdout) || [];
  for (const item of summary) {
    if (item.status === "imported") job.outputs.push(item);
    else job.failures.push(item);
  }
  if (result.code !== 0 && summary.length === 0) {
    job.failures.push({ status: "failed", stage: "command", reason: result.stderr || `exit_${result.code}` });
  }
  await log(job, `微信导入完成：成功 ${summary.filter((item) => item.status === "imported").length}，失败 ${summary.filter((item) => item.status !== "imported").length}`);
}

async function importWeb(job, urls, runName) {
  const outDir = path.join(readingRoot, "网页", runName);
  const failureDir = path.join(job.runDir, "web-failures");
  await log(job, `普通网页导入开始：${urls.length} 个链接`);
  const result = await runProcess(process.execPath, [importScript, ...urls, "--out", outDir]);
  await fs.mkdir(path.join(job.runDir, "web"), { recursive: true });
  await fs.writeFile(path.join(job.runDir, "web", "command.stdout.txt"), result.stdout, "utf8");
  await fs.writeFile(path.join(job.runDir, "web", "command.stderr.txt"), result.stderr, "utf8");
  const summary = parseSummary(result.stdout) || [];
  await moveWebFailures(summary, failureDir);
  for (const item of summary) {
    if (item.status === "imported") job.outputs.push(item);
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
  await log(job, `普通网页导入完成：成功 ${summary.filter((item) => item.status === "imported").length}，失败 ${summary.filter((item) => item.status !== "imported").length}`);
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
      instruction: job.instruction
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
      instruction: job.instruction
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

function readRequest(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk.toString();
      if (body.length > 1024 * 1024) {
        reject(new Error("request_too_large"));
        req.destroy();
      }
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function sendJson(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data, null, 2));
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
    main { max-width: 1120px; margin: 0 auto; padding: 24px; }
    h1 { font-size: 24px; line-height: 1.2; margin: 0 0 16px; font-weight: 650; }
    .layout { display: grid; grid-template-columns: minmax(0, 1.1fr) minmax(320px, .9fr); gap: 16px; align-items: start; }
    section { background: #fff; border: 1px solid #d9dee7; border-radius: 8px; padding: 16px; }
    label { display: block; font-size: 13px; font-weight: 650; margin-bottom: 8px; color: #384253; }
    textarea, input, select { width: 100%; box-sizing: border-box; border: 1px solid #c9d0dc; border-radius: 6px; padding: 10px 12px; font: 14px/1.55 ui-monospace, SFMono-Regular, Consolas, monospace; }
    textarea { min-height: 320px; resize: vertical; }
    button { margin-top: 12px; min-height: 36px; border: 1px solid #1f5fbf; background: #1f5fbf; color: #fff; border-radius: 6px; padding: 0 14px; font-size: 14px; cursor: pointer; }
    button.secondary { border-color: #c9d0dc; background: #fff; color: #1d2430; }
    button:disabled { opacity: .55; cursor: wait; }
    .row { display: grid; grid-template-columns: 140px minmax(0, 1fr); gap: 10px; align-items: end; margin-top: 10px; }
    .actions { display: flex; flex-wrap: wrap; gap: 8px; }
    .status { font-size: 14px; line-height: 1.6; }
    .paths { display: grid; gap: 8px; margin-top: 12px; }
    .item { border-top: 1px solid #eef1f5; padding-top: 8px; overflow-wrap: anywhere; }
    .ok { color: #116329; }
    .fail { color: #9b1c1c; }
    .muted { color: #667085; font-size: 13px; }
    pre { background: #101828; color: #e5e7eb; border-radius: 6px; padding: 12px; overflow: auto; min-height: 160px; max-height: 380px; font-size: 12px; line-height: 1.5; }
    @media (max-width: 820px) { .layout { grid-template-columns: 1fr; } main { padding: 16px; } }
  </style>
</head>
<body>
  <main>
    <h1>渐进阅读导入</h1>
    <div class="layout">
      <section>
        <label for="input">链接和要求</label>
        <textarea id="input" placeholder="粘贴一个或多个链接，也可以写自然语言要求。"></textarea>
        <button id="run">导入</button>
      </section>
      <section>
        <label>RSS</label>
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
      <section>
        <div class="status" id="status">空闲</div>
        <div class="paths" id="paths"></div>
        <pre id="logs"></pre>
      </section>
    </div>
  </main>
  <script>
    const run = document.getElementById('run');
    const input = document.getElementById('input');
    const statusEl = document.getElementById('status');
    const pathsEl = document.getElementById('paths');
    const logsEl = document.getElementById('logs');
    const rssOutput = document.getElementById('rssOutput');
    const rssSourceList = document.getElementById('rssSourceList');
    const rssButtons = ['rssHealth', 'rssSources', 'rssSourceSetup', 'rssSourceSync', 'rssSync', 'rssPromote', 'rssAdd'].map(id => document.getElementById(id));
    let timer = null;

    function render(job) {
      statusEl.textContent = '状态：' + job.status + '｜链接：' + job.urls.length + '｜运行目录：' + (job.runDir || '');
      logsEl.textContent = (job.logs || []).map(x => '[' + x.at + '] ' + x.message).join('\\n');
      const rows = [];
      for (const item of job.outputs || []) rows.push('<div class="item ok">成功：' + escapeHtml(item.target || item.url || '') + '</div>');
      for (const item of job.failures || []) rows.push('<div class="item fail">失败：' + escapeHtml((item.reason || '') + ' ' + (item.target || item.url || '')) + '</div>');
      pathsEl.innerHTML = rows.join('');
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

    run.addEventListener('click', async () => {
      run.disabled = true;
      statusEl.textContent = '提交中';
      pathsEl.innerHTML = '';
      logsEl.textContent = '';
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
    rssCall('/api/rss/sources');
  </script>
</body>
</html>`;
}

async function handle(req, res) {
  const url = new URL(req.url || "/", "http://127.0.0.1");
  if (req.method === "GET" && url.pathname === "/") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(html());
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
    server.once("error", async (error) => {
      if (error.code === "EADDRINUSE" && port < defaultPort + 20) {
        try {
          resolve(await listen(port + 1));
        } catch (inner) {
          reject(inner);
        }
      } else {
        reject(error);
      }
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
