import fs from 'node:fs/promises';
import path from 'node:path';
import{execFile}from'node:child_process';
import{promisify}from'node:util';
import{randomUUID,createHash}from'node:crypto';
import{LiveCookieSnapshot,defaultCookieDataRoot}from'../scripts/live-cookie-snapshot.mjs';
import { artifactPath } from '../scripts/runtime-paths.mjs';
import{scopedNetscapeCookies}from'./run-authenticated.mjs';
import{biliApi,canonicalUrl}from'./watch-core.mjs';
import{verifyUpstream}from'./import-transcript.mjs';
import{assertIllustratedWatch,watchJobDir,runWatchedIllustrated,VIDEO_PYTHON}from'./watch-illustrated.mjs';
const execute=promisify(execFile),root=import.meta.dirname;
export const WATCH_ARTIFACTS=artifactPath('ProgressiveReading','video-watch');
export const PROCESSING_OPTIONS={workflow_mode:'standard',input_form:'spoken_transcript',content_profile:'natural_language',
  source_language:'zh',structure_body:true,spoken_to_written:false,translate:false,include_reading_guide:true,
  preserve_source_voice:true,forbid_visible_timestamps:true,attribute_unverified_claims:true,normalize_semantic_containers:true};
const read=async file=>JSON.parse(await fs.readFile(file,'utf8'));

export async function publicPackages(){
  try{
  const {stdout:branch}=await execute('gh',['api','repos/Luke-Evan/videobook/branches/pages'],{windowsHide:true,timeout:90000});
  const commit=JSON.parse(branch).commit.sha;
  const {stdout:file}=await execute('gh',['api',`repos/Luke-Evan/videobook/contents/manifest.json?ref=${commit}`],{windowsHide:true,timeout:90000,maxBuffer:4*1024*1024});
  return {commit,manifest:JSON.parse(Buffer.from(JSON.parse(file).content,'base64').toString('utf8'))};
  }catch{throw Error('public_package_registry_unavailable');}
}

export async function acquireSource(item,watch,jobDir,{packages=publicPackages,api=biliApi}={}){
  const sourceDir=path.join(jobDir,'source');
  try{
    const metadata=await read(sourceDir+'/source.json');
    if(metadata.canonical_url!==item.url)throw Error('watch_source_identity_conflict');
    return {sourceDir};
  }catch(error){if(error.code!=='ENOENT')throw error;}
  if(watch.public_packages&&item.part===1&&item.parts===1){
    let upstream;
    try{upstream=await read(jobDir+'/source-request.json');}
    catch(error){
      if(error.code!=='ENOENT')throw error;
      try{upstream=await packages();}catch{return {status:'waiting_source',reason:'public_package_registry_unavailable'};}
    }
    if(upstream.manifest[item.bvid]?.corrected){
      await fs.mkdir(jobDir,{recursive:true});
      await fs.writeFile(jobDir+'/source-request.json',JSON.stringify(upstream,null,2));
      try{await execute('python',[root+'/fetch-public.py','sample','--video-id',item.bvid,'--pages-commit',upstream.commit,'--output',sourceDir],{windowsHide:true,maxBuffer:8*1024*1024});}
      catch(error){
        if(/hash mismatch|Refusing to overwrite|Unsafe tree entry|Truncated GitHub tree/iu.test(String(error.stderr||'')))throw Error('public_source_integrity_failed');
        return {status:'waiting_source',reason:'public_source_download_temporarily_unavailable'};
      }
      return {sourceDir};
    }
  }
  let view;try{view=await api('x/web-interface/view?bvid='+item.bvid);}
  catch{return {status:'waiting_source',reason:'bilibili_metadata_temporarily_unavailable'};}
  const page=view.pages?.find(p=>p.cid===item.cid);
  if(!page)throw Error('subscribed_cid_removed');
  const url=canonicalUrl(item.bvid,page.page);
  item.url=url;item.part=page.page;item.parts=view.pages.length;
  const snapshot=new LiveCookieSnapshot({workflowRoot:path.dirname(root),dataRoot:defaultCookieDataRoot(path.dirname(root))});
  snapshot.refresh({force:true});
  if(!snapshot.health().loaded||!snapshot.headerForUrl(url))return {status:'waiting_source',reason:'target_login_snapshot_unavailable'};
  const cookies=scopedNetscapeCookies(snapshot.jar.cookies,'www.bilibili.com');
  if(!cookies.count)return {status:'waiting_source',reason:'target_login_snapshot_unavailable'};
  await snapshot.protectDirectory();
  const cookiePath=path.join(snapshot.dataRoot,`video-watch-${randomUUID()}.cookies.txt`);
  await fs.mkdir(jobDir,{recursive:true});
  const job={...item,url,part:page.page,parts:view.pages.length,title:path.basename(item.publish_path,'.md').replace(/（强结构化整理）$/u,''),source_dir:sourceDir};
  await fs.writeFile(jobDir+'/subtitle-job.json',JSON.stringify(job,null,2));
  try{
    await fs.writeFile(cookiePath,cookies.text,{flag:'wx',mode:0o600});
    const {stdout}=await execute('D:/Caches/ProgressiveReading/videobook-python/Scripts/python.exe',[
      root+'/watch-subtitles.py','--job',jobDir+'/subtitle-job.json','--cookies-file',cookiePath],{windowsHide:true,maxBuffer:8*1024*1024});
    await fs.writeFile(jobDir+'/subtitle-log.txt',stdout);
  }catch(error){
    const diagnostic=String(error.stderr||'');
    await fs.writeFile(jobDir+'/subtitle-failure.json',JSON.stringify({error:'subtitle_acquisition_failed',
      details:diagnostic.replace(/https?:\/\/\S+/gu,'[source URL omitted]').replaceAll(cookiePath,'[temporary credential]').slice(-3000)},null,2));
    if(/platform_subtitles_not_yet_available|未能获取到任何字幕|There are no subtitles/iu.test(diagnostic))return {status:'waiting_source',reason:'platform_subtitles_not_yet_available'};
    throw Error('subtitle_acquisition_failed; inspect '+jobDir);
  }finally{await fs.unlink(cookiePath).catch(error=>{if(error.code!=='ENOENT')throw error;});}
  return {sourceDir};
}

