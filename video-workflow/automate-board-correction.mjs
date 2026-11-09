import fs from 'node:fs/promises';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash} from 'node:crypto';
import {runBoardCorrectionJobs} from './run-board-correction.mjs';
import {loadProducerConfig,producerModel} from '../standard-preprocessing/lib/producer.mjs';
import {boardFollowupFrame} from './board-followup-frame.mjs';
import {screenshotTiming} from './media-timing.mjs';
import {normalizeMermaidSource} from './mermaid-source.mjs';

const execute=promisify(execFile),root=import.meta.dirname;
const json=value=>JSON.stringify(value,null,2)+'\n';
const hash=value=>createHash('sha256').update(value).digest('hex');
const read=async file=>JSON.parse(await fs.readFile(file,'utf8'));
async function exact(file,data){
  await fs.mkdir(path.dirname(file),{recursive:true});
  try{await fs.writeFile(file,data,{flag:'wx'});}
  catch(error){if(error.code!=='EEXIST'||!Buffer.from(data).equals(await fs.readFile(file)))throw Error('automatic_board_frozen_input_changed:'+file);}
}
const rows=async file=>(await fs.readFile(file,'utf8')).split(/\r?\n/u).filter(Boolean).map(line=>JSON.parse(line));

export function reviewJobs(jobs,results){
  if(jobs.length!==results.length)throw Error('board_extraction_incomplete');
  return jobs.map(job=>{
    const result=results.find(row=>String(row.id)===String(job.id));
    if(!result?.output?.trim())throw Error('board_extraction_result_missing');
    return {...job,input:JSON.stringify({...JSON.parse(job.input),previous_candidate_untrusted:result.output})};
  });
}

// Reuse independently passed groups with identical raw input/images. Failed
// groups alone are reviewed under the new policy; old responses stay frozen.
export async function reusableSourceReviews(home,jobs,excludeKey,model){
  const found=new Map();
  const entries=await fs.readdir(home,{withFileTypes:true}).catch(error=>{if(error.code==='ENOENT')return [];throw error;});
  for(const entry of entries.filter(e=>e.isDirectory()&&/^source-review-[a-f0-9]{12}-\d+$/u.test(e.name)).sort((a,b)=>a.name.localeCompare(b.name))){
    if(excludeKey&&entry.name.includes(excludeKey))continue;
    const dir=path.join(home,entry.name);
    const prompt=await fs.readFile(path.join(dir,'prompt.md')).catch(()=>null);
    if(!prompt||!entry.name.includes(hash(prompt).slice(0,12)))continue;
    for(const row of await rows(path.join(dir,'results.jsonl')).catch(()=>[])){
      const job=jobs.find(j=>String(j.id)===String(row.id));
      if(!job||JSON.stringify(job)!==JSON.stringify(row.input)||row.provider!=='codex_exec'||row.image_count!==job.images.length||(model&&row.model!==model))continue;
      let value;try{value=JSON.parse(row.output.replace(/^```(?:json)?\s*|\s*```$/gu,''));}catch{continue;}
      if(value.review?.verdict==='pass'&&value.review.issues?.length===0&&value.unresolved?.length===0)
        found.set(String(row.id),row);
    }
  }
  return jobs.flatMap(job=>found.has(String(job.id))?[found.get(String(job.id))]:[]);
}

export async function resumeBoardEvidence(runDir,sourceSha){
  const home=path.join(runDir,'board-automation');
  const entries=await fs.readdir(home,{withFileTypes:true}).catch(error=>{if(error.code==='ENOENT')return [];throw error;});
  let chosen=runDir,count=0;
  for(const entry of entries.filter(e=>e.isDirectory()&&/^evidence-[a-f0-9]+$/u.test(e.name)).sort((a,b)=>a.name.localeCompare(b.name))){
    const dir=path.join(home,entry.name),request=await read(path.join(dir,'frame-review-request.json')).catch(()=>null);
    if(request?.source_sha256===sourceSha&&request.frames.length>count&&await fs.stat(path.join(dir,'combined-media-plan.json')).then(()=>true,()=>false)){
      chosen=dir;count=request.frames.length;
    }
  }
  return chosen;
}

