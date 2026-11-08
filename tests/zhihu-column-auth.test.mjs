import test from 'node:test';
import assert from 'node:assert/strict';
import {discoverZhihuColumn} from '../scripts/zhihu-column-import.mjs';
import {requestZhihuJson} from '../scripts/zhihu-social-archive.mjs';

const source='https://www.zhihu.com/column/c_auth_fixture';
const article=id=>({type:'article',id:String(id),title:'Synthetic article',created:1735689600,content:'<p>Synthetic full body.</p>'});
const json=data=>new Response(JSON.stringify(data),{headers:{'Content-Type':'application/json'}});
const page=(data,end=true,total=data.length,next=null)=>({data,paging:{is_end:end,totals:total,next}});

test('column pages and pinned items use credentials matched to the actual request host',async()=>{
  const calls=[];
  const result=await discoverZhihuColumn(source,{cookieHeaderForUrl:url=>new URL(url).hostname==='zhuanlan.zhihu.com'?'z_c0=synthetic-column-session':'z_c0=wrong-host-session',fetchImpl:async(url,init)=>{
    const parsed=new URL(url);calls.push(url);assert.equal(parsed.origin,'https://zhuanlan.zhihu.com');assert.equal(init.headers.Cookie,'z_c0=synthetic-column-session');assert.equal(init.redirect,'error');
    if(parsed.pathname.endsWith('/pinned-items/v2'))return json({data:[article(3)]});
    if(parsed.searchParams.get('offset')==='20')return json(page([article(2)],true,2));
    return json(page([article(1)],false,2,'http://zhuanlan.zhihu.com/api/columns/c_auth_fixture/items?limit=20&offset=20'));
  }});
  assert.equal(calls.length,3);assert.equal(result.complete,true);assert.equal(result.articles.length,3);assert.equal(result.articles[0].published_at,'2025-01-01T00:00:00.000Z');
});

test('a missing column-domain session cannot silently use a www session or issue an anonymous request',async()=>{
  let calls=0;
  await assert.rejects(requestZhihuJson('https://zhuanlan.zhihu.com/api/columns/c_auth_fixture/items',{cookieByHostname:new Map([['www.zhihu.com','z_c0=synthetic-www-only']]),fetchImpl:async()=>{calls++;return json(page([]));},retryDelaysMs:[]}),/cookie_not_synced/);
  assert.equal(calls,0);
});

test('column-only origin extension does not permit unrelated APIs, alternate ports or writes',async()=>{
  for(const [url,method] of [['https://zhuanlan.zhihu.com/api/me','GET'],['https://zhuanlan.zhihu.com/api/columns/c_auth_fixture/items','POST'],['https://zhuanlan.zhihu.com:333/api/columns/c_auth_fixture/items','GET'],['https://www.zhihu.com:333/api/v4/me','GET']]){
    let called=false;await assert.rejects(requestZhihuJson(url,{method,cookieHeaderForUrl:()=>{called=true;return 'z_c0=synthetic';},retryDelaysMs:[]}),/origin_invalid/);assert.equal(called,false);
  }
});

test('repeated page contents and cross-column cursors remain incomplete rather than dropping data',async()=>{
  await assert.rejects(discoverZhihuColumn(source,{cookieHeaderForUrl:()=> 'z_c0=synthetic',fetchImpl:async(url)=>json(page([article(1)],false,2,url.includes('offset=20')?'https://zhuanlan.zhihu.com/api/columns/c_auth_fixture/items?offset=40':'https://zhuanlan.zhihu.com/api/columns/c_auth_fixture/items?offset=20'))}),/incomplete_repeated_items/);
  await assert.rejects(discoverZhihuColumn(source,{cookieHeaderForUrl:()=> 'z_c0=synthetic',fetchImpl:async()=>json(page([article(1)],false,2,'https://zhuanlan.zhihu.com/api/columns/another/items?offset=20'))}),/pagination_origin_invalid/);
});
