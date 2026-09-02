import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import sanitizeFilename from "sanitize-filename";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_WORKFLOW_ROOT = path.resolve(__dirname, "..");
export const LEDGER_SCHEMA = "progressive-reading.rss-review-ledger/v1";
export const CANARY_SCHEMA = "progressive-reading.rss-reading-canary/v1";
export const DECISIONS = new Set(["unresolved", "selected", "deferred", "dismissed"]);
export const LONG_THRESHOLD = 1200;
export const REVIEW_PREVIEW_VERSION = "1.1.0";

function nowIso() {
  return new Date().toISOString();
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function fileSha256(file) {
  return sha256(await fs.readFile(file));
}

function localDate(date = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(date);
}

function isoWeek(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);
  const value = new Date(Date.UTC(
    Number(parts.find((part) => part.type === "year").value),
    Number(parts.find((part) => part.type === "month").value) - 1,
    Number(parts.find((part) => part.type === "day").value)
  ));
  const day = value.getUTCDay() || 7;
  value.setUTCDate(value.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(value.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((value - yearStart) / 86400000) + 1) / 7);
  return `${value.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

function addLocalDays(dateKey, days) {
  const [year, month, day] = String(dateKey).split("-").map(Number);
  const value = new Date(Date.UTC(year, month - 1, day));
  value.setUTCDate(value.getUTCDate() + Number(days));
  return value.toISOString().slice(0, 10);
}

function dateInShanghai(value) {
  if (!value || Number.isNaN(new Date(value).getTime())) return "";
  return localDate(new Date(value));
}

function weekInShanghai(value) {
  if (!value || Number.isNaN(new Date(value).getTime())) return "";
  return isoWeek(new Date(value));
}

function normalizeUrl(value) {
  try {
    const url = new URL(String(value || ""));
    url.hash = "";
    for (const key of [...url.searchParams.keys()]) {
      if (/^(utm_|spm$|from$|source$|ref$|ref_src$)/i.test(key)) url.searchParams.delete(key);
    }
    url.pathname = url.pathname.replace(/\/+$/u, "") || "/";
    return url.toString();
  } catch {
    return String(value || "").trim();
  }
}

function meaningfulLength(markdown) {
  return String(markdown || "")
    .replace(/^---\r?\n[\s\S]*?\r?\n---\s*/u, "")
    .replace(/<!--[^]*?-->/gu, "")
    .replace(/!\[[^\]]*\]\([^)]*\)/gu, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/gu, "$1")
    .replace(/https?:\/\/\S+/gu, " ")
    .replace(/[#>*_`~|\-]+/gu, " ")
    .replace(/\s+/gu, "")
    .length;
}

function safeTitle(value, fallback) {
  const title = sanitizeFilename(String(value || fallback || "RSS 未命名")).replace(/\s+/gu, " ").trim();
  return (title || fallback || "RSS 未命名").slice(0, 120);
}

async function readJson(file, fallback = null) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw error;
  }
}

async function writeJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp-${randomUUID()}`;
  await fs.writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  try {
    await fs.rename(temp, file);
  } catch (error) {
    if (!existsSync(temp)) throw error;
    await fs.copyFile(temp, file);
    await fs.unlink(temp);
  }
}

async function walkFiles(root) {
  if (!existsSync(root)) return [];
  const files = [];
  const queue = [root];
  while (queue.length) {
    const current = queue.shift();
    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) queue.push(target);
      else if (entry.isFile()) files.push(target);
    }
  }
  return files;
}

export function workflowPaths(workflowRoot = DEFAULT_WORKFLOW_ROOT) {
  const root = path.resolve(workflowRoot);
  return {
    workflowRoot: root,
    packagesRoot: path.join(root, "imports", "rss", "source-v1", "packages"),
    batchesRoot: path.join(root, "imports", "rss", "source-v1", "batches"),
    legacyLedgerPath: path.join(root, "imports", "rss", "legacy-v0", "review-decisions.json"),
    dataRoot: path.join(root, "imports", "rss-reading"),
    ledgerPath: path.join(root, "imports", "rss-reading", "review-ledger.v1.json"),
    runsRoot: path.join(root, "imports", "rss-reading", "runs"),
    canaryRoot: path.join(root, "imports", "rss-reading", "canary"),
    previewsRoot: path.join(root, "imports", "rss-reading", "previews"),
    legacyOutputManifestPath: path.join(root, "imports", "rss-reading", "legacy-output-migration.json"),
    supersededReportReceiptPath: path.join(root, "imports", "rss-reading", "superseded-report-migration.json"),
    summaryRoot: path.join(root, "摘要区", "RSS"),
    legacySummaryArchiveRoot: path.join(root, "摘要区", "RSS", "历史归档", "legacy-v0"),
    supersededSummaryArchiveRoot: path.join(root, "摘要区", "RSS", "历史归档", "consumer-v1-obsolete"),
    readingRoot: path.join(root, "阅读区", "RSS"),
    shortWeeklyRoot: path.join(root, "阅读区", "RSS", "短文周报"),
    localIrStateRoot: path.join(root, ".local-ir", "browser-document-state"),
    preprocessRoot: path.join(root, "imports", "preprocess-runs", "rss"),
    preprocessCli: path.join(root, "standard-preprocessing", "cli.mjs")
  };
}

async function verifiedLegacyManifest(paths) {
  const manifest = await readJson(paths.legacyOutputManifestPath);
  if (!manifest || manifest.status !== "completed" || !Array.isArray(manifest.files)) return null;
  for (const item of manifest.files) {
    if (!existsSync(item.target_path) || await fileSha256(item.target_path) !== item.target_sha256) return null;
  }
  return manifest;
}

async function preservedHistoricalShortWeeklyEvidence(paths, manifest) {
  if (!manifest?.files) return [];
  const candidates = manifest.files.filter((item) => String(item.relative_path || "").replaceAll("\\", "/").startsWith("短文周报/"));
  const evidence = [];
  for (const item of candidates) {
    const relative = String(item.relative_path).replaceAll("/", path.sep);
    const activePath = path.join(paths.readingRoot, relative);
    const archivePath = path.join(paths.legacySummaryArchiveRoot, relative);
    const expectedSha256 = item.source_sha256 || item.target_sha256;
    const activeExists = existsSync(activePath);
    const archiveExists = existsSync(archivePath);
    const activeSha256 = activeExists ? await fileSha256(activePath) : null;
    const archiveSha256 = archiveExists ? await fileSha256(archivePath) : null;
    evidence.push({
      path: activePath,
      archive_path: archivePath,
      expected_sha256: expectedSha256,
      actual_sha256: activeSha256,
      archive_sha256: archiveSha256,
      exists: activeExists,
      verified: activeExists && archiveExists && activeSha256 === expectedSha256 && archiveSha256 === expectedSha256
    });
  }
  return evidence;
}

async function activeReferencesTo(paths, sourcePath) {
  const basename = path.basename(sourcePath);
  const candidates = [
    path.join(paths.workflowRoot, "README.md"),
    path.join(paths.workflowRoot, "package.json"),
    paths.ledgerPath,
    ...(await walkFiles(path.join(paths.workflowRoot, "docs"))),
    ...(await walkFiles(path.join(paths.workflowRoot, "scripts"))),
    ...(await walkFiles(path.join(paths.workflowRoot, "rss-reading"))),
    ...(await walkFiles(paths.summaryRoot)).filter((file) => {
      const relative = path.relative(paths.summaryRoot, file);
      return !relative.startsWith(`历史归档${path.sep}`);
    })
  ];
  const references = [];
  for (const file of [...new Set(candidates)].filter((file) => file !== sourcePath && existsSync(file))) {
    const extension = path.extname(file).toLowerCase();
    if (!new Set([".md", ".json", ".mjs", ".js", ".ps1", ".toml"]).has(extension)) continue;
    const text = await fs.readFile(file, "utf8");
    if (text.includes(basename) || text.includes(sourcePath)) references.push(file);
  }
  return references;
}

async function archiveSupersededWeeklySummary(paths, week) {
  const sourcePath = path.join(paths.summaryRoot, `${week} RSS 周报.md`);
  const archivePath = path.join(paths.supersededSummaryArchiveRoot, `${week} RSS 周报.md`);
  if (!existsSync(sourcePath)) {
    return {
      status: existsSync(archivePath) ? "already_archived" : "absent",
      verified: !existsSync(archivePath) || Boolean(await fileSha256(archivePath)),
      source_path: sourcePath,
      archive_path: existsSync(archivePath) ? archivePath : null
    };
  }
  const replacementPaths = [
    path.join(paths.summaryRoot, `${week} RSS 长文周报.md`),
    path.join(paths.shortWeeklyRoot, `${week} RSS 短文周报.md`)
  ];
  const sourceText = await fs.readFile(sourcePath, "utf8");
  const references = await activeReferencesTo(paths, sourcePath);
  const sourceSha256 = await fileSha256(sourcePath);
  const base = {
    source_path: sourcePath,
    archive_path: archivePath,
    source_sha256: sourceSha256,
    replacements: replacementPaths,
    references
  };
  if (!replacementPaths.every((file) => existsSync(file))) {
    return { ...base, status: "blocked_missing_replacement", verified: false };
  }
  if (!sourceText.startsWith(`# ${week} RSS 短文周报`)) {
    return { ...base, status: "blocked_unrecognized_content", verified: false };
  }
  if (references.length) return { ...base, status: "blocked_active_references", verified: false };
  await fs.mkdir(path.dirname(archivePath), { recursive: true });
  if (existsSync(archivePath) && await fileSha256(archivePath) !== sourceSha256) {
    return { ...base, status: "blocked_archive_conflict", verified: false };
  }
  if (!existsSync(archivePath)) await fs.copyFile(sourcePath, archivePath);
  const archiveSha256 = await fileSha256(archivePath);
  if (archiveSha256 !== sourceSha256) return { ...base, status: "blocked_archive_hash_mismatch", verified: false, archive_sha256: archiveSha256 };
  await fs.unlink(sourcePath);
  const result = {
    ...base,
    schema_version: "progressive-reading.rss-superseded-report-migration/v1",
    status: "archived",
    verified: !existsSync(sourcePath) && existsSync(archivePath) && await fileSha256(archivePath) === sourceSha256,
    archive_sha256: archiveSha256,
    migrated_at: nowIso()
  };
  await writeJson(paths.supersededReportReceiptPath, result);
  return result;
}

