import { createHash } from "node:crypto";
import { collectPandocReferenceLabels } from "./pandoc-normalizer.mjs";

export const SPLIT_MANIFEST_VERSION = "progressive-reading.split-manifest/v2";
export const SPLIT_POLICY_VERSION = "heading-semantic-hierarchy-v2";

function sha256(value) {
  return createHash("sha256").update(String(value || ""), "utf8").digest("hex");
}

function sourceWithFrontmatterOffset(markdown) {
  const value = String(markdown || "").replace(/\r\n?/gu, "\n");
  if (!value.startsWith("---\n")) return { source: value, body: value, lineOffset: 0 };
  const end = value.indexOf("\n---\n", 4);
  if (end < 0) return { source: value, body: value, lineOffset: 0 };
  const bodyStart = end + 5;
  const lineOffset = value.slice(0, bodyStart).split("\n").length - 1;
  return { source: value, body: value.slice(bodyStart), lineOffset };
}

function trimOuter(value) {
  return String(value || "").replace(/^(?:\s*\n)+|(?:\n\s*)+$/gu, "");
}

function blockType(markdown) {
  const value = String(markdown || "").trim();
  if (/^#{1,6}\s+/u.test(value)) return "heading";
  if (/^```|^~~~/u.test(value)) return "code";
  if (/^(?:[-*+] |\d+[.)] )/u.test(value)) return "list";
  if (/^>/u.test(value)) return "quote";
  return "paragraph";
}

export function parseSplitSourceBlocks(markdown) {
  const { body, lineOffset } = sourceWithFrontmatterOffset(markdown);
  const lines = body.split("\n");
  const groups = [];
  let current = [];
  let currentStart = 1;
  let fence = null;
  const flush = (endLine) => {
    const value = trimOuter(current.join("\n"));
    if (value) groups.push({ markdown: value, line_start: currentStart + lineOffset, line_end: endLine + lineOffset });
    current = [];
  };
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const marker = /^\s*(```|~~~)/u.exec(line)?.[1] || null;
    if (!current.length && line.trim()) currentStart = index + 1;
    if (marker) {
      if (!fence) fence = marker;
      else if (fence === marker) fence = null;
      current.push(line);
      continue;
    }
    if (!fence && !line.trim()) flush(index);
    else current.push(line);
  }
  flush(lines.length);
  return groups.map((group, index) => {
    const hash = sha256(group.markdown);
    const heading = /^(#{1,6})\s+(.+)$/u.exec(group.markdown.split("\n")[0] || "");
    return {
      ...group,
      source_index: index,
      source_block_key: `src-${String(index + 1).padStart(4, "0")}-${hash.slice(0, 8)}`,
      source_hash: hash,
      type: blockType(group.markdown),
      heading_level: heading ? heading[1].length : null,
      heading_text: heading ? heading[2].replace(/\s*\{[^}\n]*\}\s*$/u, "").trim() : ""
    };
  });
}

