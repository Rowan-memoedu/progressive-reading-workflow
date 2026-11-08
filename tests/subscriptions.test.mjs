import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { initialize, paths, normalizeSource, saveSource, loadConfig, writeJson, readJson, digest } from '../subscription-workflow/config.mjs';
import { saveSourceMaterial, canonicalCatalog } from '../subscription-workflow/catalog.mjs';
import { autoConfig, prepareVideoPreview, discoverAuthor, retryAuto, scanZhihu, scanVideos, replayRssHistory } from '../subscription-workflow/adapters.mjs';
import { enqueue, jobList, monitorMarkdown, resolveMode, drain, appendActivity, weekKey } from '../subscription-workflow/service.mjs';
import { assertLocalRequest, handleSubscriptions } from '../subscription-workflow/http.mjs';
import { syncLedger, loadLedger, workflowPaths, generateSummaries, prepareSubscriptionPreviews, processMarkdownDecisions, writeLocalIrLaterHandoff } from '../rss-reading/core.mjs';
import { processPending, discover, observe } from '../video-workflow/watch-core.mjs';
import { RssImporter } from '../rss-import/core.mjs';
import { syncFeedDocument } from '../rss-source/core.mjs';
import { shortKey, rollShortReports } from '../subscription-workflow/report-archive.mjs';

const artifact='D:/Artifacts/ProgressiveReading/subscriptions-20261106/tests';
const previousRssHome=process.env.RSS_IMPORT_HOME;
test.afterEach(()=>{if(previousRssHome===undefined)delete process.env.RSS_IMPORT_HOME;else process.env.RSS_IMPORT_HOME=previousRssHome;});
async function fixture(){
  await fs.mkdir(artifact,{recursive:true});const root=await fs.mkdtemp(path.join(artifact,'case-')),home=path.join(root,'home'),rssHome=path.join(root,'rss-home'),videoHome=path.join(root,'video-home');
  await fs.mkdir(rssHome,{recursive:true});
  await fs.writeFile(path.join(rssHome,'RSS 自动导入.md'),'```json\n{"enabled":false}\n```\n## ① 标准流程导入\nA：https://a.test/feed\n## ② 原文直接导入\n## ③ 日报与周报\nB：https://b.test/feed\n');
  await writeJson(path.join(videoHome,'watchlist.json'),{watches:[]});await writeJson(path.join(videoHome,'state.json'),{entries:{}});
  process.env.RSS_IMPORT_HOME=rssHome;
  const config=await initialize(root,{home,rssHome,videoHome});config.enabled=true;await writeJson(paths(root).config,config);
  const reading=workflowPaths(root);await fs.mkdir(path.join(root,'阅读区'),{recursive:true});
  await writeJson(reading.legacyLedgerPath,{schema_version:'progressive-reading.rss-legacy-review-ledger/v1',decisions:Array.from({length:22},(_,i)=>({decision_id:'legacy-'+i,item_url:'https://legacy.test/'+i,title:'历史 '+i,decision:i<14?'formal_selected':'unresolved'}))});
  const source=normalizeSource({kind:'zhihu_author',name:'测试作者',url:'https://www.zhihu.com/people/example',mode:'reports',destination:'知乎'});
  config.subscriptions.push(source);await writeJson(paths(root).config,config);
  return {root,home,rssHome,videoHome,config,source,reading};
}
async function addText(f,{url='https://zhuanlan.zhihu.com/p/123',markdown='完整论证与实例。'.repeat(240),source=f.source}={}){
  return saveSourceMaterial(f.root,source,{url,title:'测试文章',published_at:'2026-11-05T00:00:00Z'},markdown);
}
async function previewRunner({item,request}){return {result:{status:'completed',processing_state:'rendered',translation_state:'not_translation',artifacts:{target_zone:'local-ir-reading',semantic:{judgments:{value:{level:'high',reason:'有完整推导'},density:{level:'high'},continue_reading:{level:'yes'}},insights:[{description:'核心命题与推导。'}]},reading_markdown:`# 中文标题\n\n## 阅读前置卡\n\n提示\n\n---\n\n## 正文\n\n${request.material.markdown}\n\n---\n\n## 原文\n\n${request.material.markdown}`}}};}

test('legacy migration keeps routes; edits are revision-checked; Bilibili original mode is rejected',async()=>{
  const f=await fixture();assert.deepEqual(f.config.subscriptions.slice(0,2).map(s=>s.mode),['standard_preprocess','reports']);
  assert.throws(()=>normalizeSource({kind:'bilibili_video',name:'视频',url:'https://www.bilibili.com/video/BV1234567890/',mode:'original_text'}),/不提供/);
  assert.throws(()=>normalizeSource({kind:'rss',name:'本地',url:'http://127.0.0.1/a'}),/公开网站/);
  assert.throws(()=>normalizeSource({kind:'rss',name:'a',url:'https://a.test/',destination:'../逃逸'}),/相对目录/);
  await saveSource(f.root,{id:f.source.id,name:'新名称'},{expectedRevision:f.config.revision});
  await assert.rejects(saveSource(f.root,{id:f.source.id,name:'陈旧名称'},{expectedRevision:f.config.revision}),/另一处/);
  assert.equal((await loadConfig(f.root)).subscriptions.at(-1).name,'新名称');
});