export async function migrateLegacyOutputs(workflowRoot = DEFAULT_WORKFLOW_ROOT, options = {}) {
  const paths = workflowPaths(workflowRoot);
  if (!options.force) {
    const verified = await verifiedLegacyManifest(paths);
    if (verified) return { ...verified, reused: true };
  }
  const allowedDirectories = ["待确认", "短文周报", "低价值归档"];
  const migrated = [];
  for (const directory of allowedDirectories) {
    const sourceRoot = path.join(paths.readingRoot, directory);
    for (const source of (await walkFiles(sourceRoot)).filter((file) => file.endsWith(".md"))) {
      const relative = path.relative(paths.readingRoot, source);
      const target = path.join(paths.legacySummaryArchiveRoot, relative);
      const sourceHash = await fileSha256(source);
      await fs.mkdir(path.dirname(target), { recursive: true });
      if (!existsSync(target) || await fileSha256(target) !== sourceHash) await fs.copyFile(source, target);
      const targetHash = await fileSha256(target);
      migrated.push({
        source_path: source,
        target_path: target,
        relative_path: relative.replaceAll("\\", "/"),
        source_sha256: sourceHash,
        target_sha256: targetHash,
        verified: sourceHash === targetHash
      });
    }
  }
  migrated.sort((a, b) => a.relative_path.localeCompare(b.relative_path));
  const manifest = {
    schema_version: "progressive-reading.rss-legacy-output-migration/v1",
    status: migrated.every((item) => item.verified) ? "completed" : "failed",
    verified_at: nowIso(),
    source_root: paths.readingRoot,
    target_root: paths.legacySummaryArchiveRoot,
    file_count: migrated.length,
    files: migrated,
    source_mutated: false
  };
  await writeJson(paths.legacyOutputManifestPath, manifest);
  return manifest;
}

function requestMarkdown(request) {
  if (typeof request?.material === "string") return request.material;
  if (request?.material && typeof request.material.markdown === "string") return request.material.markdown;
  if (typeof request?.input === "string") return request.input;
  return "";
}

function validatePackage(pkg, packageFile) {
  if (pkg?.schema_version !== "progressive-reading.rss-source-package/v1") {
    throw new Error(`invalid_source_package_schema:${packageFile}`);
  }
  if (!pkg.material_id || !pkg.content_status || !pkg.identity || !pkg.source_metadata) {
    throw new Error(`invalid_source_package_shape:${packageFile}`);
  }
}

export async function scanCatalog(workflowRoot = DEFAULT_WORKFLOW_ROOT) {
  const paths = workflowPaths(workflowRoot);
  const packageFiles = (await walkFiles(paths.packagesRoot)).filter((file) => path.basename(file) === "package.json");
  const items = [];
  for (const packageFile of packageFiles) {
    const pkg = await readJson(packageFile);
    validatePackage(pkg, packageFile);
    const packageDir = path.dirname(packageFile);
    const requestPath = pkg.artifacts?.preprocess_request
      ? path.resolve(packageDir, pkg.artifacts.preprocess_request)
      : path.join(packageDir, "preprocess-request.json");
    const request = existsSync(requestPath) ? await readJson(requestPath) : null;
    const eligible = pkg.content_status === "fulltext_ready"
      && pkg.receipt?.preprocessing_handoff === "request_ready"
      && Boolean(request);
    const length = request ? meaningfulLength(requestMarkdown(request)) : 0;
    const route = !eligible ? "blocked" : length >= LONG_THRESHOLD ? "long_review" : "short_aggregate";
    items.push({
      materialId: pkg.material_id,
      packageFile,
      packageDir,
      packageSha256: await fileSha256(packageFile),
      requestPath: eligible ? requestPath : null,
      requestSha256: eligible ? await fileSha256(requestPath) : null,
      status: pkg.status,
      contentStatus: pkg.content_status,
      syncStatus: pkg.sync_status,
      eligible,
      route,
      routingReason: eligible ? `meaningful_length_${length}_threshold_${LONG_THRESHOLD}` : `blocked_${pkg.content_status}`,
      meaningfulLength: length,
      title: pkg.source_metadata.title || pkg.identity.normalized_item_url || pkg.material_id,
      author: pkg.source_metadata.author || "",
      publishedAt: pkg.source_metadata.published_at || null,
      fetchedAt: pkg.source_metadata.fetched_at || null,
      itemUrl: pkg.identity.normalized_item_url || pkg.source_metadata.item_url || null,
      feedUrl: pkg.identity.normalized_feed_url || pkg.source_metadata.feed_url || null,
      sourceId: pkg.receipt?.source_id || "",
      errors: pkg.errors || [],
      sourceEvidence: {
        raw_item_page: pkg.artifacts?.raw_item_page
          ? path.resolve(packageDir, pkg.artifacts.raw_item_page)
          : null,
        raw_item_page_response: pkg.artifacts?.raw_item_page_response
          ? path.resolve(packageDir, pkg.artifacts.raw_item_page_response)
          : null
      }
    });
  }
  items.sort((a, b) => String(b.publishedAt || b.fetchedAt || "").localeCompare(String(a.publishedAt || a.fetchedAt || "")) || a.title.localeCompare(b.title));
  return { paths, items };
}

function emptyLedger() {
  const time = nowIso();
  return {
    schema_version: LEDGER_SCHEMA,
    ledger_version: "1.1.0",
    created_at: time,
    updated_at: time,
    legacy_import: null,
    legacy_decisions: [],
    report_runs: { daily: {}, weekly: {} },
    items: {}
  };
}

function addHistory(item, event) {
  item.history ||= [];
  const previous = item.history.at(-1);
  const normalized = { at: event.at || nowIso(), ...event };
  if (previous && JSON.stringify({ ...previous, at: null }) === JSON.stringify({ ...normalized, at: null })) return;
  item.history.push(normalized);
}

async function importLegacy(ledger, paths) {
  const legacy = await readJson(paths.legacyLedgerPath);
  if (!legacy) throw new Error("legacy_review_ledger_missing");
  if (legacy.schema_version !== "progressive-reading.rss-legacy-review-ledger/v1") throw new Error("legacy_review_ledger_schema_invalid");
  const selected = legacy.decisions.filter((item) => item.decision === "formal_selected").length;
  const unresolved = legacy.decisions.filter((item) => item.decision === "unresolved").length;
  if (legacy.decisions.length !== 22 || selected !== 14 || unresolved !== 8) {
    throw new Error(`legacy_review_conservation_failed:${legacy.decisions.length}:${selected}:${unresolved}`);
  }
  const digest = await fileSha256(paths.legacyLedgerPath);
  ledger.legacy_import = {
    source_path: paths.legacyLedgerPath,
    source_sha256: digest,
    imported_at: ledger.legacy_import?.source_sha256 === digest ? ledger.legacy_import.imported_at : nowIso(),
    counts: { total: legacy.decisions.length, selected, unresolved }
  };
  ledger.legacy_decisions = legacy.decisions.map((item) => ({
    ...item,
    normalized_item_url: normalizeUrl(item.item_url),
    migrated_decision: item.decision === "formal_selected" ? "selected" : "unresolved",
    publication_authorized: false
  }));
}

export async function loadLedger(workflowRoot = DEFAULT_WORKFLOW_ROOT) {
  const paths = workflowPaths(workflowRoot);
  const ledger = await readJson(paths.ledgerPath, emptyLedger());
  if (ledger.schema_version !== LEDGER_SCHEMA) throw new Error("rss_reading_ledger_schema_invalid");
  return ledger;
}

export async function syncLedger(workflowRoot = DEFAULT_WORKFLOW_ROOT, catalog = null) {
  const scanned = catalog || await scanCatalog(workflowRoot);
  const { paths, items } = scanned;
  const ledger = await readJson(paths.ledgerPath, emptyLedger());
  if (ledger.schema_version !== LEDGER_SCHEMA) throw new Error("rss_reading_ledger_schema_invalid");
  await importLegacy(ledger, paths);
  const legacyByUrl = new Map(ledger.legacy_decisions.map((item) => [item.normalized_item_url, item]));
  for (const current of items) {
    const existing = ledger.items[current.materialId] || null;
    const legacy = current.itemUrl ? legacyByUrl.get(normalizeUrl(current.itemUrl)) : null;
    const item = existing || {
      material_id: current.materialId,
      decision: legacy?.migrated_decision || "unresolved",
      decision_source: legacy ? "legacy_v0" : "default",
      decision_at: nowIso(),
      publication_authorized: false,
      publication_authorization_source: null,
      publication: null,
      delivery: {},
      history: []
    };
    const sourceRevision = sha256(`${current.packageSha256}:${current.requestSha256 || "blocked"}:${current.contentStatus}:${current.route}`);
    const observedAt = nowIso();
    Object.assign(item, {
      title: current.title,
      item_url: current.itemUrl,
      feed_url: current.feedUrl,
      author: current.author,
      published_at: current.publishedAt,
      fetched_at: current.fetchedAt,
      source_id: current.sourceId,
      content_status: current.contentStatus,
      source_status: current.status,
      source_errors: current.errors,
      source_evidence: current.sourceEvidence,
      source_package_path: current.packageDir,
      source_package_sha256: current.packageSha256,
      preprocess_request_path: current.requestPath,
      preprocess_request_sha256: current.requestSha256,
      eligible_for_preprocess: current.eligible,
      route: item.route_override || current.route,
      routing_reason: item.route_override ? "manual_override" : current.routingReason,
      meaningful_length: current.meaningfulLength,
      legacy_decision_id: legacy?.decision_id || item.legacy_decision_id || null,
      source_revision: sourceRevision,
      first_observed_at: item.first_observed_at || item.observed_at || observedAt,
      observed_at: item.first_observed_at || item.observed_at || observedAt,
      last_observed_at: observedAt,
      delivery: item.delivery || {}
    });
    if (!existing) addHistory(item, {
      type: legacy ? "legacy_decision_migrated" : "material_observed",
      decision: item.decision,
      publication_authorized: false,
      source: item.decision_source
    });
    ledger.items[current.materialId] = item;
  }
  ledger.updated_at = nowIso();
  await writeJson(paths.ledgerPath, ledger);
  return { paths, ledger, catalog: scanned };
}

function compactText(value) {
  return String(value || "").replace(/\s+/gu, " ").trim();
}

function firstSentence(value, maxLength = 220) {
  const text = compactText(value);
  const sentence = text.match(/^.*?[。！？!?]/u)?.[0]?.trim() || text;
  return sentence.length > maxLength ? `${sentence.slice(0, maxLength - 1).trim()}…` : sentence;
}

function humanValue(level) {
  return ({ high: "高", medium: "中", low: "低" })[level] || "待判断";
}

function readingCost(length) {
  const minutes = Math.max(3, Math.ceil(Number(length || 0) / 550));
  if (minutes <= 5) return `约 ${minutes} 分钟`;
  if (minutes <= 15) return "约 6–15 分钟";
  if (minutes <= 30) return "约 16–30 分钟";
  if (minutes <= 60) return "约 31–60 分钟";
  return "约 60 分钟以上";
}

function readingRoute(level) {
  return ({
    0: "不建议继续",
    1: "只读一句话核心",
    2: "读概览与关键结论",
    3: "阅读全文",
    4: "精细阅读并加工"
  })[Number(level)] || "根据兴趣阅读全文";
}

function sourceLabel(item) {
  if (compactText(item.author)) return compactText(item.author);
  try {
    return new URL(item.feed_url || item.item_url).hostname.replace(/^www\./u, "");
  } catch {
    return "RSS";
  }
}

function decisionLabel(item) {
  if (item.decision === "selected" && item.publication?.status === "published") return "已正式入库";
  if (item.decision === "deferred" && item.later?.status === "ready") return `已入库，Later 至 ${String(item.later.defer_until || "").slice(0, 10)}`;
  if (item.publication_failure) return "自动发布失败，等待重试";
  if (item.decision === "selected" && item.publication_authorized) return "已通过并授权，等待正式发布";
  if (item.decision === "selected") return item.decision_source === "legacy_v0" ? "历史已选，尚待本次确认" : "已选择，尚未授权发布";
  if (item.decision === "deferred") return "稍后再看";
  if (item.decision === "dismissed") return "不保留";
  return "未决";
}

