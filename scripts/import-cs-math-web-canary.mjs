import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { JSDOM } from "jsdom";

const DEFAULT_URL = "https://introtcs.org/public/lec_01_introduction.html";
const USER_AGENT = "progressive-reading-network-canary/1.0";

function parseArgs(argv) {
  const parsed = { url: DEFAULT_URL, output: "", help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--url") parsed.url = argv[++index] || "";
    else if (arg === "--output") parsed.output = argv[++index] || "";
    else if (arg === "--help" || arg === "-h") parsed.help = true;
    else throw new Error(`unknown_argument_${arg}`);
  }
  return parsed;
}

function usage() {
  return [
    "CS/math public web source canary",
    "",
    "Usage:",
    "  node scripts/import-cs-math-web-canary.mjs --url <public-url> --output <run-dir>"
  ].join("\n");
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

async function fetchResponse(url, accept = "*/*") {
  let lastError = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(url, {
        redirect: "follow",
        headers: { "User-Agent": USER_AGENT, Accept: accept },
        signal: AbortSignal.timeout(90000)
      });
      if (response.ok) return response;
      const error = new Error(`http_${response.status}_${url}`);
      if (response.status < 500 && response.status !== 429) throw error;
      lastError = error;
    } catch (error) {
      lastError = error;
    }
    if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, attempt * 1000));
  }
  throw new Error(`fetch_failed_${url}: ${lastError?.message || "unknown_error"}`, { cause: lastError });
}

async function fetchText(url, accept = "text/html,text/markdown,text/plain;q=0.9,*/*;q=0.8") {
  return (await fetchResponse(url, accept)).text();
}

async function fetchJson(url) {
  return (await fetchResponse(url, "application/vnd.github+json,application/json")).json();
}

function safeRelativeFile(value) {
  const normalized = String(value || "").replace(/\\/gu, "/");
  const parts = normalized.split("/").filter((part) => part && part !== "." && part !== "..");
  return parts.join("/") || "main.txt";
}

function decodeHtmlEntities(value) {
  const dom = new JSDOM("<!doctype html><textarea></textarea>");
  const textarea = dom.window.document.querySelector("textarea");
  textarea.innerHTML = String(value || "");
  return textarea.value;
}

export function extractTrinketFiles(embedHtml) {
  const assignment = /trinketObject\s*=\s*(\{[^\n]+\});/u.exec(String(embedHtml || ""));
  if (!assignment) throw new Error("trinket_object_missing");
  const trinket = JSON.parse(assignment[1]);
  const decodedCode = decodeHtmlEntities(trinket.code || "[]")
    .replace(/\r/gu, "\\r")
    .replace(/\n/gu, "\\n");
  const files = JSON.parse(decodedCode);
  if (!Array.isArray(files) || !files.length) throw new Error("trinket_code_files_missing");
  return {
    short_code: String(trinket.shortCode || ""),
    language: String(trinket.lang || ""),
    name: String(trinket.name || ""),
    files: files.map((file) => ({
      name: safeRelativeFile(file?.name),
      content: decodeHtmlEntities(file?.content || "").replace(/\r\n/gu, "\n")
    }))
  };
}