test('canonical identity retains explicit decisions and freezes revised body while preserving memberships',async()=>{
  const f=await fixture(),first=await addText(f);let synced=await syncLedger(f.root);const original=synced.ledger.items[first.material_id];
  original.decision='dismissed';original.review_preview={status:'ready'};const revision=original.source_revision;await writeJson(f.reading.ledgerPath,synced.ledger);
  const second=normalizeSource({kind:'zhihu_column',name:'第二来源',url:'https://zhuanlan.zhihu.com/example',mode:'reports'});
  f.config.subscriptions.push(second);await writeJson(paths(f.root).config,f.config);
  await addText(f,{source:second,markdown:'新修订文本。'.repeat(280)});
  synced=await syncLedger(f.root);assert.equal(synced.catalog.items.length,1);const item=synced.ledger.items[first.material_id];
  assert.equal(item.decision,'dismissed');assert.equal(item.source_revision,revision);assert.ok(item.available_revision);assert.equal(item.subscription_ids.length,2);
  const repeat=await syncLedger(f.root);assert.equal(repeat.ledger.items[first.material_id].available_revision.detected_at,item.available_revision.detected_at);
});

test('unchanged full text does not trigger a revision merely because metadata changed',async()=>{
  const f=await fixture(),record=await addText(f);const synced=await syncLedger(f.root);const item=synced.ledger.items[record.material_id];item.review_preview={status:'ready'};await writeJson(f.reading.ledgerPath,synced.ledger);
  const catalog=await canonicalCatalog(f.root,[]);assert.equal(catalog[0].preservedSourceRevision,item.source_revision);
  const after=await syncLedger(f.root);assert.equal(after.ledger.items[record.material_id].available_revision,undefined);
});

test('saved checkbox becomes a durable action and uses existing article without changing annotations',async()=>{
  const f=await fixture(),record=await addText(f);const report=await generateSummaries(f.root,{date:'2026-11-06',mode:'daily',previewRunner});
  const target=report.outputs.daily.path,body=await fs.readFile(target,'utf8');await fs.writeFile(target,body.replace('- [ ] 正式入库','- [x] 正式入库'));
  const queued=await processMarkdownDecisions(f.root,{enqueueOnly:true});assert.equal(queued.queued,1);
  const article=path.join(f.root,'阅读区','已有文章.md');const content='---\nsource_url: https://zhuanlan.zhihu.com/p/123\n---\n正文与用户批注\n';await fs.writeFile(article,content);
  const done=await processMarkdownDecisions(f.root,{runner:()=>{throw Error('must not regenerate');}});assert.equal(done.completed.length,1);assert.equal(await fs.readFile(article,'utf8'),content);
  const second=await processMarkdownDecisions(f.root);assert.equal(second.completed.length,0);
  const later=await writeLocalIrLaterHandoff(f.root,record.material_id,{vaultRoot:f.root,sidecarRoot:path.join(f.root,'sidecars')});
  const side=await readJson(later.sidecar_path);side.annotations=[{id:'keep',text:'我的批注'}];side.qaCards=[{id:'qa'}];await writeJson(later.sidecar_path,side);
  await writeLocalIrLaterHandoff(f.root,record.material_id,{vaultRoot:f.root,sidecarRoot:path.join(f.root,'sidecars')});assert.deepEqual((await readJson(later.sidecar_path)).annotations,side.annotations);
});

test('file monitor waits for stable save then queues once; job identity survives repeated ticks',async()=>{
  const f=await fixture();await fs.mkdir(paths(f.root).summaryRoot,{recursive:true});const file=path.join(paths(f.root).summaryRoot,'2026-11-06 订阅 日报.md');await fs.writeFile(file,'- [x] 已保存');
  assert.equal((await monitorMarkdown(f.root,1000)).queued,0);assert.equal((await monitorMarkdown(f.root,30000)).queued,0);assert.equal((await monitorMarkdown(f.root,46000)).queued,1);assert.equal((await monitorMarkdown(f.root,61000)).queued,0);
  const job=await enqueue(f.root,'rss','2026-11-06');assert.equal((await enqueue(f.root,'rss','2026-11-06')).id,job.id);assert.equal((await jobList(f.root)).length,2);
});

test('mode conflicts stop one material only; stored resolution restarts it without a model-mode ambiguity',async()=>{
  const f=await fixture(),config=autoConfig(f.config);config.subscriptions.push({url:'https://second.test/feed',route:'original_text',destination:'RSS'});config.feeds.push('https://second.test/feed');
  const importer=await new RssImporter({home:f.rssHome,workflowRoot:f.root}).load();
  importer.state.items={a:{id:'a',url:'https://example.test/a',feeds:[config.feeds[0],config.feeds[1]],status:'pending',attempt:0,attempts:[]},b:{id:'b',url:'https://example.test/b',feeds:[config.feeds[0]],status:'pending',attempt:0,attempts:[]}};
  await importer.advance(config,{base:'unused'});assert.equal(importer.state.items.a.status,'route_conflict');assert.equal(importer.state.items.b.status,'processing');
  await resolveMode(f.root,'a','original_text');await importer.load();assert.deepEqual(importer.importModes(importer.state.items.a,config),['original_text']);assert.equal(importer.state.items.a.status,'pending');
});

test('blocked video retries at most once per cycle and does not replay completed units',async()=>{
  const state={entries:{a:{key:'a',status:'blocked'},b:{key:'b',status:'completed',publication:'exists'}}};let attempts=0;const args={save:async()=>{},processItem:async()=>{attempts++;throw Error('source unavailable');},retryCycle:'day1'};
  await processPending(state,args);await processPending(state,args);assert.equal(attempts,1);await processPending(state,{...args,retryCycle:'day2'});assert.equal(attempts,2);assert.equal(state.entries.b.status,'completed');
});

test('auto imports retry only once in each cycle and preserve existing published body',async()=>{
  const f=await fixture();await writeJson(path.join(f.rssHome,'state.json'),{schema:'progressive-reading.rss-auto-import/v1',feeds:{},items:{a:{id:'a',url:'https://a.test/story',title:'故障文章',feeds:['https://a.test/feed'],status:'source_blocked',attempts:[]}}});
  assert.equal((await retryAuto(f.root,'rss','day1')).retried,1);let state=await readJson(path.join(f.rssHome,'state.json'));state.items.a.status='source_blocked';await writeJson(path.join(f.rssHome,'state.json'),state);
  assert.equal((await retryAuto(f.root,'rss','day1')).retried,0);assert.equal((await retryAuto(f.root,'rss','day2')).retried,1);
});

