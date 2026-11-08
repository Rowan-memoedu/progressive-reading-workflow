import assert from 'node:assert/strict';
import test from 'node:test';
import {prepareAnchoredTranslationSegments,protectTranslationMarkdown,restoreAnchoredTranslationSegments,restoreAnchoredTranslationTokens,restoreTranslationMarkdown,failedOnlyBecauseRecoverableTranslationStructure} from '../lib/producer.mjs';

test('anchored translations preserve frozen source tokens and offsets without re-tokenizing prose',()=>{
  for(const source of ['Compare $a$ and [paper](https://example.test/paper).', 'First `x()` then `y()` and [details](https://example.test/details).']){
    const anchored=prepareAnchoredTranslationSegments(source);
    const protection=protectTranslationMarkdown(source,{includeMath:true,tokenOffset:57});
    const translated=anchored.source_segments.map((segment,index)=>index===1?' $ dollars '+segment:segment);
    const restored=restoreAnchoredTranslationTokens(anchored,translated,protection);
    const actual=restored.match(/ZXQPRP\d{4}QXZ/gu);
    assert.deepEqual(actual,[...protection.values].sort((a,b)=>a.order-b.order).map(x=>x.token));
    assert.equal(restoreTranslationMarkdown(restored,protection.values),restoreAnchoredTranslationSegments(anchored,translated));
  }
});

test('anchored token restoration rejects missing segments and incompatible source protection',()=>{
  const a=prepareAnchoredTranslationSegments('Use `a` then `b`.');
  const p=protectTranslationMarkdown('Use `a` then `b`.',{includeMath:true});
  assert.throws(()=>restoreAnchoredTranslationTokens(a,[],p),/segment_count/);
  assert.throws(()=>restoreAnchoredTranslationTokens(a,a.source_segments,protectTranslationMarkdown('Use `c` then `d`.',{includeMath:true})),/protection_mismatch/);
});

test('protected link syntax failures use the fully validated anchored fallback without accepting missing blocks',()=>{
  const failures=[['translation_protected_syntax_changed:source-key'],['translation_protected_token_order:source-key'],['translation_markdown_markers_changed:source-key']];
  assert.equal(failedOnlyBecauseRecoverableTranslationStructure(failures),true);
  assert.equal(failedOnlyBecauseRecoverableTranslationStructure([...failures.slice(0,2),['missing_source_block:source-key']]),false);
});
