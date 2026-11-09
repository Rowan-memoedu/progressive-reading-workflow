import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { codeRoot, initialize, paths, loadConfig, writeJson, withLock } from './config.mjs';
import { JOB_KINDS, enqueue, enqueueVideoRequest, launchWorker, drain, status, initializeActivity, localDate } from './service.mjs';

export async function main(argv=process.argv.slice(2)) {
  const command=argv[0],options={};
  for(let i=1;i<argv.length;i+=2)options[argv[i].replace(/^--/u,'')]=argv[i+1];
  const root=options.root?path.resolve(options.root):codeRoot;
  if(command==='init') {const config=await initialize(root);await initializeActivity(root);return {status:'initialized',enabled:config.enabled,subscriptions:config.subscriptions.length};}
  if(command==='activate')return withLock(paths(root).config+'.lock',async()=>{const config=await loadConfig(root);if(!config)throw new Error('请先初始化');await initializeActivity(root);config.enabled=true;config.revision++;await writeJson(paths(root).config,config);return {status:'active'};});
  if(command==='status')return status(root);
  if(command==='drain')return drain(root);
  if(command==='import-video') {
    if (!(await loadConfig(root))?.enabled) throw new Error('后台队列已暂停');
    const parts=options.parts ? options.parts.split(',').map(Number) : undefined;
    const job=await enqueueVideoRequest(root,{url:options.url,parts,destination:options.destination},{retry:options.retry==='true'});
    await launchWorker(root);
    return {id:job.id,status:job.status,request:job.request};
  }
  if(command==='run'||command==='enqueue') {
    if(!JOB_KINDS.includes(options.kind))throw new Error('需要 --kind rss|bilibili|zhihu|daily|weekly|decisions|retry');
    const job=await enqueue(root,options.kind,options.key||localDate());
    if(command==='enqueue')return {id:job.id,status:job.status};
    const result=await drain(root);return {job:job.id,...result};
  }
  throw new Error('用法：cli.mjs init|activate|status|drain|run --kind <来源或报告>');
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))main().then(v=>console.log(JSON.stringify(v,null,2))).catch(e=>{console.error(e.message);process.exitCode=1;});
