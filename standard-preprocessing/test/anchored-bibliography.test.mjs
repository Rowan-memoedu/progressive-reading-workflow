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
