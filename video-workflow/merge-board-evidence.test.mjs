import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import path from 'node:path';import {createHash} from 'node:crypto';
import {mergeBoardEvidence} from './merge-board-evidence.mjs';
const json=x=>JSON.stringify(x,null,2)+'\n',hash=b=>createHash('sha256').update(b).digest('hex');
test('overlapping acquisition filenames retain different immutable images and replay exactly',async()=>{
 const root=await fs.mkdtemp('D:/Artifacts/ProgressiveReading/merge-board-fixture-'),input=path.join(root,'source'),base=path.join(root,'base'),extra=path.join(root,'extra'),output=path.join(root,'merged');
 const transcript={video_id:'fixture',title:'独立来源夹具',duration:100,segments:[{start:'00:00:01',end:'00:00:40',text:'来源中的完整叙述'}]};
 const raw=json(transcript);await fs.mkdir(input);await fs.writeFile(path.join(input,'transcript.json'),raw);
 const item=t=>({kind:'screenshot',scene:'static',time:'00:00:'+t,window_end:'00:00:'+String(Number(t)+2),title:'受控图像夹具',source_quote:'来源中的完整叙述',expected_visual:'受控测试数据'});
 const first=item('10'),second=item('20');
 for(const [run,frame,bytes] of [[base,first,Buffer.from('first encoding')],[extra,second,Buffer.from('second encoding')]]){
  await fs.mkdir(path.join(run,'frame-candidates'),{recursive:true});const file=path.join(run,'frame-candidates','same.png');await fs.writeFile(file,bytes);
  await fs.writeFile(path.join(run,'frame-review-request.json'),json({video_id:'fixture',source_sha256:hash(raw),frames:[{file:'shot_'+frame.time.replaceAll(':','_')+'.png',candidates:[{time:frame.time,actual_seconds:Number(frame.time.slice(-2)),path:file,sha256:hash(bytes)}]}]}));
 }
 await fs.writeFile(path.join(base,'media-schedule.json'),json({effective_plan:{items:[first,{kind:'mermaid',time:'00:00:30',title:'示意',source_quote:'来源中的完整叙述',code:'flowchart TD\nA["来源"]-->B["核对"]'}]}}));
 await fs.writeFile(path.join(extra,'items.json'),json([second]));
 await mergeBoardEvidence({inputDir:input,baseRun:base,extraRuns:[extra],outputDir:output});
 const request=JSON.parse(await fs.readFile(path.join(output,'frame-review-request.json'),'utf8')),paths=request.frames.map(f=>f.candidates[0].path);
 assert.equal(new Set(paths).size,2);assert.equal(await fs.readFile(paths[0],'utf8'),'first encoding');assert.equal(await fs.readFile(paths[1],'utf8'),'second encoding');
 const before=await fs.readFile(path.join(output,'frame-review-request.json'),'utf8');
 await mergeBoardEvidence({inputDir:input,baseRun:base,extraRuns:[extra],outputDir:output});
 assert.equal(await fs.readFile(path.join(output,'frame-review-request.json'),'utf8'),before);assert.equal(await fs.readFile(path.join(input,'transcript.json'),'utf8'),raw);
});
