import fs from 'node:fs/promises';
import path from 'node:path';
import {readJson,digest,loadConfig,paths,withLock} from './config.mjs';
import {setDecision} from '../rss-reading/core.mjs';
import {readingDestination} from './reading-options.mjs';
import {savedReadingBody} from './reading-body.mjs';
import {sourceAliasEvidence} from '../scripts/reading-source-library.mjs';
import {urlImportDedupeKey} from '../scripts/url-import-input.mjs';

const labels={original_url:'原文链接',original_language:'原文语言',translation_language:'译文语言'};
const ledgerPath=root=>path.join(root,'imports/rss-reading/review-ledger.v1.json');
const queueMutations=new Map();
async function withQueueMutation(root,action){
  const key=path.resolve(root),previous=queueMutations.get(key)||Promise.resolve();
  const current=previous.catch(()=>{}).then(()=>withLock(path.join(paths(root).home,'worker.lock'),action));
  queueMutations.set(key,current);
  try{return await current;}finally{if(queueMutations.get(key)===current)queueMutations.delete(key);}
}
const hardError=/source[_-]identity[_-]mismatch|source[_-]mismatch|identity_changed|hash[_-]mismatch|integrity|truncat|unsafe|source_request_changed/iu;
export function readableImportError(error) {
  const text=String(error?.message||error||'');
  if(/source_metadata[\\/]translation|missingProperty.*(?:original_url|original_language|translation_language)/u.test(text))return '来源记录缺少部分可选信息，未能完成自动处理。';
  if(/saved_reading_body_missing/u.test(text))return '预览未能识别已保存的正文，需要重新检查。';
  if(/paid_subscribers|paid_subscription_required|paywall/iu.test(text))return '来源需要付费订阅，当前没有取得完整正文。';
  if(/403|access_restricted|forbidden/iu.test(text))return '来源限制访问，当前没有取得完整正文。';
  if(/identity_changed|source[_-].*mismatch/iu.test(text))return '来源或处理流程已变化，需要重新核对后再导入。';
  if(/needs_classification/iu.test(text))return '尚未确定自动处理方式，可以先保留完整原文。';
  if(/missing.*(?:body|content)|empty.*(?:body|content)|source_not_ready/iu.test(text))return '尚未取得完整正文，需要先重新获取来源。';
  if(/completed_with_warnings/u.test(text))return '自动处理结果仍有提示，需要重新检查。';
  return '处理未完成，请重试。详细原因已保留在异常记录中。';
}

export async function diagnoseImportIssue(root,item,config) {
  const raw=item.publication_failure?.error||item.review_preview?.error||item.review_preview?.reason||item.source_errors?.[0]?.message||item.content_status||'';
  const request=item.preprocess_request_path?await readJson(item.preprocess_request_path):null;
  const markdown=typeof request?.material?.markdown==='string'?request.material.markdown:'';
  const missing=request?.source_metadata?.translation?Object.keys(labels).filter(key=>!Object.hasOwn(request.source_metadata.translation,key)):[];
  let reason=null;
  if(!item.eligible_for_preprocess||item.content_status!=='fulltext_ready'||!savedReadingBody(markdown).body)reason='尚未取得完整正文，不能忽略该问题直接导入。';
  else if(hardError.test(String(raw)))reason='来源或内容完整性需要重新核对，不能忽略该问题直接导入。';
  else if(!sourceAliasEvidence(request.source_metadata,item.item_url).aliases.includes(urlImportDedupeKey(item.item_url)))reason='保存的正文与文章来源不一致，需要重新获取来源。';
  if(!reason&&item.publication?.path){const body=await fs.readFile(item.publication.path,'utf8').catch(e=>{if(e.code==='ENOENT')return null;throw e;});if(body!==null&&!savedReadingBody(body).body)reason='已保存的文件缺少正文，需要先恢复内容。';}
  const sources=(config?.subscriptions||[]).filter(s=>(item.subscription_ids||[]).includes(s.id));
  const warnings=missing.length?[{code:'source_metadata_incomplete',message:'来源记录缺少：'+missing.map(k=>labels[k]).join('、')+'。',fields:missing}]:[{code:'processing_incomplete',message:readableImportError(raw)}];
  return {id:item.material_id,title:item.title,url:item.item_url,severity:reason?'blocking':'warning',status:reason?'blocked':'warning',can_import:!reason,can_delete:!item.publication?.path,
    message:reason||warnings.map(w=>w.message).join(' ')+' 完整原文已保存，可以先按原文入库；缺失的来源信息会保持原样。',
    warnings,source_active:sources.some(s=>s.enabled),source_paused:sources.length>0&&!sources.some(s=>s.enabled),
    request,markdown};
}

