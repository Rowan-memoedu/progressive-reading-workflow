// A continuous outline is a sequence of top-level subtrees, not one paragraph.
// Return null for mixed prose so ordinary Markdown keeps its existing grouping.
export function splitOutlineSubtrees(markdown, {maxSubtreeCharacters = 1600} = {}) {
  const lines = String(markdown).replace(/\r\n?/gu, '\n').split('\n');
  const starts = [];
  const items = [];
  let fence = null;
  let math = false;
  let hasItem = false;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (fence) {
      if (new RegExp(`^\\s*${fence.char}{${fence.length},}\\s*$`, 'u').test(line)) fence = null;
      continue;
    }
    if (math) {
      if (/^\s*\$\$\s*$/u.test(line)) math = false;
      continue;
    }
    if (!line.trim()) continue;
    const opening = /^\s*(?:[-*+]\s+)?(`{3,}|~{3,})/u.exec(line);
    if (opening && (hasItem || /^[-*+]\s+/u.test(line))) {
      const item = /^(\s*)[-*+]\s+/u.exec(line);
      if (item) items.push({line: index, indent: item[1].length});
      if (/^[-*+]\s+/u.test(line)) { starts.push(index); hasItem = true; }
      fence = {char: opening[1][0], length: opening[1].length};
      continue;
    }
    if (/^\s*(?:[-*+]\s+)?\$\$\s*$/u.test(line) && (hasItem || /^[-*+]\s+/u.test(line))) {
      const item = /^(\s*)[-*+]\s+/u.exec(line);
      if (item) items.push({line:index,indent:item[1].length});
      if (/^[-*+]\s+/u.test(line)) { starts.push(index); hasItem = true; }
      math = true; continue;
    }
    if (/^#{1,6}\s+/u.test(line) && !hasItem) { starts.push(index); continue; }
    const item = /^(\s*)[-*+]\s+/u.exec(line);
    if (item) {
      items.push({line: index, indent: item[1].length});
      if (!item[1]) { starts.push(index); hasItem = true; }
      else if (!hasItem) return null;
      continue;
    }
    if (hasItem && /^[ \t]+\S/u.test(line)) continue;
    return null;
  }
  if (!hasItem || fence || math) return null;
  const literal = (start, end) => lines.slice(start, end).join('\n').replace(/^\n+|\n+$/gu, '');
  const divide = (start, end) => {
    const text = literal(start, end);
    if (text.length <= maxSubtreeCharacters) return [text];
    const parent = items.find(item => item.line === start);
    if (!parent) return [text];
    const descendants = items.filter(item => item.line > start && item.line < end && item.indent > parent.indent);
    if (!descendants.length) return [text];
    const childIndent = Math.min(...descendants.map(item => item.indent));
    const children = descendants.filter(item => item.indent === childIndent).map(item => item.line);
    // Keep a whole list/code/math item intact. Split only at existing child items.
    return [literal(start, children[0]), ...children.flatMap((child, index) => divide(child, children[index + 1] ?? end))];
  };
  return starts.flatMap((start, index) => divide(start, starts[index + 1] ?? lines.length));
}
