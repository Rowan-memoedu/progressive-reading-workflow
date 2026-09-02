import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const [inventoryPath, outputRoot, receiptPath] = process.argv.slice(2);
if (!inventoryPath || !outputRoot || !receiptPath) {
  console.error("Usage: node validate-zhihu-column-import.mjs <inventory.json> <output-root> <receipt.json>");
  process.exit(1);
}

const inventory = JSON.parse(await fs.readFile(inventoryPath, "utf8"));
const expectedItems = Array.isArray(inventory?.items) ? inventory.items : [];
if (inventory?.layout !== "column_folders" || expectedItems.length === 0) {
  throw new Error("invalid_zhihu_column_inventory");
}

const expectedUrls = new Set(expectedItems.map((item) => item.url));
if (expectedUrls.size !== expectedItems.length) {
  throw new Error("inventory_contains_duplicate_source_urls");
}

const expectedColumnNames = new Set(
  expectedItems.flatMap((item) => item.sourceColumns || [item.columnName]).filter(Boolean)
);
const markdownFiles = await listMarkdownFiles(outputRoot);
const byUrl = new Map();
for (const file of markdownFiles) {
  const text = await fs.readFile(file, "utf8");
  const url = frontmatterValue(text, "source_url");
  if (!url) continue;
  const matches = byUrl.get(url) || [];
  matches.push({ file, text });
  byUrl.set(url, matches);
}

const results = [];
for (const item of expectedItems) {
  const matches = byUrl.get(item.url) || [];
  const errors = [];
  if (matches.length !== 1) errors.push(`expected_one_markdown_found_${matches.length}`);
  const file = matches[0]?.file || "";
  const text = matches[0]?.text || "";
  const sourceColumns = frontmatterJsonArray(text, "source_columns");
  const sourceColumnUrls = frontmatterJsonArray(text, "source_column_urls");
  const expectedSourceColumns = item.sourceColumns || [item.columnName];
  const expectedSourceColumnUrls = item.sourceColumnUrls || [item.columnUrl];
  const physicalColumn = file ? path.basename(path.dirname(file)) : "";

  if (frontmatterValue(text, "source_column") !== item.columnName) errors.push("source_column_mismatch");
  if (frontmatterValue(text, "source_column_url") !== item.columnUrl) errors.push("source_column_url_mismatch");
  if (JSON.stringify(sourceColumns) !== JSON.stringify(expectedSourceColumns)) errors.push("source_columns_mismatch");
  if (JSON.stringify(sourceColumnUrls) !== JSON.stringify(expectedSourceColumnUrls)) errors.push("source_column_urls_mismatch");
  if (physicalColumn !== item.columnName) errors.push("physical_column_mismatch");
  if (frontmatterValue(text, "import_method") !== "browser_authenticated_dom") errors.push("import_method_mismatch");
  if (frontmatterValue(text, "status") !== "imported") errors.push("status_mismatch");
  if (!text.includes("## 阅读前置卡")) errors.push("reading_guide_missing");
  if (!text.includes("## 原文")) errors.push("original_section_missing");
  if (/登录后查看更多|扫码登录|注册\/登录/.test(text)) errors.push("login_shell_detected");
  if (text.replace(/\s+/g, "").length < 100) errors.push("markdown_too_short");

  results.push({
    columnName: item.columnName,
    sourceColumns: expectedSourceColumns,
    title: item.title,
    url: item.url,
    status: errors.length ? "failed_verification" : "verified",
    errors,
    file,
    bytes: file ? Buffer.byteLength(text, "utf8") : 0,
    sha256: file ? crypto.createHash("sha256").update(text).digest("hex") : ""
  });
}

const duplicateUrls = [...byUrl]
  .filter(([, matches]) => matches.length > 1)
  .map(([url, matches]) => ({ url, files: matches.map((match) => match.file) }));
const unexpectedColumnFiles = markdownFiles.filter((file) => {
  const relative = path.relative(outputRoot, file);
  const firstSegment = relative.split(path.sep)[0];
  return relative.includes(path.sep) && !expectedColumnNames.has(firstSegment);
});
const membershipCount = expectedItems.reduce(
  (total, item) => total + (item.sourceColumns || [item.columnName]).length,
  0
);
const expectedPrimaryCounts = Object.fromEntries(
  [...new Set(expectedItems.map((item) => item.columnName))]
    .map((name) => [name, expectedItems.filter((item) => item.columnName === name).length])
);

const receipt = {
  schemaVersion: 2,
  verifiedAt: new Date().toISOString(),
  inventoryPath: path.resolve(inventoryPath),
  outputRoot: path.resolve(outputRoot),
  expectedColumns: expectedColumnNames.size,
  expectedFiles: expectedItems.length,
  expectedMemberships: membershipCount,
  verified: results.filter((item) => item.status === "verified").length,
  failed: results.filter((item) => item.status !== "verified").length,
  duplicateSourceUrls: duplicateUrls,
  unexpectedColumnFiles,
  primaryCounts: expectedPrimaryCounts,
  items: results
};

if (receipt.expectedColumns !== 8) receipt.failed += 1;
if (receipt.expectedFiles !== 41) receipt.failed += 1;
if (receipt.expectedMemberships !== 44) receipt.failed += 1;
if (duplicateUrls.length) receipt.failed += duplicateUrls.length;
if (unexpectedColumnFiles.length) receipt.failed += unexpectedColumnFiles.length;

await fs.mkdir(path.dirname(path.resolve(receiptPath)), { recursive: true });
await fs.writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
console.log(JSON.stringify({
  expectedColumns: receipt.expectedColumns,
  expectedFiles: receipt.expectedFiles,
  expectedMemberships: receipt.expectedMemberships,
  verified: receipt.verified,
  failed: receipt.failed,
  duplicateSourceUrls: receipt.duplicateSourceUrls.length,
  receiptPath: path.resolve(receiptPath)
}, null, 2));
if (receipt.failed) process.exit(1);

async function listMarkdownFiles(root) {
  const found = [];
  async function visit(directory) {
    const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(target);
      else if (entry.isFile() && entry.name.endsWith(".md")) found.push(target);
    }
  }
  await visit(root);
  return found;
}

function frontmatterJsonArray(markdown, key) {
  const value = frontmatterValue(markdown, key);
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

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
