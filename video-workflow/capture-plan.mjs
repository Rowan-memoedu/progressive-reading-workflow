import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const seconds=t=>String(t).split(':').reduce((a,b)=>a*60+Number(b),0);
export async function writeCapturePlan(file,plan) {
  const value=JSON.stringify(plan,null,2)+'\n';
  const old=await fs.readFile(file,'utf8').catch(error=>{if(error.code==='ENOENT')return null;throw error;});
  if(old===null){await fs.writeFile(file,value,{flag:'wx'});return;}
  if(old===value)return;
  const previous=JSON.parse(old);
  const strip=record=>{const {candidates,...identity}=record;return identity;};
  const frozen=x=>JSON.stringify({...x,frames:x.frames.map(strip)});
  if(frozen(previous)!==frozen(plan))throw Error('capture_plan_identity_changed');
  if(await fs.stat(path.join(path.dirname(file),'frame-review.json')).then(()=>true,()=>false))throw Error('capture_plan_already_reviewed');
  if(await fs.stat(path.join(path.dirname(file),'frame-admission.json')).then(()=>true,()=>false))throw Error('capture_plan_already_admitted');
  for(let i=0;i<plan.frames.length;i++) {
    const frame=plan.frames[i];
    if(frame.candidates.length>3||new Set(frame.candidates).size!==frame.candidates.length||
      previous.frames[i].candidates.some(time=>!frame.candidates.includes(time))||
      frame.candidates.some(time=>seconds(time)<seconds(frame.requested_time)||seconds(time)>seconds(frame.window_end)))
      throw Error('capture_plan_not_bounded_extension');
  }
  const archive=path.join(path.dirname(file),'frozen-inputs');await fs.mkdir(archive,{recursive:true});
  const before=path.join(archive,'capture-plan-'+hash(old)+'.json');
  await fs.writeFile(before,old,{flag:'wx'}).catch(async error=>{if(error.code!=='EEXIST'||await fs.readFile(before,'utf8')!==old)throw error;});
  if(await fs.readFile(file,'utf8')!==old)throw Error('capture_plan_changed_concurrently');
  await fs.writeFile(file,value);
}
