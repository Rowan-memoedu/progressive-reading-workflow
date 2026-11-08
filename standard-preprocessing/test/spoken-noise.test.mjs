import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizePureOralNoise, validateChunkOutput } from '../lib/producer.mjs';

const tail = '这段论述保留了人物身份、观点来源和原有条件。编辑只能整理语言形式，不能把一个称谓在论述中的所有出现都删除，也不能改变事实之间的关系。';
function failures(text) {
  const blocks = [{source_block_key:'source-1',markdown:text}];
  return validateChunkOutput({cleaned_sections:[{source_block_keys:['source-1'],markdown:`## 人物与观点\n${text}`,reason:'保留实质信息。'}]}, blocks);
}
test('substantive name attributions and longer words agree with existing cleanup behavior', () => {
  for (const text of [`党哥反复强调行业安全的重要性。${tail}`, `这个观点来自党哥说的学习经验。${tail}`, `大哥正在照顾弟弟，大哥大手机则是另一种产品。${tail}`]) {
    assert.equal(normalizePureOralNoise(text), text);
    assert.deepEqual(failures(text), []);
  }
});
test('vocatives and mechanical fillers still fail the unchanged noise quality gate', () => {
  for (const text of [`党哥，${tail}`, `大哥，${tail}`, `嗯，这个这个问题。${tail}`]) {
    assert.ok(failures(text).some(failure => failure.startsWith('oral_noise_')));
    assert.notEqual(normalizePureOralNoise(text), text);
  }
});

test('prose noise cleanup preserves nested bullets and native code/math/link literals', () => {
  const source = '## 条件\n\n- 嗯，测量需要校准。\n  - 然后然后记录结果。\n    - 条件不满足时停止。\n\n```mermaid\n  A[嗯] --> B[然后然后]\n```\n\n公式 $\\text{嗯}=x$，链接 [原文](https://example.com/然后然后)。';
  const cleaned = normalizePureOralNoise(source);
  assert.match(cleaned, /\n  - 然后记录结果。\n    - 条件不满足时停止。/u);
  assert.ok(cleaned.includes('```mermaid\n  A[嗯] --> B[然后然后]\n```'));
  assert.ok(cleaned.includes('$\\text{嗯}=x$'));
  assert.ok(cleaned.includes('(https://example.com/然后然后)'));
  assert.doesNotMatch(cleaned, /- 嗯，测量/u);
});