function checkbox(checked, label) {
  return `- [${checked ? "x" : " "}] ${label}`;
}

function historicalReviewNotice(item) {
  const activeReviewPath = item.delivery?.active_review_path || null;
  return activeReviewPath
    ? `> 本页为历史快照；请在 [${path.basename(activeReviewPath)}](<${path.basename(activeReviewPath)}>) 完成审批。`
    : "> 本页为历史快照；本条当前没有活跃审批入口。";
}

function longReviewBlock(item, index, options = {}) {
  const preview = item.review_preview || {};
  const ready = preview.status === "ready";
  const actions = options.active === false ? [
    historicalReviewNotice(item)
  ] : [
    checkbox(item.decision === "selected" && item.publication_authorized, "正式入库（自动处理并发布）"),
    checkbox(item.decision === "deferred", "稍后再看（入库后 Later 7 天）"),
    checkbox(item.decision === "dismissed", "不保留")
  ];
  return [
    `<!-- rss-reading:item ${item.material_id} -->`,
    `### ${index}. ${item.title}`,
    "",
    item.item_url ? `[原文链接](${item.item_url})` : "原文链接：无",
    "",
    ...actions,
    "",
    `**当前状态**：${decisionLabel(item)}`,
    `**一句话核心**：${ready ? firstSentence(preview.core, 180) : "预览处理尚未完成，暂不建议审批。"}`,
    `**为什么值得读**：${ready ? `${humanValue(preview.value_level)}；${firstSentence(preview.value_reason, 180)}` : "待判断"}`,
    `**可能新增量**：${ready ? firstSentence(preview.novelty || preview.core, 180) : "待判断"}`,
    `**预计阅读成本**：${readingCost(item.meaningful_length)}`,
    `**建议读法**：${ready ? readingRoute(preview.continue_reading?.level) : "待判断"}`,
    item.legacy_decision_id ? `**历史记录**：旧账本中已有决定；为避免把历史勾选冒充当前发布授权，本次仍需明确勾选。` : "",
    "<!-- rss-reading:end -->"
  ].filter((line) => line !== "").join("\n");
}

function sourceBlockKind(item) {
  const messages = (item.source_errors || []).map((error) => compactText(error?.message));
  if (messages.includes("fetched_article_access_restricted_paid_subscribers")) return "paid_subscription_required";
  if (item.content_status === "fetch_failed") return "fulltext_fetch_failed";
  if (item.content_status === "fetch_required") return "fulltext_fetch_required";
  return "source_not_fulltext_ready";
}

function isActiveReviewAt(item, target) {
  if (!Object.prototype.hasOwnProperty.call(item.delivery || {}, "active_review_path")) return true;
  if (!item.delivery.active_review_path) return false;
  return path.resolve(item.delivery.active_review_path) === path.resolve(target);
}

function blockedReviewBlock(item, index) {
  const kind = sourceBlockKind(item);
  const explanation = kind === "paid_subscription_required"
    ? [
        "**阻塞原因**：正文仅对付费订阅者开放。",
        "来源层已核验公开文章页，但无法取得完整正文。系统没有使用 Feed 摘要冒充全文，因此当前不能生成阅读判断或入库。"
      ]
    : kind === "fulltext_fetch_failed"
      ? [
          "**阻塞原因**：公开正文补抓失败。",
          "来源层尚未取得可验证的完整正文，因此当前不能生成阅读判断或入库。"
        ]
      : [
          "**阻塞原因**：完整正文尚待来源层补抓。",
          "在正文通过来源合同前，本条不会参与内容判断或审批。"
        ];
  return [
    `<!-- rss-reading:item ${item.material_id} -->`,
    `### ${index}. ${item.title}`,
    "",
    item.item_url ? `[原文链接](${item.item_url})` : "原文链接：无",
    "",
    ...explanation,
    item.legacy_decision_id ? "历史账本中已有决定；该决定被保留，但不会绕过正文就绪门禁。" : "",
    "<!-- rss-reading:end -->"
  ].filter((line) => line !== "").join("\n");
}

