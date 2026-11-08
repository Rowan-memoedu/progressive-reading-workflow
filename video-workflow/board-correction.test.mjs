import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {requiresBoardCorrection,prepareBoardCorrection} from './board-correction.mjs';
import {importIllustratedStrong,buildMediaBook} from './illustrated-strong.mjs';
const hash=v=>createHash('sha256').update(v).digest('hex');
const json=v=>JSON.stringify(v,null,2)+'\n';
const transcript={video_id:'fixture',title:'代数中的分式条件',video_url:'https://example.org/algebra',duration:100,
  segments:[{start:'00:00:00',end:'00:00:49',text:'正数u和v满足和为五，求乘积最大值。'},
    {start:'00:00:50',end:'00:01:40',text:'先找定值，再检查等号条件。'}]};
const plan={items:[
  {kind:'screenshot',time:'00:00:10',window_end:'00:00:12',scene:'static',title:'分式条件',expected_visual:'板书公式和条件',source_quote:'正数u和v满足和为五'},
  {kind:'screenshot',time:'00:00:50',window_end:'00:00:52',scene:'static',title:'等号条件',expected_visual:'板书取等条件',source_quote:'先找定值'},
  {kind:'mermaid',time:'00:00:50',title:'方法',source_quote:'先找定值',code:'flowchart TD\nA["定值"]-->B["取等"]'}]};

test('math mode is source-neutral and never implicitly enables illustrated mode',()=>{
  assert.equal(requiresBoardCorrection(transcript,plan),true);
  assert.equal(requiresBoardCorrection({...transcript,title:'软件安装演示'},plan),false);
  assert.equal(requiresBoardCorrection({...transcript,title:'无标题'},plan,{board_formula_correction:true}),true);
  assert.equal(requiresBoardCorrection({...transcript,title:'数论中的模与同余'},plan),true);
  assert.equal(requiresBoardCorrection({...transcript,title:'组合计数方法'},plan),true);
});

test('math lecture stops before body or guide while awaiting board evidence',async()=>{
  const base=await fs.mkdtemp('D:/Artifacts/ProgressiveReading/board-gate-canary-');
  const input=path.join(base,'source');await fs.mkdir(input);
  await fs.writeFile(path.join(input,'transcript.json'),json(transcript));
  let captures=0;
  const result=await importIllustratedStrong({inputDir:input,outputDir:path.join(base,'run'),publishPath:path.join(base,'reading.md'),
    planMedia:async()=>plan,captureFrames:async()=>{captures++;return {status:'needs_frame_review'};},
    refineBody:async()=>{throw Error('body_before_board_review');},producer:{generate(){throw Error('guide_before_board_review');}}});
  assert.equal(result.status,'needs_board_correction');assert.equal(result.body_calls,0);assert.equal(captures,1);
  assert.equal(await fs.stat(path.join(base,'reading.md')).then(()=>true,()=>false),false);
});

async function fixture(){
  const base=await fs.mkdtemp('D:/Artifacts/ProgressiveReading/board-ledger-canary-');
  const input=path.join(base,'source'),output=path.join(base,'run');
  await fs.mkdir(input);await fs.mkdir(path.join(output,'frame-candidates'),{recursive:true});
  const raw=json(transcript);await fs.writeFile(path.join(input,'transcript.json'),raw);
  const rows=[];
  for(const [index,time]of ['00:00:10','00:00:50'].entries()){
    const file='shot_'+time.replaceAll(':','_')+'.png',filePath=path.join(output,'frame-candidates',file),bytes=Buffer.from('immutable-frame-'+index);
    await fs.writeFile(filePath,bytes);
    rows.push({file,requested_time:time,window_end:time.replace(/10$/u,'12').replace(/50$/u,'52'),
      candidates:[{time,path:filePath,sha256:hash(bytes),actual_seconds:index?50:10,width:1000,height:600}]});
  }
  const request=json({version:'video-frame-review-request/v1',video_id:'fixture',source_sha256:hash(raw),frames:rows});
  await fs.writeFile(path.join(output,'frame-review-request.json'),request);
  const ledger={version:'video-board-correction/v1',accepted:true,unresolved:[],raw_transcript_sha256:hash(raw),frame_request_sha256:hash(request),
    frames:rows.map(row=>({file:row.file,use:true,status:'complete',observed:'实图可见变量、条件与取等步骤',title:'校订后的图示',selected_time:row.candidates[0].time,sha256:row.candidates[0].sha256})),
    patches:[{segment_index:0,before:transcript.segments[0].text,after:'正数u和v满足u+v=5，求乘积最大值。',evidence:[rows[0].file]}],
    formula_notes:[{after_segment_index:0,text:'条件为 $u+v=5$。',evidence:[rows[0].file]}]};
  return {inputDir:input,outputDir:output,transcript,plan,buildBook:buildMediaBook,ledger,raw};
}

