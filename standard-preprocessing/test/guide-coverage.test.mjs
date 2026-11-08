import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {generateCoverageGuide,chunkGuideBlocks,GUIDE_COVERAGE_VERSION} from '../lib/guide-coverage.mjs';
import {freezeCatalog,validateCoverage,validateFidelity,sourceSpans,guideSelectionSchema} from '../lib/guide-coverage-v2.mjs';
import Ajv from 'ajv';
import {ExternalProducer} from '../lib/producer.mjs';
import {buildPreprocessRequest,runPreprocessingRequest} from '../index.mjs';
import {classifyStandardImportQuality} from '../../scripts/standard-import-quality.mjs';
import {parseGuideJsonObject} from '../lib/guide-json.mjs';

const judgments={value:{level:'high',reason:'观点明确。'},density:{level:'high',reason:'包含实质信息。'},continue_reading:{level:3,reason:'需了解论证。'}};
const blocks=Array.from({length:35},(_,n)=>({source_block_key:'src-'+String(n+1).padStart(4,'0')+'-12345678',type:'paragraph',role:'body',language:'zh',markdown:'条件编号 '+(n+1)+'：只有满足对应温度条件时才发生转变。'}));
const payload={material_id:'fixture',source_type:'fixture',source_metadata:{language:'zh'},cleaning_policy:{mode:'semantic_only',include_reading_guide:true},insight_policy:{soft_target:{min:3,max:12},safety_cap:24},blocks};
const card=b=>({title:b.source_block_key,description:b.markdown,target_block_key:b.source_block_key});
function fixture({omit=false,wrong=false,persistent=false,drop=false}={}){
 const state={generated:0,reviewed:0,tasks:[],contexts:[]};
 return {state,generate:async p=>{
  state.generated++;state.contexts.push(p.guide_context);
  let items=p.blocks.map(card);
  if(p.guide_repair)items=p.guide_repair.missing_points.map(q=>({title:q.claim,description:q.source_quote,target_block_key:q.source_block_key}));
  else if(omit)items=[];
  if(wrong&&!p.guide_repair&&items.length)items[0].description='所有情况下都成立。';
  return {output:{judgments,insights:items,translation:{is_bilingual:false,alignments:[]}}};
 },review:async ({user})=>{
  state.reviewed++;const d=JSON.parse(user);state.tasks.push(d);
  if(d.task==='source_catalog')return {output:{reviews:d.sources.map(b=>({source_block_key:b.source_block_key,substantive:true,reason:'实质命题',points:[{source_span_ids:b.source_spans.map(s=>s.id),claim:b.markdown,kind:'claim',role:'author'}]}))}};
  if(d.task==='coverage')return {output:{coverage:d.frozen_points.map(p=>({point_id:p.point_id,insight_indices:d.insights.filter(i=>i.description===p.source_quote).map(i=>i.index),missing_detail:'须保留完整条件和命题。'}))}};
  if(d.task==='fidelity')return {output:{verdicts:d.insights.map(i=>{
   const b=d.sources.find(b=>b.source_block_key===i.target_block_key),bad=persistent||i.description==='所有情况下都成立。';
   return {index:i.index,insight_title:i.title,target_block_key:i.target_block_key,status:bad?'unsupported':'supported',evidence:[{source_block_key:b.source_block_key,source_span_ids:b.source_spans.map(s=>s.id)}],problems:bad?[{kind:'changed_scope',explanation:'把原文的温度条件删除了。'}]:[]};
  })}};
  if(d.task==='fidelity_repair')return {output:{replacements:d.insights.map(i=>({index:i.index,insight:card({...d.sources.find(b=>b.source_block_key===i.target_block_key)})}))}};
  if(d.task==='selection')return {output:drop&&state.tasks.filter(t=>t.task==='selection').length===1?{keep_indices:d.insights.slice(0,-1).map(i=>i.index),remove:[{index:d.insights.at(-1).index,covered_by:[1],reason:'fixture 故意误删'}]}:{keep_indices:d.insights.map(i=>i.index),remove:[]}};
  throw Error('unexpected:'+d.task);
 }};
}
test('full source context, immutable catalog, complete guides over 24 cards and unchanged input',async()=>{
 const f=fixture(),before=structuredClone(payload);const r=await generateCoverageGuide(payload,{...f,identity:'complete',cacheDir:false});
 assert.equal(r.output.insights.length,35);assert.deepEqual(payload,before);assert.ok(f.state.contexts.every(c=>c.length===35));
 for(const t of f.state.tasks.filter(t=>['coverage','selection','source_catalog'].includes(t.task)))assert.equal(t.full_source_context.length,35);
 for(const t of f.state.tasks.filter(t=>t.task==='fidelity'))assert.equal(t.sources.length,35);
 assert.equal(r.usage.stages.guide_coverage.missing_points,0);assert.equal(r.usage.stages.guide_fidelity.unsupported_insights,0);
});
test('frozen facts are owned by code and cannot be rewritten, duplicated or omitted by audits',()=>{
 const source={...blocks[0],source_spans:sourceSpans(blocks[0].markdown)};
 const c=freezeCatalog({reviews:[{source_block_key:source.source_block_key,substantive:true,points:[{source_span_ids:[1],claim:'条件',kind:'claim',role:'author'}]}]},[source]);
 const row={point_id:c.points[0].point_id,insight_indices:[1],missing_detail:''},before=structuredClone(c);
 assert.equal(validateCoverage({coverage:[row]},c,[card(source)]).missing.length,0);assert.deepEqual(c,before);
 assert.throws(()=>validateCoverage({coverage:[{...row,claim:'改写'}]},c,[card(source)]),/immutable/);
 assert.throws(()=>validateCoverage({coverage:[]},c,[card(source)]),/count/);
 assert.throws(()=>validateCoverage({coverage:[{...row,point_id:'bad'}]},c,[card(source)]),/identity/);
 assert.throws(()=>validateCoverage({coverage:[{...row,insight_indices:[],missing_detail:'未覆盖'}]},c,[card(source)]),/detail/);
});
test('whole-article audits never inherit the generation chunk restriction',async()=>{
 const f=fixture({wrong:true}),p={...payload,blocks:blocks.slice(0,9)};let selections=0;
 const review=async request=>{const d=JSON.parse(request.user);
 if(d.task!=='source_catalog')assert.doesNotMatch(request.system,/只为当前 blocks/);
 if(d.task==='coverage')assert.match(request.system,/同一条忠实洞察覆盖/);
 if(d.task==='selection'){
  selections++;assert.equal(d.scope,'whole_article');assert.deepEqual(d.valid_target_keys,p.blocks.map(b=>b.source_block_key));
  assert.doesNotMatch(request.system,/只为当前 blocks/);assert.match(request.system,/不能因洞察来自另一段就删除/);
  assert.deepEqual(request.outputSchema,guideSelectionSchema(d.insights.length));
 }return f.review(request);};
 const r=await generateCoverageGuide(p,{...f,review,identity:'selection-scope',cacheDir:false});
 assert.ok(f.state.generated>1);assert.ok(selections>0);assert.equal(r.output.insights.length,9);
});
test('selection output schema rejects fabricated indices before semantic validation',()=>{
 const valid=new Ajv({strict:true}).compile(guideSelectionSchema(2));
 const output={keep_indices:[1],remove:[{index:2,covered_by:[1],reason:'完整重复'}],distinct_titles:[]};
 assert.equal(valid(output),true);
 assert.equal(valid({...output,keep_indices:[1,3]}),false);
 assert.equal(valid({...output,remove:[{index:2,covered_by:[3],reason:'错误引用'}]}),false);
 assert.equal(valid({...output,extra:'invented'}),false);
});
test('unsupported scope is a hard gate and repairs only affected guide text',async()=>{
 const f=fixture({wrong:true}),p={...payload,blocks:blocks.slice(0,2)},before=structuredClone(p);
 const r=await generateCoverageGuide(p,{...f,identity:'scope',cacheDir:false});
 assert.deepEqual(r.output.insights.map(i=>i.description),p.blocks.map(b=>b.markdown));assert.deepEqual(p,before);
 assert.equal(r.usage.stages.guide_fidelity.repairs,1);
 const repair=f.state.tasks.find(t=>t.task==='fidelity_repair');assert.equal(repair.insights.length,1);
 assert.equal(repair.frozen_points.length,1);assert.equal(repair.frozen_points[0].source_quote,p.blocks[0].markdown);
 assert.equal(repair.frozen_points[0].role,'author');assert.ok(repair.frozen_points[0].point_id.startsWith('point-'));
});
test('non-substantive captions may retain verified reference evidence but never exclude a claim',()=>{
 const b={...blocks[0],markdown:'图片：示意图',source_spans:sourceSpans('图片：示意图')};
 const row={source_block_key:b.source_block_key,substantive:false,reason:'配图标题',points:[{source_span_ids:[1],claim:'示意图',kind:'reference_only',role:'author'}]};
 const c=freezeCatalog({reviews:[row]},[b]);assert.equal(c.points.length,0);assert.equal(c.excluded[0].source_quote,b.markdown);
 assert.throws(()=>freezeCatalog({reviews:[{...row,points:[{...row.points[0],kind:'claim'}]}]},[b]),/catalog_exclusion/);
});

