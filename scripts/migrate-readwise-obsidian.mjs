import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sanitize from "sanitize-filename";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const workflowRoot = path.resolve(__dirname, "..");
const defaults = {
  rawDir: path.join(workflowRoot, "imports", "readwise-obsidian-raw"),
  migrationRoot: path.join(workflowRoot, "imports", "readwise-migration"),
  readingDir: path.join(workflowRoot, "阅读区", "Readwise 迁入")
};

const args = parseArgs(process.argv.slice(2));
const now = new Date();
const runDate = args.date || formatDate(now);
const importedAt = now.toISOString();
const rawDir = path.resolve(args.raw || defaults.rawDir);
const migrationDir = path.resolve(args.migration || path.join(defaults.migrationRoot, runDate));
const readingDir = path.resolve(args.reading || defaults.readingDir);

if (fileURLToPath(import.meta.url) === path.resolve(process.argv[1] || "")) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

async function main() {
  if (args.help) {
    printHelp();
    return;
  }

  const rawExists = await exists(rawDir);
  if (!rawExists) {
    if (!args.dryRun) await fs.mkdir(rawDir, { recursive: true });
    console.log(`Raw directory is empty or missing: ${rawDir}`);
  }

  const sourceFiles = rawExists ? await collectMarkdownFiles(rawDir) : [];
  const entries = await buildEntries(sourceFiles);
  const reports = buildReports(entries);
  const manifest = {
    generated_at: importedAt,
    import_method: "readwise_obsidian_export",
    raw_dir: rawDir,
    reading_dir: readingDir,
    migration_dir: migrationDir,
    dry_run: args.dryRun,
    manifest_only: args.manifestOnly,
    counts: buildCounts(entries, reports),
    entries,
    reports
  };

  if (!args.dryRun) {
    await fs.mkdir(migrationDir, { recursive: true });
    await writeJson(path.join(migrationDir, "manifest.json"), manifest);
    await fs.writeFile(path.join(migrationDir, "manifest.md"), renderManifestMarkdown(manifest), "utf8");
  }

  const finalManifest = !args.dryRun && !args.manifestOnly
    ? await copyEntries(entries)
    : manifest;

  printSummary(finalManifest);
}

async function buildEntries(sourceFiles) {
  const analyzed = [];
  for (const sourcePath of sourceFiles) {
    const content = await fs.readFile(sourcePath, "utf8");
    const parsed = parseMarkdown(content);
    const rel = normalizeSlash(path.relative(rawDir, sourcePath));
    const pathParts = rel.split("/");
    const title = extractTitle(parsed, sourcePath);
    const category = normalizeText(firstPresent(
      parsed.frontmatter.category,
      parsed.frontmatter.type,
      pathParts.length > 1 ? pathParts[0] : "Uncategorized"
    )) || "Uncategorized";
    const author = extractAuthor(parsed);
    const sourceUrl = extractSourceUrl(parsed);
    const tags = extractTags(parsed);
    const role = inferRole(parsed.body, sourcePath);
    const key = sourceUrl || normalizeKey(title);

    analyzed.push({
      title,
      author,
      source_url: sourceUrl,
      readwise_category: category,
      tags,
      has_fulltext: role === "fulltext" || role === "mixed",
      has_highlights: role === "highlights" || role === "mixed",
      role,
      source_file: sourcePath,
      source_file_relative: rel,
      target_reading_path: "",
      migration_status: args.dryRun ? "would_copy" : "pending",
      issues: [],
      group_key: key
    });
  }

  const groupMap = new Map();
  for (const entry of analyzed) {
    if (!groupMap.has(entry.group_key)) groupMap.set(entry.group_key, []);
    groupMap.get(entry.group_key).push(entry);
  }

  const usedTargets = new Set();
  for (const entry of analyzed) {
    const group = groupMap.get(entry.group_key) || [];
    const hasAnyFulltext = group.some((item) => item.has_fulltext);
    const hasAnyHighlights = group.some((item) => item.has_highlights);

    if (group.length > 1) entry.issues.push("duplicate_title_or_url");
    if (!entry.source_url) entry.issues.push("missing_url");
    if (entry.has_highlights && !hasAnyFulltext) entry.issues.push("highlight_only_no_fulltext");
    if (entry.has_fulltext && !hasAnyHighlights) entry.issues.push("fulltext_without_highlights");
    if (/^feed$/i.test(entry.readwise_category) || /(^|\/)feed(\/|$)/i.test(entry.source_file_relative)) {
      entry.issues.push("feed_missing_fulltext_check");
    }

    const target = buildTargetPath(entry, usedTargets);
    entry.target_reading_path = target;
    entry.target_reading_path_relative = normalizeSlash(path.relative(workflowRoot, target));

    if (!args.dryRun && !args.manifestOnly) {
      entry.migration_status = await exists(target) ? "exists_skipped" : "pending";
    }
  }

  return analyzed;
}