test('a multi-P subscription does not silently expand into the containing collection',async()=>{
  const result=await discover({url:'https://www.bilibili.com/video/BV1234567890/',collection:false},{api:async()=>({bvid:'BV1234567890',title:'单视频',pages:[{cid:11,page:1,part:'P1'}],ugc_season:{id:9,ep_count:20}})});
  assert.equal(result.items.length,1);assert.equal(result.season_id,null);
  const state={entries:{}};const item=result.items[0];observe(state,{id:'one',destination:'D:/reading'},[item],{baseline:true});observe(state,{id:'two',destination:'D:/reading'},[item]);assert.deepEqual(state.entries[item.key].watch_ids,['one','two']);assert.equal(state.entries[item.key].status,'baseline');
});

test('video preview includes the entire subtitle sequence and does not call illustrated production',async()=>{
  const f=await fixture(),source=normalizeSource({kind:'bilibili_video',name:'视频',url:'https://www.bilibili.com/video/BV1234567890/',mode:'reports'});
  const item={key:'bilibili:BV1234567890:11',bvid:'BV1234567890',cid:11,url:source.url,part:1,parts:1,video_title:'视频',publish_path:path.join(f.root,'阅读区','视频.md')};
  const result=await prepareVideoPreview(f.root,source,item,{id:'video'}, {artifactRoot:path.join(f.root,'video-artifacts'),acquire:async(i,w,job)=>{const sourceDir=path.join(job,'source');await writeJson(path.join(sourceDir,'source.json'),{cid:i.cid,canonical_url:i.url});await writeJson(path.join(sourceDir,'transcript.json'),{cid:i.cid,video_url:i.url,segments:[{text:'开头完整句'},{text:'中间推导'},{text:'最后总结'}]});return {sourceDir};}});
  assert.equal(result.status,'awaiting_review');const record=await readJson(path.join(paths(f.root).sources,result.material_id,'record.json'));const request=await readJson(record.preprocess_request);assert.equal(request.material.markdown,'开头完整句\n\n中间推导\n\n最后总结');assert.equal(record.subtitle_segments,3);
});

test('Zhihu paginates both own answers and articles; incomplete listing does not establish baseline',async()=>{
  const f=await fixture();const listed=await discoverAuthor(f.source,{},async url=>({data:url.includes('/answers?')?[{id:1,question:{id:2,title:'问题'},created_time:100,content:'正文'}]:[{id:3,title:'文章',created:101,content:'原文'}],paging:{is_end:true}}));assert.equal(listed.length,2);
  await assert.rejects(discoverAuthor(f.source,{},async()=>({data:[],paging:{is_end:false}})),/缺少后续页/);
  const first=await scanZhihu(f.root,'day1',{access:()=>({}),discoverMember:async()=>listed});assert.equal(first.errors.length,0);assert.equal(Object.keys((await readJson(path.join(f.home,'zhihu-state.json'))).entries).length,0);
  await scanZhihu(f.root,'day2',{access:()=>({}),discoverMember:async()=>[...listed,{url:'https://zhuanlan.zhihu.com/p/4',title:'新文章',html:'<article><h1>新文章</h1><p>新正文内容</p></article>'}]});const state=await readJson(path.join(f.home,'zhihu-state.json'));assert.equal(Object.values(state.entries).length,1);assert.equal(Object.values(state.entries)[0].status,'ready');
});

test('subscription write boundary rejects cross-origin and DNS-rebinding hosts',()=>{
  const req={headers:{host:'127.0.0.1:37829',origin:'http://127.0.0.1:37829'},socket:{remoteAddress:'127.0.0.1'}};assert.doesNotThrow(()=>assertLocalRequest(req));
  assert.throws(()=>assertLocalRequest({...req,headers:{...req.headers,origin:'https://outside.test'}}),/来源不匹配/);
  assert.throws(()=>assertLocalRequest({...req,headers:{host:'outside.test:37829'}}),/本机/);
});

test('HTTP configuration API persists validated edits and rejects a cross-origin write',async()=>{
  const f=await fixture();const server=http.createServer((req,res)=>{handleSubscriptions(req,res,f.root).catch(error=>{res.writeHead(500);res.end(error.message);});});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const base='http://127.0.0.1:'+server.address().port;
  try {
    const get=await fetch(base+'/api/subscriptions');assert.equal(get.status,200);const config=await get.json();
    const change={revision:config.revision,source:{id:f.source.id,name:'通过网页 API 修改'}};
    const denied=await fetch(base+'/api/subscriptions/source',{method:'POST',headers:{'Content-Type':'application/json',Origin:'https://outside.test'},body:JSON.stringify(change)});assert.equal(denied.status,400);
    const accepted=await fetch(base+'/api/subscriptions/source',{method:'POST',headers:{'Content-Type':'application/json',Origin:base},body:JSON.stringify(change)});assert.equal(accepted.status,200);assert.equal((await loadConfig(f.root)).subscriptions.at(-1).name,change.source.name);
  }finally{await new Promise(resolve=>server.close(resolve));}
});

