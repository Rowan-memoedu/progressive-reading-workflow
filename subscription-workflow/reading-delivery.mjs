import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { runPreprocessingRequest, standardWorkflowOptions } from '../standard-preprocessing/index.mjs';
import { renameWithRetry } from '../rss-source/core.mjs';
import { findExistingPublication } from './catalog.mjs';
import { digest, readJson } from './config.mjs';
import { moveReport, relocatedMarkdown } from './report-archive.mjs';
import { dataPath } from '../scripts/runtime-paths.mjs';
import { auditVisibleReadingAnchors } from '../standard-preprocessing/lib/core.mjs';
import { readingDestination } from './reading-options.mjs';
import { ExternalProducer, loadBatchProducerConfig } from '../standard-preprocessing/lib/producer.mjs';

export async function subscriptionProducer(config = null) {
  return new ExternalProducer({...config || await loadBatchProducerConfig(),AI_PRODUCER_PROVIDER:'codex_exec'});
}

export const readingCache = process.env.PR_PREPROCESS_CACHE_DIR || path.join(path.dirname(dataPath()),'Caches','ProgressiveReading','preprocess');

export function attachGuideAnchors(body,guide,blocks = []) {
  const targets = new Set([...guide.matchAll(/\[\[#\^(pr-[a-f0-9]{12})(?:\|[^\]\n]+)?\]\]/gu)].map(match=>match[1]));
  const additions = [];
  const ids = new Map();
  const newline = body.includes('\r\n') ? '\r\n' : '\n';
  let cursor = 0;
  for (const block of blocks) {
    const pattern = String(block.markdown).split(/\r?\n/u).map(line=>line.replace(/[.*+?^${}()|[\]\\]/gu,'\\$&')).join('\\r?\\n');
    const match = new RegExp(pattern,'u').exec(body.slice(cursor));
    if (!match) throw new Error(`reading_guide_block_mapping_failed:${block.source_block_key}`);
    const start = cursor+match.index, end = start+match[0].length;
    cursor = end;
    if (!targets.has(block.block_id)) continue;
    const anchorText = block.type==='list' ? match[0].split(/\r?\n/u)[0] : match[0];
    const inline = !['code','math'].includes(block.type) && /(?:^|[ \t])\^([A-Za-z0-9-]+)[ \t]*$/mu.exec(anchorText);
    const trailing = /^(?:[ \t]*\r?\n){1,2}[ \t]*\^([A-Za-z0-9-]+)[ \t]*(?:\r?\n|$)/u.exec(body.slice(end));
    const previousId = inline?.[1] || trailing?.[1];
    if (previousId) {
      ids.set(block.block_id,previousId);
      guide = guide.replaceAll('#^'+block.block_id,'#^'+previousId);
      continue;
    }
    if (body.includes('^'+block.block_id)) throw new Error('reading_guide_anchor_collision');
    const list = block.type==='list' && /^\s*[-*+]\s+\S/u.test(match[0]);
    const position = list ? start+match[0].split(/\r?\n/u)[0].length : end;
    const text = list ? ' ^'+block.block_id : newline+newline+'^'+block.block_id;
    additions.push({position,text,id:block.block_id});
    ids.set(block.block_id,block.block_id);
  }
  if ([...targets].some(id=>!ids.has(id))) throw new Error('reading_guide_anchor_target_missing');
  let anchored = body;
  for (const addition of [...additions].reverse()) anchored = anchored.slice(0,addition.position)+addition.text+anchored.slice(addition.position);
  let restored = anchored;
  for (const addition of additions) restored = restored.replace(addition.text,'');
  if (restored !== body) throw new Error('reading_guide_changed_saved_body');
  return {body:anchored,guide,added_anchors:additions.map(addition=>addition.id),blocks:blocks.map(block=>({...block,block_id:ids.get(block.block_id)||block.block_id}))};
}

export function readingRequest(request, item, generateGuide = item.reading_options?.generate_guide === true) {
  return {
    ...request,
    processing_options:standardWorkflowOptions({spoken_to_written:false,structure_body:false,
      input_form:'written',content_profile:'natural_language',include_reading_guide:generateGuide,
      translation_mode:item.reading_options?.translation_mode || 'terminology'})
  };
}

function accepted(run) {
  if (!['completed','idempotent_replay'].includes(run?.result?.status)
    || run.result.processing_state !== 'rendered' || run.result.artifacts?.target_zone !== 'local-ir-reading') throw new Error('reading_preprocessing_incomplete');
}

export async function deliverArticle(paths, item, name, options = {}) {
  const preserved = item.publication?.path && await fs.access(item.publication.path).then(()=>true,()=>false)
    ? {path:item.publication.path} : await findExistingPublication(paths.workflowRoot,item.item_url);
  if (preserved) {
    item.publication = {...item.publication,path:preserved.path,status:'published',preserved_existing:true,
      sha256:digest(await fs.readFile(preserved.path)),published_at:item.publication?.published_at || new Date().toISOString()};
    if (item.reading_options.generate_guide) await addReadingGuide(paths,item,options);
    return item.review_preview = {...item.review_preview,status:'ready',direct_reading:true};
  }
  const destination = path.resolve(paths.workflowRoot,'阅读区',readingDestination(item));
  const relative = path.relative(path.join(paths.workflowRoot,'阅读区'),destination);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('reading_destination_outside_reading_area');
  const target = path.join(destination,name+'.md');
  if (await fs.access(target).then(()=>true,()=>false)) throw new Error(`reading_destination_collision:${target}`);
  const source = await readJson(item.preprocess_request_path);
  const request = await readingRequest(source,item,undefined,options);
  const outputDir = path.join(paths.preprocessRoot,'direct-reading',item.material_id,digest(JSON.stringify(request)).slice(0,20));
  const runner = options.readingRunner || runPreprocessingRequest;
  const run = await runner(request,{outputDir,publishPath:target,assetSourceDir:item.source_package_path,cacheDir:readingCache,
    ...(!options.readingRunner ? {producer:await subscriptionProducer()} : {}),
    onProgress:event=>options.onPreviewProgress?.({materialId:item.material_id,status:'processing',...event})});
  accepted(run);
  if (run.publication?.status !== 'published' || run.publication.cleanliness?.valid !== true
    || (!run.publication.preserved_existing && path.resolve(run.publication.markdown?.path || '') !== target)
    || digest(await fs.readFile(run.publication.markdown.path)) !== run.publication.markdown.sha256) throw new Error('reading_publication_verification_failed');
  item.publication = {status:'published',path:run.publication.markdown.path,sha256:run.publication.markdown.sha256,
    published_at:new Date().toISOString(),result_path:path.join(outputDir,'result.json'),
    publication_path:path.join(outputDir,'publication.json'),direct_reading:true};
  if (item.reading_options.generate_guide) item.reading_guide = {status:'ready',result_path:item.publication.result_path};
  return item.review_preview = {status:'ready',direct_reading:true,result_path:item.publication.result_path,
    source_request_sha256:item.preprocess_request_sha256};
}

export async function addReadingGuide(paths,item,options = {}) {
  const file = item.publication?.path;
  if (!file || item.publication.status !== 'published') throw new Error('reading_guide_requires_published_article');
  const before = await fs.readFile(file,'utf8');
  const existingGuide = /^## 阅读前置卡\s*$/mu.exec(before);
  const existingBody = /^## 正文\r?$/mu.exec(before);
  if (existingGuide && (!existingBody || existingGuide.index < existingBody.index)) {
    item.reading_guide = {...item.reading_guide,status:'ready',preserved_existing:true};
    return;
  }
  const marker = `<!-- subscriptions:reading-guide ${item.material_id} -->`;
  if (before.includes(marker)) throw new Error('reading_guide_marker_incomplete');
  const frontmatter = /^---\r?\n[\s\S]*?\r?\n---\r?\n/u.exec(before);
  const bodyStart = existingBody || {index:frontmatter?.[0].length || 0};
  const body = before.slice(bodyStart.index).replace(/^## 正文\r?\n/u,'').split(/\n(?:---\n\n)?## 原文\r?\n/u)[0];
  const source = await readJson(item.preprocess_request_path);
  const request = {...source,material:{markdown:body},source_metadata:{...source.source_metadata,language:'zh'},
    processing_options:standardWorkflowOptions({spoken_to_written:false,structure_body:false,translate:false,
      input_form:'written',content_profile:'natural_language',include_reading_guide:true})};
  const outputDir = path.join(paths.preprocessRoot,'reading-guides',item.material_id,digest(before).slice(0,20));
  const run = await (options.guideRunner || runPreprocessingRequest)(request,{outputDir,assetSourceDir:item.source_package_path,cacheDir:readingCache,
    ...(!options.guideRunner ? {producer:await subscriptionProducer()} : {})});
  accepted(run);
  const rendered = run.result.artifacts.reading_markdown;
  const start = /^## 阅读前置卡\r?$/mu.exec(rendered);
  const end = /^## 正文\r?$/mu.exec(rendered);
  if (!start || !end || end.index <= start.index || !run.result.artifacts.semantic?.judgments) throw new Error('reading_guide_required_artifact_missing');
  const guide = rendered.slice(start.index,end.index).replace(/\s*---\s*$/u,'').trimEnd();
  const anchored = attachGuideAnchors(body,guide,run.result.artifacts.body_blocks);
  const header = /^## 正文\r?\n/u.exec(before.slice(bodyStart.index));
  const bodyOffset = bodyStart.index+(header?.[0].length || 0);
  const insertion = marker+'\n'+anchored.guide+'\n<!-- subscriptions:reading-guide-end -->\n\n';
  const after = before.slice(0,bodyStart.index)+insertion+before.slice(bodyStart.index,bodyOffset)+anchored.body+before.slice(bodyOffset+body.length);
  const anchorAudit = auditVisibleReadingAnchors(after,anchored.blocks);
  if (!anchorAudit.passed) throw new Error('reading_guide_anchor_audit_failed');
  const temporary = file+'.guide-'+randomUUID()+'.tmp';
  try {
    await fs.writeFile(temporary,after,'utf8');
    if (await fs.readFile(file,'utf8') !== before) throw new Error('article_changed_during_guide_generation');
    await renameWithRetry(temporary,file);
  } finally { await fs.unlink(temporary).catch(error=>{if(error.code !== 'ENOENT')throw error;}); }
  item.reading_guide = {status:'ready',result_path:path.join(outputDir,'result.json'),body_preserved:true,added_anchors:anchored.added_anchors,anchor_audit:anchorAudit};
  item.publication.sha256 = digest(after);
}

export async function archiveArticle(paths,item,save) {
  const publication = item.publication;
  if (!publication?.path) throw new Error('archive_requires_reading_article');
  if (!item.reading_archive_pending) {
    const source = path.resolve(publication.path);
    const relative = path.relative(path.join(paths.workflowRoot,'阅读区'),source);
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('archive_article_outside_reading_area');
    const target = path.join(paths.workflowRoot,'待归档原文',readingDestination(item),path.basename(source));
    const before = await fs.readFile(source,'utf8');
    item.reading_archive_pending = {source,target,sha256:digest(before),destination_sha256:digest(relocatedMarkdown(before,source,target))};
    await save();
  }
  const pending = item.reading_archive_pending;
  await moveReport(pending.source,pending.target,pending.sha256,pending.destination_sha256);
  const sidecar = path.join(paths.localIrStateRoot,path.basename(pending.source)+'.browser-ir.json');
  const state = await readJson(sidecar);
  if (state?.document) {
    const relative = path.relative(paths.workflowRoot,pending.target).replaceAll('\\','/');
    const oldRelative = path.relative(paths.workflowRoot,pending.source).replaceAll('\\','/');
    const prefix = state.document.path?.endsWith(oldRelative) ? state.document.path.slice(0,-oldRelative.length) : '';
    state.document.path = prefix+relative;
    const {writeJson} = await import('./config.mjs');
    await writeJson(sidecar,state);
  }
  item.publication = {...publication,status:'archived',path:pending.target,sha256:pending.destination_sha256};
  delete item.reading_archive_pending;
}
