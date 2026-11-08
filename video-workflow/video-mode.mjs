import {fileURLToPath} from 'node:url';
import path from 'node:path';

export function resolveVideoMode(value) {
  if(value===undefined||value===null||value===''||value==='transcript')
    return {id:'transcript',name:'字幕模式',enabled:false,explicit:value==='transcript',entry:'import-transcript.mjs'};
  if(['illustrated','图文模式','illustrated_strong'].includes(value))
    return {id:'illustrated',name:'图文模式',enabled:true,explicit:true,entry:'illustrated-strong.mjs'};
  throw new Error('unknown_video_mode:'+String(value));
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(resolveVideoMode(process.argv[2]))); }
  catch(error) { console.error(error.message);process.exitCode=1; }
}
