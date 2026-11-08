import test from 'node:test';
import assert from 'node:assert/strict';
import { hasIntroducedTranslationTime, processMaterial } from '../lib/core.mjs';

test('translation preserves original clock times while rejecting invented or duplicated times', async () => {
  assert.equal(hasIntroducedTranslationTime('Work began at 7:15 a.m.','工作在 7:15 开始。'),false);
  assert.equal(hasIntroducedTranslationTime('Work began at 7:15 a.m.','工作在 7:15 和 7:15 开始。'),true);
  for (const originalTime of [true,false]) {
    const result=await processMaterial({schema_version:'progressive-reading.preprocess.request/v1',contract_version:'1.0.0',source_type:'fixture',source_metadata:{source_url:'https://example.invalid/time',source_is_original:true},material:{markdown:originalTime?'Work began at 7:15 a.m.':'Work began early in the morning.'},user_instruction:'',processing_options:{cleaning_mode:'source_translation',translation_target_language:'zh-CN',include_reading_guide:false,forbid_visible_timestamps:true}}, {producer:{async generate(payload){return {provider:'fixture',model:'fixture',output:{cleaned_blocks:payload.blocks.map(b=>({source_block_key:b.source_block_key,markdown:'工作在 7:15 开始。'})),judgments:null,insights:[],translation:{is_bilingual:false,alignments:[]}}};}}});
    assert.equal(result.status,originalTime?'completed':'completed_with_warnings');
    if (!originalTime) assert.match(result.errors[0].message,/visible_timestamp_introduced/u);
  }
});
