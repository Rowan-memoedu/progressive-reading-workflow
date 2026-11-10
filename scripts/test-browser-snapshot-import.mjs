import assert from "node:assert/strict";
import fs from "node:fs/promises";
import vm from "node:vm";
import { webcrypto } from "node:crypto";
import { startFixture } from "./browser-import-web/fixture.mjs";
import { BrowserImportBroker } from "./browser-import-broker.mjs";

// Real HTTP publication, isolated storage and a fresh broker instance.
const fixture = await startFixture();
const json = async (route, body) => {
  const response = await fetch(fixture.baseUrl + route, body ? {method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)} : {});
  assert.ok(response.ok, await response.clone().text());
  return response.json();
};
try {
  const draft = { id:"snapshot-test",url:fixture.sourceUrl+"/snapshot-only",title:"捕获快照",revision:0,annotations:[],qaCards:[],
    html:String.raw`<article><h1>捕获快照</h1><p>来自页面快照的正文，仅用于验收。这里保留公式 <span class="katex"><math><semantics><mi>x</mi><annotation encoding="application/x-tex">x^2</annotation></semantics></math><span class="katex-html">x2</span></span>，以及下标 <span class="ztext-math" data-eeimg="1" data-tex="a_1">a_1</span>。</p><p><span class="ztext-math" data-eeimg="2" data-tex="\begin{pmatrix}a&amp;b\\c&amp;d\end{pmatrix}">矩阵</span></p></article>`,
    sourceMetadata:{input_form:"written",content_profile:"natural_language",language:"zh"},processingOptions:{translate:false,include_reading_guide:true} };
  const payload={draft,async:true,client_request_id:"snapshot-canary"};
  const created=await json("/api/highlights/import-local",payload);
  assert.equal((await json("/api/highlights/import-local",payload)).request_id,created.request_id);
  let result;
  for(let i=0;i<100;i++) { const request=await json(`/api/browser-import/requests/${created.request_id}`); if(request.terminal){result=request.results[0];break;} await new Promise(resolve=>setTimeout(resolve,100)); }
  assert.equal(result?.status,"saved_locked",JSON.stringify(result));
  const markdown=await fs.readFile(result.artifacts.find(item=>item.kind==="markdown").path,"utf8");
  assert.ok(markdown.includes("来自页面快照的正文"));
  assert.ok(markdown.includes("$x^2$"));
  assert.ok(markdown.includes("$a_1$"));
  assert.ok(markdown.includes("$$\n\\begin{pmatrix}a&b\\\\c&d\\end{pmatrix}\n$$"), "Chinese non-translation publication must preserve display math and matrix row separators");
  assert.equal(fixture.hits.length,0,"snapshot import must not refetch the URL");
  const duplicate=await json('/api/highlights/import-local',{...payload,client_request_id:'snapshot-other-entry'});
  let replay;
  for(let i=0;i<100;i++){const request=await json('/api/browser-import/requests/'+duplicate.request_id);if(request.terminal){replay=request.results[0];break;}await new Promise(resolve=>setTimeout(resolve,100));}
  assert.equal(replay?.status,'idempotent_replay');
  assert.equal(replay.receipt.model_calls,0);
  assert.equal(replay.artifacts[0].path,result.artifacts[0].path);
  assert.equal(await fs.readFile(replay.artifacts[0].path,'utf8'),markdown,'ordinary snapshot import preserves existing content');
  const legacyForce=await json('/api/highlights/import-local',{...payload,client_request_id:'snapshot-legacy-explicit-reimport',draft:{...draft,html:draft.html.replace('</article>','<p>用户明确重新导入时新增的来源内容。</p></article>'),locked:false,submittedAt:new Date().toISOString(),receipt:result,importJob:{clientRequestId:'legacy-explicit'}}});
  let replaced;
  for(let i=0;i<100;i++){const request=await json('/api/browser-import/requests/'+legacyForce.request_id);if(request.terminal){replaced=request.results[0];break;}await new Promise(resolve=>setTimeout(resolve,100));}
  assert.equal(replaced?.status,'saved_locked','already-loaded extension workers retain explicit reimport support');
  assert.match(await fs.readFile(replaced.artifacts[0].path,'utf8'),/用户明确重新导入时新增的来源内容/u);
  const brokerRoot=fixture.workflowRoot+"/.local-ir/browser-import-broker";
  // The runtime health describes the authoritative broker location.
  const health=await json("/api/highlights/health");
  const root=health.browserImportBroker?.stateRoot || brokerRoot;
  const restarted=new BrowserImportBroker({stateRoot:root});
  const persisted=await restarted.getRequest(created.request_id);
  assert.equal(persisted?.terminal,true,"server state must survive a fresh broker instance");
  console.log(JSON.stringify({snapshot:"passed",request:created.request_id,root:fixture.root}));
} finally {await fixture.stop();}

