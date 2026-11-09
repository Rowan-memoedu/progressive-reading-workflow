import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { callCodexText, CODEX_TRANSPORT_VERSION } from '../lib/codex-exec.mjs';
import { producerBackend, producerModel, requestProducerText, loadProducerConfig } from '../lib/producer.mjs';
import { fullTextBodyContext } from '../lib/full-text-body.mjs';
import path from 'node:path';

test('default selects Codex independently of inherited DeepSeek model; explicit API configs stay compatible', async () => {
  const previous = process.env.AI_PRODUCER_PROVIDER;
  delete process.env.AI_PRODUCER_PROVIDER;
  try {
    const config = await loadProducerConfig();
    assert.equal(producerBackend(config), 'codex_exec');
    assert.equal(config.AI_PRODUCER_CODEX_MODEL, 'gpt-6.1-sol');
    assert.equal(producerModel({ ...config, AI_PRODUCER_CODEX_MODEL: '', AI_PRODUCER_MODEL: 'deepseek-fixture' }), 'gpt-6.1-sol');
    assert.equal(producerModel({ ...config, AI_PRODUCER_CODEX_MODEL: 'explicit-model' }), 'explicit-model');
    process.env.AI_PRODUCER_PROVIDER = 'deepseek';
    assert.equal(producerBackend(await loadProducerConfig()), 'deepseek');
    process.env.AI_PRODUCER_PROVIDER = 'typo';
    await assert.rejects(loadProducerConfig(), /unknown_producer_provider/);
    assert.equal(producerBackend({ AI_PRODUCER_BASE_URL: 'https://example.invalid' }), 'deepseek');
  } finally {
    if (previous === undefined) delete process.env.AI_PRODUCER_PROVIDER; else process.env.AI_PRODUCER_PROVIDER = previous;
  }
});

test('Codex receives source as stdin, reads final file, maps usage, and cleans only its temporary call directory', async () => {
  let run;
  const source = '中文 $() `danger` "quoted"\n第二行';
  const fakeSpawn = (executable, args, options) => {
    run = options.cwd;
    assert.equal(executable, 'fixture.exe');
    assert.ok(!args.some(value => value.includes(source)));
    assert.ok(args.includes('read-only'));
    assert.ok(args.includes('--ignore-user-config'));
    for(const setting of ['features.apps=false','features.skill_search=false','features.skip_host_skill_discovery=true'])assert.ok(args.includes(setting));
    assert.ok(!args.includes('--output-schema'));
    assert.equal(args[args.indexOf('-m') + 1], 'gpt-6.1-sol');
    const child = new EventEmitter();
    child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.stdin = new EventEmitter();
    child.stdin.end = async prompt => {
      assert.ok(prompt.includes(source));
      assert.equal(prompt, source);
      const setting=args.find(value=>value.startsWith('model_instructions_file='));
      const instructions=await fs.readFile(JSON.parse(setting.slice(setting.indexOf('=')+1)), 'utf8');
      assert.ok(instructions.endsWith('JSON only'));
      assert.ok(!instructions.includes(source));
      assert.ok(args.includes('project_doc_max_bytes=0'));
      await fs.writeFile(args[args.indexOf('-o') + 1], '{"ok":true}');
      child.stdout.emit('data', JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 3, output_tokens: 2 } }) + '\n');
      child.emit('close', 0);
    };
    return child;
  };
  const raw = await callCodexText({ AI_PRODUCER_CODEX_BIN: 'fixture.exe' }, { system: 'JSON only', user: source }, fakeSpawn);
  assert.equal(raw.choices[0].message.content, '{"ok":true}');
  assert.equal(raw.usage.total_tokens, 5);
  assert.equal(raw.transport.version,CODEX_TRANSPORT_VERSION);
  assert.equal(raw.transport.max_output_tokens_applied,false);
  assert.equal(raw.transport.thinking_applied,false);
  await assert.rejects(fs.access(run));
});

test('Codex optional output schema is frozen in the call directory and recorded in receipt',async()=>{
 const schema={type:'object',properties:{index:{type:'integer',enum:[1,2]}},required:['index'],additionalProperties:false};
 let run;
 const fakeSpawn=(_executable,args,options)=>{
  run=options.cwd;const schemaFile=args[args.indexOf('--output-schema')+1];assert.equal(path.dirname(schemaFile),run);
  const child=new EventEmitter();child.stdout=new EventEmitter();child.stderr=new EventEmitter();child.stdin=new EventEmitter();
  child.stdin.end=async prompt=>{
   assert.equal(prompt,'choose');assert.deepEqual(JSON.parse(await fs.readFile(schemaFile,'utf8')),schema);
   await fs.writeFile(args[args.indexOf('-o')+1],'{"index":1}');
   child.stdout.emit('data',JSON.stringify({type:'turn.completed'})+'\n');child.emit('close',0);
  };return child;
 };
 const result=await callCodexText({AI_PRODUCER_CODEX_BIN:'fixture.exe'},{system:'JSON',user:'choose',outputSchema:schema},fakeSpawn);
 assert.match(result.transport.output_schema_sha256,/^[0-9a-f]{64}$/);await assert.rejects(fs.access(run));
});

