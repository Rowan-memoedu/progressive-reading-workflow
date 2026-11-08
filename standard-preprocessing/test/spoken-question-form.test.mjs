import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeDocumentQuestionForm } from '../lib/producer.mjs';

const body = '试验需要保留原来的目标、条件、样本、步骤、资源和退出方案。结果尚不确定，只有验证条件满足后才考虑继续。'.repeat(4);
const section = index => ({ source_block_keys: [`sample-${index}`], markdown: `## 是否继续试验？\n${body}`, reason: '保留全部背景与条件' });
const parsedInput = user => JSON.parse(user.slice(user.search(/\n(?:\[|\{)\n/u) + 1));
const convert = value => ({ ...value, markdown: value.markdown.replace('是否继续试验？', '继续试验的条件') });

test('long interviews reuse bounded per-section normalization and preserve every source key', async () => {
  const source = Array.from({ length: 70 }, (_, index) => section(index));
  let calls = 0;
  const result = await normalizeDocumentQuestionForm({}, source, [], { maxQuestions: 8, callModel: async (_config, prompt) => {
    calls += 1;
    const input = parsedInput(prompt.user);
    assert.equal(Array.isArray(input), false, 'long bodies must not be echoed in a whole-document response');
    assert.ok(prompt.user.length < 6000);
    assert.match(prompt.system, /问句标题可改为同义陈述或名词短语/u);
    return { output: { cleaned_sections: [convert(input)] } };
  } });
  assert.equal(result.apiCalls, calls);
  assert.equal(calls, 62);
  assert.deepEqual(result.sections.map(item => item.source_block_keys), source.map(item => item.source_block_keys));
  assert.ok(result.sections.every(item => item.markdown.endsWith(body)));
  assert.equal((result.sections.map(item => item.markdown).join('').match(/？/gu) || []).length, 8);
});

test('invalid bulk JSON falls through to the existing individual path', async () => {
  const source = [section(1), section(2)];
  let calls = 0;
  const result = await normalizeDocumentQuestionForm({}, source, [], { maxQuestions: 0, callModel: async (_config, prompt) => {
    calls += 1;
    const input = parsedInput(prompt.user);
    if (Array.isArray(input)) throw new Error('producer_invalid_json_truncated');
    return { output: { cleaned_sections: [convert(input)] } };
  } });
  assert.equal(result.apiCalls, 3);
  assert.equal(calls, 3);
  assert.deepEqual(result.sections.map(item => item.source_block_keys), source.map(item => item.source_block_keys));
  assert.ok(result.sections.every(item => item.markdown.endsWith(body)));
});

test('rejected bulk output cannot drop sections from later attempts or fallback', async () => {
  const source = [section(1), section(2), section(3)];
  let bulkCalls = 0;
  const result = await normalizeDocumentQuestionForm({}, source, [], { maxQuestions: 0, callModel: async (_config, prompt) => {
    const input = parsedInput(prompt.user);
    if (Array.isArray(input)) {
      bulkCalls += 1;
      assert.equal(input.length, source.length);
      return { output: { cleaned_sections: [convert(input[0])] } };
    }
    return { output: { cleaned_sections: [convert(input)] } };
  } });
  assert.equal(bulkCalls, 2);
  assert.equal(result.apiCalls, 5);
  assert.deepEqual(result.sections.map(item => item.source_block_keys), source.map(item => item.source_block_keys));
  assert.ok(result.sections.every(item => item.markdown.endsWith(body)));
});

test('remaining question-form failures still reject the document', async () => {
  await assert.rejects(normalizeDocumentQuestionForm({}, [section(1), section(2)], [], { maxQuestions: 0,
    callModel: async (_config, prompt) => {
      const input = parsedInput(prompt.user);
      return { output: { cleaned_sections: Array.isArray(input) ? input : [input] } };
    }
  }), /document_question_form_rejected:question_marks_2_above_0/u);
});

test('documents already within the existing question budget need no model calls', async () => {
  const source = [section(1)];
  const result = await normalizeDocumentQuestionForm({}, source, [], { callModel: async () => { throw new Error('unexpected_call'); } });
  assert.equal(result.sections, source);
  assert.equal(result.apiCalls, 0);
});

test('individual normalization gives length failures back to the model before accepting a repair', async () => {
  const source = Array.from({ length: 70 }, (_, index) => section(index));
  let calls = 0;
  const result = await normalizeDocumentQuestionForm({}, source, [], { maxQuestions: 69, callModel: async (_config, prompt) => {
    calls += 1;
    const input = parsedInput(prompt.user);
    if (calls === 1) return { output: { cleaned_sections: [{ ...input, markdown: '## 试验条件\n信息不足。' }] } };
    assert.match(prompt.user, /length_ratio_/u);
    return { output: { cleaned_sections: [convert(input)] } };
  } });
  assert.equal(result.apiCalls, 2);
  assert.ok(result.sections.every(item => item.markdown.endsWith(body)));
});

test('a faithful partial question repair is refined within the same section', async () => {
  const source = Array.from({ length: 70 }, (_, index) => section(index));
  source[0].markdown += '\n是否先核验输入？是否保留记录？';
  let calls = 0;
  let best;
  const result = await normalizeDocumentQuestionForm({}, source, [], { maxQuestions: 69, callModel: async (_config, prompt) => {
    calls += 1;
    const input = parsedInput(prompt.user);
    if (calls > 1) assert.match(prompt.user, /question_marks_remaining_/u);
    best = { ...input, markdown: (best?.markdown || input.markdown).replace('？', '。') };
    return { output: { cleaned_sections: [best] } };
  } });
  assert.equal(calls, 3);
  assert.equal(result.apiCalls, 3);
  assert.equal((result.sections.map(item=>item.markdown).join('').match(/？/gu)||[]).length, 69);
  assert.deepEqual(result.sections.map(item=>item.source_block_keys), source.map(item=>item.source_block_keys));
});