export function protectedUnits(markdown) {
  const text = String(markdown || "").replace(/\r\n/gu, "\n");
  const fenced = text.match(/```[^\n]*\n[\s\S]*?\n```/gu) || [];
  const withoutFenced = text.replace(/```[^\n]*\n[\s\S]*?\n```/gu, "");
  const displayMath = withoutFenced.match(/\$\$[\s\S]*?\$\$/gu) || [];
  const withoutDisplay = withoutFenced.replace(/\$\$[\s\S]*?\$\$/gu, "");
  const inlineMath = withoutDisplay.match(/(?<!\\)\$(?!\$)(?:\\.|[^$\n])+(?<!\\)\$/gu) || [];
  const inlineCode = withoutDisplay.match(/(?<!`)`(?!`)[^`\n]+(?<!`)`(?!`)/gu) || [];
  return { fenced, displayMath, inlineMath, inlineCode };
}

function normalizeCodeWhitespace(value) {
  return String(value).split("\n").map((line) => line.trimEnd()).join("\n");
}

export function compareProtectedUnits(sourceMarkdown, candidateMarkdown, { allowCodeWhitespaceNormalization = false } = {}) {
  const source = protectedUnits(sourceMarkdown);
  const candidate = protectedUnits(candidateMarkdown);
  const categories = {};
  let ok = true;
  let exactOk = true;
  for (const key of Object.keys(source)) {
    const unmatchedCandidates = [...candidate[key]];
    const missing = [];
    const whitespaceNormalized = [];
    for (const unit of source[key]) {
      const exactIndex = unmatchedCandidates.indexOf(unit);
      if (exactIndex !== -1) {
        unmatchedCandidates.splice(exactIndex, 1);
        continue;
      }
      const allowNormalizedMatch = allowCodeWhitespaceNormalization && (key === "fenced" || key === "inlineCode");
      const normalizedIndex = allowNormalizedMatch
        ? unmatchedCandidates.findIndex((candidateUnit) => normalizeCodeWhitespace(candidateUnit) === normalizeCodeWhitespace(unit))
        : -1;
      if (normalizedIndex !== -1) {
        whitespaceNormalized.push({
          source_sha256: sha256(unit),
          candidate_sha256: sha256(unmatchedCandidates[normalizedIndex])
        });
        unmatchedCandidates.splice(normalizedIndex, 1);
        exactOk = false;
      } else {
        missing.push({ sha256: sha256(unit), count: 1 });
      }
    }
    categories[key] = {
      source_count: source[key].length,
      candidate_count: candidate[key].length,
      missing,
      whitespace_normalized: whitespaceNormalized
    };
    if (missing.length) {
      ok = false;
      exactOk = false;
    }
  }
  return { ok, exact_ok: exactOk, categories };
}

export function rewriteSourceMarkdown(markdown, pageUrl, iframeAssets = new Map()) {
  let output = String(markdown || "").replace(/\r\n/gu, "\n");
  output = output.replace(/(!?\[[^\]]*?\]\()([^)\s]+)(\))/gu, (match, prefix, target, suffix) => {
    if (/^(?:[a-z][a-z0-9+.-]*:|#)/iu.test(target)) return match;
    try {
      return `${prefix}${new URL(target, pageUrl).href}${suffix}`;
    } catch {
      return match;
    }
  });
  return output.replace(/<iframe\b[^>]*\bsrc=["']([^"']+)["'][^>]*>\s*<\/iframe>/giu, (match, src) => {
    const absolute = new URL(src, pageUrl).href;
    const asset = iframeAssets.get(absolute);
    if (!asset) return `> 在线交互代码：${absolute}`;
    return [
      `> 在线交互代码：[${asset.label}](${absolute})`,
      `> 本地可运行副本：[${asset.local_label}](${asset.local_path.replace(/\\/gu, "/")})`
    ].join("\n")
  });
}

function titleFromPage(document) {
  return document.querySelector("meta[property='og:title']")?.getAttribute("content")?.trim()
    || document.querySelector("h1")?.textContent?.trim()
    || document.title.trim()
    || "Untitled CS/math source";
}

async function githubSourceForPage(document, pageUrl) {
  const repo = document.querySelector("meta[name='github-repo']")?.getAttribute("content")?.trim();
  if (!repo || !/^[^/]+\/[^/]+$/u.test(repo)) throw new Error("github_repo_metadata_missing");
  const repoData = await fetchJson(`https://api.github.com/repos/${repo}`);
  const branch = repoData.default_branch;
  const commitData = await fetchJson(`https://api.github.com/repos/${repo}/commits/${encodeURIComponent(branch)}`);
  const sourceFile = path.posix.basename(new URL(pageUrl).pathname).replace(/\.html?$/iu, ".md");
  const sourceUrl = `https://raw.githubusercontent.com/${repo}/${commitData.sha}/${sourceFile}`;
  return {
    repo,
    branch,
    commit: commitData.sha,
    source_file: sourceFile,
    source_url: sourceUrl,
    markdown: await fetchText(sourceUrl, "text/markdown,text/plain")
  };
}

async function saveTrinketAsset(src, outputDir, index) {
  const html = await fetchText(src);
  const trinket = extractTrinketFiles(html);
  const shortCode = trinket.short_code || `item-${index + 1}`;
  const assetRoot = path.join(outputDir, "assets", `trinket-${safeRelativeFile(shortCode)}`);
  const artifacts = [];
  for (const file of trinket.files) {
    const target = path.join(assetRoot, ...file.name.split("/"));
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, file.content.endsWith("\n") ? file.content : `${file.content}\n`, "utf8");
    artifacts.push({
      path: path.relative(outputDir, target).replace(/\\/gu, "/"),
      sha256: sha256(file.content.replace(/\n?$/u, "\n"))
    });
  }
  const primary = artifacts.find((item) => /main\.py$/iu.test(item.path)) || artifacts[0];
  return {
    type: "trinket",
    source_url: src,
    short_code: shortCode,
    language: trinket.language,
    name: trinket.name,
    files: artifacts,
    primary_path: primary.path
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    return;
  }
  if (!args.url || !args.output) throw new Error("url_and_output_are_required");
  const pageUrl = new URL(args.url).href;
  if (!/^https?:$/u.test(new URL(pageUrl).protocol)) throw new Error("public_http_url_required");
  const outputDir = path.resolve(args.output);
  await fs.mkdir(path.join(outputDir, "raw"), { recursive: true });

  const pageHtml = await fetchText(pageUrl);
  const dom = new JSDOM(pageHtml, { url: pageUrl });
  const { document } = dom.window;
  const source = await githubSourceForPage(document, pageUrl);
  await fs.writeFile(path.join(outputDir, "raw", "page.html"), pageHtml, "utf8");
  await fs.writeFile(path.join(outputDir, "raw", source.source_file), source.markdown, "utf8");

  const iframeUrls = [...document.querySelectorAll("iframe[src]")]
    .map((element) => new URL(element.getAttribute("src"), pageUrl).href)
    .filter((value, index, values) => values.indexOf(value) === index);
  const embeddedAssets = [];
  for (const [index, src] of iframeUrls.entries()) {
    if (/^https:\/\/trinket\.io\/embed\//iu.test(src)) embeddedAssets.push(await saveTrinketAsset(src, outputDir, index));
  }

  const iframeAssets = new Map(embeddedAssets.map((asset) => [asset.source_url, {
    label: asset.name || `Trinket ${asset.short_code}`,
    local_label: path.posix.basename(asset.primary_path),
    local_path: asset.primary_path
  }]));
  const importMarkdown = rewriteSourceMarkdown(source.markdown, pageUrl, iframeAssets);
  await fs.writeFile(path.join(outputDir, "source.md"), importMarkdown, "utf8");

  const pdfUrl = [...pageHtml.matchAll(/https:\/\/[^"'\s]+\.pdf/giu)].map((match) => match[0])[0] || "";
  let pdfArtifact = null;
  if (pdfUrl) {
    const buffer = Buffer.from(await (await fetchResponse(pdfUrl, "application/pdf")).arrayBuffer());
    const pdfPath = path.join(outputDir, "assets", "chapter.pdf");
    await fs.mkdir(path.dirname(pdfPath), { recursive: true });
    await fs.writeFile(pdfPath, buffer);
    pdfArtifact = { path: "assets/chapter.pdf", source_url: pdfUrl, sha256: sha256(buffer) };
  }

  const sourceValidation = compareProtectedUnits(source.markdown, importMarkdown);
  const metadata = {
    source_url: pageUrl,
    canonical_url: pageUrl,
    original_url: pageUrl,
    title: titleFromPage(document),
    author: "Boaz Barak",
    source_is_original: true,
    source_repo: `https://github.com/${source.repo}`,
    source_commit: source.commit,
    source_file: source.source_file,
    source_markdown_url: source.source_url,
    content_domains: ["computer_science", "mathematics"],
    embedded_assets: embeddedAssets,
    alternate_pdf: pdfArtifact,
    translation: {
      is_translation: false,
      original_language: "en",
      translation_language: ""
    }
  };
  await fs.writeFile(path.join(outputDir, "source-metadata.json"), `${JSON.stringify(metadata, null, 2)}\n`, "utf8");

  const request = {
    schema_version: "progressive-reading.preprocess.request/v1",
    contract_version: "1.0.0",
    material: { markdown: importMarkdown },
    source_type: "public_web_cs_math_chapter",
    source_metadata: metadata,
    user_instruction: "保留作者原有视角和风格，只做清晰化与结构化，不改成第三人称转述；不要添加时间戳；正文当前保持英文；不得改写或破坏 LaTeX 公式、Pandoc algorithm/伪代码块、行内代码、代码块和链接；专业术语保持一致。"
  };
  await fs.writeFile(path.join(outputDir, "preprocess-request.json"), `${JSON.stringify(request, null, 2)}\n`, "utf8");

  const receipt = {
    status: sourceValidation.ok ? "source_captured" : "failed",
    artifacts: {
      raw_html: "raw/page.html",
      raw_markdown: `raw/${source.source_file}`,
      import_markdown: "source.md",
      source_metadata: "source-metadata.json",
      preprocess_request: "preprocess-request.json",
      embedded_assets: embeddedAssets,
      alternate_pdf: pdfArtifact
    },
    source_metadata: metadata,
    receipt: {
      source_markdown_sha256: sha256(source.markdown),
      import_markdown_sha256: sha256(importMarkdown),
      protected_units: sourceValidation
    },
    errors: sourceValidation.ok ? [] : [{ code: "protected_source_units_changed", stage: "source_normalization" }]
  };
  await fs.writeFile(path.join(outputDir, "capture-receipt.json"), `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({
    status: receipt.status,
    output_dir: outputDir,
    source_commit: source.commit,
    embedded_assets: embeddedAssets.length,
    protected_units_ok: sourceValidation.ok
  }));
  if (!sourceValidation.ok) process.exitCode = 1;
}

if (fileURLToPath(import.meta.url) === path.resolve(process.argv[1] || "")) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack || error.message : String(error));
    process.exitCode = 1;
  });
}
