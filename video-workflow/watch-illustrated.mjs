// Scheduling adapter: retain the existing illustrated authoring/capture pipeline.
import fs from 'node:fs/promises';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash,randomUUID} from 'node:crypto';
import {LiveCookieSnapshot,defaultCookieDataRoot} from '../scripts/live-cookie-snapshot.mjs';
import {scopedNetscapeCookies} from './run-authenticated.mjs';
import {importIllustratedStrong} from './illustrated-strong.mjs';
import {automateBoardCorrection} from './automate-board-correction.mjs';

export const WATCH_WORKFLOW='illustrated';
export const WATCH_MODEL='gpt-6.1-sol';
export const WATCH_FRAME_POLICY='timestamp_integrity';
export const VIDEO_PYTHON=process.env.PROGRESSIVE_READING_VIDEO_PYTHON || 'D:/Caches/ProgressiveReading/videobook-python/Scripts/python.exe';
const execute=promisify(execFile),root=import.meta.dirname;
const read=async file=>JSON.parse(await fs.readFile(file,'utf8'));
const hash=value=>createHash('sha256').update(value).digest('hex');
export const sameStrongPrompt=(left,right)=>String(left).replace(/\r\n/gu,'\n')===String(right).replace(/\r\n/gu,'\n');
export const watchJobDir=(artifactRoot,item)=>path.join(artifactRoot,item.bvid+'-cid'+item.cid,'illustrated');

// Frozen attempts are reusable only for the same source and workflow. A newer
// source, prompt or setting gets its own attempt, preserving earlier evidence.
export async function prepareIllustratedAttempt({item,watch,sourceDir,runDir,processingOptions={}}){
  const prompt=await fs.readFile(path.join(root,'../standard-preprocessing/prompts/强结构化整理.md'));
  if(!sameStrongPrompt(prompt,await fs.readFile('D:/Projects/AudioWorkflow/prompts/refine.md')))throw Error('strong_prompt_alignment_mismatch');
  const transcript=await fs.readFile(path.join(sourceDir,'transcript.json'));
  const implementation=await Promise.all(['watch-illustrated.mjs','illustrated-strong.mjs','import-transcript.mjs','automate-board-correction.mjs'].map(name=>fs.readFile(path.join(root,name))));
  const identity={version:'video-watch-illustrated/v2',entry:'importIllustratedStrong',provider:'codex_exec',model:watch.model,
    source:'full_part_transcript',body_prompt_sha256:hash(prompt),media_policy:watch.media_policy,
    frame_policy:watch.frame_policy||WATCH_FRAME_POLICY,processing_options:processingOptions,
    workflow_sha256:hash(Buffer.concat(implementation)),key:item.key,subtitle_sha256:hash(transcript)};
  const bytes=JSON.stringify(identity,null,2)+'\n',fingerprint=hash(bytes);
  const previous=await fs.readFile(path.join(runDir,'watch-pipeline.json'),'utf8').catch(error=>{if(error.code==='ENOENT')return null;throw error;});
  if(previous!==null&&previous!==bytes){
    const attempt=path.join(path.dirname(runDir),'revisions',fingerprint.slice(0,24));
    const originalSource=sourceDir;sourceDir=path.join(attempt,'source');runDir=path.join(attempt,'run');
    await fs.mkdir(sourceDir,{recursive:true});
    for(const name of ['transcript.json','source.json']){
      const data=name==='transcript.json'?transcript:await fs.readFile(path.join(originalSource,name));
      const file=path.join(sourceDir,name);
      try{await fs.writeFile(file,data,{flag:'wx'});}catch(error){if(error.code!=='EEXIST'||!(await fs.readFile(file)).equals(data))throw Error('frozen_attempt_source_conflict');}
    }
  }
  await fs.mkdir(runDir,{recursive:true});
  const file=path.join(runDir,'watch-pipeline.json');
  try{await fs.writeFile(file,bytes,{flag:'wx'});}catch(error){if(error.code!=='EEXIST'||await fs.readFile(file,'utf8')!==bytes)throw Error('frozen_attempt_identity_conflict');}
  return {sourceDir,runDir,identity_sha256:fingerprint};
}