test('specific proposition labels remain substantive while missing role fields are rejected',()=>{
 const b={...blocks[0],source_spans:sourceSpans(blocks[0].markdown)};
 for(const kind of ['reported','rebutted','hypothesis','question']){
  const p={source_span_ids:[1],claim:'原文中的具体观点',kind,role:'author'};
  const record={reviews:[{source_block_key:b.source_block_key,substantive:true,points:[p]}]};
  const c=freezeCatalog(record,[b]);assert.equal(c.points.length,1);assert.equal(c.points[0].kind,'claim');assert.equal(c.points[0].source_kind,kind);assert.equal(c.points[0].role,'author');
  delete p.role;assert.throws(()=>freezeCatalog(record,[b]),/role_required/);
 }
});

test('guide JSON recovery removes only surplus closers after a complete object',()=>{
 const obj={verdicts:[{index:1,evidence:[],problems:[],text:'quoted } ] " brace'}]};
 const raw=JSON.stringify(obj)+']}';const parsed=parseGuideJsonObject(raw);
 assert.deepEqual(parsed.output,obj);assert.equal(parsed.recovery.values_changed,false);
 assert.throws(()=>parseGuideJsonObject(JSON.stringify(obj)+' {"extra":1}'));
 assert.throws(()=>parseGuideJsonObject(JSON.stringify(obj)+',"extra":1}'));
 assert.throws(()=>parseGuideJsonObject(JSON.stringify(obj)+' explanation'));
 assert.throws(()=>parseGuideJsonObject(JSON.stringify(obj).slice(0,-3)));
 assert.equal(parseGuideJsonObject(JSON.stringify(obj)).recovery,null);
});

