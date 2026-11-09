import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {automateBoardCorrection,bindDiagramReview} from './automate-board-correction.mjs';
import {runWatchedIllustrated,WATCH_MODEL} from './watch-illustrated.mjs';
import {prepareBoardCorrection} from './board-correction.mjs';
import {buildMediaBook} from './illustrated-strong.mjs';

const execute=promisify(execFile),json=value=>JSON.stringify(value,null,2)+'\n';
const hash=data=>createHash('sha256').update(data).digest('hex');
const config={AI_PRODUCER_PROVIDER:'codex_exec',AI_PRODUCER_CODEX_MODEL:'fixture-model'};
const python='D:/Caches/ProgressiveReading/videobook-python/Scripts/python.exe';
async function fixture(){
  const base=await fs.mkdtemp('D:/Artifacts/ProgressiveReading/automatic-board-test-');
  const sourceDir=base+'/source',runDir=base+'/run';
  await fs.mkdir(sourceDir);await fs.mkdir(runDir+'/frame-candidates',{recursive:true});
  const transcript={video_id:'fixture',title:'合成数学课',duration:100,segments:[
    {start:'00:00:00',end:'00:00:50',text:'正数的和等于五，求乘积最大值。'},
    {start:'00:00:50',end:'00:01:40',text:'检查取等条件。'}]};
  const bytes=json(transcript);await fs.writeFile(sourceDir+'/transcript.json',bytes);
  const image=runDir+'/frame-candidates/shot_00_00_10.png';await fs.writeFile(image,'synthetic-pixels');
  const request={version:'video-frame-review-request/v1',video_id:'fixture',source_sha256:hash(bytes),frames:[{
    file:'shot_00_00_10.png',requested_time:'00:00:10',window_end:'00:00:12',expected_visual:'合成条件',
    candidates:[{time:'00:00:10',actual_seconds:10,path:image,sha256:hash('synthetic-pixels')}]
  }]};
  await fs.writeFile(runDir+'/frame-review-request.json',json(request));
  await fs.writeFile(runDir+'/media-schedule.json',json({effective_plan:{items:[
    {kind:'screenshot',time:'00:00:10',window_end:'00:00:12',scene:'static',title:'合成题设',expected_visual:'合成条件',source_quote:'正数的和等于五'},
    {kind:'mermaid',time:'00:00:10',title:'合成方法',source_quote:'正数的和等于五',code:'flowchart TD\nA["定值"]-->B["取等"]'}]}}));
  return {sourceDir,runDir,config,pythonPath:python,transcript,bytes};
}
function models({fail=false,requireExtra=false}={}){
  let calls=0;
  return {get calls(){return calls;},runJobs:async({inputFile,promptFile,outputDir})=>{
    calls++;const jobs=(await fs.readFile(inputFile,'utf8')).trim().split('\n').map(JSON.parse);
    const records=jobs.map(job=>{
      const input=JSON.parse(job.input),id=input.images[0].image_id;
      const value={observations:input.images.map(image=>({image_id:image.image_id,status:'complete',observed:'合成图中显示正数之和等于五',title:'合成题设'})),
        patches:[],formula_notes:[{after_segment_index:0,text:'合成题设为 $u+v=5$。',evidence:[id]}],unresolved:[]};
      if(promptFile.endsWith('board-source-review.md')){
        const missing=fail||requireExtra&&input.images.length<2;
        value.review={verdict:missing?'needs_more_evidence':'pass',issues:missing?['合成证据缺失']:[]};
      }
      return {id:job.id,input:job,output:JSON.stringify(value),provider:'codex_exec',image_count:job.images.length};
    });
    await fs.mkdir(outputDir,{recursive:true});await fs.writeFile(outputDir+'/results.jsonl',records.map(JSON.stringify).join('\n')+'\n');
  }};
}
async function command(executable,args,options){
  if(args[1].endsWith('review-board-diagrams.py')){
    const output=args[args.indexOf('--output')+1];await fs.mkdir(output,{recursive:true});
    await fs.writeFile(output+'/review.json',json({items:[{part:1,diagram_index:0,status:'keep',reason:'合成图示与来源步骤一致。'}]}));
    return {stdout:''};
  }
  return execute(executable,args,options);
}

test('background board stage requires independent image review and resumes without regenerating source',async()=>{
  const f=await fixture(),model=models();
  const result=await automateBoardCorrection({...f,command,runJobs:model.runJobs});
  assert.equal(result.status,'completed');assert.equal(model.calls,2);
  const ledger=JSON.parse(await fs.readFile(f.runDir+'/board-correction.json','utf8'));
  assert.equal(ledger.accepted,true);assert.equal(ledger.independent_review_passed,true);
  assert.equal(await fs.readFile(f.sourceDir+'/transcript.json','utf8'),f.bytes);
  await automateBoardCorrection({...f,command,runJobs:model.runJobs});assert.equal(model.calls,2);
  assert.equal(await fs.stat(f.runDir+'/illustrated-receipt.json').then(()=>true,()=>false),false);
});

test('unresolved independent review cannot admit the source or start body generation',async()=>{
  const f=await fixture(),model=models({fail:true});
  await assert.rejects(automateBoardCorrection({...f,command,runJobs:model.runJobs}),/needs_more_evidence/);
  assert.equal(await fs.stat(f.runDir+'/board-correction.json').then(()=>true,()=>false),false);
  assert.equal(await fs.readFile(f.sourceDir+'/transcript.json','utf8'),f.bytes);
});

