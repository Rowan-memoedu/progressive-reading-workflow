#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { normalizeUrl, sha256 } from "./core.mjs";

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const defaultProjectRoot = path.resolve(moduleDir, "..");

function posixRelative(root, target) {
  return path.relative(root, target).replace(/\\/gu, "/");
}

async function exists(target) {
  try { await fs.access(target); return true; } catch { return false; }
}

async function walkFiles(root) {
  if (!(await exists(root))) return [];
  const result = [];
  const pending = [root];
  while (pending.length) {
    const current = pending.pop();
    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(target);
      else if (entry.isFile()) result.push(target);
    }
  }
  return result.sort((left, right) => left.localeCompare(right));
}

async function writeJsonAtomic(target, value) {
  await fs.mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.tmp-${crypto.randomUUID()}`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await fs.rename(temporary, target);
}

function safeNormalizeUrl(value) {
  try { return normalizeUrl(value); } catch { return ""; }
}

export function parseLegacySourceText(text, sourceFile = "") {
  const match = String(text || "").match(/^<!-- rss-source-meta\s*([\s\S]*?)\s*-->\s*/u);
  if (!match) return null;
  const metadata = JSON.parse(match[1]);
  const itemUrl = safeNormalizeUrl(metadata.url || metadata.platformId || "");
  const sourceType = String(metadata.sourceType || metadata.platform || "").toLowerCase();
  const body = String(text).slice(match[0].length);
  return {
    source_file: sourceFile,
    key: String(metadata.key || ""),
    canonical_key: String(metadata.canonicalKey || ""),
    source_id: String(metadata.sourceId || ""),
    source_type: sourceType,
    item_url: itemUrl,
    title: String(metadata.title || ""),
    author: String(metadata.author || ""),
    published_at: String(metadata.publishedAt || ""),
    content_hash: String(metadata.contentHash || sha256(body)),
    fetch_method: String(metadata.fetchMethod || ""),
    body_sha256: sha256(body)
  };
}

export function extractReviewDecisions(text, sourceFile = "") {
  const decisions = [];
  const pattern = /^###\s+\d+\.\s+(?<title>.+?)\r?\n\[原文链接\]\((?<url>[^)]+)\)\r?\n- \[(?<formal>[ xX])\] 正式入库\r?\n- \[(?<remove>[ xX])\] 删除/gmu;
  for (const match of String(text || "").matchAll(pattern)) {
    const itemUrl = safeNormalizeUrl(match.groups.url);
    const formal = /[xX]/u.test(match.groups.formal);
    const remove = /[xX]/u.test(match.groups.remove);
    const decision = formal && remove ? "conflict" : formal ? "formal_selected" : remove ? "delete_selected" : "unresolved";
    decisions.push({
      decision_id: `rss-review-${sha256(itemUrl || `${sourceFile}\n${match.groups.title}`).slice(0, 20)}`,
      item_url: itemUrl || match.groups.url,
      title: match.groups.title.trim(),
      decision,
      source_file: sourceFile
    });
  }
  return decisions;
}

function primaryReadingUrls(text) {
  const values = [];
  const pattern = /\[(?:原文链接|Original)\]\((https?:\/\/[^)]+)\)/gu;
  for (const match of String(text || "").matchAll(pattern)) {
    const normalized = safeNormalizeUrl(match[1]);
    if (normalized) values.push(normalized);
  }
  return values;
}

async function legacySourceMap(projectRoot) {
  const configPath = path.join(projectRoot, "config", "rss-sources.json");
  if (!(await exists(configPath))) return new Map();
  const config = JSON.parse(await fs.readFile(configPath, "utf8"));
  return new Map((config.sources || []).map((source) => [String(source.id || ""), {
    feed_url: safeNormalizeUrl(source.feedUrl || ""),
    type: String(source.type || ""),
    display_name: String(source.displayName || source.id || "")
  }]));
}

async function currentV1Urls(projectRoot) {
  const root = path.join(projectRoot, "imports", "rss", "source-v1", "packages");
  const urls = new Set();
  for (const file of await walkFiles(root)) {
    if (path.basename(file) !== "source-metadata.json") continue;
    try {
      const metadata = JSON.parse(await fs.readFile(file, "utf8"));
      const normalized = safeNormalizeUrl(metadata.item_url || "");
      if (normalized) urls.add(normalized);
    } catch {
      // A malformed active package remains the responsibility of the v1 package validator.
    }
  }
  return urls;
}

function assertLegacyOutput(projectRoot, value) {
  const importsRss = path.join(projectRoot, "imports", "rss");
  const target = path.resolve(value || path.join(importsRss, "legacy-v0"));
  const relative = path.relative(importsRss, target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("legacy_output_must_stay_inside_imports_rss");
  return target;
}

async function evidenceTargets(projectRoot) {
  const specs = [
    { relative: "config/rss-sources.json", category: "control", preserve: true },
    { relative: "imports/rss/state.json", category: "control", preserve: true },
    { relative: "imports/rss/source-layer.json", category: "control", preserve: true },
    { relative: "scripts/rss-workflow.mjs", category: "legacy_code", preserve: true },
    { relative: "scripts/rss-sync-daily.cmd", category: "legacy_code", preserve: true },
    { relative: "docker-compose.rss.yml", category: "reproducible_tooling", preserve: false }
  ];
  const directories = [
    { relative: "imports/rss/source-layer", category: "source_layer", preserve: true },
    { relative: "imports/rss/runs", category: "run_evidence", preserve: true },
    { relative: "阅读区/RSS", category: "reading_output", preserve: true },
    { relative: "imports/rss/tools", category: "reproducible_tooling", preserve: false }
  ];
  const targets = [];
  for (const spec of specs) {
    const absolute = path.join(projectRoot, ...spec.relative.split("/"));
    if (await exists(absolute)) targets.push({ absolute, ...spec });
  }
  for (const directory of directories) {
    const root = path.join(projectRoot, ...directory.relative.split("/"));
    for (const absolute of await walkFiles(root)) {
      targets.push({ absolute, relative: posixRelative(projectRoot, absolute), category: directory.category, preserve: directory.preserve });
    }
  }
  return [...new Map(targets.map((item) => [path.resolve(item.absolute).toLowerCase(), item])).values()]
    .sort((left, right) => left.relative.localeCompare(right.relative));
}

async function preserveEvidence(outputRoot, hash, buffer) {
  const relative = `evidence/sha256/${hash.slice(0, 2)}/${hash}`;
  const target = path.join(outputRoot, ...relative.split("/"));
  if (await exists(target)) {
    const existing = await fs.readFile(target);
    if (sha256(existing) !== hash) throw new Error(`legacy_evidence_hash_mismatch_${hash}`);
    return relative;
  }
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, buffer);
  return relative;
}

export async function generateLegacyAudit({ projectRoot = defaultProjectRoot, outputRoot = "", copyEvidence = true, generatedAt = new Date().toISOString() } = {}) {
  const root = path.resolve(projectRoot);
  const legacyRoot = assertLegacyOutput(root, outputRoot);
  const sourceMap = await legacySourceMap(root);
  const activeV1Urls = await currentV1Urls(root);
  const files = [];
  const blobSizes = new Map();
  for (const target of await evidenceTargets(root)) {
    const buffer = await fs.readFile(target.absolute);
    const hash = sha256(buffer);
    let evidenceBlob = null;
    if (copyEvidence && target.preserve) {
      evidenceBlob = await preserveEvidence(legacyRoot, hash, buffer);
      blobSizes.set(hash, buffer.length);
    }
    files.push({
      relative_path: target.relative,
      category: target.category,
      size: buffer.length,
      sha256: hash,
      evidence_blob: evidenceBlob,
      disposition: target.preserve ? "preserve_before_retirement" : "reproducible_delete_candidate"
    });
  }

  const sourceRoot = path.join(root, "imports", "rss", "source-layer", "entries");
  const sourceRecords = [];
  for (const file of await walkFiles(sourceRoot)) {
    const relative = posixRelative(root, file);
    try {
      const record = parseLegacySourceText(await fs.readFile(file, "utf8"), relative);
      if (record) sourceRecords.push({ ...record, feed_url: sourceMap.get(record.source_id)?.feed_url || "" });
    } catch (error) {
      sourceRecords.push({ source_file: relative, parse_error: error.message, source_type: "unknown", item_url: "", content_hash: "" });
    }
  }
  const rssRecords = sourceRecords.filter((item) => item.source_type === "rss" && item.item_url && item.content_hash);
  const nonRssRecords = sourceRecords.filter((item) => item.source_type !== "rss");
  const rssGroups = new Map();
  for (const record of rssRecords) {
    const key = `${record.item_url}\n${record.content_hash}`;
    if (!rssGroups.has(key)) rssGroups.set(key, []);
    rssGroups.get(key).push(record);
  }
  const migrationCandidates = [...rssGroups.values()].map((group) => {
    const record = group[0];
    return {
      candidate_id: `legacy-rss-${sha256(`${record.feed_url}\n${record.item_url}\n${record.content_hash}`).slice(0, 24)}`,
      feed_url: record.feed_url || null,
      item_url: record.item_url,
      title: record.title,
      author: record.author || null,
      published_at: record.published_at || null,
      content_hash: record.content_hash,
      legacy_content_status: "unverified_legacy",
      recommended_action: record.item_url ? "refetch_required" : "manual_review",
      already_in_source_v1: activeV1Urls.has(record.item_url),
      origin_files: group.map((item) => item.source_file),
      duplicate_origin_count: group.length - 1
    };
  }).sort((left, right) => left.item_url.localeCompare(right.item_url));

  const readingRoot = path.join(root, "阅读区", "RSS");
  const reviewDecisions = [];
  const readingReferences = new Map();
  for (const file of await walkFiles(readingRoot)) {
    if (path.extname(file).toLowerCase() !== ".md") continue;
    const relative = posixRelative(root, file);
    const text = await fs.readFile(file, "utf8");
    reviewDecisions.push(...extractReviewDecisions(text, relative));
    for (const itemUrl of primaryReadingUrls(text)) {
      if (!readingReferences.has(itemUrl)) readingReferences.set(itemUrl, new Set());
      readingReferences.get(itemUrl).add(relative);
    }
  }
  const legacySourceUrls = new Set(sourceRecords.map((item) => item.item_url).filter(Boolean));
  const readingOnly = [...readingReferences.entries()]
    .filter(([itemUrl]) => !legacySourceUrls.has(itemUrl))
    .map(([itemUrl, sourceFiles]) => ({ item_url: itemUrl, source_files: [...sourceFiles].sort() }))
    .sort((left, right) => left.item_url.localeCompare(right.item_url));
  const decisionCounts = reviewDecisions.reduce((counts, item) => {
    counts[item.decision] = (counts[item.decision] || 0) + 1;
    return counts;
  }, {});
  const preservedFiles = files.filter((item) => item.evidence_blob);
  const uniqueBlobBytes = [...blobSizes.values()].reduce((sum, value) => sum + value, 0);
  const stats = {
    inventoried_files: files.length,
    preserved_files: preservedFiles.length,
    unique_evidence_blobs: blobSizes.size,
    inventoried_bytes: files.reduce((sum, item) => sum + item.size, 0),
    unique_evidence_bytes: uniqueBlobBytes,
    legacy_source_files: sourceRecords.length,
    legacy_source_parse_failures: sourceRecords.filter((item) => item.parse_error).length,
    rss_source_files: rssRecords.length,
    rss_unique_candidates: migrationCandidates.length,
    rss_duplicate_files: rssRecords.length - migrationCandidates.length,
    non_rss_source_files: nonRssRecords.length,
    review_decisions: reviewDecisions.length,
    review_decision_counts: decisionCounts,
    reading_unique_item_urls: readingReferences.size,
    reading_urls_with_source_layer_match: [...readingReferences.keys()].filter((itemUrl) => legacySourceUrls.has(itemUrl)).length,
    reading_only_item_urls: readingOnly.length,
    active_source_v1_item_urls: activeV1Urls.size,
    legacy_candidates_already_in_v1: migrationCandidates.filter((item) => item.already_in_source_v1).length
  };

  const reviewLedger = {
    schema_version: "progressive-reading.rss-legacy-review-ledger/v1",
    generated_at: generatedAt,
    note: "Historical downstream decisions only; not RSS source facts and not publication authorization.",
    counts: decisionCounts,
    decisions: reviewDecisions
  };
  const candidates = {
    schema_version: "progressive-reading.rss-legacy-candidates/v1",
    generated_at: generatedAt,
    completeness_policy: "Legacy Markdown is not promoted to fulltext_ready without raw fulltext evidence or a fresh public refetch.",
    rss_candidates: migrationCandidates,
    reading_only_candidates: readingOnly,
    non_rss_legacy_entries: nonRssRecords.map((item) => ({
      source_file: item.source_file,
      source_id: item.source_id || null,
      source_type: item.source_type,
      item_url: item.item_url || null,
      title: item.title || null,
      content_hash: item.content_hash || null
    }))
  };
  const manifest = {
    schema_version: "progressive-reading.rss-legacy-manifest/v1",
    generated_at: generatedAt,
    project_root: root,
    legacy_output_root: legacyRoot,
    evidence_mode: copyEvidence ? "content_addressed_copy" : "hash_inventory_only",
    safety: {
      moved_or_deleted_legacy_files: false,
      wrote_reading_area: false,
      wrote_remnote_or_logseq: false,
      used_browser_or_login_state: false
    },
    stats,
    files
  };
  await writeJsonAtomic(path.join(legacyRoot, "manifest.json"), manifest);
  await writeJsonAtomic(path.join(legacyRoot, "review-decisions.json"), reviewLedger);
  await writeJsonAtomic(path.join(legacyRoot, "migration-candidates.json"), candidates);
  return {
    schema_version: "progressive-reading.rss-legacy-audit-result/v1",
    status: "completed",
    output_root: legacyRoot,
    manifest: path.join(legacyRoot, "manifest.json"),
    review_decisions: path.join(legacyRoot, "review-decisions.json"),
    migration_candidates: path.join(legacyRoot, "migration-candidates.json"),
    stats,
    safety: manifest.safety
  };
}

function parseArgs(argv) {
  const command = argv[0] || "help";
  const options = {};
  for (let index = 1; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item.startsWith("--")) throw new Error(`unexpected_argument_${item}`);
    const key = item.slice(2);
    if (key === "no-copy-evidence") options[key] = true;
    else options[key] = argv[++index] ?? "";
  }
  return { command, options };
}

async function main() {
  const { command, options } = parseArgs(process.argv.slice(2));
  if (command !== "audit") {
    process.stdout.write(`${JSON.stringify({
      ok: true,
      command: "help",
      result: { command: "legacy-migration audit [--output <imports/rss/path>] [--no-copy-evidence]" }
    }, null, 2)}\n`);
    return;
  }
  const result = await generateLegacyAudit({
    projectRoot: defaultProjectRoot,
    outputRoot: options.output || "",
    copyEvidence: options["no-copy-evidence"] !== true
  });
  process.stdout.write(`${JSON.stringify({ ok: true, command, result }, null, 2)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stdout.write(`${JSON.stringify({
      ok: false,
      error: { code: "rss_legacy_audit_failed", message: error.message }
    }, null, 2)}\n`);
    process.exitCode = 1;
  });
}