test('weekly rollover leaves one active decision point and a functioning link in the daily report',async()=>{
  const f=await fixture(),record=await addText(f);const daily=await generateSummaries(f.root,{date:'2026-11-06',mode:'daily',previewRunner});
  const weekly=await generateSummaries(f.root,{date:'2026-11-08',week:'2026-W45',mode:'weekly',previewRunner});
  const ledger=await loadLedger(f.root);assert.equal(ledger.items[record.material_id].delivery.active_review_path,weekly.outputs.long_weekly.path);
  const historical=await fs.readFile(ledger.report_runs.daily['2026-11-06'].archived_path,'utf8');assert.ok(historical.includes(path.basename(weekly.outputs.long_weekly.path)));assert.ok(!historical.includes('- [ ] 正式入库'));
  const currentLink=/请在 \[[^\]]+\]\(<([^>]+)>\)/u.exec(historical)[1];
  assert.equal(path.resolve(path.dirname(ledger.report_runs.daily['2026-11-06'].archived_path),decodeURI(currentLink)),weekly.outputs.long_weekly.path);
  await assert.rejects(fs.access(daily.outputs.daily.path),{code:'ENOENT'});
  const before=await fs.readFile(weekly.outputs.long_weekly.path,'utf8');await fs.writeFile(weekly.outputs.long_weekly.path,before.replace('- [ ] 正式入库','- [x] 正式入库'));
  await fs.writeFile(path.join(f.root,'阅读区','原文.md'),'---\nsource_url: https://zhuanlan.zhihu.com/p/123\n---\n既有正文\n');
  await monitorMarkdown(f.root,1000);await monitorMarkdown(f.root,46000);const result=await drain(f.root);assert.ok(result.completed.length>0);assert.ok((await loadLedger(f.root)).items[record.material_id].publication.preserved_existing);
  assert.equal((await jobList(f.root)).filter(j=>j.status==='failed').length,0);
});

test('weekly rollover resets multi-select, moves unchecked cards and rejects stale weekly edits',async()=>{
  const f=await fixture();
  const multiple=await addText(f,{url:'https://zhuanlan.zhihu.com/p/700'});
  const unchecked=await addText(f,{url:'https://zhuanlan.zhihu.com/p/701'});
  const dismissed=await addText(f,{url:'https://zhuanlan.zhihu.com/p/702'});
  const first=await generateSummaries(f.root,{mode:'weekly',week:'2026-W44',previewRunner});
  const old=first.outputs.long_weekly.path;
  const edit=(text,id,modify)=>text.replace(new RegExp(`<!-- rss-reading:item ${id} -->[\\s\\S]*?<!-- rss-reading:end -->`,'u'),modify);
  let original=await fs.readFile(old,'utf8');
  original=edit(original,multiple.material_id,block=>block.replaceAll('- [ ]','- [x]'));
  original=edit(original,dismissed.material_id,block=>block.replace('- [ ] 不保留','- [x] 不保留'));
  await fs.writeFile(old,original);
  const next=await generateSummaries(f.root,{mode:'weekly',week:'2026-W45',previewRunner});
  assert.equal(next.outputs.long_weekly.item_count,2);
  const latest=next.outputs.long_weekly.path, content=await fs.readFile(latest,'utf8');
  assert.equal((content.match(/^- \[ \]/gmu)||[]).length,6);
  assert.doesNotMatch(content,/- \[x\]/u);
  const retired=(await loadLedger(f.root)).report_runs.weekly['2026-W44'].long_weekly.archived_path;
  assert.doesNotMatch(await fs.readFile(retired,'utf8'),/^- \[[ x]\]|\*\*当前状态\*\*/mu);
  await assert.rejects(fs.access(old),{code:'ENOENT'});
  await fs.writeFile(old,original.replaceAll('- [ ] 不保留','- [x] 不保留'));
  await processMarkdownDecisions(f.root);
  let ledger=await loadLedger(f.root);
  assert.equal(ledger.items[multiple.material_id].decision,'unresolved');
  assert.equal(ledger.items[unchecked.material_id].delivery.active_review_path,latest);
  assert.equal(ledger.items[dismissed.material_id].decision,'dismissed');
  await fs.writeFile(latest,edit(content,unchecked.material_id,block=>block.replace('- [ ] 不保留','- [x] 不保留')));
  await processMarkdownDecisions(f.root);
  ledger=await loadLedger(f.root);
  assert.equal(ledger.items[unchecked.material_id].decision,'dismissed');
});

test('expanded RSS reporting replays only in-range items from retained snapshots',async()=>{
  const f=await fixture();
  const source=f.config.subscriptions.find(entry=>entry.kind==='rss'&&entry.mode==='reports');
  Object.assign(source,{history_mode:'since',earliest_date:'2026-09-01'});
  await writeJson(paths(f.root).config,f.config);
  const snapshots=path.join(f.rssHome,'feeds',digest(source.url).slice(0,16));
  await fs.mkdir(snapshots,{recursive:true});
  const xml='<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/"><channel><title>Archive</title><link>https://b.test/</link>'
    + '<item><title>Old</title><link>https://b.test/old</link><pubDate>2026-08-31T15:59:59Z</pubDate><content:encoded>Archived old text</content:encoded></item>'
    + '<item><title>In scope</title><link>https://b.test/keep</link><pubDate>2026-08-31T16:00:00Z</pubDate><content:encoded>Archived full body</content:encoded></item>'
    + '</channel></rss>';
  await fs.writeFile(path.join(snapshots,'saved.xml'),xml);
  const offline=()=>{throw Error('archived fulltext must not be fetched')};
  const first=await replayRssHistory(f.root,f.config,{},offline);
  assert.deepEqual(first.map(result=>result.urls),[['https://b.test/keep']]);
  assert.equal(first[0].result.items[0].content_status,'fulltext_ready');
  assert.equal((await replayRssHistory(f.root,f.config,{},offline)).length,0);
  source.history_mode='all';
  await writeJson(paths(f.root).config,f.config);
  assert.deepEqual((await replayRssHistory(f.root,f.config,{},offline)).map(result=>result.urls),[['https://b.test/old']]);
});

