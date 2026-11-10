import fs from 'node:fs/promises';
import path from 'node:path';
import {paths,loadConfig,readJson,writeJson,digest,withLock,validateConfig} from './config.mjs';
import {acquireLock} from '../rss-import/core.mjs';
import {renameWithRetry} from '../rss-source/core.mjs';
import {materialKey} from './catalog.mjs';
import {readingDestination} from './reading-options.mjs';
import {moveReport,relocatedMarkdown,relocatedPath} from './report-archive.mjs';
import {readSources as readSiteSources} from '../site-import/store.mjs';

const zones=['阅读区','待归档原文','已归档原文'];
const inside=(base,file)=>{const relative=path.relative(base,file);return relative!== '..'&&!relative.startsWith('..'+path.sep)&&!path.isAbsolute(relative);};
const exists=file=>fs.access(file).then(()=>true,()=>false);
const sourceDestination=source=>readingDestination({subscription_kind:source.kind,subscription_name:source.name});
async function walk(folder){
  const result=[];
  for(const entry of await fs.readdir(folder,{withFileTypes:true}).catch(error=>{if(error.code==='ENOENT')return [];throw error;})){
    const file=path.join(folder,entry.name);
    if(entry.isSymbolicLink())continue;
    if(entry.isDirectory())result.push(...await walk(file));
    else if(entry.isFile())result.push(file);
  }
  return result;
}
function itemOwners(config,item,platform){
  const matches=config.subscriptions.filter(source=>item.subscription_ids?.includes(source.id)||item.feed_url===source.url||item.feeds?.includes(source.url)
    ||(source.watch?.id&&(item.watch_ids?.includes(source.watch.id)||item.watch_id===source.watch.id)));
  if(matches.length)return matches;
  if(platform==='rss'&&(item.feed_url||item.feeds?.length)){
    const url=item.feed_url||item.feeds[0];return [{kind:'rss',name:item.subscription_name||new URL(url).hostname,url}];
  }
  return [];
}
async function safeTarget(root,zone,file){
  const base=path.join(root,zone);
  if(!inside(base,file)||file===base)throw new Error('subscription_storage_outside_zone');
  let ancestor=path.dirname(file);while(!await exists(ancestor)){const parent=path.dirname(ancestor);if(parent===ancestor)break;ancestor=parent;}
  const actual=await fs.realpath(ancestor),actualBase=await fs.realpath(base).catch(()=>path.resolve(base));
  if(!inside(actualBase,actual))throw new Error('subscription_storage_symlink_escape');
}
function rewriteMetadata(value,mapping,root,hashes,key=''){
  if(typeof value==='string')return /(?:^|_)(?:path|paths|file|files|uri|directory|folder|destination)$|^publication$/u.test(key)?relocatedPath(value,mapping,root):value;
  if(Array.isArray(value))return value.map(item=>rewriteMetadata(item,mapping,root,hashes,key));
  if(!value||typeof value!=='object')return value;
  const result=Object.fromEntries(Object.entries(value).map(([name,item])=>[name,rewriteMetadata(item,mapping,root,hashes,name)]));
  if(value.path&&mapping.has(value.path)&&value.sha256&&hashes.has(mapping.get(value.path)))result.sha256=hashes.get(mapping.get(value.path));
  return result;
}

