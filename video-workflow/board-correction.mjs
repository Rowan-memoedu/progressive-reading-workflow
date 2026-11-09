import fs from 'node:fs/promises';
import {sourceConflictNotes} from './source-conflicts.mjs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {checkFormulaConsistency} from './formula-consistency.mjs';

const hash=value=>createHash('sha256').update(value).digest('hex');
const seconds=value=>String(value).split(':').reduce((sum,part)=>sum*60+Number(part),0);
const read=async file=>JSON.parse(await fs.readFile(file,'utf8'));
async function exact(file,data){
  await fs.mkdir(path.dirname(file),{recursive:true});
  try{await fs.writeFile(file,data,{flag:'wx'});}
  catch(error){if(error.code!=='EEXIST'||hash(await fs.readFile(file))!==hash(data))throw Error('board_frozen_input_changed:'+file);}
}
const json=value=>JSON.stringify(value,null,2)+'\n';

// Only used inside the explicitly enabled illustrated route. A formula in an
// ordinary software demo does not make it a mathematics lecture.
export function requiresBoardCorrection(transcript,plan,options={}){
  if(options.content_profile==='math_lecture'||options.board_formula_correction===true)return true;
  const subject=String(transcript.title||'');
  const mathematics=/数学|数论|同余|组合|不等式|函数|微积分|几何|代数|数列|概率|力学|电磁|物理/gu;
  const evidence=plan.items.filter(item=>/公式|板书|分母|分子|取等|平方|根号|方程|不等式/u.test(item.expected_visual||item.title||''));
  return mathematics.test(subject)&&evidence.length>=2;
}

/** Validate a source correction ledger before admitting any new body call.
 * This function never edits the original captions, raw screenshots or response.
 * Human/model observations are evidence for review, not automatic acceptance.
 */