function parseReadingSections(markdown) {
  const normalized = String(markdown || "").replace(/\r\n?/gu, "\n");
  const body = /(?:^|\n)## 正文\n([\s\S]*?)(?=\n---\n\n## 原文\n|\n## 原文\n|$)/u.exec(normalized)?.[1]?.trim() || "";
  const original = /(?:^|\n)## 原文\n([\s\S]*)$/u.exec(normalized)?.[1]?.trim() || "";
  const clean = (value) => value.replace(/^\^pr-[a-f0-9]{12}\s*$/gmu, "").replace(/\n{3,}/gu, "\n\n").trim();
  const translated = clean(body);
  const source = clean(original);
  const title = /^#\s+(.+)$/mu.exec(translated)?.[1]?.trim() || "";
  const withoutTitle = translated.replace(/^#\s+.+\n*/mu, "").trim();
  return { title, translated: withoutTitle, original: source };
}

function shortWeeklyBlock(item, index, language) {
  const preview = item.review_preview || {};
  const title = language === "zh" ? (preview.chinese_title || item.title) : item.title;
  const body = language === "zh" ? preview.chinese_body : preview.original_body;
  const linkLabel = language === "zh" ? "原文链接" : "Original";
  return [
    `#### ${index}. ${title}`,
    "",
    body || (preview.status === "ready" ? "本条没有可显示的正文。" : "本条预览处理尚未完成。"),
    "",
    item.item_url ? `[${linkLabel}](${item.item_url})` : ""
  ].filter((line) => line !== "").join("\n");
}

function parseSummaryDecisions(text, file) {
  const changes = [];
  const blocks = String(text || "").split(/(?=<!-- rss-reading:item )/gu).slice(1);
  for (const block of blocks) {
    const materialId = /<!-- rss-reading:item\s+([^\s>]+)\s+-->/u.exec(block)?.[1];
    if (!materialId) continue;
    const decisionMatches = [...block.matchAll(/^- 选择状态：([^\r\n]+)$/gmu)];
    const authMatches = [...block.matchAll(/^- 发布授权：([^\r\n]+)$/gmu)];
    if (decisionMatches.length || authMatches.length) {
      if (decisionMatches.length !== 1 || authMatches.length !== 1) throw new Error(`summary_state_not_unique:${file}:${materialId}`);
      const decision = decisionMatches[0][1].trim();
      const authorization = authMatches[0][1].trim().toLowerCase();
      if (!DECISIONS.has(decision)) throw new Error(`summary_decision_invalid:${file}:${materialId}:${decision}`);
      if (!new Set(["yes", "no"]).has(authorization)) throw new Error(`summary_authorization_invalid:${file}:${materialId}:${authorization}`);
      if (authorization === "yes" && decision !== "selected") throw new Error(`summary_authorization_requires_selected:${file}:${materialId}`);
      changes.push({ materialId, decision, publicationAuthorized: authorization === "yes", file });
      continue;
    }
    const actions = [
      { decision: "selected", authorize: true, pattern: /^- \[([ xX])\] 正式入库（(?:通过并授权|自动处理并发布)）$/gmu },
      { decision: "deferred", authorize: true, pattern: /^- \[([ xX])\] 稍后再看(?:（入库后 Later 7 天）)?$/gmu },
      { decision: "dismissed", authorize: false, pattern: /^- \[([ xX])\] 不保留$/gmu }
    ];
    const present = actions.map((action) => ({ ...action, matches: [...block.matchAll(action.pattern)] }));
    if (present.every((action) => action.matches.length === 0)) continue;
    if (present.some((action) => action.matches.length !== 1)) throw new Error(`summary_action_not_unique:${file}:${materialId}`);
    const checked = present.filter((action) => /[xX]/u.test(action.matches[0][1]));
    if (checked.length > 1) throw new Error(`summary_action_conflict:${file}:${materialId}`);
    if (checked.length === 0) continue;
    changes.push({ materialId, decision: checked[0].decision, publicationAuthorized: checked[0].authorize, file });
  }
  return changes;
}

async function ingestExistingSummaries(paths, ledger) {
  const recorded = [];
  const files = (await walkFiles(paths.summaryRoot)).filter((file) => /RSS (?:长文日报|长文周报|日报)\.md$/u.test(path.basename(file)));
  const byMaterial = new Map();
  for (const file of files) {
    const changes = parseSummaryDecisions(await fs.readFile(file, "utf8"), file);
    for (const change of changes) {
      if (!byMaterial.has(change.materialId)) byMaterial.set(change.materialId, []);
      byMaterial.get(change.materialId).push(change);
    }
  }
  for (const [materialId, changes] of byMaterial) {
    const item = ledger.items[materialId];
    if (!item) continue;
    if (Object.prototype.hasOwnProperty.call(item.delivery || {}, "active_review_path") && !item.delivery.active_review_path) continue;
    const activePath = item.delivery?.active_review_path ? path.resolve(item.delivery.active_review_path) : null;
    const activeChanges = activePath ? changes.filter((change) => path.resolve(change.file) === activePath) : changes;
    if (!activeChanges.length) continue;
    const currentSignature = `${item.decision}:${item.publication_authorized ? "yes" : "no"}`;
    const altered = new Map();
    for (const change of activeChanges) {
      const signature = `${change.decision}:${change.publicationAuthorized ? "yes" : "no"}`;
      if (signature !== currentSignature && !altered.has(signature)) altered.set(signature, change);
    }
    if (altered.size > 1) throw new Error(`summary_decision_conflict:${materialId}:${[...altered.keys()].join(",")}`);
    if (altered.size === 0) continue;
    const change = [...altered.values()][0];
    item.decision = change.decision;
    item.decision_source = "summary_markdown";
    item.decision_at = nowIso();
    item.publication_authorized = change.publicationAuthorized;
    item.publication_authorization_source = change.publicationAuthorized ? "summary_markdown" : null;
    addHistory(item, {
      type: "summary_decision_recorded",
      decision: item.decision,
      publication_authorized: item.publication_authorized,
      source: change.file
    });
    recorded.push({ material_id: materialId, decision: item.decision, source: change.file });
  }
  return recorded;
}

function consumerInstruction(mode, existing = "") {
  const shared = "用于渐进阅读 RSS 筛选。读者关注 RemNote、Codex、AI Agent、渐进阅读、卡片化沉淀和教育科技产品工作流；偏好高密度、可操作、可沉淀的材料，反感空泛总结和营销口号。只基于输入内容处理，不新增外部事实。";
  const task = mode === "short_aggregate"
    ? "这是短文周报条目：生成忠实、可直接阅读的中文译文，并清除订阅、推广、登录、分享等非正文尾巴；保留英文原文。"
    : mode === "publication"
      ? "这是用户已批准的正式阅读稿：执行标准工作流、必要翻译、阅读前置卡和洞察生成。"
      : mode === "long_review_excerpt"
        ? "这是长文筛选预览，输入是来源正文的有界节选而非全文；只根据节选生成判断。第一条洞察写一句话核心，第二条优先写本文可能提供的信息增量，第三条可写适用边界。"
        : "这是长文筛选预览。第一条洞察写一句话核心，第二条优先写本文可能提供的信息增量，第三条可写适用边界；帮助读者决定是否值得阅读全文。";
  return [compactText(existing), shared, task].filter(Boolean).join("\n\n");
}

function boundedScreeningExcerpt(markdown, maxLength = 6000) {
  const source = String(markdown || "").trim();
  if (source.length <= maxLength) return source;
  const headings = source.split(/\r?\n/gu).filter((line) => /^#{1,6}\s+\S/u.test(line)).join("\n").slice(0, 900);
  const opening = source.slice(0, 3900).replace(/\s+\S*$/u, "").trim();
  const ending = source.slice(-1200).replace(/^\S*\s+/u, "").trim();
  return [opening, headings ? `## 文章结构提示\n\n${headings}` : "", `## 结尾节选\n\n${ending}`].filter(Boolean).join("\n\n");
}

async function buildConsumerRequest(item, mode) {
  const request = await readJson(item.preprocess_request_path);
  if (!request) throw new Error(`preview_request_missing:${item.material_id}`);
  const workflowMode = mode === "long_review" ? "single_stage" : "standard";
  const material = mode === "long_review_excerpt"
    ? { ...request.material, markdown: boundedScreeningExcerpt(request.material?.markdown) }
    : request.material;
  return {
    ...request,
    material,
    user_instruction: consumerInstruction(mode, request.user_instruction),
    processing_options: {
      ...(request.processing_options || {}),
      workflow_mode: workflowMode,
      insight_soft_min: 1,
      insight_soft_max: 3,
      insight_safety_cap: 5
    }
  };
}

function reviewPreviewFromResult(item, result, request, evidence) {
  if (!result || !new Set(["completed", "idempotent_replay"]).has(result.status)) throw new Error(`preview_result_status_invalid:${item.material_id}`);
  if (result.processing_state !== "rendered" || result.artifacts?.target_zone !== "local-ir-reading") throw new Error(`preview_result_not_ready:${item.material_id}`);
  const semantic = result.artifacts?.semantic;
  const firstInsight = semantic?.insights?.[0];
  const secondInsight = semantic?.insights?.[1];
  if (!semantic?.judgments?.value || !firstInsight?.description) throw new Error(`preview_semantic_missing:${item.material_id}`);
  const preview = {
    schema_version: "progressive-reading.rss-review-preview/v1",
    preview_version: REVIEW_PREVIEW_VERSION,
    status: "ready",
    material_id: item.material_id,
    route: item.route,
    generated_at: nowIso(),
    source_request_path: item.preprocess_request_path,
    source_request_sha256: item.preprocess_request_sha256,
    consumer_request_sha256: evidence.consumerRequestSha256,
    result_path: evidence.resultPath,
    result_sha256: evidence.resultSha256,
    preview_variant: evidence.variant,
    processor_version: result.receipt?.processor_version || null,
    prompt_version: result.receipt?.prompt_version || null,
    translation_state: result.translation_state,
    core: firstSentence(firstInsight.description),
    novelty: firstSentence(secondInsight?.description || firstInsight.description),
    value_level: semantic.judgments.value.level,
    value_reason: compactText(semantic.judgments.value.reason),
    density_level: semantic.judgments.density?.level || null,
    continue_reading: semantic.judgments.continue_reading || null
  };
  if (item.route === "short_aggregate") {
    const sections = parseReadingSections(result.artifacts.reading_markdown);
    const sourceMarkdown = compactText(request.material?.markdown);
    if (!sections.translated || !/[\u3400-\u9fff]/u.test(sections.translated)) throw new Error(`preview_chinese_body_missing:${item.material_id}`);
    preview.chinese_title = sections.title || item.title;
    preview.chinese_body = sections.translated;
    preview.original_body = sections.original || sourceMarkdown;
  }
  return preview;
}

async function defaultPreviewRunner({ paths, request, outputDir }) {
  await fs.mkdir(outputDir, { recursive: true });
  const requestPath = path.join(outputDir, "consumer-request.json");
  await writeJson(requestPath, request);
  await runProcess(process.execPath, [
    paths.preprocessCli,
    "--json",
    "run",
    "--request", requestPath,
    "--output", outputDir,
    "--strict"
  ], { cwd: paths.workflowRoot, timeoutMs: 1200000 });
  return { result: await readJson(path.join(outputDir, "result.json")) };
}

async function ensureReviewPreview(paths, item, options = {}) {
  if (!item.eligible_for_preprocess || item.route === "blocked") {
    item.review_preview = { status: "blocked", reason: `source_not_ready_${item.content_status}` };
    return item.review_preview;
  }
  const variants = item.route === "long_review" ? ["long_review", "long_review_excerpt"] : [item.route];
  const runner = options.previewRunner || defaultPreviewRunner;
  const errors = [];
  for (const variant of variants) {
    const request = await buildConsumerRequest(item, variant);
    const consumerRequestSha256 = sha256(Buffer.from(JSON.stringify(request), "utf8"));
    const outputDir = path.join(paths.previewsRoot, item.material_id, consumerRequestSha256.slice(0, 16));
    const previewPath = path.join(outputDir, "preview.json");
    const resultPath = path.join(outputDir, "result.json");
    const cached = await readJson(previewPath);
    if (cached?.status === "ready" && cached.consumer_request_sha256 === consumerRequestSha256 && existsSync(cached.result_path)) {
      if (!cached.preview_variant) {
        cached.preview_variant = variant;
        await writeJson(previewPath, cached);
      }
      item.review_preview = cached;
      return cached;
    }
    const existingResult = await readJson(resultPath);
    if (existingResult && !(new Set(["completed", "idempotent_replay"]).has(existingResult.status)
      && existingResult.processing_state === "rendered" && existingResult.artifacts?.target_zone === "local-ir-reading")) {
      errors.push(`${variant}:${existingResult.status}:${existingResult.processing_state}`);
      continue;
    }
    try {
      const execution = existingResult ? { result: existingResult } : await runner({ paths, item, request, outputDir, variant });
      const result = execution?.result || await readJson(resultPath);
      if (!result) throw new Error(`preview_result_missing:${item.material_id}`);
      if (!existsSync(resultPath)) await writeJson(resultPath, result);
      const preview = reviewPreviewFromResult(item, result, request, {
        consumerRequestSha256,
        resultPath,
        resultSha256: await fileSha256(resultPath),
        variant
      });
      await writeJson(previewPath, preview);
      item.review_preview = preview;
      return preview;
    } catch (error) {
      errors.push(`${variant}:${error.message}`);
    }
  }
  throw new Error(`preview_variants_failed:${item.material_id}:${errors.join(" | ")}`);
}

async function ensureReviewPreviews(paths, items, options = {}) {
  const eligible = items.filter((item) => item.eligible_for_preprocess && item.route !== "blocked");
  const failures = [];
  let cursor = 0;
  let completed = 0;
  const concurrency = Math.max(1, Math.min(3, Number(options.previewConcurrency || 2)));
  async function worker() {
    while (cursor < eligible.length) {
      const index = cursor;
      cursor += 1;
      const item = eligible[index];
      try {
        await ensureReviewPreview(paths, item, options);
        completed += 1;
        options.onPreviewProgress?.({ completed, total: eligible.length, materialId: item.material_id, status: "ready" });
      } catch (error) {
        item.review_preview = { status: "failed", reason: error.message };
        failures.push({ material_id: item.material_id, error: error.message });
        completed += 1;
        options.onPreviewProgress?.({ completed, total: eligible.length, materialId: item.material_id, status: "failed", error: error.message });
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, eligible.length || 1) }, () => worker()));
  for (const item of items.filter((entry) => !entry.eligible_for_preprocess || entry.route === "blocked")) {
    await ensureReviewPreview(paths, item, options);
  }
  return { total: eligible.length, ready: eligible.length - failures.length, failures };
}

async function latestBatch(paths) {
  const files = (await walkFiles(paths.batchesRoot)).filter((file) => path.basename(file) === "run.json");
  const records = [];
  for (const file of files) records.push({ file, value: await readJson(file), mtime: (await fs.stat(file)).mtimeMs });
  records.sort((a, b) => b.mtime - a.mtime);
  return records[0] || null;
}

async function inventoryEvidence(paths) {
  const files = (await walkFiles(paths.batchesRoot)).filter((file) => path.basename(file) === "run.json");
  const records = [];
  for (const file of files) records.push({ file, value: await readJson(file), mtime: (await fs.stat(file)).mtimeMs });
  records.sort((a, b) => b.mtime - a.mtime);
  const bySubscription = new Map();
  for (const record of records) {
    for (const entry of record.value?.results || []) {
      if (!entry.ok || entry.result?.inventory_complete !== true || !entry.subscription_id) continue;
      if (!bySubscription.has(entry.subscription_id)) {
        bySubscription.set(entry.subscription_id, {
          subscription_id: entry.subscription_id,
          batch_id: record.value.batch_id || null,
          batch_path: record.file,
          item_count: entry.result.item_count,
          feed_item_count: entry.result.feed_item_count,
          run_id: entry.result.run_id || null
        });
      }
    }
  }
  return [...bySubscription.values()].sort((a, b) => a.subscription_id.localeCompare(b.subscription_id));
}

function sourceBatchHasCompleteInventory(batch) {
  if (!batch || !new Set(["completed", "completed_with_failures"]).has(batch.status)) return false;
  const results = Array.isArray(batch.results) ? batch.results : [];
  if (results.length !== Number(batch.subscription_count || 0) || Number(batch.failed || 0) !== 0) return false;
  if (!results.every((entry) => entry.ok === true
    && entry.result?.inventory_complete === true
    && new Set(["completed", "completed_with_failures"]).has(entry.result?.status))) return false;
  if (batch.status === "completed_with_failures") {
    return Number(batch.degraded || 0) > 0
      && results.some((entry) => entry.result?.status === "completed_with_failures");
  }
  return true;
}

function rssSourceReleaseIsCompatible(release) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/u.exec(String(release?.version || ""));
  if (!match) return false;
  const [, major, minor, patchVersion] = match.map(Number);
  const minimumSatisfied = major === 1 && (minor > 1 || (minor === 1 && patchVersion >= 1));
  return minimumSatisfied
    && release?.release_status === "released"
    && release?.schema_version === "progressive-reading.rss-source-release/v1"
    && release?.contract === "progressive-reading.rss-source-package/v1";
}

function blockedSourceStateIsExplained(item) {
  if (item.eligible || item.requestPath) return false;
  if (!new Set(["summary_only", "fetch_required", "fetch_failed"]).has(item.contentStatus)) return false;
  if (item.contentStatus !== "fetch_failed") return true;
  if (!item.errors.length) return false;
  const paidRestricted = item.errors.some((error) => error?.message === "fetched_article_access_restricted_paid_subscribers");
  if (!paidRestricted) return true;
  return Boolean(item.sourceEvidence?.raw_item_page
    && existsSync(item.sourceEvidence.raw_item_page)
    && item.sourceEvidence?.raw_item_page_response
    && existsSync(item.sourceEvidence.raw_item_page_response));
}

function groupBySource(items) {
  const grouped = new Map();
  for (const item of items) {
    const label = sourceLabel(item);
    if (!grouped.has(label)) grouped.set(label, []);
    grouped.get(label).push(item);
  }
  return grouped;
}

