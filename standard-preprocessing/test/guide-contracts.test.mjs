import test from 'node:test';
import assert from 'node:assert/strict';
import Ajv from 'ajv';
import {guideGenerationSchema,guideReviewSchema} from '../lib/guide-contracts.mjs';
const source={source_block_key:'src-1'},i={index:1,title:'条件',description:'须满足温度条件。',target_block_key:'src-1'};
const compiler=new Ajv({strict:true});
test('guide contracts cover every review stage and reject unrequested identities',()=>{
 const input={sources:[source],insights:[i],frozen_points:[{point_id:'p1'}]};
 for(const task of ['source_catalog','selection','coverage','fidelity','fidelity_repair'])assert.equal(typeof compiler.compile(guideReviewSchema({...input,task})),'function');
 const coverage=compiler.compile(guideReviewSchema({...input,task:'coverage'}));
 assert.equal(coverage({coverage:[{point_id:'p1',insight_indices:[1],missing_detail:''}]}),true);
 assert.equal(coverage({coverage:[]}),false);
 assert.equal(coverage({coverage:[{point_id:'invented',insight_indices:[1],missing_detail:''}]}),false);
 const repair=compiler.compile(guideReviewSchema({...input,task:'fidelity_repair'}));
 assert.equal(repair({replacements:[{index:2,insight:{title:i.title,description:i.description,target_block_key:i.target_block_key}}]}),false);
 assert.equal(typeof compiler.compile(guideReviewSchema({...input,task:'fidelity',insights:[i,{...i,index:2}]})),'function');
});
test('guide generation schema preserves reading judgments while limiting claims to source keys',()=>{
 const valid=compiler.compile(guideGenerationSchema([source])),rating={level:'high',reason:'包含具体条件。'};
 const output={judgments:{value:rating,density:rating,continue_reading:{level:3,reason:'可继续阅读论证。'}},insights:[{title:i.title,description:i.description,target_block_key:i.target_block_key}],translation:{is_bilingual:false,alignments:[]}};
 assert.equal(valid(output),true);output.insights[0].target_block_key='other';assert.equal(valid(output),false);
});