test('audit correction receives the rejected output and the exact missing identities',async()=>{
 const f=fixture();let correction=null,first=true;
 const review=async request=>{const d=JSON.parse(request.user),r=await f.review(request);if(d.task==='fidelity'){
  if(first){first=false;r.output.verdicts.pop();}else correction=d.validation_feedback;
 }return r;};
 const r=await generateCoverageGuide({...payload,blocks:blocks.slice(0,2)},{...f,review,identity:'diagnostic',cacheDir:false});
 assert.equal(r.usage.stages.guide_fidelity.status,'passed');assert.match(correction,/previous_output/);assert.match(correction,/missing=\[2\]/);assert.equal(f.state.generated,1);
});

test('new omission supplements get a fidelity repair even after an earlier card was repaired',async()=>{
 const f=fixture({wrong:true});
 const generate=async p=>{const r=await f.generate(p);if(!p.guide_repair)r.output.insights.pop();else r.output.insights[0].description='所有情况下都成立。';return r;};
 const r=await generateCoverageGuide({...payload,blocks:blocks.slice(0,2)},{...f,generate,identity:'separate-audits',cacheDir:false});
 assert.deepEqual(r.output.insights.map(i=>i.description),blocks.slice(0,2).map(b=>b.markdown));
 assert.equal(f.state.generated,2);assert.equal(f.state.tasks.filter(t=>t.task==='fidelity_repair').length,2);
});
test('persisting source disagreement stops publication without replaying generation',async()=>{
 const f=fixture({persistent:true});await assert.rejects(generateCoverageGuide({...payload,blocks:blocks.slice(0,1)},{...f,identity:'persistent',cacheDir:false}),e=>e.terminal&&/fidelity_incomplete/.test(e.message));assert.equal(f.state.generated,1);
 assert.equal(f.state.tasks.filter(t=>t.task==='fidelity_repair').length,2);
 assert.equal(f.state.tasks.filter(t=>t.audit_purpose==='resolve_persistent_disagreement').length,1);
});
test('a persistent false audit is resolved from source evidence without a third rewrite',async()=>{
 const f=fixture(),p={...payload,blocks:blocks.slice(0,1)};
 const review=async request=>{const d=JSON.parse(request.user),r=await f.review(request);
  if(d.task==='fidelity'&&!d.audit_purpose){Object.assign(r.output.verdicts[0],{status:'unsupported',problems:[{kind:'wrong_target',explanation:'标题与描述引用同一段中的不同句子。'}]});}
  if(d.audit_purpose){assert.equal(d.disputed_verdicts.length,1);assert.equal(d.sources.length,1);assert.match(request.system,/已经使用的同一个 key/);}
  return r;
 };
 const r=await generateCoverageGuide(p,{...f,review,identity:'audit-disagreement',cacheDir:false});
 assert.deepEqual(r.output.insights,[card(p.blocks[0])]);assert.equal(f.state.generated,1);
 assert.equal(f.state.tasks.filter(t=>t.task==='fidelity_repair').length,2);
 assert.equal(r.usage.stages.guide_fidelity.dismissed_after_evidence_review,1);
});