export function bindDiagramReview(plan,review,ledger,part){
  const diagrams=plan.items.filter(item=>item.kind==='mermaid');
  if(review.items?.length!==diagrams.length||new Set(review.items.map(item=>item.diagram_index)).size!==diagrams.length)
    throw Error('board_diagram_review_incomplete');
  const changes=[];
  for(const [index,original]of diagrams.entries()){
    const item=review.items.find(row=>row.diagram_index===index);
    if(!item||item.part!==part||!['keep','correct'].includes(item.status)||!item.reason?.trim())throw Error('board_diagram_review_invalid');
    if(item.status==='keep')continue;
    if(!item.evidence?.length||item.evidence.some(id=>!ledger.frames.some(frame=>frame.file===id)))throw Error('board_diagram_evidence_required');
    let code;
    try{code=normalizeMermaidSource(item.code);}catch{throw Error('unsafe_reviewed_mermaid');}
    if(code!==original.code)changes.push({time:original.time,before:original.code,after:code,evidence:item.evidence,reason:item.reason});
  }
  return changes;
}

// This is a stage of the existing worker, not a separate queue or resident service.
// Raw proposals, independent source reviews and admission remain separate files.
async function runAutomaticBoardCorrection({sourceDir,runDir,evidenceDir=runDir,part=1,pythonPath,
  config,command=execute,runJobs=runBoardCorrectionJobs,onProgress=async()=>{}}){
  pythonPath ||= process.env.PROGRESSIVE_READING_VIDEO_PYTHON||'D:/Caches/ProgressiveReading/videobook-python/Scripts/python.exe';
  config ||= await loadProducerConfig({requiredProvider:'codex_exec'});
  const home=path.join(evidenceDir,'board-automation'),transcriptFile=path.join(sourceDir,'transcript.json');
  const requestFile=path.join(evidenceDir,'frame-review-request.json');
  const identity={version:'automatic-board-source/v1',provider:'codex_exec',model:producerModel(config),
    source_sha256:hash(await fs.readFile(transcriptFile)),frame_request_sha256:hash(await fs.readFile(requestFile))};
  await exact(path.join(home,'identity.json'),json(identity));
  const progress=async stage=>{
    console.log(JSON.stringify({stage:'automatic_board_correction',phase:stage,part,status:'running'}));
    await fs.writeFile(path.join(home,'progress.json'),json({stage,part,status:'running',at:new Date().toISOString()}));
    await onProgress({stage,part});
  };
  const python=async(script,args)=>{
    try{
      const result=await command(pythonPath,['-u',path.join(root,script),...args],{windowsHide:true,maxBuffer:16*1024*1024,env:{...process.env,PYTHONIOENCODING:'utf-8'}});
      if(result.stdout?.trim())console.log(result.stdout.trim());
    }catch(error){
      const last=String(error.stderr||error.message).trim().split(/\r?\n/u).at(-1).slice(0,800);
      throw Error('board_stage_failed:'+script+':'+last);
    }
  };
  const completed=await read(path.join(home,'receipt.json')).catch(error=>{if(error.code==='ENOENT')return null;throw error;});
  if(completed?.status==='completed'){
    if(hash(await fs.readFile(path.join(runDir,'board-correction.json')))!==completed.ledger_sha256)throw Error('accepted_board_ledger_changed');
    return {...completed,replayed:true};
  }
  await progress('prepare_visual_jobs');
  const jobsDir=path.join(home,'jobs');
  await python('prepare-board-correction-jobs.py',['--transcript',transcriptFile,'--frame-request',requestFile,'--output',jobsDir]);
  const shards=[];
  for(const shard of [0,1]){
    const input=path.join(jobsDir,`jobs-${shard}.jsonl`),jobs=await rows(input);
    if(jobs.length)shards.push({shard,input,jobs});
  }
  if(!shards.length)throw Error('automatic_board_images_required');
  await progress('extract_and_independently_review');
  const reviewPrompt=path.join(root,'prompts/board-source-review.md');
  const reviewKey=hash(await fs.readFile(reviewPrompt)).slice(0,12);
  const reviewed=await Promise.all(shards.map(async({shard,input,jobs})=>{
    const extracted=path.join(home,`extraction-${shard}`),reviewedDir=path.join(home,`source-review-${reviewKey}-${shard}`);
    await runJobs({inputFile:input,promptFile:path.join(root,'prompts/board-formula-correction-v1.md'),outputDir:extracted,config});
    const reviewInput=path.join(jobsDir,`review-${reviewKey}-${shard}.jsonl`);
    const reviewAll=reviewJobs(jobs,await rows(path.join(extracted,'results.jsonl')));
    const reused=await reusableSourceReviews(home,reviewAll,reviewKey,producerModel(config));
    const pending=reviewAll.filter(job=>!reused.some(row=>String(row.id)===String(job.id)));
    await exact(reviewInput,pending.map(job=>JSON.stringify(job)).join('\n')+'\n');
    let fresh=[];
    if(pending.length){
      await runJobs({inputFile:reviewInput,promptFile:reviewPrompt,outputDir:reviewedDir,config});
      fresh=await rows(path.join(reviewedDir,'results.jsonl'));
    }
    const combined=path.join(home,`review-results-${reviewKey}-${shard}.jsonl`);
    await exact(combined,[...reused,...fresh].sort((a,b)=>String(a.id).localeCompare(String(b.id))).map(row=>JSON.stringify(row)).join('\n')+'\n');
    return combined;
  }));
  await progress('compile_source_evidence');
  const candidate=path.join(home,`candidate-${reviewKey}.json`);
  await python('assemble-board-ledger.py',['--transcript',transcriptFile,'--frame-request',requestFile,'--results',...reviewed,'--require-review','--output',candidate]);
  const ledger=await read(candidate);
  if(!ledger.independent_review_passed||ledger.unresolved.length||ledger.rejected_proposals.length){
    const error=Error('automatic_board_needs_more_evidence; inspect '+candidate);
    error.candidateFile=candidate;error.evidenceDir=evidenceDir;throw error;
  }
  await progress('review_generated_diagrams');
  const transcript=await read(transcriptFile);
  const plan=evidenceDir===runDir ? (await read(path.join(runDir,'media-schedule.json'))).effective_plan
    : await read(path.join(evidenceDir,'combined-media-plan.json'));
  const admittedKey=hash(await fs.readFile(candidate)).slice(0,16);
  const diagramKey=hash(json({candidate:admittedKey,plan})).slice(0,16);
  const diagramInput=path.join(home,`diagram-${diagramKey}-input.json`),diagramDir=path.join(home,`diagram-review-${diagramKey}`);
  await exact(diagramInput,json({parts:[{part,transcript,observations:ledger.frames,formula_notes:ledger.formula_notes,source_conflicts:ledger.source_conflicts,
    diagrams:plan.items.filter(item=>item.kind==='mermaid').map((item,diagram_index)=>({diagram_index,time:item.time,code:item.code}))}]}));
  await python('review-board-diagrams.py',['--input',diagramInput,'--output',diagramDir]);
  const diagramChanges=bindDiagramReview(plan,await read(path.join(diagramDir,'review.json')),ledger,part);
  await progress('admit_reviewed_source');
  const admitted=path.join(home,`admitted-source-${admittedKey}.json`);
  await python('admit-automated-board.py',['--transcript',transcriptFile,'--frame-request',requestFile,'--candidate',candidate,
    '--results',...reviewed,'--output',admitted]);
  const accepted=await read(admitted);accepted.diagram_corrections=diagramChanges;
  if(evidenceDir!==runDir){
    const planFile=path.join(evidenceDir,'combined-media-plan.json');
    accepted.evidence_bundle={request_file:requestFile,plan_file:planFile,plan_sha256:hash(await fs.readFile(planFile))};
  }
  accepted.diagram_review={path:path.join(diagramDir,'review.json'),sha256:hash(await fs.readFile(path.join(diagramDir,'review.json')))};
  await exact(path.join(runDir,'board-correction.json'),json(accepted));
  const receipt={...identity,status:'completed',frames:accepted.frames.length,used_frames:accepted.frames.filter(row=>row.use).length,
    patches:accepted.patches.length,formula_notes:accepted.formula_notes.length,diagram_corrections:diagramChanges.length,
    independent_source_review:true,review_contract_sha256:hash(await fs.readFile(reviewPrompt)),
    raw_source_changed:false,ledger_sha256:hash(await fs.readFile(path.join(runDir,'board-correction.json')))};
  await exact(path.join(home,'receipt.json'),json(receipt));
  await fs.writeFile(path.join(home,'progress.json'),json({stage:'source_admitted',status:'completed',part}));
  return receipt;
}

