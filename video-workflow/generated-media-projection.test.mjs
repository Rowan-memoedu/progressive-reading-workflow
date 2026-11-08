import test from 'node:test';
import assert from 'node:assert/strict';
import {projectGeneratedMedia,withCachedMediaRestoration,refineAndProjectGeneratedMedia} from './generated-media-projection.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {splitOutlineSubtrees} from '../standard-preprocessing/lib/outline-blocks.mjs';
const prose='# 植物观察\n- 温度\n  - 先检查温度计\n  - 记录读数\n- 湿度\n  - 观察水分变化\n';
const media=[{literal:'![温度计](images/instrument.png)'},{literal:'```mermaid\nflowchart LR\nA["观察"]-->B["记录"]\n```'}];
test('media insertion is exact, once per item, and preserves every prose byte and separate topics',()=>{
  const merged=projectGeneratedMedia(prose,media,{items:[{media_id:0,target_line:3,exact_line:'  - 先检查温度计'},
    {media_id:1,target_line:6,exact_line:'  - 观察水分变化'}]});
  assert.equal(merged.prose_unchanged,true);assert.equal(merged.insertions.length,2);
  assert.equal(splitOutlineSubtrees(merged.markdown).length,3);
  let restored=merged.markdown;for(const insertion of [...merged.insertions].reverse())restored=restored.slice(0,insertion.output_offset)+restored.slice(insertion.output_offset+insertion.text.length);
  assert.equal(restored,prose);
});
test('duplicate identities, missing visuals and invented target lines cannot enter publication',()=>{
  assert.throws(()=>projectGeneratedMedia(prose,media,{items:[]}),/count/);
  const row={media_id:0,target_line:3,exact_line:'  - 先检查温度计'};
  assert.throws(()=>projectGeneratedMedia(prose,media,{items:[row,row]}),/identity/);
  assert.throws(()=>projectGeneratedMedia(prose,media,{items:[row,{media_id:1,target_line:5,exact_line:'不存在的文字'}]}),/exact/);
});
test('saved-media recovery preserves normal body stage input, provider and cache without retrying prose',async()=>{
  let bodyCalls=0,recoveries=0;
  const config={AI_PRODUCER_PROVIDER:'codex_exec'};
  const producer={config,async refineFullText(){bodyCalls++;throw Error('protected_nonimage_missing:diagram');},generate(){return this.config;}};
  const input={markdown:'source',mode:'strong_structuring',cacheDir:'D:/cache',outputDir:'D:/run'};
  const wrapped=withCachedMediaRestoration(producer,{generatedMedia:media,transcript:{segments:[]}},async request=>{
    recoveries++;assert.deepEqual(request,{...input,generatedMedia:media,transcript:{segments:[]},producerConfig:config,requireCachedResponse:true});
    return {markdown:prose};
  });
  assert.equal((await wrapped.refineFullText(input)).markdown,prose);
  assert.equal(wrapped.generate(),config);assert.equal(bodyCalls,1);assert.equal(recoveries,1);
});
test('valid bodies and failures outside missing strong-outline media do not enter recovery',async()=>{
  const context={generatedMedia:media,transcript:{segments:[]}};
  const recover=()=>assert.fail('unexpected media recovery');
  const result={markdown:prose};
  assert.equal(await withCachedMediaRestoration({refineFullText:async()=>result},context,recover).refineFullText({mode:'strong_structuring'}),result);
  for(const [mode,message]of [['spoken_to_written','protected_nonimage_missing'],['strong_structuring','body_response_incomplete']]){
    await assert.rejects(withCachedMediaRestoration({refineFullText:async()=>{throw Error(message);}},context,recover).refineFullText({mode}),new RegExp(message));
  }
});
test('cache-only recovery refuses a missing response before any model call',async()=>{
  const base='D:/Artifacts/ProgressiveReading/tests';await fs.mkdir(base,{recursive:true});
  const dir=await fs.mkdtemp(path.join(base,'cached-media-'));
  await assert.rejects(refineAndProjectGeneratedMedia({markdown:'独立测试材料',mode:'strong_structuring',cacheDir:dir,outputDir:dir,
    producerConfig:{AI_PRODUCER_PROVIDER:'codex_exec',AI_PRODUCER_CODEX_MODEL:'gpt-6-luna'},generatedMedia:media,transcript:{segments:[]},requireCachedResponse:true}),/requires_saved_body_response/);
  assert.deepEqual(await fs.readdir(dir),[]);
});
test('frozen line addresses use source bytes, reject changed sources and cannot target code',()=>{
  const plan={anchor_protocol:'frozen_line_address/v1',prose_sha256:createHash('sha256').update(prose).digest('hex'),
    items:[{media_id:0,target_line:3,exact_line:'模型复述的行不能写入正文'},{media_id:1,target_line:6}]};
  const result=projectGeneratedMedia(prose,media,plan);
  assert.equal(result.prose_unchanged,true);assert.doesNotMatch(result.markdown,/模型复述/);
  assert.throws(()=>projectGeneratedMedia(prose+'changed',media,plan),/source_changed/);
  assert.throws(()=>projectGeneratedMedia(prose,media,{...plan,items:[{media_id:0,target_line:1},{media_id:1,target_line:6}]}),/exact_source_line/);
});