test('a later newly discovered problem receives its own bounded repair opportunity',async()=>{
 const f=fixture();let audit=0;
 const review=async request=>{const d=JSON.parse(request.user),r=await f.review(request);if(d.task==='fidelity'&&audit<3){
  const v=r.output.verdicts[audit++];v.status='unsupported';v.problems=[{kind:'changed_scope',explanation:'本轮首次定位到这一条需要保留的条件。'}];
 }return r;};
 const r=await generateCoverageGuide({...payload,blocks:blocks.slice(0,3)},{...f,review,identity:'late-finding',cacheDir:false});
 assert.equal(r.usage.stages.guide_fidelity.status,'passed');assert.equal(f.state.generated,1);
 assert.deepEqual(f.state.tasks.filter(t=>t.task==='fidelity_repair').map(t=>t.insights.map(i=>i.index)),[[1],[2],[3]]);
});
test('deletion of a unique claim is repaired against the same frozen source ids',async()=>{
 const f=fixture({drop:true}),p={...payload,blocks:blocks.slice(0,2)};
 const r=await generateCoverageGuide(p,{...f,identity:'dedup',cacheDir:false});assert.equal(r.output.insights.length,2);
 const coverage=f.state.tasks.filter(t=>t.task==='coverage');assert.deepEqual(coverage[0].frozen_points,coverage.at(-1).frozen_points);
});
test('coverage repairs carry the full paragraphs and whole-article argumentative context',async()=>{
 const f=fixture({omit:true}),p={...payload,blocks:[{...blocks[0],markdown:'常见但错误的推断是：“必须有本能。”'},{...blocks[1],markdown:'实际上，相同行为可以由不同机制实现。'}]};
 const r=await generateCoverageGuide(p,{...f,identity:'context',cacheDir:false});assert.equal(r.output.insights.length,2);assert.ok(f.state.contexts.every(c=>c.length===2));assert.equal(r.usage.stages.guide_coverage.missing_points,0);
});

