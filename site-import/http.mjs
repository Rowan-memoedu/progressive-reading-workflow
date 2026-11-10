import fs from 'node:fs/promises';
import path from 'node:path';
import { assertLocalRequest } from '../subscription-workflow/http.mjs';
import { readSources, saveSiteSource, listRuns, readRun, CODE_ROOT } from './store.mjs';
import { startSiteRun } from './tasks.mjs';

const assets=new Map([['/imports',['index.html','text/html']],['/imports/',['index.html','text/html']],['/imports/app.mjs',['app.mjs','text/javascript']],['/imports/style.css',['style.css','text/css']]]);
const send=(res,status,value)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(value));};
function brief(run){if(!run)return null;const {collection,results,...rest}=run;return {...rest,result_count:results?.length||0,index:collection?.verification?.index||null,excluded_count:collection?.inventory?.excluded_count||0,error:collection?.error||null};}
export async function handleImportCenter(req,res,{root,broker,runRequest,legacyJobs=()=>[]}={}) {
  const url=new URL(req.url,'http://127.0.0.1');
  if(!assets.has(url.pathname)&&!url.pathname.startsWith('/api/site-imports')&&!url.pathname.startsWith('/api/import-center'))return false;
  try{
    assertLocalRequest(req);
    if(assets.has(url.pathname)&&req.method==='GET'){
      const [file,type]=assets.get(url.pathname),content=await fs.readFile(path.join(CODE_ROOT,'site-import','web',file));
      res.writeHead(200,{'Content-Type':type+'; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer',
        'Content-Security-Policy':"default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'"});res.end(content);return true;
    }
    if(req.method==='GET'&&url.pathname==='/api/site-imports'){
      const config=await readSources(root),runs=await listRuns(root);
      send(res,200,{...config,sources:config.sources.map(source=>({...source,last_run:brief(runs.find(run=>run.source_id===source.id))})),runs:runs.slice(0,30).map(brief)});return true;
    }
    if(req.method==='GET'&&url.pathname==='/api/import-center/history'){
      send(res,200,{requests:await broker.listRequestSummaries({sources:['web_import_page','web_import_center']}),legacy_jobs:legacyJobs()});return true;
    }
    const detail=/^\/api\/site-imports\/runs\/(site-run-[a-f0-9]{24})$/u.exec(url.pathname);
    if(req.method==='GET'&&detail){const run=await readRun(root,detail[1]);send(res,run?200:404,run || {error:'导入记录不存在'});return true;}
    if(req.method!=='POST'){send(res,405,{error:'此操作不支持该请求方法'});return true;}
    if(!/^application\/json(?:;|$)/iu.test(req.headers['content-type']||''))throw new Error('需要 JSON 请求');
    let text='';for await(const chunk of req){text+=chunk;if(Buffer.byteLength(text)>100000)throw new Error('请求过大');}
    const input=JSON.parse(text||'{}');
    if(url.pathname==='/api/site-imports/source')send(res,200,await saveSiteSource(root,input.source,input.revision));
    else if(url.pathname==='/api/site-imports/start')send(res,202,brief(await startSiteRun(root,input,broker,runRequest)));
    else send(res,404,{error:'接口不存在'});
  }catch(error){send(res,400,{error:error.message});}
  return true;
}