test('independent source canary preserves raw captions/times and uses only hashed existing images',async()=>{
  const f=await fixture();await fs.writeFile(path.join(f.outputDir,'board-correction.json'),json(f.ledger));
  const result=await prepareBoardCorrection(f);
  assert.equal(await fs.readFile(path.join(f.inputDir,'transcript.json'),'utf8'),f.raw);
  assert.equal(result.transcript.segments.length,transcript.segments.length);
  assert.deepEqual(result.transcript.segments.map(s=>[s.start,s.end]),transcript.segments.map(s=>[s.start,s.end]));
  assert.match(result.transcript.segments[0].text,/u\+v=5/);
  assert.equal(result.receipt.new_capture_calls,0);
  const reviewed=JSON.parse(await fs.readFile(path.join(result.outputDir,'frame-review-request.json'),'utf8'));
  assert.equal(reviewed.frames.length,2);assert.equal(reviewed.board_correction_sha256,hash(json(f.ledger)));
});

test('stale source, incomplete review, mismatched source text and distant evidence fail closed',async()=>{
  for(const mutate of [
    l=>l.raw_transcript_sha256='0'.repeat(64),l=>l.frames.pop(),
    l=>l.patches[0].before='a different source',l=>l.patches[0].evidence=['not-a-captured-image'],
    l=>l.unresolved=['分母仍然不明']]){
    const f=await fixture();mutate(f.ledger);await fs.writeFile(path.join(f.outputDir,'board-correction.json'),json(f.ledger));
    await assert.rejects(prepareBoardCorrection(f),/board_/);
  }
});
test('a proposed source correction cannot invert a fraction explicitly present in its board formula notes',async()=>{
  const f=await fixture();f.ledger.patches[0].after='这个式子等于七分之三。';
  f.ledger.formula_notes[0].text='板书为 $\\frac{7}{3}$。';
  await fs.writeFile(path.join(f.outputDir,'board-correction.json'),json(f.ledger));
  await assert.rejects(prepareBoardCorrection(f),/board_patch_math_consistency_review_required/);
});

test('diagram corrections require real captured evidence, including when an empty list is supplied',async()=>{
  const f=await fixture();f.ledger.diagram_corrections=[{time:'00:00:50',before:plan.items[2].code,after:'flowchart TD\nA["定值"]',evidence:[]}];
  await fs.writeFile(path.join(f.outputDir,'board-correction.json'),json(f.ledger));
  await assert.rejects(prepareBoardCorrection(f),/board_diagram_correction_not_bound/);
});

test('corrected route publishes from existing images and replays without capture or a second body call',async()=>{
  const f=await fixture();await fs.writeFile(path.join(f.outputDir,'board-correction.json'),json(f.ledger));
  let calls=0;
  const args={inputDir:f.inputDir,outputDir:f.outputDir,publishPath:path.join(path.dirname(f.inputDir),'reading.md'),
    processingOptions:{include_reading_guide:false},planMedia:async()=>plan,
    captureFrames:async()=>{throw Error('must_reuse_existing_captures');},
    refineBody:async({markdown})=>{calls++;assert.match(markdown,/u\+v=5/);return {markdown:'# 定值与取等\n\n'+markdown,receipt:{api_calls_this_run:1}};},
    producer:{generate(){throw Error('guide_disabled');}}};
  const receipt=await importIllustratedStrong(args);
  assert.equal(calls,1);assert.equal(receipt.capture.new_capture_calls,0);
  assert.deepEqual(receipt.execution_order,['capture','board_formula_correction','strong_structuring','media_projection','reading_guide']);
  assert.equal(await fs.readFile(path.join(f.inputDir,'transcript.json'),'utf8'),f.raw);
  const final=await fs.readFile(receipt.publication.path,'utf8');assert.match(final,/images\/shot_00_00_10.png/);
  const replay=await importIllustratedStrong(args);assert.equal(replay.replayed,true);assert.equal(calls,1);
});

test('inverted generated explanation preserves the one response and blocks guide/publication',async()=>{
  const f=await fixture();f.ledger.formula_notes[0].text='测量的比例为 $\\frac u6$。';
  await fs.writeFile(path.join(f.outputDir,'board-correction.json'),json(f.ledger));
  let calls=0;
  const receipt=await importIllustratedStrong({inputDir:f.inputDir,outputDir:f.outputDir,
    publishPath:path.join(path.dirname(f.inputDir),'reading.md'),planMedia:async()=>plan,
    refineBody:async()=>{calls++;return {markdown:'# 比例\n- u分之六',receipt:{api_calls_this_run:1}};},
    producer:{generate(){throw Error('guide_must_not_run_on_formula_conflict');}}});
  assert.equal(receipt.status,'needs_formula_review');assert.equal(receipt.published,false);
  assert.equal(receipt.guide_calls,0);assert.equal(calls,1);
  assert.equal(await fs.stat(path.join(path.dirname(f.inputDir),'reading.md')).then(()=>true,()=>false),false);
});
