import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {importTranscript,parseTranscript,verifyUpstream} from './import-transcript.mjs';
import {captionMediaSource,extractBookMedia,imageEmbed} from './book-media.mjs';
import {bookPublicationPath} from './book-folder.mjs';
import {groupTranscriptSegments} from '../scripts/import-youtube-subtitle-canary.mjs';
import {refineAndProjectGeneratedMedia} from './generated-media-projection.mjs';
import {screenshotTiming} from './media-timing.mjs';
import {compileMediaSchedule} from './media-schedule.mjs';
import {extendBoardEvidencePlan} from './board-evidence-plan.mjs';
import {resolveVideoMode} from './video-mode.mjs';
import {writeCapturePlan} from './capture-plan.mjs';
import {requiresBoardCorrection,prepareBoardCorrection} from './board-correction.mjs';
import {checkFormulaConsistency} from './formula-consistency.mjs';
import {loadProducerConfig,ExternalProducer,producerModel} from '../standard-preprocessing/lib/producer.mjs';

export const OUTPUT_TYPE='illustrated';
const root=path.dirname(fileURLToPath(import.meta.url));
const hash=value=>createHash('sha256').update(value).digest('hex');
const seconds=time=>String(time).split(':').reduce((total,part)=>total*60+Number(part),0);
const readJson=async file=>JSON.parse(await fs.readFile(file,'utf8'));
const event=(stage,status,extra={})=>console.log(JSON.stringify({stage,status,...extra}));
async function exact(file,data){
  await fs.mkdir(path.dirname(file),{recursive:true});
  try{await fs.writeFile(file,data,{flag:'wx'});}
  catch(error){if(error.code!=='EEXIST'||hash(await fs.readFile(file))!==hash(data))throw new Error('output_conflict:'+file);}
}
async function command(executable,args){
  const child=spawn(executable,args,{stdio:['ignore','inherit','pipe'],windowsHide:true,env:{...process.env,PYTHONIOENCODING:'utf-8'}});
  let pending='';
  const safe=line=>line.replace(/https?:\/\/[^\s]+/gu,url=>url.split('?')[0]+'?[query-redacted]').replace(/^(.*(?:cookie|authorization):).*$/iu,'$1 [redacted]');
  child.stderr.on('data',chunk=>{pending+=chunk.toString();let end;while((end=pending.indexOf('\n'))>=0){process.stderr.write(safe(pending.slice(0,end))+'\n');pending=pending.slice(end+1);}});
  const code=await new Promise((resolve,reject)=>{child.on('error',reject);child.on('exit',resolve);});
  if(pending)process.stderr.write(safe(pending)+'\n');
  if(code!==0)throw new Error('workflow_stage_exit:'+path.basename(args[1]||args[0])+':'+code);
}
async function watchStage(stage,action){
  const started=Date.now();
  const timer=setInterval(()=>event(stage,'waiting',{elapsed_seconds:Math.round((Date.now()-started)/1000)}),30000);
  try{return await action();}finally{clearInterval(timer);}
}