async function copyEntries(entries) {
  for (const entry of entries) {
    if (entry.migration_status === "exists_skipped") continue;
    const source = await fs.readFile(entry.source_file, "utf8");
    const parsed = parseMarkdown(source);
    const output = renderReadingMarkdown(entry, parsed.body);
    await fs.mkdir(path.dirname(entry.target_reading_path), { recursive: true });
    await fs.writeFile(entry.target_reading_path, output, "utf8");
    entry.migration_status = "copied";
  }
  const manifest = {
    generated_at: importedAt,
    import_method: "readwise_obsidian_export",
    raw_dir: rawDir,
    reading_dir: readingDir,
    migration_dir: migrationDir,
    dry_run: false,
    manifest_only: false,
    counts: buildCounts(entries, buildReports(entries)),
    entries,
    reports: buildReports(entries)
  };
  await writeJson(path.join(migrationDir, "manifest.json"), manifest);
  await fs.writeFile(path.join(migrationDir, "manifest.md"), renderManifestMarkdown(manifest), "utf8");
  return manifest;
}

function buildTargetPath(entry, usedTargets) {
  const category = sanitizePathSegment(entry.readwise_category);
  const baseName = sanitizePathSegment(entry.title);
  const roleSuffix = entry.role === "fulltext" ? " - fulltext" : entry.role === "highlights" ? " - highlights" : "";
  let candidate = path.join(readingDir, category, `${baseName}${roleSuffix}.md`);
  let index = 2;
  while (usedTargets.has(normalizeSlash(candidate).toLowerCase())) {
    candidate = path.join(readingDir, category, `${baseName}${roleSuffix} ${index}.md`);
    index += 1;
  }
  usedTargets.add(normalizeSlash(candidate).toLowerCase());
  return candidate;
}

