import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { runPreprocessingRequest } from '../standard-preprocessing/index.mjs';
import { buildTxtBookManifest, buildTxtBookRequest, sha256 } from './txt-book-structure.mjs';

const readJson = async file => JSON.parse(await fs.readFile(file, 'utf8'));
const writeJson = async (file, value) => { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, JSON.stringify(value, null, 2) + '\n'); };

export async function importTxtBook({ request, plan = {}, output, publish, cache, planOnly = false }) {
  if (request.source_type !== 'txt') throw Error('txt_book_requires_txt_request');
  const manifest = buildTxtBookManifest(request, plan);
  output = path.resolve(output);
  publish = path.resolve(publish);
  if (output === publish || output.startsWith(publish + path.sep)) throw Error('txt_book_audit_inside_reading_book');
  await writeJson(path.join(output, 'book-manifest.json'), manifest);
  if (planOnly) return { status: 'planned', title: manifest.title, split_count: manifest.split_count, paths: manifest.splits.map(split => split.relative_path) };
  try { await fs.access(publish); throw Error('txt_book_target_already_exists'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const rows = [];
  for (const split of manifest.splits) {
    const child = buildTxtBookRequest(request, manifest, split);
    const target = path.resolve(publish, ...split.relative_path.split('/'));
    if (!target.startsWith(publish + path.sep)) throw Error('txt_book_target_outside_book');
    const run = await runPreprocessingRequest(child, { outputDir: path.join(output, 'sections', split.split_id), publishPath: target, cacheDir: cache || false });
    if (run.publication?.status !== 'published') throw Error(`txt_book_leaf_not_published:${split.split_id}:${run.result.status}`);
    const body = (await fs.readFile(target, 'utf8')).split('\n## 正文\n')[1]?.trim();
    if (request.source_metadata.language === 'zh' && !child.processing_options.structure_body && body.replace(/\s/gu, '') !== child.material.markdown.replace(/\s/gu, '')) throw Error(`txt_book_leaf_content_mismatch:${split.split_id}`);
    const row = { split_id: split.split_id, relative_path: split.relative_path, source_boundary: split.source_boundary,
      quality_status: run.publication.quality_status, model_calls: run.result.receipt.model.calls,
      reading_guide: run.result.receipt.reading_guide.status, publication: run.publication.markdown };
    rows.push(row);
    console.error(`[${rows.length}/${manifest.split_count}] ${split.relative_path}`);
    await writeJson(path.join(output, 'book-publication.json'), { status: 'in_progress', book_root: publish, rows });
  }
  const allSource = manifest.splits.map(split => buildTxtBookRequest(request, manifest, split).material.markdown).join('\n');
  if (sha256(allSource) !== manifest.source_sha256) throw Error('txt_book_whole_source_mismatch');
  const report = { status: 'completed', title: manifest.title, book_root: publish, split_count: rows.length,
    source_nonempty_lines: manifest.source_nonempty_lines, complete_coverage: true,
    guide_generated: rows.some(row => row.reading_guide !== 'skipped'), model_calls: rows.reduce((sum, row) => sum + row.model_calls, 0), rows };
  await writeJson(path.join(output, 'book-publication.json'), report);
  return report;
}

async function main() {
  const args = {};
  for (let index = 2; index < process.argv.length; index++) {
    const name = process.argv[index];
    if (name === '--plan-only') args.planOnly = true;
    else if (['--request', '--plan', '--output', '--publish', '--cache'].includes(name)) args[name.slice(2)] = process.argv[++index];
    else throw Error(`unknown_argument:${name}`);
  }
  if (!args.request || !args.output || !args.publish) throw Error('--request, --output, and --publish are required');
  const result = await importTxtBook({ ...args, request: await readJson(args.request), plan: args.plan ? await readJson(args.plan) : {} });
  console.log(JSON.stringify(args.planOnly ? result : { ...result, rows: undefined }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error); process.exitCode = 1; });
}
