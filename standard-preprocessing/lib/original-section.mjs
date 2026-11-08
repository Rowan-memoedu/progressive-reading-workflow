const ORIGINAL_SEPARATOR = "\n---\n\n## 原文\n";
const ORIGINAL_CALLOUT = "> [!quote]- 原文";
const trimBlankLines = markdown => String(markdown || "").replace(/^(?:[ \t]*\r?\n)+|(?:\r?\n[ \t]*)+$/gu, "");

// Remove only our presentation wrapper; source quotes and indentation stay intact.
export function unwrapPublishedOriginal(markdown) {
  const section = trimBlankLines(markdown);
  if (!section.startsWith(`${ORIGINAL_CALLOUT}\n`)) return section;
  const lines = section.slice(ORIGINAL_CALLOUT.length + 1).split("\n");
  if (!lines.every(line => line === ">" || line.startsWith("> "))) return section;
  return lines.map(line => line === ">" ? "" : line.slice(2)).join("\n");
}

export function foldPublishedOriginal(markdown) {
  const bodyStart = markdown.indexOf("\n## 正文\n");
  const originalStart = markdown.indexOf(ORIGINAL_SEPARATOR, bodyStart);
  if (bodyStart < 0 || originalStart < 0) return markdown;
  const contentStart = originalStart + ORIGINAL_SEPARATOR.length;
  const original = trimBlankLines(markdown.slice(contentStart));
  if (!original || unwrapPublishedOriginal(original) !== original) return markdown;
  const quoted = original.split("\n").map(line => line ? `> ${line}` : ">").join("\n");
  return `${markdown.slice(0, contentStart)}\n${ORIGINAL_CALLOUT}\n${quoted}\n`;
}
