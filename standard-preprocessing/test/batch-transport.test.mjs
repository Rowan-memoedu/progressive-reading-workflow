import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import fs from 'node:fs/promises';
import {callCodexText} from '../lib/codex-exec.mjs';
import {loadBatchProducerConfig, loadProducerConfig} from '../lib/producer.mjs';

function fakeCall(content, extraEvents=[]) {
  return (_executable,args) => {
    const child=new EventEmitter();
    child.stdout=new EventEmitter(); child.stderr=new EventEmitter(); child.stdin=new EventEmitter();
    child.stdin.end=async()=>{
      await fs.writeFile(args[args.indexOf('-o')+1],content);
      for(const event of [...extraEvents,{type:'turn.completed'}]) child.stdout.emit('data',JSON.stringify(event)+'\n');
      child.emit('close',0);
    };
    return child;
  };
}

test('batch routing leaves the explicitly configured software API route intact',async()=>{
  const old=process.env.AI_PRODUCER_PROVIDER;
  process.env.AI_PRODUCER_PROVIDER='deepseek';
  try {
    assert.equal((await loadBatchProducerConfig()).AI_PRODUCER_PROVIDER,'codex_exec');
    assert.equal((await loadProducerConfig()).AI_PRODUCER_PROVIDER,'deepseek');
    assert.equal(process.env.AI_PRODUCER_PROVIDER,'deepseek');
  } finally {if(old===undefined)delete process.env.AI_PRODUCER_PROVIDER;else process.env.AI_PRODUCER_PROVIDER=old;}
});

test('tool use cannot be accepted as a completed batch document',async()=>{
  await assert.rejects(callCodexText({AI_PRODUCER_CODEX_BIN:'fixture'}, {user:'data'},
    fakeCall('looks complete',[{type:'item.completed',item:{type:'command_execution'}}])),/unexpected_tool/);
});

test('only callers with an explicit empty-result contract may accept an empty document',async()=>{
  const config={AI_PRODUCER_CODEX_BIN:'fixture'};
  await assert.rejects(callCodexText(config,{user:'data'},fakeCall('')),/empty_response/);
  const raw=await callCodexText(config,{user:'data',allowEmpty:true},fakeCall(''));
  assert.equal(raw.choices[0].message.content,'');
  assert.equal(raw.transport.completed_event,true);
});