export function buildMediaBook(plan,transcript){
  if(!Array.isArray(plan.items)||!plan.items.length)throw new Error('empty_media_plan');
  const items=[...plan.items].sort((a,b)=>seconds(a.time)-seconds(b.time));
  const imagePaths=[],frames=[],seen=new Set();
  const chunks=['# '+String(transcript.title).replace(/[\r\n]/gu,' ')];
  for(const item of items){
    if(!['screenshot','mermaid'].includes(item.kind)||!/^\d{2}:\d{2}:\d{2}$/u.test(item.time)||!item.title?.trim())throw new Error('invalid_media_item');
    const parts=item.time.split(':').map(Number),time=seconds(item.time);
    if(parts[1]>=60||parts[2]>=60||time<0||time>=Number(transcript.duration))throw new Error('media_timestamp_out_of_video');
    const quote=String(item.source_quote||'');
    const nearby=transcript.segments.filter(segment=>Math.abs(seconds(segment.start)-time)<=60).map(segment=>segment.text).join('');
    if(quote.length<4||!nearby.includes(quote))throw new Error('media_source_quote_not_near_timestamp');
    const title=item.title.replace(/[\r\n\[\]<>]/gu,' ').trim();
    chunks.push('## '+title,'*(参考时间: '+item.time+')*');
    if(item.kind==='screenshot'){
      if(seen.has(item.time))throw new Error('duplicate_screenshot_timestamp');
      seen.add(item.time);
      frames.push({...screenshotTiming(item,transcript),title});
      imagePaths.push('images/shot_'+item.time.replaceAll(':','_')+'.png');
      chunks.push('!['+title+'](SCREENSHOT:'+item.time+')');
    }else{
      const code=String(item.code||'').trim();
      if(!/^(?:flowchart|graph)\s+(?:TD|TB|LR|RL|BT)\b/u.test(code)||/```|<|https?:|\bclick\b|%%\{/iu.test(code))throw new Error('invalid_or_unsafe_mermaid');
      chunks.push('```mermaid\n'+code+'\n```');
    }
  }
  const mermaid=items.filter(item=>item.kind==='mermaid').length;
  if(!imagePaths.length||!mermaid)throw new Error('complete_visual_type_requires_images_and_mermaid');
  const tagged=chunks.join('\n\n')+'\n';
  const materialized=tagged.replace(/SCREENSHOT:(\d{2}:\d{2}:\d{2})/gu,(_,time)=>'images/shot_'+time.replaceAll(':','_')+'.png');
  return {tagged,materialized,imagePaths,capturePlan:{version:'video-frame-plan/v2',frames},counts:{images:imagePaths.length,mermaid}};
}

export async function importIllustratedStrong({inputDir,outputDir,publishPath,cookiesFile,
  processingOptions={},pythonPath='D:/Caches/ProgressiveReading/videobook-python/Scripts/python.exe',
  planMedia,captureFrames,refineBody=refineAndProjectGeneratedMedia,producer}){
  inputDir=path.resolve(inputDir);outputDir=path.resolve(outputDir);
  if(outputDir===inputDir||outputDir.startsWith(inputDir+path.sep))throw new Error('input_output_overlap');
  const upstream=await verifyUpstream();
  const transcript=await readJson(path.join(inputDir,'transcript.json'));
  const finalPath=bookPublicationPath(publishPath,transcript);
  // Never regenerate or republish into a user's existing reading document.
  const previous=await readJson(path.join(outputDir,'illustrated-receipt.json')).catch(e=>{if(e.code==='ENOENT')return null;throw e;});
  if(previous?.status==='completed'){
    if(hash(await fs.readFile(previous.publication.path))!==previous.publication.sha256)throw new Error('published_document_has_user_edits');
    return {...previous,replayed:true,new_model_calls:0};
  }
  if(await fs.stat(finalPath).then(()=>true,e=>{if(e.code==='ENOENT')return false;throw e;}))throw new Error('existing_reading_document_not_overwritten');
  // Bind every production branch, including the final guide, to the same
  // configured Codex backend. An API override is rejected before production.
  const producerConfig=await loadProducerConfig({requiredProvider:'codex_exec'});
  producer ||= new ExternalProducer(producerConfig);
  const modelRoute={provider:'codex_exec',model:producerModel(producerConfig),transport:'unified-reading-transport/v1'};
  const segments=parseTranscript(transcript.segments.map(s=>'['+s.start+'] '+s.text.replace(/\r?\n/gu,' ')).join('\n'));
  // Use exactly the existing parser's original text, including multiline math/code.
  segments.forEach((segment,index)=>segment.text=transcript.segments[index].text);
  const duration=Number(transcript.duration),last=seconds(transcript.segments.at(-1)?.end||segments.at(-1)?.start);
  if(!duration||last<duration*0.8||last>duration+60)throw new Error('subtitle_coverage_incomplete');
  await fs.mkdir(outputDir,{recursive:true});
  const planDir=path.join(outputDir,'media-planning');
  if(!planMedia)planMedia=async()=>{
    await command(process.env.PR_AUDIO_PYTHON||'D:/AppData/AudioWorkflow/python/Scripts/python.exe',
      ['-u',path.join(root,'plan-upstream-media.py'),'--input',path.join(inputDir,'transcript.json'),'--output',planDir]);
    return readJson(path.join(planDir,'plan.json'));
  };
  event('upstream_media_plan','running');
  const rawPlan=await planMedia(transcript),schedule=compileMediaSchedule(rawPlan,transcript);
  const coverage=requiresBoardCorrection(transcript,schedule.plan,processingOptions)?extendBoardEvidencePlan(schedule.plan,transcript):null;
  const plan=coverage?.plan||schedule.plan,book=buildMediaBook(plan,transcript);
  await exact(path.join(outputDir,'media-schedule.json'),JSON.stringify({raw_plan:rawPlan,effective_plan:plan,...schedule.receipt},null,2)+'\n');
  if(coverage)await exact(path.join(outputDir,'board-evidence-coverage.json'),JSON.stringify(coverage.receipt,null,2)+'\n');
  const capturePlanFile=path.join(outputDir,'capture-plan.json');
  await writeCapturePlan(capturePlanFile,book.capturePlan);
  await exact(path.join(inputDir,'book.tagged.md'),book.tagged);
  // A resumed capture may already have materialized book.md. Do not revert it.
  const currentBook=await fs.readFile(path.join(inputDir,'book.md'),'utf8').catch(e=>{if(e.code==='ENOENT')return null;throw e;});
  if(currentBook===null)await exact(path.join(inputDir,'book.md'),book.tagged);
  else if(currentBook!==book.tagged&&currentBook!==book.materialized)throw new Error('source_book_conflict');
  const paragraphs=groupTranscriptSegments(segments),markdown=paragraphs.map(p=>p.text).join('\n\n');
  const media=captionMediaSource({markdown,paragraphs,bookMarkdown:book.materialized,
    inventory:book.imagePaths.map(name=>({path:name})),slug:path.basename(finalPath,'.md')});
  await exact(path.join(outputDir,'planned-media-source.md'),media.markdown);
  if(!captureFrames)captureFrames=async()=>{
    if(!cookiesFile)throw new Error('authenticated_capture_requires_cookies_file');
    await command(pythonPath,['-u',path.join(root,'capture-authenticated.py'),'--input',inputDir,
      '--cookies-file',cookiesFile,'--plan',capturePlanFile,'--report',path.join(outputDir,'capture-receipt.json')]);
    return readJson(path.join(outputDir,'capture-receipt.json'));
  };
  // Mathematical source fidelity precedes prose generation. Keep the original
  // strong prompt and old responses untouched; a corrected source gets its own
  // cache identity and single body call. Re-entry never recaptures these frames.
  if(requiresBoardCorrection(transcript,plan,processingOptions)){
    const corrected=await prepareBoardCorrection({inputDir,outputDir,transcript,plan,buildBook:buildMediaBook});
    if(!corrected){
      const request=path.join(outputDir,'frame-review-request.json');
      if(!await fs.stat(request).then(()=>true,()=>false))await captureFrames({inputDir,book,transcript});
      const pending={status:'needs_board_correction',output_type:OUTPUT_TYPE,mode_name:'图文模式',
        review_request:request,correction_file:path.join(outputDir,'board-correction.json'),
        model_route:modelRoute,correction_runner:path.join(root,'run-board-correction.mjs'),
        body_calls:0,guide_calls:0,published:false,source_unchanged:true};
      await fs.writeFile(path.join(outputDir,'board-correction-pending.json'),JSON.stringify(pending,null,2)+'\n');
      return pending;
    }
    await command(pythonPath,['-u',path.join(root,'admit-board-correction.py'),'--input',corrected.inputDir,'--run',corrected.outputDir]);
    const capture=await readJson(path.join(corrected.outputDir,'capture-receipt.json'));
    const correctedSegments=parseTranscript(corrected.transcript.segments.map(s=>'['+s.start+'] segment').join('\n'));
    correctedSegments.forEach((segment,index)=>segment.text=corrected.transcript.segments[index].text);
    const correctedParagraphs=groupTranscriptSegments(correctedSegments);
    const correctedMedia=captionMediaSource({markdown:correctedParagraphs.map(p=>p.text).join('\n\n'),paragraphs:correctedParagraphs,
      bookMarkdown:corrected.book.materialized,inventory:corrected.book.imagePaths.map(name=>({path:name})),slug:path.basename(finalPath,'.md')});
    event('board_corrected_strong_body','running',{body_prompt_unchanged:true,new_capture_calls:0});
    const refinement=await watchStage('board_corrected_strong_body',()=>refineBody({markdown:correctedMedia.markdown,mode:'strong_structuring',
      outputDir:path.join(corrected.outputDir,'preprocess/body-refinement'),
      generatedMedia:extractBookMedia(corrected.book.materialized,corrected.book.imagePaths.map(name=>({path:name})))
        .map(item=>({...item,literal:item.literal||imageEmbed(item.label,item.path)})),transcript:corrected.transcript}));
    const ledger=await readJson(path.join(outputDir,'board-correction.json'));
    const formulaCheck=checkFormulaConsistency(refinement.markdown,ledger.formula_notes.map(item=>item.text));
    await fs.writeFile(path.join(corrected.outputDir,'formula-consistency.json'),JSON.stringify(formulaCheck,null,2)+'\n');
    if(formulaCheck.status!=='passed'){
      const pending={status:'needs_formula_review',body_saved:true,published:false,
        body_calls:refinement.receipt.api_calls_this_run,guide_calls:0,body_regenerated:false,
        formula_review:path.join(corrected.outputDir,'formula-consistency.json')};
      await fs.writeFile(path.join(outputDir,'formula-review-pending.json'),JSON.stringify(pending,null,2)+'\n');
      return pending;
    }
    const receipt=await watchStage('board_corrected_reading_publication',()=>importTranscript({inputDir:corrected.inputDir,outputDir:corrected.outputDir,publishPath:finalPath,producer,
      processingOptions:{...processingOptions,source_language:processingOptions.source_language||'zh',
        content_profile:processingOptions.content_profile||'natural_language',structure_body:true,spoken_to_written:false},
      bodyRefiner:async({markdown:actual})=>{if(actual!==correctedMedia.markdown)throw Error('board_corrected_source_changed');return refinement;}}));
    const result={status:'completed',output_type:OUTPUT_TYPE,mode_name:'图文模式',upstream,publication:receipt.publication.markdown,
      counts:receipt.book_media.counts,execution_order:['capture','board_formula_correction','strong_structuring','media_projection','reading_guide'],
      board_correction:corrected.receipt,model_route:modelRoute,body_prompt_unchanged:true,upstream_prose_used:false,capture,
      body_calls:refinement.receipt.api_calls_this_run,guide_calls:receipt.reading_guide.calls,
      media_placement_calls:refinement.receipt.generated_media_projection?.placement_calls??0};
    await fs.writeFile(path.join(corrected.outputDir,'illustrated-receipt.json'),JSON.stringify(result,null,2)+'\n');
    await fs.writeFile(path.join(outputDir,'illustrated-receipt.json'),JSON.stringify(result,null,2)+'\n');
    return result;
  }
  event('parallel_capture_and_strong_body','running',book.counts);
  const started=Date.now();
  const heartbeat=setInterval(()=>event('parallel_capture_and_strong_body','waiting',{elapsed_seconds:Math.round((Date.now()-started)/1000)}),30000);
  let branches;
  try{branches=await Promise.allSettled([
    captureFrames({inputDir,book,transcript}),
    refineBody({markdown:media.markdown,mode:'strong_structuring',outputDir:path.join(outputDir,'preprocess/body-refinement'),
      generatedMedia:extractBookMedia(book.materialized,book.imagePaths.map(name=>({path:name}))).map(item=>({...item,literal:item.literal||imageEmbed(item.label,item.path)})),transcript})
  ]);}finally{clearInterval(heartbeat);}
  await fs.writeFile(path.join(outputDir,'branch-status.json'),JSON.stringify(branches.map((result,index)=>({
    branch:index===0?'upstream_capture':'strong_structuring',status:result.status,
    error:result.status==='rejected'?String(result.reason.message):null})),null,2)+'\n');
  for(const result of branches)if(result.status==='rejected')throw result.reason;
  if(branches[0].value.status==='needs_frame_review') {
    const pending={status:'needs_frame_review',output_type:OUTPUT_TYPE,mode_name:'图文模式',
      review_request:branches[0].value.review_request,review_file:branches[0].value.review_file,
      counts:book.counts,body_saved:true,body_calls:branches[1].value.receipt.api_calls_this_run,guide_calls:0,published:false};
    await fs.writeFile(path.join(outputDir,'illustrated-pending.json'),JSON.stringify(pending,null,2)+'\n');
    return pending;
  }
  if(branches[0].value.status!=='completed'||branches[0].value.frame_review?.status!=='passed')throw Error('capture_visual_review_not_passed');
  if(await fs.readFile(path.join(inputDir,'book.md'),'utf8')!==book.materialized)throw new Error('upstream_materialization_mismatch');
  const refinement=branches[1].value;
  event('standard_reading_publication','running');
  const receipt=await importTranscript({inputDir,outputDir,publishPath:finalPath,producer,
    processingOptions:{...processingOptions,source_language:processingOptions.source_language||'zh',
      content_profile:processingOptions.content_profile||'natural_language',structure_body:true,spoken_to_written:false},
    bodyRefiner:async({markdown:actual})=>{
      if(actual!==media.markdown)throw new Error('media_source_changed_between_branches');
      return refinement;
    }});
  const result={status:'completed',output_type:OUTPUT_TYPE,mode_name:'图文模式',upstream,publication:receipt.publication.markdown,
    counts:receipt.book_media.counts,parallel_branches:['upstream_capture','strong_structuring'],
    model_route:modelRoute,body_prompt_unchanged:true,upstream_prose_used:false,media_provenance:'screenshots_from_video; diagrams_generated_from_subtitle_evidence',
    capture:branches[0].value,body_calls:refinement.receipt.api_calls_this_run,guide_calls:receipt.reading_guide.calls,
    media_placement_calls:refinement.receipt.generated_media_projection?.placement_calls??0};
  await fs.writeFile(path.join(outputDir,'illustrated-receipt.json'),JSON.stringify(result,null,2)+'\n');
  return result;
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const args={};for(let i=2;i<process.argv.length;i+=2)args[process.argv[i].replace(/^--/u,'')]=process.argv[i+1];
  try{
    if(!resolveVideoMode(args.type).enabled)throw Error('illustrated_mode_requires_explicit_type');
    for(const name of ['input','output','publish'])if(!args[name])throw new Error('required_argument:'+name);
    const receipt=await importIllustratedStrong({inputDir:args.input,outputDir:args.output,publishPath:args.publish,
      cookiesFile:args['cookies-file'],pythonPath:args.python,processingOptions:args.options?await readJson(args.options):{}});
    event('illustrated',receipt.status,{...receipt,upstream:undefined,capture:undefined});
  }catch(error){console.error(error.message);process.exitCode=1;}
}