async function writeSummary(target, content, itemCount) {
  await fs.mkdir(path.dirname(target), { recursive: true });
  const normalized = `${String(content || "").trim()}\n`;
  await fs.writeFile(target, normalized, "utf8");
  return { path: target, sha256: sha256(normalized), item_count: itemCount };
}

async function renderDailySummary(target, date, longItems, blockedItems, shortCount) {
  const lines = [
    `# ${date} RSS 长文日报`,
    "",
    `本次增量有 ${longItems.length} 篇长文待筛选；${shortCount} 篇短文进入本周短文池；${blockedItems.length} 篇正文受来源限制或尚未就绪。`,
    "",
    "审批方式：每篇最多勾选一个动作。不操作即维持未决；“正式入库”会自动执行标准预处理并发布；“稍后再看”会先发布，再进入 Local IR Later 7 天。",
    ""
  ];
  if (!longItems.length) lines.push("本日没有新的长文候选。", "");
  for (const [source, sourceItems] of groupBySource(longItems)) {
    lines.push(`## ${source}`, "");
    sourceItems.forEach((item, index) => lines.push(longReviewBlock(item, index + 1, {
      active: isActiveReviewAt(item, target)
    }), ""));
  }
  if (blockedItems.length) {
    lines.push("## 正文受限或尚未就绪", "", "以下条目只保留可读的阻塞说明，不参与内容判断或审批。", "");
    blockedItems.forEach((item, index) => lines.push(blockedReviewBlock(item, index + 1), ""));
  }
  return writeSummary(target, lines.join("\n"), longItems.length + blockedItems.length);
}

async function renderShortWeekly(target, week, items) {
  const lines = [
    `# ${week} RSS 短文周报`,
    "",
    "本周短文已通过标准预处理生成中文主文，并保留 English Appendix 供原文核对。",
    "",
    "## 中文主文",
    ""
  ];
  if (!items.length) lines.push("本周没有可汇总的短文。", "");
  let number = 1;
  for (const [source, sourceItems] of groupBySource(items)) {
    lines.push(`### ${source}`, "");
    for (const item of sourceItems) {
      lines.push(shortWeeklyBlock(item, number, "zh"), "");
      number += 1;
    }
  }
  lines.push("## English Appendix", "");
  number = 1;
  for (const [source, sourceItems] of groupBySource(items)) {
    lines.push(`### ${source}`, "");
    for (const item of sourceItems) {
      lines.push(shortWeeklyBlock(item, number, "en"), "");
      number += 1;
    }
  }
  return writeSummary(target, lines.join("\n"), items.length);
}

async function renderLongWeekly(target, week, items, blockedItems = []) {
  const lines = [
    `# ${week} RSS 长文周报`,
    "",
    `本期汇总截至生成时仍未决定的 ${items.length} 篇长文。未操作条目会维持未决并滚入下一期。`,
    "",
    "每篇最多勾选一个动作：“正式入库”自动处理并发布；“稍后再看”先发布再进入 Local IR Later 7 天；“不保留”退出活跃报告，但决定仍保留在 review ledger 中并可追溯恢复。",
    ""
  ];
  if (!items.length) lines.push("本期没有活跃未决长文。", "");
  for (const [source, sourceItems] of groupBySource(items)) {
    lines.push(`## ${source}`, "");
    sourceItems.forEach((item, index) => lines.push(longReviewBlock(item, index + 1, { active: true }), ""));
  }
  if (blockedItems.length) {
    lines.push("## 正文受限或尚未就绪", "", "以下未决条目继续等待来源层解除阻塞，当前不能审批入库。", "");
    blockedItems.forEach((item, index) => lines.push(blockedReviewBlock(item, index + 1), ""));
  }
  return writeSummary(target, lines.join("\n"), items.length + blockedItems.length);
}

async function refreshHistoricalReviewNotices(paths, ledger) {
  if (!existsSync(paths.summaryRoot)) return { changed_files: [], changed_items: 0 };
  const entries = await fs.readdir(paths.summaryRoot, { withFileTypes: true });
  const changedFiles = [];
  let changedItems = 0;
  for (const entry of entries) {
    if (!entry.isFile() || !/^\d{4}-\d{2}-\d{2} RSS 日报\.md$/u.test(entry.name)) continue;
    const file = path.join(paths.summaryRoot, entry.name);
    const before = await fs.readFile(file, "utf8");
    const after = before.replace(/<!-- rss-reading:item\s+([^\s>]+)\s+-->[\s\S]*?<!-- rss-reading:end -->/gu, (block, materialId) => {
      if (!block.includes("应用筛选面板") && !block.includes("应用面板")) return block;
      const item = ledger.items?.[materialId];
      if (!item) return block;
      const replaced = block.replace(/^> 本页已成为历史快照；请在最新长文周报或应用筛选面板中操作。$/mu, historicalReviewNotice(item));
      if (replaced !== block) changedItems += 1;
      return replaced;
    });
    if (after === before) continue;
    await fs.writeFile(file, after, "utf8");
    changedFiles.push({ path: file, sha256: sha256(after) });
  }
  return { changed_files: changedFiles, changed_items: changedItems };
}

function uniqueItems(items) {
  return [...new Map(items.map((item) => [item.material_id, item])).values()];
}

export async function generateSummaries(workflowRoot = DEFAULT_WORKFLOW_ROOT, options = {}) {
  const date = options.date || localDate();
  const week = options.week || isoWeek();
  const mode = options.mode || "daily";
  if (!new Set(["daily", "weekly", "all"]).has(mode)) throw new Error(`generation_mode_invalid:${mode}`);
  const runDaily = mode === "daily" || mode === "all";
  const runWeekly = mode === "weekly" || mode === "all";
  let synced = await syncLedger(workflowRoot);
  const { paths } = synced;
  let ledger = synced.ledger;
  ledger.report_runs ||= { daily: {}, weekly: {} };
  ledger.report_runs.daily ||= {};
  ledger.report_runs.weekly ||= {};
  const ingestedDecisions = options.ingestSummaries !== false ? await ingestExistingSummaries(paths, ledger) : [];
  await writeJson(paths.ledgerPath, ledger);
  const decisionActions = { completed: [], failures: [] };
  if (options.executeDecisions !== false) {
    for (const change of ingestedDecisions.filter((item) => item.decision === "selected" || item.decision === "deferred")) {
      try {
        const result = await applyDecision(workflowRoot, change.material_id, change.decision, {
          source: "summary_markdown",
          runner: options.publicationRunner,
          date,
          vaultRoot: options.vaultRoot,
          sidecarRoot: options.sidecarRoot
        });
        decisionActions.completed.push({ material_id: change.material_id, decision: change.decision, status: result.status });
      } catch (error) {
        decisionActions.failures.push({ material_id: change.material_id, decision: change.decision, error: error.message });
      }
    }
    if (ingestedDecisions.length) {
      synced = await syncLedger(workflowRoot);
      ledger = synced.ledger;
    }
  }
  const catalogIds = new Set(synced.catalog.items.map((item) => item.materialId));
  const items = Object.values(ledger.items)
    .filter((item) => catalogIds.has(item.material_id))
    .sort((a, b) => String(b.published_at || b.fetched_at || "").localeCompare(String(a.published_at || a.fetched_at || "")) || a.title.localeCompare(b.title));
  const fulltextCount = items.filter((item) => item.eligible_for_preprocess).length;
  const blockedCount = items.length - fulltextCount;
  const dailyPath = path.join(paths.summaryRoot, `${date} RSS 日报.md`);
  const longWeeklyPath = path.join(paths.summaryRoot, `${week} RSS 长文周报.md`);
  const shortWeeklyPath = path.join(paths.shortWeeklyRoot, `${week} RSS 短文周报.md`);

  if (runDaily) {
    for (const item of items) {
      const delivery = item.delivery ||= {};
      if (item.route === "long_review" && delivery.long_daily_revision !== item.source_revision) {
        delivery.daily_report_key = date;
        delivery.daily_report_path = dailyPath;
        delivery.active_review_path = dailyPath;
      } else if (item.route === "blocked" && delivery.blocked_daily_revision !== item.source_revision) {
        delivery.blocked_report_key = date;
        delivery.blocked_report_path = dailyPath;
      }
    }
  }

  const dailyItems = runDaily ? items.filter((item) => item.route === "long_review" && item.delivery?.daily_report_key === date) : [];
  const dailyBlocked = runDaily ? items.filter((item) => item.route === "blocked" && item.delivery?.blocked_report_key === date) : [];
  const pendingShort = runWeekly ? items.filter((item) => item.route === "short_aggregate" && item.delivery?.short_weekly_revision !== item.source_revision) : [];
  const weeklyLong = runWeekly ? items.filter((item) => item.route === "long_review" && item.decision === "unresolved" && item.eligible_for_preprocess) : [];
  const weeklyBlocked = runWeekly ? items.filter((item) => item.route === "blocked" && item.decision === "unresolved") : [];
  const previewTargets = uniqueItems([...dailyItems, ...pendingShort, ...weeklyLong]);
  const preview = await ensureReviewPreviews(paths, previewTargets, options);
  const legacyCounts = ledger.legacy_import.counts;
  const batch = await latestBatch(paths);
  const legacyOutputMigration = await verifiedLegacyManifest(paths) || {
    status: "not_migrated",
    file_count: 0,
    target_root: paths.legacySummaryArchiveRoot
  };
  const preservedShortWeeklies = await preservedHistoricalShortWeeklyEvidence(paths, legacyOutputMigration);
  const generatedAt = nowIso();
  let daily = null;
  let longWeekly = null;
  let shortWeekly = null;
  if (runDaily && (dailyItems.length || dailyBlocked.length)) {
    daily = await renderDailySummary(dailyPath, date, dailyItems, dailyBlocked, items.filter((item) => item.route === "short_aggregate" && item.delivery?.short_weekly_revision !== item.source_revision).length);
    for (const item of dailyItems) item.delivery.long_daily_revision = item.source_revision;
    for (const item of dailyBlocked) item.delivery.blocked_daily_revision = item.source_revision;
    ledger.report_runs.daily[date] = { path: daily.path, sha256: daily.sha256, generated_at: generatedAt };
  }
  if (runWeekly) {
    const readyShort = pendingShort.filter((item) => item.review_preview?.status === "ready");
    if (readyShort.length) {
      shortWeekly = await renderShortWeekly(shortWeeklyPath, week, readyShort);
      for (const item of readyShort) {
        item.delivery.short_weekly_revision = item.source_revision;
        item.delivery.short_weekly_key = week;
        item.delivery.short_weekly_path = shortWeekly.path;
      }
    }
    if (weeklyLong.length || weeklyBlocked.length) {
      const supersededDailyPaths = new Set(weeklyLong
        .map((item) => item.delivery?.active_review_path)
        .filter((target) => target && /RSS 日报\.md$/u.test(path.basename(target))));
      for (const item of weeklyLong) {
        item.delivery.active_review_path = longWeeklyPath;
        item.delivery.long_weekly_key = week;
      }
      longWeekly = await renderLongWeekly(longWeeklyPath, week, weeklyLong, weeklyBlocked);
      for (const supersededPath of supersededDailyPaths) {
        const reportDate = /^(\d{4}-\d{2}-\d{2}) RSS 日报\.md$/u.exec(path.basename(supersededPath))?.[1];
        if (!reportDate) continue;
        const assignedLong = items.filter((item) => item.route === "long_review" && item.delivery?.daily_report_path === supersededPath);
        const assignedBlocked = items.filter((item) => item.route === "blocked" && item.delivery?.blocked_report_path === supersededPath);
        const rewritten = await renderDailySummary(supersededPath, reportDate, assignedLong, assignedBlocked, 0);
        if (daily && path.resolve(daily.path) === path.resolve(supersededPath)) daily = rewritten;
        ledger.report_runs.daily[reportDate] = { path: rewritten.path, sha256: rewritten.sha256, generated_at: generatedAt, superseded_by: longWeeklyPath };
      }
    }
    ledger.report_runs.weekly[week] = {
      generated_at: generatedAt,
      short_weekly: shortWeekly ? { path: shortWeekly.path, sha256: shortWeekly.sha256 } : null,
      long_weekly: longWeekly ? { path: longWeekly.path, sha256: longWeekly.sha256 } : null
    };
  }
  const supersededWeekly = runWeekly
    ? await archiveSupersededWeeklySummary(paths, week)
    : { status: "not_checked", verified: true };
  const historicalNoticeRefresh = await refreshHistoricalReviewNotices(paths, ledger);
  ledger.updated_at = nowIso();
  await writeJson(paths.ledgerPath, ledger);
  const runId = `${date.replaceAll("-", "")}-${randomUUID().slice(0, 8)}`;
  const receipt = {
    schema_version: "progressive-reading.rss-summary-generation/v1",
    status: decisionActions.failures.length
      ? "completed_with_decision_failures"
      : preview.failures.length ? "completed_with_preview_failures" : "completed",
    run_id: runId,
    generated_at: generatedAt,
    inputs: {
      package_count: items.length,
      fulltext_ready: fulltextCount,
      blocked: blockedCount,
      latest_batch_path: batch?.file || null,
      latest_batch_status: batch?.value?.status || null,
      legacy_ledger_path: paths.legacyLedgerPath,
      legacy_ledger_sha256: ledger.legacy_import.source_sha256
    },
    legacy_conservation: legacyCounts,
    review_previews: preview,
    decision_actions: decisionActions,
    legacy_output_migration: {
      manifest_path: paths.legacyOutputManifestPath,
      status: legacyOutputMigration.status,
      file_count: legacyOutputMigration.file_count,
      target_root: legacyOutputMigration.target_root
    },
    preserved_historical_short_weeklies: preservedShortWeeklies,
    superseded_weekly_report: supersededWeekly,
    historical_review_notice_refresh: historicalNoticeRefresh,
    mode,
    outputs: {
      daily,
      long_weekly: longWeekly,
      short_weekly: shortWeekly,
      ledger: { path: paths.ledgerPath, sha256: await fileSha256(paths.ledgerPath) }
    },
    writes: {
      summaries_only_under_summary_root: true,
      short_weekly_under_reading_root: Boolean(shortWeekly),
      long_publication: false,
      upstream_source: false,
      remnote: false,
      logseq: false,
      browser: false
    }
  };
  const receiptPath = path.join(paths.runsRoot, runId, "receipt.json");
  await writeJson(receiptPath, receipt);
  return { ...receipt, receipt_path: receiptPath };
}