function renderReadingMarkdown(entry, body) {
  const cleanBody = body.trimStart();
  const titleLine = cleanBody.match(/^#\s+/m) ? "" : `# ${entry.title}\n\n`;
  return [
    "---",
    `source_url: ${yamlScalar(entry.source_url)}`,
    `source_title: ${yamlScalar(entry.title)}`,
    `source_author: ${yamlScalar(entry.author)}`,
    `readwise_category: ${yamlScalar(entry.readwise_category)}`,
    "readwise_tags:",
    ...entry.tags.map((tag) => `  - ${yamlScalar(tag)}`),
    `readwise_source_file: ${yamlScalar(entry.source_file_relative)}`,
    `readwise_role: ${yamlScalar(entry.role)}`,
    `imported_at: ${yamlScalar(importedAt)}`,
    "import_method: readwise_obsidian_export",
    "status: imported_raw",
    "---",
    "",
    titleLine + cleanBody.trimEnd(),
    ""
  ].join("\n");
}

function renderManifestMarkdown(manifest) {
  const lines = [
    "# Readwise Obsidian Migration Manifest",
    "",
    `- Generated at: ${manifest.generated_at}`,
    `- Raw dir: ${manifest.raw_dir}`,
    `- Reading dir: ${manifest.reading_dir}`,
    `- Total markdown files: ${manifest.counts.total}`,
    `- Copied: ${manifest.counts.copied}`,
    `- Existing skipped: ${manifest.counts.exists_skipped}`,
    `- Missing URL: ${manifest.counts.missing_url}`,
    `- Duplicate title or URL: ${manifest.counts.duplicate_title_or_url}`,
    `- Highlight-only without fulltext: ${manifest.counts.highlight_only_no_fulltext}`,
    `- Fulltext without highlights: ${manifest.counts.fulltext_without_highlights}`,
    `- Feed fulltext check: ${manifest.counts.feed_missing_fulltext_check}`,
    "",
    "## Category Counts",
    ""
  ];

  for (const [category, count] of Object.entries(manifest.counts.by_category)) {
    lines.push(`- ${category}: ${count}`);
  }

  lines.push("", "## Samples", "");
  for (const entry of manifest.entries.slice(0, 10)) {
    lines.push(`- ${entry.title}`);
    lines.push(`  - Source: ${entry.source_file_relative}`);
    lines.push(`  - Target: ${entry.target_reading_path_relative}`);
    lines.push(`  - Role: ${entry.role}`);
    if (entry.issues.length) lines.push(`  - Issues: ${entry.issues.join(", ")}`);
  }

  lines.push("", "## Issue Lists", "");
  appendIssueList(lines, "Missing URL", manifest.reports.missing_url);
  appendIssueList(lines, "Duplicate title or URL", manifest.reports.duplicate_title_or_url);
  appendIssueList(lines, "Highlight-only without fulltext", manifest.reports.highlight_only_no_fulltext);
  appendIssueList(lines, "Fulltext without highlights", manifest.reports.fulltext_without_highlights);
  appendIssueList(lines, "Feed fulltext check", manifest.reports.feed_missing_fulltext_check);
  return `${lines.join("\n")}\n`;
}

function appendIssueList(lines, heading, entries) {
  lines.push(`### ${heading}`, "");
  if (!entries.length) {
    lines.push("- None", "");
    return;
  }
  for (const entry of entries.slice(0, 100)) {
    lines.push(`- ${entry.title} (${entry.source_file_relative})`);
  }
  if (entries.length > 100) lines.push(`- ... ${entries.length - 100} more`);
  lines.push("");
}

function buildReports(entries) {
  return {
    missing_url: entries.filter((entry) => entry.issues.includes("missing_url")),
    duplicate_title_or_url: entries.filter((entry) => entry.issues.includes("duplicate_title_or_url")),
    highlight_only_no_fulltext: entries.filter((entry) => entry.issues.includes("highlight_only_no_fulltext")),
    fulltext_without_highlights: entries.filter((entry) => entry.issues.includes("fulltext_without_highlights")),
    feed_missing_fulltext_check: entries.filter((entry) => entry.issues.includes("feed_missing_fulltext_check"))
  };
}

function buildCounts(entries, reports) {
  const byCategory = {};
  for (const entry of entries) {
    byCategory[entry.readwise_category] = (byCategory[entry.readwise_category] || 0) + 1;
  }
  return {
    total: entries.length,
    copied: entries.filter((entry) => entry.migration_status === "copied").length,
    would_copy: entries.filter((entry) => entry.migration_status === "would_copy").length,
    exists_skipped: entries.filter((entry) => entry.migration_status === "exists_skipped").length,
    pending: entries.filter((entry) => entry.migration_status === "pending").length,
    by_category: byCategory,
    missing_url: reports.missing_url.length,
    duplicate_title_or_url: reports.duplicate_title_or_url.length,
    highlight_only_no_fulltext: reports.highlight_only_no_fulltext.length,
    fulltext_without_highlights: reports.fulltext_without_highlights.length,
    feed_missing_fulltext_check: reports.feed_missing_fulltext_check.length
  };
}

function printSummary(manifest) {
  console.log(`Readwise raw files: ${manifest.counts.total}`);
  console.log(`Migration dir: ${migrationDir}`);
  console.log(`Reading dir: ${readingDir}`);
  console.log(`Copied: ${manifest.counts.copied}`);
  console.log(`Existing skipped: ${manifest.counts.exists_skipped}`);
  console.log(`Would copy: ${manifest.counts.would_copy}`);
  console.log(`Missing URL: ${manifest.counts.missing_url}`);
  console.log(`Duplicate title or URL: ${manifest.counts.duplicate_title_or_url}`);
  console.log(`Highlight-only without fulltext: ${manifest.counts.highlight_only_no_fulltext}`);
  console.log(`Fulltext without highlights: ${manifest.counts.fulltext_without_highlights}`);
  console.log(`Feed fulltext check: ${manifest.counts.feed_missing_fulltext_check}`);
  if (args.dryRun) console.log("Dry run only: no manifest or reading files were written.");
  if (!args.dryRun) console.log(`Manifest written: ${path.join(migrationDir, "manifest.md")}`);
}

function parseMarkdown(content) {
  if (!content.startsWith("---")) return { frontmatter: {}, body: content };
  const end = content.indexOf("\n---", 3);
  if (end === -1) return { frontmatter: {}, body: content };
  const yaml = content.slice(3, end).trim();
  const bodyStart = content.indexOf("\n", end + 4);
  return {
    frontmatter: parseSimpleYaml(yaml),
    body: bodyStart === -1 ? "" : content.slice(bodyStart + 1)
  };
}

function parseSimpleYaml(yaml) {
  const result = {};
  const lines = yaml.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!match) continue;
    const key = match[1];
    let value = match[2].trim();
    if (!value) {
      const list = [];
      while (i + 1 < lines.length && /^\s*-\s+/.test(lines[i + 1])) {
        i += 1;
        list.push(cleanYamlValue(lines[i].replace(/^\s*-\s+/, "")));
      }
      result[key] = list.length ? list : "";
    } else {
      result[key] = cleanYamlValue(value);
    }
  }
  return result;
}

