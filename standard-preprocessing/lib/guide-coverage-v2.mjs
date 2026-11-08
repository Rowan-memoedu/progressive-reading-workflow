import {createHash,randomUUID} from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {chunkGuideBlocks,defaultGuideCoverageCache,GUIDE_COVERAGE_VERSION} from './guide-coverage.mjs';
import {GUIDE_FIDELITY_POLICY as POLICY,GUIDE_REVIEW_FIDELITY_POLICY as REVIEW_POLICY,GUIDE_FIDELITY_VERSION} from './guide-fidelity.mjs';
import {guideReviewSchema} from './guide-contracts.mjs';
export {guideSelectionSchema} from './guide-contracts.mjs';
const hash=x=>createHash('sha256').update(typeof x==='string'?x:JSON.stringify(x)).digest('hex');
const norm=x=>String(x).normalize('NFKC').replace(/\s+/gu,'');
const unique=items=>[...new Map(items.map(i=>[norm(i.title+'|'+i.description),i])).values()];
const roles=['author','reported','rebutted','hypothesis','question'];
const terminal=message=>{throw Object.assign(Error(message),{terminal:true});};
const validJudgments=j=>['very_low','low','medium','high','very_high'].includes(j?.value?.level)&&['very_low','low','medium','high','very_high'].includes(j?.density?.level)&&Number.isInteger(j?.continue_reading?.level)&&j.continue_reading.level>=0&&j.continue_reading.level<=4&&[j.value.reason,j.density.reason,j.continue_reading.reason].every(s=>typeof s==='string'&&s.trim());
export function sourceSpans(markdown){
 const result=[];let start=0;for(let i=0;i<markdown.length;i++)if(/[。！？\n]/u.test(markdown[i])){const text=markdown.slice(start,i+1);if(text.trim())result.push({id:result.length+1,text});start=i+1;}const text=markdown.slice(start);if(text.trim())result.push({id:result.length+1,text});return result;
}
function exactMembers(items,expected,key,label){
 const actual=Array.isArray(items)?items.map(i=>i?.[key]):[];
 if(!Array.isArray(items)||items.length!==expected.length)throw Error(label+'_count: expected='+JSON.stringify(expected)+'; actual='+JSON.stringify(actual)+'; missing='+JSON.stringify(expected.filter(id=>!actual.includes(id))));
 const seen=new Set();for(const item of items){const id=item?.[key];if(!expected.includes(id)||seen.has(id))throw Error(label+'_identity: invalid or duplicate '+key+'='+JSON.stringify(id)+'; expected='+JSON.stringify(expected));seen.add(id);}
}
function evidence(e,sources){
 const b=sources.find(b=>b.source_block_key===e?.source_block_key),ids=e?.source_span_ids;
 if(!b)throw Error('guide_evidence_invalid: unknown source_block_key='+e?.source_block_key+'; copy an exact existing key from '+JSON.stringify(sources.map(b=>b.source_block_key)));
 if(!Array.isArray(ids)||!ids.length||new Set(ids).size!==ids.length||ids.some(n=>!Number.isInteger(n)||n<1||n>b.source_spans.length))throw Error('guide_evidence_invalid: '+b.source_block_key+' requires distinct integer source_span_ids in 1..'+b.source_spans.length+'; actual='+JSON.stringify(ids));
 return {source_block_key:b.source_block_key,source_span_ids:[...ids].sort((a,b)=>a-b),source_quote:[...ids].sort((a,b)=>a-b).map(n=>b.source_spans[n-1].text).join('')};
}
export function freezeCatalog(output,units){
 exactMembers(output?.reviews,units.map(b=>b.source_block_key),'source_block_key','catalog_blocks');const points=[],excluded=[];
 for(const b of output.reviews){
  if(!Array.isArray(b.points)||typeof b.substantive!=='boolean')throw Error('catalog_structure');
  if(!b.substantive){
   if(!b.reason?.trim())throw Error('catalog_exclusion');
   for(const p of b.points){
    if(!p.claim?.trim()||!['context_only','reference_only'].includes(p.kind))throw Error('catalog_exclusion');
    excluded.push({...evidence({source_block_key:b.source_block_key,source_span_ids:p.source_span_ids},units),claim:p.claim,kind:p.kind,reason:b.reason});
   }
   if(!b.points.length)excluded.push({source_block_key:b.source_block_key,reason:b.reason});continue;
  }
  if(!b.points.length)throw Error('catalog_empty_points');
  for(const p of b.points){
   if(!p.claim?.trim())throw Error('catalog_point_claim_required:'+b.source_block_key);
   // A reported/rebutted/hypothetical/question proposition is still a claim
   // for coverage purposes. Preserve the more specific provider label too.
   const kind=roles.includes(p.kind)?'claim':p.kind;
   if(!['claim','context_only','reference_only'].includes(kind))throw Error('catalog_point_kind_required:'+b.source_block_key+': each point requires kind=claim|context_only|reference_only');
   if(!roles.includes(p.role))throw Error('catalog_point_role_required:'+b.source_block_key+': each point requires role=author|reported|rebutted|hypothesis|question');
   const point={...evidence({source_block_key:b.source_block_key,source_span_ids:p.source_span_ids},units),claim:p.claim,kind,role:p.role,...(kind!==p.kind?{source_kind:p.kind}:{})};
   if(kind!=='claim')excluded.push(point);else points.push({...point,point_id:'point-'+hash(point).slice(0,20)});
  }
 }
 if(new Set(points.map(p=>p.point_id)).size!==points.length)throw Error('catalog_duplicate_point');return {points,excluded};
}
export function validateCoverage(output,catalog,insights){
 exactMembers(output?.coverage,catalog.points.map(p=>p.point_id),'point_id','coverage_points');const missing=[];
 for(const r of output.coverage){
  if(Object.keys(r).some(k=>!['point_id','insight_indices','missing_detail'].includes(k)))throw Error('coverage_immutable_field');
  if(!Array.isArray(r.insight_indices)||r.insight_indices.some(n=>!Number.isInteger(n)||n<1||n>insights.length))throw Error('coverage_insight_index');
  if(!r.insight_indices.length){if(!r.missing_detail?.trim()||/^(?:未覆盖|未提及|缺失|missing|not covered)[。.!！]?$/iu.test(r.missing_detail.trim()))throw Error('coverage_missing_detail_required');missing.push({...catalog.points.find(p=>p.point_id===r.point_id),missing_detail:r.missing_detail});}
 }
 return {missing};
}
export function validateFidelity(output,items,sources){
 exactMembers(output?.verdicts,items.map(i=>i.index),'index','fidelity_items');const problems=[];
 const mismatches=[];
 for(const v of output.verdicts){
  const item=items.find(i=>i.index===v.index);
  if(v.insight_title!==item.title||v.target_block_key!==item.target_block_key)mismatches.push({index:v.index,expected_title:item.title,actual_title:v.insight_title??null,expected_target:item.target_block_key,actual_target:v.target_block_key??null});
  else if(v.status==='supported'&&Array.isArray(v.evidence)&&v.evidence.length&&!v.evidence.some(e=>e.source_block_key===item.target_block_key))mismatches.push({index:v.index,title:item.title,target:item.target_block_key,evidence:v.evidence,reason:'supported verdict has no evidence for its own target; recheck the binding or explicitly return unsupported with wrong_target'});
 }
 if(mismatches.length)throw Error('fidelity_audit_binding_invalid:'+JSON.stringify(mismatches));
 for(const v of output.verdicts){
  if(!['supported','unsupported'].includes(v.status)||!Array.isArray(v.evidence)||!Array.isArray(v.problems))throw Error('fidelity_structure');
  for(const e of v.evidence)evidence(e,sources);
  if(v.status==='supported'){
   if(!v.evidence.length||v.problems.length)throw Error('fidelity_supported_evidence_required');
  }else{if(!v.problems.length||v.problems.some(p=>!p.kind?.trim()||!p.explanation?.trim()))throw Error('fidelity_problem_required');problems.push(v);}
 }
 return {problems};
}
const CATALOG_SYSTEM='你只从原文建立信息点清单，不生成导读。'+POLICY+'\n逐块枚举论点、论据、例子所说明的机制、数字、条件、反驳和回应。结合 full_source_context 标明身份 role。署名、订阅推广、纯链接、无实质命题的过渡可排除并说明原因；引语、反方观点、解释性脚注不能因非作者立场排除。证据用 source_span_ids，不复制原句。只输出 schema JSON。';
const COVERAGE_SYSTEM='你只核对程序冻结的信息点是否被洞察完整表达，不改写清单或洞察。'+REVIEW_POLICY+'\n每个 point_id 只返回 insight_indices 和 missing_detail。匹配范围是整篇 insights；同一命题在不同来源块重复出现，可由同一条忠实洞察覆盖，不要求洞察的跳转 key 等于每个重复信息点的 source_block_key。同主题不等于覆盖，条件、数量、力度、身份一致的忠实转述才算覆盖；漏项说明具体缺失内容。不返回 claim、role、source_span_ids，不增删信息点。';
const FIDELITY_SYSTEM='你是独立的原文观点保真核对员。'+REVIEW_POLICY+'\nsources 已提供完整原文。逐条核查标题和描述的所有实质命题，检查额外判断、条件与数量改变、立场或力度偏移。不得用外部知识纠正原文。图注、图表文字、引语和脚注也是原文证据，不能因为正文没有重复就认定不存在；同时不能把图注或被引用者的说法无条件升级成作者在正文中的断言，或据此扩写因果。忠实表述这些来源身份即可，不要求补写免责声明或比较正文与图注的注释。每条返回 supported/unsupported 与原文依据；unsupported 指出具体差异。可在其他块找到依据就不是捏造，但跳转 key 须真正支撑该洞察。证据用 source_block_key 和 source_span_ids；只输出 schema JSON。';

