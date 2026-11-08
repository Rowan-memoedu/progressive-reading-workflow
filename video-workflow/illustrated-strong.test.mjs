import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {buildMediaBook,importIllustratedStrong} from './illustrated-strong.mjs';
import {bookPublicationPath} from './book-folder.mjs';

const transcript={video_id:'BV1234567890',video_url:'https://example.org/measurement',title:'独立实验流程',duration:100,
  segments:[{start:'00:00:00',end:'00:00:49',text:'实验开始前先校准温度传感器，阈值为 $T=20$。'},
    {start:'00:00:50',end:'00:01:40',text:'如果偏差过大就重新校准，否则开始记录。'}]};
const plan={items:[
  {kind:'screenshot',scene:'static',time:'00:00:10',window_end:'00:00:12',title:'校准界面',expected_visual:'可见温度传感器的校准界面',source_quote:'先校准温度传感器'},
  {kind:'mermaid',time:'00:00:50',title:'校准与采集流程',source_quote:'如果偏差过大就重新校准',code:'flowchart TD\nA["校准"] --> B["记录"]'}]};

test('media plan rejects invented evidence, invalid time, duplicate frames and executable diagrams',()=>{
  const valid=buildMediaBook(plan,transcript);
  assert.deepEqual(valid.counts,{images:1,mermaid:1});
  for(const patch of [{source_quote:'凭空增加的操作'},{time:'00:99:10'},{time:'00:02:00'}]){
    assert.throws(()=>buildMediaBook({items:[{...plan.items[0],...patch},plan.items[1]]},transcript));
  }
  assert.throws(()=>buildMediaBook({items:[...plan.items,plan.items[0]]},transcript),/duplicate/);
  assert.throws(()=>buildMediaBook({items:[plan.items[0],{...plan.items[1],code:'flowchart TD\nclick A "https://example.org"'}]},transcript),/unsafe/);
});

test('both branches run concurrently; publication preserves source visuals and does not refine a second time',async()=>{
  const root=await fs.mkdtemp('D:/Artifacts/ProgressiveReading/illustrated-fixture-');
  const input=path.join(root,'source');await fs.mkdir(input);
  await fs.writeFile(path.join(input,'transcript.json'),JSON.stringify(transcript));
  let captureStarted=false,bodyStarted=false,bodyCalls=0;
  let releaseCapture;const bodyReady=new Promise(resolve=>releaseCapture=resolve);
  const requested=path.join(root,'reading',transcript.video_id+'（完整图文强结构化）.md');
  const receipt=await importIllustratedStrong({inputDir:input,outputDir:path.join(root,'audit'),publishPath:requested,
    processingOptions:{include_reading_guide:false},
    producer:{generate(){throw Error('extra_model_call');}},planMedia:async()=>plan,
    captureFrames:async({book})=>{
      captureStarted=true;await bodyReady;assert.equal(bodyStarted,true);
      await fs.mkdir(path.join(input,'images'));await fs.writeFile(path.join(input,book.imagePaths[0]),Buffer.from([1,2,3]));
      await fs.writeFile(path.join(input,'book.md'),book.materialized);
      return {status:'completed',frames:1,frame_review:{status:'passed'}};
    },
    refineBody:async({markdown,mode})=>{
      assert.equal(captureStarted,true);bodyStarted=true;releaseCapture();bodyCalls++;
      assert.equal(mode,'strong_structuring');assert.match(markdown,/\$T=20\$/);
      // Independent producer fixture preserves source text and media literally.
      return {markdown:'# 实验记录\n\n'+markdown,receipt:{mode:'synthetic',api_calls_this_run:1}};
    }});
  assert.equal(bodyCalls,1);assert.deepEqual(receipt.counts,{images:1,mermaid:1});
  assert.equal(receipt.output_type,'illustrated');assert.equal(receipt.mode_name,'图文模式');
  const final=await fs.readFile(receipt.publication.path,'utf8');
  assert.match(final,/images\/shot_00_00_10.png/);assert.match(final,/flowchart TD/);assert.doesNotMatch(final,/SCREENSHOT:|附件列表/);
  assert.equal(receipt.publication.path,bookPublicationPath(requested,transcript));
  await fs.appendFile(receipt.publication.path,'\n用户笔记');
  await assert.rejects(importIllustratedStrong({inputDir:input,outputDir:path.join(root,'audit'),publishPath:requested}),/user_edits/);
});

test('awaiting actual-image review retains the body and publishes no reading file',async()=>{
  const root=await fs.mkdtemp('D:/Artifacts/ProgressiveReading/frame-review-fixture-');
  const input=path.join(root,'source');await fs.mkdir(input);await fs.writeFile(path.join(input,'transcript.json'),JSON.stringify(transcript));
  let bodyCalls=0;
  const result=await importIllustratedStrong({inputDir:input,outputDir:path.join(root,'audit'),publishPath:path.join(root,'reading.md'),
    producer:{generate(){throw Error('guide_must_wait');}},planMedia:async()=>plan,
    captureFrames:async()=>({status:'needs_frame_review',review_request:'fixture',review_file:'fixture'}),
    refineBody:async()=>{bodyCalls++;return {markdown:'saved body',receipt:{api_calls_this_run:1}};}});
  assert.equal(result.status,'needs_frame_review');assert.equal(result.published,false);assert.equal(result.guide_calls,0);
  assert.equal(bodyCalls,1);assert.equal(await fs.stat(bookPublicationPath(path.join(root,'reading.md'))).then(()=>true,()=>false),false);
});

test('a missing capture prevents publication while preserving the successful body branch',async()=>{
  const root=await fs.mkdtemp('D:/Artifacts/ProgressiveReading/illustrated-failure-');
  const input=path.join(root,'source');await fs.mkdir(input);await fs.writeFile(path.join(input,'transcript.json'),JSON.stringify(transcript));
  let bodyCompleted=false;
  await assert.rejects(importIllustratedStrong({inputDir:input,outputDir:path.join(root,'audit'),publishPath:path.join(root,'reading.md'),
    planMedia:async()=>plan,captureFrames:async()=>{throw Error('capture_fixture_failed');},
    refineBody:async()=>{bodyCompleted=true;return {markdown:'saved body',receipt:{api_calls_this_run:1}};}}),/capture_fixture_failed/);
  assert.equal(bodyCompleted,true);assert.equal(await fs.stat(bookPublicationPath(path.join(root,'reading.md'))).then(()=>true,()=>false),false);
});
