import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {reviewCapturedFrames} from './review-captured-frames.mjs';
import {runWatchedIllustrated,captureAndReview,WATCH_MODEL,watchJobDir} from './watch-illustrated.mjs';
import {prepareWatchSource,processWatchItem} from './watch-process.mjs';

const hash=value=>createHash('sha256').update(value).digest('hex');
const watch={workflow:'illustrated',media_policy:'generated_and_reviewed',body_mode:'strong_structuring',provider:'codex_exec',model:WATCH_MODEL};
const config={AI_PRODUCER_PROVIDER:'codex_exec',AI_PRODUCER_CODEX_MODEL:WATCH_MODEL};
const makeRoot=()=>fs.mkdtemp('D:/Artifacts/ProgressiveReading/watch-illustrated-test-');
async function fixture(){
  const root=await makeRoot(),candidate=path.join(root,'frame-candidates','a.png');
  await fs.mkdir(path.dirname(candidate));await fs.writeFile(candidate,'test pixels');
  const frame={file:'shot_00_00_03.png',title:'传感器校准结果',scene:'static',expected_visual:'校准界面显示完成',
    candidates:[{path:candidate,time:'00:00:03',sha256:hash('test pixels')}]};
  const requestFile=path.join(root,'request.json'),reviewFile=path.join(root,'review.json'),outputDir=path.join(root,'review');
  await fs.writeFile(requestFile,JSON.stringify({version:'video-frame-review-request/v1',frames:[frame]}));
  return {root,requestFile,reviewFile,outputDir,candidate,config};
}
const response=(content,images)=>({provider:'codex_exec',model:WATCH_MODEL,image_count:images.length,
  transport:{completed_event:true},choices:[{finish_reason:'stop',message:{content:JSON.stringify(content)}}]});

