import test from 'node:test';import assert from 'node:assert/strict';
import {extendBoardEvidencePlan} from './board-evidence-plan.mjs';
test('uncovered mathematics gets only source-bound visual evidence candidates, without changing the raw plan',()=>{
 const plan={items:[{kind:'screenshot',time:'00:01:00'}]},before=JSON.stringify(plan);
 const transcript={duration:1200,segments:[{start:'00:00:00',text:'欢迎大家上课'},{start:'00:02:00',text:'这个不等式先换元'},{start:'00:08:00',text:'下一题证明等号条件'},{start:'00:18:00',text:'根号与平方的最后一题'}]};
 const result=extendBoardEvidencePlan(plan,transcript);
 assert.equal(JSON.stringify(plan),before);assert.equal(result.receipt.added.length,2);
 assert.equal(result.plan.items[1].source_quote,transcript.segments[2].text);
 assert.equal(result.plan.items[1].purpose,'board_evidence');
 assert.equal(extendBoardEvidencePlan(result.plan,transcript).receipt.added.length,0);
});
