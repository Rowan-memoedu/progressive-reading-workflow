import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { codeRoot, loadConfig, saveSource, deleteSource } from './config.mjs';
import { status, enqueue, enqueueVideoRequest, launchWorker, resolveMode, JOB_KINDS } from './service.mjs';

const assets = new Map([['/subscriptions',['index.html','text/html']],['/subscriptions/',['index.html','text/html']],
  ['/subscriptions/app.mjs',['app.mjs','text/javascript']],['/subscriptions/style.css',['style.css','text/css']]]);
const json=(res,code,value)=>{res.writeHead(code,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(value));};
export function assertLocalRequest(req) {
  const host = String(req.headers.host || '');
  if (!/^(127\.0\.0\.1|localhost):\d+$/u.test(host) || !['127.0.0.1','::1','::ffff:127.0.0.1'].includes(req.socket.remoteAddress)) throw new Error('仅允许本机访问');
  if (req.headers.origin && req.headers.origin !== 'http://'+host) throw new Error('请求来源不匹配，请从本地订阅页操作');
  if (req.headers['sec-fetch-site'] === 'cross-site') throw new Error('不接受跨站请求');
}
async function body(req) {
  if (!/^application\/json(?:;|$)/iu.test(req.headers['content-type'] || '')) throw new Error('需要 JSON 请求');
  let text=''; for await(const chunk of req){text+=chunk;if(Buffer.byteLength(text)>32768)throw new Error('请求过大');}
  return JSON.parse(text || '{}');
}
export async function handleSubscriptions(req,res,root=codeRoot) {
  const url=new URL(req.url,'http://127.0.0.1');
  if(!assets.has(url.pathname)&&!url.pathname.startsWith('/api/subscriptions'))return false;
  try {
    assertLocalRequest(req);
    if(assets.has(url.pathname)&&req.method==='GET') {
      const [file,type]=assets.get(url.pathname),content=await fs.readFile(path.join(codeRoot,'subscription-workflow','web',file));
      res.writeHead(200,{'Content-Type':type+'; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff',
        'Content-Security-Policy':"default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",'Referrer-Policy':'no-referrer'});
      res.end(content);return true;
    }
    if(req.method==='GET'&&url.pathname==='/api/subscriptions'){json(res,200,await status(root));return true;}
    if(req.method!=='POST'){json(res,405,{error:'此操作不支持该请求方法'});return true;}
    const input=await body(req);
    if(url.pathname==='/api/subscriptions/source') {
      const result=await saveSource(root,input.source,{expectedRevision:input.revision});
      json(res,200,result);
    } else if(url.pathname==='/api/subscriptions/source/delete') {
      json(res,200,await deleteSource(root,input.id,{expectedRevision:input.revision}));
    } else if(url.pathname==='/api/subscriptions/import-video') {
      if (!(await loadConfig(root))?.enabled) throw new Error('后台队列已暂停');
      const job=await enqueueVideoRequest(root,input,{retry:input.retry===true});
      json(res,202,{id:job.id,status:job.status,request:job.request});
      launchWorker(root).catch(error=>console.error('subscription_worker_start',error.message));
    } else if(url.pathname==='/api/subscriptions/run') {
      if(!JOB_KINDS.includes(input.kind))throw new Error('任务类型无效');
      if (!(await loadConfig(root))?.enabled) throw new Error('订阅流程已暂停');
      const job=await enqueue(root,input.kind,'manual-'+randomUUID());
      json(res,202,{id:job.id,status:job.status});
      launchWorker(root).catch(error=>console.error('subscription_worker_start',error.message));
    } else if(url.pathname==='/api/subscriptions/resolve') {
      json(res,200,await resolveMode(root,input.id,input.mode));
    } else if(url.pathname==='/api/subscriptions/open-report') {
      const current=await status(root),target=current.reports.find(file=>file===input.path);
      if(!target)throw new Error('报告不存在或不属于订阅报告');
      await fs.access(target);
      const child=spawn('notepad.exe',[target],{windowsHide:false,stdio:'ignore'});
      await new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject);});child.unref();
      json(res,200,{status:'opened'});
    } else json(res,404,{error:'接口不存在'});
  } catch(error) { json(res,400,{error:error.message}); }
  return true;
}