test('downstream caches bind the reviewed source instead of overwriting an older candidate or diagram input',async()=>{
  const f=await fixture(),model=models(),home=f.runDir+'/board-automation';
  await fs.mkdir(home);
  await fs.writeFile(home+'/diagram-input.json','previous frozen source');
  await fs.writeFile(home+'/admitted-source.json','previous diagnostic candidate');
  await automateBoardCorrection({...f,command,runJobs:model.runJobs});
  assert.equal(await fs.readFile(home+'/diagram-input.json','utf8'),'previous frozen source');
  assert.equal(await fs.readFile(home+'/admitted-source.json','utf8'),'previous diagnostic candidate');
  assert.equal(JSON.parse(await fs.readFile(f.runDir+'/board-correction.json','utf8')).accepted,true);
});

test('a genuine evidence gap plans and captures only new frames before source admission',async()=>{
  const f=await fixture(),model=models({requireExtra:true});let captures=0;
  const supplementCommand=async(executable,args,options)=>{
    if(args[1].endsWith('plan-board-followups.py')){
      const output=args[args.indexOf('--output')+1];await fs.mkdir(output,{recursive:true});
      await fs.writeFile(output+'/plan.json',json({items:[{part:1,segment_index:0,expected_visual:'合成完整题设',reason:'补足合成证据'}]}));
      return {stdout:''};
    }
    return command(executable,args,options);
  };
  const captureEvidence=async({inputDir,outputDir})=>{
    captures++;const plan=JSON.parse(await fs.readFile(outputDir+'/capture-plan.json','utf8'));
    const bytes=await fs.readFile(inputDir+'/transcript.json');
    const frames=[];await fs.mkdir(outputDir+'/frame-candidates');
    for(const frame of plan.frames){
      const image=outputDir+'/frame-candidates/'+frame.file;await fs.writeFile(image,'new-synthetic-pixels');
      const time=frame.candidates.at(-1),seconds=time.split(':').reduce((a,b)=>a*60+Number(b),0);
      frames.push({...frame,candidates:[{time,path:image,actual_seconds:seconds,sha256:hash('new-synthetic-pixels')}]});
    }
    await fs.writeFile(outputDir+'/frame-review-request.json',json({version:'video-frame-review-request/v1',video_id:'fixture',source_sha256:hash(bytes),frames}));
  };
  const result=await automateBoardCorrection({...f,command:supplementCommand,runJobs:model.runJobs,captureEvidence});
  assert.equal(result.status,'completed');assert.equal(captures,1);
  const ledger=JSON.parse(await fs.readFile(f.runDir+'/board-correction.json','utf8'));
  assert.equal(ledger.frames.length,2);assert.equal(ledger.accepted,true);assert.ok(ledger.evidence_bundle);
  assert.equal(await fs.readFile(f.sourceDir+'/transcript.json','utf8'),f.bytes);
  const plan=JSON.parse(await fs.readFile(f.runDir+'/media-schedule.json','utf8')).effective_plan;
  const prepared=await prepareBoardCorrection({inputDir:f.sourceDir,outputDir:f.runDir,transcript:f.transcript,plan,buildBook:buildMediaBook});
  assert.equal(prepared.receipt.reviewed_frames,2);assert.equal(prepared.receipt.new_capture_calls,0);
  await execute(python,['video-workflow/verify-board-correction.py','--input',prepared.inputDir],{windowsHide:true});
  await automateBoardCorrection({...f,command:supplementCommand,runJobs:model.runJobs,captureEvidence});
  assert.equal(captures,1);
});

test('diagram decisions cannot omit a diagram, inject code or cite unseen images',()=>{
  const plan={items:[{kind:'mermaid',time:'00:00:01',code:'flowchart TD\nA-->B'}]},ledger={frames:[{file:'actual.png'}]};
  assert.throws(()=>bindDiagramReview(plan,{items:[]},ledger,1),/incomplete/);
  assert.throws(()=>bindDiagramReview(plan,{items:[{part:1,diagram_index:0,status:'correct',code:'flowchart TD\nA-->B',evidence:['missing.png'],reason:'合成原因'}]},ledger,1),/evidence/);
  assert.throws(()=>bindDiagramReview(plan,{items:[{part:1,diagram_index:0,status:'correct',code:'flowchart TD\nclick A "https://example.test"',evidence:['actual.png'],reason:'合成原因'}]},ledger,1),/unsafe/);
});

test('the existing worker owns board continuation and enters the body only after admission',async()=>{
  const f=await fixture(),events=[];
  const watch={workflow:'illustrated',body_mode:'strong_structuring',media_policy:'generated_and_reviewed',provider:'codex_exec',model:WATCH_MODEL};
  let admitted=false;
  const result=await runWatchedIllustrated({item:{key:'fixture',part:1,url:'https://www.bilibili.com/video/BV1234567890/',publish_path:f.runDir+'/reading.md'},
    watch,sourceDir:f.sourceDir,runDir:f.runDir,processingOptions:{},cookies:async(_,action)=>action('synthetic'),
    importFlow:async()=>{events.push(admitted?'body':'pending');return {status:admitted?'completed':'needs_board_correction'};},
    completeBoard:async()=>{assert.equal(process.env.AI_PRODUCER_CODEX_MODEL,WATCH_MODEL);events.push('review');admitted=true;}});
  assert.equal(result.status,'completed');assert.deepEqual(events,['pending','review','body']);
});
