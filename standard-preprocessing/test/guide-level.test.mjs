import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {normalizeGuideLevel,ExternalProducer} from '../lib/producer.mjs';

test('guide level accepts only equivalent standard labels and numeric strings without changing the saved response',()=>{
  for(const [value,expected]of [['4',4],[' 全文 ',3],['概览与关键结论',2],['不值得读',0]]){
    const raw={judgments:{continue_reading:{level:value,reason:'来源理由'}},insights:[{description:'原洞察'}]};
    const normalized=normalizeGuideLevel(raw);
    assert.equal(normalized.judgments.continue_reading.level,expected);
    assert.equal(raw.judgments.continue_reading.level,value);
    assert.equal(normalized.insights[0].description,'原洞察');
  }
});

test('invalid guide grades are never clamped or guessed',()=>{
  for(const value of [5,-1,'5','高','阅读全文吗',null]){
    const raw={judgments:{continue_reading:{level:value}}};
    assert.equal(normalizeGuideLevel(raw),raw);
  }
});

test('guide response is frozen before normalization and replay sends no second request',async()=>{
  const root=await fs.mkdtemp('D:/Artifacts/ProgressiveReading/guide-response-fixture-');
  const previousRoot=process.env.PR_GUIDE_RESPONSE_CACHE_DIR;
  const previousFetch=globalThis.fetch;
  process.env.PR_GUIDE_RESPONSE_CACHE_DIR=root;
  let calls=0;
  globalThis.fetch=async()=>{
    calls+=1;
    return {ok:true,json:async()=>({choices:[{message:{content:JSON.stringify({judgments:{continue_reading:{level:'4',reason:'来源理由'}},insights:[]})}}],usage:{}})};
  };
  try{
    const config={AI_PRODUCER_BASE_URL:'https://example.invalid',AI_PRODUCER_MODEL:'fixture',DEEPSEEK_READING_API_KEY:'synthetic-only',AI_PRODUCER_MAX_RETRIES:0};
    const payload={cleaning_policy:{mode:'semantic_only',include_reading_guide:true},blocks:[],source_metadata:{},insight_policy:{}};
    const first=await new ExternalProducer(config).generate(payload,{singleAttempt:true});
    const second=await new ExternalProducer(config).generate(payload,{singleAttempt:true});
    assert.equal(calls,1);
    assert.equal(first.output.judgments.continue_reading.level,4);
    assert.equal(second.api_calls,0);
    const filename=(await fs.readdir(root)).find(name=>name.endsWith('.response.json'));
    const raw=JSON.parse(await fs.readFile(root+'/'+filename,'utf8'));
    assert.equal(JSON.parse(raw.choices[0].message.content).judgments.continue_reading.level,'4');
  }finally{
    globalThis.fetch=previousFetch;
    if(previousRoot===undefined)delete process.env.PR_GUIDE_RESPONSE_CACHE_DIR;
    else process.env.PR_GUIDE_RESPONSE_CACHE_DIR=previousRoot;
  }
});
