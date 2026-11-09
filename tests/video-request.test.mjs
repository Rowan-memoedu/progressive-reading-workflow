import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { normalizeVideoRequest, runVideoRequest } from '../subscription-workflow/video-request.mjs';
import { enqueueVideoRequest, enqueue } from '../subscription-workflow/service.mjs';
import { paths, readJson, writeJson } from '../subscription-workflow/config.mjs';

const artifact='D:/Artifacts/ProgressiveReading/video-request-tests';
const url='https://www.bilibili.com/video/BV1234567890/';
async function fixture(){
  await fs.mkdir(artifact,{recursive:true});
  const root=await fs.mkdtemp(path.join(artifact,'case-'));
  await writeJson(path.join(root,'imports','subscriptions','active.json'),{home:path.join(root,'home')});
  return root;
}
const view={bvid:'BV1234567890',title:'合成数学课程',pages:[
  {page:1,cid:101,part:'甲',duration:10},{page:2,cid:102,part:'乙',duration:20},{page:3,cid:103,part:'丙',duration:30}
]};
const stepper=(saved={})=>async(name,action)=>{
  if(saved[name]?.done)return saved[name].result;
  const result=await action();saved[name]={done:true,result};return result;
};

test('one-off ranges are canonical, bounded and cannot target outside reading storage',async()=>{
  const root=await fixture();
  assert.deepEqual(normalizeVideoRequest(root,{url:url+'?p=3&spm_id_from=fixture',parts:[3,1,3]}).parts,[1,3]);
  assert.deepEqual(normalizeVideoRequest(root,{url:url+'?p=2'}).parts,[2]);
  assert.throws(()=>normalizeVideoRequest(root,{url,parts:[0]}));
  assert.throws(()=>normalizeVideoRequest(root,{url,parts:[1.1]}));
  assert.throws(()=>normalizeVideoRequest(root,{url,destination:'../../outside'}));
  assert.throws(()=>normalizeVideoRequest(root,{url,destination:root}));
});

test('selected parts remain independent, a failure does not expand or stop the batch, and resume reuses results',async()=>{
  const root=await fixture(), saved={}, called=[];
  const settings={api:async()=>view,existing:async()=>new Map(),processItem:async item=>{
    called.push(item.part);if(item.part===1)throw new Error('needs_board_correction');
    return {status:'completed',publication:item.publish_path};
  }};
  const input={url,parts:[1,3]}, result=await runVideoRequest(root,input,stepper(saved),settings);
  assert.deepEqual(called,[1,3]);assert.equal(result.status,'completed_with_issues');
  assert.deepEqual(result.faults.map(item=>item.part),[1]);
  assert.equal(result.results[1].status,'completed');
  await runVideoRequest(root,input,stepper(saved),settings);assert.deepEqual(called,[1,3]);
});

test('an existing publication is verified without regeneration and a nonexistent part never starts processing',async()=>{
  const root=await fixture();let calls=0;
  const settings={api:async()=>view,existing:async()=>new Map([[url+'?p=2','existing.md']]),processItem:async item=>{
    calls++;assert.equal(item.resume_mode,'verification_only');assert.equal(item.publish_path,'existing.md');
    return {status:'completed',publication:item.publish_path};
  }};
  const result=await runVideoRequest(root,{url,parts:[2]},stepper(),settings);
  assert.equal(result.results[0].reused,true);assert.equal(calls,1);
  await assert.rejects(runVideoRequest(root,{url,parts:[4]},stepper(),settings),/没有 P4/u);
  assert.equal(calls,1);
});

test('durable one-off enqueue is idempotent and explicit retries preserve successful parts',async()=>{
  const root=await fixture(), input={url,parts:[1,3]};
  const first=await enqueueVideoRequest(root,input), replay=await enqueueVideoRequest(root,{...input,parts:[3,1]});
  assert.equal(first.id,replay.id);
  const file=path.join(paths(root).jobs,first.id+'.json');
  let job=await readJson(file);assert.deepEqual(job.request.parts,[1,3]);assert.equal(job.status,'queued');
  job.status='completed_with_issues';job.steps={'video-parts':{done:true,result:[]},'video-P1':{done:true,result:{status:'blocked'}},'video-P3':{done:true,result:{status:'completed'}}};
  await writeJson(file,job);
  assert.equal((await enqueueVideoRequest(root,input)).status,'completed_with_issues');
  job=await enqueueVideoRequest(root,input,{retry:true});
  assert.equal(job.status,'queued');assert.equal(job.steps['video-P1'],undefined);assert.equal(job.steps['video-P3'].done,true);
  await assert.rejects(enqueue(root,'video_import'),/精确分 P/u);
  assert.equal(await fs.stat(path.join(root,'watchlist.json')).then(()=>true,()=>false),false);
  assert.equal(paths(root).jobs,path.join(root,'home','jobs'));
});

test('an incomplete saved part list cannot report an empty successful import',async()=>{
  const root=await fixture();
  await assert.rejects(runVideoRequest(root,{url,parts:[1]},stepper({'video-parts':{done:true,result:[]}}),{
    existing:async()=>{throw new Error('must not run');}
  }),/分 P 清单/u);
});

test('an entirely blocked batch is labelled blocked and exposes stage progress',async()=>{
  const root=await fixture(),progress=[];
  const result=await runVideoRequest(root,{url,parts:[1]},stepper(),{api:async()=>view,existing:async()=>new Map(),
    processItem:async(item,watch,{onProgress})=>{await onProgress({stage:'extract_and_independently_review'});throw Error('source evidence missing');},
    onProgress:async event=>progress.push(event)});
  assert.equal(result.status,'blocked');assert.deepEqual(progress,[{part:1,stage:'extract_and_independently_review'}]);
});
