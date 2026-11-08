import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';

// Run the production preview function in isolation from the HTTP listener and
// real files. No fetch or API credentials are exposed to this context.
const source=await fs.readFile(new URL('./progressive-reading-app.mjs',import.meta.url),'utf8');
const start=source.indexOf('async function parseImportIntent('),end=source.indexOf('\nfunction importerInstruction(',start);
assert.ok(start>=0&&end>start);
function preview(overrides={}){
  return vm.runInNewContext(source.slice(start,end)+'\nparseImportIntent',{
    classifyUrl:()=> 'web',stripModelFences:v=>v,
    normalizeIntent:value=>value,
    fallbackIntent:(instruction,urls,error)=>({source:'local',instruction,urls,error}),
    loadUnifiedProducerConfig:()=>assert.fail('unexpected producer configuration'),
    requestProducerText:()=>assert.fail('unexpected model call'),...overrides
  });
}

test('empty import preview stays local without contacting any model',async()=>{
  assert.equal((await preview()({instruction:'',urls:['https://example.org/']})).source,'local');
});
test('instruction preview requires unified Codex Exec and preserves the original request',async()=>{
  let calls=0;const config={AI_PRODUCER_PROVIDER:'codex_exec'};
  const run=preview({loadUnifiedProducerConfig:async options=>{assert.equal(options.requiredProvider,'codex_exec');return config;},
    requestProducerText:async(actual,input)=>{calls++;assert.equal(actual,config);assert.ok(input.user.includes('不要导读，保留原文'));assert.ok(input.user.includes('https://example.org/'));
      return {choices:[{message:{content:JSON.stringify({processing:{generateReadingGuide:false}})}}]};}});
  const result=await run({instruction:'不要导读，保留原文',urls:['https://example.org/']});
  assert.equal(result.source,'codex_exec');assert.equal(result.processing.generateReadingGuide,false);assert.equal(calls,1);
});
test('API configuration is rejected before preview generation and uses local interpretation',async()=>{
  const run=preview({loadUnifiedProducerConfig:async()=>{throw Error('producer_requires_codex_exec');}});
  const result=await run({instruction:'强结构化',urls:[]});
  assert.equal(result.source,'local');assert.equal(result.error,'producer_requires_codex_exec');
});
test('Codex preview failure never falls back to another provider or repeats the call',async()=>{
  let calls=0;const run=preview({loadUnifiedProducerConfig:async()=>({AI_PRODUCER_PROVIDER:'codex_exec'}),
    requestProducerText:async()=>{calls++;throw Error('producer_codex_turn_failed');}});
  const result=await run({instruction:'只保留原文观点',urls:[]});
  assert.equal(result.source,'local');assert.equal(result.error,'producer_codex_turn_failed');assert.equal(calls,1);
});