function cleanYamlValue(value) {
  const trimmed = String(value ?? "").trim();
  if (/^\[.*\]$/.test(trimmed)) {
    return trimmed.slice(1, -1).split(",").map(cleanYamlValue).filter(Boolean);
  }
  return trimmed.replace(/^["']|["']$/g, "");
}

function extractTitle(parsed, filePath) {
  return normalizeText(firstPresent(
    parsed.frontmatter.title,
    parsed.frontmatter.source_title,
    parsed.frontmatter.document_title,
    matchLine(parsed.body, /^#\s+(.+)$/m),
    path.basename(filePath, path.extname(filePath))
  ));
}

function extractAuthor(parsed) {
  return normalizeText(firstPresent(
    parsed.frontmatter.author,
    parsed.frontmatter.authors,
    parsed.frontmatter.byline,
    matchLine(parsed.body, /^(?:[-*]\s*)?(?:Author|作者|By)\s*[:：]\s*(.+)$/im)
  ));
}

function extractSourceUrl(parsed) {
  const fromFrontmatter = firstPresent(
    parsed.frontmatter.source_url,
    parsed.frontmatter.url,
    parsed.frontmatter.source,
    parsed.frontmatter.document_url,
    parsed.frontmatter.original_url
  );
  if (fromFrontmatter) return normalizeText(fromFrontmatter);
  const metadataUrl = matchLine(parsed.body, /^(?:[-*]\s*)?(?:URL|Source|原文|原文链接|Link)\s*[:：]\s*(https?:\/\/\S+)/im);
  if (metadataUrl) return cleanupUrl(metadataUrl);
  const markdownLink = matchLine(parsed.body, /\[[^\]]*(?:原文|Source|URL|Link)[^\]]*\]\((https?:\/\/[^)\s]+)\)/i);
  if (markdownLink) return cleanupUrl(markdownLink);
  const anyUrl = matchLine(parsed.body, /(https?:\/\/[^\s)>"']+)/i);
  return anyUrl ? cleanupUrl(anyUrl) : "";
}

function extractTags(parsed) {
  const raw = firstPresent(
    parsed.frontmatter.tags,
    parsed.frontmatter.tag,
    matchLine(parsed.body, /^(?:[-*]\s*)?(?:Tags|标签)\s*[:：]\s*(.+)$/im)
  );
  return normalizeArray(raw);
}

function inferRole(body, filePath) {
  const lowerName = path.basename(filePath).toLowerCase();
  const lowerBody = body.toLowerCase();
  const hasHighlightSignals = /highlight|highlights|readwise|%%|摘录|高亮|笔记|annotation|annotations/.test(lowerBody);
  const hasFullSignals = /full[-_\s]?text|full document|全文|reader document/.test(lowerName) || /full[-_\s]?text|full document|全文/.test(lowerBody.slice(0, 2000));
  const words = body.split(/\s+/).filter(Boolean).length;
  if (hasFullSignals && hasHighlightSignals) return "mixed";
  if (hasFullSignals || (!hasHighlightSignals && words >= 800)) return "fulltext";
  if (hasHighlightSignals) return "highlights";
  return words >= 800 ? "fulltext" : "unknown";
}

async function collectMarkdownFiles(root) {
  const output = [];
  async function walk(dir) {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === ".obsidian" || entry.name === "node_modules") continue;
        await walk(fullPath);
      } else if (entry.isFile() && /\.md$/i.test(entry.name)) {
        output.push(fullPath);
      }
    }
  }
  await walk(root);
  output.sort((a, b) => normalizeSlash(a).localeCompare(normalizeSlash(b)));
  return output;
}