export async function setDecision(workflowRoot, materialId, decision, options = {}) {
  if (!DECISIONS.has(decision)) throw new Error(`decision_invalid:${decision}`);
  const { paths, ledger } = await syncLedger(workflowRoot);
  const item = ledger.items[materialId];
  if (!item) throw new Error(`material_not_found:${materialId}`);
  const authorize = Boolean(options.authorize);
  if (authorize && decision !== "selected") throw new Error("publication_authorization_requires_selected");
  item.decision = decision;
  item.decision_source = options.source || "summary_panel";
  item.decision_at = nowIso();
  item.publication_authorized = authorize;
  item.publication_authorization_source = authorize ? (options.source || "summary_panel") : null;
  addHistory(item, {
    type: "decision_recorded",
    decision,
    publication_authorized: authorize,
    source: options.source || "summary_panel"
  });
  ledger.updated_at = nowIso();
  await writeJson(paths.ledgerPath, ledger);
  return item;
}

export function publicationGate(item) {
  if (!item) return { allowed: false, reason: "material_not_found" };
  if (item.decision !== "selected") return { allowed: false, reason: `decision_${item.decision}` };
  if (!item.publication_authorized) return { allowed: false, reason: "summary_publication_not_authorized" };
  if (!new Set(["summary_markdown", "summary_panel", "isolated_test"]).has(item.publication_authorization_source)) {
    return { allowed: false, reason: "authorization_source_invalid" };
  }
  if (!item.eligible_for_preprocess || item.content_status !== "fulltext_ready" || !item.preprocess_request_path) {
    return { allowed: false, reason: `source_not_ready_${item.content_status}` };
  }
  return { allowed: true, reason: "selected_and_authorized" };
}

function runProcess(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: options.cwd, env: process.env, windowsHide: true });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("pr_preprocess_timeout"));
    }, options.timeoutMs || 900000);
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error(`pr_preprocess_exit_${code}:${stderr || stdout}`));
      else resolve({ code, stdout, stderr });
    });
  });
}

function parseCommandJson(stdout, label) {
  try {
    return JSON.parse(String(stdout || "").trim());
  } catch {
    throw new Error(`${label}_json_invalid`);
  }
}

async function validatePreprocessInputs(paths, catalog) {
  if (!existsSync(paths.preprocessCli)) throw new Error("pr_preprocess_cli_missing");
  const doctorRun = await runProcess(process.execPath, [paths.preprocessCli, "--json", "doctor"], {
    cwd: paths.workflowRoot,
    timeoutMs: 180000
  });
  const doctor = parseCommandJson(doctorRun.stdout, "pr_preprocess_doctor");
  const validations = [];
  for (const item of catalog.items.filter((entry) => entry.eligible)) {
    try {
      const validationRun = await runProcess(process.execPath, [
        paths.preprocessCli,
        "--json",
        "validate",
        "--request",
        item.requestPath
      ], { cwd: paths.workflowRoot, timeoutMs: 180000 });
      const value = parseCommandJson(validationRun.stdout, "pr_preprocess_validate");
      validations.push({ material_id: item.materialId, request_path: item.requestPath, valid: value.ok === true && value.valid === true, error: null });
    } catch (error) {
      validations.push({ material_id: item.materialId, request_path: item.requestPath, valid: false, error: error.message });
    }
  }
  return {
    doctor: {
      ok: doctor.ok === true,
      ready: doctor.ready === true,
      interface_version: doctor.interface_version || null,
      processor_version: doctor.versions?.processor || null,
      request_schema: doctor.schemas?.request || null,
      result_schema: doctor.schemas?.result || null
    },
    validations
  };
}

async function defaultPreprocessRunner({ paths, item, outputDir, publishPath }) {
  const request = await buildConsumerRequest(item, "publication");
  const requestPath = path.join(outputDir, "consumer-request.json");
  await writeJson(requestPath, request);
  const args = [
    paths.preprocessCli,
    "--json",
    "run",
    "--request", requestPath,
    "--output", outputDir,
    "--publish", publishPath,
    "--strict"
  ];
  return runProcess(process.execPath, args, { cwd: paths.workflowRoot, timeoutMs: 1200000 });
}

export async function publishSelected(workflowRoot, materialId, options = {}) {
  const synced = await syncLedger(workflowRoot);
  const { paths, ledger } = synced;
  const item = ledger.items[materialId];
  const gate = publicationGate(item);
  if (!gate.allowed) throw new Error(`publication_gate_rejected:${gate.reason}`);
  if (item.publication?.status === "published" && existsSync(item.publication.path)) {
    const existingHash = await fileSha256(item.publication.path);
    if (existingHash === item.publication.sha256) {
      return { status: "already_published", material_id: materialId, path: item.publication.path, sha256: existingHash };
    }
  }
  await fs.mkdir(paths.readingRoot, { recursive: true });
  const publishPath = path.join(paths.readingRoot, `${safeTitle(item.title, materialId)}.md`);
  const relative = path.relative(paths.readingRoot, publishPath);
  if (relative.startsWith("..") || path.isAbsolute(relative) || path.dirname(relative) !== ".") throw new Error("publication_path_not_flat_rss");
  const outputDir = path.join(paths.preprocessRoot, materialId);
  await fs.mkdir(outputDir, { recursive: true });
  const runner = options.runner || defaultPreprocessRunner;
  await runner({ paths, item, outputDir, publishPath });
  const resultPath = path.join(outputDir, "result.json");
  const publicationPath = path.join(outputDir, "publication.json");
  const result = await readJson(resultPath);
  const publication = await readJson(publicationPath);
  if (!result || !publication) throw new Error("publication_receipts_missing");
  if (!new Set(["completed", "idempotent_replay"]).has(result.status)) throw new Error(`publication_result_status_invalid:${result.status}`);
  if (result.processing_state !== "rendered") throw new Error(`publication_processing_state_invalid:${result.processing_state}`);
  if (result.artifacts?.target_zone !== "local-ir-reading") throw new Error(`publication_target_zone_invalid:${result.artifacts?.target_zone}`);
  if (publication.status !== "published") throw new Error(`publication_status_invalid:${publication.status}`);
  if (publication.cleanliness?.valid !== true) throw new Error("publication_cleanliness_invalid");
  if (path.resolve(publication.markdown?.path || "") !== path.resolve(publishPath)) throw new Error("publication_path_receipt_mismatch");
  const actualHash = await fileSha256(publishPath);
  if (actualHash !== publication.markdown?.sha256) throw new Error("publication_hash_mismatch");
  item.publication = {
    status: "published",
    published_at: nowIso(),
    path: publishPath,
    sha256: actualHash,
    result_path: resultPath,
    publication_path: publicationPath,
    result_status: result.status
  };
  addHistory(item, { type: "published", path: publishPath, sha256: actualHash, source: item.publication_authorization_source });
  ledger.updated_at = nowIso();
  await writeJson(paths.ledgerPath, ledger);
  return { status: "published", material_id: materialId, path: publishPath, sha256: actualHash, result_path: resultPath, publication_path: publicationPath };
}

