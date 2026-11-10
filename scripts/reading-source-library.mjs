import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { urlImportDedupeKey } from './url-import-input.mjs';
import { readingDocumentPathCandidates } from './standard-import-quality.mjs';

export const LIBRARY_ZONES = ['阅读区', '待归档原文', '已归档原文'];
const digest = value => createHash('sha256').update(value).digest('hex');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const optionalJson = file => fs.readFile(file, 'utf8').then(JSON.parse).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
const documentProbeCache=new Map();
async function parallelProbes(files, probe) {
  const rows=new Array(files.length);let next=0;
  await Promise.all(Array.from({length:Math.min(24,files.length)},async()=>{while(next<files.length){const index=next++;rows[index]=await probe(files[index]);}}));
  return rows;
}
async function cachedDocumentProbe(file,json=false) {
  const stat=await fs.stat(file,{bigint:true}).catch(error=>{if(error.code==='ENOENT')return null;throw error;});
  if(!stat)return null;
  const fingerprint=[stat.ino,stat.size,stat.mtimeNs,stat.ctimeNs,json].join(':');
  const cached=documentProbeCache.get(file);
  if(cached?.fingerprint===fingerprint)return cached.value;
  let value;
  if(json)value=await optionalJson(file);
  else {
    const handle=await fs.open(file,'r').catch(error=>{if(error.code==='ENOENT')return null;throw error;});
    if(!handle)return null;
    try{const buffer=Buffer.alloc(16384);const read=await handle.read(buffer,0,buffer.length,0);value=buffer.subarray(0,read.bytesRead).toString('utf8');}
    finally{await handle.close();}
  }
  documentProbeCache.set(file,{fingerprint,value});return value;
}

export function sourceAliasEvidence(metadata = {}, fallback = '') {
  const primary=metadata.source_url || metadata.item_url || fallback;
  // original_url is an alias only when the extractor identified the original
  // article, never merely because a translated article mentions another page.
  const original=metadata.original_source_ref==='item-page-original-markdown' ? metadata.original_url : null;
  const canonical=original || metadata.canonical_url || primary;
  const valid=value=>{try{return /^https?:$/u.test(new URL(value).protocol);}catch{return false;}};
  const aliases=[...new Set([primary,metadata.item_url,canonical,...(metadata.source_url_aliases || [])].filter(valid).map(urlImportDedupeKey))];
  return {canonical:valid(canonical)?urlImportDedupeKey(canonical):null,aliases};
}

const requestMetadataCache=new Map();
export async function sourceAliasResolver(root,ledger) {
  ledger ||= await optionalJson(path.join(root,'imports/rss-reading/review-ledger.v1.json'));
  const relations=[];
  for(const item of Object.values(ledger?.items || {})){
    let metadata=item.source_identity;
    if(!metadata && item.preprocess_request_path){
      const file=item.preprocess_request_path,stat=await fs.stat(file).catch(e=>{if(e.code==='ENOENT')return null;throw e;});
      if(stat){let cached=requestMetadataCache.get(file);if(!cached || cached.mtime!==stat.mtimeMs){cached={mtime:stat.mtimeMs,metadata:(await optionalJson(file))?.source_metadata};requestMetadataCache.set(file,cached);}metadata=cached.metadata;}
    }
    if(metadata)relations.push(sourceAliasEvidence(metadata,item.item_url));
  }
  const aliases=new Map();
  for(const relation of relations)if(relation.canonical)for(const alias of relation.aliases){const previous=aliases.get(alias);if(previous&&previous!==relation.canonical)throw new Error('conflicting_verified_source_alias:'+alias);aliases.set(alias,relation.canonical);}
  return url=>{let key=urlImportDedupeKey(url);const seen=new Set();while(aliases.has(key)&&aliases.get(key)!==key){if(seen.has(key))throw new Error('source_alias_cycle');seen.add(key);key=aliases.get(key);}return key;};
}

