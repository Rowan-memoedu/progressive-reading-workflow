import fs from 'node:fs/promises';import path from 'node:path';import {createHash} from 'node:crypto';
import {buildMediaBook} from './illustrated-strong.mjs';
import {bindFollowupQuote} from './board-followup-frame.mjs';
const hash=b=>createHash('sha256').update(b).digest('hex'),json=v=>JSON.stringify(v,null,2)+'\n';
const read=async file=>JSON.parse(await fs.readFile(file,'utf8'));
async function exact(file,bytes){await fs.mkdir(path.dirname(file),{recursive:true});try{await fs.writeFile(file,bytes,{flag:'wx'});}catch(e){if(e.code!=='EEXIST'||hash(await fs.readFile(file))!==hash(bytes))throw Error('merged_board_evidence_conflict');}}

// Merge acquisition phases before source admission. Existing model responses and
// PNGs stay immutable; new requests bind every frame to copied, hashed pixels.
export async function mergeBoardEvidence({inputDir,baseRun,extraRuns=[],outputDir}){
 const sourceBytes=await fs.readFile(path.join(inputDir,'transcript.json')),transcript=JSON.parse(sourceBytes);
 const plan=(await read(path.join(baseRun,'media-schedule.json'))).effective_plan;
 const requests=[await read(path.join(baseRun,'frame-review-request.json'))],lineage=[];
 for(const run of extraRuns){
  plan.items.push(...(await read(path.join(run,'items.json'))).map(item=>bindFollowupQuote(item,transcript)));requests.push(await read(path.join(run,'frame-review-request.json')));
 }
 const book=buildMediaBook(plan,transcript),byFile=new Map();
 for(const request of requests){
  if(request.source_sha256!==hash(sourceBytes)||request.video_id!==transcript.video_id)throw Error('board_phase_source_mismatch');
  for(const frame of request.frames){if(byFile.has(frame.file))throw Error('duplicate_board_phase_frame');byFile.set(frame.file,frame);}
 }
 const frames=[];
 for(const frame of book.capturePlan.frames){
  const original=byFile.get(frame.file);if(!original)throw Error('board_phase_frame_missing');
  const candidates=[];
  for(const candidate of original.candidates){
   const bytes=await fs.readFile(candidate.path);if(hash(bytes)!==candidate.sha256)throw Error('board_phase_image_changed');
   let target=path.join(outputDir,'frame-candidates',path.basename(candidate.path));
   const existing=await fs.readFile(target).catch(e=>{if(e.code==='ENOENT')return null;throw e;});
   // Overlapping acquisition windows can produce different encodings of the
   // same timestamp. Keep both immutable images instead of overwriting one.
   if(existing&&hash(existing)!==candidate.sha256)target=path.join(outputDir,'frame-candidates',candidate.sha256.slice(0,16)+'--'+path.basename(candidate.path));
   await exact(target,bytes);
   candidates.push({...candidate,path:path.resolve(target)});lineage.push({source_path:candidate.path,merged_path:path.resolve(target),sha256:candidate.sha256});
  }
  frames.push({...frame,candidates});
 }
 const planBytes=json(book.capturePlan),request={version:'video-frame-review-request/v1',video_id:transcript.video_id,
  source_sha256:hash(sourceBytes),plan_sha256:hash(planBytes),frames};
 await exact(path.join(outputDir,'combined-media-plan.json'),json(plan));await exact(path.join(outputDir,'capture-plan.json'),planBytes);
 await exact(path.join(outputDir,'frame-review-request.json'),json(request));
 await exact(path.join(outputDir,'evidence-lineage.json'),json({source_sha256:hash(sourceBytes),acquisition_phases:1+extraRuns.length,frames:frames.length,candidates:lineage,new_capture_calls:0}));
 return {inputDir,outputDir,transcript,plan,book};
}