export async function subscriptionImportIssues(root,items,{broker}={}) {
  const config=await loadConfig(root),requests=broker?await broker.listRequestSummaries({sources:['subscription_warning'],limit:100}):[],result=[];
  for(const item of items){if(item.import_queue_dismissed)continue;let diagnosis;try{diagnosis=await diagnoseImportIssue(root,item,config);}catch{diagnosis={id:item.material_id,title:item.title,url:item.item_url,severity:'blocking',status:'blocked',can_import:false,can_delete:!item.publication?.path,message:'已保存的来源记录无法读取，需要重新获取来源。'};}const {request,markdown,...issue}=diagnosis;
    const accepted=requests.find(r=>r.subscription_material_id===item.material_id);
    if(accepted){issue.import_request_id=accepted.request_id;issue.import_pending=!accepted.terminal;
      const row=accepted.results?.[0],artifact=row?.artifacts?.find(a=>a.kind==='markdown');
      if(accepted.terminal&&['imported','imported_with_warnings','idempotent_replay'].includes(row?.status)&&artifact&&await fs.access(artifact.path).then(()=>true,()=>false)){
        issue.status='imported_with_warnings';issue.can_import=false;issue.can_delete=false;issue.message='已入库，来源信息的提示仍保留。';issue.publication=artifact;
      }else if(!accepted.terminal){issue.status='processing';issue.can_import=false;issue.can_delete=false;issue.message='正在导入原文，来源信息的提示会保留。';}
    }
    issue.error=issue.message;result.push(issue);
  }
  return result;
}

export async function importWithWarnings(root,input,{broker,runRequest}={}) {
  return withQueueMutation(root,()=>importWarningUnlocked(root,input,{broker,runRequest}));
}

async function importWarningUnlocked(root,input,{broker,runRequest}={}) {
  if(!broker||!runRequest)throw new Error('导入后台尚未就绪，请稍后重试。');
  if(typeof input.client_request_id!=='string'||!/^[A-Za-z0-9_.:-]{1,180}$/u.test(input.client_request_id))throw new Error('缺少有效的导入请求编号。');
  const ledger=await readJson(ledgerPath(root)),item=ledger?.items?.[input.id];if(!item||item.canonical_material_id)throw new Error('该条目不存在，请刷新页面。');
  if(item.import_queue_dismissed)throw new Error('该条目已删除，不再导入。');
  const config=await loadConfig(root);if(!config?.enabled)throw new Error('后台队列已暂停，请先恢复队列。');
  let issue;try{issue=await diagnoseImportIssue(root,item,config);}catch{throw new Error('已保存的来源记录无法读取，需要重新获取来源。');}if(!issue.can_import)throw new Error(issue.message);
  const source=config.subscriptions.find(s=>(item.subscription_ids||[]).includes(s.id));
  const destination=readingDestination({...item,destination:source?.destination||item.destination,subscription_kind:source?.kind||item.subscription_kind,subscription_name:source?.name||item.subscription_name});
  const sourceMetadata={...issue.request.source_metadata,source_url:item.item_url,title:item.title,subscription_material_id:item.material_id,
    accepted_import_warnings:issue.warnings,warning_acceptance:{at:new Date().toISOString(),body_sha256:digest(issue.markdown)}};
  const accepted=await broker.createRequest([item.item_url],{source:'subscription_warning',clientRequestId:input.client_request_id,
    subscriptionMaterialId:item.material_id,processingMode:'original_text',destinationFolder:destination,
    browserSnapshot:{draft:{url:item.item_url,title:item.title,sourceType:'url_import',pageText:issue.markdown,cachedRssMarkdown:issue.markdown,destinationFolder:destination,sourceMetadata}}});
  void runRequest(accepted.request_id).catch(()=>{});
  return {request_id:accepted.request_id,status:accepted.terminal?'completed':'queued',warnings:issue.warnings};
}

export async function deleteQueuedImport(root,input,{broker}={}) {
  return withQueueMutation(root,async()=>{
    const ledger=await readJson(ledgerPath(root)),item=ledger?.items?.[input.id];
    if(!item||item.canonical_material_id)throw new Error('该条目不存在，请刷新页面。');
    if(item.import_queue_dismissed)return {status:'deleted',id:item.material_id};
    const requests=broker?await broker.listRequestSummaries({sources:['subscription_warning'],limit:100}):[];
    if(item.publication?.path||requests.some(r=>r.subscription_material_id===item.material_id&&(!r.terminal||r.results?.some(row=>['imported','imported_with_warnings','idempotent_replay'].includes(row.status)))))throw new Error('该条目已开始导入或已经入库，不能从待导入队列删除。');
    await setDecision(root,item.material_id,'dismissed',{source:'subscription_queue',dismissImport:true,syncCatalog:false});
    return {status:'deleted',id:item.material_id};
  });
}
