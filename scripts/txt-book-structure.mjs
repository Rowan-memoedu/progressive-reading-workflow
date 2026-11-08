import crypto from 'node:crypto';

export const TXT_BOOK_VERSION = 'progressive-reading.txt-book/v1';
export const TXT_BOOK_SPLIT_POLICY = 'uniform-sibling-granularity-v1';
export const sha256 = text => crypto.createHash('sha256').update(text, 'utf8').digest('hex');
const numerals = '[一二三四五六七八九十百零〇两0-9０-９]+';

export function discoverTxtBookHeadings(markdown, overrides = []) {
  const lines = markdown.replace(/\r\n?/gu, '\n').split('\n');
  const headings = [];
  let context = '', appendixGroup = false;
  for (let index = 0; index < lines.length; index++) {
    const title = lines[index].trim();
    let level = null;
    if (title.length <= 100 && new RegExp(`^第${numerals}章.+`, 'u').test(title)) {
      level = 1; context = 'chapter';
    } else if (context === 'chapter' && title.length <= 100 && new RegExp(`^第${numerals}节.+`, 'u').test(title)) {
      level = 2;
    } else if (/^(?:修订版|修订|再版|新版)?(?:前言|序言|导言|绪论|引言|后记|结语|结束语)[：:]?$/u.test(title)) {
      level = 1; context = 'front';
    } else if (context === 'front' && title.length <= 80 && /^[0-9０-９]+[、．.]\s*\S/u.test(title)) {
      level = 2;
    } else if (/^附录[：:]?$/u.test(title)) {
      level = 1; context = 'appendix'; appendixGroup = true;
    } else if (title.length <= 100 && new RegExp(`^附录${numerals}[：:].+`, 'u').test(title)) {
      level = appendixGroup ? 2 : 1; context = 'appendix-item';
    } else if (context === 'appendix-item' && new RegExp(`^[（(]${numerals}[）)]$`, 'u').test(title)) {
      level = appendixGroup ? 3 : 2;
    }
    if (level !== null) headings.push({ line: index + 1, title, level });
  }
  for (const override of overrides) {
    const matches = lines.map((line, index) => ({ line, index })).filter(({ line }) => line.startsWith(override.line_prefix));
    if (matches.length !== 1) throw Error(`txt_heading_override_not_unique:${override.line_prefix}`);
    const line = matches[0].index + 1;
    const existing = headings.findIndex(heading => heading.line === line);
    if (existing >= 0) headings.splice(existing, 1);
    headings.push({ line, title: override.title, level: override.level });
  }
  return headings.sort((a, b) => a.line - b.line);
}