export async function prepareWatchSource(item,watch,artifactRoot,acquire=acquireSource){
  const jobDir=watchJobDir(artifactRoot,item),sourceDir=jobDir+'/source';
  // Reuse only exact-part original subtitles. Never import the upstream AI book.
  const legacy=path.join(artifactRoot,item.bvid+'-cid'+item.cid,'source');
  if(!await fs.stat(sourceDir+'/source.json').then(()=>true,()=>false)){
    const metadata=await read(legacy+'/source.json').catch(error=>{if(error.code==='ENOENT')return null;throw error;});
    if(metadata?.subtitle_file==='transcript.json'&&metadata.canonical_url===item.url&&metadata.cid===item.cid){
      await fs.mkdir(sourceDir,{recursive:true});
      for(const name of ['transcript.json','source.json']){
        const bytes=await fs.readFile(legacy+'/'+name);
        try{await fs.writeFile(sourceDir+'/'+name,bytes,{flag:'wx'});}
        catch(error){if(error.code!=='EEXIST'||!bytes.equals(await fs.readFile(sourceDir+'/'+name)))throw Error('frozen_watch_subtitle_conflict');}
      }
    }
  }
  const source=await acquire(item,{...watch,public_packages:false},jobDir);
  if(source.status==='waiting_source')return source;
  const metadata=await read(sourceDir+'/source.json'),transcript=await read(sourceDir+'/transcript.json');
  if(metadata.cid!==item.cid||transcript.cid!==item.cid||metadata.canonical_url!==item.url||transcript.video_url!==item.url)
    throw Error('illustrated_watch_source_identity_mismatch');
  return {sourceDir,jobDir};
}

