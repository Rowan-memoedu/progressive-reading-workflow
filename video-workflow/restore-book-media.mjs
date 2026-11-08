// Local repair for an accepted reading file. No producer or model is called.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { projectBookMedia, sha256 } from './book-media.mjs';
import {publishedAssetRelative,bookPublicationPath} from './book-folder.mjs';

async function writeExact(file, data) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  try { await fs.writeFile(file, data, { flag: 'wx' }); }
  catch (error) {
    if (error.code !== 'EEXIST' || sha256(await fs.readFile(file)) !== sha256(data)) throw new Error(`media_audit_conflict:${file}`);
  }
}
const readJson = async file => JSON.parse((await fs.readFile(file, 'utf8')).replace(/^\uFEFF/u, ''));
const safeFile = (root, relative) => {
  const resolved = path.resolve(root, relative);
  if (!resolved.startsWith(path.resolve(root) + path.sep)) throw new Error(`media_path_escape:${relative}`);
  return resolved;
};

export async function restoreBookMedia({ reading, book, captions, sourceResult, audit, publication, apply = false }) {
  reading = path.resolve(reading); audit = path.resolve(audit);
  if(bookPublicationPath(reading)!==reading) throw new Error('book_folder_required:'+bookPublicationPath(reading));
  if (audit === path.dirname(reading) || audit.startsWith(path.dirname(reading) + path.sep)) throw new Error('media_audit_must_be_outside_reading_area');
  const current = await fs.readFile(reading, 'utf8');
  const beforePath = path.join(audit, 'accepted-before.md');
  const before = await fs.readFile(beforePath, 'utf8').catch(error => {
    if (error.code !== 'ENOENT') throw error;
    return current;
  });
  const sourceRoot = path.dirname(path.resolve(book));
  const source = await readJson(path.join(sourceRoot, 'source.json'));
  if (!Array.isArray(source.files)) throw new Error('media_source_inventory_required');
  const inventory = source.files;
  const bookMarkdown = await fs.readFile(book, 'utf8');
  const captionMap = await readJson(captions);
  const result = await readJson(sourceResult);
  const slug = path.basename(reading, '.md');
  const projection = projectBookMedia({ readingMarkdown: before, bookMarkdown, inventory, slug,
    paragraphs: captionMap.paragraphs, sourceNodes: result.artifacts.cleaning_manifest.source_nodes,
    bodyBlocks: result.artifacts.body_blocks });
  if (![projection.input_sha256, projection.output_sha256].includes(sha256(current))) throw new Error('accepted_reading_changed_since_snapshot');
  const assetRoot = path.dirname(reading);
  const assets = [];
  for (const item of inventory) {
    if (/^(?:\.env(?:\.|$)|_?cookies?\.(?:txt|json)$|.*\.cookies\.txt$)/iu.test(path.basename(item.path))) throw new Error('media_sensitive_asset_excluded');
    const sourcePath = safeFile(sourceRoot, item.path);
    const publishedPath = safeFile(assetRoot, publishedAssetRelative(item.path));
    const sourceBytes = await fs.readFile(sourcePath);
    if (sha256(sourceBytes) !== item.sha256) throw new Error(`media_source_asset_changed:${item.path}`);
    const retained = await fs.readFile(publishedPath).catch(error => {
      if (error.code !== 'ENOENT') throw error;
      return null;
    });
    if (retained && sha256(retained) !== item.sha256) throw new Error(`media_retained_asset_changed:${item.path}`);
    if (!retained && apply) await writeExact(publishedPath, sourceBytes);
    assets.push({ ...item, source_path: sourcePath, published_path: publishedPath,
      markdown_path: publishedAssetRelative(item.path) });
  }
  let priorPublication;
  if (publication) {
    priorPublication = await readJson(publication);
    if (path.resolve(priorPublication.markdown.path) !== reading || ![projection.input_sha256, projection.output_sha256].includes(priorPublication.markdown.sha256)) {
      throw new Error('media_publication_identity_mismatch');
    }
  }
  await writeExact(beforePath, before);
  await writeExact(path.join(audit, 'with-media.md'), projection.markdown);
  const { markdown, ...proof } = projection;
  const receiptPath = path.join(audit, 'media-projection.json');
  const receipt = { ...proof, reading_path: reading, book_path: path.resolve(book),
    captions_path: path.resolve(captions), source_result_path: path.resolve(sourceResult),
    captions_sha256: sha256(await fs.readFile(captions)), source_result_sha256: sha256(await fs.readFile(sourceResult)),
    assets, model_calls: 0, text_acceptance: 'accepted_by_user', prose_rewritten: false };
  await writeExact(receiptPath, JSON.stringify(receipt, null, 2) + '\n');
  if (apply) {
    if (sha256(await fs.readFile(reading)) !== sha256(current)) throw new Error('accepted_reading_changed_before_write');
    if (current !== markdown) {
      const temporary = reading + '.media.tmp';
      await writeExact(temporary, markdown);
      await fs.rename(temporary, reading);
    }
    if (sha256(await fs.readFile(reading)) !== projection.output_sha256) throw new Error('media_publication_readback_failed');
    if (publication && priorPublication.markdown.sha256 === projection.input_sha256) {
      await writeExact(path.join(audit, 'publication-before.json'), JSON.stringify(priorPublication, null, 2) + '\n');
      priorPublication.markdown = { ...priorPublication.markdown, bytes: Buffer.byteLength(markdown), sha256: projection.output_sha256 };
      priorPublication.assets = assets;
      priorPublication.media_projection = { receipt_path: receiptPath, version: projection.version, counts: projection.counts,
        original_sha256: projection.input_sha256, prose_unchanged: true, model_calls: 0 };
      await fs.writeFile(publication, JSON.stringify(priorPublication, null, 2) + '\n');
    }
  }
  return { status: apply ? 'applied' : 'preview', path: reading, counts: projection.counts,
    prose_unchanged: true, model_calls: 0, sha256: projection.output_sha256, receipt_path: receiptPath };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = {};
  for (let i = 2; i < process.argv.length; i++) {
    const key = process.argv[i].replace(/^--/u, '');
    if (key === 'apply') args.apply = true;
    else args[key] = process.argv[++i];
  }
  try {
    for (const key of ['reading','book','captions','source-result','audit']) if (!args[key]) throw new Error(`required_argument:--${key}`);
    console.log(JSON.stringify(await restoreBookMedia({ ...args, sourceResult: args['source-result'] })));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
