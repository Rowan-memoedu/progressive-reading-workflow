import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { repositoryConfig } from './repository-config.mjs';
import { readJson, writeJson, digest } from '../subscription-workflow/config.mjs';
import { findSourcePublications } from '../scripts/reading-source-library.mjs';
import { urlImportDedupeKey } from '../scripts/url-import-input.mjs';

const execute = promisify(execFile);
export async function githubJson(url, fetchImpl = globalThis.fetch) {
  if (!url.startsWith('https://api.github.com/repos/')) throw new Error('repository_api_scope');
  const response = await fetchImpl(url, {headers:{'User-Agent':'ProgressiveReading','Accept':'application/vnd.github+json'},signal:AbortSignal.timeout(45000)});
  if (!response.ok) throw new Error('github_http_'+response.status);
  return response.json();
}
export async function repositoryHead(repository, fetchImpl) {
  const r=repositoryConfig(repository);
  const commit=await githubJson(`https://api.github.com/repos/${r.owner}/${r.repo}/commits/${encodeURIComponent(r.branch)}`,fetchImpl);
  if (!/^[a-f0-9]{40}$/u.test(commit.sha) || !/^[a-f0-9]{40}$/u.test(commit.commit?.tree?.sha)) throw new Error('repository_commit_invalid');
  return {sha:commit.sha,tree_sha:commit.commit.tree.sha};
}
export async function snapshotRepository(repository, directory, {fetchImpl=globalThis.fetch}={}) {
  const r=repositoryConfig(repository), head=await repositoryHead(r,fetchImpl);
  const home=path.join(directory,'repository',head.sha), receipt=await readJson(path.join(home,'receipt.json'));
  if (receipt) return {...receipt,home,repository:r};
  await fs.mkdir(home,{recursive:true});
  const tree=await githubJson(`https://api.github.com/repos/${r.owner}/${r.repo}/git/trees/${head.tree_sha}?recursive=1`,fetchImpl);
  if (tree.truncated) throw new Error('repository_tree_truncated');
  if (!Array.isArray(tree.tree) || !tree.tree.length) throw new Error('repository_tree_missing');
  await writeJson(path.join(home,'tree.json'),tree);
  const response=await fetchImpl(`https://codeload.github.com/${r.owner}/${r.repo}/zip/${head.sha}`,{signal:AbortSignal.timeout(120000)});
  if (!response.ok) throw new Error('repository_archive_http_'+response.status);
  const chunks=[];let bytes=0;
  for await(const chunk of response.body){bytes+=chunk.length;if(bytes>128*1024*1024)throw new Error('repository_archive_too_large');chunks.push(chunk);}
  await fs.writeFile(path.join(home,'snapshot.zip'),Buffer.concat(chunks));
  const extracted=await execute(process.env.PROGRESSIVE_READING_PYTHON || 'python',[path.join(import.meta.dirname,'repository-snapshot.py'),path.join(home,'snapshot.zip'),path.join(home,'tree.json'),path.join(home,'files'),r.content_root],{timeout:120000,maxBuffer:1024*1024,windowsHide:true});
  const verified=JSON.parse(extracted.stdout);
  const result={...head,...verified,archive_bytes:bytes,verified_at:new Date().toISOString()};
  await writeJson(path.join(home,'receipt.json'),result);
  return {...result,home,repository:r};
}
export function originalLinkEvidence(markdown, sourceTitle='') {
  const candidates=[];
  const front=/^---\r?\n([\s\S]*?)\r?\n---/u.exec(markdown)?.[1];
  for(const match of front?.matchAll(/^original_url:\s*["']?(https?:\/\/[^\s"']+)/gmu)||[]) candidates.push({url:match[1],field:'original_url',line:match[0]});
  for(const line of markdown.split(/\r?\n/u)){
    if(!/^\s*(?:[-*>]\s*)?(?:\*\*)?(?:原文(?:链接|地址|出处)?|Original(?:\s+(?:article|source|text|link))?|Source)(?:\*\*)?\s*[:：]/iu.test(line))continue;
    const urls=[...line.matchAll(/\]\((https?:\/\/[^\s)]+)(?:\s+[^)]*)?\)|<((?:https?):\/\/[^>]+)>/gu)].map(m=>m[1]||m[2]);
    if(!urls.length){const bare=/https?:\/\/[^\s<>]+/u.exec(line);if(bare)urls.push(bare[0]);}
    for(const url of urls)candidates.push({url,field:'original-link-label',line});
  }
  // Some repositories express provenance as the linked title immediately after
  // H1. Require exact title agreement; arbitrary introductory links are citations.
  if(!candidates.length){
    const normalized=value=>value.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu,'');
    const title=/^#\s+(.+)$/mu.exec(markdown)?.[1] || '';
    const names=[sourceTitle,title].filter(Boolean).map(normalized);
    for(const line of markdown.split(/\r?\n/u).filter(l=>l.trim()).slice(0,4)){
      const link=/^\s*\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)\s*$/u.exec(line);
      if(link&&names.includes(normalized(link[1])))candidates.push({url:link[2],field:'standalone-matching-title-link',line});
    }
  }
  const unique=new Map();
  for(const item of candidates){try{const url=new URL(item.url);if(!['http:','https:'].includes(url.protocol)||url.username||url.password)continue;unique.set(urlImportDedupeKey(url.href),{...item,url:url.href});}catch{}}
  // A mislabeled author profile must not compete with an explicit article URL.
  // Keep its evidence for review rather than treating the profile as an article.
  const discarded=[];
  if(unique.size>1)for(const [key,item]of unique){if(/^\/@[^/]+\/?$/u.test(new URL(item.url).pathname)){discarded.push({...item,reason:'author-profile-path'});unique.delete(key);}}
  if(unique.size!==1)return {status:unique.size?'ambiguous':'missing',candidates:[...unique.values()],discarded};
  return {status:'verified',...unique.values().next().value,...(discarded.length?{discarded}:{})};
}
export function repositoryPageUrl(repository, relative) {
  return new URL(relative.split('/').map(encodeURIComponent).join('/').replace(/\.md$/iu,'.html'),repository.public_base).href;
}
export function repositoryMarkdown(markdown, repository, sourcePath, sha) {
  const prefix=repository.content_root ? repository.content_root+'/' : '';
  const relative=sourcePath.slice(prefix.length);
  return markdown.replace(/(!?\[[^\]\n]*\]\()(<[^>\n]+>|[^\s)]+)([^\n)]*\))/gu,(all,open,target,tail)=>{
    const raw=target.replace(/^<|>$/gu,'');
    if(/^(?:[a-z][\w+.-]*:|#|\/\/|\()/iu.test(raw)||raw.includes(':'))return all;
    let local;try{local=new URL(raw,'https://repository.invalid/'+relative);}catch{return all;}
    const link=decodeURIComponent(local.pathname.slice(1));
    const url=/\.md$/iu.test(link)&&!open.startsWith('!')?repositoryPageUrl(repository,link):`https://raw.githubusercontent.com/${repository.owner}/${repository.repo}/${sha}/${prefix}${link.split('/').map(encodeURIComponent).join('/')}`;
    return open+'<'+url+local.search+local.hash+'>'+tail;
  });
}
export async function discoverRepository(root,settings,directory,{onProgress=async()=>{},snapshotFn=snapshotRepository}={}) {
  await onProgress({phase:'planning',stage:'核对仓库固定提交与完整文件目录'});
  const snapshot=await snapshotFn(settings.repository,directory),r=snapshot.repository;
  const tree=await readJson(path.join(snapshot.home,'tree.json')),prefix=r.content_root ? r.content_root+'/' : '';
  const files=tree.tree.filter(row=>row.type==='blob'&&row.path.startsWith(prefix)&&/\.md$/iu.test(row.path));
  const captured=[],excluded=[];
  for(const row of files){
    const relative=row.path.slice(prefix.length);
    if(relative==='SUMMARY.md'){excluded.push({path:row.path,reason:'仓库导航目录；不重复作为文章导入'});continue;}
    const raw=await fs.readFile(path.join(snapshot.home,'files',row.path),'utf8');
    if(!raw.trim()){excluded.push({path:row.path,reason:'源文件为空，无正文可导入'});continue;}
    const evidence=originalLinkEvidence(raw,path.posix.basename(relative,'.md'));
    const title=/^#\s+(.+)$/mu.exec(raw)?.[1]?.trim() || path.posix.basename(relative,'.md');
    const markdown=repositoryMarkdown(raw,r,row.path,snapshot.sha),url=repositoryPageUrl(r,relative);
    captured.push({url,title,markdown,source_response:{url:`${r.url}/blob/${snapshot.sha}/${row.path.split('/').map(encodeURIComponent).join('/')}`,sha256:digest(raw),bytes:Buffer.byteLength(raw),content_type:'text/markdown'},
      metadata:{repository:{url:r.url,commit:snapshot.sha,path:row.path,relative_path:relative,blob_sha:row.sha},
        original_link_evidence:evidence,...(evidence.status==='verified'?{original_url:evidence.url,fact_source_url:urlImportDedupeKey(evidence.url),original_source_ref:'repository-original-link-field'}:{}),
        taxonomy:{version:'source-taxonomy/v1',repository_directory:path.posix.dirname(relative)==='.'?[]:path.posix.dirname(relative).split('/'),groups:[],primary:{kind:'仓库',name:path.posix.dirname(relative),path:[]}}}});
  }
  // One scan binds known originals without fetching any missing originals.
  const originals=await findSourcePublications(root,captured.map(c=>c.metadata.original_url).filter(Boolean));
  await fs.mkdir(path.join(directory,'sources'),{recursive:true});
  for(const item of captured){const original=originals.get(urlImportDedupeKey(item.metadata.original_url || item.url));if(original)item.metadata.original_document_path=original.path;await writeJson(path.join(directory,'sources',digest(item.url)+'.json'),item);}
  const inventory={taxonomy_version:'source-taxonomy/v1',complete:true,articles:captured.map(item=>({url:item.url,title:item.title,taxonomy:item.metadata.taxonomy,source_sha256:item.source_response.sha256,markdown_sha256:digest(item.markdown)})),
    excluded,excluded_count:excluded.length,failures:[],candidate_count:files.length,declared_total:files.length,sitemaps:[],planner:{provider:'verified_repository_tree',model:'none',completed:true},repository_snapshot:snapshot,
    mapping_counts:{verified:captured.filter(c=>c.metadata.original_link_evidence.status==='verified').length,ambiguous:captured.filter(c=>c.metadata.original_link_evidence.status==='ambiguous').length,missing:captured.filter(c=>c.metadata.original_link_evidence.status==='missing').length,local_originals:originals.size}};
  await onProgress({phase:'discovering',stage:'仓库正文、来源字段与本地原文核对完成',discovered:captured.length,total:files.length,checked:files.length});
  return inventory;
}