test('DeepSeek text transport retains dedicated credentials and does not use Codex', async () => {
  const previous = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    assert.equal(url, 'https://example.invalid/v1/chat/completions');
    assert.equal(options.headers.Authorization, 'Bearer synthetic-reading-key');
    assert.equal(JSON.parse(options.body).model, 'deepseek-fixture');
    return { ok: true, json: async () => ({ choices: [{ message: { content: '正文' } }] }) };
  };
  try {
    const raw = await requestProducerText({ AI_PRODUCER_PROVIDER: 'deepseek', AI_PRODUCER_BASE_URL: 'https://example.invalid/v1',
      AI_PRODUCER_MODEL: 'deepseek-fixture', DEEPSEEK_READING_API_KEY: 'synthetic-reading-key' }, { system: '保真', user: '来源' });
    assert.equal(raw.choices[0].message.content, '正文');
  } finally { globalThis.fetch = previous; }
});

test('whole-text raw response cache separates backends and models', async () => {
  const input = { markdown: '同一来源', mode: 'spoken_to_written' };
  const first = await fullTextBodyContext({ ...input, producerIdentity: ['deepseek', 'api.example.invalid', 'model-a'] });
  const second = await fullTextBodyContext({ ...input, producerIdentity: ['codex_exec', 'codex_exec', 'codex-default'] });
  const third = await fullTextBodyContext({ ...input, producerIdentity: ['codex_exec', 'codex_exec', 'model-b'] });
  assert.notEqual(first.target, second.target); assert.notEqual(second.target, third.target);
});

test('CLI exposes backend selection and rejects an invalid backend before any production', () => {
  const cli = fileURLToPath(new URL('../cli.mjs', import.meta.url));
  const help = spawnSync(process.execPath, [cli, '--help'], { encoding: 'utf8', windowsHide: true });
  assert.equal(help.status, 0);
  assert.ok(help.stdout.includes('--provider'));
  const invalid = spawnSync(process.execPath, [cli, '--json', '--provider', 'typo', 'doctor'], { encoding: 'utf8', windowsHide: true });
  assert.notEqual(invalid.status, 0);
  assert.equal(JSON.parse(invalid.stdout).error.code, 'invalid_provider');
});

test('Codex receives actual local image arguments, rejects missing visual input and never invokes fetch',async()=>{
  const root=await fs.mkdtemp('D:/Artifacts/ProgressiveReading/codex-image-route-');
  const image=path.join(root,'board.png');await fs.writeFile(image,Buffer.from([1,2,3]));
  const previous=globalThis.fetch;let calls=0;
  globalThis.fetch=async()=>{throw Error('api_must_not_be_used');};
  const fakeSpawn=(executable,args)=>{
    calls++;
    const attached=args.filter((arg,index)=>args[index-1]==='--image');
    assert.equal(attached.length,1);assert.notEqual(attached[0],image);
    const child=new EventEmitter();child.stdout=new EventEmitter();child.stderr=new EventEmitter();child.stdin=new EventEmitter();
    child.stdin.end=async prompt=>{
      assert.equal(prompt,'文字不含图中答案');
      const setting=args.find(value=>value.startsWith('model_instructions_file='));
      assert.match(await fs.readFile(JSON.parse(setting.slice(setting.indexOf('=')+1)),'utf8'),/实际图片/u);
      assert.deepEqual(await fs.readFile(attached[0]),await fs.readFile(image));
      await fs.writeFile(args[args.indexOf('-o')+1],'image understood');
      child.stdout.emit('data',JSON.stringify({type:'turn.completed'})+'\n');
      child.emit('close',0);
    };
    return child;
  };
  try{
    const raw=await callCodexText({AI_PRODUCER_CODEX_BIN:'fixture.exe'},
      {system:'核对实际板书',user:'文字不含图中答案',images:[{path:image}],requiresVisual:true},fakeSpawn);
    assert.equal(raw.provider,'codex_exec');assert.equal(raw.image_count,1);assert.equal(calls,1);
    await assert.rejects(callCodexText({},{user:'缺图',requiresVisual:true},fakeSpawn),/images_required/);
    await assert.rejects(callCodexText({},{user:'已变更',images:[{path:image,sha256:'0'.repeat(64)}]},fakeSpawn),/image_changed/);
    await assert.rejects(requestProducerText({AI_PRODUCER_PROVIDER:'deepseek'},{user:'禁止回退',images:[image]}),/images_require_codex/);
  }finally{globalThis.fetch=previous;}
});

test('explicit Codex requirement rejects an API override before credential checks or production',async()=>{
  const previous=process.env.AI_PRODUCER_PROVIDER;
  process.env.AI_PRODUCER_PROVIDER='deepseek';
  try{await assert.rejects(loadProducerConfig({requiredProvider:'codex_exec'}),/producer_requires_codex_exec/);}
  finally{if(previous===undefined)delete process.env.AI_PRODUCER_PROVIDER;else process.env.AI_PRODUCER_PROVIDER=previous;}
});

