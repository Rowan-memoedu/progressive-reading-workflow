import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { dataPath } from '../scripts/runtime-paths.mjs';
import { readJson, writeJson, withLock, canonicalUrl, digest } from '../subscription-workflow/config.mjs';
import { normalizeRelativeDestinationFolder } from '../scripts/import-destination-routing.mjs';
import { repositoryConfig } from './repository-config.mjs';

export const CODE_ROOT = path.resolve(import.meta.dirname,'..');
export const now = () => new Date().toISOString();
export function sitePaths(root=CODE_ROOT) {
  const home = process.env.PROGRESSIVE_READING_SITE_IMPORTS_HOME || (path.resolve(root)===CODE_ROOT ? dataPath('ProgressiveReading','SiteImports') : path.join(root,'.local-ir','site-imports'));
  return {home,config:path.join(home,'sources.json'),runs:path.join(home,'runs')};
}
export async function readSources(root) {
  return await readJson(sitePaths(root).config) || {schema:'progressive-reading.site-imports/v1',revision:0,sources:[]};
}
export function normalizeSiteSource(value,previous={}) {
  const rawUrl=value.url ?? previous.url;
  const url=process.env.NODE_ENV==='test'?new URL(rawUrl).href:canonicalUrl(rawUrl);
  const name=String(value.name ?? previous.name ?? '').trim().replace(/\s+/gu,' ') || new URL(url).hostname;
  if(!name || name.length>160)throw new Error('名称需要在 1–160 个字符之间');
  const mode=value.processing_mode ?? previous.processing_mode ?? 'standard_preprocess';
  if(!['standard_preprocess','original_text'].includes(mode))throw new Error('导入方式无效');
  const scope=value.scope ?? previous.scope ?? 'blog';
  if(!['blog','documents','content'].includes(scope))throw new Error('收录范围无效');
  const translation=value.translation_mode ?? previous.translation_mode ?? 'terminology';
  if(!['terminology','plain'].includes(translation))throw new Error('翻译方式无效');
  const patterns=key=>{
    const input=value[key] ?? previous[key] ?? [];
    const lines=(Array.isArray(input)?input:String(input).split(/\r?\n/u)).map(x=>String(x).trim()).filter(Boolean);
    if(lines.length>40 || lines.some(x=>x.length>300||!x.startsWith('/')))throw new Error('路径规则应以 / 开头，每行一项，最多 40 项');
    return lines;
  };
  const destination=normalizeRelativeDestinationFolder(value.destination ?? previous.destination ?? '整站/'+name.replace(/[<>:"/\\|?*]/gu,'－'),{required:true});
  const instruction=String(value.instruction ?? previous.instruction ?? '').trim();
  if(instruction.length>6000)throw new Error('范围说明或加工要求过长');
  for(const key of ['generate_guide','generate_index'])if(value[key]!==undefined&&typeof value[key]!=='boolean')throw new Error('导读或目录选项无效');
  return {...previous,id:previous.id || 'site-'+randomUUID(),name,url,scope,destination,processing_mode:mode,
    translation_mode:translation,generate_guide:value.generate_guide ?? previous.generate_guide ?? false,
    include_paths:patterns('include_paths'),exclude_paths:patterns('exclude_paths'),instruction,
    generate_index:value.generate_index ?? previous.generate_index ?? true,
    ...((value.repository || previous.repository)?{repository:repositoryConfig(value.repository || previous.repository,url)}:{}),
    created_at:previous.created_at || now(),updated_at:now()};
}
export async function saveSiteSource(root,value,revision) {
  const p=sitePaths(root);
  return withLock(p.config+'.lock',async()=>{
    const config=await readSources(root);
    if(config.revision!==revision)throw new Error('设置已在另一处更新，请刷新后重试');
    const previous=value.id ? config.sources.find(s=>s.id===value.id) : null;
    if(value.id&&!previous)throw new Error('整站来源不存在');
    const source=normalizeSiteSource(value,previous || {});
    if(previous)config.sources[config.sources.indexOf(previous)]=source;else config.sources.push(source);
    config.revision++;await writeJson(p.config,config);return {source,revision:config.revision};
  });
}
export function runPath(root,id) {
  if(!/^site-run-[a-f0-9]{24}$/u.test(id))throw new Error('整站任务编号无效');
  return path.join(sitePaths(root).runs,id);
}
export const runId = key => 'site-run-'+digest(key).slice(0,24);
export async function saveRun(root,run) {await writeJson(path.join(runPath(root,run.id),'run.json'),run);return run;}
export async function readRun(root,id) {return readJson(path.join(runPath(root,id),'run.json'));}
export async function listRuns(root) {
  const p=sitePaths(root),names=await fs.readdir(p.runs).catch(e=>{if(e.code==='ENOENT')return [];throw e;});
  const runs=await Promise.all(names.filter(name=>/^site-run-[a-f0-9]{24}$/u.test(name)).map(id=>readRun(root,id)));
  return runs.filter(Boolean).sort((a,b)=>b.created_at.localeCompare(a.created_at));
}
export function siteCounts(collection) {
  const rows=collection?.results || [];
  return {discovered:collection?.inventory?.articles?.length || collection?.discovery?.discovered || 0,
    imported:rows.filter(r=>['imported','imported_with_warnings','saved_locked'].includes(r.status)).length,
    reused:rows.filter(r=>r.status==='idempotent_replay').length,
    warnings:rows.filter(r=>r.receipt?.quality_status==='warning').length,
    failed:rows.filter(r=>['failed','requires_browser_auth','requires_js_render'].includes(r.status)).length+(collection?.inventory?.failures?.length || (!collection?.inventory ? collection?.discovery?.failed || 0 : 0)),
    waiting:rows.filter(r=>r.status==='needs_classification').length};
}
