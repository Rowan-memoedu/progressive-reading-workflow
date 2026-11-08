import path from 'node:path';
import { createHash } from 'node:crypto';
import { assetReference } from './book-folder.mjs';

export const BOOK_MEDIA_VERSION = 'book-media-preservation/v2';
export const sha256 = value => createHash('sha256').update(value).digest('hex');
const seconds = value => String(value).split(':').reduce((sum, n) => sum * 60 + Number(n), 0);
const normalized = value => String(value).normalize('NFKC').replace(/[^\p{L}\p{N}]/gu, '').toLowerCase();
export const assetUrl = (_slug, name) => assetReference(name);
export const imageEmbed = (label, name, slug = '') => `![${safeLabel(label || '视频截图')}](${assetUrl(slug,name)})`;
const safeLabel = value => value.replace(/[\[\]\\]/gu, '\\$&');

export function localPath(value) {
  let name = String(value).trim().replace(/^<|>$/gu, '').replace(/\s+["'][\s\S]*$/u, '').split(/[?#]/u)[0];
  if (/^(?:[a-z][\w+.-]*:|\/|#)/iu.test(name)) return null;
  try { name = decodeURIComponent(name); } catch { return null; }
  name = path.posix.normalize(name.replace(/\\/gu, '/'));
  return name === '..' || name.startsWith('../') ? null : name.replace(/^\.\//u, '');
}

// Read native blocks literally. Never parse examples inside another code fence
// as media, and never use the upstream generated lecture as replacement prose.
export function extractBookMedia(bookMarkdown, inventory) {
  const book = String(bookMarkdown);
  const known = new Set(inventory.map(item => item.path));
  const events = [];
  const lines = [...book.matchAll(/[^\n]*(?:\n|$)/gu)].filter(match => match[0]);
  for (let i = 0; i < lines.length; i++) {
    const match = lines[i];
    const line = match[0].replace(/\r?\n$/u, '');
    const fence = /^ {0,3}(`{3,}|~{3,})([^\r\n]*)$/u.exec(line);
    if (fence) {
      const close = new RegExp('^ {0,3}' + fence[1][0] + '{' + fence[1].length + ',}\\s*$');
      const first = i;
      while (++i < lines.length && !close.test(lines[i][0].trimEnd())) { /* literal fenced content */ }
      if (i === lines.length) throw new Error('book_media_unclosed_fence');
      if (fence[2].trim().toLowerCase() === 'mermaid') {
        const literal = book.slice(lines[first].index, lines[i].index + lines[i][0].replace(/\r?\n$/u, '').length);
        events.push({ kind: 'mermaid', offset: match.index, line: first + 1, literal, sha256: sha256(literal) });
      }
      continue;
    }
    const heading = /^(#{1,6})\s+(.+)$/u.exec(line);
    if (heading) events.push({ kind: 'heading', offset: match.index, level: heading[1].length, title: heading[2] });
    const time = /参考时间\s*[:：]\s*((?:\d+:)?\d+:\d+(?:\.\d+)?)/u.exec(line);
    if (time) events.push({ kind: 'time', offset: match.index, seconds: seconds(time[1]) });
    for (const image of line.matchAll(/!\[([^\]\n]*)\]\((<[^>\n]+>|[^)\n]+)\)/gu)) {
      const name = localPath(image[2]);
      if (!name) throw new Error(`book_media_nonlocal_image:${i + 1}`);
      if (!known.has(name)) throw new Error(`book_media_missing_asset:${name}`);
      const captured = /(?:shot|screenshot)[_-](\d{2})[_-](\d{2})[_-](\d{2})(?:\D|$)/iu.exec(name);
      events.push({ kind: 'image', offset: match.index + image.index, line: i + 1, path: name, label: image[1],
        seconds: captured ? seconds(captured.slice(1, 4).join(':')) : null });
    }
  }
  return events.filter(item => ['image', 'mermaid'].includes(item.kind)).map(item => {
    const heading = events.findLast(event => event.kind === 'heading' && event.offset < item.offset);
    const sectionEnd = events.find(event => event.kind === 'heading' && event.offset > item.offset && event.level <= (heading?.level || 0))?.offset ?? book.length;
    const nearby = events.filter(event => event.offset > (heading?.offset ?? -1) && event.offset < sectionEnd);
    const previousTime = events.findLast(event => event.kind === 'time' && event.offset < item.offset);
    const timedImages = nearby.filter(event => event.kind === 'image' && event.seconds !== null);
    // A native diagram has no capture time. Its adjacent illustration within the
    // same source section provides a tighter anchor than the chapter start.
    const imageAnchor = timedImages.findLast(event => event.offset < item.offset) || timedImages.find(event => event.offset > item.offset);
    const anchor = item.kind === 'image' && item.seconds !== null ? item :
      item.kind === 'mermaid' && imageAnchor ? imageAnchor : previousTime;
    if (!anchor || !Number.isFinite(anchor.seconds)) throw new Error(`book_media_no_time_anchor:${item.line}`);
    return { ...item, id: `${item.kind}:${item.line}:${sha256(item.literal || item.path).slice(0, 12)}`,
      seconds: anchor.seconds, time_evidence: anchor === item ? 'capture_filename' : anchor.kind === 'image' ? 'same_section_image' : 'source_reference_time',
      section: heading?.title || '' };
  });
}

function contentParagraphs(markdown) {
  const bodyMarker = /^## 正文\s*$/mu.exec(markdown);
  const start = bodyMarker ? bodyMarker.index + bodyMarker[0].length : 0;
  const fences = [...markdown.matchAll(/^(?:`{3,}|~{3,})[^\n]*\n[\s\S]*?^(?:`{3,}|~{3,})[ \t]*\r?$/gmu)].map(m => [m.index, m.index + m[0].length]);
  return [...markdown.matchAll(/[^\r\n]+(?:\r?\n(?!\r?\n)[^\r\n]+)*/gu)]
    .filter(m => m.index >= start && !fences.some(([a, b]) => m.index >= a && m.index < b))
    .map(m => ({ offset: m.index, end: m.index + m[0].length,
      text: normalized(m[0].replace(/^#{1,6} .*$/gmu, '').replace(/^\^pr-[\w-]+\s*$/gmu, '')) }))
    .filter(item => item.text.length > 0);
}

function locateBlock(markdown, block, candidates) {
  if (Number.isInteger(block.reading_offset)) {
    if (markdown.slice(block.reading_offset, block.reading_offset + block.markdown.length) !== block.markdown) throw new Error('book_media_source_offset_changed');
    return { end: block.reading_offset + block.markdown.length, method: 'source_caption_offset', matched_spans: [] };
  }
  const bodyMarker=/^## 正文\s*$/mu.exec(markdown);
  const bodyStart=bodyMarker ? bodyMarker.index+bodyMarker[0].length : 0;
  const roots=/^#{2,6} /mu.test(markdown.slice(bodyStart)) ? [] : [...markdown.matchAll(/^- (.+)$/gmu)].filter(item=>item.index>=bodyStart);
  if(roots.length) {
    const heading=normalized(block.reference_heading || '');
    const topics=roots.map((item,index)=>({heading:normalized(item[1].replace(/\s+\^pr-[\w-]+\s*$/u,'')),offset:item.index,end:roots[index+1]?.index??markdown.length}));
    const matches=heading ? topics.filter(item=>item.heading===heading) : [];
    const topic=matches.length===1 ? matches[0] : block.source_opening ? topics[0] : null;
    if(!topic) throw new Error(`book_media_ambiguous_topic_anchor:${block.source_block_key}`);
    return {end:topic.offset+markdown.slice(topic.offset,topic.end).trimEnd().length,
      method:'source_topic_heading',matched_spans:[block.reference_heading || 'source opening']};
  }
  const exact = markdown.indexOf(block.markdown, bodyStart);
  if (exact >= 0 && exact === markdown.lastIndexOf(block.markdown)) {
    const end = exact + block.markdown.length;
    const paragraph = candidates.find(candidate => candidate.offset < end && candidate.end >= end);
    return { end: paragraph?.end || end, method: 'exact_source_block', matched_spans: [] };
  }
  const reference = normalized(block.markdown.replace(/^#{1,6} .*$/gmu, '').replace(/^\^pr-[\w-]+\s*$/gmu, ''));
  const spans = new Set();
  for (let index = 0; index + 24 <= reference.length; index += 12) spans.add(reference.slice(index, index + 24));
  const matches = candidates.map(candidate => ({ ...candidate, matched_spans: [...spans].filter(span => candidate.text.includes(span)) }))
    .filter(candidate => candidate.matched_spans.length >= 2)
    .sort((a, b) => b.matched_spans.length - a.matched_spans.length);
  if (!matches.length || (matches[1] && matches[0].matched_spans.length === matches[1].matched_spans.length)) {
    throw new Error(`book_media_ambiguous_body_anchor:${block.source_block_key}`);
  }
  return { ...matches[0], method: 'source_block_exact_spans' };
}

export function nativeMermaidBlocks(markdown) {
  const lines=String(markdown).split('\n');
  const blocks=[];
  for(let i=0;i<lines.length;i++) {
    const open=/^([ \t]*)(-\s+)?(`{3,}|~{3,})([^\r\n]*)\r?$/u.exec(lines[i]);
    if(!open) continue;
    const first=i;
    const indent=open[1].length+(open[2]?.length||0);
    const close=new RegExp('^[ \\t]*'+open[3][0]+'{'+open[3].length+',}[ \\t]*\\r?$');
    while(++i<lines.length&&!close.test(lines[i])) { /* native code */ }
    if(i===lines.length) throw new Error('rendered_mermaid_unclosed_fence');
    if(open[4].trim().toLowerCase()!=='mermaid') continue;
    const canonical=lines.slice(first,i+1).map((line,index)=>{
      if(index===0) return line.slice(indent);
      if(indent&&!line.startsWith(' '.repeat(indent))) throw new Error('rendered_mermaid_invalid_list_indent');
      return line.slice(indent);
    }).join('\n');
    blocks.push(canonical);
  }
  return blocks;
}

export function verifyBookMedia(markdown, units, slug) {
  const required = new Map();
  const diagrams=nativeMermaidBlocks(markdown);
  for (const item of units) {
    const literal = item.kind === 'mermaid' ? item.literal : imageEmbed(item.label,item.path,slug);
    required.set(literal, (required.get(literal) || 0) + 1);
  }
  for (const [literal, count] of required) {
    const actual=literal.match(/^ {0,3}(?:```|~~~)mermaid/iu) ? diagrams.filter(value=>value===literal).length : markdown.split(literal).length-1;
    if (actual !== count) throw new Error('book_media_missing_changed_or_duplicated');
  }
  return { images: units.filter(item => item.kind === 'image').length, mermaid: units.filter(item => item.kind === 'mermaid').length };
}

export function removeMediaInsertions(markdown, insertions) {
  let restored = markdown;
  for (const item of [...insertions].reverse()) {
    if (restored.slice(item.output_offset, item.output_offset + item.text.length) !== item.text) throw new Error('book_media_insertion_changed');
    restored = restored.slice(0, item.output_offset) + restored.slice(item.output_offset + item.text.length);
  }
  return restored;
}

export function projectBookMedia({ readingMarkdown, bookMarkdown, inventory, slug, paragraphs, sourceNodes, bodyBlocks }) {
  const original = String(readingMarkdown);
  const units = extractBookMedia(bookMarkdown, inventory);
  const starts = paragraphs.map(item => seconds(item.start));
  const candidates = contentParagraphs(original);
  const additions = new Map();
  const placements = [];
  const existingCounts = new Map();
  for (const item of units) {
    const literal = item.kind === 'mermaid' ? item.literal : imageEmbed(item.label,item.path,slug);
    const usedCount = existingCounts.get(literal) || 0;
    if (original.split(literal).length - 1 > usedCount) {
      existingCounts.set(literal, usedCount + 1);
      placements.push({ ...item, literal: undefined, method: 'already_present' });
      continue;
    }
    const index = starts.findLastIndex(time => time <= item.seconds);
    if (index < 0) throw new Error(`book_media_outside_caption_range:${item.id}`);
    const sourceId = paragraphs.length === sourceNodes.length ? sourceNodes[index]?.id :
      sourceNodes.find(node => normalized(node.text) === normalized(paragraphs[index]?.text))?.id;
    const block = bodyBlocks.find(value => (value.source_block_keys || [value.source_block_key]).includes(sourceId));
    if (!block) throw new Error(`book_media_unmapped_caption:${item.id}`);
    const blockIndex=bodyBlocks.indexOf(block);
    const referenceHeading=[...bodyBlocks.slice(0,blockIndex+1).flatMap(value=>[...value.markdown.matchAll(/^#{1,3} (.+)$/gmu)].map(match=>match[1]))].at(-1);
    const found = locateBlock(original,{...block,reference_heading:referenceHeading,source_opening:index===0},candidates);
    // Keep an existing paragraph's navigation anchor attached to its prose.
    const anchor = /^\r?\n\r?\n\^pr-[\w-]+[ \t]*(?=\r?\n|$)/u.exec(original.slice(found.end));
    const offset = found.end + (anchor?.[0].length || 0);
    additions.set(offset, [...(additions.get(offset) || []), { item, literal }]);
    placements.push({ ...item, literal: undefined, source_id: sourceId, source_block_sha256: sha256(block.markdown),
      method: found.method, matched_spans: found.matched_spans, offset });
  }
  let markdown = original;
  const insertions = [];
  let shift = 0;
  for (const [offset, items] of [...additions].sort(([a], [b]) => a - b)) {
    const text = '\n\n' + items.map(item => item.literal).join('\n\n');
    insertions.push({ input_offset: offset, output_offset: offset + shift, text, media_ids: items.map(value => value.item.id) });
    shift += text.length;
  }
  for (const item of [...insertions].reverse()) markdown = markdown.slice(0, item.input_offset) + item.text + markdown.slice(item.input_offset);
  if (removeMediaInsertions(markdown, insertions) !== original) throw new Error('book_media_changed_prose');
  const counts = verifyBookMedia(markdown, units, slug);
  return { markdown, version: BOOK_MEDIA_VERSION, input_sha256: sha256(original), output_sha256: sha256(markdown),
    book_sha256: sha256(bookMarkdown), prose_unchanged: true, counts, insertions, placements,
    used_attachments: [...new Set(units.filter(item => item.kind === 'image').map(item => item.path))].sort() };
}

export function captionMediaSource({ markdown, paragraphs, ...options }) {
  let offset = 0;
  const sourceNodes = paragraphs.map((item, index) => ({ id: `caption-${index + 1}`, text: item.text }));
  const bodyBlocks = paragraphs.map((item, index) => {
    const block = { source_block_key: sourceNodes[index].id, markdown: item.text, reading_offset: offset };
    offset += item.text.length + 2;
    return block;
  });
  if (paragraphs.map(item => item.text).join('\n\n') !== markdown) throw new Error('book_media_caption_source_changed');
  return projectBookMedia({ ...options, readingMarkdown: markdown, paragraphs, sourceNodes, bodyBlocks });
}
