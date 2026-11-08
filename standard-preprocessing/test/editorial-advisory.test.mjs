import test from 'node:test';
import assert from 'node:assert/strict';
import { processMaterial } from '../lib/core.mjs';
import { classifyStandardImportQuality } from '../../scripts/standard-import-quality.mjs';

const markdown = Array.from({ length: 12 }, (_, index) => `第${index + 1}项记录：嗯，是否继续试验？结果尚不确定。需要核验输入、保存来源、比较输出，只有条件满足时才继续。`).join('\n\n');
const request = () => ({
  schema_version: 'progressive-reading.preprocess.request/v1', contract_version: '1.0.0', user_instruction: '',
  source_type: 'test_transcript', material: { markdown },
  source_metadata: { source_url: 'https://example.com/independent-transcript', title: '独立试验记录', source_is_original: true },
  processing_options: { cleaning_mode: 'lossless_spoken_to_written', preserve_source_voice: true, require_content_headings: true, include_reading_guide: false }
});
const output = blocks => ({
  cleaned_sections: blocks.map(block => ({ source_block_keys: [block.source_block_key], markdown: block.markdown, reason: '保留完整原文' })),
  judgments: null, insights: [], translation: { is_bilingual: false, alignments: [] }
});

test('editorial details remain traceable without retrying an otherwise complete spoken document', async () => {
  let calls = 0;
  const result = await processMaterial(request(), { producer: { generate: async payload => { calls += 1; return { output: output(payload.blocks) }; } } });
  assert.equal(calls, 1);
  assert.equal(result.status, 'completed');
  assert.equal(classifyStandardImportQuality(result).admissible, true);
  const details = result.receipt.validations.find(item => item.name === 'editorial_details_non_blocking').details;
  assert.equal(details.policy, 'advisory');
  assert.ok(details.findings.some(item => item.startsWith('structured_body_headings_missing')));
  assert.ok(details.findings.some(item => item.startsWith('oral_noise_not_sufficiently_reduced')));
  assert.ok(details.findings.some(item => item.startsWith('question_answer_form_not_sufficiently_reduced')));
  assert.doesNotMatch(result.artifacts.reading_markdown, /editorial_details_non_blocking|structured_body_headings_missing|oral_noise_not_sufficiently_reduced|question_answer_form_not_sufficiently_reduced/u);
  assert.equal(result.artifacts.cleaning_manifest.body_text.replace(/\s/gu, ''), markdown.replace(/\s/gu, ''));
});

test('missing source blocks are still rejected and only the complete original can be recovered', async () => {
  const result = await processMaterial(request(), { producer: { generate: async payload => ({ output: output(payload.blocks.slice(0, 1)) }) } });
  assert.equal(result.status, 'completed_with_warnings');
  assert.ok(result.receipt.model.attempts.every(item => item.validation_errors.some(error => error.startsWith('lossless_source_'))));
  assert.equal(result.artifacts.cleaning_manifest.body_text.replace(/\s/gu, ''), markdown.replace(/\s/gu, ''));
  assert.equal(result.receipt.validations.find(item => item.name === 'whole_article_cleaning').status, 'failed');
});
