import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {parseJsonObject,ExternalProducer} from '../lib/producer.mjs';

test('recover premature root closure without changing nested strings or values',()=>{
 const first={judgments:{reason:'字符串中的 } 和 { 以及 "引号"'},insights:[{text:'湿度 60%',nested:{condition:true}}]};
 const last={translation:{is_bilingual:false,alignments:[]}};
 const malformed=JSON.stringify(first)+','+JSON.stringify(last).slice(1);
 assert.deepEqual(parseJsonObject(malformed),{...first,...last});
 assert.deepEqual(parseJsonObject('```json\n'+malformed+'\n```'),{...first,...last});
});

test('reject conflicting members, multiple objects and malformed continuation',()=>{
 for(const text of ['{"x":1},"x":2}','{"x":1},{"y":2}','{"x":1},"y":','{"x":1} trailing prose {bad}','{"x":1},[2]}'])
  assert.throws(()=>parseJsonObject(text),/producer_invalid_json/);
});

test('cached malformed response recovers through normal producer without another API call',async()=>{
 const root=await fs.mkdtemp('D:/Artifacts/ProgressiveReading/json-resume-fixture-');
 const previousRoot=process.env.PR_GUIDE_RESPONSE_CACHE_DIR,previousFetch=globalThis.fetch;
 const raw='{"judgments":{"continue_reading":{"level":3,"reason":"仪器校准"}},"insights":[]},"translation":{"is_bilingual":false,"alignments":[]}}';
 let calls=0;process.env.PR_GUIDE_RESPONSE_CACHE_DIR=root;
 globalThis.fetch=async()=>{calls++;return {ok:true,json:async()=>({choices:[{message:{content:raw}}],usage:{}})};};
 try{
  const config={AI_PRODUCER_BASE_URL:'https://example.invalid',AI_PRODUCER_MODEL:'fixture',DEEPSEEK_READING_API_KEY:'synthetic-only',AI_PRODUCER_MAX_RETRIES:0};
  const payload={cleaning_policy:{mode:'semantic_only',include_reading_guide:true},blocks:[],source_metadata:{},insight_policy:{}};
  const first=await new ExternalProducer(config).generate(payload,{singleAttempt:true});
  const second=await new ExternalProducer(config).generate(payload,{singleAttempt:true});
  assert.equal(calls,1);assert.equal(second.api_calls,0);assert.deepEqual(first.output,second.output);
  const name=(await fs.readdir(root)).find(n=>n.endsWith('.response.json'));
  assert.equal(JSON.parse(await fs.readFile(root+'/'+name,'utf8')).choices[0].message.content,raw);
 }finally{globalThis.fetch=previousFetch;if(previousRoot===undefined)delete process.env.PR_GUIDE_RESPONSE_CACHE_DIR;else process.env.PR_GUIDE_RESPONSE_CACHE_DIR=previousRoot;}
});

test('interrupted guide request resumes the same frozen input and replays a completed response',async()=>{
 const root=await fs.mkdtemp('D:/Artifacts/ProgressiveReading/guide-resume-fixture-');
 const previousRoot=process.env.PR_GUIDE_RESPONSE_CACHE_DIR,previousFetch=globalThis.fetch;
 let calls=0;process.env.PR_GUIDE_RESPONSE_CACHE_DIR=root;
 const raw=JSON.stringify({judgments:{continue_reading:{level:3,reason:'检验恢复'}},insights:[],translation:{is_bilingual:false,alignments:[]}});
 globalThis.fetch=async()=>{if(++calls===1)throw Error('fixture_transport_interrupted');return {ok:true,json:async()=>({choices:[{message:{content:raw}}]})};};
 const config={AI_PRODUCER_BASE_URL:'https://example.invalid',AI_PRODUCER_MODEL:'fixture',DEEPSEEK_READING_API_KEY:'synthetic-only',AI_PRODUCER_MAX_RETRIES:0};
 const payload={cleaning_policy:{mode:'semantic_only',include_reading_guide:true},blocks:[],source_metadata:{},insight_policy:{}};
 try{
  const producer=new ExternalProducer(config);
  await assert.rejects(producer.generate(payload,{singleAttempt:true}),/fixture_transport_interrupted/);
  const inputName=(await fs.readdir(root)).find(n=>n.endsWith('.input.json'));
  const before=await fs.readFile(root+'/'+inputName,'utf8');
  const resumed=await producer.generate(payload,{singleAttempt:true});
  const replay=await producer.generate(payload,{singleAttempt:true});
  assert.equal(calls,2);assert.equal(replay.api_calls,0);assert.deepEqual(resumed.output,replay.output);
  assert.equal(await fs.readFile(root+'/'+inputName,'utf8'),before);
 }finally{globalThis.fetch=previousFetch;if(previousRoot===undefined)delete process.env.PR_GUIDE_RESPONSE_CACHE_DIR;else process.env.PR_GUIDE_RESPONSE_CACHE_DIR=previousRoot;}
});

test('interrupted guide recovery refuses a changed frozen request',async()=>{
 const root=await fs.mkdtemp('D:/Artifacts/ProgressiveReading/guide-conflict-fixture-');
 const previousRoot=process.env.PR_GUIDE_RESPONSE_CACHE_DIR,previousFetch=globalThis.fetch;
 let calls=0;process.env.PR_GUIDE_RESPONSE_CACHE_DIR=root;
 globalThis.fetch=async()=>{calls++;throw Error('fixture_transport_interrupted');};
 const config={AI_PRODUCER_BASE_URL:'https://example.invalid',AI_PRODUCER_MODEL:'fixture',DEEPSEEK_READING_API_KEY:'synthetic-only',AI_PRODUCER_MAX_RETRIES:0};
 const payload={cleaning_policy:{mode:'semantic_only',include_reading_guide:true},blocks:[],source_metadata:{},insight_policy:{}};
 try{
  const producer=new ExternalProducer(config);
  await assert.rejects(producer.generate(payload,{singleAttempt:true}),/fixture_transport_interrupted/);
  const inputName=(await fs.readdir(root)).find(n=>n.endsWith('.input.json'));
  await fs.appendFile(root+'/'+inputName,'changed');
  await assert.rejects(producer.generate(payload,{singleAttempt:true}),/producer_frozen_guide_input_changed/);
  assert.equal(calls,1);
 }finally{globalThis.fetch=previousFetch;if(previousRoot===undefined)delete process.env.PR_GUIDE_RESPONSE_CACHE_DIR;else process.env.PR_GUIDE_RESPONSE_CACHE_DIR=previousRoot;}
});
