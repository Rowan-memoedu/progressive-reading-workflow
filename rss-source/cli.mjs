#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { configPath as subscriptionDocumentPath } from '../rss-import/config.mjs';
import { fileURLToPath } from "node:url";

import {
  discoverFeedCandidates,
  normalizeUrl,
  readConditionalHeaders,
  syncFeedDocument,
  validateFeedDocument,
  writeNotModifiedRun
} from "./core.mjs";
import {
  loadSubscriptionRegistry,
  runSubscriptionBatch,
  subscriptionRegistryResult
} from "./subscriptions.mjs";

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const workflowRoot = path.resolve(moduleDir, "..");
const defaultOutputRoot = path.join(workflowRoot, "imports", "rss", "source-v1");
const userAgent = "progressive-reading-rss-source/1.0";

function parseArgs(argv) {
  const command = argv[0] || "help";
  const options = {};
  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) throw new Error(`unexpected_argument_${arg}`);
    const key = arg.slice(2);
    if (["fetch-fulltext", "force", "json"].includes(key)) options[key] = true;
    else options[key] = argv[++index] ?? "";
  }
  return { command, options };
}

function runId() {
  const stamp = new Date().toISOString().replace(/[-:.TZ]/gu, "").slice(0, 14);
  return `${stamp}-${crypto.randomUUID().slice(0, 8)}`;
}

function assertOutputWithinWorkspace(value) {
  const target = path.resolve(value || defaultOutputRoot);
  const allowedRoot = path.join(workflowRoot, "imports", "rss");
  const relative = path.relative(allowedRoot, target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("output_must_stay_inside_imports_rss");
  return target;
}

function resolveSubscriptionsDocument(value) {
  const target = path.resolve(value || subscriptionDocumentPath());
  if (path.extname(target).toLowerCase()!=='.md') throw new Error('rss_subscription_input_is_now_the_three_section_markdown_document');
  return target;
}

async function writeJsonAtomic(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.tmp-${crypto.randomUUID()}`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await fs.rename(temporary, filePath);
}

async function fetchText(url, { headers = {}, timeoutMs = 60000, maxBytes = 12 * 1024 * 1024 } = {}) {
  const normalized = normalizeUrl(url);
  const response = await fetch(normalized, {
    redirect: "follow",
    headers: { "User-Agent": userAgent, Accept: "application/atom+xml,application/rss+xml,application/xml,text/xml,text/html;q=0.8,*/*;q=0.5", ...headers },
    signal: AbortSignal.timeout(timeoutMs)
  });
  if (response.status === 304) {
    return { response, text: "", finalUrl: normalizeUrl(response.url || normalized) };
  }
  const declaredLength = Number(response.headers.get("content-length") || 0);
  if (declaredLength && declaredLength > maxBytes) throw new Error(`response_too_large_${declaredLength}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > maxBytes) throw new Error(`response_too_large_${buffer.length}`);
  const text = buffer.toString("utf8");
  if (!response.ok) throw new Error(`http_${response.status}_${text.slice(0, 200)}`);
  return { response, text, finalUrl: normalizeUrl(response.url || normalized) };
}

function responseMetadata(response, finalUrl) {
  return {
    status: response.status,
    final_url: finalUrl,
    headers: {
      content_type: response.headers.get("content-type") || "",
      etag: response.headers.get("etag") || "",
      last_modified: response.headers.get("last-modified") || ""
    }
  };
}

async function discover(url) {
  const fetched = await fetchText(url, { maxBytes: 4 * 1024 * 1024 });
  const candidates = discoverFeedCandidates(fetched.text, fetched.finalUrl);
  return {
    schema_version: "progressive-reading.rss-discovery-result/v1",
    status: candidates.length ? "discovered" : "not_found",
    page_url: fetched.finalUrl,
    candidates
  };
}

async function resolveFeedUrl(options) {
  if (options["feed-url"]) return normalizeUrl(options["feed-url"]);
  if (!options.url) throw new Error("feed_url_or_page_url_required");
  const discovery = await discover(options.url);
  if (!discovery.candidates.length) throw new Error("no_feed_candidates_discovered");
  const failures = [];
  for (const candidate of discovery.candidates) {
    try {
      const fetched = await fetchText(candidate.feed_url);
      await validateFeedDocument(fetched.text, fetched.finalUrl);
      return candidate.feed_url;
    } catch (error) {
      failures.push({ feed_url: candidate.feed_url, error: error.message });
    }
  }
  throw new Error(`no_valid_feed_candidate_${JSON.stringify(failures)}`);
}

