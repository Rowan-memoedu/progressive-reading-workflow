import test from 'node:test';
import assert from 'node:assert/strict';
import { sourceHasAuthorAttribution, processMaterial } from '../lib/core.mjs';

test('original English research attribution is retained without authorizing fabricated attribution', async () => {
  assert.equal(sourceHasAuthorAttribution('The author argues that controlled experiments are necessary.'),true);
  assert.equal(sourceHasAuthorAttribution('Researchers also suggest repeating the measurements.'),true);
  assert.equal(sourceHasAuthorAttribution('I measured the samples and then repeated the experiment.'),false);
  for (const hasAttribution of [true,false]) {
    const result = await processMaterial({schema_version:'progressive-reading.preprocess.request/v1',contract_version:'1.0.0',source_type:'fixture',source_metadata:{source_url:'https://example.invalid/attribution',source_is_original:true},material:{markdown:hasAttribution?'The author argues that controlled experiments are necessary.':'I measured the samples and then repeated the experiment.'},user_instruction:'',processing_options:{cleaning_mode:'source_translation',translation_target_language:'zh-CN',include_reading_guide:false}}, {producer:{async generate(payload){return {provider:'fixture',model:'fixture',output:{cleaned_blocks:payload.blocks.map(b=>({source_block_key:b.source_block_key,markdown:'作者指出，进行对照实验是必要的。'})),judgments:null,insights:[],translation:{is_bilingual:false,alignments:[]}}};}}});
    assert.equal(result.status,hasAttribution?'completed':'completed_with_warnings');
    if (!hasAttribution) assert.match(result.errors[0].message,/source_voice_shifted_to_third_person/u);
  }
});