export async function processWatchItem(item,watch,{artifactRoot=WATCH_ARTIFACTS,acquire,runFlow=runWatchedIllustrated,command=execute,onProgress=async()=>{}}={}){
  assertIllustratedWatch(watch);
  const jobDir=watchJobDir(artifactRoot,item),runDir=jobDir+'/run';
  // Fail before any body/guide call if the post-publication renderer is absent.
  try{await command(VIDEO_PYTHON,[
    '-c','import markdown_it, playwright.sync_api, PIL, yt_dlp'],{windowsHide:true});}
  catch{throw Error('video_render_runtime_unavailable: install video-workflow/render-requirements.txt');}
  const acquired=await prepareWatchSource(item,watch,artifactRoot,acquire);
  if(acquired.status==='waiting_source')return acquired;
  const sourceDir=acquired.sourceDir;
  // Preserve a completed receipt; never rerun an already published article.
  let receipt;
  try{receipt=await read(runDir+'/illustrated-receipt.json');}catch(error){if(error.code!=='ENOENT')throw error;}
  if(!receipt&&item.resume_mode==='verification_only')throw Error('saved_receipt_missing_no_regeneration_allowed');
  if(!receipt){
    try{await fs.access(item.publish_path);throw Error('publication_already_exists_without_matching_receipt');}
    catch(error){if(error.code!=='ENOENT')throw error;}
    await verifyUpstream();
    try{receipt=await runFlow({item,watch,sourceDir,runDir,processingOptions:PROCESSING_OPTIONS,onProgress});}
    catch(error){
      if(error.message==='target_login_snapshot_unavailable')return {status:'waiting_source',reason:error.message};
      throw error;
    }
  }
  if(receipt.status!=='completed')throw Error('illustrated_workflow_'+receipt.status+'; inspect '+runDir);
  if(receipt.output_type!=='illustrated'||receipt.model_route?.provider!=='codex_exec'||receipt.model_route?.model!==watch.model
    ||!receipt.body_prompt_unchanged||!(receipt.counts?.images>0)||!(receipt.counts?.mermaid>0)
    ||receipt.capture?.frame_review?.status!=='passed')throw Error('unexpected_video_watch_workflow');
  const actualRun=receipt.board_correction?.run_dir||runDir,actualSource=receipt.board_correction?.source_dir||sourceDir;
  const publication=await read(actualRun+'/video-receipt.json');
  if(publication.refinement?.mode!=='strong_structuring'||publication.reading_guide?.status!=='generated')throw Error('unexpected_video_watch_body_or_guide');
  await onProgress({stage:'verify_publication',part:item.part});
  await command(VIDEO_PYTHON,[root+'/verify-publication.py','--input',actualSource,'--run',actualRun,'--report',jobDir+'/independent-verification.json'],{windowsHide:true,maxBuffer:4*1024*1024});
  await command(VIDEO_PYTHON,[root+'/verify-rendering.py','--markdown',receipt.publication.path,'--output',jobDir+'/rendering'],{windowsHide:true,maxBuffer:4*1024*1024});
  const rendered=await read(jobDir+'/rendering/render-verification.json');
  if(rendered.status!=='passed')throw Error('video_watch_rendering_not_passed');
  return {status:'completed',publication:receipt.publication.path,runDir:actualRun,workflow:'illustrated',model:watch.model,
    media:receipt.counts,rendering:rendered.status};
}

export async function verifyPublishedForResume(item){
  const jobDir=watchJobDir(WATCH_ARTIFACTS,item);
  const illustrated=await read(jobDir+'/run/illustrated-receipt.json');
  if(illustrated.status!=='completed'||illustrated.output_type!=='illustrated')throw Error('completed_illustrated_publication_required');
  const runDir=illustrated.board_correction?.run_dir||jobDir+'/run';
  const sourceDir=illustrated.board_correction?.source_dir||jobDir+'/source';
  const receipt=await read(runDir+'/video-receipt.json');
  if(receipt.status!=='completed'||path.resolve(receipt.publication.markdown.path)!==path.resolve(item.publish_path)
    ||receipt.refinement?.mode!=='strong_structuring'||receipt.reading_guide?.status!=='generated')throw Error('matching_completed_publication_required');
  const actual=createHash('sha256').update(await fs.readFile(item.publish_path)).digest('hex');
  if(actual!==receipt.publication.markdown.sha256)throw Error('published_article_modified_resume_refused');
  await execute(VIDEO_PYTHON,[root+'/verify-publication.py','--input',sourceDir,'--run',runDir],{windowsHide:true,maxBuffer:4*1024*1024});
}
