// Audio-only adapter over existing yt-dlp, scoped cookies and the global ASR CLI.
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {spawn} from 'node:child_process';
import {withCaptureCookies,VIDEO_PYTHON} from '../watch-illustrated.mjs';
const require=createRequire(import.meta.url);
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const exists=file=>fs.stat(file).then(()=>true,e=>{if(e.code==='ENOENT')return false;throw e;});
const read=async file=>JSON.parse(await fs.readFile(file,'utf8'));

function command(exe,args,{json=false}={}){
  return new Promise((resolve,reject)=>{
    const child=spawn(exe,args,{windowsHide:true,env:{...process.env,PYTHONIOENCODING:'utf-8'},stdio:['ignore','pipe','pipe']});
    let stdout='';
    child.stdout.on('data',chunk=>{stdout+=chunk.toString('utf8');});
    // Never echo stderr because download or ASR exceptions can include credentials/URLs.
    child.stderr.on('data',()=>{});
    child.on('error',()=>reject(Error('audio_source_command_start_failed')));
    child.on('close',code=>{
      if(code!==0)return reject(Error('audio_source_command_failed:'+code));
      try{resolve(json?JSON.parse(stdout.replace(/^\uFEFF/u,'')):null);}catch{reject(Error('audio_source_invalid_receipt'));}
    });
  });
}

export function validateReceipt(raw,audio,provider){
  if(raw.schema_version!==1||raw.source_sha256!==audio.sha256||!raw.route||!raw.utterances?.length)
    throw Error('audio_transcription_source_mismatch');
  if((['bailian','tingwu'].includes(provider)||raw.route==='standard'||raw.cleanup) &&
    (raw.cleanup?.deleted!==true||raw.cleanup?.prefix_empty!==true))throw Error('audio_cloud_cleanup_unverified');
}

export async function prepareAudioSource(item,output){
  const {readCues,timestamp,exact}=require(process.env.MATH_LECTURE_LOCAL_SOURCE_MODULE || 'D:/Projects/BaiduVideoNotes/lib/local-source.cjs');
  const root=path.resolve(output,'audio-sources',item.bvid+'-cid'+item.cid);
  await fs.mkdir(root,{recursive:true});
  await exact(path.join(root,'job.json'),JSON.stringify(item,null,2)+'\n');
  const heartbeat=setInterval(()=>console.log(JSON.stringify({stage:'audio_source',part:item.part,status:'running'})),30000);
  try{
    const audioReceipt=path.join(root,'audio','audio.json');
    if(!await exists(audioReceipt)){
      await withCaptureCookies(item.url,cookies=>command(VIDEO_PYTHON,[path.join(import.meta.dirname,'download-audio.py'),
        '--job',path.join(root,'job.json'),'--cookies-file',cookies,'--output',path.join(root,'audio')]));
    }
    const audio=await read(audioReceipt);
    if(audio.cid!==item.cid||audio.video_id!==item.bvid+'_p'+item.part||hash(await fs.readFile(audio.path))!==audio.sha256)
      throw Error('audio_cache_identity_mismatch');
    const asr=path.join(root,'asr'),rawFile=path.join(asr,'raw.json'),stateFile=path.join(root,'asr-receipt.json');
    let state;
    if(await exists(stateFile))state=await read(stateFile);
    else{
      const cli=path.join(process.env.USERPROFILE,'.codex','skills','global-transcription','scripts','transcribe.py');
      const status=await command('python',[cli,'provider','status'],{json:true}),provider=status.default_provider;
      if(!['bailian','doubao','tingwu','funasr'].includes(provider))throw Error('timestamped_asr_provider_required');
      const doctor=await command('python',[cli,'doctor','--provider',provider],{json:true});
      if(doctor.providers?.[provider]?.callable!==true)throw Error('configured_asr_provider_unavailable');
      // A complete raw result survives an interruption before saving this adapter's receipt.
      if(!await exists(rawFile)){
        const receipt=await command('python',[cli,'transcribe',audio.path,'--provider',provider,'--route','auto','--output-dir',asr],{json:true});
        if(receipt.ok!==true||receipt.source_sha256!==audio.sha256||receipt.provider!==provider||path.resolve(receipt.output_dir||'')!==asr)
          throw Error('audio_asr_receipt_mismatch');
      }
      const raw=await read(rawFile);validateReceipt(raw,audio,provider);
      state={provider,audio_sha256:audio.sha256,raw_sha256:hash(await fs.readFile(rawFile)),cleanup:raw.cleanup||null};
      await exact(stateFile,JSON.stringify(state,null,2)+'\n');
    }
    const raw=await read(rawFile);validateReceipt(raw,audio,state.provider);
    if(state.audio_sha256!==audio.sha256||state.raw_sha256!==hash(await fs.readFile(rawFile)))throw Error('audio_asr_artifact_changed');
    const srt=await fs.readFile(path.join(asr,'subtitles.srt')),{cues}=readCues(srt,audio.duration);
    if(cues.length!==raw.utterances.length||cues.some((c,i)=>c.startMs!==raw.utterances[i].start_ms||c.endMs!==raw.utterances[i].end_ms||c.text!==raw.utterances[i].text.trim()))
      throw Error('audio_asr_timestamps_mismatch');
    const sourceDir=path.join(root,'source');
    const transcript={video_id:item.bvid+'_p'+item.part,cid:item.cid,title:item.part_title,
      video_url:item.url,source_url:item.url,duration:audio.duration,chapters:[],asr_used:true,asr_provider:state.provider,
      segments:cues.map(c=>({start:timestamp(c.startMs),end:timestamp(c.endMs),text:c.text}))};
    await exact(path.join(sourceDir,'transcript.json'),JSON.stringify(transcript,null,2)+'\n');
    await exact(path.join(sourceDir,'subtitles.srt'),srt);
    await exact(path.join(sourceDir,'source.json'),JSON.stringify({subtitle_kind:'global-transcription',audio_only:true,
      video_id:transcript.video_id,cid:item.cid,asr:state},null,2)+'\n');
    return {sourceDir,subtitle_kind:'global-transcription'};
  }finally{clearInterval(heartbeat);}
}
