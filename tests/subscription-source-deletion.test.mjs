import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import {SCHEMA,paths,normalizeSource,writeJson,loadConfig,deleteSource,saveSource} from '../subscription-workflow/config.mjs';
import {handleSubscriptions} from '../subscription-workflow/http.mjs';

async function fixture(){
  const artifact='D:/Artifacts/ProgressiveReading/subscription-source-deletion-tests';await fs.mkdir(artifact,{recursive:true});
  const root=await fs.mkdtemp(path.join(artifact,'case-')),home=path.join(root,'home');
  await writeJson(paths(root).marker,{home});
  const active=normalizeSource({kind:'rss',name:'Synthetic active feed',url:'https://active.test/feed',mode:'reports'});
  const disabled=normalizeSource({kind:'zhihu_column',name:'Synthetic disabled column',url:'https://www.zhihu.com/column/synthetic',mode:'reports',enabled:false});
  await writeJson(paths(root).config,{schema:SCHEMA,revision:1,enabled:true,rss_home:path.join(root,'rss-home'),subscriptions:[active,disabled]});
  const historical=path.join(root,'阅读区','existing.md');await fs.mkdir(path.dirname(historical),{recursive:true});await fs.writeFile(historical,'Synthetic body and user annotations.');
  return {root,active,disabled,historical};
}

test('delete permanently removes only a disabled subscription configuration',async()=>{
  const f=await fixture();
  const result=await deleteSource(f.root,f.disabled.id,{expectedRevision:1});
  assert.equal(result.revision,2);assert.deepEqual(result.subscriptions,[f.active]);
  assert.deepEqual((await loadConfig(f.root)).subscriptions,[f.active]);
  assert.equal(await fs.readFile(f.historical,'utf8'),'Synthetic body and user annotations.');
  await assert.rejects(deleteSource(f.root,f.disabled.id,{expectedRevision:2}),/不存在/);
});

test('active, stale, and unversioned deletes cannot remove subscriptions',async()=>{
  const f=await fixture();
  await assert.rejects(deleteSource(f.root,f.active.id,{expectedRevision:1}),/先停用/);
  await assert.rejects(deleteSource(f.root,f.disabled.id,{expectedRevision:0}),/另一处/);
  await assert.rejects(deleteSource(f.root,f.disabled.id),/另一处/);
  assert.equal((await loadConfig(f.root)).subscriptions.length,2);
  await saveSource(f.root,{id:f.disabled.id,enabled:true},{expectedRevision:1});
  await assert.rejects(deleteSource(f.root,f.disabled.id,{expectedRevision:1}),/另一处/);
  await assert.rejects(deleteSource(f.root,f.disabled.id,{expectedRevision:2}),/先停用/);
});

test('HTTP deletion enforces the same local origin, revision and disabled-state rules',async()=>{
  const f=await fixture(),server=http.createServer((req,res)=>void handleSubscriptions(req,res,f.root));
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const base='http://127.0.0.1:'+server.address().port;
  const post=(body,origin=base)=>fetch(base+'/api/subscriptions/source/delete',{method:'POST',headers:{'Content-Type':'application/json',Origin:origin},body:JSON.stringify(body)});
  try{
    assert.equal((await post({id:f.disabled.id,revision:1},'https://outside.test')).status,400);
    assert.equal((await post({id:f.active.id,revision:1})).status,400);
    const response=await post({id:f.disabled.id,revision:1});assert.equal(response.status,200);
    const config=await response.json();assert.equal(config.subscriptions.some(s=>s.id===f.disabled.id),false);
    assert.equal((await loadConfig(f.root)).subscriptions.length,1);
  }finally{await new Promise(resolve=>server.close(resolve));}
});
