import test from 'node:test';
import assert from 'node:assert/strict';
import {authenticatedApi,parseParts} from './acquire.mjs';
test('requested parts expand inclusively and never silently drop duplicates',()=>{
  assert.deepEqual(parseParts('3-5,8'),[3,4,5,8]);
  for(const text of ['0','5-3','1,1','3-5,4','x','1-99999'])assert.throws(()=>parseParts(text));
});

test('metadata uses the existing login and cannot fall back to anonymous access',async()=>{
  let loaded=true,calls=0;
  const snapshot={refresh(){},health:()=>({loaded}),headerForUrl:()=> 'SESSDATA=synthetic-fixture'};
  const api=authenticatedApi({snapshot,fetchImpl:async(url,options)=>{
    calls++;
    assert.equal(new URL(url).origin,'https://api.bilibili.com');
    assert.equal(options.headers.Cookie,'SESSDATA=synthetic-fixture');
    assert.equal(options.redirect,'error');
    return {ok:true,json:async()=>({code:0,data:{pages:[{cid:1,page:1}]}})};
  }});
  assert.deepEqual(await api('x/web-interface/view?bvid=fixture'),{pages:[{cid:1,page:1}]});
  loaded=false;
  await assert.rejects(api('x/web-interface/view?bvid=fixture'),/existing_bilibili_login_unavailable/);
  assert.equal(calls,1);
});
