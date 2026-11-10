import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { gzipSync } from 'node:zlib';
import { pathToFileURL } from 'node:url';
import { JSDOM } from 'jsdom';
import { startFixture } from '../scripts/browser-import-web/fixture.mjs';
import { digest } from '../subscription-workflow/config.mjs';

const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn){const end=Date.now()+120000;while(Date.now()<end){const value=await fn();if(value)return value;await delay(150);}throw new Error('site_acceptance_timeout');}
test('new entry imports original, reuses annotated archived RSS source, persists and safely repeats',{timeout:180000},async()=>{
  const root=await fs.mkdtemp('D:/Artifacts/ProgressiveReading/site-e2e-'),hits=[];
  const original='# Independent source\n\n这是独立站点的完整合成原文，不应翻译或改写。\n\n## 公式与代码\n\n$x^2+y^2=z^2$\n\n```python\nprint("original")\n```\n\n[站内链接](/posts/old)\n\n最后一段：逐字保留的正文。\n';
  const server=http.createServer((req,res)=>{hits.push(req.url);const url=new URL(req.url,'http://fixture');res.setHeader('content-type','application/json');
    if(url.pathname==='/')res.end('<title>Independent</title><script src="/main.js"></script>');
    else if(url.pathname==='/robots.txt')res.end('');
    else if(url.pathname==='/sitemap.xml')res.end('<urlset><url><loc>'+origin+'/posts/old</loc></url></urlset>');
    else if(url.pathname==='/main.js')res.end('const url:"/reading"; const url:"/catalog"; const articleContent="payload";');
    else if(url.pathname==='/catalog')res.end(JSON.stringify({total:3,items:[{slug:'old'},{slug:'new'},{slug:'secret',private:true}].slice(0,Number(url.searchParams.get('size')))}));
    else if(url.pathname==='/reading')res.end(JSON.stringify({document:{slug:url.searchParams.get('slug'),title:'Independent '+url.searchParams.get('slug'),payload:gzipSync(original).toString('base64'),series:{title:'Independent course',entries:[{slug:'old'},{slug:'new'}]},labels:['Topic','Second topic']}}));
    else{res.writeHead(404);res.end('{}');}
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin='http://127.0.0.1:'+server.address().port;
  const planPath=path.join(root,'plan.json');await fs.writeFile(planPath,JSON.stringify({include_paths:['/posts/*'],exclude_paths:[],article_source:{type:'json',url_template:origin+'/reading?slug={path.last}',title_path:'document.title',content_path:'document.payload',identity_path:'document.slug',encoding:'base64_gzip',content_format:'markdown',taxonomy:{collection_path:'document.series',collection_name_path:'title',collection_items_path:'entries',tags_path:'document.labels'}},listing:{url:origin+'/catalog?size=1',total_path:'total',items_path:'items',item_url_template:origin+'/posts/{item.slug}',private_path:'private',limit_parameter:'size'}}));
  const fixture=await startFixture({sitePlanPath:planPath});let dom,mounted;
  try{
    const archived=path.join(fixture.workflowRoot,'已归档原文','RSS','annotated.md'),old='---\nsource_url: '+origin+'/reader?slug=old\n---\n\n原有 RSS 文章\n\n==人工高亮== 与批注必须保留。\n';
    await fs.mkdir(path.dirname(archived),{recursive:true});await fs.writeFile(archived,old);
    const requestFile=path.join(fixture.workflowRoot,'rss-request.json');await fs.writeFile(requestFile,JSON.stringify({source_metadata:{source_url:origin+'/reader?slug=old',canonical_url:origin+'/reader?slug=old',original_url:origin+'/posts/old',original_source_ref:'item-page-original-markdown'}}));
    await fs.mkdir(path.join(fixture.workflowRoot,'imports/rss-reading'),{recursive:true});await fs.writeFile(path.join(fixture.workflowRoot,'imports/rss-reading/review-ledger.v1.json'),JSON.stringify({items:{old:{material_id:'old',item_url:origin+'/reader?slug=old',preprocess_request_path:requestFile,publication:{path:archived}}}}));
    for(const route of ['/','/import','/import/']){const response=await fetch(fixture.baseUrl+route,{redirect:'manual'});assert.equal(response.status,302);assert.ok(response.headers.get('location').startsWith('/imports'));}
    const html=await (await fetch(fixture.baseUrl+'/imports')).text();
    const code=(await fs.readFile(new URL('../site-import/web/app.mjs',import.meta.url),'utf8')).replace("'/import/client.mjs'",JSON.stringify(pathToFileURL(path.resolve('scripts/browser-import-web/client.mjs')).href));
    const {mountImportCenter}=await import('data:text/javascript;base64,'+Buffer.from(code).toString('base64'));
    const fetchImpl=(route,options)=>fetch(fixture.baseUrl+route,options);
    dom=new JSDOM(html,{url:fixture.baseUrl+'/imports'});const doc=dom.window.document;
    mounted=mountImportCenter(doc,{fetchImpl,pollMs:100000});await mounted.refresh();await delay(100);
    doc.getElementById('site-add').click();doc.getElementById('site-url').value=origin;doc.getElementById('site-name').value='Independent';doc.getElementById('site-mode').value='original_text';doc.getElementById('site-mode').dispatchEvent(new dom.window.Event('change'));
    doc.getElementById('site-form').dispatchEvent(new dom.window.Event('submit',{cancelable:true}));
    await until(()=>doc.querySelector('.source-actions button:not(.secondary)'));
    doc.querySelector('.source-actions button:not(.secondary)').click();
    const state=await until(async()=>{const data=await (await fetch(fixture.baseUrl+'/api/site-imports')).json();const run=data.runs[0];if(run&&['completed','failed','completed_with_failures'].includes(run.phase))return data;});
    assert.equal(state.runs[0].phase,'completed',JSON.stringify(state.runs[0]));assert.deepEqual(state.runs[0].counts,{discovered:2,imported:1,reused:1,warnings:0,failed:0,waiting:0});
    const run=await (await fetch(fixture.baseUrl+'/api/site-imports/runs/'+state.runs[0].id)).json();
    const fresh=run.results.find(r=>r.requested_url.endsWith('/new'));assert.equal(fresh.receipt.processing_mode,'original_text');assert.equal(fresh.receipt.llm_used,false);
    const output=fresh.artifacts.find(a=>a.kind==='markdown');const bytes=await fs.readFile(output.path);assert.equal(digest(bytes),output.sha256);assert.ok(bytes.toString('utf8').includes(original.trim()));
    assert.equal(await fs.readFile(archived,'utf8'),old);assert.equal(hits.some(url=>url.includes('slug=secret')),false);assert.equal(run.collection.inventory.excluded_count,1);assert.equal(run.collection.verification.verified,2);
    assert.match(await fs.readFile(run.collection.verification.index,'utf8'),/合集/u);
    const course=path.join(path.dirname(run.collection.verification.index),'合集','Independent course','目录.md');assert.match(await fs.readFile(course,'utf8'),/已归档原文/u);
    assert.equal(path.dirname(output.path),path.dirname(course));assert.equal(run.collection.verification.groups.length,3);
    mounted.stop();dom.window.close();dom=new JSDOM(html,{url:fixture.baseUrl+'/imports'});mounted=mountImportCenter(dom.window.document,{fetchImpl,pollMs:100000});await delay(100);await mounted.refresh();
    assert.match(dom.window.document.getElementById('site-sources').textContent,/新增 1 · 复用 1/u);
    await mounted.start(state.sources[0]);
    const repeated=await until(async()=>{const data=await (await fetch(fixture.baseUrl+'/api/site-imports')).json();return data.runs.length===2&&data.runs[0].phase==='completed'?data.runs[0]:null;});
    assert.equal(repeated.counts.imported,0);assert.equal(repeated.counts.reused,2);assert.equal(await fs.readFile(archived,'utf8'),old);
    // The ordinary/RSS publication identity remains available after a site import.
    const {findSourcePublication}=await import('../scripts/reading-source-library.mjs');assert.equal((await findSourcePublication(fixture.workflowRoot,origin+'/posts/new#fragment')).path,output.path);
    // A different process (e.g. RSS) can publish after URL preflight but before
    // original-text commit. The shared commit lock must recheck and reuse it.
    const racedUrl=fixture.sourceUrl+'/slow-during-rss';
    const accepted=await (await fetchImpl('/api/browser-import/requests',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({urls:[racedUrl],client_request_id:'original-rss-race',processing_mode:'original_text',destination_folder:'链接/另一目录'})})).json();
    await until(()=>fixture.hits.some(url=>url.startsWith('/slow-during-rss')));
    const rssPath=path.join(fixture.workflowRoot,'待归档原文','rss-race.md'),rssBody='---\nsource_url: '+racedUrl+'\n---\nRSS 正文与人工批注。\n';await fs.mkdir(path.dirname(rssPath),{recursive:true});await fs.writeFile(rssPath,rssBody);
    const raced=await until(async()=>{const data=await (await fetchImpl('/api/browser-import/requests/'+accepted.request_id)).json();return data.terminal?data.results[0]:null;});
    assert.equal(raced.status,'idempotent_replay',JSON.stringify(raced));assert.equal(raced.artifacts[0].path,rssPath);assert.equal(await fs.readFile(rssPath,'utf8'),rssBody);
    await fs.writeFile(path.join(root,'acceptance.json'),JSON.stringify({status:'passed',first:state.runs[0],repeat:repeated,old_hash:digest(old),new_hash:output.sha256,private_fetches:0},null,2));
  }finally{mounted?.stop();dom?.window.close();await fixture.stop();server.closeAllConnections();await new Promise(r=>server.close(r));}
});