test('visual review receives actual images, records observations and never repeats saved requests',async()=>{
  const f=await fixture();let calls=0;
  const request=async(_,{images,requiresVisual,user})=>{
    calls++;assert.equal(requiresVisual,true);assert.equal(images[0].path,f.candidate);
    assert.doesNotMatch(user,/D:\\|D:\//u);
    return response({selected_candidate:0,matches_expected:true,observed:'仪器窗口显示校准完成和测量结果。'},images);
  };
  const first=await reviewCapturedFrames({...f,request}),second=await reviewCapturedFrames({...f,request});
  assert.equal(first.status,'passed');assert.equal(first.actual_image_inputs,1);assert.equal(second.calls_this_run,0);assert.equal(calls,1);
  const saved=JSON.parse(await fs.readFile(f.reviewFile,'utf8'));
  assert.equal(saved.frames[0].sha256,hash('test pixels'));assert.equal(saved.frames[0].selected_time,'00:00:03');
  await fs.writeFile(f.candidate,'changed');
  await assert.rejects(reviewCapturedFrames({...f,request}),/candidate_changed/);
});
test('bad or uncertain visuals cannot be admitted; invalid selections and unknown outcomes cannot trigger retries',async()=>{
  const f=await fixture();
  const blocked=await reviewCapturedFrames({...f,request:async(_,{images})=>response({matches_expected:false,selected_candidate:null,observed:'只有空白输入框，没有校准完成结果。'},images)});
  assert.equal(blocked.status,'needs_frame_review');
  const bad=await fixture();
  await assert.rejects(reviewCapturedFrames({...bad,request:async(_,{images})=>response({matches_expected:true,selected_candidate:7,observed:'窗口显示校准结果。'},images)}),/selection_invalid/);
  const unknown=await fixture();let calls=0;
  const request=async()=>{calls++;throw Error('interrupted');};
  await assert.rejects(reviewCapturedFrames({...unknown,request}),/interrupted/);
  await assert.rejects(reviewCapturedFrames({...unknown,request}),/EEXIST/);assert.equal(calls,1);
});
test('publication requires timestamp and image integrity, without semantic model review',async()=>{
  const root=await makeRoot();let captures=0;
  const command=async(_,args)=>{
    captures++;assert.equal(args[args.indexOf('--frame-policy')+1],'timestamp_integrity');
    await fs.writeFile(root+'/capture-receipt.json',JSON.stringify({status:'completed',
      frame_review:{status:'passed',policy:'timestamp_integrity',semantic_alignment:'not_required'}}));
  };
  await captureAndReview({inputDir:root,outputDir:root,cookiesFile:'fake',command});
  assert.equal(captures,1);
  await assert.rejects(captureAndReview({inputDir:root,outputDir:root,cookiesFile:'fake',command:async()=>{
    await fs.writeFile(root+'/capture-receipt.json',JSON.stringify({status:'failed'}));
  }}),/timestamp_integrity_not_passed/);
});
test('scheduler calls the shared illustrated entry with unchanged prompt and one pinned Codex route',async()=>{
  const root=await makeRoot();await fs.writeFile(root+'/transcript.json','{}');let calls=0,captures=0;
  const before=process.env.AI_PRODUCER_CODEX_MODEL;
  const receipt=await runWatchedIllustrated({item:{key:'test:2',url:'https://www.bilibili.com/video/BV1234567890/?p=2',publish_path:root+'/reading.md'},
    watch,sourceDir:root,runDir:root+'/run',processingOptions:{structure_body:true},cookies:async(url,action)=>{assert.match(url,/p=2$/);return action('credential');},
    importFlow:async args=>{calls++;assert.equal(args.cookiesFile,'credential');assert.equal(args.processingOptions.structure_body,true);
      assert.equal(process.env.AI_PRODUCER_PROVIDER,'codex_exec');assert.equal(process.env.AI_PRODUCER_CODEX_MODEL,WATCH_MODEL);
      assert.ok(Number(process.env.AI_PRODUCER_TIMEOUT_MS)>0);
      await args.captureFrames();return{status:'completed'};},capture:async()=>{captures++;}});
  assert.equal(receipt.status,'completed');assert.equal(calls,1);assert.equal(captures,1);assert.equal(process.env.AI_PRODUCER_CODEX_MODEL,before);
  const identity=JSON.parse(await fs.readFile(root+'/run/watch-pipeline.json','utf8'));
  assert.equal(identity.entry,'importIllustratedStrong');
  assert.equal(identity.body_prompt_sha256,hash(await fs.readFile(new URL('../standard-preprocessing/prompts/强结构化整理.md',import.meta.url))));
});
test('a prebuilt book is never selected for illustrated automation and exact cid is mandatory',async()=>{
  const root=await makeRoot(),item={bvid:'BV1234567890',cid:42,url:'https://www.bilibili.com/video/BV1234567890/'};
  const source=root+'/'+item.bvid+'-cid42/source';await fs.mkdir(source,{recursive:true});
  await fs.writeFile(source+'/source.json',JSON.stringify({subtitle_file:'transcript.json',canonical_url:item.url,cid:42}));
  await fs.writeFile(source+'/transcript.json',JSON.stringify({video_url:item.url,cid:42}));await fs.writeFile(source+'/book.md','wrong prebuilt book');
  let calls=0;
  const result=await prepareWatchSource(item,watch,root,async(actual,options,job)=>{calls++;assert.equal(options.public_packages,false);return{sourceDir:job+'/source'};});
  assert.equal(calls,1);assert.equal(result.jobDir,watchJobDir(root,item));
  assert.equal(await fs.stat(result.sourceDir+'/book.md').then(()=>true,()=>false),false);
  await fs.writeFile(result.sourceDir+'/transcript.json',JSON.stringify({video_url:item.url,cid:43}));
  await assert.rejects(prepareWatchSource(item,watch,root,async()=>({})),/identity_mismatch/);
});
test('old existing-media configuration and incomplete illustrated output cannot complete',async()=>{
  await assert.rejects(processWatchItem({}, {...watch,media_policy:'existing'}),/explicit_illustrated/);
  const root=await makeRoot(),item={bvid:'BVabcdefghij',cid:10,url:'https://www.bilibili.com/video/BVabcdefghij/',publish_path:root+'/reading.md'};
  const acquire=async(i,w,job)=>{
    const sourceDir=job+'/source';await fs.mkdir(sourceDir,{recursive:true});
    await fs.writeFile(sourceDir+'/source.json',JSON.stringify({cid:i.cid,canonical_url:i.url}));
    await fs.writeFile(sourceDir+'/transcript.json',JSON.stringify({cid:i.cid,video_url:i.url}));return{sourceDir};
  };
  await assert.rejects(processWatchItem(item,watch,{artifactRoot:root,acquire,command:async()=>{},runFlow:async()=>({status:'needs_board_correction'})}),/needs_board_correction/);
  await assert.rejects(processWatchItem(item,watch,{artifactRoot:root,acquire,command:async()=>{},runFlow:async()=>({status:'completed',output_type:'illustrated',
    model_route:{provider:'codex_exec',model:WATCH_MODEL},body_prompt_unchanged:true,counts:{images:0,mermaid:0}})}),/unexpected_video_watch_workflow/);
  const waiting=await processWatchItem(item,watch,{artifactRoot:root,acquire,command:async()=>{},runFlow:async()=>{throw Error('target_login_snapshot_unavailable');}});
  assert.equal(waiting.status,'waiting_source');
});
test('shared prompt parity tolerates Windows line endings but rejects changed rules',async()=>{
  const {sameStrongPrompt}=await import('./watch-illustrated.mjs');
  assert.equal(sameStrongPrompt('rule A\r\nrule B\r\n','rule A\nrule B\n'),true);
  assert.equal(sameStrongPrompt('rule A\n','changed rule\n'),false);
});
