import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import nodeFs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { CONFIG_NAME, RssImporter, acquireLock, parseConfig, itemEligibility, saveJson, verifyImport } from '../rss-import/core.mjs';
import { reconcileInVault, ensureObsidianVisible } from '../rss-import/obsidian.mjs';

const root='D:/Artifacts/RSS-Routing-20260915/tests';
const nowValue=Date.parse('2026-09-14T00:00:00Z');
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const document=(feeds,extra={})=>'# RSS\n## 默认模式\n```json\n'+JSON.stringify({enabled:true,lookback_days:180,poll_minutes:5,destination_folder:'RSS',...extra})+'\n```\n## ① 标准流程导入\n'+feeds.join('\n')+'\n## ② 原文直接导入\n'+(extra.original_feeds || []).join('\n')+'\n## ③ 日报与周报（暂停）\n'+(extra.report_feeds || []).join('\n')+'\n## 帮助\nhttps://help.example.test/\n';
const rss=items=>'<rss version="2.0"><channel><title>Fixture RSS</title><link>https://test.example/</link><description>fixture</description>'+items.map(({url,date,title='Entry'})=>`<item><title>${title}</title>${url?`<link>${url.replaceAll('&','&amp;')}</link>`:''}${date?`<pubDate>${date}</pubDate>`:''}<description>Source body</description></item>`).join('')+'</channel></rss>';
const fetched=(text,status=200)=>({text,finalUrl:'https://feeds.example/feed',response:{status,headers:new Headers({etag:'"test"'})}});
async function home(feeds,options={}) {
  await fs.mkdir(root,{recursive:true});
  const dir=await fs.mkdtemp(path.join(root,'fixture-'));
  await fs.writeFile(path.join(dir,CONFIG_NAME),document(feeds,options));
  return dir;
}
test('configuration consumes every URL only in subscription section; validates modes',()=>{
  const config=parseConfig(document(['https://one.example/feed','- [Two](https://two.example/atom.xml)','https://one.example/feed']));
  assert.deepEqual(config.feeds,['https://one.example/feed','https://two.example/atom.xml']);
  assert.throws(()=>parseConfig(document([],{lookback_days:0})),/lookback_days/);
  assert.throws(()=>parseConfig(document([],{destination_folder:'../elsewhere'})),/destination_folder/);
});

test('expanding the RSS date scope queues retained fulltext that disappeared from the live feed',async()=>{
  const feed='https://feeds.example/feed', dir=await home([feed]);
  const config=parseConfig(document([feed]));
  config.current_feed_only=true;
  let xml='<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/"><channel><title>Fixture</title><link>https://feeds.example/</link>'
    + '<item><title>Retained</title><link>https://feeds.example/old</link><pubDate>2026-08-31T16:00:00Z</pubDate><content:encoded>Preserved complete body.</content:encoded></item></channel></rss>';
  const submissions=[];
  const importer=await new RssImporter({home:dir,workflowRoot:dir,now:()=>nowValue,fetchFeed:async()=>fetched(xml),
    request:async(_url,body)=>{if(body){submissions.push(body);return {request_id:'retained'};}return {terminal:false,status:'processing'};}}).load();
  Object.assign(config.subscriptions[0],{history_mode:'since',earliest_date:'2026-09-02'});
  await importer.scan(config,{force:true});
  assert.equal(Object.keys(importer.state.items).length,0);
  const cachedUrl='https://feeds.example/retained-package';
  const sourceArea=path.join(dir,'imports','rss','source-v1');
  const packageDir=path.join(sourceArea,'packages','feed','material');
  await saveJson(path.join(packageDir,'preprocess-request.json'),{
    source_metadata:{feed_url:feed,item_url:cachedUrl,title:'Retained package',published_at:'2026-08-31T16:00:00Z'},
    material:{markdown:'Verified body from the retained package.'}
  });
  await saveJson(path.join(sourceArea,'state.json'),{
    materials:{material:{content_status:'fulltext_ready',package_path:packageDir,content_hash:sha('Source body')}},
    aliases:{['item_url:'+cachedUrl]:{material_id:'material',content_hash:sha('Source body')}}
  });
  xml=rss([{url:cachedUrl,date:'2026-08-31T16:00:00Z'}]);
  config.subscriptions[0].earliest_date='2026-09-01';
  await importer.scan(config,{force:true});
  const backend={base:'http://127.0.0.1:1',readingRoot:dir};
  await importer.advance(config,backend);
  await importer.advance(config,backend);
  assert.equal(submissions.length,2);
  assert.equal(submissions.find(body=>body.urls[0]==='https://feeds.example/old').cached_rss_article.markdown,'Preserved complete body.');
  assert.equal(submissions.find(body=>body.urls[0]===cachedUrl).cached_rss_article.markdown,'Verified body from the retained package.');
});