async function validate(options) {
  const feedUrl = await resolveFeedUrl(options);
  const fetched = await fetchText(feedUrl);
  const validation = await validateFeedDocument(fetched.text, fetched.finalUrl);
  return {
    schema_version: "progressive-reading.rss-validation-result/v1",
    status: "valid",
    ...validation,
    response: responseMetadata(fetched.response, fetched.finalUrl)
  };
}

async function sync(options) {
  const feedUrl = await resolveFeedUrl(options);
  const outputRoot = assertOutputWithinWorkspace(options.output || defaultOutputRoot);
  const id = runId();
  const fetchedAt = new Date().toISOString();
  const conditionalHeaders = options.force === true ? {} : await readConditionalHeaders(outputRoot, feedUrl);
  const fetched = await fetchText(feedUrl, { headers: conditionalHeaders });
  const response = responseMetadata(fetched.response, fetched.finalUrl);
  if (fetched.response.status === 304) {
    return writeNotModifiedRun({ outputRoot, feedUrl, fetchedAt, response, runId: id });
  }
  const fetchFulltext = Boolean(options["fetch-fulltext"]);
  const maxItems = options.limit ? Number(options.limit) : 0;
  if (!Number.isInteger(maxItems) || maxItems < 0 || maxItems > 100) throw new Error("limit_must_be_integer_1_to_100");
  const articleFetcher = fetchFulltext
    ? async (itemUrl) => {
        const page = await fetchText(itemUrl, { maxBytes: 12 * 1024 * 1024 });
        return { html: page.text, response: responseMetadata(page.response, page.finalUrl) };
      }
    : null;
  return syncFeedDocument({
    feedUrl,
    xml: fetched.text,
    response,
    outputRoot,
    userInstruction: String(options["user-instruction"] || ""),
    fetchFulltext,
    articleFetcher,
    acceptItem: options.acceptItem,
    maxItems,
    fetchedAt,
    runId: id
  });
}

async function subscriptions(options = {}) {
  const configPath = resolveSubscriptionsDocument(options.config);
  const registry = await loadSubscriptionRegistry(configPath);
  return subscriptionRegistryResult(registry, configPath);
}

async function syncAll(options = {}) {
  const configPath = resolveSubscriptionsDocument(options.config);
  const outputRoot = assertOutputWithinWorkspace(options.output || defaultOutputRoot);
  const registry = await loadSubscriptionRegistry(configPath);
  const batchId = runId();
  const result = await runSubscriptionBatch({
    registry,
    options,
    batchId,
    syncOne: async (_subscription, subscriptionOptions) => sync(subscriptionOptions)
  });
  const batchDir = path.join(outputRoot, "batches", batchId);
  const withReceipt = { ...result, config_path: configPath, batch_dir: batchDir };
  await writeJsonAtomic(path.join(batchDir, "run.json"), withReceipt);
  return withReceipt;
}

function help() {
  return {
    schema_version: "progressive-reading.rss-cli-help/v1",
    commands: {
      discover: "rss-source discover --url <website-url>",
      validate: "rss-source validate --feed-url <feed-url> | --url <website-url>",
      sync: "rss-source sync --feed-url <feed-url> [--limit 1-100] [--fetch-fulltext] [--force] [--user-instruction <text>]",
      subscriptions: "rss-source subscriptions [--config <three-section-markdown>] (reports section only)",
      "sync-all": "rss-source sync-all [--config <three-section-markdown>] [--subscription-id <id>] [--limit 1-100] [--fetch-fulltext] [--force]"
    },
    default_output: defaultOutputRoot,
    default_subscriptions: subscriptionDocumentPath(),
    safety: {
      writes_reading_area: false,
      uses_browser_or_login_state: false,
      writes_remnote_or_logseq: false
    }
  };
}

async function main() {
  const { command, options } = parseArgs(process.argv.slice(2));
  let result;
  if (command === "discover") {
    if (!options.url) throw new Error("page_url_required");
    result = await discover(options.url);
  } else if (command === "validate") result = await validate(options);
  else if (command === "sync") result = await sync(options);
  else if (command === "subscriptions") result = await subscriptions(options);
  else if (command === "sync-all") result = await syncAll(options);
  else result = help();
  process.stdout.write(`${JSON.stringify({ ok: true, command, result }, null, 2)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stdout.write(`${JSON.stringify({
      ok: false,
      error: { code: "rss_source_failed", message: error.message }
    }, null, 2)}\n`);
    process.exitCode = 1;
  });
}

export { discover, fetchText, help, subscriptions, sync, syncAll, validate };
