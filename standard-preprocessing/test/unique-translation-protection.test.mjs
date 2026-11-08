import assert from 'node:assert/strict';
import test from 'node:test';
import { protectTranslationBlockBatch, protectTranslationMarkdown, prepareAnchoredTranslationSegments, restoreTranslationMarkdown } from '../lib/producer.mjs';
test('continuous batches use unique protected slots and restore each block exactly',()=>{
  const blocks = [
    {source_block_key:'a',markdown:'## Heading\nSee [one](https://example.org/one).'},
    {source_block_key:'b',markdown:'- Compute $x+1$ using `add(x,1)` and [two](https://example.org/two).'}
  ];
  const protectedBlocks = protectTranslationBlockBatch(blocks);
  const tokens = [...protectedBlocks.values()].flatMap(value=>value.values.map(item=>item.token));
  assert.equal(new Set(tokens).size,tokens.length);
  for(const block of blocks) {
    const value=protectedBlocks.get(block.source_block_key);
    assert.equal(restoreTranslationMarkdown(value.protectedMarkdown,value.values),block.markdown);
    assert.throws(()=>restoreTranslationMarkdown(value.protectedMarkdown.replace(value.values[0].token,''),value.values),/protected_token_order/);
  }
});

test('inequality prose and nested literal protection expose only restorable source slots',()=>{
  for(const source of [
    'Learn [with <_k_ examples](https://example.test/learning "Examples") and compare x > y, then use `f(x)`.',
    'See <span data-url="https://example.test/data">details</span> and [a](https://example.test/a).',
    'See <https://example.test/data> and then `<tag>` before $x>y$.'
  ]){
    const value=protectTranslationMarkdown(source,{includeMath:true,tokenOffset:71});
    const visible=value.protectedMarkdown.match(/ZXQPRP\d{4}QXZ/gu)||[];
    assert.equal(visible.length,value.values.length);
    assert.ok(value.values.every(item=>visible.includes(item.token)&&!/ZXQPRP\d{4}QXZ/u.test(item.value)));
    assert.equal(restoreTranslationMarkdown(value.protectedMarkdown,value.values),source);
    assert.ok(prepareAnchoredTranslationSegments(source,{includeMath:true}));
  }
});
