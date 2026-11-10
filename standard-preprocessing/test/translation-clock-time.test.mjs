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

test('unchanged written material preserves clock facts and rejects invented or duplicated times',async()=>{
  const source='办公室将在星期五上午 8:20 开放，工作人员随后检查设备并准备资料。';
  for(const [markdown,valid]of [[source,true],[source.replace('8:20','8:20 和 8:20'),false],[source.replace('8:20','8:40'),false]]){
    const result=await processMaterial({schema_version:'progressive-reading.preprocess.request/v1',contract_version:'1.0.0',
      source_type:'fixture',source_metadata:{source_url:'https://example.invalid/written-clock',source_is_original:true},
      material:{markdown:source},user_instruction:'',processing_options:{input_form:'written',spoken_to_written:false,
        cleaning_mode:'source_voice_structuring',include_reading_guide:false,forbid_visible_timestamps:true}},
      {producer:{async generate(payload){assert.equal(payload.cleaning_policy.preserve_source_clock_times,true);
        return {provider:'fixture',model:'fixture',output:{cleaned_blocks:payload.blocks.map(block=>({source_block_key:block.source_block_key,markdown})),
          judgments:null,insights:[],translation:{is_bilingual:false,alignments:[]}}};}}});
    assert.equal(result.status,valid?'completed':'completed_with_warnings');
    if(!valid)assert.match(result.errors[0].message,/visible_timestamp_introduced/u);
  }
});