test('a fidelity repair creating duplicate descriptions is deduplicated before final coverage',async()=>{
 const p={...payload,blocks:blocks.slice(0,2).map(b=>({...b,markdown:blocks[0].markdown}))},f=fixture({wrong:true});
 const review=async request=>{const d=JSON.parse(request.user);if(d.task==='selection'&&d.insights.length===2&&d.insights[0].description===d.insights[1].description)return {output:{keep_indices:[1],remove:[{index:2,covered_by:[1],reason:'标题与正文的唯一信息完全相同。'}]}};return f.review(request);};
 const r=await generateCoverageGuide(p,{...f,review,identity:'repair-dedup',cacheDir:false});
 assert.equal(r.output.insights.length,1);assert.equal(r.usage.stages.guide_coverage.source_points,2);
 assert.equal(r.usage.stages.guide_coverage.missing_points,0);assert.equal(f.state.generated,1);
});

test('selection cannot silently keep duplicate descriptions under different headings',async()=>{
 const f=fixture();let seen=false;
 const generate=async p=>({output:{judgments,insights:[card(p.blocks[0]),{...card(p.blocks[0]),title:'同一命题的另一标题'}]}});
 const review=async request=>{const d=JSON.parse(request.user);if(d.task==='selection'&&d.validation_feedback){seen=true;assert.deepEqual(d.duplicate_description_groups,[[1,2]]);return {output:{keep_indices:[1],remove:[{index:2,covered_by:[1],reason:'标题只换说法，没有独有命题。'}]}};}return f.review(request);};
 const r=await generateCoverageGuide({...payload,blocks:blocks.slice(0,1)},{...f,generate,review,identity:'duplicate-headings',cacheDir:false});
 assert.equal(r.output.insights.length,1);assert.equal(seen,true);
});

test('invalid deletion references receive precise correction without changing candidate text',async()=>{
 const f=fixture();let first=true,feedback='';
 const review=async request=>{const d=JSON.parse(request.user);if(d.task==='selection'){
  if(first){first=false;return {output:{keep_indices:[1,3],remove:[{index:2,covered_by:[2],reason:'重复'}]}};}if(d.validation_feedback)feedback=d.validation_feedback;
 }return f.review(request);};
 const p={...payload,blocks:blocks.slice(0,3)},r=await generateCoverageGuide(p,{...f,review,identity:'delete-references',cacheDir:false});
 assert.equal(r.output.insights.length,3);assert.match(feedback,/keep_indices=\[1,3\]/);assert.match(feedback,/removed item or itself/);
 const audits=f.state.tasks.filter(t=>t.task==='coverage');assert.equal(audits[0].frozen_points[0].point_id,'p1');
});
test('fidelity requires actual source evidence and a relevant jump target',()=>{
 const sources=blocks.slice(0,2).map(b=>({...b,source_spans:sourceSpans(b.markdown)})),items=[{...card(sources[0]),index:1}];
 const verdict={index:1,insight_title:items[0].title,target_block_key:items[0].target_block_key,status:'supported',evidence:[{source_block_key:sources[1].source_block_key,source_span_ids:[1]}],problems:[]};
 assert.throws(()=>validateFidelity({verdicts:[verdict]},items,sources),/audit_binding_invalid/);
 assert.equal(validateFidelity({verdicts:[{...verdict,status:'unsupported',problems:[{kind:'wrong_target',explanation:'观点来自另一块，当前跳转不支持它。'}]}]},items,sources).problems[0].problems[0].kind,'wrong_target');
 assert.throws(()=>validateFidelity({verdicts:[{...verdict,evidence:[]}]},items,sources),/evidence_required/);
 assert.throws(()=>validateFidelity({verdicts:[{...verdict,evidence:[{source_block_key:sources[0].source_block_key,source_span_ids:[999]}]}]},items,sources),/evidence_invalid/);
});

