// Refine only frozen, previously generated notes; never overwrite user edits.
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { importTranscript } from './import-transcript.mjs';
import { preprocessNetworkMarkdown } from '../standard-preprocessing/integrations/network-import.mjs';
import { spokenQualityFromReceipt } from '../standard-preprocessing/lib/spoken-quality.mjs';

const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const sha = async file => digest(await fs.readFile(file));
const save = async (file, value) => { await fs.mkdir(path.dirname(file), {recursive:true});await fs.writeFile(file,JSON.stringify(value,null,2)+'\n'); };
const project = path.resolve(import.meta.dirname, '..');
const args = Object.fromEntries(process.argv.slice(3).reduce((items,value,index,array) => index % 2 ? items : items.concat([[value.replace(/^--/u,''),array[index+1]]]),[]));
const command = process.argv[2];
process.env.PR_SPOKEN_CACHE_DIR ||= 'D:/Caches/ProgressiveReading/preprocess/spoken-quality';
if (!args.root) throw new Error('--root required');
const root = path.resolve(args.root);
const manifestFile = path.join(root, 'manifest.json');

if (command === 'prepare') {
  if(!args.selection)throw new Error('--selection required');
  const selection=JSON.parse(await fs.readFile(args.selection,'utf8'));
  const specs=selection.jobs;
  const jobs = [];
  for (const spec of specs) {
    const publish = path.join(project,'阅读区/视频',spec.title+'.md');
    const original = await fs.readFile(publish);
    const oldReceipt = JSON.parse(await fs.readFile(spec.baseline_receipt,'utf8'));
    if (digest(original) !== oldReceipt.publication.markdown.sha256) throw new Error(`user_edit_detected:${publish}`);
    const baseline = path.join(root,'baseline',spec.title+'.md');
    await fs.mkdir(path.dirname(baseline),{recursive:true});await fs.writeFile(baseline,original,{flag:'wx'});
    jobs.push({...spec,publish,baseline,baseline_sha256:digest(original),source_sha256:oldReceipt.subtitle_sha256,
      subtitle_file:oldReceipt.source_file, run:path.join(root,spec.id,'run'), staging:path.join(root,'candidate-inline',spec.title+'.md')});
  }
  await save(manifestFile,{created_at:new Date().toISOString(),jobs});
  await save(path.join(root,'canary-selection.json'),selection.canary);
  console.log(JSON.stringify({prepared:jobs.map(job=>job.id),root}));
} else if (command === 'run') {
  const manifest=JSON.parse(await fs.readFile(manifestFile,'utf8'));
  const job=manifest.jobs.find(job=>job.id===args.id);if(!job)throw new Error('unknown job');
  if(await sha(path.join(job.input,job.subtitle_file))!==job.source_sha256)throw new Error('source_changed');
  process.env.PR_SPOKEN_AUDIT_DIR=path.join(job.run,'spoken-attempts');
  const result=await importTranscript({inputDir:job.input,outputDir:job.run,publishPath:job.staging});
  console.log(JSON.stringify({id:job.id,status:result.status,quality:result.quality_status,chunks:result.spoken_quality.chunks.length,path:job.staging}));
} else if (command === 'canary') {
  // Independent historical YouTube material: never copied into production rules.
  const selected=JSON.parse(await fs.readFile(path.join(root,'canary-selection.json'),'utf8'));
  const oldReport=JSON.parse(await fs.readFile(selected.report,'utf8'));
  const old=oldReport.rows.find(row=>row.id===selected.id);
  if(!old)throw new Error('canary source not found');
  const spoken=JSON.parse(await fs.readFile(old.spoken_audit,'utf8'));
  const markdown=spoken.artifacts.cleaning_manifest.source_nodes.map(node=>node.text).join('\n\n');
  process.env.PR_SPOKEN_AUDIT_DIR=path.join(root,'youtube-canary/spoken-attempts');
  const run=await preprocessNetworkMarkdown({markdown,sourceType:'youtube_video_transcript',sourceMetadata:{...spoken.source_metadata,
    source_url:old.url,title:old.title,input_form:'spoken_transcript'},spoken:true,processingOptions:{include_reading_guide:false},
    outputDir:path.join(root,'youtube-canary'),cacheDir:'D:/Caches/ProgressiveReading/preprocess/cache'});
  const quality=spokenQualityFromReceipt(run.result.receipt);
  if(!quality?.chunks.length||quality.chunks.some(chunk=>chunk.status!=='passed'))throw new Error('independent_canary_failed');
  const nodes=run.result.artifacts.cleaning_manifest.source_nodes;
  if(nodes.map(node=>node.text).join('\n\n')!==markdown)throw new Error('canary_source_changed');
  await save(path.join(root,'youtube-canary/verification.json'),{status:'passed',url:old.url,source_sha256:digest(markdown),
    paragraphs:nodes.length,chunks:quality.chunks.length,quality,ai_body_additions:run.result.artifacts.cleaning_manifest.ai_additions});
  console.log(JSON.stringify({canary:old.id,status:'passed',chunks:quality.chunks.length}));
} else if (command === 'promote') {
  const manifest=JSON.parse(await fs.readFile(manifestFile,'utf8'));
  if(JSON.parse(await fs.readFile(path.join(root,'youtube-canary/verification.json'),'utf8')).status!=='passed')throw new Error('canary_not_passed');
  // Preflight every target and every file before any write.
  for(const job of manifest.jobs){
    const verification=JSON.parse(await fs.readFile(path.join(job.run,'verification.json'),'utf8'));
    const qualityVerification=JSON.parse(await fs.readFile(path.join(job.run,'quality-verification.json'),'utf8'));
    const receipt=JSON.parse(await fs.readFile(path.join(job.run,'video-receipt.json'),'utf8'));
    if(verification.status!=='passed'||verification.markdown_sha256!==await sha(job.staging))throw new Error('verification_missing_or_stale');
    if(qualityVerification.status!=='passed'||!qualityVerification.same_original_source_nodes
      ||!qualityVerification.all_source_and_quality_reviews_passed
      ||qualityVerification.markdown_sha256!==await sha(job.staging))throw new Error('quality_verification_missing_or_stale');
    if(await sha(job.publish)!==job.baseline_sha256||await sha(job.baseline)!==job.baseline_sha256)throw new Error('target_changed');
    if(await sha(path.join(job.input,job.subtitle_file))!==job.source_sha256)throw new Error('source_changed');
    for(const asset of receipt.publication.assets){
      const dest=path.join(path.dirname(job.publish),asset.markdown_path);
      if(await sha(dest)!==asset.sha256||await sha(asset.published_path)!==asset.sha256)throw new Error('attachment_changed');
    }
  }
  for(const job of manifest.jobs){
    const data=await fs.readFile(job.staging);const temporary=job.publish+'.refinement.tmp';
    await fs.writeFile(temporary,data,{flag:'wx'});await fs.rename(temporary,job.publish);
    if(await sha(job.publish)!==digest(data))throw new Error('promotion_readback_failed');
    for(const name of ['publication.json','video-receipt.json']){
      const file=path.join(job.run,name);const receipt=JSON.parse(await fs.readFile(file,'utf8'));
      const publication=name==='publication.json'?receipt:receipt.publication;
      publication.markdown.path=job.publish;publication.markdown.sha256=digest(data);
      for(const asset of publication.assets)asset.published_path=path.join(path.dirname(job.publish),asset.markdown_path);
      await save(file,receipt);
    }
  }
  await save(path.join(root,'promotion.json'),{status:'completed',promoted_at:new Date().toISOString(),files:await Promise.all(manifest.jobs.map(async job=>({
    path:job.publish,sha256:await sha(job.publish),previous_sha256:job.baseline_sha256,recovery_file:job.baseline}))) });
  console.log(JSON.stringify({promoted:manifest.jobs.map(job=>job.publish)}));
} else throw new Error('command must be prepare|run|canary|promote');
