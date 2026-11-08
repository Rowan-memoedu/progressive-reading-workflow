import fs from 'node:fs/promises';
import path from 'node:path';
import{fileURLToPath}from'node:url';
import { dataPath } from '../scripts/runtime-paths.mjs';
import{discover,observe,processPending,canonicalUrl,videoId,resumePublishedItem}from'./watch-core.mjs';
import{processWatchItem,verifyPublishedForResume}from'./watch-process.mjs';
import{WATCH_WORKFLOW,WATCH_MODEL,WATCH_FRAME_POLICY,assertIllustratedWatch}from'./watch-illustrated.mjs';

const root=import.meta.dirname,project=path.dirname(root);
const dataRoot=process.env.PROGRESSIVE_READING_VIDEO_HOME || dataPath('ProgressiveReading','VideoWatch');
const configFile=dataRoot+'/watchlist.json',stateFile=dataRoot+'/state.json';
const read=async(file,fallback)=>{try{return JSON.parse(await fs.readFile(file,'utf8'));}catch(e){if(e.code==='ENOENT')return fallback;throw e;}};
async function write(file,value){const temporary=file+'.'+process.pid+'.tmp';await fs.writeFile(temporary,JSON.stringify(value,null,2)+'\n');await fs.rename(temporary,file);}
async function withLock(action){
  await fs.mkdir(dataRoot,{recursive:true});
  const file=path.resolve(dataRoot,'watch.lock');let handle;
  try{handle=await fs.open(file,'wx');}catch(error){
    if(error.code!=='EEXIST')throw error;
    const previous=await read(file,null);
    if(!Number.isSafeInteger(previous?.pid))throw Error('watch_lock_requires_inspection');
    try{process.kill(previous.pid,0);throw Error('video_watch_already_running');}
    catch(e){if(e.code!=='ESRCH')throw e;}
    // Only our exact known lock path can be removed after its process is gone.
    if(file!==path.resolve(dataRoot,'watch.lock'))throw Error('unexpected_lock_path');
    await fs.unlink(file);handle=await fs.open(file,'wx');
  }
  try{await handle.writeFile(JSON.stringify({pid:process.pid}));return await action();}
  finally{await handle.close();await fs.unlink(file);}
}

export async function existingPublications(){
  const directory=path.join(project,'阅读区');
  const index=new Map();
  const folders=[directory],files=[];
  while(folders.length){
    const folder=folders.pop();
    for(const entry of await fs.readdir(folder,{withFileTypes:true})){
      if(entry.isDirectory()&&!['_assets','.git','images'].includes(entry.name))folders.push(path.join(folder,entry.name));
      else if(entry.isFile()&&/\.md$/iu.test(entry.name))files.push(path.join(folder,entry.name));
    }
  }
  for(const file of files.sort()){
    const handle=await fs.open(file,'r');
    let text;try{const buffer=Buffer.alloc(8192);const {bytesRead}=await handle.read(buffer,0,buffer.length,0);text=buffer.subarray(0,bytesRead).toString('utf8');}finally{await handle.close();}
    if(!/^---\r?\n/u.test(text))continue;
    const front=text.split(/\r?\n---\r?\n/u)[0];
    const match=/^source_url:\s*(?:"([^"\r\n]+)"|'([^'\r\n]+)'|(https:\/\/\S+))\s*$/mu.exec(front);
    if(!match)continue;
    try{const url=match[1]||match[2]||match[3],bvid=videoId(url),part=Number(new URL(url).searchParams.get('p')||1);
      if(Number.isInteger(part)&&part>0&&!index.has(canonicalUrl(bvid,part)))index.set(canonicalUrl(bvid,part),file);
    }catch{/* Non-Bilibili source URLs are outside this registry. */}
  }
  return index;
}

