import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

export async function resolveSubtitleSource(root,url,baseId) {
  const part=Number(new URL(url).searchParams.get('p')||1);
  if(!Number.isInteger(part)||part<1)throw Error('invalid_video_part');
  const bili=/^BV[0-9A-Za-z]{10}$/u.test(baseId);
  const names=bili?[`${baseId}_p${part}`,...(part===1?[baseId]:[])]:[baseId];
  for(const name of names) {
    const inputDir=path.resolve(root,name),file=path.join(inputDir,'transcript.json');
    let transcript;
    try{transcript=JSON.parse(await fs.readFile(file,'utf8'));}
    catch(error){if(error.code==='ENOENT')continue;throw error;}
    if(transcript.video_id!==name)throw Error('subtitle_identity_mismatch');
    if(bili&&new URL(transcript.video_url).pathname.match(/BV[0-9A-Za-z]{10}/u)?.[0]!==baseId)throw Error('subtitle_source_mismatch');
    return {input_dir:inputDir,video_id:name};
  }
  throw Error('saved_subtitle_not_found_for_requested_video_part');
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  try{console.log(JSON.stringify(await resolveSubtitleSource(...process.argv.slice(2))));}
  catch(error){console.error(error.message);process.exitCode=1;}
}
