// Subtitle-only entrance: reuse the existing source cache, never run VideoBook authoring.
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {discover,biliApi,entryPublication} from '../watch-core.mjs';
import {acquireSource,prepareWatchSource,WATCH_ARTIFACTS} from '../watch-process.mjs';
import {LiveCookieSnapshot,defaultCookieDataRoot} from '../../scripts/live-cookie-snapshot.mjs';
const execute=promisify(execFile);
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');

export function authenticatedApi({snapshot,fetchImpl=fetch}={}){
  const workflowRoot=path.resolve(import.meta.dirname,'../..');
  snapshot ??=new LiveCookieSnapshot({workflowRoot,dataRoot:defaultCookieDataRoot(workflowRoot)});
  return endpoint=>biliApi(endpoint,{fetchImpl:async(url,options)=>{
    if(new URL(url).origin!=='https://api.bilibili.com')throw Error('bilibili_api_origin_required');
    snapshot.refresh({force:true});
    if(!snapshot.health().loaded)throw Error('existing_bilibili_login_unavailable');
    const cookie=snapshot.headerForUrl(url);
    if(!cookie)throw Error('existing_bilibili_login_unavailable');
    return fetchImpl(url,{...options,headers:{...options.headers,Cookie:cookie},redirect:'error'});
  }});
}

export function parseParts(text){
  const result=[];
  for(const token of String(text).split(',')){
    const match=/^(\d+)(?:-(\d+))?$/.exec(token.trim());
    if(!match)throw Error('parts_require_inclusive_ranges_or_integers');
    const start=Number(match[1]),end=Number(match[2]||start);
    if(start<1||end<start||end-start>1000)throw Error('invalid_part_range');
    for(let part=start;part<=end;part++)result.push(part);
  }
  if(new Set(result).size!==result.length)throw Error('duplicate_parts');
  return result.sort((a,b)=>a-b);
}

export async function acquire({url,parts,board,output,asrIfNeeded=false,discovery,prepare=prepareWatchSource,api}){
  const requestApi=api||authenticatedApi();
  const found=await (discovery||((watch)=>discover(watch,{api:requestApi})))({url,collection:false});
  const items=parts.map(part=>{
    const item=found.items.find(row=>row.part===part);
    if(!item)throw Error('requested_part_missing:'+part);
    return item;
  });
  const {stdout}=await execute('pdfinfo',['-enc','UTF-8',path.resolve(board)],{windowsHide:true});
  const pageCount=Number(/^Pages:\s+(\d+)/m.exec(stdout)?.[1]);
  if(!Number.isInteger(pageCount)||pageCount<1)throw Error('pdf_page_count_unavailable');
  const records=[];
  for(const item of items){
    item.publish_path=entryPublication(path.dirname(output),item); // Used for source title only.
    const cachedAudio=path.resolve(path.dirname(output),'audio-sources',item.bvid+'-cid'+item.cid,'audio','audio.json');
    const audioStarted=asrIfNeeded && await fs.stat(cachedAudio).then(()=>true,e=>{if(e.code==='ENOENT')return false;throw e;});
    let result=audioStarted?{status:'waiting_source'}:await prepare(item,{public_packages:false},WATCH_ARTIFACTS,
      (sourceItem,watch,jobDir)=>acquireSource(sourceItem,watch,jobDir,{api:requestApi}));
    if(result.status==='waiting_source'){
      if(!asrIfNeeded)throw Error('source_waiting:'+item.part+':'+result.reason);
      const {prepareAudioSource}=await import('./asr-source.mjs');
      result=await prepareAudioSource(item,path.dirname(output));
    }
    const file=path.join(result.sourceDir,'transcript.json'),raw=await fs.readFile(file);
    const transcript=JSON.parse(raw.toString('utf8'));
    if(transcript.cid!==item.cid||transcript.video_id!==`${item.bvid}_p${item.part}`)throw Error('part_source_mismatch');
    records.push({part:item.part,title:item.part_title,url:item.url,cid:item.cid,transcript:file,
      sha256:hash(raw),segments:transcript.segments.length,duration_seconds:transcript.duration,
      subtitle_kind:result.subtitle_kind||'platform_subtitles'});
    console.log(JSON.stringify({part:item.part,status:'source_ready',segments:transcript.segments.length}));
  }
  const bytes=await fs.readFile(board),manifest={source_video:url,parts:records,part_count:records.length,
    total_duration_seconds:records.reduce((sum,row)=>sum+row.duration_seconds,0),
    total_segments:records.reduce((sum,row)=>sum+row.segments,0),
    board:{path:path.resolve(board),bytes:bytes.length,sha256:hash(bytes),pages:pageCount}};
  const data=JSON.stringify(manifest,null,2)+'\n';
  await fs.mkdir(path.dirname(path.resolve(output)),{recursive:true});
  try{await fs.writeFile(output,data,{flag:'wx'});}
  catch(error){if(error.code!=='EEXIST'||await fs.readFile(output,'utf8')!==data)throw Error('source_inventory_exists_with_different_content');}
  return manifest;
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{
    const args={};for(let i=2;i<process.argv.length;i+=2)args[process.argv[i].replace(/^--/,'')]=process.argv[i+1];
    for(const name of ['url','parts','board','output'])if(!args[name])throw Error('required_argument:'+name);
    const result=await acquire({...args,parts:parseParts(args.parts),asrIfNeeded:args['asr-if-needed']==='true'});
    console.log(JSON.stringify({status:'source_acquired',parts:result.part_count,board_pages:result.board.pages}));
  }catch(error){console.error(error.message);process.exitCode=1;}
}