function safeName(title) {
  const replacements = { ':': '：', '/': '／', '\\': '＼', '?': '？', '*': '＊', '"': '＂', '<': '＜', '>': '＞', '|': '｜' };
  const safe = title.replace(/[<>:"/\\|?*]/gu, char => replacements[char]).replace(/[\u0000-\u001f]/gu, '').replace(/[ .]+$/gu, '').slice(0, 100);
  if (!safe || /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/iu.test(safe)) throw Error(`txt_unsafe_title:${title}`);
  return safe;
}

function bookRootGroup(node) {
  // Native PDF/EPUB outlines can identify parts/volumes explicitly. The
  // historical TXT inference remains unchanged when this hint is absent.
  if (typeof node.peer_group === 'string' && node.peer_group) return node.peer_group;
  // The synthetic book container combines front matter, chapters and back matter.
  // Only actual parallel structural units constrain one another at this root.
  if (new RegExp(`^第${numerals}章`, 'u').test(node.title)) return 'chapters';
  if (new RegExp(`^附录${numerals}[：:]`, 'u').test(node.title)) return 'appendices';
  if (/^附录[：:]?$/u.test(node.title)) return 'appendix-group';
  if (/(?:前言|序言)[：:]?$/u.test(node.title)) return 'prefaces';
  if (/^(?:导言|绪论|引言)[：:]?$/u.test(node.title)) return 'introduction';
  if (/^(?:后记|结语|结束语)[：:]?$/u.test(node.title)) return 'afterword';
  return 'other';
}

function applyPeerGranularity(root) {
  const decisions = [];
  root.subdivide = true;
  const visit = node => {
    const groups = new Map();
    for (const child of node.children) {
      const group = node === root ? bookRootGroup(child) : 'siblings';
      if (!groups.has(group)) groups.set(group, []);
      groups.get(group).push(child);
    }
    for (const [group, peers] of groups) {
      const indivisible = peers.filter(peer => !peer.children.length);
      const subdivide = indivisible.length === 0;
      decisions.push({ parent: node.title, parent_line: node.line || null, group,
        peer_titles: peers.map(peer => peer.title), peer_lines: peers.map(peer => peer.line),
        subdivide, indivisible_peer_titles: indivisible.map(peer => peer.title),
        indivisible_peer_lines: indivisible.map(peer => peer.line) });
      for (const peer of peers) {
        peer.subdivide = subdivide;
        if (subdivide) visit(peer);
      }
    }
  };
  visit(root);
  return decisions;
}

export function buildTxtBookManifest(request, options = {}) {
  const markdown = request.material.markdown.replace(/\r\n?/gu, '\n');
  const lines = markdown.split('\n');
  const headings = options.headings || discoverTxtBookHeadings(markdown, options.heading_overrides);
  if (!headings.length) throw Error('txt_book_headings_missing');
  const root = { title: options.title || request.source_metadata.title, level: 0, start: 0, end: lines.length, children: [] };
  const stack = [root];
  let previousLine = 0;
  for (const heading of headings) {
    if (!Number.isInteger(heading.line) || heading.line <= previousLine || heading.line > lines.length || !Number.isInteger(heading.level) || heading.level < 1 || heading.level > 6 || !heading.title) throw Error('txt_book_heading_invalid');
    previousLine = heading.line;
    while (stack.at(-1).level >= heading.level) stack.pop().end = heading.line - 1;
    const node = { ...heading, start: heading.line - 1, end: lines.length, children: [] };
    stack.at(-1).children.push(node);
    stack.push(node);
  }
  const peerGranularity = applyPeerGranularity(root);
  const splits = [];
  const addLeaf = (node, start, end, relativePath, title = node.title) => {
    const source = lines.slice(start, end).join('\n');
    if (!source.trim()) throw Error('txt_book_empty_leaf');
    splits.push({ split_id: `leaf-${String(splits.length + 1).padStart(3, '0')}`, title, relative_path: relativePath,
      heading_level: node.level, source_boundary: { start_line: start + 1, end_line: end }, source_sha256: sha256(source),
      nonempty_lines: source.split('\n').filter(line => line.trim()).length });
  };
  const visit = (node, folder, inheritedStart = node.start, prefix = '') => {
    if (!node.children.length || !node.subdivide) {
      addLeaf(node, inheritedStart, node.end, `${folder}${prefix}${safeName(node.title)}.md`);
      return;
    }
    const directory = node === root ? folder : `${folder}${prefix}${safeName(node.title)}/`;
    const prefixEnd = node.children[0].start;
    const ownText = lines.slice(node === root ? node.start : node.start + 1, prefixEnd).some(line => line.trim());
    let childStart = inheritedStart;
    if (ownText) {
      const title = node === root ? '书前信息' : '开篇';
      addLeaf(node, inheritedStart, prefixEnd, `${directory}00 ${title}.md`, `${node.title} — ${title}`);
      childStart = prefixEnd;
    }
    node.children.forEach((child, index) => visit(child, directory, index === 0 ? childStart : child.start, `${String(index + 1).padStart(2, '0')} `));
  };
  visit(root, '');
  let cursor = 1;
  for (const split of splits) {
    if (split.source_boundary.start_line !== cursor) throw Error('txt_book_gap_or_overlap');
    cursor = split.source_boundary.end_line + 1;
  }
  if (cursor !== lines.length + 1) throw Error('txt_book_incomplete_coverage');
  if (new Set(splits.map(split => split.relative_path.toLowerCase())).size !== splits.length) throw Error('txt_book_filename_collision');
  return { manifest_version: TXT_BOOK_VERSION, split_policy_version: TXT_BOOK_SPLIT_POLICY,
    peer_granularity: peerGranularity, title: root.title, source_sha256: sha256(markdown), source_type: request.source_type,
    source_line_count: lines.length, source_nonempty_lines: lines.filter(line => line.trim()).length,
    headings, split_count: splits.length, splits, tree: root };
}

export function buildTxtBookRequest(parent, manifest, split) {
  const markdown = parent.material.markdown.replace(/\r\n?/gu, '\n');
  if (sha256(markdown) !== manifest.source_sha256) throw Error('txt_book_source_hash_mismatch');
  const source = markdown.split('\n').slice(split.source_boundary.start_line - 1, split.source_boundary.end_line).join('\n');
  if (sha256(source) !== split.source_sha256) throw Error('txt_book_leaf_hash_mismatch');
  return { ...structuredClone(parent), material: { markdown: source },
    source_metadata: { ...structuredClone(parent.source_metadata), title: split.title,
      split: { manifest_version: manifest.manifest_version, split_policy_version: manifest.split_policy_version,
        split_id: split.split_id, book_title: manifest.title,
        relative_path: split.relative_path, parent_source_sha256: manifest.source_sha256, source_boundary: split.source_boundary } } };
}
