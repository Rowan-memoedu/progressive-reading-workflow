import test from 'node:test';
import assert from 'node:assert/strict';
import { isBibliographicReferenceBlock, translationLiteralBlockKeys } from '../lib/producer.mjs';

test('author-led linked reference lists remain literal, including undated web references', () => {
  const lines = [
    '- Miller, A. [A Field Guide to Scientific Observation.](https://example.invalid/observation) Evidence.org.',
    '- Brown, B. C., Green, D. E., & White, F. G. (2019). [Learning in Complex Environments.](https://example.invalid/learning) Research Journal, 12 (3), 41.'
  ];
  for (const line of lines) assert.equal(isBibliographicReferenceBlock(line),true);
  assert.equal(isBibliographicReferenceBlock(lines.join('\n')),true);
  assert.equal(translationLiteralBlockKeys([{source_block_key:'resources',type:'list',markdown:lines.join('\n')}]).has('resources'),true);
  const explanation = '- Miller, A. [Observation](https://example.invalid/observation) explains how researchers can collect evidence.';
  assert.equal(isBibliographicReferenceBlock(explanation),false);
  assert.equal(isBibliographicReferenceBlock(lines[0]+'\n'+explanation),false);
});