export async function writeLocalIrLaterHandoff(workflowRoot, materialId, options = {}) {
  const synced = await syncLedger(workflowRoot);
  const { paths, ledger } = synced;
  const item = ledger.items[materialId];
  if (!item?.publication?.path || item.publication.status !== "published") throw new Error("later_requires_published_material");
  if (!existsSync(item.publication.path)) throw new Error("later_publication_file_missing");
  const date = options.date || localDate();
  const deferUntil = options.deferUntil || addLocalDays(date, 7);
  const vaultRoot = path.resolve(options.vaultRoot || path.join(paths.workflowRoot, "..", ".."));
  const relativeMarkdownPath = path.relative(vaultRoot, item.publication.path).replaceAll("\\", "/");
  if (!relativeMarkdownPath || relativeMarkdownPath.startsWith("../") || path.isAbsolute(relativeMarkdownPath)) throw new Error("later_markdown_not_in_vault");
  const stateRoot = path.resolve(options.sidecarRoot || paths.localIrStateRoot);
  const sidecarPath = path.join(stateRoot, `${path.basename(item.publication.path)}.browser-ir.json`);
  const committedAt = nowIso();
  const state = {
    schema: "local-ir.document-state",
    schemaVersion: 1,
    document: {
      id: `rss-${materialId}`,
      path: relativeMarkdownPath,
      title: item.title,
      sourceUrl: item.item_url || "",
      sourceType: "rss",
      status: "later",
      deferUntil,
      revision: 1,
      createdAt: item.publication.published_at || committedAt,
      updatedAt: committedAt,
      handoff: { direction: "browser_to_obsidian", state: "ready", owner: "obsidian", committedAt }
    },
    content: {
      markdownSha256: await fileSha256(item.publication.path),
      rawMarkdownSha256: item.preprocess_request_sha256 || "",
      conversionMethod: "rss-pr-preprocess"
    },
    annotations: [],
    articleMusing: null,
    qaCards: [],
    browser: {
      destination: "reading",
      userInstruction: "",
      sourceMetadata: { source_url: item.item_url || "", source_title: item.title },
      completionIntent: null
    }
  };
  await writeJson(sidecarPath, state);
  const verified = await readJson(sidecarPath);
  if (verified?.document?.status !== "later" || verified?.document?.deferUntil !== deferUntil || verified?.document?.path !== relativeMarkdownPath) {
    throw new Error("local_ir_later_handoff_verification_failed");
  }
  item.decision = "deferred";
  item.decision_at = committedAt;
  item.publication_authorized = false;
  item.publication_authorization_source = null;
  item.later = { status: "handoff_ready", defer_until: deferUntil, sidecar_path: sidecarPath, document_path: relativeMarkdownPath, written_at: committedAt };
  item.delivery ||= {};
  item.delivery.active_review_path = null;
  addHistory(item, { type: "local_ir_later_handoff_written", defer_until: deferUntil, sidecar_path: sidecarPath });
  ledger.updated_at = nowIso();
  await writeJson(paths.ledgerPath, ledger);
  return { status: "later_handoff_ready", material_id: materialId, defer_until: deferUntil, sidecar_path: sidecarPath, document_path: relativeMarkdownPath };
}

export async function applyDecision(workflowRoot, materialId, decision, options = {}) {
  if (!DECISIONS.has(decision)) throw new Error(`decision_invalid:${decision}`);
  if (decision === "unresolved" || decision === "dismissed") {
    return setDecision(workflowRoot, materialId, decision, { source: options.source || "summary_panel" });
  }
  const requestedDecision = decision;
  await setDecision(workflowRoot, materialId, "selected", {
    authorize: true,
    source: options.source || "summary_panel"
  });
  try {
    const publication = await publishSelected(workflowRoot, materialId, { runner: options.runner });
    if (requestedDecision === "deferred") {
      const later = await writeLocalIrLaterHandoff(workflowRoot, materialId, {
        date: options.date,
        vaultRoot: options.vaultRoot,
        sidecarRoot: options.sidecarRoot
      });
      return { status: "published_and_deferred", material_id: materialId, publication, later };
    }
    const synced = await syncLedger(workflowRoot);
    const item = synced.ledger.items[materialId];
    item.delivery ||= {};
    item.delivery.active_review_path = null;
    item.requested_action = null;
    await writeJson(synced.paths.ledgerPath, synced.ledger);
    return { status: "published", material_id: materialId, publication };
  } catch (error) {
    const synced = await syncLedger(workflowRoot);
    const item = synced.ledger.items[materialId];
    item.requested_action = requestedDecision;
    item.publication_failure = { at: nowIso(), error: error.message };
    addHistory(item, { type: "publication_failed", requested_decision: requestedDecision, error: error.message });
    await writeJson(synced.paths.ledgerPath, synced.ledger);
    throw error;
  }
}

