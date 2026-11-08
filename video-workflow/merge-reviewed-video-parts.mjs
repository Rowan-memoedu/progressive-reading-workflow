import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {extractBookMedia,imageEmbed} from './book-media.mjs';
const hash=b=>createHash('sha256').update(b).digest('hex');
const json=v=>JSON.stringify(v,null,2)+'\n';
const sec=t=>String(t).split(':').reduce((sum,n)=>sum*60+Number(n),0);
const stamp=n=>[Math.floor(n/3600),Math.floor(n/60)%60,n%60].map(v=>String(v).padStart(2,'0')).join(':');
async function exact(file,bytes){await fs.mkdir(path.dirname(file),{recursive:true});try{await fs.writeFile(file,bytes,{flag:'wx'});}catch(e){if(e.code!=='EEXIST'||hash(await fs.readFile(file))!==hash(bytes))throw Error('collection_output_conflict');}}
const read=async f=>JSON.parse(await fs.readFile(f,'utf8'));

// Parts are acquired and visually admitted separately. Only their time axes and
// image filenames change here; prose is authored once from the combined source.
export async function mergeReviewedVideoParts({parts,outputDir,title}){
  if(!Array.isArray(parts)||parts.length<2||new Set(parts.map(p=>p.part)).size!==parts.length)throw Error('collection_ordered_parts_required');
  if(parts.some((p,i)=>!Number.isInteger(p.part)||i&&p.part!==parts[i-1].part+1))throw Error('collection_parts_not_consecutive');
  const prepared=[];
  for(const part of parts){
    const inputDir=path.resolve(part.inputDir),runDir=path.resolve(part.runDir),file=path.join(inputDir,'transcript.json');
    const bytes=await fs.readFile(file),transcript=JSON.parse(bytes),capture=await read(path.join(runDir,'capture-receipt.json'));
    if(capture.status!=='completed'||capture.frame_review?.status!=='passed')throw Error('collection_part_frame_review_required');
    if(!new URL(transcript.video_url).searchParams.get('p')||Number(new URL(transcript.video_url).searchParams.get('p'))!==part.part)throw Error('collection_part_url_mismatch');
    if(sec(transcript.segments.at(-1).end)<Number(transcript.duration)*.8)throw Error('collection_part_subtitles_incomplete');
    const inventory=capture.frames.map(f=>({path:'images/'+f.file}));
    const book=await fs.readFile(path.join(inputDir,'book.md'),'utf8'),media=extractBookMedia(book,inventory);
    for(const image of media.filter(m=>m.kind==='image')){
      const recorded=capture.frames.find(f=>'images/'+f.file===image.path);
      if(!recorded||hash(await fs.readFile(path.join(inputDir,image.path)))!==recorded.sha256)throw Error('collection_image_changed');
    }
    prepared.push({...part,inputDir,runDir,bytes,transcript,capture,media,book});
  }
  const segments=[],chapters=[],origins=[],assets=[],book=['# '+title];let offset=0;
  for(const part of prepared){
    const startIndex=segments.length;
    for(const [index,s] of part.transcript.segments.entries())segments.push({...s,start:stamp(sec(s.start)+offset),end:stamp(sec(s.end)+offset),source_part:part.part,source_segment_index:index});
    const end=offset+Math.ceil(Number(part.transcript.duration));
    chapters.push({start:stamp(offset),end:stamp(end),title:part.transcript.title,part:part.part});
    for(const unit of part.media){
      const globalTime=stamp(Math.floor(unit.seconds)+offset);book.push('## '+unit.section,'*(参考时间: '+globalTime+')*');
      if(unit.kind==='image'){
        const target='images/shot_'+globalTime.replaceAll(':','_')+'.png',bytes=await fs.readFile(path.join(part.inputDir,unit.path));
        assets.push({target,bytes,part:part.part,original:unit.path,sha256:hash(bytes)});book.push(imageEmbed(unit.label,target));
      }else book.push(unit.literal);
    }
    const board=await read(path.join(part.inputDir,'board-correction-receipt.json')).catch(e=>{if(e.code==='ENOENT')return null;throw e;});
    if(board&&board.corrected_transcript_sha256!==hash(part.bytes))throw Error('collection_board_source_changed');
    origins.push({part:part.part,title:part.transcript.title,source_url:part.transcript.video_url,input_dir:part.inputDir,run_dir:part.runDir,
      transcript_sha256:hash(part.bytes),offset_seconds:offset,duration_seconds:Number(part.transcript.duration),segments:part.transcript.segments.length,
      first_combined_segment:startIndex,last_combined_segment:segments.length-1,frame_review_sha256:part.capture.frame_review.review_sha256,board_correction:board});
    offset=end;
  }
  const transcript={video_id:prepared[0].transcript.video_id.replace(/_p\d+$/u,'')+'_p'+parts[0].part+'-'+parts.at(-1).part,
    video_url:prepared[0].transcript.video_url,title,duration:offset,chapters,segments,source_parts:origins.map(p=>({part:p.part,title:p.title,source_url:p.source_url}))};
  const manifest={version:'reviewed-video-collection/v1',parts:origins,segments:segments.length,duration_seconds:offset,
    timestamp_transform:'part_local_time_plus_offset',subtitle_texts_unchanged:true,body_calls_before_merge:0,
    images:assets.map(({bytes,...a})=>a),media_count:prepared.reduce((n,p)=>n+p.media.length,0)};
  // All source checks above finish before the first output write.
  await exact(path.join(outputDir,'transcript.json'),json(transcript));
  await exact(path.join(outputDir,'book.md'),book.join('\n\n')+'\n');
  for(const asset of assets)await exact(path.join(outputDir,asset.target),asset.bytes);
  for(const part of prepared){
    await exact(path.join(outputDir,'parts','p'+part.part,'transcript.json'),part.bytes);
    await exact(path.join(outputDir,'parts','p'+part.part,'book.md'),part.book);
    for(const name of ['transcript.original.json','transcript.original.txt','subtitles.srt','board-correction.json','board-correction-receipt.json']){
      const bytes=await fs.readFile(path.join(part.inputDir,name)).catch(e=>{if(e.code==='ENOENT')return null;throw e;});
      if(bytes)await exact(path.join(outputDir,'parts','p'+part.part,name),bytes);
    }
  }
  await exact(path.join(outputDir,'collection-manifest.json'),json(manifest));
  return {transcript,manifest,inputDir:path.resolve(outputDir)};
}