export async function planReadingOrganization(root,{onProgress=()=>{}}={}){
  root=path.resolve(root);
  const p=paths(root),config=await loadConfig(root);if(!config)throw new Error('subscription_configuration_missing');
  const siteRoots=(await readSiteSources(root)).sources.flatMap(source=>zones.map(zone=>path.join(root,zone,source.destination)));
  const ledgerPath=path.join(root,'imports/rss-reading/review-ledger.v1.json'),autoPath=path.join(config.rss_home,'state.json'),videoPath=path.join(config.video_home,'state.json');
  const ledger=await readJson(ledgerPath,{items:{}}),auto=await readJson(autoPath,{items:{}}),video=await readJson(videoPath,{entries:{}});
  const ownersByPath=new Map(),ownersByUrl=new Map();
  const add=(file,url,owners)=>{if(!owners.length)return;if(file)ownersByPath.set(path.resolve(file),owners);if(url){try{const key=materialKey(url);ownersByUrl.set(key,[...new Map([...(ownersByUrl.get(key)||[]),...owners].map(s=>[s.id||s.url,s])).values()]);}catch{}}};
  for(const item of Object.values(ledger.items))add(item.publication?.path,item.item_url,itemOwners(config,item,item.platform||'rss'));
  for(const item of Object.values(auto.items))for(const artifact of item.artifacts||[])add(artifact.path,item.url,itemOwners(config,item,'rss'));
  for(const item of Object.values(video.entries))add(item.publication,item.url,itemOwners(config,item,'bilibili'));
  const directories=config.subscriptions.flatMap(source=>zones.map(zone=>path.join(root,zone,sourceDestination(source))));
  const folderNames=new Map();for(const source of config.subscriptions){const folder=sourceDestination(source).toLowerCase();if(folderNames.has(folder)&&folderNames.get(folder)!==source.id)throw new Error('subscription_source_folder_collision');folderNames.set(folder,source.id);}
  const files=[];for(const zone of zones){for(const file of await walk(path.join(root,zone)))files.push({file,zone});onProgress({stage:'inventory',zone,files:files.length});}
  const bundles=[];
  for(const source of config.subscriptions.filter(s=>s.kind.startsWith('bilibili_'))){
    const old=String(source.destination||'');
    if(!old||old.replaceAll('\\','/').startsWith('订阅/'))continue;
    if(config.subscriptions.filter(s=>s.destination===source.destination).length!==1)continue;
    for(const zone of zones){const from=path.resolve(root,zone,old),to=path.join(root,zone,sourceDestination(source));if(await exists(from))bundles.push({from,to,source});}
  }
  const moves=[],markdown=[],unmatched=[];
  for(const {file,zone} of files){
    const assetPath=path.relative(path.join(root,zone),file).split(path.sep).some(part=>['_assets','images','附件'].includes(part));
    const isMarkdown=file.toLowerCase().endsWith('.md')&&!assetPath;let text,owners=ownersByPath.get(file),target;
    const bundle=bundles.find(b=>inside(b.from,file));
    if(bundle){owners=[bundle.source];target=path.join(bundle.to,path.relative(bundle.from,file));}
    if(isMarkdown){
      const handle=await fs.open(file,'r');try{const buffer=Buffer.alloc(16384),read=await handle.read(buffer,0,buffer.length,0);text=buffer.subarray(0,read.bytesRead).toString('utf8');}finally{await handle.close();}
      markdown.push({file});
      const archiveId=/<!-- subscriptions:archive-source ([^\s>]+) -->/u.exec(text)?.[1];
      const archiveOwner=archiveId&&config.subscriptions.find(s=>s.id===archiveId);
      if(archiveOwner){owners=[archiveOwner];target=path.join(root,zone,sourceDestination(archiveOwner),'短文归档.md');}
      if(!owners){
        const url=/^(?:source_url|canonical_url):\s*["']?(https?:\/\/[^\s"']+)/mu.exec(text)?.[1];
        if(url){try{owners=ownersByUrl.get(materialKey(url));}catch{}}
      }
      const relative=path.relative(path.join(root,zone),file).split(path.sep);
      if(!owners&&relative[0]==='RSS'){
        const candidates=config.subscriptions.filter(s=>s.kind==='rss'&&s.name===relative[1]);if(candidates.length===1)owners=candidates;else unmatched.push(file);
      }
      if(owners&&!target){
        const owner=owners.find(s=>s.name&&relative.includes(s.name))||owners[0];owners=[owner,...owners.filter(s=>s!==owner)];
        const destinationRoot=path.join(root,zone,sourceDestination(owner));
        target=inside(destinationRoot,file)||siteRoots.some(base=>inside(base,file))?file:path.join(destinationRoot,path.basename(file));
      }
    }
    if(!target||target===file)continue;
    await safeTarget(root,zone,file);await safeTarget(root,zone,target);
    const stat=await fs.stat(file),bytes=await fs.readFile(file);
    moves.push({source:file,target,zone,subscription:owners[0].name,kind:owners[0].kind,source_id:owners[0].id,
      destination:sourceDestination(owners[0]),sha256:digest(bytes),markdown:isMarkdown,atime:stat.atime.toISOString(),mtime:stat.mtime.toISOString()});
  }
  const targets=new Set();for(const move of moves){if(targets.has(move.target)||await exists(move.target))throw new Error('subscription_storage_destination_collision:'+move.target);targets.add(move.target);}
  const mapping=new Map(moves.map(move=>[move.source,move.target]));for(const bundle of bundles)mapping.set(bundle.from,bundle.to);
  for(const move of moves)move.destination_sha256=move.markdown?digest(relocatedMarkdown(await fs.readFile(move.source,'utf8'),move.source,move.target,mapping,root)):move.sha256;
  const hashes=new Map(moves.map(move=>[move.target,move.destination_sha256]));
  for(const file of await walk(p.summaryRoot))if(file.endsWith('.md'))markdown.push({file});
  const updates=[];
  let checked=0;for(const {file}of markdown){if(mapping.has(file))continue;const text=await fs.readFile(file,'utf8'),after=relocatedMarkdown(text,file,file,mapping,root);if(after!==text)updates.push({file,sha256:digest(text),text:after,kind:'markdown'});if(++checked%200===0)onProgress({stage:'references',checked});}
  const metadataFiles=new Set([ledgerPath,autoPath,videoPath,path.join(config.video_home,'watchlist.json'),path.join(p.home,'activity.json')]);
  for(const file of await walk(path.join(root,'.local-ir/browser-document-state')))if(file.endsWith('.json'))metadataFiles.add(file);
  for(const item of Object.values(ledger.items))for(const key of ['publication_path','result_path']){
    const file=item.publication?.[key];if(file?.endsWith('.json')&&(inside(root,file)||inside(p.artifactRoot,file)||inside('D:/Artifacts/ProgressiveReading',file)))metadataFiles.add(file);
  }
  for(const file of metadataFiles){
    if(!await exists(file))continue;const text=await fs.readFile(file,'utf8'),before=JSON.parse(text),after=rewriteMetadata(before,mapping,root,hashes);
    if(file===ledgerPath){
      for(const item of Object.values(after.items||{})){const owner=itemOwners(config,item,item.platform||'rss')[0];if(owner){item.subscription_kind=owner.kind;item.subscription_name=owner.name;item.destination=sourceDestination(owner);}}
      for(const id of Object.keys(after.short_archive_sources||{})){const owner=config.subscriptions.find(s=>s.id===id);if(owner)after.short_archive_sources[id]=path.join(path.relative('订阅',sourceDestination(owner)),'短文归档.md').replaceAll('\\','/');}
    }
    if(before.document?.path&&after.document?.path!==before.document.path&&after.browser?.sourceMetadata){
      const match=moves.find(move=>relocatedPath(before.document.path,new Map([[move.source,move.target]]),root)!==before.document.path);
      if(match)after.browser.sourceMetadata.destination_folder=match.destination;
    }
    if(file.endsWith('watchlist.json'))for(const watch of after.watches||[]){const source=config.subscriptions.find(s=>s.watch?.id===watch.id);if(source)watch.destination=path.join(root,'阅读区',sourceDestination(source));}
    const rendered=JSON.stringify(after,null,2)+'\n';if(JSON.stringify(before)!==JSON.stringify(after))updates.push({file,sha256:digest(text),text:rendered,kind:'json'});
  }
  const next=structuredClone(config);
  for(const source of next.subscriptions){source.destination=sourceDestination(source);if(source.watch)source.watch.destination=path.join(root,'阅读区',source.destination);}
  const configChanged=JSON.stringify(next.subscriptions)!==JSON.stringify(config.subscriptions);
  if(configChanged){next.revision++;next.updated_at=new Date().toISOString();validateConfig(next);const old=await fs.readFile(p.config,'utf8');updates.push({file:p.config,sha256:digest(old),text:JSON.stringify(next,null,2)+'\n',kind:'json'});}
  return {schema:'progressive-reading.subscription-storage/v1',root,ledgerPath,autoPath,moves,updates,directories,unmatched,mapping:[...mapping],config_revision:config.revision};
}

async function replaceVerified(file,beforeHash,after){
  const current=await fs.readFile(file,'utf8');if(current===after)return;
  if(digest(current)!==beforeHash)throw new Error('subscription_reference_changed:'+file);
  const temporary=file+'.subscription-layout.tmp';await fs.writeFile(temporary,after,'utf8');
  if(digest(await fs.readFile(file))!==beforeHash)throw new Error('subscription_reference_changed:'+file);
  await renameWithRetry(temporary,file);
}
export async function organizeReadingSubscriptions(root,{recoveryRoot,onProgress=()=>{}}={}){
  const p=paths(root),config=await loadConfig(root);
  return withLock(path.join(p.home,'worker.lock'),async()=>{
    const release=await acquireLock(config.rss_home);
    try{return await withLock(p.config+'.lock',async()=>{
      const journal=path.join(p.home,'subscription-storage-organization.json');let pending=await readJson(journal);
      if(pending?.status==='running'&&(pending.root!==path.resolve(root)||pending.schema!=='progressive-reading.subscription-storage/v1'))throw new Error('subscription_storage_journal_conflict');
      if(pending?.status!=='running'){
        const plan=await planReadingOrganization(root,{onProgress});
        if(!plan.moves.length&&!plan.updates.length){for(const directory of plan.directories)await fs.mkdir(directory,{recursive:true});return {...plan,status:'completed'};}
        const recovery=path.resolve(recoveryRoot||path.join(p.artifactRoot,'storage-organization',new Date().toISOString().replaceAll(':','-')));
        await fs.mkdir(path.join(recovery,'originals'),{recursive:true});await fs.mkdir(path.join(recovery,'updates'),{recursive:true});
        pending={...plan,status:'running',recovery,backups:[],completed_moves:[]};
        for(const file of new Set([...plan.moves.filter(m=>m.markdown).map(m=>m.source),...plan.updates.map(u=>u.file)])){
          const backup=path.join(recovery,'originals',digest(file)+'.bin');await fs.copyFile(file,backup);pending.backups.push({file,backup,sha256:digest(await fs.readFile(file))});
        }
        for(const update of pending.updates){update.after_file=path.join(recovery,'updates',digest(update.file)+'.bin');await fs.writeFile(update.after_file,update.text,'utf8');delete update.text;}
        await writeJson(path.join(recovery,'migration-plan.json'),pending);await writeJson(journal,pending);
      }
      const mapping=new Map(pending.mapping);
      for(const move of pending.moves){
        if(pending.completed_moves.includes(move.source))continue;
        await safeTarget(root,move.zone,move.source);await safeTarget(root,move.zone,move.target);
        if(move.markdown)await moveReport(move.source,move.target,move.sha256,move.destination_sha256,mapping,path.resolve(root));
        else{
          if(await exists(move.source)){
            if(digest(await fs.readFile(move.source))!==move.sha256)throw new Error('subscription_asset_changed:'+move.source);
            if(await exists(move.target))throw new Error('subscription_asset_destination_exists:'+move.target);
            await fs.mkdir(path.dirname(move.target),{recursive:true});await fs.rename(move.source,move.target);
          }
          if(digest(await fs.readFile(move.target))!==move.sha256)throw new Error('subscription_asset_verification_failed');
        }
        await fs.utimes(move.target,new Date(move.atime),new Date(move.mtime));
        pending.completed_moves.push(move.source);if(pending.completed_moves.length%20===0||pending.completed_moves.length===pending.moves.length)await writeJson(journal,pending);onProgress({moved:pending.completed_moves.length,total:pending.moves.length});
      }
      for(const update of pending.updates)await replaceVerified(update.file,update.sha256,await fs.readFile(update.after_file,'utf8'));
      for(const directory of pending.directories)await fs.mkdir(directory,{recursive:true});
      for(const move of pending.moves){if(await exists(move.source)||digest(await fs.readFile(move.target))!==move.destination_sha256)throw new Error('subscription_storage_verification_failed:'+move.target);}
      const parents=[...new Set(pending.moves.flatMap(move=>{const result=[];for(let dir=path.dirname(move.source);zones.some(zone=>inside(path.join(root,zone),dir)&&dir!==path.join(root,zone));dir=path.dirname(dir))result.push(dir);return result;}))].sort((a,b)=>b.length-a.length);
      for(const directory of parents)await fs.rmdir(directory).catch(error=>{if(!['ENOTEMPTY','ENOENT','EEXIST'].includes(error.code))throw error;});
      pending.status='completed';pending.completed_at=new Date().toISOString();await writeJson(journal,pending);await writeJson(path.join(pending.recovery,'migration-receipt.json'),pending);
      return pending;
    });}finally{await release();}
  });
}