function parseArgs(argv) {
  const parsed = {
    dryRun: false,
    manifestOnly: false,
    help: false
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--dry-run") parsed.dryRun = true;
    else if (arg === "--manifest-only") parsed.manifestOnly = true;
    else if (arg === "--help" || arg === "-h") parsed.help = true;
    else if (["--raw", "--migration", "--reading", "--date"].includes(arg)) {
      parsed[arg.slice(2)] = argv[i + 1];
      i += 1;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return parsed;
}

function printHelp() {
  console.log([
    "Usage:",
    "  node scripts/migrate-readwise-obsidian.mjs --dry-run",
    "  node scripts/migrate-readwise-obsidian.mjs --manifest-only",
    "  node scripts/migrate-readwise-obsidian.mjs",
    "",
    "Options:",
    "  --raw <dir>          Readwise Official Obsidian export directory",
    "  --migration <dir>    Manifest output directory",
    "  --reading <dir>      Final reading-zone output directory",
    "  --date <yyyy-mm-dd>  Manifest date folder name",
    "  --dry-run            Print what would happen without writing files",
    "  --manifest-only      Write manifest files without copying into reading zone"
  ].join("\n"));
}

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function yamlScalar(value) {
  return JSON.stringify(String(value ?? ""));
}

function normalizeArray(value) {
  const values = Array.isArray(value) ? value : String(value ?? "").split(/[,\s]+/);
  return values.map((item) => normalizeText(item).replace(/^#/, "")).filter(Boolean);
}

function normalizeText(value) {
  if (Array.isArray(value)) return value.map(normalizeText).filter(Boolean).join(", ");
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function firstPresent(...values) {
  for (const value of values) {
    if (Array.isArray(value) && value.length) return value;
    if (typeof value === "string" && value.trim()) return value;
    if (value !== undefined && value !== null && typeof value !== "string" && !Array.isArray(value)) return value;
  }
  return "";
}

function matchLine(text, regex) {
  const match = text.match(regex);
  return match ? match[1].trim() : "";
}

function cleanupUrl(value) {
  return String(value ?? "").replace(/[),.;]+$/, "").trim();
}

function normalizeKey(value) {
  return normalizeText(value).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

function sanitizePathSegment(segment) {
  const cleaned = sanitize(normalizeText(segment));
  return (cleaned || "untitled").slice(0, 120);
}

function normalizeSlash(value) {
  return value.split(path.sep).join("/");
}

function formatDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}
