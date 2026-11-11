import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {initialize,paths,writeJson,readJson,normalizeSource,loadConfig} from '../subscription-workflow/config.mjs';
import {diagnoseImportIssue,subscriptionImportIssues} from '../subscription-workflow/import-issues.mjs';
import {savedReadingBody} from '../subscription-workflow/reading-body.mjs';
import {startFixture} from '../scripts/browser-import-web/fixture.mjs';
import {JSDOM} from 'jsdom';

const wait=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn){for(let i=0;i<200;i++){const result=await fn();if(result)return result;await wait(100);}throw Error('fixture_timeout');}
test('body recognition accepts original imports and rejects an empty processed body',()=>{
  assert.deepEqual(savedReadingBody('---\nsource_url: https://fixture.test/a\n---\n# Title\n\nOriginal body.\n\n^pr-123456789abc'),{body:'Original body.',structured:false});
  assert.deepEqual(savedReadingBody('# Title\n\n## 阅读前置卡\nGuide\n\n## 正文\n\n---\n\n## 原文\n'),{body:'',structured:true});
});

test('optional provenance warnings can publish through the real background worker and reuse existing annotations',async()=>{
  const f=await startFixture();
  try{
    await fs.mkdir(path.join(f.root,'rss'),{recursive:true});
    await fs.writeFile(path.join(f.root,'rss','RSS 自动导入.md'),'```json\n{"enabled":false}\n```\n## ① 标准流程导入\n## ② 原文直接导入\n## ③ 日报与周报\n');
    await writeJson(path.join(f.root,'video','watchlist.json'),{watches:[]});
    await writeJson(path.join(f.root,'video','state.json'),{entries:{}});
    const config=await initialize(f.workflowRoot,{home:path.join(f.root,'subscriptions'),rssHome:path.join(f.root,'rss'),videoHome:path.join(f.root,'video')});
    config.enabled=true;
    const source=normalizeSource({kind:'zhihu_author',name:'合成停用来源',url:'https://www.zhihu.com/people/fixture',mode:'reports',enabled:false});
    config.subscriptions=[source];await writeJson(paths(f.workflowRoot).config,config);
    const original='# Original title\n\n'+('A complete original paragraph with evidence and examples.\n\n').repeat(30);
    const requestPath=path.join(f.root,'source-request.json');
    const request={source_metadata:{source_url:'https://fixture.test/article',translation:{is_translation:false}},material:{markdown:original}};
    await writeJson(requestPath,request);
    const item={material_id:'fixture-warning',title:'缺字段的完整原文',item_url:request.source_metadata.source_url,subscription_ids:[source.id],platform:'zhihu',route:'long_review',decision:'unresolved',eligible_for_preprocess:true,content_status:'fulltext_ready',preprocess_request_path:requestPath,review_preview:{status:'failed',error:'invalid pending classification result {"instancePath":"/source_metadata/translation","missingProperty":"original_url"}'}};
    await writeJson(path.join(f.workflowRoot,'imports/rss-reading/review-ledger.v1.json'),{items:{[item.material_id]:item}});
    const diagnosis=await diagnoseImportIssue(f.workflowRoot,item,config);
    assert.equal(diagnosis.can_import,true);assert.equal(diagnosis.source_paused,true);assert.match(diagnosis.message,/原文链接、原文语言、译文语言/u);assert.doesNotMatch(diagnosis.message,/instancePath|missingProperty|\\u[0-9a-f]/u);
    const missing={...item,preprocess_request_path:path.join(f.root,'missing.json')};
    await writeJson(missing.preprocess_request_path,{...request,material:{markdown:''}});
    assert.equal((await diagnoseImportIssue(f.workflowRoot,missing,config)).can_import,false);
    const wrong={...item,review_preview:{error:'watch_pipeline_identity_changed'}};
    assert.equal((await diagnoseImportIssue(f.workflowRoot,wrong,config)).can_import,false);
    const mismatched={...item,preprocess_request_path:path.join(f.root,'mismatch.json')};
    await writeJson(mismatched.preprocess_request_path,{...request,source_metadata:{source_url:'https://different.test/article'}});
    assert.equal((await diagnoseImportIssue(f.workflowRoot,mismatched,config)).can_import,false);
    const html=await (await fetch(f.baseUrl+'/subscriptions')).text(),code=await (await fetch(f.baseUrl+'/subscriptions/app.mjs')).text();
    const dom=new JSDOM(html,{url:f.baseUrl+'/subscriptions',runScripts:'outside-only'});
    const calls=[];dom.window.fetch=(url,options)=>{calls.push([url,options]);return fetch(new URL(url,f.baseUrl),options);};
    dom.window.setInterval=()=>0;dom.window.crypto.randomUUID=randomUUID;dom.window.AbortController=AbortController;
    await dom.window.eval('(async()=>{'+code+'})()');
    const button=[...dom.window.document.querySelectorAll('button')].find(b=>b.textContent==='仍要导入原文');assert.ok(button,dom.window.document.body.textContent);button.click();
    await until(()=>calls.some(([url])=>url==='/api/subscriptions/import-warning'));
    const submission=JSON.parse(calls.find(([url])=>url==='/api/subscriptions/import-warning')[1].body);
    const post=async input=>{const response=await fetch(f.baseUrl+'/api/subscriptions/import-warning',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(input)});return {response,data:await response.json()};};
    const accepted=await post(submission);assert.equal(accepted.response.status,202);
    const result=await until(async()=>{const row=await (await fetch(f.baseUrl+'/api/browser-import/requests/'+accepted.data.request_id)).json();return row.terminal?row:null;});
    assert.equal(result.subscription_material_id,item.material_id);assert.equal(result.results[0].status,'imported_with_warnings',JSON.stringify(result));
    assert.equal(result.results[0].receipt.llm_used,false);
    const publication=result.results[0].artifacts.find(a=>a.kind==='markdown');assert.ok(publication);
    const text=await fs.readFile(publication.path,'utf8');assert.ok(text.includes(original.trim()));
    assert.deepEqual(await readJson(requestPath),request,'source cache is immutable');
    await fs.appendFile(publication.path,'\n> 用户批注，重复导入应保留。\n');
    const annotated=await fs.readFile(publication.path,'utf8');
    const again=await post({...submission,client_request_id:randomUUID()});
    const reused=await until(async()=>{const row=await (await fetch(f.baseUrl+'/api/browser-import/requests/'+again.data.request_id)).json();return row.terminal?row:null;});
    assert.equal(reused.results[0].artifacts.find(a=>a.kind==='markdown').path,publication.path);
    assert.equal(await fs.readFile(publication.path,'utf8'),annotated);
    assert.equal((await loadConfig(f.workflowRoot)).subscriptions[0].enabled,false);
    const current=await (await fetch(f.baseUrl+'/api/subscriptions')).json();assert.equal(current.import_issues[0].can_import,false);assert.equal(current.import_issues[0].status,'imported_with_warnings');
    const badItem={...missing,material_id:'missing-body'};
    await writeJson(path.join(f.workflowRoot,'imports/rss-reading/review-ledger.v1.json'),{items:{[badItem.material_id]:badItem}});
    const blocked=await post({id:badItem.material_id,client_request_id:randomUUID()});assert.equal(blocked.response.status,400);assert.match(blocked.data.error,/完整正文/u);
    const corrupt={...item,preprocess_request_path:path.join(f.root,'corrupt.json')};await fs.writeFile(corrupt.preprocess_request_path,'{"broken');
    assert.equal((await subscriptionImportIssues(f.workflowRoot,[corrupt]))[0].can_import,false);
    dom.window.close();
  }finally{await f.stop();}
});