// A new extension service-worker context shares only Chrome storage. It must
// recover the queued request without re-posting or exposing a false success.
const [coreSource,backgroundSource]=await Promise.all([fs.readFile(new URL("../browser-highlight-extension/draft-core.js",import.meta.url),"utf8"),fs.readFile(new URL("../browser-highlight-extension/background.js",import.meta.url),"utf8")]);
const storage={}; let posts=0; let terminal=false; let lastClientId;
function worker() {
  let listener;
  const noop={addListener(){}};
  const chrome={runtime:{lastError:null,onInstalled:noop,onStartup:noop,onSuspend:noop,onMessage:{addListener(value){listener=value;}}},storage:{local:{get(defaults,done){done(structuredClone({...defaults,...storage}));},set(values,done){Object.assign(storage,structuredClone(values));done();}}},tabs:{query(_query,done){done([]);},onRemoved:noop},contextMenus:{onClicked:noop}};
  const sandbox={chrome,crypto:webcrypto,URL,Response,AbortController,console,setTimeout,clearTimeout,fetch:async(url,options={})=>{
    let data={};
    if(String(url).endsWith("/api/highlights/import-local")){posts++; const body=JSON.parse(options.body);assert.equal(body.async,true);lastClientId=body.client_request_id;data={request_id:"job-1",terminal:false,status:"queued",results:[]};}
    if(String(url).includes("/api/browser-import/requests/job-1")) data={request_id:"job-1",terminal,status:terminal?"completed":"processing",results:[{status:terminal?"saved_locked":"claimed",stage:"reading_guide",receipt:{quality_status:"ready"}}]};
    return new Response(JSON.stringify(data));
  }};
  const context=vm.createContext(sandbox);
  sandbox.importScripts=()=>vm.runInContext(coreSource,context);
  vm.runInContext(backgroundSource,context);
  return message=>new Promise(resolve=>listener(message,{},resolve));
}
let send=worker(); const url="https://example.org/durable";
await send({type:"draft-upsert",draft:{url,html:"<p>快照</p>",sourceMetadata:{local_ir_authoring_initialized:false}}});
const accepted=await send({type:"draft-import-local",url});
assert.equal(accepted.pending,true); assert.equal(accepted.draft.locked,false);assert.ok(lastClientId);
send=worker(); const resumed=await send({type:"draft-get",url});
assert.equal(resumed.draft.importJob.stage,"reading_guide");assert.equal(posts,1);
terminal=true;const finished=await send({type:"draft-get",url});
assert.equal(finished.draft.status,"saved_locked");assert.equal(posts,1);
terminal=false;await send({type:"draft-import-local",url,force:true});assert.equal(posts,2);
console.log("worker_restart_and_forced_reimport: passed");

// Pre-upgrade drafts have no durable job. Report the interruption, retain the
// captured input, and leave reimport available instead of spinning forever.
const legacyUrl="https://example.org/interrupted-before-upgrade";
storage.localIrBrowserDrafts[legacyUrl]={url:legacyUrl,html:"<p>保留的来源快照</p>",status:"submitting",submitMode:"standard_preprocess",locked:false};
send=worker();
const interrupted=await send({type:"draft-get",url:legacyUrl});
assert.equal(interrupted.draft.status,"error");
assert.equal(interrupted.draft.locked,false);
assert.equal(interrupted.draft.html,"<p>保留的来源快照</p>");
assert.match(interrupted.draft.lastError,/没有收到完成回执/);
assert.equal(posts,2,"legacy draft recovery must not silently submit another import");
console.log("legacy_interrupted_import_recovery: passed");
