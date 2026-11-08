import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fullTextBodyContext,refineFullTextOnce} from '../standard-preprocessing/lib/full-text-body.mjs';
import {verifyBookMedia} from './book-media.mjs';
import {loadProducerConfig} from '../standard-preprocessing/lib/producer.mjs';
const execute=promisify(execFile),hash=v=>createHash('sha256').update(v).digest('hex');
const read=async file=>JSON.parse(await fs.readFile(file,'utf8'));
const python=process.env.PR_AUDIO_PYTHON||'D:/AppData/AudioWorkflow/python/Scripts/python.exe';
const missingProtectedMedia=/protected_image_has_no_ordered_bounds|protected_nonimage_missing|protected_source_missing_or_duplicated|protected_source_reordered/u;

// Keep the normal body stage and its cache identity. Recovery may only consume
// the completed response from that same stage; it must never request new prose.
export function withCachedMediaRestoration(producer,{generatedMedia,transcript},recover=refineAndProjectGeneratedMedia){
  if(!generatedMedia.length||typeof producer.refineFullText!=='function')return producer;
  const wrapped=Object.create(producer);
  wrapped.refineFullText=async input=>{
    try{return await producer.refineFullText(input);}
    catch(error){
      if(input.mode!=='strong_structuring'||!missingProtectedMedia.test(error.message))throw error;
      return recover({...input,generatedMedia,transcript,producerConfig:producer.config,requireCachedResponse:true});
    }
  };
  return wrapped;
}