export async function generateFaithfulGuide(payload,{generate,review,identity,cacheDir=defaultGuideCoverageCache(),onProgress=()=>{}}){
 const inputHash=hash({version:GUIDE_COVERAGE_VERSION,fidelity:GUIDE_FIDELITY_VERSION,policy:POLICY,identity,payload});
 const chunks=chunkGuideBlocks(payload.blocks),all=payload.blocks.filter(b=>b.role!=='original').map(b=>({...b,source_spans:sourceSpans(b.markdown)}));
 const context=all.map(({source_block_key,markdown})=>({source_block_key,markdown}));const usage=[];let reused=0,repairs=0,disputedFindings=0,dismissedFindings=0;
 async function stage(kind,input,produce,validate=x=>x){
  const file=cacheDir&&path.join(cacheDir,inputHash,kind+'-'+hash(input)+'.json');
  if(file){try{const saved=JSON.parse(await fs.readFile(file,'utf8'));validate(saved);reused++;return saved;}catch(e){if(e.code!=='ENOENT')throw e;}}
  onProgress({stage:kind});const value=await produce();if(value.usage)usage.push(value.usage);let invalid;try{validate(value);}catch(e){invalid=e;}
  if(file){await fs.mkdir(path.dirname(file),{recursive:true});const target=invalid?file+'.rejected-'+randomUUID():file,tmp=target+'.tmp-'+randomUUID();await fs.writeFile(tmp,JSON.stringify(value));await fs.rename(tmp,target);}
  if(invalid){invalid.rejected_output=value.output;throw invalid;}return value;
 }
 async function reviewed(kind,system,input,validate){
  let feedback='';for(let attempt=0;attempt<2;attempt++){
   const request={system,user:JSON.stringify({...input,validation_feedback:feedback})};
   // A valid semantic-stage cache remains reusable. Output schemas constrain
   // fresh transport responses and have their own raw-response cache identity.
   try{return await stage(kind,request,()=>review({...request,outputSchema:guideReviewSchema(input)}),r=>validate(r.output));}catch(e){if(e.terminal)throw e;if(attempt===1)terminal('guide_'+kind+'_rejected:'+e.message);feedback='只修复以下明确的 JSON 合同错误，保留已有合法条目并补齐所有要求的编号；原文与信息点不变。上一轮实际输出和错误：'+JSON.stringify({error:e.message,previous_output:e.rejected_output??null});}
  }
 }
 const keys=new Set(all.map(b=>b.source_block_key));
 const checkInsights=(o,allowed=keys)=>{if(!Array.isArray(o?.insights)||o.insights.some(i=>!allowed.has(i.target_block_key)||!i.title?.trim()||!i.description?.trim()))throw Error('invalid_guide_insights');};
 function chunkPayload(units,catalog,extra={}){return {...payload,cleaning_policy:{...payload.cleaning_policy,mode:'semantic_only',include_reading_guide:true},translation_detection:{bilingual:false},guide_context:context,guide_points:catalog.points,...extra,source_metadata:{...payload.source_metadata,section_context:[...new Set(units.map(u=>u.heading))].filter(Boolean)},blocks:units.map(({source_block_key,type,role,language,markdown})=>({source_block_key,type,role,language,markdown}))};}
 async function produced(kind,input){try{return await stage(kind,input,()=>generate(input),r=>{if(!validJudgments(r.output?.judgments))throw Error('invalid_guide_judgments');checkInsights(r.output,new Set(input.blocks.map(b=>b.source_block_key)));});}catch(e){e.terminal=true;throw e;}}
 const catalogs=[];
 for(const units of chunks){
  const sources=units.map(u=>all.find(b=>b.source_block_key===u.source_block_key));
  const input={task:'source_catalog',sources,full_source_context:context,schema:{reviews:[{source_block_key:'当前 sources 的 key',substantive:true,reason:'排除原因',points:[{source_span_ids:[1],claim:'完整命题',kind:'claim|context_only|reference_only',role:'author|reported|rebutted|hypothesis|question'}]}]}};
  const r=await reviewed('catalog',CATALOG_SYSTEM,input,o=>freezeCatalog(o,sources));catalogs.push(freezeCatalog(r.output,sources));
 }
 let insights=[],judgments=null;for(let n=0;n<chunks.length;n++){
  if(!catalogs[n].points.length)continue;const r=await produced('generation',chunkPayload(chunks[n],catalogs[n]));judgments??=r.output.judgments;insights.push(...r.output.insights);
 }
 if(!judgments){const r=await produced('global_generation',chunkPayload(all,{points:[]}));judgments=r.output.judgments;insights=r.output.insights;}
 insights=unique(insights);const catalogHash=hash(catalogs);
 async function coverage(current){
  const missing=[];for(const catalog of catalogs){if(!catalog.points.length)continue;
   // Short, request-local aliases avoid asking a language model to transcribe
   // long hashes. The immutable canonical ids remain owned by this catalog.
   const auditCatalog={points:catalog.points.map((p,n)=>({...p,point_id:'p'+(n+1)}))};
   const input={task:'coverage',frozen_points:auditCatalog.points,point_id_scope:'p1、p2 等为程序分配的本次核验编号，只能逐字引用，不能增删或改写其命题',full_source_context:context,insights:current.map((i,n)=>({...i,index:n+1})),schema:{coverage:[{point_id:'输入中的 p1 等编号',insight_indices:[1],missing_detail:''}]}};
   const r=await reviewed('coverage',COVERAGE_SYSTEM,input,o=>validateCoverage(o,auditCatalog,current));
   for(const point of validateCoverage(r.output,auditCatalog,current).missing)missing.push({...catalog.points[Number(point.point_id.slice(1))-1],missing_detail:point.missing_detail});
  }return missing;
 }
 async function fidelity(current){
  const problems=[];for(let n=0;n<current.length;n+=12){
   const items=current.slice(n,n+12).map((i,k)=>({...i,index:n+k+1}));
   const input={task:'fidelity',sources:all.map(({source_block_key,source_spans})=>({source_block_key,source_spans})),insights:items,schema:{verdicts:[{index:1,insight_title:'逐字回写当前 index 的 title，不能合并或串到相邻条目',target_block_key:'逐字回写该洞察的 target_block_key',status:'supported|unsupported',evidence:[{source_block_key:'实际 key',source_span_ids:[1]}],problems:[{kind:'added_claim|changed_scope|changed_strength|wrong_attribution|missing_condition|wrong_target',explanation:'具体差异'}]}]},target_rule:'supported 的 evidence 必须包含当前洞察的跳转块；若观点存在但跳转块错误，明确返回 unsupported 和 wrong_target，不能一边称 supported 一边只引用其他块。每个编号独立核查，不合并相邻条目。'};
   const r=await reviewed('fidelity',FIDELITY_SYSTEM,input,o=>validateFidelity(o,items,all));problems.push(...validateFidelity(r.output,items,all).problems);
  }return problems;
 }
 async function resolveDisagreement(current,problems){
  const confirmed=[];
  for(let start=0;start<problems.length;start+=12){
   const disputed=problems.slice(start,start+12),items=disputed.map(p=>({...current[p.index-1],index:p.index}));
   const input={task:'fidelity',audit_purpose:'resolve_persistent_disagreement',sources:all.map(({source_block_key,source_spans})=>({source_block_key,source_spans})),insights:items,disputed_verdicts:disputed,
    schema:{verdicts:[{index:1,insight_title:'原 title',target_block_key:'原 target_block_key',status:'supported|unsupported',evidence:[{source_block_key:'实际 key',source_span_ids:[1]}],problems:[{kind:'added_claim|changed_scope|changed_strength|wrong_attribution|missing_condition|wrong_target',explanation:'实际的原文差异'}]}]}};
   const system=FIDELITY_SYSTEM+'\n本次是对持续审计异议的独立证据复核，不再改写候选，也不默认之前的审计结论正确。逐项判断 disputed_verdicts 指出的差异是否真实存在。标题可以概括而不重复描述的每个细节；一条洞察可以忠实承载多个相关命题，由同一块的多句及全文语境共同支撑，这本身不是 wrong_target。核对实际 target_block_key，不能要求改到它已经使用的同一个 key。仅当原文确实不支持观点、身份、范围、力度或实际跳转时才保留 unsupported；没有实际差异则返回 supported，并给出直接原文证据。不得用编辑偏好代替保真问题，不因修复困难或已反复审计就放行。';
   const r=await reviewed('fidelity_disagreement',system,input,o=>validateFidelity(o,items,all));
   const actual=validateFidelity(r.output,items,all).problems;confirmed.push(...actual);
   disputedFindings+=items.length;dismissedFindings+=items.length-actual.length;
  }return confirmed;
 }
 async function repair(current,problems){
  const relatedKeys=new Set(problems.flatMap(p=>[current[p.index-1].target_block_key,...(p.evidence||[]).map(e=>e.source_block_key)]));
  const input={task:'fidelity_repair',sources:context,frozen_points:catalogs.flatMap(c=>c.points).filter(p=>relatedKeys.has(p.source_block_key)),insights:problems.map(p=>({...current[p.index-1],index:p.index,problems:p.problems,evidence:p.evidence})),schema:{replacements:[{index:1,insight:{title:'忠实标题',description:'忠实表达原文',target_block_key:'实际 key'}}]}};
  const r=await reviewed('fidelity_repair',REVIEW_POLICY+'\n只修复指定洞察，保持有效信息，不删除整条。依据完整原文和 frozen_points 核对问题说明，不把审计意见当作新观点，也不能靠删除冻结信息点通过保真。图注、图表、引语和脚注有自己的来源身份；若问题是将它们升级成正文断言，应以最小必要归属保留原意，不添加正文没有说明、尚需验证之类的注释或免责声明。frozen_points 是约束已有信息的证据，不要求把相关块所有信息塞入这条洞察。只返回 replacements。',input,o=>{exactMembers(o?.replacements,problems.map(p=>p.index),'index','repair_items');for(const x of o.replacements)checkInsights({insights:[x.insight]});});
  const next=structuredClone(current);for(const x of r.output.replacements)next[x.index-1]=x.insight;repairs+=problems.length;return next;
 }
 async function fill(current,missing){
  let next=[...current];for(let n=0;n<chunks.length;n++){
   const group=missing.filter(p=>catalogs[n].points.some(c=>c.point_id===p.point_id));if(!group.length)continue;
   const p=chunkPayload(chunks[n],catalogs[n],{guide_repair:{missing_points:group,existing_insights:current}});p.user_instruction=(p.user_instruction||'')+'\n本次是局部补缺。只补 guide_repair.missing_points 中确实遗漏的信息，结合完整语境保留论证身份。不要重复已有完整洞察，不依据漏项说明添加原文没有的内容。';
   const r=await produced('coverage_repair',p);next.push(...r.output.insights);repairs+=group.length;
  }return unique(next);
 }
 async function select(current){
  if(current.length<2)return current;
  const groups=new Map();current.forEach((i,n)=>{const key=i.target_block_key+'|'+norm(i.description);groups.set(key,[...(groups.get(key)||[]),n+1]);});
  const duplicates=[...groups.values()].filter(g=>g.length>1);
  const input={task:'selection',scope:'whole_article',valid_target_keys:[...keys],full_source_context:context,insights:current.map((i,n)=>({...i,index:n+1})),duplicate_description_groups:duplicates,schema:{keep_indices:[1],remove:[{index:2,covered_by:[1],reason:'完整承载的重复内容'}],distinct_titles:[{index:1,unique_claim:'若同描述组仍保留多条，指出此标题独有且未被其他保留项承载的具体原文命题；否则为空数组'}]}};
  const r=await reviewed('selection','只选择现成洞察，不改写。'+REVIEW_POLICY+'\n本次核对范围是整篇文章的全部 insights，所有 valid_target_keys 都是有效跳转，不存在当前分段限制；不能因洞察来自另一段就删除。只删全部实质信息已由保留条目完整承载的重复项，相同主题不等于重复，不按数量删减。同一命题仅更换标题或句式仍属重复。duplicate_description_groups 是程序发现的相同描述与跳转组；通常保留一条，只有标题确实包含独有的原文命题时才能保留多条，并逐条在 distinct_titles 说明独有命题，措辞或强调差异不算新命题。每个序号恰好出现在 keep_indices 或 remove；covered_by 只能引用保留项。',input,o=>{
   if(!Array.isArray(o?.keep_indices)||!Array.isArray(o.remove))throw Error('selection_structure');exactMembers([...o.keep_indices.map(index=>({index})),...o.remove],current.map((_,n)=>n+1),'index','selection_items');
   const invalid=o.remove.filter(x=>!x.reason?.trim()||!Array.isArray(x.covered_by)||!x.covered_by.length||x.covered_by.some(n=>!o.keep_indices.includes(n)));
   if(invalid.length)throw Error('selection_unsubstantiated: invalid remove entries='+JSON.stringify(invalid)+'; each needs a nonempty reason and covered_by containing only retained keep_indices='+JSON.stringify(o.keep_indices)+'; do not reference another removed item or itself');
   const unresolved=duplicates.map(g=>g.filter(n=>o.keep_indices.includes(n))).filter(g=>g.length>1).flat();
   if(unresolved.length){exactMembers(o.distinct_titles,unresolved,'index','selection_duplicate_titles');if(o.distinct_titles.some(x=>!x.unique_claim?.trim()))throw Error('selection_duplicate_title_claim_required');}
  });return current.filter((_,n)=>r.output.keep_indices.includes(n+1));
 }
 const before=insights.length;insights=await select(insights);
 for(let round=0;round<3;round++){
  // Bound repairs per insight, not per document. A newly discovered problem
  // must get its own correction opportunity even after other cards were fixed.
  const repairAttempts=new Map();
  for(let fidelityRound=0;fidelityRound<=2*insights.length;fidelityRound++){
   let problems=await fidelity(insights);if(!problems.length)break;
   const exhausted=problems.filter(p=>(repairAttempts.get(p.index)||0)>=2);
   if(exhausted.length){
    const confirmed=await resolveDisagreement(insights,exhausted);
    if(confirmed.length)terminal('guide_fidelity_incomplete:'+JSON.stringify(confirmed));
    const resolved=new Set(exhausted.map(p=>p.index));problems=problems.filter(p=>!resolved.has(p.index));if(!problems.length)break;
   }
   for(const p of problems)repairAttempts.set(p.index,(repairAttempts.get(p.index)||0)+1);
   insights=await repair(insights,problems);
  }
  // Repair and omission fills can create new duplicates. Selection only removes
  // cards already audited above; the following coverage check guards omissions.
  insights=await select(insights);
  const missing=await coverage(insights);if(missing.length){if(round===2)terminal('guide_coverage_incomplete:'+JSON.stringify(missing));insights=await fill(insights,missing);continue;}
  if(hash(catalogs)!==catalogHash)terminal('guide_catalog_mutated');
  const order=new Map(payload.blocks.map((b,n)=>[b.source_block_key,n]));insights.sort((a,b)=>order.get(a.target_block_key)-order.get(b.target_block_key));
  return {output:{judgments,insights,translation:{is_bilingual:false,alignments:[]}},usage:{coverage_calls:usage.length,coverage_usage:usage,stages:{guide_coverage:{version:GUIDE_COVERAGE_VERSION,status:'passed',source_chunks:chunks.length,source_points:catalogs.reduce((n,c)=>n+c.points.length,0),missing_points:0,before_selection:before,final_insights:insights.length,reused_stages:reused,catalog_sha256:catalogHash},guide_fidelity:{version:GUIDE_FIDELITY_VERSION,status:'passed',checked_insights:insights.length,unsupported_insights:0,repairs,disputed_findings:disputedFindings,dismissed_after_evidence_review:dismissedFindings,full_source_context:true,immutable_catalog:true}}}};
 }
 terminal('guide_validation_incomplete');
}
