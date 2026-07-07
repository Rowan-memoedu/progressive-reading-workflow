import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const workspaceRoot = path.resolve(__dirname, "../../..");
const targetDir = path.join(workspaceRoot, "03 Outputs", "Web Markdown Import Experiments", "youtube", "wsNzAuYDgy0");
const infoPath = path.join(targetDir, "wsNzAuYDgy0.info.json");
const enVttPath = path.join(targetDir, "wsNzAuYDgy0.en.vtt");
const zhPath = path.join(targetDir, "wsNzAuYDgy0.zh-CN.machine-translated.txt");
const outPath = path.join(targetDir, "Jordan Petersons Ultimate Advice for Students and College Grads - STOP WASTING TIME.bilingual.md");

function decodeEntities(text) {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'");
}

function parseVtt(vtt) {
  const segments = [];
  let currentTime = "";
  let currentLines = [];

  function flush() {
    if (!currentTime || currentLines.length === 0) return;
    const text = decodeEntities(currentLines.join(" ").replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim());
    if (text && segments.at(-1)?.text !== text) segments.push({ time: currentTime, text });
    currentTime = "";
    currentLines = [];
  }

  for (const raw of vtt.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line === "WEBVTT" || line.startsWith("Kind:") || line.startsWith("Language:")) {
      flush();
      continue;
    }
    if (/^\d+$/.test(line)) continue;
    if (line.includes("-->")) {
      flush();
      currentTime = line.split("-->")[0].trim().replace(/\.\d+$/, "");
      continue;
    }
    currentLines.push(line);
  }
  flush();
  return segments;
}

function durationString(info) {
  if (info.duration_string) return info.duration_string;
  if (!info.duration) return "";
  return `${Math.floor(info.duration / 60)}:${String(info.duration % 60).padStart(2, "0")}`;
}

const info = JSON.parse(await fs.readFile(infoPath, "utf8"));
const segments = parseVtt(await fs.readFile(enVttPath, "utf8"));
const zhText = await fs.readFile(zhPath, "utf8");
function splitChineseText(text) {
  const explicit = text.split(/\n{2,}/).map(line => line.trim()).filter(Boolean);
  if (explicit.length > 3) return explicit;
  return text
    .replace(/\s+/g, " ")
    .split(/(?<=[。！？；])\s*/u)
    .map(line => line.trim())
    .filter(Boolean);
}

const zhSegments = splitChineseText(zhText);
const duration = durationString(info);

const frontmatter = [
  "---",
  `source_url: ${JSON.stringify(info.webpage_url || "https://www.youtube.com/watch?v=wsNzAuYDgy0")}`,
  `source_title: ${JSON.stringify(info.title || "")}`,
  'source_platform: "YouTube"',
  `video_id: ${JSON.stringify(info.id || "wsNzAuYDgy0")}`,
  `channel: ${JSON.stringify(info.channel || info.uploader || "")}`,
  `duration: ${JSON.stringify(duration)}`,
  `imported_at: ${JSON.stringify(new Date().toISOString())}`,
  'import_method: "agent-reach/yt-dlp subtitles + DeepSeek translation"',
  'subtitle_language_source: "en"',
  'subtitle_language_translated: "zh-CN"',
  "status: imported",
  "---",
  ""
].join("\n");

const lines = [
  frontmatter,
  `# ${info.title || "YouTube transcript"}`,
  "",
  `- Source: ${info.webpage_url || "https://www.youtube.com/watch?v=wsNzAuYDgy0"}`,
  `- Channel: ${info.channel || info.uploader || ""}`,
  `- Duration: ${duration}`,
  "- Subtitle source: English",
  "- Chinese text: machine translated from English subtitles",
  "",
  "## 中文翻译",
  "",
  zhSegments.join("\n\n"),
  "",
  "## English Transcript",
  "",
  segments.map(segment => `### ${segment.time}\n\n${segment.text}`).join("\n\n")
];

await fs.writeFile(outPath, `${lines.join("\n")}\n`, "utf8");
console.log(JSON.stringify({
  outPath,
  englishSegments: segments.length,
  chineseParagraphs: zhSegments.length,
  englishChars: segments.map(segment => segment.text).join("\n\n").length,
  chineseChars: zhSegments.join("\n\n").length
}, null, 2));
