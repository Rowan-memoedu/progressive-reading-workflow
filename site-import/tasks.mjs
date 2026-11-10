import fs from 'node:fs/promises';
import path from 'node:path';
import { readJson, writeJson, withLock, digest } from '../subscription-workflow/config.mjs';
import { findSourcePublications, sourceReuseResult } from '../scripts/reading-source-library.mjs';
import { urlImportDedupeKey } from '../scripts/url-import-input.mjs';
import { processCollectionTask } from '../scripts/collection-import.mjs';
import { discoverSite } from './discovery.mjs';
import { readSources, readRun, saveRun, listRuns, runPath, runId, siteCounts, now } from './store.mjs';
import {organizeSiteFiles} from './organization.mjs';
import {writeSiteIndexes} from './indexes.mjs';
import {bindRepositoryRelations} from '../scripts/source-relations.mjs';
import {writeRepositoryIndexes} from './repository-indexes.mjs';

const SUCCESS=new Set(['imported','imported_with_warnings','idempotent_replay']);
export async function startSiteRun(root,{source_id,client_request_id,retry_run_id},broker,runRequest) {
  if(typeof client_request_id!=='string'||!/^[A-Za-z0-9_.:-]{1,180}$/u.test(client_request_id))throw new Error('导入请求缺少有效的恢复编号');
  const id=runId(client_request_id),directory=runPath(root,id);
  return withLock(directory+'.lock',async()=>{
    let run=await readRun(root,id);
    if(run&&run.source_id!==source_id)throw new Error('恢复编号已经用于另一个整站来源');
    if(run?.request_id){void runRequest(run.request_id).catch(()=>{});return run;}
    const config=await readSources(root),source=config.sources.find(s=>s.id===source_id);
    if(!source)throw new Error('请先保存整站导入设置');
    const active=(await listRuns(root)).find(run=>run.id!==id&&run.source_id===source_id&&!['completed','completed_with_failures','failed','needs_classification'].includes(run.phase));
    if(active)return active;
    const previous=retry_run_id?await readRun(root,retry_run_id):null;
    if(retry_run_id&&!previous)throw new Error('要重试的整站记录不存在');
    if(previous&&previous.source_id!==source.id)throw new Error('重试任务与来源不一致');
    const settings=run?.settings || previous?.settings || structuredClone(source);
    run ||= {id,source_id:source.id,settings,phase:'queued',created_at:now(),updated_at:now(),client_request_id,
      ...(previous?{retry_of:previous.id}:{}),counts:{discovered:0,imported:0,reused:0,failed:0,warnings:0},results:[]};
    await saveRun(root,run);
    const request=await broker.createRequest([settings.url],{source:'site_import_page',clientRequestId:client_request_id,entryRoute:'ai',destinationFolder:settings.destination,
      userInstruction:settings.instruction,processingMode:settings.processing_mode,processingOptions:{input_form:'written',content_profile:'natural_language',include_reading_guide:settings.generate_guide,translation_mode:settings.translation_mode},
      siteImport:{run_id:id,settings,...(previous?{retry_run_id:previous.id}:{})}});
    run.request_id=request.request_id;await saveRun(root,run);void runRequest(request.request_id).catch(()=>{});return run;
  });
}

export async function capturedArticle(root,articleSource,url) {
  const file=path.join(runPath(root,articleSource.run_id),'sources',digest(url)+'.json');
  const captured=await readJson(file);
  if(!captured||captured.url!==url||!captured.markdown?.trim()||captured.excluded)throw new Error('整站正文缓存缺失或来源不符');
  return captured;
}