export async function main(argv=process.argv.slice(2)){
  const command=argv[0],args={};for(let i=1;i<argv.length;i+=2)args[argv[i].replace(/^--/u,'')]=argv[i+1];
  if(!['add','scan','run','status','resume'].includes(command))throw Error('usage: watch.mjs add --url <video> --name <series> --destination <reading-folder> | scan | run | status | resume --key <blocked-publication-key>');
  return withLock(async()=>{
    const config=await read(configFile,{version:1,watches:[]}),storedState=await read(stateFile,null);
    if(config.watches.length&&!storedState)throw Error('watch_state_missing_do_not_reimport_history');
    const state=storedState||{version:1,entries:{}};
    if(command==='status')return {config,state};
    if(command==='resume'){
      const item=await resumePublishedItem(state,args.key,verifyPublishedForResume);
      await write(stateFile,state);
      return {status:item.status,key:item.key,resume_mode:item.resume_mode,model_regeneration_allowed:false};
    }
    const existing=await existingPublications();
    if(command==='add'){
      if(!args.url||!args.name||!args.destination)throw Error('url_name_destination_required');
      const destination=path.resolve(args.destination),inside=path.relative(path.join(project,'阅读区'),destination);
      if(inside.startsWith('..')||path.isAbsolute(inside))throw Error('destination_must_be_inside_reading_area');
      if(args['public-packages']==='true')throw Error('illustrated_watch_uses_original_subtitles_not_prebuilt_books');
      const candidate={url:canonicalUrl(videoId(args.url)),destination,name:args.name,public_packages:false};
      const found=await discover(candidate),id=found.season_id?'bili-season-'+found.season_id:'bili-video-'+videoId(candidate.url);
      const saved=config.watches.find(w=>w.id===id);
      if(saved)return {status:'already_subscribed',watch:saved};
      const watch={...candidate,id,season_id:found.season_id,body_mode:'strong_structuring',workflow:WATCH_WORKFLOW,
        media_policy:'generated_and_reviewed',frame_policy:WATCH_FRAME_POLICY,provider:'codex_exec',model:WATCH_MODEL,part_unit:'individual'};
      observe(state,watch,found.items,{baseline:true,existing});
      config.watches.push(watch);await write(stateFile,state);await write(configFile,config);
      return {status:'subscribed',watch,baseline:found.items.length,existing_publications:found.items.filter(i=>existing.has(i.url)).length};
    }
    const previous=await read(dataRoot+'/last-check.json',null);
    const before=new Map(Object.values(state.entries).map(i=>[i.key,JSON.stringify([i.status,i.reason||null])]));
    const report={checked_at:new Date().toISOString(),new_items:[],events:[],errors:[]};
    for(const watch of config.watches){
      try{assertIllustratedWatch(watch);const found=await discover(watch);report.new_items.push(...observe(state,watch,found.items,{existing}));}
      catch(error){report.errors.push({watch:watch.name,error:String(error.message)});}
    }
    await write(stateFile,state);
    if(command==='run'){
      report.events=await processPending(state,{save:()=>write(stateFile,state),processItem:async item=>{
        const watch=config.watches.find(w=>w.id===item.watch_id);
        if(!watch)throw Error('watch_not_found');
        console.log(JSON.stringify({event:'processing_new_video',title:item.video_title,part:item.part}));
        return processWatchItem(item,watch);
      }});
    }
    report.pending=Object.values(state.entries).filter(i=>['pending','waiting_source'].includes(i.status)).length;
    report.blocked=Object.values(state.entries).filter(i=>i.status==='blocked').map(({key,reason})=>({key,reason}));
    report.changes=Object.values(state.entries).filter(i=>before.get(i.key)!==JSON.stringify([i.status,i.reason||null]))
      .map(({key,video_title,part,status,publication,reason})=>({key,title:video_title,part,status,publication,reason}));
    report.has_updates=report.changes.length>0||JSON.stringify(report.errors)!==JSON.stringify(previous?.errors||[]);
    await write(dataRoot+'/last-check.json',report);return report;
  });
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))main().then(result=>console.log(JSON.stringify(result,null,2))).catch(error=>{console.error(error.message);process.exitCode=1;});