test('a failed Codex process never falls back to an API request',async()=>{
  const fakeSpawn=()=>{
    const child=new EventEmitter();child.stdout=new EventEmitter();child.stderr=new EventEmitter();child.stdin=new EventEmitter();
    child.stdin.end=()=>queueMicrotask(()=>child.emit('close',27));return child;
  };
  await assert.rejects(callCodexText({AI_PRODUCER_CODEX_BIN:'fixture.exe'},{user:'fixture'},fakeSpawn),/producer_codex_exit_27/);
});

test('a partial output file without a completed turn is never accepted as a complete response',async()=>{
  const fakeSpawn=(executable,args)=>{
    const child=new EventEmitter();child.stdout=new EventEmitter();child.stderr=new EventEmitter();child.stdin=new EventEmitter();
    child.stdin.end=async()=>{await fs.writeFile(args[args.indexOf('-o')+1],'partial');child.emit('close',0);};
    return child;
  };
  await assert.rejects(callCodexText({AI_PRODUCER_CODEX_BIN:'fixture.exe'},{user:'fixture'},fakeSpawn),/turn_not_completed/);
});

test('routing discovery timeout is classified before inference and never triggers an automatic resend',async()=>{
 let calls=0;
 const fakeSpawn=()=>{calls++;const child=new EventEmitter();child.stdout=new EventEmitter();child.stderr=new EventEmitter();child.stdin=new EventEmitter();
  child.stdin.end=()=>queueMicrotask(()=>{child.stdout.emit('data',JSON.stringify({type:'turn.failed',error:{message:'workspace routing discovery timed out'}})+'\n');child.emit('close',1);});return child;};
 let failure;
 await assert.rejects(callCodexText({AI_PRODUCER_CODEX_BIN:'fixture.exe'},{user:'routing regression'},fakeSpawn),e=>{failure=e;return e.message==='producer_codex_routing_timeout';});
 assert.equal(calls,1);const report=JSON.parse(await fs.readFile(failure.diagnostics_path,'utf8'));
 assert.equal(report.phase,'workspace_routing');assert.equal(report.user_payload_sha256.length,64);
});

test('Codex transient errors require a completed turn; terminal failures remain rejected',async()=>{
 const fakeSpawn=events=>(executable,args)=>{
  const child=new EventEmitter();child.stdout=new EventEmitter();child.stderr=new EventEmitter();child.stdin=new EventEmitter();
  child.stdin.end=async()=>{await fs.writeFile(args[args.indexOf('-o')+1],'complete');for(const event of events)child.stdout.emit('data',JSON.stringify(event)+'\n');child.emit('close',0);};
  return child;
 };
 const config={AI_PRODUCER_CODEX_BIN:'fixture.exe'},input={user:'fixture'};
 const completed=await callCodexText(config,input,fakeSpawn([{type:'error',message:'Reconnecting'},{type:'turn.completed'}]));
 assert.equal(completed.choices[0].message.content,'complete');assert.equal(completed.transport.recovered_error_events,1);
 const startup=await callCodexText(config,input,fakeSpawn([{type:'item.completed',item:{type:'error',message:'optional connector unavailable'}},{type:'turn.completed'}]));
 assert.equal(startup.transport.diagnostic_item_events,1);
 await assert.rejects(callCodexText(config,input,fakeSpawn([{type:'item.completed',item:{type:'command_execution'}},{type:'turn.completed'}])),/unexpected_tool/);
 await assert.rejects(callCodexText(config,input,fakeSpawn([{type:'error'}])),error=>error.message==='producer_codex_turn_failed'&&error.terminal===true);
 await assert.rejects(callCodexText(config,input,fakeSpawn([{type:'turn.failed'},{type:'turn.completed'}])),/producer_codex_turn_failed/);
});

test('failed Codex transport retains bounded redacted diagnostics without accepting partial output',async()=>{
 const root=await fs.mkdtemp('D:/Artifacts/ProgressiveReading/codex-diagnostic-fixture-');
 const fakeSpawn=()=>{
  const child=new EventEmitter();child.stdout=new EventEmitter();child.stderr=new EventEmitter();child.stdin=new EventEmitter();
  child.stdin.end=()=>queueMicrotask(()=>{
   child.stdout.emit('data',JSON.stringify({type:'turn.failed',error:{message:'Connection failed to "https://example.invalid/private"'}})+'\n');
   child.stderr.emit('data','request failed Authorization=fixture-secret');child.emit('close',1);
  });return child;
 };
 let captured;
 await assert.rejects(callCodexText({AI_PRODUCER_CODEX_BIN:'fixture.exe',AI_PRODUCER_CODEX_WORK_DIR:root},{user:'fixture'},fakeSpawn),error=>{captured=error;return error.message==='producer_codex_exit_1'&&error.terminal;});
 const record=await fs.readFile(captured.diagnostics_path,'utf8');
 assert.match(record,/Connection failed/);assert.ok(!record.includes('fixture-secret'));assert.ok(!record.includes('example.invalid/private'));
});
