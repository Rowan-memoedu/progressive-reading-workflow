import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const [manifestPath, outputRoot, receiptPath] = process.argv.slice(2);
if (!manifestPath || !outputRoot || !receiptPath) {
  console.error("Usage: node validate-zhihu-like-import.mjs <manifest.ndjson> <output-root> <receipt.json>");
  process.exit(1);
}

const manifest = (await fs.readFile(manifestPath, "utf8"))
  .trim()
  .split(/\r?\n/)
  .filter(Boolean)
  .map((line) => JSON.parse(line));

const outputEntries = await fs.readdir(outputRoot, { withFileTypes: true }).catch(() => []);
const outputFiles = outputEntries
  .filter((entry) => entry.isFile() && entry.name.endsWith(".md") && !entry.name.startsWith("FAILED "))
  .map((entry) => path.join(outputRoot, entry.name));
const outputByUrl = new Map();
for (const outputPath of outputFiles) {
  const text = await fs.readFile(outputPath, "utf8");
  const sourceUrl = frontmatterValue(text, "source_url");
  const matches = outputByUrl.get(sourceUrl) || [];
  matches.push({ outputPath, text });
  outputByUrl.set(sourceUrl, matches);
}

const results = [];
for (const item of manifest) {
  const matches = outputByUrl.get(item.url) || [];
  const errors = [];
  if (matches.length !== 1) errors.push(`expected_one_markdown_found_${matches.length}`);

  const outputPath = matches[0]?.outputPath || "";
  const text = matches[0]?.text || "";
  const sourceUrl = frontmatterValue(text, "source_url");
  const status = frontmatterValue(text, "status");
  const importMethod = frontmatterValue(text, "import_method");
  const outlineMethod = frontmatterValue(text, "outline_method");
  const readingGuideMethod = frontmatterValue(text, "reading_guide_method");
  if (sourceUrl !== item.url) errors.push("source_url_mismatch");
  if (status !== "imported") errors.push(`status_${status || "missing"}`);
  if (importMethod !== "browser_authenticated_dom") errors.push(`import_method_${importMethod || "missing"}`);
  if (!text.includes("## 阅读前置卡")) errors.push("reading_guide_missing");
  if (!text.includes("## 原文")) errors.push("original_section_missing");
  if (/登录后查看更多|扫码登录|注册\/登录/.test(text)) errors.push("login_shell_detected");
  if (text.replace(/\s+/g, "").length < 100) errors.push("markdown_too_short");

  results.push({
    index: item.index,
    date: item.date,
    title: item.title,
    url: item.url,
    status: errors.length ? "failed_verification" : "verified",
    errors,
    outputPath,
    bytes: outputPath ? Buffer.byteLength(text, "utf8") : 0,
    sha256: outputPath ? crypto.createHash("sha256").update(text).digest("hex") : "",
    importMethod,
    outlineMethod,
    readingGuideMethod
  });
}

const receipt = {
  schemaVersion: 1,
  verifiedAt: new Date().toISOString(),
  manifestPath: path.resolve(manifestPath),
  outputRoot: path.resolve(outputRoot),
  total: results.length,
  verified: results.filter((item) => item.status === "verified").length,
  failed: results.filter((item) => item.status !== "verified").length,
  outputFiles: outputFiles.length,
  nestedDirectories: outputEntries.filter((entry) => entry.isDirectory()).length,
  deepseekGuides: results.filter((item) => item.readingGuideMethod === "deepseek_reading_guide").length,
  deepseekOutlines: results.filter((item) => item.outlineMethod === "deepseek_outline").length,
  items: results
};

await fs.mkdir(path.dirname(path.resolve(receiptPath)), { recursive: true });
await fs.writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
console.log(JSON.stringify({
  total: receipt.total,
  verified: receipt.verified,
  failed: receipt.failed,
  deepseekGuides: receipt.deepseekGuides,
  deepseekOutlines: receipt.deepseekOutlines,
  receiptPath: path.resolve(receiptPath)
}, null, 2));
if (receipt.failed) process.exit(1);

function frontmatterValue(markdown, key) {
  const match = new RegExp(`^${escapeRegExp(key)}:\\s*(.+)$`, "m").exec(markdown);
  if (!match) return "";
  const raw = match[1].trim();
  if (raw.startsWith('"') && raw.endsWith('"')) {
    try {
      return JSON.parse(raw);
    } catch {
      return raw.slice(1, -1);
    }
  }
  return raw;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