test('misbound audit evidence is corrected without rewriting already faithful cards',async()=>{
 const f=fixture();let first=true,feedback='';
 const review=async request=>{const d=JSON.parse(request.user),r=await f.review(request);if(d.task==='fidelity'){
  if(first){first=false;[r.output.verdicts[0].evidence,r.output.verdicts[1].evidence]=[r.output.verdicts[1].evidence,r.output.verdicts[0].evidence];}else feedback=d.validation_feedback;
 }return r;};
 const r=await generateCoverageGuide({...payload,blocks:blocks.slice(0,2)},{...f,review,identity:'audit-binding',cacheDir:false});
 assert.equal(r.usage.stages.guide_fidelity.status,'passed');assert.equal(f.state.generated,1);
 assert.equal(f.state.tasks.filter(t=>t.task==='fidelity_repair').length,0);
 assert.match(feedback,/fidelity_audit_binding_invalid/);assert.ok(feedback.includes(blocks[0].source_block_key)&&feedback.includes(blocks[1].source_block_key));
});
test('completed stages replay, including after a terminal transport interruption',async()=>{
 const dir=await fs.mkdtemp('D:/Artifacts/ProgressiveReading/guide-v2-fixture-'),f=fixture(),p={...payload,blocks:blocks.slice(0,2)};let stop=true;
 const options={...f,identity:'resume',cacheDir:dir,review:async x=>{if(stop&&JSON.parse(x.user).task==='fidelity')throw Object.assign(Error('transport_interrupted'),{terminal:true});return f.review(x);}};
 await assert.rejects(generateCoverageGuide(p,options),/transport_interrupted/);const generated=f.state.generated;stop=false;
 const r=await generateCoverageGuide(p,options);assert.equal(f.state.generated,generated);const count=[f.state.generated,f.state.reviewed];
 const replay=await generateCoverageGuide(p,options);assert.deepEqual(replay.output,r.output);assert.deepEqual([f.state.generated,f.state.reviewed],count);
});
test('source quotations, footnotes retained; parallel original and image-only blocks excluded',()=>{
 const c=chunkGuideBlocks([{...blocks[0],markdown:'## 标题'},{...blocks[1],markdown:'> 他人的论点。'},{...blocks[2],markdown:'脚注包含理由。'},{...blocks[3],role:'original'},{...blocks[4],markdown:'![图](x.png)'}]).flat();
 assert.equal(c.length,2);
});
test('all standard import source types use the same guide gate without body or translation calls',async()=>{
 class P extends ExternalProducer{async generateGuideCoverage(_c,p){return generateCoverageGuide(p,{...fixture(),identity:'entry',cacheDir:false});}async refineFullText(){throw Error('body_changed');}}
 for(const sourceType of ['public_web_article','video_transcript','pdf','epub','txt']){
  const source=blocks.slice(0,2).map(b=>b.markdown).join('\n\n');
  const req=buildPreprocessRequest({markdown:source,sourceType,sourceMetadata:{source_url:'https://example.com/'+sourceType,source_is_original:true,input_form:'written',content_profile:'natural_language',language:'zh'},processingOptions:{workflow_mode:'standard',spoken_to_written:false,structure_body:false,translate:false,include_reading_guide:true}});
  const p=new P({AI_PRODUCER_PROVIDER:'codex_exec',AI_PRODUCER_CODEX_MODEL:'fixture'}),r=await runPreprocessingRequest(req,{cacheDir:false,producer:p});
  assert.equal(r.result.status,'completed',JSON.stringify(r.result.errors));assert.equal(r.result.artifacts.cleaning_manifest.body_text,source);assert.ok(r.result.receipt.validations.some(v=>v.name==='reading_guide_fidelity'&&v.status==='passed'));
  p.generateGuideCoverage=()=>{throw Error('guide_disabled');};const off=await runPreprocessingRequest({...req,processing_options:{...req.processing_options,include_reading_guide:false}},{cacheDir:false,producer:p});assert.equal(off.result.status,'completed');
 }
});
test('formal guide calls never fall back to the API backend',async()=>{
 const p=new ExternalProducer({AI_PRODUCER_PROVIDER:'deepseek'});await assert.rejects(p.generate(payload,{requiredProvider:'codex_exec'}),/requires_codex_exec/);
});