export async function prepareBoardCorrection({inputDir,outputDir,transcript,plan,buildBook}){
  const ledgerFile=path.join(outputDir,'board-correction.json');
  const ledger=await read(ledgerFile).catch(error=>{if(error.code==='ENOENT')return null;throw error;});
  if(!ledger)return null;
  const rawBytes=await fs.readFile(path.join(inputDir,'transcript.json'));
  let requestFile=path.join(outputDir,'frame-review-request.json');
  if(ledger.evidence_bundle){
    const bundle=ledger.evidence_bundle,allowed=path.resolve(outputDir,'board-automation')+path.sep;
    for(const file of [bundle.request_file,bundle.plan_file])if(!path.resolve(file).startsWith(allowed))throw Error('board_evidence_bundle_outside_run');
    requestFile=path.resolve(bundle.request_file);
    const bytes=await fs.readFile(bundle.plan_file);
    if(hash(bytes)!==bundle.plan_sha256)throw Error('board_evidence_plan_changed');
    plan=JSON.parse(bytes);
  }
  const requestBytes=await fs.readFile(requestFile);
  const request=JSON.parse(requestBytes);
  if(request.source_sha256!==hash(rawBytes)||request.video_id!==transcript.video_id)throw Error('board_frame_request_not_for_source');
  if(ledger.version!=='video-board-correction/v1'||ledger.accepted!==true||ledger.unresolved?.length
      ||!Array.isArray(ledger.patches)||!Array.isArray(ledger.formula_notes)
      ||ledger.raw_transcript_sha256!==hash(rawBytes)||ledger.frame_request_sha256!==hash(requestBytes))throw Error('board_correction_not_accepted_or_stale');
  const formulaCheck=checkFormulaConsistency(ledger.patches.map(p=>p.after).join('\n'),ledger.formula_notes.map(n=>n.text));
  if(formulaCheck.status!=='passed')throw Error('board_patch_math_consistency_review_required');
  if(ledger.frames?.length!==request.frames.length||new Set(ledger.frames.map(row=>row.file)).size!==request.frames.length)throw Error('board_review_coverage_mismatch');
  const ledgerHash=hash(await fs.readFile(ledgerFile));
  const stage=path.join(outputDir,'board-corrected'),source=path.join(stage,'source'),run=path.join(stage,'run');
  const evidence=new Map(),selected=[],effective=structuredClone(plan);
  for(const frame of request.frames){
    const row=ledger.frames.find(item=>item.file===frame.file);
    if(!row||!['complete','partial'].includes(row.status)||typeof row.observed!=='string'||row.observed.trim().length<4||typeof row.use!=='boolean')throw Error('board_image_not_reviewed:'+frame.file);
    const candidate=frame.candidates.find(item=>item.time===row.selected_time&&item.sha256===row.sha256);
    if(!candidate||hash(await fs.readFile(candidate.path))!==row.sha256)throw Error('board_image_changed:'+frame.file);
    const actual=candidate.actual_seconds;
    if(!Number.isFinite(actual)||actual<seconds(frame.requested_time)-0.1||actual>seconds(frame.window_end)+0.1)throw Error('board_candidate_outside_window');
    const relative=path.relative(path.join(path.dirname(requestFile),'frame-candidates'),path.resolve(candidate.path));
    if(relative.startsWith('..')||path.isAbsolute(relative))throw Error('board_candidate_path_escape');
    evidence.set(frame.file,{...row,actual_seconds:actual});
    if(!row.use){
      if(!row.omission_reason?.trim())throw Error('board_omission_reason_required');
      effective.items=effective.items.filter(item=>!(item.kind==='screenshot'&&item.time===frame.requested_time));
      continue;
    }
    if(!row.title?.trim())throw Error('board_corrected_image_title_required');
    const item=effective.items.find(item=>item.kind==='screenshot'&&item.time===frame.requested_time);
    if(!item)throw Error('board_media_identity_mismatch');
    item.title=row.title;item.expected_visual=row.observed;
    const destination=path.join(run,'frame-candidates',path.basename(candidate.path));
    await exact(destination,await fs.readFile(candidate.path));
    selected.push({frame:{...frame,title:row.title,expected_visual:row.observed,candidates:[{...candidate,path:destination}]},row});
  }
  function checkEvidence(record,index){
    if(!Array.isArray(record.evidence)||!record.evidence.length||!Number.isInteger(index)||index<0||index>=transcript.segments.length)throw Error('board_patch_evidence_required');
    const time=seconds(transcript.segments[index].start);
    for(const id of record.evidence){
      const image=evidence.get(id);
      if(!image||Math.abs(image.actual_seconds-time)>360)throw Error('board_patch_evidence_not_near_caption');
    }
  }
  const corrected=structuredClone(transcript),seen=new Set();
  for(const patch of ledger.patches){
    checkEvidence(patch,patch.segment_index);
    if(seen.has(patch.segment_index)||typeof patch.after!=='string'||!patch.after.trim()||patch.before!==transcript.segments[patch.segment_index].text)throw Error('board_patch_not_exact_source');
    seen.add(patch.segment_index);corrected.segments[patch.segment_index].text=patch.after;
  }
  const terminology=[];
  for(const term of ledger.terminology_corrections||[]){
    if(!term.before?.trim()||!term.after?.trim()||term.before===term.after||!term.evidence?.length||!term.evidence.every(id=>evidence.has(id)))throw Error('board_terminology_not_bound');
    if((ledger.source_conflicts||[]).some(item=>item.captions.some(c=>c.before.includes(term.before))))throw Error('source_conflict_was_modified');
    const indices=[];
    corrected.segments.forEach((segment,index)=>{
      if(segment.text.includes(term.before)){segment.text=segment.text.replaceAll(term.before,term.after);indices.push(index);}
    });
    terminology.push({before:term.before,after:term.after,segment_indices:indices,evidence:term.evidence});
  }
  for(const note of ledger.formula_notes){
    checkEvidence(note,note.after_segment_index);
    if(!note.text?.trim())throw Error('board_formula_note_empty');
    corrected.segments[note.after_segment_index].text+='\n'+note.text;
  }
  for(const note of sourceConflictNotes(ledger,transcript))corrected.segments[note.after_segment_index].text+='\n'+note.text;
  if(!ledger.patches.length&&!ledger.formula_notes.length&&ledger.no_correction_needed!==true)throw Error('board_review_conclusion_required');
  for(const change of ledger.diagram_corrections||[]){
    const original=effective.items.find(item=>item.kind==='mermaid'&&item.time===change.time);
    if(!original||original.code!==change.before||!change.evidence?.length||!change.evidence.every(id=>evidence.has(id)))throw Error('board_diagram_correction_not_bound');
    original.code=change.after;
  }
  // Quotes remain proven against immutable raw captions. Only the derived input
  // text and reviewed media descriptions are corrected, with the ledger retained.
  const book=buildBook(effective,transcript);
  const correctedBytes=json(corrected);
  await exact(path.join(source,'transcript.original.json'),rawBytes);
  const rawText=await fs.readFile(path.join(inputDir,'transcript.txt')).catch(e=>{if(e.code==='ENOENT')return null;throw e;});
  if(rawText)await exact(path.join(source,'transcript.original.txt'),rawText);
  await exact(path.join(source,'transcript.json'),correctedBytes);
  await exact(path.join(source,'book.md'),book.materialized);
  await exact(path.join(source,'board-correction.json'),await fs.readFile(ledgerFile));
  await exact(path.join(run,'capture-plan.json'),json(book.capturePlan));
  const correctedRequest={...request,source_sha256:hash(correctedBytes),plan_sha256:hash(json(book.capturePlan)),
    original_request_sha256:hash(requestBytes),board_correction_sha256:ledgerHash,frames:selected.map(item=>item.frame)};
  const correctedRequestBytes=json(correctedRequest);
  await exact(path.join(run,'frame-review-request.json'),correctedRequestBytes);
  await exact(path.join(run,'frame-review.json'),json({version:'video-frame-review/v1',request_sha256:hash(correctedRequestBytes),
    frames:selected.map(({frame,row})=>({file:frame.file,selected_time:row.selected_time,sha256:row.sha256,matches_expected:true,observed:row.observed}))}));
  const receipt={version:ledger.version,status:'passed',raw_input_dir:path.resolve(inputDir).replaceAll('\\','/'),source_dir:source,run_dir:run,
    raw_frame_request:requestFile,
    raw_transcript_sha256:hash(rawBytes),corrected_transcript_sha256:hash(correctedBytes),ledger_sha256:ledgerHash,
    raw_segments:transcript.segments.length,corrected_segments:corrected.segments.length,patches:ledger.patches.length,
    formula_notes:ledger.formula_notes.length,reviewed_frames:ledger.frames.length,used_frames:selected.length,
    terminology_applications:terminology,
    raw_caption_timestamps_unchanged:true,new_capture_calls:0,body_prompt_unchanged:true};
  await exact(path.join(source,'board-correction-receipt.json'),json(receipt));
  await exact(path.join(run,'board-correction-receipt.json'),json(receipt));
  return {transcript:corrected,book,inputDir:source,outputDir:run,receipt};
}