test('Bilibili and Zhihu can promote previously baselined items after expanding the date scope',async()=>{
  const f=await fixture();
  const video=normalizeSource({kind:'bilibili_collection',name:'测试合集',url:'https://www.bilibili.com/video/BV1234567890/',mode:'reports'});
  f.config.subscriptions.push(video);
  await writeJson(paths(f.root).config,f.config);
  const published_at='2026-10-15T00:00:00Z';
  const listed={key:'bilibili:BV1234567890:11',bvid:'BV1234567890',cid:11,part:1,parts:1,video_title:'合集基线',url:video.url,published_at};
  let videoCalls=0;
  const videoOptions={discoverFn:async()=>({season_id:8,items:[listed]}),existingFn:async()=>new Map(),
    previewFn:async()=>{videoCalls++;return {status:'awaiting_review'};}};
  await scanVideos(f.root,'baseline',videoOptions);
  assert.equal(videoCalls,0);
  const article={url:'https://zhuanlan.zhihu.com/p/900',title:'知乎基线',published_at,html:'<article><p>测试正文。</p></article>'};
  const zhihuOptions={access:()=>({}),discoverMember:async()=>[article]};
  await scanZhihu(f.root,'baseline',zhihuOptions);
  assert.equal(Object.keys((await readJson(path.join(f.home,'zhihu-state.json'))).entries).length,0);
  Object.assign(video,{history_mode:'since',earliest_date:'2026-10-01'});
  Object.assign(f.source,{history_mode:'all'});
  await writeJson(paths(f.root).config,f.config);
  await scanVideos(f.root,'expanded',videoOptions);
  await scanZhihu(f.root,'expanded',zhihuOptions);
  assert.equal(videoCalls,1);
  assert.equal(Object.values((await readJson(path.join(f.home,'zhihu-state.json'))).entries)[0].status,'ready');
  await scanVideos(f.root,'repeated',videoOptions);
  assert.equal(videoCalls,1);
});

test('manual retry requests coalesce and run through the persistent queue',async()=>{
  const f=await fixture();
  for(const source of f.config.subscriptions)source.enabled=false;
  await writeJson(paths(f.root).config,f.config);
  const first=await enqueue(f.root,'retry','manual-first');
  assert.equal((await enqueue(f.root,'retry','manual-again')).id,first.id);
  const server=http.createServer((req,res)=>void handleSubscriptions(req,res,f.root));
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try{
    const base='http://127.0.0.1:'+server.address().port;
    const accepted=await fetch(base+'/api/subscriptions/run',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({kind:'retry'})});
    assert.equal(accepted.status,202);
    assert.equal((await accepted.json()).id,first.id);
    const deadline=Date.now()+10000;
    let jobs=await jobList(f.root);
    while(jobs[0].status!=='completed'&&Date.now()<deadline){
      await new Promise(resolve=>setTimeout(resolve,50));
      jobs=await jobList(f.root);
    }
    assert.equal(jobs[0].status,'completed',jobs[0].error);
    assert.equal(jobs.length,1);
  }finally{await new Promise(resolve=>server.close(resolve));}
});

test('short-only catch-up keeps daily choices active and feeds the scheduled weekly report',async()=>{
  const f=await fixture();await addText(f,{url:'https://zhuanlan.zhihu.com/p/200',markdown:'第一篇短文的正文。'});
  const long=await addText(f);
  const daily=await generateSummaries(f.root,{date:'2026-11-06',week:'2026-W45',mode:'daily',previewRunner});
  const dailyPath=daily.outputs.daily.path;
  const originalDaily=await fs.readFile(dailyPath,'utf8');
  assert.ok(originalDaily.includes('**发布时间**：2026-11-05 08:00:00（北京时间）'));
  const first=await generateSummaries(f.root,{date:'2026-11-06',week:'2026-W45',mode:'short-weekly',previewRunner});
  assert.equal(first.outputs.short_weekly.item_count,1);
  assert.equal(first.outputs.long_weekly,null);
  assert.equal((await loadLedger(f.root)).items[long.material_id].delivery.active_review_path,dailyPath);
  assert.equal(await fs.readFile(dailyPath,'utf8'),originalDaily);
  await addText(f,{url:'https://zhuanlan.zhihu.com/p/201',markdown:'第二篇短文的内容。'});
  const second=await generateSummaries(f.root,{date:'2026-11-08',week:'2026-W45',mode:'weekly',previewRunner});assert.equal(second.outputs.short_weekly.item_count,2);
  const text=await fs.readFile(second.outputs.short_weekly.path,'utf8');assert.ok(text.includes('第一篇短文的正文'));assert.ok(text.includes('第二篇短文的内容'));
  assert.match(text,/第二篇短文的内容。[^]*?\*\*发布时间\*\*：2026-11-05 08:00:00/u);
  await fs.appendFile(second.outputs.short_weekly.path,'\n用户批注。\n');
  const repeated=await generateSummaries(f.root,{date:'2026-11-08',week:'2026-W45',mode:'weekly',previewRunner});
  assert.equal(repeated.outputs.short_weekly.item_count,2);
  assert.ok((await fs.readFile(repeated.outputs.short_weekly.path,'utf8')).endsWith('用户批注。\n'));
});

