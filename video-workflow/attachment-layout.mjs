import path from 'node:path';
import { projectBookMedia } from './book-media.mjs';
import { assetReference,isImage } from './book-folder.mjs';

export const ATTACHMENT_LAYOUT_VERSION = 'obsidian-book-folder/v1';
const referencePattern = /(!?)\[([^\]\n]*)\]\((<[^>\n]+>|[^)\n]+)\)/gu;
const localPath = value => {
  let name = String(value).trim().replace(/^<|>$/gu, '').replace(/\s+["'][\s\S]*$/u, '').split(/[?#]/u)[0];
  if (/^(?:[a-z][\w+.-]*:|\/|#)/iu.test(name)) return null;
  try { name = decodeURIComponent(name); } catch { return null; }
  name = path.posix.normalize(name.replace(/\\/gu, '/'));
  return name === '..' || name.startsWith('../') ? null : name.replace(/^\.\//u, '');
};
const safeLabel = label => label.replace(/[\[\]\\]/gu, '\\$&');
const assetUrl = (_slug, name) => assetReference(name);

export function layoutInlineAttachments({ readingMarkdown, sourceMarkdown, bookMarkdown = '', inventory,
  slug, paragraphs, sourceNodes, bodyBlocks }) {
  const known = new Set(inventory.map(record => record.path));
  const used = new Set();
  const placements = [];
  let markdown = String(readingMarkdown);
  const explicit = new Set([...String(sourceMarkdown).matchAll(referencePattern)].map(match => localPath(match[3])).filter(name => known.has(name)));
  // Images are embedded in the body, opaque files retain ordinary links, and
  // Markdown-native diagrams/math never become file attachments.
  const rewriteInline = content => content.split(/(```[\s\S]*?```|~~~[\s\S]*?~~~)/gu).map(part => {
    if (/^(?:```|~~~)/u.test(part)) return part;
    return part.replace(referencePattern, (full, _image, label, destination) => {
      const name = localPath(destination);
      if (!explicit.has(name)) return full;
      used.add(name);
      placements.push({path:name,method:'source_inline_reference'});
      return `${isImage(name)?'!':''}[${safeLabel(label || path.posix.basename(name))}](${assetUrl(slug,name)})`;
    });
  }).join('');

  markdown = rewriteInline(markdown);
  const media = bookMarkdown ? projectBookMedia({readingMarkdown:markdown,bookMarkdown,inventory,slug,paragraphs,sourceNodes,bodyBlocks}) : null;
  if (media) {
    markdown = media.markdown;
    for (const name of media.used_attachments) used.add(name);
    placements.push(...media.placements);
  }
  return {markdown,version:ATTACHMENT_LAYOUT_VERSION,used_attachments:[...used].sort(),placements,book_media:media};
}
