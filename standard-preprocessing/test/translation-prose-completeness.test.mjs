import test from 'node:test';
import assert from 'node:assert/strict';
import { protectTranslationBlockBatch, validateGenericTranslatedChunk, failedOnlyBecauseRecoverableTranslationStructure } from '../lib/producer.mjs';

test('long untranslated explanatory lists retry while short terms, formulas and references stay literal', () => {
  const prose = '- Preparing the apparatus requires connecting the power supply and checking that every component remains securely attached before any measurements are recorded.\n- Repeat the experiment after carefully documenting the results.';
  const block = { source_block_key:'independent-prose', type:'list', markdown:prose };
  const protection = protectTranslationBlockBatch([block]);
  const output = { translations:[{source_block_key:block.source_block_key,markdown:protection.get(block.source_block_key).protectedMarkdown}] };
  const rejected = validateGenericTranslatedChunk(output,[block],protection);
  assert.deepEqual(rejected.failures,['translation_target_language_missing:independent-prose']);
  assert.equal(failedOnlyBecauseRecoverableTranslationStructure(Array(3).fill(rejected.failures)),true);
  assert.deepEqual(validateGenericTranslatedChunk(output,[block],protection,new Set([block.source_block_key])).failures,[]);
  for (const markdown of ['- Signal processing', '$x^2+y^2=z^2$', '`do_not_translate()`']) {
    const label = {source_block_key:'label',type:'list',markdown};
    const p = protectTranslationBlockBatch([label]);
    assert.deepEqual(validateGenericTranslatedChunk({translations:[{source_block_key:'label',markdown:p.get('label').protectedMarkdown}]},[label],p).failures,[]);
  }
  const translated = protection.get(block.source_block_key).protectedMarkdown.replace('Preparing the apparatus requires','准备设备需要');
  assert.deepEqual(validateGenericTranslatedChunk({translations:[{source_block_key:block.source_block_key,markdown:translated}]},[block],protection).failures,[]);
  const heading = {source_block_key:'short-heading',type:'heading',markdown:'# GENERAL PRINCIPLES'};
  const hp = protectTranslationBlockBatch([heading]);
  assert.deepEqual(validateGenericTranslatedChunk({translations:[{source_block_key:heading.source_block_key,markdown:hp.get(heading.source_block_key).protectedMarkdown}]},[heading],hp,new Set(),{requireChinese:true}).failures,['translation_target_language_missing:chunk']);
});
