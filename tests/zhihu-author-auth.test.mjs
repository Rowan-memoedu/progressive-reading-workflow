import test from 'node:test';
import assert from 'node:assert/strict';
import {discoverAuthor} from '../subscription-workflow/adapters.mjs';
import {requestZhihuJson} from '../scripts/zhihu-social-archive.mjs';

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

test('author enumeration rejects totals that disagree with the returned inventory',async()=>{
  await assert.rejects(discoverAuthor(source,{},async()=>page([item()],true,2)),/总数不完整/);
  let count=0;await assert.rejects(discoverAuthor(source,{},async()=>++count===1?page([item()],false,2,'https://www.zhihu.com/api/v4/members/synthetic-author/answers?offset=20'):page([item('3')],true,3)),/总数异常或已变化/);
});

test('changing cursors cannot disguise repeated author page contents',async()=>{
  let count=0;await assert.rejects(discoverAuthor(source,{},async()=>page([item()],false,3,`https://www.zhihu.com/api/v4/members/synthetic-author/answers?offset=${++count*20}`)),/分页重复内容/);
});

test('an overlapping final page is accepted only when the complete unique count matches',async()=>{
  let count=0;const items=await discoverAuthor(source,{},async url=>{
    if(new URL(url).pathname.endsWith('/articles'))return page([]);
    return ++count===1?page([item()],false,1,'https://www.zhihu.com/api/v4/members/synthetic-author/answers?offset=20'):page([item()],true,1);
  });assert.equal(items.length,1);
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