export function assertIllustratedWatch(watch){
  if(watch.workflow!==WATCH_WORKFLOW||watch.media_policy!=='generated_and_reviewed'||watch.body_mode!=='strong_structuring'
    ||watch.provider!=='codex_exec'||!watch.model)throw Error('watch_requires_explicit_illustrated_workflow');
  if(watch.frame_policy&&watch.frame_policy!==WATCH_FRAME_POLICY)throw Error('watch_requires_timestamp_capture_policy');
}

export async function withCaptureCookies(url,action){
  const snapshot=new LiveCookieSnapshot({workflowRoot:path.dirname(root),dataRoot:defaultCookieDataRoot(path.dirname(root))});
  snapshot.refresh({force:true});
  if(!snapshot.health().loaded||!snapshot.headerForUrl(url))throw Error('target_login_snapshot_unavailable');
  const cookies=scopedNetscapeCookies(snapshot.jar.cookies,'www.bilibili.com');
  if(!cookies.count)throw Error('target_login_snapshot_unavailable');
  await snapshot.protectDirectory();
  const file=path.join(snapshot.dataRoot,'video-watch-capture-'+randomUUID()+'.cookies.txt');
  try{await fs.writeFile(file,cookies.text,{flag:'wx',mode:0o600});return await action(file);}
  finally{await fs.unlink(file).catch(error=>{if(error.code!=='ENOENT')throw error;});}
}

export async function captureAndReview({inputDir,outputDir,cookiesFile,command=execute}){
  const report=path.join(outputDir,'capture-receipt.json');
  const args=['-u',root+'/capture-authenticated.py','--input',inputDir,'--cookies-file',cookiesFile,
    '--plan',path.join(outputDir,'capture-plan.json'),'--report',report,'--frame-policy',WATCH_FRAME_POLICY];
  const capture=async()=>{
    await command(VIDEO_PYTHON,args,{windowsHide:true,maxBuffer:8*1024*1024,env:{...process.env,PYTHONIOENCODING:'utf-8'}});
    return read(report);
  };
  const receipt=await capture();
  if(receipt.status!=='completed'||receipt.frame_review?.status!=='passed'||receipt.frame_review?.policy!=='timestamp_integrity')
    throw Error('capture_timestamp_integrity_not_passed');
  return receipt;
}

export async function runWatchedIllustrated({item,watch,sourceDir,runDir,processingOptions,
  importFlow=importIllustratedStrong,cookies=withCaptureCookies,capture=captureAndReview,completeBoard=automateBoardCorrection,onProgress=async()=>{}}){
  assertIllustratedWatch(watch);
  const attempt=await prepareIllustratedAttempt({item,watch,sourceDir,runDir,processingOptions});
  ({sourceDir,runDir}=attempt);
  const settings={AI_PRODUCER_PROVIDER:'codex_exec',AI_PRODUCER_CODEX_MODEL:watch.model,
    AI_PRODUCER_TIMEOUT_MS:process.env.AI_PRODUCER_TIMEOUT_MS||'1800000',
    PR_GUIDE_RESPONSE_CACHE_DIR:path.join(path.dirname(runDir),'provider-responses')};
  const old=Object.fromEntries(Object.keys(settings).map(key=>[key,process.env[key]]));
  Object.assign(process.env,settings);
  try{
    return await cookies(item.url,async cookiesFile=>{
      const args={inputDir:sourceDir,outputDir:runDir,publishPath:item.publish_path,
        cookiesFile,pythonPath:VIDEO_PYTHON,processingOptions,
        captureFrames:()=>capture({inputDir:sourceDir,outputDir:runDir,cookiesFile})};
      let receipt=await importFlow(args);
      if(receipt.status==='needs_board_correction'){
        await completeBoard({sourceDir,runDir,part:item.part||1,pythonPath:VIDEO_PYTHON,onProgress,
          captureEvidence:({inputDir,outputDir})=>capture({inputDir,outputDir,cookiesFile})});
        await onProgress({stage:'generate_body_and_guide',part:item.part});
        receipt=await importFlow(args);
      }
      return {...receipt,watch_attempt:attempt};
    });
  }finally{for(const [key,value]of Object.entries(old))if(value===undefined)delete process.env[key];else process.env[key]=value;}
}
