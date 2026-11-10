import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { groupTranscriptSegments } from '../scripts/import-youtube-subtitle-canary.mjs';
import { preprocessNetworkMarkdown } from '../standard-preprocessing/integrations/network-import.mjs';
import { publishReadingArtifact } from '../standard-preprocessing/index.mjs';
import { libraryRootForPath, sourceIdentityUrl, findSourcePublication } from '../scripts/reading-source-library.mjs';
import { layoutInlineAttachments } from './attachment-layout.mjs';
import { captionMediaSource, extractBookMedia, verifyBookMedia, imageEmbed } from './book-media.mjs';
import { withCachedMediaRestoration } from './generated-media-projection.mjs';
import { ExternalProducer } from '../standard-preprocessing/lib/producer.mjs';
import { spokenQualityFromReceipt } from '../standard-preprocessing/lib/spoken-quality.mjs';
import {bookPublicationPath,publishedAssetRelative,assetReference,BOOK_FOLDER_LAYOUT} from './book-folder.mjs';

const hash = data => crypto.createHash('sha256').update(data).digest('hex');
const moduleDir = path.dirname(fileURLToPath(import.meta.url));

export function isCredentialArtifact(name) {
  const basename = path.posix.basename(name).toLowerCase();
  return /^\.env(?:\.|$)/u.test(basename) || /^(?:_?cookies?\.(?:txt|json)|.*\.cookies\.txt)$/u.test(basename);
}

export function parseTranscript(text) {
  const segments = [];
  for (const [index, line] of String(text).replace(/^\uFEFF/u, '').split(/\r?\n/u).entries()) {
    if (!line.trim()) continue;
    const match = /^\[(\d{2,}:\d{2}:\d{2}(?:\.\d+)?)\]\s*(.*)$/u.exec(line);
    if (!match || !match[2].trim()) throw new Error(`invalid_transcript_line:${index + 1}`);
    const values = match[1].split(':').map(Number);
    if (values[1] >= 60 || values[2] >= 60) throw new Error(`invalid_timestamp:${index + 1}`);
    const seconds = values[0] * 3600 + values[1] * 60 + values[2];
    if (segments.length && seconds < segments.at(-1).seconds) throw new Error(`unordered_transcript:${index + 1}`);
    segments.push({ start: match[1], seconds, text: match[2] });
  }
  if (!segments.length) throw new Error('empty_transcript');
  return segments;
}

async function listFiles(root, relative = '') {
  const records = [];
  for (const entry of await fs.readdir(path.join(root, relative), { withFileTypes: true })) {
    const name = path.posix.join(relative, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`attachment_symlink:${name}`);
    if (entry.isDirectory()) records.push(...await listFiles(root, name));
    else if (entry.isFile()) records.push(name);
    else throw new Error(`unsupported_attachment:${name}`);
  }
  return records.sort();
}

async function writeExact(file, data) {
  const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data);
  await fs.mkdir(path.dirname(file), { recursive: true });
  try {
    await fs.writeFile(file, bytes, { flag: 'wx' });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    if (hash(await fs.readFile(file)) !== hash(bytes)) throw new Error(`output_conflict:${file}`);
  }
}

export async function verifyUpstream() {
  const lock = JSON.parse(await fs.readFile(path.join(moduleDir, 'upstream-lock.json'), 'utf8'));
  for (const record of lock.files) {
    if (hash(await fs.readFile(path.join(moduleDir, 'upstream', record.path))) !== record.sha256) {
      throw new Error(`upstream_modified:${record.path}`);
    }
  }
  return { repository: lock.repository, commit: lock.commit, unchanged_files: lock.files.length };
}

async function promptHashes() {
  const root = path.resolve(moduleDir, '../standard-preprocessing/prompts');
  return Object.fromEntries(await Promise.all((await listFiles(root)).map(async name =>
    [name, hash(await fs.readFile(path.join(root, name)))])));
}