test('three adjacent regions retain names and route every link; reports never enter the direct importer',async()=>{
  const config=parseConfig(document(['- 标准网站：https://one.example/feed'],{original_feeds:['- [原文网站](https://two.example/feed)'],report_feeds:['- 报表网站：https://three.example/feed']}));
  assert.deepEqual(config.subscriptions.map(item=>[item.name,item.route]),[['标准网站','standard_preprocess'],['原文网站','original_text'],['报表网站','reports']]);
  assert.deepEqual(config.feeds,['https://one.example/feed','https://two.example/feed']);
  assert.deepEqual(config.report_feeds,['https://three.example/feed']);
  assert.throws(()=>parseConfig(document(['https://same.example/feed'],{original_feeds:['https://same.example/feed']})),/只能放在一个区域/);
  assert.equal(parseConfig(document(Array.from({length:130},(_,i)=>`网站 ${i}：https://feed${i}.example/rss`))).feeds.length,130);
  const dir=await home([],{report_feeds:['https://report.example/feed']});let fetches=0;
  const importer=await new RssImporter({home:dir,workflowRoot:dir,fetchFeed:async()=>{fetches++;throw new Error('report feed must not be fetched here');}}).load();
  await importer.tick({scanOnly:true});assert.equal(fetches,0);
});

test('original mode is explicit in the persisted request and requires a no-LLM receipt',async()=>{
  const dir=await home([],{original_feeds:['https://raw.example/feed']});const output=path.join(dir,'原文.md');
  await fs.writeFile(output,'# Original\nOriginal body without summaries or translations.');
  const result={status:'imported',receipt:{processing_mode:'original_text',llm_used:false,quality_status:'ready'},artifacts:[{kind:'markdown',path:output,sha256:sha(await fs.readFile(output))}]};
  const submissions=[];
  const request=async(url,body)=>{
    if(url.endsWith('/health'))return {readingRoot:dir,browserImportBroker:{idempotentRequestCreation:true},standardImport:{processingModes:['standard_preprocess','original_text']}};
    if(body){submissions.push(body);return {request_id:'raw-request'};}
    return {terminal:true,status:'completed',results:[result]};
  };
  const runner=await new RssImporter({home:dir,workflowRoot:dir,now:()=>nowValue,fetchFeed:async()=>fetched(rss([{url:'https://raw.example/article',date:'2026-09-01'}])),request}).load();
  await runner.tick();const report=await runner.tick();
  assert.equal(submissions[0].processing_mode,'original_text');assert.equal(report.counts.imported,1);
  assert.equal(report.items[0].processing_mode,'original_text');
  result.receipt.llm_used=true;assert.equal((await verifyImport(result,dir,'original_text')).ok,false);
});