export async function automateBoardCorrection(args){
  try{
    const acceptedFile=path.join(args.runDir,'board-correction.json');
    const prior=await read(acceptedFile).catch(error=>{if(error.code==='ENOENT')return null;throw error;});
    if(prior?.accepted&&prior.automated_admission){
      const receiptHome=prior.evidence_bundle ? path.join(path.dirname(prior.evidence_bundle.request_file),'board-automation')
        : path.join(args.runDir,'board-automation');
      const receipt=await read(path.join(receiptHome,'receipt.json'));
      if(receipt.status!=='completed'||hash(await fs.readFile(acceptedFile))!==receipt.ledger_sha256
          ||hash(await fs.readFile(path.join(args.sourceDir,'transcript.json')))!==receipt.source_sha256)
        throw Error('accepted_board_source_changed');
      return {...receipt,replayed:true};
    }
    let evidenceDir=await resumeBoardEvidence(args.runDir,hash(await fs.readFile(path.join(args.sourceDir,'transcript.json'))));
    for(let attempt=0;;attempt++){
      try{return await runAutomaticBoardCorrection({...args,evidenceDir});}
      catch(error){
        if(!error.candidateFile||!args.captureEvidence||attempt>=(args.maxEvidencePasses??2))throw error;
        const candidate=await read(error.candidateFile),transcript=await read(path.join(args.sourceDir,'transcript.json'));
        const gapKey=hash(await fs.readFile(error.candidateFile)).slice(0,12);
        const extra=path.join(args.runDir,'board-automation',`supplement-${gapKey}-${attempt+1}`),planning=path.join(extra,'planning');
        const input=path.join(extra,'source-gaps.json');
        await exact(input,json({parts:[{part:args.part||1,transcript,observations:candidate.frames,
          formula_notes:candidate.formula_notes,unresolved:candidate.unresolved,rejected_proposals:candidate.rejected_proposals}]}));
        await args.onProgress?.({stage:'supplement_board_evidence',part:args.part||1});
        const command=args.command||execute,python=args.pythonPath||process.env.PROGRESSIVE_READING_VIDEO_PYTHON||'D:/Caches/ProgressiveReading/videobook-python/Scripts/python.exe';
        const result=await command(python,['-u',path.join(root,'plan-board-followups.py'),'--input',input,'--output',planning],
          {windowsHide:true,maxBuffer:16*1024*1024,env:{...process.env,PYTHONIOENCODING:'utf-8'}});
        if(result.stdout?.trim())console.log(result.stdout.trim());
        const choices=(await read(path.join(planning,'plan.json'))).items;
        if(!Array.isArray(choices)||choices.some(choice=>choice.part!==(args.part||1)))throw Error('board_followup_part_identity_mismatch');
        const oldRequest=await read(path.join(evidenceDir,'frame-review-request.json'));
        const used=new Set(oldRequest.frames.map(frame=>frame.requested_time)),items=[];
        for(const choice of choices){
          const item=boardFollowupFrame(transcript,choice);
          if(!used.has(item.time)){items.push(item);used.add(item.time);}
        }
        if(!items.length)throw Error('automatic_board_no_actionable_supplement; inspect '+error.candidateFile);
        const source=path.join(extra,'source'),capture=path.join(extra,'capture');
        await exact(path.join(source,'transcript.json'),await fs.readFile(path.join(args.sourceDir,'transcript.json')));
        const book=items.map(item=>`![${item.title}](SCREENSHOT:${item.time})`).join('\n\n')+'\n';
        await exact(path.join(source,'book.tagged.md'),book);
        if(!await fs.stat(path.join(source,'book.md')).then(()=>true,()=>false))await exact(path.join(source,'book.md'),book);
        await exact(path.join(capture,'items.json'),json(items));
        await exact(path.join(capture,'capture-plan.json'),json({version:'video-frame-plan/v2',frames:items.map(item=>screenshotTiming(item,transcript))}));
        await args.captureEvidence({inputDir:source,outputDir:capture});
        const {mergeBoardEvidence}=await import('./merge-board-evidence.mjs');
        const next=path.join(args.runDir,'board-automation',`evidence-${hash(json({base:evidenceDir,capture})).slice(0,12)}`);
        await mergeBoardEvidence({inputDir:args.sourceDir,baseRun:evidenceDir,extraRuns:[capture],outputDir:next});
        evidenceDir=next;
      }
    }
  }
  catch(error){
    const state={stage:'board_blocked',status:'blocked',part:args.part||1,error:error.message,at:new Date().toISOString()};
    await fs.writeFile(path.join(args.runDir,'board-automation/progress.json'),json(state)).catch(()=>{});
    await args.onProgress?.(state);
    throw error;
  }
}
