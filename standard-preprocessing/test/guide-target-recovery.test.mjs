import test from 'node:test';
import assert from 'node:assert/strict';
import {recoverGuideTargetKeys} from '../lib/producer.mjs';
const blocks=[{source_block_key:'src-0001-abcdef12',markdown:'校准仪器之后再测量，实验记录必须逐项保存。'},
 {source_block_key:'src-0002-123456ab',markdown:'模型假设要接受检验，数据不足时保留结论。'}]; // gitleaks:allow -- synthetic source-block key, not a credential
const output={insights:[{title:'实验记录',description:'校准仪器之后再测量，实验记录必须逐项保存。',target_block_key:'src-0001-ffffffff'}]};
test('repair requires unchanged ordinal and unique disjoint exact source evidence',()=>{
 const raw=structuredClone(output),fixed=recoverGuideTargetKeys(raw,blocks);
 assert.equal(fixed.output.insights[0].target_block_key,blocks[0].source_block_key);
 assert.equal(fixed.repairs.length,1);assert.deepEqual(raw,output);
 assert.equal(recoverGuideTargetKeys(fixed.output,blocks).repairs.length,0);
});
test('ambiguous evidence, wrong ordinal, and unsupported descriptions stay rejected',()=>{
 assert.equal(recoverGuideTargetKeys(output,[...blocks,{...blocks[0],source_block_key:'src-0003-abcd1234'}]).repairs.length,0);
 const wrong=structuredClone(output);wrong.insights[0].target_block_key='src-0002-ffffffff';
 assert.equal(recoverGuideTargetKeys(wrong,blocks).repairs.length,0);
 wrong.insights[0].description='没有相应正文支持的其他观点';
 assert.equal(recoverGuideTargetKeys(wrong,blocks).repairs.length,0);
});