test('one article discovered in conflicting import modes is held before any submission',async()=>{
  const dir=await home(['https://standard.example/feed'],{original_feeds:['https://raw.example/feed']});let posts=0;
  const request=async(_url,body)=>{if(body)posts++;return {readingRoot:dir,browserImportBroker:{idempotentRequestCreation:true},standardImport:{processingModes:['standard_preprocess','original_text']}};};
  const runner=await new RssImporter({home:dir,workflowRoot:dir,now:()=>nowValue,fetchFeed:async()=>fetched(rss([{url:'https://shared.example/article',date:'2026-09-01'}])),request}).load();
  const report=await runner.tick();assert.equal(report.counts.route_conflict,1);assert.equal(posts,0);
});
test('date boundary, missing date and future dates are explicit',()=>{
  const config={lookback_days:180};
  assert.equal(itemEligibility({item_url:'https://test.example/a',published_at:new Date(nowValue-180*86400000).toISOString()},config,()=>nowValue),'eligible');
  assert.equal(itemEligibility({item_url:'https://test.example/a',published_at:new Date(nowValue-180*86400000-1).toISOString()},config,()=>nowValue),'outside_window');
  assert.equal(itemEligibility({item_url:'https://test.example/a',published_at:''},config,()=>nowValue),'date_unknown');
  assert.equal(itemEligibility({item_url:'https://test.example/a',published_at:'2027-01-01'},config,()=>nowValue),'future');
});
test('no 100-entry cap; every feed and missing-URL entry is accounted for; 304 re-evaluates date window',async()=>{
  const feeds=['https://alpha.example/rss','https://beta.example/rss'];
  const dir=await home(feeds);
  let cached=false;
  const entries=Array.from({length:125},(_,i)=>({url:`https://articles.example/${i}`,date:'2026-09-01'}));
  entries.push({url:'https://articles.example/old',date:'2026-01-01'},{date:'2026-09-01'});
  const runner=await new RssImporter({home:dir,workflowRoot:dir,now:()=>nowValue,fetchFeed:async()=>fetched(cached?'':rss(entries),cached?304:200)}).load();
  let report=await runner.tick({scanOnly:true});
  assert.equal(report.item_count,125);
  assert.equal(report.feeds.length,2);
  assert.equal(report.feeds[0].item_count,127);
  assert.equal(report.feeds[0].coverage.missing_url,1);
  assert.equal(Object.values(runner.state.items)[0].feeds.length,2);
  cached=true;
  await fs.writeFile(path.join(dir,CONFIG_NAME),document(feeds,{lookback_days:300}));
  report=await runner.tick({scanOnly:true});
  assert.equal(report.item_count,126);
});
test('independent Atom source and failed source cannot discard another feed inventory',async()=>{
  const feeds=['https://bad.example/rss','https://atom.example/feed'];
  const dir=await home(feeds);
  const atom='<feed xmlns="http://www.w3.org/2005/Atom"><title>Independent Atom</title><id>urn:independent</id><updated>2026-09-01T00:00:00Z</updated><entry><title>Atom entry</title><id>urn:a</id><link href="https://atom.example/article"/><updated>2026-09-01T00:00:00Z</updated><content>Source</content></entry></feed>';
  const runner=await new RssImporter({home:dir,workflowRoot:dir,now:()=>nowValue,fetchFeed:async url=>{if(url===feeds[0])throw new Error('network unavailable');return fetched(atom);}}).load();
  const report=await runner.tick({scanOnly:true});
  assert.equal(report.feeds[0].status,'failed');
  assert.equal(report.feeds[1].item_count,1);
  assert.equal(report.item_count,1);
});
test('uncertain POST survives restart with same ID; warning is retained; repeats never repost',async()=>{
  const feed='https://feed.example/rss';
  const dir=await home([feed]);
  const reading=path.join(dir,'reading');await fs.mkdir(reading);
  const file=path.join(reading,'article.md');const body='# Article\n\nFull source body';await fs.writeFile(file,body);
  const result={status:'imported_with_warnings',receipt:{processing_mode:'standard_preprocess',quality_status:'warning'},artifacts:[{kind:'markdown',path:file,sha256:sha(body)}]};
  const ids=[];let failOnce=true;
  const request=async(url,body)=>{
    if(url.endsWith('/health'))return {readingRoot:reading,browserImportBroker:{idempotentRequestCreation:true}};
    if(body){ids.push(body.client_request_id);if(failOnce){failOnce=false;throw new Error('response lost after server accepted');}return {request_id:'request-one'};}
    return {terminal:true,status:'completed_with_warnings',results:[result]};
  };
  const args={home:dir,workflowRoot:dir,now:()=>nowValue,fetchFeed:async()=>fetched(rss([{url:'https://article.example/1',date:'2026-09-01'}])),request};
  let runner=await new RssImporter(args).load();
  await runner.tick();await runner.tick();
  runner=await new RssImporter(args).load();
  let report=await runner.tick();
  assert.equal(report.counts.imported_with_warnings,1);
  assert.equal(ids.length,2);assert.equal(ids[0],ids[1]);
  await runner.tick();assert.equal(ids.length,2);
});
test('terminal failures are preserved and retried after backoff, independently of other entries',async()=>{
  const feed='https://feed.example/rss';const dir=await home([feed],{retry_minutes:1});
  let now=nowValue;const requests=[];
  const request=async(url,body)=>{
    if(url.endsWith('/health'))return {readingRoot:dir,browserImportBroker:{idempotentRequestCreation:true}};
    if(body){requests.push(body);return {request_id:'request-'+requests.length};}
    return {terminal:true,status:'failed',results:[{status:'failed',error:'network_failure'}]};
  };
  const runner=await new RssImporter({home:dir,workflowRoot:dir,now:()=>now,fetchFeed:async()=>fetched(rss([{url:'https://article.example/1',date:'2026-09-01'}])),request}).load();
  await runner.tick();let report=await runner.tick();assert.equal(report.counts.retry_wait,1);
  await runner.tick();assert.equal(requests.length,1);
  now+=60001;await runner.tick();await runner.tick();assert.equal(requests.length,2);
  assert.notEqual(requests[0].client_request_id,requests[1].client_request_id);
  assert.equal(Object.values(runner.state.items)[0].attempts.length,2);
});
test('verification rejects self-reported success without valid on-disk evidence',async()=>{
  const dir=await home([]);const file=path.join(dir,'output.md');await fs.writeFile(file,'body');
  const result={status:'imported',receipt:{processing_mode:'standard_preprocess'},artifacts:[{kind:'markdown',path:file,sha256:'fake'}]};
  assert.equal((await verifyImport(result,dir)).ok,false);
  result.artifacts[0].sha256=sha('body');assert.equal((await verifyImport(result,dir)).ok,true);
  await fs.writeFile(file,'changed');assert.equal((await verifyImport(result,dir)).ok,false);
});
test('disabled config stops submission; removed source preserves existing data',async()=>{
  const feed='https://feed.example/rss';const dir=await home([feed],{enabled:false});let calls=0;
  const runner=await new RssImporter({home:dir,workflowRoot:dir,fetchFeed:async()=>{calls++;return fetched(rss([]));},request:async()=>{throw new Error('must not submit');}}).load();
  const report=await runner.tick();assert.equal(report.enabled,false);assert.equal(calls,0);
  runner.state.items.saved={url:'https://article.example/a',feeds:[feed],status:'imported',published_at:'2026-09-01'};
  await fs.writeFile(path.join(dir,CONFIG_NAME),document([]));
  const after=await runner.tick({scanOnly:true});assert.equal(after.retained_inactive_items,1);
});
test('single writer lock protects service state and is releasable',async()=>{
  const dir=await home([]);const unlock=await acquireLock(dir);
  await assert.rejects(acquireLock(dir),/already_running/);
  await unlock();await (await acquireLock(dir))();
});

