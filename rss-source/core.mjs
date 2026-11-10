import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { JSDOM } from "jsdom";
import Parser from "rss-parser";
import {htmlArticleToMarkdown} from '../scripts/browser-page-markdown.mjs';
import {ARTICLE_EXTRACTION_VERSION,originalArticleTarget} from './article-fetch.mjs';

export const SOURCE_PACKAGE_SCHEMA = "progressive-reading.rss-source-package/v1";
export const PREPROCESS_SCHEMA = "progressive-reading.preprocess.request/v1";
export const CONTENT_STATUSES = [
  "fulltext_ready",
  "summary_only",
  "fetch_required",
  "fetch_failed"
];

const parser = new Parser({
  customFields: {
    item: [
      ["content:encoded", "contentEncoded"],
      ["dc:creator", "dcCreator"]
    ]
  }
});

export function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

export function normalizeUrl(value) {
  if (!value) return "";
  const url = new URL(String(value));
  if (!/^https?:$/u.test(url.protocol)) throw new Error(`unsupported_url_protocol_${url.protocol}`);
  if (url.username || url.password) throw new Error("url_credentials_not_allowed");
  url.hash = "";
  url.hostname = url.hostname.toLowerCase();
  if ((url.protocol === "https:" && url.port === "443") || (url.protocol === "http:" && url.port === "80")) {
    url.port = "";
  }
  for (const key of [...url.searchParams.keys()]) {
    if (/^(utm_.+|spm|fbclid|gclid|mc_cid|mc_eid)$/iu.test(key)) {
      url.searchParams.delete(key);
    }
  }
  const sorted = [...url.searchParams.entries()].sort(([leftKey, leftValue], [rightKey, rightValue]) => {
    return leftKey.localeCompare(rightKey) || leftValue.localeCompare(rightValue);
  });
  url.search = "";
  for (const [key, item] of sorted) url.searchParams.append(key, item);
  return url.toString();
}

export function discoverFeedCandidates(html, pageUrl) {
  const canonicalPageUrl = normalizeUrl(pageUrl);
  const dom = new JSDOM(String(html || ""), { url: canonicalPageUrl });
  const candidates = [];
  for (const link of dom.window.document.querySelectorAll("link[href]")) {
    const rel = String(link.getAttribute("rel") || "").toLowerCase().split(/\s+/u);
    const type = String(link.getAttribute("type") || "").toLowerCase();
    if (!rel.includes("alternate")) continue;
    if (!/(application\/(rss|atom)\+xml|application\/xml|text\/xml)/u.test(type)) continue;
    try {
      const feedUrl = normalizeUrl(new URL(link.getAttribute("href"), canonicalPageUrl).href);
      candidates.push({
        feed_url: feedUrl,
        type: type || "application/xml",
        title: String(link.getAttribute("title") || "").trim(),
        discovered_from: canonicalPageUrl
      });
    } catch {
      // Ignore malformed discovery candidates without failing all valid candidates.
    }
  }
  return [...new Map(candidates.map((candidate) => [candidate.feed_url, candidate])).values()];
}

function feedFormat(xml) {
  const text = String(xml || "").replace(/^\uFEFF/u, "").trimStart();
  if (/^<\?xml[\s\S]*?<feed[\s>]/iu.test(text) || /^<feed[\s>]/iu.test(text)) return "atom";
  if (/<rss[\s>]|<rdf:RDF[\s>]/iu.test(text)) return "rss";
  return "unknown";
}

function exactText(value) {
  return value == null ? "" : String(value);
}

function markdownFromHtmlOrText(value,baseUrl) {
  const source = exactText(value).trim();
  if (!source) return "";
  if (!/<[A-Za-z!/][^>]*>/u.test(source)) return source.replace(/\r\n/gu, "\n").trim();
  return htmlArticleToMarkdown({html:source,sourceUrl:baseUrl,extractArticle:false}).markdown;
}

