import fs from 'node:fs/promises';
import path from 'node:path';
import {readJson,writeJson,digest,paths,loadConfig,withLock} from '../subscription-workflow/config.mjs';
import {acquireLock} from '../rss-import/core.mjs';
import {relocatedPath,relocatedMarkdown,replaceChecked} from '../subscription-workflow/report-archive.mjs';
import {sourceAliasResolver,findSourcePublications,sourceReuseResult} from '../scripts/reading-source-library.mjs';
import {urlImportDedupeKey} from '../scripts/url-import-input.mjs';
import {listRuns,runPath} from './store.mjs';
import {taxonomyFolder,taxonomyGroups} from './taxonomy.mjs';
import {moveInReadingHost} from './reader-moves.mjs';
import {knownIndexes} from './indexes.mjs';

const inside=(base,file)=>{const relative=path.relative(base,file);return relative!== '..'&&!relative.startsWith('..'+path.sep)&&!path.isAbsolute(relative);};
const locationKey=file=>process.platform==='win32'?path.resolve(file).toLowerCase():path.resolve(file);
const exists=file=>fs.access(file).then(()=>true,()=>false);
async function walk(directory){const files=[];for(const entry of await fs.readdir(directory,{withFileTypes:true}).catch(e=>{if(e.code==='ENOENT')return [];throw e;})){if(entry.isSymbolicLink())continue;const file=path.join(directory,entry.name);if(entry.isDirectory()){if(!['_assets','images','附件','node_modules','.git'].includes(entry.name))files.push(...await walk(file));}else if(entry.isFile())files.push(file);}return files;}
function receiptRelocator(mapping,root){
  const entries=[...mapping].map(([from,to])=>({from:from.replaceAll('\\','/'),to,relative:path.relative(root,from).replaceAll('\\','/'),next:path.relative(root,to).replaceAll('\\','/')}));
  const exact=new Map(entries.flatMap(item=>[[item.from,item.to],[item.relative,item.next]]));
  return value=>{
    if(mapping.has(value))return mapping.get(value);
    if(/^[a-z][a-z0-9+.-]*:\/\//iu.test(value))return relocatedPath(value,mapping,root);
    const slash=value.replaceAll('\\','/');let changed=exact.get(slash);
    if(changed===undefined){const entry=entries.find(item=>item.relative&&slash.endsWith('/'+item.relative));if(entry)changed=slash.slice(0,-entry.relative.length)+entry.next;}
    return changed===undefined?value:value.includes('\\')?changed.replaceAll('/','\\'):changed.replaceAll('\\','/');
  };
}
export function remapReceipts(value,mapping,root,hashes,relocate=receiptRelocator(mapping,root)){
  if(Array.isArray(value))return value.map(v=>remapReceipts(v,mapping,root,hashes,relocate));
  if(!value||typeof value!=='object')return value;
  const result={};for(const [key,item]of Object.entries(value)){result[key]=typeof item==='string'&&/(?:path|paths|file|uri)$/iu.test(key)?relocate(item):remapReceipts(item,mapping,root,hashes,relocate);}
  if(result.path&&hashes.has(result.path)&&result.sha256)result.sha256=hashes.get(result.path);
  const markdown=result.artifacts?.find?.(a=>a.kind==='markdown');if(markdown&&result.receipt?.final_markdown_sha256)result.receipt.final_markdown_sha256=markdown.sha256;
  if(result.document?.path&&result.content?.markdownSha256){const file=path.resolve(root,result.document.path);if(hashes.has(file))result.content.markdownSha256=hashes.get(file);}
  return result;
}

export async function organizeSiteFiles(root,settings,collection,id,{broker,onProgress=async()=>{}}={}){
  const config=await loadConfig(root);if(!config)return organizeUnlocked(root,settings,collection,id,{broker,onProgress});
  return withLock(path.join(paths(root).home,'worker.lock'),async()=>{const release=await acquireLock(config.rss_home);try{return await organizeUnlocked(root,settings,collection,id,{broker,onProgress});}finally{await release();}});
}
async function organizeUnlocked(root,settings,collection,id,{broker,onProgress=async()=>{}}={}){
  const directory=runPath(root,id),journal=path.join(directory,'organization.json');let saved=await readJson(journal);
  if(saved?.status==='completed'){collection.results=remapReceipts(collection.results,new Map(saved.mapping),root,new Map(saved.hashes));return saved;}
  if(saved?.status==='running')return executeOrganization(root,collection,journal,saved,broker);
  // Finish the newest interrupted move before planning another one. Native
  // reader moves may already be durable while the client receipt was lost.
  const history=(await listRuns(root)).filter(run=>run.source_id===settings.id&&run.id!==id);
  await onProgress('检查可恢复的目录迁移记录');
  for(const previous of history){const priorJournal=path.join(runPath(root,previous.id),'organization.json'),prior=await readJson(priorJournal);if(prior?.status==='completed')break;if(prior?.status!=='running')continue;
    await executeOrganization(root,collection,priorJournal,prior,broker);
    const live=await findSourcePublications(root,collection.inventory.articles.map(a=>a.url));
    collection.results=collection.results.map(row=>{const current=live.get(urlImportDedupeKey(row.requested_url));return current?sourceReuseResult(row.requested_url,current):row;});
    // Earlier interrupted attempts are covered only when every move really
    // reached its destination. Keep incomplete evidence otherwise.
    for(const earlier of history){if(earlier.id===previous.id)continue;const file=path.join(runPath(root,earlier.id),'organization.json'),state=await readJson(file);if(state?.status!=='running')continue;if((await Promise.all((state.moves||[]).map(async m=>!await exists(m.source)&&await exists(m.target)))).every(Boolean))await writeJson(file,{...state,status:'superseded',superseded_by:previous.id});}
    break;
  }
  const base=path.join(root,'阅读区',settings.destination),identity=await sourceAliasResolver(root),current=new Map(collection.results.filter(r=>r.artifacts?.some(a=>a.kind==='markdown')).map(r=>[identity(r.requested_url),r]));
  await onProgress('核对重复副本与已有阅读状态');
  const moves=[],duplicates=[];
  for(const article of collection.inventory.articles){const row=current.get(identity(article.url));if(!row)continue;const artifact=row.artifacts.find(a=>a.kind==='markdown');
    if(!inside(path.join(root,'阅读区'),artifact.path)||row.receipt?.aggregate)continue;
    const target=path.join(root,'阅读区',taxonomyFolder(settings.destination,article.taxonomy),path.basename(artifact.path));
    if(locationKey(target)!==locationKey(artifact.path))moves.push({source:artifact.path,target,sha256:artifact.sha256});
  }
  // Only retire unchanged files created by previous runs of this site source.
  // Existing RSS/user files always win, even when their translated body differs.
  const seen=new Set();for(const previous of await listRuns(root)){if(previous.source_id!==settings.id||previous.id===id)continue;for(const row of previous.results||[]){if(!['imported','imported_with_warnings'].includes(row.status))continue;const artifact=row.artifacts?.find(a=>a.kind==='markdown'),winner=current.get(identity(row.requested_url))?.artifacts?.find(a=>a.kind==='markdown');if(!artifact||!winner||artifact.path===winner.path||!inside(base,artifact.path)||seen.has(artifact.path)||!await exists(artifact.path))continue;
    if(locationKey(artifact.path)===locationKey(winner.path))continue;
    if(digest(await fs.readFile(artifact.path))!==artifact.sha256)throw new Error('重复副本已有人工修改，已保留：'+artifact.path);
    const state=await readJson(path.join(root,'.local-ir/browser-document-state',path.basename(artifact.path)+'.browser-ir.json'));
    if(state?.annotations?.length||state?.qaCards?.length||state?.articleMusing)throw new Error('重复副本带有阅读加工，已保留：'+artifact.path);
    duplicates.push({source:artifact.path,winner:winner.path,sha256:artifact.sha256});seen.add(artifact.path);
  }}
  const targets=new Set();for(const move of moves){if(!inside(base,move.target)||targets.has(locationKey(move.target))||(await exists(move.target)&&locationKey(move.target)!==locationKey(move.source)))throw new Error('分类目录目标冲突：'+move.target);targets.add(locationKey(move.target));}
  const recovery=path.join(directory,'recovery');await fs.mkdir(recovery,{recursive:true});
  await onProgress('核对分类目录与旧链接');
  const ownedIndexes=[];for(const [file,hashes]of await knownIndexes(root,settings.id))if(await exists(file)&&hashes.has(digest(await fs.readFile(file))))ownedIndexes.push(file);
  const mapping=new Map(moves.map(m=>[m.source,m.target]));for(const d of duplicates)mapping.set(d.source,mapping.get(d.winner)||d.winner);
  // A previous reader batch may have moved files before its client lost the
  // response. Reuse verified actual locations and finish reference repair.
  const actualPaths=new Set([...current.values()].map(row=>row.artifacts.find(a=>a.kind==='markdown').path));
  for(const previous of await listRuns(root)){if(previous.source_id!==settings.id)continue;const old=await readJson(path.join(runPath(root,previous.id),'organization.json'));if(old?.status!=='running')continue;for(const move of old.moves||[])if(actualPaths.has(move.target)&&!await exists(move.source)&&await exists(move.target))mapping.set(move.source,mapping.get(move.target)||move.target);}
  for(const move of moves){const text=await fs.readFile(move.source,'utf8');if(digest(text)!==move.sha256)throw new Error('文章已发生变更，未移动：'+move.source);move.expected=relocatedMarkdown(text,move.source,move.target,mapping,root);await fs.writeFile(path.join(recovery,digest(move.source)+'.md'),text);}
  saved={status:'running',moves:moves.map(({expected,...m})=>m),duplicates,mapping:[...mapping],recovery,ownedIndexes};await writeJson(journal,saved);
  await onProgress('同步阅读状态和引用链接');
  return executeOrganization(root,collection,journal,saved,broker);
}

async function executeOrganization(root,collection,journal,saved,broker){
  const {recovery}=saved,mapping=new Map(saved.mapping.filter(([from,to])=>locationKey(from)!==locationKey(to))),moves=[];
  let restored=0;
  for(const duplicate of saved.duplicates.filter(d=>locationKey(d.source)===locationKey(d.winner))){
    const backup=path.join(recovery,'duplicate-'+digest(duplicate.source)+'.md');
    if(!await exists(duplicate.source)){if(!await exists(backup)||digest(await fs.readFile(backup))!==duplicate.sha256)throw new Error('同路径文件恢复记录不完整');await fs.mkdir(path.dirname(duplicate.source),{recursive:true});await fs.rename(backup,duplicate.source);restored++;}
    if(digest(await fs.readFile(duplicate.source))!==duplicate.sha256)throw new Error('同路径文件已有修改，未覆盖');
    const sidecar=path.join(root,'.local-ir/browser-document-state',path.basename(duplicate.source)+'.browser-ir.json'),stateBackup=path.join(recovery,'duplicate-'+digest(duplicate.source)+'.state.json');if(await exists(stateBackup)&&!await exists(sidecar))await fs.rename(stateBackup,sidecar);
  }
  const duplicates=saved.duplicates.filter(d=>locationKey(d.source)!==locationKey(d.winner));
  for(const move of saved.moves){const before=await fs.readFile(path.join(recovery,digest(move.source)+'.md'),'utf8');moves.push({...move,expected:relocatedMarkdown(before,move.source,move.target,mapping,root)});}
  const host=await moveInReadingHost(root,moves.filter(m=>!m.done),recovery,duplicates.map(d=>d.source));
  for(const move of moves){if(await exists(move.source)){await fs.mkdir(path.dirname(move.target),{recursive:true});await replaceChecked(move.target,null,move.expected);if(digest(await fs.readFile(move.source))!==move.sha256)throw new Error('移动时文章发生变化');await fs.unlink(move.source);}let actual=await fs.readFile(move.target,'utf8');if(actual!==move.expected&&digest(actual)===move.sha256){await replaceChecked(move.target,actual,move.expected);actual=move.expected;}if(actual!==move.expected)throw new Error('移动后的正文与链接核验未通过：'+move.target);}
  for(const duplicate of duplicates){const target=path.join(recovery,'duplicate-'+digest(duplicate.source)+'.md');if(await exists(duplicate.source)){if(digest(await fs.readFile(duplicate.source))!==duplicate.sha256)throw new Error('重复副本发生变化，未移出');await fs.rename(duplicate.source,target);}else if(!await exists(target)||digest(await fs.readFile(target))!==duplicate.sha256)throw new Error('重复副本恢复记录不完整');const sidecar=path.join(root,'.local-ir/browser-document-state',path.basename(duplicate.source)+'.browser-ir.json');if(await exists(sidecar))await fs.rename(sidecar,path.join(recovery,'duplicate-'+digest(duplicate.source)+'.state.json'));}
  const hashes=new Map();for(const target of new Set(mapping.values()))hashes.set(target,digest(await fs.readFile(target)));
  // Repair article/report links and persisted receipts; source text and model
  // caches are immutable inputs, so only active reading/runtime state is touched.
  for(const zone of ['阅读区','待归档原文','已归档原文','摘要区'])for(const file of await walk(path.join(root,zone))){if(!file.endsWith('.md'))continue;const before=await fs.readFile(file,'utf8'),after=relocatedMarkdown(before,file,file,mapping,root);if(after!==before){await fs.writeFile(path.join(recovery,digest(file)+'.reference.md'),before);await replaceChecked(file,before,after);hashes.set(file,digest(after));}}
  const config=await loadConfig(root),metadata=new Set([path.join(root,'imports/rss-reading/review-ledger.v1.json')]);
  for(const file of await walk(path.join(root,'.local-ir/browser-document-state')))if(file.endsWith('.json'))metadata.add(file);
  if(config){metadata.add(path.join(config.rss_home,'state.json'));metadata.add(path.join(paths(root).home,'activity.json'));}
  for(const run of await listRuns(root))if(path.join(runPath(root,run.id),'organization.json')!==journal)metadata.add(path.join(runPath(root,run.id),'run.json'));
  for(const file of metadata){const before=await readJson(file);if(!before)continue;const after=remapReceipts(before,mapping,root,hashes);if(JSON.stringify(before)!==JSON.stringify(after)){await writeJson(path.join(recovery,digest(file)+'.json'),before);await writeJson(file,after);}}
  await broker?.relocateSourceArtifacts?.([...mapping],[...hashes]);
  collection.results=remapReceipts(collection.results,mapping,root,hashes);
  const owned_index_hashes=[];for(const file of saved.ownedIndexes||[])if(await exists(file))owned_index_hashes.push([file,digest(await fs.readFile(file))]);
  saved={...saved,duplicates,mapping:[...mapping],same_location_restored:(saved.same_location_restored||0)+restored,status:'completed',host,hashes:[...hashes],owned_index_hashes,moved:moves.length,duplicates_retired:duplicates.length,groups:taxonomyGroups(collection.inventory.articles).map(g=>({kind:g.kind,name:g.name,folder:g.folder,count:g.articles.length}))};await writeJson(journal,saved);return saved;
}