export async function verifySiteCollection(root,settings,collection,runId,{broker,onProgress=async()=>{}}={}) {
  const expected=collection.inventory.articles;
  await onProgress('核对已有正文与来源别名');
  // A user may complete/archive or edit an article while discovery is running.
  // Refresh physical locations before planning moves; frozen receipts are not
  // authority to resurrect or overwrite a newer reading state.
  const live=await findSourcePublications(root,expected.map(article=>article.url));
  collection.results=collection.results.map(row=>{const current=live.get(urlImportDedupeKey(row.requested_url)),artifact=row.artifacts?.find(a=>a.kind==='markdown');return current&&(artifact?.path!==current.path||artifact.sha256!==current.sha256)?sourceReuseResult(row.requested_url,current):row;});
  await onProgress('来源核对完成，整理原站目录');
  const organization=expected.every(article=>collection.results.some(row=>row.requested_url===article.url&&SUCCESS.has(row.status)))?await organizeSiteFiles(root,settings,collection,runId,{broker,onProgress}):{};
  await onProgress('回读正式正文与目录链接');
  const rows=new Map(collection.results.map(row=>[row.requested_url,row]));
  const records=[];
  for(const article of expected){
    const row=rows.get(article.url);
    if(!row||!SUCCESS.has(row.status)){records.push({url:article.url,status:'not_imported'});continue;}
    const artifact=row.artifacts?.find(a=>a.kind==='markdown');
    if(!artifact?.path)throw new Error('文章缺少正式 Markdown 回执');
    const bytes=await fs.readFile(artifact.path),hash=digest(bytes);
    if(hash!==artifact.sha256)throw new Error('文章在验收期间发生更改，已保留文件：'+article.url);
    const reused=row.status==='idempotent_replay';
    if(settings.processing_mode==='original_text'&&!reused){
      if(row.receipt?.processing_mode!=='original_text'||row.receipt?.llm_used!==false)throw new Error('原文模式回执未通过');
      const captured=await capturedArticle(root,collection.inventory.article_source,article.url);
      const normalize=value=>String(value).replace(/\r\n/gu,'\n').replace(/\s+/gu,'');
      if(!normalize(bytes.toString('utf8')).includes(normalize(captured.markdown)))throw new Error('原文完整性核验未通过：'+article.url);
    }
    records.push({url:article.url,path:artifact.path,sha256:hash,reused,verified:true});
  }
  let index=null,groups=[];
  if(settings.generate_index&&records.every(row=>row.verified)){const written=await writeSiteIndexes(root,settings,collection.inventory,records,runId,organization);index=written.index;groups=written.groups;}
  const verification={expected:expected.length,verified:records.filter(row=>row.verified).length,records,index,groups,organization:{moved:organization.moved||0,duplicates_retired:organization.duplicates_retired||0,host:organization.host}};
  if(settings.repository&&records.every(row=>row.verified)){
    const captures=await Promise.all(expected.map(article=>capturedArticle(root,collection.inventory.article_source,article.url)));
    verification.source_relations=await bindRepositoryRelations(root,captures,records);
    verification.repository_indexes=await writeRepositoryIndexes(root,settings,captures,records);
  }
  await writeJson(path.join(runPath(root,runId),'verification.json'),verification);return verification;
}

export async function processSiteTask(root,task,{broker,runRequest,planner,fetchPage}={}) {
  const {run_id:id,settings,retry_run_id:retry}=task.site_import;
  const run=await readRun(root,id);if(!run)throw new Error('整站任务记录不存在');
  const previous=retry?await readRun(root,retry):null;
  if(previous?.collection?.inventory?.complete && !task.collection){
    const inventory=structuredClone(previous.collection.inventory);
    const retained=previous.collection.results.filter(row=>SUCCESS.has(row.status));
    task.collection={rule_id:'site-all-articles',phase:'importing',inventory,batches:[],results:retained};
  }
  const initial=task.collection || {rule_id:'site-all-articles',phase:'planning',inventory:null,batches:[],results:[]};
  const update=async collection=>{
    run.collection=structuredClone(collection);run.phase=collection.phase;
    run.counts=siteCounts(collection);run.results=collection.results || [];run.updated_at=now();
    await saveRun(root,run);
  };
  await processCollectionTask(task,{broker,runRequest,initialCollection:initial,onProgress:update,
    discover:async(_url,onProgress)=>{
      const inventory=await discoverSite(root,settings,previous?.id || id,{planner,fetchPage,onProgress:async detail=>{run.stage=detail.stage;run.discovery=detail;run.updated_at=now();await saveRun(root,run);await onProgress(detail);}});
      const existing=await findSourcePublications(root,inventory.articles.map(article=>article.url));
      initial.results=inventory.articles.filter(article=>existing.has(urlImportDedupeKey(article.url))).map(article=>sourceReuseResult(article.url,existing.get(urlImportDedupeKey(article.url))));
      return inventory;
    },
    verify:collection=>verifySiteCollection(root,settings,collection,id,{broker,onProgress:async stage=>{run.stage=stage;run.updated_at=now();await saveRun(root,run);}})});
}