function structureCounts(blocks) {
  const text = blocks.map((block) => block.markdown).join("\n\n");
  const semanticFences = (text.match(/^```[^\n]*\{[^}\n]*\.algorithm[^}\n]*\}/gmu) || []).length;
  const allFences = (text.match(/^```|^~~~/gmu) || []).length / 2;
  return {
    algorithm: semanticFences,
    exercise: (text.match(/^:::\s*\{[^}\n]*\.exercise\b/gmu) || []).length,
    proof: (text.match(/^:::\s*\{[^}\n]*\.proof\b/gmu) || []).length,
    remark: (text.match(/^:::\s*\{[^}\n]*\.remark\b/gmu) || []).length,
    objectives: (text.match(/^:::\s*\{[^}\n]*\.objectives\b/gmu) || []).length,
    true_code_fence: Math.max(0, Math.round(allFences - semanticFences)),
    display_math: (text.match(/\$\$[\s\S]*?\$\$/gu) || []).length,
    image: (text.match(/!\[[^\]]*\]\([^)\n]+\)/gu) || []).length,
    citation: (text.match(/\[@[^\]\n]+\]/gu) || []).length,
    url: (text.match(/https?:\/\/[^\s)\]>]+/gu) || []).length,
    visible_pandoc_attribute: (text.match(/\{[^}\n]*(?:#[A-Za-z0-9_:-]+|\.[A-Za-z0-9_+-]+|data-[A-Za-z0-9_-]+=|title=)[^}\n]*\}/gu) || []).length
  };
}

function semanticBreakType(block) {
  const value = block.markdown;
  if (/^```[^\n]*\{[^}\n]*\.algorithm\b/u.test(value)) return "algorithm";
  if (/^(?:>\s*)?#{1,6}\s+\{[^}\n]*\.lemma\b/u.test(value)) return "lemma";
  if (/^:::\s*\{[^}\n]*\.remark\b/u.test(value)) return "extension";
  return "";
}

function chars(blocks) {
  return blocks.reduce((total, block) => total + block.markdown.replace(/\s+/gu, "").length, 0);
}

function splitLongSection(section, { maxChars, maxLines }) {
  const totalLines = section.at(-1).line_end - section[0].line_start + 1;
  if (chars(section) <= maxChars && totalLines <= maxLines) {
    return [{ blocks: section, semantic_role: "section", split_reason: "source_heading_boundary" }];
  }
  const segments = [];
  let start = 0;
  let currentRole = "principles";
  for (let index = 1; index < section.length; index += 1) {
    const reason = semanticBreakType(section[index]);
    const current = section.slice(start, index);
    if (!reason || chars(current) < 1600) continue;
    segments.push({ blocks: current, semantic_role: currentRole, split_reason: "long_source_unit_semantic_split" });
    start = index;
    currentRole = reason === "algorithm"
      ? "algorithm_correctness"
      : reason === "lemma"
      ? "efficiency_progress"
      : "topic_extension";
  }
  segments.push({ blocks: section.slice(start), semantic_role: currentRole, split_reason: "long_source_unit_semantic_split" });
  return segments.filter((segment) => segment.blocks.length);
}

function roleSuffix(role, blocks = []) {
  const source = blocks.map((block) => block.markdown).join("\n");
  return {
    principles: "原理与推导",
    algorithm_correctness: "算法与正确性",
    efficiency_progress: "效率分析及后续进展",
    topic_extension: /matrix\s+multiplication/iu.test(source) ? "矩阵乘法扩展" : "扩展注记"
  }[role] || "";
}

function slug(value) {
  const ascii = String(value || "").normalize("NFKD").replace(/[^A-Za-z0-9]+/gu, "-").replace(/^-|-$/gu, "").toLowerCase();
  return ascii.slice(0, 56) || "reading-part";
}

function requestMaterial(request) {
  const source = request?.material ?? request?.input;
  if (typeof source === "string") return { markdown: source, originalMarkdown: "" };
  if (source && typeof source === "object") {
    return {
      markdown: source.markdown ?? source.input ?? "",
      originalMarkdown: source.original_markdown ?? source.originalMarkdown ?? ""
    };
  }
  return { markdown: "", originalMarkdown: "" };
}

export function buildSplitManifest(request, options = {}) {
  const { markdown } = requestMaterial(request);
  const { source } = sourceWithFrontmatterOffset(markdown);
  const blocks = parseSplitSourceBlocks(source);
  if (!blocks.length) throw new Error("split_source_empty");
  const maxChars = Number(options.maxChars || 6500);
  const maxLines = Number(options.maxLines || 120);
  const headingStarts = blocks.map((block, index) => ({ block, index }))
    .filter(({ block }) => block.heading_level === 2)
    .map(({ index }) => index);
  const baseStarts = [0, ...headingStarts.filter((index) => index !== 0)];
  const baseSections = baseStarts.map((start, index) => blocks.slice(start, baseStarts[index + 1] ?? blocks.length));
  const sourceUnits = baseSections.map((section, unitIndex) => {
    const first = section[0];
    const last = section.at(-1);
    const heading = section.find((block) => block.heading_text) || first;
    const sourceHeading = heading.heading_text || `Part ${unitIndex + 1}`;
    return {
      unit_id: `unit-${String(unitIndex + 1).padStart(2, "0")}-${sha256(`${first.source_block_key}:${last.source_block_key}`).slice(0, 8)}`,
      source_title: sourceHeading,
      source_heading: sourceHeading,
      source_heading_level: heading.heading_level || 1,
      blocks: section,
      source_boundary: {
        start: { source_block_key: first.source_block_key, source_index: first.source_index, line: first.line_start },
        end: { source_block_key: last.source_block_key, source_index: last.source_index, line: last.line_end }
      }
    };
  });
  const leafSegments = sourceUnits.flatMap((unit) => {
    const segments = splitLongSection(unit.blocks, { maxChars, maxLines });
    return segments.map((segment, leafIndex) => ({ ...segment, unit, leafIndex, leafCount: segments.length }));
  });
  const splits = leafSegments.map((segment, index) => {
    const first = segment.blocks[0];
    const last = segment.blocks.at(-1);
    const baseHeading = segment.unit.source_heading;
    const suffix = roleSuffix(segment.semantic_role, segment.blocks);
    const defaultTitle = suffix && segment.semantic_role !== "section" ? `${baseHeading} — ${suffix}` : baseHeading;
    const title = options.titleOverrides?.[first.source_block_key] || defaultTitle;
    const suggestedFilename = options.filenameOverrides?.[first.source_block_key]
      || `${String(index + 1).padStart(2, "0")}-${slug(title)}.md`;
    const sourceMarkdown = source.split("\n").slice(first.line_start - 1, last.line_end).join("\n");
    return {
      split_id: `split-${String(index + 1).padStart(2, "0")}-${sha256(`${first.source_block_key}:${last.source_block_key}`).slice(0, 8)}`,
      parent_unit_id: segment.unit.unit_id,
      title,
      source_title: baseHeading,
      source_heading: baseHeading,
      source_heading_level: segment.unit.source_heading_level,
      semantic_role: segment.semantic_role,
      split_reason: segment.split_reason,
      leaf_index: segment.leafIndex + 1,
      leaf_count: segment.leafCount,
      source_boundary: {
        start: { source_block_key: first.source_block_key, source_index: first.source_index, line: first.line_start },
        end: { source_block_key: last.source_block_key, source_index: last.source_index, line: last.line_end }
      },
      estimated_non_whitespace_chars: sourceMarkdown.replace(/\s+/gu, "").length,
      estimated_lines: last.line_end - first.line_start + 1,
      source_block_count: segment.blocks.length,
      special_structures: structureCounts(segment.blocks),
      suggested_filename: suggestedFilename,
      source_sha256: sha256(sourceMarkdown)
    };
  });
  const units = sourceUnits.map((unit) => {
    const leafIds = splits.filter((split) => split.parent_unit_id === unit.unit_id).map((split) => split.split_id);
    return {
      unit_id: unit.unit_id,
      source_title: unit.source_title,
      source_heading: unit.source_heading,
      source_heading_level: unit.source_heading_level,
      source_boundary: unit.source_boundary,
      source_block_count: unit.blocks.length,
      leaf_count: leafIds.length,
      leaf_split_ids: leafIds,
      split_reason: leafIds.length > 1 ? "long_source_unit_semantic_split" : "source_heading_boundary"
    };
  });
  return {
    manifest_version: SPLIT_MANIFEST_VERSION,
    split_policy_version: SPLIT_POLICY_VERSION,
    source_sha256: sha256(source),
    source_type: request.source_type,
    source_url: request.source_metadata?.source_url || request.source_metadata?.canonical_url || null,
    source_block_count: blocks.length,
    reference_labels: Object.fromEntries(collectPandocReferenceLabels(blocks)),
    hierarchy: "source_units_with_semantic_leaves",
    source_unit_count: units.length,
    leaf_split_count: splits.length,
    split_count: splits.length,
    line_basis: "material.markdown, 1-based lines after CRLF normalization; YAML frontmatter is excluded from blocks but counted in line numbers",
    policy: { heading_level: 2, max_chars: maxChars, max_lines: maxLines, semantic_long_section_splitting: true },
    units,
    splits
  };
}

export function buildSplitRequest(parentRequest, manifest, splitId) {
  const split = manifest?.splits?.find((item) => item.split_id === splitId);
  if (!split) throw new Error(`unknown_split_id:${splitId}`);
  const { markdown, originalMarkdown } = requestMaterial(parentRequest);
  const { source } = sourceWithFrontmatterOffset(markdown);
  if (sha256(source) !== manifest.source_sha256) throw new Error("split_manifest_source_hash_mismatch");
  const lines = source.split("\n");
  const childMarkdown = lines.slice(split.source_boundary.start.line - 1, split.source_boundary.end.line).join("\n");
  if (sha256(childMarkdown) !== split.source_sha256) throw new Error(`split_source_hash_mismatch:${splitId}`);
  if (originalMarkdown && sha256(String(originalMarkdown).replace(/\r\n?/gu, "\n")) !== sha256(source)) {
    throw new Error("split_bilingual_original_mapping_required");
  }
  return {
    schema_version: parentRequest.schema_version,
    contract_version: parentRequest.contract_version,
    material: originalMarkdown ? { markdown: childMarkdown, original_markdown: childMarkdown } : { markdown: childMarkdown },
    source_type: parentRequest.source_type,
    source_metadata: {
      ...structuredClone(parentRequest.source_metadata || {}),
      title: split.title,
      split: {
        manifest_version: manifest.manifest_version,
        split_id: split.split_id,
        parent_unit_id: split.parent_unit_id,
        source_heading: split.source_heading,
        source_heading_level: split.source_heading_level,
        split_reason: split.split_reason,
        leaf_index: split.leaf_index,
        leaf_count: split.leaf_count,
        parent_source_sha256: manifest.source_sha256,
        source_boundary: split.source_boundary,
        reference_labels: structuredClone(manifest.reference_labels || {})
      }
    },
    user_instruction: `${String(parentRequest.user_instruction || "").trim()}\n本次仅处理该语义分篇；阅读前置卡和核心洞察必须只覆盖本分篇，洞察跳转只能指向本分篇正文。`.trim(),
    processing_options: {
      ...structuredClone(parentRequest.processing_options || {}),
      ...(parentRequest.source_metadata?.content_profile === "math_lecture" ? { normalize_semantic_containers: true } : {})
    }
  };
}