export function projectGeneratedMedia(prose,media,placement){
  const lines=prose.split('\n');
  const addressed=placement.anchor_protocol==='frozen_line_address/v1';
  if(addressed&&placement.prose_sha256!==hash(prose))throw new Error('media_placement_source_changed');
  if(!Array.isArray(placement.items)||placement.items.length!==media.length)throw new Error('media_placement_count_mismatch');
  const seen=new Set(),adds=new Map(),validLines=new Set();let fence=null;
  lines.forEach((line,index)=>{
    const marker=/^\s*(?:-\s+)?(`{3,}|~{3,})(.*)$/u.exec(line);
    if(marker){if(!fence)fence=marker[1][0];else if(marker[1][0]===fence&&!marker[2].trim())fence=null;return;}
    if(!fence&&/^ *- \S/u.test(line))validLines.add(index+1);
  });
  const offsets=[];let offset=0;for(const line of lines){offsets.push(offset);offset+=line.length+1;}
  for(const item of placement.items){
    if(!Number.isInteger(item.media_id)||item.media_id<0||item.media_id>=media.length||seen.has(item.media_id))throw new Error('media_placement_identity_mismatch');
    seen.add(item.media_id);
    const sourceLine=lines[item.target_line-1];
    if(!validLines.has(item.target_line)||!addressed&&sourceLine!==item.exact_line)throw new Error('media_placement_not_exact_source_line');
    const indent=/^( *)- /u.exec(sourceLine)[1].length;
    let end=item.target_line;
    while(end<lines.length){
      const next=lines[end];
      if(/^#{1,6} /u.test(next)||next.trim()&&/^( *)\S/u.exec(next)[1].length<=indent)break;
      end++;
    }
    while(end>item.target_line&&!lines[end-1].trim())end--;
    const point=offsets[end-1]+lines[end-1].length;
    const literal=media[item.media_id].literal;
    const insertion='\n'+' '.repeat(indent)+'- '+literal.replaceAll('\n','\n'+' '.repeat(indent+2));
    adds.set(point,[...(adds.get(point)||[]),{media_id:item.media_id,insertion,target_line:item.target_line}]);
  }
  const insertions=[];let shift=0;
  for(const [point,items]of [...adds].sort(([a],[b])=>a-b)){
    items.sort((a,b)=>a.media_id-b.media_id);
    const text=items.map(i=>i.insertion).join('');
    insertions.push({input_offset:point,output_offset:point+shift,text,media_ids:items.map(i=>i.media_id)});shift+=text.length;
  }
  let output=prose;for(const insertion of [...insertions].reverse())output=output.slice(0,insertion.input_offset)+insertion.text+output.slice(insertion.input_offset);
  let restored=output;for(const insertion of [...insertions].reverse()){
    if(restored.slice(insertion.output_offset,insertion.output_offset+insertion.text.length)!==insertion.text)throw new Error('media_insertion_not_exact');
    restored=restored.slice(0,insertion.output_offset)+restored.slice(insertion.output_offset+insertion.text.length);
  }
  if(restored!==prose)throw new Error('media_merge_changed_prose');
  return {markdown:output,insertions,prose_sha256:hash(prose),output_sha256:hash(output),prose_unchanged:true};
}

export async function refineAndProjectGeneratedMedia({markdown,mode,outputDir,cacheDir,producerConfig,generatedMedia,transcript,requireCachedResponse=false}){
  producerConfig ||= await loadProducerConfig({requiredProvider:'codex_exec'});
  const {target,producerIdentity}=await fullTextBodyContext({markdown,mode,cacheDir,producerConfig,requiredProvider:'codex_exec'});
  outputDir ||= path.join(target,'media-restoration');
  for(const name of ['refinement-receipt.json','attempt-1.response.json']){
    const old=await read(path.join(outputDir,name)).catch(error=>{if(error.code==='ENOENT')return null;throw error;});
    if(old&&(old.provider!=='codex_exec'||old.model!==producerIdentity[2]))throw Error('body_audit_backend_change_requires_new_output_directory');
  }
  const responseFile=path.join(target,'attempt-1.response.json');
  const existed=await fs.stat(responseFile).then(()=>true,()=>false);
  if(!existed){
    if(requireCachedResponse)throw new Error('media_restoration_requires_saved_body_response');
    try{await refineFullTextOnce({markdown,mode,cacheDir,producerConfig,producerIdentity,requiredProvider:'codex_exec'});}
    catch(error){if(!missingProtectedMedia.test(error.message))throw error;}
  }
  const saved=await read(responseFile);
  if(saved.provider!=='codex_exec'||saved.model!==producerIdentity[2])throw Error('body_cache_producer_mismatch');
  const pending=path.join(outputDir,'generated-media-projection');await fs.mkdir(pending,{recursive:true});
  const mediaFile=path.join(pending,'media.json');
  const mediaBytes=JSON.stringify(generatedMedia,null,2)+'\n';
  const previous=await fs.readFile(mediaFile,'utf8').catch(e=>{if(e.code==='ENOENT')return null;throw e;});
  if(previous!==null&&previous!==mediaBytes)throw new Error('generated_media_changed');
  await fs.writeFile(mediaFile,mediaBytes);
  await execute(python,['-u',path.join(import.meta.dirname,'prepare-media-projection.py'),'--cache',target,'--media',mediaFile,'--output',pending],{windowsHide:true,maxBuffer:1024*1024});
  const prose=await fs.readFile(path.join(pending,'prose.md'),'utf8');
  const lines=prose.split('\n').map((text,index)=>({line:index+1,text}));
  const toSeconds=t=>String(t).split(':').reduce((n,v)=>n*60+Number(v),0);
  const items=generatedMedia.map((m,media_id)=>({media_id,kind:m.kind,title:m.section,seconds:m.seconds,
    source_context:transcript.segments.filter(s=>Math.abs(toSeconds(s.start)-m.seconds)<=25).map(s=>s.text).join('')}));
  const mappingInput=path.join(pending,'placement-input.json');
  await fs.writeFile(mappingInput,JSON.stringify({lines,media:items},null,2)+'\n');
  console.log(JSON.stringify({stage:'media_placement',status:'running',media:items.length,body_regenerated:false}));
  await execute(python,['-u',path.join(import.meta.dirname,'plan-media-placement.py'),'--input',mappingInput,'--output',path.join(pending,'placement')],{windowsHide:true,maxBuffer:1024*1024,
    env:{...process.env,...Object.fromEntries(Object.entries(producerConfig).map(([key,value])=>[key,String(value)])),PR_READING_NODE:process.execPath}});
  const placement=await read(path.join(pending,'placement/plan.json'));
  const merged=projectGeneratedMedia(prose,generatedMedia,placement);
  verifyBookMedia(merged.markdown,generatedMedia,'');
  await fs.writeFile(path.join(pending,'projection.json'),JSON.stringify({...merged,markdown:undefined},null,2)+'\n');
  for(const name of ['original.md','prompt.md','source-protocol.md','model-prompt.md','model-input.md','input-identity.json','protected-spans.json','attempt-1.response.json'])
    await fs.copyFile(path.join(target,name),path.join(outputDir,name));
  await fs.writeFile(path.join(outputDir,'body.md'),merged.markdown);
  const identity=await read(path.join(target,'input-identity.json')),raw=await read(responseFile);
  const receipt={...identity,status:'completed',name:'强结构化整理',api_calls_total:1,api_calls_this_run:existed?0:1,
    response_sha256:hash(await fs.readFile(responseFile)),body_sha256:merged.output_sha256,usage:raw.usage,transport_capabilities:raw.transport,
    generated_media_projection:{...merged,markdown:undefined,media:generatedMedia.length,cached_body_required:requireCachedResponse,
      placement_calls:(await read(path.join(pending,'placement/receipt.json'))).api_calls_this_run},
    source_lineage:'complete_source_to_single_body; generated_media_inserted_at_exact_frozen_outline_anchors',
    semantic_acceptance:'user_review_required',audit_dir:outputDir,cache_dir:target};
  await fs.writeFile(path.join(outputDir,'refinement-receipt.json'),JSON.stringify(receipt,null,2)+'\n');
  return {markdown:merged.markdown,receipt};
}
