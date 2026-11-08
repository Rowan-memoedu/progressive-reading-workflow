export const TRANSLATION_UNIT_VERSION = "semantic-continuous-v13-anchored-bibliographies";

// Headings define semantic sections; list runs stay with their introducing prose.
export function chunkTranslationUnits(blocks, { maxChars = 12000 } = {}) {
  const units = [];
  for (let index = 0; index < blocks.length; index += 1) {
    const unit = [blocks[index]];
    if (blocks[index].type === "heading" && index + 1 < blocks.length) {
      unit.push(blocks[++index]);
    }
    while (index + 1 < blocks.length && blocks[index + 1].type === "list") unit.push(blocks[++index]);
    units.push(unit);
  }
  const chunks = [];
  let current = [], size = 0;
  for (const unit of units) {
    const chars = unit.reduce((sum, block) => sum + String(block.markdown).length, 0);
    const heading = unit[0].type === "heading";
    if (current.length && ((heading && size >= maxChars / 2) || size + chars > maxChars)) {
      chunks.push(current);
      current = []; size = 0;
    }
    current.push(...unit); size += chars;
  }
  if (current.length) chunks.push(current);
  return chunks;
}

const marker = index => `ZXQSEG${String(index).padStart(6, "0")}QXZ`;
export function continuousTranslationInput(blocks, protectedByKey) {
  return blocks.map((block, index) =>
    marker(index) + "\n" + protectedByKey.get(block.source_block_key).protectedMarkdown
  ).join("\n\n");
}

export function decodeContinuousTranslation(output, blocks) {
  // Accept the previous structured response shape for existing adapters.
  if (Array.isArray(output?.translations)) return output;
  if (typeof output?.markdown !== "string") return { translations: [] };
  const matches = [...output.markdown.matchAll(/ZXQSEG\d{6}QXZ/gu)];
  if (JSON.stringify(matches.map(m => m[0])) !== JSON.stringify(blocks.map((_, index) => marker(index)))) {
    return { translations: [] };
  }
  if (output.markdown.slice(0, matches[0]?.index || 0).trim()) return { translations: [] };
  return { translations: blocks.map((block, index) => ({
    source_block_key: block.source_block_key,
    markdown: output.markdown.slice(
      matches[index].index + matches[index][0].length,
      index + 1 < matches.length ? matches[index + 1].index : undefined
    ).replace(/^\r?\n/u, "").replace(/\s+$/u, "")
  })) };
}
