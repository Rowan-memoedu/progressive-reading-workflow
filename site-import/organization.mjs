import fs from 'node:fs/promises';
import path from 'node:path';
import {readJson,writeJson,digest,paths,loadConfig,withLock} from '../subscription-workflow/config.mjs';
import {acquireLock} from '../rss-import/core.mjs';
import {relocatedPath,relocatedMarkdown,replaceChecked} from '../subscription-workflow/report-archive.mjs';
import {sourceAliasResolver} from '../scripts/reading-source-library.mjs';
import {listRuns,runPath} from './store.mjs';
import {taxonomyFolder,taxonomyGroups} from './taxonomy.mjs';
import {moveInReadingHost} from './reader-moves.mjs';
import {knownIndexes} from './indexes.mjs';

const inside=(base,file)=>{const relative=path.relative(base,file);return relative!== '..'&&!relative.startsWith('..'+path.sep)&&!path.isAbsolute(relative);};
const exists=file=>fs.access(file).then(()=>true,()=>false);
async function walk(directory){const files=[];for(const entry of await fs.readdir(directory,{withFileTypes:true}).catch(e=>{if(e.code==='ENOENT')return [];throw e;})){if(entry.isSymbolicLink())continue;const file=path.join(directory,entry.name);if(entry.isDirectory()){if(!['_assets','images','附件','node_modules','.git'].includes(entry.name))files.push(...await walk(file));}else if(entry.isFile())files.push(file);}return files;}
export function remapReceipts(value,mapping,root,hashes){
  if(Array.isArray(value))return value.map(v=>remapReceipts(v,mapping,root,hashes));
  if(!value||typeof value!=='object')return value;
  const result={};for(const [key,item]of Object.entries(value)){result[key]=typeof item==='string'&&/(?:path|paths|file|uri)$/iu.test(key)?relocatedPath(item,mapping,root):remapReceipts(item,mapping,root,hashes);}
  if(result.path&&hashes.has(result.path)&&result.sha256)result.sha256=hashes.get(result.path);
  const markdown=result.artifacts?.find?.(a=>a.kind==='markdown');if(markdown&&result.receipt?.final_markdown_sha256)result.receipt.final_markdown_sha256=markdown.sha256;
  return result;
}

export async function organizeSiteFiles(root,settings,collection,id,{broker}={}){
  const config=await loadConfig(root);if(!config)return organizeUnlocked(root,settings,collection,id,{broker});
  return withLock(path.join(paths(root).home,'worker.lock'),async()=>{const release=await acquireLock(config.rss_home);try{return await organizeUnlocked(root,settings,collection,id,{broker});}finally{await release();}});
}
async function organizeUnlocked(root,settings,collection,id,{broker}={}){
  const directory=runPath(root,id),journal=path.join(directory,'organization.json');let saved=await readJson(journal);
  if(saved?.status==='completed'){collection.results=remapReceipts(collection.results,new Map(saved.mapping),root,new Map(saved.hashes));return saved;}
  if(saved?.status==='running')return executeOrganization(root,collection,journal,saved,broker);
  const base=path.join(root,'阅读区',settings.destination),identity=await sourceAliasResolver(root),current=new Map(collection.results.filter(r=>r.artifacts?.some(a=>a.kind==='markdown')).map(r=>[identity(r.requested_url),r]));
  const moves=[],duplicates=[];
  for(const article of collection.inventory.articles){const row=current.get(identity(article.url));if(!row)continue;const artifact=row.artifacts.find(a=>a.kind==='markdown');
    if(!inside(path.join(root,'阅读区'),artifact.path)||row.receipt?.aggregate)continue;
    const target=path.join(root,'阅读区',taxonomyFolder(settings.destination,article.taxonomy),path.basename(artifact.path));
    if(path.resolve(target)!==path.resolve(artifact.path))moves.push({source:artifact.path,target,sha256:artifact.sha256});
  }
  // Only retire unchanged files created by previous runs of this site source.
  // Existing RSS/user files always win, even when their translated body differs.
  const seen=new Set();for(const previous of await listRuns(root)){if(previous.source_id!==settings.id||previous.id===id)continue;for(const row of previous.results||[]){if(!['imported','imported_with_warnings'].includes(row.status))continue;const artifact=row.artifacts?.find(a=>a.kind==='markdown'),winner=current.get(identity(row.requested_url))?.artifacts?.find(a=>a.kind==='markdown');if(!artifact||!winner||artifact.path===winner.path||!inside(base,artifact.path)||seen.has(artifact.path)||!await exists(artifact.path))continue;
    if(digest(await fs.readFile(artifact.path))!==artifact.sha256)throw new Error('重复副本已有人工修改，已保留：'+artifact.path);
    const state=await readJson(path.join(root,'.local-ir/browser-document-state',path.basename(artifact.path)+'.browser-ir.json'));
    if(state?.annotations?.length||state?.qaCards?.length||state?.articleMusing)throw new Error('重复副本带有阅读加工，已保留：'+artifact.path);
    duplicates.push({source:artifact.path,winner:winner.path,sha256:artifact.sha256});seen.add(artifact.path);
  }}
  const targets=new Set();for(const move of moves){if(!inside(base,move.target)||targets.has(move.target)||(await exists(move.target)&&move.target!==move.source))throw new Error('分类目录目标冲突：'+move.target);targets.add(move.target);}
  const recovery=path.join(directory,'recovery');await fs.mkdir(recovery,{recursive:true});
  const ownedIndexes=[];for(const [file,hashes]of await knownIndexes(root,settings.id))if(await exists(file)&&hashes.has(digest(await fs.readFile(file))))ownedIndexes.push(file);
  const mapping=new Map(moves.map(m=>[m.source,m.target]));for(const d of duplicates)mapping.set(d.source,mapping.get(d.winner)||d.winner);
  // A previous reader batch may have moved files before its client lost the
  // response. Reuse verified actual locations and finish reference repair.
  const actualPaths=new Set([...current.values()].map(row=>row.artifacts.find(a=>a.kind==='markdown').path));
  for(const previous of await listRuns(root)){if(previous.source_id!==settings.id)continue;const old=await readJson(path.join(runPath(root,previous.id),'organization.json'));if(old?.status!=='running')continue;for(const move of old.moves||[])if(actualPaths.has(move.target)&&!await exists(move.source)&&await exists(move.target))mapping.set(move.source,mapping.get(move.target)||move.target);}
  for(const move of moves){const text=await fs.readFile(move.source,'utf8');if(digest(text)!==move.sha256)throw new Error('文章已发生变更，未移动：'+move.source);move.expected=relocatedMarkdown(text,move.source,move.target,mapping,root);await fs.writeFile(path.join(recovery,digest(move.source)+'.md'),text);}
  saved={status:'running',moves:moves.map(({expected,...m})=>m),duplicates,mapping:[...mapping],recovery,ownedIndexes};await writeJson(journal,saved);
  return executeOrganization(root,collection,journal,saved,broker);
}

