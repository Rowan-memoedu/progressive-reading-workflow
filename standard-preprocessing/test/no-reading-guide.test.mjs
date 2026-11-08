import assert from 'node:assert/strict';
import test from 'node:test';
import { ExternalProducer } from '../lib/producer.mjs';
import { buildPreprocessRequest, runPreprocessingRequest, validateRequestContract } from '../index.mjs';

test('no-guide standard workflow translates, preserves original, and makes no guide API call', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (_url, options) => {
    calls++;
    const body = JSON.parse(options.body);
    assert.doesNotMatch(body.messages[0].content, /导读编辑器/);
    assert.match(body.messages[1].content,/ZXQSEG000000QXZ/);
    return {ok: true, json: async () => ({choices:[{message:{content:JSON.stringify({markdown:'ZXQSEG000000QXZ\n植物利用阳光制造糖分。'})}}],usage:{}})};
  };
  try {
    const request = buildPreprocessRequest({markdown:'Plants use sunlight to produce sugars.', sourceType:'epub', sourceMetadata:{source_url:'file:///example.epub', source_is_original:true, input_form:'written', content_profile:'natural_language', language:'en'}, processingOptions:{workflow_mode:'standard',include_reading_guide:false}});
    assert.equal((await validateRequestContract(request)).valid, true);
    const run = await runPreprocessingRequest(request, {cacheDir:false, producer:new ExternalProducer({AI_PRODUCER_BASE_URL:'https://example.invalid/v1', DEEPSEEK_READING_API_KEY:'synthetic', AI_PRODUCER_MODEL:'synthetic', AI_PRODUCER_TIMEOUT_MS:1000})});
    assert.equal(run.result.status,'completed',JSON.stringify(run.result.receipt.model.attempts));
    assert.equal(calls,1);
    assert.equal(run.result.artifacts.semantic.judgments,null);
    assert.deepEqual(run.result.artifacts.semantic.insights,[]);
    assert.match(run.result.artifacts.reading_markdown,/植物利用阳光制造糖分/);
    assert.match(run.result.artifacts.reading_markdown,/Plants use sunlight/);
    assert.doesNotMatch(run.result.artifacts.reading_markdown,/阅读前置卡|核心洞察|待处理/);
  } finally {globalThis.fetch=originalFetch;}
});