test('a source cycle appends each completed short article immediately and can replay safely',async()=>{
  const f=await fixture();
  await addText(f,{url:'https://zhuanlan.zhihu.com/p/300',markdown:'短文甲的正文。'});
  await addText(f,{url:'https://zhuanlan.zhihu.com/p/301',markdown:'短文乙的正文。'});
  const week=weekKey();
  const target=path.join(f.reading.shortWeeklyRoot,`${week} 订阅 短文周报.md`);
  let calls=0;
  const first=await prepareSubscriptionPreviews(f.root,'zhihu',{
    previewConcurrency:1,
    previewRunner:async input=>{
      calls++;
      if(calls===2){
        const one=await fs.readFile(target,'utf8');
        assert.equal((one.match(/rss-reading:short /gu)||[]).length,1);
        assert.equal((one.match(/## English Appendix/gu)||[]).length,1);
        await fs.appendFile(target,'\n保留已有批注。\n');
      }
      const result=await previewRunner(input);
      result.result.translation_state='generated_translation';
      return result;
    }
  });
  assert.equal(first.failures.length,0);
  const both=await fs.readFile(target,'utf8');
  assert.equal((both.match(/rss-reading:short /gu)||[]).length,2);
  assert.equal((both.match(/\*\*发布时间\*\*/gu)||[]).length,4);
  assert.match(both,/保留已有批注。/u);
  const ledger=await loadLedger(f.root);
  const entry=Object.values(ledger.items).find(item=>item.delivery?.short_weekly_path===target);
  entry.delivery.short_weekly_pending={revision:entry.source_revision,week};
  delete entry.delivery.short_weekly_revision;
  delete entry.delivery.short_weekly_path;
  await writeJson(f.reading.ledgerPath,ledger);
  const replay=await prepareSubscriptionPreviews(f.root,'zhihu',{previewRunner:()=>{throw Error('unexpected repeated translation');}});
  assert.equal(replay.failures.length,0);
  assert.equal(await fs.readFile(target,'utf8'),both);
  assert.equal((await loadLedger(f.root)).report_runs.weekly[week].short_weekly.item_count,2);
});

test('retrying a saved source snapshot touches only queued URLs and preserves the current feed cursor',async()=>{
  const f=await fixture(),output=path.join(f.root,'imports','rss','source-v1');
  const xml='<rss version="2.0"><channel><title>Feed</title><link>https://feed.test</link><description>Feed</description><item><title>Blocked</title><link>https://feed.test/blocked</link><guid>one</guid><description>Short teaser</description></item><item><title>Unselected</title><link>https://feed.test/old</link><guid>two</guid><description>Another teaser</description></item></channel></rss>';
  await syncFeedDocument({feedUrl:'https://feed.test/rss',xml,outputRoot:output,response:{headers:{etag:'current-etag'}},runId:'baseline'});
  const previous=(await readJson(path.join(output,'state.json'))).feeds;const fetched=[];
  const result=await syncFeedDocument({feedUrl:'https://feed.test/rss',xml,outputRoot:output,onlyItemUrls:['https://feed.test/blocked'],preserveFeedState:true,fetchFulltext:true,
    articleFetcher:async url=>{fetched.push(url);throw Error('still unavailable');},runId:'retry'});
  assert.equal(result.item_count,1);assert.deepEqual(fetched,['https://feed.test/blocked']);assert.deepEqual((await readJson(path.join(output,'state.json'))).feeds,previous);
});

test('a separate workflow fixture cannot accidentally load the live subscription registry',async()=>{
  await fs.mkdir(artifact,{recursive:true});const root=await fs.mkdtemp(path.join(artifact,'uninitialized-'));assert.equal(await loadConfig(root),null);
});

test('short weekly rollover preserves edited bilingual bodies and archives completed articles per source once',async()=>{
  const f=await fixture();
  const unread=await addText(f,{url:'https://zhuanlan.zhihu.com/p/800',markdown:'Unread original article.'});
  const finished=await addText(f,{url:'https://zhuanlan.zhihu.com/p/801',markdown:'Finished original article.'});
  const rssSource=f.config.subscriptions.find(source=>source.url==='https://b.test/feed');
  const other=await addText(f,{source:rssSource,url:'https://b.test/article',markdown:'Other source original.'});
  const translated=async input=>{
    const result=await previewRunner(input);
    result.result.translation_state='generated_translation';
    result.result.artifacts.reading_markdown=result.result.artifacts.reading_markdown.replace('## 正文\n\n','## 正文\n\n中文译文。');
    return result;
  };
  const first=await generateSummaries(f.root,{mode:'short-weekly',date:'2026-11-07',week:'2026-W45',previewRunner:translated});
  const old=first.outputs.short_weekly.path;
  let ledger=await loadLedger(f.root);
  const unreadKey=shortKey(ledger.items[unread.material_id]);
  const edit=(text,key,original,modify)=>text.replace(new RegExp(`(<!-- rss-reading:short${original?'-original':''} ${key} -->)([\\s\\S]*?)(<!-- rss-reading:short${original?'-original':''}-end -->)`,'u'),(_,start,body,end)=>start+modify(body)+end);
  let saved=await fs.readFile(old,'utf8');
  assert.equal((saved.match(/^- \[ \] 已完成阅读$/gmu)||[]).length,3);
  saved=edit(saved,unreadKey,false,body=>body+'\n#### 我的批注子标题\n> 手写中文批注和改写。\n');
  saved=edit(saved,unreadKey,true,body=>body+'\n> Edited English annotation.\n');
  for(const record of [finished,other]) saved=edit(saved,shortKey(ledger.items[record.material_id]),false,body=>body.replace('- [ ] 已完成阅读','- [x] 已完成阅读')+'\n> 已读批注。\n');
  saved+='\n> 末篇正文外批注。\n';
  await fs.writeFile(old,saved);
  await prepareSubscriptionPreviews(f.root,null,{week:'2026-W46',previewRunner:()=>{throw Error('reuse ready previews');}});
  ledger=await loadLedger(f.root);
  const current=ledger.items[unread.material_id].delivery.short_weekly_path;
  const carried=await fs.readFile(current,'utf8');
  assert.match(carried,/我的批注子标题\n> 手写中文批注和改写。/u);
  assert.match(carried,/Edited English annotation\./u);
  assert.equal((carried.match(/^- \[ \] 已完成阅读$/gmu)||[]).length,1);
  assert.doesNotMatch(carried,/Finished original article|Other source original/u);
  await assert.rejects(fs.access(old),{code:'ENOENT'});
  assert.equal(await fs.readFile(ledger.report_runs.weekly['2026-W45'].short_weekly.archived_path,'utf8'),saved);
  for(const record of [finished,other]){
    const file=ledger.items[record.material_id].delivery.short_archived_path;
    const archived=await fs.readFile(file,'utf8');
    assert.match(archived,/> 已读批注。/u);
    assert.equal((archived.match(/<!-- subscriptions:archived-short /gu)||[]).length,1);
    if(record===other) assert.match(archived,/末篇正文外批注。/u);
  }
  assert.notEqual(ledger.items[finished.material_id].delivery.short_archived_path,ledger.items[other.material_id].delivery.short_archived_path);
  await prepareSubscriptionPreviews(f.root,null,{week:'2026-W46'});
  assert.equal(await fs.readFile(current,'utf8'),carried);
  await fs.writeFile(ledger.report_runs.weekly['2026-W45'].short_weekly.archived_path,saved.replaceAll('- [x] 已完成阅读','- [ ] 已完成阅读'));
  await prepareSubscriptionPreviews(f.root,null,{week:'2026-W47'});
  const latest=(await loadLedger(f.root)).items[unread.material_id].delivery.short_weekly_path;
  assert.doesNotMatch(await fs.readFile(latest,'utf8'),/Finished original article|Other source original/u);
});

test('legacy short reports gain one checkbox per saved article while retaining annotations and nested headings',async()=>{
  const f=await fixture();
  await addText(f,{url:'https://zhuanlan.zhihu.com/p/810',markdown:'旧短文正文。'});
  const generated=await generateSummaries(f.root,{mode:'short-weekly',date:'2026-11-07',week:'2026-W45',previewRunner});
  const file=generated.outputs.short_weekly.path;
  const legacy=(await fs.readFile(file,'utf8')).replace(/^<!-- rss-reading:short[^\r\n]*-->\r?\n/gmu,'').replace(/^- \[ \] 已完成阅读\r?\n/gmu,'')+'\n#### 批注标题\n> 原有批注。\n';
  await fs.writeFile(file,legacy);
  await generateSummaries(f.root,{mode:'short-weekly',date:'2026-11-07',week:'2026-W45'});
  const upgraded=await fs.readFile(file,'utf8');
  assert.equal((upgraded.match(/^- \[ \] 已完成阅读$/gmu)||[]).length,1);
  assert.equal(upgraded.replace(/^<!-- rss-reading:short[^\r\n]*-->\r?\n/gmu,'').replace(/\n\n- \[ \] 已完成阅读/gu,''),legacy);
  await prepareSubscriptionPreviews(f.root,null,{week:'2026-W46'});
  const ledger=await loadLedger(f.root);
  assert.match(await fs.readFile(ledger.report_runs.weekly['2026-W46'].short_weekly.path,'utf8'),/#### 批注标题\n> 原有批注。/u);
});

test('daily archive waits for successful decisions and for the report date to pass',async()=>{
  const f=await fixture();
  await addText(f);
  const generated=await generateSummaries(f.root,{mode:'daily',date:'2026-11-07',week:'2026-W45',previewRunner});
  const file=generated.outputs.daily.path;
  const original=await fs.readFile(file,'utf8');
  await fs.writeFile(file,original.replace('- [ ] 正式入库','- [x] 正式入库'));
  const failed=await processMarkdownDecisions(f.root,{date:'2026-11-08',runner:async()=>{throw Error('publication failed');}});
  assert.equal(failed.failures.length,1);
  assert.equal(failed.archived_reports.length,0);
  await fs.access(file);
  const dismissed=original.replace('- [ ] 不保留','- [x] 不保留')+'\n日报笔记。\n';
  await fs.writeFile(file,dismissed);
  const today=await processMarkdownDecisions(f.root,{date:'2026-11-07'});
  assert.equal(today.archived_reports.length,0);
  const tomorrow=await processMarkdownDecisions(f.root,{date:'2026-11-08'});
  assert.equal(tomorrow.archived_reports.length,1);
  assert.equal(await fs.readFile(tomorrow.archived_reports[0].archived_path,'utf8'),dismissed);
  await assert.rejects(fs.access(file),{code:'ENOENT'});
  assert.equal((await processMarkdownDecisions(f.root,{date:'2026-11-08'})).archived_reports.length,0);
});

test('short rollover resumes its saved transfer checkpoint without duplicating articles',async()=>{
  const f=await fixture();
  await addText(f,{url:'https://zhuanlan.zhihu.com/p/820',markdown:'断点恢复短文。'});
  const generated=await generateSummaries(f.root,{mode:'short-weekly',date:'2026-11-07',week:'2026-W45',previewRunner});
  const synced=await syncLedger(f.root);
  await assert.rejects(rollShortReports(synced.paths,synced.ledger,'2026-W46',async()=>{
    await writeJson(synced.paths.ledgerPath,synced.ledger);
    throw Error('interrupted_after_transfer_checkpoint');
  },item=>item.author),/interrupted_after_transfer_checkpoint/u);
  await fs.access(generated.outputs.short_weekly.path);
  await prepareSubscriptionPreviews(f.root,null,{week:'2026-W46'});
  const ledger=await loadLedger(f.root);
  assert.ok(ledger.report_runs.weekly['2026-W45'].short_weekly.archived_path);
  assert.equal(ledger.report_runs.weekly['2026-W45'].short_weekly.archive_pending,undefined);
  const current=await fs.readFile(ledger.report_runs.weekly['2026-W46'].short_weekly.path,'utf8');
  assert.equal((current.match(/<!-- rss-reading:short /gu)||[]).length,1);
  await assert.rejects(fs.access(generated.outputs.short_weekly.path),{code:'ENOENT'});
});

test('a daily transferred on its own date remains visible until the following day',async()=>{
  const f=await fixture();
  await addText(f);
  const daily=await generateSummaries(f.root,{mode:'daily',date:'2026-11-08',week:'2026-W45',previewRunner});
  await generateSummaries(f.root,{mode:'weekly',date:'2026-11-08',week:'2026-W45',previewRunner});
  await fs.access(daily.outputs.daily.path);
  const next=await processMarkdownDecisions(f.root,{date:'2026-11-09'});
  assert.equal(next.archived_reports.length,1);
  await assert.rejects(fs.access(daily.outputs.daily.path),{code:'ENOENT'});
});

test('weekly rollover carries blocked source entries with historical selections before retiring their daily',async()=>{
  const f=await fixture();
  const blocked=await addText(f,{url:'https://zhuanlan.zhihu.com/p/830',markdown:null});
  const synced=await syncLedger(f.root);
  synced.ledger.items[blocked.material_id].decision='selected';
  await writeJson(synced.paths.ledgerPath,synced.ledger);
  const daily=await generateSummaries(f.root,{mode:'daily',date:'2026-11-07',week:'2026-W45'});
  const weekly=await generateSummaries(f.root,{mode:'weekly',date:'2026-11-08',week:'2026-W45'});
  assert.match(await fs.readFile(weekly.outputs.long_weekly.path,'utf8'),new RegExp(`rss-reading:item ${blocked.material_id}`,'u'));
  const ledger=await loadLedger(f.root);
  assert.ok(ledger.report_runs.daily['2026-11-07'].archived_path);
  await assert.rejects(fs.access(daily.outputs.daily.path),{code:'ENOENT'});
});

test('changing a video from reports to automatic processing releases the existing waiting item',async()=>{
  const f=await fixture(),source=normalizeSource({kind:'bilibili_video',name:'视频',url:'https://www.bilibili.com/video/BV1234567890/',mode:'standard_preprocess'});source.baseline_ready=true;f.config.subscriptions.push(source);await writeJson(paths(f.root).config,f.config);
  const item={key:'bilibili:BV1234567890:11',watch_id:source.id,bvid:'BV1234567890',cid:11,part:1,parts:1,video_title:'视频',url:source.url,status:'awaiting_review'};
  await writeJson(path.join(f.videoHome,'state.json'),{entries:{[item.key]:item}});let calls=0;
  await scanVideos(f.root,'new-cycle',{discoverFn:async()=>({season_id:null,items:[item]}),existingFn:async()=>new Map(),processFn:async()=>{calls++;return {status:'completed',publication:path.join(f.root,'阅读区','result.md')};}});
  assert.equal(calls,1);assert.equal((await readJson(path.join(f.videoHome,'state.json'))).entries[item.key].status,'completed');
});

test('an article already imported through another source becomes an activity entry, not a duplicate review card',async()=>{
  const f=await fixture(),record=await addText(f),file=path.join(f.root,'阅读区','existing.md');await fs.writeFile(file,'既有正文');
  await writeJson(path.join(f.rssHome,'state.json'),{schema:'progressive-reading.rss-auto-import/v1',feeds:{},items:{known:{id:'known',url:record.url,status:'imported',artifacts:[{path:file,sha256:digest('既有正文')}],feeds:['https://a.test/feed']}}});
  const synced=await syncLedger(f.root);assert.equal(synced.ledger.items[record.material_id].route,'import_activity');
  const result=await generateSummaries(f.root,{mode:'daily',previewRunner:()=>{throw Error('must not preview an imported article');}});assert.equal(result.outputs.daily,null);assert.equal(synced.ledger.items[record.material_id].publication.path,file);
});

test('adding import activity keeps the report receipt and ledger hashes aligned',async()=>{
  const f=await fixture();
  await addText(f);
  await writeJson(path.join(f.rssHome,'state.json'),{items:{
    dated:{id:'dated',status:'imported',title:'来源含发布时间',url:'https://a.test/dated',artifacts:[{path:path.join(f.root,'阅读区','dated.md')}],published_at:'2026-11-05T02:30:00Z',completed_at:'2026-11-06T01:00:00Z'},
    undated:{id:'undated',status:'imported',title:'来源无发布时间',url:'https://a.test/undated',artifacts:[{path:path.join(f.root,'阅读区','undated.md')}],completed_at:'2026-11-06T01:00:00Z'}
  }});
  const report=await generateSummaries(f.root,{mode:'daily',previewRunner});await appendActivity(f.root,report);
  const body=await fs.readFile(report.outputs.daily.path,'utf8');
  assert.match(body,/\[来源含发布时间\][^\n]*\n  \*\*发布时间\*\*：2026-11-05 10:30:00/u);
  assert.doesNotMatch(body,/\[来源无发布时间\][^\n]*\n  \*\*发布时间\*\*/u);
  const actual=digest(body),ledger=await loadLedger(f.root),record=Object.values(ledger.report_runs.daily).find(r=>r.path===report.outputs.daily.path);
  assert.equal(record.sha256,actual);assert.equal(report.outputs.daily.sha256,actual);assert.equal(report.outputs.ledger.sha256,digest(await fs.readFile(f.reading.ledgerPath)));
});

test('a later source fetch failure preserves a verified cached body and its selection',async()=>{
  const f=await fixture(),record=await addText(f);const before=await syncLedger(f.root);const item=before.ledger.items[record.material_id];
  item.decision='dismissed';item.review_preview={status:'ready'};await writeJson(f.reading.ledgerPath,before.ledger);
  await saveSourceMaterial(f.root,f.source,{url:record.url,title:'测试文章'},null,{errors:[{message:'temporarily unavailable'}]});
  const after=(await syncLedger(f.root)).ledger.items[record.material_id];assert.equal(after.eligible_for_preprocess,true);assert.equal(after.content_status,'fulltext_ready');assert.equal(after.decision,'dismissed');assert.equal(after.preprocess_request_path,item.preprocess_request_path);assert.ok(after.source_refresh_failure);
});