export async function importTranscript({ inputDir, outputDir, publishPath, processingOptions = {}, producer, verifyCode = true, bodyRefiner }) {
  inputDir = path.resolve(inputDir);
  outputDir = path.resolve(outputDir);
  const requestedPublishPath=path.resolve(publishPath);
  publishPath = bookPublicationPath(publishPath);
  // Audit output must never become part of the input attachment inventory.
  if (outputDir === inputDir || outputDir.startsWith(inputDir + path.sep)
      || publishPath.startsWith(inputDir + path.sep)) throw new Error('input_output_overlap');
  const upstream = verifyCode ? await verifyUpstream() : null;
  const promptsBefore = await promptHashes();
  const metadata = JSON.parse(await fs.readFile(path.join(inputDir, 'source.json'), 'utf8').catch(error => {
    if (error.code === 'ENOENT') return '{}';
    throw error;
  }));
  const discoveredFiles = await listFiles(inputDir);
  const excludedSensitivePaths = discoveredFiles.filter(isCredentialArtifact);
  const files = discoveredFiles.filter(name => name !== 'source.json' && !isCredentialArtifact(name));
  const subtitleFile = metadata.subtitle_file || (files.includes('transcript.json') ? 'transcript.json' :
    files.includes('transcript.corrected.txt') ? 'transcript.corrected.txt' : 'transcript.txt');
  if (!files.includes(subtitleFile)) throw new Error('missing_subtitle_file');
  const raw = await fs.readFile(path.join(inputDir, subtitleFile));
  let segments;
  if (subtitleFile.endsWith('.json')) {
    const transcript = JSON.parse(raw.toString('utf8'));
    Object.assign(metadata, transcript);
    const inputSegments = transcript.segments || [];
    segments = parseTranscript(inputSegments.map(s => `[${s.start}] segment`).join('\n')).map((segment, index) => {
      const text = inputSegments[index].text;
      if (typeof text !== 'string' || !text.trim()) throw new Error(`empty_json_segment:${index + 1}`);
      return { ...segment, text };
    });
    delete metadata.segments;
  } else segments = parseTranscript(raw.toString('utf8'));
  if (!metadata.source_url && metadata.video_url) metadata.source_url = metadata.video_url;
  if (!metadata.source_url || !metadata.title) throw new Error('source_url_and_title_required');
  const libraryRoot = libraryRootForPath(requestedPublishPath);
  const existingPublication = libraryRoot ? await findSourcePublication(libraryRoot, sourceIdentityUrl(metadata)) : null;
  if (existingPublication) {
    const receipt = {status:'completed',preserved_existing:true,processing_status:'idempotent_replay',quality_status:'ready',
      publication:{status:'published',preserved_existing:true,markdown:existingPublication,assets:[]},
      model:{calls:0},attachments:[],attachments_verified:0};
    await fs.mkdir(outputDir,{recursive:true});
    await fs.writeFile(path.join(outputDir,'publication.json'),JSON.stringify(receipt.publication,null,2)+'\n');
    await fs.writeFile(path.join(outputDir,'video-receipt.json'),JSON.stringify(receipt,null,2)+'\n');
    return receipt;
  }
  // BV ids are transport placeholders. Once metadata is available, publish a
  // readable title while preserving explicitly named targets and mode suffixes.
  publishPath = bookPublicationPath(requestedPublishPath, metadata);
  const paragraphs = groupTranscriptSegments(segments);
  const markdown = paragraphs.map(p => p.text).join('\n\n');
  const inventory = await Promise.all(files.map(async name => {
    const data = await fs.readFile(path.join(inputDir, name));
    return { path: name, bytes: data.length, sha256: hash(data) };
  }));
  for (const record of metadata.files || []) {
    if (inventory.find(item => item.path === record.path)?.sha256 !== record.sha256) {
      throw new Error(`source_package_changed:${record.path}`);
    }
  }
  const captionMap = { segments, paragraphs, subtitle_sha256: hash(raw), transcript_sha256: hash(markdown) };
  await writeExact(path.join(outputDir, 'caption-map.json'), JSON.stringify(captionMap, null, 2) + '\n');
  const requestMetadata = { ...metadata };
  delete requestMetadata.files;
  delete requestMetadata.subtitle_file;
  const slug = path.basename(publishPath, '.md');
  const bookMarkdown = files.includes('book.md') ? await fs.readFile(path.join(inputDir,'book.md'),'utf8') : '';
  // Attach source visuals before full-text editing, while the caption offsets
  // are still exact. The existing protected-span layer keeps native Mermaid and
  // links literal across the single model call; no invented output lineage.
  const sourceMedia = captionMediaSource({markdown,paragraphs,bookMarkdown,inventory,slug});
  await writeExact(path.join(outputDir,'media-source.md'),sourceMedia.markdown);
  const {markdown: _mediaText, ...mediaReceipt} = sourceMedia;
  await writeExact(path.join(outputDir,'media-source.json'),JSON.stringify(mediaReceipt,null,2)+'\n');
  // The single-pass adapter owns speech editing. The standard workflow receives
  // its completed written text and may only add the requested reading guide.
  const refinement = bodyRefiner ? await bodyRefiner({markdown:sourceMedia.markdown, outputDir, sourceMetadata:requestMetadata}) : null;
  if (bodyRefiner && !refinement?.markdown?.trim()) throw new Error('refinement_missing_body');
  const processingMarkdown = refinement?.markdown || sourceMedia.markdown;
  const existingMedia=extractBookMedia(bookMarkdown,inventory);
  const effectiveProducer=!bodyRefiner&&existingMedia.length
    ? withCachedMediaRestoration(producer||new ExternalProducer(),{
      generatedMedia:existingMedia.map(item=>({...item,literal:item.kind==='mermaid'?item.literal:imageEmbed(item.label,item.path,slug)})),
      transcript:{segments}})
    : producer;
  const run = await preprocessNetworkMarkdown({ markdown:processingMarkdown, sourceType: 'videobook_video_transcript',
    sourceMetadata: { ...requestMetadata, input_form: refinement ? 'written' : 'spoken_transcript', source_id: metadata.source_id || metadata.video_id,
      subtitle_sha256: hash(raw), transcript_sha256: hash(markdown), raw_artifact_dir: inputDir },
    spoken: !refinement, processingOptions:refinement ? {...processingOptions, input_form:'written',
      spoken_to_written:false, structure_body:false} : processingOptions, outputDir: path.join(outputDir, 'preprocess'),
    cacheDir: path.resolve(process.env.PR_PREPROCESS_HOME || 'D:/Caches/ProgressiveReading/preprocess', 'cache'), producer:effectiveProducer });
  const promptsAfter = await promptHashes();
  if (JSON.stringify(promptsBefore) !== JSON.stringify(promptsAfter)) throw new Error('prompts_changed_during_run');
  if (!run.result.artifacts?.reading_markdown) throw new Error(`preprocessing_not_readable:${run.result.status}`);
  // A source-preserving fallback is useful for recovery, but cannot count as a
  // successful written-text refinement or enter the reading area as such.
  let spokenQuality = null;
  const sharedRefinement = run.result.receipt.body_refinement;
  if (!producer && !refinement && !sharedRefinement) {
    const spokenResult = JSON.parse(await fs.readFile(path.join(outputDir, 'preprocess/stages/spoken_to_written/result.json'), 'utf8'));
    spokenQuality = spokenQualityFromReceipt(spokenResult.receipt);
    if (!spokenQuality?.chunks?.length || spokenQuality.chunks.some(chunk => chunk.status !== 'passed'
        || chunk.attempts.at(-1)?.review?.verdict !== 'pass'
        || chunk.attempts.at(-1)?.review?.issues?.length !== 0)) throw new Error('spoken_quality_review_not_passed');
  }
  const attachmentRoot = path.dirname(publishPath);
  const result = structuredClone(run.result);
  const layout = layoutInlineAttachments({readingMarkdown:result.artifacts.reading_markdown,sourceMarkdown:processingMarkdown,
    inventory,slug,paragraphs,sourceNodes:result.artifacts.cleaning_manifest.source_nodes,bodyBlocks:result.artifacts.body_blocks});
  layout.used_attachments = [...new Set([...layout.used_attachments,...sourceMedia.used_attachments])].sort();
  layout.placements.push(...sourceMedia.placements);
  const mediaCounts = verifyBookMedia(layout.markdown,extractBookMedia(bookMarkdown,inventory),slug);
  result.artifacts.reading_markdown = layout.markdown;
  result.artifacts.artifact_hashes.reading_markdown = hash(layout.markdown);
  // Reuse the shared admissibility and publication checks before copying attachments.
  const { classifyStandardImportQuality } = await import('../scripts/standard-import-quality.mjs');
  if (!classifyStandardImportQuality(result).admissible) throw new Error(`preprocessing_not_publishable:${result.status}`);
  for (const record of inventory) {
    const data = await fs.readFile(path.join(inputDir, record.path));
    if (hash(data) !== record.sha256) throw new Error(`source_changed_during_run:${record.path}`);
    await writeExact(path.join(attachmentRoot, publishedAssetRelative(record.path)), data);
  }
  const publication = await publishReadingArtifact(result, { publishPath, runDir: outputDir });
  if (publication.preserved_existing && path.resolve(publication.markdown.path) !== path.resolve(publishPath)) {
    const receipt={status:'completed',preserved_existing:true,quality_status:publication.quality_status,publication,model:run.result.receipt.model,attachments:[],attachments_verified:0};
    await fs.writeFile(path.join(outputDir,'video-receipt.json'),JSON.stringify(receipt,null,2)+'\n');
    return receipt;
  }
  const final = await fs.readFile(publishPath, 'utf8');
  verifyBookMedia(final,extractBookMedia(bookMarkdown,inventory),slug);
  for (const record of inventory) {
    if (hash(await fs.readFile(path.join(attachmentRoot, publishedAssetRelative(record.path)))) !== record.sha256) throw new Error(`attachment_verification_failed:${record.path}`);
    if (layout.used_attachments.includes(record.path)) {
      const relative = assetReference(record.path);
      if (!final.includes(`](${relative})`)) throw new Error(`attachment_reference_missing:${record.path}`);
    }
  }
  publication.assets = inventory.map(record => ({ source_path: path.join(inputDir, record.path),
    published_path: path.join(attachmentRoot, publishedAssetRelative(record.path)),
    markdown_path: publishedAssetRelative(record.path), bytes: record.bytes, sha256: record.sha256 }));
  publication.layout=BOOK_FOLDER_LAYOUT;
  publication.requested_markdown_path=requestedPublishPath;
  await fs.writeFile(path.join(outputDir, 'publication.json'), JSON.stringify(publication, null, 2) + '\n');
  const receipt = { status: 'completed', upstream, prompts_unchanged: true, prompt_sha256: promptsBefore,
    source_file: subtitleFile, subtitle_sha256: hash(raw), segments: segments.length, paragraphs: paragraphs.length,
    first_timestamp: segments[0].start, last_timestamp: segments.at(-1).start,
    media_downloaded: metadata.media_downloaded ?? null, asr_used: metadata.asr_used ?? null,
    processing_status: run.result.status, processing_state: run.result.processing_state,
    quality_status: publication.quality_status, workflow_route: run.result.receipt.workflow_route,
    publication, attachments: inventory, attachments_verified: inventory.length,
    excluded_sensitive_paths: excludedSensitivePaths,
    model: run.result.receipt.model, reading_guide: run.result.receipt.reading_guide, spoken_quality: spokenQuality,
    refinement:refinement?.receipt || sharedRefinement || null,
    attachment_layout:layout.version,used_attachments:layout.used_attachments,attachment_placements:layout.placements,
    book_media:{...mediaReceipt,counts:mediaCounts,restoration_stage:'before_full_text_refinement',verified_after_publication:true} };
  await fs.writeFile(path.join(outputDir, 'video-receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
  return receipt;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = {};
  for (let i = 2; i < process.argv.length; i += 2) args[process.argv[i].replace(/^--/u, '')] = process.argv[i + 1];
  try {
    if (process.argv.includes('--verify-upstream')) {
      console.log(JSON.stringify({ ok: true, upstream: await verifyUpstream() }));
      process.exit(0);
    }
    for (const key of ['input', 'output', 'publish']) if (!args[key]) throw new Error(`required_argument:--${key}`);
    const receipt = await importTranscript({ inputDir: args.input, outputDir: args.output, publishPath: args.publish,
      processingOptions: args.options ? JSON.parse(await fs.readFile(args.options, 'utf8')) : {} });
    console.log(JSON.stringify({ ok: true, status: receipt.status, publication: receipt.publication.markdown,
      quality_status: receipt.quality_status, attachments_verified: receipt.attachments_verified }));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
