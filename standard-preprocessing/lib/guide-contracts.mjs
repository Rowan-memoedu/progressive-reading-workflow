// These schemas constrain serialization at the Codex boundary. Semantic
// evidence, complete membership and source fidelity are still checked locally.
const text={type:'string'};
const object=properties=>({type:'object',properties,required:Object.keys(properties),additionalProperties:false});
const array=(items,count)=>({type:'array',items,...(count===undefined?{}:{minItems:count,maxItems:count})});
const member=values=>({type:typeof values[0]==='number'?'integer':'string',enum:[...new Set(values)]});
const spanIds=array({type:'integer',minimum:1});
const roles=['author','reported','rebutted','hypothesis','question'];
const insight=keys=>object({title:text,description:text,target_block_key:member(keys)});
const indices=count=>array(count?member(Array.from({length:count},(_,n)=>n+1)):{type:'integer'},count?undefined:0);

export function guideGenerationSchema(blocks){
 const level={type:'string',enum:['very_low','low','medium','high','very_high']};
 return object({
  judgments:object({value:object({level,reason:text}),density:object({level,reason:text}),continue_reading:object({level:member([0,1,2,3,4]),reason:text})}),
  insights:array(insight(blocks.map(b=>b.source_block_key))),
  translation:object({is_bilingual:{type:'boolean',enum:[false]},alignments:array(text,0)})
 });
}

export function guideSelectionSchema(count){
 const index=member(Array.from({length:count},(_,n)=>n+1));
 return object({
  keep_indices:indices(count),
  remove:array(object({index,covered_by:indices(count),reason:text})),
  distinct_titles:array(object({index,unique_claim:text}))
 });
}

export function guideReviewSchema(input){
 if(input.task==='selection')return guideSelectionSchema(input.insights.length);
 if(input.task==='source_catalog')return object({reviews:array(object({
  source_block_key:member(input.sources.map(s=>s.source_block_key)),substantive:{type:'boolean'},reason:text,
  points:array(object({source_span_ids:spanIds,claim:text,kind:member(['claim','context_only','reference_only',...roles]),role:member(roles)}))
 }),input.sources.length)});
 if(input.task==='coverage')return object({coverage:array(object({
  point_id:member(input.frozen_points.map(p=>p.point_id)),insight_indices:indices(input.insights.length),missing_detail:text
 }),input.frozen_points.length)});
 if(input.task==='fidelity')return object({verdicts:array(object({
  index:member(input.insights.map(i=>i.index)),insight_title:member(input.insights.map(i=>i.title)),target_block_key:member([...new Set(input.insights.map(i=>i.target_block_key))]),
  status:member(['supported','unsupported']),
  evidence:array(object({source_block_key:member(input.sources.map(s=>s.source_block_key)),source_span_ids:spanIds})),
  problems:array(object({kind:member(['added_claim','changed_scope','changed_strength','wrong_attribution','missing_condition','wrong_target']),explanation:text}))
 }),input.insights.length)});
 if(input.task==='fidelity_repair')return object({replacements:array(object({
  index:member(input.insights.map(i=>i.index)),insight:insight(input.sources.map(s=>s.source_block_key))
 }),input.insights.length)});
 throw Error('unknown_guide_review_task:'+input.task);
}
