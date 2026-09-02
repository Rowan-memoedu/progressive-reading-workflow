export const MATH_LECTURE_CONTENT_PROFILE = "math_lecture";
export const MATH_LECTURE_PROFILE_VERSION = "math-lecture-translation/v2";
export const MATH_LECTURE_PROMPT_VERSION = "math-lecture-translation-v2.0-domain-term-preserving";
export const MATH_LECTURE_STANDARDIZATION_PROFILE_VERSION = "math-lecture-standardization/v1";
export const MATH_LECTURE_STANDARDIZATION_PROMPT_VERSION = "math-lecture-standardization-v1.0-atomic-safe";

const DISPLAY_MATH_PATTERN = /\$\$[\s\S]*?\$\$/gu;
const INLINE_MATH_PATTERN = /(?<!\\)\$(?!\$)(?:\\.|[^$\n])+(?<!\\)\$/gu;
const FENCED_CODE_PATTERN = /```[\s\S]*?```|~~~[\s\S]*?~~~/gu;
const INLINE_CODE_PATTERN = /(?<!`)(`+)(?!`)([^\n]*?)(?<!`)\1(?!`)/gu;

export const MATH_LECTURE_TERMINOLOGY_POLICY = "preserve-source-terms/v1";

export const MATH_LECTURE_GLOSSARY_PROMPT = [
  "先识别本材料中的领域术语、定义项、命名算法、数据结构、理论概念、人名、缩写和原文标签，再翻译一般叙述。",
  "识别出的术语在译文中保留英文原文和原有大小写；不得自行发明中文译名，也不得只因常见就漏掉 algorithm、data structure 一类基础专业概念。",
  "只有调用方提供 approved_translation 时才可在首次出现处附加中文说明；没有批准译名时只保留英文原文。",
  "拿不准某个词是否有稳定译法时保留原文。引号中的术语、标签或作者刻意使用的表达也保留原文，不把隐喻擅自改造成术语译名。",
  "公式、代码和算法原子块继续逐字保护；术语保护不得改变公式、Markdown 结构或作者视角。"
].join("\n");

function uniqueTerms(values) {
  return [...new Set((values || [])
    .map((value) => String(value || "").trim())
    .filter((value) => value.length >= 2 && value.length <= 96 && /[A-Za-z]/u.test(value)))]
    .sort((left, right) => right.length - left.length || left.localeCompare(right, "en"));
}

function proseWithoutProtectedSyntax(markdown) {
  return String(markdown || "")
    .replace(FENCED_CODE_PATTERN, "")
    .replace(DISPLAY_MATH_PATTERN, "")
    .replace(INLINE_MATH_PATTERN, "")
    .replace(INLINE_CODE_PATTERN, "");
}

export function collectMathLectureTerminologyCandidates(blocks, suppliedTerms = []) {
  const candidates = [...(suppliedTerms || [])];
  for (const block of blocks || []) {
    if (mathLectureAtomicKind(block)) continue;
    const prose = proseWithoutProtectedSyntax(block.markdown);
    for (const match of prose.matchAll(/(?<!_)_([^_\n]{2,96})_(?!_)/gu)) candidates.push(match[1]);
    for (const match of prose.matchAll(/(?<!\*)\*\*([^*\n]{2,96})\*\*(?!\*)/gu)) candidates.push(match[1]);
    for (const match of prose.matchAll(/["“]([A-Za-z][A-Za-z0-9'’+./ -]{1,94})["”]/gu)) candidates.push(match[1]);
    for (const match of prose.matchAll(/\b(?:[A-Z]{2,}[A-Za-z0-9]*|[A-Z][a-z]+(?:[- ][A-Z][a-z]+)+)\b/gu)) candidates.push(match[0]);
  }
  return uniqueTerms(candidates);
}

export function sanitizeDiscoveredMathLectureTerms(blocks, discoveredTerms = []) {
  const source = (blocks || []).map((block) => String(block.markdown || "")).join("\n");
  return uniqueTerms(discoveredTerms).filter((term) => {
    if (!source.includes(term)) return false;
    if (term.trim().split(/\s+/u).length > 8) return false;
    if (/\n|ZXQ[A-Z0-9]+QXZ/u.test(term)) return false;
    return true;
  });
}

export function normalizeMathLectureInlineMathSpacing(markdown) {
  let value = String(markdown || "");
  const protectedValues = [];
  const protect = (pattern) => {
    value = value.replace(pattern, (match) => {
      const token = `ZXQMLP${String(protectedValues.length).padStart(4, "0")}QXZ`;
      protectedValues.push({ token, value: match });
      return token;
    });
  };
  protect(FENCED_CODE_PATTERN);
  protect(INLINE_CODE_PATTERN);
  protect(DISPLAY_MATH_PATTERN);
  value = value.replace(INLINE_MATH_PATTERN, (span, offset, input) => {
    const left = [...input.slice(0, offset)].at(-1) || "";
    const right = [...input.slice(offset + span.length)][0] || "";
    return `${/\p{Script=Han}/u.test(left) ? " " : ""}${span}${/\p{Script=Han}/u.test(right) ? " " : ""}`;
  });
  for (const item of protectedValues) value = value.replace(item.token, () => item.value);
  return value;
}

export function normalizeMathLectureTermSpacing(markdown, terms = []) {
  let value = String(markdown || "");
  const protectedValues = [];
  const protect = (pattern) => {
    value = value.replace(pattern, (match) => {
      const token = `ZXQMLT${String(protectedValues.length).padStart(4, "0")}QXZ`;
      protectedValues.push({ token, value: match });
      return token;
    });
  };
  protect(FENCED_CODE_PATTERN);
  protect(INLINE_CODE_PATTERN);
  protect(DISPLAY_MATH_PATTERN);
  protect(INLINE_MATH_PATTERN);
  for (const term of uniqueTerms(terms)) {
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    value = value.replace(new RegExp(escaped, "gu"), (match, offset, input) => {
      const left = [...input.slice(0, offset)].at(-1) || "";
      const right = [...input.slice(offset + match.length)][0] || "";
      return `${/\p{Script=Han}/u.test(left) ? " " : ""}${match}${/\p{Script=Han}/u.test(right) ? " " : ""}`;
    });
  }
  for (const item of protectedValues) value = value.replace(item.token, () => item.value);
  return value;
}

export function normalizeMathLectureReadingTerminology({ title, semantic, bodyBlocks, sourceBlocks, terms = [] }) {
  const sourceByKey = new Map((sourceBlocks || []).map((block) => [block.source_block_key, block]));
  const normalizeText = (value) => normalizeMathLectureTermSpacing(value, terms);
  const normalizedSemantic = structuredClone(semantic);
  for (const key of ["value", "density", "continue_reading"]) {
    if (normalizedSemantic?.judgments?.[key]) normalizedSemantic.judgments[key].reason = normalizeText(normalizedSemantic.judgments[key].reason);
  }
  normalizedSemantic.insights = (normalizedSemantic.insights || []).map((insight) => ({
    ...insight,
    title: normalizeText(insight.title),
    description: normalizeText(insight.description)
  }));
  const normalizedBodyBlocks = (bodyBlocks || []).map((block) => {
    const sourceKeys = block.source_block_keys || [block.source_block_key];
    const atomic = sourceKeys.some((key) => mathLectureAtomicKind(sourceByKey.get(key)));
    return atomic ? structuredClone(block) : { ...structuredClone(block), markdown: normalizeText(block.markdown) };
  });
  return { title: normalizeText(title), semantic: normalizedSemantic, bodyBlocks: normalizedBodyBlocks };
}

export function isMathLectureProfile(metadata) {
  return metadata?.content_profile === MATH_LECTURE_CONTENT_PROFILE;
}

export function mathSpans(markdown) {
  const value = String(markdown || "");
  const display = value.match(DISPLAY_MATH_PATTERN) || [];
  const withoutDisplay = value.replace(DISPLAY_MATH_PATTERN, "");
  const inline = withoutDisplay.match(INLINE_MATH_PATTERN) || [];
  return { display, inline, all: [...display, ...inline] };
}

export function mathLectureAtomicKind(block) {
  if (block?.translation_scope === "atomic_preserve" && block?.semantic_kind === "algorithm") return "algorithm";
  if (block?.type === "code") return "code";
  const markdown = String(block?.markdown || "");
  const spans = mathSpans(markdown);
  if (!spans.all.length) return null;
  const remainder = markdown
    .replace(DISPLAY_MATH_PATTERN, "")
    .replace(INLINE_MATH_PATTERN, "")
    .replace(/^\s*(?:#{1,6}|>|[-*+]|\d+[.)])\s*/gmu, "")
    .replace(/<!--[\s\S]*?-->/gu, "")
    .replace(/[\s\p{P}\p{S}]/gu, "");
  return remainder ? null : "formula";
}

export function buildMathLectureCoverage(blocks) {
  const coverage = { translated_prose_blocks: 0, preserved_formula_blocks: 0, preserved_formula_spans: 0, preserved_code_blocks: 0, preserved_algorithm_blocks: 0, preserved_terms: [] };
  for (const block of blocks || []) {
    const spans = mathSpans(block.markdown);
    if (spans.all.length) {
      coverage.preserved_formula_blocks += 1;
      coverage.preserved_formula_spans += spans.all.length;
    }
    const atomic = mathLectureAtomicKind(block);
    if (atomic === "code") coverage.preserved_code_blocks += 1;
    else if (atomic === "algorithm") coverage.preserved_algorithm_blocks += 1;
    else if (atomic !== "formula") coverage.translated_prose_blocks += 1;
  }
  return coverage;
}

export function collectPreservedMathLectureTerms(sourceBlocks, outputBlocks, terms = []) {
  const source = (sourceBlocks || []).map((block) => block.markdown).join("\n");
  const output = (outputBlocks || []).map((block) => block.markdown).join("\n");
  return uniqueTerms(terms).filter((term) => source.includes(term) && output.includes(term));
}

export function stripAllowedMathLectureTerms(markdown, terms = []) {
  let value = String(markdown || "");
  for (const term of uniqueTerms(terms)) value = value.split(term).join("");
  return value;
}

export function validateMathLectureTerminology(sourceMarkdown, outputMarkdown, terms = []) {
  const source = String(sourceMarkdown || "");
  const output = String(outputMarkdown || "");
  const failures = [];
  for (const term of uniqueTerms(terms)) {
    const sourceCount = source.split(term).length - 1;
    if (!sourceCount) continue;
    const outputCount = output.split(term).length - 1;
    if (outputCount !== sourceCount) failures.push(`preserved_term_count_${term.replace(/[^A-Za-z0-9]+/gu, "_")}`);
  }
  return failures;
}