test('source-verified quoted authors are not stripped by a later style normalization',async()=>{
 class P extends ExternalProducer{async generateGuideCoverage(_c,p){return generateCoverageGuide(p,{...fixture(),identity:'quotation',cacheDir:false});}}
 const source='书中作者主张只能用本能解释这一行为，后文实验反驳了这个主张。';
 const req=buildPreprocessRequest({markdown:source,sourceType:'public_web_article',sourceMetadata:{source_url:'https://example.com/quotation',source_is_original:true,input_form:'written',content_profile:'natural_language',language:'zh'},processingOptions:{workflow_mode:'standard',spoken_to_written:false,structure_body:false,translate:false,include_reading_guide:true,attribute_unverified_claims:true}});
 const r=await runPreprocessingRequest(req,{cacheDir:false,producer:new P({AI_PRODUCER_PROVIDER:'codex_exec',AI_PRODUCER_CODEX_MODEL:'fixture'})});
 assert.equal(r.result.status,'completed');assert.equal(r.result.artifacts.semantic.insights[0].description,source);
});

test('guide generation preserves the same body as the existing guide-disabled normalization',async()=>{
 class P extends ExternalProducer{async generateGuideCoverage(_c,p){return generateCoverageGuide(p,{...fixture(),identity:'body-baseline',cacheDir:false});}}
 const source='# 题目\n\n\n\n只有条件成立时，结论才成立。';
 const req=buildPreprocessRequest({markdown:source,sourceType:'video_transcript',sourceMetadata:{source_url:'https://example.com/body-baseline',source_is_original:true,input_form:'written',content_profile:'natural_language',language:'zh'},processingOptions:{workflow_mode:'standard',spoken_to_written:false,structure_body:false,translate:false,include_reading_guide:true}});
 const options={cacheDir:false,producer:new P({AI_PRODUCER_PROVIDER:'codex_exec',AI_PRODUCER_CODEX_MODEL:'fixture'})};
 const on=await runPreprocessingRequest(req,options),off=await runPreprocessingRequest({...req,processing_options:{...req.processing_options,include_reading_guide:false}},options);
 assert.equal(on.result.artifacts.cleaning_manifest.body_text,off.result.artifacts.cleaning_manifest.body_text);
 assert.equal(on.result.artifacts.cleaning_manifest.body_text,source.replace(/\n{3,}/gu,'\n\n'));
 assert.equal(off.result.receipt.model.calls,0);
});

test('a failed fidelity audit cannot publish even when the original body remains readable',async()=>{
 class P extends ExternalProducer{async generateGuideCoverage(){throw Object.assign(Error('guide_fidelity_incomplete'),{terminal:true});}}
 const source='仅在温度条件成立时发生转变。';
 const req=buildPreprocessRequest({markdown:source,sourceType:'public_web_article',sourceMetadata:{source_url:'https://example.com/failed-guide',source_is_original:true,input_form:'written',content_profile:'natural_language',language:'zh'},processingOptions:{workflow_mode:'standard',spoken_to_written:false,structure_body:false,translate:false,include_reading_guide:true}});
 const r=await runPreprocessingRequest(req,{cacheDir:false,producer:new P({AI_PRODUCER_PROVIDER:'codex_exec',AI_PRODUCER_CODEX_MODEL:'fixture'})});
 assert.equal(r.result.artifacts.cleaning_manifest.body_text,source);
 assert.equal(r.result.receipt.validations.find(v=>v.name==='reading_guide_fidelity').status,'failed');
 assert.equal(classifyStandardImportQuality(r.result).admissible,false);
 assert.equal(r.result.artifacts.semantic.insights.length,0);
});