function looksLikeTeaser(raw, markdown) {
  const source = exactText(raw);
  const text = exactText(markdown).trim();
  if (/class=["'][^"']*(?:more-link|read-more|continue-reading)[^"']*["']/iu.test(source)) return true;
  if (/(?:\[?(?:read|continue)\s+(?:the\s+)?(?:full\s+)?(?:article|story|post|reading|more)|阅读全文|继续阅读|阅读原文)\]?\s*(?:\([^)]*\))?\s*$/iu.test(text)) return true;
  if (text.length < 400 && /(?:\.{3}|…|\.\.\.)\s*$/u.test(text)) return true;
  return false;
}

function restrictedPageReason(raw) {
  const source = exactText(raw);
  if (/(?:this post is for paid subscribers|already a paid subscriber\?|subscribe to unlock|paid-subscribe|subscription required)/iu.test(source)) {
    return "fetched_article_access_restricted_paid_subscribers";
  }
  return "";
}

function chooseFeedContent(item, format,baseUrl) {
  const encoded = exactText(item.contentEncoded || item["content:encoded"]);
  if (encoded.trim()) {
    const markdown = markdownFromHtmlOrText(encoded,baseUrl);
    if (looksLikeTeaser(encoded, markdown)) {
      return { raw: encoded, markdown, status: "summary_only", ref: "feed-content-encoded-truncated" };
    }
    return { raw: encoded, markdown, status: "fulltext_ready", ref: "feed-content-encoded" };
  }
  if (format === "atom" && exactText(item.content).trim()) {
    const content = exactText(item.content);
    const markdown = markdownFromHtmlOrText(content,baseUrl);
    if (looksLikeTeaser(content, markdown)) {
      return { raw: content, markdown, status: "summary_only", ref: "atom-content-truncated" };
    }
    return { raw: content, markdown, status: "fulltext_ready", ref: "atom-content" };
  }
  const summary = exactText(item.summary || item.content || item.description || item.contentSnippet);
  if (summary.trim()) {
    return { raw: summary, markdown: markdownFromHtmlOrText(summary,baseUrl), status: "summary_only", ref: "feed-summary" };
  }
  return { raw: "", markdown: "", status: "summary_only", ref: "feed-empty" };
}

export async function parseFeedDocument(xml, feedUrl) {
  const normalizedFeedUrl = normalizeUrl(feedUrl);
  const format = feedFormat(xml);
  if (format === "unknown") throw new Error("feed_format_not_recognized");
  let feed;
  try {
    feed = await parser.parseString(String(xml));
  } catch (error) {
    throw new Error(`feed_parse_failed_${error.message}`, { cause: error });
  }
  const items = (feed.items || []).map((item, index) => {
    let contentBase=normalizedFeedUrl;
    try {contentBase=new URL(item.link || item.url || normalizedFeedUrl,normalizedFeedUrl).href;}catch{/* Malformed item links are handled below. */}
    const content = chooseFeedContent(item, format,contentBase);
    let itemUrl = "";
    try {
      itemUrl = normalizeUrl(item.link || item.url || "");
    } catch {
      itemUrl = "";
    }
    return {
      index,
      guid: exactText(item.guid || item.id).trim(),
      item_url: itemUrl,
      title: exactText(item.title || item.link || `RSS item ${index + 1}`).trim(),
      author: exactText(item.creator || item.dcCreator || item.author).trim(),
      published_at: exactText(item.isoDate || item.pubDate || item.published || item.updated).trim(),
      feed_content: content,
      raw_item: item
    };
  });
  return {
    format,
    feed_url: normalizedFeedUrl,
    title: exactText(feed.title).trim(),
    description: exactText(feed.description).trim(),
    site_url: (() => {
      try { return normalizeUrl(feed.link || ""); } catch { return ""; }
    })(),
    item_count: items.length,
    items
  };
}

export async function validateFeedDocument(xml, feedUrl) {
  const parsed = await parseFeedDocument(xml, feedUrl);
  return {
    valid: true,
    format: parsed.format,
    feed_url: parsed.feed_url,
    title: parsed.title,
    site_url: parsed.site_url,
    item_count: parsed.item_count,
    content_counts: parsed.items.reduce((counts, item) => {
      counts[item.feed_content.status] = (counts[item.feed_content.status] || 0) + 1;
      return counts;
    }, {})
  };
}

export function extractArticleMarkdown(html, itemUrl) {
  return htmlArticleToMarkdown({html:String(html || ''),sourceUrl:normalizeUrl(itemUrl)});
}

function safeSegment(value, fallback = "item") {
  const cleaned = String(value || "")
    .normalize("NFKC")
    .replace(/[<>:"/\\|?*\u0000-\u001f]/gu, "-")
    .replace(/\s+/gu, " ")
    .replace(/[. ]+$/gu, "")
    .trim();
  return (cleaned || fallback).slice(0, 80);
}

function identityFor(feedUrl, item, rawContent) {
  const contentHash = sha256(rawContent || item.feed_content.markdown || item.title || "");
  return {
    normalized_feed_url: normalizeUrl(feedUrl),
    normalized_item_url: item.item_url || null,
    guid: item.guid || null,
    content_hash: contentHash
  };
}

function aliasKeys(identity) {
  const feedHash = sha256(identity.normalized_feed_url).slice(0, 24);
  const keys = [`feed_content:${feedHash}:${identity.content_hash}`];
  if (identity.guid) keys.push(`feed_guid:${feedHash}:${identity.guid}`);
  if (identity.normalized_item_url) keys.push(`item_url:${identity.normalized_item_url}`);
  return keys;
}

function duplicateRecord(state, identity) {
  for (const key of aliasKeys(identity)) {
    const record = state.aliases?.[key];
    if (record?.content_hash === identity.content_hash) return record;
  }
  return null;
}

function previousRecord(state, identity) {
  const keys = aliasKeys(identity).filter((key) => !key.startsWith("feed_content:"));
  for (const key of keys) {
    const record = state.aliases?.[key];
    if (record) return record;
  }
  return null;
}

function materialId(identity) {
  const primary = identity.guid || identity.normalized_item_url || identity.content_hash;
  return `rss-${sha256(`${identity.normalized_feed_url}\n${primary}\n${identity.content_hash}`).slice(0, 24)}`;
}

function buildSourceMarkdown(title, body) {
  return `# ${title || "Untitled RSS item"}\n\n${String(body || "").trim()}\n`;
}

export function buildPreprocessRequest({ markdown, metadata, userInstruction = "" }) {
  return {
    schema_version: PREPROCESS_SCHEMA,
    contract_version: "1.0.0",
    material: { markdown },
    source_type: "rss",
    source_metadata: {
      source_url: metadata.item_url || metadata.feed_url,
      canonical_url: metadata.original_url || metadata.item_url || metadata.feed_url,
      original_url: metadata.original_url || metadata.item_url || metadata.feed_url,
      feed_url: metadata.feed_url,
      item_url: metadata.item_url,
      guid: metadata.guid,
      title: metadata.title,
      author: metadata.author,
      published_at: metadata.published_at,
      fetched_at: metadata.fetched_at,
      content_completeness: metadata.content_completeness,
      original_source_ref: metadata.original_source_ref,
      source_is_original: true,
      translation: { is_translation: false }
    },
    user_instruction: userInstruction
  };
}

async function pathExists(filePath) {
  try { await fs.access(filePath); return true; } catch { return false; }
}

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function writeJsonAtomic(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.tmp-${crypto.randomUUID()}`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await renameWithRetry(temporary, filePath);
}

async function writeTextAtomic(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.tmp-${crypto.randomUUID()}`;
  await fs.writeFile(temporary, String(value), "utf8");
  await renameWithRetry(temporary, filePath);
}

export async function renameWithRetry(source, target, { rename = fs.rename, attempts = 6, delayMs = 50 } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await rename(source, target);
      return;
    } catch (error) {
      lastError = error;
      if (!["EPERM", "EBUSY", "EACCES"].includes(String(error.code || "")) || attempt === attempts) throw error;
      await new Promise((resolve) => setTimeout(resolve, delayMs * (2 ** (attempt - 1))));
    }
  }
  throw lastError;
}

async function loadState(statePath) {
  if (!(await pathExists(statePath))) return { schema_version: "progressive-reading.rss-state/v1", feeds: {}, aliases: {}, materials: {} };
  const parsed = JSON.parse(await fs.readFile(statePath, "utf8"));
  return {
    schema_version: "progressive-reading.rss-state/v1",
    feeds: parsed.feeds || {},
    aliases: parsed.aliases || {},
    materials: parsed.materials || {}
  };
}

function registerMaterial(state, identity, record) {
  for (const key of aliasKeys(identity)) {
    state.aliases[key] = { material_id: record.material_id, content_hash: identity.content_hash, package_path: record.package_path };
  }
  state.materials[record.material_id] = record;
}

async function writePackageAtomically(targetDir, writer) {
  const temporary = `${targetDir}.tmp-${crypto.randomUUID()}`;
  await fs.mkdir(temporary, { recursive: true });
  try {
    await writer(temporary);
    await fs.mkdir(path.dirname(targetDir), { recursive: true });
    await renameWithRetry(temporary, targetDir);
  } catch (error) {
    await fs.rm(temporary, { recursive: true, force: true });
    throw error;
  }
}

function relativePath(from, target) {
  return path.relative(from, target).replace(/\\/gu, "/");
}

export async function syncFeedDocument({
  feedUrl,
  xml,
  response = {},
  outputRoot,
  userInstruction = "",
  fetchFulltext = false,
  articleFetcher = null,
  maxItems = 0,
  onlyItemUrls = null,
  acceptItem = null,
  preserveFeedState = false,
  fetchedAt = new Date().toISOString(),
  runId = `${new Date().toISOString().replace(/[-:.TZ]/gu, "").slice(0, 14)}-${crypto.randomUUID().slice(0, 8)}`
}) {
  const normalizedFeedUrl = normalizeUrl(response.final_url || feedUrl);
  const parsed = await parseFeedDocument(xml, normalizedFeedUrl);
  const sourceId = `rss-${sha256(normalizedFeedUrl).slice(0, 12)}`;
  const root = path.resolve(outputRoot);
  const statePath = path.join(root, "state.json");
  const state = await loadState(statePath);
  const runDir = path.join(root, "runs", runId);
  const rawFeedPath = path.join(runDir, "raw", parsed.format === "atom" ? "feed.atom.xml" : "feed.rss.xml");
  await fs.mkdir(path.dirname(rawFeedPath), { recursive: true });
  await fs.writeFile(rawFeedPath, String(xml), "utf8");
  await writeJson(path.join(runDir, "raw", "response.json"), {
    requested_url: normalizeUrl(feedUrl),
    final_url: normalizedFeedUrl,
    fetched_at: fetchedAt,
    status: response.status ?? 200,
    headers: {
      content_type: response.headers?.content_type || response.headers?.["content-type"] || "",
      etag: response.headers?.etag || "",
      last_modified: response.headers?.last_modified || response.headers?.["last-modified"] || ""
    },
    body_sha256: sha256(String(xml))
  });

  const runItems = [];
  const allowedUrls = onlyItemUrls ? new Set(onlyItemUrls.map(normalizeUrl)) : null;
  const candidates = allowedUrls ? parsed.items.filter(item => item.item_url && allowedUrls.has(normalizeUrl(item.item_url))) : parsed.items;
  if (allowedUrls && new Set(candidates.map(item=>normalizeUrl(item.item_url))).size !== allowedUrls.size) {
    throw new Error('retry_source_snapshot_missing_requested_items');
  }
  const eligibleItems = acceptItem ? candidates.filter(acceptItem) : candidates;
  const selectedItems = maxItems > 0 ? eligibleItems.slice(0, maxItems) : eligibleItems;
  for (const item of selectedItems) {
    const identity = identityFor(normalizedFeedUrl, item, item.feed_content.raw);
    const duplicate = duplicateRecord(state, identity);
    let existingPackage = null;
    if (duplicate && await pathExists(duplicate.package_path)) {
      try {
        existingPackage = JSON.parse(await fs.readFile(path.join(duplicate.package_path, "package.json"), "utf8"));
      } catch (error) {
        throw new Error(`existing_package_unreadable_${duplicate.material_id}_${error.message}`, { cause: error });
      }
    }
    const statusHistory = [item.feed_content.status];
    let contentStatus = item.feed_content.status;
    let sourceRef = item.feed_content.ref;
    let rawContent = item.feed_content.raw;
    let markdownBody = item.feed_content.markdown;
    let rawPageHtml = "";
    let itemPageResponse = null;
    let originalArticle = null;
    const refreshRichText=fetchFulltext && existingPackage?.content_status==='fulltext_ready'
      && originalArticleTarget(item.item_url) && existingPackage.receipt?.fulltext_evidence?.extraction_version!==ARTICLE_EXTRACTION_VERSION;
    const errors = [];

    if ((contentStatus === "summary_only" || refreshRichText) && item.item_url) {
      statusHistory.push("fetch_required");
      contentStatus = "fetch_required";
      if (fetchFulltext && (existingPackage?.content_status !== "fulltext_ready" || refreshRichText)) {
        try {
          if (typeof articleFetcher !== "function") throw new Error("article_fetcher_missing");
          const page = await articleFetcher(item.item_url);
          rawPageHtml = exactText(page.html ?? page);
          itemPageResponse = page && typeof page === "object" ? page.response || null : null;
          const article = typeof page.markdown==='string' ? {markdown:page.markdown,title:page.title} : extractArticleMarkdown(rawPageHtml, item.item_url);
          originalArticle=page.original || null;
          if(originalArticleTarget(item.item_url) && !originalArticle)throw new Error('rss_reader_page_missing_original_markdown');
          const restriction = restrictedPageReason(rawPageHtml);
          if (restriction) throw new Error(restriction);
          if (looksLikeTeaser(rawPageHtml, article.markdown)) throw new Error("fetched_article_looks_truncated");
          const minimumFulltextLength = Math.max(80, item.feed_content.markdown.length + 20);
          if (article.markdown.length < minimumFulltextLength) {
            throw new Error(`fetched_article_too_short_${article.markdown.length}_required_${minimumFulltextLength}`);
          }
          markdownBody = article.markdown;
          rawContent = originalArticle?.raw || rawPageHtml;
          sourceRef = originalArticle ? 'item-page-original-markdown' : "item-page-readability";
          contentStatus = "fulltext_ready";
          statusHistory.push("fulltext_ready");
        } catch (error) {
          contentStatus = "fetch_failed";
          statusHistory.push("fetch_failed");
          errors.push({ code: "fulltext_fetch_failed", stage: "item_page_fetch", message: error.message });
        }
      }
    }

    // Feed-entry content remains the stable material identity. A public item page is
    // completeness evidence that may upgrade the same material without creating a
    // second active package for the same GUID/item URL.
    const existingStatus = existingPackage?.content_status || null;
    const updatesExisting = Boolean(existingPackage
      && ((existingStatus !== "fulltext_ready" && ["fulltext_ready", "fetch_failed"].includes(contentStatus))
        || (refreshRichText && contentStatus==='fulltext_ready')));
    if (existingPackage && !updatesExisting) {
      if (state.materials[duplicate.material_id]) state.materials[duplicate.material_id].last_seen_at = fetchedAt;
      const occurrence = {
        material_id: duplicate.material_id,
        status: "duplicate",
        content_status: existingStatus || contentStatus,
        identity,
        existing_package_path: duplicate.package_path,
        seen_at: fetchedAt,
        status_history: [...statusHistory, "duplicate"],
        errors
      };
      runItems.push(occurrence);
      continue;
    }

    const previous = previousRecord(state, identity);
    const id = updatesExisting ? duplicate.material_id : materialId(identity);
    const sourceMarkdown = buildSourceMarkdown(item.title, markdownBody || item.feed_content.markdown);
    const revisionRoot=refreshRichText ? `revisions/${sha256(sourceMarkdown)}` : '';
    const sourceFile=revisionRoot ? `${revisionRoot}/source.md` : 'source.md';
    const requestFile=revisionRoot ? `${revisionRoot}/preprocess-request.json` : 'preprocess-request.json';
    const originalFile=originalArticle ? `${revisionRoot ? revisionRoot+'/' : ''}raw/original-article.json` : null;
    const metadata = {
      source_type: "rss",
      feed_url: normalizedFeedUrl,
      item_url: item.item_url || null,
      guid: item.guid || null,
      title: item.title,
      author: item.author || null,
      published_at: item.published_at || null,
      fetched_at: fetchedAt,
      content_completeness: contentStatus,
      original_source_ref: sourceRef,
      ...(originalArticle ? {original_url:originalArticle.url} : {}),
      user_instruction: userInstruction
    };
    const packageDir = updatesExisting ? duplicate.package_path : path.join(root, "packages", sourceId, safeSegment(id));
    const packageRecord = {
      schema_version: SOURCE_PACKAGE_SCHEMA,
      package_version: "1.0.0",
      material_id: id,
      status: contentStatus,
      content_status: contentStatus,
      sync_status: updatesExisting ? "duplicate" : "new",
      identity,
      source_metadata: metadata,
      artifacts: {
        source_markdown: sourceFile,
        source_metadata: "source-metadata.json",
        raw_item: "raw/item.json",
        raw_feed_content: "raw/feed-content.txt",
        raw_item_page: rawPageHtml ? "raw/item-page.html" : null,
        raw_item_page_response: rawPageHtml ? "raw/item-page-response.json" : null,
        ...(originalFile ? {raw_original_article:originalFile} : {}),
        raw_feed_snapshot: relativePath(packageDir, rawFeedPath),
        preprocess_request: contentStatus === "fulltext_ready" ? requestFile : null
      },
      hashes: {
        raw_feed_sha256: sha256(String(xml)),
        raw_content_sha256: sha256(rawContent || ""),
        source_markdown_sha256: sha256(sourceMarkdown)
      },
      receipt: {
        run_id: runId,
        source_id: sourceId,
        status_history: [...new Set([...(existingPackage?.receipt?.status_history || []), ...statusHistory])],
        previous_material_id: updatesExisting ? id : previous?.material_id || null,
        preprocessing_handoff: contentStatus === "fulltext_ready" ? "request_ready" : "blocked_in_source_layer",
        update_from_status: updatesExisting ? existingStatus : null,
        fulltext_evidence: {
          source_ref: sourceRef,
          ...(rawPageHtml ? {extraction_version:ARTICLE_EXTRACTION_VERSION} : {}),
          ...(originalArticle ? {original_url:originalArticle.url,original_api:originalArticle.api,original_response:originalArticle.response} : {}),
          feed_markdown_length: item.feed_content.markdown.length,
          selected_markdown_length: markdownBody.length
        }
      },
      errors
    };

    if (updatesExisting) {
      if (rawPageHtml) await writeTextAtomic(path.join(packageDir, "raw", "item-page.html"), rawPageHtml);
      if (rawPageHtml) {
        await writeJsonAtomic(path.join(packageDir, "raw", "item-page-response.json"), itemPageResponse || {
          requested_url: item.item_url,
          final_url: item.item_url,
          status: null,
          headers: {}
        });
      }
      if(originalFile)await writeTextAtomic(path.join(packageDir,originalFile),originalArticle.raw);
      await writeTextAtomic(path.join(packageDir, sourceFile), sourceMarkdown);
      await writeJsonAtomic(path.join(packageDir, "source-metadata.json"), metadata);
      if (contentStatus === "fulltext_ready") {
        await writeJsonAtomic(path.join(packageDir, requestFile), buildPreprocessRequest({
          markdown: sourceMarkdown,
          metadata,
          userInstruction
        }));
      }
      // package.json is the commit marker and is replaced last.
      await writeJsonAtomic(path.join(packageDir, "package.json"), packageRecord);
      registerMaterial(state, identity, {
        material_id: id,
        content_hash: identity.content_hash,
        content_status: contentStatus,
        package_path: packageDir,
        first_seen_at: existingPackage.source_metadata?.fetched_at || fetchedAt,
        last_seen_at: fetchedAt
      });
      runItems.push({
        material_id: id,
        status: contentStatus,
        content_status: contentStatus,
        identity,
        package_path: packageDir,
        updated_existing_package: true,
        upgraded_existing_package: contentStatus === "fulltext_ready",
        updated_from_status: existingStatus,
        status_history: packageRecord.receipt.status_history,
        preprocess_request: packageRecord.artifacts.preprocess_request,
        errors
      });
      continue;
    }

    if (await pathExists(packageDir)) {
      let existingPackage;
      try {
        existingPackage = JSON.parse(await fs.readFile(path.join(packageDir, "package.json"), "utf8"));
      } catch (error) {
        throw new Error(`existing_package_unreadable_${id}_${error.message}`, { cause: error });
      }
      if (existingPackage.material_id !== id || existingPackage.identity?.content_hash !== identity.content_hash) {
        throw new Error(`existing_package_identity_collision_${id}`);
      }
      const existingStatus = existingPackage.content_status || contentStatus;
      registerMaterial(state, identity, {
        material_id: id,
        content_hash: identity.content_hash,
        content_status: existingStatus,
        package_path: packageDir,
        first_seen_at: existingPackage.source_metadata?.fetched_at || fetchedAt,
        last_seen_at: fetchedAt
      });
      runItems.push({
        material_id: id,
        status: "duplicate",
        content_status: existingStatus,
        identity,
        existing_package_path: packageDir,
        recovered_orphan_package: true,
        seen_at: fetchedAt,
        status_history: [...new Set([...statusHistory, "duplicate"])]
      });
      continue;
    }

    await writePackageAtomically(packageDir, async (temporary) => {
      await fs.mkdir(path.join(temporary, "raw"), { recursive: true });
      await fs.writeFile(path.join(temporary, "raw", "item.json"), `${JSON.stringify(item.raw_item, null, 2)}\n`, "utf8");
      await fs.writeFile(path.join(temporary, "raw", "feed-content.txt"), item.feed_content.raw, "utf8");
      if (rawPageHtml) await fs.writeFile(path.join(temporary, "raw", "item-page.html"), rawPageHtml, "utf8");
      if (rawPageHtml) {
        await writeJson(path.join(temporary, "raw", "item-page-response.json"), itemPageResponse || {
          requested_url: item.item_url,
          final_url: item.item_url,
          status: null,
          headers: {}
        });
      }
      if(originalFile)await writeTextAtomic(path.join(temporary,originalFile),originalArticle.raw);
      await fs.writeFile(path.join(temporary, sourceFile), sourceMarkdown, "utf8");
      await writeJson(path.join(temporary, "source-metadata.json"), metadata);
      if (contentStatus === "fulltext_ready") {
        await writeJson(path.join(temporary, requestFile), buildPreprocessRequest({
          markdown: sourceMarkdown,
          metadata,
          userInstruction
        }));
      }
      await writeJson(path.join(temporary, "package.json"), packageRecord);
    });

    const stateRecord = {
      material_id: id,
      content_hash: identity.content_hash,
      content_status: contentStatus,
      package_path: packageDir,
      first_seen_at: fetchedAt,
      last_seen_at: fetchedAt
    };
    registerMaterial(state, identity, stateRecord);
    runItems.push({
      material_id: id,
      status: contentStatus,
      content_status: contentStatus,
      identity,
      package_path: packageDir,
      status_history: packageRecord.receipt.status_history,
      preprocess_request: packageRecord.artifacts.preprocess_request,
      errors
    });
  }

  const feedState = {
    source_id: sourceId,
    feed_url: normalizedFeedUrl,
    etag: response.headers?.etag || response.headers?.["etag"] || "",
    last_modified: response.headers?.last_modified || response.headers?.["last-modified"] || "",
    last_fetched_at: fetchedAt,
    last_run_id: runId,
    raw_feed_sha256: sha256(String(xml)),
    inventory_complete: !allowedUrls && !acceptItem && (maxItems <= 0 || maxItems >= parsed.item_count)
  };
  if (!preserveFeedState) state.feeds[normalizedFeedUrl] = feedState;
  const requestedFeedUrl = normalizeUrl(feedUrl);
  if (!preserveFeedState && requestedFeedUrl !== normalizedFeedUrl) {
    state.feeds[requestedFeedUrl] = { ...feedState, canonical_feed_url: normalizedFeedUrl };
  }
  await writeJsonAtomic(statePath, state);

  const result = {
    schema_version: "progressive-reading.rss-sync-result/v1",
    status: runItems.some((item) => item.status === "fetch_failed") ? "completed_with_failures" : "completed",
    run_id: runId,
    run_dir: runDir,
    feed_url: normalizedFeedUrl,
    source_id: sourceId,
    feed_format: parsed.format,
    feed_item_count: parsed.item_count,
    item_count: runItems.length,
    inventory_complete: feedState.inventory_complete,
    counts: runItems.reduce((counts, item) => {
      counts[item.status] = (counts[item.status] || 0) + 1;
      return counts;
    }, {}),
    items: runItems,
    writes: {
      reading_area: false,
      remnote: false,
      logseq: false,
      browser: false
    }
  };
  await writeJson(path.join(runDir, "items.json"), runItems);
  await writeJson(path.join(runDir, "run.json"), result);
  return result;
}

export async function readConditionalHeaders(outputRoot, feedUrl) {
  const state = await loadState(path.join(path.resolve(outputRoot), "state.json"));
  const record = state.feeds[normalizeUrl(feedUrl)] || {};
  if (record.inventory_complete !== true) return {};
  const headers = {};
  if (record.etag) headers["If-None-Match"] = record.etag;
  if (record.last_modified) headers["If-Modified-Since"] = record.last_modified;
  return headers;
}

export async function writeNotModifiedRun({ outputRoot, feedUrl, fetchedAt, response, runId }) {
  const root = path.resolve(outputRoot);
  const runDir = path.join(root, "runs", runId);
  const result = {
    schema_version: "progressive-reading.rss-sync-result/v1",
    status: "not_modified",
    run_id: runId,
    run_dir: runDir,
    feed_url: normalizeUrl(feedUrl),
    fetched_at: fetchedAt,
    response_status: response.status,
    item_count: 0,
    counts: {},
    items: [],
    writes: { reading_area: false, remnote: false, logseq: false, browser: false }
  };
  await writeJson(path.join(runDir, "run.json"), result);
  return result;
}
