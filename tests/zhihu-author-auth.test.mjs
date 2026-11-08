import test from 'node:test';
import assert from 'node:assert/strict';
import {discoverAuthor,scanZhihu} from '../subscription-workflow/adapters.mjs';
import {requestZhihuJson} from '../scripts/zhihu-social-archive.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import {paths,SCHEMA,normalizeSource,writeJson,readJson} from '../subscription-workflow/config.mjs';
import {externalCatalog} from '../subscription-workflow/catalog.mjs';
import {discoverZhihuColumn} from '../scripts/zhihu-column-import.mjs';

const source={url:'https://www.zhihu.com/people/synthetic-author',name:'Synthetic author'};
const item=(id='1')=>({id,question:{id:'2',title:'Synthetic question'},title:'Synthetic article',created_time:1735689600,content:'<p>Synthetic body.</p>'});
const page=(data,end=true,totals=data.length,next=null)=>({data,paging:{is_end:end,totals,next}});

test('author API uses the shared local fetcher identity and per-URL login session',async()=>{
  const calls=[];
  const items=await discoverAuthor(source,{cookieHeaderForUrl:url=>{assert.equal(new URL(url).origin,'https://www.zhihu.com');return 'z_c0=synthetic-session';},retryDelaysMs:[],fetchImpl:async(url,init)=>{
    calls.push(url);assert.equal(init.headers['User-Agent'],'ProgressiveReading-LocalFetcher/1.0');assert.equal(init.headers.Cookie,'z_c0=synthetic-session');assert.equal(init.redirect,'error');
    return new Response(JSON.stringify(page([item('2047309971508008683')])));
  }});
  assert.equal(calls.length,2);assert.equal(items.length,2);
  assert.equal(items[0].url,'https://www.zhihu.com/question/2/answer/2047309971508008683');
  assert.equal(items[1].url,'https://zhuanlan.zhihu.com/p/2047309971508008683');
  assert.equal(items[0].published_at,'2025-01-01T00:00:00.000Z');assert.match(items[1].html,/Synthetic body/);
});

test('expected HTTP cursors are upgraded and all author pages are counted',async()=>{
  const calls=[];
  const items=await discoverAuthor(source,{},async url=>{
    const u=new URL(url);calls.push(url);assert.equal(u.protocol,'https:');
    if(u.pathname.endsWith('/articles'))return page([]);
    if(u.searchParams.get('offset')==='20')return page([item('3')],true,2);
    return page([item()],false,2,'http://www.zhihu.com/api/v4/members/synthetic-author/answers?offset=20&limit=20');
  });
  assert.equal(calls.length,3);assert.equal(items.length,2);
});

test('count discrepancies and changing totals warn while both content types continue',async()=>{
  const warnings=[];let count=0;
  const items=await discoverAuthor(source,{onWarning:warning=>warnings.push(warning)},async url=>{
    if(new URL(url).pathname.endsWith('/articles'))return page([item('4')]);
    return ++count===1?page([item()],false,2,'https://www.zhihu.com/api/v4/members/synthetic-author/answers?offset=20'):page([item('3')],true,3);
  });
  assert.equal(items.length,3);assert.equal(warnings.length,1);assert.equal(warnings[0].platform_total,3);assert.equal(warnings[0].actual_count,2);assert.deepEqual(warnings[0].observed_totals,[2,3]);assert.equal(warnings[0].inventory_complete,false);
  await assert.rejects(discoverAuthor(source,{},async()=>page([],true,-1)),/总数异常/);
});

test('changing cursors cannot disguise repeated author page contents',async()=>{
  let count=0;await assert.rejects(discoverAuthor(source,{},async()=>page([item()],false,3,`https://www.zhihu.com/api/v4/members/synthetic-author/answers?offset=${++count*20}`)),/分页重复内容/);
});

test('an overlapping final page is accepted and deduplicated',async()=>{
  let count=0;const items=await discoverAuthor(source,{},async url=>{
    if(new URL(url).pathname.endsWith('/articles'))return page([]);
    return ++count===1?page([item()],false,1,'https://www.zhihu.com/api/v4/members/synthetic-author/answers?offset=20'):page([item()],true,1);
  });assert.equal(items.length,1);
});

test('count warnings preserve report materials and progressive-reading queue entries',async()=>{
  const artifact='D:/Artifacts/ProgressiveReading/zhihu-count-warning-tests';await fs.mkdir(artifact,{recursive:true});
  for(const kind of ['zhihu_author','zhihu_column'])for(const mode of ['reports','original_text']){
    const root=await fs.mkdtemp(path.join(artifact,'case-')),home=path.join(root,'home'),rssHome=path.join(root,'rss-home');
    const configured=normalizeSource({kind,name:source.name,url:kind==='zhihu_author'?source.url:'https://www.zhihu.com/column/c_synthetic',mode,history_mode:'all'});
    await writeJson(paths(root).marker,{home});
    await writeJson(paths(root).config,{schema:SCHEMA,enabled:true,rss_home:rssHome,rss_defaults:{},subscriptions:[configured]});
    const result=await scanZhihu(root,'count-warning',{access:()=>({}),discoverMember:(s,options)=>discoverAuthor(s,options,async url=>page([item()],true,new URL(url).pathname.endsWith('/answers')?2:1)),
      discoverColumn:(url,options)=>discoverZhihuColumn(url,{...options,cookieHeaderForUrl:()=> 'z_c0=synthetic',fetchImpl:async target=>new Response(JSON.stringify(target.includes('/pinned-items/')?{data:[]}:page([{...item(),type:'answer'},{...item('3'),type:'article'}],true,3)))})});
    assert.deepEqual(result.errors,[]);assert.equal(result.warnings.length,1);
    const state=await readJson(path.join(home,'zhihu-state.json'));assert.equal(state.sources[configured.id].error,null);assert.equal(state.sources[configured.id].inventory_complete,false);assert.equal(state.sources[configured.id].warnings[0].actual_count,kind==='zhihu_author'?1:2);
    assert.equal(Object.values(state.entries).length,2);assert.ok(Object.values(state.entries).every(i=>i.status==='ready'));
    if(mode==='reports'){const catalog=await externalCatalog(root);assert.equal(catalog.length,2);assert.ok(catalog.every(i=>i.eligible));}
    else {const queued=await readJson(path.join(rssHome,'state.json'));assert.equal(Object.keys(queued.items).length,2);assert.ok(Object.values(queued.items).every(i=>i.status==='pending'));}
  }
});

test('pagination cannot send the session to other origins, ports, authors or API types',async()=>{
  for(const next of ['https://evil.invalid/api/v4/members/synthetic-author/answers','https://www.zhihu.com:333/api/v4/members/synthetic-author/answers','https://www.zhihu.com/api/v4/members/another/answers','https://www.zhihu.com/api/v4/members/synthetic-author/articles','https://name:password@www.zhihu.com/api/v4/members/synthetic-author/answers']){
    let calls=0;await assert.rejects(discoverAuthor(source,{},async()=>{calls++;return page([item()],false,2,next);}),/分页不完整/);assert.equal(calls,1);
  }
});

test('rounded large numeric IDs and missing credentials fail explicitly',async()=>{
  await assert.rejects(discoverAuthor(source,{},async()=>page([item(2047309971508008683)])),/身份无效/);
  let called=false;await assert.rejects(requestZhihuJson('https://www.zhihu.com/api/v4/members/synthetic-author/answers',{cookieHeaderForUrl:()=>'',fetchImpl:async()=>{called=true;},retryDelaysMs:[]}),/cookie_not_synced/);assert.equal(called,false);
});