export function sourceUrls(markdown) {
  const front = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(markdown)?.[1];
  if (!front || /^(?:status|processing_status):\s*["']?(?:failed|pending|processing)["']?\s*$/mu.test(front)) return [];
  const explicitIdentity = /^source_identity_url:\s*(.+)$/mu.exec(front);
  const aliasLine=/^source_url_aliases:\s*(\[[^\n]*\])$/mu.exec(front);
  let aliases=[];try{if(aliasLine)aliases=JSON.parse(aliasLine[1]);}catch{}
  const matches = explicitIdentity ? [explicitIdentity] : [...front.matchAll(/^(?:source_url|canonical_url):\s*(.+)$/gmu),...aliases.map(value=>[null,JSON.stringify(value)])];
  return matches.flatMap(match => {
    let value = match[1].trim();
    try { if (value.startsWith('"')) value = JSON.parse(value); else value = value.replace(/^'|'$/gu, ''); }
    catch { return []; }
    try { return /^https?:$/u.test(new URL(value).protocol) ? [value] : []; } catch { return []; }
  });
}

export function sourceIdentityUrl(metadata, fallback = '') {
  const source = sourceAliasEvidence(metadata,fallback).canonical || fallback;
  if (!(metadata?.source_parts?.length > 1) || !source) return source;
  const url = new URL(source);
  const parts = metadata.source_parts.map(part => ({ url:urlImportDedupeKey(part.source_url), part:part.part ?? null }));
  url.searchParams.set('pr_source_parts',digest(JSON.stringify(parts)));
  return url.href;
}

export function libraryRootForPath(file) {
  for (let current = path.dirname(path.resolve(file));;) {
    if (LIBRARY_ZONES.includes(path.basename(current))) return path.dirname(current);
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function libraryZone(root, file) {
  const relative = path.relative(root, path.resolve(file));
  if (path.isAbsolute(relative) || relative.startsWith('..'+path.sep)) return null;
  const zone = relative.split(path.sep)[0];
  return LIBRARY_ZONES.includes(zone) ? zone : null;
}

// Read the actual library, rather than trusting an importer's stale output path.
// One batch scan serves every requested identity, including both publication orders.
export async function findSourcePublications(root, urls) {
  const ledger = await optionalJson(path.join(root, 'imports', 'rss-reading', 'review-ledger.v1.json'));
  const identity=await sourceAliasResolver(root,ledger);
  const wanted = new Set(urls.filter(Boolean).map(identity));
  const found = new Map();
  const aliasPriority=new Map();
  const sourceLocations = new Map();
  if (!wanted.size) return found;
  const retain = async (url, file, extra = {}) => {
    const key = identity(url), zone = libraryZone(root, file);
    const rank={'已归档原文':0,'待归档原文':1,'阅读区':2};
    if (!wanted.has(key) || !zone || (found.has(key)&&rank[found.get(key).zone]<rank[zone])) return;
    let data;
    try { data = await fs.readFile(file); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
    if (!data.length) return;
    // A native reader move can precede receipt repair. Prefer the preserved
    // alias-bearing publication over a later canonical-only duplicate even
    // when the ledger still points at an obsolete path or the duplicate.
    const priority=sourceUrls(data.toString('utf8').slice(0,16384)).some(source=>identity(source)===key&&urlImportDedupeKey(source)!==key)?1:0;
    if(found.has(key)&&rank[found.get(key).zone]===rank[zone]&&(aliasPriority.get(key)||0)>=priority)return;
    found.set(key, { path: path.resolve(file), sha256: digest(data), zone,canonical_url:key, ...extra });
    aliasPriority.set(key,priority);
  };
  // Weekly short articles already have a durable identity in the existing ledger.
  for (const item of Object.values(ledger?.items || {})) {
    if (!item.item_url || !wanted.has(identity(item.item_url))) continue;
    if (item.publication?.path) await retain(item.item_url, item.publication.path);
    const shortKey = digest(`${item.material_id}:${item.source_revision}`);
    for (const file of [item.delivery?.short_archived_path, item.delivery?.short_weekly_path].filter(Boolean)) {
      const text = await fs.readFile(file, 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error; });
      if (text.includes(`<!-- rss-reading:short ${shortKey} -->`) || text.includes(`<!-- subscriptions:archived-short ${shortKey} -->`))
        await retain(item.item_url, file, { aggregate: true, source_block_key: shortKey });
    }
  }
  for (const zone of LIBRARY_ZONES) {
    const queue = [path.join(root, zone)];
    while (queue.length) {
      const directory = queue.pop();
      const entries = await fs.readdir(directory, { withFileTypes: true }).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
      for(const entry of entries)if(entry.isDirectory()&&!['_assets','images','附件','node_modules','.git'].includes(entry.name))queue.push(path.join(directory,entry.name));
      const files=entries.filter(entry=>entry.isFile()&&entry.name.toLowerCase().endsWith('.md')).map(entry=>path.join(directory,entry.name));
      const fronts=await parallelProbes(files,async file=>({file,front:await cachedDocumentProbe(file)}));
      for (const {file,front} of fronts) {
        if(!front)continue;
        for (const url of sourceUrls(front)) {
          const key = identity(url);
          if (!sourceLocations.has(key)) sourceLocations.set(key,[]);
          sourceLocations.get(key).push(file);
          await retain(url, file);
        }
      }
    }
  }
  // Older Markdown kept redirect aliases only in its existing document sidecar.
  // Consult those aliases after the ordinary scan, without trusting a stale hash.
  if (found.size < wanted.size) {
    const directory = path.join(root, '.local-ir', 'browser-document-state');
    const entries = await fs.readdir(directory, { withFileTypes:true }).catch(error => { if (error.code==='ENOENT') return []; throw error; });
    const states=await parallelProbes(entries.filter(entry=>entry.isFile()&&entry.name.endsWith('.browser-ir.json')).map(entry=>path.join(directory,entry.name)),file=>cachedDocumentProbe(file,true));
    for (const state of states) {
      const metadata = state?.browser?.sourceMetadata || {};
      const aliases = [state?.document?.sourceUrl,metadata.source_url,metadata.canonical_url].filter(url=>url && wanted.has(urlImportDedupeKey(url)) && !found.has(urlImportDedupeKey(url)));
      if (!aliases.length) continue;
      const candidates = readingDocumentPathCandidates({ workflowRoot:root, readingRoot:path.join(root,'阅读区'), storedDocumentPath:state.document?.path });
      for (const file of candidates) {
        if (!libraryZone(root,file)) continue;
        const text = await fs.readFile(file,'utf8').catch(error => { if(error.code==='ENOENT')return '';throw error; });
        // A sidecar alone cannot turn a missing, failed or unrelated file into a publication.
        const identities = sourceUrls(text).map(urlImportDedupeKey);
        if (!identities.some(key=>[metadata.source_url,metadata.canonical_url,state.document?.sourceUrl].filter(Boolean).map(urlImportDedupeKey).includes(key))) continue;
        for (const alias of aliases) await retain(alias,file);
      }
      // Source identity still locates an archived/moved file after a legacy path expires.
      for (const source of [metadata.source_url,metadata.canonical_url,state.document?.sourceUrl].filter(Boolean))
        for (const file of sourceLocations.get(urlImportDedupeKey(source)) || [])
          for (const alias of aliases) await retain(alias,file);
    }
  }
  return new Map(urls.filter(Boolean).flatMap(url=>{const value=found.get(identity(url));return value?[[urlImportDedupeKey(url),value]]:[];}));
}

export async function findSourcePublication(root, url) {
  return (await findSourcePublications(root, [url])).get(urlImportDedupeKey(url)) || null;
}

// Shared filesystem publication lock also covers RSS/CLI workers in other processes.
async function reclaimExitedOwner(file, observed) {
  const recovery = file+'.reclaim';
  const handle = await fs.open(recovery,'wx').catch(error=>{if(error.code==='EEXIST')return null;throw error;});
  if (!handle) return;
  try {
    const current = await optionalJson(file).catch(error => {
      if (error instanceof SyntaxError) return null;
      throw error;
    });
    if (current?.token !== observed.token || current?.pid !== observed.pid) return;
    try { process.kill(current.pid,0); }
    catch (error) { if(error.code==='ESRCH')await fs.unlink(file).catch(e=>{if(e.code!=='ENOENT')throw e;}); }
  } finally { await handle.close(); await fs.unlink(recovery); }
}

export async function withSourcePublication(root, url, operation) {
  if (!root || !url) return operation();
  const directory = path.join(root, '.local-ir', 'source-publication-locks');
  await fs.mkdir(directory, { recursive: true });
  const identity=await sourceAliasResolver(root);
  const file = path.join(directory, digest(identity(url))+'.json');
  const token = randomUUID();
  const deadline = Date.now()+30*60*1000;
  for (;;) {
    try {
      const handle = await fs.open(file, 'wx');
      await handle.writeFile(JSON.stringify({ pid: process.pid, token }));
      await handle.close();
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const owner = await optionalJson(file).catch(() => null);
      if (Number.isSafeInteger(owner?.pid)) {
        try { process.kill(owner.pid, 0); }
        catch (probe) { if (probe.code === 'ESRCH') { await reclaimExitedOwner(file,owner); continue; } }
      }
      if (Date.now() >= deadline) throw new Error('source_publication_wait_timeout');
      await pause(100);
    }
  }
  try { return await operation(); }
  finally { if ((await optionalJson(file))?.token === token) await fs.unlink(file); }
}

export function sourceReuseResult(url, publication) {
  return { status: 'idempotent_replay', requested_url: url, final_url: url,
    source_metadata: { source_url: url, canonical_url: publication.canonical_url || url },
    artifacts: [{ kind: 'markdown', path: publication.path, sha256: publication.sha256 }],
    receipt: { preprocess_status: 'idempotent_replay', quality_status: 'ready',
      existing_article_preserved: true, global_content_identity: 'normalized_source_url',
      final_markdown_sha256: publication.sha256, source_zone: publication.zone,
      aggregate: publication.aggregate === true, browser_tab_created: false, model_calls: 0 },
    errors: [], warnings: [] };
}
