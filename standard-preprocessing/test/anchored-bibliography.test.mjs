import test from 'node:test';
import assert from 'node:assert/strict';
import { translationLiteralBlockKeys } from '../lib/producer.mjs';

test('EPUB anchors preceding a bibliography heading do not hide its section context', () => {
  const blocks = [
    {type:'paragraph',source_block_key:'heading',markdown:'<a id="origin"></a>\n# References'},
    {type:'paragraph',source_block_key:'reference',markdown:'Anonymous. A catalogue of experimental instruments. Example Press.'},
    {type:'paragraph',source_block_key:'next',markdown:'<a id="discussion"></a>\n# Discussion'},
    {type:'paragraph',source_block_key:'prose',markdown:'The next section explains how to use the instruments.'}
  ];
  const literal = translationLiteralBlockKeys(blocks);
  assert.equal(literal.has('reference'),true);
  assert.equal(literal.has('prose'),false);
});

test('article headings mentioning references or textbooks do not exempt their prose from translation',()=>{
  const blocks=[
    {type:'heading',source_block_key:'topic',markdown:'# Building Better Reference Habits'},
    {type:'paragraph',source_block_key:'explanation',markdown:'Students should attempt a problem before looking at the answer.'},
    {type:'heading',source_block_key:'textbooks',markdown:'## How to Choose Textbooks'},
    {type:'paragraph',source_block_key:'selection',markdown:'The first question is whether the examples match the learner.'},
    {type:'heading',source_block_key:'bibliography',markdown:'## 3. Recommended Reading'},
    {type:'paragraph',source_block_key:'entry',markdown:'Anonymous. A catalogue of experimental instruments. Example Press.'}
  ];
  const literal=translationLiteralBlockKeys(blocks);
  assert.equal(literal.has('explanation'),false);
  assert.equal(literal.has('selection'),false);
  assert.equal(literal.has('entry'),true);
});