async function snapshotTopLevelMarkdown(root) {
  if (!existsSync(root)) return [];
  const entries = await fs.readdir(root, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    const file = path.join(root, entry.name);
    files.push({ path: file, sha256: await fileSha256(file) });
  }
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

export async function runCanary(workflowRoot = DEFAULT_WORKFLOW_ROOT, options = {}) {
  const paths = workflowPaths(workflowRoot);
  const readingBefore = await snapshotTopLevelMarkdown(paths.readingRoot);
  const generation = await generateSummaries(workflowRoot, options);
  const readingAfter = await snapshotTopLevelMarkdown(paths.readingRoot);
  const ledger = await loadLedger(workflowRoot);
  const catalog = await scanCatalog(workflowRoot);
  const legacyManifest = await verifiedLegacyManifest(paths);
  const preservedShortWeeklies = await preservedHistoricalShortWeeklyEvidence(paths, legacyManifest);
  const latest = await latestBatch(paths);
  const inventory = await inventoryEvidence(paths);
  const preprocessValidation = options.validatePreprocess === false
    ? { skipped: true, doctor: null, validations: [] }
    : await validatePreprocessInputs(paths, catalog);
  const currentDate = options.date || localDate();
  const currentWeek = options.week || isoWeek();
  const dailyPath = path.join(paths.summaryRoot, `${currentDate} RSS 日报.md`);
  const longWeeklyPath = path.join(paths.summaryRoot, `${currentWeek} RSS 长文周报.md`);
  const shortWeeklyPath = path.join(paths.shortWeeklyRoot, `${currentWeek} RSS 短文周报.md`);
  const dailyText = existsSync(dailyPath) ? await fs.readFile(dailyPath, "utf8") : "";
  const longWeeklyText = existsSync(longWeeklyPath) ? await fs.readFile(longWeeklyPath, "utf8") : "";
  const shortWeeklyText = existsSync(shortWeeklyPath) ? await fs.readFile(shortWeeklyPath, "utf8") : "";
  const outsideFiles = (await walkFiles(paths.workflowRoot)).filter((file) => {
    if (file.endsWith(`${currentDate} RSS 日报.md`) || file.endsWith(`${currentWeek} RSS 长文周报.md`)) {
      const relative = path.relative(paths.summaryRoot, file);
      return relative.startsWith("..") || path.isAbsolute(relative);
    }
    if (file.endsWith(`${currentWeek} RSS 短文周报.md`)) {
      const relative = path.relative(paths.shortWeeklyRoot, file);
      return relative.startsWith("..") || path.isAbsolute(relative);
    }
    return false;
  });
  const blockedCatalogItems = catalog.items.filter((item) => !item.eligible);
  const paidRestrictedItems = blockedCatalogItems.filter((item) => item.errors.some((error) => error?.message === "fetched_article_access_restricted_paid_subscribers"));
  const dailyLongFormat = /\*\*一句话核心\*\*：/u.test(dailyText)
    && /\*\*为什么值得读\*\*：/u.test(dailyText)
    && /\*\*可能新增量\*\*：/u.test(dailyText)
    && /\*\*预计阅读成本\*\*：/u.test(dailyText)
    && /\*\*建议读法\*\*：/u.test(dailyText);
  const checks = {
    fulltext_ready_packages_present: catalog.items.some((item) => item.eligible),
    daily_exists_in_summary_root: existsSync(dailyPath),
    long_weekly_exists_in_summary_root: existsSync(longWeeklyPath),
    short_weekly_exists_in_reading_root: existsSync(shortWeeklyPath),
    all_required_previews_ready: generation.review_previews?.failures?.length === 0
      && generation.review_previews?.ready === generation.review_previews?.total,
    daily_human_review_format: (dailyLongFormat || /本日没有新的长文候选/u.test(dailyText))
      && !/保持未决/u.test(dailyText)
      && !/(?:Material ID|来源状态：|产品分流：|内容长度：|处理门禁：)/u.test(dailyText),
    blocked_source_states_explained: blockedCatalogItems.every(blockedSourceStateIsExplained),
    paid_restrictions_human_readable: paidRestrictedItems.length === 0
      || (/正文仅对付费订阅者开放/u.test(dailyText)
        && !/fetched_article_access_restricted_paid_subscribers/u.test(dailyText)),
    long_weekly_rolls_all_active_unresolved: /RSS 长文周报/u.test(longWeeklyText)
      && /- \[[ xX]\] 正式入库（自动处理并发布）/u.test(longWeeklyText)
      && !/保持未决/u.test(longWeeklyText),
    short_weekly_human_reading_format: /## 中文主文/u.test(shortWeeklyText)
      && /## English Appendix/u.test(shortWeeklyText)
      && !/rss-reading:item|正式入库|稍后再看|不保留/u.test(shortWeeklyText)
      && !/(?:Material ID|来源状态：|产品分流：|内容长度：|处理门禁：)/u.test(shortWeeklyText),
    current_reports_in_authorized_zones: outsideFiles.length === 0,
    no_unapproved_flat_long_publication: JSON.stringify(readingBefore) === JSON.stringify(readingAfter),
    legacy_total_22: ledger.legacy_import?.counts?.total === 22,
    legacy_selected_14: ledger.legacy_import?.counts?.selected === 14,
    legacy_unresolved_8: ledger.legacy_import?.counts?.unresolved === 8,
    legacy_output_archive_hashes_match: generation.legacy_output_migration.status === "completed",
    preserved_historical_short_weeklies_verified: preservedShortWeeklies.length > 0
      && preservedShortWeeklies.every((item) => item.exists && item.verified),
    superseded_current_weekly_removed_after_verified_archive: !existsSync(path.join(paths.summaryRoot, `${currentWeek} RSS 周报.md`))
      && generation.superseded_weekly_report?.verified === true,
    unresolved_gate_rejected: publicationGate({ decision: "unresolved" }).allowed === false,
    selected_without_summary_authorization_rejected: publicationGate({ decision: "selected", publication_authorized: false }).allowed === false,
    selected_authorized_ready_gate_allowed: publicationGate({ decision: "selected", publication_authorized: true, publication_authorization_source: "isolated_test", eligible_for_preprocess: true, content_status: "fulltext_ready", preprocess_request_path: "fixture" }).allowed === true,
    latest_source_batch_has_complete_inventory: sourceBatchHasCompleteInventory(latest?.value),
    all_subscriptions_have_complete_inventory: inventory.length >= Number(latest?.value?.subscription_count || 1),
    ...(preprocessValidation.skipped ? {} : {
      pr_preprocess_ready: preprocessValidation.doctor?.ok === true && preprocessValidation.doctor?.ready === true,
      all_fulltext_requests_validate: preprocessValidation.validations.length === catalog.items.filter((item) => item.eligible).length
        && preprocessValidation.validations.every((item) => item.valid)
    }),
    ...(options.expectedPackages === undefined ? {} : { expected_package_count: catalog.items.length === Number(options.expectedPackages) }),
    ...(options.expectedFulltext === undefined ? {} : { expected_fulltext_ready_count: catalog.items.filter((item) => item.eligible).length === Number(options.expectedFulltext) }),
    ...(options.expectedBlocked === undefined ? {} : { expected_blocked_count: catalog.items.filter((item) => !item.eligible).length === Number(options.expectedBlocked) }),
    ...(options.expectedLegacyOutputs === undefined ? {} : { expected_legacy_output_count: generation.legacy_output_migration.file_count >= Number(options.expectedLegacyOutputs) })
  };
  const blockingChecks = Object.entries(checks).filter(([, value]) => !value).map(([name]) => name);
  const canaryId = `${currentDate.replaceAll("-", "")}-${randomUUID().slice(0, 8)}`;
  const receipt = {
    schema_version: CANARY_SCHEMA,
    status: blockingChecks.length ? "blocked" : "passed",
    canary_id: canaryId,
    verified_at: nowIso(),
    checks,
    blocking_checks: blockingChecks,
    catalog: {
      package_count: catalog.items.length,
      fulltext_ready: catalog.items.filter((item) => item.eligible).length,
      blocked: blockedCatalogItems.length,
      blocked_items: blockedCatalogItems.map((item) => ({
        material_id: item.materialId,
        content_status: item.contentStatus,
        reason: sourceBlockKind({ content_status: item.contentStatus, source_errors: item.errors }),
        raw_item_page_exists: Boolean(item.sourceEvidence?.raw_item_page && existsSync(item.sourceEvidence.raw_item_page)),
        raw_item_page_response_exists: Boolean(item.sourceEvidence?.raw_item_page_response && existsSync(item.sourceEvidence.raw_item_page_response))
      }))
    },
    source_batch: latest ? { path: latest.file, status: latest.value?.status, batch_id: latest.value?.batch_id || null } : null,
    complete_inventory_evidence: inventory,
    preserved_historical_short_weeklies: preservedShortWeeklies,
    preprocess_validation: preprocessValidation,
    outputs: { daily: dailyPath, long_weekly: longWeeklyPath, short_weekly: shortWeeklyPath, generation_receipt: generation.receipt_path, ledger: paths.ledgerPath },
    reading_area_before: readingBefore,
    reading_area_after: readingAfter,
    unexpected_summary_files: outsideFiles
  };
  const receiptPath = path.join(paths.canaryRoot, canaryId, "verification.json");
  await writeJson(receiptPath, receipt);
  return { ...receipt, receipt_path: receiptPath };
}

export async function getStatus(workflowRoot = DEFAULT_WORKFLOW_ROOT) {
  const catalog = await scanCatalog(workflowRoot);
  const ledger = existsSync(catalog.paths.ledgerPath) ? await loadLedger(workflowRoot) : null;
  const latest = await latestBatch(catalog.paths);
  const reviewItems = ledger ? Object.values(ledger.items).filter((item) => item.route !== "short_aggregate") : [];
  const decisions = reviewItems.reduce((acc, item) => {
    acc[item.decision] = (acc[item.decision] || 0) + 1;
    return acc;
  }, {});
  return {
    status: "ok",
    package_count: catalog.items.length,
    fulltext_ready: catalog.items.filter((item) => item.eligible).length,
    blocked: catalog.items.filter((item) => !item.eligible).length,
    long_review_count: reviewItems.length,
    short_weekly_count: ledger ? Object.values(ledger.items).filter((item) => item.route === "short_aggregate").length : 0,
    decisions,
    legacy_conservation: ledger?.legacy_import?.counts || null,
    latest_batch: latest ? { path: latest.file, status: latest.value?.status, batch_id: latest.value?.batch_id || null } : null,
    paths: { summary_root: catalog.paths.summaryRoot, ledger: catalog.paths.ledgerPath, reading_root: catalog.paths.readingRoot }
  };
}

export async function getQueue(workflowRoot = DEFAULT_WORKFLOW_ROOT) {
  const synced = await syncLedger(workflowRoot);
  const activeIds = new Set(synced.catalog.items.map((item) => item.materialId));
  const items = Object.values(synced.ledger.items)
    .filter((item) => activeIds.has(item.material_id) && item.route !== "short_aggregate")
    .sort((a, b) => String(b.published_at || b.fetched_at || "").localeCompare(String(a.published_at || a.fetched_at || "")) || a.title.localeCompare(b.title))
    .map((item) => ({
      material_id: item.material_id,
      title: item.title,
      item_url: item.item_url,
      published_at: item.published_at,
      content_status: item.content_status,
      route: item.route,
      meaningful_length: item.meaningful_length,
      decision: item.decision,
      publication_authorized: item.publication_authorized,
      publication: item.publication,
      publication_failure: item.publication_failure || null,
      later: item.later || null,
      active_review_path: item.delivery?.active_review_path || null,
      legacy_decision_id: item.legacy_decision_id,
      review_preview: item.review_preview ? {
        status: item.review_preview.status,
        core: item.review_preview.core ? firstSentence(item.review_preview.core, 180) : null,
        value_level: item.review_preview.value_level || null,
        value_reason: item.review_preview.value_reason ? firstSentence(item.review_preview.value_reason, 180) : null,
        novelty: item.review_preview.novelty ? firstSentence(item.review_preview.novelty, 180) : null,
        reading_cost: readingCost(item.meaningful_length),
        suggested_route: readingRoute(item.review_preview.continue_reading?.level),
        chinese_title: item.review_preview.chinese_title || null,
        chinese_excerpt: item.review_preview.chinese_body ? firstSentence(item.review_preview.chinese_body, 240) : null
      } : null
    }));
  return { status: "ok", item_count: items.length, items };
}

export async function runClearanceAudit(workflowRoot = DEFAULT_WORKFLOW_ROOT) {
  const paths = workflowPaths(workflowRoot);
  const activeFiles = [
    path.join(paths.workflowRoot, "package.json"),
    path.join(paths.workflowRoot, "scripts", "progressive-reading-app.mjs"),
    path.join(paths.workflowRoot, "README.md"),
    path.join(paths.workflowRoot, "docs", "RSS_WORKFLOW.md"),
    path.join(paths.workflowRoot, "rss-reading", "core.mjs"),
    path.join(paths.workflowRoot, "rss-reading", "cli.mjs")
  ];
  const activeText = (await Promise.all(activeFiles.map((file) => fs.readFile(file, "utf8")))).join("\n");
  const packageJson = await readJson(path.join(paths.workflowRoot, "package.json"));
  const appText = await fs.readFile(path.join(paths.workflowRoot, "scripts", "progressive-reading-app.mjs"), "utf8");
  const coreText = await fs.readFile(path.join(paths.workflowRoot, "rss-reading", "core.mjs"), "utf8");
  const generateBody = /export async function generateSummaries[\s\S]*?(?=export async function setDecision)/u.exec(coreText)?.[0] || "";
  const release = await readJson(path.join(paths.workflowRoot, "rss-source", "release.json"));
  const ledger = await loadLedger(workflowRoot);
  const migration = await verifiedLegacyManifest(paths);
  const preservedHistoricalShortWeeklies = await preservedHistoricalShortWeeklyEvidence(paths, migration);
  const activeSupersededWeeklyFiles = (await fs.readdir(paths.summaryRoot, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && /^\d{4}-W\d{2} RSS 周报\.md$/u.test(entry.name))
    .map((entry) => path.join(paths.summaryRoot, entry.name));
  const canaryFiles = (await walkFiles(paths.canaryRoot)).filter((file) => path.basename(file) === "verification.json");
  const canaries = [];
  for (const file of canaryFiles) canaries.push({ file, value: await readJson(file), mtime: (await fs.stat(file)).mtimeMs });
  canaries.sort((a, b) => b.mtime - a.mtime);
  const latestCanary = canaries[0] || null;
  const scriptValues = Object.values(packageJson?.scripts || {}).join("\n");
  const checks = {
    rss_source_v1_release_compatible: rssSourceReleaseIsCompatible(release),
    latest_canary_passed: latestCanary?.value?.status === "passed" && (latestCanary?.value?.blocking_checks || []).length === 0,
    legacy_decisions_conserved: ledger.legacy_import?.counts?.total === 22 && ledger.legacy_import?.counts?.selected === 14 && ledger.legacy_import?.counts?.unresolved === 8,
    legacy_outputs_archived_and_hashed: migration?.status === "completed" && migration.files?.every((item) => item.verified),
    preserved_historical_short_weeklies_exist_and_match_archive: preservedHistoricalShortWeeklies.length > 0
      && preservedHistoricalShortWeeklies.every((item) => item.exists && item.verified),
    no_superseded_weekly_report_in_active_summary_root: activeSupersededWeeklyFiles.length === 0,
    package_scripts_do_not_invoke_legacy_workflow: !/rss-workflow\.mjs/u.test(scriptValues),
    app_does_not_invoke_legacy_workflow: !/rss-workflow\.mjs/u.test(appText),
    old_rss_api_routes_removed: !/\/api\/rss\/(?:health|sources|sync|resolve|promote)/u.test(appText),
    rss_status_ui_is_not_an_approval_surface: /\/api\/rss-reading\/queue/u.test(appText)
      && /生成今日增量/u.test(appText)
      && !/class="[^"]*rss-decision/u.test(appText)
      && !/class="[^"]*rss-publish/u.test(appText),
    active_docs_use_summary_root: /摘要区\/RSS/u.test(activeText) && !/阅读区\/RSS\/待确认/u.test(activeText),
    normal_generation_has_no_legacy_reading_scan: !/migrateLegacyOutputs/u.test(generateBody)
  };
  const migratedLegacyPaths = migration?.files?.map((item) => item.source_path) || [];
  const isWithin = (root, target) => {
    const relative = path.relative(root, target);
    return !relative.startsWith("..") && !path.isAbsolute(relative);
  };
  const clearableLegacyReadingPaths = migratedLegacyPaths.filter((file) => !isWithin(paths.shortWeeklyRoot, file));
  const failures = Object.entries(checks).filter(([, value]) => !value).map(([name]) => name);
  const receipt = {
    schema_version: "progressive-reading.rss-clearance/v1",
    status: failures.length ? "blocked" : "clearance_ready",
    verified_at: nowIso(),
    checks,
    failures,
    evidence: {
      latest_canary: latestCanary?.file || null,
      legacy_review_ledger: paths.ledgerPath,
      legacy_output_manifest: paths.legacyOutputManifestPath,
      legacy_archive_root: paths.legacySummaryArchiveRoot,
      superseded_report_migration: existsSync(paths.supersededReportReceiptPath) ? paths.supersededReportReceiptPath : null,
      active_superseded_weekly_files: activeSupersededWeeklyFiles,
      active_files_checked: activeFiles
    },
    clearance: {
      old_reading_runtime_dependency: false,
      old_ui_runtime_dependency: false,
      old_workflow_runtime_dependency: false,
      clearable_legacy_reading_paths: clearableLegacyReadingPaths,
      preserved_historical_short_weeklies: preservedHistoricalShortWeeklies,
      preserve_reading_root: paths.readingRoot,
      preserve_reason: "Authorized RSS articles publish flat files under this root, and historical plus future short weeklies remain under 阅读区/RSS/短文周报.",
      clearable_legacy_scripts: [
        path.join(paths.workflowRoot, "scripts", "rss-workflow.mjs"),
        path.join(paths.workflowRoot, "scripts", "rss-sync-daily.cmd")
      ]
    }
  };
  const receiptPath = path.join(paths.dataRoot, "clearance-receipt.json");
  await writeJson(receiptPath, receipt);
  return { ...receipt, receipt_path: receiptPath };
}