async function executeOrganization(root,collection,journal,saved,broker){
  const {recovery,duplicates}=saved,mapping=new Map(saved.mapping),moves=[];
  for(const move of saved.moves){const before=await fs.readFile(path.join(recovery,digest(move.source)+'.md'),'utf8');moves.push({...move,expected:relocatedMarkdown(before,move.source,move.target,mapping,root)});}
  const host=await moveInReadingHost(root,moves.filter(m=>!m.done),recovery,duplicates.map(d=>d.source));
  for(const move of moves){if(await exists(move.source)){await fs.mkdir(path.dirname(move.target),{recursive:true});await replaceChecked(move.target,null,move.expected);if(digest(await fs.readFile(move.source))!==move.sha256)throw new Error('移动时文章发生变化');await fs.unlink(move.source);}const actual=await fs.readFile(move.target,'utf8');if(actual!==move.expected)throw new Error('移动后的正文与链接核验未通过：'+move.target);}
  for(const duplicate of duplicates){const target=path.join(recovery,'duplicate-'+digest(duplicate.source)+'.md');if(await exists(duplicate.source)){if(digest(await fs.readFile(duplicate.source))!==duplicate.sha256)throw new Error('重复副本发生变化，未移出');await fs.rename(duplicate.source,target);}else if(!await exists(target)||digest(await fs.readFile(target))!==duplicate.sha256)throw new Error('重复副本恢复记录不完整');const sidecar=path.join(root,'.local-ir/browser-document-state',path.basename(duplicate.source)+'.browser-ir.json');if(await exists(sidecar))await fs.rename(sidecar,path.join(recovery,'duplicate-'+digest(duplicate.source)+'.state.json'));}
  const hashes=new Map();for(const target of new Set(mapping.values()))hashes.set(target,digest(await fs.readFile(target)));
  // Repair article/report links and persisted receipts; source text and model
  // caches are immutable inputs, so only active reading/runtime state is touched.
  for(const zone of ['阅读区','待归档原文','已归档原文','摘要区'])for(const file of await walk(path.join(root,zone))){if(!file.endsWith('.md'))continue;const before=await fs.readFile(file,'utf8'),after=relocatedMarkdown(before,file,file,mapping,root);if(after!==before){await fs.writeFile(path.join(recovery,digest(file)+'.reference.md'),before);await replaceChecked(file,before,after);}}
  const config=await loadConfig(root),metadata=new Set([path.join(root,'imports/rss-reading/review-ledger.v1.json')]);
  for(const file of await walk(path.join(root,'.local-ir/browser-document-state')))if(file.endsWith('.json'))metadata.add(file);
  if(config){metadata.add(path.join(config.rss_home,'state.json'));metadata.add(path.join(paths(root).home,'activity.json'));}
  for(const run of await listRuns(root))if(path.join(runPath(root,run.id),'organization.json')!==journal)metadata.add(path.join(runPath(root,run.id),'run.json'));
  for(const file of metadata){const before=await readJson(file);if(!before)continue;const after=remapReceipts(before,mapping,root,hashes);if(JSON.stringify(before)!==JSON.stringify(after)){await writeJson(path.join(recovery,digest(file)+'.json'),before);await writeJson(file,after);}}
  await broker?.relocateSourceArtifacts?.([...mapping],[...hashes]);
  collection.results=remapReceipts(collection.results,mapping,root,hashes);
  const owned_index_hashes=[];for(const file of saved.ownedIndexes||[])if(await exists(file))owned_index_hashes.push([file,digest(await fs.readFile(file))]);
  saved={...saved,status:'completed',host,hashes:[...hashes],owned_index_hashes,moved:moves.length,duplicates_retired:duplicates.length,groups:taxonomyGroups(collection.inventory.articles).map(g=>({kind:g.kind,name:g.name,folder:g.folder,count:g.articles.length}))};await writeJson(journal,saved);return saved;
}