test('missing Obsidian index event is reconciled through an aliased junction without changing content',async()=>{
  const dir=await home([]);
  const vault=path.join(dir,'vault');const target=path.join(dir,'real-store');
  await fs.mkdir(vault);await fs.mkdir(path.join(target,'new-folder'),{recursive:true});
  await fs.symlink(target,path.join(vault,'Different alias'),'junction');
  const file=path.join(target,'new-folder','中文.md');await fs.writeFile(file,'unchanged content');
  const folder={path:'Different alias',name:'Different alias',children:[]};const entries=new Map();const calls=[];
  const noise=Array.from({length:5000},(_,index)=>({path:`generated/deep/tree/${index}`,name:String(index),children:[]}));
  const app={vault:{getRoot:()=>({path:'/',children:[]}),getAllLoadedFiles:()=>[folder,...noise],getAbstractFileByPath:key=>entries.get(key),
    adapter:{getFullPath:key=>path.join(vault,key==='/'?'':key),reconcileFile:async(first,second)=>{calls.push([first,second]);entries.set(second,{path:second});}}}};
  const result=await reconcileInVault([file,path.join(dir,'outside.md')],app,path,nodeFs);
  assert.equal(result.files[0].status,'visible');assert.equal(result.files[0].reconciled,true);
  assert.equal(result.files[0].path,'Different alias/new-folder/中文.md');
  assert.equal(result.files[1].status,'vault_path_unresolved');assert.equal(calls.length,1);
  await reconcileInVault([file],app,path,nodeFs);assert.equal(calls.length,1);
  assert.equal(await fs.readFile(file,'utf8'),'unchanged content');
});

test('Obsidian CLI is not invoked when the app is closed',async()=>{
  const calls=[];
  const result=await ensureObsidianVisible([{path:'D:/some/article.md'}],{platform:'win32',run:async(command)=>{calls.push(command);return {stdout:'INFO: No tasks are running.'};}});
  assert.equal(result.status,'app_not_running');assert.deepEqual(calls,['tasklist.exe']);
});

test('visibility resumes after app opens, with bounded retries and no article resubmission',async()=>{
  const dir=await home([]);let now=nowValue;let checks=0;
  const artifact={path:'D:/some/article.md',sha256:'preserved'};
  const runner=await new RssImporter({home:dir,workflowRoot:dir,now:()=>now,syncObsidian:async()=>{
    checks++;return checks===1?{status:'app_not_running'}:{status:'visible',files:[{absolute_path:artifact.path,status:'visible'}]};
  }}).load();
  runner.state.items.one={status:'imported',attempt:1,artifacts:[artifact]};
  await runner.syncVisibility();await runner.syncVisibility();assert.equal(checks,1);
  now+=60001;await runner.syncVisibility();await runner.syncVisibility();assert.equal(checks,2);
  assert.equal(runner.state.items.one.obsidian.status,'visible');assert.equal(runner.state.items.one.attempt,1);
  assert.deepEqual(runner.state.items.one.artifacts,[artifact]);
});
